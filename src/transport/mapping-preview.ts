import { ProtocolParseError } from "./protocol.js";

export const CATALOG_MAPPING_PREVIEW_COMMAND_TYPE = "catalog.mapping.preview";
export const CATALOG_MAPPING_PREVIEW_RESULT_TYPE = "catalog.mapping.preview.result";

export interface CatalogMappingPreviewSummary {
  matchedCount: number;
  sampleCount: number;
  invalidCount: number;
}

export interface CatalogMappingPreviewCommand {
  type: typeof CATALOG_MAPPING_PREVIEW_COMMAND_TYPE;
  correlationId: string;
  mapping?: unknown;
  maxSampleSize?: unknown;
}

export interface CatalogMappingPreviewResultMessage {
  id: string;
  type: typeof CATALOG_MAPPING_PREVIEW_RESULT_TYPE;
  samples: [];
  summary: CatalogMappingPreviewSummary;
}

export function tryParseCatalogMappingPreviewCommand(
  raw: string | Buffer | ArrayBuffer | Buffer[]
): CatalogMappingPreviewCommand | undefined {
  try {
    return parseCatalogMappingPreviewCommand(raw);
  } catch {
    return undefined;
  }
}

export function parseCatalogMappingPreviewCommand(
  raw: string | Buffer | ArrayBuffer | Buffer[]
): CatalogMappingPreviewCommand {
  const value = parseJson(raw);
  const message = expectRecord(value, "message");
  const type = expectString(message.type, "type");
  if (type !== CATALOG_MAPPING_PREVIEW_COMMAND_TYPE) {
    throw new ProtocolParseError(`Unsupported server message type: ${type}`);
  }

  const command: CatalogMappingPreviewCommand = {
    type: CATALOG_MAPPING_PREVIEW_COMMAND_TYPE,
    correlationId: expectCorrelationId(message.id, "id")
  };

  if ("mapping" in message) {
    command.mapping = message.mapping;
  }
  if ("maxSampleSize" in message) {
    command.maxSampleSize = message.maxSampleSize;
  }

  return command;
}

export function buildCatalogMappingPreviewStubResult(correlationId: string): CatalogMappingPreviewResultMessage {
  return {
    id: correlationId,
    type: CATALOG_MAPPING_PREVIEW_RESULT_TYPE,
    samples: [],
    summary: {
      matchedCount: 0,
      sampleCount: 0,
      invalidCount: 0
    }
  };
}

export function serializeCatalogMappingPreviewResult(message: CatalogMappingPreviewResultMessage): string {
  return JSON.stringify(message);
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

function expectCorrelationId(value: unknown, field: string): string {
  const correlationId = expectString(value, field).trim();
  if (correlationId.length > 128) {
    throw new ProtocolParseError(`${field} must be at most 128 characters`);
  }
  return correlationId;
}
