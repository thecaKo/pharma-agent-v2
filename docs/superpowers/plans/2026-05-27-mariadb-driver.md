# Driver MariaDB Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar suporte ao MariaDB como driver de banco de origem distinto (`DB_DRIVER=mariadb`), com adapter próprio usando o pacote `mariadb` oficial.

**Architecture:** Novo `MariaDbSourceAdapter` em arquivo independente, espelhando estrutura do `MySqlSourceAdapter`. Factory atualizado com novo case. Configuração apenas via `.env` (CLI database-setup e file-discovery ficam fora de escopo). Conexão única, sem pool, sem SSL, paridade exata com MySQL adapter.

**Tech Stack:** TypeScript (ESM), vitest, pacote npm `mariadb` (oficial), Node 20+.

**Spec:** `docs/superpowers/specs/2026-05-27-mariadb-driver-design.md`

---

## File Structure

**Novos arquivos:**
- `src/db/mariadb-adapter.ts` — adapter, tipos e connection factory interface
- `tests/db/mariadb-adapter.test.ts` — testes unitários do adapter

**Modificados:**
- `src/config/types.ts` — estende union `DatabaseDriver`
- `src/config/env.ts` — adiciona `"mariadb"` no set + mensagem de erro
- `src/db/source-adapter.ts` — estende union `SourceDatabaseAdapterKind`
- `src/db/adapter-factory.ts` — novo case + dependência `mariadbConnectionFactory`
- `src/service/runtime.ts` — wiring da connection factory usando pacote `mariadb`
- `tests/config/env.test.ts` — caso de aceite `DB_DRIVER=mariadb` + mensagem
- `tests/db/adapter-factory.test.ts` — caso `driver: "mariadb"` + dependencies
- `package.json` — adiciona dependência `mariadb`

**Não muda:** `src/db/errors.ts` (usa `DatabaseDriver` direto do types.ts), `src/db/file-discovery.ts`, `src/cli/database-setup.ts`.

---

## Task 1: Estender union `DatabaseDriver` e validação `DB_DRIVER`

**Files:**
- Modify: `src/config/types.ts:1`
- Modify: `src/config/env.ts:32,131`
- Modify: `tests/config/env.test.ts:77-93`

- [ ] **Step 1.1: Atualizar o teste de aceite do driver e a mensagem de erro**

Modify `tests/config/env.test.ts` — adicionar caso novo após o teste de `postgresql` (depois da linha 82) e atualizar a string esperada na linha 89:

```ts
  it("accepts mariadb as a valid DB_DRIVER", () => {
    const config = loadConfig(validEnv({ DB_DRIVER: "mariadb", DB_PORT: "3306" }));

    expect(config.database.driver).toBe("mariadb");
    expect(config.database.port).toBe(3306);
  });

  it("rejects unsupported database drivers with a descriptive non-secret error", () => {
    try {
      loadConfig(validEnv({ DB_DRIVER: "oracle" }));
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(String(error)).toContain("DB_DRIVER must be mysql, firebird, postgresql, or mariadb");
      expect(String(error)).not.toContain("test-connector-token");
      expect(String(error)).not.toContain("test-db-password");
    }
  });
```

- [ ] **Step 1.2: Rodar os testes — devem falhar**

Run: `npx vitest run tests/config/env.test.ts`
Expected: 2 failures — "accepts mariadb" (DB_DRIVER must be mysql, firebird, or postgresql) e "rejects unsupported" (string mismatch).

- [ ] **Step 1.3: Estender o union `DatabaseDriver`**

Modify `src/config/types.ts:1`:

```ts
export type DatabaseDriver = "mysql" | "firebird" | "postgresql" | "mariadb";
```

- [ ] **Step 1.4: Atualizar o set e a mensagem em `env.ts`**

Modify `src/config/env.ts:32`:

```ts
const DATABASE_DRIVERS = new Set<DatabaseDriver>(["mysql", "firebird", "postgresql", "mariadb"]);
```

Modify `src/config/env.ts:131`:

```ts
issues.push({ field: "DB_DRIVER", message: "must be mysql, firebird, postgresql, or mariadb" });
```

- [ ] **Step 1.5: Rodar testes — devem passar**

