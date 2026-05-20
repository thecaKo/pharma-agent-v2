/**
 * neo-api ConnectorCatalogConfigBuilder + pushConnectorCatalogConfig wire format.
 */
export function neoApiCatalogConfigPush(options: {
  connectorId?: string;
  customerId?: string;
  mappingVersion?: string;
  productSource?: string;
  pollIntervalMs?: number;
  batchSize?: number;
} = {}): Record<string, unknown> {
  const productSource = options.productSource ?? "products";
  const cursorField = "updated_at";

  return {
    type: "connector.config",
    connectorId: options.connectorId ?? "connector-1",
    customerId: options.customerId ?? "customer-1",
    mapping: {
      mappingVersion: options.mappingVersion ?? "mv-api-1",
      selectedProductTable: productSource,
      pollIntervalMs: options.pollIntervalMs ?? 10,
      batchSize: options.batchSize ?? 100,
      incrementalQuery: `select * from \`${productSource}\` where \`${cursorField}\` > ? order by \`${cursorField}\` limit ?`,
      cursorField,
      cursorType: "timestamp",
      fields: {
        sourceProductCode: "sku",
        name: "title",
        price: "sale_price",
        stock: "qty",
        sourceUpdatedAt: "updated_at"
      }
    }
  };
}
