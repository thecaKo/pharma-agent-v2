import type { DatabaseConfig } from "../config/types.js";
import type { SourceRow } from "../mapping/types.js";
import type { DatabaseOperation } from "./errors.js";
import { normalizeDatabaseError } from "./errors.js";
import { type ProvisionReadonlyUserInput, type ProvisionReadonlyUserResult } from "./provision-types.js";
import type {
  DatabaseColumn,
  DatabaseTable,
  ForeignKey,
  QueryChangesInput,
  QuerySnapshotPageInput,
  RunReadOnlySelectInput,
  SourceDatabaseAdapter
} from "./source-adapter.js";

export interface SqlServerConnectionConfig {
  server: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  encrypt: true;
  trustServerCertificate: boolean;
}

export interface SqlServerDriverConnection {
  query(sql: string, params: Record<string, unknown>): Promise<{ recordset: unknown }>;
  close(): Promise<void>;
}

export type SqlServerConnectionFactory = (
  config: SqlServerConnectionConfig
) => Promise<SqlServerDriverConnection>;

export interface SqlServerSourceAdapterOptions {
  config: DatabaseConfig;
  connectionFactory: SqlServerConnectionFactory;
  secrets?: readonly string[];
}

export class SqlServerSourceAdapter implements SourceDatabaseAdapter {
  private readonly config: DatabaseConfig;
  private readonly connectionFactory: SqlServerConnectionFactory;
  private readonly secrets: readonly string[];
  private connection?: SqlServerDriverConnection;

  public constructor(options: SqlServerSourceAdapterOptions) {
    this.config = options.config;
    this.connectionFactory = options.connectionFactory;
    this.secrets = options.secrets ?? [options.config.password, options.config.name];
  }

  public async connect(): Promise<void> {
    try {
      this.connection = await this.connectionFactory(this.buildConnectionConfig());
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "sqlserver",
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
      await this.connection.close();
      this.connection = undefined;
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "sqlserver",
        operation: "close",
        error,
        secrets: this.secrets
      });
    }
  }

  public async queryChanges(input: QueryChangesInput): Promise<SourceRow[]> {
    const connection = this.requireConnection();
    try {
      const result = await connection.query(input.sql, {
        cursor: normalizeCursorParam(input.cursor),
        limit: input.limit
      });
      return normalizeRows(result.recordset);
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "sqlserver",
        operation: "query",
        error,
        secrets: this.secrets
      });
    }
  }

  public async querySnapshotPage(input: QuerySnapshotPageInput): Promise<SourceRow[]> {
    const connection = this.requireConnection();
    try {
      const result = await connection.query(input.sql, {
        limit: input.limit,
        offset: input.offset
      });
      return normalizeRows(result.recordset);
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "sqlserver",
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
          select name
          from sys.tables
          where is_ms_shipped = 0
          order by name
        `,
        {}
      );
      return normalizeTables(result.recordset);
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "sqlserver",
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
          select c.name as name,
                 t.name as dataType,
                 c.is_nullable as nullable
          from sys.columns c
          join sys.types t on t.user_type_id = c.user_type_id
          where c.object_id = object_id(@table)
          order by c.column_id
        `,
        { table: tableName }
      );
      return normalizeColumns(result.recordset);
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "sqlserver",
        operation: "listColumns",
        error,
        secrets: this.secrets
      });
    }
  }

  private buildConnectionConfig(): SqlServerConnectionConfig {
    const base = {
      database: this.config.name,
      user: this.config.user,
      password: this.config.password,
      encrypt: true as const,
      trustServerCertificate: this.config.trustServerCertificate ?? false
    };

    if (this.config.instance) {
      return {
        ...base,
        server: `${this.config.host}\\${this.config.instance}`
      };
    }

    return {
      ...base,
      server: this.config.host,
      port: this.config.port
    };
  }

  public async describeTable(_tableName: string): Promise<DatabaseColumn[]> { throw notSupported("describeTable"); }
  public async listForeignKeys(_tableName?: string): Promise<ForeignKey[]> { throw notSupported("listForeignKeys"); }
  public async sampleRows(_tableName: string, _limit: number): Promise<SourceRow[]> { throw notSupported("sampleRows"); }
  public async runReadOnlySelect(_input: RunReadOnlySelectInput): Promise<SourceRow[]> { throw notSupported("runReadOnlySelect"); }

  public async provisionReadonlyUser(input: ProvisionReadonlyUserInput): Promise<ProvisionReadonlyUserResult> {
    const connection = this.requireConnection("provision");
    const login = quoteSqlServerIdentifier(input.username);
    try {
      // CREATE/ALTER LOGIN via sp_executesql: identificador quotado por QUOTENAME,
      // senha entra como parâmetro @pwd do dinâmico (nunca concatenada).
      await connection.query(
        `DECLARE @sql nvarchar(max);
         IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = @user)
           SET @sql = N'CREATE LOGIN ' + QUOTENAME(@user) + N' WITH PASSWORD = ' + QUOTENAME(@pwd, '''');
         ELSE
           SET @sql = N'ALTER LOGIN ' + QUOTENAME(@user) + N' WITH PASSWORD = ' + QUOTENAME(@pwd, '''');
         EXEC sp_executesql @sql;`,
        { user: input.username, pwd: input.password }
      );
      await connection.query(
        `DECLARE @sql nvarchar(max);
         IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = @user)
           SET @sql = N'CREATE USER ' + QUOTENAME(@user) + N' FOR LOGIN ' + QUOTENAME(@user);
         IF @sql IS NOT NULL EXEC sp_executesql @sql;`,
        { user: input.username }
      );
      await connection.query(`ALTER ROLE db_datareader ADD MEMBER ${login};`, {});
      return { outcome: "provisioned", grantedScope: "all_tables" };
    } catch (error) {
      if (isSqlServerPrivilegeError(error)) {
        return { outcome: "fallback_no_privilege", grantedScope: "all_tables" };
      }
      throw normalizeDatabaseError({ driver: "sqlserver", operation: "provision", error, secrets: this.secrets });
    }
  }

  private requireConnection(operation: DatabaseOperation = "query"): SqlServerDriverConnection {
    if (!this.connection) {
      throw normalizeDatabaseError({
        driver: "sqlserver",
        operation,
        error: new Error("Database adapter is not connected"),
        secrets: this.secrets
      });
    }
    return this.connection;
  }
}

