import { describe, expect, it } from "vitest";
import { redactString, redactValue } from "../../src/logging/redact.js";

describe("redaction", () => {
  it("replaces connector token and database password in nested log metadata", () => {
    const redacted = redactValue(
      {
        connectorToken: "test-connector-token",
        database: {
          password: "test-db-password",
          dsn: "mysql://readonly:test-db-password@localhost/pharmacy"
        },
        message: "token=test-connector-token password=test-db-password",
        rows: [{ value: "test-connector-token" }]
      },
      ["test-connector-token", "test-db-password"]
    );

    expect(JSON.stringify(redacted)).not.toContain("test-connector-token");
    expect(JSON.stringify(redacted)).not.toContain("test-db-password");
    expect(redacted).toEqual({
      connectorToken: "[REDACTED]",
      database: {
        password: "[REDACTED]",
        dsn: "mysql://readonly:[REDACTED]@localhost/pharmacy"
      },
      message: "token=[REDACTED] password=[REDACTED]",
      rows: [{ value: "[REDACTED]" }]
    });
  });

  it("redacts repeated secret appearances in strings", () => {
    expect(redactString("test-db-password:test-db-password", ["test-db-password"])).toBe(
      "[REDACTED]:[REDACTED]"
    );
  });
});
