# Fase 2 — Discovery Probes Básicos + Admin Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que o painel central comande sondagens locais (discovery probes) na máquina do cliente via WS já existente. Adiciona 4 probes (`probe.engines`, `probe.odbc_dsns`, `probe.network`, `probe.test_connection`) e generaliza o protocolo `admin.request`/`admin.response` para carregar input e payload tipado por comando.

**Architecture:** Pasta nova `src/discovery/` com um arquivo por probe (módulos puros recebendo dependências injetadas). Novo `admin-router.ts` (também em `src/discovery/`) que despacha `AdminRequestMessage` para o probe certo, aplica timeout via `AbortSignal`, captura erros e devolve `AdminResponseMessage`. Protocolo `admin.request` evolui para carregar `input?: unknown` (validado por probe). `AdminResponseSuccessPayload` deixa de ser hard-coded em `{tables: string[]}` e passa a ser `unknown` (validado por probe).

**Tech Stack:** TypeScript (ESM), vitest, sem deps novas (usa `node:child_process` para `sc.exe`, `node:net` para TCP probe).

**Spec:** `docs/superpowers/specs/2026-05-27-discovery-multi-erp-design.md` (Seção "Catálogo de probes" e "Detalhamento dos probes" 3.1-3.6, exceto 3.3 e 3.4).

**Depende de:** Nenhuma fase anterior. Pode ser implementada em paralelo à Fase 1.

---

## File Structure

**Novos arquivos:**
- `src/discovery/types.ts` — tipos compartilhados: `ProbeContext`, `ProbeOutcome`, códigos de erro
- `src/discovery/error-codes.ts` — `categorizeError`, lista `ProbeErrorCode`
- `src/discovery/fs-reader.ts` — interface `FileSystemReader` + implementação default (`node:fs/promises`)
- `src/discovery/service-list.ts` — função `listWindowsServices()` via `sc query`
- `src/discovery/engines.ts` — `probeEngines`
- `src/discovery/odbc-dsns.ts` — `probeOdbcDsns` (generaliza `dsn-discovery.ts`)
- `src/discovery/network.ts` — `probeNetwork` via `node:net`
- `src/discovery/test-connection.ts` — `probeTestConnection` reusando `createSourceDatabaseAdapter`
- `src/discovery/admin-router.ts` — roteamento de `admin.request` por comando, timeout, captura de erros
- `tests/discovery/error-codes.test.ts`
- `tests/discovery/engines.test.ts`
- `tests/discovery/odbc-dsns.test.ts`
- `tests/discovery/network.test.ts`
- `tests/discovery/test-connection.test.ts`
- `tests/discovery/admin-router.test.ts`

**Modificados:**
- `src/transport/protocol.ts` — `AdminCommand` vira lista expandida; `AdminRequestMessage` ganha `input?: unknown`; `AdminResponseSuccessPayload` vira `unknown`; parsers atualizados
- `src/db/dsn-discovery.ts` — refatorado para usar a função genérica nova (`discoverOdbcDsns`), mantendo `discoverPostgresDsns` exportada
- `tests/transport/protocol.test.ts` (ou equivalente) — novos casos para `probe.*`
- `src/service/runtime.ts` — registra o `admin-router` no handler de `admin.request` (em vez do handler hardcoded atual de `schema.listTables`)

**Não muda:** estrutura de heartbeat, file-discovery, runtime startup.

---

## Task 1: Generalizar protocolo `admin.request` / `admin.response`

**Files:**
- Modify: `src/transport/protocol.ts:8,11,39-44,117-143,182-218,373-414,453-469`

- [ ] **Step 1.1: Escrever teste do novo shape do protocolo**

Localize o arquivo de testes do protocolo (provavelmente `tests/transport/protocol.test.ts`). Adicione um novo describe block no final:

```ts
describe("admin.request with input payload", () => {
  it("parses probe.engines admin request with empty input", () => {
    const raw = JSON.stringify({
      type: "admin.request",
      requestId: "req-1",
      command: "probe.engines",
      input: {}
    });
    const msg = parseServerMessage(raw);
    expect(msg).toMatchObject({
      type: "admin.request",
      requestId: "req-1",
      command: "probe.engines",
      input: {}
    });
  });

  it("parses probe.test_connection admin request with input payload", () => {
    const raw = JSON.stringify({
      type: "admin.request",
      requestId: "req-2",
      command: "probe.test_connection",
      input: { driver: "sqlserver", host: "10.0.0.1", port: 1433, database: "db", user: "u", password: "p" }
    });
    const msg = parseServerMessage(raw);
    expect(msg).toMatchObject({
      type: "admin.request",
      command: "probe.test_connection",
      input: { driver: "sqlserver" }
    });
  });

  it("rejects unknown admin command", () => {
    const raw = JSON.stringify({
      type: "admin.request",
      requestId: "req-3",
      command: "probe.unknown"
    });
    expect(() => parseServerMessage(raw)).toThrow(/Unsupported admin command/);
  });

  it("still accepts schema.listTables for backward compatibility", () => {
    const raw = JSON.stringify({
      type: "admin.request",
      requestId: "req-4",
      command: "schema.listTables"
    });
    const msg = parseServerMessage(raw);
    expect(msg).toMatchObject({ command: "schema.listTables" });
  });

  it("builds success response with arbitrary payload shape", () => {
    const built = buildAdminSuccessResponseMessage({
      requestId: "req-5",
      command: "probe.engines",
      payload: { engines: [{ kind: "sqlserver", confidence: "high", evidence: [] }] },
      probeVersion: "1"
    });
    expect(built).toMatchObject({
      type: "admin.response",
      command: "probe.engines",
      ok: true,
      payload: { engines: [{ kind: "sqlserver" }] },
      probeVersion: "1"
    });
  });
});
```

- [ ] **Step 1.2: Rodar — devem falhar**

Run: `npx vitest run tests/transport/protocol.test.ts`
Expected: FAIL — `Unsupported admin command` para `probe.engines`, e `buildAdminSuccessResponseMessage` com payload livre não compila.

- [ ] **Step 1.3: Estender `AdminCommand` e `AdminRequestMessage`**

Modify `src/transport/protocol.ts:11`:

```ts
export type AdminCommand =
  | "schema.listTables"
  | "probe.engines"
  | "probe.odbc_dsns"
  | "probe.network"
  | "probe.test_connection";
```

Modify `AdminRequestMessage` (linhas 39-44):

```ts
export interface AdminRequestMessage {
  type: "admin.request";
  requestId: string;
  command: AdminCommand;
  input?: unknown;
  sentAt?: string;
}
```

