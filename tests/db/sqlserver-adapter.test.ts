import { describe, expect, it, vi } from "vitest";
import { DatabaseOperationError } from "../../src/db/errors.js";
import {
  SqlServerSourceAdapter,
  type SqlServerDriverConnection
} from "../../src/db/sqlserver-adapter.js";
import type { DatabaseConfig } from "../../src/config/types.js";

const baseConfig: DatabaseConfig = {
  driver: "sqlserver",
  host: "10.0.0.5",
  port: 1433,
  name: "pharmacy",
  user: "readonly",
  password: "super-secret-password"
};

describe("SqlServerSourceAdapter", () => {
  it("opens a connection with host+port and TLS encryption enabled by default", async () => {
    const connection: SqlServerDriverConnection = {
      query: vi.fn(async () => ({ recordset: [] })),
      close: vi.fn(async () => undefined)
    };
    const connectionFactory = vi.fn(async () => connection);
    const adapter = new SqlServerSourceAdapter({ config: baseConfig, connectionFactory });

    await adapter.connect();

    expect(connectionFactory).toHaveBeenCalledWith({
      server: "10.0.0.5",
      port: 1433,
      database: "pharmacy",
      user: "readonly",
      password: "super-secret-password",
      encrypt: true,
      trustServerCertificate: false
    });
  });

  it("opens a connection with named instance and omits port when instance is set", async () => {
    const connection: SqlServerDriverConnection = {
      query: vi.fn(async () => ({ recordset: [] })),
      close: vi.fn(async () => undefined)
    };
    const connectionFactory = vi.fn(async () => connection);
    const adapter = new SqlServerSourceAdapter({
      config: { ...baseConfig, instance: "SQLEXPRESS", port: 0 },
      connectionFactory
    });

    await adapter.connect();

    expect(connectionFactory).toHaveBeenCalledWith({
      server: "10.0.0.5\\SQLEXPRESS",
      database: "pharmacy",
      user: "readonly",
      password: "super-secret-password",
      encrypt: true,
      trustServerCertificate: false
    });
  });

  it("passes trustServerCertificate=true when configured", async () => {
    const connection: SqlServerDriverConnection = {
      query: vi.fn(async () => ({ recordset: [] })),
      close: vi.fn(async () => undefined)
    };
    const connectionFactory = vi.fn(async () => connection);
    const adapter = new SqlServerSourceAdapter({
      config: { ...baseConfig, trustServerCertificate: true },
      connectionFactory
    });

    await adapter.connect();

    expect(connectionFactory).toHaveBeenCalledWith(
      expect.objectContaining({ trustServerCertificate: true })
    );
  });

  it("passes configured SQL, cursor and limit to the database driver boundary", async () => {
    const connection: SqlServerDriverConnection = {
      query: vi.fn(async () => ({ recordset: [{ product_id: "P-001", updated_at: 12 }] })),
      close: vi.fn(async () => undefined)
    };
    const adapter = new SqlServerSourceAdapter({
      config: baseConfig,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    const rows = await adapter.queryChanges({
      sql: "select * from products where updated_at > @cursor order by updated_at offset 0 rows fetch next @limit rows only",
      cursor: 10,
      limit: 25
    });

    expect(connection.query).toHaveBeenCalledWith(
      "select * from products where updated_at > @cursor order by updated_at offset 0 rows fetch next @limit rows only",
      { cursor: 10, limit: 25 }
    );
    expect(rows).toEqual([{ product_id: "P-001", updated_at: 12 }]);
  });

  it("queries snapshot pages with limit and offset", async () => {
    const connection: SqlServerDriverConnection = {
      query: vi.fn(async () => ({ recordset: [{ product_id: "P-001" }] })),
      close: vi.fn(async () => undefined)
    };
    const adapter = new SqlServerSourceAdapter({
      config: baseConfig,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    await expect(
      adapter.querySnapshotPage({
        sql: "select * from products order by product_id offset @offset rows fetch next @limit rows only",
        limit: 500,
        offset: 1000
      })
    ).resolves.toEqual([{ product_id: "P-001" }]);

    expect(connection.query).toHaveBeenCalledWith(
      "select * from products order by product_id offset @offset rows fetch next @limit rows only",
      { limit: 500, offset: 1000 }
    );
  });

  it("coerces timestamp cursor strings into Date values", async () => {
    const connection: SqlServerDriverConnection = {
      query: vi.fn(async () => ({ recordset: [] })),
      close: vi.fn(async () => undefined)
    };
    const adapter = new SqlServerSourceAdapter({
      config: baseConfig,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    await adapter.queryChanges({
      sql: "select * from products where updated_at > @cursor",
      cursor: "2026-05-16T20:00:02.000Z",
      limit: 25
    });

    expect(connection.query).toHaveBeenCalledWith(expect.any(String), {
      cursor: expect.any(Date),
      limit: 25
    });
  });

  it("queries table metadata via sys.tables and returns sorted names", async () => {
    const connection: SqlServerDriverConnection = {
      query: vi.fn(async () => ({
        recordset: [{ name: "z_products" }, { name: "customers" }, { name: "products" }]
      })),
      close: vi.fn(async () => undefined)
    };
    const adapter = new SqlServerSourceAdapter({
      config: baseConfig,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    const tables = await adapter.listTables();

    expect(connection.query).toHaveBeenCalledWith(expect.stringContaining("sys.tables"), {});
    expect(tables).toEqual([{ name: "customers" }, { name: "products" }, { name: "z_products" }]);
  });

  it("returns empty list when metadata rows are not in expected shape", async () => {
    const connection: SqlServerDriverConnection = {
      query: vi.fn(async () => ({ recordset: [{ table: "products" }, { name: 123 }, null] })),
      close: vi.fn(async () => undefined)
    };
    const adapter = new SqlServerSourceAdapter({
      config: baseConfig,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    await expect(adapter.listTables()).resolves.toEqual([]);
  });

  it("queries column metadata via sys.columns and normalizes types", async () => {
    const connection: SqlServerDriverConnection = {
      query: vi.fn(async () => ({
        recordset: [
          { name: " PRODUCT_ID ", dataType: "VARCHAR", nullable: 0 },
          { name: "updated_at", dataType: "DATETIME", nullable: 1 },
          { name: "stock", dataType: " int ", nullable: true }
        ]
      })),
      close: vi.fn(async () => undefined)
    };
    const adapter = new SqlServerSourceAdapter({
      config: baseConfig,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    const columns = await adapter.listColumns("products");

    expect(connection.query).toHaveBeenCalledWith(expect.stringContaining("sys.columns"), {
      table: "products"
    });
    expect(columns).toEqual([
      { name: "PRODUCT_ID", dataType: "varchar", nullable: false },
      { name: "updated_at", dataType: "datetime", nullable: true },
      { name: "stock", dataType: "int", nullable: true }
    ]);
  });

  it("normalizes query failures without leaking password or db name", async () => {
    const connection: SqlServerDriverConnection = {
      query: vi.fn(async () => {
        throw Object.assign(new Error("Login failed for pharmacy using super-secret-password"), {
          code: "ELOGIN"
        });
      }),
      close: vi.fn(async () => undefined)
    };
    const adapter = new SqlServerSourceAdapter({
      config: baseConfig,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    try {
      await adapter.listTables();
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseOperationError);
      expect(error).toMatchObject({
        driver: "sqlserver",
        operation: "listTables",
        errorCode: "SQLSERVER_ELOGIN"
      });
      expect(String(error)).not.toContain("super-secret-password");
      expect(String(error)).not.toContain("pharmacy");
      expect(String(error)).toContain("[REDACTED]");
    }
  });

  it("normalizes connection failures without leaking password", async () => {
    const adapter = new SqlServerSourceAdapter({
      config: baseConfig,
      connectionFactory: vi.fn(async () => {
        throw Object.assign(new Error("Login failed: super-secret-password"), { code: "ELOGIN" });
      })
    });

    await expect(adapter.connect()).rejects.toMatchObject({
      name: "DatabaseOperationError",
      driver: "sqlserver",
      operation: "connect",
      errorCode: "SQLSERVER_ELOGIN"
    });

    try {
      await adapter.connect();
    } catch (error) {
      expect(String(error)).not.toContain("super-secret-password");
      expect(String(error)).toContain("[REDACTED]");
    }
  });

  it("closes connected sessions and rejects queries after close", async () => {
    const connection: SqlServerDriverConnection = {
      query: vi.fn(async () => ({ recordset: [] })),
      close: vi.fn(async () => undefined)
    };
    const adapter = new SqlServerSourceAdapter({
      config: baseConfig,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    await adapter.close();
    await adapter.close();

    expect(connection.close).toHaveBeenCalledOnce();

    await expect(
      adapter.queryChanges({ sql: "select 1", cursor: null, limit: 1 })
    ).rejects.toMatchObject({
      driver: "sqlserver",
      operation: "query",
      errorCode: "SQLSERVER_DATABASE_ERROR"
    });
  });

  it("normalizes close failures", async () => {
    const adapter = new SqlServerSourceAdapter({
      config: baseConfig,
      connectionFactory: vi.fn(async () => ({
        query: vi.fn(async () => ({ recordset: [] })),
        close: vi.fn(async () => {
          throw Object.assign(new Error("connection close timeout"), { code: "ETIMEDOUT" });
        })
      }))
    });

    await adapter.connect();

    await expect(adapter.close()).rejects.toMatchObject({
      driver: "sqlserver",
      operation: "close",
      errorCode: "SQLSERVER_ETIMEDOUT",
      retryable: true
    });
  });
});
