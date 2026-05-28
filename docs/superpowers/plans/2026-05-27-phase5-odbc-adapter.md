# Fase 5 — ODBC Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar adapter ODBC genérico (`DB_DRIVER=odbc`) que aceita `dsn` (DSN nomeada do Windows) ou `connectionString` completa, com escolha de `dialect` para discovery (`listTables`/`listColumns`). Habilita cobertura de engines de cauda longa (Oracle, Sybase Advantage, Progress, Interbase, DB2) sem novos adapters dedicados, desde que o cliente tenha driver ODBC instalado.

**Architecture:** Novo `OdbcSourceAdapter` em arquivo independente. `DatabaseConfig` ganha campos opcionais `dsn?: string`, `connectionString?: string`, `dialect?: "ansi" | "oracle" | "sybase" | "progress" | "generic"`. Validação: exatamente um de `dsn` ou `connectionString` obrigatório quando `driver === "odbc"`; demais campos de DB (`host`, `port`, `name`) ficam opcionais para este driver. Query SQL (`queryChanges`/`querySnapshotPage`) é definida pelo painel — adapter não traduz. `listTables`/`listColumns` usam SQL por dialect.

**Tech Stack:** TypeScript (ESM), vitest, pacote `odbc` (em `optionalDependencies`, requer compilação nativa via node-gyp). Node 20+.

**Spec:** `docs/superpowers/specs/2026-05-27-discovery-multi-erp-design.md` (Seção "Adapter ODBC").

**Depende de:** Nenhuma fase anterior (pode rodar em paralelo). Beneficia-se da Fase 1 (padrão estabelecido para campos opcionais em `DatabaseConfig`).

---

## File Structure

**Novos arquivos:**
- `src/db/odbc-adapter.ts`
- `tests/db/odbc-adapter.test.ts`

**Modificados:**
- `src/config/types.ts` — estende `DatabaseDriver` com `"odbc"`; adiciona `dsn?`, `connectionString?`, `dialect?` em `DatabaseConfig`
- `src/config/env.ts` — aceita `DB_DRIVER=odbc`; parse de `DB_DSN`, `DB_CONNECTION_STRING`, `DB_DIALECT`; regra de exclusão mútua dsn/connectionString
- `src/db/source-adapter.ts` — estende `SourceDatabaseAdapterKind`
- `src/db/adapter-factory.ts` — novo case + dependência `odbcConnectionFactory`
- `src/service/runtime.ts` — wiring da factory com `optionalImport("odbc")`
- `tests/config/env.test.ts` — casos `odbc`
- `tests/db/adapter-factory.test.ts` — caso `driver: "odbc"`
- `package.json` — `odbc` em `optionalDependencies`

---

## Task 1: Estender `DatabaseDriver` e `DatabaseConfig`

**Files:**
- Modify: `src/config/types.ts`

- [ ] **Step 1.1: Estender union e tipo**

Modify `src/config/types.ts:1,5-14`:

```ts
export type DatabaseDriver =
  | "mysql"
  | "firebird"
  | "postgresql"
  | "mariadb"
  | "sqlserver"
  | "odbc";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type OdbcDialect = "ansi" | "oracle" | "sybase" | "progress" | "generic";

export interface DatabaseConfig {
  driver: DatabaseDriver;
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
  instance?: string;
  trustServerCertificate?: boolean;
  dsn?: string;
  connectionString?: string;
  dialect?: OdbcDialect;
}
```

- [ ] **Step 1.2: Verificar build TS**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: sem erros.

- [ ] **Step 1.3: Commit**

```bash
git add src/config/types.ts
git commit -m "feat(config): aceita driver odbc e campos dsn/connectionString/dialect"
```

---

## Task 2: Validação de envs ODBC

**Files:**
- Modify: `src/config/env.ts`
- Modify: `tests/config/env.test.ts`

- [ ] **Step 2.1: Escrever testes**

