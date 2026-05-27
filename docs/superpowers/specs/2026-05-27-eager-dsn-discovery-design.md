# Eager DSN discovery from the Windows Service

Date: 2026-05-27
Status: Approved (brainstorming) — pending implementation plan

## Background

The previous spec (`2026-05-26-vetorfarma-postgresql-design.md`) added PSQLODBC
DSN discovery to the interactive `database-setup` CLI. That covers initial
onboarding by an operator at the pharmacy host.

Real production operates differently: the agent runs as a Windows Service
permanently connected to the central panel via WebSocket. The CLI runs once,
or never (when the panel pushes config directly). The current discovery only
fires during that interactive session, so the panel has no visibility into
which DSNs are available on the remote host — and cannot suggest a
configuration to the admin.

Goal: make the Windows Service emit a DSN snapshot to the central panel
once per boot, so the panel can drive future configuration decisions
remotely without requiring the operator to be at the machine.

## Scope

In scope:

- The Windows Service runs `discoverPostgresDsns` once at boot, independent
  of the agent's database configuration state.
- A new agent → server WebSocket message `connector.discovery` carrying the
  snapshot.
- Tests at the same fidelity as existing transport/runtime tests (mocks for
  the WS client and the Registry reader).
- One paragraph in `docs/manual-system-tests.md` describing the manual
  smoke against a Windows host with PSQLODBC installed.

Out of scope (explicitly):

- Re-emitting the snapshot on WebSocket reconnect. Snapshot is per-boot.
- Periodic re-scanning during a long-running service session.
- A server-initiated `dsn:discover` command. Future spec if needed.
- Detecting non-PSQLODBC drivers (MyODBC, Firebird ODBC, SQL Server, etc.).
  Same filter as the CLI: `psqlodbc` substring in the driver path/description.
- Persisting the snapshot to disk on the agent host.
- Panel-side handling: rendering, storage, "configure with DSN" UX.
  Tracked as a separate spec when the panel team picks it up.
- Cancelling discovery during shutdown.

## Architecture

Two surgical additions, both reusing existing infrastructure:

### 1. Eager scan at service boot

The service entrypoint (`src/service/runtime.ts`) invokes
`discoverPostgresDsns(createRegExeRegistryReader())` once during startup,
**independent of `config.database`**. The agent already supports
`allowMissingDatabaseConfig: true` (set by `runServiceMain` in
`src/main.ts:129`), so discovery must run even when the agent boots without
a database configuration — that is the fresh-install scenario, which is the
most valuable case for this feature.

Discovery runs in parallel with the WebSocket connect. The runtime awaits
both. If discovery is still pending when the WS emits `connected`, the
runtime waits up to a hard cap (3 seconds total). After timeout, discovery
is treated as having returned `[]`.

### 2. New `connector.discovery` envelope

A new message type is added to the agent → server union in
`src/transport/protocol.ts`. Shape:

```ts
interface ConnectorDiscoveryMessage {
  type: "connector.discovery";
  scannedAt: string;     // ISO 8601
  platform: string;       // process.platform
  dsns: PostgresDsnCandidate[];
}
```

`PostgresDsnCandidate` is the existing type from
`src/db/dsn-discovery.ts` — it never contains a password.

The agent sends this message once, immediately after the first `connected`
event, before any `product.batch` or `connector.heartbeat`. The message is
fire-and-forget; the agent does not retry, does not buffer, does not
re-send on reconnect.

The CLI flow (`database-setup` interactive discovery) is unchanged. The
modules `dsn-discovery.ts` and `registry-reader.ts` are reused without
modification.

## Components

| File | Status | Responsibility |
|------|--------|----------------|
| `src/transport/protocol.ts` | edit | Add `ConnectorDiscoveryMessage` interface, serialization, and inclusion in the agent → server union. |
| `src/service/runtime.ts` | edit | Kick off discovery at startup; on first `connected` event, send `connector.discovery` envelope (with 3s timeout); never re-send. |
| `tests/transport/protocol.test.ts` | edit | Serialization round-trip; assert no password leaked. |
| `tests/service/runtime.test.ts` | edit | Discovery is called once at boot regardless of `database` config; envelope is sent on first `connected`; not re-sent on reconnect; timeout produces empty snapshot; `wsClient.send` failure is swallowed. |
| `docs/manual-system-tests.md` | edit | One paragraph for Windows smoke. |

Modules NOT touched:

- `src/db/dsn-discovery.ts` and `src/db/registry-reader.ts` — already do
  exactly what is needed; their contract is preserved.
- `src/cli/database-setup.ts` — CLI flow is unchanged.
- `src/db/postgresql-adapter.ts`, `src/db/adapter-factory.ts` — irrelevant
  here.

No new npm dependencies.

## Data flow

