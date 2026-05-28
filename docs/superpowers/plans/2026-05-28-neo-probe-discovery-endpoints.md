# Neo: endpoints stateless de probe-discovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar 3 endpoints HTTP stateless ao Neo (`/discover`, `/scan-configs`, `/apply`) que proxiam probes ao agente via WS existente, sem persistência adicional.

**Architecture:** NestJS module. Reusa `AgentConnectorWebSocketAdapter` (gateway WS atual). Adiciona 5 métodos novos no adapter (um por comando: `probe.engines`, `probe.odbc_dsns`, `probe.processes`, `probe.connections`, `probe.scan_config_dirs`, `probe.test_connection`, `connector.bootstrap.dbConfig`), seguindo o padrão `pendingRequest` já usado (UUID → timeout → resolve/reject). Service novo `ProbeDiscoveryService` orquestra. Controller novo expõe os 3 endpoints. Sem migrations, sem entidades novas.

**Tech Stack:** NestJS, TypeScript, class-validator, vitest, WebSocket nativo.

**Repo:** `/home/cako/Documents/projetos/pharmachatbot/neo-api-pharmachatbot`. Branch: novo `feat/probe-discovery-setup`. Commit style: Conventional Commits em pt-br, uma linha, sem body, sem Co-Authored-By.

**Spec:** `pharma-agent-v2/docs/superpowers/specs/2026-05-28-painel-probe-driven-setup-design.md`.

**Depende de:** Agente pronto (já está — `pharma-agent-v2@main` posterior ao commit `4b70680`).

---

## File Structure

**Novos arquivos:**

- `src/modules/pharma-agent-catalog/dtos/probe-discovery-scan-configs.dto.ts` — DTO para `/scan-configs`
- `src/modules/pharma-agent-catalog/dtos/probe-discovery-apply.dto.ts` — DTO para `/apply`
- `src/modules/pharma-agent-catalog/interfaces/probe-discovery.interface.ts` — tipos compartilhados (engines, dsns, processes, connections, candidate)
- `src/modules/pharma-agent-catalog/services/probe-discovery.service.ts` — orquestração
- `src/modules/pharma-agent-catalog/services/probe-discovery.service.test.ts`
- `src/modules/pharma-agent-catalog/controllers/probe-discovery.controller.ts` — 3 endpoints
- `src/modules/pharma-agent-catalog/controllers/probe-discovery.controller.test.ts`
- `src/modules/pharma-agent-catalog/utils/build-discovery-candidate.ts` — heurística do candidate pré-preenchido
- `src/modules/pharma-agent-catalog/utils/build-discovery-candidate.test.ts`
- `src/modules/agent-identities/interfaces/connector-probe-result.interface.ts` — tipos de response das probes que o agente devolve

**Modificados:**

- `src/modules/agent-identities/gateways/agent-connector-websocket.adapter.ts` — 7 métodos novos seguindo padrão `pendingRequest`
- `src/modules/agent-identities/gateways/agent-connector-websocket.adapter.int.test.ts` — testes dos novos métodos
- `src/modules/pharma-agent-catalog/pharma-agent-catalog.module.ts` — registra novo controller + service
- `src/modules/pharma-agent-catalog/constants/probe-discovery.constants.ts` — timeouts, limites, feature flag key

---

## Task 1: Interfaces compartilhadas (tipos das responses do agente)

**Files:**
- Create: `src/modules/agent-identities/interfaces/connector-probe-result.interface.ts`
- Create: `src/modules/pharma-agent-catalog/interfaces/probe-discovery.interface.ts`

- [ ] **Step 1.1: Criar `connector-probe-result.interface.ts`**

```ts
// Responses crus das probes vindas do agente via admin.response.payload.
// Espelham as types exportadas em pharma-agent-v2.

export interface IProbeEngineResult {
  kind: 'sqlserver' | 'postgresql' | 'mysql' | 'mariadb' | 'firebird';
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];
}

export interface IProbeOdbcDsnResult {
  name: string;
  driver: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
}

export interface IProbeProcessResult {
  pid: number;
  name: string;
  path?: string;
}

export interface IProbeConnectionResult {
  pid: number;
  processName?: string;
  localAddr: string;
  localPort: number;
  remoteAddr: string;
  remotePort: number;
  state: string;
}

export interface IProbeScanConfigDirsResult {
  files: Array<{ path: string; size: number; mtime: string }>;
  truncated: boolean;
  rootsRejected: string[];
  errors: Array<{ path: string; reason: 'permission' | 'missing' | 'unknown' }>;
}

export type ProbeTestConnectionErrorCode =
  | 'auth' | 'timeout' | 'tls' | 'unreachable' | 'driver_missing' | 'unknown';

export type IProbeTestConnectionResult =
  | { ok: true; latencyMs: number; serverVersion?: string }
  | { ok: false; code: ProbeTestConnectionErrorCode; message: string };
```

- [ ] **Step 1.2: Criar `probe-discovery.interface.ts`**

```ts
import type {
  IProbeConnectionResult,
  IProbeEngineResult,
  IProbeOdbcDsnResult,
  IProbeProcessResult,
  IProbeTestConnectionResult,
} from '@/modules/agent-identities/interfaces/connector-probe-result.interface';

export type ProbeDiscoveryDriver =
  'sqlserver' | 'postgresql' | 'mysql' | 'mariadb' | 'firebird';

export interface IProbeDiscoveryCandidate {
  driver: ProbeDiscoveryDriver;
  host: string;
  port: number;
  instance: string | null;
  database: string | null;
  user: string | null;
  password: string | null;
  trustServerCertificate: boolean;
}

export interface IProbeDiscoveryResult {
  engines: IProbeEngineResult[];
  odbcDsns: IProbeOdbcDsnResult[];
  processes: IProbeProcessResult[];
  connections: IProbeConnectionResult[];
  candidate: IProbeDiscoveryCandidate;
}

export interface IProbeDiscoveryApplyResult {
  applied: boolean;
  testResult: IProbeTestConnectionResult;
}
```

- [ ] **Step 1.3: Verificar build TS**

Run: `pnpm tsc --noEmit`
Expected: zero erros.

- [ ] **Step 1.4: Commit**

```bash
git add src/modules/agent-identities/interfaces/connector-probe-result.interface.ts \
        src/modules/pharma-agent-catalog/interfaces/probe-discovery.interface.ts
git commit -m "feat(neo): tipos compartilhados para responses de probes do agente"
```

---

## Task 2: Constants

**Files:**
- Create: `src/modules/pharma-agent-catalog/constants/probe-discovery.constants.ts`

- [ ] **Step 2.1: Criar arquivo**

