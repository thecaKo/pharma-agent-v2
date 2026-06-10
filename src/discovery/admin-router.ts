import {
  buildAdminErrorResponseMessage,
  buildAdminSuccessResponseMessage,
  type AdminRequestMessage,
  type AdminResponseMessage
} from "../transport/protocol.js";
import type { EngineCandidate } from "./engines.js";
import type { OdbcDsnCandidate } from "./odbc-dsns.js";
import type { ProbeNetworkInput, ProbeNetworkResult } from "./network.js";
import type { TestConnectionInput, TestConnectionResult } from "./test-connection.js";
import type { ProcessCandidate } from "./processes.js";
import type { ConnectionCandidate } from "./connections.js";
import type { ScanConfigDirsInput, ScanConfigDirsResult } from "./scan-config-dirs.js";
import { MAX_ROOTS } from "./scan-config-dirs.js";
import type { DatabaseColumn, ForeignKey } from "../db/source-adapter.js";
import type { SourceRow } from "../mapping/types.js";
import type { ReadConfigFileResult } from "./read-config-file.js";
import type { ReadRegistryKeyResult } from "./read-registry-key.js";
import type { FsListDirResult, FsReadFileResult, FsStatResult } from "./fs-primitives.js";

const PROBE_VERSION = "1";

export interface AdminRouterDependencies {
  probeEngines: () => Promise<EngineCandidate[]>;
  probeOdbcDsns: () => Promise<OdbcDsnCandidate[]>;
  probeNetwork: (input: ProbeNetworkInput) => Promise<ProbeNetworkResult>;
  probeTestConnection: (input: TestConnectionInput) => Promise<TestConnectionResult>;
  probeProcesses: () => Promise<ProcessCandidate[]>;
  probeConnections: () => Promise<ConnectionCandidate[]>;
  probeScanConfigDirs: (input: ScanConfigDirsInput) => Promise<ScanConfigDirsResult>;
  schemaListTables: () => Promise<string[]>;
  schemaDescribeTable: (table: string) => Promise<DatabaseColumn[]>;
  schemaListForeignKeys: (table?: string) => Promise<ForeignKey[]>;
  schemaSampleRows: (table: string, limit: number) => Promise<SourceRow[]>;
  sqlRunReadOnlySelect: (input: { sql: string; limit: number }) => Promise<SourceRow[]>;
  fsReadConfigFile: (input: { path: string }) => Promise<ReadConfigFileResult>;
  fsListDir: (input: { path: string }) => Promise<FsListDirResult>;
  fsReadFile: (input: { path: string; maxBytes?: number }) => Promise<FsReadFileResult>;
  fsStat: (input: { path: string }) => Promise<FsStatResult>;
  registryReadKey: (input: { path: string }) => Promise<ReadRegistryKeyResult>;
}

