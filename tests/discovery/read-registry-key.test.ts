import { describe, expect, it, vi } from "vitest";
import { readRegistryKey } from "../../src/discovery/read-registry-key.js";
import type { RegistryReader } from "../../src/db/registry-reader.js";

function makeRegistry(values: Record<string, string>): RegistryReader {
  return {
    listKeys: vi.fn(async () => []),
    readKey: vi.fn(async () => values)
  };
}

describe("readRegistryKey", () => {
  it("lê valores de hive permitido", async () => {
    const registry = makeRegistry({ Server: "db-host", Database: "PHARMA" });
    const r = await readRegistryKey(registry, { path: "HKLM\\Software\\Linx\\Conn" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.values).toEqual({ Server: "db-host", Database: "PHARMA" });
  });

  it("aceita HKEY_LOCAL_MACHINE longo", async () => {
    const registry = makeRegistry({ X: "1" });
    const r = await readRegistryKey(registry, { path: "HKEY_LOCAL_MACHINE\\Software\\App" });
    expect(r.ok).toBe(true);
  });

  it("rejeita hive fora da allow-list", async () => {
    const registry = makeRegistry({});
    const r = await readRegistryKey(registry, { path: "HKCR\\.exe" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe("INVALID_INPUT");
  });

  it("rejeita path vazio", async () => {
    const registry = makeRegistry({});
    const r = await readRegistryKey(registry, { path: "   " });
    expect(r.ok).toBe(false);
  });
});
