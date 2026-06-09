import { describe, expect, it, vi } from "vitest";
import { discoverConnectionCandidates } from "../../src/discovery/connection-candidates.js";

describe("discoverConnectionCandidates", () => {
  it("monta candidatos a partir de arquivos de config (scan→read→parse)", async () => {
    const deps = {
      scanConfigDirs: vi.fn(async () => ({
        files: [{ path: "/etc/app/db.conf", size: 10, mtime: "" }],
        truncated: false,
        rootsRejected: [],
        errors: []
      })),
      readConfigFile: vi.fn(async () => ({
        ok: true as const,
        path: "/etc/app/db.conf",
        content: "driver=mysql\nhost=dbhost\nport=3307\nuser=svc\npassword=pwd\ndatabase=cat"
      })),
      probeOdbcDsns: vi.fn(async () => [])
    };

    const result = await discoverConnectionCandidates(deps);

    expect(result).toHaveLength(1);
    const [c] = result;
    expect(c.handle).toBe("conn-0");
    // Descritor redigido: SEM senha.
    expect(c.descriptor).toEqual({
      handle: "conn-0",
      driver: "mysql",
      host: "dbhost",
      port: 3307,
      user: "svc",
      database: "cat",
      source: "config:/etc/app/db.conf",
      label: expect.stringContaining("mysql")
    });
    expect(JSON.stringify(c.descriptor)).not.toContain("pwd");
    // Config completa preservada localmente (com senha).
    expect(c.config).toMatchObject({ driver: "mysql", host: "dbhost", port: 3307, user: "svc", password: "pwd", name: "cat" });
  });

  it("inclui DSNs ODBC como candidatos (handle sequencial, sem senha no descritor)", async () => {
    const deps = {
      scanConfigDirs: vi.fn(async () => ({ files: [], truncated: false, rootsRejected: [], errors: [] })),
      readConfigFile: vi.fn(),
      probeOdbcDsns: vi.fn(async () => [
        { name: "LINX_PG", driver: "PSQLODBC", host: "10.0.0.5", port: 5432, database: "linx", user: "ro" }
      ])
    };

    const result = await discoverConnectionCandidates(deps);

    expect(result).toHaveLength(1);
    expect(result[0].descriptor).toMatchObject({
      handle: "conn-0",
      driver: "postgresql",
      host: "10.0.0.5",
      port: 5432,
      user: "ro",
      database: "linx",
      source: "odbc:LINX_PG"
    });
  });

  it("retorna [] quando nada utilizável é descoberto", async () => {
    const deps = {
      scanConfigDirs: vi.fn(async () => ({ files: [], truncated: false, rootsRejected: [], errors: [] })),
      readConfigFile: vi.fn(),
      probeOdbcDsns: vi.fn(async () => [])
    };
    expect(await discoverConnectionCandidates(deps)).toEqual([]);
  });

  it("ignora DSNs ODBC sem driver mapeável ou sem host", async () => {
    const deps = {
      scanConfigDirs: vi.fn(async () => ({ files: [], truncated: false, rootsRejected: [], errors: [] })),
      readConfigFile: vi.fn(),
      probeOdbcDsns: vi.fn(async () => [
        { name: "ORACLE", driver: "Oracle ODBC Driver", host: "orcl" }, // driver não suportado
        { name: "NOHOST", driver: "PSQLODBC", user: "x" } // sem host
      ])
    };
    expect(await discoverConnectionCandidates(deps)).toEqual([]);
  });

  it("usa roots default por OS quando nenhum root é passado", async () => {
    const scanConfigDirs = vi.fn(async () => ({ files: [], truncated: false, rootsRejected: [], errors: [] }));
    await discoverConnectionCandidates({
      scanConfigDirs,
      readConfigFile: vi.fn(),
      probeOdbcDsns: vi.fn(async () => [])
    });
    expect(scanConfigDirs).toHaveBeenCalledTimes(1);
    const arg = scanConfigDirs.mock.calls[0][0];
    expect(Array.isArray(arg.roots)).toBe(true);
    expect(arg.roots.length).toBeGreaterThan(0);
  });

  it("monta candidato Firebird a partir de arquivo .fdb encontrado (SYSDBA, sem senha no descritor)", async () => {
    const deps = {
      scanConfigDirs: vi.fn(async () => ({ files: [], truncated: false, rootsRejected: [], errors: [] })),
      readConfigFile: vi.fn(),
      probeOdbcDsns: vi.fn(async () => []),
      scanFirebirdFiles: vi.fn(async () => ({
        files: [{ path: "/opt/erp/DADOS.FDB", size: 1024, mtime: "" }],
        truncated: false,
        rootsRejected: [],
        errors: []
      }))
    };

    const result = await discoverConnectionCandidates(deps);

    expect(result).toHaveLength(1);
    const [c] = result;
    expect(c.handle).toBe("conn-0");
    // Config local completa: name = caminho do arquivo, SYSDBA/masterkey.
    expect(c.config).toEqual({
      driver: "firebird",
      host: "localhost",
      port: 3050,
      name: "/opt/erp/DADOS.FDB",
      user: "SYSDBA",
      password: "masterkey"
    });
    // Descritor redigido: caminho aparece, senha NÃO.
    expect(c.descriptor).toEqual({
      handle: "conn-0",
      driver: "firebird",
      host: "localhost",
      port: 3050,
      user: "SYSDBA",
      database: "/opt/erp/DADOS.FDB",
      source: "firebird-file:/opt/erp/DADOS.FDB",
      label: "firebird @ /opt/erp/DADOS.FDB (SYSDBA)"
    });
    expect(JSON.stringify(c.descriptor)).not.toContain("masterkey");
  });

  it("monta candidato Firebird para arquivos .gdb também", async () => {
    const deps = {
      scanConfigDirs: vi.fn(async () => ({ files: [], truncated: false, rootsRejected: [], errors: [] })),
      readConfigFile: vi.fn(),
      probeOdbcDsns: vi.fn(async () => []),
      scanFirebirdFiles: vi.fn(async () => ({
        files: [{ path: "C:\\ERP\\base.GDB", size: 2048, mtime: "" }],
        truncated: false,
        rootsRejected: [],
        errors: []
      }))
    };

    const result = await discoverConnectionCandidates(deps);

    expect(result).toHaveLength(1);
    expect(result[0].config.name).toBe("C:\\ERP\\base.GDB");
    expect(result[0].descriptor.source).toBe("firebird-file:C:\\ERP\\base.GDB");
  });

  it("coexiste com candidatos de config e ODBC, com handles sequenciais", async () => {
    const deps = {
      scanConfigDirs: vi.fn(async () => ({
        files: [{ path: "/etc/app/db.conf", size: 10, mtime: "" }],
        truncated: false,
        rootsRejected: [],
        errors: []
      })),
      readConfigFile: vi.fn(async () => ({
        ok: true as const,
        path: "/etc/app/db.conf",
        content: "driver=mysql\nhost=dbhost\nport=3307\nuser=svc\npassword=pwd\ndatabase=cat"
      })),
      probeOdbcDsns: vi.fn(async () => [
        { name: "LINX_PG", driver: "PSQLODBC", host: "10.0.0.5", port: 5432, database: "linx", user: "ro" }
      ]),
      scanFirebirdFiles: vi.fn(async () => ({
        files: [{ path: "/opt/erp/DADOS.FDB", size: 1024, mtime: "" }],
        truncated: false,
        rootsRejected: [],
        errors: []
      }))
    };

    const result = await discoverConnectionCandidates(deps);

    expect(result.map((c) => c.handle)).toEqual(["conn-0", "conn-1", "conn-2"]);
    expect(result.map((c) => c.descriptor.driver)).toEqual(["mysql", "postgresql", "firebird"]);
    expect(result[2].descriptor.source).toBe("firebird-file:/opt/erp/DADOS.FDB");
  });

  it("usa roots/patterns default de Firebird ao varrer .fdb/.gdb", async () => {
    const scanFirebirdFiles = vi.fn(async () => ({ files: [], truncated: false, rootsRejected: [], errors: [] }));
    await discoverConnectionCandidates({
      scanConfigDirs: vi.fn(async () => ({ files: [], truncated: false, rootsRejected: [], errors: [] })),
      readConfigFile: vi.fn(),
      probeOdbcDsns: vi.fn(async () => []),
      scanFirebirdFiles
    });
    expect(scanFirebirdFiles).toHaveBeenCalledTimes(1);
    const arg = scanFirebirdFiles.mock.calls[0][0];
    expect(Array.isArray(arg.roots)).toBe(true);
    expect(arg.roots.length).toBeGreaterThan(0);
    expect(arg.patterns).toContain("*.fdb");
    expect(arg.patterns).toContain("*.gdb");
  });

  it("funciona sem scanFirebirdFiles (dep opcional)", async () => {
    const result = await discoverConnectionCandidates({
      scanConfigDirs: vi.fn(async () => ({ files: [], truncated: false, rootsRejected: [], errors: [] })),
      readConfigFile: vi.fn(),
      probeOdbcDsns: vi.fn(async () => [])
    });
    expect(result).toEqual([]);
  });
});
