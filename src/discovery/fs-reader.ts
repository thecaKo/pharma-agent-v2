import { promises as fs } from "node:fs";
import { join } from "node:path";

export interface FsStat {
  isFile: boolean;
  isDirectory: boolean;
}

export interface FsEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  size?: number;
  mtime?: Date;
}

export interface FileSystemReader {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  listDir(path: string): Promise<string[]>;
  stat(path: string): Promise<FsStat | undefined>;
  enumerateTop(path: string): Promise<FsEntry[]>;
}

export const nodeFileSystemReader: FileSystemReader = {
  async readFile(path, encoding) {
    return fs.readFile(path, { encoding });
  },
  async listDir(path) {
    try {
      return await fs.readdir(path);
    } catch {
      return [];
    }
  },
  async stat(path) {
    try {
      const s = await fs.stat(path);
      return { isFile: s.isFile(), isDirectory: s.isDirectory() };
    } catch {
      return undefined;
    }
  },
  async enumerateTop(path) {
    const dirents = await fs.readdir(path, { withFileTypes: true });
    const entries: FsEntry[] = [];
    for (const dirent of dirents) {
      const full = join(path, dirent.name);
      let size: number | undefined;
      let mtime: Date | undefined;
      try {
        const s = await fs.stat(full);
        size = s.size;
        mtime = s.mtime;
      } catch {
        // ignore stat errors per entry; still emit dirent
      }
      entries.push({
        name: dirent.name,
        isFile: dirent.isFile(),
        isDirectory: dirent.isDirectory(),
        size,
        mtime
      });
    }
    return entries;
  }
};
