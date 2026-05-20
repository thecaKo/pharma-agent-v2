import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONNECTOR_CONFIG_FILE_NAME,
  INSTALLER_CONFIG_DIR_NAME
} from "../src/config/programdata-config.js";
import { runMain, runServiceMain, validateStartup } from "../src/main.js";
import { validDatabaseEnv, validEnv } from "./helpers/env.js";

vi.mock("../src/service/runtime.js", () => ({
  startConnectorRuntime: vi.fn(async (options: { env?: NodeJS.ProcessEnv }) => {
    const { loadConfig } = await import("../src/config/env.js");
    loadConfig(options?.env);
    return {};
  })
}));

vi.mock("../src/service/shutdown.js", () => ({
  registerShutdownHandlers: vi.fn()
}));

const tempDirs: string[] = [];

describe("startup entrypoint", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("validates startup and emits redacted startup logs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await validateStartup(validEnv() as NodeJS.ProcessEnv);

      expect(error).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledTimes(2);
      const output = log.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toContain('"event":"service.startup"');
      expect(output).toContain('"event":"configuration.loaded"');
      expect(output).not.toContain("test-connector-token");
      expect(output).not.toContain("test-db-password");
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("returns zero for valid startup configuration", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      expect(await runMain(validEnv() as NodeJS.ProcessEnv)).toBe(0);
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("returns non-zero for startup configuration errors", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      expect(await runMain(validEnv({ DB_PASSWORD: "" }) as NodeJS.ProcessEnv)).toBe(1);
      expect(log).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledOnce();
      const output = error.mock.calls[0]?.[0] as string;
      expect(output).toContain('"event":"unrecoverable.configuration_error"');
      expect(output).toContain("DB_PASSWORD");
      expect(output).not.toContain("test-connector-token");
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("returns non-zero when ProgramData config cannot be parsed", async () => {
    const configFilePath = await writeInvalidInstallerConfig();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      expect(await runMain(validDatabaseEnv() as NodeJS.ProcessEnv, { configFilePath })).toBe(1);
      expect(error).toHaveBeenCalledOnce();
      const output = error.mock.calls[0]?.[0] as string;
      expect(output).toContain('"errorCode":"PROGRAMDATA_CONFIG_FAILED"');
      expect(output).not.toContain("secret-token-in-broken-json");
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("returns non-zero when service startup configuration is invalid", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      expect(await runServiceMain(validEnv({ DB_PASSWORD: "" }) as NodeJS.ProcessEnv)).toBe(1);
      expect(error).toHaveBeenCalledOnce();
      const output = error.mock.calls[0]?.[0] as string;
      expect(output).toContain('"event":"unrecoverable.configuration_error"');
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("returns non-zero when service startup ProgramData config is invalid", async () => {
    const configFilePath = await writeInvalidInstallerConfig();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      expect(await runServiceMain(validDatabaseEnv() as NodeJS.ProcessEnv, { configFilePath })).toBe(1);
    } finally {
      error.mockRestore();
    }
  });

  it("starts service runtime with merged startup environment", async () => {
    const { startConnectorRuntime } = await import("../src/service/runtime.js");

    expect(await runServiceMain(validEnv() as NodeJS.ProcessEnv)).toBe(0);
    expect(startConnectorRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          CONNECTOR_TOKEN: "test-connector-token"
        })
      })
    );
  });

  it("does not expose file-backed connector token or database password in validation errors", async () => {
    const configFilePath = await writeInstallerConfig({
      CONNECTOR_TOKEN: "file-backed-secret-token",
      CONNECTOR_WS_URL: "wss://programdata.example/connectors/ws"
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      expect(
        await runMain(
          validDatabaseEnv({
            DB_PASSWORD: "env-secret-db-password",
            DB_USER: ""
          }) as NodeJS.ProcessEnv,
          { configFilePath }
        )
      ).toBe(1);
      expect(error).toHaveBeenCalledOnce();
      const output = error.mock.calls[0]?.[0] as string;
      expect(output).toContain('"event":"unrecoverable.configuration_error"');
      expect(output).not.toContain("file-backed-secret-token");
      expect(output).not.toContain("env-secret-db-password");
    } finally {
      error.mockRestore();
    }
  });

  it("does not print the connector token loaded from ProgramData", async () => {
    const configFilePath = await writeInstallerConfig({
      CONNECTOR_TOKEN: "installer-managed-secret-token",
      CONNECTOR_WS_URL: "wss://programdata.example/connectors/ws"
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await validateStartup(validDatabaseEnv() as NodeJS.ProcessEnv, { configFilePath });

      const output = log.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toContain('"authCredentialSource":"programdata"');
      expect(output).not.toContain("installer-managed-secret-token");
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});

async function writeInvalidInstallerConfig(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "main-programdata-invalid-"));
  tempDirs.push(dir);
  const configDir = join(dir, INSTALLER_CONFIG_DIR_NAME);
  await mkdir(configDir, { recursive: true });
  const configFilePath = join(configDir, CONNECTOR_CONFIG_FILE_NAME);
  await writeFile(
    configFilePath,
    '{"CONNECTOR_TOKEN":"secret-token-in-broken-json","CONNECTOR_WS_URL":',
    "utf8"
  );
  return configFilePath;
}

async function writeInstallerConfig(values: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "main-programdata-"));
  tempDirs.push(dir);
  const configDir = join(dir, INSTALLER_CONFIG_DIR_NAME);
  await mkdir(configDir, { recursive: true });
  const configFilePath = join(configDir, CONNECTOR_CONFIG_FILE_NAME);
  await writeFile(configFilePath, `${JSON.stringify(values)}\n`, "utf8");
  return configFilePath;
}
