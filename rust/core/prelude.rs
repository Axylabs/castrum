// rust/core/prelude.rs — Common imports for all core modules
//
// Usage: `use crate::core::prelude::*;`
// This provides all the common types and functions used across the core.

pub use crate::core::types::{
    CoreError, CoreResult, ErrorKind, Pipeline,
    malformed_data, buffer_too_small, overflow, too_many_items,
    limit_exceeded, invalid_input, internal_error,
};
