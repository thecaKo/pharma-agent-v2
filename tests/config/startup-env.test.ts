import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONNECTOR_CONFIG_FILE_NAME,
  INSTALLER_CONFIG_DIR_NAME
} from "../../src/config/programdata-config.js";
import { resolveStartupEnvironment } from "../../src/config/startup-env.js";
import { validDatabaseEnv, validEnv } from "../helpers/env.js";

const tempDirs: string[] = [];

describe("resolveStartupEnvironment", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("uses file CONNECTOR_TOKEN when env token is absent", async () => {
    const configFilePath = await writeInstallerConfig({
      CONNECTOR_TOKEN: "programdata-token-value",
      CONNECTOR_WS_URL: "wss://programdata.example/connectors/ws"
    });

    const result = await resolveStartupEnvironment(validDatabaseEnv() as NodeJS.ProcessEnv, {
      configFilePath
    });

    expect(result.env.CONNECTOR_TOKEN).toBe("programdata-token-value");
    expect(result.installerManagedSources.CONNECTOR_TOKEN).toBe("programdata");
  });

  it("uses env CONNECTOR_TOKEN when both env and file values are present", async () => {
    const configFilePath = await writeInstallerConfig({
      CONNECTOR_TOKEN: "programdata-token-value",
      CONNECTOR_WS_URL: "wss://programdata.example/connectors/ws"
    });

    const result = await resolveStartupEnvironment(
      validEnv({ CONNECTOR_TOKEN: "env-token-value" }) as NodeJS.ProcessEnv,
      { configFilePath }
    );

    expect(result.env.CONNECTOR_TOKEN).toBe("env-token-value");
    expect(result.installerManagedSources.CONNECTOR_TOKEN).toBe("environment");
  });

  it("loads dotenv values when resolving process.env", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "startup-env-dotenv-"));
    tempDirs.push(cwd);
    const previousCwd = process.cwd();
    const previousToken = process.env.CONNECTOR_TOKEN;
    const previousWsUrl = process.env.CONNECTOR_WS_URL;

    try {
      process.chdir(cwd);
      delete process.env.CONNECTOR_TOKEN;
      delete process.env.CONNECTOR_WS_URL;
      await writeFile(
        join(cwd, ".env"),
        [
          "CONNECTOR_TOKEN=dotenv-only-token",
          "CONNECTOR_WS_URL=wss://dotenv.example/connectors/ws"
        ].join("\n"),
        "utf8"
      );

      const result = await resolveStartupEnvironment(process.env);

      expect(result.env.CONNECTOR_TOKEN).toBe("dotenv-only-token");
      expect(result.env.CONNECTOR_WS_URL).toBe("wss://dotenv.example/connectors/ws");
      expect(result.installerManagedSources.CONNECTOR_TOKEN).toBe("environment");
    } finally {
      process.chdir(previousCwd);
      if (previousToken === undefined) {
        delete process.env.CONNECTOR_TOKEN;
      } else {
        process.env.CONNECTOR_TOKEN = previousToken;
      }
      if (previousWsUrl === undefined) {
        delete process.env.CONNECTOR_WS_URL;
      } else {
        process.env.CONNECTOR_WS_URL = previousWsUrl;
      }
    }
  });

  it("uses env LOG_LEVEL over file LOG_LEVEL", async () => {
    const configFilePath = await writeInstallerConfig({
      CONNECTOR_TOKEN: "programdata-token-value",
      CONNECTOR_WS_URL: "wss://programdata.example/connectors/ws",
      LOG_LEVEL: "debug"
    });

    const result = await resolveStartupEnvironment(
      validEnv({ LOG_LEVEL: "error" }) as NodeJS.ProcessEnv,
      { configFilePath }
    );

    expect(result.env.LOG_LEVEL).toBe("error");
    expect(result.installerManagedSources.LOG_LEVEL).toBe("environment");
  });

  it("uses env CONNECTOR_WS_URL over file CONNECTOR_WS_URL", async () => {
    const configFilePath = await writeInstallerConfig({
      CONNECTOR_TOKEN: "programdata-token-value",
      CONNECTOR_WS_URL: "wss://programdata.example/connectors/ws"
    });

    const result = await resolveStartupEnvironment(
      validEnv({ CONNECTOR_WS_URL: "wss://env.example/connectors/ws" }) as NodeJS.ProcessEnv,
      { configFilePath }
    );

    expect(result.env.CONNECTOR_WS_URL).toBe("wss://env.example/connectors/ws");
    expect(result.installerManagedSources.CONNECTOR_WS_URL).toBe("environment");
  });
});

async function writeInstallerConfig(values: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "startup-env-"));
  tempDirs.push(dir);
  const configDir = join(dir, INSTALLER_CONFIG_DIR_NAME);
  await mkdir(configDir, { recursive: true });
  const configFilePath = join(configDir, CONNECTOR_CONFIG_FILE_NAME);
  await writeFile(configFilePath, `${JSON.stringify(values)}\n`, "utf8");
  return configFilePath;
}
