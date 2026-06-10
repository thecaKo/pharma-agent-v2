# Conexão de banco dirigida pela IA (sem pré-config, segredos locais)

- **Data:** 2026-06-09
- **Frente:** feat-pharma-agent-v2 (repos: pharma-agent-v2 [agente], neo-api-pharmachatbot, web-pharmachatbot)
- **Branch:** feat/pharma-agent-v2
- **Status:** aprovado (brainstorming)

## Problema

O setup por IA prometia "a IA acha o banco, conecta e mapeia", mas a implementação atual NÃO consegue conectar: as tools de schema (`schema.listTables` etc.) operam apenas no banco que o agente JÁ está conectado (config do env), e não há nenhuma tool para ESTABELECER a conexão a partir de credenciais descobertas. `probe.test_connection` só testa "sem persistir". Resultado: ou o agente vem pré-configurado (contradiz a proposta), ou o schema fica inacessível (`database.config.missing` → `INTERNAL_ERROR`). Confirmado em log real: `databaseConfigured: false` → listTables falha.

## Decisões (brainstorming)

1. **Handles de credenciais descobertas:** o AGENTE descobre candidatos, guarda as credenciais COMPLETAS (com senha) **localmente**, e expõe ao neo/IA apenas um descritor **redigido** + um **handle opaco**. A senha nunca trafega. A IA/operador escolhe por handle.
2. **Fontes:** arquivos de config (parser best-effort: ini / key=value / connection-string) **+ DSNs ODBC**.
3. **Passo único de seleção:** generaliza a escolha de engine já construída → escolha de **conexão candidata** (driver+host+porta+user+fonte; senha mascarada). Subsome o engine.
4. **Sem entrada manual** de credenciais por ora (se a descoberta não achar nada utilizável → erro claro).
5. **`connection.use` conecta read-only** (adapter já força `readonly: true`).
6. **Provisionamento RO** (`propose_readonly_user`) permanece passo separado no match — fora de escopo aqui.

## Contrato (não divergir entre repos)

- Fase renomeada: `selecting_engine` → **`selecting_connection`**. Label web: "Escolhendo conexão".
- Descritor redigido de candidato:
  `IConnectionCandidate = { handle: string; driver: string; host?: string; port?: number; user?: string; database?: string; source: string; label: string }`
  - `handle`: opaco e estável por sessão (ex.: `conn-0`).
  - `source`: origem ("config:/etc/app/db.conf" | "odbc:DSN_NAME").
  - **NUNCA** inclui senha.
- socket.io neo→web `connections.proposed`: `{ sessionId, candidates: IConnectionCandidate[] }`.
- socket.io web→neo `connection.decision`: `{ sessionId, handle: string }`.
- WS neo→agente: o neo invoca duas tools novas via bridge.invokeTool.

## Componentes

### Agente (pharma-agent-v2) — onde os segredos ficam
- **Descoberta de credenciais (local):** módulo que (a) varre dirs de config (roots default por engine/OS via `probe.scan_config_dirs` com `roots` corretos), (b) lê arquivos achados e **parseia** credenciais (ini / key=value / connection-string: `driver://user:senha@host:porta/db`, `Server=...;User=...;Password=...`), (c) enumera **DSNs ODBC**. Monta um store em memória da SESSÃO: `Map<handle, FullConnConfig>` (FullConnConfig = driver/host/port/user/password/database). 
- **Nova tool `connection.discoverCandidates`** (input vazio): roda a descoberta, popula o store e retorna a lista **redigida** `IConnectionCandidate[]` (sem senha).
- **Nova tool `connection.use` `{ handle }`:** pega o `FullConnConfig` do handle no store local, cria/conecta o adapter (`createSourceDatabaseAdapter`, read-only), define-o como a conexão ativa das tools de schema (substitui/popula `this.adapter`/`this.config.database` em memória, sem persistir em disco até a aprovação do mapping). Confirma com um `listTables` rápido. Retorna `{ ok, tablesCount }` ou erro. Recebe SÓ o handle.
- As tools de schema (`schema.listTables`/`describeTable`/`sampleRows`/`sql`) passam a operar nessa conexão estabelecida.
- O store de credenciais é por sessão e descartado ao fim/abort (não persiste).

### neo (orquestrador/descoberta)
- `AiSetupDiscoveryService.discoverEngine` é substituído por um fluxo de **conexão**:
  1. `emitState('discovering')` → opcional `probe.engines` (evidência); 
  2. `emitState('selecting_connection')` → `connection.discoverCandidates` → `deps.selectConnection(candidates)` (injetado; espelha o engine-selection) → handle escolhido;
  3. `connection.use(handle)` → se ok, segue; senão erro claro;
  4. `emitState('schema')` → `inspectSchema` (inalterado).
- Renomear o serviço/tipos de engine-selection para connection-selection: `AiSetupEngineSelectionService`→`AiSetupConnectionSelectionService`, `proposeAndAwait({ sessionId, connectorId, candidates })`, `IEngineOption`→`IConnectionCandidate`, eventos `engines.proposed`/`engine.decision`→`connections.proposed`/`connection.decision`, facade `handleEngineDecision`→`handleConnectionDecision`, gateway handler, wiring.
- 0 candidatos → erro claro; `connection.use` falha → erro claro (não `INTERNAL_ERROR`).

### web (web-pharmachatbot)
- `EngineSelectionCard`→`ConnectionSelectionCard`: lista candidatos mostrando driver/host/porta/user/source (senha mascarada), rádio + "Usar esta conexão".
- hook: `engines.proposed`→`connections.proposed`, `chooseEngine`→`chooseConnection(handle)`, `engine.decision`→`connection.decision`.
- label `selecting_connection: 'Escolhendo conexão'`.

## Segurança
- Senha/credencial completa **nunca** sai do agente: só descritor redigido + handle cruzam para neo/UI. `connection.use` recebe só o handle.
- Conexão estabelecida é **read-only**. Store de sessão descartado ao fim.
- Logs já redigem segredos (redactValue); aplicar aos novos pontos.

## Rastreabilidade
- Resolve: "agente precisa de config prévia" → não precisa mais; a IA/operador escolhe uma conexão candidata e o agente conecta local.
- Substitui a feature de escolha de engine (generalizada para conexão).

## Não-objetivos
- Entrada manual de credenciais (fallback) — futura.
- Parsing exaustivo de todo formato de config — v1 cobre ini/key=value/connection-string + ODBC; extensível.
- Provisionamento RO — passo separado, inalterado.

## Testes
TDD: parser de credenciais (cada formato), enumeração DSN, store handle→creds + redação, `connection.discoverCandidates` (lista redigida sem senha), `connection.use` (conecta e schema passa a funcionar; handle inválido → erro), rewire neo (discoverCandidates→select→use→schema; erros claros), web (card lista candidatos, escolher chama chooseConnection).
