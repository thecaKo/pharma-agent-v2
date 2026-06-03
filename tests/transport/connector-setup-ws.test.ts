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

  it("parses valid firebird file-discovery setup payload with credentials", () => {
    const command = parseConnectorSetupConfigCommand(
      JSON.stringify({
        id: "setup-2",
        type: CONNECTOR_SETUP_CONFIG_COMMAND_TYPE,
        setupMethod: "file_discovery",
        driver: "firebird",
        path: "C:\\data\\store.fdb",
        host: "fb.local",
        port: 3050,
        username: "SYSDBA",
        password: "masterkey",
        selectedFileCandidateId: "candidate-1"
      })
    );

    expect(command).toMatchObject({
      setupMethod: "file_discovery",
      driver: "firebird",
      path: "C:\\data\\store.fdb",
      host: "fb.local",
      port: 3050,
      username: "SYSDBA",
      password: "masterkey",
      selectedFileCandidateId: "candidate-1"
    });

    expect(setupConfigToDatabaseConfig(command)).toEqual({
      driver: "firebird",
      host: "fb.local",
      port: 3050,
      name: "C:\\data\\store.fdb",
      user: "SYSDBA",
      password: "masterkey"
    });
  });

  it("parses valid mysql file-discovery setup payload with credentials", () => {
    const command = parseConnectorSetupConfigCommand(
      JSON.stringify({
        id: "setup-2b",
        type: CONNECTOR_SETUP_CONFIG_COMMAND_TYPE,
        setupMethod: "file_discovery",
        driver: "mysql",
        path: "C:\\mysql\\data\\pharma\\products.ibd",
        host: "db.local",
        port: 3307,
        username: "app",
        password: "secret"
      })
    );

    expect(setupConfigToDatabaseConfig(command)).toEqual({
      driver: "mysql",
      host: "db.local",
      port: 3307,
      name: "pharma",
      user: "app",
      password: "secret"
    });
  });

  it("parses valid mariadb manual setup payload", () => {
    const command = parseConnectorSetupConfigCommand(
      JSON.stringify({
        id: "setup-maria",
        type: CONNECTOR_SETUP_CONFIG_COMMAND_TYPE,
        setupMethod: "manual",
        driver: "mariadb",
        host: "192.168.20.103",
        port: 3306,
        database: "cliente_mock",
        username: "agente",
        password: "agente123"
      })
    );

    expect(command).toMatchObject({
      correlationId: "setup-maria",
      setupMethod: "manual",
      driver: "mariadb"
    });

    expect(setupConfigToDatabaseConfig(command)).toEqual({
      driver: "mariadb",
      host: "192.168.20.103",
      port: 3306,
      name: "cliente_mock",
      user: "agente",
      password: "agente123"
    });
  });

  it("rejects payload with unsupported driver", () => {
    expect(() =>
      parseConnectorSetupConfigCommand(
        JSON.stringify({
          id: "setup-bad",
          type: CONNECTOR_SETUP_CONFIG_COMMAND_TYPE,
          setupMethod: "manual",
          driver: "oracle",
          host: "db.local",
          port: 1521,
          database: "pharma_db",
          username: "app",
          password: "secret"
        })
      )
    ).toThrow('driver must be "mysql", "firebird", "postgresql", "mariadb", or "sqlserver"');
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

  it("maps mysql file path to derived database name using provided host and port", () => {
    const config = fileDiscoveryPathToDatabaseConfig({
      driver: "mysql",
      path: "C:\\mysql\\data\\pharma\\products.ibd",
      host: "db.local",
      port: 3306,
      username: "app",
      password: "secret"
    });

    expect(config).toEqual({
      driver: "mysql",
      host: "db.local",
      port: 3306,
      name: "pharma",
      user: "app",
      password: "secret"
    });
  });
});
