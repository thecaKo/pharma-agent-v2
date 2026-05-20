import { fileURLToPath } from "node:url";
import {
  discoverDatabaseFiles,
  type DatabaseFileCandidate,
  type DatabaseFileDiscoveryResult
} from "../db/file-discovery.js";

export interface DiscoverDatabasesCliOptions {
  roots?: string[];
}

export interface DiscoverDatabasesCliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
  discoverDatabaseFiles?: (options: DiscoverDatabasesCliOptions) => Promise<DatabaseFileDiscoveryResult>;
}

export function parseDiscoverDatabasesArgs(argv: readonly string[]): DiscoverDatabasesCliOptions {
  const options: DiscoverDatabasesCliOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }

    switch (arg) {
      case "--root": {
        const root = requiredValue(argv, ++index, "--root");
        options.roots = [...(options.roots ?? []), root];
        break;
      }
      case "--help":
        throw new Error(usage());
      default:
        throw new Error(arg.startsWith("--") ? `Unknown option: ${arg}` : `Unknown argument: ${arg}`);
    }
  }

  return options;
}

export async function runDiscoverDatabasesCli(
  argv: readonly string[],
  io: DiscoverDatabasesCliIo = defaultIo()
): Promise<number> {
  let options: DiscoverDatabasesCliOptions;
  try {
    options = parseDiscoverDatabasesArgs(argv);
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 1;
  }

  try {
    const scan = io.discoverDatabaseFiles ?? discoverDatabaseFiles;
    const result = await scan(options);
    printDiscoveryResult(result, io);
    return 0;
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 1;
  }
}

export function formatDiscoveryTable(candidates: readonly DatabaseFileCandidate[]): string {
  const lines = ["path\ttype\tconfidence"];
  for (const candidate of candidates) {
    lines.push(`${candidate.path}\t${candidate.type}\t${candidate.confidence}`);
  }
  return `${lines.join("\n")}\n`;
}

function printDiscoveryResult(result: DatabaseFileDiscoveryResult, io: DiscoverDatabasesCliIo): void {
  io.stdout.write(formatDiscoveryTable(result.candidates));
  io.stdout.write("\n");
  io.stdout.write(`Scanned paths: ${result.scannedPaths}\n`);
  io.stdout.write(`Blocked paths: ${result.blockedPaths}\n`);
}

function requiredValue(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value\n${usage()}`);
  }
  return value;
}

function usage(): string {
  return "Usage: discover-databases [--root <path>]";
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultIo(): DiscoverDatabasesCliIo {
  return {
    stdout: process.stdout,
    stderr: process.stderr
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const exitCode = await runDiscoverDatabasesCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
