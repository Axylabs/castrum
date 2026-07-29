// rust/core/types.rs — Pure Rust core error types and common type aliases
// No napi dependencies. Pure functional composition primitives.
//
// Use `CoreResult<T>` instead of `napi::Result<T>` throughout the core module.
// The napi adapter layer converts `CoreError` → `napi::Error` at the boundary.

use std::borrow::Cow;
use std::fmt;

// ── Error kind ──────────────────────────────────────────────────────

/// Categorization of errors that can occur in the core pipeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorKind {
    /// Input data is malformed or truncated.
    MalformedData,
    /// A buffer is too small for the required output.
    BufferTooSmall,
    /// Arithmetic or size overflow.
    Overflow,
    /// Too many items (headers, cookies, query params, etc.).
    TooManyItems,
    /// Input exceeds configured limits.
    LimitExceeded,
    /// Invalid input (bad request, invalid encoding, etc.).
    InvalidInput,
    /// Internal logic error (should not happen).
    Internal,
    /// Operation cancelled.
    Cancelled,
    /// Operation timed out.
    Timeout,
}

impl ErrorKind {
    #[inline(always)]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::MalformedData => "malformed_data",
            Self::BufferTooSmall => "buffer_too_small",
            Self::Overflow => "overflow",
            Self::TooManyItems => "too_many_items",
            Self::LimitExceeded => "limit_exceeded",
            Self::InvalidInput => "invalid_input",
            Self::Internal => "internal",
            Self::Cancelled => "cancelled",
            Self::Timeout => "timeout",
        }
    }
}

// ── Core error ──────────────────────────────────────────────────────

/// The unified error type for the entire Rust core library.
///
/// This is runtime-agnostic. Consumers (e.g., the napi adapter) can
/// convert this to their own error type via `From`/`Into`.
#[derive(Debug, Clone)]
pub enum CoreError {
    /// Input data is malformed or truncated.
    MalformedData {
        context: &'static str,
        offset: usize,
    },
    /// The provided output buffer is too small.
    BufferTooSmall {
        required: usize,
        available: usize,
    },
    /// Arithmetic or size overflow.
    Overflow {
        context: &'static str,
    },
    /// Too many items exceeded the configured limit.
    TooManyItems {
        max: usize,
        got: usize,
    },
    /// Input exceeds configured limits (size, depth, etc.).
    LimitExceeded {
        context: &'static str,
        limit: usize,
        actual: usize,
    },
    /// Invalid input (bad request, invalid encoding, etc.).
    InvalidInput {
        context: &'static str,
    },
    /// Internal logic error.
    Internal {
        msg: Cow<'static, str>,
    },
    /// Operation cancelled.
    Cancelled,
    /// Operation timed out.
    Timeout {
        elapsed_ms: u64,
    },
}

impl CoreError {
    #[inline(always)]
    pub fn kind(&self) -> ErrorKind {
        match self {
            Self::MalformedData { .. } => ErrorKind::MalformedData,
            Self::BufferTooSmall { .. } => ErrorKind::BufferTooSmall,
            Self::Overflow { .. } => ErrorKind::Overflow,
            Self::TooManyItems { .. } => ErrorKind::TooManyItems,
            Self::LimitExceeded { .. } => ErrorKind::LimitExceeded,
            Self::InvalidInput { .. } => ErrorKind::InvalidInput,
            Self::Internal { .. } => ErrorKind::Internal,
            Self::Cancelled => ErrorKind::Cancelled,
            Self::Timeout { .. } => ErrorKind::Timeout,
        }
    }
}

