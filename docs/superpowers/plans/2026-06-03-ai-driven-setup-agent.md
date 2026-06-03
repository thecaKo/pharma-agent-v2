# AI-Driven Setup — Agente: Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transformar o `pharma-agent-v2` em host de um **catálogo fechado de 14 ferramentas read-only** controlado por uma sessão de IA que roda no neo. O agente recebe `ai.session.start`, anuncia o catálogo (`ai.catalog`), executa cada `tool.invoke` (somente leitura), devolve `tool.result` + `audit.event` **com segredos redigidos na borda**, e ao receber `mapping.decision: approve` persiste credenciais (`writeDatabaseConfig`) + mapping (fluxo `connector.config` existente) e transiciona para `synced`. O poller continua intacto.

**Architecture:** Tool-calling sobre o WebSocket existente (`src/transport`). O loop agentic (LLM) vive no neo; o agente só executa ferramentas e emite eventos auditáveis. Read-only garantido por defesa em camadas: (1) catálogo fechado — `tool.invoke.name` só aceita as 14 ferramentas; (2) validador de SELECT puro (`src/db/readonly-sql.ts`) com LIMIT forçado + timeout; (3) `fs`/`registry` sem ferramenta de escrita + deny-list reaproveitada do `scan-config-dirs`. As novas ferramentas de schema reusam o `SourceDatabaseAdapter`; as probes existentes são reexpostas como ferramentas via `handleAdminRequest`. A sessão de IA é uma classe nova (`src/ai-session/ai-session.ts`) plugada na `ConnectorRuntime` por handlers de transporte.

**Tech Stack:** TypeScript ESM (imports com sufixo `.js`), vitest (`npm test` → `vitest run`), testes em `tests/**/*.test.ts`. Drivers MySQL/Firebird via factories injetadas. Redação via `src/logging/redact.ts`. Integração MySQL via `docker-compose.test.yml`.

---

## File Structure

### Arquivos criados

| Caminho | Responsabilidade |
|---|---|
| `src/db/readonly-sql.ts` | Validador de SELECT read-only: aceita SELECT/CTE-de-leitura puro; rejeita escrita/DDL/multi-statement/comentário-escondendo-statement/CALL-EXEC; injeta `LIMIT`; expõe `validateReadOnlySelect(sql, { maxLimit })`. |
| `src/discovery/read-config-file.ts` | Ferramenta `fs.readConfigFile`: lê 1 arquivo sob a deny-list/limites do `scan-config-dirs` (raiz não-negada, padrão permitido, tamanho máximo), devolve conteúdo. |
| `src/discovery/read-registry-key.ts` | Ferramenta `registry.readKey`: usa `RegistryReader.readKey` (read-only) com allow-list de hives. |
| `src/ai-session/tool-catalog.ts` | Monta `ToolDescriptor[]` das 14 ferramentas + `CATALOG_VERSION`; mapeia cada `tool.name` → `AdminCommand`/ação. |
| `src/ai-session/ai-protocol.ts` | Tipos + `build*`/`parse*` dos 9 envelopes WS novos (Contrato 2) e `AI_SESSION_*` constantes de tipo. |
| `src/ai-session/ai-session.ts` | Classe `AiSession`: ciclo start→catalog→invoke→result/audit→proposed→decision→state; `seq` incremental; `AbortController`; redação na borda. |
| `tests/db/readonly-sql.test.ts` | Tabela de casos do validador de SELECT. |
| `tests/discovery/read-config-file.test.ts` | Testes da ferramenta `fs.readConfigFile` (deny-list, tamanho, conteúdo). |
| `tests/discovery/read-registry-key.test.ts` | Testes da ferramenta `registry.readKey`. |
| `tests/ai-session/tool-catalog.test.ts` | Verifica as 14 ferramentas, schemas e `CATALOG_VERSION`. |
| `tests/ai-session/ai-protocol.test.ts` | Roundtrip parse/serialize de cada envelope + correlação `invocationId` + ordenação `seq`. |
| `tests/ai-session/ai-session.test.ts` | Fluxo da sessão, redação na borda, abort, transições de estado, approve/reject. |
| `tests/db/schema-inspection.contract.test.ts` | Contrato dos métodos novos do adapter em mysql + firebird (mocks de driver). |

### Arquivos modificados

| Caminho | Mudança |
|---|---|
| `src/db/source-adapter.ts` | Adiciona `describeTable`/`listForeignKeys`/`sampleRows`/`runReadOnlySelect` + tipos `ForeignKey`/`RunReadOnlySelectInput` à interface `SourceDatabaseAdapter`. |
| `src/db/mysql-adapter.ts` | Implementa os 4 métodos via `information_schema` + SELECT validado. |
| `src/db/firebird-adapter.ts` | Implementa os 4 métodos via `rdb$` + SELECT validado. |
| `src/discovery/admin-router.ts` | Estende `AdminCommand`-handling + `AdminRouterDependencies` com `schemaDescribeTable`/`schemaListForeignKeys`/`schemaSampleRows`/`sqlRunReadOnlySelect`/`fsReadConfigFile`/`registryReadKey` + validators `Validated<T>`. |
| `src/transport/protocol.ts` | Acrescenta os comandos novos a `AdminCommand` + `ADMIN_COMMANDS`. |
| `src/transport/server-message-router.ts` | Registra rotas de extensão para `ai.session.start`/`tool.invoke`/`mapping.decision`/`ai.session.abort`. |
| `src/service/runtime.ts` | Preenche as novas deps do `AdminRouterDependencies`; instancia `AiSession`; liga handlers de transporte; approve → `writeDatabaseConfig` + ativa mapping. |

---

## Convenções de teste

- **Unit:** `npx vitest run tests/<arquivo>` — espera-se `FAIL` antes da implementação e `PASS` depois.
- **Integração (fim de feature):** sobe MySQL de teste com `docker compose -f docker-compose.test.yml up -d --wait` e roda `npx vitest run tests/integration/source-adapters.fixture.test.ts` (já existente; estendido se necessário). Não faz parte das tarefas unitárias.
- **Commit:** mensagens pt-br, conventional, subject-only, com footer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## Tarefa 1 — `validateReadOnlySelect`: aceita SELECT/CTE, rejeita escrita

- [ ] **Write failing test** — `tests/db/readonly-sql.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validateReadOnlySelect, ReadOnlySqlError } from "../../src/db/readonly-sql.js";

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
```

- [ ] **Run test** — `npx vitest run tests/db/readonly-sql.test.ts` → **FAIL** (`Cannot find module '../../src/db/readonly-sql.js'`).

- [ ] **Implementação mínima** — `src/db/readonly-sql.ts`:

```ts
export class ReadOnlySqlError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ReadOnlySqlError";
  }
}

export interface ValidateReadOnlySelectOptions {
  maxLimit: number;
}

export type ValidateReadOnlySelectResult =
  | { ok: true; sql: string }
  | { ok: false; error: string };

const FORBIDDEN_KEYWORDS = [
  "insert", "update", "delete", "merge", "upsert", "replace",
  "create", "alter", "drop", "truncate", "rename",
  "grant", "revoke", "commit", "rollback", "savepoint",
  "call", "exec", "execute", "do", "set", "into"
];

export function validateReadOnlySelect(
  rawSql: string,
  options: ValidateReadOnlySelectOptions
): ValidateReadOnlySelectResult {
  const stripped = stripComments(rawSql);
  const trimmed = stripped.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "SQL vazio após remover comentários" };
  }

  const withoutTrailingSemicolon = trimmed.replace(/;+\s*$/u, "");
  if (withoutTrailingSemicolon.includes(";")) {
    return { ok: false, error: "multi-statement não permitido" };
  }

  const lower = withoutTrailingSemicolon.toLowerCase();
  if (!/^(select|with)\b/u.test(lower)) {
    return { ok: false, error: "somente SELECT ou CTE de leitura é permitido" };
  }

  const tokens = lower.match(/[a-z_][a-z0-9_]*/gu) ?? [];
  const literalRanges = literalSpans(withoutTrailingSemicolon);
  for (const keyword of FORBIDDEN_KEYWORDS) {
    if (tokenOutsideLiteral(withoutTrailingSemicolon, keyword, literalRanges)) {
      return { ok: false, error: `palavra-chave de escrita não permitida: ${keyword}` };
    }
  }
  void tokens;

  const limited = applyLimit(withoutTrailingSemicolon, options.maxLimit);
  return { ok: true, sql: limited };
}

function stripComments(sql: string): string {
  let result = "";
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (inSingle) {
      result += ch;
      if (ch === "'") inSingle = false;
      i += 1;
      continue;
    }
    if (inDouble) {
      result += ch;
      if (ch === '"') inDouble = false;
      i += 1;
      continue;
    }
    if (ch === "'") { inSingle = true; result += ch; i += 1; continue; }
    if (ch === '"') { inDouble = true; result += ch; i += 1; continue; }
    if (ch === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      result += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 2;
      result += " ";
      continue;
    }
    result += ch;
    i += 1;
  }
  return result;
}

function literalSpans(sql: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = i;
      i += 1;
      while (i < sql.length && sql[i] !== quote) i += 1;
      spans.push([start, i]);
    }
    i += 1;
  }
  return spans;
}

function tokenOutsideLiteral(sql: string, keyword: string, literals: Array<[number, number]>): boolean {
  const re = new RegExp(`\\b${keyword}\\b`, "giu");
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
    const idx = match.index;
    const inside = literals.some(([s, e]) => idx >= s && idx <= e);
    if (!inside) return true;
  }
  return false;
}

function applyLimit(sql: string, maxLimit: number): string {
  const re = /\blimit\s+(\d+)\s*$/iu;
  const match = re.exec(sql);
  if (match) {
    const current = Number.parseInt(match[1] ?? "0", 10);
    const capped = Math.min(current, maxLimit);
    return sql.replace(re, `limit ${capped}`);
  }
  return `${sql.trim()} limit ${maxLimit}`;
}
```

- [ ] **Run test** — `npx vitest run tests/db/readonly-sql.test.ts` → **PASS**.

- [ ] **Commit** — `git add src/db/readonly-sql.ts tests/db/readonly-sql.test.ts && git commit -m "feat(db): valida SELECT read-only com LIMIT forçado"`

---

## Tarefa 2 — Estender a interface `SourceDatabaseAdapter`

- [ ] **Write failing test** — `tests/db/schema-inspection.contract.test.ts` (parte 1, só tipos via mysql):

```ts
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
```

- [ ] **Run test** — `npx vitest run tests/db/schema-inspection.contract.test.ts` → **FAIL** (`Property 'describeTable' does not exist`).

- [ ] **Implementação mínima** — em `src/db/source-adapter.ts` adicione os tipos e amplie a interface:

```ts
export interface ForeignKey {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  constraintName?: string;
}

export interface RunReadOnlySelectInput {
  sql: string;
  limit: number;
  timeoutMs?: number;
}

export interface SourceDatabaseAdapter {
  connect(): Promise<void>;
  close(): Promise<void>;
  queryChanges(input: QueryChangesInput): Promise<SourceRow[]>;
  querySnapshotPage(input: QuerySnapshotPageInput): Promise<SourceRow[]>;
  listTables(): Promise<DatabaseTable[]>;
  listColumns(tableName: string): Promise<DatabaseColumn[]>;
  describeTable(tableName: string): Promise<DatabaseColumn[]>;
  listForeignKeys(tableName?: string): Promise<ForeignKey[]>;
  sampleRows(tableName: string, limit: number): Promise<SourceRow[]>;
  runReadOnlySelect(input: RunReadOnlySelectInput): Promise<SourceRow[]>;
}
```

> Nota de escopo: postgres/mariadb/sqlserver adapters **não** implementam estes 4 métodos nesta frente. A Tarefa 8 declara isso explicitamente lançando "not supported" via um mixin compartilhado, mantendo a interface satisfeita.

- [ ] **Run test** — `npx vitest run tests/db/schema-inspection.contract.test.ts` → ainda **FAIL** (mysql não implementa). Isso é esperado; será resolvido na Tarefa 3.

- [ ] **Commit** — `git add src/db/source-adapter.ts && git commit -m "feat(db): amplia SourceDatabaseAdapter com métodos de inspeção read-only"`

---

## Tarefa 3 — Implementar inspeção no `MySqlSourceAdapter`

- [ ] **Write failing test** — adicione a `tests/db/schema-inspection.contract.test.ts`:

```ts
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
```

- [ ] **Run test** — `npx vitest run tests/db/schema-inspection.contract.test.ts` → **FAIL**.

- [ ] **Implementação mínima** — em `src/db/mysql-adapter.ts` importe o validador e adicione os métodos à classe (antes de `requireConnection`). Note que `describeTable` reusa a mesma query de `listColumns`:

```ts
import { validateReadOnlySelect, ReadOnlySqlError } from "./readonly-sql.js";
import type {
  DatabaseColumn, DatabaseTable, ForeignKey, QueryChangesInput,
  QuerySnapshotPageInput, RunReadOnlySelectInput, SourceDatabaseAdapter
} from "./source-adapter.js";
import type { SourceRow } from "../mapping/types.js";
```

