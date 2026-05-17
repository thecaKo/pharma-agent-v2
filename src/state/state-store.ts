import { constants } from "node:fs";
import { access, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ConnectorState, CursorValue } from "./state-types.js";

export interface StateStoreOptions {
  stateFilePath: string;
  fileSystem?: Partial<StateStoreFileSystem>;
}

export interface StateStoreFileSystem {
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
  writeFile(path: string, data: string, options: { encoding: BufferEncoding; flag: string }): Promise<void>;
  mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(path: string, options: { force: boolean }): Promise<void>;
}

const STATE_KEYS = [
  "connectorId",
  "customerId",
  "mappingVersion",
  "cursorField",
  "cursorType",
  "sourceProductCodeField",
  "lastAckedCursor",
  "lastSuccessfulSendAt",
  "lastBatchId"
] as const;

export class StateStore {
  private readonly stateFilePath: string;
  private readonly fs: StateStoreFileSystem;

  public constructor(options: StateStoreOptions) {
    this.stateFilePath = options.stateFilePath;
    this.fs = {
      readFile,
      writeFile,
      mkdir,
      rename,
      rm,
      ...options.fileSystem
    };
  }

  public async load(): Promise<ConnectorState> {
    try {
      const serialized = await this.fs.readFile(this.stateFilePath, "utf8");
      return normalizeState(JSON.parse(serialized));
    } catch (error) {
      if (isMissingFileError(error)) {
        return {};
      }
      throw error;
    }
  }

  public async save(state: ConnectorState): Promise<void> {
    await this.fs.mkdir(dirname(this.stateFilePath), { recursive: true });

    const tempPath = `${this.stateFilePath}.${process.pid}.${Date.now()}.tmp`;
    const serialized = `${JSON.stringify(pickPersistedState(state), null, 2)}\n`;

    try {
      await this.fs.writeFile(tempPath, serialized, { encoding: "utf8", flag: "wx" });
      await fsyncFile(tempPath);
      await this.fs.rename(tempPath, this.stateFilePath);
      await fsyncDirectory(dirname(this.stateFilePath));
    } catch (error) {
      await this.fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

export function pickPersistedState(state: ConnectorState): ConnectorState {
  const persisted: ConnectorState = {};

  for (const key of STATE_KEYS) {
    if (state[key] !== undefined) {
      persisted[key] = state[key] as never;
    }
  }

  persisted.lastAckedCursor = normalizeCursorValue(persisted.cursorType, persisted.lastAckedCursor);

  return persisted;
}

function normalizeState(value: unknown): ConnectorState {
  if (!isRecord(value)) {
    return {};
  }

  const state = pickPersistedState(value as ConnectorState);
  state.lastAckedCursor = normalizeCursorValue(state.cursorType, state.lastAckedCursor);
  return state;
}

async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  try {
    await access(path, constants.R_OK);
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some platforms/filesystems do not support directory fsync.
  }
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCursorValue(
  cursorType: ConnectorState["cursorType"],
  value: CursorValue | undefined
): CursorValue | undefined {
  if (value === undefined || value === null || cursorType !== "timestamp") {
    return value;
  }

  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    return null;
  }

  const parsedAt = Date.parse(normalized);
  return Number.isNaN(parsedAt) ? normalized : new Date(parsedAt).toISOString();
}
