# Painel: `ProbeDiscoverySection` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar terceiro caminho de setup do conector (`probe_driven`) no painel React, com componente novo `ProbeDiscoverySection` que orquestra wizard de descoberta automática chamando os 3 endpoints Neo (`/discover`, `/scan-configs`, `/apply`).

**Architecture:** Componente novo em `src/pages/AgentConnectorPanel/`, ao lado de `ManualConnectionSection` e `FileDiscoverySection`. Estado interno via `useReducer` (~7 estados). 3 funções de service novas em `services.ts`. Novos tipos em `types.ts`. Radio button novo em `SetupMethodSection`. Sem mudanças em routing, state global ou backend.

**Tech Stack:** React, TypeScript, Vite, vitest, styled-components, Cypress.

**Repo:** `/home/cako/Documents/projetos/pharmachatbot/web-pharmachatbot`. Branch: novo `feat/probe-driven-setup-section`. Commit style: Conventional Commits em pt-br, uma linha, sem body, sem Co-Authored-By.

**Spec:** `pharma-agent-v2/docs/superpowers/specs/2026-05-28-painel-probe-driven-setup-design.md`.

**Depende de:** Endpoints Neo implementados (plano `2026-05-28-neo-probe-discovery-endpoints.md`). Pode ser desenvolvido em paralelo se o contrato HTTP estiver claro (mocks no Cypress + vitest).

---

## File Structure

**Novos arquivos:**
- `src/pages/AgentConnectorPanel/ProbeDiscoverySection.tsx` — componente principal
- `src/pages/AgentConnectorPanel/probeDiscoveryReducer.ts` — `useReducer` puro
- `src/pages/AgentConnectorPanel/probeDiscoveryReducer.test.ts`
- `src/pages/AgentConnectorPanel/ProbeDiscoverySection.test.tsx`
- `cypress/e2e/probe-discovery-setup.cy.ts`

**Modificados:**
- `src/pages/AgentConnectorPanel/types.ts` — novos tipos + estende `SETUP_METHOD_VALUES` com `'probe_driven'`
- `src/pages/AgentConnectorPanel/services.ts` — 3 funções novas
- `src/pages/AgentConnectorPanel/services.test.ts` — testes das 3 funções
- `src/pages/AgentConnectorPanel/SetupMethodSection.tsx` — radio novo + atualiza prop `onSelectMethod` para aceitar `'probe_driven'`
- `src/pages/AgentConnectorPanel/WorkspaceView.tsx` — renderiza `ProbeDiscoverySection` quando `setupMethod === 'probe_driven'`

---

## Task 1: Estender tipos em `types.ts`

**Files:**
- Modify: `src/pages/AgentConnectorPanel/types.ts`

- [ ] **Step 1.1: Estender `SETUP_METHOD_VALUES`**

Localizar a linha 5 (`SETUP_METHOD_VALUES`):

```ts
export const SETUP_METHOD_VALUES = [
  'unset',
  'manual',
  'file_discovery',
  'probe_driven',
] as const;
```

- [ ] **Step 1.2: Adicionar interfaces de probe discovery**

Ao final do arquivo, antes do `export interface ActivationResult` (ou no agrupamento de tipos relacionados):

```ts
export interface ProbeDiscoveryEngine {
  kind: string;
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];
}

export interface ProbeDiscoveryOdbcDsn {
  name: string;
  driver: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
}

export interface ProbeDiscoveryProcess {
  pid: number;
  name: string;
  path?: string;
}

export interface ProbeDiscoveryConnection {
  pid: number;
  processName?: string;
  localAddr: string;
  localPort: number;
  remoteAddr: string;
  remotePort: number;
  state: string;
}

export interface ProbeDiscoveryCandidate {
  driver: string;
  host: string;
  port: number;
  instance: string | null;
  database: string | null;
  user: string | null;
  password: string | null;
  trustServerCertificate: boolean;
}

export interface ProbeDiscoverResponse {
  engines: ProbeDiscoveryEngine[];
  odbcDsns: ProbeDiscoveryOdbcDsn[];
  processes: ProbeDiscoveryProcess[];
  connections: ProbeDiscoveryConnection[];
  candidate: ProbeDiscoveryCandidate;
}

export interface ProbeScanConfigsInput {
  roots: string[];
  patterns?: string[];
  maxDepth?: number;
  maxFiles?: number;
  maxAgeDays?: number;
}

export interface ProbeScannedFile {
  path: string;
  size: number;
  mtime: string;
}

export interface ProbeScanConfigsResponse {
  files: ProbeScannedFile[];
  truncated: boolean;
  rootsRejected: string[];
  errors: Array<{ path: string; reason: string }>;
}

export type ProbeApplyTestResult =
  | { ok: true; latencyMs: number }
  | { ok: false; code: string; message: string };

export interface ProbeApplyResponse {
  applied: boolean;
  testResult: ProbeApplyTestResult;
}
```

- [ ] **Step 1.3: Verificar TS build**

```bash
npx tsc --noEmit
```

Expected: zero erros novos (mas pode aparecer erro em `SetupMethodSection.tsx` por causa do union de `onSelectMethod` — corrige na Task 5).

- [ ] **Step 1.4: Commit**

```bash
git add src/pages/AgentConnectorPanel/types.ts
git commit -m "feat(painel): tipos para probe-driven setup (engines, dsns, candidate, etc)"
```

---

## Task 2: Reducer puro (`probeDiscoveryReducer.ts`)

**Files:**
- Create: `src/pages/AgentConnectorPanel/probeDiscoveryReducer.ts`
- Create: `src/pages/AgentConnectorPanel/probeDiscoveryReducer.test.ts`

- [ ] **Step 2.1: Escrever testes**

