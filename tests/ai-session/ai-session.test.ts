import { describe, expect, it, vi } from "vitest";
import { AiSession, type AiSessionEmit, type AiSessionDeps } from "../../src/ai-session/ai-session.js";
import type { Logger } from "../../src/logging/logger.js";
import { buildAdminSuccessResponseMessage } from "../../src/transport/protocol.js";
import type { ValidatedMappingConfig } from "../../src/mapping/types.js";

const SECRET = "super-secret-pw";

function collector() {
  const sent: any[] = [];
  const emit: AiSessionEmit = (msg) => { sent.push(msg); };
  return { sent, emit };
}

function depsWith(over: Partial<AiSessionDeps> = {}): AiSessionDeps {
  return {
    handleAdminRequest: vi.fn(async (req) =>
      buildAdminSuccessResponseMessage({ requestId: req.requestId, command: req.command, payload: { tables: ["produtos"] } })
    ),
    secrets: () => [SECRET],
    applyApproval: vi.fn(async () => undefined),
    now: () => "2026-06-03T00:00:00.000Z",
    ...over
  };
}

const mapping: ValidatedMappingConfig = {
  mappingVersion: "v1", syncMode: "snapshot", pollIntervalMs: 60000, batchSize: 500,
  snapshotQuery: "SELECT 1", snapshotPageSize: 500, fields: { sourceProductCode: "codigo", name: "nome" }
};

