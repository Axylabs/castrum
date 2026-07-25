use napi::{bindgen_prelude::*, Task};
use napi_derive::napi;

use crate::cookie_parser::cookie_parse_vec;
use crate::http_parser::http_parse_request_vec;
use crate::json_ops::{json_sum_ids_bytes, json_valid_bytes};
use crate::query_parser::query_parse_vec;

// ------------------------------------------------------------------
// JSON valid
// ------------------------------------------------------------------

pub struct JsonValidTask {
    input: Vec<u8>,
}

impl Task for JsonValidTask {
    type Output = bool;
    type JsValue = u32;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(json_valid_bytes(&self.input))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output as u32)
    }
}

#[napi]
pub fn json_valid_async(input: Uint8Array) -> AsyncTask<JsonValidTask> {
    AsyncTask::new(JsonValidTask {
        input: input.as_ref().to_vec(),
    })
}

// ------------------------------------------------------------------
// JSON sum ids
// ------------------------------------------------------------------

pub struct JsonSumIdsTask {
    input: Vec<u8>,
}

impl Task for JsonSumIdsTask {
    type Output = i64;
    type JsValue = i64;

    fn compute(&mut self) -> Result<Self::Output> {
        json_sum_ids_bytes(&self.input)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn json_sum_ids_async(input: Uint8Array) -> AsyncTask<JsonSumIdsTask> {
    AsyncTask::new(JsonSumIdsTask {
        input: input.as_ref().to_vec(),
    })
}

// ------------------------------------------------------------------
// Generic byte-output async tasks
// ------------------------------------------------------------------

macro_rules! bytes_output_task {
    ($name:ident, $func:path) => {
        pub struct $name {
            input: Vec<u8>,
        }

        impl Task for $name {
            type Output = Vec<u8>;
            type JsValue = Buffer;

            fn compute(&mut self) -> Result<Self::Output> {
                $func(&self.input)
            }

            fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
                Ok(Buffer::from(output))
            }
        }
    };
}

bytes_output_task!(HttpParseRequestTask, http_parse_request_vec);
bytes_output_task!(QueryParseTask, query_parse_vec);
bytes_output_task!(CookieParseTask, cookie_parse_vec);

#[napi]
pub fn http_parse_request_async(input: Uint8Array) -> AsyncTask<HttpParseRequestTask> {
    AsyncTask::new(HttpParseRequestTask {
        input: input.as_ref().to_vec(),
    })
}

#[napi]
pub fn query_parse_async(input: Uint8Array) -> AsyncTask<QueryParseTask> {
    AsyncTask::new(QueryParseTask {
        input: input.as_ref().to_vec(),
    })
}

#[napi]
pub fn cookie_parse_async(input: Buffer) -> AsyncTask<CookieParseTask> {
    AsyncTask::new(CookieParseTask {
        input: input.as_ref().to_vec(),
    })
}