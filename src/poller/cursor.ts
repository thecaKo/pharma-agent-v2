import type { SourceRow, ValidatedIncrementalMappingConfig } from "../mapping/types.js";
import type { CursorValue } from "../state/state-types.js";

export function readRowCursor(row: SourceRow, mapping: ValidatedIncrementalMappingConfig): CursorValue {
  const value = row[mapping.cursorField];
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return mapping.cursorType === "number" ? toFiniteNumber(value) : normalizeTimestamp(value);
}

export function selectCursorAfter(
  rows: readonly SourceRow[],
  mapping: ValidatedIncrementalMappingConfig,
  fallback: CursorValue
): CursorValue {
  let cursorAfter = fallback;

  for (const row of rows) {
    const candidate = readRowCursor(row, mapping);
    if (candidate !== null) {
      cursorAfter = candidate;
    }
  }

  return cursorAfter;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const numeric = Number(String(value).trim());
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeTimestamp(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}
