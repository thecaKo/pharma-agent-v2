import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getInstallerServiceMetadata, renderInstallerWinSwConfiguration } from "./metadata.js";

export const WINDOWS_INSTALLER_PACKAGE_SCRIPT = "package:windows-installer";
export const WINDOWS_INSTALLER_OUTPUT_RELATIVE = "installer/bin/Release/PharmaAgentConnector.msi";
export const WINDOWS_INSTALLER_PROJECT_RELATIVE = "installer/ConnectorPackage.wixproj";
export const WINDOWS_INSTALLER_GENERATED_DIST_FILES_RELATIVE = "installer/GeneratedDistFiles.wxs";
export const WINDOWS_INSTALLER_GENERATED_NODE_MODULES_FILES_RELATIVE = "installer/GeneratedNodeModulesFiles.wxs";
export const RUN_WINDOWS_INSTALLER_TESTS_ENV = "RUN_WINDOWS_INSTALLER_TESTS";

export const REQUIRED_WIX_EXTENSION_PACKAGES = ["WixToolset.UI.wixext", "WixToolset.Util.wixext"] as const;
export const WINSW_EXE_PATH_ENV = "WINSW_EXE_PATH";
export const NODE_MODULES_PATH_ENV = "NODE_MODULES_PATH";
export const REQUIRED_RUNTIME_DEPENDENCIES = ["ws", "pino", "dotenv", "mysql2", "node-firebird"] as const;

export const PACKAGING_PREREQUISITES = [
  "Windows host (win32)",
  ".NET SDK 8+ with MSBuild on PATH (`dotnet` command)",
  "WiX Toolset 5.x (restored through WixToolset.Sdk when building the installer projects)",
  "Built connector output in `dist/` (the packaging script runs `npm run build` first)",
  "Root `package.json` and `package-lock.json` present for the packaged runtime manifest",
  "Windows x64 `node.exe` copied into `installer/staging/node.exe` or supplied through NODE_EXE_PATH",
  `WinSW x64 executable copied into \`installer/staging/PharmaAgentConnector.Service.exe\` or supplied through ${WINSW_EXE_PATH_ENV}`,
  `Production \`node_modules\` prepared for Windows x64, supplied through ${NODE_MODULES_PATH_ENV} or pre-positioned at \`installer/staging/node_modules\``
] as const;

export class PackagingPrerequisiteError extends Error {
  readonly name = "PackagingPrerequisiteError";
}

export interface PackagingExecutionPlan {
  execute: boolean;
  skipReason?: string;
}

export function isWindowsPackagingHost(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

export function shouldRunPackagingBuild(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  return isWindowsPackagingHost(platform) && env[RUN_WINDOWS_INSTALLER_TESTS_ENV] === "1";
}

export function getPackagingExecutionPlan(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): PackagingExecutionPlan {
  if (!isWindowsPackagingHost(platform)) {
    return {
      execute: false,
      skipReason:
        "Windows installer packaging requires a Windows host. Automated WiX builds are skipped on non-Windows test runs."
    };
  }

  if (env[RUN_WINDOWS_INSTALLER_TESTS_ENV] !== "1") {
    return {
      execute: false,
      skipReason: `Set ${RUN_WINDOWS_INSTALLER_TESTS_ENV}=1 on Windows to run WiX packaging integration checks.`
    };
  }

  return { execute: true };
}

export function assertWindowsPackagingHost(platform: NodeJS.Platform = process.platform): void {
  if (!isWindowsPackagingHost(platform)) {
    throw new PackagingPrerequisiteError(
      "Windows installer packaging requires a Windows host (win32). Run `npm run package:windows-installer` on a prepared Windows build machine with WiX Toolset and .NET SDK installed."
    );
  }
}

export function resolveDotnetCommand(): string {
  return "dotnet";
}

export function assertDotnetAvailable(command = resolveDotnetCommand()): void {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8"
  });

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new PackagingPrerequisiteError(
      `Missing .NET SDK prerequisite: '${command}' is not available or failed. Install .NET SDK 8+ and ensure it is on PATH.${detail ? ` ${detail}` : ""}`
    );
  }
}

