# Redesign do fluxo de setup do conector dirigido por IA

- **Data:** 2026-06-09
- **Frente:** feat-pharma-agent-v2 (repos: `neo-api-pharmachatbot`, `pharma-agent-v2`, `web-pharmachatbot`)
- **Branch:** `feat/pharma-agent-v2`
- **Status:** aprovado (brainstorming) — pendente plano de implementação

## Problema

O setup do conector dirigido por IA (ai-setup) ficou instável em uso real. A IA
**dirige livremente** o loop de tool-calling e desperdiça as chamadas em probes
redundantes (`probe.network` ×10, `probe.test_connection` ×8, `fs.readConfigFile`
×N), sem chegar a `schema.describeTable`/`sampleRows`. Quando é forçada a concluir,
**não tem dados pra montar o `fields`** do mapping. Em volta disso, vários bugs:
loop sem convergência, `emit_mapping` inválido, sessões concorrentes/zumbis no
mesmo connector, ausência de reset da config anterior, reflexo incompleto na UI e
divergência entre o badge "conectado" (DB `last_seen_at`) e o mapa vivo de sockets
que o setup exige (erro `Connector ... is not connected` / 409).

### Inventário de bugs (escopo)

| # | Issue | Situação no início do redesign |
|---|---|---|
| 1 | Nome de tool com `.` rejeitado pela API DeepSeek (OpenAI-compat) | corrigido (sanitização no client) |
| 2 | Loop de convergência — IA repete probes, não progride | contido (anti-repetição + forcing), não resolvido na raiz |
| 3 | `emit_mapping` incompleto — `mappingVersion` ausente (corrigido via auto-fill); depois `fields` ausente | parcial |
| 4 | Sessões concorrentes/zumbis no mesmo connector | aberto |
| 5 | Sem reset da config/poller antigo ao iniciar | aberto |
| 6 | Reflexo na UI — `failed` (corrigido), label `provisioning`, reconexão, ordem dos cards | parcial |
| 7 | 409 / presença viva (badge `last_seen_at` mente vs mapa vivo) | aberto |
| 8 | Agente nem sempre responde `tool.invoke` (rejeição engolida por `void`) → timeout 30s no neo | aberto |

## Decisões (brainstorming)

1. **Arquitetura: híbrida.** Descoberta determinística conduzida pelo orquestrador;
   a IA é usada **apenas** no passo de match (schema↔campos + query).
2. **Descoberta: completa sempre.** Sequência fixa engine → credenciais →
   (provisionamento RO, human-gated) → schema, mesmo quando já há conexão ativa
   (uniformiza o fluxo e cobre instalação do zero).
3. **Reset: pausar no início, substituir só ao aplicar.** Ao iniciar a sessão o
   agente **pausa o poller** mas **não apaga** o mapping; o novo só substitui o
   antigo ao ser **aprovado**. Abort/falha → retoma o poller com o mapping anterior.
4. **Concorrência: uma sessão ativa por connector.** Nova sessão **aborta a anterior**.
5. **Escopo: uma spec só**, cobrindo neo + agente + web, incluindo 409/presença viva.

## Arquitetura do novo fluxo

O `AiSetupOrchestratorService` deixa de ser um loop de IA livre e vira uma
**máquina de estados determinística**. Cada fase emite `ai.session.state` (com
`detail` quando útil) e `audit.event` por tool, refletindo o avanço na UI.

| Fase | Conduz | Ações | Reflexo na UI |
|---|---|---|---|
| `discovering` | orquestrador | `probe.engines` (+`processes`/`connections`/`odbc_dsns` conforme necessário) → seleciona engine(s) viáveis | state + audit por tool |
| `credentials` | orquestrador | `probe.scan_config_dirs` → `fs.readConfigFile`/`registry.readKey` → `probe.test_connection`; usa a 1ª credencial que conecta | state + audit |
| `provisioning` | orquestrador (human-gated) | propõe usuário read-only → aguarda decisão → provisiona (fluxo existente) | state + ProvisionApprovalCard |
| `schema` | orquestrador | `schema.listTables` → seleciona tabelas candidatas (heurística nome ~ produto/product) → `describeTable` + `sampleRows` nas candidatas | state + audit |
| `proposing` | **LLM (mini-loop ≤4 turnos)** | recebe schema+amostras + **schema exato do `emit_mapping`**; pode pedir mais `schema.describeTable`/`schema.sampleRows`/`sql.runReadOnlySelect` (**toolset restrito — sem `probe.*`/`fs`/`registry`**), depois **obrigatoriamente** `emit_mapping` | state + MappingApprovalCard |
| `applying` → `synced` | agente | aplica o mapping aprovado e persiste | state |

**Por que mata o churn:** na fase de match o LLM não tem acesso aos `probe.*`
(só `schema.*`/`sql.runReadOnlySelect`) e tem orçamento curto de turnos. Os guards
já implementados (anti-repetição por `(tool,args)`, convergência forçada,
instrumentação `ai_setup_tool_call`) permanecem como rede de segurança.

### Seleção determinística (políticas)

- **Engine:** considerar candidatos retornados por `probe.engines`; seguir com os
  que passam em `probe.test_connection`. Se já houver conexão ativa do connector,
  ela é um candidato válido.
- **Credencial:** primeira que conecta (`probe.test_connection.ok`).
- **Tabela de produto:** heurística por nome (`produto`/`product`); na ausência de
  match óbvio, todas as candidatas com colunas plausíveis são amostradas e
  entregues ao match para a IA decidir.
- Ambiguidades não resolvidas pela heurística são **delegadas ao passo de match**
  (a IA escolhe entre as candidatas já amostradas) — nunca a um loop de probes.

## Ciclo de sessão & concorrência

