import type { DatabaseColumn } from "../db/source-adapter.js";
import { ProtocolParseError } from "./protocol.js";

export const SCHEMA_TABLES_LIST_COMMAND_TYPE = "schema.tables.list";
export const SCHEMA_TABLES_LIST_RESULT_TYPE = "schema.tables.list.result";

export const SCHEMA_DISCOVERY_MAX_TABLE_COUNT = 500;
export const SCHEMA_DISCOVERY_MAX_TABLE_NAME_LENGTH = 128;
export const SCHEMA_DISCOVERY_MAX_COLUMN_COUNT_PER_TABLE = 200;
export const SCHEMA_DISCOVERY_MAX_COLUMN_NAME_LENGTH = 128;
export const SCHEMA_DISCOVERY_MAX_COLUMN_TYPE_LENGTH = 64;

export interface SchemaDiscoveryColumn {
  name: string;
  type: string;
  nullable?: boolean;
}

export interface SchemaDiscoveryTable {
  name: string;
  columns: SchemaDiscoveryColumn[];
}

export interface SchemaTablesListCommand {
  type: typeof SCHEMA_TABLES_LIST_COMMAND_TYPE;
  correlationId: string;
}

export interface SchemaTablesListResultMessage {
  id: string;
  type: typeof SCHEMA_TABLES_LIST_RESULT_TYPE;
  tables: SchemaDiscoveryTable[];
}

export type SchemaDiscoveryRequest =
  | {
      responseFormat: "legacy";
      correlationId: string;
    }
  | {
      responseFormat: "admin";
      correlationId: string;
      command: "schema.listTables";
    };

export function tryParseSchemaTablesListCommand(
  raw: string | Buffer | ArrayBuffer | Buffer[]
): SchemaTablesListCommand | undefined {
  try {
    return parseSchemaTablesListCommand(raw);
  } catch {
    return undefined;
  }
}

export function parseSchemaTablesListCommand(
  raw: string | Buffer | ArrayBuffer | Buffer[]
): SchemaTablesListCommand {
  const value = parseJson(raw);
  const message = expectRecord(value, "message");
  const type = expectString(message.type, "type");
  if (type !== SCHEMA_TABLES_LIST_COMMAND_TYPE) {
    throw new ProtocolParseError(`Unsupported server message type: ${type}`);
  }

  return {
    type: SCHEMA_TABLES_LIST_COMMAND_TYPE,
    correlationId: expectCorrelationId(message.id, "id")
  };
}

export function buildSchemaTablesListResult(input: {
  correlationId: string;
  tables: readonly SchemaDiscoveryTable[];
}): SchemaTablesListResultMessage {
  return {
    id: input.correlationId,
    type: SCHEMA_TABLES_LIST_RESULT_TYPE,
    tables: sanitizeSchemaDiscoveryTables(input.tables)
  };
}

export function serializeSchemaTablesListResult(message: SchemaTablesListResultMessage): string {
  return JSON.stringify(message);
}

export function tryParseSchemaTablesListResult(
  raw: string | Buffer | ArrayBuffer | Buffer[]
): SchemaTablesListResultMessage | undefined {
  let value: unknown;
  try {
    value = parseJsonFlexible(raw);
  } catch {
    return undefined;
  }
  try {
    const message = expectRecord(value, "message");
    const type = expectString(message.type, "type");
    if (type !== SCHEMA_TABLES_LIST_RESULT_TYPE) {
      return undefined;
    }
    const correlationId = expectCorrelationId(message.id, "id");
    if (!Array.isArray(message.tables)) {
      return undefined;
    }
    return {
      id: correlationId,
      type: SCHEMA_TABLES_LIST_RESULT_TYPE,
      tables: sanitizeSchemaDiscoveryTables(message.tables as SchemaDiscoveryTable[])
    };
  } catch {
    return undefined;
  }
}

export function normalizeSchemaDiscoveryColumns(columns: readonly DatabaseColumn[]): SchemaDiscoveryColumn[] {
  const normalized: SchemaDiscoveryColumn[] = [];

  for (const column of columns.slice(0, SCHEMA_DISCOVERY_MAX_COLUMN_COUNT_PER_TABLE)) {
    const name = trimToMax(column.name, SCHEMA_DISCOVERY_MAX_COLUMN_NAME_LENGTH);
    if (!name) {
      continue;
    }

    const type = trimToMax(column.dataType ?? "unknown", SCHEMA_DISCOVERY_MAX_COLUMN_TYPE_LENGTH) ?? "unknown";
    const entry: SchemaDiscoveryColumn = { name, type };
    if (column.nullable !== undefined) {
      entry.nullable = column.nullable;
    }
    normalized.push(entry);
  }

  return normalized;
}

export function sanitizeSchemaDiscoveryTables(tables: readonly SchemaDiscoveryTable[]): SchemaDiscoveryTable[] {
  const normalized: SchemaDiscoveryTable[] = [];

  for (const table of tables.slice(0, SCHEMA_DISCOVERY_MAX_TABLE_COUNT)) {
    const name = trimToMax(table.name, SCHEMA_DISCOVERY_MAX_TABLE_NAME_LENGTH);
    if (!name) {
      continue;
    }

    const columns: SchemaDiscoveryColumn[] = [];
    for (const column of table.columns.slice(0, SCHEMA_DISCOVERY_MAX_COLUMN_COUNT_PER_TABLE)) {
      const columnName = trimToMax(column.name, SCHEMA_DISCOVERY_MAX_COLUMN_NAME_LENGTH);
      const columnType = trimToMax(column.type, SCHEMA_DISCOVERY_MAX_COLUMN_TYPE_LENGTH);
      if (!columnName || !columnType) {
        continue;
      }

      const entry: SchemaDiscoveryColumn = { name: columnName, type: columnType };
      if (column.nullable !== undefined) {
        entry.nullable = column.nullable;
      }
      columns.push(entry);
    }

    normalized.push({ name, columns });
  }

  return normalized.sort((left, right) => left.name.localeCompare(right.name));
}

function parseJsonFlexible(raw: string | Buffer | ArrayBuffer | Buffer[]): unknown {
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

function parseJson(raw: string | Buffer | ArrayBuffer | Buffer[]): unknown {
  return parseJsonFlexible(raw);
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

function expectCorrelationId(value: unknown, field: string): string {
  const correlationId = expectString(value, field).trim();
  if (correlationId.length > 128) {
    throw new ProtocolParseError(`${field} must be at most 128 characters`);
  }
  return correlationId;
}

function trimToMax(value: string, maxLength: number): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}
