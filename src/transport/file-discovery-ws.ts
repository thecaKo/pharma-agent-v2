import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { ProtocolParseError } from "./protocol.js";

export const FILE_DISCOVERY_SCAN_COMMAND_TYPE = "file-discovery.scan";
export const FILE_DISCOVERY_SCAN_RESULT_TYPE = "file-discovery.scan.result";

export const FILE_DISCOVERY_MAX_ROOT_PATH_LENGTH = 4096;
export const FILE_DISCOVERY_MAX_ENTRIES = 1000;
export const FILE_DISCOVERY_MAX_PATH_LENGTH = 8192;
export const FILE_DISCOVERY_MAX_NAME_LENGTH = 512;
export const FILE_DISCOVERY_MAX_FAILURE_REASON_LENGTH = 500;

export interface FileDiscoveryScanCommand {
  type: typeof FILE_DISCOVERY_SCAN_COMMAND_TYPE;
  correlationId: string;
  rootPath?: string;
}

export interface FileDiscoveryScanEntryWire {
  path: string;
  name?: string | null;
  isDirectory?: boolean | null;
  sizeBytes?: number | null;
}

export interface FileDiscoveryScanResultMessage {
  id: string;
  type: typeof FILE_DISCOVERY_SCAN_RESULT_TYPE;
  entries: FileDiscoveryScanEntryWire[];
  failureReason?: string;
}

export function parseFileDiscoveryScanCommand(
  raw: string | Buffer | ArrayBuffer | Buffer[]
): FileDiscoveryScanCommand {
  const value = parseJson(raw);
  expectRecordRoot(value);
  const message = value as Record<string, unknown>;
  const type = expectNonEmptyString(message.type, "type");
  if (type !== FILE_DISCOVERY_SCAN_COMMAND_TYPE) {
    throw new ProtocolParseError(`Unsupported server message type: ${type}`);
  }

  const command: FileDiscoveryScanCommand = {
    type: FILE_DISCOVERY_SCAN_COMMAND_TYPE,
    correlationId: expectCorrelationId(message.id, "id")
  };

  if ("rootPath" in message && message.rootPath !== undefined && message.rootPath !== null) {
    if (typeof message.rootPath !== "string") {
      throw new ProtocolParseError("rootPath must be a string");
    }

    const rootTrimmed = message.rootPath.trim();
    if (rootTrimmed.length > FILE_DISCOVERY_MAX_ROOT_PATH_LENGTH) {
      throw new ProtocolParseError("rootPath exceeds maximum length");
    }

    if (rootTrimmed.length > 0) {
      command.rootPath = rootTrimmed;
    }
  }

  return command;
}

export function buildFileDiscoveryScanSuccessResult(
  correlationId: string,
  entries: readonly FileDiscoveryScanEntryWire[]
): FileDiscoveryScanResultMessage {
  const normalized = sanitizeDiscoveryEntries(entries);
  return {
    id: correlationId,
    type: FILE_DISCOVERY_SCAN_RESULT_TYPE,
    entries: normalized
  };
}

export function buildFileDiscoveryScanFailureResult(
  correlationId: string,
  failureReason: string
): FileDiscoveryScanResultMessage {
  return {
    id: correlationId,
    type: FILE_DISCOVERY_SCAN_RESULT_TYPE,
    entries: [],
    failureReason: clipFailureReason(failureReason)
  };
}

export function serializeFileDiscoveryScanResult(message: FileDiscoveryScanResultMessage): string {
  return JSON.stringify(message);
}

