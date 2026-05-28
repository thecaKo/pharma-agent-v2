# Painel-driven discovery: integração Neo + painel — Design

Data: 2026-05-28
Status: aprovado para implementação
Repositórios afetados: `web-pharmachatbot` (painel React), `neo-api-pharmachatbot` (Neo backend). Agente (`pharma-agent-v2`) já está pronto.

## Contexto

O agente já implementou:

- Discovery probes (`probe.engines`, `probe.odbc_dsns`, `probe.processes`, `probe.connections`, `probe.scan_config_dirs`, `probe.test_connection`, `probe.network`)
- Bootstrap mode + envelope `connector.bootstrap.dbConfig` para receber DB config remotamente
- Heartbeat com `state: "bootstrap" | "synced"` + counter `probesRunTotal`

Falta integrar essas capacidades no fluxo de onboarding do operador. Hoje o painel só oferece dois caminhos para o operador configurar um conector: **manual** (preenchimento à mão) e **file_discovery** (varredura por arquivos de DB conhecidos). Ambos exigem técnico na máquina do cliente. Esta spec adiciona um terceiro caminho — **probe_driven** — onde o operador comanda a descoberta remotamente.

A descoberta é **one-shot por máquina** (depois de aplicada a config, raramente precisa ser refeita), então a implementação é deliberadamente **stateless** no Neo: sem tabela de sessão, sem state machine, sem retomada entre abas. O painel mantém o estado em memória durante a sessão do operador.

## Objetivos

- Adicionar `setupMethod: "probe_driven"` ao painel, co-existindo com `manual` e `file_discovery`.
- Expor 3 endpoints HTTP stateless em Neo que proxiam probes ao agente via WS já existente.
- UI em 3 estados (idle → discovering → review → applying → applied/failed) renderizada num único componente, sem persistência.
- Rollout gradual via feature flag por company.

## Não-objetivos

- Persistir sessão de descoberta no Neo (operador refaz se fechar aba — operação de 15s).
- Tabela nova ou state machine no Neo.
- Suporte a múltiplos conectores por company no fluxo de descoberta (a UI atual já assume 1:1).
- Remover ou desabilitar os fluxos `manual` / `file_discovery`. Continuam suportados indefinidamente.
- Mudanças no agente. Toda capacidade necessária já existe.
- Conexão WS direta painel↔agente. Neo continua sendo o único bridge.

## Arquitetura

Três componentes envolvidos:

### Painel React (`web-pharmachatbot`)

Novo componente `ProbeDiscoverySection` em `src/pages/AgentConnectorPanel/`, ao lado de `ManualConnectionSection` e `FileDiscoverySection`. Renderiza wizard em 3 telas, mantém estado local via `useState`/`useReducer`, chama 3 endpoints Neo. Não persiste nada além do que já é persistido pelos endpoints atuais (readiness, identity, mapping).

### Neo backend (`neo-api-pharmachatbot`)

3 endpoints HTTP stateless sob `/pharma-agent-catalog/companies/{companyId}/setup/probe-discovery/`. Cada um envia `admin.request` ao agente via WS existente, agrega respostas, devolve ao painel. Sem persistência além de logs estruturados e auditoria. Reaproveita o WS client e padrões de proxy já usados em `/setup/file-discovery/scan` etc.

### Agente (`pharma-agent-v2`)

Já implementado. Aceita os comandos `probe.engines`, `probe.odbc_dsns`, `probe.processes`, `probe.connections`, `probe.scan_config_dirs`, `probe.test_connection`. Aceita envelope `connector.bootstrap.dbConfig` em bootstrap mode e transiciona para synced sem restart.

### Fluxo de dados resumido

```
Painel ──POST /discover──────────▶ Neo ──(sequência de 4 probes)──▶ Agente
                                    │  ◀────responses agregadas──────│
Painel ◀──{engines, dsns, processes, connections, candidate}
   ↓ render: "encontramos isso, complete credenciais"
   ↓ operador preenche password e clica "Testar e aplicar"

Painel ──POST /apply─────────────▶ Neo ──probe.test_connection─────▶ Agente
                                    │  ◀────ok=true, latencyMs=12────│
                                    │  ──connector.bootstrap.dbConfig▶│
                                    │  ◀────heartbeat state=synced───│
Painel ◀──{ applied: true, testResult }
   ↓ redireciona pro fluxo de mapping (já existe)
```

## Endpoints HTTP Neo

