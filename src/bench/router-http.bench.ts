import { rust } from "../rust-ffi";
import { sortKeys } from "../shared/json";

type MatchitRouter = ReturnType<typeof rust.createRouter>;

type ResponseMode = "params" | "status";

interface RouterCase {
  name: string;
  bunPatterns: string[];
  matchitPatterns: string[];
  requestPath: string;
  method?: string;
  expectedStatus?: number;
  responseMode?: ResponseMode;
}

interface HttpProfile {
  name: string;
  requests: number;
  concurrency: number;
  warmup: number;
}

interface HttpMetrics {
  totalMs: number;
  rps: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
}

interface HttpResultRow extends HttpMetrics {
  case: string;
  profile: string;
  router: "bun-native" | "matchit";
}

type SimpleServer = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void;
};

const REQUESTS = Math.max(100, Number(process.env.HTTP_REQUESTS ?? 2000));
const WARMUP = Math.max(10, Number(process.env.HTTP_WARMUP ?? 200));

const STATIC_MATCHED_JSON = JSON.stringify({ matched: true });
const NOT_FOUND_BODY = "Not Found";

const profiles: HttpProfile[] = [
  {
    name: "sequential",
    requests: REQUESTS,
    concurrency: 1,
    warmup: WARMUP,
  },
  {
    name: "concurrency-10",
    requests: REQUESTS,
    concurrency: 10,
    warmup: WARMUP,
  },
  {
    name: "concurrency-50",
    requests: REQUESTS,
    concurrency: 50,
    warmup: WARMUP,
  },
];

function manyRoutesCase(count: number): RouterCase {
  const bunPatterns: string[] = [];
  const matchitPatterns: string[] = [];

  for (let i = 0; i < count; i++) {
    bunPatterns.push(`/api/${i}/items/:id`);
    matchitPatterns.push(`/api/${i}/items/{id}`);
  }

  bunPatterns.push(`/api/${count}/items/:id`);
  matchitPatterns.push(`/api/${count}/items/{id}`);

  return {
    name: `many-routes-${count + 1}`,
    bunPatterns,
    matchitPatterns,
    requestPath: `/api/${count}/items/42`,
    expectedStatus: 200,
    responseMode: "params",
  };
}

const cases: RouterCase[] = [
  {
    name: "static",
    bunPatterns: ["/ping"],
    matchitPatterns: ["/ping"],
    requestPath: "/ping",
    expectedStatus: 200,
    responseMode: "params",
  },
  {
    name: "static-deep",
    bunPatterns: ["/api/v1/health"],
    matchitPatterns: ["/api/v1/health"],
    requestPath: "/api/v1/health",
    expectedStatus: 200,
    responseMode: "params",
  },
  {
    name: "param",
    bunPatterns: ["/users/:id"],
    matchitPatterns: ["/users/{id}"],
    requestPath: "/users/42",
    expectedStatus: 200,
    responseMode: "params",
  },
  {
    name: "param-with-query",
    bunPatterns: ["/users/:id"],
    matchitPatterns: ["/users/{id}"],
    requestPath: "/users/42?expand=posts&limit=20",
    expectedStatus: 200,
    responseMode: "params",
  },
  {
    name: "two-params",
    bunPatterns: ["/users/:id/posts/:postId"],
    matchitPatterns: ["/users/{id}/posts/{postId}"],
    requestPath: "/users/42/posts/7",
    expectedStatus: 200,
    responseMode: "params",
  },

  // Bun currently does not reliably expose wildcard params via req.params.
  // So wildcard cases are benchmarked as match/no-match status cases.
  {
    name: "wildcard-status",
    bunPatterns: ["/files/*"],
    matchitPatterns: ["/files/{*wildcard}"],
    requestPath: "/files/docs/2026/readme.md",
    expectedStatus: 200,
    responseMode: "status",
  },
  {
    name: "mixed-param-wildcard-status",
    bunPatterns: ["/orgs/:orgId/files/*"],
    matchitPatterns: ["/orgs/{orgId}/files/{*wildcard}"],
    requestPath: "/orgs/9/files/a/b/c.txt",
    expectedStatus: 200,
    responseMode: "status",
  },
  {
    name: "no-match",
    bunPatterns: ["/users/:id"],
    matchitPatterns: ["/users/{id}"],
    requestPath: "/posts/42",
    expectedStatus: 404,
    responseMode: "status",
  },

  manyRoutesCase(100),
  manyRoutesCase(1000),
];

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: {
      "content-type": "application/json",
    },
  });
}

