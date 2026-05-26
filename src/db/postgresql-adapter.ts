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

  public async queryChanges(input: QueryChangesInput): Promise<SourceRow[]> {
    const connection = this.requireConnection();

    try {
      const result = await connection.query(input.sql, [
        normalizeCursorParam(input.cursor),
        input.limit
      ]);
      return normalizeRows(result);
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "postgresql",
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
        driver: "postgresql",
        operation: "query",
        error,
        secrets: this.secrets
      });
    }
  }

  public async listTables(): Promise<DatabaseTable[]> {
    const connection = this.requireConnection("listTables");

    try {
      const result = await connection.query(
        `
          select table_schema, table_name as name
          from information_schema.tables
          where table_schema not in ('pg_catalog', 'information_schema')
            and table_type = 'BASE TABLE'
          order by table_schema, table_name
        `,
        []
      );
      return normalizePostgresTables(result);
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "postgresql",
        operation: "listTables",
        error,
        secrets: this.secrets
      });
    }
  }

  public async listColumns(tableName: string): Promise<DatabaseColumn[]> {
    const connection = this.requireConnection("listColumns");
    const { schema, name } = splitQualifiedTable(tableName);

    try {
      const result = await connection.query(
        `
          select column_name as name,
                 data_type as "dataType",
                 is_nullable as nullable
          from information_schema.columns
          where table_schema = $1
            and table_name = $2
          order by ordinal_position
        `,
        [schema, name]
      );
      return normalizePostgresColumns(result);
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "postgresql",
        operation: "listColumns",
        error,
        secrets: this.secrets
      });
    }
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

function normalizeRows(result: unknown): SourceRow[] {
  if (isRecord(result) && Array.isArray((result as { rows?: unknown }).rows)) {
    return ((result as { rows: unknown[] }).rows.filter(isRecord) as SourceRow[]).map(
      (row) => ({ ...row })
    );
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
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

function splitQualifiedTable(tableName: string): { schema: string; name: string } {
  const trimmed = tableName.trim();
  const dotIndex = trimmed.indexOf(".");
  if (dotIndex <= 0 || dotIndex === trimmed.length - 1) {
    return { schema: "public", name: trimmed };
  }
  return {
    schema: trimmed.slice(0, dotIndex),
    name: trimmed.slice(dotIndex + 1)
  };
}

function normalizePostgresTables(result: unknown): DatabaseTable[] {
  if (!isRecord(result) || !Array.isArray((result as { rows?: unknown }).rows)) {
    return [];
  }
  const rows = (result as { rows: unknown[] }).rows;
  return rows
    .map((row) => readPostgresTable(row))
    .filter((entry): entry is DatabaseTable => entry !== undefined);
}

function readPostgresTable(row: unknown): DatabaseTable | undefined {
  if (!isRecord(row)) {
    return undefined;
  }
  const schemaValue = row.table_schema;
  const nameValue = row.name;
  if (typeof schemaValue !== "string" || typeof nameValue !== "string") {
    return undefined;
  }
  const schema = schemaValue.trim();
  const name = nameValue.trim();
  if (!schema || !name) {
    return undefined;
  }
  return { name: `${schema}.${name}` };
}

function normalizePostgresColumns(result: unknown): DatabaseColumn[] {
  if (!isRecord(result) || !Array.isArray((result as { rows?: unknown }).rows)) {
    return [];
  }
  const rows = (result as { rows: unknown[] }).rows;
  return rows
    .map((row) => readPostgresColumn(row))
    .filter((entry): entry is DatabaseColumn => entry !== undefined);
}

function readPostgresColumn(row: unknown): DatabaseColumn | undefined {
  if (!isRecord(row)) {
    return undefined;
  }
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (!name) {
    return undefined;
  }
  return {
    name,
    dataType: typeof row.dataType === "string" ? row.dataType.trim().toLowerCase() : undefined,
    nullable: readNullable(row.nullable)
  };
}

function readNullable(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "yes") return true;
  if (normalized === "no") return false;
  return undefined;
}
