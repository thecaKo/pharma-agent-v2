import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildOnboardingMappingArtifact,
  writeDatabaseSetupState
} from "../../src/cli/database-setup-state.js";
import { buildEnvBackupPath, mergeConnectorEnvContent, writeConnectorEnvFile } from "../../src/cli/env-file.js";

const tempDirs: string[] = [];
const FIXED_DATE = new Date("2026-05-18T14:30:45.000Z");

describe("mergeConnectorEnvContent", () => {
  it("preserves comments and unrelated variables while replacing known keys", () => {
    const existing = [
      "# local connector config",
      "APP_MODE=development",
      "DB_HOST=127.0.0.1",
      "DB_PASSWORD=old-secret # keep comment",
      "CUSTOM_FLAG=yes"
    ].join("\n");

    expect(
      mergeConnectorEnvContent(existing, {
        DB_HOST: "localhost",
        DB_PASSWORD: "new secret"
      })
    ).toBe(
      [
        "# local connector config",
        "APP_MODE=development",
        "DB_HOST=localhost",
        'DB_PASSWORD=\"new secret\" # keep comment',
        "CUSTOM_FLAG=yes",
        ""
      ].join("\n")
    );
  });

  it("appends missing known keys without deleting existing lines", () => {
    const existing = ["# existing", "APP_MODE=development"].join("\n");

    expect(
      mergeConnectorEnvContent(existing, {
        CONNECTOR_TOKEN: "connector-token",
        DB_PORT: 3306
      })
    ).toBe(
      [
        "# existing",
        "APP_MODE=development",
        "",
        "CONNECTOR_TOKEN=connector-token",
        "DB_PORT=3306",
        ""
      ].join("\n")
    );
  });
});

