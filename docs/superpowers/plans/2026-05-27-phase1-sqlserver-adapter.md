# Fase 1 — SQL Server Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar suporte ao Microsoft SQL Server como driver de banco de origem (`DB_DRIVER=sqlserver`), com adapter próprio usando o pacote `mssql`, suportando named instances e SQL Authentication.

**Architecture:** Novo `SqlServerSourceAdapter` em arquivo independente, espelhando o padrão de `MariaDbSourceAdapter`. Factory atualizado com novo case. `DatabaseConfig` ganha campo opcional `instance?: string` para named instances. Validação: `instance` e `port` mutuamente exclusivos. TLS habilitado por default; `trustServerCertificate` configurável. Windows Authentication explicitamente rejeitada (fase 2).

**Tech Stack:** TypeScript (ESM), vitest, pacote npm `mssql` (em `optionalDependencies`), Node 20+.

**Spec:** `docs/superpowers/specs/2026-05-27-discovery-multi-erp-design.md` (Seção "Adapter SQL Server").

---

## File Structure

**Novos arquivos:**
- `src/db/sqlserver-adapter.ts` — adapter, tipos e connection factory interface
- `tests/db/sqlserver-adapter.test.ts` — testes unitários do adapter

**Modificados:**
- `src/config/types.ts` — estende `DatabaseDriver` + adiciona `instance?: string` + `trustServerCertificate?: boolean` no `DatabaseConfig`
- `src/config/env.ts` — adiciona `"sqlserver"` no set, parse de `DB_INSTANCE` e `DB_TRUST_SERVER_CERTIFICATE`, regra de exclusão mútua instance/port, mensagem de erro atualizada
- `src/db/source-adapter.ts` — estende `SourceDatabaseAdapterKind`
- `src/db/adapter-factory.ts` — novo case + dependência `sqlserverConnectionFactory`
- `src/service/runtime.ts` — wiring da connection factory usando pacote `mssql`
- `tests/config/env.test.ts` — caso de aceite `DB_DRIVER=sqlserver`, instance, trust cert, mensagem
- `tests/db/adapter-factory.test.ts` — caso `driver: "sqlserver"` + dependencies
- `package.json` — adiciona `mssql` em `optionalDependencies`

**Não muda:** `src/db/errors.ts` (usa `DatabaseDriver` direto), `src/db/file-discovery.ts`, `src/cli/database-setup.ts` (será atualizado em fase futura).

---

## Task 1: Estender `DatabaseConfig` com `instance` e `trustServerCertificate`

**Files:**
- Modify: `src/config/types.ts:1,5-12`

- [ ] **Step 1.1: Estender o union `DatabaseDriver` e o tipo `DatabaseConfig`**

Modify `src/config/types.ts:1` e `:5-12`:

```ts
export type DatabaseDriver = "mysql" | "firebird" | "postgresql" | "mariadb" | "sqlserver";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface DatabaseConfig {
  driver: DatabaseDriver;
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
  instance?: string;
  trustServerCertificate?: boolean;
}
```

- [ ] **Step 1.2: Verificar build TS**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: sem erros novos (campos opcionais; consumidores existentes não quebram).

- [ ] **Step 1.3: Commit**

```bash
git add src/config/types.ts
git commit -m "feat(config): aceita driver sqlserver e campos instance/trustServerCertificate"
```

---

## Task 2: Estender validação de `DB_DRIVER` e parse de novos campos

**Files:**
- Modify: `src/config/env.ts:32` (set DATABASE_DRIVERS) e `:131` (mensagem)
- Modify: `tests/config/env.test.ts` — adicionar casos novos

- [ ] **Step 2.1: Escrever testes para sqlserver, instance, trust cert e regra de exclusão mútua**

Modify `tests/config/env.test.ts` — adicionar casos após o teste de `mariadb` (procure por `it("accepts mariadb as a valid DB_DRIVER"`):

