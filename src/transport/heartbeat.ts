import { CONNECTOR_VERSION } from "../version.js";
import type { ConnectorHeartbeatMessage, HeartbeatPayload } from "./protocol.js";

export interface BuildHeartbeatInput {
  online: boolean;
  mappingVersion?: string;
  lastSuccessfulSendAt?: string;
  lastErrorCode?: string;
  reconnectAttemptCount: number;
  connectorVersion?: string;
  sentAt?: string;
  state: "bootstrap" | "synced";
  bootstrap?: HeartbeatPayload["bootstrap"];
}

export function buildHeartbeatPayload(input: BuildHeartbeatInput): HeartbeatPayload {
  const payload: HeartbeatPayload = {
    connectorVersion: input.connectorVersion ?? CONNECTOR_VERSION,
    online: input.online,
    mappingVersion: input.mappingVersion,
    lastSuccessfulSendAt: input.lastSuccessfulSendAt,
    lastErrorCode: input.lastErrorCode,
    reconnectAttemptCount: input.reconnectAttemptCount,
    state: input.state
  };
  if (input.bootstrap) payload.bootstrap = input.bootstrap;
  return payload;
}

export function buildHeartbeatMessage(input: BuildHeartbeatInput): ConnectorHeartbeatMessage {
  return {
    type: "connector.heartbeat",
    sentAt: input.sentAt ?? new Date().toISOString(),
    payload: buildHeartbeatPayload(input)
  };
}
