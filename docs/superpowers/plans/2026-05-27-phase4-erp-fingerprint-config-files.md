# Fase 4 — ERP Fingerprint + Config Files Probes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar dois probes que permitem ao painel identificar ERPs conhecidos instalados no cliente (`probe.erp_fingerprint`) e extrair candidatos a connection string de arquivos de config desses ERPs (`probe.config_files`), sem nunca devolver valores que pareçam senha.

**Architecture:** Tabela de assinaturas (`src/discovery/erp-signatures.ts`) com lista crescente de ERPs (começa com `linx-big`, `totvs-protheus`). `probeErpFingerprint` cruza marcadores (file/dir/registry/service) com o que está presente. `probeConfigFiles` recebe lista de paths, parseia formatos comuns (`.ini`, `.xml`, `.json`, `.properties`, `.config`) e devolve pares chave/valor relevantes, marcando `looksLikeSecret: true` (sem valor) para chaves de senha. Ambos os probes são registrados no `admin-router`.

**Tech Stack:** TypeScript (ESM), vitest. Adiciona dep `ini` (parser leve do formato INI; ~30KB, zero deps).

**Spec:** `docs/superpowers/specs/2026-05-27-discovery-multi-erp-design.md` (Seções "3.3 probeErpFingerprint" e "3.4 probeConfigFiles").

**Depende de:** Fase 2 (`ProbeContext`, `FileSystemReader`, `admin-router`).

---

## File Structure

**Novos arquivos:**
- `src/discovery/erp-signatures.ts` — tabela de assinaturas conhecidas
- `src/discovery/erp-fingerprint.ts` — `probeErpFingerprint`
- `src/discovery/config-files.ts` — `probeConfigFiles`
- `tests/discovery/erp-fingerprint.test.ts`
- `tests/discovery/config-files.test.ts`

**Modificados:**
- `src/transport/protocol.ts` — adiciona `"probe.erp_fingerprint"` e `"probe.config_files"` em `AdminCommand`
- `src/discovery/admin-router.ts` — novos cases + validação de input para `probe.config_files`
- `tests/discovery/admin-router.test.ts` — casos novos
- `src/service/runtime.ts` — wiring dos novos probes nas `AdminRouterDependencies`
- `package.json` — adiciona `ini`

---

## Task 1: Tabela de assinaturas + `probeErpFingerprint`

**Files:**
- Create: `src/discovery/erp-signatures.ts`
- Create: `src/discovery/erp-fingerprint.ts`
- Create: `tests/discovery/erp-fingerprint.test.ts`

- [ ] **Step 1.1: Criar `erp-signatures.ts`**

Create `src/discovery/erp-signatures.ts`:

```ts
export type ErpMarker =
  | { type: "file"; path: string }
  | { type: "dir"; path: string }
  | { type: "registry"; path: string }
  | { type: "service"; name: string };

export interface ErpSignature {
  id: string;
  displayName: string;
  markers: ErpMarker[];
  configPaths: string[];
}

export const ERP_SIGNATURES: ErpSignature[] = [
  {
    id: "linx-big",
    displayName: "Linx Big",
    markers: [
      { type: "file", path: "C:\\Linx\\Big\\config.ini" },
      { type: "registry", path: "HKLM\\Software\\Linx\\Big" }
    ],
    configPaths: ["C:\\Linx\\Big\\config.ini"]
  },
  {
    id: "totvs-protheus",
    displayName: "TOTVS Protheus",
    markers: [
      { type: "dir", path: "C:\\TOTVS\\Protheus" },
      { type: "service", name: "TOTVS_AppServer" }
    ],
    configPaths: ["C:\\TOTVS\\Protheus\\bin\\appserver\\appserver.ini"]
  }
];
```

- [ ] **Step 1.2: Escrever testes de `probeErpFingerprint`**

