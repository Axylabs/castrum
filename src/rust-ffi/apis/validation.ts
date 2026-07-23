import type { FfiRuntime } from "../runtime";

export function createValidationApi(runtime: FfiRuntime) {
  const { symbols, ptr } = runtime;

  return {
    validateEmail(bytes: Uint8Array): number {
      return symbols.rust_validate_email_v2(
        ptr(bytes),
        bytes.byteLength,
      ) as number;
    },

    validateUuid(bytes: Uint8Array): number {
      return symbols.rust_validate_uuid_v2(
        ptr(bytes),
        bytes.byteLength,
      ) as number;
    },

    validateIpv4(bytes: Uint8Array): number {
      return symbols.rust_validate_ipv4_v2(
        ptr(bytes),
        bytes.byteLength,
      ) as number;
    },

    validateIpv6(bytes: Uint8Array): number {
      return symbols.rust_validate_ipv6_v2(
        ptr(bytes),
        bytes.byteLength,
      ) as number;
    },
  };
}

export type ValidationApi = ReturnType<typeof createValidationApi>;