Adicionar em `tests/config/env.test.ts` (após os testes de sqlserver):

```ts
  it("accepts DB_DRIVER=odbc with DB_DSN", () => {
    const env = validEnv({ DB_DRIVER: "odbc", DB_DSN: "LINX_PG" });
    delete env.DB_HOST;
    delete env.DB_PORT;
    delete env.DB_NAME;
    const config = loadConfig(env);
    expect(config.database.driver).toBe("odbc");
    expect(config.database.dsn).toBe("LINX_PG");
  });

  it("accepts DB_DRIVER=odbc with DB_CONNECTION_STRING", () => {
    const env = validEnv({
      DB_DRIVER: "odbc",
      DB_CONNECTION_STRING: "Driver={PostgreSQL Unicode};Server=10.0.0.1;Port=5432;Database=linx;"
    });
    delete env.DB_HOST;
    delete env.DB_PORT;
    delete env.DB_NAME;
    const config = loadConfig(env);
    expect(config.database.connectionString).toContain("Driver=");
  });

  it("accepts DB_DIALECT for odbc", () => {
    const env = validEnv({ DB_DRIVER: "odbc", DB_DSN: "X", DB_DIALECT: "oracle" });
    delete env.DB_HOST;
    delete env.DB_PORT;
    delete env.DB_NAME;
    expect(loadConfig(env).database.dialect).toBe("oracle");
  });

  it("rejects DB_DRIVER=odbc without DB_DSN or DB_CONNECTION_STRING", () => {
    const env = validEnv({ DB_DRIVER: "odbc" });
    delete env.DB_HOST;
    delete env.DB_PORT;
    delete env.DB_NAME;
    try {
      loadConfig(env);
    } catch (error) {
      expect(String(error)).toContain("DB_DSN or DB_CONNECTION_STRING is required");
    }
  });

  it("rejects DB_DSN combined with DB_CONNECTION_STRING", () => {
    const env = validEnv({
      DB_DRIVER: "odbc",
      DB_DSN: "X",
      DB_CONNECTION_STRING: "Driver=X;"
    });
    delete env.DB_HOST;
    delete env.DB_PORT;
    delete env.DB_NAME;
    try {
      loadConfig(env);
    } catch (error) {
      expect(String(error)).toContain("DB_DSN cannot be combined with DB_CONNECTION_STRING");
    }
  });

  it("rejects invalid DB_DIALECT", () => {
    const env = validEnv({ DB_DRIVER: "odbc", DB_DSN: "X", DB_DIALECT: "bogus" });
    delete env.DB_HOST;
    delete env.DB_PORT;
    delete env.DB_NAME;
    try {
      loadConfig(env);
    } catch (error) {
      expect(String(error)).toContain("DB_DIALECT");
    }
  });
```

Atualizar a mensagem esperada no teste `rejects unsupported database drivers`:

```ts
      expect(String(error)).toContain(
        "DB_DRIVER must be mysql, firebird, postgresql, mariadb, sqlserver, or odbc"
      );
```

- [ ] **Step 2.2: Atualizar `DATABASE_DRIVERS` e mensagem**

Modify `src/config/env.ts:32`:

```ts
const DATABASE_DRIVERS = new Set<DatabaseDriver>([
  "mysql",
  "firebird",
  "postgresql",
  "mariadb",
  "sqlserver",
  "odbc"
]);
```

Modify a mensagem de erro:

```ts
issues.push({
  field: "DB_DRIVER",
  message: "must be mysql, firebird, postgresql, mariadb, sqlserver, or odbc"
});
```

- [ ] **Step 2.3: Tratar campos ODBC**

No bloco onde envs são lidos:

```ts
const rawDsn = env.DB_DSN?.trim();
const rawConnString = env.DB_CONNECTION_STRING?.trim();
const rawDialect = env.DB_DIALECT?.trim().toLowerCase();
```

Adicionar validações:

