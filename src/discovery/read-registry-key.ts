import type { RegistryReader } from "../db/registry-reader.js";

const ALLOWED_HIVES = [
  "HKLM", "HKCU",
  "HKEY_LOCAL_MACHINE", "HKEY_CURRENT_USER"
];

export interface ReadRegistryKeyInput {
  path: string;
}

export type ReadRegistryKeyResult =
  | { ok: true; path: string; values: Record<string, string> }
  | { ok: false; errorCode: "INVALID_INPUT" | "unknown"; message: string };

export async function readRegistryKey(
  registry: RegistryReader,
  input: ReadRegistryKeyInput
): Promise<ReadRegistryKeyResult> {
  const path = input.path.trim();
  if (path.length === 0) {
    return { ok: false, errorCode: "INVALID_INPUT", message: "path é obrigatório" };
  }
  const hive = path.split("\\")[0] ?? "";
  if (!ALLOWED_HIVES.includes(hive.toUpperCase())) {
    return { ok: false, errorCode: "INVALID_INPUT", message: `hive não permitido: ${hive}` };
  }
  try {
    const values = await registry.readKey(path);
    return { ok: true, path, values };
  } catch (err) {
    return { ok: false, errorCode: "unknown", message: err instanceof Error ? err.message : "falha ao ler registro" };
  }
}
