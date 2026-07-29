import { describe, test, expect } from "bun:test";
// Must load native addon directly since tsconfig/paths work differently in test vs src
import addon from "../../src/native";
import type { AsyncIngressInstance } from "../../src/native";

describe("AsyncIngress", () => {
  test("class exists and is constructable", () => {
    const AsyncIngress = (addon as any).AsyncIngress as new (opts: Record<string, unknown>) => AsyncIngressInstance;
    expect(typeof AsyncIngress).toBe("function");
    
    const handler = new AsyncIngress({
      parseCookies: true,
      parseQuery: true,
      cors: {
        allowOrigin: ["https://example.com"],
        allowMethods: ["GET"],
        allowHeaders: [],
        exposeHeaders: [],
        allowCredentials: false,
        maxAge: 0,
      },
    });
    
    expect(handler).toBeDefined();
    expect(typeof handler.handleRequestFull).toBe("function");
  });

  test("handleRequestFull returns output buffer", async () => {
    const AsyncIngress = (addon as any).AsyncIngress as new (opts: Record<string, unknown>) => AsyncIngressInstance;
    
    const handler = new AsyncIngress({
      parseCookies: false,
      parseQuery: false,
    });

    const result = await handler.handleRequestFull(
      0, // GET
      "http://localhost:9122/health",
      "0.0.0.0",
      "abc123",
      [], // no headers
      null, // no body
    );

    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.byteLength).toBeGreaterThan(0);
    
    // Parse the output buffer
    const dv = new DataView(result.buffer, result.byteOffset, result.byteLength);
    
    // OUT_VERDICT at offset 0
    const verdict = dv.getUint8(0);
    expect(verdict).toBe(0); // should be 0 for accepted requests
    
    // OUT_STATUS at offset 2 (u16le)
    const status = dv.getUint16(2, true);
    expect(status).toBe(200);
  });

  test("handleRequestFull with headers", async () => {
    const AsyncIngress = (addon as any).AsyncIngress as new (opts: Record<string, unknown>) => AsyncIngressInstance;
    
    const handler = new AsyncIngress({
      parseCookies: true,
      parseQuery: true,
      cors: {
        allowOrigin: ["https://example.com"],
        allowMethods: ["GET"],
        allowHeaders: [],
        exposeHeaders: [],
        allowCredentials: false,
        maxAge: 0,
      },
    });

    const result = await handler.handleRequestFull(
      0, // GET
      "http://localhost:9122/api/users?page=1&limit=20",
      "127.0.0.1",
      "hex123",
      [
        ["origin", "https://example.com"],
        ["cookie", "session=abc123; theme=dark"],
      ],
      null,
    );

    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.byteLength).toBeGreaterThan(0);
    
    const dv = new DataView(result.buffer, result.byteOffset, result.byteLength);
    const status = dv.getUint16(2, true);
    expect(status).toBe(200);
  });
});