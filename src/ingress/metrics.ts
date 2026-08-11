// src/ingress/metrics.ts — Ingress observability wiring (zero-dep).
//
// `createIngressMetrics()` builds a {@link MetricsRegistry} and returns the
// `onRequest`/`onResponse`/`onError` hooks to pass into `createIngressHandler`'s
// runtime, so every request is counted + latency-histogrammed. Expose the
// numbers at a `/metrics` endpoint with {@link metricsHandler} (Prometheus text
// format), served by both `createIngressServer` (Bun) and
// `createIngressServerNode` (Node).
//
//   const m = createIngressMetrics();
//   const ingress = createIngressHandler(options, { ...m.runtime });
//   const srv = createIngressServer({ routes: {
//     "/health": { read: livenessHandler() },
//     "/metrics": { read: metricsHandler(m) },
//   }});

import { createMetrics, DEFAULT_BUCKETS, type MetricsRegistry } from "../shared/metrics";
import type { BakedIngressResult } from "./decode/baked-result";
import type { BakedIngressRuntime } from "./handlers";

/** The runtime hooks + registry for ingress metrics. */
export interface IngressMetrics {
  registry: MetricsRegistry;
  /** Pass as the runtime to `createIngressHandler`. */
  runtime: Pick<BakedIngressRuntime, "onRequest" | "onResponse" | "onError">;
  /** Render the Prometheus exposition. */
  render(): string;
}

/**
 * Build ingress request/error/latency metrics wired to the pre-baked handler
 * runtime hooks. Metric names follow the Prometheus `castrum_http_*` scheme.
 */
export function createIngressMetrics(): IngressMetrics {
  const registry = createMetrics();

  const requestsTotal = registry.counter(
    "castrum_http_requests_total",
    "Total ingress requests processed.",
    ["method", "status"],
  );
  const requestDuration = registry.histogram(
    "castrum_http_request_duration_seconds",
    "Ingress request latency in seconds.",
    DEFAULT_BUCKETS,
    ["method", "status"],
  );
  const errorsTotal = registry.counter(
    "castrum_http_errors_total",
    "Total internal/terminal errors.",
    ["code"],
  );
  const rateLimitedTotal = registry.counter(
    "castrum_http_rate_limited_total",
    "Total requests rejected by the rate limiter (429).",
  );
  const inFlight = registry.gauge(
    "castrum_http_in_flight_requests",
    "Requests currently being processed.",
  );

  const statusLabel = (status: number): string => String(status);

  return {
    registry,
    runtime: {
      onRequest(_req, _requestId, _ip) {
        inFlight.inc();
      },
      onResponse(req, result: BakedIngressResult, status, _requestId) {
        inFlight.dec();
        const method = req.method ?? "unknown";
        const statusKey = statusLabel(status);
        requestsTotal.inc({ method, status: statusKey });
        const started = (result as BakedIngressResult & { startTime?: number })
          .startTime;
        const durationMs = started ? Date.now() - started : 0;
        requestDuration.observe(Math.max(durationMs, 0) / 1000, {
          method,
          status: statusKey,
        });
        if (result.rateLimited) rateLimitedTotal.inc();
      },
      onError(_req, _requestId, error) {
        inFlight.dec();
        errorsTotal.inc({ code: error?.name ?? "internal" });
      },
    },
    render() {
      return registry.render();
    },
  };
}

/**
 * Route handler exposing the registry in Prometheus text format
 * (`content-type: text/plain; version=0.0.4`). Serve it as a `read` route:
 *
 *   createIngressServer({ routes: { "/metrics": { read: metricsHandler(m) } } })
 */
export function metricsHandler(metrics: IngressMetrics) {
  return (_req: Request): Response =>
    new Response(metrics.render(), {
      status: 200,
      headers: {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "cache-control": "no-store",
      },
    });
}
