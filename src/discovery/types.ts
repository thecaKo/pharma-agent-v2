import type { RegistryReader } from "../db/registry-reader.js";
import type { FileSystemReader } from "./fs-reader.js";

export interface WindowsService {
  name: string;
  state: "running" | "stopped" | "unknown";
}

export interface WindowsProcess {
  pid: number;
  name: string;
  path?: string;
}

export interface WindowsConnection {
  pid: number;
  localAddr: string;
  localPort: number;
  remoteAddr: string;
  remotePort: number;
  state: string;
}

export interface ProbeContext {
  registry: RegistryReader;
  fs: FileSystemReader;
  serviceList: () => Promise<WindowsService[]>;
  listProcesses: () => Promise<WindowsProcess[]>;
  listConnections: () => Promise<WindowsConnection[]>;
  signal: AbortSignal;
}

export type ProbeErrorCode =
  | "auth"
  | "timeout"
  | "tls"
  | "unreachable"
  | "driver_missing"
  | "unknown";