```ts
import { describe, expect, it } from 'vitest';

import {
  initialProbeDiscoveryState,
  probeDiscoveryReducer,
  type ProbeDiscoveryState,
} from './probeDiscoveryReducer';
import type { ProbeDiscoverResponse } from './types';

const sampleDiscover: ProbeDiscoverResponse = {
  engines: [{ kind: 'sqlserver', confidence: 'high', evidence: [] }],
  odbcDsns: [],
  processes: [],
  connections: [],
  candidate: {
    driver: 'sqlserver', host: '127.0.0.1', port: 1433, instance: null,
    database: null, user: null, password: null, trustServerCertificate: false,
  },
};

describe('probeDiscoveryReducer', () => {
  it('initial state is idle', () => {
    expect(initialProbeDiscoveryState.step).toBe('idle');
    expect(initialProbeDiscoveryState.results).toBeNull();
  });

  it('discover/start moves to discovering', () => {
    const next = probeDiscoveryReducer(initialProbeDiscoveryState, { type: 'discover/start' });
    expect(next.step).toBe('discovering');
    expect(next.lastError).toBeNull();
  });

  it('discover/success moves to review with results and candidate', () => {
    const after = probeDiscoveryReducer(
      { ...initialProbeDiscoveryState, step: 'discovering' },
      { type: 'discover/success', payload: sampleDiscover },
    );
    expect(after.step).toBe('review');
    expect(after.results).toEqual(sampleDiscover);
    expect(after.candidate.driver).toBe('sqlserver');
    expect(after.candidate.password).toBeNull();
  });

  it('discover/failure moves to failed_discovery and stores error', () => {
    const after = probeDiscoveryReducer(
      { ...initialProbeDiscoveryState, step: 'discovering' },
      { type: 'discover/failure', error: 'Conector offline' },
    );
    expect(after.step).toBe('failed_discovery');
    expect(after.lastError).toBe('Conector offline');
  });

  it('candidate/update merges field into candidate', () => {
    const base: ProbeDiscoveryState = {
      ...initialProbeDiscoveryState,
      step: 'review',
      results: sampleDiscover,
      candidate: { ...sampleDiscover.candidate },
    };
    const after = probeDiscoveryReducer(base, {
      type: 'candidate/update',
      field: 'password',
      value: 'secret',
    });
    expect(after.candidate.password).toBe('secret');
  });

  it('apply/start moves to applying', () => {
    const base: ProbeDiscoveryState = {
      ...initialProbeDiscoveryState,
      step: 'review',
      candidate: { ...sampleDiscover.candidate, database: 'BIG', user: 'sa', password: 'x' },
    };
    const after = probeDiscoveryReducer(base, { type: 'apply/start' });
    expect(after.step).toBe('applying');
    expect(after.lastError).toBeNull();
  });

  it('apply/success with applied=true moves to applied', () => {
    const base: ProbeDiscoveryState = { ...initialProbeDiscoveryState, step: 'applying' };
    const after = probeDiscoveryReducer(base, {
      type: 'apply/success',
      payload: { applied: true, testResult: { ok: true, latencyMs: 10 } },
    });
    expect(after.step).toBe('applied');
    expect(after.testResult).toEqual({ ok: true, latencyMs: 10 });
  });

  it('apply/success with applied=false moves to failed_apply', () => {
    const base: ProbeDiscoveryState = { ...initialProbeDiscoveryState, step: 'applying' };
    const after = probeDiscoveryReducer(base, {
      type: 'apply/success',
      payload: { applied: false, testResult: { ok: false, code: 'auth', message: 'Login failed' } },
    });
    expect(after.step).toBe('failed_apply');
    expect(after.testResult).toMatchObject({ ok: false, code: 'auth' });
  });

  it('apply/failure (network error) moves to failed_apply with message', () => {
    const after = probeDiscoveryReducer(
      { ...initialProbeDiscoveryState, step: 'applying' },
      { type: 'apply/failure', error: 'Tempo esgotado' },
    );
    expect(after.step).toBe('failed_apply');
    expect(after.lastError).toBe('Tempo esgotado');
  });

  it('back/to_review moves failed_apply back to review keeping candidate', () => {
    const base: ProbeDiscoveryState = {
      ...initialProbeDiscoveryState,
      step: 'failed_apply',
      candidate: { ...sampleDiscover.candidate, password: 'wrong' },
      testResult: { ok: false, code: 'auth', message: '...' },
    };
    const after = probeDiscoveryReducer(base, { type: 'back/to_review' });
    expect(after.step).toBe('review');
    expect(after.candidate.password).toBe('wrong');
  });

  it('back/to_idle resets state from any step', () => {
    const base: ProbeDiscoveryState = {
      ...initialProbeDiscoveryState,
      step: 'failed_discovery',
      lastError: 'erro',
    };
    const after = probeDiscoveryReducer(base, { type: 'back/to_idle' });
    expect(after).toEqual(initialProbeDiscoveryState);
  });

  it('scanConfigs/success stores result', () => {
    const base: ProbeDiscoveryState = { ...initialProbeDiscoveryState, step: 'review' };
    const after = probeDiscoveryReducer(base, {
      type: 'scanConfigs/success',
      payload: { files: [{ path: 'x', size: 1, mtime: 'm' }], truncated: false, rootsRejected: [], errors: [] },
    });
    expect(after.scanConfigs?.files).toHaveLength(1);
    expect(after.step).toBe('review');
  });
});
```

- [ ] **Step 2.2: Rodar — fail (Cannot find module)**

```bash
npx vitest run src/pages/AgentConnectorPanel/probeDiscoveryReducer.test.ts
```

- [ ] **Step 2.3: Implementar reducer**

