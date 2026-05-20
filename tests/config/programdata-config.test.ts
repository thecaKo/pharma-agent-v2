import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONNECTOR_CONFIG_FILE_NAME,
  defaultProgramDataConfigPath,
  INSTALLER_CONFIG_DIR_NAME,
  loadProgramDataConfig,
  mergeInstallerConfigWithEnvironment,
  ProgramDataConfigError
} from "../../src/config/programdata-config.js";

const tempDirs: string[] = [];

describe("defaultProgramDataConfigPath", () => {
  it("resolves under ProgramData when provided", () => {
    expect(defaultProgramDataConfigPath("C:\\ProgramData")).toBe(
      join("C:\\ProgramData", INSTALLER_CONFIG_DIR_NAME, CONNECTOR_CONFIG_FILE_NAME)
    );
  });

  it("falls back to a local app data directory when ProgramData is unset", () => {
    expect(defaultProgramDataConfigPath("")).toContain(
      join("AppData", "Local", INSTALLER_CONFIG_DIR_NAME, CONNECTOR_CONFIG_FILE_NAME)
    );
  });
});

describe("loadProgramDataConfig", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("returns found false when the config file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "programdata-config-"));
    tempDirs.push(dir);
    const configFilePath = join(dir, CONNECTOR_CONFIG_FILE_NAME);

    const result = await loadProgramDataConfig({ configFilePath });

    expect(result).toEqual({
      path: configFilePath,
      values: {},
      found: false
    });
  });

  it("returns connector token and websocket url from a valid config file", async () => {
    const configFilePath = await writeConfigFile({
      CONNECTOR_TOKEN: "installer-token-value",
      CONNECTOR_WS_URL: "wss://central.example/connectors/ws"
    });

    const result = await loadProgramDataConfig({ configFilePath });

    expect(result.found).toBe(true);
    expect(result.path).toBe(configFilePath);
    expect(result.values).toEqual({
      CONNECTOR_TOKEN: "installer-token-value",
      CONNECTOR_WS_URL: "wss://central.example/connectors/ws"
    });
  });

  it("returns optional log level from a valid config file", async () => {
    const configFilePath = await writeConfigFile({
      CONNECTOR_TOKEN: "installer-token-value",
      CONNECTOR_WS_URL: "wss://central.example/connectors/ws",
      LOG_LEVEL: "debug"
    });

    const result = await loadProgramDataConfig({ configFilePath });

    expect(result.values.LOG_LEVEL).toBe("debug");
  });

  it("rejects malformed JSON without exposing token-like file contents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "programdata-config-"));
    tempDirs.push(dir);
    const configFilePath = join(dir, CONNECTOR_CONFIG_FILE_NAME);
    await writeFile(
      configFilePath,
      '{"CONNECTOR_TOKEN":"secret-token-from-file","CONNECTOR_WS_URL":',
      "utf8"
    );

    await expect(loadProgramDataConfig({ configFilePath })).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ProgramDataConfigError);
      const message = String(error);
      expect(message).toContain("not valid JSON");
      expect(message).not.toContain("secret-token-from-file");
      return true;
    });
  });

  it("does not treat CENTRAL_WS_URL as CONNECTOR_WS_URL", async () => {
    const configFilePath = await writeConfigFile({
      CONNECTOR_TOKEN: "installer-token-value",
      CENTRAL_WS_URL: "wss://legacy-central.example/connectors/ws"
    });

    const result = await loadProgramDataConfig({ configFilePath });

    expect(result.values).toEqual({
      CONNECTOR_TOKEN: "installer-token-value"
    });
    expect(result.values).not.toHaveProperty("CONNECTOR_WS_URL");
    expect(result.values).not.toHaveProperty("CENTRAL_WS_URL");
  });

  it("ignores database settings such as DB_PASSWORD", async () => {
    const configFilePath = await writeConfigFile({
      CONNECTOR_TOKEN: "installer-token-value",
      CONNECTOR_WS_URL: "wss://central.example/connectors/ws",
      DB_PASSWORD: "must-not-load"
    });

    const result = await loadProgramDataConfig({ configFilePath });

    expect(result.values).toEqual({
      CONNECTOR_TOKEN: "installer-token-value",
      CONNECTOR_WS_URL: "wss://central.example/connectors/ws"
    });
    expect(result.values).not.toHaveProperty("DB_PASSWORD");
  });

  it("rejects invalid config structure without treating unsupported keys as runtime config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "programdata-config-"));
    tempDirs.push(dir);
    const configFilePath = join(dir, CONNECTOR_CONFIG_FILE_NAME);
    await writeFile(configFilePath, '["not","an","object"]', "utf8");

    await expect(loadProgramDataConfig({ configFilePath })).rejects.toThrow(
      /invalid structure/u
    );
  });

  it("rejects unsupported log levels with a non-secret error", async () => {
    const configFilePath = await writeConfigFile({
      CONNECTOR_TOKEN: "installer-token-value",
      CONNECTOR_WS_URL: "wss://central.example/connectors/ws",
      LOG_LEVEL: "trace"
    });

    await expect(loadProgramDataConfig({ configFilePath })).rejects.toThrow(
      /LOG_LEVEL must be debug, info, warn, or error/u
    );
  });

  it("rejects non-string log levels with a non-secret error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "programdata-config-"));
    tempDirs.push(dir);
    const configFilePath = join(dir, CONNECTOR_CONFIG_FILE_NAME);
    await writeFile(
      configFilePath,
      JSON.stringify({
        CONNECTOR_TOKEN: "installer-token-value",
        CONNECTOR_WS_URL: "wss://central.example/connectors/ws",
        LOG_LEVEL: 1
      }),
      "utf8"
    );

    await expect(loadProgramDataConfig({ configFilePath })).rejects.toThrow(
      /LOG_LEVEL must be debug, info, warn, or error/u
    );
  });

  it("reports unreadable config files without exposing secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "programdata-config-"));
    tempDirs.push(dir);

    await expect(loadProgramDataConfig({ configFilePath: dir })).rejects.toThrow(
      /Could not read installer-managed connector config file/u
    );
  });
});

