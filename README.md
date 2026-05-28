# Pharma Agent Connector

Local TypeScript runtime foundation for the Pharma Agent connector Windows Service.

## Onboarding Flows

The service supports two onboarding paths:

- **CLI local (legacy):** Run `npm run database-setup --` on the client machine to
  fill `~/.pharma-agent/database-setup.json` before starting the service. Service
  starts directly in `synced` state.
- **Painel-driven (recommended):** Skip `database-setup`. Service boots in
  `bootstrap` state, connects to the panel via WS, and accepts `probe.*` admin
  requests for the panel to discover engines, ODBC DSNs, network reachability and
  test candidate connections. The panel then sends a `connector.bootstrap.dbConfig`
  envelope; the service persists the config to `%PROGRAMDATA%\PharmaAgentConnector\connector-config.json`
  and transitions to `synced` without restarting.

In both flows the service emits a `connector.discovery` snapshot on first connect
with `mode: "bootstrap"` or `mode: "synced"`.

## Discovery Probes (Fase 4b)

Além das probes da Fase 2 (engines, odbc_dsns, network, test_connection), o agente expõe:

- **`probe.processes`** — lista processos rodando com `pid`, `name`, `path` da exe (via WMIC + PowerShell fallback). Cross-platform: retorna lista vazia.
- **`probe.connections`** — lista conexões TCP em portas de banco conhecidas (`1433`, `5432`, `3306`, `3050`, `1521`, `1583`, `50000`, `27017`), cruzando PID com nome do processo.
- **`probe.scan_config_dirs`** — varre diretórios prioritários por arquivos de config (`.ini`, `.json`, `.xml`, `.env`, `.db`, etc.), retornando metadata (path/size/mtime). Aplica deny-list intransponível (`C:\`, `C:\Windows`, `node_modules`, etc.) e limites de profundidade/quantidade. Aceita expansão de `%VAR%`.

## Local Development

Install dependencies:

```sh
npm install
```

Build TypeScript:

```sh
npm run build
```

For local connector checks against the mapping you configured in the
interactive setup flow, finish **`npm run database-setup --`** first so it
writes `~/.pharma-agent/database-setup.json` (override path with `--artifact-file` on the setup
CLI when needed). Production product mapping stays owned by the central panel.

**`npm run database-setup --`** starts with a choice between **manual connection**
(recommended when host, port, database, user, and password are known) and **local
database discovery** (optional metadata scan for candidate files). Manual setup
supports **MySQL**, **MariaDB**, **Firebird**, **PostgreSQL**, and **SQL Server**
(`DB_DRIVER=sqlserver`, com `DB_INSTANCE=<name>` opcional para named instances) without
selecting a discovered file. Discovery
runs only when you choose that path; use `--root <path>` to limit the scan. The CLI
does not print database passwords or connector tokens, and passwords stay out of the
onboarding JSON artifact.

Then start **`mock-panel serve`**, point `CONNECTOR_WS_URL` at the printed URL,
run `CONNECTOR_VALIDATE_ONLY=1 node --import tsx src/main.ts` if desired, then
run `npm start`. If no onboarding artifact is present yet, **`mock-panel serve`**
prints an error directing you back to interactive **`database-setup`**.

```sh
npm run mock-panel -- serve
npm run mock-panel -- serve --artifact-file ~/.pharma-agent/database-setup.json
```

Use **`--artifact-file <path>`** on **`mock-panel serve`** only when you saved the
mapping JSON somewhere other than the default file.

Interactive mock simulator commands (**`discover`**, **`select`**, **`current`**, **`history`**) simulate admin table selection flows and persist separate simulator-only state:

```sh
npm run mock-panel -- discover
npm run mock-panel -- select products
npm run mock-panel -- current
npm run mock-panel -- history
```

The **`mock-panel`** CLI is local tooling only and does not publish production
connector configuration.

For **`mock-panel serve`**, the server sends `connector.config` from the onboarding
mapping artifact produced by **`database-setup`**, not hardcoded edits in **`mock-ws-server.mjs`**.

`mock-panel discover` returns table names only. It does not return columns,
field types, row counts, or sample rows. Selecting a different simulated product
table with `mock-panel select` requires `--confirm-restart` and restarts product
synchronization from the beginning for the new table:

```sh
npm run mock-panel -- select inventory --confirm-restart
```

By default, local simulator state is stored at
`~/.pharma-agent/mock-panel-state.json`. Use `--state-file <path>` for isolated
tests or delete that file to clear discovered table names, current selection,
and mock panel history.

Run the local database file discovery CLI after building:

```sh
npm run discover-databases --
npm run discover-databases -- --root <path>
```

Without `--root`, discovery performs a default full-system scan: all Windows
drive roots (`A:\` through `Z:\`) or the POSIX filesystem root (`/`). Use
`--root <path>` to limit validation to a known directory during onboarding or
manual testing. Output is tabular and includes `path`, `type`, and `confidence`,
followed by `Scanned paths:` and `Blocked paths:` summary lines. `Blocked paths`
is an aggregate count of inaccessible paths; the command keeps scanning
accessible areas.

Discovery is metadata-only. It identifies candidate files with extensions used
by the supported agent drivers, and does not read database contents, table
structures, sample rows, credentials, or connection strings.

Run tests:

```sh
npm test
```

Run coverage:

```sh
npm run coverage
```

You can define the connector settings in a local `.env` file. The runtime now
loads `.env` automatically when started from the CLI, without requiring manual
`source`/`export`.

Validate startup configuration during local development:

```sh
CONNECTOR_VALIDATE_ONLY=1 node --import tsx src/main.ts
```

After building, the service entrypoint is:

```sh
npm start
```

## Windows Installer (Internal)

On Windows hosts, use the packaged installer for service installation and central
connection settings. Build the setup executable on a prepared Windows machine:

```sh
npm run package:windows-installer
```

The output is `installer/bin/PharmaAgentConnector-Setup.exe`. Run it with
administrator privileges. The wizard collects only the connector token and central
WebSocket URL; database onboarding stays in `npm run database-setup --`.

Central settings are stored at
`%PROGRAMDATA%\PharmaAgentConnector\connector-config.json`. Machine or process
environment variables override those file values. See `docs/configuration.md` and
`docs/windows-service.md` for precedence, repair, uninstall, and PowerShell script
fallback paths.

Example `.env`:

```dotenv
CONNECTOR_TOKEN=test-token
CONNECTOR_WS_URL=wss://central-platform/connectors/ws
DB_DRIVER=mysql
DB_HOST=localhost
DB_PORT=3306
DB_NAME=pharmacy
DB_USER=readonly
DB_PASSWORD=test-password
LOG_LEVEL=info
```