```ts
const VALID_DIALECTS = new Set(["ansi", "oracle", "sybase", "progress", "generic"]);

if (driver === "odbc") {
  if (!rawDsn && !rawConnString) {
    issues.push({
      field: "DB_DSN",
      message: "DB_DSN or DB_CONNECTION_STRING is required when DB_DRIVER=odbc"
    });
  }
  if (rawDsn && rawConnString) {
    issues.push({
      field: "DB_DSN",
      message: "DB_DSN cannot be combined with DB_CONNECTION_STRING"
    });
  }
  if (rawDialect && !VALID_DIALECTS.has(rawDialect)) {
    issues.push({
      field: "DB_DIALECT",
      message: "DB_DIALECT must be ansi, oracle, sybase, progress, or generic"
    });
  }
}
```

Para `odbc`, `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` devem ser opcionais. Localize as validações dessas envs no `loadConfig` e adicione uma cláusula `if (driver !== "odbc")`:

```ts
// procurar pelas validações "is required" das envs DB_HOST/DB_NAME/DB_USER/DB_PASSWORD
// e cercar com:
if (driver !== "odbc") {
  // ...validação atual de DB_HOST is required...
}
```

(Verifique se `REQUIRED_DATABASE_ENV` é usado em loop — pode ser preciso filtrar quando `driver === "odbc"`. Adicione:

```ts
const requiredDbEnv = driver === "odbc" ? [] : REQUIRED_DATABASE_ENV;
```

e use `requiredDbEnv` no loop.)

Estender o objeto `database`:

```ts
const database: DatabaseConfig = {
  driver,
  host: readRequired(env, "DB_HOST") ?? "",
  port: port ?? 0,
  name: readRequired(env, "DB_NAME") ?? "",
  user: readRequired(env, "DB_USER") ?? "",
  password: readRequired(env, "DB_PASSWORD") ?? ""
};

if (rawInstance) database.instance = rawInstance;
if (rawTrustServerCert !== undefined) {
  database.trustServerCertificate = rawTrustServerCert === "true" || rawTrustServerCert === "1";
}
if (rawDsn) database.dsn = rawDsn;
if (rawConnString) database.connectionString = rawConnString;
if (rawDialect && VALID_DIALECTS.has(rawDialect)) {
  database.dialect = rawDialect as DatabaseConfig["dialect"];
}
```

- [ ] **Step 2.4: Rodar — devem passar**

Run: `npx vitest run tests/config/env.test.ts`
Expected: PASS.

- [ ] **Step 2.5: Commit**

```bash
git add src/config/env.ts tests/config/env.test.ts
git commit -m "feat(config): valida dsn/connectionString/dialect para driver odbc"
```

---

## Task 3: Estender `SourceDatabaseAdapterKind`

**Files:**
- Modify: `src/db/source-adapter.ts:35`

- [ ] **Step 3.1: Estender o union**

Modify `src/db/source-adapter.ts:35`:

```ts
export type SourceDatabaseAdapterKind =
  | "mysql"
  | "firebird"
  | "postgresql"
  | "mariadb"
  | "sqlserver"
  | "odbc";
```

- [ ] **Step 3.2: Verificar build**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: sem erros.

- [ ] **Step 3.3: Commit**

```bash
git add src/db/source-adapter.ts
git commit -m "feat(db): aceita odbc em SourceDatabaseAdapterKind"
```

---

## Task 4: Criar `OdbcSourceAdapter` (TDD)

**Files:**
- Create: `tests/db/odbc-adapter.test.ts`
- Create: `src/db/odbc-adapter.ts`

- [ ] **Step 4.1: Escrever testes**

