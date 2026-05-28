import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WindowsConnection } from "./types.js";

const execFileAsync = promisify(execFile);

export async function listWindowsConnections(): Promise<WindowsConnection[]> {
  if (process.platform !== "win32") return [];
  try {
    const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "TCP"], {
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024
    });
    return parseNetstatOutput(stdout);
  } catch {
    return [];
  }
}

export function parseNetstatOutput(raw: string): WindowsConnection[] {
  const out: WindowsConnection[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.toUpperCase().startsWith("TCP")) continue;
    const parts = line.split(/\s+/);
    // Format: TCP <local> <remote> <state> <pid>
    if (parts.length < 5) continue;
    const local = parts[1];
    const remote = parts[2];
    const state = parts[3];
    const pidStr = parts[4];
    if (!local || !remote || state !== "ESTABLISHED" || !pidStr) continue;
    const localParts = splitAddrPort(local);
    const remoteParts = splitAddrPort(remote);
    if (!localParts || !remoteParts) continue;
    const pid = Number.parseInt(pidStr, 10);
    if (!Number.isFinite(pid)) continue;
    out.push({
      pid,
      localAddr: localParts.addr,
      localPort: localParts.port,
      remoteAddr: remoteParts.addr,
      remotePort: remoteParts.port,
      state
    });
  }
  return out;
}

function splitAddrPort(value: string): { addr: string; port: number } | undefined {
  // IPv6: [::1]:1433 → addr "::1", port 1433
  if (value.startsWith("[")) {
    const closeBracket = value.indexOf("]");
    if (closeBracket < 0) return undefined;
    const addr = value.slice(1, closeBracket);
    const portPart = value.slice(closeBracket + 2); // skip "]:"
    const port = Number.parseInt(portPart, 10);
    if (!Number.isFinite(port)) return undefined;
    return { addr, port };
  }
  const lastColon = value.lastIndexOf(":");
  if (lastColon < 0) return undefined;
  const addr = value.slice(0, lastColon);
  const port = Number.parseInt(value.slice(lastColon + 1), 10);
  if (!Number.isFinite(port)) return undefined;
  return { addr, port };
}
