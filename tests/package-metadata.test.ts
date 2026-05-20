import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = join(import.meta.dirname, "..");

async function readText(path: string): Promise<string> {
  return readFile(join(projectRoot, path), "utf8");
}

async function readPackageJson(): Promise<{
  main: string;
  types: string;
  scripts: Record<string, string>;
}> {
  return JSON.parse(await readText("package.json"));
}

describe("package metadata", () => {
  it("exposes the mock panel CLI through a script that points at the built entrypoint", async () => {
    const pkg = await readPackageJson();

    expect(pkg.scripts["mock-panel"]).toBe("node dist/cli/mock-panel.js");
  });

  it("exposes the database discovery CLI through a script that points at the built entrypoint", async () => {
    const pkg = await readPackageJson();

    expect(pkg.scripts["discover-databases"]).toBe("node dist/cli/discover-databases.js");
  });

  it("exposes the database setup CLI through a script that points at the built entrypoint", async () => {
    const pkg = await readPackageJson();

    expect(pkg.scripts["database-setup"]).toBe("node dist/cli/database-setup.js");
  });

  it("preserves existing service script and entrypoint metadata", async () => {
    const pkg = await readPackageJson();

    expect(pkg.main).toBe("dist/index.js");
    expect(pkg.types).toBe("dist/index.d.ts");
    expect(pkg.scripts).toMatchObject({
      build: "tsc -p tsconfig.json",
      "database-setup": "node dist/cli/database-setup.js",
      start: "node dist/main.js",
      "start:dev": "tsx src/main.ts",
      test: "vitest run",
      coverage: "vitest run --coverage"
    });
  });

  it("exposes the Windows installer packaging command with a TypeScript build prerequisite", async () => {
    const pkg = await readPackageJson();

    expect(pkg.scripts["package:windows-installer"]).toBe(
      "npm run build && node dist/installer/package-windows-installer.js"
    );
  });

  it("keeps the built database setup CLI output aligned with the package script", async () => {
    const pkg = await readPackageJson();
    const script = pkg.scripts["database-setup"];

    expect(script).toBeDefined();

    const outputPath = script.replace(/^node\s+/, "");
    await expect(access(join(projectRoot, outputPath))).resolves.toBeUndefined();
  });
});

describe("mock panel CLI documentation", () => {
  it("documents discovery, selection, current selection, history, and serve workflows", async () => {
    const readme = await readText("README.md");

    expect(readme).toContain("npm run mock-panel -- discover");
    expect(readme).toContain("npm run mock-panel -- select products");
    expect(readme).toContain("npm run mock-panel -- current");
    expect(readme).toContain("npm run mock-panel -- history");
    expect(readme).toContain("npm run mock-panel -- serve");
    expect(readme).toContain("npm run database-setup --");
    expect(readme).toContain("~/.pharma-agent/database-setup.json");
  });

  it("documents simulator scope, mapping source, restart behavior, and state cleanup", async () => {
    const docs = `${await readText("README.md")}\n${await readText("docs/configuration.md")}`.replace(/\s+/g, " ");

    expect(docs).toContain("does not publish production connector configuration");
    expect(docs).toContain("`mock-panel discover` returns table names only");
    expect(docs).toContain("does not return columns");
    expect(docs).toContain("mock-ws-server.mjs");
    expect(docs).toContain("restarts product synchronization from the beginning");
    expect(docs).toContain("~/.pharma-agent/mock-panel-state.json");
    expect(docs).toContain("delete that file");
  });
});

describe("setup-to-mock documentation", () => {
  it("documents production mapping stays central-panel-owned", async () => {
    const readme = await readText("README.md");
    const configurationMd = await readText("docs/configuration.md");
    const merged = `${readme}\n${configurationMd}`.replace(/\s+/g, " ");

    expect(merged).toContain("Production product mapping stays owned by the central panel");
    expect(merged.toLowerCase()).toContain("owned by the central panel");
    expect(configurationMd.replace(/\s+/g, " ")).toContain("production runtime still gets product mapping from the central panel");
  });

  it("documents default onboarding artifact usage for mock-panel serve", async () => {
    const configurationMd = await readText("docs/configuration.md");
    const normalizedConfig = configurationMd.replace(/\s+/g, " ");

    expect(normalizedConfig).toContain("~/.pharma-agent/database-setup.json");
    expect(normalizedConfig).toContain("npm run mock-panel -- serve --artifact-file <path>");
    expect(normalizedConfig).toContain("No onboarding mapping artifact was found");
  });
});

