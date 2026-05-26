import { homedir } from "node:os";
import path from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { Environment } from "../config/env.js";
import { configSecrets, loadConfig } from "../config/env.js";
import type { DatabaseConfig, DatabaseDriver, LogLevel } from "../config/types.js";
import { createSourceDatabaseAdapter, type AdapterFactoryDependencies } from "../db/adapter-factory.js";
import { attachFirebirdConnection } from "../db/firebird-driver.js";
import { DatabaseOperationError } from "../db/errors.js";
import {
  buildDatabaseSetupCandidateViews,
  discoverDatabaseFiles,
  formatDatabaseSetupCandidateView,
  type DatabaseFileCandidate,
  type DatabaseFileDiscoveryOptions,
  type DatabaseFileDiscoveryResult,
  type DatabaseSetupCandidateView
} from "../db/file-discovery.js";
import type { DatabaseColumn, DatabaseTable, SourceDatabaseAdapter } from "../db/source-adapter.js";
import { redactString } from "../logging/redact.js";
import type { CursorType, MappingConfig, ProductFieldMappings } from "../mapping/types.js";
import { validateMappingConfig } from "../mapping/validate.js";
import {
  writeDatabaseSetupState,
  type DatabaseSetupStateInput,
  type OnboardingFieldMapping,
  type OnboardingMappingArtifact
} from "./database-setup-state.js";
import { LOCAL_ONBOARDING_MAPPING_VERSION } from "./onboarding-artifact-loader.js";
import { writeConnectorEnvFile, type WriteConnectorEnvFileResult } from "./env-file.js";

export interface DatabaseSetupCliOptions {
  roots?: string[];
  envFilePath: string;
  artifactFilePath: string;
  connectorToken?: string;
  websocketUrl?: string;
  logLevel: LogLevel;
  batchSize: number;
  pollIntervalMs: number;
}

export interface DatabaseSetupPromptSelectChoice {
  value: string;
  label: string;
}

export interface DatabaseSetupPrompt {
  text(input: {
    message: string;
    defaultValue?: string;
    secret?: boolean;
  }): Promise<string>;
  select(input: {
    message: string;
    choices: readonly DatabaseSetupPromptSelectChoice[];
    defaultValue?: string;
  }): Promise<string>;
  confirm(input: {
    message: string;
    defaultValue?: boolean;
  }): Promise<boolean>;
}

export interface CreateDatabaseSetupAdapterInput {
  config: DatabaseConfig;
  secrets?: readonly string[];
}

export interface DatabaseSetupCliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
  stdin?: NodeJS.ReadStream;
  prompt?: DatabaseSetupPrompt;
  discoverDatabaseFiles?: (options: DatabaseFileDiscoveryOptions) => Promise<DatabaseFileDiscoveryResult>;
  createAdapter?: (input: CreateDatabaseSetupAdapterInput) => SourceDatabaseAdapter;
  writeConnectorEnvFile?: (input: {
    envFilePath: string;
    values: Record<string, string | number | undefined>;
    now?: Date;
  }) => Promise<WriteConnectorEnvFileResult>;
  writeDatabaseSetupState?: (input: DatabaseSetupStateInput) => Promise<OnboardingMappingArtifact>;
  env?: Environment;
  now?: () => Date;
}

export interface FieldRecommendation {
  key: keyof ProductFieldMappings;
  label: string;
  required: boolean;
}

export type DatabaseSetupMode = "manual" | "discovery";

export interface DatabaseSetupConnectionSource {
  mode: DatabaseSetupMode;
  driver: DatabaseDriver;
  candidate?: DatabaseSetupCandidateView;
}

export interface DatabaseSetupSelection {
  mode: DatabaseSetupMode;
  candidate?: DatabaseSetupCandidateView;
  config: DatabaseConfig;
  selectedTable: string;
  cursorField: string;
  cursorType: CursorType;
  incrementalQuery: string;
  batchSize: number;
  mapping: OnboardingFieldMapping;
}

const DEFAULT_ENV_FILE_PATH = path.join(process.cwd(), ".env");
export const DEFAULT_ONBOARDING_ARTIFACT_FILE_PATH = path.join(homedir(), ".pharma-agent", "database-setup.json");
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_LOG_LEVEL: LogLevel = "info";

const TABLE_HINTS = [
  "product",
  "produto",
  "item",
  "inventory",
  "estoque",
  "catalog"
] as const;

