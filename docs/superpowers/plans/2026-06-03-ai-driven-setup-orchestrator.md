# AI-Driven Setup — Orquestrador (neo): Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar no `neo-api-pharmachatbot` o orquestrador de IA do setup dirigido por IA (Contratos 1–3 da spec `2026-06-03-setup-dirigido-por-ia-design.md`): um loop agentic com Claude (Anthropic SDK) que escolhe ferramentas read-only de um catálogo anunciado pelo agente (`pharma-agent-v2`), invoca essas ferramentas via WebSocket (`tool.invoke` → `tool.result`), e ao final monta um `ValidatedMappingConfig` (formato `IConnectorCatalogMappingConfig` já consumido pelo poller) e o propõe (`mapping.proposed`). Um gateway socket.io novo relaya `audit.event`/`ai.session.state`/`mapping.proposed` para a sala da company e recebe `mapping.decision`/`ai.session.abort` do web (o web entra na sala via `company`); a sessão é iniciada por um POST REST (gatilho único), não pelo socket.

**Architecture:** O agente (já conectado no WS `/connectors/ws` autenticado, gerido por `AgentConnectorWebSocketAdapter`) é host de ferramentas read-only. O neo (este plano) roda o cérebro: (1) `AiSessionConnectorBridge` estende o canal WS agente↔neo com os envelopes `ai.session.start`/`tool.invoke`/`mapping.decision`/`ai.session.abort` (neo→agente) e `ai.catalog`/`tool.result`/`audit.event`/`mapping.proposed`/`ai.session.state` (agente→neo), modelando o padrão `pendingProbeRequests` + handlers por tipo já existentes no adapter; (2) `AnthropicMessagesClient` (wrapper mockável) chama a Messages API com prompt caching no system prompt + tool use; (3) `CatalogToToolsTranslator` mapeia `ToolDescriptor[]` → `tools` da Messages API; (4) `AiSetupOrchestratorService` roda o loop agentic com guardas anti-runaway; (5) `AiSetupGateway` (socket.io, padrão `TicketGateway` + `RedisIoAdapter`) é o relé para o web (join por `company`; recebe só `mapping.decision`/`ai.session.abort`); (6) `AiSetupController` (company-scoped, `pharma-agent-catalog/companies/:companyId/ai-setup`) expõe o POST que é o gatilho único da sessão (resolve o connector ativo internamente) + GET de estado; (7) `AiSetupModule` cabos tudo.

**Tech Stack:** NestJS, TypeScript, socket.io, @anthropic-ai/sdk, vitest

---

## File Structure

Todos os caminhos relativos à raiz do repo `neo-api-pharmachatbot`.

| Caminho | Responsabilidade |
|---|---|
| `src/modules/ai-setup/constants/ai-setup-protocol.constants.ts` | Constantes dos tipos de envelope WS (`AI_SESSION_START_MESSAGE_TYPE`, `TOOL_INVOKE_MESSAGE_TYPE`, `MAPPING_DECISION_MESSAGE_TYPE`, `AI_SESSION_ABORT_MESSAGE_TYPE`, `AI_CATALOG_MESSAGE_TYPE`, `TOOL_RESULT_MESSAGE_TYPE`, `AUDIT_EVENT_MESSAGE_TYPE`, `MAPPING_PROPOSED_MESSAGE_TYPE`, `AI_SESSION_STATE_MESSAGE_TYPE`), timeouts (`AI_TOOL_INVOKE_TIMEOUT_MS`), e nomes do catálogo canônico (`AI_SETUP_TOOL_NAMES`). |
| `src/modules/ai-setup/constants/ai-setup-orchestrator.constants.ts` | Limites anti-runaway (`AI_SESSION_MAX_INVOCATIONS`, `AI_SESSION_TIMEOUT_MS`), modelo (`AI_SETUP_DEFAULT_MODEL`), env keys (`ANTHROPIC_API_KEY_ENV`, `ANTHROPIC_MODEL_ENV`), e `AI_SETUP_SYSTEM_PROMPT`. |
| `src/modules/ai-setup/interfaces/ai-setup-protocol.interface.ts` | DTOs dos envelopes: `IToolDescriptor`, `IAiCatalogMessage`, `IToolResultMessage`, `IAuditEventMessage`, `IAiSessionStateMessage`, `IMappingProposedMessage`, `AiSessionPhase`. |
| `src/modules/ai-setup/interfaces/ai-session-bridge.interface.ts` | `IAiSessionBridgeEvents` (formato dos eventos emitidos pelo bridge: `catalog`, `audit`, `state`, `mapping`). |
| `src/modules/ai-setup/gateways/ai-session-connector-bridge.ts` | `AiSessionConnectorBridge`: envia envelopes neo→agente via `AgentConnectorWebSocketAdapter` (reusa `sendRawToConnector` exposto), correlaciona `tool.invoke`↔`tool.result` por `invocationId` (padrão `pendingProbeRequests`), e re-emite `ai.catalog`/`audit.event`/`mapping.proposed`/`ai.session.state` como eventos do `EventEmitter`. |
| `src/modules/ai-setup/services/anthropic-messages.client.ts` | `AnthropicMessagesClient` (wrapper injetável do `@anthropic-ai/sdk`): `createMessage(params)` com prompt caching no system + tools. Token de DI `ANTHROPIC_MESSAGES_CLIENT` para mock. |
| `src/modules/ai-setup/services/catalog-to-tools.translator.ts` | `CatalogToToolsTranslator.translate(tools: IToolDescriptor[]): Anthropic.Tool[]` (name/description/input_schema). |
| `src/modules/ai-setup/services/ai-setup-orchestrator.service.ts` | `AiSetupOrchestratorService.runSession(...)`: loop agentic, guardas anti-runaway, monta `IConnectorCatalogMappingConfig` e dispara `mapping.proposed` no bridge. |
| `src/modules/ai-setup/gateways/ai-setup.gateway.ts` | `AiSetupGateway` socket.io: `@SubscribeMessage('company')` (join na sala `company:{id}`, espelhando `TicketGateway`) + `@SubscribeMessage('mapping.decision'\|'ai.session.abort')` do web (SEM `ai.session.start` — o gatilho da sessão é o POST REST); `emitAuditEvent`/`emitSessionState`/`emitMappingProposed` para `company:{id}`. |
| `src/modules/ai-setup/controllers/ai-setup.controller.ts` | `AiSetupController extends BaseController` (`@Controller('pharma-agent-catalog/companies/:companyId/ai-setup')`): `POST .../sessions` (ÚNICO gatilho da sessão — resolve o connector ativo da company, registra no registry, dispara `ai.session.start` ao agente via bridge e inicia o loop do orchestrator) e `GET .../sessions/:sessionId` (estado), envelope `ok()`. |
| `src/modules/ai-setup/services/ai-setup-session.registry.ts` | `AiSetupSessionRegistry`: estado em memória das sessões ativas (`sessionId` → `{ companyId, connectorId, phase }`) p/ o controller consultar e o gateway rotear decisões. |
| `src/modules/ai-setup/ai-setup.module.ts` | `AiSetupModule`: providers/controllers/exports, importa `AgentIdentitiesModule` (p/ `AgentConnectorWebSocketAdapter`) e `RedisModule`/`ConfigModule`. |
| `src/modules/ai-setup/**/*.test.ts` | Testes unit (vitest). |
| `src/modules/ai-setup/**/*.int.test.ts` | Testes de integração (vitest + socket.io-client + ws mock). |

---

## Task 1 — Dependência `@anthropic-ai/sdk` + constantes de protocolo

**Objetivo:** Adicionar a dependência e cravar as constantes do Contrato 2 (nomes de envelope) e do catálogo canônico (Contrato 1).

### 1.1 Instalar a dependência

```bash
pnpm add @anthropic-ai/sdk
```

Saída esperada: `@anthropic-ai/sdk` aparece em `dependencies` do `package.json` e em `pnpm-lock.yaml`.

### 1.2 Write failing test

Crie `src/modules/ai-setup/constants/ai-setup-protocol.constants.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import {
  AI_CATALOG_MESSAGE_TYPE,
  AI_SESSION_ABORT_MESSAGE_TYPE,
  AI_SESSION_START_MESSAGE_TYPE,
  AI_SESSION_STATE_MESSAGE_TYPE,
  AI_SETUP_TOOL_NAMES,
  AI_TOOL_INVOKE_TIMEOUT_MS,
  AUDIT_EVENT_MESSAGE_TYPE,
  MAPPING_DECISION_MESSAGE_TYPE,
  MAPPING_PROPOSED_MESSAGE_TYPE,
  TOOL_INVOKE_MESSAGE_TYPE,
  TOOL_RESULT_MESSAGE_TYPE,
} from './ai-setup-protocol.constants';

const SUT = 'ai-setup-protocol-constants';

describe(`Teste Unitário: ${SUT}`, () => {
  it('usa exatamente os nomes de envelope do Contrato 2', () => {
    expect(AI_SESSION_START_MESSAGE_TYPE).toBe('ai.session.start');
    expect(TOOL_INVOKE_MESSAGE_TYPE).toBe('tool.invoke');
    expect(MAPPING_DECISION_MESSAGE_TYPE).toBe('mapping.decision');
    expect(AI_SESSION_ABORT_MESSAGE_TYPE).toBe('ai.session.abort');
    expect(AI_CATALOG_MESSAGE_TYPE).toBe('ai.catalog');
    expect(TOOL_RESULT_MESSAGE_TYPE).toBe('tool.result');
    expect(AUDIT_EVENT_MESSAGE_TYPE).toBe('audit.event');
    expect(MAPPING_PROPOSED_MESSAGE_TYPE).toBe('mapping.proposed');
    expect(AI_SESSION_STATE_MESSAGE_TYPE).toBe('ai.session.state');
  });

  it('lista o catálogo canônico de 14 ferramentas read-only', () => {
    expect(AI_SETUP_TOOL_NAMES).toEqual([
      'probe.engines',
      'probe.odbc_dsns',
      'probe.processes',
      'probe.connections',
      'probe.network',
      'probe.scan_config_dirs',
      'fs.readConfigFile',
      'registry.readKey',
      'probe.test_connection',
      'schema.listTables',
      'schema.describeTable',
      'schema.listForeignKeys',
      'schema.sampleRows',
      'sql.runReadOnlySelect',
    ]);
  });

  it('define timeout positivo para tool.invoke', () => {
    expect(AI_TOOL_INVOKE_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
```

### 1.3 Run (espera FAIL)

```bash
pnpm run vitest:unit src/modules/ai-setup/constants/ai-setup-protocol.constants.test.ts
```

Saída esperada: falha de resolução do módulo `./ai-setup-protocol.constants` (arquivo ainda não existe).

### 1.4 Implementação mínima

Crie `src/modules/ai-setup/constants/ai-setup-protocol.constants.ts`:

```typescript
// Contrato 2 — envelopes WS neo <-> agente (setup dirigido por IA).

// neo -> agente
export const AI_SESSION_START_MESSAGE_TYPE = 'ai.session.start';
export const TOOL_INVOKE_MESSAGE_TYPE = 'tool.invoke';
export const MAPPING_DECISION_MESSAGE_TYPE = 'mapping.decision';
export const AI_SESSION_ABORT_MESSAGE_TYPE = 'ai.session.abort';

// agente -> neo
export const AI_CATALOG_MESSAGE_TYPE = 'ai.catalog';
export const TOOL_RESULT_MESSAGE_TYPE = 'tool.result';
export const AUDIT_EVENT_MESSAGE_TYPE = 'audit.event';
export const MAPPING_PROPOSED_MESSAGE_TYPE = 'mapping.proposed';
export const AI_SESSION_STATE_MESSAGE_TYPE = 'ai.session.state';

// Timeout de correlacao tool.invoke <-> tool.result.
export const AI_TOOL_INVOKE_TIMEOUT_MS = 30_000;

// Contrato 1 — catalogo canonico de ferramentas read-only anunciadas em ai.catalog.
export const AI_SETUP_TOOL_NAMES = [
  'probe.engines',
  'probe.odbc_dsns',
  'probe.processes',
  'probe.connections',
  'probe.network',
  'probe.scan_config_dirs',
  'fs.readConfigFile',
  'registry.readKey',
  'probe.test_connection',
  'schema.listTables',
  'schema.describeTable',
  'schema.listForeignKeys',
  'schema.sampleRows',
  'sql.runReadOnlySelect',
] as const;

export type AiSetupToolName = (typeof AI_SETUP_TOOL_NAMES)[number];
```

Crie `src/modules/ai-setup/constants/ai-setup-orchestrator.constants.ts`:

```typescript
export const ANTHROPIC_API_KEY_ENV = 'ANTHROPIC_API_KEY';
export const ANTHROPIC_MODEL_ENV = 'AI_SETUP_ANTHROPIC_MODEL';

// Modelo default; sobrescrevivel via AI_SETUP_ANTHROPIC_MODEL (ex.: claude-sonnet-4-6).
export const AI_SETUP_DEFAULT_MODEL = 'claude-opus-4-8';

export const AI_SETUP_MAX_TOKENS = 8_192;

// Guardas anti-runaway.
export const AI_SESSION_MAX_INVOCATIONS = 60;
export const AI_SESSION_TIMEOUT_MS = 300_000;

export const AI_SETUP_SYSTEM_PROMPT = [
  'Você é o orquestrador de setup do PharmaConnector. Conduza, passo a passo e SOMENTE com as',
  'ferramentas read-only do catálogo, a descoberta do banco do PDV: identifique o engine, ache',
  'e valide credenciais, inspecione o schema (tabelas, colunas, FKs, amostras) e monte um SELECT',
  'com JOINs que una produtos espalhados em múltiplas tabelas. Você NUNCA executa escrita.',
  'Ao concluir, chame a ferramenta "emit_mapping" UMA vez com o ValidatedMappingConfig final',
  '(snapshotQuery ou incrementalQuery + fields canônicos + syncMode/cursor) e o rationale.',
].join(' ');
```

### 1.5 Run (espera PASS)

```bash
pnpm run vitest:unit src/modules/ai-setup/constants/ai-setup-protocol.constants.test.ts
```

Saída esperada: 3 testes passam.

### 1.6 Commit

