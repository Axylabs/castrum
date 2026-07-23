#!/usr/bin/env python3
"""
Add JSON Schema validation benchmarks to the Bun + Rust FFI benchmark repo.

This script:
  1. Adds a Rust jsonschema-based validator with compiled schema handles.
  2. Adds an Ajv-based JavaScript baseline validator.
  3. Adds multiple request-validation benchmarks.
  4. Wires everything into the existing benchmark runner.
  5. Optionally installs dependencies, builds Rust, and runs the benchmark.

Run from the repository root:

    python3 scripts/add_json_schema_bench.py

Useful flags:

    --no-run          Patch only; do not install/build/bench.
    --no-install      Skip bun install.
    --no-build        Skip cargo build --release.
    --no-bench        Skip bun bench.ts.
    --root <path>     Repository root. Defaults to current directory.
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(".")

RUST_JSON_SCHEMA = r'''
use crate::ffi::{catch_or, input_bytes, output_bytes, write_response};
use jsonschema::JSONSchema;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

static VALIDATORS: OnceLock<Mutex<HashMap<u64, Arc<JSONSchema>>>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn validators() -> &'static Mutex<HashMap<u64, Arc<JSONSchema>>> {
    VALIDATORS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[no_mangle]
pub extern "C" fn rust_json_schema_compile_v2(ptr: *const u8, len: usize) -> i64 {
    catch_or(0, || {
        let input = input_bytes(ptr, len);
        let schema: Value = match serde_json::from_slice(input) {
            Ok(v) => v,
            Err(_) => return 0,
        };

        let compiled = match JSONSchema::compile(&schema) {
            Ok(c) => c,
            Err(_) => return 0,
        };

        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);

        match validators().lock() {
            Ok(mut map) => {
                map.insert(id, Arc::new(compiled));
                id as i64
            }
            Err(_) => 0,
        }
    })
}

#[no_mangle]
pub extern "C" fn rust_json_schema_free_v2(handle: i64) -> i32 {
    catch_or(0, || {
        if handle <= 0 {
            return 0;
        }

        match validators().lock() {
            Ok(mut map) => {
                if map.remove(&(handle as u64)).is_some() {
                    1
                } else {
                    0
                }
            }
            Err(_) => 0,
        }
    })
}

#[no_mangle]
pub extern "C" fn rust_json_schema_validate_v2(handle: i64, ptr: *const u8, len: usize) -> i32 {
    catch_or(-1, || {
        if handle <= 0 {
            return -1;
        }

        let input = input_bytes(ptr, len);

        let instance: Value = match serde_json::from_slice(input) {
            Ok(v) => v,
            Err(_) => return 0,
        };

        let compiled = match validators().lock() {
            Ok(map) => map.get(&(handle as u64)).cloned(),
            Err(_) => return -1,
        };

        match compiled {
            Some(compiled) => {
                if compiled.validate(&instance).is_ok() {
                    1
                } else {
                    0
                }
            }
            None => -1,
        }
    })
}

#[no_mangle]
pub extern "C" fn rust_json_schema_validate_errors_v2(
    handle: i64,
    ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    catch_or(-1, || {
        if handle <= 0 {
            return -1;
        }

        let input = input_bytes(ptr, len);
        let out = output_bytes(out_ptr, out_cap);

        let instance: Value = match serde_json::from_slice(input) {
            Ok(v) => v,
            Err(err) => {
                let result = serde_json::json!({
                    "valid": false,
                    "errors": [{ "path": "", "message": err.to_string() }],
                });
                let serialized = serde_json::to_vec(&result).unwrap_or_default();
                return write_response(out, &serialized);
            }
        };

        let compiled = match validators().lock() {
            Ok(map) => map.get(&(handle as u64)).cloned(),
            Err(_) => return -1,
        };

        let compiled = match compiled {
            Some(c) => c,
            None => return -1,
        };

        let errors: Vec<Value> = match compiled.validate(&instance) {
            Ok(_) => Vec::new(),
            Err(errs) => errs
                .map(|err| {
                    serde_json::json!({
                        "path": "",
                        "message": err.to_string(),
                    })
                })
                .collect(),
        };

        let result = serde_json::json!({
            "valid": errors.is_empty(),
            "errors": errors,
        });

        let serialized = serde_json::to_vec(&result).unwrap_or_default();
        write_response(out, &serialized)
    })
}
'''

TS_JSON_SCHEMA_API = r'''
import type { FfiRuntime } from "../runtime";

export function createJsonSchemaApi(runtime: FfiRuntime) {
  const { symbols, ptr, callOut } = runtime;

  return {
    jsonSchemaCompile(schema: Uint8Array): bigint {
      const handle = symbols.rust_json_schema_compile_v2(
        ptr(schema),
        schema.byteLength,
      ) as bigint;

      if (handle <= 0n) {
        throw new Error("Failed to compile JSON Schema in Rust");
      }

      return handle;
    },

    jsonSchemaFree(handle: bigint): number {
      return symbols.rust_json_schema_free_v2(handle) as number;
    },

    jsonSchemaValidate(handle: bigint, bytes: Uint8Array): number {
      return symbols.rust_json_schema_validate_v2(
        handle,
        ptr(bytes),
        bytes.byteLength,
      ) as number;
    },

    jsonSchemaValidateErrors(handle: bigint, bytes: Uint8Array): Uint8Array {
      return callOut(
        symbols.rust_json_schema_validate_errors_v2,
        Math.max(1024, bytes.byteLength * 2 + 1024),
        handle,
        ptr(bytes),
        bytes.byteLength,
      );
    },
  };
}

export type JsonSchemaApi = ReturnType<typeof createJsonSchemaApi>;
'''

TS_BASELINE_JSON_SCHEMA = r'''
import Ajv from "ajv";
import { decoder, encoder } from "../../shared/bytes";

export interface NativeJsonSchemaCompiled {
  validate: (data: unknown) => boolean;
  errors?: unknown[] | null;
}

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  coerceTypes: false,
  removeAdditional: false,
});

export function nativeJsonSchemaCompile(
  schemaBytes: Uint8Array,
): NativeJsonSchemaCompiled {
  const schema = JSON.parse(decoder.decode(schemaBytes));
  const validate = ajv.compile(schema);
  return validate as unknown as NativeJsonSchemaCompiled;
}

export function nativeJsonSchemaValidate(
  compiled: NativeJsonSchemaCompiled,
  bytes: Uint8Array,
): boolean {
  let data: unknown;

  try {
    data = JSON.parse(decoder.decode(bytes));
  } catch {
    return false;
  }

  return compiled.validate(data);
}

export function nativeJsonSchemaValidateErrors(
  compiled: NativeJsonSchemaCompiled,
  bytes: Uint8Array,
): Uint8Array {
  let data: unknown;

  try {
    data = JSON.parse(decoder.decode(bytes));
  } catch (err) {
    return encoder.encode(
      JSON.stringify({
        valid: false,
        errors: [{ path: "", message: String(err) }],
      }),
    );
  }

  const valid = compiled.validate(data);

  const errors = (compiled.errors ?? []).map((error: any) => ({
    path: typeof error?.instancePath === "string" ? error.instancePath : "",
    message: typeof error?.message === "string" ? error.message : "invalid",
  }));

  return encoder.encode(JSON.stringify({ valid, errors }));
}
'''

TS_JSON_SCHEMA_FIXTURES = r'''
import { encoder } from "../shared/bytes";

export const requestSchema = {
  type: "object",
  required: [
    "id",
    "name",
    "email",
    "age",
    "active",
    "roles",
    "tags",
    "address",
    "profile",
  ],
  additionalProperties: false,
  properties: {
    id: {
      type: "integer",
      minimum: 1,
    },
    name: {
      type: "string",
      minLength: 1,
      maxLength: 80,
    },
    email: {
      type: "string",
      pattern: "^[^@]+@[^@]+[.][^@]+$",
    },
    age: {
      type: "integer",
      minimum: 0,
      maximum: 150,
    },
    active: {
      type: "boolean",
    },
    roles: {
      type: "array",
      items: {
        type: "string",
        enum: ["admin", "user", "guest"],
      },
      minItems: 1,
      maxItems: 10,
    },
    tags: {
      type: "array",
      items: {
        type: "string",
        minLength: 1,
      },
      minItems: 1,
      maxItems: 1000,
    },
    address: {
      type: "object",
      required: ["street", "city", "postalCode"],
      additionalProperties: false,
      properties: {
        street: {
          type: "string",
          minLength: 1,
        },
        city: {
          type: "string",
          minLength: 1,
        },
        country: {
          type: "string",
          minLength: 2,
          maxLength: 2,
        },
        postalCode: {
          type: "string",
          pattern: "^[0-9]{4,10}$",
        },
      },
    },
    profile: {
      type: "object",
      required: ["username", "createdAt", "settings"],
      additionalProperties: false,
      properties: {
        username: {
          type: "string",
          minLength: 3,
          maxLength: 32,
          pattern: "^[a-zA-Z0-9_]+$",
        },
        createdAt: {
          type: "string",
          minLength: 10,
          maxLength: 40,
        },
        settings: {
          type: "object",
          required: ["theme", "notifications"],
          additionalProperties: false,
          properties: {
            theme: {
              type: "string",
              enum: ["light", "dark", "system"],
            },
            language: {
              type: "string",
              minLength: 2,
              maxLength: 5,
            },
            notifications: {
              type: "object",
              required: ["email", "sms"],
              additionalProperties: false,
              properties: {
                email: {
                  type: "boolean",
                },
                sms: {
                  type: "boolean",
                },
                push: {
                  type: "boolean",
                },
              },
            },
          },
        },
      },
    },
  },
};

export const batchSchema = {
  type: "array",
  items: requestSchema,
  minItems: 1,
  maxItems: 1000,
};

export function makeRequest(i: number, tagCount = 3) {
  return {
    id: i + 1,
    name: `user_${i}`,
    email: `user${i}@example.com`,
    age: 18 + (i % 60),
    active: i % 2 === 0,
    roles: i % 2 === 0 ? ["admin", "user"] : ["user"],
    tags: Array.from({ length: tagCount }, (_, t) => `tag_${i}_${t}`),
    address: {
      street: `${i + 1} Main Street`,
      city: "Springfield",
      country: "US",
      postalCode: String(10000 + i),
    },
    profile: {
      username: `user_${i}`,
      createdAt: "2026-01-01T00:00:00Z",
      settings: {
        theme: "dark",
        language: "en",
        notifications: {
          email: true,
          sms: false,
          push: true,
        },
      },
    },
  };
}

export const validRequest = makeRequest(1, 3);

export const invalidRequest = {
  id: 0,
  name: "",
  email: "not-an-email",
  age: -1,
  active: "yes",
  roles: ["superuser"],
  tags: [],
  address: {
    street: "",
    city: "X",
    postalCode: "abc",
  },
  profile: {
    username: "u!",
    createdAt: "bad",
    settings: {
      theme: "blue",
      notifications: {
        email: "yes",
      },
    },
  },
};

export const nestedRequest = makeRequest(2, 8);
export const largeRequest = makeRequest(3, 500);
export const batchRequests = Array.from({ length: 100 }, (_, i) =>
  makeRequest(i, 3),
);

export const requestSchemaBytes = encoder.encode(JSON.stringify(requestSchema));
export const batchSchemaBytes = encoder.encode(JSON.stringify(batchSchema));

export const validRequestBytes = encoder.encode(JSON.stringify(validRequest));
export const invalidRequestBytes = encoder.encode(
  JSON.stringify(invalidRequest),
);
export const nestedRequestBytes = encoder.encode(JSON.stringify(nestedRequest));
export const largeRequestBytes = encoder.encode(JSON.stringify(largeRequest));
export const batchRequestsBytes = encoder.encode(
  JSON.stringify(batchRequests),
);
'''

TS_JSON_SCHEMA_CHECKS = r'''
import * as native from "../baseline";
import { rust } from "../rust-ffi/raw";
import { decoder } from "../shared/bytes";
import { assertEqual } from "./assert";
import {
  batchRequestsBytes,
  batchSchemaBytes,
  invalidRequestBytes,
  largeRequestBytes,
  nestedRequestBytes,
  requestSchemaBytes,
  validRequestBytes,
} from "./json-schema-fixtures";

export function runJsonSchemaChecks(): void {
  const rustRequest = rust.jsonSchemaCompile(requestSchemaBytes);
  const nativeRequest = native.nativeJsonSchemaCompile(requestSchemaBytes);

  const rustBatch = rust.jsonSchemaCompile(batchSchemaBytes);
  const nativeBatch = native.nativeJsonSchemaCompile(batchSchemaBytes);

  assertEqual(
    native.nativeJsonSchemaValidate(nativeRequest, validRequestBytes),
    rust.jsonSchemaValidate(rustRequest, validRequestBytes) === 1,
    "json schema valid request",
  );

  assertEqual(
    native.nativeJsonSchemaValidate(nativeRequest, invalidRequestBytes),
    rust.jsonSchemaValidate(rustRequest, invalidRequestBytes) === 1,
    "json schema invalid request",
  );

  assertEqual(
    native.nativeJsonSchemaValidate(nativeRequest, nestedRequestBytes),
    rust.jsonSchemaValidate(rustRequest, nestedRequestBytes) === 1,
    "json schema nested request",
  );

  assertEqual(
    native.nativeJsonSchemaValidate(nativeRequest, largeRequestBytes),
    rust.jsonSchemaValidate(rustRequest, largeRequestBytes) === 1,
    "json schema large request",
  );

  assertEqual(
    native.nativeJsonSchemaValidate(nativeBatch, batchRequestsBytes),
    rust.jsonSchemaValidate(rustBatch, batchRequestsBytes) === 1,
    "json schema batch request",
  );

  const nativeErrors = JSON.parse(
    decoder.decode(
      native.nativeJsonSchemaValidateErrors(nativeRequest, invalidRequestBytes),
    ),
  ) as { valid: boolean; errors: unknown[] };

  const rustErrors = JSON.parse(
    decoder.decode(
      rust.jsonSchemaValidateErrors(rustRequest, invalidRequestBytes),
    ),
  ) as { valid: boolean; errors: unknown[] };

  assertEqual(nativeErrors.valid, false, "native json schema errors valid flag");
  assertEqual(rustErrors.valid, false, "rust json schema errors valid flag");
  assertEqual(nativeErrors.errors.length > 0, true, "native json schema errors present");
  assertEqual(rustErrors.errors.length > 0, true, "rust json schema errors present");

  rust.jsonSchemaFree(rustRequest);
  rust.jsonSchemaFree(rustBatch);
}
'''

TS_JSON_SCHEMA_TASKS = r'''
import * as native from "../../baseline";
import { rust } from "../../rust-ffi/raw";
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";
import {
  batchRequestsBytes,
  batchSchemaBytes,
  invalidRequestBytes,
  largeRequestBytes,
  nestedRequestBytes,
  requestSchemaBytes,
  validRequestBytes,
} from "../json-schema-fixtures";

export function jsonSchemaTasks(_f: BenchFixtures): BenchTask[] {
  const rustRequest = rust.jsonSchemaCompile(requestSchemaBytes);
  const nativeRequest = native.nativeJsonSchemaCompile(requestSchemaBytes);

  const rustBatch = rust.jsonSchemaCompile(batchSchemaBytes);
  const nativeBatch = native.nativeJsonSchemaCompile(batchSchemaBytes);

  return [
    {
      name: "native:json_schema_compile",
      run: () => (native.nativeJsonSchemaCompile(requestSchemaBytes).validate ? 1 : 0),
      iterations: 50,
      warmup: 5,
    },
    {
      name: "rust:json_schema_compile",
      run: () => {
        const handle = rust.jsonSchemaCompile(requestSchemaBytes);
        rust.jsonSchemaFree(handle);
        return 1;
      },
      iterations: 50,
      warmup: 5,
    },
    {
      name: "native:json_schema_valid",
      run: () => (native.nativeJsonSchemaValidate(nativeRequest, validRequestBytes) ? 1 : 0),
      iterations: 500,
      warmup: 50,
    },
    {
      name: "rust:json_schema_valid",
      run: () => rust.jsonSchemaValidate(rustRequest, validRequestBytes),
      iterations: 500,
      warmup: 50,
    },
    {
      name: "native:json_schema_invalid",
      run: () => (native.nativeJsonSchemaValidate(nativeRequest, invalidRequestBytes) ? 1 : 0),
      iterations: 500,
      warmup: 50,
    },
    {
      name: "rust:json_schema_invalid",
      run: () => rust.jsonSchemaValidate(rustRequest, invalidRequestBytes),
      iterations: 500,
      warmup: 50,
    },
    {
      name: "native:json_schema_nested",
      run: () => (native.nativeJsonSchemaValidate(nativeRequest, nestedRequestBytes) ? 1 : 0),
      iterations: 500,
      warmup: 50,
    },
    {
      name: "rust:json_schema_nested",
      run: () => rust.jsonSchemaValidate(rustRequest, nestedRequestBytes),
      iterations: 500,
      warmup: 50,
    },
    {
      name: "native:json_schema_large",
      run: () => (native.nativeJsonSchemaValidate(nativeRequest, largeRequestBytes) ? 1 : 0),
      iterations: 200,
      warmup: 20,
    },
    {
      name: "rust:json_schema_large",
      run: () => rust.jsonSchemaValidate(rustRequest, largeRequestBytes),
      iterations: 200,
      warmup: 20,
    },
    {
      name: "native:json_schema_batch",
      run: () => (native.nativeJsonSchemaValidate(nativeBatch, batchRequestsBytes) ? 1 : 0),
      iterations: 100,
      warmup: 10,
    },
    {
      name: "rust:json_schema_batch",
      run: () => rust.jsonSchemaValidate(rustBatch, batchRequestsBytes),
      iterations: 100,
      warmup: 10,
    },
    {
      name: "native:json_schema_errors",
      run: () =>
        native.nativeJsonSchemaValidateErrors(nativeRequest, invalidRequestBytes).byteLength,
      iterations: 200,
      warmup: 20,
    },
    {
      name: "rust:json_schema_errors",
      run: () => rust.jsonSchemaValidateErrors(rustRequest, invalidRequestBytes).byteLength,
      iterations: 200,
      warmup: 20,
    },
  ];
}
'''

SYMBOLS_ADDITION = """
  rust_json_schema_compile_v2: {
    returns: FFIType.i64,
    args: [FFIType.ptr, FFIType.u64],
  },
  rust_json_schema_free_v2: {
    returns: FFIType.i32,
    args: [FFIType.i64],
  },
  rust_json_schema_validate_v2: {
    returns: FFIType.i32,
    args: [FFIType.i64, FFIType.ptr, FFIType.u64],
  },
  rust_json_schema_validate_errors_v2: {
    returns: FFIType.i64,
    args: [FFIType.i64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
  },
"""

COMPARISONS_ADDITION = """
  { label: "JSON Schema compile", nativeName: "native:json_schema_compile", rustName: "rust:json_schema_compile" },
  { label: "JSON Schema valid", nativeName: "native:json_schema_valid", rustName: "rust:json_schema_valid" },
  { label: "JSON Schema invalid", nativeName: "native:json_schema_invalid", rustName: "rust:json_schema_invalid" },
  { label: "JSON Schema nested", nativeName: "native:json_schema_nested", rustName: "rust:json_schema_nested" },
  { label: "JSON Schema large", nativeName: "native:json_schema_large", rustName: "rust:json_schema_large" },
  { label: "JSON Schema batch", nativeName: "native:json_schema_batch", rustName: "rust:json_schema_batch" },
  { label: "JSON Schema errors", nativeName: "native:json_schema_errors", rustName: "rust:json_schema_errors" },
"""


def read_file(rel: str) -> str:
    path = ROOT / rel
    if not path.exists():
        sys.exit(f"Missing required file: {rel}")
    return path.read_text(encoding="utf-8")


def write_file(rel: str, content: str) -> None:
    path = ROOT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    content = content.lstrip("\n")
    if not content.endswith("\n"):
        content += "\n"
    path.write_text(content, encoding="utf-8")
    print(f"wrote {rel}")


def patch_file(rel: str, transformer) -> None:
    path = ROOT / rel
    if not path.exists():
        sys.exit(f"Missing required file: {rel}")

    original = path.read_text(encoding="utf-8")
    updated = transformer(original)

    if updated != original:
        path.write_text(updated, encoding="utf-8")
        print(f"patched {rel}")
    else:
        print(f"unchanged {rel}")


def run_cmd(cmd: str) -> None:
    print(f"$ {cmd}")
    subprocess.run(cmd, shell=True, check=True, cwd=ROOT)


def add_cargo_dependency(text: str) -> str:
    if re.search(r"^jsonschema\s*=", text, re.M):
        return text

    pattern = re.compile(r"^\[dependencies\][^\n]*\n", re.M)
    if not pattern.search(text):
        sys.exit("Could not find [dependencies] in Cargo.toml")

    return pattern.sub(
        lambda m: f"{m.group(0)}jsonschema = \"0.18\"\n",
        text,
        count=1,
    )


def add_rust_module(text: str) -> str:
    if "mod json_schema;" in text:
        return text
    return text.rstrip() + "\nmod json_schema;\n"


def patch_raw_client(text: str) -> str:
    if "createJsonSchemaApi" not in text:
        anchor = 'import { createJsonPatchApi } from "./apis/json-patch";'
        import_line = 'import { createJsonSchemaApi } from "./apis/json-schema";'

        if anchor in text:
            text = text.replace(anchor, anchor + "\n" + import_line)
        else:
            text = import_line + "\n" + text

    if "...createJsonSchemaApi(runtime)" not in text:
        inserted = False

        pattern = re.compile(r"^([ \t]*)\.\.\.createJsonPatchApi\(runtime\),", re.M)
        if pattern.search(text):
            text = pattern.sub(
                lambda m: f"{m.group(1)}...createJsonPatchApi(runtime),\n"
                f"{m.group(1)}...createJsonSchemaApi(runtime),",
                text,
                count=1,
            )
            inserted = True
        else:
            pattern = re.compile(r"^([ \t]*)\.\.\.createUrlApi\(runtime\),", re.M)
            if pattern.search(text):
                text = pattern.sub(
                    lambda m: f"{m.group(1)}...createJsonSchemaApi(runtime),\n"
                    f"{m.group(1)}...createUrlApi(runtime),",
                    text,
                    count=1,
                )
                inserted = True

        if not inserted:
            sys.exit("Could not insert createJsonSchemaApi into src/rust-ffi/raw.ts")

    return text


def patch_symbols(text: str) -> str:
    if "rust_json_schema_compile_v2" in text:
        return text

    marker = "} as const;"
    if marker not in text:
        sys.exit("Could not find '} as const;' in src/rust-ffi/symbols.ts")

    return text.replace(
        marker,
        SYMBOLS_ADDITION.rstrip("\n") + "\n" + marker,
        1,
    )


def patch_baseline_index(text: str) -> str:
    line = 'export * from "./tasks/json-schema";'
    if line in text:
        return text
    return text.rstrip() + "\n" + line + "\n"


def patch_bench_tasks_index(text: str) -> str:
    if "jsonSchemaTasks" not in text:
        anchor = 'import { jsonPatchTasks } from "./json-patch";'
        import_line = 'import { jsonSchemaTasks } from "./json-schema";'

        if anchor in text:
            text = text.replace(anchor, anchor + "\n" + import_line)
        else:
            text = import_line + "\n" + text

    if "...jsonSchemaTasks(fixtures)" not in text:
        inserted = False

        pattern = re.compile(r"^([ \t]*)\.\.\.urlTasks\(fixtures\),", re.M)
        if pattern.search(text):
            text = pattern.sub(
                lambda m: f"{m.group(1)}...urlTasks(fixtures),\n"
                f"{m.group(1)}...jsonSchemaTasks(fixtures),",
                text,
                count=1,
            )
            inserted = True
        else:
            if "];" in text:
                text = text.replace(
                    "];",
                    "  ...jsonSchemaTasks(fixtures),\n];",
                    1,
                )
                inserted = True

        if not inserted:
            sys.exit("Could not insert jsonSchemaTasks into src/bench/tasks/index.ts")

    return text


def patch_comparisons(text: str) -> str:
    if "rust:json_schema_compile" in text:
        return text

    if "];" not in text:
        sys.exit("Could not find comparisonReports array end in src/bench/comparisons.ts")

    return text.replace(
        "];",
        COMPARISONS_ADDITION.rstrip("\n") + "\n];",
        1,
    )


def patch_checks(text: str) -> str:
    if "runJsonSchemaChecks" not in text:
        anchor = 'import type { BenchFixtures } from "./fixtures";'
        import_line = 'import { runJsonSchemaChecks } from "./json-schema-checks";'

        if anchor in text:
            text = text.replace(anchor, anchor + "\n" + import_line)
        else:
            text = import_line + "\n" + text

    if "runJsonSchemaChecks();" not in text:
        pattern = re.compile(
            r'^([ \t]*)console\.log\("Practical correctness checks passed\. ✓"\);',
            re.M,
        )

        if not pattern.search(text):
            sys.exit("Could not patch src/bench/checks.ts to call runJsonSchemaChecks()")

        text = pattern.sub(
            lambda m: f"{m.group(1)}runJsonSchemaChecks();\n"
            f"{m.group(1)}console.log(\"Practical correctness checks passed. ✓\");",
            text,
            count=1,
        )

    return text


def patch_package_json() -> None:
    rel = "package.json"
    path = ROOT / rel
    if not path.exists():
        sys.exit("Missing package.json")

    data = json.loads(path.read_text(encoding="utf-8"))

    deps = data.setdefault("dependencies", {})
    changed = False

    if "ajv" not in deps:
        deps["ajv"] = "^8.17.1"
        changed = True

    if changed:
        path.write_text(json.dumps(data, indent=4) + "\n", encoding="utf-8")
        print("patched package.json")
    else:
        print("unchanged package.json")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Add JSON Schema validation benchmarks to the Bun + Rust FFI repo."
    )
    parser.add_argument("--root", default=".", help="Repository root directory.")
    parser.add_argument("--no-run", action="store_true", help="Patch only.")
    parser.add_argument("--no-install", action="store_true", help="Skip bun install.")
    parser.add_argument("--no-build", action="store_true", help="Skip cargo build.")
    parser.add_argument("--no-bench", action="store_true", help="Skip bun bench.ts.")
    args = parser.parse_args()

    global ROOT
    ROOT = Path(args.root).resolve()

    if not (ROOT / "Cargo.toml").exists():
        sys.exit(f"{ROOT} does not look like the repository root: missing Cargo.toml")

    print(f"Repository root: {ROOT}")

    write_file("rust/json_schema.rs", RUST_JSON_SCHEMA)
    write_file("src/rust-ffi/apis/json-schema.ts", TS_JSON_SCHEMA_API)
    write_file("src/baseline/tasks/json-schema.ts", TS_BASELINE_JSON_SCHEMA)
    write_file("src/bench/json-schema-fixtures.ts", TS_JSON_SCHEMA_FIXTURES)
    write_file("src/bench/json-schema-checks.ts", TS_JSON_SCHEMA_CHECKS)
    write_file("src/bench/tasks/json-schema.ts", TS_JSON_SCHEMA_TASKS)

    patch_file("Cargo.toml", add_cargo_dependency)
    patch_file("rust/lib.rs", add_rust_module)
    patch_file("src/rust-ffi/raw.ts", patch_raw_client)
    patch_file("src/rust-ffi/symbols.ts", patch_symbols)
    patch_file("src/baseline/index.ts", patch_baseline_index)
    patch_file("src/bench/tasks/index.ts", patch_bench_tasks_index)
    patch_file("src/bench/comparisons.ts", patch_comparisons)
    patch_file("src/bench/checks.ts", patch_checks)
    patch_package_json()

    print()
    print("Added JSON Schema benchmarks:")
    print("  - native:json_schema_compile")
    print("  - rust:json_schema_compile")
    print("  - native:json_schema_valid")
    print("  - rust:json_schema_valid")
    print("  - native:json_schema_invalid")
    print("  - rust:json_schema_invalid")
    print("  - native:json_schema_nested")
    print("  - rust:json_schema_nested")
    print("  - native:json_schema_large")
    print("  - rust:json_schema_large")
    print("  - native:json_schema_batch")
    print("  - rust:json_schema_batch")
    print("  - native:json_schema_errors")
    print("  - rust:json_schema_errors")
    print()

    if args.no_run:
        print("Done. Skipping install/build/bench because --no-run was provided.")
        return

    if not args.no_install:
        run_cmd("bun install")

    if not args.no_build:
        run_cmd("cargo build --release")

    if not args.no_bench:
        run_cmd("bun bench.ts")

    print()
    print("Done.")


if __name__ == "__main__":
    main()