export async function scanLocalFilesystem(
  workspaceRootResolved: string
): Promise<{ ok: true; entries: FileDiscoveryScanEntryWire[] } | { ok: false; failureReason: string }> {
  let rootResolved: string;
  try {
    rootResolved = path.resolve(workspaceRootResolved);
  } catch {
    return { ok: false, failureReason: "Invalid root path" };
  }

  let rootStat;
  try {
    rootStat = await stat(rootResolved);
  } catch {
    return { ok: false, failureReason: "Unable to access root directory" };
  }

  if (!rootStat.isDirectory()) {
    return { ok: false, failureReason: "Root path is not a directory" };
  }

  const entries: FileDiscoveryScanEntryWire[] = [];
  const stack = [rootResolved];

  try {
    while (stack.length > 0 && entries.length < FILE_DISCOVERY_MAX_ENTRIES) {
      const currentDir = stack.pop()!;
      let dirents;
      try {
        dirents = await readdir(currentDir, { withFileTypes: true });
      } catch {
        continue;
      }

      dirents.sort((a, b) => a.name.localeCompare(b.name));

      for (const dirent of dirents) {
        if (entries.length >= FILE_DISCOVERY_MAX_ENTRIES) {
          break;
        }

        const full = path.join(currentDir, dirent.name);
        let stats;
        try {
          stats = await lstat(full);
        } catch {
          continue;
        }

        const clippedPath = clipString(full.trim(), FILE_DISCOVERY_MAX_PATH_LENGTH);
        if (!clippedPath) {
          continue;
        }

        const symlink = stats.isSymbolicLink();

        let nameWire: string | null | undefined;
        const clippedName = clipString(dirent.name.trim(), FILE_DISCOVERY_MAX_NAME_LENGTH);
        nameWire = clippedName.length === 0 ? null : clippedName;

        const wire: FileDiscoveryScanEntryWire = {
          path: clippedPath,
          name: nameWire
        };

        if (symlink) {
          wire.isDirectory = null;
          wire.sizeBytes = boundedFileSize(stats);
        } else if (stats.isDirectory()) {
          wire.isDirectory = true;
          wire.sizeBytes = null;
          stack.push(full);
        } else if (stats.isFile()) {
          wire.isDirectory = false;
          wire.sizeBytes = boundedFileSize(stats);
        } else {
          wire.isDirectory = false;
          wire.sizeBytes = null;
        }

        entries.push(wire);
      }
    }
  } catch {
    return { ok: false, failureReason: "Directory scan failed" };
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));

  return { ok: true, entries };
}

function sanitizeDiscoveryEntries(entries: readonly FileDiscoveryScanEntryWire[]): FileDiscoveryScanEntryWire[] {
  const out: FileDiscoveryScanEntryWire[] = [];
  const seenPaths = new Set<string>();

  for (const raw of entries) {
    if (out.length >= FILE_DISCOVERY_MAX_ENTRIES) {
      break;
    }

    const pathClipped = clipString(String(raw.path).trim(), FILE_DISCOVERY_MAX_PATH_LENGTH);
    if (!pathClipped || seenPaths.has(pathClipped)) {
      continue;
    }

    seenPaths.add(pathClipped);
    const next: FileDiscoveryScanEntryWire = { path: pathClipped };

    if ("name" in raw) {
      if (raw.name === undefined) {
        // omit
      } else if (raw.name === null) {
        next.name = null;
      } else if (typeof raw.name === "string") {
        const n = clipString(raw.name.trim(), FILE_DISCOVERY_MAX_NAME_LENGTH);
        next.name = n.length === 0 ? null : n;
      }
    }

    if ("isDirectory" in raw && raw.isDirectory !== undefined && raw.isDirectory !== null) {
      next.isDirectory = raw.isDirectory;
    }

    if ("sizeBytes" in raw && raw.sizeBytes !== undefined && raw.sizeBytes !== null) {
      const s = Number(raw.sizeBytes);
      if (Number.isInteger(s) && s >= 0 && s <= Number.MAX_SAFE_INTEGER) {
        next.sizeBytes = s;
      }
    }

    out.push(next);
  }

  out.sort((left, right) => left.path.localeCompare(right.path));
  return out;
}

function boundedFileSize(stats: import("node:fs").Stats): number | null {
  const sizeNum = stats.size;
  if (typeof sizeNum !== "number" || !Number.isFinite(sizeNum) || sizeNum < 0) {
    return null;
  }

  return sizeNum > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : Math.trunc(sizeNum);
}

function clipFailureReason(reason: string): string {
  const trimmed = reason.trim();
  const base = trimmed.length === 0 ? "Discovery failed" : trimmed;
  return base.length > FILE_DISCOVERY_MAX_FAILURE_REASON_LENGTH
    ? base.slice(0, FILE_DISCOVERY_MAX_FAILURE_REASON_LENGTH)
    : base;
}

function clipString(value: string, maxLength: number): string {
  if (maxLength <= 0) {
    return "";
  }

  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function parseJson(raw: string | Buffer | ArrayBuffer | Buffer[]): unknown {
  try {
    if (typeof raw === "string") {
      return JSON.parse(raw);
    }
    if (Array.isArray(raw)) {
      return JSON.parse(Buffer.concat(raw).toString("utf8"));
    }
    if (raw instanceof ArrayBuffer) {
      return JSON.parse(Buffer.from(new Uint8Array(raw)).toString("utf8"));
    }
    return JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch (error) {
    throw new ProtocolParseError(`Invalid JSON message: ${(error as Error).message}`);
  }
}

function expectRecordRoot(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolParseError("message must be an object");
  }
}

function expectNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProtocolParseError(`${field} must be a non-empty string`);
  }
  return value;
}

function expectCorrelationId(value: unknown, field: string): string {
  const correlationId = expectNonEmptyString(value, field).trim();
  if (correlationId.length > 128) {
    throw new ProtocolParseError(`${field} must be at most 128 characters`);
  }

  return correlationId;
}
