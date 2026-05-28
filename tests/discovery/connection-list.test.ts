import { describe, expect, it } from "vitest";
import { parseNetstatOutput } from "../../src/discovery/connection-list.js";

describe("parseNetstatOutput", () => {
  it("parses ESTABLISHED IPv4 connections", () => {
    const raw = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:49802        127.0.0.1:1433         ESTABLISHED     4128
  TCP    192.168.1.10:49850     10.0.0.5:5432          ESTABLISHED     2200
  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4
`.trim();
    expect(parseNetstatOutput(raw)).toEqual([
      {
        pid: 4128,
        localAddr: "127.0.0.1",
        localPort: 49802,
        remoteAddr: "127.0.0.1",
        remotePort: 1433,
        state: "ESTABLISHED"
      },
      {
        pid: 2200,
        localAddr: "192.168.1.10",
        localPort: 49850,
        remoteAddr: "10.0.0.5",
        remotePort: 5432,
        state: "ESTABLISHED"
      }
    ]);
  });

  it("parses ESTABLISHED IPv6 connections", () => {
    const raw = `
  Proto  Local Address          Foreign Address        State           PID
  TCP    [::1]:49901            [::1]:1433             ESTABLISHED     4128
`.trim();
    expect(parseNetstatOutput(raw)).toEqual([
      {
        pid: 4128,
        localAddr: "::1",
        localPort: 49901,
        remoteAddr: "::1",
        remotePort: 1433,
        state: "ESTABLISHED"
      }
    ]);
  });

  it("returns empty for empty input", () => {
    expect(parseNetstatOutput("")).toEqual([]);
  });

  it("ignores non-TCP and malformed lines", () => {
    const raw = `
  Proto  Local Address          Foreign Address        State           PID
  UDP    0.0.0.0:53             *:*                                    1500
  TCP    127.0.0.1:80           127.0.0.1:5555         ESTABLISHED     1000
  garbage line here
`.trim();
    expect(parseNetstatOutput(raw)).toEqual([
      {
        pid: 1000,
        localAddr: "127.0.0.1",
        localPort: 80,
        remoteAddr: "127.0.0.1",
        remotePort: 5555,
        state: "ESTABLISHED"
      }
    ]);
  });
});
