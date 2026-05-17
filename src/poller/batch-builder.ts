import { randomUUID } from "node:crypto";
import type { ProductChangeRecord } from "../mapping/types.js";
import type { CursorValue } from "../state/state-types.js";

export interface ProductChangeBatch {
  batchId: string;
  connectorId: string;
  customerId: string;
  mappingVersion: string;
  cursorBefore: CursorValue;
  cursorAfter: CursorValue;
  records: ProductChangeRecord[];
  createdAt: string;
}

export interface BuildProductBatchInput {
  connectorId: string;
  customerId: string;
  mappingVersion: string;
  cursorBefore: CursorValue;
  cursorAfter: CursorValue;
  records: readonly ProductChangeRecord[];
  batchId?: string;
  createdAt?: string;
}

export function buildProductBatch(input: BuildProductBatchInput): ProductChangeBatch {
  return {
    batchId: input.batchId ?? randomUUID(),
    connectorId: input.connectorId,
    customerId: input.customerId,
    mappingVersion: input.mappingVersion,
    cursorBefore: input.cursorBefore,
    cursorAfter: input.cursorAfter,
    records: [...input.records],
    createdAt: input.createdAt ?? new Date().toISOString()
  };
}
