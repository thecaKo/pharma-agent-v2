# Provisionamento de usuário read-only — design

**Data:** 2026-06-03
**Frente:** feat-pharma-agent-v2
**Repos:** `pharma-agent-v2` (agente), `neo-api-pharmachatbot` (neo), `web-pharmachatbot` (web)
**Relacionado:** [setup dirigido por IA](2026-06-03-setup-dirigido-por-ia-design.md)

## Objetivo

Após validar a conexão ao banco do PDV, **criar um usuário somente-leitura dedicado**
(`pharma_connector_ro`) com `GRANT SELECT` em todas as tabelas e **usar esse usuário** para a
inspeção de schema e o sync contínuo — em vez de reusar a credencial de admin descoberta
(least-privilege). A criação é a **única operação de escrita** do agente, isolada numa tool
admin, e **só executa após aprovação humana explícita**.

## Emenda ao modelo de segurança

A regra original ("agente NUNCA escreve") passa a:

> **O catálogo de tools do LLM é 100% read-only.** A **única** escrita do agente é o comando
> admin `connector.provisionReadonlyUser` — que **não está no catálogo do LLM**, é invocado
> **só pelo neo** após aprovação humana, e roda **statements fixos por engine** (sem SQL
> arbitrário). A senha do RO é **gerada e persistida só localmente**, nunca trafega ao painel.

## Decisões (brainstorming)

| # | Decisão |
|---|---|
| 1 | Tool de escrita dedicada (única exceção), human-gated; abordagem A (sinal do LLM + escrita neo-only). |
| 2 | **Gate cedo:** após validar a credencial descoberta; o RO é usado na inspeção de schema E no sync. |
| 3 | Suporte aos **5 engines** (MySQL, MariaDB, PostgreSQL, SQL Server, Firebird). |
| 4 | Usuário **fixo** `pharma_connector_ro` + **idempotente** (cria/atualiza senha local + re-GRANT). |
| 5 | **Fallback:** sem privilégio / engine não suportado / erro → aviso no audit → segue com a credencial descoberta (não falha a sessão). |
| 6 | Senha do RO gerada (CSPRNG, ≥24 chars) e guardada só local; nunca no painel/log/audit. |
| 7 | UI em **pt-BR hard-coded** (sem i18n). |

## Arquitetura & fluxo

**Categorias de tool:**
- **Catálogo read-only do LLM** (`ai.catalog`): 14 tools de leitura + sinal `propose_readonly_user` (sem efeito no banco) + `emit_mapping`.
- **Escrita admin** `connector.provisionReadonlyUser`: fora do catálogo; neo-only; human-gated.

```
probe.test_connection valida a credencial DESCOBERTA (admin)
  │
  ▼  LLM chama propose_readonly_user { username:"pharma_connector_ro" }  (sinal)
  ▼  orquestrador PAUSA o loop
neo → web (socket): provision.proposed { sessionId, username, engine, scope:"all_tables", readOnly:true }
  │  humano aprova/rejeita
  ├─ REJEITA/expira ─► audit ─► segue com a DESCOBERTA
  ▼ APROVA
neo → agente (WS): connector.provisionReadonlyUser { requestId, sessionId, username }
  │  agente (conexão admin): gera senha local; CREATE/ALTER USER + GRANT SELECT (por engine);
  │  valida o RO com SELECT; troca a conexão ativa para o RO; persiste RO no config local
  ▼
agente → neo: connector.provisionReadonlyUser.result { outcome, username, errorCode? }
  │  provisioned          ─► inspeção + sync usam o RO
  │  fallback/unsupported/error ─► audit ─► segue com a DESCOBERTA
  ▼  neo → web: provision.result { sessionId, outcome, username, errorCode? }
  ▼  loop RETOMA; tool.result de propose_readonly_user informa ao LLM { provisioned, activeCredential }
LLM inspeciona schema → emit_mapping → aprovação do mapping → synced
```

`ai.session.state` ganha a fase `provisioning` (entre `credentials` e `schema`).

---

## CONTRATO A — Tools do agente

### A.1 `propose_readonly_user` (sinal read-only, no catálogo do LLM)
Sem efeito no banco. Valida o username e devolve o engine corrente.
```jsonc
// inputSchema
{ "type":"object",
  "properties": { "username": {"type":"string"}, "rationale": {"type":"string"} },
  "required": ["username"] }
// output (tool.result)
{ "accepted": true, "username": "pharma_connector_ro", "engine": "mysql" }
```
Validação do username: `^[a-zA-Z][a-zA-Z0-9_]{2,62}$`. **Não toca no banco.**

