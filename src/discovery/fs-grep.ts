import { isBinary } from "./fs-primitives.js";
import { isDeniedRoot, shouldSkipDir, joinPath, mapFsError, clamp } from "./fs-walk.js";

const DEFAULT_EXTENSIONS = ["ini", "conf", "config", "xml", "json", "env", "udl", "properties"];
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_MATCHES = 50;
const DEFAULT_MAX_FILES_SCANNED = 500;

const MAX_DEPTH_CEILING = 5;
const MAX_FILE_BYTES_CEILING = 1024 * 1024;
const MAX_MATCHES_CEILING = 200;
const MAX_FILES_SCANNED_CEILING = 2000;

const TEXT_TRUNCATE_CHARS = 300;

export interface FsGrepMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface FsGrepError {
  path: string;
  reason: "permission" | "missing" | "unknown";
}

export interface FsGrepInput {
  root: string;
  pattern: string;
  ignoreCase?: boolean;
  extensions?: string[];
  maxDepth?: number;
  maxFileBytes?: number;
  maxMatches?: number;
  maxFilesScanned?: number;
}

export interface FsGrepResult {
  matches: FsGrepMatch[];
  truncated: boolean;
  filesScanned: number;
  errors: FsGrepError[];
}

export interface FsGrepOps {
  readdir(path: string): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean }>>;
  readFileBytes(path: string, maxBytes: number): Promise<{ buffer: Buffer; truncated: boolean; totalSize: number }>;
}

export async function fsGrep(input: FsGrepInput, ops: FsGrepOps): Promise<FsGrepResult> {
  const maxDepth = clamp(input.maxDepth ?? DEFAULT_MAX_DEPTH, 1, MAX_DEPTH_CEILING);
  const maxFileBytes = clamp(input.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, 1, MAX_FILE_BYTES_CEILING);
  const maxMatches = clamp(input.maxMatches ?? DEFAULT_MAX_MATCHES, 1, MAX_MATCHES_CEILING);
  const maxFilesScanned = clamp(input.maxFilesScanned ?? DEFAULT_MAX_FILES_SCANNED, 1, MAX_FILES_SCANNED_CEILING);
  const extensions = new Set((input.extensions ?? DEFAULT_EXTENSIONS).map((e) => e.toLowerCase().replace(/^\./, "")));
  const flags = input.ignoreCase !== false ? "i" : "";
  let re: RegExp;
  try {
    re = new RegExp(input.pattern, flags);
  } catch {
    return { matches: [], truncated: false, filesScanned: 0, errors: [{ path: input.root, reason: "unknown" }] };
  }

  const matches: FsGrepMatch[] = [];
  const errors: FsGrepError[] = [];
  let filesScanned = 0;
  let truncated = false;

  if (isDeniedRoot(input.root)) {
    return { matches, truncated: false, filesScanned: 0, errors: [{ path: input.root, reason: "permission" }] };
  }

  const stack: { path: string; depth: number }[] = [{ path: input.root, depth: 0 }];

  while (stack.length > 0 && matches.length < maxMatches && filesScanned < maxFilesScanned) {
    const frame = stack.pop()!;
    let dirents: Array<{ name: string; isFile: boolean; isDirectory: boolean }>;
    try {
      dirents = await ops.readdir(frame.path);
    } catch (err) {
      errors.push({ path: frame.path, reason: mapFsError(err) });
      continue;
    }

    for (const entry of dirents) {
      if (matches.length >= maxMatches || filesScanned >= maxFilesScanned) {
        truncated = true;
        break;
      }
      const fullPath = joinPath(frame.path, entry.name);
      if (entry.isDirectory) {
        if (shouldSkipDir(entry.name)) continue;
        if (frame.depth + 1 < maxDepth) {
          stack.push({ path: fullPath, depth: frame.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile) continue;

      const ext = entry.name.includes(".") ? entry.name.split(".").pop()!.toLowerCase() : "";
      if (!extensions.has(ext)) continue;

      filesScanned++;
      let read: { buffer: Buffer; truncated: boolean; totalSize: number };
      try {
        read = await ops.readFileBytes(fullPath, maxFileBytes);
      } catch (err) {
        errors.push({ path: fullPath, reason: mapFsError(err) });
        continue;
      }

      if (isBinary(read.buffer)) continue;

      const text = read.buffer.toString("utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
        const lineText = lines[i]!;
        re.lastIndex = 0;
        const m = re.exec(lineText);
        if (!m) continue;
        matches.push({
          path: fullPath,
          line: i + 1,
          column: m.index + 1,
          text: lineText.length > TEXT_TRUNCATE_CHARS ? lineText.slice(0, TEXT_TRUNCATE_CHARS) : lineText
        });
      }
    }
  }

  if (stack.length > 0 || (matches.length >= maxMatches || filesScanned >= maxFilesScanned)) {
    if (matches.length >= maxMatches || filesScanned >= maxFilesScanned) truncated = true;
  }

  return { matches, truncated, filesScanned, errors };
}
