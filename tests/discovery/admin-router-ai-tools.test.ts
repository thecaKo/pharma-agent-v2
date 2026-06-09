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
    fsListDir: vi.fn(async () => ({ ok: true, payload: { entries: [{ name: "db.conf", type: "file", size: 3 }] } } as never)),
    fsReadFile: vi.fn(async () => ({ ok: true, payload: { path: "/app/db.conf", content: "host=db", truncated: false } } as never)),
    fsStat: vi.fn(async () => ({ ok: true, payload: { exists: true, type: "file", size: 3 } } as never)),
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

  it("fs.listDir exige path e propaga o payload da primitiva", async () => {
    const semPath = await handleAdminRequest(buildAdminRequestMessage({ requestId: "r1", command: "fs.listDir" }), baseDeps());
    expect(semPath.ok).toBe(false);

    const deps = baseDeps();
    const req = { ...buildAdminRequestMessage({ requestId: "r2", command: "fs.listDir" }), input: { path: "/app" } };
    const res = await handleAdminRequest(req, deps);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.payload).toEqual({ entries: [{ name: "db.conf", type: "file", size: 3 }] });
    expect(deps.fsListDir).toHaveBeenCalledWith({ path: "/app" });
  });

  it("fs.listDir devolve erro da primitiva como falha (DENIED_PATH)", async () => {
    const deps = baseDeps();
    deps.fsListDir = vi.fn(async () => ({ ok: false, errorCode: "DENIED_PATH" } as never));
    const req = { ...buildAdminRequestMessage({ requestId: "r3", command: "fs.listDir" }), input: { path: "/proc" } };
    const res = await handleAdminRequest(req, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.errorCode).toBe("DENIED_PATH");
  });

  it("fs.readFile propaga path/content/truncated e maxBytes", async () => {
    const deps = baseDeps();
    const req = { ...buildAdminRequestMessage({ requestId: "r4", command: "fs.readFile" }), input: { path: "/app/db.conf", maxBytes: 1024 } };
    const res = await handleAdminRequest(req, deps);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.payload).toEqual({ path: "/app/db.conf", content: "host=db", truncated: false });
    expect(deps.fsReadFile).toHaveBeenCalledWith({ path: "/app/db.conf", maxBytes: 1024 });
  });

  it("fs.readFile binário vira falha BINARY_FILE", async () => {
    const deps = baseDeps();
    deps.fsReadFile = vi.fn(async () => ({ ok: false, errorCode: "BINARY_FILE" } as never));
    const req = { ...buildAdminRequestMessage({ requestId: "r5", command: "fs.readFile" }), input: { path: "/bin.dat" } };
    const res = await handleAdminRequest(req, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.errorCode).toBe("BINARY_FILE");
  });

  it("fs.stat propaga payload (exists/type/size)", async () => {
    const deps = baseDeps();
    const req = { ...buildAdminRequestMessage({ requestId: "r6", command: "fs.stat" }), input: { path: "/app/db.conf" } };
    const res = await handleAdminRequest(req, deps);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.payload).toEqual({ exists: true, type: "file", size: 3 });
    expect(deps.fsStat).toHaveBeenCalledWith({ path: "/app/db.conf" });
  });
});