describe("database discovery CLI documentation", () => {
  it("documents discovery command usage and root scoping", async () => {
    const docs = `${await readText("README.md")}\n${await readText("docs/configuration.md")}`.replace(/\s+/g, " ");

    expect(docs).toContain("npm run discover-databases --");
    expect(docs).toContain("npm run discover-databases -- --root <path>");
    expect(docs).toContain("--root <path>");
    expect(docs).toContain("default full-system scan");
  });

  it("documents discovery output fields and blocked-path summary behavior", async () => {
    const docs = `${await readText("README.md")}\n${await readText("docs/configuration.md")}`.replace(/\s+/g, " ");

    expect(docs).toContain("`path`");
    expect(docs).toContain("`type`");
    expect(docs).toContain("`confidence`");
    expect(docs).toContain("Blocked paths");
    expect(docs).toContain("summarized by count");
  });

  it("documents the metadata-only privacy boundary for database discovery", async () => {
    const docs = `${await readText("README.md")}\n${await readText("docs/configuration.md")}\n${await readText(
      "docs/manual-system-tests.md"
    )}`.replace(/\s+/g, " ");

    expect(docs).toContain("metadata-only");
    expect(docs).toContain("does not read database contents");
    expect(docs).toContain("table structures");
    expect(docs).toContain("sample rows");
    expect(docs).toContain("credentials");
    expect(docs).toContain("connection strings");
  });

  it("documents a controlled Windows fixture validation flow", async () => {
    const manualSystemTests = await readText("docs/manual-system-tests.md");
    const normalizedManualSystemTests = manualSystemTests.replace(/\s+/g, " ");

    expect(manualSystemTests).toContain("Database File Discovery CLI Flow");
    expect(manualSystemTests).toContain("C:\\Temp\\pharma-agent-db-fixture");
    expect(manualSystemTests).toContain("npm run discover-databases -- --root C:\\Temp\\pharma-agent-db-fixture");
    expect(manualSystemTests).toContain("npm run discover-databases --");
    expect(normalizedManualSystemTests).toContain("Default scans may inspect many accessible filesystem paths");
  });
});

describe("database setup CLI documentation", () => {
  it("documents manual-first setup with optional discovery on README and configuration docs", async () => {
    const docs = `${await readText("README.md")}\n${await readText("docs/configuration.md")}`.replace(/\s+/g, " ");

    expect(docs).toContain("npm run database-setup --");
    expect(docs).toContain("manual connection");
    expect(docs).toContain("local database discovery");
    expect(docs).toContain("recommended when host, port, database, user, and password are known");
    expect(docs).toContain("manual MySQL");
    expect(docs).toContain("manual Firebird");
    expect(docs).toContain("does not print database passwords or connector tokens");
  });

  it("documents the setup command, local prerequisites, and generated artifacts", async () => {
    const docs = await readText("docs/configuration.md");
    const normalizedDocs = docs.replace(/\s+/g, " ");

    expect(docs).toContain("npm run database-setup --");
    expect(normalizedDocs).toContain("same machine that can reach the pharmacy database");
    expect(normalizedDocs).toContain("read-only database user and password");
    expect(normalizedDocs).toContain("connector token and central WebSocket URL");
    expect(normalizedDocs).toContain("~/.pharma-agent/database-setup.json");
    expect(normalizedDocs).toContain("timestamped `.bak` backup");
  });

  it("documents the env and onboarding JSON boundary without claiming JSON drives production runtime", async () => {
    const docs = await readText("docs/configuration.md");
    const normalizedDocs = docs.replace(/\s+/g, " ");

    expect(normalizedDocs).toContain("Secrets stay in the env file, not in the onboarding JSON artifact");
    expect(normalizedDocs).toContain("CONNECTOR_TOKEN");
    expect(normalizedDocs).toContain("DB_PASSWORD");
    expect(normalizedDocs).toContain("does not replace panel-owned production mapping");
    expect(normalizedDocs).toContain("production runtime still gets product mapping from the central panel");
  });

  it("documents the validation and startup commands printed by the CLI", async () => {
    const docs = `${await readText("docs/configuration.md")}\n${await readText("docs/manual-system-tests.md")}`.replace(
      /\s+/g,
      " "
    );

    expect(docs).toContain("CONNECTOR_VALIDATE_ONLY=1 node --import tsx src/main.ts");
    expect(docs).toContain("npm start");
  });
});

