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
      output
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
    const logger = createLogger({ level: "warn", output });

    logger.info("configuration.loaded");

    expect(output.log).not.toHaveBeenCalled();
    expect(output.error).not.toHaveBeenCalled();
  });
});