describe("mergeInstallerConfigWithEnvironment", () => {
  it("uses file values when matching environment variables are absent", () => {
    const merged = mergeInstallerConfigWithEnvironment(
      {
        CONNECTOR_TOKEN: "file-token",
        CONNECTOR_WS_URL: "wss://file.example/ws",
        LOG_LEVEL: "warn"
      },
      {
        DB_DRIVER: "mysql"
      }
    );

    expect(merged.CONNECTOR_TOKEN).toBe("file-token");
    expect(merged.CONNECTOR_WS_URL).toBe("wss://file.example/ws");
    expect(merged.LOG_LEVEL).toBe("warn");
  });

  it("keeps installer-managed values when environment entries are empty", () => {
    const merged = mergeInstallerConfigWithEnvironment(
      {
        CONNECTOR_TOKEN: "file-token",
        CONNECTOR_WS_URL: "wss://file.example/ws"
      },
      {
        CONNECTOR_TOKEN: "",
        CONNECTOR_WS_URL: undefined
      }
    );

    expect(merged.CONNECTOR_TOKEN).toBe("file-token");
    expect(merged.CONNECTOR_WS_URL).toBe("wss://file.example/ws");
  });

  it("lets environment values override installer-managed file values", () => {
    const merged = mergeInstallerConfigWithEnvironment(
      {
        CONNECTOR_TOKEN: "file-token",
        CONNECTOR_WS_URL: "wss://file.example/ws",
        LOG_LEVEL: "debug"
      },
      {
        CONNECTOR_TOKEN: "env-token",
        CONNECTOR_WS_URL: "wss://env.example/ws",
        LOG_LEVEL: "error",
        DB_HOST: "localhost"
      }
    );

    expect(merged.CONNECTOR_TOKEN).toBe("env-token");
    expect(merged.CONNECTOR_WS_URL).toBe("wss://env.example/ws");
    expect(merged.LOG_LEVEL).toBe("error");
    expect(merged.DB_HOST).toBe("localhost");
  });
});

async function writeConfigFile(values: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "programdata-config-"));
  tempDirs.push(dir);
  const configDir = join(dir, "ProgramData", INSTALLER_CONFIG_DIR_NAME);
  await mkdir(configDir, { recursive: true });
  const configFilePath = join(configDir, CONNECTOR_CONFIG_FILE_NAME);
  await writeFile(configFilePath, `${JSON.stringify(values)}\n`, "utf8");
  return configFilePath;
}
