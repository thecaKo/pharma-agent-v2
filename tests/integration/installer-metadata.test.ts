import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getInstallerServiceMetadata } from "../../src/installer/metadata.js";
import { loadWixSources } from "../../src/installer/validate-wix-sources.js";

const projectRoot = join(import.meta.dirname, "..", "..");
const installerDirectory = join(projectRoot, "installer");

async function readScriptDefaults(): Promise<{
  serviceName: string;
  displayName: string;
  entrypoint: string;
}> {
  const script = await readFile(join(projectRoot, "scripts", "install-service.ps1"), "utf8");
  const serviceName = script.match(/\$ServiceName = "([^"]+)"/u)?.[1];
  const displayName = script.match(/\$DisplayName = "([^"]+)"/u)?.[1];
  const entrypoint = script.match(/Join-Path \$InstallDirectory "([^"]+)"/u)?.[1];

  if (!serviceName || !displayName || !entrypoint) {
    throw new Error("Could not parse install-service.ps1 defaults.");
  }

  return {
    serviceName,
    displayName,
    entrypoint: entrypoint.replace(/\\/gu, "/")
  };
}

describe("installer metadata integration", () => {
  it("aligns package entrypoint metadata with package.json start script", async () => {
    const pkg = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const metadata = getInstallerServiceMetadata();

    expect(pkg.scripts.start).toBe(`node ${metadata.entrypointRelativePath}`);
  });

  it("aligns WiX service metadata with fallback install-service.ps1 defaults", async () => {
    const scriptDefaults = await readScriptDefaults();
    const metadata = getInstallerServiceMetadata();
    const { combinedSource } = await loadWixSources(installerDirectory);

    expect(metadata.serviceName).toBe(scriptDefaults.serviceName);
    expect(metadata.displayName).toBe(scriptDefaults.displayName);
    expect(metadata.entrypointRelativePath).toBe(scriptDefaults.entrypoint);
    expect(combinedSource).toContain(metadata.serviceName);
    expect(combinedSource).toContain(metadata.displayName);
    expect(combinedSource).toContain(metadata.entrypointWindowsRelativePath);
    expect(combinedSource).toContain('Start="auto"');
  });

  it("packages the connector as a standalone MSI project", async () => {
    const packageProject = await readFile(join(installerDirectory, "ConnectorPackage.wixproj"), "utf8");

    expect(packageProject).toContain("<OutputType>Package</OutputType>");
    expect(packageProject).toContain("PharmaAgentConnector");
  });
});

describe("windows-gated manual install verification", () => {
  it("skips installer artifact checks unless RUN_WINDOWS_INSTALLER_TESTS=1 on Windows", () => {
    const enabled = process.platform === "win32" && process.env.RUN_WINDOWS_INSTALLER_TESTS === "1";
    if (process.platform !== "win32") {
      expect(enabled).toBe(false);
      return;
    }

    expect(enabled).toBe(process.env.RUN_WINDOWS_INSTALLER_TESTS === "1");
  });

  it.runIf(process.platform === "win32" && process.env.RUN_WINDOWS_INSTALLER_TESTS === "1")(
    "confirms the built setup executable exists for manual install verification",
    async () => {
      const setupExe = join(installerDirectory, "bin", "Release", "PharmaAgentConnector.msi");
      await expect(readFile(setupExe)).resolves.toBeDefined();
    }
  );
});
