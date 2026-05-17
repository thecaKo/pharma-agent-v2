import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../../src/logging/logger.js";
import { buildProductBatch } from "../../src/poller/batch-builder.js";
import { WebSocketTransportClient } from "../../src/transport/ws-client.js";
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
      batch: {
        batchId: "batch-1",
        cursorAfter: "101"
      }
    });
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
        output: {
          log: (message) => logs.push(String(message)),
          error: (message) => logs.push(String(message))
        }
      })
    });
  }
});

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
