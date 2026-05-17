import type { DatabaseConfig } from "../config/types.js";
import type { SourceRow } from "../mapping/types.js";
import { normalizeDatabaseError } from "./errors.js";
import type { QueryChangesInput, SourceDatabaseAdapter } from "./source-adapter.js";

export interface MySqlConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  readonly: true;
}

export interface MySqlDriverConnection {
  query(sql: string, params: readonly unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

export type MySqlConnectionFactory = (config: MySqlConnectionConfig) => Promise<MySqlDriverConnection>;

export interface MySqlSourceAdapterOptions {
  config: DatabaseConfig;
  connectionFactory: MySqlConnectionFactory;
  secrets?: readonly string[];
}

export class MySqlSourceAdapter implements SourceDatabaseAdapter {
  private readonly config: DatabaseConfig;
  private readonly connectionFactory: MySqlConnectionFactory;
  private readonly secrets: readonly string[];
  private connection?: MySqlDriverConnection;

  public constructor(options: MySqlSourceAdapterOptions) {
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
        driver: "mysql",
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
        driver: "mysql",
        operation: "close",
        error,
        secrets: this.secrets
      });
    }
  }

  public async queryChanges(input: QueryChangesInput): Promise<SourceRow[]> {
    const connection = this.requireConnection();

    try {
      const result = await connection.query(input.sql, [normalizeCursorParam(input.cursor), input.limit]);
      return normalizeRows(result);
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "mysql",
        operation: "query",
        error,
        secrets: this.secrets
      });
    }
  }

  private requireConnection(): MySqlDriverConnection {
    if (!this.connection) {
      throw normalizeDatabaseError({
        driver: "mysql",
        operation: "query",
        error: new Error("Database adapter is not connected"),
        secrets: this.secrets
      });
    }
    return this.connection;
  }
}

function normalizeRows(result: unknown): SourceRow[] {
  const rows = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.filter(isRecord).map((row) => ({ ...row }));
}

function isRecord(value: unknown): value is SourceRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCursorParam(value: QueryChangesInput["cursor"]): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    return null;
  }

  const parsedAt = Date.parse(normalized);
  return Number.isNaN(parsedAt) ? normalized : new Date(parsedAt);
}
