# AI-Driven Setup — UI (web): Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar a UI de auditoria + aprovação do "Setup dirigido por IA" no `web-pharmachatbot`: um hook que assina a sessão de IA via socket.io (gateway neo), uma timeline de auditoria em tempo real (segredos já chegam redigidos), um card de aprovação/edição do mapping proposto, e a integração desse modo como um novo método dentro do `AgentConnectorPanel`. Tudo coberto por testes vitest + React Testing Library.

**Architecture:** O web nunca fala com o agente. O **FLUXO CANÔNICO DE INÍCIO** é: o **REST inicia** a sessão (`POST /pharma-agent-catalog/companies/:companyId/ai-setup/sessions`, devolve `{ data: { sessionId } }`) e o **socket transmite** os eventos. Após o REST, o web entra na sala da company via `socket.emit('company', companyId)` (mesmo padrão do `src/hooks/Socket/index.tsx`) e então assina os eventos relayados pelo gateway neo (`audit.event`, `ai.session.state`, `mapping.proposed`). Pelo socket o web emite apenas decisões (`mapping.decision`, `ai.session.abort`) — **não** existe emit de `ai.session.start`. Um hook React dedicado (`useAiSetupSession`) encapsula a conexão socket.io v2 (mesmo cliente `socket.io-client@^2.3.0` e mesma forma de conexão do `src/hooks/Socket/index.tsx`, apontando para o socket neo), acumula a timeline ordenada por `seq`, expõe `phase` e a `proposal`, e expõe as ações de emit. A camada de apresentação é puramente derivada do estado do hook: `AiAuditTimeline` (lista de eventos) e `MappingApprovalCard` (proposta + decisão). A integração entra no `AgentConnectorPanel` como nova `AiSetupSection`, controlada por `phase`. A chamada REST via `neoApi` cria a sessão e devolve o `sessionId` antes de o hook entrar na sala da company pelo socket.

**Tech Stack:** React, TypeScript, socket.io-client, styled-components, react-query, vitest+RTL, i18next

---

## File Structure

Todos os caminhos sob `src/pages/AgentConnectorPanel/`.

| Caminho | Responsabilidade |
|---|---|
| `aiSetup/types.ts` | Tipos do CONTRATO CANÔNICO no lado web: `AiAuditEvent`, `AiSessionPhase`/`AI_SESSION_PHASES`, `AiSessionState`, `MappingProposal`, `ValidatedMappingConfig`, `MappingDecision`, `AiSetupPreviewRow`. Fonte de verdade de nomes de evento (`AI_SETUP_SOCKET_EVENTS`). |
| `aiSetup/hooks/useAiSetupSession.ts` | Hook que conecta o socket neo, assina `audit.event`/`ai.session.state`/`mapping.proposed`, acumula timeline ordenada por `seq`, expõe `phase`, `events`, `proposal`, `error`; ações `startSession`/`approve`/`reject`/`abort` (emit). Cleanup no unmount. |
| `aiSetup/hooks/useAiSetupSession.test.tsx` | Teste do hook com socket mockado (factory injetável). |
| `aiSetup/services.ts` | `startAiSetupSession(companyId)` via `neoApi` (POST), devolve `{ sessionId }`. Segue padrão de `services.ts` da página. |
| `aiSetup/services.test.ts` | Teste do service com `neoApi` mockado. |
| `aiSetup/AiAuditTimeline.tsx` | Componente de timeline: eventos por `seq`, ícone por `kind`/`tool`, `summary`, `detail` expansível, badge de `phase`. |
| `aiSetup/AiAuditTimeline.test.tsx` | Teste RTL: ordem por `seq`, detalhe redigido exibido como veio. |
| `aiSetup/MappingApprovalCard.tsx` | Card de aprovação: query, mapa de fields, rationale, tabela de `previewRows`, editar query, botões Aprovar/Rejeitar. |
| `aiSetup/MappingApprovalCard.test.tsx` | Teste RTL: Aprovar emite `approve` com mapping (editado); Rejeitar emite `reject`. |
| `aiSetup/AiSetupSection.tsx` | Section integradora: botão "Iniciar setup por IA" → `startSession`; mostra timeline; `proposing` → `MappingApprovalCard`; `synced` → sucesso; `failed`/`aborted` → erro + retry; botão abortar enquanto roda. |
| `aiSetup/AiSetupSection.test.tsx` | Teste RTL da section orquestrando hook (mockado) + filhos. |
| `aiSetup/styles.ts` | styled-components da feature (tokens do design.md; animação sob `prefers-reduced-motion`). |
| `SetupMethodSection.tsx` (editar) | Adicionar o método `ai_setup` (4º card). |
| `types.ts` (editar) | Adicionar `'ai_setup'` a `SETUP_METHOD_VALUES`. |
| `src/translation/languages/ptBr.ts` (editar) | Chaves `pages.agentConnector.aiSetup.*`. |

---

## Tarefa 1 — Tipos do contrato (aiSetup/types.ts)

### Step 1.1 — Write failing test

- [ ] Criar `src/pages/AgentConnectorPanel/aiSetup/types.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  AI_SESSION_PHASES,
  AI_SETUP_SOCKET_EVENTS,
  isAiSessionPhase,
} from './types';

describe('aiSetup/types', () => {
  it('declara as fases do contrato canônico na ordem do ciclo', () => {
    expect(AI_SESSION_PHASES).toEqual([
      'discovering',
      'credentials',
      'schema',
      'proposing',
      'applying',
      'synced',
      'failed',
      'aborted',
    ]);
  });

  it('declara os nomes de evento exatamente como no contrato neo<->web', () => {
    expect(AI_SETUP_SOCKET_EVENTS).toEqual({
      auditEvent: 'audit.event',
      sessionState: 'ai.session.state',
      mappingProposed: 'mapping.proposed',
      joinCompany: 'company',
      mappingDecision: 'mapping.decision',
      sessionAbort: 'ai.session.abort',
    });
  });

  it('isAiSessionPhase reconhece fase válida e rejeita desconhecida', () => {
    expect(isAiSessionPhase('proposing')).toBe(true);
    expect(isAiSessionPhase('nope')).toBe(false);
  });
});
```

### Step 1.2 — Run (espera FAIL)

- [ ] `npx vitest run src/pages/AgentConnectorPanel/aiSetup/types.test.ts`
- Saída esperada: FAIL — `Failed to resolve import './types'` / módulo inexistente.

### Step 1.3 — Implementação mínima

- [ ] Criar `src/pages/AgentConnectorPanel/aiSetup/types.ts`:

```ts
export const AI_SESSION_PHASES = [
  'discovering',
  'credentials',
  'schema',
  'proposing',
  'applying',
  'synced',
  'failed',
  'aborted',
] as const;

export type AiSessionPhase = (typeof AI_SESSION_PHASES)[number];

export function isAiSessionPhase(value: unknown): value is AiSessionPhase {
  return (
    typeof value === 'string' &&
    (AI_SESSION_PHASES as readonly string[]).includes(value)
  );
}

/** Nomes de evento socket.io do CONTRATO CANÔNICO neo<->web. */
export const AI_SETUP_SOCKET_EVENTS = {
  // neo -> web (web assina)
  auditEvent: 'audit.event',
  sessionState: 'ai.session.state',
  mappingProposed: 'mapping.proposed',
  // web -> neo (web emite)
  // Início é via REST; pelo socket o web só entra na sala da company e emite decisões.
  joinCompany: 'company',
  mappingDecision: 'mapping.decision',
  sessionAbort: 'ai.session.abort',
} as const;

export type AiAuditEventKind =
  | 'tool_invoke'
  | 'tool_result'
  | 'info'
  | 'warning'
  | 'error';

export interface AiAuditEvent {
  sessionId: string;
  seq: number;
  at: string;
  kind: AiAuditEventKind;
  tool?: string;
  summary: string;
  /** Já chega REDIGIDO da borda do agente. */
  detail?: string;
}

export interface AiSessionState {
  sessionId: string;
  phase: AiSessionPhase;
  detail?: string;
}

export type AiSyncMode = 'snapshot' | 'incremental';
export type AiCursorType = 'timestamp' | 'incrementing';

export interface ValidatedMappingFields {
  sourceProductCode: string;
  name: string;
  price?: string;
  stock?: string;
  barcode?: string;
  active?: string;
  sourceUpdatedAt?: string;
}

export interface ValidatedMappingConfig {
  mappingVersion: number;
  syncMode: AiSyncMode;
  snapshotQuery?: string;
  incrementalQuery?: string;
  cursorField?: string;
  cursorType?: AiCursorType;
  batchSize: number;
  pollIntervalMs: number;
  fields: ValidatedMappingFields;
}

export type AiSetupPreviewRow = Record<string, string | number | null>;

export interface MappingProposal {
  sessionId: string;
  mapping: ValidatedMappingConfig;
  rationale: string;
  previewRows: AiSetupPreviewRow[];
}

export interface MappingDecision {
  sessionId: string;
  decision: 'approve' | 'reject';
  editedMapping?: ValidatedMappingConfig;
}

export interface AiSessionAbortPayload {
  sessionId: string;
  reason: string;
}
```

### Step 1.4 — Run (espera PASS)

