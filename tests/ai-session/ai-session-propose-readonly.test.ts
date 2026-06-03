import { describe, expect, it, vi } from "vitest";
import { AiSession } from "../../src/ai-session/ai-session.js";
import type { AiSessionOutboundMessage } from "../../src/ai-session/ai-session.js";

function buildSession(engine: string) {
  const emitted: AiSessionOutboundMessage[] = [];
  const handleAdminRequest = vi.fn(async () => {
    throw new Error("admin não deveria ser chamado pelo sinal");
  });
  const session = new AiSession({
    sessionId: "s1",
    emit: (m) => emitted.push(m),
    deps: {
      handleAdminRequest: handleAdminRequest as never,
      secrets: () => [],
      applyApproval: async () => undefined,
      now: () => "2026-06-03T00:00:00.000Z",
      currentEngine: () => engine
    }
  });
  return { session, emitted, handleAdminRequest };
}

describe("AiSession propose_readonly_user", () => {
  it("aceita username válido, devolve engine e NÃO chama o admin", async () => {
    const { session, emitted, handleAdminRequest } = buildSession("mysql");
    await session.invokeTool({ sessionId: "s1", invocationId: "i1", name: "propose_readonly_user", input: { username: "pharma_connector_ro" } });

    const result = emitted.find((m) => m.type === "tool.result");
    expect(result).toMatchObject({
      type: "tool.result",
      invocationId: "i1",
      ok: true,
      payload: { accepted: true, username: "pharma_connector_ro", engine: "mysql" }
    });
    expect(handleAdminRequest).not.toHaveBeenCalled();
  });

  it("rejeita username inválido com tool.result ok:false", async () => {
    const { session, emitted } = buildSession("postgresql");
    await session.invokeTool({ sessionId: "s1", invocationId: "i2", name: "propose_readonly_user", input: { username: "1bad name!" } });

    const result = emitted.find((m) => m.type === "tool.result");
    expect(result).toMatchObject({ type: "tool.result", invocationId: "i2", ok: false, errorCode: "INVALID_INPUT" });
  });
});
