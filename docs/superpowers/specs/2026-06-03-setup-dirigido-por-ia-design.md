# Setup dirigido por IA — design

**Data:** 2026-06-03
**Frente:** feat-pharma-agent-v2
**Repos afetados:** `pharma-agent-v2` (agente), `neo-api-pharmachatbot` (orquestrador), `web-pharmachatbot` (UI)

## Objetivo

Reformular o ciclo de onboarding do conector: ao instalar o agente e rodar o setup,
**uma IA conduz todo o processo** — encontrar o PDV, identificar o banco, achar e validar
credenciais, inspecionar o schema e entender produtos espalhados em múltiplas tabelas
(ex.: `produtos`, `desconto_produtos`, `fabricante_produtos`) — produzindo ao final o
mesmo `connector-config.json` + mapping que o poller já consome.

### Restrições invioláveis

- **Somente leitura.** O agente NUNCA executa ação de escrita. Garantido por
  **catálogo fechado de ferramentas read-only** (não há ferramenta de escrita) +
  validador de SELECT + deny-list de fs/registro.
- **Tudo auditável.** Cada passo da IA é visível no painel em tempo real para que se
  possa identificar o que o agente está fazendo.
- **Segredos não saem da máquina.** Credenciais cruas ficam só no `connector-config.json`
  local (PROGRAMDATA). O painel recebe sempre o valor **redigido/mascarado**.

## Decisões de design (brainstorming)

| # | Decisão |
|---|---|
| 1 | Ciclo inteiro de setup conduzido por IA; agente local é host de ferramentas read-only sem IA própria. |
| 2 | Read-only garantido por **catálogo fechado de ferramentas** (a IA escolhe de um conjunto pré-codificado; não manda comando cru). |
| 3 | Spec-mestre único com **3 contratos cravados** → 3 planos paralelizáveis (agente, neo, web). |
| 4 | A sessão de IA **substitui** o setup (CLI legado + probe-driven manual) e entrega o **mesmo artefato final**. Re-disparável para re-mapear. Poller intacto. |
| 5 | Credenciais: **redigir no stream, guardar local**. |
| 6 | Loop **autônomo com aprovação humana final do mapping**. |
| 7 | Arquitetura **A**: protocolo de tool-calling sobre o WS existente; loop agentic roda no neo. |
| 8 | `sql.runReadOnlySelect`: SELECT validado + LIMIT forçado. |
| 9 | Catálogo inicial: os 3 grupos (descoberta, credenciais, schema). |
| 10 | Transporte neo→web: **socket.io** (padrão já usado: `WebSocketGateway`+`RedisIoAdapter` no neo; `socket.io-client`/`useSocket` no web). |

## Arquitetura

**Atores:**
- **Agente** (`pharma-agent-v2`): host de ferramentas read-only na máquina do cliente.
  Sem IA. Executa ferramenta → devolve resultado → emite evento de auditoria. Guarda
  credenciais localmente.
- **Orquestrador** (`neo-api-pharmachatbot`): cérebro. Roda o loop agentic de LLM,
  escolhe ferramentas do catálogo, propõe o mapping ao final. Relé de eventos para a UI.
- **UI** (`web-pharmachatbot`): timeline de auditoria em tempo real + tela de aprovação
  do mapping.

**Fluxo:**
```
instala agente + roda setup
        │
        ▼
agente conecta WS em "bootstrap" e anuncia CATÁLOGO de ferramentas read-only (ai.catalog)
        │
        ▼
neo inicia SESSÃO (ai.session.start) ──► loop:
   LLM escolhe ferramenta → tool.invoke ──► agente executa (read-only) ──► tool.result (redigido)
        │                                         │
        │                                         └──► audit.event (redigido) ──► UI (socket.io)
        ▼
   [engine → DSN/processos → lê configs → acha credencial → testa conexão →
    inspeciona schema (tabelas, colunas, FKs, amostras) → monta/testa query de JOIN]
        │
        ▼
LLM monta ValidatedMappingConfig (SELECT+JOIN) → mapping.proposed ──► UI
        │
        ▼
   humano APROVA na UI ──► mapping.decision(approve)
        │
        ▼
agente persiste connector-config.json (creds locais) + mapping → "synced"
        │
        ▼
poller/sync EXISTENTE assume (intacto)
```

Em qualquer falha (sem credencial, banco não identificado): `ai.session.state: failed`
com diagnóstico; fallback para o probe-driven manual continua disponível no agente.

---

## CONTRATO 1 — Catálogo de ferramentas read-only (agente ↔ neo)

Cada ferramenta: `name`, `description` (para o LLM), `inputSchema`, `outputSchema`.
**Por construção, nenhuma escreve.** Anunciado em `ai.catalog` com `catalogVersion`.

