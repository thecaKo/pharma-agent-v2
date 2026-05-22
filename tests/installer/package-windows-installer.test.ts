import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NODE_MODULES_PATH_ENV,
  REQUIRED_RUNTIME_DEPENDENCIES,
  WINSW_EXE_PATH_ENV,
  assertDotnetAvailable,
  assertInstallerWixPackagingLayout,
  assertWindowsPackagingHost,
  buildInstallerBundleCommand,
  formatPackagingPrerequisites,
  getPackagingExecutionPlan,
  PACKAGING_PREREQUISITES,
  PackagingPrerequisiteError,
  prepareInstallerStaging,
  renderGeneratedDistFilesWxs,
  renderGeneratedNodeModulesFilesWxs,
  RUN_WINDOWS_INSTALLER_TESTS_ENV,
  shouldRunPackagingBuild,
  WINDOWS_INSTALLER_GENERATED_DIST_FILES_RELATIVE,
  WINDOWS_INSTALLER_GENERATED_NODE_MODULES_FILES_RELATIVE,
  WINDOWS_INSTALLER_OUTPUT_RELATIVE,
  WINDOWS_INSTALLER_PROJECT_RELATIVE,
  WINDOWS_INSTALLER_PACKAGE_SCRIPT
} from "../../src/installer/package-windows-installer.js";
import { renderInstallerWinSwConfiguration } from "../../src/installer/metadata.js";

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
    expect(formatted).toContain(WINSW_EXE_PATH_ENV);
    expect(formatted).toContain(NODE_MODULES_PATH_ENV);
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

  it("targets the MSI project and installer output", () => {
    const projectRoot = "/repo";
    const command = buildInstallerBundleCommand(projectRoot);

    expect(command.args).toEqual([
      "build",
      join(projectRoot, WINDOWS_INSTALLER_PROJECT_RELATIVE),
      "-c",
      "Release",
      "-restore",
      `-p:StagingDir=${join(projectRoot, "installer", "staging")}`
    ]);
    expect(WINDOWS_INSTALLER_OUTPUT_RELATIVE).toBe("installer/bin/Release/PharmaAgentConnector.msi");
    expect(WINDOWS_INSTALLER_PACKAGE_SCRIPT).toBe("package:windows-installer");
  });

  it("fails dotnet prerequisite checks with an actionable message", () => {
    expect(() => assertDotnetAvailable("pharma-agent-missing-dotnet-command")).toThrow(
      /Missing \.NET SDK prerequisite/u
    );
  });

  it("validates installer WiX extension layout in the repository", async () => {
    const projectRoot = join(import.meta.dirname, "..", "..");
    await expect(assertInstallerWixPackagingLayout(projectRoot)).resolves.toBeUndefined();
  });

  it("stages built connector output, production node_modules, WinSW wrapper, and service XML before WiX build", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "pharma-packaging-"));
    const nodeExecutablePath = join(projectRoot, "custom-node.exe");
    const winswExecutablePath = join(projectRoot, "custom-winsw.exe");
    const preparedNodeModulesPath = join(projectRoot, "prepared-node_modules");
    await mkdir(join(projectRoot, "dist"), { recursive: true });
    await mkdir(join(projectRoot, "dist", "transport"), { recursive: true });
    await writeFile(join(projectRoot, "dist", "main.js"), "export {};\n");
    await writeFile(join(projectRoot, "dist", "transport", "ws-client.js"), "export {};\n");
    await writeFile(join(projectRoot, "package.json"), '{"name":"test"}\n');
    await writeFile(join(projectRoot, "package-lock.json"), '{"name":"test","lockfileVersion":3}\n');
    await writeFile(nodeExecutablePath, "node");
    await writeFile(winswExecutablePath, "winsw");
    await createProductionNodeModules(preparedNodeModulesPath);

    const originalNodeModulesPath = process.env[NODE_MODULES_PATH_ENV];
    process.env[NODE_MODULES_PATH_ENV] = preparedNodeModulesPath;
    try {
      const { stagingDir } = await prepareInstallerStaging({
        projectRoot,
        nodeExecutablePath,
        winswExecutablePath
      });

      expect(stagingDir).toBe(join(projectRoot, "installer", "staging"));
      await expect(access(join(stagingDir, "dist", "main.js"))).resolves.toBeUndefined();
      await expect(access(join(stagingDir, "dist", "transport", "ws-client.js"))).resolves.toBeUndefined();
      await expect(access(join(stagingDir, "package.json"))).resolves.toBeUndefined();
      await expect(access(join(stagingDir, "package-lock.json"))).resolves.toBeUndefined();
      await expect(access(join(stagingDir, "node_modules", "ws", "package.json"))).resolves.toBeUndefined();
      await expect(access(join(stagingDir, "node.exe"))).resolves.toBeUndefined();
      await expect(access(join(stagingDir, "PharmaAgentConnector.Service.exe"))).resolves.toBeUndefined();
      expect(await readFile(join(stagingDir, "PharmaAgentConnector.Service.xml"), "utf8")).toBe(
        renderInstallerWinSwConfiguration()
      );
      const generatedDistFiles = await readFile(
        join(projectRoot, WINDOWS_INSTALLER_GENERATED_DIST_FILES_RELATIVE),
        "utf8"
      );
      expect(generatedDistFiles).toContain('<ComponentGroup Id="ConnectorDistFiles">');
      expect(generatedDistFiles).toContain('Source="$(StagingDir)\\dist\\main.js"');
      expect(generatedDistFiles).toContain('Source="$(StagingDir)\\dist\\transport\\ws-client.js"');
      const generatedNodeModulesFiles = await readFile(
        join(projectRoot, WINDOWS_INSTALLER_GENERATED_NODE_MODULES_FILES_RELATIVE),
        "utf8"
      );
      expect(generatedNodeModulesFiles).toContain('<ComponentGroup Id="ConnectorNodeModulesFiles">');
      expect(generatedNodeModulesFiles).toContain('Source="$(StagingDir)\\node_modules\\ws\\package.json"');
      expect(generatedNodeModulesFiles).toContain('Source="$(StagingDir)\\node_modules\\mysql2\\index.js"');
    } finally {
      if (originalNodeModulesPath === undefined) {
        delete process.env[NODE_MODULES_PATH_ENV];
      } else {
        process.env[NODE_MODULES_PATH_ENV] = originalNodeModulesPath;
      }
    }
  });

  it("accepts pre-positioned staging binaries and node_modules when env overrides are absent", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "pharma-packaging-prestaged-"));
    const stagingDir = join(projectRoot, "installer", "staging");
    await mkdir(join(projectRoot, "dist"), { recursive: true });
    await mkdir(stagingDir, { recursive: true });
    await writeFile(join(projectRoot, "dist", "main.js"), "export {};\n");
    await writeFile(join(projectRoot, "package.json"), '{"name":"test"}\n');
    await writeFile(join(projectRoot, "package-lock.json"), '{"name":"test","lockfileVersion":3}\n');
    await writeFile(join(stagingDir, "node.exe"), "node");
    await writeFile(join(stagingDir, "PharmaAgentConnector.Service.exe"), "winsw");
    await createProductionNodeModules(join(stagingDir, "node_modules"));

    await expect(prepareInstallerStaging({ projectRoot })).resolves.toEqual({ stagingDir });
  });

  it("fails with an actionable message when production node_modules are missing", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "pharma-packaging-missing-modules-"));
    const stagingDir = join(projectRoot, "installer", "staging");
    await mkdir(join(projectRoot, "dist"), { recursive: true });
    await mkdir(stagingDir, { recursive: true });
    await writeFile(join(projectRoot, "dist", "main.js"), "export {};\n");
    await writeFile(join(projectRoot, "package.json"), '{"name":"test"}\n');
    await writeFile(join(projectRoot, "package-lock.json"), '{"name":"test","lockfileVersion":3}\n');
    await writeFile(join(stagingDir, "node.exe"), "node");
    await writeFile(join(stagingDir, "PharmaAgentConnector.Service.exe"), "winsw");

    await expect(prepareInstallerStaging({ projectRoot })).rejects.toThrow(
      /NODE_MODULES_PATH|installer\/staging\/node_modules/u
    );
  });

  it("renders a WiX component for every dist file while preserving nested directories", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "pharma-packaging-dist-wxs-"));
    const distDir = join(projectRoot, "dist");
    await mkdir(join(distDir, "config"), { recursive: true });
    await writeFile(join(distDir, "main.js"), "export {};\n");
    await writeFile(join(distDir, "config", "env.js"), "export {};\n");

    const wxs = await renderGeneratedDistFilesWxs(distDir);

    expect(wxs).toContain('<Directory Id="DistDir" Name="dist">');
    expect(wxs).toMatch(/<Directory Id="DistDir_dist_config_[a-f0-9]{12}" Name="config">/u);
    expect(wxs).toContain('Source="$(StagingDir)\\dist\\main.js"');
    expect(wxs).toContain('Source="$(StagingDir)\\dist\\config\\env.js"');
    expect(wxs).toMatch(/<ComponentRef Id="DistFile_main_js_[a-f0-9]{12}" \/>/u);
    expect(wxs).toMatch(/<ComponentRef Id="DistFile_config_env_js_[a-f0-9]{12}" \/>/u);
  });

  it("renders a WiX component for every staged node_modules file while preserving nested directories", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "pharma-packaging-node-modules-wxs-"));
    const nodeModulesDir = join(projectRoot, "node_modules");
    await createProductionNodeModules(nodeModulesDir);

    const wxs = await renderGeneratedNodeModulesFilesWxs(nodeModulesDir);

    expect(wxs).toContain('<Directory Id="NodeModulesDir" Name="node_modules">');
    expect(wxs).toMatch(/<Directory Id="NodeModulesDir_node_modules_mysql2_[a-f0-9]{12}" Name="mysql2">/u);
    expect(wxs).toContain('Source="$(StagingDir)\\node_modules\\ws\\package.json"');
    expect(wxs).toContain('Source="$(StagingDir)\\node_modules\\mysql2\\index.js"');
    expect(wxs).toMatch(/<ComponentRef Id="NodeModulesFile_ws_package_json_[a-f0-9]{12}" \/>/u);
    expect(wxs).toMatch(/<ComponentRef Id="NodeModulesFile_mysql2_index_js_[a-f0-9]{12}" \/>/u);
  });
});

async function createProductionNodeModules(nodeModulesPath: string): Promise<void> {
  for (const dependency of REQUIRED_RUNTIME_DEPENDENCIES) {
    const dependencyDirectory = join(nodeModulesPath, dependency);
    await mkdir(dependencyDirectory, { recursive: true });
    await writeFile(join(dependencyDirectory, "package.json"), JSON.stringify({ name: dependency }), "utf8");
    await writeFile(join(dependencyDirectory, "index.js"), "module.exports = {};\n", "utf8");
  }
}
