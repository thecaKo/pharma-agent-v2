import { EventEmitter } from "node:events";
import WebSocket, { type RawData } from "ws";
import type { Logger } from "../logging/logger.js";
import type { ProductChangeBatch } from "../poller/batch-builder.js";
import { buildHeartbeatMessage, type BuildHeartbeatInput } from "./heartbeat.js";
import {
  buildConnectorErrorMessage,
  buildProductBatchMessage,
  parseServerMessage,
  ProtocolParseError,
  serializeConnectorMessage,
  type BatchAckMessage,
  type ConfigUpdatedMessage,
  type ConnectorConfigMessage,
  type ConnectorErrorPayload,
  type ServerMessage
} from "./protocol.js";
import { calculateReconnectDelay, type RetryPolicyOptions } from "./retry-policy.js";

export interface WebSocketTransportClientOptions {
  url: string;
  connectorToken: string;
  logger: Logger;
  retryPolicy?: RetryPolicyOptions;
  socketFactory?: WebSocketFactory;
}

export interface WebSocketLikeOptions {
  headers?: Record<string, string>;
}

export interface WebSocketLike {
  readonly OPEN: number;
  readonly CLOSED: number;
  readyState: number;
  once(event: "open", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (code: number, reason: Buffer) => void): this;
  on(event: "message", listener: (data: RawData) => void): this;
  send(data: string): void;
  close(): void;
}

export type WebSocketFactory = (url: string, options: WebSocketLikeOptions) => WebSocketLike;

export interface CloseInfo {
  code: number;
  reason: string;
}

export type WebSocketTransportEvent = "connected" | "disconnected" | "config" | "batchAck" | "retry" | "reloadConfig";

const DEFAULT_RETRY_POLICY: RetryPolicyOptions = {
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  jitterRatio: 0.25
};

export class WebSocketTransportClient extends EventEmitter {
  private readonly url: string;
  private readonly connectorToken: string;
  private readonly logger: Logger;
  private readonly retryPolicy: RetryPolicyOptions;
  private readonly socketFactory: WebSocketFactory;
  private socket?: WebSocketLike;
  private stopped = true;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttemptCount = 0;

  public constructor(options: WebSocketTransportClientOptions) {
    super();
    this.url = options.url;
    this.connectorToken = options.connectorToken;
    this.logger = options.logger;
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.socketFactory = options.socketFactory ?? ((url, socketOptions) => new WebSocket(url, socketOptions));
  }

