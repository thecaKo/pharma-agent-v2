export {
  buildEnvBackupPath,
  mergeConnectorEnvContent,
  writeConnectorEnvFile,
  type ConnectorEnvKey,
  type ConnectorEnvValues,
  type WriteConnectorEnvFileOptions,
  type WriteConnectorEnvFileResult
} from "./cli/env-file.js";
export {
  buildOnboardingMappingArtifact,
  writeDatabaseSetupState,
  type DatabaseSetupStateInput,
  type OnboardingFieldMapping,
  type OnboardingMappingArtifact
} from "./cli/database-setup-state.js";
export {
  DEFAULT_ONBOARDING_ARTIFACT_POLL_INTERVAL_MS,
  LOCAL_ONBOARDING_MAPPING_VERSION,
  OnboardingArtifactError,
  loadValidatedMappingFromOnboardingArtifactFile
} from "./cli/onboarding-artifact-loader.js";
export {
  ConfigValidationError,
  CONNECTOR_ENV_KEYS,
  REQUIRED_ENV,
  configSecrets,
  loadConfig,
  type Environment
} from "./config/env.js";
export {
  CONNECTOR_CONFIG_FILE_NAME,
  INSTALLER_CONFIG_DIR_NAME,
  INSTALLER_MANAGED_CONFIG_KEYS,
  ProgramDataConfigError,
  defaultProgramDataConfigPath,
  loadProgramDataConfig,
  mergeInstallerConfigWithEnvironment,
  type InstallerManagedConfig,
  type InstallerManagedConfigKey,
  type ProgramDataConfigLoadResult
} from "./config/programdata-config.js";
export type {
  ConfigValidationIssue,
  ConnectorConfig,
  DatabaseConfig,
  DatabaseDriver,
  LogLevel
} from "./config/types.js";
export {
  createSourceDatabaseAdapter,
  UnsupportedDatabaseDriverError,
  type AdapterFactoryDependencies,
  type CreateSourceAdapterInput
} from "./db/adapter-factory.js";
export {
  DatabaseOperationError,
  normalizeDatabaseError,
  type DatabaseOperation,
  type NormalizeDatabaseErrorInput
} from "./db/errors.js";
export {
  buildDatabaseSetupCandidateViews,
  classifyDatabasePath,
  compareDatabaseSetupCandidateViews,
  compareDatabaseFileCandidates,
  discoverDatabaseFiles,
  formatDatabaseSetupCandidateView,
  resolveDatabaseDiscoveryRoots,
  sortDatabaseFileCandidates,
  type DatabaseCandidateType,
  type DatabaseDiscoveryConfidence,
  type DatabaseFileCandidate,
  type DatabaseFileDiscoveryOptions,
  type DatabaseFileDiscoveryResult,
  type DatabasePathKind,
  type DatabasePathMetadata,
  type DatabaseSetupCandidateView
} from "./db/file-discovery.js";
export {
  FirebirdSourceAdapter,
  type FirebirdConnectionConfig,
  type FirebirdConnectionFactory,
  type FirebirdDriverConnection,
  type FirebirdSourceAdapterOptions
} from "./db/firebird-adapter.js";
export {
  MySqlSourceAdapter,
  type MySqlConnectionConfig,
  type MySqlConnectionFactory,
  type MySqlDriverConnection,
  type MySqlSourceAdapterOptions
} from "./db/mysql-adapter.js";
export {
  type DatabaseColumn,
  type DatabaseTable,
  type QueryChangesInput,
  type SourceDatabaseAdapter,
  type SourceDatabaseAdapterKind
} from "./db/source-adapter.js";
export { createLogger, type Logger, type LoggerOptions } from "./logging/logger.js";
export { redactString, redactValue } from "./logging/redact.js";
export { applyMapping, type ApplyMappingOptions } from "./mapping/apply.js";
export type {
  ApplyMappingResult,
  CursorType,
  MappingConfig,
  ProductChangeRecord,
  ProductFieldMappings,
  RejectedSourceRow,
  SourceRow,
  ValidatedMappingConfig
} from "./mapping/types.js";
export { MappingValidationError, validateMappingConfig } from "./mapping/validate.js";
export {
  buildProductBatch,
  type BuildProductBatchInput,
  type ProductChangeBatch
} from "./poller/batch-builder.js";
export { readRowCursor, selectCursorAfter } from "./poller/cursor.js";
export {
  IncrementalPoller,
  type IncrementalPollerOptions,
  type PollCycleResult,
  type PollCycleStatus,
  type PollerStateReader
} from "./poller/incremental-poller.js";
export {
  ConnectorRuntime,
  defaultStateFilePath,
  startConnectorRuntime,
  type ConnectorRuntimeOptions,
  type ConnectorRuntimeState,
  type RuntimeTimers,
  type RuntimeTransport
} from "./service/runtime.js";
export {
  registerShutdownHandlers,
  type ShutdownProcess,
  type ShutdownRegistration,
  type ShutdownTarget
} from "./service/shutdown.js";
export { StateStore, pickPersistedState, type StateStoreOptions } from "./state/state-store.js";
export { STATE_FILE_NAME, type ConnectorState, type CursorValue } from "./state/state-types.js";
export { buildHeartbeatMessage, buildHeartbeatPayload, type BuildHeartbeatInput } from "./transport/heartbeat.js";
export {
  buildConnectorErrorMessage,
  buildAdminErrorResponseMessage,
  buildAdminSuccessResponseMessage,
  buildProductBatchMessage,
  parseServerMessage,
  ProtocolParseError,
  serializeConnectorMessage,
  type AdminCommand,
  type AdminRequestMessage,
  type AdminResponseErrorMessage,
  type AdminResponseErrorPayload,
  type AdminResponseMessage,
  type AdminResponseSuccessMessage,
  type AdminResponseSuccessPayload,
  type BatchAckMessage,
  type BatchNextAction,
  type ConfigUpdatedMessage,
  type ConnectorConfigMessage,
  type ConnectorErrorMessage,
  type ConnectorErrorPayload,
  type ConnectorHeartbeatMessage,
  type ConnectorMessage,
  type ConnectorMessageType,
  type HeartbeatPayload,
  type ProductBatchMessage,
  type ServerMessage,
  type ServerMessageType
} from "./transport/protocol.js";
export { calculateReconnectDelay, type RetryPolicyOptions } from "./transport/retry-policy.js";
export {
  WebSocketTransportClient,
  type CloseInfo,
  type WebSocketTransportClientOptions,
  type WebSocketTransportEvent
} from "./transport/ws-client.js";
export { CONNECTOR_VERSION } from "./version.js";
