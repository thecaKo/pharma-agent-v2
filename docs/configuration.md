# Connector Configuration

The Windows Service merges configuration from multiple sources at startup.
Restart the service after any central or database configuration change.
When the installer has written central settings but database settings are not
available yet, the service starts in a setup-waiting state and does not begin
schema discovery or product polling until database onboarding completes.

## Installer-Managed Central Settings

The Windows installer writes central connection settings to:

```text
%PROGRAMDATA%\PharmaAgentConnector\connector-config.json
```

The file stores only installer-managed keys: `CONNECTOR_TOKEN`, `CONNECTOR_WS_URL`,
and optional `LOG_LEVEL`. It does not store database credentials or mapping. The
installer writes this JSON as UTF-8 without BOM so Windows and Node.js tooling can
parse it consistently.

When `PROGRAMDATA` is unset, the runtime falls back to a per-user directory under
`AppData\Local\PharmaAgentConnector\` with the same file name.

**Precedence for installer-managed keys:** machine or process environment variables
override values from the ProgramData file. Empty environment values do not override
file values. After merge, the runtime validates the effective configuration.

Database settings (`DB_DRIVER`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`,
`DB_PASSWORD`) are not written by the installer. Configure them through machine
environment variables or the database setup CLI described below.

For local development, the CLI entrypoint also loads a `.env` file from the
current working directory automatically. Explicit environment variables still
take precedence over values defined in `.env`.

Required variables:

| Variable | Description |
| --- | --- |
| `CONNECTOR_TOKEN` | Connector token issued by the central panel. |
| `CONNECTOR_WS_URL` | Central outbound WebSocket URL. |
| `DB_DRIVER` | `mysql` or `firebird`. |
| `DB_HOST` | Source database host. |
| `DB_PORT` | Source database TCP port. |
| `DB_NAME` | MySQL database name or Firebird database path/name. |
| `DB_USER` | Read-only source database user. |
| `DB_PASSWORD` | Source database password. |
| `LOG_LEVEL` | Optional: `debug`, `info`, `warn`, or `error`; defaults to `info`. |

Example PowerShell configuration:

```powershell
[Environment]::SetEnvironmentVariable("CONNECTOR_TOKEN", "<token from panel>", "Machine")
[Environment]::SetEnvironmentVariable("CONNECTOR_WS_URL", "wss://central-platform/connectors/ws", "Machine")
[Environment]::SetEnvironmentVariable("DB_DRIVER", "mysql", "Machine")
[Environment]::SetEnvironmentVariable("DB_HOST", "127.0.0.1", "Machine")
[Environment]::SetEnvironmentVariable("DB_PORT", "3306", "Machine")
[Environment]::SetEnvironmentVariable("DB_NAME", "pharmacy", "Machine")
[Environment]::SetEnvironmentVariable("DB_USER", "readonly", "Machine")
[Environment]::SetEnvironmentVariable("DB_PASSWORD", "<database password>", "Machine")
```

Secrets must not be pasted into support tickets or screenshots. Runtime logs redact connector tokens and database passwords.

Important startup events:

- `service.startup` includes connector version, `dbDriver`, `databaseConfigured`, state path, and log path.
- `configuration.loaded` includes effective non-secret configuration and `databaseConfigured`.
- `service.setup_waiting` appears when the service has central settings but no `DB_*` configuration yet.
- `diagnostics.startup_report` summarizes runtime dependency checks (`dist`, `node_modules`, and the active DB driver package when applicable).
- `database.connected` / `database.connection_failed` show adapter connect outcomes without exposing `DB_PASSWORD`.

## Local Interactive Database Setup

Use the local setup CLI on the same machine that can reach the pharmacy
database. The onboarding flow validates a live connection, lets you choose the
product table and field mappings, then writes the validated local artifacts. It
supports **manual MySQL** and **manual Firebird** connection details, and an
optional **local discovery** path for finding candidate database files.

Build first, then run the setup command:

```sh
npm run build
npm run database-setup --
```

The first prompt asks whether to use **manual connection** (recommended when you
already know host, port, database name or path, user, and password) or **local
database discovery**. Manual setup does not require or use a discovered file
candidate. Discovery runs only when you select that mode; it is useful for
locating local Firebird or MySQL files before configuring connection details.

Manual connection flow:

1. Choose manual connection (default).
2. Choose driver: `mysql` or `firebird`.
3. Enter connection details. Existing env values for the selected driver are
   offered as defaults when `DB_DRIVER` matches.
4. Complete table selection, field mapping, initial read validation, and artifact
   writes through the same pipeline as discovery-based setup.

Discovery connection flow:

1. Choose local database discovery.
2. Run metadata scan (optionally limited with `--root <path>`).
3. Select a supported discovered candidate, then continue with connection prompts
   derived from that candidate.

Optional flags:

```text
--root <path>          Limit discovery scan to a known directory (discovery mode only).
--env-file <path>      Write connector env values to a different env file.
--artifact-file <path> Write the onboarding JSON to a different file path.
```

Required local context before running the command:

- The connector host can reach the local MySQL or Firebird server.
- You have a read-only database user and password.
- You have the connector token and central WebSocket URL for the target
  environment.

By default, the CLI updates `.env` in the current working directory and writes
an onboarding artifact to `~/.pharma-agent/database-setup.json`. The env writer
updates connector keys only, preserves unrelated lines and comments, and
creates a timestamped `.bak` backup before overwriting an existing env file.

