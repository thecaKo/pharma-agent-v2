# Redesign do fluxo de setup por IA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar o setup do conector dirigido por IA confiável: descoberta determinística + IA só no match, sessão única por connector com abort, reset por pausa, agente que sempre responde, reflexo fiel na UI e presença viva como fonte de verdade.

**Architecture:** O `AiSetupOrchestratorService` vira máquina de estados determinística (discovering→credentials→provisioning→schema) conduzida pelo neo; só a fase `proposing` usa o LLM, com toolset restrito (schema/sql). Sessões são indexadas por connectorId com `AbortSignal`. O agente pausa/restaura o poller no ciclo da sessão e sempre devolve `tool.result`. A UI reflete cada fase e a presença viva passa a gatear o início.

**Tech Stack:** NestJS + vitest (neo); Node/TS + vitest (agente, `pharma-agent-v2`); React + vitest/RTL (web). Spec: `docs/superpowers/specs/2026-06-09-ai-setup-fluxo-redesign-design.md`.

**Base já commitada (neo):** anti-repetição, convergência forçada (`AI_SESSION_SOFT_INVOCATION_CAP`), `failed` emitido à UI, auto-fill de `mappingVersion`, instrumentação `ai_setup_tool_call`, sanitização de nomes de tool no DeepSeek client (commits `77642c5`, `d83a807`).

---

## File Structure

**neo-api-pharmachatbot** (`src/modules/ai-setup/`):
- `services/ai-setup-session.registry.ts` — registry por connectorId + AbortSignal (uma sessão/connector).
- `services/ai-setup-orchestrator.service.ts` — máquina de estados determinística + mini-loop de match.
- `services/ai-setup-discovery.service.ts` (NOVO) — passos determinísticos (engine/credenciais/schema) isolados e testáveis.
- `services/ai-setup.facade.ts` — abort da sessão anterior no start; estados terminais.
- `services/validate-catalog-mapping.ts` + `emitMapping` — defaults de `pollIntervalMs`/`batchSize`.
- `gateways/agent-connector-websocket.adapter.ts` — `isConnectorConnected(id)`.
- `modules/pharma-agent-catalog/services/readiness-overview.service.ts` — presença viva no readiness.
- `controllers/ai-setup.controller.ts` — pré-check de presença viva (`AGENT_NOT_CONNECTED`).

**pharma-agent-v2** (`src/`):
- `ai-session/ai-session.ts` — `invokeTool` sempre responde + timeout por tool.
- `service/runtime.ts` / `service/ai-session-manager.ts` — pausa/restaura poller no ciclo da sessão.

**web-pharmachatbot** (`src/pages/AgentConnectorPanel/`):
- `translation/languages/ptBr.ts` — label `provisioning`.
- `aiSetup/hooks/useAiSetupSession.ts` — disconnect/reconnect + re-join.
- `aiSetup/AiSetupSection.tsx` — cards robustos à ordem.
- `WorkspaceView.tsx` / readiness consumo — gating do botão por presença viva.

---

## FASE 1 — neo

### Task 1: Registry por connector + AbortSignal (uma sessão/connector)

**Files:**
- Modify: `src/modules/ai-setup/services/ai-setup-session.registry.ts`
- Test: `src/modules/ai-setup/services/ai-setup-session.registry.test.ts`

- [ ] **Step 1: Teste falhando** — `register` de uma 2ª sessão para o mesmo connectorId deve marcar a 1ª como abortada (seu `AbortSignal.aborted === true`) e indexar a nova como ativa; `getActiveByConnector(connectorId)` retorna a nova.
- [ ] **Step 2: Rodar** `npx vitest run src/modules/ai-setup/services/ai-setup-session.registry.test.ts` → FAIL.
- [ ] **Step 3: Implementar** — adicionar a cada sessão um `AbortController`; mapa `byConnector: Map<connectorId, sessionId>`; em `register`, se já houver sessão ativa para o connector, chamar `.abort()` dela e removê-la; expor `getSignal(sessionId)` e `getActiveByConnector`.
- [ ] **Step 4: Rodar** → PASS.
- [ ] **Step 5: Commit** `feat(ai-setup): registry aborta sessão anterior do mesmo connector`.

