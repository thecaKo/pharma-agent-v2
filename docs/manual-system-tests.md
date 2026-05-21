# Manual System Tests

Run these checks on a Windows host before a customer rollout.

## Automated Checks (Non-Windows and CI)

These run on Linux/macOS CI and developer machines without executing the WiX installer:

- `npm test` — packaging metadata, ProgramData config precedence, installer WiX source validation, and documentation assertions (including this checklist).
- `npm run package:windows-installer` — prerequisite and staging checks only; full MSI/bundle build requires a Windows host with WiX Toolset and a staged `node.exe` under `installer/staging`.
- `RUN_WINDOWS_INSTALLER_TESTS=1 npm test` on Windows — optional gated build of `installer/bin/PharmaAgentConnector-Setup.exe`.

Treat a green non-Windows test run as proof of metadata and docs only. Installer install, repair, uninstall, and service-start behavior below are **Windows-gated** and must be executed manually on a prepared Windows host.

## Windows Installer Verification (Manual, Windows-Gated)

Use `docs/windows-service.md` (**Installer-First Installation**) as the operator reference. Complete this section after `npm run package:windows-installer` produces `installer/bin/PharmaAgentConnector-Setup.exe` on a Windows build host with WiX Toolset, a staged `node.exe`, and production dependencies under `installer/staging`.

### Prerequisites

1. Use a Windows machine with administrator access for install, repair, and uninstall.
2. Confirm WiX Toolset is installed and `installer/staging/node.exe` exists before packaging.
3. From the repository root on that host, run `npm ci`, then `npm run package:windows-installer`.
4. Confirm `installer/bin/PharmaAgentConnector-Setup.exe` exists and note its path for distribution.

### First Install and Service Registration

1. On a clean host (or after removing any prior `PharmaAgentConnector` install), run `PharmaAgentConnector-Setup.exe` with administrator privileges.
2. Complete the wizard with a test connector token and central WebSocket URL only. Do not enter database credentials in the installer UI.
3. Confirm the completion screen reports service installation success and points to the remaining database onboarding step (`npm run database-setup --` / **After Windows Installer Completion** in `docs/configuration.md`).
4. Confirm `Get-Service -Name PharmaAgentConnector` shows the service installed with automatic startup.
5. Confirm `%PROGRAMDATA%\PharmaAgentConnector\connector-config.json` contains `CONNECTOR_TOKEN` and `CONNECTOR_WS_URL` only (no `DB_PASSWORD`, `DB_DRIVER`, or mapping fields).
6. Record installer success separately from production readiness. Database onboarding is still required before expecting synchronization.

### Repair

1. Re-run `PharmaAgentConnector-Setup.exe` on the same host and choose **Repair**.
2. Confirm `Get-Service -Name PharmaAgentConnector` remains registered and starts automatically.
3. Confirm `%PROGRAMDATA%\PharmaAgentConnector\connector-config.json` is restored when it was missing or corrupted.
4. Confirm repair UI, Windows Installer logs, and completion output do not print the connector token value.

### Uninstall

1. Open **Apps & features** / **Installed apps**, select **Pharma Agent Connector**, and uninstall.
2. Confirm `Get-Service -Name PharmaAgentConnector` returns no service.
3. Confirm application files under the install directory are removed.
4. Leave `%PROGRAMDATA%\PharmaAgentConnector` in place unless fully decommissioning the host.
5. Confirm uninstall UI and completion output do not expose the connector token.

### Incomplete Database Onboarding and Service Start

Run this after a successful installer-only install, before `npm run database-setup --` completes database credentials on the host.

1. Confirm machine environment variables do not yet include `DB_DRIVER`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, or `DB_PASSWORD` (unless intentionally pre-seeded for a negative test).
2. Run `Start-Service -Name PharmaAgentConnector`.
3. Confirm the Windows Service is registered but the connector process does not reach a healthy production runtime: startup validation fails for missing database configuration (`CONFIG_VALIDATION_FAILED` / `DB_DRIVER` in service logs).
4. Confirm service stdout/stderr logs and Event Viewer entries do not contain `CONNECTOR_TOKEN` or `DB_PASSWORD`.
5. Complete `npm run database-setup --` per **Database Setup CLI Flow**, restart the service, and confirm startup validation succeeds before heartbeat or product synchronization checks.

### Installer Secret Handling