```ts
  it("accepts sqlserver as a valid DB_DRIVER", () => {
    const config = loadConfig(validEnv({ DB_DRIVER: "sqlserver", DB_PORT: "1433" }));

    expect(config.database.driver).toBe("sqlserver");
    expect(config.database.port).toBe(1433);
  });

  it("accepts DB_INSTANCE for sqlserver and omits port from config when instance is set", () => {
    const env = validEnv({ DB_DRIVER: "sqlserver", DB_INSTANCE: "SQLEXPRESS" });
    delete env.DB_PORT;

    const config = loadConfig(env);

    expect(config.database.driver).toBe("sqlserver");
    expect(config.database.instance).toBe("SQLEXPRESS");
  });

  it("accepts DB_TRUST_SERVER_CERTIFICATE=true for sqlserver", () => {
    const config = loadConfig(
      validEnv({ DB_DRIVER: "sqlserver", DB_PORT: "1433", DB_TRUST_SERVER_CERTIFICATE: "true" })
    );

    expect(config.database.trustServerCertificate).toBe(true);
  });

  it("rejects DB_INSTANCE together with DB_PORT for sqlserver", () => {
    try {
      loadConfig(validEnv({ DB_DRIVER: "sqlserver", DB_PORT: "1433", DB_INSTANCE: "SQLEXPRESS" }));
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(String(error)).toContain("DB_INSTANCE cannot be combined with DB_PORT");
    }
  });

  it("rejects DB_INSTANCE for non-sqlserver drivers", () => {
    try {
      loadConfig(validEnv({ DB_DRIVER: "postgresql", DB_PORT: "5432", DB_INSTANCE: "OLD" }));
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(String(error)).toContain("DB_INSTANCE is only valid for DB_DRIVER=sqlserver");
    }
  });
```

E atualizar a mensagem esperada no teste `rejects unsupported database drivers` (procure por `"DB_DRIVER must be mysql"`):

```ts
      expect(String(error)).toContain(
        "DB_DRIVER must be mysql, firebird, postgresql, mariadb, or sqlserver"
      );
```

- [ ] **Step 2.2: Rodar — devem falhar**

Run: `npx vitest run tests/config/env.test.ts`
Expected: 5 falhas — todas relacionadas a `sqlserver` desconhecido ou campos `DB_INSTANCE`/`DB_TRUST_SERVER_CERTIFICATE` não lidos.

- [ ] **Step 2.3: Atualizar `DATABASE_DRIVERS` em `env.ts`**

Modify `src/config/env.ts:32`:

```ts
const DATABASE_DRIVERS = new Set<DatabaseDriver>([
  "mysql",
  "firebird",
  "postgresql",
  "mariadb",
  "sqlserver"
]);
```

- [ ] **Step 2.4: Atualizar a mensagem de erro de driver**

Modify `src/config/env.ts:131`:

```ts
issues.push({
  field: "DB_DRIVER",
  message: "must be mysql, firebird, postgresql, mariadb, or sqlserver"
});
```

- [ ] **Step 2.5: Adicionar parse de `DB_INSTANCE` e `DB_TRUST_SERVER_CERTIFICATE`**

Localize em `src/config/env.ts` o bloco onde `database` é montado (procure por `const database: DatabaseConfig = {`). Adicione, antes desse bloco, leitura dos novos envs:

```ts
const rawInstance = env.DB_INSTANCE?.trim();
const rawTrustServerCert = env.DB_TRUST_SERVER_CERTIFICATE?.trim().toLowerCase();
```

Adicione regras de validação no bloco onde issues são acumuladas (junto às outras validações de DB):

```ts
if (rawInstance && driver !== "sqlserver") {
  issues.push({
    field: "DB_INSTANCE",
    message: "DB_INSTANCE is only valid for DB_DRIVER=sqlserver"
  });
}

if (rawInstance && env.DB_PORT && env.DB_PORT.trim().length > 0) {
  issues.push({
    field: "DB_INSTANCE",
    message: "DB_INSTANCE cannot be combined with DB_PORT (SQL Browser resolves the port)"
  });
}
```

