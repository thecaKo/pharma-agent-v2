import type { MappingConfig } from "../../src/mapping/types.js";

export interface ProductionConnectorConfigOptions {
  connectorId?: string;
  customerId?: string;
  sentAt?: string;
  mapping?: Partial<MappingConfig>;
}

export function productionConnectorConfig(
  options: ProductionConnectorConfigOptions = {}
): Record<string, unknown> {
  const mapping = validMapping({
    selectedProductTable: "products",
    ...options.mapping
  });

  return {
    type: "connector.config",
    connectorId: options.connectorId ?? "connector-1",
    customerId: options.customerId ?? "customer-1",
    sentAt: options.sentAt ?? "2026-05-20T12:00:00.000Z",
    mapping
  };
}

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

export function validSnapshotMapping(overrides: Partial<MappingConfig> = {}): MappingConfig {
  return {
    mappingVersion: "mapping-v1",
    selectedProductTable: "products",
    syncMode: "snapshot",
    pollIntervalMs: 10_000,
    batchSize: 500,
    snapshotQuery: "select * from products order by product_id limit ? offset ?",
    snapshotPageSize: 500,
    fields: {
      sourceProductCode: "product_id",
      name: "description",
      barcode: "ean",
      price: "sale_price",
      stock: "quantity",
      active: "is_active"
    },
    ...overrides
  };
}