```bash
git add package.json pnpm-lock.yaml src/modules/ai-setup/constants/
git commit -m "feat(ai-setup): adiciona @anthropic-ai/sdk e constantes do protocolo de setup por IA

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2 — Interfaces dos envelopes do Contrato 2

**Objetivo:** Cravar os DTOs `IToolDescriptor`, `IAiCatalogMessage`, `IToolResultMessage`, `IAuditEventMessage`, `IAiSessionStateMessage`, `IMappingProposedMessage` e o tipo `AiSessionPhase`.

### 2.1 Write failing test

Crie `src/modules/ai-setup/interfaces/ai-setup-protocol.interface.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import type {
  AiSessionPhase,
  IAiCatalogMessage,
  IAuditEventMessage,
  IMappingProposedMessage,
  IToolDescriptor,
  IToolResultMessage,
} from './ai-setup-protocol.interface';

const SUT = 'ai-setup-protocol-interface';

describe(`Teste Unitário: ${SUT}`, () => {
  it('aceita um ToolDescriptor com name/description/inputSchema/outputSchema', () => {
    const descriptor: IToolDescriptor = {
      name: 'probe.engines',
      description: 'Lista engines de banco instalados',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object', properties: {} },
    };
    expect(descriptor.name).toBe('probe.engines');
  });

  it('aceita ai.catalog com tools e catalogVersion', () => {
    const catalog: IAiCatalogMessage = {
      type: 'ai.catalog',
      sessionId: 's1',
      catalogVersion: '1',
      tools: [],
    };
    expect(catalog.catalogVersion).toBe('1');
  });

  it('aceita tool.result ok=false com errorCode', () => {
    const result: IToolResultMessage = {
      type: 'tool.result',
      sessionId: 's1',
      invocationId: 'inv1',
      ok: false,
      errorCode: 'auth',
    };
    expect(result.ok).toBe(false);
  });

  it('aceita audit.event com seq/at/kind/summary', () => {
    const audit: IAuditEventMessage = {
      type: 'audit.event',
      sessionId: 's1',
      seq: 1,
      at: new Date().toISOString(),
      kind: 'tool_invoked',
      tool: 'probe.engines',
      summary: 'Probing engines',
    };
    expect(audit.seq).toBe(1);
  });

  it('aceita mapping.proposed com mapping/rationale/previewRows', () => {
    const proposed: IMappingProposedMessage = {
      type: 'mapping.proposed',
      sessionId: 's1',
      mapping: {
        mappingVersion: 'v1',
        selectedProductTable: 'produtos',
        syncMode: 'snapshot',
        pollIntervalMs: 300_000,
        batchSize: 100,
        snapshotQuery: 'SELECT p.codigo FROM produtos p',
        fields: { sourceProductCode: 'codigo', name: 'nome' },
      },
      rationale: 'JOIN entre produtos e desconto_produtos',
      previewRows: [],
    };
    expect(proposed.mapping.syncMode).toBe('snapshot');
  });

  it('restringe AiSessionPhase às fases do contrato', () => {
    const phases: AiSessionPhase[] = [
      'discovering',
      'credentials',
      'schema',
      'proposing',
      'applying',
      'synced',
      'failed',
      'aborted',
    ];
    expect(phases).toHaveLength(8);
  });
});
```

### 2.2 Run (espera FAIL)

```bash
pnpm run vitest:unit src/modules/ai-setup/interfaces/ai-setup-protocol.interface.test.ts
```

Saída esperada: falha de resolução do módulo `./ai-setup-protocol.interface`.

### 2.3 Implementação mínima

Crie `src/modules/ai-setup/interfaces/ai-setup-protocol.interface.ts`:

```typescript
import type { IConnectorCatalogMappingConfig } from '@modules/pharma-agent-catalog/interfaces/connector-catalog-config-payload.interface';

export type AiSessionPhase =
  | 'discovering'
  | 'credentials'
  | 'schema'
  | 'proposing'
  | 'applying'
  | 'synced'
  | 'failed'
  | 'aborted';

export interface IToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface IAiCatalogMessage {
  type: 'ai.catalog';
  sessionId: string;
  catalogVersion: string;
  tools: IToolDescriptor[];
}

export interface IToolResultMessage {
  type: 'tool.result';
  sessionId: string;
  invocationId: string;
  ok: boolean;
  payload?: unknown;
  errorCode?: string;
}

export interface IAuditEventMessage {
  type: 'audit.event';
  sessionId: string;
  seq: number;
  at: string;
  kind: string;
  tool?: string;
  summary: string;
  detail?: unknown;
}

export interface IAiSessionStateMessage {
  type: 'ai.session.state';
  sessionId: string;
  phase: AiSessionPhase;
}

export interface IMappingProposedMessage {
  type: 'mapping.proposed';
  sessionId: string;
  mapping: IConnectorCatalogMappingConfig;
  rationale: string;
  previewRows: Array<Record<string, unknown>>;
}
```

### 2.4 Run (espera PASS)

```bash
pnpm run vitest:unit src/modules/ai-setup/interfaces/ai-setup-protocol.interface.test.ts
```

Saída esperada: 6 testes passam.

### 2.5 Commit

```bash
git add src/modules/ai-setup/interfaces/
git commit -m "feat(ai-setup): define DTOs dos envelopes do Contrato 2

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3 — Expor envio cru no `AgentConnectorWebSocketAdapter`

**Objetivo:** O bridge precisa enviar mensagens arbitrárias por connector reusando o socket já autenticado. Adicionar `sendRawToConnector(connectorId, message)` ao adapter (sem duplicar a lógica de `connectedSockets`), preservando o padrão de `ConflictException` quando offline.

### 3.1 Write failing test (unit)

Crie `src/modules/agent-identities/gateways/agent-connector-websocket.adapter.send-raw.test.ts`:

```typescript
import { ConflictException } from '@/common/exceptions/app.exception';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { AgentConnectorWebSocketAdapter } from './agent-connector-websocket.adapter';

vi.mock('@/common/utils/enhanced-logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SUT = 'agent-connector-websocket-adapter-send-raw';

function makeAdapter(): AgentConnectorWebSocketAdapter {
  return new AgentConnectorWebSocketAdapter(
    { httpAdapter: null } as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe(`Teste Unitário: ${SUT}`, () => {
  afterEach(() => vi.clearAllMocks());

  it('envia a mensagem serializada quando o connector está OPEN', () => {
    const adapter = makeAdapter();
    const send = vi.fn();
    const fakeWs = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
    // injeta socket conectado via API pública de teste
    (adapter as unknown as { connectedSockets: Map<string, unknown> }).connectedSockets.set(
      'conn-1',
      fakeWs,
    );

    adapter.sendRawToConnector('conn-1', { type: 'ai.session.start', sessionId: 's1' });

    expect(send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'ai.session.start', sessionId: 's1' }),
    );
  });

  it('lança ConflictException quando o connector não está conectado', () => {
    const adapter = makeAdapter();
    expect(() => adapter.sendRawToConnector('missing', { type: 'x' })).toThrow(ConflictException);
  });
});
```

### 3.2 Run (espera FAIL)

```bash
pnpm run vitest:unit src/modules/agent-identities/gateways/agent-connector-websocket.adapter.send-raw.test.ts
```

Saída esperada: `adapter.sendRawToConnector is not a function`.

### 3.3 Implementação mínima

Em `src/modules/agent-identities/gateways/agent-connector-websocket.adapter.ts`, adicione o método público (logo após `pushBootstrapDbConfig`, que segue o mesmo padrão de checagem de socket):

```typescript
  public sendRawToConnector(connectorId: string, message: Record<string, unknown>): void {
    const ws = this.connectedSockets.get(connectorId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new ConflictException(`Connector ${connectorId} is not connected`);
    }

    ws.send(JSON.stringify(message));

    logger.info(
      {
        module: MODULE,
        action: 'agent_connector_ai_setup_message_sent',
        connectorId,
        messageType: typeof message.type === 'string' ? message.type : undefined,
      },
      'Mensagem de setup por IA enviada ao conector',
    );
  }
```

### 3.4 Run (espera PASS)

```bash
pnpm run vitest:unit src/modules/agent-identities/gateways/agent-connector-websocket.adapter.send-raw.test.ts
```

Saída esperada: 2 testes passam.

### 3.5 Commit

```bash
git add src/modules/agent-identities/gateways/agent-connector-websocket.adapter.ts \
        src/modules/agent-identities/gateways/agent-connector-websocket.adapter.send-raw.test.ts
git commit -m "feat(ai-setup): expõe sendRawToConnector no adapter de WS de conectores

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4 — `AiSessionConnectorBridge`: roteia envelopes neo↔agente

**Objetivo:** Centralizar o canal agente↔neo do setup por IA: enviar `ai.session.start`/`tool.invoke`/`mapping.decision`/`ai.session.abort`; correlacionar `tool.invoke`↔`tool.result` por `invocationId` com timeout (padrão `pendingProbeRequests`); re-emitir `ai.catalog`/`audit.event`/`mapping.proposed`/`ai.session.state` como eventos do `EventEmitter`. O bridge consome mensagens cruas do agente assinando o evento `'ai-setup-message'` que o adapter emite (Task 5 fará o adapter emitir esse evento; aqui o bridge expõe `handleAgentMessage` para teste direto).

### 4.1 Write failing test (unit)

Crie `src/modules/ai-setup/gateways/ai-session-connector-bridge.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiSessionConnectorBridge } from './ai-session-connector-bridge';

