import { describe, expect, it } from "vitest";
import { fsFind, type FsFindOps } from "../../src/discovery/fs-find.js";

function makeOps(tree: Record<string, Array<{ name: string; isFile: boolean; isDirectory: boolean; size?: number; mtimeMs?: number }>>): FsFindOps {
  return {
    async readdir(path) {
      return tree[path] ?? [];
    }
  };
}

describe("fsFind", () => {
  it("encontra arquivos por glob de nome", async () => {
    const ops = makeOps({
      "/root": [
        { name: "conexao.udl", isFile: true, isDirectory: false, size: 100, mtimeMs: 1000 },
        { name: "readme.txt", isFile: true, isDirectory: false }
      ]
    });
    const result = await fsFind({ roots: ["/root"], namePatterns: ["*.udl"] }, ops);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.path).toBe("/root/conexao.udl");
    expect(result.files[0]!.size).toBe(100);
    expect(result.truncated).toBe(false);
    expect(result.rootsRejected).toHaveLength(0);
  });

  it("rejeita raiz deny-listed", async () => {
    const ops = makeOps({ "/": [] });
    const result = await fsFind({ roots: ["/"], namePatterns: ["*.udl"] }, ops);
    expect(result.rootsRejected).toContain("/");
    expect(result.files).toHaveLength(0);
  });

  it("pula node_modules e .git na travessia", async () => {
    const ops = makeOps({
      "/root": [
        { name: "node_modules", isFile: false, isDirectory: true },
        { name: ".git", isFile: false, isDirectory: true }
      ],
      "/root/node_modules": [{ name: "conexao.udl", isFile: true, isDirectory: false }],
      "/root/.git": [{ name: "config.udl", isFile: true, isDirectory: false }]
    });
    const result = await fsFind({ roots: ["/root"], namePatterns: ["*.udl"] }, ops);
    expect(result.files).toHaveLength(0);
  });

  it("respeita maxResults e marca truncated", async () => {
    const ops = makeOps({
      "/root": [
        { name: "a.udl", isFile: true, isDirectory: false },
        { name: "b.udl", isFile: true, isDirectory: false },
        { name: "c.udl", isFile: true, isDirectory: false }
      ]
    });
    const result = await fsFind({ roots: ["/root"], namePatterns: ["*.udl"], maxResults: 2 }, ops);
    expect(result.files).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("aceita múltiplas raízes", async () => {
    const ops = makeOps({
      "/app": [{ name: "db.udl", isFile: true, isDirectory: false }],
      "/data": [{ name: "cfg.udl", isFile: true, isDirectory: false }]
    });
    const result = await fsFind({ roots: ["/app", "/data"], namePatterns: ["*.udl"] }, ops);
    expect(result.files).toHaveLength(2);
  });

  it("registra erro sem abortar", async () => {
    const ops: FsFindOps = {
      async readdir() { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); }
    };
    const result = await fsFind({ roots: ["/app"], namePatterns: ["*.udl"] }, ops);
    expect(result.errors[0]!.reason).toBe("permission");
    expect(result.files).toHaveLength(0);
  });

  it("suporta glob *config*", async () => {
    const ops = makeOps({
      "/root": [
        { name: "myconfig.ini", isFile: true, isDirectory: false },
        { name: "other.ini", isFile: true, isDirectory: false }
      ]
    });
    const result = await fsFind({ roots: ["/root"], namePatterns: ["*config*"] }, ops);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.path).toContain("myconfig");
  });
});
