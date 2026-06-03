# Plano de implementação — Provisionamento de usuário read-only (AGENTE)

> Spec / fonte da verdade: [`docs/superpowers/specs/2026-06-03-provisionamento-usuario-readonly-design.md`](../specs/2026-06-03-provisionamento-usuario-readonly-design.md)
> Escopo deste plano: **Contratos A e C** no repo `pharma-agent-v2` (agente). Os contratos B (neo) e UI (web) ficam em planos separados.

## For agentic workers

Este plano é executado por um agente em uma sessão isolada. Regras:

- **TDD estrito por tarefa:** (1) escreva o teste que falha com o CÓDIGO REAL abaixo; (2) rode `npx vitest run tests/<arquivo>` e CONFIRME o FAIL esperado (mensagem coerente, não erro de import/sintaxe); (3) implemente o mínimo com o CÓDIGO REAL abaixo; (4) rode `npx vitest run tests/<arquivo>` e CONFIRME o PASS; (5) commit.
- **Sem placeholders.** Todo bloco de código aqui é literal e completo — copie-o, não invente nomes.
- **Imports `.js`** sempre (TS ESM `NodeNext`). Tipos importados com `import type`.
- **Commits** em pt-br, conventional, subject-only, com o rodapé:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
- **Nunca commite no repo raiz** nem fora desta worktree. **Não faça push.**
- Antes de cada commit rode `npm test` (suíte inteira) e garanta verde; se algo não relacionado quebrar, pare e investigue (systematic-debugging) — não force o commit.
- **Nomes do CONTRATO CANÔNICO são imutáveis:** `propose_readonly_user`; `connector.provisionReadonlyUser` / `connector.provisionReadonlyUser.result`; `outcome` ∈ `provisioned|fallback_no_privilege|unsupported_engine|error`; `grantedScope:"all_tables"`; `errorCode` ∈ `auth|timeout|unreachable|syntax|unknown`; `readonlyProvisioning.status` ∈ `provisioned|fallback_discovered|not_attempted`. Não renomeie.

## Goal

Após o `probe.test_connection` validar a credencial **descoberta (admin)**, criar um usuário
somente-leitura fixo (`pharma_connector_ro`) com `GRANT SELECT` em todas as tabelas e passar a
usá-lo na inspeção e no sync. Essa é a **única** escrita do agente, isolada num comando admin
WS fora do catálogo do LLM, invocado só pelo neo após aprovação humana. A senha do RO é gerada
localmente (CSPRNG ≥24), nunca trafega/loga, e o config local passa a guardar a credencial RO +
metadados de provisionamento. Falha de privilégio / engine não suportado / erro → fallback para a
credencial descoberta (sessão não falha).

## Architecture

- **Sinal (no catálogo do LLM):** `propose_readonly_user` é uma tool de catálogo SEM comando
  admin associado. Hoje `AiSession.invokeTool` rejeita tools fora de `toolNameToAdminCommand`.
  Vamos tratar `propose_readonly_user` como um caso especial **local** dentro do `AiSession`:
  valida `username` contra `^[a-zA-Z][a-zA-Z0-9_]{2,62}$` e devolve `{ accepted, username, engine }`,
  **sem** tocar no banco. O engine corrente vem de uma nova dep `currentEngine()`.
- **Escrita (fora do catálogo, neo-only):** novo comando server `connector.provisionReadonlyUser`
  no protocolo core (igual ao `connector.bootstrap.dbConfig`), roteado pelo `ws-client` para um
  evento `provisionReadonlyUser` no runtime. O runtime orquestra: cria adapter admin → provisiona
  via `adapter.provisionReadonlyUser(...)` → valida RO com `SELECT 1` → troca a conexão ativa para
  o RO → persiste config (RO + `readonlyProvisioning`) → responde `...result`. Fallback/erro mantém
  ou reverte para a conexão descoberta.
- **Por engine:** novo método `provisionReadonlyUser(input)` na interface `SourceDatabaseAdapter`,
  implementado nos 5 adapters com statements FIXOS/parametrizados/idempotentes e detecção de
  privilégio insuficiente. Um módulo novo `src/db/provision-password.ts` gera a senha CSPRNG.
- **Config:** `writeReadonlyProvisioningConfig(...)` em `programdata-config.ts` grava `database`
  (RO ou descoberta) + bloco `readonlyProvisioning`, reaproveitando o merge `mode 0o600`.
- **Redação:** a senha gerada entra em `secrets` em toda construção de mensagem/erro/audit
  (`redactString`/`redactValue`), e nunca é incluída no `...result` nem em logs.

## Tech Stack

- TypeScript ESM (`NodeNext`), Node ≥20, imports `.js`.
- Vitest 3 (`npx vitest run tests/<arquivo>`; suíte: `npm test`).
- `node:crypto` (`randomBytes`) para a senha CSPRNG.
- Drivers existentes via factories injetadas (sem rede real nos testes — `connectionFactory`/`query` mockados com `vi.fn`).

## File Structure

Arquivos NOVOS:

| Caminho | Conteúdo |
|---|---|
| `src/db/provision-password.ts` | `generateReadonlyPassword()` CSPRNG ≥24 |
| `src/db/provision-types.ts` | tipos compartilhados: `ProvisionReadonlyUserInput/Result`, `ProvisionOutcome`, `PROVISION_NO_PRIVILEGE` |
| `tests/db/provision-password.test.ts` | testes da senha |
| `tests/db/mysql-provision.test.ts` | provisão MySQL |
| `tests/db/mariadb-provision.test.ts` | provisão MariaDB |
| `tests/db/postgresql-provision.test.ts` | provisão Postgres |
| `tests/db/sqlserver-provision.test.ts` | provisão SQL Server |
| `tests/db/firebird-provision.test.ts` | provisão Firebird |
| `tests/transport/provision-readonly-ws.test.ts` | protocolo do comando admin |
| `tests/config/programdata-readonly-provisioning.test.ts` | persistência do config |
| `tests/ai-session/ai-session-propose-readonly.test.ts` | sinal `propose_readonly_user` |
| `tests/service/runtime-provision-readonly.test.ts` | orquestração no runtime |

Arquivos EDITADOS:

| Caminho | Mudança |
|---|---|
| `src/db/source-adapter.ts` | método `provisionReadonlyUser` na interface |
| `src/db/{mysql,mariadb,postgresql,sqlserver,firebird}-adapter.ts` | implementação `provisionReadonlyUser` |
| `src/db/errors.ts` | `DatabaseOperation` ganha `"provision"` |
| `src/config/programdata-config.ts` | `writeReadonlyProvisioningConfig` + tipos |
| `src/transport/protocol.ts` | tipos/parse do comando + builders do result |
| `src/transport/server-message-router.ts` | `connector.provisionReadonlyUser` como core |
| `src/transport/ws-client.ts` | evento `provisionReadonlyUser` + `sendProvisionReadonlyUserResult` |
| `src/ai-session/tool-catalog.ts` | spec do sinal `propose_readonly_user` |
| `src/ai-session/ai-session.ts` | tratamento local do sinal + dep `currentEngine` |
| `src/service/ai-session-wiring.ts` | passa `currentEngine` |
| `src/service/runtime.ts` | dep `currentEngine`, evento `provisionReadonlyUser`, orquestração |

---

## Tarefa 1 — Senha CSPRNG local (`generateReadonlyPassword`)

### 1a. Teste que falha

Crie `tests/db/provision-password.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { generateReadonlyPassword } from "../../src/db/provision-password.js";

describe("generateReadonlyPassword", () => {
  it("gera senha com pelo menos 24 caracteres", () => {
    const pwd = generateReadonlyPassword();
    expect(pwd.length).toBeGreaterThanOrEqual(24);
  });

  it("usa apenas caracteres do alfabeto seguro (sem aspas, barra ou crase)", () => {
    for (let i = 0; i < 50; i += 1) {
      const pwd = generateReadonlyPassword();
      expect(pwd).toMatch(/^[A-Za-z0-9!#%*+\-_.]+$/);
    }
  });

  it("produz valores distintos a cada chamada (entropia)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      seen.add(generateReadonlyPassword());
    }
    expect(seen.size).toBe(100);
  });
});
```

Rode `npx vitest run tests/db/provision-password.test.ts` → FAIL (módulo inexistente).

### 1b. Implementação mínima

Crie `src/db/provision-password.ts`:

```ts
import { randomBytes } from "node:crypto";

// Alfabeto seguro: sem aspas simples/duplas, crase, barra e contrabarra,
// evitando qualquer interferência com quoting de identificadores/strings SQL.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#%*+-_.";
const DEFAULT_LENGTH = 32;

export function generateReadonlyPassword(length: number = DEFAULT_LENGTH): string {
  const target = Math.max(length, 24);
  const bytes = randomBytes(target);
  let out = "";
  for (let i = 0; i < target; i += 1) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}
```

Rode `npx vitest run tests/db/provision-password.test.ts` → PASS.

### 1c. Commit

`feat: gera senha CSPRNG local para usuário read-only`

---

## Tarefa 2 — Tipos compartilhados de provisão + extensão da interface

### 2a. Teste que falha

Crie `tests/db/mysql-provision.test.ts` (servirá de âncora; só o primeiro caso por enquanto):

```ts
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
```

Rode `npx vitest run tests/db/mysql-provision.test.ts` → FAIL (`provisionReadonlyUser` não existe).

### 2b. Implementação mínima

Crie `src/db/provision-types.ts`:

```ts
export type ProvisionOutcome =
  | "provisioned"
  | "fallback_no_privilege"
  | "unsupported_engine"
  | "error";

export interface ProvisionReadonlyUserInput {
  username: string;
  password: string;
}

export interface ProvisionReadonlyUserResult {
  outcome: Extract<ProvisionOutcome, "provisioned" | "fallback_no_privilege">;
  grantedScope: "all_tables";
}

// Erro interno que sinaliza privilégio insuficiente, mapeado por engine.
// O orquestrador converte em outcome "fallback_no_privilege".
export class NoPrivilegeError extends Error {
  public constructor(message = "no privilege to provision read-only user") {
    super(message);
    this.name = "NoPrivilegeError";
  }
}
```

Em `src/db/errors.ts`, adicione `"provision"` ao union `DatabaseOperation`:

```ts
export type DatabaseOperation = "connect" | "query" | "listTables" | "listColumns" | "close" | "provision";
```

Em `src/db/source-adapter.ts`, importe os tipos e adicione o método à interface (logo após `runReadOnlySelect`):

```ts
import type { ProvisionReadonlyUserInput, ProvisionReadonlyUserResult } from "./provision-types.js";
```

```ts
  runReadOnlySelect(input: RunReadOnlySelectInput): Promise<SourceRow[]>;
  provisionReadonlyUser(input: ProvisionReadonlyUserInput): Promise<ProvisionReadonlyUserResult>;
```

Em `src/db/mysql-adapter.ts`, importe e implemente (após `runReadOnlySelect`, antes de `requireConnection`):

```ts
import { NoPrivilegeError, type ProvisionReadonlyUserInput, type ProvisionReadonlyUserResult } from "./provision-types.js";
```

```ts
  public async provisionReadonlyUser(input: ProvisionReadonlyUserInput): Promise<ProvisionReadonlyUserResult> {
    const connection = this.requireConnection("provision");
    const user = quoteMysqlIdentifier(input.username);
    const db = quoteMysqlIdentifier(this.config.name);
    try {
      await connection.query(`CREATE USER IF NOT EXISTS ${user}@'%' IDENTIFIED BY ?`, [input.password]);
      await connection.query(`ALTER USER ${user}@'%' IDENTIFIED BY ?`, [input.password]);
      await connection.query(`GRANT SELECT ON ${db}.* TO ${user}@'%'`, []);
      await connection.query(`FLUSH PRIVILEGES`, []);
      return { outcome: "provisioned", grantedScope: "all_tables" };
    } catch (error) {
      if (isMysqlPrivilegeError(error)) {
        return { outcome: "fallback_no_privilege", grantedScope: "all_tables" };
      }
      throw normalizeDatabaseError({ driver: "mysql", operation: "provision", error, secrets: this.secrets });
    }
  }
```

E adicione, no rodapé do mesmo arquivo (junto às outras funções livres):

```ts
function isMysqlPrivilegeError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { errno?: unknown; code?: unknown }).errno ?? (error as { code?: unknown }).code;
  const numeric = typeof code === "number" ? code : Number(code);
  return numeric === 1044 || numeric === 1142;
}
```

> Nota: `NoPrivilegeError` é exportado para uso pelos engines que mapeiam privilégio por mensagem
> (Firebird) e mantém o contrato uniforme; MySQL detecta por código numérico (1044/1142) acima.

Rode `npx vitest run tests/db/mysql-provision.test.ts` → PASS.

### 2c. Commit

`feat: adiciona provisionReadonlyUser à interface e implementa no MySQL`

---

## Tarefa 3 — Detecção de privilégio insuficiente no MySQL

### 3a. Teste que falha

Adicione ao `tests/db/mysql-provision.test.ts`:

```ts
  it("retorna fallback_no_privilege quando o GRANT falha por 1044/1142", async () => {
    const connection: MySqlDriverConnection = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("GRANT SELECT")) {
          throw Object.assign(new Error("Access denied for user"), { errno: 1142 });
        }
        return [[], []];
      }),
      end: vi.fn(async () => undefined)
    };
    const adapter = new MySqlSourceAdapter({ config, connectionFactory: vi.fn(async () => connection) });
    await adapter.connect();

    const result = await adapter.provisionReadonlyUser({
      username: "pharma_connector_ro",
      password: "pwd-1234567890-abcdefghij"
    });

    expect(result.outcome).toBe("fallback_no_privilege");
  });

  it("propaga erro normalizado para falhas que não são de privilégio", async () => {
    const connection: MySqlDriverConnection = {
      query: vi.fn(async () => {
        throw Object.assign(new Error("connection lost"), { code: "ECONNRESET" });
      }),
      end: vi.fn(async () => undefined)
    };
    const adapter = new MySqlSourceAdapter({ config, connectionFactory: vi.fn(async () => connection) });
    await adapter.connect();

    await expect(
      adapter.provisionReadonlyUser({ username: "pharma_connector_ro", password: "pwd-1234567890-abcdefghij" })
    ).rejects.toThrowError();
  });
```

Rode `npx vitest run tests/db/mysql-provision.test.ts` → o caso "fallback" provavelmente já passa
(implementado na T2); confirme que **ambos** os novos casos passam. Se o `isMysqlPrivilegeError`
não cobrir `errno`, ajuste — mas o CÓDIGO da T2 já cobre. Esta tarefa fixa os casos em testes.

### 3b. Implementação

Nenhuma mudança de código além da T2; se algum caso falhar, corrija `isMysqlPrivilegeError`.

### 3c. Commit

`test: cobre detecção de privilégio e erro genérico no provision MySQL`

---

## Tarefa 4 — Provisão MariaDB

### 4a. Teste que falha

Crie `tests/db/mariadb-provision.test.ts` (mesma forma do MySQL, driver `mariadb`):

```ts
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
```

> Antes de escrever a implementação, ABRA `src/db/mariadb-adapter.ts` e confirme o nome exato do
> tipo de conexão (`MariaDbDriverConnection`) e o helper de quoting de identificador (provavelmente
> `quoteMariaDbIdentifier` ou similar). Ajuste imports/nomes do teste e do código abaixo ao que
> existe no arquivo — NÃO invente. O padrão de query é `query(sql, params)`.

Rode `npx vitest run tests/db/mariadb-provision.test.ts` → FAIL.

### 4b. Implementação

Em `src/db/mariadb-adapter.ts`, espelhe o MySQL (importe `NoPrivilegeError`/tipos de
`./provision-types.js`, use o helper de quoting existente no arquivo e `driver: "mariadb"` em
`normalizeDatabaseError`):

```ts
  public async provisionReadonlyUser(input: ProvisionReadonlyUserInput): Promise<ProvisionReadonlyUserResult> {
    const connection = this.requireConnection("provision");
    const user = quoteMariaDbIdentifier(input.username);
    const db = quoteMariaDbIdentifier(this.config.name);
    try {
      await connection.query(`CREATE USER IF NOT EXISTS ${user}@'%' IDENTIFIED BY ?`, [input.password]);
      await connection.query(`ALTER USER ${user}@'%' IDENTIFIED BY ?`, [input.password]);
      await connection.query(`GRANT SELECT ON ${db}.* TO ${user}@'%'`, []);
      await connection.query(`FLUSH PRIVILEGES`, []);
      return { outcome: "provisioned", grantedScope: "all_tables" };
    } catch (error) {
      if (isMariaDbPrivilegeError(error)) {
        return { outcome: "fallback_no_privilege", grantedScope: "all_tables" };
      }
      throw normalizeDatabaseError({ driver: "mariadb", operation: "provision", error, secrets: this.secrets });
    }
  }
```