Create `tests/db/odbc-adapter.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { DatabaseOperationError } from "../../src/db/errors.js";
import {
  OdbcSourceAdapter,
  type OdbcDriverConnection
} from "../../src/db/odbc-adapter.js";
import type { DatabaseConfig } from "../../src/config/types.js";

const dsnConfig: DatabaseConfig = {
  driver: "odbc",
  host: "",
  port: 0,
  name: "",
  user: "",
  password: "secret-pass",
  dsn: "LINX_PG"
};

const connStrConfig: DatabaseConfig = {
  driver: "odbc",
  host: "",
  port: 0,
  name: "",
  user: "",
  password: "",
  connectionString: "Driver={PostgreSQL Unicode};Server=10.0.0.1;Port=5432;Database=linx;Uid=ro;Pwd=secret-pass;"
};

describe("OdbcSourceAdapter", () => {
  it("connects using DSN form with user/password", async () => {
    const connection: OdbcDriverConnection = {
      query: vi.fn(async () => []),
      close: vi.fn(async () => undefined)
    };
    const connectionFactory = vi.fn(async () => connection);
    const adapter = new OdbcSourceAdapter({ config: dsnConfig, connectionFactory });

    await adapter.connect();

    expect(connectionFactory).toHaveBeenCalledWith({
      connectionString: "DSN=LINX_PG;UID=;PWD=secret-pass;"
    });
  });

  it("connects using connectionString form verbatim", async () => {
    const connection: OdbcDriverConnection = {
      query: vi.fn(async () => []),
      close: vi.fn(async () => undefined)
    };
    const connectionFactory = vi.fn(async () => connection);
    const adapter = new OdbcSourceAdapter({ config: connStrConfig, connectionFactory });

    await adapter.connect();

    expect(connectionFactory).toHaveBeenCalledWith({
      connectionString: connStrConfig.connectionString
    });
  });

  it("rejects when neither dsn nor connectionString set", async () => {
    const adapter = new OdbcSourceAdapter({
      config: { ...dsnConfig, dsn: undefined },
      connectionFactory: vi.fn(async () => ({
        query: vi.fn(async () => []),
        close: vi.fn(async () => undefined)
      }))
    });
    await expect(adapter.connect()).rejects.toMatchObject({
      name: "DatabaseOperationError",
      driver: "odbc",
      operation: "connect"
    });
  });

  it("uses INFORMATION_SCHEMA for ansi/generic dialect on listTables", async () => {
    const connection: OdbcDriverConnection = {
      query: vi.fn(async () => [{ name: "products" }, { name: "customers" }]),
      close: vi.fn(async () => undefined)
    };
    const adapter = new OdbcSourceAdapter({
      config: { ...dsnConfig, dialect: "ansi" },
      connectionFactory: vi.fn(async () => connection)
    });
    await adapter.connect();
    const tables = await adapter.listTables();
    expect(connection.query).toHaveBeenCalledWith(expect.stringContaining("INFORMATION_SCHEMA.TABLES"));
    expect(tables).toEqual([{ name: "customers" }, { name: "products" }]);
  });

  it("uses ALL_TABLES for oracle dialect", async () => {
    const connection: OdbcDriverConnection = {
      query: vi.fn(async () => [{ name: "PRODUCTS" }]),
      close: vi.fn(async () => undefined)
    };
    const adapter = new OdbcSourceAdapter({
      config: { ...dsnConfig, dialect: "oracle" },
      connectionFactory: vi.fn(async () => connection)
    });
    await adapter.connect();
    await adapter.listTables();
    expect(connection.query).toHaveBeenCalledWith(expect.stringContaining("ALL_TABLES"));
  });

  it("uses sysobjects for sybase dialect", async () => {
    const connection: OdbcDriverConnection = {
      query: vi.fn(async () => []),
      close: vi.fn(async () => undefined)
    };
    const adapter = new OdbcSourceAdapter({
      config: { ...dsnConfig, dialect: "sybase" },
      connectionFactory: vi.fn(async () => connection)
    });
    await adapter.connect();
    await adapter.listTables();
    expect(connection.query).toHaveBeenCalledWith(expect.stringContaining("sysobjects"));
  });

  it("uses Progress catalog for progress dialect", async () => {
    const connection: OdbcDriverConnection = {
      query: vi.fn(async () => []),
      close: vi.fn(async () => undefined)
    };
    const adapter = new OdbcSourceAdapter({
      config: { ...dsnConfig, dialect: "progress" },
      connectionFactory: vi.fn(async () => connection)
    });
    await adapter.connect();
    await adapter.listTables();
    expect(connection.query).toHaveBeenCalledWith(expect.stringContaining("SYSTEM TABLES PROGRESS"));
  });

  it("queryChanges passes SQL with positional params [cursor, limit]", async () => {
    const connection: OdbcDriverConnection = {
      query: vi.fn(async () => [{ id: 1 }]),
      close: vi.fn(async () => undefined)
    };
    const adapter = new OdbcSourceAdapter({
      config: dsnConfig,
      connectionFactory: vi.fn(async () => connection)
    });
    await adapter.connect();
    await adapter.queryChanges({
      sql: "select * from products where updated_at > ? limit ?",
      cursor: 10,
      limit: 25
    });
    expect(connection.query).toHaveBeenCalledWith(
      "select * from products where updated_at > ? limit ?",
      [10, 25]
    );
  });

  it("querySnapshotPage passes SQL with positional params [limit, offset]", async () => {
    const connection: OdbcDriverConnection = {
      query: vi.fn(async () => []),
      close: vi.fn(async () => undefined)
    };
    const adapter = new OdbcSourceAdapter({
      config: dsnConfig,
      connectionFactory: vi.fn(async () => connection)
    });
    await adapter.connect();
    await adapter.querySnapshotPage({ sql: "select * from p limit ? offset ?", limit: 500, offset: 1000 });
    expect(connection.query).toHaveBeenCalledWith("select * from p limit ? offset ?", [500, 1000]);
  });

  it("normalizes connection failures without leaking password", async () => {
    const adapter = new OdbcSourceAdapter({
      config: dsnConfig,
      connectionFactory: vi.fn(async () => {
        throw Object.assign(new Error("ODBC: Login failed using secret-pass"), { state: "28000" });
      })
    });
    try {
      await adapter.connect();
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseOperationError);
      expect(String(error)).not.toContain("secret-pass");
      expect(String(error)).toContain("[REDACTED]");
    }
  });

  it("closes connection on close()", async () => {
    const close = vi.fn(async () => undefined);
    const adapter = new OdbcSourceAdapter({
      config: dsnConfig,
      connectionFactory: vi.fn(async () => ({ query: vi.fn(async () => []), close }))
    });
    await adapter.connect();
    await adapter.close();
    await adapter.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 4.2: Rodar — devem falhar**

Run: `npx vitest run tests/db/odbc-adapter.test.ts`
Expected: FAIL — `Cannot find module`.

- [ ] **Step 4.3: Implementar `odbc-adapter.ts`**

Create `src/db/odbc-adapter.ts`:

```ts
import type { DatabaseConfig, OdbcDialect } from "../config/types.js";
import type { SourceRow } from "../mapping/types.js";
import type { DatabaseOperation } from "./errors.js";
import { normalizeDatabaseError } from "./errors.js";
import type {
  DatabaseColumn,
  DatabaseTable,
  QueryChangesInput,
  QuerySnapshotPageInput,
  SourceDatabaseAdapter
} from "./source-adapter.js";

