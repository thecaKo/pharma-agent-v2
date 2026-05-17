# Connector Configuration

The Windows Service reads configuration from machine-level environment variables at startup. Restart the service after any configuration change.

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

Local non-secret state is stored at:

```text
%PROGRAMDATA%\PharmaAgentConnector\connector-state.json
```
