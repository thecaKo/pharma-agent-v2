# LLM Provider multi-provider (DeepSeek default + Claude) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar o LLM do orquestrador de setup plugável por provider, com DeepSeek (API direta, OpenAI-compatible) como default e Claude (Anthropic) opt-in, via uma interface neutra de LLM.

**Architecture:** Extrai uma interface neutra `LlmClient` (tipos agnósticos de tool/mensagem/turno). O loop agentic passa a falar tipos neutros; dois clients (`DeepSeekLlmClient` via SDK `openai`, `AnthropicLlmClient` via `@anthropic-ai/sdk`) traduzem neutro↔formato do provider. Uma factory de DI escolhe o client e o modelo por env. `emit_mapping` passa a ser validado (falha sem retry).

**Tech Stack:** NestJS, TypeScript, vitest, `openai`, `@anthropic-ai/sdk`. Gerenciador **pnpm**. Escopo: só `src/modules/ai-setup/`. Spec: `pharma-agent-v2/docs/superpowers/specs/2026-06-03-llm-provider-deepseek-claude-design.md`.

---

## File Structure

| Arquivo | Ação | Responsabilidade |
|---|---|---|
| `src/modules/ai-setup/interfaces/llm-client.interface.ts` | Create | tipos neutros (`LlmToolDef`/`LlmToolCall`/`LlmMessage`/`LlmTurn`/`LlmClient`) + tokens DI `LLM_CLIENT`/`LLM_MODEL`/`LLM_MAX_TOKENS` |
| `src/modules/ai-setup/services/deepseek-llm.client.ts` | Create | `DeepSeekLlmClient` — SDK `openai` (baseURL DeepSeek); traduz neutro↔OpenAI |
| `src/modules/ai-setup/services/anthropic-llm.client.ts` | Create | `AnthropicLlmClient` — `@anthropic-ai/sdk`; traduz neutro↔Anthropic + cache_control |
| `src/modules/ai-setup/services/llm-client.factory.ts` | Create | `resolveLlmProvider`/`createLlmClient`/`resolveLlmModel` + fail-fast |
| `src/modules/ai-setup/services/validate-catalog-mapping.ts` | Create | valida estruturalmente o `IConnectorCatalogMappingConfig` do `emit_mapping` |
| `src/modules/ai-setup/services/catalog-to-tools.translator.ts` | Modify | passa a retornar `LlmToolDef[]` |
| `src/modules/ai-setup/services/ai-setup-orchestrator.service.ts` | Modify | loop em tipos neutros + validação do `emit_mapping` + fim-sem-mapping → falha |
| `src/modules/ai-setup/constants/ai-setup-orchestrator.constants.ts` | Modify | envs/defaults de provider e modelo (DeepSeek + Anthropic) |
| `src/modules/ai-setup/ai-setup.module.ts` | Modify | provê `LLM_CLIENT`/`LLM_MODEL`/`LLM_MAX_TOKENS` via factory |
| `src/modules/ai-setup/services/anthropic-messages.client.ts` | Delete | substituído por `anthropic-llm.client.ts` |
| `src/modules/ai-setup/services/anthropic-messages.client.test.ts` | Delete | substituído pelo teste do novo client |
| `src/modules/ai-setup/README.md` | Modify | documenta providers/envs |
| `.env.example` | Modify | documenta `AI_SETUP_LLM_PROVIDER`/`DEEPSEEK_*`/`ANTHROPIC_*` |

Comandos de teste: `pnpm run vitest:unit <arquivo>` (unit), `pnpm run vitest:integration <arquivo>` (int), `pnpm run quality-gate:fast` (gate de pré-push).

---

## Task 1: Dependência `openai` + interface neutra

**Files:**
- Modify: `package.json` (+ `openai`)
- Create: `src/modules/ai-setup/interfaces/llm-client.interface.ts`
- Test: `src/modules/ai-setup/interfaces/llm-client.interface.test.ts`

- [ ] **Step 1: Instalar `openai`**

```bash
pnpm add openai
```

- [ ] **Step 2: Escrever o teste que falha**

```ts
// src/modules/ai-setup/interfaces/llm-client.interface.test.ts
import { describe, expect, it } from 'vitest';
import { LLM_CLIENT, LLM_MODEL, LLM_MAX_TOKENS } from './llm-client.interface';

describe('Teste Unitário: llm-client-interface', () => {
  it('exporta tokens DI distintos como symbols', () => {
    expect(typeof LLM_CLIENT).toBe('symbol');
    expect(typeof LLM_MODEL).toBe('symbol');
    expect(typeof LLM_MAX_TOKENS).toBe('symbol');
    expect(new Set([LLM_CLIENT, LLM_MODEL, LLM_MAX_TOKENS]).size).toBe(3);
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm run vitest:unit src/modules/ai-setup/interfaces/llm-client.interface.test.ts`
Expected: FAIL — `Cannot find module './llm-client.interface'`.

- [ ] **Step 4: Implementar a interface**

```ts
// src/modules/ai-setup/interfaces/llm-client.interface.ts
export const LLM_CLIENT = Symbol('LLM_CLIENT');
export const LLM_MODEL = Symbol('LLM_MODEL');
export const LLM_MAX_TOKENS = Symbol('LLM_MAX_TOKENS');

export interface LlmToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface LlmTurn {
  text: string | null;
  toolCalls: LlmToolCall[];
  stop: 'tool_calls' | 'end';
}

export interface LlmCreateTurnParams {
  system: string;
  tools: LlmToolDef[];
  messages: LlmMessage[];
  maxTokens: number;
}

export interface LlmClient {
  createTurn(params: LlmCreateTurnParams): Promise<LlmTurn>;
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `pnpm run vitest:unit src/modules/ai-setup/interfaces/llm-client.interface.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/modules/ai-setup/interfaces/llm-client.interface.ts src/modules/ai-setup/interfaces/llm-client.interface.test.ts
git commit -m "feat(ai-setup): adiciona openai e interface neutra de LLM

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Constants de provider/modelo

**Files:**
- Modify: `src/modules/ai-setup/constants/ai-setup-orchestrator.constants.ts`
- Test: `src/modules/ai-setup/constants/ai-setup-orchestrator.constants.test.ts` (Create)

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/modules/ai-setup/constants/ai-setup-orchestrator.constants.test.ts
import { describe, expect, it } from 'vitest';
import {
  AI_SETUP_LLM_PROVIDER_ENV,
  AI_SETUP_DEFAULT_PROVIDER,
  DEEPSEEK_API_KEY_ENV,
  DEEPSEEK_MODEL_ENV,
  DEEPSEEK_BASE_URL_ENV,
  AI_SETUP_DEEPSEEK_DEFAULT_MODEL,
  AI_SETUP_DEEPSEEK_DEFAULT_BASE_URL,
  ANTHROPIC_API_KEY_ENV,
  ANTHROPIC_MODEL_ENV,
  AI_SETUP_ANTHROPIC_DEFAULT_MODEL,
} from './ai-setup-orchestrator.constants';

