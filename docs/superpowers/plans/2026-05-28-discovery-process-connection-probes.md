# Discovery: probes de processo, conexão e scan de configs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar três probes novos ao admin-router: `probe.processes`, `probe.connections`, `probe.scan_config_dirs`. Permitem ao painel identificar o ERP em uso observando processos rodando, conexões TCP em portas de banco, e arquivos de config em diretórios prioritários.

**Architecture:** Três módulos novos em `src/discovery/` seguindo o padrão dos probes existentes. `ProbeContext` ganha dois hooks injetáveis (`listProcesses`, `listConnections`). `FileSystemReader` ganha `enumerateTop` para scan eficiente single-level. `AdminCommand` ganha 3 valores. `admin-router` ganha 3 cases. Runtime registra as 3 funções no `buildAdminRouterDeps()` com wrap de `bootstrapState`.

**Tech Stack:** TypeScript (ESM), vitest, sem deps novas. Usa `node:child_process` para WMIC/PowerShell/netstat, `node:fs/promises` para enumeração.

**Spec:** `docs/superpowers/specs/2026-05-28-discovery-process-connection-probes-design.md`.

**Depende de:** Fases 1-3 já implementadas (commit `34bf885` ou posterior em `main`).

---

## File Structure

**Novos arquivos:**
- `src/discovery/process-list.ts` — `listWindowsProcesses()` default + `parseWmicProcessOutput(raw)` parser puro
- `src/discovery/processes.ts` — `probeProcesses(ctx)` + `ProcessCandidate` type
- `src/discovery/connection-list.ts` — `listWindowsConnections()` default + `parseNetstatOutput(raw)` parser puro
- `src/discovery/connections.ts` — `probeConnections(ctx)` + `ConnectionCandidate` type + `DB_PORTS` set
- `src/discovery/scan-config-dirs.ts` — `probeScanConfigDirs(ctx, input)` + tipos + deny-list + algoritmo
- `tests/discovery/process-list.test.ts`
- `tests/discovery/processes.test.ts`
- `tests/discovery/connection-list.test.ts`
- `tests/discovery/connections.test.ts`
- `tests/discovery/scan-config-dirs.test.ts`
- `docs/superpowers/specs/smokes/2026-05-28-discovery-process-connection-smoke.md`

**Modificados:**
- `src/discovery/types.ts` — adiciona `WindowsProcess`, `WindowsConnection`, estende `ProbeContext` com `listProcesses` e `listConnections`
- `src/discovery/fs-reader.ts` — adiciona `FsEntry`, estende `FileSystemReader` com `enumerateTop`, implementa em `nodeFileSystemReader`
- `src/transport/protocol.ts` — estende `AdminCommand` union e `ADMIN_COMMANDS` set
- `src/discovery/admin-router.ts` — estende `AdminRouterDependencies`, 3 cases novos, `validateScanConfigDirsInput`
- `src/service/runtime.ts` — `buildAdminRouterDeps()` wira as 3 funções com `wrapProbe`; importa `listWindowsProcesses`, `listWindowsConnections`
- `tests/discovery/admin-router.test.ts` — casos para os 3 comandos novos
- `tests/discovery/engines.test.ts` — atualizar `makeContext` (adicionar `listProcesses`/`listConnections`)
- `tests/discovery/erp-fingerprint.test.ts` (se existir) — mesma atualização do makeContext
- `README.md` — seção breve listando os probes

---

## Task 1: Estender `ProbeContext` e `FileSystemReader`

**Files:**
- Modify: `src/discovery/types.ts`
- Modify: `src/discovery/fs-reader.ts`

- [ ] **Step 1.1: Estender `src/discovery/types.ts`**

Replace the file content with:

```ts
import type { RegistryReader } from "../db/registry-reader.js";
import type { FileSystemReader } from "./fs-reader.js";

export interface WindowsService {
  name: string;
  state: "running" | "stopped" | "unknown";
}

export interface WindowsProcess {
  pid: number;
  name: string;
  path?: string;
}

export interface WindowsConnection {
  pid: number;
  localAddr: string;
  localPort: number;
  remoteAddr: string;
  remotePort: number;
  state: string;
}

export interface ProbeContext {
  registry: RegistryReader;
  fs: FileSystemReader;
  serviceList: () => Promise<WindowsService[]>;
  listProcesses: () => Promise<WindowsProcess[]>;
  listConnections: () => Promise<WindowsConnection[]>;
  signal: AbortSignal;
}

export type ProbeErrorCode =
  | "auth"
  | "timeout"
  | "tls"
  | "unreachable"
  | "driver_missing"
  | "unknown";
```

- [ ] **Step 1.2: Estender `src/discovery/fs-reader.ts` com `enumerateTop`**

Replace the file content with:

```ts
import { promises as fs } from "node:fs";
import { join } from "node:path";

export interface FsStat {
  isFile: boolean;
  isDirectory: boolean;
}

export interface FsEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  size?: number;
  mtime?: Date;
}

export interface FileSystemReader {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  listDir(path: string): Promise<string[]>;
  stat(path: string): Promise<FsStat | undefined>;
  enumerateTop(path: string): Promise<FsEntry[]>;
}

export const nodeFileSystemReader: FileSystemReader = {
  async readFile(path, encoding) {
    return fs.readFile(path, { encoding });
  },
  async listDir(path) {
    try {
      return await fs.readdir(path);
    } catch {
      return [];
    }
  },
  async stat(path) {
    try {
      const s = await fs.stat(path);
      return { isFile: s.isFile(), isDirectory: s.isDirectory() };
    } catch {
      return undefined;
    }
  },
  async enumerateTop(path) {
    const dirents = await fs.readdir(path, { withFileTypes: true });
    const entries: FsEntry[] = [];
    for (const dirent of dirents) {
      const full = join(path, dirent.name);
      let size: number | undefined;
      let mtime: Date | undefined;
      try {
        const s = await fs.stat(full);
        size = s.size;
        mtime = s.mtime;
      } catch {
        // ignore stat errors per entry; still emit dirent
      }
      entries.push({
        name: dirent.name,
        isFile: dirent.isFile(),
        isDirectory: dirent.isDirectory(),
        size,
        mtime
      });
    }
    return entries;
  }
};
```

- [ ] **Step 1.3: Verificar build TS — deve falhar nos consumidores existentes que constroem `ProbeContext` em testes**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: TS errors em `tests/discovery/engines.test.ts` e qualquer outro teste que monta `ProbeContext` (não tem `listProcesses`/`listConnections`).

- [ ] **Step 1.4: Atualizar `tests/discovery/engines.test.ts`**

Localizar o helper `makeContext` (linhas ~7-22). Adicionar dois campos no objeto retornado:

```ts
function makeContext(overrides: Partial<ProbeContext> = {}): ProbeContext {
  const defaultFs: FileSystemReader = {
    readFile: vi.fn(async () => ""),
    listDir: vi.fn(async () => []),
    stat: vi.fn(async () => undefined),
    enumerateTop: vi.fn(async () => [])
  };
  return {
    registry: { readKey: vi.fn(async () => ({})) } as never,
    fs: defaultFs,
    serviceList: vi.fn(async () => []),
    listProcesses: vi.fn(async () => []),
    listConnections: vi.fn(async () => []),
    signal: new AbortController().signal,
    ...overrides
  };
}
```