export async function handleAdminRequest(
  req: AdminRequestMessage,
  deps: AdminRouterDependencies
): Promise<AdminResponseMessage> {
  try {
    switch (req.command) {
      case "probe.engines": {
        const engines = await deps.probeEngines();
        return success(req, { engines });
      }
      case "probe.odbc_dsns": {
        const dsns = await deps.probeOdbcDsns();
        return success(req, { dsns });
      }
      case "probe.network": {
        const input = validateNetworkInput(req.input);
        if (!input.ok) return invalidInput(req, input.error);
        const result = await deps.probeNetwork(input.value);
        return success(req, result);
      }
      case "probe.test_connection": {
        const input = validateTestConnectionInput(req.input);
        if (!input.ok) return invalidInput(req, input.error);
        const result = await deps.probeTestConnection(input.value);
        return success(req, result);
      }
      case "probe.processes": {
        const processes = await deps.probeProcesses();
        return success(req, { processes });
      }
      case "probe.connections": {
        const connections = await deps.probeConnections();
        return success(req, { connections });
      }
      case "probe.scan_config_dirs": {
        const input = validateScanConfigDirsInput(req.input);
        if (!input.ok) return invalidInput(req, input.error);
        const result = await deps.probeScanConfigDirs(input.value);
        return success(req, result);
      }
      case "schema.listTables": {
        const tables = await deps.schemaListTables();
        return success(req, { tables });
      }
      case "schema.describeTable": {
        const table = validateTableInput(req.input);
        if (!table.ok) return invalidInput(req, table.error);
        const columns = await deps.schemaDescribeTable(table.value);
        return success(req, { columns });
      }
      case "schema.listForeignKeys": {
        const table = optionalTableInput(req.input);
        if (!table.ok) return invalidInput(req, table.error);
        const foreignKeys = await deps.schemaListForeignKeys(table.value);
        return success(req, { foreignKeys });
      }
      case "schema.sampleRows": {
        const parsed = validateSampleRowsInput(req.input);
        if (!parsed.ok) return invalidInput(req, parsed.error);
        const rows = await deps.schemaSampleRows(parsed.value.table, parsed.value.limit);
        return success(req, { rows });
      }
      case "sql.runReadOnlySelect": {
        const parsed = validateRunSelectInput(req.input);
        if (!parsed.ok) return invalidInput(req, parsed.error);
        const rows = await deps.sqlRunReadOnlySelect(parsed.value);
        return success(req, { rows });
      }
      case "fs.readConfigFile": {
        const parsed = validatePathInput(req.input);
        if (!parsed.ok) return invalidInput(req, parsed.error);
        const result = await deps.fsReadConfigFile({ path: parsed.value });
        return success(req, result);
      }
      case "fs.listDir": {
        const parsed = validatePathInput(req.input);
        if (!parsed.ok) return invalidInput(req, parsed.error);
        const result = await deps.fsListDir({ path: parsed.value });
        return result.ok ? success(req, result.payload) : failure(req, result.errorCode);
      }
      case "fs.readFile": {
        const parsed = validateReadFileInput(req.input);
        if (!parsed.ok) return invalidInput(req, parsed.error);
        const result = await deps.fsReadFile(parsed.value);
        return result.ok ? success(req, result.payload) : failure(req, result.errorCode);
      }
      case "fs.stat": {
        const parsed = validatePathInput(req.input);
        if (!parsed.ok) return invalidInput(req, parsed.error);
        const result = await deps.fsStat({ path: parsed.value });
        return result.ok ? success(req, result.payload) : failure(req, result.errorCode);
      }
      case "registry.readKey": {
        const parsed = validatePathInput(req.input);
        if (!parsed.ok) return invalidInput(req, parsed.error);
        const result = await deps.registryReadKey({ path: parsed.value });
        return success(req, result);
      }
      default:
        return invalidInput(req, `Unsupported command: ${(req as { command: string }).command}`);
    }
  } catch (err) {
    return buildAdminErrorResponseMessage({
      requestId: req.requestId,
      command: req.command,
      errorCode: "INTERNAL_ERROR",
      message: err instanceof Error ? err.message : "Internal error"
    });
  }
}

function success(
  req: AdminRequestMessage,
  payload: unknown
): AdminResponseMessage {
  return buildAdminSuccessResponseMessage({
    requestId: req.requestId,
    command: req.command,
    payload,
    probeVersion: PROBE_VERSION
  });
}

function invalidInput(req: AdminRequestMessage, message: string): AdminResponseMessage {
  return buildAdminErrorResponseMessage({
    requestId: req.requestId,
    command: req.command,
    errorCode: "INVALID_INPUT",
    message
  });
}

function failure(req: AdminRequestMessage, errorCode: string): AdminResponseMessage {
  return buildAdminErrorResponseMessage({
    requestId: req.requestId,
    command: req.command,
    errorCode,
    message: errorCode
  });
}

type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

function validateNetworkInput(input: unknown): Validated<ProbeNetworkInput> {
  if (!isRecord(input)) return { ok: false, error: "input must be an object" };
  const host = input.host;
  const port = input.port;
  const timeoutMs = input.timeoutMs ?? 3000;
  if (typeof host !== "string" || host.length === 0) return { ok: false, error: "input.host must be a non-empty string" };
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: "input.port must be an integer between 1 and 65535" };
  }
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1) {
    return { ok: false, error: "input.timeoutMs must be a positive integer" };
  }
  return { ok: true, value: { host, port, timeoutMs } };
}

