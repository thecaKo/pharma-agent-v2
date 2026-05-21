import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDatabaseSetupCandidateViews,
  classifyDatabasePath,
  compareDatabaseSetupCandidateViews,
  compareDatabaseFileCandidates,
  discoverDatabaseFiles,
  formatDatabaseSetupCandidateView,
  resolveDatabaseDiscoveryRoots,
  sortDatabaseFileCandidates,
  type DatabaseFileCandidate
} from "../../src/db/file-discovery.js";

const temporaryDirectories: string[] = [];
const itIfPermissionDeniedCanBeModeled =
  process.platform === "win32" || process.getuid?.() === 0 ? it.skip : it;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("database file discovery classifier", () => {
  it("classifies Firebird file candidates from metadata", () => {
    expect(classifyDatabasePath({ path: "/pharmacy/PHARMACY.FDB", kind: "file" })).toEqual({
      path: "/pharmacy/PHARMACY.FDB",
      type: "firebird",
      confidence: "high"
    });

    expect(classifyDatabasePath({ path: "/pharmacy/archive.GDB", kind: "file" })).toMatchObject({
      type: "firebird",
      confidence: "medium"
    });
    expect(classifyDatabasePath({ path: "/pharmacy/backup.fbk", kind: "file" })).toMatchObject({
      type: "firebird",
      confidence: "low"
    });
  });

  it("classifies MySQL file candidates from metadata", () => {
    expect(classifyDatabasePath({ path: "/mysql/pharmacy/products.ibd", kind: "file" })).toEqual({
      path: "/mysql/pharmacy/products.ibd",
      type: "mysql",
      confidence: "high"
    });

    expect(classifyDatabasePath({ path: "/mysql/pharmacy/products.MYD", kind: "file" })).toMatchObject({
      type: "mysql",
      confidence: "medium"
    });
    expect(classifyDatabasePath({ path: "/mysql/pharmacy/products.frm", kind: "file" })).toMatchObject({
      type: "mysql",
      confidence: "low"
    });
  });

  it("ignores unrelated files, directories, and unsupported database extensions", () => {
    expect(classifyDatabasePath({ path: "/documents/pharmacy.txt", kind: "file" })).toBeUndefined();
    expect(classifyDatabasePath({ path: "/documents/data", kind: "directory" })).toBeUndefined();
    expect(classifyDatabasePath({ path: "/backups/pharmacy.sqlite", kind: "file" })).toBeUndefined();
    expect(classifyDatabasePath({ path: "/sql/pharmacy.mdf", kind: "file" })).toBeUndefined();
    expect(classifyDatabasePath({ path: "/mysql/data/ibdata1", kind: "file" })).toBeUndefined();
  });
});

