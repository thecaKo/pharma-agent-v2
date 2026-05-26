import { describe, expect, it, vi } from "vitest";
import { DatabaseOperationError } from "../../src/db/errors.js";
import {
  PostgresSourceAdapter,
  type PostgresDriverConnection
} from "../../src/db/postgresql-adapter.js";
import type { DatabaseConfig } from "../../src/config/types.js";

const config: DatabaseConfig = {
  driver: "postgresql",
  host: "127.0.0.1",
  port: 5432,
  name: "vetorfarma",
  user: "readonly",
  password: "super-secret-password"
};

describe("PostgresSourceAdapter", () => {
  it("connects via the injected connection factory with readonly intent", async () => {
    const connection: PostgresDriverConnection = {
      query: vi.fn(async () => ({ rows: [] })),
      end: vi.fn(async () => undefined)
    };
    const connectionFactory = vi.fn(async () => connection);
    const adapter = new PostgresSourceAdapter({ config, connectionFactory });

    await adapter.connect();

    expect(connectionFactory).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 5432,
      database: "vetorfarma",
      user: "readonly",
      password: "super-secret-password",
      readonly: true
    });
  });

  it("normalizes connection failures without leaking password or database name", async () => {
    const adapter = new PostgresSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => {
        throw Object.assign(new Error("password authentication failed for super-secret-password on vetorfarma"), {
          code: "28P01"
        });
      })
    });

    await expect(adapter.connect()).rejects.toMatchObject({
      name: "DatabaseOperationError",
      driver: "postgresql",
      operation: "connect",
      errorCode: "POSTGRESQL_28P01"
    });

    try {
      await adapter.connect();
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseOperationError);
      expect(String(error)).not.toContain("super-secret-password");
      expect(String(error)).not.toContain("vetorfarma");
      expect(String(error)).toContain("[REDACTED]");
    }
  });

  it("closes connected sessions exactly once", async () => {
    const connection: PostgresDriverConnection = {
      query: vi.fn(async () => ({ rows: [] })),
      end: vi.fn(async () => undefined)
    };
    const adapter = new PostgresSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => connection)
    });

    await adapter.connect();
    await adapter.close();
    await adapter.close();

    expect(connection.end).toHaveBeenCalledOnce();
  });

  it("normalizes close failures", async () => {
    const adapter = new PostgresSourceAdapter({
      config,
      connectionFactory: vi.fn(async () => ({
        query: vi.fn(async () => ({ rows: [] })),
        end: vi.fn(async () => {
          throw Object.assign(new Error("connection close timeout"), { code: "ETIMEDOUT" });
        })
      }))
    });

    await adapter.connect();

    await expect(adapter.close()).rejects.toMatchObject({
      driver: "postgresql",
      operation: "close",
      errorCode: "POSTGRESQL_ETIMEDOUT",
      retryable: true
    });
  });
});
