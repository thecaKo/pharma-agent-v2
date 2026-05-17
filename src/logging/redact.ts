const REDACTED = "[REDACTED]";

export function redactValue(value: unknown, secrets: readonly string[] = []): unknown {
  const activeSecrets = secrets.filter((secret) => secret.length > 0);

  if (typeof value === "string") {
    return redactString(value, activeSecrets);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, activeSecrets));
  }

  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        isSecretKey(key) ? REDACTED : redactValue(entry, activeSecrets)
      ])
    );
  }

  return value;
}

export function redactString(value: string, secrets: readonly string[] = []): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce((current, secret) => current.split(secret).join(REDACTED), value);
}

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.includes("token") || normalized.includes("password");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
