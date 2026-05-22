import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, configSecrets, ConfigValidationError } from "./config/env.js";
import { ProgramDataConfigError } from "./config/programdata-config.js";
import {
  buildStartupConfigSourceMetadata,
  resolveStartupEnvironment,
  type ResolveStartupEnvironmentOptions
} from "./config/startup-env.js";
import { createLogger } from "./logging/logger.js";
import { redactValue } from "./logging/redact.js";
import {
  collectStartupDiagnostics,
  defaultServiceLogPath,
  defaultServiceStateFilePath
} from "./logging/startup-diagnostics.js";
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
  const startupMetadata = buildStartupConfigSourceMetadata(startupEnv);
  const diagnostics = await collectStartupDiagnostics({
    baseDir: process.cwd(),
    programData: startupEnv.env.PROGRAMDATA,
    stateFilePath: defaultServiceStateFilePath(startupEnv.env.PROGRAMDATA),
    databaseConfigured: true,
    websocketUrlConfigured: config.websocketUrl.trim().length > 0,
    dbDriver: config.database.driver,
    startupMetadata
  });

  logger.info("service.startup", {
    version: CONNECTOR_VERSION,
    dbDriver: config.database.driver,
    databaseConfigured: true,
    stateFilePath: defaultServiceStateFilePath(startupEnv.env.PROGRAMDATA),
    logPath: defaultServiceLogPath(startupEnv.env.PROGRAMDATA),
    ...startupMetadata
  });
  logger.info("configuration.loaded", {
    websocketUrl: config.websocketUrl,
    websocketUrlConfigured: config.websocketUrl.trim().length > 0,
    databaseConfigured: true,
    dbDriver: config.database.driver,
    dbHost: config.database.host,
    dbPort: config.database.port,
    dbName: config.database.name,
    dbUser: config.database.user
  });
  for (const warning of diagnostics.warnings) {
    logger.warn(warning.event, {
      dependency: warning.dependency,
      path: warning.path,
      message: warning.message
    });
  }
  logger.info("diagnostics.startup_report", { ...diagnostics.report });
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

export interface RunServiceMainOptions extends ResolveStartupEnvironmentOptions {
  keepProcessAlive?: boolean;
}

export async function waitForServiceShutdown(
  runtime: { getState(): { stopped: boolean } },
  pollIntervalMs = 1_000,
  sleep: (ms: number) => Promise<void> = sleepMs
): Promise<void> {
  while (!runtime.getState().stopped) {
    await sleep(pollIntervalMs);
  }
}

export async function runServiceMain(
  env: NodeJS.ProcessEnv = process.env,
  options: RunServiceMainOptions = {}
): Promise<number> {
  const keepProcessAlive = options.keepProcessAlive ?? process.platform === "win32";

  try {
    const startupEnv = await resolveStartupEnvironment(env, options);
    const runtime = await startConnectorRuntime({
      env: startupEnv.env,
      allowMissingDatabaseConfig: true,
      startupMetadata: buildStartupConfigSourceMetadata(startupEnv)
    });
    registerShutdownHandlers(runtime);
    if (keepProcessAlive) {
      await waitForServiceShutdown(runtime);
    }
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

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function isMainModule(metaUrl: string, argvEntry = process.argv[1]): boolean {
  if (!argvEntry) {
    return false;
  }

  const compareAsWindowsPath = isWindowsAbsolutePath(argvEntry);
  const modulePath = fileURLToPath(metaUrl);

  return normalizeEntrypointPath(modulePath, compareAsWindowsPath) === normalizeEntrypointPath(argvEntry, compareAsWindowsPath);
}

function normalizeEntrypointPath(value: string, compareAsWindowsPath: boolean): string {
  if (!compareAsWindowsPath) {
    return path.resolve(value);
  }

  const valueWithoutFileUrlLeadingSlash = value.replace(/^\/([A-Za-z]:[\\/])/, "$1");
  return path.win32.resolve(valueWithoutFileUrlLeadingSlash).toLowerCase();
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

if (isMainModule(import.meta.url)) {
  if (process.env.CONNECTOR_VALIDATE_ONLY === "1") {
    process.exitCode = await runMain(process.env);
  } else {
    process.exitCode = await runServiceMain(process.env);
  }
}