Create `tests/discovery/erp-fingerprint.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { probeErpFingerprint } from "../../src/discovery/erp-fingerprint.js";
import type { ProbeContext } from "../../src/discovery/types.js";

function makeContext(overrides: Partial<ProbeContext> = {}): ProbeContext {
  return {
    registry: { readKey: vi.fn(async () => ({})) } as never,
    fs: {
      readFile: vi.fn(async () => ""),
      listDir: vi.fn(async () => []),
      stat: vi.fn(async () => undefined)
    },
    serviceList: vi.fn(async () => []),
    signal: new AbortController().signal,
    ...overrides
  };
}

describe("probeErpFingerprint", () => {
  it("detects Linx Big when config.ini exists with high confidence", async () => {
    const ctx = makeContext({
      fs: {
        readFile: vi.fn(async () => ""),
        listDir: vi.fn(async () => []),
        stat: vi.fn(async (path: string) =>
          path.toLowerCase().includes("linx\\big\\config.ini") ? { isFile: true, isDirectory: false } : undefined
        )
      },
      registry: {
        readKey: vi.fn(async (path: string) =>
          path === "HKLM\\Software\\Linx\\Big" ? { _exists: "1" } : ({} as Record<string, string>)
        )
      } as never
    });

    const erps = await probeErpFingerprint(ctx);
    const linx = erps.find((e) => e.id === "linx-big");
    expect(linx).toBeDefined();
    expect(linx?.confidence).toBe("high");
    expect(linx?.paths).toContain("C:\\Linx\\Big\\config.ini");
  });

  it("detects TOTVS Protheus via dir + service", async () => {
    const ctx = makeContext({
      fs: {
        readFile: vi.fn(async () => ""),
        listDir: vi.fn(async () => []),
        stat: vi.fn(async (path: string) =>
          path === "C:\\TOTVS\\Protheus" ? { isFile: false, isDirectory: true } : undefined
        )
      },
      serviceList: vi.fn(async () => [{ name: "TOTVS_AppServer", state: "running" }])
    });
    const erps = await probeErpFingerprint(ctx);
    const totvs = erps.find((e) => e.id === "totvs-protheus");
    expect(totvs).toBeDefined();
    expect(totvs?.confidence).toBe("high");
  });

  it("returns low confidence when only one marker matches", async () => {
    const ctx = makeContext({
      fs: {
        readFile: vi.fn(async () => ""),
        listDir: vi.fn(async () => []),
        stat: vi.fn(async (path: string) =>
          path === "C:\\TOTVS\\Protheus" ? { isFile: false, isDirectory: true } : undefined
        )
      }
    });
    const erps = await probeErpFingerprint(ctx);
    const totvs = erps.find((e) => e.id === "totvs-protheus");
    expect(totvs?.confidence).toBe("low");
  });

  it("returns empty when no ERP matches", async () => {
    const ctx = makeContext();
    const erps = await probeErpFingerprint(ctx);
    expect(erps).toEqual([]);
  });

  it("swallows registry/fs errors without throwing", async () => {
    const ctx = makeContext({
      registry: {
        readKey: vi.fn(async () => {
          throw new Error("registry denied");
        })
      } as never,
      fs: {
        readFile: vi.fn(async () => {
          throw new Error("fs denied");
        }),
        listDir: vi.fn(async () => []),
        stat: vi.fn(async () => {
          throw new Error("stat denied");
        })
      }
    });
    await expect(probeErpFingerprint(ctx)).resolves.toEqual([]);
  });
});
```

- [ ] **Step 1.3: Criar `src/discovery/erp-fingerprint.ts`**

Create `src/discovery/erp-fingerprint.ts`:

```ts
import { ERP_SIGNATURES, type ErpMarker, type ErpSignature } from "./erp-signatures.js";
import type { ProbeContext } from "./types.js";

export interface ErpFingerprintResult {
  id: string;
  displayName: string;
  confidence: "high" | "medium" | "low";
  paths: string[];
  matchedMarkers: number;
}

export async function probeErpFingerprint(ctx: ProbeContext): Promise<ErpFingerprintResult[]> {
  const services = await safeListServices(ctx);
  const results: ErpFingerprintResult[] = [];

  for (const sig of ERP_SIGNATURES) {
    if (ctx.signal.aborted) break;
    const matched = await countMatchedMarkers(sig, ctx, services);
    if (matched > 0) {
      results.push({
        id: sig.id,
        displayName: sig.displayName,
        confidence: scoreConfidence(matched, sig.markers.length),
        paths: sig.configPaths,
        matchedMarkers: matched
      });
    }
  }

  return results;
}

async function countMatchedMarkers(
  sig: ErpSignature,
  ctx: ProbeContext,
  services: { name: string }[]
): Promise<number> {
  let matched = 0;
  for (const marker of sig.markers) {
    if (await markerMatches(marker, ctx, services)) {
      matched += 1;
    }
  }
  return matched;
}

async function markerMatches(
  marker: ErpMarker,
  ctx: ProbeContext,
  services: { name: string }[]
): Promise<boolean> {
  try {
    switch (marker.type) {
      case "file": {
        const stat = await ctx.fs.stat(marker.path);
        return stat?.isFile ?? false;
      }
      case "dir": {
        const stat = await ctx.fs.stat(marker.path);
        return stat?.isDirectory ?? false;
      }
      case "registry": {
        const values = await ctx.registry.readKey(marker.path);
        return values && Object.keys(values).length > 0;
      }
      case "service": {
        return services.some((s) => s.name.toLowerCase() === marker.name.toLowerCase());
      }
    }
  } catch {
    return false;
  }
}

function scoreConfidence(matched: number, total: number): "high" | "medium" | "low" {
  const ratio = matched / total;
  if (ratio >= 0.66 && matched >= 2) return "high";
  if (matched >= 2) return "medium";
  return "low";
}

async function safeListServices(ctx: ProbeContext) {
  try {
    return await ctx.serviceList();
  } catch {
    return [];
  }
}
```

