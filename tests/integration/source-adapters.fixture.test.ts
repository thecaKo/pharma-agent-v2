import { describe, expect, it, vi } from "vitest";
import { FirebirdSourceAdapter } from "../../src/db/firebird-adapter.js";
import { MySqlSourceAdapter } from "../../src/db/mysql-adapter.js";
import { IncrementalPoller } from "../../src/poller/incremental-poller.js";
import { validateMappingConfig } from "../../src/mapping/validate.js";
import { validMapping } from "../helpers/mapping.js";
import type { DatabaseConfig } from "../../src/config/types.js";

const mysqlConfig: DatabaseConfig = {
  driver: "mysql",
  host: "localhost",
  port: 3306,
  name: "fixture",
  user: "readonly",
  password: "test-db-password"
};

const firebirdConfig: DatabaseConfig = {
  ...mysqlConfig,
  driver: "firebird",
  port: 3050
};

const fixtureRows = [
  {
    product_id: "P-001",
    description: "Dipirona 500mg",
    ean: "7891000000001",
    sale_price: "12.50",
    quantity: "7",
    updated_at: 11
  },
  {
    product_id: "P-002",
    description: "Paracetamol 750mg",
    ean: "7891000000002",
    sale_price: "8.25",
    quantity: "4",
    updated_at: 12
  }
];

function incrementalFixtureRows(cursor: unknown, limit: unknown) {
  const numericCursor = typeof cursor === "number" ? cursor : Number(cursor ?? 0);
  return fixtureRows.filter((row) => row.updated_at > numericCursor).slice(0, Number(limit));
}

describe("source adapter fixture integrations", () => {
  it("MySQL adapter reads incremental fixture rows using cursor and limit inputs", async () => {
    const adapter = new MySqlSourceAdapter({
      config: mysqlConfig,
      connectionFactory: vi.fn(async () => ({
        query: vi.fn(async (_sql, params) => [incrementalFixtureRows(params[0], params[1]), []]),
        end: vi.fn(async () => undefined)
      }))
    });

    await adapter.connect();
    const rows = await adapter.queryChanges({ sql: "fixture sql", cursor: 10, limit: 1 });

    expect(rows).toEqual([fixtureRows[0]]);
  });

  it("Firebird adapter reads incremental fixture rows using cursor and limit inputs", async () => {
    const adapter = new FirebirdSourceAdapter({
      config: firebirdConfig,
      connectionFactory: vi.fn(async () => ({
        query: vi.fn(async (_sql, params) => incrementalFixtureRows(params[0], params[1])),
        detach: vi.fn(async () => undefined)
      }))
    });

    await adapter.connect();
    const rows = await adapter.queryChanges({ sql: "fixture sql", cursor: 10, limit: 1 });

    expect(rows).toEqual([fixtureRows[0]]);
  });

  it("MySQL adapter describeTable lists columns of the produtos fixture table", async () => {
    const adapter = new MySqlSourceAdapter({
      config: mysqlConfig,
      connectionFactory: vi.fn(async () => ({
        query: vi.fn(async () => [[{ name: "codigo", dataType: "varchar", nullable: "NO" }], []]),
        end: vi.fn(async () => undefined)
      }))
    });
    await adapter.connect();
    const columns = await adapter.describeTable("produtos");
    expect(columns).toEqual([{ name: "codigo", dataType: "varchar", nullable: false }]);
  });

  it("MySQL adapter listForeignKeys links desconto_produtos to produtos", async () => {
    const adapter = new MySqlSourceAdapter({
      config: mysqlConfig,
      connectionFactory: vi.fn(async () => ({
        query: vi.fn(async () => [[
          { fromTable: "desconto_produtos", fromColumn: "produto_id", toTable: "produtos", toColumn: "id", constraintName: "fk_dp" }
        ], []]),
        end: vi.fn(async () => undefined)
      }))
    });
    await adapter.connect();
    const fks = await adapter.listForeignKeys("desconto_produtos");
    expect(fks).toEqual([
      { fromTable: "desconto_produtos", fromColumn: "produto_id", toTable: "produtos", toColumn: "id", constraintName: "fk_dp" }
    ]);
  });

  it("MySQL adapter sampleRows applies a numeric LIMIT to the fabricante_produtos table", async () => {
    const query = vi.fn(async () => [[{ produto_id: "P-001", fabricante: "ACME" }], []]);
    const adapter = new MySqlSourceAdapter({
      config: mysqlConfig,
      connectionFactory: vi.fn(async () => ({ query, end: vi.fn(async () => undefined) }))
    });
    await adapter.connect();
    const rows = await adapter.sampleRows("fabricante_produtos", 3);
    expect(rows).toEqual([{ produto_id: "P-001", fabricante: "ACME" }]);
    expect(query.mock.calls[0]?.[0]).toMatch(/limit 3/i);
  });

  it("MySQL adapter runReadOnlySelect runs a validated SELECT and rejects writes", async () => {
    const query = vi.fn(async () => [[{ codigo: "P-001" }], []]);
    const adapter = new MySqlSourceAdapter({
      config: mysqlConfig,
      connectionFactory: vi.fn(async () => ({ query, end: vi.fn(async () => undefined) }))
    });
    await adapter.connect();
    const rows = await adapter.runReadOnlySelect({ sql: "SELECT codigo FROM produtos", limit: 25 });
    expect(rows).toEqual([{ codigo: "P-001" }]);
    expect(query.mock.calls[0]?.[0]).toMatch(/limit 25/i);
    await expect(adapter.runReadOnlySelect({ sql: "DELETE FROM produtos", limit: 10 })).rejects.toThrow();
  });

  it("poller converts fixture rows into a product batch with cursor before and after metadata", async () => {
    const mapping = validateMappingConfig(
      validMapping({
        cursorType: "number",
        cursorField: "updated_at",
        batchSize: 2
      })
    );
    const adapter = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      queryChanges: vi.fn(async () => fixtureRows),
      querySnapshotPage: vi.fn(async () => []),
      listTables: vi.fn(async () => [{ name: "products" }]),
      listColumns: vi.fn(async () => [
        { name: "product_id", dataType: "varchar", nullable: false },
        { name: "updated_at", dataType: "integer", nullable: false }
      ])
    };

    const result = await new IncrementalPoller({
      adapter,
      mapping,
      state: { load: vi.fn(async () => ({ lastAckedCursor: 10 })) },
      connectorId: "connector-1",
      customerId: "customer-1",
      isTransportReady: () => true,
      now: () => "2026-05-16T20:00:00.000Z"
    }).pollOnce();

    expect(result.status).toBe("batch");
    expect(result.batch).toMatchObject({
      connectorId: "connector-1",
      customerId: "customer-1",
      mappingVersion: "mapping-v1",
      cursorBefore: 10,
      cursorAfter: 12
    });
    expect(result.batch?.records).toHaveLength(2);
    expect(result.batch?.records[0]).toMatchObject({
      sourceProductCode: "P-001",
      price: 12.5,
      stock: 7
    });
    expect(adapter.listColumns).not.toHaveBeenCalled();
  });
});
