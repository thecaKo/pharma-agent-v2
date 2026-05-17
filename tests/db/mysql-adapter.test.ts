import { describe, expect, it, vi } from "vitest";
import { DatabaseOperationError } from "../../src/db/errors.js";
import { MySqlSourceAdapter, type MySqlDriverConnection } from "../../src/db/mysql-adapter.js";
import type { DatabaseConfig } from "../../src/config/types.js";

const config: DatabaseConfig = {
  driver: "mysql",
  host: "127.0.0.1",
  port: 3306,
  name: "pharmacy",
  user: "readonly",
  password: "super-secret-password"
};

describe("MySqlSourceAdapter", () => {
  it("passes configured SQL, cursor, and limit to the database driver boundary", async () => {
    const connection: MySqlDriverConnection = {
      query: vi.fn(async () => [[{ product_id: "P-001", updated_at: 12 }], []]),
      end: vi.fn(async () => undefined)
    };
    const connectionFactory = vi.fn(async () => connection);
    const adapter = new MySqlSourceAdapter({ config, connectionFactory });

    await adapter.connect();
    const rows = await adapter.queryChanges({
      sql: "select * from products where updated_at > ? limit ?",
      cursor: 10,
      limit: 25
    });

    expect(connectionFactory).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 3306,
      database: "pharmacy",
      user: "readonly",
      password: "super-secret-password",
      readonly: true
    });
    expect(connection.query).toHaveBeenCalledWith("select * from products where updated_at > ? limit ?", [10, 25]);
    expect(rows).toEqual([{ product_id: "P-001", updated_at: 12 }]);
  });

  it("coerces timestamp cursor strings into Date values for mysql datetime parameters", async () => {
    const connection: MySqlDriverConnection = {
      query: vi.fn(async () => [[{ product_id: "P-001", updated_at: "2026-05-16 20:00:03" }], []]),
      end: vi.fn(async () => undefined)
    };
    const adapter = new MySqlSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    await adapter.queryChanges({
      sql: "select * from products where updated_at > ? limit ?",
      cursor: "Sat May 16 2026 20:00:02 GMT-0300 (Brasilia Standard Time)",
      limit: 25
    });

    expect(connection.query).toHaveBeenCalledWith("select * from products where updated_at > ? limit ?", [
      expect.any(Date),
      25
    ]);
  });

  it("normalizes connection failures without leaking database password", async () => {
    const adapter = new MySqlSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => {
        throw Object.assign(new Error("Access denied for super-secret-password"), { code: "ER_ACCESS_DENIED_ERROR" });
      })
    });

    await expect(adapter.connect()).rejects.toMatchObject({
      name: "DatabaseOperationError",
      driver: "mysql",
      operation: "connect",
      errorCode: "MYSQL_ER_ACCESS_DENIED_ERROR"
    });

    try {
      await adapter.connect();
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseOperationError);
      expect(String(error)).not.toContain("super-secret-password");
      expect(String(error)).toContain("[REDACTED]");
    }
  });

  it("closes connected sessions and normalizes query before connect", async () => {
    const connection: MySqlDriverConnection = {
      query: vi.fn(async () => []),
      end: vi.fn(async () => undefined)
    };
    const adapter = new MySqlSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    await adapter.close();
    await adapter.close();

    expect(connection.end).toHaveBeenCalledOnce();

    await expect(adapter.queryChanges({ sql: "select 1", cursor: null, limit: 1 })).rejects.toMatchObject({
      driver: "mysql",
      operation: "query",
      errorCode: "MYSQL_DATABASE_ERROR"
    });
  });

  it("normalizes close failures", async () => {
    const adapter = new MySqlSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => ({
        query: vi.fn(async () => []),
        end: vi.fn(async () => {
          throw Object.assign(new Error("connection close timeout"), { code: "ETIMEDOUT" });
        })
      }))
    });

    await adapter.connect();

    await expect(adapter.close()).rejects.toMatchObject({
      driver: "mysql",
      operation: "close",
      errorCode: "MYSQL_ETIMEDOUT",
      retryable: true
    });
  });
});
