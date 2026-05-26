# VetorFarma / PostgreSQL connectivity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a PostgreSQL driver (`postgresql`) to `pharma-agent-v2` and a Windows-only PSQLODBC DSN discovery flow in the `database-setup` CLI, enabling the agent to ingest data from VetorFarma installations and any other PostgreSQL-backed ERP.

**Architecture:** Mirror the existing MySQL/Firebird adapter pattern (`SourceDatabaseAdapter` + injected `ConnectionFactory`). Add a parallel `dsn-discovery` module that reads PSQLODBC DSNs from the Windows Registry via an injected `RegistryReader` (default impl shells out to `reg.exe`). Driver-agnostic modules (`transport/`, `poller/`, `mapping/`, `state/`) are not touched.

**Tech Stack:** TypeScript, Node 20+, vitest, `pg` (new dependency), `child_process` (for `reg.exe`).

**Spec:** `docs/superpowers/specs/2026-05-26-vetorfarma-postgresql-design.md`

---

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `src/config/types.ts` | edit | Add `"postgresql"` to `DatabaseDriver`. |
| `src/db/source-adapter.ts` | edit | Add `"postgresql"` to `SourceDatabaseAdapterKind`. |
| `src/db/adapter-factory.ts` | edit | Add `postgresConnectionFactory` dependency + `case "postgresql"`. |
| `src/db/postgresql-adapter.ts` | new | `PostgresSourceAdapter` implementing `SourceDatabaseAdapter` with `$1/$2` placeholders. |
| `src/db/registry-reader.ts` | new | `RegistryReader` interface + default `reg.exe` impl + non-Windows no-op. |
| `src/db/dsn-discovery.ts` | new | `discoverPostgresDsns(reader)` returns `PostgresDsnCandidate[]`. |
| `src/cli/database-setup.ts` | edit | Driver picker gains `"postgresql"`; manual flow for postgresql offers DSN discovery; production wiring adds `postgresConnectionFactory`. |
| `tests/db/postgresql-adapter.test.ts` | new | Adapter unit tests with injected fake. |
| `tests/db/dsn-discovery.test.ts` | new | Discovery unit tests with injected `RegistryReader`. |
| `tests/db/registry-reader.test.ts` | new | Default reader returns `[]` on non-Windows; ignores `reg.exe` errors. |
| `tests/db/adapter-factory.test.ts` | edit | Add postgresql case; keep unsupported-driver regression. |
| `tests/cli/database-setup.test.ts` | edit/new | Driver picker shows postgresql; DSN flow pre-fills defaults; empty DSN falls back to manual. |
| `docs/manual-system-tests.md` | edit | Add one-paragraph postgres smoke test. |
| `package.json` | edit | Add `pg` (dependencies) and `@types/pg` (devDependencies). |

---

## Conventions

- **Commit style:** matches existing repo style (lowercase, `feat(scope):`, `test(scope):`, `docs(scope):`, etc.). Co-Author footer required.
- **Test runner:** `npm test` for the full suite; `npx vitest run tests/path/to/test.ts -t "test name"` for one test.
- **Build check:** `npm run build` must succeed after each task that touches types/exports.
- **No live Postgres or live Registry in tests:** everything via injected fakes.

---

## Task 1: Add `postgresql` to driver type unions

**Files:**
- Modify: `src/config/types.ts`
- Modify: `src/db/source-adapter.ts`

- [ ] **Step 1: Update `DatabaseDriver`**

Edit `src/config/types.ts:1`:

```ts
export type DatabaseDriver = "mysql" | "firebird" | "postgresql";
```

- [ ] **Step 2: Update `SourceDatabaseAdapterKind`**

Edit `src/db/source-adapter.ts:35`:

```ts
export type SourceDatabaseAdapterKind = "mysql" | "firebird" | "postgresql";
```

- [ ] **Step 3: Verify the build fails predictably**

Run: `npm run build`
Expected: FAIL with errors in `src/db/adapter-factory.ts` referring to exhaustive switch on `DatabaseDriver` (the factory will be updated in Task 5). If no error appears, the switch is non-exhaustive and that is acceptable — proceed.

- [ ] **Step 4: Commit**

```bash
git add src/config/types.ts src/db/source-adapter.ts
git commit -m "$(cat <<'EOF'
feat(db): adiciona postgresql ao DatabaseDriver e SourceDatabaseAdapterKind

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add `pg` and `@types/pg` as dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install runtime dependency**

Run: `npm install pg`
Expected: `package.json` `dependencies` now includes `"pg": "^<latest>"`.

- [ ] **Step 2: Install types dev dependency**

Run: `npm install --save-dev @types/pg`
Expected: `package.json` `devDependencies` now includes `"@types/pg": "^<latest>"`.

- [ ] **Step 3: Sanity-check the lockfile**

Run: `npm test`
Expected: PASS (existing suite is unaffected by adding a dependency).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "$(cat <<'EOF'
chore(deps): adiciona pg e @types/pg para suporte a postgresql

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: PostgresSourceAdapter — connect, close, error normalization

**Files:**
- Create: `src/db/postgresql-adapter.ts`
- Create: `tests/db/postgresql-adapter.test.ts`

- [ ] **Step 1: Write the failing tests for connect/close**

Create `tests/db/postgresql-adapter.test.ts` with this initial content:

```ts
import { describe, expect, it, vi } from "vitest";
import { DatabaseOperationError } from "../../src/db/errors.js";
import {
  PostgresSourceAdapter,
  type PostgresDriverConnection
} from "../../src/db/postgresql-adapter.js";
import type { DatabaseConfig } from "../../src/config/types.js";

const config: DatabaseConfig = {
  driver: "postgresql",
  host: "127.0.0.1",
  port: 5432,
  name: "vetorfarma",
  user: "readonly",
  password: "super-secret-password"
};

describe("PostgresSourceAdapter", () => {
  it("connects via the injected connection factory with readonly intent", async () => {
    const connection: PostgresDriverConnection = {
      query: vi.fn(async () => ({ rows: [] })),
      end: vi.fn(async () => undefined)
    };
    const connectionFactory = vi.fn(async () => connection);
    const adapter = new PostgresSourceAdapter({ config, connectionFactory });

    await adapter.connect();

    expect(connectionFactory).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 5432,
      database: "vetorfarma",
      user: "readonly",
      password: "super-secret-password",
      readonly: true
    });
  });

  it("normalizes connection failures without leaking password or database name", async () => {
    const adapter = new PostgresSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => {
        throw Object.assign(new Error("password authentication failed for super-secret-password on vetorfarma"), {
          code: "28P01"
        });
      })
    });

    await expect(adapter.connect()).rejects.toMatchObject({
      name: "DatabaseOperationError",
      driver: "postgresql",
      operation: "connect",
      errorCode: "POSTGRESQL_28P01"
    });

    try {
      await adapter.connect();
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseOperationError);
      expect(String(error)).not.toContain("super-secret-password");
      expect(String(error)).not.toContain("vetorfarma");
      expect(String(error)).toContain("[REDACTED]");
    }
  });

  it("closes connected sessions exactly once", async () => {
    const connection: PostgresDriverConnection = {
      query: vi.fn(async () => ({ rows: [] })),
      end: vi.fn(async () => undefined)
    };
    const adapter = new PostgresSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    await adapter.close();
    await adapter.close();

    expect(connection.end).toHaveBeenCalledOnce();
  });

  it("normalizes close failures", async () => {
    const adapter = new PostgresSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => ({
        query: vi.fn(async () => ({ rows: [] })),
        end: vi.fn(async () => {
          throw Object.assign(new Error("connection close timeout"), { code: "ETIMEDOUT" });
        })
      }))
    });

    await adapter.connect();

    await expect(adapter.close()).rejects.toMatchObject({
      driver: "postgresql",
      operation: "close",
      errorCode: "POSTGRESQL_ETIMEDOUT",
      retryable: true
    });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npx vitest run tests/db/postgresql-adapter.test.ts`
Expected: FAIL — `Cannot find module '../../src/db/postgresql-adapter.js'`.

- [ ] **Step 3: Create the adapter skeleton with connect/close**

Create `src/db/postgresql-adapter.ts`:

```ts
import type { DatabaseConfig } from "../config/types.js";
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

