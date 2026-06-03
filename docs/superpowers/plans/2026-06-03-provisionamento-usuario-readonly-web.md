# Provisionamento de usuário read-only (UI web) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar à UI `AgentConnectorPanel/aiSetup` a fase `provisioning` do setup dirigido por IA — assinatura dos eventos `provision.*`, card de aprovação do usuário read-only e linhas de resultado na timeline — em pt-BR hard-coded (sem i18n).

**Architecture:** Estende a feature existente `src/pages/AgentConnectorPanel/aiSetup` (frente anterior). O hook `useAiSetupSession` passa a assinar `provision.proposed`/`provision.result` (sala `company`), expõe `provisionProposal`/`provisionResult` e as ações `approveProvision()`/`rejectProvision()` que emitem `provision.decision`. Um novo componente `ProvisionApprovalCard` (styled-components com os tokens do `design.md`) aparece quando `phase === 'provisioning'`; o `AiSetupSection` ganha o estado `provisioning` no fluxo; a `AiAuditTimeline` ganha uma linha de resultado conforme `provision.result`. **Texto novo é pt-BR literal no JSX — NÃO usar `translation.t` nem chaves em `translation/languages`.** Os componentes pré-existentes continuam com i18n; só o código NOVO é hard-coded.

**Tech Stack:** React 18 + TypeScript + Vite, styled-components, socket.io-client v2, vitest + React Testing Library.

**Comando de teste (rode os arquivos AFETADOS isoladamente — há hang pré-existente em `ConfigurationModal.test.tsx`):**
`npx vitest run src/pages/AgentConnectorPanel/aiSetup/<arquivo>`

**CONTRATO CANÔNICO (verbatim — NÃO altere nomes):**
- web ASSINA: `provision.proposed` `{ sessionId, username, engine, scope:"all_tables", readOnly:true, rationale? }`
- web ASSINA: `provision.result` `{ sessionId, outcome:"provisioned"|"fallback_no_privilege"|"unsupported_engine"|"error", username, errorCode? }`
- web EMITE: `provision.decision` `{ sessionId, decision:"approve"|"reject" }`
- `ai.session.state` ganha a fase `provisioning` (entre `credentials` e `schema`).

---

## File Structure

Sob `src/pages/AgentConnectorPanel/aiSetup/`:

- **`types.ts`** (modificar) — adiciona `'provisioning'` em `AI_SESSION_PHASES`; adiciona chaves `provisionProposed`/`provisionResult`/`provisionDecision` em `AI_SETUP_SOCKET_EVENTS`; adiciona tipos `ProvisionEngine`, `ProvisionOutcome`, `ProvisionProposal`, `ProvisionResult`, `ProvisionDecision`.
- **`types.test.ts`** (modificar) — cobre `isAiSessionPhase('provisioning')` e os nomes de evento canônicos.
- **`hooks/useAiSetupSession.ts`** (modificar) — assina `provision.proposed`/`provision.result`, expõe `provisionProposal`/`provisionResult`, ações `approveProvision()`/`rejectProvision()`; registra/remove os 2 novos handlers no `ensureSocket`/cleanup.
- **`hooks/useAiSetupSession.test.tsx`** (modificar) — assinatura/exposição dos eventos, emissão de `provision.decision`, `off` no unmount.
- **`ProvisionApprovalCard.tsx`** (criar) — card pt-BR hard-coded com username/engine/escopo/aviso e botões Aprovar/Rejeitar.
- **`ProvisionApprovalCard.test.tsx`** (criar) — render do conteúdo pt-BR + cliques chamam `onApprove`/`onReject`.
- **`styles.ts`** (modificar) — adiciona styled-components `ProvisionWarning` e `ProvisionMetaRow`/`ProvisionMetaList` (tokens existentes: `CARD_RADIUS`, `SHADOW_MD`, `SUCCESS_GREEN`, `WARNING_AMBER`, `var(--color-primary-base)`, `SOFT_BORDER`).
- **`AiSetupSection.tsx`** (modificar) — consome `provisionProposal`/`approveProvision`/`rejectProvision`; na fase `provisioning` renderiza `AiAuditTimeline` + `ProvisionApprovalCard`.
- **`AiSetupSection.test.tsx`** (modificar) — fase `provisioning` mostra o card e os botões chamam as ações.
- **`AiAuditTimeline.tsx`** (modificar) — recebe `provisionResult?` e renderiza uma linha de resultado pt-BR (provisioned/fallback/erro).
- **`AiAuditTimeline.test.tsx`** (modificar) — linha de resultado por outcome.

---

## Task 1: Tipos e nomes de evento `provision.*` em `types.ts`

**Files:**
- Modify: `src/pages/AgentConnectorPanel/aiSetup/types.ts`
- Test: `src/pages/AgentConnectorPanel/aiSetup/types.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

Adicione ao final do `describe` existente em `src/pages/AgentConnectorPanel/aiSetup/types.test.ts` (mantenha os testes já presentes; importe `AI_SETUP_SOCKET_EVENTS` se ainda não importado):

```tsx
import { describe, expect, it } from 'vitest';

import {
  AI_SESSION_PHASES,
  AI_SETUP_SOCKET_EVENTS,
  isAiSessionPhase,
} from './types';

