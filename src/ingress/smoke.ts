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

  try {
    const result = await ingress(req, "127.0.0.1");
    console.log("continue result:", result);
  } catch (err) {
    if (err instanceof Response) {
      console.log("Response thrown:", err.status);
      console.log(await err.text());
    } else {
      throw err;
    }
  }

  // Preflight example
  const preflight = new Request("https://api.example.com/users", {
    method: "OPTIONS",
    headers: {
      origin: "https://app.example.com",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });

  try {
    await ingress(preflight, "127.0.0.1");
  } catch (err) {
    if (err instanceof Response) {
      console.log("Preflight response:", err.status);
      console.log([...err.headers.entries()]);
    } else {
      throw err;
    }
  }
}

main().catch(console.error);