1. During the wizard, confirm token fields mask input and no preview shows the full token.
2. Confirm the completion screen names database onboarding without echoing the entered token.
3. Search Windows Installer logs (`%TEMP%` MSI logs) and service logs for the test token string; neither should contain the literal value.
4. Confirm `%PROGRAMDATA%\PharmaAgentConnector\connector-state.json` (if created) does not store `CONNECTOR_TOKEN` or `DB_PASSWORD`.

## PowerShell Script Fallback Installation

Use only when the WiX installer cannot run. See `docs/windows-service.md` (**PowerShell Script Fallback**).

1. Build the connector with `npm ci` and `npm run build`.
2. Set the required machine environment variables from `docs/configuration.md`.
3. Run `.\scripts\install-service.ps1`.
4. Confirm `Get-Service -Name PharmaAgentConnector` shows the service installed.

## Start, Stop, Restart

1. Run `Start-Service -Name PharmaAgentConnector`.
2. Confirm the central panel or compatible mock service receives a heartbeat with online state.
3. Run `Stop-Service -Name PharmaAgentConnector`.
4. Confirm the panel marks the connector offline after the expected central timeout.
5. Run `.\scripts\restart-service.ps1`.
6. Confirm heartbeat resumes and includes the current mapping version when a mapping is active.

## Product Flow

1. Configure a compatible central WebSocket endpoint that sends `connector.config`.
2. Change two product rows in the source database.
3. Confirm the connector sends one `product.batch`.
4. Return an accepted `batch.ack`.
5. Confirm `%PROGRAMDATA%\PharmaAgentConnector\connector-state.json` advances `lastAckedCursor` only after the acknowledgement and updates `lastSuccessfulSendAt`.

## Production Central Panel Config Push Smoke

Use this checklist at customer go-live when validating mapping pushed from the **central panel** (neo-api complete `connector.config` payload). This is the production path. Do **not** substitute **`npm run mock-panel -- serve`** here—that flow is a **development/simulator-only** path documented in **Mock Panel CLI Flow** and does not prove panel-owned config delivery.

### Preconditions

1. Pharma Agent Connector service running and started successfully after database onboarding.
2. ERP database reachable from the connector host with the read-only user configured at install time.
3. Valid `CONNECTOR_TOKEN` and `CONNECTOR_WS_URL` pointing at the production central WebSocket endpoint.
4. Complete customer-specific product mapping published from the central panel (incremental query, cursor metadata, field mappings, selected product table).
5. Healthy network between connector host, central platform, and ERP.

### Valid config push (primary flow)

1. Confirm the connector service is online and the central panel shows a connected WebSocket session (heartbeat with online state).
2. Publish the complete `connector.config` from the central panel for this customer connector.
3. Note the wall-clock time when the panel publish completes.
4. In connector/service logs, confirm `mapping.active` with the expected `selectedProductTable`, `cursorField`, and related mapping metadata from the pushed config.
5. Make a small, known change to one or two product rows in the source ERP table covered by the mapping.
6. Confirm the connector sends the first `product.batch` for that mapping after the change (or on the scheduled poll when your fixture already has pending rows).
7. From the central panel or compatible tooling, return an accepted `batch.ack` for that batch.
8. Confirm `%PROGRAMDATA%\PharmaAgentConnector\connector-state.json` advances `lastAckedCursor` only after the acknowledgement and updates `lastSuccessfulSendAt`.

### Timing measurement (30-second target)

1. Measure elapsed time from panel config publish completion to the first observed `mapping.active` log or event.
2. Measure elapsed time from the same publish completion (or from `mapping.active`, if your runbook separates activation from batch) to the first `product.batch`.
3. The **30-second** target applies **only** under healthy ERP, network, and connector process conditions; slow ERPs, intermittent networks, or service restarts during the test are out of scope for this SLA.
4. The connector does **not** enforce a runtime 30-second deadline; missed timing during smoke is a signal to recheck preconditions and ERP performance, not an automatic connector failure.

### Invalid config push (failure flow)

1. From the panel, publish an intentionally incomplete `connector.config` (for example missing `mapping.incrementalQuery`, invalid cursor type, or incomplete field mappings) in a controlled test window after coordinating with the platform team.
2. Confirm the central panel or WebSocket trace shows an immediate `connector.error` (typically `CONFIG_VALIDATION_FAILED`) with a field-specific validation message suitable for support tickets.
3. Confirm connector logs do **not** show `mapping.active`, polling does not start, and no `product.batch` is sent for that invalid push.
4. Fix the mapping in the panel, republish a complete config, and repeat the valid config push steps above.

