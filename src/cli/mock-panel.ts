import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import type { ValidatedMappingConfig } from "../mapping/types.js";
import {
  buildAdminRequestMessage,
  parseAdminResponseMessage,
  serializeServerMessage,
  type AdminResponseMessage,
  type ConnectorConfigMessage
} from "../transport/protocol.js";
import { DEFAULT_ONBOARDING_ARTIFACT_FILE_PATH } from "./database-setup.js";
import { loadValidatedMappingFromOnboardingArtifactFile } from "./onboarding-artifact-loader.js";

export interface MockPanelInteractiveCliOptions {
  command: "discover" | "select" | "current" | "history";
  host: string;
  port: number;
  timeoutMs: number;
  stateFilePath: string;
  tableName?: string;
  confirmRestart: boolean;
}

export interface MockPanelServeCliOptions {
  command: "serve";
  host: string;
  port: number;
  artifactFilePath: string;
  connectorId: string;
  customerId: string;
}

export type MockPanelCliOptions = MockPanelInteractiveCliOptions | MockPanelServeCliOptions;

const DEFAULT_SERVE_CONNECTOR_ID = "local-test-connector";
const DEFAULT_SERVE_CUSTOMER_ID = "local-test-customer";

export interface MockPanelCliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
  now?: () => string;
  requestId?: () => string;
}

export interface DiscoveryResult {
  tables: string[];
}

export interface PanelSelectionHistoryEntry {
  tableName: string;
  selectedAt: string;
}

export interface PanelSimState {
  selectedProductTable?: string;
  discoveredTables?: string[];
  history: PanelSelectionHistoryEntry[];
}

