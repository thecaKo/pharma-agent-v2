/**
 * Primitivas de sistema de arquivos READ-ONLY que a IA compõe para achar o banco
 * em QUALQUER caminho/formato. Sem deny-list/roots restritivos como na descoberta
 * determinística antiga — só guardas contra: poucos caminhos críticos de SO,
 * arquivos binários e leituras gigantes (cap de bytes). NUNCA escrevem.
 *
 * Contrato (fixo — neo consome):
 * - fs.listDir { path } → { entries: [{ name, type:'file'|'dir', size? }] }
 * - fs.readFile { path, maxBytes? } → { path, content, truncated }
 * - fs.stat { path } → { exists, type, size, mtime? }
 */

import { promises as nodeFs } from "node:fs";

export const DEFAULT_MAX_READ_BYTES = 256 * 1024;
const MAX_READ_BYTES_CEILING = 4 * 1024 * 1024;

export type FsEntryType = "file" | "dir";

export interface FsListDirEntry {
  name: string;
  type: FsEntryType;
  size?: number;
}

export interface FsListDirInput {
  path: string;
}
export interface FsReadFileInput {
  path: string;
  maxBytes?: number;
}
export interface FsStatInput {
  path: string;
}

export type FsListDirResult =
  | { ok: true; payload: { entries: FsListDirEntry[] } }
  | { ok: false; errorCode: FsErrorCode };

export type FsReadFileResult =
  | { ok: true; payload: { path: string; content: string; truncated: boolean } }
  | { ok: false; errorCode: FsErrorCode };

export type FsStatResult =
  | { ok: true; payload: { exists: boolean; type?: FsEntryType; size?: number; mtime?: string } }
  | { ok: false; errorCode: FsErrorCode };

export type FsErrorCode =
  | "INVALID_INPUT"
  | "DENIED_PATH"
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "BINARY_FILE"
  | "NOT_A_FILE"
  | "NOT_A_DIRECTORY"
  | "READ_FAILED";

export interface FsPrimitiveStat {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtimeMs?: number;
}

export interface FsPrimitiveDirent {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  size?: number;
}

export interface FsPrimitivesOps {
  stat(path: string): Promise<FsPrimitiveStat>;
  readdir(path: string): Promise<FsPrimitiveDirent[]>;
  readFileBytes(path: string, maxBytes: number): Promise<{ buffer: Buffer; truncated: boolean; totalSize: number }>;
}

/**
 * Poucos caminhos críticos de SO que NÃO devem ser lidos/listados (pseudo-FS do
 * kernel e dirs sensíveis do Windows). Tudo o mais é permitido (read-only).
 */
const DENIED_PATH_REGEXES: RegExp[] = [
  /^\/proc(\/|$)/i,
  /^\/sys(\/|$)/i,
  /^\/dev(\/|$)/i,
  /^[A-Z]:[\\/]Windows[\\/]System32[\\/]config(\\|\/|$)/i,
  /^[A-Z]:[\\/]Windows[\\/]System32[\\/]LogFiles(\\|\/|$)/i,
  /^[A-Z]:[\\/]\$Recycle\.Bin(\\|\/|$)/i
];

function validatePath(raw: unknown): { ok: true; path: string } | { ok: false; errorCode: FsErrorCode } {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, errorCode: "INVALID_INPUT" };
  }
  const path = raw.trim();
  if (DENIED_PATH_REGEXES.some((re) => re.test(path))) {
    return { ok: false, errorCode: "DENIED_PATH" };
  }
  return { ok: true, path };
}

function mapFsError(err: unknown): FsErrorCode {
  if (err && typeof err === "object" && "code" in err) {
    const code = String((err as { code?: unknown }).code);
    if (code === "ENOENT") return "NOT_FOUND";
    if (code === "EACCES" || code === "EPERM") return "PERMISSION_DENIED";
  }
  return "READ_FAILED";
}

export async function fsListDir(input: FsListDirInput, ops: FsPrimitivesOps): Promise<FsListDirResult> {
  const guard = validatePath(input.path);
  if (!guard.ok) return guard;
  let dirents: FsPrimitiveDirent[];
  try {
    dirents = await ops.readdir(guard.path);
  } catch (err) {
    const code = mapFsError(err);
    if (code === "READ_FAILED") {
      // readdir em arquivo regular vira ENOTDIR.
      if (err && typeof err === "object" && String((err as { code?: unknown }).code) === "ENOTDIR") {
        return { ok: false, errorCode: "NOT_A_DIRECTORY" };
      }
    }
    return { ok: false, errorCode: code };
  }
  const entries: FsListDirEntry[] = dirents.map((d) => {
    const type: FsEntryType = d.isDirectory ? "dir" : "file";
    return type === "file" && typeof d.size === "number"
      ? { name: d.name, type, size: d.size }
      : { name: d.name, type };
  });
  return { ok: true, payload: { entries } };
}