- [ ] **Step 1.4: Generalizar `AdminResponseSuccessPayload` e helpers de build**

Modify a tipagem do success payload e response (linhas 117-143):

```ts
export type AdminResponseSuccessPayload = unknown;

export interface AdminResponseErrorPayload {
  errorCode: string;
  message: string;
}

interface AdminResponseBaseMessage {
  type: "admin.response";
  requestId: string;
  command: AdminCommand;
  sentAt: string;
  probeVersion?: string;
}

export interface AdminResponseSuccessMessage extends AdminResponseBaseMessage {
  ok: true;
  payload: AdminResponseSuccessPayload;
}

export interface AdminResponseErrorMessage extends AdminResponseBaseMessage {
  ok: false;
  error: AdminResponseErrorPayload;
}

export type AdminResponseMessage = AdminResponseSuccessMessage | AdminResponseErrorMessage;
```

- [ ] **Step 1.5: Atualizar `parseAdminCommand` e `parseAdminRequest`**

Modify `parseAdminCommand` (linhas 463-469):

```ts
const ADMIN_COMMANDS = new Set<AdminCommand>([
  "schema.listTables",
  "probe.engines",
  "probe.odbc_dsns",
  "probe.network",
  "probe.test_connection"
]);

function parseAdminCommand(value: unknown): AdminCommand {
  const command = expectString(value, "command");
  if (!ADMIN_COMMANDS.has(command as AdminCommand)) {
    throw new ProtocolParseError(`Unsupported admin command: ${command}`);
  }
  return command as AdminCommand;
}
```

Modify `parseAdminRequest` (linhas 454-461):

```ts
function parseAdminRequest(message: Record<string, unknown>): AdminRequestMessage {
  const base: AdminRequestMessage = {
    type: "admin.request",
    requestId: validateRequestId(expectString(message.requestId, "requestId")),
    command: parseAdminCommand(message.command),
    sentAt: optionalString(message.sentAt, "sentAt")
  };
  if (message.input !== undefined) {
    base.input = message.input;
  }
  return base;
}
```

- [ ] **Step 1.6: Atualizar `buildAdminSuccessResponseMessage` para aceitar payload livre**

Modify `buildAdminSuccessResponseMessage` (linhas 373-391):

```ts
export function buildAdminSuccessResponseMessage(
  input: {
    requestId: string;
    command: AdminCommand;
    payload: AdminResponseSuccessPayload;
    probeVersion?: string;
  },
  sentAt = new Date().toISOString()
): AdminResponseMessage {
  const message: AdminResponseSuccessMessage = {
    type: "admin.response",
    requestId: validateRequestId(input.requestId),
    command: input.command,
    ok: true,
    payload: input.payload,
    sentAt
  };
  if (input.probeVersion !== undefined) {
    message.probeVersion = input.probeVersion;
  }
  return message;
}
```

- [ ] **Step 1.7: Atualizar `parseAdminResponseMessage` para aceitar payload livre**

Modify `parseAdminResponseMessage` (linhas 182-218) — remova a validação que exige `tables: string[]` e aceite payload arbitrário:

```ts
export function parseAdminResponseMessage(raw: string | Buffer | ArrayBuffer | Buffer[]): AdminResponseMessage {
  const value = parseJson(raw);
  const message = expectRecord(value, "message");
  const type = expectString(message.type, "type");
  if (type !== "admin.response") {
    throw new ProtocolParseError(`Unsupported connector message type: ${type}`);
  }

  const base = {
    type: "admin.response" as const,
    requestId: validateRequestId(expectString(message.requestId, "requestId")),
    command: parseAdminCommand(message.command),
    sentAt: expectString(message.sentAt, "sentAt")
  };
  const ok = expectBoolean(message.ok, "ok");

  if (ok) {
    return {
      ...base,
      ok,
      payload: message.payload as AdminResponseSuccessPayload,
      ...(typeof message.probeVersion === "string" ? { probeVersion: message.probeVersion } : {})
    };
  }

  const error = expectRecord(message.error, "error");
  return {
    ...base,
    ok,
    error: {
      errorCode: expectString(error.errorCode, "error.errorCode"),
      message: expectString(error.message, "error.message")
    }
  };
}
```

- [ ] **Step 1.8: Atualizar callsite de `buildAdminSuccessResponseMessage` no runtime**

Localize no `src/service/runtime.ts` onde é chamado `buildAdminSuccessResponseMessage({ requestId, command, tables: ... })`. Atualize para nova assinatura:

```ts
buildAdminSuccessResponseMessage({
  requestId: req.requestId,
  command: req.command,
  payload: { tables }
})
```

- [ ] **Step 1.9: Rodar testes do protocolo — devem passar**

Run: `npx vitest run tests/transport/protocol.test.ts`
Expected: PASS para todos os novos casos + casos antigos.

- [ ] **Step 1.10: Rodar suite completa**

Run: `npm test`
Expected: PASS — nenhum teste antigo quebra. (Se algum teste exigia `payload: { tables }` específico para `schema.listTables`, ele continua válido — payload livre aceita esse shape.)

- [ ] **Step 1.11: Commit**

```bash
git add src/transport/protocol.ts src/service/runtime.ts tests/transport/protocol.test.ts
git commit -m "feat(protocol): admin.request aceita input e payload livre por comando"
```

---

## Task 2: Criar `src/discovery/types.ts` e `error-codes.ts`

**Files:**
- Create: `src/discovery/types.ts`
- Create: `src/discovery/error-codes.ts`
- Create: `tests/discovery/error-codes.test.ts`

- [ ] **Step 2.1: Criar `src/discovery/types.ts`**

Create `src/discovery/types.ts`:

```ts
import type { RegistryReader } from "../db/registry-reader.js";
import type { FileSystemReader } from "./fs-reader.js";

export interface WindowsService {
  name: string;
  state: "running" | "stopped" | "unknown";
}

export interface ProbeContext {
  registry: RegistryReader;
  fs: FileSystemReader;
  serviceList: () => Promise<WindowsService[]>;
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

- [ ] **Step 2.2: Escrever teste para `categorizeError`**

Create `tests/discovery/error-codes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { categorizeError, DriverMissingError } from "../../src/discovery/error-codes.js";

