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

**Opt-in is per partner (decided 2026-10-12).** The region env var makes host mode
*available*. The partner setting `networkProxy.dedicatedTunnelOrigin` decides whether that
partner's sessions *use* it:
- Home: Partner Settings → Remote Access.
- Level: partner only, with no org override.
- Resolver: `isTunnelOriginEnabledForOrg`, used by the ticket route and re-checked by
  `/__bz/enter`.
- Default: off, until PSL inclusion is verified (§1).

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

## W00 spike results (2026-10-12)

Run locally per plan amendment 2: app on `app.localhost`, tunnels on `*.tunnel.localhost`.
Task 0.1 (DNS, ACM, hosted ingress) moved to W04 and was not run. Harness, runners and raw
per-browser results: `docs/superpowers/plans/monitoring/evidence/2026-10-12-tunnel-origin-w00/`
(`results/summary.txt` is the condensed view; each `results/<profile>-<scheme>.json` holds
every request the server saw, with its `Cookie` and `Sec-Fetch-*` headers).

### Results that contradict this spec as written

The design sections above are left unchanged. These need a decision before W02.

1. **§4 step 2 ("sets the auth cookie and `302`s to `/`") conflicts with §4a.** In every
   engine run, the `GET /` that follows a 302 from `/__bz/enter` carried
   `Sec-Fetch-Site: cross-site`. §4a would refuse the first device page. The plan's G1
   resolution works: a 200 bootstrap page that pings `/__bz/ping` and then calls
   `location.replace('/')` produced `same-origin` on `/` in every engine.
2. **§4 fallback and the Goals ("SPAs using web storage") miss a Chrome case.** This is
   Chrome 154 with third-party cookies blocked. The block was applied three ways at once, so
   the effect cannot be attributed to any one of them:
   - the profile prefs `cookie_controls_mode=1` and `block_third_party_cookies=true`, which
     is how the settings UI stores the setting;
   - CDP `Network.setCookieControls`;
   - `--test-third-party-cookie-phaseout`.
   The control cookie confirms the block was in effect: an unpartitioned `SameSite=None`
   cookie was dropped. The `Partitioned`
   `__Host-bzt` still worked, so `/__bz/ping` returned 204 and no cookie-blocked notice fired.
   But `localStorage` threw `SecurityError` inside the tunnel iframe, both with and without
   the §6 sandbox attribute. A device SPA that uses web storage will fail in the iframe, and
   the user gets no fallback prompt. The cookie-only ping cannot detect this. The bootstrap
   check (plan Tasks 8 and 13) also needs a storage probe that triggers the "Open in New Tab"
   notice. In the new tab, `localStorage` worked.
3. **§3 ("Caddy's tunnel block 404s any host that does not match the wildcard pattern")
   does not hold in the `:80` catch-all configuration.** Hosts on the tunnel domain that
   miss both wildcards never reach the tunnel block. The app block served them, with no
   assertion header:
   - a trailing-dot tunnel host;
   - a three-label host (`a.b.c.<suffix>`);
   - the bare suffix.
   `/` went to `web`. By the app block's routing, `/api/*` would go to the API (inferred: not
   probed for these hosts). The app block needs its own reject for tunnel-domain hosts. The
   API classifier only ever sees `/api/*` paths from that block.

No contradiction was found with §4a's premise, the §4 cookie shape, or the §6 sandbox. See
"Cross-tunnel requests" below.

### Decisions
| Open question | Answer | Evidence |
|---|---|---|
| 1. Edge TLS | ACM (decided 2026-10-07). Origin hop: n/a, because Task 0.1 moved to W04 (plan amendment 2) | — |
| 2. Domain | n/a: configuration only, supplied at W04 (plan amendment 1) | — |
| 3. PSL timing | Opt-in until PSL inclusion is verified (decided 2026-10-07). The opt-in is per partner (plan amendment 3, 2026-10-12) | — |

