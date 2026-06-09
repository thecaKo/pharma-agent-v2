import type { AdminCommand } from "../transport/protocol.js";
import type { ToolDescriptor } from "./ai-protocol.js";

export const CATALOG_VERSION = "1";

interface ToolSpec {
  name: string;
  command: AdminCommand;
  description: string;
  inputSchema: object;
  outputSchema: object;
}

const OBJECT = { type: "object" } as const;
const ARRAY = { type: "array" } as const;

const SPECS: ToolSpec[] = [
  { name: "probe.engines", command: "probe.engines", description: "Lista engines de banco instalados na máquina.", inputSchema: OBJECT, outputSchema: { type: "object", properties: { engines: ARRAY } } },
  { name: "probe.odbc_dsns", command: "probe.odbc_dsns", description: "Lista DSNs ODBC configurados.", inputSchema: OBJECT, outputSchema: { type: "object", properties: { dsns: ARRAY } } },
  { name: "probe.processes", command: "probe.processes", description: "Lista processos em execução (pid/nome/caminho).", inputSchema: OBJECT, outputSchema: { type: "object", properties: { processes: ARRAY } } },
  { name: "probe.connections", command: "probe.connections", description: "Lista conexões TCP em portas de banco conhecidas.", inputSchema: OBJECT, outputSchema: { type: "object", properties: { connections: ARRAY } } },
  { name: "probe.network", command: "probe.network", description: "Testa alcançabilidade de host:porta.", inputSchema: { type: "object", required: ["host", "port"], properties: { host: { type: "string" }, port: { type: "integer" }, timeoutMs: { type: "integer" } } }, outputSchema: OBJECT },
  { name: "probe.scan_config_dirs", command: "probe.scan_config_dirs", description: "Varre diretórios por arquivos de config (deny-list + limites).", inputSchema: { type: "object", required: ["roots"], properties: { roots: ARRAY } }, outputSchema: OBJECT },
  { name: "fs.readConfigFile", command: "fs.readConfigFile", description: "Lê um arquivo de config sob deny-list; conteúdo cru só local.", inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } }, outputSchema: OBJECT },
  { name: "registry.readKey", command: "registry.readKey", description: "Lê uma chave do registro Windows (somente leitura).", inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } }, outputSchema: OBJECT },
  { name: "probe.test_connection", command: "probe.test_connection", description: "Testa uma credencial candidata sem persistir.", inputSchema: { type: "object", required: ["driver"], properties: { driver: { type: "string" } } }, outputSchema: OBJECT },
  { name: "schema.listTables", command: "schema.listTables", description: "Lista as tabelas do banco conectado.", inputSchema: OBJECT, outputSchema: { type: "object", properties: { tables: ARRAY } } },
  { name: "schema.describeTable", command: "schema.describeTable", description: "Colunas e tipos de uma tabela.", inputSchema: { type: "object", required: ["table"], properties: { table: { type: "string" } } }, outputSchema: { type: "object", properties: { columns: ARRAY } } },
  { name: "schema.listForeignKeys", command: "schema.listForeignKeys", description: "Foreign keys (liga produtos a tabelas auxiliares).", inputSchema: { type: "object", properties: { table: { type: "string" } } }, outputSchema: { type: "object", properties: { foreignKeys: ARRAY } } },
  { name: "schema.sampleRows", command: "schema.sampleRows", description: "Amostra de N linhas de uma tabela (LIMIT pequeno).", inputSchema: { type: "object", required: ["table"], properties: { table: { type: "string" }, limit: { type: "integer" } } }, outputSchema: { type: "object", properties: { rows: ARRAY } } },
  { name: "sql.runReadOnlySelect", command: "sql.runReadOnlySelect", description: "Executa um SELECT validado (rejeita escrita, LIMIT forçado).", inputSchema: { type: "object", required: ["sql"], properties: { sql: { type: "string" }, limit: { type: "integer" } } }, outputSchema: { type: "object", properties: { rows: ARRAY } } }
];

export const PROPOSE_READONLY_USER_TOOL = "propose_readonly_user";
export const CONNECTION_DISCOVER_TOOL = "connection.discoverCandidates";
export const CONNECTION_USE_TOOL = "connection.use";

const CANDIDATE_DESCRIPTOR_SCHEMA = {
  type: "object",
  properties: {
    handle: { type: "string" },
    driver: { type: "string" },
    host: { type: "string" },
    port: { type: "integer" },
    user: { type: "string" },
    database: { type: "string" },
    source: { type: "string" },
    label: { type: "string" }
  }
} as const;

const SIGNAL_DESCRIPTORS: ToolDescriptor[] = [
  {
    name: PROPOSE_READONLY_USER_TOOL,
    description:
      "Sinaliza ao operador a criação de um usuário somente-leitura dedicado. Não toca no banco; valida o nome e devolve o engine corrente.",
    inputSchema: {
      type: "object",
      required: ["username"],
      properties: { username: { type: "string" }, rationale: { type: "string" } }
    },
    outputSchema: {
      type: "object",
      properties: { accepted: { type: "boolean" }, username: { type: "string" }, engine: { type: "string" } }
    }
  },
  {
    name: CONNECTION_DISCOVER_TOOL,
    description:
      "Descobre conexões candidatas (arquivos de config + DSNs ODBC) na máquina e devolve descritores REDIGIDOS (sem senha) com um handle por conexão. A credencial completa fica local no agente.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: { candidates: { type: "array", items: CANDIDATE_DESCRIPTOR_SCHEMA } }
    }
  },
  {
    name: CONNECTION_USE_TOOL,
    description:
      "Estabelece (read-only) a conexão escolhida pelo handle e a torna a conexão ativa das tools de schema. Recebe SÓ o handle — a senha nunca trafega.",
    inputSchema: {
      type: "object",
      required: ["handle"],
      properties: { handle: { type: "string" } }
    },
    outputSchema: {
      type: "object",
      properties: { ok: { type: "boolean" }, tablesCount: { type: "integer" }, errorCode: { type: "string" } }
    }
  }
];

export const TOOL_NAMES: ReadonlySet<string> = new Set([
  ...SPECS.map((spec) => spec.name),
  ...SIGNAL_DESCRIPTORS.map((d) => d.name)
]);

const NAME_TO_COMMAND = new Map<string, AdminCommand>(SPECS.map((spec) => [spec.name, spec.command]));

export function toolNameToAdminCommand(name: string): AdminCommand | undefined {
  return NAME_TO_COMMAND.get(name);
}

export function buildToolCatalog(): ToolDescriptor[] {
  return [
    ...SPECS.map((spec) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      outputSchema: spec.outputSchema
    })),
    ...SIGNAL_DESCRIPTORS
  ];
}
