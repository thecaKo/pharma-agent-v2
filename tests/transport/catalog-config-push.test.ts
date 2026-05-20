import { describe, expect, it } from "vitest";
import { normalizeCatalogConfigPushMessage } from "../../src/transport/catalog-config-push.js";
import { parseServerMessage } from "../../src/transport/protocol.js";
import { neoApiCatalogConfigPush } from "../helpers/catalog-config-push.js";
import { productionConnectorConfig } from "../helpers/mapping.js";

describe("catalog config push normalization", () => {
  it("passes through flat neo-api connector.config unchanged", () => {
    const push = neoApiCatalogConfigPush();
    expect(normalizeCatalogConfigPushMessage(push)).toEqual(push);
  });

  it("parseServerMessage accepts flat neo-api activation push", () => {
    const parsed = parseServerMessage(JSON.stringify(neoApiCatalogConfigPush()));

    expect(parsed).toMatchObject({
      type: "connector.config",
      connectorId: "connector-1",
      customerId: "customer-1",
      mapping: {
        mappingVersion: "mv-api-1",
        selectedProductTable: "products",
        pollIntervalMs: 10,
        cursorField: "updated_at",
        cursorType: "timestamp",
        fields: {
          sourceProductCode: "sku",
          name: "title",
          price: "sale_price",
          stock: "qty",
          sourceUpdatedAt: "updated_at"
        }
      }
    });
  });

  it("normalizes legacy nested { type, config } envelope with aliased SQL", () => {
    const nested = {
      type: "connector.config",
      config: {
        connectorId: "connector-1",
        customerId: "customer-1",
        selectedProductTable: "products",
        fields: {
          sourceProductCode: "sku",
          sourceProductName: "title",
          sourceProductPrice: "sale_price",
          sourceProductStock: "qty",
          sourceProductUpdatedAt: "updated_at"
        },
        mapping: {
          mappingVersion: "mv-legacy-1",
          incrementalQuery: `SELECT \`sku\` AS \`sourceProductCode\`,
       \`title\` AS \`sourceProductName\`,
       \`sale_price\` AS \`sourceProductPrice\`,
       \`qty\` AS \`sourceProductStock\`,
       \`updated_at\` AS \`sourceProductUpdatedAt\`
FROM \`products\`
WHERE \`updated_at\` > ?
ORDER BY \`updated_at\` ASC
LIMIT ?`,
          pollIntervalMs: 10,
          batchSize: 100
        }
      }
    };

    const normalized = normalizeCatalogConfigPushMessage(nested);

    expect(normalized).toMatchObject({
      type: "connector.config",
      connectorId: "connector-1",
      customerId: "customer-1",
      mapping: {
        mappingVersion: "mv-legacy-1",
        selectedProductTable: "products",
        pollIntervalMs: 10,
        batchSize: 100,
        cursorField: "sourceProductUpdatedAt",
        cursorType: "timestamp",
        fields: {
          sourceProductCode: "sourceProductCode",
          name: "sourceProductName",
          price: "sourceProductPrice",
          stock: "sourceProductStock",
          sourceUpdatedAt: "sourceProductUpdatedAt"
        }
      }
    });
  });

  it("maps catalog cursorType updated_at to agent timestamp in nested envelope", () => {
    const push = {
      type: "connector.config",
      config: {
        connectorId: "connector-1",
        customerId: "customer-1",
        selectedProductTable: "products",
        cursorType: "updated_at",
        fields: {
          sourceProductCode: "sku",
          sourceProductName: "title",
          sourceProductPrice: "sale_price",
          sourceProductStock: "qty"
        },
        mapping: {
          mappingVersion: "mv-1",
          incrementalQuery: "select * from `products` where `updated_at` > ? order by `updated_at` limit ?",
          pollIntervalMs: 10,
          batchSize: 100
        }
      }
    };

    const normalized = normalizeCatalogConfigPushMessage(push);
    expect(normalized.mapping).toMatchObject({ cursorType: "timestamp" });
  });

  it("maps catalog cursorType incrementing to agent number in nested envelope", () => {
    const push = {
      type: "connector.config",
      config: {
        connectorId: "connector-1",
        customerId: "customer-1",
        selectedProductTable: "products",
        cursorType: "incrementing",
        fields: {
          sourceProductCode: "sku",
          sourceProductName: "title",
          sourceProductPrice: "sale_price",
          sourceProductStock: "qty"
        },
        mapping: {
          mappingVersion: "mv-1",
          incrementalQuery: "select * from `products` where `id` > ? order by `id` limit ?",
          pollIntervalMs: 10,
          batchSize: 100
        }
      }
    };

    const normalized = normalizeCatalogConfigPushMessage(push);
    expect(normalized.mapping).toMatchObject({ cursorType: "number" });
  });

  it("leaves flat production connector.config unchanged", () => {
    const flat = productionConnectorConfig();
    expect(normalizeCatalogConfigPushMessage(flat)).toEqual(flat);
  });
});
