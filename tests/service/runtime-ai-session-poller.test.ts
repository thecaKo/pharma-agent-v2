import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ConnectorRuntime } from "../../src/service/runtime.js";
import { StateStore } from "../../src/state/state-store.js";
import type { SourceDatabaseAdapter } from "../../src/db/source-adapter.js";
import { productionConnectorConfig } from "../helpers/mapping.js";

class FakeTransport extends EventEmitter {
  public connect = vi.fn(async () => {
    this.connected = true;
    this.emit("connected");
  });
  public close = vi.fn(async () => {
    this.connected = false;
  });
  public connected = false;
  public isConnected = vi.fn(() => this.connected);
  public sendBatch = vi.fn();
  public sendHeartbeat = vi.fn();
  public sendConnectorError = vi.fn();
  public sendAdminResponse = vi.fn();
  public sendSchemaTablesListResult = vi.fn();
  public sendFileDiscoveryScanResult = vi.fn();
  public sendConnectorSetupConfigResult = vi.fn();
  public sendConnectorDiscovery = vi.fn();
  public sendAiSessionMessage = vi.fn();
  public sendProvisionReadonlyUserResult = vi.fn();
  public getReconnectAttemptCount = vi.fn(() => 0);
}

function fakeAdapter(): SourceDatabaseAdapter {
  return {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    queryChanges: vi.fn(async () => []),
    querySnapshotPage: vi.fn(async () => []),
    listTables: vi.fn(async () => [{ name: "products" }]),
    listColumns: vi.fn(async () => [{ name: "product_id" }]),
    describeTable: vi.fn(async () => []),
    listForeignKeys: vi.fn(async () => []),
    sampleRows: vi.fn(async () => []),
    runReadOnlySelect: vi.fn(async () => [])
  } as never;
}

const env = {
  CONNECTOR_TOKEN: "tok",
  CONNECTOR_WS_URL: "ws://localhost:9999",
  DB_DRIVER: "mysql",
  DB_HOST: "127.0.0.1",
  DB_PORT: "3306",
  DB_NAME: "pharmacy",
  DB_USER: "admin",
  DB_PASSWORD: "admin-secret",
  PROGRAMDATA: "/tmp/does-not-matter"
} as never;

function makeRuntime(transport: FakeTransport) {
  return new ConnectorRuntime({
    env,
    transport: transport as never,
    adapter: fakeAdapter(),
    now: () => "2026-06-09T00:00:00.000Z",
    stateStore: new StateStore({ stateFilePath: join(tmpdir(), `runtime-${randomUUID()}.json`) })
  } as never);
}

describe("ConnectorRuntime — ciclo de vida da sessão de IA × poller", () => {
  it("pausa o poller ao iniciar a sessão de IA", async () => {
    const transport = new FakeTransport();
    const runtime = makeRuntime(transport);
    await runtime.start();

    transport.emit("config", productionConnectorConfig());
    await vi.waitFor(() => expect(runtime.getState().pollingPaused).toBe(false));

    transport.emit("aiSessionStart", { sessionId: "sess-1" });
    await vi.waitFor(() => expect(runtime.getState().pollingPaused).toBe(true));
  });

  it("retoma o poller no abort sem ter aplicado mapping", async () => {
    const transport = new FakeTransport();
    const runtime = makeRuntime(transport);
    await runtime.start();

    transport.emit("config", productionConnectorConfig());
    await vi.waitFor(() => expect(runtime.getState().pollingPaused).toBe(false));
    const mappingBefore = runtime.getState().activeMapping?.mappingVersion;

    transport.emit("aiSessionStart", { sessionId: "sess-1" });
    await vi.waitFor(() => expect(runtime.getState().pollingPaused).toBe(true));

    transport.emit("aiSessionAbort", { sessionId: "sess-1", reason: "user" });
    await vi.waitFor(() => expect(runtime.getState().pollingPaused).toBe(false));
    expect(runtime.getState().activeMapping?.mappingVersion).toBe(mappingBefore);
  });
});
