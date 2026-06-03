import { describe, expect, it } from "vitest";
import {
  AI_SESSION_START_TYPE, TOOL_INVOKE_TYPE, MAPPING_DECISION_TYPE, AI_SESSION_ABORT_TYPE,
  parseAiSessionStart, parseToolInvoke, parseMappingDecision, parseAiSessionAbort,
  buildAiCatalogMessage, buildToolResultMessage, buildAuditEventMessage,
  buildMappingProposedMessage, buildAiSessionStateMessage
} from "../../src/ai-session/ai-protocol.js";
import type { ValidatedMappingConfig } from "../../src/mapping/types.js";

const mapping: ValidatedMappingConfig = {
  mappingVersion: "v1", syncMode: "snapshot", pollIntervalMs: 60000, batchSize: 500,
  snapshotQuery: "SELECT 1", snapshotPageSize: 500,
  fields: { sourceProductCode: "codigo", name: "nome" }
};

describe("ai-protocol — parse (servidor→agente)", () => {
  it("parseAiSessionStart", () => {
    const r = parseAiSessionStart({ type: AI_SESSION_START_TYPE, sessionId: "s1" });
    expect(r).toMatchObject({ sessionId: "s1" });
  });

  it("parseToolInvoke exige name e invocationId", () => {
    const r = parseToolInvoke({ type: TOOL_INVOKE_TYPE, sessionId: "s1", invocationId: "i1", name: "schema.listTables", input: {} });
    expect(r).toMatchObject({ sessionId: "s1", invocationId: "i1", name: "schema.listTables" });
    expect(() => parseToolInvoke({ type: TOOL_INVOKE_TYPE, sessionId: "s1" })).toThrow();
  });

  it("parseMappingDecision aceita approve/reject", () => {
    expect(parseMappingDecision({ type: MAPPING_DECISION_TYPE, sessionId: "s1", decision: "approve" }).decision).toBe("approve");
    expect(parseMappingDecision({ type: MAPPING_DECISION_TYPE, sessionId: "s1", decision: "reject" }).decision).toBe("reject");
    expect(() => parseMappingDecision({ type: MAPPING_DECISION_TYPE, sessionId: "s1", decision: "maybe" })).toThrow();
  });

  it("parseAiSessionAbort exige reason", () => {
    expect(parseAiSessionAbort({ type: AI_SESSION_ABORT_TYPE, sessionId: "s1", reason: "user" }).reason).toBe("user");
  });
});

describe("ai-protocol — build (agente→servidor) roundtrip", () => {
  it("ai.catalog roundtrip", () => {
    const msg = buildAiCatalogMessage({ sessionId: "s1", catalogVersion: "1", tools: [{ name: "schema.listTables", description: "d", inputSchema: {}, outputSchema: {} }] });
    const back = JSON.parse(JSON.stringify(msg));
    expect(back.type).toBe("ai.catalog");
    expect(back.tools).toHaveLength(1);
    expect(typeof back.sentAt).toBe("string");
  });

  it("tool.result correlaciona invocationId", () => {
    const msg = buildToolResultMessage({ sessionId: "s1", invocationId: "i7", ok: true, payload: { rows: [] } });
    expect(msg.invocationId).toBe("i7");
    expect(msg.ok).toBe(true);
  });

  it("tool.result erro carrega errorCode", () => {
    const msg = buildToolResultMessage({ sessionId: "s1", invocationId: "i7", ok: false, errorCode: "auth" });
    expect(msg.ok).toBe(false);
    expect(msg.errorCode).toBe("auth");
  });

  it("audit.event preserva seq", () => {
    const a = buildAuditEventMessage({ sessionId: "s1", seq: 1, kind: "tool.invoke", tool: "schema.listTables", summary: "lista tabelas" });
    const b = buildAuditEventMessage({ sessionId: "s1", seq: 2, kind: "tool.result", summary: "ok" });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(typeof a.at).toBe("string");
  });

  it("mapping.proposed transporta mapping validado", () => {
    const msg = buildMappingProposedMessage({ sessionId: "s1", mapping, rationale: "join", previewRows: [{ codigo: "P1" }] });
    expect(msg.mapping.mappingVersion).toBe("v1");
    expect(msg.previewRows).toEqual([{ codigo: "P1" }]);
  });

  it("ai.session.state aceita fases válidas", () => {
    const msg = buildAiSessionStateMessage({ sessionId: "s1", phase: "discovering" });
    expect(msg.phase).toBe("discovering");
  });
});
