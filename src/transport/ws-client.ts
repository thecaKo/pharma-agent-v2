import { EventEmitter } from "node:events";
import WebSocket, { type RawData } from "ws";
import type { Logger } from "../logging/logger.js";
import { redactString } from "../logging/redact.js";
import type { ProductChangeBatch } from "../poller/batch-builder.js";
import { buildHeartbeatMessage, type BuildHeartbeatInput } from "./heartbeat.js";
import {
  buildConfigValidationConnectorError,
  buildConnectorErrorMessage,
  buildProductBatchMessage,
  buildUnsupportedServerCommandRejection,
  CONFIG_VALIDATION_FAILED_ERROR_CODE,
  extractSafeConfigPushIdentity,
  parseServerMessage,
  ProtocolParseError,
  serializeConnectorMessage,
  UNSUPPORTED_SERVER_COMMAND_ERROR_CODE,
  type BatchAckMessage,
  type AdminRequestMessage,
  type AdminResponseMessage,
  type ConfigUpdatedMessage,
  type ConnectorConfigMessage,
  type ConnectorDiscoveryMessage,
  type ConnectorErrorPayload,
  type ServerMessage
} from "./protocol.js";
import {
  buildCatalogMappingPreviewStubResult,
  serializeCatalogMappingPreviewResult
} from "./mapping-preview.js";
import {
  buildSetupConfigFailureResult,
  CONNECTOR_SETUP_CONFIG_COMMAND_TYPE,
  extractSetupConfigSecrets,
  serializeConnectorSetupConfigResult,
  SETUP_CONFIG_VALIDATION_FAILED_ERROR_CODE,
  type ConnectorSetupConfigCommand,
  type ConnectorSetupConfigResultMessage
} from "./connector-setup-ws.js";
import { serializeFileDiscoveryScanResult, type FileDiscoveryScanResultMessage } from "./file-discovery-ws.js";
import {
  buildSchemaTablesListResult,
  serializeSchemaTablesListResult,
  type SchemaDiscoveryRequest,
  type SchemaDiscoveryTable
} from "./schema-discovery.js";
import {
  dispatchExtensionMessage,
  dispatchServerMessage,
  parseServerMessageEnvelope,
  type ServerMessageEnvelope
} from "./server-message-router.js";
import { calculateReconnectDelay, type RetryPolicyOptions } from "./retry-policy.js";