```ts
// Timeouts para WS round-trip entre Neo e o agente. Cada probe individual.
export const PROBE_DISCOVERY_TIMEOUT_MS = 15_000;

// Timeout para test_connection (mais curto — adapter já tem 5s interno).
export const PROBE_DISCOVERY_TEST_CONNECTION_TIMEOUT_MS = 8_000;

// Timeout para esperar heartbeat synced após bootstrap.dbConfig.
export const PROBE_DISCOVERY_APPLY_HEARTBEAT_TIMEOUT_MS = 15_000;

// Conector é considerado offline se último heartbeat passou disto.
export const PROBE_DISCOVERY_OFFLINE_THRESHOLD_MS = 60_000;

// Cap de roots aceitos em /scan-configs (espelha o limite do agente).
export const PROBE_DISCOVERY_MAX_ROOTS = 32;

// Feature flag key (padrão do Neo — consultar como ler em existing services).
export const PROBE_DISCOVERY_FEATURE_FLAG = 'feature_probe_driven_setup';
```

- [ ] **Step 2.2: Commit**

```bash
git add src/modules/pharma-agent-catalog/constants/probe-discovery.constants.ts
git commit -m "feat(neo): constantes de timeouts e limites para probe discovery"
```

---

## Task 3: Estender `AgentConnectorWebSocketAdapter` com método genérico `requestProbe`

**Files:**
- Modify: `src/modules/agent-identities/gateways/agent-connector-websocket.adapter.ts`
- Modify: `src/modules/agent-identities/gateways/agent-connector-websocket.adapter.int.test.ts`

- [ ] **Step 3.1: Inspecionar o padrão existente de pendingRequest**

Antes de tocar código, ler o adapter (`wc -l`: 1952). Procurar pelas estruturas existentes:

```bash
grep -n "pendingSchemaTablesListRequest\|pendingFileDiscoveryScanRequest\|removePendingSchemaTables\|connectorId\|isConnectorOnline" src/modules/agent-identities/gateways/agent-connector-websocket.adapter.ts | head -20
```

Anotar:
- Como os pending requests são armazenados (`Map<commandId, { resolve, reject, timer }>`)
- Como o commandId é gerado (`uuid()`)
- Como o handler de mensagem do agente faz routing pela `requestId`/`command`
- Helper que checa se conector está online (`isConnectorOnline(connectorId)` ou similar)

- [ ] **Step 3.2: Adicionar método genérico `requestProbeAdminCommand`**

Adicionar no adapter, próximo aos métodos `requestSchemaTablesList` / `requestFileDiscoveryScan`:

