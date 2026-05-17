import { describe, expect, it } from "vitest";
import { readRowCursor, selectCursorAfter } from "../../src/poller/cursor.js";
import { validateMappingConfig } from "../../src/mapping/validate.js";
import { validMapping } from "../helpers/mapping.js";

describe("cursor helpers", () => {
  it("reads numeric and timestamp cursors from source rows", () => {
    const timestampMapping = validateMappingConfig(validMapping());
    const numberMapping = validateMappingConfig(validMapping({ cursorType: "number", cursorField: "seq" }));

    expect(readRowCursor({ updated_at: "2026-05-16T20:00:00.000Z" }, timestampMapping)).toBe(
      "2026-05-16T20:00:00.000Z"
    );
    expect(readRowCursor({ updated_at: new Date("2026-05-16T23:00:00.000Z") }, timestampMapping)).toBe(
      "2026-05-16T23:00:00.000Z"
    );
    expect(readRowCursor({ seq: "42" }, numberMapping)).toBe(42);
  });

  it("selects the last non-empty row cursor with fallback", () => {
    const mapping = validateMappingConfig(validMapping({ cursorType: "number", cursorField: "seq" }));

    expect(selectCursorAfter([{ seq: 11 }, { seq: null }, { seq: 12 }], mapping, 10)).toBe(12);
    expect(selectCursorAfter([{ seq: null }], mapping, 10)).toBe(10);
  });
});
