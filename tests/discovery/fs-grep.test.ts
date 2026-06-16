import { describe, expect, it } from "vitest";
import { fsGrep, type FsGrepOps } from "../../src/discovery/fs-grep.js";

type FakeDirEntry = { name: string; isFile: boolean; isDirectory: boolean };

function makeOps(
  tree: Record<string, Record<string, string | "dir">>,
  binaryFiles: Set<string> = new Set()
): FsGrepOps {
  return {
    async readdir(path) {
      const entries = tree[path] ?? {};
      return Object.entries(entries).map(([name, value]) => ({
        name,
        isFile: value !== "dir",
        isDirectory: value === "dir"
      }));
    },
    async readFileBytes(path, maxBytes) {
      if (binaryFiles.has(path)) {
        const buf = Buffer.alloc(10);
        buf[0] = 0; // NUL byte → binário
        return { buffer: buf, truncated: false, totalSize: buf.length };
      }
      const parts = path.split("/");
      const name = parts[parts.length - 1]!;
      const parent = parts.slice(0, -1).join("/");
      const content = tree[parent]?.[name];
      if (typeof content !== "string") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      const buf = Buffer.from(content, "utf8").subarray(0, maxBytes);
      return { buffer: buf, truncated: buf.length < content.length, totalSize: content.length };
    }
  };
}

describe("fsGrep", () => {
  it("encontra match simples em arquivo de extensão correta", async () => {
    const ops = makeOps({ "/root": { "cfg.json": '{"host":"localhost"}' } });
    const result = await fsGrep({ root: "/root", pattern: "localhost" }, ops);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ path: "/root/cfg.json", line: 1 });
    expect(result.filesScanned).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("ignora extensões fora da lista default", async () => {
    const ops = makeOps({ "/root": { "script.sh": "host=localhost" } });
    const result = await fsGrep({ root: "/root", pattern: "localhost" }, ops);
    expect(result.matches).toHaveLength(0);
    expect(result.filesScanned).toBe(0);
  });

  it("respeita extensões customizadas", async () => {
    const ops = makeOps({ "/root": { "readme.txt": "host=localhost" } });
    const result = await fsGrep({ root: "/root", pattern: "localhost", extensions: ["txt"] }, ops);
    expect(result.matches).toHaveLength(1);
  });

  it("pula arquivo binário", async () => {
    const binaryFiles = new Set(["/root/cfg.json"]);
    const ops = makeOps({ "/root": { "cfg.json": "..." } }, binaryFiles);
    const result = await fsGrep({ root: "/root", pattern: "." }, ops);
    expect(result.matches).toHaveLength(0);
    expect(result.filesScanned).toBe(1);
  });

  it("respeita deny-list de roots (raiz /)", async () => {
    const ops = makeOps({ "/": { "db.json": "host=localhost" } });
    const result = await fsGrep({ root: "/", pattern: "localhost" }, ops);
    expect(result.matches).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.reason).toBe("permission");
  });

  it("respeita maxMatches", async () => {
    const content = Array.from({ length: 10 }, (_, i) => `line${i}=match`).join("\n");
    const ops = makeOps({ "/root": { "cfg.conf": content } });
    const result = await fsGrep({ root: "/root", pattern: "match", maxMatches: 3 }, ops);
    expect(result.matches).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("respeita maxFilesScanned", async () => {
    const ops = makeOps({
      "/root": { "a.json": "x", "b.json": "x", "c.json": "x" }
    });
    const result = await fsGrep({ root: "/root", pattern: "nomatch", maxFilesScanned: 1 }, ops);
    expect(result.filesScanned).toBe(1);
  });

  it("registra erro de permissão sem abortar", async () => {
    const ops: FsGrepOps = {
      async readdir() { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); },
      async readFileBytes() { return { buffer: Buffer.from(""), truncated: false, totalSize: 0 }; }
    };
    const result = await fsGrep({ root: "/root", pattern: "x" }, ops);
    expect(result.errors[0]!.reason).toBe("permission");
  });

  it("busca case-insensitive por padrão", async () => {
    const ops = makeOps({ "/root": { "db.ini": "HOST=LOCALHOST" } });
    const result = await fsGrep({ root: "/root", pattern: "localhost" }, ops);
    expect(result.matches).toHaveLength(1);
  });

  it("busca case-sensitive quando ignoreCase=false", async () => {
    const ops = makeOps({ "/root": { "db.ini": "HOST=LOCALHOST" } });
    const result = await fsGrep({ root: "/root", pattern: "localhost", ignoreCase: false }, ops);
    expect(result.matches).toHaveLength(0);
  });

  it("pula node_modules e .git", async () => {
    const ops = makeOps({
      "/root": { "node_modules": "dir", ".git": "dir" },
      "/root/node_modules": { "cfg.json": "match" },
      "/root/.git": { "db.json": "match" }
    });
    const result = await fsGrep({ root: "/root", pattern: "match" }, ops);
    expect(result.matches).toHaveLength(0);
  });
});
