import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeReadonlyProvisioningConfig } from "../../src/config/programdata-config.js";
import type { DatabaseConfig } from "../../src/config/types.js";

const baseDb: DatabaseConfig = {
  driver: "mysql", host: "127.0.0.1", port: 3306, name: "pharmacy", user: "ro", password: "ro-secret"
};

describe("writeReadonlyProvisioningConfig", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pdc-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("grava database RO + bloco readonlyProvisioning provisioned", async () => {
    await writeReadonlyProvisioningConfig(dir, {
      database: baseDb,
      readonlyProvisioning: { status: "provisioned", username: "pharma_connector_ro", engine: "mysql", provisionedAt: "2026-06-03T00:00:00Z" }
    });
    const filePath = join(dir, "PharmaAgentConnector", "connector-config.json");
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    expect(parsed.database.user).toBe("ro");
    expect(parsed.readonlyProvisioning).toEqual({
      status: "provisioned", username: "pharma_connector_ro", engine: "mysql", provisionedAt: "2026-06-03T00:00:00Z"
    });
  });

  it("grava bloco fallback_discovered sem username", async () => {
    await writeReadonlyProvisioningConfig(dir, {
      database: baseDb,
      readonlyProvisioning: { status: "fallback_discovered", engine: "mysql", provisionedAt: "2026-06-03T00:00:00Z" }
    });
    const filePath = join(dir, "PharmaAgentConnector", "connector-config.json");
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    expect(parsed.readonlyProvisioning.status).toBe("fallback_discovered");
    expect("username" in parsed.readonlyProvisioning).toBe(false);
  });
});
