import { rust } from "../../rust-ffi";
import type { BenchTask } from "../types";

export function routingTasks(): BenchTask[] {
  const router = rust.createRouter([
    "/ping",
    "/api/v1/health",
    "/users/{id}",
    "/users/{id}/posts/{postId}",
    "/files/{*wildcard}",
  ]);

  const staticPath = "/api/v1/health";
  const paramPath = "/users/42/posts/7";
  const wildcardPath = "/files/docs/2026/readme.md";

  return [
    {
      name: "rust:router_match_id_static",
      run: () => router.matchId(staticPath) ?? -1,
      iterations: 10_000,
      warmup: 1_000,
    },
    {
      name: "rust:router_match_id_param",
      run: () => router.matchId(paramPath) ?? -1,
      iterations: 10_000,
      warmup: 1_000,
    },
    {
      name: "rust:router_match_id_wildcard",
      run: () => router.matchId(wildcardPath) ?? -1,
      iterations: 10_000,
      warmup: 1_000,
    },
    {
      name: "rust:router_match_params",
      run: () => router.match(paramPath)?.routeId ?? -1,
      iterations: 10_000,
      warmup: 1_000,
    },
    {
      name: "rust:router_match_wildcard_params",
      run: () => router.match(wildcardPath)?.routeId ?? -1,
      iterations: 10_000,
      warmup: 1_000,
    },
  ];
}