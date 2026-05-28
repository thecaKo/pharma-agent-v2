import { createConnection } from "node:net";

export interface ProbeNetworkInput {
  host: string;
  port: number;
  timeoutMs: number;
}

export interface ProbeNetworkResult {
  reachable: boolean;
  latencyMs?: number;
  error?: "timeout" | "refused" | "unreachable" | "unknown";
}

export async function probeNetwork(input: ProbeNetworkInput): Promise<ProbeNetworkResult> {
  const start = Date.now();
  try {
    const open = await tcpProbeRaw(input.host, input.port, input.timeoutMs);
    if (open.kind === "open") {
      return { reachable: true, latencyMs: Date.now() - start };
    }
    return { reachable: false, error: open.error };
  } catch {
    return { reachable: false, error: "unknown" };
  }
}

export async function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const result = await tcpProbeRaw(host, port, timeoutMs);
  return result.kind === "open";
}

interface TcpProbeRawResult {
  kind: "open" | "closed";
  error?: ProbeNetworkResult["error"];
}

function tcpProbeRaw(host: string, port: number, timeoutMs: number): Promise<TcpProbeRawResult> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;

    const finish = (result: TcpProbeRawResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => finish({ kind: "closed", error: "timeout" }), timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);
      finish({ kind: "open" });
    });

    socket.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const error =
        err.code === "ECONNREFUSED" ? "refused" :
        err.code === "EHOSTUNREACH" || err.code === "ENETUNREACH" || err.code === "ENOTFOUND" ? "unreachable" :
        "unknown";
      finish({ kind: "closed", error });
    });
  });
}
