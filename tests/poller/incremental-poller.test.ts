import { describe, expect, it, vi } from "vitest";
import type { SourceDatabaseAdapter } from "../../src/db/source-adapter.js";
import { IncrementalPoller } from "../../src/poller/incremental-poller.js";
import { validateMappingConfig } from "../../src/mapping/validate.js";
import type { ConnectorState } from "../../src/state/state-types.js";
import { validMapping } from "../helpers/mapping.js";

function adapterWithRows(rows: Record<string, unknown>[] = []): SourceDatabaseAdapter {
  return {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    queryChanges: vi.fn(async () => rows),
    querySnapshotPage: vi.fn(async () => []),
    listTables: vi.fn(async () => [{ name: "products" }]),
    listColumns: vi.fn(async () => [])
  };
}

function stateReader(state: ConnectorState) {
  return {
    load: vi.fn(async () => state)
  };
}

describe("IncrementalPoller", () => {
  it("does not query when mapping validation fails", async () => {
    const adapter = adapterWithRows();
    const result = await new IncrementalPoller({
      adapter,
      mapping: validMapping({ fields: { name: "description", price: "sale_price", stock: "quantity" } }),
      state: stateReader({ lastAckedCursor: "2026-05-16T19:00:00.000Z" }),
      connectorId: "connector-1",
      customerId: "customer-1",
      isTransportReady: () => true
    }).pollOnce();

    expect(result.status).toBe("invalid_mapping");
    expect(adapter.queryChanges).not.toHaveBeenCalled();
  });

  it("queries with last acknowledged cursor from state", async () => {
    const adapter = adapterWithRows([]);
    const state = stateReader({ lastAckedCursor: "2026-05-16T19:00:00.000Z" });

    await new IncrementalPoller({
      adapter,
      mapping: validateMappingConfig(validMapping()),
      state,
      connectorId: "connector-1",
      customerId: "customer-1",
      isTransportReady: () => true
    }).pollOnce();

    expect(state.load).toHaveBeenCalledOnce();
    expect(adapter.queryChanges).toHaveBeenCalledWith({
      sql: "select * from products where updated_at > ? order by updated_at",
      cursor: "2026-05-16T19:00:00.000Z",
      limit: 500
    });
  });

  it("uses epoch timestamp cursor when no acknowledged timestamp cursor exists", async () => {
    const adapter = adapterWithRows([]);

    const result = await new IncrementalPoller({
      adapter,
      mapping: validateMappingConfig(validMapping()),
      state: stateReader({}),
      connectorId: "connector-1",
      customerId: "customer-1",
      isTransportReady: () => true
    }).pollOnce();

    expect(adapter.queryChanges).toHaveBeenCalledWith({
      sql: "select * from products where updated_at > ? order by updated_at",
      cursor: "1970-01-01T00:00:00.000Z",
      limit: 500
    });
    expect(result.cursorBefore).toBe("1970-01-01T00:00:00.000Z");
    expect(result.cursorAfter).toBe("1970-01-01T00:00:00.000Z");
  });

  it("uses zero cursor when no acknowledged number cursor exists", async () => {
    const adapter = adapterWithRows([]);

    const result = await new IncrementalPoller({
      adapter,
      mapping: validateMappingConfig(validMapping({ cursorType: "number", cursorField: "seq" })),
      state: stateReader({ lastAckedCursor: null }),
      connectorId: "connector-1",
      customerId: "customer-1",
      isTransportReady: () => true
    }).pollOnce();

    expect(adapter.queryChanges).toHaveBeenCalledWith({
      sql: "select * from products where updated_at > ? order by updated_at",
      cursor: 0,
      limit: 500
    });
    expect(result.cursorBefore).toBe(0);
    expect(result.cursorAfter).toBe(0);
  });

  it("skips rows missing sourceProductCode and batches valid rows from the same result set", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await new IncrementalPoller({
      adapter: adapterWithRows([
        {
          product_id: "",
          description: "Invalid",
          sale_price: "1.00",
          quantity: "1",
          updated_at: "2026-05-16T20:00:00.000Z"
        },
        {
          product_id: "P-001",
          description: "Dipirona 500mg",
          ean: "7891000000001",
          sale_price: "12.50",
          quantity: "7",
          is_active: "1",
          updated_at: "2026-05-16T20:00:01.000Z"
        }
      ]),
      mapping: validateMappingConfig(validMapping()),
      state: stateReader({ lastAckedCursor: "2026-05-16T19:59:00.000Z" }),
      connectorId: "connector-1",
      customerId: "customer-1",
      isTransportReady: () => true,
      logger,
      now: () => "2026-05-16T20:00:02.000Z"
    }).pollOnce();

    expect(result.status).toBe("batch");
    expect(result.rejectedRowCount).toBe(1);
    expect(result.batch?.cursorBefore).toBe("2026-05-16T19:59:00.000Z");
    expect(result.batch?.cursorAfter).toBe("2026-05-16T20:00:01.000Z");
    expect(result.batch?.records).toEqual([
      {
        sourceProductCode: "P-001",
        name: "Dipirona 500mg",
        barcode: "7891000000001",
        price: 12.5,
        stock: 7,
        active: true,
        sourceUpdatedAt: "2026-05-16T20:00:01.000Z"
      }
    ]);
    expect(logger.warn).toHaveBeenCalledWith("invalid_record.skipped", {
      connectorId: "connector-1",
      customerId: "customer-1",
      mappingVersion: "mapping-v1",
      reason: "missing_source_product_code",
      rowIndex: 0
    });
  });

  it("returns no batch when there are zero source rows", async () => {
    const result = await new IncrementalPoller({
      adapter: adapterWithRows([]),
      mapping: validateMappingConfig(validMapping()),
      state: stateReader({ lastAckedCursor: "2026-05-16T19:59:00.000Z" }),
      connectorId: "connector-1",
      customerId: "customer-1",
      isTransportReady: () => true
    }).pollOnce();

    expect(result).toMatchObject({
      status: "empty",
      cursorBefore: "2026-05-16T19:59:00.000Z",
      cursorAfter: "2026-05-16T19:59:00.000Z",
      rowCount: 0,
      rejectedRowCount: 0
    });
    expect(result.batch).toBeUndefined();
  });

  it("does not query or request cursor advancement when transport is unavailable", async () => {
    const adapter = adapterWithRows([{ product_id: "P-001" }]);
    const state = stateReader({ lastAckedCursor: 10 });

    const result = await new IncrementalPoller({
      adapter,
      mapping: validateMappingConfig(validMapping({ cursorType: "number", cursorField: "seq" })),
      state,
      connectorId: "connector-1",
      customerId: "customer-1",
      isTransportReady: () => false
    }).pollOnce();

    expect(result.status).toBe("transport_unavailable");
    expect(adapter.queryChanges).not.toHaveBeenCalled();
    expect(state.load).not.toHaveBeenCalled();
    expect(result.batch).toBeUndefined();
  });

  it("does not query while a previous batch is still unacknowledged", async () => {
    const adapter = adapterWithRows([{ product_id: "P-001" }]);

    const result = await new IncrementalPoller({
      adapter,
      mapping: validateMappingConfig(validMapping()),
      state: stateReader({ lastAckedCursor: null }),
      connectorId: "connector-1",
      customerId: "customer-1",
      isTransportReady: () => true,
      hasUnacknowledgedBatch: () => true
    }).pollOnce();

    expect(result.status).toBe("awaiting_ack");
    expect(adapter.queryChanges).not.toHaveBeenCalled();
  });
});
