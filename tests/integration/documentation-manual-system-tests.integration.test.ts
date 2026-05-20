import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = join(import.meta.dirname, "../..");

describe("manual system test documentation consistency", () => {
  it("covers setup-to-mock serve flow and rejects hidden mock-ws-server mapping reliance", async () => {
    const manual = await readFile(join(projectRoot, "docs/manual-system-tests.md"), "utf8");
    const flattened = manual.replace(/\s+/g, " ");

    expect(manual).toContain("## Mock Panel CLI Flow");
    expect(flattened).toContain("npm run database-setup --");
    expect(manual).toContain("npm run mock-panel -- serve");
    expect(manual).toContain("--artifact-file <path>");
    expect(flattened).toContain("No onboarding mapping artifact was found");
    expect(manual).toContain("mock-ws-server.mjs");
    expect(flattened).toContain("connector.config");
  });

  it("requires validating emitted connector config against onboarding field mapping metadata", async () => {
    const manual = await readFile(join(projectRoot, "docs/manual-system-tests.md"), "utf8");
    const flattened = manual.replace(/\s+/g, " ");

    expect(flattened).toContain("mapping.active");
    expect(flattened).toContain("selectedProductTable");
    expect(flattened).toContain("cursorField");
    expect(flattened).toContain("sourceProductCodeField");
    expect(manual).toContain("onboarding JSON");
  });

  it("documents manual-first setup, Docker MySQL manual verification, and Firebird manual verification", async () => {
    const manual = await readFile(join(projectRoot, "docs/manual-system-tests.md"), "utf8");
    const flattened = manual.replace(/\s+/g, " ");

    expect(manual).toContain("## Manual MySQL Setup (Docker)");
    expect(manual).toContain("docker compose -f docker-compose.test.yml");
    expect(flattened).toContain("manual connection");
    expect(flattened).toContain("local database discovery");
    expect(manual).toContain("## Manual Firebird Setup");
    expect(flattened).toContain("DB_DRIVER=firebird");
    expect(manual).toContain("does not contain `CONNECTOR_TOKEN`");
    expect(manual).toContain("`DB_PASSWORD`");
  });

  it("aligns manual installer checks with installer-first Windows service documentation", async () => {
    const manual = await readFile(join(projectRoot, "docs/manual-system-tests.md"), "utf8");
    const windowsService = await readFile(join(projectRoot, "docs/windows-service.md"), "utf8");
    const manualFlat = manual.replace(/\s+/g, " ");
    const serviceFlat = windowsService.replace(/\s+/g, " ");

    expect(manual).toContain("## Windows Installer Verification (Manual, Windows-Gated)");
    expect(manualFlat).toContain("docs/windows-service.md");
    expect(manualFlat).toContain("Installer-First Installation");
    expect(manual).toContain("PharmaAgentConnector-Setup.exe");
    expect(manual).toContain("npm run package:windows-installer");

    for (const shared of [
      "PharmaAgentConnector",
      "PharmaAgentConnector-Setup.exe",
      "npm run database-setup",
      "Repair",
      "Uninstall",
      "administrator privileges"
    ]) {
      expect(manualFlat).toContain(shared);
      expect(serviceFlat).toContain(shared);
    }

    expect(manualFlat).toMatch(/installer success separately from production readiness/i);
    expect(serviceFlat).toMatch(/does not configure the pharmacy database/i);
  });
});
