import type { MappingConfig } from "../mapping/types.js";

export type CursorValue = string | number | null;

export interface ConnectorState {
  connectorId?: string;
  customerId?: string;
  mapping?: MappingConfig;
  mappingVersion?: string;
  selectedProductTable?: string;
  cursorField?: string;
  cursorType?: CursorValue extends number ? never : "timestamp" | "number";
  sourceProductCodeField?: string;
  lastAckedCursor?: CursorValue;
  lastSuccessfulSendAt?: string;
  lastBatchId?: string;
}

export const STATE_FILE_NAME = "connector-state.json";