describe('types provisioning', () => {
  it('inclui a fase provisioning entre credentials e schema', () => {
    expect(isAiSessionPhase('provisioning')).toBe(true);
    const idx = AI_SESSION_PHASES.indexOf('provisioning');
    expect(idx).toBe(AI_SESSION_PHASES.indexOf('credentials') + 1);
    expect(idx).toBe(AI_SESSION_PHASES.indexOf('schema') - 1);
  });

  it('expõe os nomes de evento do contrato de provisionamento', () => {
    expect(AI_SETUP_SOCKET_EVENTS.provisionProposed).toBe('provision.proposed');
    expect(AI_SETUP_SOCKET_EVENTS.provisionResult).toBe('provision.result');
    expect(AI_SETUP_SOCKET_EVENTS.provisionDecision).toBe('provision.decision');
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/pages/AgentConnectorPanel/aiSetup/types.test.ts`
Expected: FAIL — `provisioning` não está em `AI_SESSION_PHASES` e `provisionProposed`/`provisionResult`/`provisionDecision` são `undefined`.

- [ ] **Step 3: Implementar os tipos**

Em `src/pages/AgentConnectorPanel/aiSetup/types.ts`, altere `AI_SESSION_PHASES` para incluir `'provisioning'` entre `'credentials'` e `'schema'`:

```tsx
export const AI_SESSION_PHASES = [
  'discovering',
  'credentials',
  'provisioning',
  'schema',
  'proposing',
  'applying',
  'synced',
  'failed',
  'aborted',
] as const;
```

Adicione as 3 chaves ao objeto `AI_SETUP_SOCKET_EVENTS` (não remova nenhuma chave existente):

```tsx
export const AI_SETUP_SOCKET_EVENTS = {
  // neo -> web (web assina)
  auditEvent: 'audit.event',
  sessionState: 'ai.session.state',
  mappingProposed: 'mapping.proposed',
  provisionProposed: 'provision.proposed',
  provisionResult: 'provision.result',
  // web -> neo (web emite)
  // Início é via REST; pelo socket o web só entra na sala da company e emite decisões.
  joinCompany: 'company',
  mappingDecision: 'mapping.decision',
  provisionDecision: 'provision.decision',
  sessionAbort: 'ai.session.abort',
} as const;
```

Adicione os tipos de payload (ao final do arquivo, após `AiSessionAbortPayload`):

```tsx
export type ProvisionEngine =
  | 'mysql'
  | 'mariadb'
  | 'postgres'
  | 'sqlserver'
  | 'firebird';

export type ProvisionOutcome =
  | 'provisioned'
  | 'fallback_no_privilege'
  | 'unsupported_engine'
  | 'error';

export interface ProvisionProposal {
  sessionId: string;
  username: string;
  engine: ProvisionEngine;
  scope: 'all_tables';
  readOnly: true;
  rationale?: string;
}

export interface ProvisionResult {
  sessionId: string;
  outcome: ProvisionOutcome;
  username: string;
  errorCode?: string;
}

export interface ProvisionDecision {
  sessionId: string;
  decision: 'approve' | 'reject';
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npx vitest run src/pages/AgentConnectorPanel/aiSetup/types.test.ts`
Expected: PASS (todos os testes do arquivo, novos e antigos).

- [ ] **Step 5: Commit**

```bash
git add src/pages/AgentConnectorPanel/aiSetup/types.ts src/pages/AgentConnectorPanel/aiSetup/types.test.ts
git commit -m "feat(ai-setup): tipos e eventos provision.* na UI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `useAiSetupSession` assina `provision.*` e expõe ações

**Files:**
- Modify: `src/pages/AgentConnectorPanel/aiSetup/hooks/useAiSetupSession.ts`
- Test: `src/pages/AgentConnectorPanel/aiSetup/hooks/useAiSetupSession.test.tsx`

- [ ] **Step 1: Escrever os testes que falham**

Adicione ao `describe('useAiSetupSession', ...)` em `src/pages/AgentConnectorPanel/aiSetup/hooks/useAiSetupSession.test.tsx` os blocos abaixo. Importe os tipos no topo do arquivo, na linha de import de `../types`, deixando-a assim:

```tsx
import {
  AI_SETUP_SOCKET_EVENTS,
  type AiAuditEvent,
  type AiSessionState,
  type MappingProposal,
  type ProvisionProposal,
  type ProvisionResult,
} from '../types';
```

Novos testes (cole antes do `});` que fecha o `describe`):

```tsx
  it('guarda a proposta de provisionamento de provision.proposed', async () => {
    const socket = makeFakeSocket();
    const { result } = renderHook(() =>
      useAiSetupSession({ companyId: 7, createSocket: () => socket as never }),
    );
    await act(async () => {
      await result.current.startSession();
    });

    const proposal: ProvisionProposal = {
      sessionId: 'sess-1',
      username: 'pharma_connector_ro',
      engine: 'mysql',
      scope: 'all_tables',
      readOnly: true,
      rationale: 'least-privilege',
    };
    act(() => socket.fire(AI_SETUP_SOCKET_EVENTS.provisionProposed, proposal));

    await waitFor(() =>
      expect(result.current.provisionProposal).toEqual(proposal),
    );
  });

  it('guarda o resultado de provisionamento de provision.result', async () => {
    const socket = makeFakeSocket();
    const { result } = renderHook(() =>
      useAiSetupSession({ companyId: 7, createSocket: () => socket as never }),
    );
    await act(async () => {
      await result.current.startSession();
    });

    const res: ProvisionResult = {
      sessionId: 'sess-1',
      outcome: 'provisioned',
      username: 'pharma_connector_ro',
    };
    act(() => socket.fire(AI_SETUP_SOCKET_EVENTS.provisionResult, res));

    await waitFor(() => expect(result.current.provisionResult).toEqual(res));
  });

  it('approveProvision emite provision.decision approve com o sessionId', async () => {
    const socket = makeFakeSocket();
    const { result } = renderHook(() =>
      useAiSetupSession({ companyId: 7, createSocket: () => socket as never }),
    );
    await act(async () => {
      await result.current.startSession();
    });

    act(() => result.current.approveProvision());

    expect(socket.emit).toHaveBeenCalledWith(
      AI_SETUP_SOCKET_EVENTS.provisionDecision,
      { sessionId: 'sess-1', decision: 'approve' },
    );
  });

  it('rejectProvision emite provision.decision reject com o sessionId', async () => {
    const socket = makeFakeSocket();
    const { result } = renderHook(() =>
      useAiSetupSession({ companyId: 7, createSocket: () => socket as never }),
    );
    await act(async () => {
      await result.current.startSession();
    });

    act(() => result.current.rejectProvision());

    expect(socket.emit).toHaveBeenCalledWith(
      AI_SETUP_SOCKET_EVENTS.provisionDecision,
      { sessionId: 'sess-1', decision: 'reject' },
    );
  });

  it('remove os listeners de provision.* (off) ao desmontar', async () => {
    const socket = makeFakeSocket();
    const { result, unmount } = renderHook(() =>
      useAiSetupSession({ companyId: 7, createSocket: () => socket as never }),
    );
    await act(async () => {
      await result.current.startSession();
    });

    unmount();

    const offEvents = socket.off.mock.calls.map(([event]) => event);
    expect(offEvents).toContain(AI_SETUP_SOCKET_EVENTS.provisionProposed);
    expect(offEvents).toContain(AI_SETUP_SOCKET_EVENTS.provisionResult);
  });
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/pages/AgentConnectorPanel/aiSetup/hooks/useAiSetupSession.test.tsx`
Expected: FAIL — `provisionProposal`, `provisionResult`, `approveProvision`, `rejectProvision` não existem no resultado do hook.

- [ ] **Step 3: Implementar no hook**

Em `src/pages/AgentConnectorPanel/aiSetup/hooks/useAiSetupSession.ts`:

a) Estenda os imports de `../types`:

```tsx
import {
  AI_SETUP_SOCKET_EVENTS,
  isAiSessionPhase,
  type AiAuditEvent,
  type AiSessionPhase,
  type AiSessionState,
  type MappingProposal,
  type ProvisionProposal,
  type ProvisionResult,
  type ValidatedMappingConfig,
} from '../types';
```

b) Adicione os campos à interface `UseAiSetupSessionResult`:

```tsx
export interface UseAiSetupSessionResult {
  phase: AiSessionPhase | null;
  events: AiAuditEvent[];
  proposal: MappingProposal | null;
  provisionProposal: ProvisionProposal | null;
  provisionResult: ProvisionResult | null;
  detail: string | null;
  sessionId: string | null;
  starting: boolean;
  startError: boolean;
  startSession: () => Promise<void>;
  approve: (editedMapping?: ValidatedMappingConfig) => void;
  reject: () => void;
  approveProvision: () => void;
  rejectProvision: () => void;
  abort: (reason: string) => void;
}
```

c) Adicione os states (logo após `const [proposal, setProposal] = useState<MappingProposal | null>(null);`):

```tsx
  const [provisionProposal, setProvisionProposal] =
    useState<ProvisionProposal | null>(null);
  const [provisionResult, setProvisionResult] =
    useState<ProvisionResult | null>(null);
```

d) Adicione os 2 handlers ao tipo de `handlersRef` e à sua inicialização. Substitua o bloco de tipo do `handlersRef`:

```tsx
  const handlersRef = useRef<{
    auditEvent: (payload: AiAuditEvent) => void;
    sessionState: (payload: AiSessionState) => void;
    mappingProposed: (payload: MappingProposal) => void;
    provisionProposed: (payload: ProvisionProposal) => void;
    provisionResult: (payload: ProvisionResult) => void;
  } | null>(null);
```

E adicione os handlers dentro do `if (handlersRef.current === null)`, após `mappingProposed`:

```tsx
      provisionProposed: (payload: ProvisionProposal) => {
        setProvisionProposal(payload);
      },
      provisionResult: (payload: ProvisionResult) => {
        setProvisionResult(payload);
      },
```

e) Registre-os em `ensureSocket`, logo após o registro de `mappingProposed` (dentro do `if (handlers) { ... }`):

