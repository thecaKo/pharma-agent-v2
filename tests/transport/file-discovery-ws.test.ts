import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildFileDiscoveryScanFailureResult,
  buildFileDiscoveryScanSuccessResult,
  FILE_DISCOVERY_SCAN_COMMAND_TYPE,
  FILE_DISCOVERY_SCAN_RESULT_TYPE,
  parseFileDiscoveryScanCommand,
  scanLocalFilesystem,
  serializeFileDiscoveryScanResult
} from "../../src/transport/file-discovery-ws.js";
import { ProtocolParseError } from "../../src/transport/protocol.js";

describe("file discovery ws protocol", () => {
  it("parses file-discovery.scan with optional root path", () => {
    expect(
      parseFileDiscoveryScanCommand(
        JSON.stringify({
          id: "cmd-x",
          type: FILE_DISCOVERY_SCAN_COMMAND_TYPE,
          rootPath: " C:\\data "
        })
      )
    ).toEqual({
      type: FILE_DISCOVERY_SCAN_COMMAND_TYPE,
      correlationId: "cmd-x",
      rootPath: "C:\\data"
    });
  });

  it("parses file-discovery.scan without explicit root path", () => {
    expect(
      parseFileDiscoveryScanCommand(
        JSON.stringify({
          id: "cmd-rootless",
          type: FILE_DISCOVERY_SCAN_COMMAND_TYPE
        })
      )
    ).toEqual({
      type: FILE_DISCOVERY_SCAN_COMMAND_TYPE,
      correlationId: "cmd-rootless"
    });
  });

  it("rejects file-discovery.scan without correlation id", () => {
    expect(() =>
      parseFileDiscoveryScanCommand(
        JSON.stringify({
          type: FILE_DISCOVERY_SCAN_COMMAND_TYPE,
          rootPath: "/tmp"
        })
      )
    ).toThrow(ProtocolParseError);
  });

  it("serialize success result aligns with MVP wire shape", () => {
    const message = buildFileDiscoveryScanSuccessResult("corr-9", []);
    expect(serializeFileDiscoveryScanResult(message)).toEqual(
      JSON.stringify({
        id: "corr-9",
        type: FILE_DISCOVERY_SCAN_RESULT_TYPE,
        entries: []
      })
    );
  });

  it("failure result keeps failureReason bounded", () => {
    const longReason = `${"e".repeat(600)}suffix`;
    const message = buildFileDiscoveryScanFailureResult("corr-10", longReason);
    expect(message.failureReason!.length).toBe(500);
    expect(message.failureReason!.endsWith("suffix")).toBe(false);
    expect(message.entries).toEqual([]);
  });

  it("scans bounded directory hierarchy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "file-discovery-protocol-"));
    await mkdir(path.join(root, "a"), { recursive: true });
    await writeFile(path.join(root, "a", "x.txt"), "1");

    const snapshot = await scanLocalFilesystem(root);
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.entries.some((entry) => entry.name === "x.txt")).toBe(true);
    }
  });
});
