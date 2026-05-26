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
});
