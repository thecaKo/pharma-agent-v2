import { describe, expect, it, vi } from "vitest";
import { attachFirebirdConnection, type FirebirdDriverModule } from "../../src/db/firebird-driver.js";

describe("attachFirebirdConnection", () => {
  it("wraps node-firebird handshake crashes as connection errors", async () => {
    const firebird: FirebirdDriverModule = {
      attach: vi.fn(() => {
        process.nextTick(() => {
          const error = new TypeError("Cannot read properties of undefined (reading 'readUInt16LE')");
          error.stack = [
            "TypeError: Cannot read properties of undefined (reading 'readUInt16LE')",
            "    at decodeResponse (/tmp/node_modules/node-firebird/lib/wire/connection.js:1833:52)"
          ].join("\n");
          throw error;
        });
      })
    };

    await expect(
      attachFirebirdConnection(firebird, {
        host: "127.0.0.1",
        port: 3050,
        database: "/var/lib/firebird/data/pharma_flow.fdb",
        user: "SYSDBA",
        password: "masterkey",
        readonly: true
      })
    ).rejects.toThrow("Firebird driver handshake failed before authentication completed.");
  });
});