export interface OdbcConnectionConfig {
  connectionString: string;
}

export interface OdbcDriverConnection {
  query(sql: string, params?: readonly unknown[]): Promise<unknown>;
  close(): Promise<void>;
}

export type OdbcConnectionFactory = (
  config: OdbcConnectionConfig
) => Promise<OdbcDriverConnection>;

export interface OdbcSourceAdapterOptions {
  config: DatabaseConfig;
  connectionFactory: OdbcConnectionFactory;
  secrets?: readonly string[];
}

export class OdbcSourceAdapter implements SourceDatabaseAdapter {
  private readonly config: DatabaseConfig;
  private readonly connectionFactory: OdbcConnectionFactory;
  private readonly secrets: readonly string[];
  private connection?: OdbcDriverConnection;

  public constructor(options: OdbcSourceAdapterOptions) {
    this.config = options.config;
    this.connectionFactory = options.connectionFactory;
    this.secrets = options.secrets ?? [options.config.password].filter((s) => s && s.length > 0);
  }

  public async connect(): Promise<void> {
    try {
      const connectionString = this.buildConnectionString();
      this.connection = await this.connectionFactory({ connectionString });
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "odbc",
        operation: "connect",
        error,
        secrets: this.secrets
      });
    }
  }

  public async close(): Promise<void> {
    if (!this.connection) return;
    try {
      await this.connection.close();
      this.connection = undefined;
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "odbc",
        operation: "close",
        error,
        secrets: this.secrets
      });
    }
  }

  public async queryChanges(input: QueryChangesInput): Promise<SourceRow[]> {
    const connection = this.requireConnection();
    try {
      const result = await connection.query(input.sql, [normalizeCursorParam(input.cursor), input.limit]);
      return normalizeRows(result);
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "odbc",
        operation: "query",
        error,
        secrets: this.secrets
      });
    }
  }

  public async querySnapshotPage(input: QuerySnapshotPageInput): Promise<SourceRow[]> {
    const connection = this.requireConnection();
    try {
      const result = await connection.query(input.sql, [input.limit, input.offset]);
      return normalizeRows(result);
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "odbc",
        operation: "query",
        error,
        secrets: this.secrets
      });
    }
  }

  public async listTables(): Promise<DatabaseTable[]> {
    const connection = this.requireConnection();
    try {
      const sql = listTablesSqlForDialect(this.config.dialect ?? "generic");
      const result = await connection.query(sql);
      return normalizeTables(result);
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "odbc",
        operation: "listTables",
        error,
        secrets: this.secrets
      });
    }
  }

  public async listColumns(tableName: string): Promise<DatabaseColumn[]> {
    const connection = this.requireConnection("listColumns");
    try {
      const sql = listColumnsSqlForDialect(this.config.dialect ?? "generic", tableName);
      const result = await connection.query(sql);
      return normalizeColumns(result);
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "odbc",
        operation: "listColumns",
        error,
        secrets: this.secrets
      });
    }
  }

  private buildConnectionString(): string {
    if (this.config.connectionString) return this.config.connectionString;
    if (this.config.dsn) {
      return `DSN=${this.config.dsn};UID=${this.config.user};PWD=${this.config.password};`;
    }
    throw new Error("odbc adapter requires either dsn or connectionString");
  }

  private requireConnection(operation: DatabaseOperation = "query"): OdbcDriverConnection {
    if (!this.connection) {
      throw normalizeDatabaseError({
        driver: "odbc",
        operation,
        error: new Error("Database adapter is not connected"),
        secrets: this.secrets
      });
    }
    return this.connection;
  }
}