Todos sob `/pharma-agent-catalog/companies/{companyId}/setup/probe-discovery/`. Envelope `{ data }` padrão (igual aos endpoints existentes). Autenticação igual ao resto (`companies:read` para `/discover` e `/scan-configs`, `companies:write` para `/apply`).

### `POST /discover` (síncrono, ~10-15s)

Neo dispara em sequência: `probe.engines`, `probe.odbc_dsns`, `probe.processes`, `probe.connections`. Agrega responses e devolve, junto com um `candidate` pré-preenchido por heurística simples.

**Heurística do `candidate`:**

1. Pega o engine com maior `confidence` da lista `engines`; deriva `driver` (`sqlserver`/`postgresql`/`mysql`/`mariadb`/`firebird`).
2. Para `host`/`port`: usa o primeiro item de `connections` cujo `remotePort ∈ DB_PORTS` (do agente) e cujo engine bata com o do passo 1. Fallback: `127.0.0.1` + porta padrão do engine.
3. Para `database`/`user`: pega do primeiro `odbcDsns[]` cujo driver bata com o engine (ex: PSQLODBC para postgresql). Fallback: `null`.
4. `password`: sempre `null`. Operador preenche.

**Request:** `{}` (sem body. `connectorId` derivado do conector ativo da company).

**Response 200:**

```jsonc
{
  "data": {
    "engines": [
      { "kind": "sqlserver", "confidence": "high",
        "evidence": ["service:MSSQLSERVER", "port:1433", "dll:msodbcsql17.dll"] }
    ],
    "odbcDsns": [
      { "name": "LINX_PG", "driver": "PSQLODBC",
        "host": "10.0.0.5", "port": 5432, "database": "linx", "user": "ro" }
    ],
    "processes": [
      { "pid": 4128, "name": "Big.exe", "path": "C:\\Linx\\bin\\Big.exe" }
    ],
    "connections": [
      { "pid": 4128, "processName": "Big.exe",
        "localAddr": "127.0.0.1", "localPort": 49802,
        "remoteAddr": "127.0.0.1", "remotePort": 1433,
        "state": "ESTABLISHED" }
    ],
    "candidate": {
      "driver": "sqlserver",
      "host": "127.0.0.1",
      "port": 1433,
      "instance": null,
      "database": null,
      "user": null,
      "password": null,
      "trustServerCertificate": false
    }
  }
}
```

**Erros:**

- `404 not_found` — company/connector inexistente
- `424 failed_dependency` — conector offline (heartbeat há > 60s)
- `504 gateway_timeout` — alguma probe não respondeu em 15s

### `POST /scan-configs` (opcional, síncrono ~5-10s)

Usado quando o operador clica "Não está aqui? Buscar arquivos de config". Dispara `probe.scan_config_dirs` no agente.

**Request:**

```jsonc
{
  "roots": ["C:\\Linx", "%PROGRAMFILES%\\Linx"],
  "patterns": ["*.ini", "*.config"],   // opcional, usa default do agente se ausente
  "maxDepth": 3,                       // opcional, default do agente
  "maxFiles": 200,                     // opcional, default do agente
  "maxAgeDays": 90                     // opcional, sem default (sem filtro)
}
```

**Response 200:**

```jsonc
{
  "data": {
    "files": [
      { "path": "C:\\Linx\\config\\app.ini", "size": 2048, "mtime": "2026-05-15T14:30:00Z" }
    ],
    "truncated": false,
    "rootsRejected": [],
    "errors": []
  }
}
```

**Erros:**

- `400 invalid_input` — `roots` vazio ou > 32 itens, ou strings inválidas
- `424 failed_dependency` — conector offline
- `504 gateway_timeout` — agente não respondeu em 15s

### `POST /apply` (síncrono ~5-15s)

Recebe candidato preenchido, testa a conexão, aplica se ok.

**Request:**

```jsonc
{
  "driver": "sqlserver",
  "host": "127.0.0.1",
  "port": 1433,
  "instance": null,
  "database": "BIG",
  "user": "sa",
  "password": "***",
  "trustServerCertificate": false
}
```

**Comportamento:**

1. Neo monta `admin.request` com `command: "probe.test_connection"` carregando o candidato e envia ao agente. Timeout 8s.
2. Se `testResult.ok === false`: Neo devolve `200` com `{ applied: false, testResult }`. Operador corrige no painel e tenta de novo.
3. Se `testResult.ok === true`: Neo envia `connector.bootstrap.dbConfig` ao agente carregando o mesmo `database`. Aguarda heartbeat com `state: "synced"` (timeout 15s).
4. Se heartbeat synced chega: devolve `200` com `{ applied: true, testResult }`.
5. Se timeout no heartbeat: devolve `504 gateway_timeout`. Operador refaz; o agente trata novo `bootstrap.dbConfig` como idempotente (já em synced → ignora com warn).

