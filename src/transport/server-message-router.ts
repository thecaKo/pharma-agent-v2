import type { RawData } from "ws";
import { ProtocolParseError, type ServerMessageType } from "./protocol.js";
import {
  CONNECTOR_SETUP_CONFIG_COMMAND_TYPE,
  parseConnectorSetupConfigCommand
} from "./connector-setup-ws.js";
import {
  FILE_DISCOVERY_SCAN_COMMAND_TYPE,
  parseFileDiscoveryScanCommand
} from "./file-discovery-ws.js";
import {
  CATALOG_MAPPING_PREVIEW_COMMAND_TYPE,
  parseCatalogMappingPreviewCommand
} from "./mapping-preview.js";
import {
  parseSchemaTablesListCommand,
  SCHEMA_TABLES_LIST_COMMAND_TYPE,
  type SchemaDiscoveryRequest
} from "./schema-discovery.js";
import {
  AI_SESSION_START_TYPE, TOOL_INVOKE_TYPE, MAPPING_DECISION_TYPE, AI_SESSION_ABORT_TYPE,
  type AiSessionStartCommand, type ToolInvokeCommand, type MappingDecisionCommand, type AiSessionAbortCommand
} from "../ai-session/ai-protocol.js";

export type ServerMessageClassification = "malformed" | "core" | "extension" | "unsupported";

export const CORE_SERVER_MESSAGE_TYPES: ReadonlySet<ServerMessageType> = new Set([
  "connector.config",
  "batch.ack",
  "config.updated",
  "admin.request",
  "connector.bootstrap.dbConfig"
]);

export const DOCUMENTED_EXTENSION_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "schema.tables.list",
  "catalog.mapping.preview",
  FILE_DISCOVERY_SCAN_COMMAND_TYPE,
  CONNECTOR_SETUP_CONFIG_COMMAND_TYPE,
  AI_SESSION_START_TYPE,
  TOOL_INVOKE_TYPE,
  MAPPING_DECISION_TYPE,
  AI_SESSION_ABORT_TYPE
]);

export interface ServerMessageEnvelope {
  type: string;
  id?: string;
  message: Record<string, unknown>;
}

export type ServerMessageEnvelopeParseResult =
  | { classification: "malformed"; error: Error }
  | { classification: Exclude<ServerMessageClassification, "malformed">; envelope: ServerMessageEnvelope };

export interface ServerMessageDispatchHandlers {
  onMalformed: (error: Error) => void;
  onCore: (raw: RawData) => void;
  onExtension: (envelope: ServerMessageEnvelope, raw: RawData) => void;
  onUnsupported: (envelope: ServerMessageEnvelope) => void;
}

export function isCoreServerMessageType(type: string): type is ServerMessageType {
  return CORE_SERVER_MESSAGE_TYPES.has(type as ServerMessageType);
}

export function isDocumentedExtensionMessageType(type: string): boolean {
  return DOCUMENTED_EXTENSION_MESSAGE_TYPES.has(type);
}

export function parseServerMessageEnvelope(raw: RawData): ServerMessageEnvelopeParseResult {
  let value: unknown;
  try {
    value = parseJson(raw);
  } catch (error) {
    return {
      classification: "malformed",
      error: error instanceof Error ? error : new ProtocolParseError("Invalid JSON message")
    };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      classification: "malformed",
      error: new ProtocolParseError("message must be an object")
    };
  }

  const message = value as Record<string, unknown>;
  const typeValue = message.type;
  if (typeof typeValue !== "string" || typeValue.trim().length === 0) {
    return {
      classification: "malformed",
      error: new ProtocolParseError("type must be a non-empty string")
    };
  }

  const envelope: ServerMessageEnvelope = {
    type: typeValue,
    message
  };

  const id = message.id;
  if (typeof id === "string" && id.trim().length > 0) {
    envelope.id = id.trim();
  }

  if (isCoreServerMessageType(typeValue)) {
    return { classification: "core", envelope };
  }

  if (isDocumentedExtensionMessageType(typeValue)) {
    return { classification: "extension", envelope };
  }

  return { classification: "unsupported", envelope };
}