vi.mock('@/common/utils/enhanced-logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SUT = 'ai-session-connector-bridge';

describe(`Teste Unitário: ${SUT}`, () => {
  let sendRaw: ReturnType<typeof vi.fn>;
  let adapter: { sendRawToConnector: typeof sendRaw };
  let bridge: AiSessionConnectorBridge;

  beforeEach(() => {
    sendRaw = vi.fn();
    adapter = { sendRawToConnector: sendRaw };
    bridge = new AiSessionConnectorBridge(adapter as never);
  });

  afterEach(() => vi.clearAllMocks());

  it('startSession envia ai.session.start ao agente', () => {
    bridge.startSession('conn-1', 's1');
    expect(sendRaw).toHaveBeenCalledWith('conn-1', {
      type: 'ai.session.start',
      sessionId: 's1',
    });
  });

  it('invokeTool envia tool.invoke e resolve quando chega tool.result ok', async () => {
    const pending = bridge.invokeTool('conn-1', 's1', 'probe.engines', { foo: 1 }, 1_000);

    const sent = sendRaw.mock.calls[0][1] as {
      type: string;
      invocationId: string;
      name: string;
      input: unknown;
    };
    expect(sent.type).toBe('tool.invoke');
    expect(sent.name).toBe('probe.engines');
    expect(sent.input).toEqual({ foo: 1 });

    bridge.handleAgentMessage('conn-1', {
      type: 'tool.result',
      sessionId: 's1',
      invocationId: sent.invocationId,
      ok: true,
      payload: { engines: ['mysql'] },
    });

    await expect(pending).resolves.toEqual({
      ok: true,
      payload: { engines: ['mysql'] },
    });
  });

  it('invokeTool resolve com ok=false e errorCode preservado', async () => {
    const pending = bridge.invokeTool('conn-1', 's1', 'probe.test_connection', {}, 1_000);
    const sent = sendRaw.mock.calls[0][1] as { invocationId: string };

    bridge.handleAgentMessage('conn-1', {
      type: 'tool.result',
      sessionId: 's1',
      invocationId: sent.invocationId,
      ok: false,
      errorCode: 'auth',
    });

    await expect(pending).resolves.toEqual({ ok: false, errorCode: 'auth' });
  });

  it('invokeTool rejeita por timeout quando nenhuma resposta chega', async () => {
    await expect(
      bridge.invokeTool('conn-1', 's1', 'probe.engines', {}, 20),
    ).rejects.toThrow(/timed out/);
  });

  it('re-emite ai.catalog, audit.event, ai.session.state e mapping.proposed', () => {
    const catalog = vi.fn();
    const audit = vi.fn();
    const state = vi.fn();
    const mapping = vi.fn();
    bridge.on('catalog', catalog);
    bridge.on('audit', audit);
    bridge.on('state', state);
    bridge.on('mapping', mapping);

    bridge.handleAgentMessage('conn-1', {
      type: 'ai.catalog',
      sessionId: 's1',
      catalogVersion: '1',
      tools: [],
    });
    bridge.handleAgentMessage('conn-1', {
      type: 'audit.event',
      sessionId: 's1',
      seq: 1,
      at: '2026-06-03T00:00:00Z',
      kind: 'tool_invoked',
      summary: 'x',
    });
    bridge.handleAgentMessage('conn-1', {
      type: 'ai.session.state',
      sessionId: 's1',
      phase: 'discovering',
    });
    bridge.handleAgentMessage('conn-1', {
      type: 'mapping.proposed',
      sessionId: 's1',
      mapping: {
        mappingVersion: 'v1',
        selectedProductTable: 'produtos',
        syncMode: 'snapshot',
        pollIntervalMs: 1,
        batchSize: 1,
        snapshotQuery: 'SELECT 1',
        fields: { sourceProductCode: 'codigo', name: 'nome' },
      },
      rationale: 'r',
      previewRows: [],
    });

    expect(catalog).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledOnce();
    expect(state).toHaveBeenCalledOnce();
    expect(mapping).toHaveBeenCalledOnce();
  });

  it('decision e abort enviam os envelopes corretos ao agente', () => {
    bridge.sendDecision('conn-1', 's1', 'approve');
    bridge.abortSession('conn-1', 's1', 'user_cancelled');
    expect(sendRaw).toHaveBeenCalledWith('conn-1', {
      type: 'mapping.decision',
      sessionId: 's1',
      decision: 'approve',
    });
    expect(sendRaw).toHaveBeenCalledWith('conn-1', {
      type: 'ai.session.abort',
      sessionId: 's1',
      reason: 'user_cancelled',
    });
  });
});
```

### 4.2 Run (espera FAIL)

```bash
pnpm run vitest:unit src/modules/ai-setup/gateways/ai-session-connector-bridge.test.ts
```

Saída esperada: falha de resolução do módulo `./ai-session-connector-bridge`.

### 4.3 Implementação mínima

Crie `src/modules/ai-setup/interfaces/ai-session-bridge.interface.ts`:

```typescript
export interface IToolInvocationResult {
  ok: boolean;
  payload?: unknown;
  errorCode?: string;
}
```

Crie `src/modules/ai-setup/gateways/ai-session-connector-bridge.ts`:

```typescript
import { EventEmitter } from 'node:events';

import { Injectable } from '@nestjs/common';
import { v4 as uuid } from 'uuid';

import { logger } from '@/common/utils/enhanced-logger';
import { AgentConnectorWebSocketAdapter } from '@modules/agent-identities/gateways/agent-connector-websocket.adapter';

import {
  AI_CATALOG_MESSAGE_TYPE,
  AI_SESSION_ABORT_MESSAGE_TYPE,
  AI_SESSION_START_MESSAGE_TYPE,
  AI_SESSION_STATE_MESSAGE_TYPE,
  AI_TOOL_INVOKE_TIMEOUT_MS,
  AUDIT_EVENT_MESSAGE_TYPE,
  MAPPING_DECISION_MESSAGE_TYPE,
  MAPPING_PROPOSED_MESSAGE_TYPE,
  TOOL_INVOKE_MESSAGE_TYPE,
  TOOL_RESULT_MESSAGE_TYPE,
} from '../constants/ai-setup-protocol.constants';
import type { IToolInvocationResult } from '../interfaces/ai-session-bridge.interface';
import type {
  IAiCatalogMessage,
  IAiSessionStateMessage,
  IAuditEventMessage,
  IMappingProposedMessage,
  IToolResultMessage,
} from '../interfaces/ai-setup-protocol.interface';

const MODULE = 'AiSessionConnectorBridge';

interface PendingToolInvocation {
  resolve: (result: IToolInvocationResult) => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

@Injectable()
export class AiSessionConnectorBridge extends EventEmitter {
  private readonly pendingInvocations = new Map<string, PendingToolInvocation>();

  constructor(private readonly connectorAdapter: AgentConnectorWebSocketAdapter) {
    super();
  }

  startSession(connectorId: string, sessionId: string): void {
    this.connectorAdapter.sendRawToConnector(connectorId, {
      type: AI_SESSION_START_MESSAGE_TYPE,
      sessionId,
    });
  }

  invokeTool(
    connectorId: string,
    sessionId: string,
    name: string,
    input: unknown,
    timeoutMs: number = AI_TOOL_INVOKE_TIMEOUT_MS,
  ): Promise<IToolInvocationResult> {
    const invocationId = uuid();

    return new Promise<IToolInvocationResult>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingInvocations.delete(invocationId);
        logger.warn(
          { module: MODULE, action: 'ai_tool_invoke_timeout', connectorId, sessionId, name },
          'tool.invoke expirou',
        );
        reject(new Error(`tool.invoke ${name} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingInvocations.set(invocationId, { resolve, reject, timeoutHandle });

      const message: Record<string, unknown> = {
        type: TOOL_INVOKE_MESSAGE_TYPE,
        sessionId,
        invocationId,
        name,
      };
      if (input !== undefined) {
        message.input = input;
      }
      this.connectorAdapter.sendRawToConnector(connectorId, message);
    });
  }

  sendDecision(
    connectorId: string,
    sessionId: string,
    decision: 'approve' | 'reject',
    editedMapping?: unknown,
  ): void {
    const message: Record<string, unknown> = {
      type: MAPPING_DECISION_MESSAGE_TYPE,
      sessionId,
      decision,
    };
    if (editedMapping !== undefined) {
      message.editedMapping = editedMapping;
    }
    this.connectorAdapter.sendRawToConnector(connectorId, message);
  }

  abortSession(connectorId: string, sessionId: string, reason: string): void {
    this.connectorAdapter.sendRawToConnector(connectorId, {
      type: AI_SESSION_ABORT_MESSAGE_TYPE,
      sessionId,
      reason,
    });
  }

  handleAgentMessage(connectorId: string, message: { type?: string } & Record<string, unknown>): void {
    switch (message.type) {
      case TOOL_RESULT_MESSAGE_TYPE:
        this.resolveToolResult(message as unknown as IToolResultMessage);
        return;
      case AI_CATALOG_MESSAGE_TYPE:
        this.emit('catalog', { connectorId, message: message as unknown as IAiCatalogMessage });
        return;
      case AUDIT_EVENT_MESSAGE_TYPE:
        this.emit('audit', { connectorId, message: message as unknown as IAuditEventMessage });
        return;
      case AI_SESSION_STATE_MESSAGE_TYPE:
        this.emit('state', { connectorId, message: message as unknown as IAiSessionStateMessage });
        return;
      case MAPPING_PROPOSED_MESSAGE_TYPE:
        this.emit('mapping', {
          connectorId,
          message: message as unknown as IMappingProposedMessage,
        });
        return;
      default:
        return;
    }
  }

  private resolveToolResult(message: IToolResultMessage): void {
    const invocationId = typeof message.invocationId === 'string' ? message.invocationId : undefined;
    if (!invocationId) {
      return;
    }
    const pending = this.pendingInvocations.get(invocationId);
    if (!pending) {
      // Idempotencia: resultado repetido/desconhecido e ignorado.
      return;
    }
    clearTimeout(pending.timeoutHandle);
    this.pendingInvocations.delete(invocationId);
    pending.resolve({
      ok: message.ok === true,
      ...(message.payload === undefined ? {} : { payload: message.payload }),
      ...(typeof message.errorCode === 'string' ? { errorCode: message.errorCode } : {}),
    });
  }
}
```

### 4.4 Run (espera PASS)

```bash
pnpm run vitest:unit src/modules/ai-setup/gateways/ai-session-connector-bridge.test.ts
```

Saída esperada: 6 testes passam.

### 4.5 Commit

```bash
git add src/modules/ai-setup/gateways/ai-session-connector-bridge.ts \
        src/modules/ai-setup/gateways/ai-session-connector-bridge.test.ts \
        src/modules/ai-setup/interfaces/ai-session-bridge.interface.ts
git commit -m "feat(ai-setup): bridge WS neo<->agente com correlação por invocationId

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5 — Adapter emite `'ai-setup-message'` para o bridge

**Objetivo:** No `handleMessage` do `AgentConnectorWebSocketAdapter`, quando o tipo for um dos envelopes agente→neo do setup por IA (`ai.catalog`/`tool.result`/`audit.event`/`mapping.proposed`/`ai.session.state`), emitir o evento `'ai-setup-message'` com `{ connectorId, message }` (o `AiSetupModule` assina e repassa para o bridge). Reusa o `EventEmitter` que o adapter já estende.

### 5.1 Write failing test (unit)

Crie `src/modules/agent-identities/gateways/agent-connector-websocket.adapter.ai-setup-emit.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentConnectorWebSocketAdapter } from './agent-connector-websocket.adapter';

vi.mock('@/common/utils/enhanced-logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SUT = 'agent-connector-websocket-adapter-ai-setup-emit';

function makeAdapter(): AgentConnectorWebSocketAdapter {
  return new AgentConnectorWebSocketAdapter(
    { httpAdapter: null } as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

function fakeWs(connectorId: string) {
  return { connectorSession: { connectorId, storeId: 's', companyId: 1 } } as never;
}

describe(`Teste Unitário: ${SUT}`, () => {
  afterEach(() => vi.clearAllMocks());

  it('emite ai-setup-message para envelopes do agente->neo', async () => {
    const adapter = makeAdapter();
    const listener = vi.fn();
    adapter.on('ai-setup-message', listener);

    await adapter.handleMessage(
      fakeWs('conn-1'),
      Buffer.from(JSON.stringify({ type: 'ai.catalog', sessionId: 's1', catalogVersion: '1', tools: [] })),
    );

    expect(listener).toHaveBeenCalledWith({
      connectorId: 'conn-1',
      message: { type: 'ai.catalog', sessionId: 's1', catalogVersion: '1', tools: [] },
    });
  });

  it('não emite ai-setup-message para heartbeat', async () => {
    const adapter = makeAdapter();
    const listener = vi.fn();
    adapter.on('ai-setup-message', listener);

    await adapter.handleMessage(
      fakeWs('conn-1'),
      Buffer.from(JSON.stringify({ type: 'connector.heartbeat', payload: {} })),
    );

    expect(listener).not.toHaveBeenCalled();
  });
});
```

### 5.2 Run (espera FAIL)

```bash
pnpm run vitest:unit src/modules/agent-identities/gateways/agent-connector-websocket.adapter.ai-setup-emit.test.ts
```

Saída esperada: o segundo teste passa (heartbeat já tratado), o primeiro falha (listener nunca chamado).

### 5.3 Implementação mínima

Em `src/modules/agent-identities/gateways/agent-connector-websocket.adapter.ts`, adicione no topo (junto às outras constantes exportadas):

```typescript
const AI_SETUP_AGENT_MESSAGE_TYPES = new Set([
  'ai.catalog',
  'tool.result',
  'audit.event',
  'mapping.proposed',
  'ai.session.state',
]);
```

No fim de `handleMessage`, antes do fechamento do método (depois do bloco `connector.audit`), adicione:

```typescript
    if (typeof parsed.type === 'string' && AI_SETUP_AGENT_MESSAGE_TYPES.has(parsed.type)) {
      this.emit('ai-setup-message', { connectorId: session.connectorId, message: parsed });
      return;
    }
```

### 5.4 Run (espera PASS)

```bash
pnpm run vitest:unit src/modules/agent-identities/gateways/agent-connector-websocket.adapter.ai-setup-emit.test.ts
```

Saída esperada: 2 testes passam.

### 5.5 Commit

```bash
git add src/modules/agent-identities/gateways/agent-connector-websocket.adapter.ts \
        src/modules/agent-identities/gateways/agent-connector-websocket.adapter.ai-setup-emit.test.ts
git commit -m "feat(ai-setup): adapter emite ai-setup-message para envelopes do agente

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6 — `CatalogToToolsTranslator`

**Objetivo:** Mapear `IToolDescriptor[]` → `Anthropic.Tool[]` (`name`, `description`, `input_schema`).

### 6.1 Write failing test (unit)

Crie `src/modules/ai-setup/services/catalog-to-tools.translator.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import type { IToolDescriptor } from '../interfaces/ai-setup-protocol.interface';
import { CatalogToToolsTranslator } from './catalog-to-tools.translator';

const SUT = 'catalog-to-tools-translator';

describe(`Teste Unitário: ${SUT}`, () => {
  const translator = new CatalogToToolsTranslator();

  it('mapeia name/description/inputSchema para o formato tools da Messages API', () => {
    const catalog: IToolDescriptor[] = [
      {
        name: 'schema.listTables',
        description: 'Lista tabelas do banco',
        inputSchema: {
          type: 'object',
          properties: { schema: { type: 'string' } },
          required: [],
        },
      },
    ];

    const tools = translator.translate(catalog);

    expect(tools).toEqual([
      {
        name: 'schema.listTables',
        description: 'Lista tabelas do banco',
        input_schema: {
          type: 'object',
          properties: { schema: { type: 'string' } },
          required: [],
        },
      },
    ]);
  });

  it('preenche input_schema vazio como objeto sem propriedades', () => {
    const tools = translator.translate([
      { name: 'probe.engines', description: 'engines', inputSchema: {} },
    ]);
    expect(tools[0].input_schema).toEqual({ type: 'object', properties: {} });
  });

  it('retorna lista vazia para catálogo vazio', () => {
    expect(translator.translate([])).toEqual([]);
  });
});
```

### 6.2 Run (espera FAIL)

```bash
pnpm run vitest:unit src/modules/ai-setup/services/catalog-to-tools.translator.test.ts
```

Saída esperada: falha de resolução do módulo `./catalog-to-tools.translator`.

### 6.3 Implementação mínima

Crie `src/modules/ai-setup/services/catalog-to-tools.translator.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';

import type { IToolDescriptor } from '../interfaces/ai-setup-protocol.interface';

@Injectable()
export class CatalogToToolsTranslator {
  translate(descriptors: IToolDescriptor[]): Anthropic.Tool[] {
    return descriptors.map((descriptor) => {
      const rawSchema = descriptor.inputSchema ?? {};
      const inputSchema =
        rawSchema && typeof rawSchema === 'object' && 'type' in rawSchema
          ? rawSchema
          : { type: 'object', properties: {}, ...rawSchema };

      return {
        name: descriptor.name,
        description: descriptor.description,
        input_schema: inputSchema as Anthropic.Tool.InputSchema,
      };
    });
  }
}
```

### 6.4 Run (espera PASS)

```bash
pnpm run vitest:unit src/modules/ai-setup/services/catalog-to-tools.translator.test.ts
```

Saída esperada: 3 testes passam.

### 6.5 Commit

```bash
git add src/modules/ai-setup/services/catalog-to-tools.translator.ts \
        src/modules/ai-setup/services/catalog-to-tools.translator.test.ts
git commit -m "feat(ai-setup): tradutor catálogo->tools da Messages API

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7 — `AnthropicMessagesClient` (wrapper mockável + prompt caching)

**Objetivo:** Wrapper injetável do `@anthropic-ai/sdk` com `createMessage(params)` que chama `messages.create` com prompt caching no system prompt (`cache_control: { type: 'ephemeral' }` no último bloco de system) e `tools`. Exposto sob o token `ANTHROPIC_MESSAGES_CLIENT` para mock determinístico nos testes do loop. O `Anthropic` real é instanciado lazy (no primeiro `createMessage`) a partir do `ConfigService` (`ANTHROPIC_API_KEY`).

### 7.1 Write failing test (unit)

Crie `src/modules/ai-setup/services/anthropic-messages.client.test.ts`:

```typescript
import { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createMock = vi.hoisted(() => vi.fn());
const ctorMock = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { create: createMock };
    constructor(opts: unknown) {
      ctorMock(opts);
    }
  }
  return { default: FakeAnthropic };
});

import { AnthropicMessagesClient } from './anthropic-messages.client';

const SUT = 'anthropic-messages-client';

function makeConfig(overrides: Record<string, string>): ConfigService {
  return { get: (k: string) => overrides[k] } as unknown as ConfigService;
}

describe(`Teste Unitário: ${SUT}`, () => {
  beforeEach(() => {
    createMock.mockResolvedValue({ id: 'msg_1', content: [], stop_reason: 'end_turn' });
  });
  afterEach(() => vi.clearAllMocks());

  it('instancia o SDK com a ANTHROPIC_API_KEY do ConfigService', async () => {
    const client = new AnthropicMessagesClient(makeConfig({ ANTHROPIC_API_KEY: 'sk-test' }));
    await client.createMessage({
      model: 'claude-opus-4-8',
      maxTokens: 100,
      system: 'sys',
      tools: [],
      messages: [{ role: 'user', content: 'oi' }],
    });
    expect(ctorMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-test' }));
  });

  it('aplica cache_control ephemeral no system prompt', async () => {
    const client = new AnthropicMessagesClient(makeConfig({ ANTHROPIC_API_KEY: 'sk-test' }));
    await client.createMessage({
      model: 'claude-opus-4-8',
      maxTokens: 100,
      system: 'system grande',
      tools: [],
      messages: [{ role: 'user', content: 'oi' }],
    });
    const arg = createMock.mock.calls[0][0];
    expect(arg.system).toEqual([
      { type: 'text', text: 'system grande', cache_control: { type: 'ephemeral' } },
    ]);
    expect(arg.model).toBe('claude-opus-4-8');
    expect(arg.max_tokens).toBe(100);
  });

  it('repassa tools e messages ao SDK', async () => {
    const client = new AnthropicMessagesClient(makeConfig({ ANTHROPIC_API_KEY: 'sk-test' }));
    const tools = [{ name: 'probe.engines', description: 'e', input_schema: { type: 'object' } }];
    await client.createMessage({
      model: 'm',
      maxTokens: 1,
      system: 's',
      tools,
      messages: [{ role: 'user', content: 'x' }],
    });
    const arg = createMock.mock.calls[0][0];
    expect(arg.tools).toBe(tools);
    expect(arg.messages).toEqual([{ role: 'user', content: 'x' }]);
  });
});
```

### 7.2 Run (espera FAIL)

```bash
pnpm run vitest:unit src/modules/ai-setup/services/anthropic-messages.client.test.ts
```

Saída esperada: falha de resolução do módulo `./anthropic-messages.client`.

### 7.3 Implementação mínima

Crie `src/modules/ai-setup/services/anthropic-messages.client.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

import { ANTHROPIC_API_KEY_ENV } from '../constants/ai-setup-orchestrator.constants';

export interface ICreateMessageParams {
  model: string;
  maxTokens: number;
  system: string;
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
}

export const ANTHROPIC_MESSAGES_CLIENT = Symbol('ANTHROPIC_MESSAGES_CLIENT');

export interface IAnthropicMessagesClient {
  createMessage(params: ICreateMessageParams): Promise<Anthropic.Message>;
}

@Injectable()
export class AnthropicMessagesClient implements IAnthropicMessagesClient {
  private client: Anthropic | null = null;

  constructor(private readonly configService: ConfigService) {}

  private getClient(): Anthropic {
    if (this.client) {
      return this.client;
    }
    const apiKey = this.configService.get<string>(ANTHROPIC_API_KEY_ENV);
    this.client = new Anthropic({ apiKey });
    return this.client;
  }

  async createMessage(params: ICreateMessageParams): Promise<Anthropic.Message> {
    return this.getClient().messages.create({
      model: params.model,
      max_tokens: params.maxTokens,
      // Prompt caching: o system prompt e estavel entre as iteracoes do loop,
      // entao marcamos cache_control ephemeral no bloco de system.
      system: [{ type: 'text', text: params.system, cache_control: { type: 'ephemeral' } }],
      tools: params.tools,
      messages: params.messages,
    });
  }
}
```

### 7.4 Run (espera PASS)

```bash
pnpm run vitest:unit src/modules/ai-setup/services/anthropic-messages.client.test.ts
```

Saída esperada: 3 testes passam.

### 7.5 Commit

```bash
git add src/modules/ai-setup/services/anthropic-messages.client.ts \
        src/modules/ai-setup/services/anthropic-messages.client.test.ts
git commit -m "feat(ai-setup): wrapper mockável do Anthropic SDK com prompt caching

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8 — `AiSetupSessionRegistry`

**Objetivo:** Estado em memória das sessões ativas (`sessionId → { companyId, connectorId, phase }`) para o controller consultar o estado e o gateway rotear decisões (`mapping.decision`/`ai.session.abort`) ao connector certo.

### 8.1 Write failing test (unit)

Crie `src/modules/ai-setup/services/ai-setup-session.registry.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { AiSetupSessionRegistry } from './ai-setup-session.registry';

const SUT = 'ai-setup-session-registry';

describe(`Teste Unitário: ${SUT}`, () => {
  it('registra e recupera uma sessão por sessionId', () => {
    const registry = new AiSetupSessionRegistry();
    registry.register({ sessionId: 's1', companyId: 7, connectorId: 'conn-1' });
    expect(registry.get('s1')).toEqual({
      sessionId: 's1',
      companyId: 7,
      connectorId: 'conn-1',
      phase: 'discovering',
    });
  });

  it('atualiza a fase de uma sessão existente', () => {
    const registry = new AiSetupSessionRegistry();
    registry.register({ sessionId: 's1', companyId: 7, connectorId: 'conn-1' });
    registry.updatePhase('s1', 'proposing');
    expect(registry.get('s1')?.phase).toBe('proposing');
  });

  it('ignora updatePhase de sessão inexistente', () => {
    const registry = new AiSetupSessionRegistry();
    expect(() => registry.updatePhase('x', 'synced')).not.toThrow();
  });

  it('remove uma sessão', () => {
    const registry = new AiSetupSessionRegistry();
    registry.register({ sessionId: 's1', companyId: 7, connectorId: 'conn-1' });
    registry.remove('s1');
    expect(registry.get('s1')).toBeUndefined();
  });
});
```

### 8.2 Run (espera FAIL)

```bash
pnpm run vitest:unit src/modules/ai-setup/services/ai-setup-session.registry.test.ts
```

Saída esperada: falha de resolução do módulo `./ai-setup-session.registry`.

### 8.3 Implementação mínima

Crie `src/modules/ai-setup/services/ai-setup-session.registry.ts`:

```typescript
import { Injectable } from '@nestjs/common';

import type { AiSessionPhase } from '../interfaces/ai-setup-protocol.interface';

export interface IAiSetupSession {
  sessionId: string;
  companyId: number;
  connectorId: string;
  phase: AiSessionPhase;
}

@Injectable()
export class AiSetupSessionRegistry {
  private readonly sessions = new Map<string, IAiSetupSession>();

  register(input: { sessionId: string; companyId: number; connectorId: string }): void {
    this.sessions.set(input.sessionId, {
      sessionId: input.sessionId,
      companyId: input.companyId,
      connectorId: input.connectorId,
      phase: 'discovering',
    });
  }

  get(sessionId: string): IAiSetupSession | undefined {
    return this.sessions.get(sessionId);
  }

  updatePhase(sessionId: string, phase: AiSessionPhase): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.phase = phase;
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
```

### 8.4 Run (espera PASS)

```bash
pnpm run vitest:unit src/modules/ai-setup/services/ai-setup-session.registry.test.ts
```

Saída esperada: 4 testes passam.

### 8.5 Commit

```bash
git add src/modules/ai-setup/services/ai-setup-session.registry.ts \
        src/modules/ai-setup/services/ai-setup-session.registry.test.ts
git commit -m "feat(ai-setup): registry em memória das sessões de setup por IA

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9 — `AiSetupOrchestratorService`: loop agentic com LLM mockado

**Objetivo:** O cérebro. `runSession({ companyId, connectorId, sessionId, catalog })`:
1. traduz o catálogo (+ a tool sintética `emit_mapping`) para `tools` da Messages API;
2. roda o loop: chama `AnthropicMessagesClient.createMessage`; para cada `tool_use` que não seja `emit_mapping`, chama `bridge.invokeTool` e devolve `tool_result` ao modelo; quando o modelo chama `emit_mapping`, monta o `IConnectorCatalogMappingConfig` e dispara `mapping.proposed` no bridge (via `bridge` → relé pro web);
3. guardas anti-runaway: aborta com `Error` se exceder `AI_SESSION_MAX_INVOCATIONS` ou `AI_SESSION_TIMEOUT_MS`.
LLM injetado por `ANTHROPIC_MESSAGES_CLIENT` (mock determinístico nos testes).

### 9.1 Write failing test (unit, LLM + bridge mockados)

Crie `src/modules/ai-setup/services/ai-setup-orchestrator.service.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IToolDescriptor } from '../interfaces/ai-setup-protocol.interface';
import { CatalogToToolsTranslator } from './catalog-to-tools.translator';
import { AiSetupOrchestratorService } from './ai-setup-orchestrator.service';

vi.mock('@/common/utils/enhanced-logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SUT = 'ai-setup-orchestrator-service';

const CATALOG: IToolDescriptor[] = [
  { name: 'schema.listTables', description: 'lista', inputSchema: { type: 'object' } },
];

const VALID_MAPPING = {
  mappingVersion: 'v1',
  selectedProductTable: 'produtos',
  syncMode: 'snapshot',
  pollIntervalMs: 300_000,
  batchSize: 100,
  snapshotQuery:
    'SELECT p.codigo, p.nome FROM produtos p LEFT JOIN desconto_produtos dp ON dp.produto_id = p.id',
  fields: { sourceProductCode: 'codigo', name: 'nome' },
};

function textStop(): unknown {
  return { id: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
}

describe(`Teste Unitário: ${SUT}`, () => {
  let llm: { createMessage: ReturnType<typeof vi.fn> };
  let bridge: { invokeTool: ReturnType<typeof vi.fn>; emitMappingProposed: ReturnType<typeof vi.fn> };
  let service: AiSetupOrchestratorService;

  beforeEach(() => {
    llm = { createMessage: vi.fn() };
    bridge = { invokeTool: vi.fn(), emitMappingProposed: vi.fn() };
    service = new AiSetupOrchestratorService(
      llm as never,
      bridge as never,
      new CatalogToToolsTranslator(),
    );
  });

  afterEach(() => vi.clearAllMocks());

  it('roda tool_use -> tool.invoke -> tool_result e emite mapping ao emit_mapping', async () => {
    // 1a resposta: modelo chama schema.listTables
    llm.createMessage.mockResolvedValueOnce({
      id: 'm1',
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'tu1', name: 'schema.listTables', input: { schema: 'dbo' } },
      ],
    });
    // bridge devolve resultado da ferramenta
    bridge.invokeTool.mockResolvedValueOnce({ ok: true, payload: { tables: ['produtos'] } });
    // 2a resposta: modelo chama emit_mapping com o ValidatedMappingConfig
    llm.createMessage.mockResolvedValueOnce({
      id: 'm2',
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'tu2',
          name: 'emit_mapping',
          input: { mapping: VALID_MAPPING, rationale: 'JOIN', previewRows: [] },
        },
      ],
    });

    await service.runSession({
      companyId: 7,
      connectorId: 'conn-1',
      sessionId: 's1',
      catalog: CATALOG,
    });

    // tool.invoke chamado com o nome e input do modelo
    expect(bridge.invokeTool).toHaveBeenCalledWith(
      'conn-1',
      's1',
      'schema.listTables',
      { schema: 'dbo' },
    );
    // mapping proposto com config valido
    expect(bridge.emitMappingProposed).toHaveBeenCalledWith('conn-1', {
      type: 'mapping.proposed',
      sessionId: 's1',
      mapping: VALID_MAPPING,
      rationale: 'JOIN',
      previewRows: [],
    });
  });

  it('devolve tool_result is_error=true quando a ferramenta falha mas o loop não morre', async () => {
    llm.createMessage.mockResolvedValueOnce({
      id: 'm1',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu1', name: 'schema.listTables', input: {} }],
    });
    bridge.invokeTool.mockResolvedValueOnce({ ok: false, errorCode: 'auth' });
    llm.createMessage.mockResolvedValueOnce(textStop());

    await service.runSession({
      companyId: 7,
      connectorId: 'conn-1',
      sessionId: 's1',
      catalog: CATALOG,
    });

    const secondCallMessages = llm.createMessage.mock.calls[1][0].messages;
    const toolResultTurn = secondCallMessages[secondCallMessages.length - 1];
    const toolResultBlock = toolResultTurn.content[0];
    expect(toolResultBlock.type).toBe('tool_result');
    expect(toolResultBlock.is_error).toBe(true);
  });

  it('aborta com erro ao exceder o limite de invocações (anti-runaway)', async () => {
    // sempre devolve um tool_use que nunca conclui
    llm.createMessage.mockResolvedValue({
      id: 'mN',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu', name: 'schema.listTables', input: {} }],
    });
    bridge.invokeTool.mockResolvedValue({ ok: true, payload: {} });

    await expect(
      service.runSession(
        { companyId: 7, connectorId: 'conn-1', sessionId: 's1', catalog: CATALOG },
        { maxInvocations: 3, timeoutMs: 60_000 },
      ),
    ).rejects.toThrow(/limite de invocações/i);
    expect(bridge.invokeTool).toHaveBeenCalledTimes(3);
  });

  it('encerra sem propor mapping quando o modelo para com end_turn', async () => {
    llm.createMessage.mockResolvedValueOnce(textStop());
    await service.runSession({
      companyId: 7,
      connectorId: 'conn-1',
      sessionId: 's1',
      catalog: CATALOG,
    });
    expect(bridge.emitMappingProposed).not.toHaveBeenCalled();
  });
});
```

### 9.2 Run (espera FAIL)

```bash
pnpm run vitest:unit src/modules/ai-setup/services/ai-setup-orchestrator.service.test.ts
```

Saída esperada: falha de resolução do módulo `./ai-setup-orchestrator.service`. (O método `bridge.emitMappingProposed` será adicionado ao bridge na Task 10; aqui o orchestrator só o invoca — o teste usa um bridge mockado.)

### 9.3 Implementação mínima

Crie `src/modules/ai-setup/services/ai-setup-orchestrator.service.ts`:

```typescript
import { Inject, Injectable } from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';

import { logger } from '@/common/utils/enhanced-logger';
import type { IConnectorCatalogMappingConfig } from '@modules/pharma-agent-catalog/interfaces/connector-catalog-config-payload.interface';

import {
  AI_SESSION_MAX_INVOCATIONS,
  AI_SESSION_TIMEOUT_MS,
  AI_SETUP_DEFAULT_MODEL,
  AI_SETUP_MAX_TOKENS,
  AI_SETUP_SYSTEM_PROMPT,
} from '../constants/ai-setup-orchestrator.constants';
import { AiSessionConnectorBridge } from '../gateways/ai-session-connector-bridge';
import type { IToolDescriptor } from '../interfaces/ai-setup-protocol.interface';
import {
  ANTHROPIC_MESSAGES_CLIENT,
  type IAnthropicMessagesClient,
} from './anthropic-messages.client';
import { CatalogToToolsTranslator } from './catalog-to-tools.translator';

const MODULE = 'AiSetupOrchestratorService';
const EMIT_MAPPING_TOOL_NAME = 'emit_mapping';

export interface IRunSessionInput {
  companyId: number;
  connectorId: string;
  sessionId: string;
  catalog: IToolDescriptor[];
  model?: string;
}

export interface IRunSessionGuards {
  maxInvocations?: number;
  timeoutMs?: number;
}

const EMIT_MAPPING_TOOL: Anthropic.Tool = {
  name: EMIT_MAPPING_TOOL_NAME,
  description:
    'Conclui a sessão emitindo o ValidatedMappingConfig final e o rationale. Chame UMA vez.',
  input_schema: {
    type: 'object',
    properties: {
      mapping: { type: 'object' },
      rationale: { type: 'string' },
      previewRows: { type: 'array', items: { type: 'object' } },
    },
    required: ['mapping', 'rationale'],
  } as Anthropic.Tool.InputSchema,
};

@Injectable()
export class AiSetupOrchestratorService {
  constructor(
    @Inject(ANTHROPIC_MESSAGES_CLIENT)
    private readonly llm: IAnthropicMessagesClient,
    private readonly bridge: AiSessionConnectorBridge,
    private readonly translator: CatalogToToolsTranslator,
  ) {}

  async runSession(input: IRunSessionInput, guards: IRunSessionGuards = {}): Promise<void> {
    const maxInvocations = guards.maxInvocations ?? AI_SESSION_MAX_INVOCATIONS;
    const timeoutMs = guards.timeoutMs ?? AI_SESSION_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const model = input.model ?? AI_SETUP_DEFAULT_MODEL;

    const tools: Anthropic.Tool[] = [
      ...this.translator.translate(input.catalog),
      EMIT_MAPPING_TOOL,
    ];

    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content:
          'Inicie o setup: descubra o banco, valide credenciais, inspecione o schema e proponha o mapping.',
      },
    ];

    let invocations = 0;

    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(`Timeout de sessão excedido (${timeoutMs}ms)`);
      }

      const response = await this.llm.createMessage({
        model,
        maxTokens: AI_SETUP_MAX_TOKENS,
        system: AI_SETUP_SYSTEM_PROMPT,
        tools,
        messages,
      });

      const toolUses = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );

      if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
        // Modelo encerrou sem propor mapping.
        return;
      }

      messages.push({ role: 'assistant', content: response.content });

      const emitBlock = toolUses.find((block) => block.name === EMIT_MAPPING_TOOL_NAME);
      if (emitBlock) {
        this.emitMapping(input, emitBlock.input as Record<string, unknown>);
        return;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        if (invocations >= maxInvocations) {
          throw new Error(`Limite de invocações por sessão excedido (${maxInvocations})`);
        }
        invocations += 1;

        const result = await this.bridge.invokeTool(
          input.connectorId,
          input.sessionId,
          toolUse.name,
          toolUse.input,
        );

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result.ok ? result.payload ?? {} : { errorCode: result.errorCode }),
          ...(result.ok ? {} : { is_error: true }),
        });
      }

      messages.push({ role: 'user', content: toolResults });
    }
  }

  private emitMapping(input: IRunSessionInput, emitInput: Record<string, unknown>): void {
    const mapping = emitInput.mapping as IConnectorCatalogMappingConfig;
    const rationale = typeof emitInput.rationale === 'string' ? emitInput.rationale : '';
    const previewRows = Array.isArray(emitInput.previewRows)
      ? (emitInput.previewRows as Array<Record<string, unknown>>)
      : [];

    this.bridge.emitMappingProposed(input.connectorId, {
      type: 'mapping.proposed',
      sessionId: input.sessionId,
      mapping,
      rationale,
      previewRows,
    });

    logger.info(
      { module: MODULE, action: 'ai_setup_mapping_proposed', sessionId: input.sessionId },
      'Mapping proposto pela IA',
    );
  }
}
```

### 9.4 Run (espera PASS)

```bash
pnpm run vitest:unit src/modules/ai-setup/services/ai-setup-orchestrator.service.test.ts
```

Saída esperada: 4 testes passam.

### 9.5 Commit

```bash
git add src/modules/ai-setup/services/ai-setup-orchestrator.service.ts \
        src/modules/ai-setup/services/ai-setup-orchestrator.service.test.ts
