import { describe, expect, it, vi } from "vitest";
import { AiSession, type AiSessionDeps, type AiSessionOutboundMessage } from "../../src/ai-session/ai-session.js";
import type { DatabaseConfig } from "../../src/config/types.js";

const PARAMS = {
  driver: "mysql",
  host: "dbhost",
  port: 3306,
  user: "svc",
  password: "s3cr3t",
  database: "loja"
};

const EXPECTED_CONFIG: DatabaseConfig = {
  driver: "mysql",
  host: "dbhost",
  port: 3306,
  name: "loja",
  user: "svc",
  password: "s3cr3t"
};

function buildSession(overrides: Partial<AiSessionDeps> = {}) {
  const emitted: AiSessionOutboundMessage[] = [];
  const deps: AiSessionDeps = {
    handleAdminRequest: vi.fn(async () => {
      throw new Error("admin não deveria ser chamado por db.connect");
    }) as never,
    secrets: () => ["s3cr3t"],
    applyApproval: async () => undefined,
    now: () => "2026-06-09T00:00:00.000Z",
    currentEngine: () => "mysql",
    connectDatabase: vi.fn(async () => ({ ok: true, tablesCount: 7 })),
    ...overrides
  };
  const session = new AiSession({ sessionId: "s1", emit: (m) => emitted.push(m), deps });
  return { session, emitted, deps };
}

describe("db.connect", () => {
  it("conecta com os params completos e retorna { ok, tablesCount }", async () => {
    const { session, emitted, deps } = buildSession();
    await session.invokeTool({ sessionId: "s1", invocationId: "i1", name: "db.connect", input: PARAMS });

    expect(deps.connectDatabase).toHaveBeenCalledWith(EXPECTED_CONFIG);
    const result = emitted.filter((m) => m.type === "tool.result").at(-1);
    expect(result).toMatchObject({ invocationId: "i1", ok: true, payload: { ok: true, tablesCount: 7 } });
  });

  it("port é opcional", async () => {
    const { session, deps } = buildSession();
    const { port, ...noPort } = PARAMS;
    await session.invokeTool({ sessionId: "s1", invocationId: "i1", name: "db.connect", input: noPort });
    expect(deps.connectDatabase).toHaveBeenCalledWith(expect.objectContaining({ driver: "mysql", host: "dbhost", name: "loja", user: "svc", password: "s3cr3t" }));
  });

  it("não vaza a senha no payload/result", async () => {
    const { session, emitted } = buildSession();
    await session.invokeTool({ sessionId: "s1", invocationId: "i1", name: "db.connect", input: PARAMS });
    const result = emitted.filter((m) => m.type === "tool.result").at(-1);
    expect(JSON.stringify(result)).not.toContain("s3cr3t");
  });

  it("falha de conexão → repassa { ok:false, errorCode }", async () => {
    const { session, emitted } = buildSession({
      connectDatabase: vi.fn(async () => ({ ok: false, errorCode: "CONNECTION_FAILED" }))
    });
    await session.invokeTool({ sessionId: "s1", invocationId: "i1", name: "db.connect", input: PARAMS });
    const result = emitted.filter((m) => m.type === "tool.result").at(-1);
    expect(result).toMatchObject({ invocationId: "i1", ok: true, payload: { ok: false, errorCode: "CONNECTION_FAILED" } });
  });

  it("params incompletos (sem driver/host/user/password/database) → INVALID_INPUT", async () => {
    const { session, emitted, deps } = buildSession();
    await session.invokeTool({ sessionId: "s1", invocationId: "i1", name: "db.connect", input: { driver: "mysql", host: "h" } });
    const result = emitted.find((m) => m.type === "tool.result");
    expect(result).toMatchObject({ invocationId: "i1", ok: false, errorCode: "INVALID_INPUT" });
    expect(deps.connectDatabase).not.toHaveBeenCalled();
  });
});
