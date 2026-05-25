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

  it("rejects mappings without name", () => {
    const fields = validMapping().fields;

    expectIssue(validMapping({ fields: { ...fields, name: "" } }), "fields.name");
  });

  it("accepts mappings without price or stock", () => {
    const fields = validMapping().fields;

    expect(validateMappingConfig(validMapping({ fields: { ...fields, price: undefined, stock: undefined } }))).toMatchObject({
      fields: {
        sourceProductCode: "product_id",
        name: "description",
        price: undefined,
        stock: undefined
      }
    });
  });

  it("rejects unsupported cursor types", () => {
    expectIssue(validMapping({ cursorType: "uuid" }), "cursorType");
  });

  it("rejects non-positive polling intervals and batch sizes", () => {
    expectIssue(validMapping({ pollIntervalMs: 0 }), "pollIntervalMs");
    expectIssue(validMapping({ batchSize: -1 }), "batchSize");
  });
});

describe("validateMappingConfig snapshot mode", () => {
  it("accepts snapshot mapping without cursor fields", () => {
    expect(
      validateMappingConfig({
        mappingVersion: "mapping-v1",
        syncMode: "snapshot",
        selectedProductTable: "products",
        pollIntervalMs: 10_000,
        batchSize: 500,
        snapshotQuery: "select * from products order by product_id limit ? offset ?",
        snapshotPageSize: 500,
        fields: {
          sourceProductCode: "product_id",
          name: "description",
          price: "sale_price",
          stock: "quantity"
        }
      })
    ).toMatchObject({
      syncMode: "snapshot",
      snapshotQuery: "select * from products order by product_id limit ? offset ?",
      snapshotPageSize: 500
    });
  });

  it("rejects snapshot mapping without snapshotQuery", () => {
    expect(() =>
      validateMappingConfig({
        ...validMapping({ syncMode: "snapshot" }),
        incrementalQuery: undefined,
        cursorField: undefined,
        cursorType: undefined,
        snapshotQuery: undefined,
        snapshotPageSize: 500
      })
    ).toThrow(MappingValidationError);
  });

  it("keeps incremental as the default sync mode", () => {
    expect(validateMappingConfig(validMapping()).syncMode).toBe("incremental");
  });

  it("rejects snapshot mapping with cursorField set", () => {
    expectIssue(
      {
        mappingVersion: "mapping-v1",
        syncMode: "snapshot",
        pollIntervalMs: 10_000,
        batchSize: 500,
        snapshotQuery: "select * from products order by product_id limit ? offset ?",
        snapshotPageSize: 500,
        cursorField: "updated_at",
        fields: { sourceProductCode: "product_id", name: "description" }
      },
      "cursorField"
    );
  });

  it("rejects snapshot mapping with cursorType set", () => {
    expectIssue(
      {
        mappingVersion: "mapping-v1",
        syncMode: "snapshot",
        pollIntervalMs: 10_000,
        batchSize: 500,
        snapshotQuery: "select * from products order by product_id limit ? offset ?",
        snapshotPageSize: 500,
        cursorType: "timestamp",
        fields: { sourceProductCode: "product_id", name: "description" }
      },
      "cursorType"
    );
  });
});

describe("validateMappingConfig syncMode validation", () => {
  it("reports syncMode issue when syncMode is invalid", () => {
    expectIssue(
      validMapping({ syncMode: "invalid" as unknown as "incremental" }),
      "syncMode"
    );
  });

  it("reports syncMode issue when syncMode is an unknown string", () => {
    try {
      validateMappingConfig(validMapping({ syncMode: "bulk" as unknown as "incremental" }));
    } catch (error) {
      expect(error).toBeInstanceOf(MappingValidationError);
      const fields = (error as MappingValidationError).issues.map((i) => i.field);
      expect(fields).toContain("syncMode");
      return;
    }
    throw new Error("Expected syncMode validation issue");
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