- [ ] `npx vitest run src/pages/AgentConnectorPanel/aiSetup/types.test.ts`
- Saída esperada: PASS (3 testes).

### Step 1.5 — Commit

- [ ] `git add src/pages/AgentConnectorPanel/aiSetup/types.ts src/pages/AgentConnectorPanel/aiSetup/types.test.ts`
- [ ] `git commit -m "feat: tipos do contrato de setup por IA na UI"`

---

## Tarefa 2 — Service REST de início de sessão (aiSetup/services.ts)

### Step 2.1 — Write failing test

- [ ] Criar `src/pages/AgentConnectorPanel/aiSetup/services.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('services/neoApi', () => ({
  default: { post: vi.fn() },
}));

import neoApi from 'services/neoApi';
import { startAiSetupSession } from './services';

const mockedPost = neoApi.post as unknown as ReturnType<typeof vi.fn>;

describe('startAiSetupSession', () => {
  it('faz POST no endpoint da company e devolve o sessionId', async () => {
    mockedPost.mockResolvedValueOnce({
      data: { data: { sessionId: 'sess-123' } },
    });

    const result = await startAiSetupSession(42);

    expect(mockedPost).toHaveBeenCalledWith(
      '/pharma-agent-catalog/companies/42/ai-setup/sessions',
    );
    expect(result).toEqual({ sessionId: 'sess-123' });
  });
});
```

### Step 2.2 — Run (espera FAIL)

- [ ] `npx vitest run src/pages/AgentConnectorPanel/aiSetup/services.test.ts`
- Saída esperada: FAIL — `./services` inexistente.

### Step 2.3 — Implementação mínima

- [ ] Criar `src/pages/AgentConnectorPanel/aiSetup/services.ts`:

```ts
import neoApi from 'services/neoApi';

type NeoEnvelope<T> = { data: T };

export interface StartAiSetupSessionResult {
  sessionId: string;
}

const aiSetupSessionsPath = (companyId: number) =>
  `/pharma-agent-catalog/companies/${companyId}/ai-setup/sessions`;

export async function startAiSetupSession(
  companyId: number,
): Promise<StartAiSetupSessionResult> {
  const response = await neoApi.post<NeoEnvelope<StartAiSetupSessionResult>>(
    aiSetupSessionsPath(companyId),
  );
  return { sessionId: response.data.data.sessionId };
}
```

> **Suposição:** o endpoint REST de criação de sessão (`POST .../ai-setup/sessions`) é o plano do neo; caminho ilustrativo no mesmo estilo de `productSearchStartPath` em `services.ts` (já comentado lá como "Backend contract TBD with Neo team"). Se o neo expuser outro caminho/envelope, ajustar só aqui.

### Step 2.4 — Run (espera PASS)

- [ ] `npx vitest run src/pages/AgentConnectorPanel/aiSetup/services.test.ts`
- Saída esperada: PASS (1 teste).

### Step 2.5 — Commit

- [ ] `git add src/pages/AgentConnectorPanel/aiSetup/services.ts src/pages/AgentConnectorPanel/aiSetup/services.test.ts`
- [ ] `git commit -m "feat: service REST para iniciar sessão de setup por IA"`

---

## Tarefa 3 — Hook de assinatura da sessão (aiSetup/hooks/useAiSetupSession.ts)

O hook cria seu próprio socket neo (mesmo cliente `socket.io-client@^2.3.0` usado em `src/hooks/Socket/index.tsx`), via uma factory injetável (`createSocket`) para permitir mock no teste. Acumula `events` ordenados por `seq` (dedup por `seq`), guarda `phase`, `proposal`, `detail`/`error`. Ações `startSession`/`approve`/`reject`/`abort` fazem `emit`. Desconecta no unmount.

### Step 3.1 — Write failing test

- [ ] Criar `src/pages/AgentConnectorPanel/aiSetup/hooks/useAiSetupSession.test.tsx`:

```ts
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useAiSetupSession } from './useAiSetupSession';
import {
  AI_SETUP_SOCKET_EVENTS,
  type AiAuditEvent,
  type AiSessionState,
  type MappingProposal,
} from '../types';

vi.mock('../services', () => ({
  startAiSetupSession: vi.fn().mockResolvedValue({ sessionId: 'sess-1' }),
}));

import { startAiSetupSession } from '../services';

type Handler = (payload: unknown) => void;

function makeFakeSocket() {
  const handlers = new Map<string, Handler[]>();
  return {
    emit: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    off: vi.fn(),
    fire(event: string, payload: unknown) {
      (handlers.get(event) ?? []).forEach((h) => h(payload));
    },
  };
}

describe('useAiSetupSession', () => {
  it('startSession cria a sessão REST e entra na sala da company', async () => {
    const socket = makeFakeSocket();
    const { result } = renderHook(() =>
      useAiSetupSession({ companyId: 7, createSocket: () => socket as never }),
    );

    await act(async () => {
      await result.current.startSession();
    });

    expect(startAiSetupSession).toHaveBeenCalledWith(7);
    expect(socket.emit).toHaveBeenCalledWith(
      AI_SETUP_SOCKET_EVENTS.joinCompany,
      7,
    );
  });

  it('acumula eventos de auditoria ordenados por seq mesmo fora de ordem', async () => {
    const socket = makeFakeSocket();
    const { result } = renderHook(() =>
      useAiSetupSession({ companyId: 7, createSocket: () => socket as never }),
    );
    await act(async () => {
      await result.current.startSession();
    });

    const ev2: AiAuditEvent = {
      sessionId: 'sess-1',
      seq: 2,
      at: '2026-06-03T10:00:02Z',
      kind: 'tool_result',
      tool: 'sql.runReadOnlySelect',
      summary: 'select ok',
    };
    const ev1: AiAuditEvent = {
      sessionId: 'sess-1',
      seq: 1,
      at: '2026-06-03T10:00:01Z',
      kind: 'tool_invoke',
      tool: 'schema.listTables',
      summary: 'listando tabelas',
    };

    act(() => {
      socket.fire(AI_SETUP_SOCKET_EVENTS.auditEvent, ev2);
      socket.fire(AI_SETUP_SOCKET_EVENTS.auditEvent, ev1);
    });

    await waitFor(() => expect(result.current.events).toHaveLength(2));
    expect(result.current.events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('atualiza a fase a partir de ai.session.state', async () => {
    const socket = makeFakeSocket();
    const { result } = renderHook(() =>
      useAiSetupSession({ companyId: 7, createSocket: () => socket as never }),
    );
    await act(async () => {
      await result.current.startSession();
    });

    const state: AiSessionState = { sessionId: 'sess-1', phase: 'schema' };
    act(() => socket.fire(AI_SETUP_SOCKET_EVENTS.sessionState, state));

    await waitFor(() => expect(result.current.phase).toBe('schema'));
  });

  it('guarda a proposta de mapping de mapping.proposed', async () => {
    const socket = makeFakeSocket();
    const { result } = renderHook(() =>
      useAiSetupSession({ companyId: 7, createSocket: () => socket as never }),
    );
    await act(async () => {
      await result.current.startSession();
    });

    const proposal: MappingProposal = {
      sessionId: 'sess-1',
      mapping: {
        mappingVersion: 1,
        syncMode: 'snapshot',
        snapshotQuery: 'SELECT p.codigo FROM produtos p',
        batchSize: 100,
        pollIntervalMs: 10000,
        fields: { sourceProductCode: 'codigo', name: 'nome' },
      },
      rationale: 'JOIN entre produtos e desconto_produtos',
      previewRows: [{ codigo: 'A1', nome: 'Dipirona' }],
    };
    act(() => socket.fire(AI_SETUP_SOCKET_EVENTS.mappingProposed, proposal));

    await waitFor(() => expect(result.current.proposal).toEqual(proposal));
  });

  it('approve emite mapping.decision approve com o sessionId e o editedMapping', async () => {
    const socket = makeFakeSocket();
    const { result } = renderHook(() =>
      useAiSetupSession({ companyId: 7, createSocket: () => socket as never }),
    );
    await act(async () => {
      await result.current.startSession();
    });

    const mapping = {
      mappingVersion: 1,
      syncMode: 'snapshot' as const,
      snapshotQuery: 'SELECT p.codigo FROM produtos p',
      batchSize: 100,
      pollIntervalMs: 10000,
      fields: { sourceProductCode: 'codigo', name: 'nome' },
    };

    act(() => result.current.approve(mapping));

    expect(socket.emit).toHaveBeenCalledWith(
      AI_SETUP_SOCKET_EVENTS.mappingDecision,
      { sessionId: 'sess-1', decision: 'approve', editedMapping: mapping },
    );
  });

  it('reject emite mapping.decision reject e abort emite ai.session.abort', async () => {
    const socket = makeFakeSocket();
    const { result } = renderHook(() =>
      useAiSetupSession({ companyId: 7, createSocket: () => socket as never }),
    );
    await act(async () => {
      await result.current.startSession();
    });

    act(() => result.current.reject());
    expect(socket.emit).toHaveBeenCalledWith(
      AI_SETUP_SOCKET_EVENTS.mappingDecision,
      { sessionId: 'sess-1', decision: 'reject' },
    );

    act(() => result.current.abort('usuário cancelou'));
    expect(socket.emit).toHaveBeenCalledWith(
      AI_SETUP_SOCKET_EVENTS.sessionAbort,
      { sessionId: 'sess-1', reason: 'usuário cancelou' },
    );
  });

  it('desconecta o socket ao desmontar', async () => {
    const socket = makeFakeSocket();
    const { result, unmount } = renderHook(() =>
      useAiSetupSession({ companyId: 7, createSocket: () => socket as never }),
    );
    await act(async () => {
      await result.current.startSession();
    });

    unmount();
    expect(socket.disconnect).toHaveBeenCalled();
  });
});
```

