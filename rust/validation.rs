use crate::ffi::{catch_or, input_bytes};
use email_address::EmailAddress;
use std::str::FromStr;
use uuid::Uuid;

#[no_mangle]
pub extern "C" fn rust_validate_email_v2(ptr: *const u8, len: usize) -> i32 {
    catch_or(0, || {
        let input = input_bytes(ptr, len);
        let email = String::from_utf8_lossy(input);

        if EmailAddress::is_valid(&email) {
            1
        } else {
            0
        }
    })
}

#[no_mangle]
pub extern "C" fn rust_validate_uuid_v2(ptr: *const u8, len: usize) -> i32 {
    catch_or(0, || {
        let input = input_bytes(ptr, len);
        let text = String::from_utf8_lossy(input);

        match Uuid::parse_str(&text) {
            Ok(u) => {
                if u.get_version_num() == 4 && matches!(u.get_variant(), uuid::Variant::RFC4122) {
                    1
                } else {
                    0
                }
            }
            Err(_) => 0,
        }
    })
}

#[no_mangle]
pub extern "C" fn rust_validate_ipv4_v2(ptr: *const u8, len: usize) -> i32 {
    catch_or(0, || {
        let input = input_bytes(ptr, len);
        let text = String::from_utf8_lossy(input);

        match std::net::Ipv4Addr::from_str(&text) {
            Ok(_) => 1,
            Err(_) => 0,
        }
    })
}

#[no_mangle]
pub extern "C" fn rust_validate_ipv6_v2(ptr: *const u8, len: usize) -> i32 {
    catch_or(0, || {
        let input = input_bytes(ptr, len);
        let text = String::from_utf8_lossy(input);

        match std::net::Ipv6Addr::from_str(&text) {
            Ok(_) => 1,
            Err(_) => 0,
        }
    })
}
