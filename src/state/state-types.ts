import type { MappingConfig, ProductChangeRecord } from "../mapping/types.js";

export type CursorValue = string | number | null;

export interface SnapshotProductState {
  hash: string;
  lastSeenAt: string;
  lastConfirmedAt: string;
}

export interface PendingSnapshotProduct {
  sourceProductCode: string;
  hash: string;
  record: ProductChangeRecord;
}

export interface SnapshotState {
  fieldsSignature: string;
  products: Record<string, SnapshotProductState>;
  pending: PendingSnapshotProduct[];
}

export interface ConnectorState {
  connectorId?: string;
  customerId?: string;
  mapping?: MappingConfig;
  mappingVersion?: string;
  selectedProductTable?: string;
  cursorField?: string;
  cursorType?: CursorValue extends number ? never : "timestamp" | "number";
  sourceProductCodeField?: string;
  lastAckedCursor?: CursorValue;
  lastSuccessfulSendAt?: string;
  lastBatchId?: string;
  snapshotState?: SnapshotState;
}

export const STATE_FILE_NAME = "connector-state.json";
