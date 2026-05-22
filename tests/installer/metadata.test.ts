import { describe, expect, it } from "vitest";
import {
  getInstallerServiceMetadata,
  INSTALLER_COMPLETION_DATABASE_ONBOARDING_COMMAND,
  INSTALLER_COMPLETION_DATABASE_ONBOARDING_HINT,
  INSTALLER_FORBIDDEN_WIZARD_PROPERTIES,
  INSTALLER_NODE_EXECUTABLE,
  INSTALLER_SERVICE_DISPLAY_NAME,
  INSTALLER_SERVICE_ENTRYPOINT,
  INSTALLER_SERVICE_NAME,
  INSTALLER_SERVICE_START_MODE,
  INSTALLER_WINSW_CONFIGURATION_FILE,
  INSTALLER_WINSW_EXECUTABLE,
  INSTALLER_WIZARD_PROPERTIES,
  renderInstallerWinSwConfiguration
} from "../../src/installer/metadata.js";

describe("installer metadata", () => {
  it("defines the connector service identity", () => {
    expect(INSTALLER_SERVICE_NAME).toBe("PharmaAgentConnector");
    expect(INSTALLER_SERVICE_DISPLAY_NAME).toBe("Pharma Agent Connector");
    expect(INSTALLER_SERVICE_START_MODE).toBe("automatic");
    expect(INSTALLER_SERVICE_ENTRYPOINT).toBe("dist/main.js");
    expect(INSTALLER_NODE_EXECUTABLE).toBe("node.exe");
    expect(INSTALLER_WINSW_EXECUTABLE).toBe("PharmaAgentConnector.Service.exe");
    expect(INSTALLER_WINSW_CONFIGURATION_FILE).toBe("PharmaAgentConnector.Service.xml");
  });

  it("limits wizard properties to central installer-managed settings", () => {
    expect(INSTALLER_WIZARD_PROPERTIES).toEqual(["CONNECTOR_TOKEN", "CONNECTOR_WS_URL"]);
    expect(INSTALLER_FORBIDDEN_WIZARD_PROPERTIES).toContain("DB_PASSWORD");
  });

  it("documents database onboarding completion guidance", () => {
    expect(INSTALLER_COMPLETION_DATABASE_ONBOARDING_HINT).toContain("database setup flow");
    expect(INSTALLER_COMPLETION_DATABASE_ONBOARDING_COMMAND).toBe("npm run database-setup");
  });

  it("exposes metadata aligned with ProgramData config naming", () => {
    const metadata = getInstallerServiceMetadata();

    expect(metadata.programDataDirName).toBe("PharmaAgentConnector");
    expect(metadata.programDataConfigFileName).toBe("connector-config.json");
    expect(metadata.programDataLogDirName).toBe("logs");
    expect(metadata.serviceWrapperExecutable).toBe("PharmaAgentConnector.Service.exe");
    expect(metadata.serviceWrapperConfigurationFile).toBe("PharmaAgentConnector.Service.xml");
    expect(metadata.recoveryResetPeriodSeconds).toBe(86_400);
    expect(metadata.recoveryRestartDelayMilliseconds).toBe(60_000);
    expect(metadata.logSizeThresholdKb).toBe(10 * 1024);
    expect(metadata.logKeepFiles).toBe(10);
  });

  it("renders a WinSW configuration that wraps node.exe and writes ProgramData logs", () => {
    const xml = renderInstallerWinSwConfiguration();

    expect(xml).toContain("<executable>%BASE%\\node.exe</executable>");
    expect(xml).toContain("<arguments>&quot;%BASE%\\dist\\main.js&quot;</arguments>");
    expect(xml).toContain("<workingdirectory>%BASE%</workingdirectory>");
    expect(xml).toContain("<logpath>%ProgramData%\\PharmaAgentConnector\\logs</logpath>");
    expect(xml).toContain('<log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>10</keepFiles></log>');
    expect(xml).toContain('<onfailure action="restart" delay="60 sec" />');
    expect(xml).toContain("<resetfailure>1 day</resetfailure>");
  });
});
