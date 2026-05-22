# Windows Service Operations

The service name is `PharmaAgentConnector`. Display name: **Pharma Agent Connector**.

## Installer-First Installation (Recommended)

Internal Windows deployments should use the packaged installer instead of manual
PowerShell service scripts.

1. Build the connector and produce the installer on a Windows build host with WiX
   Toolset and a staged `node.exe` (see `npm run package:windows-installer`).
2. Distribute and run `PharmaAgentConnector.msi` from the packaging output
   (`installer/bin/Release/PharmaAgentConnector.msi` after a successful build).
3. Complete the wizard: enter the connector token and central WebSocket URL only.
4. Confirm the completion screen. It reports service installation status and
   points to the remaining database onboarding step.

Run the installer with administrator privileges. Windows Installer handles file
placement, ProgramData config creation, and service registration.

**Install:** launch the setup executable on a clean host or when upgrading from
a prior installer build.

**Repair:** run the same setup executable again and choose **Repair** when the
service or ProgramData config must be restored without a full removal.

**Uninstall:** use **Apps & features** / **Installed apps**, select **Pharma Agent
Connector**, and uninstall. Windows Installer removes the service and application
files. Remove `%PROGRAMDATA%\PharmaAgentConnector` manually only when fully
decommissioning the connector on that host.

The installer does not configure the pharmacy database. After install, follow
`docs/configuration.md` (**After Windows Installer Completion**) and run
`npm run database-setup --` before expecting production synchronization.
Before that database onboarding exists, the service should remain running in a
setup-waiting state rather than stopping because `DB_*` variables are missing.

## PowerShell Script Fallback (Administrative)

Use the scripts under `scripts/` only when the WiX installer cannot be used
(for example development hosts, recovery, or scripted lab provisioning). They are
not the normal internal deployment path.

Metadata matches the installer: service name `PharmaAgentConnector`, automatic
startup, recovery restart after failures, and entrypoint `dist\main.js` via
`node.exe`.

### Install (fallback)

Build the connector before installation:

```powershell
npm ci
npm run build
.\scripts\install-service.ps1
```

The script registers an automatic Windows Service. It warns when required machine
environment variables are missing (including database settings the installer does
not collect).

### Configure (fallback)

Set environment variables documented in `docs/configuration.md`, or rely on
ProgramData `connector-config.json` for central settings when the installer wrote
them. Restart after changes:

```powershell
.\scripts\restart-service.ps1
```

The connector opens only an outbound WebSocket to `CONNECTOR_WS_URL`. It does not
create inbound HTTP or TCP listeners.

### Restart

```powershell
.\scripts\restart-service.ps1 -ServiceName PharmaAgentConnector
```

### Stop and Start

```powershell
Stop-Service -Name PharmaAgentConnector
Start-Service -Name PharmaAgentConnector
```

### Uninstall (fallback)

```powershell
.\scripts\uninstall-service.ps1 -ServiceName PharmaAgentConnector
```

This removes the Windows Service registration only. Remove machine environment
variables and `%PROGRAMDATA%\PharmaAgentConnector` manually when fully
decommissioning.

## Logs and State

Structured runtime logs are written to the service stdout/stderr target configured
by Windows Service hosting. Local non-secret cursor state is stored under:

```text
%PROGRAMDATA%\PharmaAgentConnector\connector-state.json
```

The state file must not contain `CONNECTOR_TOKEN`, `DB_PASSWORD`, or raw database
credentials. Runtime logs redact connector tokens and database passwords.

## Service Account

Run the service with the least-privileged account that can read ProgramData config
(or machine environment variables), open the outbound WebSocket URL, and read from
the source MySQL or Firebird database.
