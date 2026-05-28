# Discovery: probes de processo, conexão e varredura de config — Design

Data: 2026-05-28
Status: aprovado para implementação

## Contexto

A Fase 4 do roadmap de discovery (`probe.erp_fingerprint` + `probe.config_files`) cobre ERPs conhecidos via tabela de assinaturas estáticas. Para casos de cauda longa — ERPs não catalogados, instalações customizadas — é preciso descobrir o que está rodando observando o sistema vivo: processos ativos, conexões TCP estabelecidas, arquivos de config dentro das pastas certas.

Três probes novas resolvem isso, mantendo o princípio "agente executa, painel orquestra":

- **`probe.processes`** — lista processos rodando com `path` da executável.
- **`probe.connections`** — lista conexões TCP estabelecidas em portas de banco conhecidas, cruzadas com PID/nome de processo.
- **`probe.scan_config_dirs`** — varre diretórios prioritários por arquivos de configuração (metadata only), com guardrails contra varredura ampla.

Tipicamente o painel orquestra: `processes` → cruza com `connections` → deriva roots a partir dos paths das exes → `scan_config_dirs` → seleciona arquivos relevantes → `probe.config_files` (Fase 4) para parsear.

## Objetivos

- Permitir ao painel identificar o ERP em uso observando o sistema, sem depender de tabela de signatures.
- Cruzar PID de processo com porta de banco para inferir qual processo fala com qual banco.
- Varrer diretórios prioritários por arquivos de config de forma segura (deny-list intransponível) e eficiente (filtro por extensão na enumeração, limites de profundidade e quantidade).
- Cobertura Windows. Linux/macOS retornam vazio (não-target).

## Não-objetivos

- Leitura de conteúdo dos arquivos durante `scan_config_dirs` — só metadata (`path`, `size`, `mtime`). Conteúdo sai por `probe.config_files` (Fase 4) com regras de redação de senhas.
- Banner grabbing de bancos por TCP (handshake especulativo). Risco operacional, ganho marginal sobre `probe.engines` já existente.
- Leitura de memória de processo, env vars de processo específico. Risco AV/EDR alto, ganho não justifica.
- Heurísticas de "qual ERP está rodando" no agente. Cruzamentos ficam no painel — mais fácil iterar sem redeploy.
- Modificação de qualquer estado do cliente. Probes são read-only.

## Arquitetura

Três módulos novos em `src/discovery/`, todos seguindo o padrão dos probes existentes (Fase 2): função pura recebendo `ProbeContext`, dependências injetáveis, sem side effects fora do disco/processos do sistema.

### Componentes

- `src/discovery/processes.ts` — `probeProcesses(ctx)` retorna `ProcessCandidate[]`.
- `src/discovery/process-list.ts` — `listWindowsProcesses()` default via `wmic process get ProcessId,Name,ExecutablePath /format:csv`; exporta parser puro `parseWmicProcessOutput(raw)`.
- `src/discovery/connections.ts` — `probeConnections(ctx)` retorna `ConnectionCandidate[]`.
- `src/discovery/connection-list.ts` — `listWindowsConnections()` default via `netstat -ano -p TCP`; exporta parser puro `parseNetstatOutput(raw)`.
- `src/discovery/scan-config-dirs.ts` — `probeScanConfigDirs(ctx, input)` retorna `ScanConfigDirsResult`.

### Extensões em estruturas existentes

`ProbeContext` (em `src/discovery/types.ts`) ganha dois hooks:

```ts
export interface WindowsProcess { pid: number; name: string; path?: string; }
export interface WindowsConnection {
  pid: number; localAddr: string; localPort: number;
  remoteAddr: string; remotePort: number;
  state: string;
}

export interface ProbeContext {
  registry: RegistryReader;
  fs: FileSystemReader;
  serviceList: () => Promise<WindowsService[]>;
  listProcesses: () => Promise<WindowsProcess[]>;     // novo
  listConnections: () => Promise<WindowsConnection[]>; // novo
  signal: AbortSignal;
}
```