Estenda o objeto `database` para incluir os campos novos (apenas quando aplicáveis):

```ts
const database: DatabaseConfig = {
  driver,
  host,
  port,
  name,
  user,
  password
};

if (rawInstance) {
  database.instance = rawInstance;
}

if (rawTrustServerCert !== undefined) {
  database.trustServerCertificate = rawTrustServerCert === "true" || rawTrustServerCert === "1";
}
```

Quando `instance` está presente para `sqlserver`, o parser de `DB_PORT` deve aceitar a ausência — verifique se a validação atual de `DB_PORT` (`port must be a positive integer`) já permite ausência quando `driver === "sqlserver" && rawInstance`. Caso obrigue, ajustar para tornar `DB_PORT` opcional nesse caso, atribuindo `port = 0` como sentinel não-usado:

```ts
let port = 0;
if (env.DB_PORT && env.DB_PORT.trim().length > 0) {
  // ...lógica existente de parseInt + validação...
} else if (!(driver === "sqlserver" && rawInstance)) {
  issues.push({ field: "DB_PORT", message: "must be a positive integer" });
}
```

- [ ] **Step 2.6: Rodar testes — devem passar**

Run: `npx vitest run tests/config/env.test.ts`
Expected: PASS para todos.

- [ ] **Step 2.7: Commit**

```bash
git add src/config/env.ts tests/config/env.test.ts
git commit -m "feat(config): valida instance e trust cert para sqlserver"
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
  | "sqlserver";
```

- [ ] **Step 3.2: Verificar build TS**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: sem erros novos.

- [ ] **Step 3.3: Commit**

```bash
git add src/db/source-adapter.ts
git commit -m "feat(db): aceita sqlserver em SourceDatabaseAdapterKind"
```

---

## Task 4: Criar `SqlServerSourceAdapter` (TDD)

**Files:**
- Create: `tests/db/sqlserver-adapter.test.ts`
- Create: `src/db/sqlserver-adapter.ts`

- [ ] **Step 4.1: Escrever o arquivo de teste completo**

