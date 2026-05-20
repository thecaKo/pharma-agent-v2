import { readFile } from "node:fs/promises";
import type { MappingConfig, ProductFieldMappings, ValidatedMappingConfig } from "../mapping/types.js";
import { validateMappingConfig } from "../mapping/validate.js";

export const LOCAL_ONBOARDING_MAPPING_VERSION = "local-onboarding-v1";
export const DEFAULT_ONBOARDING_ARTIFACT_POLL_INTERVAL_MS = 10_000;

export class OnboardingArtifactError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OnboardingArtifactError";
  }
}

export async function loadValidatedMappingFromOnboardingArtifactFile(
  artifactFilePath: string
): Promise<ValidatedMappingConfig> {
  let raw: string;
  try {
    raw = await readFile(artifactFilePath, "utf8");
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
    if (code === "ENOENT") {
      throw new OnboardingArtifactError(
        "No onboarding mapping artifact was found. Run the interactive database setup CLI to create it before starting the mock."
      );
    }
    throw new OnboardingArtifactError("Could not read the onboarding mapping artifact file.");
  }

  const parsed = parseArtifactJson(raw);
  assertOnboardingArtifactV1(parsed);
  const mapping = artifactV1ToMappingConfig(parsed);
  return validateMappingConfig(mapping);
}

function parseArtifactJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new OnboardingArtifactError("The onboarding mapping file is not valid JSON.");
  }
}

function assertOnboardingArtifactV1(parsed: unknown): asserts parsed is Record<string, unknown> {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OnboardingArtifactError("The onboarding mapping file has an invalid structure.");
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== "1") {
    throw new OnboardingArtifactError("The onboarding mapping file is not a supported artifact version.");
  }
}

function artifactV1ToMappingConfig(record: Record<string, unknown>): MappingConfig {
  const fieldsRaw = record.fields;
  if (!fieldsRaw || typeof fieldsRaw !== "object" || Array.isArray(fieldsRaw)) {
    throw new OnboardingArtifactError("The onboarding mapping file is missing field mapping metadata.");
  }
  const fieldsRecord = fieldsRaw as Record<string, unknown>;

  const cursorType = record.cursorType === "timestamp" || record.cursorType === "number" ? record.cursorType : undefined;

  const batchSize = typeof record.batchSize === "number" ? record.batchSize : Number.NaN;

  const fields: ProductFieldMappings = {
    sourceProductCode: optionalTrimmedField(fieldsRecord, "sourceProductCode"),
    name: optionalTrimmedField(fieldsRecord, "name"),
    price: optionalTrimmedField(fieldsRecord, "price"),
    stock: optionalTrimmedField(fieldsRecord, "stock"),
    barcode: optionalTrimmedField(fieldsRecord, "barcode"),
    active: optionalTrimmedField(fieldsRecord, "active"),
    sourceUpdatedAt: optionalTrimmedField(fieldsRecord, "sourceUpdatedAt")
  };

  return {
    mappingVersion: LOCAL_ONBOARDING_MAPPING_VERSION,
    pollIntervalMs: DEFAULT_ONBOARDING_ARTIFACT_POLL_INTERVAL_MS,
    selectedProductTable: optionalTrimmedField(record, "selectedProductTable"),
    batchSize,
    incrementalQuery: typeof record.incrementalQuery === "string" ? record.incrementalQuery : "",
    cursorField: typeof record.cursorField === "string" ? record.cursorField : "",
    cursorType,
    fields
  };
}

function optionalTrimmedField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
