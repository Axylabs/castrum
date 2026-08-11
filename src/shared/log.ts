// src/shared/log.ts — lightweight structured logging for the ingress layer.
//
// No external dependencies. Emits one JSON object per line to a writable
// stream (default stderr), gated by the `CASTRUM_LOG_LEVEL` env var. This
// gives operators a zero-dependency way to correlate requests by request-id
// without wiring OpenTelemetry. For full control, use the `onRequest` /
// `onResponse` / `onError` runtime hooks instead.

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};

function resolveLevel(envValue: string | undefined): LogLevel {
  const v = envValue?.trim().toLowerCase();
  if (v === "debug") return "debug";
  if (v === "warn" || v === "warning") return "warn";
  if (v === "error") return "error";
  if (v === "silent" || v === "off" || v === "none") return "silent";
  return "info";
}

/**
 * A minimal structured logger. Emits `{ts, level, ...fields}` JSON lines to
 * `stream` when `level` is enabled by the ambient `CASTRUM_LOG_LEVEL`.
 */
export function createStructuredLogger(
  stream: Pick<NodeJS.WritableStream, "write"> = process.stderr,
  env: NodeJS.ProcessEnv = process.env,
) {
  const threshold = LEVEL_ORDER[resolveLevel(env.CASTRUM_LOG_LEVEL)] ?? LEVEL_ORDER.info;

  function emit(level: LogLevel, fields: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < threshold) return;
    try {
      const line = JSON.stringify({
        ts: Date.now(),
        level,
        ...fields,
      });
      stream.write(`${line}\n`);
    } catch {
      // never throw from logging
    }
  }

  return {
    /** Record one completed request. */
    request(info: {
      requestId: string;
      method: string;
      path: string;
      status: number;
      durationMs: number;
      ip?: string;
    }): void {
      emit("info", { event: "request", ...info });
    },
    error(info: {
      requestId?: string;
      method?: string;
      path?: string;
      code?: string;
      message: string;
    }): void {
      emit("error", { event: "error", ...info });
    },
  };
}