### Hosted ingress (Task 0.1)
| Probe | Result |
|---|---|
| `https://<uuid>.us.<tunnel-domain>/` cert SAN + status | n/a: moved to W04 Task 17 |
| `https://a.b.us.<tunnel-domain>/` | n/a: moved to W04 Task 17 |
| `https://us.<tunnel-domain>/` | n/a: moved to W04 Task 17 |
| `cf-cache-status` (two requests) | n/a: moved to W04 Task 17 |
| API port published? (compose + `ss`) | Compose: no `ports`/`expose`/`network_mode` key on `api` in `deploy/docker-compose.prod.yml` (rendered with `config --no-interpolate`). No service in that file publishes a port. `ss` on the droplet: n/a, because W00 used no ssh. (The repo's dev `docker-compose.yml` publishes only caddy's 80/443.) |

### Caddy routing (Task 0.2)
Real `caddy:2-alpine`, `docker/Caddyfile.prod` plus the proposed tunnel block (plan Task 10)
plus a site-level `request_header -X-Breeze-Tunnel-Site` in the app block. Settings:
`CADDY_SITE_ADDRESS=:80`, and
`TUNNEL_SITE_ADDRESS='http://*.us.breezetunnel.test, http://*.*.us.breezetunnel.test'`.
The stub echoes `upstream|host|X-Breeze-Tunnel-Site|path`. Script: `caddy-routing.sh`;
output: `results/caddy-routing.txt`.

| Host / header | Upstream body |
|---|---|
| tunnel `/` | `api\|<uuid>.us.breezetunnel.test\|1\|/` |
| tunnel `/api/v1/auth/me` | `api\|…\|1\|/api/v1/auth/me` (never app routing) |
| tunnel `/portal/login` | `api\|…\|1\|/portal/login` |
| tunnel + forged assertion (one or two `X-Breeze-Tunnel-Site` copies) | `api\|…\|1\|/`: replaced, not appended |
| tunnel, uppercase host | `api\|<UUID>.US.BREEZETUNNEL.TEST\|1\|/`. Matched, case preserved, so the API must lowercase. |
| tunnel, explicit `:80` | `api\|…\|1\|/` |
| tunnel, trailing dot | `web\|<uuid>.us.breezetunnel.test.\|\|/`: **app block** (contradiction 3) |
| `a.b.<suffix>` | `api\|a.b.us.breezetunnel.test\|1\|/` (G10 `*.*` form works) |
| `a.b.c.<suffix>` | `web\|a.b.c.us.breezetunnel.test\|\|/`: **app block** (contradiction 3) |
| bare suffix | `web\|us.breezetunnel.test\|\|/`: app block, as the plan expected |
| app `/api/v1/health` + forged assertion | `api\|app.example.test\|\|/api/v1/health`: stripped |
| app `/` + forged assertion | `web\|app.example.test\|\|/`: stripped |
| app `/portal/login` + forged assertion | `portal\|app.example.test\|\|/portal/login`: stripped |
| app `/` + `X-Forwarded-Host: <tunnel host>` | `web\|app.example.test\|\|/`: no effect on routing |
| `TUNNEL_SITE_ADDRESS` unset / empty | Unset: adapts (exit 0) and the block matches only `tunnel-disabled.invalid`. Empty: `caddy adapt` **fails** (exit 1, `server block without any key is global configuration, and if used, it must be first`). Compose must therefore always pass `${TUNNEL_SITE_ADDRESS:-…}`, with `:-` so that empty also gets the default. |

