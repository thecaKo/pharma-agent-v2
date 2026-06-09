import { buildAdminRequestMessage, type AdminResponseMessage } from "../transport/protocol.js";
import { redactValue } from "../logging/redact.js";
import type { Logger } from "../logging/logger.js";
import { validateMappingConfig } from "../mapping/validate.js";
import type { ValidatedMappingConfig, MappingConfig } from "../mapping/types.js";
import {
  buildAiCatalogMessage, buildToolResultMessage, buildAuditEventMessage,
  buildMappingProposedMessage, buildAiSessionStateMessage,
  type AiSessionPhase, type ToolInvokeCommand, type MappingDecisionCommand,
  type AiCatalogMessage, type ToolResultMessage, type AuditEventMessage,
  type MappingProposedMessage, type AiSessionStateMessage
} from "./ai-protocol.js";
import {
  buildToolCatalog, CATALOG_VERSION, toolNameToAdminCommand,
  PROPOSE_READONLY_USER_TOOL, DB_CONNECT_TOOL
} from "./tool-catalog.js";
import { READONLY_USERNAME_PATTERN } from "../db/provision-types.js";
import type { DatabaseConfig, DatabaseDriver } from "../config/types.js";

const AI_TOOL_EXEC_TIMEOUT_MS = 25000;

const TOOL_TIMEOUT = Symbol("tool-timeout");

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
  /**
   * Abre (read-only) uma conexão a partir dos PARÂMETROS completos que a IA
   * descobriu (driver/host/port/user/password/database) e a torna a conexão ativa
   * das tools de schema. Retorna o resultado redigido { ok, tablesCount?, errorCode? }.
   * Opcional: ausente em sessões legadas/sem suporte a conexão.
   */
  connectDatabase?: (config: DatabaseConfig) => Promise<{ ok: boolean; tablesCount?: number; errorCode?: string }>;
  /**
   * Logger opcional para observabilidade no STDOUT do agente. Não altera
   * comportamento — só emite logs (já redigidos) dos eventos do ciclo da sessão.
   */
  logger?: Logger;
}

const LOG_STRING_MAX = 500;

/**
 * Trunca strings longas em qualquer nível de um valor já redigido, para evitar
 * despejar payloads enormes no STDOUT. Não muta a entrada original.
 */
function truncateForLog(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > LOG_STRING_MAX ? `${value.slice(0, LOG_STRING_MAX)}…[+${value.length - LOG_STRING_MAX}]` : value;
  }
  if (depth >= 6) return "[…]";
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => truncateForLog(item, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, truncateForLog(v, depth + 1)])
    );
  }
  return value;
}

/**
 * Resumo seguro de um payload de tool já redigido: para coleções conhecidas
 * loga apenas CONTAGENS (nunca os valores), e trunca o resto.
 */
function summarizeToolPayload(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object") return truncateForLog(payload);
  if (Array.isArray(payload)) return { count: payload.length };
  const record = payload as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (Array.isArray(value)) {
      summary[`${key}Count`] = value.length;
    } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      summary[key] = truncateForLog(value);
    } else if (value !== null && typeof value === "object") {
      summary[`${key}Keys`] = Object.keys(value as Record<string, unknown>).length;
    }
  }
  return summary;
}

/**
 * Valida e normaliza os params de db.connect num DatabaseConfig. driver/host/
 * user/password/database são obrigatórios; port é opcional. Mapeia `database` →
 * `name` (formato interno do DatabaseConfig). Retorna undefined se inválido.
 */
