import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { ConnectorRuntime } from "../../src/service/runtime.js";
import type { SourceDatabaseAdapter } from "../../src/db/source-adapter.js";
import type { ProvisionReadonlyUserResultMessage } from "../../src/transport/protocol.js";
import * as provisionPassword from "../../src/db/provision-password.js";

class FakeTransport extends EventEmitter {
  public results: ProvisionReadonlyUserResultMessage[] = [];
  public connect = vi.fn(async () => undefined);
  public close = vi.fn(async () => undefined);
  public isConnected = vi.fn(() => true);
  public sendBatch = vi.fn();
  public sendHeartbeat = vi.fn();
  public sendConnectorError = vi.fn();
  public sendAdminResponse = vi.fn();
  public sendSchemaTablesListResult = vi.fn();
  public sendFileDiscoveryScanResult = vi.fn();
  public sendConnectorSetupConfigResult = vi.fn();
  public sendConnectorDiscovery = vi.fn();
  public sendAiSessionMessage = vi.fn();
  public getReconnectAttemptCount = vi.fn(() => 0);
  public sendProvisionReadonlyUserResult = vi.fn((m: ProvisionReadonlyUserResultMessage) => {
    this.results.push(m);
  });
}

function buildAdmin(provisionOutcome: "provisioned" | "fallback_no_privilege"): SourceDatabaseAdapter {
  return {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    queryChanges: vi.fn(async () => []),
    querySnapshotPage: vi.fn(async () => []),
    listTables: vi.fn(async () => []),
    listColumns: vi.fn(async () => []),
    describeTable: vi.fn(async () => []),
    listForeignKeys: vi.fn(async () => []),
    sampleRows: vi.fn(async () => []),
    runReadOnlySelect: vi.fn(async () => [{ ok: 1 }]),
    provisionReadonlyUser: vi.fn(async () => ({ outcome: provisionOutcome, grantedScope: "all_tables" as const }))
  } as never;
}

const env = {
  CONNECTOR_TOKEN: "tok",
  CONNECTOR_WS_URL: "ws://localhost:9999",
  DB_DRIVER: "mysql",
  DB_HOST: "127.0.0.1",
  DB_PORT: "3306",
  DB_NAME: "pharmacy",
  DB_USER: "admin",
  DB_PASSWORD: "admin-secret",
  PROGRAMDATA: "/tmp/does-not-matter"
} as never;