Create `tests/db/sqlserver-adapter.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { DatabaseOperationError } from "../../src/db/errors.js";
import {
  SqlServerSourceAdapter,
  type SqlServerDriverConnection
} from "../../src/db/sqlserver-adapter.js";
import type { DatabaseConfig } from "../../src/config/types.js";

const baseConfig: DatabaseConfig = {
  driver: "sqlserver",
  host: "10.0.0.5",
  port: 1433,
  name: "pharmacy",
  user: "readonly",
  password: "super-secret-password"
};

describe("SqlServerSourceAdapter", () => {
  it("opens a connection with host+port and TLS encryption enabled by default", async () => {
    const connection: SqlServerDriverConnection = {
      query: vi.fn(async () => ({ recordset: [] })),
      close: vi.fn(async () => undefined)
    };
    const connectionFactory = vi.fn(async () => connection);
    const adapter = new SqlServerSourceAdapter({ config: baseConfig, connectionFactory });

    await adapter.connect();

    expect(connectionFactory).toHaveBeenCalledWith({
      server: "10.0.0.5",
      port: 1433,
      database: "pharmacy",
      user: "readonly",
      password: "super-secret-password",
      encrypt: true,
      trustServerCertificate: false
    });
  });

  it("opens a connection with named instance and omits port when instance is set", async () => {
    const connection: SqlServerDriverConnection = {
      query: vi.fn(async () => ({ recordset: [] })),
      close: vi.fn(async () => undefined)
    };
    const connectionFactory = vi.fn(async () => connection);
    const adapter = new SqlServerSourceAdapter({
      config: { ...baseConfig, instance: "SQLEXPRESS", port: 0 },
      connectionFactory
    });

    await adapter.connect();

    expect(connectionFactory).toHaveBeenCalledWith({
      server: "10.0.0.5\\SQLEXPRESS",
      database: "pharmacy",
      user: "readonly",
      password: "super-secret-password",
      encrypt: true,
      trustServerCertificate: false
    });
  });

  it("passes trustServerCertificate=true when configured", async () => {
    const connection: SqlServerDriverConnection = {
      query: vi.fn(async () => ({ recordset: [] })),
      close: vi.fn(async () => undefined)
    };
    const connectionFactory = vi.fn(async () => connection);
    const adapter = new SqlServerSourceAdapter({
      config: { ...baseConfig, trustServerCertificate: true },
      connectionFactory
    });

    await adapter.connect();

    expect(connectionFactory).toHaveBeenCalledWith(
      expect.objectContaining({ trustServerCertificate: true })
    );
  });

  it("passes configured SQL, cursor and limit to the database driver boundary", async () => {
    const connection: SqlServerDriverConnection = {
      query: vi.fn(async () => ({ recordset: [{ product_id: "P-001", updated_at: 12 }] })),
      close: vi.fn(async () => undefined)
    };
    const adapter = new SqlServerSourceAdapter({
      config: baseConfig,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    const rows = await adapter.queryChanges({
      sql: "select * from products where updated_at > @cursor order by updated_at offset 0 rows fetch next @limit rows only",
      cursor: 10,
      limit: 25
    });

    expect(connection.query).toHaveBeenCalledWith(
      "select * from products where updated_at > @cursor order by updated_at offset 0 rows fetch next @limit rows only",
      { cursor: 10, limit: 25 }
    );
    expect(rows).toEqual([{ product_id: "P-001", updated_at: 12 }]);
  });

  it("queries snapshot pages with limit and offset", async () => {
    const connection: SqlServerDriverConnection = {
      query: vi.fn(async () => ({ recordset: [{ product_id: "P-001" }] })),
      close: vi.fn(async () => undefined)
    };
    const adapter = new SqlServerSourceAdapter({
      config: baseConfig,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    await expect(
      adapter.querySnapshotPage({
        sql: "select * from products order by product_id offset @offset rows fetch next @limit rows only",
        limit: 500,
        offset: 1000
      })
    ).resolves.toEqual([{ product_id: "P-001" }]);

    expect(connection.query).toHaveBeenCalledWith(
      "select * from products order by product_id offset @offset rows fetch next @limit rows only",
      { limit: 500, offset: 1000 }
    );
  });

  it("coerces timestamp cursor strings into Date values", async () => {
    const connection: SqlServerDriverConnection = {
      query: vi.fn(async () => ({ recordset: [] })),
      close: vi.fn(async () => undefined)
    };
    const adapter = new SqlServerSourceAdapter({
      config: baseConfig,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    await adapter.queryChanges({
      sql: "select * from products where updated_at > @cursor",
      cursor: "2026-05-16T20:00:02.000Z",
      limit: 25
    });

    expect(connection.query).toHaveBeenCalledWith(expect.any(String), {
      cursor: expect.any(Date),
      limit: 25
    });
  });

  it("queries table metadata via sys.tables and returns sorted names", async () => {
    const connection: SqlServerDriverConnection = {
      query: vi.fn(async () => ({
        recordset: [{ name: "z_products" }, { name: "customers" }, { name: "products" }]
      })),
      close: vi.fn(async () => undefined)
    };
    const adapter = new SqlServerSourceAdapter({
      config: baseConfig,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    const tables = await adapter.listTables();

    expect(connection.query).toHaveBeenCalledWith(expect.stringContaining("sys.tables"), {});
    expect(tables).toEqual([{ name: "customers" }, { name: "products" }, { name: "z_products" }]);
  });

  it("returns empty list when metadata rows are not in expected shape", async () => {
    const connection: SqlServerDriverConnection = {
      query: vi.fn(async () => ({ recordset: [{ table: "products" }, { name: 123 }, null] })),
      close: vi.fn(async () => undefined)
    };
    const adapter = new SqlServerSourceAdapter({
      config: baseConfig,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    await expect(adapter.listTables()).resolves.toEqual([]);
  });

  it("queries column metadata via sys.columns and normalizes types", async () => {
    const connection: SqlServerDriverConnection = {
      query: vi.fn(async () => ({
        recordset: [
          { name: " PRODUCT_ID ", dataType: "VARCHAR", nullable: 0 },
          { name: "updated_at", dataType: "DATETIME", nullable: 1 },
          { name: "stock", dataType: " int ", nullable: true }
        ]
      })),
      close: vi.fn(async () => undefined)
    };
    const adapter = new SqlServerSourceAdapter({
      config: baseConfig,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    const columns = await adapter.listColumns("products");

    expect(connection.query).toHaveBeenCalledWith(expect.stringContaining("sys.columns"), {
      table: "products"
    });
    expect(columns).toEqual([
      { name: "PRODUCT_ID", dataType: "varchar", nullable: false },
      { name: "updated_at", dataType: "datetime", nullable: true },
      { name: "stock", dataType: "int", nullable: true }
    ]);
  });

  it("normalizes query failures without leaking password or db name", async () => {
    const connection: SqlServerDriverConnection = {
      query: vi.fn(async () => {
        throw Object.assign(new Error("Login failed for pharmacy using super-secret-password"), {
          code: "ELOGIN"
        });
      }),
      close: vi.fn(async () => undefined)
    };
    const adapter = new SqlServerSourceAdapter({
      config: baseConfig,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    try {
      await adapter.listTables();
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseOperationError);
      expect(error).toMatchObject({
        driver: "sqlserver",
        operation: "listTables",
        errorCode: "SQLSERVER_ELOGIN"
      });
      expect(String(error)).not.toContain("super-secret-password");
      expect(String(error)).not.toContain("pharmacy");
      expect(String(error)).toContain("[REDACTED]");
    }
  });

  it("normalizes connection failures without leaking password", async () => {
    const adapter = new SqlServerSourceAdapter({
      config: baseConfig,
      connectionFactory: vi.fn(async () => {
        throw Object.assign(new Error("Login failed: super-secret-password"), { code: "ELOGIN" });
      })
    });

    await expect(adapter.connect()).rejects.toMatchObject({
      name: "DatabaseOperationError",
      driver: "sqlserver",
      operation: "connect",
      errorCode: "SQLSERVER_ELOGIN"
    });

    try {
      await adapter.connect();
    } catch (error) {
      expect(String(error)).not.toContain("super-secret-password");
      expect(String(error)).toContain("[REDACTED]");
    }
  });

  it("closes connected sessions and rejects queries after close", async () => {
    const connection: SqlServerDriverConnection = {
      query: vi.fn(async () => ({ recordset: [] })),
      close: vi.fn(async () => undefined)
    };
    const adapter = new SqlServerSourceAdapter({
      config: baseConfig,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    await adapter.close();
    await adapter.close();

    expect(connection.close).toHaveBeenCalledOnce();

    await expect(
      adapter.queryChanges({ sql: "select 1", cursor: null, limit: 1 })
    ).rejects.toMatchObject({
      driver: "sqlserver",
      operation: "query",
      errorCode: "SQLSERVER_DATABASE_ERROR"
    });
  });

  it("normalizes close failures", async () => {
    const adapter = new SqlServerSourceAdapter({
      config: baseConfig,
      connectionFactory: vi.fn(async () => ({
        query: vi.fn(async () => ({ recordset: [] })),
        close: vi.fn(async () => {
          throw Object.assign(new Error("connection close timeout"), { code: "ETIMEDOUT" });
        })
      }))
    });

    await adapter.connect();

    await expect(adapter.close()).rejects.toMatchObject({
      driver: "sqlserver",
      operation: "close",
      errorCode: "SQLSERVER_ETIMEDOUT",
      retryable: true
    });
  });
});
```

