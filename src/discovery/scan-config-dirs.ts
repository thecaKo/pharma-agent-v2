import type { FileSystemReader, FsEntry } from "./fs-reader.js";
import {
  DENY_ROOT_REGEXES,
  isDeniedRoot,
  shouldSkipDir,
  compilePatterns,
  matchesAny,
  expandEnv,
  mapFsError,
  joinPath,
  clamp
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
    if (isDeniedRoot(root)) {
      rootsRejected.push(rawRoot);
      continue;
    }

    let initialEntries: FsEntry[];
    try {
      initialEntries = await ctx.fs.enumerateTop(root);
    } catch (err) {
      errors.push({ path: root, reason: mapFsError(err) });
      continue;
    }

    const stack: { path: string; entries: FsEntry[]; depth: number }[] = [
      { path: root, entries: initialEntries, depth: 0 }
    ];
    while (stack.length > 0) {
      if (files.length >= maxFiles) break;
      const frame = stack.pop();
      if (!frame) break;
      for (const entry of frame.entries) {
        if (files.length >= maxFiles) {
          truncated = true;
          break;
        }
        const fullPath = joinPath(frame.path, entry.name);
        if (entry.isFile) {
          if (!matchesAny(entry.name, patternsRegex)) continue;
          if (ageCutoff && entry.mtime && entry.mtime < ageCutoff) continue;
          files.push({
            path: fullPath,
            size: entry.size ?? 0,
            mtime: (entry.mtime ?? new Date(0)).toISOString()
          });
          if (files.length >= maxFiles) {
            truncated = true;
            break;
          }
          continue;
        }
        if (entry.isDirectory) {
          if (shouldSkipDir(entry.name)) continue;
          if (frame.depth + 1 >= maxDepth) continue;
          try {
            const childEntries = await ctx.fs.enumerateTop(fullPath);
            stack.push({ path: fullPath, entries: childEntries, depth: frame.depth + 1 });
          } catch (err) {
            errors.push({ path: fullPath, reason: mapFsError(err) });
          }
        }
      }
    }
  }

  return { files, truncated, rootsRejected, errors };
}

function cutoffDate(now: () => Date, days: number): Date {
  const t = now().getTime() - days * 24 * 60 * 60 * 1000;
  return new Date(t);
}
