# Fase 3 — Bootstrap Mode + Transição Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que o service rode em **bootstrap mode** sem `DatabaseConfig` válido (já parcialmente suportado via `allowMissingDatabaseConfig`), reporte estado `bootstrap` no heartbeat, aceite envelope novo `connector.bootstrap.dbConfig` do painel para receber credenciais do banco, persista em ProgramData e transicione para modo `synced` sem reiniciar o processo.

**Architecture:** `HeartbeatPayload` ganha `state: "bootstrap" | "synced"` + `bootstrap?: { probesRunTotal, lastProbeAt?, lastProbeError? }`. Novo envelope `connector.bootstrap.dbConfig` (server→agent) carregando `DatabaseConfig`. `runtime.ts` ganha método `applyBootstrapDbConfig(config)` que valida, persiste no `programdata-config.ts`, cria adapter via `createSourceDatabaseAdapter`, registra `probesRunTotal` counter compartilhado com o admin-router, e roda `resumeSavedMappingIfAvailable()` caso já exista mapping salvo. `connector.discovery` snapshot inclui `mode: "bootstrap" | "synced"`.

**Tech Stack:** TypeScript (ESM), vitest. Sem deps novas.

**Spec:** `docs/superpowers/specs/2026-05-27-discovery-multi-erp-design.md` (Seção "Bootstrap mode").

**Depende de:** Fase 2 (probes/admin-router) — o counter `probesRunTotal` é alimentado pelo admin-router.

---

## File Structure

**Novos arquivos:**
- `src/service/bootstrap-state.ts` — counter `probesRunTotal`, `lastProbeAt`, `lastProbeError` (estrutura compartilhada entre admin-router e heartbeat)
- `tests/service/bootstrap-state.test.ts`

**Modificados:**
- `src/transport/protocol.ts` — adiciona `ServerMessageType "connector.bootstrap.dbConfig"`, `BootstrapDbConfigMessage`, parser, builder; estende `HeartbeatPayload` com `state` e `bootstrap?`; estende `buildConnectorDiscoveryMessage` com `mode`
- `src/transport/server-message-router.ts` — roteia `connector.bootstrap.dbConfig` para o handler do runtime
- `src/config/programdata-config.ts` — adiciona `writeDatabaseConfig(config)` que persiste DB credentials no arquivo já existente
- `src/service/runtime.ts` — `applyBootstrapDbConfig`, transição bootstrap→synced sem restart, heartbeat carregando state+bootstrap, `connector.discovery` com mode, integração do `bootstrap-state` no admin-router-deps
- `tests/transport/protocol.test.ts` — casos para o novo envelope, novos campos de heartbeat e discovery
- `tests/service/runtime.test.ts` (ou equivalente) — caso de bootstrap recebendo dbConfig e transicionando

**Não muda:** loadConfig signature (já aceita `requireDatabase: false`), main.ts (já passa `allowMissingDatabaseConfig: true`).

---

## Task 1: `bootstrap-state.ts` (counter compartilhado)

**Files:**
- Create: `src/service/bootstrap-state.ts`
- Create: `tests/service/bootstrap-state.test.ts`

- [ ] **Step 1.1: Escrever testes**

Create `tests/service/bootstrap-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BootstrapState } from "../../src/service/bootstrap-state.js";

describe("BootstrapState", () => {
  it("starts with zero probes", () => {
    const state = new BootstrapState();
    expect(state.snapshot()).toEqual({ probesRunTotal: 0 });
  });

  it("increments probesRunTotal and records lastProbeAt on success", () => {
    const state = new BootstrapState(() => "2026-05-27T10:00:00.000Z");
    state.recordProbeSuccess("probe.engines");
    expect(state.snapshot()).toEqual({
      probesRunTotal: 1,
      lastProbeAt: "2026-05-27T10:00:00.000Z"
    });
  });

  it("records lastProbeError on failure", () => {
    const state = new BootstrapState(() => "2026-05-27T10:00:00.000Z");
    state.recordProbeError("probe.test_connection", "auth");
    expect(state.snapshot()).toEqual({
      probesRunTotal: 1,
      lastProbeAt: "2026-05-27T10:00:00.000Z",
      lastProbeError: { command: "probe.test_connection", code: "auth" }
    });
  });

  it("clears lastProbeError after a subsequent successful probe", () => {
    const state = new BootstrapState(() => "now");
    state.recordProbeError("probe.engines", "unknown");
    state.recordProbeSuccess("probe.engines");
    expect(state.snapshot().lastProbeError).toBeUndefined();
    expect(state.snapshot().probesRunTotal).toBe(2);
  });
});
```

