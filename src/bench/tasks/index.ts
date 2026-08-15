// src/bench/tasks/index.ts — CPU benchmark task composers (barrel).
//
// Each `*Tasks` factory builds the benchmark tasks for one op family
// (hashing, json, http, query, ...). Bench-only.

import type { BenchFixtures, ComplexFixtures } from '../fixtures'
import type { BenchTask, ConcurrentBenchTask, StressBenchTask } from '../types'
import { acceptTasks } from './accept'
// Backend-framework feature tasks
import { aeadTasks } from './aead'
import { bunBuiltinsTasks } from './bun-builtins'
import { complexTasks } from './complex'
import { compressTasks } from './compress'
import { concurrentTasks } from './concurrent'
import { cookieTasks } from './cookie'
import { cookieSignTasks } from './cookie-sign'
import { csrfTasks } from './csrf'
import { encodingTasks } from './encoding'
import { etagTasks } from './etag'
import { formTasks } from './form'
import { hashingTasks } from './hashing'
import { hmacTasks } from './hmac'
import { httpTasks } from './http'
import { intoTasks } from './into'
import { jsonTasks } from './json'
import { jsonPatchTasks } from './json-patch'
import { jsonSchemaTasks } from './json-schema'
import { jwtTasks } from './jwt'
import { loaderTasks } from './loader'
import { mediaTypeTasks } from './media-type'
import { mimeTasks } from './mime'
import { multipartTasks } from './multipart'
import { passwordTasks } from './password'
import { queryTasks } from './query'
import { streamingTasks } from './streaming'
import { stressTasks } from './stress'
import { templateTasks } from './template'
import { tokenTasks } from './token'
import { urlTasks } from './url'
import { urlJoinTasks } from './url-join'
import { validationTasks } from './validation'
import { websocketTasks } from './websocket'

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
    // Pooled zero-alloc `*Into` FFI ops (best-case crossing, no per-call alloc)
    ...intoTasks(fixtures),
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
