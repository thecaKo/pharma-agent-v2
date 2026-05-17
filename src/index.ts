export {
  ConfigValidationError,
  configSecrets,
  loadConfig,
  type Environment
} from "./config/env.js";
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
  buildProductBatchMessage,
  parseServerMessage,
  ProtocolParseError,
  serializeConnectorMessage,
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
