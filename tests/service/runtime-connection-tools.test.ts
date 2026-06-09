import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ConnectorRuntime } from "../../src/service/runtime.js";
import { StateStore } from "../../src/state/state-store.js";
import type { DiscoveredConnection } from "../../src/discovery/connection-candidates.js";
import type { DatabaseConfig } from "../../src/config/types.js";

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

const env = {
  CONNECTOR_TOKEN: "tok",
  CONNECTOR_WS_URL: "ws://localhost:9999",
  PROGRAMDATA: "/tmp/does-not-matter"
} as never;

const FULL_CONFIG: DatabaseConfig = {
  driver: "mysql",
  host: "10.0.0.9",
  port: 3306,
  name: "loja",
  user: "leitor",
  password: "topsecret"
};

function discovery(): DiscoveredConnection[] {
  return [
    {
      handle: "conn-0",
      config: FULL_CONFIG,
      descriptor: {
        handle: "conn-0",
        driver: "mysql",
        host: "10.0.0.9",
        port: 3306,
        user: "leitor",
        database: "loja",
        source: "config:/etc/app/db.conf",
        label: "mysql @ 10.0.0.9:3306 (leitor) — config:/etc/app/db.conf"
      }
    }
  ];
}

function makeRuntime(transport: FakeTransport, discoveredListTables: string[]) {
  // Fake da conexão mysql2: listTables faz `select table_name as name ...` e o
  // adapter normaliza result[0] (recordset). Devolvemos as tabelas desejadas.
  const connectionFactory = vi.fn(async () => ({
    query: vi.fn(async () => [discoveredListTables.map((name) => ({ name })), []]),
    end: vi.fn(async () => undefined)
  }));
  const runtime = new ConnectorRuntime({
    env,
    allowMissingDatabaseConfig: true,
    transport: transport as never,
    now: () => "2026-06-09T00:00:00.000Z",
    stateStore: new StateStore({ stateFilePath: join(tmpdir(), `rt-${randomUUID()}.json`) }),
    discoverConnections: async () => discovery(),
    // O connection.use cria adapter via adapter-factory; injetamos um factory
    // mysql que devolve uma conexão fake (sem driver real).
    adapterDependencies: {
      mysqlConnectionFactory: connectionFactory,
      firebirdConnectionFactory: vi.fn(),
      postgresConnectionFactory: vi.fn(),
      mariadbConnectionFactory: vi.fn(),
      sqlserverConnectionFactory: vi.fn()
    } as never
  } as never);
  return { runtime, connectionFactory };
}

async function aiMessages(transport: FakeTransport) {
  return (transport.sendAiSessionMessage.mock.calls as Array<[unknown]>).map((c) => c[0]) as Array<Record<string, unknown>>;
}