**Response 200 (sucesso):**

```jsonc
{
  "data": {
    "applied": true,
    "testResult": { "ok": true, "latencyMs": 12 }
  }
}
```

**Response 200 (falha de auth):**

```jsonc
{
  "data": {
    "applied": false,
    "testResult": { "ok": false, "code": "auth", "message": "Login failed for user [REDACTED]" }
  }
}
```

Códigos possíveis de `testResult.code` (vindos do agente, já tipados): `auth | timeout | tls | unreachable | driver_missing | unknown`.

**Erros HTTP:**

- `424 failed_dependency` — conector offline antes do envio
- `504 gateway_timeout` — heartbeat synced não chegou em 15s após bootstrap.dbConfig (apply parcial)

## Painel React

### Localização

Novo arquivo `src/pages/AgentConnectorPanel/ProbeDiscoverySection.tsx`. Adicionar `'probe_driven'` ao `SETUP_METHOD_VALUES` em `types.ts`. Adicionar radio button no `SetupMethodSection.tsx` com label "Descoberta automática".

### Estado interno (React)

```ts
type DiscoveryStep =
  | "idle"
  | "discovering"
  | "review"
  | "applying"
  | "applied"
  | "failed_discovery"
  | "failed_apply";

interface ProbeDiscoveryState {
  step: DiscoveryStep;
  results: DiscoverResponse | null;
  candidate: ProbeDiscoveryCandidate;
  testResult: ApplyResponse["testResult"] | null;
  scanConfigs: ScanConfigsResponse | null;
  lastError: string | null;
}
```

`useReducer` para transições. Sem cache externo, sem persistência. Fechar aba reinicia o fluxo.

### Telas

**Tela 1 — `idle`:** card explicativo com botão "Iniciar descoberta". Botão fica disabled se `status.online === false` com tooltip "O conector está offline. Peça ao TI ligar a máquina."

**Tela 2 — `discovering`:** spinner com texto rotativo ("detectando processos...", "varredura de portas..."). Sem polling real de progresso — apenas feedback visual durante os 10-15s.

**Tela 3 — `review`:** lista com 3 colunas (banco detectado, ERP em execução, DSNs ODBC) cada uma renderizando os dados de `results`. Embaixo, form com campos do `candidate` pré-preenchidos. Validação inline: `database`, `user`, `password` obrigatórios. Botão "Testar e aplicar" disabled até preencher. Botão secundário "Não está aqui? Buscar arquivos de config" expande sub-section para `scan-configs` (input livre de `roots`, exibe lista de paths/sizes — v1 não tem ação avançada além de mostrar).

**Tela `applying`:** spinner curto.

**Tela `applied`:** ícone de sucesso + texto "Configuração aplicada", redirect automático em 2s para o `MappingStep` existente.

**Tela `failed_apply`:** mostra `testResult.code` e `message`. Dois botões: "Voltar e ajustar" (volta para `review` mantendo `candidate`) e "Tentar novamente" (reenvia `/apply` com o mesmo body).

**Tela `failed_discovery`:** mensagem clara baseada no status (`424` → "Conector offline", `504` → "Agente demorou para responder, tente de novo", outros → "Erro inesperado: [code]"). Botão "Voltar" → `idle`.

### Novos tipos em `types.ts`

```ts
export const SETUP_METHOD_VALUES = [
  'unset',
  'manual',
  'file_discovery',
  'probe_driven'
] as const;

export interface ProbeDiscoveryEngine {
  kind: string;
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];
}

export interface ProbeDiscoveryOdbcDsn {
  name: string;
  driver: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
}

export interface ProbeDiscoveryProcess {
  pid: number;
  name: string;
  path?: string;
}

export interface ProbeDiscoveryConnection {
  pid: number;
  processName?: string;
  localAddr: string;
  localPort: number;
  remoteAddr: string;
  remotePort: number;
  state: string;
}

export interface ProbeDiscoveryCandidate {
  driver: string;
  host: string;
  port: number;
  instance: string | null;
  database: string | null;
  user: string | null;
  password: string | null;
  trustServerCertificate: boolean;
}

export interface DiscoverResponse {
  engines: ProbeDiscoveryEngine[];
  odbcDsns: ProbeDiscoveryOdbcDsn[];
  processes: ProbeDiscoveryProcess[];
  connections: ProbeDiscoveryConnection[];
  candidate: ProbeDiscoveryCandidate;
}

export interface ScanConfigsInput {
  roots: string[];
  patterns?: string[];
  maxDepth?: number;
  maxFiles?: number;
  maxAgeDays?: number;
}

export interface ScannedFile {
  path: string;
  size: number;
  mtime: string;
}

export interface ScanConfigsResponse {
  files: ScannedFile[];
  truncated: boolean;
  rootsRejected: string[];
  errors: { path: string; reason: string }[];
}

export interface ApplyResponse {
  applied: boolean;
  testResult:
    | { ok: true; latencyMs: number }
    | { ok: false; code: string; message: string };
}
```

