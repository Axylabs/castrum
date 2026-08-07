import * as native from "../../baseline";
import { rust } from "../../rust-ffi";
import type { BenchFixtures } from "../fixtures";
import type { BenchTask } from "../types";

export function templateTasks(f: BenchFixtures): BenchTask[] {
  // Compile once (like real usage), render many times.
  const renderer = rust.createTemplateRenderer(f.templateSource);

  return [
    {
      name: "native:template_render",
      run: () =>
        native
          .nativeTemplateRender(f.templateSource, f.templateContext)
          .length,
      iterations: 200,
      warmup: 20,
    },
    {
      name: "rust:template_render",
      run: () => renderer.render(f.templateContext).byteLength,
      iterations: 200,
      warmup: 20,
    },
  ];
}