export function formatPackagingPrerequisites(): string {
  return PACKAGING_PREREQUISITES.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

export async function prepareInstallerStaging(options: {
  projectRoot: string;
  nodeExecutablePath?: string;
  winswExecutablePath?: string;
}): Promise<{ stagingDir: string }> {
  const metadata = getInstallerServiceMetadata();
  const stagingDir = join(options.projectRoot, "installer", "staging");
  const distSource = join(options.projectRoot, metadata.entrypointRelativePath);
  const packageJsonSource = join(options.projectRoot, "package.json");
  const packageLockSource = join(options.projectRoot, "package-lock.json");
  const stagedNodeModulesDirectory = join(stagingDir, "node_modules");

  await access(distSource);
  await access(packageJsonSource);
  await access(packageLockSource);
  await mkdir(stagingDir, { recursive: true });
  await rm(join(stagingDir, "dist"), { recursive: true, force: true });
  await mkdir(join(stagingDir, "dist"), { recursive: true });
  await cp(join(options.projectRoot, "dist"), join(stagingDir, "dist"), { recursive: true });
  await copyFile(packageJsonSource, join(stagingDir, "package.json"));
  await copyFile(packageLockSource, join(stagingDir, "package-lock.json"));

  await stageProductionNodeModules({
    stagingDir,
    targetDirectory: stagedNodeModulesDirectory
  });

  await writeFile(
    join(options.projectRoot, WINDOWS_INSTALLER_GENERATED_DIST_FILES_RELATIVE),
    await renderGeneratedDistFilesWxs(join(options.projectRoot, "dist")),
    "utf8"
  );
  await writeFile(
    join(options.projectRoot, WINDOWS_INSTALLER_GENERATED_NODE_MODULES_FILES_RELATIVE),
    await renderGeneratedNodeModulesFilesWxs(stagedNodeModulesDirectory),
    "utf8"
  );

  const nodeSource = options.nodeExecutablePath ?? process.env.NODE_EXE_PATH;
  const winswSource = options.winswExecutablePath ?? process.env[WINSW_EXE_PATH_ENV];
  const stagedNodeExecutable = join(stagingDir, metadata.nodeExecutable);
  const stagedServiceWrapperExecutable = join(stagingDir, metadata.serviceWrapperExecutable);
  const stagedServiceWrapperConfiguration = join(stagingDir, metadata.serviceWrapperConfigurationFile);

  if (nodeSource) {
    await copyFile(nodeSource, stagedNodeExecutable);
  } else {
    try {
      await access(stagedNodeExecutable);
    } catch {
      throw new PackagingPrerequisiteError(
        `Missing packaged Node runtime at ${stagedNodeExecutable}. Copy node.exe into installer/staging or set NODE_EXE_PATH to a Windows x64 node.exe before packaging.`
      );
    }
  }

  if (winswSource) {
    await copyFile(winswSource, stagedServiceWrapperExecutable);
  } else {
    try {
      await access(stagedServiceWrapperExecutable);
    } catch {
      throw new PackagingPrerequisiteError(
        `Missing WinSW wrapper at ${stagedServiceWrapperExecutable}. Copy ${metadata.serviceWrapperExecutable} into installer/staging or set ${WINSW_EXE_PATH_ENV} to a WinSW executable before packaging.`
      );
    }
  }

  await writeFile(stagedServiceWrapperConfiguration, renderInstallerWinSwConfiguration(metadata), "utf8");

  return { stagingDir };
}

export async function renderGeneratedDistFilesWxs(distDirectory: string): Promise<string> {
  return renderGeneratedFilesWxs(distDirectory, {
    rootDirectoryId: "DistDir",
    rootDirectoryName: "dist",
    relativeSourcePrefix: "dist",
    componentGroupId: "ConnectorDistFiles",
    componentIdPrefix: "DistFile",
    directoryIdPrefix: "DistDir"
  });
}

export async function renderGeneratedNodeModulesFilesWxs(nodeModulesDirectory: string): Promise<string> {
  return renderGeneratedFilesWxs(nodeModulesDirectory, {
    rootDirectoryId: "NodeModulesDir",
    rootDirectoryName: "node_modules",
    relativeSourcePrefix: "node_modules",
    componentGroupId: "ConnectorNodeModulesFiles",
    componentIdPrefix: "NodeModulesFile",
    directoryIdPrefix: "NodeModulesDir"
  });
}

export async function assertInstallerWixPackagingLayout(projectRoot: string): Promise<void> {
  const installerDirectory = join(projectRoot, "installer");
  const sources: string[] = [];

  for (const relativePath of ["Directory.Build.props", "ConnectorPackage.wixproj"]) {
    try {
      sources.push(await readFile(join(installerDirectory, relativePath), "utf8"));
    } catch {
      throw new PackagingPrerequisiteError(
        `Missing installer project file ${join("installer", relativePath)}. Run packaging from the repository root (for example C:\\dev\\pharma-agent-v2).`
      );
    }
  }

  const combined = sources.join("\n");
  const missingPackages = REQUIRED_WIX_EXTENSION_PACKAGES.filter((packageId) => !combined.includes(packageId));

  if (missingPackages.length > 0) {
    throw new PackagingPrerequisiteError(
      `Installer WiX extension packages are not configured (${missingPackages.join(", ")}). Pull the latest repository changes, then run: dotnet restore installer\\ConnectorPackage.wixproj`
    );
  }

  if (!combined.includes("WixToolset.Sdk/5.0.0")) {
    throw new PackagingPrerequisiteError(
      "Installer projects must target WixToolset.Sdk/5.0.0. Pull the latest repository changes before packaging."
    );
  }

  if (!combined.includes("GeneratedNodeModulesFiles.wxs")) {
    throw new PackagingPrerequisiteError(
      "Installer project must compile GeneratedNodeModulesFiles.wxs. Pull the latest repository changes before packaging."
    );
  }
}

export function restoreInstallerProject(projectRoot: string): void {
  const installerProject = join(projectRoot, WINDOWS_INSTALLER_PROJECT_RELATIVE);
  const result = spawnSync(resolveDotnetCommand(), ["restore", installerProject], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: "pipe"
  });

  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new PackagingPrerequisiteError(
      `Failed to restore WiX installer project.${detail ? `\n${detail}` : ""}`
    );
  }
}

