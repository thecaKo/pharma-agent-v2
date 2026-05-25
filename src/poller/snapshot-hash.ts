import { createHash } from "node:crypto";
import type { ProductChangeRecord, ValidatedSnapshotMappingConfig } from "../mapping/types.js";

export function productSnapshotHash(record: ProductChangeRecord): string {
  return sha256(stableStringify({
    sourceProductCode: record.sourceProductCode,
    name: record.name,
    barcode: record.barcode ?? null,
    price: record.price,
    stock: record.stock,
    active: record.active ?? null,
    sourceUpdatedAt: record.sourceUpdatedAt ?? null
  }));
}

export function snapshotFieldsSignature(mapping: ValidatedSnapshotMappingConfig): string {
  return sha256(stableStringify({
    selectedProductTable: mapping.selectedProductTable ?? null,
    snapshotQuery: mapping.snapshotQuery,
    fields: mapping.fields
  }));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortValue(nested)])
    );
  }
  return value;
}
