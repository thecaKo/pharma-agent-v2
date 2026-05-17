import type {
  ConfigValidationIssue,
  ConnectorConfig,
  DatabaseDriver,
  LogLevel
} from "./types.js";

const REQUIRED_ENV = [
  "CONNECTOR_TOKEN",
  "CONNECTOR_WS_URL",
  "DB_DRIVER",
  "DB_HOST",
  "DB_PORT",
  "DB_NAME",
  "DB_USER",
  "DB_PASSWORD"
] as const;

const DATABASE_DRIVERS = new Set<DatabaseDriver>(["mysql", "firebird"]);
const LOG_LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error"]);

export class ConfigValidationError extends Error {
  public readonly issues: ConfigValidationIssue[];

  public constructor(issues: ConfigValidationIssue[]) {
    super(`Invalid connector configuration: ${issues.map((issue) => `${issue.field} ${issue.message}`).join("; ")}`);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

export type Environment = Record<string, string | undefined>;

export function loadConfig(env: Environment = process.env): ConnectorConfig {
  const issues: ConfigValidationIssue[] = [];

  for (const field of REQUIRED_ENV) {
    if (!readRequired(env, field)) {
      issues.push({ field, message: "is required" });
    }
  }

  const driver = readRequired(env, "DB_DRIVER");
  if (driver && !DATABASE_DRIVERS.has(driver as DatabaseDriver)) {
    issues.push({ field: "DB_DRIVER", message: "must be mysql or firebird" });
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
    logLevel: logLevel as LogLevel
  };
}

export function configSecrets(config: Pick<ConnectorConfig, "connectorToken" | "database">): string[] {
  return [config.connectorToken, config.database.password].filter((value) => value.length > 0);
}

function readRequired(env: Environment, field: (typeof REQUIRED_ENV)[number]): string {
  return normalizeOptional(env[field], "");
}

function normalizeOptional(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : fallback;
}