describe("writeConnectorEnvFile", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("creates a missing env file without a backup", async () => {
    const envFilePath = await tempPath("config", ".env");

    const result = await writeConnectorEnvFile({
      envFilePath,
      now: FIXED_DATE,
      values: {
        CONNECTOR_TOKEN: "new-token",
        DB_DRIVER: "mysql",
        DB_HOST: "localhost"
      }
    });

    expect(result).toEqual({
      envFilePath,
      created: true,
      updatedKeys: ["CONNECTOR_TOKEN", "DB_DRIVER", "DB_HOST"]
    });
    await expect(readFile(envFilePath, "utf8")).resolves.toBe(
      ["CONNECTOR_TOKEN=new-token", "DB_DRIVER=mysql", "DB_HOST=localhost", ""].join("\n")
    );
    await expect(readFile(buildEnvBackupPath(envFilePath, FIXED_DATE), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("creates a timestamped backup before overwriting an existing env file", async () => {
    const envFilePath = await tempPath("config", ".env");
    const original = ["# local connector config", "DB_HOST=127.0.0.1", "APP_MODE=development", ""].join("\n");
    await mkdir(dirname(envFilePath), { recursive: true });
    await writeFile(envFilePath, original, "utf8");

    const result = await writeConnectorEnvFile({
      envFilePath,
      now: FIXED_DATE,
      values: {
        DB_HOST: "db.internal",
        DB_PORT: 3306
      }
    });

    const backupFilePath = buildEnvBackupPath(envFilePath, FIXED_DATE);

    expect(result).toEqual({
      envFilePath,
      backupFilePath,
      created: false,
      updatedKeys: ["DB_HOST", "DB_PORT"]
    });
    await expect(readFile(backupFilePath, "utf8")).resolves.toBe(original);
    await expect(readFile(envFilePath, "utf8")).resolves.toBe(
      ["# local connector config", "DB_HOST=db.internal", "APP_MODE=development", "", "DB_PORT=3306", ""].join(
        "\n"
      )
    );
  });
});

describe("buildOnboardingMappingArtifact", () => {
  it("excludes secret fields and keeps required onboarding metadata", () => {
    const artifact = buildOnboardingMappingArtifact({
      artifactFilePath: "/tmp/onboarding.json",
      createdAt: FIXED_DATE,
      driver: "mysql",
      databaseName: "pharmacy",
      selectedProductTable: "products",
      cursorField: "updated_at",
      cursorType: "timestamp",
      incrementalQuery: "select * from products where updated_at > ? order by updated_at",
      batchSize: 500,
      connectorToken: "secret-token",
      databasePassword: "secret-password",
      fields: {
        sourceProductCode: "product_id",
        name: "description",
        barcode: "ean",
        price: "sale_price",
        stock: "quantity",
        active: "is_active",
        sourceUpdatedAt: "updated_at"
      }
    });

    expect(artifact).toEqual({
      version: "1",
      createdAt: FIXED_DATE.toISOString(),
      driver: "mysql",
      databaseName: "pharmacy",
      selectedProductTable: "products",
      cursorField: "updated_at",
      cursorType: "timestamp",
      incrementalQuery: "select * from products where updated_at > ? order by updated_at",
      batchSize: 500,
      fields: {
        sourceProductCode: "product_id",
        name: "description",
        barcode: "ean",
        price: "sale_price",
        stock: "quantity",
        active: "is_active",
        sourceUpdatedAt: "updated_at"
      }
    });
    expect(JSON.stringify(artifact)).not.toContain("secret-token");
    expect(JSON.stringify(artifact)).not.toContain("secret-password");
  });
});

describe("onboarding persistence integration", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("writes env and onboarding artifacts with stable content in a temporary directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "connector-onboarding-"));
    tempDirs.push(dir);

    const envFilePath = join(dir, ".env");
    const artifactFilePath = join(dir, "state", "onboarding.json");

    await writeFile(envFilePath, ["APP_MODE=development", "DB_HOST=127.0.0.1", ""].join("\n"), "utf8");

    await writeConnectorEnvFile({
      envFilePath,
      now: FIXED_DATE,
      values: {
        CONNECTOR_TOKEN: "connector-token",
        CONNECTOR_WS_URL: "wss://central-platform/connectors/ws",
        DB_DRIVER: "mysql",
        DB_HOST: "localhost",
        DB_PORT: 3306,
        DB_NAME: "pharmacy",
        DB_USER: "readonly",
        DB_PASSWORD: "db secret",
        LOG_LEVEL: "info"
      }
    });

    await writeDatabaseSetupState({
      artifactFilePath,
      createdAt: FIXED_DATE,
      driver: "mysql",
      databaseName: "pharmacy",
      selectedProductTable: "products",
      cursorField: "updated_at",
      cursorType: "timestamp",
      incrementalQuery: "select * from products where updated_at > ? order by updated_at",
      batchSize: 500,
      connectorToken: "connector-token",
      databasePassword: "db secret",
      fields: {
        sourceProductCode: "product_id",
        name: "description",
        price: "sale_price",
        stock: "quantity",
        sourceUpdatedAt: "updated_at"
      }
    });

    await expect(readFile(envFilePath, "utf8")).resolves.toBe(
      [
        "APP_MODE=development",
        "DB_HOST=localhost",
        "",
        "CONNECTOR_TOKEN=connector-token",
        "CONNECTOR_WS_URL=wss://central-platform/connectors/ws",
        "DB_DRIVER=mysql",
        "DB_PORT=3306",
        "DB_NAME=pharmacy",
        "DB_USER=readonly",
        'DB_PASSWORD=\"db secret\"',
        "LOG_LEVEL=info",
        ""
      ].join("\n")
    );

    await expect(readFile(artifactFilePath, "utf8")).resolves.toBe(
      `${JSON.stringify(
        {
          version: "1",
          createdAt: FIXED_DATE.toISOString(),
          driver: "mysql",
          databaseName: "pharmacy",
          selectedProductTable: "products",
          cursorField: "updated_at",
          cursorType: "timestamp",
          incrementalQuery: "select * from products where updated_at > ? order by updated_at",
          batchSize: 500,
          fields: {
            sourceProductCode: "product_id",
            name: "description",
            price: "sale_price",
            stock: "quantity",
            sourceUpdatedAt: "updated_at"
          }
        },
        null,
        2
      )}\n`
    );
  });
});

async function tempPath(...segments: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "connector-env-"));
  tempDirs.push(dir);
  return join(dir, ...segments);
}
