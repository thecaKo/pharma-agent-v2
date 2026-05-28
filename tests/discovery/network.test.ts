import { describe, expect, it } from "vitest";
import * as net from "node:net";
import { probeNetwork, tcpProbe } from "../../src/discovery/network.js";

describe("tcpProbe", () => {
  it("returns true for an open port on localhost", async () => {
    const server = net.createServer().listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as net.AddressInfo).port;

    const open = await tcpProbe("127.0.0.1", port, 500);
    expect(open).toBe(true);

    server.close();
  });

  it("returns false for a closed port within timeout", async () => {
    const open = await tcpProbe("127.0.0.1", 1, 500);
    expect(open).toBe(false);
  });
});

describe("probeNetwork", () => {
  it("reports reachable with latency when port is open", async () => {
    const server = net.createServer().listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as net.AddressInfo).port;

    const result = await probeNetwork({ host: "127.0.0.1", port, timeoutMs: 500 });
    expect(result.reachable).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    server.close();
  });

  it("reports refused for a closed port", async () => {
    const result = await probeNetwork({ host: "127.0.0.1", port: 1, timeoutMs: 500 });
    expect(result.reachable).toBe(false);
    expect(result.error).toMatch(/refused|unreachable/);
  });

  it("reports not reachable for an unroutable address", async () => {
    const result = await probeNetwork({ host: "10.255.255.1", port: 1, timeoutMs: 200 });
    expect(result.reachable).toBe(false);
    expect(result.error).toMatch(/timeout|refused|unreachable|unknown/);
  });
});
