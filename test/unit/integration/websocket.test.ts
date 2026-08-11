/**
 * Tests for src/integration/websocket.ts — the RFC 6455 upgrade helper.
 */

import { describe, test, expect } from "bun:test";
import { createWebSocketUpgrade } from "../../../src/integration";

function wsReq(path = "/ws", headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:9999${path}`, {
    headers: { "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers },
  });
}

describe("createWebSocketUpgrade", () => {
  test("returns a 101 with the RFC 6455 accept key", () => {
    // RFC 6455 §1.3 example: key "dGhlIHNhbXBsZSBub25jZQ==" →
    // accept "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" (verified against node:crypto).
    const up = createWebSocketUpgrade(wsReq());
    expect(up).not.toBeNull();
    expect(up?.response.status).toBe(101);
    expect(up?.response.headers.get("sec-websocket-accept")).toBe(
      "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
    );
    expect(up?.key).toBe("dGhlIHNhbXBsZSBub25jZQ==");
    expect(up?.protocol).toBeNull();
  });

  test("returns null when the key is missing", () => {
    const up = createWebSocketUpgrade(
      new Request("http://localhost:9999/ws", { headers: {} }),
    );
    expect(up).toBeNull();
  });

  test("returns null when the key is empty", () => {
    const up = createWebSocketUpgrade(
      wsReq("/ws", { "sec-websocket-key": "" }),
    );
    expect(up).toBeNull();
  });

  test("negotiates a matching subprotocol", () => {
    const up = createWebSocketUpgrade(
      wsReq("/ws", { "sec-websocket-protocol": "chat, superchat" }),
      { protocols: ["chat"] },
    );
    expect(up).not.toBeNull();
    expect(up?.protocol).toBe("chat");
    expect(up?.response.headers.get("sec-websocket-protocol")).toBe("chat");
  });

  test("protocol negotiation is case-insensitive", () => {
    const up = createWebSocketUpgrade(
      wsReq("/ws", { "sec-websocket-protocol": "CHAT" }),
      { protocols: ["chat"] },
    );
    expect(up?.protocol).toBe("chat");
  });

  test("does not echo an unsupported subprotocol", () => {
    const up = createWebSocketUpgrade(
      wsReq("/ws", { "sec-websocket-protocol": "bogus" }),
      { protocols: ["chat"] },
    );
    expect(up?.protocol).toBeNull();
    expect(up?.response.headers.get("sec-websocket-protocol")).toBeNull();
  });
});
