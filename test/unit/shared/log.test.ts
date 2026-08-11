/**
 * Tests for src/shared/log.ts — createStructuredLogger (previously untested).
 *
 * Uses an in-memory writable stream and a custom env so CASTRUM_LOG_LEVEL
 * gating is deterministic.
 */

import { describe, test, expect } from "bun:test";
import { createStructuredLogger } from "../../../src/shared/log";

class MemoryStream {
  lines: string[] = [];
  write(chunk: string): boolean {
    this.lines.push(chunk);
    return true;
  }
}

function makeLogger(envValue: string | undefined) {
  const stream = new MemoryStream();
  const logger = createStructuredLogger(
    stream as unknown as NodeJS.WritableStream,
    { CASTRUM_LOG_LEVEL: envValue } as NodeJS.ProcessEnv,
  );
  return { logger, stream };
}

describe("createStructuredLogger", () => {
  test("info-level emits request lines with the request shape", () => {
    const { logger, stream } = makeLogger("info");
    logger.request({
      requestId: "rid",
      method: "GET",
      path: "/health",
      status: 200,
      durationMs: 1.5,
      ip: "1.2.3.4",
    });

    expect(stream.lines).toHaveLength(1);
    const line = JSON.parse(stream.lines[0] ?? "") as Record<string, unknown>;
    expect(line.level).toBe("info");
    expect(line.event).toBe("request");
    expect(line.requestId).toBe("rid");
    expect(line.status).toBe(200);
    expect(line.durationMs).toBe(1.5);
    expect(typeof line.ts).toBe("number");
  });

  test("warn level gates out info request lines", () => {
    const { logger, stream } = makeLogger("warn");
    logger.request({ requestId: "r", method: "GET", path: "/", status: 200, durationMs: 1 });
    expect(stream.lines).toHaveLength(0);

    logger.error({ requestId: "r", code: "internal", message: "boom" });
    expect(stream.lines).toHaveLength(1);
    const line = JSON.parse(stream.lines[0] ?? "") as { level: string; event: string };
    expect(line.level).toBe("error");
    expect(line.event).toBe("error");
  });

  test("silent level emits nothing", () => {
    const { logger, stream } = makeLogger("silent");
    logger.error({ message: "boom" });
    logger.request({ requestId: "r", method: "GET", path: "/", status: 500, durationMs: 1 });
    expect(stream.lines).toHaveLength(0);
  });

  test("defaults to info when the env var is unset", () => {
    const { logger, stream } = makeLogger(undefined);
    logger.request({ requestId: "r", method: "GET", path: "/", status: 200, durationMs: 1 });
    expect(stream.lines).toHaveLength(1);
  });

  test("never throws on a malformed field", () => {
    const { logger } = makeLogger("info");
    expect(() =>
      logger.request({
        requestId: "r",
        method: "GET",
        path: "/",
        status: 200,
        // circular reference would break JSON.stringify — must be swallowed
        durationMs: Number.NaN,
        ip: undefined,
      } as never),
    ).not.toThrow();
  });
});