describe("categorizeError", () => {
  it("classifies driver missing", () => {
    expect(categorizeError(new DriverMissingError("mssql"))).toBe("driver_missing");
  });

  it("classifies timeout via ETIMEDOUT message", () => {
    expect(categorizeError(new Error("connect ETIMEDOUT 1433"))).toBe("timeout");
  });

  it("classifies timeout via timeout keyword", () => {
    expect(categorizeError(new Error("Query timeout after 5000ms"))).toBe("timeout");
  });

  it("classifies unreachable via ECONNREFUSED", () => {
    expect(categorizeError(new Error("connect ECONNREFUSED 127.0.0.1:5432"))).toBe("unreachable");
  });

  it("classifies unreachable via host unreachable", () => {
    expect(categorizeError(new Error("Host unreachable"))).toBe("unreachable");
  });

  it("classifies auth via login failed message", () => {
    expect(categorizeError(new Error("Login failed for user 'sa'"))).toBe("auth");
  });

  it("classifies auth via SQLSTATE 28000", () => {
    expect(categorizeError(new Error("[28000] authentication failed"))).toBe("auth");
  });

  it("classifies auth via password keyword", () => {
    expect(categorizeError(new Error("invalid password"))).toBe("auth");
  });

  it("classifies tls via certificate keyword", () => {
    expect(categorizeError(new Error("self-signed certificate in chain"))).toBe("tls");
  });

  it("classifies tls via SSL keyword", () => {
    expect(categorizeError(new Error("SSL handshake failed"))).toBe("tls");
  });

  it("classifies tls via TLS keyword", () => {
    expect(categorizeError(new Error("TLS protocol error"))).toBe("tls");
  });

  it("falls back to unknown when no category matches", () => {
    expect(categorizeError(new Error("Out of memory"))).toBe("unknown");
  });

  it("handles non-Error inputs without throwing", () => {
    expect(categorizeError("plain string")).toBe("unknown");
    expect(categorizeError(undefined)).toBe("unknown");
    expect(categorizeError(null)).toBe("unknown");
    expect(categorizeError(42)).toBe("unknown");
  });
});
```

- [ ] **Step 2.3: Rodar — devem falhar**

Run: `npx vitest run tests/discovery/error-codes.test.ts`
Expected: FAIL — `Cannot find module`.

- [ ] **Step 2.4: Criar `src/discovery/error-codes.ts`**

Create `src/discovery/error-codes.ts`:

```ts
import type { ProbeErrorCode } from "./types.js";

export class DriverMissingError extends Error {
  public readonly driver: string;

  public constructor(driver: string) {
    super(`Driver package missing: ${driver}`);
    this.name = "DriverMissingError";
    this.driver = driver;
  }
}

export function categorizeError(err: unknown): ProbeErrorCode {
  if (err instanceof DriverMissingError) return "driver_missing";

  const msg = readMessage(err).toLowerCase();
  if (msg.length === 0) return "unknown";

  if (msg.includes("etimedout") || msg.includes("timeout") || msg.includes("timed out")) {
    return "timeout";
  }
  if (msg.includes("econnrefused") || msg.includes("unreachable") || msg.includes("enotfound")) {
    return "unreachable";
  }
  if (msg.includes("ssl") || msg.includes("tls") || msg.includes("certificate")) {
    return "tls";
  }
  if (
    msg.includes("login failed") ||
    msg.includes("28000") ||
    msg.includes("password") ||
    msg.includes("access denied") ||
    msg.includes("authentication")
  ) {
    return "auth";
  }
  return "unknown";
}

function readMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const value = (err as { message?: unknown }).message;
    if (typeof value === "string") return value;
  }
  return "";
}
```

- [ ] **Step 2.5: Rodar — devem passar**

Run: `npx vitest run tests/discovery/error-codes.test.ts`
Expected: PASS para todos.

- [ ] **Step 2.6: Commit**

```bash
git add src/discovery/types.ts src/discovery/error-codes.ts tests/discovery/error-codes.test.ts
git commit -m "feat(discovery): tipos compartilhados e categorizacao de erros"
```

---

## Task 3: Criar `FileSystemReader` interface + implementação default

**Files:**
- Create: `src/discovery/fs-reader.ts`

- [ ] **Step 3.1: Criar interface e implementação default**

Create `src/discovery/fs-reader.ts`:

```ts
import { promises as fs } from "node:fs";

export interface FsStat {
  isFile: boolean;
  isDirectory: boolean;
}

export interface FileSystemReader {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  listDir(path: string): Promise<string[]>;
  stat(path: string): Promise<FsStat | undefined>;
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
  }
};
```

- [ ] **Step 3.2: Verificar build TS**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: sem erros.

- [ ] **Step 3.3: Commit**

```bash
git add src/discovery/fs-reader.ts
git commit -m "feat(discovery): interface FileSystemReader com implementacao node"
```

---

## Task 4: Criar `listWindowsServices` via `sc query`

**Files:**
- Create: `src/discovery/service-list.ts`
- Create: `tests/discovery/service-list.test.ts`

- [ ] **Step 4.1: Escrever teste com parser puro**

Create `tests/discovery/service-list.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseScQueryOutput } from "../../src/discovery/service-list.js";

describe("parseScQueryOutput", () => {
  it("parses sc query output with multiple services", () => {
    const raw = `
SERVICE_NAME: MSSQLSERVER
DISPLAY_NAME: SQL Server (MSSQLSERVER)
        TYPE               : 10  WIN32_OWN_PROCESS
        STATE              : 4  RUNNING
                                (STOPPABLE, PAUSABLE, ACCEPTS_SHUTDOWN)
        WIN32_EXIT_CODE    : 0  (0x0)

SERVICE_NAME: SQLBrowser
DISPLAY_NAME: SQL Server Browser
        TYPE               : 10  WIN32_OWN_PROCESS
        STATE              : 1  STOPPED
        WIN32_EXIT_CODE    : 0  (0x0)
`.trim();
    expect(parseScQueryOutput(raw)).toEqual([
      { name: "MSSQLSERVER", state: "running" },
      { name: "SQLBrowser", state: "stopped" }
    ]);
  });

  it("returns empty list for empty or malformed output", () => {
    expect(parseScQueryOutput("")).toEqual([]);
    expect(parseScQueryOutput("no services here")).toEqual([]);
  });

  it("marks unrecognized state as unknown", () => {
    const raw = `SERVICE_NAME: WeirdSvc\nDISPLAY_NAME: X\n  STATE              : 7  PAUSED\n`;
    expect(parseScQueryOutput(raw)).toEqual([{ name: "WeirdSvc", state: "unknown" }]);
  });
});
```

- [ ] **Step 4.2: Criar `service-list.ts`**

Create `src/discovery/service-list.ts`:

```ts
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
```

- [ ] **Step 4.3: Rodar — devem passar**

Run: `npx vitest run tests/discovery/service-list.test.ts`
Expected: PASS.

- [ ] **Step 4.4: Commit**

```bash
git add src/discovery/service-list.ts tests/discovery/service-list.test.ts
git commit -m "feat(discovery): listWindowsServices via sc query"
```

---

## Task 5: Probe `probeEngines`

**Files:**
- Create: `src/discovery/engines.ts`
- Create: `tests/discovery/engines.test.ts`

- [ ] **Step 5.1: Escrever testes completos**

Create `tests/discovery/engines.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { probeEngines } from "../../src/discovery/engines.js";
import type { ProbeContext } from "../../src/discovery/types.js";
import type { FileSystemReader } from "../../src/discovery/fs-reader.js";

