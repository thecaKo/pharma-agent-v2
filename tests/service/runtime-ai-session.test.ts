import { describe, expect, it, vi } from "vitest";
import { buildRuntimeAdminDeps, buildAiSessionDeps } from "../../src/service/ai-session-wiring.js";
import type { SourceDatabaseAdapter } from "../../src/db/source-adapter.js";

function fakeAdapter(): SourceDatabaseAdapter {
  return {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    queryChanges: vi.fn(async () => []),
    querySnapshotPage: vi.fn(async () => []),
    listTables: vi.fn(async () => [{ name: "produtos" }]),
    listColumns: vi.fn(async () => [{ name: "codigo" }]),
    describeTable: vi.fn(async () => [{ name: "codigo", dataType: "varchar", nullable: false }]),
    listForeignKeys: vi.fn(async () => [{ fromTable: "desconto_produtos", fromColumn: "produto_id", toTable: "produtos", toColumn: "id" }]),
    sampleRows: vi.fn(async () => [{ codigo: "P1" }]),
    runReadOnlySelect: vi.fn(async () => [{ codigo: "P1" }])
  };
}

describe("ai-session-wiring", () => {
  it("buildRuntimeAdminDeps roteia schema.describeTable ao adapter", async () => {
    const adapter = fakeAdapter();
    const deps = buildRuntimeAdminDeps({
      getAdapter: async () => adapter,
      fs: { readFile: vi.fn(async () => "host=db"), listDir: vi.fn(async () => []), stat: vi.fn(async () => undefined), enumerateTop: vi.fn(async () => []) },
      registry: { listKeys: vi.fn(async () => []), readKey: vi.fn(async () => ({ Server: "db" })) },
      probeDeps: {} as never
    });
    const cols = await deps.schemaDescribeTable("produtos");
    expect(cols).toEqual([{ name: "codigo", dataType: "varchar", nullable: false }]);
    const rows = await deps.sqlRunReadOnlySelect({ sql: "SELECT codigo FROM produtos", limit: 10 });
    expect(rows).toEqual([{ codigo: "P1" }]);
    expect(adapter.runReadOnlySelect).toHaveBeenCalledWith({ sql: "SELECT codigo FROM produtos", limit: 10 });
  });

  it("buildAiSessionDeps.applyApproval persiste credenciais e ativa mapping", async () => {
    const writeDatabaseConfig = vi.fn(async () => undefined);
    const activateMapping = vi.fn(async () => undefined);
    const deps = buildAiSessionDeps({
      handleAdminRequest: vi.fn(async () => ({ type: "admin.response", requestId: "r", command: "schema.listTables", ok: true, payload: {}, sentAt: "t" } as never)),
      secrets: () => ["pw"],
      now: () => "t",
      writeDatabaseConfig,
      programData: undefined,
      currentDatabase: () => ({ driver: "mysql", host: "h", port: 3306, name: "db", user: "u", password: "pw" }),
      activateMapping
    });
    await deps.applyApproval({ mappingVersion: "v1", syncMode: "snapshot", pollIntervalMs: 60000, batchSize: 500, snapshotQuery: "SELECT 1", snapshotPageSize: 500, fields: { sourceProductCode: "codigo", name: "nome" } });
    expect(writeDatabaseConfig).toHaveBeenCalledTimes(1);
    expect(activateMapping).toHaveBeenCalledTimes(1);
  });
});
