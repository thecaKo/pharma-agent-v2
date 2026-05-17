import { describe, expect, it } from "vitest";
import {
  buildConnectorErrorMessage,
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