Secrets stay in the env file, not in the onboarding JSON artifact. The JSON
contains the validated local table and field mapping metadata used during
onboarding, while `CONNECTOR_TOKEN`, `CONNECTOR_WS_URL`, and `DB_PASSWORD`
remain in `.env` or the file selected through `--env-file`.

The onboarding JSON does not replace panel-owned production mapping. It is a
local validation and handoff artifact only; the production runtime still gets
product mapping from the central panel.

After the CLI saves configuration, it prints the next-step commands:

```sh
CONNECTOR_VALIDATE_ONLY=1 node --import tsx src/main.ts
npm start
```

Run the validation command first to confirm env-based startup configuration.
Run `npm start` only after validation succeeds and the target panel environment
is ready to send production mapping.

## After Windows Installer Completion

The MVP installer installs the `PharmaAgentConnector` service and collects only
the connector token and central WebSocket URL. Database connection, table
selection, and field mapping remain in this database setup flow — they are not
part of the installer wizard. The installed Windows Service is hosted by the
WinSW wrapper `PharmaAgentConnector.Service.exe`, which launches
`%BASE%\node.exe "%BASE%\dist\main.js"` and writes wrapper/stdout/stderr logs to
`%PROGRAMDATA%\PharmaAgentConnector\logs`. The MSI is self-contained: it installs
`node.exe`, `PharmaAgentConnector.Service.exe`, `PharmaAgentConnector.Service.xml`,
`package.json`, `package-lock.json`, the full built `dist\` tree, and production
runtime `node_modules\`. WinSW rotates service logs with a 10 MiB threshold and
keeps 10 rolled files.

After a successful install, run database onboarding on the same host that can
reach the pharmacy database:

```sh
npm run build
npm run database-setup --
```

When building the MSI on Windows, prepare production `node_modules` that are
compatible with Windows x64. Point `NODE_MODULES_PATH` at that prepared directory,
or pre-stage it at `installer/staging/node_modules`, before running
`npm run package:windows-installer`.

Set database credentials through the CLI (machine environment variables or the
generated `.env` file). Restart the Windows Service when central or database
settings change. See `docs/windows-service.md` for installer repair, uninstall,
and script fallback paths.

Local non-secret state is stored at:

```text
%PROGRAMDATA%\PharmaAgentConnector\connector-state.json
```

## Mock Panel Simulator State

The **`mock-panel serve`** WebSocket shim sends **`connector.config`** payloads from
the same onboarding JSON **`database-setup`** writes by default (**`~/.pharma-agent/database-setup.json`**).
Provide **`npm run mock-panel -- serve --artifact-file <path>`** when both CLIs must use a shared,
non-default mapping file.

If the artifact is missing or unreadable, **`mock-panel serve`** exits with a
setup-first error (for example *No onboarding mapping artifact was found. Run the
interactive database setup CLI to create it before starting the mock.*). It does
not fall back to hidden hardcoded mapping in **`mock-ws-server.mjs`**.

The interactive **`mock-panel discover`**, **`select`**, **`current`**, and
**`history`** commands are a local simulator for dynamic product table selection
state. They are not a production configuration source; production table selection
and product mapping remain owned by the central panel.

The simulator stores its local state separately from connector runtime state:

```text
~/.pharma-agent/mock-panel-state.json
```

That file contains the simulator's discovered table names, current selected
product table, and selection history. Discovery records table names only and
does not persist columns, field types, row counts, or sample rows. Changing the
selected product table represents a new panel selection and restarts product
synchronization from the beginning for that table.

Use `npm run mock-panel -- <command> --state-file <path>` to keep test state in
a disposable file. To reset the default local simulator, delete
`~/.pharma-agent/mock-panel-state.json`.

## Product Synchronization

### Sync Mode

Use `incremental` when the ERP has a cursor field that advances whenever a synchronized product field changes.

Use `snapshot` when the ERP does not have a reliable update field. Snapshot mode reads the full product list in pages on each polling cycle and sends only products whose synchronized payload changed since the last accepted ACK.

Snapshot mode is intended for catalogs up to 10,000 products. Removed products are ignored; they are not automatically sent as inactive.

## Database File Discovery

The database file discovery CLI is an onboarding utility for locating likely
local database files before connector configuration. Build the connector first,
then run:

```sh
npm run discover-databases --
npm run discover-databases -- --root <path>
```

When no `--root <path>` is provided, the command performs the default
full-system scan across all Windows drive roots (`A:\` through `Z:\`) or the
POSIX filesystem root (`/`). Use `--root <path>` to limit the scan to a
controlled fixture, known application directory, or other approved onboarding
scope.

Results are printed as human-readable tabular output with these fields:

| Field | Description |
| --- | --- |
| `path` | Resolved candidate file path. |
| `type` | Likely database family for a supported driver, such as `firebird` or `mysql`. |
| `confidence` | Metadata-only confidence label: `high`, `medium`, or `low`. |

The command also prints `Scanned paths:` and `Blocked paths:` summary lines.
Inaccessible paths are summarized by count only so permission-protected areas do
not stop the scan or fill the output with path-level errors.

Discovery is metadata-only and privacy-preserving. It does not read database
contents, table structures, sample rows, credentials, or connection strings.
Treat all results as candidates for follow-up validation, not as automatic
connector configuration.
