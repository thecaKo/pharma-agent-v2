import type { DatabaseConfig, DatabaseDriver } from "../config/types.js";
import { connectionDefaults, discoveryConnectionSource } from "../cli/database-setup.js";
import type { DatabaseSetupCandidateView } from "../db/file-discovery.js";
import { ProtocolParseError } from "./protocol.js";

export const CONNECTOR_SETUP_CONFIG_COMMAND_TYPE = "connector.setup.config";
export const CONNECTOR_SETUP_CONFIG_RESULT_TYPE = "connector.setup.config.result";

export const SETUP_CONFIG_VALIDATION_FAILED_ERROR_CODE = "SETUP_CONFIG_VALIDATION_FAILED";
export const SETUP_CONNECTION_FAILED_ERROR_CODE = "SETUP_CONNECTION_FAILED";

export type ConnectorSetupMethod = "manual" | "file_discovery";

export interface ConnectorSetupConfigCommand {
  type: typeof CONNECTOR_SETUP_CONFIG_COMMAND_TYPE;
  correlationId: string;
  setupMethod: ConnectorSetupMethod;
  driver: DatabaseDriver;
  host?: string;
  port?: number;
  database?: string;
  databaseName?: string;
  username?: string;
  password?: string;
  path?: string;
  selectedFileCandidateId?: string;
}

export interface ConnectorSetupConfigResultMessage {
  id: string;
  type: typeof CONNECTOR_SETUP_CONFIG_RESULT_TYPE;
  ok: boolean;
  setupMethod?: ConnectorSetupMethod;
  driver?: DatabaseDriver;
  errorCode?: string;
  message?: string;
}

export function parseConnectorSetupConfigCommand(
  raw: string | Buffer | ArrayBuffer | Buffer[]
): ConnectorSetupConfigCommand {
  const value = parseJson(raw);
  expectRecordRoot(value);
  const message = value as Record<string, unknown>;
  const type = expectNonEmptyString(message.type, "type");
  if (type !== CONNECTOR_SETUP_CONFIG_COMMAND_TYPE) {
    throw new ProtocolParseError(`Unsupported server message type: ${type}`);
  }

  const setupMethod = parseSetupMethod(message.setupMethod);
  const driver = parseDriver(message.driver);

  const command: ConnectorSetupConfigCommand = {
    type: CONNECTOR_SETUP_CONFIG_COMMAND_TYPE,
    correlationId: expectCorrelationId(message.id, "id"),
    setupMethod,
    driver
  };

  if (setupMethod === "manual") {
    command.host = expectNonEmptyString(message.host, "host").trim();
    command.port = expectPort(message.port, "port");
    const database =
      optionalNonEmptyString(message.database) ??
      optionalNonEmptyString(message.databaseName) ??
      optionalNonEmptyString(message.database_name);
    if (!database) {
      throw new ProtocolParseError("database must be a non-empty string");
    }
    command.database = database;
    command.username = expectNonEmptyString(message.username, "username").trim();
    command.password = expectPassword(message.password, "password");
    return command;
  }

  const path = expectNonEmptyString(message.path, "path").trim();
  command.path = path;
  const selectedFileCandidateId = optionalNonEmptyString(message.selectedFileCandidateId);
  if (selectedFileCandidateId) {
    command.selectedFileCandidateId = selectedFileCandidateId;
  }

  const username = optionalNonEmptyString(message.username);
  if (username) {
    command.username = username;
  }
  if (message.password !== undefined && message.password !== null) {
    command.password = expectPassword(message.password, "password");
  }

  return command;
}

export function setupConfigToDatabaseConfig(command: ConnectorSetupConfigCommand): DatabaseConfig {
  if (command.setupMethod === "manual") {
    return {
      driver: command.driver,
      host: command.host!,
      port: command.port!,
      name: command.database!,
      user: command.username!,
      password: command.password!
    };
  }

  return fileDiscoveryPathToDatabaseConfig({
    driver: command.driver,
    path: command.path!,
    username: command.username,
    password: command.password
  });
}

