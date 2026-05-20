import type { ValidatedMappingConfig } from "../mapping/types.js";
import type { ProductChangeBatch } from "../poller/batch-builder.js";
import { redactString } from "../logging/redact.js";

export type ServerMessageType = "connector.config" | "batch.ack" | "config.updated" | "admin.request";
export type ConnectorMessageType = "connector.heartbeat" | "product.batch" | "connector.error" | "admin.response";
export type BatchNextAction = "continue" | "retry" | "reload_config";
export type AdminCommand = "schema.listTables";

export interface ConnectorConfigMessage {
  type: "connector.config";
  connectorId: string;
  customerId: string;
  mapping: ValidatedMappingConfig;
  sentAt?: string;
}

export interface BatchAckMessage {
  type: "batch.ack";
  batchId: string;
  accepted: boolean;
  acceptedRecordCount: number;
  rejectedRecordCount: number;
  nextAction: BatchNextAction;
  errorCode?: string;
  sentAt?: string;
}

export interface ConfigUpdatedMessage {
  type: "config.updated";
  mappingVersion?: string;
  reason?: string;
  sentAt?: string;
}

export interface AdminRequestMessage {
  type: "admin.request";
  requestId: string;
  command: AdminCommand;
  sentAt?: string;
}

export type ServerMessage = ConnectorConfigMessage | BatchAckMessage | ConfigUpdatedMessage | AdminRequestMessage;

export interface HeartbeatPayload {
  connectorVersion: string;
  online: boolean;
  mappingVersion?: string;
  lastSuccessfulSendAt?: string;
  lastErrorCode?: string;
  reconnectAttemptCount: number;
}

export interface ConnectorHeartbeatMessage {
  type: "connector.heartbeat";
  sentAt: string;
  payload: HeartbeatPayload;
}

export interface ProductBatchMessage {
  type: "product.batch";
  sentAt: string;
  batch: ProductChangeBatch;
}

export interface ConnectorErrorPayload {
  errorCode: string;
  message: string;
  connectorId?: string;
  customerId?: string;
  mappingVersion?: string;
  batchId?: string;
}

export interface ConnectorErrorMessage {
  type: "connector.error";
  sentAt: string;
  error: ConnectorErrorPayload;
}

export interface AdminResponseSuccessPayload {
  tables: string[];
}

export interface AdminResponseErrorPayload {
  errorCode: string;
  message: string;
}

interface AdminResponseBaseMessage {
  type: "admin.response";
  requestId: string;
  command: AdminCommand;
  sentAt: string;
}

export interface AdminResponseSuccessMessage extends AdminResponseBaseMessage {
  ok: true;
  payload: AdminResponseSuccessPayload;
}

export interface AdminResponseErrorMessage extends AdminResponseBaseMessage {
  ok: false;
  error: AdminResponseErrorPayload;
}

export type AdminResponseMessage = AdminResponseSuccessMessage | AdminResponseErrorMessage;

export type ConnectorMessage =
  | ConnectorHeartbeatMessage
  | ProductBatchMessage
  | ConnectorErrorMessage
  | AdminResponseMessage;

export class ProtocolParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProtocolParseError";
  }
}

export function parseServerMessage(raw: string | Buffer | ArrayBuffer | Buffer[]): ServerMessage {
  const value = parseJson(raw);
  const message = expectRecord(value, "message");
  const type = expectString(message.type, "type") as ServerMessageType;

  switch (type) {
    case "connector.config":
      return parseConnectorConfig(message);
    case "batch.ack":
      return parseBatchAck(message);
    case "config.updated":
      return parseConfigUpdated(message);
    case "admin.request":
      return parseAdminRequest(message);
    default:
      throw new ProtocolParseError(`Unsupported server message type: ${type}`);
  }
}

export function serializeConnectorMessage(message: ConnectorMessage): string {
  return JSON.stringify(message);
}

