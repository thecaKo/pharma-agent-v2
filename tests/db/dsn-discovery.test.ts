import { describe, expect, it, vi } from "vitest";
import { discoverPostgresDsns } from "../../src/db/dsn-discovery.js";
import type { RegistryReader } from "../../src/db/registry-reader.js";

function makeReader(map: Record<string, string[] | Record<string, string>>): RegistryReader {
  return {
    async listKeys(path) {
      const value = map[path];
      return Array.isArray(value) ? value : [];
    },
    async readKey(path) {
      const value = map[path];
      return value && !Array.isArray(value) ? value : {};
    }
  };
}

const HKLM_INDEX = "HKLM\\Software\\ODBC\\ODBC.INI\\ODBC Data Sources";
const HKCU_INDEX = "HKCU\\Software\\ODBC\\ODBC.INI\\ODBC Data Sources";

describe("discoverPostgresDsns", () => {
  it("returns PSQLODBC DSNs from both HKLM and HKCU, deduped by name", async () => {
    const reader = makeReader({
      [HKLM_INDEX]: { VetorFarma: "PostgreSQL Unicode", LegacyMs: "SQL Server" },
      [HKCU_INDEX]: { VetorFarma: "PostgreSQL Unicode", PgUser: "psqlODBC ANSI" },
      "HKLM\\Software\\ODBC\\ODBC.INI\\VetorFarma": {
        Driver: "C:\\Windows\\system32\\psqlodbc35w.dll",
        Servername: "127.0.0.1",
        Port: "5432",
        Database: "vetorfarma",
        Username: "vfuser"
      },
      "HKLM\\Software\\ODBC\\ODBC.INI\\LegacyMs": {
        Driver: "C:\\Windows\\system32\\sqlsrv32.dll"
      },
      "HKCU\\Software\\ODBC\\ODBC.INI\\VetorFarma": {
        Driver: "C:\\Windows\\system32\\psqlodbc35w.dll",
        Servername: "10.0.0.1"
      },
      "HKCU\\Software\\ODBC\\ODBC.INI\\PgUser": {
        Driver: "C:\\Windows\\system32\\psqlodbca.dll",
        Servername: "db.local",
        Port: "5432",
        Database: "pguser_db"
      }
    });

    const dsns = await discoverPostgresDsns(reader);

    expect(dsns).toEqual([
      {
        dsnName: "VetorFarma",
        host: "127.0.0.1",
        port: 5432,
        database: "vetorfarma",
        user: "vfuser"
      },
      {
        dsnName: "PgUser",
        host: "db.local",
        port: 5432,
        database: "pguser_db"
      }
    ]);
  });

  it("filters out DSNs whose driver does not contain psqlodbc (case-insensitive)", async () => {
    const reader = makeReader({
      [HKLM_INDEX]: { Other: "Some Driver" },
      [HKCU_INDEX]: [],
      "HKLM\\Software\\ODBC\\ODBC.INI\\Other": {
        Driver: "C:\\Windows\\system32\\notpg.dll"
      }
    });
    await expect(discoverPostgresDsns(reader)).resolves.toEqual([]);
  });

  it("omits any password even if the DSN exposes one", async () => {
    const reader = makeReader({
      [HKLM_INDEX]: { Risky: "psqlODBC" },
      [HKCU_INDEX]: [],
      "HKLM\\Software\\ODBC\\ODBC.INI\\Risky": {
        Driver: "psqlodbc35w.dll",
        Servername: "host",
        Username: "u",
        Password: "should-never-be-read",
        Database: "d",
        Port: "5432"
      }
    });

    const dsns = await discoverPostgresDsns(reader);
    expect(dsns).toHaveLength(1);
    expect(dsns[0]).not.toHaveProperty("password");
    expect(JSON.stringify(dsns[0])).not.toContain("should-never-be-read");
  });

  it("returns [] when the reader throws", async () => {
    const reader: RegistryReader = {
      async listKeys() {
        throw new Error("registry blew up");
      },
      async readKey() {
        throw new Error("registry blew up");
      }
    };

    await expect(discoverPostgresDsns(reader)).resolves.toEqual([]);
  });

  it("returns [] when both indexes are empty (non-Windows default reader)", async () => {
    const reader = makeReader({ [HKLM_INDEX]: [], [HKCU_INDEX]: [] });
    await expect(discoverPostgresDsns(reader)).resolves.toEqual([]);
  });
});