const FIELD_RECOMMENDATIONS: readonly FieldRecommendation[] = [
  { key: "sourceProductCode", label: "product code", required: true },
  { key: "name", label: "product name", required: true },
  { key: "price", label: "price", required: true },
  { key: "stock", label: "stock", required: true },
  { key: "barcode", label: "barcode", required: false },
  { key: "active", label: "active flag", required: false },
  { key: "sourceUpdatedAt", label: "updated at", required: false }
];

const FIELD_HINTS: Record<FieldRecommendation["key"], readonly string[]> = {
  sourceProductCode: ["product_id", "produto_id", "code", "codigo", "sku", "item"],
  name: ["name", "nome", "description", "descricao", "produto"],
  price: ["price", "preco", "valor", "sale_price", "unit_price"],
  stock: ["stock", "estoque", "quantity", "qty", "saldo"],
  barcode: ["barcode", "ean", "gtin", "bar", "codigo_barras"],
  active: ["active", "ativo", "enabled", "status"],
  sourceUpdatedAt: ["updated", "update", "modified", "alterado", "data_alt", "timestamp"]
};

export function parseDatabaseSetupArgs(argv: readonly string[]): DatabaseSetupCliOptions {
  const options: DatabaseSetupCliOptions = {
    envFilePath: DEFAULT_ENV_FILE_PATH,
    artifactFilePath: DEFAULT_ONBOARDING_ARTIFACT_FILE_PATH,
    logLevel: DEFAULT_LOG_LEVEL,
    batchSize: DEFAULT_BATCH_SIZE,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }

    switch (arg) {
      case "--root":
        options.roots = [...(options.roots ?? []), requiredValue(argv, ++index, "--root")];
        break;
      case "--env-file":
        options.envFilePath = requiredValue(argv, ++index, "--env-file");
        break;
      case "--artifact-file":
        options.artifactFilePath = requiredValue(argv, ++index, "--artifact-file");
        break;
      case "--connector-token":
        options.connectorToken = requiredValue(argv, ++index, "--connector-token");
        break;
      case "--ws-url":
        options.websocketUrl = requiredValue(argv, ++index, "--ws-url");
        break;
      case "--log-level":
        options.logLevel = parseLogLevel(requiredValue(argv, ++index, "--log-level"));
        break;
      case "--batch-size":
        options.batchSize = parsePositiveInteger(requiredValue(argv, ++index, "--batch-size"), "--batch-size");
        break;
      case "--poll-interval-ms":
        options.pollIntervalMs = parsePositiveInteger(
          requiredValue(argv, ++index, "--poll-interval-ms"),
          "--poll-interval-ms"
        );
        break;
      case "--help":
        throw new Error(usage());
      default:
        throw new Error(arg.startsWith("--") ? `Unknown option: ${arg}` : `Unknown argument: ${arg}`);
    }
  }

  return options;
}

export async function runDatabaseSetupCli(
  argv: readonly string[],
  io: DatabaseSetupCliIo = defaultIo()
): Promise<number> {
  let options: DatabaseSetupCliOptions;
  try {
    options = parseDatabaseSetupArgs(argv);
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 1;
  }

  try {
    await runDatabaseSetup(options, io);
    return 0;
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 1;
  }
}

export async function selectSetupMode(
  prompt: DatabaseSetupPrompt,
  io: Pick<DatabaseSetupCliIo, "stdout">
): Promise<DatabaseSetupMode> {
  const selected = await prompt.select({
    message: "Selecione o modo de configuracao",
    choices: [
      { value: "manual", label: "Conexao manual (recomendado)" },
      { value: "discovery", label: "Descobrir bancos locais" }
    ],
    defaultValue: "manual"
  });

  if (selected === "discovery") {
    io.stdout.write("Modo: descoberta local.\n");
    return "discovery";
  }

  io.stdout.write("Modo: conexao manual.\n");
  return "manual";
}

export async function selectManualDriver(prompt: DatabaseSetupPrompt): Promise<DatabaseDriver> {
  const selected = await prompt.select({
    message: "Selecione o driver do banco",
    choices: [
      { value: "mysql", label: "MySQL" },
      { value: "firebird", label: "Firebird" }
    ],
    defaultValue: "mysql"
  });
  return selected === "firebird" ? "firebird" : "mysql";
}

async function resolveConnectionSource(input: {
  mode: DatabaseSetupMode;
  options: DatabaseSetupCliOptions;
  prompt: DatabaseSetupPrompt;
  io: DatabaseSetupCliIo;
  scan: NonNullable<DatabaseSetupCliIo["discoverDatabaseFiles"]>;
}): Promise<DatabaseSetupConnectionSource> {
  if (input.mode === "manual") {
    const driver = await selectManualDriver(input.prompt);
    return manualConnectionSource(driver);
  }

  input.io.stdout.write("Buscando bancos locais...\n");
  const discovery = await input.scan({ roots: input.options.roots });
  const candidate = await selectCandidate(discovery.candidates, input.prompt, input.io);
  return discoveryConnectionSource(candidate);
}

