import { spawnSync } from "node:child_process";
import { access, copyFile, cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getInstallerServiceMetadata } from "./metadata.js";

export const WINDOWS_INSTALLER_PACKAGE_SCRIPT = "package:windows-installer";
export const WINDOWS_INSTALLER_OUTPUT_RELATIVE = "installer/bin/Release/PharmaAgentConnector.msi";
export const WINDOWS_INSTALLER_PROJECT_RELATIVE = "installer/ConnectorPackage.wixproj";
export const RUN_WINDOWS_INSTALLER_TESTS_ENV = "RUN_WINDOWS_INSTALLER_TESTS";

export const REQUIRED_WIX_EXTENSION_PACKAGES = ["WixToolset.UI.wixext", "WixToolset.Util.wixext"] as const;

export const PACKAGING_PREREQUISITES = [
  "Windows host (win32)",
  ".NET SDK 8+ with MSBuild on PATH (`dotnet` command)",
  "WiX Toolset 5.x (restored through WixToolset.Sdk when building the installer projects)",
  "Built connector output in `dist/` (the packaging script runs `npm run build` first)",
  "Windows x64 `node.exe` copied into `installer/staging/node.exe` or supplied through NODE_EXE_PATH"
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
}): Promise<{ stagingDir: string }> {
  const metadata = getInstallerServiceMetadata();
  const stagingDir = join(options.projectRoot, "installer", "staging");
  const distSource = join(options.projectRoot, metadata.entrypointRelativePath);

  await access(distSource);
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(join(stagingDir, "dist"), { recursive: true });
  await cp(join(options.projectRoot, "dist"), join(stagingDir, "dist"), { recursive: true });
  await cp(join(options.projectRoot, "package.json"), join(stagingDir, "package.json"));

  const nodeSource = options.nodeExecutablePath ?? process.env.NODE_EXE_PATH;
  const stagedNodeExecutable = join(stagingDir, metadata.nodeExecutable);

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

  return { stagingDir };
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
