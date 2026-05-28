import { describe, expect, it } from "vitest";
import { buildHeartbeatPayload } from "../../src/transport/heartbeat.js";

describe("buildHeartbeatPayload", () => {
  it("includes connector status metadata required by the central panel", () => {
    expect(
      buildHeartbeatPayload({
        connectorVersion: "0.1.0-test",
        online: true,
        mappingVersion: "mapping-v1",
        lastSuccessfulSendAt: "2026-05-16T20:00:00.000Z",
        lastErrorCode: "LAST_ERROR",
        reconnectAttemptCount: 3,
        state: "synced"
      })
    ).toEqual({
      connectorVersion: "0.1.0-test",
      online: true,
      mappingVersion: "mapping-v1",
      lastSuccessfulSendAt: "2026-05-16T20:00:00.000Z",
      lastErrorCode: "LAST_ERROR",
      reconnectAttemptCount: 3,
      state: "synced"
    });
  });
});
