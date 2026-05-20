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

  it("queries user table metadata and trims padded relation names", async () => {
    const connection: FirebirdDriverConnection = {
      query: vi.fn(async () => [
        { name: "Z_PRODUCTS                         ", column_count: 12 },
        { name: "PRODUCTS                           ", sample: { product_id: "P-001" } },
        { name: "CUSTOMERS                          ", row_count: 99 }
      ]),
      detach: vi.fn(async () => undefined)
    };
    const adapter = new FirebirdSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    const tables = await adapter.listTables();

    expect(connection.query).toHaveBeenCalledWith(expect.stringContaining("rdb$relations"), []);
    expect(connection.query).toHaveBeenCalledWith(expect.stringContaining("rdb$view_blr is null"), []);
    expect(tables).toEqual([{ name: "CUSTOMERS" }, { name: "PRODUCTS" }, { name: "Z_PRODUCTS" }]);
  });

  it("returns only sorted, non-empty Firebird table names", async () => {
    const connection: FirebirdDriverConnection = {
      query: vi.fn(async () => [
        { "RDB$RELATION_NAME": "PRODUCTS                           " },
        { NAME: "                                  " },
        { NAME: "CUSTOMERS                         " },
        { name: 123 },
        null
      ]),
      detach: vi.fn(async () => undefined)
    };
    const adapter = new FirebirdSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();

    await expect(adapter.listTables()).resolves.toEqual([{ name: "CUSTOMERS" }, { name: "PRODUCTS" }]);
  });

  it("queries column metadata, trims padded identifiers, and normalizes nullability", async () => {
    const connection: FirebirdDriverConnection = {
      query: vi.fn(async () => [
        { name: " PRODUCT_ID                      ", dataType: "VARCHAR", nullable: 0 },
        { RDB$FIELD_NAME: "UPDATED_AT                     ", DATA_TYPE: "TIMESTAMP", NULLABLE: 1 },
        { NAME: "ACTIVE                         ", dataType: " BOOLEAN ", nullable: true }
      ]),
      detach: vi.fn(async () => undefined)
    };
    const adapter = new FirebirdSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    const columns = await adapter.listColumns("PRODUCTS");

    expect(connection.query).toHaveBeenCalledWith(expect.stringContaining("from rdb$relation_fields"), ["PRODUCTS"]);
    expect(connection.query).toHaveBeenCalledWith(expect.stringContaining("rf.rdb$relation_name = ?"), ["PRODUCTS"]);
    expect(columns).toEqual([
      { name: "PRODUCT_ID", dataType: "varchar", nullable: false },
      { name: "UPDATED_AT", dataType: "timestamp", nullable: true },
      { name: "ACTIVE", dataType: "boolean", nullable: true }
    ]);
  });

  it("returns an empty column list when Firebird metadata rows are not in the expected shape", async () => {
    const connection: FirebirdDriverConnection = {
      query: vi.fn(async () => [{ field: "PRODUCT_ID" }, { NAME: " " }, null]),
      detach: vi.fn(async () => undefined)
    };
    const adapter = new FirebirdSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();

    await expect(adapter.listColumns("PRODUCTS")).resolves.toEqual([]);
  });

  it("normalizes discovery failures without leaking password or local database path", async () => {
    const connection: FirebirdDriverConnection = {
      query: vi.fn(async () => {
        throw Object.assign(new Error("Cannot inspect C:\\secret\\PHARMACY.FDB with firebird-secret"), {
          code: "isc_no_priv"
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
      await adapter.listTables();
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseOperationError);
      expect(error).toMatchObject({
        driver: "firebird",
        operation: "listTables",
        errorCode: "FIREBIRD_isc_no_priv"
      });
      expect(String(error)).not.toContain("firebird-secret");
      expect(String(error)).not.toContain("C:\\secret\\PHARMACY.FDB");
      expect(String(error)).toContain("[REDACTED]");
    }
  });

  it("normalizes column discovery failures without leaking password or local database path", async () => {
    const connection: FirebirdDriverConnection = {
      query: vi.fn(async () => {
        throw Object.assign(new Error("Cannot inspect C:\\secret\\PHARMACY.FDB.PRODUCTS with firebird-secret"), {
          code: "isc_dsql_error"
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
      await adapter.listColumns("PRODUCTS");
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseOperationError);
      expect(error).toMatchObject({
        driver: "firebird",
        operation: "listColumns",
        errorCode: "FIREBIRD_isc_dsql_error"
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
