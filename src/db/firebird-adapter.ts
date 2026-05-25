import type { DatabaseConfig } from "../config/types.js";
import type { SourceRow } from "../mapping/types.js";
import type { DatabaseOperation } from "./errors.js";
import { normalizeDatabaseError } from "./errors.js";
import type { DatabaseColumn, DatabaseTable, QueryChangesInput, QuerySnapshotPageInput, SourceDatabaseAdapter } from "./source-adapter.js";

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

  public async querySnapshotPage(input: QuerySnapshotPageInput): Promise<SourceRow[]> {
    const connection = this.requireConnection();

    try {
      const start = input.offset + 1;
      const end = input.offset + input.limit;
      const result = await connection.query(input.sql, [start, end]);
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

  public async listTables(): Promise<DatabaseTable[]> {
    const connection = this.requireConnection();

    try {
      const result = await connection.query(
        `
          select rdb$relation_name as name
          from rdb$relations
          where coalesce(rdb$system_flag, 0) = 0
            and rdb$view_blr is null
          order by rdb$relation_name
        `,
        []
      );
      return normalizeTables(result);
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "firebird",
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
          select rf.rdb$field_name as name,
                 case f.rdb$field_type
                   when 7 then case coalesce(f.rdb$field_sub_type, 0)
                     when 1 then 'numeric'
                     when 2 then 'decimal'
                     else 'smallint'
                   end
                   when 8 then case coalesce(f.rdb$field_sub_type, 0)
                     when 1 then 'numeric'
                     when 2 then 'decimal'
                     else 'integer'
                   end
                   when 10 then 'float'
                   when 12 then 'date'
                   when 13 then 'time'
                   when 14 then 'char'
                   when 16 then case coalesce(f.rdb$field_sub_type, 0)
                     when 1 then 'numeric'
                     when 2 then 'decimal'
                     else 'bigint'
                   end
                   when 23 then 'boolean'
                   when 27 then 'double precision'
                   when 35 then 'timestamp'
                   when 37 then 'varchar'
                   when 261 then case coalesce(f.rdb$field_sub_type, 0)
                     when 1 then 'text'
                     else 'blob'
                   end
                   else null
                 end as dataType,
                 case
                   when coalesce(rf.rdb$null_flag, f.rdb$null_flag, 0) = 1 then 0
                   else 1
                 end as nullable
          from rdb$relation_fields rf
          join rdb$fields f on f.rdb$field_name = rf.rdb$field_source
          where rf.rdb$relation_name = ?
          order by rf.rdb$field_position
        `,
        [tableName]
      );
      return normalizeColumns(result);
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "firebird",
        operation: "listColumns",
        error,
        secrets: this.secrets
      });
    }
  }

  private requireConnection(operation: DatabaseOperation = "query"): FirebirdDriverConnection {
    if (!this.connection) {
      throw normalizeDatabaseError({
        driver: "firebird",
        operation,
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

function normalizeTables(result: unknown): DatabaseTable[] {
  if (!Array.isArray(result)) {
    return [];
  }

  return result
    .map(readTableName)
    .filter((name): name is string => name !== undefined)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({ name }));
}

function normalizeColumns(result: unknown): DatabaseColumn[] {
  if (!Array.isArray(result)) {
    return [];
  }

  return result
    .map(readColumn)
    .filter((column): column is DatabaseColumn => column !== undefined);
}

function readTableName(row: unknown): string | undefined {
  if (!isRecord(row)) {
    return undefined;
  }

  const value = row.name ?? row.NAME ?? row.RDB$RELATION_NAME;
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

  const name = normalizeString(row.name ?? row.NAME ?? row.RDB$FIELD_NAME);
  if (!name) {
    return undefined;
  }

  return {
    name,
    dataType: normalizeOptionalString(row.dataType ?? row.DATA_TYPE ?? row.DATATYPE),
    nullable: normalizeNullable(row.nullable ?? row.NULLABLE)
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
    case "0":
    case "false":
    case "no":
    case "n":
      return false;
    case "1":
    case "true":
    case "yes":
    case "y":
      return true;
    default:
      return undefined;
  }
}
