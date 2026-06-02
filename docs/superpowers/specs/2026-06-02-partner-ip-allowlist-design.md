# Partner-level Admin IP Allowlist — Design

**Date:** 2026-06-02
**Status:** Design (pending implementation plan)
**Scope:** Enforce the existing (but currently inert) `partners.settings.security.ipAllowlist` so an MSP can restrict dashboard access to specific source IPs/CIDRs.

## Problem

There is no built-in way to restrict the Breeze administration panel to specific IP addresses. Operators currently push this down to the reverse proxy (Caddy / Cloudflare Access). A partner-settings field `ipAllowlist` already exists in the schema and UI, but **nothing reads it to block access** — it is dead config today.

This design wires up enforcement for that field at the partner level, with the safety mechanisms needed to make app-layer IP filtering usable without locking operators out of their own panel.

## Goals

- A partner admin can configure an allowlist of IPs/CIDRs that gates dashboard/user access for all of that partner's staff.
- Enforcement at both login and on every authenticated dashboard request.
- Strong protection against self-lockout and a documented recovery path.
- Safe behavior when the API cannot determine a trustworthy client IP (no mass lockout, no false sense of security).
- Agent traffic is never affected.

## Non-goals (v1)

- Org-level and platform-level allowlists. The data model already supports an org-level list; only the **partner** axis is enforced in v1. (Future: extend to org with the existing partner-wins merge.)
- Gating dashboard **WebSocket** upgrades (terminal/desktop viewer side). REST enforcement only in v1.
- Per-user or per-role allowlists.
- Geo/ASN rules. IP/CIDR literals only.

## Decisions (resolved during brainstorming)

| Decision | Choice |
|---|---|
| Tenancy axis | **Partner-level only** |
| Enforcement point | **Both** login and every authenticated request |
| Untrusted-IP behavior | **Gate enabling** (proxy-trust pre-check) + **fail-open at runtime** with warning/banner |
| Lockout safety | Warn+confirm on save · "Add my current IP" helper · platform-admin bypass · env/CLI break-glass |
| Break-glass env var | `IP_ALLOWLIST_ENFORCEMENT_MODE` (default `enforce`, `off` disables) — mirrors `ENROLLMENT_SECRET_ENFORCEMENT_MODE` |
| WebSocket upgrades | Out of scope for v1 |

## Architecture

No new tables. Reuse `partners.settings.security.ipAllowlist: string[]` (IPs and CIDRs). An **empty array means disabled** (no enforcement).

### Data flow

```
                    ┌──────────────────────────────────────────────┐
Login request  ───► │ auth/login.ts: after user.partnerId resolved │
                    │   checkIpAllowed(partnerId, clientIp)         │──► deny → 403 { code: 'ip_not_allowed' }
                    └──────────────────────────────────────────────┘     allow → mint tokens

                    ┌──────────────────────────────────────────────┐
Dashboard API  ───► │ authMiddleware (sets c.get('auth').partnerId)│
request             │            ▼                                  │
                    │ ipAllowlistMiddleware                         │──► deny → 403 { code: 'ip_not_allowed' }
                    │   checkIpAllowed(partnerId, clientIp)         │     allow → next()
                    └──────────────────────────────────────────────┘

Agent API      ───► agentAuth (separate middleware) ──────────────────► never sees ipAllowlistMiddleware
```

### Components

1. **`checkIpAllowed(partnerId, clientIp, ctx)`** — shared enforcement function (new, e.g. `apps/api/src/services/ipAllowlist.ts`). Returns a discriminated result: `{ decision: 'allow' | 'deny' | 'skip', reason }`.
   - `skip` (fail-open) when: global mode is `off`; allowlist empty; client IP not trustable; caller is platform admin.
   - `deny` when: list non-empty, IP trustable, IP not matched.
   - `allow` otherwise.

2. **`ipMatchesAny(ip, cidrs): boolean`** — extracted from the CIDR-matching logic already in `clientIp.ts` (`isTrustedProxySource`). Supports IPv4, IPv6, single IPs (treated as /32 or /128), and CIDR ranges. Shared by proxy-trust and allowlist code so there is one matcher.

3. **`ipAllowlistMiddleware`** (new, `apps/api/src/middleware/ipAllowlist.ts`) — runs **after** `authMiddleware` on the dashboard/user router only. Reads `c.get('auth')` for `partnerId` and `isPlatformAdmin`, resolves the client IP via `getTrustedClientIpOrUndefined(c)`, calls `checkIpAllowed`, and throws `HTTPException(403)` on `deny`.

4. **Login check** — `auth/login.ts` calls `checkIpAllowed` after `user.partnerId` is known and before minting tokens. A `deny` returns `403 { code: 'ip_not_allowed' }` so the login screen shows a precise error.

5. **Partner-settings cache** — partner `settings.security.ipAllowlist` read is cached per `partnerId` (~30–60s TTL, Redis or in-process) to avoid a DB read on every request. Cache is invalidated when partner settings are written.

### Enforcement logic detail

**Trustable client IP.** "Trustable" means `getTrustedClientIpOrUndefined(c)` returns a value (i.e. `TRUST_PROXY_HEADERS=true`, the immediate peer is within `TRUSTED_PROXY_CIDRS`, and a client-IP header was present). When it returns `undefined`, the IP is not trustable → `skip` (fail-open).

