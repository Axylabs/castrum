// rust/ingress/ip_trust.rs — trusted-proxy client-IP resolution.

use crate::util::trim_ascii_whitespace;
use ipnet::{IpNet, Ipv4Net, Ipv6Net};
use std::net::IpAddr;
use xxhash_rust::xxh3::Xxh3;

#[derive(Clone)]
pub enum ProxyTrustMode {
    None,
    All,
    Networks(Vec<IpNet>),
}

impl ProxyTrustMode {
    /// Build the trust mode from user config. Pure core: errors are `String`
    /// messages; the napi boundary (`mod.rs`) maps them to JS errors.
    pub fn from_config(
        enabled: bool,
        networks: Option<Vec<String>>,
    ) -> std::result::Result<Self, String> {
        if !enabled {
            return Ok(Self::None);
        }

        // Safety: an enabled trust-proxy mode with NO explicit networks must
        // never fall back to ProxyTrustMode::All (which trusts every hop and
        // lets clients spoof X-Forwarded-For). Treat it as "trust nothing"
        // unless the operator explicitly lists trusted networks.
        let Some(networks) = networks else {
            return Ok(Self::Networks(Vec::new()));
        };

        if networks.is_empty() {
            return Ok(Self::Networks(Vec::new()));
        }

        let mut out = Vec::with_capacity(networks.len());

        for raw in networks {
            let raw = raw.trim();
            if raw.is_empty() {
                continue;
            }

            if let Ok(ip) = raw.parse::<IpAddr>() {
                out.push(ip_to_net(ip)?);
            } else {
                let net: IpNet = raw
                    .parse()
                    .map_err(|_| format!("invalid trusted proxy network: {raw}"))?;
                out.push(net);
            }
        }

        // Networks that filtered down to nothing -> trust nothing (see above).
        Ok(Self::Networks(out))
    }

    #[inline(always)]
    pub fn is_none(&self) -> bool {
        matches!(self, Self::None)
    }

    pub fn is_trusted(&self, ip: IpAddr) -> bool {
        match self {
            Self::None => false,
            Self::All => true,
            Self::Networks(nets) => nets.iter().any(|n| n.contains(&ip)),
        }
    }
}

pub enum ResolvedIp<'a> {
    V4([u8; 4]),
    V6([u8; 16]),
    Raw(&'a [u8]),
}

impl<'a> From<IpAddr> for ResolvedIp<'a> {
    fn from(ip: IpAddr) -> Self {
        match ip {
            IpAddr::V4(v4) => ResolvedIp::V4(v4.octets()),
            IpAddr::V6(v6) => ResolvedIp::V6(v6.octets()),
        }
    }
}

impl ResolvedIp<'_> {
    pub fn rate_key(&self, seed: u64) -> u64 {
        let mut h = Xxh3::with_seed(seed);

        match self {
            ResolvedIp::V4(octets) => {
                h.update(&[1]);
                h.update(octets);
            }
            ResolvedIp::V6(octets) => {
                h.update(&[2]);
                h.update(octets);
            }
            ResolvedIp::Raw(bytes) => {
                h.update(&[0]);
                h.update(bytes);
            }
        }

        h.digest()
    }
}

fn ip_to_net(ip: IpAddr) -> std::result::Result<IpNet, String> {
    match ip {
        // Prefix 32 (v4) / 128 (v6) is always valid, but return a proper error
        // instead of panicking so a failed conversion surfaces as a JS error
        // rather than unwinding through the constructor.
        IpAddr::V4(v4) => Ipv4Net::new(v4, 32)
            .map(IpNet::V4)
            .map_err(|_| "invalid IPv4 /32 trusted network".to_string()),
        IpAddr::V6(v6) => Ipv6Net::new(v6, 128)
            .map(IpNet::V6)
            .map_err(|_| "invalid IPv6 /128 trusted network".to_string()),
    }
}

fn parse_ip_bytes(bytes: &[u8]) -> Option<IpAddr> {
    let s = std::str::from_utf8(trim_ascii_whitespace(bytes)).ok()?;
    s.parse::<IpAddr>().ok()
}

/// Cheap "is the socket peer a trusted proxy" check for the common case where
/// the caller only needs `peer_trusted` and not the resolved client IP (i.e.
/// rate limiting is disabled). Skips the `IpAddr` parse entirely when no
/// trusted-proxy mode is configured (where `peer_trusted` is always false).
#[inline]
pub fn socket_is_trusted(mode: &ProxyTrustMode, socket_ip: &[u8]) -> bool {
    if mode.is_none() {
        return false;
    }
    socket_parsed_is_trusted(mode, parse_ip_bytes(socket_ip))
}

#[inline]
fn socket_parsed_is_trusted(mode: &ProxyTrustMode, parsed: Option<IpAddr>) -> bool {
    parsed.map(|ip| mode.is_trusted(ip)).unwrap_or(false)
}