- [ ] **Step 1.2: Criar `src/service/bootstrap-state.ts`**

Create `src/service/bootstrap-state.ts`:

```ts
export interface BootstrapStateSnapshot {
  probesRunTotal: number;
  lastProbeAt?: string;
  lastProbeError?: { command: string; code: string };
}

export class BootstrapState {
  private probesRunTotal = 0;
  private lastProbeAt?: string;
  private lastProbeError?: { command: string; code: string };
  private readonly now: () => string;

  public constructor(now: () => string = () => new Date().toISOString()) {
    this.now = now;
  }

  public recordProbeSuccess(command: string): void {
    this.probesRunTotal += 1;
    this.lastProbeAt = this.now();
    this.lastProbeError = undefined;
    void command;
  }

  public recordProbeError(command: string, code: string): void {
    this.probesRunTotal += 1;
    this.lastProbeAt = this.now();
    this.lastProbeError = { command, code };
  }

  public snapshot(): BootstrapStateSnapshot {
    const out: BootstrapStateSnapshot = { probesRunTotal: this.probesRunTotal };
    if (this.lastProbeAt) out.lastProbeAt = this.lastProbeAt;
    if (this.lastProbeError) out.lastProbeError = { ...this.lastProbeError };
    return out;
  }
}
```

- [ ] **Step 1.3: Rodar — devem passar**

Run: `npx vitest run tests/service/bootstrap-state.test.ts`
Expected: PASS.

- [ ] **Step 1.4: Commit**

```bash
git add src/service/bootstrap-state.ts tests/service/bootstrap-state.test.ts
git commit -m "feat(service): BootstrapState rastreia probes para heartbeat"
```

---

## Task 2: Estender `HeartbeatPayload` com `state` e `bootstrap`

**Files:**
- Modify: `src/transport/protocol.ts:48-55,253-266`

- [ ] **Step 2.1: Estender `HeartbeatPayload`**

Modify `src/transport/protocol.ts:48-55`:

```ts
export interface HeartbeatPayload {
  connectorVersion: string;
  online: boolean;
  mappingVersion?: string;
  lastSuccessfulSendAt?: string;
  lastErrorCode?: string;
  reconnectAttemptCount: number;
  state: "bootstrap" | "synced";
  bootstrap?: {
    probesRunTotal: number;
    lastProbeAt?: string;
    lastProbeError?: { command: string; code: string };
  };
}
```

- [ ] **Step 2.2: Estender `ConnectorDiscoveryMessage` com `mode`**

Modify `ConnectorDiscoveryMessage` (linhas 110-115):

```ts
export interface ConnectorDiscoveryMessage {
  type: "connector.discovery";
  scannedAt: string;
  platform: string;
  mode: "bootstrap" | "synced";
  dsns: PostgresDsnCandidate[];
}
```

Modify `buildConnectorDiscoveryMessage` (linhas 253-266):

```ts
export function buildConnectorDiscoveryMessage(
  input: {
    platform: string;
    dsns: PostgresDsnCandidate[];
    mode: "bootstrap" | "synced";
    scannedAt?: string;
  }
): ConnectorDiscoveryMessage {
  return {
    type: "connector.discovery",
    scannedAt: input.scannedAt ?? new Date().toISOString(),
    platform: input.platform,
    mode: input.mode,
    dsns: input.dsns
  };
}
```

- [ ] **Step 2.3: Verificar build TS**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: erros nos callsites de `buildConnectorDiscoveryMessage` (faltando `mode`) e em qualquer lugar que monta `HeartbeatPayload`.

- [ ] **Step 2.4: Atualizar callsites em `runtime.ts`**

