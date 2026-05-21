import { loadConfig, configSecrets, ConfigValidationError } from "./config/env.js";
import { ProgramDataConfigError } from "./config/programdata-config.js";
import {
  buildStartupConfigSourceMetadata,
  resolveStartupEnvironment,
  type ResolveStartupEnvironmentOptions
} from "./config/startup-env.js";
import { createLogger } from "./logging/logger.js";
import { redactValue } from "./logging/redact.js";
import { registerShutdownHandlers } from "./service/shutdown.js";
import { startConnectorRuntime } from "./service/runtime.js";
import { CONNECTOR_VERSION } from "./version.js";

export async function validateStartup(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveStartupEnvironmentOptions = {}
): Promise<void> {
  const startupEnv = await resolveStartupEnvironment(env, options);
  const config = loadConfig(startupEnv.env);
  const logger = createLogger({
    level: config.logLevel,
    secrets: configSecrets(config),
    nodeEnv: readNodeEnv(env)
  });

  logger.info("service.startup", {
    version: CONNECTOR_VERSION,
    dbDriver: config.database.driver,
    ...buildStartupConfigSourceMetadata(startupEnv)
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

export async function runMain(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveStartupEnvironmentOptions = {}
): Promise<number> {
  try {
    await validateStartup(env, options);
    return 0;
  } catch (error) {
    const logger = createLogger({ level: "info", nodeEnv: readNodeEnv(env) });

    if (error instanceof ConfigValidationError) {
      logger.error("unrecoverable.configuration_error", {
        errorCode: "CONFIG_VALIDATION_FAILED",
        issues: error.issues
      });
      return 1;
    }

    if (error instanceof ProgramDataConfigError) {
      logger.error("unrecoverable.startup_error", {
        errorCode: "PROGRAMDATA_CONFIG_FAILED",
        error: redactValue(error.message)
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

export async function runServiceMain(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveStartupEnvironmentOptions = {}
): Promise<number> {
  try {
    const startupEnv = await resolveStartupEnvironment(env, options);
    const runtime = await startConnectorRuntime({ env: startupEnv.env });
    registerShutdownHandlers(runtime);
    return 0;
  } catch (error) {
    const logger = createLogger({ level: "info", nodeEnv: readNodeEnv(env) });

    if (error instanceof ConfigValidationError) {
      logger.error("unrecoverable.configuration_error", {
        errorCode: "CONFIG_VALIDATION_FAILED",
        issues: error.issues
      });
      return 1;
    }

    if (error instanceof ProgramDataConfigError) {
      logger.error("unrecoverable.startup_error", {
        errorCode: "PROGRAMDATA_CONFIG_FAILED",
        error: redactValue(error.message)
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

function readNodeEnv(env: NodeJS.ProcessEnv): string | undefined {
  return env.NODE_ENV ?? env.node_env;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.env.CONNECTOR_VALIDATE_ONLY === "1") {
    process.exitCode = await runMain(process.env);
  } else {
    process.exitCode = await runServiceMain(process.env);
  }
}
