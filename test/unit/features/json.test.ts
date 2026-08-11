/**
 * Tests for the Rust JSON FFI: `rust.jsonParse` (sonic-rs → JS value) and the
 * native `SchemaValidator` scalar/batch validation, cross-checked against the
 * JS baselines (`JSON.parse` and ajv).
 */

import { describe, test, expect } from "bun:test";
import { rust } from "../../../src/rust-ffi";
import { decoder, encoder } from "../../../src/shared/bytes";
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

describe("SchemaValidator detailed errors", () => {
  const validator = rust.createSchemaValidator(SCHEMA);

  test("validateDetailed returns [] for a valid doc", () => {
    expect(validator.validateDetailed(VALID_DOC)).toEqual([]);
  });

  test("validateDetailed reports instance path + keyword", () => {
    const errs = validator.validateDetailed(INVALID_DOC);
    expect(errs.length).toBeGreaterThan(0);
    const e = errs[0];
    expect(e?.instancePath).toBe("/id");
    expect(e?.keyword).toBe("type");
    expect(e?.schemaPath).toBe("/properties/id/type");
    expect(e?.message.length ?? 0).toBeGreaterThan(0);
  });

  test("validateFirstError returns null for a valid doc", () => {
    expect(validator.validateFirstError(VALID_DOC)).toBeNull();
  });

  test("validateFirstError returns a single error for an invalid doc", () => {
    const first = validator.validateFirstError(INVALID_DOC);
    expect(first).not.toBeNull();
    expect(first?.instancePath).toBe("/id");
  });

  test("agrees with validate()", () => {
    for (const doc of [VALID_DOC, INVALID_DOC]) {
      const ok = validator.validate(doc);
      const errs = validator.validateDetailed(doc);
      const first = validator.validateFirstError(doc);
      expect(ok).toBe(errs.length === 0);
      expect(ok ? first == null : first != null).toBe(true);
    }
  });

  test("collects multiple errors (pattern + additionalProperties)", () => {
    const schema = encoder.encode(
      JSON.stringify({
        type: "object",
        properties: {
          name: { type: "string", pattern: "^[a-z]+$" },
        },
        additionalProperties: false,
      }),
    );
    const v = rust.createSchemaValidator(schema);
    const errs = v.validateDetailed(
      encoder.encode(JSON.stringify({ name: "AB", extra: 1 })),
    );
    const keywords = errs.map((e) => e.keyword);
    expect(keywords).toContain("pattern");
    expect(keywords).toContain("additionalProperties");
  });
});