**Enable-gate (on save).** When a PATCH transitions the list from empty → non-empty (i.e. turning enforcement on), the settings handler verifies proxy trust is actually working for *this* request: `TRUST_PROXY_HEADERS=true`, `TRUSTED_PROXY_CIDRS` non-empty, and `getTrustedClientIpOrUndefined(c)` is defined. If not, reject the save with `400 { code: 'proxy_trust_required' }` and a message explaining that proxy trust must be configured before the allowlist can see real client IPs. This prevents enabling a control that would silently fail open (false security) or, if it were fail-closed, mass-lock.

**Runtime fail-open.** If at request time the IP is not trustable, `checkIpAllowed` returns `skip`, logs a rate-limited `warn` (`[ipAllowlist] configured but inactive: client IP not trusted for partner <id>`), and sets a status flag the UI reads to render an "inactive" banner.

**Platform-admin bypass.** `auth.user.isPlatformAdmin === true` → `skip` with reason `platform_admin`, audit-logged. Break-glass for self-host owner / hosted support.

**Global break-glass.** `IP_ALLOWLIST_ENFORCEMENT_MODE=off` (read at boot) makes `checkIpAllowed` always `skip`. Documented SQL fallback to clear the list:
```sql
UPDATE partners
SET settings = jsonb_set(settings, '{security,ipAllowlist}', '[]'::jsonb)
WHERE id = '<partner-id>';
```

## Lockout safety (reconciled)

The four selected mechanisms are reconciled so they compose rather than conflict:

- **"Add my current IP" helper** — an explicit one-click button (and pre-filled suggestion) in the UI, backed by the status endpoint returning the caller's detected trusted IP. This is the friendly, non-silent form of "auto-add" — the admin sees and confirms the IP added.
- **Warn + confirm on save** — if the admin's detected current IP is not covered by the list being saved, the save is blocked with a confirmation gate ("your current IP isn't in this list; you may lose access — confirm to proceed"). This is the guard if the admin removes their own IP. (We do **not** silently inject the IP, which would make warn+confirm unreachable.)
- **Platform-admin bypass** — as above.
- **Env/CLI break-glass** — as above.

## API changes

- `PATCH /orgs/partners/me` (existing) — extend the settings handler:
  - Validate each `ipAllowlist` entry as a valid IPv4/IPv6 address or CIDR (Zod refinement). Reject malformed entries with field-level errors.
  - Apply the enable-gate (`proxy_trust_required`) on empty→non-empty transitions.
  - Invalidate the partner-settings cache on write.
- `GET /orgs/partners/me/ip-allowlist/status` (new) — returns:
  ```json
  { "currentIp": "203.0.113.10", "proxyTrustOk": true, "enforced": true, "active": true }
  ```
  - `currentIp`: caller's detected trusted IP (or null if not trustable).
  - `proxyTrustOk`: whether proxy trust is configured/working.
  - `enforced`: allowlist non-empty and mode `enforce`.
  - `active`: `enforced && proxyTrustOk` (drives the inactive banner when false).

## UI changes (`PartnerSecurityTab.tsx`)

The `ipAllowlist` field already exists in the component. Add:
- A CIDR list editor (add/remove rows) with inline format validation.
- "Add my current IP" button (calls the status endpoint).
- Inactive banner when `status.active === false && status.enforced` ("Allowlist configured but inactive — the API isn't seeing real client IPs. Configure proxy trust.").
- `proxy_trust_required` enable-gate error and the warn+confirm dialog surfaced through `runAction` (per the repo's mutation-feedback convention).

## Audit logging

Log via the existing audit subsystem:
- `ip_allowlist.denied` — actor (user/login), attempted IP, partnerId.
- `ip_allowlist.bypass_platform_admin` — actor, IP, partnerId.
- `ip_allowlist.updated` — actor, before/after list (settings change).

## Validation & edge cases

- Empty list → disabled (the off switch).
- Duplicate/overlapping CIDRs allowed (no-op).
- IPv6 supported; single IP normalized to /32 (v4) or /128 (v6).
- Loopback/private ranges are allowed as entries (valid for VPN/self-host setups); no special-casing.
- Mode `off` globally short-circuits regardless of per-partner config.
- The cache TTL means an allowlist change can take up to the TTL to fully propagate to in-flight sessions; acceptable for v1 (login check is immediate; per-request catches up within TTL). Cache invalidation on write keeps the saving node fresh immediately.

## Testing

- **`ipMatchesAny`**: IPv4/IPv6 single + CIDR, boundary cases, malformed input.
- **`checkIpAllowed`**: allow / deny / skip (empty list, untrusted IP, mode off, platform admin).
- **`ipAllowlistMiddleware`**: 403 on deny, pass on allow/skip, agent routes unaffected.
- **Login check**: `ip_not_allowed` returned, no tokens minted.
- **Enable-gate**: `proxy_trust_required` when proxy trust not configured.
- **Settings validation**: malformed CIDR rejected; cache invalidation on write.
- **Audit**: denied / bypass / updated events emitted.

## Rollout

- Purely additive; default behavior unchanged (empty list = disabled, mode defaults to `enforce` but only acts on non-empty lists).
- No migration required (field already exists).
- Document `IP_ALLOWLIST_ENFORCEMENT_MODE` in `.env.example` and the security docs, plus a "behind a reverse proxy you must configure proxy trust first" note that links to the Cloudflare Tunnel / environment docs.

## Open questions

None outstanding. Env var name and WebSocket scope resolved.
