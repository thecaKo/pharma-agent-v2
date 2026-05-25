import type { Logger } from "../logging/logger.js";
import { applyMapping } from "../mapping/apply.js";
import type { MappingConfig, SourceRow, ValidatedSnapshotMappingConfig } from "../mapping/types.js";
import { validateMappingConfig } from "../mapping/validate.js";
import type { SourceDatabaseAdapter } from "../db/source-adapter.js";
import type { ConnectorState, PendingSnapshotProduct, SnapshotProductState } from "../state/state-types.js";
import { buildProductBatch, type ProductChangeBatch } from "./batch-builder.js";
import { diffSnapshotProducts } from "./snapshot-diff.js";
import { snapshotFieldsSignature } from "./snapshot-hash.js";

export interface SnapshotPollerOptions {
  adapter: SourceDatabaseAdapter;
  mapping: MappingConfig | ValidatedSnapshotMappingConfig;
  state: { load(): Promise<ConnectorState> };
  connectorId: string;
  customerId: string;
  isTransportReady: () => boolean;
  hasUnacknowledgedBatch?: () => boolean;
  logger?: Pick<Logger, "info" | "warn" | "error">;
  now?: () => string;
}

export type SnapshotPollCycleStatus = "batch" | "empty" | "invalid_mapping" | "transport_unavailable" | "awaiting_ack";

export interface SnapshotPollCycleResult {
  status: SnapshotPollCycleStatus;
  batch?: ProductChangeBatch;
  snapshotPending?: PendingSnapshotProduct[];
  fieldsSignature?: string;
  rowCount?: number;
  rejectedRowCount?: number;
  error?: Error;
}

export class SnapshotPoller {
  private readonly adapter: SourceDatabaseAdapter;
  private readonly mapping: MappingConfig | ValidatedSnapshotMappingConfig;
  private readonly state: { load(): Promise<ConnectorState> };
  private readonly connectorId: string;
  private readonly customerId: string;
  private readonly isTransportReady: () => boolean;
  private readonly hasUnacknowledgedBatch: () => boolean;
  private readonly logger?: Pick<Logger, "info" | "warn" | "error">;
  private readonly now: () => string;

  public constructor(options: SnapshotPollerOptions) {
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
    return this.validateSnapshotMapping().pollIntervalMs;
  }

  public async pollOnce(): Promise<SnapshotPollCycleResult> {
    let mapping: ValidatedSnapshotMappingConfig;
    try {
      mapping = this.validateSnapshotMapping();
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error("Invalid snapshot mapping configuration");
      return { status: "invalid_mapping", error: normalized };
    }

    if (!this.isTransportReady()) {
      return { status: "transport_unavailable" };
    }

    if (this.hasUnacknowledgedBatch()) {
      return { status: "awaiting_ack" };
    }

    const state = await this.state.load();
    const fieldsSignature = snapshotFieldsSignature(mapping);
    const snapshotState = state.snapshotState?.fieldsSignature === fieldsSignature
      ? state.snapshotState
      : { fieldsSignature, products: {}, pending: [] };

    const pending = snapshotState.pending.length > 0
      ? snapshotState.pending
      : await this.scanAndDiff(mapping, snapshotState.products);

    if (pending.length === 0) {
      return { status: "empty", fieldsSignature, rowCount: 0, rejectedRowCount: 0 };
    }

    const selected = pending.slice(0, mapping.batchSize);
    const batch = buildProductBatch({
      connectorId: this.connectorId,
      customerId: this.customerId,
      mappingVersion: mapping.mappingVersion,
      cursorBefore: null,
      cursorAfter: null,
      records: selected.map((entry) => entry.record),
      createdAt: this.now()
    });

    return {
      status: "batch",
      batch,
      snapshotPending: pending,
      fieldsSignature
    };
  }

  private async scanAndDiff(
    mapping: ValidatedSnapshotMappingConfig,
    products: Record<string, SnapshotProductState>
  ): Promise<PendingSnapshotProduct[]> {
    const rows: SourceRow[] = [];
    for (let offset = 0; ; offset += mapping.snapshotPageSize) {
      const page = await this.adapter.querySnapshotPage({
        sql: mapping.snapshotQuery,
        limit: mapping.snapshotPageSize,
        offset
      });
      rows.push(...page);
      if (page.length < mapping.snapshotPageSize) {
        break;
      }
    }

    const mapped = applyMapping(rows, mapping, {
      logger: this.logger,
      logContext: {
        connectorId: this.connectorId,
        customerId: this.customerId,
        mappingVersion: mapping.mappingVersion
      }
    });

    return diffSnapshotProducts({
      products: mapped.records,
      confirmed: products ?? {},
      now: this.now()
    }).changed;
  }

  private validateSnapshotMapping(): ValidatedSnapshotMappingConfig {
    const mapping = validateMappingConfig(this.mapping);
    if (mapping.syncMode !== "snapshot") {
      throw new Error("SnapshotPoller requires syncMode snapshot");
    }
    return mapping;
  }
}
