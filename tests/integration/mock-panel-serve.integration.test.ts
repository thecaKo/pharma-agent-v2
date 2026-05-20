import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { startMockPanelServeServer } from "../../src/cli/mock-panel.js";
import { OnboardingArtifactError } from "../../src/cli/onboarding-artifact-loader.js";
import { parseServerMessage } from "../../src/transport/protocol.js";

const execFileAsync = promisify(execFile);

const projectRoot = join(import.meta.dirname, "..", "..");

const clients: WebSocket[] = [];

describe("mock panel serve integration", () => {
  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.removeAllListeners("error");
      client.on("error", () => undefined);
      if (client.readyState === WebSocket.CONNECTING) {
        client.terminate();
      } else {
        client.close();
      }
    }
  });

  it("rejects startup when no artifact exists so nothing listens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mp-serve-int-"));
    const missing = join(dir, "gone.json");

    await expect(
      startMockPanelServeServer({
        command: "serve",
        host: "127.0.0.1",
        port: 0,
        artifactFilePath: missing,
        connectorId: "c",
        customerId: "u"
      })
    ).rejects.toThrow(OnboardingArtifactError);
  });

  it("WebSocket handshake receives connector.config built from the temporary onboarding artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mp-serve-int-"));
    const artifactPath = join(dir, "artifact.json");
    const marker = "INCREMENTAL_SERVE_MARKER_9933";
    await writeFile(
      artifactPath,
      `${JSON.stringify(
        {
          version: "1",
          createdAt: "2026-05-18T12:00:00.000Z",
          driver: "mysql",
          databaseName: "pharmacy",
          selectedProductTable: "inventory_items",
          cursorField: "updated_at",
          cursorType: "timestamp",
          incrementalQuery: `SELECT 1 /*${marker}*/`,
          batchSize: 300,
          fields: {
            sourceProductCode: "sku",
            name: "title",
            price: "amount",
            stock: "qty"
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const handle = await startMockPanelServeServer({
      command: "serve",
      host: "127.0.0.1",
      port: 0,
      artifactFilePath: artifactPath,
      connectorId: "int-connector",
      customerId: "int-customer"
    });

    try {
      const { firstMessage } = await openClientWithFirstMessage(handle.url);
      const first = await firstMessage;
      const message = parseServerMessage(first);
      expect(message.type).toBe("connector.config");
      if (message.type !== "connector.config") {
        throw new Error("expected connector.config");
      }
      expect(message.mapping.selectedProductTable).toBe("inventory_items");
      expect(message.mapping.incrementalQuery).toContain(marker);
      expect(message.mapping.incrementalQuery).not.toMatch(/from\s+products/i);
    } finally {
      await handle.close();
    }
  });

  it("root mock-ws-server.mjs forwards to serve and fails before listen when the artifact is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mp-mjs-"));
    const missing = join(dir, "no.json");
    try {
      const result = await execFileAsync(
        process.execPath,
        [join(projectRoot, "mock-ws-server.mjs"), "--artifact-file", missing],
        { cwd: projectRoot, encoding: "utf8", env: process.env }
      );
      expect.fail(`expected non-zero exit, got stdout=${result.stdout} stderr=${result.stderr}`);
    } catch (error) {
      const execError = error as NodeJS.ErrnoException & { stderr?: string };
      expect(execError.code).toBe(1);
      const stderr = String(execError.stderr ?? "");
      expect(stderr).toMatch(/database setup/i);
      expect(stderr).not.toContain("sale_price");
      expect(stderr).not.toContain('"ean"');
    }
  });
});

function openClientWithFirstMessage(url: string): Promise<{ client: WebSocket; firstMessage: Promise<string> }> {
  const client = new WebSocket(url, {
    headers: {
      Authorization: "Bearer connector-token"
    }
  });
  clients.push(client);
  const firstMessage = onceMessage(client);

  return new Promise((resolve, reject) => {
    client.once("open", () => resolve({ client, firstMessage }));
    client.once("error", (err) => {
      const idx = clients.indexOf(client);
      if (idx >= 0) {
        clients.splice(idx, 1);
      }
      client.removeAllListeners();
      reject(err);
    });
  });
}

function onceMessage(client: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    client.once("message", (data) => resolve(data.toString()));
  });
}
