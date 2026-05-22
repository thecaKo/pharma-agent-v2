import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectStartupDiagnostics, defaultServiceLogPath } from "../../src/logging/startup-diagnostics.js";

describe("startup diagnostics", () => {
  it("reports runtime dependency presence and startup metadata", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "startup-diagnostics-"));
    await mkdir(join(baseDir, "dist"), { recursive: true });
    await mkdir(join(baseDir, "node_modules", "pino"), { recursive: true });
    await mkdir(join(baseDir, "node_modules", "ws"), { recursive: true });
    await writeFile(join(baseDir, "dist", "main.js"), "console.log('ok')\n", "utf8");
    await writeFile(join(baseDir, "node_modules", "pino", "package.json"), "{}\n", "utf8");
    await writeFile(join(baseDir, "node_modules", "ws", "package.json"), "{}\n", "utf8");

    const diagnostics = await collectStartupDiagnostics({
      baseDir,
      programData: "C:\\ProgramData",
      stateFilePath: "C:\\ProgramData\\PharmaAgentConnector\\connector-state.json",
      databaseConfigured: false,
      websocketUrlConfigured: true,
      startupMetadata: {
        programDataConfigFound: true,
        authCredentialSource: "programdata"
      }
    });

    expect(diagnostics.warnings).toEqual([]);
    expect(diagnostics.report).toMatchObject({
      serviceWrapper: "WinSW",
      runtimeBasePath: baseDir,
      databaseConfigured: false,
      websocketUrlConfigured: true,
      distFound: true,
      nodeModulesFound: true,
      requiredDependenciesFound: true,
      logPath: defaultServiceLogPath("C:\\ProgramData"),
      startupMetadata: {
        programDataConfigFound: true,
        authCredentialSource: "programdata"
      }
    });
  });

  it("marks missing dependencies without failing the report", async () => {
    const diagnostics = await collectStartupDiagnostics({
      baseDir: "/missing/base",
      stateFilePath: "/state.json",
      databaseConfigured: true,
      websocketUrlConfigured: true,
      dbDriver: "mysql",
      fileSystem: {
        access: async () => {
          const error = new Error("missing") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
      }
    });

    expect(diagnostics.warnings).toEqual([]);
    expect(diagnostics.report.distFound).toBe(false);
    expect(diagnostics.report.nodeModulesFound).toBe(false);
    expect(diagnostics.report.requiredDependenciesFound).toBe(false);
    expect(diagnostics.report.requiredRuntimeDependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "dist", status: "missing" }),
        expect.objectContaining({ name: "node_modules/mysql2", status: "missing" })
      ])
    );
  });

  it("surfaces access failures as warnings", async () => {
    const diagnostics = await collectStartupDiagnostics({
      baseDir: "/restricted/base",
      stateFilePath: "/state.json",
      databaseConfigured: true,
      websocketUrlConfigured: true,
      fileSystem: {
        access: async () => {
          const error = new Error("permission denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
      }
    });

    expect(diagnostics.report.requiredRuntimeDependencies.every((entry) => entry.status === "unknown")).toBe(true);
    expect(diagnostics.warnings.length).toBeGreaterThan(0);
    expect(diagnostics.warnings[0]).toMatchObject({
      event: "diagnostics.startup_warning",
      message: "Could not verify startup dependency path."
    });
  });
});