`FileSystemReader` (em `src/discovery/fs-reader.ts`) ganha enumeração single-level eficiente:

```ts
export interface FsEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  size?: number;
  mtime?: Date;
}

export interface FileSystemReader {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  listDir(path: string): Promise<string[]>;
  stat(path: string): Promise<FsStat | undefined>;
  enumerateTop(path: string): Promise<FsEntry[]>; // novo — readdir + stat em uma passada
}
```

`enumerateTop` usa `fs.readdir(path, { withFileTypes: true })` + `fs.stat` por entry. Implementação default já está em `nodeFileSystemReader`.

### Extensões no protocolo

`AdminCommand` (em `src/transport/protocol.ts`) e `ADMIN_COMMANDS` set ganham três valores:

```ts
| "probe.processes"
| "probe.connections"
| "probe.scan_config_dirs"
```

### Extensões no admin-router

`src/discovery/admin-router.ts` `AdminRouterDependencies` ganha três funções:

```ts
probeProcesses: () => Promise<ProcessCandidate[]>;
probeConnections: () => Promise<ConnectionCandidate[]>;
probeScanConfigDirs: (input: ScanConfigDirsInput) => Promise<ScanConfigDirsResult>;
```

Cases novos no switch + validador `validateScanConfigDirsInput`.

### Extensões no runtime

`src/service/runtime.ts` `buildAdminRouterDeps()` envelopa as três novas funções com `wrapProbe` (alimentando `bootstrapState`), conforme padrão Fase 2/3.

## `probe.processes`

**Input:** `{}` (nenhum parâmetro).

**Output:**

```ts
interface ProcessCandidate { pid: number; name: string; path?: string; }
{ processes: ProcessCandidate[] }
```

**Implementação:** `wmic process get ProcessId,Name,ExecutablePath /format:csv` com timeout 8s, maxBuffer 8 MB. WMIC traz as três colunas necessárias em uma única chamada (PID, name, path completo). Parser puro extrai cada linha CSV. Cross-platform: retorna `[]`.

WMIC está deprecated no Windows 11/Server 2022 mas ainda presente; fallback recomendado é PowerShell `Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath | ConvertTo-Csv -NoTypeInformation`. A factory padrão tenta WMIC primeiro, fallback para PowerShell se WMIC falhar (timeout ou exit code não-zero). Parser é o mesmo (CSV).

**Filtro de ruído:** lista hardcoded curta de processos do sistema descartados (`System`, `Idle`, `Registry`, `csrss.exe`, `lsass.exe`, `services.exe`, `winlogon.exe`, `wininit.exe`).

**Privacidade:** retorna apenas `pid`, `name`, `path`. WMIC pode retornar outras colunas em alguns ambientes — o parser descarta qualquer campo não listado.

**Tradeoffs assumidos:**

- WMIC + PowerShell fallback é mais lento que `tasklist` (~1-2s para WMIC), mas é o único caminho confiável para path da exe. Aceitável.
- Em máquinas com 200+ processos o payload chega a 30-50 KB. Aceitável.

## `probe.connections`

**Input:** `{}`.

**Output:**

```ts
interface ConnectionCandidate {
  pid: number;
  processName?: string;       // cruzado via listProcesses
  localAddr: string;
  localPort: number;
  remoteAddr: string;
  remotePort: number;
  state: string;              // "ESTABLISHED" filtrado, raramente outros
}
{ connections: ConnectionCandidate[] }
```

**Implementação:** `netstat -ano -p TCP` com timeout 5s. Parser puro identifica linhas `TCP <localAddr>:<localPort> <remoteAddr>:<remotePort> <state> <pid>`. Aceita IPv4 e IPv6 (`[::1]:1433` etc).

**Filtros aplicados pelo agente:**

- Apenas `state === "ESTABLISHED"`.
- Apenas conexões onde `remotePort` ou `localPort` está em `DB_PORTS` (lista hardcoded abaixo).

