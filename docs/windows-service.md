# Windows Service Operations

The MVP service name is `PharmaAgentConnector`.

## Install

Build the connector before installation:

```powershell
npm ci
npm run build
.\scripts\install-service.ps1
```

The installer creates an automatic Windows Service and configures service recovery to restart after failures. It warns when required machine environment variables are missing.

## Configure

Set the environment variables documented in `docs/configuration.md`, then restart the service:

```powershell
.\scripts\restart-service.ps1
```

The connector opens only an outbound WebSocket connection to `CONNECTOR_WS_URL`. It does not create inbound HTTP or TCP listeners.

## Restart

Use restart after config changes, package updates, or central mapping troubleshooting:

```powershell
.\scripts\restart-service.ps1 -ServiceName PharmaAgentConnector
```

## Stop and Start

```powershell
Stop-Service -Name PharmaAgentConnector
Start-Service -Name PharmaAgentConnector
```

## Logs and State

Structured runtime logs are written to the service stdout/stderr target configured by Windows Service hosting. Local non-secret cursor state is stored under:

```text
%PROGRAMDATA%\PharmaAgentConnector\connector-state.json
```

The state file must not contain `CONNECTOR_TOKEN`, `DB_PASSWORD`, or raw database credentials.

## Uninstall

```powershell
.\scripts\uninstall-service.ps1 -ServiceName PharmaAgentConnector
```

Uninstalling removes the Windows Service. Remove machine environment variables and `%PROGRAMDATA%\PharmaAgentConnector` manually only when the customer is fully decommissioned.

## Service Account

Run the service with the least-privileged account that can read machine environment variables, open the outbound WebSocket URL, and read from the source MySQL or Firebird database.
