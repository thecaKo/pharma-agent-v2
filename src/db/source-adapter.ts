import type { SourceRow } from "../mapping/types.js";
import type { CursorValue } from "../state/state-types.js";

export interface QueryChangesInput {
  sql: string;
  cursor: CursorValue;
  limit: number;
}

export interface DatabaseTable {
  name: string;
}

export interface DatabaseColumn {
  name: string;
  dataType?: string;
  nullable?: boolean;
}

export interface SourceDatabaseAdapter {
  connect(): Promise<void>;
  close(): Promise<void>;
  queryChanges(input: QueryChangesInput): Promise<SourceRow[]>;
  listTables(): Promise<DatabaseTable[]>;
  listColumns(tableName: string): Promise<DatabaseColumn[]>;
}

export type SourceDatabaseAdapterKind = "mysql" | "firebird";
