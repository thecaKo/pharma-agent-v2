# Discovery multi-ERP e robustez de conexão — Design

Data: 2026-05-27
Status: aprovado para implementação

## Contexto e problema

O agente roda como Windows Service na máquina do cliente e conecta no banco do ERP local para sincronizar dados com o painel central. Hoje suporta PostgreSQL, MySQL, MariaDB e Firebird, com descoberta limitada (DSN PSQLODBC, registry reader, file discovery por extensão conhecida).

As duas maiores dores de campo identificadas:

1. **Engines não suportados.** Vários ERPs do segmento (Linx, TOTVS, etc.) rodam em SQL Server e o agente ainda não fala esse driver. Engines de cauda longa (Oracle, Sybase Advantage, Progress) aparecem ocasionalmente.
2. **Descoberta de credenciais/host/porta.** Hoje um técnico humano precisa acessar a máquina do cliente, identificar se é banco local ou arquivo, caçar arquivos de config do ERP e extrair connection strings. Processo manual, lento, depende de pessoas e não escala.

O fluxo atual de onboarding via `database-setup` CLI exige técnico no terminal da máquina do cliente. Queremos um modelo onde o **painel central comanda a descoberta remotamente** via canal WS já existente, e o agente é executor confiável de sondas locais.

## Objetivos

- Adicionar adapter nativo para **SQL Server** (driver `mssql`).
- Adicionar adapter genérico **ODBC** (driver `odbc`) como fallback para engines de cauda longa que tenham driver ODBC instalado no Windows.
- Permitir que o painel central **execute discovery remotamente** via uma família de probes sobre `admin.request`/`admin.response`.
- Permitir que o service rode em **bootstrap mode** sem config de DB válida — conectado ao WS, aceitando probes, esperando `connector.config` para transicionar a synced.
- Não introduzir breaking change no fluxo CLI local atual (`database-setup` continua funcionando).

## Não-objetivos

- Windows Authentication para SQL Server (fica para fase 2 — exige `msnodesqlv8`, validar em campo).
- UI do painel para orquestrar discovery (fora deste agente; é dependência externa).
- Novos engines nativos além de SQL Server (Oracle/Progress/etc. ficam cobertos via ODBC ou por specs futuros).
- Tradução automática de SQL entre dialetos no adapter ODBC. Painel envia SQL específico do dialeto.

## Arquitetura

Três trabalhos paralelos que se compõem:

### Discovery Protocol (transport)

Reusa o padrão `admin.request` / `admin.response` existente em `src/transport/protocol.ts`. Discovery não introduz envelopes novos — apenas uma nova família de `action`s no payload de admin. Permite painel pedir e agente responder com `requestId` ecoado.

### Discovery Engine (`src/discovery/`)

Pasta nova. Um módulo por probe (`engines.ts`, `odbc-dsns.ts`, `erp-fingerprint.ts`, `config-files.ts`, `test-connection.ts`, `network.ts`). Cada módulo expõe `run(input, ctx): Promise<Result>` e recebe dependências (`RegistryReader`, `FileSystemReader`, `serviceList`) injetadas para teste unitário sem disco/registry reais. Reusa `RegistryReader` existente e generaliza `dsn-discovery.ts`.

### Bootstrap mode (runtime)

`config/env.ts` aceita ausência de campos de DB como config válida do tipo `{ kind: "bootstrap" }`. `service/runtime.ts` detecta o tipo e:

- não instancia adapter, não inicia poller;
- conecta WS, envia heartbeat com `state: "bootstrap"`;
- registra handlers de `admin.request` para probes;
- envia `connector.discovery` snapshot inicial com `mode: "bootstrap"`.

Quando `connector.config` válido chega pelo WS, runtime persiste no artifact existente e **transiciona para modo normal sem restart**: instancia adapter, inicia poller, atualiza heartbeat para `state: "synced"`. Se a config falhar (driver missing, auth, etc.), volta para bootstrap e devolve `connector.error`.

### Adapters novos

- `SqlServerSourceAdapter` (`src/db/sqlserver-adapter.ts`).
- `OdbcSourceAdapter` (`src/db/odbc-adapter.ts`).

Ambos seguem o padrão de `MariaDbSourceAdapter` — `ConnectionFactory` injetada, `optionalImport` do pacote npm na factory do runtime, `case` novo em `adapter-factory.ts`, kind novo em `SourceDatabaseAdapterKind`.

### Diagrama

```
Painel ──admin.request{action:"probe.engines"}──▶ Service (bootstrap mode)
                                                   │
                                                   ▼
                                            src/discovery/engines.ts
                                                   │
Painel ◀──admin.response{ok,payload:{engines}}─── Service
                       ...iterações...
Painel ──connector.config{driver:"sqlserver",...}─▶ Service → transição → synced
```