### Novos services em `services.ts`

3 funções novas seguindo o padrão dos existentes (`manualValidateConnection`/`fileDiscoveryScan`):

```ts
const probeDiscoveryBasePath = (companyId: number) =>
  `${pharmaCatalogCompanyPath(companyId)}/setup/probe-discovery`;

export async function probeDiscoveryDiscover(companyId: number): Promise<DiscoverResponse> {
  const response = await neoApi.post<NeoEnvelope<DiscoverResponse>>(
    `${probeDiscoveryBasePath(companyId)}/discover`,
    {}
  );
  return response.data.data;
}

export async function probeDiscoveryScanConfigs(
  companyId: number,
  input: ScanConfigsInput
): Promise<ScanConfigsResponse> {
  const response = await neoApi.post<NeoEnvelope<ScanConfigsResponse>>(
    `${probeDiscoveryBasePath(companyId)}/scan-configs`,
    input
  );
  return response.data.data;
}

export async function probeDiscoveryApply(
  companyId: number,
  candidate: ProbeDiscoveryCandidate
): Promise<ApplyResponse> {
  const response = await neoApi.post<NeoEnvelope<ApplyResponse>>(
    `${probeDiscoveryBasePath(companyId)}/apply`,
    candidate
  );
  return response.data.data;
}
```

### Heartbeat `state` (compatibilidade)

O agente passou a emitir `state: "bootstrap" | "synced"` no payload do heartbeat e `bootstrap.probesRunTotal` quando em bootstrap. O painel hoje consome `status.online` e `status.lastHeartbeat` do readiness endpoint do Neo. Para esta spec basta que o painel:

1. Ignore os campos novos (já é o comportamento default — TypeScript usa `unknown` para campos extras em JSON).
2. Opcionalmente: o readiness endpoint do Neo pode passar `state` adiante como `connectorState: "bootstrap" | "synced"` em `AgentConnectorStatus`, e a UI mostrar um badge. **Fora do escopo desta spec** — fica para uma melhoria posterior.

## Segurança

