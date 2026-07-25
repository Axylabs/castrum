import { rust } from "./src/rust-ffi/raw";

// ------------------------------------------------------------------
// Route table (shared, passed from JS to both routers)
// ------------------------------------------------------------------
const ROUTES = [
    "/",
    "/health",
    "/ready",
    "/metrics",
    "/api/v1/users",
    "/api/v1/users/:id",
    "/api/v1/users/:id/posts",
    "/api/v1/users/:id/posts/:postId",
    "/api/v1/products",
    "/api/v1/products/:id",
    "/api/v1/products/:id/reviews",
    "/api/v1/search",
    "/api/v2/graphql",
    "/auth/login",
    "/auth/logout",
    "/auth/callback",
    "/users/me",
    "/users/me/settings",
    "/admin/dashboard",
    "/admin/users",
    "/admin/users/:id",
    "/admin/settings",
    "/files/:id",
    "/files/:id/download",
    "/ws/health",
    "/api/external/:service/:action",
];

// Pre-bake handlers so we aren't measuring Response creation.
const HANDLERS = ROUTES.map(() => () => new Response("ok"));

// Mix of static hits, param hits, and misses.
const PATHS = [
    "/",
    "/health",
    "/api/v1/users",
    "/api/v1/users/123",
    "/api/v1/users/123/posts",
    "/api/v1/users/123/posts/456",
    "/api/v1/products/abc",
    "/api/v1/products/abc/reviews",
    "/auth/login",
    "/users/me/settings",
    "/admin/users/789",
    "/files/abc123/download",
    "/api/external/github/webhook",
    "/notfound",
    "/api/v1/users/123/posts/456/extra",
];

// ------------------------------------------------------------------
// Server A: Bun native router (zero JS fetch-handler overhead)
// ------------------------------------------------------------------
function createBunNativeServer() {
    const table: Record<string, () => Response> = {};
    for (let i = 0; i < ROUTES.length; i++) table[ROUTES[i]] = HANDLERS[i];
    return Bun.serve({ port: 0, routes: table });
}

// ------------------------------------------------------------------
// Server B: Rust matchit inside a fetch handler
// ------------------------------------------------------------------
function createRustRouterServer() {
    const router = rust.createRouter(ROUTES);
    return Bun.serve({
        port: 0,
        fetch(req) {
            // Real-world user-land router pays the URL-parse + FFI cost.
            const path = new URL(req.url).pathname;
            const idx = router.matchRoute(path);
             if (idx >= 0) return HANDLERS[idx]();
            return new Response("not found", { status: 404 });
        },
    });
}

// ------------------------------------------------------------------
// Benchmark driver
// ------------------------------------------------------------------
async function hammer(
    label: string,
    origin: string,
    durationMs: number,
    concurrency: number,
) {
    const deadline = performance.now() + durationMs;
    const pathCount = PATHS.length;

    const worker = async () => {
        let ops = 0;
        let i = 0;
        while (performance.now() < deadline) {
            const res = await fetch(origin + PATHS[i % pathCount]);
            if (res.status === 200) ops++;
            i++;
        }
        return ops;
    };

    const totals = await Promise.all(
        Array.from({ length: concurrency }, worker),
    );
    const totalOps = totals.reduce((a, b) => a + b, 0);
    return (totalOps / durationMs) * 1000;
}

// ------------------------------------------------------------------
// Run
// ------------------------------------------------------------------
async function main() {
    console.log(`Routes : ${ROUTES.length}`);
    console.log(`Paths  : ${PATHS.length}\n`);

    // Warm-up to stabilise JIT / FFI trampolines
    console.log("Warming up…");
    const w1 = createBunNativeServer();
    await hammer("bun-warm", w1.url.origin, 500, 20);
    w1.stop();

    const w2 = createRustRouterServer();
    await hammer("rust-warm", w2.url.origin, 500, 20);
    w2.stop();

    // Real benchmark
    const DURATION = 3000;
    const CONCURRENCY = 50;

    console.log(
        `\nBenchmarking ${CONCURRENCY} concurrent clients × ${DURATION}ms…\n`,
    );

    const bun = createBunNativeServer();
    const bunRps = await hammer("Bun native", bun.url.origin, DURATION, CONCURRENCY);
    bun.stop();

    const rust = createRustRouterServer();
    const rustRps = await hammer("Rust matchit", rust.url.origin, DURATION, CONCURRENCY);
    rust.stop();

    console.log("Results");
    console.log(`  Bun native router : ${bunRps.toFixed(0).padStart(10)} req/s`);
    console.log(`  Rust matchit      : ${rustRps.toFixed(0).padStart(10)} req/s`);
    console.log(`  Rust / Bun ratio  : ${(rustRps / bunRps).toFixed(2)}x`);
}

main().catch(console.error);