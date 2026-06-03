import { describe, expect, it, vi } from "vitest";
import { SqlServerSourceAdapter, type SqlServerDriverConnection } from "../../src/db/sqlserver-adapter.js";
import type { DatabaseConfig } from "../../src/config/types.js";

const config: DatabaseConfig = {
  driver: "sqlserver",
  host: "127.0.0.1",
  port: 1433,
  name: "pharmacy",
  user: "admin",
  password: "admin-secret"
};

describe("SqlServerSourceAdapter.provisionReadonlyUser", () => {
  it("cria/altera login, cria user e adiciona ao db_datareader; senha por parâmetro nomeado", async () => {
    const calls: Array<{ sql: string; params: Record<string, unknown> }> = [];
    const connection: SqlServerDriverConnection = {
      query: vi.fn(async (sql: string, params: Record<string, unknown>) => {
        calls.push({ sql, params });
        return { recordset: [] };
      }),
      close: vi.fn(async () => undefined)
    };
    const adapter = new SqlServerSourceAdapter({ config, connectionFactory: vi.fn(async () => connection) });
    await adapter.connect();

    const result = await adapter.provisionReadonlyUser({
      username: "pharma_connector_ro",
      password: "sqlserver-strong-pwd-1234567"
    });

    expect(result).toEqual({ outcome: "provisioned", grantedScope: "all_tables" });
    const joined = calls.map((c) => c.sql).join("\n");
    expect(joined).toContain("LOGIN");
    expect(joined).toContain("CREATE USER");
    expect(joined).toContain("db_datareader");
    for (const c of calls) expect(c.sql).not.toContain("sqlserver-strong-pwd-1234567");
    const usedParam = calls.some((c) => Object.values(c.params).includes("sqlserver-strong-pwd-1234567"));
    expect(usedParam).toBe(true);
  });

  it("mapeia erros 229/15247 para fallback_no_privilege", async () => {
    const connection: SqlServerDriverConnection = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("db_datareader")) throw Object.assign(new Error("permission"), { number: 15247 });
        return { recordset: [] };
      }),
      close: vi.fn(async () => undefined)
    };
    const adapter = new SqlServerSourceAdapter({ config, connectionFactory: vi.fn(async () => connection) });
    await adapter.connect();
    const result = await adapter.provisionReadonlyUser({ username: "pharma_connector_ro", password: "p-1234567890-abcdefgh" });
    expect(result.outcome).toBe("fallback_no_privilege");
  });
});