```ts
import type {
  ProbeApplyResponse,
  ProbeApplyTestResult,
  ProbeDiscoverResponse,
  ProbeDiscoveryCandidate,
  ProbeScanConfigsResponse,
} from './types';

export type ProbeDiscoveryStep =
  | 'idle'
  | 'discovering'
  | 'review'
  | 'applying'
  | 'applied'
  | 'failed_discovery'
  | 'failed_apply';

export interface ProbeDiscoveryState {
  step: ProbeDiscoveryStep;
  results: ProbeDiscoverResponse | null;
  candidate: ProbeDiscoveryCandidate;
  scanConfigs: ProbeScanConfigsResponse | null;
  testResult: ProbeApplyTestResult | null;
  lastError: string | null;
}

export const initialProbeDiscoveryState: ProbeDiscoveryState = {
  step: 'idle',
  results: null,
  candidate: {
    driver: 'sqlserver',
    host: '',
    port: 1433,
    instance: null,
    database: null,
    user: null,
    password: null,
    trustServerCertificate: false,
  },
  scanConfigs: null,
  testResult: null,
  lastError: null,
};

export type ProbeDiscoveryAction =
  | { type: 'discover/start' }
  | { type: 'discover/success'; payload: ProbeDiscoverResponse }
  | { type: 'discover/failure'; error: string }
  | { type: 'candidate/update'; field: keyof ProbeDiscoveryCandidate; value: unknown }
  | { type: 'scanConfigs/start' }
  | { type: 'scanConfigs/success'; payload: ProbeScanConfigsResponse }
  | { type: 'scanConfigs/failure'; error: string }
  | { type: 'apply/start' }
  | { type: 'apply/success'; payload: ProbeApplyResponse }
  | { type: 'apply/failure'; error: string }
  | { type: 'back/to_review' }
  | { type: 'back/to_idle' };

export function probeDiscoveryReducer(
  state: ProbeDiscoveryState,
  action: ProbeDiscoveryAction,
): ProbeDiscoveryState {
  switch (action.type) {
    case 'discover/start':
      return { ...state, step: 'discovering', lastError: null };

    case 'discover/success':
      return {
        ...state,
        step: 'review',
        results: action.payload,
        candidate: { ...action.payload.candidate },
        lastError: null,
      };

    case 'discover/failure':
      return { ...state, step: 'failed_discovery', lastError: action.error };

    case 'candidate/update':
      return {
        ...state,
        candidate: { ...state.candidate, [action.field]: action.value },
      };

    case 'scanConfigs/start':
      return { ...state, lastError: null };

    case 'scanConfigs/success':
      return { ...state, scanConfigs: action.payload };

    case 'scanConfigs/failure':
      return { ...state, lastError: action.error };

    case 'apply/start':
      return { ...state, step: 'applying', lastError: null };

    case 'apply/success':
      return {
        ...state,
        step: action.payload.applied ? 'applied' : 'failed_apply',
        testResult: action.payload.testResult,
      };

    case 'apply/failure':
      return { ...state, step: 'failed_apply', lastError: action.error };

    case 'back/to_review':
      return { ...state, step: 'review' };

    case 'back/to_idle':
      return initialProbeDiscoveryState;

    default:
      return state;
  }
}
```

- [ ] **Step 2.4: Rodar — pass**

```bash
npx vitest run src/pages/AgentConnectorPanel/probeDiscoveryReducer.test.ts
```

Expected: 13 testes passando.

- [ ] **Step 2.5: Commit**

```bash
git add src/pages/AgentConnectorPanel/probeDiscoveryReducer.ts \
        src/pages/AgentConnectorPanel/probeDiscoveryReducer.test.ts
git commit -m "feat(painel): reducer puro para wizard de probe-driven setup"
```

---

## Task 3: 3 services em `services.ts`

**Files:**
- Modify: `src/pages/AgentConnectorPanel/services.ts`
- Modify: `src/pages/AgentConnectorPanel/services.test.ts`

- [ ] **Step 3.1: Adicionar testes**

Adicionar ao final de `services.test.ts`:

```ts
import {
  probeDiscoveryApply,
  probeDiscoveryDiscover,
  probeDiscoveryScanConfigs,
} from './services';

describe('probeDiscoveryDiscover', () => {
  it('POSTs to the discover endpoint and unwraps { data }', async () => {
    const mockApi = vi.fn(async () => ({
      data: {
        data: {
          engines: [{ kind: 'sqlserver', confidence: 'high', evidence: [] }],
          odbcDsns: [],
          processes: [],
          connections: [],
          candidate: {
            driver: 'sqlserver', host: 'h', port: 1433, instance: null,
            database: null, user: null, password: null, trustServerCertificate: false,
          },
        },
      },
    }));
    vi.spyOn(neoApi, 'post').mockImplementation(mockApi);
    const r = await probeDiscoveryDiscover(42);
    expect(mockApi).toHaveBeenCalledWith(
      '/pharma-agent-catalog/companies/42/setup/probe-discovery/discover',
      {},
    );
    expect(r.candidate.driver).toBe('sqlserver');
  });
});

describe('probeDiscoveryScanConfigs', () => {
  it('POSTs to scan-configs with body', async () => {
    const mockApi = vi.fn(async () => ({
      data: { data: { files: [], truncated: false, rootsRejected: [], errors: [] } },
    }));
    vi.spyOn(neoApi, 'post').mockImplementation(mockApi);
    await probeDiscoveryScanConfigs(42, { roots: ['C:\\App'] });
    expect(mockApi).toHaveBeenCalledWith(
      '/pharma-agent-catalog/companies/42/setup/probe-discovery/scan-configs',
      { roots: ['C:\\App'] },
    );
  });
});

describe('probeDiscoveryApply', () => {
  it('POSTs candidate and unwraps result', async () => {
    const mockApi = vi.fn(async () => ({
      data: { data: { applied: true, testResult: { ok: true, latencyMs: 10 } } },
    }));
    vi.spyOn(neoApi, 'post').mockImplementation(mockApi);
    const r = await probeDiscoveryApply(42, {
      driver: 'sqlserver', host: 'h', port: 1433, instance: null,
      database: 'd', user: 'u', password: 'p', trustServerCertificate: false,
    });
    expect(mockApi).toHaveBeenCalledWith(
      '/pharma-agent-catalog/companies/42/setup/probe-discovery/apply',
      expect.objectContaining({ driver: 'sqlserver', password: 'p' }),
    );
    expect(r.applied).toBe(true);
  });

  it('returns applied=false when testResult.ok=false', async () => {
    const mockApi = vi.fn(async () => ({
      data: { data: { applied: false, testResult: { ok: false, code: 'auth', message: 'Login failed' } } },
    }));
    vi.spyOn(neoApi, 'post').mockImplementation(mockApi);
    const r = await probeDiscoveryApply(42, {
      driver: 'sqlserver', host: 'h', port: 1433, instance: null,
      database: 'd', user: 'u', password: 'wrong', trustServerCertificate: false,
    });
    expect(r.applied).toBe(false);
    expect(r.testResult).toMatchObject({ ok: false, code: 'auth' });
  });
});
```

