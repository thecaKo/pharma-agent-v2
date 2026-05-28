import { describe, expect, it, vi } from "vitest";
import { probeProcesses } from "../../src/discovery/processes.js";
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

describe("probeProcesses", () => {
  it("returns processes provided by listProcesses", async () => {
    const ctx = makeContext({
      listProcesses: vi.fn(async () => [
        { pid: 4128, name: "Big.exe", path: "C:\\Linx\\bin\\Big.exe" }
      ])
    });
    await expect(probeProcesses(ctx)).resolves.toEqual([
      { pid: 4128, name: "Big.exe", path: "C:\\Linx\\bin\\Big.exe" }
    ]);
  });

  it("swallows errors and returns empty list", async () => {
    const ctx = makeContext({
      listProcesses: vi.fn(async () => {
        throw new Error("wmic not available");
      })
    });
    await expect(probeProcesses(ctx)).resolves.toEqual([]);
  });

  it("returns empty when listProcesses returns no results", async () => {
    const ctx = makeContext();
    await expect(probeProcesses(ctx)).resolves.toEqual([]);
  });
});
