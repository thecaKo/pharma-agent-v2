# Snapshot Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reliable `snapshot` sync mode that detects new and changed products without relying on ERP `updated_at` fields.

**Architecture:** Keep the existing incremental flow intact and add a separate snapshot poller path. Snapshot mode scans all products in stable pages, maps rows into product records, hashes confirmed payload fields, compares against persisted local snapshot state, and updates that state only after accepted ACKs.

**Tech Stack:** TypeScript, Node.js 20, Vitest, existing connector runtime, existing source database adapters, JSON state store.

---

## File Structure

- Modify `src/mapping/types.ts`: add `syncMode`, `snapshotQuery`, `snapshotPageSize`, and snapshot-aware validated mapping types.
- Modify `src/mapping/validate.ts`: validate incremental and snapshot contracts separately.
- Modify `src/transport/protocol.ts`: parse snapshot mapping fields from `connector.config`.
- Modify `tests/helpers/mapping.ts`: keep default mapping incremental and add a snapshot helper.
- Modify `src/state/state-types.ts`: add durable snapshot index and pending snapshot change state.
- Modify `src/state/state-store.ts`: persist and normalize `snapshotState`.
- Modify `src/db/source-adapter.ts`: add `querySnapshotPage`.
- Modify `src/db/mysql-adapter.ts`: implement snapshot page query with `limit` and `offset`.
- Modify `src/db/firebird-adapter.ts`: implement snapshot page query with `start` and `end`.
- Create `src/poller/snapshot-hash.ts`: deterministic product and mapping signature hashing.
- Create `src/poller/snapshot-diff.ts`: compare mapped products with persisted snapshot state.
- Create `src/poller/snapshot-poller.ts`: scan pages, build batches, and expose ACK state updates.
- Modify `src/service/runtime.ts`: instantiate incremental or snapshot poller by mode and update snapshot state after ACK.
- Modify docs only if implementation changes operational setup details beyond the design spec.

## Task 1: Mapping Contract and Validation

**Files:**
- Modify: `src/mapping/types.ts`
- Modify: `src/mapping/validate.ts`
- Modify: `src/transport/protocol.ts`
- Modify: `tests/helpers/mapping.ts`
- Test: `tests/mapping/validate.test.ts`
- Test: `tests/transport/protocol.test.ts`

- [ ] **Step 1: Write failing validation tests**

Add tests to `tests/mapping/validate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MappingValidationError, validateMappingConfig } from "../../src/mapping/validate.js";
import { validMapping } from "../helpers/mapping.js";

describe("validateMappingConfig snapshot mode", () => {
  it("accepts snapshot mapping without cursor fields", () => {
    expect(
      validateMappingConfig({
        mappingVersion: "mapping-v1",
        syncMode: "snapshot",
        selectedProductTable: "products",
        pollIntervalMs: 10_000,
        batchSize: 500,
        snapshotQuery: "select * from products order by product_id limit ? offset ?",
        snapshotPageSize: 500,
        fields: {
          sourceProductCode: "product_id",
          name: "description",
          price: "sale_price",
          stock: "quantity"
        }
      })
    ).toMatchObject({
      syncMode: "snapshot",
      snapshotQuery: "select * from products order by product_id limit ? offset ?",
      snapshotPageSize: 500
    });
  });

  it("rejects snapshot mapping without snapshotQuery", () => {
    expect(() =>
      validateMappingConfig({
        ...validMapping({ syncMode: "snapshot" }),
        incrementalQuery: undefined,
        cursorField: undefined,
        cursorType: undefined,
        snapshotQuery: undefined,
        snapshotPageSize: 500
      })
    ).toThrow(MappingValidationError);
  });

  it("keeps incremental as the default sync mode", () => {
    expect(validateMappingConfig(validMapping()).syncMode).toBe("incremental");
  });
});
```

- [ ] **Step 2: Run validation tests and verify failure**

Run:

```bash
npm test -- tests/mapping/validate.test.ts
```

Expected: FAIL because `syncMode`, `snapshotQuery`, and `snapshotPageSize` are not part of the mapping types or validator yet.

- [ ] **Step 3: Update mapping types**

In `src/mapping/types.ts`, replace the config interfaces with snapshot-aware fields while preserving existing field names:

```ts
export type SyncMode = "incremental" | "snapshot";
export type CursorType = "timestamp" | "number";
export type SourceRow = Record<string, unknown>;

export interface ProductFieldMappings {
  sourceProductCode?: string;
  name?: string;
  barcode?: string;
  price?: string | null;
  stock?: string | null;
  active?: string;
  sourceUpdatedAt?: string;
}

export interface MappingConfig {
  mappingVersion?: string;
  selectedProductTable?: string;
  syncMode?: SyncMode;
  pollIntervalMs?: number;
  batchSize?: number;
  incrementalQuery?: string;
  cursorField?: string;
  cursorType?: string;
  snapshotQuery?: string;
  snapshotPageSize?: number;
  fields?: ProductFieldMappings;
}

interface ValidatedMappingBase {
  mappingVersion: string;
  selectedProductTable?: string;
  syncMode: SyncMode;
  pollIntervalMs: number;
  batchSize: number;
  fields: Required<Pick<ProductFieldMappings, "sourceProductCode" | "name">> &
    Pick<ProductFieldMappings, "price" | "stock" | "barcode" | "active" | "sourceUpdatedAt">;
}

export interface ValidatedIncrementalMappingConfig extends ValidatedMappingBase {
  syncMode: "incremental";
  incrementalQuery: string;
  cursorField: string;
  cursorType: CursorType;
}

export interface ValidatedSnapshotMappingConfig extends ValidatedMappingBase {
  syncMode: "snapshot";
  snapshotQuery: string;
  snapshotPageSize: number;
}

export type ValidatedMappingConfig = ValidatedIncrementalMappingConfig | ValidatedSnapshotMappingConfig;
```

