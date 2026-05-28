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

const PROBE_VERSION = "1";

export interface AdminRouterDependencies {
  probeEngines: () => Promise<EngineCandidate[]>;
  probeOdbcDsns: () => Promise<OdbcDsnCandidate[]>;
  probeNetwork: (input: ProbeNetworkInput) => Promise<ProbeNetworkResult>;
  probeTestConnection: (input: TestConnectionInput) => Promise<TestConnectionResult>;
  schemaListTables: () => Promise<string[]>;
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
      case "schema.listTables": {
        const tables = await deps.schemaListTables();
        return success(req, { tables });
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
