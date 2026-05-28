import { describe, expect, it } from "vitest";
import { BootstrapState } from "../../src/service/bootstrap-state.js";

describe("BootstrapState", () => {
  it("starts with zero probes", () => {
    const state = new BootstrapState();
    expect(state.snapshot()).toEqual({ probesRunTotal: 0 });
  });

  it("increments probesRunTotal and records lastProbeAt on success", () => {
    const state = new BootstrapState(() => "2026-05-27T10:00:00.000Z");
    state.recordProbeSuccess("probe.engines");
    expect(state.snapshot()).toEqual({
      probesRunTotal: 1,
      lastProbeAt: "2026-05-27T10:00:00.000Z"
    });
  });

  it("records lastProbeError on failure", () => {
    const state = new BootstrapState(() => "2026-05-27T10:00:00.000Z");
    state.recordProbeError("probe.test_connection", "auth");
    expect(state.snapshot()).toEqual({
      probesRunTotal: 1,
      lastProbeAt: "2026-05-27T10:00:00.000Z",
      lastProbeError: { command: "probe.test_connection", code: "auth" }
    });
  });

  it("clears lastProbeError after a subsequent successful probe", () => {
    const state = new BootstrapState(() => "now");
    state.recordProbeError("probe.engines", "unknown");
    state.recordProbeSuccess("probe.engines");
    expect(state.snapshot().lastProbeError).toBeUndefined();
    expect(state.snapshot().probesRunTotal).toBe(2);
  });
});