- [ ] **Step 4: Update mapping validation**

In `src/mapping/validate.ts`, make validation branch by mode:

```ts
const SYNC_MODES = new Set(["incremental", "snapshot"]);
const CURSOR_TYPES = new Set(["timestamp", "number"]);

export function validateMappingConfig(mapping: MappingConfig): ValidatedMappingConfig {
  const issues: ConfigValidationIssue[] = [];
  const syncMode = normalizeSyncMode(mapping.syncMode, issues);

  requireString(mapping.mappingVersion, "mappingVersion", issues);
  requirePositiveInteger(mapping.pollIntervalMs, "pollIntervalMs", issues);
  requirePositiveInteger(mapping.batchSize, "batchSize", issues);

  for (const field of REQUIRED_FIELDS) {
    requireString(mapping.fields?.[field], `fields.${field}`, issues);
  }

  if (syncMode === "incremental") {
    requireString(mapping.incrementalQuery, "incrementalQuery", issues);
    requireString(mapping.cursorField, "cursorField", issues);
    if (!mapping.cursorType || !CURSOR_TYPES.has(mapping.cursorType)) {
      issues.push({ field: "cursorType", message: "must be timestamp or number" });
    }
  }

  if (syncMode === "snapshot") {
    requireString(mapping.snapshotQuery, "snapshotQuery", issues);
    requirePositiveInteger(mapping.snapshotPageSize, "snapshotPageSize", issues);
  }

  if (issues.length > 0) {
    throw new MappingValidationError(issues);
  }

  const selectedProductTable = normalizeOptionalMapping(mapping.selectedProductTable);
  const base = {
    mappingVersion: mapping.mappingVersion?.trim() as string,
    ...(selectedProductTable ? { selectedProductTable } : {}),
    syncMode,
    pollIntervalMs: mapping.pollIntervalMs as number,
    batchSize: mapping.batchSize as number,
    fields: {
      sourceProductCode: mapping.fields?.sourceProductCode?.trim() as string,
      name: mapping.fields?.name?.trim() as string,
      price: normalizeOptionalMapping(mapping.fields?.price),
      stock: normalizeOptionalMapping(mapping.fields?.stock),
      barcode: normalizeOptionalMapping(mapping.fields?.barcode),
      active: normalizeOptionalMapping(mapping.fields?.active),
      sourceUpdatedAt: normalizeOptionalMapping(mapping.fields?.sourceUpdatedAt)
    }
  };

  if (syncMode === "snapshot") {
    return {
      ...base,
      syncMode: "snapshot",
      snapshotQuery: mapping.snapshotQuery?.trim() as string,
      snapshotPageSize: mapping.snapshotPageSize as number
    };
  }

  return {
    ...base,
    syncMode: "incremental",
    incrementalQuery: mapping.incrementalQuery?.trim() as string,
    cursorField: mapping.cursorField?.trim() as string,
    cursorType: mapping.cursorType as "timestamp" | "number"
  };
}

function normalizeSyncMode(value: MappingConfig["syncMode"], issues: ConfigValidationIssue[]): SyncMode {
  if (value === undefined) {
    return "incremental";
  }
  if (!SYNC_MODES.has(value)) {
    issues.push({ field: "syncMode", message: "must be incremental or snapshot" });
    return "incremental";
  }
  return value;
}
```

- [ ] **Step 5: Update protocol parser**

In `src/transport/protocol.ts`, update `parseMapping` to pass through snapshot fields:

```ts
function parseMapping(value: unknown): ValidatedMappingConfig {
  const mapping = expectRecord(value, "mapping");
  const fields = expectRecord(mapping.fields, "mapping.fields");
  const syncMode = parseSyncMode(mapping.syncMode);

  const base = {
    mappingVersion: expectString(mapping.mappingVersion, "mapping.mappingVersion"),
    selectedProductTable: optionalString(mapping.selectedProductTable, "mapping.selectedProductTable"),
    syncMode,
    pollIntervalMs: expectPositiveInteger(mapping.pollIntervalMs, "mapping.pollIntervalMs"),
    batchSize: expectPositiveInteger(mapping.batchSize, "mapping.batchSize"),
    fields: {
      sourceProductCode: expectString(fields.sourceProductCode, "mapping.fields.sourceProductCode"),
      name: expectString(fields.name, "mapping.fields.name"),
      price: optionalNullableString(fields.price, "mapping.fields.price"),
      stock: optionalNullableString(fields.stock, "mapping.fields.stock"),
      barcode: optionalString(fields.barcode, "mapping.fields.barcode"),
      active: optionalString(fields.active, "mapping.fields.active"),
      sourceUpdatedAt: optionalString(fields.sourceUpdatedAt, "mapping.fields.sourceUpdatedAt")
    }
  };

  if (syncMode === "snapshot") {
    return {
      ...base,
      syncMode: "snapshot",
      snapshotQuery: expectString(mapping.snapshotQuery, "mapping.snapshotQuery"),
      snapshotPageSize: expectPositiveInteger(mapping.snapshotPageSize, "mapping.snapshotPageSize")
    };
  }

  return {
    ...base,
    syncMode: "incremental",
    incrementalQuery: expectString(mapping.incrementalQuery, "mapping.incrementalQuery"),
    cursorField: expectString(mapping.cursorField, "mapping.cursorField"),
    cursorType: parseCursorType(mapping.cursorType)
  };
}

function parseSyncMode(value: unknown): "incremental" | "snapshot" {
  if (value === undefined || value === null) {
    return "incremental";
  }
  const syncMode = expectString(value, "mapping.syncMode");
  if (syncMode !== "incremental" && syncMode !== "snapshot") {
    throw new ProtocolParseError(`mapping.syncMode must be "incremental" or "snapshot", got "${syncMode}"`);
  }
  return syncMode;
}
```

- [ ] **Step 6: Add snapshot helper**

In `tests/helpers/mapping.ts`, add:

```ts
export function validSnapshotMapping(overrides: Partial<MappingConfig> = {}): MappingConfig {
  return {
    mappingVersion: "mapping-v1",
    selectedProductTable: "products",
    syncMode: "snapshot",
    pollIntervalMs: 10_000,
    batchSize: 500,
    snapshotQuery: "select * from products order by product_id limit ? offset ?",
    snapshotPageSize: 500,
    fields: {
      sourceProductCode: "product_id",
      name: "description",
      barcode: "ean",
      price: "sale_price",
      stock: "quantity",
      active: "is_active"
    },
    ...overrides
  };
}
```

- [ ] **Step 7: Run focused tests**

Run:

```bash
npm test -- tests/mapping/validate.test.ts tests/transport/protocol.test.ts
```

Expected: PASS.

## Task 2: Durable Snapshot State

**Files:**
- Modify: `src/state/state-types.ts`
- Modify: `src/state/state-store.ts`
- Test: `tests/state/state-store.test.ts`

- [ ] **Step 1: Write failing state persistence test**

Add to `tests/state/state-store.test.ts`:

```ts
it("saves and reloads snapshot state", async () => {
  const path = await stateFilePath();
  const store = new StateStore({ stateFilePath: path });
  const state: ConnectorState = {
    connectorId: "connector-1",
    customerId: "customer-1",
    mappingVersion: "mapping-v1",
    snapshotState: {
      fieldsSignature: "sig-1",
      products: {
        "P-001": {
          hash: "hash-1",
          lastSeenAt: "2026-05-25T12:00:00.000Z",
          lastConfirmedAt: "2026-05-25T12:00:01.000Z"
        }
      },
      pending: [
        {
          sourceProductCode: "P-002",
          hash: "hash-2",
          record: {
            sourceProductCode: "P-002",
            name: "Produto 2",
            price: 12.5,
            stock: 3
          }
        }
      ]
    }
  };

  await store.save(state);

  await expect(new StateStore({ stateFilePath: path }).load()).resolves.toEqual(state);
});
```

- [ ] **Step 2: Run state test and verify failure**

Run:

```bash
npm test -- tests/state/state-store.test.ts
```

Expected: FAIL because `snapshotState` is not persisted.

- [ ] **Step 3: Add snapshot state types**

In `src/state/state-types.ts`, add imports and types:

```ts
import type { MappingConfig, ProductChangeRecord } from "../mapping/types.js";

export interface SnapshotProductState {
  hash: string;
  lastSeenAt: string;
  lastConfirmedAt: string;
}

export interface PendingSnapshotProduct {
  sourceProductCode: string;
  hash: string;
  record: ProductChangeRecord;
}

export interface SnapshotState {
  fieldsSignature: string;
  products: Record<string, SnapshotProductState>;
  pending: PendingSnapshotProduct[];
}

export interface ConnectorState {
  connectorId?: string;
  customerId?: string;
  mapping?: MappingConfig;
  mappingVersion?: string;
  selectedProductTable?: string;
  cursorField?: string;
  cursorType?: "timestamp" | "number";
  sourceProductCodeField?: string;
  lastAckedCursor?: CursorValue;
  lastSuccessfulSendAt?: string;
  lastBatchId?: string;
  snapshotState?: SnapshotState;
}
```

- [ ] **Step 4: Persist `snapshotState`**

In `src/state/state-store.ts`, add `"snapshotState"` to `STATE_KEYS`.

Add validation helpers:

```ts
function normalizeSnapshotState(value: unknown): ConnectorState["snapshotState"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const fieldsSignature = typeof value.fieldsSignature === "string" ? value.fieldsSignature.trim() : "";
  if (!fieldsSignature) {
    return undefined;
  }

  const products: ConnectorState["snapshotState"]["products"] = {};
  if (isRecord(value.products)) {
    for (const [code, entry] of Object.entries(value.products)) {
      if (!isRecord(entry)) {
        continue;
      }
      if (
        typeof entry.hash === "string" &&
        typeof entry.lastSeenAt === "string" &&
        typeof entry.lastConfirmedAt === "string"
      ) {
        products[code] = {
          hash: entry.hash,
          lastSeenAt: entry.lastSeenAt,
          lastConfirmedAt: entry.lastConfirmedAt
        };
      }
    }
  }

  const pending = Array.isArray(value.pending)
    ? value.pending.filter(isRecord).filter((entry) =>
        typeof entry.sourceProductCode === "string" &&
        typeof entry.hash === "string" &&
        isRecord(entry.record)
      ) as ConnectorState["snapshotState"]["pending"]
    : [];

  return { fieldsSignature, products, pending };
}
```

In `pickPersistedState`, normalize after cursor normalization:

```ts
persisted.snapshotState = normalizeSnapshotState(persisted.snapshotState);
```

- [ ] **Step 5: Run state tests**

Run:

```bash
npm test -- tests/state/state-store.test.ts
```

Expected: PASS.

## Task 3: Snapshot Hash and Diff Units

**Files:**
- Create: `src/poller/snapshot-hash.ts`
- Create: `src/poller/snapshot-diff.ts`
- Test: `tests/poller/snapshot-hash.test.ts`
- Test: `tests/poller/snapshot-diff.test.ts`

- [ ] **Step 1: Write hash tests**

