# Fix do loop: reverse-map de nome de tool + forcing no laço único

> REQUIRED SUB-SKILL: TDD. Repo: neo-api-pharmachatbot. Branch feat/pharma-agent-v2.

**Problema (confirmado em log):** no laço único dirigido pela IA, ao atingir o teto de exploração (AI_SESSION_SOFT_INVOCATION_CAP), a convergência forçada passa a oferecer SÓ `emit_mapping`. Mas (a) a IA ainda precisa de `db.connect`/`fs.*` e (b) o reverse-map de nomes do client DeepSeek é montado só das tools oferecidas no turno — então `db_connect` não volta pra `db.connect`, o agente devolve INVALID_INPUT em tudo, e roda até MAX_INVOCATIONS=60 → falha.

## BUG A — reverse-map de nome de tool sempre completo
**Arquivos:** `src/modules/ai-setup/services/ai-setup-orchestrator.service.ts`; `src/modules/ai-setup/services/deepseek-llm.client.ts` (+ anthropic p/ consistência); testes correspondentes.

- [ ] Teste falhando (orchestrator): durante "forcing", o modelo retorna uma tool_call `db.connect`; o orquestrador deve invocar `db.connect` (com ponto) no bridge — NÃO `db_connect`. (Hoje, como o toolset é restringido a emit_mapping, o reverse-map perde db.connect.)
- [ ] Implementar: **o orquestrador SEMPRE passa o catálogo COMPLETO de tools ao LLM** (remover `tools: forcing ? [EMIT_MAPPING_TOOL] : tools` → usar sempre `tools`). Com isso o `originalBySanitized` do client cobre todos os nomes e o reverse-map sempre resolve. Manter o fallback existente do client (`originalBySanitized.get(name) ?? name`).
- [ ] (Defesa) garantir que o client DeepSeek/Anthropic monta o reverse-map de TODAS as `params.tools` recebidas (já faz) — só não restringir mais a lista.
- [ ] Rodar e passar. Commit.

## BUG B — forcing vira NUDGE + falha graciosa (sem restringir toolset)
**Arquivos:** mesmo orchestrator + constants; testes.

- [ ] Teste falhando: a IA NUNCA conecta (db.connect sempre falha/INVALID); ao passar o teto de exploração, a sessão deve (i) MANTER o toolset completo disponível (a IA pode continuar tentando conectar), (ii) injetar um NUDGE forte (uma vez/escalando) instruindo: "se você já tem uma conexão funcionando + schema, chame emit_mapping; se NÃO conseguiu localizar credenciais de banco, pare"; (iii) ao estourar MAX_INVOCATIONS sem nunca ter conectado, falhar com mensagem CLARA e específica (ex.: "A IA não localizou credenciais de banco utilizáveis na máquina do agente") — não o genérico "Limite de invocações excedido".
- [ ] Implementar:
  - Remover a restrição de toolset no forcing (já feito no BUG A); o "forcing" passa a ser só o nudge (manter `forcedNudgeSent`/escalonar).
  - Rastrear estado: `connectedOk` (true quando um `db.connect` retornou payload.ok===true) e se houve inspeção de schema. Usar pra compor a mensagem de falha terminal.
  - No teto de invocações: lançar InternalException com motivo dependente do estado (`!connectedOk` → "não localizou credenciais…"; conectou mas não propôs → "encerrou sem propor mapping").
  - Considerar reduzir o desperdício: se a IA repetir db.connect com params equivalentes que falham, a anti-repetição já bloqueia (manter).
- [ ] A facade já emite `ai.session.state: failed` com `detail` — garantir que o `detail` carregue a mensagem clara (já carrega error.message).
- [ ] Rodar `npx vitest run src/modules/ai-setup` verde + tsc limpo. Commit.

## Notas
- NÃO mexer no agente/web nesta entrega (só neo).
- Husky: subject ≤ ~90 chars, conventional pt-br, subject-only + footer Co-Author.
- Itens 3 (UI estilo ChatGPT) e 4 (usar conexão existente) ficam para depois.
