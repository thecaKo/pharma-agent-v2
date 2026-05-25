import pino, { type DestinationStream } from "pino";
import pretty from "pino-pretty";
import type { LogLevel } from "../config/types.js";
import { redactValue } from "./redact.js";

export interface Logger {
  debug(event: string, metadata?: Record<string, unknown>): void;
  info(event: string, metadata?: Record<string, unknown>): void;
  warn(event: string, metadata?: Record<string, unknown>): void;
  error(event: string, metadata?: Record<string, unknown>): void;
}

export type LogFormat = "json" | "pretty";

export interface LoggerOptions {
  level: LogLevel;
  secrets?: readonly string[];
  output?: Pick<Console, "log" | "error">;
  nodeEnv?: string;
  logFormat?: LogFormat;
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
      messageKey: "event",
      formatters: {
        level: (label) => ({ level: label })
      }
    },
    resolveStream(options)
  );

  function write(level: LogLevel, event: string, metadata: Record<string, unknown> = {}): void {
    const safeMeta = redactValue(metadata, options.secrets ?? []) as object;
    logger[level](safeMeta, event);
  }

  return {
    debug: (event, metadata) => write("debug", event, metadata),
    info: (event, metadata) => write("info", event, metadata),
    warn: (event, metadata) => write("warn", event, metadata),
    error: (event, metadata) => write("error", event, metadata)
  };
}

function resolveStream(options: LoggerOptions): DestinationStream {
  if (options.output) {
    return buildConsoleJsonStream(options.output);
  }
  const format = options.logFormat ?? readLogFormatEnv() ?? "json";
  if (format === "pretty") {
    return pretty({
      colorize: true,
      translateTime: "SYS:HH:MM:ss.l",
      ignore: "pid,hostname",
      messageKey: "event"
    });
  }
  return buildConsoleJsonStream(console);
}

function readLogFormatEnv(): LogFormat | undefined {
  const raw = process.env.LOG_FORMAT?.trim().toLowerCase();
  if (raw === "json" || raw === "pretty") {
    return raw;
  }
  return undefined;
}

function buildConsoleJsonStream(output: Pick<Console, "log" | "error">): DestinationStream {
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