### Step 3.2 — Run (espera FAIL)

- [ ] `npx vitest run src/pages/AgentConnectorPanel/aiSetup/hooks/useAiSetupSession.test.tsx`
- Saída esperada: FAIL — `./useAiSetupSession` inexistente.

### Step 3.3 — Implementação mínima

- [ ] Criar `src/pages/AgentConnectorPanel/aiSetup/hooks/useAiSetupSession.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';

import client from 'socket.io-client';

import { startAiSetupSession } from '../services';
import {
  AI_SETUP_SOCKET_EVENTS,
  isAiSessionPhase,
  type AiAuditEvent,
  type AiSessionPhase,
  type AiSessionState,
  type MappingProposal,
  type ValidatedMappingConfig,
} from '../types';

const NEO_DOMAIN_SOCKET =
  import.meta.env.VITE_REACT_APP_NEO_BACKEND_SOCKET_URL ||
  'http://localhost:3333';

// Mesma forma de conexão do socket neo em src/hooks/Socket/index.tsx
// (socket.io-client v2). Exposta como factory para permitir mock nos testes.
type AiSetupSocket = {
  emit: (event: string, payload?: unknown) => void;
  on: (event: string, handler: (payload: never) => void) => void;
  disconnect: () => void;
};

function defaultCreateSocket(): AiSetupSocket {
  return client(NEO_DOMAIN_SOCKET, {
    transports: ['websocket', 'polling'],
    forceNew: true,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    randomizationFactor: 0.5,
    timeout: 6000,
    autoConnect: true,
  }) as unknown as AiSetupSocket;
}

type UseAiSetupSessionArgs = {
  companyId: number;
  createSocket?: () => AiSetupSocket;
};

export interface UseAiSetupSessionResult {
  phase: AiSessionPhase | null;
  events: AiAuditEvent[];
  proposal: MappingProposal | null;
  detail: string | null;
  sessionId: string | null;
  starting: boolean;
  startError: boolean;
  startSession: () => Promise<void>;
  approve: (editedMapping?: ValidatedMappingConfig) => void;
  reject: () => void;
  abort: (reason: string) => void;
}

export function useAiSetupSession({
  companyId,
  createSocket = defaultCreateSocket,
}: UseAiSetupSessionArgs): UseAiSetupSessionResult {
  const [phase, setPhase] = useState<AiSessionPhase | null>(null);
  const [events, setEvents] = useState<AiAuditEvent[]>([]);
  const [proposal, setProposal] = useState<MappingProposal | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState(false);

  const socketRef = useRef<AiSetupSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  const ensureSocket = useCallback((): AiSetupSocket => {
    if (socketRef.current) return socketRef.current;

    const socket = createSocket();
    socketRef.current = socket;

    socket.on(AI_SETUP_SOCKET_EVENTS.auditEvent, (payload: AiAuditEvent) => {
      setEvents((prev) => {
        if (prev.some((e) => e.seq === payload.seq)) return prev;
        return [...prev, payload].sort((a, b) => a.seq - b.seq);
      });
    });

    socket.on(
      AI_SETUP_SOCKET_EVENTS.sessionState,
      (payload: AiSessionState) => {
        if (isAiSessionPhase(payload.phase)) setPhase(payload.phase);
        setDetail(payload.detail ?? null);
      },
    );

    socket.on(
      AI_SETUP_SOCKET_EVENTS.mappingProposed,
      (payload: MappingProposal) => {
        setProposal(payload);
      },
    );

    return socket;
  }, [createSocket]);

  const startSession = useCallback(async () => {
    setStarting(true);
    setStartError(false);
    setEvents([]);
    setProposal(null);
    setDetail(null);
    setPhase(null);
    try {
      // FLUXO CANÔNICO: REST inicia a sessão; o socket apenas transmite.
      const { sessionId: created } = await startAiSetupSession(companyId);
      sessionIdRef.current = created;
      setSessionId(created);
      // Garante o socket conectado e entra na sala da company para RECEBER os eventos.
      const socket = ensureSocket();
      socket.emit(AI_SETUP_SOCKET_EVENTS.joinCompany, companyId);
    } catch {
      setStartError(true);
    } finally {
      setStarting(false);
    }
  }, [companyId, ensureSocket]);

  const approve = useCallback((editedMapping?: ValidatedMappingConfig) => {
    const sid = sessionIdRef.current;
    if (!sid || !socketRef.current) return;
    socketRef.current.emit(AI_SETUP_SOCKET_EVENTS.mappingDecision, {
      sessionId: sid,
      decision: 'approve',
      ...(editedMapping ? { editedMapping } : {}),
    });
  }, []);

  const reject = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!sid || !socketRef.current) return;
    socketRef.current.emit(AI_SETUP_SOCKET_EVENTS.mappingDecision, {
      sessionId: sid,
      decision: 'reject',
    });
  }, []);

  const abort = useCallback((reason: string) => {
    const sid = sessionIdRef.current;
    if (!sid || !socketRef.current) return;
    socketRef.current.emit(AI_SETUP_SOCKET_EVENTS.sessionAbort, {
      sessionId: sid,
      reason,
    });
  }, []);

  useEffect(() => {
    return () => {
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, []);

  return {
    phase,
    events,
    proposal,
    detail,
    sessionId,
    starting,
    startError,
    startSession,
    approve,
    reject,
    abort,
  };
}
```

### Step 3.4 — Run (espera PASS)

- [ ] `npx vitest run src/pages/AgentConnectorPanel/aiSetup/hooks/useAiSetupSession.test.tsx`
- Saída esperada: PASS (7 testes).

### Step 3.5 — Commit

- [ ] `git add src/pages/AgentConnectorPanel/aiSetup/hooks/useAiSetupSession.ts src/pages/AgentConnectorPanel/aiSetup/hooks/useAiSetupSession.test.tsx`
- [ ] `git commit -m "feat: hook de assinatura da sessão de setup por IA"`

---

## Tarefa 4 — styles.ts da feature (tokens do design.md)

Sem teste próprio (apenas styled-components); validado pelos testes dos componentes. Usa **somente** tokens do design.md: `DARK_TEXT #605e70`, `MUTED_TEXT #737185`, `SOFT_BORDER rgba(0,0,0,0.06)`, `SUCCESS_GREEN #10B981`, `WARNING_AMBER #F59E0B`, `CARD_RADIUS 18px`, `SHADOW_MD`, `var(--color-primary-base)`, fonte mono para SQL/dados técnicos, erro `#dc2626`. Nenhuma cor de paleta de gráfico. Toda animação sob `@media (prefers-reduced-motion: no-preference)`.

### Step 4.1 — Implementação (sem TDD; arquivo de estilo)

- [ ] Criar `src/pages/AgentConnectorPanel/aiSetup/styles.ts`:

```ts
import styled from 'styled-components';

import { fadeIn, spin } from '../components/animations/keyframes';

const DARK_TEXT = '#605e70';
const MUTED_TEXT = '#737185';
const SOFT_BORDER = 'rgba(0, 0, 0, 0.06)';
const SUCCESS_GREEN = '#10B981';
const WARNING_AMBER = '#F59E0B';
const ERROR_RED = '#dc2626';
const CARD_RADIUS = '18px';
const HANDOFF_GAP = '18px';
const SHADOW_MD =
  '0 8px 24px -8px rgba(26, 19, 32, 0.12), 0 2px 6px rgba(26, 19, 32, 0.05)';

export const AiSetupContainer = styled.section`
  display: flex;
  flex-direction: column;
  gap: ${HANDOFF_GAP};
`;

export const AiSetupIntro = styled.p`
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.5;
  color: ${MUTED_TEXT};
`;

export const TimelineList = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
`;

export const TimelineItem = styled.li`
  display: flex;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid ${SOFT_BORDER};
  border-radius: ${CARD_RADIUS};
  background: #ffffff;

  @media (prefers-reduced-motion: no-preference) {
    animation: ${fadeIn} 0.4s ease both;
  }
`;

export const TimelineIcon = styled.span<{ $tone: 'info' | 'success' | 'error' }>`
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: ${({ $tone }) =>
    $tone === 'success'
      ? `color-mix(in srgb, ${SUCCESS_GREEN} 14%, transparent)`
      : $tone === 'error'
        ? `color-mix(in srgb, ${ERROR_RED} 12%, transparent)`
        : 'color-mix(in srgb, var(--color-primary-base) 10%, transparent)'};
  color: ${({ $tone }) =>
    $tone === 'success'
      ? SUCCESS_GREEN
      : $tone === 'error'
        ? ERROR_RED
        : 'var(--color-primary-base)'};
`;

export const TimelineBody = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
`;

export const TimelineSummary = styled.span`
  font-size: 0.875rem;
  font-weight: 600;
  color: ${DARK_TEXT};
