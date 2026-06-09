# Conexão dirigida pela IA — Implementation Plan

> REQUIRED SUB-SKILL: subagent-driven-development. TDD por task. Spec: docs/superpowers/specs/2026-06-09-ai-setup-conexao-dirigida-ia-design.md.

**Goal:** A IA/operador escolhe uma CONEXÃO candidata (descoberta pelo agente) e o agente conecta localmente — sem pré-config, senha nunca sai da máquina.

## Contrato (FIXO — não divergir)
- Fase `selecting_engine` → **`selecting_connection`** (label web "Escolhendo conexão").
- `IConnectionCandidate = { handle: string; driver: string; host?: string; port?: number; user?: string; database?: string; source: string; label: string }` (SEM senha).
- socket.io neo→web `connections.proposed`: `{ sessionId, candidates: IConnectionCandidate[] }`.
- socket.io web→neo `connection.decision`: `{ sessionId, handle: string }`.
- Tools novas no agente (catálogo): `connection.discoverCandidates` (input vazio → `{ candidates: IConnectionCandidate[] }`, redigido) e `connection.use` (`{ handle }` → `{ ok: boolean, tablesCount?: number, errorCode?: string }`).

## FASE AGENTE (pharma-agent-v2) — núcleo
- **A1 parser de credenciais:** módulo que parseia conteúdo de config em `{driver?,host?,port?,user?,password?,database?}` a partir de: ini, key=value, connection-string (`driver://user:pass@host:port/db`, `Server=...;Database=...;User Id=...;Password=...`). TDD por formato. Retorna candidatos parciais; só vira candidato se tiver pelo menos driver+host (porta default por driver) + user.
- **A2 enumeração ODBC + varredura:** reaproveitar probeOdbcDsns e probeScanConfigDirs (roots default por OS/engine) + readConfigFile (local) para coletar fontes; montar candidatos.
- **A3 store de sessão + tool `connection.discoverCandidates`:** roda A1+A2, popula `Map<handle, FullConnConfig>` (handle `conn-<i>`), retorna lista REDIGIDA (sem senha). Adicionar ao catálogo (tool-catalog.ts) + admin-router + deps.
- **A4 tool `connection.use {handle}`:** pega FullConnConfig do store, `createSourceDatabaseAdapter` (readonly), conecta, define como adapter ativo das tools de schema (em memória, sem persistir), confirma com listTables → `{ok, tablesCount}`; handle inválido/erro → `{ok:false, errorCode}`. Catálogo + router + deps.
- **A5** store descartado no fim/abort da sessão. Build do dist ao final.
- Segredos: redactValue em tudo que loga; senha nunca no descritor.

## FASE NEO (neo-api-pharmachatbot) — rewire + rename
- **N1 rename** engine→conexão: `selecting_engine`→`selecting_connection`; `IEngineOption`→`IConnectionCandidate` (+ user/database/source/label); `engines.proposed`/`engine.decision`→`connections.proposed`/`connection.decision`; `AiSetupEngineSelectionService`→`AiSetupConnectionSelectionService`; facade `handleEngineDecision`→`handleConnectionDecision`; gateway/wiring; constantes.
- **N2 discovery rewire** (ai-setup-discovery.service.ts): substituir o fluxo de engine por: `emitState('selecting_connection')` → `connection.discoverCandidates` → `deps.selectConnection(candidates)` → `connection.use(handle)` (se ok segue; senão erro claro) → `inspectSchema`. Remover scan/test_connection/fallback antigos (agora a conexão é estabelecida explicitamente). Orquestrador wira `selectConnection` ao ConnectionSelectionService.proposeAndAwait.
- **N3** erros claros: 0 candidatos; connection.use falhou.
- Atualizar testes (discovery/orchestrator/facade/gateway/wiring) ao novo contrato; suíte `src/modules/ai-setup` verde; tsc limpo.

## FASE WEB (web-pharmachatbot)
- **W1** `EngineSelectionCard`→`ConnectionSelectionCard` (mostra driver/host/porta/user/source; senha mascarada; rádio + "Usar esta conexão").
- **W2** hook: `engines.proposed`→`connections.proposed`, `chooseEngine`→`chooseConnection(handle)`, `engine.decision`→`connection.decision`; tipos/AI_SETUP_SOCKET_EVENTS; fase `selecting_connection`; label "Escolhendo conexão".
- Testes isolados (suíte cheia trava por hang pré-existente); tsc limpo.

## Notas
- Husky/commitlint: subject ≤ ~90 chars, conventional pt-br, subject-only + footer Co-Author.
- Sem entrada manual de credencial (futuro). Provisionamento RO inalterado.
