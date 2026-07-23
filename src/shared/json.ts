export function parseJson<T = unknown>(text: string): T {
  return JSON.parse(text) as T;
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

export function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};

  for (const key of Object.keys(record).sort()) {
    sorted[key] = sortKeys(record[key]);
  }

  return sorted;
}
