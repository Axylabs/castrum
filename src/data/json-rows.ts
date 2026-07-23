import { encoder } from "../shared/bytes";

export interface JsonRowNested {
  version: number;
  createdAt: string;
}

export interface JsonRow {
  id: number;
  name: string;
  active: boolean;
  score: number;
  tags: string[];
  nested: JsonRowNested;
}

export function createJsonRows(rows: number): JsonRow[] {
  return Array.from({ length: rows }, (_, i) => ({
    id: i,
    name: `user_${i}`,
    active: i % 2 === 0,
    score: i * 1.25,
    tags: ["alpha", "beta", "gamma"],
    nested: {
      version: i % 10,
      createdAt: "2026-01-01T00:00:00Z",
    },
  }));
}

export function jsonRowsBytes(rows: number): Uint8Array {
  return encoder.encode(JSON.stringify(createJsonRows(rows)));
}
