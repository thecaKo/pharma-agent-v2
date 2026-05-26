import path from "node:path";
import { homedir } from "node:os";
import { configSecrets, loadConfig, type ConnectorStartupConfig, type Environment } from "../config/env.js";
import type { ConnectorConfig, DatabaseConfig } from "../config/types.js";
import {
  createSourceDatabaseAdapter,
  type AdapterFactoryDependencies
} from "../db/adapter-factory.js";
import { attachFirebirdConnection } from "../db/firebird-driver.js";
import type { SourceDatabaseAdapter } from "../db/source-adapter.js";
import { createLogger, type Logger } from "../logging/logger.js";
import { redactString } from "../logging/redact.js";
import { collectStartupDiagnostics, defaultServiceLogPath } from "../logging/startup-diagnostics.js";
import type { ValidatedMappingConfig } from "../mapping/types.js";
import { validateMappingConfig } from "../mapping/validate.js";
import { IncrementalPoller } from "../poller/incremental-poller.js";
import type { ProductChangeBatch } from "../poller/batch-builder.js";
import { SnapshotPoller } from "../poller/snapshot-poller.js";
import { StateStore } from "../state/state-store.js";
import { STATE_FILE_NAME, type ConnectorState, type PendingSnapshotProduct } from "../state/state-types.js";
import type {
  BatchAckMessage,
  AdminResponseMessage,
  ConfigUpdatedMessage,
  ConnectorConfigMessage,
  ConnectorErrorPayload
} from "../transport/protocol.js";
import { buildAdminErrorResponseMessage, buildAdminSuccessResponseMessage } from "../transport/protocol.js";
import {
  buildSetupConfigFailureResult,
  buildSetupConfigSuccessResult,
  SETUP_CONFIG_VALIDATION_FAILED_ERROR_CODE,
  SETUP_CONNECTION_FAILED_ERROR_CODE,
  setupConfigToDatabaseConfig,
  type ConnectorSetupConfigCommand,
  type ConnectorSetupConfigResultMessage
} from "../transport/connector-setup-ws.js";
import {
  buildFileDiscoveryScanFailureResult,
  buildFileDiscoveryScanSuccessResult,
  scanLocalFilesystem,
  type FileDiscoveryScanResultMessage
} from "../transport/file-discovery-ws.js";
import {
  normalizeSchemaDiscoveryColumns,
  SCHEMA_DISCOVERY_MAX_TABLE_COUNT,
  type SchemaDiscoveryRequest,
  type SchemaDiscoveryTable
} from "../transport/schema-discovery.js";
import { WebSocketTransportClient } from "../transport/ws-client.js";
import { CONNECTOR_VERSION } from "../version.js";

export interface RuntimeTransport {
  on(event: "connected", listener: () => void): this;
  on(event: "disconnected", listener: (info: unknown) => void): this;
  on(event: "config", listener: (message: ConnectorConfigMessage) => void): this;
  on(event: "batchAck", listener: (message: BatchAckMessage) => void): this;
  on(event: "reloadConfig", listener: (message: BatchAckMessage | ConfigUpdatedMessage) => void): this;
  on(event: "schemaDiscoveryRequest", listener: (request: SchemaDiscoveryRequest) => void): this;
  on(
    event: "fileDiscoveryScanRequest",
    listener: (request: { correlationId: string; rootPath?: string }) => void
  ): this;
  on(event: "setupConfigRequest", listener: (request: ConnectorSetupConfigCommand) => void): this;
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
  sendSchemaTablesListResult(input: { correlationId: string; tables: readonly SchemaDiscoveryTable[] }): void;
  sendFileDiscoveryScanResult(message: FileDiscoveryScanResultMessage): void;
  sendConnectorSetupConfigResult(message: ConnectorSetupConfigResultMessage): void;
  getReconnectAttemptCount(): number;
}

export interface RuntimeTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface ConnectorRuntimeOptions {
  env?: Environment;
  allowMissingDatabaseConfig?: boolean;
  logger?: Logger;
  stateStore?: StateStore;
  stateFilePath?: string;
  startupMetadata?: Record<string, string | boolean | undefined>;
  adapter?: SourceDatabaseAdapter;
  adapterDependencies?: AdapterFactoryDependencies;
  transport?: RuntimeTransport;
  timers?: RuntimeTimers;
  now?: () => string;
}

export interface ConnectorRuntimeState {
  config: ConnectorRuntimeConfig;
  activeMapping?: ValidatedMappingConfig;
  inFlightBatch?: ProductChangeBatch;
  pollingPaused: boolean;
  stopped: boolean;
}

