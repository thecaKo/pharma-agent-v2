import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WindowsService } from "./types.js";

const execFileAsync = promisify(execFile);

export async function listWindowsServices(): Promise<WindowsService[]> {
  if (process.platform !== "win32") {
    return [];
  }
  try {
    const { stdout } = await execFileAsync("sc", ["query", "type=service", "state=all"], {
      timeout: 8000,
      maxBuffer: 8 * 1024 * 1024
    });
    return parseScQueryOutput(stdout);
  } catch {
    return [];
  }
}

export function parseScQueryOutput(raw: string): WindowsService[] {
  const services: WindowsService[] = [];
  const blocks = raw.split(/\r?\n\s*\r?\n/);
  for (const block of blocks) {
    const nameMatch = /SERVICE_NAME:\s*(.+)$/m.exec(block);
    const stateMatch = /STATE\s*:\s*\d+\s+(\S+)/.exec(block);
    if (!nameMatch || !nameMatch[1]) continue;
    services.push({
      name: nameMatch[1].trim(),
      state: parseState(stateMatch?.[1])
    });
  }
  return services;
}

function parseState(value: string | undefined): WindowsService["state"] {
  switch (value?.toUpperCase()) {
    case "RUNNING":
      return "running";
    case "STOPPED":
      return "stopped";
    default:
      return "unknown";
  }
}
