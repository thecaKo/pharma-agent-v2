import path from "node:path";
import { homedir } from "node:os";
import { configSecrets, loadConfig, type ConnectorStartupConfig, type Environment } from "../config/env.js";
import type { ConnectorConfig, DatabaseConfig } from "../config/types.js";
import {
  createSourceDatabaseAdapter,
  type AdapterFactoryDependencies
} from "../db/adapter-factory.js";
import { attachFirebirdConnection } from "../db/firebird-driver.js";
import { discoverPostgresDsns, type PostgresDsnCandidate } from "../db/dsn-discovery.js";
import { createRegExeRegistryReader } from "../db/registry-reader.js";
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
  AdminRequestMessage,
  AdminResponseMessage,
  BootstrapDbConfigMessage,
  ConfigUpdatedMessage,
  ConnectorConfigMessage,
  ConnectorDiscoveryMessage,
  ConnectorErrorPayload
} from "../transport/protocol.js";
import {
  buildAdminErrorResponseMessage,
  buildAdminSuccessResponseMessage,
  buildConnectorDiscoveryMessage,
  buildProvisionReadonlyUserResult,
  type ProvisionReadonlyUserMessage,
  type ProvisionReadonlyUserResultMessage,
  type ProvisionErrorCode
} from "../transport/protocol.js";
import {
  writeDatabaseConfig,
  writeReadonlyProvisioningConfig,
  type ReadonlyProvisioningMetadata
} from "../config/programdata-config.js";
import { generateReadonlyPassword } from "../db/provision-password.js";
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
import { BootstrapState } from "./bootstrap-state.js";
import { handleAdminRequest, type AdminRouterDependencies } from "../discovery/admin-router.js";
import { AiSessionManager } from "./ai-session-manager.js";
import { buildAiSessionDeps, buildRuntimeAdminDeps } from "./ai-session-wiring.js";
import type {
  AiSessionStartCommand,
  ToolInvokeCommand,
  MappingDecisionCommand,
  AiSessionAbortCommand
} from "../ai-session/ai-protocol.js";
import type { AiSessionOutboundMessage } from "../ai-session/ai-session.js";
import { probeEngines } from "../discovery/engines.js";
import { probeOdbcDsns } from "../discovery/odbc-dsns.js";
import { probeNetwork, tcpProbe } from "../discovery/network.js";
import { probeTestConnection } from "../discovery/test-connection.js";
import { listWindowsServices } from "../discovery/service-list.js";
import { nodeFileSystemReader } from "../discovery/fs-reader.js";
import { probeProcesses } from "../discovery/processes.js";
import { probeConnections } from "../discovery/connections.js";
import { probeScanConfigDirs } from "../discovery/scan-config-dirs.js";
import { listWindowsProcesses } from "../discovery/process-list.js";
import { listWindowsConnections } from "../discovery/connection-list.js";
import type { ProbeContext } from "../discovery/types.js";
import { CONNECTOR_VERSION } from "../version.js";

type ProbeRouterDependencies = Pick<
  AdminRouterDependencies,
  | "probeEngines"
  | "probeOdbcDsns"
  | "probeNetwork"
  | "probeTestConnection"
  | "probeProcesses"
  | "probeConnections"
  | "probeScanConfigDirs"
  | "schemaListTables"
>;

