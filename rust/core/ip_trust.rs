// rust/core/ip_trust.rs — IP trust & proxy resolution
// Pure Rust, no napi dependencies.

use crate::core::prelude::*;
use crate::core::util::trim_ascii_whitespace;
use ipnet::{IpNet, Ipv4Net, Ipv6Net};
use std::net::IpAddr;
use xxhash_rust::xxh3::Xxh3;

/// Proxy trust mode for IP resolution.
#[derive(Clone, Debug)]
pub enum ProxyTrustMode {
    /// No proxy trust (use socket IP directly).
    None,
    /// Trust all proxies.
    All,
    /// Trust only specific networks.
    Networks(Vec<IpNet>),
}

impl ProxyTrustMode {
    /// Create a `ProxyTrustMode` from configuration.
    pub fn from_config(enabled: bool, networks: Option<Vec<String>>) -> CoreResult<Self> {
        if !enabled {
            return Ok(Self::None);
        }

        let Some(networks) = networks else {
            return Ok(Self::All);
        };

        if networks.is_empty() {
            return Ok(Self::All);
        }

        let mut out = Vec::with_capacity(networks.len());

        for raw in networks {
            let raw = raw.trim().to_string();
            if raw.is_empty() {
                continue;
            }

            if let Ok(ip) = raw.parse::<IpAddr>() {
                out.push(ip_to_net(ip));
            } else {
                let net: IpNet = raw.parse().map_err(|_| {
                    CoreError::InvalidInput { context: "invalid trusted proxy network" }
                })?;
                out.push(net);
            }
        }

        if out.is_empty() {
            Ok(Self::All)
        } else {
            Ok(Self::Networks(out))
        }
    }

    /// Returns `true` if this mode is `None`.
    #[inline(always)]
    pub fn is_none(&self) -> bool {
        matches!(self, Self::None)
    }

    /// Check if the given IP is trusted.
    pub fn is_trusted(&self, ip: IpAddr) -> bool {
        match self {
            Self::None => false,
            Self::All => true,
            Self::Networks(nets) => nets.iter().any(|n| n.contains(&ip)),
        }
    }
}

/// A resolved client IP address.
#[derive(Debug, Clone)]
pub enum ResolvedIp<'a> {
    /// IPv4 address (4 bytes).
    V4([u8; 4]),
    /// IPv6 address (16 bytes).
    V6([u8; 16]),
    /// Raw bytes (failed to parse as IP).
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
    /// Compute a rate-limiting key from this IP.
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

fn ip_to_net(ip: IpAddr) -> IpNet {
    match ip {
        IpAddr::V4(v4) => IpNet::V4(Ipv4Net::new(v4, 32).expect("valid /32")),
        IpAddr::V6(v6) => IpNet::V6(Ipv6Net::new(v6, 128).expect("valid /128")),
    }
}

fn parse_ip_bytes(bytes: &[u8]) -> Option<IpAddr> {
    let s = std::str::from_utf8(trim_ascii_whitespace(bytes)).ok()?;
    s.parse::<IpAddr>().ok()
}

/// Resolve the client IP address using proxy headers.
///
/// Returns a tuple of `(ResolvedIp, peer_trusted)`.
pub fn resolve_client_ip<'a>(
    mode: &ProxyTrustMode,
    socket_ip: &'a [u8],
    xff: Option<&'a [u8]>,
    x_real_ip: Option<&'a [u8]>,
) -> (ResolvedIp<'a>, bool) {
    let socket_trim = trim_ascii_whitespace(socket_ip);
    let socket_parsed = parse_ip_bytes(socket_trim);

    let peer_trusted = socket_parsed
        .map(|ip| mode.is_trusted(ip))
        .unwrap_or(false);

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
                    let trusted = mode.is_trusted(ip);
                    last_valid = Some(ip.into());

                    if !trusted {
                        return (last_valid.take().unwrap(), peer_trusted);
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
    use super::*;

    #[test]
    fn test_proxy_trust_none() {
        let mode = ProxyTrustMode::None;
        assert!(!mode.is_trusted("192.168.1.1".parse().unwrap()));
    }

    #[test]
    fn test_proxy_trust_all() {
        let mode = ProxyTrustMode::All;
        assert!(mode.is_trusted("10.0.0.1".parse().unwrap()));
    }
}
