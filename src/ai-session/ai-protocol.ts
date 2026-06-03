import { ProtocolParseError } from "../transport/protocol.js";
import type { ValidatedMappingConfig, MappingConfig } from "../mapping/types.js";

export const AI_SESSION_START_TYPE = "ai.session.start";
export const TOOL_INVOKE_TYPE = "tool.invoke";
export const MAPPING_DECISION_TYPE = "mapping.decision";
export const AI_SESSION_ABORT_TYPE = "ai.session.abort";

export type AiSessionPhase =
  | "discovering" | "credentials" | "schema" | "proposing"
  | "applying" | "synced" | "failed" | "aborted";

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: object;
  outputSchema: object;
}

export interface AiSessionStartCommand { sessionId: string; sentAt?: string; }
export interface ToolInvokeCommand { sessionId: string; invocationId: string; name: string; input?: unknown; sentAt?: string; }
export interface MappingDecisionCommand { sessionId: string; decision: "approve" | "reject"; editedMapping?: MappingConfig; sentAt?: string; }
export interface AiSessionAbortCommand { sessionId: string; reason: string; sentAt?: string; }

export interface AiCatalogMessage { type: "ai.catalog"; sessionId: string; catalogVersion: string; tools: ToolDescriptor[]; sentAt: string; }
export interface ToolResultMessage { type: "tool.result"; sessionId: string; invocationId: string; ok: boolean; payload?: unknown; errorCode?: string; sentAt: string; }
export interface AuditEventMessage { type: "audit.event"; sessionId: string; seq: number; at: string; kind: string; tool?: string; summary: string; detail?: unknown; }
export interface MappingProposedMessage { type: "mapping.proposed"; sessionId: string; mapping: ValidatedMappingConfig; rationale: string; previewRows: unknown[]; sentAt: string; }
export interface AiSessionStateMessage { type: "ai.session.state"; sessionId: string; phase: AiSessionPhase; detail?: string; sentAt: string; }

const PHASES: ReadonlySet<AiSessionPhase> = new Set([
  "discovering", "credentials", "schema", "proposing", "applying", "synced", "failed", "aborted"
]);

export function parseAiSessionStart(message: Record<string, unknown>): AiSessionStartCommand {
  return { sessionId: str(message.sessionId, "sessionId"), ...optStr(message.sentAt, "sentAt") };
}

export function parseToolInvoke(message: Record<string, unknown>): ToolInvokeCommand {
  const base: ToolInvokeCommand = {
    sessionId: str(message.sessionId, "sessionId"),
    invocationId: str(message.invocationId, "invocationId"),
    name: str(message.name, "name"),
    ...optStr(message.sentAt, "sentAt")
  };
  if (message.input !== undefined) base.input = message.input;
  return base;
}

export function parseMappingDecision(message: Record<string, unknown>): MappingDecisionCommand {
  const decision = str(message.decision, "decision");
  if (decision !== "approve" && decision !== "reject") {
    throw new ProtocolParseError(`decision must be approve or reject, got ${decision}`);
  }
  const base: MappingDecisionCommand = { sessionId: str(message.sessionId, "sessionId"), decision, ...optStr(message.sentAt, "sentAt") };
  if (message.editedMapping !== undefined) {
    if (typeof message.editedMapping !== "object" || message.editedMapping === null) {
      throw new ProtocolParseError("editedMapping must be an object");
    }
    base.editedMapping = message.editedMapping as MappingConfig;
  }
  return base;
}

export function parseAiSessionAbort(message: Record<string, unknown>): AiSessionAbortCommand {
  return { sessionId: str(message.sessionId, "sessionId"), reason: str(message.reason, "reason"), ...optStr(message.sentAt, "sentAt") };
}

export function buildAiCatalogMessage(
  input: { sessionId: string; catalogVersion: string; tools: ToolDescriptor[] },
  sentAt = new Date().toISOString()
): AiCatalogMessage {
  return { type: "ai.catalog", sessionId: input.sessionId, catalogVersion: input.catalogVersion, tools: input.tools, sentAt };
}

export function buildToolResultMessage(
  input: { sessionId: string; invocationId: string; ok: boolean; payload?: unknown; errorCode?: string },
  sentAt = new Date().toISOString()
): ToolResultMessage {
  const msg: ToolResultMessage = { type: "tool.result", sessionId: input.sessionId, invocationId: input.invocationId, ok: input.ok, sentAt };
  if (input.payload !== undefined) msg.payload = input.payload;
  if (input.errorCode !== undefined) msg.errorCode = input.errorCode;
  return msg;
}

export function buildAuditEventMessage(
  input: { sessionId: string; seq: number; kind: string; tool?: string; summary: string; detail?: unknown },
  at = new Date().toISOString()
): AuditEventMessage {
  const msg: AuditEventMessage = { type: "audit.event", sessionId: input.sessionId, seq: input.seq, at, kind: input.kind, summary: input.summary };
  if (input.tool !== undefined) msg.tool = input.tool;
  if (input.detail !== undefined) msg.detail = input.detail;
  return msg;
}

export function buildMappingProposedMessage(
  input: { sessionId: string; mapping: ValidatedMappingConfig; rationale: string; previewRows: unknown[] },
  sentAt = new Date().toISOString()
): MappingProposedMessage {
  return { type: "mapping.proposed", sessionId: input.sessionId, mapping: input.mapping, rationale: input.rationale, previewRows: input.previewRows, sentAt };
}

export function buildAiSessionStateMessage(
  input: { sessionId: string; phase: AiSessionPhase; detail?: string },
  sentAt = new Date().toISOString()
): AiSessionStateMessage {
  if (!PHASES.has(input.phase)) throw new ProtocolParseError(`invalid phase: ${input.phase}`);
  const msg: AiSessionStateMessage = { type: "ai.session.state", sessionId: input.sessionId, phase: input.phase, sentAt };
  if (input.detail !== undefined) msg.detail = input.detail;
  return msg;
}

function str(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProtocolParseError(`${field} must be a non-empty string`);
  }
  return value;
}

function optStr(value: unknown, field: string): { sentAt?: string } {
  if (value === undefined) return {};
  return { sentAt: str(value, field) };
}
