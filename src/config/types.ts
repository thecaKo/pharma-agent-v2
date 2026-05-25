export type DatabaseDriver = "mysql" | "firebird";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface DatabaseConfig {
  driver: DatabaseDriver;
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
}

export interface ConnectorConfig {
  connectorToken: string;
  websocketUrl: string;
  database: DatabaseConfig;
  logLevel: LogLevel;
  heartbeatIntervalMs: number;
  wsPingIntervalMs: number;
  wsPongTimeoutMs: number;
}

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
export const DEFAULT_WS_PING_INTERVAL_MS = 30_000;
export const DEFAULT_WS_PONG_TIMEOUT_MS = 10_000;

export interface ConfigValidationIssue {
  field: string;
  message: string;
}
