import { describe, expect, it, vi } from "vitest";
import { createSourceDatabaseAdapter, UnsupportedDatabaseDriverError } from "../../src/db/adapter-factory.js";
import { FirebirdSourceAdapter } from "../../src/db/firebird-adapter.js";
import { MySqlSourceAdapter } from "../../src/db/mysql-adapter.js";
import type { DatabaseConfig } from "../../src/config/types.js";

const mysqlConfig: DatabaseConfig = {
  driver: "mysql",
  host: "localhost",
  port: 3306,
  name: "pharmacy",
  user: "readonly",
  password: "test-db-password"
};

const firebirdConfig: DatabaseConfig = {
  ...mysqlConfig,
  driver: "firebird",
  port: 3050
};

describe("createSourceDatabaseAdapter", () => {
  it("returns MySQL adapter when DB_DRIVER=mysql", () => {
    const adapter = createSourceDatabaseAdapter({
      config: mysqlConfig,
      dependencies: {
        mysqlConnectionFactory: vi.fn(),
        firebirdConnectionFactory: vi.fn()
      }
    });

    expect(adapter).toBeInstanceOf(MySqlSourceAdapter);
  });

  it("returns Firebird adapter when DB_DRIVER=firebird", () => {
    const adapter = createSourceDatabaseAdapter({
      config: firebirdConfig,
      dependencies: {
        mysqlConnectionFactory: vi.fn(),
        firebirdConnectionFactory: vi.fn()
      }
    });

    expect(adapter).toBeInstanceOf(FirebirdSourceAdapter);
  });

  it("rejects unsupported drivers before polling starts", () => {
    expect(() =>
      createSourceDatabaseAdapter({
        config: { ...mysqlConfig, driver: "postgres" as never },
        dependencies: {
          mysqlConnectionFactory: vi.fn(),
          firebirdConnectionFactory: vi.fn()
        }
      })
    ).toThrow(UnsupportedDatabaseDriverError);
  });
});