```ts
function isMariaDbPrivilegeError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { errno?: unknown; code?: unknown }).errno ?? (error as { code?: unknown }).code;
  const numeric = typeof code === "number" ? code : Number(code);
  return numeric === 1044 || numeric === 1142;
}
```

> Se o helper de quoting do arquivo tiver outro nome, use o nome real e ajuste o teste.

Rode `npx vitest run tests/db/mariadb-provision.test.ts` → PASS.

### 4c. Commit

`feat: implementa provisionReadonlyUser no MariaDB`

---

## Tarefa 5 — Provisão PostgreSQL

### 5a. Teste que falha

Crie `tests/db/postgresql-provision.test.ts`:

```ts
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
```

Rode `npx vitest run tests/db/postgresql-provision.test.ts` → FAIL.

### 5b. Implementação

Em `src/db/postgresql-adapter.ts`, importe `./provision-types.js` e substitua o stub
`provisionReadonlyUser` (não há stub ainda — adicione o método; remova-o da lista de `notSupported`
se você o adicionar lá). Postgres NÃO parametriza identificadores; faça quote de identificador
seguro localmente. O `CREATE ROLE` não é idempotente por padrão, então trate "role já existe"
(SQLSTATE `42710`) caindo para `ALTER ROLE`:

```ts
import { type ProvisionReadonlyUserInput, type ProvisionReadonlyUserResult } from "./provision-types.js";
```

```ts
  public async provisionReadonlyUser(input: ProvisionReadonlyUserInput): Promise<ProvisionReadonlyUserResult> {
    const connection = this.requireConnection("provision");
    const role = quotePgIdentifier(input.username);
    const dbName = quotePgIdentifier(this.config.name);
    const schema = "public";
    const schemaIdent = quotePgIdentifier(schema);
    try {
      try {
        await connection.query(`CREATE ROLE ${role} LOGIN PASSWORD $1`, [input.password]);
      } catch (error) {
        if (isPgRoleExistsError(error)) {
          await connection.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD $1`, [input.password]);
        } else {
          throw error;
        }
      }
      await connection.query(`GRANT CONNECT ON DATABASE ${dbName} TO ${role}`, []);
      await connection.query(`GRANT USAGE ON SCHEMA ${schemaIdent} TO ${role}`, []);
      await connection.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schemaIdent} TO ${role}`, []);
      return { outcome: "provisioned", grantedScope: "all_tables" };
    } catch (error) {
      if (isPgPrivilegeError(error)) {
        return { outcome: "fallback_no_privilege", grantedScope: "all_tables" };
      }
      throw normalizeDatabaseError({ driver: "postgresql", operation: "provision", error, secrets: this.secrets });
    }
  }
```

Adicione os helpers no rodapé do arquivo:

```ts
function quotePgIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
    throw new Error(`identificador inválido para Postgres: ${name}`);
  }
  return `"${name}"`;
}

function pgSqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isPgRoleExistsError(error: unknown): boolean {
  return pgSqlState(error) === "42710";
}

function isPgPrivilegeError(error: unknown): boolean {
  return pgSqlState(error) === "42501";
}
```

> Se você adicionou `provisionReadonlyUser` ao bloco de stubs `notSupported`, remova-o de lá — o
> método real substitui o stub. Garanta que a interface esteja satisfeita só uma vez.

Rode `npx vitest run tests/db/postgresql-provision.test.ts` → PASS.

### 5c. Commit

`feat: implementa provisionReadonlyUser no PostgreSQL`

---

## Tarefa 6 — Provisão SQL Server

### 6a. Teste que falha

Crie `tests/db/sqlserver-provision.test.ts`:

```ts
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
```

Rode `npx vitest run tests/db/sqlserver-provision.test.ts` → FAIL.

### 6b. Implementação

`mssql` parametriza por nome (`request.input(name, value)`), mas NÃO parametriza identificadores nem
aceita parâmetro em `CREATE LOGIN`. A senha só pode ir como parâmetro em statements DML/`sp_executesql`;
para `CREATE/ALTER LOGIN` precisamos de `sp_executesql` com `@pwd` interpolado no texto dinâmico
parametrizado. Use o padrão abaixo (senha vai em `@pwd`, identificador quotado via `QUOTENAME`):

Em `src/db/sqlserver-adapter.ts`, importe `./provision-types.js` e adicione (removendo o stub
`notSupported` correspondente, se existir):

```ts
import { type ProvisionReadonlyUserInput, type ProvisionReadonlyUserResult } from "./provision-types.js";
```

```ts
  public async provisionReadonlyUser(input: ProvisionReadonlyUserInput): Promise<ProvisionReadonlyUserResult> {
    const connection = this.requireConnection("provision");
    const login = quoteSqlServerIdentifier(input.username);
    try {
      // CREATE/ALTER LOGIN via sp_executesql: identificador quotado por QUOTENAME,
      // senha entra como parâmetro @pwd do dinâmico (nunca concatenada).
      await connection.query(
        `DECLARE @sql nvarchar(max);
         IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = @user)
           SET @sql = N'CREATE LOGIN ' + QUOTENAME(@user) + N' WITH PASSWORD = ' + QUOTENAME(@pwd, '''');
         ELSE
           SET @sql = N'ALTER LOGIN ' + QUOTENAME(@user) + N' WITH PASSWORD = ' + QUOTENAME(@pwd, '''');
         EXEC sp_executesql @sql;`,
        { user: input.username, pwd: input.password }
      );
      await connection.query(
        `DECLARE @sql nvarchar(max);
         IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = @user)
           SET @sql = N'CREATE USER ' + QUOTENAME(@user) + N' FOR LOGIN ' + QUOTENAME(@user);
         IF @sql IS NOT NULL EXEC sp_executesql @sql;`,
        { user: input.username }
      );
      await connection.query(`ALTER ROLE db_datareader ADD MEMBER ${login};`, {});
      return { outcome: "provisioned", grantedScope: "all_tables" };
    } catch (error) {
      if (isSqlServerPrivilegeError(error)) {
        return { outcome: "fallback_no_privilege", grantedScope: "all_tables" };
      }
      throw normalizeDatabaseError({ driver: "sqlserver", operation: "provision", error, secrets: this.secrets });
    }
  }
```

Helpers no rodapé:

```ts
function quoteSqlServerIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
    throw new Error(`identificador inválido para SQL Server: ${name}`);
  }
  return `[${name}]`;
}

function isSqlServerPrivilegeError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const num = (error as { number?: unknown }).number ?? (error as { code?: unknown }).code;
  const numeric = typeof num === "number" ? num : Number(num);
  return numeric === 229 || numeric === 15247;
}
```

> Confirme em `src/db/sqlserver-adapter.ts` se já existe um `quoteSqlServerIdentifier`/`quoteIdentifier`;
> se sim, reuse-o em vez de duplicar. O nome do tipo de conexão (`SqlServerDriverConnection`) já foi
> verificado: `query(sql, params: Record<string, unknown>)` e `close()`.

Rode `npx vitest run tests/db/sqlserver-provision.test.ts` → PASS.

### 6c. Commit

`feat: implementa provisionReadonlyUser no SQL Server`

---

## Tarefa 7 — Provisão Firebird

### 7a. Teste que falha

Crie `tests/db/firebird-provision.test.ts`:

```ts
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
```

Rode `npx vitest run tests/db/firebird-provision.test.ts` → FAIL.

### 7b. Implementação

Em `src/db/firebird-adapter.ts`, importe `./provision-types.js` e adicione (Firebird parametriza
a senha do `CREATE OR ALTER USER`; identificadores de tabela vêm do próprio `RDB$RELATIONS` e são
quotados):

```ts
import { type ProvisionReadonlyUserInput, type ProvisionReadonlyUserResult } from "./provision-types.js";
```