- [ ] **Step 1.5: Verificar build TS**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: zero erros novos. Se algum outro teste constrói `ProbeContext`, atualizar com a mesma assinatura.

- [ ] **Step 1.6: Rodar suite**

Run: `npm test`
Expected: 0 falhas.

- [ ] **Step 1.7: Commit**

```bash
git add src/discovery/types.ts src/discovery/fs-reader.ts tests/discovery/engines.test.ts
git commit -m "feat(discovery): ProbeContext aceita listProcesses/listConnections e enumerateTop"
```

---

## Task 2: `process-list.ts` — parser puro + default

**Files:**
- Create: `src/discovery/process-list.ts`
- Create: `tests/discovery/process-list.test.ts`

- [ ] **Step 2.1: Escrever testes do parser puro**

Create `tests/discovery/process-list.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseWmicProcessOutput } from "../../src/discovery/process-list.js";

describe("parseWmicProcessOutput", () => {
  it("parses standard WMIC CSV output", () => {
    const raw = `Node,ExecutablePath,Name,ProcessId
HOST,C:\\Linx\\bin\\Big.exe,Big.exe,4128
HOST,C:\\Windows\\System32\\svchost.exe,svchost.exe,1024
`.trim();
    expect(parseWmicProcessOutput(raw)).toEqual([
      { pid: 4128, name: "Big.exe", path: "C:\\Linx\\bin\\Big.exe" },
      { pid: 1024, name: "svchost.exe", path: "C:\\Windows\\System32\\svchost.exe" }
    ]);
  });

  it("returns empty for empty input", () => {
    expect(parseWmicProcessOutput("")).toEqual([]);
  });

  it("handles entries with missing ExecutablePath (some system procs)", () => {
    const raw = `Node,ExecutablePath,Name,ProcessId
HOST,,System,4
HOST,C:\\Windows\\explorer.exe,explorer.exe,2048
`.trim();
    expect(parseWmicProcessOutput(raw)).toEqual([
      { pid: 4, name: "System" },
      { pid: 2048, name: "explorer.exe", path: "C:\\Windows\\explorer.exe" }
    ]);
  });

  it("ignores malformed lines", () => {
    const raw = `Node,ExecutablePath,Name,ProcessId
malformed
HOST,C:\\App\\app.exe,app.exe,123
not,enough,cols
`.trim();
    expect(parseWmicProcessOutput(raw)).toEqual([
      { pid: 123, name: "app.exe", path: "C:\\App\\app.exe" }
    ]);
  });

  it("trims whitespace and handles BOM", () => {
    const raw = "﻿Node,ExecutablePath,Name,ProcessId\r\nHOST,  C:\\X\\y.exe  ,  y.exe  ,  55  ";
    expect(parseWmicProcessOutput(raw)).toEqual([
      { pid: 55, name: "y.exe", path: "C:\\X\\y.exe" }
    ]);
  });
});
```

- [ ] **Step 2.2: Rodar — devem falhar (Cannot find module)**

Run: `npx vitest run tests/discovery/process-list.test.ts`
Expected: FAIL — `Cannot find module '../../src/discovery/process-list.js'`.

- [ ] **Step 2.3: Criar `src/discovery/process-list.ts`**

Create `src/discovery/process-list.ts`:

```ts
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
  return parseCsvProcesses(raw, { wmicLayout: true });
}

export function parsePowershellProcessOutput(raw: string): WindowsProcess[] {
  return parseCsvProcesses(raw, { wmicLayout: false });
}

function parseCsvProcesses(raw: string, opts: { wmicLayout: boolean }): WindowsProcess[] {
  const lines = raw.replace(/﻿/g, "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const headerLine = lines[0];
  if (!headerLine) return [];

  const headers = parseCsvLine(headerLine).map((h) => h.toLowerCase());
  const idxName = headers.indexOf("name");
  const idxPid = headers.indexOf("processid");
  const idxPath = headers.indexOf("executablepath");
  if (idxName < 0 || idxPid < 0) return [];
  void opts;

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
```

- [ ] **Step 2.4: Rodar — devem passar**

Run: `npx vitest run tests/discovery/process-list.test.ts`
Expected: PASS.

- [ ] **Step 2.5: Commit**

```bash
git add src/discovery/process-list.ts tests/discovery/process-list.test.ts
git commit -m "feat(discovery): listWindowsProcesses via WMIC com fallback PowerShell"
```

---

## Task 3: `probeProcesses`

**Files:**
- Create: `src/discovery/processes.ts`
- Create: `tests/discovery/processes.test.ts`

- [ ] **Step 3.1: Escrever testes**

Create `tests/discovery/processes.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { probeProcesses } from "../../src/discovery/processes.js";
import type { ProbeContext } from "../../src/discovery/types.js";

function makeContext(overrides: Partial<ProbeContext> = {}): ProbeContext {
  return {
    registry: { readKey: vi.fn(async () => ({})) } as never,
    fs: {
      readFile: vi.fn(async () => ""),
      listDir: vi.fn(async () => []),
      stat: vi.fn(async () => undefined),
      enumerateTop: vi.fn(async () => [])
    },
    serviceList: vi.fn(async () => []),
    listProcesses: vi.fn(async () => []),
    listConnections: vi.fn(async () => []),
    signal: new AbortController().signal,
    ...overrides
  };
}

describe("probeProcesses", () => {
  it("returns processes provided by listProcesses", async () => {
    const ctx = makeContext({
      listProcesses: vi.fn(async () => [
        { pid: 4128, name: "Big.exe", path: "C:\\Linx\\bin\\Big.exe" }
      ])
    });
    await expect(probeProcesses(ctx)).resolves.toEqual([
      { pid: 4128, name: "Big.exe", path: "C:\\Linx\\bin\\Big.exe" }
    ]);
  });

  it("swallows errors and returns empty list", async () => {
    const ctx = makeContext({
      listProcesses: vi.fn(async () => {
        throw new Error("wmic not available");
      })
    });
    await expect(probeProcesses(ctx)).resolves.toEqual([]);
  });

  it("returns empty when listProcesses returns no results", async () => {
    const ctx = makeContext();
    await expect(probeProcesses(ctx)).resolves.toEqual([]);
  });
});
```

- [ ] **Step 3.2: Rodar — Cannot find module**

Run: `npx vitest run tests/discovery/processes.test.ts`
Expected: FAIL.

- [ ] **Step 3.3: Criar `src/discovery/processes.ts`**

Create `src/discovery/processes.ts`:

```ts
import type { ProbeContext, WindowsProcess } from "./types.js";

export type ProcessCandidate = WindowsProcess;

export async function probeProcesses(ctx: ProbeContext): Promise<ProcessCandidate[]> {
  try {
    return await ctx.listProcesses();
  } catch {
    return [];
  }
}
```

- [ ] **Step 3.4: Rodar — devem passar**

