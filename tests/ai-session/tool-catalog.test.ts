import { describe, expect, it } from "vitest";
import { buildToolCatalog, CATALOG_VERSION, TOOL_NAMES, toolNameToAdminCommand } from "../../src/ai-session/tool-catalog.js";

describe("tool-catalog", () => {
  it("declara as primitivas read-only canônicas mais os sinais (propose_readonly_user + db.connect)", () => {
    expect([...TOOL_NAMES].sort()).toEqual([
      "db.connect",
      "fs.listDir",
      "fs.readConfigFile",
      "fs.readFile",
      "fs.stat",
      "probe.connections",
      "probe.engines",
      "probe.network",
      "probe.odbc_dsns",
      "probe.processes",
      "probe.scan_config_dirs",
      "probe.test_connection",
      "propose_readonly_user",
      "registry.readKey",
      "schema.describeTable",
      "schema.listForeignKeys",
      "schema.listTables",
      "schema.sampleRows",
      "sql.runReadOnlySelect"
    ]);
  });

  it("buildToolCatalog devolve um ToolDescriptor por ferramenta", () => {
    const tools = buildToolCatalog();
    expect(tools).toHaveLength(19);
    for (const tool of tools) {
      expect(tool.name).toBeTypeOf("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeTypeOf("object");
      expect(tool.outputSchema).toBeTypeOf("object");
    }
  });

  it("CATALOG_VERSION é string não vazia", () => {
    expect(CATALOG_VERSION.length).toBeGreaterThan(0);
  });

  it("toolNameToAdminCommand mapeia para AdminCommand", () => {
    expect(toolNameToAdminCommand("schema.listTables")).toBe("schema.listTables");
    expect(toolNameToAdminCommand("sql.runReadOnlySelect")).toBe("sql.runReadOnlySelect");
    expect(toolNameToAdminCommand("desconhecida")).toBeUndefined();
  });
});

describe("db.connect no catálogo", () => {
  it("db.connect é sinal sem comando admin e exige os params completos", () => {
    const catalog = buildToolCatalog();
    const tool = catalog.find((t) => t.name === "db.connect");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema).toMatchObject({
      type: "object",
      required: ["driver", "host", "user", "password", "database"]
    });
    expect(toolNameToAdminCommand("db.connect")).toBeUndefined();
  });
});

describe("fs.* primitivas no catálogo", () => {
  it("fs.listDir/fs.readFile/fs.stat mapeiam para comando admin", () => {
    expect(toolNameToAdminCommand("fs.listDir")).toBe("fs.listDir");
    expect(toolNameToAdminCommand("fs.readFile")).toBe("fs.readFile");
    expect(toolNameToAdminCommand("fs.stat")).toBe("fs.stat");
  });
});

describe("propose_readonly_user no catálogo", () => {
  it("aparece no catálogo como tool de sinal sem comando admin", () => {
    const catalog = buildToolCatalog();
    const tool = catalog.find((t) => t.name === "propose_readonly_user");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema).toMatchObject({
      type: "object",
      required: ["username"],
      properties: { username: { type: "string" }, rationale: { type: "string" } }
    });
    expect(TOOL_NAMES.has("propose_readonly_user")).toBe(true);
    // É sinal: NÃO tem comando admin associado.
    expect(toolNameToAdminCommand("propose_readonly_user")).toBeUndefined();
  });
});