describe("AiSession", () => {
  it("ao start emite ai.catalog e ai.session.state discovering", async () => {
    const { sent, emit } = collector();
    const session = new AiSession({ sessionId: "s1", emit, deps: depsWith() });
    await session.start();
    const types = sent.map((m) => m.type);
    expect(types).toContain("ai.catalog");
    expect(types).toContain("ai.session.state");
    expect(sent.find((m) => m.type === "ai.catalog").tools).toHaveLength(19);
  });

  it("tool.invoke emite tool.result e audit.event com seq incremental", async () => {
    const { sent, emit } = collector();
    const session = new AiSession({ sessionId: "s1", emit, deps: depsWith() });
    await session.start();
    await session.invokeTool({ sessionId: "s1", invocationId: "i1", name: "schema.listTables", input: {} });
    const result = sent.find((m) => m.type === "tool.result");
    expect(result).toMatchObject({ invocationId: "i1", ok: true });
    const audits = sent.filter((m) => m.type === "audit.event").map((m) => m.seq);
    expect(audits).toEqual([...audits].sort((a, b) => a - b));
    expect(new Set(audits).size).toBe(audits.length);
  });

  it("rejeita ferramenta fora do catálogo com errorCode INVALID_INPUT", async () => {
    const { sent, emit } = collector();
    const session = new AiSession({ sessionId: "s1", emit, deps: depsWith() });
    await session.start();
    await session.invokeTool({ sessionId: "s1", invocationId: "ix", name: "fs.writeFile", input: {} });
    const result = sent.find((m) => m.type === "tool.result" && m.invocationId === "ix");
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("INVALID_INPUT");
  });

  it("REDAÇÃO: segredo nunca sai cru em tool.result nem audit.event", async () => {
    const deps = depsWith({
      handleAdminRequest: vi.fn(async (req) =>
        buildAdminSuccessResponseMessage({ requestId: req.requestId, command: req.command, payload: { content: `pwd=${SECRET}`, password: SECRET } })
      )
    });
    const { sent, emit } = collector();
    const session = new AiSession({ sessionId: "s1", emit, deps });
    await session.start();
    await session.invokeTool({ sessionId: "s1", invocationId: "i1", name: "fs.readConfigFile", input: { path: "C:\\x.ini" } });
    const serialized = JSON.stringify(sent);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain("[REDACTED]");
    // nenhum audit.event nem tool.result contém o segredo cru em qualquer nível
    expect(
      sent
        .filter((m) => ["audit.event", "tool.result"].includes(m.type))
        .every((m) => !JSON.stringify(m).includes(SECRET))
    ).toBe(true);
    // e [REDACTED] aparece onde o segredo estava (no tool.result do payload)
    const toolResult = sent.find((m) => m.type === "tool.result" && m.invocationId === "i1");
    expect(JSON.stringify(toolResult)).toContain("[REDACTED]");
  });

  it("ignora invocationId repetido (idempotência)", async () => {
    const deps = depsWith();
    const { sent, emit } = collector();
    const session = new AiSession({ sessionId: "s1", emit, deps });
    await session.start();
    await session.invokeTool({ sessionId: "s1", invocationId: "i1", name: "schema.listTables", input: {} });
    await session.invokeTool({ sessionId: "s1", invocationId: "i1", name: "schema.listTables", input: {} });
    expect(sent.filter((m) => m.type === "tool.result" && m.invocationId === "i1")).toHaveLength(1);
    expect(deps.handleAdminRequest).toHaveBeenCalledTimes(1);
  });

  it("abort emite ai.session.state aborted e aborta o signal", async () => {
    const { sent, emit } = collector();
    const session = new AiSession({ sessionId: "s1", emit, deps: depsWith() });
    await session.start();
    session.abort("user");
    const state = sent.filter((m) => m.type === "ai.session.state").pop();
    expect(state.phase).toBe("aborted");
    expect(session.signal.aborted).toBe(true);
  });

  it("após abort, invokeTool é silenciosamente ignorado", async () => {
    const deps = depsWith();
    const { sent, emit } = collector();
    const session = new AiSession({ sessionId: "s1", emit, deps });
    await session.start();
    session.abort("user");
    sent.length = 0;
    await session.invokeTool({ sessionId: "s1", invocationId: "i1", name: "schema.listTables", input: {} });
    expect(sent.filter((m) => m.type === "tool.result")).toHaveLength(0);
    expect(deps.handleAdminRequest).not.toHaveBeenCalled();
  });

  it("após abort, handleDecision(approve) é ignorado", async () => {
    const deps = depsWith();
    const { emit } = collector();
    const session = new AiSession({ sessionId: "s1", emit, deps });
    await session.start();
    session.setProposedMapping(mapping);
    session.abort("user");
    await session.handleDecision({ sessionId: "s1", decision: "approve" });
    expect(deps.applyApproval).not.toHaveBeenCalled();
  });

  it("approve chama applyApproval com mapping validado e transiciona para synced", async () => {
    const deps = depsWith();
    const { sent, emit } = collector();
    const session = new AiSession({ sessionId: "s1", emit, deps });
    await session.start();
    session.setProposedMapping(mapping);
    await session.handleDecision({ sessionId: "s1", decision: "approve" });
    expect(deps.applyApproval).toHaveBeenCalledWith(mapping);
    const state = sent.filter((m) => m.type === "ai.session.state").pop();
    expect(state.phase).toBe("synced");
  });

  it("reject transiciona para proposing sem aplicar", async () => {
    const deps = depsWith();
    const { sent, emit } = collector();
    const session = new AiSession({ sessionId: "s1", emit, deps });
    await session.start();
    session.setProposedMapping(mapping);
    await session.handleDecision({ sessionId: "s1", decision: "reject" });
    expect(deps.applyApproval).not.toHaveBeenCalled();
    const state = sent.filter((m) => m.type === "ai.session.state").pop();
    expect(state.phase).toBe("proposing");
  });

  it("quando handleAdminRequest rejeita, emite tool.result ok:false INTERNAL_ERROR", async () => {
    const deps = depsWith({
      handleAdminRequest: vi.fn(async () => { throw new Error("boom"); })
    });
    const { sent, emit } = collector();
    const session = new AiSession({ sessionId: "s1", emit, deps });
    await session.start();
    await session.invokeTool({ sessionId: "s1", invocationId: "i1", name: "schema.listTables", input: {} });
    const result = sent.find((m) => m.type === "tool.result" && m.invocationId === "i1");
    expect(result).toBeDefined();
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("INTERNAL_ERROR");
    const errAudit = sent.filter((m) => m.type === "audit.event").pop();
    expect(errAudit.kind).toBe("tool.result");
  });

  it("quando handleAdminRequest nunca resolve, emite tool.result ok:false TOOL_TIMEOUT após o timeout", async () => {
    vi.useFakeTimers();
    try {
      const deps = depsWith({
        handleAdminRequest: vi.fn(() => new Promise<never>(() => { /* nunca resolve */ }))
      });
      const { sent, emit } = collector();
      const session = new AiSession({ sessionId: "s1", emit, deps });
      await session.start();
      const promise = session.invokeTool({ sessionId: "s1", invocationId: "i1", name: "schema.listTables", input: {} });
      await vi.advanceTimersByTimeAsync(26000);
      await promise;
      const result = sent.find((m) => m.type === "tool.result" && m.invocationId === "i1");
      expect(result).toBeDefined();
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("TOOL_TIMEOUT");
    } finally {
      vi.useRealTimers();
    }
  });

  it("OBSERVABILIDADE: loga start, tool_invoke (input redigido), tool_result (com resumo) e transition", async () => {
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { emit } = collector();
    const session = new AiSession({ sessionId: "s1", emit, deps: depsWith({ logger }) });
    await session.start();
    await session.invokeTool({ sessionId: "s1", invocationId: "i1", name: "schema.listTables", input: {} });

    const calls = (logger.info as any).mock.calls as Array<[string, Record<string, unknown>]>;
    const actions = calls.map(([action]) => action);
    expect(actions).toContain("ai_session.start");
    expect(actions).toContain("ai_session.tool_invoke");
    expect(actions).toContain("ai_session.tool_result");
    expect(actions).toContain("ai_session.transition");

    const invoke = calls.find(([a]) => a === "ai_session.tool_invoke")?.[1];
    expect(invoke).toMatchObject({ sessionId: "s1", invocationId: "i1", name: "schema.listTables" });

    // tool_result loga ok + RESUMO (contagem de tabelas), nunca os valores
    const result = calls.find(([a]) => a === "ai_session.tool_result")?.[1];
    expect(result).toMatchObject({ invocationId: "i1", name: "schema.listTables", ok: true });
    expect((result as any).summary).toMatchObject({ tablesCount: 1 });
    expect(JSON.stringify((result as any).summary)).not.toContain("produtos");
  });

  it("OBSERVABILIDADE: input logado em tool_invoke nunca contém o segredo cru", async () => {
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { emit } = collector();
    const session = new AiSession({ sessionId: "s1", emit, deps: depsWith({ logger }) });
    await session.start();
    await session.invokeTool({
      sessionId: "s1", invocationId: "i1", name: "probe.test_connection",
      input: { driver: "mssql", password: SECRET, dsn: `Server=x;Pwd=${SECRET}` }
    });
    const calls = (logger.info as any).mock.calls as Array<[string, Record<string, unknown>]>;
    const invoke = calls.find(([a]) => a === "ai_session.tool_invoke")?.[1];
    expect(JSON.stringify(invoke)).not.toContain(SECRET);
    expect(JSON.stringify(invoke)).toContain("[REDACTED]");
  });

  it("OBSERVABILIDADE: loga mapping_decision e abort", async () => {
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { emit } = collector();
    const session = new AiSession({ sessionId: "s1", emit, deps: depsWith({ logger }) });
    await session.start();
    session.setProposedMapping(mapping);
    await session.handleDecision({ sessionId: "s1", decision: "approve" });
    const calls = (logger.info as any).mock.calls as Array<[string, Record<string, unknown>]>;
    const decision = calls.find(([a]) => a === "ai_session.mapping_decision")?.[1];
    expect(decision).toMatchObject({ decision: "approve" });

    const session2 = new AiSession({ sessionId: "s2", emit, deps: depsWith({ logger }) });
    await session2.start();
    session2.abort("user");
    const calls2 = (logger.info as any).mock.calls as Array<[string, Record<string, unknown>]>;
    const abort = calls2.find(([a]) => a === "ai_session.abort")?.[1];
    expect(abort).toMatchObject({ sessionId: "s2", reason: "user" });
  });

  it("propõe via proposeMapping com previewRows redigidas", async () => {
    const { sent, emit } = collector();
    const session = new AiSession({ sessionId: "s1", emit, deps: depsWith() });
    await session.start();
    session.proposeMapping({ mapping, rationale: "join", previewRows: [{ codigo: "P1", password: SECRET }] });
    const proposed = sent.find((m) => m.type === "mapping.proposed");
    expect(JSON.stringify(proposed)).not.toContain(SECRET);
    expect(proposed.mapping.mappingVersion).toBe("v1");
  });
});
