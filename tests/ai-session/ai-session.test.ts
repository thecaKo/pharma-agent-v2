import { describe, expect, it, vi } from "vitest";
import { AiSession, type AiSessionEmit, type AiSessionDeps } from "../../src/ai-session/ai-session.js";
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
    expect(sent.find((m) => m.type === "ai.catalog").tools).toHaveLength(14);
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
