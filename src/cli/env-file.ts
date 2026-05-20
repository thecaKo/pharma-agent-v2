import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CONNECTOR_ENV_KEYS } from "../config/env.js";

export type ConnectorEnvKey = (typeof CONNECTOR_ENV_KEYS)[number];
export type ConnectorEnvValues = Partial<Record<ConnectorEnvKey, string | number>>;

export interface WriteConnectorEnvFileOptions {
  envFilePath: string;
  values: ConnectorEnvValues;
  now?: Date;
}

export interface WriteConnectorEnvFileResult {
  envFilePath: string;
  backupFilePath?: string;
  created: boolean;
  updatedKeys: ConnectorEnvKey[];
}

const LINE_ENDING = "\n";
const ENV_KEY_SET = new Set<ConnectorEnvKey>(CONNECTOR_ENV_KEYS);
const ENV_ASSIGNMENT_PATTERN = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*?)(\s+#.*)?$/;

export async function writeConnectorEnvFile(
  input: WriteConnectorEnvFileOptions
): Promise<WriteConnectorEnvFileResult> {
  const nextValues = collectKnownValues(input.values);
  const createdAt = input.now ?? new Date();

  await mkdir(dirname(input.envFilePath), { recursive: true });

  let existing = "";
  let created = false;

  try {
    existing = await readFile(input.envFilePath, "utf8");
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
    created = true;
  }

  const merged = mergeConnectorEnvContent(existing, nextValues);
  if (!created && merged === existing) {
    return {
      envFilePath: input.envFilePath,
      created: false,
      updatedKeys: Object.keys(nextValues) as ConnectorEnvKey[]
    };
  }

  let backupFilePath: string | undefined;
  if (!created) {
    backupFilePath = buildEnvBackupPath(input.envFilePath, createdAt);
    await writeFile(backupFilePath, existing, "utf8");
  }

  await writeFile(input.envFilePath, merged, "utf8");

  return {
    envFilePath: input.envFilePath,
    ...(backupFilePath ? { backupFilePath } : {}),
    created,
    updatedKeys: Object.keys(nextValues) as ConnectorEnvKey[]
  };
}

export function mergeConnectorEnvContent(existing: string, values: ConnectorEnvValues): string {
  const nextValues = collectKnownValues(values);
  const pendingKeys = new Set<ConnectorEnvKey>(Object.keys(nextValues) as ConnectorEnvKey[]);
  const lines = existing.length > 0 ? existing.split(/\r?\n/u) : [];
  const mergedLines: string[] = [];

  for (const line of lines) {
    if (line.length === 0) {
      mergedLines.push(line);
      continue;
    }

    const match = ENV_ASSIGNMENT_PATTERN.exec(line);
    if (!match) {
      mergedLines.push(line);
      continue;
    }

    const [, leadingWhitespace, key, separator, , trailingComment = ""] = match;
    if (!ENV_KEY_SET.has(key as ConnectorEnvKey) || !pendingKeys.has(key as ConnectorEnvKey)) {
      mergedLines.push(line);
      continue;
    }

    const envKey = key as ConnectorEnvKey;
    mergedLines.push(`${leadingWhitespace}${envKey}${separator}${formatEnvValue(nextValues[envKey] as string | number)}${trailingComment}`);
    pendingKeys.delete(envKey);
  }

  const missingKeys = CONNECTOR_ENV_KEYS.filter((key) => pendingKeys.has(key));
  if (missingKeys.length > 0) {
    if (mergedLines.length > 0 && mergedLines[mergedLines.length - 1] !== "") {
      mergedLines.push("");
    }

    for (const key of missingKeys) {
      mergedLines.push(`${key}=${formatEnvValue(nextValues[key] as string | number)}`);
    }
  }

  return `${mergedLines.join(LINE_ENDING).replace(/\n*$/u, "")}${LINE_ENDING}`;
}

export function buildEnvBackupPath(envFilePath: string, now: Date): string {
  return `${envFilePath}.${formatBackupTimestamp(now)}.bak`;
}

function collectKnownValues(values: ConnectorEnvValues): ConnectorEnvValues {
  const nextValues: ConnectorEnvValues = {};

  for (const key of CONNECTOR_ENV_KEYS) {
    const value = values[key];
    if (value !== undefined) {
      nextValues[key] = value;
    }
  }

  return nextValues;
}

function formatEnvValue(value: string | number): string {
  const text = String(value);
  if (/^[A-Za-z0-9_./:-]+$/u.test(text)) {
    return text;
  }

  return `"${text
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/\n/gu, "\\n")
    .replace(/\r/gu, "\\r")}"`;
}

function formatBackupTimestamp(value: Date): string {
  return value.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
