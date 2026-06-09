import { describe, expect, it, vi } from "vitest";
import { buildAiSessionDeps } from "../../src/service/ai-session-wiring.js";
import type { DiscoveredConnection } from "../../src/discovery/connection-candidates.js";
import type { DatabaseConfig } from "../../src/config/types.js";

const baseInput = {
  handleAdminRequest: vi.fn(async () => ({ type: "admin.response", requestId: "r", command: "schema.listTables", ok: true, payload: {}, sentAt: "t" } as never)),
  secrets: () => ["pw"],
  now: () => "t",
  writeDatabaseConfig: vi.fn(async () => undefined),
  programData: undefined,
  currentDatabase: () => undefined,
  activateMapping: vi.fn(async () => undefined),
  currentEngine: () => "mysql"
};

describe("buildAiSessionDeps — connection tools wiring", () => {
  it("repassa discoverConnections quando fornecido", async () => {
    const discovered: DiscoveredConnection[] = [
      { handle: "conn-0", config: {} as DatabaseConfig, descriptor: { handle: "conn-0", driver: "mysql", source: "odbc:X", label: "x" } }
    ];
    const discoverConnections = vi.fn(async () => discovered);
    const deps = buildAiSessionDeps({ ...baseInput, discoverConnections });
    expect(deps.discoverConnections).toBeDefined();
    expect(await deps.discoverConnections!()).toBe(discovered);
  });

  it("repassa useConnection quando fornecido", async () => {
    const useConnection = vi.fn(async () => ({ ok: true, tablesCount: 3 }));
    const deps = buildAiSessionDeps({ ...baseInput, useConnection });
    const config: DatabaseConfig = { driver: "mysql", host: "h", port: 3306, name: "db", user: "u", password: "pw" };
    expect(await deps.useConnection!(config)).toEqual({ ok: true, tablesCount: 3 });
    expect(useConnection).toHaveBeenCalledWith(config);
  });

  it("não define as tools quando não fornecidas (compat legada)", () => {
    const deps = buildAiSessionDeps(baseInput);
    expect(deps.discoverConnections).toBeUndefined();
    expect(deps.useConnection).toBeUndefined();
  });
});
