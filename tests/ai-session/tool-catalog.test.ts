import { describe, expect, it } from "vitest";
import { buildToolCatalog, CATALOG_VERSION, TOOL_NAMES, toolNameToAdminCommand } from "../../src/ai-session/tool-catalog.js";

describe("tool-catalog", () => {
  it("declara as 14 ferramentas canônicas mais os sinais (propose_readonly_user + connection.*)", () => {
    expect([...TOOL_NAMES].sort()).toEqual([
      "connection.discoverCandidates",
      "connection.use",
      "fs.readConfigFile",
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
    expect(tools).toHaveLength(17);
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

describe("connection.* no catálogo", () => {
  it("connection.discoverCandidates e connection.use são sinais sem comando admin", () => {
    const catalog = buildToolCatalog();
    expect(catalog.find((t) => t.name === "connection.discoverCandidates")).toBeDefined();
    const useTool = catalog.find((t) => t.name === "connection.use");
    expect(useTool!.inputSchema).toMatchObject({ type: "object", required: ["handle"] });
    expect(toolNameToAdminCommand("connection.discoverCandidates")).toBeUndefined();
    expect(toolNameToAdminCommand("connection.use")).toBeUndefined();
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