### Grupo 1 — Descoberta de sistema (reuso das probes existentes como tools)
| Tool | O que faz |
|---|---|
| `probe.engines` | engines de banco instalados |
| `probe.odbc_dsns` | DSNs ODBC configurados |
| `probe.processes` | processos rodando (pid/name/path) |
| `probe.connections` | conexões TCP em portas de banco conhecidas |
| `probe.network` | testa alcançabilidade host:porta |
| `probe.scan_config_dirs` | varre dirs por arquivos de config (deny-list + limites) |

### Grupo 2 — Credenciais & conexão (read-only)
| Tool | O que faz |
|---|---|
| `fs.readConfigFile` | lê um arquivo de config sob deny-list; valor cru só local, redigido no audit |
| `registry.readKey` | lê chave do registro Windows (read-only) |
| `probe.test_connection` | testa credencial candidata sem persistir |

### Grupo 3 — Inspeção de schema (destrava tabelas espalhadas)
| Tool | O que faz |
|---|---|
| `schema.listTables` | lista tabelas (já existe) |
| `schema.describeTable` | colunas + tipos de uma tabela |
| `schema.listForeignKeys` | FKs (infere ligação entre `produtos` e tabelas auxiliares) |
| `schema.sampleRows` | amostra N linhas (LIMIT pequeno) |
| `sql.runReadOnlySelect` | executa SELECT validado (rejeita não-SELECT, LIMIT forçado, timeout) — testa a query de JOIN antes de propor |

### Garantias de read-only (defesa em camadas)
1. **Catálogo fechado** — `tool.invoke` só aceita `name` desse conjunto; fora dele → rejeitado.
2. **Validador de `sql.runReadOnlySelect`** — exige SELECT puro: sem
   `INSERT/UPDATE/DELETE/MERGE/DDL`, sem múltiplos statements, sem procedures de escrita;
   injeta `LIMIT` e impõe timeout de query.
3. **`fs`/`registry`** — leitura por implementação (sem ferramenta de escrita) + deny-list
   de paths já usada nas probes.

---

## CONTRATO 2 — Protocolo WS / eventos

Estende `src/transport/protocol.ts` (tipos `ServerMessageType`/`ConnectorMessageType`).

### Servidor (neo) → Agente
| Mensagem | Payload | Propósito |
|---|---|---|
| `ai.session.start` | `sessionId` | inicia sessão; agente responde com `ai.catalog` |
| `tool.invoke` | `sessionId`, `invocationId`, `name`, `input` | pede execução de ferramenta do catálogo |
| `mapping.decision` | `sessionId`, `decision: approve\|reject`, `editedMapping?` | resposta humana à proposta |
| `ai.session.abort` | `sessionId`, `reason` | aborta o loop |

### Agente → Servidor (neo)
| Mensagem | Payload | Propósito |
|---|---|---|
| `ai.catalog` | `sessionId`, `tools[]`, `catalogVersion` | anuncia ferramentas read-only |
| `tool.result` | `sessionId`, `invocationId`, `ok`, `payload` (redigido), `errorCode?` | resultado |
| `audit.event` | `sessionId`, `seq`, `at`, `kind`, `tool?`, `summary`, `detail` (redigido) | item da timeline |
| `mapping.proposed` | `sessionId`, `mapping: ValidatedMappingConfig`, `rationale`, `previewRows` (redigido) | proposta p/ aprovação |
| `ai.session.state` | `sessionId`, `phase: discovering\|credentials\|schema\|proposing\|applying\|synced\|failed\|aborted` | estado p/ UI |

### Regras do contrato
- **Redação na borda do agente:** todo campo que possa conter segredo
  (`tool.result.payload`, `audit.event.detail`, `mapping.proposed.previewRows`) passa por
  `src/logging/redact.ts` **antes** de sair do agente.
- **`invocationId`** correlaciona `tool.invoke` ↔ `tool.result`; **`seq`** ordena a timeline.
- **Idempotência:** `invocationId` único; resultado repetido é ignorado.
- **Neo → Web (socket.io):** gateway/namespace novo (ex.: `ai-setup`) relaya `audit.event`,
  `ai.session.state`, `mapping.proposed`; web assina via hook estilo `useSocket`; decisão
  volta por emit no socket (ou POST REST — detalhe do plano do neo). Web nunca fala direto
  com o agente.
- **Persistência ao aprovar:** credenciais via fluxo `connector.bootstrap.dbConfig`
  existente; mapping via `connector.config` (`ValidatedMappingConfig`). Poller não muda.

### Início de sessão (canônico — REST inicia, socket transmite)

Para os planos de neo e web concordarem, o início é **único e via REST**:

1. **Web → neo (REST):** `POST /pharma-agent-catalog/companies/:companyId/ai-setup/sessions`.
   Escopo por **company** (o web só conhece `companyId`); o neo **resolve internamente o
   connector ativo** da company. Resposta: envelope `{ data: { sessionId } }`. Esse POST
   registra a sessão (`AiSetupSessionRegistry`), dispara `ai.session.start` **neo→agente** e
   inicia o loop do orquestrador.