Run: `npx vitest run tests/config/env.test.ts`
Expected: PASS para todos.

- [ ] **Step 1.6: Commit**

```bash
git add src/config/types.ts src/config/env.ts tests/config/env.test.ts
git commit -m "feat(config): aceita driver mariadb no DB_DRIVER"
```

---

## Task 2: Estender `SourceDatabaseAdapterKind`

**Files:**
- Modify: `src/db/source-adapter.ts:35`

- [ ] **Step 2.1: Estender o union**

Modify `src/db/source-adapter.ts:35`:

```ts
export type SourceDatabaseAdapterKind = "mysql" | "firebird" | "postgresql" | "mariadb";
```

- [ ] **Step 2.2: Verificar build TS**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: sem erros novos.

- [ ] **Step 2.3: Commit**

```bash
git add src/db/source-adapter.ts
git commit -m "feat(db): aceita mariadb em SourceDatabaseAdapterKind"
```

---

## Task 3: Criar `MariaDbSourceAdapter` (TDD)

**Files:**
- Create: `tests/db/mariadb-adapter.test.ts`
- Create: `src/db/mariadb-adapter.ts`

- [ ] **Step 3.1: Escrever o arquivo de teste completo**

Create `tests/db/mariadb-adapter.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { DatabaseOperationError } from "../../src/db/errors.js";
import { MariaDbSourceAdapter, type MariaDbDriverConnection } from "../../src/db/mariadb-adapter.js";
import type { DatabaseConfig } from "../../src/config/types.js";

const config: DatabaseConfig = {
  driver: "mariadb",
  host: "127.0.0.1",
  port: 3306,
  name: "pharmacy",
  user: "readonly",
  password: "super-secret-password"
};

describe("MariaDbSourceAdapter", () => {
  it("passes configured SQL, cursor, and limit to the database driver boundary", async () => {
    const connection: MariaDbDriverConnection = {
      query: vi.fn(async () => [{ product_id: "P-001", updated_at: 12 }]),
      end: vi.fn(async () => undefined)
    };
    const connectionFactory = vi.fn(async () => connection);
    const adapter = new MariaDbSourceAdapter({ config, connectionFactory });

    await adapter.connect();
    const rows = await adapter.queryChanges({
      sql: "select * from products where updated_at > ? limit ?",
      cursor: 10,
      limit: 25
    });

    expect(connectionFactory).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 3306,
      database: "pharmacy",
      user: "readonly",
      password: "super-secret-password",
      readonly: true
    });
    expect(connection.query).toHaveBeenCalledWith("select * from products where updated_at > ? limit ?", [10, 25]);
    expect(rows).toEqual([{ product_id: "P-001", updated_at: 12 }]);
  });

  it("queries snapshot pages with limit and offset", async () => {
    const connection: MariaDbDriverConnection = {
      query: vi.fn(async () => [{ product_id: "P-001" }]),
      end: vi.fn(async () => undefined)
    };
    const adapter = new MariaDbSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    await expect(
      adapter.querySnapshotPage({
        sql: "select * from products order by product_id limit ? offset ?",
        limit: 500,
        offset: 1000
      })
    ).resolves.toEqual([{ product_id: "P-001" }]);

    expect(connection.query).toHaveBeenCalledWith(
      "select * from products order by product_id limit ? offset ?",
      [500, 1000]
    );
  });

  it("coerces timestamp cursor strings into Date values for mariadb datetime parameters", async () => {
    const connection: MariaDbDriverConnection = {
      query: vi.fn(async () => [{ product_id: "P-001", updated_at: "2026-05-16 20:00:03" }]),
      end: vi.fn(async () => undefined)
    };
    const adapter = new MariaDbSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    await adapter.queryChanges({
      sql: "select * from products where updated_at > ? limit ?",
      cursor: "Sat May 16 2026 20:00:02 GMT-0300 (Brasilia Standard Time)",
      limit: 25
    });

    expect(connection.query).toHaveBeenCalledWith("select * from products where updated_at > ? limit ?", [
      expect.any(Date),
      25
    ]);
  });

  it("queries table metadata and returns only sorted table names", async () => {
    const connection: MariaDbDriverConnection = {
      query: vi.fn(async () => [
        { name: "z_products", column_count: 12 },
        { name: "customers", row_count: 99 },
        { name: "products", sample: { product_id: "P-001" } }
      ]),
      end: vi.fn(async () => undefined)
    };
    const adapter = new MariaDbSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    const tables = await adapter.listTables();

    expect(connection.query).toHaveBeenCalledWith(expect.stringContaining("information_schema.tables"), ["pharmacy"]);
    expect(connection.query).toHaveBeenCalledWith(expect.stringContaining("table_type = 'BASE TABLE'"), ["pharmacy"]);
    expect(tables).toEqual([{ name: "customers" }, { name: "products" }, { name: "z_products" }]);
  });

  it("returns an empty table list when metadata rows are not in the expected shape", async () => {
    const connection: MariaDbDriverConnection = {
      query: vi.fn(async () => [{ table: "products" }, { name: 123 }, null]),
      end: vi.fn(async () => undefined)
    };
    const adapter = new MariaDbSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();

    await expect(adapter.listTables()).resolves.toEqual([]);
  });

  it("queries column metadata for the configured schema and selected table", async () => {
    const connection: MariaDbDriverConnection = {
      query: vi.fn(async () => [
        { name: " PRODUCT_ID ", dataType: "VARCHAR", nullable: "NO", extra: "ignored" },
        { COLUMN_NAME: "updated_at", DATA_TYPE: "DATETIME", IS_NULLABLE: "YES" },
        { name: "stock", dataType: " int ", nullable: true }
      ]),
      end: vi.fn(async () => undefined)
    };
    const adapter = new MariaDbSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    const columns = await adapter.listColumns("products");

    expect(connection.query).toHaveBeenCalledWith(expect.stringContaining("information_schema.columns"), [
      "pharmacy",
      "products"
    ]);
    expect(connection.query).toHaveBeenCalledWith(expect.stringContaining("table_name = ?"), ["pharmacy", "products"]);
    expect(columns).toEqual([
      { name: "PRODUCT_ID", dataType: "varchar", nullable: false },
      { name: "updated_at", dataType: "datetime", nullable: true },
      { name: "stock", dataType: "int", nullable: true }
    ]);
  });

  it("also normalizes responses returned as mysql2-style tuple", async () => {
    const connection: MariaDbDriverConnection = {
      query: vi.fn(async () => [[{ name: "products" }, { name: "customers" }], []]),
      end: vi.fn(async () => undefined)
    };
    const adapter = new MariaDbSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    const tables = await adapter.listTables();

    expect(tables).toEqual([{ name: "customers" }, { name: "products" }]);
  });

  it("normalizes discovery failures without leaking database password or name", async () => {
    const connection: MariaDbDriverConnection = {
      query: vi.fn(async () => {
        throw Object.assign(new Error("Cannot inspect pharmacy using super-secret-password"), {
          code: "ER_TABLEACCESS_DENIED_ERROR"
        });
      }),
      end: vi.fn(async () => undefined)
    };
    const adapter = new MariaDbSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();

    try {
      await adapter.listTables();
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseOperationError);
      expect(error).toMatchObject({
        driver: "mariadb",
        operation: "listTables",
        errorCode: "MARIADB_ER_TABLEACCESS_DENIED_ERROR"
      });
      expect(String(error)).not.toContain("super-secret-password");
      expect(String(error)).not.toContain("pharmacy");
      expect(String(error)).toContain("[REDACTED]");
    }
  });

  it("normalizes column discovery failures without leaking database password or name", async () => {
    const connection: MariaDbDriverConnection = {
      query: vi.fn(async () => {
        throw Object.assign(new Error("Cannot inspect pharmacy.products using super-secret-password"), {
          code: "ER_BAD_FIELD_ERROR"
        });
      }),
      end: vi.fn(async () => undefined)
    };
    const adapter = new MariaDbSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();

    try {
      await adapter.listColumns("products");
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseOperationError);
      expect(error).toMatchObject({
        driver: "mariadb",
        operation: "listColumns",
        errorCode: "MARIADB_ER_BAD_FIELD_ERROR"
      });
      expect(String(error)).not.toContain("super-secret-password");
      expect(String(error)).not.toContain("pharmacy");
      expect(String(error)).toContain("[REDACTED]");
    }
  });

  it("normalizes connection failures without leaking database password", async () => {
    const adapter = new MariaDbSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => {
        throw Object.assign(new Error("Access denied for super-secret-password"), { code: "ER_ACCESS_DENIED_ERROR" });
      })
    });

    await expect(adapter.connect()).rejects.toMatchObject({
      name: "DatabaseOperationError",
      driver: "mariadb",
      operation: "connect",
      errorCode: "MARIADB_ER_ACCESS_DENIED_ERROR"
    });

    try {
      await adapter.connect();
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseOperationError);
      expect(String(error)).not.toContain("super-secret-password");
      expect(String(error)).toContain("[REDACTED]");
    }
  });

  it("closes connected sessions and normalizes query before connect", async () => {
    const connection: MariaDbDriverConnection = {
      query: vi.fn(async () => []),
      end: vi.fn(async () => undefined)
    };
    const adapter = new MariaDbSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    await adapter.close();
    await adapter.close();

    expect(connection.end).toHaveBeenCalledOnce();

    await expect(adapter.queryChanges({ sql: "select 1", cursor: null, limit: 1 })).rejects.toMatchObject({
      driver: "mariadb",
      operation: "query",
      errorCode: "MARIADB_DATABASE_ERROR"
    });
  });

  it("normalizes close failures", async () => {
    const adapter = new MariaDbSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => ({
        query: vi.fn(async () => []),
        end: vi.fn(async () => {
          throw Object.assign(new Error("connection close timeout"), { code: "ETIMEDOUT" });
        })
      }))
    });

    await adapter.connect();

    await expect(adapter.close()).rejects.toMatchObject({
      driver: "mariadb",
      operation: "close",
      errorCode: "MARIADB_ETIMEDOUT",
      retryable: true
    });
  });
});
```

