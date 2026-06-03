import { describe, expect, it } from "vitest";
import {
  parseServerMessage,
  buildProvisionReadonlyUserResult,
  ProtocolParseError,
  type ProvisionReadonlyUserMessage
} from "../../src/transport/protocol.js";
import { isCoreServerMessageType } from "../../src/transport/server-message-router.js";

describe("connector.provisionReadonlyUser protocol", () => {
  it("faz parse do comando neo→agente (sem senha)", () => {
    const msg = parseServerMessage(JSON.stringify({
      type: "connector.provisionReadonlyUser",
      requestId: "req-1",
      sessionId: "sess-1",
      username: "pharma_connector_ro"
    })) as ProvisionReadonlyUserMessage;
    expect(msg.type).toBe("connector.provisionReadonlyUser");
    expect(msg.requestId).toBe("req-1");
    expect(msg.sessionId).toBe("sess-1");
    expect(msg.username).toBe("pharma_connector_ro");
    expect("password" in msg).toBe(false);
  });

  it("rejeita comando sem username", () => {
    expect(() => parseServerMessage(JSON.stringify({
      type: "connector.provisionReadonlyUser", requestId: "req-1", sessionId: "sess-1"
    }))).toThrow(ProtocolParseError);
  });

  it("constrói o result provisioned sem errorCode", () => {
    const result = buildProvisionReadonlyUserResult({
      requestId: "req-1", sessionId: "sess-1", outcome: "provisioned", username: "pharma_connector_ro"
    });
    expect(result).toMatchObject({
      type: "connector.provisionReadonlyUser.result",
      requestId: "req-1",
      sessionId: "sess-1",
      outcome: "provisioned",
      username: "pharma_connector_ro",
      grantedScope: "all_tables"
    });
    expect("errorCode" in result).toBe(false);
  });

  it("constrói o result error com errorCode", () => {
    const result = buildProvisionReadonlyUserResult({
      requestId: "req-1", sessionId: "sess-1", outcome: "error", username: "pharma_connector_ro", errorCode: "timeout"
    });
    expect(result.outcome).toBe("error");
    expect(result.errorCode).toBe("timeout");
  });
});

describe("connector.provisionReadonlyUser routing", () => {
  it("é classificado como core", () => {
    expect(isCoreServerMessageType("connector.provisionReadonlyUser")).toBe(true);
  });
});