  public override on(event: "connected", listener: () => void): this;
  public override on(event: "disconnected", listener: (info: CloseInfo) => void): this;
  public override on(event: "config", listener: (message: ConnectorConfigMessage) => void): this;
  public override on(event: "batchAck", listener: (message: BatchAckMessage) => void): this;
  public override on(event: "retry", listener: (message: BatchAckMessage) => void): this;
  public override on(event: "reloadConfig", listener: (message: BatchAckMessage | ConfigUpdatedMessage) => void): this;
  public override on(event: WebSocketTransportEvent, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  public getReconnectAttemptCount(): number {
    return this.reconnectAttemptCount;
  }

  public isConnected(): boolean {
    const socket = this.socket;
    return socket !== undefined && socket.readyState === socket.OPEN;
  }

  public async connect(): Promise<void> {
    this.stopped = false;
    this.clearReconnectTimer();
    await this.openSocket();
  }

  public async close(): Promise<void> {
    this.stopped = true;
    this.clearReconnectTimer();

    const socket = this.socket;
    this.socket = undefined;
    if (!socket || socket.readyState === socket.CLOSED) {
      return;
    }

    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close();
    });
  }

  public sendHeartbeat(input: Omit<BuildHeartbeatInput, "online" | "reconnectAttemptCount">): void {
    this.send(
      buildHeartbeatMessage({
        ...input,
        online: this.isConnected(),
        reconnectAttemptCount: this.reconnectAttemptCount
      })
    );
  }

  public sendBatch(batch: ProductChangeBatch, sentAt?: string): void {
    this.send(buildProductBatchMessage(batch, sentAt));
    this.logger.info("batch sent", {
      batchId: batch.batchId,
      connectorId: batch.connectorId,
      customerId: batch.customerId,
      mappingVersion: batch.mappingVersion,
      rowCount: batch.records.length,
      cursorBefore: batch.cursorBefore,
      cursorAfter: batch.cursorAfter
    });
  }

  public sendConnectorError(input: ConnectorErrorPayload, sentAt?: string): void {
    const message = buildConnectorErrorMessage(input, sentAt);
    this.send(message);
    this.logger.warn("connector error sent", {
      event: "connector.error",
      errorCode: message.error.errorCode,
      connectorId: message.error.connectorId,
      customerId: message.error.customerId,
      mappingVersion: message.error.mappingVersion,
      batchId: message.error.batchId
    });
  }

  private async openSocket(): Promise<void> {
    this.logger.info("websocket connecting", { url: this.url });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = this.socketFactory(this.url, {
        headers: {
          Authorization: `Bearer ${this.connectorToken}`
        }
      });
      this.socket = socket;

      socket.once("open", () => {
        settled = true;
        this.reconnectAttemptCount = 0;
        this.logger.info("websocket connected", { url: this.url });
        this.emit("connected");
        resolve();
      });

      socket.once("error", (error) => {
        this.logger.warn("websocket error", {
          url: this.url,
          errorCode: "WEBSOCKET_ERROR",
          message: error.message
        });
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      socket.on("message", (data) => this.handleMessage(data));
      socket.once("close", (code, reason) => {
        const closeInfo = { code, reason: reason.toString("utf8") };
        this.logger.warn("websocket disconnected", closeInfo);
        this.emit("disconnected", closeInfo);
        if (!settled) {
          settled = true;
          reject(new Error(`WebSocket closed before opening: ${code}`));
        }
        if (!this.stopped && this.socket === socket) {
          this.scheduleReconnect();
        }
      });
    });
  }

  private handleMessage(data: RawData): void {
    let message: ServerMessage;
    try {
      message = parseServerMessage(data);
    } catch (error) {
      this.logger.warn("websocket malformed message", {
        errorCode: "PROTOCOL_PARSE_ERROR",
        message: error instanceof ProtocolParseError ? error.message : "Unknown protocol parse error"
      });
      return;
    }

    switch (message.type) {
      case "connector.config":
        this.logger.info("mapping received", {
          connectorId: message.connectorId,
          customerId: message.customerId,
          mappingVersion: message.mapping.mappingVersion
        });
        this.emit("config", message);
        return;
      case "batch.ack":
        this.logger.info("batch acknowledged", {
          batchId: message.batchId,
          accepted: message.accepted,
          acceptedRecordCount: message.acceptedRecordCount,
          rejectedRecordCount: message.rejectedRecordCount,
          nextAction: message.nextAction,
          errorCode: message.errorCode
        });
        this.emit("batchAck", message);
        if (message.nextAction === "retry") {
          this.emit("retry", message);
        }
        if (message.nextAction === "reload_config") {
          this.emit("reloadConfig", message);
        }
        return;
      case "config.updated":
        this.logger.info("config update received", {
          mappingVersion: message.mappingVersion,
          reason: message.reason
        });
        this.emit("reloadConfig", message);
        return;
    }
  }

  private send(message: Parameters<typeof serializeConnectorMessage>[0]): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      throw new Error("WebSocket is not connected");
    }
    this.socket.send(serializeConnectorMessage(message));
  }

  private scheduleReconnect(): void {
    this.reconnectAttemptCount += 1;
    const delayMs = calculateReconnectDelay(this.reconnectAttemptCount, this.retryPolicy);
    this.logger.warn("websocket reconnect scheduled", {
      reconnectAttemptCount: this.reconnectAttemptCount,
      delayMs
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.openSocket().catch(() => undefined);
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}
