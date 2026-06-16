import type { SourceRow } from "../mapping/types.js";
import type { CursorValue } from "../state/state-types.js";
import type { ProvisionReadonlyUserInput, ProvisionReadonlyUserResult } from "./provision-types.js";

export interface QueryChangesInput {
  sql: string;
  cursor: CursorValue;
  limit: number;
}

export interface QuerySnapshotPageInput {
  sql: string;
  limit: number;
  offset: number;
}

export interface DatabaseTable {
  name: string;
}

export interface DatabaseColumn {
  name: string;
  dataType?: string;
  nullable?: boolean;
}

export interface ForeignKey {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  constraintName?: string;
}

export interface RunReadOnlySelectInput {
  sql: string;
  limit: number;
  timeoutMs?: number;
}

export interface SchemaSearchInput {
  keywords: string[];
  schema?: string;
  maxTables?: number;
}

export interface SchemaMatchedColumn {
  name: string;
  dataType?: string;
  nullable?: boolean;
}

export interface SchemaSearchTable {
  schema?: string;
  table: string;
  matchedColumns: SchemaMatchedColumn[];
}

export interface SchemaSearchResult {
  tables: SchemaSearchTable[];
}

export interface SourceDatabaseAdapter {
  connect(): Promise<void>;
  close(): Promise<void>;
  queryChanges(input: QueryChangesInput): Promise<SourceRow[]>;
  querySnapshotPage(input: QuerySnapshotPageInput): Promise<SourceRow[]>;
  listTables(): Promise<DatabaseTable[]>;
  listColumns(tableName: string): Promise<DatabaseColumn[]>;
  describeTable(tableName: string): Promise<DatabaseColumn[]>;
  listForeignKeys(tableName?: string): Promise<ForeignKey[]>;
  sampleRows(tableName: string, limit: number): Promise<SourceRow[]>;
  runReadOnlySelect(input: RunReadOnlySelectInput): Promise<SourceRow[]>;
  provisionReadonlyUser(input: ProvisionReadonlyUserInput): Promise<ProvisionReadonlyUserResult>;
  searchSchema(input: SchemaSearchInput): Promise<SchemaSearchResult>;
  listSchemas(): Promise<string[]>;
}

export type SourceDatabaseAdapterKind =
  | "mysql"
  | "firebird"
  | "postgresql"
  | "mariadb"
  | "sqlserver";