type ConnectorRuntimeConfig = ConnectorConfig | ConnectorStartupConfig;

class DatabaseConfigurationUnavailableError extends Error {
  public constructor() {
    super("Database configuration is not available yet. Complete database setup before activating mapping or schema discovery.");
    this.name = "DatabaseConfigurationUnavailableError";
  }
}

const defaultTimers: RuntimeTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
};

type ActivePoller = IncrementalPoller | SnapshotPoller;

export class ConnectorRuntime {
  private config: ConnectorRuntimeConfig;
  private readonly env?: Environment;
  private readonly logger: Logger;
  private readonly stateStore: StateStore;
  private readonly stateFilePath: string;
  private readonly startupMetadata?: Record<string, string | boolean | undefined>;
  private adapter?: SourceDatabaseAdapter;
  private readonly adapterDependencies: AdapterFactoryDependencies;
  private readonly transport: RuntimeTransport;
  private readonly timers: RuntimeTimers;
  private readonly now: () => string;
  private poller?: ActivePoller;
  private activeMapping?: ValidatedMappingConfig;
  private activeConnectorId?: string;
  private activeCustomerId?: string;
  private inFlightBatch?: ProductChangeBatch;
  private inFlightSnapshotPending?: PendingSnapshotProduct[];
  private inFlightSnapshotFieldsSignature?: string;
  private pollTimer?: unknown;
  private heartbeatIntervalHandle?: unknown;
  private pendingPoll?: Promise<void>;
  private pendingStateWrite: Promise<void> = Promise.resolve();
  private pollingPaused = true;
  private stopped = true;
  private adapterConnected = false;
  private lastErrorCode: string | undefined;

  public constructor(options: ConnectorRuntimeOptions = {}) {
    this.env = options.env;
    this.config = options.allowMissingDatabaseConfig
      ? loadConfig(options.env, { requireDatabase: false })
      : loadConfig(options.env);
    this.stateFilePath = options.stateFilePath ?? defaultStateFilePath(options.env?.PROGRAMDATA);
    this.startupMetadata = options.startupMetadata;
    this.logger =
      options.logger ??
      createLogger({
        level: this.config.logLevel,
        secrets: runtimeConfigSecrets(this.config),
        nodeEnv: options.env?.NODE_ENV ?? options.env?.node_env
      });
    this.stateStore =
      options.stateStore ??
      new StateStore({
        stateFilePath: this.stateFilePath
      });
    this.adapterDependencies = options.adapterDependencies ?? createOptionalDriverDependencies();
    this.adapter = options.adapter;
    if (!this.adapter && this.config.database) {
      this.adapter = createSourceDatabaseAdapter({
        config: this.config.database,
        dependencies: this.adapterDependencies,
        secrets: runtimeConfigSecrets(this.config)
      });
    }
    this.transport =
      options.transport ??
      new WebSocketTransportClient({
        url: this.config.websocketUrl,
        connectorToken: this.config.connectorToken,
        logger: this.logger,
        pingIntervalMs: this.config.wsPingIntervalMs,
        pongTimeoutMs: this.config.wsPongTimeoutMs
      });
    this.timers = options.timers ?? defaultTimers;
    this.now = options.now ?? (() => new Date().toISOString());
    this.bindTransportEvents();
  }

  public async start(): Promise<void> {
    this.stopped = false;
    this.logger.info("service.startup", {
      version: CONNECTOR_VERSION,
      dbDriver: this.config.database?.driver,
      databaseConfigured: this.config.database !== undefined,
      stateFilePath: this.stateFilePath,
      logPath: defaultServiceLogPath(this.configuredProgramDataPath())
    });
    const databaseConfig = this.config.database;
    this.logger.info("configuration.loaded", {
      websocketUrl: this.config.websocketUrl,
      websocketUrlConfigured: this.config.websocketUrl.trim().length > 0,
      databaseConfigured: databaseConfig !== undefined,
      ...(databaseConfig
        ? {
            dbDriver: databaseConfig.driver,
            dbHost: databaseConfig.host,
            dbPort: databaseConfig.port,
            dbName: databaseConfig.name,
            dbUser: databaseConfig.user
          }
        : {})
    });
    if (!databaseConfig) {
      this.logger.warn("service.setup_waiting", {
        databaseConfigured: false,
        stateFilePath: this.stateFilePath,
        logPath: defaultServiceLogPath(this.configuredProgramDataPath())
      });
    }
    const diagnostics = await collectStartupDiagnostics({
      baseDir: process.cwd(),
      programData: this.configuredProgramDataPath(),
      stateFilePath: this.stateFilePath,
      databaseConfigured: databaseConfig !== undefined,
      websocketUrlConfigured: this.config.websocketUrl.trim().length > 0,
      dbDriver: databaseConfig?.driver,
      startupMetadata: this.startupMetadata
    });
    for (const warning of diagnostics.warnings) {
      this.logger.warn(warning.event, {
        dependency: warning.dependency,
        path: warning.path,
        message: warning.message
      });
    }
    this.logger.info("diagnostics.startup_report", { ...diagnostics.report });

    await this.transport.connect();
    await this.resumeSavedMappingIfAvailable();
  }

