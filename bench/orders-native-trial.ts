/**
 * bench/orders-native-trial.ts — trial-and-error: can Rust FFI beat the
 * compiled-server baseline for the REAL `/api/orders` use case (700KB body,
 * 5000 lineItems, handler reads `lineItems.length` + `totalCents`)?
 *
 * Method: warmup + N samples per candidate, report MEDIAN. Run several times
 * to confirm stability (`bun bench/orders-native-trial.ts`).
 *
 * Candidates measured (mirrors ignus packages/app compiled flow):
 *  - parse+ajv (valid)      current happy path: JSON.parse + precompiled Ajv
 *  - native gate (valid)    fast_schema first, then parse+ajv  (double-scan?)
 *  - parse+ajv (invalid)    current invalid path (parses full DOM then rejects)
 *  - native gate (invalid)  fast_schema early-exit, zero-DOM reject
 *  - native gate (bad-last) invalid failing at the LAST field (early-exit bound)
 *  - parse (malformed)      current malformed path (JSON.parse throws)
 *  - jsonValid (malformed)  rust.jsonValid FFI reject (zero-DOM)
 *  - derive: parse+reduce   JS single-pass derive (sum ids)  — baseline
 *  - derive: jsonSumIds     native single-pass derive (sum ids) — proof of the
 *                           derive-op ceiling for "validate+extract" routes
 */
import Ajv from "ajv";
import { rust } from "../src/rust-ffi";
import { decoder } from "../src/shared/bytes";

// ── deterministic orders payload (matches ignus bench-data LCG) ─────────────
let lcgState = 0x9e3779b9;
const rand = (): number => {
  lcgState = (Math.imul(lcgState, 1664525) + 1013904223) >>> 0;
  return lcgState / 0x100000000;
};

const ORDERS_SCHEMA = {
  type: "object",
  required: [
    "orderId",
    "customer",
    "shippingAddress",
    "lineItems",
    "payment",
    "subtotalCents",
    "taxCents",
    "totalCents",
    "currency",
  ],
  properties: {
    orderId: { type: "string" },
    customer: {
      type: "object",
      required: ["id", "email", "name"],
      properties: {
        id: { type: "string" },
        email: { type: "string" },
        name: { type: "string" },
      },
    },
    shippingAddress: {
      type: "object",
      required: ["line1", "city", "region", "postalCode", "country"],
      properties: {
        line1: { type: "string" },
        city: { type: "string" },
        region: { type: "string" },
        postalCode: { type: "string" },
        country: { type: "string" },
      },
    },
    lineItems: {
      type: "array",
      items: {
        type: "object",
        required: ["sku", "name", "quantity", "unitPriceCents"],
        properties: {
          sku: { type: "string" },
          name: { type: "string" },
          quantity: { type: "integer", minimum: 1 },
          unitPriceCents: { type: "integer", minimum: 0 },
          note: { type: "string" },
        },
      },
    },
    payment: {
      type: "object",
      required: ["method", "last4"],
      properties: { method: { type: "string" }, last4: { type: "string" } },
    },
    subtotalCents: { type: "integer" },
    taxCents: { type: "integer" },
    totalCents: { type: "integer" },
    currency: { type: "string" },
  },
} as const;

const lineItem = (i: number) => ({
  sku: `SKU-${String(i).padStart(5, "0")}`,
  name: `Line Item ${i} ${rand().toString(36).slice(2, 7)}`,
  quantity: 1 + Math.floor(rand() * 9),
  unitPriceCents: Math.floor(rand() * 50000),
  note: rand() > 0.5 ? `note-${rand().toString(36).slice(2, 10)}` : undefined,
});

const buildOrder = (nItems: number) => ({
  orderId: `ord_${rand().toString(36).slice(2, 14)}`,
  customer: {
    id: `cus_${rand().toString(36).slice(2, 14)}`,
    email: `customer${Math.floor(rand() * 1e6)}@example.com`,
    name: "Test Customer",
  },
  shippingAddress: {
    line1: "123 Main St",
    city: "Metropolis",
    region: "NY",
    postalCode: "10001",
    country: "US",
  },
  lineItems: Array.from({ length: nItems }, (_, i) => lineItem(i)),
  payment: { method: "card", last4: "4242" },
  subtotalCents: 100000,
  taxCents: 8000,
  totalCents: 108000,
  currency: "USD",
});

const N_ITEMS = 5000;
const valid = buildOrder(N_ITEMS);
const validJson = JSON.stringify(valid);
const validBytes = new TextEncoder().encode(validJson);

// invalid: bad sku type at lineItems[0] (early exit) — common bad-client case
const invalidEarly = structuredClone(valid);
(invalidEarly.lineItems[0] as { sku: unknown }).sku = 12345;
const invalidEarlyJson = JSON.stringify(invalidEarly);
const invalidEarlyBytes = new TextEncoder().encode(invalidEarlyJson);

// invalid: bad totalCents (LAST property) — worst-case early-exit bound
const invalidLate = structuredClone(valid);
invalidLate.totalCents = "nope" as unknown as number;
const invalidLateJson = JSON.stringify(invalidLate);
const invalidLateBytes = new TextEncoder().encode(invalidLateJson);

// malformed: truncate mid-array
const malformedBytes = validBytes.subarray(0, Math.floor(validBytes.length * 0.6));

// derive-op proof payload: top-level array of {id} (jsonSumIds shape)
const idsArr = Array.from({ length: N_ITEMS }, (_, i) => ({ id: i + 1 }));
const idsJson = JSON.stringify(idsArr);
const idsBytes = new TextEncoder().encode(idsJson);
const idsString = idsJson;