Run: `grep -n "buildConnectorDiscoveryMessage\|connectorVersion: CONNECTOR_VERSION\|online:" src/service/runtime.ts`

Em cada callsite de `buildConnectorDiscoveryMessage`, adicionar `mode: this.runtimeStateName()` (a função vai existir na Task 4 — por ora hardcode `mode: this.config.database ? "synced" : "bootstrap"`).

Em cada lugar que monta `HeartbeatPayload`, adicionar:

```ts
state: this.config.database ? "synced" : "bootstrap",
...(this.config.database ? {} : { bootstrap: this.bootstrapState.snapshot() })
```

(O `this.bootstrapState` será introduzido na Task 4.)

- [ ] **Step 2.5: Rodar suite — pode haver falhas em testes que validam shape de heartbeat/discovery**

Run: `npm test`
Expected: falhas previsíveis em testes de protocol e runtime. Atualizar esses testes para incluir `state: "synced"` (caso default) ou `mode: "synced"` quando a config tem DB.

- [ ] **Step 2.6: Commit (incremental — somente protocol changes)**

```bash
git add src/transport/protocol.ts
git commit -m "feat(protocol): heartbeat carrega state e bootstrap; discovery carrega mode"
```

---

## Task 3: Envelope `connector.bootstrap.dbConfig`

**Files:**
- Modify: `src/transport/protocol.ts`
- Modify: `src/transport/server-message-router.ts`

- [ ] **Step 3.1: Escrever testes**

Adicione em `tests/transport/protocol.test.ts`:

```ts
describe("connector.bootstrap.dbConfig", () => {
  it("parses a valid bootstrap db config message", () => {
    const raw = JSON.stringify({
      type: "connector.bootstrap.dbConfig",
      requestId: "boot-1",
      database: {
        driver: "sqlserver",
        host: "10.0.0.1",
        port: 1433,
        name: "BIG",
        user: "ro",
        password: "p"
      }
    });
    const msg = parseServerMessage(raw);
    expect(msg).toMatchObject({
      type: "connector.bootstrap.dbConfig",
      requestId: "boot-1",
      database: { driver: "sqlserver", host: "10.0.0.1", port: 1433 }
    });
  });

  it("accepts sqlserver instance instead of port", () => {
    const raw = JSON.stringify({
      type: "connector.bootstrap.dbConfig",
      requestId: "boot-2",
      database: {
        driver: "sqlserver",
        host: "10.0.0.1",
        instance: "SQLEXPRESS",
        name: "BIG",
        user: "ro",
        password: "p"
      }
    });
    const msg = parseServerMessage(raw);
    expect(msg).toMatchObject({ database: { instance: "SQLEXPRESS" } });
  });

  it("rejects when driver is missing", () => {
    const raw = JSON.stringify({
      type: "connector.bootstrap.dbConfig",
      requestId: "boot-3",
      database: { host: "h", port: 1, name: "n", user: "u", password: "p" }
    });
    expect(() => parseServerMessage(raw)).toThrow(/driver/);
  });
});
```

- [ ] **Step 3.2: Estender `ServerMessageType` e adicionar interface + parser**

Modify `src/transport/protocol.ts:8`:

```ts
export type ServerMessageType =
  | "connector.config"
  | "batch.ack"
  | "config.updated"
  | "admin.request"
  | "connector.bootstrap.dbConfig";
```

Adicionar interface próximo às outras `ServerMessage`s:

```ts
export interface BootstrapDbConfigMessage {
  type: "connector.bootstrap.dbConfig";
  requestId: string;
  database: {
    driver: DatabaseDriver;
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
    instance?: string;
    trustServerCertificate?: boolean;
  };
  sentAt?: string;
}
```

Adicionar import de `DatabaseDriver` no topo se não existir:

```ts
import type { DatabaseDriver } from "../config/types.js";
```

Estender o union `ServerMessage`:

```ts
export type ServerMessage =
  | ConnectorConfigMessage
  | BatchAckMessage
  | ConfigUpdatedMessage
  | AdminRequestMessage
  | BootstrapDbConfigMessage;
```

