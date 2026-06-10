import type { AdminRouterDependencies } from "../discovery/admin-router.js";
import type { SourceDatabaseAdapter } from "../db/source-adapter.js";
import type { FileSystemReader } from "../discovery/fs-reader.js";
import type { RegistryReader } from "../db/registry-reader.js";
import { readConfigFile } from "../discovery/read-config-file.js";
import { readRegistryKey } from "../discovery/read-registry-key.js";
import { fsListDir, fsReadFile, fsStat, nodeFsPrimitivesOps } from "../discovery/fs-primitives.js";
import type { AiSessionDeps } from "../ai-session/ai-session.js";
import type { AdminResponseMessage, AdminRequestMessage } from "../transport/protocol.js";
import type { DatabaseConfig } from "../config/types.js";
import type { ValidatedMappingConfig } from "../mapping/types.js";
import type { Logger } from "../logging/logger.js";

type ProbeDeps = Pick<
  AdminRouterDependencies,
  "probeEngines" | "probeOdbcDsns" | "probeNetwork" | "probeTestConnection" |
  "probeProcesses" | "probeConnections" | "probeScanConfigDirs" | "schemaListTables"
>;

export interface RuntimeAdminDepsInput {
  getAdapter: () => Promise<SourceDatabaseAdapter>;
  fs: FileSystemReader;
  registry: RegistryReader;
  probeDeps: ProbeDeps;
}

export function buildRuntimeAdminDeps(input: RuntimeAdminDepsInput): AdminRouterDependencies {
  return {
    ...input.probeDeps,
    // schema.listTables PRECISA usar o adapter real — o spread de probeDeps traz
    // um stub `() => []` que, sem este override, faria listTables retornar vazio
    // em QUALQUER banco. Mapeia DatabaseTable[] -> string[] (contrato da dep).
    schemaListTables: async () => {
      const tables = await (await input.getAdapter()).listTables();
      return tables.map((table) => table.name);
    },
    schemaDescribeTable: async (table) => (await input.getAdapter()).describeTable(table),
    schemaListForeignKeys: async (table) => (await input.getAdapter()).listForeignKeys(table),
    schemaSampleRows: async (table, limit) => (await input.getAdapter()).sampleRows(table, limit),
    sqlRunReadOnlySelect: async (sel) => (await input.getAdapter()).runReadOnlySelect(sel),
    fsReadConfigFile: async (file) => readConfigFile({ fs: input.fs }, file),
    fsListDir: async (dir) => fsListDir(dir, nodeFsPrimitivesOps),
    fsReadFile: async (file) => fsReadFile(file, nodeFsPrimitivesOps),
    fsStat: async (file) => fsStat(file, nodeFsPrimitivesOps),
    registryReadKey: async (key) => readRegistryKey(input.registry, key)
  };
}

export interface AiSessionDepsInput {
  handleAdminRequest: (req: AdminRequestMessage) => Promise<AdminResponseMessage>;
  secrets: () => readonly string[];
  now: () => string;
  writeDatabaseConfig: (programData: string | undefined, database: DatabaseConfig) => Promise<void>;
  programData: string | undefined;
  currentDatabase: () => DatabaseConfig | undefined;
  activateMapping: (mapping: ValidatedMappingConfig) => Promise<void>;
  currentEngine: () => string;
  /** Abre (read-only) a conexão a partir dos params completos e a torna a ativa das tools de schema. */
  connectDatabase?: (config: DatabaseConfig) => Promise<{ ok: boolean; tablesCount?: number; errorCode?: string }>;
  /** Logger para observabilidade no STDOUT do agente (eventos do ciclo da sessão). */
  logger?: Logger;
}

export function buildAiSessionDeps(input: AiSessionDepsInput): AiSessionDeps {
  return {
    handleAdminRequest: (req) => input.handleAdminRequest(req as AdminRequestMessage),
    secrets: input.secrets,
    now: input.now,
    currentEngine: input.currentEngine,
    ...(input.connectDatabase ? { connectDatabase: input.connectDatabase } : {}),
    ...(input.logger ? { logger: input.logger } : {}),
    applyApproval: async (mapping) => {
      const database = input.currentDatabase();
      if (database) {
        await input.writeDatabaseConfig(input.programData, database);
      }
      await input.activateMapping(mapping);
    }
  };
}
