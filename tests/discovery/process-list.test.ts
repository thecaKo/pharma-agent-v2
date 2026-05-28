import { describe, expect, it } from "vitest";
import { parseWmicProcessOutput } from "../../src/discovery/process-list.js";

describe("parseWmicProcessOutput", () => {
  it("parses standard WMIC CSV output", () => {
    const raw = `Node,ExecutablePath,Name,ProcessId
HOST,C:\\Linx\\bin\\Big.exe,Big.exe,4128
HOST,C:\\Windows\\System32\\svchost.exe,svchost.exe,1024
`.trim();
    expect(parseWmicProcessOutput(raw)).toEqual([
      { pid: 4128, name: "Big.exe", path: "C:\\Linx\\bin\\Big.exe" },
      { pid: 1024, name: "svchost.exe", path: "C:\\Windows\\System32\\svchost.exe" }
    ]);
  });

  it("returns empty for empty input", () => {
    expect(parseWmicProcessOutput("")).toEqual([]);
  });

  it("handles entries with missing ExecutablePath (some system procs)", () => {
    const raw = `Node,ExecutablePath,Name,ProcessId
HOST,,System,4
HOST,C:\\Windows\\explorer.exe,explorer.exe,2048
`.trim();
    expect(parseWmicProcessOutput(raw)).toEqual([
      { pid: 4, name: "System" },
      { pid: 2048, name: "explorer.exe", path: "C:\\Windows\\explorer.exe" }
    ]);
  });

  it("ignores malformed lines", () => {
    const raw = `Node,ExecutablePath,Name,ProcessId
malformed
HOST,C:\\App\\app.exe,app.exe,123
not,enough,cols
`.trim();
    expect(parseWmicProcessOutput(raw)).toEqual([
      { pid: 123, name: "app.exe", path: "C:\\App\\app.exe" }
    ]);
  });

  it("trims whitespace and handles BOM", () => {
    const raw = "﻿Node,ExecutablePath,Name,ProcessId\r\nHOST,  C:\\X\\y.exe  ,  y.exe  ,  55  ";
    expect(parseWmicProcessOutput(raw)).toEqual([
      { pid: 55, name: "y.exe", path: "C:\\X\\y.exe" }
    ]);
  });
});