export async function runDatabaseSetup(
  options: DatabaseSetupCliOptions,
  io: DatabaseSetupCliIo = defaultIo()
): Promise<DatabaseSetupSelection> {
  const prompt = io.prompt ?? createReadlinePrompt(io);
  const env = io.env ?? process.env;
  const now = io.now ?? (() => new Date());
  const scan = io.discoverDatabaseFiles ?? discoverDatabaseFiles;
  const persistEnv = io.writeConnectorEnvFile ?? writeConnectorEnvFile;
  const persistState = io.writeDatabaseSetupState ?? writeDatabaseSetupState;

  const mode = await selectSetupMode(prompt, io);
  const connectionSource = await resolveConnectionSource({ mode, options, prompt, io, scan });
  let config = await promptForConnectionConfig({ source: connectionSource, options, prompt, env, io });

  let adapter = createAdapter({ config, io });
  try {
    ({ adapter, config } = await connectWithRetry({ adapter, config, options, source: connectionSource, prompt, env, io }));
    io.stdout.write("Conexao OK.\n");
    io.stdout.write("Listando tabelas...\n");
    const tables = await adapter.listTables();
    const selectedTable = await selectTable(tables, prompt);
    io.stdout.write("Listando colunas da tabela...\n");
    const columns = await adapter.listColumns(selectedTable);
    const cursorField = await selectCursorField(columns, prompt);
    const cursorType = await resolveCursorType(cursorField, columns, prompt);
    const mapping = await selectFieldMappings(columns, cursorField, prompt);
    const incrementalQuery = buildIncrementalReadTestQuery(config.driver, selectedTable, cursorField);
    validateMappingConfig(buildValidatedMappingInput({ mapping, selectedTable, cursorField, cursorType, incrementalQuery, options }));

    io.stdout.write("Testando leitura inicial...\n");
    const rows = await adapter.queryChanges({
      sql: incrementalQuery,
      cursor: initialCursorValue(cursorType),
      limit: options.batchSize
    });
    io.stdout.write(`Leitura inicial OK. ${rows.length} registro(s) retornado(s).\n`);

    const connectorToken = await promptConnectorToken(prompt, env, options.connectorToken);
    const websocketUrl = await promptWebsocketUrl(prompt, env, options.websocketUrl);
    const envValues = {
      CONNECTOR_TOKEN: connectorToken,
      CONNECTOR_WS_URL: websocketUrl,
      DB_DRIVER: config.driver,
      DB_HOST: config.host,
      DB_PORT: config.port,
      DB_NAME: config.name,
      DB_USER: config.user,
      DB_PASSWORD: config.password,
      LOG_LEVEL: options.logLevel
    };
    loadConfig({
      ...env,
      CONNECTOR_TOKEN: connectorToken,
      CONNECTOR_WS_URL: websocketUrl,
      DB_DRIVER: config.driver,
      DB_HOST: config.host,
      DB_PORT: String(config.port),
      DB_NAME: config.name,
      DB_USER: config.user,
      DB_PASSWORD: config.password,
      LOG_LEVEL: options.logLevel
    });

    const envResult = await persistEnv({
      envFilePath: options.envFilePath,
      values: envValues,
      now: now()
    });
    const stateArtifact = await persistState({
      artifactFilePath: options.artifactFilePath,
      driver: config.driver,
      databaseName: config.name,
      selectedProductTable: selectedTable,
      cursorField,
      cursorType,
      incrementalQuery,
      batchSize: options.batchSize,
      fields: mapping,
      createdAt: now()
    });

    printSuccessSummary({
      io,
      envFilePath: envResult.envFilePath,
      backupFilePath: envResult.backupFilePath,
      artifactFilePath: options.artifactFilePath,
      config,
      selectedTable,
      stateArtifact
    });

    return {
      mode: connectionSource.mode,
      candidate: connectionSource.candidate,
      config,
      selectedTable,
      cursorField,
      cursorType,
      incrementalQuery,
      batchSize: options.batchSize,
      mapping
    };
  } finally {
    await adapter.close().catch(() => undefined);
  }
}

