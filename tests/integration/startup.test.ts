import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONNECTOR_CONFIG_FILE_NAME,
  INSTALLER_CONFIG_DIR_NAME
} from "../../src/config/programdata-config.js";
import { validDatabaseEnv, validEnv } from "../helpers/env.js";

const tempDirs: string[] = [];

const PROJECT_ROOT = process.cwd();
const MAIN_FILE = join(PROJECT_ROOT, "src", "main.ts");

describe("connector startup command", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("exits without configuration errors for a complete test environment", () => {
    const result = spawnSync("node", startupArgs(), {
      cwd: PROJECT_ROOT,
      env: {
        PATH: process.env.PATH,
        CONNECTOR_VALIDATE_ONLY: "1",
        ...validEnv()
      },
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("test-connector-token");
    expect(result.stdout).not.toContain("test-db-password");
  });

  it("exits non-zero and emits redacted diagnostics when required variables are missing", () => {
    const result = spawnSync("node", startupArgs(), {
      cwd: PROJECT_ROOT,
      env: {
        PATH: process.env.PATH,
        CONNECTOR_VALIDATE_ONLY: "1",
        ...validEnv({
          CONNECTOR_TOKEN: "secret-token-that-must-not-print",
          DB_PASSWORD: "secret-password-that-must-not-print"
        }),
        DB_USER: ""
      },
      encoding: "utf8"
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("secret-token-that-must-not-print");
    expect(result.stderr).not.toContain("secret-password-that-must-not-print");
  });

  it("loads configuration from .env without manual export", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "connector-dotenv-"));
    await writeFile(
      join(cwd, ".env"),
      [
        "CONNECTOR_TOKEN=dotenv-token",
        "CONNECTOR_WS_URL=wss://central-platform/connectors/ws",
        "DB_DRIVER=mysql",
        "DB_HOST=127.0.0.1",
        "DB_PORT=3306",
        "DB_NAME=pharmacy",
        "DB_USER=readonly",
        "DB_PASSWORD=dotenv-password"
      ].join("\n")
    );

    const result = spawnSync("node", startupArgs(cwd), {
      cwd: PROJECT_ROOT,
      env: {
        PATH: process.env.PATH
      },
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("dotenv-token");
    expect(result.stdout).not.toContain("dotenv-password");
  });

  it("succeeds with ProgramData token and URL plus database settings from env", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "startup-programdata-"));
    tempDirs.push(cwd);
    const programDataRoot = join(cwd, "ProgramData");
    const configDir = join(programDataRoot, INSTALLER_CONFIG_DIR_NAME);
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, CONNECTOR_CONFIG_FILE_NAME),
      JSON.stringify({
        CONNECTOR_TOKEN: "integration-installer-token",
        CONNECTOR_WS_URL: "wss://integration-installer.example/connectors/ws"
      }),
      "utf8"
    );

    const result = spawnSync("node", startupArgs(cwd), {
      cwd: PROJECT_ROOT,
      env: {
        PATH: process.env.PATH,
        CONNECTOR_VALIDATE_ONLY: "1",
        PROGRAMDATA: programDataRoot,
        ...validDatabaseEnv()
      },
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("integration-installer-token");
    expect(result.stdout).toContain('"authCredentialSource":"programdata"');
    expect(result.stdout).toContain('"programDataConfigFound":true');
    expect(result.stdout).toContain("wss://integration-installer.example/connectors/ws");
  });

  it("prefers env CONNECTOR_WS_URL over ProgramData CONNECTOR_WS_URL during validate-only startup", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "startup-programdata-ws-precedence-"));
    tempDirs.push(cwd);
    const programDataRoot = join(cwd, "ProgramData");
    const configDir = join(programDataRoot, INSTALLER_CONFIG_DIR_NAME);
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, CONNECTOR_CONFIG_FILE_NAME),
      JSON.stringify({
        CONNECTOR_TOKEN: "integration-installer-token",
        CONNECTOR_WS_URL: "wss://file-precedence.example/connectors/ws"
      }),
      "utf8"
    );

    const result = spawnSync("node", startupArgs(cwd), {
      cwd: PROJECT_ROOT,
      env: {
        PATH: process.env.PATH,
        CONNECTOR_VALIDATE_ONLY: "1",
        PROGRAMDATA: programDataRoot,
        ...validDatabaseEnv(),
        CONNECTOR_WS_URL: "wss://env-precedence.example/connectors/ws"
      },
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain('"websocketUrlSource":"environment"');
    expect(result.stdout).toContain("wss://env-precedence.example/connectors/ws");
    expect(result.stdout).not.toContain("wss://file-precedence.example/connectors/ws");
    expect(result.stdout).not.toContain("integration-installer-token");
  });

  it("fails with missing database diagnostics when only ProgramData central settings exist", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "startup-programdata-only-"));
    tempDirs.push(cwd);
    const programDataRoot = join(cwd, "ProgramData");
    const configDir = join(programDataRoot, INSTALLER_CONFIG_DIR_NAME);
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, CONNECTOR_CONFIG_FILE_NAME),
      JSON.stringify({
        CONNECTOR_TOKEN: "integration-installer-token",
        CONNECTOR_WS_URL: "wss://integration-installer.example/connectors/ws"
      }),
      "utf8"
    );

    const result = spawnSync("node", startupArgs(cwd), {
      cwd: PROJECT_ROOT,
      env: {
        PATH: process.env.PATH,
        CONNECTOR_VALIDATE_ONLY: "1",
        PROGRAMDATA: programDataRoot
      },
      encoding: "utf8"
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('"event":"unrecoverable.configuration_error"');
    expect(result.stderr).toContain("DB_DRIVER");
    expect(result.stderr).toContain("DB_PASSWORD");
    expect(result.stderr).not.toContain("integration-installer-token");
  });
});

function startupArgs(workingDirectory?: string): string[] {
  const prelude = workingDirectory ? `process.chdir(${JSON.stringify(workingDirectory)}); ` : "";
  return [
    "--import",
    "tsx",
    "--eval",
    `${prelude}import { runMain } from ${JSON.stringify(MAIN_FILE)}; process.exitCode = await runMain(process.env);`
  ];
}
