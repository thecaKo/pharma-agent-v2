import { describe, expect, it, vi } from "vitest";
import { AiSessionManager } from "../../src/service/ai-session-manager.js";
import { buildAdminSuccessResponseMessage } from "../../src/transport/protocol.js";

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
});