// ── compiled validators (once) ──────────────────────────────────────────────
const ajv = new Ajv({ strict: false });
const ajvValidate = ajv.compile(ORDERS_SCHEMA as object) as (d: unknown) => boolean;
const nativeSchema = rust.createSchemaValidator(
  new TextEncoder().encode(JSON.stringify(ORDERS_SCHEMA)),
);

// ── measurement helpers ─────────────────────────────────────────────────────
const time = (fn: () => unknown): number => {
  const t0 = performance.now();
  fn();
  return (performance.now() - t0) * 1000; // µs
};

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const measure = (
  label: string,
  fn: () => unknown,
  samples = 25,
  warmup = 5,
): { label: string; medianUs: number; minUs: number; p95Us: number } => {
  for (let i = 0; i < warmup; i++) fn();
  const xs: number[] = [];
  for (let i = 0; i < samples; i++) xs.push(time(fn));
  const s = [...xs].sort((a, b) => a - b);
  const p95 = s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!;
  return { label, medianUs: median(xs), minUs: s[0]!, p95Us: p95 };
};

// ── candidates ──────────────────────────────────────────────────────────────
const runs: Array<{ label: string; fn: () => unknown }> = [
  // happy path
  {
    label: "A1 parse+ajv (valid)         [current]",
    fn: () => {
      const body = JSON.parse(validJson) as unknown;
      ajvValidate(body);
    },
  },
  {
    label: "A2 native gate->parse+ajv    [double-scan?]",
    fn: () => {
      if (!nativeSchema.validate(validBytes)) return;
      const body = JSON.parse(validJson) as unknown;
      ajvValidate(body);
    },
  },
  {
    label: "A3 native gate->parse (no ajv) [replace ajv?]",
    fn: () => {
      if (!nativeSchema.validate(validBytes)) return;
      JSON.parse(validJson);
    },
  },
  // invalid paths
  {
    label: "B1 parse+ajv (invalid@0)     [current]",
    fn: () => {
      const body = JSON.parse(invalidEarlyJson) as unknown;
      if (!ajvValidate(body)) return; // -> 400
    },
  },
  {
    label: "B2 native gate (invalid@0)   [zero-DOM reject]",
    fn: () => {
      if (!nativeSchema.validate(invalidEarlyBytes)) return; // -> 400
    },
  },
  {
    label: "B3 parse+ajv (invalid@last)  [current]",
    fn: () => {
      const body = JSON.parse(invalidLateJson) as unknown;
      if (!ajvValidate(body)) return; // -> 400
    },
  },
  {
    label: "B4 native gate (invalid@last) [zero-DOM reject]",
    fn: () => {
      if (!nativeSchema.validate(invalidLateBytes)) return; // -> 400
    },
  },
  // malformed
  {
    label: "C1 parse (malformed)         [current]",
    fn: () => {
      try {
        JSON.parse(decoder.decode(malformedBytes));
      } catch {
        /* 400 */
      }
    },
  },
  {
    label: "C2 jsonValid FFI (malformed) [zero-DOM reject]",
    fn: () => {
      rust.jsonValid(malformedBytes);
    },
  },
  // derive-op proof (single-pass native vs single-pass JS)
  {
    label: "D1 derive JS parse+reduce    [baseline]",
    fn: () => {
      const arr = JSON.parse(idsString) as Array<{ id: number }>;
      let sum = 0;
      for (const it of arr) sum += it.id;
      if (sum !== (N_ITEMS * (N_ITEMS + 1)) / 2) throw new Error("sum");
    },
  },
  {
    label: "D2 derive rust.jsonSumIds    [native single-pass]",
    fn: () => {
      const sum = rust.jsonSumIds(idsBytes);
      if (sum !== BigInt((N_ITEMS * (N_ITEMS + 1)) / 2)) throw new Error("sum");
    },
  },
  // ── THE WIN: one-pass native derive for the orders route ─────────────────
  {
    label: "E1 native derive (valid)      [validate+extract 1-pass]",
    fn: () => {
      const r = nativeSchema.derive(validBytes, ["/lineItems/-", "/totalCents"]);
      if (!r.ok) throw new Error("must be valid");
      if (r.values[0]!.int !== N_ITEMS || r.values[1]!.int !== 108000)
        throw new Error("wrong derive");
    },
  },
  {
    label: "E2 native derive (invalid@0)  [zero-DOM reject]",
    fn: () => {
      const r = nativeSchema.derive(invalidEarlyBytes, ["/lineItems/-", "/totalCents"]);
      if (r.ok) throw new Error("must reject");
    },
  },
];

// ── run & report ────────────────────────────────────────────────────────────
console.log(
  `orders-native-trial — items=${N_ITEMS}, body=${(validBytes.length / 1024).toFixed(0)}KB, samples/median`,
);
console.log("-".repeat(78));
const results = runs.map((r) => measure(r.label, r.fn));
for (const r of results) {
  console.log(
    `${r.label}  med=${r.medianUs.toFixed(0).padStart(6)}µs  min=${r.minUs
      .toFixed(0)
      .padStart(6)}µs  p95=${r.p95Us.toFixed(0).padStart(6)}µs`,
  );
}
console.log("-".repeat(78));

// sanity
if (!ajvValidate(valid)) throw new Error("valid fixture must pass");
if (ajvValidate(invalidEarly) || ajvValidate(invalidLate))
  throw new Error("invalid fixtures must fail");
if (!nativeSchema.validate(validBytes)) throw new Error("native must accept valid");
if (nativeSchema.validate(invalidEarlyBytes) || nativeSchema.validate(invalidLateBytes))
  throw new Error("native must reject invalid");
