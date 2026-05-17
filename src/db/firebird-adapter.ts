import type { DatabaseConfig } from "../config/types.js";
import type { SourceRow } from "../mapping/types.js";
import { normalizeDatabaseError } from "./errors.js";
import type { QueryChangesInput, SourceDatabaseAdapter } from "./source-adapter.js";

export interface FirebirdConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  readonly: true;
}

export interface FirebirdDriverConnection {
  query(sql: string, params: readonly unknown[]): Promise<unknown>;
  detach(): Promise<void>;
}

export type FirebirdConnectionFactory = (config: FirebirdConnectionConfig) => Promise<FirebirdDriverConnection>;

export interface FirebirdSourceAdapterOptions {
  config: DatabaseConfig;
  connectionFactory: FirebirdConnectionFactory;
  secrets?: readonly string[];
}

export class FirebirdSourceAdapter implements SourceDatabaseAdapter {
  private readonly config: DatabaseConfig;
  private readonly connectionFactory: FirebirdConnectionFactory;
  private readonly secrets: readonly string[];
  private connection?: FirebirdDriverConnection;

  public constructor(options: FirebirdSourceAdapterOptions) {
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
        driver: "firebird",
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
      await this.connection.detach();
      this.connection = undefined;
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "firebird",
        operation: "close",
        error,
        secrets: this.secrets
      });
    }
  }

  public async queryChanges(input: QueryChangesInput): Promise<SourceRow[]> {
    const connection = this.requireConnection();

    try {
      const result = await connection.query(input.sql, [input.cursor, input.limit]);
      return normalizeRows(result);
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "firebird",
        operation: "query",
        error,
        secrets: this.secrets
      });
    }
  }

  private requireConnection(): FirebirdDriverConnection {
    if (!this.connection) {
      throw normalizeDatabaseError({
        driver: "firebird",
        operation: "query",
        error: new Error("Database adapter is not connected"),
        secrets: this.secrets
      });
    }
    return this.connection;
  }
}

function normalizeRows(result: unknown): SourceRow[] {
  if (!Array.isArray(result)) {
    return [];
  }
  return result.filter(isRecord).map((row) => ({ ...row }));
}

function isRecord(value: unknown): value is SourceRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
