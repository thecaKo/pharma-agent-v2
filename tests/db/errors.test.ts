import { describe, expect, it } from "vitest";
import { DatabaseOperationError, normalizeDatabaseError } from "../../src/db/errors.js";

describe("normalizeDatabaseError", () => {
  it("returns existing normalized errors unchanged", () => {
    const error = new DatabaseOperationError({
      driver: "mysql",
      operation: "query",
      errorCode: "MYSQL_CUSTOM",
      message: "already normalized",
      retryable: false
    });

    expect(normalizeDatabaseError({ driver: "mysql", operation: "query", error })).toBe(error);
  });

  it("normalizes primitive errors without secret context", () => {
    const error = normalizeDatabaseError({
      driver: "firebird",
      operation: "connect",
      error: "failed",
      secrets: ["secret"]
    });

    expect(error).toMatchObject({
      driver: "firebird",
      operation: "connect",
      errorCode: "FIREBIRD_DATABASE_ERROR",
      retryable: false
    });
    expect(error.message).toContain("Database operation failed");
    expect(error.message).not.toContain("secret");
  });
});
