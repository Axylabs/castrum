const HEX = "0123456789abcdef";

export function nativeRandomToken(byteLen: number): Uint8Array {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);

  const hex = new Uint8Array(byteLen * 2);

  for (let i = 0; i < byteLen; i++) {
    hex[i * 2] = HEX.charCodeAt(bytes[i]! >> 4);
    hex[i * 2 + 1] = HEX.charCodeAt(bytes[i]! & 0x0f);
  }

  return hex;
}