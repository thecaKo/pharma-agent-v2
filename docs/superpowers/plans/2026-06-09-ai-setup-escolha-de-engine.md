# Escolha de engine no setup por IA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. TDD por task.

**Goal:** Após o `probe.engines`, a descoberta PAUSA, lista os engines achados na UI e o usuário ESCOLHE qual a IA deve usar para buscar credenciais/schema.

**Decisões (aprovadas):** lista = engines do `probe.engines` (driver + host/porta); SEMPRE pede escolha (mesmo com 1 engine); 0 engines → falha clara.

**Padrão de referência:** o provisionamento human-gated (`AiSetupProvisioningService.proposeAndAwait` + `handleProvisionDecision` + gateway + wiring) já implementa "propõe → espera decisão humana com timeout". A escolha de engine espelha esse padrão.

## Contrato (NÃO divergir entre neo e web)

- Nova fase `selecting_engine` adicionada ao tipo `AiSessionPhase` (neo: ai-setup-protocol.interface; web: aiSetup/types.ts). Label pt-BR: "Escolhendo banco".
- **socket.io neo→web** evento `engines.proposed`, payload:
  `{ sessionId: string, engines: EngineOption[] }`
  `EngineOption = { id: string; driver?: string; host?: string; port?: number; label: string }`
  - `id` estável por sessão: `engine-<index>` (0-based).
  - `label`: string amigável pré-montada no neo (ex.: `"MySQL — 127.0.0.1:3306"` ou o driver se sem host).
- **socket.io web→neo** evento `engine.decision`, payload: `{ sessionId: string, engineId: string }`.
- Timeout da decisão: reusar `AI_PROVISION_TIMEOUT_MS` (10min) → expira como falha/abort com motivo claro.

## FASE neo

### Task N1: protocolo + fase
- Constantes `ENGINES_PROPOSED_MESSAGE_TYPE='engines.proposed'`, `ENGINE_DECISION_MESSAGE_TYPE='engine.decision'`; interfaces `IEnginesProposedMessage`, `IEngineDecision`, `IEngineOption`; adicionar `'selecting_engine'` ao `AiSessionPhase`.
- TDD: teste de tipo/constante mínimo. Commit.

### Task N2: serviço de seleção de engine (propose → await)
- `AiSetupEngineSelectionService` (espelha provisioning): `proposeAndAwait({ sessionId, connectorId, engines }): Promise<IEngineOption>` — emite `engines.proposed` (via bridge.emit/gateway), registra pending por sessionId, aguarda `engine.decision` com timeout; resolve com o engine escolhido (casa por `id`); rejeita/aborta em timeout ou id inválido.
- `applyEngineDecision(decision)` resolve o pending.
- TDD: propõe→decisão resolve com o engine certo; id inválido → erro; timeout → erro. Commit.

### Task N3: facade + gateway + wiring
- `AiSetupFacade.handleEngineDecision({ companyId, sessionId, engineId })` → valida sessão/empresa → `engineSelection.applyEngineDecision`.
- `AiSetupGateway`: handler do evento `engine.decision` (valida `client.data.companyId`) → facade; método `emitEnginesProposed(companyId, message)` → `server.to('company:'+companyId).emit('engines.proposed', ...)`.
- wiring: rotear o emit do serviço ao gateway por companyId (como audit/state).
- TDD nos respectivos testes. Commit.

### Task N4: discovery usa selectEngine
- `IAiSetupDiscoveryDeps` ganha `selectEngine: (engines: IDiscoveredEngine[]) => Promise<IDiscoveredEngine>`.
- `discoverEngine`: após `probe.engines` (0 → throw claro), `deps.emitState('selecting_engine')` e `const engine = await deps.selectEngine(engines)`; segue credenciais/schema SÓ com o engine escolhido (scan/test/fallback p/ conexão existente — mantido). Remover o auto-loop de seleção.
- Orquestrador (`runSession`): wira `selectEngine` ao `engineSelection.proposeAndAwait({ sessionId, connectorId, engines })`, montando `IEngineOption[]` (id `engine-<i>`, label driver+host+port).
- TDD: discovery chama selectEngine com os engines e segue com o escolhido; emite `selecting_engine`. Atualizar testes existentes (mock de selectEngine retornando engines[0]). Commit.

## FASE web

### Task W1: hook
- `useAiSetupSession`: escuta `engines.proposed` → `setEnginesProposal(payload)`; expõe `chooseEngine(engineId)` que emite `engine.decision` `{ sessionId, engineId }`; limpa proposal ao decidir.
- TDD no useAiSetupSession.test. Commit.

### Task W2: EngineSelectionCard + render + label
- Novo `EngineSelectionCard` (lista de engines com rádio + botão "Usar este banco"), exibido quando `enginesProposal` presente (robusto à ordem, como os outros cards). Chama `chooseEngine`.
- Label `selecting_engine: 'Escolhendo banco'` em ptBr.ts.
- TDD no AiSetupSection.test (card aparece com proposal; clicar confirma chama chooseEngine). Rodar arquivos ISOLADOS (suíte cheia trava por hang pré-existente). Commit.

## Notas
- 0 engines → erro claro ("nenhum engine de banco detectado pelo agente").
- Reaproveitar tudo do gateway/socket.io existente (join company, validação de companyId nos handlers).
- Não muda o contrato WS neo↔agente (engines vêm do probe.engines já existente).
