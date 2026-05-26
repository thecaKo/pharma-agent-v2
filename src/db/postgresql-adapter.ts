import type { DatabaseConfig } from "../config/types.js";
import type { SourceRow } from "../mapping/types.js";
import type { DatabaseOperation } from "./errors.js";
import { normalizeDatabaseError } from "./errors.js";
import type {
  DatabaseColumn,
  DatabaseTable,
  QueryChangesInput,
  QuerySnapshotPageInput,
  SourceDatabaseAdapter
} from "./source-adapter.js";

export interface PostgresConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  readonly: true;
}

export interface PostgresDriverConnection {
  query(sql: string, params: readonly unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

export type PostgresConnectionFactory = (
  config: PostgresConnectionConfig
) => Promise<PostgresDriverConnection>;

export interface PostgresSourceAdapterOptions {
  config: DatabaseConfig;
  connectionFactory: PostgresConnectionFactory;
  secrets?: readonly string[];
}

export class PostgresSourceAdapter implements SourceDatabaseAdapter {
  private readonly config: DatabaseConfig;
  private readonly connectionFactory: PostgresConnectionFactory;
  private readonly secrets: readonly string[];
  private connection?: PostgresDriverConnection;

  public constructor(options: PostgresSourceAdapterOptions) {
    this.config = options.config;
    this.connectionFactory = options.connectionFactory;
    this.secrets = options.secrets ?? [options.config.password, options.config.name];
  }

  public async connect(): Promise<void> {
    try {
      this.connection = await this.connectionFactory({
        host: this.config.host,
        port: this.config.port,
        database: this.config.name,
        user: this.config.user,
        password: this.config.password,
        readonly: true
      });
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "postgresql",
        operation: "connect",
        error,
        secrets: this.secrets
      });
    }
  }

  public async close(): Promise<void> {
    if (!this.connection) {
      return;
    }
    try {
      await this.connection.end();
      this.connection = undefined;
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "postgresql",
        operation: "close",
        error,
        secrets: this.secrets
      });
    }
  }

  public async queryChanges(_input: QueryChangesInput): Promise<SourceRow[]> {
    throw new Error("not implemented yet");
  }

  public async querySnapshotPage(_input: QuerySnapshotPageInput): Promise<SourceRow[]> {
    throw new Error("not implemented yet");
  }

  public async listTables(): Promise<DatabaseTable[]> {
    throw new Error("not implemented yet");
  }

  public async listColumns(_tableName: string): Promise<DatabaseColumn[]> {
    throw new Error("not implemented yet");
  }

  private requireConnection(operation: DatabaseOperation = "query"): PostgresDriverConnection {
    if (!this.connection) {
      throw normalizeDatabaseError({
        driver: "postgresql",
        operation,
        error: new Error("Database adapter is not connected"),
        secrets: this.secrets
      });
    }
    return this.connection;
  }
}
