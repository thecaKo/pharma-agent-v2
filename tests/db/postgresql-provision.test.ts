import { describe, expect, it, vi } from "vitest";
import { PostgresSourceAdapter, type PostgresDriverConnection } from "../../src/db/postgresql-adapter.js";
import type { DatabaseConfig } from "../../src/config/types.js";

const config: DatabaseConfig = {
  driver: "postgresql",
  host: "127.0.0.1",
  port: 5432,
  name: "pharmacy",
  user: "admin",
  password: "admin-secret"
};

describe("PostgresSourceAdapter.provisionReadonlyUser", () => {
  it("cria/altera role com senha parametrizada e concede CONNECT/USAGE/SELECT", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const connection: PostgresDriverConnection = {
      query: vi.fn(async (sql: string, params: readonly unknown[]) => {
        calls.push({ sql, params });
        return { rows: [] };
      }),
      end: vi.fn(async () => undefined)
    };
    const adapter = new PostgresSourceAdapter({ config, connectionFactory: vi.fn(async () => connection) });
    await adapter.connect();

    const result = await adapter.provisionReadonlyUser({
      username: "pharma_connector_ro",
      password: "pg-strong-password-1234567890"
    });

    expect(result).toEqual({ outcome: "provisioned", grantedScope: "all_tables" });
    const joined = calls.map((c) => c.sql).join("\n");
    expect(joined).toContain("ROLE");
    expect(joined).toContain("PASSWORD");
    expect(joined).toContain("GRANT CONNECT");
    expect(joined).toContain("GRANT USAGE ON SCHEMA");
    expect(joined).toContain("GRANT SELECT ON ALL TABLES IN SCHEMA");
    // senha sempre por parâmetro, nunca no texto
    for (const c of calls) expect(c.sql).not.toContain("pg-strong-password-1234567890");
    const passwordParamUsed = calls.some((c) => c.params.includes("pg-strong-password-1234567890"));
    expect(passwordParamUsed).toBe(true);
  });

  it("mapeia SQLSTATE 42501 para fallback_no_privilege", async () => {
    const connection: PostgresDriverConnection = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("GRANT SELECT ON ALL TABLES")) {
          throw Object.assign(new Error("permission denied"), { code: "42501" });
        }
        return { rows: [] };
      }),
      end: vi.fn(async () => undefined)
    };
    const adapter = new PostgresSourceAdapter({ config, connectionFactory: vi.fn(async () => connection) });
    await adapter.connect();
    const result = await adapter.provisionReadonlyUser({ username: "pharma_connector_ro", password: "p-1234567890-abcdefgh" });
    expect(result.outcome).toBe("fallback_no_privilege");
  });
});
