import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/logging/logger.js";
import { buildProductBatch } from "../../src/poller/batch-builder.js";
import {
  buildAdminSuccessResponseMessage,
  CONFIG_VALIDATION_FAILED_ERROR_CODE,
  UNSUPPORTED_SERVER_COMMAND_ERROR_CODE
} from "../../src/transport/protocol.js";
import {
  CONNECTOR_SETUP_CONFIG_COMMAND_TYPE,
  CONNECTOR_SETUP_CONFIG_RESULT_TYPE,
  SETUP_CONFIG_VALIDATION_FAILED_ERROR_CODE
} from "../../src/transport/connector-setup-ws.js";
import { CATALOG_MAPPING_PREVIEW_RESULT_TYPE } from "../../src/transport/mapping-preview.js";
import type { RawData } from "ws";
import { WebSocketTransportClient, type WebSocketLike } from "../../src/transport/ws-client.js";
import { validMapping } from "../helpers/mapping.js";
import { MockWebSocketServer, waitFor } from "../support/mock-ws-server.js";

describe("WebSocketTransportClient", () => {
  let server: MockWebSocketServer;
  let client: WebSocketTransportClient | undefined;
  let logs: string[];

  beforeEach(async () => {
    logs = [];
    server = new MockWebSocketServer();
    await server.ready;
  });

  afterEach(async () => {
    await client?.close();
    await server.close();
  });

  it("authenticates during connection setup without logging the connector token", async () => {
    client = createClient("connector-token-secret");

    await client.connect();
    await server.waitForConnectionCount(1);

    expect(server.lastAuthorization).toBe("Bearer connector-token-secret");
    expect(logs.join("\n")).not.toContain("connector-token-secret");
  });

  it("sends connector.error for malformed connector.config with invalid mapping.cursorType", async () => {
    client = createClient("connector-token-secret");
    let configCount = 0;
    client.on("config", () => {
      configCount += 1;
    });

    await client.connect();
    server.sendJson({
      type: "connector.config",
      connectorId: "connector-1",
      customerId: "customer-1",
      connectorToken: "connector-token-secret",
      databasePassword: "database-password-secret",
      mapping: validMapping({ cursorType: "uuid" as "timestamp" })
    });

    const message = await server.nextMessage();

    expect(message.parsed).toMatchObject({
      type: "connector.error",
      error: {
        errorCode: CONFIG_VALIDATION_FAILED_ERROR_CODE,
        message: 'mapping.cursorType must be "timestamp" or "number", got "uuid"',
        connectorId: "connector-1",
        customerId: "customer-1",
        mappingVersion: "mapping-v1"
      }
    });
    expect(configCount).toBe(0);
    expect(message.raw).not.toContain("connector-token-secret");
    expect(message.raw).not.toContain("database-password-secret");
  });

  it("sends connector.error for malformed connector.config missing mapping.fields.sourceProductCode", async () => {
    const mapping = validMapping();
    delete (mapping.fields as Record<string, unknown>).sourceProductCode;
    client = createClient("connector-token-secret");
    let configCount = 0;
    client.on("config", () => {
      configCount += 1;
    });

    await client.connect();
    server.sendJson({
      type: "connector.config",
      connectorId: "connector-1",
      customerId: "customer-1",
      mapping
    });

    const message = await server.nextMessage();

    expect(message.parsed).toMatchObject({
      type: "connector.error",
      error: {
        errorCode: CONFIG_VALIDATION_FAILED_ERROR_CODE,
        message: "mapping.fields.sourceProductCode must be a non-empty string",
        connectorId: "connector-1",
        customerId: "customer-1",
        mappingVersion: "mapping-v1"
      }
    });
    expect(configCount).toBe(0);
    expect(message.raw).not.toContain("connector-token-secret");
  });

  it("sends connector.error for malformed connector.config missing mapping.incrementalQuery", async () => {
    const mapping = validMapping();
    delete (mapping as Record<string, unknown>).incrementalQuery;
    client = createClient("connector-token-secret");
    let configCount = 0;
    client.on("config", () => {
      configCount += 1;
    });

    await client.connect();
    server.sendJson({
      type: "connector.config",
      connectorId: "connector-1",
      customerId: "customer-1",
      connectorToken: "connector-token-secret",
      databasePassword: "database-password-secret",
      mapping
    });

    const message = await server.nextMessage();

    expect(message.parsed).toMatchObject({
      type: "connector.error",
      error: {
        errorCode: CONFIG_VALIDATION_FAILED_ERROR_CODE,
        message: "mapping.incrementalQuery must be a non-empty string",
        connectorId: "connector-1",
        customerId: "customer-1",
        mappingVersion: "mapping-v1"
      }
    });
    expect(configCount).toBe(0);
    expect(message.raw).not.toContain("connector-token-secret");
    expect(message.raw).not.toContain("database-password-secret");
    expect(logs.join("\n")).toContain("CONFIG_VALIDATION_FAILED");
    expect(logs.join("\n")).not.toContain("PROTOCOL_PARSE_ERROR");
  });

  it("emits connector.config messages to the runtime boundary", async () => {
    client = createClient();
    const configReceived = onceClientEvent(client, "config");

    await client.connect();
    server.sendJson({
      type: "connector.config",
      connectorId: "connector-1",
      customerId: "customer-1",
      mapping: validMapping()
    });

    await expect(configReceived).resolves.toMatchObject({
      type: "connector.config",
      connectorId: "connector-1",
      customerId: "customer-1",
      mapping: {
        mappingVersion: "mapping-v1"
      }
    });
  });

  it("emits setupConfigRequest for connector.setup.config commands", async () => {
    client = createClient();
    const received = onceClientEvent(client, "setupConfigRequest");

    await client.connect();
    server.sendJson({
      id: "setup-1",
      type: CONNECTOR_SETUP_CONFIG_COMMAND_TYPE,
      setupMethod: "manual",
      driver: "mysql",
      host: "db.local",
      port: 3306,
      database: "pharma_db",
      username: "app",
      password: "database-password-secret"
    });

    await expect(received).resolves.toMatchObject({
      correlationId: "setup-1",
      setupMethod: "manual",
      driver: "mysql",
      host: "db.local"
    });
    expect(logs.join("\n")).not.toContain("PROTOCOL_PARSE_ERROR");
    expect(logs.join("\n")).not.toContain("database-password-secret");
  });

  it("sends setup failure result for malformed connector.setup.config without logging secrets", async () => {
    client = createClient("connector-token-secret");
    let setupCount = 0;
    client.on("setupConfigRequest", () => {
      setupCount += 1;
    });

    await client.connect();
    server.sendJson({
      id: "setup-bad",
      type: CONNECTOR_SETUP_CONFIG_COMMAND_TYPE,
      setupMethod: "manual",
      connectorToken: "connector-token-secret",
      databasePassword: "database-password-secret",
      host: "db.local",
      port: 3306,
      database: "pharma_db",
      username: "app",
      password: "database-password-secret"
    });

    const message = await server.nextMessage();

    expect(message.parsed).toMatchObject({
      type: CONNECTOR_SETUP_CONFIG_RESULT_TYPE,
      id: "setup-bad",
      ok: false,
      errorCode: SETUP_CONFIG_VALIDATION_FAILED_ERROR_CODE
    });
    expect(setupCount).toBe(0);
    expect(message.raw).not.toContain("connector-token-secret");
    expect(message.raw).not.toContain("database-password-secret");
    expect(logs.join("\n")).not.toContain("database-password-secret");
    expect(logs.join("\n")).not.toContain("PROTOCOL_PARSE_ERROR");
  });

  it("emits fileDiscoveryScanRequest for file-discovery.scan commands", async () => {
    client = createClient();
    const received = onceClientEvent(client, "fileDiscoveryScanRequest");

    await client.connect();
    server.sendJson({
      id: "scan-1",
      type: "file-discovery.scan",
      rootPath: "/custom/root"
    });

    await expect(received).resolves.toEqual({
      correlationId: "scan-1",
      rootPath: "/custom/root"
    });
  });

  it("emits schemaDiscoveryRequest for schema.tables.list commands", async () => {
    client = createClient();
    const schemaDiscoveryReceived = onceClientEvent(client, "schemaDiscoveryRequest");

    await client.connect();
    server.sendJson({
      id: "cmd-1",
      type: "schema.tables.list"
    });

    await expect(schemaDiscoveryReceived).resolves.toEqual({
      responseFormat: "legacy",
      correlationId: "cmd-1"
    });
    expect(logs.join("\n")).not.toContain("PROTOCOL_PARSE_ERROR");
  });

  it("logs malformed schema.tables.list without id and does not emit schemaDiscoveryRequest", async () => {
    client = createClient();
    let schemaDiscoveryCount = 0;
    client.on("schemaDiscoveryRequest", () => {
      schemaDiscoveryCount += 1;
    });

    await client.connect();
    server.sendJson({
      type: "schema.tables.list"
    });
    await waitFor(() => logs.join("\n").includes("PROTOCOL_PARSE_ERROR"));

    expect(schemaDiscoveryCount).toBe(0);
    expect(client.isConnected()).toBe(true);
  });

  it("sends correlated catalog.mapping.preview stub result without protocol parse errors", async () => {
    client = createClient();
    await client.connect();

    const startedAt = Date.now();
    server.sendJson({
      id: "prev-1",
      type: "catalog.mapping.preview",
      mapping: validMapping(),
      maxSampleSize: 5
    });

    const message = await server.nextMessage();
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1_000);
    expect(message.parsed).toEqual({
      id: "prev-1",
      type: CATALOG_MAPPING_PREVIEW_RESULT_TYPE,
      samples: [],
      summary: {
        matchedCount: 0,
        sampleCount: 0,
        invalidCount: 0
      }
    });
    expect(logs.join("\n")).toContain("preview.not_implemented");
    expect(logs.join("\n")).not.toContain("PROTOCOL_PARSE_ERROR");
  });

  it("logs unsupported_server_message and sends connector.error rejection for future platform types with id", async () => {
    client = createClient();
    await client.connect();

    const startedAt = Date.now();
    server.sendJson({
      id: "f-1",
      type: "platform.future.feature"
    });

    const message = await server.nextMessage();
    const elapsedMs = Date.now() - startedAt;
    const logOutput = logs.join("\n");

    expect(elapsedMs).toBeLessThan(1_000);
    expect(message.parsed).toMatchObject({
      id: "f-1",
      type: "connector.error",
      error: {
        errorCode: UNSUPPORTED_SERVER_COMMAND_ERROR_CODE,
        message: "Unsupported server message type: platform.future.feature"
      }
    });
    expect(logOutput).toContain("unsupported_server_message");
    expect(logOutput).not.toContain("PROTOCOL_PARSE_ERROR");
  });

  it("logs unsupported_server_message without sending a correlated response when id is absent", async () => {
    client = createClient();
    await client.connect();

    server.sendJson({
      type: "catalog.future.command"
    });
    await waitFor(() => logs.join("\n").includes("unsupported_server_message"));

    const outbound = await Promise.race([
      server.nextMessage().then(() => "message"),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 200))
    ]);

    expect(outbound).toBe("timeout");
    expect(logs.join("\n")).not.toContain("PROTOCOL_PARSE_ERROR");
    expect(client.isConnected()).toBe(true);
  });

  it("logs PROTOCOL_PARSE_ERROR for malformed JSON payloads", async () => {
    client = createClient();
    await client.connect();

    server.sendRaw("{ not json");
    await waitFor(() => logs.join("\n").includes("PROTOCOL_PARSE_ERROR"));

    expect(logs.join("\n")).not.toContain("unsupported_server_message");
    expect(client.isConnected()).toBe(true);
  });

  it("logs malformed catalog.mapping.preview without id and does not send a stub result", async () => {
    client = createClient();
    await client.connect();

    server.sendJson({
      type: "catalog.mapping.preview",
      mapping: validMapping(),
      maxSampleSize: 5
    });
    await waitFor(() => logs.join("\n").includes("PROTOCOL_PARSE_ERROR"));

    expect(client.isConnected()).toBe(true);
    expect(logs.join("\n")).not.toContain("preview.not_implemented");
  });

  it("sends serialized schema.tables.list.result payloads", async () => {
    client = createClient();
    await client.connect();

    client.sendSchemaTablesListResult({
      correlationId: "cmd-1",
      tables: [
        {
          name: "products",
          columns: [{ name: "id", type: "int", nullable: false }]
        }
      ]
    });

    const message = await server.nextMessage();
    expect(message.parsed).toMatchObject({
      id: "cmd-1",
      type: "schema.tables.list.result",
      tables: [
        {
          name: "products",
          columns: [{ name: "id", type: "int", nullable: false }]
        }
      ]
    });
  });

  it("emits admin.request messages as a distinct runtime event", async () => {
    client = createClient();
    const adminRequestReceived = onceClientEvent(client, "adminRequest");

    await client.connect();
    server.sendJson({
      type: "admin.request",
      requestId: "req-1",
      command: "schema.listTables"
    });

    await expect(adminRequestReceived).resolves.toEqual({
      type: "admin.request",
      requestId: "req-1",
      command: "schema.listTables",
      sentAt: undefined
    });
  });

  it("logs and ignores malformed admin.request messages", async () => {
    client = createClient();
    let adminRequestCount = 0;
    client.on("adminRequest", () => {
      adminRequestCount += 1;
    });

    await client.connect();
    server.sendJson({
      type: "admin.request",
      requestId: "",
      command: "schema.listTables"
    });
    await waitFor(() => logs.join("\n").includes("PROTOCOL_PARSE_ERROR"));

    expect(adminRequestCount).toBe(0);
    expect(client.isConnected()).toBe(true);
  });

  it("logs and ignores unsupported admin commands", async () => {
    client = createClient();
    let adminRequestCount = 0;
    client.on("adminRequest", () => {
      adminRequestCount += 1;
    });

    await client.connect();
    server.sendJson({
      type: "admin.request",
      requestId: "req-1",
      command: "schema.describeTable"
    });
    await waitFor(() => logs.join("\n").includes("Unsupported admin command"));

    expect(adminRequestCount).toBe(0);
    expect(client.isConnected()).toBe(true);
  });

  it("sends heartbeat messages containing version and last successful send metadata", async () => {
    client = createClient();
    await client.connect();

    client.sendHeartbeat({
      connectorVersion: "0.1.0-test",
      mappingVersion: "mapping-v1",
      lastSuccessfulSendAt: "2026-05-16T20:00:00.000Z",
      sentAt: "2026-05-16T20:00:01.000Z"
    });

    await expect(server.nextMessage()).resolves.toMatchObject({
      parsed: {
        type: "connector.heartbeat",
        sentAt: "2026-05-16T20:00:01.000Z",
        payload: {
          connectorVersion: "0.1.0-test",
          online: true,
          mappingVersion: "mapping-v1",
          lastSuccessfulSendAt: "2026-05-16T20:00:00.000Z",
          reconnectAttemptCount: 0
        }
      }
    });
  });

  it("sends product batches and surfaces matching continue acknowledgements", async () => {
    client = createClient();
    const ackReceived = onceClientEvent(client, "batchAck");
    await client.connect();

    client.sendBatch(fixtureBatch(), "2026-05-16T20:00:01.000Z");
    const batchMessage = await server.nextMessage();
    server.sendJson({
      type: "batch.ack",
      batchId: "batch-1",
      accepted: true,
      acceptedRecordCount: 1,
      rejectedRecordCount: 0,
      nextAction: "continue"
    });

    expect(batchMessage.parsed).toMatchObject({
      type: "product.batch",
      batchId: "batch-1",
      mappingVersion: "mapping-v1",
      cursor: {
        before: "100",
        after: "101"
      },
      products: [
        {
          code: "P-001",
          name: "Dipirona 500mg",
          salePrice: 12.5,
          stockQuantity: 7
        }
      ]
    });
    expect(batchMessage.parsed).not.toHaveProperty("batch");
    await expect(ackReceived).resolves.toMatchObject({
      type: "batch.ack",
      batchId: "batch-1",
      accepted: true,
      nextAction: "continue"
    });
  });

  it("surfaces retry acknowledgements without reporting cursor advancement", async () => {
    client = createClient();
    const retryReceived = onceClientEvent(client, "retry");
    await client.connect();

    server.sendJson({
      type: "batch.ack",
      batchId: "batch-1",
      accepted: false,
      acceptedRecordCount: 0,
      rejectedRecordCount: 1,
      nextAction: "retry",
      errorCode: "TRANSIENT_FAILURE"
    });

    const retry = await retryReceived;
    expect(retry).toMatchObject({
      type: "batch.ack",
      batchId: "batch-1",
      nextAction: "retry"
    });
    expect(JSON.stringify(retry)).not.toContain("lastAckedCursor");
    expect(JSON.stringify(retry)).not.toContain("cursorAfter");
  });

  it("surfaces config.updated so runtime can reload mapping", async () => {
    client = createClient();
    const reloadReceived = onceClientEvent(client, "reloadConfig");
    await client.connect();

    server.sendJson({
      type: "config.updated",
      mappingVersion: "mapping-v2",
      reason: "panel_update"
    });

    await expect(reloadReceived).resolves.toMatchObject({
      type: "config.updated",
      mappingVersion: "mapping-v2",
      reason: "panel_update"
    });
  });

  it("reconnects after server disconnect and resets reconnect attempt count after recovery", async () => {
    client = createClient("connector-token-secret", { baseDelayMs: 10, maxDelayMs: 20, jitterRatio: 0, random: () => 0.5 });

    await client.connect();
    server.disconnectClients();
    await server.waitForConnectionCount(2);

    expect(client.getReconnectAttemptCount()).toBe(0);

    client.sendHeartbeat({
      connectorVersion: "0.1.0-test",
      sentAt: "2026-05-16T20:00:02.000Z"
    });
    const heartbeat = await server.nextMessage();

    expect(heartbeat.parsed).toMatchObject({
      type: "connector.heartbeat",
      payload: {
        reconnectAttemptCount: 0
      }
    });
  });

  it("keeps the process alive by scheduling reconnect when the initial handshake closes", async () => {
    const socket = new EarlyCloseWebSocket();
    let connectionAttempts = 0;
    client = new WebSocketTransportClient({
      url: "ws://mock.connector.test/forbidden",
      connectorToken: "connector-token-secret",
      retryPolicy: { baseDelayMs: 10_000, maxDelayMs: 10_000, jitterRatio: 0, random: () => 0.5 },
      socketFactory: () => {
        connectionAttempts += 1;
        queueMicrotask(() => socket.serverClose(1008, "forbidden"));
        return socket;
      },
      logger: createLogger({
        level: "debug",
        secrets: ["connector-token-secret"],
        nodeEnv: "dev",
        output: {
          log: (message) => logs.push(String(message)),
          error: (message) => logs.push(String(message))
        }
      })
    });

    await expect(client.connect()).resolves.toBeUndefined();

    expect(connectionAttempts).toBe(1);
    expect(client.getReconnectAttemptCount()).toBe(1);
    expect(logs.join("\n")).toContain("websocket reconnect scheduled");
    expect(logs.join("\n")).not.toContain("connector-token-secret");
  });

  it("sends connector.error messages without secret metadata", async () => {
    client = createClient();
    await client.connect();

    client.sendConnectorError(
      {
        errorCode: "DB_TIMEOUT",
        message: "Database timeout",
        connectorId: "connector-1",
        customerId: "customer-1",
        mappingVersion: "mapping-v1",
        connectorToken: "connector-token-secret",
        databasePassword: "database-password-secret"
      } as never,
      "2026-05-16T20:00:03.000Z"
    );

    const message = await server.nextMessage();

    expect(message.parsed).toMatchObject({
      type: "connector.error",
      error: {
        errorCode: "DB_TIMEOUT",
        message: "Database timeout",
        connectorId: "connector-1",
        customerId: "customer-1",
        mappingVersion: "mapping-v1"
      }
    });
    expect(message.raw).not.toContain("connector-token-secret");
    expect(message.raw).not.toContain("database-password-secret");
  });

  it("sends serialized admin.response messages", async () => {
    client = createClient();
    await client.connect();

    client.sendAdminResponse(
      buildAdminSuccessResponseMessage(
        {
          requestId: "req-1",
          command: "schema.listTables",
          payload: { tables: ["products"] }
        },
        "2026-05-16T20:00:04.000Z"
      )
    );

    await expect(server.nextMessage()).resolves.toMatchObject({
      parsed: {
        type: "admin.response",
        requestId: "req-1",
        command: "schema.listTables",
        ok: true,
        payload: {
          tables: ["products"]
        },
        sentAt: "2026-05-16T20:00:04.000Z"
      }
    });
  });

  it("sends connector.discovery messages serialized as JSON", async () => {
    client = createClient();
    await client.connect();

    client.sendConnectorDiscovery({
      type: "connector.discovery",
      scannedAt: "2026-05-27T12:00:00.000Z",
      platform: "win32",
      dsns: [{ dsnName: "X", host: "h", port: 5432 }]
    });

    const message = await server.nextMessage();
    expect(message.raw).toBe(
      JSON.stringify({
        type: "connector.discovery",
        scannedAt: "2026-05-27T12:00:00.000Z",
        platform: "win32",
        dsns: [{ dsnName: "X", host: "h", port: 5432 }]
      })
    );
  });

  it("routes an in-memory admin request and returns a correlated admin response", async () => {
    client = createClient();
    client.on("adminRequest", (message) => {
      client?.sendAdminResponse(
        buildAdminSuccessResponseMessage(
          {
            requestId: message.requestId,
            command: message.command,
            payload: { tables: ["products", "inventory"] }
          },
          "2026-05-16T20:00:05.000Z"
        )
      );
    });

    await client.connect();
    server.sendJson({
      type: "admin.request",
      requestId: "req-42",
      command: "schema.listTables"
    });

    await expect(server.nextMessage()).resolves.toMatchObject({
      parsed: {
        type: "admin.response",
        requestId: "req-42",
        command: "schema.listTables",
        ok: true,
        payload: {
          tables: ["products", "inventory"]
        }
      }
    });
  });

  function createClient(
    token = "connector-token",
    retryPolicy = { baseDelayMs: 10, maxDelayMs: 50, jitterRatio: 0, random: () => 0.5 }
  ): WebSocketTransportClient {
    return new WebSocketTransportClient({
      url: server.url,
      connectorToken: token,
      retryPolicy,
      socketFactory: server.createWebSocket,
      logger: createLogger({
        level: "debug",
        secrets: [token],
        nodeEnv: "dev",
        output: {
          log: (message) => logs.push(String(message)),
          error: (message) => logs.push(String(message))
        }
      })
    });
  }
});

