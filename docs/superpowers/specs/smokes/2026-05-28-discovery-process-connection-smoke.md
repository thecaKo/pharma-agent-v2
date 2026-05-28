# Smoke Manual: probes de processos, conexões e scan de configs

Validar end-to-end em VM Windows real os 3 probes novos.

## Pré-requisitos

- VM Windows 10/11 com `pharma-agent-connector` instalado e rodando como service `LocalSystem`.
- SQL Server local rodando na porta 1433 (`MSSQLSERVER` ou `MSSQL$SQLEXPRESS`).
- Service conectado ao `mock-panel` (`npm run mock-panel -- serve`) via WS.
- Processo cliente conectado a localhost:1433 — pode ser `sqlcmd -S .` deixado aberto, ou qualquer SSMS.

## Roteiro

### 1. probe.processes

Pelo `mock-panel`, enviar `admin.request` com `command: "probe.processes"`. Esperado:

- Response `ok: true`, `payload.processes` é array.
- Lista contém pelo menos `sqlservr.exe` com `path` (ex: `C:\Program Files\Microsoft SQL Server\MSSQL16.MSSQLSERVER\MSSQL\Binn\sqlservr.exe`).
- Processos de sistema (`System`, `Idle`, `services.exe`) NÃO aparecem.

### 2. probe.connections

`command: "probe.connections"`. Esperado:

- Response `ok: true`, `payload.connections` array.
- Pelo menos uma entry com `remotePort: 1433` (ou `localPort: 1433` se o SQL Server estiver listando para si).
- `processName` preenchido (`sqlservr.exe` ou o cliente).
- Conexões em portas não-DB (porta 80, 443) NÃO aparecem.

### 3. probe.scan_config_dirs com root válido

`command: "probe.scan_config_dirs"`, `input: { roots: ["C:\\Program Files\\Microsoft SQL Server"], maxDepth: 3, maxFiles: 50 }`.

Esperado:

- `payload.files` contém arquivos `.config`, `.xml`, `.ini` (se houver) abaixo da pasta. Tamanhos > 0.
- `rootsRejected: []`.
- `truncated: false` (provavelmente — depende da instalação).

### 4. probe.scan_config_dirs com root negado

`input: { roots: ["C:\\", "C:\\Windows\\System32", "C:\\Program Files\\Microsoft SQL Server"] }`.

Esperado:

- `rootsRejected` contém `C:\` e `C:\Windows\System32`.
- `files` ainda traz resultados do root válido.

### 5. probe.scan_config_dirs com env var

`input: { roots: ["%PROGRAMFILES%\\Microsoft SQL Server"] }`.

Esperado: equivalente ao caso 3 (env expandida internamente).

### 6. heartbeat bootstrap counter

Após executar os 3 probes acima, observar o próximo heartbeat. Em `bootstrap` mode, `payload.bootstrap.probesRunTotal` deve refletir os probes executados; `lastProbeAt` recente.

## Critérios de aceitação

- ✅ Todos os 6 itens acima retornam o esperado
- ✅ Nenhum log `unsupported_server_message` aparece para esses comandos
- ✅ Nenhum erro `INTERNAL_ERROR` retornado
