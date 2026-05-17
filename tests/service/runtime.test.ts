import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ConfigValidationError } from "../../src/config/env.js";
import type { SourceDatabaseAdapter } from "../../src/db/source-adapter.js";
import type { ProductChangeBatch } from "../../src/poller/batch-builder.js";
import { ConnectorRuntime, type RuntimeTransport } from "../../src/service/runtime.js";
import { StateStore } from "../../src/state/state-store.js";
import type { BatchAckMessage, ConnectorConfigMessage } from "../../src/transport/protocol.js";
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
    logger: silentLogger(),
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
    queryChanges: vi.fn(async () => rows)
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
  public readonly connect = vi.fn(async () => {
    this.connected = true;
    this.emit("connected");
  });
  public readonly close = vi.fn(async () => {
    this.connected = false;
  });
  public readonly sendHeartbeat = vi.fn();
  public readonly sendConnectorError = vi.fn();
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
}
