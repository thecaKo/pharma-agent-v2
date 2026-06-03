export type ProvisionOutcome =
  | "provisioned"
  | "fallback_no_privilege"
  | "unsupported_engine"
  | "error";

export interface ProvisionReadonlyUserInput {
  username: string;
  password: string;
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
