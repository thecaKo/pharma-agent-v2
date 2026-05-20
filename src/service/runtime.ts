import { homedir } from "node:os";
import { join } from "node:path";
import { configSecrets, loadConfig, type Environment } from "../config/env.js";
import type { ConnectorConfig } from "../config/types.js";
import {
  createSourceDatabaseAdapter,
  type AdapterFactoryDependencies
} from "../db/adapter-factory.js";
import { attachFirebirdConnection } from "../db/firebird-driver.js";
import type { SourceDatabaseAdapter } from "../db/source-adapter.js";
import { createLogger, type Logger } from "../logging/logger.js";
import type { ValidatedMappingConfig } from "../mapping/types.js";
import { validateMappingConfig } from "../mapping/validate.js";
import { IncrementalPoller } from "../poller/incremental-poller.js";
import type { ProductChangeBatch } from "../poller/batch-builder.js";
import { StateStore } from "../state/state-store.js";
import { STATE_FILE_NAME, type ConnectorState } from "../state/state-types.js";
import type {
  BatchAckMessage,
  AdminRequestMessage,
  AdminResponseMessage,
  ConfigUpdatedMessage,
  ConnectorConfigMessage,
  ConnectorErrorPayload
} from "../transport/protocol.js";
import { buildAdminErrorResponseMessage, buildAdminSuccessResponseMessage } from "../transport/protocol.js";
import { WebSocketTransportClient } from "../transport/ws-client.js";
import { CONNECTOR_VERSION } from "../version.js";

export interface RuntimeTransport {
  on(event: "connected", listener: () => void): this;
  on(event: "disconnected", listener: (info: unknown) => void): this;
  on(event: "config", listener: (message: ConnectorConfigMessage) => void): this;
  on(event: "batchAck", listener: (message: BatchAckMessage) => void): this;
  on(event: "reloadConfig", listener: (message: BatchAckMessage | ConfigUpdatedMessage) => void): this;
  on(event: "adminRequest", listener: (message: AdminRequestMessage) => void): this;
  connect(): Promise<void>;
  close(): Promise<void>;
  isConnected(): boolean;
  sendBatch(batch: ProductChangeBatch, sentAt?: string): void;
  sendHeartbeat(input: {
    connectorVersion: string;
    mappingVersion?: string;
    lastSuccessfulSendAt?: string;
    lastErrorCode?: string;
    sentAt?: string;
  }): void;
  sendConnectorError(input: ConnectorErrorPayload, sentAt?: string): void;
  sendAdminResponse(message: AdminResponseMessage): void;
  getReconnectAttemptCount(): number;
}

export interface RuntimeTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ConnectorRuntimeOptions {
  env?: Environment;
  logger?: Logger;
  stateStore?: StateStore;
  stateFilePath?: string;
  adapter?: SourceDatabaseAdapter;
  adapterDependencies?: AdapterFactoryDependencies;
  transport?: RuntimeTransport;
  timers?: RuntimeTimers;
  now?: () => string;
}

export interface ConnectorRuntimeState {
  config: ConnectorConfig;
  activeMapping?: ValidatedMappingConfig;
  inFlightBatch?: ProductChangeBatch;
  pollingPaused: boolean;
  stopped: boolean;
}

