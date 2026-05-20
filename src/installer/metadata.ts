import {
  CONNECTOR_CONFIG_FILE_NAME,
  INSTALLER_CONFIG_DIR_NAME
} from "../config/programdata-config.js";

export const INSTALLER_SERVICE_NAME = "PharmaAgentConnector";
export const INSTALLER_SERVICE_DISPLAY_NAME = "Pharma Agent Connector";
export const INSTALLER_SERVICE_DESCRIPTION =
  "Outbound-only local connector for Pharma Agent product synchronization.";
export const INSTALLER_SERVICE_START_MODE = "automatic";
export const INSTALLER_SERVICE_ENTRYPOINT = "dist/main.js";
export const INSTALLER_SERVICE_ENTRYPOINT_WINDOWS = "dist\\main.js";
export const INSTALLER_NODE_EXECUTABLE = "node.exe";
export const INSTALLER_PROGRAM_DATA_DIR_NAME = INSTALLER_CONFIG_DIR_NAME;
export const INSTALLER_PROGRAM_DATA_CONFIG_FILE_NAME = CONNECTOR_CONFIG_FILE_NAME;
export const INSTALLER_WIZARD_PROPERTIES = ["CONNECTOR_TOKEN", "CONNECTOR_WS_URL"] as const;
export const INSTALLER_FORBIDDEN_WIZARD_PROPERTIES = [
  "DB_PASSWORD",
  "DB_HOST",
  "DB_PORT",
  "DB_NAME",
  "DB_USER",
  "DB_DRIVER"
] as const;
export const INSTALLER_SERVICE_RECOVERY_RESET_PERIOD_SECONDS = 86_400;
export const INSTALLER_SERVICE_RECOVERY_RESTART_DELAY_MS = 60_000;
export const INSTALLER_COMPLETION_DATABASE_ONBOARDING_HINT =
  "Database connection, table selection, and field mapping still use the existing database setup flow.";
export const INSTALLER_COMPLETION_DATABASE_ONBOARDING_COMMAND = "npm run database-setup";

export interface InstallerServiceMetadata {
  serviceName: string;
  displayName: string;
  description: string;
  startMode: string;
  entrypointRelativePath: string;
  entrypointWindowsRelativePath: string;
  nodeExecutable: string;
  programDataDirName: string;
  programDataConfigFileName: string;
  recoveryResetPeriodSeconds: number;
  recoveryRestartDelayMilliseconds: number;
}

export function getInstallerServiceMetadata(): InstallerServiceMetadata {
  return {
    serviceName: INSTALLER_SERVICE_NAME,
    displayName: INSTALLER_SERVICE_DISPLAY_NAME,
    description: INSTALLER_SERVICE_DESCRIPTION,
    startMode: INSTALLER_SERVICE_START_MODE,
    entrypointRelativePath: INSTALLER_SERVICE_ENTRYPOINT,
    entrypointWindowsRelativePath: INSTALLER_SERVICE_ENTRYPOINT_WINDOWS,
    nodeExecutable: INSTALLER_NODE_EXECUTABLE,
    programDataDirName: INSTALLER_PROGRAM_DATA_DIR_NAME,
    programDataConfigFileName: INSTALLER_PROGRAM_DATA_CONFIG_FILE_NAME,
    recoveryResetPeriodSeconds: INSTALLER_SERVICE_RECOVERY_RESET_PERIOD_SECONDS,
    recoveryRestartDelayMilliseconds: INSTALLER_SERVICE_RECOVERY_RESTART_DELAY_MS
  };
}
