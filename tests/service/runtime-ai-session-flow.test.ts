import { describe, expect, it, vi } from "vitest";
import { AiSessionManager } from "../../src/service/ai-session-manager.js";
import { buildAdminSuccessResponseMessage } from "../../src/transport/protocol.js";

const validMapping = {
  mappingVersion: "mapping-v1",
  syncMode: "snapshot" as const,
  selectedProductTable: "products",
  pollIntervalMs: 10_000,
  batchSize: 500,
  snapshotQuery: "select * from products order by product_id limit ? offset ?",
  snapshotPageSize: 500,
  fields: { sourceProductCode: "product_id", name: "description" }
};

describe("AiSessionManager", () => {
  function makeManager() {
    const sent: any[] = [];
    const manager = new AiSessionManager({
      emit: (msg) => sent.push(msg),
      buildDeps: () => ({
        handleAdminRequest: async (req) => buildAdminSuccessResponseMessage({ requestId: req.requestId, command: req.command, payload: { tables: ["produtos"] } }),
        secrets: () => [],
        now: () => "t",
        applyApproval: vi.fn(async () => undefined)
      })
    });
    return { sent, manager };
  }

  it("start cria sessão e emite ai.catalog", async () => {
    const { sent, manager } = makeManager();
    await manager.onStart({ sessionId: "s1" });
    expect(sent.some((m) => m.type === "ai.catalog")).toBe(true);
  });

  it("tool.invoke é roteado para a sessão correta", async () => {
    const { sent, manager } = makeManager();
    await manager.onStart({ sessionId: "s1" });
    await manager.onToolInvoke({ sessionId: "s1", invocationId: "i1", name: "schema.listTables", input: {} });
    expect(sent.some((m) => m.type === "tool.result" && m.invocationId === "i1")).toBe(true);
  });

  it("tool.invoke de sessão desconhecida é ignorado", async () => {
    const { sent, manager } = makeManager();
    await manager.onToolInvoke({ sessionId: "zzz", invocationId: "i1", name: "schema.listTables", input: {} });
    expect(sent.filter((m) => m.type === "tool.result")).toHaveLength(0);
  });

  it("abort encerra a sessão", async () => {
    const { sent, manager } = makeManager();
    await manager.onStart({ sessionId: "s1" });
    manager.onAbort({ sessionId: "s1", reason: "user" });
    const state = sent.filter((m) => m.type === "ai.session.state").pop();
    expect(state.phase).toBe("aborted");
  });

  it("após synced a sessão é removida do Map (não roteia mais comandos)", async () => {
    const { sent, manager } = makeManager();
    await manager.onStart({ sessionId: "s1" });
    await manager.onDecision({ sessionId: "s1", decision: "approve", editedMapping: validMapping });
    const state = sent.filter((m) => m.type === "ai.session.state").pop();
    expect(state.phase).toBe("synced");
    // sessão removida: tool.invoke posterior é ignorado (sessão desconhecida)
    sent.length = 0;
    await manager.onToolInvoke({ sessionId: "s1", invocationId: "after", name: "schema.listTables", input: {} });
    expect(sent.filter((m) => m.type === "tool.result")).toHaveLength(0);
  });

  it("após failed a sessão é removida do Map (não roteia mais comandos)", async () => {
    const sent: any[] = [];
    const failingApproval = vi.fn(async () => { throw new Error("boom"); });
    const manager = new AiSessionManager({
      emit: (msg) => sent.push(msg),
      buildDeps: () => ({
        handleAdminRequest: async (req) => buildAdminSuccessResponseMessage({ requestId: req.requestId, command: req.command, payload: {} }),
        secrets: () => [],
        now: () => "t",
        applyApproval: failingApproval
      })
    });
    await manager.onStart({ sessionId: "s1" });
    // applyApproval lança → a sessão emite ai.session.state failed
    await manager.onDecision({ sessionId: "s1", decision: "approve", editedMapping: validMapping });
    const state = sent.filter((m) => m.type === "ai.session.state").pop();
    expect(state.phase).toBe("failed");
    expect(failingApproval).toHaveBeenCalledTimes(1);
    // o manager remove a sessão ao observar o estado terminal "failed"
    sent.length = 0;
    await manager.onToolInvoke({ sessionId: "s1", invocationId: "after", name: "schema.listTables", input: {} });
    expect(sent.filter((m) => m.type === "tool.result")).toHaveLength(0);
  });
});