- [ ] **Step 4.2: Rodar testes — devem falhar com módulo não encontrado**

Run: `npx vitest run tests/db/sqlserver-adapter.test.ts`
Expected: FAIL — `Cannot find module '../../src/db/sqlserver-adapter.js'`.

- [ ] **Step 4.3: Implementar `sqlserver-adapter.ts`**

Create `src/db/sqlserver-adapter.ts`:

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

export interface SqlServerConnectionConfig {
  server: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  encrypt: true;
  trustServerCertificate: boolean;
}

export interface SqlServerDriverConnection {
  query(sql: string, params: Record<string, unknown>): Promise<{ recordset: unknown }>;
  close(): Promise<void>;
}

export type SqlServerConnectionFactory = (
  config: SqlServerConnectionConfig
) => Promise<SqlServerDriverConnection>;

export interface SqlServerSourceAdapterOptions {
  config: DatabaseConfig;
  connectionFactory: SqlServerConnectionFactory;
  secrets?: readonly string[];
}

export class SqlServerSourceAdapter implements SourceDatabaseAdapter {
  private readonly config: DatabaseConfig;
  private readonly connectionFactory: SqlServerConnectionFactory;
  private readonly secrets: readonly string[];
  private connection?: SqlServerDriverConnection;

  public constructor(options: SqlServerSourceAdapterOptions) {
    this.config = options.config;
    this.connectionFactory = options.connectionFactory;
    this.secrets = options.secrets ?? [options.config.password, options.config.name];
  }

