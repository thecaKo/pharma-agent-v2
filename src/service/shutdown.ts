export interface ShutdownTarget {
  shutdown(): Promise<void>;
}

export interface ShutdownRegistration {
  dispose(): void;
}

export interface ShutdownProcess {
  on(event: NodeJS.Signals | "beforeExit", listener: () => void): this;
  off(event: NodeJS.Signals | "beforeExit", listener: () => void): this;
}

export function registerShutdownHandlers(
  target: ShutdownTarget,
  processLike: ShutdownProcess = process,
  signals: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"]
): ShutdownRegistration {
  let shuttingDown = false;

  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void target.shutdown();
  };

  for (const signal of signals) {
    processLike.on(signal, shutdown);
  }
  processLike.on("beforeExit", shutdown);

  return {
    dispose: () => {
      for (const signal of signals) {
        processLike.off(signal, shutdown);
      }
      processLike.off("beforeExit", shutdown);
    }
  };
}