- [ ] **Step 3.2: Rodar testes — devem falhar com módulo não encontrado**

Run: `npx vitest run tests/db/mariadb-adapter.test.ts`
Expected: FAIL — `Cannot find module '../../src/db/mariadb-adapter.js'`.

- [ ] **Step 3.3: Implementar `mariadb-adapter.ts`**

Create `src/db/mariadb-adapter.ts`:

```ts
import type { DatabaseConfig } from "../config/types.js";
import type { SourceRow } from "../mapping/types.js";
import type { DatabaseOperation } from "./errors.js";
import { normalizeDatabaseError } from "./errors.js";
import type { DatabaseColumn, DatabaseTable, QueryChangesInput, QuerySnapshotPageInput, SourceDatabaseAdapter } from "./source-adapter.js";

export interface MariaDbConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  readonly: true;
}

export interface MariaDbDriverConnection {
  query(sql: string, params: readonly unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

export type MariaDbConnectionFactory = (config: MariaDbConnectionConfig) => Promise<MariaDbDriverConnection>;

export interface MariaDbSourceAdapterOptions {
  config: DatabaseConfig;
  connectionFactory: MariaDbConnectionFactory;
  secrets?: readonly string[];
}

export class MariaDbSourceAdapter implements SourceDatabaseAdapter {
  private readonly config: DatabaseConfig;
  private readonly connectionFactory: MariaDbConnectionFactory;
  private readonly secrets: readonly string[];
  private connection?: MariaDbDriverConnection;

  public constructor(options: MariaDbSourceAdapterOptions) {
    this.config = options.config;
    this.connectionFactory = options.connectionFactory;
    this.secrets = options.secrets ?? [options.config.password, options.config.name];
  }

  public async connect(): Promise<void> {
    try {
      this.connection = await this.connectionFactory({
        host: this.config.host,
        port: this.config.port,
        database: this.config.name,
        user: this.config.user,
        password: this.config.password,
        readonly: true
      });
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "mariadb",
        operation: "connect",
        error,
        secrets: this.secrets
      });
    }
  }

  public async close(): Promise<void> {
    if (!this.connection) {
      return;
    }
    try {
      await this.connection.end();
      this.connection = undefined;
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "mariadb",
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
        driver: "mariadb",
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
        driver: "mariadb",
        operation: "query",
        error,
        secrets: this.secrets
      });
    }
  }

  public async listTables(): Promise<DatabaseTable[]> {
    const connection = this.requireConnection();

    try {
      const result = await connection.query(
        `
          select table_name as name
          from information_schema.tables
          where table_schema = ?
            and table_type = 'BASE TABLE'
          order by table_name
        `,
        [this.config.name]
      );
      return normalizeTables(result);
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "mariadb",
        operation: "listTables",
        error,
        secrets: this.secrets
      });
    }
  }

  public async listColumns(tableName: string): Promise<DatabaseColumn[]> {
    const connection = this.requireConnection("listColumns");

    try {
      const result = await connection.query(
        `
          select column_name as name,
                 data_type as dataType,
                 is_nullable as nullable
          from information_schema.columns
          where table_schema = ?
            and table_name = ?
          order by ordinal_position
        `,
        [this.config.name, tableName]
      );
      return normalizeColumns(result);
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "mariadb",
        operation: "listColumns",
        error,
        secrets: this.secrets
      });
    }
  }

  private requireConnection(operation: DatabaseOperation = "query"): MariaDbDriverConnection {
    if (!this.connection) {
      throw normalizeDatabaseError({
        driver: "mariadb",
        operation,
        error: new Error("Database adapter is not connected"),
        secrets: this.secrets
      });
    }
    return this.connection;
  }
}

function normalizeRows(result: unknown): SourceRow[] {
  const rows = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.filter(isRecord).map((row) => ({ ...row }));
}

function normalizeTables(result: unknown): DatabaseTable[] {
  const rows = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows
    .map(readTableName)
    .filter((name): name is string => name !== undefined)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({ name }));
}

function normalizeColumns(result: unknown): DatabaseColumn[] {
  const rows = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows
    .map(readColumn)
    .filter((column): column is DatabaseColumn => column !== undefined);
}

function readTableName(row: unknown): string | undefined {
  if (!isRecord(row)) {
    return undefined;
  }

  const value = row.name ?? row.TABLE_NAME;
  if (typeof value !== "string") {
    return undefined;
  }

  const name = value.trim();
  return name.length > 0 ? name : undefined;
}

function readColumn(row: unknown): DatabaseColumn | undefined {
  if (!isRecord(row)) {
    return undefined;
  }

  const name = normalizeString(row.name ?? row.COLUMN_NAME);
  if (!name) {
    return undefined;
  }

  return {
    name,
    dataType: normalizeOptionalString(row.dataType ?? row.DATA_TYPE),
    nullable: normalizeNullable(row.nullable ?? row.IS_NULLABLE)
  };
}

function isRecord(value: unknown): value is SourceRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  const normalized = normalizeString(value);
  return normalized?.toLowerCase();
}

function normalizeNullable(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  if (typeof value !== "string") {
    return undefined;
  }

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
  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    return null;
  }

  const parsedAt = Date.parse(normalized);
  return Number.isNaN(parsedAt) ? normalized : new Date(parsedAt);
}
```

