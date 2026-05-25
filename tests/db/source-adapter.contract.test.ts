import { describe, expect, it, vi } from "vitest";
import type { SourceDatabaseAdapter } from "../../src/db/source-adapter.js";

class ContractAdapter implements SourceDatabaseAdapter {
  public readonly connect = vi.fn(async () => undefined);
  public readonly close = vi.fn(async () => undefined);
  public readonly queryChanges = vi.fn(async () => [{ product_id: "P-001", updated_at: "2026-05-16T20:00:00.000Z" }]);
  public readonly querySnapshotPage = vi.fn(async () => []);
  public readonly listTables = vi.fn(async () => [{ name: "products" }]);
  public readonly listColumns = vi.fn(async () => [{ name: "product_id", dataType: "varchar", nullable: false }]);
}

describe("SourceDatabaseAdapter contract", () => {
  it("exposes connect, queryChanges, listTables, listColumns, and close", async () => {
    const adapter = new ContractAdapter();

    await adapter.connect();
    const tables = await adapter.listTables();
    const columns = await adapter.listColumns("products");
    const rows = await adapter.queryChanges({
      sql: "select * from products where updated_at > ? rows ?",
      cursor: "2026-05-16T19:59:00.000Z",
      limit: 500
    });
    await adapter.close();

    expect(adapter.connect).toHaveBeenCalledOnce();
    expect(adapter.listTables).toHaveBeenCalledOnce();
    expect(tables).toEqual([{ name: "products" }]);
    expect(adapter.listColumns).toHaveBeenCalledWith("products");
    expect(columns).toEqual([{ name: "product_id", dataType: "varchar", nullable: false }]);
    expect(adapter.queryChanges).toHaveBeenCalledWith({
      sql: "select * from products where updated_at > ? rows ?",
      cursor: "2026-05-16T19:59:00.000Z",
      limit: 500
    });
    expect(rows).toEqual([{ product_id: "P-001", updated_at: "2026-05-16T20:00:00.000Z" }]);
    expect(adapter.close).toHaveBeenCalledOnce();
  });
});