Create `tests/poller/snapshot-hash.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { productSnapshotHash, snapshotFieldsSignature } from "../../src/poller/snapshot-hash.js";
import { validateMappingConfig } from "../../src/mapping/validate.js";
import { validSnapshotMapping } from "../helpers/mapping.js";

describe("productSnapshotHash", () => {
  it("is stable for equivalent product payloads", () => {
    const product = {
      sourceProductCode: "P-001",
      name: "Dipirona",
      barcode: null,
      price: 12.5,
      stock: 7
    };

    expect(productSnapshotHash(product)).toBe(productSnapshotHash({ ...product }));
  });

  it("changes when price changes", () => {
    const before = productSnapshotHash({
      sourceProductCode: "P-001",
      name: "Dipirona",
      price: 12.5,
      stock: 7
    });
    const after = productSnapshotHash({
      sourceProductCode: "P-001",
      name: "Dipirona",
      price: 13.9,
      stock: 7
    });

    expect(after).not.toBe(before);
  });
});

describe("snapshotFieldsSignature", () => {
  it("changes when a mapped field changes", () => {
    const first = snapshotFieldsSignature(validateMappingConfig(validSnapshotMapping()));
    const second = snapshotFieldsSignature(
      validateMappingConfig(validSnapshotMapping({ fields: { sourceProductCode: "product_id", name: "name" } }))
    );

    expect(second).not.toBe(first);
  });
});
```

- [ ] **Step 2: Write diff tests**

Create `tests/poller/snapshot-diff.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { diffSnapshotProducts } from "../../src/poller/snapshot-diff.js";

describe("diffSnapshotProducts", () => {
  it("detects new products", () => {
    const result = diffSnapshotProducts({
      products: [{ sourceProductCode: "P-001", name: "Dipirona", price: 12.5, stock: 7 }],
      confirmed: {},
      now: "2026-05-25T12:00:00.000Z"
    });

    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]?.sourceProductCode).toBe("P-001");
  });

  it("ignores unchanged products", () => {
    const product = { sourceProductCode: "P-001", name: "Dipirona", price: 12.5, stock: 7 };
    const first = diffSnapshotProducts({
      products: [product],
      confirmed: {},
      now: "2026-05-25T12:00:00.000Z"
    });

    const second = diffSnapshotProducts({
      products: [product],
      confirmed: {
        "P-001": {
          hash: first.changed[0]?.hash ?? "",
          lastSeenAt: "2026-05-25T12:00:00.000Z",
          lastConfirmedAt: "2026-05-25T12:00:01.000Z"
        }
      },
      now: "2026-05-25T12:01:00.000Z"
    });

    expect(second.changed).toEqual([]);
  });

  it("detects changed price", () => {
    const initial = diffSnapshotProducts({
      products: [{ sourceProductCode: "P-001", name: "Dipirona", price: 12.5, stock: 7 }],
      confirmed: {},
      now: "2026-05-25T12:00:00.000Z"
    });

    const changed = diffSnapshotProducts({
      products: [{ sourceProductCode: "P-001", name: "Dipirona", price: 13.9, stock: 7 }],
      confirmed: {
        "P-001": {
          hash: initial.changed[0]?.hash ?? "",
          lastSeenAt: "2026-05-25T12:00:00.000Z",
          lastConfirmedAt: "2026-05-25T12:00:01.000Z"
        }
      },
      now: "2026-05-25T12:01:00.000Z"
    });

    expect(changed.changed).toHaveLength(1);
  });

  it("ignores removed products", () => {
    const result = diffSnapshotProducts({
      products: [],
      confirmed: {
        "P-001": {
          hash: "hash-1",
          lastSeenAt: "2026-05-25T12:00:00.000Z",
          lastConfirmedAt: "2026-05-25T12:00:01.000Z"
        }
      },
      now: "2026-05-25T12:01:00.000Z"
    });

    expect(result.changed).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
npm test -- tests/poller/snapshot-hash.test.ts tests/poller/snapshot-diff.test.ts
```

Expected: FAIL because the files do not exist.

- [ ] **Step 4: Implement hash**

Create `src/poller/snapshot-hash.ts`:

```ts
import { createHash } from "node:crypto";
import type { ProductChangeRecord, ValidatedSnapshotMappingConfig } from "../mapping/types.js";

export function productSnapshotHash(record: ProductChangeRecord): string {
  return sha256(stableStringify({
    sourceProductCode: record.sourceProductCode,
    name: record.name,
    barcode: record.barcode ?? null,
    price: record.price,
    stock: record.stock,
    active: record.active ?? null,
    sourceUpdatedAt: record.sourceUpdatedAt ?? null
  }));
}

export function snapshotFieldsSignature(mapping: ValidatedSnapshotMappingConfig): string {
  return sha256(stableStringify({
    selectedProductTable: mapping.selectedProductTable ?? null,
    snapshotQuery: mapping.snapshotQuery,
    fields: mapping.fields
  }));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortValue(nested)])
    );
  }
  return value;
}
```

- [ ] **Step 5: Implement diff**

Create `src/poller/snapshot-diff.ts`:

```ts
import type { ProductChangeRecord } from "../mapping/types.js";
import type { PendingSnapshotProduct, SnapshotProductState } from "../state/state-types.js";
import { productSnapshotHash } from "./snapshot-hash.js";

export interface DiffSnapshotProductsInput {
  products: readonly ProductChangeRecord[];
  confirmed: Record<string, SnapshotProductState>;
  now: string;
}

export interface DiffSnapshotProductsResult {
  changed: PendingSnapshotProduct[];
  scannedCount: number;
  unchangedCount: number;
}

export function diffSnapshotProducts(input: DiffSnapshotProductsInput): DiffSnapshotProductsResult {
  const changed: PendingSnapshotProduct[] = [];
  let unchangedCount = 0;

  for (const record of input.products) {
    const hash = productSnapshotHash(record);
    const confirmed = input.confirmed[record.sourceProductCode];

    if (confirmed?.hash === hash) {
      unchangedCount += 1;
      continue;
    }

    changed.push({
      sourceProductCode: record.sourceProductCode,
      hash,
      record
    });
  }

  return {
    changed,
    scannedCount: input.products.length,
    unchangedCount
  };
}
```

- [ ] **Step 6: Run hash and diff tests**

Run:

```bash
npm test -- tests/poller/snapshot-hash.test.ts tests/poller/snapshot-diff.test.ts
```

Expected: PASS.

## Task 4: Snapshot Page Query Adapter Contract