git commit -m "feat(ai-setup): loop agentic com tool use e guardas anti-runaway

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10 — `emitMappingProposed` no bridge

**Objetivo:** O orchestrator (Task 9) chama `bridge.emitMappingProposed(connectorId, IMappingProposedMessage)`. Implementar esse método no `AiSessionConnectorBridge` re-emitindo no `EventEmitter` (o `AiSetupModule` assina e relaya pro gateway). Isso unifica a saída: tanto `mapping.proposed` vindo do agente (`handleAgentMessage`) quanto o proposto pelo orchestrator passam pelo mesmo evento `'mapping'`.

### 10.1 Write failing test (unit)

Adicione a `src/modules/ai-setup/gateways/ai-session-connector-bridge.test.ts` (novo `it` dentro do mesmo `describe`):

```typescript
  it('emitMappingProposed re-emite o evento mapping', () => {
    const mapping = vi.fn();
    bridge.on('mapping', mapping);
    const msg = {
      type: 'mapping.proposed' as const,
      sessionId: 's1',
      mapping: {
        mappingVersion: 'v1',
        selectedProductTable: 'produtos',
        syncMode: 'snapshot' as const,
        pollIntervalMs: 1,
        batchSize: 1,
        snapshotQuery: 'SELECT 1',
        fields: { sourceProductCode: 'codigo', name: 'nome' },
      },
      rationale: 'r',
      previewRows: [],
    };
    bridge.emitMappingProposed('conn-1', msg);
    expect(mapping).toHaveBeenCalledWith({ connectorId: 'conn-1', message: msg });
  });
```