export function formatCandidateSelectionTable(candidates: readonly DatabaseFileCandidate[]): string {
  return `${buildDatabaseSetupCandidateViews(candidates).map(formatDatabaseSetupCandidateView).join("\n")}\n`;
}

export function rankDatabaseTables(tables: readonly DatabaseTable[]): DatabaseTable[] {
  return [...tables].sort((left, right) => compareSuggestion(left.name, right.name, TABLE_HINTS));
}

export function rankDatabaseColumns(
  columns: readonly DatabaseColumn[],
  field: FieldRecommendation["key"]
): DatabaseColumn[] {
  return [...columns].sort((left, right) => compareSuggestion(left.name, right.name, FIELD_HINTS[field]));
}

export function buildIncrementalReadTestQuery(
  driver: DatabaseDriver,
  tableName: string,
  cursorField: string
): string {
  const quotedTable = quoteIdentifier(driver, tableName);
  const quotedCursor = quoteIdentifier(driver, cursorField);
  if (driver === "postgresql") {
    return `select * from ${quotedTable} where ${quotedCursor} > $1 order by ${quotedCursor} limit $2`;
  }
  const limitClause = driver === "mysql" ? "limit ?" : "rows ?";
  return `select * from ${quotedTable} where ${quotedCursor} > ? order by ${quotedCursor} ${limitClause}`;
}

export function buildSnapshotReadTestQuery(
  driver: DatabaseDriver,
  tableName: string,
  stableOrderField: string
): string {
  const quotedTable = quoteIdentifier(driver, tableName);
  const quotedOrder = quoteIdentifier(driver, stableOrderField);
  if (driver === "postgresql") {
    return `select * from ${quotedTable} order by ${quotedOrder} limit $1 offset $2`;
  }
  return driver === "mysql"
    ? `select * from ${quotedTable} order by ${quotedOrder} limit ? offset ?`
    : `select * from ${quotedTable} order by ${quotedOrder} rows ? to ?`;
}

export function discoveryConnectionSource(candidate: DatabaseSetupCandidateView): DatabaseSetupConnectionSource {
  return {
    mode: "discovery",
    driver: candidate.type as DatabaseDriver,
    candidate
  };
}

export function manualConnectionSource(driver: DatabaseDriver): DatabaseSetupConnectionSource {
  return {
    mode: "manual",
    driver
  };
}

export interface ConnectionDefaults {
  host: string;
  port: number;
  databaseName: string;
  user: string;
  password: string;
}

export function connectionDefaults(source: DatabaseSetupConnectionSource, env?: Environment): ConnectionDefaults {
  const base = driverConnectionDefaults(source);
  if (!env || env.DB_DRIVER?.trim() !== source.driver) {
    return base;
  }

  const host = normalizeOptionalEnvValue(env.DB_HOST);
  const port = parseOptionalEnvPort(env.DB_PORT);
  const databaseName = normalizeOptionalEnvValue(env.DB_NAME);
  const user = env.DB_USER !== undefined ? env.DB_USER.trim() : undefined;
  const password = env.DB_PASSWORD !== undefined ? env.DB_PASSWORD : undefined;

  return {
    host: host ?? base.host,
    port: port ?? base.port,
    databaseName: databaseName ?? base.databaseName,
    user: user ?? base.user,
    password: password ?? base.password
  };
}

function driverConnectionDefaults(source: DatabaseSetupConnectionSource): ConnectionDefaults {
  if (source.mode === "discovery" && source.candidate) {
    if (source.candidate.type === "firebird") {
      return {
        host: "127.0.0.1",
        port: 3050,
        databaseName: source.candidate.path,
        user: "SYSDBA",
        password: "masterkey"
      };
    }

    return {
      host: "127.0.0.1",
      port: 3306,
      databaseName: deriveMySqlDatabaseName(source.candidate.path),
      user: "",
      password: ""
    };
  }

  if (source.driver === "firebird") {
    return {
      host: "127.0.0.1",
      port: 3050,
      databaseName: "",
      user: "SYSDBA",
      password: "masterkey"
    };
  }

  return {
    host: "127.0.0.1",
    port: 3306,
    databaseName: "",
    user: "",
    password: ""
  };
}

function normalizeOptionalEnvValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function parseOptionalEnvPort(value: string | undefined): number | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  const port = Number(normalized);
  if (!Number.isInteger(port) || port <= 0) {
    return undefined;
  }
  return port;
}

