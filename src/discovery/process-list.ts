import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WindowsProcess } from "./types.js";

const execFileAsync = promisify(execFile);

const SYSTEM_PROCESS_DENY = new Set([
  "system",
  "idle",
  "registry",
  "csrss.exe",
  "lsass.exe",
  "services.exe",
  "winlogon.exe",
  "wininit.exe"
]);

export async function listWindowsProcesses(): Promise<WindowsProcess[]> {
  if (process.platform !== "win32") {
    return [];
  }
  try {
    const { stdout } = await execFileAsync(
      "wmic",
      ["process", "get", "ProcessId,Name,ExecutablePath", "/format:csv"],
      { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }
    );
    return filterSystem(parseWmicProcessOutput(stdout));
  } catch {
    // WMIC may be missing on newer Windows — fallback to PowerShell
    try {
      const { stdout } = await execFileAsync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath | ConvertTo-Csv -NoTypeInformation"
        ],
        { timeout: 12000, maxBuffer: 8 * 1024 * 1024 }
      );
      return filterSystem(parsePowershellProcessOutput(stdout));
    } catch {
      return [];
    }
  }
}

export function parseWmicProcessOutput(raw: string): WindowsProcess[] {
  return parseCsvProcesses(raw);
}

export function parsePowershellProcessOutput(raw: string): WindowsProcess[] {
  return parseCsvProcesses(raw);
}

function parseCsvProcesses(raw: string): WindowsProcess[] {
  const lines = raw.replace(/﻿/g, "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const headerLine = lines[0];
  if (!headerLine) return [];

  const headers = parseCsvLine(headerLine).map((h) => h.toLowerCase());
  const idxName = headers.indexOf("name");
  const idxPid = headers.indexOf("processid");
  const idxPath = headers.indexOf("executablepath");
  if (idxName < 0 || idxPid < 0) return [];

  const out: WindowsProcess[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i] ?? "");
    if (cols.length < headers.length) continue;
    const name = (cols[idxName] ?? "").trim();
    const pidStr = (cols[idxPid] ?? "").trim();
    const pid = Number.parseInt(pidStr, 10);
    if (!name || !Number.isFinite(pid)) continue;
    const pathValue = idxPath >= 0 ? (cols[idxPath] ?? "").trim() : "";
    const entry: WindowsProcess = { pid, name };
    if (pathValue) entry.path = pathValue;
    out.push(entry);
  }
  return out;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; continue; }
      if (ch === '"') { inQuote = false; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"') { inQuote = true; continue; }
    if (ch === ",") { cells.push(cur); cur = ""; continue; }
    cur += ch;
  }
  cells.push(cur);
  return cells;
}

function filterSystem(procs: WindowsProcess[]): WindowsProcess[] {
  return procs.filter((p) => !SYSTEM_PROCESS_DENY.has(p.name.toLowerCase()));
}