## Mock Panel CLI Flow

**Development/simulator only.** Production go-live validation uses the **Production Central Panel Config Push Smoke** checklist above, not this section.

These steps assume you already completed **`npm run database-setup --`** locally so
`~/.pharma-agent/database-setup.json` captures the validated table and field
mapping. Production mapping stays central-panel-owned; **`mock-panel serve`** is
only for validating the connector against your local artifact.

1. Build the connector with `npm run build`.
2. Start **`npm run mock-panel -- serve`** and note the **`listening on ws://...`** URL.
   Pass **`--artifact-file <path>`** when **`database-setup`** wrote the JSON elsewhere.
3. If the onboarding JSON is absent, **`mock-panel serve`** exits with guidance to rerun **`npm run database-setup --`**
   (for example a *No onboarding mapping artifact was found* message); it never reads hidden hardcoded mapping from **`mock-ws-server.mjs`**.
4. Put the listed URL into `CONNECTOR_WS_URL`, optionally validate startup with
   `CONNECTOR_VALIDATE_ONLY=1 node --import tsx src/main.ts`, then start the connector with **`npm start`**.
5. Confirm connector logs emit **`mapping.active`** with **`selectedProductTable`** equal to your setup choice and that persisted state includes **`cursorField`** and **`sourceProductCodeField`** values matching the field mapping from your onboarding JSON.
6. Run **`npm run mock-panel -- discover`** when you need schema listing against the shim; the command waits for the connector and prints table names only.
7. Optionally exercise simulator-only selection with **`npm run mock-panel -- select <table>`**; that state does not feed **`mock-panel serve`**, which always reads the onboarding JSON.
8. If changing an existing simulated selection, re-run **`npm run mock-panel -- select <table>`** with **`--confirm-restart`** and confirm product synchronization restarts from the beginning.
9. Inspect simulator-only state with **`npm run mock-panel -- current`** and **`npm run mock-panel -- history`** when you used the interactive commands above.
10. Clean up **`~/.pharma-agent/mock-panel-state.json`**, or use **`--state-file <path>`**, when discarding simulator fixtures.

On Windows installs, **`%PROGRAMDATA%\PharmaAgentConnector\connector-state.json`** retains the mirrored mapping fields referenced in step **5**.

## Database File Discovery CLI Flow

1. Build the connector with `npm run build`.
2. Create a controlled fixture directory:

   ```powershell
   New-Item -ItemType Directory -Force C:\Temp\pharma-agent-db-fixture | Out-Null
   New-Item -ItemType File -Force C:\Temp\pharma-agent-db-fixture\PHARMACY.FDB | Out-Null
   New-Item -ItemType Directory -Force C:\Temp\pharma-agent-db-fixture\mysql\data | Out-Null
   New-Item -ItemType File -Force C:\Temp\pharma-agent-db-fixture\mysql\data\products.ibd | Out-Null
   ```

3. Run the controlled discovery check:

   ```powershell
   npm run discover-databases -- --root C:\Temp\pharma-agent-db-fixture
   ```

4. Confirm output includes the `path`, `type`, and `confidence` header and
   candidate rows for Firebird and MySQL fixture file paths.
5. Confirm output includes `Scanned paths:` and `Blocked paths:` summary lines.
6. Confirm no database contents, table structures, sample rows, credentials, or
   connection strings are printed.
7. Run a real default scan with `npm run discover-databases --` only when the
   customer environment, maintenance window, and implementation lead approve a
   broad metadata scan. Default scans may inspect many accessible filesystem
   paths and can take longer on large machines.
8. Remove the fixture directory:

   ```powershell
   Remove-Item -Recurse -Force C:\Temp\pharma-agent-db-fixture
   ```

## Database Setup CLI Flow

1. Build the connector with `npm run build`.
2. Run `npm run database-setup --` on the same machine that can reach the local
   MySQL or Firebird server.
3. At the first prompt, confirm **manual connection** is the recommended default
   and that **local database discovery** is available as an optional path.
4. Complete the prompts with a read-only database user, the connector token,
   and the target `CONNECTOR_WS_URL`.
