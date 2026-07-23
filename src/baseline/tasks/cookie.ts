import { parse as parseCookie } from "cookie-es";
import { decoder, encoder } from "../../shared/bytes";

export function nativeCookieParse(bytes: Uint8Array): Uint8Array {
  const text = decoder.decode(bytes);
  const cookies = parseCookie(text);
  return encoder.encode(JSON.stringify(cookies));
}