`;

export const TimelineTool = styled.span`
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.75rem;
  color: ${MUTED_TEXT};
`;

export const TimelineDetailToggle = styled.button`
  align-self: flex-start;
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-primary-base);

  &:hover {
    color: var(--color-primary-dark);
  }
`;

export const TimelineDetail = styled.pre`
  margin: 4px 0 0;
  padding: 8px 10px;
  border-radius: 12px;
  background: #f8f9fa;
  border: 1px solid ${SOFT_BORDER};
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.75rem;
  color: ${DARK_TEXT};
  white-space: pre-wrap;
  word-break: break-word;
`;

export const PhaseBadge = styled.span<{ $tone: 'info' | 'success' | 'error' }>`
  align-self: flex-start;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  background: ${({ $tone }) =>
    $tone === 'success'
      ? `color-mix(in srgb, ${SUCCESS_GREEN} 12%, transparent)`
      : $tone === 'error'
        ? `color-mix(in srgb, ${ERROR_RED} 10%, transparent)`
        : `color-mix(in srgb, ${WARNING_AMBER} 14%, transparent)`};
  color: ${({ $tone }) =>
    $tone === 'success'
      ? SUCCESS_GREEN
      : $tone === 'error'
        ? ERROR_RED
        : WARNING_AMBER};
`;

export const ApprovalCard = styled.section`
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 22px;
  border: 1px solid ${SOFT_BORDER};
  border-radius: ${CARD_RADIUS};
  background: #ffffff;
  box-shadow: ${SHADOW_MD};
`;

export const ApprovalTitle = styled.h4`
  margin: 0;
  font-size: 1rem;
  font-weight: 800;
  letter-spacing: -0.01em;
  color: ${DARK_TEXT};
`;

export const ApprovalLabel = styled.span`
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: ${MUTED_TEXT};
`;

export const QueryTextarea = styled.textarea`
  width: 100%;
  min-height: 96px;
  resize: vertical;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid ${SOFT_BORDER};
  background: rgba(255, 255, 255, 0.85);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8125rem;
  color: #3a3847;

  &:focus {
    outline: none;
    border-color: var(--color-primary-base);
    box-shadow: 0 0 0 3px rgba(230, 40, 74, 0.12);
  }
`;

export const FieldsList = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
`;

export const FieldRow = styled.li`
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
  border-bottom: 1px solid ${SOFT_BORDER};
  font-size: 0.875rem;
  color: ${DARK_TEXT};

  & > span:last-child {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: ${MUTED_TEXT};
  }
`;

export const Rationale = styled.p`
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.5;
  color: ${MUTED_TEXT};
`;

export const PreviewTableWrap = styled.div`
  overflow-x: auto;
  border: 1px solid ${SOFT_BORDER};
  border-radius: 12px;
`;

export const PreviewTable = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8125rem;

  th,
  td {
    text-align: left;
    padding: 8px 10px;
    border-bottom: 1px solid ${SOFT_BORDER};
    color: ${DARK_TEXT};
    white-space: nowrap;
  }

  th {
    font-size: 0.6875rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: ${MUTED_TEXT};
  }
`;

export const ApprovalActions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 10px;
`;

export const Spinner = styled.span`
  width: 16px;
  height: 16px;
  border-radius: 999px;
  border: 2px solid color-mix(in srgb, var(--color-primary-base) 30%, transparent);
  border-top-color: var(--color-primary-base);
  display: inline-block;

  @media (prefers-reduced-motion: no-preference) {
    animation: ${spin} 0.8s linear infinite;
  }
`;

export const StateBanner = styled.div<{ $tone: 'success' | 'error' }>`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-radius: ${CARD_RADIUS};
  font-size: 0.875rem;
  font-weight: 600;
  background: ${({ $tone }) =>
    $tone === 'success'
      ? `color-mix(in srgb, ${SUCCESS_GREEN} 8%, transparent)`
      : `color-mix(in srgb, ${ERROR_RED} 8%, transparent)`};
  border: 1px solid
    ${({ $tone }) =>
      $tone === 'success'
        ? `color-mix(in srgb, ${SUCCESS_GREEN} 30%, transparent)`
        : `color-mix(in srgb, ${ERROR_RED} 30%, transparent)`};
  color: ${({ $tone }) => ($tone === 'success' ? SUCCESS_GREEN : ERROR_RED)};
`;
```

### Step 4.2 — Run (sanidade de tipos via teste já existente)

- [ ] `npx vitest run src/pages/AgentConnectorPanel/aiSetup/types.test.ts`
- Saída esperada: PASS (garante que o diretório compila; o styles.ts é exercido nas tarefas 5–6).

### Step 4.3 — Commit

- [ ] `git add src/pages/AgentConnectorPanel/aiSetup/styles.ts`
- [ ] `git commit -m "feat: estilos do setup por IA com tokens do design system"`

---

## Tarefa 5 — Timeline de auditoria (aiSetup/AiAuditTimeline.tsx)

### Step 5.1 — Write failing test

- [ ] Criar `src/pages/AgentConnectorPanel/aiSetup/AiAuditTimeline.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AiAuditTimeline } from './AiAuditTimeline';
import type { AiAuditEvent } from './types';

const events: AiAuditEvent[] = [
  {
    sessionId: 's1',
    seq: 1,
    at: '2026-06-03T10:00:01Z',
    kind: 'tool_invoke',
    tool: 'schema.listTables',
    summary: 'listando tabelas',
  },
  {
    sessionId: 's1',
    seq: 2,
    at: '2026-06-03T10:00:02Z',
    kind: 'tool_result',
    tool: 'fs.readConfigFile',
    summary: 'credencial encontrada',
    detail: 'user=sa;password=[REDACTED]',
  },
  {
    sessionId: 's1',
    seq: 3,
    at: '2026-06-03T10:00:03Z',
    kind: 'error',
    summary: 'falha de conexão',
  },
];

describe('AiAuditTimeline', () => {
  it('renderiza os eventos em ordem de seq', () => {
    render(<AiAuditTimeline events={events} phase="schema" />);

    const items = screen.getAllByTestId(/^ai-audit-item-/);
    expect(items.map((el) => el.getAttribute('data-testid'))).toEqual([
      'ai-audit-item-1',
      'ai-audit-item-2',
      'ai-audit-item-3',
    ]);
  });

  it('exibe a badge da fase atual', () => {
    render(<AiAuditTimeline events={events} phase="schema" />);
    expect(screen.getByTestId('ai-audit-phase')).toHaveTextContent('schema');
  });

  it('expande o detail e exibe o segredo redigido exatamente como veio', () => {
    render(<AiAuditTimeline events={events} phase="credentials" />);

    fireEvent.click(screen.getByTestId('ai-audit-detail-toggle-2'));

    expect(screen.getByTestId('ai-audit-detail-2')).toHaveTextContent(
      'user=sa;password=[REDACTED]',
    );
  });

  it('renderiza estado vazio quando não há eventos', () => {
    render(<AiAuditTimeline events={[]} phase={null} />);
    expect(screen.getByTestId('ai-audit-empty')).toBeInTheDocument();
  });
});
```

### Step 5.2 — Run (espera FAIL)

- [ ] `npx vitest run src/pages/AgentConnectorPanel/aiSetup/AiAuditTimeline.test.tsx`
- Saída esperada: FAIL — `./AiAuditTimeline` inexistente.

### Step 5.3 — Implementação mínima

- [ ] Criar `src/pages/AgentConnectorPanel/aiSetup/AiAuditTimeline.tsx`:

```tsx
import { useState } from 'react';

import { translation } from 'translation/i18n';

import {
  PhaseBadge,
  TimelineBody,
  TimelineDetail,
  TimelineDetailToggle,
  TimelineIcon,
  TimelineItem,
  TimelineList,
  TimelineSummary,
  TimelineTool,
} from './styles';
import {
  type AiAuditEvent,
  type AiAuditEventKind,
  type AiSessionPhase,
} from './types';

type Props = {
  events: AiAuditEvent[];
  phase: AiSessionPhase | null;
};

function toneForKind(kind: AiAuditEventKind): 'info' | 'success' | 'error' {
  if (kind === 'error' || kind === 'warning') return 'error';
  if (kind === 'tool_result') return 'success';
  return 'info';
}

function iconForKind(kind: AiAuditEventKind): string {
  if (kind === 'error' || kind === 'warning') return '!';
  if (kind === 'tool_result') return '✓';
  return '•';
}

function toneForPhase(
  phase: AiSessionPhase | null,
): 'info' | 'success' | 'error' {
  if (phase === 'synced') return 'success';
  if (phase === 'failed' || phase === 'aborted') return 'error';
  return 'info';
}

