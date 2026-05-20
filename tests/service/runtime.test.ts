import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ConfigValidationError } from "../../src/config/env.js";
import * as adapterFactory from "../../src/db/adapter-factory.js";
import { buildMockPanelConnectorConfig } from "../../src/cli/mock-panel.js";
import type { SourceDatabaseAdapter } from "../../src/db/source-adapter.js";
import type { ProductChangeBatch } from "../../src/poller/batch-builder.js";
import { ConnectorRuntime, type RuntimeTransport } from "../../src/service/runtime.js";
import { StateStore } from "../../src/state/state-store.js";
import type {
  AdminRequestMessage,
  AdminResponseMessage,
  BatchAckMessage,
  ConnectorConfigMessage
} from "../../src/transport/protocol.js";
import {
  CONNECTOR_SETUP_CONFIG_RESULT_TYPE,
  type ConnectorSetupConfigCommand
} from "../../src/transport/connector-setup-ws.js";
import {
  FILE_DISCOVERY_SCAN_RESULT_TYPE,
  type FileDiscoveryScanResultMessage
} from "../../src/transport/file-discovery-ws.js";
import { validEnv } from "../helpers/env.js";
import { validMapping } from "../helpers/mapping.js";

describe("ConnectorRuntime", () => {
  it("fails fast when startup configuration validation fails", () => {
    expect(() => new ConnectorRuntime({ env: validEnv({ DB_PASSWORD: "" }) })).toThrow(ConfigValidationError);
  });

  it("connects WebSocket before starting polling", async () => {
    const transport = new FakeTransport();
    const adapter = adapterWithRows([]);
    const timers = manualTimers();
    const runtime = createRuntime({ transport, adapter, timers });

    await runtime.start();

    expect(transport.connect).toHaveBeenCalledOnce();
    expect(adapter.connect).not.toHaveBeenCalled();
    expect(adapter.queryChanges).not.toHaveBeenCalled();
    expect(timers.callbacks).toHaveLength(0);
  });

  it("keeps polling paused and does not activate mapping when runtime mapping validation fails", async () => {
    const transport = new FakeTransport();
    const adapter = adapterWithRows([]);
    const runtime = createRuntime({ transport, adapter });

    await runtime.start();
    transport.emitConfig(
      configMessage({
        mapping: validMapping({ cursorType: "uuid" as "timestamp" })
      })
    );
    await waitUntil(() => transport.sendConnectorError.mock.calls.length > 0);

    expect(runtime.getState().pollingPaused).toBe(true);
    expect(runtime.getState().activeMapping).toBeUndefined();
    expect(adapter.queryChanges).not.toHaveBeenCalled();
    expect(transport.sendConnectorError).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "CONFIG_ACTIVATION_FAILED",
        message: expect.stringContaining("cursorType")
      }),
      expect.any(String)
    );
    expect(JSON.stringify(transport.sendConnectorError.mock.calls)).not.toContain("test-db-password");
  });

  it("waits for connector.config before creating polling cycles", async () => {
    const transport = new FakeTransport();
    const adapter = adapterWithRows([]);
    const timers = manualTimers();
    const runtime = createRuntime({ transport, adapter, timers });

    await runtime.start();
    await runtime.pollOnceForTest();
    expect(adapter.queryChanges).not.toHaveBeenCalled();

    transport.emitConfig(configMessage());
    await waitUntil(() => runtime.getState().activeMapping?.mappingVersion === "mapping-v1");

    expect(adapter.connect).toHaveBeenCalledOnce();
    expect(timers.callbacks).toHaveLength(1);
  });

  it("accepted batch.ack advances lastAckedCursor and updates lastSuccessfulSendAt", async () => {
    const stateStore = await tempStateStore();
    const transport = new FakeTransport();
    const runtime = createRuntime({
      transport,
      stateStore,
      now: sequenceNow(["2026-05-16T20:00:00.000Z", "2026-05-16T20:00:01.000Z"]),
      adapter: adapterWithRows([
        {
          product_id: "P-001",
          description: "Dipirona",
          sale_price: "12.50",
          quantity: "7",
          updated_at: "2026-05-16T20:00:01.000Z"
        }
      ])
    });

    await runtime.start();
    transport.emitConfig(configMessage());
    await waitUntil(() => runtime.getState().activeMapping?.mappingVersion === "mapping-v1");
    await runtime.pollOnceForTest();

    expect(transport.sentBatches).toHaveLength(1);
    expect((await stateStore.load()).lastAckedCursor).toBeNull();

    transport.emitAck({
      type: "batch.ack",
      batchId: transport.sentBatches[0]!.batchId,
      accepted: true,
      acceptedRecordCount: 1,
      rejectedRecordCount: 0,
      nextAction: "continue"
    });
    await waitUntil(async () => (await stateStore.load()).lastAckedCursor === "2026-05-16T20:00:01.000Z");

    await expect(stateStore.load()).resolves.toMatchObject({
      lastAckedCursor: "2026-05-16T20:00:01.000Z",
      lastSuccessfulSendAt: "2026-05-16T20:00:01.000Z",
      lastBatchId: transport.sentBatches[0]!.batchId
    });
  });

  it("batch.ack with nextAction=retry does not advance cursor", async () => {
    const stateStore = await tempStateStore();
    const transport = new FakeTransport();
    const runtime = createRuntime({
      transport,
      stateStore,
      adapter: adapterWithRows([
        {
          product_id: "P-001",
          description: "Dipirona",
          sale_price: "12.50",
          quantity: "7",
          updated_at: "2026-05-16T20:00:01.000Z"
        }
      ])
    });

    await runtime.start();
    transport.emitConfig(configMessage());
    await waitUntil(() => runtime.getState().activeMapping?.mappingVersion === "mapping-v1");
    await runtime.pollOnceForTest();
    transport.emitAck({
      type: "batch.ack",
      batchId: transport.sentBatches[0]!.batchId,
      accepted: false,
      acceptedRecordCount: 0,
      rejectedRecordCount: 1,
      nextAction: "retry",
      errorCode: "TRANSIENT_FAILURE"
    });
    await waitUntil(() => runtime.getState().inFlightBatch === undefined);

    expect((await stateStore.load()).lastAckedCursor).toBeNull();
    expect((await stateStore.load()).lastSuccessfulSendAt).toBeUndefined();
    expect(runtime.getState().pollingPaused).toBe(false);
  });

  it("batch.ack with nextAction=reload_config pauses polling until a new mapping is active", async () => {
    const stateStore = await tempStateStore();
    const transport = new FakeTransport();
    const runtime = createRuntime({
      transport,
      stateStore,
      adapter: adapterWithRows([
        {
          product_id: "P-001",
          description: "Dipirona",
          sale_price: "12.50",
          quantity: "7",
          updated_at: "2026-05-16T20:00:01.000Z"
        }
      ])
    });

    await runtime.start();
    transport.emitConfig(configMessage());
    await waitUntil(() => runtime.getState().activeMapping?.mappingVersion === "mapping-v1");
    await runtime.pollOnceForTest();
    transport.emitAck({
      type: "batch.ack",
      batchId: transport.sentBatches[0]!.batchId,
      accepted: true,
      acceptedRecordCount: 1,
      rejectedRecordCount: 0,
      nextAction: "reload_config"
    });
    await waitUntil(() => runtime.getState().pollingPaused);

    expect(runtime.getState().pollingPaused).toBe(true);

    transport.emitConfig(configMessage({ mapping: validMapping({ mappingVersion: "mapping-v2" }) }));
    await waitUntil(() => runtime.getState().activeMapping?.mappingVersion === "mapping-v2");

    expect(runtime.getState().pollingPaused).toBe(false);
    await expect(stateStore.load()).resolves.toMatchObject({
      mappingVersion: "mapping-v2",
      lastAckedCursor: null
    });
  });

  it("config update notification pauses polling and resumes with the new mapping version", async () => {
    const transport = new FakeTransport();
    const runtime = createRuntime({ transport, adapter: adapterWithRows([]) });

    await runtime.start();
    transport.emitConfig(configMessage());
    await waitUntil(() => runtime.getState().activeMapping?.mappingVersion === "mapping-v1");
    expect(runtime.getState().activeMapping?.mappingVersion).toBe("mapping-v1");

    transport.emit("reloadConfig", { type: "config.updated", mappingVersion: "mapping-v2" });
    await waitUntil(() => runtime.getState().pollingPaused);
    expect(runtime.getState().pollingPaused).toBe(true);

    transport.emitConfig(configMessage({ mapping: validMapping({ mappingVersion: "mapping-v2" }) }));
    await waitUntil(() => runtime.getState().activeMapping?.mappingVersion === "mapping-v2");
    expect(runtime.getState().activeMapping?.mappingVersion).toBe("mapping-v2");
    expect(runtime.getState().pollingPaused).toBe(false);
  });

  it("preserves the acknowledged cursor when a mapping update keeps the same cursor contract", async () => {
    const stateStore = await tempStateStore();
    await stateStore.save({
      connectorId: "connector-1",
      customerId: "customer-1",
      mappingVersion: "mapping-v1",
      cursorField: "updated_at",
      cursorType: "timestamp",
      sourceProductCodeField: "product_id",
      lastAckedCursor: "2026-05-16T20:00:01.000Z"
    });

    const transport = new FakeTransport();
    const runtime = createRuntime({ transport, stateStore, adapter: adapterWithRows([]) });

    await runtime.start();
    transport.emitConfig(configMessage({ mapping: validMapping({ mappingVersion: "mapping-v2" }) }));
    await waitUntil(() => runtime.getState().activeMapping?.mappingVersion === "mapping-v2");

    await expect(stateStore.load()).resolves.toMatchObject({
      mappingVersion: "mapping-v2",
      cursorField: "updated_at",
      cursorType: "timestamp",
      sourceProductCodeField: "product_id",
      lastAckedCursor: "2026-05-16T20:00:01.000Z"
    });
  });

  it("preserves the acknowledged cursor when selectedProductTable is unchanged", async () => {
    const stateStore = await tempStateStore();
    await stateStore.save({
      connectorId: "connector-1",
      customerId: "customer-1",
      mappingVersion: "mapping-v1",
      selectedProductTable: "products",
      cursorField: "updated_at",
      cursorType: "timestamp",
      sourceProductCodeField: "product_id",
      lastAckedCursor: "2026-05-16T20:00:01.000Z"
    });

    const transport = new FakeTransport();
    const runtime = createRuntime({ transport, stateStore, adapter: adapterWithRows([]) });

    await runtime.start();
    transport.emitConfig(
      configMessage({
        mapping: validMapping({
          mappingVersion: "mapping-v2",
          selectedProductTable: "products"
        })
      })
    );
    await waitUntil(() => runtime.getState().activeMapping?.mappingVersion === "mapping-v2");

    await expect(stateStore.load()).resolves.toMatchObject({
      mappingVersion: "mapping-v2",
      selectedProductTable: "products",
      lastAckedCursor: "2026-05-16T20:00:01.000Z"
    });
  });

  it("resets the acknowledged cursor when a mapping update changes the cursor contract", async () => {
    const stateStore = await tempStateStore();
    await stateStore.save({
      connectorId: "connector-1",
      customerId: "customer-1",
      mappingVersion: "mapping-v1",
      cursorField: "updated_at",
      cursorType: "timestamp",
      sourceProductCodeField: "product_id",
      lastAckedCursor: "2026-05-16T20:00:01.000Z"
    });

    const transport = new FakeTransport();
    const runtime = createRuntime({ transport, stateStore, adapter: adapterWithRows([]) });

    await runtime.start();
    transport.emitConfig(
      configMessage({
        mapping: validMapping({
          mappingVersion: "mapping-v2",
          cursorField: "updated_seq",
          cursorType: "number"
        })
      })
    );
    await waitUntil(() => runtime.getState().activeMapping?.mappingVersion === "mapping-v2");

    await expect(stateStore.load()).resolves.toMatchObject({
      mappingVersion: "mapping-v2",
      cursorField: "updated_seq",
      cursorType: "number",
      sourceProductCodeField: "product_id",
      lastAckedCursor: null
    });
  });

  it("resets the acknowledged cursor when selectedProductTable changes", async () => {
    const stateStore = await tempStateStore();
    await stateStore.save({
      connectorId: "connector-1",
      customerId: "customer-1",
      mappingVersion: "mapping-v1",
      selectedProductTable: "products",
      cursorField: "updated_at",
      cursorType: "timestamp",
      sourceProductCodeField: "product_id",
      lastAckedCursor: "2026-05-16T20:00:01.000Z"
    });

    const transport = new FakeTransport();
    const runtime = createRuntime({ transport, stateStore, adapter: adapterWithRows([]) });

    await runtime.start();
    transport.emitConfig(
      configMessage({
        mapping: validMapping({
          mappingVersion: "mapping-v2",
          selectedProductTable: "inventory"
        })
      })
    );
    await waitUntil(() => runtime.getState().activeMapping?.mappingVersion === "mapping-v2");

    await expect(stateStore.load()).resolves.toMatchObject({
      mappingVersion: "mapping-v2",
      selectedProductTable: "inventory",
      lastAckedCursor: null
    });
  });

  it("resets the acknowledged cursor when fake transport receives mock panel config with changed selected table", async () => {
    const stateStore = await tempStateStore();
    await stateStore.save({
      connectorId: "connector-1",
      customerId: "customer-1",
      mappingVersion: "mapping-v1",
      selectedProductTable: "products",
      cursorField: "updated_at",
      cursorType: "timestamp",
      sourceProductCodeField: "product_id",
      lastAckedCursor: "2026-05-16T20:00:01.000Z"
    });
    const transport = new FakeTransport();
    const runtime = createRuntime({ transport, stateStore, adapter: adapterWithRows([]) });

    await runtime.start();
    transport.emitConfig(
      buildMockPanelConnectorConfig({
        connectorId: "connector-1",
        customerId: "customer-1",
        mapping: validMapping({
          mappingVersion: "mapping-v2",
          incrementalQuery: "select * from inventory where updated_at > ? order by updated_at"
        }),
        selectedProductTable: "inventory"
      })
    );
    await waitUntil(() => runtime.getState().activeMapping?.selectedProductTable === "inventory");

    await expect(stateStore.load()).resolves.toMatchObject({
      mappingVersion: "mapping-v2",
      selectedProductTable: "inventory",
      lastAckedCursor: null
    });
    expect(runtime.getState().activeMapping?.incrementalQuery).toBe(
      "select * from inventory where updated_at > ? order by updated_at"
    );
  });

  it("persists selectedProductTable during fake transport mapping activation before polling resumes", async () => {
    const stateStore = await tempStateStore();
    const transport = new FakeTransport();
    const adapter = adapterWithRows([]);
    const timers = manualTimers();
    const logger = silentLogger();
    const runtime = createRuntime({ transport, stateStore, adapter, timers, logger });

    await runtime.start();
    transport.emitConfig(
      configMessage({
        mapping: validMapping({
          selectedProductTable: "products"
        })
      })
    );
    await waitUntil(() => runtime.getState().activeMapping?.selectedProductTable === "products");

    expect(adapter.queryChanges).not.toHaveBeenCalled();
    expect(timers.callbacks).toHaveLength(1);
    await expect(stateStore.load()).resolves.toMatchObject({
      mappingVersion: "mapping-v1",
      selectedProductTable: "products",
      lastAckedCursor: null
    });
    expect(logger.info).toHaveBeenCalledWith(
      "mapping.active",
      expect.objectContaining({ selectedProductTable: "products" })
    );
  });

  it("handles schema.listTables and sends a correlated success response with sorted table names", async () => {
    const transport = new FakeTransport();
    const adapter = adapterWithTables([{ name: "z_products" }, { name: "a_products" }]);
    const logger = silentLogger();
    const runtime = createRuntime({ transport, adapter, logger });

    await runtime.start();
    transport.emitAdminRequest(adminRequest({ requestId: "request-1" }));
    await waitUntil(() => transport.sentAdminResponses.length === 1);

    expect(adapter.connect).toHaveBeenCalledOnce();
    expect(adapter.listTables).toHaveBeenCalledOnce();
    expect(adapter.listColumns).toHaveBeenCalledTimes(2);
    expect(transport.sentAdminResponses[0]).toMatchObject({
      type: "admin.response",
      requestId: "request-1",
      command: "schema.listTables",
      ok: true,
      payload: { tables: ["a_products", "z_products"] }
    });
    expect(logger.info).toHaveBeenCalledWith(
      "schema.discovery.received",
      expect.objectContaining({
        correlationId: "request-1",
        responseFormat: "admin",
        command: "schema.listTables"
      })
    );
    expect(logger.info).toHaveBeenCalledWith(
      "admin.response.sent",
      expect.objectContaining({ requestId: "request-1", ok: true, tableCount: 2 })
    );
  });

  it("connects the adapter before discovery when no mapping has been activated", async () => {
    const transport = new FakeTransport();
    const adapter = adapterWithTables([{ name: "products" }]);
    const runtime = createRuntime({ transport, adapter });

    await runtime.start();
    transport.emitAdminRequest(adminRequest());
    await waitUntil(() => transport.sentAdminResponses.length === 1);

    expect(adapter.connect).toHaveBeenCalledOnce();
    expect(adapter.queryChanges).not.toHaveBeenCalled();
    expect(runtime.getState().activeMapping).toBeUndefined();
    expect(runtime.getState().pollingPaused).toBe(true);
  });

  it("reuses an already connected adapter when discovery occurs after mapping activation", async () => {
    const transport = new FakeTransport();
    const adapter = adapterWithTables([{ name: "products" }]);
    const runtime = createRuntime({ transport, adapter });

    await runtime.start();
    transport.emitConfig(configMessage());
    await waitUntil(() => runtime.getState().activeMapping?.mappingVersion === "mapping-v1");
    transport.emitAdminRequest(adminRequest({ requestId: "request-after-config" }));
    await waitUntil(() => transport.sentAdminResponses.length === 1);

    expect(adapter.connect).toHaveBeenCalledOnce();
    expect(adapter.listTables).toHaveBeenCalledOnce();
    expect(transport.sentAdminResponses[0]?.requestId).toBe("request-after-config");
  });

  it("sends a correlated admin error response when table discovery fails", async () => {
    const transport = new FakeTransport();
    const adapter = adapterWithTables([], new Error("cannot inspect test-db-password tables"));
    const logger = silentLogger();
    const runtime = createRuntime({ transport, adapter, logger });

    await runtime.start();
    transport.emitAdminRequest(adminRequest({ requestId: "request-failure" }));
    await waitUntil(() => transport.sentAdminResponses.length === 1);

    expect(transport.sentAdminResponses[0]).toMatchObject({
      type: "admin.response",
      requestId: "request-failure",
      command: "schema.listTables",
      ok: false,
      error: {
        errorCode: "TABLE_DISCOVERY_FAILED",
        message: "cannot inspect [REDACTED] tables"
      }
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "admin.request.failed",
      expect.objectContaining({
        requestId: "request-failure",
        errorCode: "TABLE_DISCOVERY_FAILED",
        message: "cannot inspect [REDACTED] tables"
      })
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("test-db-password");
  });

  it("responds to legacy schema.tables.list with correlated column metadata", async () => {
    const transport = new FakeTransport();
    const adapter = adapterWithTables(
      [{ name: "products" }],
      undefined,
      [{ name: "id", dataType: "int", nullable: false }]
    );
    const runtime = createRuntime({ transport, adapter });

    await runtime.start();
    transport.emitSchemaDiscoveryRequest({
      responseFormat: "legacy",
      correlationId: "cmd-123"
    });
    await waitUntil(() => transport.sentSchemaResults.length === 1);

    expect(transport.sentSchemaResults[0]).toEqual({
      correlationId: "cmd-123",
      tables: [
        {
          name: "products",
          columns: [{ name: "id", type: "int", nullable: false }]
        }
      ]
    });
    expect(transport.sentAdminResponses).toHaveLength(0);
  });

  it("responds to file-discovery.scan with correlated directory entries when root exists", async () => {
    const transport = new FakeTransport();
    const adapter = adapterWithRows([]);
    const scanRoot = await mkdtemp(join(tmpdir(), "file-discovery-runtime-"));
    await mkdir(join(scanRoot, "nested"), { recursive: true });
    await writeFile(join(scanRoot, "nested", "note.txt"), "x");

    const runtime = createRuntime({ transport, adapter });
    await runtime.start();

    transport.emitFileDiscoveryScanRequest({
      correlationId: "scan-rooted",
      rootPath: scanRoot
    });

    await waitUntil(() => transport.sentFileDiscoveryResults.length === 1);

    const message = transport.sentFileDiscoveryResults[0];
    expect(message).toMatchObject({
      id: "scan-rooted",
      type: FILE_DISCOVERY_SCAN_RESULT_TYPE,
      entries: expect.any(Array)
    });
    expect(message?.failureReason).toBeUndefined();
    expect(message?.entries.some((entry) => entry.name === "note.txt")).toBe(true);

    await runtime.shutdown();
  });

  it("responds to file-discovery.scan with failure when root does not exist", async () => {
    const transport = new FakeTransport();
    const adapter = adapterWithRows([]);
    const runtime = createRuntime({ transport, adapter });
    await runtime.start();

    transport.emitFileDiscoveryScanRequest({
      correlationId: "scan-missing",
      rootPath: join(tmpdir(), "missing-root-" + randomUUID())
    });

    await waitUntil(() => transport.sentFileDiscoveryResults.length === 1);

    expect(transport.sentFileDiscoveryResults[0]).toMatchObject({
      id: "scan-missing",
      type: FILE_DISCOVERY_SCAN_RESULT_TYPE,
      entries: [],
      failureReason: "Unable to access root directory"
    });

    await runtime.shutdown();
  });

  it("does not send a legacy schema result when discovery fails", async () => {
    const transport = new FakeTransport();
    const adapter = adapterWithTables([], new Error("cannot inspect test-db-password tables"));
    const logger = silentLogger();
    const runtime = createRuntime({ transport, adapter, logger });

    await runtime.start();
    transport.emitSchemaDiscoveryRequest({
      responseFormat: "legacy",
      correlationId: "cmd-failure"
    });
    await waitUntil(() => logger.warn.mock.calls.some(([event]) => event === "schema.discovery.failed"));

    expect(transport.sentSchemaResults).toHaveLength(0);
    expect(transport.sentAdminResponses).toHaveLength(0);
  });

  it("reloads adapter on valid manual setup config and acknowledges success", async () => {
    const transport = new FakeTransport();
    const firstAdapter = adapterWithTables([{ name: "legacy_products" }]);
    const secondAdapter = adapterWithTables([{ name: "panel_products" }]);
    const createAdapterSpy = vi
      .spyOn(adapterFactory, "createSourceDatabaseAdapter")
      .mockReturnValue(secondAdapter);
    const runtime = createRuntime({
      transport,
      adapter: firstAdapter
    });

    await runtime.start();
    transport.emitSetupConfig(manualSetupCommand());
    await waitUntil(() => transport.sentSetupConfigResults.length === 1);

    expect(transport.sentSetupConfigResults[0]).toMatchObject({
      type: CONNECTOR_SETUP_CONFIG_RESULT_TYPE,
      ok: true,
      setupMethod: "manual",
      driver: "mysql"
    });
    expect(createAdapterSpy).toHaveBeenCalledOnce();
    expect(firstAdapter.close).toHaveBeenCalledOnce();
    expect(secondAdapter.connect).toHaveBeenCalledOnce();

    transport.emitSchemaDiscoveryRequest({
      responseFormat: "legacy",
      correlationId: "schema-after-setup"
    });
    await waitUntil(() => transport.sentSchemaResults.length === 1);
    expect(secondAdapter.listTables).toHaveBeenCalled();
    expect(firstAdapter.listTables).not.toHaveBeenCalled();

    createAdapterSpy.mockRestore();
  });

  it("keeps prior adapter when setup config connection fails", async () => {
    const transport = new FakeTransport();
    const adapter = adapterWithTables([{ name: "products" }]);
    const failingAdapter = {
      connect: vi.fn(async () => {
        throw new Error("cannot reach test-db-password host");
      }),
      close: vi.fn(async () => undefined),
      queryChanges: vi.fn(async () => []),
      listTables: vi.fn(async () => [{ name: "products" }]),
      listColumns: vi.fn(async () => [])
    };
    const createAdapterSpy = vi
      .spyOn(adapterFactory, "createSourceDatabaseAdapter")
      .mockReturnValue(failingAdapter);
    const runtime = createRuntime({
      transport,
      adapter
    });

    await runtime.start();
    transport.emitSetupConfig(
      manualSetupCommand({
        password: "test-db-password"
      })
    );
    await waitUntil(() => transport.sentSetupConfigResults.length === 1);

    expect(transport.sentSetupConfigResults[0]).toMatchObject({
      type: CONNECTOR_SETUP_CONFIG_RESULT_TYPE,
      ok: false,
      errorCode: "SETUP_CONNECTION_FAILED"
    });
    expect(JSON.stringify(transport.sentSetupConfigResults)).not.toContain("test-db-password");
    expect(adapter.close).not.toHaveBeenCalled();

    transport.emitSchemaDiscoveryRequest({
      responseFormat: "legacy",
      correlationId: "schema-prior-adapter"
    });
    await waitUntil(() => transport.sentSchemaResults.length === 1);
    expect(adapter.listTables).toHaveBeenCalled();
    expect(failingAdapter.listTables).not.toHaveBeenCalled();

    createAdapterSpy.mockRestore();
  });

  it("does not pause polling for a successful discovery request", async () => {
    const transport = new FakeTransport();
    const adapter = adapterWithTables([{ name: "products" }]);
    const timers = manualTimers();
    const runtime = createRuntime({ transport, adapter, timers });

    await runtime.start();
    transport.emitConfig(configMessage());
    await waitUntil(() => runtime.getState().activeMapping?.mappingVersion === "mapping-v1");
    const scheduledPolls = timers.callbacks.length;

    transport.emitAdminRequest(adminRequest());
    await waitUntil(() => transport.sentAdminResponses.length === 1);

    expect(runtime.getState().pollingPaused).toBe(false);
    expect(runtime.getState().activeMapping?.mappingVersion).toBe("mapping-v1");
    expect(timers.callbacks).toHaveLength(scheduledPolls);
  });

  it("shutdown closes WebSocket and database adapter after state writes complete", async () => {
    const transport = new FakeTransport();
    const adapter = adapterWithRows([]);
    const runtime = createRuntime({ transport, adapter });

    await runtime.start();
    transport.emitConfig(configMessage());
    await waitUntil(() => runtime.getState().activeMapping?.mappingVersion === "mapping-v1");
    await runtime.shutdown();

    expect(transport.close).toHaveBeenCalledOnce();
    expect(adapter.close).toHaveBeenCalledOnce();
    expect(runtime.getState().stopped).toBe(true);
  });

  it("service scripts reference service name and required environment variables", async () => {
    const root = join(process.cwd(), "scripts");
    const install = await readFile(join(root, "install-service.ps1"), "utf8");
    const restart = await readFile(join(root, "restart-service.ps1"), "utf8");
    const uninstall = await readFile(join(root, "uninstall-service.ps1"), "utf8");

    for (const content of [install, restart, uninstall]) {
      expect(content).toContain("PharmaAgentConnector");
    }
    for (const name of [
      "CONNECTOR_TOKEN",
      "CONNECTOR_WS_URL",
      "DB_DRIVER",
      "DB_HOST",
      "DB_PORT",
      "DB_NAME",
      "DB_USER",
      "DB_PASSWORD"
    ]) {
      expect(install).toContain(name);
    }
  });
});

