import type { DatabaseDriver } from "../config/types.js";
import type { OdbcDsnCandidate } from "./odbc-dsns.js";

/**
 * Candidato parcial extraído de um conteúdo de config. Pode estar incompleto;
 * só vira candidato de conexão válido quando tem driver+host+user (a porta
 * recebe default por driver). A senha permanece local — nunca sai do agente.
 */
export interface ParsedCredential {
  driver?: DatabaseDriver;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
}

const DEFAULT_PORT_BY_DRIVER: Record<DatabaseDriver, number> = {
  mysql: 3306,
  mariadb: 3306,
  postgresql: 5432,
  firebird: 3050,
  sqlserver: 1433
};

// Normaliza nomes/aliases de driver vindos de URLs, ODBC e configs para o
// conjunto suportado pelo adapter-factory.
const DRIVER_ALIASES: Record<string, DatabaseDriver> = {
  mysql: "mysql",
  mysql2: "mysql",
  mariadb: "mariadb",
  postgres: "postgresql",
  postgresql: "postgresql",
  postgre: "postgresql",
  pg: "postgresql",
  psql: "postgresql",
  psqlodbc: "postgresql",
  firebird: "firebird",
  fb: "firebird",
  sqlserver: "sqlserver",
  mssql: "sqlserver",
  sqlsrv: "sqlserver",
  "sql server": "sqlserver"
};

const HOST_KEYS = ["host", "server", "servername", "data source", "datasource", "address", "addr", "db_host", "dbhost"];
const PORT_KEYS = ["port", "db_port", "dbport"];
const USER_KEYS = ["user", "username", "user id", "uid", "db_user", "dbuser", "db_username"];
const PASSWORD_KEYS = ["password", "pwd", "pass", "db_password", "dbpassword", "db_pass"];
const DATABASE_KEYS = ["database", "dbname", "db_name", "db", "initial catalog", "catalog"];
const DRIVER_KEYS = ["driver", "engine", "db_driver", "dbdriver", "dialect", "type", "provider"];

/**
 * Parser best-effort de credenciais. Tenta connection-strings (URL e
 * `key=value;`), ini e key=value plano, retornando todos os candidatos parciais
 * que tenham o mínimo (driver+host+user). Não lança — entradas inúteis → [].
 */
export function parseCredentials(content: string): ParsedCredential[] {
  const results: ParsedCredential[] = [];

  for (const url of extractConnectionUrls(content)) {
    const parsed = parseConnectionUrl(url);
    if (parsed) pushIfComplete(results, parsed);
  }

  const semicolonStyle = parseKeyValuePairs(content, /;/);
  if (semicolonStyle) pushIfComplete(results, semicolonStyle);

  const lineStyle = parseKeyValuePairs(content, /\r?\n/);
  if (lineStyle) pushIfComplete(results, lineStyle);

  return dedupe(results);
}

function normalizeDriver(raw: string | undefined): DatabaseDriver | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^\{|\}$/g, "")
    .replace(/\b(unicode|ansi|odbc|driver)\b/g, "")
    .replace(/[^a-z ]/g, " ")
    .trim();
  if (DRIVER_ALIASES[cleaned]) return DRIVER_ALIASES[cleaned];
  for (const [alias, driver] of Object.entries(DRIVER_ALIASES)) {
    if (cleaned.includes(alias)) return driver;
  }
  return undefined;
}

function withDefaultPort(c: ParsedCredential): ParsedCredential {
  if (c.port === undefined && c.driver) {
    return { ...c, port: DEFAULT_PORT_BY_DRIVER[c.driver] };
  }
  return c;
}

function isComplete(c: ParsedCredential): boolean {
  return Boolean(c.driver && c.host && c.user);
}

function pushIfComplete(target: ParsedCredential[], c: ParsedCredential): void {
  const withPort = withDefaultPort(c);
  if (isComplete(withPort)) target.push(withPort);
}