export async function fsReadFile(input: FsReadFileInput, ops: FsPrimitivesOps): Promise<FsReadFileResult> {
  const guard = validatePath(input.path);
  if (!guard.ok) return guard;

  let maxBytes = DEFAULT_MAX_READ_BYTES;
  if (input.maxBytes !== undefined) {
    if (typeof input.maxBytes !== "number" || !Number.isInteger(input.maxBytes) || input.maxBytes < 1) {
      return { ok: false, errorCode: "INVALID_INPUT" };
    }
    maxBytes = Math.min(input.maxBytes, MAX_READ_BYTES_CEILING);
  }

  let read: { buffer: Buffer; truncated: boolean; totalSize: number };
  try {
    read = await ops.readFileBytes(guard.path, maxBytes);
  } catch (err) {
    const code = mapFsError(err);
    if (err && typeof err === "object" && String((err as { code?: unknown }).code) === "EISDIR") {
      return { ok: false, errorCode: "NOT_A_FILE" };
    }
    return { ok: false, errorCode: code };
  }

  if (isBinary(read.buffer)) {
    return { ok: false, errorCode: "BINARY_FILE" };
  }

  return {
    ok: true,
    payload: { path: guard.path, content: read.buffer.toString("utf8"), truncated: read.truncated }
  };
}

export async function fsStat(input: FsStatInput, ops: FsPrimitivesOps): Promise<FsStatResult> {
  const guard = validatePath(input.path);
  if (!guard.ok) return guard;
  let stat: FsPrimitiveStat;
  try {
    stat = await ops.stat(guard.path);
  } catch (err) {
    const code = mapFsError(err);
    if (code === "NOT_FOUND") {
      return { ok: true, payload: { exists: false } };
    }
    return { ok: false, errorCode: code };
  }
  const type: FsEntryType = stat.isDirectory ? "dir" : "file";
  const payload: { exists: boolean; type?: FsEntryType; size?: number; mtime?: string } = {
    exists: true,
    type,
    size: stat.size
  };
  if (typeof stat.mtimeMs === "number") {
    payload.mtime = new Date(stat.mtimeMs).toISOString();
  }
  return { ok: true, payload };
}

/**
 * Implementação real (node:fs) das operações usadas pelas primitivas. Lê só os
 * primeiros maxBytes do arquivo (sem carregar o arquivo inteiro na memória).
 */
export const nodeFsPrimitivesOps: FsPrimitivesOps = {
  async stat(path) {
    const s = await nodeFs.stat(path);
    return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs };
  },
  async readdir(path) {
    const dirents = await nodeFs.readdir(path, { withFileTypes: true });
    const entries: FsPrimitiveDirent[] = [];
    for (const dirent of dirents) {
      let size: number | undefined;
      if (dirent.isFile()) {
        try {
          const s = await nodeFs.stat(`${path}/${dirent.name}`);
          size = s.size;
        } catch {
          size = undefined;
        }
      }
      entries.push({ name: dirent.name, isFile: dirent.isFile(), isDirectory: dirent.isDirectory(), size });
    }
    return entries;
  },
  async readFileBytes(path, maxBytes) {
    const handle = await nodeFs.open(path, "r");
    try {
      const stat = await handle.stat();
      const toRead = Math.min(stat.size, maxBytes);
      const buffer = Buffer.alloc(toRead);
      if (toRead > 0) {
        await handle.read(buffer, 0, toRead, 0);
      }
      return { buffer, truncated: stat.size > maxBytes, totalSize: stat.size };
    } finally {
      await handle.close();
    }
  }
};

/**
 * Heurística de binário: presença de byte NUL na janela lida. Suficiente para
 * pular executáveis/imagens/arquivos de banco sem tentar decodificá-los.
 */
function isBinary(buffer: Buffer): boolean {
  const window = buffer.subarray(0, Math.min(buffer.length, 8192));
  return window.includes(0);
}