```tsx
      socket.off(
        AI_SETUP_SOCKET_EVENTS.provisionProposed,
        handlers.provisionProposed as never,
      );
      socket.on(
        AI_SETUP_SOCKET_EVENTS.provisionProposed,
        handlers.provisionProposed,
      );
      socket.off(
        AI_SETUP_SOCKET_EVENTS.provisionResult,
        handlers.provisionResult as never,
      );
      socket.on(
        AI_SETUP_SOCKET_EVENTS.provisionResult,
        handlers.provisionResult,
      );
```

f) Limpe os states novos em `startSession` (após `setProposal(null);`):

```tsx
      setProvisionProposal(null);
      setProvisionResult(null);
```

g) Adicione as ações (após `reject`, antes de `abort`):

```tsx
  const approveProvision = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!sid || !socketRef.current) return;
    socketRef.current.emit(AI_SETUP_SOCKET_EVENTS.provisionDecision, {
      sessionId: sid,
      decision: 'approve',
    });
  }, []);

  const rejectProvision = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!sid || !socketRef.current) return;
    socketRef.current.emit(AI_SETUP_SOCKET_EVENTS.provisionDecision, {
      sessionId: sid,
      decision: 'reject',
    });
  }, []);
```

h) Remova os 2 handlers no cleanup (`useEffect` de unmount), dentro do `if (socket && handlers) { ... }`, após o `off` de `mappingProposed`:

```tsx
        socket.off(
          AI_SETUP_SOCKET_EVENTS.provisionProposed,
          handlers.provisionProposed as never,
        );
        socket.off(
          AI_SETUP_SOCKET_EVENTS.provisionResult,
          handlers.provisionResult as never,
        );
```

i) Exponha tudo no `return`:

```tsx
  return {
    phase,
    events,
    proposal,
    provisionProposal,
    provisionResult,
    detail,
    sessionId,
    starting,
    startError,
    startSession,
    approve,
    reject,
    approveProvision,
    rejectProvision,
    abort,
  };
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/pages/AgentConnectorPanel/aiSetup/hooks/useAiSetupSession.test.tsx`
Expected: PASS (novos e antigos, incluindo o teste de "remove os 3 listeners" que continua válido).

- [ ] **Step 5: Commit**

```bash
git add src/pages/AgentConnectorPanel/aiSetup/hooks/useAiSetupSession.ts src/pages/AgentConnectorPanel/aiSetup/hooks/useAiSetupSession.test.tsx
git commit -m "feat(ai-setup): hook assina provision.* e emite provision.decision

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Estilos do `ProvisionApprovalCard` em `styles.ts`

**Files:**
- Modify: `src/pages/AgentConnectorPanel/aiSetup/styles.ts`

> Reaproveite os tokens já definidos no topo do arquivo (`DARK_TEXT`, `MUTED_TEXT`, `SOFT_BORDER`, `SUCCESS_GREEN`, `WARNING_AMBER`, `CARD_RADIUS`, `SHADOW_MD`). Sem cantos vivos; o card reusa `ApprovalCard`/`ApprovalTitle`/`ApprovalLabel`/`ApprovalActions` existentes — esta task adiciona apenas o que falta.

- [ ] **Step 1: Adicionar os styled-components**

Acrescente ao final de `src/pages/AgentConnectorPanel/aiSetup/styles.ts`:

```tsx
export const ProvisionMetaList = styled.dl`
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
`;

export const ProvisionMetaRow = styled.div`
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
  border-bottom: 1px solid ${SOFT_BORDER};
  font-size: 0.875rem;
  color: ${DARK_TEXT};

  dt {
    margin: 0;
    color: ${MUTED_TEXT};
  }

  dd {
    margin: 0;
    font-weight: 600;
  }

  dd.mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-weight: 600;
  }
`;

export const ProvisionWarning = styled.p`
  margin: 0;
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 12px 14px;
  border-radius: ${CARD_RADIUS};
  font-size: 0.8125rem;
  line-height: 1.5;
  background: color-mix(in srgb, ${WARNING_AMBER} 10%, transparent);
  border: 1px solid color-mix(in srgb, ${WARNING_AMBER} 30%, transparent);
  color: ${DARK_TEXT};

  &::before {
    content: '⚠';
    flex: 0 0 auto;
    color: ${WARNING_AMBER};
    font-size: 1rem;
    line-height: 1.4;
  }
`;
```

> Nota: não há novo teste só de estilo — a cobertura visual vem via render do `ProvisionApprovalCard` na Task 4. `SUCCESS_GREEN` já é usado pela timeline (Task 6).

- [ ] **Step 2: Verificar que o módulo compila (typecheck via teste existente)**

Run: `npx vitest run src/pages/AgentConnectorPanel/aiSetup/AiAuditTimeline.test.tsx`
Expected: PASS — confirma que `styles.ts` segue válido (importado pela timeline) e não quebrou nada.

- [ ] **Step 3: Commit**

```bash
git add src/pages/AgentConnectorPanel/aiSetup/styles.ts
git commit -m "feat(ai-setup): estilos do card de provisionamento read-only

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Componente `ProvisionApprovalCard` (pt-BR hard-coded)

**Files:**
- Create: `src/pages/AgentConnectorPanel/aiSetup/ProvisionApprovalCard.tsx`
- Test: `src/pages/AgentConnectorPanel/aiSetup/ProvisionApprovalCard.test.tsx`

> ⛔ Texto pt-BR LITERAL no JSX. NÃO importe `translation`/`translation.t`.

- [ ] **Step 1: Escrever o teste que falha**