const defaultTimers: RuntimeTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export class ConnectorRuntime {
  private readonly config: ConnectorConfig;
  private readonly logger: Logger;
  private readonly stateStore: StateStore;
  private readonly adapter: SourceDatabaseAdapter;
  private readonly transport: RuntimeTransport;
  private readonly timers: RuntimeTimers;
  private readonly now: () => string;
  private poller?: IncrementalPoller;
  private activeMapping?: ValidatedMappingConfig;
  private activeConnectorId?: string;
  private activeCustomerId?: string;
  private inFlightBatch?: ProductChangeBatch;
  private pollTimer?: unknown;
  private pendingPoll?: Promise<void>;
  private pendingStateWrite: Promise<void> = Promise.resolve();
  private pollingPaused = true;
  private stopped = true;
  private adapterConnected = false;
  private lastErrorCode: string | undefined;

  public constructor(options: ConnectorRuntimeOptions = {}) {
    this.config = loadConfig(options.env);
    this.logger =
      options.logger ??
      createLogger({
        level: this.config.logLevel,
        secrets: configSecrets(this.config)
      });
    this.stateStore =
      options.stateStore ??
      new StateStore({
        stateFilePath: options.stateFilePath ?? defaultStateFilePath()
      });
    this.adapter =
      options.adapter ??
      createSourceDatabaseAdapter({
        config: this.config.database,
        dependencies: options.adapterDependencies ?? createOptionalDriverDependencies(),
        secrets: configSecrets(this.config)
      });
    this.transport =
      options.transport ??
      new WebSocketTransportClient({
        url: this.config.websocketUrl,
        connectorToken: this.config.connectorToken,
        logger: this.logger
      });
    this.timers = options.timers ?? defaultTimers;
    this.now = options.now ?? (() => new Date().toISOString());
    this.bindTransportEvents();
  }

  public async start(): Promise<void> {
    this.stopped = false;
    this.logger.info("service.startup", {
      version: CONNECTOR_VERSION,
      dbDriver: this.config.database.driver
    });
    this.logger.info("configuration.loaded", {
      websocketUrl: this.config.websocketUrl,
      dbDriver: this.config.database.driver,
      dbHost: this.config.database.host,
      dbPort: this.config.database.port,
      dbName: this.config.database.name,
      dbUser: this.config.database.user
    });

    await this.transport.connect();
  }

  public async shutdown(): Promise<void> {
    this.stopped = true;
    this.pollingPaused = true;
    this.stopPollTimer();

    await this.pendingPoll?.catch(() => undefined);
    await this.pendingStateWrite;
    await this.transport.close();
    if (this.adapterConnected) {
      await this.adapter.close();
      this.adapterConnected = false;
    }
    this.logger.info("service.shutdown", {
      connectorId: this.activeStateIdentity().connectorId,
      customerId: this.activeStateIdentity().customerId,
      mappingVersion: this.activeMapping?.mappingVersion
    });
  }

  public getState(): ConnectorRuntimeState {
    return {
      config: this.config,
      activeMapping: this.activeMapping,
      inFlightBatch: this.inFlightBatch,
      pollingPaused: this.pollingPaused,
      stopped: this.stopped
    };
  }

  public async pollOnceForTest(): Promise<void> {
    await this.runPollCycle();
  }

  private bindTransportEvents(): void {
    this.transport.on("connected", () => {
      this.logger.info("websocket.connected", {
        reconnectAttemptCount: this.transport.getReconnectAttemptCount()
      });
      this.sendHeartbeat();
    });
    this.transport.on("disconnected", () => {
      this.logger.warn("websocket.disconnected", {
        mappingVersion: this.activeMapping?.mappingVersion
      });
    });
    this.transport.on("config", (message) => {
      this.handleConfig(message).catch((error) => this.handleRuntimeError("CONFIG_ACTIVATION_FAILED", error));
    });
    this.transport.on("batchAck", (message) => {
      this.handleBatchAck(message).catch((error) => this.handleRuntimeError("ACK_HANDLING_FAILED", error));
    });
    this.transport.on("reloadConfig", () => {
      this.pausePolling("config reload requested");
    });
    this.transport.on("adminRequest", (message) => {
      this.handleAdminRequest(message).catch((error) => this.handleRuntimeError("ADMIN_REQUEST_FAILED", error));
    });
  }

  private async handleConfig(message: ConnectorConfigMessage): Promise<void> {
    this.pausePolling("mapping activation");

    const mapping = validateMappingConfig(message.mapping);
    await this.ensureAdapterConnected();

    const previous = await this.stateStore.load();
    const keepCursor = canReuseAcknowledgedCursor(previous, mapping);
    const nextState: ConnectorState = {
      connectorId: message.connectorId,
      customerId: message.customerId,
      mappingVersion: mapping.mappingVersion,
      selectedProductTable: mapping.selectedProductTable,
      cursorField: mapping.cursorField,
      cursorType: mapping.cursorType,
      sourceProductCodeField: mapping.fields.sourceProductCode,
      lastAckedCursor: keepCursor ? previous.lastAckedCursor ?? null : null,
      lastSuccessfulSendAt: previous.lastSuccessfulSendAt,
      lastBatchId: previous.lastBatchId
    };
    await this.saveState(nextState);

    this.activeMapping = mapping;
    this.activeConnectorId = message.connectorId;
    this.activeCustomerId = message.customerId;
    this.inFlightBatch = undefined;
    this.poller = new IncrementalPoller({
      adapter: this.adapter,
      mapping,
      state: this.stateStore,
      connectorId: message.connectorId,
      customerId: message.customerId,
      isTransportReady: () => this.transport.isConnected(),
      hasUnacknowledgedBatch: () => this.inFlightBatch !== undefined,
      logger: this.logger,
      now: this.now
    });
    this.pollingPaused = false;

    this.logger.info("mapping.active", {
      connectorId: message.connectorId,
      customerId: message.customerId,
      mappingVersion: mapping.mappingVersion,
      ...(mapping.selectedProductTable ? { selectedProductTable: mapping.selectedProductTable } : {})
    });
    this.sendHeartbeat();
    this.scheduleNextPoll(0);
  }

  private async handleAdminRequest(message: AdminRequestMessage): Promise<void> {
    const identity = this.activeStateIdentity();
    this.logger.info("admin.request.received", {
      requestId: message.requestId,
      command: message.command,
      connectorId: identity.connectorId,
      customerId: identity.customerId
    });

    try {
      await this.ensureAdapterConnected();
      const tables = await this.adapter.listTables();
      const tableNames = tables.map((table) => table.name);
      const response = buildAdminSuccessResponseMessage(
        {
          requestId: message.requestId,
          command: message.command,
          tables: tableNames
        },
        this.now()
      );

      this.transport.sendAdminResponse(response);
      this.logger.info("admin.response.sent", {
        requestId: response.requestId,
        command: response.command,
        ok: response.ok,
        tableCount: tableNames.length
      });
    } catch (error) {
      const errorInput = {
        errorCode: "TABLE_DISCOVERY_FAILED",
        message: error instanceof Error ? error.message : String(error)
      };
      const response = buildAdminErrorResponseMessage(
        {
          requestId: message.requestId,
          command: message.command,
          errorCode: errorInput.errorCode,
          message: errorInput.message,
          secrets: configSecrets(this.config)
        },
        this.now()
      );

      this.logger.warn("admin.request.failed", {
        requestId: message.requestId,
        command: message.command,
        errorCode: errorInput.errorCode,
        message: response.ok ? undefined : response.error.message
      });

      this.transport.sendAdminResponse(response);
      this.logger.info("admin.response.sent", {
        requestId: response.requestId,
        command: response.command,
        ok: response.ok,
        tableCount: undefined
      });
    }
  }

  private async handleBatchAck(message: BatchAckMessage): Promise<void> {
    const batch = this.inFlightBatch;
    if (!batch || batch.batchId !== message.batchId) {
      this.logger.warn("batch_ack.ignored", {
        batchId: message.batchId,
        reason: "no_matching_in_flight_batch"
      });
      return;
    }

    if (message.accepted && message.nextAction === "continue") {
      const state = await this.stateStore.load();
      const lastSuccessfulSendAt = this.now();
      await this.saveState({
        ...state,
        connectorId: batch.connectorId,
        customerId: batch.customerId,
        mappingVersion: batch.mappingVersion,
        selectedProductTable: this.activeMapping?.selectedProductTable,
        cursorField: this.activeMapping?.cursorField,
        cursorType: this.activeMapping?.cursorType,
        sourceProductCodeField: this.activeMapping?.fields.sourceProductCode,
        lastAckedCursor: batch.cursorAfter,
        lastSuccessfulSendAt,
        lastBatchId: batch.batchId
      });
      this.inFlightBatch = undefined;
      this.logger.info("cursor advanced", {
        connectorId: batch.connectorId,
        customerId: batch.customerId,
        mappingVersion: batch.mappingVersion,
        batchId: batch.batchId,
        cursorAfter: batch.cursorAfter,
        lastSuccessfulSendAt
      });
      this.sendHeartbeat(lastSuccessfulSendAt);
      this.scheduleNextPoll();
      return;
    }

    this.inFlightBatch = undefined;
    if (message.nextAction === "reload_config") {
      this.pausePolling("ack requested config reload");
      return;
    }

    this.lastErrorCode = message.errorCode ?? "BATCH_NOT_ACCEPTED";
    this.logger.warn("batch_ack.no_cursor_advance", {
      batchId: message.batchId,
      accepted: message.accepted,
      nextAction: message.nextAction,
      errorCode: message.errorCode
    });
    this.scheduleNextPoll();
  }

  private async runPollCycle(): Promise<void> {
    if (this.stopped || this.pollingPaused || !this.poller) {
      return;
    }

    this.stopPollTimer();
    this.pendingPoll = this.poller
      .pollOnce()
      .then((result) => {
        if (result.status === "batch" && result.batch) {
          this.transport.sendBatch(result.batch, this.now());
          this.inFlightBatch = result.batch;
          return;
        }
        this.scheduleNextPoll();
      })
      .catch((error) => {
        this.handleRuntimeError("POLL_FAILED", error);
        this.scheduleNextPoll();
      })
      .finally(() => {
        this.pendingPoll = undefined;
      });

    await this.pendingPoll;
  }

  private pausePolling(reason: string): void {
    this.pollingPaused = true;
    this.stopPollTimer();
    this.logger.info("polling.paused", {
      reason,
      mappingVersion: this.activeMapping?.mappingVersion
    });
  }

  private scheduleNextPoll(delayMs = this.activeMapping?.pollIntervalMs ?? 0): void {
    if (this.stopped || this.pollingPaused || this.inFlightBatch) {
      return;
    }
    this.stopPollTimer();
    this.pollTimer = this.timers.setTimeout(() => {
      void this.runPollCycle();
    }, delayMs);
  }

  private stopPollTimer(): void {
    if (this.pollTimer !== undefined) {
      this.timers.clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async saveState(state: ConnectorState): Promise<void> {
    this.pendingStateWrite = this.pendingStateWrite.then(() => this.stateStore.save(state));
    await this.pendingStateWrite;
  }

  private async ensureAdapterConnected(): Promise<void> {
    if (this.adapterConnected) {
      return;
    }

    await this.adapter.connect();
    this.adapterConnected = true;
  }

  private sendHeartbeat(lastSuccessfulSendAt?: string): void {
    try {
      this.transport.sendHeartbeat({
        connectorVersion: CONNECTOR_VERSION,
        mappingVersion: this.activeMapping?.mappingVersion,
        lastSuccessfulSendAt,
        lastErrorCode: this.lastErrorCode,
        sentAt: this.now()
      });
    } catch {
      // Heartbeat is best-effort; polling readiness still comes from transport state.
    }
  }

  private handleRuntimeError(errorCode: string, error: unknown): void {
    this.lastErrorCode = errorCode;
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error("runtime.error", {
      errorCode,
      message,
      mappingVersion: this.activeMapping?.mappingVersion
    });
    try {
      this.transport.sendConnectorError(
        {
          errorCode,
          message,
          ...this.activeStateIdentity(),
          mappingVersion: this.activeMapping?.mappingVersion
        },
        this.now()
      );
    } catch {
      // The transport may be offline while reporting the runtime error.
    }
  }

  private activeStateIdentity(): Pick<ConnectorState, "connectorId" | "customerId"> {
    return {
      connectorId: this.inFlightBatch?.connectorId ?? this.activeConnectorId,
      customerId: this.inFlightBatch?.customerId ?? this.activeCustomerId
    };
  }
}

export async function startConnectorRuntime(options: ConnectorRuntimeOptions = {}): Promise<ConnectorRuntime> {
  const runtime = new ConnectorRuntime(options);
  await runtime.start();
  return runtime;
}

export function defaultStateFilePath(programData = process.env.PROGRAMDATA): string {
  const root = programData && programData.trim().length > 0 ? programData : join(homedir(), "AppData", "Local");
  return join(root, "PharmaAgentConnector", STATE_FILE_NAME);
}

function createOptionalDriverDependencies(): AdapterFactoryDependencies {
  return {
    mysqlConnectionFactory: async (config) => {
      const mysql = await optionalImport("mysql2/promise");
      const connection = await mysql.createConnection({
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: config.password
      });
      return {
        query: (sql, params) => connection.query(sql, params),
        end: () => connection.end()
      };
    },
    firebirdConnectionFactory: async (config) => {
      const firebird = await optionalImport("node-firebird");
      return await attachFirebirdConnection(
        firebird as {
          attach: (
            options: Record<string, unknown>,
            callback: (error: Error | undefined, db: { query: Function; detach: Function }) => void
          ) => void;
        },
        config
      );
    }
  };
}

async function optionalImport(specifier: string): Promise<any> {
  try {
    const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
    return await dynamicImport(specifier);
  } catch (error) {
    throw new Error(`Database driver package is not available: ${specifier}`);
  }
}

function canReuseAcknowledgedCursor(
  previous: ConnectorState,
  nextMapping: ValidatedMappingConfig
): boolean {
  if (previous.lastAckedCursor === undefined || previous.lastAckedCursor === null) {
    return false;
  }

  return (
    previous.cursorField === nextMapping.cursorField &&
    previous.cursorType === nextMapping.cursorType &&
    previous.sourceProductCodeField === nextMapping.fields.sourceProductCode &&
    previous.selectedProductTable === nextMapping.selectedProductTable
  );
}
