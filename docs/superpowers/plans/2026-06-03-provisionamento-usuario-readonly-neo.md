# Provisionamento de usuário read-only (NEO) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar ao módulo `ai-setup` da neo-api o Contrato B do provisionamento de usuário read-only: pausar o loop agentic quando o LLM chama o sinal `propose_readonly_user`, propor ao painel (socket.io), aguardar a decisão humana, invocar o comando admin `connector.provisionReadonlyUser` ao conector (correlacionado/timeout) e resolver o `tool.result` do sinal com o payload canônico.

**Architecture:** O orquestrador (loop agentic baseado em Anthropic tool-use) intercepta a tool `propose_readonly_user` e, em vez de despachar via `bridge.invokeTool`, delega a uma rotina de pausa/retomada que registra a proposta pendente, emite `provision.proposed` ao painel, espera `provision.decision` (com timeout que vira `reject`), e — se aprovado — chama um novo método da bridge que envia `connector.provisionReadonlyUser` correlacionado por `requestId`+timeout. O resultado do conector vira `provision.result` ao painel e resolve o `tool.result` do sinal de volta ao LLM. A fase `provisioning` entra entre `credentials` e `schema`.

**Tech Stack:** NestJS, TypeScript, EventEmitter (bridge), socket.io (gateway painel↔neo), raw WebSocket (`AgentConnectorWebSocketAdapter`), vitest (`pnpm run vitest:unit <arquivo>` / `vitest:integration`), socket.io-client + `ws` (integração). Exceptions de `@/common/exceptions/app.exception`.

> **NOTA — refactor de provider de LLM (DeepSeek):** existe um plano separado, ainda NÃO executado, de troca do provider de LLM. Este plano é escrito contra o **código ATUAL** do orquestrador (`AiSetupOrchestratorService`, baseado em `@anthropic-ai/sdk` / `Anthropic.ToolUseBlock`). Se o refactor de provider entrar antes, a lógica de pausa/retomada do `propose_readonly_user` é **idêntica**: só muda a forma de despachar/identificar o `tool_use` (passa a usar tipos neutros em vez de `Anthropic.ToolUseBlock`). A interceptação por **nome da tool** (`propose_readonly_user`) e o payload canônico de retorno não mudam.

---

## Contrato canônico (fonte de verdade — NÃO alterar nomes)

- **Sinal no catálogo do LLM:** `propose_readonly_user` `{ username, rationale? }` → output `{ accepted, username, engine }`.
- **Comando admin (neo→agente, fora do catálogo):** `{ type:"connector.provisionReadonlyUser", requestId, sessionId, username }` → `{ type:"connector.provisionReadonlyUser.result", requestId, sessionId, outcome:"provisioned"|"fallback_no_privilege"|"unsupported_engine"|"error", username, grantedScope:"all_tables", errorCode? }`. Timeout `AI_PROVISION_TIMEOUT_MS = 30000`.
- **socket.io neo→web (sala `company:{id}`):** `"provision.proposed"` `{ sessionId, username, engine, scope:"all_tables", readOnly:true, rationale? }`; `"provision.result"` `{ sessionId, outcome, username, errorCode? }`. web→neo: `"provision.decision"` `{ sessionId, decision:"approve"|"reject" }`.
- **Pausa/retomada:** ao receber `tool.invoke` de `propose_readonly_user`, NÃO resolve o `tool.result`; registra `pendingProvision[sessionId]`; emite `provision.proposed`; aguarda `provision.decision` (timeout `AI_PROVISION_DECISION_TIMEOUT_MS = 600000` → `reject`). `approve` → invoca `connector.provisionReadonlyUser` → ao receber result, emite `provision.result` e RESOLVE o `tool.result` do sinal com `{ provisioned:true, activeCredential:"readonly_user", username }` (ou em fallback/erro/reject: `{ provisioned:false, activeCredential:"discovered", reason:"no_privilege|unsupported|error|rejected" }`). Decisão **idempotente** por `sessionId`. Fase `ai.session.state` `provisioning` (entre `credentials` e `schema`). Web só fala com o neo. `provision.*` **nunca** carrega senha.

---

## File Structure

### Criados

- `src/modules/ai-setup/constants/ai-setup-provisioning.constants.ts` — tipos de mensagem (`CONNECTOR_PROVISION_READONLY_USER_MESSAGE_TYPE`, `CONNECTOR_PROVISION_READONLY_USER_RESULT_MESSAGE_TYPE`), eventos socket.io (`PROVISION_PROPOSED_EVENT`, `PROVISION_RESULT_EVENT`, `PROVISION_DECISION_EVENT`), nome da tool de sinal (`PROPOSE_READONLY_USER_TOOL_NAME`), timeouts (`AI_PROVISION_TIMEOUT_MS`, `AI_PROVISION_DECISION_TIMEOUT_MS`) e escopo (`PROVISION_GRANTED_SCOPE = 'all_tables'`).
- `src/modules/ai-setup/interfaces/ai-setup-provisioning.interface.ts` — DTOs dos envelopes: `IProvisionReadonlyUserCommand`, `IProvisionReadonlyUserResult`, `IProvisionProposedMessage`, `IProvisionResultMessage`, `IProvisionDecision`, `IProvisionSignalToolResult` (payload de volta ao LLM), tipo `ProvisionOutcome`.
- `src/modules/ai-setup/services/ai-setup-provisioning.service.ts` — orquestra a pausa/retomada: `pendingProvision` por `sessionId`, `proposeAndAwait(...)` (registra, emite proposed, espera decisão com timeout), `applyDecision(...)` (idempotente), montagem do payload canônico.
- `src/modules/ai-setup/services/ai-setup-provisioning.service.test.ts` — unit da pausa/retomada (approve/reject/timeout/fallback/idempotência).
- `src/modules/ai-setup/constants/ai-setup-provisioning.constants.test.ts` — congela os valores literais do contrato.

### Modificados

- `src/modules/ai-setup/interfaces/ai-setup-protocol.interface.ts` — adiciona `'provisioning'` ao union `AiSessionPhase`.
- `src/modules/ai-setup/gateways/ai-session-connector-bridge.ts` — `provisionReadonlyUser(connectorId, sessionId, username)` (correlação por `requestId` + timeout `AI_PROVISION_TIMEOUT_MS`), tratamento do `.result` em `handleAgentMessage`, `emitProvisionProposed`/`emitProvisionResult` (re-emit via EventEmitter).
- `src/modules/ai-setup/services/ai-setup-orchestrator.service.ts` — injeta `AiSetupProvisioningService`; intercepta `tool_use` de `propose_readonly_user` antes do `bridge.invokeTool`; resolve o `tool_result` com o payload do serviço; muda a fase para `provisioning`.
- `src/modules/ai-setup/gateways/ai-setup.gateway.ts` — `@SubscribeMessage('provision.decision')`, handler registrável `onProvisionDecision`, `emitProvisionProposed`/`emitProvisionResult`.
- `src/modules/ai-setup/services/ai-setup.facade.ts` — `handleProvisionDecision(...)` delega ao provisioning service via registry.
- `src/modules/ai-setup/ai-setup.wiring.ts` — liga `bridge('provision.proposed'|'provision.result')` → gateway e `gateway.onProvisionDecision` → facade.
- `src/modules/ai-setup/ai-setup.module.ts` — registra `AiSetupProvisioningService` nos providers.
- `src/modules/ai-setup/tests/ai-setup.int.test.ts` — adiciona teste de integração (web recebe `provision.proposed` e envia `provision.decision`).
- `src/modules/ai-setup/README.md` — documenta fase `provisioning`, envelopes e eventos.

---

## Task 1: Constantes do provisionamento

**Files:**
- Create: `src/modules/ai-setup/constants/ai-setup-provisioning.constants.ts`
- Test: `src/modules/ai-setup/constants/ai-setup-provisioning.constants.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/modules/ai-setup/constants/ai-setup-provisioning.constants.test.ts
import { describe, expect, it } from 'vitest';

import {
  AI_PROVISION_DECISION_TIMEOUT_MS,
  AI_PROVISION_TIMEOUT_MS,
  CONNECTOR_PROVISION_READONLY_USER_MESSAGE_TYPE,
  CONNECTOR_PROVISION_READONLY_USER_RESULT_MESSAGE_TYPE,
  PROPOSE_READONLY_USER_TOOL_NAME,
  PROVISION_DECISION_EVENT,
  PROVISION_GRANTED_SCOPE,
  PROVISION_PROPOSED_EVENT,
  PROVISION_RESULT_EVENT,
} from './ai-setup-provisioning.constants';

const SUT = 'ai-setup-provisioning-constants';

describe(`Teste Unitário: ${SUT}`, () => {
  it('congela os nomes canônicos do contrato (verbatim)', () => {
    expect(PROPOSE_READONLY_USER_TOOL_NAME).toBe('propose_readonly_user');
    expect(CONNECTOR_PROVISION_READONLY_USER_MESSAGE_TYPE).toBe('connector.provisionReadonlyUser');
    expect(CONNECTOR_PROVISION_READONLY_USER_RESULT_MESSAGE_TYPE).toBe(
      'connector.provisionReadonlyUser.result',
    );
    expect(PROVISION_PROPOSED_EVENT).toBe('provision.proposed');
    expect(PROVISION_RESULT_EVENT).toBe('provision.result');
    expect(PROVISION_DECISION_EVENT).toBe('provision.decision');
    expect(PROVISION_GRANTED_SCOPE).toBe('all_tables');
  });

  it('congela os timeouts do contrato', () => {
    expect(AI_PROVISION_TIMEOUT_MS).toBe(30_000);
    expect(AI_PROVISION_DECISION_TIMEOUT_MS).toBe(600_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run vitest:unit src/modules/ai-setup/constants/ai-setup-provisioning.constants.test.ts`