export function buildInstallerMsiCommand(projectRoot: string): {
  command: string;
  args: string[];
  cwd: string;
} {
  const stagingDir = join(projectRoot, "installer", "staging");
  return {
    command: resolveDotnetCommand(),
    args: [
      "build",
      join(projectRoot, WINDOWS_INSTALLER_PROJECT_RELATIVE),
      "-c",
      "Release",
      "-restore",
      `-p:StagingDir=${stagingDir}`
    ],
    cwd: projectRoot
  };
}

export function runInstallerMsiBuild(projectRoot: string): void {
  const { command, args, cwd } = buildInstallerMsiCommand(projectRoot);
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe"
  });

  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new PackagingPrerequisiteError(
      `WiX packaging failed. Confirm WiX Toolset 5.x is installed and that installer staging is complete.${detail ? `\n${detail}` : ""}`
    );
  }
}

interface GeneratedDirectoryNode {
  readonly files: string[];
  readonly children: Map<string, GeneratedDirectoryNode>;
}

interface GeneratedWixOptions {
  readonly rootDirectoryId: string;
  readonly rootDirectoryName: string;
  readonly relativeSourcePrefix: string;
  readonly componentGroupId: string;
  readonly componentIdPrefix: string;
  readonly directoryIdPrefix: string;
}

async function listRelativeFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (entry.isFile()) {
        files.push(relative(root, path).split(sep).join("/"));
      }
    }
  }

  await walk(root);
  return files.sort((left, right) => left.localeCompare(right));
}

async function renderGeneratedFilesWxs(rootDirectory: string, options: GeneratedWixOptions): Promise<string> {
  const relativeFiles = await listRelativeFiles(rootDirectory);
  const directoryTree = buildDirectoryTree(relativeFiles);

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">',
    "  <Fragment>",
    '    <DirectoryRef Id="INSTALLFOLDER">',
    renderDirectoryNode(directoryTree, options.rootDirectoryId, options.rootDirectoryName, options.rootDirectoryName, 3, options),
    "    </DirectoryRef>",
    "  </Fragment>",
    "  <Fragment>",
    `    <ComponentGroup Id="${options.componentGroupId}">`,
    ...relativeFiles.map((file) => `      <ComponentRef Id="${componentId(file, options.componentIdPrefix)}" />`),
    "    </ComponentGroup>",
    "  </Fragment>",
    "</Wix>",
    ""
  ].join("\n");
}

function buildDirectoryTree(relativeFiles: readonly string[]): GeneratedDirectoryNode {
  const root = createDistDirectoryNode();

  for (const file of relativeFiles) {
    const segments = file.split("/");
    const fileName = segments.pop();
    if (!fileName) {
      continue;
    }

    let current = root;
    for (const segment of segments) {
      let child = current.children.get(segment);
      if (!child) {
        child = createDistDirectoryNode();
        current.children.set(segment, child);
      }
      current = child;
    }
    current.files.push(file);
  }

  return root;
}

function createDistDirectoryNode(): GeneratedDirectoryNode {
  return {
    files: [],
    children: new Map()
  };
}

