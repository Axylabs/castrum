import { isIP } from 'node:net'
import validator from 'validator'
import { decoder } from '../../shared/bytes'

export function nativeValidateEmail(bytes: Uint8Array): boolean {
  return validator.isEmail(decoder.decode(bytes))
}

export function nativeValidateUuid(bytes: Uint8Array): boolean {
  return validator.isUUID(decoder.decode(bytes), 4)
}

export function nativeValidateIpv4(bytes: Uint8Array): boolean {
  return validator.isIP(decoder.decode(bytes), 4)
}

export function nativeValidateIpv6(bytes: Uint8Array): boolean {
  return isIP(decoder.decode(bytes)) === 6
}
