import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";
import { cookieTasks } from "./cookie";
import { hashingTasks } from "./hashing";
import { hmacTasks } from "./hmac";
import { httpTasks } from "./http";
import { jsonTasks } from "./json";
import { jsonPatchTasks } from "./json-patch";
import { mimeTasks } from "./mime";
import { queryTasks } from "./query";
import { routingTasks } from "./routing";
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
    ...routingTasks(),
    ...validationTasks(fixtures),
    ...hashingTasks(fixtures),
    ...mimeTasks(fixtures),
    ...urlTasks(fixtures),
  ];
}