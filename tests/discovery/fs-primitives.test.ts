import { describe, expect, it } from "vitest";
import {
  fsListDir,
  fsReadFile,
  fsStat,
  DEFAULT_MAX_READ_BYTES,
  type FsPrimitivesOps
} from "../../src/discovery/fs-primitives.js";

interface FakeFile {
  type: "file";
  content: Buffer;
  mtimeMs?: number;
}
interface FakeDir {
  type: "dir";
  entries: Record<string, FakeFile | FakeDir>;
}
type FakeNode = FakeFile | FakeDir;

function makeOps(tree: Record<string, FakeNode>): FsPrimitivesOps {
  const lookup = (p: string): FakeNode | undefined => tree[p];
  return {
    async stat(path) {
      const node = lookup(path);
      if (!node) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return {
        isFile: node.type === "file",
        isDirectory: node.type === "dir",
        size: node.type === "file" ? node.content.length : 0,
        mtimeMs: node.type === "file" ? node.mtimeMs : undefined
      };
    },
    async readdir(path) {
      const node = lookup(path);
      if (!node) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      if (node.type !== "dir") {
        const err = new Error("ENOTDIR") as NodeJS.ErrnoException;
        err.code = "ENOTDIR";
        throw err;
      }
      return Object.entries(node.entries).map(([name, child]) => ({
        name,
        isFile: child.type === "file",
        isDirectory: child.type === "dir",
        size: child.type === "file" ? child.content.length : undefined
      }));
    },
    async readFileBytes(path, maxBytes) {
      const node = lookup(path);
      if (!node || node.type !== "file") {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      const truncated = node.content.length > maxBytes;
      return { buffer: node.content.subarray(0, maxBytes), truncated, totalSize: node.content.length };
    }
  };
}

describe("fsListDir", () => {
  it("lista entradas com name/type/size", async () => {
    const ops = makeOps({
      "/app": {
        type: "dir",
        entries: {
          "db.conf": { type: "file", content: Buffer.from("abc") },
          sub: { type: "dir", entries: {} }
        }
      }
    });
    const res = await fsListDir({ path: "/app" }, ops);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payload.entries).toEqual(
      expect.arrayContaining([
        { name: "db.conf", type: "file", size: 3 },
        { name: "sub", type: "dir" }
      ])
    );
  });

  it("rejeita caminho crítico de SO", async () => {
    const ops = makeOps({});
    const res = await fsListDir({ path: "/proc/1" }, ops);
    expect(res).toEqual({ ok: false, errorCode: "DENIED_PATH" });
  });

  it("caminho inexistente → NOT_FOUND", async () => {
    const ops = makeOps({});
    const res = await fsListDir({ path: "/nope" }, ops);
    expect(res).toEqual({ ok: false, errorCode: "NOT_FOUND" });
  });
});

describe("fsReadFile", () => {
  it("lê conteúdo texto e marca truncated=false", async () => {
    const ops = makeOps({
      "/app/db.conf": { type: "file", content: Buffer.from("user=svc\npass=123") }
    });
    const res = await fsReadFile({ path: "/app/db.conf" }, ops);
    expect(res).toEqual({
      ok: true,
      payload: { path: "/app/db.conf", content: "user=svc\npass=123", truncated: false }
    });
  });

  it("trunca quando excede o cap de bytes", async () => {
    const big = Buffer.from("x".repeat(DEFAULT_MAX_READ_BYTES + 100));
    const ops = makeOps({ "/big.txt": { type: "file", content: big } });
    const res = await fsReadFile({ path: "/big.txt" }, ops);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payload.truncated).toBe(true);
    expect(Buffer.byteLength(res.payload.content, "utf8")).toBeLessThanOrEqual(DEFAULT_MAX_READ_BYTES);
  });

  it("respeita maxBytes informado", async () => {
    const ops = makeOps({ "/f.txt": { type: "file", content: Buffer.from("abcdef") } });
    const res = await fsReadFile({ path: "/f.txt", maxBytes: 3 }, ops);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payload.content).toBe("abc");
    expect(res.payload.truncated).toBe(true);
  });

  it("rejeita arquivo binário (NUL byte) → BINARY_FILE", async () => {
    const ops = makeOps({ "/bin.dat": { type: "file", content: Buffer.from([0x41, 0x00, 0x42]) } });
    const res = await fsReadFile({ path: "/bin.dat" }, ops);
    expect(res).toEqual({ ok: false, errorCode: "BINARY_FILE" });
  });

  it("rejeita caminho crítico de SO → DENIED_PATH", async () => {
    const ops = makeOps({});
    const res = await fsReadFile({ path: "C:\\Windows\\System32\\config\\SAM" }, ops);
    expect(res).toEqual({ ok: false, errorCode: "DENIED_PATH" });
  });

  it("caminho inexistente → NOT_FOUND", async () => {
    const ops = makeOps({});
    const res = await fsReadFile({ path: "/nope" }, ops);
    expect(res).toEqual({ ok: false, errorCode: "NOT_FOUND" });
  });
});

describe("fsStat", () => {
  it("arquivo existente → exists:true com type/size/mtime", async () => {
    const ops = makeOps({
      "/app/db.conf": { type: "file", content: Buffer.from("abc"), mtimeMs: 1717000000000 }
    });
    const res = await fsStat({ path: "/app/db.conf" }, ops);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payload).toMatchObject({ exists: true, type: "file", size: 3 });
    expect(res.payload.mtime).toBe(new Date(1717000000000).toISOString());
  });

  it("caminho inexistente → exists:false (ok:true)", async () => {
    const ops = makeOps({});
    const res = await fsStat({ path: "/nope" }, ops);
    expect(res).toEqual({ ok: true, payload: { exists: false } });
  });

  it("rejeita caminho crítico de SO → DENIED_PATH", async () => {
    const ops = makeOps({});
    const res = await fsStat({ path: "/sys/kernel" }, ops);
    expect(res).toEqual({ ok: false, errorCode: "DENIED_PATH" });
  });
});
