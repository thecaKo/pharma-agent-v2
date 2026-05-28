import { describe, expect, it, vi } from "vitest";
import { probeEngines } from "../../src/discovery/engines.js";
import type { ProbeContext } from "../../src/discovery/types.js";
import type { FileSystemReader } from "../../src/discovery/fs-reader.js";

function makeContext(overrides: Partial<ProbeContext> = {}): ProbeContext {
  const defaultFs: FileSystemReader = {
    readFile: vi.fn(async () => ""),
    listDir: vi.fn(async () => []),
    stat: vi.fn(async () => undefined)
  };
  return {
    registry: { readKey: vi.fn(async () => ({})) } as never,
    fs: defaultFs,
    serviceList: vi.fn(async () => []),
    signal: new AbortController().signal,
    ...overrides
  };
}

describe("probeEngines", () => {
  it("detects SQL Server via service + port + dll evidence with high confidence", async () => {
    const ctx = makeContext({
      serviceList: vi.fn(async () => [{ name: "MSSQLSERVER", state: "running" }]),
      fs: {
        readFile: vi.fn(async () => ""),
        listDir: vi.fn(async () => []),
        stat: vi.fn(async (path: string) => {
          if (path.toLowerCase().includes("msodbcsql")) return { isFile: true, isDirectory: false };
          return undefined;
        })
      }
    });

    const engines = await probeEngines(ctx, { tcpProbe: async (host, port) => port === 1433 });
    const sqlserver = engines.find((e) => e.kind === "sqlserver");
    expect(sqlserver).toBeDefined();
    expect(sqlserver?.confidence).toBe("high");
    expect(sqlserver?.evidence).toEqual(
      expect.arrayContaining([
        expect.stringContaining("service:MSSQLSERVER"),
        "port:1433",
        expect.stringContaining("dll:")
      ])
    );
  });

  it("detects Postgres via service alone with low confidence", async () => {
    const ctx = makeContext({
      serviceList: vi.fn(async () => [{ name: "postgresql-x64-14", state: "running" }])
    });

    const engines = await probeEngines(ctx, { tcpProbe: async () => false });
    const postgres = engines.find((e) => e.kind === "postgresql");
    expect(postgres).toBeDefined();
    expect(postgres?.confidence).toBe("low");
    expect(postgres?.evidence).toEqual(["service:postgresql-x64-14"]);
  });

  it("detects Firebird via dll alone", async () => {
    const ctx = makeContext({
      fs: {
        readFile: vi.fn(async () => ""),
        listDir: vi.fn(async () => []),
        stat: vi.fn(async (path: string) =>
          path.toLowerCase().endsWith("gds32.dll") ? { isFile: true, isDirectory: false } : undefined
        )
      }
    });
    const engines = await probeEngines(ctx, { tcpProbe: async () => false });
    expect(engines).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "firebird" })]));
  });

  it("returns empty list when no evidence found", async () => {
    const ctx = makeContext();
    const engines = await probeEngines(ctx, { tcpProbe: async () => false });
    expect(engines).toEqual([]);
  });

  it("does not throw if serviceList rejects", async () => {
    const ctx = makeContext({
      serviceList: vi.fn(async () => {
        throw new Error("sc.exe not available");
      })
    });
    await expect(probeEngines(ctx, { tcpProbe: async () => false })).resolves.toEqual([]);
  });
});