  public async shutdown(): Promise<void> {
    this.stopHeartbeatLoop();
    this.stopped = true;
    this.pollingPaused = true;
    this.stopPollTimer();

    await this.pendingPoll?.catch(() => undefined);
    await this.pendingStateWrite;
    await this.transport.close();
    if (this.adapterConnected && this.adapter) {
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
      this.startHeartbeatLoop();
    });
    this.transport.on("disconnected", () => {
      this.logger.warn("websocket.disconnected", {
        mappingVersion: this.activeMapping?.mappingVersion
      });
      this.stopHeartbeatLoop();
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
    this.transport.on("schemaDiscoveryRequest", (request) => {
      this.handleSchemaDiscovery(request).catch((error) => this.handleRuntimeError("ADMIN_REQUEST_FAILED", error));
    });
    this.transport.on("fileDiscoveryScanRequest", (request) => {
      this.handleFileDiscoveryScan(request).catch((error) => this.handleRuntimeError("FILE_DISCOVERY_FAILED", error));
    });
    this.transport.on("setupConfigRequest", (request) => {
      this.handleSetupConfig(request).catch((error) =>
        this.handleRuntimeError("SETUP_CONFIG_FAILED", error)
      );
    });
  }

  private async handleConfig(message: ConnectorConfigMessage): Promise<void> {
    this.pausePolling("mapping activation");

    const mapping = validateMappingConfig(message.mapping);
    await this.activateMapping({
      connectorId: message.connectorId,
      customerId: message.customerId,
      mapping
    });
  }

  private async resumeSavedMappingIfAvailable(): Promise<void> {
    const state = await this.stateStore.load();
    if (!state.connectorId || !state.customerId || !state.mapping) {
      return;
    }

    try {
      const mapping = validateMappingConfig(state.mapping);
      await this.activateMapping({
        connectorId: state.connectorId,
        customerId: state.customerId,
        mapping,
        previousState: state,
        reason: "saved mapping resume"
      });
    } catch (error) {
      this.logger.warn("mapping.resume_failed", {
        errorCode: "SAVED_MAPPING_INVALID",
        message: error instanceof Error ? error.message : String(error),
        connectorId: state.connectorId,
        customerId: state.customerId,
        mappingVersion: state.mappingVersion
      });
    }
  }

  private async activateMapping(input: {
    connectorId: string;
    customerId: string;
    mapping: ValidatedMappingConfig;
    previousState?: ConnectorState;
    reason?: string;
  }): Promise<void> {
    const { connectorId, customerId, mapping } = input;
    const adapter = await this.ensureAdapterConnected();

    const previous = input.previousState ?? (await this.stateStore.load());
    const keepCursor = canReuseAcknowledgedCursor(previous, mapping);
    const nextState: ConnectorState = {
      connectorId,
      customerId,
      mapping,
      mappingVersion: mapping.mappingVersion,
      selectedProductTable: mapping.selectedProductTable,
      cursorField: mapping.syncMode === "incremental" ? mapping.cursorField : undefined,
      cursorType: mapping.syncMode === "incremental" ? mapping.cursorType : undefined,
      sourceProductCodeField: mapping.fields.sourceProductCode,
      lastAckedCursor: keepCursor ? previous.lastAckedCursor ?? null : null,
      lastSuccessfulSendAt: previous.lastSuccessfulSendAt,
      lastBatchId: previous.lastBatchId
    };
    await this.saveState(nextState);

    this.activeMapping = mapping;
    this.activeConnectorId = connectorId;
    this.activeCustomerId = customerId;
    this.inFlightBatch = undefined;
    this.inFlightSnapshotPending = undefined;
    this.inFlightSnapshotFieldsSignature = undefined;
    this.poller =
      mapping.syncMode === "snapshot"
        ? new SnapshotPoller({
            adapter,
            mapping,
            state: this.stateStore,
            connectorId,
            customerId,
            isTransportReady: () => this.transport.isConnected(),
            hasUnacknowledgedBatch: () => this.inFlightBatch !== undefined,
            logger: this.logger,
            now: this.now
          })
        : new IncrementalPoller({
            adapter,
            mapping,
            state: this.stateStore,
            connectorId,
            customerId,
            isTransportReady: () => this.transport.isConnected(),
            hasUnacknowledgedBatch: () => this.inFlightBatch !== undefined,
            logger: this.logger,
            now: this.now
          });
    this.pollingPaused = false;

    this.logger.info("mapping.active", {
      connectorId,
      customerId,
      mappingVersion: mapping.mappingVersion,
      ...(input.reason ? { reason: input.reason } : {}),
      pollIntervalMs: mapping.pollIntervalMs,
      batchSize: mapping.batchSize,
      ...(mapping.selectedProductTable ? { selectedProductTable: mapping.selectedProductTable } : {})
    });
    this.sendHeartbeat();
    this.scheduleNextPoll(0);
  }

  private async handleSchemaDiscovery(request: SchemaDiscoveryRequest): Promise<void> {
    const identity = this.activeStateIdentity();
    const correlationId = request.correlationId;
    const command = request.responseFormat === "admin" ? request.command : "schema.listTables";

    this.logger.info("schema.discovery.received", {
      correlationId,
      responseFormat: request.responseFormat,
      command,
      connectorId: identity.connectorId,
      customerId: identity.customerId
    });

    try {
      const snapshot = await this.discoverSchemaSnapshot();
      if (request.responseFormat === "legacy") {
        this.transport.sendSchemaTablesListResult({
          correlationId,
          tables: snapshot
        });
        return;
      }

      const response = buildAdminSuccessResponseMessage(
        {
          requestId: correlationId,
          command,
          tables: snapshot.map((table) => table.name)
        },
        this.now()
      );
      this.transport.sendAdminResponse(response);
      this.logger.info("admin.response.sent", {
        requestId: response.requestId,
        command: response.command,
        ok: response.ok,
        tableCount: snapshot.length
      });
    } catch (error) {
      const errorInput = {
        errorCode: "TABLE_DISCOVERY_FAILED",
        message: error instanceof Error ? error.message : String(error)
      };

      if (request.responseFormat === "legacy") {
        this.logger.warn("schema.discovery.failed", {
          correlationId,
          errorCode: errorInput.errorCode,
          message: errorInput.message
        });
        return;
      }

      const response = buildAdminErrorResponseMessage(
        {
          requestId: correlationId,
          command,
          errorCode: errorInput.errorCode,
          message: errorInput.message,
          secrets: runtimeConfigSecrets(this.config)
        },
        this.now()
      );

      this.logger.warn("admin.request.failed", {
        requestId: correlationId,
        command,
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

  private async handleSetupConfig(request: ConnectorSetupConfigCommand): Promise<void> {
    const correlationId = request.correlationId;

    this.pausePolling("database setup reload");
    await this.pendingPoll?.catch(() => undefined);
    this.logger.info("setup.config.received", {
      correlationId,
      setupMethod: request.setupMethod,
      driver: request.driver
    });

    let databaseConfig: DatabaseConfig;
    try {
      databaseConfig = setupConfigToDatabaseConfig(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("setup.config.validation_failed", {
        correlationId,
        setupMethod: request.setupMethod,
        driver: request.driver,
        errorCode: SETUP_CONFIG_VALIDATION_FAILED_ERROR_CODE,
        message
      });
      this.transport.sendConnectorSetupConfigResult(
        buildSetupConfigFailureResult(correlationId, {
          errorCode: SETUP_CONFIG_VALIDATION_FAILED_ERROR_CODE,
          message
        })
      );
      return;
    }

    const secrets = configSecrets({
      connectorToken: this.config.connectorToken,
      database: databaseConfig
    });
    const candidateAdapter = createSourceDatabaseAdapter({
      config: databaseConfig,
      dependencies: this.adapterDependencies,
      secrets
    });
    this.logger.info("setup.config.connection_test_started", {
      correlationId,
      setupMethod: request.setupMethod,
      driver: request.driver,
      dbHost: databaseConfig.host,
      dbPort: databaseConfig.port,
      dbName: databaseConfig.name,
      dbUser: databaseConfig.user
    });

    try {
      await candidateAdapter.connect();
    } catch (error) {
      await candidateAdapter.close().catch(() => undefined);
      const message = redactString(
        error instanceof Error ? error.message : String(error),
        secrets
      );
      this.transport.sendConnectorSetupConfigResult(
        buildSetupConfigFailureResult(correlationId, {
          errorCode: SETUP_CONNECTION_FAILED_ERROR_CODE,
          message
        })
      );
      this.logger.warn("setup.config.connection_failed", {
        correlationId,
        setupMethod: request.setupMethod,
        driver: request.driver,
        message
      });
      return;
    }

    const previousAdapter = this.adapter;
    this.config = {
      ...this.config,
      database: databaseConfig
    };
    this.adapter = candidateAdapter;
    this.adapterConnected = true;
    await previousAdapter?.close().catch(() => undefined);

    if (this.activeMapping && this.poller) {
      this.poller = new IncrementalPoller({
        adapter: candidateAdapter,
        mapping: this.activeMapping,
        state: this.stateStore,
        connectorId: this.activeConnectorId ?? this.inFlightBatch?.connectorId ?? "",
        customerId: this.activeCustomerId ?? this.inFlightBatch?.customerId ?? "",
        isTransportReady: () => this.transport.isConnected(),
        hasUnacknowledgedBatch: () => this.inFlightBatch !== undefined,
        logger: this.logger,
        now: this.now
      });
    }

    this.transport.sendConnectorSetupConfigResult(
      buildSetupConfigSuccessResult(correlationId, request)
    );
    this.logger.info("setup.config.applied", {
      correlationId,
      setupMethod: request.setupMethod,
      driver: request.driver,
      dbHost: databaseConfig.host,
      dbPort: databaseConfig.port,
      dbName: databaseConfig.name,
      dbUser: databaseConfig.user
    });
  }

  private async handleFileDiscoveryScan(request: { correlationId: string; rootPath?: string }): Promise<void> {
    const correlationId = request.correlationId;
    const identity = this.activeStateIdentity();

    this.logger.info("file.discovery.received", {
      correlationId,
      connectorId: identity.connectorId,
      customerId: identity.customerId
    });

    const rawRoot =
      typeof request.rootPath === "string" ? request.rootPath.trim() : undefined;

    const scan = await scanLocalFilesystem(rawRoot);

    const message = scan.ok
      ? buildFileDiscoveryScanSuccessResult(correlationId, scan.entries)
      : buildFileDiscoveryScanFailureResult(correlationId, scan.failureReason);

    this.transport.sendFileDiscoveryScanResult(message);
  }

  private async discoverSchemaSnapshot(): Promise<SchemaDiscoveryTable[]> {
    const adapter = await this.ensureAdapterConnected();
    const tables = await adapter.listTables();
    const limitedTables =
      tables.length > SCHEMA_DISCOVERY_MAX_TABLE_COUNT ? tables.slice(0, SCHEMA_DISCOVERY_MAX_TABLE_COUNT) : tables;

    if (tables.length > SCHEMA_DISCOVERY_MAX_TABLE_COUNT) {
      this.logger.warn("schema.discovery.truncated", {
        field: "tables",
        totalCount: tables.length,
        returnedCount: limitedTables.length
      });
    }

    const snapshot: SchemaDiscoveryTable[] = [];
    for (const table of limitedTables) {
      const columns = await adapter.listColumns(table.name);
      snapshot.push({
        name: table.name,
        columns: normalizeSchemaDiscoveryColumns(columns)
      });
    }

    return snapshot.sort((left, right) => left.name.localeCompare(right.name));
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
      const snapshotState = this.buildAcceptedSnapshotState(state, batch.batchId);
      await this.saveState({
        ...state,
        connectorId: batch.connectorId,
        customerId: batch.customerId,
        mappingVersion: batch.mappingVersion,
        selectedProductTable: this.activeMapping?.selectedProductTable,
        cursorField: this.activeMapping?.syncMode === "incremental" ? this.activeMapping.cursorField : undefined,
        cursorType: this.activeMapping?.syncMode === "incremental" ? this.activeMapping.cursorType : undefined,
        sourceProductCodeField: this.activeMapping?.fields.sourceProductCode,
        lastAckedCursor: batch.cursorAfter,
        lastSuccessfulSendAt,
        lastBatchId: batch.batchId,
        snapshotState
      });
      this.inFlightBatch = undefined;
      this.inFlightSnapshotPending = undefined;
      this.inFlightSnapshotFieldsSignature = undefined;
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
          if ("snapshotPending" in result) {
            this.inFlightSnapshotPending = result.snapshotPending;
            this.inFlightSnapshotFieldsSignature = result.fieldsSignature;
          } else {
            this.inFlightSnapshotPending = undefined;
            this.inFlightSnapshotFieldsSignature = undefined;
          }
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
    this.logger.info("poll scheduled", {
      delayMs,
      mappingVersion: this.activeMapping?.mappingVersion
    });
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

  private async ensureAdapterConnected(): Promise<SourceDatabaseAdapter> {
    const adapter = this.adapter;
    if (!adapter) {
      this.logger.warn("database.config.missing", {
        databaseConfigured: false,
        stateFilePath: this.stateFilePath
      });
      throw new DatabaseConfigurationUnavailableError();
    }

    if (this.adapterConnected) {
      return adapter;
    }

    try {
      await adapter.connect();
      this.adapterConnected = true;
      this.logger.info("database.connected", {
        dbDriver: this.config.database?.driver,
        dbHost: this.config.database?.host,
        dbPort: this.config.database?.port,
        dbName: this.config.database?.name,
        dbUser: this.config.database?.user
      });
      return adapter;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("database.connection_failed", {
        dbDriver: this.config.database?.driver,
        message
      });
      throw error;
    }
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("heartbeat.send.failed", {
        message,
        mappingVersion: this.activeMapping?.mappingVersion
      });
    }
  }

  private startHeartbeatLoop(): void {
    this.stopHeartbeatLoop();
    this.heartbeatIntervalHandle = this.timers.setInterval(() => {
      this.sendHeartbeat();
    }, this.config.heartbeatIntervalMs);
  }

  private stopHeartbeatLoop(): void {
    if (this.heartbeatIntervalHandle !== undefined) {
      this.timers.clearInterval(this.heartbeatIntervalHandle);
      this.heartbeatIntervalHandle = undefined;
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

  private buildAcceptedSnapshotState(
    state: ConnectorState,
    batchId: string
  ): ConnectorState["snapshotState"] | undefined {
    if (!this.inFlightSnapshotPending || !this.inFlightSnapshotFieldsSignature || !this.inFlightBatch) {
      return state.snapshotState;
    }

    const confirmedCodes = new Set(this.inFlightBatch.records.map((record) => record.sourceProductCode));
    const now = this.now();
    const products =
      state.snapshotState?.fieldsSignature === this.inFlightSnapshotFieldsSignature
        ? { ...state.snapshotState.products }
        : {};
    const pending: PendingSnapshotProduct[] = [];

    for (const entry of this.inFlightSnapshotPending) {
      if (confirmedCodes.has(entry.sourceProductCode)) {
        products[entry.sourceProductCode] = {
          hash: entry.hash,
          lastSeenAt: now,
          lastConfirmedAt: now
        };
        continue;
      }
      pending.push(entry);
    }

    return {
      fieldsSignature: this.inFlightSnapshotFieldsSignature,
      products,
      pending
    };
  }

  private configuredProgramDataPath(): string | undefined {
    const value = this.env?.PROGRAMDATA;
    return value && value.trim().length > 0 ? value : undefined;
  }
}

export async function startConnectorRuntime(options: ConnectorRuntimeOptions = {}): Promise<ConnectorRuntime> {
  const runtime = new ConnectorRuntime(options);
  try {
    await runtime.start();
  } catch (error) {
    await runtime.shutdown();
    throw error;
  }
  return runtime;
}

export function defaultStateFilePath(programData = process.env.PROGRAMDATA): string {
  const root = programData && programData.trim().length > 0 ? programData : path.join(homedir(), "AppData", "Local");
  return path.join(root, "PharmaAgentConnector", STATE_FILE_NAME);
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
    },
    postgresConnectionFactory: async (config) => {
      const pg = await optionalImport("pg");
      const ClientCtor = pg.Client ?? pg.default?.Client;
      const client = new ClientCtor({
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: config.password
      });
      await client.connect();
      return {
        query: (sql, params) => client.query(sql, params),
        end: () => client.end()
      };
    }
  };
}

function runtimeConfigSecrets(config: ConnectorRuntimeConfig): string[] {
  return [config.connectorToken, config.database?.password].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
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
  if (nextMapping.syncMode !== "incremental") {
    return false;
  }

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
