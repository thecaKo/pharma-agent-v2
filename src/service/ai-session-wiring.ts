import type { AdminRouterDependencies } from "../discovery/admin-router.js";
import type { SourceDatabaseAdapter } from "../db/source-adapter.js";
import type { FileSystemReader } from "../discovery/fs-reader.js";
import type { RegistryReader } from "../db/registry-reader.js";
import { readConfigFile } from "../discovery/read-config-file.js";
import { readRegistryKey } from "../discovery/read-registry-key.js";
import type { AiSessionDeps } from "../ai-session/ai-session.js";
import type { AdminResponseMessage, AdminRequestMessage } from "../transport/protocol.js";
import type { DatabaseConfig } from "../config/types.js";
import type { ValidatedMappingConfig } from "../mapping/types.js";

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
    schemaDescribeTable: async (table) => (await input.getAdapter()).describeTable(table),
    schemaListForeignKeys: async (table) => (await input.getAdapter()).listForeignKeys(table),
    schemaSampleRows: async (table, limit) => (await input.getAdapter()).sampleRows(table, limit),
    sqlRunReadOnlySelect: async (sel) => (await input.getAdapter()).runReadOnlySelect(sel),
    fsReadConfigFile: async (file) => readConfigFile({ fs: input.fs }, file),
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
}

export function buildAiSessionDeps(input: AiSessionDepsInput): AiSessionDeps {
  return {
    handleAdminRequest: (req) => input.handleAdminRequest(req as AdminRequestMessage),
    secrets: input.secrets,
    now: input.now,
    applyApproval: async (mapping) => {
      const database = input.currentDatabase();
      if (database) {
        await input.writeDatabaseConfig(input.programData, database);
      }
      await input.activateMapping(mapping);
    }
  };
}