### 10.2 Run (espera FAIL)

```bash
pnpm run vitest:unit src/modules/ai-setup/gateways/ai-session-connector-bridge.test.ts
```

Saída esperada: `bridge.emitMappingProposed is not a function`.

### 10.3 Implementação mínima

Em `src/modules/ai-setup/gateways/ai-session-connector-bridge.ts`, importe o tipo e adicione o método público:

```typescript
  emitMappingProposed(connectorId: string, message: IMappingProposedMessage): void {
    this.emit('mapping', { connectorId, message });
  }
```

(`IMappingProposedMessage` já está importado na Task 4.)

### 10.4 Run (espera PASS)

```bash
pnpm run vitest:unit src/modules/ai-setup/gateways/ai-session-connector-bridge.test.ts
```

Saída esperada: 7 testes passam (6 anteriores + o novo).

### 10.5 Commit

```bash
git add src/modules/ai-setup/gateways/ai-session-connector-bridge.ts \
        src/modules/ai-setup/gateways/ai-session-connector-bridge.test.ts
git commit -m "feat(ai-setup): emitMappingProposed no bridge

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11 — `AiSetupGateway` (socket.io, relé para o web)

**Objetivo:** Gateway socket.io seguindo `TicketGateway`, atuando APENAS como relé (o gatilho da sessão é o POST REST da Task 12, não o socket): `@SubscribeMessage('company')` faz o cliente entrar na sala `company:{id}`; `@SubscribeMessage('mapping.decision'|'ai.session.abort')` recebe do web e (via callbacks injetados pelo módulo) encaminha decisão/abort ao agente; `emitAuditEvent`/`emitSessionState`/`emitMappingProposed` fazem `server.to('company:{id}').emit(evento, payload)`. NÃO há `@SubscribeMessage('ai.session.start')` — iniciar a sessão é responsabilidade exclusiva do controller REST. Reusa `RedisIoAdapter` (já global via `main.ts`).

### 11.1 Write failing test (unit)

Crie `src/modules/ai-setup/gateways/ai-setup.gateway.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server, Socket } from 'socket.io';

import { AiSetupGateway } from './ai-setup.gateway';

vi.mock('@/common/utils/enhanced-logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const SUT = 'ai-setup-gateway';

describe(`Teste Unitário: ${SUT}`, () => {
  let gateway: AiSetupGateway;
  let emit: ReturnType<typeof vi.fn>;
  let to: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    gateway = new AiSetupGateway();
    emit = vi.fn();
    to = vi.fn().mockReturnValue({ emit });
    gateway.server = { to } as unknown as Server;
  });

  afterEach(() => vi.clearAllMocks());

  it('handleCompanyJoin entra na sala company:{id}', async () => {
    const join = vi.fn();
    const client = { id: 'c1', join, data: {} } as unknown as Socket;
    await gateway.handleCompanyJoin(7, client);
    expect(join).toHaveBeenCalledWith('company:7');
    expect((client.data as { companyId?: number }).companyId).toBe(7);
  });

  it('emitAuditEvent emite audit.event para a sala da company', () => {
    gateway.emitAuditEvent(7, { type: 'audit.event', sessionId: 's1', seq: 1, at: 'x', kind: 'k', summary: 's' });
    expect(to).toHaveBeenCalledWith('company:7');
    expect(emit).toHaveBeenCalledWith(
      'audit.event',
      expect.objectContaining({ type: 'audit.event', sessionId: 's1' }),
    );
  });

  it('emitSessionState emite ai.session.state para a sala da company', () => {
    gateway.emitSessionState(7, { type: 'ai.session.state', sessionId: 's1', phase: 'schema' });
    expect(emit).toHaveBeenCalledWith('ai.session.state', expect.objectContaining({ phase: 'schema' }));
  });

  it('emitMappingProposed emite mapping.proposed para a sala da company', () => {
    gateway.emitMappingProposed(7, {
      type: 'mapping.proposed',
      sessionId: 's1',
      mapping: {
        mappingVersion: 'v1',
        selectedProductTable: 'produtos',
        syncMode: 'snapshot',
        pollIntervalMs: 1,
        batchSize: 1,
        snapshotQuery: 'SELECT 1',
        fields: { sourceProductCode: 'codigo', name: 'nome' },
      },
      rationale: 'r',
      previewRows: [],
    });
    expect(emit).toHaveBeenCalledWith('mapping.proposed', expect.objectContaining({ sessionId: 's1' }));
  });

  it('handleMappingDecision chama o handler registrado', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    gateway.onMappingDecision(handler);
    const client = { id: 'c1', data: { companyId: 7 } } as unknown as Socket;
    await gateway.handleMappingDecision({ sessionId: 's1', decision: 'approve' }, client);
    expect(handler).toHaveBeenCalledWith({ companyId: 7, sessionId: 's1', decision: 'approve', editedMapping: undefined });
  });

  it('handleSessionAbort chama o handler registrado', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    gateway.onSessionAbort(handler);
    const client = { id: 'c1', data: { companyId: 7 } } as unknown as Socket;
    await gateway.handleSessionAbort({ sessionId: 's1', reason: 'cancel' }, client);
    expect(handler).toHaveBeenCalledWith({ companyId: 7, sessionId: 's1', reason: 'cancel' });
  });
});
```

### 11.2 Run (espera FAIL)

```bash
pnpm run vitest:unit src/modules/ai-setup/gateways/ai-setup.gateway.test.ts
```

Saída esperada: falha de resolução do módulo `./ai-setup.gateway`.

### 11.3 Implementação mínima

Crie `src/modules/ai-setup/gateways/ai-setup.gateway.ts`:

```typescript
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

import { logger } from '@/common/utils/enhanced-logger';

import type {
  IAiSessionStateMessage,
  IAuditEventMessage,
  IMappingProposedMessage,
} from '../interfaces/ai-setup-protocol.interface';

export type MappingDecisionHandler = (input: {
  companyId: number;
  sessionId: string;
  decision: 'approve' | 'reject';
  editedMapping?: unknown;
}) => Promise<void> | void;

export type SessionAbortHandler = (input: {
  companyId: number;
  sessionId: string;
  reason: string;
}) => Promise<void> | void;

@WebSocketGateway({
  cors: { origin: '*', credentials: true },
  transports: ['websocket', 'polling'],
  allowEIO3: true,
})
export class AiSetupGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private mappingDecisionHandler: MappingDecisionHandler | null = null;
  private sessionAbortHandler: SessionAbortHandler | null = null;

  afterInit(): void {
    logger.info({ module: 'AiSetupGateway' }, 'WebSocket Gateway de setup por IA inicializado');
  }

  handleConnection(client: Socket): void {
    logger.debug({ module: 'AiSetupGateway', clientId: client.id }, 'Cliente conectado');
  }

  handleDisconnect(client: Socket): void {
    logger.debug({ module: 'AiSetupGateway', clientId: client.id }, 'Cliente desconectado');
  }

  onMappingDecision(handler: MappingDecisionHandler): void {
    this.mappingDecisionHandler = handler;
  }

  onSessionAbort(handler: SessionAbortHandler): void {
    this.sessionAbortHandler = handler;
  }

  @SubscribeMessage('company')
  async handleCompanyJoin(
    @MessageBody() companyId: number,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const id = Number(companyId);
    if (!id || Number.isNaN(id)) {
      return;
    }
    await client.join(`company:${id}`);
    client.data.companyId = id;
  }

  @SubscribeMessage('mapping.decision')
  async handleMappingDecision(
    @MessageBody() body: { sessionId: string; decision: 'approve' | 'reject'; editedMapping?: unknown },
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const companyId = client.data.companyId as number | undefined;
    if (!companyId || !this.mappingDecisionHandler) {
      return;
    }
    await this.mappingDecisionHandler({
      companyId,
      sessionId: body.sessionId,
      decision: body.decision,
      editedMapping: body.editedMapping,
    });
  }

  @SubscribeMessage('ai.session.abort')
  async handleSessionAbort(
    @MessageBody() body: { sessionId: string; reason: string },
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const companyId = client.data.companyId as number | undefined;
    if (!companyId || !this.sessionAbortHandler) {
      return;
    }
    await this.sessionAbortHandler({ companyId, sessionId: body.sessionId, reason: body.reason });
  }

  emitAuditEvent(companyId: number, message: IAuditEventMessage): void {
    this.server.to(`company:${companyId}`).emit('audit.event', message);
  }

  emitSessionState(companyId: number, message: IAiSessionStateMessage): void {
    this.server.to(`company:${companyId}`).emit('ai.session.state', message);
  }

  emitMappingProposed(companyId: number, message: IMappingProposedMessage): void {
    this.server.to(`company:${companyId}`).emit('mapping.proposed', message);
  }
}
```

### 11.4 Run (espera PASS)

```bash
pnpm run vitest:unit src/modules/ai-setup/gateways/ai-setup.gateway.test.ts
```

Saída esperada: 6 testes passam.

### 11.5 Commit

```bash
git add src/modules/ai-setup/gateways/ai-setup.gateway.ts \
        src/modules/ai-setup/gateways/ai-setup.gateway.test.ts
