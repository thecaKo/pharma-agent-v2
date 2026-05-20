import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeDatabaseSetupState } from "../../src/cli/database-setup-state.js";
import { writeConnectorEnvFile } from "../../src/cli/env-file.js";

const tempDirs: string[] = [];

describe("writeDatabaseSetupState", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("writes a stable non-secret onboarding artifact", async () => {
    const artifactFilePath = await tempFilePath("onboarding.json");

    const artifact = await writeDatabaseSetupState({
      artifactFilePath,
      createdAt: "2026-05-18T12:34:56.789Z",
      driver: "mysql",
      databaseName: "pharmacy",
      selectedProductTable: "products",
      cursorField: "updated_at",
      cursorType: "timestamp",
      incrementalQuery: "SELECT * FROM products WHERE updated_at > ? ORDER BY updated_at ASC LIMIT ?",
      batchSize: 250,
      fields: {
        sourceProductCode: "product_id",
        name: "description",
        price: "sale_price",
        stock: "stock_qty",
        barcode: "barcode",
        active: "is_active",
        sourceUpdatedAt: "updated_at"
      },
      CONNECTOR_TOKEN: "secret-token",
      DB_PASSWORD: "secret-password"
    });

    expect(artifact).toEqual({
      version: "1",
      createdAt: "2026-05-18T12:34:56.789Z",
      driver: "mysql",
      databaseName: "pharmacy",
      selectedProductTable: "products",
      cursorField: "updated_at",
      cursorType: "timestamp",
      incrementalQuery: "SELECT * FROM products WHERE updated_at > ? ORDER BY updated_at ASC LIMIT ?",
      batchSize: 250,
      fields: {
        sourceProductCode: "product_id",
        name: "description",
        price: "sale_price",
        stock: "stock_qty",
        barcode: "barcode",
        active: "is_active",
        sourceUpdatedAt: "updated_at"
      }
    });

    const serialized = await readFile(artifactFilePath, "utf8");
    expect(serialized).toBe(`${JSON.stringify(artifact, null, 2)}\n`);
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("secret-password");
    expect(serialized).not.toContain("CONNECTOR_TOKEN");
    expect(serialized).not.toContain("DB_PASSWORD");
  });

  it("writes env and onboarding artifacts together in a temporary directory", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "database-setup-persistence-"));
    tempDirs.push(tempDir);
    const envFilePath = join(tempDir, ".env");
    const artifactFilePath = join(tempDir, "onboarding.json");

    await writeConnectorEnvFile({
      envFilePath,
      values: {
        CONNECTOR_TOKEN: "token-1",
        CONNECTOR_WS_URL: "wss://central-platform/connectors/ws",
        DB_DRIVER: "firebird",
        DB_HOST: "127.0.0.1",
        DB_PORT: "3050",
        DB_NAME: "/data/farmacia.fdb",
        DB_USER: "SYSDBA",
        DB_PASSWORD: "super-secret"
      }
    });

    await writeDatabaseSetupState({
      artifactFilePath,
      createdAt: "2026-05-18T13:00:00.000Z",
      driver: "firebird",
      databaseName: "/data/farmacia.fdb",
      selectedProductTable: "PRODUTOS",
      cursorField: "DATA_ATUALIZACAO",
      cursorType: "timestamp",
      incrementalQuery: "SELECT FIRST ? * FROM PRODUTOS WHERE DATA_ATUALIZACAO > ? ORDER BY DATA_ATUALIZACAO",
      batchSize: 100,
      fields: {
        sourceProductCode: "CODIGO",
        name: "DESCRICAO",
        price: "PRECO",
        stock: "ESTOQUE"
      },
      DB_PASSWORD: "super-secret"
    });

    await expect(readFile(envFilePath, "utf8")).resolves.toContain("DB_PASSWORD=super-secret\n");
    const artifact = await readFile(artifactFilePath, "utf8");
    expect(artifact).toContain('"selectedProductTable": "PRODUTOS"');
    expect(artifact).toContain('"batchSize": 100');
    expect(artifact).not.toContain("super-secret");
  });
});

async function tempFilePath(relativePath: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "database-setup-state-"));
  tempDirs.push(dir);
  return join(dir, relativePath);
}
