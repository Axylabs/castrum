import { applyPatch, type Operation } from 'fast-json-patch'
import { decoder, encoder } from '../../shared/bytes'

export function nativeJsonPatch(docBytes: Uint8Array, patchBytes: Uint8Array): Uint8Array {
  const doc = JSON.parse(decoder.decode(docBytes))
  const patch = JSON.parse(decoder.decode(patchBytes)) as Operation[]
  const result = applyPatch(doc, patch, true, false).newDocument
  return encoder.encode(JSON.stringify(result))
}