- [ ] **Step 3.4: Rodar testes — devem passar**

Run: `npx vitest run tests/db/mariadb-adapter.test.ts`
Expected: PASS para todos.

- [ ] **Step 3.5: Commit**

```bash
git add src/db/mariadb-adapter.ts tests/db/mariadb-adapter.test.ts
git commit -m "feat(db): adiciona MariaDbSourceAdapter"
```

---

## Task 4: Adicionar case `mariadb` no `adapter-factory`

**Files:**
- Modify: `tests/db/adapter-factory.test.ts`
- Modify: `src/db/adapter-factory.ts`

- [ ] **Step 4.1: Atualizar o teste do factory**

Modify `tests/db/adapter-factory.test.ts`:

Adicionar import na linha 5:

```ts
import { MariaDbSourceAdapter } from "../../src/db/mariadb-adapter.js";
```

Adicionar config após `postgresConfig` (linha 27):

```ts
const mariadbConfig: DatabaseConfig = {
  ...mysqlConfig,
  driver: "mariadb",
  port: 3306
};
```

Atualizar `dependencies` (linha 29-33):

```ts
const dependencies = () => ({
  mysqlConnectionFactory: vi.fn(),
  firebirdConnectionFactory: vi.fn(),
  postgresConnectionFactory: vi.fn(),
  mariadbConnectionFactory: vi.fn()
});
```

