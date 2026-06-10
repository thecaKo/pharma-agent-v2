import { createServer } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMockPanelConnectorConfig,
  discoverTables,
  loadPanelSimState,
  MockPanelServer,
  parseMockPanelArgs,
  runMockPanelCli,
  savePanelSimState,
  selectProductTable,
  startMockPanelServeServer
} from "../../src/cli/mock-panel.js";
import { buildAdminErrorResponseMessage, parseServerMessage, serializeConnectorMessage } from "../../src/transport/protocol.js";
import {
  buildSchemaTablesListResult,
  serializeSchemaTablesListResult
} from "../../src/transport/schema-discovery.js";
import { validMapping } from "../helpers/mapping.js";

const clients: WebSocket[] = [];

describe("mock panel CLI", () => {
  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.removeAllListeners("error");
      client.on("error", () => undefined);
      if (client.readyState === WebSocket.CONNECTING) {
        client.terminate();
      } else {
        client.close();
      }
    }
  });

  it("parses the discover command and WebSocket options", () => {
    expect(
      parseMockPanelArgs([
        "discover",
        "--host",
        "0.0.0.0",
        "--port",
        "9898",
        "--timeout-ms",
        "250",
        "--state-file",
        "/tmp/panel-state.json"
      ])
    ).toEqual({
      command: "discover",
      host: "0.0.0.0",
      port: 9898,
      timeoutMs: 250,
      stateFilePath: "/tmp/panel-state.json",
      confirmRestart: false
    });
  });

  it("parses the serve command with optional listener and artifact paths", () => {
    expect(
      parseMockPanelArgs([
        "serve",
        "--host",
        "0.0.0.0",
        "--port",
        "0",
        "--artifact-file",
        "/tmp/ob.json",
        "--connector-id",
        "a",
        "--customer-id",
        "b"
      ])
    ).toEqual({
      command: "serve",
      host: "0.0.0.0",
      port: 0,
      artifactFilePath: "/tmp/ob.json",
      connectorId: "a",
      customerId: "b"
    });
  });

  it("parses the select command with restart confirmation", () => {
    expect(parseMockPanelArgs(["select", "products", "--confirm-restart", "--state-file", "/tmp/state.json"])).toEqual(
      expect.objectContaining({
        command: "select",
        tableName: "products",
        confirmRestart: true,
        stateFilePath: "/tmp/state.json"
      })
    );
  });

  it("selecting products stores selectedProductTable in local mock panel state", async () => {
    const stateFile = await tempStateFile();

    await expect(
      selectProductTable(
        {
          stateFilePath: stateFile,
          tableName: "products",
          confirmRestart: false
        },
        { now: () => "2026-05-16T21:00:00.000Z" }
      )
    ).resolves.toMatchObject({
      changed: true,
      restartRequired: false,
      state: {
        selectedProductTable: "products",
        history: [{ tableName: "products", selectedAt: "2026-05-16T21:00:00.000Z" }]
      }
    });

    await expect(loadPanelSimState(stateFile)).resolves.toMatchObject({
      selectedProductTable: "products",
      history: [{ tableName: "products" }]
    });
  });

  it("selecting a different table appends history with table name and timestamp", async () => {
    const stateFile = await tempStateFile();
    await savePanelSimState(stateFile, {
      selectedProductTable: "products",
      history: [{ tableName: "products", selectedAt: "2026-05-16T21:00:00.000Z" }]
    });

    await selectProductTable(
      {
        stateFilePath: stateFile,
        tableName: "inventory",
        confirmRestart: true
      },
      { now: () => "2026-05-16T22:00:00.000Z" }
    );

    await expect(loadPanelSimState(stateFile)).resolves.toMatchObject({
      selectedProductTable: "inventory",
      history: [
        { tableName: "products", selectedAt: "2026-05-16T21:00:00.000Z" },
        { tableName: "inventory", selectedAt: "2026-05-16T22:00:00.000Z" }
      ]
    });
  });

  it("selecting the same table does not append restart history", async () => {
    const stateFile = await tempStateFile();
    await savePanelSimState(stateFile, {
      selectedProductTable: "products",
      history: [{ tableName: "products", selectedAt: "2026-05-16T21:00:00.000Z" }]
    });

    await expect(
      selectProductTable(
        {
          stateFilePath: stateFile,
          tableName: "products",
          confirmRestart: false
        },
        { now: () => "2026-05-16T22:00:00.000Z" }
      )
    ).resolves.toMatchObject({
      changed: false,
      restartRequired: false
    });

    await expect(loadPanelSimState(stateFile)).resolves.toMatchObject({
      history: [{ tableName: "products", selectedAt: "2026-05-16T21:00:00.000Z" }]
    });
  });

  it("refuses a changed table when restart confirmation is missing", async () => {
    const stateFile = await tempStateFile();
    await savePanelSimState(stateFile, {
      selectedProductTable: "products",
      history: [{ tableName: "products", selectedAt: "2026-05-16T21:00:00.000Z" }]
    });

    await expect(
      selectProductTable({
        stateFilePath: stateFile,
        tableName: "inventory",
        confirmRestart: false
      })
    ).rejects.toThrow("will restart product sync");

    await expect(loadPanelSimState(stateFile)).resolves.toMatchObject({
      selectedProductTable: "products",
      history: [{ tableName: "products" }]
    });
  });

  it("validates selection against discovered table names when available", async () => {
    const stateFile = await tempStateFile();
    await savePanelSimState(stateFile, {
      discoveredTables: ["inventory", "products"],
      history: []
    });

    await expect(
      selectProductTable({
        stateFilePath: stateFile,
        tableName: "customers",
        confirmRestart: false
      })
    ).rejects.toThrow("Unknown product table");
  });

  it("sends schema.tables.list with a correlated id", async () => {
    const server = new MockPanelServer({ host: "127.0.0.1", port: 0, timeoutMs: 500 });
    await server.listen();

    try {
      const client = await connectClient(server.url());
      const received = onceMessage(client);
      const discovery = server.sendDiscoveryRequest({
        correlationId: "req-test"
      });

      expect(JSON.parse(await received)).toEqual({
        type: "schema.tables.list",
        id: "req-test"
      });

      client.send(
        serializeSchemaTablesListResult(
          buildSchemaTablesListResult({
            correlationId: "req-test",
            tables: [{ name: "products", columns: [{ name: "id", type: "int" }] }]
          })
        )
      );

      await expect(discovery).resolves.toEqual([
        { name: "products", columns: [{ name: "id", type: "int" }] }
      ]);
    } finally {
      await server.close();
    }
  });

  it("prints only returned table names for successful discovery", async () => {
    const port = await freePort();
    const output = createBufferedOutput();
    const stateFile = await tempStateFile();
    const run = runMockPanelCli(["discover", "--port", String(port), "--timeout-ms", "500", "--state-file", stateFile], {
      ...output,
      requestId: () => "req-output",
      now: () => "2026-05-16T20:00:00.000Z"
    });

    const { client, firstMessage } = await connectClientWithFirstMessage(`ws://127.0.0.1:${port}`);
    const request = JSON.parse(await firstMessage) as { id: string };
    client.send(
      serializeSchemaTablesListResult(
        buildSchemaTablesListResult({
          correlationId: request.id,
          tables: [
            {
              name: "products",
              columns: [{ name: "sku", type: "varchar" }]
            },
            {
              name: "inventory",
              columns: [{ name: "qty", type: "int" }]
            }
          ]
        })
      )
    );

    await expect(run).resolves.toBe(0);
    expect(output.stdoutText()).toBe("inventory\nproducts\n");
    expect(output.stderrText()).toBe("");
    expect(output.stdoutText()).not.toContain("columns");
    expect(output.stdoutText()).not.toContain("rowCount");
    await expect(loadPanelSimState(stateFile)).resolves.toMatchObject({
      discoveredTables: ["inventory", "products"],
      discoveredSchema: [
        { name: "inventory", columns: [{ name: "qty", type: "int" }] },
        { name: "products", columns: [{ name: "sku", type: "varchar" }] }
      ]
    });
  });

  it("current command prints the selected table and handles no-selection state", async () => {
    const emptyStateFile = await tempStateFile();
    const emptyOutput = createBufferedOutput();
    await expect(runMockPanelCli(["current", "--state-file", emptyStateFile], emptyOutput)).resolves.toBe(0);
    expect(emptyOutput.stdoutText()).toBe("No product table selected.\n");

    const selectedStateFile = await tempStateFile();
    await savePanelSimState(selectedStateFile, {
      selectedProductTable: "products",
      history: []
    });
    const selectedOutput = createBufferedOutput();
    await expect(runMockPanelCli(["current", "--state-file", selectedStateFile], selectedOutput)).resolves.toBe(0);
    expect(selectedOutput.stdoutText()).toBe("Selected product table: products\n");
  });

  it("history command prints entries in deterministic order", async () => {
    const stateFile = await tempStateFile();
    await savePanelSimState(stateFile, {
      selectedProductTable: "products",
      history: [
        { tableName: "products", selectedAt: "2026-05-16T22:00:00.000Z" },
        { tableName: "inventory", selectedAt: "2026-05-16T21:00:00.000Z" }
      ]
    });
    const output = createBufferedOutput();

    await expect(runMockPanelCli(["history", "--state-file", stateFile], output)).resolves.toBe(0);

    expect(output.stdoutText()).toBe(
      "2026-05-16T21:00:00.000Z\tinventory\n2026-05-16T22:00:00.000Z\tproducts\n"
    );
  });

  it("select command output makes restart confirmation explicit before changed selection applies", async () => {
    const stateFile = await tempStateFile();
    await savePanelSimState(stateFile, {
      selectedProductTable: "products",
      history: [{ tableName: "products", selectedAt: "2026-05-16T21:00:00.000Z" }]
    });
    const rejected = createBufferedOutput();

    await expect(runMockPanelCli(["select", "inventory", "--state-file", stateFile], rejected)).resolves.toBe(1);
    expect(rejected.stderrText()).toContain("will restart product sync");

    const accepted = createBufferedOutput();
    await expect(
      runMockPanelCli(["select", "inventory", "--confirm-restart", "--state-file", stateFile], {
        ...accepted,
        now: () => "2026-05-16T22:00:00.000Z"
      })
    ).resolves.toBe(0);
    expect(accepted.stdoutText()).toContain("Sync restart confirmed");
    expect(accepted.stdoutText()).toContain("Connector config metadata: selectedProductTable=inventory");
  });

  it("generated connector config includes selectedProductTable and preserves incrementalQuery", () => {
    const mapping = validMapping({
      incrementalQuery: "select * from products where updated_at > ? order by updated_at"
    });

    expect(
      buildMockPanelConnectorConfig({
        connectorId: "connector-1",
        customerId: "customer-1",
        mapping,
        selectedProductTable: "products",
        sentAt: "2026-05-16T22:00:00.000Z"
      })
    ).toEqual({
      type: "connector.config",
      connectorId: "connector-1",
      customerId: "customer-1",
      sentAt: "2026-05-16T22:00:00.000Z",
      mapping: {
        ...mapping,
        selectedProductTable: "products",
        incrementalQuery: "select * from products where updated_at > ? order by updated_at"
      }
    });
  });

  it("mock panel server emits connector config messages with selected table metadata", async () => {
    const server = new MockPanelServer({ host: "127.0.0.1", port: 0, timeoutMs: 500 });
    await server.listen();

    try {
      const client = await connectClient(server.url());
      const received = onceMessage(client);
      await server.sendConnectorConfig(
        buildMockPanelConnectorConfig({
          connectorId: "connector-1",
          customerId: "customer-1",
          mapping: validMapping(),
          selectedProductTable: "products"
        })
      );

      expect(JSON.parse(await received)).toMatchObject({
        type: "connector.config",
        connectorId: "connector-1",
        customerId: "customer-1",
        mapping: {
          selectedProductTable: "products",
          incrementalQuery: validMapping().incrementalQuery
        }
      });
    } finally {
      await server.close();
    }
  });

  it("returns non-zero when no connector connects before timeout", async () => {
    const port = await freePort();
    const output = createBufferedOutput();

    await expect(runMockPanelCli(["discover", "--port", String(port), "--timeout-ms", "20"], output)).resolves.toBe(1);

    expect(output.stdoutText()).toBe("");
    expect(output.stderrText()).toContain("No connector connected before timeout");
  });

  it("returns non-zero when the connector sends no schema.tables.list.result (timeout)", async () => {
    const port = await freePort();
    const output = createBufferedOutput();
    const run = runMockPanelCli(["discover", "--port", String(port), "--timeout-ms", "500"], {
      ...output,
      requestId: () => "req-error",
      now: () => "2026-05-16T20:00:00.000Z"
    });

    const { client, firstMessage } = await connectClientWithFirstMessage(`ws://127.0.0.1:${port}`);
    await firstMessage;
    client.send(
      serializeConnectorMessage(
        buildAdminErrorResponseMessage(
          {
            requestId: "req-error",
            command: "schema.listTables",
            errorCode: "TABLE_DISCOVERY_FAILED",
            message: "Database password secret-password failed"
          },
          "2026-05-16T20:00:01.000Z"
        )
      )
    );

    await expect(run).resolves.toBe(1);
    expect(output.stdoutText()).toBe("");
    expect(output.stderrText()).toContain("Timed out waiting for schema.tables.list.result");
    expect(output.stderrText()).not.toContain("secret-password");
    expect(output.stderrText()).not.toContain("Database password");
  });

  it("exchanges a discovery request and response in-process", async () => {
    const port = await freePort();
    const discovery = discoverTables(
      {
        command: "discover",
        host: "127.0.0.1",
        port,
        timeoutMs: 500
      },
      {
        stdout: { write: () => true },
        stderr: { write: () => true },
        requestId: () => "req-integration",
        now: () => "2026-05-16T20:00:00.000Z"
      }
    );

    const { client, firstMessage } = await connectClientWithFirstMessage(`ws://127.0.0.1:${port}`);
    const request = JSON.parse(await firstMessage) as { id: string; type: string };

    expect(request).toMatchObject({
      type: "schema.tables.list",
      id: "req-integration"
    });

    client.send(
      serializeSchemaTablesListResult(
        buildSchemaTablesListResult({
          correlationId: request.id,
          tables: [
            { name: "produto", columns: [{ name: "a", type: "int" }] },
            { name: "estoque", columns: [{ name: "b", type: "int" }] }
          ]
        })
      )
    );

    await expect(discovery).resolves.toEqual({
      tables: ["estoque", "produto"],
      schema: [
        { name: "estoque", columns: [{ name: "b", type: "int" }] },
        { name: "produto", columns: [{ name: "a", type: "int" }] }
      ]
    });
  });

  it("returns non-zero for serve when the onboarding artifact path does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mock-panel-serve-"));
    const missing = join(dir, "absent.json");
    const output = createBufferedOutput();
    await expect(runMockPanelCli(["serve", "--artifact-file", missing], output)).resolves.toBe(1);
    expect(output.stderrText()).toMatch(/database setup/i);
    expect(output.stdoutText()).toBe("");
  });

  it("emits connector.config from a saved artifact over WebSocket and acknowledges product.batch batches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mock-panel-serve-ws-"));
    const artifactPath = join(dir, "setup.json");
    const incrementalQuery = "SELECT * FROM products WHERE id > ?";
    await writeFile(
      artifactPath,
      `${JSON.stringify(
        {
          version: "1",
          createdAt: "2026-05-18T12:00:00.000Z",
          driver: "mysql",
          databaseName: "pharmacy",
          selectedProductTable: "products",
          cursorField: "row_id",
          cursorType: "number",
          incrementalQuery,
          batchSize: 88,
          fields: {
            sourceProductCode: "cod",
            name: "nm",
            price: "pr",
            stock: "st"
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const handle = await startMockPanelServeServer({
      command: "serve",
      host: "127.0.0.1",
      port: 0,
      artifactFilePath: artifactPath,
      connectorId: "local-test-connector",
      customerId: "local-test-customer"
    });

    try {
      const { client, firstMessage } = await connectClientWithFirstMessage(handle.url);
      const raw = await firstMessage;
      const message = parseServerMessage(raw);

      expect(message.type).toBe("connector.config");
      if (message.type !== "connector.config") {
        throw new Error("expected connector.config");
      }
      expect(message.mapping.selectedProductTable).toBe("products");
      expect(message.mapping.incrementalQuery).toBe(incrementalQuery);
      expect(message.mapping.cursorField).toBe("row_id");
      expect(message.mapping.cursorType).toBe("number");
      expect(message.mapping.batchSize).toBe(88);
      expect(message.mapping.fields.sourceProductCode).toBe("cod");
      expect(message.mapping.fields.name).toBe("nm");
      expect(message.mapping.mappingVersion).toBe("local-onboarding-v1");
      expect(message.connectorId).toBe("local-test-connector");
      expect(message.customerId).toBe("local-test-customer");

      client.send(
        JSON.stringify({
          type: "product.batch",
          sentAt: "2026-05-18T12:05:00.000Z",
          batchId: "batch-xyz",
          mappingVersion: "local-onboarding-v1",
          cursor: {
            before: null,
            after: null
          },
          products: [{ code: "1", name: "n", salePrice: 1, stockQuantity: 2 }]
        })
      );

      const ackRaw = await onceMessage(client);
      const ack = parseServerMessage(ackRaw);
      expect(ack).toMatchObject({
        type: "batch.ack",
        batchId: "batch-xyz",
        accepted: true,
        acceptedRecordCount: 1,
        rejectedRecordCount: 0,
        nextAction: "continue"
      });
    } finally {
      await handle.close();
    }
  });
});

async function connectClient(url: string, timeoutMs = 500): Promise<WebSocket> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await openClient(url);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Unable to connect test WebSocket client");
}

function openClient(url: string): Promise<WebSocket> {
  const client = new WebSocket(url, {
    headers: {
      Authorization: "Bearer connector-token"
    }
  });
  clients.push(client);
  return new Promise((resolve, reject) => {
    client.once("open", () => resolve(client));
    client.once("error", (error) => {
      const index = clients.indexOf(client);
      if (index >= 0) {
        clients.splice(index, 1);
      }
      client.removeAllListeners();
      reject(error);
    });
  });
}

function onceMessage(client: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    client.once("message", (data) => {
      resolve(data.toString());
    });
  });
}

async function connectClientWithFirstMessage(
  url: string,
  timeoutMs = 500
): Promise<{ client: WebSocket; firstMessage: Promise<string> }> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await openClientWithFirstMessage(url);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Unable to connect test WebSocket client");
}

function openClientWithFirstMessage(url: string): Promise<{ client: WebSocket; firstMessage: Promise<string> }> {
  const client = new WebSocket(url, {
    headers: {
      Authorization: "Bearer connector-token"
    }
  });
  clients.push(client);
  const firstMessage = onceMessage(client);

  return new Promise((resolve, reject) => {
    client.once("open", () => resolve({ client, firstMessage }));
    client.once("error", (error) => {
      const index = clients.indexOf(client);
      if (index >= 0) {
        clients.splice(index, 1);
      }
      client.removeAllListeners();
      reject(error);
    });
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to allocate free port");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  return port;
}

function createBufferedOutput(): {
  stdout: { write: (chunk: string) => boolean };
  stderr: { write: (chunk: string) => boolean };
  stdoutText: () => string;
  stderrText: () => string;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout: {
      write: (chunk) => {
        stdout.push(chunk);
        return true;
      }
    },
    stderr: {
      write: (chunk) => {
        stderr.push(chunk);
        return true;
      }
    },
    stdoutText: () => stdout.join(""),
    stderrText: () => stderr.join("")
  };
}

async function tempStateFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mock-panel-state-"));
  return join(dir, "state.json");
}
