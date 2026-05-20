import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/logging/logger.js";
import type { SourceDatabaseAdapter } from "../../src/db/source-adapter.js";
import { ConnectorRuntime } from "../../src/service/runtime.js";
import { StateStore } from "../../src/state/state-store.js";
import { WebSocketTransportClient } from "../../src/transport/ws-client.js";
import * as adapterFactory from "../../src/db/adapter-factory.js";
import {
  CONNECTOR_SETUP_CONFIG_COMMAND_TYPE,
  CONNECTOR_SETUP_CONFIG_RESULT_TYPE
} from "../../src/transport/connector-setup-ws.js";
import {
  FILE_DISCOVERY_SCAN_COMMAND_TYPE,
  FILE_DISCOVERY_SCAN_RESULT_TYPE,
  type FileDiscoveryScanResultMessage
} from "../../src/transport/file-discovery-ws.js";
import { CATALOG_MAPPING_PREVIEW_RESULT_TYPE } from "../../src/transport/mapping-preview.js";
import { CONFIG_VALIDATION_FAILED_ERROR_CODE } from "../../src/transport/protocol.js";
import { validEnv } from "../helpers/env.js";
import { neoApiCatalogConfigPush } from "../helpers/catalog-config-push.js";
import { productionConnectorConfig, validMapping } from "../helpers/mapping.js";
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

  it.each([
    {
      case: "missing mapping.incrementalQuery",
      buildMapping: () => {
        const mapping = validMapping();
        delete (mapping as Record<string, unknown>).incrementalQuery;
        return mapping;
      },
      expectedMessage: "mapping.incrementalQuery must be a non-empty string"
    },
    {
      case: "missing mapping.fields.sourceProductCode",
      buildMapping: () => {
        const mapping = validMapping();
        delete (mapping.fields as Record<string, unknown>).sourceProductCode;
        return mapping;
      },
      expectedMessage: "mapping.fields.sourceProductCode must be a non-empty string"
    },
    {
      case: "invalid mapping.cursorType",
      buildMapping: () => validMapping({ cursorType: "uuid" as "timestamp" }),
      expectedMessage: 'mapping.cursorType must be "timestamp" or "number", got "uuid"'
    }
  ])(
    "rejects invalid connector.config ($case) with connector.error and no activation",
    async ({ buildMapping, expectedMessage }) => {
      const adapter = adapterWithRows([]);
      runtime = createRuntime({ adapter });
      await runtime.start();

      server.sendJson({
        type: "connector.config",
        connectorId: "connector-1",
        customerId: "customer-1",
        connectorToken: "test-connector-token",
        databasePassword: "test-db-password",
        mapping: buildMapping()
      });

      const errorMessage = await nextConnectorError(server);
      expect(errorMessage.parsed).toMatchObject({
        type: "connector.error",
        error: {
          errorCode: CONFIG_VALIDATION_FAILED_ERROR_CODE,
          message: expectedMessage,
          connectorId: "connector-1",
          customerId: "customer-1",
          mappingVersion: "mapping-v1"
        }
      });
      expect(errorMessage.raw).not.toContain("test-connector-token");
      expect(errorMessage.raw).not.toContain("test-db-password");
      expect(runtime.getState().activeMapping).toBeUndefined();
      expect(runtime.getState().pollingPaused).toBe(true);
      expect(adapter.queryChanges).not.toHaveBeenCalled();

      const productBatch = await Promise.race([
        nextProductBatch(server).then(() => "batch"),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 200))
      ]);
      expect(productBatch).toBe("timeout");
    }
  );

  it("activates after a prior invalid connector.config push when a valid config arrives", async () => {
    const adapter = adapterWithRows([
      {
        product_id: "P-001",
        description: "Dipirona 500mg",
        sale_price: "12.50",
        quantity: "7",
        updated_at: "2026-05-16T20:00:01.000Z"
      }
    ]);
    runtime = createRuntime({ adapter });
    await runtime.start();

    const invalidMapping = validMapping();
    delete (invalidMapping as Record<string, unknown>).incrementalQuery;
    server.sendJson({
      type: "connector.config",
      connectorId: "connector-1",
      customerId: "customer-1",
      mapping: invalidMapping
    });
    await nextConnectorError(server);
    expect(runtime.getState().activeMapping).toBeUndefined();

    server.sendJson(configMessage());
    await nextProductBatch(server);

    expect(runtime.getState().activeMapping?.mappingVersion).toBe("mapping-v1");
    expect(adapter.queryChanges).toHaveBeenCalled();
  });

  it("applies manual setup config, acknowledges success, and uses reloaded adapter for schema discovery", async () => {
    const initialAdapter = adapterWithSchema([], [{ name: "legacy_products" }]);
    const reloadedAdapter = adapterWithSchema(
      [],
      [{ name: "panel_products" }],
      [{ name: "product_id", dataType: "varchar" }]
    );
    const createAdapterSpy = vi
      .spyOn(adapterFactory, "createSourceDatabaseAdapter")
      .mockReturnValue(reloadedAdapter);

    runtime = createRuntime({ adapter: initialAdapter });
    await runtime.start();

    server.sendJson({
      id: "setup-flow-1",
      type: CONNECTOR_SETUP_CONFIG_COMMAND_TYPE,
      setupMethod: "manual",
      driver: "mysql",
      host: "db.local",
      port: 3306,
      database: "pharma_db",
      username: "app",
      password: "test-db-password"
    });

    const setupResult = await nextSetupConfigResult(server);
    expect(setupResult.parsed).toMatchObject({
      type: CONNECTOR_SETUP_CONFIG_RESULT_TYPE,
      id: "setup-flow-1",
      ok: true,
      setupMethod: "manual",
      driver: "mysql"
    });
    expect(setupResult.raw).not.toContain("test-db-password");
    expect(initialAdapter.close).toHaveBeenCalledOnce();
    expect(reloadedAdapter.connect).toHaveBeenCalledOnce();

    server.sendJson({
      id: "schema-after-setup",
      type: "schema.tables.list"
    });

    const schemaResult = await nextSchemaTablesListResult(server);
    expect(schemaResult.parsed.tables).toEqual([
      expect.objectContaining({ name: "panel_products" })
    ]);
    expect(reloadedAdapter.listTables).toHaveBeenCalled();
    expect(initialAdapter.listTables).not.toHaveBeenCalled();

    createAdapterSpy.mockRestore();
  });

  it("activates neo-api catalog connector.config push and starts polling", async () => {
    const logLines: string[] = [];
    const adapter = adapterWithRows([
      {
        sku: "SKU-1",
        title: "Produto 1",
        sale_price: "10.00",
        qty: "5",
        updated_at: "2026-05-16T20:00:01.000Z"
      }
    ]);
    runtime = createRuntime({
      adapter,
      logger: createLogger({
        level: "info",
        secrets: ["test-connector-token", "test-db-password"],
        output: {
          log: (line) => logLines.push(line),
          error: (line) => logLines.push(line)
        }
      })
    });

    await runtime.start();
    server.sendJson(neoApiCatalogConfigPush({ mappingVersion: "mv-api-1" }));

    await waitFor(() => runtime!.getState().activeMapping?.mappingVersion === "mv-api-1");
    expect(runtime.getState().pollingPaused).toBe(false);
    expect(adapter.queryChanges).toHaveBeenCalled();
    expect(logLines.some((line) => line.includes('"event":"mapping.active"'))).toBe(true);
    expect(logLines.some((line) => line.includes('"event":"poll started"'))).toBe(true);

    const batchMessage = await nextProductBatch(server);
    expect(batchMessage.parsed).toMatchObject({
      type: "product.batch",
      batch: {
        connectorId: "connector-1",
        customerId: "customer-1",
        mappingVersion: "mv-api-1"
      }
    });
    expect((batchMessage.parsed.batch as { records: unknown[] }).records).toMatchObject([
      {
        sourceProductCode: "SKU-1",
        name: "Produto 1",
        price: 10,
        stock: 5,
        sourceUpdatedAt: "2026-05-16T20:00:01.000Z"
      }
    ]);
  });

  it("activates production-shaped connector.config over WebSocket and emits mapped product.batch", async () => {
    runtime = createRuntime({
      adapter: adapterWithRows([
        {
          product_id: "P-001",
          description: "Dipirona 500mg",
          sale_price: "12.50",
          quantity: "7",
          ean: "7891234567890",
          is_active: 1,
          updated_at: "2026-05-16T20:00:01.000Z"
        },
        {
          product_id: "P-002",
          description: "Paracetamol 750mg",
          sale_price: "8.90",
          quantity: "4",
          ean: "7899876543210",
          is_active: 0,
          updated_at: "2026-05-16T20:00:02.000Z"
        }
      ])
    });

    await runtime.start();
    server.sendJson(productionConnectorConfig());

    const batchMessage = await nextProductBatch(server);
    const batch = batchMessage.parsed.batch as Record<string, unknown>;
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
    expect(batch.records).toHaveLength(2);
    expect(batch.records).toEqual([
      {
        sourceProductCode: "P-001",
        name: "Dipirona 500mg",
        barcode: "7891234567890",
        price: 12.5,
        stock: 7,
        active: true,
        sourceUpdatedAt: "2026-05-16T20:00:01.000Z"
      },
      {
        sourceProductCode: "P-002",
        name: "Paracetamol 750mg",
        barcode: "7899876543210",
        price: 8.9,
        stock: 4,
        active: false,
        sourceUpdatedAt: "2026-05-16T20:00:02.000Z"
      }
    ]);
    expect(runtime.getState().activeMapping).toMatchObject({
      mappingVersion: "mapping-v1",
      selectedProductTable: "products",
      pollIntervalMs: 10_000,
      batchSize: 500,
      incrementalQuery: "select * from products where updated_at > ? order by updated_at",
      cursorField: "updated_at",
      cursorType: "timestamp"
    });

    server.sendJson({
      type: "batch.ack",
      batchId: batch.batchId as string,
      accepted: true,
      acceptedRecordCount: 2,
      rejectedRecordCount: 0,
      nextAction: "continue"
    });

    await waitUntilState(stateFilePath, (state) => state.lastAckedCursor === "2026-05-16T20:00:02.000Z");
    const state = JSON.parse(await readFile(stateFilePath, "utf8")) as Record<string, unknown>;
    expect(state.lastSuccessfulSendAt).toBe("2026-05-16T20:00:01.000Z");
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

  it("responds to catalog.mapping.preview with correlated stub result within platform timeout", async () => {
    runtime = createRuntime({ adapter: adapterWithRows([]) });

    await runtime.start();
    await server.waitForConnectionCount(1);

    const startedAt = Date.now();
    server.sendJson({
      id: "prev-integration-1",
      type: "catalog.mapping.preview",
      mapping: validMapping(),
      maxSampleSize: 5
    });

    const response = await nextCatalogMappingPreviewResult(server);
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1_000);
    expect(response.parsed).toEqual({
      id: "prev-integration-1",
      type: CATALOG_MAPPING_PREVIEW_RESULT_TYPE,
      samples: [],
      summary: {
        matchedCount: 0,
        sampleCount: 0,
        invalidCount: 0
      }
    });
  });

  it("responds to schema.tables.list with correlated column metadata for the panel protocol", async () => {
    runtime = createRuntime({
      adapter: adapterWithSchema(
        [],
        [{ name: "z_products" }, { name: "a_products" }],
        [{ name: "id", dataType: "int", nullable: false }]
      )
    });

    await runtime.start();
    await server.waitForConnectionCount(1);
    server.sendJson({
      id: "cmd-123",
      type: "schema.tables.list"
    });

    const response = await nextSchemaTablesListResult(server);
    expect(response.parsed).toMatchObject({
      id: "cmd-123",
      type: "schema.tables.list.result",
      tables: [
        {
          name: "a_products",
          columns: [{ name: "id", type: "int", nullable: false }]
        },
        {
          name: "z_products",
          columns: [{ name: "id", type: "int", nullable: false }]
        }
      ]
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

  it("responds to file-discovery.scan with correlated filesystem entries", async () => {
    const scanRoot = await mkdtemp(join(tmpdir(), "connector-flow-file-discovery-"));
    await mkdir(join(scanRoot, "data"), { recursive: true });
    await writeFile(join(scanRoot, "data", "file.csv"), "a");

    runtime = createRuntime({
      adapter: adapterWithRows([])
    });

    await runtime.start();
    await server.waitForConnectionCount(1);

    server.sendJson({
      id: "scan-int-1",
      type: FILE_DISCOVERY_SCAN_COMMAND_TYPE,
      rootPath: scanRoot
    });

    const response = await nextFileDiscoveryScanResult(server);

    expect(response.parsed).toMatchObject({
      id: "scan-int-1",
      type: FILE_DISCOVERY_SCAN_RESULT_TYPE
    });
    const parsed = response.parsed as FileDiscoveryScanResultMessage;
    expect(parsed.failureReason).toBeUndefined();
    expect(parsed.entries.some((entry) => entry.name === "file.csv")).toBe(true);
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
    logger?: ReturnType<typeof createLogger>;
  }): ConnectorRuntime {
    return new ConnectorRuntime({
      env: validEnv({ CONNECTOR_WS_URL: server.url }),
      logger:
        options.logger ??
        createLogger({ level: "error", secrets: ["test-connector-token", "test-db-password"] }),
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
  return adapterWithSchema(rows, tables, []);
}

function adapterWithSchema(
  rows: Record<string, unknown>[],
  tables: Array<{ name: string }>,
  columns: Array<{ name: string; dataType?: string; nullable?: boolean }>
): SourceDatabaseAdapter {
  return {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    queryChanges: vi.fn(async () => rows),
    listTables: vi.fn(async () => tables),
    listColumns: vi.fn(async () => columns)
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

async function nextConnectorError(server: MockWebSocketServer) {
  while (true) {
    const message = await server.nextMessage();
    if (message.parsed.type === "connector.error") {
      return message;
    }
  }
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

async function nextSchemaTablesListResult(server: MockWebSocketServer) {
  while (true) {
    const message = await server.nextMessage();
    if (message.parsed.type === "connector.heartbeat") {
      continue;
    }
    if (message.parsed.type === "schema.tables.list.result") {
      return message;
    }
  }
}

async function nextCatalogMappingPreviewResult(server: MockWebSocketServer) {
  while (true) {
    const message = await server.nextMessage();
    if (message.parsed.type === CATALOG_MAPPING_PREVIEW_RESULT_TYPE) {
      return message;
    }
  }
}

async function nextSetupConfigResult(server: MockWebSocketServer) {
  while (true) {
    const message = await server.nextMessage();
    if (message.parsed.type === "connector.heartbeat") {
      continue;
    }
    if (message.parsed.type === CONNECTOR_SETUP_CONFIG_RESULT_TYPE) {
      return message;
    }
  }
}

async function nextFileDiscoveryScanResult(server: MockWebSocketServer) {
  while (true) {
    const message = await server.nextMessage();
    if (message.parsed.type === FILE_DISCOVERY_SCAN_RESULT_TYPE) {
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
