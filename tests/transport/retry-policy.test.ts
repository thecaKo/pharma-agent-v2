import { describe, expect, it } from "vitest";
import { calculateReconnectDelay } from "../../src/transport/retry-policy.js";

describe("calculateReconnectDelay", () => {
  it("returns increasing delays up to the configured maximum", () => {
    const options = {
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: 0,
      random: () => 0.5
    };

    expect([1, 2, 3, 4, 5].map((attempt) => calculateReconnectDelay(attempt, options))).toEqual([
      100,
      200,
      400,
      800,
      1_000
    ]);
  });

  it("keeps jitter within the configured lower and upper bounds", () => {
    const low = calculateReconnectDelay(3, {
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: 0.25,
      random: () => 0
    });
    const high = calculateReconnectDelay(3, {
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: 0.25,
      random: () => 1
    });

    expect(low).toBe(300);
    expect(high).toBe(500);
  });
});