```ts
// No topo do arquivo, adicionar import:
// import type { AdminCommand, IProbe... } from ...
// (Não usado por enquanto — método é genérico.)

private readonly pendingProbeRequests = new Map<
  string,
  {
    resolve: (payload: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    command: string;
  }
>();

private removePendingProbeRequest(commandId: string) {
  const pending = this.pendingProbeRequests.get(commandId);
  if (pending) {
    clearTimeout(pending.timer);
    this.pendingProbeRequests.delete(commandId);
  }
  return pending;
}

public async requestProbeAdminCommand(
  connectorId: string,
  command:
    | 'probe.engines'
    | 'probe.odbc_dsns'
    | 'probe.processes'
    | 'probe.connections'
    | 'probe.scan_config_dirs'
    | 'probe.test_connection',
  input: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const ws = this.getConnectorSocket(connectorId);
  if (!ws) {
    throw new Error(`Connector ${connectorId} is not connected`);
  }

  const commandId = uuid();

  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      this.removePendingProbeRequest(commandId);
      logger.warn({
        action: 'agent_connector_probe_command_timeout',
        connectorId,
        commandId,
        command,
      });
      reject(new Error(`Probe ${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    this.pendingProbeRequests.set(commandId, {
      resolve: (payload) => {
        this.removePendingProbeRequest(commandId);
        resolve(payload);
      },
      reject: (error) => {
        this.removePendingProbeRequest(commandId);
        reject(error);
      },
      timer,
      command,
    });

    const message: Record<string, unknown> = {
      type: 'admin.request',
      requestId: commandId,
      command,
    };
    if (input !== undefined) message.input = input;

    ws.send(JSON.stringify(message));
    logger.info({
      action: 'agent_connector_probe_command_sent',
      connectorId,
      commandId,
      command,
    });
  });
}
```

`uuid` e `logger` já são importados no topo do arquivo (verificar). `getConnectorSocket(connectorId)` é o helper privado que o adapter já usa para outros métodos — confirmar nome real lendo o código adjacente.

- [ ] **Step 3.3: Estender o handler de `admin.response` no adapter para resolver pending probe requests**

Localizar o método que processa mensagens recebidas do agente (procurar `admin.response` ou `parseAdminResponseMessage`). Antes/depois do tratamento atual de `schema.listTables`, adicionar:

```ts
// Dentro do handler de admin.response message:
const pendingProbe = this.pendingProbeRequests.get(message.requestId);
if (pendingProbe) {
  if (message.ok) {
    pendingProbe.resolve(message.payload);
  } else {
    pendingProbe.reject(new Error(message.error?.message ?? 'Probe failed'));
  }
  return;
}
```

(O handler atual provavelmente faz lookup em `pendingSchemaTablesListRequests` ou similar — colocar a lookup em probe ANTES dele para que o novo path tenha precedência caso commandIds colidam.)

- [ ] **Step 3.4: Adicionar método `pushBootstrapDbConfig` no adapter**

Próximo aos outros métodos `push*`:

```ts
public pushBootstrapDbConfig(
  connectorId: string,
  database: {
    driver: string;
    host: string;
    port: number;
    instance?: string;
    name: string;
    user: string;
    password: string;
    trustServerCertificate?: boolean;
  },
): void {
  const ws = this.getConnectorSocket(connectorId);
  if (!ws) {
    throw new Error(`Connector ${connectorId} is not connected`);
  }

  const requestId = uuid();
  const message: Record<string, unknown> = {
    type: 'connector.bootstrap.dbConfig',
    requestId,
    database,
  };
  ws.send(JSON.stringify(message));
  logger.info({
    action: 'agent_connector_bootstrap_db_config_sent',
    connectorId,
    requestId,
    dbDriver: database.driver,
  });
}
```

- [ ] **Step 3.5: Adicionar método `waitForSyncedHeartbeat`**

Após o `pushBootstrapDbConfig`, painel quer saber se o agente transicionou. Adicionar:

```ts
public async waitForSyncedHeartbeat(
  connectorId: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let resolved = false;
    const cleanup = () => {
      this.removeListener('heartbeat', onHeartbeat);
      clearTimeout(timer);
    };
    const onHeartbeat = (event: { connectorId: string; payload: { state?: string } }) => {
      if (event.connectorId === connectorId && event.payload?.state === 'synced') {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve();
      }
    };
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      cleanup();
      reject(new Error(`Synced heartbeat not received within ${timeoutMs}ms`));
    }, timeoutMs);
    this.on('heartbeat', onHeartbeat);
  });
}
```

Confirmar que o adapter já emite eventos `'heartbeat'` com o payload (procurar por `emit('heartbeat'` no arquivo). Se não emitir, adicionar emissão no handler de heartbeat:

```ts
// Dentro do handler de heartbeat:
this.emit('heartbeat', { connectorId, payload });
```

- [ ] **Step 3.6: Adicionar testes do método genérico**

Em `agent-connector-websocket.adapter.int.test.ts`, adicionar block novo:

```ts
describe('requestProbeAdminCommand', () => {
  it('sends admin.request and resolves with payload on admin.response', async () => {
    // setup adapter + mock WS server (já existem helpers no test file atual)
    const adapter = createTestAdapter();
    const fakeWs = registerFakeConnector(adapter, 'conn-1');

    const promise = adapter.requestProbeAdminCommand('conn-1', 'probe.engines', {}, 5000);

    // esperar o adapter ter enviado a request
    await waitForMessage(fakeWs);
    const sent = JSON.parse(fakeWs.lastSent());
    expect(sent).toMatchObject({
      type: 'admin.request',
      command: 'probe.engines',
    });

    // simular response
    fakeWs.simulateMessageFromConnector({
      type: 'admin.response',
      requestId: sent.requestId,
      command: 'probe.engines',
      ok: true,
      payload: { engines: [] },
      sentAt: new Date().toISOString(),
    });

    await expect(promise).resolves.toEqual({ engines: [] });
  });

  it('rejects on admin.response error', async () => {
    const adapter = createTestAdapter();
    const fakeWs = registerFakeConnector(adapter, 'conn-2');
    const promise = adapter.requestProbeAdminCommand('conn-2', 'probe.engines', {}, 5000);
    await waitForMessage(fakeWs);
    const sent = JSON.parse(fakeWs.lastSent());
    fakeWs.simulateMessageFromConnector({
      type: 'admin.response',
      requestId: sent.requestId,
      command: 'probe.engines',
      ok: false,
      error: { errorCode: 'INTERNAL_ERROR', message: 'boom' },
      sentAt: new Date().toISOString(),
    });
    await expect(promise).rejects.toThrow('boom');
  });

  it('rejects with timeout when no response arrives', async () => {
    const adapter = createTestAdapter();
    registerFakeConnector(adapter, 'conn-3');
    await expect(
      adapter.requestProbeAdminCommand('conn-3', 'probe.engines', {}, 100),
    ).rejects.toThrow(/timed out/);
  });

  it('throws when connector is not connected', async () => {
    const adapter = createTestAdapter();
    await expect(
      adapter.requestProbeAdminCommand('conn-missing', 'probe.engines', {}, 5000),
    ).rejects.toThrow(/not connected/);
  });
});

describe('pushBootstrapDbConfig', () => {
  it('sends connector.bootstrap.dbConfig envelope', () => {
    const adapter = createTestAdapter();
    const fakeWs = registerFakeConnector(adapter, 'conn-4');
    adapter.pushBootstrapDbConfig('conn-4', {
      driver: 'sqlserver', host: 'h', port: 1433, name: 'd', user: 'u', password: 'p',
    });
    const sent = JSON.parse(fakeWs.lastSent());
    expect(sent).toMatchObject({
      type: 'connector.bootstrap.dbConfig',
      database: { driver: 'sqlserver', name: 'd' },
    });
  });
});

describe('waitForSyncedHeartbeat', () => {
  it('resolves when heartbeat event with state=synced fires', async () => {
    const adapter = createTestAdapter();
    const promise = adapter.waitForSyncedHeartbeat('conn-5', 1000);
    adapter.emit('heartbeat', { connectorId: 'conn-5', payload: { state: 'synced' } });
    await expect(promise).resolves.toBeUndefined();
  });

  it('ignores heartbeats from other connectors', async () => {
    const adapter = createTestAdapter();
    const promise = adapter.waitForSyncedHeartbeat('conn-5', 200);
    adapter.emit('heartbeat', { connectorId: 'conn-other', payload: { state: 'synced' } });
    await expect(promise).rejects.toThrow(/not received/);
  });
});
```

Os helpers `createTestAdapter`, `registerFakeConnector`, `waitForMessage` existem no arquivo de teste atual — verificar nomes reais e adaptar.

- [ ] **Step 3.7: Rodar**

```bash
pnpm test src/modules/agent-identities/gateways/agent-connector-websocket.adapter.int.test.ts
```

Expected: PASS.

- [ ] **Step 3.8: Commit**

```bash
git add src/modules/agent-identities/gateways/agent-connector-websocket.adapter.ts \
        src/modules/agent-identities/gateways/agent-connector-websocket.adapter.int.test.ts
git commit -m "feat(neo): adapter aceita requestProbeAdminCommand e pushBootstrapDbConfig"
```

---

## Task 4: Heurística do candidate (`build-discovery-candidate.ts`)

**Files:**
- Create: `src/modules/pharma-agent-catalog/utils/build-discovery-candidate.ts`
- Create: `src/modules/pharma-agent-catalog/utils/build-discovery-candidate.test.ts`

- [ ] **Step 4.1: Escrever testes**

```ts
import { describe, expect, it } from 'vitest';
import { buildDiscoveryCandidate } from './build-discovery-candidate';

describe('buildDiscoveryCandidate', () => {
  it('returns null candidate when no engines detected', () => {
    const r = buildDiscoveryCandidate({ engines: [], odbcDsns: [], processes: [], connections: [] });
    expect(r).toEqual({
      driver: 'sqlserver',
      host: '127.0.0.1',
      port: 1433,
      instance: null,
      database: null,
      user: null,
      password: null,
      trustServerCertificate: false,
    });
  });

  it('picks engine with highest confidence', () => {
    const r = buildDiscoveryCandidate({
      engines: [
        { kind: 'mysql', confidence: 'low', evidence: ['service:MySQL'] },
        { kind: 'sqlserver', confidence: 'high', evidence: ['service:MSSQLSERVER'] },
      ],
      odbcDsns: [],
      processes: [],
      connections: [],
    });
    expect(r.driver).toBe('sqlserver');
    expect(r.port).toBe(1433);
  });

  it('uses connection host/port when available and matches engine port', () => {
    const r = buildDiscoveryCandidate({
      engines: [{ kind: 'postgresql', confidence: 'high', evidence: [] }],
      odbcDsns: [],
      processes: [],
      connections: [
        { pid: 1, localAddr: '127.0.0.1', localPort: 9000, remoteAddr: '10.0.0.5', remotePort: 5432, state: 'ESTABLISHED' },
      ],
    });
    expect(r.host).toBe('10.0.0.5');
    expect(r.port).toBe(5432);
  });

  it('falls back to default port when no matching connection', () => {
    const r = buildDiscoveryCandidate({
      engines: [{ kind: 'mariadb', confidence: 'high', evidence: [] }],
      odbcDsns: [],
      processes: [],
      connections: [
        { pid: 1, localAddr: '127.0.0.1', localPort: 9000, remoteAddr: '127.0.0.1', remotePort: 1433, state: 'ESTABLISHED' },
      ],
    });
    expect(r.driver).toBe('mariadb');
    expect(r.port).toBe(3306);
    expect(r.host).toBe('127.0.0.1');
  });

  it('uses ODBC DSN database and user when driver matches', () => {
    const r = buildDiscoveryCandidate({
      engines: [{ kind: 'postgresql', confidence: 'high', evidence: [] }],
      odbcDsns: [
        { name: 'LINX_PG', driver: 'PSQLODBC', host: '10.0.0.5', port: 5432, database: 'linx', user: 'ro' },
      ],
      processes: [],
      connections: [],
    });
    expect(r.database).toBe('linx');
    expect(r.user).toBe('ro');
  });

  it('ignores ODBC DSN when driver does not match detected engine', () => {
    const r = buildDiscoveryCandidate({
      engines: [{ kind: 'sqlserver', confidence: 'high', evidence: [] }],
      odbcDsns: [
        { name: 'LINX_PG', driver: 'PSQLODBC', host: '10.0.0.5', port: 5432, database: 'linx', user: 'ro' },
      ],
      processes: [],
      connections: [],
    });
    expect(r.database).toBeNull();
    expect(r.user).toBeNull();
  });
});
```

- [ ] **Step 4.2: Rodar — fail (módulo não existe)**

```bash
pnpm test src/modules/pharma-agent-catalog/utils/build-discovery-candidate.test.ts
```

- [ ] **Step 4.3: Implementar**

```ts
import type {
  IProbeConnectionResult,
  IProbeEngineResult,
  IProbeOdbcDsnResult,
  IProbeProcessResult,
} from '@/modules/agent-identities/interfaces/connector-probe-result.interface';
import type {
  IProbeDiscoveryCandidate,
  ProbeDiscoveryDriver,
} from '../interfaces/probe-discovery.interface';

const ENGINE_DEFAULT_PORT: Record<ProbeDiscoveryDriver, number> = {
  sqlserver: 1433,
  postgresql: 5432,
  mysql: 3306,
  mariadb: 3306,
  firebird: 3050,
};

const CONFIDENCE_RANK: Record<'high' | 'medium' | 'low', number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const ODBC_DRIVER_MATCHERS: Record<ProbeDiscoveryDriver, RegExp> = {
  sqlserver: /sql ?server|msodbc|sqlncli/i,
  postgresql: /psqlodbc|postgres/i,
  mysql: /mysql/i,
  mariadb: /mariadb/i,
  firebird: /firebird/i,
};

interface BuildInput {
  engines: IProbeEngineResult[];
  odbcDsns: IProbeOdbcDsnResult[];
  processes: IProbeProcessResult[];
  connections: IProbeConnectionResult[];
}

export function buildDiscoveryCandidate(input: BuildInput): IProbeDiscoveryCandidate {
  const driver = pickDriver(input.engines);
  const defaultPort = ENGINE_DEFAULT_PORT[driver];

  const matchingConn = input.connections.find(
    (c) => c.remotePort === defaultPort || c.localPort === defaultPort,
  );
  const host = matchingConn?.remoteAddr ?? '127.0.0.1';
  const port = matchingConn?.remotePort ?? defaultPort;

  const matchingDsn = input.odbcDsns.find((d) => ODBC_DRIVER_MATCHERS[driver].test(d.driver));

  return {
    driver,
    host,
    port,
    instance: null,
    database: matchingDsn?.database ?? null,
    user: matchingDsn?.user ?? null,
    password: null,
    trustServerCertificate: false,
  };
}

function pickDriver(engines: IProbeEngineResult[]): ProbeDiscoveryDriver {
  if (engines.length === 0) return 'sqlserver';
  const sorted = [...engines].sort((a, b) => CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence]);
  return sorted[0]?.kind ?? 'sqlserver';
}
```

- [ ] **Step 4.4: Rodar — pass**

- [ ] **Step 4.5: Commit**

```bash
git add src/modules/pharma-agent-catalog/utils/build-discovery-candidate.ts \
        src/modules/pharma-agent-catalog/utils/build-discovery-candidate.test.ts
