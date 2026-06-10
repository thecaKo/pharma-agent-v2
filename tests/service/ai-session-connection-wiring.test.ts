import { describe, expect, it, vi } from "vitest";
import { buildAiSessionDeps } from "../../src/service/ai-session-wiring.js";
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

describe("buildAiSessionDeps — db.connect wiring", () => {
  it("repassa connectDatabase quando fornecido", async () => {
    const connectDatabase = vi.fn(async () => ({ ok: true, tablesCount: 3 }));
    const deps = buildAiSessionDeps({ ...baseInput, connectDatabase });
    const config: DatabaseConfig = { driver: "mysql", host: "h", port: 3306, name: "db", user: "u", password: "pw" };
    expect(deps.connectDatabase).toBeDefined();
    expect(await deps.connectDatabase!(config)).toEqual({ ok: true, tablesCount: 3 });
    expect(connectDatabase).toHaveBeenCalledWith(config);
  });

  it("não define a tool quando não fornecida (compat legada)", () => {
    const deps = buildAiSessionDeps(baseInput);
    expect(deps.connectDatabase).toBeUndefined();
  });
});