class EarlyCloseWebSocket extends EventEmitter implements WebSocketLike {
  public readonly OPEN = 1;
  public readonly CLOSED = 3;
  public readyState = 0;

  public send(): void {
    throw new Error("Socket is not open");
  }

  public close(): void {
    this.serverClose(1000, "client close");
  }

  public ping(): void {
    // no-op stub — ping/pong logic lives in Task 6
  }

  public terminate(): void {
    this.serverClose(1006, "terminated");
  }

  public serverClose(code: number, reason: string): void {
    if (this.readyState === this.CLOSED) {
      return;
    }
    this.readyState = this.CLOSED;
    this.emit("close", code, Buffer.from(reason, "utf8"));
  }
}

function fixtureBatch() {
  return buildProductBatch({
    batchId: "batch-1",
    connectorId: "connector-1",
    customerId: "customer-1",
    mappingVersion: "mapping-v1",
    cursorBefore: "100",
    cursorAfter: "101",
    createdAt: "2026-05-16T20:00:00.000Z",
    records: [
      {
        sourceProductCode: "P-001",
        name: "Dipirona 500mg",
        price: 12.5,
        stock: 7
      }
    ]
  });
}

function onceClientEvent<T>(client: WebSocketTransportClient, event: string): Promise<T> {
  return new Promise((resolve) => {
    client.once(event, (message) => resolve(message as T));
  });
}

function silentLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

describe("zombie socket detection", () => {
  function manualClientTimers() {
    const intervals: Array<{ cb: () => void; ms: number; handle: object }> = [];
    const timeouts: Array<{ cb: () => void; ms: number; handle: object }> = [];
    return {
      intervals,
      timeouts,
      setInterval: (cb: () => void, ms: number) => {
        const handle = {};
        intervals.push({ cb, ms, handle });
        return handle;
      },
      clearInterval: (handle: unknown) => {
        const idx = intervals.findIndex((entry) => entry.handle === handle);
        if (idx >= 0) intervals.splice(idx, 1);
      },
      setTimeout: (cb: () => void, ms: number) => {
        const handle = {};
        timeouts.push({ cb, ms, handle });
        return handle;
      },
      clearTimeout: (handle: unknown) => {
        const idx = timeouts.findIndex((entry) => entry.handle === handle);
        if (idx >= 0) timeouts.splice(idx, 1);
      }
    };
  }

  function createFakeSocketHandles() {
    const listeners = {
      open: [] as Array<() => void>,
      error: [] as Array<(err: Error) => void>,
      close: [] as Array<(code: number, reason: Buffer) => void>,
      message: [] as Array<(data: RawData) => void>,
      pong: [] as Array<(data: Buffer) => void>
    };
    const socket: WebSocketLike = {
      OPEN: 1,
      CLOSED: 3,
      readyState: 0,
      once: vi.fn((event: string, listener: (...args: any[]) => void) => {
        if (event === "open") listeners.open.push(listener as () => void);
        else if (event === "error") listeners.error.push(listener as (e: Error) => void);
        else if (event === "close") listeners.close.push(listener as (c: number, r: Buffer) => void);
        return socket;
      }),
      on: vi.fn((event: string, listener: (...args: any[]) => void) => {
        if (event === "message") listeners.message.push(listener as (d: RawData) => void);
        else if (event === "pong") listeners.pong.push(listener as (d: Buffer) => void);
        return socket;
      }),
      send: vi.fn(),
      close: vi.fn(),
      ping: vi.fn(),
      terminate: vi.fn()
    };
    return {
      socket,
      openSocket: () => {
        socket.readyState = socket.OPEN;
        listeners.open.forEach((l) => l());
      },
      emitClose: (code = 1000, reason = "") => {
        socket.readyState = socket.CLOSED;
        listeners.close.forEach((l) => l(code, Buffer.from(reason)));
      },
      emitPong: () => {
        listeners.pong.forEach((l) => l(Buffer.alloc(0)));
      }
    };
  }

  it("starts pinging at the configured interval after open", async () => {
    const timers = manualClientTimers();
    const { socket, openSocket } = createFakeSocketHandles();
    const client = new WebSocketTransportClient({
      url: "wss://example",
      connectorToken: "pac_test",
      logger: silentLogger(),
      socketFactory: () => socket,
      pingIntervalMs: 5_000,
      pongTimeoutMs: 1_000,
      timers
    });

    void client.connect();
    openSocket();

    expect(timers.intervals).toHaveLength(1);
    expect(timers.intervals[0]!.ms).toBe(5_000);

    timers.intervals[0]!.cb();
    expect(socket.ping).toHaveBeenCalledTimes(1);
  });

  it("terminates the socket when pong does not arrive within timeout", async () => {
    const timers = manualClientTimers();
    const { socket, openSocket } = createFakeSocketHandles();
    const client = new WebSocketTransportClient({
      url: "wss://example",
      connectorToken: "pac_test",
      logger: silentLogger(),
      socketFactory: () => socket,
      pingIntervalMs: 5_000,
      pongTimeoutMs: 1_000,
      timers
    });
    void client.connect();
    openSocket();

    timers.intervals[0]!.cb();
    expect(timers.timeouts).toHaveLength(1);
    expect(timers.timeouts[0]!.ms).toBe(1_000);

    timers.timeouts[0]!.cb();
    expect(socket.terminate).toHaveBeenCalledTimes(1);
  });

  it("clears pong deadline when pong arrives", async () => {
    const timers = manualClientTimers();
    const { socket, openSocket, emitPong } = createFakeSocketHandles();
    const client = new WebSocketTransportClient({
      url: "wss://example",
      connectorToken: "pac_test",
      logger: silentLogger(),
      socketFactory: () => socket,
      pingIntervalMs: 5_000,
      pongTimeoutMs: 1_000,
      timers
    });
    void client.connect();
    openSocket();

    timers.intervals[0]!.cb();
    expect(timers.timeouts).toHaveLength(1);

    emitPong();
    expect(timers.timeouts).toHaveLength(0);
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  it("stops pinging on close", async () => {
    const timers = manualClientTimers();
    const { socket, openSocket, emitClose } = createFakeSocketHandles();
    const client = new WebSocketTransportClient({
      url: "wss://example",
      connectorToken: "pac_test",
      logger: silentLogger(),
      socketFactory: () => socket,
      pingIntervalMs: 5_000,
      pongTimeoutMs: 1_000,
      timers
    });
    void client.connect();
    openSocket();

    emitClose();
    expect(timers.intervals).toHaveLength(0);
  });
});