git commit -m "feat(neo): heuristica de candidate pre-preenchido a partir de probes"
```

---

## Task 5: DTOs (`scan-configs` + `apply`)

**Files:**
- Create: `src/modules/pharma-agent-catalog/dtos/probe-discovery-scan-configs.dto.ts`
- Create: `src/modules/pharma-agent-catalog/dtos/probe-discovery-apply.dto.ts`

- [ ] **Step 5.1: Criar `probe-discovery-scan-configs.dto.ts`**

```ts
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, Max, MaxLength, Min,
} from 'class-validator';

import { PROBE_DISCOVERY_MAX_ROOTS } from '../constants/probe-discovery.constants';

export class ProbeDiscoveryScanConfigsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PROBE_DISCOVERY_MAX_ROOTS)
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  roots!: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(32)
  patterns?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  maxDepth?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  maxFiles?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  maxAgeDays?: number;
}
```

- [ ] **Step 5.2: Criar `probe-discovery-apply.dto.ts`**

```ts
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min,
  ValidateIf,
} from 'class-validator';

const DRIVERS = ['sqlserver', 'postgresql', 'mysql', 'mariadb', 'firebird'] as const;

function trim(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export class ProbeDiscoveryApplyDto {
  @Transform(({ value }) => trim(value))
  @IsString()
  @IsIn([...DRIVERS])
  driver!: string;

  @Transform(({ value }) => trim(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  host!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;

  @IsOptional()
  @Transform(({ value }) => trim(value))
  @IsString()
  @MaxLength(128)
  @ValidateIf((_, value) => value !== null)
  instance?: string | null;

  @Transform(({ value }) => trim(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  database!: string;

  @Transform(({ value }) => trim(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  user!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  password!: string;

  @IsOptional()
  @IsBoolean()
  trustServerCertificate?: boolean;
}
```

- [ ] **Step 5.3: Verificar build TS**

```bash
pnpm tsc --noEmit
```

- [ ] **Step 5.4: Commit**

```bash
git add src/modules/pharma-agent-catalog/dtos/probe-discovery-scan-configs.dto.ts \
        src/modules/pharma-agent-catalog/dtos/probe-discovery-apply.dto.ts
git commit -m "feat(neo): DTOs scan-configs e apply para probe discovery"
```

---

## Task 6: `ProbeDiscoveryService`

**Files:**
- Create: `src/modules/pharma-agent-catalog/services/probe-discovery.service.ts`
- Create: `src/modules/pharma-agent-catalog/services/probe-discovery.service.test.ts`

- [ ] **Step 6.1: Escrever testes**

```ts
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentConnectorWebSocketAdapter } from '@/modules/agent-identities/gateways/agent-connector-websocket.adapter';
import { ProbeDiscoveryService } from './probe-discovery.service';

function makeAdapter(): AgentConnectorWebSocketAdapter {
  return {
    isConnectorOnline: vi.fn(() => true),
    requestProbeAdminCommand: vi.fn(),
    pushBootstrapDbConfig: vi.fn(),
    waitForSyncedHeartbeat: vi.fn(async () => undefined),
  } as unknown as AgentConnectorWebSocketAdapter;
}

describe('ProbeDiscoveryService', () => {
  let adapter: AgentConnectorWebSocketAdapter;
  let service: ProbeDiscoveryService;

  beforeEach(async () => {
    adapter = makeAdapter();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ProbeDiscoveryService,
        { provide: AgentConnectorWebSocketAdapter, useValue: adapter },
      ],
    }).compile();
    service = moduleRef.get(ProbeDiscoveryService);
  });

  describe('discover', () => {
    it('runs 4 probes in sequence and aggregates with candidate', async () => {
      vi.mocked(adapter.requestProbeAdminCommand)
        .mockResolvedValueOnce({ engines: [{ kind: 'sqlserver', confidence: 'high', evidence: [] }] })
        .mockResolvedValueOnce({ dsns: [] })
        .mockResolvedValueOnce({ processes: [] })
        .mockResolvedValueOnce({ connections: [] });

      const result = await service.discover('conn-1');
      expect(result.engines).toHaveLength(1);
      expect(result.candidate.driver).toBe('sqlserver');
      expect(adapter.requestProbeAdminCommand).toHaveBeenCalledTimes(4);
    });

    it('throws when connector is offline', async () => {
      vi.mocked(adapter.isConnectorOnline).mockReturnValue(false);
      await expect(service.discover('conn-offline')).rejects.toThrow(/offline/i);
    });
  });

  describe('scanConfigs', () => {
    it('forwards probe.scan_config_dirs and returns result', async () => {
      vi.mocked(adapter.requestProbeAdminCommand).mockResolvedValueOnce({
        files: [{ path: 'C:\\Linx\\app.ini', size: 100, mtime: '2026-01-01T00:00:00Z' }],
        truncated: false, rootsRejected: [], errors: [],
      });
      const r = await service.scanConfigs('conn-1', { roots: ['C:\\Linx'] });
      expect(r.files).toHaveLength(1);
      expect(adapter.requestProbeAdminCommand).toHaveBeenCalledWith(
        'conn-1', 'probe.scan_config_dirs', { roots: ['C:\\Linx'] }, expect.any(Number),
      );
    });
  });

  describe('apply', () => {
    it('runs test_connection and aborts if ok=false', async () => {
      vi.mocked(adapter.requestProbeAdminCommand).mockResolvedValueOnce({
        ok: false, code: 'auth', message: 'Login failed',
      });
      const r = await service.apply('conn-1', {
        driver: 'sqlserver', host: 'h', port: 1433, instance: null,
        database: 'd', user: 'u', password: 'p', trustServerCertificate: false,
      });
      expect(r.applied).toBe(false);
      expect(r.testResult).toMatchObject({ ok: false, code: 'auth' });
      expect(adapter.pushBootstrapDbConfig).not.toHaveBeenCalled();
    });

    it('pushes bootstrap.dbConfig and waits for synced heartbeat on success', async () => {
      vi.mocked(adapter.requestProbeAdminCommand).mockResolvedValueOnce({
        ok: true, latencyMs: 10,
      });
      const r = await service.apply('conn-1', {
        driver: 'sqlserver', host: 'h', port: 1433, instance: null,
        database: 'd', user: 'u', password: 'p', trustServerCertificate: false,
      });
      expect(r.applied).toBe(true);
      expect(adapter.pushBootstrapDbConfig).toHaveBeenCalledWith('conn-1', expect.objectContaining({
        driver: 'sqlserver', host: 'h', port: 1433, name: 'd', user: 'u', password: 'p',
      }));
      expect(adapter.waitForSyncedHeartbeat).toHaveBeenCalledWith('conn-1', expect.any(Number));
    });

    it('throws on offline connector', async () => {
      vi.mocked(adapter.isConnectorOnline).mockReturnValue(false);
      await expect(
        service.apply('conn-offline', {
          driver: 'sqlserver', host: 'h', port: 1433, instance: null,
          database: 'd', user: 'u', password: 'p', trustServerCertificate: false,
        }),
      ).rejects.toThrow(/offline/i);
    });
  });
});
```

- [ ] **Step 6.2: Rodar — fail**

```bash
pnpm test src/modules/pharma-agent-catalog/services/probe-discovery.service.test.ts
```

- [ ] **Step 6.3: Implementar**

```ts
import { Injectable } from '@nestjs/common';
import { logger } from '@/common/utils/enhanced-logger';

import { AgentConnectorWebSocketAdapter } from '@/modules/agent-identities/gateways/agent-connector-websocket.adapter';
import {
  PROBE_DISCOVERY_APPLY_HEARTBEAT_TIMEOUT_MS,
  PROBE_DISCOVERY_TEST_CONNECTION_TIMEOUT_MS,
  PROBE_DISCOVERY_TIMEOUT_MS,
} from '../constants/probe-discovery.constants';
import type {
  IProbeDiscoveryApplyResult,
  IProbeDiscoveryCandidate,
  IProbeDiscoveryResult,
} from '../interfaces/probe-discovery.interface';
import { buildDiscoveryCandidate } from '../utils/build-discovery-candidate';

import type {
  IProbeConnectionResult,
  IProbeEngineResult,
  IProbeOdbcDsnResult,
  IProbeProcessResult,
  IProbeScanConfigDirsResult,
  IProbeTestConnectionResult,
} from '@/modules/agent-identities/interfaces/connector-probe-result.interface';

import type { ProbeDiscoveryScanConfigsDto } from '../dtos/probe-discovery-scan-configs.dto';

const MODULE = 'ProbeDiscoveryService';

@Injectable()
export class ProbeDiscoveryService {
  constructor(private readonly adapter: AgentConnectorWebSocketAdapter) {}

  async discover(connectorId: string): Promise<IProbeDiscoveryResult> {
    this.assertOnline(connectorId, 'discover');

    const enginesPayload = (await this.adapter.requestProbeAdminCommand(
      connectorId, 'probe.engines', {}, PROBE_DISCOVERY_TIMEOUT_MS,
    )) as { engines: IProbeEngineResult[] };

    const dsnsPayload = (await this.adapter.requestProbeAdminCommand(
      connectorId, 'probe.odbc_dsns', {}, PROBE_DISCOVERY_TIMEOUT_MS,
    )) as { dsns: IProbeOdbcDsnResult[] };

    const processesPayload = (await this.adapter.requestProbeAdminCommand(
      connectorId, 'probe.processes', {}, PROBE_DISCOVERY_TIMEOUT_MS,
    )) as { processes: IProbeProcessResult[] };

    const connectionsPayload = (await this.adapter.requestProbeAdminCommand(
      connectorId, 'probe.connections', {}, PROBE_DISCOVERY_TIMEOUT_MS,
    )) as { connections: IProbeConnectionResult[] };

    const candidate = buildDiscoveryCandidate({
      engines: enginesPayload.engines ?? [],
      odbcDsns: dsnsPayload.dsns ?? [],
      processes: processesPayload.processes ?? [],
      connections: connectionsPayload.connections ?? [],
    });

    return {
      engines: enginesPayload.engines ?? [],
      odbcDsns: dsnsPayload.dsns ?? [],
      processes: processesPayload.processes ?? [],
      connections: connectionsPayload.connections ?? [],
      candidate,
    };
  }

  async scanConfigs(
    connectorId: string,
    dto: ProbeDiscoveryScanConfigsDto,
  ): Promise<IProbeScanConfigDirsResult> {
    this.assertOnline(connectorId, 'scanConfigs');
    return (await this.adapter.requestProbeAdminCommand(
      connectorId, 'probe.scan_config_dirs', dto, PROBE_DISCOVERY_TIMEOUT_MS,
    )) as IProbeScanConfigDirsResult;
  }

  async apply(
    connectorId: string,
    candidate: IProbeDiscoveryCandidate,
  ): Promise<IProbeDiscoveryApplyResult> {
    this.assertOnline(connectorId, 'apply');

    const testInput = {
      driver: candidate.driver,
      host: candidate.host,
      port: candidate.port,
      ...(candidate.instance ? { instance: candidate.instance } : {}),
      database: candidate.database,
      user: candidate.user,
      password: candidate.password,
      ...(candidate.trustServerCertificate !== undefined
        ? { trustServerCertificate: candidate.trustServerCertificate }
        : {}),
    };

    const testResult = (await this.adapter.requestProbeAdminCommand(
      connectorId,
      'probe.test_connection',
      testInput,
      PROBE_DISCOVERY_TEST_CONNECTION_TIMEOUT_MS,
    )) as IProbeTestConnectionResult;

    if (!testResult.ok) {
      logger.info({ action: 'probe_discovery.apply.test_only', connectorId, code: testResult.code, module: MODULE });
      return { applied: false, testResult };
    }

    this.adapter.pushBootstrapDbConfig(connectorId, {
      driver: candidate.driver,
      host: candidate.host,
      port: candidate.port,
      ...(candidate.instance ? { instance: candidate.instance } : {}),
      name: candidate.database!,
      user: candidate.user!,
      password: candidate.password!,
      ...(candidate.trustServerCertificate !== undefined
        ? { trustServerCertificate: candidate.trustServerCertificate }
        : {}),
    });

    await this.adapter.waitForSyncedHeartbeat(connectorId, PROBE_DISCOVERY_APPLY_HEARTBEAT_TIMEOUT_MS);

    logger.info({ action: 'probe_discovery.apply.success', connectorId, module: MODULE });
    return { applied: true, testResult };
  }

  private assertOnline(connectorId: string, action: string): void {
    if (!this.adapter.isConnectorOnline(connectorId)) {
      logger.warn({ action: `probe_discovery.${action}.offline`, connectorId, module: MODULE });
      const err = new Error(`Connector ${connectorId} is offline`);
      err.name = 'ConnectorOfflineError';
      throw err;
    }
  }
}
```

- [ ] **Step 6.4: Rodar — pass**

```bash
pnpm test src/modules/pharma-agent-catalog/services/probe-discovery.service.test.ts
```

- [ ] **Step 6.5: Commit**

```bash
git add src/modules/pharma-agent-catalog/services/probe-discovery.service.ts \
        src/modules/pharma-agent-catalog/services/probe-discovery.service.test.ts
git commit -m "feat(neo): ProbeDiscoveryService orquestra discover/scanConfigs/apply"
```

---

## Task 7: Controller com 3 endpoints

**Files:**
- Create: `src/modules/pharma-agent-catalog/controllers/probe-discovery.controller.ts`
- Create: `src/modules/pharma-agent-catalog/controllers/probe-discovery.controller.test.ts`

- [ ] **Step 7.1: Inspecionar padrão de controller existente**

```bash
head -50 src/modules/pharma-agent-catalog/controllers/connector-catalog-config.controller.ts
```

Anotar: nome do decorator de auth (`@UseGuards(...)` ou similar), helper de resolver connectorId a partir de companyId (provavelmente via `ReadinessOverviewRepository.findByCompanyId(companyId).connector.id`), error mapping convention.

- [ ] **Step 7.2: Escrever testes**

```ts
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProbeDiscoveryController } from './probe-discovery.controller';
import { ProbeDiscoveryService } from '../services/probe-discovery.service';
import { ReadinessOverviewRepository } from '../repositories/readiness-overview.repository';

function makeRepo(connectorId: string | null) {
  return {
    findByCompanyId: vi.fn(async () => connectorId
      ? { connector: { id: connectorId } }
      : null),
  } as unknown as ReadinessOverviewRepository;
}

function makeService(): ProbeDiscoveryService {
  return {
    discover: vi.fn(),
    scanConfigs: vi.fn(),
    apply: vi.fn(),
  } as unknown as ProbeDiscoveryService;
}

describe('ProbeDiscoveryController', () => {
  let controller: ProbeDiscoveryController;
  let service: ProbeDiscoveryService;

  async function setup(connectorId: string | null) {
    service = makeService();
    const repo = makeRepo(connectorId);
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeDiscoveryController],
      providers: [
        { provide: ProbeDiscoveryService, useValue: service },
        { provide: ReadinessOverviewRepository, useValue: repo },
      ],
    }).compile();
    controller = moduleRef.get(ProbeDiscoveryController);
  }

  describe('POST /discover', () => {
    it('wraps service result in { data }', async () => {
      await setup('conn-1');
      vi.mocked(service.discover).mockResolvedValueOnce({
        engines: [], odbcDsns: [], processes: [], connections: [],
        candidate: { driver: 'sqlserver', host: '127.0.0.1', port: 1433, instance: null,
          database: null, user: null, password: null, trustServerCertificate: false },
      });
      const r = await controller.discover(42);
      expect(r).toMatchObject({ data: { candidate: { driver: 'sqlserver' } } });
    });

    it('returns 424 when no connector found', async () => {
      await setup(null);
      await expect(controller.discover(42)).rejects.toMatchObject({ status: 424 });
    });

    it('maps service offline error to 424', async () => {
      await setup('conn-1');
      const err: any = new Error('offline');
      err.name = 'ConnectorOfflineError';
      vi.mocked(service.discover).mockRejectedValueOnce(err);
      await expect(controller.discover(42)).rejects.toMatchObject({ status: 424 });
    });

    it('maps WS timeout to 504', async () => {
      await setup('conn-1');
      vi.mocked(service.discover).mockRejectedValueOnce(new Error('Probe probe.engines timed out after 15000ms'));
      await expect(controller.discover(42)).rejects.toMatchObject({ status: 504 });
    });
  });

  describe('POST /scan-configs', () => {
    it('forwards DTO to service', async () => {
      await setup('conn-1');
      vi.mocked(service.scanConfigs).mockResolvedValueOnce({ files: [], truncated: false, rootsRejected: [], errors: [] });
      const r = await controller.scanConfigs(42, { roots: ['C:\\App'] } as any);
      expect(service.scanConfigs).toHaveBeenCalledWith('conn-1', { roots: ['C:\\App'] });
      expect(r).toMatchObject({ data: { files: [] } });
    });
  });

  describe('POST /apply', () => {
    it('returns applied=true on success', async () => {
      await setup('conn-1');
      vi.mocked(service.apply).mockResolvedValueOnce({ applied: true, testResult: { ok: true, latencyMs: 12 } });
      const dto = { driver: 'sqlserver', host: 'h', port: 1433, instance: null,
        database: 'd', user: 'u', password: 'p' } as any;
      const r = await controller.apply(42, dto);
      expect(r).toMatchObject({ data: { applied: true } });
    });

    it('returns applied=false with testResult on auth failure', async () => {
      await setup('conn-1');
      vi.mocked(service.apply).mockResolvedValueOnce({
        applied: false, testResult: { ok: false, code: 'auth', message: 'Login failed' },
      });
      const r = await controller.apply(42, {} as any);
      expect(r).toMatchObject({ data: { applied: false, testResult: { ok: false, code: 'auth' } } });
    });

    it('maps WS timeout post-bootstrap to 504', async () => {
      await setup('conn-1');
      vi.mocked(service.apply).mockRejectedValueOnce(new Error('Synced heartbeat not received within 15000ms'));
      await expect(controller.apply(42, {} as any)).rejects.toMatchObject({ status: 504 });
    });
  });
});
```

- [ ] **Step 7.3: Implementar**

```ts
import {
  Body, Controller, HttpException, HttpStatus, Param, ParseIntPipe, Post,
} from '@nestjs/common';

