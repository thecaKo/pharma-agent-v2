import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DatabaseDriver } from "../config/types.js";
import type { ProductFieldMappings, SyncMode } from "../mapping/types.js";

export type OnboardingFieldMapping = Required<Pick<ProductFieldMappings, "sourceProductCode" | "name" | "price" | "stock">> &
  Pick<ProductFieldMappings, "barcode" | "active" | "sourceUpdatedAt">;

export interface OnboardingMappingArtifact {
  version: "1";
  createdAt: string;
  driver: DatabaseDriver;
  databaseName: string;
  selectedProductTable: string;
  syncMode: SyncMode;
  cursorField: string;
  cursorType: "timestamp" | "number";
  incrementalQuery: string;
  batchSize: number;
  snapshotQuery?: string;
  snapshotPageSize?: number;
  fields: OnboardingFieldMapping;
}

export interface DatabaseSetupStateInput {
  artifactFilePath: string;
  driver: DatabaseDriver;
  databaseName: string;
  selectedProductTable: string;
  syncMode?: SyncMode;
  cursorField: string;
  cursorType: "timestamp" | "number";
  incrementalQuery: string;
  batchSize: number;
  snapshotQuery?: string;
  snapshotPageSize?: number;
  fields: OnboardingFieldMapping;
  createdAt?: Date | string;
  connectorToken?: string;
  databasePassword?: string;
  CONNECTOR_TOKEN?: string;
  DB_PASSWORD?: string;
}

export async function writeDatabaseSetupState(
  input: DatabaseSetupStateInput
): Promise<OnboardingMappingArtifact> {
  const artifact = buildOnboardingMappingArtifact(input);
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;

  await mkdir(dirname(input.artifactFilePath), { recursive: true });

  const tempPath = `${input.artifactFilePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, serialized, { encoding: "utf8", flag: "wx" });
    await rename(tempPath, input.artifactFilePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }

  return artifact;
}

export function buildOnboardingMappingArtifact(input: DatabaseSetupStateInput): OnboardingMappingArtifact {
  return {
    version: "1",
    createdAt: normalizeCreatedAt(input.createdAt),
    driver: input.driver,
    databaseName: input.databaseName,
    selectedProductTable: input.selectedProductTable,
    syncMode: input.syncMode ?? "incremental",
    cursorField: input.cursorField,
    cursorType: input.cursorType,
    incrementalQuery: input.incrementalQuery,
    batchSize: input.batchSize,
    snapshotQuery: input.snapshotQuery,
    snapshotPageSize: input.snapshotPageSize,
    fields: pickArtifactFields(input.fields)
  };
}

function normalizeCreatedAt(value: DatabaseSetupStateInput["createdAt"]): string {
  if (typeof value === "string") {
    return value;
  }

  return (value ?? new Date()).toISOString();
}

function pickArtifactFields(fields: DatabaseSetupStateInput["fields"]): OnboardingMappingArtifact["fields"] {
  return {
    sourceProductCode: fields.sourceProductCode,
    name: fields.name,
    price: fields.price,
    stock: fields.stock,
    ...(fields.barcode ? { barcode: fields.barcode } : {}),
    ...(fields.active ? { active: fields.active } : {}),
    ...(fields.sourceUpdatedAt ? { sourceUpdatedAt: fields.sourceUpdatedAt } : {})
  };
}
