// src/ingress/routes/safe-record.ts — prototype-safe key assignment for
// request-derived objects.
//
// PURE: no addon and no pooled-buffer state. Request keys are attacker
// controlled, so a key of `__proto__` must not invoke the inherited setter on a
// plain object. `assignOwn` writes `__proto__` with `Object.defineProperty` (an
// own enumerable data property) and every other key with plain assignment,
// which is already safe: `constructor` / `prototype` just become own shadowing
// properties.
//
// Scope: this protects the RECORD itself — it keeps `Object.prototype` (so
// `hasOwnProperty` / `instanceof Object` still work), gains an own `__proto__`
// data key, and is never mutated through the setter. It does NOT protect a
// consumer that blindly merges the record into another object, e.g.
// `Object.assign({}, rec)`: the own `__proto__` key is still enumerable, so a
// merge target's inherited setter can fire there. Such consumers must guard
// their own merge.

/** A request-derived key that would invoke the inherited `__proto__` setter. */
const PROTO_KEY = '__proto__'

/**
 * Create an empty plain record (`Object.prototype` is preserved, so
 * `hasOwnProperty` / `instanceof Object` keep working). Safety comes from
 * {@link assignOwn}, not from the container.
 *
 * @returns A fresh, empty `Record<string, unknown>`.
 */
export function safeRecord(): Record<string, unknown> {
  return {}
}

/**
 * Assign a request-derived key as an OWN enumerable data property.
 *
 * Only `__proto__` is written with `Object.defineProperty` — a plain
 * `target[key] = value` would invoke the inherited `__proto__` setter and
 * mutate the prototype. Every other key (including `constructor` /
 * `prototype`) uses plain assignment: faster, and it merely shadows on the
 * object.
 *
 * @param target - Record to write into (normally from {@link safeRecord}).
 * @param key - Request-derived key (may be `__proto__` / `constructor`).
 * @param value - Request-derived value.
 */
export function assignOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === PROTO_KEY) {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    })
    return
  }
  target[key] = value
}
