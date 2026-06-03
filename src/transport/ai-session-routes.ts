import { ProtocolParseError } from "./protocol.js";
import { registerExtensionRoute, type ExtensionRouteDispatchResult } from "./server-message-router.js";
import {
  AI_SESSION_START_TYPE, TOOL_INVOKE_TYPE, MAPPING_DECISION_TYPE, AI_SESSION_ABORT_TYPE,
  parseAiSessionStart, parseToolInvoke, parseMappingDecision, parseAiSessionAbort
} from "../ai-session/ai-protocol.js";

function asRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") return JSON.parse(raw) as Record<string, unknown>;
  if (Buffer.isBuffer(raw)) return JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  if (Array.isArray(raw)) return JSON.parse(Buffer.concat(raw as Buffer[]).toString("utf8")) as Record<string, unknown>;
  if (raw instanceof ArrayBuffer) return JSON.parse(Buffer.from(new Uint8Array(raw)).toString("utf8")) as Record<string, unknown>;
  return JSON.parse(Buffer.from(raw as Buffer).toString("utf8")) as Record<string, unknown>;
}

function guard(fn: () => ExtensionRouteDispatchResult, label: string): ExtensionRouteDispatchResult {
  try {
    return fn();
  } catch (error) {
    return { kind: "malformed", error: error instanceof Error ? error : new ProtocolParseError(`Invalid ${label} command`) };
  }
}

registerExtensionRoute(AI_SESSION_START_TYPE, (_env, raw) =>
  guard(() => ({ kind: "aiSessionStart", command: parseAiSessionStart(asRecord(raw)) }), AI_SESSION_START_TYPE)
);
registerExtensionRoute(TOOL_INVOKE_TYPE, (_env, raw) =>
  guard(() => ({ kind: "aiToolInvoke", command: parseToolInvoke(asRecord(raw)) }), TOOL_INVOKE_TYPE)
);
registerExtensionRoute(MAPPING_DECISION_TYPE, (_env, raw) =>
  guard(() => ({ kind: "aiMappingDecision", command: parseMappingDecision(asRecord(raw)) }), MAPPING_DECISION_TYPE)
);
registerExtensionRoute(AI_SESSION_ABORT_TYPE, (_env, raw) =>
  guard(() => ({ kind: "aiSessionAbort", command: parseAiSessionAbort(asRecord(raw)) }), AI_SESSION_ABORT_TYPE)
);
