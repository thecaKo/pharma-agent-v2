import { describe, expect, it, vi } from "vitest";
import { DatabaseOperationError } from "../../src/db/errors.js";
import {
  PostgresSourceAdapter,
  type PostgresDriverConnection
} from "../../src/db/postgresql-adapter.js";
import type { DatabaseConfig } from "../../src/config/types.js";

const config: DatabaseConfig = {
  driver: "postgresql",
  host: "127.0.0.1",
  port: 5432,
  name: "vetorfarma",
  user: "readonly",
  password: "super-secret-password"
};

describe("PostgresSourceAdapter", () => {
  it("connects via the injected connection factory with readonly intent", async () => {
    const connection: PostgresDriverConnection = {
      query: vi.fn(async () => ({ rows: [] })),
      end: vi.fn(async () => undefined)
    };
    const connectionFactory = vi.fn(async () => connection);
    const adapter = new PostgresSourceAdapter({ config, connectionFactory });

    await adapter.connect();

    expect(connectionFactory).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 5432,
      database: "vetorfarma",
      user: "readonly",
      password: "super-secret-password",
      readonly: true
    });
  });

  it("normalizes connection failures without leaking password or database name", async () => {
    const adapter = new PostgresSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => {
        throw Object.assign(new Error("password authentication failed for super-secret-password on vetorfarma"), {
          code: "28P01"
        });
      })
    });

    await expect(adapter.connect()).rejects.toMatchObject({
      name: "DatabaseOperationError",
      driver: "postgresql",
      operation: "connect",
      errorCode: "POSTGRESQL_28P01"
    });

    try {
      await adapter.connect();
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseOperationError);
      expect(String(error)).not.toContain("super-secret-password");
      expect(String(error)).not.toContain("vetorfarma");
      expect(String(error)).toContain("[REDACTED]");
    }
  });

  it("closes connected sessions exactly once", async () => {
    const connection: PostgresDriverConnection = {
      query: vi.fn(async () => ({ rows: [] })),
      end: vi.fn(async () => undefined)
    };
    const adapter = new PostgresSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    await adapter.close();
    await adapter.close();

    expect(connection.end).toHaveBeenCalledOnce();
  });

  it("normalizes close failures", async () => {
    const adapter = new PostgresSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => ({
        query: vi.fn(async () => ({ rows: [] })),
        end: vi.fn(async () => {
          throw Object.assign(new Error("connection close timeout"), { code: "ETIMEDOUT" });
        })
      }))
    });

    await adapter.connect();

    await expect(adapter.close()).rejects.toMatchObject({
      driver: "postgresql",
      operation: "close",
      errorCode: "POSTGRESQL_ETIMEDOUT",
      retryable: true
    });
  });

  it("passes SQL and params to the driver and returns rows from .rows", async () => {
    const connection: PostgresDriverConnection = {
      query: vi.fn(async () => ({ rows: [{ product_id: "P-001", updated_at: 12 }] })),
      end: vi.fn(async () => undefined)
    };
    const adapter = new PostgresSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    const rows = await adapter.queryChanges({
      sql: "select * from products where updated_at > $1 order by updated_at limit $2",
      cursor: 10,
      limit: 25
    });

    expect(connection.query).toHaveBeenCalledWith(
      "select * from products where updated_at > $1 order by updated_at limit $2",
      [10, 25]
    );
    expect(rows).toEqual([{ product_id: "P-001", updated_at: 12 }]);
  });

  it("coerces timestamp cursor strings into Date for postgres timestamp params", async () => {
    const connection: PostgresDriverConnection = {
      query: vi.fn(async () => ({ rows: [] })),
      end: vi.fn(async () => undefined)
    };
    const adapter = new PostgresSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    await adapter.queryChanges({
      sql: "select * from products where updated_at > $1 order by updated_at limit $2",
      cursor: "Sat May 16 2026 20:00:02 GMT-0300 (Brasilia Standard Time)",
      limit: 25
    });

    expect(connection.query).toHaveBeenCalledWith(
      "select * from products where updated_at > $1 order by updated_at limit $2",
      [expect.any(Date), 25]
    );
  });

  it("emits LIMIT $1 OFFSET $2 params for snapshot pages", async () => {
    const connection: PostgresDriverConnection = {
      query: vi.fn(async () => ({ rows: [{ product_id: "P-001" }] })),
      end: vi.fn(async () => undefined)
    };
    const adapter = new PostgresSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    await expect(
      adapter.querySnapshotPage({
        sql: "select * from products order by product_id limit $1 offset $2",
        limit: 500,
        offset: 1000
      })
    ).resolves.toEqual([{ product_id: "P-001" }]);

    expect(connection.query).toHaveBeenCalledWith(
      "select * from products order by product_id limit $1 offset $2",
      [500, 1000]
    );
  });

  it("normalizes query errors without leaking secrets", async () => {
    const connection: PostgresDriverConnection = {
      query: vi.fn(async () => {
        throw Object.assign(new Error("relation \"vetorfarma.products\" does not exist; password=super-secret-password"), {
          code: "42P01"
        });
      }),
      end: vi.fn(async () => undefined)
    };
    const adapter = new PostgresSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();

    try {
      await adapter.queryChanges({ sql: "select 1", cursor: null, limit: 1 });
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseOperationError);
      expect(error).toMatchObject({
        driver: "postgresql",
        operation: "query",
        errorCode: "POSTGRESQL_42P01"
      });
      expect(String(error)).not.toContain("super-secret-password");
      expect(String(error)).not.toContain("vetorfarma");
    }
  });

  it("listTables returns schema-qualified names, excluding system schemas", async () => {
    const connection: PostgresDriverConnection = {
      query: vi.fn(async () => ({
        rows: [
          { table_schema: "public", name: "products" },
          { table_schema: "vetor", name: "estoque" }
        ]
      })),
      end: vi.fn(async () => undefined)
    };
    const adapter = new PostgresSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    const tables = await adapter.listTables();

    expect(connection.query).toHaveBeenCalledWith(
      expect.stringContaining("information_schema.tables"),
      []
    );
    expect(connection.query).toHaveBeenCalledWith(
      expect.stringContaining("table_schema not in ('pg_catalog', 'information_schema')"),
      []
    );
    expect(tables).toEqual([
      { name: "public.products" },
      { name: "vetor.estoque" }
    ]);
  });

  it("listTables returns [] when rows are not in the expected shape", async () => {
    const connection: PostgresDriverConnection = {
      query: vi.fn(async () => ({ rows: [{ table: "products" }, null, { name: 123 }] })),
      end: vi.fn(async () => undefined)
    };
    const adapter = new PostgresSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    await expect(adapter.listTables()).resolves.toEqual([]);
  });

  it("listColumns splits schema.table into ($1=schema, $2=name)", async () => {
    const connection: PostgresDriverConnection = {
      query: vi.fn(async () => ({
        rows: [
          { name: "product_id", dataType: "varchar", nullable: "NO" },
          { name: "updated_at", dataType: "timestamp", nullable: "YES" }
        ]
      })),
      end: vi.fn(async () => undefined)
    };
    const adapter = new PostgresSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    const columns = await adapter.listColumns("vetor.estoque");

    expect(connection.query).toHaveBeenCalledWith(
      expect.stringContaining("information_schema.columns"),
      ["vetor", "estoque"]
    );
    expect(columns).toEqual([
      { name: "product_id", dataType: "varchar", nullable: false },
      { name: "updated_at", dataType: "timestamp", nullable: true }
    ]);
  });

  it("listColumns defaults to public schema when no dot is present", async () => {
    const connection: PostgresDriverConnection = {
      query: vi.fn(async () => ({ rows: [] })),
      end: vi.fn(async () => undefined)
    };
    const adapter = new PostgresSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    await adapter.listColumns("products");

    expect(connection.query).toHaveBeenCalledWith(
      expect.stringContaining("information_schema.columns"),
      ["public", "products"]
    );
  });

  it("normalizes listTables failures without leaking secrets", async () => {
    const connection: PostgresDriverConnection = {
      query: vi.fn(async () => {
        throw Object.assign(new Error("permission denied on vetorfarma; super-secret-password"), {
          code: "42501"
        });
      }),
      end: vi.fn(async () => undefined)
    };
    const adapter = new PostgresSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();

    try {
      await adapter.listTables();
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseOperationError);
      expect(error).toMatchObject({
        driver: "postgresql",
        operation: "listTables",
        errorCode: "POSTGRESQL_42501"
      });
      expect(String(error)).not.toContain("super-secret-password");
      expect(String(error)).not.toContain("vetorfarma");
    }
  });
});