### Task 2: Orquestrador checa AbortSignal e encerra limpo

**Files:**
- Modify: `services/ai-setup-orchestrator.service.ts` (loop em `runSession`)
- Modify: `services/ai-setup.facade.ts` (passar o signal; abortar anterior no start)
- Test: `services/ai-setup-orchestrator.service.test.ts`

- [ ] **Step 1: Teste falhando** — `runSession` recebe um `signal` (AbortSignal); se `signal.aborted` no início de uma iteração, lança/encerra com estado `aborted` (não continua chamando tools). Teste: abortar após 1 tool → `bridge.invokeTool` não é chamado de novo e a sessão termina.
- [ ] **Step 2: Rodar** → FAIL.
- [ ] **Step 3: Implementar** — `runSession(input, guards, signal?)`; checar `signal?.aborted` no topo do `for(;;)` e antes de cada `invokeTool`; ao abortar, `return` (a facade emite `aborted`).
- [ ] **Step 4: Rodar** → PASS.
- [ ] **Step 5: Commit** `feat(ai-setup): orquestrador respeita AbortSignal da sessão`.

### Task 3: Serviço de descoberta determinística (engine/credenciais/schema)

**Files:**
- Create: `services/ai-setup-discovery.service.ts`
- Test: `services/ai-setup-discovery.service.test.ts`

Responsabilidade: dado o `bridge.invokeTool` (injeção) e o connectorId/sessionId, executar a sequência determinística e devolver `{ engine, schemaTables, describedTables, samples }`, emitindo `ai.session.state` por fase via `bridge.emitSessionState`.

- [ ] **Step 1: Teste falhando** — `discover()` chama, em ordem: `probe.engines` → seleciona 1º viável; `probe.scan_config_dirs`→`fs.readConfigFile`/`registry.readKey`→`probe.test_connection` (usa 1ª que conecta); `schema.listTables` → escolhe candidatas (nome ~ /produt|product/i) → `schema.describeTable`+`schema.sampleRows`. Emite `discovering`,`credentials`,`schema` na ordem. Mocka `invokeTool` retornando ok com payloads fixos; assere a ordem das tools e os states emitidos.
- [ ] **Step 2: Rodar** → FAIL.
- [ ] **Step 3: Implementar** o serviço (sem LLM). Política de seleção: engine = 1º de `engines` cujo `test_connection.ok`; tabela candidata = nomes que casam a regex, senão todas com colunas; amostrar até K candidatas.
- [ ] **Step 4: Rodar** → PASS.
- [ ] **Step 5: Commit** `feat(ai-setup): descoberta determinística (engine/credenciais/schema)`.

### Task 4: Mini-loop de match com toolset restrito

**Files:**
- Modify: `services/ai-setup-orchestrator.service.ts`
- Test: `services/ai-setup-orchestrator.service.test.ts`

- [ ] **Step 1: Teste falhando** — na fase de match, `createTurn` é chamado com `tools` contendo APENAS `schema.describeTable`, `schema.sampleRows`, `sql.runReadOnlySelect` e `emit_mapping` (nenhum `probe.*`/`fs`/`registry`). Orçamento de turnos ≤ `AI_SESSION_MATCH_MAX_TURNS` (novo, =4): excedido sem `emit_mapping` → `InternalException` (falha graciosa). Mocka `createTurn` retornando tool calls; assere o conjunto de nomes em `tools` e o limite.
- [ ] **Step 2: Rodar** → FAIL.
- [ ] **Step 3: Implementar** — após a descoberta (Task 3), montar a 1ª mensagem do match com o schema/amostras coletados + o schema do `emit_mapping`; restringir `tools` ao subconjunto; reusar anti-repetição/forcing; contar turnos do match.
- [ ] **Step 4: Rodar** → PASS.
- [ ] **Step 5: Commit** `feat(ai-setup): match isolado com toolset restrito e orçamento de turnos`.

### Task 5: Integrar descoberta + match em runSession; estados terminais

**Files:**
- Modify: `services/ai-setup-orchestrator.service.ts`, `services/ai-setup.facade.ts`
- Test: ambos os `.test.ts`

