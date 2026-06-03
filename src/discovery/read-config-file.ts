import type { FileSystemReader } from "./fs-reader.js";
import { DEFAULT_PATTERNS } from "./scan-config-dirs.js";

export const MAX_CONFIG_FILE_BYTES = 512 * 1024;

const DENY_PATH_REGEXES: RegExp[] = [
  /^[A-Z]:\\Windows(\\|$)/i,
  /^[A-Z]:\\\$Recycle\.Bin/i,
  /^\/etc(\/|$)/,
  /^\/usr(\/|$)/,
  /^\/proc(\/|$)/,
  /^\/sys(\/|$)/
];

export interface ReadConfigFileInput {
  path: string;
}

export interface ReadConfigFileContext {
  fs: FileSystemReader;
  patterns?: readonly string[];
}

export type ReadConfigFileResult =
  | { ok: true; path: string; content: string }
  | { ok: false; errorCode: "INVALID_INPUT" | "unreachable" | "unknown"; message: string };

export async function readConfigFile(
  ctx: ReadConfigFileContext,
  input: ReadConfigFileInput
): Promise<ReadConfigFileResult> {
  const rawPath = input.path.trim();
  if (rawPath.length === 0) {
    return { ok: false, errorCode: "INVALID_INPUT", message: "path é obrigatório" };
  }
  if (hasTraversalSegment(rawPath)) {
    return { ok: false, errorCode: "INVALID_INPUT", message: "path com traversal (..) não permitido" };
  }
  const path = normalizePath(rawPath);
  if (DENY_PATH_REGEXES.some((re) => re.test(path))) {
    return { ok: false, errorCode: "INVALID_INPUT", message: "path sob diretório negado" };
  }
  const fileName = path.split(/[\\/]/u).pop() ?? "";
  const patterns = ctx.patterns ?? DEFAULT_PATTERNS;
  if (!patterns.some((p) => globMatch(fileName, p))) {
    return { ok: false, errorCode: "INVALID_INPUT", message: "extensão de arquivo não permitida" };
  }

  let content: string;
  try {
    content = await ctx.fs.readFile(path, "utf8");
  } catch (err) {
    return { ok: false, errorCode: "unreachable", message: mapReadError(err) };
  }

  if (Buffer.byteLength(content, "utf8") > MAX_CONFIG_FILE_BYTES) {
    return { ok: false, errorCode: "INVALID_INPUT", message: "arquivo excede o limite de tamanho" };
  }
  return { ok: true, path, content };
}

function hasTraversalSegment(rawPath: string): boolean {
  return rawPath.split(/[\\/]/u).some((segment) => segment === "..");
}

// Normaliza separadores redundantes e segmentos "." preservando o estilo
// (Windows com "\" vs POSIX com "/") para que a deny-list seja aplicada sobre
// o path resolvido — segmentos ".." já foram rejeitados antes desta etapa.
function normalizePath(rawPath: string): string {
  const isWindows = /^[A-Za-z]:[\\/]/u.test(rawPath) || rawPath.includes("\\");
  const sep = isWindows ? "\\" : "/";
  const parts = rawPath.split(/[\\/]/u);
  const out: string[] = [];
  for (let idx = 0; idx < parts.length; idx += 1) {
    const part = parts[idx];
    if (part === ".") continue;
    if (part === "" && idx !== 0 && idx !== parts.length - 1) continue;
    out.push(part ?? "");
  }
  return out.join(sep);
}

function globMatch(name: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(name);
}

function mapReadError(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    const code = String((err as { code?: unknown }).code);
    if (code === "EACCES" || code === "EPERM") return "permissão negada";
    if (code === "ENOENT") return "arquivo não encontrado";
  }
  return "falha ao ler arquivo";
}