function buildValidatedMappingInput(input: {
  mapping: OnboardingFieldMapping;
  selectedTable: string;
  cursorField: string;
  cursorType: CursorType;
  incrementalQuery: string;
  options: Pick<DatabaseSetupCliOptions, "batchSize" | "pollIntervalMs">;
}): MappingConfig {
  return {
    mappingVersion: LOCAL_ONBOARDING_MAPPING_VERSION,
    selectedProductTable: input.selectedTable,
    pollIntervalMs: input.options.pollIntervalMs,
    batchSize: input.options.batchSize,
    incrementalQuery: input.incrementalQuery,
    cursorField: input.cursorField,
    cursorType: input.cursorType,
    fields: input.mapping
  };
}

async function selectCandidate(
  candidates: readonly DatabaseFileCandidate[],
  prompt: DatabaseSetupPrompt,
  io: Pick<DatabaseSetupCliIo, "stdout">
): Promise<DatabaseSetupCandidateView> {
  const views = buildDatabaseSetupCandidateViews(candidates);
  if (views.length === 0) {
    throw new Error("Nenhum banco de dados local foi encontrado.");
  }

  io.stdout.write(`${views.map(formatDatabaseSetupCandidateView).join("\n")}\n`);

  const choices = views.map((candidate) => ({
    value: String(candidate.index),
    label: formatDatabaseSetupCandidateView(candidate)
  }));

  while (true) {
    const selection = await prompt.select({
      message: "Selecione o banco de dados",
      choices
    });
    const candidate = views.find((entry) => String(entry.index) === selection);
    if (!candidate) {
      continue;
    }
    if (!candidate.supported) {
      io.stdout.write(`${candidate.warning ?? "Banco de dados nao suportado."}\n`);
      continue;
    }
    return candidate;
  }
}

export async function promptForConnectionConfig(input: {
  source: DatabaseSetupConnectionSource;
  options: DatabaseSetupCliOptions;
  prompt: DatabaseSetupPrompt;
  env: Environment;
  io: Pick<DatabaseSetupCliIo, "stdout">;
}): Promise<DatabaseConfig> {
  const defaults = connectionDefaults(input.source, input.env);
  const host = await input.prompt.text({
    message: "Host do banco",
    defaultValue: defaults.host
  });
  const portValue = await input.prompt.text({
    message: "Porta do banco",
    defaultValue: String(defaults.port)
  });
  const port = parsePositiveInteger(portValue, "DB_PORT");

  const name = await input.prompt.text({
    message: input.source.driver === "mysql" ? "Schema/database do MySQL" : "Arquivo/caminho do Firebird",
    defaultValue: defaults.databaseName
  });
  if (name.trim().length === 0) {
    throw new Error(
      input.source.driver === "mysql"
        ? "MySQL setup requires a database/schema name before connection."
        : "Firebird database path is required."
    );
  }

  const user = await input.prompt.text({
    message: "Usuario do banco",
    defaultValue: defaults.user
  });
  const password = await input.prompt.text({
    message: "Senha do banco",
    defaultValue: defaults.password,
    secret: true
  });

  input.io.stdout.write("Testando conexao...\n");
  return {
    driver: input.source.driver,
    host: host.trim(),
    port,
    name: name.trim(),
    user: user.trim(),
    password
  };
}

export async function connectWithRetry(input: {
  adapter: SourceDatabaseAdapter;
  config: DatabaseConfig;
  options: DatabaseSetupCliOptions;
  source: DatabaseSetupConnectionSource;
  prompt: DatabaseSetupPrompt;
  env: Environment;
  io: DatabaseSetupCliIo;
}): Promise<{ adapter: SourceDatabaseAdapter; config: DatabaseConfig }> {
  let adapter = input.adapter;
  let config = input.config;

  while (true) {
    try {
      await adapter.connect();
      return { adapter, config };
    } catch (error) {
      const message = redactError(error, configSecrets({
        connectorToken: input.options.connectorToken ?? input.env.CONNECTOR_TOKEN ?? "",
        database: config
      }));
      input.io.stderr.write(`${message}\n`);
      const retry = await input.prompt.confirm({
        message: "Falha ao conectar. Deseja tentar novamente?",
        defaultValue: true
      });
      if (!retry) {
        throw new Error(message);
      }

      await adapter.close().catch(() => undefined);
      config = await promptForConnectionConfig({
        source: input.source,
        options: input.options,
        prompt: input.prompt,
        env: input.env,
        io: input.io
      });
      adapter = createAdapter({ config, io: input.io });
    }
  }
}

