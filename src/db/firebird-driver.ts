import type { FirebirdConnectionConfig, FirebirdDriverConnection } from "./firebird-adapter.js";

export interface FirebirdDriverModule {
  attach(
    options: Record<string, unknown>,
    callback: (error: Error | undefined, db: { query: Function; detach: Function }) => void
  ): void;
}

export async function attachFirebirdConnection(
  firebird: FirebirdDriverModule,
  config: FirebirdConnectionConfig
): Promise<FirebirdDriverConnection> {
  return await new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      process.off("uncaughtException", onUncaughtException);
    };

    const rejectOnce = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const resolveOnce = (connection: FirebirdDriverConnection) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(connection);
    };

    const onUncaughtException = (error: Error) => {
      if (!isFirebirdDriverHandshakeCrash(error)) {
        cleanup();
        process.nextTick(() => {
          throw error;
        });
        return;
      }

      rejectOnce(
        new Error(
          "Firebird driver handshake failed before authentication completed. Check server auth/wire protocol compatibility.",
          { cause: error }
        )
      );
    };

    process.once("uncaughtException", onUncaughtException);

    try {
      firebird.attach(
        {
          host: config.host,
          port: config.port,
          database: config.database,
          user: config.user,
          password: config.password
        },
        (error: Error | undefined, db: { query: Function; detach: Function }) => {
          if (error) {
            rejectOnce(error);
            return;
          }

          resolveOnce({
            query: (sql: string, params: readonly unknown[]) =>
              new Promise((queryResolve, queryReject) => {
                db.query(sql, params, (queryError: Error | undefined, result: unknown) => {
                  if (queryError) {
                    queryReject(queryError);
                    return;
                  }
                  queryResolve(result);
                });
              }),
            detach: () =>
              new Promise<void>((detachResolve, detachReject) => {
                db.detach((detachError: Error | undefined) => {
                  if (detachError) {
                    detachReject(detachError);
                    return;
                  }
                  detachResolve();
                });
              })
          });
        }
      );
    } catch (error) {
      rejectOnce(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function isFirebirdDriverHandshakeCrash(error: Error): boolean {
  const stack = error.stack ?? "";
  return /node-firebird[\\/].*connection\.js/u.test(stack) || error.message.includes("readUInt16LE");
}
