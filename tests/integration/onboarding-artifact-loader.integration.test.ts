import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeDatabaseSetupState } from "../../src/cli/database-setup-state.js";
import { loadValidatedMappingFromOnboardingArtifactFile } from "../../src/cli/onboarding-artifact-loader.js";
import { validateMappingConfig } from "../../src/mapping/validate.js";

const tempDirs: string[] = [];

describe("onboarding artifact loader integration", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("loads a mapping from an artifact written by writeDatabaseSetupState and passes validateMappingConfig", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onboard-integration-"));
    tempDirs.push(dir);
    const artifactFilePath = join(dir, "setup.json");

    await writeDatabaseSetupState({
      artifactFilePath,
      createdAt: "2026-05-18T16:00:00.000Z",
      driver: "mysql",
      databaseName: "pharma",
      selectedProductTable: "catalog_items",
      cursorField: "modified_at",
      cursorType: "number",
      incrementalQuery: "SELECT * FROM catalog_items WHERE modified_at > ? ORDER BY modified_at",
      batchSize: 300,
      fields: {
        sourceProductCode: "sku",
        name: "title",
        price: "unit_price",
        stock: "inventory",
        barcode: "gtin"
      }
    });

    const mapping = await loadValidatedMappingFromOnboardingArtifactFile(artifactFilePath);
    expect(validateMappingConfig(mapping)).toEqual(mapping);
    expect(mapping.selectedProductTable).toBe("catalog_items");
    expect(mapping.cursorType).toBe("number");
    expect(mapping.batchSize).toBe(300);
    expect(mapping.mappingVersion).toBe("local-onboarding-v1");
  });
});
