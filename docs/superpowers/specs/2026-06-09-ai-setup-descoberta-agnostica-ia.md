# Descoberta de conexão agnóstica dirigida pela IA (primitivas read-only)

- **Data:** 2026-06-09
- **Frente:** feat-pharma-agent-v2 (agente pharma-agent-v2, neo-api-pharmachatbot, web-pharmachatbot)
- **Branch:** feat/pharma-agent-v2
- **Status:** aprovado (brainstorming)

## Problema / visão

A descoberta atual depende de roots/parsers/formatos por PDV (hardcoded) e não acha o banco em casos reais (credenciais em locais/formatos não previstos — ex.: `connection.conf` hex dentro da pasta do PDV). Visão do usuário: **um canal read-only da máquina Windows do cliente para o painel, onde a IA faz TUDO** — encontra o banco, credenciais (usuário, senha), nome do banco, tabelas — e entrega o pacote pronto; o operador só **revisa/aceita no fim**.

## Decisões (brainstorming)

1. **Dirigido pela IA:** a IA compõe livremente **primitivas read-only** para descobrir o banco (não há descoberta determinística por roots/parsers).
2. **Read-only garantido por primitiva, sem shell cru:** o agente expõe operações de LEITURA bem definidas; nenhum comando arbitrário/escrita/exec.
3. **A IA vê as credenciais:** lê o conteúdo dos arquivos (inclui senha), decodifica e usa pra conectar — a senha trafega para a IA/neo. **Abandona-se o princípio "segredos não saem da máquina"** (trade-off aceito por poder/agnosticismo). Torna obsoleto o modelo de "candidato com handle/segredo local".
4. **FS amplo:** `fs.readFile`/`fs.listDir` em **qualquer caminho** (read-only), removendo o deny-list/roots atuais — só guardas contra arquivos gigantes/binários e poucos caminhos críticos de SO.
5. **Humano só no fim:** a IA é **autônoma (read-only)** até propor TUDO; timeline ao vivo mostra cada passo; o operador revisa/aceita o pacote completo (conexão usada + tabelas + mapping) — **sem cards de escolha no meio**.
6. **Auth de handshake do gateway** (falha cross-tenant aberta desde o review) entra NO ESCOPO — pré-requisito dado o novo poder (IA lê arquivos arbitrários + vê credenciais).

## Capacidade — primitivas read-only (catálogo v2)

A IA invoca, via o canal WS já existente, primitivas de leitura. Todas auditadas; nenhuma escreve.
- **FS:** `fs.listDir({ path })`, `fs.readFile({ path, maxBytes? })` (qualquer caminho; cap de tamanho; rejeita binário/caminhos críticos de SO), `fs.stat({ path })`.
- **Sistema:** `probe.processes`, `probe.services` (se viável), `registry.read({ path })`.
- **Banco:** `db.connect({ driver, host, port, user, password, database })` — abre conexão **read-only** e a torna a conexão ativa das tools de schema (substitui `connection.use`/handle; recebe params completos pois a IA os tem); `schema.listTables`, `schema.describeTable`, `schema.sampleRows`, `schema.listForeignKeys`, `sql.runReadOnlySelect`.
- Decodificação (hex/base64/etc.) é feita pela IA sobre o conteúdo lido (sem tool dedicada, ou uma `util.decode` opcional).

## Fluxo — laço único dirigido pela IA

Sem fase determinística e sem seleção no meio:
`discovering` (a IA explora FS/processos/registry, lê configs, decodifica, acha credenciais) → `connecting` (a IA chama `db.connect` com o que achou; se falhar, tenta outra) → `schema` (lista tabelas, descreve, amostra) → `proposing` (`emit_mapping`). Timeline ao vivo (audit.event — já existe). No fim: **um card de revisão** mostrando a CONEXÃO escolhida (driver/host/db/user — senha mascarada na UI) + tabelas + mapping; operador **aceita**. Reaproveita guard-rails: anti-repetição, convergência forçada, orçamento de turnos/tempo, abort, 1 sessão/connector, logs do LLM.

## Segurança

- Read-only forçado em cada primitiva (sem escrita/exec/shell). `db.connect` força conexão read-only.
- **A IA/neo vê credenciais** — trade-off aceito; documentar.
- **Auth de handshake do gateway socket.io** (e authz por companyId no join e nas rotas) — implementar: middleware de JWT no handshake + validação de tenant no `handleCompanyJoin`. Fecha o risco cross-tenant.
- Tudo auditável na timeline (com segredos redigidos NA UI/logs, mesmo que a IA os processe internamente).

## Rework (o que esta entrega SUBSTITUI)

Remove/aposenta: descoberta determinística (`ai-setup-discovery.service` no formato atual), modelo de candidato com handle + segredo local (`connection.discoverCandidates`/`connection.use` por handle), seleção de conexão/engine (`connections.proposed`/`connection.decision`/`ConnectionSelectionCard`, fase `selecting_connection`) e a varredura por roots/parsers/Firebird-file como caminho ÚNICO (as primitivas read-only as tornam desnecessárias; a IA varre via `fs.listDir`/`readFile`).
Reaproveita: timeline de auditoria, card de aprovação do mapping (vira o review final), client/loop do LLM + instrumentação, ciclo de sessão (abort/1-por-connector), bridge/relé socket.io.

## Não-objetivos
- Shell/PowerShell cru ou qualquer escrita (somente primitivas read-only).
- Provisionamento de usuário read-only (`propose_readonly_user`) — passo separado, opcional, inalterado.

## Testes
TDD: cada primitiva read-only (incl. guardas de FS: caminho crítico/binário/tamanho), `db.connect` read-only + swap de adapter, o laço da IA (mock LLM) compondo primitivas → connect → schema → emit_mapping, guard-rails (anti-loop/forcing/budget/abort), e a auth do gateway (handshake sem JWT é rejeitado; join valida tenant).
