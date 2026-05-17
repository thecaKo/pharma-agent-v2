import type { MappingConfig } from "../../src/mapping/types.js";

export function validMapping(overrides: Partial<MappingConfig> = {}): MappingConfig {
  return {
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
    },
    ...overrides
  };
}