git commit -m "feat(ai-setup): gateway socket.io de relé para o web

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 12 — `AiSetupController` (REST: gatilho ÚNICO da sessão)

**Objetivo:** Endpoints REST seguindo `AgentIdentityController` + `BaseController` + envelope `ok()`, escopados por company (SEM `connectorId` na URL). O `POST /pharma-agent-catalog/companies/:companyId/ai-setup/sessions` é o **único gatilho da sessão**: resolve o connector ativo da company internamente (não vem da URL), gera `sessionId`, registra no registry, dispara `ai.session.start` neo→agente via bridge e inicia o loop do `AiSetupOrchestratorService` — tudo via `AiSetupFacade.startSession({ companyId })`. O `GET /pharma-agent-catalog/companies/:companyId/ai-setup/sessions/:sessionId` consulta o estado.

### 12.1 Write failing test (unit)

Crie `src/modules/ai-setup/controllers/ai-setup.controller.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiSetupController } from './ai-setup.controller';

vi.mock('@/common/utils/enhanced-logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SUT = 'ai-setup-controller';

describe(`Teste Unitário: ${SUT}`, () => {
  let startSession: ReturnType<typeof vi.fn>;
  let getSession: ReturnType<typeof vi.fn>;
  let controller: AiSetupController;

  beforeEach(() => {
    startSession = vi.fn().mockResolvedValue({ sessionId: 's1' });
    getSession = vi.fn().mockReturnValue({
      sessionId: 's1',
      companyId: 7,
      connectorId: 'conn-1',
      phase: 'discovering',
    });
    controller = new AiSetupController({ startSession, getSession } as never);
  });

  afterEach(() => vi.clearAllMocks());

  it('POST sessions retorna envelope ok com sessionId', async () => {
    const result = await controller.createSession(7);
    expect(startSession).toHaveBeenCalledWith({ companyId: 7 });
    expect(result).toEqual({
      success: true,
      message: expect.any(String),
      data: { sessionId: 's1' },
      error: null,
    });
  });

  it('GET sessions retorna envelope ok com estado', async () => {
    const result = await controller.getSession(7, 's1');
    expect(getSession).toHaveBeenCalledWith('s1');
    expect(result).toEqual({
      success: true,
      message: expect.any(String),
      data: { sessionId: 's1', companyId: 7, connectorId: 'conn-1', phase: 'discovering' },
      error: null,
    });
  });
});
```

### 12.2 Run (espera FAIL)

```bash
pnpm run vitest:unit src/modules/ai-setup/controllers/ai-setup.controller.test.ts
```

Saída esperada: falha de resolução do módulo `./ai-setup.controller`.

### 12.3 Implementação mínima

A lógica de iniciar/consultar sessão vive numa fachada `AiSetupFacade` (criada na Task 13, dentro do módulo, para evitar dependência circular gateway↔orchestrator). O controller depende apenas dela. Crie `src/modules/ai-setup/controllers/ai-setup.controller.ts`:

```typescript
import { Controller, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import { BaseController } from '@/common/controllers/base.controller';

import { AiSetupFacade } from '../services/ai-setup.facade';

@ApiTags('AiSetup')
@ApiBearerAuth('bearer')
@Controller('pharma-agent-catalog/companies/:companyId/ai-setup')
export class AiSetupController extends BaseController {
  constructor(private readonly aiSetupFacade: AiSetupFacade) {
    super();
  }

  @Post('sessions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Inicia uma sessão de setup dirigido por IA' })
  @ApiParam({ name: 'companyId', type: Number })
  async createSession(@Param('companyId', ParseIntPipe) companyId: number) {
    try {
      const result = await this.aiSetupFacade.startSession({ companyId });
      return this.ok('Sessão de setup por IA iniciada', result);
    } catch (error) {
      this.handleError({
        error,
        method: 'createSession',
        action: 'ai_setup_session_start',
        defaultMessage: 'Ocorreu um erro ao iniciar a sessão de setup por IA.',
        errorType: '/erros/ai-setup-session-start',
        title: 'Erro ao iniciar sessão de setup por IA',
        payload: { companyId },
      });
    }
  }

  @Get('sessions/:sessionId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Consulta o estado de uma sessão de setup por IA' })
  @ApiParam({ name: 'companyId', type: Number })
  @ApiParam({ name: 'sessionId', type: String })
  async getSession(
    @Param('companyId', ParseIntPipe) companyId: number,
    @Param('sessionId') sessionId: string,
  ) {
    try {
      const result = this.aiSetupFacade.getSession(sessionId);
      return this.ok('Estado da sessão de setup por IA', result);
    } catch (error) {
      this.handleError({
        error,
        method: 'getSession',
        action: 'ai_setup_session_state',
        defaultMessage: 'Ocorreu um erro ao consultar a sessão de setup por IA.',
        errorType: '/erros/ai-setup-session-state',
        title: 'Erro ao consultar sessão de setup por IA',
        payload: { companyId, sessionId },
      });
    }
  }
}
```

> Nota: o teste injeta um stub `{ startSession, getSession }` no lugar do `AiSetupFacade`. O `AiSetupFacade` real é implementado na Task 13.

### 12.4 Run

`getSession`/`startSession` referenciam `AiSetupFacade` (ainda inexistente). Como o teste injeta um stub, o teste de unit do controller só precisa que o **import de tipo** resolva. Para o import resolver agora, crie um stub mínimo de `AiSetupFacade` em `src/modules/ai-setup/services/ai-setup.facade.ts`:

```typescript
import { Injectable } from '@nestjs/common';

@Injectable()
export class AiSetupFacade {
  async startSession(_input: { companyId: number }): Promise<{ sessionId: string }> {
    throw new Error('not implemented');
  }

  getSession(_sessionId: string): unknown {
    throw new Error('not implemented');
  }
}
```

Run (espera PASS):

```bash
pnpm run vitest:unit src/modules/ai-setup/controllers/ai-setup.controller.test.ts
```

Saída esperada: 2 testes passam.

### 12.5 Commit

```bash
git add src/modules/ai-setup/controllers/ai-setup.controller.ts \
        src/modules/ai-setup/controllers/ai-setup.controller.test.ts \
        src/modules/ai-setup/services/ai-setup.facade.ts
git commit -m "feat(ai-setup): controller REST de apoio com envelope ok

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 13 — `AiSetupFacade`: orquestra início de sessão + roteamento

**Objetivo:** Implementar o `AiSetupFacade` real. `startSession({ companyId })` é o gatilho único da sessão (chamado pelo controller REST): RESOLVE o connector ativo da company internamente (via `AgentConnectorRepository.findActiveStoreByCompanyId` → `findActiveConnectorByStoreId`; lança `NotFoundException` se não houver connector ativo), gera `sessionId` (uuid), registra no `AiSetupSessionRegistry` (companyId + connectorId resolvido, phase inicial), e chama `bridge.startSession` (`ai.session.start` neo→agente). O loop do `orchestrator.runSession` é iniciado ao receber o catálogo do agente (evento `'catalog'` do bridge → `handleCatalog`), que é a resposta do agente ao `ai.session.start` disparado pelo POST. `handleDecision` chama `bridge.sendDecision`; `handleAbort` chama `bridge.abortSession`. `getSession` lê o registry. A facade resolve a relação `companyId`↔`connectorId` consultando o registry por `sessionId`.

### 13.1 Write failing test (unit)

Crie `src/modules/ai-setup/services/ai-setup.facade.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiSessionConnectorBridge } from '../gateways/ai-session-connector-bridge';
import { AiSetupSessionRegistry } from './ai-setup-session.registry';
import { AiSetupFacade } from './ai-setup.facade';

vi.mock('@/common/utils/enhanced-logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SUT = 'ai-setup-facade';

describe(`Teste Unitário: ${SUT}`, () => {
  let bridge: AiSessionConnectorBridge;
  let registry: AiSetupSessionRegistry;
  let orchestrator: { runSession: ReturnType<typeof vi.fn> };
  let connectorRepository: {
    findActiveStoreByCompanyId: ReturnType<typeof vi.fn>;
    findActiveConnectorByStoreId: ReturnType<typeof vi.fn>;
  };
  let facade: AiSetupFacade;

  beforeEach(() => {
    bridge = new AiSessionConnectorBridge({ sendRawToConnector: vi.fn() } as never);
    vi.spyOn(bridge, 'startSession').mockImplementation(() => undefined);
    vi.spyOn(bridge, 'sendDecision').mockImplementation(() => undefined);
    vi.spyOn(bridge, 'abortSession').mockImplementation(() => undefined);
    registry = new AiSetupSessionRegistry();
    orchestrator = { runSession: vi.fn().mockResolvedValue(undefined) };
    connectorRepository = {
      findActiveStoreByCompanyId: vi.fn().mockResolvedValue({ id: 'store-1' }),
      findActiveConnectorByStoreId: vi.fn().mockResolvedValue({ id: 'conn-1' }),
    };
    facade = new AiSetupFacade(
      bridge,
      registry,
      orchestrator as never,
      connectorRepository as never,
    );
  });

  afterEach(() => vi.clearAllMocks());

  it('startSession resolve o connector ativo, registra a sessão e manda ai.session.start ao agente', async () => {
    const { sessionId } = await facade.startSession({ companyId: 7 });
    expect(connectorRepository.findActiveStoreByCompanyId).toHaveBeenCalledWith(7);
    expect(connectorRepository.findActiveConnectorByStoreId).toHaveBeenCalledWith('store-1');
    expect(registry.get(sessionId)).toMatchObject({ companyId: 7, connectorId: 'conn-1' });
    expect(bridge.startSession).toHaveBeenCalledWith('conn-1', sessionId);
  });

  it('ao receber catálogo do bridge dispara orchestrator.runSession', async () => {
    const { sessionId } = await facade.startSession({ companyId: 7 });
    bridge.emit('catalog', {
      connectorId: 'conn-1',
      message: { type: 'ai.catalog', sessionId, catalogVersion: '1', tools: [] },
    });
    // microtask para o handler assíncrono rodar
    await Promise.resolve();
    expect(orchestrator.runSession).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 7, connectorId: 'conn-1', sessionId, catalog: [] }),
    );
  });

  it('handleDecision encaminha approve ao agente', () => {
    registry.register({ sessionId: 's1', companyId: 7, connectorId: 'conn-1' });
    facade.handleDecision({ companyId: 7, sessionId: 's1', decision: 'approve' });
    expect(bridge.sendDecision).toHaveBeenCalledWith('conn-1', 's1', 'approve', undefined);
  });

  it('handleAbort encaminha o abort ao agente', () => {
    registry.register({ sessionId: 's1', companyId: 7, connectorId: 'conn-1' });
    facade.handleAbort({ companyId: 7, sessionId: 's1', reason: 'cancel' });
    expect(bridge.abortSession).toHaveBeenCalledWith('conn-1', 's1', 'cancel');
  });

  it('getSession lê o registry', () => {
    registry.register({ sessionId: 's1', companyId: 7, connectorId: 'conn-1' });
    expect(facade.getSession('s1')).toMatchObject({ sessionId: 's1', phase: 'discovering' });
  });
});
```

### 13.2 Run (espera FAIL)

```bash
pnpm run vitest:unit src/modules/ai-setup/services/ai-setup.facade.test.ts
```

Saída esperada: falha porque `AiSetupFacade` é o stub que lança `not implemented`.

### 13.3 Implementação

Substitua `src/modules/ai-setup/services/ai-setup.facade.ts` pela implementação real:

```typescript
import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { v4 as uuid } from 'uuid';

import { logger } from '@/common/utils/enhanced-logger';
import { AgentConnectorRepository } from '@modules/agent-identities/repositories/agent-connector.repository';

import { AiSessionConnectorBridge } from '../gateways/ai-session-connector-bridge';
import type { IAiCatalogMessage } from '../interfaces/ai-setup-protocol.interface';
import { AiSetupOrchestratorService } from './ai-setup-orchestrator.service';
import { AiSetupSessionRegistry, type IAiSetupSession } from './ai-setup-session.registry';

const MODULE = 'AiSetupFacade';

@Injectable()
export class AiSetupFacade implements OnModuleInit {
  constructor(
    private readonly bridge: AiSessionConnectorBridge,
    private readonly registry: AiSetupSessionRegistry,
    private readonly orchestrator: AiSetupOrchestratorService,
    private readonly connectorRepository: AgentConnectorRepository,
  ) {}

  onModuleInit(): void {
    this.bridge.on(
      'catalog',
      (event: { connectorId: string; message: IAiCatalogMessage }) => {
        void this.handleCatalog(event.connectorId, event.message);
      },
    );
  }

  async startSession(input: { companyId: number }): Promise<{
    sessionId: string;
  }> {
    const connectorId = await this.resolveActiveConnectorId(input.companyId);
    const sessionId = uuid();
    this.registry.register({
      sessionId,
      companyId: input.companyId,
      connectorId,
    });
    this.bridge.startSession(connectorId, sessionId);
    logger.info(
      { module: MODULE, action: 'ai_setup_session_started', sessionId, companyId: input.companyId, connectorId },
      'Sessão de setup por IA iniciada',
    );
    return { sessionId };
  }

  private async resolveActiveConnectorId(companyId: number): Promise<string> {
    const store = await this.connectorRepository.findActiveStoreByCompanyId(companyId);
    if (!store) {
      throw new NotFoundException(`Nenhuma store ativa para a company ${companyId}`);
    }
    const connector = await this.connectorRepository.findActiveConnectorByStoreId(store.id);
    if (!connector) {
      throw new NotFoundException(`Nenhum connector ativo para a company ${companyId}`);
    }
    return connector.id;
  }