Adicionar caso de teste após o de Postgres (depois da linha 58):

```ts
  it("returns MariaDB adapter when DB_DRIVER=mariadb", () => {
    const adapter = createSourceDatabaseAdapter({
      config: mariadbConfig,
      dependencies: dependencies()
    });
    expect(adapter).toBeInstanceOf(MariaDbSourceAdapter);
  });
```

- [ ] **Step 4.2: Rodar — devem falhar (mariadbConnectionFactory desconhecido, caso `"mariadb"` cai no default)**

Run: `npx vitest run tests/db/adapter-factory.test.ts`
Expected: FAIL — TS error em `mariadbConnectionFactory` extra ou `UnsupportedDatabaseDriverError` lançado.

- [ ] **Step 4.3: Atualizar o factory**

Modify `src/db/adapter-factory.ts`:

Adicionar import junto aos outros (após linha 3):

```ts
import { MariaDbSourceAdapter, type MariaDbConnectionFactory } from "./mariadb-adapter.js";
```

Estender `AdapterFactoryDependencies`:

```ts
export interface AdapterFactoryDependencies {
  mysqlConnectionFactory: MySqlConnectionFactory;
  firebirdConnectionFactory: FirebirdConnectionFactory;
  postgresConnectionFactory: PostgresConnectionFactory;
  mariadbConnectionFactory: MariaDbConnectionFactory;
}
```

