import { promises as fs } from "node:fs";

export interface FsStat {
  isFile: boolean;
  isDirectory: boolean;
}

export interface FileSystemReader {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  listDir(path: string): Promise<string[]>;
  stat(path: string): Promise<FsStat | undefined>;
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
  }
};