```ts
  public async provisionReadonlyUser(input: ProvisionReadonlyUserInput): Promise<ProvisionReadonlyUserResult> {
    const connection = this.requireConnection("provision");
    const user = quoteFirebirdIdentifier(input.username);
    try {
      await connection.query(`CREATE OR ALTER USER ${user} PASSWORD ?`, [input.password]);
      const rows = await connection.query(
        `SELECT RDB$RELATION_NAME FROM RDB$RELATIONS
         WHERE RDB$SYSTEM_FLAG = 0 AND RDB$VIEW_BLR IS NULL`,
        []
      );
      const tables = extractFirebirdRelationNames(rows);
      for (const table of tables) {
        await connection.query(`GRANT SELECT ON ${quoteFirebirdIdentifier(table)} TO ${user}`, []);
      }
      return { outcome: "provisioned", grantedScope: "all_tables" };
    } catch (error) {
      if (isFirebirdPrivilegeError(error)) {
        return { outcome: "fallback_no_privilege", grantedScope: "all_tables" };
      }
      throw normalizeDatabaseError({ driver: "firebird", operation: "provision", error, secrets: this.secrets });
    }
  }
```

Helpers no rodapé:

```ts
function quoteFirebirdIdentifier(name: string): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(trimmed)) {
    throw new Error(`identificador inválido para Firebird: ${name}`);
  }
  return `"${trimmed}"`;
}

function extractFirebirdRelationNames(rows: unknown): string[] {
  if (!Array.isArray(rows)) return [];
  const names: string[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const raw = (row as Record<string, unknown>)["RDB$RELATION_NAME"];
    if (typeof raw === "string" && raw.trim().length > 0) {
      names.push(raw.trim());
    }
  }
  return names;
}

function isFirebirdPrivilegeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no permission/i.test(message);
}
```

> Verifique no arquivo se já existe helper de quoting Firebird; reuse se houver. O `RDB$RELATION_NAME`
> pode vir com padding de espaços — o `.trim()` em `extractFirebirdRelationNames` cobre isso.

Rode `npx vitest run tests/db/firebird-provision.test.ts` → PASS.

### 7c. Commit

`feat: implementa provisionReadonlyUser no Firebird`

---

## Tarefa 8 — Sinal `propose_readonly_user` no catálogo do LLM

### 8a. Teste que falha

Adicione ao teste existente `tests/transport/tool-catalog.test.ts` (ou crie um caso novo lá):

```ts
import { describe, expect, it } from "vitest";
import { buildToolCatalog, toolNameToAdminCommand, TOOL_NAMES } from "../../src/ai-session/tool-catalog.js";

describe("propose_readonly_user no catálogo", () => {
  it("aparece no catálogo como tool de sinal sem comando admin", () => {
    const catalog = buildToolCatalog();
    const tool = catalog.find((t) => t.name === "propose_readonly_user");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema).toMatchObject({
      type: "object",
      required: ["username"],
      properties: { username: { type: "string" }, rationale: { type: "string" } }
    });
    expect(TOOL_NAMES.has("propose_readonly_user")).toBe(true);
    // É sinal: NÃO tem comando admin associado.
    expect(toolNameToAdminCommand("propose_readonly_user")).toBeUndefined();
  });
});
```

> Ajuste o caminho do arquivo de teste ao que existe (`tests/ai-session/tool-catalog.test.ts`).

Rode `npx vitest run tests/ai-session/tool-catalog.test.ts` → FAIL.

### 8b. Implementação

Em `src/ai-session/tool-catalog.ts`, a estrutura `ToolSpec` exige `command: AdminCommand`. Como o
sinal não tem comando admin, separe a entrada do catálogo. Refatore para que `buildToolCatalog`
inclua um descritor extra sem alterar o `NAME_TO_COMMAND`:

```ts
export const PROPOSE_READONLY_USER_TOOL = "propose_readonly_user";

const SIGNAL_DESCRIPTORS: ToolDescriptor[] = [
  {
    name: PROPOSE_READONLY_USER_TOOL,
    description:
      "Sinaliza ao operador a criação de um usuário somente-leitura dedicado. Não toca no banco; valida o nome e devolve o engine corrente.",
    inputSchema: {
      type: "object",
      required: ["username"],
      properties: { username: { type: "string" }, rationale: { type: "string" } }
    },
    outputSchema: {
      type: "object",
      properties: { accepted: { type: "boolean" }, username: { type: "string" }, engine: { type: "string" } }
    }
  }
];
```

Inclua os nomes de sinal em `TOOL_NAMES` e adicione os descritores ao catálogo:

```ts
export const TOOL_NAMES: ReadonlySet<string> = new Set([
  ...SPECS.map((spec) => spec.name),
  ...SIGNAL_DESCRIPTORS.map((d) => d.name)
]);
```

```ts
export function buildToolCatalog(): ToolDescriptor[] {
  return [
    ...SPECS.map((spec) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      outputSchema: spec.outputSchema
    })),
    ...SIGNAL_DESCRIPTORS
  ];
}
```

> `toolNameToAdminCommand` continua usando só `NAME_TO_COMMAND` (sem o sinal) → devolve `undefined`
> para `propose_readonly_user`, como o teste exige. Importe `ToolDescriptor` de `./ai-protocol.js`
> (já importado no arquivo).

Rode `npx vitest run tests/ai-session/tool-catalog.test.ts` → PASS.

### 8c. Commit

`feat: adiciona sinal propose_readonly_user ao catálogo do LLM`

---

## Tarefa 9 — Tratamento local do sinal `propose_readonly_user` no `AiSession`

### 9a. Teste que falha

Crie `tests/ai-session/ai-session-propose-readonly.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { AiSession } from "../../src/ai-session/ai-session.js";
import type { AiSessionOutboundMessage } from "../../src/ai-session/ai-session.js";

function buildSession(engine: string) {
  const emitted: AiSessionOutboundMessage[] = [];
  const handleAdminRequest = vi.fn(async () => {
    throw new Error("admin não deveria ser chamado pelo sinal");
  });
  const session = new AiSession({
    sessionId: "s1",
    emit: (m) => emitted.push(m),
    deps: {
      handleAdminRequest: handleAdminRequest as never,
      secrets: () => [],
      applyApproval: async () => undefined,
      now: () => "2026-06-03T00:00:00.000Z",
      currentEngine: () => engine
    }
  });
  return { session, emitted, handleAdminRequest };
}

describe("AiSession propose_readonly_user", () => {
  it("aceita username válido, devolve engine e NÃO chama o admin", async () => {
    const { session, emitted, handleAdminRequest } = buildSession("mysql");
    await session.invokeTool({ sessionId: "s1", invocationId: "i1", name: "propose_readonly_user", input: { username: "pharma_connector_ro" } });

    const result = emitted.find((m) => m.type === "tool.result");
    expect(result).toMatchObject({
      type: "tool.result",
      invocationId: "i1",
      ok: true,
      payload: { accepted: true, username: "pharma_connector_ro", engine: "mysql" }
    });
    expect(handleAdminRequest).not.toHaveBeenCalled();
  });

  it("rejeita username inválido com tool.result ok:false", async () => {
    const { session, emitted } = buildSession("postgresql");
    await session.invokeTool({ sessionId: "s1", invocationId: "i2", name: "propose_readonly_user", input: { username: "1bad name!" } });

    const result = emitted.find((m) => m.type === "tool.result");
    expect(result).toMatchObject({ type: "tool.result", invocationId: "i2", ok: false, errorCode: "INVALID_INPUT" });
  });
});
```

Rode `npx vitest run tests/ai-session/ai-session-propose-readonly.test.ts` → FAIL (sem `currentEngine`/sem tratamento).

### 9b. Implementação

Em `src/ai-session/ai-session.ts`:

1. Adicione `currentEngine: () => string;` à interface `AiSessionDeps`.
2. Importe o nome do sinal e o regex de validação:

```ts
import { buildToolCatalog, CATALOG_VERSION, toolNameToAdminCommand, PROPOSE_READONLY_USER_TOOL } from "./tool-catalog.js";

const READONLY_USERNAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{2,62}$/;
```

3. No início de `invokeTool`, após registrar a invocação e auditar o `tool.invoke`, intercepte o
   sinal antes do `toolNameToAdminCommand`:

```ts
    if (command.name === PROPOSE_READONLY_USER_TOOL) {
      this.handleProposeReadonlyUser(command);
      return;
    }
```

4. Adicione o método privado:

