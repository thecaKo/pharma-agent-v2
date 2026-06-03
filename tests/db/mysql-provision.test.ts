import { describe, expect, it, vi } from "vitest";
import { MySqlSourceAdapter, type MySqlDriverConnection } from "../../src/db/mysql-adapter.js";
import type { DatabaseConfig } from "../../src/config/types.js";

const config: DatabaseConfig = {
  driver: "mysql",
  host: "127.0.0.1",
  port: 3306,
  name: "pharmacy",
  user: "admin",
  password: "admin-secret"
};

describe("MySqlSourceAdapter.provisionReadonlyUser", () => {
  it("executa CREATE/ALTER/GRANT/FLUSH idempotentes e parametrizados", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const connection: MySqlDriverConnection = {
      query: vi.fn(async (sql: string, params: readonly unknown[]) => {
        calls.push({ sql, params });
        return [[], []];
      }),
      end: vi.fn(async () => undefined)
    };
    const adapter = new MySqlSourceAdapter({ config, connectionFactory: vi.fn(async () => connection) });
    await adapter.connect();

    const result = await adapter.provisionReadonlyUser({
      username: "pharma_connector_ro",
      password: "a-very-strong-password-1234"
    });

    expect(result).toEqual({ outcome: "provisioned", grantedScope: "all_tables" });
    const sqls = calls.map((c) => c.sql);
    expect(sqls[0]).toContain("CREATE USER IF NOT EXISTS");
    expect(sqls[1]).toContain("ALTER USER");
    expect(sqls[2]).toContain("GRANT SELECT ON");
    expect(sqls[3]).toContain("FLUSH PRIVILEGES");
    // senha nunca concatenada no texto SQL — sempre por parâmetro
    for (const c of calls) {
      expect(c.sql).not.toContain("a-very-strong-password-1234");
    }
    // CREATE e ALTER recebem a senha como parâmetro posicional
    expect(calls[0]!.params).toContain("a-very-strong-password-1234");
    expect(calls[1]!.params).toContain("a-very-strong-password-1234");
  });
});