async function selectTable(tables: readonly DatabaseTable[], prompt: DatabaseSetupPrompt): Promise<string> {
  if (tables.length === 0) {
    throw new Error("Nenhuma tabela de produto foi encontrada no banco selecionado.");
  }

  const ranked = rankDatabaseTables(tables);
  return await promptForChoice(prompt, {
    message: "Selecione a tabela de produtos",
    choices: ranked.map((table) => ({
      value: table.name,
      label: table.name
    })),
    defaultValue: ranked[0]?.name
  });
}

async function selectCursorField(columns: readonly DatabaseColumn[], prompt: DatabaseSetupPrompt): Promise<string> {
  if (columns.length === 0) {
    throw new Error("Nenhuma coluna foi encontrada na tabela selecionada.");
  }

  const ranked = rankDatabaseColumns(columns, "sourceUpdatedAt");
  return await promptForChoice(prompt, {
    message: "Selecione o campo de cursor incremental",
    choices: ranked.map((column) => ({
      value: column.name,
      label: formatColumnChoice(column)
    })),
    defaultValue: ranked[0]?.name
  });
}

async function resolveCursorType(
  cursorField: string,
  columns: readonly DatabaseColumn[],
  prompt: DatabaseSetupPrompt
): Promise<CursorType> {
  const column = columns.find((entry) => entry.name === cursorField);
  const inferred = inferCursorType(column);
  if (inferred) {
    return inferred;
  }

  const selected = await promptForChoice(prompt, {
    message: "Selecione o tipo do cursor",
    choices: [
      { value: "timestamp", label: "timestamp" },
      { value: "number", label: "number" }
    ],
    defaultValue: "timestamp"
  });
  return selected as CursorType;
}

async function selectFieldMappings(
  columns: readonly DatabaseColumn[],
  cursorField: string,
  prompt: DatabaseSetupPrompt
): Promise<OnboardingFieldMapping> {
  const mapping: Partial<OnboardingFieldMapping> = {};

  for (const field of FIELD_RECOMMENDATIONS) {
    const ranked = rankDatabaseColumns(columns, field.key);
    const choices: DatabaseSetupPromptSelectChoice[] = ranked.map((column) => ({
      value: column.name,
      label: formatColumnChoice(column)
    }));

    if (!field.required) {
      choices.unshift({ value: "", label: "pular" });
    }

    const defaultChoice =
      field.key === "sourceUpdatedAt" && columns.some((column) => column.name === cursorField)
        ? cursorField
        : ranked[0]?.name;

    const selected = await promptForChoice(prompt, {
      message: `Selecione a coluna para ${field.label}`,
      choices,
      defaultValue: field.required ? defaultChoice : defaultChoice ?? ""
    });

    if (!field.required && selected.length === 0) {
      continue;
    }

    mapping[field.key] = selected;
  }

  return mapping as OnboardingFieldMapping;
}

export function deriveMySqlDatabaseName(candidatePath: string): string {
  const normalized = candidatePath.split(/[\\/]/u).filter((segment) => segment.length > 0);
  for (let index = normalized.length - 2; index >= 0; index -= 1) {
    const segment = normalized[index]?.trim();
    if (!segment) {
      continue;
    }
    if (!["mysql", "data", "var", "lib"].includes(segment.toLowerCase())) {
      return segment;
    }
  }
  return "";
}

async function promptForChoice(
  prompt: DatabaseSetupPrompt,
  input: {
    message: string;
    choices: readonly DatabaseSetupPromptSelectChoice[];
    defaultValue?: string;
  }
): Promise<string> {
  if (input.choices.length === 0) {
    throw new Error(`Nenhuma opcao disponivel para: ${input.message}`);
  }

  while (true) {
    const selected = await prompt.select(input);
    if (input.choices.some((choice) => choice.value === selected)) {
      return selected;
    }
  }
}

function inferCursorType(column: DatabaseColumn | undefined): CursorType | undefined {
  const type = column?.dataType?.toLowerCase();
  if (!type) {
    return undefined;
  }
  if (["timestamp", "datetime", "date", "time"].some((token) => type.includes(token))) {
    return "timestamp";
  }
  if (["int", "dec", "num", "float", "double"].some((token) => type.includes(token))) {
    return "number";
  }
  return undefined;
}

