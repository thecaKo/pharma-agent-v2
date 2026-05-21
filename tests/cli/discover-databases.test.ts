import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatDiscoveryTable,
  parseDiscoverDatabasesArgs,
  runDiscoverDatabasesCli
} from "../../src/cli/discover-databases.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("discover databases CLI parser", () => {
  it("parses a root option", () => {
    expect(parseDiscoverDatabasesArgs(["--root", "/tmp/dbs"])).toEqual({
      roots: ["/tmp/dbs"]
    });
  });

  it("parses repeated root options in argument order", () => {
    expect(parseDiscoverDatabasesArgs(["--root", "/tmp/a", "--root", "/tmp/b"])).toEqual({
      roots: ["/tmp/a", "/tmp/b"]
    });
  });

  it("rejects unknown options", () => {
    expect(() => parseDiscoverDatabasesArgs(["--json"])).toThrow("Unknown option: --json");
  });
});

describe("discover databases CLI runner", () => {
  it("returns a usage error when root is missing a value without starting discovery", async () => {
    const output = createBufferedOutput();
    const scan = vi.fn();

    await expect(
      runDiscoverDatabasesCli(["--root"], {
        ...output,
        discoverDatabaseFiles: scan
      })
    ).resolves.toBe(1);

    expect(output.stdoutText()).toBe("");
    expect(output.stderrText()).toContain("--root requires a value");
    expect(output.stderrText()).toContain("Usage: discover-databases [--root <path>]");
    expect(scan).not.toHaveBeenCalled();
  });

  it("returns a descriptive error for unknown options without starting discovery", async () => {
    const output = createBufferedOutput();
    const scan = vi.fn();

    await expect(
      runDiscoverDatabasesCli(["--unknown"], {
        ...output,
        discoverDatabaseFiles: scan
      })
    ).resolves.toBe(1);

    expect(output.stdoutText()).toBe("");
    expect(output.stderrText()).toContain("Unknown option: --unknown");
    expect(scan).not.toHaveBeenCalled();
  });

  it("prints a tabular header, candidate rows, and scan summaries", async () => {
    const output = createBufferedOutput();

    await expect(
      runDiscoverDatabasesCli(["--root", "/tmp/dbs"], {
        ...output,
        discoverDatabaseFiles: async (options) => {
          expect(options).toEqual({ roots: ["/tmp/dbs"] });
          return {
            candidates: [{ path: "/tmp/dbs/PHARMACY.FDB", type: "firebird", confidence: "high" }],
            scannedPaths: 12,
            blockedPaths: 2
          };
        }
      })
    ).resolves.toBe(0);

    expect(output.stdoutText()).toBe(
      "path\ttype\tconfidence\n/tmp/dbs/PHARMACY.FDB\tfirebird\thigh\n\nScanned paths: 12\nBlocked paths: 2\n"
    );
    expect(output.stderrText()).toBe("");
  });

  it("formats an empty candidate table with the required columns", () => {
    expect(formatDiscoveryTable([])).toBe("path\ttype\tconfidence\n");
  });

  it("discovers Firebird and MySQL candidates from a temporary fixture root", async () => {
    const root = await createTemporaryDirectory();
    const firebirdPath = path.join(root, "PHARMACY.FDB");
    const mysqlDirectory = path.join(root, "mysql", "data", "pharmacy");
    const mysqlPath = path.join(mysqlDirectory, "products.ibd");
    const sqlServerDirectory = path.join(root, "sqlserver");
    const sqlServerPath = path.join(sqlServerDirectory, "pharmacy.mdf");
    await mkdir(mysqlDirectory, { recursive: true });
    await mkdir(sqlServerDirectory, { recursive: true });
    await writeFile(firebirdPath, "metadata-only fixture");
    await writeFile(mysqlPath, "metadata-only fixture");
    await writeFile(sqlServerPath, "metadata-only fixture");
    const output = createBufferedOutput();

    await expect(runDiscoverDatabasesCli(["--root", root], output)).resolves.toBe(0);

    expect(output.stdoutText()).toContain("path\ttype\tconfidence\n");
    expect(output.stdoutText()).toContain(`${firebirdPath}\tfirebird\thigh\n`);
    expect(output.stdoutText()).toContain(`${mysqlPath}\tmysql\thigh\n`);
    expect(output.stdoutText()).not.toContain(sqlServerPath);
    expect(output.stdoutText()).toContain("Scanned paths:");
    expect(output.stdoutText()).toContain("Blocked paths: 0\n");
    expect(output.stderrText()).toBe("");
  });
});

function createBufferedOutput(): {
  stdout: { write: (chunk: string | Uint8Array) => boolean };
  stderr: { write: (chunk: string | Uint8Array) => boolean };
  stdoutText: () => string;
  stderrText: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    stdout: {
      write: (chunk) => {
        stdout += chunk.toString();
        return true;
      }
    },
    stderr: {
      write: (chunk) => {
        stderr += chunk.toString();
        return true;
      }
    },
    stdoutText: () => stdout,
    stderrText: () => stderr
  };
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "discover-databases-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}