Adicionar case no switch antes do `default`:

```ts
    case "mariadb":
      return new MariaDbSourceAdapter({
        config: input.config,
        connectionFactory: input.dependencies.mariadbConnectionFactory,
        secrets: input.secrets
      });
```

- [ ] **Step 4.4: Rodar — devem passar**

Run: `npx vitest run tests/db/adapter-factory.test.ts`
Expected: PASS para todos (incluindo casos antigos de mysql, firebird, postgres).

- [ ] **Step 4.5: Commit**

```bash
git add src/db/adapter-factory.ts tests/db/adapter-factory.test.ts
git commit -m "feat(db): factory cria MariaDbSourceAdapter para driver mariadb"
```

---

## Task 5: Wiring no `runtime.ts` e dependência `mariadb`

**Files:**
- Modify: `package.json:dependencies`
- Modify: `src/service/runtime.ts:1027-1070` (createOptionalDriverDependencies)

- [ ] **Step 5.1: Adicionar dependência `mariadb`**

Run: `npm install mariadb`
Expected: pacote adicionado em `package.json` (versão atual estável, ~3.x).

- [ ] **Step 5.2: Registrar `mariadbConnectionFactory` no runtime**

Modify `src/service/runtime.ts` dentro de `createOptionalDriverDependencies` — adicionar a factory antes do fechamento do objeto (depois de `postgresConnectionFactory`):

```ts
    mariadbConnectionFactory: async (config) => {
      const mariadb = await optionalImport("mariadb");
      const createConnection = mariadb.createConnection ?? mariadb.default?.createConnection;
      const connection = await createConnection({
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: config.password
      });
      return {
        query: (sql, params) => connection.query(sql, params as unknown[]),
        end: () => connection.end()
      };
    }
```

Lembrar de colocar vírgula no final da factory anterior (`postgresConnectionFactory`).

- [ ] **Step 5.3: Verificar build TS**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: sem erros — `AdapterFactoryDependencies` agora exige `mariadbConnectionFactory` e o runtime fornece.

- [ ] **Step 5.4: Rodar toda a suite**

Run: `npm test`
Expected: PASS para todos os testes do projeto.

- [ ] **Step 5.5: Commit**

```bash
git add package.json package-lock.json pnpm-lock.yaml src/service/runtime.ts
git commit -m "feat(runtime): wiring do driver mariadb com pacote oficial"
```

---

## Verificação final

- [ ] **Step F.1: Rodar suite completa + coverage**

Run: `npm test`
Expected: 0 failures.

- [ ] **Step F.2: Build de produção**

Run: `npm run build`
Expected: 0 erros TS.

- [ ] **Step F.3: Verificar git log**

Run: `git log --oneline -8`
Expected: 5 commits criados na ordem das tasks.