Adicionar case no switch de `parseServerMessage` (linha ~164):

```ts
    case "connector.bootstrap.dbConfig":
      return parseBootstrapDbConfig(message);
```

E a função de parse:

```ts
function parseBootstrapDbConfig(message: Record<string, unknown>): BootstrapDbConfigMessage {
  const database = expectRecord(message.database, "database");
  const driver = expectString(database.driver, "database.driver");
  if (!["mysql", "firebird", "postgresql", "mariadb", "sqlserver"].includes(driver)) {
    throw new ProtocolParseError(`database.driver must be a supported driver, got ${driver}`);
  }
  const hasInstance = typeof database.instance === "string" && database.instance.length > 0;
  const port = hasInstance && driver === "sqlserver" ? 0 : expectPositiveInteger(database.port, "database.port");

  const out: BootstrapDbConfigMessage = {
    type: "connector.bootstrap.dbConfig",
    requestId: validateRequestId(expectString(message.requestId, "requestId")),
    database: {
      driver: driver as DatabaseDriver,
      host: expectString(database.host, "database.host"),
      port,
      name: expectString(database.name, "database.name"),
      user: expectString(database.user, "database.user"),
      password: expectString(database.password, "database.password")
    },
    sentAt: optionalString(message.sentAt, "sentAt")
  };
  if (hasInstance) out.database.instance = database.instance as string;
  if (typeof database.trustServerCertificate === "boolean") {
    out.database.trustServerCertificate = database.trustServerCertificate;
  }
  return out;
}
```

- [ ] **Step 3.3: Estender `server-message-router.ts`**

Run: `cat src/transport/server-message-router.ts` para revisar estrutura. Adicione um caso `core` para `connector.bootstrap.dbConfig` (se o router usa `core | extension` split, este vai como `core`). O dispatcher de runtime cuida do handler real.

- [ ] **Step 3.4: Rodar testes do protocolo — devem passar**

Run: `npx vitest run tests/transport/protocol.test.ts`
Expected: PASS para os novos casos.

- [ ] **Step 3.5: Commit**

```bash
git add src/transport/protocol.ts src/transport/server-message-router.ts tests/transport/protocol.test.ts
git commit -m "feat(protocol): envelope connector.bootstrap.dbConfig"
```

---

## Task 4: `applyBootstrapDbConfig` no runtime

**Files:**
- Modify: `src/config/programdata-config.ts` — adicionar `writeDatabaseConfig`
- Modify: `src/service/runtime.ts` — `applyBootstrapDbConfig`, `bootstrapState`, handler do novo envelope, transição

- [ ] **Step 4.1: Inspecionar `programdata-config.ts`**

Run: `cat src/config/programdata-config.ts | head -80`

Identifique o formato do arquivo persistido (provavelmente JSON em `%PROGRAMDATA%\PharmaAgent\config.json` ou similar). Anote o nome do export usado para escrever (provavelmente já existe um `writeConfig` ou similar).

- [ ] **Step 4.2: Adicionar `writeDatabaseConfig`**

Modify `src/config/programdata-config.ts` — adicionar função que recebe `DatabaseConfig` e mescla com o conteúdo existente (preservando campos não relacionados a DB):

```ts
import type { DatabaseConfig } from "./types.js";

export async function writeDatabaseConfig(
  programDataPath: string | undefined,
  database: DatabaseConfig
): Promise<void> {
  const filePath = defaultProgramDataConfigPath(programDataPath);
  await ensureDirectoryExists(path.dirname(filePath));
  let current: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(filePath, "utf8");
    current = JSON.parse(raw);
  } catch {
    current = {};
  }
  const next = { ...current, database };
  await fs.writeFile(filePath, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
}
```

(Ajustar para usar os helpers/imports que `programdata-config.ts` já expõe — `defaultProgramDataConfigPath`, `ensureDirectoryExists` ou equivalentes.)

- [ ] **Step 4.3: Adicionar `BootstrapState` no runtime e expô-lo no admin-router-deps**

Modify `src/service/runtime.ts`:

Adicionar import:

