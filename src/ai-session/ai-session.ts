import { buildAdminRequestMessage, type AdminResponseMessage } from "../transport/protocol.js";
import { redactValue } from "../logging/redact.js";
import { validateMappingConfig } from "../mapping/validate.js";
import type { ValidatedMappingConfig, MappingConfig } from "../mapping/types.js";
import {
  buildAiCatalogMessage, buildToolResultMessage, buildAuditEventMessage,
  buildMappingProposedMessage, buildAiSessionStateMessage,
  type AiSessionPhase, type ToolInvokeCommand, type MappingDecisionCommand,
  type AiCatalogMessage, type ToolResultMessage, type AuditEventMessage,
  type MappingProposedMessage, type AiSessionStateMessage
} from "./ai-protocol.js";
import { buildToolCatalog, CATALOG_VERSION, toolNameToAdminCommand, PROPOSE_READONLY_USER_TOOL } from "./tool-catalog.js";

const READONLY_USERNAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{2,62}$/;

export type AiSessionOutboundMessage =
  | AiCatalogMessage | ToolResultMessage | AuditEventMessage
  | MappingProposedMessage | AiSessionStateMessage;

export type AiSessionEmit = (message: AiSessionOutboundMessage) => void;

export interface AiSessionDeps {
  handleAdminRequest: (req: ReturnType<typeof buildAdminRequestMessage> & { input?: unknown }) => Promise<AdminResponseMessage>;
  secrets: () => readonly string[];
  applyApproval: (mapping: ValidatedMappingConfig) => Promise<void>;
  now: () => string;
  currentEngine: () => string;
}

export interface AiSessionOptions {
  sessionId: string;
  emit: AiSessionEmit;
  deps: AiSessionDeps;
}

export class AiSession {
  public readonly sessionId: string;
  private readonly emit: AiSessionEmit;
  private readonly deps: AiSessionDeps;
  private readonly controller = new AbortController();
  private readonly seenInvocations = new Set<string>();
  private seq = 0;
  private proposedMapping?: ValidatedMappingConfig;

  public constructor(options: AiSessionOptions) {
    this.sessionId = options.sessionId;
    this.emit = options.emit;
    this.deps = options.deps;
  }

  public get signal(): AbortSignal {
    return this.controller.signal;
  }

  public async start(): Promise<void> {
    this.emit(buildAiCatalogMessage(
      { sessionId: this.sessionId, catalogVersion: CATALOG_VERSION, tools: buildToolCatalog() },
      this.deps.now()
    ));
    this.transition("discovering");
  }

  public async invokeTool(command: ToolInvokeCommand): Promise<void> {
    if (this.controller.signal.aborted) return;
    if (this.seenInvocations.has(command.invocationId)) return;
    this.seenInvocations.add(command.invocationId);

    const secrets = this.deps.secrets();
    this.audit({ kind: "tool.invoke", tool: command.name, summary: `invoca ${command.name}`, detail: redactValue(command.input, secrets) });

    if (command.name === PROPOSE_READONLY_USER_TOOL) {
      this.handleProposeReadonlyUser(command);
      return;
    }

    const adminCommand = toolNameToAdminCommand(command.name);
    if (!adminCommand) {
      this.emit(buildToolResultMessage(
        { sessionId: this.sessionId, invocationId: command.invocationId, ok: false, errorCode: "INVALID_INPUT" },
        this.deps.now()
      ));
      this.audit({ kind: "tool.result", tool: command.name, summary: `ferramenta fora do catálogo: ${command.name}` });
      return;
    }

    const req = { ...buildAdminRequestMessage({ requestId: command.invocationId, command: adminCommand }, this.deps.now()), input: command.input };
    const response = await this.deps.handleAdminRequest(req);

    if (response.ok) {
      const safePayload = redactValue(response.payload, secrets);
      this.emit(buildToolResultMessage(
        { sessionId: this.sessionId, invocationId: command.invocationId, ok: true, payload: safePayload },
        this.deps.now()
      ));
      this.audit({ kind: "tool.result", tool: command.name, summary: `${command.name} ok`, detail: safePayload });
    } else {
      this.emit(buildToolResultMessage(
        { sessionId: this.sessionId, invocationId: command.invocationId, ok: false, errorCode: response.error.errorCode },
        this.deps.now()
      ));
      this.audit({ kind: "tool.result", tool: command.name, summary: `${command.name} falhou: ${response.error.errorCode}` });
    }
  }

  private handleProposeReadonlyUser(command: ToolInvokeCommand): void {
    const input = (command.input ?? {}) as { username?: unknown };
    const username = typeof input.username === "string" ? input.username : "";
    if (!READONLY_USERNAME_PATTERN.test(username)) {
      this.emit(buildToolResultMessage(
        { sessionId: this.sessionId, invocationId: command.invocationId, ok: false, errorCode: "INVALID_INPUT" },
        this.deps.now()
      ));
      this.audit({ kind: "tool.result", tool: command.name, summary: `username inválido para usuário read-only` });
      return;
    }
    const engine = this.deps.currentEngine();
    const payload = { accepted: true, username, engine };
    this.emit(buildToolResultMessage(
      { sessionId: this.sessionId, invocationId: command.invocationId, ok: true, payload },
      this.deps.now()
    ));
    this.audit({ kind: "tool.result", tool: command.name, summary: `proposta de usuário read-only ${username} (${engine})`, detail: payload });
  }

  public proposeMapping(input: { mapping: ValidatedMappingConfig; rationale: string; previewRows: unknown[] }): void {
    this.proposedMapping = input.mapping;
    const safeRows = redactValue(input.previewRows, this.deps.secrets()) as unknown[];
    this.emit(buildMappingProposedMessage(
      { sessionId: this.sessionId, mapping: input.mapping, rationale: input.rationale, previewRows: safeRows },
      this.deps.now()
    ));
    this.transition("proposing");
  }

  public setProposedMapping(mapping: ValidatedMappingConfig): void {
    this.proposedMapping = mapping;
  }

  public async handleDecision(command: MappingDecisionCommand): Promise<void> {
    if (this.controller.signal.aborted) return;
    if (command.decision === "reject") {
      this.audit({ kind: "mapping.decision", summary: "mapping rejeitado" });
      this.transition("proposing");
      return;
    }
    const candidate: MappingConfig = command.editedMapping ?? (this.proposedMapping as MappingConfig | undefined) ?? {};
    const validated = validateMappingConfig(candidate);
    this.transition("applying");
    try {
      await this.deps.applyApproval(validated);
    } catch (err) {
      this.fail(err instanceof Error ? err.message : "falha ao aplicar mapping");
      return;
    }
    this.audit({ kind: "mapping.decision", summary: "mapping aprovado e aplicado" });
    this.transition("synced");
  }

  public abort(reason: string): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    this.audit({ kind: "ai.session.abort", summary: `sessão abortada: ${reason}` });
    this.transition("aborted", reason);
  }

  public fail(detail: string): void {
    this.transition("failed", detail);
  }

  private transition(phase: AiSessionPhase, detail?: string): void {
    this.emit(buildAiSessionStateMessage({ sessionId: this.sessionId, phase, ...(detail ? { detail } : {}) }, this.deps.now()));
  }

  private audit(input: { kind: string; tool?: string; summary: string; detail?: unknown }): void {
    this.seq += 1;
    this.emit(buildAuditEventMessage(
      { sessionId: this.sessionId, seq: this.seq, kind: input.kind, ...(input.tool ? { tool: input.tool } : {}), summary: input.summary, ...(input.detail !== undefined ? { detail: input.detail } : {}) },
      this.deps.now()
    ));
  }
}