```
T+0    Windows Service process starts
T+5    runtime loads config (database may be missing — that's OK)
T+10   In parallel:
       ├── discoverPostgresDsns(createRegExeRegistryReader())  [Windows: ~1500ms]
       └── wsClient.connect(wsUrl, token)                       [~500ms]
T+500  WS emits `connected`
T+500  runtime awaits the discovery promise with a 3s hard cap
T+1500 Discovery resolves → snapshot envelope built
T+1505 wsClient.send({ type: "connector.discovery", scannedAt, platform, dsns })
T+1510 Normal flow continues (heartbeats, polling if config has database)
```

Alternative paths:

- **Linux/Mac**: `createRegExeRegistryReader` returns the non-Windows
  no-op reader. `discoverPostgresDsns` resolves to `[]` in ~5ms.
  Envelope is sent with `dsns: []` and `platform: "linux" | "darwin"`.
- **Windows without ODBC**: `reg.exe query` fails fast → `[]`. Envelope
  is sent empty.
- **Discovery exceeds the 3s cap**: runtime sends envelope with `dsns: []`,
  logs `warn` with message `"dsn discovery timeout — sending empty snapshot"`.
- **Service starts without database config**: identical to the path above.
  Discovery runs unchanged. The runtime simply does not create an adapter
  and does not poll, but the WS is still up and the envelope is still sent.
- **WS reconnects after disconnect**: snapshot is sent on the *first*
  `connected` only. Subsequent `connected` events do not re-emit. Justified:
  the snapshot is per-boot; the Registry rarely changes during a process
  lifetime; re-emitting on every reconnect adds noise without value.
- **`wsClient.send` throws on the first emit**: error is caught, warn logged,
  envelope is dropped. Not buffered for retry. The next service restart
  is the recovery path.

## Error handling

- `discoverPostgresDsns` already swallows all internal errors and returns
  `[]`. Contract preserved; no additional handling needed.
- Discovery exceeding the 3s cap: runtime wraps the promise in a
  `Promise.race` with a timer. After timeout, the pending promise is
  abandoned (not cancelled — Node will GC it). The runtime continues with
  `[]`.
- `wsClient.send` failure: wrapped in `try/catch`. Log `warn`. No retry,
  no buffering.
- Schema validation: the envelope is built locally by the runtime; the
  type is enforced by TypeScript via the `ConnectorDiscoveryMessage`
  interface and the existing `serializeConnectorMessage` helper. No
  runtime validation is added.

Explicitly NOT handled (YAGNI):

- Rate limiting / backpressure (one envelope per boot, kilobytes).
- Envelope versioning (additive changes only; schema changes get a new
  `type` if ever needed).
- Cancellation on shutdown (Node GC is sufficient).

## Testing

All tests use mocks. No real `reg.exe`, no real Postgres, no real WS.

### `tests/transport/protocol.test.ts`

- Serialization of a `ConnectorDiscoveryMessage` produces JSON with the
  correct shape: `type`, `scannedAt`, `platform`, `dsns` array.
- A `dsns` entry containing a fabricated password-like field MUST not
  leak in the serialized form (defense-in-depth — `PostgresDsnCandidate`
  has no `password` field, but the test belts-and-braces it).
- If a generic envelope parser exists, it accepts `connector.discovery`
  without throwing (forward compatibility).

### `tests/service/runtime.test.ts`

With `wsClient` and `registryReader` mocked:

- Service boot with full database config: `discoverPostgresDsns` is
  called once; on first `connected`, `wsClient.send` is called with an
  envelope matching `{ type: "connector.discovery", scannedAt, platform, dsns: [...] }`.
- Service boot with `allowMissingDatabaseConfig: true` and no database
  config: identical assertion — discovery runs and envelope is sent.
- Reader returns `[]`: envelope is still sent, `dsns: []`.
- Reader takes >3s: after the cap, envelope is sent with `dsns: []` and a
  `warn` log is recorded with `"dsn discovery timeout"` substring.
- `wsClient.send` throws on the first call: error is caught, runtime
  does not crash, a `warn` is logged.
- Reconnect: simulate `connected → disconnected → connected`. The new
  envelope is sent ONLY after the first `connected`. The second
  `connected` does NOT trigger another `connector.discovery` send.

### Manual smoke

Add one paragraph to `docs/manual-system-tests.md`:

> On a Windows host with PSQLODBC installed and at least one DSN configured,
> start `mock-panel serve`, then start the agent (`npm start`). Confirm
> the mock panel logs receipt of a `connector.discovery` envelope shortly
> after `connected`. Confirm the envelope contains the expected DSN(s)
> and no password field.

## Open questions deferred to implementation

- Exact placement of the discovery kickoff inside `runtime.ts` (right
  after `loadConfig` vs after transport construction). The plan picks
  the spot that yields the cleanest test seams.
- Whether to expose `discoverPostgresDsns` as an injectable dependency
  on `ConnectorRuntimeOptions`. Strongly preferred for testability;
  defaults to the production wiring with `createRegExeRegistryReader()`.
- Whether to track a `hasEmittedDiscoverySnapshot` flag on the runtime
  to prevent re-emit on reconnect. The plan locks in a flag-based
  approach for clarity.
