import type { ProbeContext, WindowsProcess } from "./types.js";

export type ProcessCandidate = WindowsProcess;

export async function probeProcesses(ctx: ProbeContext): Promise<ProcessCandidate[]> {
  try {
    return await ctx.listProcesses();
  } catch {
    return [];
  }
}
