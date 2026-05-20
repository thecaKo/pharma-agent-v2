import { config as loadDotEnvFile } from "dotenv";
import {
  loadProgramDataConfig,
  mergeInstallerConfigWithEnvironment,
  type InstallerManagedConfig,
  type InstallerManagedConfigKey
} from "./programdata-config.js";

export type ConfigSourceKind = "environment" | "programdata" | "unset";

export interface InstallerManagedConfigSources {
  CONNECTOR_TOKEN: ConfigSourceKind;
  CONNECTOR_WS_URL: ConfigSourceKind;
  LOG_LEVEL: ConfigSourceKind;
}

export interface StartupEnvironmentResult {
  env: NodeJS.ProcessEnv;
  programDataFound: boolean;
  programDataPath: string;
  installerManagedSources: InstallerManagedConfigSources;
}

export interface ResolveStartupEnvironmentOptions {
  configFilePath?: string;
}

export async function resolveStartupEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveStartupEnvironmentOptions = {}
): Promise<StartupEnvironmentResult> {
  const usesProcessEnv = env === process.env;
  if (usesProcessEnv) {
    loadDotEnvFile();
  }

  const explicitEnv = usesProcessEnv ? process.env : env;
  const programData = await loadProgramDataConfig({
    configFilePath: options.configFilePath
  });
  const merged = mergeInstallerConfigWithEnvironment(programData.values, explicitEnv);

  return {
    env: merged,
    programDataFound: programData.found,
    programDataPath: programData.path,
    installerManagedSources: {
      CONNECTOR_TOKEN: resolveInstallerKeySource("CONNECTOR_TOKEN", programData.values, explicitEnv),
      CONNECTOR_WS_URL: resolveInstallerKeySource("CONNECTOR_WS_URL", programData.values, explicitEnv),
      LOG_LEVEL: resolveInstallerKeySource("LOG_LEVEL", programData.values, explicitEnv)
    }
  };
}

export function buildStartupConfigSourceMetadata(
  result: Pick<StartupEnvironmentResult, "programDataFound" | "programDataPath" | "installerManagedSources">
): Record<string, string | boolean> {
  return {
    programDataConfigFound: result.programDataFound,
    programDataConfigPath: result.programDataPath,
    authCredentialSource: result.installerManagedSources.CONNECTOR_TOKEN,
    websocketUrlSource: result.installerManagedSources.CONNECTOR_WS_URL,
    logLevelSource: result.installerManagedSources.LOG_LEVEL
  };
}

function resolveInstallerKeySource(
  key: InstallerManagedConfigKey,
  fileValues: InstallerManagedConfig,
  explicitEnv: NodeJS.ProcessEnv
): ConfigSourceKind {
  if (hasExplicitEnvValue(explicitEnv, key)) {
    return "environment";
  }

  const fileValue = fileValues[key];
  if (fileValue !== undefined && String(fileValue).trim().length > 0) {
    return "programdata";
  }

  return "unset";
}

function hasExplicitEnvValue(env: NodeJS.ProcessEnv, key: string): boolean {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0;
}
