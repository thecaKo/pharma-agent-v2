import type { SourceRow } from "../mapping/types.js";
import type { CursorValue } from "../state/state-types.js";

export interface QueryChangesInput {
  sql: string;
  cursor: CursorValue;
  limit: number;
}

export interface SourceDatabaseAdapter {
  connect(): Promise<void>;
  close(): Promise<void>;
  queryChanges(input: QueryChangesInput): Promise<SourceRow[]>;
}

export type SourceDatabaseAdapterKind = "mysql" | "firebird";
