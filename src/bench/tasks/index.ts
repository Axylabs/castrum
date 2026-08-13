// src/bench/tasks/index.ts — CPU benchmark task composers (barrel).
//
// Each `*Tasks` factory builds the benchmark tasks for one op family
// (hashing, json, http, query, ...). Bench-only.

import type { BenchFixtures, ComplexFixtures } from '../fixtures'
import type { BenchTask, ConcurrentBenchTask, StressBenchTask } from '../types'
import { cookieTasks } from './cookie'
import { concurrentTasks } from './concurrent'
import { complexTasks } from './complex'
import { encodingTasks } from './encoding'
import { etagTasks } from './etag'
import { formTasks } from './form'
import { hashingTasks } from './hashing'
import { hmacTasks } from './hmac'
import { httpTasks } from './http'
import { jsonTasks } from './json'
import { jsonSchemaTasks } from './json-schema'
import { jsonPatchTasks } from './json-patch'
import { loaderTasks } from './loader'
import { mediaTypeTasks } from './media-type'
import { mimeTasks } from './mime'
import { queryTasks } from './query'
import { stressTasks } from './stress'
import { tokenTasks } from './token'
import { urlTasks } from './url'
import { validationTasks } from './validation'
import { websocketTasks } from './websocket'
// Backend-framework feature tasks
import { aeadTasks } from './aead'
import { acceptTasks } from './accept'
import { compressTasks } from './compress'
import { cookieSignTasks } from './cookie-sign'
import { csrfTasks } from './csrf'
import { jwtTasks } from './jwt'
import { multipartTasks } from './multipart'
import { passwordTasks } from './password'
import { streamingTasks } from './streaming'
import { templateTasks } from './template'
import { urlJoinTasks } from './url-join'
import { bunBuiltinsTasks } from './bun-builtins'

export function createAllTasks(fixtures: BenchFixtures): BenchTask[] {
  return [
    ...jsonTasks(fixtures),
    ...jsonSchemaTasks(fixtures),
    ...httpTasks(fixtures),
    ...queryTasks(fixtures),
    ...formTasks(fixtures),
    ...mediaTypeTasks(fixtures),
    ...etagTasks(fixtures),
    ...acceptTasks(fixtures),
    ...encodingTasks(fixtures),
    ...cookieSignTasks(fixtures),
    ...csrfTasks(fixtures),
    ...cookieTasks(fixtures),
    ...tokenTasks(),
    ...websocketTasks(fixtures),
    ...jsonPatchTasks(fixtures),
    ...hmacTasks(fixtures),
    ...validationTasks(fixtures),
    ...hashingTasks(fixtures),
    ...mimeTasks(fixtures),
    ...urlTasks(fixtures),
    // Backend-framework feature tasks
    ...jwtTasks(fixtures),
    ...passwordTasks(fixtures),
    ...aeadTasks(fixtures),
    ...compressTasks(fixtures),
    ...multipartTasks(fixtures),
    ...templateTasks(fixtures),
    ...streamingTasks(fixtures),
    ...urlJoinTasks(fixtures),
    // Diagnostic: castrum vs Bun built-ins (diag: task names — never audited)
    ...bunBuiltinsTasks(fixtures),
  ]
}

export function createComplexTasks(fixtures: ComplexFixtures): BenchTask[] {
  return [...complexTasks(fixtures), ...loaderTasks(fixtures)]
}

export function createConcurrentTasks(
  fixtures: BenchFixtures,
  complex: ComplexFixtures,
): ConcurrentBenchTask[] {
  return concurrentTasks(fixtures, complex)
}

export function createStressTasks(
  fixtures: BenchFixtures,
  complex: ComplexFixtures,
): StressBenchTask[] {
  return stressTasks(fixtures, complex)
}
