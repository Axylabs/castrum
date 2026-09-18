// src/ingress/routes/safe-record.ts — prototype-safe containers for
// request-derived objects.
//
// PURE: no addon and no pooled-buffer state. Every object keyed by request data
// (query/cookie/body keys) goes through these helpers, so attacker-controlled
// keys such as `__proto__` / `constructor` / `prototype` land as inert OWN
// data. `Object.create(null)` removes the inherited `__proto__` setter, and
// `Object.defineProperty` avoids the setter even on a target that has a
// prototype, so nothing can reach `Object.prototype` (or a downstream config
// merge) as an accessor.

/**
 * Create an empty null-prototype record.
 *
 * @returns A fresh `Record<string, unknown>` with no prototype, so
 *   `__proto__` / `constructor` / `prototype` are ordinary own keys.
 */
export function safeRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>
}

/**
 * Assign a key as an OWN, enumerable, writable, configurable data property.
 *
 * `Object.defineProperty` is used instead of `target[key] = value` because the
 * latter invokes an inherited `__proto__` setter on ordinary objects;
 * `defineProperty` always writes own data and never touches the prototype
 * chain.
 *
 * @param target - Record to write into (normally from {@link safeRecord}).
 * @param key - Request-derived key (may be `__proto__` / `constructor`).
 * @param value - Request-derived value.
 */
export function assignOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}