function renderDirectoryNode(
  node: GeneratedDirectoryNode,
  id: string,
  name: string,
  path: string,
  indentLevel: number,
  options: GeneratedWixOptions
): string {
  const indent = "  ".repeat(indentLevel);
  const lines = [`${indent}<Directory Id="${id}" Name="${escapeXml(name)}">`];

  for (const file of [...node.files].sort((left, right) => left.localeCompare(right))) {
    lines.push(renderFileComponent(file, indentLevel + 1, options));
  }

  for (const [childName, child] of [...node.children.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const childPath = `${path}/${childName}`;
    lines.push(
      renderDirectoryNode(child, directoryId(childPath, options.directoryIdPrefix), childName, childPath, indentLevel + 1, options)
    );
  }

  lines.push(`${indent}</Directory>`);
  return lines.join("\n");
}

function renderFileComponent(file: string, indentLevel: number, options: GeneratedWixOptions): string {
  const indent = "  ".repeat(indentLevel);
  const generatedComponentId = componentId(file, options.componentIdPrefix);
  const sourcePath = file.split("/").join("\\");

  return [
    `${indent}<Component Id="${generatedComponentId}" Guid="*">`,
    `${indent}  <File Id="${generatedComponentId}File" Source="$(StagingDir)\\${escapeXml(options.relativeSourcePrefix)}\\${escapeXml(sourcePath)}" KeyPath="yes" />`,
    `${indent}</Component>`
  ].join("\n");
}

function componentId(file: string, prefix: string): string {
  return wixIdentifier(`${prefix}_${file}`);
}

function directoryId(path: string, prefix: string): string {
  return wixIdentifier(`${prefix}_${path}`);
}

async function stageProductionNodeModules(options: {
  stagingDir: string;
  targetDirectory: string;
}): Promise<void> {
  const envSource = process.env[NODE_MODULES_PATH_ENV];
  const preStagedSource = join(options.stagingDir, "node_modules");
  const resolvedTarget = resolve(options.targetDirectory);
  const requestedSource = envSource ? resolve(envSource) : resolvedTarget;

  if (envSource) {
    await access(requestedSource).catch(() => {
      throw new PackagingPrerequisiteError(
        `Missing production node_modules at ${envSource}. Prepare Windows x64 production dependencies first, then retry with ${NODE_MODULES_PATH_ENV} pointing at that directory.`
      );
    });

    if (requestedSource !== resolvedTarget) {
      await rm(options.targetDirectory, { recursive: true, force: true });
      await cp(requestedSource, options.targetDirectory, { recursive: true });
    }
  } else {
    await access(preStagedSource).catch(() => {
      throw new PackagingPrerequisiteError(
        `Missing production node_modules for MSI staging. Set ${NODE_MODULES_PATH_ENV} to a prepared Windows x64 production node_modules directory or pre-position installer/staging/node_modules before packaging.`
      );
    });
  }

  await assertRequiredRuntimeDependencies(options.targetDirectory);
}

async function assertRequiredRuntimeDependencies(nodeModulesDirectory: string): Promise<void> {
  const missing: string[] = [];

  for (const dependency of REQUIRED_RUNTIME_DEPENDENCIES) {
    const manifestPath = join(nodeModulesDirectory, dependency, "package.json");
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { name?: unknown };
      if (manifest.name !== dependency) {
        missing.push(dependency);
      }
    } catch {
      missing.push(dependency);
    }
  }

  if (missing.length > 0) {
    throw new PackagingPrerequisiteError(
      `Staged production node_modules is incomplete. Missing runtime dependency manifests for: ${missing.join(", ")}. Prepare Windows x64 production dependencies before packaging.`
    );
  }
}

function wixIdentifier(input: string): string {
  const normalized = input.replace(/[^A-Za-z0-9_]/gu, "_");
  const legalStart = /^[A-Za-z_]/u.test(normalized) ? normalized : `_${normalized}`;
  const hash = createHash("sha1").update(input).digest("hex").slice(0, 12);
  const maxPrefixLength = 55;
  return `${legalStart.slice(0, maxPrefixLength)}_${hash}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/"/gu, "&quot;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

/** @deprecated Use buildInstallerMsiCommand */
export const buildInstallerBundleCommand = buildInstallerMsiCommand;

/** @deprecated Use runInstallerMsiBuild */
export const runInstallerBundleBuild = runInstallerMsiBuild;

export async function packageWindowsInstaller(projectRoot: string): Promise<{ outputPath: string }> {
  assertWindowsPackagingHost();
  assertDotnetAvailable();
  await assertInstallerWixPackagingLayout(projectRoot);
  restoreInstallerProject(projectRoot);
  await prepareInstallerStaging({ projectRoot });
  runInstallerMsiBuild(projectRoot);

  const outputPath = join(projectRoot, WINDOWS_INSTALLER_OUTPUT_RELATIVE);
  await access(outputPath);
  return { outputPath };
}

async function runCli(): Promise<void> {
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  console.error("Windows installer packaging prerequisites:\n" + formatPackagingPrerequisites());
  const result = await packageWindowsInstaller(projectRoot);
  console.log(`Built ${result.outputPath}`);
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
