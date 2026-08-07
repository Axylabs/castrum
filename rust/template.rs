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
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let out = tpl
            .render(&context)
            .map_err(|e| Error::from_reason(format!("template render failed: {e}")))?;
        Ok(Buffer::from(out.into_bytes()))
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
}
