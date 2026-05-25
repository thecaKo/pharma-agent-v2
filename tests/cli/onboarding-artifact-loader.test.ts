import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OnboardingArtifactError,
  loadValidatedMappingFromOnboardingArtifactFile
} from "../../src/cli/onboarding-artifact-loader.js";
import { MappingValidationError, validateMappingConfig } from "../../src/mapping/validate.js";

const SECRET_TOKEN = "super-secret-connector-token-xyz";
const SECRET_PASSWORD = "super-secret-db-password-abc";

const tempDirs: string[] = [];

describe("loadValidatedMappingFromOnboardingArtifactFile", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("returns a validated mapping for a valid v1 artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onboard-loader-"));
    tempDirs.push(dir);
    const path = join(dir, "onboarding.json");
    await writeFile(
      path,
      `${JSON.stringify(
        {
          version: "1",
          createdAt: "2026-05-18T12:00:00.000Z",
          driver: "mysql",
          databaseName: "pharmacy",
          selectedProductTable: "products",
          cursorField: "updated_at",
          cursorType: "timestamp",
          incrementalQuery: "SELECT * FROM products WHERE updated_at > ?",
          batchSize: 250,
          fields: {
            sourceProductCode: "product_id",
            name: "description",
            price: "sale_price",
            stock: "stock_qty",
            barcode: "ean",
            active: "is_active",
            sourceUpdatedAt: "updated_at"
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const mapping = await loadValidatedMappingFromOnboardingArtifactFile(path);
    expect(validateMappingConfig(mapping)).toEqual(mapping);
    expect(mapping.mappingVersion).toBe("local-onboarding-v1");
    expect(mapping.pollIntervalMs).toBe(10_000);
    expect(mapping.selectedProductTable).toBe("products");
    expect(mapping.batchSize).toBe(250);
    expect(mapping.incrementalQuery).toBe("SELECT * FROM products WHERE updated_at > ?");
    expect(mapping.cursorField).toBe("updated_at");
    expect(mapping.cursorType).toBe("timestamp");
    expect(mapping.fields.sourceProductCode).toBe("product_id");
    expect(mapping.fields.name).toBe("description");
    expect(mapping.fields.price).toBe("sale_price");
    expect(mapping.fields.stock).toBe("stock_qty");
    expect(mapping.fields.barcode).toBe("ean");
    expect(mapping.fields.active).toBe("is_active");
    expect(mapping.fields.sourceUpdatedAt).toBe("updated_at");
  });

  it("returns a validated snapshot mapping for a snapshot v1 artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onboard-loader-"));
    tempDirs.push(dir);
    const path = join(dir, "snapshot-onboarding.json");
    await writeFile(
      path,
      `${JSON.stringify(
        {
          version: "1",
          createdAt: "2026-05-18T12:00:00.000Z",
          driver: "mysql",
          databaseName: "pharmacy",
          selectedProductTable: "products",
          syncMode: "snapshot",
          batchSize: 500,
          snapshotQuery: "select * from products order by product_id limit ? offset ?",
          snapshotPageSize: 250,
          fields: {
            sourceProductCode: "product_id",
            name: "description",
            price: "sale_price",
            stock: "stock_qty"
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const mapping = await loadValidatedMappingFromOnboardingArtifactFile(path);
    expect(mapping.syncMode).toBe("snapshot");
    expect(mapping.snapshotQuery).toBe("select * from products order by product_id limit ? offset ?");
    expect(mapping.snapshotPageSize).toBe(250);
  });

  it("defaults syncMode to incremental when omitted from artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onboard-loader-"));
    tempDirs.push(dir);
    const path = join(dir, "incremental-default.json");
    await writeFile(
      path,
      `${JSON.stringify(
        {
          version: "1",
          createdAt: "2026-05-18T12:00:00.000Z",
          driver: "mysql",
          databaseName: "pharmacy",
          selectedProductTable: "products",
          cursorField: "updated_at",
          cursorType: "timestamp",
          incrementalQuery: "SELECT * FROM products WHERE updated_at > ?",
          batchSize: 250,
          fields: {
            sourceProductCode: "product_id",
            name: "description",
            price: "sale_price",
            stock: "stock_qty"
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const mapping = await loadValidatedMappingFromOnboardingArtifactFile(path);
    expect(mapping.syncMode).toBe("incremental");
  });

  it("throws a setup-first error when the artifact path is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onboard-loader-"));
    tempDirs.push(dir);
    const path = join(dir, "nope.json");

    await expect(loadValidatedMappingFromOnboardingArtifactFile(path)).rejects.toThrow(OnboardingArtifactError);
    await expect(loadValidatedMappingFromOnboardingArtifactFile(path)).rejects.toThrow(/database setup/i);
  });

  it("rejects invalid JSON without leaking file contents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onboard-loader-"));
    tempDirs.push(dir);
    const path = join(dir, "bad.json");
    await writeFile(path, `{ "not": "closed", "secret": ${JSON.stringify(SECRET_TOKEN)}`, "utf8");

    await expect(loadValidatedMappingFromOnboardingArtifactFile(path)).rejects.toThrow(OnboardingArtifactError);
    await expect(loadValidatedMappingFromOnboardingArtifactFile(path)).rejects.toThrow(/not valid json/i);
    try {
      await loadValidatedMappingFromOnboardingArtifactFile(path);
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(SECRET_TOKEN);
    }
  });

  it("rejects artifacts with wrong version before mapping validation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onboard-loader-"));
    tempDirs.push(dir);
    const path = join(dir, "v2.json");
    await writeFile(path, JSON.stringify({ version: "2", mappingVersion: "x" }), "utf8");

    await expect(loadValidatedMappingFromOnboardingArtifactFile(path)).rejects.toMatchObject({
      name: "OnboardingArtifactError"
    });
  });

  it("rejects artifacts missing required field mapping entries via mapping validation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onboard-loader-"));
    tempDirs.push(dir);
    const path = join(dir, "partial.json");
    await writeFile(
      path,
      JSON.stringify({
        version: "1",
        createdAt: "2026-05-18T12:00:00.000Z",
        driver: "mysql",
        databaseName: "pharmacy",
        selectedProductTable: "products",
        cursorField: "updated_at",
        cursorType: "timestamp",
        incrementalQuery: "SELECT 1",
        batchSize: 100,
        fields: {
          sourceProductCode: "product_id",
          price: "sale_price"
        }
      }),
      "utf8"
    );

    await expect(loadValidatedMappingFromOnboardingArtifactFile(path)).rejects.toThrow(MappingValidationError);
    try {
      await loadValidatedMappingFromOnboardingArtifactFile(path);
    } catch (error) {
      expect(error).toBeInstanceOf(MappingValidationError);
      expect((error as MappingValidationError).issues.some((i) => i.field === "fields.name")).toBe(true);
    }
  });

  it("does not expose secret-like extra artifact fields in the validated mapping", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onboard-loader-"));
    tempDirs.push(dir);
    const path = join(dir, "extra.json");
    await writeFile(
      path,
      JSON.stringify({
        version: "1",
        createdAt: "2026-05-18T12:00:00.000Z",
        driver: "mysql",
        databaseName: "pharmacy",
        selectedProductTable: "products",
        cursorField: "updated_at",
        cursorType: "timestamp",
        incrementalQuery: "SELECT 1",
        batchSize: 100,
        connectorToken: SECRET_TOKEN,
        databasePassword: SECRET_PASSWORD,
        fields: {
          sourceProductCode: "product_id",
          name: "description",
          price: "price",
          stock: "stock"
        }
      }),
      "utf8"
    );

    const mapping = await loadValidatedMappingFromOnboardingArtifactFile(path);
    const serialized = JSON.stringify(mapping);
    expect(serialized).not.toContain(SECRET_TOKEN);
    expect(serialized).not.toContain(SECRET_PASSWORD);
  });

  it("does not leak ignored secret-like artifact keys into MappingValidationError text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onboard-loader-"));
    tempDirs.push(dir);
    const path = join(dir, "bad-batch.json");
    await writeFile(
      path,
      JSON.stringify({
        version: "1",
        createdAt: "2026-05-18T12:00:00.000Z",
        driver: "mysql",
        databaseName: "pharmacy",
        selectedProductTable: "products",
        cursorField: "updated_at",
        cursorType: "timestamp",
        incrementalQuery: "SELECT 1",
        batchSize: 0,
        connectorToken: SECRET_TOKEN,
        databasePassword: SECRET_PASSWORD,
        fields: {
          sourceProductCode: "product_id",
          name: "description",
          price: "price",
          stock: "stock"
        }
      }),
      "utf8"
    );

    try {
      await loadValidatedMappingFromOnboardingArtifactFile(path);
      expect.fail("expected validation error");
    } catch (error) {
      expect(error).toBeInstanceOf(MappingValidationError);
      const text = String((error as Error).message);
      expect(text).not.toContain(SECRET_TOKEN);
      expect(text).not.toContain(SECRET_PASSWORD);
    }
  });
});

describe("loadValidatedMappingFromOnboardingArtifactFile — unreadable directory", () => {
  it("fails with a readable error when the file cannot be read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onboard-loader-"));
    try {
      await mkdir(join(dir, "nested"), { recursive: true });
      const path = join(dir, "nested");

      await expect(loadValidatedMappingFromOnboardingArtifactFile(path)).rejects.toThrow(OnboardingArtifactError);
      await expect(loadValidatedMappingFromOnboardingArtifactFile(path)).rejects.toThrow(/Could not read/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
