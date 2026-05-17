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
}

export function buildHeartbeatPayload(input: BuildHeartbeatInput): HeartbeatPayload {
  return {
    connectorVersion: input.connectorVersion ?? CONNECTOR_VERSION,
    online: input.online,
    mappingVersion: input.mappingVersion,
    lastSuccessfulSendAt: input.lastSuccessfulSendAt,
    lastErrorCode: input.lastErrorCode,
    reconnectAttemptCount: input.reconnectAttemptCount
  };
}

export function buildHeartbeatMessage(input: BuildHeartbeatInput): ConnectorHeartbeatMessage {
  return {
    type: "connector.heartbeat",
    sentAt: input.sentAt ?? new Date().toISOString(),
    payload: buildHeartbeatPayload(input)
  };
}
