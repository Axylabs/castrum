import { createIngress } from "./index";

const encoder = new TextEncoder();

const schema = encoder.encode(
  JSON.stringify({
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "number" },
      name: { type: "string" },
    },
    additionalProperties: false,
  }),
);

const ingress = createIngress({
  trustProxy: true,
  parseCookies: true,
  parseQuery: true,
  requireJsonBody: true,
  schema,
  cors: {
    allowOrigin: ["https://app.example.com"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    allowCredentials: true,
    maxAge: 86400,
  },
  rateLimit: {
    limit: 5,
    windowMs: 1000,
  },
  security: {
    hstsMaxAge: 31536000,
    hstsIncludeSubdomains: true,
    hstsPreload: true,
  },
});

async function main() {
  const req = new Request("https://api.example.com/users?limit=10&offset=0", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.example.com",
      cookie: "sid=abc123; theme=dark",
      "x-forwarded-for": "203.0.113.9, 10.0.0.1",
    },
    body: JSON.stringify({ id: 42, name: "alice" }),
  });

  const ctx = await ingress(req, "127.0.0.1");

  console.log("ingress result:", {
    status: ctx.status,
    terminal: ctx.terminal,
    ok: ctx.ok,
    verdict: ctx.verdict,
    errorCode: ctx.errorCode,
    requestId: ctx.requestId,
  });

  if (ctx.response) {
    console.log("terminal response:", ctx.response.status);
    console.log(await ctx.response.text());
  }

  const preflight = new Request("https://api.example.com/users", {
    method: "OPTIONS",
    headers: {
      origin: "https://app.example.com",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });

  const preflightCtx = await ingress(preflight, "127.0.0.1");

  console.log("preflight result:", {
    status: preflightCtx.status,
    terminal: preflightCtx.terminal,
    corsAllowed: preflightCtx.corsAllowed,
    isPreflight: preflightCtx.isPreflight,
  });

  if (preflightCtx.response) {
    console.log("preflight response:", preflightCtx.response.status);
    console.log([...preflightCtx.response.headers.entries()]);
  }
}

main().catch(console.error);