```ts
  private handleProposeReadonlyUser(command: ToolInvokeCommand): void {
    const input = (command.input ?? {}) as { username?: unknown };
    const username = typeof input.username === "string" ? input.username : "";
    if (!READONLY_USERNAME_PATTERN.test(username)) {
      this.emit(buildToolResultMessage(
        { sessionId: this.sessionId, invocationId: command.invocationId, ok: false, errorCode: "INVALID_INPUT" },
        this.deps.now()
      ));
      this.audit({ kind: "tool.result", tool: command.name, summary: `username inválido para usuário read-only` });
      return;
    }
    const engine = this.deps.currentEngine();
    const payload = { accepted: true, username, engine };
    this.emit(buildToolResultMessage(
      { sessionId: this.sessionId, invocationId: command.invocationId, ok: true, payload },
      this.deps.now()
    ));
    this.audit({ kind: "tool.result", tool: command.name, summary: `proposta de usuário read-only ${username} (${engine})`, detail: payload });
  }
```

> Nenhum segredo no payload → não precisa redigir, mas mantém o padrão de audit existente.

Rode `npx vitest run tests/ai-session/ai-session-propose-readonly.test.ts` → PASS.
Rode `npx vitest run tests/ai-session/ai-session.test.ts` → garanta que ainda passa.

### 9c. Implementação do wiring

Em `src/service/ai-session-wiring.ts`, adicione `currentEngine` ao `AiSessionDepsInput` e propague
em `buildAiSessionDeps`:

```ts
export interface AiSessionDepsInput {
  // ...campos existentes...
  currentEngine: () => string;
}
```

```ts
export function buildAiSessionDeps(input: AiSessionDepsInput): AiSessionDeps {
  return {
    handleAdminRequest: (req) => input.handleAdminRequest(req as AdminRequestMessage),
    secrets: input.secrets,
    now: input.now,
    currentEngine: input.currentEngine,
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

Em `src/service/runtime.ts`, no `buildAiSessionDeps({...})` dentro de `bindTransportEvents`,
adicione:

```ts
          currentEngine: () => this.config.database?.driver ?? "unknown",
```

Rode `npm test` → garanta verde (runtime e ai-session-flow continuam passando).

### 9d. Commit

`feat: trata propose_readonly_user localmente na AiSession com engine corrente`

---

## Tarefa 10 — Protocolo do comando admin `connector.provisionReadonlyUser`

### 10a. Teste que falha

Crie `tests/transport/provision-readonly-ws.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  parseServerMessage,
  buildProvisionReadonlyUserResult,
  ProtocolParseError,
  type ProvisionReadonlyUserMessage
} from "../../src/transport/protocol.js";

describe("connector.provisionReadonlyUser protocol", () => {
  it("faz parse do comando neo→agente (sem senha)", () => {
    const msg = parseServerMessage(JSON.stringify({
      type: "connector.provisionReadonlyUser",
      requestId: "req-1",
      sessionId: "sess-1",
      username: "pharma_connector_ro"
    })) as ProvisionReadonlyUserMessage;
    expect(msg.type).toBe("connector.provisionReadonlyUser");
    expect(msg.requestId).toBe("req-1");
    expect(msg.sessionId).toBe("sess-1");
    expect(msg.username).toBe("pharma_connector_ro");
    expect("password" in msg).toBe(false);
  });

  it("rejeita comando sem username", () => {
    expect(() => parseServerMessage(JSON.stringify({
      type: "connector.provisionReadonlyUser", requestId: "req-1", sessionId: "sess-1"
    }))).toThrow(ProtocolParseError);
  });

  it("constrói o result provisioned sem errorCode", () => {
    const result = buildProvisionReadonlyUserResult({
      requestId: "req-1", sessionId: "sess-1", outcome: "provisioned", username: "pharma_connector_ro"
    });
    expect(result).toMatchObject({
      type: "connector.provisionReadonlyUser.result",
      requestId: "req-1",
      sessionId: "sess-1",
      outcome: "provisioned",
      username: "pharma_connector_ro",
      grantedScope: "all_tables"
    });
    expect("errorCode" in result).toBe(false);
  });

  it("constrói o result error com errorCode", () => {
    const result = buildProvisionReadonlyUserResult({
      requestId: "req-1", sessionId: "sess-1", outcome: "error", username: "pharma_connector_ro", errorCode: "timeout"
    });
    expect(result.outcome).toBe("error");
    expect(result.errorCode).toBe("timeout");
  });
});
```

Rode `npx vitest run tests/transport/provision-readonly-ws.test.ts` → FAIL.

### 10b. Implementação

Em `src/transport/protocol.ts`:

1. Adicione o tipo ao `ServerMessageType`:

```ts
export type ServerMessageType =
  | "connector.config"
  | "batch.ack"
  | "config.updated"
  | "admin.request"
  | "connector.bootstrap.dbConfig"
  | "connector.provisionReadonlyUser";
```

2. Adicione o tipo de resultado ao `ConnectorMessageType`:

```ts
export type ConnectorMessageType = "connector.heartbeat" | "product.batch" | "connector.error" | "admin.response" | "connector.discovery" | "connector.provisionReadonlyUser.result";
```

3. Tipos de mensagem (após `BootstrapDbConfigMessage`):

```ts
export type ProvisionOutcomeWire = "provisioned" | "fallback_no_privilege" | "unsupported_engine" | "error";
export type ProvisionErrorCode = "auth" | "timeout" | "unreachable" | "syntax" | "unknown";

export interface ProvisionReadonlyUserMessage {
  type: "connector.provisionReadonlyUser";
  requestId: string;
  sessionId: string;
  username: string;
  sentAt?: string;
}

export interface ProvisionReadonlyUserResultMessage {
  type: "connector.provisionReadonlyUser.result";
  requestId: string;
  sessionId: string;
  outcome: ProvisionOutcomeWire;
  username: string;
  grantedScope: "all_tables";
  errorCode?: ProvisionErrorCode;
  sentAt?: string;
}
```

4. Inclua `ProvisionReadonlyUserMessage` no union `ServerMessage` e
   `ProvisionReadonlyUserResultMessage` no union `ConnectorMessage`.

5. No `switch` de `parseServerMessage`, adicione:

```ts
    case "connector.provisionReadonlyUser":
      return parseProvisionReadonlyUser(message);
```

6. Função de parse e validação do username (reaproveita o pattern do contrato):

```ts
const PROVISION_USERNAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{2,62}$/;

function parseProvisionReadonlyUser(message: Record<string, unknown>): ProvisionReadonlyUserMessage {
  const username = expectString(message.username, "username");
  if (!PROVISION_USERNAME_PATTERN.test(username)) {
    throw new ProtocolParseError("username must match ^[a-zA-Z][a-zA-Z0-9_]{2,62}$");
  }
  return {
    type: "connector.provisionReadonlyUser",
    requestId: validateRequestId(expectString(message.requestId, "requestId")),
    sessionId: expectString(message.sessionId, "sessionId"),
    username,
    sentAt: optionalString(message.sentAt, "sentAt")
  };
}
```

7. Builder do result:

```ts
export function buildProvisionReadonlyUserResult(
  input: {
    requestId: string;
    sessionId: string;
    outcome: ProvisionOutcomeWire;
    username: string;
    errorCode?: ProvisionErrorCode;
  },
  sentAt = new Date().toISOString()
): ProvisionReadonlyUserResultMessage {
  const message: ProvisionReadonlyUserResultMessage = {
    type: "connector.provisionReadonlyUser.result",
    requestId: validateRequestId(input.requestId),
    sessionId: input.sessionId,
    outcome: input.outcome,
    username: input.username,
    grantedScope: "all_tables",
    sentAt
  };
  if (input.outcome === "error" && input.errorCode !== undefined) {
    message.errorCode = input.errorCode;
  }
  return message;
}
```

Rode `npx vitest run tests/transport/provision-readonly-ws.test.ts` → PASS.
Rode `npx vitest run tests/transport/protocol.test.ts` → garanta verde.

### 10c. Commit

`feat: protocolo do comando admin connector.provisionReadonlyUser`

---

## Tarefa 11 — Roteamento core + evento no ws-client

### 11a. Teste que falha

Adicione ao teste do router (`tests/transport/server-message-router.test.ts` se existir; senão crie
um caso em `tests/transport/provision-readonly-ws.test.ts`):

```ts
import { isCoreServerMessageType } from "../../src/transport/server-message-router.js";

