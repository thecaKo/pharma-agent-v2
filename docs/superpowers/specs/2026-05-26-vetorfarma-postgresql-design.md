# VetorFarma / PostgreSQL connectivity for pharma-agent-v2

Date: 2026-05-26
Status: Approved (brainstorming) — pending implementation plan

## Background

`pharma-agent-v2` today supports only two source drivers: `mysql` and `firebird`
(`src/config/types.ts:1`, `src/db/source-adapter.ts:35`,
`src/db/adapter-factory.ts:27`).

Field discovery: VetorFarma (Zetti Tech ERP/PDV, ~1.600 PDVs) installations
expose `PSQLODBC` on the client machine. PSQLODBC is the official PostgreSQL
ODBC driver (`odbc.postgresql.org`). Its presence is strong evidence that
VetorFarma persists data in PostgreSQL and uses ODBC locally for legacy
Windows components. The agent does not need ODBC: it can speak PostgreSQL
over TCP directly using the `pg` library.

Goal: enable `pharma-agent-v2` to ingest product / stock / price data from
VetorFarma instances and from any other ERP that exposes a PostgreSQL
endpoint.

## Scope

In scope:

- New `postgresql` driver in the existing adapter pipeline.
- New, isolated DSN discovery module that reads PSQLODBC entries from the
  Windows Registry to pre-fill the setup wizard.
- Changes to the `database-setup` CLI to expose the new driver and the new
  discovery path.
- Tests at the same fidelity as MySQL/Firebird today (unit tests against
  injected fakes; no live Postgres in CI).
- One-line addition to `docs/manual-system-tests.md` describing the manual
  Postgres smoke test.

Out of scope (explicitly):

- Generic ODBC adapter. Decided: native `pg` only; ODBC remains a human
  diagnostic aid, not a runtime dependency.
- SSL / TLS configuration for PostgreSQL connections. VetorFarma runs on
  loopback inside the PDV; remote/encrypted Postgres is a future spec.
- A "VetorFarma preset" with hard-coded table/column mapping. Product
  mapping stays owned by the central panel, per the current README contract.
- Connection pooling, query timeouts, automatic in-adapter reconnect. The
  agent uses a single long-lived connection per driver today; `transport/`
  already handles socket-level recovery.
- Refactoring `file-discovery.ts` into a generic "source-discovery"
  abstraction. DSN discovery lives in its own module beside it.
- Reading the Registry on non-Windows hosts (best-effort no-op).
- Reading passwords from a DSN, even if PSQLODBC stored one.

## Architecture

Two parallel additions, each isolated, each following an existing pattern.

### 1. `postgresql` driver in the adapter pipeline

The enum `DatabaseDriver` (`src/config/types.ts:1`) and
`SourceDatabaseAdapterKind` (`src/db/source-adapter.ts:35`) each gain
`"postgresql"`. `createSourceDatabaseAdapter`
(`src/db/adapter-factory.ts:27`) gains a third `case` that constructs a
`PostgresSourceAdapter`. Connection construction is injected via a new
`PostgresConnectionFactory` added to `AdapterFactoryDependencies`. Production
wiring (`src/cli/database-setup.ts:889`) uses `await import("pg")` so the
dependency is loaded lazily, mirroring how `node-firebird` is loaded today.

Driver-agnostic modules (`transport/`, `poller/`, `mapping/`, `state/`,
`logging/`, `service/`) are not touched.

### 2. Independent DSN discovery module

New module `src/db/dsn-discovery.ts`. It is not coupled to
`file-discovery.ts`. Responsibility: enumerate PSQLODBC DSNs from
`HKLM\Software\ODBC\ODBC.INI` and `HKCU\Software\ODBC\ODBC.INI` on
Windows, and return a list of pre-fill suggestions for the setup wizard.

Registry access is abstracted behind a `RegistryReader` interface so the
discovery logic is unit-testable without a real Windows host. The default
implementation shells out to `reg.exe` via `child_process` (zero new npm
dependency). On non-Windows hosts the default reader returns an empty list
synchronously.

The wizard (`src/cli/database-setup.ts`) gets one new entry in its mode
picker when the driver is `postgresql`: "Discover PSQLODBC DSN". Existing
"manual connection" and "local database discovery" entries are not changed.

## Components