```ts
import { BootstrapState } from "./bootstrap-state.js";
import { writeDatabaseConfig } from "../config/programdata-config.js";
import type { BootstrapDbConfigMessage } from "../transport/protocol.js";
```

Adicionar propriedade na classe:

```ts
private readonly bootstrapState = new BootstrapState();
```

No callsite do admin-router (introduzido na Fase 2), envelopar as funções do router para registrarem probe no `bootstrapState`:

```ts
const wrapProbe = <I extends unknown[], R>(
  command: string,
  fn: (...args: I) => Promise<R>
) => async (...args: I): Promise<R> => {
  try {
    const result = await fn(...args);
    this.bootstrapState.recordProbeSuccess(command);
    return result;
  } catch (err) {
    this.bootstrapState.recordProbeError(command, "internal");
    throw err;
  }
};

const adminRouterDeps = {
  probeEngines: wrapProbe("probe.engines", () => probeEngines(...)),
  probeOdbcDsns: wrapProbe("probe.odbc_dsns", () => probeOdbcDsns(...)),
  probeNetwork: wrapProbe("probe.network", probeNetwork),
  probeTestConnection: wrapProbe("probe.test_connection", (input) => probeTestConnection(input, {...})),
  schemaListTables: async () => { /* existente */ }
};
```

(Para `probe.test_connection`, idealmente registrar o `code` retornado em `recordProbeError` quando `result.ok === false`; manter um `record` extra:

```ts
probeTestConnection: async (input) => {
  const result = await probeTestConnection(input, {...});
  if (result.ok) this.bootstrapState.recordProbeSuccess("probe.test_connection");
  else this.bootstrapState.recordProbeError("probe.test_connection", result.code);
  return result;
}
```
)

- [ ] **Step 4.4: Implementar `applyBootstrapDbConfig`**

Adicionar método público no `Runtime`:

```ts
public async applyBootstrapDbConfig(message: BootstrapDbConfigMessage): Promise<void> {
  if (this.config.database) {
    this.logger.warn("bootstrap.db_config_ignored", {
      reason: "already_synced",
      requestId: message.requestId
    });
    return;
  }

  this.logger.info("bootstrap.db_config_received", {
    requestId: message.requestId,
    dbDriver: message.database.driver
  });

  try {
    await writeDatabaseConfig(this.configuredProgramDataPath(), message.database);
  } catch (err) {
    this.logger.error("bootstrap.persist_failed", {
      message: err instanceof Error ? err.message : String(err)
    });
    return;
  }

  this.config = { ...this.config, database: message.database } as ConnectorConfig;
  this.adapter = createSourceDatabaseAdapter({
    config: message.database,
    dependencies: this.adapterDependencies,
    secrets: runtimeConfigSecrets(this.config)
  });

  this.logger.info("bootstrap.transitioned_to_synced", {
    dbDriver: message.database.driver
  });

  this.sendHeartbeat();
  await this.resumeSavedMappingIfAvailable();
}
```

- [ ] **Step 4.5: Wirar handler no router de mensagens do server**

Localize o callback que dispatcha `ServerMessage` no `bindTransportEvents` (procure por `case "connector.config"` ou `onServerMessage`). Adicione:

```ts
case "connector.bootstrap.dbConfig":
  await this.applyBootstrapDbConfig(message);
  break;
```

- [ ] **Step 4.6: Atualizar callsites de heartbeat e `connector.discovery` para usar `state`/`mode`**

Substitua o hardcode da Task 2.4 (`this.config.database ? "synced" : "bootstrap"`) pela chamada limpa:

```ts
private currentMode(): "bootstrap" | "synced" {
  return this.config.database ? "synced" : "bootstrap";
}
```

E nos pontos de heartbeat:

```ts
const payload: HeartbeatPayload = {
  // ...campos existentes...
  state: this.currentMode(),
  ...(this.currentMode() === "bootstrap" ? { bootstrap: this.bootstrapState.snapshot() } : {})
};
```

- [ ] **Step 4.7: Rodar suite completa**

Run: `npm test`
Expected: PASS — alguns testes podem precisar de atualização para esperar `state: "synced"` nos heartbeats e `mode` no discovery.

