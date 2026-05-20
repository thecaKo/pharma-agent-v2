import { describe, expect, it } from "vitest";
import {
  buildCatalogMappingPreviewStubResult,
  CATALOG_MAPPING_PREVIEW_COMMAND_TYPE,
  CATALOG_MAPPING_PREVIEW_RESULT_TYPE,
  parseCatalogMappingPreviewCommand,
  serializeCatalogMappingPreviewResult,
  tryParseCatalogMappingPreviewCommand
} from "../../src/transport/mapping-preview.js";
import { ProtocolParseError } from "../../src/transport/protocol.js";
import { validMapping } from "../helpers/mapping.js";

describe("mapping preview protocol", () => {
  it("parses a valid catalog.mapping.preview command with optional fields", () => {
    expect(
      parseCatalogMappingPreviewCommand(
        JSON.stringify({
          id: "prev-1",
          type: CATALOG_MAPPING_PREVIEW_COMMAND_TYPE,
          mapping: validMapping(),
          maxSampleSize: 5
        })
      )
    ).toEqual({
      type: CATALOG_MAPPING_PREVIEW_COMMAND_TYPE,
      correlationId: "prev-1",
      mapping: validMapping(),
      maxSampleSize: 5
    });
  });

  it("rejects catalog.mapping.preview without id", () => {
    expect(() =>
      parseCatalogMappingPreviewCommand(
        JSON.stringify({
          type: CATALOG_MAPPING_PREVIEW_COMMAND_TYPE,
          mapping: validMapping(),
          maxSampleSize: 5
        })
      )
    ).toThrow(ProtocolParseError);
  });

  it("returns undefined for unrelated message types", () => {
    expect(
      tryParseCatalogMappingPreviewCommand(
        JSON.stringify({
          id: "cmd-1",
          type: "schema.tables.list"
        })
      )
    ).toBeUndefined();
  });

  it("builds stub result with empty samples and zeroed summary counts", () => {
    const result = buildCatalogMappingPreviewStubResult("prev-1");

    expect(result).toEqual({
      id: "prev-1",
      type: CATALOG_MAPPING_PREVIEW_RESULT_TYPE,
      samples: [],
      summary: {
        matchedCount: 0,
        sampleCount: 0,
        invalidCount: 0
      }
    });
    expect(serializeCatalogMappingPreviewResult(result)).toContain('"type":"catalog.mapping.preview.result"');
  });
});
