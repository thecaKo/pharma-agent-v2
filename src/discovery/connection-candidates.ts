import type { DatabaseConfig } from "../config/types.js";
import { parseCredentials, normalizeOdbcCredential, type ParsedCredential } from "./credential-parser.js";
import type { OdbcDsnCandidate } from "./odbc-dsns.js";
import type { ScanConfigDirsInput, ScanConfigDirsResult } from "./scan-config-dirs.js";
import type { ReadConfigFileResult } from "./read-config-file.js";

/**
 * Descritor REDIGIDO de uma conexão candidata. É o único formato que cruza para
 * neo/web — NUNCA contém senha. Contrato fixo (neo/web dependem).
 */
export interface IConnectionCandidate {
  handle: string;
  driver: string;
  host?: string;
  port?: number;
  user?: string;
  database?: string;
  source: string;
  label: string;
}

/**
 * Candidato com a config COMPLETA (com senha) mantida localmente no agente, mais
 * o descritor redigido. O `config` é um DatabaseConfig pronto para
 * createSourceDatabaseAdapter; nunca é serializado para fora do agente.
 */
export interface DiscoveredConnection {
  handle: string;
  config: DatabaseConfig;
  descriptor: IConnectionCandidate;
}

export interface ConnectionCandidatesDeps {
  scanConfigDirs: (input: ScanConfigDirsInput) => Promise<ScanConfigDirsResult>;
  readConfigFile: (input: { path: string }) => Promise<ReadConfigFileResult>;
  probeOdbcDsns: () => Promise<OdbcDsnCandidate[]>;
  platform?: NodeJS.Platform;
}

// Roots comuns por SO onde costumam viver configs de aplicação/banco. Usa env
// vars expandidas por probeScanConfigDirs (ex.: %PROGRAMFILES%, %APPDATA%).
const WINDOWS_ROOTS = [
  "%PROGRAMDATA%",
  "%PROGRAMFILES%",
  "%PROGRAMFILES(X86)%",
  "%APPDATA%",
  "%LOCALAPPDATA%",
  "C:\\inetpub"
];

const POSIX_ROOTS = [
  "/opt",
  "/srv",
  "/var/www",
  "%HOME%/.config"
];

function defaultRootsFor(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? WINDOWS_ROOTS : POSIX_ROOTS;
}

export async function discoverConnectionCandidates(
  deps: ConnectionCandidatesDeps
): Promise<DiscoveredConnection[]> {
  const platform = deps.platform ?? process.platform;
  const out: DiscoveredConnection[] = [];
  let index = 0;

  const push = (parsed: ParsedCredential, source: string): void => {
    const config = toDatabaseConfig(parsed);
    if (!config) return;
    const handle = `conn-${index}`;
    index += 1;
    out.push({ handle, config, descriptor: buildDescriptor(handle, config, source) });
  };

  // 1) Arquivos de config: scan → read → parse.
  let scan: ScanConfigDirsResult;
  try {
    scan = await deps.scanConfigDirs({ roots: defaultRootsFor(platform) });
  } catch {
    scan = { files: [], truncated: false, rootsRejected: [], errors: [] };
  }
  for (const file of scan.files) {
    let read: ReadConfigFileResult;
    try {
      read = await deps.readConfigFile({ path: file.path });
    } catch {
      continue;
    }
    if (!read.ok) continue;
    for (const parsed of parseCredentials(read.content)) {
      push(parsed, `config:${read.path}`);
    }
  }

  // 2) DSNs ODBC (já trazem host/db/user).
  let dsns: OdbcDsnCandidate[];
  try {
    dsns = await deps.probeOdbcDsns();
  } catch {
    dsns = [];
  }
  for (const dsn of dsns) {
    const parsed = normalizeOdbcCredential(dsn);
    if (parsed) push(parsed, `odbc:${dsn.name}`);
  }

  return out;
}

function toDatabaseConfig(parsed: ParsedCredential): DatabaseConfig | undefined {
  if (!parsed.driver || !parsed.host || !parsed.user || parsed.port === undefined) {
    return undefined;
  }
  return {
    driver: parsed.driver,
    host: parsed.host,
    port: parsed.port,
    name: parsed.database ?? "",
    user: parsed.user,
    password: parsed.password ?? ""
  };
}

function buildDescriptor(
  handle: string,
  config: DatabaseConfig,
  source: string
): IConnectionCandidate {
  const descriptor: IConnectionCandidate = {
    handle,
    driver: config.driver,
    source,
    label: buildLabel(config, source)
  };
  if (config.host) descriptor.host = config.host;
  if (config.port !== undefined) descriptor.port = config.port;
  if (config.user) descriptor.user = config.user;
  if (config.name) descriptor.database = config.name;
  return descriptor;
}

function buildLabel(config: DatabaseConfig, source: string): string {
  const hostPart = config.port !== undefined ? `${config.host}:${config.port}` : config.host;
  const userPart = config.user ? ` (${config.user})` : "";
  return `${config.driver} @ ${hostPart}${userPart} — ${source}`;
}
