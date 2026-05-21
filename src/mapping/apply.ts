import type { Logger } from "../logging/logger.js";
import type { CursorValue } from "../state/state-types.js";
import type {
  ApplyMappingResult,
  ProductChangeRecord,
  RejectedSourceRow,
  SourceRow,
  ValidatedMappingConfig
} from "./types.js";

export interface ApplyMappingOptions {
  logger?: Pick<Logger, "warn">;
  logContext?: Record<string, unknown>;
}

export function applyMapping(
  rows: readonly SourceRow[],
  mapping: ValidatedMappingConfig,
  options: ApplyMappingOptions = {}
): ApplyMappingResult {
  const records: ProductChangeRecord[] = [];
  const rejected: RejectedSourceRow[] = [];
  let cursorAfter: CursorValue = null;

  rows.forEach((row, index) => {
    const mappedCursor = readCursor(row, mapping.cursorField, mapping.cursorType);
    if (mappedCursor !== null) {
      cursorAfter = mappedCursor;
    }

    const sourceProductCode = normalizeString(row[mapping.fields.sourceProductCode]);
    if (!sourceProductCode) {
      const rejection = { index, reason: "missing_source_product_code" };
      rejected.push(rejection);
      options.logger?.warn("invalid_record.skipped", {
        ...options.logContext,
        reason: rejection.reason,
        rowIndex: index
      });
      return;
    }

    records.push({
      sourceProductCode,
      name: normalizeString(row[mapping.fields.name]) ?? "",
      barcode: optionalString(mapping.fields.barcode ? row[mapping.fields.barcode] : undefined),
      price: mapping.fields.price ? toNumber(row[mapping.fields.price]) : null,
      stock: mapping.fields.stock ? toNumber(row[mapping.fields.stock]) : null,
      ...optionalBooleanProperty("active", mapping.fields.active ? row[mapping.fields.active] : undefined),
      ...optionalStringProperty(
        "sourceUpdatedAt",
        mapping.fields.sourceUpdatedAt
          ? row[mapping.fields.sourceUpdatedAt] ?? row[mapping.cursorField]
          : row[mapping.cursorField]
      )
    });
  });

  return { records, rejected, cursorAfter };
}

function readCursor(row: SourceRow, field: string, cursorType: "timestamp" | "number"): CursorValue {
  const value = row[field];
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return cursorType === "number" ? toNumber(value) : normalizeTimestamp(value);
}

function normalizeString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : undefined;
}

function optionalString(value: unknown): string | null {
  return normalizeString(value) ?? null;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  const normalized = normalizeString(value);
  if (!normalized) {
    return 0;
  }
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : 0;
}

function optionalBooleanProperty(name: "active", value: unknown): Partial<Pick<ProductChangeRecord, "active">> {
  if (value === undefined || value === null || value === "") {
    return {};
  }
  if (typeof value === "boolean") {
    return { [name]: value };
  }
  if (typeof value === "number") {
    return { [name]: value !== 0 };
  }

  const normalized = String(value).trim().toLowerCase();
  if (["true", "t", "yes", "y", "1", "active"].includes(normalized)) {
    return { [name]: true };
  }
  if (["false", "f", "no", "n", "0", "inactive"].includes(normalized)) {
    return { [name]: false };
  }
  return {};
}

function optionalStringProperty(
  name: "sourceUpdatedAt",
  value: unknown
): Partial<Pick<ProductChangeRecord, "sourceUpdatedAt">> {
  const normalized = normalizeString(value);
  return normalized ? { [name]: normalized } : {};
}

function normalizeTimestamp(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const normalized = normalizeString(value);
  return normalized ?? null;
}
