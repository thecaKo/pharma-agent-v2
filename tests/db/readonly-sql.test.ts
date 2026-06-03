import { describe, expect, it } from "vitest";
import { validateReadOnlySelect, ReadOnlySqlError, MAX_SQL_BYTES } from "../../src/db/readonly-sql.js";

describe("validateReadOnlySelect — aceitos", () => {
  it.each([
    "SELECT 1",
    "select p.codigo, p.nome from produtos p",
    "  SELECT * FROM produtos LEFT JOIN desconto_produtos dp ON dp.produto_id = produtos.id  ",
    "WITH ativos AS (SELECT id FROM produtos WHERE ativo = 1) SELECT * FROM ativos",
    "SELECT 'INSERT INTO x' AS literal FROM produtos"
  ])("aceita: %s", (sql) => {
    const r = validateReadOnlySelect(sql, { maxLimit: 100 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sql.toLowerCase()).toContain("select");
  });
});

describe("validateReadOnlySelect — rejeitados", () => {
  it.each([
    ["INSERT", "INSERT INTO produtos VALUES (1)"],
    ["UPDATE", "UPDATE produtos SET nome = 'x'"],
    ["DELETE", "DELETE FROM produtos"],
    ["MERGE", "MERGE INTO produtos USING t ON (1=1) WHEN MATCHED THEN UPDATE SET nome='x'"],
    ["CREATE", "CREATE TABLE t (id int)"],
    ["ALTER", "ALTER TABLE produtos ADD c int"],
    ["DROP", "DROP TABLE produtos"],
    ["TRUNCATE", "TRUNCATE TABLE produtos"],
    ["GRANT", "GRANT SELECT ON produtos TO u"],
    ["multi-statement", "SELECT 1; DROP TABLE produtos"],
    ["comentario-esconde-ddl", "SELECT 1 -- ok\n; DROP TABLE produtos"],
    ["bloco-comentario-esconde", "SELECT 1 /* x */; DELETE FROM produtos"],
    ["CALL", "CALL minha_proc()"],
    ["EXEC", "EXEC sp_who"],
    ["EXECUTE", "EXECUTE minha_proc"],
    ["vazio", "   "],
    ["nao-select", "WITH t AS (DELETE FROM produtos RETURNING *) SELECT * FROM t"]
  ])("rejeita %s", (_label, sql) => {
    const r = validateReadOnlySelect(sql, { maxLimit: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeTypeOf("string");
  });
});

describe("validateReadOnlySelect — LIMIT", () => {
  it("injeta LIMIT quando ausente", () => {
    const r = validateReadOnlySelect("SELECT * FROM produtos", { maxLimit: 50 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sql).toMatch(/limit 50$/i);
  });

  it("reduz LIMIT acima do teto", () => {
    const r = validateReadOnlySelect("SELECT * FROM produtos LIMIT 9999", { maxLimit: 50 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sql).toMatch(/limit 50$/i);
  });

  it("preserva LIMIT dentro do teto", () => {
    const r = validateReadOnlySelect("SELECT * FROM produtos LIMIT 10", { maxLimit: 50 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sql).toMatch(/limit 10$/i);
  });

  it("ReadOnlySqlError carrega o motivo", () => {
    const err = new ReadOnlySqlError("multi-statement não permitido");
    expect(err.name).toBe("ReadOnlySqlError");
    expect(err.message).toContain("multi-statement");
  });
});

describe("validateReadOnlySelect — segurança defensiva", () => {
  it("rejeita comentário de bloco não terminado", () => {
    const r = validateReadOnlySelect("SELECT 1 /* sem fechar", { maxLimit: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("comentário de bloco não terminado");
  });

  it("rejeita SQL acima do teto de tamanho", () => {
    const big = `SELECT '${"x".repeat(MAX_SQL_BYTES)}' FROM produtos`;
    expect(Buffer.byteLength(big, "utf8")).toBeGreaterThan(MAX_SQL_BYTES);
    const r = validateReadOnlySelect(big, { maxLimit: 100 });
    expect(r.ok).toBe(false);
  });
});
