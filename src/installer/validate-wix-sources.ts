import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  getInstallerServiceMetadata,
  INSTALLER_COMPLETION_DATABASE_ONBOARDING_COMMAND,
  INSTALLER_COMPLETION_DATABASE_ONBOARDING_HINT,
  INSTALLER_FORBIDDEN_WIZARD_PROPERTIES,
  INSTALLER_SERVICE_ENTRYPOINT,
  INSTALLER_SERVICE_ENTRYPOINT_WINDOWS,
  INSTALLER_WIZARD_PROPERTIES,
  type InstallerServiceMetadata
} from "./metadata.js";

export interface WixSourceValidationResult {
  sources: string[];
  combinedSource: string;
}

export async function loadWixSources(installerDirectory: string): Promise<WixSourceValidationResult> {
  const entries = await readdir(installerDirectory, { withFileTypes: true });
  const wxsFiles = entries
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".wxs") || entry.name.endsWith(".wxi")))
    .map((entry) => join(installerDirectory, entry.name))
    .sort();

  const sources = await Promise.all(wxsFiles.map((path) => readFile(path, "utf8")));
  return {
    sources: wxsFiles,
    combinedSource: sources.join("\n")
  };
}

export function validateWixServiceMetadata(
  combinedSource: string,
  metadata: InstallerServiceMetadata = getInstallerServiceMetadata()
): string[] {
  const errors: string[] = [];

  if (!combinedSource.includes(metadata.serviceName)) {
    errors.push(`missing service name ${metadata.serviceName}`);
  }

  if (!combinedSource.includes(metadata.displayName)) {
    errors.push(`missing display name ${metadata.displayName}`);
  }

  if (!combinedSource.includes('Start="auto"') && !combinedSource.includes('Start="automatic"')) {
    errors.push("missing automatic service startup semantics");
  }

  if (
    !combinedSource.includes(metadata.entrypointRelativePath) &&
    !combinedSource.includes(metadata.entrypointWindowsRelativePath)
  ) {
    errors.push(`missing packaged entrypoint ${metadata.entrypointRelativePath}`);
  }

  if (!combinedSource.includes("<ServiceInstall")) {
    errors.push("missing ServiceInstall element");
  }

  if (!combinedSource.includes("<ServiceControl")) {
    errors.push("missing ServiceControl element");
  }

  return errors;
}

export function validateWixWizardScope(combinedSource: string): string[] {
  const errors: string[] = [];

  for (const propertyName of INSTALLER_WIZARD_PROPERTIES) {
    if (!combinedSource.includes(propertyName)) {
      errors.push(`missing wizard property ${propertyName}`);
    }
  }

  for (const forbiddenProperty of INSTALLER_FORBIDDEN_WIZARD_PROPERTIES) {
    if (combinedSource.includes(`Id="${forbiddenProperty}"`)) {
      errors.push(`forbidden wizard property ${forbiddenProperty}`);
    }
  }

  if (!combinedSource.includes('Secure="yes"') && !combinedSource.includes("Secure=\"yes\"")) {
    errors.push("missing secure connector token property");
  }

  if (
    combinedSource.includes('Password="yes"') === false &&
    combinedSource.includes('Type="Password"') === false
  ) {
    errors.push("missing masked connector token control");
  }

  if (combinedSource.includes(INSTALLER_COMPLETION_DATABASE_ONBOARDING_HINT) === false) {
    errors.push("missing database onboarding completion guidance");
  }

  if (combinedSource.includes(INSTALLER_COMPLETION_DATABASE_ONBOARDING_COMMAND) === false) {
    errors.push("missing database onboarding command guidance");
  }

  return errors;
}

export function validateWixProgramDataConfigAuthoring(combinedSource: string): string[] {
  const errors: string[] = [];
  const metadata = getInstallerServiceMetadata();

  if (!combinedSource.includes(metadata.programDataConfigFileName)) {
    errors.push(`missing ProgramData config file name ${metadata.programDataConfigFileName}`);
  }

  if (!combinedSource.includes(metadata.programDataDirName)) {
    errors.push(`missing ProgramData directory name ${metadata.programDataDirName}`);
  }

  if (!combinedSource.includes("WriteProgramDataConfig")) {
    errors.push("missing ProgramData config custom action");
  }

  return errors;
}

export function assertWixMetadataValid(combinedSource: string): void {
  const errors = [
    ...validateWixServiceMetadata(combinedSource),
    ...validateWixWizardScope(combinedSource),
    ...validateWixProgramDataConfigAuthoring(combinedSource)
  ];

  if (errors.length > 0) {
    throw new Error(`WiX installer metadata validation failed: ${errors.join("; ")}`);
  }
}
