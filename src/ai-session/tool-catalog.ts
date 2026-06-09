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
  { name: "fs.listDir", command: "fs.listDir", description: "Lista entradas de um diretório (qualquer caminho, read-only). Devolve name/type/size.", inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } }, outputSchema: { type: "object", properties: { entries: ARRAY } } },
  { name: "fs.readFile", command: "fs.readFile", description: "Lê o conteúdo de um arquivo (qualquer caminho, read-only). Cap de bytes; pula binário; rejeita caminho crítico de SO.", inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" }, maxBytes: { type: "integer" } } }, outputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, truncated: { type: "boolean" } } } },
  { name: "fs.stat", command: "fs.stat", description: "Verifica existência/tipo/tamanho de um caminho (read-only).", inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } }, outputSchema: { type: "object", properties: { exists: { type: "boolean" }, type: { type: "string" }, size: { type: "integer" }, mtime: { type: "string" } } } },
  { name: "registry.readKey", command: "registry.readKey", description: "Lê uma chave do registro Windows (somente leitura).", inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } }, outputSchema: OBJECT },
  { name: "probe.test_connection", command: "probe.test_connection", description: "Testa uma credencial candidata sem persistir.", inputSchema: { type: "object", required: ["driver"], properties: { driver: { type: "string" } } }, outputSchema: OBJECT },
  { name: "schema.listTables", command: "schema.listTables", description: "Lista as tabelas do banco conectado.", inputSchema: OBJECT, outputSchema: { type: "object", properties: { tables: ARRAY } } },
  { name: "schema.describeTable", command: "schema.describeTable", description: "Colunas e tipos de uma tabela.", inputSchema: { type: "object", required: ["table"], properties: { table: { type: "string" } } }, outputSchema: { type: "object", properties: { columns: ARRAY } } },
  { name: "schema.listForeignKeys", command: "schema.listForeignKeys", description: "Foreign keys (liga produtos a tabelas auxiliares).", inputSchema: { type: "object", properties: { table: { type: "string" } } }, outputSchema: { type: "object", properties: { foreignKeys: ARRAY } } },
  { name: "schema.sampleRows", command: "schema.sampleRows", description: "Amostra de N linhas de uma tabela (LIMIT pequeno).", inputSchema: { type: "object", required: ["table"], properties: { table: { type: "string" }, limit: { type: "integer" } } }, outputSchema: { type: "object", properties: { rows: ARRAY } } },
  { name: "sql.runReadOnlySelect", command: "sql.runReadOnlySelect", description: "Executa um SELECT validado (rejeita escrita, LIMIT forçado).", inputSchema: { type: "object", required: ["sql"], properties: { sql: { type: "string" }, limit: { type: "integer" } } }, outputSchema: { type: "object", properties: { rows: ARRAY } } }
];

export const PROPOSE_READONLY_USER_TOOL = "propose_readonly_user";
export const DB_CONNECT_TOOL = "db.connect";

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
    name: DB_CONNECT_TOOL,
    description:
      "Abre uma conexão READ-ONLY com os parâmetros completos descobertos (driver/host/port/user/password/database) e a torna a conexão ativa das tools de schema. Confirma com listTables.",
    inputSchema: {
      type: "object",
      required: ["driver", "host", "user", "password", "database"],
      properties: {
        driver: { type: "string" },
        host: { type: "string" },
        port: { type: "integer" },
        user: { type: "string" },
        password: { type: "string" },
        database: { type: "string" }
      }
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