function createRuntime(
  overrides: Partial<ConstructorParameters<typeof ConnectorRuntime>[0]> = {}
): ConnectorRuntime {
  return new ConnectorRuntime({
    env: validEnv(),
    logger: overrides.logger ?? silentLogger(),
    stateStore: overrides.stateStore ?? new StateStore({ stateFilePath: join(tmpdir(), `runtime-${randomUUID()}.json`) }),
    transport: overrides.transport ?? new FakeTransport(),
    adapter: overrides.adapter ?? adapterWithRows([]),
    timers: overrides.timers ?? manualTimers(),
    now: overrides.now ?? (() => "2026-05-16T20:00:00.000Z")
  });
}

function configMessage(overrides: Partial<ConnectorConfigMessage> = {}): ConnectorConfigMessage {
  return {
    type: "connector.config",
    connectorId: "connector-1",
    customerId: "customer-1",
    mapping: validMapping(),
    ...overrides
  };
}

function adapterWithRows(rows: Record<string, unknown>[]): SourceDatabaseAdapter {
  return {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    queryChanges: vi.fn(async () => rows),
    listTables: vi.fn(async () => [{ name: "products" }]),
    listColumns: vi.fn(async () => [])
  };
}

function adapterWithTables(
  tables: Array<{ name: string }>,
  listTablesError?: Error,
  columns: Array<{ name: string; dataType?: string; nullable?: boolean }> = []
): SourceDatabaseAdapter {
  return {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    queryChanges: vi.fn(async () => []),
    listColumns: vi.fn(async () => columns),
    listTables: vi.fn(async () => {
      if (listTablesError) {
        throw listTablesError;
      }
      return tables;
    })
  };
}

