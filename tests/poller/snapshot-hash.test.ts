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
