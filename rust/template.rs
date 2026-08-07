// rust/template.rs — HTML/text templating via minijinja.
//
// Backend-framework feature: server-side templating. minijinja is a fast, safe,
// Jinja2-compatible engine (no eval, no unsafe). Templates are compiled once and
// cached inside the `Environment`; renders accept a `serde_json::Value` context.
//
// The napi class keeps an owned `Environment<'static>` (templates added via
// `add_template_owned`), so it is `Send + Sync` and safe to hold across calls.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::util::{should_parallelize, total_bytes, unpack};

/// A compiled template renderer. Construct once per template, render many times
/// with different contexts.
#[napi]
pub struct TemplateRenderer {
    // Owns the compiled template state (templates added via add_template_owned).
    env: minijinja::Environment<'static>,
}

#[napi]
impl TemplateRenderer {
    #[napi(constructor)]
    pub fn new(source: String) -> Result<Self> {
        let mut env = minijinja::Environment::new();
        env.add_template_owned("main", source)
            .map_err(|e| Error::from_reason(format!("template compile failed: {e}")))?;
        Ok(Self { env })
    }

    /// Render the template with the given JSON context → UTF-8 bytes.
    #[napi]
    pub fn render(&self, context: serde_json::Value) -> Result<Buffer> {
        let tpl = self
            .env
            .get_template("main")
            .map_err(|e| Error::from_reason(format!("template compile failed: {e}")))?;
        let out = tpl
            .render(&context)
            .map_err(|e| Error::from_reason(format!("template render failed: {e}")))?;
        Ok(Buffer::from(out.into_bytes()))
    }

    /// Parallel render batch: packed `[u32 count]{[u32 len][context-json]}` in
    /// → packed `[u32 count]{[u32 len][rendered]}` out. The compiled template
    /// is fetched ONCE and reused for every item — no per-call recompilation.
    #[napi]
    pub fn render_batch_packed(&self, data: Uint8Array) -> Result<Buffer> {
        let items = unpack(data.as_ref())?;

        // get_template is a cheap internal Arc lookup — the expensive part
        // (compiling the template) happened once in the constructor.
        let tpl = self
            .env
            .get_template("main")
            .map_err(|e| Error::from_reason(format!("template compile failed: {e}")))?;

        let render_one = |context_json: &[u8]| -> Vec<u8> {
            let Ok(context) = serde_json::from_slice::<serde_json::Value>(context_json) else {
                return Vec::new();
            };
            tpl.render(&context)
                .map(|s| s.into_bytes())
                .unwrap_or_default()
        };

        let mut out = Vec::with_capacity(4 + items.len() * 32);
        out.extend_from_slice(&(items.len() as u32).to_le_bytes());

        if should_parallelize(items.len(), total_bytes(&items)) {
            use rayon::prelude::*;
            let results: Vec<Vec<u8>> = items.par_iter().map(|c| render_one(c)).collect();
            for r in results {
                out.extend_from_slice(&(r.len() as u32).to_le_bytes());
                out.extend_from_slice(&r);
            }
        } else {
            for c in items {
                let r = render_one(c);
                out.extend_from_slice(&(r.len() as u32).to_le_bytes());
                out.extend_from_slice(&r);
            }
        }

        Ok(Buffer::from(out))
    }
}

