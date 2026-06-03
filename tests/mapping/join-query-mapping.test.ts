import { describe, expect, it } from "vitest";
import { validateMappingConfig } from "../../src/mapping/validate.js";

const JOIN_SQL =
  "SELECT p.codigo, p.nome, dp.preco_final, fp.fabricante FROM produtos p " +
  "LEFT JOIN desconto_produtos dp ON dp.produto_id = p.id " +
  "LEFT JOIN fabricante_produtos fp ON fp.produto_id = p.id";

describe("validateMappingConfig com SELECT+JOIN", () => {
  it("aceita snapshotQuery com JOIN", () => {
    const m = validateMappingConfig({
      mappingVersion: "v1", syncMode: "snapshot", pollIntervalMs: 60000, batchSize: 500,
      snapshotQuery: JOIN_SQL, snapshotPageSize: 500,
      fields: { sourceProductCode: "codigo", name: "nome", price: "preco_final" }
    });
    expect(m.syncMode).toBe("snapshot");
    if (m.syncMode === "snapshot") expect(m.snapshotQuery).toContain("LEFT JOIN");
  });

  it("aceita incrementalQuery com JOIN", () => {
    const m = validateMappingConfig({
      mappingVersion: "v2", syncMode: "incremental", pollIntervalMs: 60000, batchSize: 500,
      incrementalQuery: `${JOIN_SQL} WHERE p.updated_at > ? ORDER BY p.updated_at LIMIT ?`,
      cursorField: "updated_at", cursorType: "timestamp",
      fields: { sourceProductCode: "codigo", name: "nome" }
    });
    expect(m.syncMode).toBe("incremental");
    if (m.syncMode === "incremental") expect(m.incrementalQuery).toContain("LEFT JOIN");
  });
});
