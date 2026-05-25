import type { ProductChangeRecord } from "../mapping/types.js";
import type { PendingSnapshotProduct, SnapshotProductState } from "../state/state-types.js";
import { productSnapshotHash } from "./snapshot-hash.js";

export interface DiffSnapshotProductsInput {
  products: readonly ProductChangeRecord[];
  confirmed: Record<string, SnapshotProductState>;
  now: string;
}

export interface DiffSnapshotProductsResult {
  changed: PendingSnapshotProduct[];
  scannedCount: number;
  unchangedCount: number;
}

export function diffSnapshotProducts(input: DiffSnapshotProductsInput): DiffSnapshotProductsResult {
  const changed: PendingSnapshotProduct[] = [];
  let unchangedCount = 0;

  for (const record of input.products) {
    const hash = productSnapshotHash(record);
    const confirmed = input.confirmed[record.sourceProductCode];

    if (confirmed?.hash === hash) {
      unchangedCount += 1;
      continue;
    }

    changed.push({
      sourceProductCode: record.sourceProductCode,
      hash,
      record
    });
  }

  return {
    changed,
    scannedCount: input.products.length,
    unchangedCount
  };
}
