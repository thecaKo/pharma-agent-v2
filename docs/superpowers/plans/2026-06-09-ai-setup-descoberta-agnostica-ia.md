# Descoberta agnóstica dirigida pela IA — Implementation Plan

> REQUIRED SUB-SKILL: subagent-driven-development. TDD por task. Spec: docs/superpowers/specs/2026-06-09-ai-setup-descoberta-agnostica-ia.md.

**Goal:** A IA compõe primitivas READ-ONLY pra achar o banco em qualquer lugar/formato, conecta, inspeciona schema e propõe o mapping — operador só revisa no fim. Sem descoberta determinística, sem seleção no meio.

## Contrato das primitivas read-only (FIXO — neo consome)
Tools do agente (via tool.invoke; resultado em tool.result; ok do tool + payload):
- `fs.listDir` { path } → { entries: [{ name, type:'file'|'dir', size? }] }
- `fs.readFile` { path, maxBytes? } → { path, content, truncated } (rejeita caminho crítico de SO / binário / > cap → errorCode)
- `fs.stat` { path } → { exists, type, size, mtime? }
- `probe.processes` { } → { processes:[...] } (já existe)
- `registry.read` { path } → { values } (já existe como registry.readKey — manter nome)
- `db.connect` { driver, host, port?, user, password, database } → { ok:boolean, tablesCount?, errorCode? } (read-only; vira a conexão ativa das tools de schema; substitui connection.use/handle)
- `schema.listTables`/`schema.describeTable`/`schema.sampleRows`/`schema.listForeignKeys`/`sql.runReadOnlySelect` (já existem; operam na conexão de db.connect)

## FASE AGENTE (pharma-agent-v2)
- **AG1** Primitivas FS: `fs.listDir`, `fs.readFile` (qualquer caminho, read-only, cap de bytes, deny de caminhos críticos de SO + skip binário), `fs.stat`. TDD com fs mockado. Catálogo + router + deps.
- **AG2** `db.connect` { params completos } → createSourceDatabaseAdapter(readonly) → conecta → vira adapter ativo das tools de schema (mesmo swap do connection.use atual, mas recebendo params em vez de handle); { ok, tablesCount } / { ok:false, errorCode }. Catálogo + router/sinal + deps.
- **AG3** REMOVER o que foi aposentado: `connection.discoverCandidates`, `connection.use`(handle), store de handles, `connection-candidates.ts`, `credential-parser.ts` (e testes), scan firebird-file como fonte. Manter probe.processes/registry/schema/sql.
- **AG4** build do dist ao final.

## FASE NEO (neo-api-pharmachatbot)
- **N1** Orquestrador vira UM laço dirigido pela IA com o catálogo READ-ONLY completo (fs.*, probe.processes, registry.read, db.connect, schema.*, sql) + emit_mapping. Remover a fase determinística (chamada à discovery service) e a restrição de toolset do match — agora é um loop só. Manter anti-repetição, convergência forçada, orçamento (subir um pouco o teto de exploração, ex.: 40, pois agora a IA varre FS), abort, logs do LLM.
- **N2** System prompt novo: instruir a IA a explorar o FS (listDir/readFile) pra achar credenciais de banco (qualquer formato; decodificar hex/base64 se preciso), chamar db.connect com o que achou, inspecionar o schema e chamar emit_mapping. Fases: discovering → connecting → schema → proposing.
- **N3** REMOVER: AiSetupConnectionSelectionService, eventos connections.proposed/connection.decision, fase selecting_connection, facade.handleConnectionDecision, gateway/wiring/constantes correspondentes, ai-setup-discovery.service (ou reduzi-lo). Atualizar todos os testes.
- **N4** SEGURANÇA — auth de handshake do gateway socket.io: middleware que exige JWT no handshake (rejeita sem token) + validar tenant/companyId no handleCompanyJoin (cliente só entra na sala da própria empresa). Fecha o cross-tenant. TDD.
- Suíte `src/modules/ai-setup` + a do gateway verde; tsc limpo.

## FASE WEB (web-pharmachatbot)
- **W1** REMOVER ConnectionSelectionCard + estado/handlers de seleção (connectionsProposal/chooseConnection, eventos, fase selecting_connection).
- **W2** Manter timeline + card de aprovação final do mapping; o card final mostra a CONEXÃO que a IA usou (driver/host/db/user — senha mascarada) + tabelas + mapping. Labels de fase: discovering/connecting/schema/proposing/synced/failed/aborted ('Conectando' p/ connecting). Tipos/eventos atualizados.
- Testes isolados (suíte cheia trava por hang pré-existente); tsc limpo.

## Notas
- Husky/commitlint: subject ≤ ~90 chars, conventional pt-br, subject-only + footer Co-Author.
- Trade-off documentado: a IA/neo vê credenciais (segredos-locais abandonado). db.connect é read-only.
- Provisionamento RO (propose_readonly_user) inalterado/opcional.