function listTablesSqlForDialect(dialect: OdbcDialect): string {
  switch (dialect) {
    case "oracle":
      return "SELECT TABLE_NAME AS name FROM ALL_TABLES ORDER BY TABLE_NAME";
    case "sybase":
      return "SELECT name FROM sysobjects WHERE type='U' ORDER BY name";
    case "progress":
      return "SELECT _File-Name AS name FROM SYSTEM TABLES PROGRESS WHERE _Tbl-Type = 'T' ORDER BY _File-Name";
    case "ansi":
    case "generic":
    default:
      return "SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME";
  }
}

function listColumnsSqlForDialect(dialect: OdbcDialect, tableName: string): string {
  const escaped = tableName.replace(/'/g, "''");
  switch (dialect) {
    case "oracle":
      return `SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType, NULLABLE AS nullable FROM ALL_TAB_COLUMNS WHERE TABLE_NAME = '${escaped}' ORDER BY COLUMN_ID`;
    case "sybase":
      return `SELECT c.name AS name, t.name AS dataType, c.allow_null AS nullable FROM syscolumns c JOIN systypes t ON c.usertype=t.usertype WHERE id = OBJECT_ID('${escaped}') ORDER BY c.colid`;
    case "progress":
      return `SELECT _Field-Name AS name, _Data-Type AS dataType FROM SYSTEM COLUMNS PROGRESS WHERE _File-Name = '${escaped}'`;
    case "ansi":
    case "generic":
    default:
      return `SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType, IS_NULLABLE AS nullable FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${escaped}' ORDER BY ORDINAL_POSITION`;
  }
}

function normalizeRows(result: unknown): SourceRow[] {
  if (!Array.isArray(result)) return [];
  return result.filter(isRecord).map((r) => ({ ...r }));
}

function normalizeTables(result: unknown): DatabaseTable[] {
  if (!Array.isArray(result)) return [];
  return result
    .map(readName)
    .filter((n): n is string => n !== undefined)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name }));
}

