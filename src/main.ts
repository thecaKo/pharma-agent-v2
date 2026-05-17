import { config as loadDotEnvFile } from "dotenv";
import { loadConfig, configSecrets, ConfigValidationError } from "./config/env.js";
import { createLogger } from "./logging/logger.js";
import { redactValue } from "./logging/redact.js";
import { registerShutdownHandlers } from "./service/shutdown.js";
import { startConnectorRuntime } from "./service/runtime.js";
import { CONNECTOR_VERSION } from "./version.js";

export function validateStartup(env: NodeJS.ProcessEnv = process.env): void {
  const config = loadConfig(resolveRuntimeEnv(env));
  const logger = createLogger({
    level: config.logLevel,
    secrets: configSecrets(config)
  });

  logger.info("service.startup", {
    version: CONNECTOR_VERSION,
    dbDriver: config.database.driver
  });
  logger.info("configuration.loaded", {
    websocketUrl: config.websocketUrl,
    dbDriver: config.database.driver,
    dbHost: config.database.host,
    dbPort: config.database.port,
    dbName: config.database.name,
    dbUser: config.database.user
  });
}

export function runMain(env: NodeJS.ProcessEnv = process.env): number {
  try {
    validateStartup(env);
    return 0;
  } catch (error) {
    const logger = createLogger({ level: "info" });

    if (error instanceof ConfigValidationError) {
      logger.error("unrecoverable.configuration_error", {
        errorCode: "CONFIG_VALIDATION_FAILED",
        issues: error.issues
      });
      return 1;
    }

    logger.error("unrecoverable.startup_error", {
      errorCode: "STARTUP_FAILED",
      error: redactValue(error instanceof Error ? error.message : String(error))
    });
    return 1;
  }
}

export async function runServiceMain(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  try {
    const runtime = await startConnectorRuntime({ env: resolveRuntimeEnv(env) });
    registerShutdownHandlers(runtime);
    return 0;
  } catch (error) {
    const logger = createLogger({ level: "info" });

    if (error instanceof ConfigValidationError) {
      logger.error("unrecoverable.configuration_error", {
        errorCode: "CONFIG_VALIDATION_FAILED",
        issues: error.issues
      });
      return 1;
    }

    logger.error("unrecoverable.startup_error", {
      errorCode: "STARTUP_FAILED",
      error: redactValue(error instanceof Error ? error.message : String(error))
    });
    return 1;
  }
}

function resolveRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env === process.env) {
    loadDotEnvFile();
    return process.env;
  }

  return env;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.env.CONNECTOR_VALIDATE_ONLY === "1") {
    process.exitCode = runMain(process.env);
  } else {
    process.exitCode = await runServiceMain(process.env);
  }
}
