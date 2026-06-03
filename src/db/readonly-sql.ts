export class ReadOnlySqlError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ReadOnlySqlError";
  }
}

export interface ValidateReadOnlySelectOptions {
  maxLimit: number;
}

export type ValidateReadOnlySelectResult =
  | { ok: true; sql: string }
  | { ok: false; error: string };

export const MAX_SQL_BYTES = 100 * 1024;

const FORBIDDEN_KEYWORDS = [
  "insert", "update", "delete", "merge", "upsert", "replace",
  "create", "alter", "drop", "truncate", "rename",
  "grant", "revoke", "commit", "rollback", "savepoint",
  "call", "exec", "execute", "do", "set", "into"
];

export function validateReadOnlySelect(
  rawSql: string,
  options: ValidateReadOnlySelectOptions
): ValidateReadOnlySelectResult {
  if (Buffer.byteLength(rawSql, "utf8") > MAX_SQL_BYTES) {
    return { ok: false, error: "SQL excede o tamanho máximo permitido" };
  }

  const stripped = stripComments(rawSql);
  if (stripped.unterminated) {
    return { ok: false, error: "comentário de bloco não terminado" };
  }
  const trimmed = stripped.text.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "SQL vazio após remover comentários" };
  }

  const withoutTrailingSemicolon = trimmed.replace(/;+\s*$/u, "");
  if (withoutTrailingSemicolon.includes(";")) {
    return { ok: false, error: "multi-statement não permitido" };
  }

  const lower = withoutTrailingSemicolon.toLowerCase();
  if (!/^(select|with)\b/u.test(lower)) {
    return { ok: false, error: "somente SELECT ou CTE de leitura é permitido" };
  }

  const tokens = lower.match(/[a-z_][a-z0-9_]*/gu) ?? [];
  const literalRanges = literalSpans(withoutTrailingSemicolon);
  for (const keyword of FORBIDDEN_KEYWORDS) {
    if (tokenOutsideLiteral(withoutTrailingSemicolon, keyword, literalRanges)) {
      return { ok: false, error: `palavra-chave de escrita não permitida: ${keyword}` };
    }
  }
  void tokens;

  const limited = applyLimit(withoutTrailingSemicolon, options.maxLimit);
  return { ok: true, sql: limited };
}

function stripComments(sql: string): { text: string; unterminated: boolean } {
  let result = "";
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (inSingle) {
      result += ch;
      if (ch === "'") inSingle = false;
      i += 1;
      continue;
    }
    if (inDouble) {
      result += ch;
      if (ch === '"') inDouble = false;
      i += 1;
      continue;
    }
    if (ch === "'") { inSingle = true; result += ch; i += 1; continue; }
    if (ch === '"') { inDouble = true; result += ch; i += 1; continue; }
    if (ch === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      result += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      if (i >= sql.length) {
        return { text: result, unterminated: true };
      }
      i += 2;
      result += " ";
      continue;
    }
    result += ch;
    i += 1;
  }
  return { text: result, unterminated: false };
}

function literalSpans(sql: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = i;
      i += 1;
      while (i < sql.length && sql[i] !== quote) i += 1;
      spans.push([start, i]);
    }
    i += 1;
  }
  return spans;
}

function tokenOutsideLiteral(sql: string, keyword: string, literals: Array<[number, number]>): boolean {
  const re = new RegExp(`\\b${keyword}\\b`, "giu");
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
    const idx = match.index;
    const inside = literals.some(([s, e]) => idx >= s && idx <= e);
    if (!inside) return true;
  }
  return false;
}

function applyLimit(sql: string, maxLimit: number): string {
  const re = /\blimit\s+(\d+)\s*$/iu;
  const match = re.exec(sql);
  if (match) {
    const current = Number.parseInt(match[1] ?? "0", 10);
    const capped = Math.min(current, maxLimit);
    return sql.replace(re, `limit ${capped}`);
  }
  return `${sql.trim()} limit ${maxLimit}`;
}
