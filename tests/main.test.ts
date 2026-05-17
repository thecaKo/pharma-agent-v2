import { describe, expect, it, vi } from "vitest";
import { runMain, validateStartup } from "../src/main.js";
import { validEnv } from "./helpers/env.js";

describe("startup entrypoint", () => {
  it("validates startup and emits redacted startup logs", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      validateStartup(validEnv() as NodeJS.ProcessEnv);

      expect(error).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledTimes(2);
      const output = log.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toContain('"event":"service.startup"');
      expect(output).toContain('"event":"configuration.loaded"');
      expect(output).not.toContain("test-connector-token");
      expect(output).not.toContain("test-db-password");
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("returns zero for valid startup configuration", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      expect(runMain(validEnv() as NodeJS.ProcessEnv)).toBe(0);
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("returns non-zero for startup configuration errors", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      expect(runMain(validEnv({ DB_PASSWORD: "" }) as NodeJS.ProcessEnv)).toBe(1);
      expect(log).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledOnce();
      const output = error.mock.calls[0]?.[0] as string;
      expect(output).toContain('"event":"unrecoverable.configuration_error"');
      expect(output).toContain("DB_PASSWORD");
      expect(output).not.toContain("test-connector-token");
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