```ts
const DB_PORTS = new Set([
  1433,   // SQL Server
  5432,   // PostgreSQL
  3306,   // MySQL / MariaDB
  3050,   // Firebird
  1521,   // Oracle TNS
  1583,   // Sybase Advantage
  50000,  // DB2
  27017   // MongoDB
]);
```

**Cruzamento PID→nome:** após filtrar, chama `safeListProcesses(ctx)` uma vez e monta `Map<pid, name>` para preencher `processName`. Se a listagem de processos falhar, `processName` fica `undefined` (não aborta).

**Permissões:** `netstat -ano` precisa de PID confiável; service rodando como `LocalSystem` resolve.

**Tradeoffs assumidos:**

- Adicionar engines exige redeploy do agente. Aceitável — essas portas são estáveis há décadas.
- Cruzar PID→nome no agente custa uma chamada extra de `tasklist` mas evita round-trip ao painel.

## `probe.scan_config_dirs`

A probe mais sensível em segurança e performance. Aplica integralmente as diretrizes discutidas.

**Input:**

```ts
interface ScanConfigDirsInput {
  roots: string[];           // obrigatório, 1..32 itens; aceita %VAR% (expandido)
  patterns?: string[];       // default DEFAULT_PATTERNS
  maxDepth?: number;         // default 3, máx aceito 5
  maxFiles?: number;         // default 200, máx aceito 1000
  maxAgeDays?: number;       // default undefined (sem filtro)
}
```

**Output:**

```ts
interface ScannedFile { path: string; size: number; mtime: string; /* ISO */ }
interface ScanError { path: string; reason: "permission" | "missing" | "unknown"; }

interface ScanConfigDirsResult {
  files: ScannedFile[];
  truncated: boolean;
  rootsRejected: string[];   // roots filtrados pela deny-list
  errors: ScanError[];
}
```

### Defaults

```ts
const DEFAULT_PATTERNS = [
  "*.ini", "*.conf", "*.config",
  "*.json", "*.xml", "*.yaml", "*.yml",
  "*.env", "*.properties",
  "*.db", "*.sqlite", "*.db3"
];

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_FILES = 200;
const MAX_DEPTH_CEILING = 5;
const MAX_FILES_CEILING = 1000;
const MAX_ROOTS = 32;
```

### Deny-list (guardrail intransponível)

Roots que casam com qualquer regex/prefixo abaixo são **rejeitados pelo agente mesmo se o painel solicitar**. Vão para `rootsRejected[]`, agente segue com os roots restantes.

```ts
const DENY_ROOT_REGEXES = [
  /^[A-Z]:\\?$/i,                    // C:\, D:\, etc — volumes inteiros
  /^[A-Z]:\\Users\\?$/i,             // C:\Users (mas C:\Users\fulano\AppData... ok)
  /^[A-Z]:\\Windows(\\|$)/i,         // C:\Windows e tudo abaixo
  /^[A-Z]:\\\$Recycle\.Bin/i,
  /^\/$/,                            // Linux defensivo
  /^\/home\/?$/, /^\/usr\/?$/, /^\/etc\/?$/
];
```

Substrings rejeitadas case-insensitive (mesmo se aparecem em caminhos derivados durante recursão — usados em `SKIP_DIR_NAMES_CI`):

```ts
const SKIP_DIR_NAMES_CI = new Set([
  "node_modules", ".git", ".svn", ".hg",
  "temp", "tmp", "cache", "logs", "log",
  "backup", "backups", "winsxs", "system32", "syswow64",
  "inetcache", "$recycle.bin"
]);
```

Pastas ocultas (`.algo`) são puladas exceto `.config` (preserva caso Linux).

### Expansão de variáveis de ambiente

Roots aceitam `%PROGRAMFILES%`, `%LOCALAPPDATA%` etc — expandidas via `process.env` na entrada. Vars indefinidas viram string vazia e o root resulta inválido, indo para `rootsRejected[]` com motivo `"unresolved_env_var"` em log.

### Algoritmo

Para cada root válido (não rejeitado):