export function dispatchServerMessage(raw: RawData, handlers: ServerMessageDispatchHandlers): void {
  const result = parseServerMessageEnvelope(raw);

  switch (result.classification) {
    case "malformed":
      handlers.onMalformed(result.error);
      return;
    case "core":
      handlers.onCore(raw);
      return;
    case "extension":
      handlers.onExtension(result.envelope, raw);
      return;
    case "unsupported":
      handlers.onUnsupported(result.envelope);
      return;
  }
}

export type ExtensionRouteDispatchResult =
  | { kind: "handled" }
  | { kind: "malformed"; error: Error }
  | { kind: "schemaDiscoveryRequest"; request: Extract<SchemaDiscoveryRequest, { responseFormat: "legacy" }> }
  | { kind: "catalogMappingPreviewStub"; correlationId: string }
  | { kind: "fileDiscoveryScanRequest"; correlationId: string; rootPath?: string }
  | { kind: "setupConfigRequest"; request: import("./connector-setup-ws.js").ConnectorSetupConfigCommand }
  | { kind: "aiSessionStart"; command: AiSessionStartCommand }
  | { kind: "aiToolInvoke"; command: ToolInvokeCommand }
  | { kind: "aiMappingDecision"; command: MappingDecisionCommand }
  | { kind: "aiSessionAbort"; command: AiSessionAbortCommand };

export type ExtensionRouteHandler = (
  envelope: ServerMessageEnvelope,
  raw: RawData
) => ExtensionRouteDispatchResult;

const extensionRoutes = new Map<string, ExtensionRouteHandler>();

export function registerExtensionRoute(type: string, handler: ExtensionRouteHandler): void {
  extensionRoutes.set(type, handler);
}

export function dispatchExtensionMessage(
  envelope: ServerMessageEnvelope,
  raw: RawData
): ExtensionRouteDispatchResult {
  const handler = extensionRoutes.get(envelope.type);
  if (!handler) {
    return { kind: "handled" };
  }
  return handler(envelope, raw);
}

registerExtensionRoute(SCHEMA_TABLES_LIST_COMMAND_TYPE, (_envelope, raw) => {
  try {
    const command = parseSchemaTablesListCommand(raw);
    return {
      kind: "schemaDiscoveryRequest",
      request: {
        responseFormat: "legacy",
        correlationId: command.correlationId
      }
    };
  } catch (error) {
    return {
      kind: "malformed",
      error: error instanceof Error ? error : new ProtocolParseError("Invalid schema.tables.list command")
    };
  }
});

registerExtensionRoute(CATALOG_MAPPING_PREVIEW_COMMAND_TYPE, (_envelope, raw) => {
  try {
    const command = parseCatalogMappingPreviewCommand(raw);
    return {
      kind: "catalogMappingPreviewStub",
      correlationId: command.correlationId
    };
  } catch (error) {
    return {
      kind: "malformed",
      error: error instanceof Error ? error : new ProtocolParseError("Invalid catalog.mapping.preview command")
    };
  }
});

registerExtensionRoute(CONNECTOR_SETUP_CONFIG_COMMAND_TYPE, (_envelope, raw) => {
  try {
    const command = parseConnectorSetupConfigCommand(raw);
    return {
      kind: "setupConfigRequest",
      request: command
    };
  } catch (error) {
    return {
      kind: "malformed",
      error: error instanceof Error ? error : new ProtocolParseError("Invalid connector.setup.config command")
    };
  }
});

registerExtensionRoute(FILE_DISCOVERY_SCAN_COMMAND_TYPE, (_envelope, raw) => {
  try {
    const command = parseFileDiscoveryScanCommand(raw);
    return {
      kind: "fileDiscoveryScanRequest",
      correlationId: command.correlationId,
      ...(command.rootPath !== undefined ? { rootPath: command.rootPath } : {})
    };
  } catch (error) {
    return {
      kind: "malformed",
      error:
        error instanceof Error ? error : new ProtocolParseError("Invalid file-discovery.scan command")
    };
  }
});

function parseJson(raw: RawData): unknown {
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
