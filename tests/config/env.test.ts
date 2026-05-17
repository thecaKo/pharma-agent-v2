import { describe, expect, it } from "vitest";
import { ConfigValidationError, configSecrets, loadConfig } from "../../src/config/env.js";
import { validEnv } from "../helpers/env.js";

describe("loadConfig", () => {
  it("returns typed connector configuration for mysql", () => {
    const config = loadConfig(validEnv({ DB_DRIVER: "mysql" }));

    expect(config).toEqual({
      connectorToken: "test-connector-token",
      websocketUrl: "wss://central-platform/connectors/ws",
      database: {
        driver: "mysql",
        host: "localhost",
        port: 3306,
        name: "pharmacy",
        user: "readonly",
        password: "test-db-password"
      },
      logLevel: "info"
    });
  });

  it("returns typed connector configuration for firebird", () => {
    const config = loadConfig(
      validEnv({
        DB_DRIVER: "firebird",
        DB_PORT: "3050"
      })
    );

    expect(config.database.driver).toBe("firebird");
    expect(config.database.port).toBe(3050);
  });

  it("rejects missing CONNECTOR_TOKEN without exposing secret values", () => {
    expect(() => loadConfig(validEnv({ CONNECTOR_TOKEN: "" }))).toThrow(ConfigValidationError);

    try {
      loadConfig(validEnv({ CONNECTOR_TOKEN: "" }));
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(String(error)).toContain("CONNECTOR_TOKEN is required");
      expect(String(error)).not.toContain("test-db-password");
    }
  });

  it("rejects missing DB_PASSWORD without exposing secret values", () => {
    try {
      loadConfig(validEnv({ DB_PASSWORD: "" }));
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(String(error)).toContain("DB_PASSWORD is required");
      expect(String(error)).not.toContain("test-connector-token");
    }
  });

  it("rejects unsupported database drivers with a descriptive non-secret error", () => {
    try {
      loadConfig(validEnv({ DB_DRIVER: "postgres" }));
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(String(error)).toContain("DB_DRIVER must be mysql or firebird");
      expect(String(error)).not.toContain("test-connector-token");
      expect(String(error)).not.toContain("test-db-password");
    }
  });

  it("rejects invalid database ports and log levels", () => {
    try {
      loadConfig(validEnv({ DB_PORT: "not-a-port", LOG_LEVEL: "trace" }));
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(String(error)).toContain("DB_PORT must be a valid TCP port");
      expect(String(error)).toContain("LOG_LEVEL must be debug, info, warn, or error");
    }
  });

  it("defaults omitted LOG_LEVEL to info", () => {
    const config = loadConfig(validEnv({ LOG_LEVEL: undefined }));

    expect(config.logLevel).toBe("info");
  });

  it("extracts connector secrets from validated config", () => {
    const config = loadConfig(validEnv());

    expect(configSecrets(config)).toEqual(["test-connector-token", "test-db-password"]);
  });
});