```
1. Se !ctx.fs.pathExists(root): errors.push({path: root, reason: "missing"}), próximo root
2. Pilha BFS: [{ path: root, depth: 0 }]
3. enquanto pilha não vazia E files.length < maxFiles:
   3.1. node = pilha.pop()
   3.2. entries = ctx.fs.enumerateTop(node.path) — captura erro como ScanError
   3.3. para cada entry:
        - se isFile E pattern match E (sem maxAgeDays OU mtime dentro do limite):
            files.push({path, size, mtime}); se files.length === maxFiles, truncated=true, break
        - se isDirectory E nome não em SKIP_DIR_NAMES_CI E nome não começa com "." (exceto ".config"):
            se node.depth + 1 < maxDepth: pilha.push({path: <node.path>/<entry.name>, depth: node.depth+1})
4. ctx.signal.aborted entre nodes: aborta sem erro, retorna parcial com truncated=false (timeout do executor cuida do erro)
```

Patterns viram regex case-insensitive: `*.ini` → `/^.+\.ini$/i`. Compilados uma vez antes do loop.

Filtro por `mtime` aplicado por arquivo, usando `entry.mtime` já vindo do `enumerateTop`.

Erros de `enumerateTop` mapeados:

- `EACCES`/`EPERM` → `"permission"`
- `ENOENT` → `"missing"`
- outro → `"unknown"`

Errors são registrados mas **não abortam** a varredura.

### Lista de roots prioritárias (referência para o painel — não imposta pelo agente)

Documentada aqui para guiar a integração do painel:

**Windows:**

- `%PROGRAMFILES%`, `%PROGRAMFILES(X86)%`
- `%APPDATA%`, `%LOCALAPPDATA%`, `%COMMONPROGRAMFILES%`
- `C:\Sistemas`, `C:\PDV`, `C:\ERP`
- Pasta da exe de processo PDV ativo (derivada via `probe.processes`)

**Linux/macOS:** suporte mantido para dev local, na prática `[]` será o retorno comum.

### Validação de input (admin-router)

```ts
function validateScanConfigDirsInput(input: unknown): Validated<ScanConfigDirsInput> {
  if (!isRecord(input)) return { ok: false, error: "input must be an object" };
  if (!Array.isArray(input.roots) || input.roots.length === 0)
    return { ok: false, error: "input.roots must be a non-empty array" };
  if (input.roots.length > MAX_ROOTS)
    return { ok: false, error: `input.roots accepts at most ${MAX_ROOTS} items` };
  // maxDepth / maxFiles são silenciosamente clampados aos ceilings (não viram erro);
  // patterns opcional, default DEFAULT_PATTERNS.
  return { ok: true, value: parsedInput };
}
```