  getSession(sessionId: string): IAiSetupSession {
    const session = this.registry.get(sessionId);
    if (!session) {
      throw new NotFoundException(`Sessão ${sessionId} não encontrada`);
    }
    return session;
  }

  handleDecision(input: {
    companyId: number;
    sessionId: string;
    decision: 'approve' | 'reject';
    editedMapping?: unknown;
  }): void {
    const session = this.registry.get(input.sessionId);
    if (!session || session.companyId !== input.companyId) {
      return;
    }
    this.bridge.sendDecision(
      session.connectorId,
      input.sessionId,
      input.decision,
      input.editedMapping,
    );
  }

  handleAbort(input: { companyId: number; sessionId: string; reason: string }): void {
    const session = this.registry.get(input.sessionId);
    if (!session || session.companyId !== input.companyId) {
      return;
    }
    this.bridge.abortSession(session.connectorId, input.sessionId, input.reason);
  }

  private async handleCatalog(connectorId: string, message: IAiCatalogMessage): Promise<void> {
    const session = this.registry.get(message.sessionId);
    if (!session || session.connectorId !== connectorId) {
      return;
    }
    try {
      await this.orchestrator.runSession({
        companyId: session.companyId,
        connectorId,
        sessionId: message.sessionId,
        catalog: message.tools,
      });
    } catch (error) {
      logger.error(
        error instanceof Error ? error : new Error('Falha no loop agentic'),
        { module: MODULE, action: 'ai_setup_run_session_failed', sessionId: message.sessionId },
        'Loop agentic da sessão de setup por IA falhou',
      );
      this.registry.updatePhase(message.sessionId, 'failed');
    }
  }
}
```

### 13.4 Run (espera PASS)

```bash
pnpm run vitest:unit src/modules/ai-setup/services/ai-setup.facade.test.ts
```

Saída esperada: 5 testes passam.

### 13.5 Commit

```bash
git add src/modules/ai-setup/services/ai-setup.facade.ts \
        src/modules/ai-setup/services/ai-setup.facade.test.ts
git commit -m "feat(ai-setup): facade orquestra início de sessão e roteamento

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 14 — `AiSetupModule` (cabos + fan-out de eventos)

**Objetivo:** Cablar tudo num `AiSetupModule`: importar `AgentIdentitiesModule` (exporta `AgentConnectorWebSocketAdapter` e — adicionado nesta task — `AgentConnectorRepository`, necessário à facade para resolver o connector ativo da company), `ConfigModule`, `RedisModule`; declarar providers (`AiSessionConnectorBridge`, `AnthropicMessagesClient` sob token `ANTHROPIC_MESSAGES_CLIENT`, `CatalogToToolsTranslator`, `AiSetupOrchestratorService`, `AiSetupSessionRegistry`, `AiSetupFacade`, `AiSetupGateway`); controller `AiSetupController`. Um provider de bootstrap (`AiSetupWiring`, `OnApplicationBootstrap`) conecta: (a) `adapter.on('ai-setup-message')` → `bridge.handleAgentMessage`; (b) eventos `audit`/`state`/`mapping` do bridge → métodos `emit*` do gateway (resolvendo `companyId` pelo registry); (c) handlers do gateway → facade (apenas `mapping.decision` e `ai.session.abort`; o `ai.session.start` NÃO é ouvido pelo socket — o gatilho da sessão é o POST REST). Registrar `AiSetupModule` no `AppModule`. **Pré-requisito:** adicionar `AgentConnectorRepository` ao `exports` de `AgentIdentitiesModule`.

### 14.1 Write failing test (unit do wiring)

Crie `src/modules/ai-setup/ai-setup.wiring.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiSetupWiring } from './ai-setup.wiring';

vi.mock('@/common/utils/enhanced-logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SUT = 'ai-setup-wiring';

describe(`Teste Unitário: ${SUT}`, () => {
  let adapter: { on: ReturnType<typeof vi.fn> };
  let bridge: { on: ReturnType<typeof vi.fn>; handleAgentMessage: ReturnType<typeof vi.fn> };
  let gateway: {
    onMappingDecision: ReturnType<typeof vi.fn>;
    onSessionAbort: ReturnType<typeof vi.fn>;
    emitAuditEvent: ReturnType<typeof vi.fn>;
  };
  let registry: { get: ReturnType<typeof vi.fn>; updatePhase: ReturnType<typeof vi.fn> };
  let facade: Record<string, unknown>;
  let wiring: AiSetupWiring;

  beforeEach(() => {
    adapter = { on: vi.fn() };
    bridge = { on: vi.fn(), handleAgentMessage: vi.fn() };
    gateway = {
      onMappingDecision: vi.fn(),
      onSessionAbort: vi.fn(),
      emitAuditEvent: vi.fn(),
      emitSessionState: vi.fn(),
      emitMappingProposed: vi.fn(),
    } as never;
    registry = { get: vi.fn(), updatePhase: vi.fn() };
    facade = { startSession: vi.fn(), handleDecision: vi.fn(), handleAbort: vi.fn() };
    wiring = new AiSetupWiring(
      adapter as never,
      bridge as never,
      gateway as never,
      registry as never,
      facade as never,
    );
  });

  afterEach(() => vi.clearAllMocks());

  it('liga adapter.on(ai-setup-message) ao bridge.handleAgentMessage', () => {
    wiring.onApplicationBootstrap();
    expect(adapter.on).toHaveBeenCalledWith('ai-setup-message', expect.any(Function));
    const handler = adapter.on.mock.calls.find((c) => c[0] === 'ai-setup-message')![1];
    handler({ connectorId: 'conn-1', message: { type: 'tool.result' } });
    expect(bridge.handleAgentMessage).toHaveBeenCalledWith('conn-1', { type: 'tool.result' });
  });

  it('liga evento audit do bridge ao gateway.emitAuditEvent resolvendo a company', () => {
    registry.get.mockReturnValue({ companyId: 7, connectorId: 'conn-1' });
    wiring.onApplicationBootstrap();
    const handler = bridge.on.mock.calls.find((c) => c[0] === 'audit')![1];
    const message = { type: 'audit.event', sessionId: 's1', seq: 1, at: 'x', kind: 'k', summary: 's' };
    handler({ connectorId: 'conn-1', message });
    expect(gateway.emitAuditEvent).toHaveBeenCalledWith(7, message);
  });

  it('registra apenas os handlers de decisão/abort do gateway apontando para a facade (sem ai.session.start)', () => {
    wiring.onApplicationBootstrap();
    expect(gateway.onMappingDecision).toHaveBeenCalled();
    expect(gateway.onSessionAbort).toHaveBeenCalled();
    expect((gateway as Record<string, unknown>).onSessionStart).toBeUndefined();
  });
});
```

### 14.2 Run (espera FAIL)

```bash
pnpm run vitest:unit src/modules/ai-setup/ai-setup.wiring.test.ts
```

Saída esperada: falha de resolução do módulo `./ai-setup.wiring`.

### 14.3 Implementação

Crie `src/modules/ai-setup/ai-setup.wiring.ts`:

```typescript
import { Injectable, OnApplicationBootstrap } from '@nestjs/common';

import { AgentConnectorWebSocketAdapter } from '@modules/agent-identities/gateways/agent-connector-websocket.adapter';

import { AiSessionConnectorBridge } from './gateways/ai-session-connector-bridge';
import { AiSetupGateway } from './gateways/ai-setup.gateway';
import type {
  IAiSessionStateMessage,
  IAuditEventMessage,
  IMappingProposedMessage,
} from './interfaces/ai-setup-protocol.interface';
import { AiSetupFacade } from './services/ai-setup.facade';
import { AiSetupSessionRegistry } from './services/ai-setup-session.registry';

@Injectable()
export class AiSetupWiring implements OnApplicationBootstrap {
  constructor(
    private readonly adapter: AgentConnectorWebSocketAdapter,
    private readonly bridge: AiSessionConnectorBridge,
    private readonly gateway: AiSetupGateway,
    private readonly registry: AiSetupSessionRegistry,
    private readonly facade: AiSetupFacade,
  ) {}

  onApplicationBootstrap(): void {
    // (a) adapter -> bridge
    this.adapter.on(
      'ai-setup-message',
      (event: { connectorId: string; message: Record<string, unknown> }) => {
        this.bridge.handleAgentMessage(event.connectorId, event.message);
      },
    );

    // (b) bridge -> gateway (relé para o web), resolvendo a company pelo registry
    this.bridge.on('audit', (event: { connectorId: string; message: IAuditEventMessage }) => {
      const companyId = this.registry.get(event.message.sessionId)?.companyId;
      if (companyId) {
        this.gateway.emitAuditEvent(companyId, event.message);
      }
    });
    this.bridge.on('state', (event: { connectorId: string; message: IAiSessionStateMessage }) => {
      const companyId = this.registry.get(event.message.sessionId)?.companyId;
      if (companyId) {
        this.registry.updatePhase(event.message.sessionId, event.message.phase);
        this.gateway.emitSessionState(companyId, event.message);
      }
    });
    this.bridge.on(
      'mapping',
      (event: { connectorId: string; message: IMappingProposedMessage }) => {
        const companyId = this.registry.get(event.message.sessionId)?.companyId;
        if (companyId) {
          this.gateway.emitMappingProposed(companyId, event.message);
        }
      },
    );

    // (c) gateway -> facade (somente decisão/abort; o ai.session.start NÃO vem
    // do socket — o gatilho da sessão é o POST REST do AiSetupController)
    this.gateway.onMappingDecision((input) => this.facade.handleDecision(input));
    this.gateway.onSessionAbort((input) => this.facade.handleAbort(input));
  }
}
```

Antes de criar o módulo, exporte o repositório que a facade precisa. Em
`src/modules/agent-identities/agent-identities.module.ts`, adicione
`AgentConnectorRepository` ao array `exports` (ele já está em `providers`):

```typescript
// exports: [AgentIdentityService, AgentConnectorAuthService, AgentConnectorWebSocketAdapter, AgentConnectorRepository]
```

Crie `src/modules/ai-setup/ai-setup.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { RedisModule } from '@/common/redis/redis.module';
import { AgentIdentitiesModule } from '@modules/agent-identities/agent-identities.module';

import { AiSetupWiring } from './ai-setup.wiring';
import { AiSetupController } from './controllers/ai-setup.controller';
import { AiSessionConnectorBridge } from './gateways/ai-session-connector-bridge';
import { AiSetupGateway } from './gateways/ai-setup.gateway';
import {
  AnthropicMessagesClient,
  ANTHROPIC_MESSAGES_CLIENT,
} from './services/anthropic-messages.client';
import { AiSetupFacade } from './services/ai-setup.facade';
import { AiSetupOrchestratorService } from './services/ai-setup-orchestrator.service';
import { AiSetupSessionRegistry } from './services/ai-setup-session.registry';
import { CatalogToToolsTranslator } from './services/catalog-to-tools.translator';

@Module({
  imports: [ConfigModule, RedisModule, AgentIdentitiesModule],
  controllers: [AiSetupController],
  providers: [
    AiSessionConnectorBridge,
    CatalogToToolsTranslator,
    AiSetupSessionRegistry,
    AiSetupOrchestratorService,
    AiSetupFacade,
    AiSetupGateway,
    AiSetupWiring,
    AnthropicMessagesClient,
    { provide: ANTHROPIC_MESSAGES_CLIENT, useExisting: AnthropicMessagesClient },
  ],
  exports: [AiSetupFacade],
})
export class AiSetupModule {}
```

Registre no `AppModule` (`src/app.module.ts`): adicione `AiSetupModule` ao array `imports`.

```typescript
import { AiSetupModule } from '@modules/ai-setup/ai-setup.module';
// ... dentro de @Module({ imports: [ ..., AiSetupModule ] })
```

### 14.4 Run (espera PASS)

```bash
pnpm run vitest:unit src/modules/ai-setup/ai-setup.wiring.test.ts
```

Saída esperada: 3 testes passam. Rode também a suíte unit do módulo inteiro:

```bash
pnpm run vitest:unit src/modules/ai-setup
```

Saída esperada: todos os testes unit do módulo passam.

### 14.5 Commit

```bash
git add src/modules/ai-setup/ai-setup.module.ts \
        src/modules/ai-setup/ai-setup.wiring.ts \
        src/modules/ai-setup/ai-setup.wiring.test.ts \
        src/modules/agent-identities/agent-identities.module.ts \
        src/app.module.ts
git commit -m "feat(ai-setup): módulo NestJS + wiring de eventos agente<->web

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 15 — Integration test: gateway recebe `audit.event` e envia `mapping.decision`

**Objetivo:** Int test ponta-a-ponta do canal web↔neo↔agente, modelando o agente via um WS mock conectado no `/connectors/ws` (como em `agent-connector-websocket.adapter.int.test.ts`) e o web via `socket.io-client` (como em `ticket.gateway.redis.int.test.ts`). O web (a) entra na sala via `emit('company', companyId)` — sem `ai.session.start` no socket; (b) recebe `audit.event` quando o agente emite o envelope; (c) emite `mapping.decision` e o neo encaminha o `mapping.decision` ao agente. A sessão é iniciada pelo gatilho canônico `facade.startSession({ companyId })` (o que o POST REST faz), que resolve o connector ativo da company internamente.

### 15.1 Write failing test (int)

Crie `src/modules/ai-setup/tests/ai-setup.int.test.ts`:

```typescript
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { type Socket as ClientSocket, io as ioClient } from 'socket.io-client';
import { v4 as uuid } from 'uuid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { CompanyFactory } from '@/common/utils/tests/factories/company.factory';
import { testDb } from '@/common/utils/tests/integration-setup';
import { RedisIoAdapter } from '@/common/websocket/redis-io.adapter';
import { DRIZZLE, DrizzleModule } from '@/drizzle/drizzle.module';
import { AiSetupModule } from '@modules/ai-setup/ai-setup.module';
import { ANTHROPIC_MESSAGES_CLIENT } from '@modules/ai-setup/services/anthropic-messages.client';
import { AiSetupFacade } from '@modules/ai-setup/services/ai-setup.facade';
import { CONNECTOR_WS_PATH } from '@modules/agent-identities/gateways/agent-connector-websocket.adapter';
import { AgentConnectorRepository } from '@modules/agent-identities/repositories/agent-connector.repository';
import { ConnectorTokenService } from '@modules/agent-identities/services/connector-token.service';