- **Senha** trafega apenas em `POST /apply`. Neo não persiste, não loga, não retorna. Após enviar `bootstrap.dbConfig` ao agente, o handler explicitamente faz `body.password = undefined` antes de retornar.
- **Mensagens de erro** de `testResult` vêm pré-redigidas do agente (substring de password é substituída por `[REDACTED]` no próprio adapter de DB). Neo passa adiante sem modificar.
- **`/apply`** exige permissão `companies:write` do usuário autenticado. `/discover` e `/scan-configs` exigem `companies:read`.
- **`/scan-configs.roots`** não é validado por Neo — passa cru pro agente. O agente tem deny-list intransponível (`C:\`, `C:\Windows`, etc.) que rejeita roots perigosos mesmo se o painel pedir explicitamente. Defesa em camadas.
- **Auditoria** registra um único evento `audit.probe_discovery.applied` quando `applied: true` é retornado, contendo `companyId`, `connectorId`, `userId`, `dbDriver`, `dbHost`, `dbName`, `dbUser`, `appliedAt`. Nunca password.

## Observabilidade

Logs estruturados em Neo, padrão do projeto:

- `probe_discovery.discover.start` / `.ok` / `.failed`
- `probe_discovery.scan_configs.start` / `.ok` / `.failed`
- `probe_discovery.apply.test_only` (testResult.ok === false)
- `probe_discovery.apply.success`
- `probe_discovery.apply.timeout`

Cada evento carrega `companyId`, `connectorId`, `userId`, `durationMs`. Sumários numéricos sem PII (ex: `summary.engineCount: 1`).

Métricas (Prometheus/Datadog conforme padrão atual do Neo):

- `probe_discovery_discover_duration_seconds` (histogram)
- `probe_discovery_apply_outcome_total{result="success|auth_failed|timeout|offline"}` (counter)

## Tratamento de erro do WS Neo↔agente

Reusa o WS client já existente em Neo (`file-discovery/scan` já usa).

- **Conector offline** (`isOnline === false` ou heartbeat > 60s): endpoint devolve `424 failed_dependency` imediatamente, sem tentar enviar.
- **Probe timeout** (sem `admin.response` em 15s): cancela o request_id, devolve `504` (em `/discover`/`/scan-configs`) ou `testResult: { ok: false, code: "timeout" }` (em `/apply.test`).
- **WS disconnect durante request**: trata como falha; devolve `504`. Sem retry automático.
- **Apply parcial** (bootstrap.dbConfig enviado mas heartbeat synced não chegou em 15s): devolve `504`. Operador refaz; agente é idempotente.

## Testes

### Neo backend

- **Unit/integration**: cada endpoint com fake WS client mockando responses do agente. Cobre: happy path, conector offline, timeout, scan_configs com erro de input, apply com testResult.ok=false, apply com timeout em heartbeat.
- **Contract tests**: shape de `admin.request` enviado bate com `AdminCommand` do agente (cópia da union em fixture).
- **E2E em CI**: container do agente real (linux — probes retornam `[]` mas o caminho completo é exercitado). Confirma serialização do protocolo.

### Painel React

- **Unit do reducer**: idle → discovering → review → applying → applied; rotas de erro.
- **Component test** (`ProbeDiscoverySection.test.tsx`): mocks de `probeDiscoveryDiscover/Apply`, verifica que após `/apply` ok=true a navegação para `MappingStep` é chamada.
- **Cypress E2E**: 1 cenário happy path completo (login → entrar em conector → escolher "Descoberta automática" → discover → preencher senha → aplicar → ir para mapping).

## Rollout

- **Sem migration de DB.** Implementação stateless.
- **Feature flag** `feature_probe_driven_setup` por company (padrão atual do Neo). Habilita: endpoint Neo retorna `404 not_found` se flag off; painel oculta o radio button.
- **Fases:**
  1. Habilitar flag para 2-3 clientes piloto com SQL Server (validar happy path em produção).
  2. Coletar feedback de UX por ~1 semana.
  3. Habilitar global. Manter `manual` e `file_discovery` indefinidamente como fallback (não há intenção de descontinuar).

## Plano de entrega

Cada fase é mergeable e desplugável independentemente. Backend Neo e frontend trabalham em paralelo após Fase 1.

1. **Contrato HTTP fechado** — este spec serve como contrato. Sem código. ✓ aprovado.
2. **Neo endpoints stateless** (`/discover`, `/scan-configs`, `/apply`) — 3 endpoints com WS proxy + testes. Estimativa: 2-3 dias.
3. **Painel `ProbeDiscoverySection`** + tipos + services + testes — 1 componente novo, 1 radio adicional, 3 funções de service, ~6 tipos novos. Estimativa: 2-3 dias.
4. **Cypress E2E happy path + rollout via feature flag** — 1 cenário + configuração de flag. Estimativa: 1 dia.

Total: **~1 sprint** com paralelismo entre times.

## Riscos e mitigações

- **Probe completion variável (>15s)** em máquinas lentas. Mitigação: timeout configurável por env var no Neo; padrão 15s. Se ficar problemático, considerar mover `/discover` para assíncrono (volta a ter sessão — versão complexa). Improvável.
- **`scan-configs` traz lista muito grande mesmo com cap (200 arquivos)**. Mitigação: painel limita exibição a primeiros 50 com "ver mais", e operador filtra por substring no client side.
- **WS Neo↔agente cai durante apply**. Mitigação: bootstrap.dbConfig é idempotente. Operador refaz.
- **Conector volta a bootstrap por algum motivo (ex: reset manual em ProgramData)** após estar synced. Mitigação: o painel pode rodar `/discover` de novo a qualquer momento sem efeito colateral. Não há proteção contra re-aplicação.
- **Heurística do `candidate` erra a sugestão.** Mitigação: operador pode editar tudo. O candidato é só pré-preenchimento, nunca obrigatório. Aceitamos UX imperfeito em casos exóticos.

## Sucesso

Esta entrega é bem-sucedida quando:

- Operador consegue configurar conector em máquina Windows com SQL Server em **< 2 minutos** sem precisar de técnico na máquina, partindo de "conector instalado, online" até "synced + mapping aberto".
- Taxa de uso do `probe_driven` ultrapassa `file_discovery` em 30 dias após rollout global.
- Zero incidente de senha vazada em log ou response (mensagens redigidas funcionam).
- Tempo médio de `/discover` < 15s em produção (P95).