function staticMatchedResponse(): Response {
  return new Response(STATIC_MATCHED_JSON, {
    headers: {
      "content-type": "application/json",
    },
  });
}

function notFoundResponse(): Response {
  return new Response(NOT_FOUND_BODY, {
    status: 404,
    headers: {
      "content-type": "text/plain",
    },
  });
}

function normalizeBunParams(
  params: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== "string") continue;

    // Bun may expose wildcard as "*" in some versions.
    // matchit pattern uses {*wildcard}, so normalize Bun output to match.
    const normalizedKey = key === "*" ? "wildcard" : key;
    out[normalizedKey] = value;
  }

  return sortKeys(out) as Record<string, string>;
}

function pathnameFromRequestUrl(url: string): string {
  if (url.startsWith("/")) {
    const q = url.indexOf("?");
    return q === -1 ? url : url.slice(0, q);
  }

  const schemeEnd = url.indexOf("//");
  const pathStart =
    schemeEnd === -1 ? url.indexOf("/") : url.indexOf("/", schemeEnd + 2);

  if (pathStart === -1) {
    return "/";
  }

  const q = url.indexOf("?", pathStart);
  return q === -1 ? url.slice(pathStart) : url.slice(pathStart, q);
}

function startBunNativeServer(c: RouterCase): SimpleServer {
  const responseMode: ResponseMode = c.responseMode ?? "params";

  const handler =
    responseMode === "status"
      ? () => staticMatchedResponse()
      : (req: any) => jsonResponse(normalizeBunParams(req.params ?? {}));

  const routes: Record<string, any> = {};

  for (const pattern of c.bunPatterns) {
    routes[pattern] = handler;
  }

  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes,
    fetch() {
      return notFoundResponse();
    },
  } as any) as unknown as SimpleServer;
}

function startMatchitServer(c: RouterCase): {
  server: SimpleServer;
  router: MatchitRouter;
} {
  const router = rust.createRouter(c.matchitPatterns);
  const responseMode: ResponseMode = c.responseMode ?? "params";

  const server =
    responseMode === "status"
      ? Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(req) {
            const path = pathnameFromRequestUrl(req.url);
            const routeId = router.matchId(path);

            if (routeId === null) {
              return notFoundResponse();
            }

            return staticMatchedResponse();
          },
        })
      : Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(req) {
            const path = pathnameFromRequestUrl(req.url);
            const match = router.match(path);

            if (!match) {
              return notFoundResponse();
            }

            return jsonResponse(match.params ?? {});
          },
        });

  return {
    server: server as unknown as SimpleServer,
    router,
  };
}

function makeUrl(server: SimpleServer, path: string): string {
  return `http://127.0.0.1:${server.port}${path}`;
}

