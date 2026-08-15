// src/shared/packed/parsers.ts — High-level string parsers (convenience).
//
// Wrap the native packed parsers + decoders for ergonomic use, so consumers
// don't have to hand-pack buffers or decode packed pairs:
//   parseQueryString("a=1&b=2")    // { a: "1", b: "2" }
//   parseCookieHeader("a=1; b=2")  // { a: "1", b: "2" }

import { getAddon, lazyAddon } from '../../native'
import { encoder } from '../bytes'
import { pairsToObject, readPairsPacked } from './wire'

// Lazy: importing this module does not dlopen the addon until first use.
const addon = lazyAddon(getAddon)

/** Parse a query string (`a=1&b=2`) into an object via the native parser. */
export function parseQueryString(query: string): Record<string, string | string[]> {
  const packed = addon.queryParsePacked(encoder.encode(query))
  return pairsToObject(readPairsPacked(packed))
}

/** Parse a cookie header (`a=1; b=2`) into an object via the native parser. */
export function parseCookieHeader(header: string): Record<string, string | string[]> {
  const packed = addon.cookieParsePacked(encoder.encode(header))
  return pairsToObject(readPairsPacked(packed))
}

/** Parse an application/x-www-form-urlencoded body into a key/value object. */
export function parseFormBody(body: Uint8Array): Record<string, string | string[]> {
  const packed = addon.formParsePacked(body)
  return pairsToObject(readPairsPacked(packed))
}