const SUT = 'ai-setup-gateway-relay';

// LLM stub determinístico: nunca chama API real; encerra sem propor mapping.
const llmStub = {
  createMessage: async () => ({ id: 'm', stop_reason: 'end_turn', content: [] }),
};

function createTestDrizzleModule(db: typeof testDb) {
  return {
    module: class TestDrizzleModule {},
    providers: [{ provide: DRIZZLE, useValue: db }],
    exports: [DRIZZLE],
  };
}

describe(`Teste de Integração: ${SUT}`, () => {
  let app: INestApplication;
  let port: number;
  let facade: AiSetupFacade;
  let repository: AgentConnectorRepository;
  let tokenService: ConnectorTokenService;
  const openSockets: WebSocket[] = [];
  const openClients: ClientSocket[] = [];

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.test', '.env'] }),
        AiSetupModule,
      ],
    })
      .overrideModule(DrizzleModule)
      .useModule(createTestDrizzleModule(testDb))
      .overrideProvider(ANTHROPIC_MESSAGES_CLIENT)
      .useValue(llmStub)
      .compile();

    app = moduleRef.createNestApplication();
    const adapter = new RedisIoAdapter(app);
    await adapter.connectToRedis();
    app.useWebSocketAdapter(adapter);
    await app.init();
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;

    facade = app.get(AiSetupFacade);
    repository = new AgentConnectorRepository(testDb);
    tokenService = new ConnectorTokenService();
  }, 60_000);

  afterEach(async () => {
    for (const ws of openSockets) ws.close();
    for (const c of openClients) c.disconnect();
    openSockets.length = 0;
    openClients.length = 0;
    await app.close();
  });

  async function seedConnector(companyId: number): Promise<{ rawToken: string; connectorId: string }> {
    const rawToken = tokenService.generateToken();
    const tokenHash = tokenService.hashToken(rawToken);
    const setup = await repository.ensureActiveStoreAndConnector({
      companyId,
      storeId: uuid(),
      connectorId: uuid(),
      tokenHash,
    });
    return { rawToken, connectorId: setup.connector.id };
  }

  function openAgent(rawToken: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${CONNECTOR_WS_PATH}`, {
        headers: { Authorization: `Bearer ${rawToken}` },
      });
      openSockets.push(ws);
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
  }

  function openWebClient(companyId: number): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const client = ioClient(`http://127.0.0.1:${port}`, {
        transports: ['websocket'],
        forceNew: true,
      });
      openClients.push(client);
      client.on('connect', () => {
        client.emit('company', companyId);
        setTimeout(() => resolve(client), 200);
      });
      client.on('connect_error', reject);
    });
  }

  it('cliente socket.io recebe audit.event emitido pelo agente', async () => {
    const company = await CompanyFactory.create(testDb);
    const { rawToken } = await seedConnector(company.id);
    const agent = await openAgent(rawToken);
    const client = await openWebClient(company.id);

    // inicia sessão via o gatilho canônico: o facade resolve o connector ativo
    // da company (mesmo connector seedado) e registra company<->connector<->sessionId
    const { sessionId } = await facade.startSession({ companyId: company.id });

    const received = new Promise<unknown>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout audit.event')), 10_000);
      client.on('audit.event', (payload: unknown) => {
        clearTimeout(t);
        resolve(payload);
      });
    });

    // agente emite audit.event
    agent.send(
      JSON.stringify({
        type: 'audit.event',
        sessionId,
        seq: 1,
        at: new Date().toISOString(),
        kind: 'tool_invoked',
        tool: 'probe.engines',
        summary: 'Probing engines',
      }),
    );

    const payload = await received;
    expect(payload).toMatchObject({ type: 'audit.event', sessionId, tool: 'probe.engines' });
  }, 20_000);

  it('cliente socket.io que envia mapping.decision faz o neo encaminhar ao agente', async () => {
    const company = await CompanyFactory.create(testDb);
    const { rawToken } = await seedConnector(company.id);
    const agent = await openAgent(rawToken);
    const client = await openWebClient(company.id);

    const { sessionId } = await facade.startSession({ companyId: company.id });

    const agentReceived = new Promise<unknown>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout mapping.decision no agente')), 10_000);
      agent.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as { type?: string };
        if (msg.type === 'mapping.decision') {
          clearTimeout(t);
          resolve(msg);
        }
      });
    });

    client.emit('mapping.decision', { sessionId, decision: 'approve' });

    const msg = await agentReceived;
    expect(msg).toMatchObject({ type: 'mapping.decision', sessionId, decision: 'approve' });
  }, 20_000);
});
```

### 15.2 Run (espera FAIL primeiro, depois PASS)

```bash
pnpm run vitest:integration src/modules/ai-setup/tests/ai-setup.int.test.ts
```

Saída esperada (após o módulo estar cabeado nas Tasks 1–14): 2 testes passam. Caso falhe por `companyId` ausente ao resolver o relé, confirme que `facade.startSession` foi chamado **antes** de o agente emitir o envelope (a ordem no teste já garante isso) e que `AiSetupWiring.onApplicationBootstrap` rodou (o `RedisIoAdapter` + `app.init()` dispara o lifecycle).

> Pré-requisito de ambiente: o int test sobe Redis e o DB de teste — rode com a infra de integração ativa, p.ex. via `pnpm run test:db:init` (uma vez) e `pnpm run vitest:integration ...` como acima. Não chama a API da Anthropic (LLM é stub).

### 15.3 Commit

```bash
git add src/modules/ai-setup/tests/ai-setup.int.test.ts
git commit -m "test(ai-setup): integração do relé socket.io agente<->web

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 16 — Verificação final da suíte

**Objetivo:** Garantir que toda a suíte unit e a int do módulo passam e que o typecheck não quebrou.

### 16.1 Run

```bash
pnpm run vitest:unit src/modules/ai-setup
pnpm run vitest:unit src/modules/agent-identities/gateways
pnpm run typecheck
```

Saída esperada: todos os testes unit do `ai-setup` e dos gateways de `agent-identities` passam; `typecheck` sem erros.

### 16.2 Run (integração — requer infra)

```bash
pnpm run vitest:integration src/modules/ai-setup/tests/ai-setup.int.test.ts
```

Saída esperada: 2 testes passam.

### 16.3 Commit (se houve ajustes de typecheck)

```bash
git add -A
git commit -m "chore(ai-setup): ajustes finais de tipos e verificação

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Cobertura do escopo 1–8:**

1. **Dependência `@anthropic-ai/sdk` + config (Task 1, 7):** `pnpm add @anthropic-ai/sdk` mostrado; `ANTHROPIC_API_KEY` via `ConfigService` (`ANTHROPIC_API_KEY_ENV`); modelo `claude-opus-4-8` default, sobrescrevível via `AI_SETUP_ANTHROPIC_MODEL` (`AI_SETUP_DEFAULT_MODEL` + parâmetro `model` em `runSession`). ✔
2. **Estender o canal agente↔neo (Tasks 3, 4, 5, 10):** `AiSessionConnectorBridge` envia `ai.session.start`/`tool.invoke`/`mapping.decision`/`ai.session.abort` e recebe `ai.catalog`/`tool.result`/`audit.event`/`mapping.proposed`/`ai.session.state`. `tool.invoke` tem timeout (`AI_TOOL_INVOKE_TIMEOUT_MS`) + correlação por `invocationId` (Map `pendingInvocations`, espelhando `pendingProbeRequests`). Reuso do socket autenticado via `sendRawToConnector`; recepção via `adapter.on('ai-setup-message')`. ✔
3. **Tradutor catálogo→tools (Task 6):** `CatalogToToolsTranslator.translate` mapeia `name`/`description`/`input_schema`. ✔
4. **Loop agentic mockável (Tasks 7, 9):** `AiSetupOrchestratorService.runSession` roda tool-use, devolve `tool_result` ao modelo, monta `IConnectorCatalogMappingConfig` e dispara `mapping.proposed`; guardas `AI_SESSION_MAX_INVOCATIONS`/`AI_SESSION_TIMEOUT_MS`; LLM injetado por `ANTHROPIC_MESSAGES_CLIENT` (mock determinístico nos testes — script de `tool_use` verificando `ValidatedMappingConfig` válido e a sequência de `tool.invoke`). ✔
5. **Gateway socket.io novo (Task 11):** `AiSetupGateway` segue `TicketGateway`; o web entra na sala via `@SubscribeMessage('company')` → `client.join('company:'+id)`; relaya `audit.event`/`ai.session.state`/`mapping.proposed` para `company:{id}`; recebe APENAS `mapping.decision`/`ai.session.abort` do web (SEM `ai.session.start` — a sessão é iniciada pelo POST REST). Reusa `RedisIoAdapter` global (registrado em `main.ts`; int test reusa o mesmo adapter). ✔
6. **Controller REST = gatilho único da sessão (Tasks 12, 13):** `AiSetupController extends BaseController`, company-scoped em `@Controller('pharma-agent-catalog/companies/:companyId/ai-setup')`, com `POST sessions` (sem `connectorId` na URL — `AiSetupFacade.startSession({ companyId })` resolve o connector ativo via `AgentConnectorRepository`, registra a sessão, dispara `ai.session.start` neo→agente e o loop do orchestrator parte ao chegar o `ai.catalog`) e `GET sessions/:sessionId`, envelope `ok()`. ✔
7. **Módulo NestJS novo (Task 14):** `AiSetupModule` com providers/controllers/exports, importando `AgentIdentitiesModule`/`RedisModule`/`ConfigModule`; registrado no `AppModule`. ✔
8. **Testes (Tasks 6, 9, 15):** unit do tradutor (Task 6) e do loop com LLM mockado (Task 9, script determinístico → verifica `ValidatedMappingConfig` válido e sequência de `tool.invoke`); int test do gateway (Task 15) com cliente socket.io recebendo `audit.event` e enviando `mapping.decision`, modelando o agente via WS mock como em `agent-connector-websocket.adapter.int.test.ts`. ✔

**Placeholders:** Nenhum `TODO`/"similar to Task N" no código dos steps — todo step traz código completo (decorators, DI, símbolos reais: `requestProbeAdminCommand`/`pendingProbeRequests` (referenciados como padrão), `sendRawToConnector`, `server.to().emit`, `ConfigService`, `BaseController.ok`). A única dependência intencional entre tasks (stub mínimo do `AiSetupFacade` na Task 12, implementação real na Task 13) está explicitada e o stub é código real e compilável.

**Consistência com o CONTRATO CANÔNICO:**
- Tool names: os 14 nomes do catálogo cravados em `AI_SETUP_TOOL_NAMES` exatamente como no contrato. ✔
- Envelopes neo→agente: `ai.session.start{sessionId}`, `tool.invoke{sessionId,invocationId,name,input?}`, `mapping.decision{sessionId,decision,editedMapping?}`, `ai.session.abort{sessionId,reason}` — produzidos no bridge exatamente assim. ✔
- Envelopes agente→neo: `ai.catalog{sessionId,catalogVersion,tools}`, `tool.result{sessionId,invocationId,ok,payload?,errorCode?}`, `audit.event{sessionId,seq,at,kind,tool?,summary,detail?}`, `mapping.proposed{sessionId,mapping,rationale,previewRows}`, `ai.session.state{sessionId,phase}` — tipados nas interfaces e tratados no bridge. ✔
- `ToolDescriptor={name,description,inputSchema,outputSchema}` — `IToolDescriptor`. ✔
- `ValidatedMappingConfig` = formato do agente: mapeado para `IConnectorCatalogMappingConfig` (`snapshotQuery`/`incrementalQuery` + `fields{sourceProductCode,name,price,stock,barcode,active,sourceUpdatedAt}` + `syncMode`/`cursor...`), que é o tipo que `connector.config` já transporta e o poller consome (Contrato 3 — "sem formato novo"). ✔
- Eventos socket.io neo→web: emitidos como `"audit.event"`, `"ai.session.state"`, `"mapping.proposed"` para a sala da company; web→neo recebidos `"company"` (join na sala), `"mapping.decision"`, `"ai.session.abort"`. O `"ai.session.start"` NÃO trafega no socket — é o POST REST que inicia a sessão (e o bridge o repassa neo→agente). ✔

**Suposições feitas:**
1. `AgentConnectorWebSocketAdapter` é exportado por `AgentIdentitiesModule` (confirmado no `exports`), então `AiSetupModule` o obtém via DI importando o módulo.
2. `connector.config` / poller já consomem `IConnectorCatalogMappingConfig`; o orchestrator entrega exatamente esse tipo no `mapping.proposed` (Contrato 3). O agente é quem persiste ao aprovar (`connector.bootstrap.dbConfig` + `connector.config`) — fora do escopo deste plano.
3. A autenticação do gateway socket.io segue o padrão de `TicketGateway` (sem guard de auth no handshake; o cliente entra na sala via `emit('company', id)`). Como o web nunca fala direto com o agente e o relé é filtrado por `companyId`, isso espelha o gateway existente; se a frente exigir auth no handshake, é um incremento localizado no `handleConnection`.
4. `RedisIoAdapter` é global (registrado em `main.ts` via `app.useWebSocketAdapter`), então o `AiSetupGateway` participa do fan-out Redis sem config extra — o int test recria o adapter como em `ticket.gateway.redis.int.test.ts`.
5. Prompt caching: aplicado no system prompt (estável entre iterações). Não cacheei `tools` separadamente porque o array de tools muda por sessão (catálogo do agente) e o SDK renderiza `tools` antes do system; a marcação no último bloco de system cobre tools+system juntos por construção do prefix-match — adequado ao loop multi-iteração de uma mesma sessão.
6. Modelo default `claude-opus-4-8` (instrução do escopo); thinking/effort não foram setados no wrapper para manter o request mínimo e determinístico nos testes — podem ser adicionados como incremento sem quebrar a interface `ICreateMessageParams`.
7. `AgentConnectorRepository.ensureActiveStoreAndConnector` e `ConnectorTokenService` têm a mesma assinatura usada no int test existente de `agent-identities` (confirmado).