export function parseAdminResponseMessage(raw: string | Buffer | ArrayBuffer | Buffer[]): AdminResponseMessage {
  const value = parseJson(raw);
  const message = expectRecord(value, "message");
  const type = expectString(message.type, "type");
  if (type !== "admin.response") {
    throw new ProtocolParseError(`Unsupported connector message type: ${type}`);
  }

  const base = {
    type: "admin.response" as const,
    requestId: validateRequestId(expectString(message.requestId, "requestId")),
    command: parseAdminCommand(message.command),
    sentAt: expectString(message.sentAt, "sentAt")
  };
  const ok = expectBoolean(message.ok, "ok");

  if (ok) {
    const payload = expectRecord(message.payload, "payload");
    return {
      ...base,
      ok,
      payload: {
        tables: expectStringArray(payload.tables, "payload.tables")
      }
    };
  }

  const error = expectRecord(message.error, "error");
  return {
    ...base,
    ok,
    error: {
      errorCode: expectString(error.errorCode, "error.errorCode"),
      message: expectString(error.message, "error.message")
    }
  };
}

export function buildAdminRequestMessage(
  input: {
    requestId: string;
    command: AdminCommand;
  },
  sentAt = new Date().toISOString()
): AdminRequestMessage {
  return {
    type: "admin.request",
    requestId: validateRequestId(input.requestId),
    command: input.command,
    sentAt
  };
}

export function serializeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}

export function buildProductBatchMessage(batch: ProductChangeBatch, sentAt = new Date().toISOString()): ProductBatchMessage {
  return {
    type: "product.batch",
    sentAt,
    batch
  };
}

export function buildConnectorErrorMessage(
  input: ConnectorErrorPayload,
  sentAt = new Date().toISOString()
): ConnectorErrorMessage {
  return {
    type: "connector.error",
    sentAt,
    error: {
      errorCode: input.errorCode,
      message: input.message,
      connectorId: input.connectorId,
      customerId: input.customerId,
      mappingVersion: input.mappingVersion,
      batchId: input.batchId
    }
  };
}

export function buildAdminSuccessResponseMessage(
  input: {
    requestId: string;
    command: AdminCommand;
    tables: readonly string[];
  },
  sentAt = new Date().toISOString()
): AdminResponseMessage {
  return {
    type: "admin.response",
    requestId: validateRequestId(input.requestId),
    command: input.command,
    ok: true,
    payload: {
      tables: [...input.tables].sort((left, right) => left.localeCompare(right))
    },
    sentAt
  };
}

export function buildAdminErrorResponseMessage(
  input: {
    requestId: string;
    command: AdminCommand;
    errorCode: string;
    message: string;
    secrets?: readonly string[];
  },
  sentAt = new Date().toISOString()
): AdminResponseMessage {
  return {
    type: "admin.response",
    requestId: validateRequestId(input.requestId),
    command: input.command,
    ok: false,
    error: {
      errorCode: expectString(input.errorCode, "errorCode"),
      message: redactString(input.message, input.secrets ?? [])
    },
    sentAt
  };
}

function parseConnectorConfig(message: Record<string, unknown>): ConnectorConfigMessage {
  return {
    type: "connector.config",
    connectorId: expectString(message.connectorId, "connectorId"),
    customerId: expectString(message.customerId, "customerId"),
    mapping: parseMapping(message.mapping),
    sentAt: optionalString(message.sentAt, "sentAt")
  };
}

function parseBatchAck(message: Record<string, unknown>): BatchAckMessage {
  const nextAction = expectString(message.nextAction, "nextAction");
  if (!["continue", "retry", "reload_config"].includes(nextAction)) {
    throw new ProtocolParseError("nextAction must be continue, retry, or reload_config");
  }

  return {
    type: "batch.ack",
    batchId: expectString(message.batchId, "batchId"),
    accepted: expectBoolean(message.accepted, "accepted"),
    acceptedRecordCount: expectNonNegativeInteger(message.acceptedRecordCount, "acceptedRecordCount"),
    rejectedRecordCount: expectNonNegativeInteger(message.rejectedRecordCount, "rejectedRecordCount"),
    nextAction: nextAction as BatchNextAction,
    errorCode: optionalString(message.errorCode, "errorCode"),
    sentAt: optionalString(message.sentAt, "sentAt")
  };
}

