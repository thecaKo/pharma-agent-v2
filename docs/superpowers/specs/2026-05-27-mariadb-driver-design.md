# Driver MariaDB — Design

**Data:** 2026-05-27
**Status:** Aprovado

## Objetivo

Adicionar suporte ao MariaDB como driver de banco de origem distinto, ao lado dos já existentes `mysql`, `firebird` e `postgresql`. Configuração apenas via `.env` nesta iteração — o CLI `database-setup` e o `file-discovery` ficam fora de escopo.

## Decisões de design

| Decisão | Escolha | Motivação |
|---|---|---|
| Identificação | Driver próprio `"mariadb"` no union `DatabaseDriver` | Discovery, logs, métricas e erros refletem o tipo real do banco. |
| Pacote npm | `mariadb` oficial (nova dependência) | Suporte completo a auth plugins (`ed25519`, `parsec`, `gssapi`) e tipos específicos. |
| Reuso de código | Arquivo independente (`mariadb-adapter.ts`) | A API do pacote `mariadb` difere do `mysql2` (sem tupla `[rows, fields]`); cópia adaptada do `mysql-adapter` evita acoplar evoluções futuras. |
| CLI `database-setup` | **Fora de escopo** | MariaDB configurável apenas via `.env` nesta iteração. |
| `file-discovery` | **Não muda** | Arquivos InnoDB são indistinguíveis entre MySQL e MariaDB; ambiguidade não precisa ser resolvida sem CLI. |
| Pool/SSL | Single connection, sem pool, sem SSL configurável | Paridade exata com o `MySqlSourceAdapter` atual. |

## Pontos de toque

### `src/config/types.ts`
Adicionar `"mariadb"` ao union `DatabaseDriver`:

```ts
export type DatabaseDriver = "mysql" | "firebird" | "postgresql" | "mariadb";
```

### `src/config/env.ts`
Incluir `"mariadb"` no `Set` de drivers permitidos e atualizar a mensagem de erro de `DB_DRIVER`:

```ts
const DATABASE_DRIVERS = new Set<DatabaseDriver>(["mysql", "firebird", "postgresql", "mariadb"]);
// ...
issues.push({ field: "DB_DRIVER", message: "must be mysql, firebird, postgresql, or mariadb" });
```

### `src/db/source-adapter.ts`
Estender o union `SourceDatabaseAdapterKind` com `"mariadb"`.

### `src/db/errors.ts`
**Não muda.** O módulo importa `DatabaseDriver` direto de `config/types.ts`, então a extensão do union em types.ts propaga automaticamente. As mensagens de erro já usam `${input.driver}` interpolado, o label `"mariadb"` aparece naturalmente.

### `src/db/mariadb-adapter.ts` (novo)
Cópia adaptada de `mysql-adapter.ts`. Exporta:

- `MariaDbConnectionConfig` — idêntico a `MySqlConnectionConfig`.
- `MariaDbDriverConnection` — mesma interface (`query(sql, params): Promise<unknown>`, `end(): Promise<void>`).
- `MariaDbConnectionFactory` — `(config: MariaDbConnectionConfig) => Promise<MariaDbDriverConnection>`.
- `MariaDbSourceAdapter implements SourceDatabaseAdapter` — mesma estrutura do `MySqlSourceAdapter`, todas as chamadas a `normalizeDatabaseError` usam `driver: "mariadb"`.

SQL idêntico ao MySQL adapter (queries contra `information_schema.tables` e `information_schema.columns`, paginação `limit ? offset ?`).

Os helpers `normalizeRows`, `normalizeTables`, `normalizeColumns`, `readTableName`, `readColumn`, `normalizeString`, `normalizeOptionalString`, `normalizeNullable`, `normalizeCursorParam`, `isRecord` são copiados verbatim. A condição `Array.isArray(result) && Array.isArray(result[0])` em `normalizeRows` já cobre tanto a resposta tupla do `mysql2` quanto o array direto do `mariadb` oficial — o else path lida com o array direto.

### `src/db/adapter-factory.ts`
Adicionar `mariadbConnectionFactory` em `AdapterFactoryDependencies`:

```ts
export interface AdapterFactoryDependencies {
  mysqlConnectionFactory: MySqlConnectionFactory;
  firebirdConnectionFactory: FirebirdConnectionFactory;
  postgresConnectionFactory: PostgresConnectionFactory;
  mariadbConnectionFactory: MariaDbConnectionFactory;
}
```

Novo case no switch:

```ts
case "mariadb":
  return new MariaDbSourceAdapter({
    config: input.config,
    connectionFactory: input.dependencies.mariadbConnectionFactory,
    secrets: input.secrets
  });
```

### `src/service/runtime.ts`
Adicionar `mariadbConnectionFactory` no wiring de dependências:

```ts
mariadbConnectionFactory: async (config) => {
  const mariadb = await import("mariadb");
  const connection = await mariadb.default.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database
  });
  return {
    query: (sql, params) => connection.query(sql, params as unknown[]),
    end: () => connection.end()
  };
}
```

A forma exata da importação (`mariadb.default` vs `mariadb`) é validada no momento da implementação. O adapter abstrai isso.

### `package.json`
Adicionar `"mariadb": "^3.x"` em `dependencies`. Versão exata definida no momento da instalação (latest stable).

## Testes

**TDD com vitest.** Cada teste é escrito antes da implementação correspondente.

### `tests/db/mariadb-adapter.test.ts` (novo)
Espelho de `mysql-adapter.test.ts`. Cobre:

- `connect()` chama a `MariaDbConnectionFactory` com config correto.
- `connect()` propaga falha como `DatabaseError` com `driver: "mariadb"` e secrets redacted.
- `close()` é idempotente quando não conectado e fecha quando conectado.
- `queryChanges` repassa SQL e params (com normalização de cursor) à connection; retorna linhas normalizadas.
- `querySnapshotPage` repassa SQL, `limit` e `offset` à connection.
- `listTables` consulta `information_schema.tables` filtrando por `table_schema` e retorna nomes ordenados.
- `listColumns` consulta `information_schema.columns` e retorna `{ name, dataType, nullable }`.
- Resposta no formato array direto (estilo `mariadb` oficial) é normalizada corretamente — caso explícito.
- Resposta no formato tupla `[rows, fields]` (estilo `mysql2`) também é normalizada — robustez.
- Operações sem `connect()` prévio lançam `DatabaseError` com `driver: "mariadb"`.

### `tests/db/adapter-factory.test.ts`
Adicionar:

- `driver: "mariadb"` em `DatabaseConfig` retorna instância de `MariaDbSourceAdapter`.
- A `mariadbConnectionFactory` injetada é repassada para o adapter.

### `tests/config/env.test.ts`
Adicionar (se o arquivo existir):

- `DB_DRIVER=mariadb` é aceito como configuração válida.
- Mensagem de erro de `DB_DRIVER` inválido inclui `"mariadb"`.

### Fora de escopo
- Testes de integração contra um MariaDB real (mesmo padrão do MySQL atual).
- Validação de auth plugins (`ed25519`, etc.) — coberto pelo pacote `mariadb`; smoke manual documentado como follow-up.

## Follow-ups (não cobertos nesta iteração)

- Suporte ao MariaDB no CLI `database-setup` (prompt manual + desambiguação após file-discovery).
- Smoke manual com servidor MariaDB real (validar conexão, queries de metadata, paginação).
- Pool de conexões e SSL configurável (paridade ainda com o MySQL adapter, que também não tem).
