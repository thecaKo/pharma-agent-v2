import { describe, expect, it } from "vitest";
import {
  buildSchemaTablesListResult,
  normalizeSchemaDiscoveryColumns,
  parseSchemaTablesListCommand,
  SCHEMA_DISCOVERY_MAX_COLUMN_COUNT_PER_TABLE,
  SCHEMA_DISCOVERY_MAX_TABLE_COUNT,
  SCHEMA_TABLES_LIST_COMMAND_TYPE,
  SCHEMA_TABLES_LIST_RESULT_TYPE,
  serializeSchemaTablesListResult,
  tryParseSchemaTablesListCommand,
  tryParseSchemaTablesListResult
} from "../../src/transport/schema-discovery.js";
import { ProtocolParseError } from "../../src/transport/protocol.js";

describe("schema discovery protocol", () => {
  it("parses a valid schema.tables.list command", () => {
    expect(
      parseSchemaTablesListCommand(
        JSON.stringify({
          id: "cmd-1",
          type: SCHEMA_TABLES_LIST_COMMAND_TYPE
        })
      )
    ).toEqual({
      type: SCHEMA_TABLES_LIST_COMMAND_TYPE,
      correlationId: "cmd-1"
    });
  });

  it("rejects schema.tables.list without id", () => {
    expect(() =>
      parseSchemaTablesListCommand(
        JSON.stringify({
          type: SCHEMA_TABLES_LIST_COMMAND_TYPE
        })
      )
    ).toThrow(ProtocolParseError);
  });

  it("returns undefined for unrelated message types", () => {
    expect(
      tryParseSchemaTablesListCommand(
        JSON.stringify({
          type: "admin.request",
          requestId: "req-1",
          command: "schema.listTables"
        })
      )
    ).toBeUndefined();
  });

  it("maps dataType to type and applies discovery limits", () => {
    const tables = Array.from({ length: SCHEMA_DISCOVERY_MAX_TABLE_COUNT + 1 }, (_, index) => ({
      name: `table_${index}`,
      columns: Array.from({ length: SCHEMA_DISCOVERY_MAX_COLUMN_COUNT_PER_TABLE + 1 }, (__, columnIndex) => ({
        name: `column_${columnIndex}`,
        type: "varchar",
        nullable: true
      }))
    }));

    const result = buildSchemaTablesListResult({
      correlationId: "cmd-1",
      tables
    });

    expect(result).toMatchObject({
      id: "cmd-1",
      type: SCHEMA_TABLES_LIST_RESULT_TYPE,
      tables: expect.any(Array)
    });
    expect(result.tables).toHaveLength(SCHEMA_DISCOVERY_MAX_TABLE_COUNT);
    expect(result.tables[0]?.columns).toHaveLength(SCHEMA_DISCOVERY_MAX_COLUMN_COUNT_PER_TABLE);
    expect(serializeSchemaTablesListResult(result)).toContain('"type":"schema.tables.list.result"');
  });

  it("parses schema.tables.list.result payloads", () => {
    const built = buildSchemaTablesListResult({
      correlationId: "corr-1",
      tables: [{ name: "t1", columns: [{ name: "c1", type: "int" }] }]
    });
    const raw = serializeSchemaTablesListResult(built);
    expect(tryParseSchemaTablesListResult(raw)).toEqual(built);
  });

  it("returns undefined for non-result schema messages", () => {
    expect(
      tryParseSchemaTablesListResult(JSON.stringify({ id: "x", type: SCHEMA_TABLES_LIST_COMMAND_TYPE }))
    ).toBeUndefined();
  });

  it("normalizes database columns with unknown type fallback", () => {
    expect(
      normalizeSchemaDiscoveryColumns([
        { name: " id ", dataType: " INT ", nullable: false },
        { name: "notes" }
      ])
    ).toEqual([
      { name: "id", type: "INT", nullable: false },
      { name: "notes", type: "unknown" }
    ]);
  });
});