describe("connector.provisionReadonlyUser routing", () => {
  it("é classificado como core", () => {
    expect(isCoreServerMessageType("connector.provisionReadonlyUser")).toBe(true);
  });
});
```

Rode `npx vitest run tests/transport/provision-readonly-ws.test.ts` → FAIL.

### 11b. Implementação

Em `src/transport/server-message-router.ts`, adicione ao `CORE_SERVER_MESSAGE_TYPES`:

```ts
export const CORE_SERVER_MESSAGE_TYPES: ReadonlySet<ServerMessageType> = new Set([
  "connector.config",
  "batch.ack",
  "config.updated",
  "admin.request",
  "connector.bootstrap.dbConfig",
  "connector.provisionReadonlyUser"
]);
```

Em `src/transport/ws-client.ts`:

1. Importe o tipo de mensagem e o builder do result do `./protocol.js`:

```ts
  type ProvisionReadonlyUserMessage,
  type ProvisionReadonlyUserResultMessage,
```

2. Adicione `"provisionReadonlyUser"` ao union `WebSocketTransportEvent`.

3. Sobrecarga de `on`:

```ts
  public override on(event: "provisionReadonlyUser", listener: (message: ProvisionReadonlyUserMessage) => void): this;
```

4. No `switch (message.type)` de `handleCoreMessage`, adicione:

```ts
      case "connector.provisionReadonlyUser":
        this.logger.info("provision.readonly.received", {
          requestId: message.requestId,
          sessionId: message.sessionId
        });
        this.emit("provisionReadonlyUser", message);
        return;
```

5. Método de envio do result:

```ts
  public sendProvisionReadonlyUserResult(message: ProvisionReadonlyUserResultMessage): void {
    this.send(message);
    this.logger.info("provision.readonly.result_sent", {
      requestId: message.requestId,
      sessionId: message.sessionId,
      outcome: message.outcome,
      ...(message.errorCode ? { errorCode: message.errorCode } : {})
    });
  }
```

> `send` serializa via `serializeConnectorMessage`; `ProvisionReadonlyUserResultMessage` está no
> union `ConnectorMessage`, então tipa corretamente.

Rode `npx vitest run tests/transport/provision-readonly-ws.test.ts` → PASS.

### 11c. Commit

`feat: roteia connector.provisionReadonlyUser e envia o result no ws-client`

---

## Tarefa 12 — Persistência do config (RO + `readonlyProvisioning`)

### 12a. Teste que falha

Crie `tests/config/programdata-readonly-provisioning.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeReadonlyProvisioningConfig } from "../../src/config/programdata-config.js";
import type { DatabaseConfig } from "../../src/config/types.js";

const baseDb: DatabaseConfig = {
  driver: "mysql", host: "127.0.0.1", port: 3306, name: "pharmacy", user: "ro", password: "ro-secret"
};

describe("writeReadonlyProvisioningConfig", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pdc-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("grava database RO + bloco readonlyProvisioning provisioned", async () => {
    await writeReadonlyProvisioningConfig(dir, {
      database: baseDb,
      readonlyProvisioning: { status: "provisioned", username: "pharma_connector_ro", engine: "mysql", provisionedAt: "2026-06-03T00:00:00Z" }
    });
    const filePath = join(dir, "PharmaAgentConnector", "connector-config.json");
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    expect(parsed.database.user).toBe("ro");
    expect(parsed.readonlyProvisioning).toEqual({
      status: "provisioned", username: "pharma_connector_ro", engine: "mysql", provisionedAt: "2026-06-03T00:00:00Z"
    });
  });

  it("grava bloco fallback_discovered sem username", async () => {
    await writeReadonlyProvisioningConfig(dir, {
      database: baseDb,
      readonlyProvisioning: { status: "fallback_discovered", engine: "mysql", provisionedAt: "2026-06-03T00:00:00Z" }
    });
    const filePath = join(dir, "PharmaAgentConnector", "connector-config.json");
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    expect(parsed.readonlyProvisioning.status).toBe("fallback_discovered");
    expect("username" in parsed.readonlyProvisioning).toBe(false);
  });
});
```

Rode `npx vitest run tests/config/programdata-readonly-provisioning.test.ts` → FAIL.

### 12b. Implementação

Em `src/config/programdata-config.ts` adicione tipos e função (reaproveitando merge `mode 0o600`):

```ts
export interface ReadonlyProvisioningMetadata {
  status: "provisioned" | "fallback_discovered" | "not_attempted";
  username?: string;
  engine: string;
  provisionedAt: string;
}

export async function writeReadonlyProvisioningConfig(
  programData: string | undefined,
  input: { database: DatabaseConfig; readonlyProvisioning: ReadonlyProvisioningMetadata }
): Promise<void> {
  const filePath = defaultProgramDataConfigPath(programData);
  await mkdir(dirname(filePath), { recursive: true });

  let current: Record<string, unknown> = {};
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    current = isPlainRecord(parsed) ? parsed : {};
  } catch (err) {
    if (!isMissingFileError(err)) {
      throw new ProgramDataConfigError(
        "Could not read existing connector config file before writing readonly provisioning section."
      );
    }
    current = {};
  }

  const provisioning: ReadonlyProvisioningMetadata = {
    status: input.readonlyProvisioning.status,
    engine: input.readonlyProvisioning.engine,
    provisionedAt: input.readonlyProvisioning.provisionedAt,
    ...(input.readonlyProvisioning.username !== undefined
      ? { username: input.readonlyProvisioning.username }
      : {})
  };

  const next = { ...current, database: input.database, readonlyProvisioning: provisioning };
  await writeFile(filePath, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
}
```

Rode `npx vitest run tests/config/programdata-readonly-provisioning.test.ts` → PASS.

### 12c. Commit

`feat: persiste credencial RO + bloco readonlyProvisioning no connector-config`

---

## Tarefa 13 — Orquestração no runtime (provisioned + troca de conexão + persistência)

### 13a. Teste que falha

Crie `tests/service/runtime-provision-readonly.test.ts`. Use um `transport` fake (EventEmitter) e um
`adapter` injetado, no estilo de `tests/service/runtime.test.ts`. ABRA esse arquivo primeiro para
copiar o `FakeTransport`/helpers existentes. Esqueleto literal:

```ts
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { ConnectorRuntime } from "../../src/service/runtime.js";
import type { SourceDatabaseAdapter } from "../../src/db/source-adapter.js";
import type { ProvisionReadonlyUserResultMessage } from "../../src/transport/protocol.js";

class FakeTransport extends EventEmitter {
  public results: ProvisionReadonlyUserResultMessage[] = [];
  public connect = vi.fn(async () => undefined);
  public close = vi.fn(async () => undefined);
  public isConnected = vi.fn(() => true);
  public sendBatch = vi.fn();
  public sendHeartbeat = vi.fn();
  public sendConnectorError = vi.fn();
  public sendAdminResponse = vi.fn();
  public sendSchemaTablesListResult = vi.fn();
  public sendFileDiscoveryScanResult = vi.fn();
  public sendConnectorSetupConfigResult = vi.fn();
  public sendConnectorDiscovery = vi.fn();
  public sendAiSessionMessage = vi.fn();
  public getReconnectAttemptCount = vi.fn(() => 0);
  public sendProvisionReadonlyUserResult = vi.fn((m: ProvisionReadonlyUserResultMessage) => { this.results.push(m); });
}

function buildAdmin(provisionOutcome: "provisioned" | "fallback_no_privilege"): SourceDatabaseAdapter {
  return {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    queryChanges: vi.fn(async () => []),
    querySnapshotPage: vi.fn(async () => []),
    listTables: vi.fn(async () => []),
    listColumns: vi.fn(async () => []),
    describeTable: vi.fn(async () => []),
    listForeignKeys: vi.fn(async () => []),
    sampleRows: vi.fn(async () => []),
    runReadOnlySelect: vi.fn(async () => [{ ok: 1 }]),
    provisionReadonlyUser: vi.fn(async () => ({ outcome: provisionOutcome, grantedScope: "all_tables" as const }))
  };
}

const env = {
  CONNECTOR_TOKEN: "tok",
  CONNECTOR_WS_URL: "ws://localhost:9999",
  DB_DRIVER: "mysql",
  DB_HOST: "127.0.0.1",
  DB_PORT: "3306",
  DB_NAME: "pharmacy",
  DB_USER: "admin",
  DB_PASSWORD: "admin-secret",
  PROGRAMDATA: "/tmp/does-not-matter"
} as never;