function formatColumnChoice(column: DatabaseColumn): string {
  const parts = [column.name];
  if (column.dataType) {
    parts.push(column.dataType);
  }
  if (column.nullable !== undefined) {
    parts.push(column.nullable ? "nullable" : "required");
  }
  return parts.join(" [").replace(/\s\[/u, " [") + (parts.length > 1 ? "]".repeat(parts.length - 1) : "");
}

function compareSuggestion(left: string, right: string, hints: readonly string[]): number {
  const leftScore = suggestionScore(left, hints);
  const rightScore = suggestionScore(right, hints);
  if (leftScore !== rightScore) {
    return rightScore - leftScore;
  }
  return left.localeCompare(right);
}

function suggestionScore(value: string, hints: readonly string[]): number {
  const normalized = normalizeKey(value);
  let score = 0;

  for (const [index, hint] of hints.entries()) {
    const normalizedHint = normalizeKey(hint);
    const priorityBoost = Math.max(hints.length - index, 1);
    if (normalized === normalizedHint) {
      score += 100 * priorityBoost;
      continue;
    }
    if (normalized.startsWith(normalizedHint)) {
      score += 70 * priorityBoost;
      continue;
    }
    if (normalized.includes(normalizedHint)) {
      score += 40 * priorityBoost;
    }
  }

  return score;
}

function normalizeKey(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase();
}

function initialCursorValue(type: CursorType): number | string {
  return type === "number" ? 0 : "1970-01-01T00:00:00.000Z";
}

function quoteIdentifier(driver: DatabaseDriver, value: string): string {
  if (driver === "mysql") {
    return `\`${value.replace(/`/gu, "``")}\``;
  }
  return `"${value.replace(/"/gu, '""')}"`;
}

function createAdapter(input: {
  config: DatabaseConfig;
  io: DatabaseSetupCliIo;
}): SourceDatabaseAdapter {
  return (input.io.createAdapter ?? defaultCreateAdapter)({
    config: input.config,
    secrets: [input.config.password]
  });
}

function defaultCreateAdapter(input: CreateDatabaseSetupAdapterInput): SourceDatabaseAdapter {
  return createSourceDatabaseAdapter({
    config: input.config,
    dependencies: createOptionalDriverDependencies(),
    secrets: input.secrets
  });
}

function createOptionalDriverDependencies(): AdapterFactoryDependencies {
  return {
    mysqlConnectionFactory: async (config) => {
      const mysql = await import("mysql2/promise");
      const connection = await mysql.createConnection({
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: config.password
      });
      return {
        query: (sql, params) => connection.query(sql, [...params]),
        end: () => connection.end()
      };
    },
    firebirdConnectionFactory: async (config) => {
      const firebird = await importUnknownModule("node-firebird");
      return await attachFirebirdConnection(
        firebird as {
          attach: (
            options: Record<string, unknown>,
            callback: (error: Error | undefined, db: { query: Function; detach: Function }) => void
          ) => void;
        },
        config
      );
    }
  };
}

async function promptConnectorToken(
  prompt: DatabaseSetupPrompt,
  env: Environment,
  explicitValue: string | undefined
): Promise<string> {
  const existing = normalizeOptional(explicitValue) ?? normalizeOptional(env.CONNECTOR_TOKEN);
  if (existing) {
    return existing;
  }

  const token = await prompt.text({
    message: "Token do conector",
    secret: true
  });
  if (token.trim().length === 0) {
    throw new Error("CONNECTOR_TOKEN is required.");
  }
  return token;
}

async function promptWebsocketUrl(
  prompt: DatabaseSetupPrompt,
  env: Environment,
  explicitValue: string | undefined
): Promise<string> {
  const existing = normalizeOptional(explicitValue) ?? normalizeOptional(env.CONNECTOR_WS_URL);
  if (existing) {
    return existing;
  }

  const url = await prompt.text({
    message: "WebSocket URL da central"
  });
  if (url.trim().length === 0) {
    throw new Error("CONNECTOR_WS_URL is required.");
  }
  return url;
}

function printSuccessSummary(input: {
  io: Pick<DatabaseSetupCliIo, "stdout">;
  envFilePath: string;
  backupFilePath?: string;
  artifactFilePath: string;
  config: DatabaseConfig;
  selectedTable: string;
  stateArtifact: OnboardingMappingArtifact;
}): void {
  input.io.stdout.write("Configuracao salva.\n");
  input.io.stdout.write(`Driver: ${input.config.driver}\n`);
  input.io.stdout.write(`Host: ${input.config.host}\n`);
  input.io.stdout.write(`Port: ${input.config.port}\n`);
  input.io.stdout.write(`Database: ${input.config.name}\n`);
  input.io.stdout.write(`Table: ${input.selectedTable}\n`);
  input.io.stdout.write(`Env file: ${input.envFilePath}\n`);
  if (input.backupFilePath) {
    input.io.stdout.write(`Env backup: ${input.backupFilePath}\n`);
  }
  input.io.stdout.write(`Onboarding JSON: ${input.artifactFilePath}\n`);
  input.io.stdout.write("Next steps:\n");
  input.io.stdout.write("CONNECTOR_VALIDATE_ONLY=1 node --import tsx src/main.ts\n");
  input.io.stdout.write("npm start\n");
  input.io.stdout.write(
    `Cursor: ${input.stateArtifact.cursorField} (${input.stateArtifact.cursorType}), batch size ${input.stateArtifact.batchSize}\n`
  );
}

