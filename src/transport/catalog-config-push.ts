import type { CursorType } from "../mapping/types.js";

const CATALOG_FIELD_TO_AGENT: Readonly<Record<string, keyof AgentFieldMapping>> = {
  sourceProductCode: "sourceProductCode",
  sourceProductName: "name",
  sourceProductPrice: "price",
  sourceProductStock: "stock",
  sourceProductBarcode: "barcode",
  sourceProductActive: "active",
  sourceProductUpdatedAt: "sourceUpdatedAt"
};

const CATALOG_CURSOR_TYPE_TO_AGENT: Readonly<Record<string, CursorType>> = {
  updated_at: "timestamp",
  composite: "timestamp",
  incrementing: "number"
};

const AGENT_CURSOR_TYPES = new Set<string>(["timestamp", "number"]);
const ALIASED_QUERY_MARKER = /AS\s+`sourceProductCode`/i;

interface AgentFieldMapping {
  sourceProductCode: string;
  name: string;
  price: string;
  stock: string;
  barcode?: string;
  active?: string;
  sourceUpdatedAt?: string;
}

/**
 * Normalizes neo-api catalog activation push `{ type, config }` into the flat
 * connector.config shape expected by parseConnectorConfig.
 */
export function normalizeCatalogConfigPushMessage(message: Record<string, unknown>): Record<string, unknown> {
  const config = message.config;
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return message;
  }

  if (typeof message.connectorId === "string" && typeof message.mapping === "object" && message.mapping !== null) {
    return message;
  }

  const catalog = config as Record<string, unknown>;
  const catalogMapping =
    typeof catalog.mapping === "object" && catalog.mapping !== null && !Array.isArray(catalog.mapping)
      ? (catalog.mapping as Record<string, unknown>)
      : {};

  const incrementalQuery =
    typeof catalogMapping.incrementalQuery === "string" ? catalogMapping.incrementalQuery.trim() : "";
  const catalogFields = readCatalogFields(catalog.fields);
  const usesAliasedSelect = ALIASED_QUERY_MARKER.test(incrementalQuery);
  const fields = buildAgentFields(catalogFields, usesAliasedSelect);
  const cursorField = resolveCursorField({
    catalog,
    catalogMapping,
    catalogFields,
    incrementalQuery,
    usesAliasedSelect
  });
  const cursorType = resolveCursorType(catalog, catalogMapping);

  return {
    type: message.type ?? "connector.config",
    connectorId: catalog.connectorId,
    customerId: catalog.customerId,
    sentAt: message.sentAt,
    mapping: {
      mappingVersion: catalogMapping.mappingVersion,
      selectedProductTable: catalog.selectedProductTable,
      pollIntervalMs: catalogMapping.pollIntervalMs,
      batchSize: catalogMapping.batchSize,
      incrementalQuery,
      cursorField,
      cursorType,
      fields
    }
  };
}

function readCatalogFields(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  const fields: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string" && raw.trim().length > 0) {
      fields[key] = raw.trim();
    }
  }
  return fields;
}

function buildAgentFields(catalogFields: Record<string, string>, usesAliasedSelect: boolean): AgentFieldMapping {
  const fields: Partial<AgentFieldMapping> = {};

  for (const [catalogKey, agentKey] of Object.entries(CATALOG_FIELD_TO_AGENT)) {
    const column = catalogFields[catalogKey];
    if (!column) {
      continue;
    }
    fields[agentKey] = usesAliasedSelect ? catalogKey : column;
  }

  return fields as AgentFieldMapping;
}

function resolveCursorField(input: {
  catalog: Record<string, unknown>;
  catalogMapping: Record<string, unknown>;
  catalogFields: Record<string, string>;
  incrementalQuery: string;
  usesAliasedSelect: boolean;
}): string {
  const explicit = readNonEmptyString(input.catalog.cursorField) ?? readNonEmptyString(input.catalogMapping.cursorField);
  if (explicit) {
    return explicit;
  }

  if (input.usesAliasedSelect && input.catalogFields.sourceProductUpdatedAt) {
    return "sourceProductUpdatedAt";
  }

  const fromQuery = parseCursorFieldFromIncrementalQuery(input.incrementalQuery);
  if (fromQuery) {
    return input.usesAliasedSelect && input.catalogFields.sourceProductUpdatedAt
      ? "sourceProductUpdatedAt"
      : fromQuery;
  }

  return "";
}

function resolveCursorType(catalog: Record<string, unknown>, catalogMapping: Record<string, unknown>): CursorType {
  const raw =
    readNonEmptyString(catalog.cursorType) ??
    readNonEmptyString(catalogMapping.cursorType) ??
    "";

  if (AGENT_CURSOR_TYPES.has(raw)) {
    return raw as CursorType;
  }

  const mapped = CATALOG_CURSOR_TYPE_TO_AGENT[raw];
  if (mapped) {
    return mapped;
  }

  return "timestamp";
}

function parseCursorFieldFromIncrementalQuery(sql: string): string | undefined {
  const match = sql.match(/WHERE\s+`([^`]+)`\s*>\s*\?/i);
  return match?.[1]?.trim();
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}