describe("ConnectorRuntime provision readonly", () => {
  it("provisiona, valida RO, troca a conexão ativa e responde provisioned", async () => {
    const transport = new FakeTransport();
    const adminAdapter = buildAdmin("provisioned");
    const roAdapter = buildAdmin("provisioned");
    const writeProvision = vi.fn(async () => undefined);

    const runtime = new ConnectorRuntime({
      env,
      transport: transport as never,
      adapter: adminAdapter,
      now: () => "2026-06-03T00:00:00.000Z",
      createReadonlyAdapter: () => roAdapter,
      writeReadonlyProvisioningConfig: writeProvision
    } as never);
    await runtime.start();

    transport.emit("provisionReadonlyUser", {
      type: "connector.provisionReadonlyUser",
      requestId: "req-1",
      sessionId: "sess-1",
      username: "pharma_connector_ro"
    });
    await vi.waitFor(() => expect(transport.results.length).toBe(1));

    const result = transport.results[0]!;
    expect(result.outcome).toBe("provisioned");
    expect(result.username).toBe("pharma_connector_ro");
    expect(result.grantedScope).toBe("all_tables");
    expect(adminAdapter.provisionReadonlyUser).toHaveBeenCalledTimes(1);
    expect(roAdapter.runReadOnlySelect).toHaveBeenCalled(); // valida RO
    expect(writeProvision).toHaveBeenCalledTimes(1);
    const persisted = (writeProvision.mock.calls[0]![1]) as { readonlyProvisioning: { status: string; username?: string } };
    expect(persisted.readonlyProvisioning.status).toBe("provisioned");
    expect(persisted.readonlyProvisioning.username).toBe("pharma_connector_ro");
  });

  it("fallback_no_privilege mantém a conexão na descoberta e persiste fallback_discovered", async () => {
    const transport = new FakeTransport();
    const adminAdapter = buildAdmin("fallback_no_privilege");
    const writeProvision = vi.fn(async () => undefined);
    const runtime = new ConnectorRuntime({
      env,
      transport: transport as never,
      adapter: adminAdapter,
      now: () => "2026-06-03T00:00:00.000Z",
      createReadonlyAdapter: () => buildAdmin("provisioned"),
      writeReadonlyProvisioningConfig: writeProvision
    } as never);
    await runtime.start();

    transport.emit("provisionReadonlyUser", {
      type: "connector.provisionReadonlyUser", requestId: "req-2", sessionId: "sess-1", username: "pharma_connector_ro"
    });
    await vi.waitFor(() => expect(transport.results.length).toBe(1));
    expect(transport.results[0]!.outcome).toBe("fallback_no_privilege");
    const persisted = (writeProvision.mock.calls[0]![1]) as { readonlyProvisioning: { status: string } };
    expect(persisted.readonlyProvisioning.status).toBe("fallback_discovered");
  });

  it("erro durante a provisão responde error e não troca a conexão", async () => {
    const transport = new FakeTransport();
    const adminAdapter = buildAdmin("provisioned");
    (adminAdapter.provisionReadonlyUser as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error("connection lost"), { code: "ECONNRESET" })
    );
    const runtime = new ConnectorRuntime({
      env,
      transport: transport as never,
      adapter: adminAdapter,
      now: () => "2026-06-03T00:00:00.000Z",
      createReadonlyAdapter: () => buildAdmin("provisioned"),
      writeReadonlyProvisioningConfig: vi.fn(async () => undefined)
    } as never);
    await runtime.start();

    transport.emit("provisionReadonlyUser", {
      type: "connector.provisionReadonlyUser", requestId: "req-3", sessionId: "sess-1", username: "pharma_connector_ro"
    });
    await vi.waitFor(() => expect(transport.results.length).toBe(1));
    expect(transport.results[0]!.outcome).toBe("error");
    expect(transport.results[0]!.errorCode).toBeDefined();
  });
});
```

> ABRA `tests/service/runtime.test.ts` e `src/config/env.ts` para confirmar como o `env` é montado
> (nomes exatos das chaves `DB_*`). Ajuste o objeto `env` ao formato real. O `vi.waitFor` cobre o
> processamento assíncrono do handler.

Rode `npx vitest run tests/service/runtime-provision-readonly.test.ts` → FAIL.

### 13b. Implementação

Em `src/service/runtime.ts`:

1. Importe os símbolos do protocolo e do config:

```ts
import {
  buildAdminErrorResponseMessage,
  buildAdminSuccessResponseMessage,
  buildConnectorDiscoveryMessage,
  buildProvisionReadonlyUserResult,
  type ProvisionReadonlyUserMessage,
  type ProvisionErrorCode
} from "../transport/protocol.js";
import {
  writeDatabaseConfig,
  writeReadonlyProvisioningConfig,
  type ReadonlyProvisioningMetadata
} from "../config/programdata-config.js";
import { generateReadonlyPassword } from "../db/provision-password.js";
```

2. Adicione à `RuntimeTransport` a sobrecarga do evento e o método de envio:

```ts
  on(event: "provisionReadonlyUser", listener: (message: ProvisionReadonlyUserMessage) => void): this;
```
```ts
  sendProvisionReadonlyUserResult(message: import("../transport/protocol.js").ProvisionReadonlyUserResultMessage): void;
```

3. Adicione opções injetáveis ao `ConnectorRuntimeOptions` (para testabilidade):

```ts
  createReadonlyAdapter?: (database: DatabaseConfig) => SourceDatabaseAdapter;
  writeReadonlyProvisioningConfig?: (
    programData: string | undefined,
    input: { database: DatabaseConfig; readonlyProvisioning: ReadonlyProvisioningMetadata }
  ) => Promise<void>;
```

Guarde-os em campos privados com defaults:

```ts
  private readonly createReadonlyAdapterFn: (database: DatabaseConfig) => SourceDatabaseAdapter;
  private readonly writeReadonlyProvisioningFn: (
    programData: string | undefined,
    input: { database: DatabaseConfig; readonlyProvisioning: ReadonlyProvisioningMetadata }
  ) => Promise<void>;
```
No construtor:
```ts
    this.createReadonlyAdapterFn =
      options.createReadonlyAdapter ??
      ((database) =>
        createSourceDatabaseAdapter({
          config: database,
          dependencies: this.adapterDependencies,
          secrets: runtimeConfigSecrets(this.config)
        }));
    this.writeReadonlyProvisioningFn =
      options.writeReadonlyProvisioningConfig ?? writeReadonlyProvisioningConfig;
```

4. Bind do evento em `bindTransportEvents`:

```ts
    this.transport.on("provisionReadonlyUser", (message) => {
      this.handleProvisionReadonlyUser(message).catch((error) =>
        this.handleRuntimeError("PROVISION_READONLY_FAILED", error)
      );
    });
