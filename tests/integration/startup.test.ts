import { mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { validEnv } from "../helpers/env.js";

const PROJECT_ROOT = process.cwd();
const MAIN_FILE = join(PROJECT_ROOT, "src", "main.ts");

describe("connector startup command", () => {
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
});

function startupArgs(workingDirectory?: string): string[] {
  const prelude = workingDirectory ? `process.chdir(${JSON.stringify(workingDirectory)}); ` : "";
  return [
    "--import",
    "tsx",
    "--eval",
    `${prelude}import { runMain } from ${JSON.stringify(MAIN_FILE)}; process.exitCode = runMain(process.env);`
  ];
}