function parseConfigUpdated(message: Record<string, unknown>): ConfigUpdatedMessage {
  return {
    type: "config.updated",
    mappingVersion: optionalString(message.mappingVersion, "mappingVersion"),
    reason: optionalString(message.reason, "reason"),
    sentAt: optionalString(message.sentAt, "sentAt")
  };
}

function parseAdminRequest(message: Record<string, unknown>): AdminRequestMessage {
  return {
    type: "admin.request",
    requestId: validateRequestId(expectString(message.requestId, "requestId")),
    command: parseAdminCommand(message.command),
    sentAt: optionalString(message.sentAt, "sentAt")
  };
}

function parseAdminCommand(value: unknown): AdminCommand {
  const command = expectString(value, "command");
  if (command !== "schema.listTables") {
    throw new ProtocolParseError("Unsupported admin command");
  }
  return command;
}

function parseMapping(value: unknown): ValidatedMappingConfig {
  const mapping = expectRecord(value, "mapping");
  const fields = expectRecord(mapping.fields, "mapping.fields");

  return {
    mappingVersion: expectString(mapping.mappingVersion, "mapping.mappingVersion"),
    selectedProductTable: optionalString(mapping.selectedProductTable, "mapping.selectedProductTable"),
    pollIntervalMs: expectPositiveInteger(mapping.pollIntervalMs, "mapping.pollIntervalMs"),
    batchSize: expectPositiveInteger(mapping.batchSize, "mapping.batchSize"),
    incrementalQuery: expectString(mapping.incrementalQuery, "mapping.incrementalQuery"),
    cursorField: expectString(mapping.cursorField, "mapping.cursorField"),
    cursorType: parseCursorType(mapping.cursorType),
    fields: {
      sourceProductCode: expectString(fields.sourceProductCode, "mapping.fields.sourceProductCode"),
      name: expectString(fields.name, "mapping.fields.name"),
      price: expectString(fields.price, "mapping.fields.price"),
      stock: expectString(fields.stock, "mapping.fields.stock"),
      barcode: optionalString(fields.barcode, "mapping.fields.barcode"),
      active: optionalString(fields.active, "mapping.fields.active"),
      sourceUpdatedAt: optionalString(fields.sourceUpdatedAt, "mapping.fields.sourceUpdatedAt")
    }
  };
}

function parseCursorType(value: unknown): "timestamp" | "number" {
  const cursorType = expectString(value, "mapping.cursorType");
  if (cursorType !== "timestamp" && cursorType !== "number") {
    throw new ProtocolParseError("mapping.cursorType must be timestamp or number");
  }
  return cursorType;
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

function expectRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolParseError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProtocolParseError(`${field} must be a non-empty string`);
  }
  return value;
}

function expectStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new ProtocolParseError(`${field} must be an array`);
  }
  return value.map((item, index) => expectString(item, `${field}[${index}]`));
}

function validateRequestId(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new ProtocolParseError("requestId must contain only letters, numbers, dots, underscores, colons, or hyphens");
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return expectString(value, field);
}

function expectBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ProtocolParseError(`${field} must be a boolean`);
  }
  return value;
}

function expectPositiveInteger(value: unknown, field: string): number {
  const parsed = expectNonNegativeInteger(value, field);
  if (parsed <= 0) {
    throw new ProtocolParseError(`${field} must be a positive integer`);
  }
  return parsed;
}

function expectNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new ProtocolParseError(`${field} must be a non-negative integer`);
  }
  return value as number;
}
