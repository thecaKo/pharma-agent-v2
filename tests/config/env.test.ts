import { describe, expect, it } from "vitest";
import { ConfigValidationError, configSecrets, loadConfig } from "../../src/config/env.js";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_WS_PING_INTERVAL_MS,
  DEFAULT_WS_PONG_TIMEOUT_MS
} from "../../src/config/types.js";
import { validEnv } from "../helpers/env.js";

const baseEnv = {
  CONNECTOR_TOKEN: "pac_test",
  CONNECTOR_WS_URL: "wss://example/connectors/ws",
  DB_DRIVER: "mysql",
  DB_HOST: "localhost",
  DB_PORT: "3306",
  DB_NAME: "pharma",
  DB_USER: "user",
  DB_PASSWORD: "secret"
};

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
      logLevel: "info",
      heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
      wsPingIntervalMs: DEFAULT_WS_PING_INTERVAL_MS,
      wsPongTimeoutMs: DEFAULT_WS_PONG_TIMEOUT_MS
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

  it("accepts postgresql as a valid DB_DRIVER", () => {
    const config = loadConfig(validEnv({ DB_DRIVER: "postgresql", DB_PORT: "5432" }));

    expect(config.database.driver).toBe("postgresql");
    expect(config.database.port).toBe(5432);
  });

  it("accepts mariadb as a valid DB_DRIVER", () => {
    const config = loadConfig(validEnv({ DB_DRIVER: "mariadb", DB_PORT: "3306" }));

    expect(config.database.driver).toBe("mariadb");
    expect(config.database.port).toBe(3306);
  });

  it("rejects unsupported database drivers with a descriptive non-secret error", () => {
    try {
      loadConfig(validEnv({ DB_DRIVER: "oracle" }));
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(String(error)).toContain("DB_DRIVER must be mysql, firebird, postgresql, or mariadb");
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

describe("loadConfig — heartbeat/ping envs", () => {
  it("returns defaults when envs absent", () => {
    const config = loadConfig({ ...baseEnv });
    expect(config.heartbeatIntervalMs).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS);
    expect(config.wsPingIntervalMs).toBe(DEFAULT_WS_PING_INTERVAL_MS);
    expect(config.wsPongTimeoutMs).toBe(DEFAULT_WS_PONG_TIMEOUT_MS);
  });

  it("parses overrides from env", () => {
    const config = loadConfig({
      ...baseEnv,
      HEARTBEAT_INTERVAL_MS: "15000",
      WS_PING_INTERVAL_MS: "20000",
      WS_PONG_TIMEOUT_MS: "5000"
    });
    expect(config.heartbeatIntervalMs).toBe(15000);
    expect(config.wsPingIntervalMs).toBe(20000);
    expect(config.wsPongTimeoutMs).toBe(5000);
  });

  it("rejects non-positive integers", () => {
    expect(() =>
      loadConfig({ ...baseEnv, HEARTBEAT_INTERVAL_MS: "0" })
    ).toThrow(/HEARTBEAT_INTERVAL_MS/);
    expect(() =>
      loadConfig({ ...baseEnv, WS_PING_INTERVAL_MS: "-1" })
    ).toThrow(/WS_PING_INTERVAL_MS/);
    expect(() =>
      loadConfig({ ...baseEnv, WS_PONG_TIMEOUT_MS: "abc" })
    ).toThrow(/WS_PONG_TIMEOUT_MS/);
  });
});