function makeContext(overrides: Partial<ProbeContext> = {}): ProbeContext {
  const defaultFs: FileSystemReader = {
    readFile: vi.fn(async () => ""),
    listDir: vi.fn(async () => []),
    stat: vi.fn(async () => undefined)
  };
  return {
    registry: { readKey: vi.fn(async () => ({})) } as never,
    fs: defaultFs,
    serviceList: vi.fn(async () => []),
    signal: new AbortController().signal,
    ...overrides
  };
}

describe("probeEngines", () => {
  it("detects SQL Server via service + port + dll evidence with high confidence", async () => {
    const ctx = makeContext({
      serviceList: vi.fn(async () => [{ name: "MSSQLSERVER", state: "running" }]),
      fs: {
        readFile: vi.fn(async () => ""),
        listDir: vi.fn(async () => []),
        stat: vi.fn(async (path: string) => {
          if (path.toLowerCase().includes("msodbcsql")) return { isFile: true, isDirectory: false };
          return undefined;
        })
      }
    });

    const engines = await probeEngines(ctx, { tcpProbe: async (host, port) => port === 1433 });
    const sqlserver = engines.find((e) => e.kind === "sqlserver");
    expect(sqlserver).toBeDefined();
    expect(sqlserver?.confidence).toBe("high");
    expect(sqlserver?.evidence).toEqual(
      expect.arrayContaining([
        expect.stringContaining("service:MSSQLSERVER"),
        "port:1433",
        expect.stringContaining("dll:")
      ])
    );
  });

  it("detects Postgres via service alone with low confidence", async () => {
    const ctx = makeContext({
      serviceList: vi.fn(async () => [{ name: "postgresql-x64-14", state: "running" }])
    });

    const engines = await probeEngines(ctx, { tcpProbe: async () => false });
    const postgres = engines.find((e) => e.kind === "postgresql");
    expect(postgres).toBeDefined();
    expect(postgres?.confidence).toBe("low");
    expect(postgres?.evidence).toEqual(["service:postgresql-x64-14"]);
  });

  it("detects Firebird via dll alone", async () => {
    const ctx = makeContext({
      fs: {
        readFile: vi.fn(async () => ""),
        listDir: vi.fn(async () => []),
        stat: vi.fn(async (path: string) =>
          path.toLowerCase().endsWith("gds32.dll") ? { isFile: true, isDirectory: false } : undefined
        )
      }
    });
    const engines = await probeEngines(ctx, { tcpProbe: async () => false });
    expect(engines).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "firebird" })]));
  });

  it("returns empty list when no evidence found", async () => {
    const ctx = makeContext();
    const engines = await probeEngines(ctx, { tcpProbe: async () => false });
    expect(engines).toEqual([]);
  });

  it("does not throw if serviceList rejects", async () => {
    const ctx = makeContext({
      serviceList: vi.fn(async () => {
        throw new Error("sc.exe not available");
      })
    });
    await expect(probeEngines(ctx, { tcpProbe: async () => false })).resolves.toEqual([]);
  });
});
```

- [ ] **Step 5.2: Criar `src/discovery/engines.ts`**

Create `src/discovery/engines.ts`:

```ts
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
      "C\\Program Files\\Microsoft SQL Server",
      "C\\Windows\\System32\\sqlncli11.dll",
      "C\\Windows\\System32\\msodbcsql17.dll",
      "C\\Windows\\System32\\msodbcsql18.dll"
    ]
  },
  {
    kind: "postgresql",
    servicePatterns: [/^postgresql-x64-\d+$/i, /^postgresql-\d+$/i],
    ports: [5432],
    dllPaths: ["C\\Windows\\System32\\libpq.dll"]
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
      "C\\Windows\\System32\\gds32.dll",
      "C\\Windows\\System32\\fbclient.dll"
    ]
  }
];

export interface ProbeEnginesOptions {
  tcpProbe: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
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
      const stat = await ctx.fs.stat(dll.replace(/\\\\/g, "\\"));
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
```

- [ ] **Step 5.3: Rodar — devem passar**

Run: `npx vitest run tests/discovery/engines.test.ts`
Expected: PASS.

- [ ] **Step 5.4: Commit**

```bash
git add src/discovery/engines.ts tests/discovery/engines.test.ts
git commit -m "feat(discovery): probeEngines detecta engines via service/port/dll"
```

---

## Task 6: Probe `probeNetwork`

**Files:**
- Create: `src/discovery/network.ts`
- Create: `tests/discovery/network.test.ts`

- [ ] **Step 6.1: Escrever teste para `tcpProbe` (que será reusado por `probeEngines`)**

Create `tests/discovery/network.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import * as net from "node:net";
import { probeNetwork, tcpProbe } from "../../src/discovery/network.js";

describe("tcpProbe", () => {
  it("returns true for an open port on localhost", async () => {
    const server = net.createServer().listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as net.AddressInfo).port;

    const open = await tcpProbe("127.0.0.1", port, 500);
    expect(open).toBe(true);

    server.close();
  });

  it("returns false for a closed port within timeout", async () => {
    const open = await tcpProbe("127.0.0.1", 1, 500);
    expect(open).toBe(false);
  });
});

