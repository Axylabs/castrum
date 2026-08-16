// src/bench/tasks/template.ts — CPU benchmark tasks: template rendering.

import * as native from '../../baseline'
import { rust } from '../../rust-ffi'
import { encoder } from '../../shared/bytes'
import type { BenchFixtures } from '../fixtures'
import type { BenchTask } from '../types'

export function templateTasks(f: BenchFixtures): BenchTask[] {
  // Compile once (like real usage), render many times.
  const renderer = rust.createTemplateRenderer(f.templateSource)
  // Pre-serialized context (the byte-JSON overload's input).
  const contextJson = encoder.encode(JSON.stringify(f.templateContext))

  return [
    {
      name: 'native:template_render',
      run: () => native.nativeTemplateRender(f.templateSource, f.templateContext).length,
      iterations: 200,
      warmup: 20,
    },
    {
      name: 'rust:template_render',
      run: () => renderer.render(f.templateContext).byteLength,
      iterations: 200,
      warmup: 20,
    },
    {
      name: 'rust:template_render_bytes',
      run: () => renderer.renderBytes(contextJson).byteLength,
      iterations: 200,
      warmup: 20,
    },
  ]
}