export function AiAuditTimeline({ events, phase }: Props) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  return (
    <div data-testid="ai-audit-timeline">
      {phase ? (
        <PhaseBadge $tone={toneForPhase(phase)} data-testid="ai-audit-phase">
          {translation.t(`pages.agentConnector.aiSetup.phases.${phase}`)}
        </PhaseBadge>
      ) : null}

      {events.length === 0 ? (
        <p data-testid="ai-audit-empty">
          {translation.t('pages.agentConnector.aiSetup.timeline.empty')}
        </p>
      ) : (
        <TimelineList>
          {events.map((event) => {
            const tone = toneForKind(event.kind);
            const isOpen = expanded[event.seq] ?? false;
            return (
              <TimelineItem
                key={event.seq}
                data-testid={`ai-audit-item-${event.seq}`}
              >
                <TimelineIcon $tone={tone} aria-hidden="true">
                  {iconForKind(event.kind)}
                </TimelineIcon>
                <TimelineBody>
                  <TimelineSummary>{event.summary}</TimelineSummary>
                  {event.tool ? (
                    <TimelineTool>{event.tool}</TimelineTool>
                  ) : null}
                  {event.detail ? (
                    <>
                      <TimelineDetailToggle
                        type="button"
                        data-testid={`ai-audit-detail-toggle-${event.seq}`}
                        onClick={() =>
                          setExpanded((prev) => ({
                            ...prev,
                            [event.seq]: !isOpen,
                          }))
                        }
                      >
                        {isOpen
                          ? translation.t(
                              'pages.agentConnector.aiSetup.timeline.hideDetail',
                            )
                          : translation.t(
                              'pages.agentConnector.aiSetup.timeline.showDetail',
                            )}
                      </TimelineDetailToggle>
                      {isOpen ? (
                        <TimelineDetail
                          data-testid={`ai-audit-detail-${event.seq}`}
                        >
                          {event.detail}
                        </TimelineDetail>
                      ) : null}
                    </>
                  ) : null}
                </TimelineBody>
              </TimelineItem>
            );
          })}
        </TimelineList>
      )}
    </div>
  );
}
```

> Nota: as chaves i18n usadas aqui (`phases.*`, `timeline.*`) serão criadas na Tarefa 8. Para os testes desta tarefa passarem antes da Tarefa 8, o teste assere `toHaveTextContent('schema')`: como o i18n já está inicializado com `fallbackLng: 'pt'` e a chave ainda não existe, `translation.t` retorna a própria chave (`...phases.schema`), que **contém** a substring `schema` — o `toHaveTextContent` parcial passa. Os asserts de detail/seq/empty não dependem de texto traduzido. (Se preferir, execute a Tarefa 8 antes desta; ambas as ordens passam.)

### Step 5.4 — Run (espera PASS)

- [ ] `npx vitest run src/pages/AgentConnectorPanel/aiSetup/AiAuditTimeline.test.tsx`
- Saída esperada: PASS (4 testes).

### Step 5.5 — Commit

- [ ] `git add src/pages/AgentConnectorPanel/aiSetup/AiAuditTimeline.tsx src/pages/AgentConnectorPanel/aiSetup/AiAuditTimeline.test.tsx`
- [ ] `git commit -m "feat: timeline de auditoria do setup por IA"`

---

## Tarefa 6 — Card de aprovação do mapping (aiSetup/MappingApprovalCard.tsx)

### Step 6.1 — Write failing test

- [ ] Criar `src/pages/AgentConnectorPanel/aiSetup/MappingApprovalCard.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MappingApprovalCard } from './MappingApprovalCard';
import type { MappingProposal } from './types';

const proposal: MappingProposal = {
  sessionId: 's1',
  mapping: {
    mappingVersion: 1,
    syncMode: 'snapshot',
    snapshotQuery:
      'SELECT p.codigo, p.nome FROM produtos p LEFT JOIN desconto_produtos dp ON dp.produto_id = p.id',
    batchSize: 100,
    pollIntervalMs: 10000,
    fields: {
      sourceProductCode: 'codigo',
      name: 'nome',
      price: 'preco_final',
    },
  },
  rationale: 'JOIN entre produtos e desconto_produtos via produto_id',
  previewRows: [
    { codigo: 'A1', nome: 'Dipirona', preco_final: 9.9 },
    { codigo: 'A2', nome: 'Paracetamol', preco_final: 7.5 },
  ],
};