export interface RuntimeTransport {
  on(event: "connected", listener: () => void): this;
  on(event: "disconnected", listener: (info: unknown) => void): this;
  on(event: "config", listener: (message: ConnectorConfigMessage) => void): this;
  on(event: "batchAck", listener: (message: BatchAckMessage) => void): this;
  on(event: "reloadConfig", listener: (message: BatchAckMessage | ConfigUpdatedMessage) => void): this;
  on(event: "adminRequest", listener: (request: AdminRequestMessage) => void): this;
  on(event: "schemaDiscoveryRequest", listener: (request: SchemaDiscoveryRequest) => void): this;
  on(
    event: "fileDiscoveryScanRequest",
    listener: (request: { correlationId: string; rootPath?: string }) => void
  ): this;
  on(event: "setupConfigRequest", listener: (request: ConnectorSetupConfigCommand) => void): this;
  on(event: "bootstrapDbConfig", listener: (message: BootstrapDbConfigMessage) => void): this;
  on(event: "aiSessionStart", listener: (command: AiSessionStartCommand) => void): this;
  on(event: "aiToolInvoke", listener: (command: ToolInvokeCommand) => void): this;
  on(event: "aiMappingDecision", listener: (command: MappingDecisionCommand) => void): this;
  on(event: "aiSessionAbort", listener: (command: AiSessionAbortCommand) => void): this;
  on(event: "provisionReadonlyUser", listener: (message: ProvisionReadonlyUserMessage) => void): this;
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
    state: "bootstrap" | "synced";
    bootstrap?: {
      probesRunTotal: number;
      lastProbeAt?: string;
      lastProbeError?: { command: string; code: string };
    };
  }): void;
  sendConnectorError(input: ConnectorErrorPayload, sentAt?: string): void;
  sendAdminResponse(message: AdminResponseMessage): void;
  sendSchemaTablesListResult(input: { correlationId: string; tables: readonly SchemaDiscoveryTable[] }): void;
  sendFileDiscoveryScanResult(message: FileDiscoveryScanResultMessage): void;
  sendConnectorSetupConfigResult(message: ConnectorSetupConfigResultMessage): void;
  sendConnectorDiscovery(message: ConnectorDiscoveryMessage): void;
  sendAiSessionMessage(message: AiSessionOutboundMessage): void;
  sendProvisionReadonlyUserResult(message: ProvisionReadonlyUserResultMessage): void;
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
  discoverDsns?: () => Promise<PostgresDsnCandidate[]>;
  discoveryTimeoutMs?: number;
  createReadonlyAdapter?: (database: DatabaseConfig) => SourceDatabaseAdapter;
  writeReadonlyProvisioningConfig?: (
    programData: string | undefined,
    input: { database: DatabaseConfig; readonlyProvisioning: ReadonlyProvisioningMetadata }
  ) => Promise<void>;
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
  private aiSessionManager?: AiSessionManager;
  private aiSessionPreviousMapping?: ValidatedMappingConfig;
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
  private readonly discoverDsnsFn: () => Promise<PostgresDsnCandidate[]>;
  private readonly discoveryTimeoutMs: number;
  private discoverySnapshotPromise?: Promise<PostgresDsnCandidate[]>;
  private hasEmittedDiscoverySnapshot = false;
  private readonly bootstrapState = new BootstrapState();
  private readonly createReadonlyAdapterFn: (database: DatabaseConfig) => SourceDatabaseAdapter;
  private readonly writeReadonlyProvisioningFn: (
    programData: string | undefined,
    input: { database: DatabaseConfig; readonlyProvisioning: ReadonlyProvisioningMetadata }
  ) => Promise<void>;

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
    this.discoverDsnsFn =
      options.discoverDsns ?? (() => discoverPostgresDsns(createRegExeRegistryReader()));
    this.discoveryTimeoutMs = options.discoveryTimeoutMs ?? 3000;
    this.createReadonlyAdapterFn =
      options.createReadonlyAdapter ??
      ((database) =>
        createSourceDatabaseAdapter({
          config: database,
          dependencies: this.adapterDependencies,
          secrets: runtimeConfigSecrets(this.config)
        }));
    this.writeReadonlyProvisioningFn =
      options.writeReadonlyProvisioningConfig ?? writeReadonlyProvisioningConfig;
    this.bindTransportEvents();
  }

  public async start(): Promise<void> {
    this.discoverySnapshotPromise = this.discoverDsnsFn().catch((error) => {
      this.logger.warn("dsn.discovery_failed", {
        message: error instanceof Error ? error.message : String(error)
      });
      return [];
    });
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
      this.emitDiscoverySnapshotOnce().catch((error) => {
        this.logger.warn("dsn.discovery_emit_failed", {
          message: error instanceof Error ? error.message : String(error)
        });
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
    this.transport.on("adminRequest", (request) => {
      if (request.command === "schema.listTables") {
        return; // Handled by handleSchemaDiscovery via schemaDiscoveryRequest event
      }
      this.handleProbeAdminRequest(request).catch((error) =>
        this.handleRuntimeError("ADMIN_REQUEST_FAILED", error)
      );
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
    this.transport.on("bootstrapDbConfig", (message) => {
      this.applyBootstrapDbConfig(message).catch((error) =>
        this.handleRuntimeError("BOOTSTRAP_DB_CONFIG_FAILED", error)
      );
    });
    this.transport.on("provisionReadonlyUser", (message) => {
      this.handleProvisionReadonlyUser(message).catch((error) =>
        this.handleRuntimeError("PROVISION_READONLY_FAILED", error)
      );
    });

    const manager = new AiSessionManager({
      emit: (message) => this.transport.sendAiSessionMessage(message),
      buildDeps: () =>
        buildAiSessionDeps({
          handleAdminRequest: (req) => handleAdminRequest(req, this.buildFullAdminRouterDeps()),
          secrets: () => runtimeConfigSecrets(this.config),
          now: this.now,
          writeDatabaseConfig,
          programData: this.configuredProgramDataPath(),
          currentDatabase: () => this.config.database,
          currentEngine: () => this.config.database?.driver ?? "unknown",
          activateMapping: (mapping) =>
            this.activateMapping({
              connectorId: this.activeConnectorId ?? "ai-session",
              customerId: this.activeCustomerId ?? "ai-session",
              mapping
            })
        }),
      onSessionStart: () => this.pauseForAiSession(),
      onSessionEnded: ({ applied }) => {
        if (!applied) {
          this.resumePollingAfterAiSession();
        }
      }
    });
    this.aiSessionManager = manager;
    this.transport.on("aiSessionStart", (command) => {
      void manager.onStart(command);
    });
    this.transport.on("aiToolInvoke", (command) => {
      void manager.onToolInvoke(command);
    });
    this.transport.on("aiMappingDecision", (command) => {
      void manager.onDecision(command);
    });
    this.transport.on("aiSessionAbort", (command) => {
      manager.onAbort(command);
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
          payload: { tables: snapshot.map((table) => table.name) }
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

  private async handleProbeAdminRequest(request: AdminRequestMessage): Promise<void> {
    this.logger.info("admin.probe.received", {
      requestId: request.requestId,
      command: request.command
    });
    const deps = this.buildFullAdminRouterDeps();
    const response = await handleAdminRequest(request, deps);
    this.transport.sendAdminResponse(response);
    this.logger.info("admin.probe.responded", {
      requestId: request.requestId,
      command: request.command,
      ok: response.ok
    });
  }

  private buildAdminRouterDeps(): ProbeRouterDependencies {
    const registry = createRegExeRegistryReader();
    const buildProbeContext = (): ProbeContext => ({
      registry,
      fs: nodeFileSystemReader,
      serviceList: listWindowsServices,
      listProcesses: listWindowsProcesses,
      listConnections: listWindowsConnections,
      signal: new AbortController().signal
    });
    const recordSuccess = (cmd: string) => this.bootstrapState.recordProbeSuccess(cmd);
    const recordError = (cmd: string, code: string) => this.bootstrapState.recordProbeError(cmd, code);

    return {
      probeEngines: async () => {
        try {
          const result = await probeEngines(buildProbeContext(), {
            tcpProbe: (host, port, timeoutMs = 3000) => tcpProbe(host, port, timeoutMs)
          });
          recordSuccess("probe.engines");
          return result;
        } catch (err) {
          recordError("probe.engines", "internal");
          throw err;
        }
      },
      probeOdbcDsns: async () => {
        try {
          const result = await probeOdbcDsns(registry);
          recordSuccess("probe.odbc_dsns");
          return result;
        } catch (err) {
          recordError("probe.odbc_dsns", "internal");
          throw err;
        }
      },
      probeNetwork: async (input) => {
        try {
          const result = await probeNetwork(input);
          if (result.reachable) recordSuccess("probe.network");
          else recordError("probe.network", result.error ?? "unknown");
          return result;
        } catch (err) {
          recordError("probe.network", "internal");
          throw err;
        }
      },
      probeTestConnection: async (input) => {
        try {
          const result = await probeTestConnection(input, {
            createAdapter: (config) =>
              createSourceDatabaseAdapter({
                config,
                dependencies: this.adapterDependencies
              }),
            timeoutMs: 5000
          });
          if (result.ok) recordSuccess("probe.test_connection");
          else recordError("probe.test_connection", result.code);
          return result;
        } catch (err) {
          recordError("probe.test_connection", "internal");
          throw err;
        }
      },
      probeProcesses: async () => {
        try {
          const result = await probeProcesses(buildProbeContext());
          recordSuccess("probe.processes");
          return result;
        } catch (err) {
          recordError("probe.processes", "internal");
          throw err;
        }
      },
      probeConnections: async () => {
        try {
          const result = await probeConnections(buildProbeContext());
          recordSuccess("probe.connections");
          return result;
        } catch (err) {
          recordError("probe.connections", "internal");
          throw err;
        }
      },
      probeScanConfigDirs: async (input) => {
        try {
          const result = await probeScanConfigDirs({ fs: nodeFileSystemReader }, input);
          recordSuccess("probe.scan_config_dirs");
          return result;
        } catch (err) {
          recordError("probe.scan_config_dirs", "internal");
          throw err;
        }
      },
      schemaListTables: async () => []
    };
  }

  private buildFullAdminRouterDeps(): AdminRouterDependencies {
    return buildRuntimeAdminDeps({
      getAdapter: () => this.ensureAdapterConnected(),
      fs: nodeFileSystemReader,
      registry: createRegExeRegistryReader(),
      probeDeps: this.buildAdminRouterDeps()
    });
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

  public async applyBootstrapDbConfig(message: BootstrapDbConfigMessage): Promise<void> {
    if (this.config.database) {
      this.logger.warn("bootstrap.db_config_ignored", {
        reason: "already_synced",
        requestId: message.requestId
      });
      return;
    }

    this.logger.info("bootstrap.db_config_received", {
      requestId: message.requestId,
      dbDriver: message.database.driver
    });

    try {
      await writeDatabaseConfig(this.configuredProgramDataPath(), message.database);
    } catch (err) {
      this.logger.error("bootstrap.persist_failed", {
        message: err instanceof Error ? err.message : String(err)
      });
      return;
    }

    this.config = { ...this.config, database: message.database } as ConnectorConfig;
    this.adapter = createSourceDatabaseAdapter({
      config: message.database,
      dependencies: this.adapterDependencies,
      secrets: runtimeConfigSecrets(this.config)
    });

    this.logger.info("bootstrap.transitioned_to_synced", {
      dbDriver: message.database.driver
    });

    this.sendHeartbeat();
    await this.resumeSavedMappingIfAvailable();
  }

  private async handleProvisionReadonlyUser(message: ProvisionReadonlyUserMessage): Promise<void> {
    const database = this.config.database;
    const engine = database?.driver ?? "unknown";
    const respond = (
      outcome: "provisioned" | "fallback_no_privilege" | "unsupported_engine" | "error",
      errorCode?: ProvisionErrorCode
    ): void => {
      this.transport.sendProvisionReadonlyUserResult(
        buildProvisionReadonlyUserResult(
          {
            requestId: message.requestId,
            sessionId: message.sessionId,
            outcome,
            username: message.username,
            ...(errorCode ? { errorCode } : {})
          },
          this.now()
        )
      );
    };

    if (!database) {
      respond("error", "unknown");
      return;
    }

    const password = generateReadonlyPassword();
    const secrets = [...runtimeConfigSecrets(this.config), password];

    let adminAdapter: SourceDatabaseAdapter;
    try {
      adminAdapter = await this.ensureAdapterConnected();
    } catch {
      respond("error", "unreachable");
      return;
    }

    let provisionResult;
    try {
      provisionResult = await adminAdapter.provisionReadonlyUser({
        username: message.username,
        password
      });
    } catch (error) {
      this.logger.warn("provision.readonly.failed", {
        requestId: message.requestId,
        message: redactString(error instanceof Error ? error.message : String(error), secrets)
      });
      await this.persistProvisioning(database, { status: "fallback_discovered", engine });
      respond("error", classifyProvisionError(error));
      return;
    }

    if (provisionResult.outcome === "fallback_no_privilege") {
      await this.persistProvisioning(database, { status: "fallback_discovered", engine });
      respond("fallback_no_privilege");
      return;
    }

    // provisioned: monta credencial RO, valida com SELECT, troca a conexão ativa.
    const roDatabase: DatabaseConfig = { ...database, user: message.username, password };
    const roAdapter = this.createReadonlyAdapterFn(roDatabase);
    try {
      await roAdapter.connect();
      await roAdapter.runReadOnlySelect({ sql: "select 1", limit: 1 });
    } catch (error) {
      await roAdapter.close().catch(() => undefined);
      this.logger.warn("provision.readonly.validation_failed", {
        requestId: message.requestId,
        message: redactString(error instanceof Error ? error.message : String(error), secrets)
      });
      await this.persistProvisioning(database, { status: "fallback_discovered", engine });
      respond("error", classifyProvisionError(error));
      return;
    }

    const previousAdapter = this.adapter;
    this.adapter = roAdapter;
    this.adapterConnected = true;
    this.config = { ...this.config, database: roDatabase };
    if (previousAdapter && previousAdapter !== roAdapter) {
      await previousAdapter.close().catch(() => undefined);
    }

    await this.persistProvisioning(roDatabase, {
      status: "provisioned",
      username: message.username,
      engine
    });
    this.logger.info("provision.readonly.provisioned", {
      requestId: message.requestId,
      sessionId: message.sessionId,
      engine
    });
    respond("provisioned");
  }

  private async persistProvisioning(
    database: DatabaseConfig,
    meta: { status: ReadonlyProvisioningMetadata["status"]; username?: string; engine: string }
  ): Promise<void> {
    const readonlyProvisioning: ReadonlyProvisioningMetadata = {
      status: meta.status,
      engine: meta.engine,
      provisionedAt: this.now(),
      ...(meta.username !== undefined ? { username: meta.username } : {})
    };
    await this.writeReadonlyProvisioningFn(this.configuredProgramDataPath(), {
      database,
      readonlyProvisioning
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

  private pauseForAiSession(): void {
    this.aiSessionPreviousMapping = this.activeMapping;
    this.pausePolling("ai session active");
  }

  private resumePollingAfterAiSession(): void {
    const previousMapping = this.aiSessionPreviousMapping;
    this.aiSessionPreviousMapping = undefined;
    // Se a própria sessão aplicou um novo mapping, activateMapping já reativou
    // o poller; nada a fazer. Caso contrário, retoma o mapping anterior.
    if (this.activeMapping !== previousMapping || !this.poller) {
      return;
    }
    this.pollingPaused = false;
    this.logger.info("polling.resumed", {
      reason: "ai session ended without applying mapping",
      mappingVersion: this.activeMapping?.mappingVersion
    });
    this.scheduleNextPoll(0);
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

  private async emitDiscoverySnapshotOnce(): Promise<void> {
    if (this.hasEmittedDiscoverySnapshot) {
      return;
    }
    this.hasEmittedDiscoverySnapshot = true;

    const promise = this.discoverySnapshotPromise ?? Promise.resolve<PostgresDsnCandidate[]>([]);
    let dsns: PostgresDsnCandidate[] = [];

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<"__dsn_discovery_timeout__">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("__dsn_discovery_timeout__"), this.discoveryTimeoutMs);
      timeoutHandle.unref?.();
    });
    let winner: PostgresDsnCandidate[] | "__dsn_discovery_timeout__";
    try {
      winner = await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
    if (winner === "__dsn_discovery_timeout__") {
      this.logger.warn("dsn.discovery_timeout", {
        message: "dsn discovery timeout — sending empty snapshot",
        timeoutMs: this.discoveryTimeoutMs
      });
      dsns = [];
    } else {
      dsns = winner;
    }

    const envelope = buildConnectorDiscoveryMessage({
      platform: process.platform,
      dsns,
      mode: this.currentMode()
    });

    try {
      this.transport.sendConnectorDiscovery(envelope);
    } catch (error) {
      this.logger.warn("dsn.discovery_send_failed", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private currentMode(): "bootstrap" | "synced" {
    return this.config.database ? "synced" : "bootstrap";
  }

  private sendHeartbeat(lastSuccessfulSendAt?: string): void {
    try {
      const mode = this.currentMode();
      this.transport.sendHeartbeat({
        connectorVersion: CONNECTOR_VERSION,
        mappingVersion: this.activeMapping?.mappingVersion,
        lastSuccessfulSendAt,
        lastErrorCode: this.lastErrorCode,
        sentAt: this.now(),
        state: mode,
        ...(mode === "bootstrap" ? { bootstrap: this.bootstrapState.snapshot() } : {})
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
    },
    mariadbConnectionFactory: async (config) => {
      const mariadb = await optionalImport("mariadb");
      const createConnection = mariadb.createConnection ?? mariadb.default?.createConnection;
      const connection = await createConnection({
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: config.password
      });
      return {
        query: (sql, params) => connection.query(sql, params as unknown[]),
        end: () => connection.end()
      };
    },
    sqlserverConnectionFactory: async (config) => {
      const mssql = await optionalImport("mssql");
      const sql = mssql.default ?? mssql;
      const pool = new sql.ConnectionPool({
        server: config.server,
        ...(config.port !== undefined ? { port: config.port } : {}),
        database: config.database,
        user: config.user,
        password: config.password,
        options: {
          encrypt: config.encrypt,
          trustServerCertificate: config.trustServerCertificate
        }
      });
      await pool.connect();
      return {
        query: async (sqlText: string, params: Record<string, unknown>) => {
          const request = pool.request();
          for (const [name, value] of Object.entries(params)) {
            request.input(name, value);
          }
          const result = await request.query(sqlText);
          return { recordset: result.recordset };
        },
        close: () => pool.close()
      };
    }
  };
}

function classifyProvisionError(error: unknown): ProvisionErrorCode {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code).toLowerCase()
    : "";
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const haystack = `${code} ${message}`;
  if (haystack.includes("timeout") || haystack.includes("timedout")) return "timeout";
  if (haystack.includes("econnrefused") || haystack.includes("econnreset") || haystack.includes("unreachable") || haystack.includes("network")) return "unreachable";
  if (haystack.includes("auth") || haystack.includes("denied") || haystack.includes("password")) return "auth";
  if (haystack.includes("syntax")) return "syntax";
  return "unknown";
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
