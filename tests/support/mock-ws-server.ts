import { EventEmitter } from "node:events";
import type { WebSocketFactory, WebSocketLike, WebSocketLikeOptions } from "../../src/transport/ws-client.js";

export interface ReceivedClientMessage {
  raw: string;
  parsed: Record<string, unknown>;
}

const READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3
} as const;

export class MockWebSocketServer {
  private readonly clients = new Set<InMemoryWebSocket>();
  private readonly receivedMessages: ReceivedClientMessage[] = [];
  private readonly messageWaiters: Array<(message: ReceivedClientMessage) => void> = [];
  private connectionCount = 0;

  public readonly ready = Promise.resolve();
  public readonly url = "ws://mock.connector.test/connect";
  public readonly createWebSocket: WebSocketFactory;
  public lastAuthorization?: string;

  public constructor() {
    this.createWebSocket = (url, options) => this.connectClient(url, options);
  }

  public get connections(): number {
    return this.connectionCount;
  }

  public async waitForConnectionCount(count: number): Promise<void> {
    await waitFor(() => this.connectionCount >= count);
  }

  public sendJson(message: Record<string, unknown>): void {
    this.sendRaw(JSON.stringify(message));
  }

  public sendRaw(payload: string): void {
    for (const client of this.clients) {
      client.receive(payload);
    }
  }

  public async nextMessage(): Promise<ReceivedClientMessage> {
    const message = this.receivedMessages.shift();
    if (message) {
      return message;
    }
    return new Promise((resolve) => this.messageWaiters.push(resolve));
  }

  public snapshotMessages(): readonly ReceivedClientMessage[] {
    return [...this.receivedMessages];
  }

  public disconnectClients(): void {
    for (const client of [...this.clients]) {
      client.serverClose(4000, "test disconnect");
    }
  }

  public async close(): Promise<void> {
    for (const client of [...this.clients]) {
      client.serverClose(1000, "server shutdown");
    }
  }

  private connectClient(url: string, options: WebSocketLikeOptions): WebSocketLike {
    if (url !== this.url) {
      throw new Error(`Unexpected mock WebSocket URL: ${url}`);
    }

    const client = new InMemoryWebSocket({
      onSend: (raw) => this.captureMessage(raw),
      onClose: () => this.clients.delete(client)
    });
    this.lastAuthorization = options.headers?.Authorization;

    queueMicrotask(() => {
      this.connectionCount += 1;
      this.clients.add(client);
      client.markOpen();
    });

    return client;
  }

  private captureMessage(raw: string): void {
    const message = { raw, parsed: JSON.parse(raw) as Record<string, unknown> };
    const waiter = this.messageWaiters.shift();
    if (waiter) {
      waiter(message);
      return;
    }
    this.receivedMessages.push(message);
  }
}

interface InMemoryWebSocketOptions {
  onSend(raw: string): void;
  onClose(): void;
}

class InMemoryWebSocket extends EventEmitter implements WebSocketLike {
  public readonly OPEN = READY_STATE.OPEN;
  public readonly CLOSED = READY_STATE.CLOSED;
  public readyState = READY_STATE.CONNECTING;
  private readonly onSendMessage: (raw: string) => void;
  private readonly onCloseSocket: () => void;

  public constructor(options: InMemoryWebSocketOptions) {
    super();
    this.onSendMessage = options.onSend;
    this.onCloseSocket = options.onClose;
  }

  public send(data: string): void {
    if (this.readyState !== READY_STATE.OPEN) {
      throw new Error("Socket is not open");
    }
    this.onSendMessage(data);
  }

  public close(code = 1000, reason = ""): void {
    if (this.readyState === READY_STATE.CLOSED) {
      return;
    }
    this.readyState = READY_STATE.CLOSED;
    this.onCloseSocket();
    this.emit("close", code, Buffer.from(reason, "utf8"));
  }

  public receive(payload: string): void {
    if (this.readyState !== READY_STATE.OPEN) {
      return;
    }
    this.emit("message", Buffer.from(payload, "utf8"));
  }

  public serverClose(code: number, reason: string): void {
    this.close(code, reason);
  }

  public markOpen(): void {
    if (this.readyState !== READY_STATE.CONNECTING) {
      return;
    }
    this.readyState = READY_STATE.OPEN;
    this.emit("open");
  }
}

export async function waitFor(assertion: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!assertion()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for mock WebSocket condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