describe("database file discovery scanner", () => {
  it("resolves explicit roots to deterministic absolute paths", () => {
    const left = path.join("scan", "b");
    const right = path.join("scan", "a");

    expect(resolveDatabaseDiscoveryRoots([left, right, left])).toEqual([
      path.resolve(right),
      path.resolve(left)
    ]);
  });

  it("uses every Windows drive or the current filesystem root when no explicit roots are provided", () => {
    const expectedRoots =
      process.platform === "win32"
        ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((drive) => `${drive}:\\`)
        : [path.parse(process.cwd()).root];

    expect(resolveDatabaseDiscoveryRoots()).toEqual(expectedRoots);
  });

  it("returns a Firebird candidate from an explicit root", async () => {
    const root = await createTemporaryDirectory();
    const candidatePath = path.join(root, "PHARMACY.FDB");
    await writeFile(candidatePath, "content that must not be read");

    await expect(discoverDatabaseFiles({ roots: [root] })).resolves.toMatchObject({
      candidates: [{ path: candidatePath, type: "firebird", confidence: "high", sizeBytes: 29 }],
      scannedPaths: 2,
      blockedPaths: 0
    });
  });

  it("discovers nested MySQL files and ignores unsupported artifacts and directories", async () => {
    const root = await createTemporaryDirectory();
    const sqlDirectory = path.join(root, "sql");
    const mysqlDirectory = path.join(root, "mysql", "data", "pharmacy");
    await mkdir(sqlDirectory, { recursive: true });
    await mkdir(mysqlDirectory, { recursive: true });
    const sqlServerPath = path.join(sqlDirectory, "pharmacy.mdf");
    const mysqlPath = path.join(mysqlDirectory, "products.ibd");
    await writeFile(sqlServerPath, "");
    await writeFile(mysqlPath, "");

    const result = await discoverDatabaseFiles({ roots: [root] });

    expect(result.candidates).toEqual([
      { path: mysqlPath, type: "mysql", confidence: "high", sizeBytes: 0 }
    ]);
    expect(result.scannedPaths).toBe(7);
    expect(result.blockedPaths).toBe(0);
  });

  it("skips node_modules and ignores non-database files", async () => {
    const root = await createTemporaryDirectory();
    const modulesDirectory = path.join(root, "node_modules", ".pnpm");
    await mkdir(modulesDirectory, { recursive: true });
    await writeFile(path.join(modulesDirectory, "pnpm-workspace-state-v1.json"), "{}");
    await writeFile(path.join(root, "PHARMACY.FDB"), "");

    const result = await discoverDatabaseFiles({ roots: [root] });

    expect(result.candidates).toEqual([
      { path: path.join(root, "PHARMACY.FDB"), type: "firebird", confidence: "high", sizeBytes: 0 }
    ]);
  });

  it("reports scanned path counts for an empty root", async () => {
    const root = await createTemporaryDirectory();

    await expect(discoverDatabaseFiles({ roots: [root] })).resolves.toEqual({
      candidates: [],
      scannedPaths: 1,
      blockedPaths: 0
    });
  });

  it("counts blocked missing paths without throwing", async () => {
    const root = await createTemporaryDirectory();
    const missingPath = path.join(root, "missing");

    await expect(discoverDatabaseFiles({ roots: [missingPath] })).resolves.toEqual({
      candidates: [],
      scannedPaths: 0,
      blockedPaths: 1
    });
  });

  itIfPermissionDeniedCanBeModeled("continues scanning when a child directory cannot be opened", async () => {
    const root = await createTemporaryDirectory();
    const blockedDirectory = path.join(root, "blocked");
    const candidatePath = path.join(root, "PHARMACY.FDB");
    await mkdir(blockedDirectory);
    await writeFile(candidatePath, "");

    try {
      await chmod(blockedDirectory, 0o000);

      await expect(discoverDatabaseFiles({ roots: [root] })).resolves.toMatchObject({
        candidates: [{ path: candidatePath, type: "firebird", confidence: "high", sizeBytes: 0 }],
        scannedPaths: 3,
        blockedPaths: 1
      });
    } finally {
      await chmod(blockedDirectory, 0o700);
    }
  });

  it("sorts candidates deterministically regardless of root traversal order", async () => {
    const root = await createTemporaryDirectory();
    const zDirectory = path.join(root, "z-mysql");
    const aDirectory = path.join(root, "a-firebird");
    await mkdir(zDirectory, { recursive: true });
    await mkdir(aDirectory, { recursive: true });
    const mysqlPath = path.join(zDirectory, "products.ibd");
    const firebirdPath = path.join(aDirectory, "PHARMACY.FDB");
    await writeFile(mysqlPath, "");
    await writeFile(firebirdPath, "");

    await expect(discoverDatabaseFiles({ roots: [zDirectory, aDirectory] })).resolves.toMatchObject({
      candidates: [
        { path: firebirdPath, type: "firebird", confidence: "high" },
        { path: mysqlPath, type: "mysql", confidence: "high" }
      ]
    });
  });
});

