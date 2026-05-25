import type { DatabaseConfig } from "../config/types.js";
import type { SourceRow } from "../mapping/types.js";
import type { DatabaseOperation } from "./errors.js";
import { normalizeDatabaseError } from "./errors.js";
import type { DatabaseColumn, DatabaseTable, QueryChangesInput, QuerySnapshotPageInput, SourceDatabaseAdapter } from "./source-adapter.js";

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

  public async querySnapshotPage(input: QuerySnapshotPageInput): Promise<SourceRow[]> {
    const connection = this.requireConnection();

    try {
      const result = await connection.query(input.sql, [input.limit, input.offset]);
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

  public async listTables(): Promise<DatabaseTable[]> {
    const connection = this.requireConnection();

    try {
      const result = await connection.query(
        `
          select table_name as name
          from information_schema.tables
          where table_schema = ?
            and table_type = 'BASE TABLE'
          order by table_name
        `,
        [this.config.name]
      );
      return normalizeTables(result);
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "mysql",
        operation: "listTables",
        error,
        secrets: this.secrets
      });
    }
  }

  public async listColumns(tableName: string): Promise<DatabaseColumn[]> {
    const connection = this.requireConnection("listColumns");

    try {
      const result = await connection.query(
        `
          select column_name as name,
                 data_type as dataType,
                 is_nullable as nullable
          from information_schema.columns
          where table_schema = ?
            and table_name = ?
          order by ordinal_position
        `,
        [this.config.name, tableName]
      );
      return normalizeColumns(result);
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "mysql",
        operation: "listColumns",
        error,
        secrets: this.secrets
      });
    }
  }

  private requireConnection(operation: DatabaseOperation = "query"): MySqlDriverConnection {
    if (!this.connection) {
      throw normalizeDatabaseError({
        driver: "mysql",
        operation,
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

function normalizeTables(result: unknown): DatabaseTable[] {
  const rows = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows
    .map(readTableName)
    .filter((name): name is string => name !== undefined)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({ name }));
}

function normalizeColumns(result: unknown): DatabaseColumn[] {
  const rows = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows
    .map(readColumn)
    .filter((column): column is DatabaseColumn => column !== undefined);
}

function readTableName(row: unknown): string | undefined {
  if (!isRecord(row)) {
    return undefined;
  }

  const value = row.name ?? row.TABLE_NAME;
  if (typeof value !== "string") {
    return undefined;
  }

  const name = value.trim();
  return name.length > 0 ? name : undefined;
}

function readColumn(row: unknown): DatabaseColumn | undefined {
  if (!isRecord(row)) {
    return undefined;
  }

  const name = normalizeString(row.name ?? row.COLUMN_NAME);
  if (!name) {
    return undefined;
  }

  return {
    name,
    dataType: normalizeOptionalString(row.dataType ?? row.DATA_TYPE),
    nullable: normalizeNullable(row.nullable ?? row.IS_NULLABLE)
  };
}

function isRecord(value: unknown): value is SourceRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  const normalized = normalizeString(value);
  return normalized?.toLowerCase();
}

function normalizeNullable(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  switch (value.trim().toLowerCase()) {
    case "yes":
    case "y":
    case "true":
    case "1":
      return true;
    case "no":
    case "n":
    case "false":
    case "0":
      return false;
    default:
      return undefined;
  }
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