Run: `npx vitest run tests/discovery/processes.test.ts`
Expected: PASS (3 testes).

- [ ] **Step 3.5: Commit**

```bash
git add src/discovery/processes.ts tests/discovery/processes.test.ts
git commit -m "feat(discovery): probeProcesses retorna lista de processos via context hook"
```

---

## Task 4: `connection-list.ts` — parser puro + default

**Files:**
- Create: `src/discovery/connection-list.ts`
- Create: `tests/discovery/connection-list.test.ts`

- [ ] **Step 4.1: Escrever testes do parser puro**

Create `tests/discovery/connection-list.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseNetstatOutput } from "../../src/discovery/connection-list.js";

describe("parseNetstatOutput", () => {
  it("parses ESTABLISHED IPv4 connections", () => {
    const raw = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:49802        127.0.0.1:1433         ESTABLISHED     4128
  TCP    192.168.1.10:49850     10.0.0.5:5432          ESTABLISHED     2200
  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4
`.trim();
    expect(parseNetstatOutput(raw)).toEqual([
      {
        pid: 4128,
        localAddr: "127.0.0.1",
        localPort: 49802,
        remoteAddr: "127.0.0.1",
        remotePort: 1433,
        state: "ESTABLISHED"
      },
      {
        pid: 2200,
        localAddr: "192.168.1.10",
        localPort: 49850,
        remoteAddr: "10.0.0.5",
        remotePort: 5432,
        state: "ESTABLISHED"
      }
    ]);
  });

  it("parses ESTABLISHED IPv6 connections", () => {
    const raw = `
  Proto  Local Address          Foreign Address        State           PID
  TCP    [::1]:49901            [::1]:1433             ESTABLISHED     4128
`.trim();
    expect(parseNetstatOutput(raw)).toEqual([
      {
        pid: 4128,
        localAddr: "::1",
        localPort: 49901,
        remoteAddr: "::1",
        remotePort: 1433,
        state: "ESTABLISHED"
      }
    ]);
  });

  it("returns empty for empty input", () => {
    expect(parseNetstatOutput("")).toEqual([]);
  });

  it("ignores non-TCP and malformed lines", () => {
    const raw = `
  Proto  Local Address          Foreign Address        State           PID
  UDP    0.0.0.0:53             *:*                                    1500
  TCP    127.0.0.1:80           127.0.0.1:5555         ESTABLISHED     1000
  garbage line here
`.trim();
    expect(parseNetstatOutput(raw)).toEqual([
      {
        pid: 1000,
        localAddr: "127.0.0.1",
        localPort: 80,
        remoteAddr: "127.0.0.1",
        remotePort: 5555,
        state: "ESTABLISHED"
      }
    ]);
  });
});
```

- [ ] **Step 4.2: Rodar — Cannot find module**

Run: `npx vitest run tests/discovery/connection-list.test.ts`
Expected: FAIL.

- [ ] **Step 4.3: Criar `src/discovery/connection-list.ts`**

Create `src/discovery/connection-list.ts`:

```ts
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
```

- [ ] **Step 4.4: Rodar — devem passar**

Run: `npx vitest run tests/discovery/connection-list.test.ts`
Expected: PASS.

- [ ] **Step 4.5: Commit**

```bash
git add src/discovery/connection-list.ts tests/discovery/connection-list.test.ts
git commit -m "feat(discovery): listWindowsConnections via netstat com parser puro"
```

---

## Task 5: `probeConnections` com cruzamento PID→nome

**Files:**
- Create: `src/discovery/connections.ts`
- Create: `tests/discovery/connections.test.ts`

- [ ] **Step 5.1: Escrever testes**

Create `tests/discovery/connections.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { probeConnections, DB_PORTS } from "../../src/discovery/connections.js";
import type { ProbeContext } from "../../src/discovery/types.js";

function makeContext(overrides: Partial<ProbeContext> = {}): ProbeContext {
  return {
    registry: { readKey: vi.fn(async () => ({})) } as never,
    fs: {
      readFile: vi.fn(async () => ""),
      listDir: vi.fn(async () => []),
      stat: vi.fn(async () => undefined),
      enumerateTop: vi.fn(async () => [])
    },
    serviceList: vi.fn(async () => []),
    listProcesses: vi.fn(async () => []),
    listConnections: vi.fn(async () => []),
    signal: new AbortController().signal,
    ...overrides
  };
}

describe("DB_PORTS", () => {
  it("includes the expected database ports", () => {
    expect(DB_PORTS.has(1433)).toBe(true);
    expect(DB_PORTS.has(5432)).toBe(true);
    expect(DB_PORTS.has(3306)).toBe(true);
    expect(DB_PORTS.has(3050)).toBe(true);
    expect(DB_PORTS.has(1521)).toBe(true);
    expect(DB_PORTS.has(27017)).toBe(true);
    expect(DB_PORTS.has(50000)).toBe(true);
    expect(DB_PORTS.has(1583)).toBe(true);
    expect(DB_PORTS.has(80)).toBe(false);
  });
});

describe("probeConnections", () => {
  it("filters connections to DB_PORTS (remote)", async () => {
    const ctx = makeContext({
      listConnections: vi.fn(async () => [
        { pid: 4128, localAddr: "127.0.0.1", localPort: 49802, remoteAddr: "127.0.0.1", remotePort: 1433, state: "ESTABLISHED" },
        { pid: 999, localAddr: "127.0.0.1", localPort: 6000, remoteAddr: "127.0.0.1", remotePort: 80, state: "ESTABLISHED" }
      ])
    });
    const result = await probeConnections(ctx);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ pid: 4128, remotePort: 1433 });
  });

  it("filters connections to DB_PORTS (local — case server listening)", async () => {
    const ctx = makeContext({
      listConnections: vi.fn(async () => [
        { pid: 100, localAddr: "0.0.0.0", localPort: 5432, remoteAddr: "10.0.0.1", remotePort: 51000, state: "ESTABLISHED" }
      ])
    });
    const result = await probeConnections(ctx);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ pid: 100, localPort: 5432 });
  });

  it("cross-references PID to processName when listProcesses succeeds", async () => {
    const ctx = makeContext({
      listConnections: vi.fn(async () => [
        { pid: 4128, localAddr: "127.0.0.1", localPort: 49802, remoteAddr: "127.0.0.1", remotePort: 1433, state: "ESTABLISHED" }
      ]),
      listProcesses: vi.fn(async () => [
        { pid: 4128, name: "Big.exe", path: "C:\\Linx\\bin\\Big.exe" }
      ])
    });
    const result = await probeConnections(ctx);
    expect(result[0]?.processName).toBe("Big.exe");
  });

  it("returns connections without processName when listProcesses throws", async () => {
    const ctx = makeContext({
      listConnections: vi.fn(async () => [
        { pid: 4128, localAddr: "127.0.0.1", localPort: 49802, remoteAddr: "127.0.0.1", remotePort: 1433, state: "ESTABLISHED" }
      ]),
      listProcesses: vi.fn(async () => {
        throw new Error("wmic failed");
      })
    });
    const result = await probeConnections(ctx);
    expect(result[0]?.pid).toBe(4128);
    expect(result[0]?.processName).toBeUndefined();
  });

  it("returns empty list when listConnections throws", async () => {
    const ctx = makeContext({
      listConnections: vi.fn(async () => {
        throw new Error("netstat failed");
      })
    });
    await expect(probeConnections(ctx)).resolves.toEqual([]);
  });
});
```

- [ ] **Step 5.2: Rodar — Cannot find module**

Run: `npx vitest run tests/discovery/connections.test.ts`
Expected: FAIL.

- [ ] **Step 5.3: Criar `src/discovery/connections.ts`**

Create `src/discovery/connections.ts`:

```ts
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
```

- [ ] **Step 5.4: Rodar — devem passar**

Run: `npx vitest run tests/discovery/connections.test.ts`
Expected: PASS (6 testes).

- [ ] **Step 5.5: Commit**

```bash
git add src/discovery/connections.ts tests/discovery/connections.test.ts
git commit -m "feat(discovery): probeConnections filtra DB_PORTS e cruza PID com processName"
```

---

## Task 6: `probeScanConfigDirs` (probe maior)

**Files:**
- Create: `src/discovery/scan-config-dirs.ts`
- Create: `tests/discovery/scan-config-dirs.test.ts`

- [ ] **Step 6.1: Escrever testes**

Create `tests/discovery/scan-config-dirs.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { probeScanConfigDirs, DEFAULT_PATTERNS } from "../../src/discovery/scan-config-dirs.js";
import type { FileSystemReader, FsEntry } from "../../src/discovery/fs-reader.js";