export function buildSetupConfigSuccessResult(
  correlationId: string,
  command: Pick<ConnectorSetupConfigCommand, "setupMethod" | "driver">
): ConnectorSetupConfigResultMessage {
  return {
    id: correlationId,
    type: CONNECTOR_SETUP_CONFIG_RESULT_TYPE,
    ok: true,
    setupMethod: command.setupMethod,
    driver: command.driver
  };
}

export function buildSetupConfigFailureResult(
  correlationId: string,
  input: { errorCode: string; message: string }
): ConnectorSetupConfigResultMessage {
  return {
    id: correlationId,
    type: CONNECTOR_SETUP_CONFIG_RESULT_TYPE,
    ok: false,
    errorCode: input.errorCode,
    message: clipMessage(input.message)
  };
}

export function serializeConnectorSetupConfigResult(message: ConnectorSetupConfigResultMessage): string {
  return JSON.stringify(message);
}

export function extractSetupConfigSecrets(message: Record<string, unknown>): string[] {
  const secrets: string[] = [];
  const password = message.password;
  if (typeof password === "string" && password.length > 0) {
    secrets.push(password);
  }
  const databasePassword = message.databasePassword;
  if (typeof databasePassword === "string" && databasePassword.length > 0) {
    secrets.push(databasePassword);
  }
  return secrets;
}

export function fileDiscoveryPathToDatabaseConfig(input: {
  driver: DatabaseDriver;
  path: string;
  username?: string;
  password?: string;
}): DatabaseConfig {
  const candidate: DatabaseSetupCandidateView = {
    index: 0,
    path: input.path,
    type: input.driver,
    confidence: "high",
    supported: true
  };
  const source = discoveryConnectionSource(candidate);
  const defaults = connectionDefaults(source);

  return {
    driver: input.driver,
    host: defaults.host,
    port: defaults.port,
    name: defaults.databaseName.length > 0 ? defaults.databaseName : input.path,
    user: input.username?.trim() || defaults.user,
    password: input.password ?? defaults.password
  };
}

function parseSetupMethod(value: unknown): ConnectorSetupMethod {
  const method = expectNonEmptyString(value, "setupMethod");
  if (method !== "manual" && method !== "file_discovery") {
    throw new ProtocolParseError('setupMethod must be "manual" or "file_discovery"');
  }
  return method;
}

function parseDriver(value: unknown): DatabaseDriver {
  const driver = expectNonEmptyString(value, "driver");
  if (driver !== "mysql" && driver !== "firebird") {
    throw new ProtocolParseError('driver must be "mysql" or "firebird"');
  }
  return driver;
}

function parseJson(raw: string | Buffer | ArrayBuffer | Buffer[]): unknown {
  try {
    if (typeof raw === "string") {
      return JSON.parse(raw);
    }
    if (Array.isArray(raw)) {
      return JSON.parse(Buffer.concat(raw).toString("utf8"));
    }
    if (raw instanceof ArrayBuffer) {
      return JSON.parse(Buffer.from(new Uint8Array(raw)).toString("utf8"));
    }
    return JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch (error) {
    throw new ProtocolParseError(`Invalid JSON message: ${(error as Error).message}`);
  }
}

function expectRecordRoot(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolParseError("message must be an object");
  }
}

function expectNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProtocolParseError(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ProtocolParseError("database must be a string");
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function expectPassword(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ProtocolParseError(`${field} must be a string`);
  }
  return value;
}

function expectPort(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new ProtocolParseError(`${field} must be a positive integer`);
  }
  return value as number;
}

function expectCorrelationId(value: unknown, field: string): string {
  const correlationId = expectNonEmptyString(value, field).trim();
  if (correlationId.length > 128) {
    throw new ProtocolParseError(`${field} must be at most 128 characters`);
  }
  return correlationId;
}

function clipMessage(message: string): string {
  const trimmed = message.trim();
  const base = trimmed.length === 0 ? "Setup configuration failed" : trimmed;
  return base.length > 500 ? base.slice(0, 500) : base;
}
