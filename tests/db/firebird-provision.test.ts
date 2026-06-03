import { describe, expect, it, vi } from "vitest";
import { FirebirdSourceAdapter, type FirebirdDriverConnection } from "../../src/db/firebird-adapter.js";
import type { DatabaseConfig } from "../../src/config/types.js";

const config: DatabaseConfig = {
  driver: "firebird",
  host: "127.0.0.1",
  port: 3050,
  name: "/data/pharmacy.fdb",
  user: "SYSDBA",
  password: "masterkey"
};

describe("FirebirdSourceAdapter.provisionReadonlyUser", () => {
  it("cria/altera usuário com senha parametrizada e itera RDB$RELATIONS concedendo SELECT", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const connection: FirebirdDriverConnection = {
      query: vi.fn(async (sql: string, params: readonly unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes("RDB$RELATIONS")) {
          return [{ RDB$RELATION_NAME: "PRODUTOS" }, { RDB$RELATION_NAME: "PRECOS" }];
        }
        return [];
      }),
      detach: vi.fn(async () => undefined)
    };
    const adapter = new FirebirdSourceAdapter({ config, connectionFactory: vi.fn(async () => connection) });
    await adapter.connect();

    const result = await adapter.provisionReadonlyUser({
      username: "pharma_connector_ro",
      password: "firebird-strong-password-1234"
    });

    expect(result).toEqual({ outcome: "provisioned", grantedScope: "all_tables" });
    const joined = calls.map((c) => c.sql).join("\n");
    expect(joined).toContain("CREATE OR ALTER USER");
    expect(joined).toContain("RDB$RELATIONS");
    const grantCalls = calls.filter((c) => c.sql.includes("GRANT SELECT"));
    expect(grantCalls.length).toBe(2);
    expect(grantCalls[0]!.sql).toContain("PRODUTOS");
    expect(grantCalls[1]!.sql).toContain("PRECOS");
    for (const c of calls) expect(c.sql).not.toContain("firebird-strong-password-1234");
  });

  it("aborta e lança erro quando um GRANT falha no meio do loop (nunca grants parciais)", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const connection: FirebirdDriverConnection = {
      query: vi.fn(async (sql: string, params: readonly unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes("RDB$RELATIONS")) {
          return [
            { RDB$RELATION_NAME: "PRODUTOS" },
            { RDB$RELATION_NAME: "PRECOS" },
            { RDB$RELATION_NAME: "ESTOQUE" }
          ];
        }
        // 2º GRANT (PRECOS) falha por um erro genérico (não-privilégio) no meio do loop.
        if (sql.includes("GRANT SELECT") && sql.includes("PRECOS")) {
          throw new Error("connection reset by peer");
        }
        return [];
      }),
      detach: vi.fn(async () => undefined)
    };
    const adapter = new FirebirdSourceAdapter({ config, connectionFactory: vi.fn(async () => connection) });
    await adapter.connect();

    await expect(
      adapter.provisionReadonlyUser({ username: "pharma_connector_ro", password: "p-1234567890-abcdefgh" })
    ).rejects.toThrowError();

    // Aborta no GRANT que falhou: a 3ª tabela (ESTOQUE) nunca recebe GRANT.
    const grantCalls = calls.filter((c) => c.sql.includes("GRANT SELECT"));
    expect(grantCalls.some((c) => c.sql.includes("ESTOQUE"))).toBe(false);
  });

  it("aborta e lança erro mesmo quando o GRANT no meio do loop é negado por privilégio", async () => {
    // Mesmo um erro 'no permission' no meio do loop NÃO pode virar fallback: o usuário
    // já existe com grants parciais. Deve propagar como erro para o runtime reverter.
    const connection: FirebirdDriverConnection = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("RDB$RELATIONS")) {
          return [{ RDB$RELATION_NAME: "PRODUTOS" }, { RDB$RELATION_NAME: "PRECOS" }];
        }
        if (sql.includes("GRANT SELECT") && sql.includes("PRECOS")) {
          throw new Error("no permission for GRANT on PRECOS");
        }
        return [];
      }),
      detach: vi.fn(async () => undefined)
    };
    const adapter = new FirebirdSourceAdapter({ config, connectionFactory: vi.fn(async () => connection) });
    await adapter.connect();

    await expect(
      adapter.provisionReadonlyUser({ username: "pharma_connector_ro", password: "p-1234567890-abcdefgh" })
    ).rejects.toThrowError();
  });

  it("rejeita username read-only inválido antes de qualquer SQL", async () => {
    const connection: FirebirdDriverConnection = {
      query: vi.fn(async () => []),
      detach: vi.fn(async () => undefined)
    };
    const adapter = new FirebirdSourceAdapter({ config, connectionFactory: vi.fn(async () => connection) });
    await adapter.connect();

    await expect(
      adapter.provisionReadonlyUser({ username: "1bad$name", password: "p-1234567890-abcdefgh" })
    ).rejects.toThrowError();
    expect(connection.query).not.toHaveBeenCalled();
  });

  it("mapeia mensagem 'no permission' para fallback_no_privilege", async () => {
    const connection: FirebirdDriverConnection = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("CREATE OR ALTER USER")) {
          throw new Error("no permission for CREATE access to USER");
        }
        return [];
      }),
      detach: vi.fn(async () => undefined)
    };
    const adapter = new FirebirdSourceAdapter({ config, connectionFactory: vi.fn(async () => connection) });
    await adapter.connect();
    const result = await adapter.provisionReadonlyUser({ username: "pharma_connector_ro", password: "p-1234567890-abcdefgh" });
    expect(result.outcome).toBe("fallback_no_privilege");
  });
});
