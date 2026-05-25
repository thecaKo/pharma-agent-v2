import type { CursorValue } from "../state/state-types.js";

export type SyncMode = "incremental" | "snapshot";
export type CursorType = "timestamp" | "number";
export type SourceRow = Record<string, unknown>;

export interface ProductFieldMappings {
  sourceProductCode?: string;
  name?: string;
  barcode?: string;
  price?: string | null;
  stock?: string | null;
  active?: string;
  sourceUpdatedAt?: string;
}

export interface MappingConfig {
  mappingVersion?: string;
  selectedProductTable?: string;
  syncMode?: SyncMode;
  pollIntervalMs?: number;
  batchSize?: number;
  incrementalQuery?: string;
  cursorField?: string;
  cursorType?: string;
  snapshotQuery?: string;
  snapshotPageSize?: number;
  fields?: ProductFieldMappings;
}

interface ValidatedMappingBase {
  mappingVersion: string;
  selectedProductTable?: string;
  syncMode: SyncMode;
  pollIntervalMs: number;
  batchSize: number;
  fields: Required<Pick<ProductFieldMappings, "sourceProductCode" | "name">> &
    Pick<ProductFieldMappings, "price" | "stock" | "barcode" | "active" | "sourceUpdatedAt">;
}

export interface ValidatedIncrementalMappingConfig extends ValidatedMappingBase {
  syncMode: "incremental";
  incrementalQuery: string;
  cursorField: string;
  cursorType: CursorType;
}

export interface ValidatedSnapshotMappingConfig extends ValidatedMappingBase {
  syncMode: "snapshot";
  snapshotQuery: string;
  snapshotPageSize: number;
}

export type ValidatedMappingConfig = ValidatedIncrementalMappingConfig | ValidatedSnapshotMappingConfig;

export interface ProductChangeRecord {
  sourceProductCode: string;
  name: string;
  barcode?: string | null;
  price: number | null;
  stock: number | null;
  active?: boolean;
  sourceUpdatedAt?: string;
}

export interface RejectedSourceRow {
  index: number;
  reason: string;
  sourceProductCode?: string;
}

export interface ApplyMappingResult {
  records: ProductChangeRecord[];
  rejected: RejectedSourceRow[];
  cursorAfter: CursorValue;
}