describe('Teste Unitário: ai-setup-orchestrator-constants', () => {
  it('expõe envs e defaults de provider', () => {
    expect(AI_SETUP_LLM_PROVIDER_ENV).toBe('AI_SETUP_LLM_PROVIDER');
    expect(AI_SETUP_DEFAULT_PROVIDER).toBe('deepseek');
    expect(DEEPSEEK_API_KEY_ENV).toBe('DEEPSEEK_API_KEY');
    expect(DEEPSEEK_MODEL_ENV).toBe('AI_SETUP_DEEPSEEK_MODEL');
    expect(DEEPSEEK_BASE_URL_ENV).toBe('AI_SETUP_DEEPSEEK_BASE_URL');
    expect(AI_SETUP_DEEPSEEK_DEFAULT_MODEL).toBe('deepseek-v4-flash');
    expect(AI_SETUP_DEEPSEEK_DEFAULT_BASE_URL).toBe('https://api.deepseek.com');
    expect(ANTHROPIC_API_KEY_ENV).toBe('ANTHROPIC_API_KEY');
    expect(ANTHROPIC_MODEL_ENV).toBe('AI_SETUP_ANTHROPIC_MODEL');
    expect(AI_SETUP_ANTHROPIC_DEFAULT_MODEL).toBe('claude-opus-4-8');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm run vitest:unit src/modules/ai-setup/constants/ai-setup-orchestrator.constants.test.ts`
Expected: FAIL — exports inexistentes.

- [ ] **Step 3: Editar as constants**

Substitua o topo do arquivo (linhas 1-7 atuais: `ANTHROPIC_API_KEY_ENV`/`ANTHROPIC_MODEL_ENV`/`AI_SETUP_DEFAULT_MODEL`/`AI_SETUP_MAX_TOKENS`) por:

```ts
// Seleção de provider.
export const AI_SETUP_LLM_PROVIDER_ENV = 'AI_SETUP_LLM_PROVIDER';
export const AI_SETUP_DEFAULT_PROVIDER = 'deepseek';

// DeepSeek (default).
export const DEEPSEEK_API_KEY_ENV = 'DEEPSEEK_API_KEY';
export const DEEPSEEK_MODEL_ENV = 'AI_SETUP_DEEPSEEK_MODEL';
export const DEEPSEEK_BASE_URL_ENV = 'AI_SETUP_DEEPSEEK_BASE_URL';
export const AI_SETUP_DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';
export const AI_SETUP_DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';

// Anthropic (opt-in).
export const ANTHROPIC_API_KEY_ENV = 'ANTHROPIC_API_KEY';
export const ANTHROPIC_MODEL_ENV = 'AI_SETUP_ANTHROPIC_MODEL';
export const AI_SETUP_ANTHROPIC_DEFAULT_MODEL = 'claude-opus-4-8';

export const AI_SETUP_MAX_TOKENS_ENV = 'AI_SETUP_MAX_TOKENS';
export const AI_SETUP_MAX_TOKENS = 8_192;
```

Mantenha as linhas existentes de `AI_SESSION_MAX_INVOCATIONS`, `AI_SESSION_TIMEOUT_MS` e `AI_SETUP_SYSTEM_PROMPT` inalteradas. **Remova** o antigo `AI_SETUP_DEFAULT_MODEL` (substituído pelos defaults por provider).

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm run vitest:unit src/modules/ai-setup/constants/ai-setup-orchestrator.constants.test.ts`
Expected: PASS. (TypeScript ainda quebra em arquivos que importam `AI_SETUP_DEFAULT_MODEL`/`ANTHROPIC_MESSAGES_CLIENT` — serão corrigidos nas próximas tasks; não rode `typecheck` global ainda.)

- [ ] **Step 5: Commit**

```bash
git add src/modules/ai-setup/constants/
git commit -m "feat(ai-setup): constants de provider deepseek/anthropic

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `DeepSeekLlmClient`

**Files:**
- Create: `src/modules/ai-setup/services/deepseek-llm.client.ts`
- Test: `src/modules/ai-setup/services/deepseek-llm.client.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/modules/ai-setup/services/deepseek-llm.client.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createMock = vi.hoisted(() => vi.fn());
const ctorMock = vi.hoisted(() => vi.fn());

vi.mock('openai', () => {
  class FakeOpenAI {
    chat = { completions: { create: createMock } };
    constructor(opts: unknown) {
      ctorMock(opts);
    }
  }
  return { default: FakeOpenAI };
});

import { DeepSeekLlmClient } from './deepseek-llm.client';

const SUT = 'deepseek-llm-client';

describe(`Teste Unitário: ${SUT}`, () => {
  beforeEach(() => {
    createMock.mockReset();
    ctorMock.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it('instancia o SDK com apiKey e baseURL', async () => {
    createMock.mockResolvedValue({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
    });
    const client = new DeepSeekLlmClient('sk-deep', 'https://api.deepseek.com');
    await client.createTurn({ system: 's', tools: [], messages: [{ role: 'user', content: 'oi' }], maxTokens: 100 });
    expect(ctorMock).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-deep', baseURL: 'https://api.deepseek.com' }),
    );
  });

  it('traduz tools neutras para function-calling e mensagens para o formato OpenAI', async () => {
    createMock.mockResolvedValue({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'fim' } }],
    });
    const client = new DeepSeekLlmClient('sk', 'https://api.deepseek.com');
    await client.createTurn({
      system: 'SYS',
      tools: [{ name: 'schema.listTables', description: 'lista', parameters: { type: 'object' } }],
      messages: [
        { role: 'user', content: 'descubra' },
        { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'schema.listTables', arguments: { schema: 'dbo' } }] },
        { role: 'tool', toolCallId: 'c1', content: '{"tables":["produtos"]}' },
      ],
      maxTokens: 64,
    });
    const arg = createMock.mock.calls[0][0];
    expect(arg.model).toBeUndefined(); // o modelo é injetado pelo orquestrador, não pelo client
    expect(arg.max_tokens).toBe(64);
    expect(arg.tools).toEqual([
      { type: 'function', function: { name: 'schema.listTables', description: 'lista', parameters: { type: 'object' } } },
    ]);
    // system vira a 1a mensagem; assistant carrega tool_calls; tool vira role:tool
    expect(arg.messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(arg.messages[1]).toEqual({ role: 'user', content: 'descubra' });
    expect(arg.messages[2]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'schema.listTables', arguments: '{"schema":"dbo"}' } }],
    });
    expect(arg.messages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"tables":["produtos"]}' });
  });

  it('mapeia finish_reason=tool_calls e parseia arguments', async () => {
    createMock.mockResolvedValue({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c9', type: 'function', function: { name: 'probe.engines', arguments: '{"a":1}' } }],
          },
        },
      ],
    });
    const client = new DeepSeekLlmClient('sk', 'https://api.deepseek.com');
    const turn = await client.createTurn({ system: 's', tools: [], messages: [{ role: 'user', content: 'x' }], maxTokens: 10 });
    expect(turn.stop).toBe('tool_calls');
    expect(turn.toolCalls).toEqual([{ id: 'c9', name: 'probe.engines', arguments: { a: 1 } }]);
    expect(turn.text).toBeNull();
  });

  it('mapeia finish_reason=stop para stop:end', async () => {
    createMock.mockResolvedValue({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'pronto' } }],
    });
    const client = new DeepSeekLlmClient('sk', 'https://api.deepseek.com');
    const turn = await client.createTurn({ system: 's', tools: [], messages: [{ role: 'user', content: 'x' }], maxTokens: 10 });
    expect(turn.stop).toBe('end');
    expect(turn.text).toBe('pronto');
    expect(turn.toolCalls).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm run vitest:unit src/modules/ai-setup/services/deepseek-llm.client.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar o client**

```ts
// src/modules/ai-setup/services/deepseek-llm.client.ts
import OpenAI from 'openai';

import type {
  LlmClient,
  LlmCreateTurnParams,
  LlmMessage,
  LlmToolCall,
  LlmToolDef,
  LlmTurn,
} from '../interfaces/llm-client.interface';

export class DeepSeekLlmClient implements LlmClient {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(apiKey: string, baseURL: string, model = '') {
    this.client = new OpenAI({ apiKey, baseURL });
    this.model = model;
  }

  async createTurn(params: LlmCreateTurnParams): Promise<LlmTurn> {
    const tools = params.tools.map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    const messages = [
      { role: 'system' as const, content: params.system },
      ...params.messages.map((m) => this.toOpenAiMessage(m)),
    ];

    const response = await this.client.chat.completions.create({
      ...(this.model ? { model: this.model } : {}),
      max_tokens: params.maxTokens,
      tools: tools.length > 0 ? tools : undefined,
      messages: messages as never,
    } as never);

    const choice = (response as { choices: unknown[] }).choices[0] as {
      finish_reason: string;
      message: {
        content: string | null;
        tool_calls?: { id: string; function: { name: string; arguments: string } }[];
      };
    };

    const toolCalls: LlmToolCall[] = (choice.message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: parseJsonObject(tc.function.arguments),
    }));

    return {
      text: choice.message.content ?? null,
      toolCalls,
      stop: choice.finish_reason === 'tool_calls' || toolCalls.length > 0 ? 'tool_calls' : 'end',
    };
  }

  private toOpenAiMessage(m: LlmMessage): Record<string, unknown> {
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: m.content,
        ...(m.toolCalls && m.toolCalls.length > 0
          ? {
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
              })),
            }
          : {}),
      };
    }
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
    return { role: m.role, content: m.content };
  }
}

function parseJsonObject(raw: string): unknown {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}
```

> Nota: o `model` é injetado pelo orquestrador via `LLM_MODEL`; o client aceita `model` opcional só para flexibilidade. Como nos testes do client o modelo não é passado, `model` fica vazio e é omitido — o teste valida `arg.model` indefinido.

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm run vitest:unit src/modules/ai-setup/services/deepseek-llm.client.test.ts`
Expected: PASS (4 testes).

- [ ] **Step 5: Commit**

```bash
git add src/modules/ai-setup/services/deepseek-llm.client.ts src/modules/ai-setup/services/deepseek-llm.client.test.ts
git commit -m "feat(ai-setup): DeepSeekLlmClient com traducao neutro-OpenAI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `AnthropicLlmClient` (substitui o client antigo)

