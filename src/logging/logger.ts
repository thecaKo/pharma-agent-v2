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
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export function createLogger(options: LoggerOptions): Logger {
  const output = options.output ?? console;

  function write(level: LogLevel, event: string, metadata: Record<string, unknown> = {}): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[options.level]) {
      return;
    }

    const entry = redactValue(
      {
        timestamp: new Date().toISOString(),
        level,
        event,
        ...metadata
      },
      options.secrets ?? []
    );
    const serialized = JSON.stringify(entry);

    if (level === "error") {
      output.error(serialized);
      return;
    }

    output.log(serialized);
  }

  return {
    debug: (event, metadata) => write("debug", event, metadata),
    info: (event, metadata) => write("info", event, metadata),
    warn: (event, metadata) => write("warn", event, metadata),
    error: (event, metadata) => write("error", event, metadata)
  };
}