- [ ] **Step 1: Teste falhando** — fluxo feliz ponta-a-ponta (mockando discovery + match): emite `discovering`→`credentials`→`schema`→`proposing` e `mapping.proposed`. E: abort/timeout/erro emitem `aborted`/`failed` à UI (facade) e removem do registry.
- [ ] **Step 2: Rodar** → FAIL.
- [ ] **Step 3: Implementar** — `runSession` chama `discovery.discover()` e depois o match; facade abort-anterior no start; `aborted` emitido em `handleAbort` (state) e em abort por nova sessão.
- [ ] **Step 4: Rodar** → PASS.
- [ ] **Step 5: Commit** `feat(ai-setup): integra descoberta+match e reflete estados terminais`.

### Task 6: Defaults de mapping (pollIntervalMs/batchSize)

**Files:**
- Modify: `services/ai-setup-orchestrator.service.ts` (`emitMapping`)
- Test: `services/ai-setup-orchestrator.service.test.ts`

- [ ] **Step 1: Teste falhando** — `emit_mapping` sem `pollIntervalMs`/`batchSize` → orquestrador injeta defaults (ex.: 300000 / 500) antes de validar; proposta sai válida.
- [ ] **Step 2: Rodar** → FAIL.
- [ ] **Step 3: Implementar** defaults no `emitMapping` (junto do `mappingVersion` já existente).
- [ ] **Step 4: Rodar** → PASS.
- [ ] **Step 5: Commit** `feat(ai-setup): defaults de pollIntervalMs/batchSize no emit_mapping`.

### Task 7: Presença viva — adapter + readiness + pré-check no start

**Files:**
- Modify: `gateways/agent-connector-websocket.adapter.ts` (`isConnectorConnected`)
- Modify: `pharma-agent-catalog/services/readiness-overview.service.ts`
- Modify: `ai-setup/controllers/ai-setup.controller.ts` + `services/ai-setup.facade.ts`
- Test: cada `.test.ts` correspondente

- [ ] **Step 1: Teste falhando (adapter)** — `isConnectorConnected(id)` true só quando há socket OPEN no mapa; false caso contrário.
- [ ] **Step 2: Teste falhando (readiness)** — `isOnline` exige socket vivo E `last_seen` recente (não só `last_seen`).
- [ ] **Step 3: Teste falhando (start)** — `startSession` quando o connector não está vivo lança/retorna erro tipado `AGENT_NOT_CONNECTED` (não `ConflictException` crua).
- [ ] **Step 4: Rodar** os 3 → FAIL.
- [ ] **Step 5: Implementar** os 3 pontos.
- [ ] **Step 6: Rodar** → PASS.
- [ ] **Step 7: Commit** `feat(ai-setup): presença viva como fonte de verdade + erro tipado AGENT_NOT_CONNECTED`.

---

## FASE 2 — agente (`pharma-agent-v2`)

### Task 8: invokeTool sempre responde + timeout por tool

**Files:**
- Modify: `src/ai-session/ai-session.ts` (`invokeTool`)
- Test: `src/ai-session/ai-session.test.ts` (ou arquivo equivalente)

- [ ] **Step 1: Teste falhando** — quando `deps.handleAdminRequest` lança, `invokeTool` ainda emite um `tool.result` com `ok:false` (não fica sem resposta). E: se exceder um timeout por tool, emite `tool.result` de erro.
- [ ] **Step 2: Rodar** → FAIL.
- [ ] **Step 3: Implementar** — `try/catch` em volta da execução; `Promise.race` com timeout (`AI_TOOL_EXEC_TIMEOUT_MS`); sempre `emit(buildToolResultMessage(... ok:false, errorCode))` no catch/timeout.
- [ ] **Step 4: Rodar** → PASS.
- [ ] **Step 5: Commit** `fix(ai-session): invokeTool sempre responde tool.result (erro/timeout)`.

### Task 9: Pausa/restaura poller no ciclo da sessão

**Files:**
- Modify: `src/service/runtime.ts` (handlers de aiSessionStart/abort) e/ou `src/service/ai-session-manager.ts`
- Test: arquivo de teste do runtime/manager

