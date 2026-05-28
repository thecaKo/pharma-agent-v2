import { describe, expect, it } from "vitest";
import { parseScQueryOutput } from "../../src/discovery/service-list.js";

describe("parseScQueryOutput", () => {
  it("parses sc query output with multiple services", () => {
    const raw = `
SERVICE_NAME: MSSQLSERVER
DISPLAY_NAME: SQL Server (MSSQLSERVER)
        TYPE               : 10  WIN32_OWN_PROCESS
        STATE              : 4  RUNNING
                                (STOPPABLE, PAUSABLE, ACCEPTS_SHUTDOWN)
        WIN32_EXIT_CODE    : 0  (0x0)

SERVICE_NAME: SQLBrowser
DISPLAY_NAME: SQL Server Browser
        TYPE               : 10  WIN32_OWN_PROCESS
        STATE              : 1  STOPPED
        WIN32_EXIT_CODE    : 0  (0x0)
`.trim();
    expect(parseScQueryOutput(raw)).toEqual([
      { name: "MSSQLSERVER", state: "running" },
      { name: "SQLBrowser", state: "stopped" }
    ]);
  });

  it("returns empty list for empty or malformed output", () => {
    expect(parseScQueryOutput("")).toEqual([]);
    expect(parseScQueryOutput("no services here")).toEqual([]);
  });

  it("marks unrecognized state as unknown", () => {
    const raw = `SERVICE_NAME: WeirdSvc\nDISPLAY_NAME: X\n  STATE              : 7  PAUSED\n`;
    expect(parseScQueryOutput(raw)).toEqual([{ name: "WeirdSvc", state: "unknown" }]);
  });
});
