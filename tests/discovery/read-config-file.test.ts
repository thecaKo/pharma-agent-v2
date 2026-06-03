import { describe, expect, it, vi } from "vitest";
import { readConfigFile, MAX_CONFIG_FILE_BYTES } from "../../src/discovery/read-config-file.js";
import type { FileSystemReader } from "../../src/discovery/fs-reader.js";

function makeFs(map: Record<string, string | "permission" | "missing">): FileSystemReader {
  return {
    readFile: vi.fn(async (path: string) => {
      const v = map[path];
      if (v === undefined || v === "missing") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (v === "permission") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return v;
    }),
    listDir: vi.fn(async () => []),
    stat: vi.fn(async () => undefined),
    enumerateTop: vi.fn(async () => [])
  };
}

describe("readConfigFile", () => {
  it("lê arquivo permitido sob padrão default", async () => {
    const fs = makeFs({ "C:\\Linx\\config.ini": "host=db\nport=3050" });
    const r = await readConfigFile({ fs }, { path: "C:\\Linx\\config.ini" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toContain("host=db");
  });

  it("rejeita path sob raiz negada (Windows)", async () => {
    const fs = makeFs({ "C:\\Windows\\System32\\drivers\\etc\\hosts": "127.0.0.1" });
    const r = await readConfigFile({ fs }, { path: "C:\\Windows\\System32\\drivers\\etc\\hosts" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe("INVALID_INPUT");
  });

  it("rejeita extensão fora do padrão permitido", async () => {
    const fs = makeFs({ "C:\\Linx\\app.exe": "MZ" });
    const r = await readConfigFile({ fs }, { path: "C:\\Linx\\app.exe" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe("INVALID_INPUT");
  });

  it("rejeita conteúdo acima do limite", async () => {
    const big = "x".repeat(MAX_CONFIG_FILE_BYTES + 1);
    const fs = makeFs({ "C:\\Linx\\big.json": big });
    const r = await readConfigFile({ fs }, { path: "C:\\Linx\\big.json" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe("INVALID_INPUT");
  });

  it("mapeia erro de permissão", async () => {
    const fs = makeFs({ "C:\\Linx\\secret.ini": "permission" });
    const r = await readConfigFile({ fs }, { path: "C:\\Linx\\secret.ini" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe("unreachable");
  });

  it("mapeia arquivo ausente", async () => {
    const fs = makeFs({});
    const r = await readConfigFile({ fs }, { path: "C:\\Linx\\missing.ini" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe("unreachable");
  });
});