- **Registry indexado por `connectorId`** → no máximo uma sessão ativa por connector.
- **Nova sessão aborta a anterior:** `startSession` sinaliza o `AbortSignal` da
  sessão vigente daquele connector antes de registrar a nova; o orquestrador
  verifica o sinal em cada checkpoint (antes de cada tool/turno) e encerra limpo.
- **Estados terminais sempre emitem** `ai.session.state` à UI (`synced`/`failed`/
  `aborted`/`timeout`) e removem a sessão do registry. (`failed` no catch do facade
  já implementado.)
- **Timeout duro** por sessão envolve todas as fases.

## Reset & robustez do agente (`pharma-agent-v2`)

- Ao receber `ai.session.start`, o agente **pausa o poller** (`pausePolling`,
  como em `handleConfig`) e guarda o mapping ativo anterior em memória. **Não apaga**
  `connector-state.json`.
- Ao **aprovar** o mapping (`applyApproval`): ativa e persiste o novo (substitui).
- Em **abort/falha/encerramento sem aplicar**: **retoma o poller** com o mapping
  anterior.
- **#8 — agente sempre responde `tool.invoke`:** `AiSession.invokeTool` envolve a
  execução em `try/catch` e **sempre emite `tool.result`** (erro em caso de exceção),
  com **timeout próprio por tool** no agente. Assim o neo nunca pendura 30s. O
  call-site em `runtime.ts` (`void manager.onToolInvoke`) deixa de engolir a falha
  silenciosamente.

## Convergência do mapping

- **`emit_mapping`:** o servidor preenche `mappingVersion` (já implementado) e
  defaults de `pollIntervalMs`/`batchSize` quando ausentes. O passo de match recebe
  os campos obrigatórios do `ValidatedMappingConfig` e as **colunas amostradas**,
  então consegue produzir `fields`/query.
- Inválido após o mini-loop → **falha graciosa** com o motivo específico (já emite
  `failed` à UI).

## UI (`web-pharmachatbot`)

- **Reflexo por fase:** cada transição determinística emite `ai.session.state`
  (progresso granular) além dos `audit.event` por tool (timeline acumula, de-dupe
  por `seq`, ordena por `seq` — já existente).
- **Label `provisioning`** em `translation/languages/ptBr.ts` (hoje ausente → badge
  mostra a chave crua).
- **Reconexão:** tratar `disconnect`/`connect_error` (mostrar "conexão perdida /
  reconectando") e **re-emitir `joinCompany`** ao reconectar (hoje só no
  `startSession` → eventos perdidos após queda).
- **Ordem dos cards:** exibição robusta a `mapping.proposed`/`provision.proposed`
  chegando antes/depois da transição de fase.
- **Render de `failed`/`aborted`** com `detail`.

## 409 / presença viva (neo + web)

- `AgentConnectorWebSocketAdapter` expõe `isConnectorConnected(connectorId)` lendo
  o mapa vivo `connectedSockets`.
- **Readiness/badge** passa a exigir **socket vivo** (não apenas `last_seen_at` ≤ 2min),
  eliminando o falso "conectado".
- **`startSession` pré-checa presença viva** e, na ausência, retorna um resultado
  **tipado e amigável** (`AGENT_NOT_CONNECTED`) — não a `ConflictException` crua que
  vaza como erro. A UI **desabilita "Iniciar setup por IA"** enquanto o agente não
  estiver realmente conectado e mostra mensagem clara.

## Rastreabilidade (bug → resolução)

| Bug | Resolvido por |
|---|---|
| #2 loop / #3 mapping incompleto | match isolado com toolset restrito + orçamento + convergência do mapping |
| #4 sessões concorrentes | uma sessão/connector + abort da anterior |
| #5 reset | pausa/restaura no agente |
| #6 reflexo UI | state por fase + labels/reconexão/cards |
| #7 409/presença | mapa vivo como fonte de verdade + erro tipado + gating na UI |
| #8 agente sempre responde | `try/catch`+`tool.result`+timeout por tool |

## Base já implementada (neo)

Entram como fundação deste redesign (já com TDD, 120 testes verdes):
sanitização de nomes de tool no client DeepSeek; anti-repetição por `(tool,args)`;
convergência forçada após teto de exploração; `failed` emitido à UI no catch;
auto-fill de `mappingVersion`; instrumentação `ai_setup_tool_call`.

## Fases de implementação (todas via TDD)

1. **Neo** — máquina de estados determinística (discovering/credentials/
   provisioning/schema) + mini-loop de match com toolset restrito; ciclo de sessão
   (abort/uma-por-connector/timeout/estados terminais); presença viva (adapter +
   readiness + startSession tipado); convergência do mapping (defaults).
2. **Agente** — pausa/restaura poller no ciclo da sessão; `invokeTool` sempre
   responde + timeout por tool.
3. **Web** — reflexo por fase; label `provisioning`; reconexão + re-join; cards
   robustos; gating do botão por presença viva + mensagem amigável.

## Não-objetivos

- Trocar o modelo de LLM (ver `aisetup-nao-trocar-modelo`): o loop é estrutural,
  não de capacidade do modelo. A tarefa (tools pré-definidas + busca + match) é
  simples; um modelo leve dá conta com o fluxo determinístico.
- Auth de handshake do gateway socket.io (cross-tenant) permanece como pendência
  HIGH separada do review anterior — fora do escopo desta spec.

## Testes

TDD em cada unidade: máquina de estados (cada fase emite o state esperado e chama
as tools na ordem), abort/uma-por-connector, presença viva (gate + erro tipado),
convergência do mapping (defaults + match com toolset restrito), agente
(pausa/restaura + sempre-responde), web (labels/reconexão/cards/gating).