describe('MappingApprovalCard', () => {
  it('mostra a query, o rationale e as previewRows', () => {
    render(
      <MappingApprovalCard
        proposal={proposal}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );

    expect(screen.getByTestId('mapping-query')).toHaveValue(
      proposal.mapping.snapshotQuery,
    );
    expect(screen.getByText(proposal.rationale)).toBeInTheDocument();
    expect(screen.getAllByTestId(/^mapping-preview-row-/)).toHaveLength(2);
    expect(screen.getByTestId('mapping-field-sourceProductCode')).toHaveTextContent(
      'codigo',
    );
  });

  it('Aprovar chama onApprove com o mapping (query inalterada)', () => {
    const onApprove = vi.fn();
    render(
      <MappingApprovalCard
        proposal={proposal}
        onApprove={onApprove}
        onReject={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('mapping-approve-button'));

    expect(onApprove).toHaveBeenCalledWith(proposal.mapping);
  });

  it('Aprovar com query editada envia editedMapping com a nova snapshotQuery', () => {
    const onApprove = vi.fn();
    render(
      <MappingApprovalCard
        proposal={proposal}
        onApprove={onApprove}
        onReject={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByTestId('mapping-query'), {
      target: { value: 'SELECT p.codigo, p.nome FROM produtos p' },
    });
    fireEvent.click(screen.getByTestId('mapping-approve-button'));

    expect(onApprove).toHaveBeenCalledWith({
      ...proposal.mapping,
      snapshotQuery: 'SELECT p.codigo, p.nome FROM produtos p',
    });
  });

  it('Rejeitar chama onReject', () => {
    const onReject = vi.fn();
    render(
      <MappingApprovalCard
        proposal={proposal}
        onApprove={vi.fn()}
        onReject={onReject}
      />,
    );

    fireEvent.click(screen.getByTestId('mapping-reject-button'));

    expect(onReject).toHaveBeenCalledTimes(1);
  });
});
```

### Step 6.2 — Run (espera FAIL)

- [ ] `npx vitest run src/pages/AgentConnectorPanel/aiSetup/MappingApprovalCard.test.tsx`
- Saída esperada: FAIL — `./MappingApprovalCard` inexistente.

### Step 6.3 — Implementação mínima

- [ ] Criar `src/pages/AgentConnectorPanel/aiSetup/MappingApprovalCard.tsx`:

```tsx
import { useMemo, useState } from 'react';

import { Button, ButtonLabel } from 'global';
import { translation } from 'translation/i18n';

import {
  ApprovalActions,
  ApprovalCard,
  ApprovalLabel,
  ApprovalTitle,
  FieldRow,
  FieldsList,
  PreviewTable,
  PreviewTableWrap,
  QueryTextarea,
  Rationale,
} from './styles';
import {
  type MappingProposal,
  type ValidatedMappingConfig,
} from './types';

type Props = {
  proposal: MappingProposal;
  onApprove: (editedMapping: ValidatedMappingConfig) => void;
  onReject: () => void;
};

function originalQuery(mapping: ValidatedMappingConfig): string {
  return mapping.syncMode === 'incremental'
    ? (mapping.incrementalQuery ?? '')
    : (mapping.snapshotQuery ?? '');
}

export function MappingApprovalCard({ proposal, onApprove, onReject }: Props) {
  const { mapping, rationale, previewRows } = proposal;
  const [query, setQuery] = useState(() => originalQuery(mapping));

  const fieldEntries = useMemo(
    () =>
      Object.entries(mapping.fields).filter(
        ([, value]) => typeof value === 'string' && value.length > 0,
      ) as Array<[string, string]>,
    [mapping.fields],
  );

  const columns = useMemo(() => {
    const keys = new Set<string>();
    previewRows.forEach((row) =>
      Object.keys(row).forEach((key) => keys.add(key)),
    );
    return [...keys];
  }, [previewRows]);

  function buildEditedMapping(): ValidatedMappingConfig {
    if (query === originalQuery(mapping)) return mapping;
    return mapping.syncMode === 'incremental'
      ? { ...mapping, incrementalQuery: query }
      : { ...mapping, snapshotQuery: query };
  }

  return (
    <ApprovalCard data-testid="mapping-approval-card">
      <ApprovalTitle>
        {translation.t('pages.agentConnector.aiSetup.approval.title')}
      </ApprovalTitle>

      <div>
        <ApprovalLabel>
          {translation.t('pages.agentConnector.aiSetup.approval.queryLabel')}
        </ApprovalLabel>
        <QueryTextarea
          data-testid="mapping-query"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div>
        <ApprovalLabel>
          {translation.t('pages.agentConnector.aiSetup.approval.fieldsLabel')}
        </ApprovalLabel>
        <FieldsList>
          {fieldEntries.map(([canonical, column]) => (
            <FieldRow
              key={canonical}
              data-testid={`mapping-field-${canonical}`}
            >
              <span>{canonical}</span>
              <span>{column}</span>
            </FieldRow>
          ))}
        </FieldsList>
      </div>

      <div>
        <ApprovalLabel>
          {translation.t('pages.agentConnector.aiSetup.approval.rationaleLabel')}
        </ApprovalLabel>
        <Rationale>{rationale}</Rationale>
      </div>

      {previewRows.length > 0 ? (
        <PreviewTableWrap>
          <PreviewTable data-testid="mapping-preview-table">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {previewRows.map((row, index) => (
                <tr
                  // biome-ignore lint/suspicious/noArrayIndexKey: previewRows são imutáveis e sem id estável
                  key={index}
                  data-testid={`mapping-preview-row-${index}`}
                >
                  {columns.map((column) => (
                    <td key={column}>
                      {row[column] === null || row[column] === undefined
                        ? '—'
                        : String(row[column])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </PreviewTable>
        </PreviewTableWrap>
      ) : null}

      <ApprovalActions>
        <Button
          type="button"
          variant="secondary"
          onClick={onReject}
          datatestid="mapping-reject-button"
        >
          <ButtonLabel
            label={translation.t('pages.agentConnector.aiSetup.approval.reject')}
            loading={false}
            variant="secondary"
          />
        </Button>
        <Button
          type="button"
          variant="primary"
          onClick={() => onApprove(buildEditedMapping())}
          datatestid="mapping-approve-button"
        >
          <ButtonLabel
            label={translation.t('pages.agentConnector.aiSetup.approval.approve')}
            loading={false}
            variant="primary"
          />
        </Button>
      </ApprovalActions>
    </ApprovalCard>
  );
}
```

> **Suposição:** `Button` + `ButtonLabel` de `global` aceitam `datatestid`/`variant`/`label`/`loading` como em `ProbeDiscoverySection.tsx`. Caso `ButtonLabel` não tenha variante `secondary`, usar `variant="primary"` no botão de rejeitar mantendo `variant="secondary"` no `Button`; ajustar conforme a assinatura real verificada em `global`.

### Step 6.4 — Run (espera PASS)

- [ ] `npx vitest run src/pages/AgentConnectorPanel/aiSetup/MappingApprovalCard.test.tsx`
- Saída esperada: PASS (4 testes).

### Step 6.5 — Commit

- [ ] `git add src/pages/AgentConnectorPanel/aiSetup/MappingApprovalCard.tsx src/pages/AgentConnectorPanel/aiSetup/MappingApprovalCard.test.tsx`
- [ ] `git commit -m "feat: card de aprovação e edição do mapping da IA"`

---

## Tarefa 7 — Section integradora (aiSetup/AiSetupSection.tsx)

Orquestra o hook (mockado no teste) + filhos: botão "Iniciar setup por IA" → `startSession`; enquanto roda (`phase` em discovering/credentials/schema/proposing/applying) mostra a Timeline + botão Abortar; `proposing` → `MappingApprovalCard` (Aprovar → `approve(editedMapping)`, Rejeitar → `reject()`); `synced` → banner de sucesso; `failed`/`aborted` → banner de erro + botão "Tentar novamente" (`startSession`).

### Step 7.1 — Write failing test

- [ ] Criar `src/pages/AgentConnectorPanel/aiSetup/AiSetupSection.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiSetupSection } from './AiSetupSection';
import type {
  AiAuditEvent,
  AiSessionPhase,
  MappingProposal,
} from './types';

const startSession = vi.fn();
const approve = vi.fn();
const reject = vi.fn();
const abort = vi.fn();

type HookState = {
  phase: AiSessionPhase | null;
  events: AiAuditEvent[];
  proposal: MappingProposal | null;
  detail: string | null;
  starting: boolean;
  startError: boolean;
};

let hookState: HookState;

vi.mock('./hooks/useAiSetupSession', () => ({
  useAiSetupSession: () => ({
    ...hookState,
    sessionId: hookState.phase ? 's1' : null,
    startSession,
    approve,
    reject,
    abort,
  }),
}));

const proposal: MappingProposal = {
  sessionId: 's1',
  mapping: {
    mappingVersion: 1,
    syncMode: 'snapshot',
    snapshotQuery: 'SELECT p.codigo FROM produtos p',
    batchSize: 100,
    pollIntervalMs: 10000,
    fields: { sourceProductCode: 'codigo', name: 'nome' },
  },
  rationale: 'só produtos',
  previewRows: [{ codigo: 'A1', nome: 'Dipirona' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  hookState = {
    phase: null,
    events: [],
    proposal: null,
    detail: null,
    starting: false,
    startError: false,
  };
});

describe('AiSetupSection', () => {
  it('mostra o botão de iniciar quando não há sessão e chama startSession', () => {
    render(<AiSetupSection companyId={9} />);

    fireEvent.click(screen.getByTestId('ai-setup-start-button'));
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it('mostra a timeline enquanto a sessão roda', () => {
    hookState.phase = 'schema';
    hookState.events = [
      {
        sessionId: 's1',
        seq: 1,
        at: '2026-06-03T10:00:01Z',
        kind: 'tool_invoke',
        summary: 'inspecionando schema',
      },
    ];
    render(<AiSetupSection companyId={9} />);

    expect(screen.getByTestId('ai-audit-timeline')).toBeInTheDocument();
    expect(screen.getByTestId('ai-setup-abort-button')).toBeInTheDocument();
  });

  it('mostra o card de aprovação na fase proposing e aprova com o mapping', () => {
    hookState.phase = 'proposing';
    hookState.proposal = proposal;
    render(<AiSetupSection companyId={9} />);

    expect(screen.getByTestId('mapping-approval-card')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mapping-approve-button'));
    expect(approve).toHaveBeenCalledWith(proposal.mapping);
  });

  it('mostra sucesso quando synced', () => {
    hookState.phase = 'synced';
    render(<AiSetupSection companyId={9} />);
    expect(screen.getByTestId('ai-setup-success')).toBeInTheDocument();
  });

  it('mostra erro com retry quando failed e o retry chama startSession', () => {
    hookState.phase = 'failed';
    render(<AiSetupSection companyId={9} />);

    expect(screen.getByTestId('ai-setup-error')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ai-setup-retry-button'));
    expect(startSession).toHaveBeenCalledTimes(1);
  });
});
```

### Step 7.2 — Run (espera FAIL)

- [ ] `npx vitest run src/pages/AgentConnectorPanel/aiSetup/AiSetupSection.test.tsx`
- Saída esperada: FAIL — `./AiSetupSection` inexistente.

### Step 7.3 — Implementação mínima

- [ ] Criar `src/pages/AgentConnectorPanel/aiSetup/AiSetupSection.tsx`:

```tsx
import { Button, ButtonLabel } from 'global';
import { translation } from 'translation/i18n';

import { AiAuditTimeline } from './AiAuditTimeline';
import { MappingApprovalCard } from './MappingApprovalCard';
import { useAiSetupSession } from './hooks/useAiSetupSession';
import {
  AiSetupContainer,
  AiSetupIntro,
  ApprovalActions,
  StateBanner,
} from './styles';
import { type AiSessionPhase } from './types';

const RUNNING_PHASES: AiSessionPhase[] = [
  'discovering',
  'credentials',
  'schema',
  'proposing',
  'applying',
];

type Props = {
  companyId: number;
};

export function AiSetupSection({ companyId }: Props) {
  const {
    phase,
    events,
    proposal,
    detail,
    starting,
    startSession,
    approve,
    reject,
    abort,
  } = useAiSetupSession({ companyId });

  const idle = phase === null;
  const running = phase !== null && RUNNING_PHASES.includes(phase);
  const synced = phase === 'synced';
  const errored = phase === 'failed' || phase === 'aborted';

  return (
    <AiSetupContainer
      aria-labelledby="ai-setup-heading"
      data-testid="ai-setup-section"
    >
      <h3 id="ai-setup-heading" style={{ margin: 0 }}>
        {translation.t('pages.agentConnector.aiSetup.title')}
      </h3>
      <AiSetupIntro>
        {translation.t('pages.agentConnector.aiSetup.intro')}
      </AiSetupIntro>

      {idle ? (
        <Button
          type="button"
          variant="primary"
          disabled={starting}
          onClick={() => startSession()}
          datatestid="ai-setup-start-button"
        >
          <ButtonLabel
            label={translation.t('pages.agentConnector.aiSetup.start')}
            loading={starting}
            variant="primary"
          />
        </Button>
      ) : null}

      {running ? (
        <>
          <AiAuditTimeline events={events} phase={phase} />
          {phase === 'proposing' && proposal ? (
            <MappingApprovalCard
              proposal={proposal}
              onApprove={(editedMapping) => approve(editedMapping)}
              onReject={() => reject()}
            />
          ) : null}
          <ApprovalActions>
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                abort(
                  translation.t('pages.agentConnector.aiSetup.abortReason'),
                )
              }
              datatestid="ai-setup-abort-button"
            >
              <ButtonLabel
                label={translation.t('pages.agentConnector.aiSetup.abort')}
                loading={false}
                variant="secondary"
              />
            </Button>
          </ApprovalActions>
        </>
      ) : null}

      {synced ? (
        <StateBanner $tone="success" data-testid="ai-setup-success">
          {translation.t('pages.agentConnector.aiSetup.synced')}
        </StateBanner>
      ) : null}

      {errored ? (
        <>
          <StateBanner $tone="error" data-testid="ai-setup-error">
            {detail ??
              translation.t('pages.agentConnector.aiSetup.failed')}
          </StateBanner>
          <Button
            type="button"
            variant="primary"
            onClick={() => startSession()}
            datatestid="ai-setup-retry-button"
          >
            <ButtonLabel
              label={translation.t('pages.agentConnector.aiSetup.retry')}
              loading={starting}
              variant="primary"
            />
          </Button>
        </>
      ) : null}
    </AiSetupContainer>
  );
}
```

### Step 7.4 — Run (espera PASS)

- [ ] `npx vitest run src/pages/AgentConnectorPanel/aiSetup/AiSetupSection.test.tsx`
- Saída esperada: PASS (5 testes).

### Step 7.5 — Commit

- [ ] `git add src/pages/AgentConnectorPanel/aiSetup/AiSetupSection.tsx src/pages/AgentConnectorPanel/aiSetup/AiSetupSection.test.tsx`
- [ ] `git commit -m "feat: section integradora do setup por IA"`

---

## Tarefa 8 — Strings i18n (ptBr) + método ai_setup

### Step 8.1 — Write failing test

- [ ] Criar `src/pages/AgentConnectorPanel/aiSetup/i18n.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { translation } from 'translation/i18n';

describe('i18n pages.agentConnector.aiSetup (ptBr)', () => {
  it('expõe as chaves usadas pela UI de setup por IA', () => {
    const base = 'pages.agentConnector.aiSetup';
    const keys = [
      'title',
      'intro',
      'start',
      'abort',
      'abortReason',
      'retry',
      'synced',
      'failed',
      'timeline.empty',
      'timeline.showDetail',
      'timeline.hideDetail',
      'approval.title',
      'approval.queryLabel',
      'approval.fieldsLabel',
      'approval.rationaleLabel',
      'approval.approve',
      'approval.reject',
      'phases.discovering',
      'phases.credentials',
      'phases.schema',
      'phases.proposing',
      'phases.applying',
      'phases.synced',
      'phases.failed',
      'phases.aborted',
    ];

    for (const key of keys) {
      const full = `${base}.${key}`;
      // t devolve a própria chave quando não há tradução: então deve diferir.
      expect(translation.t(full)).not.toBe(full);
    }
  });

  it('inclui ai_setup nos métodos de setup', async () => {
    const { SETUP_METHOD_VALUES } = await import('../types');
    expect(SETUP_METHOD_VALUES).toContain('ai_setup');
  });
});
```

### Step 8.2 — Run (espera FAIL)

- [ ] `npx vitest run src/pages/AgentConnectorPanel/aiSetup/i18n.test.ts`
- Saída esperada: FAIL — chaves devolvem a própria string / `ai_setup` ausente.

### Step 8.3 — Implementação mínima

- [ ] Em `src/pages/AgentConnectorPanel/types.ts`, adicionar `'ai_setup'` ao array `SETUP_METHOD_VALUES`:

```ts
export const SETUP_METHOD_VALUES = [
  'unset',
  'manual',
  'file_discovery',
  'probe_discovery',
  'ai_setup',
] as const;
```

- [ ] Em `src/translation/languages/ptBr.ts`, localizar o objeto `pages: { ... }` e adicionar a chave `agentConnector` (logo após uma entrada existente, mantendo a vírgula). Bloco a inserir:

```ts
        agentConnector: {
          aiSetup: {
            title: 'Setup com IA',
            intro:
              'A IA conduz a descoberta do banco, encontra e valida credenciais, inspeciona o schema e propõe o mapeamento dos produtos. Cada passo aparece na linha do tempo, com segredos sempre redigidos.',
            start: 'Iniciar setup por IA',
            abort: 'Cancelar',
            abortReason: 'Cancelado pelo usuário',
            retry: 'Tentar novamente',
            synced: 'Setup concluído. O conector está sincronizando os produtos.',
            failed:
              'Não foi possível concluir o setup automático. Você pode tentar novamente ou usar a configuração manual.',
            timeline: {
              empty: 'Aguardando os primeiros passos da IA…',
              showDetail: 'Ver detalhe',
              hideDetail: 'Ocultar detalhe',
            },
            approval: {
              title: 'Revisar mapeamento proposto',
              queryLabel: 'Consulta SQL',
              fieldsLabel: 'Campos mapeados',
              rationaleLabel: 'Justificativa da IA',
              approve: 'Aprovar',
              reject: 'Rejeitar',
            },
            phases: {
              discovering: 'Descobrindo',
              credentials: 'Credenciais',
              schema: 'Schema',
              proposing: 'Propondo mapeamento',
              applying: 'Aplicando',
              synced: 'Sincronizado',
              failed: 'Falhou',
              aborted: 'Cancelado',
            },
          },
        },
```

> As demais línguas (`enUS`, `esES`, `ptPT`, `fr`, `it`, `de` em `src/translation/languages/*`) seguem **a mesma estrutura** `pages.agentConnector.aiSetup.*`; replicar o bloco traduzido em cada arquivo após o ptBr passar (a UI cai no `fallbackLng: 'pt'` enquanto não traduzido, então o app não quebra).

### Step 8.4 — Run (espera PASS)

- [ ] `npx vitest run src/pages/AgentConnectorPanel/aiSetup/i18n.test.ts`
- Saída esperada: PASS (2 testes).

### Step 8.5 — Commit

- [ ] `git add src/pages/AgentConnectorPanel/types.ts src/translation/languages/ptBr.ts src/pages/AgentConnectorPanel/aiSetup/i18n.test.ts`
- [ ] `git commit -m "feat: strings i18n e método ai_setup do setup por IA"`

---

## Tarefa 9 — Integração no SetupMethodSection (4º card "Setup com IA")

### Step 9.1 — Write failing test

- [ ] Editar `src/pages/AgentConnectorPanel/SetupMethodSection.test.tsx` adicionando um caso (mantendo os existentes). Conteúdo a anexar dentro do `describe` existente:

```tsx
  it('renderiza o card de setup por IA e dispara onSelectMethod com ai_setup', () => {
    const onSelectMethod = vi.fn();
    render(
      <SetupMethodSection
        setupMethodServer="unset"
        draftMethod={null}
        methodSwitchLocked={false}
        onSelectMethod={onSelectMethod}
      />,
    );

    fireEvent.click(screen.getByTestId('setup-method-ai-setup'));
    expect(onSelectMethod).toHaveBeenCalledWith('ai_setup');
  });
```

> Verifique os imports do topo do arquivo de teste; se `fireEvent`/`vi` não estiverem importados, adicioná-los de `@testing-library/react` e `vitest`.

### Step 9.2 — Run (espera FAIL)

- [ ] `npx vitest run src/pages/AgentConnectorPanel/SetupMethodSection.test.tsx`
- Saída esperada: FAIL — `setup-method-ai-setup` não encontrado / tipo `'ai_setup'` não aceito.

### Step 9.3 — Implementação mínima

- [ ] Em `src/pages/AgentConnectorPanel/SetupMethodSection.tsx`:
  - Ampliar o union do tipo `Props` e variáveis derivadas para incluir `'ai_setup'`:

```tsx
type SetupChoice = 'manual' | 'file_discovery' | 'probe_discovery' | 'ai_setup';

type Props = {
  setupMethodServer: SetupMethod;
  draftMethod: SetupChoice | null;
  methodSwitchLocked: boolean;
  onSelectMethod: (method: SetupChoice) => void;
};
```

  - Substituir as anotações inline `'manual' | 'file_discovery' | 'probe_discovery'` por `SetupChoice` em `serverResolved` e `displayedPath`, e incluir `setupMethodServer === 'ai_setup'` na resolução de `serverResolved`.
  - Adicionar `const aiSelected = displayedPath === 'ai_setup';`
  - Adicionar um ícone inline `IconSparkles` (estilo dos demais SVGs do arquivo) e o card, **antes** do card `probe_discovery` (o "Recomendado" passa a ser a IA):

```tsx
function IconSparkles() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
    </svg>
  );
}
```

```tsx
        <MethodCard
          type="button"
          role="radio"
          aria-checked={aiSelected}
          $selected={aiSelected}
          disabled={methodSwitchLocked}
          onClick={() => onSelectMethod('ai_setup')}
          data-testid="setup-method-ai-setup"
        >
          <MethodCardBadge>Recomendado</MethodCardBadge>
          <MethodCardIcon $selected={aiSelected}>
            <IconSparkles />
          </MethodCardIcon>
          <MethodCardTitle>Setup com IA</MethodCardTitle>
          <MethodCardDescription>
            A IA descobre o banco, valida credenciais e propõe o mapeamento dos
            produtos automaticamente.
          </MethodCardDescription>
          <MethodCardRadio $selected={aiSelected} aria-hidden="true" />
        </MethodCard>
```

  - Remover o `<MethodCardBadge>Recomendado</MethodCardBadge>` do card `probe_discovery` (somente um "Recomendado").

### Step 9.4 — Run (espera PASS)

- [ ] `npx vitest run src/pages/AgentConnectorPanel/SetupMethodSection.test.tsx`
- Saída esperada: PASS (existentes + 1 novo).

### Step 9.5 — Commit

- [ ] `git add src/pages/AgentConnectorPanel/SetupMethodSection.tsx src/pages/AgentConnectorPanel/SetupMethodSection.test.tsx`
- [ ] `git commit -m "feat: card de método setup por IA no seletor"`

---

## Tarefa 10 — Renderizar AiSetupSection quando o método é ai_setup (ConfigurationModal)

A `ConfigurationModal` já roteia `probe_discovery → ProbeDiscoverySection`, `manual → ManualConnectionSection`, etc. Adicionar o ramo `ai_setup → AiSetupSection`. (Caminho exato do branch a confirmar no código; o teste valida o comportamento observável.)

### Step 10.1 — Write failing test

- [ ] Criar `src/pages/AgentConnectorPanel/aiSetup/AiSetupSection.integration.test.tsx` (teste leve, render direto da section dentro de um wrapper com método selecionado — independente do roteamento interno do modal):

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./hooks/useAiSetupSession', () => ({
  useAiSetupSession: () => ({
    phase: null,
    events: [],
    proposal: null,
    detail: null,
    sessionId: null,
    starting: false,
    startError: false,
    startSession: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    abort: vi.fn(),
  }),
}));

import { AiSetupSection } from './AiSetupSection';

describe('AiSetupSection no fluxo de configuração', () => {
  it('renderiza o título e o botão de iniciar para a company informada', () => {
    render(<AiSetupSection companyId={123} />);
    expect(screen.getByTestId('ai-setup-section')).toBeInTheDocument();
    expect(screen.getByTestId('ai-setup-start-button')).toBeInTheDocument();
  });
});
```

### Step 10.2 — Run (espera FAIL ou PASS conforme já-existente)

- [ ] `npx vitest run src/pages/AgentConnectorPanel/aiSetup/AiSetupSection.integration.test.tsx`
- Saída esperada inicial: PASS se `AiSetupSection` já existe (tarefa 7). O foco desta tarefa é o **wiring** no modal — passo a seguir.

### Step 10.3 — Implementação mínima (wiring no modal)

- [ ] Ler `src/pages/AgentConnectorPanel/ConfigurationModal.tsx` e localizar onde o método selecionado decide qual section renderizar (procurar pelos usos de `ProbeDiscoverySection` / `displayedPath === 'probe_discovery'`). Adicionar:
  - `import { AiSetupSection } from './aiSetup/AiSetupSection';`
  - Um ramo condicional irmão dos existentes:

```tsx
{selectedMethod === 'ai_setup' ? (
  <AiSetupSection companyId={companyId} />
) : null}
```

  onde `selectedMethod`/`companyId` são as variáveis já em escopo no modal (nomes exatos a confirmar na leitura).
- [ ] Garantir que o `onSelectMethod` do `SetupMethodSection` já encaminhado pelo modal aceita `'ai_setup'` (coberto pela Tarefa 9).

### Step 10.4 — Run (espera PASS)

- [ ] `npx vitest run src/pages/AgentConnectorPanel/ConfigurationModal.test.tsx src/pages/AgentConnectorPanel/aiSetup/AiSetupSection.integration.test.tsx`
- Saída esperada: PASS (sem regressão no modal; nova section renderiza no ramo).

### Step 10.5 — Run completo da página + commit

- [ ] `npx vitest run src/pages/AgentConnectorPanel`
- Saída esperada: PASS (toda a suíte da página verde).
- [ ] `git add src/pages/AgentConnectorPanel/ConfigurationModal.tsx src/pages/AgentConnectorPanel/aiSetup/AiSetupSection.integration.test.tsx`
- [ ] `git commit -m "feat: roteia método ai_setup para a section de setup por IA"`

---

## Self-Review

**Cobertura do escopo (1–6 do pedido):**
1. **Hook de assinatura** — Tarefa 3 (`useAiSetupSession`): cria socket neo (mesma forma do `src/hooks/Socket/index.tsx`), assina `audit.event`/`ai.session.state`/`mapping.proposed`, timeline ordenada por `seq` (com dedup), expõe `phase`/`proposal`, ações `startSession`/`approve`/`reject`/`abort` via `emit`, cleanup `disconnect` no unmount, testado com socket mockado (factory injetável). ✔
2. **Timeline (`AiAuditTimeline`)** — Tarefa 5: ordem por `seq`, ícone por `kind`/`tool`, `summary`, `detail` expansível, badge por `phase`; teste assere ordem e que o segredo redigido (`[REDACTED]`) aparece literalmente como veio. Estilos com tokens do design.md. ✔
3. **Aprovação (`MappingApprovalCard`)** — Tarefa 6: query (`snapshotQuery`/`incrementalQuery`), mapa de `fields`, `rationale`, tabela de `previewRows`, edição da query antes de aprovar (`editedMapping`), botões Aprovar/Rejeitar; testes cobrem approve com/sem edição e reject. ✔
4. **Integração na página** — Tarefas 7 (section por `phase`: timeline → approval em `proposing` → success em `synced` → erro+retry em `failed`/`aborted`, com abortar), 9 (4º card em `SetupMethodSection`), 10 (wiring no `ConfigurationModal`). Estrutura de pastas `aiSetup/` (styles.ts, hooks/, componentes, testes co-localizados) seguindo a convenção da página. ✔
5. **i18n** — Tarefa 8: chaves sob `pages.agentConnector.aiSetup.*` em `ptBr.ts`, via `translation.t`; nota explícita de replicar nas demais línguas com fallback `pt`. ✔
6. **REST de apoio** — Tarefa 2 (`aiSetup/services.ts` `startAiSetupSession` via `neoApi`, padrão de `services.ts`), consumida pelo hook em `startSession`. ✔

**Consistência com o CONTRATO CANÔNICO (REST inicia, socket transmite):** o **início da sessão é exclusivamente** a chamada REST `startAiSetupSession` (`POST /pharma-agent-catalog/companies/:companyId/ai-setup/sessions` → `{ data: { sessionId } }`); **não há emit de `ai.session.start`**. Após o REST, o web entra na sala via `socket.emit('company', companyId)` (`AI_SETUP_SOCKET_EVENTS.joinCompany`) para RECEBER os eventos. Nomes de evento centralizados em `AI_SETUP_SOCKET_EVENTS` e testados literais (Tarefa 1): neo→web (web assina) `audit.event`/`ai.session.state`/`mapping.proposed`; web→neo o web só emite `company` (join), `mapping.decision` e `ai.session.abort`. Payloads: `mapping.decision → {sessionId, decision, editedMapping?}`, `ai.session.abort → {sessionId, reason}`; `audit.event` com `{sessionId,seq,at,kind,tool?,summary,detail?}`; `ai.session.state.phase` ∈ `AI_SESSION_PHASES`; `mapping.proposed → {sessionId, mapping:ValidatedMappingConfig, rationale, previewRows[]}`. `ValidatedMappingConfig` com `mappingVersion/syncMode/snapshotQuery?|incrementalQuery?/cursorField?/cursorType?/batchSize/pollIntervalMs/fields{sourceProductCode,name,price?,stock?,barcode?,active?,sourceUpdatedAt?}`. ✔

**Design (design.md):** todos os estilos usam tokens existentes (`#605e70`, `#737185`, `rgba(0,0,0,0.06)`, `#10B981`, `#F59E0B`, `#dc2626`, `CARD_RADIUS 18px`, `SHADOW_MD`, `var(--color-primary-base)`/`--color-primary-dark`, mono para SQL/dados); nenhuma cor de paleta de gráfico em UI; sem cantos vivos (radius ≥12px em inputs/cards/botões, 999px em pílulas); animações (`fadeIn`, `spin`) sob `@media (prefers-reduced-motion: no-preference)`; reuso dos keyframes existentes em `components/animations/keyframes.ts`. ✔

**Sem placeholders:** todo step traz código completo (sem TODO/"similar a") usando símbolos reais (`useSocket`-style client, `neoApi`, `translation.t`, `Button`/`ButtonLabel` de `global`, tokens de styles). As únicas incógnitas são marcadas como **Suposições** abaixo, não como código vago.

**Suposições (a confirmar na execução):**
- O gateway socket.io do neo para AI-setup relaya na mesma conexão/origin já usada (`VITE_REACT_APP_NEO_BACKEND_SOCKET_URL`); o hook cria conexão própria em vez de reaproveitar o `SocketProvider` global (que tem shape fixo e não expõe estes eventos). Conforme o FLUXO CANÔNICO, após o REST iniciar a sessão o hook entra na sala da company via `socket.emit('company', companyId)` (mesmo padrão do `src/hooks/Socket/index.tsx`) para receber os eventos relayados; se o neo exigir uma sala mais específica (ex.: `ai-setup-{sessionId}`), ajustar apenas esse `emit` de join em `startSession` — ponto único de ajuste.
- Endpoint REST `POST /pharma-agent-catalog/companies/:id/ai-setup/sessions` com envelope `{ data: { sessionId } }` é ilustrativo (mesmo disclaimer que `productSearchStartPath` no `services.ts`); ajustar caminho/shape quando o plano do neo fixar.
- `Button`/`ButtonLabel` de `global` expõem `variant`/`label`/`loading`/`datatestid` como em `ProbeDiscoverySection.tsx`; se `ButtonLabel` não tiver `variant="secondary"`, usar `primary` no label mantendo o `Button variant="secondary"`.
- O nome da variável de método selecionado dentro de `ConfigurationModal.tsx` (Tarefa 10) deve ser confirmado por leitura antes de inserir o ramo `ai_setup`.
- `socket.io-client@^2.3.0` (API v2: `on/emit/disconnect`) — o fake socket dos testes do hook reflete essa API; sem dependência de `io()` named export.