describe("database file discovery sorting", () => {
  it("sorts deterministically by confidence, type, and path without mutating input", () => {
    const candidates: DatabaseFileCandidate[] = [
      { path: "/z/mysql/products.frm", type: "mysql", confidence: "low" },
      { path: "/a/mysql/products.ibd", type: "mysql", confidence: "high" },
      { path: "/b/firebird/PHARMACY.FDB", type: "firebird", confidence: "high" },
      { path: "/a/firebird/ARCHIVE.GDB", type: "firebird", confidence: "medium" }
    ];

    expect(sortDatabaseFileCandidates(candidates)).toEqual([
      { path: "/b/firebird/PHARMACY.FDB", type: "firebird", confidence: "high" },
      { path: "/a/mysql/products.ibd", type: "mysql", confidence: "high" },
      { path: "/a/firebird/ARCHIVE.GDB", type: "firebird", confidence: "medium" },
      { path: "/z/mysql/products.frm", type: "mysql", confidence: "low" }
    ]);
    expect(candidates[0]).toEqual({ path: "/z/mysql/products.frm", type: "mysql", confidence: "low" });
  });

  it("provides a comparator for downstream stable output", () => {
    expect(
      compareDatabaseFileCandidates(
        { path: "/a/pharmacy.fdb", type: "firebird", confidence: "high" },
        { path: "/b/products.ibd", type: "mysql", confidence: "high" }
      )
    ).toBeLessThan(0);
  });
});

describe("database setup candidate views", () => {
  it("marks a Firebird database as supported and ranks it before lower-confidence candidates", () => {
    const views = buildDatabaseSetupCandidateViews([
      { path: "/mysql/pharmacy/products.frm", type: "mysql", confidence: "low" },
      { path: "/firebird/PHARMACY.FDB", type: "firebird", confidence: "high" }
    ]);

    expect(views).toEqual([
      {
        index: 1,
        path: "/firebird/PHARMACY.FDB",
        type: "firebird",
        confidence: "high",
        supported: true,
        internal: false,
        warning: undefined
      },
      {
        index: 2,
        path: "/mysql/pharmacy/products.frm",
        type: "mysql",
        confidence: "low",
        supported: true,
        internal: false,
        warning: undefined
      }
    ]);
  });

  it("marks Firebird security databases as internal candidates", () => {
    expect(
      buildDatabaseSetupCandidateViews([
        { path: "/firebird/security3.fdb", type: "firebird", confidence: "high" },
        { path: "/firebird/security4.fdb", type: "firebird", confidence: "high" }
      ])
    ).toEqual([
      {
        index: 1,
        path: "/firebird/security3.fdb",
        type: "firebird",
        confidence: "high",
        supported: true,
        internal: true,
        warning: "Firebird security database detected; choose the pharmacy database instead."
      },
      {
        index: 2,
        path: "/firebird/security4.fdb",
        type: "firebird",
        confidence: "high",
        supported: true,
        internal: true,
        warning: "Firebird security database detected; choose the pharmacy database instead."
      }
    ]);
  });

  it("marks MySQL internal files with supported extensions as internal candidates", () => {
    const views = buildDatabaseSetupCandidateViews([
      { path: "/mysql/data/mysql.ibd", type: "mysql", confidence: "high" }
    ]);

    expect(views).toEqual([
      {
        index: 1,
        path: "/mysql/data/mysql.ibd",
        type: "mysql",
        confidence: "high",
        supported: true,
        internal: true,
        warning: "MySQL internal/shared file detected; choose an application schema file instead."
      }
    ]);
  });

  it("sorts equal-confidence setup candidates deterministically", () => {
    const views = buildDatabaseSetupCandidateViews([
      { path: "/b/PHARMACY.FDB", type: "firebird", confidence: "high" },
      { path: "/a/PHARMACY.FDB", type: "firebird", confidence: "high" }
    ]);

    expect(views.map((view) => view.path)).toEqual(["/a/PHARMACY.FDB", "/b/PHARMACY.FDB"]);
    expect(compareDatabaseSetupCandidateViews(views[0], views[1])).toBeLessThan(0);
  });

  it("formats supported and internal setup candidates for interactive selection", () => {
    const views = buildDatabaseSetupCandidateViews([
      { path: "/firebird/security3.fdb", type: "firebird", confidence: "high" },
      { path: "/firebird/PHARMACY.FDB", type: "firebird", confidence: "high" }
    ]);

    expect(views.map((view) => formatDatabaseSetupCandidateView(view))).toEqual([
      "1. /firebird/PHARMACY.FDB [firebird, high, supported]",
      "2. /firebird/security3.fdb [firebird, high, internal] - Firebird security database detected; choose the pharmacy database instead."
    ]);
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "database-file-discovery-"));
  temporaryDirectories.push(directory);
  return directory;
}