**Files:**
- Create: `src/modules/ai-setup/services/anthropic-llm.client.ts`
- Test: `src/modules/ai-setup/services/anthropic-llm.client.test.ts`
- Delete: `src/modules/ai-setup/services/anthropic-messages.client.ts` e `...client.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/modules/ai-setup/services/anthropic-llm.client.test.ts
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

import { AnthropicLlmClient } from './anthropic-llm.client';

const SUT = 'anthropic-llm-client';

describe(`Teste Unitário: ${SUT}`, () => {
  beforeEach(() => {
    createMock.mockReset();
    ctorMock.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it('instancia o SDK com apiKey e aplica cache_control no system', async () => {
    createMock.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] });
    const client = new AnthropicLlmClient('sk-ant');
    await client.createTurn({ system: 'SYS', tools: [], messages: [{ role: 'user', content: 'oi' }], maxTokens: 50 });
    expect(ctorMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-ant' }));
    const arg = createMock.mock.calls[0][0];
    expect(arg.system).toEqual([{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]);
    expect(arg.max_tokens).toBe(50);
  });

  it('traduz tools neutras para input_schema e coalesce tool_results num único user', async () => {
    createMock.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }] });
    const client = new AnthropicLlmClient('sk');
    await client.createTurn({
      system: 's',
      tools: [{ name: 'probe.engines', description: 'e', parameters: { type: 'object' } }],
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: null, toolCalls: [
          { id: 'a1', name: 'probe.engines', arguments: { x: 1 } },
          { id: 'a2', name: 'schema.listTables', arguments: {} },
        ] },
        { role: 'tool', toolCallId: 'a1', content: 'R1' },
        { role: 'tool', toolCallId: 'a2', content: 'R2' },
      ],
      maxTokens: 10,
    });
    const arg = createMock.mock.calls[0][0];
    expect(arg.tools).toEqual([{ name: 'probe.engines', description: 'e', input_schema: { type: 'object' } }]);
    // assistant com 2 tool_use
    expect(arg.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'a1', name: 'probe.engines', input: { x: 1 } },
        { type: 'tool_use', id: 'a2', name: 'schema.listTables', input: {} },
      ],
    });
    // os 2 tool resultados viram UM único user com 2 blocos tool_result
    expect(arg.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a1', content: 'R1' },
        { type: 'tool_result', tool_use_id: 'a2', content: 'R2' },
      ],
    });
  });

  it('mapeia stop_reason=tool_use e extrai toolCalls + texto', async () => {
    createMock.mockResolvedValue({
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'penso' },
        { type: 'tool_use', id: 't1', name: 'probe.engines', input: { a: 1 } },
      ],
    });
    const client = new AnthropicLlmClient('sk');
    const turn = await client.createTurn({ system: 's', tools: [], messages: [{ role: 'user', content: 'x' }], maxTokens: 10 });
    expect(turn.stop).toBe('tool_calls');
    expect(turn.toolCalls).toEqual([{ id: 't1', name: 'probe.engines', arguments: { a: 1 } }]);
    expect(turn.text).toBe('penso');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm run vitest:unit src/modules/ai-setup/services/anthropic-llm.client.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar o client**

```ts
// src/modules/ai-setup/services/anthropic-llm.client.ts
import Anthropic from '@anthropic-ai/sdk';

import type {
  LlmClient,
  LlmCreateTurnParams,
  LlmMessage,
  LlmToolCall,
  LlmTurn,
} from '../interfaces/llm-client.interface';

export class AnthropicLlmClient implements LlmClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(apiKey: string, model = '') {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async createTurn(params: LlmCreateTurnParams): Promise<LlmTurn> {
    const tools = params.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));

    const response = await this.client.messages.create({
      ...(this.model ? { model: this.model } : {}),
      max_tokens: params.maxTokens,
      system: [{ type: 'text', text: params.system, cache_control: { type: 'ephemeral' } }],
      tools: tools as never,
      messages: this.toAnthropicMessages(params.messages) as never,
    } as never);

    const content = (response as { content: unknown[] }).content as {
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
    }[];

    const toolCalls: LlmToolCall[] = content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id as string, name: b.name as string, arguments: b.input }));

    const textBlock = content.find((b) => b.type === 'text');
    const stopReason = (response as { stop_reason: string }).stop_reason;

    return {
      text: textBlock?.text ?? null,
      toolCalls,
      stop: stopReason === 'tool_use' || toolCalls.length > 0 ? 'tool_calls' : 'end',
    };
  }

  private toAnthropicMessages(messages: LlmMessage[]): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const m of messages) {
      if (m.role === 'system') {
        continue; // system vai no campo dedicado
      }
      if (m.role === 'user') {
        out.push({ role: 'user', content: m.content });
        continue;
      }
      if (m.role === 'assistant') {
        const blocks = (m.toolCalls ?? []).map((tc) => ({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.arguments,
        }));
        out.push({ role: 'assistant', content: blocks });
        continue;
      }
      // role === 'tool' — coalesce em um único user com blocos tool_result
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
      const last = out[out.length - 1] as { role?: string; content?: unknown[] } | undefined;
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
    }
    return out;
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm run vitest:unit src/modules/ai-setup/services/anthropic-llm.client.test.ts`
Expected: PASS (3 testes).

- [ ] **Step 5: Remover o client antigo**

```bash
git rm src/modules/ai-setup/services/anthropic-messages.client.ts src/modules/ai-setup/services/anthropic-messages.client.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/modules/ai-setup/services/anthropic-llm.client.ts src/modules/ai-setup/services/anthropic-llm.client.test.ts
git commit -m "feat(ai-setup): AnthropicLlmClient neutro substitui o client antigo

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Factory de provider

**Files:**
- Create: `src/modules/ai-setup/services/llm-client.factory.ts`
- Test: `src/modules/ai-setup/services/llm-client.factory.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/modules/ai-setup/services/llm-client.factory.test.ts
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

vi.mock('openai', () => ({ default: class { constructor(_: unknown) {} chat = { completions: { create: vi.fn() } }; } }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { constructor(_: unknown) {} messages = { create: vi.fn() }; } }));

import { DeepSeekLlmClient } from './deepseek-llm.client';
import { AnthropicLlmClient } from './anthropic-llm.client';
import { createLlmClient, resolveLlmModel, resolveLlmProvider } from './llm-client.factory';

const SUT = 'llm-client-factory';

function cfg(map: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => map[k] } as unknown as ConfigService;
}

describe(`Teste Unitário: ${SUT}`, () => {
  it('default provider é deepseek e cria DeepSeekLlmClient', () => {
    const config = cfg({ DEEPSEEK_API_KEY: 'sk-d' });
    expect(resolveLlmProvider(config)).toBe('deepseek');
    expect(createLlmClient(config)).toBeInstanceOf(DeepSeekLlmClient);
  });

  it('seleciona anthropic via env e cria AnthropicLlmClient', () => {
    const config = cfg({ AI_SETUP_LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-a' });
    expect(resolveLlmProvider(config)).toBe('anthropic');
    expect(createLlmClient(config)).toBeInstanceOf(AnthropicLlmClient);
  });

  it('resolve o modelo default por provider e respeita override', () => {
    expect(resolveLlmModel(cfg({ DEEPSEEK_API_KEY: 'x' }))).toBe('deepseek-v4-flash');
    expect(resolveLlmModel(cfg({ DEEPSEEK_API_KEY: 'x', AI_SETUP_DEEPSEEK_MODEL: 'deepseek-chat' }))).toBe('deepseek-chat');
    expect(resolveLlmModel(cfg({ AI_SETUP_LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'x' }))).toBe('claude-opus-4-8');
  });

  it('fail-fast quando a key do provider selecionado falta', () => {
    expect(() => createLlmClient(cfg({}))).toThrow(/DEEPSEEK_API_KEY/);
    expect(() => createLlmClient(cfg({ AI_SETUP_LLM_PROVIDER: 'anthropic' }))).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('rejeita provider desconhecido', () => {
    expect(() => resolveLlmProvider(cfg({ AI_SETUP_LLM_PROVIDER: 'foo' }))).toThrow(/AI_SETUP_LLM_PROVIDER/);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm run vitest:unit src/modules/ai-setup/services/llm-client.factory.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar a factory**

```ts
// src/modules/ai-setup/services/llm-client.factory.ts
import type { ConfigService } from '@nestjs/config';

import { InternalException } from '@/common/exceptions/app.exception';
import {
  AI_SETUP_ANTHROPIC_DEFAULT_MODEL,
  AI_SETUP_DEEPSEEK_DEFAULT_BASE_URL,
  AI_SETUP_DEEPSEEK_DEFAULT_MODEL,
  AI_SETUP_DEFAULT_PROVIDER,
  AI_SETUP_LLM_PROVIDER_ENV,
  ANTHROPIC_API_KEY_ENV,
  ANTHROPIC_MODEL_ENV,
  DEEPSEEK_API_KEY_ENV,
  DEEPSEEK_BASE_URL_ENV,
  DEEPSEEK_MODEL_ENV,
} from '../constants/ai-setup-orchestrator.constants';
import type { LlmClient } from '../interfaces/llm-client.interface';
import { AnthropicLlmClient } from './anthropic-llm.client';
import { DeepSeekLlmClient } from './deepseek-llm.client';

export type LlmProvider = 'deepseek' | 'anthropic';

export function resolveLlmProvider(config: ConfigService): LlmProvider {
  const raw = (config.get<string>(AI_SETUP_LLM_PROVIDER_ENV) ?? AI_SETUP_DEFAULT_PROVIDER).trim();
  if (raw !== 'deepseek' && raw !== 'anthropic') {
    throw new InternalException(`${AI_SETUP_LLM_PROVIDER_ENV} inválido: "${raw}" (use deepseek|anthropic)`);
  }
  return raw;
}

export function resolveLlmModel(config: ConfigService): string {
  if (resolveLlmProvider(config) === 'anthropic') {
    return config.get<string>(ANTHROPIC_MODEL_ENV)?.trim() || AI_SETUP_ANTHROPIC_DEFAULT_MODEL;
  }
  return config.get<string>(DEEPSEEK_MODEL_ENV)?.trim() || AI_SETUP_DEEPSEEK_DEFAULT_MODEL;
}