```

5. O handler (orquestração completa). Conecta admin (já é a conexão ativa), gera senha, provisiona,
   valida RO em adapter novo, troca conexão e persiste:

```ts
  private async handleProvisionReadonlyUser(message: ProvisionReadonlyUserMessage): Promise<void> {
    const database = this.config.database;
    const engine = database?.driver ?? "unknown";
    const respond = (
      outcome: "provisioned" | "fallback_no_privilege" | "unsupported_engine" | "error",
      errorCode?: ProvisionErrorCode
    ): void => {
      this.transport.sendProvisionReadonlyUserResult(
        buildProvisionReadonlyUserResult(
          {
            requestId: message.requestId,
            sessionId: message.sessionId,
            outcome,
            username: message.username,
            ...(errorCode ? { errorCode } : {})
          },
          this.now()
        )
      );
    };

    if (!database) {
      respond("error", "unknown");
      return;
    }

    const password = generateReadonlyPassword();
    const secrets = [...runtimeConfigSecrets(this.config), password];

    let adminAdapter: SourceDatabaseAdapter;
    try {
      adminAdapter = await this.ensureAdapterConnected();
    } catch {
      respond("error", "unreachable");
      return;
    }

    let provisionResult;
    try {
      provisionResult = await adminAdapter.provisionReadonlyUser({
        username: message.username,
        password
      });
    } catch (error) {
      this.logger.warn("provision.readonly.failed", {
        requestId: message.requestId,
        message: redactString(error instanceof Error ? error.message : String(error), secrets)
      });
      await this.persistProvisioning(database, { status: "fallback_discovered", engine });
      respond("error", classifyProvisionError(error));
      return;
    }

    if (provisionResult.outcome === "fallback_no_privilege") {
      await this.persistProvisioning(database, { status: "fallback_discovered", engine });
      respond("fallback_no_privilege");
      return;
    }

    // provisioned: monta credencial RO, valida com SELECT, troca a conexão ativa.
    const roDatabase: DatabaseConfig = { ...database, user: message.username, password };
    const roAdapter = this.createReadonlyAdapterFn(roDatabase);
    try {
      await roAdapter.connect();
      await roAdapter.runReadOnlySelect({ sql: "select 1", limit: 1 });
    } catch (error) {
      await roAdapter.close().catch(() => undefined);
      this.logger.warn("provision.readonly.validation_failed", {
        requestId: message.requestId,
        message: redactString(error instanceof Error ? error.message : String(error), secrets)
      });
      await this.persistProvisioning(database, { status: "fallback_discovered", engine });
      respond("error", classifyProvisionError(error));
      return;
    }

    const previousAdapter = this.adapter;
    this.adapter = roAdapter;
    this.adapterConnected = true;
    this.config = { ...this.config, database: roDatabase };
    if (previousAdapter && previousAdapter !== roAdapter) {
      await previousAdapter.close().catch(() => undefined);
    }

    await this.persistProvisioning(roDatabase, {
      status: "provisioned",
      username: message.username,
      engine
    });
    this.logger.info("provision.readonly.provisioned", {
      requestId: message.requestId,
      sessionId: message.sessionId,
      engine
    });
    respond("provisioned");
  }

  private async persistProvisioning(
    database: DatabaseConfig,
    meta: { status: ReadonlyProvisioningMetadata["status"]; username?: string; engine: string }
  ): Promise<void> {
    const readonlyProvisioning: ReadonlyProvisioningMetadata = {
      status: meta.status,
      engine: meta.engine,
      provisionedAt: this.now(),
      ...(meta.username !== undefined ? { username: meta.username } : {})
    };
    await this.writeReadonlyProvisioningFn(this.configuredProgramDataPath(), {
      database,
      readonlyProvisioning
    });
  }
```

6. Função livre de classificação de erro (no rodapé do arquivo, junto às demais):

```ts
function classifyProvisionError(error: unknown): ProvisionErrorCode {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code).toLowerCase()
    : "";
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const haystack = `${code} ${message}`;
  if (haystack.includes("timeout") || haystack.includes("timedout")) return "timeout";
  if (haystack.includes("econnrefused") || haystack.includes("econnreset") || haystack.includes("unreachable") || haystack.includes("network")) return "unreachable";
  if (haystack.includes("auth") || haystack.includes("denied") || haystack.includes("password")) return "auth";
  if (haystack.includes("syntax")) return "syntax";
  return "unknown";
}
```

> A `WebSocketTransportClient` real já ganhou `sendProvisionReadonlyUserResult` (T11), satisfazendo
> a interface `RuntimeTransport`. A persistência usa a senha gerada apenas em memória/arquivo local
> (`mode 0o600`), nunca no `...result`.

Rode `npx vitest run tests/service/runtime-provision-readonly.test.ts` → PASS.
Rode `npm test` → suíte inteira verde.

### 13c. Commit

`feat: orquestra provisionamento RO no runtime com fallback e troca de conexão`

---

## Tarefa 14 — Redação garante a senha fora do result/log/audit

### 14a. Teste que falha

Adicione ao `tests/service/runtime-provision-readonly.test.ts` um caso que captura todas as saídas
do transport e do logger e garante ausência da senha. Como a senha é gerada internamente, intercepte
via spy em `generateReadonlyPassword` para conhecer o valor:

```ts
import * as provisionPassword from "../../src/db/provision-password.js";

  it("nunca expõe a senha gerada no result nem nos logs", async () => {
    const KNOWN = "KNOWN-RO-PASSWORD-1234567890ABCD";
    vi.spyOn(provisionPassword, "generateReadonlyPassword").mockReturnValue(KNOWN);

    const transport = new FakeTransport();
    const logger = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      child: vi.fn(() => logger)
    };
    const runtime = new ConnectorRuntime({
      env,
      transport: transport as never,
      adapter: buildAdmin("provisioned"),
      logger: logger as never,
      now: () => "2026-06-03T00:00:00.000Z",
      createReadonlyAdapter: () => buildAdmin("provisioned"),
      writeReadonlyProvisioningConfig: vi.fn(async () => undefined)
    } as never);
    await runtime.start();

    transport.emit("provisionReadonlyUser", {
      type: "connector.provisionReadonlyUser", requestId: "req-9", sessionId: "sess-1", username: "pharma_connector_ro"
    });
    await vi.waitFor(() => expect(transport.results.length).toBe(1));

    const serializedResult = JSON.stringify(transport.results[0]);
    expect(serializedResult).not.toContain(KNOWN);

    const allLogs = JSON.stringify([
      ...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls
    ]);
    expect(allLogs).not.toContain(KNOWN);
  });
```

> Confirme em `src/logging/logger.ts` a interface real do `Logger` (métodos `info/warn/error/debug`
> e se há `child`); ajuste o mock ao shape real.

Rode `npx vitest run tests/service/runtime-provision-readonly.test.ts` → este caso DEVE passar pela
construção da T13 (a senha nunca entra em `buildProvisionReadonlyUserResult` nem em campos logados).
Se algum log incluir a senha, redija com `redactString(..., [password])` antes de logar e re-rode até
PASS. Esta tarefa existe para travar a garantia de redação.

### 14b. Implementação

Sem mudança esperada além da T13; se o teste falhar, adicione redação ao log culpado.

### 14c. Commit

`test: garante que a senha RO nunca vaza no result ou nos logs`

---

## Self-Review (obrigatório antes de encerrar)

Antes de declarar concluído, verifique:

1. **Cobertura do escopo (Contratos A e C):**
   - [ ] (A.1) `propose_readonly_user` no catálogo + tratamento local que valida
     `^[a-zA-Z][a-zA-Z0-9_]{2,62}$`, devolve `{accepted,username,engine}` e NÃO toca no banco (T8, T9).
   - [ ] (A.2) Comando admin `connector.provisionReadonlyUser` / `.result` (protocolo, rota, ws-client) (T10, T11).
   - [ ] (A.2) `provisionReadonlyUser` na interface + 5 engines com statements fixos/parametrizados/idempotentes e detecção de privilégio (T2–T7).
   - [ ] Geração de senha CSPRNG ≥24 local (T1).
   - [ ] Orquestração: conecta admin → provisiona → valida RO (`select 1`) → troca conexão ativa → persiste → responde (T13).
   - [ ] Fallback `fallback_no_privilege` mantém descoberta; `error` responde error e NÃO troca conexão (T13).
   - [ ] (C) `writeReadonlyProvisioningConfig` grava `database` RO/descoberta + `readonlyProvisioning` (`provisioned|fallback_discovered|not_attempted`) `mode 0o600` (T12).
   - [ ] Senha fora de result/log/audit via redação (T14).

2. **Placeholders:** nenhum `TODO`, `...`, `FIXME` ou identificador inventado em código de produção.

3. **Consistência de nomes com o CONTRATO CANÔNICO:** confira via busca:
   `grep -rn "provisionReadonlyUser\|propose_readonly_user\|fallback_no_privilege\|grantedScope\|readonlyProvisioning\|fallback_discovered" src/`
   e bata cada string contra o contrato (sem variações de capitalização/typos).

4. **Verificação final:** `npm test` verde; `npx tsc -p tsconfig.json --noEmit` sem erros de tipo.

5. **Pontos a confirmar no repo (não assumir):** nomes reais de `MariaDbDriverConnection` e helper de
   quoting do MariaDB (T4); existência/nome de helper de quoting do SQL Server (T6) e Firebird (T7);
   se Postgres/SQLServer tinham `provisionReadonlyUser` em `notSupported` (remover o stub); shape real
   do `Logger` (T14) e do objeto `env`/`config.database` (T13). Onde divergir do plano, use o nome
   REAL e ajuste teste+código juntos.

## Out of scope (planos separados)

- Contrato B (neo): pausa/retomada do loop, `provision.proposed/result/decision`, relay socket.io,
  invocação correlacionada do comando admin.
- UI (web): `ProvisionApprovalCard`, hook, fase `provisioning`, timeline.
- Teste de integração ponta-a-ponta (fim de feature).
