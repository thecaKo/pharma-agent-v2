import { describe, expect, it, vi } from "vitest";
import { MySqlSourceAdapter, type MySqlDriverConnection } from "../../src/db/mysql-adapter.js";
import { PostgresSourceAdapter, type PostgresDriverConnection } from "../../src/db/postgresql-adapter.js";
import type { DatabaseConfig } from "../../src/config/types.js";

const mysqlConfig: DatabaseConfig = {
  driver: "mysql",
  host: "127.0.0.1",
  port: 3306,
  name: "pharmacy",
  user: "ro",
  password: "secret"
};

const pgConfig: DatabaseConfig = {
  driver: "postgresql",
  host: "127.0.0.1",
  port: 5432,
  name: "pharmacy",
  user: "ro",
  password: "secret"
};

function makeMysqlConnection(rows: Record<string, unknown>[]): MySqlDriverConnection {
  return {
    query: vi.fn(async () => [rows, []]),
    end: vi.fn(async () => undefined)
  };
}

function makePgConnection(rows: Record<string, unknown>[]): PostgresDriverConnection {
  return {
    query: vi.fn(async () => ({ rows })),
    end: vi.fn(async () => undefined)
  };
}

describe("MySqlSourceAdapter.searchSchema", () => {
  it("retorna tabelas com colunas que casam com a keyword", async () => {
    const rows = [
      { table_name: "produtos", column_name: "codigo", data_type: "varchar", is_nullable: "NO" }
    ];
    const conn = makeMysqlConnection(rows);
    const adapter = new MySqlSourceAdapter({ config: mysqlConfig, connectionFactory: vi.fn(async () => conn) });
    await adapter.connect();

    const result = await adapter.searchSchema({ keywords: ["codigo"] });

    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]!.table).toBe("produtos");
    expect(result.tables[0]!.matchedColumns[0]!.name).toBe("codigo");
    expect(result.tables[0]!.matchedColumns[0]!.dataType).toBe("varchar");
    expect(conn.query).toHaveBeenCalledWith(expect.stringContaining("information_schema.columns"), expect.arrayContaining(["pharmacy", "%codigo%"]));
  });

  it("respeita maxTables", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      table_name: `tabela${i}`,
      column_name: "codigo",
      data_type: "int",
      is_nullable: "YES"
    }));
    const conn = makeMysqlConnection(rows);
    const adapter = new MySqlSourceAdapter({ config: mysqlConfig, connectionFactory: vi.fn(async () => conn) });
    await adapter.connect();

    const result = await adapter.searchSchema({ keywords: ["codigo"], maxTables: 3 });
    expect(result.tables.length).toBeLessThanOrEqual(3);
  });

  it("retorna lista vazia quando nenhuma coluna casa", async () => {
    const conn = makeMysqlConnection([]);
    const adapter = new MySqlSourceAdapter({ config: mysqlConfig, connectionFactory: vi.fn(async () => conn) });
    await adapter.connect();

    const result = await adapter.searchSchema({ keywords: ["naoexiste"] });
    expect(result.tables).toHaveLength(0);
  });
});

describe("MySqlSourceAdapter.listSchemas", () => {
  it("lista schemas via information_schema.schemata", async () => {
    const rows = [{ schema_name: "information_schema" }, { schema_name: "pharmacy" }];
    const conn = makeMysqlConnection(rows);
    const adapter = new MySqlSourceAdapter({ config: mysqlConfig, connectionFactory: vi.fn(async () => conn) });
    await adapter.connect();

    const result = await adapter.listSchemas();
    expect(result).toContain("pharmacy");
    expect(conn.query).toHaveBeenCalledWith(expect.stringContaining("information_schema.schemata"), []);
  });
});

describe("PostgresSourceAdapter.searchSchema", () => {
  it("retorna tabelas com colunas que casam com a keyword (ilike)", async () => {
    const rows = [
      { table_schema: "public", table_name: "produtos", column_name: "codigo", data_type: "character varying", is_nullable: "NO" }
    ];
    const conn = makePgConnection(rows);
    const adapter = new PostgresSourceAdapter({ config: pgConfig, connectionFactory: vi.fn(async () => conn) });
    await adapter.connect();

    const result = await adapter.searchSchema({ keywords: ["codigo"] });

    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]!.table).toBe("produtos");
    expect(conn.query).toHaveBeenCalledWith(expect.stringContaining("ilike"), expect.arrayContaining(["public", "%codigo%"]));
  });
});

describe("PostgresSourceAdapter.listSchemas", () => {
  it("lista schemas via information_schema.schemata", async () => {
    const rows = [{ schema_name: "pg_catalog" }, { schema_name: "public" }];
    const conn = makePgConnection(rows);
    const adapter = new PostgresSourceAdapter({ config: pgConfig, connectionFactory: vi.fn(async () => conn) });
    await adapter.connect();

    const result = await adapter.listSchemas();
    expect(result).toContain("public");
    expect(conn.query).toHaveBeenCalledWith(expect.stringContaining("information_schema.schemata"), []);
  });
});