(`neoApi` já é importado no topo de `services.test.ts`. `vi.spyOn` segue padrão do arquivo atual.)

- [ ] **Step 3.2: Rodar — fail (export não existe)**

```bash
npx vitest run src/pages/AgentConnectorPanel/services.test.ts
```

- [ ] **Step 3.3: Implementar em `services.ts`**

Adicionar próximo aos outros endpoints de setup (depois de `manualValidateConnection` ou ao final do arquivo):

```ts
const probeDiscoveryBasePath = (companyId: number) =>
  `${pharmaCatalogCompanyPath(companyId)}/setup/probe-discovery`;

export async function probeDiscoveryDiscover(
  companyId: number,
): Promise<ProbeDiscoverResponse> {
  const response = await neoApi.post<NeoEnvelope<ProbeDiscoverResponse>>(
    `${probeDiscoveryBasePath(companyId)}/discover`,
    {},
  );
  return response.data.data;
}

export async function probeDiscoveryScanConfigs(
  companyId: number,
  input: ProbeScanConfigsInput,
): Promise<ProbeScanConfigsResponse> {
  const response = await neoApi.post<NeoEnvelope<ProbeScanConfigsResponse>>(
    `${probeDiscoveryBasePath(companyId)}/scan-configs`,
    input,
  );
  return response.data.data;
}

export async function probeDiscoveryApply(
  companyId: number,
  candidate: ProbeDiscoveryCandidate,
): Promise<ProbeApplyResponse> {
  const response = await neoApi.post<NeoEnvelope<ProbeApplyResponse>>(
    `${probeDiscoveryBasePath(companyId)}/apply`,
    candidate,
  );
  return response.data.data;
}
```

Adicionar imports no topo de `services.ts`:

```ts
import type {
  ProbeApplyResponse,
  ProbeDiscoverResponse,
  ProbeDiscoveryCandidate,
  ProbeScanConfigsInput,
  ProbeScanConfigsResponse,
} from './types';
```

- [ ] **Step 3.4: Rodar — pass**

```bash
npx vitest run src/pages/AgentConnectorPanel/services.test.ts
```

- [ ] **Step 3.5: Commit**

```bash
git add src/pages/AgentConnectorPanel/services.ts \
        src/pages/AgentConnectorPanel/services.test.ts
git commit -m "feat(painel): services probeDiscoveryDiscover/ScanConfigs/Apply"
```

---

## Task 4: `ProbeDiscoverySection` componente

**Files:**
- Create: `src/pages/AgentConnectorPanel/ProbeDiscoverySection.tsx`
- Create: `src/pages/AgentConnectorPanel/ProbeDiscoverySection.test.tsx`

- [ ] **Step 4.1: Inspecionar padrão visual existente**

```bash
head -120 src/pages/AgentConnectorPanel/ManualConnectionSection.tsx
```

Anotar: estrutura JSX, uso de `styled-components` (provavelmente em `./styles.ts`), props pattern (`status: AgentConnectorStatus`).

- [ ] **Step 4.2: Escrever testes do componente**

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProbeDiscoverySection } from './ProbeDiscoverySection';
import * as services from './services';

const baseStatus = {
  companyId: 42,
  connectorId: 'conn-1',
  online: true,
  lastHeartbeat: new Date().toISOString(),
  lastError: '',
  lastSync: null,
  totalProducts: 0,
  readinessState: 'pending',
  setupMethod: 'probe_driven' as const,
  fileDiscoveryScanState: 'idle' as const,
  manualValidationResultCode: 'unset' as const,
  manualValidated: false,
  selectedFileCandidateId: '',
  fileDiscoveryCandidates: [],
  catalogActivationBlocked: false,
  schemaDiscoveryStale: false,
  mappingStale: false,
  mappingConfirmed: false,
  searchStartAllowed: false,
};

