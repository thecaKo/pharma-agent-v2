# Eager DSN discovery from the Windows Service — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the Windows Service boots, run PSQLODBC DSN discovery once (independent of whether the database config is present) and publish a single `connector.discovery` envelope to the central panel over WebSocket, then never resend.

**Architecture:** A new agent → server message type added to `protocol.ts`. A new transport method `sendConnectorDiscovery`. The runtime kicks off discovery in parallel with `transport.connect()` during `start()`, and on the first `connected` event sends the snapshot (with a 3s hard cap), guarded by a flag so reconnects do not resend.

**Tech Stack:** TypeScript, Node 20+, vitest, no new npm deps. Reuses the existing `discoverPostgresDsns` / `createRegExeRegistryReader` modules built in the previous spec.

**Spec:** `docs/superpowers/specs/2026-05-27-eager-dsn-discovery-design.md`

---

## Conventions

- Commits are **subject-line only** (no body paragraph). Conventional-commit style (`feat(...): ...`, `test(...): ...`, `docs(...): ...`). Co-Author footer required.
- TDD: failing tests first, then implementation.
- `npm test` for the full suite; `npx vitest run tests/path -t "name"` for one test.
- `npm run build` must succeed after any task that touches types or exports.

---

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `src/transport/protocol.ts` | edit | Add `ConnectorDiscoveryMessage` interface; extend `ConnectorMessageType` and `ConnectorMessage` union; add `buildConnectorDiscoveryMessage` builder. |
| `src/transport/ws-client.ts` | edit | Add `sendConnectorDiscovery(message)` method that calls `this.send(message)`. |
| `src/service/runtime.ts` | edit | Extend `RuntimeTransport` interface with `sendConnectorDiscovery`; add `discoverDsns` option + private snapshot promise + `hasEmittedDiscoverySnapshot` flag; kick off in `start()`; emit on first `connected` with 3s cap. |
| `tests/transport/protocol.test.ts` | edit | Serialization + password-leak defense-in-depth test. |
| `tests/service/runtime.test.ts` | edit | 6 behavioral tests. |
| `docs/manual-system-tests.md` | edit | One paragraph: Windows smoke against mock-panel. |

No new files. No new dependencies.

---

## Task 1: Protocol envelope and builder

**Files:**
- Modify: `src/transport/protocol.ts`
- Modify: `tests/transport/protocol.test.ts`

- [ ] **Step 1: Add failing tests in `tests/transport/protocol.test.ts`**

