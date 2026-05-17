import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMapping } from "../../src/mapping/apply.js";
import { validateMappingConfig } from "../../src/mapping/validate.js";
import { buildProductBatch } from "../../src/poller/batch-builder.js";
import { StateStore } from "../../src/state/state-store.js";
import { validMapping } from "../helpers/mapping.js";

const tempDirs: string[] = [];

describe("state reload and mapped batch integration", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("loads state saved by a previous connector process using the same ProgramData directory", async () => {
    const stateFilePath = await programDataStatePath();

    await new StateStore({ stateFilePath }).save({
      connectorId: "connector-1",
      customerId: "customer-1",
      mappingVersion: "mapping-v1",
      cursorField: "updated_at",
      cursorType: "timestamp",
      sourceProductCodeField: "product_id",
      lastAckedCursor: "2026-05-16T20:00:00.000Z",
      lastSuccessfulSendAt: "2026-05-16T20:00:10.000Z",
      lastBatchId: "batch-1"
    });

    await expect(new StateStore({ stateFilePath }).load()).resolves.toEqual({
      connectorId: "connector-1",
      customerId: "customer-1",
      mappingVersion: "mapping-v1",
      cursorField: "updated_at",
      cursorType: "timestamp",
      sourceProductCodeField: "product_id",
      lastAckedCursor: "2026-05-16T20:00:00.000Z",
      lastSuccessfulSendAt: "2026-05-16T20:00:10.000Z",
      lastBatchId: "batch-1"
    });
  });

  it("builds one batch from fixture rows with invalid rows excluded and cursor metadata preserved", () => {
    const mapping = validateMappingConfig(validMapping());
    const mapped = applyMapping(
      [
        {
          product_id: "P-001",
          description: "Dipirona 500mg",
          ean: "7891000000001",
          sale_price: "12.50",
          quantity: "7",
          is_active: "1",
          updated_at: "2026-05-16T20:00:00.000Z"
        },
        {
          product_id: null,
          description: "Rejected product",
          sale_price: "15.00",
          quantity: "9",
          updated_at: "2026-05-16T20:00:01.000Z"
        },
        {
          product_id: "P-002",
          description: "Paracetamol 750mg",
          ean: "7891000000002",
          sale_price: "8.25",
          quantity: "3",
          is_active: "true",
          updated_at: "2026-05-16T20:00:02.000Z"
        }
      ],
      mapping
    );

    const batch = buildProductBatch({
      connectorId: "connector-1",
      customerId: "customer-1",
      mappingVersion: mapping.mappingVersion,
      cursorBefore: "2026-05-16T19:59:00.000Z",
      cursorAfter: mapped.cursorAfter,
      records: mapped.records,
      batchId: "batch-fixture",
      createdAt: "2026-05-16T20:00:05.000Z"
    });

    expect(mapped.rejected).toEqual([{ index: 1, reason: "missing_source_product_code" }]);
    expect(batch).toMatchObject({
      batchId: "batch-fixture",
      connectorId: "connector-1",
      customerId: "customer-1",
      mappingVersion: "mapping-v1",
      cursorBefore: "2026-05-16T19:59:00.000Z",
      cursorAfter: "2026-05-16T20:00:02.000Z",
      createdAt: "2026-05-16T20:00:05.000Z"
    });
    expect(batch.records.map((record) => record.sourceProductCode)).toEqual(["P-001", "P-002"]);
  });
});

async function programDataStatePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "connector-programdata-"));
  tempDirs.push(dir);
  return join(dir, "ProgramData", "PharmaAgentConnector", "connector-state.json");
}