function normalizeRows(recordset: unknown): SourceRow[] {
  if (!Array.isArray(recordset)) {
    return [];
  }
  return recordset.filter(isRecord).map((row) => ({ ...row }));
}

function normalizeTables(recordset: unknown): DatabaseTable[] {
  if (!Array.isArray(recordset)) {
    return [];
  }
  return recordset
    .map(readTableName)
    .filter((name): name is string => name !== undefined)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({ name }));
}

function normalizeColumns(recordset: unknown): DatabaseColumn[] {
  if (!Array.isArray(recordset)) {
    return [];
  }
  return recordset.map(readColumn).filter((c): c is DatabaseColumn => c !== undefined);
}

function readTableName(row: unknown): string | undefined {
  if (!isRecord(row)) return undefined;
  const value = row.name;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readColumn(row: unknown): DatabaseColumn | undefined {
  if (!isRecord(row)) return undefined;
  const name = normalizeString(row.name);
  if (!name) return undefined;
  return {
    name,
    dataType: normalizeOptionalString(row.dataType),
    nullable: normalizeNullable(row.nullable)
  };
}

function isRecord(value: unknown): value is SourceRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  const normalized = normalizeString(value);
  return normalized?.toLowerCase();
}

function normalizeNullable(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return undefined;
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
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsedAt = Date.parse(trimmed);
  return Number.isNaN(parsedAt) ? trimmed : new Date(parsedAt);
}

function notSupported(op: string): Error {
  return new Error(`${op} is not supported for this driver`);
}

function quoteSqlServerIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
    throw new Error(`identificador inválido para SQL Server: ${name}`);
  }
  return `[${name}]`;
}

function isSqlServerPrivilegeError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const num = (error as { number?: unknown }).number ?? (error as { code?: unknown }).code;
  const numeric = typeof num === "number" ? num : Number(num);
  return numeric === 229 || numeric === 15247;
}
