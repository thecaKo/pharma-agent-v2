import { describe, expect, it, vi } from "vitest";
import { applyMapping } from "../../src/mapping/apply.js";
import { validateMappingConfig } from "../../src/mapping/validate.js";
import { validMapping } from "../helpers/mapping.js";

describe("applyMapping", () => {
  it("maps valid source rows into product change records", () => {
    const mapping = validateMappingConfig(validMapping());

    const result = applyMapping(
      [
        {
          product_id: "  P-001  ",
          description: "Dipirona 500mg",
          ean: "7891000000001",
          sale_price: "12.50",
          quantity: "7",
          is_active: "1",
          updated_at: "2026-05-16T20:00:00.000Z"
        }
      ],
      mapping
    );

    expect(result.records).toEqual([
      {
        sourceProductCode: "P-001",
        name: "Dipirona 500mg",
        barcode: "7891000000001",
        price: 12.5,
        stock: 7,
        active: true,
        sourceUpdatedAt: "2026-05-16T20:00:00.000Z"
      }
    ]);
    expect(result.rejected).toEqual([]);
    expect(result.cursorAfter).toBe("2026-05-16T20:00:00.000Z");
  });

  it("rejects rows missing sourceProductCode and excludes them from records", () => {
    const logger = { warn: vi.fn() };
    const mapping = validateMappingConfig(validMapping());

    const result = applyMapping(
      [
        {
          product_id: "",
          description: "Missing code",
          sale_price: "1.99",
          quantity: 1,
          updated_at: "2026-05-16T20:00:00.000Z"
        },
        {
          product_id: "P-002",
          description: "Valid row",
          sale_price: "2.99",
          quantity: 3,
          updated_at: "2026-05-16T20:00:01.000Z"
        }
      ],
      mapping,
      {
        logger,
        logContext: {
          connectorId: "connector-1",
          customerId: "customer-1",
          mappingVersion: mapping.mappingVersion
        }
      }
    );

    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.sourceProductCode).toBe("P-002");
    expect(result.rejected).toEqual([{ index: 0, reason: "missing_source_product_code" }]);
    expect(logger.warn).toHaveBeenCalledWith("invalid_record.skipped", {
      connectorId: "connector-1",
      customerId: "customer-1",
      mappingVersion: "mapping-v1",
      reason: "missing_source_product_code",
      rowIndex: 0
    });
  });

  it("converts numeric fields and optional active states conservatively", () => {
    const mapping = validateMappingConfig(validMapping({ cursorType: "number", cursorField: "seq" }));

    const result = applyMapping(
      [
        {
          product_id: "P-003",
          description: "Numeric row",
          sale_price: 9.75,
          quantity: "4",
          is_active: "inactive",
          seq: 99
        }
      ],
      mapping
    );

    expect(result.records[0]).toMatchObject({
      sourceProductCode: "P-003",
      price: 9.75,
      stock: 4,
      active: false,
      sourceUpdatedAt: "99"
    });
    expect(result.cursorAfter).toBe(99);
  });

  it("normalizes Date timestamp values into ISO strings for payload and cursor", () => {
    const mapping = validateMappingConfig(validMapping());
    const updatedAt = new Date("2026-05-16T23:00:02.000Z");

    const result = applyMapping(
      [
        {
          product_id: "P-004",
          description: "Date-backed row",
          sale_price: "10.50",
          quantity: 2,
          updated_at: updatedAt
        }
      ],
      mapping
    );

    expect(result.records[0]).toMatchObject({
      sourceProductCode: "P-004",
      sourceUpdatedAt: "2026-05-16T23:00:02.000Z"
    });
    expect(result.cursorAfter).toBe("2026-05-16T23:00:02.000Z");
  });

  it("maps price and stock as null when they are not configured", () => {
    const mapping = validateMappingConfig(
      validMapping({
        fields: {
          ...validMapping().fields,
          price: undefined,
          stock: undefined
        }
      })
    );

    const result = applyMapping(
      [
        {
          product_id: "P-005",
          description: "No price or stock",
          updated_at: "2026-05-16T23:00:03.000Z"
        }
      ],
      mapping
    );

    expect(result.records[0]).toMatchObject({
      sourceProductCode: "P-005",
      name: "No price or stock",
      price: null,
      stock: null
    });
  });
});
