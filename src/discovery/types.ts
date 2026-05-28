import type { RegistryReader } from "../db/registry-reader.js";
import type { FileSystemReader } from "./fs-reader.js";

export interface WindowsService {
  name: string;
  state: "running" | "stopped" | "unknown";
}

export interface ProbeContext {
  registry: RegistryReader;
  fs: FileSystemReader;
  serviceList: () => Promise<WindowsService[]>;
  signal: AbortSignal;
}

export type ProbeErrorCode =
  | "auth"
  | "timeout"
  | "tls"
  | "unreachable"
  | "driver_missing"
  | "unknown";