- [ ] **Step 4.8: Commit**

```bash
git add src/config/programdata-config.ts src/service/runtime.ts
git commit -m "feat(runtime): applyBootstrapDbConfig persiste e transiciona para synced"
```

---

## Task 5: Teste de integração da transição bootstrap→synced

**Files:**
- Modify: `tests/service/runtime.test.ts` (ou criar `tests/service/bootstrap-transition.test.ts` se preferir isolado)

- [ ] **Step 5.1: Adicionar teste cobrindo o ciclo completo**

```ts
import { describe, expect, it, vi } from "vitest";
import { ConnectorRuntime } from "../../src/service/runtime.js";
// importar fakes/mocks existentes para transport, stateStore, adapter, etc.

describe("bootstrap mode transition", () => {
  it("starts in bootstrap, applies dbConfig, transitions to synced and resumes mapping", async () => {
    const env = {
      CONNECTOR_TOKEN: "tok",
      CONNECTOR_WS_URL: "ws://localhost/",
      LOG_LEVEL: "info"
      // sem DB_*
    };
    const fakeAdapter = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      queryChanges: vi.fn(async () => []),
      querySnapshotPage: vi.fn(async () => []),
      listTables: vi.fn(async () => []),
      listColumns: vi.fn(async () => [])
    };
    const adapterDependencies = {
      mysqlConnectionFactory: vi.fn(),
      firebirdConnectionFactory: vi.fn(),
      postgresConnectionFactory: vi.fn(),
      mariadbConnectionFactory: vi.fn(),
      sqlserverConnectionFactory: vi.fn()
    };

    const runtime = new ConnectorRuntime({
      env,
      allowMissingDatabaseConfig: true,
      adapterDependencies,
      // injetar transport/state mocks conforme o padrão atual dos testes
    });

    expect(runtime.getState()).toMatchObject({ /* state que indica bootstrap */ });

    await runtime.applyBootstrapDbConfig({
      type: "connector.bootstrap.dbConfig",
      requestId: "boot-1",
      database: {
        driver: "sqlserver",
        host: "10.0.0.1",
        port: 1433,
        name: "BIG",
        user: "ro",
        password: "p"
      }
    });

    expect(runtime.getState()).toMatchObject({ /* state synced */ });
  });

  it("rejects dbConfig when already synced", async () => {
    // setup runtime com DB env válido → applyBootstrapDbConfig deve apenas warnar e não recriar adapter
  });
});
```

(Ajustar para o estilo real dos testes de runtime existentes — usar fakes de transport/stateStore conforme padrão do projeto.)

- [ ] **Step 5.2: Rodar testes**

Run: `npx vitest run tests/service/`
Expected: PASS.

- [ ] **Step 5.3: Commit**

```bash
git add tests/service/
git commit -m "test(runtime): cobre transicao bootstrap para synced"
```

---

## Task 6: Atualizar README com fluxo painel-driven

**Files:**
- Modify: `README.md`

- [ ] **Step 6.1: Adicionar seção "Fluxo painel-driven vs CLI local"**

Adicione antes da seção "Local Development" do README:

```md
## Onboarding Flows

The service supports two onboarding paths:

- **CLI local (legacy):** Run `npm run database-setup --` on the client machine to
  fill `~/.pharma-agent/database-setup.json` before starting the service. Service
  starts directly in `synced` state.
- **Painel-driven (recommended):** Skip `database-setup`. Service boots in
  `bootstrap` state, connects to the panel via WS, and accepts `probe.*` admin
  requests for the panel to discover engines, ODBC DSNs, network reachability and
  test candidate connections. The panel then sends a `connector.bootstrap.dbConfig`
  envelope; the service persists the config to `%PROGRAMDATA%\PharmaAgent` and
  transitions to `synced` without restarting.

In both flows the service emits a `connector.discovery` snapshot on first connect
with `mode: "bootstrap"` or `mode: "synced"`.
```

- [ ] **Step 6.2: Commit**

```bash
git add README.md
git commit -m "docs: README descreve fluxo painel-driven com bootstrap mode"
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
Expected: 6 commits criados na ordem das tasks.
