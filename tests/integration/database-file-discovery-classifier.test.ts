import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDatabaseSetupCandidateViews,
  classifyDatabasePath,
  discoverDatabaseFiles,
  sortDatabaseFileCandidates
} from "../../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("database discovery classifier integration surface", () => {
  it("lets downstream discovery consumers classify metadata entries and reuse canonical sorting", () => {
    const metadataEntries = [
      { path: "/scan/mysql/products.frm", kind: "file" as const },
      { path: "/scan/sql/pharmacy.mdf", kind: "file" as const },
      { path: "/scan/readme.md", kind: "file" as const },
      { path: "/scan/firebird/PHARMACY.FDB", kind: "file" as const }
    ];

    const candidates = sortDatabaseFileCandidates(
      metadataEntries.flatMap((entry) => {
        const candidate = classifyDatabasePath(entry);
        return candidate === undefined ? [] : [candidate];
      })
    );

    expect(candidates).toEqual([
      { path: "/scan/firebird/PHARMACY.FDB", type: "firebird", confidence: "high" },
      { path: "/scan/sql/pharmacy.mdf", type: "sqlserver", confidence: "high" },
      { path: "/scan/mysql/products.frm", type: "mysql", confidence: "low" }
    ]);

    expect(buildDatabaseSetupCandidateViews(candidates)).toEqual([
      {
        index: 1,
        path: "/scan/firebird/PHARMACY.FDB",
        type: "firebird",
        confidence: "high",
        supported: true,
        internal: false,
        warning: undefined
      },
      {
        index: 2,
        path: "/scan/mysql/products.frm",
        type: "mysql",
        confidence: "low",
        supported: true,
        internal: false,
        warning: undefined
      },
      {
        index: 3,
        path: "/scan/sql/pharmacy.mdf",
        type: "sqlserver",
        confidence: "high",
        supported: false,
        warning: "SQL Server discovery is visible, but onboarding support is not implemented."
      }
    ]);
  });
});

describe("database file discovery scanner integration", () => {
  it("traverses temporary filesystem fixtures and returns metadata-only database candidates", async () => {
    const root = await createTemporaryDirectory();
    const firebirdDirectory = path.join(root, "firebird");
    const mysqlDirectory = path.join(root, "vendor", "mysql", "data");
    const sqlServerDirectory = path.join(root, "sqlserver");
    await mkdir(firebirdDirectory, { recursive: true });
    await mkdir(mysqlDirectory, { recursive: true });
    await mkdir(sqlServerDirectory, { recursive: true });

    const firebirdPath = path.join(firebirdDirectory, "PHARMACY.FDB");
    const mysqlPath = path.join(mysqlDirectory, "products.frm");
    const sqlServerPath = path.join(sqlServerDirectory, "pharmacy.ldf");
    await writeFile(firebirdPath, "not inspected");
    await writeFile(mysqlPath, "not inspected");
    await writeFile(sqlServerPath, "not inspected");
    await writeFile(path.join(root, "readme.txt"), "not a database");

    const result = await discoverDatabaseFiles({ roots: [root] });

    expect(result.candidates).toEqual([
      { path: firebirdPath, type: "firebird", confidence: "high" },
      { path: path.join(root, "vendor", "mysql", "data"), type: "mysql", confidence: "medium" },
      { path: mysqlPath, type: "mysql", confidence: "low" },
      { path: sqlServerPath, type: "sqlserver", confidence: "low" }
    ]);
    expect(result.scannedPaths).toBe(10);
    expect(result.blockedPaths).toBe(0);
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "database-file-discovery-integration-"));
  temporaryDirectories.push(directory);
  return directory;
}
