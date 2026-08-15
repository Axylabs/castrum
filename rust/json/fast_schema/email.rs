// rust/json/fast_schema/email.rs — Zero-DOM `format: "email"` validator.
//
// Byte-parity replica of jsonschema 0.48.5's `keywords::format::is_valid_email`
// (the default, non-IDN path used by `format: "email"`):
//
//   1. structural local-part parse via the SAME `email_address` crate
//      (`EmailAddress::from_str` — jsonschema's `parse_email(email, None)`),
//   2. then the domain is either an `[IPv6:]`/`[IPv4]` literal, or an RFC 1034
//      hostname with RFC 5891 A-label (punycode) + RFC 5892 PVALID/contextual
//      unicode-label rules.
//
// `idna` and `unicode-general-category` are the same crates/versions the
// jsonschema crate pulls in, so the two can only drift if the pinned
// `jsonschema` dep is upgraded — in that case re-verify parity here (see
// `tests.rs` for the parity corpus + property test).
//
// NOTE: only `format: "email"` (non-IDN) is supported. `format: "idn-email"`
// and every other format value keep the DOM fallback (compile returns Err).

use std::net::{Ipv4Addr, Ipv6Addr};
use std::str::FromStr;

use email_address::EmailAddress;
use idna::punycode::decode_to_string;
use unicode_general_category::{get_general_category, GeneralCategory};