**Files:**
- Modify: `src/db/source-adapter.ts`
- Modify: `src/db/mysql-adapter.ts`
- Modify: `src/db/firebird-adapter.ts`
- Test: `tests/db/mysql-adapter.test.ts`
- Test: `tests/db/firebird-adapter.test.ts`

- [ ] **Step 1: Add failing adapter tests**

Add MySQL test:

```ts
it("queries snapshot pages with limit and offset", async () => {
  const connection = {
    query: vi.fn(async () => [[{ product_id: "P-001" }]]),
    end: vi.fn(async () => undefined)
  };
  const adapter = new MySqlSourceAdapter({
    config: mysqlConfig(),
    connectionFactory: vi.fn(async () => connection)
  });

  await adapter.connect();
  await expect(
    adapter.querySnapshotPage({
      sql: "select * from products order by product_id limit ? offset ?",
      limit: 500,
      offset: 1000
    })
  ).resolves.toEqual([{ product_id: "P-001" }]);

  expect(connection.query).toHaveBeenCalledWith(
    "select * from products order by product_id limit ? offset ?",
    [500, 1000]
  );
});
```

Add Firebird test:

```ts
it("queries snapshot pages with start and end row bounds", async () => {
  const connection = {
    query: vi.fn(async () => [{ PRODUCT_ID: "P-001" }]),
    detach: vi.fn(async () => undefined)
  };
  const adapter = new FirebirdSourceAdapter({
    config: firebirdConfig(),
    connectionFactory: vi.fn(async () => connection)
  });

  await adapter.connect();
  await expect(
    adapter.querySnapshotPage({
      sql: "select * from products order by product_id rows ? to ?",
      limit: 500,
      offset: 1000
    })
  ).resolves.toEqual([{ PRODUCT_ID: "P-001" }]);

  expect(connection.query).toHaveBeenCalledWith(
    "select * from products order by product_id rows ? to ?",
    [1001, 1500]
  );
});
```

- [ ] **Step 2: Run adapter tests and verify failure**

Run:

```bash
npm test -- tests/db/mysql-adapter.test.ts tests/db/firebird-adapter.test.ts
```

Expected: FAIL because `querySnapshotPage` does not exist.

- [ ] **Step 3: Add adapter interface method**

In `src/db/source-adapter.ts`:

```ts
export interface QuerySnapshotPageInput {
  sql: string;
  limit: number;
  offset: number;
}

export interface SourceDatabaseAdapter {
  connect(): Promise<void>;
  close(): Promise<void>;
  queryChanges(input: QueryChangesInput): Promise<SourceRow[]>;
  querySnapshotPage(input: QuerySnapshotPageInput): Promise<SourceRow[]>;
  listTables(): Promise<DatabaseTable[]>;
  listColumns(tableName: string): Promise<DatabaseColumn[]>;
}
```

- [ ] **Step 4: Implement MySQL method**

In `src/db/mysql-adapter.ts`:

```ts
public async querySnapshotPage(input: QuerySnapshotPageInput): Promise<SourceRow[]> {
  const connection = this.requireConnection();

  try {
    const result = await connection.query(input.sql, [input.limit, input.offset]);
    return normalizeRows(result);
  } catch (error) {
    throw normalizeDatabaseError({
      driver: "mysql",
      operation: "query",
      error,
      secrets: this.secrets
    });
  }
}
```

Import `QuerySnapshotPageInput` from `./source-adapter.js`.

- [ ] **Step 5: Implement Firebird method**

In `src/db/firebird-adapter.ts`:

```ts
public async querySnapshotPage(input: QuerySnapshotPageInput): Promise<SourceRow[]> {
  const connection = this.requireConnection();

  try {
    const start = input.offset + 1;
    const end = input.offset + input.limit;
    const result = await connection.query(input.sql, [start, end]);
    return normalizeRows(result);
  } catch (error) {
    throw normalizeDatabaseError({
      driver: "firebird",
      operation: "query",
      error,
      secrets: this.secrets
    });
  }
}
```

Import `QuerySnapshotPageInput` from `./source-adapter.js`.

- [ ] **Step 6: Update test doubles**

Any object typed as `SourceDatabaseAdapter` in tests must add:

```ts
querySnapshotPage: vi.fn(async () => [])
```

Use `rg "queryChanges: vi.fn" tests src -n` to find doubles.

- [ ] **Step 7: Run adapter tests**

Run:

```bash
npm test -- tests/db/mysql-adapter.test.ts tests/db/firebird-adapter.test.ts
```

Expected: PASS.

## Task 5: Snapshot Poller

**Files:**
- Create: `src/poller/snapshot-poller.ts`
- Test: `tests/poller/snapshot-poller.test.ts`

- [ ] **Step 1: Write snapshot poller tests**