5. Confirm the CLI prints the selected driver, host, port, database, and table
   without printing the password or connector token.
6. Confirm the CLI writes connector secrets to `.env` or the selected env file,
   and creates a timestamped `.bak` backup when that env file already existed.
7. Confirm the CLI writes the onboarding JSON artifact separately and that the
   artifact does not contain `CONNECTOR_TOKEN` or `DB_PASSWORD`.
8. Confirm the CLI prints `CONNECTOR_VALIDATE_ONLY=1 node --import tsx
   src/main.ts` and `npm start` as the next-step commands.
9. Run the validation command and confirm startup validation succeeds with the
   saved env values.
10. Treat the JSON artifact as local onboarding output only. Confirm production
    product mapping still comes from the central panel or approved mock-panel
    workflow, not from the onboarding JSON.

## Manual MySQL Setup (Docker)

Use this check when validating manual setup against a containerized MySQL instance
without relying on filesystem discovery.

1. Build the connector with `npm run build`.
2. From the repository root, start the test database:

   ```sh
   docker compose -f docker-compose.test.yml --env-file .env.test up -d
   ```

3. Wait until `docker compose -f docker-compose.test.yml ps` reports the MySQL
   service as healthy.
4. Run `npm run database-setup --` and choose **manual connection** (recommended).
5. Choose the **MySQL** driver and enter connection values from `.env.test`
   (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`).
6. Select the `products` table, map required product fields, and complete initial
   read validation.
7. Confirm setup succeeds without selecting any discovered file candidate and
   that stdout/stderr never contain `DB_PASSWORD` or `CONNECTOR_TOKEN`.
8. Confirm `.env` (or `--env-file` target) contains `DB_DRIVER=mysql` and the
   onboarding JSON under `~/.pharma-agent/database-setup.json` (or
   `--artifact-file`) contains mapping metadata only.
9. Run `CONNECTOR_VALIDATE_ONLY=1 node --import tsx src/main.ts` against the
   saved env file and confirm validation succeeds.
10. Stop the test database when finished:

    ```sh
    docker compose -f docker-compose.test.yml down
    ```

## Manual Firebird Setup

Use this check when the Firebird server host, port, database path, user, and
password are already known.

1. Build the connector with `npm run build`.
2. Confirm the connector host can reach the Firebird server and that a read-only
   user can read the product table you plan to map.
3. Run `npm run database-setup --` and choose **manual connection** (recommended).
4. Choose the **Firebird** driver and enter host, port, database path (`DB_NAME`),
   user, and password.
5. Select the product table, map required fields, and complete initial read
   validation.
6. Confirm setup succeeds without selecting any discovered file candidate.
7. Confirm secrets stay in `.env` (or `--env-file` target) and the onboarding JSON
   does not contain `CONNECTOR_TOKEN` or `DB_PASSWORD`.
8. Run `CONNECTOR_VALIDATE_ONLY=1 node --import tsx src/main.ts` and confirm
   validation succeeds with `DB_DRIVER=firebird`.

## Database Setup Discovery Path (Optional)

1. Build the connector with `npm run build`.
2. Run `npm run database-setup --` and choose **local database discovery**.
3. Use `--root <path>` when the scan should be limited to a controlled onboarding
   directory (see **Database File Discovery CLI Flow**).
4. Select a supported discovered candidate and complete connection prompts.
5. Confirm the same secret-handling and artifact rules as the manual setup flows.

## No Inbound Port

1. While the service is running, inspect listening ports with `Get-NetTCPConnection -State Listen`.
2. Confirm the connector process does not open an inbound HTTP or TCP endpoint.
3. Confirm only outbound traffic to `CONNECTOR_WS_URL` is required by the customer firewall.

## Logs

1. Confirm service logs include startup, configuration loaded, WebSocket connected, mapping received, poll completed, batch sent, batch acknowledged, and cursor advanced events.
2. Confirm logs do not contain `CONNECTOR_TOKEN` or `DB_PASSWORD` values.

## PowerShell Script Fallback Uninstall

Use when validating script-based removal instead of **Windows Installer Verification → Uninstall**.

1. Run `.\scripts\uninstall-service.ps1`.
2. Confirm `Get-Service -Name PharmaAgentConnector` returns no service.
3. Leave `%PROGRAMDATA%\PharmaAgentConnector` in place for restart investigations unless decommissioning is final.
