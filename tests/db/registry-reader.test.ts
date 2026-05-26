import { describe, expect, it, vi } from "vitest";
import {
  createRegExeRegistryReader,
  type RegistryReader
} from "../../src/db/registry-reader.js";

describe("createRegExeRegistryReader", () => {
  it("returns empty arrays on non-Windows platforms without invoking reg.exe", async () => {
    const exec = vi.fn();
    const reader: RegistryReader = createRegExeRegistryReader({
      platform: "linux",
      exec
    });

    await expect(reader.listKeys("HKLM\\Software\\ODBC\\ODBC.INI")).resolves.toEqual([]);
    await expect(reader.readKey("HKLM\\Software\\ODBC\\ODBC.INI\\Foo")).resolves.toEqual({});
    expect(exec).not.toHaveBeenCalled();
  });

  it("parses listKeys output from reg.exe on Windows", async () => {
    const exec = vi.fn(async (args: readonly string[]) => {
      expect(args[0]).toBe("query");
      expect(args[1]).toBe("HKLM\\Software\\ODBC\\ODBC.INI");
      return {
        stdout: [
          "",
          "HKEY_LOCAL_MACHINE\\Software\\ODBC\\ODBC.INI",
          "    (Default)    REG_SZ    (value not set)",
          "",
          "HKEY_LOCAL_MACHINE\\Software\\ODBC\\ODBC.INI\\ODBC Data Sources",
          "HKEY_LOCAL_MACHINE\\Software\\ODBC\\ODBC.INI\\VetorFarma",
          ""
        ].join("\r\n"),
        stderr: ""
      };
    });
    const reader = createRegExeRegistryReader({ platform: "win32", exec });

    const subkeys = await reader.listKeys("HKLM\\Software\\ODBC\\ODBC.INI");

    expect(subkeys).toEqual([
      "ODBC Data Sources",
      "VetorFarma"
    ]);
  });

  it("parses readKey output from reg.exe", async () => {
    const exec = vi.fn(async () => ({
      stdout: [
        "",
        "HKEY_LOCAL_MACHINE\\Software\\ODBC\\ODBC.INI\\VetorFarma",
        "    Driver       REG_SZ    C:\\Windows\\system32\\psqlodbc35w.dll",
        "    Servername   REG_SZ    127.0.0.1",
        "    Port         REG_SZ    5432",
        "    Database     REG_SZ    vetorfarma",
        "    Username     REG_SZ    vfuser",
        ""
      ].join("\r\n"),
      stderr: ""
    }));
    const reader = createRegExeRegistryReader({ platform: "win32", exec });

    const values = await reader.readKey("HKLM\\Software\\ODBC\\ODBC.INI\\VetorFarma");

    expect(values).toEqual({
      Driver: "C:\\Windows\\system32\\psqlodbc35w.dll",
      Servername: "127.0.0.1",
      Port: "5432",
      Database: "vetorfarma",
      Username: "vfuser"
    });
  });

  it("returns [] / {} when reg.exe fails (missing key, ACL denial)", async () => {
    const exec = vi.fn(async () => {
      throw new Error("ERROR: The system was unable to find the specified registry key");
    });
    const reader = createRegExeRegistryReader({ platform: "win32", exec });

    await expect(reader.listKeys("HKCU\\does\\not\\exist")).resolves.toEqual([]);
    await expect(reader.readKey("HKCU\\does\\not\\exist")).resolves.toEqual({});
  });
});
