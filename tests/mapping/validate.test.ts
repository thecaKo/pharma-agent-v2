import { describe, expect, it } from "vitest";
import { MappingValidationError, validateMappingConfig } from "../../src/mapping/validate.js";
import type { MappingConfig } from "../../src/mapping/types.js";
import { validMapping } from "../helpers/mapping.js";

describe("validateMappingConfig", () => {
  it("accepts a complete mapping", () => {
    expect(validateMappingConfig(validMapping())).toMatchObject({
      mappingVersion: "mapping-v1",
      pollIntervalMs: 10_000,
      batchSize: 500,
      incrementalQuery: "select * from products where updated_at > ? order by updated_at",
      cursorField: "updated_at",
      cursorType: "timestamp",
      fields: {
        sourceProductCode: "product_id",
        name: "description",
        barcode: "ean",
        price: "sale_price",
        stock: "quantity",
        active: "is_active",
        sourceUpdatedAt: "updated_at"
      }
    });
  });

  it("preserves trimmed selectedProductTable when provided", () => {
    expect(validateMappingConfig(validMapping({ selectedProductTable: "  products  " }))).toMatchObject({
      selectedProductTable: "products"
    });
  });

  it("omits empty selectedProductTable when provided", () => {
    expect(validateMappingConfig(validMapping({ selectedProductTable: "   " }))).not.toHaveProperty(
      "selectedProductTable"
    );
  });

  it("rejects missing required top-level mapping fields", () => {
    expect(() =>
      validateMappingConfig({
        fields: validMapping().fields
      })
    ).toThrow(MappingValidationError);

    try {
      validateMappingConfig({ fields: validMapping().fields });
    } catch (error) {
      expect(error).toBeInstanceOf(MappingValidationError);
      expect((error as MappingValidationError).issues.map((issue) => issue.field)).toEqual([
        "mappingVersion",
        "pollIntervalMs",
        "batchSize",
        "incrementalQuery",
        "cursorField",
        "cursorType"
      ]);
    }
  });

  it("rejects a mapping without sourceProductCode", () => {
    expectIssue(validMapping({ fields: { ...validMapping().fields, sourceProductCode: "" } }), "fields.sourceProductCode");
  });

  it("rejects mappings without name, price, or stock", () => {
    const fields = validMapping().fields;

    expectIssue(validMapping({ fields: { ...fields, name: "" } }), "fields.name");
    expectIssue(validMapping({ fields: { ...fields, price: "" } }), "fields.price");
    expectIssue(validMapping({ fields: { ...fields, stock: "" } }), "fields.stock");
  });

  it("rejects unsupported cursor types", () => {
    expectIssue(validMapping({ cursorType: "uuid" }), "cursorType");
  });

  it("rejects non-positive polling intervals and batch sizes", () => {
    expectIssue(validMapping({ pollIntervalMs: 0 }), "pollIntervalMs");
    expectIssue(validMapping({ batchSize: -1 }), "batchSize");
  });
});

function expectIssue(mapping: MappingConfig, field: string): void {
  try {
    validateMappingConfig(mapping);
  } catch (error) {
    expect(error).toBeInstanceOf(MappingValidationError);
    expect((error as MappingValidationError).issues.map((issue) => issue.field)).toContain(field);
    return;
  }
  throw new Error(`Expected ${field} validation issue`);
}