/// Parallel render batch: packed `[u32 count]{[u32 len][context-json]}` in →
/// packed `[u32 count]{[u32 len][rendered]}` out. A new `TemplateRenderer` is
/// built once per call from `source`, then all contexts render in parallel.
#[napi]
pub fn template_render_batch_packed(
    data: Uint8Array,
    source: String,
) -> Result<Buffer> {
    let items = unpack(data.as_ref())?;

    let mut env = minijinja::Environment::new();
    env.add_template_owned("main", source)
        .map_err(|e| Error::from_reason(format!("template compile failed: {e}")))?;

    let render_one = |context_json: &[u8]| -> Vec<u8> {
        let Ok(context) = serde_json::from_slice::<serde_json::Value>(context_json) else {
            return Vec::new();
        };
        let Ok(tpl) = env.get_template("main") else {
            return Vec::new();
        };
        tpl.render(&context)
            .map(|s| s.into_bytes())
            .unwrap_or_default()
    };

    let mut out = Vec::with_capacity(4 + items.len() * 32);
    out.extend_from_slice(&(items.len() as u32).to_le_bytes());

    if should_parallelize(items.len(), total_bytes(&items)) {
        use rayon::prelude::*;
        let results: Vec<Vec<u8>> = items.par_iter().map(|c| render_one(c)).collect();
        for r in results {
            out.extend_from_slice(&(r.len() as u32).to_le_bytes());
            out.extend_from_slice(&r);
        }
    } else {
        for c in items {
            let r = render_one(c);
            out.extend_from_slice(&(r.len() as u32).to_le_bytes());
            out.extend_from_slice(&r);
        }
    }

    Ok(Buffer::from(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn renders_variables() {
        let mut env = minijinja::Environment::new();
        env.add_template("t", "Hello {{ name }}!").unwrap();
        let tpl = env.get_template("t").unwrap();
        let mut ctx = BTreeMap::new();
        ctx.insert("name", "World");
        assert_eq!(tpl.render(ctx).unwrap(), "Hello World!");
    }

    #[test]
    fn renders_loops_over_serde_value() {
        let mut env = minijinja::Environment::new();
        env.add_template(
            "t",
            "{% for u in users %}<li>{{ u.name }} ({{ u.id }})</li>{% endfor %}",
        )
        .unwrap();
        let tpl = env.get_template("t").unwrap();

        let context = serde_json::json!({
            "users": [
                { "name": "Alice", "id": 1 },
                { "name": "Bob", "id": 2 },
            ]
        });
        let out = tpl.render(&context).unwrap();
        assert_eq!(out, "<li>Alice (1)</li><li>Bob (2)</li>");
    }

    #[test]
    fn compile_error_is_reported() {
        let mut env = minijinja::Environment::new();
        assert!(env.add_template("t", "{% for x in %}" ).is_err());
    }

    #[test]
    fn missing_variable_renders_empty() {
        let mut env = minijinja::Environment::new();
        env.add_template("t", "[{{ missing }}]").unwrap();
        let tpl = env.get_template("t").unwrap();
        let ctx = serde_json::json!({});
        assert_eq!(tpl.render(&ctx).unwrap(), "[]");
    }

    fn pack_contexts(contexts: &[serde_json::Value]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&(contexts.len() as u32).to_le_bytes());
        for c in contexts {
            let bytes = serde_json::to_vec(c).unwrap();
            out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
            out.extend_from_slice(&bytes);
        }
        out
    }

    #[test]
    fn renderer_instance_reuses_compiled_template() {
        let r = TemplateRenderer::new("Hello {{ name }}!".to_string()).unwrap();
        let ctx = serde_json::json!({ "name": "World" });
        assert_eq!(&r.render(ctx).unwrap()[..], b"Hello World!");

        // Batch path must reuse the SAME compiled template.
        let data = pack_contexts(&[
            serde_json::json!({ "name": "Alice" }),
            serde_json::json!({ "name": "Bob" }),
        ]);
        let batch = r.render_batch_packed(Uint8Array::new(data)).unwrap();
        assert_eq!(u32::from_le_bytes(batch[..4].try_into().unwrap()), 2);

        let mut pos = 4usize;
        let mut renders = Vec::new();
        for _ in 0..2 {
            let len = u32::from_le_bytes(batch[pos..pos + 4].try_into().unwrap()) as usize;
            pos += 4;
            renders.push(String::from_utf8(batch[pos..pos + len].to_vec()).unwrap());
            pos += len;
        }
        assert_eq!(
            renders,
            vec!["Hello Alice!".to_string(), "Hello Bob!".to_string()]
        );
    }

    #[test]
    fn renderer_rejects_bad_compile() {
        assert!(TemplateRenderer::new("{% for x in %}".to_string()).is_err());
    }
}