export interface SelectProductTableResult {
  state: PanelSimState;
  changed: boolean;
  restartRequired: boolean;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STATE_FILE_PATH = join(homedir(), ".pharma-agent", "mock-panel-state.json");

export function parseMockPanelArgs(argv: readonly string[]): MockPanelCliOptions {
  const args = [...argv];
  const command = args.shift();

  if (!command || !["discover", "select", "current", "history", "serve"].includes(command)) {
    throw new Error(
      [
        "Usage:",
        '  mock-panel serve [--host <host>] [--port <port>] [--artifact-file <path>] [--connector-id <id>] [--customer-id <id>]',
        '  mock-panel discover [options]',
        '  mock-panel select <table> [options]',
        "  mock-panel current",
        '  mock-panel history'
      ].join("\n")
    );
  }

  if (command === "serve") {
    return parseMockPanelServeArgs(args);
  }

  const options: MockPanelInteractiveCliOptions = {
    command: command as MockPanelInteractiveCliOptions["command"],
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    stateFilePath: DEFAULT_STATE_FILE_PATH,
    confirmRestart: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    switch (arg) {
      case "--host":
        options.host = requiredValue(args, ++index, "--host");
        break;
      case "--port":
        options.port = parsePositiveInteger(requiredValue(args, ++index, "--port"), "--port");
        break;
      case "--timeout-ms":
        options.timeoutMs = parsePositiveInteger(requiredValue(args, ++index, "--timeout-ms"), "--timeout-ms");
        break;
      case "--state-file":
        options.stateFilePath = requiredValue(args, ++index, "--state-file");
        break;
      case "--confirm-restart":
        options.confirmRestart = true;
        break;
      default:
        if (options.command === "select" && !options.tableName && !arg.startsWith("--")) {
          options.tableName = arg;
          break;
        }
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (options.command === "select" && !options.tableName) {
    throw new Error("Usage: mock-panel select <table> [--confirm-restart] [--state-file <path>]");
  }

  return options;
}

function parseMockPanelServeArgs(argv: readonly string[]): MockPanelServeCliOptions {
  const args = [...argv];
  const options: MockPanelServeCliOptions = {
    command: "serve",
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    artifactFilePath: DEFAULT_ONBOARDING_ARTIFACT_FILE_PATH,
    connectorId: DEFAULT_SERVE_CONNECTOR_ID,
    customerId: DEFAULT_SERVE_CUSTOMER_ID
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    switch (arg) {
      case "--host":
        options.host = requiredValue(args, ++index, "--host");
        break;
      case "--port":
        options.port = parseTcpPort(requiredValue(args, ++index, "--port"), "--port");
        break;
      case "--artifact-file":
        options.artifactFilePath = requiredValue(args, ++index, "--artifact-file");
        break;
      case "--connector-id":
        options.connectorId = requiredValue(args, ++index, "--connector-id");
        break;
      case "--customer-id":
        options.customerId = requiredValue(args, ++index, "--customer-id");
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

export async function runMockPanelCli(argv: readonly string[], io: MockPanelCliIo = defaultIo()): Promise<number> {
  let options: MockPanelCliOptions;
  try {
    options = parseMockPanelArgs(argv);
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 1;
  }

  try {
    switch (options.command) {
      case "discover": {
        const result = await discoverTables(options, io);
        await savePanelSimState(options.stateFilePath, {
          ...(await loadPanelSimState(options.stateFilePath)),
          discoveredTables: result.tables
        });
        for (const table of result.tables) {
          io.stdout.write(`${table}\n`);
        }
        return 0;
      }
      case "select": {
        const result = await selectProductTable(
          {
            stateFilePath: options.stateFilePath,
            tableName: options.tableName!,
            confirmRestart: options.confirmRestart
          },
          io
        );
        if (!result.changed) {
          io.stdout.write(`Product table already selected: ${result.state.selectedProductTable}\n`);
          return 0;
        }
        if (result.restartRequired) {
          io.stdout.write("Sync restart confirmed for changed product table selection.\n");
        }
        io.stdout.write(`Selected product table: ${result.state.selectedProductTable}\n`);
        io.stdout.write(`Connector config metadata: selectedProductTable=${result.state.selectedProductTable}\n`);
        return 0;
      }
      case "current":
        await printCurrentSelection(options.stateFilePath, io);
        return 0;
      case "history":
        await printSelectionHistory(options.stateFilePath, io);
        return 0;
      case "serve": {
        let handle: MockPanelServeHandle;
        try {
          handle = await startMockPanelServeServer(options);
        } catch (error) {
          io.stderr.write(`${formatError(error)}\n`);
          return 1;
        }

        io.stdout.write(`listening on ${handle.url}\n`);
        await new Promise<void>((resolve) => {
          process.once("SIGINT", resolve);
          process.once("SIGTERM", resolve);
        });
        await handle.close();
        return 0;
      }
    }
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 1;
  }
}

export async function discoverTables(
  options: MockPanelInteractiveCliOptions,
  io: MockPanelCliIo = defaultIo()
): Promise<DiscoveryResult> {
  const server = new MockPanelServer({
    host: options.host,
    port: options.port,
    timeoutMs: options.timeoutMs
  });

  try {
    await server.listen();
    const requestId = io.requestId?.() ?? `schema-listTables-${Date.now()}`;
    const response = await server.sendDiscoveryRequest({
      requestId,
      sentAt: io.now?.() ?? new Date().toISOString()
    });

    if (!response.ok) {
      throw new Error(`Discovery failed: ${response.error.errorCode}`);
    }

    return {
      tables: [...response.payload.tables].sort((left, right) => left.localeCompare(right))
    };
  } finally {
    await server.close();
  }
}

export async function selectProductTable(
  input: {
    stateFilePath: string;
    tableName: string;
    confirmRestart: boolean;
  },
  io: Pick<MockPanelCliIo, "now"> = {}
): Promise<SelectProductTableResult> {
  const tableName = input.tableName.trim();
  if (tableName.length === 0) {
    throw new Error("Product table name is required");
  }

  const state = await loadPanelSimState(input.stateFilePath);
  if (state.discoveredTables && state.discoveredTables.length > 0 && !state.discoveredTables.includes(tableName)) {
    throw new Error(`Unknown product table: ${tableName}. Run discovery again or choose a discovered table.`);
  }

  const previousSelection = state.selectedProductTable;
  const changed = previousSelection !== tableName;
  if (!changed) {
    return {
      state,
      changed: false,
      restartRequired: false
    };
  }

  const restartRequired = previousSelection !== undefined;
  if (restartRequired && !input.confirmRestart) {
    throw new Error(
      `Changing product table from ${previousSelection} to ${tableName} will restart product sync. Re-run with --confirm-restart to apply.`
    );
  }

  const nextState: PanelSimState = {
    ...state,
    selectedProductTable: tableName,
    history: [
      ...state.history,
      {
        tableName,
        selectedAt: io.now?.() ?? new Date().toISOString()
      }
    ]
  };
  await savePanelSimState(input.stateFilePath, nextState);

  return {
    state: nextState,
    changed: true,
    restartRequired
  };
}

export async function printCurrentSelection(stateFilePath: string, io: MockPanelCliIo = defaultIo()): Promise<void> {
  const state = await loadPanelSimState(stateFilePath);
  if (!state.selectedProductTable) {
    io.stdout.write("No product table selected.\n");
    return;
  }
  io.stdout.write(`Selected product table: ${state.selectedProductTable}\n`);
}

export async function printSelectionHistory(stateFilePath: string, io: MockPanelCliIo = defaultIo()): Promise<void> {
  const state = await loadPanelSimState(stateFilePath);
  if (state.history.length === 0) {
    io.stdout.write("No product table selection history.\n");
    return;
  }

  const entries = [...state.history].sort((left, right) =>
    left.selectedAt === right.selectedAt
      ? left.tableName.localeCompare(right.tableName)
      : left.selectedAt.localeCompare(right.selectedAt)
  );
  for (const entry of entries) {
    io.stdout.write(`${entry.selectedAt}\t${entry.tableName}\n`);
  }
}

export async function loadPanelSimState(stateFilePath: string): Promise<PanelSimState> {
  try {
    const serialized = await readFile(stateFilePath, "utf8");
    return normalizePanelSimState(JSON.parse(serialized));
  } catch (error) {
    if (isMissingFileError(error)) {
      return emptyPanelSimState();
    }
    throw error;
  }
}

export async function savePanelSimState(stateFilePath: string, state: PanelSimState): Promise<void> {
  await mkdir(dirname(stateFilePath), { recursive: true });
  await writeFile(stateFilePath, `${JSON.stringify(normalizePanelSimState(state), null, 2)}\n`, "utf8");
}

export function buildMockPanelConnectorConfig(input: {
  connectorId: string;
  customerId: string;
  mapping: ValidatedMappingConfig;
  selectedProductTable: string;
  sentAt?: string;
}): ConnectorConfigMessage {
  return {
    type: "connector.config",
    connectorId: input.connectorId,
    customerId: input.customerId,
    mapping: {
      ...input.mapping,
      selectedProductTable: input.selectedProductTable
    },
    sentAt: input.sentAt
  };
}

export interface MockPanelServeHandle {
  url: string;
  close(): Promise<void>;
}

export async function startMockPanelServeServer(options: MockPanelServeCliOptions): Promise<MockPanelServeHandle> {
  const mapping = await loadValidatedMappingFromOnboardingArtifactFile(options.artifactFilePath);
  const selectedProductTable = mapping.selectedProductTable;
  if (!selectedProductTable) {
    throw new Error(
      "Onboarding artifact is missing selectedProductTable. Run interactive database-setup to regenerate the artifact."
    );
  }

  const configMessage = buildMockPanelConnectorConfig({
    connectorId: options.connectorId,
    customerId: options.customerId,
    mapping,
    selectedProductTable,
    sentAt: new Date().toISOString()
  });

  const server = new WebSocketServer({
    host: options.host,
    port: options.port
  });

  server.on("connection", (socket) => {
    socket.send(serializeServerMessage(configMessage));
    socket.on("message", (data) => {
      replyToProductBatch(socket, data);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close(() => undefined);
    throw new Error("Mock panel serve is not listening.");
  }

  return {
    url: `ws://${options.host}:${address.port}`,
    close: async () => {
      for (const ws of [...server.clients]) {
        ws.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  };
}

export interface MockPanelServerOptions {
  host: string;
  port: number;
  timeoutMs: number;
}

export class MockPanelServer {
  private readonly options: MockPanelServerOptions;
  private server?: WebSocketServer;
  private connector?: WebSocket;
  private readonly pendingResponses = new Map<string, (response: AdminResponseMessage) => void>();

  public constructor(options: MockPanelServerOptions) {
    this.options = options;
  }

  public async listen(): Promise<void> {
    this.server = new WebSocketServer({
      host: this.options.host,
      port: this.options.port
    });

    this.server.on("connection", (socket) => {
      this.connector = socket;
      socket.on("message", (data) => this.handleMessage(data));
      socket.on("close", () => {
        if (this.connector === socket) {
          this.connector = undefined;
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("listening", resolve);
      this.server?.once("error", reject);
    });
  }

  public url(): string {
    const address = this.server?.address();
    if (!address || typeof address === "string") {
      throw new Error("Mock panel server is not listening");
    }
    return `ws://${this.options.host}:${address.port}`;
  }

  public async sendDiscoveryRequest(input: { requestId: string; sentAt: string }): Promise<AdminResponseMessage> {
    const connector = await this.waitForConnector();
    const request = buildAdminRequestMessage(
      {
        requestId: input.requestId,
        command: "schema.listTables"
      },
      input.sentAt
    );

    const response = new Promise<AdminResponseMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(request.requestId);
        reject(new Error(`Timed out waiting for schema.listTables response (${this.options.timeoutMs} ms).`));
      }, this.options.timeoutMs);

      this.pendingResponses.set(request.requestId, (message) => {
        clearTimeout(timeout);
        resolve(message);
      });
    });

    connector.send(serializeServerMessage(request));
    return response;
  }

  public async sendConnectorConfig(message: ConnectorConfigMessage): Promise<void> {
    const connector = await this.waitForConnector();
    connector.send(serializeServerMessage(message));
  }

  public async close(): Promise<void> {
    for (const resolve of this.pendingResponses.values()) {
      resolve({
        type: "admin.response",
        requestId: "closed",
        command: "schema.listTables",
        ok: false,
        error: {
          errorCode: "MOCK_PANEL_CLOSED",
          message: "Mock panel closed"
        },
        sentAt: new Date().toISOString()
      });
    }
    this.pendingResponses.clear();

    for (const client of this.server?.clients ?? []) {
      client.terminate();
    }
    this.connector = undefined;

    const server = this.server;
    this.server = undefined;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async waitForConnector(): Promise<WebSocket> {
    if (this.connector?.readyState === WebSocket.OPEN) {
      return this.connector;
    }

    return new Promise<WebSocket>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`No connector connected before timeout (${this.options.timeoutMs} ms).`));
      }, this.options.timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timeout);
        this.server?.off("connection", onConnection);
      };
      const onConnection = (socket: WebSocket): void => {
        cleanup();
        resolve(socket);
      };
      this.server?.on("connection", onConnection);
    });
  }

  private handleMessage(data: RawData): void {
    let message: AdminResponseMessage;
    try {
      message = parseAdminResponseMessage(data);
    } catch {
      return;
    }

    const resolve = this.pendingResponses.get(message.requestId);
    if (!resolve) {
      return;
    }
    this.pendingResponses.delete(message.requestId);
    resolve(message);
  }
}

function requiredValue(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (!value) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

function parseTcpPort(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`${option} must be an integer from 0 to 65535`);
  }
  return parsed;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function replyToProductBatch(socket: WebSocket, data: RawData): void {
  let parsed: unknown;
  try {
    const text =
      typeof data === "string"
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data).toString("utf8")
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : Buffer.from(data as ArrayBuffer).toString("utf8");
    parsed = JSON.parse(text);
  } catch {
    return;
  }

  if (!isRecord(parsed) || parsed.type !== "product.batch") {
    return;
  }

  const batch = parsed.batch;
  if (!isRecord(batch)) {
    return;
  }

  const batchId = batch.batchId;
  const records = batch.records;
  if (typeof batchId !== "string" || batchId.trim().length === 0 || !Array.isArray(records)) {
    return;
  }

  socket.send(
    serializeServerMessage({
      type: "batch.ack",
      batchId,
      accepted: true,
      acceptedRecordCount: records.length,
      rejectedRecordCount: 0,
      nextAction: "continue",
      sentAt: new Date().toISOString()
    })
  );
}

function defaultIo(): MockPanelCliIo {
  return {
    stdout: process.stdout,
    stderr: process.stderr
  };
}

function normalizePanelSimState(value: unknown): PanelSimState {
  if (!isRecord(value)) {
    return emptyPanelSimState();
  }

  const selectedProductTable = normalizeOptionalString(value.selectedProductTable);
  const discoveredTables = Array.isArray(value.discoveredTables)
    ? uniqueSortedStrings(value.discoveredTables)
    : undefined;
  const history = Array.isArray(value.history)
    ? value.history
        .filter(isRecord)
        .map((entry) => ({
          tableName: normalizeOptionalString(entry.tableName),
          selectedAt: normalizeOptionalString(entry.selectedAt)
        }))
        .filter((entry): entry is PanelSelectionHistoryEntry => Boolean(entry.tableName && entry.selectedAt))
    : [];

  return {
    ...(selectedProductTable ? { selectedProductTable } : {}),
    ...(discoveredTables ? { discoveredTables } : {}),
    history
  };
}

function emptyPanelSimState(): PanelSimState {
  return {
    history: []
  };
}

function uniqueSortedStrings(values: unknown[]): string[] {
  return [...new Set(values.map(normalizeOptionalString).filter((value): value is string => Boolean(value)))].sort(
    (left, right) => left.localeCompare(right)
  );
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const exitCode = await runMockPanelCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
