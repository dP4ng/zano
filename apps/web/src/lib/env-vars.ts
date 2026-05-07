export type EnvVars = Record<string, string>;

export interface EnvVarEntry {
  id: string;
  key: string;
  value: string;
}

export function isEnvVarKey(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

export function normalizeEnvVars(value: unknown): EnvVars | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const envVars: EnvVars = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (!isEnvVarKey(key) || typeof rawValue !== "string") {
      return null;
    }
    envVars[key] = rawValue;
  }
  return envVars;
}

export function createEnvVarEntry(key = "", value = ""): EnvVarEntry {
  return {
    id:
      globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    key,
    value,
  };
}

export function envRecordToEntries(envVars: EnvVars): EnvVarEntry[] {
  return Object.entries(envVars).map(([key, value]) =>
    createEnvVarEntry(key, value)
  );
}

export function envEntriesToRecord(entries: EnvVarEntry[]): EnvVars {
  const envVars: EnvVars = {};
  for (const entry of entries) {
    const key = entry.key.trim();
    if (!key) continue;
    envVars[key] = entry.value;
  }
  return envVars;
}