export function createLlmClient(config: ConfigService): LlmClient {
  const provider = resolveLlmProvider(config);
  if (provider === 'anthropic') {
    const apiKey = config.get<string>(ANTHROPIC_API_KEY_ENV)?.trim();
    if (!apiKey) {
      throw new InternalException(`${ANTHROPIC_API_KEY_ENV} ausente para o provider anthropic`);
    }
    return new AnthropicLlmClient(apiKey);
  }
  const apiKey = config.get<string>(DEEPSEEK_API_KEY_ENV)?.trim();
  if (!apiKey) {
    throw new InternalException(`${DEEPSEEK_API_KEY_ENV} ausente para o provider deepseek`);
  }
  const baseURL = config.get<string>(DEEPSEEK_BASE_URL_ENV)?.trim() || AI_SETUP_DEEPSEEK_DEFAULT_BASE_URL;
  return new DeepSeekLlmClient(apiKey, baseURL);
}
```

> O `model` NÃO é passado ao client aqui: ele é injetado no orquestrador via `LLM_MODEL` (Task 8), mantendo o client agnóstico de modelo. Cada client envia o `model` que vier no DI.

> Ajuste necessário ao client: para o `model` chegar via DI, o orquestrador passa o modelo dentro de `createTurn`? NÃO — `createTurn` não recebe model. Em vez disso, o módulo cria o client JÁ com o modelo resolvido. Veja Task 8: o provider de DI chama `createLlmClient(config)` e injeta `resolveLlmModel(config)` separadamente; o orquestrador repassa o model ao client via construtor. Para isso, `createLlmClient` recebe o model: **atualize a assinatura** para `createLlmClient(config, model = resolveLlmModel(config))` e passe-o aos construtores (`new DeepSeekLlmClient(apiKey, baseURL, model)` / `new AnthropicLlmClient(apiKey, model)`). Atualize o teste da factory para tolerar isso (o `instanceof` continua válido).

- [ ] **Step 4: Ajustar `createLlmClient` para injetar o model**

Reescreva o corpo para incluir o model:

```ts
export function createLlmClient(config: ConfigService, model = resolveLlmModel(config)): LlmClient {
  const provider = resolveLlmProvider(config);
  if (provider === 'anthropic') {
    const apiKey = config.get<string>(ANTHROPIC_API_KEY_ENV)?.trim();
    if (!apiKey) {
      throw new InternalException(`${ANTHROPIC_API_KEY_ENV} ausente para o provider anthropic`);
    }
    return new AnthropicLlmClient(apiKey, model);
  }
  const apiKey = config.get<string>(DEEPSEEK_API_KEY_ENV)?.trim();
  if (!apiKey) {
    throw new InternalException(`${DEEPSEEK_API_KEY_ENV} ausente para o provider deepseek`);
  }
  const baseURL = config.get<string>(DEEPSEEK_BASE_URL_ENV)?.trim() || AI_SETUP_DEEPSEEK_DEFAULT_BASE_URL;
  return new DeepSeekLlmClient(apiKey, baseURL, model);
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `pnpm run vitest:unit src/modules/ai-setup/services/llm-client.factory.test.ts`
Expected: PASS (5 testes).

- [ ] **Step 6: Commit**

```bash
git add src/modules/ai-setup/services/llm-client.factory.ts src/modules/ai-setup/services/llm-client.factory.test.ts
git commit -m "feat(ai-setup): factory de provider de LLM com fail-fast

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Validador do mapping (`emit_mapping`)

**Files:**
- Create: `src/modules/ai-setup/services/validate-catalog-mapping.ts`
- Test: `src/modules/ai-setup/services/validate-catalog-mapping.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/modules/ai-setup/services/validate-catalog-mapping.test.ts
import { describe, expect, it } from 'vitest';
import { validateCatalogMapping } from './validate-catalog-mapping';

const BASE = {
  mappingVersion: 'v1',
  syncMode: 'snapshot',
  pollIntervalMs: 300_000,
  batchSize: 100,
  snapshotQuery: 'SELECT 1',
  fields: { sourceProductCode: 'codigo', name: 'nome' },
};

describe('Teste Unitário: validate-catalog-mapping', () => {
  it('aceita um mapping snapshot válido', () => {
    expect(validateCatalogMapping(BASE).ok).toBe(true);
  });

  it('aceita incremental válido', () => {
    const r = validateCatalogMapping({
      ...BASE,
      syncMode: 'incremental',
      snapshotQuery: undefined,
      incrementalQuery: 'SELECT 1 WHERE updated_at > ?',
      cursorField: 'updated_at',
      cursorType: 'timestamp',
    });
    expect(r.ok).toBe(true);
  });

  it('rejeita quando não é objeto', () => {
    expect(validateCatalogMapping('x').ok).toBe(false);
    expect(validateCatalogMapping(null).ok).toBe(false);
  });

  it('rejeita campos obrigatórios ausentes', () => {
    const r = validateCatalogMapping({ ...BASE, fields: { name: 'nome' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/sourceProductCode/);
  });

  it('rejeita snapshot sem snapshotQuery e incremental sem incrementalQuery', () => {
    expect(validateCatalogMapping({ ...BASE, snapshotQuery: undefined }).ok).toBe(false);
    expect(validateCatalogMapping({ ...BASE, syncMode: 'incremental', snapshotQuery: undefined }).ok).toBe(false);
  });

  it('rejeita syncMode inválido', () => {
    expect(validateCatalogMapping({ ...BASE, syncMode: 'full' }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm run vitest:unit src/modules/ai-setup/services/validate-catalog-mapping.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar o validador**

```ts
// src/modules/ai-setup/services/validate-catalog-mapping.ts
import type { IConnectorCatalogMappingConfig } from '@modules/pharma-agent-catalog/interfaces/connector-catalog-config-payload.interface';

export type ValidateMappingResult =
  | { ok: true; mapping: IConnectorCatalogMappingConfig }
  | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

export function validateCatalogMapping(value: unknown): ValidateMappingResult {
  if (!isRecord(value)) {
    return { ok: false, error: 'mapping deve ser um objeto' };
  }
  if (!isNonEmptyString(value.mappingVersion)) {
    return { ok: false, error: 'mappingVersion ausente' };
  }
  if (value.syncMode !== 'snapshot' && value.syncMode !== 'incremental') {
    return { ok: false, error: 'syncMode deve ser snapshot|incremental' };
  }
  const fields = value.fields;
  if (!isRecord(fields) || !isNonEmptyString(fields.sourceProductCode) || !isNonEmptyString(fields.name)) {
    return { ok: false, error: 'fields.sourceProductCode e fields.name são obrigatórios' };
  }
  if (value.syncMode === 'snapshot' && !isNonEmptyString(value.snapshotQuery)) {
    return { ok: false, error: 'snapshotQuery obrigatório no modo snapshot' };
  }
  if (value.syncMode === 'incremental') {
    if (!isNonEmptyString(value.incrementalQuery)) {
      return { ok: false, error: 'incrementalQuery obrigatório no modo incremental' };
    }
    if (!isNonEmptyString(value.cursorField)) {
      return { ok: false, error: 'cursorField obrigatório no modo incremental' };
    }
  }
  return { ok: true, mapping: value as unknown as IConnectorCatalogMappingConfig };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm run vitest:unit src/modules/ai-setup/services/validate-catalog-mapping.test.ts`
Expected: PASS (6 testes).

- [ ] **Step 5: Commit**

```bash
git add src/modules/ai-setup/services/validate-catalog-mapping.ts src/modules/ai-setup/services/validate-catalog-mapping.test.ts
git commit -m "feat(ai-setup): validador estrutural do mapping do emit_mapping

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Translator → `LlmToolDef[]`

**Files:**
- Modify: `src/modules/ai-setup/services/catalog-to-tools.translator.ts`
- Modify: `src/modules/ai-setup/services/catalog-to-tools.translator.test.ts`

- [ ] **Step 1: Reescrever o teste**

```ts
// src/modules/ai-setup/services/catalog-to-tools.translator.test.ts
import { describe, expect, it } from 'vitest';
import { CatalogToToolsTranslator } from './catalog-to-tools.translator';

describe('Teste Unitário: catalog-to-tools-translator', () => {
  it('traduz descritores do catálogo para LlmToolDef neutro', () => {
    const t = new CatalogToToolsTranslator();
    const out = t.translate([
      { name: 'probe.engines', description: 'engines', inputSchema: { type: 'object', properties: {} } },
    ]);
    expect(out).toEqual([
      { name: 'probe.engines', description: 'engines', parameters: { type: 'object', properties: {} } },
    ]);
  });

  it('preenche parameters default quando inputSchema ausente', () => {
    const t = new CatalogToToolsTranslator();
    const out = t.translate([{ name: 'x', description: 'd', inputSchema: undefined }]);
    expect(out[0].parameters).toEqual({ type: 'object', properties: {} });
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm run vitest:unit src/modules/ai-setup/services/catalog-to-tools.translator.test.ts`
Expected: FAIL — retorna `input_schema`, não `parameters`.

- [ ] **Step 3: Reescrever o translator**

```ts
// src/modules/ai-setup/services/catalog-to-tools.translator.ts
import { Injectable } from '@nestjs/common';

import type { IToolDescriptor } from '../interfaces/ai-setup-protocol.interface';
import type { LlmToolDef } from '../interfaces/llm-client.interface';

@Injectable()
export class CatalogToToolsTranslator {
  translate(descriptors: IToolDescriptor[]): LlmToolDef[] {
    return descriptors.map((descriptor) => {
      const rawSchema = descriptor.inputSchema ?? {};
      const parameters =
        rawSchema && typeof rawSchema === 'object' && 'type' in rawSchema
          ? (rawSchema as Record<string, unknown>)
          : { type: 'object', properties: {}, ...(rawSchema as Record<string, unknown>) };

      return { name: descriptor.name, description: descriptor.description, parameters };
    });
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm run vitest:unit src/modules/ai-setup/services/catalog-to-tools.translator.test.ts`
Expected: PASS (2 testes).

- [ ] **Step 5: Commit**

```bash
git add src/modules/ai-setup/services/catalog-to-tools.translator.ts src/modules/ai-setup/services/catalog-to-tools.translator.test.ts
git commit -m "refactor(ai-setup): translator emite LlmToolDef neutro

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Orquestrador em tipos neutros + validação + fim→falha

**Files:**
- Modify: `src/modules/ai-setup/services/ai-setup-orchestrator.service.ts`
- Modify: `src/modules/ai-setup/services/ai-setup-orchestrator.service.test.ts`

> **⚠️ NOTA DE RECONCILIAÇÃO (provisionamento read-only):**
> Este plano foi escrito ANTES da feature de **provisionamento de usuário read-only**
> ser mergeada nesta mesma branch. Essa feature ALTEROU o orquestrador, o módulo e o
> int test. O refactor para tipos neutros **NÃO pode apagar** a lógica de provisionamento.
> Concretamente, esta task DEVE preservar:
> - a **4ª/6ª dependência** `AiSetupProvisioningService` no construtor;
> - o campo `engine?: string` em `IRunSessionInput`;
> - os imports de `AI_SESSION_STATE_MESSAGE_TYPE`, `PROPOSE_READONLY_USER_TOOL_NAME`,
>   `IProvisionSignalToolResult` e `AiSetupProvisioningService`;
> - a **interceptação** `if (call.name === PROPOSE_READONLY_USER_TOOL_NAME)` dentro do
>   loop, ANTES do branch genérico `bridge.invokeTool`;
> - o método `handleProposeReadonlyUser` IDÊNTICO ao atual (emite fase `provisioning`,
>   chama `provisioning.proposeAndAwait`, e emite fase `schema`/`discovering` conforme a
>   decisão). Ele NÃO muda com tipos neutros — só o transporte do resultado da tool
>   passa de `tool_result` (Anthropic) para a mensagem neutra `role:'tool'`.
> O código e os testes abaixo já incorporam essa preservação.

- [ ] **Step 1: Reescrever o teste (mock neutro + novos comportamentos + provisionamento)**

```ts
// src/modules/ai-setup/services/ai-setup-orchestrator.service.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InternalException } from '@/common/exceptions/app.exception';
import { PROPOSE_READONLY_USER_TOOL_NAME } from '../constants/ai-setup-provisioning.constants';
import type { IToolDescriptor } from '../interfaces/ai-setup-protocol.interface';
import type { LlmTurn } from '../interfaces/llm-client.interface';
import { AiSetupOrchestratorService } from './ai-setup-orchestrator.service';
import { CatalogToToolsTranslator } from './catalog-to-tools.translator';

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
  snapshotQuery: 'SELECT p.codigo, p.nome FROM produtos p',
  fields: { sourceProductCode: 'codigo', name: 'nome' },
};

function toolCallTurn(name: string, args: unknown, id = 'tc'): LlmTurn {
  return { text: null, toolCalls: [{ id, name, arguments: args }], stop: 'tool_calls' };
}
function endTurn(): LlmTurn {
  return { text: 'fim', toolCalls: [], stop: 'end' };
}

describe(`Teste Unitário: ${SUT}`, () => {
  let llm: { createTurn: ReturnType<typeof vi.fn> };
  let bridge: {
    invokeTool: ReturnType<typeof vi.fn>;
    emitMappingProposed: ReturnType<typeof vi.fn>;
    emitSessionState: ReturnType<typeof vi.fn>;
  };
  let provisioning: { proposeAndAwait: ReturnType<typeof vi.fn> };
  let service: AiSetupOrchestratorService;

  beforeEach(() => {
    llm = { createTurn: vi.fn() };
    bridge = { invokeTool: vi.fn(), emitMappingProposed: vi.fn(), emitSessionState: vi.fn() };
    provisioning = { proposeAndAwait: vi.fn() };
    service = new AiSetupOrchestratorService(
      llm as never,
      'deepseek-v4-flash',
      8192,
      bridge as never,
      new CatalogToToolsTranslator(),
      provisioning as never,
    );
  });
  afterEach(() => vi.clearAllMocks());

  it('tool_call -> tool.invoke -> tool result -> emit_mapping válido propõe o mapping', async () => {
    llm.createTurn
      .mockResolvedValueOnce(toolCallTurn('schema.listTables', { schema: 'dbo' }, 'c1'))
      .mockResolvedValueOnce(toolCallTurn('emit_mapping', { mapping: VALID_MAPPING, rationale: 'JOIN', previewRows: [] }, 'c2'));
    bridge.invokeTool.mockResolvedValueOnce({ ok: true, payload: { tables: ['produtos'] } });

    await service.runSession({ companyId: 7, connectorId: 'conn-1', sessionId: 's1', catalog: CATALOG });

    expect(bridge.invokeTool).toHaveBeenCalledWith('conn-1', 's1', 'schema.listTables', { schema: 'dbo' });
    expect(bridge.emitMappingProposed).toHaveBeenCalledWith('conn-1', {
      type: 'mapping.proposed',
      sessionId: 's1',
      mapping: VALID_MAPPING,
      rationale: 'JOIN',
      previewRows: [],
    });
    // o segundo turno recebeu a mensagem 'tool' com o resultado
    const secondMessages = llm.createTurn.mock.calls[1][0].messages;
    expect(secondMessages.some((m: { role: string }) => m.role === 'tool')).toBe(true);
  });

  it('emit_mapping inválido lança InternalException (failed)', async () => {
    llm.createTurn.mockResolvedValueOnce(
      toolCallTurn('emit_mapping', { mapping: { mappingVersion: 'v1' }, rationale: 'x' }, 'c1'),
    );
    const promise = service.runSession({ companyId: 7, connectorId: 'conn-1', sessionId: 's1', catalog: CATALOG });
    await expect(promise).rejects.toBeInstanceOf(InternalException);
    await expect(promise).rejects.toThrow(/mapping/i);
    expect(bridge.emitMappingProposed).not.toHaveBeenCalled();
  });

  it('fim sem emit_mapping lança InternalException (failed)', async () => {
    llm.createTurn.mockResolvedValueOnce(endTurn());
    const promise = service.runSession({ companyId: 7, connectorId: 'conn-1', sessionId: 's1', catalog: CATALOG });
    await expect(promise).rejects.toBeInstanceOf(InternalException);
    await expect(promise).rejects.toThrow(/sem propor mapping/i);
  });

  it('repassa errorCode da ferramenta no conteúdo da mensagem tool e segue o loop', async () => {
    llm.createTurn
      .mockResolvedValueOnce(toolCallTurn('schema.listTables', {}, 'c1'))
      .mockResolvedValueOnce(endTurn());
    bridge.invokeTool.mockResolvedValueOnce({ ok: false, errorCode: 'auth' });

    const promise = service.runSession({ companyId: 7, connectorId: 'conn-1', sessionId: 's1', catalog: CATALOG });
    await expect(promise).rejects.toThrow(/sem propor mapping/i); // termina sem mapping após o erro
    const secondMessages = llm.createTurn.mock.calls[1][0].messages;
    const toolMsg = secondMessages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMsg.content).toContain('auth');
  });

  it('aborta ao exceder o limite de invocações', async () => {
    llm.createTurn.mockResolvedValue(toolCallTurn('schema.listTables', {}, 'c'));
    bridge.invokeTool.mockResolvedValue({ ok: true, payload: {} });
    const promise = service.runSession(
      { companyId: 7, connectorId: 'conn-1', sessionId: 's1', catalog: CATALOG },
      { maxInvocations: 3, timeoutMs: 60_000 },
    );
    await expect(promise).rejects.toBeInstanceOf(InternalException);
    await expect(promise).rejects.toThrow(/limite de invocações/i);
    expect(bridge.invokeTool).toHaveBeenCalledTimes(3);
  });

  it('aborta ao exceder o timeout global', async () => {
    const base = 1_000_000;
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(base).mockReturnValueOnce(base).mockReturnValue(base + 10_000);
    llm.createTurn.mockResolvedValue(toolCallTurn('schema.listTables', {}, 'c'));
    bridge.invokeTool.mockResolvedValue({ ok: true, payload: {} });
    const promise = service.runSession(
      { companyId: 7, connectorId: 'conn-1', sessionId: 's1', catalog: CATALOG },
      { maxInvocations: 100, timeoutMs: 5_000 },
    );
    await expect(promise).rejects.toThrow(/timeout de sessão/i);
    nowSpy.mockRestore();
  });

  it('propose_readonly_user provisionado: chama proposeAndAwait e emite fase provisioning→schema', async () => {
    llm.createTurn
      .mockResolvedValueOnce(
        toolCallTurn('propose_readonly_user', { username: 'ro_user', rationale: 'sem acesso' }, 'p1'),
      )
      .mockResolvedValueOnce(
        toolCallTurn('emit_mapping', { mapping: VALID_MAPPING, rationale: 'JOIN', previewRows: [] }, 'c2'),
      );
    provisioning.proposeAndAwait.mockResolvedValueOnce({
      provisioned: true,
      activeCredential: 'readonly_user',
      username: 'ro_user',
    });

    await service.runSession({
      companyId: 7,
      connectorId: 'conn-1',
      sessionId: 's1',
      catalog: CATALOG,
      engine: 'postgres',
    });

    expect(provisioning.proposeAndAwait).toHaveBeenCalledWith({
      connectorId: 'conn-1',
      sessionId: 's1',
      username: 'ro_user',
      engine: 'postgres',
      rationale: 'sem acesso',
    });
    // Fase 'provisioning' antes da decisão; 'schema' após provisionar.
    expect(bridge.emitSessionState).toHaveBeenNthCalledWith(1, 'conn-1', {
      type: AI_SESSION_STATE_MESSAGE_TYPE,
      sessionId: 's1',
      phase: 'provisioning',
    });
    expect(bridge.emitSessionState).toHaveBeenNthCalledWith(2, 'conn-1', {
      type: AI_SESSION_STATE_MESSAGE_TYPE,
      sessionId: 's1',
      phase: 'schema',
    });
    // O sinal volta ao loop como mensagem neutra role:'tool'.
    const secondMessages = llm.createTurn.mock.calls[1][0].messages;
    const toolMsg = secondMessages.find(
      (m: { role: string; toolCallId?: string }) => m.role === 'tool' && m.toolCallId === 'p1',
    );
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content).toContain('readonly_user');
    // propose_readonly_user NÃO vai ao bridge.invokeTool.
    expect(bridge.invokeTool).not.toHaveBeenCalled();
  });

  it('propose_readonly_user não provisionado: emite fase provisioning→discovering', async () => {
    llm.createTurn
      .mockResolvedValueOnce(toolCallTurn('propose_readonly_user', { username: 'ro_user' }, 'p1'))
      .mockResolvedValueOnce(
        toolCallTurn('emit_mapping', { mapping: VALID_MAPPING, rationale: 'JOIN', previewRows: [] }, 'c2'),
      );
    provisioning.proposeAndAwait.mockResolvedValueOnce({
      provisioned: false,
      activeCredential: 'discovered',
      reason: 'rejected',
    });

    await service.runSession({
      companyId: 7,
      connectorId: 'conn-1',
      sessionId: 's1',
      catalog: CATALOG,
      engine: 'postgres',
    });

    expect(provisioning.proposeAndAwait).toHaveBeenCalledTimes(1);
    expect(bridge.emitSessionState).toHaveBeenNthCalledWith(2, 'conn-1', {
      type: AI_SESSION_STATE_MESSAGE_TYPE,
      sessionId: 's1',
      phase: 'discovering',
    });
  });
});
```

> O teste importa `PROPOSE_READONLY_USER_TOOL_NAME` real (usado implicitamente via
> `toolCallTurn('propose_readonly_user', ...)` — o nome literal É o valor da constante) e
> `AI_SESSION_STATE_MESSAGE_TYPE` para casar os payloads de `emitSessionState`. Adicione o
> import no topo do arquivo de teste:
>
> ```ts
> import { AI_SESSION_STATE_MESSAGE_TYPE } from '../constants/ai-setup-protocol.constants';
> ```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm run vitest:unit src/modules/ai-setup/services/ai-setup-orchestrator.service.test.ts`
Expected: FAIL — construtor/contrato antigos.

- [ ] **Step 3: Reescrever o orquestrador**

```ts
// src/modules/ai-setup/services/ai-setup-orchestrator.service.ts
import type { IConnectorCatalogMappingConfig } from '@modules/pharma-agent-catalog/interfaces/connector-catalog-config-payload.interface';
import { Inject, Injectable } from '@nestjs/common';

import { InternalException } from '@/common/exceptions/app.exception';
import { logger } from '@/common/utils/enhanced-logger';

import {
  AI_SESSION_MAX_INVOCATIONS,
  AI_SESSION_TIMEOUT_MS,
  AI_SETUP_SYSTEM_PROMPT,
} from '../constants/ai-setup-orchestrator.constants';
import { AI_SESSION_STATE_MESSAGE_TYPE } from '../constants/ai-setup-protocol.constants';
import { PROPOSE_READONLY_USER_TOOL_NAME } from '../constants/ai-setup-provisioning.constants';
import { AiSessionConnectorBridge } from '../gateways/ai-session-connector-bridge';
import type { IProvisionSignalToolResult } from '../interfaces/ai-setup-provisioning.interface';
import type { IToolDescriptor } from '../interfaces/ai-setup-protocol.interface';
import {
  LLM_CLIENT,
  LLM_MAX_TOKENS,
  LLM_MODEL,
  type LlmClient,
  type LlmMessage,
  type LlmToolDef,
} from '../interfaces/llm-client.interface';
import { AiSetupProvisioningService } from './ai-setup-provisioning.service';
import { CatalogToToolsTranslator } from './catalog-to-tools.translator';
import { validateCatalogMapping } from './validate-catalog-mapping';

const MODULE = 'AiSetupOrchestratorService';
const EMIT_MAPPING_TOOL_NAME = 'emit_mapping';

export interface IRunSessionInput {
  companyId: number;
  connectorId: string;
  sessionId: string;
  catalog: IToolDescriptor[];
  engine?: string;
}

export interface IRunSessionGuards {
  maxInvocations?: number;
  timeoutMs?: number;
}

const EMIT_MAPPING_TOOL: LlmToolDef = {
  name: EMIT_MAPPING_TOOL_NAME,
  description:
    'Conclui a sessão emitindo o ValidatedMappingConfig final e o rationale. Chame UMA vez.',
  parameters: {
    type: 'object',
    properties: {
      mapping: { type: 'object' },
      rationale: { type: 'string' },
      previewRows: { type: 'array', items: { type: 'object' } },
    },
    required: ['mapping', 'rationale'],
  },
};

@Injectable()
export class AiSetupOrchestratorService {
  constructor(
    @Inject(LLM_CLIENT) private readonly llm: LlmClient,
    @Inject(LLM_MODEL) private readonly model: string,
    @Inject(LLM_MAX_TOKENS) private readonly maxTokens: number,
    private readonly bridge: AiSessionConnectorBridge,
    private readonly translator: CatalogToToolsTranslator,
    private readonly provisioning: AiSetupProvisioningService,
  ) {}

  async runSession(input: IRunSessionInput, guards: IRunSessionGuards = {}): Promise<void> {
    const maxInvocations = guards.maxInvocations ?? AI_SESSION_MAX_INVOCATIONS;
    const timeoutMs = guards.timeoutMs ?? AI_SESSION_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;

    const tools: LlmToolDef[] = [...this.translator.translate(input.catalog), EMIT_MAPPING_TOOL];
    const messages: LlmMessage[] = [
      {
        role: 'user',
        content:
          'Inicie o setup: descubra o banco, valide credenciais, inspecione o schema e proponha o mapping.',
      },
    ];

    let invocations = 0;

    for (;;) {
      if (Date.now() > deadline) {
        throw new InternalException(`Timeout de sessão excedido (${timeoutMs}ms)`);
      }

      const turn = await this.llm.createTurn({
        system: AI_SETUP_SYSTEM_PROMPT,
        tools,
        messages,
        maxTokens: this.maxTokens,
      });

      if (turn.stop === 'end' || turn.toolCalls.length === 0) {
        throw new InternalException('Sessão encerrou sem propor mapping');
      }

      messages.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls });

      const emitCall = turn.toolCalls.find((c) => c.name === EMIT_MAPPING_TOOL_NAME);
      if (emitCall) {
        this.emitMapping(input, emitCall.arguments);
        return;
      }

      for (const call of turn.toolCalls) {
        if (invocations >= maxInvocations) {
          throw new InternalException(`Limite de invocações por sessão excedido (${maxInvocations})`);
        }
        invocations += 1;

        // Interceptação do sinal de provisionamento (NÃO vai ao bridge.invokeTool):
        // pausa o loop, propõe ao painel e aguarda a decisão; o resultado volta
        // como mensagem neutra role:'tool'.
        if (call.name === PROPOSE_READONLY_USER_TOOL_NAME) {
          const signalResult = await this.handleProposeReadonlyUser(
            input,
            call.arguments as Record<string, unknown>,
          );
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: JSON.stringify(signalResult),
          });
          continue;
        }

        const result = await this.bridge.invokeTool(input.connectorId, input.sessionId, call.name, call.arguments);

        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: JSON.stringify(result.ok ? (result.payload ?? {}) : { errorCode: result.errorCode }),
        });
      }
    }
  }

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
      {
        module: MODULE,
        action: 'ai_setup_provision_proposed',
        sessionId: input.sessionId,
        username,
      },
      'Sinal propose_readonly_user recebido; pausando o loop até a decisão',
    );

    const signalResult = await this.provisioning.proposeAndAwait({
      connectorId: input.connectorId,
      sessionId: input.sessionId,
      username,
      engine,
      ...(rationale === undefined ? {} : { rationale }),
    });

    // Sai da fase 'provisioning' após a decisão: provisionado segue para o
    // schema; sem provisão (reject/fallback/erro) volta à descoberta e segue
    // a inspeção com a credencial descoberta.
    this.bridge.emitSessionState(input.connectorId, {
      type: AI_SESSION_STATE_MESSAGE_TYPE,
      sessionId: input.sessionId,
      phase: signalResult.provisioned ? 'schema' : 'discovering',
    });

    return signalResult;
  }

  private emitMapping(input: IRunSessionInput, emitArgs: unknown): void {
    const args = (typeof emitArgs === 'object' && emitArgs !== null ? emitArgs : {}) as Record<string, unknown>;
    const validation = validateCatalogMapping(args.mapping);
    if (!validation.ok) {
      throw new InternalException(`emit_mapping inválido: ${validation.error}`);
    }
    const rationale = typeof args.rationale === 'string' ? args.rationale : '';
    const previewRows = Array.isArray(args.previewRows) ? (args.previewRows as Record<string, unknown>[]) : [];

    this.bridge.emitMappingProposed(input.connectorId, {
      type: 'mapping.proposed',
      sessionId: input.sessionId,
      mapping: validation.mapping as IConnectorCatalogMappingConfig,
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

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm run vitest:unit src/modules/ai-setup/services/ai-setup-orchestrator.service.test.ts`
Expected: PASS (8 testes — 6 neutros + 2 de provisionamento).

- [ ] **Step 5: Commit**

```bash
git add src/modules/ai-setup/services/ai-setup-orchestrator.service.ts src/modules/ai-setup/services/ai-setup-orchestrator.service.test.ts
git commit -m "refactor(ai-setup): loop agentic neutro preservando provisionamento read-only

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> **Mudança de comportamento (do spec):** antes, fim sem mapping retornava silencioso; agora lança `InternalException` → o `AiSetupFacade` já captura erros do `runSession` e marca a sessão como `failed` (não precisa alterar a facade).

---

## Task 9: Wiring do módulo (DI da factory)

**Files:**
- Modify: `src/modules/ai-setup/ai-setup.module.ts`
- Test: `src/modules/ai-setup/ai-setup.module.test.ts` (Create)

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/modules/ai-setup/ai-setup.module.test.ts
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

vi.mock('openai', () => ({ default: class { constructor(_: unknown) {} chat = { completions: { create: vi.fn() } }; } }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { constructor(_: unknown) {} messages = { create: vi.fn() }; } }));

import { LLM_CLIENT, LLM_MAX_TOKENS, LLM_MODEL } from './interfaces/llm-client.interface';
import { DeepSeekLlmClient } from './services/deepseek-llm.client';
import { llmClientProviders } from './ai-setup.module';

describe('Teste Unitário: ai-setup-module-llm-providers', () => {
  it('provê LLM_CLIENT (deepseek default), LLM_MODEL e LLM_MAX_TOKENS via ConfigService', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: ConfigService, useValue: { get: (k: string) => ({ DEEPSEEK_API_KEY: 'sk-d' } as Record<string, string>)[k] } },
        ...llmClientProviders,
      ],
    }).compile();

    expect(moduleRef.get(LLM_CLIENT)).toBeInstanceOf(DeepSeekLlmClient);
    expect(moduleRef.get(LLM_MODEL)).toBe('deepseek-v4-flash');
    expect(moduleRef.get(LLM_MAX_TOKENS)).toBe(8192);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm run vitest:unit src/modules/ai-setup/ai-setup.module.test.ts`
Expected: FAIL — `llmClientProviders` não exportado.

- [ ] **Step 3: Editar o módulo**

Troque **apenas** o wiring do LLM: remova o `AnthropicMessagesClient` e o provider
`{ provide: ANTHROPIC_MESSAGES_CLIENT, useExisting: ... }`, e adicione `...llmClientProviders`.
**PRESERVE** todos os demais providers existentes — em especial `AiSetupProvisioningService`,
que a feature de provisionamento read-only adicionou e que o orquestrador agora resolve por
DI (6ª dependência). NestJS injeta o `AiSetupProvisioningService` por tipo (classe), então
basta mantê-lo na lista. O arquivo passa a:

```ts
// src/modules/ai-setup/ai-setup.module.ts
import { AgentIdentitiesModule } from '@modules/agent-identities/agent-identities.module';
import { Module, type Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { RedisModule } from '@/common/redis/redis.module';

import { AiSetupWiring } from './ai-setup.wiring';
import { AiSetupController } from './controllers/ai-setup.controller';
import { AiSessionConnectorBridge } from './gateways/ai-session-connector-bridge';
import { AiSetupGateway } from './gateways/ai-setup.gateway';
import { AI_SETUP_MAX_TOKENS, AI_SETUP_MAX_TOKENS_ENV } from './constants/ai-setup-orchestrator.constants';
import { LLM_CLIENT, LLM_MAX_TOKENS, LLM_MODEL } from './interfaces/llm-client.interface';
import { AiSetupFacade } from './services/ai-setup.facade';
import { AiSetupOrchestratorService } from './services/ai-setup-orchestrator.service';
import { AiSetupProvisioningService } from './services/ai-setup-provisioning.service';
import { AiSetupSessionRegistry } from './services/ai-setup-session.registry';
import { CatalogToToolsTranslator } from './services/catalog-to-tools.translator';
import { createLlmClient, resolveLlmModel } from './services/llm-client.factory';

export const llmClientProviders: Provider[] = [
  { provide: LLM_CLIENT, useFactory: (config: ConfigService) => createLlmClient(config), inject: [ConfigService] },
  { provide: LLM_MODEL, useFactory: (config: ConfigService) => resolveLlmModel(config), inject: [ConfigService] },
  {
    provide: LLM_MAX_TOKENS,
    useFactory: (config: ConfigService) => Number(config.get(AI_SETUP_MAX_TOKENS_ENV)) || AI_SETUP_MAX_TOKENS,
    inject: [ConfigService],
  },
];

@Module({
  imports: [ConfigModule, RedisModule, AgentIdentitiesModule],
  controllers: [AiSetupController],
  providers: [
    AiSessionConnectorBridge,
    CatalogToToolsTranslator,
    AiSetupSessionRegistry,
    AiSetupOrchestratorService,
    AiSetupProvisioningService,
    AiSetupFacade,
    AiSetupGateway,
    AiSetupWiring,
    ...llmClientProviders,
  ],
  exports: [AiSetupFacade],
})
export class AiSetupModule {}
```

> **Reconciliação (provisionamento):** `AiSetupProvisioningService` PERMANECE na lista de
> providers — não é um símbolo do LLM e não deve ser removido junto do client antigo. O
> orquestrador agora tem 6 deps (`LLM_CLIENT` + `LLM_MODEL` + `LLM_MAX_TOKENS` via tokens,
> `AiSessionConnectorBridge` + `CatalogToToolsTranslator` + `AiSetupProvisioningService` por
> tipo). O teste do módulo (Step 1) cobre só o wiring do LLM; o wiring do provisioning é
> coberto pelo int test (Task 10).

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm run vitest:unit src/modules/ai-setup/ai-setup.module.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/ai-setup/ai-setup.module.ts src/modules/ai-setup/ai-setup.module.test.ts
git commit -m "feat(ai-setup): DI do LLM_CLIENT/LLM_MODEL via factory de provider

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Ajustar o int test, README, .env.example e fechar o gate

**Files:**
- Modify: `src/modules/ai-setup/tests/ai-setup.int.test.ts`
- Modify: `src/modules/ai-setup/README.md`
- Modify: `.env.example`

- [ ] **Step 1: Atualizar o int test para o client neutro (preservando os testes de provisionamento)**

> **⚠️ RECONCILIAÇÃO (provisionamento):** este int test contém testes de provisionamento
> read-only (approve / reject / fallback_no_privilege) que a feature mergeada adicionou.
> Eles **devem ser preservados e adaptados** — NÃO removidos. Hoje esses testes dirigem o
> provisionamento **direto** via `provisioning.proposeAndAwait(...)` (não pelo loop do LLM),
> então a única mudança obrigatória neles é o **override do LLM**: o int test não pode mais
> referenciar `ANTHROPIC_MESSAGES_CLIENT` (client deletado na Task 4). Troque o override do
> stub Anthropic pelo stub neutro abaixo. Os asserts de `provision.proposed`/`provision.result`
> e os payloads `{ provisioned, activeCredential, reason }` ficam **idênticos**.

**1a. Trocar o stub e os imports.** Remova `import { ANTHROPIC_MESSAGES_CLIENT } from '@modules/ai-setup/services/anthropic-messages.client';` e o stub `llmStub` com `createMessage`. Adicione:

```ts
import { LLM_CLIENT, LLM_MAX_TOKENS, LLM_MODEL } from '@modules/ai-setup/interfaces/llm-client.interface';
import type { LlmTurn } from '@modules/ai-setup/interfaces/llm-client.interface';

// Stub neutro do LlmClient: determinístico, nunca chama API real.
// Por padrão encerra o loop (stop:'end'); cada teste pode reprogramar `nextTurns`
// para dirigir o loop (ex.: emitir propose_readonly_user e depois encerrar).
const llmStub = {
  nextTurns: [] as LlmTurn[],
  async createTurn(): Promise<LlmTurn> {
    return this.nextTurns.shift() ?? { text: null, toolCalls: [], stop: 'end' };
  },
};
```

**1b. Trocar o override no `Test.createTestingModule`.** Substitua:

```ts
.overrideProvider(ANTHROPIC_MESSAGES_CLIENT)
.useValue(llmStub)
```

por três overrides dos tokens neutros:

```ts
.overrideProvider(LLM_CLIENT)
.useValue(llmStub)
.overrideProvider(LLM_MODEL)
.useValue('deepseek-v4-flash')
.overrideProvider(LLM_MAX_TOKENS)
.useValue(8192)
```

Mantenha o restante do teste idêntico: o relé do gateway (`audit.event`, `mapping.decision`)
e os três testes de provisionamento (approve/reject/fallback) continuam dirigindo
`provisioning.proposeAndAwait(...)` diretamente e validando `provision.proposed`/`provision.result`.

> **Loop dirigindo `propose_readonly_user` (opcional, se algum teste optar por exercitar o
> fluxo ponta-a-ponta pelo orquestrador):** como o stub neutro suporta `nextTurns`, basta
> empilhar um turno com `toolCalls:[{ id:'p1', name:'propose_readonly_user', arguments:{ username:'ro_user' } }]`,
> `stop:'tool_calls'`, seguido de um turno `{ text:null, toolCalls:[], stop:'end' }` (ou de erro,
> conforme o caso). Isso faz o orquestrador chamar `handleProposeReadonlyUser` → emitir a fase
> `provisioning` e `provisioning.proposeAndAwait`, exatamente como o teste unitário da Task 8.
> Os testes existentes NÃO precisam migrar para esse formato — manter o disparo direto é
> suficiente e mais estável; o `nextTurns` fica disponível caso se queira cobrir o end-to-end.

> Como `stop:'end'` agora lança no `runSession`, e o `AiSetupFacade.handleCatalog` captura o erro e marca `failed`, o int test que valida o **relé do gateway** (não o sucesso do loop) segue válido — ajuste qualquer assert que dependa de a sessão NÃO falhar para, em vez disso, disparar um `audit.event`/`mapping.proposed` manual pelo bridge (como o teste já faz para exercitar o relé), não pelo loop.

- [ ] **Step 2: Rodar o int test**

Run: `pnpm run vitest:integration src/modules/ai-setup/tests/ai-setup.int.test.ts`
Expected: PASS (a infra de integração precisa estar de pé; se indisponível, registre e siga — não provisione infra).

- [ ] **Step 3: Atualizar o README do módulo**

Edite `src/modules/ai-setup/README.md` adicionando uma seção **Providers de LLM**:

```markdown
## Providers de LLM

O orquestrador é multi-provider via interface neutra `LlmClient`. Selecionado por env:

- `AI_SETUP_LLM_PROVIDER` = `deepseek` (default) | `anthropic`
- DeepSeek (default): `DEEPSEEK_API_KEY`, `AI_SETUP_DEEPSEEK_MODEL` (default `deepseek-v4-flash`),
  `AI_SETUP_DEEPSEEK_BASE_URL` (default `https://api.deepseek.com`) — via SDK `openai`.
- Anthropic (opt-in): `ANTHROPIC_API_KEY`, `AI_SETUP_ANTHROPIC_MODEL` (default `claude-opus-4-8`).
- Comum: `AI_SETUP_MAX_TOKENS` (default 8192).

O boot faz fail-fast se a key do provider selecionado estiver ausente. O `emit_mapping` é
validado contra o `IConnectorCatalogMappingConfig`; mapping inválido ou ausente → sessão `failed`.
```

- [ ] **Step 4: Documentar as envs no `.env.example`**

Adicione ao final de `.env.example` (raiz do repo):

```bash
# --- Setup dirigido por IA (módulo ai-setup) ---
AI_SETUP_LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=
AI_SETUP_DEEPSEEK_MODEL=deepseek-v4-flash
AI_SETUP_DEEPSEEK_BASE_URL=https://api.deepseek.com
ANTHROPIC_API_KEY=
AI_SETUP_ANTHROPIC_MODEL=claude-opus-4-8
AI_SETUP_MAX_TOKENS=8192
```

- [ ] **Step 5: Rodar o gate completo do módulo**

```bash
pnpm run vitest:unit src/modules/ai-setup
pnpm run quality-gate:fast
```
Expected: unit do módulo verde; `Quality Gate: APROVADO`.

- [ ] **Step 6: Commit**

```bash
git add src/modules/ai-setup/tests/ai-setup.int.test.ts src/modules/ai-setup/README.md .env.example
git commit -m "test(ai-setup): int test no client neutro preservando provisionamento + docs de providers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (preenchido)

**1. Cobertura do spec:**
- Interface neutra → Task 1. DeepSeek client → Task 3. Anthropic client → Task 4. Factory/env/fail-fast → Tasks 2,5. Loop neutro → Task 8. emit_mapping validar→falhar → Tasks 6,8. Fim sem mapping → falha → Task 8. Tradução por client (coalescing/cache_control/function-calling) → Tasks 3,4. Config/env → Tasks 2,10. Erros normalizados → coberto pelo fail-fast (Task 5) e InternalException no loop (Task 8); a normalização fina de erros de rede do client (`rate_limit`/`timeout`) é tratada como propagação de exceção → `failed` na facade (suficiente p/ o spec; sem código dedicado por não haver requisito de UI por código de erro). Tests → todas as tasks. quality-gate/README → Task 10.
- **Gap fechado:** o spec menciona normalizar `auth/rate_limit/timeout/unavailable/unknown`; como não há requisito de comportamento diferenciado por código (todos levam a `failed`), o plano propaga a exceção do SDK e deixa a facade marcar `failed`. Se for desejado granular, é incremento futuro — registrado aqui, não silenciado.

**2. Placeholders:** nenhum "TBD/TODO"; todo step tem código/here-doc/commando reais.

**3. Consistência de tipos:** `LlmClient.createTurn`/`LlmTurn`/`LlmToolDef`/`LlmMessage` idênticos entre Tasks 1,3,4,7,8. Construtor do orquestrador (`LLM_CLIENT, LLM_MODEL, LLM_MAX_TOKENS, bridge, translator, provisioning`) bate com o teste da Task 8 e com o DI da Task 9. `createLlmClient(config, model?)` consistente entre Tasks 5 e 9. `validateCatalogMapping` (Task 6) usado na Task 8.

**4. Reconciliação com o provisionamento read-only:** este plano foi escrito ANTES da feature de provisionamento read-only ser mergeada na mesma branch, que alterou orquestrador, módulo e int test. As Tasks 8/9/10 foram reconciliadas para **preservar** essa lógica:
- **Task 8** — o orquestrador neutro mantém a 6ª dep `AiSetupProvisioningService`, o `engine?` em `IRunSessionInput`, os imports de `AI_SESSION_STATE_MESSAGE_TYPE`/`PROPOSE_READONLY_USER_TOOL_NAME`/`IProvisionSignalToolResult`/`AiSetupProvisioningService`, a interceptação `if (call.name === PROPOSE_READONLY_USER_TOOL_NAME)` antes do `bridge.invokeTool` (empilhando o sinal como `role:'tool'` + `continue`) e o método `handleProposeReadonlyUser` idêntico (fase `provisioning` → `proposeAndAwait` → fase `schema`/`discovering`). O teste ganhou 2 casos neutros de provisionamento (provisionado→schema; não provisionado→discovering) além dos 6 neutros.
- **Task 9** — `AiSetupProvisioningService` PERMANECE na lista de providers do módulo (não é símbolo de LLM); o orquestrador resolve as 6 deps por DI (3 tokens LLM_* + bridge + translator + provisioning por tipo).
- **Task 10** — os três testes de provisionamento do int test (approve/reject/fallback) são **preservados e adaptados**, não removidos: a única mudança obrigatória é trocar o override `ANTHROPIC_MESSAGES_CLIENT` (client deletado) pelos overrides neutros `LLM_CLIENT`/`LLM_MODEL`/`LLM_MAX_TOKENS`; o stub neutro suporta `nextTurns` para, se desejado, dirigir o loop a emitir `propose_readonly_user` ponta-a-ponta.

---

## Execução

Plano neo-only. Sugestão: **subagent-driven** (um subagente por task, com revisão), seguindo o `guard`/quality-gate antes de cada commit. Ao final, atualizar a PR existente do neo (#356) com os novos commits ou abrir PR dedicada, conforme orientação.
