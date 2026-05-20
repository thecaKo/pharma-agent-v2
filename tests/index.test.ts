import { describe, expect, it } from "vitest";
import { classifyDatabasePath, CONNECTOR_VERSION, createLogger, loadConfig, redactValue } from "../src/index.js";
import { validEnv } from "./helpers/env.js";

describe("public connector exports", () => {
  it("exports reusable foundation modules", () => {
    expect(CONNECTOR_VERSION).toBe("0.1.0");
    expect(loadConfig(validEnv()).database.driver).toBe("mysql");
    expect(redactValue({ token: "secret" }, ["secret"])).toEqual({ token: "[REDACTED]" });
    expect(createLogger({ level: "info" })).toHaveProperty("info");
    expect(classifyDatabasePath({ path: "/data/PHARMACY.FDB", kind: "file" })).toMatchObject({
      type: "firebird",
      confidence: "high"
    });
  });
});
