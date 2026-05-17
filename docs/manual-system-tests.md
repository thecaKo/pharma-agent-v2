# Manual System Tests

Run these checks on a Windows host before a customer rollout.

## Installation

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

## No Inbound Port

1. While the service is running, inspect listening ports with `Get-NetTCPConnection -State Listen`.
2. Confirm the connector process does not open an inbound HTTP or TCP endpoint.
3. Confirm only outbound traffic to `CONNECTOR_WS_URL` is required by the customer firewall.

## Logs

1. Confirm service logs include startup, configuration loaded, WebSocket connected, mapping received, poll completed, batch sent, batch acknowledged, and cursor advanced events.
2. Confirm logs do not contain `CONNECTOR_TOKEN` or `DB_PASSWORD` values.

## Uninstall

1. Run `.\scripts\uninstall-service.ps1`.
2. Confirm `Get-Service -Name PharmaAgentConnector` returns no service.
3. Leave `%PROGRAMDATA%\PharmaAgentConnector` in place for restart investigations unless decommissioning is final.