/// RFC 1034 hostname chars (`a-zA-Z0-9-`).
const VALID_HOSTNAME_CHARS: [bool; 256] = {
    let mut table = [false; 256];
    let mut byte: u8 = 0;
    while byte < 255 {
        table[byte as usize] = matches!(byte, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-');
        byte += 1;
    }
    // Handle byte 255 separately to avoid overflow.
    table[255] = matches!(255u8, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-');
    table
};

#[inline]
fn is_punycode_label(label: &[u8]) -> bool {
    label.len() >= 4 && label[0] == b'x' && label[1] == b'n' && label[2] == b'-' && label[3] == b'-'
}

#[inline]
fn validate_hostname_label(label: &[u8]) -> bool {
    !label.is_empty() && label.len() <= 63 && label[0] != b'-' && *label.last().unwrap() != b'-'
}

/// RFC 1034 ASCII hostname shape: 1..=253 chars, no trailing dot, each label
/// non-empty / ≤63 / no leading or trailing hyphen, chars in `a-zA-Z0-9-`.
fn is_valid_ascii_hostname(hostname: &str) -> bool {
    let hostname_bytes = hostname.as_bytes();
    let len = hostname_bytes.len();
    if len == 0 || len > 253 || hostname_bytes[len - 1] == b'.' {
        return false;
    }

    let mut label_start = 0;
    let mut i = 0;
    while i < len {
        if hostname_bytes[i] == b'.' {
            if !validate_hostname_label(&hostname_bytes[label_start..i]) {
                return false;
            }
            label_start = i + 1;
        } else if !VALID_HOSTNAME_CHARS[hostname_bytes[i] as usize] {
            return false;
        }
        i += 1;
    }

    validate_hostname_label(&hostname_bytes[label_start..])
}

/// RFC 5892 derives the PVALID property primarily from these general categories.
fn is_idna_pvalid_category(category: GeneralCategory) -> bool {
    matches!(
        category,
        GeneralCategory::UppercaseLetter
            | GeneralCategory::LowercaseLetter
            | GeneralCategory::TitlecaseLetter
            | GeneralCategory::ModifierLetter
            | GeneralCategory::OtherLetter
            | GeneralCategory::NonspacingMark
            | GeneralCategory::SpacingMark
            | GeneralCategory::DecimalNumber
    )
}

/// RFC 5892 §2 context-aware label rules + PVALID check. Replica of
/// jsonschema 0.48.5 `validate_unicode_label`.
fn validate_unicode_label(label: &str) -> bool {
    let mut chars = label.chars().peekable();
    if let Some(&first) = chars.peek() {
        let category = get_general_category(first);
        if matches!(
            category,
            GeneralCategory::SpacingMark
                | GeneralCategory::NonspacingMark
                | GeneralCategory::EnclosingMark
        ) {
            return false;
        }
    }
    let mut previous = None;
    let mut has_katakana_middle_dot = false;
    let mut has_hiragana_katakana_han = false;
    let mut has_arabic_indic_digits = false;
    let mut has_extended_arabic_indic_digits = false;

    while let Some(current) = chars.next() {
        match current {
            // ZERO WIDTH JOINER — allowed only after a virama.
            '\u{200D}'
                if !previous.is_some_and(|prev| {
                    matches!(
                        prev,
                        '\u{094D}'
                            | '\u{09CD}'
                            | '\u{0A4D}'
                            | '\u{0ACD}'
                            | '\u{0B4D}'
                            | '\u{0BCD}'
                            | '\u{0C4D}'
                            | '\u{0CCD}'
                            | '\u{0D4D}'
                            | '\u{0DCA}'
                            | '\u{0E3A}'
                            | '\u{0F84}'
                            | '\u{1039}'
                            | '\u{1714}'
                            | '\u{1734}'
                            | '\u{17D2}'
                            | '\u{1A60}'
                            | '\u{1B44}'
                            | '\u{1BAA}'
                            | '\u{1BF2}'
                            | '\u{1BF3}'
                            | '\u{2D7F}'
                            | '\u{A806}'
                            | '\u{A8C4}'
                            | '\u{A953}'
                            | '\u{ABED}'
                            | '\u{10A3F}'
                            | '\u{11046}'
                            | '\u{1107F}'
                            | '\u{110B9}'
                            | '\u{11133}'
                            | '\u{111C0}'
                            | '\u{11235}'
                            | '\u{112EA}'
                            | '\u{1134D}'
                            | '\u{11442}'
                            | '\u{114C2}'
                            | '\u{115BF}'
                            | '\u{1163F}'
                            | '\u{116B6}'
                            | '\u{1172B}'
                            | '\u{11839}'
                            | '\u{119E0}'
                            | '\u{11A34}'
                            | '\u{11A47}'
                            | '\u{11A99}'
                            | '\u{11C3F}'
                            | '\u{11D44}'
                            | '\u{11D45}'
                            | '\u{11D97}'
                    )
                }) =>
            {
                return false;
            }
            // MIDDLE DOT — must be between 'l' and 'l'.
            '\u{00B7}' if previous != Some('l') || chars.peek() != Some(&'l') => return false,
            // Greek KERAIA — must be followed by a Greek char.
            '\u{0375}'
                if !chars
                    .peek()
                    .is_some_and(|next| ('\u{0370}'..='\u{03FF}').contains(next)) =>
            {
                return false;
            }
            // Hebrew GERESH / GERSHAYIM — must follow a Hebrew char.
            '\u{05F3}' | '\u{05F4}'
                if !previous.is_some_and(|prev| ('\u{0590}'..='\u{05FF}').contains(&prev)) =>
            {
                return false;
            }
            // KATAKANA MIDDLE DOT.
            '\u{30FB}' => has_katakana_middle_dot = true,
            // Hiragana, Katakana, or Han.
            '\u{3040}'..='\u{309F}' | '\u{30A0}'..='\u{30FF}' | '\u{4E00}'..='\u{9FFF}' => {
                has_hiragana_katakana_han = true;
            }
            // ARABIC-INDIC DIGITS.
            '\u{0660}'..='\u{0669}' => has_arabic_indic_digits = true,
            // EXTENDED ARABIC-INDIC DIGITS.
            '\u{06F0}'..='\u{06F9}' => has_extended_arabic_indic_digits = true,
            // DISALLOWED.
            '\u{0640}' | '\u{07FA}' | '\u{302E}' | '\u{302F}' | '\u{3031}' | '\u{3032}'
            | '\u{3033}' | '\u{3034}' | '\u{3035}' | '\u{303B}' => return false,
            // Contextual joiners/punctuation already validated above, plus the
            // RFC 5892 PVALID exceptions whose general category would otherwise
            // be disallowed.
            '\u{200C}' | '\u{200D}' | '\u{00B7}' | '\u{0375}' | '\u{05F3}' | '\u{05F4}'
            | '\u{06FD}' | '\u{06FE}' | '\u{0F0B}' | '\u{3007}' => {}
            // Per RFC 5892 a code point is PVALID only when it is a letter, a
            // combining mark, or a decimal digit; any other decoded code point
            // is disallowed.
            other if !other.is_ascii() && !is_idna_pvalid_category(get_general_category(other)) => {
                return false;
            }
            _ => {}
        }
        previous = Some(current);
    }

    if (has_katakana_middle_dot && !has_hiragana_katakana_han)
        || (has_arabic_indic_digits && has_extended_arabic_indic_digits)
    {
        return false;
    }

    true
}

/// RFC 1034 hostname + RFC 5891 A-label + RFC 5892 unicode-label rules
/// (non-IDN path — ASCII hostname shape, punycode A-labels decoded + checked).
fn is_valid_hostname(hostname: &str) -> bool {
    if !is_valid_ascii_hostname(hostname) {
        return false;
    }

    for label in hostname.as_bytes().split(|&b| b == b'.') {
        // Per RFC 5891, labels with hyphens in 3rd & 4th positions must be
        // valid A-labels.
        if label.len() >= 4 && label[2] == b'-' && label[3] == b'-' && !is_punycode_label(label) {
            return false;
        }

        if is_punycode_label(label) {
            // SAFETY: `is_valid_ascii_hostname` already checked the label is
            // pure `a-zA-Z0-9-` ASCII, so slicing past the `xn--` prefix is
            // valid UTF-8 (mirrors jsonschema's `.expect`).
            let payload = std::str::from_utf8(&label[4..]).expect("ASCII label already validated");
            let Some(decoded) = decode_to_string(payload) else {
                return false;
            };
            if !validate_unicode_label(&decoded) {
                return false;
            }
        }
    }

    true
}

/// `[IPv6:...]` / `[IPv4...]` literals, else the hostname rules.
fn validate_email_domain(domain: &str) -> bool {
    if let Some(domain) = domain.strip_prefix('[').and_then(|d| d.strip_suffix(']')) {
        if let Some(domain) = domain.strip_prefix("IPv6:") {
            domain.parse::<Ipv6Addr>().is_ok()
        } else {
            domain.parse::<Ipv4Addr>().is_ok()
        }
    } else {
        is_valid_hostname(domain)
    }
}

/// Validate `input` as an RFC 5321/5322 email — byte-parity with jsonschema
/// 0.48.5 `format: "email"` (default options, non-ASCII local parts rejected).
pub fn is_valid_email_format(input: &[u8]) -> bool {
    let Ok(s) = std::str::from_utf8(input) else {
        return false;
    };
    let Ok(parsed) = EmailAddress::from_str(s) else {
        return false;
    };
    validate_email_domain(parsed.domain())
}