impl fmt::Display for CoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MalformedData { context, offset } => {
                write!(f, "malformed data at offset {}: {}", offset, context)
            }
            Self::BufferTooSmall { required, available } => {
                write!(
                    f,
                    "buffer too small: need {} bytes but only {} available",
                    required, available
                )
            }
            Self::Overflow { context } => {
                write!(f, "overflow: {}", context)
            }
            Self::TooManyItems { max, got } => {
                write!(f, "too many items: max {} but got {}", max, got)
            }
            Self::LimitExceeded {
                context,
                limit,
                actual,
            } => {
                write!(
                    f,
                    "limit exceeded: {} limit {} actual {}",
                    context, limit, actual
                )
            }
            Self::InvalidInput { context } => {
                write!(f, "invalid input: {}", context)
            }
            Self::Internal { msg } => {
                write!(f, "internal error: {}", msg)
            }
            Self::Cancelled => write!(f, "cancelled"),
            Self::Timeout { elapsed_ms } => {
                write!(f, "timeout after {}ms", elapsed_ms)
            }
        }
    }
}

impl std::error::Error for CoreError {}

// ── Convenience constructors ────────────────────────────────────────

#[inline(always)]
pub fn malformed_data(context: &'static str, offset: usize) -> CoreError {
    CoreError::MalformedData { context, offset }
}

#[inline(always)]
pub fn buffer_too_small(required: usize, available: usize) -> CoreError {
    CoreError::BufferTooSmall { required, available }
}

#[inline(always)]
pub fn overflow(context: &'static str) -> CoreError {
    CoreError::Overflow { context }
}

#[inline(always)]
pub fn too_many_items(max: usize, got: usize) -> CoreError {
    CoreError::TooManyItems { max, got }
}

#[inline(always)]
pub fn limit_exceeded(context: &'static str, limit: usize, actual: usize) -> CoreError {
    CoreError::LimitExceeded {
        context,
        limit,
        actual,
    }
}

#[inline(always)]
pub fn invalid_input(context: &'static str) -> CoreError {
    CoreError::InvalidInput { context }
}

#[inline(always)]
pub fn internal_error(msg: impl Into<Cow<'static, str>>) -> CoreError {
    CoreError::Internal { msg: msg.into() }
}

// ── Result alias ────────────────────────────────────────────────────

/// The standard Result type for the entire Rust core library.
pub type CoreResult<T> = Result<T, CoreError>;

// ── Functional composition primitives ───────────────────────────────

/// A composable pipeline that transforms input `I` to output `O`.
///
/// ```ignore
/// let pipeline = Pipeline::new(parse_input)
///     .then(validate)
///     .then(transform)
///     .then(format_output);
///
/// let result = pipeline.run(input)?;
/// ```
pub struct Pipeline<I, O> {
    inner: Box<dyn Fn(I) -> CoreResult<O> + Send + Sync>,
}

impl<I, O> Pipeline<I, O> {
    /// Create a new pipeline from a function.
    #[inline]
    pub fn new<F>(f: F) -> Self
    where
        F: Fn(I) -> CoreResult<O> + Send + Sync + 'static,
    {
        Self {
            inner: Box::new(f),
        }
    }

    /// Chain another transformation.
    #[inline]
    pub fn then<I2, F>(self, f: F) -> Pipeline<I, I2>
    where
        O: 'static,
        F: Fn(O) -> CoreResult<I2> + Send + Sync + 'static,
        I: 'static,
        I2: 'static,
    {
        let prev = self.inner;
        Pipeline {
            inner: Box::new(move |input| {
                let intermediate = prev(input)?;
                f(intermediate)
            }),
        }
    }

    /// Run the pipeline with the given input.
    #[inline]
    pub fn run(&self, input: I) -> CoreResult<O> {
        (self.inner)(input)
    }
}

impl<I, O> Clone for Pipeline<I, O>
where
    I: 'static,
    O: 'static,
{
    fn clone(&self) -> Self {
        // Note: We cannot clone boxed closures directly.
        // For true cloning, use Arc-based dispatch instead.
        // This is a simplified version that works for most use cases.
        panic!("Pipeline::clone() is not supported — use Arc<Pipeline> for shared ownership");
    }
}

// ── Unit type for void pipelines ────────────────────────────────────

/// Empty input/output for pipelines that produce or consume no data.
pub type Unit = ();

#[inline(always)]
pub fn unit() -> Unit {}