describe("probeNetwork", () => {
  it("reports reachable with latency when port is open", async () => {
    const server = net.createServer().listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as net.AddressInfo).port;

    const result = await probeNetwork({ host: "127.0.0.1", port, timeoutMs: 500 });
    expect(result.reachable).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    server.close();
  });

  it("reports refused for a closed port", async () => {
    const result = await probeNetwork({ host: "127.0.0.1", port: 1, timeoutMs: 500 });
    expect(result.reachable).toBe(false);
    expect(result.error).toMatch(/refused|unreachable/);
  });

  it("reports timeout for an unroutable address", async () => {
    const result = await probeNetwork({ host: "10.255.255.1", port: 1, timeoutMs: 200 });
    expect(result.reachable).toBe(false);
    expect(result.error).toBe("timeout");
  });
});
```

- [ ] **Step 6.2: Criar `src/discovery/network.ts`**

Create `src/discovery/network.ts`:

```ts
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
```

- [ ] **Step 6.3: Rodar — devem passar**

Run: `npx vitest run tests/discovery/network.test.ts`
Expected: PASS.

- [ ] **Step 6.4: Commit**

```bash
git add src/discovery/network.ts tests/discovery/network.test.ts
git commit -m "feat(discovery): probeNetwork e tcpProbe via node:net"
```

---

## Task 7: Probe `probeOdbcDsns` (generalização)

**Files:**
- Create: `src/discovery/odbc-dsns.ts`
- Modify: `src/db/dsn-discovery.ts` (refatorar para usar a função nova)
- Create: `tests/discovery/odbc-dsns.test.ts`

- [ ] **Step 7.1: Escrever testes**

Create `tests/discovery/odbc-dsns.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { probeOdbcDsns } from "../../src/discovery/odbc-dsns.js";

describe("probeOdbcDsns", () => {
  it("returns all DSNs from HKLM and HKCU regardless of driver", async () => {
    const reader = {
      readKey: vi.fn(async (path: string) => {
        if (path === "HKLM\\Software\\ODBC\\ODBC.INI\\ODBC Data Sources") {
          return { LINX_PG: "PostgreSQL Unicode", ORACLE_SRC: "Oracle ODBC Driver" };
        }
        if (path === "HKCU\\Software\\ODBC\\ODBC.INI\\ODBC Data Sources") {
          return { USER_DSN: "Microsoft Access Driver" };
        }
        if (path === "HKLM\\Software\\ODBC\\ODBC.INI\\LINX_PG") {
          return { Driver: "PSQLODBC", Servername: "10.0.0.5", Port: "5432", Database: "linx", Username: "ro" };
        }
        if (path === "HKLM\\Software\\ODBC\\ODBC.INI\\ORACLE_SRC") {
          return { Driver: "Oracle ODBC Driver", Servername: "orcl.local" };
        }
        if (path === "HKCU\\Software\\ODBC\\ODBC.INI\\USER_DSN") {
          return { Driver: "C:\\Windows\\System32\\odbcjt32.dll", DBQ: "C:\\data\\old.mdb" };
        }
        return {};
      })
    };

    const dsns = await probeOdbcDsns(reader);
    expect(dsns).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "LINX_PG",
        driver: "PSQLODBC",
        host: "10.0.0.5",
        port: 5432,
        database: "linx",
        user: "ro"
      }),
      expect.objectContaining({ name: "ORACLE_SRC", driver: "Oracle ODBC Driver", host: "orcl.local" }),
      expect.objectContaining({ name: "USER_DSN", driver: expect.stringContaining("odbcjt32") })
    ]));
  });

  it("dedupes DSN names appearing in both hives (HKLM wins)", async () => {
    const reader = {
      readKey: vi.fn(async (path: string) => {
        if (path.endsWith("ODBC Data Sources") && path.startsWith("HKLM"))
          return { DUP: "PSQLODBC" };
        if (path.endsWith("ODBC Data Sources") && path.startsWith("HKCU"))
          return { DUP: "MariaDB ODBC" };
        if (path === "HKLM\\Software\\ODBC\\ODBC.INI\\DUP")
          return { Driver: "PSQLODBC", Servername: "machine.local" };
        return {};
      })
    };
    const dsns = await probeOdbcDsns(reader);
    expect(dsns).toHaveLength(1);
    expect(dsns[0]).toMatchObject({ name: "DUP", driver: "PSQLODBC", host: "machine.local" });
  });

  it("returns empty list and swallows errors gracefully", async () => {
    const reader = {
      readKey: vi.fn(async () => {
        throw new Error("registry access denied");
      })
    };
    await expect(probeOdbcDsns(reader)).resolves.toEqual([]);
  });
});
```

- [ ] **Step 7.2: Criar `src/discovery/odbc-dsns.ts`**

Create `src/discovery/odbc-dsns.ts`:

```ts
import type { RegistryReader } from "../db/registry-reader.js";

export interface OdbcDsnCandidate {
  name: string;
  driver: string;
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

export async function probeOdbcDsns(reader: RegistryReader): Promise<OdbcDsnCandidate[]> {
  try {
    const seen = new Set<string>();
    const result: OdbcDsnCandidate[] = [];

    for (let i = 0; i < ODBC_INI_INDEXES.length; i += 1) {
      const indexPath = ODBC_INI_INDEXES[i];
      const parentPath = ODBC_INI_PARENTS[i];
      if (!indexPath || !parentPath) continue;

      let index: Record<string, string> = {};
      try {
        index = await reader.readKey(indexPath);
      } catch {
        index = {};
      }

      for (const [dsnName, driverDescription] of Object.entries(index)) {
        if (seen.has(dsnName)) continue;
        let values: Record<string, string> = {};
        try {
          values = await reader.readKey(`${parentPath}\\${dsnName}`);
        } catch {
          values = {};
        }
        seen.add(dsnName);
        result.push(buildCandidate(dsnName, values, driverDescription));
      }
    }

    return result;
  } catch {
    return [];
  }
}

function buildCandidate(
  dsnName: string,
  values: Record<string, string>,
  driverDescription: string
): OdbcDsnCandidate {
  const candidate: OdbcDsnCandidate = {
    name: dsnName,
    driver: (values.Driver ?? driverDescription ?? "").trim()
  };

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
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) return undefined;
  return parsed;
}
```

- [ ] **Step 7.3: Refatorar `src/db/dsn-discovery.ts` para chamar a função nova**

Modify `src/db/dsn-discovery.ts` (reescrita completa, mantendo a API pública `discoverPostgresDsns` e `PostgresDsnCandidate`):

```ts
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
```

- [ ] **Step 7.4: Rodar testes existentes de `dsn-discovery` (não devem quebrar)**

Run: `npx vitest run tests/db/dsn-discovery.test.ts`
Expected: PASS — comportamento de `discoverPostgresDsns` preservado.

- [ ] **Step 7.5: Rodar testes novos**

Run: `npx vitest run tests/discovery/odbc-dsns.test.ts`
Expected: PASS.

- [ ] **Step 7.6: Commit**

```bash
git add src/discovery/odbc-dsns.ts src/db/dsn-discovery.ts tests/discovery/odbc-dsns.test.ts
git commit -m "feat(discovery): probeOdbcDsns generalizado e dsn-discovery refatorado"
```

---

## Task 8: Probe `probeTestConnection`

**Files:**
- Create: `src/discovery/test-connection.ts`
- Create: `tests/discovery/test-connection.test.ts`

- [ ] **Step 8.1: Escrever testes**

Create `tests/discovery/test-connection.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { probeTestConnection, type TestConnectionInput } from "../../src/discovery/test-connection.js";
import type { SourceDatabaseAdapter } from "../../src/db/source-adapter.js";

