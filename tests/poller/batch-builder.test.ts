import { describe, expect, it } from "vitest";
import { buildProductBatch } from "../../src/poller/batch-builder.js";

describe("buildProductBatch", () => {
  it("includes identity, mapping, cursor metadata, records, batch id, and timestamp", () => {
    const records = [
      {
        sourceProductCode: "P-001",
        name: "Dipirona 500mg",
        barcode: "7891000000001",
        price: 12.5,
        stock: 7,
        active: true,
        sourceUpdatedAt: "2026-05-16T20:00:00.000Z"
      }
    ];

    const batch = buildProductBatch({
      connectorId: "connector-1",
      customerId: "customer-1",
      mappingVersion: "mapping-v1",
      cursorBefore: "2026-05-16T19:59:00.000Z",
      cursorAfter: "2026-05-16T20:00:00.000Z",
      records,
      batchId: "batch-1",
      createdAt: "2026-05-16T20:00:05.000Z"
    });

    expect(batch).toEqual({
      batchId: "batch-1",
      connectorId: "connector-1",
      customerId: "customer-1",
      mappingVersion: "mapping-v1",
      cursorBefore: "2026-05-16T19:59:00.000Z",
      cursorAfter: "2026-05-16T20:00:00.000Z",
      records,
      createdAt: "2026-05-16T20:00:05.000Z"
    });
  });

  it("creates a unique batch id and timestamp when not supplied", () => {
    const first = buildProductBatch({
      connectorId: "connector-1",
      customerId: "customer-1",
      mappingVersion: "mapping-v1",
      cursorBefore: null,
      cursorAfter: 1,
      records: []
    });
    const second = buildProductBatch({
      connectorId: "connector-1",
      customerId: "customer-1",
      mappingVersion: "mapping-v1",
      cursorBefore: 1,
      cursorAfter: 2,
      records: []
    });

    expect(first.batchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.batchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.batchId).not.toBe(second.batchId);
    expect(Date.parse(first.createdAt)).not.toBeNaN();
  });

  it("copies records so callers cannot mutate the batch array by reference", () => {
    const records = [{ sourceProductCode: "P-001", name: "Product", price: 1, stock: 2 }];

    const batch = buildProductBatch({
      connectorId: "connector-1",
      customerId: "customer-1",
      mappingVersion: "mapping-v1",
      cursorBefore: null,
      cursorAfter: null,
      records
    });
    records.push({ sourceProductCode: "P-002", name: "Other", price: 3, stock: 4 });

    expect(batch.records).toHaveLength(1);
  });
});
