# Core Authentication Wave 6: Trusted Client-IP Boundary Design

**Finding:** SR2-16
**Depends on:** none; delivered last to keep authentication-state PRs independent
**Parent design:** `docs/superpowers/specs/2026-07-11-core-authentication-hardening-design.md`

## Goal

Make the client IP used by partner allowlists originate from an explicit trusted network boundary, never from an untrusted request's forwarding headers.

## Trust modes

Replace ambiguous precedence with an explicit source mode:

```ts
type ClientIpSourceMode = 'direct' | 'canonical_proxy' | 'cloudflare';
```

- `direct`: ignore every forwarding header and use the socket peer address.
- `canonical_proxy`: require the socket peer to match an explicit CIDR or a configured service hostname resolved and pinned to exact addresses at startup, then accept only Caddy's canonical `X-Breeze-Client-IP` header.
- `cloudflare`: for deployments where the API directly receives Cloudflare traffic, require the peer to match configured Cloudflare CIDRs and accept only `CF-Connecting-IP`.

Production configuration must select a mode explicitly. Shipped direct API development defaults to `direct`. Shipped hosted and self-hosted Caddy→API use `canonical_proxy` with the generic Compose service name `caddy`; Caddy, not the API, interprets Cloudflare headers. The API resolves that service name once at startup and trusts only the returned exact peer addresses, avoiding committed infrastructure IPs.

Legacy `TRUST_PROXY_HEADERS` is rejected or mapped only during a documented migration period when the new source mode and CIDRs are also explicit. It cannot independently enable header trust.

## Caddy boundary

Before proxying to the API, Caddy removes client-supplied:

- `X-Breeze-Client-IP`
- `CF-Connecting-IP`
- `True-Client-IP`
- `X-Real-IP`
- forwarding headers that could bypass Caddy's own trusted-proxy calculation

Caddy then overwrites `X-Breeze-Client-IP` with its trusted-proxy-aware `{client_ip}` value. Hosted configuration keeps the existing Cloudflare trusted-proxy ranges so `{client_ip}` resolves the Cloudflare-authenticated client. Generic/self-host Caddy without a trusted upstream resolves the direct client.

The API never prefers raw `CF-Connecting-IP` in `canonical_proxy` mode.

## API resolver

Return a structured result rather than an unqualified string:

```ts
type TrustedClientIpResult =
  | { trusted: true; ip: string; source: ClientIpSourceMode }
  | { trusted: false; reason: 'untrusted_peer' | 'missing_header' | 'invalid_ip' | 'misconfigured' };

function resolveTrustedClientIp(request: RequestContext): TrustedClientIpResult;
```

The resolver validates IP syntax/canonicalization, normalizes IPv4-mapped IPv6, and never accepts comma-separated/multiple values for the canonical internal header.

General logging/rate-limit callers may use the trusted result or a separately documented non-authoritative fingerprint. Security policy callers use only `trusted:true`.

## IP allowlist behavior

When a partner has a non-empty allowlist:

- trusted client IP in the list → allow;
- trusted client IP outside the list → deny;
- no trusted client IP or resolver misconfiguration → fail closed with service-unavailable/deny semantics and an operator-visible audit reason.

Platform-admin bypass behavior, if retained by product policy, is explicit and tested separately; it does not change how IP is resolved.

Login and authenticated-request allowlist checks call the same resolver. Audit stores the resolved canonical IP and source mode, never raw forwarding-header chains.

## Configuration validation

Startup validation enforces:

- `direct` forbids reliance on trusted-proxy headers;
- `canonical_proxy` requires at least one explicit trusted CIDR or startup-resolved proxy hostname;
- `cloudflare` requires non-empty Cloudflare CIDRs;
- production rejects wildcard/all-network trusted CIDRs;
- malformed CIDRs or unsupported mode fail startup.

Compose examples use generic placeholders and contain no internal host/IP details.

## Failure behavior

- Missing/invalid canonical header from an otherwise trusted proxy fails allowlist checks closed.
- Header spoofing from an untrusted peer is ignored and audited only at bounded rate.
- Caddy/API configuration mismatch is visible in readiness/startup diagnostics rather than silently falling back to a raw header.
- Non-security telemetry must not accidentally reuse an untrusted value as the allowlist decision later.

## Verification

API tests cover every source mode, trusted/untrusted peers, spoofed headers, IPv4/IPv6 normalization, multiple values, malformed CIDRs, missing headers, and fail-closed allowlists.

Static configuration tests assert every Caddy reverse-proxy block removes/overwrites the canonical header and shipped Compose modes set explicit source configuration. Integration tests send a spoofed `CF-Connecting-IP` through generic Caddy and confirm the API sees the actual client, while hosted-mode fixtures confirm the trusted upstream result.