function extractConnectionUrls(content: string): string[] {
  const re = /\b[a-z][a-z0-9+]*:\/\/[^\s'"]+/gi;
  return content.match(re) ?? [];
}

function parseConnectionUrl(url: string): ParsedCredential | undefined {
  const match = /^([a-z0-9+]+):\/\/(?:([^:@/]+)(?::([^@/]*))?@)?([^:/?#]+)(?::(\d+))?(?:\/([^?#]+))?/i.exec(url);
  if (!match) return undefined;
  const [, scheme, user, password, host, port, database] = match;
  const driver = normalizeDriver(scheme);
  if (!driver) return undefined;
  const out: ParsedCredential = { driver, host };
  if (user) out.user = decodeURIComponent(user);
  if (password) out.password = decodeURIComponent(password);
  if (port) {
    const p = Number.parseInt(port, 10);
    if (Number.isInteger(p) && p >= 1 && p <= 65535) out.port = p;
  }
  if (database) out.database = decodeURIComponent(database.split("/")[0] ?? database);
  return out;
}

function parseKeyValuePairs(content: string, splitter: RegExp): ParsedCredential | undefined {
  const map = new Map<string, string>();
  for (const rawSegment of content.split(splitter)) {
    const segment = rawSegment.trim();
    if (segment.length === 0 || segment.startsWith("#") || segment.startsWith(";") || segment.startsWith("[")) {
      continue;
    }
    const eq = segment.indexOf("=");
    if (eq <= 0) continue;
    const key = segment.slice(0, eq).trim().toLowerCase();
    let value = segment.slice(eq + 1).trim();
    value = value.replace(/^["']|["']$/g, "");
    if (value.length === 0) continue;
    if (!map.has(key)) map.set(key, value);
  }
  if (map.size === 0) return undefined;

  const out: ParsedCredential = {};
  const driver = normalizeDriver(firstMatch(map, DRIVER_KEYS));
  if (driver) out.driver = driver;

  const rawHost = firstMatch(map, HOST_KEYS);
  if (rawHost) {
    // Server=host,port (estilo SQL Server) ou host:port
    const m = /^([^,:]+)(?:[,:](\d+))?$/.exec(rawHost.trim());
    if (m) {
      out.host = m[1]?.trim();
      if (m[2]) {
        const p = Number.parseInt(m[2], 10);
        if (Number.isInteger(p) && p >= 1 && p <= 65535) out.port = p;
      }
    } else {
      out.host = rawHost.trim();
    }
  }

  const rawPort = firstMatch(map, PORT_KEYS);
  if (rawPort && out.port === undefined) {
    const p = Number.parseInt(rawPort.trim(), 10);
    if (Number.isInteger(p) && p >= 1 && p <= 65535) out.port = p;
  }

  const user = firstMatch(map, USER_KEYS);
  if (user) out.user = user;
  const password = firstMatch(map, PASSWORD_KEYS);
  if (password) out.password = password;
  const database = firstMatch(map, DATABASE_KEYS);
  if (database) out.database = database;

  return out;
}

function firstMatch(map: Map<string, string>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = map.get(key);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Converte um DSN ODBC já enumerado em ParsedCredential, normalizando o driver
 * e aplicando porta default. DSNs sem driver mapeável ou sem host viram
 * `undefined` (não viram candidato). DSNs não trazem senha.
 */
export function normalizeOdbcCredential(dsn: OdbcDsnCandidate): ParsedCredential | undefined {
  const driver = normalizeDriver(dsn.driver);
  if (!driver || !dsn.host || !dsn.user) return undefined;
  const out: ParsedCredential = { driver, host: dsn.host, user: dsn.user };
  if (dsn.port !== undefined) out.port = dsn.port;
  if (dsn.database) out.database = dsn.database;
  return withDefaultPort(out);
}

function dedupe(creds: ParsedCredential[]): ParsedCredential[] {
  const seen = new Set<string>();
  const out: ParsedCredential[] = [];
  for (const c of creds) {
    const key = `${c.driver}|${c.host}|${c.port}|${c.user}|${c.database}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
