import { describe, expect, it } from "vitest";
import {
  parseServerMessageEnvelope, dispatchExtensionMessage, isDocumentedExtensionMessageType
} from "../../src/transport/server-message-router.js";
import "../../src/transport/ai-session-routes.js";
import {
  AI_SESSION_START_TYPE, TOOL_INVOKE_TYPE, MAPPING_DECISION_TYPE, AI_SESSION_ABORT_TYPE
} from "../../src/ai-session/ai-protocol.js";

function envelope(payload: object) {
  const raw = Buffer.from(JSON.stringify(payload));
  const parsed = parseServerMessageEnvelope(raw);
  if (parsed.classification === "malformed") throw parsed.error;
  return { env: parsed.envelope, raw };
}

describe("ai-session-routes", () => {
  it("classifica os 4 tipos como extension documentado", () => {
    for (const t of [AI_SESSION_START_TYPE, TOOL_INVOKE_TYPE, MAPPING_DECISION_TYPE, AI_SESSION_ABORT_TYPE]) {
      expect(isDocumentedExtensionMessageType(t)).toBe(true);
    }
  });

  it("ai.session.start despacha aiSessionStart", () => {
    const { env, raw } = envelope({ type: AI_SESSION_START_TYPE, sessionId: "s1" });
    const r = dispatchExtensionMessage(env, raw);
    expect(r.kind).toBe("aiSessionStart");
  });

  it("tool.invoke despacha aiToolInvoke", () => {
    const { env, raw } = envelope({ type: TOOL_INVOKE_TYPE, sessionId: "s1", invocationId: "i1", name: "schema.listTables", input: {} });
    const r = dispatchExtensionMessage(env, raw);
    expect(r.kind).toBe("aiToolInvoke");
  });

  it("mapping.decision malformado vira malformed", () => {
    const { env, raw } = envelope({ type: MAPPING_DECISION_TYPE, sessionId: "s1", decision: "talvez" });
    const r = dispatchExtensionMessage(env, raw);
    expect(r.kind).toBe("malformed");
  });

  it("ai.session.abort despacha aiSessionAbort", () => {
    const { env, raw } = envelope({ type: AI_SESSION_ABORT_TYPE, sessionId: "s1", reason: "user" });
    const r = dispatchExtensionMessage(env, raw);
    expect(r.kind).toBe("aiSessionAbort");
  });
});
