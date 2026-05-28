import type { FileSystemReader, FsEntry } from "./fs-reader.js";

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

const DENY_ROOT_REGEXES: RegExp[] = [
  /^[A-Z]:\\?$/i,
  /^[A-Z]:\\Users\\?$/i,
  /^[A-Z]:\\Windows(\\|$)/i,
  /^[A-Z]:\\\$Recycle\.Bin/i,
  /^\/$/,
  /^\/home\/?$/,
  /^\/usr\/?$/,
  /^\/etc\/?$/
];

const SKIP_DIR_NAMES_CI: ReadonlySet<string> = new Set([
  "node_modules", ".git", ".svn", ".hg",
  "temp", "tmp", "cache", "logs", "log",
  "backup", "backups", "winsxs", "system32", "syswow64",
  "inetcache", "$recycle.bin"
]);

const PRESERVED_HIDDEN_DIRS: ReadonlySet<string> = new Set([".config"]);

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
    if (isDenied(root)) {
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

function expandEnv(value: string, env: Record<string, string | undefined>): string | undefined {
  let resolved = value;
  const re = /%([A-Z0-9_\(\)]+)%/gi;
  let match: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((match = re.exec(resolved)) !== null) {
    const varName = match[1];
    if (!varName) continue;
    if (seen.has(varName)) continue;
    seen.add(varName);
    const replacement = env[varName];
    if (replacement === undefined || replacement.length === 0) return undefined;
    resolved = resolved.split(`%${varName}%`).join(replacement);
    re.lastIndex = 0;
  }
  return resolved;
}

function isDenied(path: string): boolean {
  return DENY_ROOT_REGEXES.some((re) => re.test(path));
}

function shouldSkipDir(name: string): boolean {
  const lower = name.toLowerCase();
  if (SKIP_DIR_NAMES_CI.has(lower)) return true;
  if (name.startsWith(".") && !PRESERVED_HIDDEN_DIRS.has(lower)) return true;
  return false;
}

function compilePatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map((p) => {
    // Escape all regex special chars except * and ?, then convert glob wildcards
    const escaped = p
      .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex specials (not * or ?)
      .replace(/\*/g, ".*")                   // glob * → regex .*
      .replace(/\?/g, ".");                   // glob ? → regex .
    return new RegExp(`^${escaped}$`, "i");
  });
}

function matchesAny(name: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(name));
}

function cutoffDate(now: () => Date, days: number): Date {
  const t = now().getTime() - days * 24 * 60 * 60 * 1000;
  return new Date(t);
}

function mapFsError(err: unknown): "permission" | "missing" | "unknown" {
  if (err && typeof err === "object" && "code" in err) {
    const code = String((err as { code?: unknown }).code);
    if (code === "EACCES" || code === "EPERM") return "permission";
    if (code === "ENOENT") return "missing";
  }
  return "unknown";
}

function joinPath(parent: string, name: string): string {
  if (parent.includes("\\")) {
    return parent.endsWith("\\") ? `${parent}${name}` : `${parent}\\${name}`;
  }
  return parent.endsWith("/") ? `${parent}${name}` : `${parent}/${name}`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