function manualSetupCommand(
  overrides: Partial<ConnectorSetupConfigCommand> = {}
): ConnectorSetupConfigCommand {
  return {
    type: "connector.setup.config",
    correlationId: "setup-1",
    setupMethod: "manual",
    driver: "mysql",
    host: "db.local",
    port: 3306,
    database: "pharma_db",
    username: "app",
    password: "secret",
    ...overrides
  };
}

function adminRequest(overrides: Partial<AdminRequestMessage> = {}): AdminRequestMessage {
  return {
    type: "admin.request",
    requestId: "request-1",
    command: "schema.listTables",
    ...overrides
  };
}

async function tempStateStore(): Promise<StateStore> {
  const dir = await mkdtemp(join(tmpdir(), "connector-runtime-"));
  return new StateStore({ stateFilePath: join(dir, "state.json") });
}

function manualTimers() {
  const callbacks: Array<() => void> = [];
  return {
    callbacks,
    setTimeout: (callback: () => void) => {
      callbacks.push(callback);
      return callback;
    },
    clearTimeout: (handle: unknown) => {
      const index = callbacks.indexOf(handle as () => void);
      if (index >= 0) {
        callbacks.splice(index, 1);
      }
    }
  };
}

function sequenceNow(values: string[]): () => string {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

function silentLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

async function waitUntil(assertion: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!(await assertion())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for runtime condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class FakeTransport extends EventEmitter implements RuntimeTransport {
  public readonly sentBatches: ProductChangeBatch[] = [];
  public readonly sentAdminResponses: AdminResponseMessage[] = [];
  public readonly sentSchemaResults: Array<{
    correlationId: string;
    tables: Array<{ name: string; columns: Array<{ name: string; type: string; nullable?: boolean }> }>;
  }> = [];
  public readonly sentFileDiscoveryResults: FileDiscoveryScanResultMessage[] = [];
  public readonly sentSetupConfigResults: import("../../src/transport/connector-setup-ws.js").ConnectorSetupConfigResultMessage[] =
    [];
  public readonly connect = vi.fn(async () => {
    this.connected = true;
    this.emit("connected");
  });
  public readonly close = vi.fn(async () => {
    this.connected = false;
  });
  public readonly sendHeartbeat = vi.fn();
  public readonly sendConnectorError = vi.fn();
  public readonly sendAdminResponse = vi.fn((message: AdminResponseMessage) => {
    this.sentAdminResponses.push(message);
  });
  public readonly sendSchemaTablesListResult = vi.fn((input: {
    correlationId: string;
    tables: Array<{ name: string; columns: Array<{ name: string; type: string; nullable?: boolean }> }>;
  }) => {
    this.sentSchemaResults.push(input);
  });
  public readonly sendFileDiscoveryScanResult = vi.fn((message: FileDiscoveryScanResultMessage) => {
    this.sentFileDiscoveryResults.push(message);
  });
  public readonly sendConnectorSetupConfigResult = vi.fn(
    (message: import("../../src/transport/connector-setup-ws.js").ConnectorSetupConfigResultMessage) => {
      this.sentSetupConfigResults.push(message);
    }
  );
  private connected = false;

  public isConnected(): boolean {
    return this.connected;
  }

  public sendBatch(batch: ProductChangeBatch): void {
    this.sentBatches.push(batch);
  }

  public getReconnectAttemptCount(): number {
    return 0;
  }

  public emitConfig(message: ConnectorConfigMessage): void {
    this.emit("config", message);
  }

  public emitAck(message: BatchAckMessage): void {
    this.emit("batchAck", message);
  }

  public emitSchemaDiscoveryRequest(
    request: import("../../src/transport/schema-discovery.js").SchemaDiscoveryRequest
  ): void {
    this.emit("schemaDiscoveryRequest", request);
  }

  public emitFileDiscoveryScanRequest(request: {
    correlationId: string;
    rootPath?: string;
  }): void {
    this.emit("fileDiscoveryScanRequest", request);
  }

  public emitSetupConfig(request: ConnectorSetupConfigCommand): void {
    this.emit("setupConfigRequest", request);
  }

  public emitAdminRequest(message: AdminRequestMessage): void {
    this.emitSchemaDiscoveryRequest({
      responseFormat: "admin",
      correlationId: message.requestId,
      command: message.command
    });
  }
}
