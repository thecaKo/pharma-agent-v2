import type { ProbeContext } from "./types.js";

export type EngineKind = "sqlserver" | "postgresql" | "mysql" | "mariadb" | "firebird";

export type Confidence = "high" | "medium" | "low";

export interface EngineCandidate {
  kind: EngineKind;
  confidence: Confidence;
  evidence: string[];
}

interface EngineFingerprint {
  kind: EngineKind;
  servicePatterns: RegExp[];
  ports: number[];
  dllPaths: string[];
}

const FINGERPRINTS: EngineFingerprint[] = [
  {
    kind: "sqlserver",
    servicePatterns: [/^MSSQLSERVER$/i, /^MSSQL\$.+$/i, /^SQLBrowser$/i],
    ports: [1433],
    dllPaths: [
      "C:\\Program Files\\Microsoft SQL Server",
      "C:\\Windows\\System32\\sqlncli11.dll",
      "C:\\Windows\\System32\\msodbcsql17.dll",
      "C:\\Windows\\System32\\msodbcsql18.dll"
    ]
  },
  {
    kind: "postgresql",
    servicePatterns: [/^postgresql-x64-\d+$/i, /^postgresql-\d+$/i],
    ports: [5432],
    dllPaths: ["C:\\Windows\\System32\\libpq.dll"]
  },
  {
    kind: "mysql",
    servicePatterns: [/^MySQL/i],
    ports: [3306],
    dllPaths: []
  },
  {
    kind: "mariadb",
    servicePatterns: [/^MariaDB/i],
    ports: [3306],
    dllPaths: []
  },
  {
    kind: "firebird",
    servicePatterns: [/^FirebirdServer/i, /^FirebirdGuardian/i],
    ports: [3050],
    dllPaths: [
      "C:\\Windows\\System32\\gds32.dll",
      "C:\\Windows\\System32\\fbclient.dll"
    ]
  }
];

export interface ProbeEnginesOptions {
  tcpProbe: (host: string, port: number, timeoutMs?: number) => Promise<boolean>;
}

export async function probeEngines(
  ctx: ProbeContext,
  options: ProbeEnginesOptions
): Promise<EngineCandidate[]> {
  const services = await safeListServices(ctx);

  const candidates: EngineCandidate[] = [];
  for (const fp of FINGERPRINTS) {
    const evidence: string[] = [];

    for (const service of services) {
      if (fp.servicePatterns.some((pattern) => pattern.test(service.name))) {
        evidence.push(`service:${service.name}`);
      }
    }

    for (const port of fp.ports) {
      if (ctx.signal.aborted) break;
      const open = await safeTcpProbe(options.tcpProbe, "127.0.0.1", port, 800);
      if (open) evidence.push(`port:${port}`);
    }

    for (const dll of fp.dllPaths) {
      if (ctx.signal.aborted) break;
      const stat = await ctx.fs.stat(dll);
      if (stat?.isFile) evidence.push(`dll:${dll}`);
    }

    if (evidence.length > 0) {
      candidates.push({ kind: fp.kind, evidence, confidence: scoreConfidence(evidence) });
    }
  }

  return candidates;
}

function scoreConfidence(evidence: string[]): Confidence {
  const categories = new Set(evidence.map((e) => e.split(":")[0]));
  if (categories.size >= 3) return "high";
  if (categories.size === 2) return "medium";
  return "low";
}

async function safeListServices(ctx: ProbeContext) {
  try {
    return await ctx.serviceList();
  } catch {
    return [];
  }
}

async function safeTcpProbe(
  probe: ProbeEnginesOptions["tcpProbe"],
  host: string,
  port: number,
  timeoutMs: number
): Promise<boolean> {
  try {
    return await probe(host, port, timeoutMs);
  } catch {
    return false;
  }
}
