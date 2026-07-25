import { decoder } from "../../shared/bytes";
import { packPairs } from "../../shared/packed";

export function nativeQueryParse(bytes: Uint8Array): Uint8Array {
  const query = decoder.decode(bytes);
  const sp = new URLSearchParams(query);

  const obj: Record<string, string | string[]> = {};
  for (const key of new Set(sp.keys())) {
    const values = sp.getAll(key);
    obj[key] = values.length === 1 ? (values[0] ?? "") : values;
  }

  return encoder.encode(JSON.stringify(obj));
}

export function nativeQueryParsePacked(bytes: Uint8Array): Uint8Array {
  const query = decoder.decode(bytes);
  const sp = new URLSearchParams(query);

  const pairs: Array<[string, string]> = [];
  for (const [key, value] of sp.entries()) {
    pairs.push([key, value]);
  }

  return packPairs(pairs);
}

import { encoder } from "../../shared/bytes";