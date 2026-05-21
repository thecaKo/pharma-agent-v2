import pino, { type DestinationStream } from "pino";
import type { LogLevel } from "../config/types.js";
import { redactValue } from "./redact.js";

export interface Logger {
  debug(event: string, metadata?: Record<string, unknown>): void;
  info(event: string, metadata?: Record<string, unknown>): void;
  warn(event: string, metadata?: Record<string, unknown>): void;
  error(event: string, metadata?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  level: LogLevel;
  secrets?: readonly string[];
  output?: Pick<Console, "log" | "error">;
  nodeEnv?: string;
}

const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

export function createLogger(options: LoggerOptions): Logger {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  if (nodeEnv !== "dev") {
    return noopLogger;
  }

  const logger = pino(
    {
      level: options.level,
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label })
      }
    },
    buildOutputStream(options.output ?? console)
  );

  function write(level: LogLevel, event: string, metadata: Record<string, unknown> = {}): void {
    const entry = redactValue({ event, ...metadata }, options.secrets ?? []);
    logger[level](entry);
  }

  return {
    debug: (event, metadata) => write("debug", event, metadata),
    info: (event, metadata) => write("info", event, metadata),
    warn: (event, metadata) => write("warn", event, metadata),
    error: (event, metadata) => write("error", event, metadata)
  };
}

function buildOutputStream(output: Pick<Console, "log" | "error">): DestinationStream {
  return {
    write(line: string): void {
      const trimmed = line.trimEnd();
      if (readLogLevel(trimmed) === "error") {
        output.error(trimmed);
        return;
      }

      output.log(trimmed);
    }
  };
}

function readLogLevel(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line) as { level?: unknown };
    return typeof parsed.level === "string" ? parsed.level : undefined;
  } catch {
    return undefined;
  }
}
