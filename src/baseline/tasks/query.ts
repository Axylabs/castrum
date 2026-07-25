import { decoder } from "../../shared/bytes";
import { packPairs } from "../../shared/packed";

export function nativeQueryParsePacked(bytes: Uint8Array): Uint8Array {
  const query = decoder.decode(bytes);
  const sp = new URLSearchParams(query);

  const pairs: Array<[string, string]> = [];
  for (const [key, value] of sp.entries()) {
    pairs.push([key, value]);
  }

  return packPairs(pairs);
}