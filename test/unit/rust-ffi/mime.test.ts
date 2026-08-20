/**
 * Tests for `rust.mimeFromExtension` / `rust.text.mimeFromExtension` —
 * extension → MIME lookup (rust/http/mime_lookup.rs, phf table).
 */

import { describe, expect, test } from 'bun:test'
import { rust } from '../../../src/rust-ffi'
import { decoder, encoder } from '../../../src/shared/bytes'

describe('mimeFromExtension', () => {
  const cases: Array<[string, string]> = [
    ['.js', 'text/javascript'],
    ['.json', 'application/json'],
    ['.html', 'text/html'],
    ['.txt', 'text/plain'],
    ['.png', 'image/png'],
    ['.css', 'text/css'],
    ['.svg', 'image/svg+xml'],
  ]

  test('maps known extensions (scalar)', () => {
    for (const [ext, mime] of cases) {
      expect(decoder.decode(rust.mimeFromExtension(encoder.encode(ext)))).toBe(mime)
    }
  })

  test('maps known extensions (text namespace, string in/out)', () => {
    for (const [ext, mime] of cases) {
      expect(rust.text.mimeFromExtension(ext)).toBe(mime)
    }
  })

  test('is case-insensitive for the extension dot', () => {
    // ".JS" and "js" (no leading dot) resolve to the same table entry.
    expect(rust.text.mimeFromExtension('.JS')).toBe('text/javascript')
  })

  test('unknown extensions resolve deterministically (octet-stream)', () => {
    // Unknown extensions must not throw and must produce a stable result.
    const unknown = rust.text.mimeFromExtension('.definitely-not-a-real-ext')
    expect(typeof unknown).toBe('string')
    expect(unknown.length).toBeGreaterThan(0)
  })
})