```ts
  public async describeTable(tableName: string): Promise<DatabaseColumn[]> {
    return this.listColumns(tableName);
  }

  public async listForeignKeys(tableName?: string): Promise<ForeignKey[]> {
    const connection = this.requireConnection("listColumns");
    try {
      const params: unknown[] = [this.config.name];
      let filter = "";
      if (tableName !== undefined) {
        filter = "and kcu.table_name = ?";
        params.push(tableName);
      }
      const result = await connection.query(
        `
          select kcu.table_name as fromTable,
                 kcu.column_name as fromColumn,
                 kcu.referenced_table_name as toTable,
                 kcu.referenced_column_name as toColumn,
                 kcu.constraint_name as constraintName
          from information_schema.key_column_usage kcu
          where kcu.table_schema = ?
            and kcu.referenced_table_name is not null
            ${filter}
          order by kcu.table_name, kcu.ordinal_position
        `,
        params
      );
      return normalizeForeignKeys(result);
    } catch (error) {
      throw normalizeDatabaseError({ driver: "mysql", operation: "listColumns", error, secrets: this.secrets });
    }
  }

  public async sampleRows(tableName: string, limit: number): Promise<SourceRow[]> {
    const safeLimit = clampSampleLimit(limit);
    const safeTable = quoteMysqlIdentifier(tableName);
    const connection = this.requireConnection();
    try {
      const result = await connection.query(`select * from ${safeTable} limit ${safeLimit}`, []);
      return normalizeRows(result);
    } catch (error) {
      throw normalizeDatabaseError({ driver: "mysql", operation: "query", error, secrets: this.secrets });
    }
  }

  public async runReadOnlySelect(input: RunReadOnlySelectInput): Promise<SourceRow[]> {
    const validated = validateReadOnlySelect(input.sql, { maxLimit: clampSampleLimit(input.limit) });
    if (!validated.ok) {
      throw new ReadOnlySqlError(validated.error);
    }
    const connection = this.requireConnection();
    try {
      const result = await connection.query(validated.sql, []);
      return normalizeRows(result);
    } catch (error) {
      throw normalizeDatabaseError({ driver: "mysql", operation: "query", error, secrets: this.secrets });
    }
  }
```

E adicione, junto às funções utilitárias do arquivo:

```ts
function normalizeForeignKeys(result: unknown): ForeignKey[] {
  const rows = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
  if (!Array.isArray(rows)) return [];
  return rows.filter(isRecord).flatMap((row) => {
    const fromTable = normalizeString(row.fromTable ?? row.TABLE_NAME);
    const fromColumn = normalizeString(row.fromColumn ?? row.COLUMN_NAME);
    const toTable = normalizeString(row.toTable ?? row.REFERENCED_TABLE_NAME);
    const toColumn = normalizeString(row.toColumn ?? row.REFERENCED_COLUMN_NAME);
    if (!fromTable || !fromColumn || !toTable || !toColumn) return [];
    const constraintName = normalizeString(row.constraintName ?? row.CONSTRAINT_NAME);
    return [{ fromTable, fromColumn, toTable, toColumn, ...(constraintName ? { constraintName } : {}) }];
  });
}

function clampSampleLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < 1) return 1;
  return Math.min(Math.trunc(limit), 1000);
}

function quoteMysqlIdentifier(name: string): string {
  if (!/^[A-Za-z0-9_$]+$/u.test(name)) {
    throw new ReadOnlySqlError(`nome de tabela inválido: ${name}`);
  }
  return `\`${name}\``;
}
```

- [ ] **Run test** — `npx vitest run tests/db/schema-inspection.contract.test.ts` → **PASS** (todos os casos mysql).

- [ ] **Commit** — `git add src/db/mysql-adapter.ts tests/db/schema-inspection.contract.test.ts && git commit -m "feat(db): inspeção read-only no MySqlSourceAdapter"`

---

## Tarefa 4 — Implementar inspeção no `FirebirdSourceAdapter`

- [ ] **Write failing test** — adicione a `tests/db/schema-inspection.contract.test.ts`:

```ts
import { FirebirdSourceAdapter, type FirebirdDriverConnection } from "../../src/db/firebird-adapter.js";

const fbConfig: DatabaseConfig = {
  driver: "firebird", host: "127.0.0.1", port: 3050,
  name: "/db/PHARMA.FDB", user: "SYSDBA", password: "masterkey"
};