  public async connect(): Promise<void> {
    try {
      this.connection = await this.connectionFactory(this.buildConnectionConfig());
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "sqlserver",
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
      await this.connection.close();
      this.connection = undefined;
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "sqlserver",
        operation: "close",
        error,
        secrets: this.secrets
      });
    }
  }

  public async queryChanges(input: QueryChangesInput): Promise<SourceRow[]> {
    const connection = this.requireConnection();
    try {
      const result = await connection.query(input.sql, {
        cursor: normalizeCursorParam(input.cursor),
        limit: input.limit
      });
      return normalizeRows(result.recordset);
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "sqlserver",
        operation: "query",
        error,
        secrets: this.secrets
      });
    }
  }

  public async querySnapshotPage(input: QuerySnapshotPageInput): Promise<SourceRow[]> {
    const connection = this.requireConnection();
    try {
      const result = await connection.query(input.sql, {
        limit: input.limit,
        offset: input.offset
      });
      return normalizeRows(result.recordset);
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "sqlserver",
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
          select name
          from sys.tables
          where is_ms_shipped = 0
          order by name
        `,
        {}
      );
      return normalizeTables(result.recordset);
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "sqlserver",
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
          select c.name as name,
                 t.name as dataType,
                 c.is_nullable as nullable
          from sys.columns c
          join sys.types t on t.user_type_id = c.user_type_id
          where c.object_id = object_id(@table)
          order by c.column_id
        `,
        { table: tableName }
      );
      return normalizeColumns(result.recordset);
    } catch (error) {
      throw normalizeDatabaseError({
        driver: "sqlserver",
        operation: "listColumns",
        error,
        secrets: this.secrets
      });
    }
  }

  private buildConnectionConfig(): SqlServerConnectionConfig {
    const base = {
      database: this.config.name,
      user: this.config.user,
      password: this.config.password,
      encrypt: true as const,
      trustServerCertificate: this.config.trustServerCertificate ?? false
    };

    if (this.config.instance) {
      return {
        ...base,
        server: `${this.config.host}\\${this.config.instance}`
      };
    }

    return {
      ...base,
      server: this.config.host,
      port: this.config.port
    };
  }

  private requireConnection(operation: DatabaseOperation = "query"): SqlServerDriverConnection {
    if (!this.connection) {
      throw normalizeDatabaseError({
        driver: "sqlserver",
        operation,
        error: new Error("Database adapter is not connected"),
        secrets: this.secrets
      });
    }
    return this.connection;
  }
}

