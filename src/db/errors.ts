import type { DatabaseDriver } from "../config/types.js";
import { redactString } from "../logging/redact.js";

export type DatabaseOperation = "connect" | "query" | "listTables" | "listColumns" | "close";

export interface NormalizeDatabaseErrorInput {
  driver: DatabaseDriver;
  operation: DatabaseOperation;
  error: unknown;
  secrets?: readonly string[];
}

export class DatabaseOperationError extends Error {
  public readonly driver: DatabaseDriver;
  public readonly operation: DatabaseOperation;
  public readonly errorCode: string;
  public readonly retryable: boolean;

  public constructor(input: {
    driver: DatabaseDriver;
    operation: DatabaseOperation;
    errorCode: string;
    message: string;
    retryable: boolean;
  }) {
    super(input.message);
    this.name = "DatabaseOperationError";
    this.driver = input.driver;
    this.operation = input.operation;
    this.errorCode = input.errorCode;
    this.retryable = input.retryable;
  }
}

export function normalizeDatabaseError(input: NormalizeDatabaseErrorInput): DatabaseOperationError {
  if (input.error instanceof DatabaseOperationError) {
    return input.error;
  }

  const rawCode = readErrorCode(input.error);
  const errorCode = rawCode ? `${input.driver.toUpperCase()}_${rawCode}` : `${input.driver.toUpperCase()}_DATABASE_ERROR`;
  const rawMessage = readErrorMessage(input.error);
  const redactedMessage = redactString(rawMessage, input.secrets ?? []);

  return new DatabaseOperationError({
    driver: input.driver,
    operation: input.operation,
    errorCode,
    retryable: isRetryable(rawCode, rawMessage),
    message: `${input.driver} ${input.operation} failed: ${redactedMessage}`
  });
}

function readErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const value = error.code ?? error.errno ?? error.sqlState;
  return value === undefined || value === null ? undefined : String(value).replace(/[^A-Za-z0-9_]/g, "_");
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  return "Database operation failed";
}

function isRetryable(code: string | undefined, message: string): boolean {
  const normalized = `${code ?? ""} ${message}`.toLowerCase();
  return [
    "timeout",
    "timedout",
    "econnreset",
    "econnrefused",
    "connection",
    "deadlock",
    "lock wait",
    "network"
  ].some((token) => normalized.includes(token));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
