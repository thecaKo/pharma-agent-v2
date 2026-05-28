import { describe, expect, it, vi } from "vitest";
import { probeOdbcDsns } from "../../src/discovery/odbc-dsns.js";

describe("probeOdbcDsns", () => {
  it("returns all DSNs from HKLM and HKCU regardless of driver", async () => {
    const reader = {
      readKey: vi.fn(async (path: string) => {
        if (path === "HKLM\\Software\\ODBC\\ODBC.INI\\ODBC Data Sources") {
          return { LINX_PG: "PostgreSQL Unicode", ORACLE_SRC: "Oracle ODBC Driver" };
        }
        if (path === "HKCU\\Software\\ODBC\\ODBC.INI\\ODBC Data Sources") {
          return { USER_DSN: "Microsoft Access Driver" };
        }
        if (path === "HKLM\\Software\\ODBC\\ODBC.INI\\LINX_PG") {
          return { Driver: "PSQLODBC", Servername: "10.0.0.5", Port: "5432", Database: "linx", Username: "ro" };
        }
        if (path === "HKLM\\Software\\ODBC\\ODBC.INI\\ORACLE_SRC") {
          return { Driver: "Oracle ODBC Driver", Servername: "orcl.local" };
        }
        if (path === "HKCU\\Software\\ODBC\\ODBC.INI\\USER_DSN") {
          return { Driver: "C:\\Windows\\System32\\odbcjt32.dll", DBQ: "C:\\data\\old.mdb" };
        }
        return {};
      })
    };

    const dsns = await probeOdbcDsns(reader);
    expect(dsns).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "LINX_PG",
        driver: "PSQLODBC",
        host: "10.0.0.5",
        port: 5432,
        database: "linx",
        user: "ro"
      }),
      expect.objectContaining({ name: "ORACLE_SRC", driver: "Oracle ODBC Driver", host: "orcl.local" }),
      expect.objectContaining({ name: "USER_DSN", driver: expect.stringContaining("odbcjt32") })
    ]));
  });

  it("dedupes DSN names appearing in both hives (HKLM wins)", async () => {
    const reader = {
      readKey: vi.fn(async (path: string) => {
        if (path.endsWith("ODBC Data Sources") && path.startsWith("HKLM"))
          return { DUP: "PSQLODBC" };
        if (path.endsWith("ODBC Data Sources") && path.startsWith("HKCU"))
          return { DUP: "MariaDB ODBC" };
        if (path === "HKLM\\Software\\ODBC\\ODBC.INI\\DUP")
          return { Driver: "PSQLODBC", Servername: "machine.local" };
        return {};
      })
    };
    const dsns = await probeOdbcDsns(reader);
    expect(dsns).toHaveLength(1);
    expect(dsns[0]).toMatchObject({ name: "DUP", driver: "PSQLODBC", host: "machine.local" });
  });

  it("returns empty list and swallows errors gracefully", async () => {
    const reader = {
      readKey: vi.fn(async () => {
        throw new Error("registry access denied");
      })
    };
    await expect(probeOdbcDsns(reader)).resolves.toEqual([]);
  });
});
