# Provider de LLM multi-provider (DeepSeek default + Claude) — design

**Data:** 2026-06-03
**Frente:** feat-pharma-agent-v2
**Repo afetado:** `neo-api-pharmachatbot` (apenas — módulo `src/modules/ai-setup/`)
**Relacionado:** [setup dirigido por IA](2026-06-03-setup-dirigido-por-ia-design.md)

## Objetivo

Tornar o LLM do orquestrador de setup **plugável por provider**, com **DeepSeek (API direta)
como default** e **Claude (Anthropic) como alternativa por env**. Hoje o orquestrador está
acoplado à API de Mensagens da Anthropic (SDK, content blocks `tool_use`, `stop_reason`,
`tool_result`, `cache_control`). Este design extrai uma **interface neutra de LLM** e move o
loop agentic para tipos agnósticos, com duas implementações de client.

**Escopo:** neo-only, confinado a `src/modules/ai-setup/`. NÃO toca agente nem web. Gera 1 plano.

## Decisões (brainstorming)

| # | Decisão |
|---|---|
| 1 | Abordagem A: interface neutra `LlmClient` + implementações por provider. |
| 2 | Multi-provider: `deepseek` (default) e `anthropic`, selecionados por `AI_SETUP_LLM_PROVIDER`. |
| 3 | DeepSeek via API direta `api.deepseek.com` (OpenAI-compatible, SDK `openai`); default model `deepseek-v4-flash`. |
| 4 | Anthropic via `@anthropic-ai/sdk` (já instalado); default model `claude-opus-4-8`. |
| 5 | `emit_mapping`: validar contra o schema; se inválido/ausente/guarda estourada → `failed`. **Sem retry, sem fallback.** |
| 6 | API key nunca logada; fail-fast no boot se a key do provider selecionado faltar. |

## Arquitetura

Tudo dentro de `src/modules/ai-setup/`. O loop agentic deixa de conhecer qualquer SDK e fala a
interface neutra; cada client traduz neutro ↔ formato do provider.

### Contrato interno — interface neutra (`interfaces/llm-client.interface.ts`)

```ts
export const LLM_CLIENT = Symbol('LLM_CLIENT');

export interface LlmToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema do input
}

export interface LlmToolCall {
  id: string;        // id da tool call (correlaciona com a resposta)
  name: string;
  arguments: unknown; // JÁ parseado de JSON para objeto
}

export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface LlmTurn {
  text: string | null;          // texto do assistant, se houver
  toolCalls: LlmToolCall[];     // [] quando não há tool calls
  stop: 'tool_calls' | 'end';   // 'tool_calls' quando há toolCalls a executar
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

### Componentes

| Arquivo | Responsabilidade |
|---|---|
| `interfaces/llm-client.interface.ts` | tipos neutros + token DI `LLM_CLIENT` |
| `services/deepseek-llm.client.ts` | `DeepSeekLlmClient implements LlmClient` — SDK `openai` (`baseURL` DeepSeek); traduz neutro↔OpenAI |
| `services/anthropic-llm.client.ts` | `AnthropicLlmClient implements LlmClient` — refatora o `AnthropicMessagesClient` atual; traduz neutro↔Anthropic + `cache_control` |
| `services/llm-client.factory.ts` | resolve provider por env, provê `LLM_CLIENT` e expõe `resolveModel()`/`resolveMaxTokens()`; fail-fast |
| `services/catalog-to-tools.translator.ts` | passa a produzir `LlmToolDef[]` (neutro); cada client converte ao seu formato |
| `services/ai-setup-orchestrator.service.ts` | loop agentic em tipos neutros + validação `emit_mapping` |
| `constants/ai-setup-orchestrator.constants.ts` | envs/defaults de provider e modelo |
| `ai-setup.module.ts` | binding `{ provide: LLM_CLIENT, useFactory }` |
| `README.md` | documenta os providers e envs |

### Tradução por client

**DeepSeek/OpenAI (`DeepSeekLlmClient`):**
- `tools` → `[{ type: 'function', function: { name, description, parameters } }]`.
- mensagens neutras → OpenAI: `assistant` com `tool_calls: [{ id, type:'function', function:{ name, arguments: JSON.stringify(args) } }]`; `tool` → `{ role:'tool', tool_call_id, content }`; `system`/`user` diretos.
- resposta: `choices[0].message`; `finish_reason === 'tool_calls'` ⇒ `stop:'tool_calls'`; `toolCalls` de `message.tool_calls` com `arguments` via `JSON.parse`; `text` de `message.content`.
- client: `new OpenAI({ apiKey: DEEPSEEK_API_KEY, baseURL: AI_SETUP_DEEPSEEK_BASE_URL })`.

**Anthropic (`AnthropicLlmClient`):**
- `tools` → `[{ name, description, input_schema: parameters }]`.
- mensagens neutras → Anthropic: `system` separado (com `cache_control: { type:'ephemeral' }`); `assistant` → content blocks (text + `tool_use{ id, name, input: args }`); **coalesce** mensagens `tool` consecutivas num único `user` com blocos `tool_result{ tool_use_id, content }`.
- resposta: `content` blocks; `stop_reason === 'tool_use'` ⇒ `stop:'tool_calls'`; `toolCalls` dos blocos `tool_use`; `text` dos blocos `text`.

## Fluxo do loop (orquestrador, tipos neutros)

```
monta messages = [system, user-inicial]
loop:
  turn = llmClient.createTurn({ system, tools, messages, maxTokens })
  se turn.stop === 'end' e nunca chamou emit_mapping  -> FAILED ("sem mapping")
  para cada toolCall em turn.toolCalls:
     se name === 'emit_mapping':
        valida arguments vs IConnectorCatalogMappingConfig
          válido   -> mapping.proposed (fluxo de aprovação existente) e ENCERRA
          inválido -> FAILED (motivo da validação)
     senão:
        result = bridge.invokeTool(name, arguments)   // tool.invoke -> tool.result
        anexa assistant{toolCalls} + tool{toolCallId, content: JSON.stringify(result)}
  guardas anti-runaway (AI_SESSION_MAX_INVOCATIONS=60, AI_SESSION_TIMEOUT_MS=300000) -> FAILED se estourar
