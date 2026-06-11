import { describe, expect, it } from "vitest";
import {
  normalizeCatalogConfigPushMessage,
  parseCursorFieldFromIncrementalQuery
} from "../../src/transport/catalog-config-push.js";
import { parseServerMessage } from "../../src/transport/protocol.js";
import { neoApiCatalogConfigPush } from "../helpers/catalog-config-push.js";
import { productionConnectorConfig } from "../helpers/mapping.js";

describe("catalog config push normalization", () => {
  it("normalizes flat neo-api connector.config runtime cadence", () => {
    const push = neoApiCatalogConfigPush();
    expect(normalizeCatalogConfigPushMessage(push)).toEqual({
      ...push,
      mapping: {
        ...(push.mapping as Record<string, unknown>),
        syncMode: "incremental",
        // valores válidos do helper (10/100) são preservados; o default só
        // entra quando o campo está ausente ou inválido.
        pollIntervalMs: 10,
        batchSize: 100,
        cursorType: "timestamp",
        snapshotPageSize: 500
      }
    });
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
        batchSize: 100,
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
        // cursorType ausente NÃO é fabricado: o normalizador o omite e o validate a
        // jusante rejeita a ausência em incremental (contrato "não inventa default").
        fields: {
          sourceProductCode: "sourceProductCode",
          name: "sourceProductName",
          price: "sourceProductPrice",
          stock: "sourceProductStock",
          sourceUpdatedAt: "sourceProductUpdatedAt"
        }
      }
    });
    expect(normalized.mapping).not.toHaveProperty("cursorType");
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
    expect(normalizeCatalogConfigPushMessage(flat)).toEqual({
      ...flat,
      mapping: {
        ...(flat.mapping as Record<string, unknown>),
        syncMode: "incremental",
        pollIntervalMs: 10_000,
        batchSize: 500,
        snapshotPageSize: 500
      }
    });
  });

  it("maps flat cursorType updated_at to agent timestamp", () => {
    const push = neoApiCatalogConfigPush();
    (push.mapping as Record<string, unknown>).cursorType = "updated_at";

    const normalized = normalizeCatalogConfigPushMessage(push);
    expect(normalized.mapping).toMatchObject({ cursorType: "timestamp" });
  });

  it("leaves unknown flat cursorType raw for the validator to reject", () => {
    const push = neoApiCatalogConfigPush();
    (push.mapping as Record<string, unknown>).cursorType = "timestamptz";

    // Lixo desconhecido NÃO é saneado para um default: permanece cru para o
    // validate a jusante rejeitar (não se chuta a semântica timestamp×number).
    const normalized = normalizeCatalogConfigPushMessage(push);
    expect(normalized.mapping).toMatchObject({ cursorType: "timestamptz" });
  });

  it("maps flat cursorType incrementing to agent number", () => {
    const push = neoApiCatalogConfigPush();
    (push.mapping as Record<string, unknown>).cursorType = "incrementing";

    const normalized = normalizeCatalogConfigPushMessage(push);
    expect(normalized.mapping).toMatchObject({ cursorType: "number" });
  });

  it("removes cursorType and cursorField from flat snapshot mapping", () => {
    const push = neoApiCatalogConfigPush();
    const mapping = push.mapping as Record<string, unknown>;
    mapping.syncMode = "snapshot";
    mapping.snapshotQuery = "select * from `products` order by `id` limit ? offset ?";
    mapping.snapshotPageSize = 500;
    mapping.cursorType = "updated_at";
    mapping.cursorField = "updated_at";

    const normalized = normalizeCatalogConfigPushMessage(push);
    const normalizedMapping = normalized.mapping as Record<string, unknown>;
    expect(normalizedMapping.syncMode).toBe("snapshot");
    expect(normalizedMapping).not.toHaveProperty("cursorType");
    expect(normalizedMapping).not.toHaveProperty("cursorField");
  });

  it("keeps cursorField and normalizes cursorType in flat incremental mapping", () => {
    const push = neoApiCatalogConfigPush();
    const mapping = push.mapping as Record<string, unknown>;
    mapping.cursorField = "updated_at";
    mapping.cursorType = "composite";

    const normalized = normalizeCatalogConfigPushMessage(push);
    expect(normalized.mapping).toMatchObject({
      syncMode: "incremental",
      cursorField: "updated_at",
      cursorType: "timestamp"
    });
  });

  it.each([
    ["zero", 0],
    ["null", null],
    ["string", "100"],
    ["float", 3.5],
    ["negative", -1]
  ])("defaults invalid flat snapshotPageSize (%s) to 500", (_label, invalid) => {
    const push = neoApiCatalogConfigPush();
    (push.mapping as Record<string, unknown>).snapshotPageSize = invalid;

    const normalized = normalizeCatalogConfigPushMessage(push);
    expect(normalized.mapping).toMatchObject({ snapshotPageSize: 500 });
  });

  it("preserves valid flat runtime numbers instead of replacing with defaults", () => {
    const push = neoApiCatalogConfigPush();
    const mapping = push.mapping as Record<string, unknown>;
    mapping.snapshotPageSize = 250;
    mapping.pollIntervalMs = 60_000;
    mapping.batchSize = 1_000;

    const normalized = normalizeCatalogConfigPushMessage(push);
    expect(normalized.mapping).toMatchObject({
      snapshotPageSize: 250,
      pollIntervalMs: 60_000,
      batchSize: 1_000
    });
  });

  it("passes through snapshot sync fields from nested catalog payloads", () => {
    const push = {
      type: "connector.config",
      config: {
        connectorId: "connector-1",
        customerId: "customer-1",
        selectedProductTable: "products",
        fields: {
          sourceProductCode: "product_id",
          sourceProductName: "description",
          sourceProductPrice: "sale_price",
          sourceProductStock: "stock_qty"
        },
        mapping: {
          mappingVersion: "mv-snapshot-1",
          syncMode: "snapshot",
          snapshotQuery: "select * from products order by product_id limit ? offset ?",
          snapshotPageSize: 500,
          pollIntervalMs: 10,
          batchSize: 100
        }
      }
    };

    const normalized = normalizeCatalogConfigPushMessage(push);
    expect(normalized.mapping).toMatchObject({
      syncMode: "snapshot",
      snapshotQuery: "select * from products order by product_id limit ? offset ?",
      snapshotPageSize: 500
    });
  });
});

describe("parseCursorFieldFromIncrementalQuery", () => {
  it("extrai a coluna no dialeto MySQL (backtick + ?)", () => {
    const sql = "SELECT * FROM `products` WHERE `updated_at` > ? ORDER BY `updated_at` ASC LIMIT ?";
    expect(parseCursorFieldFromIncrementalQuery(sql)).toBe("updated_at");
  });

  it("extrai a coluna no dialeto PostgreSQL (aspas duplas + $1)", () => {
    const sql = 'SELECT * FROM "products" WHERE "atualizado_em" > $1 ORDER BY "atualizado_em" ASC LIMIT $2';
    expect(parseCursorFieldFromIncrementalQuery(sql)).toBe("atualizado_em");
  });

  it("retorna undefined quando nenhum dialeto casa", () => {
    expect(parseCursorFieldFromIncrementalQuery("SELECT 1")).toBeUndefined();
  });
});
