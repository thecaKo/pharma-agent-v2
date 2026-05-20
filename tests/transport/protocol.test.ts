import { describe, expect, it } from "vitest";
import {
  buildAdminErrorResponseMessage,
  buildAdminRequestMessage,
  buildAdminSuccessResponseMessage,
  buildConnectorErrorMessage,
  parseAdminResponseMessage,
  parseServerMessage,
  ProtocolParseError
} from "../../src/transport/protocol.js";
import { validMapping } from "../helpers/mapping.js";

describe("transport protocol", () => {
  it("accepts a valid connector.config message", () => {
    expect(
      parseServerMessage(
        JSON.stringify({
          type: "connector.config",
          connectorId: "connector-1",
          customerId: "customer-1",
          mapping: validMapping()
        })
      )
    ).toMatchObject({
      type: "connector.config",
      connectorId: "connector-1",
      customerId: "customer-1",
      mapping: {
        mappingVersion: "mapping-v1"
      }
    });
  });

  it("accepts connector.config selectedProductTable metadata", () => {
    expect(
      parseServerMessage(
        JSON.stringify({
          type: "connector.config",
          connectorId: "connector-1",
          customerId: "customer-1",
          mapping: validMapping({ selectedProductTable: "products" })
        })
      )
    ).toMatchObject({
      type: "connector.config",
      mapping: {
        mappingVersion: "mapping-v1",
        selectedProductTable: "products"
      }
    });
  });

  it("rejects a malformed connector.config message", () => {
    expect(() =>
      parseServerMessage(
        JSON.stringify({
          type: "connector.config",
          connectorId: "connector-1",
          customerId: "customer-1",
          mapping: {
            ...validMapping(),
            fields: {}
          }
        })
      )
    ).toThrow(ProtocolParseError);
  });

  it("accepts a valid batch.ack message", () => {
    expect(
      parseServerMessage(
        JSON.stringify({
          type: "batch.ack",
          batchId: "batch-1",
          accepted: true,
          acceptedRecordCount: 2,
          rejectedRecordCount: 0,
          nextAction: "continue"
        })
      )
    ).toMatchObject({
      type: "batch.ack",
      batchId: "batch-1",
      nextAction: "continue"
    });
  });

  it("rejects a batch.ack without batchId", () => {
    expect(() =>
      parseServerMessage(
        JSON.stringify({
          type: "batch.ack",
          accepted: true,
          acceptedRecordCount: 2,
          rejectedRecordCount: 0,
          nextAction: "continue"
        })
      )
    ).toThrow(ProtocolParseError);
  });

  it("accepts a valid schema.listTables admin request", () => {
    expect(
      parseServerMessage(
        JSON.stringify({
          type: "admin.request",
          requestId: "req-1",
          command: "schema.listTables",
          sentAt: "2026-05-16T20:00:00.000Z"
        })
      )
    ).toEqual({
      type: "admin.request",
      requestId: "req-1",
      command: "schema.listTables",
      sentAt: "2026-05-16T20:00:00.000Z"
    });
  });

  it("builds schema.listTables admin requests", () => {
    expect(
      buildAdminRequestMessage(
        {
          requestId: "req-1",
          command: "schema.listTables"
        },
        "2026-05-16T20:00:00.000Z"
      )
    ).toEqual({
      type: "admin.request",
      requestId: "req-1",
      command: "schema.listTables",
      sentAt: "2026-05-16T20:00:00.000Z"
    });
  });

  it("rejects an admin request with an empty requestId", () => {
    expect(() =>
      parseServerMessage(
        JSON.stringify({
          type: "admin.request",
          requestId: "",
          command: "schema.listTables"
        })
      )
    ).toThrow(ProtocolParseError);
  });

  it("rejects an admin request with a malformed requestId", () => {
    expect(() =>
      parseServerMessage(
        JSON.stringify({
          type: "admin.request",
          requestId: "request id with spaces",
          command: "schema.listTables"
        })
      )
    ).toThrow(ProtocolParseError);
  });

  it("rejects unsupported admin commands", () => {
    expect(() =>
      parseServerMessage(
        JSON.stringify({
          type: "admin.request",
          requestId: "req-1",
          command: "schema.describeTable"
        })
      )
    ).toThrow(ProtocolParseError);
  });

  it("builds successful admin responses with table names only", () => {
    const message = buildAdminSuccessResponseMessage(
      {
        requestId: "req-1",
        command: "schema.listTables",
        tables: ["products", "inventory"]
      },
      "2026-05-16T20:00:01.000Z"
    );

    expect(message).toEqual({
      type: "admin.response",
      requestId: "req-1",
      command: "schema.listTables",
      ok: true,
      payload: {
        tables: ["inventory", "products"]
      },
      sentAt: "2026-05-16T20:00:01.000Z"
    });
    expect(JSON.stringify(message)).not.toContain("columns");
    expect(JSON.stringify(message)).not.toContain("rowCount");
  });

  it("parses successful admin responses with table names only", () => {
    expect(
      parseAdminResponseMessage(
        JSON.stringify({
          type: "admin.response",
          requestId: "req-1",
          command: "schema.listTables",
          ok: true,
          payload: {
            tables: ["inventory", "products"]
          },
          sentAt: "2026-05-16T20:00:01.000Z"
        })
      )
    ).toEqual({
      type: "admin.response",
      requestId: "req-1",
      command: "schema.listTables",
      ok: true,
      payload: {
        tables: ["inventory", "products"]
      },
      sentAt: "2026-05-16T20:00:01.000Z"
    });
  });

  it("parses admin error responses", () => {
    expect(
      parseAdminResponseMessage(
        JSON.stringify({
          type: "admin.response",
          requestId: "req-1",
          command: "schema.listTables",
          ok: false,
          error: {
            errorCode: "TABLE_DISCOVERY_FAILED",
            message: "Discovery failed"
          },
          sentAt: "2026-05-16T20:00:01.000Z"
        })
      )
    ).toEqual({
      type: "admin.response",
      requestId: "req-1",
      command: "schema.listTables",
      ok: false,
      error: {
        errorCode: "TABLE_DISCOVERY_FAILED",
        message: "Discovery failed"
      },
      sentAt: "2026-05-16T20:00:01.000Z"
    });
  });

  it("builds admin error responses with redacted messages and no secret fields", () => {
    const message = buildAdminErrorResponseMessage(
      {
        requestId: "req-1",
        command: "schema.listTables",
        errorCode: "TABLE_DISCOVERY_FAILED",
        message: "Database password secret-password rejected for token secret-token",
        secrets: ["secret-password", "secret-token"],
        databasePassword: "secret-password",
        connectorToken: "secret-token"
      } as never,
      "2026-05-16T20:00:01.000Z"
    );
    const serialized = JSON.stringify(message);

    expect(message).toEqual({
      type: "admin.response",
      requestId: "req-1",
      command: "schema.listTables",
      ok: false,
      error: {
        errorCode: "TABLE_DISCOVERY_FAILED",
        message: "Database password [REDACTED] rejected for token [REDACTED]"
      },
      sentAt: "2026-05-16T20:00:01.000Z"
    });
    expect(serialized).not.toContain("secret-password");
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("databasePassword");
    expect(serialized).not.toContain("connectorToken");
  });

  it("builds connector errors without token or database password fields", () => {
    const message = buildConnectorErrorMessage({
      errorCode: "DB_TIMEOUT",
      message: "Database timeout",
      connectorId: "connector-1",
      customerId: "customer-1",
      mappingVersion: "mapping-v1",
      batchId: "batch-1",
      connectorToken: "secret-token",
      databasePassword: "secret-password"
    } as never);

    const serialized = JSON.stringify(message);

    expect(message).toMatchObject({
      type: "connector.error",
      error: {
        errorCode: "DB_TIMEOUT",
        message: "Database timeout"
      }
    });
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("secret-password");
    expect(serialized).not.toContain("connectorToken");
    expect(serialized).not.toContain("databasePassword");
  });
});