```

## Configuração (env)

```
AI_SETUP_LLM_PROVIDER=deepseek            # default; ou: anthropic
# DeepSeek (default)
DEEPSEEK_API_KEY=sk-...
AI_SETUP_DEEPSEEK_MODEL=deepseek-v4-flash         # default
AI_SETUP_DEEPSEEK_BASE_URL=https://api.deepseek.com   # default (override opcional)
# Anthropic (opt-in)
ANTHROPIC_API_KEY=sk-ant-...
AI_SETUP_ANTHROPIC_MODEL=claude-opus-4-8          # default
# comum
AI_SETUP_MAX_TOKENS=8192
```

A factory resolve o client conforme `AI_SETUP_LLM_PROVIDER` e o modelo default do provider
(sobrescrevível pela env do provider). **Fail-fast no boot:** se a key do provider selecionado
estiver ausente, lança exceção de config clara (não sobe meio-configurado).

## Erros

- Erros do client normalizados para o orquestrador: `auth` (401/403), `rate_limit` (429),
  `timeout`, `unavailable` (5xx), `unknown` → sessão `failed` com `errorCode` + mensagem
  **redigida**. **API key nunca logada.**
- `emit_mapping` inválido, `end` sem mapping, ou guarda anti-runaway estourada → `failed`.
- Exceções de domínio de `@/common/exceptions/` (sem `throw new Error()` — passa no quality-gate).

## Testes (vitest)

- **Mock neutro `LlmClient`** (turnos roteirizados) — reescreve os testes do orquestrador para
  tipos neutros (script de `toolCalls` → verifica `mapping.proposed` válido e a sequência de
  `tool.invoke`).
- **`DeepSeekLlmClient`:** mock do SDK `openai`; valida tradução neutro↔OpenAI (tools, tool_calls,
  role:tool, parse de arguments, finish_reason).
- **`AnthropicLlmClient`:** valida tradução neutro↔Anthropic, **coalescing** de `tool_result` e
  `cache_control` no system.
- **`llm-client.factory`:** seleciona por `AI_SETUP_LLM_PROVIDER`; fail-fast com key ausente.
- **`emit_mapping` inválido → `failed`**; `end` sem mapping → `failed`.
- **Integração** do gateway (relé) mantida, usando o mock neutro.
- `pnpm run quality-gate:fast` verde; `pnpm run vitest:unit`/`vitest:integration` verdes.

## Migração / impacto

- Adiciona dependência `openai` (`pnpm add openai`).
- `AnthropicMessagesClient` é **refatorado** em `AnthropicLlmClient` (mesma lógica de chamada +
  tradução neutro); o token DI `ANTHROPIC_MESSAGES_CLIENT` é substituído por `LLM_CLIENT`.
- O `catalog-to-tools.translator` passa a emitir `LlmToolDef[]` (neutro) em vez de `Anthropic.Tool[]`.
- Sem mudança de contrato WS/socket.io — agente e web não são afetados.

## Fora de escopo (vai para outro spec)

O **provisionamento de usuário read-only** (`CREATE USER` + `GRANT SELECT`, nova tool de escrita
no agente, aprovação no painel) é uma feature separada que toca os 3 repos — terá brainstorm e
spec próprios.
