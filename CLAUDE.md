# Worktree — feat-pharma-agent-v2 · pharma-agent-v2

- **Frente:** feat-pharma-agent-v2
- **Repo origem:** pharma-agent-v2
- **Branch:** feat/pharma-agent-v2
- **Papel:** agent (pharma-agent-v2)
- **Objetivo:** desenvolvimento do pharma-agent-v2 (integração com web e neo).

## Regras (pharmatree)

- Esta é uma **worktree** — todo o trabalho da frente vive aqui, nunca no repo raiz.
- Antes de commitar, rode o procedimento **guard** (testes unitários + commit).
- Commits em **pt-br**, conventional, **subject-only** + footer Co-Author.
- A branch `feat/pharma-agent-v2` é a mesma nos repos `web-pharmachatbot` e
  `neo-api-pharmachatbot` desta frente.

## CLI de setup em desuso

- A CLI de setup interativa (`src/cli/database-setup.ts`, script `database-setup`)
  está **em desuso** e **não deve ser considerada** como fluxo ativo nem como fonte
  de verdade para suporte a drivers/setup.
- O setup oficial acontece via **PharmaConnector** (mensagem `connector.setup.config`
  por WebSocket / fluxo probe-driven do web + neo). Ao avaliar cobertura de driver,
  validação ou comportamento de setup, use esse caminho — não a CLI.