Crie `src/pages/AgentConnectorPanel/aiSetup/ProvisionApprovalCard.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ProvisionApprovalCard } from './ProvisionApprovalCard';
import type { ProvisionProposal } from './types';

const proposal: ProvisionProposal = {
  sessionId: 's1',
  username: 'pharma_connector_ro',
  engine: 'mysql',
  scope: 'all_tables',
  readOnly: true,
  rationale: 'least-privilege',
};

describe('ProvisionApprovalCard', () => {
  it('mostra o usuário proposto, o engine e o escopo somente leitura', () => {
    render(
      <ProvisionApprovalCard
        proposal={proposal}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );

    expect(screen.getByTestId('provision-approval-card')).toBeInTheDocument();
    expect(screen.getByTestId('provision-username')).toHaveTextContent(
      'pharma_connector_ro',
    );
    expect(screen.getByTestId('provision-engine')).toHaveTextContent('MySQL');
    expect(screen.getByTestId('provision-scope')).toHaveTextContent(
      'somente leitura, todas as tabelas',
    );
  });

  it('exibe o aviso de credencial de admin não armazenada', () => {
    render(
      <ProvisionApprovalCard
        proposal={proposal}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );

    expect(screen.getByTestId('provision-warning')).toHaveTextContent(
      'será criado um usuário read-only dedicado para o sync; sua credencial de admin não será armazenada',
    );
  });

  it('chama onApprove ao clicar em Aprovar', () => {
    const onApprove = vi.fn();
    render(
      <ProvisionApprovalCard
        proposal={proposal}
        onApprove={onApprove}
        onReject={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('provision-approve-button'));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('chama onReject ao clicar em Rejeitar', () => {
    const onReject = vi.fn();
    render(
      <ProvisionApprovalCard
        proposal={proposal}
        onApprove={vi.fn()}
        onReject={onReject}
      />,
    );

    fireEvent.click(screen.getByTestId('provision-reject-button'));
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('mostra o rationale quando presente', () => {
    render(
      <ProvisionApprovalCard
        proposal={proposal}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByTestId('provision-rationale')).toHaveTextContent(
      'least-privilege',
    );
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/pages/AgentConnectorPanel/aiSetup/ProvisionApprovalCard.test.tsx`
Expected: FAIL — `Cannot find module './ProvisionApprovalCard'`.

- [ ] **Step 3: Implementar o componente**

Crie `src/pages/AgentConnectorPanel/aiSetup/ProvisionApprovalCard.tsx`:

```tsx
import { Button, ButtonLabel } from 'global';

import {
  ApprovalActions,
  ApprovalCard,
  ApprovalLabel,
  ApprovalTitle,
  ProvisionMetaList,
  ProvisionMetaRow,
  ProvisionWarning,
  Rationale,
} from './styles';
import { type ProvisionEngine, type ProvisionProposal } from './types';

type Props = {
  proposal: ProvisionProposal;
  onApprove: () => void;
  onReject: () => void;
};

const ENGINE_LABELS: Record<ProvisionEngine, string> = {
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  postgres: 'PostgreSQL',
  sqlserver: 'SQL Server',
  firebird: 'Firebird',
};

export function ProvisionApprovalCard({
  proposal,
  onApprove,
  onReject,
}: Props) {
  const { username, engine, rationale } = proposal;

  return (
    <ApprovalCard data-testid="provision-approval-card">
      <ApprovalTitle>Criar usuário somente leitura</ApprovalTitle>

      <div>
        <ApprovalLabel>Detalhes</ApprovalLabel>
        <ProvisionMetaList>
          <ProvisionMetaRow>
            <dt>Usuário</dt>
            <dd className="mono" data-testid="provision-username">
              {username}
            </dd>
          </ProvisionMetaRow>
          <ProvisionMetaRow>
            <dt>Banco de dados</dt>
            <dd data-testid="provision-engine">
              {ENGINE_LABELS[engine] ?? engine}
            </dd>
          </ProvisionMetaRow>
          <ProvisionMetaRow>
            <dt>Escopo</dt>
            <dd data-testid="provision-scope">
              somente leitura, todas as tabelas
            </dd>
          </ProvisionMetaRow>
        </ProvisionMetaList>
      </div>

      <ProvisionWarning data-testid="provision-warning">
        será criado um usuário read-only dedicado para o sync; sua credencial de
        admin não será armazenada
      </ProvisionWarning>

      {rationale ? (
        <div>
          <ApprovalLabel>Motivo</ApprovalLabel>
          <Rationale data-testid="provision-rationale">{rationale}</Rationale>
        </div>
      ) : null}

      <ApprovalActions>
        <Button
          type="button"
          variant="secondary"
          onClick={onReject}
          datatestid="provision-reject-button"
        >
          <ButtonLabel label="Rejeitar" loading={false} variant="secondary" />
        </Button>
        <Button
          type="button"
          variant="primary"
          onClick={onApprove}
          datatestid="provision-approve-button"
        >
          <ButtonLabel label="Aprovar" loading={false} variant="primary" />
        </Button>
      </ApprovalActions>
    </ApprovalCard>
  );
}
```

> O `Button` do `global` aceita a prop `datatestid` (minúsculo, como nos componentes existentes) e a renderiza como `data-testid` no elemento — por isso os testes consultam `provision-approve-button`/`provision-reject-button`.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/pages/AgentConnectorPanel/aiSetup/ProvisionApprovalCard.test.tsx`
Expected: PASS (5 testes).

- [ ] **Step 5: Commit**

```bash
git add src/pages/AgentConnectorPanel/aiSetup/ProvisionApprovalCard.tsx src/pages/AgentConnectorPanel/aiSetup/ProvisionApprovalCard.test.tsx
git commit -m "feat(ai-setup): ProvisionApprovalCard em pt-BR

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Fase `provisioning` no `AiSetupSection`

**Files:**
- Modify: `src/pages/AgentConnectorPanel/aiSetup/AiSetupSection.tsx`
- Test: `src/pages/AgentConnectorPanel/aiSetup/AiSetupSection.test.tsx`

- [ ] **Step 1: Escrever os testes que falham**

Em `src/pages/AgentConnectorPanel/aiSetup/AiSetupSection.test.tsx`:

a) Estenda o `HookState` e o mock para incluir os novos campos/ações. Substitua o tipo `HookState` e o mock por:

```tsx
const startSession = vi.fn();
const approve = vi.fn();
const reject = vi.fn();
const approveProvision = vi.fn();
const rejectProvision = vi.fn();
const abort = vi.fn();

type HookState = {
  phase: AiSessionPhase | null;
  events: AiAuditEvent[];
  proposal: MappingProposal | null;
  provisionProposal: ProvisionProposal | null;
  provisionResult: ProvisionResult | null;
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
    approveProvision,
    rejectProvision,
    abort,
  }),
}));
```

b) Estenda o import de tipos no topo:

```tsx
import type {
  AiAuditEvent,
  AiSessionPhase,
  MappingProposal,
  ProvisionProposal,
  ProvisionResult,
} from './types';
```

c) Adicione a fixture de proposta de provisionamento (após a const `proposal`):

```tsx
const provisionProposal: ProvisionProposal = {
  sessionId: 's1',
  username: 'pharma_connector_ro',
  engine: 'mysql',
  scope: 'all_tables',
  readOnly: true,
  rationale: 'least-privilege',
};
```

d) Inclua os 2 campos novos no `beforeEach` (dentro do objeto `hookState`):

```tsx
  hookState = {
    phase: null,
    events: [],
    proposal: null,
    provisionProposal: null,
    provisionResult: null,
    detail: null,
    starting: false,
    startError: false,
  };
```

e) Acrescente os testes (antes do `});` que fecha o `describe`):

```tsx
  it('mostra a timeline e o card de provisionamento na fase provisioning', () => {
    hookState.phase = 'provisioning';
    hookState.provisionProposal = provisionProposal;
    render(<AiSetupSection companyId={9} />);

    expect(screen.getByTestId('ai-audit-timeline')).toBeInTheDocument();
    expect(screen.getByTestId('provision-approval-card')).toBeInTheDocument();
  });

  it('aprova o provisionamento ao clicar em Aprovar', () => {
    hookState.phase = 'provisioning';
    hookState.provisionProposal = provisionProposal;
    render(<AiSetupSection companyId={9} />);

    fireEvent.click(screen.getByTestId('provision-approve-button'));
    expect(approveProvision).toHaveBeenCalledTimes(1);
  });

  it('rejeita o provisionamento ao clicar em Rejeitar', () => {
    hookState.phase = 'provisioning';
    hookState.provisionProposal = provisionProposal;
    render(<AiSetupSection companyId={9} />);

    fireEvent.click(screen.getByTestId('provision-reject-button'));
    expect(rejectProvision).toHaveBeenCalledTimes(1);
  });

  it('não mostra o card de provisionamento fora da fase provisioning', () => {
    hookState.phase = 'schema';
    hookState.provisionProposal = provisionProposal;
    render(<AiSetupSection companyId={9} />);

    expect(
      screen.queryByTestId('provision-approval-card'),
    ).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/pages/AgentConnectorPanel/aiSetup/AiSetupSection.test.tsx`
Expected: FAIL — o `provision-approval-card` não é renderizado (`provisioning` não está em `RUNNING_PHASES` e o card não está no componente).

- [ ] **Step 3: Implementar no `AiSetupSection`**

Em `src/pages/AgentConnectorPanel/aiSetup/AiSetupSection.tsx`:

a) Inclua `'provisioning'` em `RUNNING_PHASES` (entre `'credentials'` e `'schema'`):

```tsx
const RUNNING_PHASES: AiSessionPhase[] = [
  'discovering',
  'credentials',
  'provisioning',
  'schema',
  'proposing',
  'applying',
];
```

b) Importe o novo componente, após o import de `MappingApprovalCard`:

```tsx
import { ProvisionApprovalCard } from './ProvisionApprovalCard';
```

c) Desestruture os novos valores do hook:

```tsx
  const {
    phase,
    events,
    proposal,
    provisionProposal,
    provisionResult,
    detail,
    starting,
    startSession,
    approve,
    reject,
    approveProvision,
    rejectProvision,
    abort,
  } = useAiSetupSession({ companyId });
```

d) Adicione os handlers (após `handleReject`):

```tsx
  const handleApproveProvision = useCallback(() => {
    approveProvision();
  }, [approveProvision]);

  const handleRejectProvision = useCallback(() => {
    rejectProvision();
  }, [rejectProvision]);
```

e) No bloco `{running ? (...)}`, passe `provisionResult` à timeline e renderize o card na fase `provisioning`. Substitua o conteúdo interno do fragment por:

```tsx
        <>
          <AiAuditTimeline
            events={events}
            phase={phase}
            provisionResult={provisionResult}
          />
          {phase === 'provisioning' && provisionProposal ? (
            <ProvisionApprovalCard
              proposal={provisionProposal}
              onApprove={handleApproveProvision}
              onReject={handleRejectProvision}
            />
          ) : null}
          {phase === 'proposing' && proposal ? (
            <MappingApprovalCard
              proposal={proposal}
              onApprove={handleApprove}
              onReject={handleReject}
            />
          ) : null}
          <ApprovalActions>
            <Button
              type="button"
              variant="secondary"
              onClick={handleAbort}
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
```

> O texto do botão de abortar permanece via i18n por ser pré-existente; apenas o card novo é pt-BR hard-coded. A prop `provisionResult` é adicionada à `AiAuditTimeline` na Task 6 — implemente-a lá; aqui o TS pode acusar prop desconhecida até a Task 6, então rode a Task 6 em seguida (ou faça as duas antes de rodar os testes do Section). Para manter cada task verde isoladamente, a Task 6 já estará no repo se executada em ordem; se executar fora de ordem, comece pela Task 6.

