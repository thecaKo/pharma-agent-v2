import type { Logger } from "../logging/logger.js";
import { applyMapping } from "../mapping/apply.js";
import type { MappingConfig, SourceRow, ValidatedMappingConfig } from "../mapping/types.js";
import { validateMappingConfig } from "../mapping/validate.js";
import type { ConnectorState, CursorValue } from "../state/state-types.js";
import { buildProductBatch, type ProductChangeBatch } from "./batch-builder.js";
import { selectCursorAfter } from "./cursor.js";
import type { SourceDatabaseAdapter } from "../db/source-adapter.js";

export interface PollerStateReader {
  load(): Promise<ConnectorState>;
}

export interface IncrementalPollerOptions {
  adapter: SourceDatabaseAdapter;
  mapping: MappingConfig | ValidatedMappingConfig;
  state: PollerStateReader;
  connectorId: string;
  customerId: string;
  isTransportReady: () => boolean;
  hasUnacknowledgedBatch?: () => boolean;
  logger?: Pick<Logger, "info" | "warn" | "error">;
  now?: () => string;
}

export type PollCycleStatus =
  | "batch"
  | "empty"
  | "invalid_mapping"
  | "transport_unavailable"
  | "awaiting_ack";

export interface PollCycleResult {
  status: PollCycleStatus;
  batch?: ProductChangeBatch;
  cursorBefore?: CursorValue;
  cursorAfter?: CursorValue;
  rowCount?: number;
  rejectedRowCount?: number;
  error?: Error;
}

export class IncrementalPoller {
  private readonly adapter: SourceDatabaseAdapter;
  private readonly mapping: MappingConfig | ValidatedMappingConfig;
  private readonly state: PollerStateReader;
  private readonly connectorId: string;
  private readonly customerId: string;
  private readonly isTransportReady: () => boolean;
  private readonly hasUnacknowledgedBatch: () => boolean;
  private readonly logger?: Pick<Logger, "info" | "warn" | "error">;
  private readonly now: () => string;

  public constructor(options: IncrementalPollerOptions) {
    this.adapter = options.adapter;
    this.mapping = options.mapping;
    this.state = options.state;
    this.connectorId = options.connectorId;
    this.customerId = options.customerId;
    this.isTransportReady = options.isTransportReady;
    this.hasUnacknowledgedBatch = options.hasUnacknowledgedBatch ?? (() => false);
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public getPollIntervalMs(): number {
    return validateMappingConfig(this.mapping).pollIntervalMs;
  }

  public async pollOnce(): Promise<PollCycleResult> {
    let mapping: ValidatedMappingConfig;
    try {
      mapping = validateMappingConfig(this.mapping);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error("Invalid mapping configuration");
      this.logger?.warn("poll skipped invalid mapping", {
        event: "poll.skipped",
        errorCode: "INVALID_MAPPING",
        message: normalized.message
      });
      return { status: "invalid_mapping", error: normalized };
    }

    if (!this.isTransportReady()) {
      this.logger?.warn("poll skipped transport unavailable", {
        event: "poll.skipped",
        errorCode: "TRANSPORT_UNAVAILABLE",
        connectorId: this.connectorId,
        customerId: this.customerId,
        mappingVersion: mapping.mappingVersion
      });
      return { status: "transport_unavailable" };
    }

    if (this.hasUnacknowledgedBatch()) {
      this.logger?.warn("poll skipped awaiting ack", {
        event: "poll.skipped",
        errorCode: "BATCH_AWAITING_ACK",
        connectorId: this.connectorId,
        customerId: this.customerId,
        mappingVersion: mapping.mappingVersion
      });
      return { status: "awaiting_ack" };
    }

    const state = await this.state.load();
    const cursorBefore = state.lastAckedCursor ?? initialCursorValue(mapping.cursorType);

    this.logger?.info("poll started", {
      connectorId: this.connectorId,
      customerId: this.customerId,
      mappingVersion: mapping.mappingVersion,
      cursorBefore,
      dbLimit: mapping.batchSize
    });

    const rows = await this.adapter.queryChanges({
      sql: mapping.incrementalQuery,
      cursor: cursorBefore,
      limit: mapping.batchSize
    });

    if (rows.length === 0) {
      this.logger?.info("poll completed", {
        connectorId: this.connectorId,
        customerId: this.customerId,
        mappingVersion: mapping.mappingVersion,
        rowCount: 0,
        cursorBefore,
        cursorAfter: cursorBefore
      });
      return {
        status: "empty",
        cursorBefore,
        cursorAfter: cursorBefore,
        rowCount: 0,
        rejectedRowCount: 0
      };
    }

    return this.buildResult(rows, mapping, cursorBefore);
  }

  private buildResult(rows: SourceRow[], mapping: ValidatedMappingConfig, cursorBefore: CursorValue): PollCycleResult {
    const mapped = applyMapping(rows, mapping, {
      logger: this.logger,
      logContext: {
        connectorId: this.connectorId,
        customerId: this.customerId,
        mappingVersion: mapping.mappingVersion
      }
    });
    const cursorAfter = mapped.cursorAfter ?? selectCursorAfter(rows, mapping, cursorBefore);

    if (mapped.records.length === 0) {
      return {
        status: "empty",
        cursorBefore,
        cursorAfter,
        rowCount: rows.length,
        rejectedRowCount: mapped.rejected.length
      };
    }

    const batch = buildProductBatch({
      connectorId: this.connectorId,
      customerId: this.customerId,
      mappingVersion: mapping.mappingVersion,
      cursorBefore,
      cursorAfter,
      records: mapped.records,
      createdAt: this.now()
    });

    this.logger?.info("poll completed", {
      connectorId: this.connectorId,
      customerId: this.customerId,
      mappingVersion: mapping.mappingVersion,
      batchId: batch.batchId,
      rowCount: rows.length,
      rejectedRowCount: mapped.rejected.length,
      cursorBefore,
      cursorAfter
    });

    return {
      status: "batch",
      batch,
      cursorBefore,
      cursorAfter,
      rowCount: rows.length,
      rejectedRowCount: mapped.rejected.length
    };
  }
}

function initialCursorValue(cursorType: ValidatedMappingConfig["cursorType"]): CursorValue {
  return cursorType === "number" ? 0 : "1970-01-01T00:00:00.000Z";
}
