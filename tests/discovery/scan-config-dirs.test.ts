import { describe, expect, it, vi } from "vitest";
import { probeScanConfigDirs, DEFAULT_PATTERNS } from "../../src/discovery/scan-config-dirs.js";
import type { FileSystemReader, FsEntry } from "../../src/discovery/fs-reader.js";

interface FsMap {
  [path: string]: FsEntry[] | "permission" | "missing";
}

function makeFs(map: FsMap): FileSystemReader {
  return {
    readFile: vi.fn(async () => ""),
    listDir: vi.fn(async () => []),
    stat: vi.fn(async (path: string) => {
      if (path in map && map[path] !== "missing") {
        return { isFile: false, isDirectory: true };
      }
      return undefined;
    }),
    enumerateTop: vi.fn(async (path: string) => {
      const entries = map[path];
      if (entries === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (entries === "permission") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      if (entries === "missing") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return entries;
    })
  };
}

function file(name: string, size = 100, mtime = new Date("2026-05-01T00:00:00Z")): FsEntry {
  return { name, isFile: true, isDirectory: false, size, mtime };
}

function dir(name: string): FsEntry {
  return { name, isFile: false, isDirectory: true };
}

describe("probeScanConfigDirs", () => {
  it("returns files matching default patterns at depth 0", async () => {
    const fs = makeFs({
      "C:\\Linx": [file("config.ini"), file("readme.txt"), file("app.config")]
    });
    const r = await probeScanConfigDirs({ fs }, { roots: ["C:\\Linx"] });
    expect(r.files.map((f) => f.path).sort()).toEqual([
      "C:\\Linx\\app.config",
      "C:\\Linx\\config.ini"
    ]);
    expect(r.truncated).toBe(false);
    expect(r.rootsRejected).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it("recurses into subdirs up to maxDepth", async () => {
    const fs = makeFs({
      "C:\\Linx": [file("a.ini"), dir("sub")],
      "C:\\Linx\\sub": [file("b.ini"), dir("deeper")],
      "C:\\Linx\\sub\\deeper": [file("c.ini")]
    });
    const r = await probeScanConfigDirs({ fs }, { roots: ["C:\\Linx"], maxDepth: 2 });
    const paths = r.files.map((f) => f.path).sort();
    expect(paths).toEqual([
      "C:\\Linx\\a.ini",
      "C:\\Linx\\sub\\b.ini"
    ]);
  });

  it("rejects roots in deny-list (volume root, Windows folder)", async () => {
    const fs = makeFs({});
    const r = await probeScanConfigDirs({ fs }, {
      roots: ["C:\\", "C:\\Windows", "C:\\Windows\\System32", "C:\\App"]
    });
    expect(r.rootsRejected.sort()).toEqual([
      "C:\\", "C:\\Windows", "C:\\Windows\\System32"
    ]);
  });

  it("rejects Users root but accepts paths under it", async () => {
    const fs = makeFs({
      "C:\\Users\\fulano\\AppData\\Local\\App": [file("settings.json")]
    });
    const r = await probeScanConfigDirs({ fs }, {
      roots: ["C:\\Users", "C:\\Users\\fulano\\AppData\\Local\\App"]
    });
    expect(r.rootsRejected).toEqual(["C:\\Users"]);
    expect(r.files.map((f) => f.path)).toEqual([
      "C:\\Users\\fulano\\AppData\\Local\\App\\settings.json"
    ]);
  });

  it("skips dirs in SKIP_DIR_NAMES_CI", async () => {
    const fs = makeFs({
      "C:\\App": [
        file("a.ini"),
        dir("node_modules"),
        dir("Temp"),
        dir("config"),
        dir(".git")
      ],
      "C:\\App\\node_modules": [file("evil.ini")],
      "C:\\App\\Temp": [file("evil2.ini")],
      "C:\\App\\config": [file("good.ini")],
      "C:\\App\\.git": [file("evil3.ini")]
    });
    const r = await probeScanConfigDirs({ fs }, { roots: ["C:\\App"], maxDepth: 2 });
    const paths = r.files.map((f) => f.path).sort();
    expect(paths).toEqual([
      "C:\\App\\a.ini",
      "C:\\App\\config\\good.ini"
    ]);
  });

  it("preserves .config hidden dir (cross-platform)", async () => {
    const fs = makeFs({
      "/home/user": [dir(".config"), dir(".cache")],
      "/home/user/.config": [file("app.ini")],
      "/home/user/.cache": [file("evil.ini")]
    });
    const r = await probeScanConfigDirs({ fs }, { roots: ["/home/user"], maxDepth: 2 });
    expect(r.files.map((f) => f.path)).toEqual(["/home/user/.config/app.ini"]);
  });

  it("truncates at maxFiles", async () => {
    const entries: FsEntry[] = [];
    for (let i = 0; i < 50; i += 1) entries.push(file(`f${i}.ini`));
    const fs = makeFs({ "C:\\App": entries });
    const r = await probeScanConfigDirs({ fs }, { roots: ["C:\\App"], maxFiles: 10 });
    expect(r.files).toHaveLength(10);
    expect(r.truncated).toBe(true);
  });

  it("clamps maxDepth to ceiling silently", async () => {
    const fs = makeFs({ "C:\\App": [file("a.ini")] });
    const r = await probeScanConfigDirs({ fs }, { roots: ["C:\\App"], maxDepth: 999 });
    expect(r.files).toHaveLength(1);
  });

  it("filters by maxAgeDays", async () => {
    const now = new Date("2026-05-28T00:00:00Z");
    const fs = makeFs({
      "C:\\App": [
        file("recent.ini", 100, new Date("2026-05-25T00:00:00Z")),
        file("old.ini", 100, new Date("2024-01-01T00:00:00Z"))
      ]
    });
    const r = await probeScanConfigDirs({ fs, now: () => now }, {
      roots: ["C:\\App"],
      maxAgeDays: 30
    });
    expect(r.files.map((f) => f.path)).toEqual(["C:\\App\\recent.ini"]);
  });

  it("records permission errors without aborting", async () => {
    const fs = makeFs({
      "C:\\App": [file("a.ini"), dir("protected")],
      "C:\\App\\protected": "permission"
    });
    const r = await probeScanConfigDirs({ fs }, { roots: ["C:\\App"], maxDepth: 2 });
    expect(r.files.map((f) => f.path)).toEqual(["C:\\App\\a.ini"]);
    expect(r.errors).toEqual([{ path: "C:\\App\\protected", reason: "permission" }]);
  });

  it("records missing root in errors", async () => {
    const fs = makeFs({});
    const r = await probeScanConfigDirs({ fs }, { roots: ["C:\\Inexistente"] });
    expect(r.errors).toEqual([{ path: "C:\\Inexistente", reason: "missing" }]);
  });

  it("expands environment variables in roots", async () => {
    const fs = makeFs({
      "C:\\Program Files\\App": [file("config.ini")]
    });
    const env = { PROGRAMFILES: "C:\\Program Files" };
    const r = await probeScanConfigDirs({ fs, env }, { roots: ["%PROGRAMFILES%\\App"] });
    expect(r.files.map((f) => f.path)).toEqual(["C:\\Program Files\\App\\config.ini"]);
  });

  it("rejects root with unresolved env var", async () => {
    const fs = makeFs({});
    const r = await probeScanConfigDirs(
      { fs, env: {} },
      { roots: ["%UNDEFINED_VAR%\\App"] }
    );
    expect(r.rootsRejected).toEqual(["%UNDEFINED_VAR%\\App"]);
  });

  it("respects custom patterns case-insensitively", async () => {
    const fs = makeFs({
      "C:\\App": [file("a.INI"), file("b.txt"), file("c.YML")]
    });
    const r = await probeScanConfigDirs({ fs }, {
      roots: ["C:\\App"],
      patterns: ["*.ini", "*.yml"]
    });
    expect(r.files.map((f) => f.path).sort()).toEqual([
      "C:\\App\\a.INI",
      "C:\\App\\c.YML"
    ]);
  });

  it("DEFAULT_PATTERNS includes ini/json/xml/env/db", () => {
    expect(DEFAULT_PATTERNS).toContain("*.ini");
    expect(DEFAULT_PATTERNS).toContain("*.json");
    expect(DEFAULT_PATTERNS).toContain("*.xml");
    expect(DEFAULT_PATTERNS).toContain("*.env");
    expect(DEFAULT_PATTERNS).toContain("*.db");
  });
});