function validateTestConnectionInput(input: unknown): Validated<TestConnectionInput> {
  if (!isRecord(input)) return { ok: false, error: "input must be an object" };
  const driver = input.driver;
  if (typeof driver !== "string" || driver.length === 0) {
    return { ok: false, error: "input.driver is required" };
  }
  const out: TestConnectionInput = { driver: driver as TestConnectionInput["driver"] };
  for (const key of ["host", "instance", "database", "user", "password", "dsn", "connectionString"] as const) {
    const value = input[key];
    if (typeof value === "string") out[key] = value;
  }
  if (typeof input.port === "number" && Number.isInteger(input.port)) out.port = input.port;
  if (typeof input.trustServerCertificate === "boolean") {
    out.trustServerCertificate = input.trustServerCertificate;
  }
  return { ok: true, value: out };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTableInput(input: unknown): Validated<string> {
  if (!isRecord(input)) return { ok: false, error: "input must be an object" };
  const table = input.table;
  if (typeof table !== "string" || table.trim().length === 0) {
    return { ok: false, error: "input.table must be a non-empty string" };
  }
  return { ok: true, value: table.trim() };
}

function optionalTableInput(input: unknown): Validated<string | undefined> {
  if (input === undefined) return { ok: true, value: undefined };
  if (!isRecord(input)) return { ok: false, error: "input must be an object" };
  if (input.table === undefined) return { ok: true, value: undefined };
  if (typeof input.table !== "string" || input.table.trim().length === 0) {
    return { ok: false, error: "input.table must be a non-empty string" };
  }
  return { ok: true, value: input.table.trim() };
}

function validateSampleRowsInput(input: unknown): Validated<{ table: string; limit: number }> {
  if (!isRecord(input)) return { ok: false, error: "input must be an object" };
  if (typeof input.table !== "string" || input.table.trim().length === 0) {
    return { ok: false, error: "input.table must be a non-empty string" };
  }
  const limit = input.limit ?? 20;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    return { ok: false, error: "input.limit must be an integer between 1 and 1000" };
  }
  return { ok: true, value: { table: input.table.trim(), limit } };
}

function validateRunSelectInput(input: unknown): Validated<{ sql: string; limit: number }> {
  if (!isRecord(input)) return { ok: false, error: "input must be an object" };
  if (typeof input.sql !== "string" || input.sql.trim().length === 0) {
    return { ok: false, error: "input.sql must be a non-empty string" };
  }
  const limit = input.limit ?? 100;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    return { ok: false, error: "input.limit must be an integer between 1 and 1000" };
  }
  return { ok: true, value: { sql: input.sql, limit } };
}

function validatePathInput(input: unknown): Validated<string> {
  if (!isRecord(input)) return { ok: false, error: "input must be an object" };
  if (typeof input.path !== "string" || input.path.trim().length === 0) {
    return { ok: false, error: "input.path must be a non-empty string" };
  }
  return { ok: true, value: input.path.trim() };
}

function validateReadFileInput(input: unknown): Validated<{ path: string; maxBytes?: number }> {
  const parsed = validatePathInput(input);
  if (!parsed.ok) return parsed;
  const record = input as Record<string, unknown>;
  const out: { path: string; maxBytes?: number } = { path: parsed.value };
  if (record.maxBytes !== undefined) {
    if (typeof record.maxBytes !== "number" || !Number.isInteger(record.maxBytes) || record.maxBytes < 1) {
      return { ok: false, error: "input.maxBytes must be a positive integer" };
    }
    out.maxBytes = record.maxBytes;
  }
  return { ok: true, value: out };
}

function validateScanConfigDirsInput(input: unknown): Validated<ScanConfigDirsInput> {
  if (!isRecord(input)) return { ok: false, error: "input must be an object" };
  if (!Array.isArray(input.roots) || input.roots.length === 0) {
    return { ok: false, error: "input.roots must be a non-empty array" };
  }
  if (input.roots.length > MAX_ROOTS) {
    return { ok: false, error: `input.roots accepts at most ${MAX_ROOTS} items` };
  }
  const roots: string[] = [];
  for (const r of input.roots) {
    if (typeof r !== "string" || r.length === 0) {
      return { ok: false, error: "input.roots must contain non-empty strings" };
    }
    roots.push(r);
  }
  const out: ScanConfigDirsInput = { roots };
  if (Array.isArray(input.patterns)) {
    const patterns: string[] = [];
    for (const p of input.patterns) {
      if (typeof p !== "string" || p.length === 0) {
        return { ok: false, error: "input.patterns must contain non-empty strings" };
      }
      patterns.push(p);
    }
    if (patterns.length > 0) out.patterns = patterns;
  }
  if (typeof input.maxDepth === "number" && Number.isInteger(input.maxDepth) && input.maxDepth > 0) {
    out.maxDepth = input.maxDepth;
  }
  if (typeof input.maxFiles === "number" && Number.isInteger(input.maxFiles) && input.maxFiles > 0) {
    out.maxFiles = input.maxFiles;
  }
  if (typeof input.maxAgeDays === "number" && input.maxAgeDays > 0) {
    out.maxAgeDays = input.maxAgeDays;
  }
  return { ok: true, value: out };
}
