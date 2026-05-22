import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore, isIgnorableFsyncError, pickPersistedState } from "../../src/state/state-store.js";
import type { ConnectorState } from "../../src/state/state-types.js";

const tempDirs: string[] = [];

describe("StateStore", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("returns an empty first-run state when the file is missing", async () => {
    const store = new StateStore({ stateFilePath: await stateFilePath() });

    await expect(store.load()).resolves.toEqual({});
  });

  it("saves and reloads persisted cursor and batch state", async () => {
    const path = await stateFilePath();
    const store = new StateStore({ stateFilePath: path });
    const state: ConnectorState = {
      connectorId: "connector-1",
      customerId: "customer-1",
      mappingVersion: "mapping-v1",
      selectedProductTable: "products",
      cursorField: "updated_at",
      cursorType: "timestamp",
      sourceProductCodeField: "product_id",
      lastAckedCursor: "2026-05-16T20:00:00.000Z",
      lastSuccessfulSendAt: "2026-05-16T20:00:30.000Z",
      lastBatchId: "batch-1"
    };

    await store.save(state);

    await expect(new StateStore({ stateFilePath: path }).load()).resolves.toEqual(state);
  });

  it("saves and reloads the last valid mapping for startup resume", async () => {
    const path = await stateFilePath();
    const store = new StateStore({ stateFilePath: path });
    const state: ConnectorState = {
      connectorId: "connector-1",
      customerId: "customer-1",
      mapping: {
        mappingVersion: "mapping-v1",
        selectedProductTable: "products",
        pollIntervalMs: 10_000,
        batchSize: 500,
        incrementalQuery: "select * from products where id > ? order by id limit ?",
        cursorField: "id",
        cursorType: "number",
        fields: {
          sourceProductCode: "id",
          name: "description",
          price: "sale_price",
          stock: "quantity"
        }
      },
      mappingVersion: "mapping-v1",
      selectedProductTable: "products",
      cursorField: "id",
      cursorType: "number",
      sourceProductCodeField: "id",
      lastAckedCursor: 100
    };

    await store.save(state);

    await expect(new StateStore({ stateFilePath: path }).load()).resolves.toEqual(state);
  });

  it("leaves the previous valid state readable when atomic replacement fails", async () => {
    const path = await stateFilePath();
    const store = new StateStore({ stateFilePath: path });
    await store.save({ mappingVersion: "mapping-v1", lastAckedCursor: 10 });

    const failingStore = new StateStore({
      stateFilePath: path,
      fileSystem: {
        rename: async () => {
          throw new Error("simulated rename failure");
        }
      }
    });

    await expect(failingStore.save({ mappingVersion: "mapping-v2", lastAckedCursor: 20 })).rejects.toThrow(
      "simulated rename failure"
    );
    await expect(new StateStore({ stateFilePath: path }).load()).resolves.toMatchObject({
      mappingVersion: "mapping-v1",
      lastAckedCursor: 10
    });
  });

  it("serializes only non-secret state fields", async () => {
    const path = await stateFilePath();
    const store = new StateStore({ stateFilePath: path });

    await store.save({
      connectorId: "connector-1",
      customerId: "customer-1",
      mappingVersion: "mapping-v1",
      selectedProductTable: "products",
      cursorField: "updated_at",
      cursorType: "timestamp",
      sourceProductCodeField: "product_id",
      lastAckedCursor: 123,
      CONNECTOR_TOKEN: "secret-token",
      DB_PASSWORD: "secret-password",
      database: {
        host: "localhost",
        user: "readonly",
        password: "raw-db-password"
      }
    } as ConnectorState & Record<string, unknown>);

    const serialized = await readFile(path, "utf8");
    expect(serialized).toContain("connector-1");
    expect(serialized).not.toContain("CONNECTOR_TOKEN");
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("DB_PASSWORD");
    expect(serialized).not.toContain("secret-password");
    expect(serialized).not.toContain("raw-db-password");
    expect(JSON.parse(serialized)).toEqual({
      connectorId: "connector-1",
      customerId: "customer-1",
      mappingVersion: "mapping-v1",
      selectedProductTable: "products",
      cursorField: "updated_at",
      cursorType: "timestamp",
      sourceProductCodeField: "product_id",
      lastAckedCursor: 123
    });
  });

  it("ignores unknown keys when loading an existing state file", async () => {
    const path = await stateFilePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        mappingVersion: "mapping-v1",
        connectorToken: "secret-token",
        databasePassword: "secret-password"
      })
    );

    await expect(new StateStore({ stateFilePath: path }).load()).resolves.toEqual({
      mappingVersion: "mapping-v1"
    });
  });

  it("normalizes legacy timestamp cursors into ISO format when loading state", async () => {
    const path = await stateFilePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        mappingVersion: "mapping-v1",
        cursorType: "timestamp",
        lastAckedCursor: "Sat May 16 2026 20:00:02 GMT-0300 (Brasilia Standard Time)"
      })
    );

    await expect(new StateStore({ stateFilePath: path }).load()).resolves.toEqual({
      mappingVersion: "mapping-v1",
      cursorType: "timestamp",
      lastAckedCursor: "2026-05-16T23:00:02.000Z"
    });
  });

  it("continues saving state when file fsync fails with Windows EPERM", async () => {
    const path = await stateFilePath();
    const sync = await spyOnFileHandleSync(path);
    sync.mockRejectedValueOnce(fsError("EPERM"));

    try {
      await expect(new StateStore({ stateFilePath: path }).save({ mappingVersion: "mapping-v1" })).resolves.toBeUndefined();
      await expect(new StateStore({ stateFilePath: path }).load()).resolves.toEqual({
        mappingVersion: "mapping-v1"
      });
    } finally {
      sync.mockRestore();
    }
  });

  it("keeps fatal fsync errors fatal", async () => {
    const path = await stateFilePath();
    const sync = await spyOnFileHandleSync(path);
    sync.mockRejectedValueOnce(fsError("ENOSPC"));

    try {
      await expect(new StateStore({ stateFilePath: path }).save({ mappingVersion: "mapping-v1" })).rejects.toMatchObject({
        code: "ENOSPC"
      });
    } finally {
      sync.mockRestore();
    }
  });
});

describe("pickPersistedState", () => {
  it("keeps only durable state keys", () => {
    expect(
      pickPersistedState({
        connectorId: "connector-1",
        customerId: "customer-1",
        token: "secret-token"
      } as ConnectorState & Record<string, unknown>)
    ).toEqual({
      connectorId: "connector-1",
      customerId: "customer-1"
    });
  });
});

describe("isIgnorableFsyncError", () => {
  it.each(["EPERM", "EINVAL", "ENOTSUP"])("treats %s as ignorable", (code) => {
    expect(isIgnorableFsyncError(fsError(code))).toBe(true);
  });

  it("does not treat disk-full errors as ignorable", () => {
    expect(isIgnorableFsyncError(fsError("ENOSPC"))).toBe(false);
  });
});

async function stateFilePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "connector-state-"));
  tempDirs.push(dir);
  return join(dir, "ProgramData", "PharmaAgentConnector", "connector-state.json");
}

async function spyOnFileHandleSync(path: string): Promise<ReturnType<typeof vi.spyOn>> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "", "utf8");
  const handle = await open(path, "r");
  const fileHandlePrototype = Object.getPrototypeOf(handle) as Awaited<ReturnType<typeof open>>;
  await handle.close();
  return vi.spyOn(fileHandlePrototype, "sync");
}

function fsError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}