## Catálogo de probes

Cada probe é uma `action` em `admin.request`. Resposta simétrica em `admin.response` com `requestId` ecoado. Erros viram `admin.response` com `ok: false` e `error: { code, message }` — códigos categóricos, nunca stack trace cru.

| action                    | input                                                        | resposta resumida                                                                             |
| ------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `probe.engines`           | `{}`                                                         | `engines: [{kind, evidence:["service:MSSQLSERVER","port:1433"], confidence}]`                 |
| `probe.odbc_dsns`         | `{}`                                                         | `dsns: [{name, driver, host?, port?, database?, user?}]`                                      |
| `probe.erp_fingerprint`   | `{}`                                                         | `erps: [{id:"linx-big", paths:["C:\\Linx\\Big\\config.ini"], confidence}]`                    |
| `probe.config_files`      | `{paths: string[]}`                                          | `files: [{path, format, candidates:[{key, value, looksLikeSecret}]}]`                         |
| `probe.network`           | `{host, port, timeoutMs}`                                    | `{reachable, latencyMs?, error?}`                                                             |
| `probe.test_connection`   | `{driver, host?, port?, instance?, database?, user?, password?, dsn?, connectionString?, options?}` | `{ok, latencyMs, serverVersion?}` ou `{ok:false, code, message}`                              |

### Regras transversais

- **Timeout máximo server-side** por probe, enforçado pelo executor do agente via `AbortSignal`. Defaults: `probe.engines` 8s, `probe.test_connection` 5s, `probe.network` 3s, `probe.config_files` 4s.
- **Sigilo:** `probe.config_files` NUNCA devolve valores que casam com regex de senha/token. Devolve `looksLikeSecret: true` e a chave; valor é omitido. Senhas reais só viajam no caminho `connector.config` (canal existente).
- **Read-only:** `probe.test_connection` abre conexão, faz `SELECT 1` ou equivalente, fecha. Nunca emite DML.
- **Idempotência:** todos os probes são read-only e seguros para reexecutar.
- **Versionamento:** cada response inclui `probeVersion: "1"`. Painel pode rejeitar versões desconhecidas sem travar o agente.

### Códigos de erro canônicos (`probe.test_connection`)

`auth | timeout | tls | unreachable | driver_missing | unknown`. Mapeamento centralizado em `src/discovery/error-codes.ts` — recebe `unknown` do driver e classifica por inspeção de `message` (econnrefused → unreachable, login failed/28000 → auth, etc.).

## Detalhamento dos probes

### `probeEngines`

Une evidências por engine. Não inventa: só reporta o que viu.

- **Serviços Windows** via `sc query type=service state=all` parseado:
  - SQL Server: `MSSQLSERVER`, `MSSQL$*`, `SQLBrowser`
  - PostgreSQL: `postgresql-x64-*`
  - MySQL/MariaDB: `MySQL*`, `MariaDB`
  - Firebird: `FirebirdServer*`
- **Portas locais listening** via `netstat -ano` ou tentativa de connect curtíssima em localhost: 1433, 5432, 3306, 3050.
- **DLLs/binários conhecidos** em `C:\Program Files*\`: `gds32.dll`, `fbclient.dll` (Firebird); `libpq.dll` (Postgres); `sqlncli11.dll`, `msodbcsql*.dll` (SQL Server).

Cada engine retornado vem com `confidence: "high" | "medium" | "low"` baseado em quantas categorias de evidência bateram (3+ = high, 2 = medium, 1 = low).

### `probeOdbcDsns`

Generalização do `dsn-discovery.ts` atual: lê os mesmos paths de registry, sem filtrar por PSQLODBC. Retorna todas as DSNs com seu driver. Mantém função `discoverPostgresDsns` exportada por compatibilidade (chama a genérica e filtra).

### `probeErpFingerprint`

Tabela de assinaturas conhecidas em `src/discovery/erp-signatures.ts`. Começa pequena, cresce com tempo:

```ts
const ERP_SIGNATURES = [
  { id: "linx-big", markers: [
      { type: "file", path: "C:\\Linx\\Big\\config.ini" },
      { type: "registry", path: "HKLM\\Software\\Linx\\Big" }
    ], configPaths: ["C:\\Linx\\Big\\config.ini"] },
  { id: "totvs-protheus", markers: [
      { type: "dir", path: "C:\\TOTVS\\Protheus" },
      { type: "service", name: "TOTVS_AppServer" }
    ], configPaths: ["C:\\TOTVS\\Protheus\\bin\\appserver\\appserver.ini"] }
];
```

Cada ERP detectado vem com `configPaths` (caminhos prováveis) — alimenta a próxima chamada `probe.config_files`.

### `probeConfigFiles`

Recebe lista de paths. Identifica formato pela extensão (`.ini`, `.xml`, `.json`, `.config`, `.properties`). Parsea com parsers leves (`ini` da stdlib equivalente + regex para os outros — sem deps pesadas).

Para cada par chave/valor encontrado:

- Heurística por nome de chave (`host`, `server`, `database`, `db`, `user`, `uid`, `port`, `instance`) → marca como candidato relevante.
- Chaves de senha (`password`, `pwd`, `senha`) ou valores que parecem hash/base64 longa → retorna `{ key, looksLikeSecret: true }` SEM valor.
- Connection string completa (`Server=...;Database=...`) → explode em pares antes de aplicar heurísticas.

### `probeNetwork`

Sondagem TCP barata. `net.createConnection` para `{host, port}` com `timeoutMs`. Retorna `{reachable: true, latencyMs}` em sucesso, `{reachable: false, error: "timeout" | "refused" | "unreachable" | "unknown"}` em falha. Útil para painel evitar `probe.test_connection` quando porta nem está aberta.

### `probeTestConnection`

Wrapper que monta `DatabaseConfig` temporário, chama `createSourceDatabaseAdapter` (mesma factory do runtime), executa `connect()` + `listTables()` (com `LIMIT 1` lógico onde possível) + `close()`, tudo sob `AbortSignal` com timeout. Categoriza erro do driver via `categorizeError` em `error-codes.ts`.

## Adapter SQL Server

Arquivo `src/db/sqlserver-adapter.ts`, padrão de `mariadb-adapter.ts`.

**Driver:** `mssql` (npm), em `optionalDependencies`. Razões: API mais amigável que `tedious` puro (que é a base), suporta named instances, pooling embutido.

**Forma:**

```ts
export type SqlServerConnectionFactory = (config: SqlServerConnectionInput) => Promise<SqlServerConnection>;

