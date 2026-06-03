import { describe, expect, it, vi } from "vitest";
import { MariaDbSourceAdapter, type MariaDbDriverConnection } from "../../src/db/mariadb-adapter.js";
import type { DatabaseConfig } from "../../src/config/types.js";

const config: DatabaseConfig = {
  driver: "mariadb",
  host: "127.0.0.1",
  port: 3306,
  name: "pharmacy",
  user: "admin",
  password: "admin-secret"
};

describe("MariaDbSourceAdapter.provisionReadonlyUser", () => {
  it("executa statements idempotentes parametrizados e nunca concatena a senha", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const connection: MariaDbDriverConnection = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return [];
      }),
      end: vi.fn(async () => undefined)
    };
    const adapter = new MariaDbSourceAdapter({ config, connectionFactory: vi.fn(async () => connection) });
    await adapter.connect();

    const result = await adapter.provisionReadonlyUser({
      username: "pharma_connector_ro",
      password: "maria-strong-password-1234567"
    });

    expect(result).toEqual({ outcome: "provisioned", grantedScope: "all_tables" });
    const sqls = calls.map((c) => c.sql);
    expect(sqls[0]).toContain("CREATE USER IF NOT EXISTS");
    expect(sqls[1]).toContain("ALTER USER");
    expect(sqls[2]).toContain("GRANT SELECT ON");
    expect(sqls[3]).toContain("FLUSH PRIVILEGES");
    for (const c of calls) expect(c.sql).not.toContain("maria-strong-password-1234567");
  });

  it("mapeia 1044/1142 para fallback_no_privilege", async () => {
    const connection: MariaDbDriverConnection = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("GRANT SELECT")) throw Object.assign(new Error("denied"), { errno: 1044 });
        return [];
      }),
      end: vi.fn(async () => undefined)
    };
    const adapter = new MariaDbSourceAdapter({ config, connectionFactory: vi.fn(async () => connection) });
    await adapter.connect();
    const result = await adapter.provisionReadonlyUser({ username: "pharma_connector_ro", password: "p-1234567890-abcdefgh" });
    expect(result.outcome).toBe("fallback_no_privilege");
  });
});