- [ ] **Step 1.4: Rodar — devem passar**

Run: `npx vitest run tests/discovery/erp-fingerprint.test.ts`
Expected: PASS.

- [ ] **Step 1.5: Commit**

```bash
git add src/discovery/erp-signatures.ts src/discovery/erp-fingerprint.ts tests/discovery/erp-fingerprint.test.ts
git commit -m "feat(discovery): probeErpFingerprint identifica ERPs conhecidos"
```

---

## Task 2: `probeConfigFiles`

**Files:**
- Create: `src/discovery/config-files.ts`
- Create: `tests/discovery/config-files.test.ts`
- Modify: `package.json` (adicionar dep `ini`)

- [ ] **Step 2.1: Adicionar dep `ini`**

Run: `npm install ini @types/ini`
Expected: pacotes adicionados ao `dependencies` e `devDependencies`.

- [ ] **Step 2.2: Escrever testes**

Create `tests/discovery/config-files.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { probeConfigFiles } from "../../src/discovery/config-files.js";
import type { FileSystemReader } from "../../src/discovery/fs-reader.js";

function fsReturning(map: Record<string, string>): FileSystemReader {
  return {
    readFile: vi.fn(async (path: string) => {
      if (path in map) return map[path];
      throw new Error("ENOENT");
    }),
    listDir: vi.fn(async () => []),
    stat: vi.fn(async () => ({ isFile: true, isDirectory: false }))
  };
}

describe("probeConfigFiles", () => {
  it("parses INI files and extracts connection-related keys", async () => {
    const fs = fsReturning({
      "C:\\app\\config.ini": "[database]\nhost=10.0.0.1\nport=1433\nuser=sa\npassword=secret123\n"
    });
    const result = await probeConfigFiles({ paths: ["C:\\app\\config.ini"], fs });
    expect(result.files[0]?.format).toBe("ini");
    const cands = result.files[0]?.candidates ?? [];
    expect(cands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "database.host", value: "10.0.0.1" }),
        expect.objectContaining({ key: "database.port", value: "1433" }),
        expect.objectContaining({ key: "database.user", value: "sa" }),
        expect.objectContaining({ key: "database.password", looksLikeSecret: true })
      ])
    );
    const passwordCand = cands.find((c) => c.key === "database.password");
    expect(passwordCand?.value).toBeUndefined();
  });

  it("parses .config XML and finds connectionString", async () => {
    const fs = fsReturning({
      "C:\\app\\App.config": `
        <configuration>
          <connectionStrings>
            <add name="Default" connectionString="Server=10.0.0.1;Database=BIG;User Id=sa;Password=secret123;" />
          </connectionStrings>
        </configuration>
      `
    });
    const result = await probeConfigFiles({ paths: ["C:\\app\\App.config"], fs });
    const cands = result.files[0]?.candidates ?? [];
    expect(cands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "Server", value: "10.0.0.1" }),
        expect.objectContaining({ key: "Database", value: "BIG" }),
        expect.objectContaining({ key: "User Id", value: "sa" }),
        expect.objectContaining({ key: "Password", looksLikeSecret: true })
      ])
    );
  });

  it("parses JSON files and finds DB-related fields", async () => {
    const fs = fsReturning({
      "C:\\app\\settings.json": JSON.stringify({
        db: { host: "h", port: 5432, user: "u", password: "p" }
      })
    });
    const result = await probeConfigFiles({ paths: ["C:\\app\\settings.json"], fs });
    const cands = result.files[0]?.candidates ?? [];
    expect(cands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "db.host", value: "h" }),
        expect.objectContaining({ key: "db.password", looksLikeSecret: true })
      ])
    );
  });

  it("parses .properties files", async () => {
    const fs = fsReturning({
      "C:\\app\\app.properties": "jdbc.url=jdbc:sqlserver://10.0.0.1:1433;databaseName=BIG\njdbc.user=sa\njdbc.password=secret\n"
    });
    const result = await probeConfigFiles({ paths: ["C:\\app\\app.properties"], fs });
    const cands = result.files[0]?.candidates ?? [];
    expect(cands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "jdbc.url", value: expect.stringContaining("sqlserver") }),
        expect.objectContaining({ key: "jdbc.password", looksLikeSecret: true })
      ])
    );
  });

  it("reports unreadable files without throwing", async () => {
    const fs: FileSystemReader = {
      readFile: vi.fn(async () => {
        throw new Error("permission denied");
      }),
      listDir: vi.fn(async () => []),
      stat: vi.fn(async () => undefined)
    };
    const result = await probeConfigFiles({ paths: ["C:\\inaccessible.ini"], fs });
    expect(result.files[0]).toMatchObject({ path: "C:\\inaccessible.ini", format: "unknown", candidates: [] });
  });

  it("treats values that look like long base64/hash as secrets even on non-password keys", async () => {
    const fs = fsReturning({
      "C:\\app\\config.ini":
        "[db]\nhost=h\ntoken=ZjVhYjMxMmI4ZjVhYjMxMmI4ZjVhYjMxMmI4ZjVhYjMxMmI4ZjVhYjMxMmI4ZjVhYjMxMmI4\n"
    });
    const result = await probeConfigFiles({ paths: ["C:\\app\\config.ini"], fs });
    const tokenCand = result.files[0]?.candidates.find((c) => c.key === "db.token");
    expect(tokenCand?.looksLikeSecret).toBe(true);
    expect(tokenCand?.value).toBeUndefined();
  });
});
```