const baseInput: TestConnectionInput = {
  driver: "sqlserver",
  host: "10.0.0.1",
  port: 1433,
  database: "db",
  user: "u",
  password: "p"
};

function makeAdapter(overrides: Partial<SourceDatabaseAdapter> = {}): SourceDatabaseAdapter {
  return {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    queryChanges: vi.fn(async () => []),
    querySnapshotPage: vi.fn(async () => []),
    listTables: vi.fn(async () => []),
    listColumns: vi.fn(async () => []),
    ...overrides
  };
}

describe("probeTestConnection", () => {
  it("returns ok with latency on successful probe", async () => {
    const adapter = makeAdapter();
    const result = await probeTestConnection(baseInput, {
      createAdapter: () => adapter,
      timeoutMs: 1000
    });
    expect(result).toMatchObject({ ok: true });
    expect(result).toHaveProperty("latencyMs");
    expect(adapter.connect).toHaveBeenCalled();
    expect(adapter.listTables).toHaveBeenCalled();
    expect(adapter.close).toHaveBeenCalled();
  });

  it("categorizes auth failure", async () => {
    const adapter = makeAdapter({
      connect: vi.fn(async () => {
        throw new Error("Login failed for user 'sa'");
      })
    });
    const result = await probeTestConnection(baseInput, {
      createAdapter: () => adapter,
      timeoutMs: 1000
    });
    expect(result).toMatchObject({ ok: false, code: "auth" });
  });

  it("categorizes unreachable failure", async () => {
    const adapter = makeAdapter({
      connect: vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.1:1433");
      })
    });
    const result = await probeTestConnection(baseInput, {
      createAdapter: () => adapter,
      timeoutMs: 1000
    });
    expect(result).toMatchObject({ ok: false, code: "unreachable" });
  });

  it("categorizes driver_missing", async () => {
    const { DriverMissingError } = await import("../../src/discovery/error-codes.js");
    const adapter = makeAdapter({
      connect: vi.fn(async () => {
        throw new DriverMissingError("mssql");
      })
    });
    const result = await probeTestConnection(baseInput, {
      createAdapter: () => adapter,
      timeoutMs: 1000
    });
    expect(result).toMatchObject({ ok: false, code: "driver_missing" });
  });

  it("times out long-running connect attempts", async () => {
    const adapter = makeAdapter({
      connect: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, 1000);
          })
      )
    });
    const result = await probeTestConnection(baseInput, {
      createAdapter: () => adapter,
      timeoutMs: 50
    });
    expect(result).toMatchObject({ ok: false, code: "timeout" });
  });

  it("always closes the adapter even on listTables failure", async () => {
    const close = vi.fn(async () => undefined);
    const adapter = makeAdapter({
      listTables: vi.fn(async () => {
        throw new Error("permission denied");
      }),
      close
    });
    const result = await probeTestConnection(baseInput, {
      createAdapter: () => adapter,
      timeoutMs: 1000
    });
    expect(result.ok).toBe(false);
    expect(close).toHaveBeenCalled();
  });

  it("redacts password from any error message returned", async () => {
    const adapter = makeAdapter({
      connect: vi.fn(async () => {
        throw new Error("invalid password 'p' for 'u'");
      })
    });
    const result = await probeTestConnection(baseInput, {
      createAdapter: () => adapter,
      timeoutMs: 1000
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain("'p'");
    }
  });
});
```

- [ ] **Step 8.2: Criar `src/discovery/test-connection.ts`**

Create `src/discovery/test-connection.ts`:

```ts
import type { SourceDatabaseAdapter } from "../db/source-adapter.js";
import type { DatabaseConfig, DatabaseDriver } from "../config/types.js";
import { categorizeError, type ProbeErrorCode } from "./error-codes.js";

export interface TestConnectionInput {
  driver: DatabaseDriver;
  host?: string;
  port?: number;
  instance?: string;
  database?: string;
  user?: string;
  password?: string;
  dsn?: string;
  connectionString?: string;
  trustServerCertificate?: boolean;
}

export type TestConnectionResult =
  | { ok: true; latencyMs: number; serverVersion?: string }
  | { ok: false; code: ProbeErrorCode; message: string };

export interface ProbeTestConnectionOptions {
  createAdapter: (config: DatabaseConfig) => SourceDatabaseAdapter;
  timeoutMs: number;
}

