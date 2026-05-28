import { describe, expect, it, vi } from "vitest";
import { handleAdminRequest, type AdminRouterDependencies } from "../../src/discovery/admin-router.js";
import type { AdminRequestMessage } from "../../src/transport/protocol.js";

function makeDeps(overrides: Partial<AdminRouterDependencies> = {}): AdminRouterDependencies {
  return {
    probeEngines: vi.fn(async () => [{ kind: "sqlserver", confidence: "high", evidence: ["service:MSSQLSERVER"] }]),
    probeOdbcDsns: vi.fn(async () => []),
    probeNetwork: vi.fn(async () => ({ reachable: true, latencyMs: 5 })),
    probeTestConnection: vi.fn(async () => ({ ok: true, latencyMs: 12 })),
    probeProcesses: vi.fn(async () => [{ pid: 4128, name: "Big.exe", path: "C:\\Linx\\bin\\Big.exe" }]),
    probeConnections: vi.fn(async () => []),
    probeScanConfigDirs: vi.fn(async () => ({ files: [], truncated: false, rootsRejected: [], errors: [] })),
    schemaListTables: vi.fn(async () => ["products"]),
    ...overrides
  };
}

describe("handleAdminRequest", () => {
  it("dispatches probe.engines and returns success payload with probeVersion", async () => {
    const req: AdminRequestMessage = {
      type: "admin.request",
      requestId: "req-1",
      command: "probe.engines",
      input: {}
    };
    const res = await handleAdminRequest(req, makeDeps());
    expect(res).toMatchObject({
      type: "admin.response",
      requestId: "req-1",
      command: "probe.engines",
      ok: true,
      probeVersion: "1",
      payload: { engines: expect.any(Array) }
    });
  });

  it("dispatches probe.network with input", async () => {
    const probeNetwork = vi.fn(async () => ({ reachable: false, error: "timeout" as const }));
    const req: AdminRequestMessage = {
      type: "admin.request",
      requestId: "req-2",
      command: "probe.network",
      input: { host: "10.0.0.1", port: 1433, timeoutMs: 200 }
    };
    const res = await handleAdminRequest(req, makeDeps({ probeNetwork }));
    expect(probeNetwork).toHaveBeenCalledWith({ host: "10.0.0.1", port: 1433, timeoutMs: 200 });
    expect(res).toMatchObject({ ok: true, payload: { reachable: false, error: "timeout" } });
  });

  it("dispatches probe.test_connection with input", async () => {
    const probeTestConnection = vi.fn(async () => ({ ok: false, code: "auth" as const, message: "Login failed" }));
    const req: AdminRequestMessage = {
      type: "admin.request",
      requestId: "req-3",
      command: "probe.test_connection",
      input: { driver: "sqlserver", host: "h", port: 1433, database: "d", user: "u", password: "p" }
    };
    const res = await handleAdminRequest(req, makeDeps({ probeTestConnection }));
    expect(probeTestConnection).toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true, payload: { ok: false, code: "auth" } });
  });

  it("rejects probe.network with invalid input shape", async () => {
    const req: AdminRequestMessage = {
      type: "admin.request",
      requestId: "req-4",
      command: "probe.network",
      input: { host: "h" }
    };
    const res = await handleAdminRequest(req, makeDeps());
    expect(res).toMatchObject({
      ok: false,
      error: { errorCode: "INVALID_INPUT", message: expect.stringContaining("port") }
    });
  });

  it("rejects probe.test_connection without driver field", async () => {
    const req: AdminRequestMessage = {
      type: "admin.request",
      requestId: "req-5",
      command: "probe.test_connection",
      input: { host: "h" }
    };
    const res = await handleAdminRequest(req, makeDeps());
    expect(res).toMatchObject({ ok: false, error: { errorCode: "INVALID_INPUT" } });
  });

  it("returns INTERNAL_ERROR when probe throws unexpectedly", async () => {
    const probeEngines = vi.fn(async () => {
      throw new Error("registry corrupted");
    });
    const req: AdminRequestMessage = {
      type: "admin.request",
      requestId: "req-6",
      command: "probe.engines"
    };
    const res = await handleAdminRequest(req, makeDeps({ probeEngines }));
    expect(res).toMatchObject({ ok: false, error: { errorCode: "INTERNAL_ERROR" } });
  });

  it("still supports schema.listTables for backward compatibility", async () => {
    const req: AdminRequestMessage = {
      type: "admin.request",
      requestId: "req-7",
      command: "schema.listTables"
    };
    const res = await handleAdminRequest(req, makeDeps());
    expect(res).toMatchObject({ ok: true, payload: { tables: ["products"] } });
  });

  it("dispatches probe.processes", async () => {
    const res = await handleAdminRequest(
      { type: "admin.request", requestId: "r", command: "probe.processes" },
      makeDeps()
    );
    expect(res).toMatchObject({ ok: true, payload: { processes: expect.any(Array) } });
  });

  it("dispatches probe.connections", async () => {
    const res = await handleAdminRequest(
      { type: "admin.request", requestId: "r", command: "probe.connections" },
      makeDeps()
    );
    expect(res).toMatchObject({ ok: true, payload: { connections: expect.any(Array) } });
  });

  it("dispatches probe.scan_config_dirs with roots", async () => {
    const res = await handleAdminRequest(
      {
        type: "admin.request",
        requestId: "r",
        command: "probe.scan_config_dirs",
        input: { roots: ["C:\\App"] }
      },
      makeDeps()
    );
    expect(res).toMatchObject({
      ok: true,
      payload: { files: expect.any(Array), truncated: false, rootsRejected: [], errors: [] }
    });
  });

  it("rejects probe.scan_config_dirs with empty roots", async () => {
    const res = await handleAdminRequest(
      {
        type: "admin.request",
        requestId: "r",
        command: "probe.scan_config_dirs",
        input: { roots: [] }
      },
      makeDeps()
    );
    expect(res).toMatchObject({ ok: false, error: { errorCode: "INVALID_INPUT" } });
  });
});