Expected: FAIL — `Cannot find module './ai-setup-provisioning.constants'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/modules/ai-setup/constants/ai-setup-provisioning.constants.ts
// Contrato B — provisionamento de usuário read-only (envelopes + timeouts).

// Sinal read-only no catálogo do LLM (sem efeito no banco).
export const PROPOSE_READONLY_USER_TOOL_NAME = 'propose_readonly_user';

// Comando admin neo -> agente (FORA do catálogo) e seu resultado.
export const CONNECTOR_PROVISION_READONLY_USER_MESSAGE_TYPE = 'connector.provisionReadonlyUser';
export const CONNECTOR_PROVISION_READONLY_USER_RESULT_MESSAGE_TYPE =
  'connector.provisionReadonlyUser.result';

// Eventos socket.io neo <-> painel.
export const PROVISION_PROPOSED_EVENT = 'provision.proposed';
export const PROVISION_RESULT_EVENT = 'provision.result';
export const PROVISION_DECISION_EVENT = 'provision.decision';

// Escopo de leitura concedido (canônico).
export const PROVISION_GRANTED_SCOPE = 'all_tables';

// Timeout de correlação do comando admin (neo aguarda o .result do agente).
export const AI_PROVISION_TIMEOUT_MS = 30_000;

// Timeout da decisão humana no painel; ao expirar é tratado como 'reject'.
export const AI_PROVISION_DECISION_TIMEOUT_MS = 600_000;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm run vitest:unit src/modules/ai-setup/constants/ai-setup-provisioning.constants.test.ts`
Expected: PASS (2 testes).

- [ ] **Step 5: Commit**

```bash
git add src/modules/ai-setup/constants/ai-setup-provisioning.constants.ts src/modules/ai-setup/constants/ai-setup-provisioning.constants.test.ts
git commit -m "feat(ai-setup): constantes do provisionamento read-only

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Interfaces/DTOs dos envelopes de provisionamento

**Files:**
- Create: `src/modules/ai-setup/interfaces/ai-setup-provisioning.interface.ts`
- Modify: `src/modules/ai-setup/interfaces/ai-setup-protocol.interface.ts` (adiciona fase `provisioning`)

> Interfaces puras (sem runtime) não exigem teste próprio — são validadas pelos testes das tarefas que as consomem (3, 4, 5). A mudança de fase é validada no Task 6.

- [ ] **Step 1: Criar o arquivo de interfaces**

```typescript
// src/modules/ai-setup/interfaces/ai-setup-provisioning.interface.ts

// Resultado dos engines (canônico).
export type ProvisionOutcome =
  | 'provisioned'
  | 'fallback_no_privilege'
  | 'unsupported_engine'
  | 'error';

// neo -> agente: comando admin (SEM senha — gerada no agente).
export interface IProvisionReadonlyUserCommand {
  type: 'connector.provisionReadonlyUser';
  requestId: string;
  sessionId: string;
  username: string;
}

// agente -> neo: resultado do comando admin.
export interface IProvisionReadonlyUserResult {
  type: 'connector.provisionReadonlyUser.result';
  requestId: string;
  sessionId: string;
  outcome: ProvisionOutcome;
  username: string;
  grantedScope: 'all_tables';
  errorCode?: string;
}

// neo -> web (socket.io): proposta de provisionamento (NUNCA carrega senha).
export interface IProvisionProposedMessage {
  sessionId: string;
  username: string;
  engine: string;
  scope: 'all_tables';
  readOnly: true;
  rationale?: string;
}

// neo -> web (socket.io): resultado do provisionamento.
export interface IProvisionResultMessage {
  sessionId: string;
  outcome: ProvisionOutcome;
  username: string;
  errorCode?: string;
}

// web -> neo (socket.io): decisão humana.
export interface IProvisionDecision {
  sessionId: string;
  decision: 'approve' | 'reject';
}

// Payload do tool.result do sinal `propose_readonly_user` de volta ao LLM.
export type IProvisionSignalToolResult =
  | { provisioned: true; activeCredential: 'readonly_user'; username: string }
  | {
      provisioned: false;
      activeCredential: 'discovered';
      reason: 'no_privilege' | 'unsupported' | 'error' | 'rejected';
    };
```

- [ ] **Step 2: Adicionar a fase `provisioning` ao union de fases**

Em `src/modules/ai-setup/interfaces/ai-setup-protocol.interface.ts`, alterar o tipo `AiSessionPhase` (linhas 3-11) para incluir `'provisioning'` **entre** `'credentials'` e `'schema'`:

```typescript
export type AiSessionPhase =
  | 'discovering'
  | 'credentials'
  | 'provisioning'
  | 'schema'
  | 'proposing'
  | 'applying'
  | 'synced'
  | 'failed'
  | 'aborted';
```

- [ ] **Step 3: Verificar a compilação dos tipos**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: PASS — sem novos erros de tipo (arquivo de interfaces compila; o union novo é aceito em todos os usos existentes de `AiSessionPhase`).

- [ ] **Step 4: Commit**

```bash
git add src/modules/ai-setup/interfaces/ai-setup-provisioning.interface.ts src/modules/ai-setup/interfaces/ai-setup-protocol.interface.ts
git commit -m "feat(ai-setup): DTOs do provisionamento e fase provisioning

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Bridge — comando admin correlacionado + emits de provisionamento

**Files:**
- Modify: `src/modules/ai-setup/gateways/ai-session-connector-bridge.ts`
- Test: `src/modules/ai-setup/gateways/ai-session-connector-bridge.test.ts`

- [ ] **Step 1: Write the failing tests** (anexar ao `describe` existente)

```typescript
// adicionar ao final do describe em ai-session-connector-bridge.test.ts

  it('provisionReadonlyUser envia connector.provisionReadonlyUser e resolve no .result', async () => {
    const pending = bridge.provisionReadonlyUser('conn-1', 's1', 'pharma_connector_ro', 1_000);

    const sent = sendRaw.mock.calls[0][1] as {
      type: string;
      requestId: string;
      sessionId: string;
      username: string;
    };
    expect(sent.type).toBe('connector.provisionReadonlyUser');
    expect(sent.sessionId).toBe('s1');
    expect(sent.username).toBe('pharma_connector_ro');
    expect(typeof sent.requestId).toBe('string');

    bridge.handleAgentMessage('conn-1', {
      type: 'connector.provisionReadonlyUser.result',
      requestId: sent.requestId,
      sessionId: 's1',
      outcome: 'provisioned',
      username: 'pharma_connector_ro',
      grantedScope: 'all_tables',
    });

    await expect(pending).resolves.toEqual({
      type: 'connector.provisionReadonlyUser.result',
      requestId: sent.requestId,
      sessionId: 's1',
      outcome: 'provisioned',
      username: 'pharma_connector_ro',
      grantedScope: 'all_tables',
    });
  });

  it('provisionReadonlyUser rejeita por timeout quando o .result não chega', async () => {
    await expect(
      bridge.provisionReadonlyUser('conn-1', 's1', 'pharma_connector_ro', 20),
    ).rejects.toThrow(/timed out/);
  });

  it('provisionReadonlyUser ignora .result com requestId divergente (continua pendente)', async () => {
    const pending = bridge.provisionReadonlyUser('conn-1', 's1', 'pharma_connector_ro', 50);
    bridge.handleAgentMessage('conn-1', {
      type: 'connector.provisionReadonlyUser.result',
      requestId: 'outro-request',
      sessionId: 's1',
      outcome: 'provisioned',
      username: 'pharma_connector_ro',
      grantedScope: 'all_tables',
    });
    await expect(pending).rejects.toThrow(/timed out/);
  });

  it('emitProvisionProposed e emitProvisionResult re-emitem os eventos', () => {
    const proposed = vi.fn();
    const result = vi.fn();
    bridge.on('provision.proposed', proposed);
    bridge.on('provision.result', result);

    const proposedMsg = {
      sessionId: 's1',
      username: 'pharma_connector_ro',
      engine: 'mysql',
      scope: 'all_tables' as const,
      readOnly: true as const,
    };
    const resultMsg = {
      sessionId: 's1',
      outcome: 'provisioned' as const,
      username: 'pharma_connector_ro',
    };
    bridge.emitProvisionProposed('conn-1', proposedMsg);
    bridge.emitProvisionResult('conn-1', resultMsg);

    expect(proposed).toHaveBeenCalledWith({ connectorId: 'conn-1', message: proposedMsg });
    expect(result).toHaveBeenCalledWith({ connectorId: 'conn-1', message: resultMsg });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm run vitest:unit src/modules/ai-setup/gateways/ai-session-connector-bridge.test.ts`