export async function probeTestConnection(
  input: TestConnectionInput,
  options: ProbeTestConnectionOptions
): Promise<TestConnectionResult> {
  const start = Date.now();
  const password = input.password ?? "";
  const secrets = [password].filter((s) => s.length > 0);

  const config: DatabaseConfig = {
    driver: input.driver,
    host: input.host ?? "",
    port: input.port ?? 0,
    name: input.database ?? "",
    user: input.user ?? "",
    password
  };
  if (input.instance) config.instance = input.instance;
  if (input.trustServerCertificate !== undefined) {
    config.trustServerCertificate = input.trustServerCertificate;
  }

  let adapter: SourceDatabaseAdapter | undefined;
  try {
    adapter = options.createAdapter(config);
    await withTimeout(adapter.connect(), options.timeoutMs);
    await withTimeout(adapter.listTables(), options.timeoutMs);
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    const code = categorizeError(err);
    const message = redact(readMessage(err), secrets);
    return { ok: false, code, message };
  } finally {
    if (adapter) {
      try {
        await adapter.close();
      } catch {
        /* ignore close errors */
      }
    }
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`probe timeout after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function readMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "probe failed";
}

function redact(message: string, secrets: string[]): string {
  let out = message;
  for (const s of secrets) {
    if (s.length === 0) continue;
    out = out.split(s).join("[REDACTED]");
  }
  return out;
}
```

- [ ] **Step 8.3: Rodar — devem passar**

Run: `npx vitest run tests/discovery/test-connection.test.ts`
Expected: PASS.

- [ ] **Step 8.4: Commit**

```bash
git add src/discovery/test-connection.ts tests/discovery/test-connection.test.ts
git commit -m "feat(discovery): probeTestConnection com timeout e categorizacao de erro"
```

---

## Task 9: Admin router

**Files:**
- Create: `src/discovery/admin-router.ts`
- Create: `tests/discovery/admin-router.test.ts`

- [ ] **Step 9.1: Escrever testes do router**

Create `tests/discovery/admin-router.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { handleAdminRequest, type AdminRouterDependencies } from "../../src/discovery/admin-router.js";
import type { AdminRequestMessage } from "../../src/transport/protocol.js";

function makeDeps(overrides: Partial<AdminRouterDependencies> = {}): AdminRouterDependencies {
  return {
    probeEngines: vi.fn(async () => [{ kind: "sqlserver", confidence: "high", evidence: ["service:MSSQLSERVER"] }]),
    probeOdbcDsns: vi.fn(async () => []),
    probeNetwork: vi.fn(async () => ({ reachable: true, latencyMs: 5 })),
    probeTestConnection: vi.fn(async () => ({ ok: true, latencyMs: 12 })),
    schemaListTables: vi.fn(async () => ["products"]),
    ...overrides
  };
}

describe("handleAdminRequest", () => {
  it("dispatches probe.engines and returns success payload with probeVersion", async () => {
    const req: AdminRequestMessage = {
      type: "admin.request",
      requestId: "req-1",
      command: "probe.engines",
      input: {}
    };
    const res = await handleAdminRequest(req, makeDeps());
    expect(res).toMatchObject({
      type: "admin.response",
      requestId: "req-1",
      command: "probe.engines",
      ok: true,
      probeVersion: "1",
      payload: { engines: expect.any(Array) }
    });
  });

  it("dispatches probe.network with input", async () => {
    const probeNetwork = vi.fn(async () => ({ reachable: false, error: "timeout" as const }));
    const req: AdminRequestMessage = {
      type: "admin.request",
      requestId: "req-2",
      command: "probe.network",
      input: { host: "10.0.0.1", port: 1433, timeoutMs: 200 }
    };
    const res = await handleAdminRequest(req, makeDeps({ probeNetwork }));
    expect(probeNetwork).toHaveBeenCalledWith({ host: "10.0.0.1", port: 1433, timeoutMs: 200 });
    expect(res).toMatchObject({ ok: true, payload: { reachable: false, error: "timeout" } });
  });

  it("dispatches probe.test_connection with input", async () => {
    const probeTestConnection = vi.fn(async () => ({ ok: false, code: "auth" as const, message: "Login failed" }));
    const req: AdminRequestMessage = {
      type: "admin.request",
      requestId: "req-3",
      command: "probe.test_connection",
      input: { driver: "sqlserver", host: "h", port: 1433, database: "d", user: "u", password: "p" }
    };
    const res = await handleAdminRequest(req, makeDeps({ probeTestConnection }));
    expect(probeTestConnection).toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true, payload: { ok: false, code: "auth" } });
  });

  it("rejects probe.network with invalid input shape", async () => {
    const req: AdminRequestMessage = {
      type: "admin.request",
      requestId: "req-4",
      command: "probe.network",
      input: { host: "h" }
    };
    const res = await handleAdminRequest(req, makeDeps());
    expect(res).toMatchObject({
      ok: false,
      error: { errorCode: "INVALID_INPUT", message: expect.stringContaining("port") }
    });
  });

  it("rejects probe.test_connection without driver field", async () => {
    const req: AdminRequestMessage = {
      type: "admin.request",
      requestId: "req-5",
      command: "probe.test_connection",
      input: { host: "h" }
    };
    const res = await handleAdminRequest(req, makeDeps());
    expect(res).toMatchObject({ ok: false, error: { errorCode: "INVALID_INPUT" } });
  });

  it("returns INTERNAL_ERROR when probe throws unexpectedly", async () => {
    const probeEngines = vi.fn(async () => {
      throw new Error("registry corrupted");
    });
    const req: AdminRequestMessage = {
      type: "admin.request",
      requestId: "req-6",
      command: "probe.engines"
    };
    const res = await handleAdminRequest(req, makeDeps({ probeEngines }));
    expect(res).toMatchObject({ ok: false, error: { errorCode: "INTERNAL_ERROR" } });
  });

  it("still supports schema.listTables for backward compatibility", async () => {
    const req: AdminRequestMessage = {
      type: "admin.request",
      requestId: "req-7",
      command: "schema.listTables"
    };
    const res = await handleAdminRequest(req, makeDeps());
    expect(res).toMatchObject({ ok: true, payload: { tables: ["products"] } });
  });
});
```

- [ ] **Step 9.2: Criar `src/discovery/admin-router.ts`**

Create `src/discovery/admin-router.ts`:

```ts
import {
  buildAdminErrorResponseMessage,
  buildAdminSuccessResponseMessage,
  type AdminRequestMessage,
  type AdminResponseMessage
} from "../transport/protocol.js";
import type { EngineCandidate } from "./engines.js";
import type { OdbcDsnCandidate } from "./odbc-dsns.js";
import type { ProbeNetworkInput, ProbeNetworkResult } from "./network.js";
import type { TestConnectionInput, TestConnectionResult } from "./test-connection.js";

const PROBE_VERSION = "1";

export interface AdminRouterDependencies {
  probeEngines: () => Promise<EngineCandidate[]>;
  probeOdbcDsns: () => Promise<OdbcDsnCandidate[]>;
  probeNetwork: (input: ProbeNetworkInput) => Promise<ProbeNetworkResult>;
  probeTestConnection: (input: TestConnectionInput) => Promise<TestConnectionResult>;
  schemaListTables: () => Promise<string[]>;
}

export async function handleAdminRequest(
  req: AdminRequestMessage,
  deps: AdminRouterDependencies
): Promise<AdminResponseMessage> {
  try {
    switch (req.command) {
      case "probe.engines": {
        const engines = await deps.probeEngines();
        return success(req, { engines });
      }
      case "probe.odbc_dsns": {
        const dsns = await deps.probeOdbcDsns();
        return success(req, { dsns });
      }
      case "probe.network": {
        const input = validateNetworkInput(req.input);
        if (input.error) return invalidInput(req, input.error);
        const result = await deps.probeNetwork(input.value);
        return success(req, result);
      }
      case "probe.test_connection": {
        const input = validateTestConnectionInput(req.input);
        if (input.error) return invalidInput(req, input.error);
        const result = await deps.probeTestConnection(input.value);
        return success(req, result);
      }
      case "schema.listTables": {
        const tables = await deps.schemaListTables();
        return success(req, { tables });
      }
      default:
        return invalidInput(req, `Unsupported command: ${(req as { command: string }).command}`);
    }
  } catch (err) {
    return buildAdminErrorResponseMessage({
      requestId: req.requestId,
      command: req.command,
      errorCode: "INTERNAL_ERROR",
      message: err instanceof Error ? err.message : "Internal error"
    });
  }
}

function success(
  req: AdminRequestMessage,
  payload: unknown
): AdminResponseMessage {
  return buildAdminSuccessResponseMessage({
    requestId: req.requestId,
    command: req.command,
    payload,
    probeVersion: PROBE_VERSION
  });
}

function invalidInput(req: AdminRequestMessage, message: string): AdminResponseMessage {
  return buildAdminErrorResponseMessage({
    requestId: req.requestId,
    command: req.command,
    errorCode: "INVALID_INPUT",
    message
  });
}

type Validated<T> = { value: T; error?: undefined } | { value?: undefined; error: string };

function validateNetworkInput(input: unknown): Validated<ProbeNetworkInput> {
  if (!isRecord(input)) return { error: "input must be an object" };
  const host = input.host;
  const port = input.port;
  const timeoutMs = input.timeoutMs ?? 3000;
  if (typeof host !== "string" || host.length === 0) return { error: "input.host must be a non-empty string" };
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: "input.port must be an integer between 1 and 65535" };
  }
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1) {
    return { error: "input.timeoutMs must be a positive integer" };
  }
  return { value: { host, port, timeoutMs } };
}

function validateTestConnectionInput(input: unknown): Validated<TestConnectionInput> {
  if (!isRecord(input)) return { error: "input must be an object" };
  const driver = input.driver;
  if (typeof driver !== "string" || driver.length === 0) {
    return { error: "input.driver is required" };
  }
  const out: TestConnectionInput = { driver: driver as TestConnectionInput["driver"] };
  for (const key of ["host", "instance", "database", "user", "password", "dsn", "connectionString"] as const) {
    const value = input[key];
    if (typeof value === "string") out[key] = value;
  }
  if (typeof input.port === "number" && Number.isInteger(input.port)) out.port = input.port;
  if (typeof input.trustServerCertificate === "boolean") {
    out.trustServerCertificate = input.trustServerCertificate;
  }
  return { value: out };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

- [ ] **Step 9.3: Rodar testes do router — devem passar**

Run: `npx vitest run tests/discovery/admin-router.test.ts`
Expected: PASS.

- [ ] **Step 9.4: Commit**

```bash
git add src/discovery/admin-router.ts tests/discovery/admin-router.test.ts
git commit -m "feat(discovery): admin-router despacha probes com validacao de input"
```

---

## Task 10: Wiring no runtime — substituir o handler atual de `admin.request` pelo `admin-router`

**Files:**
- Modify: `src/service/runtime.ts` (procurar onde `AdminRequestMessage` é tratada hoje — busca por `schema.listTables` e o `case` correspondente)

- [ ] **Step 10.1: Localizar o handler atual de admin.request**

Run: `grep -n "schema.listTables\|AdminRequestMessage\|handleAdminRequest" src/service/runtime.ts`
Expected: identificar a função que processa hoje o `admin.request` (provavelmente algo como `handleAdminRequestMessage` ou similar).

- [ ] **Step 10.2: Importar as dependências necessárias no topo de `runtime.ts`**

Adicionar imports (ajustar caminhos):

```ts
import { handleAdminRequest } from "../discovery/admin-router.js";
import { probeEngines } from "../discovery/engines.js";
import { probeOdbcDsns } from "../discovery/odbc-dsns.js";
import { probeNetwork, tcpProbe } from "../discovery/network.js";
import { probeTestConnection } from "../discovery/test-connection.js";
import { listWindowsServices } from "../discovery/service-list.js";
import { nodeFileSystemReader } from "../discovery/fs-reader.js";
import { createSourceDatabaseAdapter } from "../db/adapter-factory.js";
```

- [ ] **Step 10.3: Construir o `AdminRouterDependencies` reaproveitando o adapter atual quando aplicável**

Dentro da inicialização do runtime, montar o objeto que injetará as dependências no router. Substituir o handler atual de `admin.request` por algo como:

```ts
const adminRouterDeps = {
  probeEngines: () => probeEngines(
    {
      registry: registryReader,
      fs: nodeFileSystemReader,
      serviceList: listWindowsServices,
      signal: new AbortController().signal
    },
    { tcpProbe }
  ),
  probeOdbcDsns: () => probeOdbcDsns(registryReader),
  probeNetwork,
  probeTestConnection: (input) =>
    probeTestConnection(input, {
      createAdapter: (config) =>
        createSourceDatabaseAdapter({
          config,
          dependencies: this.adapterDependencies
        }),
      timeoutMs: 5000
    }),
  schemaListTables: async () => {
    if (!this.sourceAdapter) return [];
    const tables = await this.sourceAdapter.listTables();
    return tables.map((t) => t.name);
  }
};
```

(Ajustar `this.adapterDependencies` / `this.sourceAdapter` aos nomes reais usados no `Runtime` — verificar com o `grep` anterior.)

E no callback de `admin.request` (substituir o switch atual):

```ts
const adminResponse = await handleAdminRequest(adminRequest, adminRouterDeps);
this.transport.sendAdminResponse(adminResponse);
```

(Verificar se existe `sendAdminResponse` no transport; se o método atual for outro, ajustar.)

- [ ] **Step 10.4: Verificar build TS**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: sem erros novos.

- [ ] **Step 10.5: Rodar suite completa**

Run: `npm test`
Expected: PASS — testes do `runtime` que cobrem `admin.request` (schema.listTables) continuam passando porque o router faz fallback para `schemaListTables`.

- [ ] **Step 10.6: Commit**

```bash
git add src/service/runtime.ts
git commit -m "feat(runtime): admin.request despacha via admin-router com probes"
```

---

## Verificação final

- [ ] **Step F.1: Rodar suite completa**

Run: `npm test`
Expected: 0 failures.

- [ ] **Step F.2: Build de produção**

Run: `npm run build`
Expected: 0 erros TS.

- [ ] **Step F.3: Verificar git log**

Run: `git log --oneline -15`
Expected: 10 commits criados na ordem das tasks.
