# Pharma Agent Connector

Local TypeScript runtime foundation for the Pharma Agent connector Windows Service.

## Local Development

Install dependencies:

```sh
npm install
```

Build TypeScript:

```sh
npm run build
```

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
