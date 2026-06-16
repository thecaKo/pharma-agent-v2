import { resolve as pathResolve, normalize as pathNormalize } from "node:path";

export const SECRET_DIR_NAMES: ReadonlySet<string> = new Set([".ssh", ".aws", ".gnupg", ".gnupg2"]);

export function isSecretDir(name: string): boolean {
  return SECRET_DIR_NAMES.has(name.toLowerCase());
}

// path.resolve garante path absoluto e desfaz ../. sem acessar o FS
export function normalizePath(p: string): string {
  return pathResolve(pathNormalize(p));
}

export const DENY_ROOT_REGEXES: RegExp[] = [
  /^[A-Z]:\\?$/i,
  /^[A-Z]:\\Users\\?$/i,
  /^[A-Z]:\\Windows(\\|$)/i,
  /^[A-Z]:\\\$Recycle\.Bin/i,
  /^\/$/,
  /^\/home\/?$/,
  /^\/usr\/?$/,
  /^\/etc\/?$/,
  /^\/proc(\/|$)/i,
  /^\/sys(\/|$)/i,
  /^\/dev(\/|$)/i
];

const SKIP_DIR_NAMES_CI: ReadonlySet<string> = new Set([
  "node_modules", ".git", ".svn", ".hg",
  "temp", "tmp", "cache", "logs", "log",
  "backup", "backups", "winsxs", "system32", "syswow64",
  "inetcache", "$recycle.bin"
]);

const PRESERVED_HIDDEN_DIRS: ReadonlySet<string> = new Set([".config"]);

export function isDeniedRoot(path: string): boolean {
  return DENY_ROOT_REGEXES.some((re) => re.test(path));
}

export function shouldSkipDir(name: string): boolean {
  const lower = name.toLowerCase();
  if (SKIP_DIR_NAMES_CI.has(lower)) return true;
  if (isSecretDir(lower)) return true;
  if (name.startsWith(".") && !PRESERVED_HIDDEN_DIRS.has(lower)) return true;
  return false;
}

export function compilePatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map((p) => {
    const escaped = p
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`, "i");
  });
}

export function matchesAny(name: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(name));
}

export function expandEnv(value: string, env: Record<string, string | undefined>): string | undefined {
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

export function mapFsError(err: unknown): "permission" | "missing" | "unknown" {
  if (err && typeof err === "object" && "code" in err) {
    const code = String((err as { code?: unknown }).code);
    if (code === "EACCES" || code === "EPERM") return "permission";
    if (code === "ENOENT") return "missing";
  }
  return "unknown";
}

export function joinPath(parent: string, name: string): string {
  if (parent.includes("\\")) {
    return parent.endsWith("\\") ? `${parent}${name}` : `${parent}\\${name}`;
  }
  return parent.endsWith("/") ? `${parent}${name}` : `${parent}/${name}`;
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

export interface WalkDirent {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink?: boolean;
  size?: number;
  mtimeMs?: number;
}

export interface WalkOps {
  readdir(path: string): Promise<WalkDirent[]>;
}

export interface WalkFrame {
  path: string;
  depth: number;
}

/**
 * Gerador DFS blindado: bloqueia isDeniedRoot em cada dir,
 * pula symlinks de diretório e shouldSkipDir; respeita maxDepth.
 * skipRootNormalize=true quando o chamador já fez a checagem de deny-list
 * (ex.: scan-config-dirs opera com paths Windows em ambiente Linux nos testes).
 * Yields: { frame, entry, fullPath } para cada arquivo válido.
 * Emite erro via onError para dirs inacessíveis.
 */
export async function* walkDirs(
  roots: string[],
  ops: WalkOps,
  opts: {
    maxDepth: number;
    onError: (path: string, err: unknown) => void;
    onRootRejected: (raw: string) => void;
    skipRootNormalize?: boolean;
  }
): AsyncGenerator<{ frame: WalkFrame; entry: WalkDirent; fullPath: string }> {
  for (const rawRoot of roots) {
    const root = opts.skipRootNormalize ? rawRoot : normalizePath(rawRoot);
    if (isDeniedRoot(root)) {
      opts.onRootRejected(rawRoot);
      continue;
    }

    const stack: WalkFrame[] = [{ path: root, depth: 0 }];

    while (stack.length > 0) {
      const frame = stack.pop()!;
      let dirents: WalkDirent[];
      try {
        dirents = await ops.readdir(frame.path);
      } catch (err) {
        opts.onError(frame.path, err);
        continue;
      }

      for (const entry of dirents) {
        if (entry.isSymbolicLink) continue;
        const fullPath = joinPath(frame.path, entry.name);
        if (entry.isDirectory) {
          if (shouldSkipDir(entry.name)) continue;
          if (isDeniedRoot(fullPath)) continue;
          if (frame.depth + 1 < opts.maxDepth) {
            stack.push({ path: fullPath, depth: frame.depth + 1 });
          }
          continue;
        }
        yield { frame, entry, fullPath };
      }
    }
  }
}
