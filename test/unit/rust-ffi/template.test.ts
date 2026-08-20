/**
 * Tests for the Rust minijinja templating FFI, cross-checked for byte parity
 * against the JS mini-renderer baseline.
 */

import { describe, expect, test } from 'bun:test'
import { nativeTemplateRender } from '../../../src/baseline/tasks/template'
import { rust } from '../../../src/rust-ffi'
import { decoder, encoder } from '../../../src/shared/bytes'

const source = '{% for u in users %}<li>{{ u.name }} ({{ u.id }})</li>\n{% endfor %}'

const context = {
  users: [
    { name: 'Alice', id: 1 },
    { name: 'Bob', id: 2 },
    { name: 'Carol', id: 3 },
  ],
}

describe('rust.createTemplateRenderer', () => {
  test('renders a loop to the same bytes as the baseline', () => {
    const renderer = rust.createTemplateRenderer(source)
    const rustHtml = decoder.decode(renderer.render(context))
    const nativeHtml = nativeTemplateRender(source, context)
    expect(rustHtml).toBe(nativeHtml)
  })

  test('renders expected output', () => {
    const renderer = rust.createTemplateRenderer(source)
    const html = decoder.decode(renderer.render(context))
    expect(html).toBe('<li>Alice (1)</li>\n<li>Bob (2)</li>\n<li>Carol (3)</li>\n')
  })

  test('handles missing variables', () => {
    const renderer = rust.createTemplateRenderer('[{{ missing }}]')
    expect(decoder.decode(renderer.render({}))).toBe('[]')
  })

  test('throws on compile error', () => {
    expect(() => rust.createTemplateRenderer('{% for x in %}')).toThrow()
  })
})

describe('rust.batch.templateRender', () => {
  test('renders many contexts', () => {
    const contexts = Array.from({ length: 5 }, (_, i) =>
      encoder.encode(JSON.stringify({ users: [{ name: `U${i}`, id: i }] })),
    )
    const out = rust.batch.templateRender(source, contexts)
    expect(out).toHaveLength(5)
    contexts.forEach((_, i) => {
      expect(decoder.decode(out[i] as Uint8Array)).toBe(`<li>U${i} (${i})</li>\n`)
    })
  })
})
