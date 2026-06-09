import { describe, expect, it, vi } from "vitest";
import { AiSession, type AiSessionDeps, type AiSessionOutboundMessage } from "../../src/ai-session/ai-session.js";
import type { DiscoveredConnection } from "../../src/discovery/connection-candidates.js";
import type { DatabaseConfig } from "../../src/config/types.js";

const FULL_CONFIG: DatabaseConfig = {
  driver: "mysql",
  host: "dbhost",
  port: 3306,
  name: "loja",
  user: "svc",
  password: "s3cr3t"
};

function discovery(): DiscoveredConnection[] {
  return [
    {
      handle: "conn-0",
      config: FULL_CONFIG,
      descriptor: {
        handle: "conn-0",
        driver: "mysql",
        host: "dbhost",
        port: 3306,
        user: "svc",
        database: "loja",
        source: "config:/etc/app/db.conf",
        label: "mysql @ dbhost:3306 (svc) — config:/etc/app/db.conf"
      }
    }
  ];
}

function buildSession(overrides: Partial<AiSessionDeps> = {}) {
  const emitted: AiSessionOutboundMessage[] = [];
  const deps: AiSessionDeps = {
    handleAdminRequest: vi.fn(async () => {
      throw new Error("admin não deveria ser chamado por estas tools");
    }) as never,
    secrets: () => ["s3cr3t"],
    applyApproval: async () => undefined,
    now: () => "2026-06-09T00:00:00.000Z",
    currentEngine: () => "mysql",
    discoverConnections: vi.fn(async () => discovery()),
    useConnection: vi.fn(async () => ({ ok: true, tablesCount: 7 })),
    ...overrides
  };
  const session = new AiSession({ sessionId: "s1", emit: (m) => emitted.push(m), deps });
  return { session, emitted, deps };
}

describe("connection.discoverCandidates", () => {
  it("retorna a lista REDIGIDA de candidatos (sem senha) e não chama o admin", async () => {
    const { session, emitted, deps } = buildSession();
    await session.invokeTool({ sessionId: "s1", invocationId: "i1", name: "connection.discoverCandidates", input: {} });

    const result = emitted.find((m) => m.type === "tool.result");
    expect(result).toMatchObject({
      invocationId: "i1",
      ok: true,
      payload: { candidates: [discovery()[0].descriptor] }
    });
    expect(JSON.stringify(result)).not.toContain("s3cr3t");
    expect(deps.handleAdminRequest).not.toHaveBeenCalled();
  });

  it("não vaza senha em nenhum lugar do payload", async () => {
    const { session, emitted } = buildSession();
    await session.invokeTool({ sessionId: "s1", invocationId: "i1", name: "connection.discoverCandidates", input: {} });
    const result = emitted.find((m) => m.type === "tool.result") as { payload: { candidates: unknown[] } };
    expect(result.payload.candidates[0]).not.toHaveProperty("password");
    expect(result.payload.candidates[0]).not.toHaveProperty("config");
  });
});

describe("connection.use", () => {
  it("conecta com a config COMPLETA do handle e retorna { ok, tablesCount }", async () => {
    const { session, emitted, deps } = buildSession();
    await session.invokeTool({ sessionId: "s1", invocationId: "i1", name: "connection.discoverCandidates", input: {} });
    await session.invokeTool({ sessionId: "s1", invocationId: "i2", name: "connection.use", input: { handle: "conn-0" } });

    expect(deps.useConnection).toHaveBeenCalledWith(FULL_CONFIG);
    const result = emitted.filter((m) => m.type === "tool.result").at(-1);
    expect(result).toMatchObject({ invocationId: "i2", ok: true, payload: { ok: true, tablesCount: 7 } });
  });

  it("handle inválido → { ok:false, errorCode }", async () => {
    const { session, emitted } = buildSession();
    await session.invokeTool({ sessionId: "s1", invocationId: "i1", name: "connection.discoverCandidates", input: {} });
    await session.invokeTool({ sessionId: "s1", invocationId: "i2", name: "connection.use", input: { handle: "conn-99" } });

    const result = emitted.filter((m) => m.type === "tool.result").at(-1);
    expect(result).toMatchObject({ invocationId: "i2", ok: true, payload: { ok: false, errorCode: "UNKNOWN_HANDLE" } });
  });

  it("falha de conexão → repassa { ok:false, errorCode } do useConnection", async () => {
    const { session, emitted } = buildSession({
      useConnection: vi.fn(async () => ({ ok: false, errorCode: "CONNECTION_FAILED" }))
    });
    await session.invokeTool({ sessionId: "s1", invocationId: "i1", name: "connection.discoverCandidates", input: {} });
    await session.invokeTool({ sessionId: "s1", invocationId: "i2", name: "connection.use", input: { handle: "conn-0" } });

    const result = emitted.filter((m) => m.type === "tool.result").at(-1);
    expect(result).toMatchObject({ invocationId: "i2", ok: true, payload: { ok: false, errorCode: "CONNECTION_FAILED" } });
  });

  it("input sem handle → tool.result ok:false INVALID_INPUT", async () => {
    const { session, emitted } = buildSession();
    await session.invokeTool({ sessionId: "s1", invocationId: "i2", name: "connection.use", input: {} });
    const result = emitted.find((m) => m.type === "tool.result");
    expect(result).toMatchObject({ invocationId: "i2", ok: false, errorCode: "INVALID_INPUT" });
  });
});