function parseDbConnectParams(input: unknown): DatabaseConfig | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  const driver = record.driver;
  const host = record.host;
  const user = record.user;
  const password = record.password;
  const database = record.database;
  if (
    typeof driver !== "string" || driver.length === 0 ||
    typeof host !== "string" || host.length === 0 ||
    typeof user !== "string" || user.length === 0 ||
    typeof password !== "string" ||
    typeof database !== "string"
  ) {
    return undefined;
  }
  const config: DatabaseConfig = {
    driver: driver as DatabaseDriver,
    host,
    port: typeof record.port === "number" && Number.isInteger(record.port) ? record.port : 0,
    name: database,
    user,
    password
  };
  return config;
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
    this.deps.logger?.info("ai_session.start", { sessionId: this.sessionId });
    this.emit(buildAiCatalogMessage(
      { sessionId: this.sessionId, catalogVersion: CATALOG_VERSION, tools: buildToolCatalog() },
      this.deps.now()
    ));
    this.transition("discovering");
  }

  private logToolResult(invocationId: string, name: string, ok: boolean, extra: { errorCode?: string; payload?: unknown }): void {
    this.deps.logger?.info("ai_session.tool_result", {
      sessionId: this.sessionId,
      invocationId,
      name,
      ok,
      ...(extra.errorCode !== undefined ? { errorCode: extra.errorCode } : {}),
      ...(extra.payload !== undefined ? { summary: extra.payload } : {})
    });
  }

  public async invokeTool(command: ToolInvokeCommand): Promise<void> {
    if (this.controller.signal.aborted) return;
    if (this.seenInvocations.has(command.invocationId)) return;
    this.seenInvocations.add(command.invocationId);

    const secrets = this.deps.secrets();
    const safeInput = redactValue(command.input, secrets);
    this.deps.logger?.info("ai_session.tool_invoke", {
      sessionId: this.sessionId,
      invocationId: command.invocationId,
      name: command.name,
      input: truncateForLog(safeInput)
    });
    this.audit({ kind: "tool.invoke", tool: command.name, summary: `invoca ${command.name}`, detail: safeInput });

    if (command.name === PROPOSE_READONLY_USER_TOOL) {
      this.handleProposeReadonlyUser(command);
      return;
    }

    if (command.name === DB_CONNECT_TOOL) {
      await this.handleDbConnect(command);
      return;
    }

    const adminCommand = toolNameToAdminCommand(command.name);
    if (!adminCommand) {
      this.emit(buildToolResultMessage(
        { sessionId: this.sessionId, invocationId: command.invocationId, ok: false, errorCode: "INVALID_INPUT" },
        this.deps.now()
      ));
      this.audit({ kind: "tool.result", tool: command.name, summary: `ferramenta fora do catálogo: ${command.name}` });
      this.logToolResult(command.invocationId, command.name, false, { errorCode: "INVALID_INPUT" });
      return;
    }

    const req = { ...buildAdminRequestMessage({ requestId: command.invocationId, command: adminCommand }, this.deps.now()), input: command.input };

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<typeof TOOL_TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TOOL_TIMEOUT), AI_TOOL_EXEC_TIMEOUT_MS);
      });
      const response = await Promise.race([this.deps.handleAdminRequest(req), timeout]);

      if (response === TOOL_TIMEOUT) {
        this.emit(buildToolResultMessage(
          { sessionId: this.sessionId, invocationId: command.invocationId, ok: false, errorCode: "TOOL_TIMEOUT" },
          this.deps.now()
        ));
        this.audit({ kind: "tool.result", tool: command.name, summary: `${command.name} excedeu o tempo limite (${AI_TOOL_EXEC_TIMEOUT_MS}ms)` });
        this.logToolResult(command.invocationId, command.name, false, { errorCode: "TOOL_TIMEOUT" });
        return;
      }

      if (response.ok) {
        const safePayload = redactValue(response.payload, secrets);
        this.emit(buildToolResultMessage(
          { sessionId: this.sessionId, invocationId: command.invocationId, ok: true, payload: safePayload },
          this.deps.now()
        ));
        this.audit({ kind: "tool.result", tool: command.name, summary: `${command.name} ok`, detail: safePayload });
        this.logToolResult(command.invocationId, command.name, true, { payload: summarizeToolPayload(safePayload) });
      } else {
        this.emit(buildToolResultMessage(
          { sessionId: this.sessionId, invocationId: command.invocationId, ok: false, errorCode: response.error.errorCode },
          this.deps.now()
        ));
        this.audit({ kind: "tool.result", tool: command.name, summary: `${command.name} falhou: ${response.error.errorCode}` });
        this.logToolResult(command.invocationId, command.name, false, { errorCode: response.error.errorCode });
      }
    } catch (err) {
      this.emit(buildToolResultMessage(
        { sessionId: this.sessionId, invocationId: command.invocationId, ok: false, errorCode: "INTERNAL_ERROR" },
        this.deps.now()
      ));
      this.audit({ kind: "tool.result", tool: command.name, summary: `${command.name} erro interno: ${err instanceof Error ? err.message : String(err)}` });
      this.logToolResult(command.invocationId, command.name, false, { errorCode: "INTERNAL_ERROR" });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
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
      this.logToolResult(command.invocationId, command.name, false, { errorCode: "INVALID_INPUT" });
      return;
    }
    const engine = this.deps.currentEngine();
    const payload = { accepted: true, username, engine };
    this.emit(buildToolResultMessage(
      { sessionId: this.sessionId, invocationId: command.invocationId, ok: true, payload },
      this.deps.now()
    ));
    this.audit({ kind: "tool.result", tool: command.name, summary: `proposta de usuário read-only ${username} (${engine})`, detail: payload });
    this.logToolResult(command.invocationId, command.name, true, {
      payload: summarizeToolPayload(redactValue(payload, this.deps.secrets()))
    });
  }

  private emitToolResult(invocationId: string, name: string, ok: boolean, extra: { payload?: unknown; errorCode?: string }): void {
    this.emit(buildToolResultMessage(
      { sessionId: this.sessionId, invocationId, ok, ...(extra.payload !== undefined ? { payload: extra.payload } : {}), ...(extra.errorCode !== undefined ? { errorCode: extra.errorCode } : {}) },
      this.deps.now()
    ));
  }

  private async handleDbConnect(command: ToolInvokeCommand): Promise<void> {
    const connectDatabase = this.deps.connectDatabase;
    const config = parseDbConnectParams(command.input);
    if (!config || !connectDatabase) {
      this.emitToolResult(command.invocationId, command.name, false, { errorCode: "INVALID_INPUT" });
      this.audit({ kind: "tool.result", tool: command.name, summary: `${command.name}: parâmetros inválidos/indisponível` });
      this.logToolResult(command.invocationId, command.name, false, { errorCode: "INVALID_INPUT" });
      return;
    }
    let result: { ok: boolean; tablesCount?: number; errorCode?: string };
    try {
      result = await connectDatabase(config);
    } catch (err) {
      const payload = { ok: false, errorCode: "CONNECTION_FAILED" };
      this.emitToolResult(command.invocationId, command.name, true, { payload });
      this.audit({ kind: "tool.result", tool: command.name, summary: `${command.name} erro: ${err instanceof Error ? err.message : String(err)}`, detail: payload });
      this.logToolResult(command.invocationId, command.name, true, { payload });
      return;
    }
    const safe = redactValue(result, this.deps.secrets());
    this.emitToolResult(command.invocationId, command.name, true, { payload: safe });
    this.audit({ kind: "tool.result", tool: command.name, summary: result.ok ? `conexão ativa (${result.tablesCount ?? 0} tabelas)` : `conexão falhou: ${result.errorCode}`, detail: safe });
    this.logToolResult(command.invocationId, command.name, true, { payload: summarizeToolPayload(safe) });
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
      this.deps.logger?.info("ai_session.mapping_decision", { sessionId: this.sessionId, decision: "reject" });
      this.audit({ kind: "mapping.decision", summary: "mapping rejeitado" });
      this.transition("proposing");
      return;
    }
    this.deps.logger?.info("ai_session.mapping_decision", { sessionId: this.sessionId, decision: "approve" });
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
    this.deps.logger?.info("ai_session.abort", { sessionId: this.sessionId, reason: truncateForLog(reason) });
    this.audit({ kind: "ai.session.abort", summary: `sessão abortada: ${reason}` });
    this.transition("aborted", reason);
  }

  public fail(detail: string): void {
    this.transition("failed", detail);
  }

  private transition(phase: AiSessionPhase, detail?: string): void {
    this.deps.logger?.info("ai_session.transition", { sessionId: this.sessionId, phase, ...(detail ? { detail: truncateForLog(detail) } : {}) });
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
