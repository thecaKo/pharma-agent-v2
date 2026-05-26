export interface RegistryReader {
  listKeys(path: string): Promise<string[]>;
  readKey(path: string): Promise<Record<string, string>>;
}

export interface RegExeResult {
  stdout: string;
  stderr: string;
}

export type RegExeExec = (args: readonly string[]) => Promise<RegExeResult>;

export interface CreateRegExeRegistryReaderOptions {
  platform?: NodeJS.Platform | string;
  exec?: RegExeExec;
}

export function createRegExeRegistryReader(
  options: CreateRegExeRegistryReaderOptions = {}
): RegistryReader {
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? defaultExec;

  if (platform !== "win32") {
    return {
      async listKeys() {
        return [];
      },
      async readKey() {
        return {};
      }
    };
  }

  return {
    async listKeys(path: string): Promise<string[]> {
      try {
        const result = await exec(["query", path]);
        return parseSubkeys(path, result.stdout);
      } catch {
        return [];
      }
    },
    async readKey(path: string): Promise<Record<string, string>> {
      try {
        const result = await exec(["query", path]);
        return parseValues(result.stdout);
      } catch {
        return {};
      }
    }
  };
}

const defaultExec: RegExeExec = async (args) => {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    execFile("reg.exe", [...args], { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
};

function parseSubkeys(parentPath: string, stdout: string): string[] {
  const prefix = normalizePath(parentPath);
  const subkeys: string[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.includes("REG_")) {
      continue;
    }
    const normalized = normalizePath(line);
    if (!normalized.startsWith(`${prefix}\\`)) {
      continue;
    }
    const rest = normalized.slice(prefix.length + 1);
    if (!rest || rest.includes("\\")) {
      continue;
    }
    subkeys.push(rest);
  }
  return subkeys;
}

function parseValues(stdout: string): Record<string, string> {
  const values: Record<string, string> = {};
  const valueLine = /^(\S(?:.*?\S)?)\s+REG_[A-Z_]+\s+(.*)$/u;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = valueLine.exec(line);
    if (!match) {
      continue;
    }
    const [, name, value] = match;
    if (name === "(Default)") {
      continue;
    }
    values[name] = value;
  }
  return values;
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith("HKEY_LOCAL_MACHINE")) {
    return `HKLM${trimmed.slice("HKEY_LOCAL_MACHINE".length)}`;
  }
  if (trimmed.startsWith("HKEY_CURRENT_USER")) {
    return `HKCU${trimmed.slice("HKEY_CURRENT_USER".length)}`;
  }
  return trimmed;
}