- [ ] **Step 1: Teste falhando** — ao iniciar sessão de IA, o poller é pausado (`pausePolling` chamado) e o mapping atual é guardado; em abort/falha/fim-sem-aplicar, o poller é retomado com o mapping anterior; ao aplicar, o novo mapping substitui (fluxo existente de `applyApproval`).
- [ ] **Step 2: Rodar** → FAIL.
- [ ] **Step 3: Implementar** — no `onStart`: `pausePolling("ai session")` + snapshot do mapping ativo; no `onAbort`/`fail`/fim-sem-aplicar: `resumePolling`/reativar mapping anterior. NÃO apagar `connector-state.json`.
- [ ] **Step 4: Rodar** → PASS.
- [ ] **Step 5: Commit** `feat(ai-session): pausa o poller na sessão e restaura no abort`.

---

## FASE 3 — web (`web-pharmachatbot`)

### Task 10: Label pt-BR de `provisioning`

**Files:**
- Modify: `src/translation/languages/ptBr.ts`
- Test: `src/pages/AgentConnectorPanel/aiSetup/AiAuditTimeline.test.tsx` (ou adicionar)

- [ ] **Step 1: Teste falhando** — badge da fase `provisioning` renderiza "Provisionando" (não a chave crua).
- [ ] **Step 2: Rodar** → FAIL.
- [ ] **Step 3: Implementar** — adicionar `provisioning: 'Provisionando'` em `pages.agentConnector.aiSetup.phases`.
- [ ] **Step 4: Rodar** → PASS.
- [ ] **Step 5: Commit** `fix(painel): label pt-BR da fase provisioning`.

### Task 11: Disconnect/reconnect + re-join na sala company

**Files:**
- Modify: `src/pages/AgentConnectorPanel/aiSetup/hooks/useAiSetupSession.ts`
- Test: `.../hooks/useAiSetupSession.test.ts(x)` (criar se não existir)

- [ ] **Step 1: Teste falhando** — no evento `disconnect`, um estado `connectionLost` vira true (UI pode mostrar aviso); no `connect` após queda, re-emite `joinCompany` com o companyId atual.
- [ ] **Step 2: Rodar** → FAIL.
- [ ] **Step 3: Implementar** — listeners `socket.on('disconnect'|'connect')`; guardar companyId num ref; re-emitir join no reconnect; expor `connectionLost`.
- [ ] **Step 4: Rodar** → PASS.
- [ ] **Step 5: Commit** `feat(painel): aviso de conexão perdida e re-join no reconnect do setup IA`.

### Task 12: Cards robustos à ordem + gating por presença viva

**Files:**
- Modify: `aiSetup/AiSetupSection.tsx`; consumo de readiness no `WorkspaceView.tsx`
- Test: `aiSetup/AiSetupSection.test.tsx`

- [ ] **Step 1: Teste falhando** — (a) `MappingApprovalCard`/`ProvisionApprovalCard` aparecem quando há proposta mesmo se a fase chegou antes/depois; (b) botão "Iniciar setup por IA" fica desabilitado quando readiness indica agente não vivo, com mensagem clara.
- [ ] **Step 2: Rodar** → FAIL.
- [ ] **Step 3: Implementar** — exibir card por presença de `proposal`/`provisionProposal` (não estritamente acoplado à fase); desabilitar o início quando `!isOnline` (presença viva) + texto "Agente não conectado — reabra/reinicie o conector".
- [ ] **Step 4: Rodar** → PASS.
- [ ] **Step 5: Commit** `feat(painel): cards robustos à ordem e gating do início por presença viva`.

---

## Notas de execução

- Cada task é independente e commitável; rodar a suíte do módulo afetado antes de cada commit (guard). No web, rodar arquivos isolados (a suíte cheia do AgentConnectorPanel trava por hang pré-existente em `ConfigurationModal.test.tsx`).
- Tasks 1–7 (neo) podem ser sequenciais; 3 e 4 dependem de 1/2. Fase 2 (agente) e Fase 3 (web) são independentes do neo e podem ser paralelizadas entre si.
- Não trocar o modelo de LLM (decisão registrada).
- Contratos WS/socket.io existentes (envelopes) permanecem; o que muda é QUEM dirige as fases (orquestrador, não LLM) e o toolset do match.