Create `tests/poller/snapshot-poller.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { SourceDatabaseAdapter } from "../../src/db/source-adapter.js";
import { validateMappingConfig } from "../../src/mapping/validate.js";
import { SnapshotPoller } from "../../src/poller/snapshot-poller.js";
import type { ConnectorState } from "../../src/state/state-types.js";
import { validSnapshotMapping } from "../helpers/mapping.js";

function adapterWithPages(pages: Record<string, unknown>[][]): SourceDatabaseAdapter {
  return {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    queryChanges: vi.fn(async () => []),
    querySnapshotPage: vi.fn(async () => pages.shift() ?? []),
    listTables: vi.fn(async () => [{ name: "products" }]),
    listColumns: vi.fn(async () => [])
  };
}

function stateReader(state: ConnectorState) {
  return { load: vi.fn(async () => state) };
}

describe("SnapshotPoller", () => {
  it("scans pages and batches new products", async () => {
    const adapter = adapterWithPages([
      [
        { product_id: "P-001", description: "Dipirona", sale_price: "12.50", quantity: "7" }
      ],
      []
    ]);

    const result = await new SnapshotPoller({
      adapter,
      mapping: validateMappingConfig(validSnapshotMapping({ snapshotPageSize: 1, batchSize: 500 })),
      state: stateReader({}),
      connectorId: "connector-1",
      customerId: "customer-1",
      isTransportReady: () => true,
      now: () => "2026-05-25T12:00:00.000Z"
    }).pollOnce();

    expect(result.status).toBe("batch");
    expect(result.batch?.records).toEqual([
      {
        sourceProductCode: "P-001",
        name: "Dipirona",
        barcode: null,
        price: 12.5,
        stock: 7
      }
    ]);
    expect(adapter.querySnapshotPage).toHaveBeenCalledTimes(2);
  });

  it("detects price changes without cursor movement", async () => {
    const first = await new SnapshotPoller({
      adapter: adapterWithPages([[{ product_id: "P-001", description: "Dipirona", sale_price: "12.50", quantity: "7" }], []]),
      mapping: validateMappingConfig(validSnapshotMapping()),
      state: stateReader({}),
      connectorId: "connector-1",
      customerId: "customer-1",
      isTransportReady: () => true,
      now: () => "2026-05-25T12:00:00.000Z"
    }).pollOnce();

    const pending = first.snapshotPending ?? [];
    const confirmedProducts = Object.fromEntries(
      pending.map((entry) => [
        entry.sourceProductCode,
        {
          hash: entry.hash,
          lastSeenAt: "2026-05-25T12:00:00.000Z",
          lastConfirmedAt: "2026-05-25T12:00:01.000Z"
        }
      ])
    );

    const changed = await new SnapshotPoller({
      adapter: adapterWithPages([[{ product_id: "P-001", description: "Dipirona", sale_price: "13.90", quantity: "7" }], []]),
      mapping: validateMappingConfig(validSnapshotMapping()),
      state: stateReader({ snapshotState: { fieldsSignature: first.fieldsSignature ?? "", products: confirmedProducts, pending: [] } }),
      connectorId: "connector-1",
      customerId: "customer-1",
      isTransportReady: () => true,
      now: () => "2026-05-25T12:01:00.000Z"
    }).pollOnce();

    expect(changed.status).toBe("batch");
    expect(changed.batch?.records[0]?.price).toBe(13.9);
  });
});
```

- [ ] **Step 2: Run poller test and verify failure**

Run:

```bash
npm test -- tests/poller/snapshot-poller.test.ts
```

Expected: FAIL because `SnapshotPoller` does not exist.

- [ ] **Step 3: Implement SnapshotPoller**

Create `src/poller/snapshot-poller.ts`:

```ts
import type { Logger } from "../logging/logger.js";
import { applyMapping } from "../mapping/apply.js";
import type { MappingConfig, SourceRow, ValidatedSnapshotMappingConfig } from "../mapping/types.js";
import { validateMappingConfig } from "../mapping/validate.js";
import type { SourceDatabaseAdapter } from "../db/source-adapter.js";
import type { ConnectorState, PendingSnapshotProduct } from "../state/state-types.js";
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
    products: ConnectorState["snapshotState"]["products"]
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
```

- [ ] **Step 4: Run snapshot poller tests**

Run:

```bash
npm test -- tests/poller/snapshot-poller.test.ts
```

Expected: PASS.

## Task 6: Runtime Integration and ACK Persistence

**Files:**
- Modify: `src/service/runtime.ts`
- Test: `tests/service/runtime.test.ts`

- [ ] **Step 1: Write failing runtime test for snapshot ACK**

Add to `tests/service/runtime.test.ts`:

```ts
it("snapshot mode persists confirmed hashes only after accepted ack", async () => {
  const stateStore = await tempStateStore();
  const transport = new FakeTransport();
  const adapter = adapterWithRows([]);
  adapter.querySnapshotPage = vi
    .fn()
    .mockResolvedValueOnce([
      { product_id: "P-001", description: "Dipirona", sale_price: "12.50", quantity: "7" }
    ])
    .mockResolvedValueOnce([]);

  const runtime = createRuntime({ transport, stateStore, adapter });

  await runtime.start();
  transport.emitConfig(configMessage({ mapping: validSnapshotMapping({ snapshotPageSize: 500, batchSize: 500 }) }));

  const batch = await waitForSentBatch(transport);
  expect(batch.records[0]?.sourceProductCode).toBe("P-001");
  await expect(stateStore.load()).resolves.not.toHaveProperty("snapshotState.products.P-001");

  transport.emitAck({
    type: "batch.ack",
    batchId: batch.batchId,
    accepted: true,
    acceptedRecordCount: 1,
    rejectedRecordCount: 0,
    nextAction: "continue"
  });

  await waitUntil(async () => Boolean((await stateStore.load()).snapshotState?.products["P-001"]));
});
```

Use existing fake transport helpers. If helper names differ, adapt to the local names already used in `runtime.test.ts`.

- [ ] **Step 2: Run runtime test and verify failure**

Run:

```bash
npm test -- tests/service/runtime.test.ts
```

Expected: FAIL because runtime always creates `IncrementalPoller`.

- [ ] **Step 3: Add runtime poller union**

In `src/service/runtime.ts`, import `SnapshotPoller` and define:

```ts
import { SnapshotPoller } from "../poller/snapshot-poller.js";
import type { PendingSnapshotProduct } from "../state/state-types.js";

type ActivePoller = IncrementalPoller | SnapshotPoller;
```

Change `private poller?: IncrementalPoller;` to:

```ts
private poller?: ActivePoller;
private inFlightSnapshotPending?: PendingSnapshotProduct[];
private inFlightSnapshotFieldsSignature?: string;
```

- [ ] **Step 4: Instantiate poller by sync mode**

In `activateMapping`, replace direct `new IncrementalPoller` with:

```ts
this.poller =
  mapping.syncMode === "snapshot"
    ? new SnapshotPoller({
        adapter,
        mapping,
        state: this.stateStore,
        connectorId,
        customerId,
        isTransportReady: () => this.transport.isConnected(),
        hasUnacknowledgedBatch: () => this.inFlightBatch !== undefined,
        logger: this.logger,
        now: this.now
      })
    : new IncrementalPoller({
        adapter,
        mapping,
        state: this.stateStore,
        connectorId,
        customerId,
        isTransportReady: () => this.transport.isConnected(),
        hasUnacknowledgedBatch: () => this.inFlightBatch !== undefined,
        logger: this.logger,
        now: this.now
      });
```

Also reset:

```ts
this.inFlightSnapshotPending = undefined;
this.inFlightSnapshotFieldsSignature = undefined;
```

- [ ] **Step 5: Capture snapshot pending from poll results**

In `runPollCycle`, after `this.inFlightBatch = result.batch;`, add:

```ts
if ("snapshotPending" in result) {
  this.inFlightSnapshotPending = result.snapshotPending;
  this.inFlightSnapshotFieldsSignature = result.fieldsSignature;
} else {
  this.inFlightSnapshotPending = undefined;
  this.inFlightSnapshotFieldsSignature = undefined;
}
```

- [ ] **Step 6: Persist snapshot index on ACK**

In `handleBatchAck`, before saving accepted state, compute snapshot update:

```ts
const snapshotState = this.buildAcceptedSnapshotState(state, batch.batchId);
```

Add helper method:

```ts
private buildAcceptedSnapshotState(state: ConnectorState, batchId: string): ConnectorState["snapshotState"] | undefined {
  if (!this.inFlightSnapshotPending || !this.inFlightSnapshotFieldsSignature || !this.inFlightBatch) {
    return state.snapshotState;
  }

  const confirmedCodes = new Set(this.inFlightBatch.records.map((record) => record.sourceProductCode));
  const now = this.now();
  const products = state.snapshotState?.fieldsSignature === this.inFlightSnapshotFieldsSignature
    ? { ...state.snapshotState.products }
    : {};
  const pending: PendingSnapshotProduct[] = [];

  for (const entry of this.inFlightSnapshotPending) {
    if (confirmedCodes.has(entry.sourceProductCode)) {
      products[entry.sourceProductCode] = {
        hash: entry.hash,
        lastSeenAt: now,
        lastConfirmedAt: now
      };
      continue;
    }
    pending.push(entry);
  }

  return {
    fieldsSignature: this.inFlightSnapshotFieldsSignature,
    products,
    pending
  };
}
```

Pass `snapshotState` into `saveState`:

```ts
snapshotState,
```

After accepted ACK, clear:

```ts
this.inFlightSnapshotPending = undefined;
this.inFlightSnapshotFieldsSignature = undefined;
```

Do not clear these before retry/no cursor advance branches unless the batch is no longer in flight and will be rebuilt from persisted pending state.

- [ ] **Step 7: Run runtime tests**

Run:

```bash
npm test -- tests/service/runtime.test.ts
```

Expected: PASS.

## Task 7: Setup and Catalog Config Snapshot Support

**Files:**
- Modify: `src/cli/database-setup.ts`
- Modify: `src/cli/database-setup-state.ts`
- Modify: `src/cli/onboarding-artifact-loader.ts`
- Modify: `src/transport/catalog-config-push.ts`
- Test: `tests/cli/database-setup.test.ts`
- Test: `tests/cli/database-setup-state.test.ts`
- Test: `tests/cli/onboarding-artifact-loader.test.ts`
- Test: `tests/transport/catalog-config-push.test.ts`

- [ ] **Step 1: Add snapshot query builder tests**

Add tests around a new builder:

```ts
expect(buildSnapshotReadTestQuery("mysql", "products", "product_id")).toBe(
  "select * from `products` order by `product_id` limit ? offset ?"
);

expect(buildSnapshotReadTestQuery("firebird", "PRODUCTS", "PRODUCT_ID")).toBe(
  "select * from \"PRODUCTS\" order by \"PRODUCT_ID\" rows ? to ?"
);
```

- [ ] **Step 2: Implement snapshot query builder**

In `src/cli/database-setup.ts`:

```ts
export function buildSnapshotReadTestQuery(
  driver: DatabaseDriver,
  tableName: string,
  stableOrderField: string
): string {
  const quotedTable = quoteIdentifier(driver, tableName);
  const quotedOrder = quoteIdentifier(driver, stableOrderField);
  return driver === "mysql"
    ? `select * from ${quotedTable} order by ${quotedOrder} limit ? offset ?`
    : `select * from ${quotedTable} order by ${quotedOrder} rows ? to ?`;
}
```

- [ ] **Step 3: Extend onboarding artifact state**

In `src/cli/database-setup-state.ts`, persist `syncMode`, `snapshotQuery`, and `snapshotPageSize` when present. Keep current incremental fields for backward compatibility.

Use shape:

```ts
syncMode: input.syncMode ?? "incremental",
snapshotQuery: input.snapshotQuery,
snapshotPageSize: input.snapshotPageSize
```

- [ ] **Step 4: Extend onboarding artifact loader**

In `src/cli/onboarding-artifact-loader.ts`, read:

```ts
const syncMode = record.syncMode === "snapshot" ? "snapshot" : "incremental";
const snapshotQuery = typeof record.snapshotQuery === "string" ? record.snapshotQuery : undefined;
const snapshotPageSize = Number.isInteger(record.snapshotPageSize) ? record.snapshotPageSize as number : undefined;
```

Include them in the returned mapping.

- [ ] **Step 5: Extend catalog config normalization**

In `src/transport/catalog-config-push.ts`, pass through `syncMode`, `snapshotQuery`, and `snapshotPageSize` from catalog payloads. If `syncMode` is omitted, default remains incremental.

Expected normalized snapshot mapping:

```ts
expect(normalized.mapping).toMatchObject({
  syncMode: "snapshot",
  snapshotQuery: "select * from products order by product_id limit ? offset ?",
  snapshotPageSize: 500
});
```

