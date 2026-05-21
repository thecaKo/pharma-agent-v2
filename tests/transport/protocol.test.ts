import { describe, expect, it } from "vitest";
import {
  buildAdminErrorResponseMessage,
  buildAdminRequestMessage,
  buildAdminSuccessResponseMessage,
  buildConfigValidationConnectorError,
  buildConnectorErrorMessage,
  buildProductBatchMessage,
  buildUnsupportedServerCommandRejection,
  CONFIG_VALIDATION_FAILED_ERROR_CODE,
  extractSafeConfigPushIdentity,
  UNSUPPORTED_SERVER_COMMAND_ERROR_CODE,
  parseAdminResponseMessage,
  parseServerMessage,
  ProtocolParseError
} from "../../src/transport/protocol.js";
import { buildProductBatch } from "../../src/poller/batch-builder.js";
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

  describe("connector.config validation", () => {
    function parseConfigMessage(mappingOverrides: Record<string, unknown> = {}, topLevel: Record<string, unknown> = {}) {
      return () =>
        parseServerMessage(
          JSON.stringify({
            type: "connector.config",
            connectorId: "connector-1",
            customerId: "customer-1",
            mapping: validMapping(mappingOverrides),
            ...topLevel
          })
        );
    }

    it("rejects empty mapping.incrementalQuery with a field-specific message", () => {
      expect(parseConfigMessage({ incrementalQuery: "" })).toThrow(
        new ProtocolParseError("mapping.incrementalQuery must be a non-empty string")
      );
    });

    it("rejects missing mapping.fields.sourceProductCode with a field-specific message", () => {
      const mapping = validMapping();
      delete (mapping.fields as Record<string, unknown>).sourceProductCode;

      expect(() =>
        parseServerMessage(
          JSON.stringify({
            type: "connector.config",
            connectorId: "connector-1",
            customerId: "customer-1",
            mapping
          })
        )
      ).toThrow(new ProtocolParseError("mapping.fields.sourceProductCode must be a non-empty string"));
    });

    it("rejects invalid mapping.cursorType with valid options in the message", () => {
      expect(parseConfigMessage({ cursorType: "uuid" })).toThrow(
        new ProtocolParseError('mapping.cursorType must be "timestamp" or "number", got "uuid"')
      );
    });

    it("rejects non-positive mapping.pollIntervalMs with a field-specific message", () => {
      expect(parseConfigMessage({ pollIntervalMs: 0 })).toThrow(
        new ProtocolParseError("mapping.pollIntervalMs must be a positive integer")
      );
      expect(parseConfigMessage({ pollIntervalMs: -1 })).toThrow(
        new ProtocolParseError("mapping.pollIntervalMs must be a positive integer")
      );
    });

    it("rejects non-positive mapping.batchSize with a field-specific message", () => {
      expect(parseConfigMessage({ batchSize: 0 })).toThrow(
        new ProtocolParseError("mapping.batchSize must be a positive integer")
      );
      expect(parseConfigMessage({ batchSize: -5 })).toThrow(
        new ProtocolParseError("mapping.batchSize must be a positive integer")
      );
    });

    it("accepts optional selectedProductTable, product fields, and sentAt when required fields are valid", () => {
      const parsed = parseServerMessage(
        JSON.stringify({
          type: "connector.config",
          connectorId: "connector-1",
          customerId: "customer-1",
          sentAt: "2026-05-20T12:00:00.000Z",
          mapping: validMapping({
            selectedProductTable: "products",
            fields: {
              sourceProductCode: "product_id",
              name: "description",
              price: "sale_price",
              stock: "quantity",
              barcode: "ean",
              active: "is_active",
              sourceUpdatedAt: "updated_at"
            }
          })
        })
      );

      expect(parsed).toMatchObject({
        type: "connector.config",
        sentAt: "2026-05-20T12:00:00.000Z",
        mapping: {
          selectedProductTable: "products",
          fields: {
            barcode: "ean",
            active: "is_active",
            sourceUpdatedAt: "updated_at"
          }
        }
      });
    });

    it("accepts connector.config without price and stock field mappings", () => {
      const mapping = validMapping();
      delete (mapping.fields as Record<string, unknown>).price;
      delete (mapping.fields as Record<string, unknown>).stock;

      const parsed = parseServerMessage(
        JSON.stringify({
          type: "connector.config",
          connectorId: "connector-1",
          customerId: "customer-1",
          mapping
        })
      );

      expect(parsed).toMatchObject({
        type: "connector.config",
        mapping: {
          fields: {
            sourceProductCode: "product_id",
            name: "description"
          }
        }
      });
    });

    it("does not include raw config payloads or secret-like values in parse errors", () => {
      const secretToken = "super-secret-connector-token";
      const secretPassword = "super-secret-db-password";
      const rawPayload = JSON.stringify({
        type: "connector.config",
        connectorId: "connector-1",
        customerId: "customer-1",
        connectorToken: secretToken,
        databasePassword: secretPassword,
        mapping: {
          ...validMapping(),
          incrementalQuery: "",
          fields: {
            sourceProductCode: "product_id",
            name: "description",
            price: "sale_price",
            stock: "quantity"
          }
        }
      });

      let errorMessage = "";
      try {
        parseServerMessage(rawPayload);
      } catch (error) {
        errorMessage = (error as Error).message;
      }

      expect(errorMessage).toContain("mapping.incrementalQuery");
      expect(errorMessage).not.toContain(secretToken);
      expect(errorMessage).not.toContain(secretPassword);
      expect(errorMessage).not.toContain(rawPayload);
      expect(errorMessage).not.toContain("connectorToken");
      expect(errorMessage).not.toContain("databasePassword");
    });
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

  it("builds product.batch messages in the neo-api wire format", () => {
    const message = buildProductBatchMessage(
      buildProductBatch({
        batchId: "batch-1",
        connectorId: "connector-1",
        customerId: "customer-1",
        mappingVersion: "mapping-v1",
        cursorBefore: 0,
        cursorAfter: 123,
        createdAt: "2026-05-16T20:00:00.000Z",
        records: [
          {
            sourceProductCode: "P-001",
            name: "Dipirona 500mg",
            price: 12.5,
            stock: 7,
            barcode: "7891234567890",
            active: true,
            sourceUpdatedAt: "2026-05-16T20:00:01.000Z"
          },
          {
            sourceProductCode: "P-002",
            name: "Sem preco/estoque",
            price: null,
            stock: null
          }
        ]
      }),
      "2026-05-16T20:00:01.000Z"
    );

    expect(message).toEqual({
      type: "product.batch",
      sentAt: "2026-05-16T20:00:01.000Z",
      batchId: "batch-1",
      mappingVersion: "mapping-v1",
      cursor: {
        before: 0,
        after: 123
      },
      products: [
        {
          code: "P-001",
          name: "Dipirona 500mg",
          salePrice: 12.5,
          stockQuantity: 7,
          barcode: "7891234567890",
          active: true,
          sourceUpdatedAt: "2026-05-16T20:00:01.000Z"
        },
        {
          code: "P-002",
          name: "Sem preco/estoque",
          salePrice: null,
          stockQuantity: null
        }
      ]
    });
    expect(JSON.stringify(message)).not.toContain("\"batch\"");
    expect(JSON.stringify(message)).not.toContain("sourceProductCode");
    expect(JSON.stringify(message)).not.toContain("\"records\"");
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

  it("builds config validation connector errors with stable code and safe identity", () => {
    const message = buildConfigValidationConnectorError({
      parseError: new ProtocolParseError("mapping.incrementalQuery must be a non-empty string"),
      identity: {
        connectorId: "connector-1",
        customerId: "customer-1",
        mappingVersion: "mapping-v1"
      }
    });

    expect(message).toMatchObject({
      type: "connector.error",
      error: {
        errorCode: CONFIG_VALIDATION_FAILED_ERROR_CODE,
        message: "mapping.incrementalQuery must be a non-empty string",
        connectorId: "connector-1",
        customerId: "customer-1",
        mappingVersion: "mapping-v1"
      }
    });
  });

  it("extracts only safe connector.config identity fields", () => {
    expect(
      extractSafeConfigPushIdentity({
        connectorId: "connector-1",
        customerId: "customer-1",
        connectorToken: "secret-token",
        mapping: {
          mappingVersion: "mapping-v1",
          incrementalQuery: "select 1"
        }
      })
    ).toEqual({
      connectorId: "connector-1",
      customerId: "customer-1",
      mappingVersion: "mapping-v1"
    });
    expect(extractSafeConfigPushIdentity({ connectorId: "", mapping: "invalid" })).toEqual({});
  });

  it("builds unsupported server command rejections as correlated connector.error payloads", () => {
    const message = buildUnsupportedServerCommandRejection({
      messageType: "catalog.future.command",
      correlationId: "x-1"
    });

    expect(message).toEqual({
      id: "x-1",
      type: "connector.error",
      sentAt: message.sentAt,
      error: {
        errorCode: UNSUPPORTED_SERVER_COMMAND_ERROR_CODE,
        message: "Unsupported server message type: catalog.future.command"
      }
    });
    expect(JSON.stringify(message)).toContain('"id":"x-1"');
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
