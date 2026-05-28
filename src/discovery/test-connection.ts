import type { SourceDatabaseAdapter } from "../db/source-adapter.js";
import type { DatabaseConfig, DatabaseDriver } from "../config/types.js";
import { categorizeError, type ProbeErrorCode } from "./error-codes.js";

export interface TestConnectionInput {
  driver: DatabaseDriver;
  host?: string;
  port?: number;
  instance?: string;
  database?: string;
  user?: string;
  password?: string;
  dsn?: string;
  connectionString?: string;
  trustServerCertificate?: boolean;
}

export type TestConnectionResult =
  | { ok: true; latencyMs: number; serverVersion?: string }
  | { ok: false; code: ProbeErrorCode; message: string };

export interface ProbeTestConnectionOptions {
  createAdapter: (config: DatabaseConfig) => SourceDatabaseAdapter;
  timeoutMs: number;
}

export async function probeTestConnection(
  input: TestConnectionInput,
  options: ProbeTestConnectionOptions
): Promise<TestConnectionResult> {
  const start = Date.now();
  const password = input.password ?? "";
  const secrets = [password].filter((s) => s.length > 0);

  const config: DatabaseConfig = {
    driver: input.driver,
    host: input.host ?? "",
    port: input.port ?? 0,
    name: input.database ?? "",
    user: input.user ?? "",
    password
  };
  if (input.instance) config.instance = input.instance;
  if (input.trustServerCertificate !== undefined) {
    config.trustServerCertificate = input.trustServerCertificate;
  }

  let adapter: SourceDatabaseAdapter | undefined;
  try {
    adapter = options.createAdapter(config);
    await withTimeout(adapter.connect(), options.timeoutMs);
    await withTimeout(adapter.listTables(), options.timeoutMs);
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    const code = categorizeError(err);
    const message = redact(readMessage(err), secrets);
    return { ok: false, code, message };
  } finally {
    if (adapter) {
      try {
        await adapter.close();
      } catch {
        /* ignore close errors */
      }
    }
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`probe timeout after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function readMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "probe failed";
}

function redact(message: string, secrets: string[]): string {
  let out = message;
  for (const s of secrets) {
    if (s.length === 0) continue;
    out = out.split(s).join("[REDACTED]");
  }
  return out;
}