### Secure and Partitioned cookies on `http://*.localhost` (plan amendment 2)
| Engine | `Secure`, `__Host-` and `Partitioned` cookies stored over http | `isSecureContext` | `Sec-Fetch-*` sent over http | Flows taken from |
|---|---|---|---|---|
| Chromium 151 (Playwright) | yes | true | yes | http and https: identical results |
| Chrome 154.0.8037.58 stable | yes | true | yes | http and https: identical results |
| Firefox 153 (Playwright build) | yes | true | yes | http and https: identical results |
| Firefox 157.0.1 stock | yes | true | yes | http only (a throwaway profile does not trust Caddy's CA) |
| WebKit 26.5 (Playwright) | **no**: only the non-`Secure` cookie was stored, even though `isSecureContext` was true | true | yes | **https** behind Caddy `tls internal` (the http run fails at `/__bz/ping`) |

### Browsers (Task 0.3)
Abbreviations: "SFS" means `Sec-Fetch-Site`; "3P" means third-party.

Columns:
- **Partitioned?** — `__Host-bzt` was absent when the same tunnel host was then loaded top-level.
- **3P control** — an unpartitioned `SameSite=None` cookie set beside `__Host-bzt`.
- **Sibling** — requests from tunnel s2's page to tunnel s1, which sit in the same app tab and
  partition.

Every row ran the same flows, all of which come from the harness:
- the iframe bootstrap flow, then the same flow inside the exact §6 sandbox attribute set;
- the iframe 302 flow;
- the new tab: `about:blank`, `opener = null`, then `location.replace`;
- the sibling flow.

In every engine, the sandboxed run matched the unsandboxed run.

| Browser + version | ping saw cookie | SFS on `/` (302) | SFS on `/` (bootstrap) | localStorage (iframe) | device cookie after form POST | document.cookie | Partitioned? / 3P control | tab: auth + session | sibling SFS / auth attached / toss reached |
|---|---|---|---|---|---|---|---|---|---|
| Chromium 151 (Playwright) | yes | cross-site | same-origin | ok | yes | yes | yes / sent (3PC allowed) | yes / yes | same-site / yes / yes |
| Chrome 154 stable (default, headless, temp profile) | yes | cross-site | same-origin | ok | yes | yes | yes / sent (3PC allowed) | yes / yes | same-site / yes / yes |
| Chrome 154 stable (3PC blocked: profile prefs + CDP cookie controls + phaseout flag, the same recipe as contradiction 2) | yes | cross-site | same-origin | **throws `SecurityError`** | yes | yes | yes / **blocked**, so blocking was in effect | yes / yes (tab `localStorage` ok) | same-site / yes / yes (`Partitioned` toss only; unpartitioned toss blocked) |
| Chromium 151 (3PC blocked) | n/a: blocking was not in effect (3P control still sent with the profile pref, the CDP cookie controls and `--test-third-party-cookie-phaseout`), so this row is not a result | | | | | | | | |
| Chrome stable−1 | n/a: not available in this run | | | | | | | | |
| Firefox 157.0.1 stock (headless, fresh profile; shipped `cookieBehavior=5` read from `omni.ja`) | yes | cross-site | same-origin | ok | yes | yes | yes / sent, but partitioned (TCP) | yes / yes | same-site / yes / yes |
| Firefox 153 Playwright, stock prefs (`cookieBehavior=5`, `CHIPS.enabled=true`) | yes | cross-site | same-origin | ok | yes | yes | yes / sent, partitioned | yes / yes | same-site / yes / yes |
| Firefox 153 Playwright default (`cookieBehavior=4`, `CHIPS.enabled=false`) | yes | cross-site | same-origin | ok | yes | yes | **no**: `Partitioned` ignored, `__Host-bzt` visible top-level / sent, unpartitioned | yes / yes | same-site / yes / yes |
| Firefox ESR | n/a: not available in this run | | | | | | | | |
| WebKit 26.5 (Playwright, https): **an approximation of Safari** | yes | cross-site | same-origin | ok | yes | yes | yes / **blocked** (3PC blocked by default) | yes / yes | **cross-site** / yes / yes (`Partitioned` toss) |
| Safari 26.x | n/a: not run (see below) | | | | | | | | |
| Safari 25/18.x | n/a: not run | | | | | | | | |

Notes:
- The `/__bz/enter` request was `cross-site` in every engine, both from the iframe and from
  the new tab. So the §4a exemption for `/__bz/enter` is required.
- **Chromium-family default is `SameSite=Lax`.** The secure-cookie probe set a cookie
  without `SameSite=None` in the iframe; Chrome did not send it back there, while Firefox
  did. This confirms that §5 must force `SameSite=None; Partitioned` on device cookies in the
  iframe context.
- **Playwright's Firefox is not stock Firefox for this feature.** Its `playwright.cfg` sets
  `network.cookie.cookieBehavior=4` and `network.cookie.CHIPS.enabled=false`, which makes
  `__Host-bzt` an unpartitioned third-party cookie. W03's Playwright Firefox project must
  set the two stock prefs, or it tests a configuration no user has.
- **The new-tab flow without a user gesture is Playwright-specific.** Playwright disables
  popup blocking, and the stock Firefox run set `dom.disable_open_during_load=false`. G5
  (a popup opened after an `await`) was **not** tested.
- **The sibling results are approximations.** `.localhost` is not on the PSL, so how an
  engine classifies `s1.tunnel.localhost` against `s2.tunnel.localhost` is its unknown-TLD
  fallback. Chromium and Firefox called it `same-site`; WebKit called it `cross-site`. It
  approximates production pre-PSL; it does not prove it.
- **HTTPS rows used `ignoreHTTPSErrors`** against Caddy's untrusted internal CA. The http and
  https results matched for every engine that ran both.

**Safari (WebKit stands in).** Playwright's WebKit 26.5 is not Safari. It has no ITP state,
and it differs from Safari in networking stack and cookie policy UI. Still to verify in real
Safari 26.2+, once on a real tunnel domain over trusted TLS:
- that the `Partitioned` `__Host-bzt` is stored and sent in the iframe (spec §4 support claim);
- that iframe `localStorage` works;
- the SFS between sibling tunnel hosts pre-PSL;
- the 302-vs-bootstrap SFS;
- that the new-tab open after the ticket `await` is not popup-blocked (G5).

A pre-26.2 Safari is expected to show the cookie-blocked notice. That expectation is
inferred and was not observed.

### Cross-tunnel requests (§4a)
In every engine with working cookies, s2's page loaded inside the same app tab and sent
credentialed requests at s1: `fetch` POST, `fetch` GET, an `<img>` GET and a form POST.
Every one of them **carried s1's `__Host-bzt`**, because the two share the app's partition.
The SFS was `same-site` (Chromium, Firefox) or `cross-site` (WebKit), and never
`same-origin`. The §4a rule (only `same-origin`/`none` admitted, GET included) refuses all
of them. This confirms §4a's premise.

The cookies s2 wrote through `document.cookie` with `Domain=tunnel.localhost` reached s1
in every engine, which is cookie tossing pre-PSL (§1):
- Chrome with 3PC blocked and WebKit accepted only the `Partitioned` variant;
- the other engines accepted both.

### Plan-level spec amendments (from the implementation plan G1–G10)
- **G1 (§4 vs §4a, 302 vs admission): Confirmed.** The 302 variant gave `cross-site` on `/`
  in every engine. The bootstrap variant gave `same-origin`. See contradiction 1.
- **G2 (§8, hosted ingress is Cloudflare Tunnel): not tested.** Task 0.1 moved to W04.
- **G3 (§6/§7, no runtime template in the web image): not tested.** This is a design note
  with nothing to measure.
- **G4 (§2, `http://` + port for `*.localhost` outside production): Confirmed for Chromium and
  Firefox. Refuted for WebKit.** WebKit stores no `Secure` cookie on `http://*.localhost`, so
  W03's WebKit Playwright run needs TLS (Caddy `tls internal`).
- **G5 (§4/§7, popup after `await`): not tested.** Playwright disables popup blocking. The
  `about:blank` → `opener = null` → `location.replace` sequence itself worked in every
  engine.
- **G6 (§2 response shape): not tested.** No browser behaviour is involved.
- **G7 (§3 rate-limit bucket): not tested.** This is API-internal.
- **G8 (§9 tickets die on Close): not tested.** This is API-internal.
- **G9 (§4 cancel in-flight across replicas): not tested.** This is API-internal.
- **G10 (§3/§8 depth): Confirmed, and wider than planned.** The `*.*` form catches two
  labels. Three or more labels, a trailing dot and the bare suffix all fall through to the
  app block (contradiction 3).
