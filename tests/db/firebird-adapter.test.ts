import { describe, expect, it, vi } from "vitest";
import { DatabaseOperationError } from "../../src/db/errors.js";
import { FirebirdSourceAdapter, type FirebirdDriverConnection } from "../../src/db/firebird-adapter.js";
import type { DatabaseConfig } from "../../src/config/types.js";

const config: DatabaseConfig = {
  driver: "firebird",
  host: "127.0.0.1",
  port: 3050,
  name: "C:\\secret\\PHARMACY.FDB",
  user: "readonly",
  password: "firebird-secret"
};

describe("FirebirdSourceAdapter", () => {
  it("passes configured SQL, cursor, and limit to the database driver boundary", async () => {
    const connection: FirebirdDriverConnection = {
      query: vi.fn(async () => [{ product_id: "P-001", updated_at: 12 }]),
      detach: vi.fn(async () => undefined)
    };
    const connectionFactory = vi.fn(async () => connection);
    const adapter = new FirebirdSourceAdapter({ config, connectionFactory });

    await adapter.connect();
    const rows = await adapter.queryChanges({
      sql: "select first ? * from products where updated_at > ?",
      cursor: 10,
      limit: 25
    });

    expect(connectionFactory).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 3050,
      database: "C:\\secret\\PHARMACY.FDB",
      user: "readonly",
      password: "firebird-secret",
      readonly: true
    });
    expect(connection.query).toHaveBeenCalledWith("select first ? * from products where updated_at > ?", [10, 25]);
    expect(rows).toEqual([{ product_id: "P-001", updated_at: 12 }]);
  });

  it("normalizes query failures without leaking password or local database path", async () => {
    const connection: FirebirdDriverConnection = {
      query: vi.fn(async () => {
        throw Object.assign(new Error("Cannot read C:\\secret\\PHARMACY.FDB with firebird-secret"), {
          code: "isc_io_error"
        });
      }),
      detach: vi.fn(async () => undefined)
    };
    const adapter = new FirebirdSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();

    try {
      await adapter.queryChanges({ sql: "select * from products", cursor: null, limit: 1 });
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseOperationError);
      expect(error).toMatchObject({
        driver: "firebird",
        operation: "query",
        errorCode: "FIREBIRD_isc_io_error"
      });
      expect(String(error)).not.toContain("firebird-secret");
      expect(String(error)).not.toContain("C:\\secret\\PHARMACY.FDB");
      expect(String(error)).toContain("[REDACTED]");
    }
  });

  it("closes connected sessions and normalizes query before connect", async () => {
    const connection: FirebirdDriverConnection = {
      query: vi.fn(async () => []),
      detach: vi.fn(async () => undefined)
    };
    const adapter = new FirebirdSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    await adapter.close();
    await adapter.close();

    expect(connection.detach).toHaveBeenCalledOnce();

    await expect(adapter.queryChanges({ sql: "select 1 from rdb$database", cursor: null, limit: 1 })).rejects.toMatchObject({
      driver: "firebird",
      operation: "query",
      errorCode: "FIREBIRD_DATABASE_ERROR"
    });
  });

  it("normalizes close failures", async () => {
    const adapter = new FirebirdSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => ({
        query: vi.fn(async () => []),
        detach: vi.fn(async () => {
          throw Object.assign(new Error("network detach failure"), { code: "isc_network_error" });
        })
      }))
    });

    await adapter.connect();

    await expect(adapter.close()).rejects.toMatchObject({
      driver: "firebird",
      operation: "close",
      errorCode: "FIREBIRD_isc_network_error",
      retryable: true
    });
  });
});
