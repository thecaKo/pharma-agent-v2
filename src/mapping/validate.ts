import type { ConfigValidationIssue } from "../config/types.js";
import type { MappingConfig, SyncMode, ValidatedMappingConfig } from "./types.js";

const REQUIRED_FIELDS = ["sourceProductCode", "name"] as const;
const SYNC_MODES = new Set(["incremental", "snapshot"]);
const CURSOR_TYPES = new Set(["timestamp", "number"]);

export class MappingValidationError extends Error {
  public readonly issues: ConfigValidationIssue[];

  public constructor(issues: ConfigValidationIssue[]) {
    super(`Invalid mapping configuration: ${issues.map((issue) => `${issue.field} ${issue.message}`).join("; ")}`);
    this.name = "MappingValidationError";
    this.issues = issues;
  }
}

export function validateMappingConfig(mapping: MappingConfig): ValidatedMappingConfig {
  const issues: ConfigValidationIssue[] = [];
  const syncMode = normalizeSyncMode(mapping.syncMode, issues);

  requireString(mapping.mappingVersion, "mappingVersion", issues);
  requirePositiveInteger(mapping.pollIntervalMs, "pollIntervalMs", issues);
  requirePositiveInteger(mapping.batchSize, "batchSize", issues);

  for (const field of REQUIRED_FIELDS) {
    requireString(mapping.fields?.[field], `fields.${field}`, issues);
  }

  if (syncMode === "incremental") {
    requireString(mapping.incrementalQuery, "incrementalQuery", issues);
    requireString(mapping.cursorField, "cursorField", issues);
    if (!mapping.cursorType || !CURSOR_TYPES.has(mapping.cursorType)) {
      issues.push({ field: "cursorType", message: "must be timestamp or number" });
    }
  }

  if (syncMode === "snapshot") {
    requireString(mapping.snapshotQuery, "snapshotQuery", issues);
    requirePositiveInteger(mapping.snapshotPageSize, "snapshotPageSize", issues);
    if (mapping.cursorField?.trim()) {
      issues.push({ field: "cursorField", message: "must be absent in snapshot mode" });
    }
    if (mapping.cursorType?.trim()) {
      issues.push({ field: "cursorType", message: "must be absent in snapshot mode" });
    }
  }

  if (issues.length > 0) {
    throw new MappingValidationError(issues);
  }

  const selectedProductTable = normalizeOptionalMapping(mapping.selectedProductTable);
  const base = {
    mappingVersion: mapping.mappingVersion?.trim() as string,
    ...(selectedProductTable ? { selectedProductTable } : {}),
    syncMode,
    pollIntervalMs: mapping.pollIntervalMs as number,
    batchSize: mapping.batchSize as number,
    fields: {
      sourceProductCode: mapping.fields?.sourceProductCode?.trim() as string,
      name: mapping.fields?.name?.trim() as string,
      price: normalizeOptionalMapping(mapping.fields?.price),
      stock: normalizeOptionalMapping(mapping.fields?.stock),
      barcode: normalizeOptionalMapping(mapping.fields?.barcode),
      active: normalizeOptionalMapping(mapping.fields?.active),
      sourceUpdatedAt: normalizeOptionalMapping(mapping.fields?.sourceUpdatedAt)
    }
  };

  if (syncMode === "snapshot") {
    return {
      ...base,
      syncMode: "snapshot",
      snapshotQuery: mapping.snapshotQuery?.trim() as string,
      snapshotPageSize: mapping.snapshotPageSize as number
    };
  }

  return {
    ...base,
    syncMode: "incremental",
    incrementalQuery: mapping.incrementalQuery?.trim() as string,
    cursorField: mapping.cursorField?.trim() as string,
    cursorType: mapping.cursorType as "timestamp" | "number"
  };
}

function normalizeSyncMode(value: MappingConfig["syncMode"], issues: ConfigValidationIssue[]): SyncMode {
  if (value === undefined) {
    return "incremental";
  }
  if (!SYNC_MODES.has(value)) {
    issues.push({ field: "syncMode", message: "must be incremental or snapshot" });
    return "incremental";
  }
  return value;
}

function requireString(value: string | undefined, field: string, issues: ConfigValidationIssue[]): void {
  if (!value?.trim()) {
    issues.push({ field, message: "is required" });
  }
}

function requirePositiveInteger(value: number | undefined, field: string, issues: ConfigValidationIssue[]): void {
  if (!Number.isInteger(value) || (value ?? 0) <= 0) {
    issues.push({ field, message: "must be a positive integer" });
  }
}

function normalizeOptionalMapping(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}