pub fn resolve_client_ip<'a>(
    mode: &ProxyTrustMode,
    socket_ip: &'a [u8],
    xff: Option<&'a [u8]>,
    x_real_ip: Option<&'a [u8]>,
) -> (ResolvedIp<'a>, bool) {
    let socket_trim = trim_ascii_whitespace(socket_ip);
    let socket_parsed = parse_ip_bytes(socket_trim);

    let peer_trusted = socket_parsed_is_trusted(mode, socket_parsed);

    if mode.is_none() || !peer_trusted {
        return (
            socket_parsed
                .map(Into::into)
                .unwrap_or(ResolvedIp::Raw(socket_trim)),
            peer_trusted,
        );
    }

    if let Some(xff) = xff {
        let mut last_valid: Option<ResolvedIp> = None;

        for part in xff.split(|&b| b == b',').rev() {
            let part = trim_ascii_whitespace(part);
            if part.is_empty() {
                continue;
            }

            match parse_ip_bytes(part) {
                Some(ip) => {
                    if mode.is_trusted(ip) {
                        last_valid = Some(ip.into());
                    } else {
                        // First hop past the trusted edge: use it directly.
                        return (ip.into(), peer_trusted);
                    }
                }
                None => break,
            }
        }

        if let Some(ip) = last_valid {
            return (ip, peer_trusted);
        }
    }

    if let Some(xri) = x_real_ip {
        let xri_trim = trim_ascii_whitespace(xri);
        let first = xri_trim.split(|&b| b == b',').next().unwrap_or(xri_trim);

        if let Some(ip) = parse_ip_bytes(first) {
            return (ip.into(), peer_trusted);
        }
    }

    (
        socket_parsed
            .map(Into::into)
            .unwrap_or(ResolvedIp::Raw(socket_trim)),
        peer_trusted,
    )
}

#[cfg(test)]
mod tests {
    use super::{resolve_client_ip, ProxyTrustMode};

    #[test]
    fn ip_trust_disabled_mode_is_none() {
        let mode = ProxyTrustMode::from_config(false, None).unwrap();
        assert!(mode.is_none());
    }

    #[test]
    fn ip_trust_enabled_without_networks_trusts_nothing() {
        // Regression: this must NOT become ProxyTrustMode::All (spoofing vector).
        let mode = ProxyTrustMode::from_config(true, None).unwrap();
        assert!(!mode.is_none());
        assert!(!mode.is_trusted("10.0.0.1".parse().unwrap()));
        assert!(!mode.is_trusted("8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn ip_trust_enabled_with_empty_networks_trusts_nothing() {
        let mode = ProxyTrustMode::from_config(true, Some(vec![])).unwrap();
        assert!(!mode.is_trusted("10.0.0.1".parse().unwrap()));
    }

    #[test]
    fn ip_trust_network_list_matches() {
        let mode = ProxyTrustMode::from_config(true, Some(vec!["10.0.0.0/8".to_string()])).unwrap();
        assert!(mode.is_trusted("10.1.2.3".parse().unwrap()));
        assert!(!mode.is_trusted("8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn ip_trust_single_ip_network() {
        let mode =
            ProxyTrustMode::from_config(true, Some(vec!["192.168.1.1".to_string()])).unwrap();
        assert!(mode.is_trusted("192.168.1.1".parse().unwrap()));
        assert!(!mode.is_trusted("192.168.1.2".parse().unwrap()));
    }

    #[test]
    fn ip_trust_invalid_network_is_error() {
        let res = ProxyTrustMode::from_config(true, Some(vec!["not-an-ip".to_string()]));
        assert!(res.is_err());
    }

    #[test]
    fn ip_trust_resolves_socket_ip_when_not_trusting_proxy() {
        let mode = ProxyTrustMode::from_config(false, None).unwrap();
        let (resolved, peer_trusted) =
            resolve_client_ip(&mode, b"203.0.113.5", Some(b"6.6.6.6"), None);
        assert!(!peer_trusted);
        // Socket IP must win; XFF must be ignored.
        match resolved {
            super::ResolvedIp::V4(o) => assert_eq!(o, [203, 0, 113, 5]),
            _ => panic!("expected V4 socket IP"),
        }
    }

    #[test]
    fn ip_trust_untrusted_socket_ignores_xff() {
        // Socket is NOT in the trusted networks -> XFF cannot spoof the client IP.
        let mode = ProxyTrustMode::from_config(true, Some(vec!["10.0.0.0/8".to_string()])).unwrap();
        let (resolved, peer_trusted) =
            resolve_client_ip(&mode, b"203.0.113.9", Some(b"6.6.6.6"), None);
        assert!(!peer_trusted);
        match resolved {
            super::ResolvedIp::V4(o) => assert_eq!(o, [203, 0, 113, 9]),
            _ => panic!("expected V4 socket IP"),
        }
    }

    #[test]
    fn ip_trust_trusted_socket_uses_leftmost_untrusted_xff() {
        let mode = ProxyTrustMode::from_config(true, Some(vec!["10.0.0.0/8".to_string()])).unwrap();
        let (resolved, peer_trusted) = resolve_client_ip(
            &mode,
            b"10.0.0.5",
            Some(b"8.8.8.8, 10.0.0.1, 10.0.0.2"),
            None,
        );
        assert!(peer_trusted);
        // Right-to-left: 10.0.0.2 trusted, 10.0.0.1 trusted, 8.8.8.8 NOT trusted -> client = 8.8.8.8.
        match resolved {
            super::ResolvedIp::V4(o) => assert_eq!(o, [8, 8, 8, 8]),
            _ => panic!("expected V4 8.8.8.8"),
        }
    }

    #[test]
    fn ip_trust_all_trusted_xff_returns_last_entry() {
        let mode = ProxyTrustMode::from_config(true, Some(vec!["10.0.0.0/8".to_string()])).unwrap();
        let (resolved, peer_trusted) =
            resolve_client_ip(&mode, b"10.0.0.5", Some(b"10.0.0.1, 10.0.0.2"), None);
        assert!(peer_trusted);
        match resolved {
            super::ResolvedIp::V4(o) => assert_eq!(o, [10, 0, 0, 1]),
            _ => panic!("expected V4 10.0.0.1"),
        }
    }
}