export class SqlServerSourceAdapter implements SourceDatabaseAdapter {
  // connect(): abre pool, SELECT @@VERSION para warmup
  // queryChanges/querySnapshotPage: request.query parametrizada
  // listTables: SELECT name FROM sys.tables ORDER BY name
  // listColumns: SELECT name, system_type_id, is_nullable FROM sys.columns WHERE object_id = OBJECT_ID(@table)
  // close(): drena o pool
}
```

**Especificidades:**

- **Named instance:** `DatabaseConfig` ganha campo opcional `instance?: string`. Quando presente, monta `server: "host\\instance"` e ignora `port` (SQL Browser resolve). Quando ausente, usa `host` + `port` (default 1433). `instance` e `port` definidos juntos: rejeita com mensagem clara na validação.
- **Auth:** apenas SQL Auth na fase 1. Campo `auth?: "sql" | "windows"` aceito na config para forward-compat, mas `windows` rejeitado com `"requires phase 2 / msnodesqlv8"`.
- **TLS:** `encrypt: true` por default; `trustServerCertificate` configurável (comum cert self-signed corporativo).
- **Cursor incremental:** `OFFSET ... FETCH NEXT ... ROWS ONLY` (SQL Server 2012+).

**Wiring:**

- `SourceDatabaseAdapterKind` ganha `"sqlserver"`.
- `DatabaseDriver` aceita `"sqlserver"`.
- `adapter-factory.ts` ganha `case "sqlserver"` com `sqlserverConnectionFactory`.
- `runtime.ts` faz `optionalImport('mssql')`.

## Adapter ODBC

Arquivo `src/db/odbc-adapter.ts`. Driver `odbc` (npm), em `optionalDependencies`.

**Quando entra:** engines de cauda longa com driver ODBC instalado no Windows (Oracle via Oracle Instant Client + ODBC, Sybase Advantage, Progress, Interbase, DB2).

**Config:**

```ts
{
  driver: "odbc",
  dsn?: string,                    // forma 1
  connectionString?: string,       // forma 2
  user?: string,
  password?: string,
  dialect?: "ansi" | "oracle" | "sybase" | "progress" | "generic"  // default "generic"
}
```

Validação: exatamente um de `dsn` ou `connectionString` obrigatório.

**SQL flavor:**

- Queries de produto/cursor (`queryChanges`, `querySnapshotPage`) usam SQL enviado pelo painel via `connector.config`. Adapter não traduz nada.
- `listTables` / `listColumns` (usadas em discovery) precisam de dialect:
  - `ansi` | `generic`: `INFORMATION_SCHEMA.TABLES` / `INFORMATION_SCHEMA.COLUMNS`
  - `oracle`: `ALL_TABLES` / `ALL_TAB_COLUMNS`
  - `sybase`: `sysobjects WHERE type='U'`
  - `progress`: catálogo Progress equivalente

**Tradeoffs assumidos:**

- Sem pooling sofisticado — pool básico do `odbc`, suficiente para poller serial.
- `dataType` em `listColumns` é a string crua do driver. Mapping é resolvido upstream no painel.

## Bootstrap mode

**`config/env.ts`:**
Aceita ausência total dos campos `DB_*` (ou explícito `DB_DRIVER=__bootstrap__`) como config válida do tipo `{ kind: "bootstrap" }`. Configs completas continuam produzindo `{ kind: "configured", driver, ... }`.

**`service/runtime.ts`:**
Detecta `kind: "bootstrap"` e não instancia adapter, não inicia poller. Apenas:

- conecta WS;
- heartbeat com `state: "bootstrap", bootstrap: { lastProbeAt, probesRunTotal, lastProbeError? }`;
- registra handlers de `admin.request` para probes em `src/discovery/admin-router.ts`;
- envia `connector.discovery` snapshot inicial com `mode: "bootstrap"`.

**Transição bootstrap → synced:**
Quando `connector.config` válido chega:

1. Valida config (schema atual).
2. Tenta `probe.test_connection` interno com a config recebida.
3. Se ok: persiste no artifact (`~/.pharma-agent/database-setup.json` ou ProgramData), instancia adapter, inicia poller, atualiza heartbeat para `state: "synced"`. Sem restart.
4. Se falha: mantém bootstrap, envia `connector.error` com `code` categorizado.

**Instalador / primeira execução:**

- `database-setup` CLI continua funcionando exatamente como hoje. Caminho local não muda.
- Se `database-setup` NÃO foi rodado, service sobe em bootstrap em vez de abortar — espera painel.
- README ganha seção "fluxo painel-driven vs CLI local — ambos suportados".

**Segurança bootstrap:**

- Aceita `admin.request` apenas via WS autenticado (mesmo token que valida hoje). Sem WS = sem probe.
- Nenhum probe escreve em disco do cliente. Discovery é puramente leitura.

## Observabilidade

- Todos os probes emitem log estruturado (`src/logging/` atual) com `probe`, `durationMs`, `outcome`. Senhas/connection strings completas nunca vão para o log — usa sanitizador `secrets` já presente nos adapters.
- Heartbeat em bootstrap inclui contador `probesRunTotal`, `lastProbeAt`, `lastProbeError?`. Painel observa atividade sem precisar abrir log.

## Testes

- **Unit (vitest, padrão atual):** cada probe com `RegistryReader` / `FileSystemReader` / `serviceList` mockados. Cada adapter com `ConnectionFactory` mockada. Cobertura > 90% nos módulos novos.
- **Contract tests:** snapshot tests dos shapes de `admin.request` / `admin.response` para cada probe — mudanças no protocolo quebram visivelmente.
- **Integração (`docker-compose.test.yml`):** adicionar container `mcr.microsoft.com/mssql/server:2022-latest` atrás de flag `MSSQL_INTEGRATION=1` (imagem pesada, ~1.5 GB). Manter Postgres/MySQL/Firebird.
- **ODBC integração:** smoke manual documentado — instalar Postgres ODBC driver localmente, testar contra Postgres docker existente.
- **Smoke manual painel-driven:** roteiro em `docs/superpowers/specs/smokes/` para validar discovery numa VM Windows com SQL Server + Linx Big simulado.

## Riscos e mitigações

- **`mssql` driver pesado em disco / instalador maior.** Mitigação: `optionalDependencies` — instalador empacota só se cliente declarar uso. Avaliar no installer step.
- **`odbc` requer compilação nativa (node-gyp).** Já temos isso em `firebird-driver`. Documentar dependências de build no README do dev. Build em CI cobre.
- **Falsos positivos em `probe.config_files`.** Mitigação: heurística conservadora; painel decide o que apresentar para operador humano confirmar.
- **Bootstrap mode abrir superfície de ataque.** Mitigação: probes só leem; autenticação WS exigida; nenhum probe executa SQL fora de `SELECT 1`/`listTables`.
- **`probeEngines` via `sc.exe` / `netstat` exige permissão.** Mitigação: service roda como `LocalSystem` (já é o caso); fallback degradado se sem permissão.

## Plano de entrega (fases sugeridas)

Cada fase é mergeable independentemente e entrega valor parcial.

1. **Adapter SQL Server** standalone (sem discovery nova). Permite cliente Linx/TOTVS via `database-setup` CLI tradicional.
2. **Probes engine/odbc_dsns/network** + `admin-router` (sem bootstrap mode). Painel pode sondar máquinas onde service já está synced.
3. **Bootstrap mode + transição**. Habilita fluxo painel-driven completo desde primeira instalação.
4. **Probes erp_fingerprint + config_files**. Heurísticas de ERP conhecidos, começando com Linx Big.
5. **Adapter ODBC genérico**. Cobertura de cauda longa.

Decomposição em planos de implementação separados (um por fase) fica para a próxima etapa via `writing-plans`.
