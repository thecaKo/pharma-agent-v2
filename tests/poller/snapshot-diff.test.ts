import { describe, expect, it } from "vitest";
import { diffSnapshotProducts } from "../../src/poller/snapshot-diff.js";

describe("diffSnapshotProducts", () => {
  it("detects new products", () => {
    const result = diffSnapshotProducts({
      products: [{ sourceProductCode: "P-001", name: "Dipirona", price: 12.5, stock: 7 }],
      confirmed: {},
      now: "2026-05-25T12:00:00.000Z"
    });

    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]?.sourceProductCode).toBe("P-001");
  });

  it("ignores unchanged products", () => {
    const product = { sourceProductCode: "P-001", name: "Dipirona", price: 12.5, stock: 7 };
    const first = diffSnapshotProducts({
      products: [product],
      confirmed: {},
      now: "2026-05-25T12:00:00.000Z"
    });

    const second = diffSnapshotProducts({
      products: [product],
      confirmed: {
        "P-001": {
          hash: first.changed[0]?.hash ?? "",
          lastSeenAt: "2026-05-25T12:00:00.000Z",
          lastConfirmedAt: "2026-05-25T12:00:01.000Z"
        }
      },
      now: "2026-05-25T12:01:00.000Z"
    });

    expect(second.changed).toEqual([]);
  });

  it("detects changed price", () => {
    const initial = diffSnapshotProducts({
      products: [{ sourceProductCode: "P-001", name: "Dipirona", price: 12.5, stock: 7 }],
      confirmed: {},
      now: "2026-05-25T12:00:00.000Z"
    });

    const changed = diffSnapshotProducts({
      products: [{ sourceProductCode: "P-001", name: "Dipirona", price: 13.9, stock: 7 }],
      confirmed: {
        "P-001": {
          hash: initial.changed[0]?.hash ?? "",
          lastSeenAt: "2026-05-25T12:00:00.000Z",
          lastConfirmedAt: "2026-05-25T12:00:01.000Z"
        }
      },
      now: "2026-05-25T12:01:00.000Z"
    });

    expect(changed.changed).toHaveLength(1);
  });

  it("ignores removed products", () => {
    const result = diffSnapshotProducts({
      products: [],
      confirmed: {
        "P-001": {
          hash: "hash-1",
          lastSeenAt: "2026-05-25T12:00:00.000Z",
          lastConfirmedAt: "2026-05-25T12:00:01.000Z"
        }
      },
      now: "2026-05-25T12:01:00.000Z"
    });

    expect(result.changed).toEqual([]);
  });
});
