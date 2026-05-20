import { describe, expect, it, vi } from "vitest";
import {
  dispatchExtensionMessage,
  dispatchServerMessage,
  DOCUMENTED_EXTENSION_MESSAGE_TYPES,
  isCoreServerMessageType,
  isDocumentedExtensionMessageType,
  parseServerMessageEnvelope
} from "../../src/transport/server-message-router.js";
import { SCHEMA_TABLES_LIST_COMMAND_TYPE } from "../../src/transport/schema-discovery.js";
import {
  CATALOG_MAPPING_PREVIEW_COMMAND_TYPE
} from "../../src/transport/mapping-preview.js";
import { CONNECTOR_SETUP_CONFIG_COMMAND_TYPE } from "../../src/transport/connector-setup-ws.js";
import { FILE_DISCOVERY_SCAN_COMMAND_TYPE } from "../../src/transport/file-discovery-ws.js";
import { parseServerMessage } from "../../src/transport/protocol.js";
import { validMapping } from "../helpers/mapping.js";

describe("server-message-router", () => {
  it("classifies invalid JSON as malformed", () => {
    const result = parseServerMessageEnvelope("{not-json");

    expect(result).toEqual({
      classification: "malformed",
      error: expect.objectContaining({
        name: "ProtocolParseError",
        message: expect.stringContaining("Invalid JSON message")
      })
    });
  });

  it("classifies JSON without type as malformed", () => {
    const result = parseServerMessageEnvelope(JSON.stringify({ id: "cmd-1" }));

    expect(result).toEqual({
      classification: "malformed",
      error: expect.objectContaining({
        name: "ProtocolParseError",
        message: "type must be a non-empty string"
      })
    });
  });

  it("classifies empty type as malformed", () => {
    const result = parseServerMessageEnvelope(JSON.stringify({ type: "   " }));

    expect(result.classification).toBe("malformed");
  });

  it("classifies core connector.config messages", () => {
    const payload = JSON.stringify({
      type: "connector.config",
      connectorId: "connector-1",
      customerId: "customer-1",
      mapping: validMapping()
    });
    const result = parseServerMessageEnvelope(payload);

    expect(result).toMatchObject({
      classification: "core",
      envelope: {
        type: "connector.config"
      }
    });
    expect(isCoreServerMessageType("connector.config")).toBe(true);
    expect(parseServerMessage(payload)).toMatchObject({
      type: "connector.config",
      connectorId: "connector-1"
    });
  });

  it("classifies core batch.ack messages", () => {
    const payload = JSON.stringify({
      type: "batch.ack",
      batchId: "batch-1",
      accepted: true,
      acceptedRecordCount: 1,
      rejectedRecordCount: 0,
      nextAction: "continue"
    });
    const result = parseServerMessageEnvelope(payload);

    expect(result).toMatchObject({
      classification: "core",
      envelope: {
        type: "batch.ack"
      }
    });
    expect(parseServerMessage(payload)).toMatchObject({
      type: "batch.ack",
      batchId: "batch-1"
    });
  });

  it("classifies documented extension messages without treating them as malformed", () => {
    const payload = JSON.stringify({
      id: "preview-1",
      type: "catalog.mapping.preview"
    });
    const result = parseServerMessageEnvelope(payload);

    expect(result).toMatchObject({
      classification: "extension",
      envelope: {
        type: "catalog.mapping.preview",
        id: "preview-1"
      }
    });
    expect(isDocumentedExtensionMessageType("catalog.mapping.preview")).toBe(true);
    expect(isDocumentedExtensionMessageType(FILE_DISCOVERY_SCAN_COMMAND_TYPE)).toBe(true);
    expect(DOCUMENTED_EXTENSION_MESSAGE_TYPES.has("schema.tables.list")).toBe(true);
  });

  it("classifies valid unknown types as unsupported", () => {
    const result = parseServerMessageEnvelope(JSON.stringify({ type: "future.command", id: "cmd-1" }));

    expect(result).toMatchObject({
      classification: "unsupported",
      envelope: {
        type: "future.command",
        id: "cmd-1"
      }
    });
  });

  it("logs malformed payloads and does not dispatch runtime handlers", () => {
    const onMalformed = vi.fn();
    const onCore = vi.fn();
    const onExtension = vi.fn();
    const onUnsupported = vi.fn();

    dispatchServerMessage("{bad-json", {
      onMalformed,
      onCore,
      onExtension,
      onUnsupported
    });

    expect(onMalformed).toHaveBeenCalledOnce();
    expect(onMalformed.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        name: "ProtocolParseError"
      })
    );
    expect(onCore).not.toHaveBeenCalled();
    expect(onExtension).not.toHaveBeenCalled();
    expect(onUnsupported).not.toHaveBeenCalled();
  });

  it("routes core connector.config payloads to the core handler", () => {
    const onCore = vi.fn();
    const payload = JSON.stringify({
      type: "connector.config",
      connectorId: "connector-1",
      customerId: "customer-1",
      mapping: validMapping()
    });

    dispatchServerMessage(payload, {
      onMalformed: vi.fn(),
      onCore,
      onExtension: vi.fn(),
      onUnsupported: vi.fn()
    });

    expect(onCore).toHaveBeenCalledOnce();
    expect(onCore).toHaveBeenCalledWith(payload);
  });

  it("routes core batch.ack payloads to the core handler", () => {
    const onCore = vi.fn();
    const payload = JSON.stringify({
      type: "batch.ack",
      batchId: "batch-1",
      accepted: true,
      acceptedRecordCount: 1,
      rejectedRecordCount: 0,
      nextAction: "continue"
    });

    dispatchServerMessage(payload, {
      onMalformed: vi.fn(),
      onCore,
      onExtension: vi.fn(),
      onUnsupported: vi.fn()
    });

    expect(onCore).toHaveBeenCalledOnce();
    expect(onCore).toHaveBeenCalledWith(payload);
  });

  it("routes catalog.mapping.preview to extension without malformed handling", () => {
    const onMalformed = vi.fn();
    const onExtension = vi.fn();
    const payload = JSON.stringify({
      id: "preview-1",
      type: "catalog.mapping.preview"
    });

    dispatchServerMessage(payload, {
      onMalformed,
      onCore: vi.fn(),
      onExtension,
      onUnsupported: vi.fn()
    });

    expect(onMalformed).not.toHaveBeenCalled();
    expect(onExtension).toHaveBeenCalledOnce();
    expect(onExtension.mock.calls[0]?.[0]).toMatchObject({
      type: "catalog.mapping.preview",
      id: "preview-1"
    });
  });

  it("dispatches schema.tables.list through the extension route table", () => {
    const payload = JSON.stringify({
      id: "cmd-1",
      type: SCHEMA_TABLES_LIST_COMMAND_TYPE
    });
    const envelope = parseServerMessageEnvelope(payload);

    expect(envelope).toMatchObject({
      classification: "extension",
      envelope: {
        type: SCHEMA_TABLES_LIST_COMMAND_TYPE,
        id: "cmd-1"
      }
    });

    if (envelope.classification !== "extension") {
      throw new Error("expected extension classification");
    }

    expect(dispatchExtensionMessage(envelope.envelope, payload)).toEqual({
      kind: "schemaDiscoveryRequest",
      request: {
        responseFormat: "legacy",
        correlationId: "cmd-1"
      }
    });
  });

  it("rejects schema.tables.list without id as malformed extension command", () => {
    const payload = JSON.stringify({
      type: SCHEMA_TABLES_LIST_COMMAND_TYPE
    });
    const envelope = parseServerMessageEnvelope(payload);

    if (envelope.classification !== "extension") {
      throw new Error("expected extension classification");
    }

    const result = dispatchExtensionMessage(envelope.envelope, payload);
    expect(result.kind).toBe("malformed");
    if (result.kind === "malformed") {
      expect(result.error).toEqual(
        expect.objectContaining({
          name: "ProtocolParseError",
          message: expect.stringContaining("id")
        })
      );
    }
  });

  it("dispatches catalog.mapping.preview through the extension route table", () => {
    const payload = JSON.stringify({
      id: "prev-1",
      type: CATALOG_MAPPING_PREVIEW_COMMAND_TYPE,
      mapping: validMapping(),
      maxSampleSize: 5
    });
    const envelope = parseServerMessageEnvelope(payload);

    if (envelope.classification !== "extension") {
      throw new Error("expected extension classification");
    }

    expect(dispatchExtensionMessage(envelope.envelope, payload)).toEqual({
      kind: "catalogMappingPreviewStub",
      correlationId: "prev-1"
    });
  });

  it("rejects catalog.mapping.preview without id as malformed extension command", () => {
    const payload = JSON.stringify({
      type: CATALOG_MAPPING_PREVIEW_COMMAND_TYPE,
      mapping: validMapping(),
      maxSampleSize: 5
    });
    const envelope = parseServerMessageEnvelope(payload);

    if (envelope.classification !== "extension") {
      throw new Error("expected extension classification");
    }

    const result = dispatchExtensionMessage(envelope.envelope, payload);
    expect(result.kind).toBe("malformed");
    if (result.kind === "malformed") {
      expect(result.error).toEqual(
        expect.objectContaining({
          name: "ProtocolParseError",
          message: expect.stringContaining("id")
        })
      );
    }
  });

  it("classifies connector.setup.config as extension without PROTOCOL_PARSE_ERROR path", () => {
    const payload = JSON.stringify({
      id: "setup-1",
      type: CONNECTOR_SETUP_CONFIG_COMMAND_TYPE,
      setupMethod: "manual",
      driver: "mysql",
      host: "db.local",
      port: 3306,
      database: "pharma_db",
      username: "app",
      password: "secret"
    });
    const result = parseServerMessageEnvelope(payload);

    expect(result).toMatchObject({
      classification: "extension",
      envelope: {
        type: CONNECTOR_SETUP_CONFIG_COMMAND_TYPE,
        id: "setup-1"
      }
    });
    expect(isDocumentedExtensionMessageType(CONNECTOR_SETUP_CONFIG_COMMAND_TYPE)).toBe(true);
  });

  it("dispatches connector.setup.config through the extension route table", () => {
    const payload = JSON.stringify({
      id: "setup-2",
      type: CONNECTOR_SETUP_CONFIG_COMMAND_TYPE,
      setupMethod: "file_discovery",
      driver: "firebird",
      path: "/data/store.fdb"
    });
    const envelope = parseServerMessageEnvelope(payload);

    if (envelope.classification !== "extension") {
      throw new Error("expected extension classification");
    }

    expect(dispatchExtensionMessage(envelope.envelope, payload)).toEqual({
      kind: "setupConfigRequest",
      request: expect.objectContaining({
        correlationId: "setup-2",
        setupMethod: "file_discovery",
        driver: "firebird",
        path: "/data/store.fdb"
      })
    });
  });

  it("dispatches file-discovery.scan through the extension route table", () => {
    const payload = JSON.stringify({
      id: "fd-1",
      type: FILE_DISCOVERY_SCAN_COMMAND_TYPE,
      rootPath: "/tmp/scan-root"
    });
    const envelope = parseServerMessageEnvelope(payload);

    if (envelope.classification !== "extension") {
      throw new Error("expected extension classification");
    }

    expect(dispatchExtensionMessage(envelope.envelope, payload)).toEqual({
      kind: "fileDiscoveryScanRequest",
      correlationId: "fd-1",
      rootPath: "/tmp/scan-root"
    });
  });

  it("dispatches file-discovery.scan without rootPath correlation id only", () => {
    const payload = JSON.stringify({
      id: "fd-2",
      type: FILE_DISCOVERY_SCAN_COMMAND_TYPE
    });
    const envelope = parseServerMessageEnvelope(payload);

    if (envelope.classification !== "extension") {
      throw new Error("expected extension classification");
    }

    expect(dispatchExtensionMessage(envelope.envelope, payload)).toEqual({
      kind: "fileDiscoveryScanRequest",
      correlationId: "fd-2"
    });
  });

  it("rejects file-discovery.scan rootPath exceeding maximum length", () => {
    const payload = JSON.stringify({
      id: "fd-3",
      type: FILE_DISCOVERY_SCAN_COMMAND_TYPE,
      rootPath: "x".repeat(4097)
    });
    const envelope = parseServerMessageEnvelope(payload);

    if (envelope.classification !== "extension") {
      throw new Error("expected extension classification");
    }

    const result = dispatchExtensionMessage(envelope.envelope, payload);
    expect(result.kind).toBe("malformed");
  });

  it("routes unsupported typed payloads to the unsupported handler", () => {
    const onUnsupported = vi.fn();
    const payload = JSON.stringify({ type: "future.command", id: "cmd-1" });

    dispatchServerMessage(payload, {
      onMalformed: vi.fn(),
      onCore: vi.fn(),
      onExtension: vi.fn(),
      onUnsupported
    });

    expect(onUnsupported).toHaveBeenCalledOnce();
    expect(onUnsupported.mock.calls[0]?.[0]).toMatchObject({
      type: "future.command",
      id: "cmd-1"
    });
  });
});
