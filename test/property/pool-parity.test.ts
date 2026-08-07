/**
 * Property test: the reusable-output native path (handleRequestFullSyncInto)
 * must produce byte-identical output to the allocating path
 * (handleRequestFullSync) for arbitrary inputs, including body/output
 * aliasing edge cases.
 *
 * This guards the pooling refactor against subtle behavioral drift: the pooled
 * path is only safe if it is a drop-in replacement for the allocating one.
 */

import { describe, test, expect } from "bun:test";
import { getAddon } from "../../src/native";

const addon = getAddon();

const METHODS = [0, 1, 2, 3, 4, 5, 6];
const HEADER_NAMES = [
  "cookie",
  "origin",
  "x-forwarded-for",
  "x-real-ip",
  "access-control-request-method",
  "access-control-request-headers",
  "x-forwarded-proto",
];

function randInt(n: number): number {
  return Math.floor(Math.random() * n);
}

function randBytes(max: number): Uint8Array {
  const b = new Uint8Array(randInt(max));
  for (let i = 0; i < b.length; i++) {
    b[i] = randInt(256);
  }
  return b;
}

function randString(max: number): string {
  // Include JSON-special + control chars so the escape/JSON-serialization
  // paths (and their length accounting) are exercised on every run.
  const chars =
    'abcdefghijklmnopqrstuvwxyz0123456789-_=+&?%/.~"\\\t\r\n\x08\x0c';
  let s = "";
  const len = randInt(max);
  for (let i = 0; i < len; i++) {
    s += chars[randInt(chars.length)];
  }
  return s;
}

function randRequest(): {
  method: number;
  url: string;
  ip: string;
  rid: string;
  headers: [string, string][];
  body: Uint8Array | null;
} {
  const headers: [string, string][] = [];
  const n = randInt(6);
  for (let i = 0; i < n; i++) {
    headers.push([HEADER_NAMES[randInt(HEADER_NAMES.length)]!, randString(60)]);
  }
  return {
    method: METHODS[randInt(METHODS.length)]!,
    url: `/${randString(40)}?${randString(30)}`,
    ip: `${randInt(256)}.${randInt(256)}.${randInt(256)}.${randInt(256)}`,
    rid: randString(16),
    headers,
    body: randInt(3) === 0 ? null : randBytes(256),
  };
}

describe("pooled vs allocating parity (property)", () => {
  for (const parseCookies of [false, true]) {
    for (const parseQuery of [false, true]) {
      test(`parseCookies=${parseCookies} parseQuery=${parseQuery}: parity over random inputs`, () => {
        const ingress = new addon.Ingress({
          parseCookies,
          parseQuery,
          https: true,
          emitMetadataJson: true,
          requireJsonBody: true,
        });

        for (let i = 0; i < 300; i++) {
          const r = randRequest();

          const expected = ingress.handleRequestFullSync(
            r.method,
            r.url,
            r.ip,
            r.rid,
            r.headers,
            r.body,
            131072,
          );

          const out = new Uint8Array(131072);
          const written = ingress.handleRequestFullSyncInto(
            r.method,
            r.url,
            r.ip,
            r.rid,
            r.headers,
            r.body,
            out,
          );

          expect(written).toBe(expected.byteLength);
          expect(
            Buffer.compare(Buffer.from(out.subarray(0, written)), Buffer.from(expected)),
          ).toBe(0);
        }
      });
    }
  }

  test("body aliasing the output buffer is handled safely", () => {
    const ingress = new addon.Ingress({
      parseQuery: true,
      https: true,
      emitMetadataJson: true,
    });

    // Share one backing store for both the body and the output buffer: the
    // native side must detect the overlap and copy the body before writing.
    const shared = new Uint8Array(131072);
    const bodyView = shared.subarray(0, 64);
    bodyView.set(new TextEncoder().encode('{"a":1,"b":"x"}'));

    const expected = ingress.handleRequestFullSync(
      2,
      "/x",
      "1.1.1.1",
      "rid",
      [["cookie", "a=1"]],
      bodyView,
      131072,
    );

    const written = ingress.handleRequestFullSyncInto(
      2,
      "/x",
      "1.1.1.1",
      "rid",
      [["cookie", "a=1"]],
      bodyView,
      shared,
    );

    expect(written).toBe(expected.byteLength);
    expect(
      Buffer.compare(Buffer.from(shared.subarray(0, written)), Buffer.from(expected)),
    ).toBe(0);
  });

  test("repeated reuse of the same output buffer across requests is stable", () => {
    const ingress = new addon.Ingress({
      parseCookies: true,
      parseQuery: true,
      https: true,
      emitMetadataJson: true,
    });

    const out = new Uint8Array(131072);
    for (let i = 0; i < 500; i++) {
      const r = randRequest();
      const written = ingress.handleRequestFullSyncInto(
        r.method,
        r.url,
        r.ip,
        r.rid,
        r.headers,
        r.body,
        out,
      );
      const got = Buffer.from(out.subarray(0, written)).toString("base64");
      // A fresh allocating call must agree with the pooled call every time.
      const expected = ingress.handleRequestFullSync(
        r.method,
        r.url,
        r.ip,
        r.rid,
        r.headers,
        r.body,
        131072,
      );
      expect(got).toBe(Buffer.from(expected).toString("base64"));
    }
  });
});