- [ ] **Step 2.3: Criar `src/discovery/config-files.ts`**

Create `src/discovery/config-files.ts`:

```ts
import * as ini from "ini";
import type { FileSystemReader } from "./fs-reader.js";

export type ConfigFileFormat = "ini" | "xml" | "json" | "properties" | "unknown";

export interface ConfigCandidate {
  key: string;
  value?: string;
  looksLikeSecret: boolean;
}

export interface ConfigFileResult {
  path: string;
  format: ConfigFileFormat;
  candidates: ConfigCandidate[];
  error?: string;
}

export interface ProbeConfigFilesInput {
  paths: string[];
  fs: FileSystemReader;
}

export interface ProbeConfigFilesResult {
  files: ConfigFileResult[];
}

const RELEVANT_KEY_RE =
  /(^|\.)(host|server|servername|database|db|databasename|user|uid|username|user_?id|port|instance|connectionstring|jdbc\.url|dsn)$/i;

const SECRET_KEY_RE = /(password|pwd|senha|token|secret|apikey|api_key)/i;

const LIKELY_SECRET_VALUE_RE = /^[A-Za-z0-9+/=]{40,}$/;

export async function probeConfigFiles(input: ProbeConfigFilesInput): Promise<ProbeConfigFilesResult> {
  const files: ConfigFileResult[] = [];
  for (const path of input.paths) {
    files.push(await parseOne(path, input.fs));
  }
  return { files };
}

async function parseOne(path: string, fs: FileSystemReader): Promise<ConfigFileResult> {
  const format = detectFormat(path);
  try {
    const raw = await fs.readFile(path, "utf8");
    const candidates = extractCandidates(raw, format);
    return { path, format, candidates };
  } catch (err) {
    return {
      path,
      format,
      candidates: [],
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

function detectFormat(path: string): ConfigFileFormat {
  const lower = path.toLowerCase();
  if (lower.endsWith(".ini")) return "ini";
  if (lower.endsWith(".xml") || lower.endsWith(".config")) return "xml";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".properties")) return "properties";
  return "unknown";
}

function extractCandidates(raw: string, format: ConfigFileFormat): ConfigCandidate[] {
  switch (format) {
    case "ini":
      return walkFlatPairs(ini.parse(raw));
    case "json":
      try {
        return walkFlatPairs(JSON.parse(raw));
      } catch {
        return [];
      }
    case "properties":
      return walkFlatPairs(parseProperties(raw));
    case "xml":
      return extractXmlConnectionStrings(raw);
    default:
      return [];
  }
}

function walkFlatPairs(value: unknown, prefix = ""): ConfigCandidate[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const out: ConfigCandidate[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out.push(...walkFlatPairs(v, key));
      continue;
    }
    const stringValue = v === null || v === undefined ? "" : String(v);
    out.push(buildCandidate(key, stringValue));
  }
  return out.filter(isRelevantOrSecret);
}

function parseProperties(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    out[key] = value;
  }
  return out;
}

function extractXmlConnectionStrings(raw: string): ConfigCandidate[] {
  const out: ConfigCandidate[] = [];
  const connStringRe = /connectionString\s*=\s*"([^"]+)"/gi;
  let match: RegExpExecArray | null;
  while ((match = connStringRe.exec(raw)) !== null) {
    const conn = match[1] ?? "";
    for (const pair of conn.split(/[;]/)) {
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const key = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (key) out.push(buildCandidate(key, value));
    }
  }
  return out;
}

function buildCandidate(key: string, value: string): ConfigCandidate {
  const isSecret = SECRET_KEY_RE.test(key) || LIKELY_SECRET_VALUE_RE.test(value);
  if (isSecret) {
    return { key, looksLikeSecret: true };
  }
  return { key, value, looksLikeSecret: false };
}

function isRelevantOrSecret(c: ConfigCandidate): boolean {
  return RELEVANT_KEY_RE.test(c.key) || c.looksLikeSecret;
}
```