interface FsMap {
  [path: string]: FsEntry[] | "permission" | "missing";
}

function makeFs(map: FsMap): FileSystemReader {
  return {
    readFile: vi.fn(async () => ""),
    listDir: vi.fn(async () => []),
    stat: vi.fn(async (path: string) => {
      if (path in map && map[path] !== "missing") {
        return { isFile: false, isDirectory: true };
      }
      return undefined;
    }),
    enumerateTop: vi.fn(async (path: string) => {
      const entries = map[path];
      if (entries === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (entries === "permission") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      if (entries === "missing") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return entries;
    })
  };
}

function file(name: string, size = 100, mtime = new Date("2026-05-01T00:00:00Z")): FsEntry {
  return { name, isFile: true, isDirectory: false, size, mtime };
}

function dir(name: string): FsEntry {
  return { name, isFile: false, isDirectory: true };
}

describe("probeScanConfigDirs", () => {
  it("returns files matching default patterns at depth 0", async () => {
    const fs = makeFs({
      "C:\\Linx": [file("config.ini"), file("readme.txt"), file("app.config")]
    });
    const r = await probeScanConfigDirs({ fs }, { roots: ["C:\\Linx"] });
    expect(r.files.map((f) => f.path).sort()).toEqual([
      "C:\\Linx\\app.config",
      "C:\\Linx\\config.ini"
    ]);
    expect(r.truncated).toBe(false);
    expect(r.rootsRejected).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it("recurses into subdirs up to maxDepth", async () => {
    const fs = makeFs({
      "C:\\Linx": [file("a.ini"), dir("sub")],
      "C:\\Linx\\sub": [file("b.ini"), dir("deeper")],
      "C:\\Linx\\sub\\deeper": [file("c.ini")]
    });
    const r = await probeScanConfigDirs({ fs }, { roots: ["C:\\Linx"], maxDepth: 2 });
    const paths = r.files.map((f) => f.path).sort();
    expect(paths).toEqual([
      "C:\\Linx\\a.ini",
      "C:\\Linx\\sub\\b.ini"
    ]);
  });

  it("rejects roots in deny-list (volume root, Windows folder)", async () => {
    const fs = makeFs({});
    const r = await probeScanConfigDirs({ fs }, {
      roots: ["C:\\", "C:\\Windows", "C:\\Windows\\System32", "C:\\App"]
    });
    expect(r.rootsRejected.sort()).toEqual([
      "C:\\", "C:\\Windows", "C:\\Windows\\System32"
    ]);
  });

  it("rejects Users root but accepts paths under it", async () => {
    const fs = makeFs({
      "C:\\Users\\fulano\\AppData\\Local\\App": [file("settings.json")]
    });
    const r = await probeScanConfigDirs({ fs }, {
      roots: ["C:\\Users", "C:\\Users\\fulano\\AppData\\Local\\App"]
    });
    expect(r.rootsRejected).toEqual(["C:\\Users"]);
    expect(r.files.map((f) => f.path)).toEqual([
      "C:\\Users\\fulano\\AppData\\Local\\App\\settings.json"
    ]);
  });

  it("skips dirs in SKIP_DIR_NAMES_CI", async () => {
    const fs = makeFs({
      "C:\\App": [
        file("a.ini"),
        dir("node_modules"),
        dir("Temp"),
        dir("config"),
        dir(".git")
      ],
      "C:\\App\\node_modules": [file("evil.ini")],
      "C:\\App\\Temp": [file("evil2.ini")],
      "C:\\App\\config": [file("good.ini")],
      "C:\\App\\.git": [file("evil3.ini")]
    });
    const r = await probeScanConfigDirs({ fs }, { roots: ["C:\\App"], maxDepth: 2 });
    const paths = r.files.map((f) => f.path).sort();
    expect(paths).toEqual([
      "C:\\App\\a.ini",
      "C:\\App\\config\\good.ini"
    ]);
  });

  it("preserves .config hidden dir (cross-platform)", async () => {
    const fs = makeFs({
      "/home/user": [dir(".config"), dir(".cache")],
      "/home/user/.config": [file("app.ini")],
      "/home/user/.cache": [file("evil.ini")]
    });
    const r = await probeScanConfigDirs({ fs }, { roots: ["/home/user"], maxDepth: 2 });
    expect(r.files.map((f) => f.path)).toEqual(["/home/user/.config/app.ini"]);
  });

  it("truncates at maxFiles", async () => {
    const entries: FsEntry[] = [];
    for (let i = 0; i < 50; i += 1) entries.push(file(`f${i}.ini`));
    const fs = makeFs({ "C:\\App": entries });
    const r = await probeScanConfigDirs({ fs }, { roots: ["C:\\App"], maxFiles: 10 });
    expect(r.files).toHaveLength(10);
    expect(r.truncated).toBe(true);
  });

  it("clamps maxDepth to ceiling silently", async () => {
    const fs = makeFs({ "C:\\App": [file("a.ini")] });
    const r = await probeScanConfigDirs({ fs }, { roots: ["C:\\App"], maxDepth: 999 });
    // Não rejeita — clampado. files retorna normalmente.
    expect(r.files).toHaveLength(1);
  });

  it("filters by maxAgeDays", async () => {
    const now = new Date("2026-05-28T00:00:00Z");
    const fs = makeFs({
      "C:\\App": [
        file("recent.ini", 100, new Date("2026-05-25T00:00:00Z")),
        file("old.ini", 100, new Date("2024-01-01T00:00:00Z"))
      ]
    });
    const r = await probeScanConfigDirs({ fs, now: () => now }, {
      roots: ["C:\\App"],
      maxAgeDays: 30
    });
    expect(r.files.map((f) => f.path)).toEqual(["C:\\App\\recent.ini"]);
  });

  it("records permission errors without aborting", async () => {
    const fs = makeFs({
      "C:\\App": [file("a.ini"), dir("protected")],
      "C:\\App\\protected": "permission"
    });
    const r = await probeScanConfigDirs({ fs }, { roots: ["C:\\App"], maxDepth: 2 });
    expect(r.files.map((f) => f.path)).toEqual(["C:\\App\\a.ini"]);
    expect(r.errors).toEqual([{ path: "C:\\App\\protected", reason: "permission" }]);
  });

  it("records missing root in errors", async () => {
    const fs = makeFs({});
    const r = await probeScanConfigDirs({ fs }, { roots: ["C:\\Inexistente"] });
    expect(r.errors).toEqual([{ path: "C:\\Inexistente", reason: "missing" }]);
  });

  it("expands environment variables in roots", async () => {
    const fs = makeFs({
      "C:\\Program Files\\App": [file("config.ini")]
    });
    const env = { PROGRAMFILES: "C:\\Program Files" };
    const r = await probeScanConfigDirs({ fs, env }, { roots: ["%PROGRAMFILES%\\App"] });
    expect(r.files.map((f) => f.path)).toEqual(["C:\\Program Files\\App\\config.ini"]);
  });

  it("rejects root with unresolved env var", async () => {
    const fs = makeFs({});
    const r = await probeScanConfigDirs(
      { fs, env: {} },
      { roots: ["%UNDEFINED_VAR%\\App"] }
    );
    expect(r.rootsRejected).toEqual(["%UNDEFINED_VAR%\\App"]);
  });

  it("respects custom patterns case-insensitively", async () => {
    const fs = makeFs({
      "C:\\App": [file("a.INI"), file("b.txt"), file("c.YML")]
    });
    const r = await probeScanConfigDirs({ fs }, {
      roots: ["C:\\App"],
      patterns: ["*.ini", "*.yml"]
    });
    expect(r.files.map((f) => f.path).sort()).toEqual([
      "C:\\App\\a.INI",
      "C:\\App\\c.YML"
    ]);
  });

  it("DEFAULT_PATTERNS includes ini/json/xml/env/db", () => {
    expect(DEFAULT_PATTERNS).toContain("*.ini");
    expect(DEFAULT_PATTERNS).toContain("*.json");
    expect(DEFAULT_PATTERNS).toContain("*.xml");
    expect(DEFAULT_PATTERNS).toContain("*.env");
    expect(DEFAULT_PATTERNS).toContain("*.db");
  });
});
```

- [ ] **Step 6.2: Rodar — Cannot find module**

Run: `npx vitest run tests/discovery/scan-config-dirs.test.ts`
Expected: FAIL.

- [ ] **Step 6.3: Criar `src/discovery/scan-config-dirs.ts`**

Create `src/discovery/scan-config-dirs.ts`:

```ts
import type { FileSystemReader, FsEntry } from "./fs-reader.js";

export const DEFAULT_PATTERNS = [
  "*.ini", "*.conf", "*.config",
  "*.json", "*.xml", "*.yaml", "*.yml",
  "*.env", "*.properties",
  "*.db", "*.sqlite", "*.db3"
] as const;

export const DEFAULT_MAX_DEPTH = 3;
export const DEFAULT_MAX_FILES = 200;
export const MAX_DEPTH_CEILING = 5;
export const MAX_FILES_CEILING = 1000;
export const MAX_ROOTS = 32;

const DENY_ROOT_REGEXES: RegExp[] = [
  /^[A-Z]:\\?$/i,
  /^[A-Z]:\\Users\\?$/i,
  /^[A-Z]:\\Windows(\\|$)/i,
  /^[A-Z]:\\\$Recycle\.Bin/i,
  /^\/$/,
  /^\/home\/?$/,
  /^\/usr\/?$/,
  /^\/etc\/?$/
];

const SKIP_DIR_NAMES_CI: ReadonlySet<string> = new Set([
  "node_modules", ".git", ".svn", ".hg",
  "temp", "tmp", "cache", "logs", "log",
  "backup", "backups", "winsxs", "system32", "syswow64",
  "inetcache", "$recycle.bin"
]);

const PRESERVED_HIDDEN_DIRS: ReadonlySet<string> = new Set([".config"]);

export interface ScanConfigDirsInput {
  roots: string[];
  patterns?: readonly string[];
  maxDepth?: number;
  maxFiles?: number;
  maxAgeDays?: number;
}

export interface ScannedFile {
  path: string;
  size: number;
  mtime: string;
}

export interface ScanError {
  path: string;
  reason: "permission" | "missing" | "unknown";
}

export interface ScanConfigDirsResult {
  files: ScannedFile[];
  truncated: boolean;
  rootsRejected: string[];
  errors: ScanError[];
}

export interface ProbeScanConfigDirsContext {
  fs: FileSystemReader;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

export async function probeScanConfigDirs(
  ctx: ProbeScanConfigDirsContext,
  input: ScanConfigDirsInput
): Promise<ScanConfigDirsResult> {
  const env = ctx.env ?? process.env;
  const maxDepth = clamp(input.maxDepth ?? DEFAULT_MAX_DEPTH, 1, MAX_DEPTH_CEILING);
  const maxFiles = clamp(input.maxFiles ?? DEFAULT_MAX_FILES, 1, MAX_FILES_CEILING);
  const patternsRegex = compilePatterns(input.patterns ?? DEFAULT_PATTERNS);
  const ageCutoff = input.maxAgeDays !== undefined ? cutoffDate(ctx.now ?? (() => new Date()), input.maxAgeDays) : undefined;

  const files: ScannedFile[] = [];
  const errors: ScanError[] = [];
  const rootsRejected: string[] = [];
  let truncated = false;

  for (const rawRoot of input.roots) {
    if (files.length >= maxFiles) break;
    const expansion = expandEnv(rawRoot, env);
    if (expansion === undefined) {
      rootsRejected.push(rawRoot);
      continue;
    }
    const root = expansion;
    if (isDenied(root)) {
      rootsRejected.push(rawRoot);
      continue;
    }

    // Verify root exists
    let initialEntries: FsEntry[];
    try {
      initialEntries = await ctx.fs.enumerateTop(root);
    } catch (err) {
      errors.push({ path: root, reason: mapFsError(err) });
      continue;
    }

    const stack: { path: string; entries: FsEntry[]; depth: number }[] = [
      { path: root, entries: initialEntries, depth: 0 }
    ];
    while (stack.length > 0) {
      if (files.length >= maxFiles) break;
      const frame = stack.pop();
      if (!frame) break;
      for (const entry of frame.entries) {
        if (files.length >= maxFiles) {
          truncated = true;
          break;
        }
        const fullPath = joinPath(frame.path, entry.name);
        if (entry.isFile) {
          if (!matchesAny(entry.name, patternsRegex)) continue;
          if (ageCutoff && entry.mtime && entry.mtime < ageCutoff) continue;
          files.push({
            path: fullPath,
            size: entry.size ?? 0,
            mtime: (entry.mtime ?? new Date(0)).toISOString()
          });
          if (files.length >= maxFiles) {
            truncated = true;
            break;
          }
          continue;
        }
        if (entry.isDirectory) {
          if (shouldSkipDir(entry.name)) continue;
          if (frame.depth + 1 >= maxDepth) continue;
          try {
            const childEntries = await ctx.fs.enumerateTop(fullPath);
            stack.push({ path: fullPath, entries: childEntries, depth: frame.depth + 1 });
          } catch (err) {
            errors.push({ path: fullPath, reason: mapFsError(err) });
          }
        }
      }
    }
  }

  return { files, truncated, rootsRejected, errors };
}

function expandEnv(value: string, env: Record<string, string | undefined>): string | undefined {
  let resolved = value;
  const re = /%([A-Z0-9_\(\)]+)%/gi;
  let match: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((match = re.exec(resolved)) !== null) {
    const varName = match[1];
    if (!varName) continue;
    if (seen.has(varName)) continue;
    seen.add(varName);
    const replacement = env[varName];
    if (replacement === undefined || replacement.length === 0) return undefined;
    resolved = resolved.split(`%${varName}%`).join(replacement);
    re.lastIndex = 0;
  }
  return resolved;
}

function isDenied(path: string): boolean {
  return DENY_ROOT_REGEXES.some((re) => re.test(path));
}

function shouldSkipDir(name: string): boolean {
  const lower = name.toLowerCase();
  if (SKIP_DIR_NAMES_CI.has(lower)) return true;
  if (name.startsWith(".") && !PRESERVED_HIDDEN_DIRS.has(lower)) return true;
  return false;
}

function compilePatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map((p) => {
    const escaped = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
    return new RegExp(`^${escaped}$`, "i");
  });
}

function matchesAny(name: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(name));
}

function cutoffDate(now: () => Date, days: number): Date {
  const t = now().getTime() - days * 24 * 60 * 60 * 1000;
  return new Date(t);
}

function mapFsError(err: unknown): "permission" | "missing" | "unknown" {
  if (err && typeof err === "object" && "code" in err) {
    const code = String((err as { code?: unknown }).code);
    if (code === "EACCES" || code === "EPERM") return "permission";
    if (code === "ENOENT") return "missing";
  }
  return "unknown";
}

function joinPath(parent: string, name: string): string {
  if (parent.includes("\\")) {
    return parent.endsWith("\\") ? `${parent}${name}` : `${parent}\\${name}`;
  }
  return parent.endsWith("/") ? `${parent}${name}` : `${parent}/${name}`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
```

- [ ] **Step 6.4: Rodar — devem passar**

Run: `npx vitest run tests/discovery/scan-config-dirs.test.ts`
Expected: PASS (todos os ~14 testes).

- [ ] **Step 6.5: Commit**

```bash
git add src/discovery/scan-config-dirs.ts tests/discovery/scan-config-dirs.test.ts
git commit -m "feat(discovery): probeScanConfigDirs com deny-list, BFS controlada e env expansion"
```

---

## Task 7: Estender protocolo + admin-router

**Files:**
- Modify: `src/transport/protocol.ts`
- Modify: `src/discovery/admin-router.ts`
- Modify: `tests/discovery/admin-router.test.ts`
- Modify: `tests/transport/protocol.test.ts`

- [ ] **Step 7.1: Escrever testes do protocolo (rejeição/aceitação dos novos commands)**

Adicionar em `tests/transport/protocol.test.ts` (ao final do describe "admin.request with input payload"):

```ts
  it("accepts probe.processes admin request", () => {
    const raw = JSON.stringify({
      type: "admin.request",
      requestId: "req-pp",
      command: "probe.processes",
      input: {}
    });
    expect((parseServerMessage(raw) as { command: string }).command).toBe("probe.processes");
  });

  it("accepts probe.connections admin request", () => {
    const raw = JSON.stringify({
      type: "admin.request",
      requestId: "req-pc",
      command: "probe.connections"
    });
    expect((parseServerMessage(raw) as { command: string }).command).toBe("probe.connections");
  });

  it("accepts probe.scan_config_dirs admin request with input", () => {
    const raw = JSON.stringify({
      type: "admin.request",
      requestId: "req-scd",
      command: "probe.scan_config_dirs",
      input: { roots: ["C:\\App"] }
    });
    const msg = parseServerMessage(raw);
    expect(msg).toMatchObject({ command: "probe.scan_config_dirs", input: { roots: ["C:\\App"] } });
  });
```

- [ ] **Step 7.2: Estender `AdminCommand` em `src/transport/protocol.ts`**

Localizar o union `AdminCommand` (linha ~11):

```ts
export type AdminCommand =
  | "schema.listTables"
  | "probe.engines"
  | "probe.odbc_dsns"
  | "probe.network"
  | "probe.test_connection"
  | "probe.processes"
  | "probe.connections"
  | "probe.scan_config_dirs";
```

Localizar `ADMIN_COMMANDS` set:

```ts
const ADMIN_COMMANDS = new Set<AdminCommand>([
  "schema.listTables",
  "probe.engines",
  "probe.odbc_dsns",
  "probe.network",
  "probe.test_connection",
  "probe.processes",
  "probe.connections",
  "probe.scan_config_dirs"
]);
```

- [ ] **Step 7.3: Rodar testes do protocolo — devem passar**

Run: `npx vitest run tests/transport/protocol.test.ts`
Expected: PASS.

- [ ] **Step 7.4: Estender `AdminRouterDependencies` e adicionar cases no router**

Modify `src/discovery/admin-router.ts`:

Adicionar imports:

```ts
import type { ProcessCandidate } from "./processes.js";
import type { ConnectionCandidate } from "./connections.js";
import type { ScanConfigDirsInput, ScanConfigDirsResult } from "./scan-config-dirs.js";
import { MAX_ROOTS } from "./scan-config-dirs.js";
```

Estender o interface `AdminRouterDependencies`:

```ts
export interface AdminRouterDependencies {
  probeEngines: () => Promise<EngineCandidate[]>;
  probeOdbcDsns: () => Promise<OdbcDsnCandidate[]>;
  probeNetwork: (input: ProbeNetworkInput) => Promise<ProbeNetworkResult>;
  probeTestConnection: (input: TestConnectionInput) => Promise<TestConnectionResult>;
  probeProcesses: () => Promise<ProcessCandidate[]>;
  probeConnections: () => Promise<ConnectionCandidate[]>;
  probeScanConfigDirs: (input: ScanConfigDirsInput) => Promise<ScanConfigDirsResult>;
  schemaListTables: () => Promise<string[]>;
}
```

No switch de `handleAdminRequest`, adicionar 3 cases antes do `case "schema.listTables":`:

```ts
      case "probe.processes": {
        const processes = await deps.probeProcesses();
        return success(req, { processes });
      }
      case "probe.connections": {
        const connections = await deps.probeConnections();
        return success(req, { connections });
      }
      case "probe.scan_config_dirs": {
        const input = validateScanConfigDirsInput(req.input);
        if (!input.ok) return invalidInput(req, input.error);
        const result = await deps.probeScanConfigDirs(input.value);
        return success(req, result);
      }
```

Ao final do arquivo, adicionar o validador:

```ts
function validateScanConfigDirsInput(input: unknown): Validated<ScanConfigDirsInput> {
  if (!isRecord(input)) return { ok: false, error: "input must be an object" };
  if (!Array.isArray(input.roots) || input.roots.length === 0) {
    return { ok: false, error: "input.roots must be a non-empty array" };
  }
  if (input.roots.length > MAX_ROOTS) {
    return { ok: false, error: `input.roots accepts at most ${MAX_ROOTS} items` };
  }
  const roots: string[] = [];
  for (const r of input.roots) {
    if (typeof r !== "string" || r.length === 0) {
      return { ok: false, error: "input.roots must contain non-empty strings" };
    }
    roots.push(r);
  }
  const out: ScanConfigDirsInput = { roots };
  if (Array.isArray(input.patterns)) {
    const patterns: string[] = [];
    for (const p of input.patterns) {
      if (typeof p !== "string" || p.length === 0) {
        return { ok: false, error: "input.patterns must contain non-empty strings" };
      }
      patterns.push(p);
    }
    if (patterns.length > 0) out.patterns = patterns;
  }
  if (typeof input.maxDepth === "number" && Number.isInteger(input.maxDepth) && input.maxDepth > 0) {
    out.maxDepth = input.maxDepth;
  }
  if (typeof input.maxFiles === "number" && Number.isInteger(input.maxFiles) && input.maxFiles > 0) {
    out.maxFiles = input.maxFiles;
  }
  if (typeof input.maxAgeDays === "number" && input.maxAgeDays > 0) {
    out.maxAgeDays = input.maxAgeDays;
  }
  return { ok: true, value: out };
}
```

- [ ] **Step 7.5: Estender testes do router**

Modify `tests/discovery/admin-router.test.ts` no helper `makeDeps`:

```ts
function makeDeps(overrides: Partial<AdminRouterDependencies> = {}): AdminRouterDependencies {
  return {
    probeEngines: vi.fn(async () => [{ kind: "sqlserver", confidence: "high", evidence: ["service:MSSQLSERVER"] }]),
    probeOdbcDsns: vi.fn(async () => []),
    probeNetwork: vi.fn(async () => ({ reachable: true, latencyMs: 5 })),
    probeTestConnection: vi.fn(async () => ({ ok: true, latencyMs: 12 })),
    probeProcesses: vi.fn(async () => [{ pid: 4128, name: "Big.exe", path: "C:\\Linx\\bin\\Big.exe" }]),
    probeConnections: vi.fn(async () => []),
    probeScanConfigDirs: vi.fn(async () => ({ files: [], truncated: false, rootsRejected: [], errors: [] })),
    schemaListTables: vi.fn(async () => ["products"]),
    ...overrides
  };
}
```

Adicionar 4 testes novos:

```ts
  it("dispatches probe.processes", async () => {
    const res = await handleAdminRequest(
      { type: "admin.request", requestId: "r", command: "probe.processes" },
      makeDeps()
    );
    expect(res).toMatchObject({ ok: true, payload: { processes: expect.any(Array) } });
  });

  it("dispatches probe.connections", async () => {
    const res = await handleAdminRequest(
      { type: "admin.request", requestId: "r", command: "probe.connections" },
      makeDeps()
    );
    expect(res).toMatchObject({ ok: true, payload: { connections: expect.any(Array) } });
  });

  it("dispatches probe.scan_config_dirs with roots", async () => {
    const res = await handleAdminRequest(
      {
        type: "admin.request",
        requestId: "r",
        command: "probe.scan_config_dirs",
        input: { roots: ["C:\\App"] }
      },
      makeDeps()
    );
    expect(res).toMatchObject({
      ok: true,
      payload: { files: expect.any(Array), truncated: false, rootsRejected: [], errors: [] }
    });
  });

  it("rejects probe.scan_config_dirs with empty roots", async () => {
    const res = await handleAdminRequest(
      {
        type: "admin.request",
        requestId: "r",
        command: "probe.scan_config_dirs",
        input: { roots: [] }
      },
      makeDeps()
    );
    expect(res).toMatchObject({ ok: false, error: { errorCode: "INVALID_INPUT" } });
  });
```

- [ ] **Step 7.6: Rodar — devem passar**

Run: `npx vitest run tests/discovery/admin-router.test.ts tests/transport/protocol.test.ts`
Expected: PASS.

- [ ] **Step 7.7: Commit**

```bash
git add src/transport/protocol.ts src/discovery/admin-router.ts tests/discovery/admin-router.test.ts tests/transport/protocol.test.ts
git commit -m "feat(discovery): admin-router despacha probes processes/connections/scan_config_dirs"
```

---

## Task 8: Wiring no runtime

**Files:**
- Modify: `src/service/runtime.ts`

- [ ] **Step 8.1: Adicionar imports no topo de `runtime.ts`**

Adicionar (após os imports existentes de discovery):

```ts
import { probeProcesses } from "../discovery/processes.js";
import { probeConnections } from "../discovery/connections.js";
import { probeScanConfigDirs } from "../discovery/scan-config-dirs.js";
import { listWindowsProcesses } from "../discovery/process-list.js";
import { listWindowsConnections } from "../discovery/connection-list.js";
```

- [ ] **Step 8.2: Atualizar a construção do `ProbeContext` no `buildAdminRouterDeps()`**

Localizar `buildAdminRouterDeps()`. Os probes existentes (`probeEngines`, `probeOdbcDsns`) construem um `ProbeContext` inline. Esse contexto agora precisa de `listProcesses` e `listConnections`. Refatorar para construir o contexto compartilhado:

```ts
private buildAdminRouterDeps(): AdminRouterDependencies {
  const registry = createRegExeRegistryReader();
  const buildProbeContext = (): ProbeContext => ({
    registry,
    fs: nodeFileSystemReader,
    serviceList: listWindowsServices,
    listProcesses: listWindowsProcesses,
    listConnections: listWindowsConnections,
    signal: new AbortController().signal
  });

  const recordSuccess = (cmd: string) => this.bootstrapState.recordProbeSuccess(cmd);
  const recordError = (cmd: string, code: string) => this.bootstrapState.recordProbeError(cmd, code);

  return {
    probeEngines: async () => {
      try {
        const result = await probeEngines(buildProbeContext(), {
          tcpProbe: (host, port, timeoutMs = 3000) => tcpProbe(host, port, timeoutMs)
        });
        recordSuccess("probe.engines");
        return result;
      } catch (err) {
        recordError("probe.engines", "internal");
        throw err;
      }
    },
    probeOdbcDsns: async () => {
      try {
        const result = await probeOdbcDsns(registry);
        recordSuccess("probe.odbc_dsns");
        return result;
      } catch (err) {
        recordError("probe.odbc_dsns", "internal");
        throw err;
      }
    },
    probeNetwork: async (input) => {
      try {
        const result = await probeNetwork(input);
        if (result.reachable) recordSuccess("probe.network");
        else recordError("probe.network", result.error ?? "unknown");
        return result;
      } catch (err) {
        recordError("probe.network", "internal");
        throw err;
      }
    },
    probeTestConnection: async (input) => {
      try {
        const result = await probeTestConnection(input, {
          createAdapter: (config) =>
            createSourceDatabaseAdapter({
              config,
              dependencies: this.adapterDependencies
            }),
          timeoutMs: 5000
        });
        if (result.ok) recordSuccess("probe.test_connection");
        else recordError("probe.test_connection", result.code);
        return result;
      } catch (err) {
        recordError("probe.test_connection", "internal");
        throw err;
      }
    },
    probeProcesses: async () => {
      try {
        const result = await probeProcesses(buildProbeContext());
        recordSuccess("probe.processes");
        return result;
      } catch (err) {
        recordError("probe.processes", "internal");
        throw err;
      }
    },
    probeConnections: async () => {
      try {
        const result = await probeConnections(buildProbeContext());
        recordSuccess("probe.connections");
        return result;
      } catch (err) {
        recordError("probe.connections", "internal");
        throw err;
      }
    },
    probeScanConfigDirs: async (input) => {
      try {
        const result = await probeScanConfigDirs({ fs: nodeFileSystemReader }, input);
        recordSuccess("probe.scan_config_dirs");
        return result;
      } catch (err) {
        recordError("probe.scan_config_dirs", "internal");
        throw err;
      }
    },
    schemaListTables: async () => []
  };
}
```

Adicionar `import type { ProbeContext } from "../discovery/types.js";` no topo se ainda não estiver presente.

- [ ] **Step 8.3: Verificar TS build**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: zero errors.

- [ ] **Step 8.4: Rodar suite completa**

Run: `npm test`
Expected: 0 falhas.

- [ ] **Step 8.5: Commit**

```bash
git add src/service/runtime.ts
git commit -m "feat(runtime): wira probes processes/connections/scan_config_dirs no admin-router"
```

---

## Task 9: Smoke manual + README

**Files:**
- Create: `docs/superpowers/specs/smokes/2026-05-28-discovery-process-connection-smoke.md`
- Modify: `README.md`

- [ ] **Step 9.1: Criar smoke**

Create `docs/superpowers/specs/smokes/2026-05-28-discovery-process-connection-smoke.md`:

```md
# Smoke Manual: probes de processos, conexões e scan de configs

Validar end-to-end em VM Windows real os 3 probes novos.

## Pré-requisitos

- VM Windows 10/11 com `pharma-agent-connector` instalado e rodando como service `LocalSystem`.
- SQL Server local rodando na porta 1433 (`MSSQLSERVER` ou `MSSQL$SQLEXPRESS`).
- Service conectado ao `mock-panel` (`npm run mock-panel -- serve`) via WS.
- Processo cliente conectado a localhost:1433 — pode ser `sqlcmd -S .` deixado aberto, ou qualquer SSMS.

## Roteiro

### 1. probe.processes

Pelo `mock-panel`, enviar `admin.request` com `command: "probe.processes"`. Esperado:

- Response `ok: true`, `payload.processes` é array.
- Lista contém pelo menos `sqlservr.exe` com `path` (ex: `C:\Program Files\Microsoft SQL Server\MSSQL16.MSSQLSERVER\MSSQL\Binn\sqlservr.exe`).
- Processos de sistema (`System`, `Idle`, `services.exe`) NÃO aparecem.

### 2. probe.connections

`command: "probe.connections"`. Esperado:

- Response `ok: true`, `payload.connections` array.
- Pelo menos uma entry com `remotePort: 1433` (ou `localPort: 1433` se o SQL Server estiver listando para si).
- `processName` preenchido (`sqlservr.exe` ou o cliente).
- Conexões em portas não-DB (porta 80, 443) NÃO aparecem.

### 3. probe.scan_config_dirs com root válido

`command: "probe.scan_config_dirs"`, `input: { roots: ["C:\\Program Files\\Microsoft SQL Server"], maxDepth: 3, maxFiles: 50 }`.

Esperado:

- `payload.files` contém arquivos `.config`, `.xml`, `.ini` (se houver) abaixo da pasta. Tamanhos > 0.
- `rootsRejected: []`.
- `truncated: false` (provavelmente — depende da instalação).

### 4. probe.scan_config_dirs com root negado

`input: { roots: ["C:\\", "C:\\Windows\\System32", "C:\\Program Files\\Microsoft SQL Server"] }`.

Esperado:

- `rootsRejected` contém `C:\` e `C:\Windows\System32`.
- `files` ainda traz resultados do root válido.

### 5. probe.scan_config_dirs com env var

`input: { roots: ["%PROGRAMFILES%\\Microsoft SQL Server"] }`.

Esperado: equivalente ao caso 3 (env expandida internamente).

### 6. heartbeat bootstrap counter

Após executar os 3 probes acima, observar o próximo heartbeat. Em `bootstrap` mode, `payload.bootstrap.probesRunTotal` deve refletir os probes executados; `lastProbeAt` recente.

## Critérios de aceitação

- ✅ Todos os 6 itens acima retornam o esperado
- ✅ Nenhum log `unsupported_server_message` aparece para esses comandos
- ✅ Nenhum erro `INTERNAL_ERROR` retornado
```

- [ ] **Step 9.2: Atualizar README**

Localizar a seção sobre probes (perto de "Discovery" se existir, ou após "Onboarding Flows" criada na Fase 3). Adicionar:

```md
### Probes adicionais (Fase 4b)

- **`probe.processes`** — lista processos rodando com `pid`, `name`, `path` da exe (via WMIC + PowerShell fallback). Cross-platform: retorna lista vazia.
- **`probe.connections`** — lista conexões TCP em portas de banco conhecidas (`1433`, `5432`, `3306`, `3050`, `1521`, `1583`, `50000`, `27017`), cruzando PID com nome do processo.
- **`probe.scan_config_dirs`** — varre diretórios prioritários por arquivos de config (`.ini`, `.json`, `.xml`, `.env`, `.db`, etc.), retornando metadata (path/size/mtime). Aplica deny-list intransponível (`C:\`, `C:\Windows`, `node_modules`, etc.) e limites de profundidade/quantidade. Aceita expansão de `%VAR%`.
```

- [ ] **Step 9.3: Commit**

```bash
git add docs/superpowers/specs/smokes/2026-05-28-discovery-process-connection-smoke.md README.md
git commit -m "docs: smoke manual e README dos novos probes process/connection/scan"
```

---

## Verificação final

- [ ] **Step F.1: Rodar suite completa**

Run: `npm test`
Expected: 0 falhas, pelo menos ~30 testes novos (process-list 5, processes 3, connection-list 4, connections 6, scan-config-dirs ~14, admin-router +4, protocol +3).

- [ ] **Step F.2: Build de produção**

Run: `npm run build`
Expected: 0 erros TS.

- [ ] **Step F.3: Verificar git log**

Run: `git log --oneline -12`
Expected: 9 commits criados na ordem das tasks.
