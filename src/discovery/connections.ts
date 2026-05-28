import type { ProbeContext, WindowsConnection } from "./types.js";

export const DB_PORTS: ReadonlySet<number> = new Set([
  1433, 5432, 3306, 3050, 1521, 1583, 50000, 27017
]);

export interface ConnectionCandidate extends WindowsConnection {
  processName?: string;
}

export async function probeConnections(ctx: ProbeContext): Promise<ConnectionCandidate[]> {
  let raw: WindowsConnection[];
  try {
    raw = await ctx.listConnections();
  } catch {
    return [];
  }

  const dbOnly = raw.filter((c) => DB_PORTS.has(c.remotePort) || DB_PORTS.has(c.localPort));
  if (dbOnly.length === 0) return [];

  let procByPid: Map<number, string> = new Map();
  try {
    const procs = await ctx.listProcesses();
    procByPid = new Map(procs.map((p) => [p.pid, p.name]));
  } catch {
    procByPid = new Map();
  }

  return dbOnly.map((c) => {
    const name = procByPid.get(c.pid);
    return name ? { ...c, processName: name } : { ...c };
  });
}