- [ ] **Step 2.4: Rodar — devem passar**

Run: `npx vitest run tests/discovery/config-files.test.ts`
Expected: PASS.

- [ ] **Step 2.5: Commit**

```bash
git add src/discovery/config-files.ts tests/discovery/config-files.test.ts package.json package-lock.json
git commit -m "feat(discovery): probeConfigFiles extrai candidatos sem vazar senhas"
```

---

## Task 3: Adicionar comandos no `AdminCommand` e router

**Files:**
- Modify: `src/transport/protocol.ts` (linha onde `AdminCommand` foi definido na Fase 2)
- Modify: `src/discovery/admin-router.ts`
- Modify: `tests/discovery/admin-router.test.ts`

- [ ] **Step 3.1: Estender `AdminCommand`**

Modify `src/transport/protocol.ts`:

```ts
export type AdminCommand =
  | "schema.listTables"
  | "probe.engines"
  | "probe.odbc_dsns"
  | "probe.network"
  | "probe.test_connection"
  | "probe.erp_fingerprint"
  | "probe.config_files";
```

Atualizar o `ADMIN_COMMANDS` Set (mesma localização):

```ts
const ADMIN_COMMANDS = new Set<AdminCommand>([
  "schema.listTables",
  "probe.engines",
  "probe.odbc_dsns",
  "probe.network",
  "probe.test_connection",
  "probe.erp_fingerprint",
  "probe.config_files"
]);
```

- [ ] **Step 3.2: Estender `AdminRouterDependencies` e cases**

Modify `src/discovery/admin-router.ts`:

```ts
import type { ErpFingerprintResult } from "./erp-fingerprint.js";
import type { ProbeConfigFilesResult } from "./config-files.js";

export interface AdminRouterDependencies {
  probeEngines: () => Promise<EngineCandidate[]>;
  probeOdbcDsns: () => Promise<OdbcDsnCandidate[]>;
  probeNetwork: (input: ProbeNetworkInput) => Promise<ProbeNetworkResult>;
  probeTestConnection: (input: TestConnectionInput) => Promise<TestConnectionResult>;
  probeErpFingerprint: () => Promise<ErpFingerprintResult[]>;
  probeConfigFiles: (paths: string[]) => Promise<ProbeConfigFilesResult>;
  schemaListTables: () => Promise<string[]>;
}
```

Adicionar cases no switch:

