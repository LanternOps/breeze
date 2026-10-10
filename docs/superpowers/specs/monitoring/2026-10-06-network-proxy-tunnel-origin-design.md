---
title: Network Proxy — serve device UIs from a dedicated tunnel origin
tracking_issue: LanternOps/breeze#8155
status: draft (advisor-reviewed: Fable + Codex xhigh, 2026-10-07)
date: 2026-10-06
area: monitoring / remote access
related:
  - docs/superpowers/plans/monitoring/2026-06-25-network-proxy-http-reverse-proxy.md
  - docs/superpowers/specs/monitoring/2026-08-08-proxy-access-consolidation-design.md
  - PR #8110 (path-token auth for cookie-less sandbox subresources)
---

# Network Proxy — dedicated tunnel origin

## Problem

The Network Proxy currently renders a LAN device's web UI (printer, firewall, switch, NAS)
inside the Breeze app's own origin, under `/api/v1/tunnel-http/<tunnelId>/<pathToken>/…`.
Because that content is untrusted, it runs in an iframe whose CSP is `sandbox` **without**
`allow-same-origin`, so the document gets an opaque (`null`) origin. That one constraint
causes most of the proxy's breakage over the last few months:

| Symptom | Root cause in path mode |
|---|---|
| Blank pages on modern printer UIs (#5906) | Root-relative `/x` URLs escape the `/api/v1/tunnel-http/…` prefix; needs HTML/CSS/JS URL rewriting plus a runtime shim |
| Framing refused (#7144) | App-wide CSP/XFO had to be carved out for one path prefix |
| Splash-screen hangs (SonicWall, #8110) | Firefox Total Cookie Protection puts the sandbox in its own partition and `crossorigin` loads omit cookies, so subresources lose the tunnel cookie |
| SPAs crash on load | `localStorage`/`sessionStorage` throw `SecurityError` in an opaque origin |
| Login loops after form-post logins in Firefox | Frame navigations and sandbox fetches use different cookie partitions |
| No WebSocket support | Rewriting/shim layer and the shared app origin make it impractical |

Each fix so far (URL rewriting, `<base>` injection, runtime shim, `SameSite=None`, path token,
`Origin: null` CORS, viewer presence) works around the same root problem. **This design removes
the root problem: give every proxy session its own real origin, on a domain the app does not
share.** The device then runs exactly as it would if you browsed to it directly.

## Goals

- Device UIs work unmodified: root-relative URLs, SPAs using web storage, full-page form
  logins, and redirects all behave natively in Chrome, Firefox, and Safari.
- Untrusted device content can never read or act on the Breeze app origin, its cookies, or its
  storage, and one device's content can never read another session's.
- No new database tables and no tenancy-shape changes. The existing `tunnel_sessions`
  lifecycle and every authorization gate are reused unchanged.
- Self-hosters without a second domain keep today's path mode (#8110) as a fallback.

## Non-goals

- WebSocket proxying. This design makes it feasible, but it is a later wave.
- Removing path mode. It stays as the fallback until host mode has been the default for
  at least one release.
- Changing how tunnels are created, authorized, allowlisted, or audited.

## Design

### 1. Origin shape

```
App:     https://us.2breeze.app/remote/proxy/<tunnelId>
           └─ <iframe src="https://<tunnelId>.us.breezetunnel.net/__bz/enter?t=<ticket>">
Tunnel:  https://<tunnelId>.us.breezetunnel.net/<device path, unmodified>
           → Caddy (tunnel site block) → api:3001, routed by Host → agent → device
```

- **Separate registrable domain** (working name `breezetunnel.net`). It must not be a
  subdomain of the app's domain, because `x.2breeze.app` is *same-site* with
  `us.2breeze.app`. That would bring back SameSite cookie flow and same-site request trust
  between untrusted content and the app. This is the same pattern as `googleusercontent.com`
  and `githubusercontent.com`.
- **One origin per tunnel session.** Each session gets `<tunnelId>.<region>.<tunnel-domain>`,
  so device A's scripts cannot read device B's cookies or storage (cross-origin).
- **Region is a DNS label**, so `*.us.breezetunnel.net` routes to the US droplet and
  `*.eu.…` to EU. A per-region wildcard cert covers it (see Infra).
- **Public Suffix List.** Submit `us.breezetunnel.net` and `eu.breezetunnel.net` to the PSL
  (private section) so each tunnel host is its own *site*. Until that lands, tunnel hosts are
  same-site with each other, and device JS on one tunnel could set a
  `Domain=us.breezetunnel.net` cookie that reaches another tunnel host (cookie tossing
  between sessions). Mitigations until PSL inclusion: the auth cookie uses the `__Host-`
  prefix, which cannot be set with a `Domain` attribute, so a sibling tunnel cannot plant
  or overwrite it; and the server strips `Domain=` from device `Set-Cookie`. Device JS can
  still write a `Domain` cookie through `document.cookie`, which this design cannot block
  before PSL inclusion. So `__Host-` protects proxy authentication, but not ordinary device
  cookies, from sibling tossing or fixation. **Verified PSL inclusion (present in shipped
  browser lists, not just submitted) gates making host mode the hosted default.** Before that,
  host mode is opt-in. See Open question 3. PSL inclusion takes weeks, so it
  is a W04 task, not a launch blocker.
- The hostname reveals only the tunnel id, which is not a credential. Access always
  requires the session cookie.

### 2. Configuration

| Env var | Example | Meaning |
|---|---|---|
| `TUNNEL_ORIGIN_TEMPLATE` | `https://{id}.us.breezetunnel.net` | Enables host mode. `{id}` is the tunnel UUID. Unset means path mode (today). |
| `TUNNEL_FRAME_ANCESTOR` | `https://us.2breeze.app` | Origin allowed to frame tunnel content. Defaults to the app's public origin. |

The config validator (`apps/api/src/config/validate.ts`) refuses to boot when
`TUNNEL_ORIGIN_TEMPLATE` is set and any of these hold:

- it is not exactly `https://{id}.<suffix>`: no userinfo, path, query, fragment, or port;
  exactly one `{id}`, as the leftmost label; and a syntactically valid suffix;
- `TUNNEL_FRAME_ANCESTOR` is not an exact HTTPS origin, or the public app origin it defaults
  from is not configured. Missing config fails closed rather than guessing;
- the suffix's registrable domain equals the registrable domain of **any** authenticated
  app/API origin. That covers the public app URL, the API URL, and every
  `CORS_ALLOWED_ORIGINS` entry. This uses `tldts`, which is already an API dependency, with
  `allowPrivateDomains` set explicitly in both directions: a private-PSL suffix must not mask
  a shared parent.

The server alone builds tunnel URLs. `POST /tunnels/:id/http-ticket` returns
`{ ticket, url }`, and the web client stops composing the iframe URL itself.

### 3. Request routing (API)

A new `tunnelHostRoutes` Hono app is mounted **in front of** the main app. Requests are
routed by `Host`:

- If `Host` matches the template's pattern (UUID label + configured suffix), the request
  goes to `tunnelHostRoutes` and nothing else. API routes, auth middleware, the app CORS
  policy, and static assets are never served on a tunnel host.
- If `Host` is an app host, the request goes to the existing app. The tunnel-host handler is
  unreachable there.
- Both Caddy site blocks reach the same `api:3001`, so the assertion header is the only
  ingress signal. It must be hardened end to end:
  - every Caddy site block deletes a client-supplied `X-Breeze-Tunnel-Site` at the site
    level, before any `reverse_proxy` sets it. A `header_up` delete placed after a set
    erases the set (see the existing comments at the top of `docker/Caddyfile.prod`);
  - only the tunnel block sets the header;
  - the API rejects a tunnel-pattern `Host` without the assertion, and an app request
    carrying it;
  - `X-Forwarded-Host` and similar overrides are ignored for this decision;
  - Caddy's tunnel block 404s any host that does not match the wildcard pattern;
  - the API port is not reachable except through Caddy (already true in the compose
    networks — assert it in the W00 spike).
- An integration test drives real Caddy, not just Hono, through both blocks with forged
  `Host` and assertion headers.
- Body-size limits, admission controls, request logging, and metrics middleware run
  **before** Host dispatch, so tunnel hosts are not a bypass around them.

The handler reuses `tunnelHttp.ts` internals, factored into a shared core:
`authorizeTunnelContinuation`, `loadOwnedTunnelSession`, the 12h cap, device-online check,
`checkRemoteAccess(…, 'proxy')`, activity bump, agent dispatch, and decompression bounds.
Only authentication, URL rewriting, and response headers differ by mode.

### 4. Authentication in host mode

1. The web page mints a ticket (unchanged) and sets the iframe to the returned
   `url` (`https://<id>.us.breezetunnel.net/__bz/enter?t=<ticket>`).
2. `GET /__bz/enter` consumes the ticket with the same checks as today: session id, type,
   IP/UA, and live authority. It then sets the auth cookie and `302`s to `/`.
   - Cookie: `__Host-bzt=<signed JWT>; Path=/; Secure; HttpOnly; SameSite=None; Partitioned`,
     with a 5-minute sliding TTL.
   - The `/__bz/` path prefix is reserved by the proxy and never forwarded to the device.
3. Every other request needs a valid `__Host-bzt` for this tunnel id. There is no path token
   and no cookie-less mode.

Why `SameSite=None; Partitioned`: inside the iframe the tunnel host is a third-party context
under the app's top-level site. A partitioned (CHIPS) cookie is keyed to that top-level
site, so it is set and read in the same partition. That works under Chrome's third-party
cookie restrictions and under Firefox Total Cookie Protection. **"Open in New Tab"** mints a
fresh ticket and opens `url` top-level. The cookie is then first-party, which works in
every browser.

**Browser support for CHIPS** (per the advisor, to verify in the W00 spike): Chrome 114+,
Firefox 141+, Safari 26.2+. Firefox Total Cookie Protection alone is not equivalent. On a
browser without CHIPS support, or with third-party cookies blocked outright, the web page
falls back to "Open in New Tab" with a one-line notice. Path mode is not the fallback.

**New tab** is a different cookie partition (top-level), so it does not share the iframe's
device login state. The new-tab URL carries `mode=tab`. `/__bz/enter` then sets an
unpartitioned first-party cookie (`__Host-bzt-top`) and the tab is opened with `noopener`.
Each context gets its own ticket.

**Revocation.** The cookie is re-checked against live authority on every request, as
today. Close revokes outstanding tickets. Ticket exchange activates the session
**conditionally** (`UPDATE … WHERE status IN ('pending','connecting','active')`), so an
exchange racing a Close cannot reopen it; today the exchange is unconditional, and W01 fixes
that in both modes. Close cancels in-flight agent requests for the tunnel, and the web page
shows "disconnected" only after the DELETE succeeds (via `runAction`).

### 4a. Request admission (cross-tunnel CSRF)

Before PSL inclusion, sibling tunnel hosts are same-site. Even after it, all iframes share
the app's cookie partition, so a page on tunnel A can send a request to tunnel B's host that
carries B's partitioned cookie. Admission rules, enforced before dispatch:

- If `Sec-Fetch-Site` is present, it must be `same-origin` or `none`. The only exception is
  `/__bz/enter`, which accepts the app's cross-site iframe navigation and is protected by the
  one-time ticket.
- If `Sec-Fetch-Site` is absent (older browsers), unsafe methods require `Origin` equal to
  this tunnel's origin. A missing `Origin` on an unsafe method is rejected.
- These rules apply to GET too, because device GET endpoints often have side effects
  (reboot links, config toggles).

Only an admitted request's `Origin` is rewritten for the device (§5).

### 5. What the proxy still rewrites

The device owns the whole origin, so root-relative and relative URLs need **no rewriting**.
`<base>` injection and most of the runtime shim go away. What remains:

- **Absolute URLs naming the device's own origin** (`https://192.168.1.254/…`) in HTML
  attributes, CSS `url()`, `Location`, and a minimal fetch/XHR shim are mapped to the tunnel
  origin. This reuses `rewriteTunnelUrl` with `basePath: '/'`.
- **Device `Set-Cookie`:** strip `Domain=`. Force `Secure; SameSite=None; Partitioned` in
  the iframe context, and `Secure; SameSite=Lax` (unpartitioned) in the new-tab context.
  Keep the name, value, and `Path`. There is no name prefixing, because nothing else lives
  on this origin. Only the proxy's own cookie names (`__Host-bzt`, `__Host-bzt-top`) are
  reserved and dropped from device `Set-Cookie`; other `__Host-*` device cookies pass
  through. Device JS `document.cookie` writes can't be rewritten, and may fail in a
  third-party context with cookies blocked. The new-tab fallback covers that.
- **Upstream `Cookie`:** the proxy's cookies are stripped before forwarding. Only device
  cookies reach the device.
- **Device `Origin`:** when the request's `Origin` equals this tunnel's origin, it is
  forwarded rewritten to the device's own origin, so device-side CSRF checks that compare
  `Origin` to the device host pass. Any other `Origin` is not forwarded. `Referer` is not
  forwarded either, since responses set `no-referrer`. This is new in host mode; path mode
  forwards neither.

### 6. Response headers in host mode

- `Content-Security-Policy: frame-ancestors <TUNNEL_FRAME_ANCESTOR> 'self'`. `'self'` keeps
  device pages that frame their own content working. There is **no
  `sandbox` directive**: the content already runs in its own cross-site origin. The iframe
  element still carries
  `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"`,
  which blocks top-level navigation of the app tab. `allow-same-origin` is safe here *only
  because* the origin differs from the app. The web code asserts the iframe URL is on the
  tunnel domain before adding it.
- `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`
  (device `Content-Type` is preserved), and device `X-Frame-Options`/CSP dropped as today.
- No CORS headers: device `access-control-*` headers are stripped, and the device's own
  requests are same-origin.
- **Service workers are blocked.** Any request with a `Service-Worker: script` header gets
  a 404. A device-registered worker would otherwise persist on the tunnel origin and
  intercept later sessions.
- The iframe URL is validated exactly (template match plus tunnel id) before render, and
  the new tab opens with `noopener`.

### 7. Web changes

- `ProxyTunnelPage.tsx` uses `url` from the ticket response. When the URL is on the tunnel
  domain it renders the host-mode sandbox; otherwise it uses today's path-mode sandbox.
- "Open in New Tab" mints a new ticket and opens `url` top-level.
- Status polling, idle re-mint, and close behavior are unchanged. The 5s poll still drives
  terminal-state UI.

### 8. Infra (per region)

- Register the tunnel domain. Cloudflare DNS: `*.us` → US droplet, `*.eu` → EU droplet,
  proxied.
- TLS for `*.us.<domain>` and `*.eu.<domain>` has two hops:
  - **Edge (browser ↔ Cloudflare):** Universal SSL covers only one wildcard level, so the
    two regional wildcards need Cloudflare Advanced Certificate Manager.
  - **Origin (Cloudflare ↔ Caddy):** ACM does not cover this hop. Install a Cloudflare
    Origin CA wildcard cert for the regional suffix in Caddy, with Full (strict). This
    avoids DNS-01 and a custom Caddy build.

  The alternative is DNS-only records plus Caddy DNS-01. See Open question 1.
- A Cloudflare cache rule bypasses caching for the tunnel zone, and bot/challenge
  features are disabled there. Device assets must never be edge-cached, and a challenge
  page inside the iframe would break the proxy.
- `docker/Caddyfile.prod`: a new site block `{$TUNNEL_SITE_ADDRESS}` that accepts only the
  tunnel wildcard. It reverse-proxies to `api:3001` with the tunnel-site assertion header,
  with no web/portal/billing handlers, and keeps WebSocket upgrade headers intact for the
  future wave.
- Droplet `.env` + compose `environment:` mapping for `TUNNEL_ORIGIN_TEMPLATE`,
  `TUNNEL_FRAME_ANCESTOR`, and `TUNNEL_SITE_ADDRESS`, per the required-env-var rule in
  CLAUDE.md.
- Self-hosters get a docs page: an optional second domain plus wildcard DNS/cert. Without
  it they stay in path mode.

### 9. Security review checklist (gate for W02 merge)

- [ ] A tunnel host never serves `/api/*`, auth, app, or portal routes. An app host never
      serves tunnel-host handling. Tested both ways, including a forged `Host` and a forged
      assertion header through the app site block.
- [ ] The template validator rejects a same-registrable-domain config.
- [ ] `__Host-bzt` is bound to the tunnel id. A cookie for tunnel A is rejected on tunnel B's
      host, and a cookie minted on A is not sent to B (host-only).
- [ ] Every path-mode gate runs in host mode: live authority, ownership, 12h cap, device
      online, policy, and activity/idle.
- [ ] `/__bz/*` is never forwarded to the device, and device responses cannot set
      `__Host-bzt`. Device `Set-Cookie` named `__Host-bzt` or `__Host-*` is dropped.
- [ ] `frame-ancestors` allows only the configured app origin.
- [ ] Device `Set-Cookie` `Domain=` is stripped. A device cookie cannot reach a sibling
      tunnel host (pre-PSL).
- [ ] Forwarded `Origin`/`Referer` rewriting never forwards the app origin or any Breeze
      credential.
- [ ] Cross-tunnel requests are refused before dispatch under the §4a rules, including
      GETs and `Sec-Fetch-Site` absent.
- [ ] Proxy cookies never reach the device. Device `__Host-*` cookies other than the
      reserved names pass through.
- [ ] A ticket exchange racing Close does not reopen the session, and outstanding tickets
      die on Close.
- [ ] `Service-Worker: script` requests are refused.
- [ ] Per-user, per-tunnel, and per-agent request-rate and concurrency budgets exist.
      Logs redact cookies and tickets. Metrics count auth failures, admission refusals, and
      dispatch failures by mode.

## Waves

| Wave | Scope | Exit criteria |
|---|---|---|
| **W00 — Spikes (before W01 is approved)** | Domain + DNS + ACM + Origin CA on one region against a stub; real Caddy routing with forged Host/assertion; CHIPS iframe + new-tab cookies in real Chrome, Firefox, and Safari (current and one older) | Written results appended to this spec; Open questions 1–3 answered |
| **W01 — API foundation** | Config + validator; shared core factored out of `tunnelHttp.ts` (path mode unchanged); conditional activation + Close cancels in-flight work (both modes); `http-ticket` returns `url`; Host dispatch scaffold (tunnel hosts fail closed). Off by default. | Unit + route tests; path-mode suites green |
| **W02 — API host mode** | Header/cookie rules; request admission (§4a); `tunnelHostRoutes` with `/__bz/enter` and `__Host-bzt`; host-mode rewriting; rate/concurrency budgets, metrics, log redaction; real-Caddy routing contract | Unit + route tests for every §9 checklist item; security review round |
| **W03 — Web** | `ProxyTunnelPage` uses the server `url`; host-mode sandbox attributes; new-tab ticket flow; Safari fallback notice | Web tests; Playwright run against a wt-stack with a local wildcard host (`*.tunnel.localhost`) in Chromium + Firefox, plus WebKit where available |
| **W04 — Infra + rollout** | Domain, DNS, certs, Caddy site block in repo + droplets, env mapping, self-host docs, PSL submission; enable on US, then EU | Lab: SonicWall SonicOS 7, a modern printer UI (the #5906 Xerox class), and a form-post-login device, in Chrome/Firefox/Safari; version-parity check post-deploy |
| **W05 — WebSocket proxying** *(optional, later)* | Upgrade passthrough over the agent tunnel | Separate spec |

Path mode and its #8110 workarounds stay in place throughout. Host mode ships opt-in at W04.
It becomes the hosted default only after verified PSL inclusion. A follow-up can deprecate path mode once self-hoster adoption is known.

## Open questions (for Todd)

1. **TLS route:** Cloudflare Advanced Certificate Manager (≈$10/mo per zone, simplest, keeps
   the CF proxy), or Caddy DNS-01 wildcard (free, needs a custom Caddy image and a CF API
   token on the droplets)? *Recommend ACM.* It keeps the existing CF-fronted setup and needs
   no custom Caddy build.
2. **Domain name:** `breezetunnel.net`, or something under the LanternOps brand? It must be
   a new registrable domain, not a subdomain of `2breeze.app`.
3. **PSL timing:** ship host mode opt-in before PSL inclusion, and make it the hosted
   default only once PSL inclusion is verified in shipped browser lists. *Recommend this.*
   It was revised after the advisor review: `__Host-` protects proxy auth, but not device
   session cookies from cross-tunnel fixation.
