export interface BootstrapStateSnapshot {
  probesRunTotal: number;
  lastProbeAt?: string;
  lastProbeError?: { command: string; code: string };
}

export class BootstrapState {
  private probesRunTotal = 0;
  private lastProbeAt?: string;
  private lastProbeError?: { command: string; code: string };
  private readonly now: () => string;

  public constructor(now: () => string = () => new Date().toISOString()) {
    this.now = now;
  }

  public recordProbeSuccess(command: string): void {
    this.probesRunTotal += 1;
    this.lastProbeAt = this.now();
    this.lastProbeError = undefined;
    void command;
  }

  public recordProbeError(command: string, code: string): void {
    this.probesRunTotal += 1;
    this.lastProbeAt = this.now();
    this.lastProbeError = { command, code };
  }

  public snapshot(): BootstrapStateSnapshot {
    const out: BootstrapStateSnapshot = { probesRunTotal: this.probesRunTotal };
    if (this.lastProbeAt) out.lastProbeAt = this.lastProbeAt;
    if (this.lastProbeError) out.lastProbeError = { ...this.lastProbeError };
    return out;
  }
}
