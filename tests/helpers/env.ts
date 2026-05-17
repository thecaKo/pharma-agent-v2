import type { Environment } from "../../src/config/env.js";

export function validEnv(overrides: Environment = {}): Environment {
  return {
    CONNECTOR_TOKEN: "test-connector-token",
    CONNECTOR_WS_URL: "wss://central-platform/connectors/ws",
    DB_DRIVER: "mysql",
    DB_HOST: "localhost",
    DB_PORT: "3306",
    DB_NAME: "pharmacy",
    DB_USER: "readonly",
    DB_PASSWORD: "test-db-password",
    ...overrides
  };
}