describe("windows installer documentation", () => {
  const PLACEHOLDER_SECRET_PATTERN =
    /(?:CONNECTOR_TOKEN|DB_PASSWORD)\s*[:=]\s*["']?(?!test-token|test-password|<)[a-zA-Z0-9_-]{24,}/u;

  async function operatorDocs(): Promise<string> {
    return [
      await readText("README.md"),
      await readText("docs/configuration.md"),
      await readText("docs/windows-service.md")
    ].join("\n");
  }

  it("documents the ProgramData installer config path", async () => {
    const docs = await operatorDocs();

    expect(docs).toContain("%PROGRAMDATA%\\PharmaAgentConnector\\connector-config.json");
  });

  it("documents environment override precedence over ProgramData config", async () => {
    const docs = (await operatorDocs()).replace(/\s+/g, " ");

    expect(docs).toContain("environment variables override values from the ProgramData file");
    expect(docs).toContain("Empty environment values do not override file values");
  });

  it("documents database onboarding as separate from the installer", async () => {
    const docs = (await operatorDocs()).replace(/\s+/g, " ");

    expect(docs).toContain("PharmaAgentConnector");
    expect(docs).toMatch(
      /database onboarding (?:remains|stays)|remain in this database setup flow|not part of the installer wizard/i
    );
    expect(docs).toMatch(/not part of the installer wizard|not written by the installer/i);
    expect(docs).toContain("npm run database-setup");
  });

  it("does not embed long literal connector tokens or database passwords in operator docs", async () => {
    const docs = await operatorDocs();

    expect(docs).not.toMatch(PLACEHOLDER_SECRET_PATTERN);
    expect(docs).not.toMatch(/sk-[a-zA-Z0-9]{20,}/u);
  });
});

describe("windows installer documentation integration", () => {
  async function serviceDocs(): Promise<string> {
    return await readText("docs/windows-service.md");
  }

  it("documents installer-first install, repair, and uninstall flows", async () => {
    const docs = (await serviceDocs()).replace(/\s+/g, " ");

    expect(docs).toContain("Installer-First Installation");
    expect(docs).toContain("PharmaAgentConnector-Setup.exe");
    expect(docs).toMatch(/administrator privileges/i);
    expect(docs).toContain("Repair");
    expect(docs).toContain("Uninstall");
  });

  it("documents PowerShell scripts as administrative fallback paths", async () => {
    const docs = (await serviceDocs()).replace(/\s+/g, " ");

    expect(docs).toContain("PowerShell Script Fallback");
    expect(docs).toContain(".\\scripts\\install-service.ps1");
    expect(docs).toContain(".\\scripts\\restart-service.ps1");
    expect(docs).toContain(".\\scripts\\uninstall-service.ps1");
    expect(docs).toMatch(/not the normal internal deployment path|not the normal/i);
  });

  it("aligns fallback script guidance with installer service metadata", async () => {
    const docs = await serviceDocs();

    expect(docs).toContain("PharmaAgentConnector");
    expect(docs).toContain("dist\\main.js");
    expect(docs).toContain("automatic");
  });
});

describe("windows installer manual verification documentation", () => {
  async function manualSystemTests(): Promise<string> {
    return await readText("docs/manual-system-tests.md");
  }

  it("mentions building the Windows installer artifact and Windows-gated execution", async () => {
    const manual = (await manualSystemTests()).replace(/\s+/g, " ");

    expect(manual).toContain("npm run package:windows-installer");
    expect(manual).toContain("PharmaAgentConnector-Setup.exe");
    expect(manual).toMatch(/Windows-gated|administrator privileges/i);
    expect(manual).toContain("Automated Checks (Non-Windows and CI)");
  });

  it("includes install, repair, and uninstall manual checks", async () => {
    const manual = await manualSystemTests();

    expect(manual).toContain("## Windows Installer Verification (Manual, Windows-Gated)");
    expect(manual).toContain("### First Install and Service Registration");
    expect(manual).toContain("### Repair");
    expect(manual).toContain("### Uninstall");
    expect(manual).toMatch(/choose \*\*Repair\*\*/i);
  });

  it("includes incomplete database onboarding service-start verification", async () => {
    const manual = (await manualSystemTests()).replace(/\s+/g, " ");

    expect(manual).toContain("### Incomplete Database Onboarding and Service Start");
    expect(manual).toMatch(/before `npm run database-setup --`/i);
    expect(manual).toContain("CONFIG_VALIDATION_FAILED");
    expect(manual).toContain("DB_DRIVER");
    expect(manual).toMatch(/installer success separately from production readiness/i);
  });

  it("includes no-token-exposure checks for installer UI, logs, and completion output", async () => {
    const manual = (await manualSystemTests()).replace(/\s+/g, " ");

    expect(manual).toContain("### Installer Secret Handling");
    expect(manual).toMatch(/do not (?:print|contain|expose|echo)/i);
    expect(manual).toContain("CONNECTOR_TOKEN");
    expect(manual).toMatch(/completion screen/i);
    expect(manual).toMatch(/Windows Installer logs|MSI logs/i);
  });

  it("points completion guidance to the database setup flow", async () => {
    const manual = (await manualSystemTests()).replace(/\s+/g, " ");

    expect(manual).toContain("npm run database-setup --");
    expect(manual).toContain("After Windows Installer Completion");
    expect(manual).toMatch(/database onboarding/i);
  });
});
