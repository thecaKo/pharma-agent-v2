import { describe, expect, it, vi } from "vitest";
import { MySqlSourceAdapter, type MySqlDriverConnection } from "../../src/db/mysql-adapter.js";
import { PostgresSourceAdapter, type PostgresDriverConnection } from "../../src/db/postgresql-adapter.js";
import { SqlServerSourceAdapter, type SqlServerDriverConnection } from "../../src/db/sqlserver-adapter.js";
import { FirebirdSourceAdapter, type FirebirdDriverConnection } from "../../src/db/firebird-adapter.js";
import { MariaDbSourceAdapter, type MariaDbDriverConnection } from "../../src/db/mariadb-adapter.js";
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

const sqlserverConfig: DatabaseConfig = {
  driver: "sqlserver",
  host: "127.0.0.1",
  port: 1433,
  name: "pharmacy",
  user: "ro",
  password: "secret"
};

const firebirdConfig: DatabaseConfig = {
  driver: "firebird",
  host: "127.0.0.1",
  port: 3050,
  name: "pharmacy",
  user: "ro",
  password: "secret"
};

const mariadbConfig: DatabaseConfig = {
  driver: "mariadb",
  host: "127.0.0.1",
  port: 3306,
  name: "pharmacy",
  user: "ro",
  password: "secret"
};

function makeSqlServerConnection(rows: Record<string, unknown>[]): SqlServerDriverConnection {
  return {
    query: vi.fn(async () => ({ recordset: rows })),
    close: vi.fn(async () => undefined)
  };
}

function makeFirebirdConnection(rows: Record<string, unknown>[]): FirebirdDriverConnection {
  return {
    query: vi.fn(async () => rows),
    detach: vi.fn(async () => undefined)
  };
}

function makeMariaDbConn(rows: Record<string, unknown>[]): MariaDbDriverConnection {
  return {
    query: vi.fn(async () => [rows, []]),
    end: vi.fn(async () => undefined)
  };
}

describe("SqlServerSourceAdapter.searchSchema", () => {
  it("retorna tabelas com schema e nullable", async () => {
    const rows = [
      { schema_name: "dbo", table_name: "produtos", column_name: "codigo", data_type: "varchar", nullable: 0 }
    ];
    const conn = makeSqlServerConnection(rows);
    const adapter = new SqlServerSourceAdapter({ config: sqlserverConfig, connectionFactory: vi.fn(async () => conn) });
    await adapter.connect();

    const result = await adapter.searchSchema({ keywords: ["codigo"] });

    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]!.schema).toBe("dbo");
    expect(result.tables[0]!.table).toBe("produtos");
    expect(result.tables[0]!.matchedColumns[0]!.nullable).toBe(false);
  });

  it("filtra por input.schema quando fornecido", async () => {
    const conn = makeSqlServerConnection([]);
    const adapter = new SqlServerSourceAdapter({ config: sqlserverConfig, connectionFactory: vi.fn(async () => conn) });
    await adapter.connect();

    await adapter.searchSchema({ keywords: ["codigo"], schema: "historico" });

    expect(conn.query).toHaveBeenCalledWith(
      expect.stringContaining("@schema"),
      expect.objectContaining({ schema: "historico" })
    );
  });

  it("separa tabelas de schemas diferentes com mesmo nome (dbo.x vs historico.x)", async () => {
    const rows = [
      { schema_name: "dbo", table_name: "estoque", column_name: "codigo", data_type: "int", nullable: 0 },
      { schema_name: "historico", table_name: "estoque", column_name: "codigo", data_type: "int", nullable: 1 }
    ];
    const conn = makeSqlServerConnection(rows);
    const adapter = new SqlServerSourceAdapter({ config: sqlserverConfig, connectionFactory: vi.fn(async () => conn) });
    await adapter.connect();

    const result = await adapter.searchSchema({ keywords: ["codigo"] });

    expect(result.tables).toHaveLength(2);
    const schemas = result.tables.map((t) => t.schema).sort();
    expect(schemas).toEqual(["dbo", "historico"]);
  });

  it("multi-keyword: tabela que aparece em dois keywords não duplica coluna", async () => {
    const conn = makeSqlServerConnection([]);
    (conn.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ recordset: [{ schema_name: "dbo", table_name: "produtos", column_name: "codigo", data_type: "varchar", nullable: 0 }] })
      .mockResolvedValueOnce({ recordset: [{ schema_name: "dbo", table_name: "produtos", column_name: "codigo_barras", data_type: "varchar", nullable: 1 }] });
    const adapter = new SqlServerSourceAdapter({ config: sqlserverConfig, connectionFactory: vi.fn(async () => conn) });
    await adapter.connect();

    const result = await adapter.searchSchema({ keywords: ["codigo", "barras"] });

    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]!.matchedColumns).toHaveLength(2);
  });
});

describe("FirebirdSourceAdapter.searchSchema", () => {
  it("retorna tabelas com coluna e nullable", async () => {
    const rows = [
      { table_name: "PRODUTOS", column_name: "CODIGO", nullable: 0 }
    ];
    const conn = makeFirebirdConnection(rows);
    const adapter = new FirebirdSourceAdapter({ config: firebirdConfig, connectionFactory: vi.fn(async () => conn) });
    await adapter.connect();

    const result = await adapter.searchSchema({ keywords: ["CODIGO"] });

    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]!.table).toBe("PRODUTOS");
    expect(result.tables[0]!.matchedColumns[0]!.nullable).toBe(false);
  });
});

describe("MariaDbSourceAdapter.searchSchema", () => {
  it("retorna nullable em matchedColumns", async () => {
    const rows = [
      { table_name: "produtos", column_name: "codigo", data_type: "varchar", is_nullable: "YES" }
    ];
    const conn = makeMariaDbConn(rows);
    const adapter = new MariaDbSourceAdapter({ config: mariadbConfig, connectionFactory: vi.fn(async () => conn) });
    await adapter.connect();

    const result = await adapter.searchSchema({ keywords: ["codigo"] });

    expect(result.tables[0]!.matchedColumns[0]!.nullable).toBe(true);
  });
});
