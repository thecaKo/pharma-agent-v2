import { describe, expect, it, vi } from "vitest";
import { createSourceDatabaseAdapter, UnsupportedDatabaseDriverError } from "../../src/db/adapter-factory.js";
import { FirebirdSourceAdapter } from "../../src/db/firebird-adapter.js";
import { MySqlSourceAdapter } from "../../src/db/mysql-adapter.js";
import { PostgresSourceAdapter } from "../../src/db/postgresql-adapter.js";
import { MariaDbSourceAdapter } from "../../src/db/mariadb-adapter.js";
import { SqlServerSourceAdapter } from "../../src/db/sqlserver-adapter.js";
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

const postgresConfig: DatabaseConfig = {
  ...mysqlConfig,
  driver: "postgresql",
  port: 5432
};

const mariadbConfig: DatabaseConfig = {
  ...mysqlConfig,
  driver: "mariadb",
  port: 3306
};

const sqlserverConfig: DatabaseConfig = {
  ...mysqlConfig,
  driver: "sqlserver",
  port: 1433
};

const dependencies = () => ({
  mysqlConnectionFactory: vi.fn(),
  firebirdConnectionFactory: vi.fn(),
  postgresConnectionFactory: vi.fn(),
  mariadbConnectionFactory: vi.fn(),
  sqlserverConnectionFactory: vi.fn()
});

describe("createSourceDatabaseAdapter", () => {
  it("returns MySQL adapter when DB_DRIVER=mysql", () => {
    const adapter = createSourceDatabaseAdapter({
      config: mysqlConfig,
      dependencies: dependencies()
    });
    expect(adapter).toBeInstanceOf(MySqlSourceAdapter);
  });

  it("returns Firebird adapter when DB_DRIVER=firebird", () => {
    const adapter = createSourceDatabaseAdapter({
      config: firebirdConfig,
      dependencies: dependencies()
    });
    expect(adapter).toBeInstanceOf(FirebirdSourceAdapter);
  });

  it("returns Postgres adapter when DB_DRIVER=postgresql", () => {
    const adapter = createSourceDatabaseAdapter({
      config: postgresConfig,
      dependencies: dependencies()
    });
    expect(adapter).toBeInstanceOf(PostgresSourceAdapter);
  });

  it("returns MariaDB adapter when DB_DRIVER=mariadb", () => {
    const adapter = createSourceDatabaseAdapter({
      config: mariadbConfig,
      dependencies: dependencies()
    });
    expect(adapter).toBeInstanceOf(MariaDbSourceAdapter);
  });

  it("returns SQL Server adapter when DB_DRIVER=sqlserver", () => {
    const adapter = createSourceDatabaseAdapter({
      config: sqlserverConfig,
      dependencies: dependencies()
    });
    expect(adapter).toBeInstanceOf(SqlServerSourceAdapter);
  });

  it("rejects unsupported drivers before polling starts", () => {
    expect(() =>
      createSourceDatabaseAdapter({
        config: { ...mysqlConfig, driver: "oracle" as never },
        dependencies: dependencies()
      })
    ).toThrow(UnsupportedDatabaseDriverError);
  });
});
