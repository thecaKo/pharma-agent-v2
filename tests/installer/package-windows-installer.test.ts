import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertDotnetAvailable,
  assertWindowsPackagingHost,
  buildInstallerBundleCommand,
  formatPackagingPrerequisites,
  getPackagingExecutionPlan,
  PACKAGING_PREREQUISITES,
  PackagingPrerequisiteError,
  prepareInstallerStaging,
  RUN_WINDOWS_INSTALLER_TESTS_ENV,
  shouldRunPackagingBuild,
  WINDOWS_INSTALLER_BUNDLE_PROJECT_RELATIVE,
  WINDOWS_INSTALLER_OUTPUT_RELATIVE,
  WINDOWS_INSTALLER_PACKAGE_SCRIPT
} from "../../src/installer/package-windows-installer.js";

describe("package-windows-installer", () => {
  it("documents Windows and WiX packaging prerequisites", () => {
    const formatted = formatPackagingPrerequisites();

    expect(PACKAGING_PREREQUISITES).toEqual(
      expect.arrayContaining([
        "Windows host (win32)",
        expect.stringMatching(/\.NET SDK/u),
        expect.stringMatching(/WiX Toolset/u)
      ])
    );
    expect(formatted).toContain("1. Windows host (win32)");
    expect(formatted).toContain("node.exe");
  });

  it("requires a Windows host before packaging", () => {
    expect(() => assertWindowsPackagingHost("linux")).toThrow(PackagingPrerequisiteError);
    expect(() => assertWindowsPackagingHost("win32")).not.toThrow();
  });

  it("skips automated packaging unless Windows test gate is enabled", () => {
    expect(
      getPackagingExecutionPlan({ [RUN_WINDOWS_INSTALLER_TESTS_ENV]: "1" }, "linux").skipReason
    ).toMatch(/Windows host/u);
    expect(getPackagingExecutionPlan({}, "win32").skipReason).toContain(RUN_WINDOWS_INSTALLER_TESTS_ENV);
    expect(shouldRunPackagingBuild({ [RUN_WINDOWS_INSTALLER_TESTS_ENV]: "1" }, "win32")).toBe(true);
    expect(shouldRunPackagingBuild({}, "win32")).toBe(false);
  });

  it("targets the bundle project and setup executable output", () => {
    const projectRoot = "/repo";
    const command = buildInstallerBundleCommand(projectRoot);

    expect(command.args).toEqual([
      "build",
      join(projectRoot, WINDOWS_INSTALLER_BUNDLE_PROJECT_RELATIVE),
      "-c",
      "Release"
    ]);
    expect(WINDOWS_INSTALLER_OUTPUT_RELATIVE).toBe("installer/bin/PharmaAgentConnector-Setup.exe");
    expect(WINDOWS_INSTALLER_PACKAGE_SCRIPT).toBe("package:windows-installer");
  });

  it("fails dotnet prerequisite checks with an actionable message", () => {
    expect(() => assertDotnetAvailable("pharma-agent-missing-dotnet-command")).toThrow(
      /Missing \.NET SDK prerequisite/u
    );
  });

  it("stages built connector output and node.exe before WiX build", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "pharma-packaging-"));
    const nodeExecutablePath = join(projectRoot, "custom-node.exe");
    await mkdir(join(projectRoot, "dist"), { recursive: true });
    await writeFile(join(projectRoot, "dist", "main.js"), "export {};\n");
    await writeFile(join(projectRoot, "package.json"), '{"name":"test"}\n');
    await writeFile(nodeExecutablePath, "node");

    const { stagingDir } = await prepareInstallerStaging({ projectRoot, nodeExecutablePath });

    expect(stagingDir).toBe(join(projectRoot, "installer", "staging"));
    await expect(access(join(stagingDir, "dist", "main.js"))).resolves.toBeUndefined();
    await expect(access(join(stagingDir, "node.exe"))).resolves.toBeUndefined();
  });
});