2. **Web → neo (socket.io):** após o POST, o web **entra na sala da company** (mesmo padrão
   `emit('company', companyId)` do socket existente) para receber `audit.event`,
   `ai.session.state` e `mapping.proposed`.
3. **Web → neo (socket.io) emite SOMENTE:** `mapping.decision { sessionId, decision, editedMapping? }`
   e `ai.session.abort { sessionId, reason }`. **Não existe `ai.session.start` web→neo** — o
   gatilho é exclusivamente o POST REST. (`ai.session.start` só existe no canal neo→agente.)
4. **Estado:** `GET /pharma-agent-catalog/companies/:companyId/ai-setup/sessions/:sessionId`
   devolve a fase atual (apoio; a fonte de verdade ao vivo é o `ai.session.state` no socket).

---

## CONTRATO 3 — Artefato de mapping (saída da IA)

A IA produz exatamente um **`ValidatedMappingConfig`** (`src/mapping/types.ts`), o tipo que
`connector.config` já transporta e o poller já consome. **Sem formato novo.**

- **`snapshotQuery`/`incrementalQuery`** ← o SELECT com JOIN montado e validado via
  `sql.runReadOnlySelect`. Ex.:
  `SELECT p.codigo, p.nome, dp.preco_final, fp.fabricante FROM produtos p
   LEFT JOIN desconto_produtos dp ON dp.produto_id = p.id
   LEFT JOIN fabricante_produtos fp ON fp.produto_id = p.id`.
- **`fields`** mapeia colunas do resultado → campos canônicos (`sourceProductCode`, `name`,
  `price`, `stock`, `barcode`, `active`, `sourceUpdatedAt`).
- **`syncMode`/`cursorField`/`cursorType`**: incremental se a IA achou coluna de
  timestamp/versão confiável; senão snapshot.
- **`mappingVersion`**: nova a cada proposta aprovada.
- Proposta acompanha `rationale` + `previewRows` (redigidas) para decisão humana.

**Extensão provável:** confirmar no plano do agente que `validate.ts`/`apply.ts` aceitam
bem queries com JOIN (esperado, pois já é string SQL livre).

---

## Erros, edge cases e segurança operacional

- **Ferramenta falha** (`tool.result.ok=false`): `errorCode` tipado (reusa `ProbeErrorCode`:
  `auth`/`timeout`/`tls`/`unreachable`/`driver_missing`/`unknown` + `INVALID_INPUT`/
  `INTERNAL_ERROR`). A IA reage (outra credencial/host); o loop não morre por erro isolado.
- **Credencial/banco não encontrado:** esgota candidatos → `ai.session.state: failed` com
  motivo; UI permite intervenção manual (fallback probe-driven segue existindo).
- **Anti-runaway:** limite de invocações por sessão + timeout de sessão (estourou →
  `aborted`); `sql.runReadOnlySelect` com timeout de query + LIMIT forçado.
- **Abort sempre disponível** (`ai.session.abort`) — humano corta o loop pela UI a qualquer
  momento.
- **Redação** testada: nenhum campo sensível trafega cru.

## Estratégia de testes

- **Agente (TDD unit):** cada ferramenta nova com fixtures dos adapters (fixture Firebird +
  MySQL via `docker-compose.test.yml`). Foco no **validador de SELECT** (tabela de casos:
  rejeita escrita/multi-statement/procedures; aceita SELECT/CTE-leitura) e na **redação**.
- **Agente (contrato):** roundtrip parse/serialize de cada envelope WS novo; correlação
  `invocationId`; ordenação `seq`.
- **Neo:** loop agentic com LLM **mockado/determinístico** (script de tool-calls) → monta
  `ValidatedMappingConfig` válido e relaya eventos. Sem LLM real no CI.
- **Web:** timeline consumindo eventos socket mockados + fluxo aprovar/rejeitar mapping.
- **Integração (fim de feature):** sessão ponta-a-ponta contra o MySQL de teste com tabelas
  espalhadas (`produtos` + `desconto_produtos` + `fabricante_produtos`): IA monta JOIN →
  mapping aprovado → poller sincroniza produtos corretos.

## Decomposição em planos (paralelizáveis)

1. **Plano Agente** (`pharma-agent-v2`): ferramentas dos 3 grupos + validador SELECT +
   redação na borda + envelopes WS do Contrato 2 (lado agente) + anúncio de catálogo +
   persistência ao aprovar.
2. **Plano Neo** (`neo-api-pharmachatbot`): loop agentic, seleção de ferramentas, geração do
   `ValidatedMappingConfig`, gateway socket.io `ai-setup`, relé de eventos + decisão.
3. **Plano Web** (`web-pharmachatbot`): hook de assinatura socket, timeline de auditoria,
   tela de aprovação/edição do mapping.

Os 3 dependem apenas dos Contratos 1–3 acima; com eles fixados, podem ser executados em
paralelo.
