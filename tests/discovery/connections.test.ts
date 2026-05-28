import { describe, expect, it, vi } from "vitest";
import { probeConnections, DB_PORTS } from "../../src/discovery/connections.js";
import type { ProbeContext } from "../../src/discovery/types.js";

function makeContext(overrides: Partial<ProbeContext> = {}): ProbeContext {
  return {
    registry: { readKey: vi.fn(async () => ({})) } as never,
    fs: {
      readFile: vi.fn(async () => ""),
      listDir: vi.fn(async () => []),
      stat: vi.fn(async () => undefined),
      enumerateTop: vi.fn(async () => [])
    },
    serviceList: vi.fn(async () => []),
    listProcesses: vi.fn(async () => []),
    listConnections: vi.fn(async () => []),
    signal: new AbortController().signal,
    ...overrides
  };
}

describe("DB_PORTS", () => {
  it("includes the expected database ports", () => {
    expect(DB_PORTS.has(1433)).toBe(true);
    expect(DB_PORTS.has(5432)).toBe(true);
    expect(DB_PORTS.has(3306)).toBe(true);
    expect(DB_PORTS.has(3050)).toBe(true);
    expect(DB_PORTS.has(1521)).toBe(true);
    expect(DB_PORTS.has(27017)).toBe(true);
    expect(DB_PORTS.has(50000)).toBe(true);
    expect(DB_PORTS.has(1583)).toBe(true);
    expect(DB_PORTS.has(80)).toBe(false);
  });
});

describe("probeConnections", () => {
  it("filters connections to DB_PORTS (remote)", async () => {
    const ctx = makeContext({
      listConnections: vi.fn(async () => [
        { pid: 4128, localAddr: "127.0.0.1", localPort: 49802, remoteAddr: "127.0.0.1", remotePort: 1433, state: "ESTABLISHED" },
        { pid: 999, localAddr: "127.0.0.1", localPort: 6000, remoteAddr: "127.0.0.1", remotePort: 80, state: "ESTABLISHED" }
      ])
    });
    const result = await probeConnections(ctx);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ pid: 4128, remotePort: 1433 });
  });

  it("filters connections to DB_PORTS (local — case server listening)", async () => {
    const ctx = makeContext({
      listConnections: vi.fn(async () => [
        { pid: 100, localAddr: "0.0.0.0", localPort: 5432, remoteAddr: "10.0.0.1", remotePort: 51000, state: "ESTABLISHED" }
      ])
    });
    const result = await probeConnections(ctx);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ pid: 100, localPort: 5432 });
  });

  it("cross-references PID to processName when listProcesses succeeds", async () => {
    const ctx = makeContext({
      listConnections: vi.fn(async () => [
        { pid: 4128, localAddr: "127.0.0.1", localPort: 49802, remoteAddr: "127.0.0.1", remotePort: 1433, state: "ESTABLISHED" }
      ]),
      listProcesses: vi.fn(async () => [
        { pid: 4128, name: "Big.exe", path: "C:\\Linx\\bin\\Big.exe" }
      ])
    });
    const result = await probeConnections(ctx);
    expect(result[0]?.processName).toBe("Big.exe");
  });

  it("returns connections without processName when listProcesses throws", async () => {
    const ctx = makeContext({
      listConnections: vi.fn(async () => [
        { pid: 4128, localAddr: "127.0.0.1", localPort: 49802, remoteAddr: "127.0.0.1", remotePort: 1433, state: "ESTABLISHED" }
      ]),
      listProcesses: vi.fn(async () => {
        throw new Error("wmic failed");
      })
    });
    const result = await probeConnections(ctx);
    expect(result[0]?.pid).toBe(4128);
    expect(result[0]?.processName).toBeUndefined();
  });

  it("returns empty list when listConnections throws", async () => {
    const ctx = makeContext({
      listConnections: vi.fn(async () => {
        throw new Error("netstat failed");
      })
    });
    await expect(probeConnections(ctx)).resolves.toEqual([]);
  });
});