import { ProbeDiscoveryApplyDto } from '../dtos/probe-discovery-apply.dto';
import { ProbeDiscoveryScanConfigsDto } from '../dtos/probe-discovery-scan-configs.dto';
import { ReadinessOverviewRepository } from '../repositories/readiness-overview.repository';
import { ProbeDiscoveryService } from '../services/probe-discovery.service';
import type { IProbeDiscoveryCandidate } from '../interfaces/probe-discovery.interface';

@Controller('/pharma-agent-catalog/companies/:companyId/setup/probe-discovery')
export class ProbeDiscoveryController {
  constructor(
    private readonly service: ProbeDiscoveryService,
    private readonly readinessRepo: ReadinessOverviewRepository,
  ) {}

  @Post('discover')
  async discover(@Param('companyId', ParseIntPipe) companyId: number) {
    const connectorId = await this.resolveConnectorId(companyId);
    try {
      const result = await this.service.discover(connectorId);
      return { data: result };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  @Post('scan-configs')
  async scanConfigs(
    @Param('companyId', ParseIntPipe) companyId: number,
    @Body() dto: ProbeDiscoveryScanConfigsDto,
  ) {
    const connectorId = await this.resolveConnectorId(companyId);
    try {
      const result = await this.service.scanConfigs(connectorId, dto);
      return { data: result };
    } catch (err) {
      throw this.mapError(err);
    }
  }

  @Post('apply')
  async apply(
    @Param('companyId', ParseIntPipe) companyId: number,
    @Body() dto: ProbeDiscoveryApplyDto,
  ) {
    const connectorId = await this.resolveConnectorId(companyId);
    const candidate: IProbeDiscoveryCandidate = {
      driver: dto.driver as IProbeDiscoveryCandidate['driver'],
      host: dto.host,
      port: dto.port,
      instance: dto.instance ?? null,
      database: dto.database,
      user: dto.user,
      password: dto.password,
      trustServerCertificate: dto.trustServerCertificate ?? false,
    };
    try {
      const result = await this.service.apply(connectorId, candidate);
      // Defesa em profundidade: zerar password no body recebido antes do GC.
      (dto as Record<string, unknown>).password = undefined;
      return { data: result };
    } catch (err) {
      (dto as Record<string, unknown>).password = undefined;
      throw this.mapError(err);
    }
  }

  private async resolveConnectorId(companyId: number): Promise<string> {
    const readiness = await this.readinessRepo.findByCompanyId(companyId);
    const connectorId = readiness?.connector?.id;
    if (!connectorId) {
      throw new HttpException(
        { error: 'connector_not_found', message: 'No connector registered for this company' },
        HttpStatus.FAILED_DEPENDENCY,
      );
    }
    return connectorId;
  }

  private mapError(err: unknown): HttpException {
    if (err instanceof HttpException) return err;
    const e = err as { name?: string; message?: string };
    if (e?.name === 'ConnectorOfflineError') {
      return new HttpException(
        { error: 'connector_offline', message: e.message ?? 'Connector is offline' },
        HttpStatus.FAILED_DEPENDENCY,
      );
    }
    if (typeof e?.message === 'string' && /timed out|not received/i.test(e.message)) {
      return new HttpException(
        { error: 'agent_timeout', message: e.message },
        HttpStatus.GATEWAY_TIMEOUT,
      );
    }
    return new HttpException(
      { error: 'internal_error', message: 'Probe discovery failed' },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}
```

- [ ] **Step 7.4: Rodar testes**

```bash
pnpm test src/modules/pharma-agent-catalog/controllers/probe-discovery.controller.test.ts
```

- [ ] **Step 7.5: Commit**

```bash
git add src/modules/pharma-agent-catalog/controllers/probe-discovery.controller.ts \
        src/modules/pharma-agent-catalog/controllers/probe-discovery.controller.test.ts
git commit -m "feat(neo): controller probe-discovery com 3 endpoints"
```

---

## Task 8: Registrar controller + service no module

**Files:**
- Modify: `src/modules/pharma-agent-catalog/pharma-agent-catalog.module.ts`

- [ ] **Step 8.1: Adicionar import e providers/controllers**

Localizar o `@Module({...})` decorator. Adicionar:

```ts
import { ProbeDiscoveryController } from './controllers/probe-discovery.controller';
import { ProbeDiscoveryService } from './services/probe-discovery.service';
// ...

@Module({
  imports: [ /* existentes — provavelmente AgentIdentitiesModule */ ],
  controllers: [
    // ...existentes...
    ProbeDiscoveryController,
  ],
  providers: [
    // ...existentes...
    ProbeDiscoveryService,
  ],
})
export class PharmaAgentCatalogModule {}
```

`ReadinessOverviewRepository` e `AgentConnectorWebSocketAdapter` provavelmente já estão no módulo (verificar).

- [ ] **Step 8.2: Verificar TS build**

```bash
pnpm tsc --noEmit
```

- [ ] **Step 8.3: Rodar testes do módulo**

```bash
pnpm test src/modules/pharma-agent-catalog
```

Expected: 0 falhas.

- [ ] **Step 8.4: Commit**

```bash
git add src/modules/pharma-agent-catalog/pharma-agent-catalog.module.ts
git commit -m "feat(neo): registra ProbeDiscoveryController e Service no modulo"
```

---

## Task 9: Feature flag gating (opcional via env)

**Files:**
- Modify: `src/modules/pharma-agent-catalog/controllers/probe-discovery.controller.ts`

- [ ] **Step 9.1: Inspecionar padrão de feature flag existente**

```bash
grep -rn "featureFlag\|isFeatureEnabled\|FeatureFlagService" src/ | head -10
```

Se existir um `FeatureFlagService` injetável: usar. Senão: ler env var `FEATURE_PROBE_DRIVEN_SETUP` (boolean) e cercar os 3 endpoints com:

```ts
private assertFeatureEnabled(companyId: number): void {
  // Padrão real depende do Neo. Se houver FeatureFlagService:
  // if (!this.featureFlags.isEnabled('feature_probe_driven_setup', { companyId })) {
  //   throw new NotFoundException();
  // }
  // Stub simples por env var enquanto não há FeatureFlagService:
  if (process.env.FEATURE_PROBE_DRIVEN_SETUP !== 'true') {
    throw new HttpException(
      { error: 'feature_disabled', message: 'Probe-driven setup is not enabled' },
      HttpStatus.NOT_FOUND,
    );
  }
}
```

Chamar `this.assertFeatureEnabled(companyId)` no início dos 3 endpoints, antes de `resolveConnectorId`.

- [ ] **Step 9.2: Atualizar testes**

Adicionar `process.env.FEATURE_PROBE_DRIVEN_SETUP = 'true'` em `beforeEach` (e `delete process.env.FEATURE_PROBE_DRIVEN_SETUP` em `afterEach`). Adicionar teste:

```ts
it('returns 404 when feature flag disabled', async () => {
  delete process.env.FEATURE_PROBE_DRIVEN_SETUP;
  await setup('conn-1');
  await expect(controller.discover(42)).rejects.toMatchObject({ status: 404 });
});
```

- [ ] **Step 9.3: Rodar testes**

```bash
pnpm test src/modules/pharma-agent-catalog/controllers/probe-discovery.controller.test.ts
```

- [ ] **Step 9.4: Commit**

```bash
git add src/modules/pharma-agent-catalog/controllers/probe-discovery.controller.ts \
        src/modules/pharma-agent-catalog/controllers/probe-discovery.controller.test.ts
git commit -m "feat(neo): gate de feature flag para probe discovery endpoints"
```

---

## Task 10: README do módulo

**Files:**
- Modify: `src/modules/pharma-agent-catalog/README.md`

- [ ] **Step 10.1: Adicionar seção de endpoints**

Adicionar ao final do README existente:

```md
## Probe Discovery (setup automático)

Endpoints stateless que orquestram probes do agente para descoberta automática
de configuração de banco. Spec:
`pharma-agent-v2/docs/superpowers/specs/2026-05-28-painel-probe-driven-setup-design.md`.

Feature flag: `FEATURE_PROBE_DRIVEN_SETUP=true` (env var temporária — migrar
para FeatureFlagService quando disponível).

- `POST /pharma-agent-catalog/companies/:companyId/setup/probe-discovery/discover` — agrega 4 probes
- `POST /pharma-agent-catalog/companies/:companyId/setup/probe-discovery/scan-configs` — varre dirs (opcional)
- `POST /pharma-agent-catalog/companies/:companyId/setup/probe-discovery/apply` — test + bootstrap

Erros: `424` (conector offline), `504` (agente timeout), `404` (flag off ou
conector inexistente).
```

- [ ] **Step 10.2: Commit**

```bash
git add src/modules/pharma-agent-catalog/README.md
git commit -m "docs(neo): documenta endpoints de probe discovery no README do modulo"
```

---

## Verificação final

- [ ] **Step F.1: Suite completa**

```bash
pnpm test
```

Expected: 0 falhas.

- [ ] **Step F.2: Build**

```bash
pnpm build
```

Expected: 0 erros.

- [ ] **Step F.3: Git log**

```bash
git log --oneline -12
```

Expected: 10 commits criados, prontos pra PR.

- [ ] **Step F.4: Abrir PR**

```bash
gh pr create --title "feat(neo): endpoints de probe-driven setup" \
  --body "Implementa Tasks 1-10 do plano em pharma-agent-v2/docs/superpowers/plans/2026-05-28-neo-probe-discovery-endpoints.md. Spec em pharma-agent-v2/docs/superpowers/specs/2026-05-28-painel-probe-driven-setup-design.md."
```
