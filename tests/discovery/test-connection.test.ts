import { describe, expect, it, vi } from "vitest";
import { probeTestConnection, type TestConnectionInput } from "../../src/discovery/test-connection.js";
import type { SourceDatabaseAdapter } from "../../src/db/source-adapter.js";

const baseInput: TestConnectionInput = {
  driver: "sqlserver",
  host: "10.0.0.1",
  port: 1433,
  database: "db",
  user: "u",
  password: "p"
};

function makeAdapter(overrides: Partial<SourceDatabaseAdapter> = {}): SourceDatabaseAdapter {
  return {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    queryChanges: vi.fn(async () => []),
    querySnapshotPage: vi.fn(async () => []),
    listTables: vi.fn(async () => []),
    listColumns: vi.fn(async () => []),
    ...overrides
  };
}

describe("probeTestConnection", () => {
  it("returns ok with latency on successful probe", async () => {
    const adapter = makeAdapter();
    const result = await probeTestConnection(baseInput, {
      createAdapter: () => adapter,
      timeoutMs: 1000
    });
    expect(result).toMatchObject({ ok: true });
    expect(result).toHaveProperty("latencyMs");
    expect(adapter.connect).toHaveBeenCalled();
    expect(adapter.listTables).toHaveBeenCalled();
    expect(adapter.close).toHaveBeenCalled();
  });

  it("categorizes auth failure", async () => {
    const adapter = makeAdapter({
      connect: vi.fn(async () => {
        throw new Error("Login failed for user 'sa'");
      })
    });
    const result = await probeTestConnection(baseInput, {
      createAdapter: () => adapter,
      timeoutMs: 1000
    });
    expect(result).toMatchObject({ ok: false, code: "auth" });
  });

  it("categorizes unreachable failure", async () => {
    const adapter = makeAdapter({
      connect: vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.1:1433");
      })
    });
    const result = await probeTestConnection(baseInput, {
      createAdapter: () => adapter,
      timeoutMs: 1000
    });
    expect(result).toMatchObject({ ok: false, code: "unreachable" });
  });

  it("categorizes driver_missing", async () => {
    const { DriverMissingError } = await import("../../src/discovery/error-codes.js");
    const adapter = makeAdapter({
      connect: vi.fn(async () => {
        throw new DriverMissingError("mssql");
      })
    });
    const result = await probeTestConnection(baseInput, {
      createAdapter: () => adapter,
      timeoutMs: 1000
    });
    expect(result).toMatchObject({ ok: false, code: "driver_missing" });
  });

  it("times out long-running connect attempts", async () => {
    const adapter = makeAdapter({
      connect: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, 1000);
          })
      )
    });
    const result = await probeTestConnection(baseInput, {
      createAdapter: () => adapter,
      timeoutMs: 50
    });
    expect(result).toMatchObject({ ok: false, code: "timeout" });
  });

  it("always closes the adapter even on listTables failure", async () => {
    const close = vi.fn(async () => undefined);
    const adapter = makeAdapter({
      listTables: vi.fn(async () => {
        throw new Error("permission denied");
      }),
      close
    });
    const result = await probeTestConnection(baseInput, {
      createAdapter: () => adapter,
      timeoutMs: 1000
    });
    expect(result.ok).toBe(false);
    expect(close).toHaveBeenCalled();
  });

  it("redacts password from any error message returned", async () => {
    const adapter = makeAdapter({
      connect: vi.fn(async () => {
        throw new Error("invalid password 'p' for 'u'");
      })
    });
    const result = await probeTestConnection(baseInput, {
      createAdapter: () => adapter,
      timeoutMs: 1000
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain("'p'");
    }
  });
});
