import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/logging/logger.js";

describe("createLogger", () => {
  it("writes structured JSON and redacts configured secrets", () => {
    const output = {
      log: vi.fn(),
      error: vi.fn()
    };
    const logger = createLogger({
      level: "debug",
      secrets: ["test-connector-token", "test-db-password"],
      output,
      nodeEnv: "dev"
    });

    logger.info("configuration.loaded", {
      connectorToken: "test-connector-token",
      password: "test-db-password",
      nested: {
        detail: "test-connector-token"
      }
    });

    expect(output.log).toHaveBeenCalledOnce();
    const line = output.log.mock.calls[0]?.[0] as string;
    expect(line).toContain('"event":"configuration.loaded"');
    expect(line).not.toContain("test-connector-token");
    expect(line).not.toContain("test-db-password");
    expect(JSON.parse(line)).toMatchObject({
      level: "info",
      event: "configuration.loaded",
      connectorToken: "[REDACTED]",
      password: "[REDACTED]",
      nested: {
        detail: "[REDACTED]"
      }
    });
  });

  it("does not write entries below the configured level", () => {
    const output = {
      log: vi.fn(),
      error: vi.fn()
    };
    const logger = createLogger({ level: "warn", output, nodeEnv: "dev" });

    logger.info("configuration.loaded");

    expect(output.log).not.toHaveBeenCalled();
    expect(output.error).not.toHaveBeenCalled();
  });

  it("fora de dev emite info/warn/error mas suprime debug", () => {
    const output = {
      log: vi.fn(),
      error: vi.fn()
    };
    const logger = createLogger({ level: "debug", output, nodeEnv: "production" });

    logger.debug("debug.suppressed");
    logger.info("configuration.loaded");
    logger.warn("config.warning");
    logger.error("runtime.error");

    // debug não deve sair fora de dev, mesmo com level "debug" configurado.
    const allLines = [...output.log.mock.calls, ...output.error.mock.calls].map(
      (call) => call[0] as string
    );
    expect(allLines.some((line) => line.includes("debug.suppressed"))).toBe(false);

    // info/warn vão para output.log; error vai para output.error.
    expect(output.log.mock.calls.some((call) => String(call[0]).includes("configuration.loaded"))).toBe(true);
    expect(output.log.mock.calls.some((call) => String(call[0]).includes("config.warning"))).toBe(true);
    expect(output.error.mock.calls.some((call) => String(call[0]).includes("runtime.error"))).toBe(true);
  });

  it("dentro de dev emite debug quando level é debug", () => {
    const output = {
      log: vi.fn(),
      error: vi.fn()
    };
    const logger = createLogger({ level: "debug", output, nodeEnv: "dev" });

    logger.debug("debug.visible");

    expect(output.log).toHaveBeenCalledOnce();
    const line = output.log.mock.calls[0]?.[0] as string;
    expect(line).toContain("debug.visible");
    expect(JSON.parse(line)).toMatchObject({ level: "debug", event: "debug.visible" });
  });

  it("emits JSON when logFormat is 'json' explicitly", () => {
    const output = {
      log: vi.fn(),
      error: vi.fn()
    };
    const logger = createLogger({
      level: "info",
      output,
      nodeEnv: "dev",
      logFormat: "json"
    });

    logger.info("poll.started", { connectorId: "abc" });

    expect(output.log).toHaveBeenCalledOnce();
    const line = output.log.mock.calls[0]?.[0] as string;
    expect(() => JSON.parse(line)).not.toThrow();
    expect(JSON.parse(line)).toMatchObject({
      level: "info",
      event: "poll.started",
      connectorId: "abc"
    });
  });
});
