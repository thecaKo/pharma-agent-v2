import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONNECTOR_CONFIG_FILE_NAME,
  INSTALLER_CONFIG_DIR_NAME,
  loadProgramDataConfig,
  mergeInstallerConfigWithEnvironment
} from "../../src/config/programdata-config.js";

const tempDirs: string[] = [];

describe("programdata installer config loader integration", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("reads a temporary connector-config.json that mirrors the ProgramData file shape", async () => {
    const programDataRoot = await mkdtemp(join(tmpdir(), "programdata-integration-"));
    tempDirs.push(programDataRoot);
    const configDir = join(programDataRoot, INSTALLER_CONFIG_DIR_NAME);
    await mkdir(configDir, { recursive: true });
    const configFilePath = join(configDir, CONNECTOR_CONFIG_FILE_NAME);
    await writeFile(
      configFilePath,
      JSON.stringify({
        CONNECTOR_TOKEN: "integration-installer-token",
        CONNECTOR_WS_URL: "wss://integration.example/connectors/ws",
        LOG_LEVEL: "warn"
      }),
      "utf8"
    );

    const loaded = await loadProgramDataConfig({ configFilePath });
    const merged = mergeInstallerConfigWithEnvironment(loaded.values, {
      DB_DRIVER: "mysql",
      CONNECTOR_WS_URL: "wss://override.example/connectors/ws"
    });

    expect(loaded).toEqual({
      path: configFilePath,
      found: true,
      values: {
        CONNECTOR_TOKEN: "integration-installer-token",
        CONNECTOR_WS_URL: "wss://integration.example/connectors/ws",
        LOG_LEVEL: "warn"
      }
    });
    expect(merged.CONNECTOR_TOKEN).toBe("integration-installer-token");
    expect(merged.CONNECTOR_WS_URL).toBe("wss://override.example/connectors/ws");
    expect(merged.LOG_LEVEL).toBe("warn");
    expect(merged.DB_DRIVER).toBe("mysql");
  });
});