```ts
      case "probe.erp_fingerprint": {
        const erps = await deps.probeErpFingerprint();
        return success(req, { erps });
      }
      case "probe.config_files": {
        const input = validateConfigFilesInput(req.input);
        if (input.error) return invalidInput(req, input.error);
        const result = await deps.probeConfigFiles(input.value);
        return success(req, result);
      }
```

Adicionar validador:

```ts
function validateConfigFilesInput(input: unknown): Validated<string[]> {
  if (!isRecord(input)) return { error: "input must be an object" };
  if (!Array.isArray(input.paths)) return { error: "input.paths must be an array" };
  const paths: string[] = [];
  for (const p of input.paths) {
    if (typeof p !== "string" || p.length === 0) {
      return { error: "input.paths must contain non-empty strings" };
    }
    paths.push(p);
  }
  if (paths.length === 0) return { error: "input.paths must contain at least one path" };
  return { value: paths };
}
```

- [ ] **Step 3.3: Adicionar testes do router**

Modify `tests/discovery/admin-router.test.ts` — adicionar ao `makeDeps`:

```ts
probeErpFingerprint: vi.fn(async () => [{ id: "linx-big", displayName: "Linx Big", confidence: "high", paths: ["C:\\Linx\\Big\\config.ini"], matchedMarkers: 2 }]),
probeConfigFiles: vi.fn(async () => ({ files: [{ path: "x", format: "ini" as const, candidates: [] }] })),
```

E novos casos:

```ts
it("dispatches probe.erp_fingerprint", async () => {
  const res = await handleAdminRequest(
    { type: "admin.request", requestId: "r", command: "probe.erp_fingerprint" },
    makeDeps()
  );
  expect(res).toMatchObject({ ok: true, payload: { erps: expect.any(Array) } });
});

it("dispatches probe.config_files with valid paths", async () => {
  const res = await handleAdminRequest(
    {
      type: "admin.request",
      requestId: "r",
      command: "probe.config_files",
      input: { paths: ["C:\\app\\config.ini"] }
    },
    makeDeps()
  );
  expect(res).toMatchObject({ ok: true, payload: { files: expect.any(Array) } });
});

it("rejects probe.config_files without paths", async () => {
  const res = await handleAdminRequest(
    { type: "admin.request", requestId: "r", command: "probe.config_files", input: {} },
    makeDeps()
  );
  expect(res).toMatchObject({ ok: false, error: { errorCode: "INVALID_INPUT" } });
});

it("rejects probe.config_files with empty paths array", async () => {
  const res = await handleAdminRequest(
    {
      type: "admin.request",
      requestId: "r",
      command: "probe.config_files",
      input: { paths: [] }
    },
    makeDeps()
  );
  expect(res).toMatchObject({ ok: false, error: { errorCode: "INVALID_INPUT" } });
});
```

- [ ] **Step 3.4: Rodar — devem passar**

Run: `npx vitest run tests/discovery/admin-router.test.ts tests/transport/protocol.test.ts`
Expected: PASS.

- [ ] **Step 3.5: Commit**

```bash
git add src/transport/protocol.ts src/discovery/admin-router.ts tests/discovery/admin-router.test.ts
git commit -m "feat(discovery): admin-router despacha probe.erp_fingerprint e probe.config_files"
```

---

## Task 4: Wiring no runtime

**Files:**
- Modify: `src/service/runtime.ts`

- [ ] **Step 4.1: Adicionar imports**

```ts
import { probeErpFingerprint } from "../discovery/erp-fingerprint.js";
import { probeConfigFiles } from "../discovery/config-files.js";
```

- [ ] **Step 4.2: Adicionar nas dependências do router (no mesmo bloco da Fase 2 + Fase 3)**

```ts
probeErpFingerprint: wrapProbe("probe.erp_fingerprint", () => probeErpFingerprint({
  registry: registryReader,
  fs: nodeFileSystemReader,
  serviceList: listWindowsServices,
  signal: new AbortController().signal
})),
probeConfigFiles: wrapProbe("probe.config_files", (paths: string[]) =>
  probeConfigFiles({ paths, fs: nodeFileSystemReader })
),
```

- [ ] **Step 4.3: Verificar build TS**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: sem erros.

- [ ] **Step 4.4: Rodar suite completa**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4.5: Commit**

```bash
git add src/service/runtime.ts
git commit -m "feat(runtime): wiring de probes erp_fingerprint e config_files"
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

Run: `git log --oneline -8`
Expected: 4 commits criados na ordem das tasks.
