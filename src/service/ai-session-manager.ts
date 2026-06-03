import { AiSession, type AiSessionDeps, type AiSessionEmit } from "../ai-session/ai-session.js";
import type {
  AiSessionStartCommand, ToolInvokeCommand, MappingDecisionCommand, AiSessionAbortCommand
} from "../ai-session/ai-protocol.js";

export interface AiSessionManagerOptions {
  emit: AiSessionEmit;
  buildDeps: (sessionId: string) => AiSessionDeps;
}

export class AiSessionManager {
  private readonly sessions = new Map<string, AiSession>();
  private readonly options: AiSessionManagerOptions;

  public constructor(options: AiSessionManagerOptions) {
    this.options = options;
  }

  public async onStart(command: AiSessionStartCommand): Promise<void> {
    const existing = this.sessions.get(command.sessionId);
    if (existing) return;
    const session = new AiSession({
      sessionId: command.sessionId,
      emit: this.options.emit,
      deps: this.options.buildDeps(command.sessionId)
    });
    this.sessions.set(command.sessionId, session);
    await session.start();
  }

  public async onToolInvoke(command: ToolInvokeCommand): Promise<void> {
    await this.sessions.get(command.sessionId)?.invokeTool(command);
  }

  public async onDecision(command: MappingDecisionCommand): Promise<void> {
    await this.sessions.get(command.sessionId)?.handleDecision(command);
  }

  public onAbort(command: AiSessionAbortCommand): void {
    const session = this.sessions.get(command.sessionId);
    if (!session) return;
    session.abort(command.reason);
    this.sessions.delete(command.sessionId);
  }
}
