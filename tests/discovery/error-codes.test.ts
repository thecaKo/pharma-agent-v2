import { describe, expect, it } from "vitest";
import { categorizeError, DriverMissingError } from "../../src/discovery/error-codes.js";

describe("categorizeError", () => {
  it("classifies driver missing", () => {
    expect(categorizeError(new DriverMissingError("mssql"))).toBe("driver_missing");
  });

  it("classifies timeout via ETIMEDOUT message", () => {
    expect(categorizeError(new Error("connect ETIMEDOUT 1433"))).toBe("timeout");
  });

  it("classifies timeout via timeout keyword", () => {
    expect(categorizeError(new Error("Query timeout after 5000ms"))).toBe("timeout");
  });

  it("classifies unreachable via ECONNREFUSED", () => {
    expect(categorizeError(new Error("connect ECONNREFUSED 127.0.0.1:5432"))).toBe("unreachable");
  });

  it("classifies unreachable via host unreachable", () => {
    expect(categorizeError(new Error("Host unreachable"))).toBe("unreachable");
  });

  it("classifies auth via login failed message", () => {
    expect(categorizeError(new Error("Login failed for user 'sa'"))).toBe("auth");
  });

  it("classifies auth via SQLSTATE 28000", () => {
    expect(categorizeError(new Error("[28000] authentication failed"))).toBe("auth");
  });

  it("classifies auth via password keyword", () => {
    expect(categorizeError(new Error("invalid password"))).toBe("auth");
  });

  it("classifies tls via certificate keyword", () => {
    expect(categorizeError(new Error("self-signed certificate in chain"))).toBe("tls");
  });

  it("classifies tls via SSL keyword", () => {
    expect(categorizeError(new Error("SSL handshake failed"))).toBe("tls");
  });

  it("classifies tls via TLS keyword", () => {
    expect(categorizeError(new Error("TLS protocol error"))).toBe("tls");
  });

  it("falls back to unknown when no category matches", () => {
    expect(categorizeError(new Error("Out of memory"))).toBe("unknown");
  });

  it("handles non-Error inputs without throwing", () => {
    expect(categorizeError("plain string")).toBe("unknown");
    expect(categorizeError(undefined)).toBe("unknown");
    expect(categorizeError(null)).toBe("unknown");
    expect(categorizeError(42)).toBe("unknown");
  });
});
