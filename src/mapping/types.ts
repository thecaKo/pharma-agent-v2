import type { CursorValue } from "../state/state-types.js";

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
  pollIntervalMs?: number;
  batchSize?: number;
  incrementalQuery?: string;
  cursorField?: string;
  cursorType?: string;
  fields?: ProductFieldMappings;
}

export interface ValidatedMappingConfig {
  mappingVersion: string;
  selectedProductTable?: string;
  pollIntervalMs: number;
  batchSize: number;
  incrementalQuery: string;
  cursorField: string;
  cursorType: CursorType;
  fields: Required<Pick<ProductFieldMappings, "sourceProductCode" | "name">> &
    Pick<ProductFieldMappings, "price" | "stock" | "barcode" | "active" | "sourceUpdatedAt">;
}

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
