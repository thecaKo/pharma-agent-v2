import { ReadOnlySqlError } from "./readonly-sql.js";

export type ProvisionOutcome =
  | "provisioned"
  | "fallback_no_privilege"
  | "unsupported_engine"
  | "error";

export interface ProvisionReadonlyUserInput {
  username: string;
  password: string;
}

// Padrão único de username read-only, compartilhado entre a AiSession
// (propose_readonly_user) e os adapters. É o padrão mais restritivo: deve iniciar
// com letra, conter apenas [a-zA-Z0-9_] (sem `$`, sem início numérico) e ter de 3 a
// 63 caracteres. Mantido aqui como fonte de verdade para evitar divergências.
export const READONLY_USERNAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{2,62}$/;

export function isValidReadonlyUsername(username: string): boolean {
  return READONLY_USERNAME_PATTERN.test(username);
}

// Valida o username read-only nos adapters antes de quotá-lo no SQL de provisão.
// Lança ReadOnlySqlError (mesma classe usada nas validações de identificador dos
// adapters) para um comportamento de rejeição consistente entre engines.
export function validateReadonlyUsername(username: string): void {
  if (!READONLY_USERNAME_PATTERN.test(username)) {
    throw new ReadOnlySqlError(`username read-only inválido: ${username}`);
  }
}

export interface ProvisionReadonlyUserResult {
  outcome: Extract<ProvisionOutcome, "provisioned" | "fallback_no_privilege">;
  grantedScope: "all_tables";
}

// Erro interno que sinaliza privilégio insuficiente, mapeado por engine.
// O orquestrador converte em outcome "fallback_no_privilege".
export class NoPrivilegeError extends Error {
  public constructor(message = "no privilege to provision read-only user") {
    super(message);
    this.name = "NoPrivilegeError";
  }
}
