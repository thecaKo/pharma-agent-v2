export interface RetryPolicyOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
  random?: () => number;
}

export function calculateReconnectDelay(attempt: number, options: RetryPolicyOptions): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("attempt must be a positive integer");
  }
  if (options.baseDelayMs <= 0 || options.maxDelayMs <= 0) {
    throw new Error("baseDelayMs and maxDelayMs must be positive");
  }
  if (options.maxDelayMs < options.baseDelayMs) {
    throw new Error("maxDelayMs must be greater than or equal to baseDelayMs");
  }
  if (options.jitterRatio < 0 || options.jitterRatio > 1) {
    throw new Error("jitterRatio must be between 0 and 1");
  }

  const exponentialDelay = options.baseDelayMs * 2 ** (attempt - 1);
  const boundedDelay = Math.min(exponentialDelay, options.maxDelayMs);
  const jitterRange = boundedDelay * options.jitterRatio;
  const random = options.random ?? Math.random;
  const jitter = (random() * 2 - 1) * jitterRange;

  return Math.round(clamp(boundedDelay + jitter, boundedDelay - jitterRange, boundedDelay + jitterRange));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
