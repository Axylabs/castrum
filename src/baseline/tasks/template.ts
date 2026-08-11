/**
 * JS baseline HTML templating: a tiny dependency-free renderer for the
 * Jinja2/`{{ }}` subset used by the benchmark fixture, producing byte-identical
 * output to the Rust minijinja renderer for that subset:
 *   - `{{ dotted.path }}` variable substitution
 *   - `{% for item in expr %}...{% endfor %}` single-level loops
 *
 * No new npm dependency is needed (handlebars would use different syntax than
 * minijinja, breaking byte-parity checks). This is a fair timing reference:
 * idiomatic JS string building vs a compiled minijinja template.
 */

function resolvePath(ctx: Record<string, unknown>, path: string): unknown {
  let cur: unknown = ctx;
  for (const part of path.split(".")) {
    const key = part.trim();
    if (
      cur !== null &&
      typeof cur === "object" &&
      key in (cur as Record<string, unknown>)
    ) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

function renderValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

function render(src: string, ctx: Record<string, unknown>): string {
  let out = "";
  let i = 0;

  while (i < src.length) {
    const varOpen = src.indexOf("{{", i);
    const tagOpen = src.indexOf("{%", i);

    if (varOpen === -1 && tagOpen === -1) {
      out += src.slice(i);
      break;
    }

    let open: number;
    let isVar: boolean;
    if (varOpen === -1) {
      open = tagOpen;
      isVar = false;
    } else if (tagOpen === -1) {
      open = varOpen;
      isVar = true;
    } else {
      open = Math.min(varOpen, tagOpen);
      isVar = varOpen < tagOpen;
    }

    out += src.slice(i, open);
    const closeToken = isVar ? "}}" : "%}";
    const close = src.indexOf(closeToken, open + 2);

    if (close === -1) {
      out += src.slice(open);
      break;
    }

    const inner = src.slice(open + 2, close).trim();

    if (isVar) {
      out += renderValue(resolvePath(ctx, inner));
      i = close + 2;
      continue;
    }

    // Tag handling: `{% for %}` … `{% endfor %}`.
    const forMatch = /^for\s+(\w+)\s+in\s+(.+)$/.exec(inner);
    if (forMatch) {
      const itemName = forMatch[1] ?? "";
      const expr = forMatch[2] ?? "";
      const endToken = "{% endfor %}";
      const endIdx = src.indexOf(endToken, close + 2);
      if (endIdx === -1) {
        out += src.slice(open);
        break;
      }
      const body = src.slice(close + 2, endIdx);
      const arr = resolvePath(ctx, (expr ?? "").trim());
      if (Array.isArray(arr)) {
        for (const item of arr) {
          out += render(body, { ...ctx, [itemName]: item });
        }
      }
      i = endIdx + endToken.length;
      continue;
    }

    // Unknown tag: emit verbatim.
    out += src.slice(open, close + 2);
    i = close + 2;
  }

  return out;
}

export function nativeTemplateRender(
  source: string,
  context: Record<string, unknown>,
): string {
  return render(source, context);
}
