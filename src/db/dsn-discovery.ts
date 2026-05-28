import type { RegistryReader } from "./registry-reader.js";
import { probeOdbcDsns, type OdbcDsnCandidate } from "../discovery/odbc-dsns.js";

export interface PostgresDsnCandidate {
  dsnName: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
}

export async function discoverPostgresDsns(reader: RegistryReader): Promise<PostgresDsnCandidate[]> {
  const all = await probeOdbcDsns(reader);
  return all.filter(isPsqlodbc).map(toPostgresCandidate);
}

function isPsqlodbc(candidate: OdbcDsnCandidate): boolean {
  return candidate.driver.toLowerCase().includes("psqlodbc");
}

function toPostgresCandidate(candidate: OdbcDsnCandidate): PostgresDsnCandidate {
  const out: PostgresDsnCandidate = { dsnName: candidate.name };
  if (candidate.host) out.host = candidate.host;
  if (candidate.port) out.port = candidate.port;
  if (candidate.database) out.database = candidate.database;
  if (candidate.user) out.user = candidate.user;
  return out;
}
