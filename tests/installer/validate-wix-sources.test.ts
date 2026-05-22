import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertWixMetadataValid,
  loadWixSources,
  validateWixProgramDataConfigAuthoring,
  validateWixServiceMetadata,
  validateWixWizardScope
} from "../../src/installer/validate-wix-sources.js";
import { getInstallerServiceMetadata } from "../../src/installer/metadata.js";

const installerDirectory = join(import.meta.dirname, "..", "..", "installer");

describe("validate-wix-sources", () => {
  it("loads all installer wxs sources", async () => {
    const result = await loadWixSources(installerDirectory);

    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.combinedSource).toContain("PharmaAgentConnector");
  });

  it("validates service metadata in installer sources", async () => {
    const { combinedSource } = await loadWixSources(installerDirectory);
    const errors = validateWixServiceMetadata(combinedSource);

    expect(errors).toEqual([]);
  });

  it("validates wizard scope and token masking in installer sources", async () => {
    const { combinedSource } = await loadWixSources(installerDirectory);
    const errors = validateWixWizardScope(combinedSource);

    expect(errors).toEqual([]);
  });

  it("validates ProgramData config authoring in installer sources", async () => {
    const { combinedSource } = await loadWixSources(installerDirectory);
    const errors = validateWixProgramDataConfigAuthoring(combinedSource);

    expect(errors).toEqual([]);
  });

  it("authors the ProgramData config script as UTF-8 without BOM JSON output", async () => {
    const script = await readFile(join(installerDirectory, "actions", "WriteProgramDataConfig.ps1"), "utf8");

    expect(script).toContain("System.Text.UTF8Encoding($false)");
    expect(script).toContain("[System.IO.File]::WriteAllText");
    expect(script).not.toContain("Set-Content -Path $configPath -Encoding UTF8");
  });

  it("passes combined installer metadata validation", async () => {
    const { combinedSource } = await loadWixSources(installerDirectory);

    expect(() => assertWixMetadataValid(combinedSource)).not.toThrow();
  });

  it("reports validation failures for incomplete installer sources", () => {
    expect(() => assertWixMetadataValid("<Package />")).toThrow(
      /WiX installer metadata validation failed/u
    );
    expect(validateWixServiceMetadata("<Package />")).toContain("missing service name PharmaAgentConnector");
    expect(validateWixServiceMetadata("<Package />")).toContain(
      "missing generated node_modules component group ConnectorNodeModulesFiles"
    );
    expect(validateWixWizardScope("<Package />")).toContain("missing wizard property CONNECTOR_TOKEN");
    expect(validateWixProgramDataConfigAuthoring("<Package />")).toContain(
      "missing ProgramData config file name connector-config.json"
    );
  });

  it("rejects forbidden database wizard properties", () => {
    const errors = validateWixWizardScope('<Property Id="DB_PASSWORD" />');

    expect(errors).toContain("forbidden wizard property DB_PASSWORD");
  });

  it("accepts automatic startup when only the automatic literal is present", () => {
    const metadata = getInstallerServiceMetadata();
    const source = [
      metadata.serviceName,
      metadata.displayName,
      'Start="automatic"',
      metadata.entrypointWindowsRelativePath,
      metadata.nodeExecutable,
      metadata.serviceWrapperExecutable,
      metadata.serviceWrapperConfigurationFile,
      "ConnectorDistFiles",
      "ConnectorNodeModulesFiles",
      "package-lock.json",
      "<ServiceInstall />",
      "<ServiceControl />"
    ].join("\n");

    expect(validateWixServiceMetadata(source)).toEqual([]);
  });

  it("rejects direct node.exe service registration authoring", () => {
    const metadata = getInstallerServiceMetadata();
    const source = [
      '<Component Id="ConnectorWindowsService">',
      metadata.serviceName,
      metadata.displayName,
      'Start="auto"',
      metadata.entrypointWindowsRelativePath,
      metadata.nodeExecutable,
      metadata.serviceWrapperExecutable,
      metadata.serviceWrapperConfigurationFile,
      "ConnectorDistFiles",
      "ConnectorNodeModulesFiles",
      "package-lock.json",
      'Name="node.exe" Source="$(StagingDir)\\node.exe" KeyPath="yes"',
      'Arguments="&quot;[INSTALLFOLDER]dist\\main.js&quot;"',
      "<ServiceInstall />",
      "<ServiceControl />",
      "</Component>"
    ].join("\n");

    expect(validateWixServiceMetadata(source)).toContain(
      "service install still passes runtime arguments directly instead of using the wrapper"
    );
    expect(validateWixServiceMetadata(source)).toContain(
      "node.exe must not be the Windows service KeyPath binary"
    );
  });
});
