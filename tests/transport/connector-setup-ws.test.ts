import { describe, expect, it } from "vitest";
import {
  CONNECTOR_SETUP_CONFIG_COMMAND_TYPE,
  CONNECTOR_SETUP_CONFIG_RESULT_TYPE,
  buildSetupConfigFailureResult,
  buildSetupConfigSuccessResult,
  fileDiscoveryPathToDatabaseConfig,
  parseConnectorSetupConfigCommand,
  setupConfigToDatabaseConfig
} from "../../src/transport/connector-setup-ws.js";

describe("connector-setup-ws", () => {
  it("parses valid manual setup payload", () => {
    const command = parseConnectorSetupConfigCommand(
      JSON.stringify({
        id: "setup-1",
        type: CONNECTOR_SETUP_CONFIG_COMMAND_TYPE,
        setupMethod: "manual",
        driver: "mysql",
        host: "db.local",
        port: 3306,
        database_name: "pharma_db",
        username: "app",
        password: "secret"
      })
    );

    expect(command).toMatchObject({
      correlationId: "setup-1",
      setupMethod: "manual",
      driver: "mysql",
      host: "db.local",
      port: 3306,
      database: "pharma_db",
      username: "app",
      password: "secret"
    });

    expect(setupConfigToDatabaseConfig(command)).toEqual({
      driver: "mysql",
      host: "db.local",
      port: 3306,
      name: "pharma_db",
      user: "app",
      password: "secret"
    });
  });

  it("parses valid file-discovery setup payload", () => {
    const command = parseConnectorSetupConfigCommand(
      JSON.stringify({
        id: "setup-2",
        type: CONNECTOR_SETUP_CONFIG_COMMAND_TYPE,
        setupMethod: "file_discovery",
        driver: "firebird",
        path: "C:\\data\\store.fdb",
        selectedFileCandidateId: "candidate-1"
      })
    );

    expect(command.setupMethod).toBe("file_discovery");
    expect(command.path).toBe("C:\\data\\store.fdb");

    const config = setupConfigToDatabaseConfig(command);
    expect(config.driver).toBe("firebird");
    expect(config.name).toBe("C:\\data\\store.fdb");
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(3050);
  });

  it("rejects malformed payload missing driver", () => {
    expect(() =>
      parseConnectorSetupConfigCommand(
        JSON.stringify({
          id: "setup-3",
          type: CONNECTOR_SETUP_CONFIG_COMMAND_TYPE,
          setupMethod: "manual",
          host: "db.local",
          port: 3306,
          database: "pharma_db",
          username: "app",
          password: "secret"
        })
      )
    ).toThrow("driver must be a non-empty string");
  });

  it("builds correlated success and failure results", () => {
    expect(
      buildSetupConfigSuccessResult("corr-1", {
        setupMethod: "manual",
        driver: "mysql"
      })
    ).toEqual({
      id: "corr-1",
      type: CONNECTOR_SETUP_CONFIG_RESULT_TYPE,
      ok: true,
      setupMethod: "manual",
      driver: "mysql"
    });

    expect(
      buildSetupConfigFailureResult("corr-2", {
        errorCode: "SETUP_CONNECTION_FAILED",
        message: "connection refused"
      })
    ).toMatchObject({
      id: "corr-2",
      type: CONNECTOR_SETUP_CONFIG_RESULT_TYPE,
      ok: false,
      errorCode: "SETUP_CONNECTION_FAILED",
      message: "connection refused"
    });
  });

  it("maps mysql file path to derived database name", () => {
    const config = fileDiscoveryPathToDatabaseConfig({
      driver: "mysql",
      path: "C:\\mysql\\data\\pharma\\products.ibd"
    });

    expect(config.name).toBe("pharma");
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(3306);
  });
});