describe("FirebirdSourceAdapter — inspeção", () => {
  it("listForeignKeys lê rdb$ relation constraints", async () => {
    const query = vi.fn(async () => [
      { fromTable: "DESCONTO_PRODUTOS", fromColumn: "PRODUTO_ID", toTable: "PRODUTOS", toColumn: "ID", constraintName: "FK_DP" }
    ]);
    const connection: FirebirdDriverConnection = { query, detach: vi.fn(async () => undefined) };
    const adapter = new FirebirdSourceAdapter({ config: fbConfig, connectionFactory: vi.fn(async () => connection) });
    await adapter.connect();
    const fks = await adapter.listForeignKeys();
    expect(fks).toEqual([
      { fromTable: "DESCONTO_PRODUTOS", fromColumn: "PRODUTO_ID", toTable: "PRODUTOS", toColumn: "ID", constraintName: "FK_DP" }
    ]);
  });

  it("sampleRows usa FIRST n", async () => {
    const query = vi.fn(async () => [{ ID: 1 }]);
    const connection: FirebirdDriverConnection = { query, detach: vi.fn(async () => undefined) };
    const adapter = new FirebirdSourceAdapter({ config: fbConfig, connectionFactory: vi.fn(async () => connection) });
    await adapter.connect();
    const rows = await adapter.sampleRows("PRODUTOS", 3);
    expect(rows).toEqual([{ ID: 1 }]);
    expect(query.mock.calls[0]?.[0]).toMatch(/first 3/i);
  });

  it("runReadOnlySelect rejeita escrita antes do driver", async () => {
    const query = vi.fn(async () => []);
    const connection: FirebirdDriverConnection = { query, detach: vi.fn(async () => undefined) };
    const adapter = new FirebirdSourceAdapter({ config: fbConfig, connectionFactory: vi.fn(async () => connection) });
    await adapter.connect();
    await expect(adapter.runReadOnlySelect({ sql: "UPDATE PRODUTOS SET NOME='x'", limit: 5 })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
});
```

- [ ] **Run test** — `npx vitest run tests/db/schema-inspection.contract.test.ts` → **FAIL** (firebird não implementa).

- [ ] **Implementação mínima** — em `src/db/firebird-adapter.ts` importe o validador e adicione os métodos. Firebird usa `FIRST n` em vez de `LIMIT`; por isso o `runReadOnlySelect` valida (rejeição de escrita) mas injeta `FIRST` próprio:

```ts
import { validateReadOnlySelect, ReadOnlySqlError } from "./readonly-sql.js";
import type {
  DatabaseColumn, DatabaseTable, ForeignKey, QueryChangesInput,
  QuerySnapshotPageInput, RunReadOnlySelectInput, SourceDatabaseAdapter
} from "./source-adapter.js";
```

```ts
  public async describeTable(tableName: string): Promise<DatabaseColumn[]> {
    return this.listColumns(tableName);
  }

  public async listForeignKeys(tableName?: string): Promise<ForeignKey[]> {
    const connection = this.requireConnection("listColumns");
    try {
      const params: unknown[] = [];
      let filter = "";
      if (tableName !== undefined) {
        filter = "and rc.rdb$relation_name = ?";
        params.push(tableName);
      }
      const result = await connection.query(
        `
          select rc.rdb$relation_name as fromTable,
                 sf.rdb$field_name as fromColumn,
                 rc2.rdb$relation_name as toTable,
                 sf2.rdb$field_name as toColumn,
                 rc.rdb$constraint_name as constraintName
          from rdb$relation_constraints rc
          join rdb$ref_constraints ref on ref.rdb$constraint_name = rc.rdb$constraint_name
          join rdb$relation_constraints rc2 on rc2.rdb$constraint_name = ref.rdb$const_name_uq
          join rdb$index_segments sf on sf.rdb$index_name = rc.rdb$index_name
          join rdb$index_segments sf2 on sf2.rdb$index_name = rc2.rdb$index_name
          where rc.rdb$constraint_type = 'FOREIGN KEY'
            ${filter}
          order by rc.rdb$relation_name
        `,
        params
      );
      return normalizeForeignKeys(result);
    } catch (error) {
      throw normalizeDatabaseError({ driver: "firebird", operation: "listColumns", error, secrets: this.secrets });
    }
  }

  public async sampleRows(tableName: string, limit: number): Promise<SourceRow[]> {
    const safeLimit = clampSampleLimit(limit);
    const safeTable = quoteFirebirdIdentifier(tableName);
    const connection = this.requireConnection();
    try {
      const result = await connection.query(`select first ${safeLimit} * from ${safeTable}`, []);
      return normalizeRows(result);
    } catch (error) {
      throw normalizeDatabaseError({ driver: "firebird", operation: "query", error, secrets: this.secrets });
    }
  }

  public async runReadOnlySelect(input: RunReadOnlySelectInput): Promise<SourceRow[]> {
    const validated = validateReadOnlySelect(input.sql, { maxLimit: clampSampleLimit(input.limit) });
    if (!validated.ok) {
      throw new ReadOnlySqlError(validated.error);
    }
    const connection = this.requireConnection();
    try {
      const result = await connection.query(validated.sql, []);
      return normalizeRows(result);
    } catch (error) {
      throw normalizeDatabaseError({ driver: "firebird", operation: "query", error, secrets: this.secrets });
    }
  }
```

E utilitários junto às funções do arquivo:

```ts
function normalizeForeignKeys(result: unknown): ForeignKey[] {
  if (!Array.isArray(result)) return [];
  return result.filter(isRecord).flatMap((row) => {
    const fromTable = normalizeString(row.fromTable ?? row.FROMTABLE ?? row.RDB$RELATION_NAME);
    const fromColumn = normalizeString(row.fromColumn ?? row.FROMCOLUMN);
    const toTable = normalizeString(row.toTable ?? row.TOTABLE);
    const toColumn = normalizeString(row.toColumn ?? row.TOCOLUMN);
    if (!fromTable || !fromColumn || !toTable || !toColumn) return [];
    const constraintName = normalizeString(row.constraintName ?? row.CONSTRAINTNAME);
    return [{ fromTable, fromColumn, toTable, toColumn, ...(constraintName ? { constraintName } : {}) }];
  });
}

function clampSampleLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < 1) return 1;
  return Math.min(Math.trunc(limit), 1000);
}

function quoteFirebirdIdentifier(name: string): string {
  if (!/^[A-Za-z0-9_$]+$/u.test(name)) {
    throw new ReadOnlySqlError(`nome de tabela inválido: ${name}`);
  }
  return `"${name}"`;
}
```

- [ ] **Run test** — `npx vitest run tests/db/schema-inspection.contract.test.ts` → **PASS**.

- [ ] **Commit** — `git add src/db/firebird-adapter.ts && git commit -m "feat(db): inspeção read-only no FirebirdSourceAdapter"`

---

## Tarefa 5 — Ferramenta `fs.readConfigFile` (deny-list reaproveitada)

- [ ] **Write failing test** — `tests/discovery/read-config-file.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { readConfigFile, MAX_CONFIG_FILE_BYTES } from "../../src/discovery/read-config-file.js";
import type { FileSystemReader } from "../../src/discovery/fs-reader.js";

function makeFs(map: Record<string, string | "permission" | "missing">): FileSystemReader {
  return {
    readFile: vi.fn(async (path: string) => {
      const v = map[path];
      if (v === undefined || v === "missing") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (v === "permission") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return v;
    }),
    listDir: vi.fn(async () => []),
    stat: vi.fn(async () => undefined),
    enumerateTop: vi.fn(async () => [])
  };
}

describe("readConfigFile", () => {
  it("lê arquivo permitido sob padrão default", async () => {
    const fs = makeFs({ "C:\\Linx\\config.ini": "host=db\nport=3050" });
    const r = await readConfigFile({ fs }, { path: "C:\\Linx\\config.ini" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toContain("host=db");
  });

  it("rejeita path sob raiz negada (Windows)", async () => {
    const fs = makeFs({ "C:\\Windows\\System32\\drivers\\etc\\hosts": "127.0.0.1" });
    const r = await readConfigFile({ fs }, { path: "C:\\Windows\\System32\\drivers\\etc\\hosts" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe("INVALID_INPUT");
  });

  it("rejeita extensão fora do padrão permitido", async () => {
    const fs = makeFs({ "C:\\Linx\\app.exe": "MZ" });
    const r = await readConfigFile({ fs }, { path: "C:\\Linx\\app.exe" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe("INVALID_INPUT");
  });

  it("rejeita conteúdo acima do limite", async () => {
    const big = "x".repeat(MAX_CONFIG_FILE_BYTES + 1);
    const fs = makeFs({ "C:\\Linx\\big.json": big });
    const r = await readConfigFile({ fs }, { path: "C:\\Linx\\big.json" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe("INVALID_INPUT");
  });

  it("mapeia erro de permissão", async () => {
    const fs = makeFs({ "C:\\Linx\\secret.ini": "permission" });
    const r = await readConfigFile({ fs }, { path: "C:\\Linx\\secret.ini" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe("unreachable");
  });

  it("mapeia arquivo ausente", async () => {
    const fs = makeFs({});
    const r = await readConfigFile({ fs }, { path: "C:\\Linx\\missing.ini" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe("unreachable");
  });
});
```

- [ ] **Run test** — `npx vitest run tests/discovery/read-config-file.test.ts` → **FAIL**.

- [ ] **Implementação mínima** — `src/discovery/read-config-file.ts`:

```ts
import type { FileSystemReader } from "./fs-reader.js";
import { DEFAULT_PATTERNS } from "./scan-config-dirs.js";

export const MAX_CONFIG_FILE_BYTES = 512 * 1024;

const DENY_PATH_REGEXES: RegExp[] = [
  /^[A-Z]:\\Windows(\\|$)/i,
  /^[A-Z]:\\\$Recycle\.Bin/i,
  /^\/etc(\/|$)/,
  /^\/usr(\/|$)/,
  /^\/proc(\/|$)/,
  /^\/sys(\/|$)/
];

export interface ReadConfigFileInput {
  path: string;
}

export interface ReadConfigFileContext {
  fs: FileSystemReader;
  patterns?: readonly string[];
}

export type ReadConfigFileResult =
  | { ok: true; path: string; content: string }
  | { ok: false; errorCode: "INVALID_INPUT" | "unreachable" | "unknown"; message: string };

export async function readConfigFile(
  ctx: ReadConfigFileContext,
  input: ReadConfigFileInput
): Promise<ReadConfigFileResult> {
  const path = input.path.trim();
  if (path.length === 0) {
    return { ok: false, errorCode: "INVALID_INPUT", message: "path é obrigatório" };
  }
  if (DENY_PATH_REGEXES.some((re) => re.test(path))) {
    return { ok: false, errorCode: "INVALID_INPUT", message: "path sob diretório negado" };
  }
  const fileName = path.split(/[\\/]/u).pop() ?? "";
  const patterns = ctx.patterns ?? DEFAULT_PATTERNS;
  if (!patterns.some((p) => globMatch(fileName, p))) {
    return { ok: false, errorCode: "INVALID_INPUT", message: "extensão de arquivo não permitida" };
  }

  let content: string;
  try {
    content = await ctx.fs.readFile(path, "utf8");
  } catch (err) {
    return { ok: false, errorCode: "unreachable", message: mapReadError(err) };
  }

  if (Buffer.byteLength(content, "utf8") > MAX_CONFIG_FILE_BYTES) {
    return { ok: false, errorCode: "INVALID_INPUT", message: "arquivo excede o limite de tamanho" };
  }
  return { ok: true, path, content };
}

function globMatch(name: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(name);
}

function mapReadError(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    const code = String((err as { code?: unknown }).code);
    if (code === "EACCES" || code === "EPERM") return "permissão negada";
    if (code === "ENOENT") return "arquivo não encontrado";
  }
  return "falha ao ler arquivo";
}
```

- [ ] **Run test** — `npx vitest run tests/discovery/read-config-file.test.ts` → **PASS**.

- [ ] **Commit** — `git add src/discovery/read-config-file.ts tests/discovery/read-config-file.test.ts && git commit -m "feat(discovery): ferramenta fs.readConfigFile com deny-list"`

---

## Tarefa 6 — Ferramenta `registry.readKey` (read-only)

- [ ] **Write failing test** — `tests/discovery/read-registry-key.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { readRegistryKey } from "../../src/discovery/read-registry-key.js";
import type { RegistryReader } from "../../src/db/registry-reader.js";

function makeRegistry(values: Record<string, string>): RegistryReader {
  return {
    listKeys: vi.fn(async () => []),
    readKey: vi.fn(async () => values)
  };
}

describe("readRegistryKey", () => {
  it("lê valores de hive permitido", async () => {
    const registry = makeRegistry({ Server: "db-host", Database: "PHARMA" });
    const r = await readRegistryKey(registry, { path: "HKLM\\Software\\Linx\\Conn" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.values).toEqual({ Server: "db-host", Database: "PHARMA" });
  });

  it("aceita HKEY_LOCAL_MACHINE longo", async () => {
    const registry = makeRegistry({ X: "1" });
    const r = await readRegistryKey(registry, { path: "HKEY_LOCAL_MACHINE\\Software\\App" });
    expect(r.ok).toBe(true);
  });

  it("rejeita hive fora da allow-list", async () => {
    const registry = makeRegistry({});
    const r = await readRegistryKey(registry, { path: "HKCR\\.exe" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe("INVALID_INPUT");
  });

  it("rejeita path vazio", async () => {
    const registry = makeRegistry({});
    const r = await readRegistryKey(registry, { path: "   " });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Run test** — `npx vitest run tests/discovery/read-registry-key.test.ts` → **FAIL**.

- [ ] **Implementação mínima** — `src/discovery/read-registry-key.ts`:

```ts
import type { RegistryReader } from "../db/registry-reader.js";

const ALLOWED_HIVES = [
  "HKLM", "HKCU",
  "HKEY_LOCAL_MACHINE", "HKEY_CURRENT_USER"
];

export interface ReadRegistryKeyInput {
  path: string;
}

export type ReadRegistryKeyResult =
  | { ok: true; path: string; values: Record<string, string> }
  | { ok: false; errorCode: "INVALID_INPUT" | "unknown"; message: string };

export async function readRegistryKey(
  registry: RegistryReader,
  input: ReadRegistryKeyInput
): Promise<ReadRegistryKeyResult> {
  const path = input.path.trim();
  if (path.length === 0) {
    return { ok: false, errorCode: "INVALID_INPUT", message: "path é obrigatório" };
  }
  const hive = path.split("\\")[0] ?? "";
  if (!ALLOWED_HIVES.includes(hive.toUpperCase())) {
    return { ok: false, errorCode: "INVALID_INPUT", message: `hive não permitido: ${hive}` };
  }
  try {
    const values = await registry.readKey(path);
    return { ok: true, path, values };
  } catch (err) {
    return { ok: false, errorCode: "unknown", message: err instanceof Error ? err.message : "falha ao ler registro" };
  }
}
```

- [ ] **Run test** — `npx vitest run tests/discovery/read-registry-key.test.ts` → **PASS**.

- [ ] **Commit** — `git add src/discovery/read-registry-key.ts tests/discovery/read-registry-key.test.ts && git commit -m "feat(discovery): ferramenta registry.readKey read-only"`

---

## Tarefa 7 — Estender `AdminCommand` (protocol) com os comandos novos

- [ ] **Write failing test** — `tests/transport/admin-command-catalog.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildAdminRequestMessage, parseServerMessage } from "../../src/transport/protocol.js";

const NEW_COMMANDS = [
  "schema.describeTable",
  "schema.listForeignKeys",
  "schema.sampleRows",
  "sql.runReadOnlySelect",
  "fs.readConfigFile",
  "registry.readKey"
] as const;

describe("AdminCommand — novos comandos do catálogo", () => {
  it.each(NEW_COMMANDS)("aceita %s no parse de admin.request", (command) => {
    const built = buildAdminRequestMessage({ requestId: "r1", command });
    const parsed = parseServerMessage(JSON.stringify({ ...built, input: { table: "produtos" } }));
    expect(parsed.type).toBe("admin.request");
    if (parsed.type === "admin.request") expect(parsed.command).toBe(command);
  });

  it("ainda rejeita comando desconhecido", () => {
    expect(() =>
      parseServerMessage(JSON.stringify({ type: "admin.request", requestId: "r1", command: "fs.writeFile" }))
    ).toThrow(/Unsupported admin command/);
  });
});
```

- [ ] **Run test** — `npx vitest run tests/transport/admin-command-catalog.test.ts` → **FAIL** (`Unsupported admin command: schema.describeTable`).

- [ ] **Implementação mínima** — em `src/transport/protocol.ts` amplie o type `AdminCommand` (linhas ~18-26) e o `ADMIN_COMMANDS` set (linhas ~502-511):

```ts
export type AdminCommand =
  | "schema.listTables"
  | "schema.describeTable"
  | "schema.listForeignKeys"
  | "schema.sampleRows"
  | "sql.runReadOnlySelect"
  | "fs.readConfigFile"
  | "registry.readKey"
  | "probe.engines"
  | "probe.odbc_dsns"
  | "probe.network"
  | "probe.test_connection"
  | "probe.processes"
  | "probe.connections"
  | "probe.scan_config_dirs";
```

```ts
const ADMIN_COMMANDS = new Set<AdminCommand>([
  "schema.listTables",
  "schema.describeTable",
  "schema.listForeignKeys",
  "schema.sampleRows",
  "sql.runReadOnlySelect",
  "fs.readConfigFile",
  "registry.readKey",
  "probe.engines",
  "probe.odbc_dsns",
  "probe.network",
  "probe.test_connection",
  "probe.processes",
  "probe.connections",
  "probe.scan_config_dirs"
]);
```

- [ ] **Run test** — `npx vitest run tests/transport/admin-command-catalog.test.ts` → **PASS**.

- [ ] **Commit** — `git add src/transport/protocol.ts tests/transport/admin-command-catalog.test.ts && git commit -m "feat(transport): novos AdminCommands do catálogo de IA"`

---

## Tarefa 8 — Despachar os novos comandos no `handleAdminRequest`

- [ ] **Write failing test** — `tests/discovery/admin-router-ai-tools.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { handleAdminRequest, type AdminRouterDependencies } from "../../src/discovery/admin-router.js";
import { buildAdminRequestMessage } from "../../src/transport/protocol.js";

function baseDeps(): AdminRouterDependencies {
  return {
    probeEngines: vi.fn(async () => []),
    probeOdbcDsns: vi.fn(async () => []),
    probeNetwork: vi.fn(async () => ({ reachable: false } as never)),
    probeTestConnection: vi.fn(async () => ({ ok: false, code: "unknown", message: "x" } as never)),
    probeProcesses: vi.fn(async () => []),
    probeConnections: vi.fn(async () => []),
    probeScanConfigDirs: vi.fn(async () => ({ files: [], truncated: false, rootsRejected: [], errors: [] })),
    schemaListTables: vi.fn(async () => []),
    schemaDescribeTable: vi.fn(async () => [{ name: "id", dataType: "int", nullable: false }]),
    schemaListForeignKeys: vi.fn(async () => [{ fromTable: "a", fromColumn: "b", toTable: "c", toColumn: "d" }]),
    schemaSampleRows: vi.fn(async () => [{ id: 1 }]),
    sqlRunReadOnlySelect: vi.fn(async () => [{ codigo: "P1" }]),
    fsReadConfigFile: vi.fn(async () => ({ ok: true, path: "C:\\x.ini", content: "host=db" } as never)),
    registryReadKey: vi.fn(async () => ({ ok: true, path: "HKLM\\x", values: { Server: "db" } } as never))
  };
}

describe("handleAdminRequest — ferramentas de IA", () => {
  it("schema.describeTable exige input.table", async () => {
    const res = await handleAdminRequest(buildAdminRequestMessage({ requestId: "r1", command: "schema.describeTable" }), baseDeps());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.errorCode).toBe("INVALID_INPUT");
  });

  it("schema.describeTable retorna colunas", async () => {
    const req = { ...buildAdminRequestMessage({ requestId: "r1", command: "schema.describeTable" }), input: { table: "produtos" } };
    const res = await handleAdminRequest(req, baseDeps());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.payload).toEqual({ columns: [{ name: "id", dataType: "int", nullable: false }] });
  });

  it("sql.runReadOnlySelect exige sql não vazio", async () => {
    const res = await handleAdminRequest(buildAdminRequestMessage({ requestId: "r1", command: "sql.runReadOnlySelect" }), baseDeps());
    expect(res.ok).toBe(false);
  });

  it("sql.runReadOnlySelect retorna linhas", async () => {
    const deps = baseDeps();
    const req = { ...buildAdminRequestMessage({ requestId: "r1", command: "sql.runReadOnlySelect" }), input: { sql: "SELECT codigo FROM produtos", limit: 10 } };
    const res = await handleAdminRequest(req, deps);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.payload).toEqual({ rows: [{ codigo: "P1" }] });
    expect(deps.sqlRunReadOnlySelect).toHaveBeenCalledWith({ sql: "SELECT codigo FROM produtos", limit: 10 });
  });

  it("fs.readConfigFile propaga payload da ferramenta", async () => {
    const req = { ...buildAdminRequestMessage({ requestId: "r1", command: "fs.readConfigFile" }), input: { path: "C:\\x.ini" } };
    const res = await handleAdminRequest(req, baseDeps());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.payload).toMatchObject({ ok: true, content: "host=db" });
  });

  it("registry.readKey propaga payload", async () => {
    const req = { ...buildAdminRequestMessage({ requestId: "r1", command: "registry.readKey" }), input: { path: "HKLM\\x" } };
    const res = await handleAdminRequest(req, baseDeps());
    expect(res.ok).toBe(true);
  });
});
```

- [ ] **Run test** — `npx vitest run tests/discovery/admin-router-ai-tools.test.ts` → **FAIL**.

- [ ] **Implementação mínima** — em `src/discovery/admin-router.ts`:

1. Amplie imports e `AdminRouterDependencies`:

```ts
import type { DatabaseColumn, ForeignKey } from "../db/source-adapter.js";
import type { SourceRow } from "../mapping/types.js";
import type { ReadConfigFileResult } from "./read-config-file.js";
import type { ReadRegistryKeyResult } from "./read-registry-key.js";
```

```ts
export interface AdminRouterDependencies {
  probeEngines: () => Promise<EngineCandidate[]>;
  probeOdbcDsns: () => Promise<OdbcDsnCandidate[]>;
  probeNetwork: (input: ProbeNetworkInput) => Promise<ProbeNetworkResult>;
  probeTestConnection: (input: TestConnectionInput) => Promise<TestConnectionResult>;
  probeProcesses: () => Promise<ProcessCandidate[]>;
  probeConnections: () => Promise<ConnectionCandidate[]>;
  probeScanConfigDirs: (input: ScanConfigDirsInput) => Promise<ScanConfigDirsResult>;
  schemaListTables: () => Promise<string[]>;
  schemaDescribeTable: (table: string) => Promise<DatabaseColumn[]>;
  schemaListForeignKeys: (table?: string) => Promise<ForeignKey[]>;
  schemaSampleRows: (table: string, limit: number) => Promise<SourceRow[]>;
  sqlRunReadOnlySelect: (input: { sql: string; limit: number }) => Promise<SourceRow[]>;
  fsReadConfigFile: (input: { path: string }) => Promise<ReadConfigFileResult>;
  registryReadKey: (input: { path: string }) => Promise<ReadRegistryKeyResult>;
}
```

2. Adicione os `case` no `switch` (antes do `default`):

```ts
      case "schema.describeTable": {
        const table = validateTableInput(req.input);
        if (!table.ok) return invalidInput(req, table.error);
        const columns = await deps.schemaDescribeTable(table.value);
        return success(req, { columns });
      }
      case "schema.listForeignKeys": {
        const table = optionalTableInput(req.input);
        if (!table.ok) return invalidInput(req, table.error);
        const foreignKeys = await deps.schemaListForeignKeys(table.value);
        return success(req, { foreignKeys });
      }
      case "schema.sampleRows": {
        const parsed = validateSampleRowsInput(req.input);
        if (!parsed.ok) return invalidInput(req, parsed.error);
        const rows = await deps.schemaSampleRows(parsed.value.table, parsed.value.limit);
        return success(req, { rows });
      }
      case "sql.runReadOnlySelect": {
        const parsed = validateRunSelectInput(req.input);
        if (!parsed.ok) return invalidInput(req, parsed.error);
        const rows = await deps.sqlRunReadOnlySelect(parsed.value);
        return success(req, { rows });
      }
      case "fs.readConfigFile": {
        const parsed = validatePathInput(req.input);
        if (!parsed.ok) return invalidInput(req, parsed.error);
        const result = await deps.fsReadConfigFile({ path: parsed.value });
        return success(req, result);
      }
      case "registry.readKey": {
        const parsed = validatePathInput(req.input);
        if (!parsed.ok) return invalidInput(req, parsed.error);
        const result = await deps.registryReadKey({ path: parsed.value });
        return success(req, result);
      }
```

3. Adicione os validators no fim do arquivo:

```ts
function validateTableInput(input: unknown): Validated<string> {
  if (!isRecord(input)) return { ok: false, error: "input must be an object" };
  const table = input.table;
  if (typeof table !== "string" || table.trim().length === 0) {
    return { ok: false, error: "input.table must be a non-empty string" };
  }
  return { ok: true, value: table.trim() };
}

function optionalTableInput(input: unknown): Validated<string | undefined> {
  if (input === undefined) return { ok: true, value: undefined };
  if (!isRecord(input)) return { ok: false, error: "input must be an object" };
  if (input.table === undefined) return { ok: true, value: undefined };
  if (typeof input.table !== "string" || input.table.trim().length === 0) {
    return { ok: false, error: "input.table must be a non-empty string" };
  }
  return { ok: true, value: input.table.trim() };
}

function validateSampleRowsInput(input: unknown): Validated<{ table: string; limit: number }> {
  if (!isRecord(input)) return { ok: false, error: "input must be an object" };
  if (typeof input.table !== "string" || input.table.trim().length === 0) {
    return { ok: false, error: "input.table must be a non-empty string" };
  }
  const limit = input.limit ?? 20;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    return { ok: false, error: "input.limit must be an integer between 1 and 1000" };
  }
  return { ok: true, value: { table: input.table.trim(), limit } };
}

function validateRunSelectInput(input: unknown): Validated<{ sql: string; limit: number }> {
  if (!isRecord(input)) return { ok: false, error: "input must be an object" };
  if (typeof input.sql !== "string" || input.sql.trim().length === 0) {
    return { ok: false, error: "input.sql must be a non-empty string" };
  }
  const limit = input.limit ?? 100;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    return { ok: false, error: "input.limit must be an integer between 1 and 1000" };
  }
  return { ok: true, value: { sql: input.sql, limit } };
}

function validatePathInput(input: unknown): Validated<string> {
  if (!isRecord(input)) return { ok: false, error: "input must be an object" };
  if (typeof input.path !== "string" || input.path.trim().length === 0) {
    return { ok: false, error: "input.path must be a non-empty string" };
  }
  return { ok: true, value: input.path.trim() };
}
```

- [ ] **Run test** — `npx vitest run tests/discovery/admin-router-ai-tools.test.ts` → **PASS**.

- [ ] **Commit** — `git add src/discovery/admin-router.ts tests/discovery/admin-router-ai-tools.test.ts && git commit -m "feat(discovery): handleAdminRequest despacha ferramentas de schema/fs/registry"`

---

## Tarefa 9 — Envelopes WS do Contrato 2 (`ai-protocol.ts`)

- [ ] **Write failing test** — `tests/ai-session/ai-protocol.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  AI_SESSION_START_TYPE, TOOL_INVOKE_TYPE, MAPPING_DECISION_TYPE, AI_SESSION_ABORT_TYPE,
  parseAiSessionStart, parseToolInvoke, parseMappingDecision, parseAiSessionAbort,
  buildAiCatalogMessage, buildToolResultMessage, buildAuditEventMessage,
  buildMappingProposedMessage, buildAiSessionStateMessage
} from "../../src/ai-session/ai-protocol.js";
import type { ValidatedMappingConfig } from "../../src/mapping/types.js";

const mapping: ValidatedMappingConfig = {
  mappingVersion: "v1", syncMode: "snapshot", pollIntervalMs: 60000, batchSize: 500,
  snapshotQuery: "SELECT 1", snapshotPageSize: 500,
  fields: { sourceProductCode: "codigo", name: "nome" }
};

describe("ai-protocol — parse (servidor→agente)", () => {
  it("parseAiSessionStart", () => {
    const r = parseAiSessionStart({ type: AI_SESSION_START_TYPE, sessionId: "s1" });
    expect(r).toMatchObject({ sessionId: "s1" });
  });

  it("parseToolInvoke exige name e invocationId", () => {
    const r = parseToolInvoke({ type: TOOL_INVOKE_TYPE, sessionId: "s1", invocationId: "i1", name: "schema.listTables", input: {} });
    expect(r).toMatchObject({ sessionId: "s1", invocationId: "i1", name: "schema.listTables" });
    expect(() => parseToolInvoke({ type: TOOL_INVOKE_TYPE, sessionId: "s1" })).toThrow();
  });

  it("parseMappingDecision aceita approve/reject", () => {
    expect(parseMappingDecision({ type: MAPPING_DECISION_TYPE, sessionId: "s1", decision: "approve" }).decision).toBe("approve");
    expect(parseMappingDecision({ type: MAPPING_DECISION_TYPE, sessionId: "s1", decision: "reject" }).decision).toBe("reject");
    expect(() => parseMappingDecision({ type: MAPPING_DECISION_TYPE, sessionId: "s1", decision: "maybe" })).toThrow();
  });

  it("parseAiSessionAbort exige reason", () => {
    expect(parseAiSessionAbort({ type: AI_SESSION_ABORT_TYPE, sessionId: "s1", reason: "user" }).reason).toBe("user");
  });
});

describe("ai-protocol — build (agente→servidor) roundtrip", () => {
  it("ai.catalog roundtrip", () => {
    const msg = buildAiCatalogMessage({ sessionId: "s1", catalogVersion: "1", tools: [{ name: "schema.listTables", description: "d", inputSchema: {}, outputSchema: {} }] });
    const back = JSON.parse(JSON.stringify(msg));
    expect(back.type).toBe("ai.catalog");
    expect(back.tools).toHaveLength(1);
    expect(typeof back.sentAt).toBe("string");
  });

  it("tool.result correlaciona invocationId", () => {
    const msg = buildToolResultMessage({ sessionId: "s1", invocationId: "i7", ok: true, payload: { rows: [] } });
    expect(msg.invocationId).toBe("i7");
    expect(msg.ok).toBe(true);
  });

  it("tool.result erro carrega errorCode", () => {
    const msg = buildToolResultMessage({ sessionId: "s1", invocationId: "i7", ok: false, errorCode: "auth" });
    expect(msg.ok).toBe(false);
    expect(msg.errorCode).toBe("auth");
  });

  it("audit.event preserva seq", () => {
    const a = buildAuditEventMessage({ sessionId: "s1", seq: 1, kind: "tool.invoke", tool: "schema.listTables", summary: "lista tabelas" });
    const b = buildAuditEventMessage({ sessionId: "s1", seq: 2, kind: "tool.result", summary: "ok" });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(typeof a.at).toBe("string");
  });

  it("mapping.proposed transporta mapping validado", () => {
    const msg = buildMappingProposedMessage({ sessionId: "s1", mapping, rationale: "join", previewRows: [{ codigo: "P1" }] });
    expect(msg.mapping.mappingVersion).toBe("v1");
    expect(msg.previewRows).toEqual([{ codigo: "P1" }]);
  });

  it("ai.session.state aceita fases válidas", () => {
    const msg = buildAiSessionStateMessage({ sessionId: "s1", phase: "discovering" });
    expect(msg.phase).toBe("discovering");
  });
});
```

- [ ] **Run test** — `npx vitest run tests/ai-session/ai-protocol.test.ts` → **FAIL**.

- [ ] **Implementação mínima** — `src/ai-session/ai-protocol.ts`:

```ts
import { ProtocolParseError } from "../transport/protocol.js";
import type { ValidatedMappingConfig, MappingConfig } from "../mapping/types.js";

export const AI_SESSION_START_TYPE = "ai.session.start";
export const TOOL_INVOKE_TYPE = "tool.invoke";
export const MAPPING_DECISION_TYPE = "mapping.decision";
export const AI_SESSION_ABORT_TYPE = "ai.session.abort";

export type AiSessionPhase =
  | "discovering" | "credentials" | "schema" | "proposing"
  | "applying" | "synced" | "failed" | "aborted";

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: object;
  outputSchema: object;
}

export interface AiSessionStartCommand { sessionId: string; sentAt?: string; }
export interface ToolInvokeCommand { sessionId: string; invocationId: string; name: string; input?: unknown; sentAt?: string; }
export interface MappingDecisionCommand { sessionId: string; decision: "approve" | "reject"; editedMapping?: MappingConfig; sentAt?: string; }
export interface AiSessionAbortCommand { sessionId: string; reason: string; sentAt?: string; }

export interface AiCatalogMessage { type: "ai.catalog"; sessionId: string; catalogVersion: string; tools: ToolDescriptor[]; sentAt: string; }
export interface ToolResultMessage { type: "tool.result"; sessionId: string; invocationId: string; ok: boolean; payload?: unknown; errorCode?: string; sentAt: string; }
export interface AuditEventMessage { type: "audit.event"; sessionId: string; seq: number; at: string; kind: string; tool?: string; summary: string; detail?: unknown; }
export interface MappingProposedMessage { type: "mapping.proposed"; sessionId: string; mapping: ValidatedMappingConfig; rationale: string; previewRows: unknown[]; sentAt: string; }
export interface AiSessionStateMessage { type: "ai.session.state"; sessionId: string; phase: AiSessionPhase; detail?: string; sentAt: string; }

const PHASES: ReadonlySet<AiSessionPhase> = new Set([
  "discovering", "credentials", "schema", "proposing", "applying", "synced", "failed", "aborted"
]);

export function parseAiSessionStart(message: Record<string, unknown>): AiSessionStartCommand {
  return { sessionId: str(message.sessionId, "sessionId"), ...optStr(message.sentAt, "sentAt") };
}

export function parseToolInvoke(message: Record<string, unknown>): ToolInvokeCommand {
  const base: ToolInvokeCommand = {
    sessionId: str(message.sessionId, "sessionId"),
    invocationId: str(message.invocationId, "invocationId"),
    name: str(message.name, "name"),
    ...optStr(message.sentAt, "sentAt")
  };
  if (message.input !== undefined) base.input = message.input;
  return base;
}

export function parseMappingDecision(message: Record<string, unknown>): MappingDecisionCommand {
  const decision = str(message.decision, "decision");
  if (decision !== "approve" && decision !== "reject") {
    throw new ProtocolParseError(`decision must be approve or reject, got ${decision}`);
  }
  const base: MappingDecisionCommand = { sessionId: str(message.sessionId, "sessionId"), decision, ...optStr(message.sentAt, "sentAt") };
  if (message.editedMapping !== undefined) {
    if (typeof message.editedMapping !== "object" || message.editedMapping === null) {
      throw new ProtocolParseError("editedMapping must be an object");
    }
    base.editedMapping = message.editedMapping as MappingConfig;
  }
  return base;
}

export function parseAiSessionAbort(message: Record<string, unknown>): AiSessionAbortCommand {
  return { sessionId: str(message.sessionId, "sessionId"), reason: str(message.reason, "reason"), ...optStr(message.sentAt, "sentAt") };
}

export function buildAiCatalogMessage(
  input: { sessionId: string; catalogVersion: string; tools: ToolDescriptor[] },
  sentAt = new Date().toISOString()
): AiCatalogMessage {
  return { type: "ai.catalog", sessionId: input.sessionId, catalogVersion: input.catalogVersion, tools: input.tools, sentAt };
}

export function buildToolResultMessage(
  input: { sessionId: string; invocationId: string; ok: boolean; payload?: unknown; errorCode?: string },
  sentAt = new Date().toISOString()
): ToolResultMessage {
  const msg: ToolResultMessage = { type: "tool.result", sessionId: input.sessionId, invocationId: input.invocationId, ok: input.ok, sentAt };
  if (input.payload !== undefined) msg.payload = input.payload;
  if (input.errorCode !== undefined) msg.errorCode = input.errorCode;
  return msg;
}

export function buildAuditEventMessage(
  input: { sessionId: string; seq: number; kind: string; tool?: string; summary: string; detail?: unknown },
  at = new Date().toISOString()
): AuditEventMessage {
  const msg: AuditEventMessage = { type: "audit.event", sessionId: input.sessionId, seq: input.seq, at, kind: input.kind, summary: input.summary };
  if (input.tool !== undefined) msg.tool = input.tool;
  if (input.detail !== undefined) msg.detail = input.detail;
  return msg;
}

export function buildMappingProposedMessage(
  input: { sessionId: string; mapping: ValidatedMappingConfig; rationale: string; previewRows: unknown[] },
  sentAt = new Date().toISOString()
): MappingProposedMessage {
  return { type: "mapping.proposed", sessionId: input.sessionId, mapping: input.mapping, rationale: input.rationale, previewRows: input.previewRows, sentAt };
}

export function buildAiSessionStateMessage(
  input: { sessionId: string; phase: AiSessionPhase; detail?: string },
  sentAt = new Date().toISOString()
): AiSessionStateMessage {
  if (!PHASES.has(input.phase)) throw new ProtocolParseError(`invalid phase: ${input.phase}`);
  const msg: AiSessionStateMessage = { type: "ai.session.state", sessionId: input.sessionId, phase: input.phase, sentAt };
  if (input.detail !== undefined) msg.detail = input.detail;
  return msg;
}

function str(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProtocolParseError(`${field} must be a non-empty string`);
  }
  return value;
}

function optStr(value: unknown, field: string): { sentAt?: string } {
  if (value === undefined) return {};
  return { sentAt: str(value, field) };
}
```

- [ ] **Run test** — `npx vitest run tests/ai-session/ai-protocol.test.ts` → **PASS**.

- [ ] **Commit** — `git add src/ai-session/ai-protocol.ts tests/ai-session/ai-protocol.test.ts && git commit -m "feat(ai-session): envelopes WS do contrato de tool-calling"`

---

## Tarefa 10 — Catálogo de ferramentas (`tool-catalog.ts`)

- [ ] **Write failing test** — `tests/ai-session/tool-catalog.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildToolCatalog, CATALOG_VERSION, TOOL_NAMES, toolNameToAdminCommand } from "../../src/ai-session/tool-catalog.js";

describe("tool-catalog", () => {
  it("declara exatamente as 14 ferramentas canônicas", () => {
    expect([...TOOL_NAMES].sort()).toEqual([
      "fs.readConfigFile",
      "probe.connections",
      "probe.engines",
      "probe.network",
      "probe.odbc_dsns",
      "probe.processes",
      "probe.scan_config_dirs",
      "probe.test_connection",
      "registry.readKey",
      "schema.describeTable",
      "schema.listForeignKeys",
      "schema.listTables",
      "schema.sampleRows",
      "sql.runReadOnlySelect"
    ]);
  });

  it("buildToolCatalog devolve um ToolDescriptor por ferramenta", () => {
    const tools = buildToolCatalog();
    expect(tools).toHaveLength(14);
    for (const tool of tools) {
      expect(tool.name).toBeTypeOf("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeTypeOf("object");
      expect(tool.outputSchema).toBeTypeOf("object");
    }
  });

  it("CATALOG_VERSION é string não vazia", () => {
    expect(CATALOG_VERSION.length).toBeGreaterThan(0);
  });

  it("toolNameToAdminCommand mapeia para AdminCommand", () => {
    expect(toolNameToAdminCommand("schema.listTables")).toBe("schema.listTables");
    expect(toolNameToAdminCommand("sql.runReadOnlySelect")).toBe("sql.runReadOnlySelect");
    expect(toolNameToAdminCommand("desconhecida")).toBeUndefined();
  });
});
```

- [ ] **Run test** — `npx vitest run tests/ai-session/tool-catalog.test.ts` → **FAIL**.

- [ ] **Implementação mínima** — `src/ai-session/tool-catalog.ts`:

```ts
import type { AdminCommand } from "../transport/protocol.js";
import type { ToolDescriptor } from "./ai-protocol.js";

export const CATALOG_VERSION = "1";

interface ToolSpec {
  name: string;
  command: AdminCommand;
  description: string;
  inputSchema: object;
  outputSchema: object;
}

const OBJECT = { type: "object" } as const;
const ARRAY = { type: "array" } as const;

const SPECS: ToolSpec[] = [
  { name: "probe.engines", command: "probe.engines", description: "Lista engines de banco instalados na máquina.", inputSchema: OBJECT, outputSchema: { type: "object", properties: { engines: ARRAY } } },
  { name: "probe.odbc_dsns", command: "probe.odbc_dsns", description: "Lista DSNs ODBC configurados.", inputSchema: OBJECT, outputSchema: { type: "object", properties: { dsns: ARRAY } } },
  { name: "probe.processes", command: "probe.processes", description: "Lista processos em execução (pid/nome/caminho).", inputSchema: OBJECT, outputSchema: { type: "object", properties: { processes: ARRAY } } },
  { name: "probe.connections", command: "probe.connections", description: "Lista conexões TCP em portas de banco conhecidas.", inputSchema: OBJECT, outputSchema: { type: "object", properties: { connections: ARRAY } } },
  { name: "probe.network", command: "probe.network", description: "Testa alcançabilidade de host:porta.", inputSchema: { type: "object", required: ["host", "port"], properties: { host: { type: "string" }, port: { type: "integer" }, timeoutMs: { type: "integer" } } }, outputSchema: OBJECT },
  { name: "probe.scan_config_dirs", command: "probe.scan_config_dirs", description: "Varre diretórios por arquivos de config (deny-list + limites).", inputSchema: { type: "object", required: ["roots"], properties: { roots: ARRAY } }, outputSchema: OBJECT },
  { name: "fs.readConfigFile", command: "fs.readConfigFile", description: "Lê um arquivo de config sob deny-list; conteúdo cru só local.", inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } }, outputSchema: OBJECT },
  { name: "registry.readKey", command: "registry.readKey", description: "Lê uma chave do registro Windows (somente leitura).", inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } }, outputSchema: OBJECT },
  { name: "probe.test_connection", command: "probe.test_connection", description: "Testa uma credencial candidata sem persistir.", inputSchema: { type: "object", required: ["driver"], properties: { driver: { type: "string" } } }, outputSchema: OBJECT },
  { name: "schema.listTables", command: "schema.listTables", description: "Lista as tabelas do banco conectado.", inputSchema: OBJECT, outputSchema: { type: "object", properties: { tables: ARRAY } } },
  { name: "schema.describeTable", command: "schema.describeTable", description: "Colunas e tipos de uma tabela.", inputSchema: { type: "object", required: ["table"], properties: { table: { type: "string" } } }, outputSchema: { type: "object", properties: { columns: ARRAY } } },
  { name: "schema.listForeignKeys", command: "schema.listForeignKeys", description: "Foreign keys (liga produtos a tabelas auxiliares).", inputSchema: { type: "object", properties: { table: { type: "string" } } }, outputSchema: { type: "object", properties: { foreignKeys: ARRAY } } },
  { name: "schema.sampleRows", command: "schema.sampleRows", description: "Amostra de N linhas de uma tabela (LIMIT pequeno).", inputSchema: { type: "object", required: ["table"], properties: { table: { type: "string" }, limit: { type: "integer" } } }, outputSchema: { type: "object", properties: { rows: ARRAY } } },
  { name: "sql.runReadOnlySelect", command: "sql.runReadOnlySelect", description: "Executa um SELECT validado (rejeita escrita, LIMIT forçado).", inputSchema: { type: "object", required: ["sql"], properties: { sql: { type: "string" }, limit: { type: "integer" } } }, outputSchema: { type: "object", properties: { rows: ARRAY } } }
];

export const TOOL_NAMES: ReadonlySet<string> = new Set(SPECS.map((spec) => spec.name));

const NAME_TO_COMMAND = new Map<string, AdminCommand>(SPECS.map((spec) => [spec.name, spec.command]));

export function toolNameToAdminCommand(name: string): AdminCommand | undefined {
  return NAME_TO_COMMAND.get(name);
}

export function buildToolCatalog(): ToolDescriptor[] {
  return SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema
  }));
}
```

- [ ] **Run test** — `npx vitest run tests/ai-session/tool-catalog.test.ts` → **PASS**.

- [ ] **Commit** — `git add src/ai-session/tool-catalog.ts tests/ai-session/tool-catalog.test.ts && git commit -m "feat(ai-session): catálogo das 14 ferramentas read-only"`

---

## Tarefa 11 — `AiSession`: start → catalog, invoke → result + audit (com redação)

- [ ] **Write failing test** — `tests/ai-session/ai-session.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { AiSession, type AiSessionEmit, type AiSessionDeps } from "../../src/ai-session/ai-session.js";
import { buildAdminSuccessResponseMessage, buildAdminErrorResponseMessage } from "../../src/transport/protocol.js";
import type { ValidatedMappingConfig } from "../../src/mapping/types.js";

const SECRET = "super-secret-pw";

function collector() {
  const sent: any[] = [];
  const emit: AiSessionEmit = (msg) => { sent.push(msg); };
  return { sent, emit };
}

function depsWith(over: Partial<AiSessionDeps> = {}): AiSessionDeps {
  return {
    handleAdminRequest: vi.fn(async (req) =>
      buildAdminSuccessResponseMessage({ requestId: req.requestId, command: req.command, payload: { tables: ["produtos"] } })
    ),
    secrets: () => [SECRET],
    applyApproval: vi.fn(async () => undefined),
    now: () => "2026-06-03T00:00:00.000Z",
    ...over
  };
}

const mapping: ValidatedMappingConfig = {
  mappingVersion: "v1", syncMode: "snapshot", pollIntervalMs: 60000, batchSize: 500,
  snapshotQuery: "SELECT 1", snapshotPageSize: 500, fields: { sourceProductCode: "codigo", name: "nome" }
};

describe("AiSession", () => {
  it("ao start emite ai.catalog e ai.session.state discovering", async () => {
    const { sent, emit } = collector();
    const session = new AiSession({ sessionId: "s1", emit, deps: depsWith() });
    await session.start();
    const types = sent.map((m) => m.type);
    expect(types).toContain("ai.catalog");
    expect(types).toContain("ai.session.state");
    expect(sent.find((m) => m.type === "ai.catalog").tools).toHaveLength(14);
  });

  it("tool.invoke emite tool.result e audit.event com seq incremental", async () => {
    const { sent, emit } = collector();
    const session = new AiSession({ sessionId: "s1", emit, deps: depsWith() });
    await session.start();
    await session.invokeTool({ sessionId: "s1", invocationId: "i1", name: "schema.listTables", input: {} });
    const result = sent.find((m) => m.type === "tool.result");
    expect(result).toMatchObject({ invocationId: "i1", ok: true });
    const audits = sent.filter((m) => m.type === "audit.event").map((m) => m.seq);
    expect(audits).toEqual([...audits].sort((a, b) => a - b));
    expect(new Set(audits).size).toBe(audits.length);
  });

  it("rejeita ferramenta fora do catálogo com errorCode INVALID_INPUT", async () => {
    const { sent, emit } = collector();
    const session = new AiSession({ sessionId: "s1", emit, deps: depsWith() });
    await session.start();
    await session.invokeTool({ sessionId: "s1", invocationId: "ix", name: "fs.writeFile", input: {} });
    const result = sent.find((m) => m.type === "tool.result" && m.invocationId === "ix");
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("INVALID_INPUT");
  });

  it("REDAÇÃO: segredo nunca sai cru em tool.result nem audit.event", async () => {
    const deps = depsWith({
      handleAdminRequest: vi.fn(async (req) =>
        buildAdminSuccessResponseMessage({ requestId: req.requestId, command: req.command, payload: { content: `pwd=${SECRET}`, password: SECRET } })
      )
    });
    const { sent, emit } = collector();
    const session = new AiSession({ sessionId: "s1", emit, deps });
    await session.start();
    await session.invokeTool({ sessionId: "s1", invocationId: "i1", name: "fs.readConfigFile", input: { path: "C:\\x.ini" } });
    const serialized = JSON.stringify(sent);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain("[REDACTED]");
  });

  it("ignora invocationId repetido (idempotência)", async () => {
    const deps = depsWith();
    const { sent, emit } = collector();
    const session = new AiSession({ sessionId: "s1", emit, deps });
    await session.start();
    await session.invokeTool({ sessionId: "s1", invocationId: "i1", name: "schema.listTables", input: {} });
    await session.invokeTool({ sessionId: "s1", invocationId: "i1", name: "schema.listTables", input: {} });
    expect(sent.filter((m) => m.type === "tool.result" && m.invocationId === "i1")).toHaveLength(1);
    expect(deps.handleAdminRequest).toHaveBeenCalledTimes(1);
  });

  it("abort emite ai.session.state aborted e aborta o signal", async () => {
    const { sent, emit } = collector();
    const session = new AiSession({ sessionId: "s1", emit, deps: depsWith() });
    await session.start();
    session.abort("user");
    const state = sent.filter((m) => m.type === "ai.session.state").pop();
    expect(state.phase).toBe("aborted");
    expect(session.signal.aborted).toBe(true);
  });

  it("approve chama applyApproval com mapping validado e transiciona para synced", async () => {
    const deps = depsWith();
    const { sent, emit } = collector();
    const session = new AiSession({ sessionId: "s1", emit, deps });
    await session.start();
    session.setProposedMapping(mapping);
    await session.handleDecision({ sessionId: "s1", decision: "approve" });
    expect(deps.applyApproval).toHaveBeenCalledWith(mapping);
    const state = sent.filter((m) => m.type === "ai.session.state").pop();
    expect(state.phase).toBe("synced");
  });

  it("reject transiciona para proposing sem aplicar", async () => {
    const deps = depsWith();
    const { sent, emit } = collector();
    const session = new AiSession({ sessionId: "s1", emit, deps });
    await session.start();
    session.setProposedMapping(mapping);
    await session.handleDecision({ sessionId: "s1", decision: "reject" });
    expect(deps.applyApproval).not.toHaveBeenCalled();
    const state = sent.filter((m) => m.type === "ai.session.state").pop();
    expect(state.phase).toBe("proposing");
  });

  it("propõe via proposeMapping com previewRows redigidas", async () => {
    const { sent, emit } = collector();
    const session = new AiSession({ sessionId: "s1", emit, deps: depsWith() });
    await session.start();
    session.proposeMapping({ mapping, rationale: "join", previewRows: [{ codigo: "P1", password: SECRET }] });
    const proposed = sent.find((m) => m.type === "mapping.proposed");
    expect(JSON.stringify(proposed)).not.toContain(SECRET);
    expect(proposed.mapping.mappingVersion).toBe("v1");
  });
});
```

- [ ] **Run test** — `npx vitest run tests/ai-session/ai-session.test.ts` → **FAIL**.

- [ ] **Implementação mínima** — `src/ai-session/ai-session.ts`:

```ts
import { buildAdminRequestMessage, type AdminResponseMessage } from "../transport/protocol.js";
import { redactValue } from "../logging/redact.js";
import { validateMappingConfig } from "../mapping/validate.js";
import type { ValidatedMappingConfig, MappingConfig } from "../mapping/types.js";
import {
  buildAiCatalogMessage, buildToolResultMessage, buildAuditEventMessage,
  buildMappingProposedMessage, buildAiSessionStateMessage,
  type AiSessionPhase, type ToolInvokeCommand, type MappingDecisionCommand,
  type AiCatalogMessage, type ToolResultMessage, type AuditEventMessage,
  type MappingProposedMessage, type AiSessionStateMessage
} from "./ai-protocol.js";
import { buildToolCatalog, CATALOG_VERSION, toolNameToAdminCommand } from "./tool-catalog.js";

export type AiSessionOutboundMessage =
  | AiCatalogMessage | ToolResultMessage | AuditEventMessage
  | MappingProposedMessage | AiSessionStateMessage;

export type AiSessionEmit = (message: AiSessionOutboundMessage) => void;

export interface AiSessionDeps {
  handleAdminRequest: (req: ReturnType<typeof buildAdminRequestMessage> & { input?: unknown }) => Promise<AdminResponseMessage>;
  secrets: () => readonly string[];
  applyApproval: (mapping: ValidatedMappingConfig) => Promise<void>;
  now: () => string;
}

export interface AiSessionOptions {
  sessionId: string;
  emit: AiSessionEmit;
  deps: AiSessionDeps;
}

export class AiSession {
  public readonly sessionId: string;
  private readonly emit: AiSessionEmit;
  private readonly deps: AiSessionDeps;
  private readonly controller = new AbortController();
  private readonly seenInvocations = new Set<string>();
  private seq = 0;
  private proposedMapping?: ValidatedMappingConfig;

  public constructor(options: AiSessionOptions) {
    this.sessionId = options.sessionId;
    this.emit = options.emit;
    this.deps = options.deps;
  }

  public get signal(): AbortSignal {
    return this.controller.signal;
  }

  public async start(): Promise<void> {
    this.emit(buildAiCatalogMessage(
      { sessionId: this.sessionId, catalogVersion: CATALOG_VERSION, tools: buildToolCatalog() },
      this.deps.now()
    ));
    this.transition("discovering");
  }

  public async invokeTool(command: ToolInvokeCommand): Promise<void> {
    if (this.controller.signal.aborted) return;
    if (this.seenInvocations.has(command.invocationId)) return;
    this.seenInvocations.add(command.invocationId);

    const secrets = this.deps.secrets();
    this.audit({ kind: "tool.invoke", tool: command.name, summary: `invoca ${command.name}`, detail: redactValue(command.input, secrets) });

    const adminCommand = toolNameToAdminCommand(command.name);
    if (!adminCommand) {
      this.emit(buildToolResultMessage(
        { sessionId: this.sessionId, invocationId: command.invocationId, ok: false, errorCode: "INVALID_INPUT" },
        this.deps.now()
      ));
      this.audit({ kind: "tool.result", tool: command.name, summary: `ferramenta fora do catálogo: ${command.name}` });
      return;
    }

    const req = { ...buildAdminRequestMessage({ requestId: command.invocationId, command: adminCommand }, this.deps.now()), input: command.input };
    const response = await this.deps.handleAdminRequest(req);

    if (response.ok) {
      const safePayload = redactValue(response.payload, secrets);
      this.emit(buildToolResultMessage(
        { sessionId: this.sessionId, invocationId: command.invocationId, ok: true, payload: safePayload },
        this.deps.now()
      ));
      this.audit({ kind: "tool.result", tool: command.name, summary: `${command.name} ok`, detail: safePayload });
    } else {
      this.emit(buildToolResultMessage(
        { sessionId: this.sessionId, invocationId: command.invocationId, ok: false, errorCode: response.error.errorCode },
        this.deps.now()
      ));
      this.audit({ kind: "tool.result", tool: command.name, summary: `${command.name} falhou: ${response.error.errorCode}` });
    }
  }

  public proposeMapping(input: { mapping: ValidatedMappingConfig; rationale: string; previewRows: unknown[] }): void {
    this.proposedMapping = input.mapping;
    const safeRows = redactValue(input.previewRows, this.deps.secrets()) as unknown[];
    this.emit(buildMappingProposedMessage(
      { sessionId: this.sessionId, mapping: input.mapping, rationale: input.rationale, previewRows: safeRows },
      this.deps.now()
    ));
    this.transition("proposing");
  }

  public setProposedMapping(mapping: ValidatedMappingConfig): void {
    this.proposedMapping = mapping;
  }

  public async handleDecision(command: MappingDecisionCommand): Promise<void> {
    if (this.controller.signal.aborted) return;
    if (command.decision === "reject") {
      this.audit({ kind: "mapping.decision", summary: "mapping rejeitado" });
      this.transition("proposing");
      return;
    }
    const candidate: MappingConfig = command.editedMapping ?? (this.proposedMapping as MappingConfig | undefined) ?? {};
    const validated = validateMappingConfig(candidate);
    this.transition("applying");
    await this.deps.applyApproval(validated);
    this.audit({ kind: "mapping.decision", summary: "mapping aprovado e aplicado" });
    this.transition("synced");
  }

  public abort(reason: string): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    this.audit({ kind: "ai.session.abort", summary: `sessão abortada: ${reason}` });
    this.transition("aborted", reason);
  }

  public fail(detail: string): void {
    this.transition("failed", detail);
  }

  private transition(phase: AiSessionPhase, detail?: string): void {
    this.emit(buildAiSessionStateMessage({ sessionId: this.sessionId, phase, ...(detail ? { detail } : {}) }, this.deps.now()));
  }

  private audit(input: { kind: string; tool?: string; summary: string; detail?: unknown }): void {
    this.seq += 1;
    this.emit(buildAuditEventMessage(
      { sessionId: this.sessionId, seq: this.seq, kind: input.kind, ...(input.tool ? { tool: input.tool } : {}), summary: input.summary, ...(input.detail !== undefined ? { detail: input.detail } : {}) },
      this.deps.now()
    ));
  }
}
```

- [ ] **Run test** — `npx vitest run tests/ai-session/ai-session.test.ts` → **PASS**.

- [ ] **Commit** — `git add src/ai-session/ai-session.ts tests/ai-session/ai-session.test.ts && git commit -m "feat(ai-session): sessão de IA com redação na borda e idempotência"`

---

## Tarefa 12 — Registrar rotas de extensão WS para os 4 comandos da sessão

- [ ] **Write failing test** — `tests/transport/ai-session-routes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  parseServerMessageEnvelope, dispatchExtensionMessage, isDocumentedExtensionMessageType
} from "../../src/transport/server-message-router.js";
import "../../src/transport/ai-session-routes.js";
import {
  AI_SESSION_START_TYPE, TOOL_INVOKE_TYPE, MAPPING_DECISION_TYPE, AI_SESSION_ABORT_TYPE
} from "../../src/ai-session/ai-protocol.js";

function envelope(payload: object) {
  const raw = Buffer.from(JSON.stringify(payload));
  const parsed = parseServerMessageEnvelope(raw);
  if (parsed.classification === "malformed") throw parsed.error;
  return { env: parsed.envelope, raw };
}

describe("ai-session-routes", () => {
  it("classifica os 4 tipos como extension documentado", () => {
    for (const t of [AI_SESSION_START_TYPE, TOOL_INVOKE_TYPE, MAPPING_DECISION_TYPE, AI_SESSION_ABORT_TYPE]) {
      expect(isDocumentedExtensionMessageType(t)).toBe(true);
    }
  });

  it("ai.session.start despacha aiSessionStart", () => {
    const { env, raw } = envelope({ type: AI_SESSION_START_TYPE, sessionId: "s1" });
    const r = dispatchExtensionMessage(env, raw);
    expect(r.kind).toBe("aiSessionStart");
  });

  it("tool.invoke despacha aiToolInvoke", () => {
    const { env, raw } = envelope({ type: TOOL_INVOKE_TYPE, sessionId: "s1", invocationId: "i1", name: "schema.listTables", input: {} });
    const r = dispatchExtensionMessage(env, raw);
    expect(r.kind).toBe("aiToolInvoke");
  });

  it("mapping.decision malformado vira malformed", () => {
    const { env, raw } = envelope({ type: MAPPING_DECISION_TYPE, sessionId: "s1", decision: "talvez" });
    const r = dispatchExtensionMessage(env, raw);
    expect(r.kind).toBe("malformed");
  });

  it("ai.session.abort despacha aiSessionAbort", () => {
    const { env, raw } = envelope({ type: AI_SESSION_ABORT_TYPE, sessionId: "s1", reason: "user" });
    const r = dispatchExtensionMessage(env, raw);
    expect(r.kind).toBe("aiSessionAbort");
  });
});
```

- [ ] **Run test** — `npx vitest run tests/transport/ai-session-routes.test.ts` → **FAIL**.

- [ ] **Implementação mínima** — primeiro amplie o union `ExtensionRouteDispatchResult` e o set `DOCUMENTED_EXTENSION_MESSAGE_TYPES` em `src/transport/server-message-router.ts`:

```ts
import {
  AI_SESSION_START_TYPE, TOOL_INVOKE_TYPE, MAPPING_DECISION_TYPE, AI_SESSION_ABORT_TYPE,
  type AiSessionStartCommand, type ToolInvokeCommand, type MappingDecisionCommand, type AiSessionAbortCommand
} from "../ai-session/ai-protocol.js";
```

```ts
export const DOCUMENTED_EXTENSION_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "schema.tables.list",
  "catalog.mapping.preview",
  FILE_DISCOVERY_SCAN_COMMAND_TYPE,
  CONNECTOR_SETUP_CONFIG_COMMAND_TYPE,
  AI_SESSION_START_TYPE,
  TOOL_INVOKE_TYPE,
  MAPPING_DECISION_TYPE,
  AI_SESSION_ABORT_TYPE
]);
```

```ts
export type ExtensionRouteDispatchResult =
  | { kind: "handled" }
  | { kind: "malformed"; error: Error }
  | { kind: "schemaDiscoveryRequest"; request: Extract<SchemaDiscoveryRequest, { responseFormat: "legacy" }> }
  | { kind: "catalogMappingPreviewStub"; correlationId: string }
  | { kind: "fileDiscoveryScanRequest"; correlationId: string; rootPath?: string }
  | { kind: "setupConfigRequest"; request: import("./connector-setup-ws.js").ConnectorSetupConfigCommand }
  | { kind: "aiSessionStart"; command: AiSessionStartCommand }
  | { kind: "aiToolInvoke"; command: ToolInvokeCommand }
  | { kind: "aiMappingDecision"; command: MappingDecisionCommand }
  | { kind: "aiSessionAbort"; command: AiSessionAbortCommand };
```

Crie `src/transport/ai-session-routes.ts` (registra as rotas; importado por efeito colateral):

```ts
import { ProtocolParseError } from "./protocol.js";
import { registerExtensionRoute, type ExtensionRouteDispatchResult } from "./server-message-router.js";
import {
  AI_SESSION_START_TYPE, TOOL_INVOKE_TYPE, MAPPING_DECISION_TYPE, AI_SESSION_ABORT_TYPE,
  parseAiSessionStart, parseToolInvoke, parseMappingDecision, parseAiSessionAbort
} from "../ai-session/ai-protocol.js";

function asRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") return JSON.parse(raw) as Record<string, unknown>;
  if (Buffer.isBuffer(raw)) return JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  if (Array.isArray(raw)) return JSON.parse(Buffer.concat(raw as Buffer[]).toString("utf8")) as Record<string, unknown>;
  if (raw instanceof ArrayBuffer) return JSON.parse(Buffer.from(new Uint8Array(raw)).toString("utf8")) as Record<string, unknown>;
  return JSON.parse(Buffer.from(raw as Buffer).toString("utf8")) as Record<string, unknown>;
}

function guard(fn: () => ExtensionRouteDispatchResult, label: string): ExtensionRouteDispatchResult {
  try {
    return fn();
  } catch (error) {
    return { kind: "malformed", error: error instanceof Error ? error : new ProtocolParseError(`Invalid ${label} command`) };
  }
}

registerExtensionRoute(AI_SESSION_START_TYPE, (_env, raw) =>
  guard(() => ({ kind: "aiSessionStart", command: parseAiSessionStart(asRecord(raw)) }), AI_SESSION_START_TYPE)
);
registerExtensionRoute(TOOL_INVOKE_TYPE, (_env, raw) =>
  guard(() => ({ kind: "aiToolInvoke", command: parseToolInvoke(asRecord(raw)) }), TOOL_INVOKE_TYPE)
);
registerExtensionRoute(MAPPING_DECISION_TYPE, (_env, raw) =>
  guard(() => ({ kind: "aiMappingDecision", command: parseMappingDecision(asRecord(raw)) }), MAPPING_DECISION_TYPE)
);
registerExtensionRoute(AI_SESSION_ABORT_TYPE, (_env, raw) =>
  guard(() => ({ kind: "aiSessionAbort", command: parseAiSessionAbort(asRecord(raw)) }), AI_SESSION_ABORT_TYPE)
);
```

- [ ] **Run test** — `npx vitest run tests/transport/ai-session-routes.test.ts` → **PASS**.

- [ ] **Commit** — `git add src/transport/server-message-router.ts src/transport/ai-session-routes.ts tests/transport/ai-session-routes.test.ts && git commit -m "feat(transport): rotas de extensão para os comandos da sessão de IA"`

---

## Tarefa 13 — Ligar `AiSession` na `ConnectorRuntime` (deps reais + approve persiste)

- [ ] **Write failing test** — `tests/service/runtime-ai-session.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { buildRuntimeAdminDeps, buildAiSessionDeps } from "../../src/service/ai-session-wiring.js";
import type { SourceDatabaseAdapter } from "../../src/db/source-adapter.js";

function fakeAdapter(): SourceDatabaseAdapter {
  return {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    queryChanges: vi.fn(async () => []),
    querySnapshotPage: vi.fn(async () => []),
    listTables: vi.fn(async () => [{ name: "produtos" }]),
    listColumns: vi.fn(async () => [{ name: "codigo" }]),
    describeTable: vi.fn(async () => [{ name: "codigo", dataType: "varchar", nullable: false }]),
    listForeignKeys: vi.fn(async () => [{ fromTable: "desconto_produtos", fromColumn: "produto_id", toTable: "produtos", toColumn: "id" }]),
    sampleRows: vi.fn(async () => [{ codigo: "P1" }]),
    runReadOnlySelect: vi.fn(async () => [{ codigo: "P1" }])
  };
}

describe("ai-session-wiring", () => {
  it("buildRuntimeAdminDeps roteia schema.describeTable ao adapter", async () => {
    const adapter = fakeAdapter();
    const deps = buildRuntimeAdminDeps({
      getAdapter: async () => adapter,
      fs: { readFile: vi.fn(async () => "host=db"), listDir: vi.fn(async () => []), stat: vi.fn(async () => undefined), enumerateTop: vi.fn(async () => []) },
      registry: { listKeys: vi.fn(async () => []), readKey: vi.fn(async () => ({ Server: "db" })) },
      probeDeps: {} as never
    });
    const cols = await deps.schemaDescribeTable("produtos");
    expect(cols).toEqual([{ name: "codigo", dataType: "varchar", nullable: false }]);
    const rows = await deps.sqlRunReadOnlySelect({ sql: "SELECT codigo FROM produtos", limit: 10 });
    expect(rows).toEqual([{ codigo: "P1" }]);
    expect(adapter.runReadOnlySelect).toHaveBeenCalledWith({ sql: "SELECT codigo FROM produtos", limit: 10 });
  });

  it("buildAiSessionDeps.applyApproval persiste credenciais e ativa mapping", async () => {
    const writeDatabaseConfig = vi.fn(async () => undefined);
    const activateMapping = vi.fn(async () => undefined);
    const deps = buildAiSessionDeps({
      handleAdminRequest: vi.fn(async () => ({ type: "admin.response", requestId: "r", command: "schema.listTables", ok: true, payload: {}, sentAt: "t" } as never)),
      secrets: () => ["pw"],
      now: () => "t",
      writeDatabaseConfig,
      programData: undefined,
      currentDatabase: () => ({ driver: "mysql", host: "h", port: 3306, name: "db", user: "u", password: "pw" }),
      activateMapping
    });
    await deps.applyApproval({ mappingVersion: "v1", syncMode: "snapshot", pollIntervalMs: 60000, batchSize: 500, snapshotQuery: "SELECT 1", snapshotPageSize: 500, fields: { sourceProductCode: "codigo", name: "nome" } });
    expect(writeDatabaseConfig).toHaveBeenCalledTimes(1);
    expect(activateMapping).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Run test** — `npx vitest run tests/service/runtime-ai-session.test.ts` → **FAIL**.

- [ ] **Implementação mínima** — `src/service/ai-session-wiring.ts` (módulo puro, fácil de testar; a `ConnectorRuntime` o consome):

```ts
import type { AdminRouterDependencies } from "../discovery/admin-router.js";
import type { SourceDatabaseAdapter } from "../db/source-adapter.js";
import type { FileSystemReader } from "../discovery/fs-reader.js";
import type { RegistryReader } from "../db/registry-reader.js";
import { readConfigFile } from "../discovery/read-config-file.js";
import { readRegistryKey } from "../discovery/read-registry-key.js";
import type { AiSessionDeps } from "../ai-session/ai-session.js";
import type { AdminResponseMessage, AdminRequestMessage } from "../transport/protocol.js";
import type { DatabaseConfig } from "../config/types.js";
import type { ValidatedMappingConfig } from "../mapping/types.js";

type ProbeDeps = Pick<
  AdminRouterDependencies,
  "probeEngines" | "probeOdbcDsns" | "probeNetwork" | "probeTestConnection" |
  "probeProcesses" | "probeConnections" | "probeScanConfigDirs" | "schemaListTables"
>;

export interface RuntimeAdminDepsInput {
  getAdapter: () => Promise<SourceDatabaseAdapter>;
  fs: FileSystemReader;
  registry: RegistryReader;
  probeDeps: ProbeDeps;
}

export function buildRuntimeAdminDeps(input: RuntimeAdminDepsInput): AdminRouterDependencies {
  return {
    ...input.probeDeps,
    schemaDescribeTable: async (table) => (await input.getAdapter()).describeTable(table),
    schemaListForeignKeys: async (table) => (await input.getAdapter()).listForeignKeys(table),
    schemaSampleRows: async (table, limit) => (await input.getAdapter()).sampleRows(table, limit),
    sqlRunReadOnlySelect: async (sel) => (await input.getAdapter()).runReadOnlySelect(sel),
    fsReadConfigFile: async (file) => readConfigFile({ fs: input.fs }, file),
    registryReadKey: async (key) => readRegistryKey(input.registry, key)
  };
}

export interface AiSessionDepsInput {
  handleAdminRequest: (req: AdminRequestMessage) => Promise<AdminResponseMessage>;
  secrets: () => readonly string[];
  now: () => string;
  writeDatabaseConfig: (programData: string | undefined, database: DatabaseConfig) => Promise<void>;
  programData: string | undefined;
  currentDatabase: () => DatabaseConfig | undefined;
  activateMapping: (mapping: ValidatedMappingConfig) => Promise<void>;
}

export function buildAiSessionDeps(input: AiSessionDepsInput): AiSessionDeps {
  return {
    handleAdminRequest: (req) => input.handleAdminRequest(req as AdminRequestMessage),
    secrets: input.secrets,
    now: input.now,
    applyApproval: async (mapping) => {
      const database = input.currentDatabase();
      if (database) {
        await input.writeDatabaseConfig(input.programData, database);
      }
      await input.activateMapping(mapping);
    }
  };
}
```

> Nota: `AdminRouterDependencies` é `Pick`-ada via `ProbeDeps` para reusar as factories de probe já construídas pela `ConnectorRuntime.buildAdminRouterDeps()`; isto evita reimplementar as 8 probes.

- [ ] **Run test** — `npx vitest run tests/service/runtime-ai-session.test.ts` → **PASS**.

- [ ] **Commit** — `git add src/service/ai-session-wiring.ts tests/service/runtime-ai-session.test.ts && git commit -m "feat(service): wiring de deps do admin-router e da sessão de IA"`

---

## Tarefa 14 — Integrar o wiring na `ConnectorRuntime` e nos handlers de transporte

> Esta tarefa conecta os módulos já testados à `ConnectorRuntime`. O teste foca o comportamento observável: ao receber `aiSessionStart` o runtime cria a sessão e emite `ai.catalog`; ao receber `aiToolInvoke` emite `tool.result`.

- [ ] **Write failing test** — `tests/service/runtime-ai-session-flow.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { AiSessionManager } from "../../src/service/ai-session-manager.js";
import { buildAdminSuccessResponseMessage } from "../../src/transport/protocol.js";

describe("AiSessionManager", () => {
  function makeManager() {
    const sent: any[] = [];
    const manager = new AiSessionManager({
      emit: (msg) => sent.push(msg),
      buildDeps: () => ({
        handleAdminRequest: async (req) => buildAdminSuccessResponseMessage({ requestId: req.requestId, command: req.command, payload: { tables: ["produtos"] } }),
        secrets: () => [],
        now: () => "t",
        applyApproval: vi.fn(async () => undefined)
      })
    });
    return { sent, manager };
  }

  it("start cria sessão e emite ai.catalog", async () => {
    const { sent, manager } = makeManager();
    await manager.onStart({ sessionId: "s1" });
    expect(sent.some((m) => m.type === "ai.catalog")).toBe(true);
  });

  it("tool.invoke é roteado para a sessão correta", async () => {
    const { sent, manager } = makeManager();
    await manager.onStart({ sessionId: "s1" });
    await manager.onToolInvoke({ sessionId: "s1", invocationId: "i1", name: "schema.listTables", input: {} });
    expect(sent.some((m) => m.type === "tool.result" && m.invocationId === "i1")).toBe(true);
  });

  it("tool.invoke de sessão desconhecida é ignorado", async () => {
    const { sent, manager } = makeManager();
    await manager.onToolInvoke({ sessionId: "zzz", invocationId: "i1", name: "schema.listTables", input: {} });
    expect(sent.filter((m) => m.type === "tool.result")).toHaveLength(0);
  });

  it("abort encerra a sessão", async () => {
    const { sent, manager } = makeManager();
    await manager.onStart({ sessionId: "s1" });
    manager.onAbort({ sessionId: "s1", reason: "user" });
    const state = sent.filter((m) => m.type === "ai.session.state").pop();
    expect(state.phase).toBe("aborted");
  });
});
```

- [ ] **Run test** — `npx vitest run tests/service/runtime-ai-session-flow.test.ts` → **FAIL**.

- [ ] **Implementação mínima** — `src/service/ai-session-manager.ts`:

```ts
import { AiSession, type AiSessionDeps, type AiSessionEmit } from "../ai-session/ai-session.js";
import type {
  AiSessionStartCommand, ToolInvokeCommand, MappingDecisionCommand, AiSessionAbortCommand
} from "../ai-session/ai-protocol.js";

export interface AiSessionManagerOptions {
  emit: AiSessionEmit;
  buildDeps: (sessionId: string) => AiSessionDeps;
}

export class AiSessionManager {
  private readonly sessions = new Map<string, AiSession>();
  private readonly options: AiSessionManagerOptions;

  public constructor(options: AiSessionManagerOptions) {
    this.options = options;
  }

  public async onStart(command: AiSessionStartCommand): Promise<void> {
    const existing = this.sessions.get(command.sessionId);
    if (existing) return;
    const session = new AiSession({
      sessionId: command.sessionId,
      emit: this.options.emit,
      deps: this.options.buildDeps(command.sessionId)
    });
    this.sessions.set(command.sessionId, session);
    await session.start();
  }

  public async onToolInvoke(command: ToolInvokeCommand): Promise<void> {
    await this.sessions.get(command.sessionId)?.invokeTool(command);
  }

  public async onDecision(command: MappingDecisionCommand): Promise<void> {
    await this.sessions.get(command.sessionId)?.handleDecision(command);
  }

  public onAbort(command: AiSessionAbortCommand): void {
    const session = this.sessions.get(command.sessionId);
    if (!session) return;
    session.abort(command.reason);
    this.sessions.delete(command.sessionId);
  }
}
```

Em `src/service/runtime.ts`, instancie o manager e ligue os handlers de transporte. Adicione ao `RuntimeTransport` os eventos e ao `bindTransportEvents` o roteamento (espelhando o padrão de `setupConfigRequest`). O `emit` serializa via `transport.sendAiSessionMessage`. Como a interface de transporte e o `ws-client` já roteiam extension results pelo padrão existente, exponha um método `sendAiSessionMessage(message)` no transporte e os handlers:

```ts
// no RuntimeTransport interface:
  on(event: "aiSessionStart", listener: (command: import("../ai-session/ai-protocol.js").AiSessionStartCommand) => void): this;
  on(event: "aiToolInvoke", listener: (command: import("../ai-session/ai-protocol.js").ToolInvokeCommand) => void): this;
  on(event: "aiMappingDecision", listener: (command: import("../ai-session/ai-protocol.js").MappingDecisionCommand) => void): this;
  on(event: "aiSessionAbort", listener: (command: import("../ai-session/ai-protocol.js").AiSessionAbortCommand) => void): this;
  sendAiSessionMessage(message: import("../ai-session/ai-session.js").AiSessionOutboundMessage): void;
```

```ts
// em bindTransportEvents():
    const manager = new AiSessionManager({
      emit: (message) => this.transport.sendAiSessionMessage(message),
      buildDeps: () => buildAiSessionDeps({
        handleAdminRequest: (req) => handleAdminRequest(req, buildRuntimeAdminDeps({
          getAdapter: () => this.ensureAdapterConnected(),
          fs: nodeFileSystemReader,
          registry: createRegExeRegistryReader(),
          probeDeps: this.buildAdminRouterDeps()
        })),
        secrets: () => runtimeConfigSecrets(this.config),
        now: this.now,
        writeDatabaseConfig,
        programData: this.configuredProgramDataPath(),
        currentDatabase: () => this.config.database,
        activateMapping: (mapping) => this.activateMapping({
          connectorId: this.activeConnectorId ?? "ai-session",
          customerId: this.activeCustomerId ?? "ai-session",
          mapping
        })
      })
    });
    this.aiSessionManager = manager;
    this.transport.on("aiSessionStart", (c) => { void manager.onStart(c); });
    this.transport.on("aiToolInvoke", (c) => { void manager.onToolInvoke(c); });
    this.transport.on("aiMappingDecision", (c) => { void manager.onDecision(c); });
    this.transport.on("aiSessionAbort", (c) => { manager.onAbort(c); });
```

(Declare `private aiSessionManager?: AiSessionManager;` e os imports `AiSessionManager`, `buildAiSessionDeps`, `buildRuntimeAdminDeps`. O método `buildRuntimeAdminDeps` em wiring recebe `probeDeps: this.buildAdminRouterDeps()`, reusando as 8 probes já construídas — o spread `...input.probeDeps` cobre os 8 campos de probe + `schemaListTables`.)

> O `ws-client` deve mapear os 4 novos `ExtensionRouteDispatchResult.kind` (`aiSessionStart`/`aiToolInvoke`/`aiMappingDecision`/`aiSessionAbort`) para os respectivos `emit` de evento, espelhando como já trata `setupConfigRequest`. Verifique `src/transport/ws-client.ts` ao implementar; adicione os casos faltantes ali e `sendAiSessionMessage` que faz `this.send(JSON.stringify(message))` pelo mesmo caminho do `sendConnectorSetupConfigResult`.

- [ ] **Run test** — `npx vitest run tests/service/runtime-ai-session-flow.test.ts` → **PASS**. Em seguida rode a suíte de transporte/serviço para garantir que nada quebrou: `npx vitest run tests/transport tests/service`.

- [ ] **Commit** — `git add src/service/ai-session-manager.ts src/service/runtime.ts src/transport/ws-client.ts tests/service/runtime-ai-session-flow.test.ts && git commit -m "feat(service): integra AiSessionManager e handlers de transporte"`

---

## Tarefa 15 — Confirmar que `validate.ts`/`apply.ts` aceitam queries com JOIN

> Contrato 3 prevê confirmar (não estender) que SELECT com JOIN passa como SQL livre. Teste de regressão simples.

- [ ] **Write failing test** — `tests/mapping/join-query-mapping.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validateMappingConfig } from "../../src/mapping/validate.js";

const JOIN_SQL =
  "SELECT p.codigo, p.nome, dp.preco_final, fp.fabricante FROM produtos p " +
  "LEFT JOIN desconto_produtos dp ON dp.produto_id = p.id " +
  "LEFT JOIN fabricante_produtos fp ON fp.produto_id = p.id";

describe("validateMappingConfig com SELECT+JOIN", () => {
  it("aceita snapshotQuery com JOIN", () => {
    const m = validateMappingConfig({
      mappingVersion: "v1", syncMode: "snapshot", pollIntervalMs: 60000, batchSize: 500,
      snapshotQuery: JOIN_SQL, snapshotPageSize: 500,
      fields: { sourceProductCode: "codigo", name: "nome", price: "preco_final" }
    });
    expect(m.syncMode).toBe("snapshot");
    if (m.syncMode === "snapshot") expect(m.snapshotQuery).toContain("LEFT JOIN");
  });

  it("aceita incrementalQuery com JOIN", () => {
    const m = validateMappingConfig({
      mappingVersion: "v2", syncMode: "incremental", pollIntervalMs: 60000, batchSize: 500,
      incrementalQuery: `${JOIN_SQL} WHERE p.updated_at > ? ORDER BY p.updated_at LIMIT ?`,
      cursorField: "updated_at", cursorType: "timestamp",
      fields: { sourceProductCode: "codigo", name: "nome" }
    });
    expect(m.syncMode).toBe("incremental");
    if (m.syncMode === "incremental") expect(m.incrementalQuery).toContain("LEFT JOIN");
  });
});
```

- [ ] **Run test** — `npx vitest run tests/mapping/join-query-mapping.test.ts` → deve **PASSAR direto** (já suportado). Se passar, é confirmação do Contrato 3; nenhuma mudança de produção necessária. Se falhar, abra `src/mapping/validate.ts`/`apply.ts` e ajuste (não esperado).

- [ ] **Commit** — `git add tests/mapping/join-query-mapping.test.ts && git commit -m "test(mapping): confirma SELECT+JOIN como SQL livre no mapping"`

---

## Tarefa 16 — Suíte completa + integração

- [ ] **Run** — `npm test` (vitest run completo). Espera-se **todos verdes**; se algum adapter postgres/mariadb/sqlserver quebrar pela interface ampliada, adicione os 4 métodos lançando "not supported" nesses adapters:

```ts
// padrão para postgresql/mariadb/sqlserver-adapter.ts
public async describeTable(): Promise<DatabaseColumn[]> { throw notSupported("describeTable"); }
public async listForeignKeys(): Promise<ForeignKey[]> { throw notSupported("listForeignKeys"); }
public async sampleRows(): Promise<SourceRow[]> { throw notSupported("sampleRows"); }
public async runReadOnlySelect(): Promise<SourceRow[]> { throw notSupported("runReadOnlySelect"); }
// helper local:
function notSupported(op: string): Error { return new Error(`${op} is not supported for this driver`); }
```

(Importar `ForeignKey`/`RunReadOnlySelectInput`/`SourceRow` conforme necessário; ajustar testes desses adapters se eles assertam a interface completa.)

- [ ] **Run integração** — `docker compose -f docker-compose.test.yml up -d --wait && npx vitest run tests/integration/source-adapters.fixture.test.ts` — confirma que `describeTable`/`listForeignKeys`/`sampleRows`/`runReadOnlySelect` funcionam contra o MySQL real (estenda esse arquivo de fixture com 1 caso por método novo, usando as tabelas `produtos`/`desconto_produtos`/`fabricante_produtos` do init). Ao final: `docker compose -f docker-compose.test.yml down`.

- [ ] **Commit** — `git add -A && git commit -m "test: cobre adapters não suportados e integração da inspeção read-only"`

---

## Self-Review

Cobertura do escopo 1–9:

1. **Adapter read-only inspection** — Tarefas 2 (interface), 3 (mysql), 4 (firebird), 16 (outros lançam "not supported", declarado explicitamente). ✅
2. **Validador de SELECT** (`src/db/readonly-sql.ts`) — Tarefa 1, com tabela abrangente (escrita/DDL/multi-statement/comentário-escondendo/CALL-EXEC/LIMIT). ✅
3. **`fs.readConfigFile` + `registry.readKey`** reusando deny-list/limites — Tarefas 5 e 6. ✅
4. **Catálogo `ToolDescriptor[]` + catalogVersion** e despacho via `handleAdminRequest`/`AdminRouterDependencies` com `Validated<T>` — Tarefas 7, 8, 10. ✅
5. **Protocolo**: 9 envelopes + build*/parse* + rotas via `registerExtensionRoute` para os 4 comandos servidor→agente — Tarefas 9 e 12. ✅
6. **Sessão de IA**: start→catalog, invoke→handleAdminRequest→tool.result+audit.event (seq incremental + redação via `redactValue`), AbortSignal, transições `ai.session.state` — Tarefas 11, 13, 14. ✅
7. **Aprovação**: `mapping.decision approve` → `validateMappingConfig` → `writeDatabaseConfig` + ativa mapping → `synced`; reject → `proposing` — Tarefas 11 (lógica), 13 (persistência), 14 (wiring). ✅
8. **Redação na borda** com teste explícito (segredo não sai cru em `tool.result`/`audit.event`/`mapping.proposed.previewRows`) — Tarefa 11. ✅
9. **Contrato**: roundtrip parse/serialize de cada envelope + correlação `invocationId` + ordenação `seq` — Tarefa 9 (roundtrip/correlação) e Tarefa 11 (seq incremental/idempotência). ✅

Ausência de placeholders: todos os steps de código trazem implementação completa; nenhum "TODO/TBD". Tipos referenciados existem no código atual (`redactValue`, `buildAdminErrorResponseMessage`, `buildAdminSuccessResponseMessage`, `writeDatabaseConfig`, `validateMappingConfig`, `SourceDatabaseAdapter`, `RegistryReader`, `FileSystemReader`, `DEFAULT_PATTERNS`, `ProtocolParseError`, `AdminCommand`) ou são criados em tarefas anteriores (`validateReadOnlySelect`, `ForeignKey`, `ToolDescriptor`, `AiSession`, `buildToolCatalog`).

Consistência de nomes: tipos de envelope e tool names seguem o Contrato Canônico exatamente; `AdminCommand` recebe os 6 comandos novos com os mesmos nomes das tools; `AiSessionPhase` cobre as 8 fases especificadas.