function normalizeColumns(result: unknown): DatabaseColumn[] {
  if (!Array.isArray(result)) return [];
  return result
    .map((row) => {
      if (!isRecord(row)) return undefined;
      const name = normalizeString(row.name);
      if (!name) return undefined;
      return {
        name,
        dataType: normalizeOptionalString(row.dataType),
        nullable: normalizeNullable(row.nullable)
      };
    })
    .filter((c): c is DatabaseColumn => c !== undefined);
}

function readName(row: unknown): string | undefined {
  if (!isRecord(row)) return undefined;
  const value = row.name;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is SourceRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  const normalized = normalizeString(value);
  return normalized?.toLowerCase();
}

function normalizeNullable(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "yes":
    case "y":
    case "true":
    case "1":
      return true;
    case "no":
    case "n":
    case "false":
    case "0":
      return false;
    default:
      return undefined;
  }
}

function normalizeCursorParam(value: QueryChangesInput["cursor"]): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsedAt = Date.parse(trimmed);
  return Number.isNaN(parsedAt) ? trimmed : new Date(parsedAt);
}
```

- [ ] **Step 4.4: Rodar — devem passar**

Run: `npx vitest run tests/db/odbc-adapter.test.ts`
Expected: PASS.

- [ ] **Step 4.5: Commit**

```bash
git add src/db/odbc-adapter.ts tests/db/odbc-adapter.test.ts
git commit -m "feat(db): adiciona OdbcSourceAdapter com dialect por engine"
```

---

## Task 5: Adicionar case `odbc` no factory

**Files:**
- Modify: `tests/db/adapter-factory.test.ts`
- Modify: `src/db/adapter-factory.ts`

- [ ] **Step 5.1: Atualizar teste**

Adicionar import:

```ts
import { OdbcSourceAdapter } from "../../src/db/odbc-adapter.js";
```

Adicionar config:

```ts
const odbcConfig: DatabaseConfig = {
  ...mysqlConfig,
  driver: "odbc",
  dsn: "LINX_PG"
};
```

Atualizar `dependencies`:

```ts
const dependencies = () => ({
  mysqlConnectionFactory: vi.fn(),
  firebirdConnectionFactory: vi.fn(),
  postgresConnectionFactory: vi.fn(),
  mariadbConnectionFactory: vi.fn(),
  sqlserverConnectionFactory: vi.fn(),
  odbcConnectionFactory: vi.fn()
});
```

Caso novo:

```ts
  it("returns ODBC adapter when DB_DRIVER=odbc", () => {
    const adapter = createSourceDatabaseAdapter({
      config: odbcConfig,
      dependencies: dependencies()
    });
    expect(adapter).toBeInstanceOf(OdbcSourceAdapter);
  });
