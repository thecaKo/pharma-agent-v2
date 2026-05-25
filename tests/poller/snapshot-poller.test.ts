import { describe, expect, it, vi } from "vitest";
import type { SourceDatabaseAdapter } from "../../src/db/source-adapter.js";
import { validateMappingConfig } from "../../src/mapping/validate.js";
import { SnapshotPoller } from "../../src/poller/snapshot-poller.js";
import type { ConnectorState } from "../../src/state/state-types.js";
import { validSnapshotMapping } from "../helpers/mapping.js";

function adapterWithPages(pages: Record<string, unknown>[][]): SourceDatabaseAdapter {
  return {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    queryChanges: vi.fn(async () => []),
    querySnapshotPage: vi.fn(async () => pages.shift() ?? []),
    listTables: vi.fn(async () => [{ name: "products" }]),
    listColumns: vi.fn(async () => [])
  };
}

function stateReader(state: ConnectorState) {
  return { load: vi.fn(async () => state) };
}

describe("SnapshotPoller", () => {
  it("scans pages and batches new products", async () => {
    const adapter = adapterWithPages([
      [
        { product_id: "P-001", description: "Dipirona", sale_price: "12.50", quantity: "7" }
      ],
      []
    ]);

    const result = await new SnapshotPoller({
      adapter,
      mapping: validateMappingConfig(validSnapshotMapping({ snapshotPageSize: 1, batchSize: 500 })),
      state: stateReader({}),
      connectorId: "connector-1",
      customerId: "customer-1",
      isTransportReady: () => true,
      now: () => "2026-05-25T12:00:00.000Z"
    }).pollOnce();

    expect(result.status).toBe("batch");
    expect(result.batch?.records).toEqual([
      {
        sourceProductCode: "P-001",
        name: "Dipirona",
        barcode: null,
        price: 12.5,
        stock: 7
      }
    ]);
    expect(adapter.querySnapshotPage).toHaveBeenCalledTimes(2);
  });

  it("detects price changes without cursor movement", async () => {
    const first = await new SnapshotPoller({
      adapter: adapterWithPages([[{ product_id: "P-001", description: "Dipirona", sale_price: "12.50", quantity: "7" }], []]),
      mapping: validateMappingConfig(validSnapshotMapping()),
      state: stateReader({}),
      connectorId: "connector-1",
      customerId: "customer-1",
      isTransportReady: () => true,
      now: () => "2026-05-25T12:00:00.000Z"
    }).pollOnce();

    const pending = first.snapshotPending ?? [];
    const confirmedProducts = Object.fromEntries(
      pending.map((entry) => [
        entry.sourceProductCode,
        {
          hash: entry.hash,
          lastSeenAt: "2026-05-25T12:00:00.000Z",
          lastConfirmedAt: "2026-05-25T12:00:01.000Z"
        }
      ])
    );

    const changed = await new SnapshotPoller({
      adapter: adapterWithPages([[{ product_id: "P-001", description: "Dipirona", sale_price: "13.90", quantity: "7" }], []]),
      mapping: validateMappingConfig(validSnapshotMapping()),
      state: stateReader({ snapshotState: { fieldsSignature: first.fieldsSignature ?? "", products: confirmedProducts, pending: [] } }),
      connectorId: "connector-1",
      customerId: "customer-1",
      isTransportReady: () => true,
      now: () => "2026-05-25T12:01:00.000Z"
    }).pollOnce();

    expect(changed.status).toBe("batch");
    expect(changed.batch?.records[0]?.price).toBe(13.9);
  });
});
