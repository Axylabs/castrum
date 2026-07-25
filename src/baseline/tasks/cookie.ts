import { decoder } from "../../shared/bytes";
import { packPairs } from "../../shared/packed";

export function nativeCookieParsePacked(bytes: Uint8Array): Uint8Array {
  const text = decoder.decode(bytes);
  const pairs: Array<[string, string]> = [];

  for (const rawPair of text.split(";")) {
    const pair = rawPair.trim();
    if (pair.length === 0) continue;

    const eq = pair.indexOf("=");
    const name = (eq >= 0 ? pair.slice(0, eq) : pair).trim();
    const value = eq >= 0 ? pair.slice(eq + 1).trim() : "";

    if (name.length === 0) continue;

    pairs.push([name, value]);
  }

  return packPairs(pairs);
}