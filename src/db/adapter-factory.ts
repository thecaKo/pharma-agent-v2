import type { DatabaseConfig, DatabaseDriver } from "../config/types.js";
import { FirebirdSourceAdapter, type FirebirdConnectionFactory } from "./firebird-adapter.js";
import { MySqlSourceAdapter, type MySqlConnectionFactory } from "./mysql-adapter.js";
import { PostgresSourceAdapter, type PostgresConnectionFactory } from "./postgresql-adapter.js";
import type { SourceDatabaseAdapter } from "./source-adapter.js";

export interface AdapterFactoryDependencies {
  mysqlConnectionFactory: MySqlConnectionFactory;
  firebirdConnectionFactory: FirebirdConnectionFactory;
  postgresConnectionFactory: PostgresConnectionFactory;
}

export interface CreateSourceAdapterInput {
  config: DatabaseConfig;
  dependencies: AdapterFactoryDependencies;
  secrets?: readonly string[];
}

export class UnsupportedDatabaseDriverError extends Error {
  public readonly driver: string;

  public constructor(driver: string) {
    super(`Unsupported database driver: ${driver}`);
    this.name = "UnsupportedDatabaseDriverError";
    this.driver = driver;
  }
}

export function createSourceDatabaseAdapter(input: CreateSourceAdapterInput): SourceDatabaseAdapter {
  switch (input.config.driver as DatabaseDriver | string) {
    case "mysql":
      return new MySqlSourceAdapter({
        config: input.config,
        connectionFactory: input.dependencies.mysqlConnectionFactory,
        secrets: input.secrets
      });
    case "firebird":
      return new FirebirdSourceAdapter({
        config: input.config,
        connectionFactory: input.dependencies.firebirdConnectionFactory,
        secrets: input.secrets
      });
    case "postgresql":
      return new PostgresSourceAdapter({
        config: input.config,
        connectionFactory: input.dependencies.postgresConnectionFactory,
        secrets: input.secrets
      });
    default:
      throw new UnsupportedDatabaseDriverError(String(input.config.driver));
  }
}
