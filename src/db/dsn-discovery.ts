import type { RegistryReader } from "./registry-reader.js";

export interface PostgresDsnCandidate {
  dsnName: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
}

const ODBC_INI_INDEXES = [
  "HKLM\\Software\\ODBC\\ODBC.INI\\ODBC Data Sources",
  "HKCU\\Software\\ODBC\\ODBC.INI\\ODBC Data Sources"
] as const;

const ODBC_INI_PARENTS = [
  "HKLM\\Software\\ODBC\\ODBC.INI",
  "HKCU\\Software\\ODBC\\ODBC.INI"
] as const;

export async function discoverPostgresDsns(reader: RegistryReader): Promise<PostgresDsnCandidate[]> {
  try {
    const seen = new Set<string>();
    const result: PostgresDsnCandidate[] = [];

    for (let i = 0; i < ODBC_INI_INDEXES.length; i += 1) {
      const indexPath = ODBC_INI_INDEXES[i];
      const parentPath = ODBC_INI_PARENTS[i];
      if (!indexPath || !parentPath) {
        continue;
      }
      let index: Record<string, string> = {};
      try {
        index = await reader.readKey(indexPath);
      } catch {
        index = {};
      }

      for (const [dsnName, driverDescription] of Object.entries(index)) {
        if (seen.has(dsnName)) {
          continue;
        }
        let values: Record<string, string> = {};
        try {
          values = await reader.readKey(`${parentPath}\\${dsnName}`);
        } catch {
          values = {};
        }

        if (!isPsqlodbc(values.Driver) && !isPsqlodbc(driverDescription)) {
          continue;
        }

        seen.add(dsnName);
        result.push(buildCandidate(dsnName, values));
      }
    }

    return result;
  } catch {
    return [];
  }
}

function isPsqlodbc(value: string | undefined): boolean {
  return typeof value === "string" && value.toLowerCase().includes("psqlodbc");
}

function buildCandidate(dsnName: string, values: Record<string, string>): PostgresDsnCandidate {
  const candidate: PostgresDsnCandidate = { dsnName };

  const host = values.Servername?.trim();
  if (host) candidate.host = host;

  const port = parsePort(values.Port);
  if (port !== undefined) candidate.port = port;

  const database = values.Database?.trim();
  if (database) candidate.database = database;

  const user = values.Username?.trim();
  if (user) candidate.user = user;

  return candidate;
}

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    return undefined;
  }
  return parsed;
}
