import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import {
  INSTALLER_PROGRAM_DATA_DIR_NAME,
  INSTALLER_PROGRAM_DATA_LOG_DIR_NAME
} from "../installer/metadata.js";
import type { DatabaseDriver } from "../config/types.js";
import { STATE_FILE_NAME } from "../state/state-types.js";

export interface StartupDiagnosticsOptions {
  baseDir?: string;
  programData?: string;
  stateFilePath: string;
  websocketUrlConfigured: boolean;
  databaseConfigured: boolean;
  dbDriver?: DatabaseDriver;
  startupMetadata?: Record<string, string | boolean | undefined>;
  fileSystem?: {
    access(path: string, mode?: number): Promise<void>;
  };
}

export interface StartupDiagnosticsReport {
  serviceWrapper: "WinSW";
  runtimeBasePath: string;
  stateFilePath: string;
  logPath: string;
  databaseConfigured: boolean;
  websocketUrlConfigured: boolean;
  distFound: boolean;
  nodeModulesFound: boolean;
  requiredDependenciesFound: boolean;
  requiredRuntimeDependencies: StartupDependencyStatus[];
  startupMetadata?: Record<string, string | boolean>;
}

export interface StartupDependencyStatus {
  name: string;
  path: string;
  status: "present" | "missing" | "unknown";
}

export interface StartupDiagnosticsWarning {
  event: "diagnostics.startup_warning";
  dependency: string;
  path: string;
  message: string;
}

export interface StartupDiagnosticsResult {
  report: StartupDiagnosticsReport;
  warnings: StartupDiagnosticsWarning[];
}

export async function collectStartupDiagnostics(
  options: StartupDiagnosticsOptions
): Promise<StartupDiagnosticsResult> {
  const fileSystem = options.fileSystem ?? { access };
  const baseDir = options.baseDir ?? process.cwd();
  const logPath = defaultServiceLogPath(options.programData);

  const dependencies = buildDependencyChecks(baseDir, options.dbDriver);
  const statuses = await Promise.all(
    dependencies.map(async (dependency) => ({
      ...dependency,
      status: await detectPathStatus(fileSystem, dependency.path)
    }))
  );

  const warnings = statuses
    .filter((dependency) => dependency.status === "unknown")
    .map(
      (dependency): StartupDiagnosticsWarning => ({
        event: "diagnostics.startup_warning",
        dependency: dependency.name,
        path: dependency.path,
        message: "Could not verify startup dependency path."
      })
    );

  return {
    report: {
      serviceWrapper: "WinSW",
      runtimeBasePath: baseDir,
      stateFilePath: options.stateFilePath,
      logPath,
      databaseConfigured: options.databaseConfigured,
      websocketUrlConfigured: options.websocketUrlConfigured,
      distFound: statuses.some((dependency) => dependency.name === "dist" && dependency.status === "present"),
      nodeModulesFound: statuses.some(
        (dependency) => dependency.name === "node_modules" && dependency.status === "present"
      ),
      requiredDependenciesFound: statuses.every((dependency) => dependency.status === "present"),
      requiredRuntimeDependencies: statuses,
      ...(options.startupMetadata ? { startupMetadata: compactMetadata(options.startupMetadata) } : {})
    },
    warnings
  };
}

export function defaultServiceLogPath(programData = process.env.PROGRAMDATA): string {
  return path.join(defaultProgramDataRoot(programData), INSTALLER_PROGRAM_DATA_DIR_NAME, INSTALLER_PROGRAM_DATA_LOG_DIR_NAME);
}

export function defaultServiceStateFilePath(programData = process.env.PROGRAMDATA): string {
  return path.join(defaultProgramDataRoot(programData), INSTALLER_PROGRAM_DATA_DIR_NAME, STATE_FILE_NAME);
}

function defaultProgramDataRoot(programData = process.env.PROGRAMDATA): string {
  const normalized = programData?.trim();
  return normalized && normalized.length > 0 ? normalized : path.join(homedir(), "AppData", "Local");
}

function buildDependencyChecks(baseDir: string, dbDriver?: DatabaseDriver): Array<Pick<StartupDependencyStatus, "name" | "path">> {
  const dependencies: Array<Pick<StartupDependencyStatus, "name" | "path">> = [
    { name: "dist", path: path.join(baseDir, "dist") },
    { name: "node_modules", path: path.join(baseDir, "node_modules") },
    { name: "dist/main.js", path: path.join(baseDir, "dist", "main.js") },
    { name: "node_modules/pino", path: path.join(baseDir, "node_modules", "pino", "package.json") },
    { name: "node_modules/ws", path: path.join(baseDir, "node_modules", "ws", "package.json") }
  ];

  if (dbDriver === "mysql") {
    dependencies.push({
      name: "node_modules/mysql2",
      path: path.join(baseDir, "node_modules", "mysql2", "package.json")
    });
  }

  if (dbDriver === "firebird") {
    dependencies.push({
      name: "node_modules/node-firebird",
      path: path.join(baseDir, "node_modules", "node-firebird", "package.json")
    });
  }

  return dependencies;
}

async function detectPathStatus(
  fileSystem: { access(path: string, mode?: number): Promise<void> },
  targetPath: string
): Promise<StartupDependencyStatus["status"]> {
  try {
    await fileSystem.access(targetPath, constants.R_OK);
    return "present";
  } catch (error) {
    if (isMissingFileError(error)) {
      return "missing";
    }
    return "unknown";
  }
}

function compactMetadata(input: Record<string, string | boolean | undefined>): Record<string, string | boolean> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Record<
    string,
    string | boolean
  >;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (String((error as NodeJS.ErrnoException).code) === "ENOENT" ||
      String((error as NodeJS.ErrnoException).code) === "ENOTDIR")
  );
}