| File | Status | Responsibility |
|------|--------|----------------|
| `src/config/types.ts` | edit | Add `"postgresql"` to `DatabaseDriver`. |
| `src/db/source-adapter.ts` | edit | Add `"postgresql"` to `SourceDatabaseAdapterKind`. |
| `src/db/adapter-factory.ts` | edit | New `postgresConnectionFactory` dependency + `case "postgresql"`. |
| `src/db/postgresql-adapter.ts` | new | `PostgresSourceAdapter` implementing `SourceDatabaseAdapter`. Mirrors `mysql-adapter.ts`. |
| `src/db/dsn-discovery.ts` | new | `discoverPostgresDsns(reader): Promise<PostgresDsnCandidate[]>`. |
| `src/db/registry-reader.ts` | new | `RegistryReader` interface + default `reg.exe`-based implementation + non-Windows no-op. |
| `src/cli/database-setup.ts` | edit | Driver picker gains "PostgreSQL" entry; mode picker gains "Discover PSQLODBC DSN" when driver = postgresql; production wiring adds `postgresConnectionFactory` via `await import("pg")`. |
| `tests/db/postgresql-adapter.test.ts` | new | Adapter unit tests with injected fake. |
| `tests/db/dsn-discovery.test.ts` | new | Discovery unit tests with injected `RegistryReader`. |
| `tests/db/adapter-factory.test.ts` | edit | Add postgresql case. |
| `tests/cli/database-setup.test.ts` | edit/new | Driver picker, DSN discovery flow, empty-DSN fallback. |
| `docs/manual-system-tests.md` | edit | One-paragraph Postgres smoke test. |
| `package.json` | edit | `pg` and `@types/pg` added to `dependencies` (not optional). |

### `PostgresSourceAdapter` interface (mirror of MySQL)

```ts
interface PostgresConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  readonly: true;
}

interface PostgresDriverConnection {
  query(sql: string, params: readonly unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

type PostgresConnectionFactory =
  (config: PostgresConnectionConfig) => Promise<PostgresDriverConnection>;
```

Schema queries use `information_schema.tables` and
`information_schema.columns`, excluding `pg_catalog` and `information_schema`
themselves. Parameter placeholders are PostgreSQL-native (`$1`, `$2`); the
adapter is responsible for emitting them, exactly as `mysql-adapter` emits
`?`.

### `PostgresDsnCandidate` shape

```ts
interface PostgresDsnCandidate {
  dsnName: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
}
```

Password is never present in this type, even when the Registry exposes one.

## Data flow

### Onboarding flow (one-time, on the pharmacy host)

```
Operator runs `npm run database-setup`
   -> CLI driver picker  -> select "postgresql"
   -> CLI mode picker    -> "Discover PSQLODBC DSN"  OR  "Manual connection"
        (discovery branch)
            -> registry-reader lists HKLM/HKCU ODBC.INI
            -> dsn-discovery filters drivers containing "psqlodbc"
            -> CLI shows DSN list; operator selects one
            -> host/port/database/user pre-filled in next prompts
   -> Operator confirms / edits host/port/database/user and TYPES password
   -> PostgresSourceAdapter.connect() runs SELECT 1
   -> listTables() populates the table-selection prompt
   -> Artifact saved to ~/.pharma-agent/database-setup.json
      (existing format; `driver: "postgresql"`)
```

Invariants:

- Passwords are never read from the Registry, never written to the artifact.
- Empty DSN list -> CLI falls back to manual mode with a friendly notice.

### Runtime sync flow (identical to MySQL today)

```
service start -> connector-config.json -> driver = "postgresql"
   -> adapter-factory.createSourceDatabaseAdapter() -> PostgresSourceAdapter
   -> adapter.connect()   (pg Client connects TCP to host:port)
   -> poller runs at configured interval
        snapshot mode:    querySnapshotPage(sql, limit, offset)
        incremental mode: queryChanges(sql, cursor, limit)
   -> mapping/ normalizes rows into SourceRow (driver-agnostic)
   -> transport/ publishes via WebSocket to the central panel
```

The agent connects with whatever credentials the operator supplied. Read-only
intent is by convention (the adapter only issues `SELECT`); no DB-side
privilege enforcement is added.

## Error handling

### Postgres connection / query errors

`PostgresSourceAdapter.connect()` and `query()` route every thrown error
through the existing `src/db/errors.ts:normalizeDatabaseError(error, operation)`.
Mapping additions:

- `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND` -> `"connection"`
- SQLSTATE `28P01` (invalid_password), `28000` (invalid_authorization) -> `"authentication"`
- SQLSTATE `3D000` (invalid_catalog_name) -> `"connection"`
- SQLSTATE `42P01` (undefined_table), `42703` (undefined_column) -> `"schema"`

Behavior matches MySQL/Firebird: the typed error is logged at the existing
level and re-thrown; `transport/` decides retry / backoff.

### Registry / discovery errors

`discoverPostgresDsns()` never throws. Any underlying failure (`reg.exe`
missing, ACL denial, malformed Registry data) is caught, logged at `warn`
level with the cause, and the function returns `[]`. If the operator chose
the discovery branch and the list is empty, the CLI prints
"No PSQLODBC DSN found. Falling back to manual entry." and proceeds.

Discovery is a convenience; failing onboarding because of a flaky optional
hint is bad UX.

### Startup validation

`ConfigValidationIssue` already exists. The new rule: when
`driver === "postgresql"`, require non-empty `host`, `name`, `user`,
`password`, and `port` in `[1, 65535]`. Same form as MySQL/Firebird.
`CONNECTOR_VALIDATE_ONLY=1` continues to validate without touching the DB.

## Testing

Unit tests at parity with current MySQL/Firebird coverage. No live Postgres
or live Windows in CI; integration smoke testing is manual.

### `tests/db/postgresql-adapter.test.ts` (new)

- `connect()` success and failure paths.
- `close()` releases the underlying connection.
- `queryChanges` emits `$1 / $2` placeholders and the correct
  `WHERE cursorCol > $1 ORDER BY cursorCol LIMIT $2` SQL.
- `querySnapshotPage` emits `LIMIT $1 OFFSET $2`.
- `listTables` excludes `pg_catalog` and `information_schema`.
- `listColumns` returns columns for a given table.
- Error mapping: `ECONNREFUSED`, `28P01`, `3D000`, `42P01` each map to the
  correct `DatabaseErrorCode` via `normalizeDatabaseError`.
- Secrets (`[password, name]`) are passed through to `normalizeDatabaseError`.

### `tests/db/dsn-discovery.test.ts` (new)

- HKLM and HKCU both expose PSQLODBC DSNs: results unioned and deduped by
  name.
- A non-PSQLODBC DSN under the same hive is filtered out.
- `Servername`, `Port`, `Database`, `Username` are parsed; missing fields
  stay `undefined`.
- A DSN that exposes `Password` in the Registry: result MUST omit
  password (explicit assertion).
- `RegistryReader.listKeys` throws: discovery returns `[]`, error is
  swallowed.
- Default (non-Windows) reader returns `[]` without invoking `reg.exe`.

### `tests/db/adapter-factory.test.ts` (edit)

- `driver: "postgresql"` constructs `PostgresSourceAdapter` with the
  injected `postgresConnectionFactory`.
- Unknown drivers still throw `UnsupportedDatabaseDriverError` (regression).

### `tests/cli/database-setup.test.ts` (edit or new)

- Driver picker includes "PostgreSQL".
- Choosing `postgresql` + "Discover PSQLODBC DSN" calls
  `discoverPostgresDsns` (injected mock), shows the list, pre-fills the
  next prompts from the selected DSN.
- Empty DSN list -> CLI falls back to manual entry without crashing.
- Operator is always prompted for the password, even when the DSN supplied
  a user.

### Manual smoke (documented, not in CI)

One paragraph added to `docs/manual-system-tests.md`: start a local
Postgres (Docker / Podman); run `database-setup` with the new driver;
validate that the artifact contains `driver: "postgresql"`,
no password, and a valid table selection.

## YAGNI / non-goals (recap)

- No generic ODBC adapter.
- No connection pooling.
- No SSL/TLS options.
- No automatic schema resolution beyond Postgres's own `search_path`.
- No "VetorFarma preset" mapping.
- No refactor of `file-discovery.ts`.
- No DSN password extraction.
- No live Postgres or live Windows test in CI.

## Open questions deferred to implementation

- Exact `pg` minor version and whether to pin. Decision deferred to the
  implementation plan; default is "latest stable at the time of the PR".
- Whether to emit a structured log line when a DSN is selected (for
  observability when supporting customers). Likely yes; spelled out in the
  plan.
- The wording of CLI prompts and error messages (Portuguese vs English).
  The existing CLI already mixes both; the plan should standardize within
  the changed surface and match the surrounding text.