export interface WebSocketTransportClientOptions {
  url: string;
  connectorToken: string;
  logger: Logger;
  retryPolicy?: RetryPolicyOptions;
  socketFactory?: WebSocketFactory;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  timers?: {
    setInterval(cb: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
    setTimeout(cb: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
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
  on(event: "pong", listener: (data: Buffer) => void): this;
  send(data: string): void;
  close(): void;
  ping(): void;
  terminate(): void;
}

export type WebSocketFactory = (url: string, options: WebSocketLikeOptions) => WebSocketLike;

export interface CloseInfo {
  code: number;
  reason: string;
}

export type WebSocketTransportEvent =
  | "connected"
  | "disconnected"
  | "config"
  | "batchAck"
  | "retry"
  | "reloadConfig"
  | "adminRequest"
  | "schemaDiscoveryRequest"
  | "fileDiscoveryScanRequest"
  | "setupConfigRequest";

function isTablesPayload(payload: unknown): payload is { tables: unknown[] } {
  return typeof payload === "object" && payload !== null && Array.isArray((payload as { tables?: unknown }).tables);
}

const DEFAULT_RETRY_POLICY: RetryPolicyOptions = {
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  jitterRatio: 0.25
};

const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_PONG_TIMEOUT_MS = 10_000;

const defaultClientTimers = {
  setInterval: (cb: () => void, ms: number) => setInterval(cb, ms),
  clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export class WebSocketTransportClient extends EventEmitter {
  private readonly url: string;
  private readonly connectorToken: string;
  private readonly logger: Logger;
  private readonly retryPolicy: RetryPolicyOptions;
  private readonly socketFactory: WebSocketFactory;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly clientTimers: NonNullable<WebSocketTransportClientOptions["timers"]>;
  private socket?: WebSocketLike;
  private stopped = true;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttemptCount = 0;
  private pingIntervalHandle?: unknown;
  private pongDeadlineHandle?: unknown;

  public constructor(options: WebSocketTransportClientOptions) {
    super();
    this.url = options.url;
    this.connectorToken = options.connectorToken;
    this.logger = options.logger;
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.socketFactory = options.socketFactory ?? ((url, socketOptions) => new WebSocket(url, socketOptions));
    this.pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.pongTimeoutMs = options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
    this.clientTimers = options.timers ?? defaultClientTimers;
  }

  public override on(event: "connected", listener: () => void): this;
  public override on(event: "disconnected", listener: (info: CloseInfo) => void): this;
  public override on(event: "config", listener: (message: ConnectorConfigMessage) => void): this;
  public override on(event: "batchAck", listener: (message: BatchAckMessage) => void): this;
  public override on(event: "retry", listener: (message: BatchAckMessage) => void): this;
  public override on(event: "reloadConfig", listener: (message: BatchAckMessage | ConfigUpdatedMessage) => void): this;
  public override on(event: "adminRequest", listener: (message: AdminRequestMessage) => void): this;
  public override on(event: "schemaDiscoveryRequest", listener: (request: SchemaDiscoveryRequest) => void): this;
  public override on(
    event: "fileDiscoveryScanRequest",
    listener: (request: { correlationId: string; rootPath?: string }) => void
  ): this;
  public override on(event: "setupConfigRequest", listener: (request: ConnectorSetupConfigCommand) => void): this;
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

  public sendAdminResponse(message: AdminResponseMessage): void {
    this.send(message);
    this.logger.info("admin.response.sent", {
      requestId: message.requestId,
      command: message.command,
      ok: message.ok,
      tableCount: message.ok && isTablesPayload(message.payload) ? message.payload.tables.length : undefined
    });
  }

  public sendSchemaTablesListResult(input: { correlationId: string; tables: readonly SchemaDiscoveryTable[] }): void {
    const message = buildSchemaTablesListResult(input);
    this.sendRaw(serializeSchemaTablesListResult(message));
    this.logger.info("schema.discovery.sent", {
      correlationId: message.id,
      responseFormat: "legacy",
      tableCount: message.tables.length
    });
  }

  public sendCatalogMappingPreviewResult(input: { correlationId: string }): void {
    const message = buildCatalogMappingPreviewStubResult(input.correlationId);
    this.sendRaw(serializeCatalogMappingPreviewResult(message));
    this.logger.info("preview.not_implemented", {
      correlationId: message.id,
      sampleCount: message.summary.sampleCount
    });
  }

  public sendFileDiscoveryScanResult(message: FileDiscoveryScanResultMessage): void {
    this.sendRaw(serializeFileDiscoveryScanResult(message));
    this.logger.info(message.failureReason ? "file.discovery.failure_sent" : "file.discovery.sent", {
      correlationId: message.id,
      ...(message.failureReason ? { failureReason: message.failureReason } : {}),
      entryCount: message.failureReason ? undefined : message.entries.length
    });
  }

  public sendConnectorSetupConfigResult(message: ConnectorSetupConfigResultMessage): void {
    this.sendRaw(serializeConnectorSetupConfigResult(message));
    this.logger.info(message.ok ? "setup.config.applied" : "setup.config.failed", {
      correlationId: message.id,
      setupMethod: message.setupMethod,
      driver: message.driver,
      ...(message.ok
        ? {}
        : {
            errorCode: message.errorCode,
            message: message.message
          })
    });
  }

  public sendConnectorDiscovery(message: ConnectorDiscoveryMessage): void {
    this.send(message);
  }

  private async openSocket(): Promise<void> {
    this.logger.info("websocket connecting", { url: this.url });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let opened = false;
      const socket = this.socketFactory(this.url, {
        headers: {
          Authorization: `Bearer ${this.connectorToken}`
        }
      });
      this.socket = socket;

      socket.once("open", () => {
        settled = true;
        opened = true;
        this.reconnectAttemptCount = 0;
        this.logger.info("websocket connected", { url: this.url });
        this.emit("connected");
        this.startPingLoop(socket);
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
          this.socket = undefined;
          this.scheduleReconnect();
          resolve();
        }
      });

      socket.on("message", (data) => this.handleMessage(data));
      socket.on("pong", () => this.clearPongDeadline());
      socket.once("close", (code, reason) => {
        this.stopPingLoop();
        const closeInfo = { code, reason: reason.toString("utf8") };
        this.logger.warn("websocket disconnected", closeInfo);
        this.emit("disconnected", closeInfo);
        if (!settled) {
          settled = true;
          this.socket = undefined;
          this.scheduleReconnect();
          resolve();
        }
        if (opened && !this.stopped && this.socket === socket) {
          this.scheduleReconnect();
        }
      });
    });
  }

  private handleMessage(data: RawData): void {
    dispatchServerMessage(data, {
      onMalformed: (error) => this.logProtocolParseError(error),
      onCore: (raw) => this.handleCoreMessage(raw),
      onExtension: (envelope, raw) => this.handleExtensionMessage(envelope, raw),
      onUnsupported: (envelope) => this.handleUnsupportedMessage(envelope)
    });
  }

  private handleCoreMessage(raw: RawData): void {
    let message: ServerMessage;
    try {
      message = parseServerMessage(raw);
    } catch (error) {
      const envelopeResult = parseServerMessageEnvelope(raw);
      if (
        envelopeResult.classification !== "malformed" &&
        envelopeResult.envelope.type === "connector.config"
      ) {
        this.respondToMalformedConfigPush(error, envelopeResult.envelope.message);
        return;
      }
      this.logProtocolParseError(error);
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
      case "admin.request":
        this.logger.info("admin.request.received", {
          requestId: message.requestId,
          command: message.command
        });
        this.emit("adminRequest", message);
        if (message.command === "schema.listTables") {
          this.emit("schemaDiscoveryRequest", {
            responseFormat: "admin",
            correlationId: message.requestId,
            command: message.command
          } satisfies SchemaDiscoveryRequest);
        }
        return;
    }
  }

  private handleUnsupportedMessage(envelope: ServerMessageEnvelope): void {
    this.logger.warn("unsupported_server_message", {
      type: envelope.type,
      ...(envelope.id !== undefined ? { id: envelope.id } : {})
    });

    if (!envelope.id) {
      return;
    }

    const message = buildUnsupportedServerCommandRejection({
      messageType: envelope.type,
      correlationId: envelope.id
    });
    this.send(message);
    this.logger.warn("connector error sent", {
      event: "connector.error",
      errorCode: UNSUPPORTED_SERVER_COMMAND_ERROR_CODE,
      correlationId: envelope.id,
      messageType: envelope.type
    });
  }

  private handleExtensionMessage(envelope: ServerMessageEnvelope, raw: RawData): void {
    const result = dispatchExtensionMessage(envelope, raw);

    switch (result.kind) {
      case "schemaDiscoveryRequest":
        this.logger.info("schema.discovery.received", {
          correlationId: result.request.correlationId
        });
        this.emit("schemaDiscoveryRequest", result.request satisfies SchemaDiscoveryRequest);
        return;
      case "catalogMappingPreviewStub":
        this.sendCatalogMappingPreviewResult({ correlationId: result.correlationId });
        return;
      case "fileDiscoveryScanRequest":
        this.emit("fileDiscoveryScanRequest", {
          correlationId: result.correlationId,
          ...(result.rootPath !== undefined ? { rootPath: result.rootPath } : {})
        });
        return;
      case "setupConfigRequest":
        this.logger.info("setup.config.received", {
          correlationId: result.request.correlationId,
          setupMethod: result.request.setupMethod,
          driver: result.request.driver
        });
        this.emit("setupConfigRequest", result.request);
        return;
      case "malformed":
        if (envelope.type === CONNECTOR_SETUP_CONFIG_COMMAND_TYPE && envelope.id) {
          this.respondToMalformedSetupConfig(result.error, envelope);
          return;
        }
        this.logProtocolParseError(result.error);
        return;
      case "handled":
        return;
    }
  }

  private respondToMalformedSetupConfig(error: unknown, envelope: ServerMessageEnvelope): void {
    const correlationId = envelope.id;
    if (!correlationId) {
      this.logProtocolParseError(error);
      return;
    }

    const message =
      error instanceof Error ? error.message : "Invalid connector.setup.config message";
    const secrets = [
      this.connectorToken,
      ...extractSetupConfigSecrets(envelope.message)
    ];
    const result = buildSetupConfigFailureResult(correlationId, {
      errorCode: SETUP_CONFIG_VALIDATION_FAILED_ERROR_CODE,
      message: redactString(message, secrets)
    });

    try {
      this.sendConnectorSetupConfigResult(result);
      this.logger.warn("setup.config.validation_failed", {
        correlationId,
        errorCode: SETUP_CONFIG_VALIDATION_FAILED_ERROR_CODE
      });
    } catch {
      this.logProtocolParseError(error);
    }
  }

  private respondToMalformedConfigPush(error: unknown, messageRecord: Record<string, unknown>): void {
    const connectorError = buildConfigValidationConnectorError({
      parseError: error instanceof Error ? error : new ProtocolParseError("Invalid connector.config message"),
      identity: extractSafeConfigPushIdentity(messageRecord)
    });
    connectorError.error.message = redactString(connectorError.error.message, [this.connectorToken]);

    try {
      this.send(connectorError);
      this.logger.warn("connector error sent", {
        event: "connector.error",
        errorCode: CONFIG_VALIDATION_FAILED_ERROR_CODE,
        connectorId: connectorError.error.connectorId,
        customerId: connectorError.error.customerId,
        mappingVersion: connectorError.error.mappingVersion
      });
    } catch {
      this.logProtocolParseError(error);
    }
  }

  private logProtocolParseError(error: unknown): void {
    this.logger.warn("websocket malformed message", {
      errorCode: "PROTOCOL_PARSE_ERROR",
      message: error instanceof ProtocolParseError ? error.message : "Unknown protocol parse error"
    });
  }

  private send(message: Parameters<typeof serializeConnectorMessage>[0]): void {
    this.sendRaw(serializeConnectorMessage(message));
  }

  private sendRaw(payload: string): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      throw new Error("WebSocket is not connected");
    }
    this.socket.send(payload);
  }

  private startPingLoop(socket: WebSocketLike): void {
    this.stopPingLoop();
    this.pingIntervalHandle = this.clientTimers.setInterval(() => {
      if (socket.readyState !== socket.OPEN) {
        return;
      }
      try {
        socket.ping();
      } catch (error) {
        this.logger.warn("websocket.ping.failed", {
          message: error instanceof Error ? error.message : String(error)
        });
        return;
      }
      this.armPongDeadline(socket);
    }, this.pingIntervalMs);
  }

  private stopPingLoop(): void {
    if (this.pingIntervalHandle !== undefined) {
      this.clientTimers.clearInterval(this.pingIntervalHandle);
      this.pingIntervalHandle = undefined;
    }
    this.clearPongDeadline();
  }

  private armPongDeadline(socket: WebSocketLike): void {
    this.clearPongDeadline();
    this.pongDeadlineHandle = this.clientTimers.setTimeout(() => {
      this.pongDeadlineHandle = undefined;
      this.logger.warn("websocket.pong.timeout", {
        pongTimeoutMs: this.pongTimeoutMs
      });
      try {
        socket.terminate();
      } catch (error) {
        this.logger.warn("websocket.terminate.failed", {
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }, this.pongTimeoutMs);
  }

  private clearPongDeadline(): void {
    if (this.pongDeadlineHandle !== undefined) {
      this.clientTimers.clearTimeout(this.pongDeadlineHandle);
      this.pongDeadlineHandle = undefined;
    }
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
