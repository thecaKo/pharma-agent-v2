import { describe, expect, it } from "vitest";
import {
  getInstallerServiceMetadata,
  INSTALLER_COMPLETION_DATABASE_ONBOARDING_COMMAND,
  INSTALLER_COMPLETION_DATABASE_ONBOARDING_HINT,
  INSTALLER_FORBIDDEN_WIZARD_PROPERTIES,
  INSTALLER_SERVICE_DISPLAY_NAME,
  INSTALLER_SERVICE_ENTRYPOINT,
  INSTALLER_SERVICE_NAME,
  INSTALLER_SERVICE_START_MODE,
  INSTALLER_WIZARD_PROPERTIES
} from "../../src/installer/metadata.js";

describe("installer metadata", () => {
  it("defines the connector service identity", () => {
    expect(INSTALLER_SERVICE_NAME).toBe("PharmaAgentConnector");
    expect(INSTALLER_SERVICE_DISPLAY_NAME).toBe("Pharma Agent Connector");
    expect(INSTALLER_SERVICE_START_MODE).toBe("automatic");
    expect(INSTALLER_SERVICE_ENTRYPOINT).toBe("dist/main.js");
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
    expect(metadata.recoveryResetPeriodSeconds).toBe(86_400);
    expect(metadata.recoveryRestartDelayMilliseconds).toBe(60_000);
  });
});