describe("ConnectorRuntime — connection.* tools (discover→use→schema)", () => {
  it("connection.discoverCandidates devolve descritores redigidos (sem senha)", async () => {
    const transport = new FakeTransport();
    const { runtime } = makeRuntime(transport, ["produtos", "precos"]);
    await runtime.start();

    transport.emit("aiSessionStart", { sessionId: "s1" });
    transport.emit("aiToolInvoke", { sessionId: "s1", invocationId: "d1", name: "connection.discoverCandidates", input: {} });

    await vi.waitFor(async () => {
      const msgs = await aiMessages(transport);
      expect(msgs.some((m) => m.type === "tool.result" && m.invocationId === "d1")).toBe(true);
    });
    const result = (await aiMessages(transport)).find((m) => m.type === "tool.result" && m.invocationId === "d1") as { payload: { candidates: unknown[] } };
    expect(result.payload.candidates).toEqual([discovery()[0].descriptor]);
    expect(JSON.stringify(result)).not.toContain("topsecret");

    await runtime.shutdown();
  });

  it("connection.use conecta e schema.listTables passa a operar na conexão estabelecida", async () => {
    const transport = new FakeTransport();
    const { runtime } = makeRuntime(transport, ["produtos", "precos", "estoque"]);
    await runtime.start();

    transport.emit("aiSessionStart", { sessionId: "s1" });
    transport.emit("aiToolInvoke", { sessionId: "s1", invocationId: "d1", name: "connection.discoverCandidates", input: {} });
    await vi.waitFor(async () => {
      expect((await aiMessages(transport)).some((m) => m.invocationId === "d1" && m.type === "tool.result")).toBe(true);
    });

    transport.emit("aiToolInvoke", { sessionId: "s1", invocationId: "u1", name: "connection.use", input: { handle: "conn-0" } });
    await vi.waitFor(async () => {
      expect((await aiMessages(transport)).some((m) => m.invocationId === "u1" && m.type === "tool.result")).toBe(true);
    });
    const useResult = (await aiMessages(transport)).find((m) => m.invocationId === "u1") as { payload: { ok: boolean; tablesCount: number } };
    expect(useResult.payload).toEqual({ ok: true, tablesCount: 3 });

    // Agora as tools de schema operam na conexão estabelecida (3 tabelas).
    transport.emit("aiToolInvoke", { sessionId: "s1", invocationId: "lt", name: "schema.listTables", input: {} });
    await vi.waitFor(async () => {
      expect((await aiMessages(transport)).some((m) => m.invocationId === "lt" && m.type === "tool.result")).toBe(true);
    });
    const ltResult = (await aiMessages(transport)).find((m) => m.invocationId === "lt") as { ok: boolean; payload: { tables: string[] } };
    expect(ltResult.ok).toBe(true);
    expect([...ltResult.payload.tables].sort()).toEqual(["estoque", "precos", "produtos"]);

    await runtime.shutdown();
  });

  it("connection.use com handle desconhecido devolve { ok:false, errorCode }", async () => {
    const transport = new FakeTransport();
    const { runtime } = makeRuntime(transport, ["produtos"]);
    await runtime.start();

    transport.emit("aiSessionStart", { sessionId: "s1" });
    transport.emit("aiToolInvoke", { sessionId: "s1", invocationId: "d1", name: "connection.discoverCandidates", input: {} });
    await vi.waitFor(async () => {
      expect((await aiMessages(transport)).some((m) => m.invocationId === "d1")).toBe(true);
    });

    transport.emit("aiToolInvoke", { sessionId: "s1", invocationId: "u9", name: "connection.use", input: { handle: "conn-99" } });
    await vi.waitFor(async () => {
      expect((await aiMessages(transport)).some((m) => m.invocationId === "u9")).toBe(true);
    });
    const r = (await aiMessages(transport)).find((m) => m.invocationId === "u9") as { payload: { ok: boolean; errorCode: string } };
    expect(r.payload).toEqual({ ok: false, errorCode: "UNKNOWN_HANDLE" });

    await runtime.shutdown();
  });

  it("A5: ao abortar a sessão a conexão estabelecida é descartada (fecha o adapter)", async () => {
    const transport = new FakeTransport();
    const { runtime, connectionFactory } = makeRuntime(transport, ["produtos"]);
    await runtime.start();

    transport.emit("aiSessionStart", { sessionId: "s1" });
    transport.emit("aiToolInvoke", { sessionId: "s1", invocationId: "d1", name: "connection.discoverCandidates", input: {} });
    await vi.waitFor(async () => {
      expect((await aiMessages(transport)).some((m) => m.invocationId === "d1")).toBe(true);
    });
    transport.emit("aiToolInvoke", { sessionId: "s1", invocationId: "u1", name: "connection.use", input: { handle: "conn-0" } });
    await vi.waitFor(async () => {
      expect((await aiMessages(transport)).some((m) => m.invocationId === "u1")).toBe(true);
    });
    const fakeConn = await connectionFactory.mock.results[0].value;

    transport.emit("aiSessionAbort", { sessionId: "s1", reason: "user" });
    await vi.waitFor(() => expect(fakeConn.end).toHaveBeenCalled());

    await runtime.shutdown();
  });
});