function sortedJsonString(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

async function assertSameResponse(
  urlA: string,
  urlB: string,
  method: string,
  expectedStatus: number,
): Promise<void> {
  const [a, b] = await Promise.all([
    fetch(urlA, { method }),
    fetch(urlB, { method }),
  ]);

  const [textA, textB] = await Promise.all([a.text(), b.text()]);

  if (a.status !== expectedStatus) {
    throw new Error(
      `Expected status ${expectedStatus} from Bun native server, got ${a.status}`,
    );
  }

  if (b.status !== expectedStatus) {
    throw new Error(
      `Expected status ${expectedStatus} from matchit server, got ${b.status}`,
    );
  }

  if (a.status !== b.status) {
    throw new Error(
      `Status mismatch: ${a.status} vs ${b.status}\nA: ${textA}\nB: ${textB}`,
    );
  }

  if (expectedStatus === 200) {
    const jsonA = sortedJsonString(JSON.parse(textA || "null"));
    const jsonB = sortedJsonString(JSON.parse(textB || "null"));

    if (jsonA !== jsonB) {
      throw new Error(`JSON mismatch:\nA: ${jsonA}\nB: ${jsonB}`);
    }
  } else if (textA !== textB) {
    throw new Error(`Body mismatch:\nA: ${textA}\nB: ${textB}`);
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx] ?? 0;
}

async function benchHttp(
  url: string,
  profile: HttpProfile,
  expectedStatus: number,
  method: string,
): Promise<HttpMetrics> {
  const requests = Math.max(1, profile.requests);
  const concurrency = Math.max(1, profile.concurrency);
  const warmup = Math.max(0, profile.warmup);

  for (let i = 0; i < warmup; i++) {
    const res = await fetch(url, { method });
    await res.text();

    if (res.status !== expectedStatus) {
      throw new Error(
        `Warmup failed: expected ${expectedStatus}, got ${res.status}`,
      );
    }
  }

  const latencies = new Float64Array(requests);
  let next = 0;

  const start = performance.now();

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= requests) break;

      const reqStart = performance.now();

      const res = await fetch(url, { method });
      await res.text();

      if (res.status !== expectedStatus) {
        throw new Error(
          `Benchmark request failed: expected ${expectedStatus}, got ${res.status}`,
        );
      }

      latencies[i] = performance.now() - reqStart;
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const totalMs = performance.now() - start;

  const sorted = Array.from(latencies).sort((a, b) => a - b);
  const avgMs = sorted.reduce((a, b) => a + b, 0) / requests;

  return {
    totalMs,
    rps: requests / (totalMs / 1000),
    avgMs,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

async function runCaseProfile(
  c: RouterCase,
  profile: HttpProfile,
): Promise<HttpResultRow[]> {
  const method = c.method ?? "GET";
  const expectedStatus = c.expectedStatus ?? 200;

  const nativeServer = startBunNativeServer(c);
  const matchit = startMatchitServer(c);

  try {
    const nativeUrl = makeUrl(nativeServer, c.requestPath);
    const matchitUrl = makeUrl(matchit.server, c.requestPath);

    await assertSameResponse(nativeUrl, matchitUrl, method, expectedStatus);

    const nativeMetrics = await benchHttp(
      nativeUrl,
      profile,
      expectedStatus,
      method,
    );

    const matchitMetrics = await benchHttp(
      matchitUrl,
      profile,
      expectedStatus,
      method,
    );

    return [
      {
        case: c.name,
        profile: profile.name,
        router: "bun-native",
        ...nativeMetrics,
      },
      {
        case: c.name,
        profile: profile.name,
        router: "matchit",
        ...matchitMetrics,
      },
    ];
  } finally {
    nativeServer.stop(true);
    matchit.server.stop(true);
    matchit.router.destroy();
  }
}

async function main(): Promise<void> {
  const rows: HttpResultRow[] = [];

  console.log("Bun native router vs Rust matchit over HTTP");
  console.log("============================================");
  console.log(`Requests per profile: ${REQUESTS}`);
  console.log(`Warmup per profile:   ${WARMUP}`);
  console.log("");

  for (const c of cases) {
    for (const profile of profiles) {
      const results = await runCaseProfile(c, profile);

      rows.push(...results);

      const native = results.find((x) => x.router === "bun-native");
      const matchit = results.find((x) => x.router === "matchit");

      if (!native || !matchit) {
        throw new Error("Missing benchmark result pair");
      }

      const rpsRatio = matchit.rps / Math.max(native.rps, 1e-9);
      const latencyRatio = native.avgMs / Math.max(matchit.avgMs, 1e-9);

      console.log(
        `${c.name} / ${profile.name}: ` +
          `bun-native ${native.rps.toFixed(1)} req/s, ` +
          `matchit ${matchit.rps.toFixed(1)} req/s, ` +
          `matchit ${rpsRatio.toFixed(2)}x throughput, ` +
          `latency ${latencyRatio.toFixed(2)}x`,
      );
    }
  }

  console.log("");
  console.table(
    rows.map((row) => ({
      case: row.case,
      profile: row.profile,
      router: row.router,
      "req/s": row.rps.toFixed(1),
      "avg ms": row.avgMs.toFixed(4),
      "p50 ms": row.p50Ms.toFixed(4),
      "p95 ms": row.p95Ms.toFixed(4),
      "total ms": row.totalMs.toFixed(1),
    })),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});