```

- [ ] **Step 5.2: Atualizar factory**

Modify `src/db/adapter-factory.ts`:

Import:

```ts
import { OdbcSourceAdapter, type OdbcConnectionFactory } from "./odbc-adapter.js";
```

Estender deps:

```ts
export interface AdapterFactoryDependencies {
  mysqlConnectionFactory: MySqlConnectionFactory;
  firebirdConnectionFactory: FirebirdConnectionFactory;
  postgresConnectionFactory: PostgresConnectionFactory;
  mariadbConnectionFactory: MariaDbConnectionFactory;
  sqlserverConnectionFactory: SqlServerConnectionFactory;
  odbcConnectionFactory: OdbcConnectionFactory;
}
```

Case novo:

```ts
    case "odbc":
      return new OdbcSourceAdapter({
        config: input.config,
        connectionFactory: input.dependencies.odbcConnectionFactory,
        secrets: input.secrets
      });
```

- [ ] **Step 5.3: Rodar — devem passar**

Run: `npx vitest run tests/db/adapter-factory.test.ts`
Expected: PASS.

- [ ] **Step 5.4: Commit**

```bash
git add src/db/adapter-factory.ts tests/db/adapter-factory.test.ts
git commit -m "feat(db): factory cria OdbcSourceAdapter para driver odbc"
```

---

## Task 6: Wiring no runtime + dep `odbc`

**Files:**
- Modify: `package.json` (`optionalDependencies`)
- Modify: `src/service/runtime.ts`

- [ ] **Step 6.1: Adicionar dep `odbc`**

Run: `npm install --save-optional odbc`
Expected: pacote adicionado em `optionalDependencies` (versão ~2.x). Se for adicionado em `dependencies`, mover manualmente para `optionalDependencies`.

- [ ] **Step 6.2: Registrar `odbcConnectionFactory` no runtime**

Modify `src/service/runtime.ts` — adicionar factory dentro de `createOptionalDriverDependencies` (após `sqlserverConnectionFactory`):

```ts
    odbcConnectionFactory: async (config) => {
      const odbc = await optionalImport("odbc");
      const connect = odbc.connect ?? odbc.default?.connect;
      const connection = await connect(config.connectionString);
      return {
        query: async (sql: string, params?: readonly unknown[]) => {
          const result = await connection.query(sql, params ? [...params] : undefined);
          return result;
        },
        close: () => connection.close()
      };
    }
```

- [ ] **Step 6.3: Verificar build**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: sem erros.

- [ ] **Step 6.4: Rodar suite completa**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6.5: Commit**

```bash
git add package.json package-lock.json src/service/runtime.ts
git commit -m "feat(runtime): wiring do driver odbc com pacote node-odbc"
```

---

## Task 7: Atualizar README

**Files:**
- Modify: `README.md`

- [ ] **Step 7.1: Documentar driver odbc**

Adicionar na seção de drivers suportados:

```md
- **ODBC genérico** (`DB_DRIVER=odbc`) — fallback para engines de cauda longa
  (Oracle, Sybase Advantage, Progress, Interbase, DB2, etc.) com driver ODBC
  instalado no Windows. Configurar com `DB_DSN=<nome_dsn>` ou
  `DB_CONNECTION_STRING="Driver={...};Server=...;"`, e opcionalmente
  `DB_DIALECT=ansi|oracle|sybase|progress|generic` (default `generic`).
  Build do pacote `odbc` requer ferramentas de compilação (`windows-build-tools`
  em Windows, `python3 build-essential` em Linux).
```

- [ ] **Step 7.2: Commit**

```bash
git add README.md
git commit -m "docs: README documenta driver odbc com dsn e connectionString"
```

---

## Verificação final

- [ ] **Step F.1: Rodar suite completa**

Run: `npm test`
Expected: 0 failures.

- [ ] **Step F.2: Build de produção**

Run: `npm run build`
Expected: 0 erros TS.

- [ ] **Step F.3: Verificar git log**

Run: `git log --oneline -10`
Expected: 7 commits criados na ordem das tasks.