describe('ProbeDiscoverySection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('renders idle state with disabled button when connector offline', () => {
    render(<ProbeDiscoverySection status={{ ...baseStatus, online: false }} onApplied={vi.fn()} />);
    expect(screen.getByRole('button', { name: /iniciar descoberta/i })).toBeDisabled();
  });

  it('clicking "Iniciar descoberta" calls discover and renders review on success', async () => {
    vi.spyOn(services, 'probeDiscoveryDiscover').mockResolvedValueOnce({
      engines: [{ kind: 'sqlserver', confidence: 'high', evidence: ['service:MSSQLSERVER'] }],
      odbcDsns: [],
      processes: [{ pid: 4128, name: 'Big.exe', path: 'C:\\Linx\\bin\\Big.exe' }],
      connections: [{ pid: 4128, processName: 'Big.exe', localAddr: '127.0.0.1', localPort: 49802,
        remoteAddr: '127.0.0.1', remotePort: 1433, state: 'ESTABLISHED' }],
      candidate: { driver: 'sqlserver', host: '127.0.0.1', port: 1433, instance: null,
        database: null, user: null, password: null, trustServerCertificate: false },
    });
    render(<ProbeDiscoverySection status={baseStatus} onApplied={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /iniciar descoberta/i }));
    await waitFor(() => screen.getByText(/Banco detectado/i));
    expect(screen.getByText(/SQL Server/i)).toBeInTheDocument();
    expect(screen.getByText(/Big\.exe/)).toBeInTheDocument();
  });

  it('shows error state when discover fails', async () => {
    vi.spyOn(services, 'probeDiscoveryDiscover').mockRejectedValueOnce(new Error('Conector offline'));
    render(<ProbeDiscoverySection status={baseStatus} onApplied={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /iniciar descoberta/i }));
    await waitFor(() => screen.getByText(/Conector offline/i));
  });

  it('apply success calls onApplied callback', async () => {
    vi.spyOn(services, 'probeDiscoveryDiscover').mockResolvedValueOnce({
      engines: [{ kind: 'sqlserver', confidence: 'high', evidence: [] }],
      odbcDsns: [], processes: [], connections: [],
      candidate: { driver: 'sqlserver', host: '127.0.0.1', port: 1433, instance: null,
        database: null, user: null, password: null, trustServerCertificate: false },
    });
    vi.spyOn(services, 'probeDiscoveryApply').mockResolvedValueOnce({
      applied: true, testResult: { ok: true, latencyMs: 12 },
    });
    const onApplied = vi.fn();
    render(<ProbeDiscoverySection status={baseStatus} onApplied={onApplied} />);
    fireEvent.click(screen.getByRole('button', { name: /iniciar descoberta/i }));
    await waitFor(() => screen.getByLabelText(/database/i));

    fireEvent.change(screen.getByLabelText(/database/i), { target: { value: 'BIG' } });
    fireEvent.change(screen.getByLabelText(/usu/i), { target: { value: 'sa' } });
    fireEvent.change(screen.getByLabelText(/senha/i), { target: { value: 'secret' } });

    const applyButton = screen.getByRole('button', { name: /testar e aplicar/i });
    fireEvent.click(applyButton);
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(true));
  });

  it('apply failure shows error and allows retry', async () => {
    vi.spyOn(services, 'probeDiscoveryDiscover').mockResolvedValueOnce({
      engines: [{ kind: 'sqlserver', confidence: 'high', evidence: [] }],
      odbcDsns: [], processes: [], connections: [],
      candidate: { driver: 'sqlserver', host: '127.0.0.1', port: 1433, instance: null,
        database: null, user: null, password: null, trustServerCertificate: false },
    });
    vi.spyOn(services, 'probeDiscoveryApply').mockResolvedValueOnce({
      applied: false, testResult: { ok: false, code: 'auth', message: 'Login failed' },
    });
    render(<ProbeDiscoverySection status={baseStatus} onApplied={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /iniciar descoberta/i }));
    await waitFor(() => screen.getByLabelText(/database/i));
    fireEvent.change(screen.getByLabelText(/database/i), { target: { value: 'BIG' } });
    fireEvent.change(screen.getByLabelText(/usu/i), { target: { value: 'sa' } });
    fireEvent.change(screen.getByLabelText(/senha/i), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: /testar e aplicar/i }));
    await waitFor(() => screen.getByText(/Login failed/i));
    expect(screen.getByRole('button', { name: /voltar e ajustar/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 4.3: Implementar componente**

```tsx
import { useReducer } from 'react';

import {
  initialProbeDiscoveryState,
  probeDiscoveryReducer,
  type ProbeDiscoveryStep,
} from './probeDiscoveryReducer';
import {
  probeDiscoveryApply,
  probeDiscoveryDiscover,
} from './services';
import type { AgentConnectorStatus, ProbeDiscoveryCandidate } from './types';

interface Props {
  status: AgentConnectorStatus;
  onApplied: (success: boolean) => void;
}

export function ProbeDiscoverySection({ status, onApplied }: Props): JSX.Element {
  const [state, dispatch] = useReducer(probeDiscoveryReducer, initialProbeDiscoveryState);

  async function handleDiscover() {
    dispatch({ type: 'discover/start' });
    try {
      const result = await probeDiscoveryDiscover(status.companyId);
      dispatch({ type: 'discover/success', payload: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro desconhecido';
      dispatch({ type: 'discover/failure', error: humanizeDiscoverError(message) });
    }
  }

  async function handleApply() {
    dispatch({ type: 'apply/start' });
    try {
      const result = await probeDiscoveryApply(status.companyId, state.candidate);
      dispatch({ type: 'apply/success', payload: result });
      if (result.applied) {
        setTimeout(() => onApplied(true), 1500);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro desconhecido';
      dispatch({ type: 'apply/failure', error: message });
    }
  }

  function updateCandidateField<K extends keyof ProbeDiscoveryCandidate>(
    field: K,
    value: ProbeDiscoveryCandidate[K],
  ) {
    dispatch({ type: 'candidate/update', field, value });
  }

  return (
    <section data-testid="probe-discovery-section">
      {state.step === 'idle' && (
        <IdleView status={status} onStart={handleDiscover} />
      )}
      {state.step === 'discovering' && <DiscoveringView />}
      {state.step === 'review' && (
        <ReviewView
          state={state}
          updateField={updateCandidateField}
          onApply={handleApply}
          onCancel={() => dispatch({ type: 'back/to_idle' })}
        />
      )}
      {state.step === 'applying' && <ApplyingView />}
      {state.step === 'applied' && <AppliedView />}
      {state.step === 'failed_discovery' && (
        <FailedDiscoveryView
          error={state.lastError ?? 'Erro desconhecido'}
          onRetry={() => dispatch({ type: 'back/to_idle' })}
        />
      )}
      {state.step === 'failed_apply' && (
        <FailedApplyView
          state={state}
          onBack={() => dispatch({ type: 'back/to_review' })}
          onRetry={handleApply}
        />
      )}
    </section>
  );
}

interface IdleViewProps { status: AgentConnectorStatus; onStart: () => void; }
function IdleView({ status, onStart }: IdleViewProps): JSX.Element {
  const disabled = !status.online;
  return (
    <div>
      <h3>Descoberta automática</h3>
      <p>
        Identificaremos qual sistema (ERP, PDV) está rodando na máquina do
        cliente e em qual banco ele se conecta.
      </p>
      <button
        type="button"
        onClick={onStart}
        disabled={disabled}
        title={disabled ? 'O conector está offline. Peça ao TI ligar a máquina.' : undefined}
      >
        Iniciar descoberta
      </button>
    </div>
  );
}

function DiscoveringView(): JSX.Element {
  return (
    <div role="status" aria-live="polite">
      <h3>🔍 Sondando a máquina do cliente...</h3>
      <p>Isso leva cerca de 15 segundos.</p>
    </div>
  );
}

interface ReviewViewProps {
  state: ReturnType<typeof probeDiscoveryReducer>;
  updateField: <K extends keyof ProbeDiscoveryCandidate>(
    field: K,
    value: ProbeDiscoveryCandidate[K],
  ) => void;
  onApply: () => void;
  onCancel: () => void;
}
function ReviewView({ state, updateField, onApply, onCancel }: ReviewViewProps): JSX.Element {
  const { results, candidate } = state;
  const canApply = !!candidate.database && !!candidate.user && !!candidate.password;

  return (
    <div>
      <h3>✓ Encontramos:</h3>
      {results?.engines.map((e) => (
        <div key={e.kind}>
          <strong>Banco detectado: {labelForEngine(e.kind)} ({e.confidence} confiança)</strong>
          <p>{e.evidence.join(' · ')}</p>
        </div>
      ))}
      {results?.processes.length ? (
        <div>
          <strong>ERP em execução:</strong>
          <ul>
            {results.processes.slice(0, 3).map((p) => (
              <li key={p.pid}>
                {p.name} (PID {p.pid}){p.path ? ` — ${p.path}` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {results?.connections.length ? (
        <div>
          <strong>Conexões:</strong>
          <ul>
            {results.connections.slice(0, 3).map((c, i) => (
              <li key={i}>
                {c.processName ?? `PID ${c.pid}`} → {c.remoteAddr}:{c.remotePort}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <hr />
      <h4>Complete os dados de conexão:</h4>
      <label>
        Driver
        <select
          value={candidate.driver}
          onChange={(e) => updateField('driver', e.target.value)}
        >
          <option value="sqlserver">SQL Server</option>
          <option value="postgresql">PostgreSQL</option>
          <option value="mysql">MySQL</option>
          <option value="mariadb">MariaDB</option>
          <option value="firebird">Firebird</option>
        </select>
      </label>
      <label>
        Host
        <input
          type="text"
          value={candidate.host}
          onChange={(e) => updateField('host', e.target.value)}
        />
      </label>
      <label>
        Porta
        <input
          type="number"
          value={candidate.port}
          onChange={(e) => updateField('port', Number.parseInt(e.target.value, 10) || 0)}
        />
      </label>
      <label>
        Database
        <input
          type="text"
          value={candidate.database ?? ''}
          onChange={(e) => updateField('database', e.target.value || null)}
        />
      </label>
      <label>
        Usuário
        <input
          type="text"
          value={candidate.user ?? ''}
          onChange={(e) => updateField('user', e.target.value || null)}
        />
      </label>
      <label>
        Senha
        <input
          type="password"
          value={candidate.password ?? ''}
          onChange={(e) => updateField('password', e.target.value || null)}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={candidate.trustServerCertificate}
          onChange={(e) => updateField('trustServerCertificate', e.target.checked)}
        />
        Confiar no certificado do servidor
      </label>

      <hr />
      <button type="button" onClick={onCancel}>Cancelar</button>
      <button
        type="button"
        onClick={onApply}
        disabled={!canApply}
      >
        Testar e aplicar
      </button>
    </div>
  );
}

function ApplyingView(): JSX.Element {
  return <div role="status">Testando conexão e aplicando configuração...</div>;
}

function AppliedView(): JSX.Element {
  return (
    <div role="status">
      ✓ Configuração aplicada com sucesso! Redirecionando para o mapeamento...
    </div>
  );
}

function FailedDiscoveryView({ error, onRetry }: { error: string; onRetry: () => void }): JSX.Element {
  return (
    <div role="alert">
      <h3>✗ Não foi possível descobrir</h3>
      <p>{error}</p>
      <button type="button" onClick={onRetry}>Voltar</button>
    </div>
  );
}

interface FailedApplyViewProps {
  state: ReturnType<typeof probeDiscoveryReducer>;
  onBack: () => void;
  onRetry: () => void;
}
function FailedApplyView({ state, onBack, onRetry }: FailedApplyViewProps): JSX.Element {
  const message =
    state.testResult && !state.testResult.ok
      ? `${state.testResult.code}: ${state.testResult.message}`
      : state.lastError ?? 'Erro desconhecido';
  return (
    <div role="alert">
      <h3>✗ Não conseguimos aplicar</h3>
      <p>{message}</p>
      <button type="button" onClick={onBack}>Voltar e ajustar</button>
      <button type="button" onClick={onRetry}>Tentar novamente</button>
    </div>
  );
}

function labelForEngine(kind: string): string {
  switch (kind) {
    case 'sqlserver': return 'SQL Server';
    case 'postgresql': return 'PostgreSQL';
    case 'mysql': return 'MySQL';
    case 'mariadb': return 'MariaDB';
    case 'firebird': return 'Firebird';
    default: return kind;
  }
}

function humanizeDiscoverError(message: string): string {
  if (/offline/i.test(message)) return 'O conector está offline. Peça ao TI ligar a máquina.';
  if (/timed out|timeout/i.test(message)) return 'O agente demorou para responder. Tente novamente.';
  return message;
}
```

- [ ] **Step 4.4: Rodar testes**

```bash
npx vitest run src/pages/AgentConnectorPanel/ProbeDiscoverySection.test.tsx
```

Expected: 5 testes passando.

- [ ] **Step 4.5: Commit**

```bash
git add src/pages/AgentConnectorPanel/ProbeDiscoverySection.tsx \
        src/pages/AgentConnectorPanel/ProbeDiscoverySection.test.tsx
git commit -m "feat(painel): componente ProbeDiscoverySection com wizard de 7 estados"
```

---

## Task 5: Atualizar `SetupMethodSection` com radio novo

**Files:**
- Modify: `src/pages/AgentConnectorPanel/SetupMethodSection.tsx`

- [ ] **Step 5.1: Ampliar prop `onSelectMethod`**

Localizar linha 57 (`onSelectMethod: (method: 'manual' | 'file_discovery') => void;`). Substituir por:

```ts
  onSelectMethod: (method: 'manual' | 'file_discovery' | 'probe_driven') => void;
```

E localizar linha 67-68 (a ternária de coerção):

```ts
    setupMethodServer === 'manual' ||
    setupMethodServer === 'file_discovery' ||
    setupMethodServer === 'probe_driven'
      ? setupMethodServer
```

- [ ] **Step 5.2: Adicionar terceiro `MethodCard`**

Localizar o `MethodCardGrid` que renderiza os dois cards atuais (provavelmente próximo à linha 118 com `data-testid="setup-method-manual"`). Adicionar um terceiro card antes ou depois dos existentes:

```tsx
<MethodCard
  data-testid="setup-method-probe-driven"
  selected={selectedMethod === 'probe_driven'}
  onClick={() => onSelectMethod('probe_driven')}
>
  <MethodCardRadio
    type="radio"
    checked={selectedMethod === 'probe_driven'}
    onChange={() => onSelectMethod('probe_driven')}
    aria-label="Descoberta automática"
  />
  <MethodCardIcon>
    {/* reusar um ícone existente como IconDatabase ou criar SVG simples */}
    <IconDatabase />
  </MethodCardIcon>
  <MethodCardTitle>Descoberta automática</MethodCardTitle>
  <MethodCardBadge>Recomendado</MethodCardBadge>
  <MethodCardDescription>
    Identificamos o sistema e o banco do cliente automaticamente, sem precisar
    de técnico na máquina.
  </MethodCardDescription>
</MethodCard>
```

- [ ] **Step 5.3: Verificar TS build**

```bash
npx tsc --noEmit
```

Expected: zero erros novos.

- [ ] **Step 5.4: Rodar testes do componente (se existir snapshot/test)**

```bash
ls src/pages/AgentConnectorPanel/ | grep SetupMethod
```

Se houver `SetupMethodSection.test.tsx`, rodar e ajustar snapshots/asserts caso seja necessário.

- [ ] **Step 5.5: Commit**

```bash
git add src/pages/AgentConnectorPanel/SetupMethodSection.tsx
git commit -m "feat(painel): SetupMethodSection aceita probe_driven como terceiro metodo"
```

---

## Task 6: Renderizar `ProbeDiscoverySection` em `WorkspaceView`

**Files:**
- Modify: `src/pages/AgentConnectorPanel/WorkspaceView.tsx`

- [ ] **Step 6.1: Adicionar import e bloco condicional**

Localizar onde `ManualConnectionSection` e `FileDiscoverySection` são renderizados condicionalmente. Adicionar:

```tsx
import { ProbeDiscoverySection } from './ProbeDiscoverySection';

// ...dentro do JSX, próximo aos blocos existentes:

{status.setupMethod === 'probe_driven' && (
  <ProbeDiscoverySection
    status={status}
    onApplied={(success) => {
      if (success) {
        // padrão atual provavelmente refetcha readiness e/ou navega
        // procurar como ManualConnectionSection trata sucesso e replicar
        readinessRefetch.refresh();
      }
    }}
  />
)}
```

(O padrão exato de "após aplicar, atualiza readiness" depende do hook existente — procurar `readinessRefetch` ou `refresh` no arquivo atual.)

- [ ] **Step 6.2: Verificar build TS**

```bash
npx tsc --noEmit
```

- [ ] **Step 6.3: Rodar suite**

```bash
npx vitest run src/pages/AgentConnectorPanel
```

- [ ] **Step 6.4: Commit**

```bash
git add src/pages/AgentConnectorPanel/WorkspaceView.tsx
git commit -m "feat(painel): WorkspaceView renderiza ProbeDiscoverySection quando probe_driven"
```

---

## Task 7: Cypress E2E happy path

**Files:**
- Create: `cypress/e2e/probe-discovery-setup.cy.ts`

- [ ] **Step 7.1: Inspecionar padrão de E2E existente**

```bash
ls cypress/e2e/ | head -10
grep -l "AgentConnectorPanel\|agent-connectors\|setup-method" cypress/e2e/*.cy.ts
```

Anotar como os outros testes de connector setup fazem login, navegação até a tela, e mock de endpoints Neo (`cy.intercept`).

- [ ] **Step 7.2: Escrever cenário happy path**

```ts
describe('Probe-driven setup', () => {
  beforeEach(() => {
    // Reusar pattern de login existente — procurar em outros .cy.ts
    cy.loginAsSuperAdmin(); // helper típico — verificar nome real
    cy.visit('/agent-connectors/42'); // companyId fictício de seed
  });

  it('completes happy path: discover → fill credentials → apply → redirect to mapping', () => {
    cy.intercept(
      'POST',
      '/pharma-agent-catalog/companies/42/setup/probe-discovery/discover',
      {
        statusCode: 200,
        body: {
          data: {
            engines: [{ kind: 'sqlserver', confidence: 'high', evidence: ['service:MSSQLSERVER', 'port:1433'] }],
            odbcDsns: [],
            processes: [{ pid: 4128, name: 'Big.exe', path: 'C:\\Linx\\bin\\Big.exe' }],
            connections: [
              { pid: 4128, processName: 'Big.exe', localAddr: '127.0.0.1', localPort: 49802,
                remoteAddr: '127.0.0.1', remotePort: 1433, state: 'ESTABLISHED' },
            ],
            candidate: {
              driver: 'sqlserver', host: '127.0.0.1', port: 1433, instance: null,
              database: null, user: null, password: null, trustServerCertificate: false,
            },
          },
        },
      },
    ).as('discover');

    cy.intercept(
      'POST',
      '/pharma-agent-catalog/companies/42/setup/probe-discovery/apply',
      {
        statusCode: 200,
        body: {
          data: { applied: true, testResult: { ok: true, latencyMs: 12 } },
        },
      },
    ).as('apply');

    // Escolher método de setup probe-driven
    cy.get('[data-testid="setup-method-probe-driven"]').click();

    // Botão "Iniciar descoberta"
    cy.contains('button', /iniciar descoberta/i).click();
    cy.wait('@discover');

    // Tela de review
    cy.contains(/Banco detectado/i).should('exist');
    cy.contains(/SQL Server/i).should('exist');
    cy.contains(/Big\.exe/).should('exist');

    // Preencher form
    cy.get('input[type="text"]').filter('[aria-label*="database" i], [name="database"]').first().clear().type('BIG');
    cy.get('input[type="text"]').filter('[aria-label*="usu" i], [name="user"]').first().clear().type('sa');
    cy.get('input[type="password"]').type('secret123');

    // Aplicar
    cy.contains('button', /testar e aplicar/i).click();
    cy.wait('@apply');

    // Tela de sucesso
    cy.contains(/aplicada com sucesso/i).should('exist');
  });

  it('shows error when apply returns auth failure', () => {
    cy.intercept('POST', '**/probe-discovery/discover', {
      statusCode: 200,
      body: { data: {
        engines: [{ kind: 'sqlserver', confidence: 'high', evidence: [] }],
        odbcDsns: [], processes: [], connections: [],
        candidate: { driver: 'sqlserver', host: '127.0.0.1', port: 1433, instance: null,
          database: null, user: null, password: null, trustServerCertificate: false },
      } },
    });
    cy.intercept('POST', '**/probe-discovery/apply', {
      statusCode: 200,
      body: { data: { applied: false, testResult: { ok: false, code: 'auth', message: 'Login failed' } } },
    });
    cy.get('[data-testid="setup-method-probe-driven"]').click();
    cy.contains('button', /iniciar descoberta/i).click();
    cy.get('input[type="text"]').filter('[name="database"]').first().clear().type('BIG');
    cy.get('input[type="text"]').filter('[name="user"]').first().clear().type('sa');
    cy.get('input[type="password"]').type('wrong');
    cy.contains('button', /testar e aplicar/i).click();
    cy.contains(/Login failed/i).should('exist');
    cy.contains('button', /voltar e ajustar/i).should('exist');
  });
});
```

(Os seletores `aria-label*="..."` / `name="..."` dependem dos atributos finais do componente — confirmar com o componente real e ajustar.)

- [ ] **Step 7.3: Rodar Cypress local**

```bash
pnpm cy:local:open
# selecionar probe-discovery-setup.cy.ts e rodar
```

Expected: ambos os cenários passam.

- [ ] **Step 7.4: Commit**

```bash
git add cypress/e2e/probe-discovery-setup.cy.ts
git commit -m "test(painel): E2E probe-driven setup happy path e auth failure"
```

---

## Task 8: PR e checklist

- [ ] **Step 8.1: Suite completa**

```bash
pnpm test
```

- [ ] **Step 8.2: Build de produção**

```bash
pnpm build
```

- [ ] **Step 8.3: Lint**

```bash
pnpm check
```

- [ ] **Step 8.4: Git log**

```bash
git log --oneline -10
```

Expected: 6 commits criados nas tasks anteriores.

- [ ] **Step 8.5: Abrir PR**

```bash
gh pr create --title "feat(painel): probe-driven setup (descoberta automatica)" \
  --body "Implementa Tasks 1-7 do plano em pharma-agent-v2/docs/superpowers/plans/2026-05-28-painel-probe-discovery-section.md. Spec em pharma-agent-v2/docs/superpowers/specs/2026-05-28-painel-probe-driven-setup-design.md. Depende dos endpoints Neo do PR correspondente em neo-api-pharmachatbot."
```
