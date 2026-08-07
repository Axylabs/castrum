/**
 * Tests for the Rust JSON FFI: `rust.jsonParse` (sonic-rs → JS value) and the
 * native `SchemaValidator` scalar/batch validation, cross-checked against the
 * JS baselines (`JSON.parse` and ajv).
 */

import { describe, test, expect } from "bun:test";
import { rust } from "../../../src/rust-ffi";
import { encoder } from "../../../src/shared/bytes";
import {
  nativeJsonSchemaValidate,
  nativeJsonSchemaValidateBatch,
} from "../../../src/bench/schema-baseline";

const SCHEMA = encoder.encode(
  JSON.stringify({
    type: "object",
    required: ["id", "name"],
    properties: {
      id: { type: "number" },
      name: { type: "string", minLength: 1 },
    },
    additionalProperties: false,
  }),
);

const VALID_DOC = encoder.encode(JSON.stringify({ id: 1, name: "alice" }));
const INVALID_DOC = encoder.encode(JSON.stringify({ id: "x", name: 42 }));

describe("rust.jsonParse", () => {
  test("parses to a JS value matching JSON.parse", () => {
    const bytes = encoder.encode('{"a":1,"b":[true,null,"x"],"c":{"d":2.5}}');
    const parsed = rust.jsonParse(bytes) as Record<string, unknown>;
    const expected = JSON.parse("{\"a\":1,\"b\":[true,null,\"x\"],\"c\":{\"d\":2.5}}");

    expect(parsed.a).toBe(1);
    expect(parsed.b).toEqual([true, null, "x"]);
    expect(parsed.c).toEqual({ d: 2.5 });
    expect(parsed).toEqual(expected);
  });

  test("parses a large array of rows", () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: i, name: `u${i}` }));
    const parsed = rust.jsonParse(encoder.encode(JSON.stringify(rows))) as unknown[];
    expect(parsed.length).toBe(1000);
    expect((parsed[500] as { id: number }).id).toBe(500);
  });

  test("throws on invalid JSON", () => {
    expect(() => rust.jsonParse(encoder.encode("{not json"))).toThrow();
    expect(() => rust.jsonParse(new Uint8Array(0))).toThrow();
  });
});

describe("SchemaValidator.validate (scalar)", () => {
  const validator = rust.createSchemaValidator(SCHEMA);

  test("accepts a valid doc, matching ajv", () => {
    expect(validator.validate(VALID_DOC)).toBe(true);
    expect(nativeJsonSchemaValidate(VALID_DOC, SCHEMA)).toBe(true);
  });

  test("rejects an invalid doc, matching ajv", () => {
    expect(validator.validate(INVALID_DOC)).toBe(false);
    expect(nativeJsonSchemaValidate(INVALID_DOC, SCHEMA)).toBe(false);
  });
});

describe("SchemaValidator batch", () => {
  const validator = rust.createSchemaValidator(SCHEMA);

  test("count matches the JS baseline", () => {
    const docs = [VALID_DOC, VALID_DOC, INVALID_DOC, VALID_DOC];
    expect(rust.batch.schemaValidateCount(validator, docs)).toBe(3);
    expect(nativeJsonSchemaValidateBatch(docs, SCHEMA)).toBe(3);
  });
});
