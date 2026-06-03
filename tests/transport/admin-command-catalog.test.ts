import { describe, expect, it } from "vitest";
import { buildAdminRequestMessage, parseServerMessage } from "../../src/transport/protocol.js";

const NEW_COMMANDS = [
  "schema.describeTable",
  "schema.listForeignKeys",
  "schema.sampleRows",
  "sql.runReadOnlySelect",
  "fs.readConfigFile",
  "registry.readKey"
] as const;

describe("AdminCommand — novos comandos do catálogo", () => {
  it.each(NEW_COMMANDS)("aceita %s no parse de admin.request", (command) => {
    const built = buildAdminRequestMessage({ requestId: "r1", command });
    const parsed = parseServerMessage(JSON.stringify({ ...built, input: { table: "produtos" } }));
    expect(parsed.type).toBe("admin.request");
    if (parsed.type === "admin.request") expect(parsed.command).toBe(command);
  });

  it("ainda rejeita comando desconhecido", () => {
    expect(() =>
      parseServerMessage(JSON.stringify({ type: "admin.request", requestId: "r1", command: "fs.writeFile" }))
    ).toThrow(/Unsupported admin command/);
  });
});
