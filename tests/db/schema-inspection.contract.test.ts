import { describe, expect, it, vi } from "vitest";
import { MySqlSourceAdapter, type MySqlDriverConnection } from "../../src/db/mysql-adapter.js";
import type { DatabaseConfig } from "../../src/config/types.js";

const config: DatabaseConfig = {
  driver: "mysql", host: "127.0.0.1", port: 3306,
  name: "pharmacy", user: "ro", password: "secret-pw"
};

function adapterWith(query: MySqlDriverConnection["query"]): MySqlSourceAdapter {
  const connection: MySqlDriverConnection = { query, end: vi.fn(async () => undefined) };
  return new MySqlSourceAdapter({ config, connectionFactory: vi.fn(async () => connection) });
}

describe("MySqlSourceAdapter schema inspection", () => {
  it("describeTable retorna colunas via information_schema", async () => {
    const query = vi.fn(async () => [[{ name: "id", dataType: "int", nullable: "NO" }], []]);
    const adapter = adapterWith(query);
    await adapter.connect();
    const cols = await adapter.describeTable("produtos");
    expect(cols).toEqual([{ name: "id", dataType: "int", nullable: false }]);
    expect(query.mock.calls[0]?.[1]).toEqual(["pharmacy", "produtos"]);
  });
});

describe("MySqlSourceAdapter — FK / sample / readonly select", () => {
  it("listForeignKeys lê key_column_usage", async () => {
    const query = vi.fn(async () => [[
      { fromTable: "desconto_produtos", fromColumn: "produto_id", toTable: "produtos", toColumn: "id", constraintName: "fk_dp" }
    ], []]);
    const connection: MySqlDriverConnection = { query, end: vi.fn(async () => undefined) };
    const adapter = new MySqlSourceAdapter({ config, connectionFactory: vi.fn(async () => connection) });
    await adapter.connect();
    const fks = await adapter.listForeignKeys("desconto_produtos");
    expect(fks).toEqual([
      { fromTable: "desconto_produtos", fromColumn: "produto_id", toTable: "produtos", toColumn: "id", constraintName: "fk_dp" }
    ]);
  });

  it("sampleRows aplica limite numérico inline", async () => {
    const query = vi.fn(async () => [[{ id: 1 }], []]);
    const connection: MySqlDriverConnection = { query, end: vi.fn(async () => undefined) };
    const adapter = new MySqlSourceAdapter({ config, connectionFactory: vi.fn(async () => connection) });
    await adapter.connect();
    const rows = await adapter.sampleRows("produtos", 5);
    expect(rows).toEqual([{ id: 1 }]);
    expect(query.mock.calls[0]?.[0]).toMatch(/limit 5/i);
  });

  it("runReadOnlySelect rejeita escrita antes de tocar o driver", async () => {
    const query = vi.fn(async () => [[], []]);
    const connection: MySqlDriverConnection = { query, end: vi.fn(async () => undefined) };
    const adapter = new MySqlSourceAdapter({ config, connectionFactory: vi.fn(async () => connection) });
    await adapter.connect();
    await expect(
      adapter.runReadOnlySelect({ sql: "DELETE FROM produtos", limit: 10 })
    ).rejects.toThrow(/escrita|SELECT/i);
    expect(query).not.toHaveBeenCalled();
  });

  it("runReadOnlySelect executa SELECT validado com LIMIT", async () => {
    const query = vi.fn(async () => [[{ codigo: "P1" }], []]);
    const connection: MySqlDriverConnection = { query, end: vi.fn(async () => undefined) };
    const adapter = new MySqlSourceAdapter({ config, connectionFactory: vi.fn(async () => connection) });
    await adapter.connect();
    const rows = await adapter.runReadOnlySelect({ sql: "SELECT codigo FROM produtos", limit: 25 });
    expect(rows).toEqual([{ codigo: "P1" }]);
    expect(query.mock.calls[0]?.[0]).toMatch(/limit 25/i);
  });
});