function normalizeRows(recordset: unknown): SourceRow[] {
  if (!Array.isArray(recordset)) {
    return [];
  }
  return recordset.filter(isRecord).map((row) => ({ ...row }));
}

function normalizeTables(recordset: unknown): DatabaseTable[] {
  if (!Array.isArray(recordset)) {
    return [];
  }
  return recordset
    .map(readTableName)
    .filter((name): name is string => name !== undefined)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({ name }));
}

function normalizeColumns(recordset: unknown): DatabaseColumn[] {
  if (!Array.isArray(recordset)) {
    return [];
  }
  return recordset.map(readColumn).filter((c): c is DatabaseColumn => c !== undefined);
}

function readTableName(row: unknown): string | undefined {
  if (!isRecord(row)) return undefined;
  const value = row.name;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readColumn(row: unknown): DatabaseColumn | undefined {
  if (!isRecord(row)) return undefined;
  const name = normalizeString(row.name);
  if (!name) return undefined;
  return {
    name,
    dataType: normalizeOptionalString(row.dataType),
    nullable: normalizeNullable(row.nullable)
  };
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

- [ ] **Step 4.4: Rodar testes — devem passar**

Run: `npx vitest run tests/db/sqlserver-adapter.test.ts`
Expected: PASS para todos.

- [ ] **Step 4.5: Commit**

```bash
git add src/db/sqlserver-adapter.ts tests/db/sqlserver-adapter.test.ts
git commit -m "feat(db): adiciona SqlServerSourceAdapter"
```

---

## Task 5: Adicionar case `sqlserver` no `adapter-factory`

**Files:**
- Modify: `tests/db/adapter-factory.test.ts`
- Modify: `src/db/adapter-factory.ts`

- [ ] **Step 5.1: Atualizar o teste do factory**

Modify `tests/db/adapter-factory.test.ts`:

Adicionar import após linha 6:

```ts
import { SqlServerSourceAdapter } from "../../src/db/sqlserver-adapter.js";
```

Adicionar config após `mariadbConfig` (linha 30-34):

```ts
const sqlserverConfig: DatabaseConfig = {
  ...mysqlConfig,
  driver: "sqlserver",
  port: 1433
};
```

Atualizar `dependencies` (linhas 36-41):

```ts
const dependencies = () => ({
  mysqlConnectionFactory: vi.fn(),
  firebirdConnectionFactory: vi.fn(),
  postgresConnectionFactory: vi.fn(),
  mariadbConnectionFactory: vi.fn(),
  sqlserverConnectionFactory: vi.fn()
});
```

Adicionar caso de teste após o de MariaDB:

```ts
  it("returns SQL Server adapter when DB_DRIVER=sqlserver", () => {
    const adapter = createSourceDatabaseAdapter({
      config: sqlserverConfig,
      dependencies: dependencies()
    });
    expect(adapter).toBeInstanceOf(SqlServerSourceAdapter);
  });
```

- [ ] **Step 5.2: Rodar — devem falhar**

Run: `npx vitest run tests/db/adapter-factory.test.ts`
Expected: FAIL — TS error em `sqlserverConnectionFactory` extra ou `UnsupportedDatabaseDriverError`.

- [ ] **Step 5.3: Atualizar o factory**

Modify `src/db/adapter-factory.ts`:

Adicionar import após linha 5:

```ts
import { SqlServerSourceAdapter, type SqlServerConnectionFactory } from "./sqlserver-adapter.js";
```

Estender `AdapterFactoryDependencies`:

```ts
export interface AdapterFactoryDependencies {
  mysqlConnectionFactory: MySqlConnectionFactory;
  firebirdConnectionFactory: FirebirdConnectionFactory;
  postgresConnectionFactory: PostgresConnectionFactory;
  mariadbConnectionFactory: MariaDbConnectionFactory;
  sqlserverConnectionFactory: SqlServerConnectionFactory;
}
```

Adicionar case no switch antes do `default`:

```ts
    case "sqlserver":
      return new SqlServerSourceAdapter({
        config: input.config,
        connectionFactory: input.dependencies.sqlserverConnectionFactory,
        secrets: input.secrets
      });
```

- [ ] **Step 5.4: Rodar — devem passar**

Run: `npx vitest run tests/db/adapter-factory.test.ts`
Expected: PASS para todos.

- [ ] **Step 5.5: Commit**

```bash
git add src/db/adapter-factory.ts tests/db/adapter-factory.test.ts
git commit -m "feat(db): factory cria SqlServerSourceAdapter para driver sqlserver"
```

---

## Task 6: Wiring no `runtime.ts` e dependência `mssql`

**Files:**
- Modify: `package.json` (optionalDependencies)
- Modify: `src/service/runtime.ts` (createOptionalDriverDependencies, em torno da linha 1026)

- [ ] **Step 6.1: Adicionar dependência `mssql` em optionalDependencies**

Run: `npm install --save-optional mssql`
Expected: pacote adicionado em `optionalDependencies` no `package.json` (versão atual estável, ~11.x).

Se o `npm install` adicionar como `dependencies` por default, mover manualmente para `optionalDependencies` no `package.json`:

```json
"optionalDependencies": {
  "...": "...",
  "mssql": "^11.0.1"
}
```

- [ ] **Step 6.2: Registrar `sqlserverConnectionFactory` no runtime**

Modify `src/service/runtime.ts` dentro de `createOptionalDriverDependencies` (próximo à linha 1070, após o `mariadbConnectionFactory`). Adicionar:

```ts
    sqlserverConnectionFactory: async (config) => {
      const mssql = await optionalImport("mssql");
      const sql = mssql.default ?? mssql;
      const pool = new sql.ConnectionPool({
        server: config.server,
        ...(config.port !== undefined ? { port: config.port } : {}),
        database: config.database,
        user: config.user,
        password: config.password,
        options: {
          encrypt: config.encrypt,
          trustServerCertificate: config.trustServerCertificate
        }
      });
      await pool.connect();
      return {
        query: async (sqlText: string, params: Record<string, unknown>) => {
          const request = pool.request();
          for (const [name, value] of Object.entries(params)) {
            request.input(name, value);
          }
          const result = await request.query(sqlText);
          return { recordset: result.recordset };
        },
        close: () => pool.close()
      };
    }
```

Lembrar de colocar vírgula no final da factory anterior (`mariadbConnectionFactory`).

- [ ] **Step 6.3: Verificar build TS**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: sem erros — `AdapterFactoryDependencies` agora exige `sqlserverConnectionFactory` e o runtime fornece.

- [ ] **Step 6.4: Rodar toda a suite**

Run: `npm test`
Expected: PASS para todos os testes do projeto.

- [ ] **Step 6.5: Commit**

```bash
git add package.json package-lock.json pnpm-lock.yaml src/service/runtime.ts
git commit -m "feat(runtime): wiring do driver sqlserver com pacote mssql"
```

---

## Task 7: Atualizar documentação mínima (README)

**Files:**
- Modify: `README.md` (procurar lista de drivers suportados)

- [ ] **Step 7.1: Atualizar a lista de drivers no README**

Localize em `README.md` a menção a "Manual setup supports **MySQL**, **Firebird**, and **PostgreSQL**" (próximo à linha 24) e atualize:

```md
Manual setup supports **MySQL**, **MariaDB**, **Firebird**, **PostgreSQL**, and **SQL Server**
(`DB_DRIVER=sqlserver`, com `DB_INSTANCE=<name>` opcional para named instances) without
selecting a discovered file.
```

- [ ] **Step 7.2: Commit**

```bash
git add README.md
git commit -m "docs: README lista sqlserver como driver suportado"
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
