import type { ProbeErrorCode } from "./types.js";

export type { ProbeErrorCode } from "./types.js";

export class DriverMissingError extends Error {
  public readonly driver: string;

  public constructor(driver: string) {
    super(`Driver package missing: ${driver}`);
    this.name = "DriverMissingError";
    this.driver = driver;
  }
}

export function categorizeError(err: unknown): ProbeErrorCode {
  if (err instanceof DriverMissingError) return "driver_missing";

  const msg = readMessage(err).toLowerCase();
  if (msg.length === 0) return "unknown";

  if (msg.includes("etimedout") || msg.includes("timeout") || msg.includes("timed out")) {
    return "timeout";
  }
  if (msg.includes("econnrefused") || msg.includes("unreachable") || msg.includes("enotfound")) {
    return "unreachable";
  }
  if (msg.includes("ssl") || msg.includes("tls") || msg.includes("certificate")) {
    return "tls";
  }
  if (
    msg.includes("login failed") ||
    msg.includes("28000") ||
    msg.includes("password") ||
    msg.includes("access denied") ||
    msg.includes("authentication")
  ) {
    return "auth";
  }
  return "unknown";
}

function readMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const value = (err as { message?: unknown }).message;
    if (typeof value === "string") return value;
  }
  return "";
}