**Política de clamp:** `maxDepth` recebido > `MAX_DEPTH_CEILING` é silenciosamente clampado a 5. `maxFiles` > `MAX_FILES_CEILING` é clampado a 1000. Não retorna erro — painel pode mandar valores otimistas sem precisar conhecer os limites internos. `MAX_ROOTS` (32) é o único limite que rejeita com erro, porque indica request mal-formada ao invés de otimismo.
```

## Segurança

- `probe.processes`/`probe.connections` rodam apenas em `win32`. Outros platforms: lista vazia. Não é erro.
- `probe.scan_config_dirs` aplica deny-list mesmo se o painel mandar root explicitamente proibido. Roots rejeitados aparecem em `rootsRejected[]` e log estruturado.
- Conteúdo de arquivos **nunca** sai pelo `scan_config_dirs`. Só metadata. Conteúdo só por `probe.config_files` (Fase 4) que já redige senhas.
- Limites de tamanho (`maxFiles`, `MAX_ROOTS`) protegem contra explosão de payload.
- Expansão de env vars é defensiva: vars maliciosas geram root rejeitado por deny-list, não execução arbitrária.
- WS autenticado pelo `CONNECTOR_TOKEN` continua sendo o gate único de quem pode mandar probe. Bootstrap mode aceita probes (Fase 3) — mesmo modelo de auth.

## Observabilidade

- Logs estruturados: `discovery.processes.run`, `discovery.connections.run`, `discovery.scan_config_dirs.run` com `durationMs`, `resultCount`, `truncated?`, `rootsRejected.length`, `errors.length`.
- `bootstrapState` registra cada probe via `wrapProbe` (recordProbeSuccess/Error), mesmo padrão Fase 2/3. Heartbeat reflete `probesRunTotal` atualizado.
- Probes que excedem timeout (`AbortSignal`) retornam `INTERNAL_ERROR` com mensagem clara via admin-router.

## Testes

### Unit (vitest)

- `parseTasklistOutput` — 3+ amostras: vazio, normal, edge cases (vírgulas em nomes, paths com espaços).
- `parseNetstatOutput` — IPv4 + IPv6, estados variados (filtra para ESTABLISHED).
- `probeProcesses` — mock `listProcesses`; cobre filtragem de processos de sistema, cross-platform vazio.
- `probeConnections` — mocks `listConnections` e `listProcesses`; cobre filtro DB_PORTS, cruzamento PID→nome, falha de listProcesses tolerada.
- `probeScanConfigDirs` — `FileSystemReader` fake; cenários:
  - root deny-list (volumes, Windows, $Recycle.Bin)
  - root com env var expandida e env var faltando
  - depth limit alcançado
  - maxFiles atingido → `truncated: true`
  - maxAgeDays filtra arquivos antigos
  - patterns case-insensitive
  - SKIP_DIR_NAMES_CI pulados
  - error tolerance (EACCES/EPERM/ENOENT em subdiretórios → errors[], scan continua)
  - input validation no admin-router (roots vazio, > 32, depth > 5)

### Contract tests do protocolo

Snapshot tests dos shapes de `admin.request{command: "probe.processes" | "probe.connections" | "probe.scan_config_dirs"}` e respectivos `admin.response`.

### Integração manual

Roteiro em `docs/superpowers/specs/smokes/2026-05-28-discovery-process-connection-smoke.md`:

1. VM Windows com SQL Server local rodando.
2. Processo simulando ERP (`Big.exe` fake) conectando em localhost:1433.
3. Painel local envia `probe.processes` → confere lista.
4. `probe.connections` → confere cruzamento PID/processName/porta.
5. `probe.scan_config_dirs` com `roots: ["C:\\Linx"]` → confere `files[]` e `truncated`.
6. Testa deny-list mandando `roots: ["C:\\"]` → confere `rootsRejected`.

## Riscos e mitigações

- **Antivírus/EDR detectar `tasklist`/`netstat` como reconnaissance.** Mitigação: comandos são oficiais Microsoft, executados pelo service `LocalSystem` legitimamente. Sem `procdump`, sem injeção, sem leitura de memória.
- **`tasklist /v` ~500 ms mais lento que `tasklist` simples.** Mitigação: timeout de 8 s acomoda; cache não vale a pena (processos mudam rápido).
- **`enumerateTop` com muitas entries (>10000) em uma pasta.** Mitigação: filtro por pattern no loop interrompe cedo; se um único diretório tem 10k entries, atinge `maxFiles` cap e retorna truncated.
- **Painel comprometido mandando roots maliciosos.** Mitigação: deny-list intransponível + WS autenticado.
- **Falsos positivos em `probe.connections` (ex: outra app local fala 5432 que não é ERP).** Mitigação: probe é descritivo, decisão fica no painel.

## Plano de entrega (fases sugeridas)

Cada fase é mergeable independentemente.

1. **Extensões `ProbeContext` + `FileSystemReader`.** Adiciona `listProcesses`, `listConnections`, `enumerateTop` com implementações default + testes do parser puro.
2. **`probe.processes` + admin-router + runtime wiring.**
3. **`probe.connections` + admin-router + runtime wiring.**
4. **`probe.scan_config_dirs` + admin-router + runtime wiring.** Inclui deny-list, validators, recursão controlada.
5. **Smoke manual + README breve** documentando os 3 probes novos.

Decomposição em planos de implementação separados fica para a próxima etapa via `writing-plans`.