### A.2 `connector.provisionReadonlyUser` (escrita admin, FORA do catálogo, neo-only)
Novo comando no protocolo WS do agente (como `connector.bootstrap.dbConfig`).
```jsonc
// neo → agente
{ "type":"connector.provisionReadonlyUser", "requestId":"<uuid>", "sessionId":"<id>",
  "username":"pharma_connector_ro" }            // SEM senha — gerada no agente
// agente → neo
{ "type":"connector.provisionReadonlyUser.result", "requestId":"<uuid>", "sessionId":"<id>",
  "outcome":"provisioned"|"fallback_no_privilege"|"unsupported_engine"|"error",
  "username":"pharma_connector_ro", "grantedScope":"all_tables",
  "errorCode":"auth|timeout|unreachable|syntax|unknown" }   // só quando outcome="error"
```
**Comportamento do agente:**
1. Conecta com a credencial **descoberta (admin)**.
2. Gera senha forte localmente (CSPRNG, ≥24 chars).
3. Executa statements **fixos e parametrizados, idempotentes, por engine**:
   - **MySQL/MariaDB:** `CREATE USER IF NOT EXISTS 'u'@'%' IDENTIFIED BY ?` → `ALTER USER 'u'@'%' IDENTIFIED BY ?` → `` GRANT SELECT ON `db`.* TO 'u'@'%' `` → `FLUSH PRIVILEGES`.
   - **PostgreSQL:** `CREATE ROLE u LOGIN PASSWORD ?` (ou `ALTER ROLE u WITH PASSWORD ?` se existe) → `GRANT CONNECT ON DATABASE db TO u` → `GRANT USAGE ON SCHEMA <schema> TO u` → `GRANT SELECT ON ALL TABLES IN SCHEMA <schema> TO u`.
   - **SQL Server:** `CREATE LOGIN`/`ALTER LOGIN ... WITH PASSWORD` → `CREATE USER ... FOR LOGIN` → `ALTER ROLE db_datareader ADD MEMBER u`.
   - **Firebird:** `CREATE OR ALTER USER u PASSWORD ?` → itera `RDB$RELATIONS` (tabelas de usuário) e `GRANT SELECT ON <tabela> TO u`.
4. Valida o RO com um `SELECT` read-only; **troca a conexão ativa** (inspeção+sync) para o RO; persiste o RO no config (Contrato C).
5. **Detecção de privilégio insuficiente** (mapeada por engine: MySQL 1044/1142, PG 42501, SQL Server 229/15247, Firebird "no permission") → `outcome:"fallback_no_privilege"` e mantém a conexão na **descoberta**.
6. **Erro no meio** → `outcome:"error"`; reverte a conexão ativa para a descoberta (estado consistente).

**Segurança:** statements são templates fixos por engine; senha/username como **parâmetros** (identificadores devidamente *quoted* quando o driver não parametriza). **Sem SQL concatenado/arbitrário.** Senha nunca na resposta/log/audit.

---

## CONTRATO B — Envelopes WS de provisionamento

### B.1 neo ↔ agente
`connector.provisionReadonlyUser` / `connector.provisionReadonlyUser.result` (A.2), correlacionados por `requestId` (padrão `pendingProbeRequests`/`invocationId`). Timeout: `AI_PROVISION_TIMEOUT_MS = 30000`.

### B.2 neo → web (socket.io, sala `company:{id}`)
```jsonc
"provision.proposed" → { sessionId, username:"pharma_connector_ro", engine, scope:"all_tables", readOnly:true, rationale?:string }
"provision.result"   → { sessionId, outcome, username, errorCode?:string }
```

### B.3 web → neo (socket.io)
```jsonc
"provision.decision" → { sessionId, decision:"approve"|"reject" }
```

### B.4 Pausa/retomada do loop (neo)
- Ao receber `tool.invoke` de `propose_readonly_user`, o orquestrador **não** resolve o `tool.result` ainda: registra `pendingProvision[sessionId]`, emite `provision.proposed`, e aguarda `provision.decision` (timeout `AI_PROVISION_DECISION_TIMEOUT_MS = 600000` → expira como `reject`).
- **approve:** invoca `connector.provisionReadonlyUser`; ao receber o result, emite `provision.result` e resolve o `tool.result` do sinal com:
  ```jsonc
  { "provisioned": true,  "activeCredential": "readonly_user", "username": "pharma_connector_ro" }
  // fallback/erro/reject:
  { "provisioned": false, "activeCredential": "discovered", "reason": "no_privilege|unsupported|error|rejected" }
  ```
- **reject/timeout/fallback/error:** sem escrita efetiva (ou revertida); `tool.result` informa `provisioned:false, activeCredential:"discovered"`; loop segue.
- Decisão **idempotente** por `sessionId`. Web só fala com o neo. `provision.*` nunca carrega senha.

---

## CONTRATO C — `connector-config.json`