describe("ConnectorRuntime provision readonly", () => {
  it("provisiona, valida RO, troca a conexão ativa e responde provisioned", async () => {
    const transport = new FakeTransport();
    const adminAdapter = buildAdmin("provisioned");
    const roAdapter = buildAdmin("provisioned");
    const writeProvision = vi.fn(async () => undefined);

    const runtime = new ConnectorRuntime({
      env,
      transport: transport as never,
      adapter: adminAdapter,
      now: () => "2026-06-03T00:00:00.000Z",
      createReadonlyAdapter: () => roAdapter,
      writeReadonlyProvisioningConfig: writeProvision
    } as never);
    await runtime.start();

    transport.emit("provisionReadonlyUser", {
      type: "connector.provisionReadonlyUser",
      requestId: "req-1",
      sessionId: "sess-1",
      username: "pharma_connector_ro"
    });
    await vi.waitFor(() => expect(transport.results.length).toBe(1));

    const result = transport.results[0]!;
    expect(result.outcome).toBe("provisioned");
    expect(result.username).toBe("pharma_connector_ro");
    expect(result.grantedScope).toBe("all_tables");
    expect(adminAdapter.provisionReadonlyUser).toHaveBeenCalledTimes(1);
    expect(roAdapter.runReadOnlySelect).toHaveBeenCalled(); // valida RO
    expect(writeProvision).toHaveBeenCalledTimes(1);
    const persisted = (writeProvision.mock.calls[0]![1]) as { readonlyProvisioning: { status: string; username?: string } };
    expect(persisted.readonlyProvisioning.status).toBe("provisioned");
    expect(persisted.readonlyProvisioning.username).toBe("pharma_connector_ro");
  });

  it("fallback_no_privilege mantém a conexão na descoberta e persiste fallback_discovered", async () => {
    const transport = new FakeTransport();
    const adminAdapter = buildAdmin("fallback_no_privilege");
    const writeProvision = vi.fn(async () => undefined);
    const runtime = new ConnectorRuntime({
      env,
      transport: transport as never,
      adapter: adminAdapter,
      now: () => "2026-06-03T00:00:00.000Z",
      createReadonlyAdapter: () => buildAdmin("provisioned"),
      writeReadonlyProvisioningConfig: writeProvision
    } as never);
    await runtime.start();

    transport.emit("provisionReadonlyUser", {
      type: "connector.provisionReadonlyUser", requestId: "req-2", sessionId: "sess-1", username: "pharma_connector_ro"
    });
    await vi.waitFor(() => expect(transport.results.length).toBe(1));
    expect(transport.results[0]!.outcome).toBe("fallback_no_privilege");
    const persisted = (writeProvision.mock.calls[0]![1]) as { readonlyProvisioning: { status: string } };
    expect(persisted.readonlyProvisioning.status).toBe("fallback_discovered");
    // A conexão admin (descoberta) não é trocada nem fechada no caminho de fallback.
    expect(adminAdapter.close).not.toHaveBeenCalled();
  });

  it("validação RO falha após GRANT: responde erro, não troca a conexão e fecha o roAdapter", async () => {
    const transport = new FakeTransport();
    const adminAdapter = buildAdmin("provisioned");
    const roAdapter = buildAdmin("provisioned");
    // O provisionamento dá certo (provisioned), mas a validação RO (select 1) falha.
    (roAdapter.runReadOnlySelect as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("login do usuário read-only recusado")
    );
    const writeProvision = vi.fn(async () => undefined);

    const runtime = new ConnectorRuntime({
      env,
      transport: transport as never,
      adapter: adminAdapter,
      now: () => "2026-06-03T00:00:00.000Z",
      createReadonlyAdapter: () => roAdapter,
      writeReadonlyProvisioningConfig: writeProvision
    } as never);
    await runtime.start();

    transport.emit("provisionReadonlyUser", {
      type: "connector.provisionReadonlyUser", requestId: "req-ro-val", sessionId: "sess-1", username: "pharma_connector_ro"
    });
    await vi.waitFor(() => expect(transport.results.length).toBe(1));

    // Responde erro (fallback para a credencial descoberta), não comuta para o RO.
    expect(transport.results[0]!.outcome).toBe("error");
    expect(adminAdapter.provisionReadonlyUser).toHaveBeenCalledTimes(1);
    // O roAdapter foi aberto para validar e, ao falhar, é fechado.
    expect(roAdapter.connect).toHaveBeenCalledTimes(1);
    expect(roAdapter.close).toHaveBeenCalledTimes(1);
    // A conexão admin permanece ativa: não é fechada.
    expect(adminAdapter.close).not.toHaveBeenCalled();
    // Persiste fallback_discovered (não provisioned).
    const persisted = (writeProvision.mock.calls[0]![1]) as { readonlyProvisioning: { status: string } };
    expect(persisted.readonlyProvisioning.status).toBe("fallback_discovered");
  });

  it("erro durante a provisão responde error e não troca a conexão", async () => {
    const transport = new FakeTransport();
    const adminAdapter = buildAdmin("provisioned");
    (adminAdapter.provisionReadonlyUser as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error("connection lost"), { code: "ECONNRESET" })
    );
    const runtime = new ConnectorRuntime({
      env,
      transport: transport as never,
      adapter: adminAdapter,
      now: () => "2026-06-03T00:00:00.000Z",
      createReadonlyAdapter: () => buildAdmin("provisioned"),
      writeReadonlyProvisioningConfig: vi.fn(async () => undefined)
    } as never);
    await runtime.start();

    transport.emit("provisionReadonlyUser", {
      type: "connector.provisionReadonlyUser", requestId: "req-3", sessionId: "sess-1", username: "pharma_connector_ro"
    });
    await vi.waitFor(() => expect(transport.results.length).toBe(1));
    expect(transport.results[0]!.outcome).toBe("error");
    expect(transport.results[0]!.errorCode).toBeDefined();
  });

  it("nunca expõe a senha gerada no result nem nos logs", async () => {
    const KNOWN = "KNOWN-RO-PASSWORD-1234567890ABCD";
    vi.spyOn(provisionPassword, "generateReadonlyPassword").mockReturnValue(KNOWN);

    const transport = new FakeTransport();
    const logger = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      child: vi.fn(() => logger)
    };
    const runtime = new ConnectorRuntime({
      env,
      transport: transport as never,
      adapter: buildAdmin("provisioned"),
      logger: logger as never,
      now: () => "2026-06-03T00:00:00.000Z",
      createReadonlyAdapter: () => buildAdmin("provisioned"),
      writeReadonlyProvisioningConfig: vi.fn(async () => undefined)
    } as never);
    await runtime.start();

    transport.emit("provisionReadonlyUser", {
      type: "connector.provisionReadonlyUser", requestId: "req-9", sessionId: "sess-1", username: "pharma_connector_ro"
    });
    await vi.waitFor(() => expect(transport.results.length).toBe(1));

    const serializedResult = JSON.stringify(transport.results[0]);
    expect(serializedResult).not.toContain(KNOWN);

    const allLogs = JSON.stringify([
      ...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls
    ]);
    expect(allLogs).not.toContain(KNOWN);
  });
});
