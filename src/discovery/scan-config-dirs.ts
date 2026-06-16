import type { FileSystemReader } from "./fs-reader.js";
import {
  DENY_ROOT_REGEXES,
  isDeniedRoot,
  compilePatterns,
  matchesAny,
  expandEnv,
  mapFsError,
  normalizePath,
  clamp,
  walkDirs,
  type WalkOps
} from "./fs-walk.js";

export { DENY_ROOT_REGEXES };

export const DEFAULT_PATTERNS = [
  "*.ini", "*.conf", "*.config",
  "*.json", "*.xml", "*.yaml", "*.yml",
  "*.env", "*.properties",
  "*.db", "*.sqlite", "*.db3"
] as const;

export const DEFAULT_MAX_DEPTH = 3;
export const DEFAULT_MAX_FILES = 200;
export const MAX_DEPTH_CEILING = 5;
export const MAX_FILES_CEILING = 1000;
export const MAX_ROOTS = 32;

export interface ScanConfigDirsInput {
  roots: string[];
  patterns?: readonly string[];
  maxDepth?: number;
  maxFiles?: number;
  maxAgeDays?: number;
}

export interface ScannedFile {
  path: string;
  size: number;
  mtime: string;
}

export interface ScanError {
  path: string;
  reason: "permission" | "missing" | "unknown";
}

export interface ScanConfigDirsResult {
  files: ScannedFile[];
  truncated: boolean;
  rootsRejected: string[];
  errors: ScanError[];
}

export interface ProbeScanConfigDirsContext {
  fs: FileSystemReader;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

export async function probeScanConfigDirs(
  ctx: ProbeScanConfigDirsContext,
  input: ScanConfigDirsInput
): Promise<ScanConfigDirsResult> {
  const env = ctx.env ?? process.env;
  const maxDepth = clamp(input.maxDepth ?? DEFAULT_MAX_DEPTH, 1, MAX_DEPTH_CEILING);
  const maxFiles = clamp(input.maxFiles ?? DEFAULT_MAX_FILES, 1, MAX_FILES_CEILING);
  const patternsRegex = compilePatterns(input.patterns ?? DEFAULT_PATTERNS);
  const ageCutoff =
    input.maxAgeDays !== undefined
      ? cutoffDate(ctx.now ?? (() => new Date()), input.maxAgeDays)
      : undefined;

  const files: ScannedFile[] = [];
  const errors: ScanError[] = [];
  const rootsRejected: string[] = [];
  let truncated = false;

  for (const rawRoot of input.roots) {
    if (files.length >= maxFiles) break;
    const expansion = expandEnv(rawRoot, env);
    if (expansion === undefined) {
      rootsRejected.push(rawRoot);
      continue;
    }
    const root = expansion;
    // checa path original (Windows) E normalizado (desfaz "../" — ex.: /tmp/../proc → /proc)
    if (isDeniedRoot(root) || isDeniedRoot(normalizePath(root))) {
      rootsRejected.push(rawRoot);
      continue;
    }

    const walkOps: WalkOps = {
      readdir: (path) =>
        ctx.fs.enumerateTop(path).then((entries) =>
          entries.map((e) => ({
            name: e.name,
            isFile: e.isFile,
            isDirectory: e.isDirectory,
            isSymbolicLink: e.isSymbolicLink,
            size: e.size,
            mtimeMs: e.mtime?.getTime()
          }))
        )
    };

    const walker = walkDirs(
      [root],
      walkOps,
      {
        maxDepth,
        // deny-list já verificada acima para a raiz; skipRootNormalize evita que
        // path.resolve estrague paths Windows quando executado em Linux (testes cross-plat)
        skipRootNormalize: true,
        onError: (path, err) => errors.push({ path, reason: mapFsError(err) }),
        onRootRejected: () => rootsRejected.push(rawRoot)
      }
    );

    for await (const { entry, fullPath } of walker) {
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      if (!entry.isFile) continue;
      if (!matchesAny(entry.name, patternsRegex)) continue;
      const mtime = typeof entry.mtimeMs === "number" ? new Date(entry.mtimeMs) : undefined;
      if (ageCutoff && mtime && mtime < ageCutoff) continue;
      files.push({
        path: fullPath,
        size: entry.size ?? 0,
        mtime: (mtime ?? new Date(0)).toISOString()
      });
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
    }
  }

  return { files, truncated, rootsRejected, errors };
}

function cutoffDate(now: () => Date, days: number): Date {
  const t = now().getTime() - days * 24 * 60 * 60 * 1000;
  return new Date(t);
}
