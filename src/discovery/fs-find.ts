import { mapFsError, compilePatterns, matchesAny, clamp, walkDirs } from "./fs-walk.js";

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_RESULTS = 100;
const MAX_DEPTH_CEILING = 6;
const MAX_RESULTS_CEILING = 500;
const MAX_ROOTS = 32;

export interface FsFindFile {
  path: string;
  size: number;
  mtime: string;
}

export interface FsFindError {
  path: string;
  reason: "permission" | "missing" | "unknown";
}

export interface FsFindInput {
  roots: string[];
  namePatterns: string[];
  maxDepth?: number;
  maxResults?: number;
}

export interface FsFindResult {
  files: FsFindFile[];
  truncated: boolean;
  rootsRejected: string[];
  errors: FsFindError[];
}

export interface FsFindOps {
  readdir(path: string): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink?: boolean; size?: number; mtimeMs?: number }>>;
}

export async function fsFind(input: FsFindInput, ops: FsFindOps): Promise<FsFindResult> {
  const maxDepth = clamp(input.maxDepth ?? DEFAULT_MAX_DEPTH, 1, MAX_DEPTH_CEILING);
  const maxResults = clamp(input.maxResults ?? DEFAULT_MAX_RESULTS, 1, MAX_RESULTS_CEILING);
  const patterns = compilePatterns(input.namePatterns);

  const files: FsFindFile[] = [];
  const errors: FsFindError[] = [];
  const rootsRejected: string[] = [];
  let truncated = false;

  if (input.roots.length > MAX_ROOTS) {
    rootsRejected.push(...input.roots);
    return { files, truncated: true, rootsRejected, errors };
  }

  for (const rawRoot of input.roots) {
    if (files.length >= maxResults) break;

    const walker = walkDirs(
      [rawRoot],
      { readdir: ops.readdir },
      {
        maxDepth,
        onError: (path, err) => errors.push({ path, reason: mapFsError(err) }),
        onRootRejected: () => rootsRejected.push(rawRoot)
      }
    );

    for await (const { entry, fullPath } of walker) {
      if (files.length >= maxResults) {
        truncated = true;
        break;
      }
      if (!entry.isFile) continue;
      if (!matchesAny(entry.name, patterns)) continue;

      files.push({
        path: fullPath,
        size: entry.size ?? 0,
        mtime: typeof entry.mtimeMs === "number" ? new Date(entry.mtimeMs).toISOString() : new Date(0).toISOString()
      });
    }
  }

  return { files, truncated, rootsRejected, errors };
}
