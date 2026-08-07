// rust/test_support.rs — Shared helpers for Rust unit tests (`cargo test`).
//
// Only compiled when running tests. Each module's `#[cfg(test)] mod tests`
// imports whatever it needs from here instead of redefining it.

/// Build a packed header buffer:
/// `[u16 count] repeated { [u16 name_len][name][u32 val_len][val] }`.
pub(crate) fn pack_headers<'a, I>(pairs: I) -> Vec<u8>
where
    I: IntoIterator<Item = (&'a str, &'a str)>,
{
    let pairs: Vec<(&str, &str)> = pairs.into_iter().collect();
    let mut out = Vec::new();
    out.extend_from_slice(&(pairs.len() as u16).to_le_bytes());
    for (name, value) in pairs {
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&(value.len() as u32).to_le_bytes());
        out.extend_from_slice(value.as_bytes());
    }
    out
}

/// Decode a packed pairs buffer:
/// `[u32 count] repeated { [u32 key_len][key][u32 val_len][val] }`.
pub(crate) fn decode_packed_pairs(packed: &[u8]) -> Vec<(Vec<u8>, Vec<u8>)> {
    assert!(packed.len() >= 4, "packed buffer too short");
    let count = u32::from_le_bytes([packed[0], packed[1], packed[2], packed[3]]) as usize;
    let mut out = Vec::with_capacity(count);
    let mut pos = 4usize;
    for _ in 0..count {
        let key_len =
            u32::from_le_bytes([packed[pos], packed[pos + 1], packed[pos + 2], packed[pos + 3]])
                as usize;
        pos += 4;
        let key = packed[pos..pos + key_len].to_vec();
        pos += key_len;
        let val_len =
            u32::from_le_bytes([packed[pos], packed[pos + 1], packed[pos + 2], packed[pos + 3]])
                as usize;
        pos += 4;
        let val = packed[pos..pos + val_len].to_vec();
        pos += val_len;
        out.push((key, val));
    }
    out
}

/// Deterministic xorshift PRNG so fuzz-style tests are reproducible.
pub(crate) struct Rng(pub u64);

impl Rng {
    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    pub fn bytes(&mut self, len: usize) -> Vec<u8> {
        (0..len).map(|_| self.next() as u8).collect()
    }
}