Expected: FAIL — `bridge.provisionReadonlyUser is not a function` (e os emits).

- [ ] **Step 3: Write the implementation**

Em `ai-session-connector-bridge.ts`:

Adicionar imports (junto aos constants existentes):

```typescript
import {
  AI_PROVISION_TIMEOUT_MS,
  CONNECTOR_PROVISION_READONLY_USER_MESSAGE_TYPE,
  CONNECTOR_PROVISION_READONLY_USER_RESULT_MESSAGE_TYPE,
} from '../constants/ai-setup-provisioning.constants';
import type {
  IProvisionProposedMessage,
  IProvisionReadonlyUserResult,
  IProvisionResultMessage,
} from '../interfaces/ai-setup-provisioning.interface';
```

Adicionar a interface de pendência e o mapa, logo após `PendingToolInvocation`:

```typescript
interface PendingProvision {
  sessionId: string;
  resolve: (result: IProvisionReadonlyUserResult) => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}
```

E como campo da classe (junto a `pendingInvocations`):

```typescript
  private readonly pendingProvisions = new Map<string, PendingProvision>();
```

Adicionar os métodos públicos (próximos a `invokeTool`):

```typescript
  provisionReadonlyUser(
    connectorId: string,
    sessionId: string,
    username: string,
    timeoutMs: number = AI_PROVISION_TIMEOUT_MS,
  ): Promise<IProvisionReadonlyUserResult> {
    const requestId = uuid();

    return new Promise<IProvisionReadonlyUserResult>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingProvisions.delete(requestId);
        logger.warn(
          { module: MODULE, action: 'ai_provision_timeout', connectorId, sessionId, username },
          'connector.provisionReadonlyUser expirou',
        );
        reject(
          new Error(`connector.provisionReadonlyUser timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);

      this.pendingProvisions.set(requestId, { sessionId, resolve, reject, timeoutHandle });

      try {
        this.connectorAdapter.sendRawToConnector(connectorId, {
          type: CONNECTOR_PROVISION_READONLY_USER_MESSAGE_TYPE,
          requestId,
          sessionId,
          username,
        });
      } catch (error) {
        clearTimeout(timeoutHandle);
        this.pendingProvisions.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  emitProvisionProposed(connectorId: string, message: IProvisionProposedMessage): void {
    this.emit('provision.proposed', { connectorId, message });
  }

  emitProvisionResult(connectorId: string, message: IProvisionResultMessage): void {
    this.emit('provision.result', { connectorId, message });
  }
```

No `switch` de `handleAgentMessage`, adicionar (antes do `default`):

```typescript
      case CONNECTOR_PROVISION_READONLY_USER_RESULT_MESSAGE_TYPE:
        this.resolveProvisionResult(message as unknown as IProvisionReadonlyUserResult);
        return;
```

E o resolvedor privado (junto a `resolveToolResult`):

```typescript
  private resolveProvisionResult(message: IProvisionReadonlyUserResult): void {
    const requestId = typeof message.requestId === 'string' ? message.requestId : undefined;
    if (!requestId) {
      return;
    }
    const pending = this.pendingProvisions.get(requestId);
    if (!pending) {
      // Idempotência: resultado repetido/desconhecido é ignorado.
      return;
    }
    if (typeof message.sessionId === 'string' && message.sessionId !== pending.sessionId) {
      return;
    }
    clearTimeout(pending.timeoutHandle);
    this.pendingProvisions.delete(requestId);
    pending.resolve(message);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm run vitest:unit src/modules/ai-setup/gateways/ai-session-connector-bridge.test.ts`
Expected: PASS (testes existentes + 4 novos).

- [ ] **Step 5: Commit**

```bash
git add src/modules/ai-setup/gateways/ai-session-connector-bridge.ts src/modules/ai-setup/gateways/ai-session-connector-bridge.test.ts
git commit -m "feat(ai-setup): bridge envia connector.provisionReadonlyUser correlacionado

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Serviço de pausa/retomada do provisionamento

**Files:**
- Create: `src/modules/ai-setup/services/ai-setup-provisioning.service.ts`
- Test: `src/modules/ai-setup/services/ai-setup-provisioning.service.test.ts`

> Este serviço NÃO conhece o LLM. Ele expõe `proposeAndAwait(...)` que: registra `pendingProvision[sessionId]`, emite `provision.proposed` pela bridge, aguarda `applyDecision(...)` (chamada pela facade ao chegar `provision.decision`), e — em `approve` — invoca `bridge.provisionReadonlyUser`, emite `provision.result` e devolve o payload canônico ao chamador (orquestrador). Em `reject`/timeout/fallback/error devolve o payload de fallback. `applyDecision` é idempotente por `sessionId`.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/modules/ai-setup/services/ai-setup-provisioning.service.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiSetupProvisioningService } from './ai-setup-provisioning.service';

vi.mock('@/common/utils/enhanced-logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SUT = 'ai-setup-provisioning-service';

interface BridgeMock {
  provisionReadonlyUser: ReturnType<typeof vi.fn>;
  emitProvisionProposed: ReturnType<typeof vi.fn>;
  emitProvisionResult: ReturnType<typeof vi.fn>;
}

const BASE = {
  connectorId: 'conn-1',
  sessionId: 's1',
  username: 'pharma_connector_ro',
  engine: 'mysql',
  rationale: 'least privilege',
};

describe(`Teste Unitário: ${SUT}`, () => {
  let bridge: BridgeMock;
  let service: AiSetupProvisioningService;

  beforeEach(() => {
    bridge = {
      provisionReadonlyUser: vi.fn(),
      emitProvisionProposed: vi.fn(),
      emitProvisionResult: vi.fn(),
    };
    service = new AiSetupProvisioningService(bridge as never);
  });

  afterEach(() => vi.clearAllMocks());

  it('emite provision.proposed (sem senha) ao iniciar a proposta', async () => {
    const promise = service.proposeAndAwait(BASE, { decisionTimeoutMs: 10_000 });
    expect(bridge.emitProvisionProposed).toHaveBeenCalledWith('conn-1', {
      sessionId: 's1',
      username: 'pharma_connector_ro',
      engine: 'mysql',
      scope: 'all_tables',
      readOnly: true,
      rationale: 'least privilege',
    });
    // resolve para não vazar timer
    service.applyDecision({ sessionId: 's1', decision: 'reject' });
    await promise;
  });

  it('approve -> provisioned: invoca o comando admin, emite provision.result e devolve payload readonly', async () => {
    bridge.provisionReadonlyUser.mockResolvedValueOnce({
      type: 'connector.provisionReadonlyUser.result',
      requestId: 'r1',
      sessionId: 's1',
      outcome: 'provisioned',
      username: 'pharma_connector_ro',
      grantedScope: 'all_tables',
    });

    const promise = service.proposeAndAwait(BASE, { decisionTimeoutMs: 10_000 });
    service.applyDecision({ sessionId: 's1', decision: 'approve' });
    const payload = await promise;

    expect(bridge.provisionReadonlyUser).toHaveBeenCalledWith('conn-1', 's1', 'pharma_connector_ro');
    expect(bridge.emitProvisionResult).toHaveBeenCalledWith('conn-1', {
      sessionId: 's1',
      outcome: 'provisioned',
      username: 'pharma_connector_ro',
    });
    expect(payload).toEqual({
      provisioned: true,
      activeCredential: 'readonly_user',
      username: 'pharma_connector_ro',
    });
  });

  it('reject -> devolve fallback discovered/rejected, sem invocar o comando admin', async () => {
    const promise = service.proposeAndAwait(BASE, { decisionTimeoutMs: 10_000 });
    service.applyDecision({ sessionId: 's1', decision: 'reject' });
    const payload = await promise;

    expect(bridge.provisionReadonlyUser).not.toHaveBeenCalled();
    expect(payload).toEqual({
      provisioned: false,
      activeCredential: 'discovered',
      reason: 'rejected',
    });
  });

  it('timeout da decisão -> tratado como reject', async () => {
    vi.useFakeTimers();
    const promise = service.proposeAndAwait(BASE, { decisionTimeoutMs: 600_000 });
    await vi.advanceTimersByTimeAsync(600_000);
    const payload = await promise;
    expect(bridge.provisionReadonlyUser).not.toHaveBeenCalled();
    expect(payload).toEqual({
      provisioned: false,
      activeCredential: 'discovered',
      reason: 'rejected',
    });
    vi.useRealTimers();
  });

  it.each([
    ['fallback_no_privilege', 'no_privilege'],
    ['unsupported_engine', 'unsupported'],
    ['error', 'error'],
  ])('approve -> outcome %s vira fallback discovered/%s', async (outcome, reason) => {
    bridge.provisionReadonlyUser.mockResolvedValueOnce({
      type: 'connector.provisionReadonlyUser.result',
      requestId: 'r1',
      sessionId: 's1',
      outcome,
      username: 'pharma_connector_ro',
      grantedScope: 'all_tables',
      ...(outcome === 'error' ? { errorCode: 'syntax' } : {}),
    });

    const promise = service.proposeAndAwait(BASE, { decisionTimeoutMs: 10_000 });
    service.applyDecision({ sessionId: 's1', decision: 'approve' });
    const payload = await promise;

    expect(bridge.emitProvisionResult).toHaveBeenCalledWith('conn-1', {
      sessionId: 's1',
      outcome,
      username: 'pharma_connector_ro',
      ...(outcome === 'error' ? { errorCode: 'syntax' } : {}),
    });
    expect(payload).toEqual({
      provisioned: false,
      activeCredential: 'discovered',
      reason,
    });
  });

  it('approve com a invocação do comando admin lançando -> fallback discovered/error', async () => {
    bridge.provisionReadonlyUser.mockRejectedValueOnce(new Error('timed out'));

    const promise = service.proposeAndAwait(BASE, { decisionTimeoutMs: 10_000 });
    service.applyDecision({ sessionId: 's1', decision: 'approve' });
    const payload = await promise;

    expect(bridge.emitProvisionResult).toHaveBeenCalledWith('conn-1', {
      sessionId: 's1',
      outcome: 'error',
      username: 'pharma_connector_ro',
      errorCode: 'timeout',
    });
    expect(payload).toEqual({
      provisioned: false,
      activeCredential: 'discovered',
      reason: 'error',
    });
  });

  it('applyDecision é idempotente por sessionId (segunda decisão é ignorada)', async () => {
    bridge.provisionReadonlyUser.mockResolvedValueOnce({
      type: 'connector.provisionReadonlyUser.result',
      requestId: 'r1',
      sessionId: 's1',
      outcome: 'provisioned',
      username: 'pharma_connector_ro',
      grantedScope: 'all_tables',
    });

    const promise = service.proposeAndAwait(BASE, { decisionTimeoutMs: 10_000 });
    service.applyDecision({ sessionId: 's1', decision: 'approve' });
    service.applyDecision({ sessionId: 's1', decision: 'reject' }); // ignorada
    await promise;

    expect(bridge.provisionReadonlyUser).toHaveBeenCalledTimes(1);
  });

  it('applyDecision para sessionId sem pendência é no-op', () => {
    expect(() =>
      service.applyDecision({ sessionId: 'inexistente', decision: 'approve' }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm run vitest:unit src/modules/ai-setup/services/ai-setup-provisioning.service.test.ts`
Expected: FAIL — `Cannot find module './ai-setup-provisioning.service'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/modules/ai-setup/services/ai-setup-provisioning.service.ts
import { Injectable } from '@nestjs/common';

import { logger } from '@/common/utils/enhanced-logger';

import {
  AI_PROVISION_DECISION_TIMEOUT_MS,
  PROVISION_GRANTED_SCOPE,
} from '../constants/ai-setup-provisioning.constants';
import { AiSessionConnectorBridge } from '../gateways/ai-session-connector-bridge';
import type {
  IProvisionDecision,
  IProvisionSignalToolResult,
  ProvisionOutcome,
} from '../interfaces/ai-setup-provisioning.interface';

const MODULE = 'AiSetupProvisioningService';

export interface IProposeProvisionInput {
  connectorId: string;
  sessionId: string;
  username: string;
  engine: string;
  rationale?: string;
}

export interface IProposeProvisionOptions {
  decisionTimeoutMs?: number;
}

interface PendingProvision {
  connectorId: string;
  username: string;
  resolveDecision: (decision: 'approve' | 'reject') => void;
  decisionTimeoutHandle: ReturnType<typeof setTimeout>;
}

const DISCOVERED_REASON_BY_OUTCOME: Record<
  Exclude<ProvisionOutcome, 'provisioned'>,
  'no_privilege' | 'unsupported' | 'error'
> = {
  fallback_no_privilege: 'no_privilege',
  unsupported_engine: 'unsupported',
  error: 'error',
};

@Injectable()
export class AiSetupProvisioningService {
  // Pendência por sessionId garante decisão idempotente.
  private readonly pending = new Map<string, PendingProvision>();

  constructor(private readonly bridge: AiSessionConnectorBridge) {}

  async proposeAndAwait(
    input: IProposeProvisionInput,
    options: IProposeProvisionOptions = {},
  ): Promise<IProvisionSignalToolResult> {
    const decisionTimeoutMs = options.decisionTimeoutMs ?? AI_PROVISION_DECISION_TIMEOUT_MS;

    // Emite a proposta ao painel (NUNCA carrega senha).
    this.bridge.emitProvisionProposed(input.connectorId, {
      sessionId: input.sessionId,
      username: input.username,
      engine: input.engine,
      scope: PROVISION_GRANTED_SCOPE,
      readOnly: true,
      ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
    });

    const decision = await new Promise<'approve' | 'reject'>((resolve) => {
      const decisionTimeoutHandle = setTimeout(() => {
        this.pending.delete(input.sessionId);
        logger.warn(
          { module: MODULE, action: 'ai_provision_decision_timeout', sessionId: input.sessionId },
          'decisão de provisionamento expirou; tratada como reject',
        );
        resolve('reject');
      }, decisionTimeoutMs);

      this.pending.set(input.sessionId, {
        connectorId: input.connectorId,
        username: input.username,
        resolveDecision: resolve,
        decisionTimeoutHandle,
      });
    });

    if (decision === 'reject') {
      return { provisioned: false, activeCredential: 'discovered', reason: 'rejected' };
    }

    return this.invokeAdmin(input);
  }

  applyDecision(decision: IProvisionDecision): void {
    const pending = this.pending.get(decision.sessionId);
    if (!pending) {
      // Idempotência / sessão sem pendência: no-op.
      return;
    }
    clearTimeout(pending.decisionTimeoutHandle);
    this.pending.delete(decision.sessionId);
    pending.resolveDecision(decision.decision);
  }

  private async invokeAdmin(
    input: IProposeProvisionInput,
  ): Promise<IProvisionSignalToolResult> {
    let outcome: ProvisionOutcome;
    let errorCode: string | undefined;

    try {
      const result = await this.bridge.provisionReadonlyUser(
        input.connectorId,
        input.sessionId,
        input.username,
      );
      outcome = result.outcome;
      errorCode = result.errorCode;
    } catch (error) {
      // Timeout/queda do comando admin = erro; conexão fica na descoberta.
      outcome = 'error';
      errorCode = error instanceof Error && /timed out/.test(error.message) ? 'timeout' : 'unknown';
      logger.error(
        error instanceof Error ? error : new Error('provisionReadonlyUser falhou'),
        { module: MODULE, action: 'ai_provision_admin_failed', sessionId: input.sessionId },
        'Comando admin de provisionamento falhou',
      );
    }

    this.bridge.emitProvisionResult(input.connectorId, {
      sessionId: input.sessionId,
      outcome,
      username: input.username,
      ...(errorCode === undefined ? {} : { errorCode }),
    });

    if (outcome === 'provisioned') {
      return {
        provisioned: true,
        activeCredential: 'readonly_user',
        username: input.username,
      };
    }

    return {
      provisioned: false,
      activeCredential: 'discovered',
      reason: DISCOVERED_REASON_BY_OUTCOME[outcome],
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm run vitest:unit src/modules/ai-setup/services/ai-setup-provisioning.service.test.ts`
Expected: PASS (todos, incluindo os 3 casos do `it.each`).

- [ ] **Step 5: Commit**

```bash
git add src/modules/ai-setup/services/ai-setup-provisioning.service.ts src/modules/ai-setup/services/ai-setup-provisioning.service.test.ts
git commit -m "feat(ai-setup): serviço de pausa/retomada do provisionamento read-only

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Gateway — provision.decision + emits provision.*

**Files:**
- Modify: `src/modules/ai-setup/gateways/ai-setup.gateway.ts`
- Test: `src/modules/ai-setup/gateways/ai-setup.gateway.test.ts`

- [ ] **Step 1: Write the failing tests** (anexar ao `describe` existente)

```typescript
// adicionar ao final do describe em ai-setup.gateway.test.ts

  it('emitProvisionProposed emite provision.proposed para a sala da company (sem senha)', () => {
    gateway.emitProvisionProposed(7, {
      sessionId: 's1',
      username: 'pharma_connector_ro',
      engine: 'mysql',
      scope: 'all_tables',
      readOnly: true,
      rationale: 'least privilege',
    });
    expect(to).toHaveBeenCalledWith('company:7');
    expect(emit).toHaveBeenCalledWith(
      'provision.proposed',
      expect.objectContaining({ sessionId: 's1', username: 'pharma_connector_ro' }),
    );
    // garante que nenhum campo de senha vazou
    const payload = emit.mock.calls.find((c) => c[0] === 'provision.proposed')?.[1] as Record<
      string,
      unknown
    >;
    expect('password' in payload).toBe(false);
  });

  it('emitProvisionResult emite provision.result para a sala da company', () => {
    gateway.emitProvisionResult(7, {
      sessionId: 's1',
      outcome: 'provisioned',
      username: 'pharma_connector_ro',
    });
    expect(emit).toHaveBeenCalledWith(
      'provision.result',
      expect.objectContaining({ sessionId: 's1', outcome: 'provisioned' }),
    );
  });

  it('handleProvisionDecision chama o handler registrado com a company do socket', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    gateway.onProvisionDecision(handler);
    const client = { id: 'c1', data: { companyId: 7 } } as unknown as Socket;
    await gateway.handleProvisionDecision({ sessionId: 's1', decision: 'approve' }, client);
    expect(handler).toHaveBeenCalledWith({ companyId: 7, sessionId: 's1', decision: 'approve' });
  });

  it('handleProvisionDecision é no-op sem company no socket', async () => {
    const handler = vi.fn();
    gateway.onProvisionDecision(handler);
    const client = { id: 'c1', data: {} } as unknown as Socket;
    await gateway.handleProvisionDecision({ sessionId: 's1', decision: 'approve' }, client);
    expect(handler).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm run vitest:unit src/modules/ai-setup/gateways/ai-setup.gateway.test.ts`
Expected: FAIL — `gateway.emitProvisionProposed is not a function` etc.

- [ ] **Step 3: Write the implementation**

Em `ai-setup.gateway.ts`:

Adicionar import dos eventos e tipos:

```typescript
import {
  PROVISION_DECISION_EVENT,
  PROVISION_PROPOSED_EVENT,
  PROVISION_RESULT_EVENT,
} from '../constants/ai-setup-provisioning.constants';
import type {
  IProvisionProposedMessage,
  IProvisionResultMessage,
} from '../interfaces/ai-setup-provisioning.interface';
```

Adicionar o tipo do handler (junto a `MappingDecisionHandler`):

```typescript
export type ProvisionDecisionHandler = (input: {
  companyId: number;
  sessionId: string;
  decision: 'approve' | 'reject';
}) => Promise<void> | void;
```

Adicionar o campo e o registrador (junto aos outros handlers):

```typescript
  private provisionDecisionHandler: ProvisionDecisionHandler | null = null;
```

```typescript
  onProvisionDecision(handler: ProvisionDecisionHandler): void {
    this.provisionDecisionHandler = handler;
  }
```

Adicionar o `@SubscribeMessage` (junto a `handleMappingDecision`):

```typescript
  @SubscribeMessage(PROVISION_DECISION_EVENT)
  async handleProvisionDecision(
    @MessageBody() body: { sessionId: string; decision: 'approve' | 'reject' },
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const companyId = client.data.companyId as number | undefined;
    if (!companyId || !this.provisionDecisionHandler) {
      return;
    }
    await this.provisionDecisionHandler({
      companyId,
      sessionId: body.sessionId,
      decision: body.decision,
    });
  }
```

Adicionar os emits (junto a `emitMappingProposed`):

```typescript
  emitProvisionProposed(companyId: number, message: IProvisionProposedMessage): void {
    this.server.to(`company:${companyId}`).emit(PROVISION_PROPOSED_EVENT, message);
  }

  emitProvisionResult(companyId: number, message: IProvisionResultMessage): void {
    this.server.to(`company:${companyId}`).emit(PROVISION_RESULT_EVENT, message);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm run vitest:unit src/modules/ai-setup/gateways/ai-setup.gateway.test.ts`
Expected: PASS (existentes + 4 novos).

- [ ] **Step 5: Commit**

```bash
git add src/modules/ai-setup/gateways/ai-setup.gateway.ts src/modules/ai-setup/gateways/ai-setup.gateway.test.ts
git commit -m "feat(ai-setup): gateway provision.decision e emits provision.*

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Orquestrador — interceptar propose_readonly_user e mudar fase

**Files:**
- Modify: `src/modules/ai-setup/services/ai-setup-orchestrator.service.ts`
- Test: `src/modules/ai-setup/services/ai-setup-orchestrator.service.test.ts`

> O orquestrador, ao encontrar um `tool_use` cujo `name === 'propose_readonly_user'`, NÃO chama `bridge.invokeTool`. Em vez disso: muda a fase para `provisioning` (emitindo `ai.session.state` pela bridge), chama `provisioning.proposeAndAwait(...)` com `username`/`rationale` (do input) e `engine` (do input da sessão — ver abaixo), e usa o `IProvisionSignalToolResult` retornado como conteúdo do `tool_result` (sempre `ok`, nunca `is_error`). O `engine` vem de `input` (`IRunSessionInput` ganha `engine?: string`, default `'unknown'`, preenchido pela facade a partir do registry numa frente futura — aqui usamos o que estiver disponível, default `'unknown'`).

- [ ] **Step 1: Write the failing tests** (anexar ao `describe` existente)

Adicionar ao topo do arquivo de teste, no `beforeEach`, o stub do provisioning service e o `emitSessionState` na bridge:

```typescript
// no topo: ampliar o tipo do bridge mock
  let provisioning: { proposeAndAwait: ReturnType<typeof vi.fn> };

// no beforeEach, após criar bridge:
    bridge.emitSessionState = vi.fn();
    provisioning = { proposeAndAwait: vi.fn() };
    service = new AiSetupOrchestratorService(
      llm as never,
      bridge as never,
      new CatalogToToolsTranslator(),
      provisioning as never,
    );
```

> Ajustar a declaração de `bridge` no `beforeEach` para incluir `emitSessionState` e (já existente) `invokeTool`/`emitMappingProposed`.

Novos testes:

```typescript
  it('intercepta propose_readonly_user: chama proposeAndAwait (não invokeTool) e devolve o payload ao LLM', async () => {
    llm.createMessage.mockResolvedValueOnce({
      id: 'm1',
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'tu1',
          name: 'propose_readonly_user',
          input: { username: 'pharma_connector_ro', rationale: 'least privilege' },
        },
      ],
    });
    provisioning.proposeAndAwait.mockResolvedValueOnce({
      provisioned: true,
      activeCredential: 'readonly_user',
      username: 'pharma_connector_ro',
    });
    llm.createMessage.mockResolvedValueOnce(textStop());

    await service.runSession({
      companyId: 7,
      connectorId: 'conn-1',
      sessionId: 's1',
      catalog: CATALOG,
      engine: 'mysql',
    });

    expect(bridge.invokeTool).not.toHaveBeenCalled();
    expect(provisioning.proposeAndAwait).toHaveBeenCalledWith({
      connectorId: 'conn-1',
      sessionId: 's1',
      username: 'pharma_connector_ro',
      engine: 'mysql',
      rationale: 'least privilege',
    });
    // emitiu a fase provisioning
    expect(bridge.emitSessionState).toHaveBeenCalledWith('conn-1', {
      type: 'ai.session.state',
      sessionId: 's1',
      phase: 'provisioning',
    });
    // o tool_result devolvido ao LLM contém o payload canônico, sem is_error
    const secondCallMessages = llm.createMessage.mock.calls[1][0].messages;
    const toolResultTurn = secondCallMessages[secondCallMessages.length - 1];
    const block = toolResultTurn.content[0];
    expect(block.type).toBe('tool_result');
    expect(block.is_error).toBeUndefined();
    expect(JSON.parse(block.content)).toEqual({
      provisioned: true,
      activeCredential: 'readonly_user',
      username: 'pharma_connector_ro',
    });
  });

  it('propose_readonly_user em fallback devolve provisioned:false discovered ao LLM', async () => {
    llm.createMessage.mockResolvedValueOnce({
      id: 'm1',
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'tu1',
          name: 'propose_readonly_user',
          input: { username: 'pharma_connector_ro' },
        },
      ],
    });
    provisioning.proposeAndAwait.mockResolvedValueOnce({
      provisioned: false,
      activeCredential: 'discovered',
      reason: 'rejected',
    });
    llm.createMessage.mockResolvedValueOnce(textStop());

    await service.runSession({
      companyId: 7,
      connectorId: 'conn-1',
      sessionId: 's1',
      catalog: CATALOG,
    });

    // engine ausente no input vira 'unknown' na proposta
    expect(provisioning.proposeAndAwait).toHaveBeenCalledWith({
      connectorId: 'conn-1',
      sessionId: 's1',
      username: 'pharma_connector_ro',
      engine: 'unknown',
    });
    const secondCallMessages = llm.createMessage.mock.calls[1][0].messages;
    const block = secondCallMessages[secondCallMessages.length - 1].content[0];
    expect(JSON.parse(block.content)).toEqual({
      provisioned: false,
      activeCredential: 'discovered',
      reason: 'rejected',
    });
  });
```

> Garantir que o stub de `bridge` nos testes existentes ainda tem `invokeTool` e `emitMappingProposed` (já têm). Adicionar `emitSessionState: vi.fn()` no `beforeEach` evita `undefined is not a function` nos testes antigos (que não chamam propose, então `emitSessionState` não é invocado — mas a propriedade precisa existir só nos testes novos; defini-la sempre é seguro).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm run vitest:unit src/modules/ai-setup/services/ai-setup-orchestrator.service.test.ts`
Expected: FAIL — construtor com 3 args (falta `provisioning`) / `proposeAndAwait` não chamado / `propose_readonly_user` cai no caminho `invokeTool`.

- [ ] **Step 3: Write the implementation**

Em `ai-setup-orchestrator.service.ts`:

Adicionar imports:

```typescript
import { PROPOSE_READONLY_USER_TOOL_NAME } from '../constants/ai-setup-provisioning.constants';
import { AI_SESSION_STATE_MESSAGE_TYPE } from '../constants/ai-setup-protocol.constants';
import { AiSetupProvisioningService } from './ai-setup-provisioning.service';
```

> `AI_SESSION_STATE_MESSAGE_TYPE` já existe em `ai-setup-protocol.constants.ts`.

Adicionar `engine?: string` em `IRunSessionInput`:

```typescript
export interface IRunSessionInput {
  companyId: number;
  connectorId: string;
  sessionId: string;
  catalog: IToolDescriptor[];
  model?: string;
  engine?: string;
}
```

Injetar o serviço no construtor:

```typescript
  constructor(
    @Inject(ANTHROPIC_MESSAGES_CLIENT)
    private readonly llm: IAnthropicMessagesClient,
    private readonly bridge: AiSessionConnectorBridge,
    private readonly translator: CatalogToToolsTranslator,
    private readonly provisioning: AiSetupProvisioningService,
  ) {}
```

No laço `for (const toolUse of toolUses)`, antes do `invokeTool`, interceptar o sinal. Substituir o corpo do laço por:

```typescript
      for (const toolUse of toolUses) {
        if (invocations >= maxInvocations) {
          throw new InternalException(
            `Limite de invocações por sessão excedido (${maxInvocations})`,
          );
        }
        invocations += 1;

        if (toolUse.name === PROPOSE_READONLY_USER_TOOL_NAME) {
          const signalResult = await this.handleProposeReadonlyUser(
            input,
            toolUse.input as Record<string, unknown>,
          );
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify(signalResult),
          });
          continue;
        }

        const result = await this.bridge.invokeTool(
          input.connectorId,
          input.sessionId,
          toolUse.name,
          toolUse.input,
        );

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(
            result.ok ? (result.payload ?? {}) : { errorCode: result.errorCode },
          ),
          ...(result.ok ? {} : { is_error: true }),
        });
      }
```

Adicionar o método privado (junto a `emitMapping`):

```typescript
  private async handleProposeReadonlyUser(
    input: IRunSessionInput,
    toolInput: Record<string, unknown>,
  ): Promise<IProvisionSignalToolResult> {
    const username = typeof toolInput.username === 'string' ? toolInput.username : '';
    const rationale = typeof toolInput.rationale === 'string' ? toolInput.rationale : undefined;
    const engine = input.engine ?? 'unknown';

    // Fase 'provisioning' (entre credentials e schema).
    this.bridge.emitSessionState(input.connectorId, {
      type: AI_SESSION_STATE_MESSAGE_TYPE,
      sessionId: input.sessionId,
      phase: 'provisioning',
    });

    logger.info(
      { module: MODULE, action: 'ai_setup_provision_proposed', sessionId: input.sessionId, username },
      'Sinal propose_readonly_user recebido; pausando o loop até a decisão',
    );

    return this.provisioning.proposeAndAwait({
      connectorId: input.connectorId,
      sessionId: input.sessionId,
      username,
      engine,
      ...(rationale === undefined ? {} : { rationale }),
    });
  }
```

Adicionar o import do tipo:

```typescript
import type { IProvisionSignalToolResult } from '../interfaces/ai-setup-provisioning.interface';
```

> **Nota:** `bridge.emitSessionState` é um novo método na bridge (re-emit do estado para o relay). Adicioná-lo na bridge no Step seguinte deste task.

- [ ] **Step 4: Adicionar `emitSessionState` à bridge (re-emit do evento `state`)**

Em `ai-session-connector-bridge.ts`, adicionar (junto a `emitMappingProposed`), e o import do tipo `IAiSessionStateMessage` (já importado):

```typescript
  emitSessionState(connectorId: string, message: IAiSessionStateMessage): void {
    this.emit('state', { connectorId, message });
  }
```

> A wiring já escuta `bridge.on('state', ...)` e faz `registry.updatePhase` + `gateway.emitSessionState`. Assim, emitir aqui propaga a fase `provisioning` ao registry e ao painel reusando o caminho existente. **Não** é preciso novo teste de bridge para este método além do que o orquestrador exercita (mas adicionar uma asserção mínima é opcional). Acrescentar ao `ai-session-connector-bridge.test.ts`:

```typescript
  it('emitSessionState re-emite o evento state', () => {
    const state = vi.fn();
    bridge.on('state', state);
    const msg = { type: 'ai.session.state' as const, sessionId: 's1', phase: 'provisioning' as const };
    bridge.emitSessionState('conn-1', msg);
    expect(state).toHaveBeenCalledWith({ connectorId: 'conn-1', message: msg });
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm run vitest:unit src/modules/ai-setup/services/ai-setup-orchestrator.service.test.ts`
Run: `pnpm run vitest:unit src/modules/ai-setup/gateways/ai-session-connector-bridge.test.ts`
Expected: PASS em ambos (orquestrador: existentes + 2 novos; bridge: + 1 novo).

- [ ] **Step 6: Commit**

```bash
git add src/modules/ai-setup/services/ai-setup-orchestrator.service.ts src/modules/ai-setup/services/ai-setup-orchestrator.service.test.ts src/modules/ai-setup/gateways/ai-session-connector-bridge.ts src/modules/ai-setup/gateways/ai-session-connector-bridge.test.ts
git commit -m "feat(ai-setup): orquestrador pausa no propose_readonly_user e entra na fase provisioning

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Facade — delegar provision.decision ao serviço

**Files:**
- Modify: `src/modules/ai-setup/services/ai-setup.facade.ts`
- Test: `src/modules/ai-setup/services/ai-setup.facade.test.ts`

> A facade ganha `handleProvisionDecision(...)`: valida que a sessão existe e pertence à company, então chama `provisioning.applyDecision({ sessionId, decision })`. A facade também passa a injetar `AiSetupProvisioningService` (já provido no módulo no Task 8).

- [ ] **Step 1: Write the failing test**

Primeiro, ler `ai-setup.facade.test.ts` para reaproveitar o padrão de mocks (registry/bridge/orchestrator/connectorRepository) e adicionar o mock do provisioning service no `beforeEach`. Adicionar:

```typescript
  it('handleProvisionDecision delega applyDecision quando a sessão pertence à company', () => {
    registry.get.mockReturnValue({
      sessionId: 's1',
      companyId: 7,
      connectorId: 'conn-1',
      phase: 'provisioning',
    });
    facade.handleProvisionDecision({ companyId: 7, sessionId: 's1', decision: 'approve' });
    expect(provisioning.applyDecision).toHaveBeenCalledWith({ sessionId: 's1', decision: 'approve' });
  });

  it('handleProvisionDecision ignora quando a sessão é de outra company', () => {
    registry.get.mockReturnValue({
      sessionId: 's1',
      companyId: 99,
      connectorId: 'conn-1',
      phase: 'provisioning',
    });
    facade.handleProvisionDecision({ companyId: 7, sessionId: 's1', decision: 'approve' });
    expect(provisioning.applyDecision).not.toHaveBeenCalled();
  });

  it('handleProvisionDecision ignora quando a sessão não existe', () => {
    registry.get.mockReturnValue(undefined);
    facade.handleProvisionDecision({ companyId: 7, sessionId: 's1', decision: 'reject' });
    expect(provisioning.applyDecision).not.toHaveBeenCalled();
  });
```

> No `beforeEach` do arquivo, adicionar `provisioning = { applyDecision: vi.fn() }` e passá-lo como novo argumento do construtor do `AiSetupFacade` (na posição correta — ver Step 3). Ajustar a instanciação existente do `AiSetupFacade` no teste para incluir `provisioning as never`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run vitest:unit src/modules/ai-setup/services/ai-setup.facade.test.ts`
Expected: FAIL — construtor com aridade diferente / `handleProvisionDecision` não existe.

- [ ] **Step 3: Write the implementation**

Em `ai-setup.facade.ts`:

Adicionar import e injeção:

```typescript
import { AiSetupProvisioningService } from './ai-setup-provisioning.service';
import type { IProvisionDecision } from '../interfaces/ai-setup-provisioning.interface';
```

Construtor (adicionar o serviço como último parâmetro):

```typescript
  constructor(
    private readonly bridge: AiSessionConnectorBridge,
    private readonly registry: AiSetupSessionRegistry,
    private readonly orchestrator: AiSetupOrchestratorService,
    private readonly connectorRepository: AgentConnectorRepository,
    private readonly provisioning: AiSetupProvisioningService,
  ) {
```

Método novo (junto a `handleDecision`):

```typescript
  handleProvisionDecision(input: {
    companyId: number;
    sessionId: string;
    decision: 'approve' | 'reject';
  }): void {
    const session = this.registry.get(input.sessionId);
    if (!session || session.companyId !== input.companyId) {
      return;
    }
    const decision: IProvisionDecision = {
      sessionId: input.sessionId,
      decision: input.decision,
    };
    this.provisioning.applyDecision(decision);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm run vitest:unit src/modules/ai-setup/services/ai-setup.facade.test.ts`
Expected: PASS (existentes + 3 novos).

- [ ] **Step 5: Commit**

```bash
git add src/modules/ai-setup/services/ai-setup.facade.ts src/modules/ai-setup/services/ai-setup.facade.test.ts
git commit -m "feat(ai-setup): facade delega provision.decision ao serviço de provisionamento

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Módulo + wiring — registrar serviço e ligar o fan-out

**Files:**
- Modify: `src/modules/ai-setup/ai-setup.module.ts`
- Modify: `src/modules/ai-setup/ai-setup.wiring.ts`
- Test: `src/modules/ai-setup/ai-setup.wiring.test.ts`

> Primeiro ler `ai-setup.module.ts` e `ai-setup.wiring.test.ts` para reaproveitar os padrões de providers e de asserção de binding.

- [ ] **Step 1: Write the failing tests** (anexar ao `describe` existente de wiring)

```typescript
  it('liga provision.proposed da bridge ao gateway resolvendo a company pelo registry', () => {
    registry.get.mockReturnValue({ sessionId: 's1', companyId: 7, connectorId: 'conn-1', phase: 'provisioning' });
    wiring.onApplicationBootstrap();
    bridge.emit('provision.proposed', {
      connectorId: 'conn-1',
      message: {
        sessionId: 's1',
        username: 'pharma_connector_ro',
        engine: 'mysql',
        scope: 'all_tables',
        readOnly: true,
      },
    });
    expect(gateway.emitProvisionProposed).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ sessionId: 's1', username: 'pharma_connector_ro' }),
    );
  });

  it('liga provision.result da bridge ao gateway', () => {
    registry.get.mockReturnValue({ sessionId: 's1', companyId: 7, connectorId: 'conn-1', phase: 'provisioning' });
    wiring.onApplicationBootstrap();
    bridge.emit('provision.result', {
      connectorId: 'conn-1',
      message: { sessionId: 's1', outcome: 'provisioned', username: 'pharma_connector_ro' },
    });
    expect(gateway.emitProvisionResult).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ sessionId: 's1', outcome: 'provisioned' }),
    );
  });

  it('registra o handler de provision.decision no gateway -> facade', () => {
    wiring.onApplicationBootstrap();
    expect(gateway.onProvisionDecision).toHaveBeenCalledWith(expect.any(Function));
  });
```

> Ajustar os mocks de `gateway` no `beforeEach` para incluir `emitProvisionProposed: vi.fn()`, `emitProvisionResult: vi.fn()`, `onProvisionDecision: vi.fn()`; e `bridge` deve ser um `EventEmitter` real (como nos testes existentes de wiring) para suportar `emit`/`on`. Garantir que `facade` mock tem `handleProvisionDecision: vi.fn()`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm run vitest:unit src/modules/ai-setup/ai-setup.wiring.test.ts`
Expected: FAIL — listeners de `provision.*` não existem; `gateway.onProvisionDecision` não chamado.

- [ ] **Step 3: Write the wiring implementation**

Em `ai-setup.wiring.ts`:

Adicionar imports de tipos:

```typescript
import type {
  IProvisionProposedMessage,
  IProvisionResultMessage,
} from './interfaces/ai-setup-provisioning.interface';
```

Adicionar os tipos de handler e campos:

```typescript
type ProvisionProposedHandler = (event: {
  connectorId: string;
  message: IProvisionProposedMessage;
}) => void;
type ProvisionResultHandler = (event: {
  connectorId: string;
  message: IProvisionResultMessage;
}) => void;
```

```typescript
  private provisionProposedHandler?: ProvisionProposedHandler;
  private provisionResultHandler?: ProvisionResultHandler;
```

No `onApplicationBootstrap`, após o bloco do `mappingHandler`:

```typescript
    this.provisionProposedHandler = (event) => {
      const companyId = this.registry.get(event.message.sessionId)?.companyId;
      if (companyId) {
        this.gateway.emitProvisionProposed(companyId, event.message);
      }
    };
    this.bridge.on('provision.proposed', this.provisionProposedHandler);

    this.provisionResultHandler = (event) => {
      const companyId = this.registry.get(event.message.sessionId)?.companyId;
      if (companyId) {
        this.gateway.emitProvisionResult(companyId, event.message);
      }
    };
    this.bridge.on('provision.result', this.provisionResultHandler);
```

Após `this.gateway.onSessionAbort(...)`:

```typescript
    this.gateway.onProvisionDecision((input) => this.facade.handleProvisionDecision(input));
```

No `onApplicationShutdown`, adicionar a remoção:

```typescript
    if (this.provisionProposedHandler) {
      this.bridge.off('provision.proposed', this.provisionProposedHandler);
      this.provisionProposedHandler = undefined;
    }
    if (this.provisionResultHandler) {
      this.bridge.off('provision.result', this.provisionResultHandler);
      this.provisionResultHandler = undefined;
    }
```

- [ ] **Step 4: Register the provider in the module**

Em `ai-setup.module.ts`, adicionar `AiSetupProvisioningService` ao array `providers` (importar do caminho `./services/ai-setup-provisioning.service`). Manter a ordem alfabética/lógica existente do array de providers.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm run vitest:unit src/modules/ai-setup/ai-setup.wiring.test.ts`
Expected: PASS (existentes + 3 novos).

- [ ] **Step 6: Commit**

```bash
git add src/modules/ai-setup/ai-setup.wiring.ts src/modules/ai-setup/ai-setup.wiring.test.ts src/modules/ai-setup/ai-setup.module.ts
git commit -m "feat(ai-setup): wiring do fan-out de provision.* e registro do serviço

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Integração — painel recebe provision.proposed e envia provision.decision

**Files:**
- Modify: `src/modules/ai-setup/tests/ai-setup.int.test.ts`

> Reusa o harness existente (Nest app real, `RedisIoAdapter`, agente via `ws`, painel via `socket.io-client`, LLM stub). O teste exercita o caminho fim-a-fim do relay: a facade dispara a proposta via o serviço de provisionamento (chamando diretamente `provisioning.proposeAndAwait`, como o teste existente dispara `facade.startSession`), o painel recebe `provision.proposed`, envia `provision.decision: approve`, o agente recebe `connector.provisionReadonlyUser`, responde o `.result` e o painel recebe `provision.result`.

- [ ] **Step 1: Write the failing test**

Adicionar ao `describe` de integração (importar `AiSetupProvisioningService` no topo do arquivo: `import { AiSetupProvisioningService } from '@modules/ai-setup/services/ai-setup-provisioning.service';`), e obter o serviço no `beforeEach`: `provisioning = app.get(AiSetupProvisioningService);` (declarar `let provisioning: AiSetupProvisioningService;`).

```typescript
  it('painel recebe provision.proposed, aprova, e recebe provision.result após o agente responder', async () => {
    const company = await CompanyFactory.create(testDb);
    const { rawToken } = await seedConnector(company.id);
    const agent = await openAgent(rawToken);
    const client = await openWebClient(company.id);

    const { sessionId } = await facade.startSession({ companyId: company.id });

    const proposedReceived = new Promise<{ sessionId: string; username: string }>(
      (resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout provision.proposed')), 10_000);
        client.on('provision.proposed', (payload: { sessionId: string; username: string }) => {
          clearTimeout(t);
          resolve(payload);
        });
      },
    );

    const resultReceived = new Promise<{ sessionId: string; outcome: string }>(
      (resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout provision.result')), 10_000);
        client.on('provision.result', (payload: { sessionId: string; outcome: string }) => {
          clearTimeout(t);
          resolve(payload);
        });
      },
    );

    // O agente responde ao comando admin assim que o recebe.
    agent.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as { type?: string; requestId?: string };
      if (msg.type === 'connector.provisionReadonlyUser') {
        agent.send(
          JSON.stringify({
            type: 'connector.provisionReadonlyUser.result',
            requestId: msg.requestId,
            sessionId,
            outcome: 'provisioned',
            username: 'pharma_connector_ro',
            grantedScope: 'all_tables',
          }),
        );
      }
    });

    // Dispara a proposta (equivalente ao orquestrador ao ver propose_readonly_user).
    const signalResult = provisioning.proposeAndAwait({
      connectorId: facade.getSession(sessionId).connectorId,
      sessionId,
      username: 'pharma_connector_ro',
      engine: 'mysql',
      rationale: 'least privilege',
    });

    const proposed = await proposedReceived;
    expect(proposed).toMatchObject({ sessionId, username: 'pharma_connector_ro' });
    expect('password' in (proposed as Record<string, unknown>)).toBe(false);

    // O painel aprova.
    client.emit('provision.decision', { sessionId, decision: 'approve' });

    const result = await resultReceived;
    expect(result).toMatchObject({ sessionId, outcome: 'provisioned' });

    await expect(signalResult).resolves.toEqual({
      provisioned: true,
      activeCredential: 'readonly_user',
      username: 'pharma_connector_ro',
    });
  }, 30_000);
```

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm run vitest:integration src/modules/ai-setup/tests/ai-setup.int.test.ts`
Expected: PASS (existentes + 1 novo). Requer Redis/DB de teste como os testes de integração já existentes.

> Se ao rodar a primeira vez o teste falhar por `getSession` não expor `connectorId`, confirmar que `IAiSetupSession` já o contém (contém — ver `ai-setup-session.registry.ts`). Sem mudança de produção esperada neste task; é só teste.

- [ ] **Step 3: Commit**

```bash
git add src/modules/ai-setup/tests/ai-setup.int.test.ts
git commit -m "test(ai-setup): integração do relay provision.proposed/decision/result

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: README do módulo + quality gate

**Files:**
- Modify: `src/modules/ai-setup/README.md`

- [ ] **Step 1: Atualizar o README**

Em `src/modules/ai-setup/README.md`:

1. Na tabela "socket.io (painel ↔ neo)", adicionar as linhas:

```markdown
| Painel → neo | `provision.decision` | `{ sessionId, decision: 'approve'\|'reject' }` |
| neo → Painel | `provision.proposed` | `{ sessionId, username, engine, scope: 'all_tables', readOnly: true, rationale? }` (nunca carrega senha) |
| neo → Painel | `provision.result` | `{ sessionId, outcome, username, errorCode? }` |
```

2. Na tabela "Bridge raw WS (neo ↔ conector)", adicionar:

```markdown
| neo → conector | `connector.provisionReadonlyUser` | Comando admin human-gated (`requestId`, sem senha) |
| conector → neo | `connector.provisionReadonlyUser.result` | Resultado do provisionamento (correlação por `requestId`) |
```

3. Atualizar a lista de fases para incluir `provisioning` entre `credentials` e `schema`:

```markdown
Fases da sessão (`AiSessionPhase`): `discovering`, `credentials`, `provisioning`,
`schema`, `proposing`, `applying`, `synced`, `failed`, `aborted`.
```

4. Adicionar uma subseção em "Fluxo principal" (após o item 5, renumerando os seguintes) ou um parágrafo novo na seção "Regras de negócio":

```markdown
- **Provisionamento read-only (human-gated):** o catálogo do LLM expõe o sinal
  read-only `propose_readonly_user` (sem efeito no banco). Ao recebê-lo, o
  orquestrador **pausa** o loop (`AiSetupProvisioningService`), entra na fase
  `provisioning`, emite `provision.proposed` ao painel e aguarda
  `provision.decision` (timeout `AI_PROVISION_DECISION_TIMEOUT_MS` = 10 min → tratado
  como `reject`). Em `approve`, a bridge envia o comando admin
  `connector.provisionReadonlyUser` (fora do catálogo, sem senha, timeout
  `AI_PROVISION_TIMEOUT_MS` = 30 s); ao chegar o `.result`, emite `provision.result`
  e **resolve** o `tool.result` do sinal de volta ao LLM com `{ provisioned, activeCredential, ... }`.
  A decisão é **idempotente** por `sessionId` e os eventos `provision.*` **nunca**
  carregam senha.
```

5. Na tabela "Modelo e configuração", adicionar:

```markdown
| `AI_PROVISION_TIMEOUT_MS` | `30000` (correlação do comando admin) |
| `AI_PROVISION_DECISION_TIMEOUT_MS` | `600000` (decisão humana; expira como reject) |
```

- [ ] **Step 2: Rodar a suíte unitária completa do módulo**

Run: `pnpm run vitest:unit src/modules/ai-setup`
Expected: PASS — todos os arquivos `*.test.ts` do módulo.

- [ ] **Step 3: Rodar o quality-gate rápido (pre-push)**

Run: `pnpm run quality-gate:fast`
Expected: PASS — lint + typecheck + testes rápidos sem erros (sem `throw new Error`; só exceptions de `@/common/exceptions`).

- [ ] **Step 4: Commit**

```bash
git add src/modules/ai-setup/README.md
git commit -m "docs(ai-setup): documenta provisionamento read-only no README

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage (Contrato B / ESCOPO):**

| Requisito do escopo | Task |
| --- | --- |
| (1) constantes/DTOs dos envelopes + timeouts | Tasks 1, 2 |
| (2) bridge: comando admin correlacionado por requestId+timeout + tratamento do `.result`; emits provision.proposed/result | Task 3 (+ `emitSessionState` no Task 6) |
| (3) orquestrador: interceptar `propose_readonly_user` → pausar → emitir proposed → aguardar decisão → invocar admin → resolver `tool.result`; fase `provisioning` | Tasks 4 (serviço) + 6 (orquestrador) |
| (4) gateway: `@SubscribeMessage('provision.decision')` + emits | Task 5 |
| (5) wiring/facade do fan-out | Tasks 7 (facade), 8 (wiring/módulo) |
| (6) testes unit (pausa/retomada, approve/reject/timeout, fallback) + int | Tasks 4 (unit completos), 9 (int) |

Payload canônico de volta ao LLM (`{ provisioned, activeCredential, username }` / `{ provisioned:false, activeCredential:'discovered', reason }`): coberto no Task 4 (`IProvisionSignalToolResult`) e exercitado no Task 6. Decisão idempotente por `sessionId`: Task 4 (`pending` por sessionId, `applyDecision` no-op após consumida). Fase `provisioning` entre `credentials` e `schema`: Task 2 (union) + Task 6 (emit). `provision.*` sem senha: garantido por contrato dos DTOs (sem campo de senha) e asserções nos Tasks 5 e 9.

**2. Placeholder scan:** sem TBD/TODO; todo step com código mostra o código completo; comandos com saída esperada; nenhuma referência a tipo/método não definido (`AI_SESSION_STATE_MESSAGE_TYPE` é constante pré-existente; `emitSessionState` é criado no Task 6; `IProvisionSignalToolResult` no Task 2). Os Tasks 7, 8 e 9 pedem leitura prévia dos arquivos de teste existentes para casar exatamente o padrão de mocks (não reproduzem o arquivo inteiro pois ele já existe e segue padrão estável).

**3. Type consistency:**
- `provisionReadonlyUser(connectorId, sessionId, username, timeoutMs?)` — Task 3, chamada no Task 4 com 3 args (timeout default).
- `proposeAndAwait(input: IProposeProvisionInput, options?)` e `applyDecision(decision: IProvisionDecision)` — Task 4, consumidos no Task 6 (orquestrador chama `proposeAndAwait`) e Task 7 (facade chama `applyDecision`).
- `emitProvisionProposed`/`emitProvisionResult`/`emitSessionState` na bridge (Tasks 3/6) ↔ ouvidos pela wiring (Task 8).
- `onProvisionDecision`/`emitProvisionProposed`/`emitProvisionResult` no gateway (Task 5) ↔ usados pela wiring (Task 8).
- `handleProvisionDecision` na facade (Task 7) ↔ registrado pela wiring (Task 8).
- Eventos socket.io e tipos de mensagem WS via constantes do Task 1 — sem strings soltas no código de produção.
- Nomes canônicos (`propose_readonly_user`, `connector.provisionReadonlyUser[.result]`, `provision.proposed/result/decision`, `all_tables`, outcomes, `activeCredential` values) batem verbatim com o CONTRATO CANÔNICO.

**Conformidade com regras do repo:** sem `throw new Error` em código de produção (a bridge usa `Error` apenas em `reject` de Promise de timeout, padrão já existente no `invokeTool`; o serviço captura e converte para outcome `error`); módulo mantém README atualizado (Task 10); cada task roda vitest FAIL→impl→PASS e commita com o rodapé Co-Authored-By exigido.