export interface PostgresConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  readonly: true;
}

export interface PostgresDriverConnection {
  query(sql: string, params: readonly unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

export type PostgresConnectionFactory = (
  config: PostgresConnectionConfig
) => Promise<PostgresDriverConnection>;

export interface PostgresSourceAdapterOptions {
  config: DatabaseConfig;
  connectionFactory: PostgresConnectionFactory;
  secrets?: readonly string[];
}

export class PostgresSourceAdapter implements SourceDatabaseAdapter {
  private readonly config: DatabaseConfig;
  private readonly connectionFactory: PostgresConnectionFactory;
  private readonly secrets: readonly string[];
  private connection?: PostgresDriverConnection;

  public constructor(options: PostgresSourceAdapterOptions) {
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
        driver: "postgresql",
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
        driver: "postgresql",
        operation: "close",
        error,
        secrets: this.secrets
      });
    }
  }

  public async queryChanges(_input: QueryChangesInput): Promise<SourceRow[]> {
    throw new Error("not implemented yet");
  }

  public async querySnapshotPage(_input: QuerySnapshotPageInput): Promise<SourceRow[]> {
    throw new Error("not implemented yet");
  }

  public async listTables(): Promise<DatabaseTable[]> {
    throw new Error("not implemented yet");
  }

  public async listColumns(_tableName: string): Promise<DatabaseColumn[]> {
    throw new Error("not implemented yet");
  }

  private requireConnection(operation: DatabaseOperation = "query"): PostgresDriverConnection {
    if (!this.connection) {
      throw normalizeDatabaseError({
        driver: "postgresql",
        operation,
        error: new Error("Database adapter is not connected"),
        secrets: this.secrets
      });
    }
    return this.connection;
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run tests/db/postgresql-adapter.test.ts`
Expected: PASS for all 4 tests in this task. (Other suites still pass — `npm test` to confirm.)

- [ ] **Step 5: Commit**

```bash
git add src/db/postgresql-adapter.ts tests/db/postgresql-adapter.test.ts
git commit -m "$(cat <<'EOF'
feat(db): adapter postgresql com connect/close e normalizacao de erro

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: PostgresSourceAdapter — queryChanges and querySnapshotPage

**Files:**
- Modify: `src/db/postgresql-adapter.ts`
- Modify: `tests/db/postgresql-adapter.test.ts`

- [ ] **Step 1: Add failing tests for queryChanges and querySnapshotPage**

Append to `tests/db/postgresql-adapter.test.ts` (inside the `describe` block, before the closing `});`):

```ts
  it("passes SQL and params to the driver and returns rows from .rows", async () => {
    const connection: PostgresDriverConnection = {
      query: vi.fn(async () => ({ rows: [{ product_id: "P-001", updated_at: 12 }] })),
      end: vi.fn(async () => undefined)
    };
    const adapter = new PostgresSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    const rows = await adapter.queryChanges({
      sql: "select * from products where updated_at > $1 order by updated_at limit $2",
      cursor: 10,
      limit: 25
    });

    expect(connection.query).toHaveBeenCalledWith(
      "select * from products where updated_at > $1 order by updated_at limit $2",
      [10, 25]
    );
    expect(rows).toEqual([{ product_id: "P-001", updated_at: 12 }]);
  });

  it("coerces timestamp cursor strings into Date for postgres timestamp params", async () => {
    const connection: PostgresDriverConnection = {
      query: vi.fn(async () => ({ rows: [] })),
      end: vi.fn(async () => undefined)
    };
    const adapter = new PostgresSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    await adapter.queryChanges({
      sql: "select * from products where updated_at > $1 order by updated_at limit $2",
      cursor: "Sat May 16 2026 20:00:02 GMT-0300 (Brasilia Standard Time)",
      limit: 25
    });

    expect(connection.query).toHaveBeenCalledWith(
      "select * from products where updated_at > $1 order by updated_at limit $2",
      [expect.any(Date), 25]
    );
  });

  it("emits LIMIT $1 OFFSET $2 params for snapshot pages", async () => {
    const connection: PostgresDriverConnection = {
      query: vi.fn(async () => ({ rows: [{ product_id: "P-001" }] })),
      end: vi.fn(async () => undefined)
    };
    const adapter = new PostgresSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    await expect(
      adapter.querySnapshotPage({
        sql: "select * from products order by product_id limit $1 offset $2",
        limit: 500,
        offset: 1000
      })
    ).resolves.toEqual([{ product_id: "P-001" }]);

    expect(connection.query).toHaveBeenCalledWith(
      "select * from products order by product_id limit $1 offset $2",
      [500, 1000]
    );
  });

  it("normalizes query errors without leaking secrets", async () => {
    const connection: PostgresDriverConnection = {
      query: vi.fn(async () => {
        throw Object.assign(new Error("relation \"vetorfarma.products\" does not exist; password=super-secret-password"), {
          code: "42P01"
        });
      }),
      end: vi.fn(async () => undefined)
    };
    const adapter = new PostgresSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();

    try {
      await adapter.queryChanges({ sql: "select 1", cursor: null, limit: 1 });
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseOperationError);
      expect(error).toMatchObject({
        driver: "postgresql",
        operation: "query",
        errorCode: "POSTGRESQL_42P01"
      });
      expect(String(error)).not.toContain("super-secret-password");
      expect(String(error)).not.toContain("vetorfarma");
    }
  });
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npx vitest run tests/db/postgresql-adapter.test.ts -t "passes SQL and params"`
Expected: FAIL — `not implemented yet`.

- [ ] **Step 3: Implement queryChanges and querySnapshotPage**

Replace the two stub methods and `requireConnection` block in `src/db/postgresql-adapter.ts` with this implementation. Add helper functions at the bottom of the file.

```ts
  public async queryChanges(input: QueryChangesInput): Promise<SourceRow[]> {
    const connection = this.requireConnection();

    try {
      const result = await connection.query(input.sql, [
        normalizeCursorParam(input.cursor),
        input.limit
      ]);
      return normalizeRows(result);
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "postgresql",
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
        driver: "postgresql",
        operation: "query",
        error,
        secrets: this.secrets
      });
    }
  }
```

Append below the class:

```ts
function normalizeRows(result: unknown): SourceRow[] {
  if (isRecord(result) && Array.isArray((result as { rows?: unknown }).rows)) {
    return ((result as { rows: unknown[] }).rows.filter(isRecord) as SourceRow[]).map(
      (row) => ({ ...row })
    );
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run tests/db/postgresql-adapter.test.ts`
Expected: PASS for all tests in this file (8 total counting Task 3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/postgresql-adapter.ts tests/db/postgresql-adapter.test.ts
git commit -m "$(cat <<'EOF'
feat(db): adapter postgresql implementa queryChanges e querySnapshotPage

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: PostgresSourceAdapter — listTables and listColumns

**Files:**
- Modify: `src/db/postgresql-adapter.ts`
- Modify: `tests/db/postgresql-adapter.test.ts`

**Note:** `listTables` returns schema-qualified names (`schema.table`) because Postgres has real schemas, unlike MySQL where `table_schema = database name`. `listColumns(qualifiedName)` splits the qualified name; if no dot is present, defaults to `public`.

- [ ] **Step 1: Add failing tests**

Append inside the `describe` block:

```ts
  it("listTables returns schema-qualified names, excluding system schemas", async () => {
    const connection: PostgresDriverConnection = {
      query: vi.fn(async () => ({
        rows: [
          { table_schema: "public", name: "products" },
          { table_schema: "vetor", name: "estoque" }
        ]
      })),
      end: vi.fn(async () => undefined)
    };
    const adapter = new PostgresSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    const tables = await adapter.listTables();

    expect(connection.query).toHaveBeenCalledWith(
      expect.stringContaining("information_schema.tables"),
      []
    );
    expect(connection.query).toHaveBeenCalledWith(
      expect.stringContaining("table_schema not in ('pg_catalog', 'information_schema')"),
      []
    );
    expect(tables).toEqual([
      { name: "public.products" },
      { name: "vetor.estoque" }
    ]);
  });

  it("listTables returns [] when rows are not in the expected shape", async () => {
    const connection: PostgresDriverConnection = {
      query: vi.fn(async () => ({ rows: [{ table: "products" }, null, { name: 123 }] })),
      end: vi.fn(async () => undefined)
    };
    const adapter = new PostgresSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    await expect(adapter.listTables()).resolves.toEqual([]);
  });

  it("listColumns splits schema.table into ($1=schema, $2=name)", async () => {
    const connection: PostgresDriverConnection = {
      query: vi.fn(async () => ({
        rows: [
          { name: "product_id", dataType: "varchar", nullable: "NO" },
          { name: "updated_at", dataType: "timestamp", nullable: "YES" }
        ]
      })),
      end: vi.fn(async () => undefined)
    };
    const adapter = new PostgresSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    const columns = await adapter.listColumns("vetor.estoque");

    expect(connection.query).toHaveBeenCalledWith(
      expect.stringContaining("information_schema.columns"),
      ["vetor", "estoque"]
    );
    expect(columns).toEqual([
      { name: "product_id", dataType: "varchar", nullable: false },
      { name: "updated_at", dataType: "timestamp", nullable: true }
    ]);
  });

  it("listColumns defaults to public schema when no dot is present", async () => {
    const connection: PostgresDriverConnection = {
      query: vi.fn(async () => ({ rows: [] })),
      end: vi.fn(async () => undefined)
    };
    const adapter = new PostgresSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    await adapter.listColumns("products");

    expect(connection.query).toHaveBeenCalledWith(
      expect.stringContaining("information_schema.columns"),
      ["public", "products"]
    );
  });

  it("normalizes listTables failures without leaking secrets", async () => {
    const connection: PostgresDriverConnection = {
      query: vi.fn(async () => {
        throw Object.assign(new Error("permission denied on vetorfarma; super-secret-password"), {
          code: "42501"
        });
      }),
      end: vi.fn(async () => undefined)
    };
    const adapter = new PostgresSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();

    try {
      await adapter.listTables();
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseOperationError);
      expect(error).toMatchObject({
        driver: "postgresql",
        operation: "listTables",
        errorCode: "POSTGRESQL_42501"
      });
      expect(String(error)).not.toContain("super-secret-password");
      expect(String(error)).not.toContain("vetorfarma");
    }
  });
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npx vitest run tests/db/postgresql-adapter.test.ts -t "listTables"`
Expected: FAIL — `not implemented yet`.

- [ ] **Step 3: Implement listTables and listColumns**

In `src/db/postgresql-adapter.ts`, replace the two stub methods with:

```ts
  public async listTables(): Promise<DatabaseTable[]> {
    const connection = this.requireConnection("listTables");

    try {
      const result = await connection.query(
        `
          select table_schema, table_name as name
          from information_schema.tables
          where table_schema not in ('pg_catalog', 'information_schema')
            and table_type = 'BASE TABLE'
          order by table_schema, table_name
        `,
        []
      );
      return normalizePostgresTables(result);
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "postgresql",
        operation: "listTables",
        error,
        secrets: this.secrets
      });
    }
  }

  public async listColumns(tableName: string): Promise<DatabaseColumn[]> {
    const connection = this.requireConnection("listColumns");
    const { schema, name } = splitQualifiedTable(tableName);

    try {
      const result = await connection.query(
        `
          select column_name as name,
                 data_type as "dataType",
                 is_nullable as nullable
          from information_schema.columns
          where table_schema = $1
            and table_name = $2
          order by ordinal_position
        `,
        [schema, name]
      );
      return normalizePostgresColumns(result);
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "postgresql",
        operation: "listColumns",
        error,
        secrets: this.secrets
      });
    }
  }
```

Append below the existing helpers in `src/db/postgresql-adapter.ts`:

```ts
function splitQualifiedTable(tableName: string): { schema: string; name: string } {
  const trimmed = tableName.trim();
  const dotIndex = trimmed.indexOf(".");
  if (dotIndex <= 0 || dotIndex === trimmed.length - 1) {
    return { schema: "public", name: trimmed };
  }
  return {
    schema: trimmed.slice(0, dotIndex),
    name: trimmed.slice(dotIndex + 1)
  };
}

function normalizePostgresTables(result: unknown): DatabaseTable[] {
  if (!isRecord(result) || !Array.isArray((result as { rows?: unknown }).rows)) {
    return [];
  }
  const rows = (result as { rows: unknown[] }).rows;
  return rows
    .map((row) => readPostgresTable(row))
    .filter((entry): entry is DatabaseTable => entry !== undefined);
}

function readPostgresTable(row: unknown): DatabaseTable | undefined {
  if (!isRecord(row)) {
    return undefined;
  }
  const schemaValue = row.table_schema;
  const nameValue = row.name;
  if (typeof schemaValue !== "string" || typeof nameValue !== "string") {
    return undefined;
  }
  const schema = schemaValue.trim();
  const name = nameValue.trim();
  if (!schema || !name) {
    return undefined;
  }
  return { name: `${schema}.${name}` };
}

function normalizePostgresColumns(result: unknown): DatabaseColumn[] {
  if (!isRecord(result) || !Array.isArray((result as { rows?: unknown }).rows)) {
    return [];
  }
  const rows = (result as { rows: unknown[] }).rows;
  return rows
    .map((row) => readPostgresColumn(row))
    .filter((entry): entry is DatabaseColumn => entry !== undefined);
}

function readPostgresColumn(row: unknown): DatabaseColumn | undefined {
  if (!isRecord(row)) {
    return undefined;
  }
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (!name) {
    return undefined;
  }
  return {
    name,
    dataType: typeof row.dataType === "string" ? row.dataType.trim().toLowerCase() : undefined,
    nullable: readNullable(row.nullable)
  };
}

function readNullable(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "yes") return true;
  if (normalized === "no") return false;
  return undefined;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run tests/db/postgresql-adapter.test.ts`
Expected: PASS for all tests in this file.

- [ ] **Step 5: Commit**

```bash
git add src/db/postgresql-adapter.ts tests/db/postgresql-adapter.test.ts
git commit -m "$(cat <<'EOF'
feat(db): adapter postgresql implementa listTables e listColumns

Lista tabelas qualificadas por schema (schema.table). listColumns aceita
schema.table e cai em public quando nao ha ponto.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Wire postgresql into adapter-factory

**Files:**
- Modify: `src/db/adapter-factory.ts`
- Modify: `tests/db/adapter-factory.test.ts`

- [ ] **Step 1: Update factory test for postgresql**

Edit `tests/db/adapter-factory.test.ts`. Replace its contents with:

```ts
import { describe, expect, it, vi } from "vitest";
import { createSourceDatabaseAdapter, UnsupportedDatabaseDriverError } from "../../src/db/adapter-factory.js";
import { FirebirdSourceAdapter } from "../../src/db/firebird-adapter.js";
import { MySqlSourceAdapter } from "../../src/db/mysql-adapter.js";
import { PostgresSourceAdapter } from "../../src/db/postgresql-adapter.js";
import type { DatabaseConfig } from "../../src/config/types.js";

const mysqlConfig: DatabaseConfig = {
  driver: "mysql",
  host: "localhost",
  port: 3306,
  name: "pharmacy",
  user: "readonly",
  password: "test-db-password"
};

const firebirdConfig: DatabaseConfig = {
  ...mysqlConfig,
  driver: "firebird",
  port: 3050
};

const postgresConfig: DatabaseConfig = {
  ...mysqlConfig,
  driver: "postgresql",
  port: 5432
};

const dependencies = () => ({
  mysqlConnectionFactory: vi.fn(),
  firebirdConnectionFactory: vi.fn(),
  postgresConnectionFactory: vi.fn()
});

describe("createSourceDatabaseAdapter", () => {
  it("returns MySQL adapter when DB_DRIVER=mysql", () => {
    const adapter = createSourceDatabaseAdapter({
      config: mysqlConfig,
      dependencies: dependencies()
    });
    expect(adapter).toBeInstanceOf(MySqlSourceAdapter);
  });

  it("returns Firebird adapter when DB_DRIVER=firebird", () => {
    const adapter = createSourceDatabaseAdapter({
      config: firebirdConfig,
      dependencies: dependencies()
    });
    expect(adapter).toBeInstanceOf(FirebirdSourceAdapter);
  });

  it("returns Postgres adapter when DB_DRIVER=postgresql", () => {
    const adapter = createSourceDatabaseAdapter({
      config: postgresConfig,
      dependencies: dependencies()
    });
    expect(adapter).toBeInstanceOf(PostgresSourceAdapter);
  });

  it("rejects unsupported drivers before polling starts", () => {
    expect(() =>
      createSourceDatabaseAdapter({
        config: { ...mysqlConfig, driver: "oracle" as never },
        dependencies: dependencies()
      })
    ).toThrow(UnsupportedDatabaseDriverError);
  });
});
```

- [ ] **Step 2: Run tests to confirm the postgres case fails**

Run: `npx vitest run tests/db/adapter-factory.test.ts -t "Postgres adapter"`
Expected: FAIL — either type error (`postgresConnectionFactory` not in `AdapterFactoryDependencies`) or thrown `UnsupportedDatabaseDriverError`.

- [ ] **Step 3: Update the factory**

Edit `src/db/adapter-factory.ts`. Replace its contents with:

```ts
import type { DatabaseConfig, DatabaseDriver } from "../config/types.js";
import { FirebirdSourceAdapter, type FirebirdConnectionFactory } from "./firebird-adapter.js";
import { MySqlSourceAdapter, type MySqlConnectionFactory } from "./mysql-adapter.js";
import { PostgresSourceAdapter, type PostgresConnectionFactory } from "./postgresql-adapter.js";
import type { SourceDatabaseAdapter } from "./source-adapter.js";

export interface AdapterFactoryDependencies {
  mysqlConnectionFactory: MySqlConnectionFactory;
  firebirdConnectionFactory: FirebirdConnectionFactory;
  postgresConnectionFactory: PostgresConnectionFactory;
}

export interface CreateSourceAdapterInput {
  config: DatabaseConfig;
  dependencies: AdapterFactoryDependencies;
  secrets?: readonly string[];
}

export class UnsupportedDatabaseDriverError extends Error {
  public readonly driver: string;

  public constructor(driver: string) {
    super(`Unsupported database driver: ${driver}`);
    this.name = "UnsupportedDatabaseDriverError";
    this.driver = driver;
  }
}

export function createSourceDatabaseAdapter(input: CreateSourceAdapterInput): SourceDatabaseAdapter {
  switch (input.config.driver as DatabaseDriver | string) {
    case "mysql":
      return new MySqlSourceAdapter({
        config: input.config,
        connectionFactory: input.dependencies.mysqlConnectionFactory,
        secrets: input.secrets
      });
    case "firebird":
      return new FirebirdSourceAdapter({
        config: input.config,
        connectionFactory: input.dependencies.firebirdConnectionFactory,
        secrets: input.secrets
      });
    case "postgresql":
      return new PostgresSourceAdapter({
        config: input.config,
        connectionFactory: input.dependencies.postgresConnectionFactory,
        secrets: input.secrets
      });
    default:
      throw new UnsupportedDatabaseDriverError(String(input.config.driver));
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run tests/db/adapter-factory.test.ts`
Expected: PASS for all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/db/adapter-factory.ts tests/db/adapter-factory.test.ts
git commit -m "$(cat <<'EOF'
feat(db): adapter-factory cria PostgresSourceAdapter para driver postgresql

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: RegistryReader (interface + reg.exe default impl)

**Files:**
- Create: `src/db/registry-reader.ts`
- Create: `tests/db/registry-reader.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/db/registry-reader.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  createRegExeRegistryReader,
  type RegistryReader
} from "../../src/db/registry-reader.js";

describe("createRegExeRegistryReader", () => {
  it("returns empty arrays on non-Windows platforms without invoking reg.exe", async () => {
    const exec = vi.fn();
    const reader: RegistryReader = createRegExeRegistryReader({
      platform: "linux",
      exec
    });

    await expect(reader.listKeys("HKLM\\Software\\ODBC\\ODBC.INI")).resolves.toEqual([]);
    await expect(reader.readKey("HKLM\\Software\\ODBC\\ODBC.INI\\Foo")).resolves.toEqual({});
    expect(exec).not.toHaveBeenCalled();
  });

  it("parses listKeys output from reg.exe on Windows", async () => {
    const exec = vi.fn(async (args: readonly string[]) => {
      expect(args[0]).toBe("query");
      expect(args[1]).toBe("HKLM\\Software\\ODBC\\ODBC.INI");
      return {
        stdout: [
          "",
          "HKEY_LOCAL_MACHINE\\Software\\ODBC\\ODBC.INI",
          "    (Default)    REG_SZ    (value not set)",
          "",
          "HKEY_LOCAL_MACHINE\\Software\\ODBC\\ODBC.INI\\ODBC Data Sources",
          "HKEY_LOCAL_MACHINE\\Software\\ODBC\\ODBC.INI\\VetorFarma",
          ""
        ].join("\r\n"),
        stderr: ""
      };
    });
    const reader = createRegExeRegistryReader({ platform: "win32", exec });

    const subkeys = await reader.listKeys("HKLM\\Software\\ODBC\\ODBC.INI");

    expect(subkeys).toEqual([
      "ODBC Data Sources",
      "VetorFarma"
    ]);
  });

  it("parses readKey output from reg.exe", async () => {
    const exec = vi.fn(async () => ({
      stdout: [
        "",
        "HKEY_LOCAL_MACHINE\\Software\\ODBC\\ODBC.INI\\VetorFarma",
        "    Driver       REG_SZ    C:\\Windows\\system32\\psqlodbc35w.dll",
        "    Servername   REG_SZ    127.0.0.1",
        "    Port         REG_SZ    5432",
        "    Database     REG_SZ    vetorfarma",
        "    Username     REG_SZ    vfuser",
        ""
      ].join("\r\n"),
      stderr: ""
    }));
    const reader = createRegExeRegistryReader({ platform: "win32", exec });

    const values = await reader.readKey("HKLM\\Software\\ODBC\\ODBC.INI\\VetorFarma");

    expect(values).toEqual({
      Driver: "C:\\Windows\\system32\\psqlodbc35w.dll",
      Servername: "127.0.0.1",
      Port: "5432",
      Database: "vetorfarma",
      Username: "vfuser"
    });
  });

  it("returns [] / {} when reg.exe fails (missing key, ACL denial)", async () => {
    const exec = vi.fn(async () => {
      throw new Error("ERROR: The system was unable to find the specified registry key");
    });
    const reader = createRegExeRegistryReader({ platform: "win32", exec });

    await expect(reader.listKeys("HKCU\\does\\not\\exist")).resolves.toEqual([]);
    await expect(reader.readKey("HKCU\\does\\not\\exist")).resolves.toEqual({});
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npx vitest run tests/db/registry-reader.test.ts`
Expected: FAIL — `Cannot find module '../../src/db/registry-reader.js'`.

- [ ] **Step 3: Implement the reader**

Create `src/db/registry-reader.ts`:

```ts
export interface RegistryReader {
  listKeys(path: string): Promise<string[]>;
  readKey(path: string): Promise<Record<string, string>>;
}

export interface RegExeResult {
  stdout: string;
  stderr: string;
}

export type RegExeExec = (args: readonly string[]) => Promise<RegExeResult>;

export interface CreateRegExeRegistryReaderOptions {
  platform?: NodeJS.Platform | string;
  exec?: RegExeExec;
}

export function createRegExeRegistryReader(
  options: CreateRegExeRegistryReaderOptions = {}
): RegistryReader {
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? defaultExec;

  if (platform !== "win32") {
    return {
      async listKeys() {
        return [];
      },
      async readKey() {
        return {};
      }
    };
  }

  return {
    async listKeys(path: string): Promise<string[]> {
      try {
        const result = await exec(["query", path]);
        return parseSubkeys(path, result.stdout);
      } catch {
        return [];
      }
    },
    async readKey(path: string): Promise<Record<string, string>> {
      try {
        const result = await exec(["query", path]);
        return parseValues(result.stdout);
      } catch {
        return {};
      }
    }
  };
}

const defaultExec: RegExeExec = async (args) => {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    execFile("reg.exe", [...args], { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
};

function parseSubkeys(parentPath: string, stdout: string): string[] {
  const prefix = normalizePath(parentPath);
  const subkeys: string[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.includes("REG_")) {
      continue;
    }
    const normalized = normalizePath(line);
    if (!normalized.startsWith(`${prefix}\\`)) {
      continue;
    }
    const rest = normalized.slice(prefix.length + 1);
    if (!rest || rest.includes("\\")) {
      continue;
    }
    subkeys.push(rest);
  }
  return subkeys;
}

function parseValues(stdout: string): Record<string, string> {
  const values: Record<string, string> = {};
  const valueLine = /^(\S(?:.*?\S)?)\s+REG_[A-Z_]+\s+(.*)$/u;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = valueLine.exec(line);
    if (!match) {
      continue;
    }
    const [, name, value] = match;
    if (name === "(Default)") {
      continue;
    }
    values[name] = value;
  }
  return values;
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith("HKEY_LOCAL_MACHINE")) {
    return `HKLM${trimmed.slice("HKEY_LOCAL_MACHINE".length)}`;
  }
  if (trimmed.startsWith("HKEY_CURRENT_USER")) {
    return `HKCU${trimmed.slice("HKEY_CURRENT_USER".length)}`;
  }
  return trimmed;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run tests/db/registry-reader.test.ts`
Expected: PASS for all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/db/registry-reader.ts tests/db/registry-reader.test.ts
git commit -m "$(cat <<'EOF'
feat(db): registry-reader baseado em reg.exe com no-op fora do windows

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: DSN discovery for PSQLODBC

**Files:**
- Create: `src/db/dsn-discovery.ts`
- Create: `tests/db/dsn-discovery.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/db/dsn-discovery.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { discoverPostgresDsns } from "../../src/db/dsn-discovery.js";
import type { RegistryReader } from "../../src/db/registry-reader.js";

function makeReader(map: Record<string, string[] | Record<string, string>>): RegistryReader {
  return {
    async listKeys(path) {
      const value = map[path];
      return Array.isArray(value) ? value : [];
    },
    async readKey(path) {
      const value = map[path];
      return value && !Array.isArray(value) ? value : {};
    }
  };
}

const HKLM_INDEX = "HKLM\\Software\\ODBC\\ODBC.INI\\ODBC Data Sources";
const HKCU_INDEX = "HKCU\\Software\\ODBC\\ODBC.INI\\ODBC Data Sources";

describe("discoverPostgresDsns", () => {
  it("returns PSQLODBC DSNs from both HKLM and HKCU, deduped by name", async () => {
    const reader = makeReader({
      [HKLM_INDEX]: { VetorFarma: "PostgreSQL Unicode", LegacyMs: "SQL Server" },
      [HKCU_INDEX]: { VetorFarma: "PostgreSQL Unicode", PgUser: "psqlODBC ANSI" },
      "HKLM\\Software\\ODBC\\ODBC.INI\\VetorFarma": {
        Driver: "C:\\Windows\\system32\\psqlodbc35w.dll",
        Servername: "127.0.0.1",
        Port: "5432",
        Database: "vetorfarma",
        Username: "vfuser"
      },
      "HKLM\\Software\\ODBC\\ODBC.INI\\LegacyMs": {
        Driver: "C:\\Windows\\system32\\sqlsrv32.dll"
      },
      "HKCU\\Software\\ODBC\\ODBC.INI\\VetorFarma": {
        Driver: "C:\\Windows\\system32\\psqlodbc35w.dll",
        Servername: "10.0.0.1"
      },
      "HKCU\\Software\\ODBC\\ODBC.INI\\PgUser": {
        Driver: "C:\\Windows\\system32\\psqlodbca.dll",
        Servername: "db.local",
        Port: "5432",
        Database: "pguser_db"
      }
    });

    const dsns = await discoverPostgresDsns(reader);

    expect(dsns).toEqual([
      {
        dsnName: "VetorFarma",
        host: "127.0.0.1",
        port: 5432,
        database: "vetorfarma",
        user: "vfuser"
      },
      {
        dsnName: "PgUser",
        host: "db.local",
        port: 5432,
        database: "pguser_db"
      }
    ]);
  });

  it("filters out DSNs whose driver does not contain psqlodbc (case-insensitive)", async () => {
    const reader = makeReader({
      [HKLM_INDEX]: { Other: "Some Driver" },
      [HKCU_INDEX]: [],
      "HKLM\\Software\\ODBC\\ODBC.INI\\Other": {
        Driver: "C:\\Windows\\system32\\notpg.dll"
      }
    });
    await expect(discoverPostgresDsns(reader)).resolves.toEqual([]);
  });

  it("omits any password even if the DSN exposes one", async () => {
    const reader = makeReader({
      [HKLM_INDEX]: { Risky: "psqlODBC" },
      [HKCU_INDEX]: [],
      "HKLM\\Software\\ODBC\\ODBC.INI\\Risky": {
        Driver: "psqlodbc35w.dll",
        Servername: "host",
        Username: "u",
        Password: "should-never-be-read",
        Database: "d",
        Port: "5432"
      }
    });

    const dsns = await discoverPostgresDsns(reader);
    expect(dsns).toHaveLength(1);
    expect(dsns[0]).not.toHaveProperty("password");
    expect(JSON.stringify(dsns[0])).not.toContain("should-never-be-read");
  });

  it("returns [] when the reader throws", async () => {
    const reader: RegistryReader = {
      async listKeys() {
        throw new Error("registry blew up");
      },
      async readKey() {
        throw new Error("registry blew up");
      }
    };

    await expect(discoverPostgresDsns(reader)).resolves.toEqual([]);
  });

  it("returns [] when both indexes are empty (non-Windows default reader)", async () => {
    const reader = makeReader({ [HKLM_INDEX]: [], [HKCU_INDEX]: [] });
    await expect(discoverPostgresDsns(reader)).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npx vitest run tests/db/dsn-discovery.test.ts`
Expected: FAIL — `Cannot find module '../../src/db/dsn-discovery.js'`.

- [ ] **Step 3: Implement discovery**

Create `src/db/dsn-discovery.ts`:

```ts
import type { RegistryReader } from "./registry-reader.js";

export interface PostgresDsnCandidate {
  dsnName: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
}

const ODBC_INI_INDEXES = [
  "HKLM\\Software\\ODBC\\ODBC.INI\\ODBC Data Sources",
  "HKCU\\Software\\ODBC\\ODBC.INI\\ODBC Data Sources"
] as const;

const ODBC_INI_PARENTS = [
  "HKLM\\Software\\ODBC\\ODBC.INI",
  "HKCU\\Software\\ODBC\\ODBC.INI"
] as const;

export async function discoverPostgresDsns(reader: RegistryReader): Promise<PostgresDsnCandidate[]> {
  try {
    const seen = new Set<string>();
    const result: PostgresDsnCandidate[] = [];

    for (let i = 0; i < ODBC_INI_INDEXES.length; i += 1) {
      const indexPath = ODBC_INI_INDEXES[i];
      const parentPath = ODBC_INI_PARENTS[i];
      let index: Record<string, string> = {};
      try {
        index = await reader.readKey(indexPath);
      } catch {
        index = {};
      }

      for (const [dsnName, driverDescription] of Object.entries(index)) {
        if (seen.has(dsnName)) {
          continue;
        }
        let values: Record<string, string> = {};
        try {
          values = await reader.readKey(`${parentPath}\\${dsnName}`);
        } catch {
          values = {};
        }

        if (!isPsqlodbc(values.Driver) && !isPsqlodbc(driverDescription)) {
          continue;
        }

        seen.add(dsnName);
        result.push(buildCandidate(dsnName, values));
      }
    }

    return result;
  } catch {
    return [];
  }
}

function isPsqlodbc(value: string | undefined): boolean {
  return typeof value === "string" && value.toLowerCase().includes("psqlodbc");
}

function buildCandidate(dsnName: string, values: Record<string, string>): PostgresDsnCandidate {
  const candidate: PostgresDsnCandidate = { dsnName };

  const host = values.Servername?.trim();
  if (host) candidate.host = host;

  const port = parsePort(values.Port);
  if (port !== undefined) candidate.port = port;

  const database = values.Database?.trim();
  if (database) candidate.database = database;

  const user = values.Username?.trim();
  if (user) candidate.user = user;

  return candidate;
}

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    return undefined;
  }
  return parsed;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run tests/db/dsn-discovery.test.ts`
Expected: PASS for all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/db/dsn-discovery.ts tests/db/dsn-discovery.test.ts
git commit -m "$(cat <<'EOF'
feat(db): dsn-discovery enumera DSNs PSQLODBC do registry sem ler senhas

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: SQL test-query builders emit `$1/$2` for postgresql

**Files:**
- Modify: `src/cli/database-setup.ts` (functions `buildIncrementalReadTestQuery` and `buildSnapshotReadTestQuery`)
- Modify: `tests/cli/database-setup.test.ts` (if missing, create — see Step 1)

- [ ] **Step 1: Locate or create the test file**

Run: `ls tests/cli/database-setup.test.ts`
If the file does not exist, create it with this minimal scaffold:

```ts
import { describe, expect, it } from "vitest";
import {
  buildIncrementalReadTestQuery,
  buildSnapshotReadTestQuery
} from "../../src/cli/database-setup.js";
```

If the file exists, add the same imports if not already present.

- [ ] **Step 2: Add failing tests**

Append to `tests/cli/database-setup.test.ts`:

```ts
describe("buildIncrementalReadTestQuery — postgresql", () => {
  it("emits $1 and $2 placeholders and double-quoted identifiers", () => {
    const sql = buildIncrementalReadTestQuery("postgresql", "produtos", "updated_at");
    expect(sql).toBe(
      'select * from "produtos" where "updated_at" > $1 order by "updated_at" limit $2'
    );
  });
});

describe("buildSnapshotReadTestQuery — postgresql", () => {
  it("emits LIMIT $1 OFFSET $2 placeholders for postgres", () => {
    const sql = buildSnapshotReadTestQuery("postgresql", "produtos", "produto_id");
    expect(sql).toBe(
      'select * from "produtos" order by "produto_id" limit $1 offset $2'
    );
  });
});
```

- [ ] **Step 3: Run the tests to confirm they fail**

Run: `npx vitest run tests/cli/database-setup.test.ts -t "postgresql"`
Expected: FAIL — current builders emit `?` placeholders for non-mysql drivers.

- [ ] **Step 4: Update the builders**

In `src/cli/database-setup.ts`, replace the two functions starting near line 398:

```ts
export function buildIncrementalReadTestQuery(
  driver: DatabaseDriver,
  tableName: string,
  cursorField: string
): string {
  const quotedTable = quoteIdentifier(driver, tableName);
  const quotedCursor = quoteIdentifier(driver, cursorField);
  if (driver === "postgresql") {
    return `select * from ${quotedTable} where ${quotedCursor} > $1 order by ${quotedCursor} limit $2`;
  }
  const limitClause = driver === "mysql" ? "limit ?" : "rows ?";
  return `select * from ${quotedTable} where ${quotedCursor} > ? order by ${quotedCursor} ${limitClause}`;
}

export function buildSnapshotReadTestQuery(
  driver: DatabaseDriver,
  tableName: string,
  stableOrderField: string
): string {
  const quotedTable = quoteIdentifier(driver, tableName);
  const quotedOrder = quoteIdentifier(driver, stableOrderField);
  if (driver === "postgresql") {
    return `select * from ${quotedTable} order by ${quotedOrder} limit $1 offset $2`;
  }
  return driver === "mysql"
    ? `select * from ${quotedTable} order by ${quotedOrder} limit ? offset ?`
    : `select * from ${quotedTable} order by ${quotedOrder} rows ? to ?`;
}
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `npx vitest run tests/cli/database-setup.test.ts -t "postgresql"`
Expected: PASS.

Also run the full file to make sure nothing else broke: `npx vitest run tests/cli/database-setup.test.ts`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/database-setup.ts tests/cli/database-setup.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): builders de SQL de teste emitem placeholders \$1/\$2 para postgresql

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Driver picker offers PostgreSQL; connection defaults extended

**Files:**
- Modify: `src/cli/database-setup.ts` (functions `selectManualDriver` and `driverConnectionDefaults`)
- Modify: `tests/cli/database-setup.test.ts`

- [ ] **Step 1: Add failing tests for driver picker and defaults**

Append to `tests/cli/database-setup.test.ts`:

```ts
import { vi } from "vitest";
import { selectManualDriver, connectionDefaults, manualConnectionSource } from "../../src/cli/database-setup.js";

describe("selectManualDriver", () => {
  it("offers postgresql alongside mysql and firebird", async () => {
    const choices: Array<readonly { value: string; label: string }[]> = [];
    const prompt = {
      text: vi.fn(),
      select: vi.fn(async ({ choices: c }) => {
        choices.push(c);
        return "postgresql";
      }),
      confirm: vi.fn()
    };

    const driver = await selectManualDriver(prompt);

    expect(driver).toBe("postgresql");
    expect(choices[0]?.map((c) => c.value)).toEqual(["mysql", "firebird", "postgresql"]);
  });

  it("returns mysql when prompt returns mysql", async () => {
    const prompt = {
      text: vi.fn(),
      select: vi.fn(async () => "mysql"),
      confirm: vi.fn()
    };
    await expect(selectManualDriver(prompt)).resolves.toBe("mysql");
  });

  it("returns firebird when prompt returns firebird", async () => {
    const prompt = {
      text: vi.fn(),
      select: vi.fn(async () => "firebird"),
      confirm: vi.fn()
    };
    await expect(selectManualDriver(prompt)).resolves.toBe("firebird");
  });
});

describe("connectionDefaults — postgresql", () => {
  it("uses port 5432 and empty database/user/password by default", () => {
    const defaults = connectionDefaults(manualConnectionSource("postgresql"));
    expect(defaults).toEqual({
      host: "127.0.0.1",
      port: 5432,
      databaseName: "",
      user: "",
      password: ""
    });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npx vitest run tests/cli/database-setup.test.ts -t "postgresql"`
Expected: FAIL — picker only has 2 choices; defaults fall through to MySQL shape.

- [ ] **Step 3: Update `selectManualDriver`**

Replace the body of `selectManualDriver` near line 245 of `src/cli/database-setup.ts`:

```ts
export async function selectManualDriver(prompt: DatabaseSetupPrompt): Promise<DatabaseDriver> {
  const selected = await prompt.select({
    message: "Selecione o driver do banco",
    choices: [
      { value: "mysql", label: "MySQL" },
      { value: "firebird", label: "Firebird" },
      { value: "postgresql", label: "PostgreSQL (VetorFarma e similares)" }
    ],
    defaultValue: "mysql"
  });
  if (selected === "firebird") return "firebird";
  if (selected === "postgresql") return "postgresql";
  return "mysql";
}
```

- [ ] **Step 4: Update `driverConnectionDefaults`**

Replace the function `driverConnectionDefaults` (near line 465) with:

```ts
function driverConnectionDefaults(source: DatabaseSetupConnectionSource): ConnectionDefaults {
  if (source.mode === "discovery" && source.candidate) {
    if (source.candidate.type === "firebird") {
      return {
        host: "127.0.0.1",
        port: 3050,
        databaseName: source.candidate.path,
        user: "SYSDBA",
        password: "masterkey"
      };
    }

    return {
      host: "127.0.0.1",
      port: 3306,
      databaseName: deriveMySqlDatabaseName(source.candidate.path),
      user: "",
      password: ""
    };
  }

  if (source.driver === "firebird") {
    return {
      host: "127.0.0.1",
      port: 3050,
      databaseName: "",
      user: "SYSDBA",
      password: "masterkey"
    };
  }

  if (source.driver === "postgresql") {
    return {
      host: "127.0.0.1",
      port: 5432,
      databaseName: "",
      user: "",
      password: ""
    };
  }

  return {
    host: "127.0.0.1",
    port: 3306,
    databaseName: "",
    user: "",
    password: ""
  };
}
```

- [ ] **Step 5: Run tests to confirm they pass**

Run: `npx vitest run tests/cli/database-setup.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/database-setup.ts tests/cli/database-setup.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): picker de driver inclui postgresql com defaults de porta 5432

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: DSN discovery sub-flow integrated into manual postgresql setup

**Files:**
- Modify: `src/cli/database-setup.ts` (extend `DatabaseSetupCliIo` and add a helper that injects DSN-derived defaults; wire it into `resolveConnectionSource` / `promptForConnectionConfig`)
- Modify: `tests/cli/database-setup.test.ts`

**Design:** the existing `selectSetupMode` ("manual" vs "discovery") is preserved. After the operator selects `postgresql` in `selectManualDriver`, the CLI offers (via `prompt.confirm`) to scan PSQLODBC DSNs. If accepted and at least one candidate exists, the operator picks one; the candidate's `host/port/database/user` become the suggested defaults in subsequent prompts. The injection point is a new exported helper `maybeDiscoverPostgresDsn` that returns a `Partial<ConnectionDefaults>` or `undefined`. `runDatabaseSetup` merges it into the `ConnectionDefaults` used by `promptForConnectionConfig`.

**Note on DI:** we add `discoverPostgresDsns` to `DatabaseSetupCliIo` to allow mocking. Production wiring uses the default `createRegExeRegistryReader()`.

- [ ] **Step 1: Add failing tests**

Append to `tests/cli/database-setup.test.ts`:

```ts
import { maybeDiscoverPostgresDsn } from "../../src/cli/database-setup.js";

describe("maybeDiscoverPostgresDsn", () => {
  function makePrompt(answers: { confirm?: boolean; selected?: string }) {
    return {
      text: vi.fn(),
      select: vi.fn(async () => answers.selected ?? ""),
      confirm: vi.fn(async () => answers.confirm ?? false)
    };
  }

  it("returns undefined when the user declines the DSN scan", async () => {
    const prompt = makePrompt({ confirm: false });
    const discover = vi.fn(async () => []);
    const stdout = { write: vi.fn() };

    const result = await maybeDiscoverPostgresDsn({
      prompt,
      stdout,
      discoverPostgresDsns: discover
    });

    expect(result).toBeUndefined();
    expect(discover).not.toHaveBeenCalled();
  });

  it("returns undefined and prints fallback notice when no DSN is found", async () => {
    const prompt = makePrompt({ confirm: true });
    const discover = vi.fn(async () => []);
    const stdout = { write: vi.fn() };

    const result = await maybeDiscoverPostgresDsn({
      prompt,
      stdout,
      discoverPostgresDsns: discover
    });

    expect(result).toBeUndefined();
    expect(stdout.write).toHaveBeenCalledWith(
      expect.stringContaining("Nenhum DSN PSQLODBC encontrado")
    );
  });

  it("returns selected DSN's host/port/database/user when one DSN is picked", async () => {
    const prompt = makePrompt({ confirm: true, selected: "VetorFarma" });
    const discover = vi.fn(async () => [
      { dsnName: "VetorFarma", host: "127.0.0.1", port: 5432, database: "vf", user: "vfuser" },
      { dsnName: "Other", host: "10.0.0.1" }
    ]);
    const stdout = { write: vi.fn() };

    const result = await maybeDiscoverPostgresDsn({
      prompt,
      stdout,
      discoverPostgresDsns: discover
    });

    expect(result).toEqual({
      host: "127.0.0.1",
      port: 5432,
      databaseName: "vf",
      user: "vfuser"
    });
  });

  it("does NOT return a password under any circumstances", async () => {
    const prompt = makePrompt({ confirm: true, selected: "VetorFarma" });
    const discover = vi.fn(async () => [
      { dsnName: "VetorFarma", host: "127.0.0.1", port: 5432, database: "vf", user: "vfuser" }
    ]);
    const stdout = { write: vi.fn() };

    const result = await maybeDiscoverPostgresDsn({
      prompt,
      stdout,
      discoverPostgresDsns: discover
    });

    expect(result).not.toHaveProperty("password");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npx vitest run tests/cli/database-setup.test.ts -t "maybeDiscoverPostgresDsn"`
Expected: FAIL — `maybeDiscoverPostgresDsn` is not exported.

- [ ] **Step 3: Add the helper and extend `DatabaseSetupCliIo`**

Add to `src/cli/database-setup.ts`, near the bottom of the file (after `manualConnectionSource`):

```ts
export interface MaybeDiscoverPostgresDsnInput {
  prompt: DatabaseSetupPrompt;
  stdout: Pick<NodeJS.WriteStream, "write">;
  discoverPostgresDsns: () => Promise<PostgresDsnCandidate[]>;
}

export async function maybeDiscoverPostgresDsn(
  input: MaybeDiscoverPostgresDsnInput
): Promise<Partial<ConnectionDefaults> | undefined> {
  const wantsScan = await input.prompt.confirm({
    message: "Procurar DSN PSQLODBC instalado?",
    defaultValue: true
  });
  if (!wantsScan) {
    return undefined;
  }

  const dsns = await input.discoverPostgresDsns();
  if (dsns.length === 0) {
    input.stdout.write("Nenhum DSN PSQLODBC encontrado. Caindo no modo manual.\n");
    return undefined;
  }

  const selected = await input.prompt.select({
    message: "Selecione o DSN",
    choices: dsns.map((dsn) => ({
      value: dsn.dsnName,
      label: formatDsnLabel(dsn)
    })),
    defaultValue: dsns[0].dsnName
  });

  const picked = dsns.find((dsn) => dsn.dsnName === selected) ?? dsns[0];
  const overrides: Partial<ConnectionDefaults> = {};
  if (picked.host) overrides.host = picked.host;
  if (picked.port !== undefined) overrides.port = picked.port;
  if (picked.database) overrides.databaseName = picked.database;
  if (picked.user) overrides.user = picked.user;
  return overrides;
}

function formatDsnLabel(dsn: PostgresDsnCandidate): string {
  const parts: string[] = [dsn.dsnName];
  if (dsn.host) parts.push(`@${dsn.host}${dsn.port ? `:${dsn.port}` : ""}`);
  if (dsn.database) parts.push(`/${dsn.database}`);
  return parts.join("");
}
```

Add the import at the top of the file:

```ts
import { discoverPostgresDsns as defaultDiscoverPostgresDsns } from "../db/dsn-discovery.js";
import type { PostgresDsnCandidate } from "../db/dsn-discovery.js";
import { createRegExeRegistryReader } from "../db/registry-reader.js";
```

Extend `DatabaseSetupCliIo` (near line 71) — add the optional field:

```ts
  discoverPostgresDsns?: () => Promise<PostgresDsnCandidate[]>;
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run tests/cli/database-setup.test.ts -t "maybeDiscoverPostgresDsn"`
Expected: PASS for all 4 tests.

- [ ] **Step 5: Wire `maybeDiscoverPostgresDsn` into `runDatabaseSetup`**

In `src/cli/database-setup.ts`, modify `resolveConnectionSource` and the subsequent `promptForConnectionConfig` call so a postgres DSN override is folded into the defaults.

Replace `resolveConnectionSource` (near line 257) with:

```ts
async function resolveConnectionSource(input: {
  mode: DatabaseSetupMode;
  options: DatabaseSetupCliOptions;
  prompt: DatabaseSetupPrompt;
  io: DatabaseSetupCliIo;
  scan: NonNullable<DatabaseSetupCliIo["discoverDatabaseFiles"]>;
}): Promise<{ source: DatabaseSetupConnectionSource; overrides?: Partial<ConnectionDefaults> }> {
  if (input.mode === "manual") {
    const driver = await selectManualDriver(input.prompt);
    if (driver === "postgresql") {
      const discover = input.io.discoverPostgresDsns
        ?? (() => defaultDiscoverPostgresDsns(createRegExeRegistryReader()));
      const overrides = await maybeDiscoverPostgresDsn({
        prompt: input.prompt,
        stdout: input.io.stdout,
        discoverPostgresDsns: discover
      });
      return { source: manualConnectionSource(driver), overrides };
    }
    return { source: manualConnectionSource(driver) };
  }

  input.io.stdout.write("Buscando bancos locais...\n");
  const discovery = await input.scan({ roots: input.options.roots });
  const candidate = await selectCandidate(discovery.candidates, input.prompt, input.io);
  return { source: discoveryConnectionSource(candidate) };
}
```

Update the call site in `runDatabaseSetup` (near line 287):

```ts
  const { source: connectionSource, overrides } = await resolveConnectionSource({
    mode,
    options,
    prompt,
    io,
    scan
  });
  let config = await promptForConnectionConfig({
    source: connectionSource,
    options,
    prompt,
    env,
    io,
    defaultsOverride: overrides
  });
```

Find `promptForConnectionConfig` in the file. Add the optional `defaultsOverride` parameter to its input interface, and apply the override to the defaults derived from `connectionDefaults`. Concretely:

```ts
// Inside promptForConnectionConfig's input type:
//   defaultsOverride?: Partial<ConnectionDefaults>;
// And near the start of promptForConnectionConfig where defaults are built:
const base = connectionDefaults(input.source, input.env);
const defaults: ConnectionDefaults = { ...base, ...(input.defaultsOverride ?? {}) };
// ... use `defaults` everywhere instead of `base` below.
```

(Refer to the existing implementation of `promptForConnectionConfig` for the exact replacement; the change is purely additive — a one-line spread.)

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS (all existing tests plus the new ones).

- [ ] **Step 7: Commit**

```bash
git add src/cli/database-setup.ts tests/cli/database-setup.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): fluxo postgresql oferece descoberta de DSN PSQLODBC para pre-fill

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Production wiring of `pg` via dynamic import

**Files:**
- Modify: `src/cli/database-setup.ts` (function `createOptionalDriverDependencies`)

- [ ] **Step 1: Add the postgres connection factory to production wiring**

In `src/cli/database-setup.ts`, find `createOptionalDriverDependencies` (near line 887). Replace its body with:

```ts
function createOptionalDriverDependencies(): AdapterFactoryDependencies {
  return {
    mysqlConnectionFactory: async (config) => {
      const mysql = await import("mysql2/promise");
      const connection = await mysql.createConnection({
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: config.password
      });
      return {
        query: (sql, params) => connection.query(sql, [...params]),
        end: () => connection.end()
      };
    },
    firebirdConnectionFactory: async (config) => {
      const firebird = await importUnknownModule("node-firebird");
      return await attachFirebirdConnection(
        firebird as {
          attach: (
            options: Record<string, unknown>,
            callback: (error: Error | undefined, db: { query: Function; detach: Function }) => void
          ) => void;
        },
        config
      );
    },
    postgresConnectionFactory: async (config) => {
      const pg = await import("pg");
      const client = new pg.Client({
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: config.password
      });
      await client.connect();
      return {
        query: async (sql, params) => client.query(sql, [...params]),
        end: () => client.end()
      };
    }
  };
}
```

- [ ] **Step 2: Run the full suite and the build**

Run: `npm test && npm run build`
Expected: both PASS. Type errors from `pg`'s typings would surface in `npm run build`.

- [ ] **Step 3: Commit**

```bash
git add src/cli/database-setup.ts
git commit -m "$(cat <<'EOF'
feat(cli): wiring producao do driver postgresql via import dinamico de pg

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Wire postgres factory anywhere else the factory is built in production

**Files:**
- Modify: any other file in `src/` that constructs `AdapterFactoryDependencies` (search-driven).

- [ ] **Step 1: Find all builders of `AdapterFactoryDependencies` in `src/`**

Run: `grep -RIn "AdapterFactoryDependencies\|mysqlConnectionFactory" src/ --include="*.ts"`
Expected: the obvious hit is `src/cli/database-setup.ts` (already updated in Task 12). Any other production builder (e.g., in `src/main.ts`, `src/service/`, `src/index.ts`) must also receive a `postgresConnectionFactory`.

- [ ] **Step 2: For each additional production builder, add the postgres factory**

Apply the same `await import("pg")` pattern from Task 12. If no other production builder exists, this step is a no-op — commit anyway is unnecessary.

- [ ] **Step 3: Run the build to catch any missing wiring**

Run: `npm run build`
Expected: PASS. A failure points to a builder still missing `postgresConnectionFactory`.

- [ ] **Step 4: Commit (only if changes were made)**

```bash
git add -p src
git commit -m "$(cat <<'EOF'
feat(runtime): injeta postgresConnectionFactory nos demais call sites

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

If no changes were made, skip the commit.

---

## Task 14: Documentation update

**Files:**
- Modify: `docs/manual-system-tests.md`
- Modify: `README.md` (optional — update the supported driver list if it appears literally)

- [ ] **Step 1: Add Postgres smoke test paragraph**

Open `docs/manual-system-tests.md` and append a new section:

```markdown
## PostgreSQL (VetorFarma) smoke test

Pré-requisito: um Postgres local acessível (Docker/Podman ou instalação direta) com pelo menos uma tabela de produtos populada.

1. Suba o Postgres: `docker run --rm -d --name pg-smoke -e POSTGRES_PASSWORD=test -p 5432:5432 postgres:16`.
2. Execute `npm run database-setup --`.
3. Selecione `postgresql` no driver picker.
4. Quando perguntado "Procurar DSN PSQLODBC instalado?", responda "não" (caminho de smoke test em Linux/macOS).
5. Preencha host=`127.0.0.1`, port=`5432`, database=`postgres`, user=`postgres`, password=`test`.
6. Verifique que a conexão sucede (`Conexao OK.`), que `listTables` retorna tabelas qualificadas por schema (`public.<nome>`), e que o artefato em `~/.pharma-agent/database-setup.json` contém `driver: "postgresql"` e nenhum campo de senha.
7. Limpe: `docker rm -f pg-smoke`.

Em Windows, opcionalmente repita com um DSN PSQLODBC pré-configurado para validar o fluxo de descoberta.
```

- [ ] **Step 2: Update README driver list (only if it mentions MySQL/Firebird explicitly)**

Run: `grep -n "MySQL\|Firebird" README.md`
If a line like "Manual setup supports **MySQL** and **Firebird**" exists, update it to also mention PostgreSQL. Otherwise skip.

- [ ] **Step 3: Commit**

```bash
git add docs/manual-system-tests.md README.md
git commit -m "$(cat <<'EOF'
docs: smoke test manual e suporte a postgresql no setup

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Final verification

**Files:** none.

- [ ] **Step 1: Run the full test suite with coverage**

Run: `npm run coverage`
Expected: PASS, coverage thresholds met. The new files (`postgresql-adapter.ts`, `dsn-discovery.ts`, `registry-reader.ts`) should be at or above the project-wide 80% threshold.

- [ ] **Step 2: Build the dist**

Run: `npm run build`
Expected: PASS, no type errors.

- [ ] **Step 3: Confirm no live Postgres connection happens in tests**

Run: `grep -RIn "new pg\.Client\|new Client(" src/ tests/`
Expected: the only `new pg.Client(...)` reference is in `src/cli/database-setup.ts:createOptionalDriverDependencies` (production wiring). Tests must not reach `pg.Client` directly.

- [ ] **Step 4: Confirm no DSN test reads from real Registry**

Run: `grep -RIn "createRegExeRegistryReader" tests/`
Expected: any reference uses `createRegExeRegistryReader({ platform: ..., exec: ... })` with both options injected.

- [ ] **Step 5: Final commit (only if any cleanup happened)**

If Step 1–4 produced no new edits, no commit is needed. Otherwise:

```bash
git add -p
git commit -m "$(cat <<'EOF'
chore: cleanup pos-implementacao do suporte postgresql

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```