describe("rust.jsonPatch", () => {
  test("replaces a field", () => {
    const doc = encoder.encode('{"name":"alice","age":30}');
    const patch = encoder.encode('[{"op":"replace","path":"/age","value":31}]');
    const out = rust.jsonPatch(doc, patch);
    expect(JSON.parse(decoder.decode(out))).toEqual({ name: "alice", age: 31 });
  });

  test("supports add/remove on arrays", () => {
    const doc = encoder.encode('{"items":["a","b"]}');
    const patch = encoder.encode(
      '[{"op":"add","path":"/items/-","value":"c"},{"op":"remove","path":"/items/0"}]',
    );
    const out = rust.jsonPatch(doc, patch);
    expect(JSON.parse(decoder.decode(out))).toEqual({ items: ["b", "c"] });
  });

  test("applies a real-world multi-op patch", () => {
    const doc = encoder.encode(
      JSON.stringify({
        id: "usr_01H2X9K7",
        profile: { displayName: "Alice", preferences: { theme: "dark" } },
        roles: ["admin"],
      }),
    );
    const patch = encoder.encode(
      JSON.stringify([
        { op: "replace", path: "/profile/preferences/theme", value: "light" },
        { op: "add", path: "/roles/-", value: "reviewer" },
      ]),
    );
    const out = rust.jsonPatch(doc, patch);
    expect(JSON.parse(decoder.decode(out))).toEqual({
      id: "usr_01H2X9K7",
      profile: { displayName: "Alice", preferences: { theme: "light" } },
      roles: ["admin", "reviewer"],
    });
  });

  test("throws on invalid document or patch", () => {
    expect(() => rust.jsonPatch(encoder.encode("not-json"), encoder.encode("[]"))).toThrow();
    expect(() => rust.jsonPatch(encoder.encode("{}"), encoder.encode("not-json"))).toThrow();
  });

  test("throws with contextual error message", () => {
    let message = "";
    try {
      rust.jsonPatch(encoder.encode("{bad"), encoder.encode("[]"));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("invalid document");
  });

  test("applies move, copy, and test ops", () => {
    const moved = rust.jsonPatch(
      encoder.encode('{"arr":[1,2,3],"obj":{}}'),
      encoder.encode('[{"op":"move","from":"/arr/0","path":"/obj/first"}]'),
    );
    expect(JSON.parse(decoder.decode(moved))).toEqual({
      arr: [2, 3],
      obj: { first: 1 },
    });

    const copied = rust.jsonPatch(
      encoder.encode('{"a":{"x":1},"b":null}'),
      encoder.encode('[{"op":"copy","from":"/a","path":"/b"}]'),
    );
    expect(JSON.parse(decoder.decode(copied))).toEqual({ a: { x: 1 }, b: { x: 1 } });

    // `test` mismatch throws.
    expect(() =>
      rust.jsonPatch(
        encoder.encode('{"v":42}'),
        encoder.encode('[{"op":"test","path":"/v","value":43}]'),
      ),
    ).toThrow(/apply failed/);
  });

  test("rejects invalid RFC 6901 escapes (~2, trailing ~)", () => {
    expect(() =>
      rust.jsonPatch(
        encoder.encode('{"a/b":1}'),
        encoder.encode('[{"op":"replace","path":"/a~2b","value":2}]'),
      ),
    ).toThrow(/invalid patch/);
    expect(() =>
      rust.jsonPatch(
        encoder.encode('{"a":1}'),
        encoder.encode('[{"op":"replace","path":"/a~","value":2}]'),
      ),
    ).toThrow(/invalid patch/);
  });
});

describe("rust.batch.jsonPatch", () => {
  test("zips docs and patches, matching scalar results", () => {
    const docs = [encoder.encode('{"a":1}'), encoder.encode('{"items":["x"]}')];
    const patches = [
      encoder.encode('[{"op":"replace","path":"/a","value":2}]'),
      encoder.encode('[{"op":"add","path":"/items/-","value":"y"}]'),
    ];
    const results = rust.batch.jsonPatch(docs, patches);
    expect(results.length).toBe(2);
    expect(JSON.parse(decoder.decode(results[0]))).toEqual({ a: 2 });
    expect(JSON.parse(decoder.decode(results[1]))).toEqual({ items: ["x", "y"] });
  });

  test("fails fast when the packed counts mismatch", () => {
    expect(() => rust.batch.jsonPatch([encoder.encode("{}")], [])).toThrow(/count/);
  });

  test("fails fast on an invalid item", () => {
    expect(() =>
      rust.batch.jsonPatch(
        [encoder.encode('{"a":1}'), encoder.encode("{bad")],
        [encoder.encode("[]"), encoder.encode("[]")],
      ),
    ).toThrow();
  });

  test("reports the failing item index", () => {
    let message = "";
    try {
      rust.batch.jsonPatch(
        [encoder.encode('{"a":1}'), encoder.encode("{bad"), encoder.encode('{"c":3}')],
        [encoder.encode("[]"), encoder.encode("[]"), encoder.encode("[]")],
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("item 1");
    expect(message).toContain("invalid document");
  });

  test("empty batch returns an empty result set", () => {
    expect(rust.batch.jsonPatch([], [])).toEqual([]);
  });

  test("reports failure on the first and last item with the right index", () => {
    for (const bad of [0, 2]) {
      const docs = [
        encoder.encode('{"a":1}'),
        encoder.encode('{"b":2}'),
        encoder.encode('{"c":3}'),
      ];
      docs[bad] = encoder.encode("{bad");
      const patches = [encoder.encode("[]"), encoder.encode("[]"), encoder.encode("[]")];
      let message = "";
      try {
        rust.batch.jsonPatch(docs, patches);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain(`item ${bad}`);
    }
  });
});
