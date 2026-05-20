import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/logging/logger.js";
import type { SourceDatabaseAdapter } from "../../src/db/source-adapter.js";
import { ConnectorRuntime } from "../../src/service/runtime.js";
import { StateStore } from "../../src/state/state-store.js";
import { WebSocketTransportClient } from "../../src/transport/ws-client.js";
import { validEnv } from "../helpers/env.js";
import { validMapping } from "../helpers/mapping.js";
import { MockWebSocketServer, waitFor } from "../support/mock-ws-server.js";

describe("connector runtime flow", () => {
  let server: MockWebSocketServer;
  let runtime: ConnectorRuntime | undefined;
  let stateFilePath: string;

  beforeEach(async () => {
    server = new MockWebSocketServer();
    await server.ready;
    const dir = await mkdtemp(join(tmpdir(), "connector-flow-"));
    stateFilePath = join(dir, "state.json");
  });

  afterEach(async () => {
    await runtime?.shutdown();
    await server.close();
  });

  it("sends one product batch from mock database and accepted ack advances cursor", async () => {
    runtime = createRuntime({
      adapter: adapterWithRows([
        {
          product_id: "P-001",
          description: "Dipirona 500mg",
          sale_price: "12.50",
          quantity: "7",
          updated_at: "2026-05-16T20:00:01.000Z"
        },
        {
          product_id: "P-002",
          description: "Paracetamol 750mg",
          sale_price: "8.90",
          quantity: "4",
          updated_at: "2026-05-16T20:00:02.000Z"
        }
      ])
    });

    await runtime.start();
    server.sendJson(configMessage());

    const batchMessage = await nextProductBatch(server);
    expect(batchMessage.parsed).toMatchObject({
      type: "product.batch",
      batch: {
        connectorId: "connector-1",
        customerId: "customer-1",
        mappingVersion: "mapping-v1",
        cursorBefore: "1970-01-01T00:00:00.000Z",
        cursorAfter: "2026-05-16T20:00:02.000Z"
      }
    });
    expect((batchMessage.parsed.batch as { records: unknown[] }).records).toHaveLength(2);

    server.sendJson({
      type: "batch.ack",
      batchId: (batchMessage.parsed.batch as { batchId: string }).batchId,
      accepted: true,
      acceptedRecordCount: 2,
      rejectedRecordCount: 0,
      nextAction: "continue"
    });

    await waitUntilState(stateFilePath, (state) => state.lastAckedCursor === "2026-05-16T20:00:02.000Z");
    const state = JSON.parse(await readFile(stateFilePath, "utf8")) as Record<string, unknown>;
    expect(state.lastSuccessfulSendAt).toBe("2026-05-16T20:00:01.000Z");
  });

  it("runtime restart reloads saved state and resumes from last acknowledged cursor", async () => {
    const firstAdapter = adapterWithRows([
      {
        product_id: "P-001",
        description: "Dipirona 500mg",
        sale_price: "12.50",
        quantity: "7",
        updated_at: "2026-05-16T20:00:01.000Z"
      }
    ]);
    runtime = createRuntime({ adapter: firstAdapter });
    await runtime.start();
    server.sendJson(configMessage());
    const firstBatch = await nextProductBatch(server);
    server.sendJson({
      type: "batch.ack",
      batchId: (firstBatch.parsed.batch as { batchId: string }).batchId,
      accepted: true,
      acceptedRecordCount: 1,
      rejectedRecordCount: 0,
      nextAction: "continue"
    });
    await waitUntilState(stateFilePath, (state) => state.lastAckedCursor === "2026-05-16T20:00:01.000Z");
    await runtime.shutdown();

    await server.close();
    server = new MockWebSocketServer();
    await server.ready;
    const secondAdapter = adapterWithRows([]);
    runtime = createRuntime({ adapter: secondAdapter });

    await runtime.start();
    server.sendJson(configMessage());
    await waitFor(() => vi.mocked(secondAdapter.queryChanges).mock.calls.length > 0);

    expect(secondAdapter.queryChanges).toHaveBeenCalledWith({
      sql: "select * from products where updated_at > ? order by updated_at",
      cursor: "2026-05-16T20:00:01.000Z",
      limit: 500
    });
  });

  it("responds to a mock panel schema.listTables admin request with the correlated table list", async () => {
    runtime = createRuntime({
      adapter: adapterWithRows([], [{ name: "z_products" }, { name: "a_products" }])
    });

    await runtime.start();
    server.sendJson({
      type: "admin.request",
      requestId: "request-123",
      command: "schema.listTables"
    });

    const response = await nextAdminResponse(server);
    expect(response.parsed).toMatchObject({
      type: "admin.response",
      requestId: "request-123",
      command: "schema.listTables",
      ok: true,
      payload: { tables: ["a_products", "z_products"] }
    });
  });

  it("mock central disconnect triggers reconnect without creating an inbound connector endpoint", async () => {
    runtime = createRuntime({
      transport: new WebSocketTransportClient({
        url: server.url,
        connectorToken: "test-connector-token",
        retryPolicy: { baseDelayMs: 10, maxDelayMs: 10, jitterRatio: 0, random: () => 0.5 },
        socketFactory: server.createWebSocket,
        logger: createLogger({ level: "error", secrets: ["test-connector-token"] })
      }),
      adapter: adapterWithRows([])
    });

    await runtime.start();
    await server.waitForConnectionCount(1);
    server.disconnectClients();
    await server.waitForConnectionCount(2);

    expect(server.connections).toBe(2);
    expect(runtime.getState().config.websocketUrl).toBe(server.url);
  });

  it("manual system test documentation covers lifecycle, logs, no inbound ports, and panel heartbeat checks", async () => {
    const doc = await readFile(join(process.cwd(), "docs", "manual-system-tests.md"), "utf8");

    for (const text of [
      "install-service.ps1",
      "Start-Service",
      "Stop-Service",
      "restart-service.ps1",
      "uninstall-service.ps1",
      "%PROGRAMDATA%\\PharmaAgentConnector",
      "No Inbound Port",
      "heartbeat",
      "online"
    ]) {
      expect(doc).toContain(text);
    }
  });

  function createRuntime(options: {
    adapter: SourceDatabaseAdapter;
    transport?: WebSocketTransportClient;
  }): ConnectorRuntime {
    return new ConnectorRuntime({
      env: validEnv({ CONNECTOR_WS_URL: server.url }),
      logger: createLogger({ level: "error", secrets: ["test-connector-token", "test-db-password"] }),
      stateStore: new StateStore({ stateFilePath }),
      adapter: options.adapter,
      transport:
        options.transport ??
        new WebSocketTransportClient({
          url: server.url,
          connectorToken: "test-connector-token",
          socketFactory: server.createWebSocket,
          logger: createLogger({ level: "error", secrets: ["test-connector-token", "test-db-password"] })
        }),
      now: sequenceNow(["2026-05-16T20:00:00.000Z", "2026-05-16T20:00:01.000Z"])
    });
  }
});

function adapterWithRows(
  rows: Record<string, unknown>[],
  tables: Array<{ name: string }> = [{ name: "products" }]
): SourceDatabaseAdapter {
  return {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    queryChanges: vi.fn(async () => rows),
    listTables: vi.fn(async () => tables),
    listColumns: vi.fn(async () => [])
  };
}

function configMessage(mapping = validMapping()): Record<string, unknown> {
  return {
    type: "connector.config",
    connectorId: "connector-1",
    customerId: "customer-1",
    mapping
  };
}

async function nextProductBatch(server: MockWebSocketServer) {
  while (true) {
    const message = await server.nextMessage();
    if (message.parsed.type === "product.batch") {
      return message;
    }
  }
}

async function nextAdminResponse(server: MockWebSocketServer) {
  while (true) {
    const message = await server.nextMessage();
    if (message.parsed.type === "admin.response") {
      return message;
    }
  }
}

async function waitUntilState(
  path: string,
  predicate: (state: Record<string, unknown>) => boolean,
  timeoutMs = 1_000
): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    try {
      const state = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      if (predicate(state)) {
        return;
      }
    } catch {
      // The state file may not exist yet.
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for connector state");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function sequenceNow(values: string[]): () => string {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}
