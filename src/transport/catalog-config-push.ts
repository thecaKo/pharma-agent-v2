import type { CursorType, SyncMode } from "../mapping/types.js";

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
export const CATALOG_POLL_INTERVAL_MS = 10_000;
export const CATALOG_BATCH_SIZE = 500;

interface AgentFieldMapping {
  sourceProductCode: string;
  name: string;
  price?: string;
  stock?: string;
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
    if (typeof message.connectorId === "string" && typeof message.mapping === "object" && message.mapping !== null) {
      return normalizeFlatConnectorConfigMessage(message);
    }
    return message;
  }

  if (typeof message.connectorId === "string" && typeof message.mapping === "object" && message.mapping !== null) {
    return normalizeFlatConnectorConfigMessage(message);
  }

  const catalog = config as Record<string, unknown>;
  const catalogMapping =
    typeof catalog.mapping === "object" && catalog.mapping !== null && !Array.isArray(catalog.mapping)
      ? (catalog.mapping as Record<string, unknown>)
      : {};

  const incrementalQuery =
    typeof catalogMapping.incrementalQuery === "string" ? catalogMapping.incrementalQuery.trim() : "";
  const syncMode = resolveSyncMode(catalog, catalogMapping);
  const snapshotQuery =
    typeof catalogMapping.snapshotQuery === "string" ? catalogMapping.snapshotQuery.trim() : "";
  const snapshotPageSize = normalizeRuntimeNumber(catalogMapping.snapshotPageSize, CATALOG_BATCH_SIZE);
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
      syncMode,
      pollIntervalMs: normalizeRuntimeNumber(catalogMapping.pollIntervalMs, CATALOG_POLL_INTERVAL_MS),
      batchSize: normalizeRuntimeNumber(catalogMapping.batchSize, CATALOG_BATCH_SIZE),
      incrementalQuery,
      cursorField,
      // Ausente vira undefined; só inclui a chave quando há valor (alias coagido,
      // válido ou lixo cru a ser rejeitado pelo validate).
      ...(cursorType !== undefined ? { cursorType } : {}),
      snapshotQuery,
      snapshotPageSize,
      fields
    }
  };
}

function normalizeFlatConnectorConfigMessage(message: Record<string, unknown>): Record<string, unknown> {
  const mapping = message.mapping as Record<string, unknown>;
  const syncMode = resolveSyncMode({}, mapping);
  const normalizedMapping: Record<string, unknown> = {
    ...mapping,
    syncMode,
    pollIntervalMs: normalizeRuntimeNumber(mapping.pollIntervalMs, CATALOG_POLL_INTERVAL_MS),
    batchSize: normalizeRuntimeNumber(mapping.batchSize, CATALOG_BATCH_SIZE),
    snapshotPageSize: normalizeRuntimeNumber(mapping.snapshotPageSize, CATALOG_BATCH_SIZE)
  };

  if (syncMode === "snapshot") {
    // O validador rejeita cursorType/cursorField presentes em snapshot.
    delete normalizedMapping.cursorType;
    delete normalizedMapping.cursorField;
  } else {
    // Incremental: mesmo contrato do caminho config-wrapped — coage alias de banco
    // (updated_at/composite→timestamp, incrementing→number), preserva válido e deixa
    // lixo cru passar para o validate rejeitar. Não inventa default na ausência.
    const cursorType = resolveCursorType({}, mapping);
    if (cursorType !== undefined) {
      normalizedMapping.cursorType = cursorType;
    } else {
      delete normalizedMapping.cursorType;
    }
  }

  return {
    ...message,
    mapping: normalizedMapping
  };
}

function resolveSyncMode(catalog: Record<string, unknown>, catalogMapping: Record<string, unknown>): SyncMode {
  const raw = readNonEmptyString(catalogMapping.syncMode) ?? readNonEmptyString(catalog.syncMode) ?? "";
  return raw === "snapshot" ? "snapshot" : "incremental";
}

function normalizeRuntimeNumber(value: unknown, normalizedValue: number): unknown {
  // Inteiro positivo válido é preservado; ausente ou inválido (null, 0, negativo,
  // float, string) cai no default.
  if (Number.isInteger(value) && (value as number) > 0) {
    return value;
  }
  return normalizedValue;
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

function resolveCursorType(
  catalog: Record<string, unknown>,
  catalogMapping: Record<string, unknown>
): string | undefined {
  const raw = readNonEmptyString(catalog.cursorType) ?? readNonEmptyString(catalogMapping.cursorType);

  // Ausente: não inventa default. Em incremental o validate já rejeita a ausência;
  // em snapshot o cursorType é removido a montante.
  if (raw === undefined) {
    return undefined;
  }

  // Já no vocabulário do agente: passa inalterado.
  if (AGENT_CURSOR_TYPES.has(raw)) {
    return raw;
  }

  // Alias de banco conhecido: coage para o vocabulário do agente.
  const mapped = CATALOG_CURSOR_TYPE_TO_AGENT[raw];
  if (mapped) {
    return mapped;
  }

  // Desconhecido/lixo (ex.: "timestamptz", "uuid"): deixa cru para o validate a
  // jusante rejeitar e o agente emitir connector.error — não chuta a semântica do
  // cursor (timestamp×number), o que corromperia o sync incremental em silêncio.
  return raw;
}

export function parseCursorFieldFromIncrementalQuery(sql: string): string | undefined {
  // MySQL/MariaDB: identificador entre backticks e placeholder posicional "?".
  const mysqlMatch = sql.match(/WHERE\s+`([^`]+)`\s*>\s*\?/i);
  if (mysqlMatch?.[1]) {
    return mysqlMatch[1].trim();
  }

  // PostgreSQL: identificador entre aspas duplas e placeholder posicional "$1".
  const postgresMatch = sql.match(/WHERE\s+"([^"]+)"\s*>\s*\$\d+/i);
  return postgresMatch?.[1]?.trim();
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}
