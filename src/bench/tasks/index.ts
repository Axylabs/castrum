import type { BenchFixtures, ComplexFixtures } from "../fixtures";
import type { BenchTask, ConcurrentBenchTask, StressBenchTask } from "../types";
import { cookieTasks } from "./cookie";
import { concurrentTasks } from "./concurrent";
import { complexTasks } from "./complex";
import { hashingTasks } from "./hashing";
import { hmacTasks } from "./hmac";
import { httpTasks } from "./http";
import { jsonTasks } from "./json";
import { jsonPatchTasks } from "./json-patch";
import { mimeTasks } from "./mime";
import { queryTasks } from "./query";
import { stressTasks } from "./stress";
import { tokenTasks } from "./token";
import { urlTasks } from "./url";
import { validationTasks } from "./validation";
import { websocketTasks } from "./websocket";

export function createAllTasks(fixtures: BenchFixtures): BenchTask[] {
  return [
    ...jsonTasks(fixtures),
    ...httpTasks(fixtures),
    ...queryTasks(fixtures),
    ...cookieTasks(fixtures),
    ...tokenTasks(),
    ...websocketTasks(fixtures),
    ...jsonPatchTasks(fixtures),
    ...hmacTasks(fixtures),
    ...validationTasks(fixtures),
    ...hashingTasks(fixtures),
    ...mimeTasks(fixtures),
    ...urlTasks(fixtures),
  ];
}

export function createComplexTasks(fixtures: ComplexFixtures): BenchTask[] {
  return complexTasks(fixtures);
}

export function createConcurrentTasks(
  fixtures: BenchFixtures,
  complex: ComplexFixtures,
): ConcurrentBenchTask[] {
  return concurrentTasks(fixtures, complex);
}

export function createStressTasks(
  fixtures: BenchFixtures,
  complex: ComplexFixtures,
): StressBenchTask[] {
  return stressTasks(fixtures, complex);
}