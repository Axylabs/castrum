import { decoder } from '../../shared/bytes'

export function nativeUrlEncode(input: string | Uint8Array): string {
  const text = typeof input === 'string' ? input : decoder.decode(input)
  return encodeURIComponent(text)
}

export function nativeUrlDecode(input: string | Uint8Array): string {
  const text = typeof input === 'string' ? input : decoder.decode(input)
  return decodeURIComponent(text)
}
