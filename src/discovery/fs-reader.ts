export interface FsStat {
  isFile: boolean;
  isDirectory: boolean;
}

export interface FileSystemReader {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  listDir(path: string): Promise<string[]>;
  stat(path: string): Promise<FsStat | undefined>;
}
