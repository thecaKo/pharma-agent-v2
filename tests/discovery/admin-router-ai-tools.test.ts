import { describe, expect, it, vi } from "vitest";
import { handleAdminRequest, type AdminRouterDependencies } from "../../src/discovery/admin-router.js";
import { buildAdminRequestMessage } from "../../src/transport/protocol.js";

function baseDeps(): AdminRouterDependencies {
  return {
    probeEngines: vi.fn(async () => []),
    probeOdbcDsns: vi.fn(async () => []),
    probeNetwork: vi.fn(async () => ({ reachable: false } as never)),
    probeTestConnection: vi.fn(async () => ({ ok: false, code: "unknown", message: "x" } as never)),
    probeProcesses: vi.fn(async () => []),
    probeConnections: vi.fn(async () => []),
    probeScanConfigDirs: vi.fn(async () => ({ files: [], truncated: false, rootsRejected: [], errors: [] })),
    schemaListTables: vi.fn(async () => []),
    schemaDescribeTable: vi.fn(async () => [{ name: "id", dataType: "int", nullable: false }]),
    schemaListForeignKeys: vi.fn(async () => [{ fromTable: "a", fromColumn: "b", toTable: "c", toColumn: "d" }]),
    schemaSampleRows: vi.fn(async () => [{ id: 1 }]),
    sqlRunReadOnlySelect: vi.fn(async () => [{ codigo: "P1" }]),
    fsReadConfigFile: vi.fn(async () => ({ ok: true, path: "C:\\x.ini", content: "host=db" } as never)),
    registryReadKey: vi.fn(async () => ({ ok: true, path: "HKLM\\x", values: { Server: "db" } } as never))
  };
}

describe("handleAdminRequest — ferramentas de IA", () => {
  it("schema.describeTable exige input.table", async () => {
    const res = await handleAdminRequest(buildAdminRequestMessage({ requestId: "r1", command: "schema.describeTable" }), baseDeps());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.errorCode).toBe("INVALID_INPUT");
  });

  it("schema.describeTable retorna colunas", async () => {
    const req = { ...buildAdminRequestMessage({ requestId: "r1", command: "schema.describeTable" }), input: { table: "produtos" } };
    const res = await handleAdminRequest(req, baseDeps());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.payload).toEqual({ columns: [{ name: "id", dataType: "int", nullable: false }] });
  });

  it("sql.runReadOnlySelect exige sql não vazio", async () => {
    const res = await handleAdminRequest(buildAdminRequestMessage({ requestId: "r1", command: "sql.runReadOnlySelect" }), baseDeps());
    expect(res.ok).toBe(false);
  });

  it("sql.runReadOnlySelect retorna linhas", async () => {
    const deps = baseDeps();
    const req = { ...buildAdminRequestMessage({ requestId: "r1", command: "sql.runReadOnlySelect" }), input: { sql: "SELECT codigo FROM produtos", limit: 10 } };
    const res = await handleAdminRequest(req, deps);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.payload).toEqual({ rows: [{ codigo: "P1" }] });
    expect(deps.sqlRunReadOnlySelect).toHaveBeenCalledWith({ sql: "SELECT codigo FROM produtos", limit: 10 });
  });

  it("fs.readConfigFile propaga payload da ferramenta", async () => {
    const req = { ...buildAdminRequestMessage({ requestId: "r1", command: "fs.readConfigFile" }), input: { path: "C:\\x.ini" } };
    const res = await handleAdminRequest(req, baseDeps());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.payload).toMatchObject({ ok: true, content: "host=db" });
  });

  it("registry.readKey propaga payload", async () => {
    const req = { ...buildAdminRequestMessage({ requestId: "r1", command: "registry.readKey" }), input: { path: "HKLM\\x" } };
    const res = await handleAdminRequest(req, baseDeps());
    expect(res.ok).toBe(true);
  });
});