Append (don't touch existing tests):

```ts
import { buildConnectorDiscoveryMessage, serializeConnectorMessage } from "../../src/transport/protocol.js";
import type { PostgresDsnCandidate } from "../../src/db/dsn-discovery.js";

describe("buildConnectorDiscoveryMessage", () => {
  it("builds a connector.discovery envelope with platform, scannedAt and dsns", () => {
    const dsns: PostgresDsnCandidate[] = [
      { dsnName: "VetorFarma", host: "127.0.0.1", port: 5432, database: "vf", user: "vfuser" }
    ];
    const message = buildConnectorDiscoveryMessage({
      platform: "win32",
      dsns,
      scannedAt: "2026-05-27T12:00:00.000Z"
    });
    expect(message).toEqual({
      type: "connector.discovery",
      platform: "win32",
      scannedAt: "2026-05-27T12:00:00.000Z",
      dsns: [
        { dsnName: "VetorFarma", host: "127.0.0.1", port: 5432, database: "vf", user: "vfuser" }
      ]
    });
  });

  it("defaults scannedAt to now when not provided", () => {
    const before = new Date().toISOString();
    const message = buildConnectorDiscoveryMessage({ platform: "linux", dsns: [] });
    const after = new Date().toISOString();
    expect(message.scannedAt >= before && message.scannedAt <= after).toBe(true);
  });

  it("serializes to JSON with no password field even when a rogue field would be present", () => {
    const dsns: PostgresDsnCandidate[] = [
      { dsnName: "Risky", host: "host", user: "u" }
    ];
    const message = buildConnectorDiscoveryMessage({ platform: "win32", dsns });
    const json = serializeConnectorMessage(message);
    expect(json).not.toContain("password");
    expect(json).not.toContain("Password");
    expect(JSON.parse(json)).toMatchObject({ type: "connector.discovery", dsns });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/transport/protocol.test.ts -t "buildConnectorDiscoveryMessage"`
Expected: FAIL — `buildConnectorDiscoveryMessage` not exported.

- [ ] **Step 3: Edit `src/transport/protocol.ts` to add the new envelope**

Add this import near the top of the file (after the existing imports):

```ts
import type { PostgresDsnCandidate } from "../db/dsn-discovery.js";
```

Modify the `ConnectorMessageType` declaration (line 8):

```ts
export type ConnectorMessageType = "connector.heartbeat" | "product.batch" | "connector.error" | "admin.response" | "connector.discovery";
```

Add the interface (place it near the other connector message interfaces, e.g. after `ConnectorErrorMessage`):

```ts
export interface ConnectorDiscoveryMessage {
  type: "connector.discovery";
  scannedAt: string;
  platform: string;
  dsns: PostgresDsnCandidate[];
}
```

Extend the `ConnectorMessage` union (around line 137):

```ts
export type ConnectorMessage =
  | ConnectorHeartbeatMessage
  | ProductBatchMessage
  | ConnectorErrorMessage
  | AdminResponseMessage
  | ConnectorDiscoveryMessage;
```

Add the builder function (place it next to other `build*Message` helpers, e.g. after `buildProductBatchMessage`):

```ts
export function buildConnectorDiscoveryMessage(
  input: {
    platform: string;
    dsns: PostgresDsnCandidate[];
    scannedAt?: string;
  }
): ConnectorDiscoveryMessage {
  return {
    type: "connector.discovery",
    scannedAt: input.scannedAt ?? new Date().toISOString(),
    platform: input.platform,
    dsns: input.dsns
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/transport/protocol.test.ts`
Expected: PASS (existing tests + 3 new tests).

Run: `npm run build`
Expected: PASS (no type errors).

- [ ] **Step 5: Commit**

```bash
cd /home/cako/Documents/projetos/pharmachatbot/pharma-agent-v2
git add src/transport/protocol.ts tests/transport/protocol.test.ts
git commit -m "$(cat <<'EOF'
feat(transport): adiciona envelope connector.discovery e builder

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Transport `sendConnectorDiscovery` method

**Files:**
- Modify: `src/transport/ws-client.ts`
- Modify: `tests/transport/ws-client.test.ts` (only if file exists; if not, skip the test step and rely on the runtime tests in Task 4)

- [ ] **Step 1: Confirm whether `tests/transport/ws-client.test.ts` exists**

Run: `ls /home/cako/Documents/projetos/pharmachatbot/pharma-agent-v2/tests/transport/ws-client.test.ts`

If the file exists, proceed with Step 2. If not, skip directly to Step 4 (the test coverage in Task 4 exercises this method via mocking the transport).

- [ ] **Step 2 (conditional): Add a failing test**

In `tests/transport/ws-client.test.ts`, locate the existing describe block for `WebSocketTransportClient` and append:

```ts
  it("sendConnectorDiscovery serializes and sends the envelope", () => {
    // Use the existing harness/fake socket pattern from this file.
    // The exact wiring depends on how the file already builds test instances —
    // mimic an existing test (e.g. one that calls sendHeartbeat).
    const { client, sentMessages } = buildConnectedClient(); // existing helper if present
    client.sendConnectorDiscovery({
      type: "connector.discovery",
      scannedAt: "2026-05-27T12:00:00.000Z",
      platform: "win32",
      dsns: [{ dsnName: "X", host: "h", port: 5432 }]
    });
    expect(sentMessages).toContain(
      JSON.stringify({
        type: "connector.discovery",
        scannedAt: "2026-05-27T12:00:00.000Z",
        platform: "win32",
        dsns: [{ dsnName: "X", host: "h", port: 5432 }]
      })
    );
  });
```

If `buildConnectedClient` (or analogous test harness) does not exist, copy the pattern from any existing test in the file that calls `client.sendHeartbeat(...)` or `client.sendBatch(...)` and adapt.

Run: `npx vitest run tests/transport/ws-client.test.ts -t "sendConnectorDiscovery"`
Expected: FAIL — method does not exist.

- [ ] **Step 3 (conditional): Implement the method**

In `src/transport/ws-client.ts`, after the existing `sendConnectorSetupConfigResult` (around line 274), add:

```ts
  public sendConnectorDiscovery(message: ConnectorDiscoveryMessage): void {
    this.send(message);
  }
```

Update the imports at the top of `ws-client.ts` to include `ConnectorDiscoveryMessage`:

```ts
import type { ConnectorDiscoveryMessage } from "./protocol.js";
```

(If `protocol.ts` types are already imported via a type-only import, add the new name to that existing list rather than creating a duplicate import.)

Run: `npx vitest run tests/transport/ws-client.test.ts -t "sendConnectorDiscovery"`
Expected: PASS.

- [ ] **Step 4: If no test file existed in Step 1, still implement the method**

Apply the same edit to `src/transport/ws-client.ts` as Step 3. The method's behavior will be verified indirectly by the runtime tests in Task 4.

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/cako/Documents/projetos/pharmachatbot/pharma-agent-v2
# Include the test file in the add only if it was modified
git add src/transport/ws-client.ts tests/transport/ws-client.test.ts 2>/dev/null || git add src/transport/ws-client.ts
git commit -m "$(cat <<'EOF'
feat(transport): adiciona sendConnectorDiscovery no ws-client

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Extend `RuntimeTransport` interface

**Files:**
- Modify: `src/service/runtime.ts`

- [ ] **Step 1: Update the `RuntimeTransport` interface**

In `src/service/runtime.ts`, locate the `RuntimeTransport` interface (around line 53). Add a method declaration after `sendConnectorSetupConfigResult`:

```ts
  sendConnectorDiscovery(message: ConnectorDiscoveryMessage): void;
```

Update the imports at the top of `runtime.ts` to include `ConnectorDiscoveryMessage`:

Find the existing `import type` from `../transport/protocol.js` and add `ConnectorDiscoveryMessage` to its list.

- [ ] **Step 2: Verify the build still passes**

Run: `npm run build`
Expected: PASS. `WebSocketTransportClient` already gained `sendConnectorDiscovery` in Task 2, so it still satisfies the interface.

Run: `npm test`
Expected: PASS — no behavior change yet.

- [ ] **Step 3: Commit**

```bash
cd /home/cako/Documents/projetos/pharmachatbot/pharma-agent-v2
git add src/service/runtime.ts
git commit -m "$(cat <<'EOF'
feat(runtime): expande RuntimeTransport com sendConnectorDiscovery

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Runtime kicks off discovery and emits envelope on first `connected`

**Files:**
- Modify: `src/service/runtime.ts`
- Modify: `tests/service/runtime.test.ts`

**Design notes for the implementer:**

- Add a new optional DI: `discoverDsns?: () => Promise<PostgresDsnCandidate[]>`. Production default: `() => discoverPostgresDsns(createRegExeRegistryReader())`.
- Add another optional DI: `discoveryTimeoutMs?: number`. Production default: `3000`. Tests pass small values for fast assertions.
- Store the started discovery promise as `private discoverySnapshotPromise?: Promise<PostgresDsnCandidate[]>`.
- Store the emit-once flag as `private hasEmittedDiscoverySnapshot = false`.
- In `start()`, kick off the discovery promise BEFORE `this.transport.connect()`:
  ```ts
  this.discoverySnapshotPromise = this.discoverDsnsFn();
  await this.transport.connect();
  ```
- On the `connected` event listener (line 289), call a new private async method `emitDiscoverySnapshotOnce()` BEFORE `this.sendHeartbeat()`. The method:
  1. If `hasEmittedDiscoverySnapshot` → return.
  2. Set the flag to true.
  3. Race `this.discoverySnapshotPromise` against `setTimeout(this.discoveryTimeoutMs)`.
  4. If timed out, log `warn` with `"dsn discovery timeout — sending empty snapshot"` and use `[]`.
  5. If the promise rejected, log `warn` and use `[]`.
  6. Build the envelope with `buildConnectorDiscoveryMessage({ platform: process.platform, dsns })`.
  7. Try `this.transport.sendConnectorDiscovery(envelope)`; if it throws, log `warn` and swallow.

- [ ] **Step 1: Add failing tests in `tests/service/runtime.test.ts`**

Append to the file (don't disturb existing tests). Many existing tests already construct a `ConnectorRuntime` with mocked transport — mimic that pattern. Below is the shape of the new tests; adapt the harness/mocks to whatever helpers already exist (`createFakeTransport()`, `createTestRuntime()`, etc.).

```ts
describe("ConnectorRuntime — DSN discovery snapshot on boot", () => {
  function makeFakeTransport() {
    const listeners: Record<string, ((arg?: unknown) => void)[]> = {};
    const sent: unknown[] = [];
    return {
      sent,
      emit(event: string, arg?: unknown) {
        (listeners[event] ?? []).forEach((cb) => cb(arg));
      },
      on(event: string, cb: (arg?: unknown) => void) {
        (listeners[event] ??= []).push(cb);
        return this;
      },
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      isConnected: () => true,
      sendBatch: vi.fn(),
      sendHeartbeat: vi.fn(),
      sendConnectorError: vi.fn(),
      sendAdminResponse: vi.fn(),
      sendSchemaTablesListResult: vi.fn(),
      sendFileDiscoveryScanResult: vi.fn(),
      sendConnectorSetupConfigResult: vi.fn(),
      sendConnectorDiscovery: vi.fn((message) => { sent.push(message); }),
      getReconnectAttemptCount: () => 0
    };
  }

  const baseEnv = {
    CONNECTOR_TOKEN: "tok",
    CONNECTOR_WS_URL: "wss://test/ws",
    DB_DRIVER: "postgresql",
    DB_HOST: "127.0.0.1",
    DB_PORT: "5432",
    DB_NAME: "vf",
    DB_USER: "u",
    DB_PASSWORD: "p",
    LOG_LEVEL: "info"
  } as NodeJS.ProcessEnv;

  it("emits connector.discovery on first connected with the discovery result", async () => {
    const transport = makeFakeTransport();
    const discoverDsns = vi.fn(async () => [
      { dsnName: "VetorFarma", host: "127.0.0.1", port: 5432, database: "vf", user: "vfuser" }
    ]);
    const runtime = new ConnectorRuntime({
      env: baseEnv,
      transport: transport as unknown as RuntimeTransport,
      discoverDsns,
      discoveryTimeoutMs: 1000
    });

    await runtime.start();
    transport.emit("connected");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(transport.sendConnectorDiscovery).toHaveBeenCalledOnce();
    const sent = transport.sendConnectorDiscovery.mock.calls[0][0];
    expect(sent).toMatchObject({
      type: "connector.discovery",
      platform: process.platform,
      dsns: [{ dsnName: "VetorFarma", host: "127.0.0.1", port: 5432, database: "vf", user: "vfuser" }]
    });
    expect(typeof sent.scannedAt).toBe("string");

    await runtime.shutdown();
  });

  it("emits with empty dsns when discovery returns []", async () => {
    const transport = makeFakeTransport();
    const runtime = new ConnectorRuntime({
      env: baseEnv,
      transport: transport as unknown as RuntimeTransport,
      discoverDsns: async () => [],
      discoveryTimeoutMs: 1000
    });
    await runtime.start();
    transport.emit("connected");
    await new Promise((resolve) => setImmediate(resolve));

    expect(transport.sendConnectorDiscovery).toHaveBeenCalledOnce();
    expect(transport.sendConnectorDiscovery.mock.calls[0][0].dsns).toEqual([]);

    await runtime.shutdown();
  });

  it("emits envelope even when database config is missing", async () => {
    const transport = makeFakeTransport();
    const envWithoutDb = {
      CONNECTOR_TOKEN: "tok",
      CONNECTOR_WS_URL: "wss://test/ws",
      LOG_LEVEL: "info"
    } as NodeJS.ProcessEnv;
    const runtime = new ConnectorRuntime({
      env: envWithoutDb,
      allowMissingDatabaseConfig: true,
      transport: transport as unknown as RuntimeTransport,
      discoverDsns: async () => [{ dsnName: "X", host: "h" }],
      discoveryTimeoutMs: 1000
    });
    await runtime.start();
    transport.emit("connected");
    await new Promise((resolve) => setImmediate(resolve));

    expect(transport.sendConnectorDiscovery).toHaveBeenCalledOnce();
    await runtime.shutdown();
  });

  it("falls back to empty dsns when discovery times out", async () => {
    const transport = makeFakeTransport();
    const runtime = new ConnectorRuntime({
      env: baseEnv,
      transport: transport as unknown as RuntimeTransport,
      discoverDsns: () => new Promise(() => {}), // never resolves
      discoveryTimeoutMs: 20
    });
    await runtime.start();
    transport.emit("connected");
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(transport.sendConnectorDiscovery).toHaveBeenCalledOnce();
    expect(transport.sendConnectorDiscovery.mock.calls[0][0].dsns).toEqual([]);

    await runtime.shutdown();
  });

  it("swallows errors from transport.sendConnectorDiscovery", async () => {
    const transport = makeFakeTransport();
    transport.sendConnectorDiscovery = vi.fn(() => {
      throw new Error("WebSocket is not connected");
    });
    const runtime = new ConnectorRuntime({
      env: baseEnv,
      transport: transport as unknown as RuntimeTransport,
      discoverDsns: async () => [],
      discoveryTimeoutMs: 1000
    });
    await runtime.start();
    expect(() => transport.emit("connected")).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    await runtime.shutdown();
  });

  it("does not re-emit on a second connected event (reconnect)", async () => {
    const transport = makeFakeTransport();
    const runtime = new ConnectorRuntime({
      env: baseEnv,
      transport: transport as unknown as RuntimeTransport,
      discoverDsns: async () => [{ dsnName: "X", host: "h" }],
      discoveryTimeoutMs: 1000
    });
    await runtime.start();
    transport.emit("connected");
    await new Promise((resolve) => setImmediate(resolve));
    transport.emit("disconnected");
    transport.emit("connected");
    await new Promise((resolve) => setImmediate(resolve));

    expect(transport.sendConnectorDiscovery).toHaveBeenCalledOnce();
    await runtime.shutdown();
  });
});
```

Make sure the imports at the top of the file include `ConnectorRuntime`, `type RuntimeTransport`, and `vi` from vitest (most likely already present).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/service/runtime.test.ts -t "DSN discovery snapshot on boot"`
Expected: FAIL — runtime does not accept `discoverDsns`/`discoveryTimeoutMs` and does not call `sendConnectorDiscovery`.

- [ ] **Step 3: Edit `ConnectorRuntimeOptions` to accept the new DI**

In `src/service/runtime.ts`, find `ConnectorRuntimeOptions` (around line 91). Add two optional fields:

```ts
  discoverDsns?: () => Promise<PostgresDsnCandidate[]>;
  discoveryTimeoutMs?: number;
```

Add imports at the top of the file:

```ts
import { discoverPostgresDsns, type PostgresDsnCandidate } from "../db/dsn-discovery.js";
import { createRegExeRegistryReader } from "../db/registry-reader.js";
import { buildConnectorDiscoveryMessage } from "../transport/protocol.js";
```

(Adjust placement next to other related imports; the existing `import type` from `../transport/protocol.js` should be extended to also include `ConnectorDiscoveryMessage` if it isn't already, and a separate value import for `buildConnectorDiscoveryMessage` should be added.)

- [ ] **Step 4: Add private fields and wire the discovery DI in the constructor**

In the `ConnectorRuntime` class body (near the existing private field declarations, around line 132–157), add:

```ts
  private readonly discoverDsnsFn: () => Promise<PostgresDsnCandidate[]>;
  private readonly discoveryTimeoutMs: number;
  private discoverySnapshotPromise?: Promise<PostgresDsnCandidate[]>;
  private hasEmittedDiscoverySnapshot = false;
```

In the constructor (the body that already assigns `this.env`, `this.config`, etc.), add after `this.now = ...` and BEFORE `this.bindTransportEvents()`:

```ts
    this.discoverDsnsFn =
      options.discoverDsns ?? (() => discoverPostgresDsns(createRegExeRegistryReader()));
    this.discoveryTimeoutMs = options.discoveryTimeoutMs ?? 3000;
```

- [ ] **Step 5: Kick off discovery at the very start of `start()`**

In the existing `start()` method (line 201), insert this line as the FIRST executable statement (before `this.stopped = false;`):

```ts
    this.discoverySnapshotPromise = this.discoverDsnsFn().catch((error) => {
      this.logger.warn("dsn.discovery_failed", {
        message: error instanceof Error ? error.message : String(error)
      });
      return [];
    });
```

- [ ] **Step 6: Update the `connected` listener in `bindTransportEvents`**

In `bindTransportEvents()` (around line 289), find:

```ts
    this.transport.on("connected", () => {
      this.logger.info("websocket.connected", {
        reconnectAttemptCount: this.transport.getReconnectAttemptCount()
      });
      this.sendHeartbeat();
      this.startHeartbeatLoop();
    });
```

Replace with:

```ts
    this.transport.on("connected", () => {
      this.logger.info("websocket.connected", {
        reconnectAttemptCount: this.transport.getReconnectAttemptCount()
      });
      this.emitDiscoverySnapshotOnce().catch((error) => {
        this.logger.warn("dsn.discovery_emit_failed", {
          message: error instanceof Error ? error.message : String(error)
        });
      });
      this.sendHeartbeat();
      this.startHeartbeatLoop();
    });
```

- [ ] **Step 7: Implement `emitDiscoverySnapshotOnce` as a private method**

Add this private method to the `ConnectorRuntime` class (place it next to `sendHeartbeat`, around line 837):

```ts
  private async emitDiscoverySnapshotOnce(): Promise<void> {
    if (this.hasEmittedDiscoverySnapshot) {
      return;
    }
    this.hasEmittedDiscoverySnapshot = true;

    const promise = this.discoverySnapshotPromise ?? Promise.resolve<PostgresDsnCandidate[]>([]);
    let dsns: PostgresDsnCandidate[] = [];

    const timeoutPromise = new Promise<"__timeout__">((resolve) => {
      this.timers.setTimeout(() => resolve("__timeout__"), this.discoveryTimeoutMs);
    });
    const winner = await Promise.race([promise, timeoutPromise]);
    if (winner === "__timeout__") {
      this.logger.warn("dsn.discovery_timeout", {
        message: "dsn discovery timeout — sending empty snapshot",
        timeoutMs: this.discoveryTimeoutMs
      });
      dsns = [];
    } else {
      dsns = winner;
    }

    const envelope = buildConnectorDiscoveryMessage({
      platform: process.platform,
      dsns
    });

    try {
      this.transport.sendConnectorDiscovery(envelope);
    } catch (error) {
      this.logger.warn("dsn.discovery_send_failed", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
```

- [ ] **Step 8: Run the new tests to verify they pass**

Run: `npx vitest run tests/service/runtime.test.ts -t "DSN discovery snapshot on boot"`
Expected: PASS for all 6 new tests.

Run: `npm test`
Expected: full suite still green.

Run: `npm run build`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
cd /home/cako/Documents/projetos/pharmachatbot/pharma-agent-v2
git add src/service/runtime.ts tests/service/runtime.test.ts
git commit -m "$(cat <<'EOF'
feat(runtime): publica snapshot connector.discovery no primeiro connected

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Manual smoke test note

**Files:**
- Modify: `docs/manual-system-tests.md`

- [ ] **Step 1: Append a section at the end of `docs/manual-system-tests.md`**

```markdown

## `connector.discovery` envelope on Windows

Pré-requisito: máquina Windows com PSQLODBC instalado e pelo menos um DSN configurado em `HKLM\Software\ODBC\ODBC.INI`.

1. Em uma shell separada, suba o painel mock: `npm run mock-panel -- serve`.
2. Configure o agente apontando para essa URL (variáveis `CONNECTOR_WS_URL` e `CONNECTOR_TOKEN`).
3. Inicie o serviço: `npm start`.
4. Confirme no log do `mock-panel` que um envelope `connector.discovery` é recebido logo após `connected`, contendo:
   - `platform: "win32"`
   - `dsns: [...]` com pelo menos uma entrada do DSN PSQLODBC instalado
   - **Nenhum** campo de senha em qualquer entrada.
5. Reconecte (desligue/religue rede) e confirme que o envelope **NÃO** é reemitido após o segundo `connected`.
6. Reinicie o serviço e confirme que um novo envelope é emitido (snapshot por boot).

Em Linux/macOS o envelope é emitido com `dsns: []` e `platform` correspondente — útil para validar o caminho não-Windows sem alterar nada.
```

- [ ] **Step 2: Commit**

```bash
cd /home/cako/Documents/projetos/pharmachatbot/pharma-agent-v2
git add docs/manual-system-tests.md
git commit -m "$(cat <<'EOF'
docs: smoke manual para envelope connector.discovery no servico

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Final verification

**Files:** none.

- [ ] **Step 1: Run the full suite with coverage**

Run: `npm run coverage`
Expected: PASS, coverage thresholds met (project aggregate 80% on branches/functions/lines/statements).

- [ ] **Step 2: Build the dist**

Run: `npm run build`
Expected: PASS, zero TypeScript errors.

- [ ] **Step 3: Sanity grep — no real Registry / no real WS in tests**

Run: `grep -RIn "createRegExeRegistryReader" tests/`
Expected: matches in `tests/db/registry-reader.test.ts` (already injected with `platform` and `exec`) and nowhere else.

Run: `grep -RIn "discoverPostgresDsns\\b" tests/`
Expected: matches only in `tests/db/dsn-discovery.test.ts` with mocked readers; runtime tests pass their own `discoverDsns` mocks, not the real function.

- [ ] **Step 4: Sanity grep — `connector.discovery` is emitted from exactly one site**

Run: `grep -RIn "connector\.discovery" src/`
Expected: matches in `src/transport/protocol.ts` (type + builder), `src/transport/ws-client.ts` (the new `sendConnectorDiscovery`), and `src/service/runtime.ts` (the `buildConnectorDiscoveryMessage` call site). No other source files.

- [ ] **Step 5: Final report (no commit)**

Report final coverage numbers, build result, and any sanity-grep deviations. No commit is required if nothing surfaced.
