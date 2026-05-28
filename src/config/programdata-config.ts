import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { DatabaseConfig, LogLevel } from "./types.js";
import { redactString } from "../logging/redact.js";

export const CONNECTOR_CONFIG_FILE_NAME = "connector-config.json";
export const INSTALLER_CONFIG_DIR_NAME = "PharmaAgentConnector";

export const INSTALLER_MANAGED_CONFIG_KEYS = [
  "CONNECTOR_TOKEN",
  "CONNECTOR_WS_URL",
  "LOG_LEVEL"
] as const;

export type InstallerManagedConfigKey = (typeof INSTALLER_MANAGED_CONFIG_KEYS)[number];

export interface InstallerManagedConfig {
  CONNECTOR_TOKEN?: string;
  CONNECTOR_WS_URL?: string;
  LOG_LEVEL?: LogLevel;
}

export interface ProgramDataConfigLoadResult {
  path: string;
  values: InstallerManagedConfig;
  found: boolean;
}

export class ProgramDataConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProgramDataConfigError";
  }
}

const LOG_LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error"]);

export function defaultProgramDataConfigPath(programData = process.env.PROGRAMDATA): string {
  const root =
    programData && programData.trim().length > 0 ? programData : join(homedir(), "AppData", "Local");
  return join(root, INSTALLER_CONFIG_DIR_NAME, CONNECTOR_CONFIG_FILE_NAME);
}

export async function loadProgramDataConfig(
  options: { configFilePath?: string } = {}
): Promise<ProgramDataConfigLoadResult> {
  const path = options.configFilePath ?? defaultProgramDataConfigPath();

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return { path, values: {}, found: false };
    }
    throw new ProgramDataConfigError("Could not read installer-managed connector config file.");
  }

  const values = parseInstallerConfigContent(raw);
  return { path, values, found: true };
}

export function mergeInstallerConfigWithEnvironment(
  fileValues: InstallerManagedConfig,
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const fromFile = installerConfigToEnvironment(fileValues);
  const explicitEnv: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && value.trim().length > 0) {
      explicitEnv[key] = value;
    }
  }

  return { ...fromFile, ...explicitEnv };
}

function parseInstallerConfigContent(raw: string): InstallerManagedConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProgramDataConfigError(
      redactInstallerConfigDiagnostic("Installer-managed connector config file is not valid JSON.", raw)
    );
  }

  if (!isPlainRecord(parsed)) {
    throw new ProgramDataConfigError(
      "Installer-managed connector config file has an invalid structure."
    );
  }

  const values: InstallerManagedConfig = {};
  const token = readInstallerString(parsed, "CONNECTOR_TOKEN");
  if (token) {
    values.CONNECTOR_TOKEN = token;
  }

  const websocketUrl = readInstallerString(parsed, "CONNECTOR_WS_URL");
  if (websocketUrl) {
    values.CONNECTOR_WS_URL = websocketUrl;
  }

  const logLevel = readInstallerLogLevel(parsed);
  if (logLevel) {
    values.LOG_LEVEL = logLevel;
  }

  return values;
}

function installerConfigToEnvironment(values: InstallerManagedConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (values.CONNECTOR_TOKEN) {
    env.CONNECTOR_TOKEN = values.CONNECTOR_TOKEN;
  }
  if (values.CONNECTOR_WS_URL) {
    env.CONNECTOR_WS_URL = values.CONNECTOR_WS_URL;
  }
  if (values.LOG_LEVEL) {
    env.LOG_LEVEL = values.LOG_LEVEL;
  }
  return env;
}

function readInstallerString(record: Record<string, unknown>, key: InstallerManagedConfigKey): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readInstallerLogLevel(record: Record<string, unknown>): LogLevel | undefined {
  const value = record.LOG_LEVEL;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ProgramDataConfigError("LOG_LEVEL must be debug, info, warn, or error.");
  }
  const normalized = value.trim().toLowerCase();
  if (!LOG_LEVELS.has(normalized as LogLevel)) {
    throw new ProgramDataConfigError("LOG_LEVEL must be debug, info, warn, or error.");
  }
  return normalized as LogLevel;
}

function redactInstallerConfigDiagnostic(message: string, raw: string): string {
  const secrets = collectInstallerConfigSecrets(raw);
  return redactString(message, secrets);
}

function collectInstallerConfigSecrets(raw: string): string[] {
  const tokenMatch = raw.match(/"CONNECTOR_TOKEN"\s*:\s*"([^"]+)"/u);
  return tokenMatch?.[1] ? [tokenMatch[1]] : [];
}

export async function writeDatabaseConfig(
  programData: string | undefined,
  database: DatabaseConfig
): Promise<void> {
  const filePath = defaultProgramDataConfigPath(programData);
  await mkdir(dirname(filePath), { recursive: true });

  let current: Record<string, unknown> = {};
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    current = isPlainRecord(parsed) ? parsed : {};
  } catch (err) {
    if (!isMissingFileError(err)) {
      throw new ProgramDataConfigError(
        "Could not read existing connector config file before writing database section."
      );
    }
    current = {};
  }

  const next = { ...current, database };
  await writeFile(filePath, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    String((error as NodeJS.ErrnoException).code) === "ENOENT"
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