- [ ] **Step 6: Run focused setup/config tests**

Run:

```bash
npm test -- tests/cli/database-setup.test.ts tests/cli/database-setup-state.test.ts tests/cli/onboarding-artifact-loader.test.ts tests/transport/catalog-config-push.test.ts
```

Expected: PASS.

## Task 8: Integration Coverage and Regression Pass

**Files:**
- Modify: `tests/integration/connector-flow.test.ts`
- Modify: `tests/integration/state-and-batch.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Export new utilities**

In `src/index.ts`, export snapshot types and helpers needed by tests or consumers:

```ts
export { SnapshotPoller, type SnapshotPollCycleResult } from "./poller/snapshot-poller.js";
export { productSnapshotHash, snapshotFieldsSignature } from "./poller/snapshot-hash.js";
export { diffSnapshotProducts } from "./poller/snapshot-diff.js";
```

- [ ] **Step 2: Add integration test for price update without cursor**

In `tests/integration/connector-flow.test.ts`, add a flow:

```ts
it("snapshot mode sends price changes without updated_at cursor movement", async () => {
  const adapter = adapterWithSchema(
    [{ name: "products" }],
    [
      { name: "product_id" },
      { name: "description" },
      { name: "sale_price" },
      { name: "quantity" }
    ]
  );
  adapter.querySnapshotPage = vi
    .fn()
    .mockResolvedValueOnce([{ product_id: "P-001", description: "Dipirona", sale_price: "12.50", quantity: "7" }])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ product_id: "P-001", description: "Dipirona", sale_price: "13.90", quantity: "7" }])
    .mockResolvedValueOnce([]);

  // Start runtime, push connector.config with syncMode snapshot, ACK first batch,
  // wait for next batch, and assert salePrice is 13.9.
});
```

Use existing helpers in the file to start runtime and read `product.batch` messages. Keep the test focused on price change detection, not setup wizard behavior.

- [ ] **Step 3: Run integration tests**

Run:

```bash
npm test -- tests/integration/connector-flow.test.ts tests/integration/state-and-batch.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run full regression**

Run:

```bash
npm test
npm run build
```

Expected: all tests PASS and TypeScript build exits 0.

## Task 9: Documentation and Manual Test Notes

**Files:**
- Modify: `docs/configuration.md`
- Modify: `docs/manual-system-tests.md`

- [ ] **Step 1: Document mode choice**

Add a section to `docs/configuration.md`:

```md
### Sync Mode

Use `incremental` when the ERP has a cursor field that advances whenever a synchronized product field changes.

Use `snapshot` when the ERP does not have a reliable update field. Snapshot mode reads the full product list in pages on each polling cycle and sends only products whose synchronized payload changed since the last accepted ACK.

Snapshot mode is intended for catalogs up to 10,000 products. Removed products are ignored; they are not automatically sent as inactive.
```

- [ ] **Step 2: Add manual smoke test**

Add to `docs/manual-system-tests.md` under Product Flow:

```md
### Snapshot product change smoke

1. Publish a `connector.config` with `syncMode: "snapshot"` and a stable `snapshotQuery`.
2. Let the connector send the initial `product.batch`.
3. Return an accepted `batch.ack`.
4. Change only the source product price in the ERP, without changing any update timestamp.
5. Wait for the next polling cycle.
6. Confirm the next `product.batch` includes the changed product with the new price.
7. Confirm a removed product is not sent as inactive automatically.
```

- [ ] **Step 3: Run doc-related tests**

Run:

```bash
npm test -- tests/integration/documentation-manual-system-tests.integration.test.ts tests/package-metadata.test.ts
```

Expected: PASS. Update documentation assertions only if existing tests require exact text coverage.

## Final Verification

- [ ] **Step 1: Check worktree**

Run:

```bash
git status --short --branch
```

Expected: only files related to snapshot sync and the approved spec/plan are changed.

- [ ] **Step 2: Run full verification**

Run:

```bash
npm test
npm run build
```

Expected: PASS.

- [ ] **Step 3: Commit only if requested**

The user explicitly requested no commit during planning. Do not commit automatically. If the user later requests commits, use focused commits such as:

```bash
git add src/mapping/types.ts src/mapping/validate.ts src/transport/protocol.ts tests/mapping/validate.test.ts tests/transport/protocol.test.ts tests/helpers/mapping.ts
git commit -m "feat(sync): add snapshot mapping contract"
```

```bash
git add src/state/state-types.ts src/state/state-store.ts tests/state/state-store.test.ts
git commit -m "feat(sync): persist snapshot state"
```

```bash
git add src/poller/snapshot-hash.ts src/poller/snapshot-diff.ts src/poller/snapshot-poller.ts tests/poller/snapshot-hash.test.ts tests/poller/snapshot-diff.test.ts tests/poller/snapshot-poller.test.ts
git commit -m "feat(sync): add snapshot poller"
```

```bash
git add src/service/runtime.ts tests/service/runtime.test.ts
git commit -m "feat(sync): wire snapshot mode into runtime"
```

```bash
git add docs/configuration.md docs/manual-system-tests.md tests/integration/documentation-manual-system-tests.integration.test.ts tests/package-metadata.test.ts
git commit -m "docs(sync): document snapshot mode"
```

## Self-Review

- Spec coverage: The plan covers mapping contract, snapshot query, local snapshot index, hash diffing, pending batches, ACK-only state updates, mapping invalidation, observability hooks through runtime/poller logs, ignored removals, and tests for price changes without `updated_at`.
- Placeholder scan: No unresolved placeholders or intentionally undefined implementation steps remain.
- Type consistency: `syncMode`, `snapshotQuery`, `snapshotPageSize`, `snapshotState`, `fieldsSignature`, `pending`, `SnapshotPoller`, `productSnapshotHash`, and `snapshotFieldsSignature` are consistently named across tasks.