function createReadlinePrompt(io: DatabaseSetupCliIo): DatabaseSetupPrompt {
  const input = io.stdin ?? process.stdin;
  const output = io.stdout as NodeJS.WriteStream;
  const rl = createInterface({
    input,
    output,
    terminal: Boolean(input.isTTY)
  });

  return {
    text: async ({ message, defaultValue, secret }) => {
      if (secret) {
        return readSecretInput({ rl, input, output, message, defaultValue });
      }
      input.resume();
      const answer = await rl.question(withDefault(message, defaultValue));
      return answer.length > 0 ? answer : defaultValue ?? "";
    },
    select: async ({ message, choices, defaultValue }) => {
      while (true) {
        input.resume();
        const labels = choices.map((choice, index) => `- ${index + 1}: ${choice.label}`).join("\n");
        const answer = (await rl.question(`${message}\n${labels}\n> `)).trim();
        if (answer.length === 0) {
          return defaultValue ?? choices[0]?.value ?? "";
        }

        const selectedIndex = Number.parseInt(answer, 10);
        if (Number.isInteger(selectedIndex) && selectedIndex >= 1 && selectedIndex <= choices.length) {
          return choices[selectedIndex - 1]?.value ?? "";
        }

        output.write("Selecione um numero valido.\n");
      }
    },
    confirm: async ({ message, defaultValue }) => {
      const suffix = defaultValue === undefined ? "[y/n]" : defaultValue ? "[Y/n]" : "[y/N]";
      input.resume();
      const answer = (await rl.question(`${message} ${suffix} `)).trim().toLowerCase();
      if (answer.length === 0 && defaultValue !== undefined) {
        return defaultValue;
      }
      return ["y", "yes", "s", "sim"].includes(answer);
    }
  };
}

async function readSecretInput(input: {
  rl: Interface;
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  message: string;
  defaultValue?: string;
}): Promise<string> {
  if (!input.input.isTTY || typeof input.input.setRawMode !== "function") {
    const fallback = await input.rl.question(withDefault(input.message, input.defaultValue));
    return fallback.length > 0 ? fallback : input.defaultValue ?? "";
  }

  input.output.write(withDefault(input.message, input.defaultValue));
  input.input.setRawMode(true);
  input.input.resume();
  let value = "";

  return await new Promise<string>((resolve) => {
    const onData = (chunk: string | Buffer) => {
      const text = chunk.toString("utf8");
      for (const character of text) {
        if (character === "\r" || character === "\n") {
          cleanup();
          input.output.write("\n");
          resolve(value.length > 0 ? value : input.defaultValue ?? "");
          return;
        }
        if (character === "\u0003") {
          cleanup();
          throw new Error("Input cancelled.");
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };

    const cleanup = () => {
      input.input.off("data", onData);
      input.input.setRawMode(false);
    };

    input.input.on("data", onData);
  });
}

function requiredValue(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value\n${usage()}`);
  }
  return value;
}

function parsePositiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return parsed;
}

function parseLogLevel(value: string): LogLevel {
  if (!["debug", "info", "warn", "error"].includes(value)) {
    throw new Error("--log-level must be debug, info, warn, or error");
  }
  return value as LogLevel;
}

function usage(): string {
  return [
    "Usage: database-setup [--root <path>] [--env-file <path>] [--artifact-file <path>]",
    "  [--connector-token <token>] [--ws-url <url>] [--log-level <level>]",
    "  [--batch-size <n>] [--poll-interval-ms <ms>]"
  ].join("\n");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactError(error: unknown, secrets: readonly string[]): string {
  const message = error instanceof DatabaseOperationError ? error.message : formatError(error);
  return redactString(message, secrets);
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

async function importUnknownModule(specifier: string): Promise<unknown> {
  return await new Function("value", "return import(value);")(specifier) as Promise<unknown>;
}

function withDefault(message: string, defaultValue?: string): string {
  return defaultValue === undefined ? `${message}: ` : `${message} [${defaultValue}]: `;
}

function defaultIo(): DatabaseSetupCliIo {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const exitCode = await runDatabaseSetupCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
