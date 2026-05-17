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
}

export interface ConfigValidationIssue {
  field: string;
  message: string;
}