- [ ] **Step 4: Rodar e confirmar que passa**

> Pré-requisito: Task 6 implementada (prop `provisionResult` na timeline). Execute a Task 6 antes deste Step 4 se ainda não o fez.

Run: `npx vitest run src/pages/AgentConnectorPanel/aiSetup/AiSetupSection.test.tsx`
Expected: PASS (novos e antigos).

- [ ] **Step 5: Commit**

```bash
git add src/pages/AgentConnectorPanel/aiSetup/AiSetupSection.tsx src/pages/AgentConnectorPanel/aiSetup/AiSetupSection.test.tsx
git commit -m "feat(ai-setup): fase provisioning renderiza ProvisionApprovalCard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Linha de resultado de provisionamento na `AiAuditTimeline`

**Files:**
- Modify: `src/pages/AgentConnectorPanel/aiSetup/AiAuditTimeline.tsx`
- Test: `src/pages/AgentConnectorPanel/aiSetup/AiAuditTimeline.test.tsx`

> Execute esta task ANTES do Step 4 da Task 5 (ela introduz a prop `provisionResult` que o Section passa). É independente em código.

- [ ] **Step 1: Escrever os testes que falham**

Em `src/pages/AgentConnectorPanel/aiSetup/AiAuditTimeline.test.tsx`, estenda o import de tipos e adicione os testes. Ajuste o import:

```tsx
import type { AiAuditEvent, ProvisionResult } from './types';
```

Adicione (antes do `});` que fecha o `describe`):

```tsx
  it('mostra a linha de sucesso quando provisionResult é provisioned', () => {
    const provisionResult: ProvisionResult = {
      sessionId: 's1',
      outcome: 'provisioned',
      username: 'pharma_connector_ro',
    };
    render(
      <AiAuditTimeline
        events={events}
        phase="schema"
        provisionResult={provisionResult}
      />,
    );

    expect(screen.getByTestId('provision-result-line')).toHaveTextContent(
      'Usuário somente leitura pharma_connector_ro criado',
    );
  });

  it('mostra a linha de fallback quando outcome é fallback_no_privilege', () => {
    const provisionResult: ProvisionResult = {
      sessionId: 's1',
      outcome: 'fallback_no_privilege',
      username: 'pharma_connector_ro',
    };
    render(
      <AiAuditTimeline
        events={events}
        phase="schema"
        provisionResult={provisionResult}
      />,
    );

    expect(screen.getByTestId('provision-result-line')).toHaveTextContent(
      'Sem privilégio para criar o usuário read-only; seguindo com a credencial atual',
    );
  });

  it('mostra a linha de fallback quando outcome é unsupported_engine', () => {
    const provisionResult: ProvisionResult = {
      sessionId: 's1',
      outcome: 'unsupported_engine',
      username: 'pharma_connector_ro',
    };
    render(
      <AiAuditTimeline
        events={events}
        phase="schema"
        provisionResult={provisionResult}
      />,
    );

    expect(screen.getByTestId('provision-result-line')).toHaveTextContent(
      'Banco não suportado para usuário read-only; seguindo com a credencial atual',
    );
  });

  it('mostra a linha de erro quando outcome é error', () => {
    const provisionResult: ProvisionResult = {
      sessionId: 's1',
      outcome: 'error',
      username: 'pharma_connector_ro',
      errorCode: 'timeout',
    };
    render(
      <AiAuditTimeline
        events={events}
        phase="schema"
        provisionResult={provisionResult}
      />,
    );

    expect(screen.getByTestId('provision-result-line')).toHaveTextContent(
      'Falha ao criar o usuário read-only; seguindo com a credencial atual',
    );
  });

  it('não mostra a linha de resultado quando não há provisionResult', () => {
    render(<AiAuditTimeline events={events} phase="schema" />);
    expect(
      screen.queryByTestId('provision-result-line'),
    ).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx vitest run src/pages/AgentConnectorPanel/aiSetup/AiAuditTimeline.test.tsx`
Expected: FAIL — `provisionResult` não é prop do componente e `provision-result-line` não existe.

- [ ] **Step 3: Implementar na timeline**

Em `src/pages/AgentConnectorPanel/aiSetup/AiAuditTimeline.tsx`:

a) Estenda o import de tipos:

```tsx
import {
  type AiAuditEvent,
  type AiAuditEventKind,
  type AiSessionPhase,
  type ProvisionOutcome,
  type ProvisionResult,
} from './types';
```

b) Importe `StateBanner` dos estilos (acrescente à lista de imports de `./styles`):

```tsx
  StateBanner,
```

c) Estenda as `Props`:

```tsx
type Props = {
  events: AiAuditEvent[];
  phase: AiSessionPhase | null;
  provisionResult?: ProvisionResult | null;
};
```

d) Adicione um helper de texto pt-BR (após a função `toneForPhase`):

```tsx
function provisionResultText(result: ProvisionResult): string {
  const messages: Record<ProvisionOutcome, string> = {
    provisioned: `Usuário somente leitura ${result.username} criado; sync usará esta credencial`,
    fallback_no_privilege:
      'Sem privilégio para criar o usuário read-only; seguindo com a credencial atual',
    unsupported_engine:
      'Banco não suportado para usuário read-only; seguindo com a credencial atual',
    error:
      'Falha ao criar o usuário read-only; seguindo com a credencial atual',
  };
  return messages[result.outcome];
}

function provisionResultTone(
  outcome: ProvisionOutcome,
): 'success' | 'error' {
  return outcome === 'provisioned' ? 'success' : 'error';
}
```

e) Desestruture a prop na assinatura do componente:

```tsx
export function AiAuditTimeline({ events, phase, provisionResult }: Props) {
```

f) Renderize a linha antes do fechamento do `</div>` raiz (após o bloco `events.length === 0 ? ... : (...)`):

```tsx
      {provisionResult ? (
        <StateBanner
          $tone={provisionResultTone(provisionResult.outcome)}
          data-testid="provision-result-line"
        >
          {provisionResultText(provisionResult)}
        </StateBanner>
      ) : null}
```

> `StateBanner` é o token de banner já existente em `styles.ts` (`success`→`SUCCESS_GREEN`, `error`→`ERROR_RED`), com `CARD_RADIUS` e sem cantos vivos.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx vitest run src/pages/AgentConnectorPanel/aiSetup/AiAuditTimeline.test.tsx`
Expected: PASS (novos e antigos).

- [ ] **Step 5: Commit**

```bash
git add src/pages/AgentConnectorPanel/aiSetup/AiAuditTimeline.tsx src/pages/AgentConnectorPanel/aiSetup/AiAuditTimeline.test.tsx
git commit -m "feat(ai-setup): linha de resultado de provisionamento na timeline

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Verificação final dos arquivos afetados

**Files:** nenhum (apenas execução).

- [ ] **Step 1: Rodar todos os testes afetados, isoladamente**

> Rode cada arquivo separado — NÃO rode a suíte inteira (hang pré-existente em `ConfigurationModal.test.tsx`).

```bash
npx vitest run src/pages/AgentConnectorPanel/aiSetup/types.test.ts
npx vitest run src/pages/AgentConnectorPanel/aiSetup/hooks/useAiSetupSession.test.tsx
npx vitest run src/pages/AgentConnectorPanel/aiSetup/ProvisionApprovalCard.test.tsx
npx vitest run src/pages/AgentConnectorPanel/aiSetup/AiSetupSection.test.tsx
npx vitest run src/pages/AgentConnectorPanel/aiSetup/AiAuditTimeline.test.tsx
```

Expected: todos PASS.

- [ ] **Step 2: Confirmar ausência de i18n no código novo**

```bash
grep -rn "translation" src/pages/AgentConnectorPanel/aiSetup/ProvisionApprovalCard.tsx
```

Expected: nenhuma ocorrência (saída vazia). Se houver, remova e troque por texto pt-BR literal.

```bash
grep -rn "aiSetup" src/translation/languages
```

Expected: apenas chaves PRÉ-EXISTENTES — nenhuma chave nova de provisionamento deve ter sido adicionada.

---

## Self-Review

**1. Cobertura do escopo (Contrato B lado web):**
- (1) Tipos `provision.*` + chaves `AI_SETUP_SOCKET_EVENTS` → **Task 1**. ✔ Nomes verbatim: `provision.proposed`/`provision.result`/`provision.decision`.
- (2) Hook assina `provision.proposed`/`provision.result`, expõe `provisionProposal`/`provisionResult`, ações `approveProvision()`/`rejectProvision()` que emitem `provision.decision`; cleanup/off no unmount → **Task 2**. ✔
- (3) `ProvisionApprovalCard` (styled-components com tokens; pt-BR): username, engine, escopo "somente leitura, todas as tabelas", aviso, botões Aprovar/Rejeitar → **Tasks 3+4**. ✔
- (4) `AiSetupSection` estado `provisioning` renderiza timeline + card → **Task 5**. ✔
- (5) Linhas de resultado na timeline conforme `provision.result` (provisioned/fallback/erro), pt-BR → **Task 6**. ✔ Cobre os 4 outcomes (provisioned, fallback_no_privilege, unsupported_engine, error).
- Fase `provisioning` entre `credentials` e `schema` → **Task 1** (ordem do array verificada por teste).

**2. Placeholders:** nenhum "TBD/TODO". Todo passo de código mostra o código completo. Aviso e labels pt-BR escritos por extenso.

**3. Consistência de tipos/nomes:** `ProvisionProposal`/`ProvisionResult`/`ProvisionOutcome`/`ProvisionEngine`/`ProvisionDecision` (Task 1) são os mesmos usados nas Tasks 2/4/5/6. Ações `approveProvision`/`rejectProvision` idênticas em hook (Task 2), Section (Task 5) e mocks de teste. Evento `provision.decision` emitido com `{ sessionId, decision }` — bate com o contrato. Prop `provisionResult` da timeline definida na Task 6 e consumida na Task 5 (ordem de execução observada: Task 6 antes do Step 4 da Task 5).

**4. Design:** reusa tokens existentes (`CARD_RADIUS`, `SHADOW_MD`, `SUCCESS_GREEN`, `WARNING_AMBER`, `var(--color-primary-base)`, `SOFT_BORDER`, `StateBanner`, `ApprovalCard`); sem cantos vivos (todos os radius ≥ 12px/`CARD_RADIUS`); o `ProvisionWarning` usa âmbar de aviso a 10%/30%. Animações decorativas só nos componentes que já as protegem com `prefers-reduced-motion` (`TimelineItem`); o card novo não introduz animação nova.

**5. Sem i18n no código novo:** `ProvisionApprovalCard` e os textos de `provisionResultText` são pt-BR literais; Task 7 valida via `grep`. Botão de abortar pré-existente mantém i18n (não é texto novo).
