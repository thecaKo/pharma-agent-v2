import type { ConfigValidationIssue, ConnectorConfig, DatabaseConfig, DatabaseDriver, LogLevel } from "./types.js";

export const REQUIRED_ENV = [
  "CONNECTOR_TOKEN",
  "CONNECTOR_WS_URL",
  "DB_DRIVER",
  "DB_HOST",
  "DB_PORT",
  "DB_NAME",
  "DB_USER",
  "DB_PASSWORD"
] as const;

export const CONNECTOR_ENV_KEYS = [...REQUIRED_ENV, "LOG_LEVEL"] as const;
export const REQUIRED_DATABASE_ENV = [
  "DB_DRIVER",
  "DB_HOST",
  "DB_PORT",
  "DB_NAME",
  "DB_USER",
  "DB_PASSWORD"
] as const;

export interface ConnectorStartupConfig extends Omit<ConnectorConfig, "database"> {
  database?: DatabaseConfig;
}

export interface LoadConfigOptions {
  requireDatabase?: boolean;
}

const DATABASE_DRIVERS = new Set<DatabaseDriver>(["mysql", "firebird", "postgresql", "mariadb"]);
const LOG_LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error"]);

function parsePositiveInteger(
  raw: string | undefined,
  fallback: number,
  fieldName: string,
  issues: ConfigValidationIssue[]
): number {
  const value = raw?.trim();
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    issues.push({ field: fieldName, message: "must be a positive integer" });
    return fallback;
  }
  return parsed;
}

export class ConfigValidationError extends Error {
  public readonly issues: ConfigValidationIssue[];

  public constructor(issues: ConfigValidationIssue[]) {
    super(`Invalid connector configuration: ${issues.map((issue) => `${issue.field} ${issue.message}`).join("; ")}`);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

export type Environment = Record<string, string | undefined>;

export function loadConfig(env?: Environment): ConnectorConfig;
export function loadConfig(env: Environment | undefined, options: { requireDatabase: false }): ConnectorStartupConfig;
export function loadConfig(
  env: Environment = process.env,
  options: LoadConfigOptions = {}
): ConnectorConfig | ConnectorStartupConfig {
  const requireDatabase = options.requireDatabase ?? true;
  const issues: ConfigValidationIssue[] = [];

  const heartbeatIntervalMs = parsePositiveInteger(
    env.HEARTBEAT_INTERVAL_MS,
    30_000,
    "HEARTBEAT_INTERVAL_MS",
    issues
  );
  const wsPingIntervalMs = parsePositiveInteger(
    env.WS_PING_INTERVAL_MS,
    30_000,
    "WS_PING_INTERVAL_MS",
    issues
  );
  const wsPongTimeoutMs = parsePositiveInteger(
    env.WS_PONG_TIMEOUT_MS,
    10_000,
    "WS_PONG_TIMEOUT_MS",
    issues
  );

  for (const field of REQUIRED_ENV) {
    if (!requireDatabase && isDatabaseField(field)) {
      continue;
    }
    if (!readRequired(env, field)) {
      issues.push({ field, message: "is required" });
    }
  }

  const hasDatabaseConfig = REQUIRED_DATABASE_ENV.some((field) => readRequired(env, field));
  if (!requireDatabase && !hasDatabaseConfig) {
    const logLevel = normalizeOptional(env.LOG_LEVEL, "info");
    if (!LOG_LEVELS.has(logLevel as LogLevel)) {
      issues.push({ field: "LOG_LEVEL", message: "must be debug, info, warn, or error" });
    }
    if (issues.length > 0) {
      throw new ConfigValidationError(issues);
    }
    return {
      connectorToken: readRequired(env, "CONNECTOR_TOKEN"),
      websocketUrl: readRequired(env, "CONNECTOR_WS_URL"),
      logLevel: logLevel as LogLevel,
      heartbeatIntervalMs,
      wsPingIntervalMs,
      wsPongTimeoutMs
    };
  }

  if (!requireDatabase) {
    for (const field of REQUIRED_DATABASE_ENV) {
      if (!readRequired(env, field)) {
        issues.push({ field, message: "is required" });
      }
    }
  }

  const driver = readRequired(env, "DB_DRIVER");
  if (driver && !DATABASE_DRIVERS.has(driver as DatabaseDriver)) {
    issues.push({ field: "DB_DRIVER", message: "must be mysql, firebird, postgresql, or mariadb" });
  }

  const portValue = readRequired(env, "DB_PORT");
  const port = Number(portValue);
  if (portValue && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
    issues.push({ field: "DB_PORT", message: "must be a valid TCP port" });
  }

  const logLevel = normalizeOptional(env.LOG_LEVEL, "info");
  if (!LOG_LEVELS.has(logLevel as LogLevel)) {
    issues.push({ field: "LOG_LEVEL", message: "must be debug, info, warn, or error" });
  }

  if (issues.length > 0) {
    throw new ConfigValidationError(issues);
  }

  return {
    connectorToken: readRequired(env, "CONNECTOR_TOKEN"),
    websocketUrl: readRequired(env, "CONNECTOR_WS_URL"),
    database: {
      driver: driver as DatabaseDriver,
      host: readRequired(env, "DB_HOST"),
      port,
      name: readRequired(env, "DB_NAME"),
      user: readRequired(env, "DB_USER"),
      password: readRequired(env, "DB_PASSWORD")
    },
    logLevel: logLevel as LogLevel,
    heartbeatIntervalMs,
    wsPingIntervalMs,
    wsPongTimeoutMs
  };
}

export function configSecrets(config: Pick<ConnectorConfig, "connectorToken" | "database">): string[] {
  return [config.connectorToken, config.database.password].filter((value) => value.length > 0);
}

function readRequired(env: Environment, field: (typeof REQUIRED_ENV)[number]): string {
  return normalizeOptional(env[field], "");
}

function isDatabaseField(field: (typeof REQUIRED_ENV)[number]): field is (typeof REQUIRED_DATABASE_ENV)[number] {
  return (REQUIRED_DATABASE_ENV as readonly string[]).includes(field);
}

function normalizeOptional(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : fallback;
}
