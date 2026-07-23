import { rust } from "./native";
import { encoder, nativeBatch, nativeSha256U64, xxhash3U64 } from "./shared";

const jsonHeaders = {
    "content-type": "application/json; charset=utf-8",
};

const productId123 = encoder.encode("123");

const server = Bun.serve({
    port: Number(process.env.PORT ?? 3000),
    routes: {
        "/native/products/add": {
            POST: async (req) => {
                const body = await req.json();

                return Response.json(
                    {
                        created: true,
                        body,
                    },
                    { status: 201 },
                );
            },
        },

        "/rust/products/add": {
            POST: async (req) => {
                const bytes = new Uint8Array(await req.arrayBuffer());
                const out = new Uint8Array(256 * 1024);
                const status = new Uint16Array(1);

                const written = rust.productsAdd(bytes, out, status);

                if (written < 0) {
                    return Response.json({ error: "Rust handler failed" }, { status: 500 });
                }

                return new Response(out.slice(0, Number(written)), {
                    status: status[0] || 201,
                    headers: jsonHeaders,
                });
            },
        },

        "/native/products/123": {
            GET: () => {
                return Response.json({
                    product: {
                        id: "123",
                    },
                });
            },
        },

        "/rust/products/123": {
            GET: () => {
                const out = new Uint8Array(64 * 1024);
                const status = new Uint16Array(1);

                const written = rust.productsGetId(productId123, out, status);

                if (written < 0) {
                    return Response.json({ error: "Rust handler failed" }, { status: 500 });
                }

                return new Response(out.slice(0, Number(written)), {
                    status: status[0] || 200,
                    headers: jsonHeaders,
                });
            },
        },

        "/native/batch": {
            POST: async (req) => {
                const ops: unknown = await req.json();

                if (!Array.isArray(ops)) {
                    return Response.json(
                        { error: "Invalid batch payload" },
                        { status: 400 },
                    );
                }

                return Response.json(nativeBatch(ops));
            },
        },

        "/rust/batch": {
            POST: async (req) => {
                const bytes = new Uint8Array(await req.arrayBuffer());
                const out = new Uint8Array(2 * 1024 * 1024);
                const status = new Uint16Array(1);

                const written = rust.batchExecute(bytes, out, status);

                if (written < 0) {
                    return Response.json({ error: "Rust batch failed" }, { status: 500 });
                }

                return new Response(out.slice(0, Number(written)), {
                    status: status[0] || 200,
                    headers: jsonHeaders,
                });
            },
        },

        "/native/hash": {
            POST: async (req) => {
                const bytes = new Uint8Array(await req.arrayBuffer());

                return Response.json({
                    hash: String(xxhash3U64(bytes))
                });
            },
        },

        "/rust/hash": {
            POST: async (req) => {
                const bytes = new Uint8Array(await req.arrayBuffer());

                return Response.json({
                    hash: String(rust.xxh3(bytes)),
                });
            },
        },

        "/native/sha256": {
            POST: async (req) => {
                const bytes = new Uint8Array(await req.arrayBuffer());

                return Response.json({
                    hash: nativeSha256U64(bytes).toString(16),
                });
            },
        },

        "/rust/sha256": {
            POST: async (req) => {
                const bytes = new Uint8Array(await req.arrayBuffer());

                return Response.json({
                    hash: rust.sha256(bytes).toString(16),
                });
            },
        },
    },

    fetch() {
        return new Response("Not found", { status: 404 });
    },
});

console.log(`Benchmark server listening on http://localhost:${server.port}`);