Estrutura atual `database: { driver, host, port, name, user, password, instance?, trustServerCertificate? }` (consumida pelo poller). O provisionamento altera **só qual credencial** fica gravada:

| Momento | Credencial |
|---|---|
| Descoberta + `test_connection` + provisionamento | descoberta (admin) |
| Inspeção de schema / `sql.runReadOnlySelect` pós-provisionamento | RO se `provisioned`; senão descoberta |
| Sync contínuo (poller) | RO se `provisioned`; senão descoberta |

- `database.user`/`database.password` = credencial **RO** quando `provisioned`; senão **descoberta** (intacto).
- Bloco de metadados não-secreto:
```jsonc
"readonlyProvisioning": {
  "status": "provisioned" | "fallback_discovered" | "not_attempted",
  "username": "pharma_connector_ro",   // ausente em fallback/not_attempted
  "engine": "mysql",
  "provisionedAt": "2026-06-03T00:00:00Z"
}
```
- Persistência reaproveita `writeDatabaseConfig` (`mode 0o600`). Senha só local. **Poller não muda** (lê `database` normalmente, recebe a credencial RO transparentemente).
- Idempotência: usuário fixo + senha redefinida a cada provisionamento ⇒ `password` gravado sempre bate com o banco; sem órfãos.

---

## UI (web) — pt-BR hard-coded (sem i18n)

Estende `AgentConnectorPanel/aiSetup` (frente anterior), reusando `useAiSetupSession` e os tokens do `design.md` (`CARD_RADIUS 18px`, `SHADOW_MD`, sem cantos vivos, animação sob `prefers-reduced-motion`).

- **Hook:** `useAiSetupSession` assina `provision.proposed`/`provision.result`, expõe `provisionProposal` e ações `approveProvision()`/`rejectProvision()` (emitem `provision.decision`).
- **`ProvisionApprovalCard`:** aparece quando `phase === 'provisioning'` e há `provisionProposal`. Mostra (strings pt-BR literais no componente): usuário proposto, engine, escopo "somente leitura, todas as tabelas", aviso "será criado um usuário read-only dedicado para o sync; sua credencial de admin não será armazenada". Botões **Aprovar** / **Rejeitar**.
- **Timeline (`AiAuditTimeline`):** linha de resultado conforme `provision.result` (provisioned / fallback / erro), em pt-BR.
- **`AiSetupSection`:** novo estado `provisioning` no switch por `phase` (entre `credentials` e `schema`).
- **Sem i18n:** nada de `translation.t`/chaves em `translation/languages`.

---

## Erros & edge cases

- Sem privilégio → `fallback_no_privilege` → fallback (não falha).
- Engine não suportado → `unsupported_engine` → fallback.
- Erro de execução (timeout/queda no GRANT) → `error` → agente reverte conexão para a descoberta → fallback.
- Decisão expira → tratado como `reject`.
- Re-setup → idempotente (A.2/C).
- **Firebird parcial:** se o `SELECT` de validação do RO falhar (alguma tabela essencial sem grant) → `error` → fallback.

## Testes

- **Agente:** unit por engine (statements corretos/idempotentes/parametrizados, **sem SQL concatenado**); detecção de erro de privilégio por engine; geração de senha (CSPRNG, ≥24, nunca em output/log); troca de conexão ativa; persistência `database` RO + `readonlyProvisioning`; redação garante senha fora de result/audit; `propose_readonly_user` valida username e não toca no banco.
- **Neo:** pausa/retomada (`pendingProvision`), relay `provision.proposed`/`provision.result`, `provision.decision` (approve/reject/timeout), payload de volta ao LLM, invocação do comando admin com correlação/timeout (LLM mockado).
- **Web:** `ProvisionApprovalCard` (aprovar/rejeitar → `provision.decision`), assinatura dos eventos no hook, fase `provisioning`, linhas de resultado na timeline.
- **Integração (fim de feature):** ponta-a-ponta no MySQL de teste — descobre → propõe → aprova → cria `pharma_connector_ro` → inspeção+sync com o RO → produtos sincronizam.

## Decomposição em 3 planos paralelizáveis

1. **Agente** (`pharma-agent-v2`): `propose_readonly_user` no catálogo + comando admin `connector.provisionReadonlyUser` + rotinas por engine + geração de senha + troca de conexão + persistência (Contratos A, C).
2. **Neo** (`neo-api-pharmachatbot`): pausa/retomada do loop, envelopes `provision.*`, relay socket.io, invocação do comando admin (Contrato B).
3. **Web** (`web-pharmachatbot`): `ProvisionApprovalCard` + hook + fase `provisioning`, pt-BR hard-coded (Contrato B lado web).

Dependem apenas dos Contratos A/B/C acima — fixados para permitir execução paralela.
