---
title: Network Proxy — dedicated tunnel origin (implementation plan)
tracking_issue: LanternOps/breeze#8155
date: 2026-10-07
area: monitoring / remote access
spec: docs/superpowers/specs/monitoring/2026-10-06-network-proxy-tunnel-origin-design.md
depends_on: PR #8110 (fix/network-proxy-sandbox-subresource-auth) merged to main before W01 starts
---

# Network Proxy Dedicated Tunnel Origin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve proxied LAN-device web UIs from a per-tunnel origin on a separate registrable domain (`https://<tunnelId>.<region>.<tunnel-domain>`), so device UIs run unmodified, while path mode (`/api/v1/tunnel-http/…`, #8110) stays as the default and fallback.

**Architecture:** A Host-classifier middleware in `apps/api/src/index.ts` recognises tunnel hosts (template suffix plus a Caddy-only assertion header) and hands them to a separate Hono app, `tunnelHostRoutes`, before any app route, CORS or app security header runs. Host mode reuses one shared core extracted from `tunnelHttp.ts`: live authority, ownership, the 12h cap, device online, policy, activity, agent dispatch and decompression. Only authentication (`/__bz/enter` ticket exchange to a `__Host-bzt` cookie), request admission, rewriting and response headers differ. The web page takes the iframe/new-tab URL from the server and validates it before rendering.

**Tech Stack:** Hono 4.13 (`hono/cookie` `generateCookie` with `partitioned`), jose JWT (existing keyring in `services/jwt.ts`), `tldts` (already an API dependency), prom-client, Vitest, React + Vitest/jsdom, Playwright 1.62/1.63, Caddy 2, Cloudflare (DNS, Advanced Certificate Manager, Cloudflare Tunnel / Origin CA).

**Spec:** `docs/superpowers/specs/monitoring/2026-10-06-network-proxy-tunnel-origin-design.md` (read it in full; section refs below are to it).

**Tracking:** after Todd approves this plan, the orchestrator registers it with the `feature-lifecycle` MCP (`register_feature`: one parent plus waves W00, W01, W02, W03, W04) and adds `tracking_issue: LanternOps/breeze#<parent>` to this file's frontmatter. Each wave branch is `feature/<parent#>-network-proxy-tunnel-origin/wave-<sub#>`, and its PR body carries `Closes #<sub#>`.

## Wave → PR map

| Wave | PR | Tasks | Notes |
|---|---|---|---|
| W00 spikes | 1 docs PR (spec results + harness) | 0.1–0.4 | Gate: Todd approves W01 only after results are appended to the spec |
| W01 API foundation | 1 PR | 1–5 | Config/validator, shared core, revocation race fix, server-built URL, Host dispatch scaffold (tunnel hosts 404) |
| W02 API host mode | 1 PR | 6–11 | Header/cookie rules, admission, `tunnelHostRoutes`, budgets/metrics, real-Caddy contract, security-checklist exit |
| W03 web | 1 PR | 12–15 | Server URL, validation, sandbox, new tab, cookie-blocked notice, `runAction` close, Playwright |
| W04 infra + rollout | 1 docs PR + ops runbook (no app code) | 16–19 | Several steps need **[TODD]** |
| W05 WebSockets | none | — | Separate spec later |

The API work is split into two waves (W01, W02) because it is large and has two separable review surfaces. W01 changes behaviour in path mode (conditional activation, close cancels in-flight requests), and its host-mode routing is fail-closed (every tunnel host gets a 404). W02 is the security-critical host-mode surface. W01 must merge before W02 starts. **W01 itself must start only after #8110 merges to `main`**: every `tunnelHttp.ts` line reference below is to the #8110 version (`git show origin/fix/network-proxy-sandbox-subresource-auth:apps/api/src/routes/tunnelHttp.ts`).

## Global Constraints

- No schema changes and no migrations. `tunnel_sessions` and every authorization gate are reused unchanged (spec Goals).
- Path mode (`/api/v1/tunnel-http/<id>/<pathToken>/…`, #8110) keeps its behaviour and stays the fallback. Its existing suite `apps/api/src/routes/tunnelHttp.test.ts` must stay green throughout. The only intended path-mode changes are the two revocation fixes the spec mandates for "both modes" (§4 Revocation) and the new metrics.
- The feature is off by default. With `TUNNEL_ORIGIN_TEMPLATE` unset, `tunnelHostRoutes` is unreachable, `POST /tunnels/:id/http-ticket` returns a path-mode URL, and the Caddy tunnel block matches only the placeholder `tunnel-disabled.invalid`.
- Never hardcode the tunnel domain. Everything derives from `TUNNEL_ORIGIN_TEMPLATE`, `TUNNEL_FRAME_ANCESTOR` and `TUNNEL_SITE_ADDRESS` (plus the optional `TUNNEL_TLS_DIRECTIVE`). Tests use `https://{id}.us.breezetunnel.test`, and dev/e2e use `http://{id}.tunnel.localhost:<port>`. Infra tasks name "the chosen tunnel domain", recorded in W00 Task 0.1.
- Tunnel hosts never serve app or API routes, auth, web, portal or billing. An app host never reaches tunnel-host handling.
- The template is exactly `https://{id}.<suffix>`, with no userinfo, path, query, fragment or port, exactly one `{id}`, and `{id}` as the leftmost label. **Plan-level exception (spec gap G4):** outside `NODE_ENV=production`, `http://` and a port are accepted only when the suffix is `localhost` or ends in `.localhost`.
- The proxy's reserved cookie names are exactly `__Host-bzt` (iframe, `SameSite=None; Partitioned`) and `__Host-bzt-top` (new tab, unpartitioned `SameSite=Lax`). Both are `Path=/; Secure; HttpOnly`, with a 5-minute sliding TTL (`HTTP_TUNNEL_COOKIE_TTL_SECONDS = 300`).
- Every reserved path is under `/__bz/` and is never forwarded to the device.
- Host-mode response headers are `Content-Security-Policy: frame-ancestors <TUNNEL_FRAME_ANCESTOR> 'self'` (no `sandbox`), `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. Device `access-control-*`, CSP and X-Frame-Options headers are stripped. A request with `Service-Worker: script` gets a 404.
- Host-mode iframe sandbox: `allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads`, only for a URL that passed `resolveProxyTarget`. The path-mode sandbox stays `allow-scripts allow-forms allow-popups`.
- New API env vars must be mapped in both `docker-compose.yml` (`x-api-env`) and `deploy/docker-compose.prod.yml`, registered in `system/connections/registry.ts`, and documented in `.env.example`. This is enforced by `envComposeParity.test.ts`, `envReadComposeCoverage.test.ts`, `envInventory.test.ts` and `registry.test.ts`.
- Web mutations go through `runAction` (`apps/web/src/lib/runAction.ts`).
- No infra IPs or hostnames in committed files. Droplet specifics stay in `/opt/breeze/.env` and `internal/`.
- Test commands: `cd apps/api && npx vitest run <file>` and `cd apps/web && npx vitest run <file>`. Never use `pnpm … test -- --run`. Typecheck with `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"`. Read the exit code: piping to `tail` hides an OOM.

## Review Focus

These are the input classes the spec implies but does not spell out. The test that pins each one lives in the named task.

1. **The redirect after the ticket exchange is cross-site (spec gap G1).** Per the Fetch spec, a 302 from `/__bz/enter` (reached by the app's cross-site iframe navigation) carries `Sec-Fetch-Site: cross-site` into the redirected `GET /`, so §4a would refuse the very first device page. A reasonable person expects the iframe to load. `/__bz/enter` therefore returns a 200 bootstrap page that pings `/__bz/ping` same-origin and then calls `location.replace('/')`. Pinned in Task 8 ("enter returns a bootstrap page, never a redirect") and measured per browser in W00 Task 0.3.
2. **Host header variants.** These include uppercase, a trailing dot, an explicit `:443`, the bare suffix, deeper labels (`a.b.<suffix>`) and a non-UUID leftmost label. Each must land on the tunnel surface (404/421), never on app routes. Pinned in Task 1 (`matchTunnelHost` / `isTunnelDomainHost`) and Task 5 (classifier).
3. **Percent-encoded reserved paths.** `/%5F%5Fbz/enter?t=…` must not reach the device with a ticket, and `/__bz/x` must never be forwarded. Pinned in Task 8.
4. **`Origin: null` and foreign Origins when `Sec-Fetch-Site` is absent.** This covers older browsers and device-internal sandboxed frames. Unsafe methods without a matching Origin are refused, and a GET with a foreign Origin is refused. Pinned in Task 7.
5. **Close racing an in-flight request or an exchange.** Close must not be followed by a reopened row or a late device response. Pinned in Task 3 (conditional activation, `cancelPendingAgentCommandsByPrefix`) and Task 8 (an exchange after close gets a 404 and no cookie).

## Spec gaps and contradictions found while planning (resolved here; to be recorded in the spec by W00 Task 0.4)

- **G1 (§4 vs §4a).** "302 to `/`" contradicts the admission rules (see Review Focus 1). Resolution: a 200 bootstrap page plus a same-origin `/__bz/ping` check, which also gives the "CHIPS unsupported / third-party cookies blocked" detection the spec asks for in §4 (the page `postMessage`s `breeze-tunnel-cookie-blocked` to the frame ancestor).
- **G2 (§8).** The spec assumes Cloudflare → Caddy with an Origin CA cert and Full (strict). Hosted production is actually **Cloudflare Tunnel**: `deploy/docker-compose.prod.yml` service `tunnel` (cloudflared) → `caddy` on the docker network. The global-options comment in `docker/Caddyfile.prod` says "Internet -> cloudflared … -> Caddy". The hosted DNS is therefore a proxied CNAME to the tunnel, with a wildcard ingress rule in `/opt/breeze/cloudflared/config.yml`. The Caddy hop is plain HTTP inside docker, so an Origin CA cert is likely unnecessary on hosted. ACM is still needed at the edge for the two-level wildcard. W00 Task 0.1 confirms this. The Caddy block supports both shapes through `TUNNEL_SITE_ADDRESS` plus an optional `TUNNEL_TLS_DIRECTIVE` (Task 10).
- **G3 (§6/§7).** "The web code asserts the iframe URL is on the tunnel domain (template match)" cannot be done as written, because the web image has no runtime config. Astro `PUBLIC_*` values are baked at build time, and the GHCR image is region-agnostic. Resolution: structural validation (`resolveProxyTarget`, Task 12), with the server validator (Task 1) as the authority on registrable-domain separation.
- **G4 (§2).** A validator with "https only, no port" makes local dev and Playwright impossible. Resolution: `http://` plus a port only for `*.localhost`, and only outside production.
- **G5 (§4/§7 new tab).** `window.open(url, '_blank', 'noopener')` after an `await` (the ticket mint) is blocked as a popup in Safari and Firefox, and `noopener` returns no handle. Resolution: open `about:blank` synchronously in the click handler, set `opener = null`, then `location.replace(url)` after the mint (Task 14).
- **G6 (§2 response shape).** Today `http-ticket` returns `{ ticket: { ticket, expiresInSeconds } }` (`tunnels.ts` ~line 1352, and the web reads `body.ticket?.ticket`). Resolution: keep that shape and add `url` and `mode: 'host' | 'path'`.
- **G7 (§3 "admission … run before Host dispatch").** `globalRateLimit` buckets by **path prefix**. Tunnel-host requests have arbitrary paths, so device subresources would drain the shared 300/min per-IP dashboard bucket. Resolution: a dedicated `tunnelhost` bucket keyed on the classifier flag (Task 5).
- **G8 (§9 "outstanding tickets die on Close").** Tickets are random Redis keys (`remote:ws_ticket:<secret>`, `services/remoteSessionAuth.ts` ~line 86) with no per-session index, so they cannot be enumerated and deleted. They die because the exchange requires a connectable row, and the conditional activation closes the race. Pinned by tests rather than by new storage.
- **G9 (§4 cancel in flight).** `agentCommandAwait`'s `pending` map is process-local and API-role-affine. A DELETE served by a different API replica than the in-flight request cannot cancel it. Today each region runs one `api` container, so this is acceptable. Recorded as a limitation.
- **G10 (§3/§8).** The Caddy wildcard `*.us.<domain>` matches exactly one label. In the hosted `:80` catch-all configuration, a deeper host would fall through to the **app** block and be served the web app on the tunnel domain. Resolution: `TUNNEL_SITE_ADDRESS` lists both `*.` and `*.*.` forms, and the API treats any host at or under the suffix as tunnel surface (Tasks 1, 5, 10).

## Current code that contradicts spec assumptions (verified 2026-10-07)

- **Close does not revoke anything HTTP-specific.** `DELETE /tunnels/:id` (`apps/api/src/routes/tunnels.ts` ~lines 1143–1215) sends `tunnel_close` to the agent, runs an unconditional `UPDATE … status='disconnected'`, and calls `revokeViewerSession(id)`, which only affects viewer JWTs. Tunnel-http tickets and cookies are not touched. Cookies stop working only because every proxied request re-reads the row status through `loadOwnedTunnelSession`.
- **The exchange's activation is unconditional.** `tunnelHttp.ts` (#8110, lines 586–592) runs `db.update(tunnelSessions).set({ status: 'active', … }).where(eq(id))`. A ticket consumed after `loadOwnedTunnelSession` read `active` but before the write can flip a just-closed row back to `active`.
- **No in-flight cancellation exists.** `services/agentCommandAwait.ts` exposes only `sendCommandToAgentAwaitResult` and `resolvePendingAgentCommand`.
- **The web Close is fire-and-forget.** `ProxyTunnelPage.tsx` lines 200–203 call `fetchWithAuth(DELETE).catch(() => {})` and then `setStatus('disconnected')` unconditionally.
- **"Open In New Tab" reuses the iframe's already-consumed ticket URL** (`href={proxyUrl}`, line 254). In path mode the new tab lands on `/api/v1/tunnel-http/<id>/?__bzt=<spent>`. The cookie it may carry is path-scoped to `/<id>/<token>/`, so this reads as broken today (401 or 404). W03 Task 14 fixes it in both modes with a fresh `mode=tab` ticket.
- **App-wide headers merge into returned responses.** This is documented at `apps/api/src/index.ts` ~lines 452–467. Exempting the tunnel host therefore needs the same exemption as the path prefix: `secureHeaders`, the `securityMiddleware` headers and `cors`, not just a route mount.

---

## File structure

**API (W01)**

| File | Responsibility |
|---|---|
| `apps/api/src/config/tunnelOrigin.ts` (new) | Pure parse/validate of `TUNNEL_ORIGIN_TEMPLATE` / `TUNNEL_FRAME_ANCESTOR`, a cached runtime getter, URL builders, and Host matching |
| `apps/api/src/config/validate.ts` | Schema keys plus a superRefine call into `parseTunnelOriginConfig` |
| `apps/api/src/routes/tunnelHttpCore.ts` (new) | Shared gates, cookie JWT, dispatch, decompression and activation, extracted from `tunnelHttp.ts` |
| `apps/api/src/routes/tunnelHttp.ts` | Path mode, now a thin consumer of the core |
| `apps/api/src/services/agentCommandAwait.ts` | `cancelPendingAgentCommandsByPrefix` |
| `apps/api/src/routes/tunnels.ts` | `http-ticket` returns `{ticket, url, mode}`; DELETE cancels in-flight requests |
| `apps/api/src/middleware/tunnelHostDispatch.ts` (new) | Host classification, the assertion header, dispatch, and the exemption wrappers |
| `apps/api/src/middleware/security.ts`, `globalRateLimit.ts` | Predicate-based header skip and the `tunnelhost` bucket |
| `apps/api/src/index.ts` | Middleware wiring |
| `apps/api/src/routes/tunnelHostHeaders.ts` (new) | Host-mode request/response header and cookie rules (pure) |
| `apps/api/src/routes/tunnelHostAdmission.ts` (new) | §4a admission (pure) |
| `apps/api/src/routes/tunnelHttpRewrite.ts` | `injectBase` option |
| `apps/api/src/routes/tunnelHost.ts` (new) | `tunnelHostRoutes`: `/__bz/enter`, `/__bz/ping`, and the proxy |
| `apps/api/src/services/tunnelHttpBudget.ts`, `tunnelHttpMetrics.ts` (new) | Rate and concurrency budgets, and the Prometheus counter |
| `docker/Caddyfile.prod`, `scripts/check-tunnel-site-routing.sh` (new), `.github/workflows/ci.yml` | Tunnel site block and the real-Caddy contract |

**Web (W03)**

| File | Responsibility |
|---|---|
| `apps/web/src/lib/proxyTunnelUrl.ts` (new) | `resolveProxyTarget` and the sandbox constants |
| `apps/web/src/components/remote/ProxyTunnelPage.tsx` | Server URL, mode sandbox, new tab, cookie-blocked notice, `runAction` close |
| `apps/web/src/locales/*/remote.json` | 4 new keys × 8 locales |
| `e2e-tests/helpers/tunnelOriginStack.ts`, `e2e-tests/tests/network-proxy-tunnel-origin.spec.ts`, `e2e-tests/playwright.tunnel-origin.config.ts`, `scripts/dev/wt-stack/env.ts` | Playwright against a wt-stack with `*.tunnel.localhost` |

---

# W00 — Spikes (before W01 is approved)

Exit: every Open question (spec §Open questions 1–3) is answered, and the results section below is appended to the spec, along with the G1–G10 list from this plan. Spikes 0.2 and 0.3 run locally and need no Todd input. Spike 0.1 needs **[TODD]**.

### Task 0.1: Tunnel domain, edge TLS and ingress on one region against a stub [TODD for domain/billing]

**Files:**
- Modify: `docs/superpowers/specs/monitoring/2026-10-06-network-proxy-tunnel-origin-design.md` (append results only)

**Inputs recorded here:** the chosen tunnel domain (written as `<tunnel-domain>` below; it is **never** committed into code or compose), the Cloudflare zone, and the region used (US).

- [ ] **Step 1 [TODD]: Choose and register the tunnel domain** (spec Open question 2). It must be a new registrable domain, not under `2breeze.app`. Add it as a zone in the same Cloudflare account as the app zone. Record only the name in the spec results (it is public anyway once used).
- [ ] **Step 2 [TODD]: Order Advanced Certificate Manager on the new zone** with hostnames `*.us.<tunnel-domain>` and `*.eu.<tunnel-domain>` (spec Open question 1, decided: ACM). Wait for status `Active`:
  Run in the Cloudflare dashboard: SSL/TLS → Edge Certificates → Order Advanced Certificate.
  Expected: two wildcard SANs, status Active.
- [ ] **Step 3: Establish the real hosted ingress path (G2).** On the US droplet, read the current tunnel config without changing it:
  Run: `ssh root@<us-droplet> "cat /opt/breeze/cloudflared/config.yml | sed -n '1,80p'; docker ps --format '{{.Names}}' | grep -E 'tunnel|caddy'"`
  Expected: an `ingress:` list ending with a catch-all `- service: http_status:404`, and the app hostname pointing at `http://caddy:80` (or `https://caddy:443`). Record which.
- [ ] **Step 4: Stub the wildcard through cloudflared's built-in `hello_world` service** (no Caddy or API change). Back up the file, then add the rule *above* the catch-all:
  ```bash
  ssh root@<us-droplet> "cp /opt/breeze/cloudflared/config.yml /opt/breeze/cloudflared/config.yml.bak-tunnel-spike"
  # add under ingress:, before the final http_status:404 rule:
  #   - hostname: "*.us.<tunnel-domain>"
  #     service: hello_world
  ssh root@<us-droplet> "cd /opt/breeze && docker compose restart tunnel"
  ```
  DNS [TODD or delegated]: in the `<tunnel-domain>` zone, create a proxied CNAME `*.us` → `<tunnel-uuid>.cfargotunnel.com`. The tunnel UUID is in `config.yml` (`tunnel:`).
- [ ] **Step 5: Verify edge TLS, routing and depth behaviour**:
  ```bash
  ID=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee
  curl -sv "https://$ID.us.<tunnel-domain>/" -o /dev/null 2>&1 | grep -E 'subject:|subjectAltName|HTTP/'
  curl -sv "https://a.b.us.<tunnel-domain>/" -o /dev/null 2>&1 | grep -E 'SSL|HTTP/|error'
  curl -s -o /dev/null -w '%{http_code}\n' "https://us.<tunnel-domain>/"
  curl -sI "https://$ID.us.<tunnel-domain>/" | grep -iE 'cf-cache-status|server'
  ```
  Expected: the first returns `HTTP/2 200` with SAN `*.us.<tunnel-domain>`. The second fails TLS (no cert covers two labels). Record this, because it is what makes G10's second-level wildcard unreachable from browsers on hosted. Record the third. The fourth shows `cf-cache-status: DYNAMIC` or `BYPASS`.
- [ ] **Step 6: Decide the origin TLS shape and record it.** If ingress is `http://caddy:80` (expected), the hosted `TUNNEL_SITE_ADDRESS` is `http://*.us.<tunnel-domain>, http://*.*.us.<tunnel-domain>` and no Origin CA cert is installed (Full (strict) does not apply to tunnel-routed hostnames). If the region is instead A-record → Caddy:443, record that the Origin CA path (W04 Task 17 Step 4b) is required.
- [ ] **Step 7: Configure and verify the Cloudflare rules on the zone [TODD or delegated]**: a Cache Rule "Bypass cache" for `*.us.<tunnel-domain>` and `*.eu.<tunnel-domain>`. Under Security, a Configuration Rule for the same hostnames with Browser Integrity Check off and Security Level "Essentially off". Bot Fight Mode off for the zone.
  Run: `for i in 1 2; do curl -sI "https://$ID.us.<tunnel-domain>/" | grep -i cf-cache-status; done`
  Expected: never `HIT`.
- [ ] **Step 8: Revert the stub**:
  `ssh root@<us-droplet> "cp /opt/breeze/cloudflared/config.yml.bak-tunnel-spike /opt/breeze/cloudflared/config.yml && cd /opt/breeze && docker compose restart tunnel"`. Keep the DNS record and ACM (they are W04 inputs). Then verify the app still answers: `curl -sf https://us.2breeze.app/health`.

### Task 0.2: Real Caddy routing with forged Host and assertion headers (local docker)

**Files:**
- Create (scratch, not committed): `$SCRATCH/caddy-spike/` (use the session scratchpad)

- [ ] **Step 1: Build a scratch copy of the Caddyfile with the proposed tunnel block appended** (the same block W01 Task 10 commits):
  ```bash
  S="$SCRATCH/caddy-spike"; mkdir -p "$S"
  cp docker/Caddyfile.prod "$S/Caddyfile"
  cat >> "$S/Caddyfile" <<'EOF'

  {$TUNNEL_SITE_ADDRESS:http://tunnel-disabled.invalid} {
  	{$TUNNEL_TLS_DIRECTIVE}
  	request_header -X-Breeze-Tunnel-Site
  	request_header -X-Breeze-Client-Cert-Verified
  	request_header -X-Breeze-Client-Cert-Serial
  	reverse_proxy api:3001 {
  		header_up X-Breeze-Tunnel-Site 1
  		header_up -Cf-Client-Cert-Verified
  		header_up -Cf-Client-Cert-Serial
  		header_up -Cf-Client-Cert-Der-Base64
  		header_up -Cf-Client-Cert-Sha256
  	}
  }
  EOF
  # and add `request_header -X-Breeze-Tunnel-Site` next to the two existing
  # site-level request_header lines in the {$CADDY_SITE_ADDRESS::80} block.
  ```
- [ ] **Step 2: Create stub upstreams that echo who they are and what they received**:
  ```bash
  cat > "$S/stub.Caddyfile" <<'EOF'
  {
  	admin off
  	auto_https off
  }
  :3001 {
  	respond "api|{host}|{header.X-Breeze-Tunnel-Site}|{path}"
  }
  :4321 {
  	respond "web|{host}|{header.X-Breeze-Tunnel-Site}|{path}"
  }
  :4322 {
  	respond "portal|{host}|{header.X-Breeze-Tunnel-Site}|{path}"
  }
  :3002 {
  	respond "billing|{host}|{header.X-Breeze-Tunnel-Site}|{path}"
  }
  EOF
  docker network create caddy-spike
  docker run -d --name caddy-spike-stub --network caddy-spike --network-alias api --network-alias web --network-alias portal --network-alias billing -v "$S/stub.Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine
  docker run -d --name caddy-spike-edge --network caddy-spike --network-alias edge -e CADDY_SITE_ADDRESS=':80' -e TUNNEL_SITE_ADDRESS='http://*.us.breezetunnel.test, http://*.*.us.breezetunnel.test' -v "$S/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine
  ```
- [ ] **Step 3: Probe** (one line per case; record each output in the results table):
  ```bash
  p() { docker run --rm --network caddy-spike curlimages/curl:8.10.1 -s -H "Host: $1" "${@:3}" "http://edge:80$2"; echo; }
  T=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.us.breezetunnel.test
  p "$T" /                                   # expect api|$T|1|/
  p "$T" /api/v1/auth/me                     # expect api|…|1|/api/v1/auth/me  (never app routing)
  p "$T" /portal/login                       # expect api|…|1|/portal/login
  p "$T" / -H 'X-Breeze-Tunnel-Site: forged' # expect …|1|… (replaced, not appended)
  p "a.b.us.breezetunnel.test" /             # expect api|a.b…|1|/  (G10)
  p "us.breezetunnel.test" /                 # record: expected web|…||/ (bare suffix → app block; API must 421 it)
  p "app.example.test" /api/v1/health -H 'X-Breeze-Tunnel-Site: 1'  # expect api|app.example.test||…
  p "app.example.test" / -H 'X-Breeze-Tunnel-Site: 1'               # expect web|app.example.test||/
  ```
- [ ] **Step 4: Check the unset and empty-variable behaviour of the placeholder default**:
  ```bash
  docker run --rm -v "$S/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine caddy adapt --config /etc/caddy/Caddyfile >/dev/null && echo UNSET-OK
  docker run --rm -e TUNNEL_SITE_ADDRESS= -v "$S/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine caddy adapt --config /etc/caddy/Caddyfile 2>&1 | tail -2
  ```
  Record whether an **empty** value falls back to the default or errors. Compose always passes `${TUNNEL_SITE_ADDRESS:-http://tunnel-disabled.invalid}` (W01 Task 10), so either result is safe, but it must be recorded.
- [ ] **Step 5: Assert the API port is not reachable except through Caddy** (spec §3): `docker compose -f deploy/docker-compose.prod.yml config | grep -A30 '^  api:' | grep -nE 'ports:|published'`. Expected: no published port for `api`. On the US droplet, also run `ssh root@<us-droplet> "ss -ltnp | grep 3001 || echo no-host-listener"`.
- [ ] **Step 6: Clean up**: `docker rm -f caddy-spike-stub caddy-spike-edge; docker network rm caddy-spike`.

### Task 0.3: CHIPS iframe, new-tab cookies and admission headers in real browsers

**Files:**
- Create: `e2e-tests/browser-contracts/tunnel-origin/chips-harness-server.mjs`
- Create: `e2e-tests/browser-contracts/tunnel-origin/chips.spike.spec.ts`
- Create: `e2e-tests/playwright.tunnel-origin-spike.config.ts`

The harness uses two public loopback wildcard DNS names that sit in different registrable domains: `app.localtest.me` for the app and `<label>.127.0.0.1.sslip.io` for tunnels. Both resolve to 127.0.0.1 in every engine without resolver flags. Siblings `t1.` and `t2.` share a site unless `sslip.io` is on the PSL, so the run also measures the pre-PSL condition.

- [ ] **Step 1: Write the harness server**:

```js
// e2e-tests/browser-contracts/tunnel-origin/chips-harness-server.mjs
// W00 spike harness (spec 2026-10-06 §4/§4a). Not product code.
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.HARNESS_PORT ?? 8443);
const APP_HOST = process.env.HARNESS_APP_HOST ?? 'app.localtest.me';
const SUFFIX = process.env.HARNESS_TUNNEL_SUFFIX ?? '127.0.0.1.sslip.io';
const APP_ORIGIN = `https://${APP_HOST}:${PORT}`;

function loadCert() {
  if (process.env.HARNESS_CERT && process.env.HARNESS_KEY) {
    return { cert: readFileSync(process.env.HARNESS_CERT), key: readFileSync(process.env.HARNESS_KEY) };
  }
  const dir = mkdtempSync(join(tmpdir(), 'chips-harness-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=chips-harness',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
    '-addext', `subjectAltName=DNS:${APP_HOST},DNS:*.${SUFFIX}`], { stdio: 'ignore' });
  return { cert: readFileSync(join(dir, 'cert.pem')), key: readFileSync(join(dir, 'key.pem')) };
}

const log = [];
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
};
const cookieAttrs = (framed) => framed ? 'Path=/; Secure; SameSite=None; Partitioned' : 'Path=/; Secure; SameSite=Lax';

function report(stage, framed, extra) {
  // Posts to the app when framed; tab mode is observed through /__log.
  return `<script>(function(){var r=${JSON.stringify({ stage })};
Object.assign(r, ${JSON.stringify(extra)});
try{localStorage.setItem('k','v');r.localStorage=localStorage.getItem('k')==='v';}catch(e){r.localStorage='throws:'+e.name;}
try{document.cookie='jsdev=1; Path=/; Secure; SameSite=None; Partitioned';r.docCookieWrite=/jsdev=1/.test(document.cookie);}catch(e){r.docCookieWrite='throws';}
fetch('/probe',{method:'POST',body:'x'}).then(function(x){return x.text()}).then(function(t){r.probe=t;done();},function(){r.probe='failed';done();});
function done(){ if(${framed}&&parent!==window){parent.postMessage(r,${JSON.stringify(APP_ORIGIN)});} document.title=JSON.stringify(r);
 ${stage === 'root' ? "setTimeout(function(){document.getElementById('f').submit();},50);" : ''} }
})();</script>`;
}

createServer(loadCert(), (req, res) => {
  const host = (req.headers.host ?? '').split(':')[0];
  const url = new URL(req.url, `https://${req.headers.host}`);
  if (url.pathname === '/__log') { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(log)); return; }
  if (url.pathname === '/__reset') { log.length = 0; send(res, 204, ''); return; }
  const cookie = req.headers.cookie ?? '';
  log.push({ host, method: req.method, path: url.pathname, search: url.search, cookie,
    secFetchSite: req.headers['sec-fetch-site'] ?? null, secFetchDest: req.headers['sec-fetch-dest'] ?? null,
    origin: req.headers.origin ?? null });

  if (host === APP_HOST) {
    const label = url.searchParams.get('t') ?? 't1';
    const variant = url.searchParams.get('variant') ?? 'bootstrap';
    return send(res, 200, `<!doctype html><title>app</title>
<script>window.results=[];addEventListener('message',function(e){window.results.push({origin:e.origin,data:e.data});});</script>
<iframe id="f" src="https://${label}.${SUFFIX}:${PORT}/__bz/enter?variant=${variant}" style="width:900px;height:300px"></iframe>`);
  }
  if (!host.endsWith(`.${SUFFIX}`)) return send(res, 404, 'unknown host');
  const label = host.slice(0, -(SUFFIX.length + 1));
  const csp = `frame-ancestors ${APP_ORIGIN} 'self'`;
  const framed = !/__Host-bzt-top=/.test(cookie) && url.searchParams.get('mode') !== 'tab';

  if (url.pathname === '/__bz/enter') {
    const tab = url.searchParams.get('mode') === 'tab';
    const auth = tab ? `__Host-bzt-top=${label}; Path=/; Secure; HttpOnly; SameSite=Lax`
      : `__Host-bzt=${label}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned`;
    if (url.searchParams.get('variant') === '302') {
      res.writeHead(302, { location: '/', 'set-cookie': auth, 'content-security-policy': csp, 'cache-control': 'no-store' });
      return res.end();
    }
    // Bootstrap variant = the plan's G1 resolution.
    return send(res, 200, `<!doctype html><p>entering</p><script>
fetch('/__bz/ping',{credentials:'same-origin',cache:'no-store'}).then(function(r){
 if(r.status===204){location.replace('/');}
 else if(parent!==window){parent.postMessage({type:'breeze-tunnel-cookie-blocked'},${JSON.stringify(APP_ORIGIN)});}
});</script>`, { 'set-cookie': auth, 'content-security-policy': csp });
  }
  if (url.pathname === '/__bz/ping') {
    return send(res, /__Host-bzt(-top)?=/.test(cookie) ? 204 : 401, '');
  }
  if (url.pathname === '/') {
    return send(res, 200, `<!doctype html><form id="f" method="post" action="/login"><input name="u" value="x"></form>
${report('root', framed, { label, serverSawAuth: /__Host-bzt(-top)?=/.test(cookie) })}`,
      { 'content-security-policy': csp, 'set-cookie': `dev=${label}; ${cookieAttrs(framed)}` });
  }
  if (url.pathname === '/login' && req.method === 'POST') {
    res.writeHead(303, { location: '/home', 'set-cookie': `devsess=${label}; ${cookieAttrs(framed)}`, 'content-security-policy': csp });
    return res.end();
  }
  if (url.pathname === '/home') {
    return send(res, 200, `<!doctype html>${report('home', framed, { label, serverSawSession: /devsess=/.test(cookie) })}`,
      { 'content-security-policy': csp });
  }
  if (url.pathname === '/toss') {
    // From t2: try to plant a cookie on the shared parent (pre-PSL cookie tossing).
    return send(res, 200, `<!doctype html><script>
document.cookie='toss=${label}; Domain=${SUFFIX}; Path=/; Secure; SameSite=None; Partitioned';
fetch('https://t1.${SUFFIX}:${PORT}/probe',{method:'POST',mode:'no-cors',credentials:'include',body:'x'});
var i=new Image(); i.src='https://t1.${SUFFIX}:${PORT}/reboot';
</script>`, { 'content-security-policy': csp });
  }
  return send(res, 200, `ok ${req.method} ${url.pathname} cookie=${cookie}`, { 'content-type': 'text/plain' });
}).listen(PORT, () => console.log(`chips harness on https://${APP_HOST}:${PORT}/`));
```

- [ ] **Step 2: Write the measuring spec.** It records results; it does not gate anything:

```ts
// e2e-tests/browser-contracts/tunnel-origin/chips.spike.spec.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';

const PORT = Number(process.env.HARNESS_PORT ?? 8443);
const APP = `https://app.localtest.me:${PORT}`;
const SUFFIX = '127.0.0.1.sslip.io';
const out: Record<string, unknown> = {};

async function serverLog(request: import('@playwright/test').APIRequestContext) {
  return (await (await request.get(`${APP}/__log`)).json()) as Array<Record<string, string | null>>;
}

test.afterAll(async ({ browserName }) => {
  const dir = path.join(__dirname, 'results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${browserName}.json`), JSON.stringify(out, null, 2));
});

for (const variant of ['bootstrap', '302'] as const) {
  test(`iframe flow (${variant})`, async ({ page, request }) => {
    await request.get(`${APP}/__reset`);
    await page.goto(`${APP}/?t=t1&variant=${variant}`);
    await page.waitForTimeout(3000);
    const results = await page.evaluate(() => (window as unknown as { results: unknown[] }).results);
    const log = (await serverLog(request)).filter((e) => e.host === `t1.${SUFFIX}`);
    out[`iframe_${variant}`] = { results, log };
  });
}

test('new tab flow (about:blank → opener=null → replace)', async ({ page, context, request }) => {
  await request.get(`${APP}/__reset`);
  await page.goto(`${APP}/?t=t1`);
  const popup = context.waitForEvent('page');
  await page.evaluate((u) => { const w = window.open('about:blank', '_blank'); if (w) { w.opener = null; w.location.replace(u); } },
    `https://t1.${SUFFIX}:${PORT}/__bz/enter?mode=tab`);
  const tab = await popup;
  await tab.waitForTimeout(3000);
  out.tab = { title: await tab.title(), log: (await serverLog(request)).filter((e) => e.host === `t1.${SUFFIX}`) };
});

test('sibling tunnel: cookie tossing + cross-tunnel requests', async ({ page, request }) => {
  await page.goto(`${APP}/?t=t1`);
  await page.waitForTimeout(2000);
  await request.get(`${APP}/__reset`);
  await page.evaluate((s) => {
    const f = document.createElement('iframe'); f.src = s; document.body.appendChild(f);
  }, `https://t2.${SUFFIX}:${PORT}/toss`);
  await page.waitForTimeout(2000);
  await page.goto(`${APP}/?t=t1`);
  await page.waitForTimeout(2000);
  out.sibling = (await serverLog(request)).filter((e) => e.host === `t1.${SUFFIX}`);
});
```

- [ ] **Step 3: Write the spike config**:

```ts
// e2e-tests/playwright.tunnel-origin-spike.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './browser-contracts/tunnel-origin',
  testMatch: /chips\.spike\.spec\.ts/,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: { ignoreHTTPSErrors: true },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'chrome-3pc-blocked', use: { ...devices['Desktop Chrome'], launchOptions: { args: ['--test-third-party-cookie-phaseout'] } } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'node browser-contracts/tunnel-origin/chips-harness-server.mjs',
    url: 'https://app.localtest.me:8443/__log',
    ignoreHTTPSErrors: true,
    reuseExistingServer: true,
  },
});
```

- [ ] **Step 4: Install the browsers and run**:
  ```bash
  node node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/cli.js install chromium firefox webkit
  cd e2e-tests && npx playwright test -c playwright.tunnel-origin-spike.config.ts
  ```
  Expected: every test passes (they only record), and `e2e-tests/browser-contracts/tunnel-origin/results/{chromium,firefox,webkit}.json` exist. The `chrome-3pc-blocked` project writes to `chromium.json` too, so run it alone afterwards with `--project chrome-3pc-blocked` and rename the file to `chromium-3pc-blocked.json`.
- [ ] **Step 5: Manual run in real browsers, current and one older version.** Run the server with trusted certs (`brew install mkcert && mkcert -install && mkcert app.localtest.me '*.127.0.0.1.sslip.io'`, then `HARNESS_CERT=… HARNESS_KEY=… node e2e-tests/browser-contracts/tunnel-origin/chips-harness-server.mjs`). Open `https://app.localtest.me:8443/?t=t1` in Chrome stable (default settings, and with "Block third-party cookies"), Firefox stable and ESR, and Safari 26.x and one older Safari. For each, read `https://app.localtest.me:8443/__log` and the iframe's document title.
- [ ] **Step 6: Record, per browser, in the results table** (Task 0.4):
  - (a) whether `/__bz/ping` saw the auth cookie;
  - (b) `Sec-Fetch-Site` on `/` for the **302 variant** vs the **bootstrap variant**, which confirms or refutes G1;
  - (c) `localStorage` ok;
  - (d) whether device `Set-Cookie` with `Partitioned` came back on `/home` after the form POST (the login-loop class);
  - (e) whether `document.cookie` writes worked;
  - (f) whether the tab flow's `/` and `/home` saw `__Host-bzt-top` and `devsess`;
  - (g) on the sibling test, the `Sec-Fetch-Site` of t2→t1 requests (expected `same-site` pre-PSL), whether t1's `__Host-bzt` was attached (expected **yes**, the same top-level partition, which is why §4a exists), and whether `toss=` reached t1 (expected yes pre-PSL).
- [ ] **Step 7: Commit the harness and results** (W00 PR):
  ```bash
  git add e2e-tests/browser-contracts/tunnel-origin e2e-tests/playwright.tunnel-origin-spike.config.ts
  git commit -m "test(network-proxy): W00 CHIPS/admission browser harness + results"
  ```

### Task 0.4: Append results to the spec

**Files:**
- Modify: `docs/superpowers/specs/monitoring/2026-10-06-network-proxy-tunnel-origin-design.md`

- [ ] **Step 1: Append this section, with every cell filled** (no blank cells; write "n/a — reason" where something does not apply):

```markdown
## W00 spike results (YYYY-MM-DD)

### Decisions
| Open question | Answer | Evidence |
|---|---|---|
| 1. Edge TLS | ACM on `<tunnel-domain>` (decided 2026-10-07); origin hop = <cloudflared http://caddy:80 \| Origin CA at Caddy:443> | Task 0.1 Step 5–6 |
| 2. Domain | `<tunnel-domain>` | Task 0.1 Step 1 |
| 3. PSL timing | opt-in until verified PSL inclusion (decided 2026-10-07) | — |

### Hosted ingress (Task 0.1)
| Probe | Result |
|---|---|
| `https://<uuid>.us.<tunnel-domain>/` cert SAN + status | |
| `https://a.b.us.<tunnel-domain>/` | |
| `https://us.<tunnel-domain>/` | |
| `cf-cache-status` (two requests) | |
| API port published? (compose + `ss`) | |

### Caddy routing (Task 0.2)
| Host / header | Upstream body |
|---|---|
| tunnel `/` | |
| tunnel `/api/v1/auth/me` | |
| tunnel `/portal/login` | |
| tunnel + forged assertion | |
| `a.b.<suffix>` | |
| bare suffix | |
| app `/api/v1/health` + forged assertion | |
| app `/` + forged assertion | |
| `TUNNEL_SITE_ADDRESS` unset / empty | |

### Browsers (Task 0.3)
| Browser + version | ping saw cookie | SFS on `/` (302) | SFS on `/` (bootstrap) | localStorage | device cookie after form POST | document.cookie | tab: auth + session | sibling SFS / auth attached / toss reached |
|---|---|---|---|---|---|---|---|---|
| Chromium (Playwright) | | | | | | | | |
| Chrome stable (default) | | | | | | | | |
| Chrome stable (3PC blocked) | | | | | | | | |
| Chrome stable−1 | | | | | | | | |
| Firefox stable | | | | | | | | |
| Firefox ESR | | | | | | | | |
| WebKit (Playwright) | | | | | | | | |
| Safari 26.x | | | | | | | | |
| Safari 25/18.x | | | | | | | | |

### Plan-level spec amendments (from the implementation plan G1–G10)
<paste the "Spec gaps and contradictions" list from the plan, marking each Confirmed / Refuted by the results above>
```

- [ ] **Step 2: If G1 is refuted** (the 302 variant shows `same-origin` on `/` in every browser), leave Task 8 unchanged. The bootstrap page is still required for cookie-blocked detection. **If CHIPS fails in a browser the spec lists as supported**, record it and confirm that W03 Task 13's notice covers it.
- [ ] **Step 3: Commit**:
  ```bash
  git add docs/superpowers/specs/monitoring/2026-10-06-network-proxy-tunnel-origin-design.md
  git commit -m "docs(spec): network proxy tunnel origin — W00 spike results"
  ```

---

# W01 — API foundation (PR 1 of 2)

### Task 1: Tunnel origin config, validator and env plumbing

**Files:**
- Create: `apps/api/src/config/tunnelOrigin.ts`
- Create: `apps/api/src/config/tunnelOrigin.test.ts`
- Modify: `apps/api/src/config/validate.ts` (schema keys near `PUBLIC_API_URL` ~line 566; superRefine after the PUBLIC_API_URL block ~line 1290)
- Modify: `apps/api/src/config/validate.test.ts`
- Modify: `apps/api/src/system/connections/registry.ts` (server entry ~line 57), `apps/api/src/system/connections/registry.test.ts` (`REVIEWED_PUBLIC_VARS`)
- Modify: `.env.example`, `docker-compose.yml` (`x-api-env`), `deploy/docker-compose.prod.yml` (api env)

**Interfaces:**
- Produces:
  ```ts
  export type TunnelCookieContext = 'frame' | 'tab';
  export interface TunnelOriginConfig { scheme: 'https' | 'http'; suffix: string; port: string; frameAncestor: string }
  export interface TunnelOriginEnv { NODE_ENV?: string; TUNNEL_ORIGIN_TEMPLATE?: string; TUNNEL_FRAME_ANCESTOR?: string;
    PUBLIC_APP_URL?: string; DASHBOARD_URL?: string; PUBLIC_API_URL?: string; CORS_ALLOWED_ORIGINS?: string }
  export interface TunnelOriginIssue { path: 'TUNNEL_ORIGIN_TEMPLATE' | 'TUNNEL_FRAME_ANCESTOR'; message: string }
  export function parseTunnelOriginConfig(env: TunnelOriginEnv):
    { ok: true; config: TunnelOriginConfig | null } | { ok: false; issues: TunnelOriginIssue[] };
  export function getTunnelOriginConfig(): TunnelOriginConfig | null;
  export function __resetTunnelOriginConfigForTests(): void;
  export function buildTunnelOrigin(config: TunnelOriginConfig, tunnelId: string): string;
  export function buildTunnelEnterUrl(config: TunnelOriginConfig, tunnelId: string, ticket: string, context?: TunnelCookieContext): string;
  export function buildPathModeTicketUrl(tunnelId: string, ticket: string): string;
  export function isTunnelDomainHost(hostHeader: string | undefined, config: TunnelOriginConfig): boolean;
  export function matchTunnelHost(hostHeader: string | undefined, config: TunnelOriginConfig): string | null;
  ```

- [ ] **Step 1: Write the failing tests**:

```ts
// apps/api/src/config/tunnelOrigin.test.ts
import { describe, expect, it } from 'vitest';
import {
  buildPathModeTicketUrl,
  buildTunnelEnterUrl,
  buildTunnelOrigin,
  isTunnelDomainHost,
  matchTunnelHost,
  parseTunnelOriginConfig,
  type TunnelOriginEnv,
} from './tunnelOrigin';

const ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const TEMPLATE = 'https://{id}.us.breezetunnel.test';
const PROD: TunnelOriginEnv = {
  NODE_ENV: 'production',
  PUBLIC_APP_URL: 'https://us.breeze-app.test',
  PUBLIC_API_URL: 'https://us.breeze-app.test',
  CORS_ALLOWED_ORIGINS: 'https://us.breeze-app.test',
};

function config(env: TunnelOriginEnv) {
  const parsed = parseTunnelOriginConfig(env);
  if (!parsed.ok) throw new Error(parsed.issues.map((i) => i.message).join('\n'));
  return parsed.config;
}
function issueText(env: TunnelOriginEnv): string {
  const parsed = parseTunnelOriginConfig(env);
  return parsed.ok ? '' : parsed.issues.map((i) => `${i.path}: ${i.message}`).join('\n');
}

describe('parseTunnelOriginConfig', () => {
  it('is off when the template is unset or blank', () => {
    expect(config(PROD)).toBeNull();
    expect(config({ ...PROD, TUNNEL_ORIGIN_TEMPLATE: '   ' })).toBeNull();
  });

  it('parses the template and defaults the frame ancestor to the PUBLIC_APP_URL origin', () => {
    expect(config({ ...PROD, TUNNEL_ORIGIN_TEMPLATE: TEMPLATE })).toEqual({
      scheme: 'https', suffix: 'us.breezetunnel.test', port: '', frameAncestor: 'https://us.breeze-app.test',
    });
  });

  it.each([
    ['plain http in production', 'http://{id}.us.breezetunnel.test'],
    ['userinfo', 'https://u@{id}.us.breezetunnel.test'],
    ['a path', 'https://{id}.us.breezetunnel.test/x'],
    ['a query', 'https://{id}.us.breezetunnel.test?x=1'],
    ['a fragment', 'https://{id}.us.breezetunnel.test#x'],
    ['a port in production', 'https://{id}.us.breezetunnel.test:8443'],
    ['{id} not the whole leftmost label', 'https://tun-{id}.us.breezetunnel.test'],
    ['two {id}s', 'https://{id}.{id}.breezetunnel.test'],
    ['no {id}', 'https://x.us.breezetunnel.test'],
    ['a single-label suffix', 'https://{id}.test'],
    ['uppercase', 'https://{id}.US.breezetunnel.test'],
    ['an invalid label', 'https://{id}.-us.breezetunnel.test'],
    ['a trailing slash', 'https://{id}.us.breezetunnel.test/'],
  ])('rejects %s', (_label, template) => {
    expect(issueText({ ...PROD, TUNNEL_ORIGIN_TEMPLATE: template })).toMatch(/TUNNEL_ORIGIN_TEMPLATE/);
  });

  it('rejects a suffix that shares the app registrable domain', () => {
    expect(issueText({ ...PROD, TUNNEL_ORIGIN_TEMPLATE: 'https://{id}.tunnel.breeze-app.test' }))
      .toMatch(/registrable domain/);
  });

  it('rejects a suffix that shares a CORS origin registrable domain', () => {
    expect(issueText({
      ...PROD, CORS_ALLOWED_ORIGINS: 'https://us.breeze-app.test,https://portal.other-brand.test',
      TUNNEL_ORIGIN_TEMPLATE: 'https://{id}.t.other-brand.test',
    })).toMatch(/registrable domain/);
  });

  it('rejects when a private PSL suffix would mask a shared public parent', () => {
    expect(issueText({
      ...PROD, PUBLIC_APP_URL: 'https://acme.github.io', PUBLIC_API_URL: 'https://acme.github.io',
      CORS_ALLOWED_ORIGINS: 'https://acme.github.io', TUNNEL_ORIGIN_TEMPLATE: 'https://{id}.tunnels.github.io',
    })).toMatch(/registrable domain/);
  });

  it('requires TUNNEL_FRAME_ANCESTOR to be an exact https origin', () => {
    expect(issueText({ ...PROD, TUNNEL_ORIGIN_TEMPLATE: TEMPLATE, TUNNEL_FRAME_ANCESTOR: 'https://us.breeze-app.test/' }))
      .toMatch(/TUNNEL_FRAME_ANCESTOR/);
    expect(issueText({ ...PROD, TUNNEL_ORIGIN_TEMPLATE: TEMPLATE, TUNNEL_FRAME_ANCESTOR: 'http://us.breeze-app.test' }))
      .toMatch(/TUNNEL_FRAME_ANCESTOR/);
  });

  it('fails closed when no frame ancestor can be derived', () => {
    expect(issueText({ NODE_ENV: 'production', TUNNEL_ORIGIN_TEMPLATE: TEMPLATE }))
      .toMatch(/TUNNEL_FRAME_ANCESTOR/);
  });

  it('allows http and a port only for *.localhost outside production', () => {
    const dev: TunnelOriginEnv = {
      NODE_ENV: 'development', PUBLIC_APP_URL: 'http://localhost:18480',
      TUNNEL_ORIGIN_TEMPLATE: 'http://{id}.tunnel.localhost:18480', TUNNEL_FRAME_ANCESTOR: 'http://localhost:18480',
    };
    expect(config(dev)).toEqual({ scheme: 'http', suffix: 'tunnel.localhost', port: '18480', frameAncestor: 'http://localhost:18480' });
    expect(issueText({ ...dev, NODE_ENV: 'production' })).toMatch(/TUNNEL_ORIGIN_TEMPLATE/);
  });
});

describe('tunnel URL builders and Host matching', () => {
  const cfg = config({ ...PROD, TUNNEL_ORIGIN_TEMPLATE: TEMPLATE })!;

  it('builds the origin, enter URL and path-mode URL', () => {
    expect(buildTunnelOrigin(cfg, ID)).toBe(`https://${ID}.us.breezetunnel.test`);
    expect(buildTunnelEnterUrl(cfg, ID, 'a b/c')).toBe(`https://${ID}.us.breezetunnel.test/__bz/enter?t=a+b%2Fc`);
    expect(buildTunnelEnterUrl(cfg, ID, 'T', 'tab')).toBe(`https://${ID}.us.breezetunnel.test/__bz/enter?t=T&mode=tab`);
    expect(buildPathModeTicketUrl(ID, 'a/b')).toBe(`/api/v1/tunnel-http/${ID}/?__bzt=a%2Fb`);
  });

  it.each([
    [`${ID}.us.breezetunnel.test`, ID],
    [`${ID.toUpperCase()}.US.BREEZETUNNEL.TEST`, ID],
    [`${ID}.us.breezetunnel.test.`, ID],
    [`${ID}.us.breezetunnel.test:443`, ID],
    [`${ID}.us.breezetunnel.test:8443`, null],
    [`not-a-uuid.us.breezetunnel.test`, null],
    [`a.${ID}.us.breezetunnel.test`, null],
    ['us.breezetunnel.test', null],
    ['us.breeze-app.test', null],
    [undefined, null],
  ])('matchTunnelHost(%s) → %s', (host, expected) => {
    expect(matchTunnelHost(host, cfg)).toBe(expected);
  });

  it.each([
    [`${ID}.us.breezetunnel.test`, true],
    ['a.b.us.breezetunnel.test', true],
    ['us.breezetunnel.test', true],
    ['US.BREEZETUNNEL.TEST.', true],
    [`${ID}.us.breezetunnel.test:8443`, true],
    ['evil-us.breezetunnel.test', false],
    ['us.breeze-app.test', false],
    [undefined, false],
  ])('isTunnelDomainHost(%s) → %s', (host, expected) => {
    expect(isTunnelDomainHost(host, cfg)).toBe(expected);
  });
});
```

Append to `apps/api/src/config/validate.test.ts`, inside `describe('validateConfig', …)`:

```ts
  it('refuses boot when TUNNEL_ORIGIN_TEMPLATE shares the app registrable domain', () => {
    withEnv({ ...validEnv, PUBLIC_APP_URL: 'https://us.breeze-app.test', TUNNEL_ORIGIN_TEMPLATE: 'https://{id}.tunnel.breeze-app.test' }, () => {
      expect(() => validateConfig()).toThrow(/TUNNEL_ORIGIN_TEMPLATE/);
    });
  });

  it('boots with a tunnel template on a separate registrable domain', () => {
    withEnv({
      ...validEnv, PUBLIC_APP_URL: 'https://us.breeze-app.test',
      TUNNEL_ORIGIN_TEMPLATE: 'https://{id}.us.breezetunnel.test', TUNNEL_FRAME_ANCESTOR: 'https://us.breeze-app.test',
    }, () => {
      expect(() => validateConfig()).not.toThrow();
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**
  Run: `cd apps/api && npx vitest run src/config/tunnelOrigin.test.ts src/config/validate.test.ts`
  Expected: `tunnelOrigin.test.ts` fails with "Failed to resolve import ./tunnelOrigin". The `refuses boot …` case in `validate.test.ts` fails because no error is thrown.

- [ ] **Step 3: Implement `tunnelOrigin.ts`**:

```ts
// apps/api/src/config/tunnelOrigin.ts
/**
 * Network Proxy host mode (spec 2026-10-06 §2): the tunnel origin template.
 * Pure parsing + a cached runtime getter. config/validate.ts refuses boot on
 * any issue returned here, so the runtime getter's error branch is defensive.
 * The tunnel domain itself is NEVER written in code — only derived from env.
 */
import { getDomain } from 'tldts';
import { UUID_REGEX } from '../utils/uuid';

export type TunnelCookieContext = 'frame' | 'tab';

export interface TunnelOriginConfig {
  scheme: 'https' | 'http';
  /** Lowercase, no leading dot, e.g. `us.breezetunnel.test`. */
  suffix: string;
  /** '' for the scheme default; only ever non-empty for *.localhost dev stacks. */
  port: string;
  /** Exact origin allowed in `frame-ancestors`. */
  frameAncestor: string;
}

export interface TunnelOriginEnv {
  NODE_ENV?: string;
  TUNNEL_ORIGIN_TEMPLATE?: string;
  TUNNEL_FRAME_ANCESTOR?: string;
  PUBLIC_APP_URL?: string;
  DASHBOARD_URL?: string;
  PUBLIC_API_URL?: string;
  CORS_ALLOWED_ORIGINS?: string;
}

export interface TunnelOriginIssue {
  path: 'TUNNEL_ORIGIN_TEMPLATE' | 'TUNNEL_FRAME_ANCESTOR';
  message: string;
}

const TEMPLATE_RE = /^(https?):\/\/\{id\}\.([a-z0-9.-]+?)(?::(\d{1,5}))?$/;
const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const TEMPLATE_SHAPE =
  'must be exactly https://{id}.<suffix> — lowercase, {id} as the whole leftmost label, no userinfo, path, query, fragment or port';

function isLocalhostName(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost');
}

function safeUrl(raw: string | undefined): URL | null {
  if (!raw?.trim()) return null;
  try {
    return new URL(raw.trim());
  } catch {
    return null;
  }
}

/** Every origin that authenticates Breeze users or serves the app. */
function appOrigins(env: TunnelOriginEnv, frameAncestor: string | null): URL[] {
  const raws = [
    env.PUBLIC_APP_URL, env.DASHBOARD_URL, env.PUBLIC_API_URL, frameAncestor ?? undefined,
    ...(env.CORS_ALLOWED_ORIGINS ?? '').split(','),
  ];
  return raws.map((r) => (r && r.trim() !== '*' ? safeUrl(r) : null)).filter((u): u is URL => u !== null);
}

function registrableDomains(host: string): Set<string> {
  const out = new Set<string>();
  for (const allowPrivateDomains of [true, false]) {
    const d = getDomain(host, { allowPrivateDomains });
    if (d) out.add(d);
  }
  return out;
}

export function parseTunnelOriginConfig(
  env: TunnelOriginEnv,
): { ok: true; config: TunnelOriginConfig | null } | { ok: false; issues: TunnelOriginIssue[] } {
  const raw = env.TUNNEL_ORIGIN_TEMPLATE?.trim();
  if (!raw) return { ok: true, config: null };
  const production = env.NODE_ENV === 'production';
  const issues: TunnelOriginIssue[] = [];

  const match = TEMPLATE_RE.exec(raw);
  if (!match || raw.split('{id}').length !== 2) {
    return { ok: false, issues: [{ path: 'TUNNEL_ORIGIN_TEMPLATE', message: TEMPLATE_SHAPE }] };
  }
  const scheme = match[1] as 'https' | 'http';
  const suffix = match[2]!;
  const port = match[3] ?? '';
  const labels = suffix.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) {
    issues.push({ path: 'TUNNEL_ORIGIN_TEMPLATE', message: `${TEMPLATE_SHAPE} (invalid suffix "${suffix}")` });
  }
  const devLocal = !production && isLocalhostName(suffix);
  if (scheme !== 'https' && !devLocal) {
    issues.push({ path: 'TUNNEL_ORIGIN_TEMPLATE', message: 'must use https:// (http is accepted only for *.localhost outside production)' });
  }
  if (port && !devLocal) {
    issues.push({ path: 'TUNNEL_ORIGIN_TEMPLATE', message: 'must not contain a port (accepted only for *.localhost outside production)' });
  }

  // Frame ancestor: explicit, else the public app origin; missing config fails closed.
  const ancestorRaw = env.TUNNEL_FRAME_ANCESTOR?.trim()
    || safeUrl(env.PUBLIC_APP_URL)?.origin
    || safeUrl(env.DASHBOARD_URL)?.origin
    || '';
  let frameAncestor: string | null = null;
  if (!ancestorRaw) {
    issues.push({ path: 'TUNNEL_FRAME_ANCESTOR', message: 'is required when TUNNEL_ORIGIN_TEMPLATE is set (no PUBLIC_APP_URL/DASHBOARD_URL to default from)' });
  } else {
    const parsed = safeUrl(ancestorRaw);
    const localAncestor = !production && parsed !== null && isLocalhostName(parsed.hostname) && parsed.protocol === 'http:';
    if (!parsed || parsed.origin !== ancestorRaw || (parsed.protocol !== 'https:' && !localAncestor)) {
      issues.push({ path: 'TUNNEL_FRAME_ANCESTOR', message: `must be an exact https origin such as https://app.example.com (got "${ancestorRaw}")` });
    } else {
      frameAncestor = parsed.origin;
    }
  }

  // Registrable-domain separation from every authenticated app/API origin,
  // compared with allowPrivateDomains in BOTH directions (spec §2).
  const tunnelDomains = registrableDomains(`x.${suffix}`);
  if (tunnelDomains.size === 0 && !devLocal) {
    issues.push({ path: 'TUNNEL_ORIGIN_TEMPLATE', message: `suffix "${suffix}" has no registrable domain` });
  }
  for (const origin of appOrigins(env, frameAncestor)) {
    const host = origin.hostname;
    const shared = [...registrableDomains(host)].some((d) => tunnelDomains.has(d));
    if (shared || host === suffix) {
      issues.push({
        path: 'TUNNEL_ORIGIN_TEMPLATE',
        message: `suffix "${suffix}" shares a registrable domain with app origin ${origin.origin}; tunnel content must live on a separate registrable domain`,
      });
    }
  }

  if (issues.length > 0 || !frameAncestor) return { ok: false, issues };
  return { ok: true, config: { scheme, suffix, port, frameAncestor } };
}

let cached: { value: TunnelOriginConfig | null } | null = null;

export function getTunnelOriginConfig(): TunnelOriginConfig | null {
  if (cached) return cached.value;
  const parsed = parseTunnelOriginConfig(process.env);
  if (!parsed.ok) {
    console.error('[tunnel-origin] invalid tunnel origin config; host mode disabled:',
      parsed.issues.map((i) => `${i.path} ${i.message}`).join('; '));
    cached = { value: null };
    return null;
  }
  cached = { value: parsed.config };
  return parsed.config;
}

export function __resetTunnelOriginConfigForTests(): void {
  cached = null;
}

export function buildTunnelOrigin(config: TunnelOriginConfig, tunnelId: string): string {
  return `${config.scheme}://${tunnelId.toLowerCase()}.${config.suffix}${config.port ? `:${config.port}` : ''}`;
}

export function buildTunnelEnterUrl(
  config: TunnelOriginConfig,
  tunnelId: string,
  ticket: string,
  context: TunnelCookieContext = 'frame',
): string {
  const url = new URL('/__bz/enter', buildTunnelOrigin(config, tunnelId));
  url.searchParams.set('t', ticket);
  if (context === 'tab') url.searchParams.set('mode', 'tab');
  return url.toString();
}

export function buildPathModeTicketUrl(tunnelId: string, ticket: string): string {
  return `/api/v1/tunnel-http/${tunnelId}/?__bzt=${encodeURIComponent(ticket)}`;
}

function parseHost(hostHeader: string | undefined): { hostname: string; port: string } | null {
  if (!hostHeader) return null;
  try {
    const u = new URL(`http://${hostHeader}`);
    return { hostname: u.hostname.replace(/\.$/, ''), port: u.port };
  } catch {
    return null;
  }
}

/** True for the bare suffix and ANY depth under it — all of it is tunnel surface (G10). Port is ignored. */
export function isTunnelDomainHost(hostHeader: string | undefined, config: TunnelOriginConfig): boolean {
  const host = parseHost(hostHeader);
  if (!host) return false;
  return host.hostname === config.suffix || host.hostname.endsWith(`.${config.suffix}`);
}

/** The tunnel id for `<uuid>.<suffix>[:<configured port>]`, else null. */
export function matchTunnelHost(hostHeader: string | undefined, config: TunnelOriginConfig): string | null {
  const host = parseHost(hostHeader);
  if (!host || !host.hostname.endsWith(`.${config.suffix}`)) return null;
  const portOk = config.port ? host.port === config.port : host.port === '' || host.port === '443';
  if (!portOk) return null;
  const label = host.hostname.slice(0, -(config.suffix.length + 1));
  return UUID_REGEX.test(label) ? label.toLowerCase() : null;
}
```

- [ ] **Step 4: Wire the validator.** In `apps/api/src/config/validate.ts`:
  - Add `import { parseTunnelOriginConfig } from './tunnelOrigin';` with the other imports.
  - In `envObjectSchema`, directly after `PUBLIC_API_URL: z.string().optional(),` add:
    ```ts
    // Network Proxy host mode (spec 2026-10-06 §2). Unset = path mode only.
    // Validated in the superRefine below (shape + registrable-domain separation).
    TUNNEL_ORIGIN_TEMPLATE: z.string().optional(),
    TUNNEL_FRAME_ANCESTOR: z.string().optional(),
    // Read by the tunnel-origin validator to derive the frame ancestor and to
    // compare registrable domains; used unvalidated elsewhere.
    PUBLIC_APP_URL: z.string().optional(),
    DASHBOARD_URL: z.string().optional(),
    ```
  - Inside `.superRefine((data, ctx) => {`, after the `PUBLIC_API_URL` canonical-form block, add:
    ```ts
    // Network Proxy tunnel origin (spec 2026-10-06 §2): refuse boot on a
    // malformed template or one sharing a registrable domain with any app origin,
    // in every NODE_ENV — a same-site tunnel origin is a tenant-isolation bug.
    const tunnelOrigin = parseTunnelOriginConfig(data);
    if (!tunnelOrigin.ok) {
      for (const issue of tunnelOrigin.issues) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [issue.path], message: `${issue.path} ${issue.message}` });
      }
    }
    ```
- [ ] **Step 5: Register and map the env vars.**
  - `apps/api/src/system/connections/registry.ts`, server entry `vars` (after `{ name: 'PUBLIC_API_URL', … }`):
    ```ts
      { name: 'TUNNEL_ORIGIN_TEMPLATE', secret: false },
      { name: 'TUNNEL_FRAME_ANCESTOR', secret: false },
    ```
  - `apps/api/src/system/connections/registry.test.ts` `REVIEWED_PUBLIC_VARS`: insert `'TUNNEL_FRAME_ANCESTOR',` and `'TUNNEL_ORIGIN_TEMPLATE',` in alphabetical position.
  - `docker-compose.yml`, in `x-api-env` directly under `PUBLIC_API_URL: …`:
    ```yaml
      # Network Proxy host mode (optional; unset = path mode). See
      # docs/deploy/network-proxy-tunnel-origin. Never infer from BREEZE_DOMAIN:
      # the tunnel domain must be a different registrable domain.
      TUNNEL_ORIGIN_TEMPLATE: ${TUNNEL_ORIGIN_TEMPLATE:-}
      TUNNEL_FRAME_ANCESTOR: ${TUNNEL_FRAME_ANCESTOR:-}
    ```
  - `deploy/docker-compose.prod.yml`: add the same two lines in the api environment anchor, next to `PUBLIC_APP_URL` (~line 82).
  - `.env.example`: after the `PUBLIC_API_URL=` block (~line 264):
    ```bash
    # Network Proxy dedicated tunnel origin (optional). Unset keeps path mode.
    # Must be a DIFFERENT registrable domain from the app, e.g.
    # TUNNEL_ORIGIN_TEMPLATE=https://{id}.us.tunnel.example.net
    # TUNNEL_FRAME_ANCESTOR defaults to PUBLIC_APP_URL's origin.
    # TUNNEL_ORIGIN_TEMPLATE=
    # TUNNEL_FRAME_ANCESTOR=
    ```
- [ ] **Step 6: Run the tests to verify they pass**
  Run: `cd apps/api && npx vitest run src/config/tunnelOrigin.test.ts src/config/validate.test.ts src/system/connections src/config/envComposeParity.test.ts src/config/envReadComposeCoverage.test.ts`
  Expected: all PASS. If `envReadComposeCoverage` names `TUNNEL_*` for `deploy/docker-compose.prod.yml`, the prod mapping in Step 5 is missing.
- [ ] **Step 7: Typecheck and commit**
  ```bash
  cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"
  git add apps/api/src/config/tunnelOrigin.ts apps/api/src/config/tunnelOrigin.test.ts apps/api/src/config/validate.ts apps/api/src/config/validate.test.ts apps/api/src/system/connections/registry.ts apps/api/src/system/connections/registry.test.ts .env.example docker-compose.yml deploy/docker-compose.prod.yml
  git commit -m "feat(network-proxy): TUNNEL_ORIGIN_TEMPLATE config + fail-closed validator"
  ```

### Task 2: Extract the shared tunnel-http core (path mode unchanged)

**Files:**
- Create: `apps/api/src/routes/tunnelHttpCore.ts`
- Create: `apps/api/src/routes/tunnelHttpCore.test.ts`
- Modify: `apps/api/src/routes/tunnelHttp.ts` (#8110 version: lines 1–24 imports, 53–78 constants and `authorizeTunnelContinuation`, 172–175 `isPastSessionCap`, 177–205 header sets, 217–229 zlib, 241–308 cookie JWT and `loadTunnelRow`, 373–411 `loadOwnedTunnelSession` and `upstreamHeaderValue`, 627–875 gates, dispatch and decode)

**Interfaces:**
- Consumes: `TunnelCookieContext` (Task 1).
- Produces (all exported from `tunnelHttpCore.ts`):
  ```ts
  export const HTTP_REQUEST_TIMEOUT_MS = 25_000;
  export const HTTP_TUNNEL_COOKIE_TTL_SECONDS = 300;
  export const HTTP_TUNNEL_COOKIE_CLOCK_TOLERANCE_SECONDS = 0;
  export const HTTP_TUNNEL_MAX_SESSION_HOURS = 12;
  export const PATH_COOKIE_AUDIENCE = 'breeze-tunnel-http';
  export const HOST_COOKIE_AUDIENCE = 'breeze-tunnel-host';
  export const CONNECTABLE_TUNNEL_STATUSES: readonly ['pending', 'connecting', 'active'];
  export const HOP_BY_HOP: Set<string>;
  export interface UsableTunnel { agentId: string | null; deviceId: string; deviceStatus: string; deviceSiteId: string | null;
    targetHost: string; targetPort: number; scheme: string | null; skipTlsVerify: boolean; orgId: string; type: string;
    createdAt: Date; startedAt: Date | null; lastActivityAt: Date | null }
  export type ReachableTunnel = UsableTunnel & { agentId: string };
  export function authorizeTunnelContinuation(tunnelId: string, userId: string): ReturnType<typeof authorizeRemoteSessionContinuation>;
  export function loadTunnelRow(tunnelId: string): Promise<{ session: typeof tunnelSessions.$inferSelect; device: typeof devices.$inferSelect } | null>;
  export function loadOwnedTunnelSession(tunnelId: string, userId: string): Promise<UsableTunnel | null>;
  export function isPastSessionCap(createdAt: Date): boolean;
  export function signTunnelCookie(userId: string, tunnelId: string, opts?: { audience?: string; context?: TunnelCookieContext }): Promise<string>;
  export function verifyTunnelCookie(token: string | undefined, tunnelId: string, opts?: { audience?: string; context?: TunnelCookieContext }): Promise<string | null>;
  export type TunnelGateResult = { ok: true; session: ReachableTunnel } | { ok: false; status: ContentfulStatusCode; message: string; reason: 'live_authority' | 'not_found' | 'session_expired' | 'agent_offline' | 'policy' };
  export function runTunnelRequestGates(tunnelId: string, userId: string): Promise<TunnelGateResult>;
  export function bumpTunnelActivity(tunnelId: string, lastActivityAt: Date | null): Promise<void>;
  export function collectForwardableHeaders(reqHeaders: Record<string, string>): Record<string, string[]>;
  export function tunnelScheme(session: Pick<UsableTunnel, 'scheme' | 'targetPort'>): 'http' | 'https';
  export function deviceTargetOrigin(session: Pick<UsableTunnel, 'scheme' | 'targetPort' | 'targetHost'>): string;
  export interface UpstreamHttpResponse { status: number; headers: Record<string, string[]>; bodyB64: string; truncated?: boolean }
  export type TunnelDispatchOutcome = { ok: true; upstream: UpstreamHttpResponse } | { ok: false; status: 502 | 504; message: string; reason: 'timeout' | 'tls_cert_untrusted' | 'agent_error' | 'malformed_response' };
  export function dispatchTunnelHttpRequest(tunnelId: string, session: ReachableTunnel, request: { method: string; path: string; headers: Record<string, string[]>; bodyB64: string }): Promise<TunnelDispatchOutcome>;
  export function decodeUpstreamBody(body: Buffer, contentEncoding: string | null): Promise<{ ok: true; body: Buffer; decoded: boolean } | { ok: false }>;
  export function upstreamHeaderValue(headers: Record<string, string[]> | undefined, name: string): string | null;
  ```

- [ ] **Step 1: Write the failing core tests** (behaviour that path mode depends on, now pinned at the core boundary):

```ts
// apps/api/src/routes/tunnelHttpCore.test.ts
import { describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';

vi.mock('../db', () => ({ db: {}, withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()) }));
vi.mock('../db/schema', () => ({ tunnelSessions: {}, devices: {} }));
vi.mock('./agentWs', () => ({ isAgentConnected: vi.fn(() => true) }));
vi.mock('../services/agentCommandAwait', () => ({ sendCommandToAgentAwaitResult: vi.fn() }));
vi.mock('../services/remoteAccessPolicy', () => ({ checkRemoteAccess: vi.fn() }));
vi.mock('../services/remoteWsAuthorization', () => ({ authorizeRemoteSessionContinuation: vi.fn() }));
vi.mock('../services/tunnelAllowlist', () => ({ getActiveAllowlistPatterns: vi.fn() }));

import {
  HOST_COOKIE_AUDIENCE,
  collectForwardableHeaders,
  decodeUpstreamBody,
  deviceTargetOrigin,
  signTunnelCookie,
  verifyTunnelCookie,
} from './tunnelHttpCore';

const TUNNEL_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER_TUNNEL = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const USER_ID = 'uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu';

describe('tunnelHttpCore', () => {
  it('decodes gzip, passes unknown encodings through untouched, and fails a bomb closed', async () => {
    const gz = await decodeUpstreamBody(gzipSync(Buffer.from('<p>hi</p>')), 'gzip');
    expect(gz).toEqual({ ok: true, body: Buffer.from('<p>hi</p>'), decoded: true });

    const raw = Buffer.from('opaque');
    expect(await decodeUpstreamBody(raw, 'gzip, zstd')).toEqual({ ok: true, body: raw, decoded: false });

    const bomb = gzipSync(Buffer.alloc(40 * 1024 * 1024));
    expect(await decodeUpstreamBody(bomb, 'gzip')).toEqual({ ok: false });
  });

  it('brackets IPv6 device hosts and keeps the explicit port', () => {
    expect(deviceTargetOrigin({ scheme: null, targetPort: 443, targetHost: 'fe80::1' })).toBe('https://[fe80::1]:443');
    expect(deviceTargetOrigin({ scheme: 'http', targetPort: 8080, targetHost: '192.168.1.5' })).toBe('http://192.168.1.5:8080');
  });

  it('never forwards Breeze credentials to the device', () => {
    expect(collectForwardableHeaders({ accept: 'text/html', cookie: 'a=b', authorization: 'Bearer x', 'x-api-key': 'k' }))
      .toEqual({ accept: ['text/html'] });
  });

  it('binds cookies to tunnel, audience and context', async () => {
    const pathCookie = await signTunnelCookie(USER_ID, TUNNEL_ID);
    expect(await verifyTunnelCookie(pathCookie, TUNNEL_ID)).toBe(USER_ID);
    expect(await verifyTunnelCookie(pathCookie, OTHER_TUNNEL)).toBeNull();
    // A path-mode cookie can never authenticate host mode, and vice versa.
    expect(await verifyTunnelCookie(pathCookie, TUNNEL_ID, { audience: HOST_COOKIE_AUDIENCE, context: 'frame' })).toBeNull();

    const frame = await signTunnelCookie(USER_ID, TUNNEL_ID, { audience: HOST_COOKIE_AUDIENCE, context: 'frame' });
    expect(await verifyTunnelCookie(frame, TUNNEL_ID, { audience: HOST_COOKIE_AUDIENCE, context: 'frame' })).toBe(USER_ID);
    expect(await verifyTunnelCookie(frame, TUNNEL_ID, { audience: HOST_COOKIE_AUDIENCE, context: 'tab' })).toBeNull();
    expect(await verifyTunnelCookie(frame, TUNNEL_ID)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**
  Run: `cd apps/api && npx vitest run src/routes/tunnelHttpCore.test.ts`
  Expected: FAIL, "Failed to resolve import ./tunnelHttpCore".

- [ ] **Step 3: Create `tunnelHttpCore.ts` by moving code out of `tunnelHttp.ts`** (same bodies, same comments, with only the changes shown):

```ts
// apps/api/src/routes/tunnelHttpCore.ts
/**
 * Shared core for both Network Proxy modes (spec 2026-10-06 §3): path mode
 * (routes/tunnelHttp.ts) and host mode (routes/tunnelHost.ts). Every gate here
 * runs identically in both — only authentication, rewriting and response
 * headers differ by mode.
 */
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'crypto';
import { brotliDecompress, gunzip, inflate } from 'node:zlib';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { tunnelSessions, devices } from '../db/schema';
import { sendCommandToAgentAwaitResult } from '../services/agentCommandAwait';
import { getActiveAllowlistPatterns } from '../services/tunnelAllowlist';
import { isAgentConnected } from './agentWs';
import { checkRemoteAccess } from '../services/remoteAccessPolicy';
import { getSignKey, getVerifyKey, buildHeader } from '../services/jwt';
import { authorizeRemoteSessionContinuation } from '../services/remoteWsAuthorization';
import { PERMISSIONS } from '../services/permissions';
import type { TunnelCookieContext } from '../config/tunnelOrigin';

export const HTTP_REQUEST_TIMEOUT_MS = 25_000;
export const HTTP_TUNNEL_COOKIE_TTL_SECONDS = 300;
export const HTTP_TUNNEL_COOKIE_CLOCK_TOLERANCE_SECONDS = 0;
export const HTTP_TUNNEL_MAX_SESSION_HOURS = 12;
const HTTP_TUNNEL_MAX_SESSION_MS = HTTP_TUNNEL_MAX_SESSION_HOURS * 60 * 60 * 1000;
const ACTIVITY_BUMP_THROTTLE_MS = 30_000;
export const PATH_COOKIE_AUDIENCE = 'breeze-tunnel-http';
export const HOST_COOKIE_AUDIENCE = 'breeze-tunnel-host';
export const CONNECTABLE_TUNNEL_STATUSES = ['pending', 'connecting', 'active'] as const;
const TUNNEL_CONTINUATION_PERMISSIONS = [PERMISSIONS.REMOTE_ACCESS, PERMISSIONS.DEVICES_EXECUTE];
const TUNNEL_DECOMPRESSED_BODY_MAX_BYTES = 32 * 1024 * 1024;
const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);
const brotliDecompressAsync = promisify(brotliDecompress);

export function authorizeTunnelContinuation(tunnelId: string, userId: string) {
  return authorizeRemoteSessionContinuation(
    { sessionId: tunnelId, sessionType: 'tunnel', userId },
    TUNNEL_CONTINUATION_PERMISSIONS,
  );
}

export function isPastSessionCap(createdAt: Date): boolean {
  return Date.now() - createdAt.getTime() > HTTP_TUNNEL_MAX_SESSION_MS;
}

// (moved verbatim from tunnelHttp.ts #8110 lines 177–205, with their comments)
export const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
]);
const FORWARDABLE_REQUEST_HEADERS = new Set([
  'accept', 'accept-language', 'user-agent', 'content-type', 'content-length', 'range',
  'if-modified-since', 'if-none-match', 'cache-control',
]);

export function collectForwardableHeaders(reqHeaders: Record<string, string>): Record<string, string[]> {
  const headers: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(reqHeaders)) {
    if (FORWARDABLE_REQUEST_HEADERS.has(k.toLowerCase())) headers[k] = [v];
  }
  return headers;
}

export async function signTunnelCookie(
  userId: string,
  tunnelId: string,
  opts: { audience?: string; context?: TunnelCookieContext } = {},
): Promise<string> {
  const { key, kid } = getSignKey();
  const claims: Record<string, string> = { tunnelId };
  if (opts.context) claims.ctx = opts.context;
  return new SignJWT(claims)
    .setProtectedHeader(buildHeader(kid))
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${HTTP_TUNNEL_COOKIE_TTL_SECONDS}s`)
    .setIssuer('breeze')
    .setAudience(opts.audience ?? PATH_COOKIE_AUDIENCE)
    .sign(key);
}

export async function verifyTunnelCookie(
  token: string | undefined,
  tunnelId: string,
  opts: { audience?: string; context?: TunnelCookieContext } = {},
): Promise<string | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getVerifyKey, {
      issuer: 'breeze',
      audience: opts.audience ?? PATH_COOKIE_AUDIENCE,
      algorithms: ['HS256'],
      clockTolerance: HTTP_TUNNEL_COOKIE_CLOCK_TOLERANCE_SECONDS,
    });
    if (payload.tunnelId !== tunnelId) return null;
    if ((payload.ctx ?? undefined) !== opts.context) return null;
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

export interface UsableTunnel {
  agentId: string | null;
  deviceId: string;
  deviceStatus: string;
  deviceSiteId: string | null;
  targetHost: string;
  targetPort: number;
  scheme: string | null;
  skipTlsVerify: boolean;
  orgId: string;
  type: string;
  createdAt: Date;
  startedAt: Date | null;
  lastActivityAt: Date | null;
}
export type ReachableTunnel = UsableTunnel & { agentId: string };

// (loadTunnelRow + loadOwnedTunnelSession moved verbatim from #8110 lines 296–308 and 373–400, now exported)
export async function loadTunnelRow(tunnelId: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({ session: tunnelSessions, device: devices })
      .from(tunnelSessions)
      .innerJoin(devices, eq(tunnelSessions.deviceId, devices.id))
      .where(eq(tunnelSessions.id, tunnelId))
      .limit(1);
    return row ?? null;
  });
}

export async function loadOwnedTunnelSession(tunnelId: string, userId: string): Promise<UsableTunnel | null> {
  const row = await loadTunnelRow(tunnelId);
  if (!row) return null;
  const { session, device } = row;
  if (session.userId !== userId) return null;
  if (!(CONNECTABLE_TUNNEL_STATUSES as readonly string[]).includes(session.status)) return null;
  return {
    agentId: device.agentId ?? null,
    deviceId: device.id,
    deviceStatus: device.status,
    deviceSiteId: device.siteId ?? null,
    targetHost: session.targetHost,
    targetPort: session.targetPort,
    scheme: session.scheme ?? null,
    skipTlsVerify: session.skipTlsVerify ?? false,
    orgId: session.orgId,
    type: session.type,
    createdAt: session.createdAt,
    startedAt: session.startedAt ?? null,
    lastActivityAt: session.lastActivityAt ?? null,
  };
}

export type TunnelGateResult =
  | { ok: true; session: ReachableTunnel }
  | { ok: false; status: ContentfulStatusCode; message: string;
      reason: 'live_authority' | 'not_found' | 'session_expired' | 'agent_offline' | 'policy' };

/** Same gates, same order, same responses as path mode before the extraction (#8110 lines 627–657). */
export async function runTunnelRequestGates(tunnelId: string, userId: string): Promise<TunnelGateResult> {
  const liveAuthority = await authorizeTunnelContinuation(tunnelId, userId);
  if (!liveAuthority.ok) {
    return { ok: false, status: liveAuthority.status as ContentfulStatusCode, message: 'Access denied', reason: 'live_authority' };
  }
  const session = await loadOwnedTunnelSession(tunnelId, userId);
  if (!session) return { ok: false, status: 404, message: 'Not found', reason: 'not_found' };

  // Absolute 12h cap — the terminal row write is what makes the cap visible
  // to the polling parent page (see the original comment in tunnelHttp.ts).
  if (isPastSessionCap(session.createdAt)) {
    await withSystemDbAccessContext(async () => {
      await db.update(tunnelSessions)
        .set({ status: 'disconnected', errorMessage: 'session_expired', endedAt: new Date() })
        .where(eq(tunnelSessions.id, tunnelId));
    });
    return { ok: false, status: 410, message: 'Session expired', reason: 'session_expired' };
  }
  if (session.deviceStatus !== 'online' || !session.agentId || !isAgentConnected(session.agentId)) {
    return { ok: false, status: 502, message: 'Bridge agent offline', reason: 'agent_offline' };
  }
  const policy = await checkRemoteAccess(session.deviceId, 'proxy');
  if (!policy.allowed) {
    return { ok: false, status: 403, message: policy.reason ?? 'Proxy access disabled by policy', reason: 'policy' };
  }
  return { ok: true, session: session as ReachableTunnel };
}

/** Throttled lastActivityAt bump — call only after every gate passed. */
export async function bumpTunnelActivity(tunnelId: string, lastActivityAt: Date | null): Promise<void> {
  const now = new Date();
  if (lastActivityAt && now.getTime() - lastActivityAt.getTime() <= ACTIVITY_BUMP_THROTTLE_MS) return;
  await withSystemDbAccessContext(async () => {
    await db.update(tunnelSessions).set({ lastActivityAt: now }).where(eq(tunnelSessions.id, tunnelId));
  });
}

export function tunnelScheme(session: Pick<UsableTunnel, 'scheme' | 'targetPort'>): 'http' | 'https' {
  return (session.scheme as 'http' | 'https' | null) ?? (session.targetPort === 443 ? 'https' : 'http');
}

export function deviceTargetOrigin(session: Pick<UsableTunnel, 'scheme' | 'targetPort' | 'targetHost'>): string {
  const host = session.targetHost.includes(':') && !session.targetHost.startsWith('[')
    ? `[${session.targetHost}]` : session.targetHost;
  return `${tunnelScheme(session)}://${host}:${session.targetPort}`;
}

export interface UpstreamHttpResponse {
  status: number;
  headers: Record<string, string[]>;
  bodyB64: string;
  truncated?: boolean;
}

export type TunnelDispatchOutcome =
  | { ok: true; upstream: UpstreamHttpResponse }
  | { ok: false; status: 502 | 504; message: string;
      reason: 'timeout' | 'tls_cert_untrusted' | 'agent_error' | 'malformed_response' };

/** Allowlist lookup + http_request dispatch + error mapping (#8110 lines 725–786, unchanged semantics). */
export async function dispatchTunnelHttpRequest(
  tunnelId: string,
  session: ReachableTunnel,
  request: { method: string; path: string; headers: Record<string, string[]>; bodyB64: string },
): Promise<TunnelDispatchOutcome> {
  const allowlistRules = await withSystemDbAccessContext(() =>
    getActiveAllowlistPatterns(session.orgId, session.deviceSiteId));
  const awaitResult = await sendCommandToAgentAwaitResult(
    session.agentId,
    {
      id: `http-req-${tunnelId}-${randomUUID()}`,
      type: 'http_request',
      payload: {
        tunnelId,
        targetHost: session.targetHost,
        targetPort: session.targetPort,
        scheme: tunnelScheme(session),
        method: request.method,
        path: request.path,
        headers: request.headers,
        bodyB64: request.bodyB64,
        skipTlsVerify: session.skipTlsVerify,
        allowlistRules,
      },
    },
    HTTP_REQUEST_TIMEOUT_MS,
  );
  if (awaitResult.status !== 'completed') {
    const err = awaitResult.error ?? '';
    if (/timeout/i.test(err)) return { ok: false, status: 504, message: 'Upstream timeout', reason: 'timeout' };
    if (err === 'tls_cert_untrusted') {
      // (original comment kept: system context; terminal session for the recreate banner)
      await withSystemDbAccessContext(async () => {
        await db.update(tunnelSessions)
          .set({ status: 'failed', errorMessage: 'tls_cert_untrusted', endedAt: new Date() })
          .where(eq(tunnelSessions.id, tunnelId));
      });
      return { ok: false, status: 502, message: 'Untrusted upstream certificate', reason: 'tls_cert_untrusted' };
    }
    return { ok: false, status: 502, message: 'Bridge agent error', reason: 'agent_error' };
  }
  try {
    return { ok: true, upstream: JSON.parse(awaitResult.stdout ?? '') as UpstreamHttpResponse };
  } catch {
    return { ok: false, status: 502, message: 'Malformed upstream response', reason: 'malformed_response' };
  }
}

/** Decode a full gzip/deflate/br/identity stack; unknown stacks pass through untouched (#8110 lines 846–862). */
export async function decodeUpstreamBody(
  body: Buffer,
  contentEncoding: string | null,
): Promise<{ ok: true; body: Buffer; decoded: boolean } | { ok: false }> {
  const encodings = (contentEncoding ?? 'identity').split(',').map((e) => e.trim().toLowerCase());
  if (!encodings.every((e) => ['identity', 'gzip', 'deflate', 'br'].includes(e))) {
    return { ok: true, body, decoded: false };
  }
  try {
    const zlibOptions = { maxOutputLength: TUNNEL_DECOMPRESSED_BODY_MAX_BYTES };
    let out = body;
    for (const encoding of [...encodings].reverse()) {
      if (encoding === 'gzip') out = await gunzipAsync(out, zlibOptions);
      else if (encoding === 'deflate') out = await inflateAsync(out, zlibOptions);
      else if (encoding === 'br') out = await brotliDecompressAsync(out, zlibOptions);
    }
    return { ok: true, body: out, decoded: true };
  } catch {
    return { ok: false };
  }
}

export function upstreamHeaderValue(headers: Record<string, string[]> | undefined, name: string): string | null {
  for (const [k, values] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === name) return values.join(', ');
  }
  return null;
}
```

- [ ] **Step 4: Make `tunnelHttp.ts` consume the core.**
  - Imports: remove `SignJWT, jwtVerify`, `randomUUID` (keep `createHmac, timingSafeEqual`), the zlib/promisify imports, `sendCommandToAgentAwaitResult`, `getActiveAllowlistPatterns`, `isAgentConnected`, `checkRemoteAccess`, `getVerifyKey, buildHeader` (keep `getSignKey` for `computeTunnelPathToken`), `authorizeRemoteSessionContinuation` and `PERMISSIONS`. Add:
    ```ts
    import {
      CONNECTABLE_TUNNEL_STATUSES, HOP_BY_HOP, HTTP_TUNNEL_COOKIE_TTL_SECONDS,
      authorizeTunnelContinuation, bumpTunnelActivity, collectForwardableHeaders, decodeUpstreamBody,
      deviceTargetOrigin, dispatchTunnelHttpRequest, loadOwnedTunnelSession, loadTunnelRow,
      runTunnelRequestGates, signTunnelCookie, upstreamHeaderValue, verifyTunnelCookie,
    } from './tunnelHttpCore';
    // Re-exported: tunnels.ts and tunnelHttp.test.ts import these from here.
    export {
      HTTP_TUNNEL_COOKIE_TTL_SECONDS, HTTP_TUNNEL_COOKIE_CLOCK_TOLERANCE_SECONDS, HTTP_TUNNEL_MAX_SESSION_HOURS,
    } from './tunnelHttpCore';
    ```
  - Delete the moved declarations: `HTTP_REQUEST_TIMEOUT_MS`, the three exported constants (now re-exported), `HTTP_TUNNEL_MAX_SESSION_MS`, `ACTIVITY_BUMP_THROTTLE_MS`, `COOKIE_AUDIENCE`, `CONNECTABLE_TUNNEL_STATUSES`, `TUNNEL_CONTINUATION_PERMISSIONS`, `authorizeTunnelContinuation`, `isPastSessionCap`, `HOP_BY_HOP`, `FORWARDABLE_REQUEST_HEADERS`, the zlib block, `signTunnelCookie`, `verifyTunnelCookie`, `UsableTunnel`, `loadTunnelRow`, `loadOwnedTunnelSession` and `upstreamHeaderValue`. In `authenticateByPathToken`, `CONNECTABLE_TUNNEL_STATUSES.includes(session.status)` becomes `(CONNECTABLE_TUNNEL_STATUSES as readonly string[]).includes(session.status)`.
  - Replace the route body from `// 2. Authz:` (#8110 line 627) through the dispatch error handling (line 786) with:
    ```ts
      // 2. Authz — shared core (identical gates/order/responses in both modes).
      const gate = await runTunnelRequestGates(tunnelId, userId);
      if (!gate.ok) {
        return c.text(gate.message, gate.status);
      }
      const { session } = gate;

      // CORS preflight from the sandboxed document (unchanged block, #8110 lines 659–673).
      if (c.req.method === 'OPTIONS' && isSandboxOrigin(c) && c.req.header('access-control-request-method')) {
        return new Response(null, {
          status: 204,
          headers: {
            ...sandboxCorsHeaders(),
            'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE',
            'access-control-allow-headers': c.req.header('access-control-request-headers') ?? '',
            'access-control-max-age': '600',
            vary: 'Origin',
          },
        });
      }

      // All gates passed — the ONE place activity is bumped (see original comment).
      await bumpTunnelActivity(tunnelId, session.lastActivityAt);
      const refreshedCookie = pathTokenOnly ? null : generateCookie(authCookieName, await signTunnelCookie(userId, tunnelId), {
        httpOnly: true,
        secure: true,
        sameSite: 'None',
        path: basePath,
        maxAge: HTTP_TUNNEL_COOKIE_TTL_SECONDS,
      });

      // 3. Build + dispatch the http_request command.
      const wildcard = c.req.path.startsWith(basePath) ? c.req.path.slice(basePath.length) : '';
      const qs = new URL(c.req.url).search;
      const path = '/' + wildcard + qs;
      const headers = collectForwardableHeaders(c.req.header());
      const deviceCookies = extractDeviceCookies(c.req.header('cookie') ?? '');
      if (deviceCookies) {
        headers['cookie'] = [deviceCookies];
      }
      const method = c.req.method.toUpperCase();
      let bodyB64 = '';
      if (method !== 'GET' && method !== 'HEAD') {
        bodyB64 = Buffer.from(await c.req.arrayBuffer()).toString('base64');
      }
      const outcome = await dispatchTunnelHttpRequest(tunnelId, session, { method, path, headers, bodyB64 });
      if (!outcome.ok) {
        return c.text(outcome.message, outcome.status);
      }
      const upstream = outcome.upstream;
    ```
  - In section "5. Rewrite headers + body" keep the header loop unchanged. Replace the `targetHost`/`rewriteOptions` lines and the whole decode `if` block (#8110 lines 841–869) with:
    ```ts
      const rewriteOptions = { basePath, targetOrigin: deviceTargetOrigin(session) };
      const isHtml = contentType.toLowerCase().includes('text/html');
      if (isHtml || contentType.toLowerCase().includes('text/css')) {
        const decoded = await decodeUpstreamBody(body as Buffer, respHeaders.get('content-encoding'));
        if (!decoded.ok) {
          return c.text('Malformed upstream content encoding', 502);
        }
        if (decoded.decoded) {
          body = isHtml
            ? rewriteTunnelHtml(decoded.body.toString('utf8'), rewriteOptions)
            : rewriteTunnelCss(decoded.body.toString('utf8'), rewriteOptions);
          respHeaders.delete('content-encoding');
          respHeaders.set('content-length', String(Buffer.byteLength(body)));
        }
      }
    ```
  - The ticket branch keeps `authorizeTunnelContinuation` and `loadOwnedTunnelSession`, now imported from the core. Its activation `UPDATE` is left as-is in this task (Task 3 changes it).
- [ ] **Step 5: Run the new core tests and the untouched path-mode suite**
  Run: `cd apps/api && npx vitest run src/routes/tunnelHttpCore.test.ts src/routes/tunnelHttp.test.ts src/routes/tunnels.test.ts`
  Expected: all PASS, with no edits to `tunnelHttp.test.ts`. That proves path mode is unchanged.
- [ ] **Step 6: Typecheck and commit**
  ```bash
  cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"
  git add apps/api/src/routes/tunnelHttpCore.ts apps/api/src/routes/tunnelHttpCore.test.ts apps/api/src/routes/tunnelHttp.ts
  git commit -m "refactor(network-proxy): extract shared tunnel-http core (path mode unchanged)"
  ```

### Task 3: Conditional activation (both modes) + Close cancels in-flight requests

**Files:**
- Modify: `apps/api/src/routes/tunnelHttpCore.ts`
- Modify: `apps/api/src/routes/tunnelHttp.ts` (ticket branch, #8110 lines 583–592)
- Modify: `apps/api/src/services/agentCommandAwait.ts`, `apps/api/src/services/agentCommandAwait.test.ts`
- Modify: `apps/api/src/routes/tunnels.ts` (DELETE `/:id`, ~line 1194)
- Modify: `apps/api/src/routes/tunnelHttp.test.ts`, `apps/api/src/routes/tunnels.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // services/agentCommandAwait.ts
  export function cancelPendingAgentCommandsByPrefix(prefix: string, error: string): number;
  // routes/tunnelHttpCore.ts
  export const TUNNEL_CLOSED_ERROR = 'tunnel_closed';
  export function tunnelHttpCommandPrefix(tunnelId: string): string; // `http-req-${tunnelId}-`
  export function activateTunnelSessionOnExchange(tunnelId: string, setStartedAt: boolean): Promise<boolean>;
  // TunnelDispatchOutcome.reason gains 'tunnel_closed'
  ```

- [ ] **Step 1: Write the failing tests.**

In `apps/api/src/services/agentCommandAwait.test.ts`, change the import to `import { sendCommandToAgentAwaitResult, resolvePendingAgentCommand, cancelPendingAgentCommandsByPrefix } from './agentCommandAwait';` and add:

```ts
  it('cancelPendingAgentCommandsByPrefix resolves only the matching in-flight commands', async () => {
    mockSendCommandToAgent.mockReturnValue(true);
    const closing = sendCommandToAgentAwaitResult('agent-1', { id: 'http-req-T1-a', type: 'http_request', payload: {} }, 60_000);
    const other = sendCommandToAgentAwaitResult('agent-1', { id: 'http-req-T2-b', type: 'http_request', payload: {} }, 60_000);

    expect(cancelPendingAgentCommandsByPrefix('http-req-T1-', 'tunnel_closed')).toBe(1);
    await expect(closing).resolves.toEqual({ status: 'failed', error: 'tunnel_closed' });
    // A late result for the cancelled id is a no-op; the other tunnel is untouched.
    expect(resolvePendingAgentCommand('http-req-T1-a', { status: 'completed' })).toBe(false);
    expect(resolvePendingAgentCommand('http-req-T2-b', { status: 'completed' })).toBe(true);
    await expect(other).resolves.toEqual({ status: 'completed' });
  });
```

In `apps/api/src/routes/tunnelHttp.test.ts`, make the db mock support `.returning()` and drive it:

```ts
// near capturedSessionUpdates:
let activationRows: Array<{ id: string }> = [{ id: TUNNEL_ID }];

// replace the `update:` mock in vi.mock('../db', …):
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        capturedSessionUpdate = values;
        capturedSessionUpdates.push(values);
        return {
          where: vi.fn(() => Object.assign(Promise.resolve(undefined), {
            returning: vi.fn(async () => activationRows),
          })),
        };
      }),
    })),

// add `status: 'tunnelSessions.status'` to the tunnelSessions schema mock.
// in beforeEach: activationRows = [{ id: TUNNEL_ID }];
```

and add:

```ts
describe('ticket exchange vs Close (spec §4 revocation)', () => {
  it('does not reopen a session that Close ended between the ownership read and activation', async () => {
    activationRows = []; // the conditional UPDATE … WHERE status IN (connectable) matched nothing
    consumeWsTicketMock.mockResolvedValueOnce({
      ok: true, sessionId: TUNNEL_ID, sessionType: 'tunnel-http', userId: USER_ID, expiresAt: Date.now() + 60_000,
    });
    const res = await makeApp().request(`${BASE}/?__bzt=goodticket`);
    expect(res.status).toBe(404);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('refuses a still-valid ticket once the row is terminal', async () => {
    setJoinRow(defaultJoinRow({ status: 'disconnected' }));
    consumeWsTicketMock.mockResolvedValueOnce({
      ok: true, sessionId: TUNNEL_ID, sessionType: 'tunnel-http', userId: USER_ID, expiresAt: Date.now() + 60_000,
    });
    const res = await makeApp().request(`${BASE}/?__bzt=goodticket`);
    expect(res.status).toBe(404);
    expect(capturedSessionUpdates).toEqual([]);
  });

  it('maps a Close-cancelled dispatch to 502 "Tunnel closed"', async () => {
    const app = makeApp();
    const cookie = await mintCookie(app);
    sendCommandMock.mockResolvedValueOnce({ status: 'failed', error: 'tunnel_closed' });
    const res = await app.request(`${TOKEN_BASE}/`, { headers: { cookie } });
    expect(res.status).toBe(502);
    expect(await res.text()).toBe('Tunnel closed');
  });
});
```

In `apps/api/src/routes/tunnels.test.ts`, add a mock near the other `vi.mock`s and a test in the DELETE audit area:

```ts
const { cancelPendingMock } = vi.hoisted(() => ({ cancelPendingMock: vi.fn(() => 0) }));
vi.mock('../services/agentCommandAwait', () => ({
  sendCommandToAgentAwaitResult: vi.fn(),
  cancelPendingAgentCommandsByPrefix: cancelPendingMock,
}));

  it('DELETE /tunnels/:id cancels the tunnel’s in-flight proxied requests', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeSelectChain([sessionRecord]) as any)
      .mockReturnValueOnce(makeSelectChain([onlineDevice]) as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    } as any);
    vi.mocked(db.insert).mockImplementation(vi.fn().mockReturnValue(makeAuditAwareInsertChain([])) as any);

    const res = await app.request(`/tunnels/${SESSION_ID}`, {
      method: 'DELETE',
      headers: { 'x-test-scope': 'partner', 'x-test-accessible-orgs': ORG_ID },
    });

    expect(res.status).toBe(200);
    expect(cancelPendingMock).toHaveBeenCalledWith(`http-req-${SESSION_ID}-`, 'tunnel_closed');
  });
```

(Place the test inside the `describe` that already holds "DELETE /tunnels/:id writes a tunnel.close audit row …" so it reuses that block's `app` and `beforeEach`.)

- [ ] **Step 2: Run to verify they fail**
  Run: `cd apps/api && npx vitest run src/services/agentCommandAwait.test.ts src/routes/tunnelHttp.test.ts src/routes/tunnels.test.ts`
  Expected: FAIL. `cancelPendingAgentCommandsByPrefix is not a function`, a 302 where 404 was expected, `'Bridge agent error'` instead of `'Tunnel closed'`, and `cancelPendingMock` not called.

- [ ] **Step 3: Implement.**

`apps/api/src/services/agentCommandAwait.ts` (append):

```ts
/**
 * Resolve every in-flight awaited command whose id starts with `prefix` as
 * `{status:'failed', error}`. Used by tunnel Close (spec 2026-10-06 §4) to
 * cancel that tunnel's proxied requests. Process-local like the rest of this
 * module: a request in flight on ANOTHER api replica is not reached (single
 * api replica per region today — plan G9).
 */
export function cancelPendingAgentCommandsByPrefix(prefix: string, error: string): number {
  let cancelled = 0;
  for (const [id, entry] of pending) {
    if (!id.startsWith(prefix)) continue;
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.resolve({ status: 'failed', error });
    cancelled += 1;
  }
  return cancelled;
}
```

`apps/api/src/routes/tunnelHttpCore.ts`:

```ts
import { and, eq, inArray } from 'drizzle-orm'; // replaces the `eq`-only import

export const TUNNEL_CLOSED_ERROR = 'tunnel_closed';

export function tunnelHttpCommandPrefix(tunnelId: string): string {
  return `http-req-${tunnelId}-`;
}

/**
 * Ticket-exchange activation, CONDITIONAL on the row still being connectable
 * (spec §4): an exchange racing Close can never flip a closed row back to
 * active. Returns false when nothing matched (caller answers 404, no cookie).
 */
export async function activateTunnelSessionOnExchange(tunnelId: string, setStartedAt: boolean): Promise<boolean> {
  const updates: Record<string, unknown> = { status: 'active' };
  if (setStartedAt) updates.startedAt = new Date();
  const rows = await withSystemDbAccessContext(async () =>
    db.update(tunnelSessions)
      .set(updates)
      .where(and(eq(tunnelSessions.id, tunnelId), inArray(tunnelSessions.status, [...CONNECTABLE_TUNNEL_STATUSES])))
      .returning({ id: tunnelSessions.id }));
  return rows.length > 0;
}
```

In `dispatchTunnelHttpRequest`, extend the reason union with `'tunnel_closed'` and add this as the first check inside `if (awaitResult.status !== 'completed')`:

```ts
    if (err === TUNNEL_CLOSED_ERROR) return { ok: false, status: 502, message: 'Tunnel closed', reason: 'tunnel_closed' };
```

and use the prefix helper for the command id: `id: \`${tunnelHttpCommandPrefix(tunnelId)}${randomUUID()}\``.

`apps/api/src/routes/tunnelHttp.ts`: in the ticket branch replace the `mintUpdates` object and its `withSystemDbAccessContext(… db.update …)` (#8110 lines 583–592) with:

```ts
    // `active` = "a client established a session"; startedAt only when still
    // null. Conditional on the row still being connectable (spec §4): a ticket
    // racing Close must not reopen the session.
    if (!(await activateTunnelSessionOnExchange(tunnelId, !ownedAtMint.startedAt))) {
      return c.text('Not found', 404);
    }
```

(add `activateTunnelSessionOnExchange` to the core import list; drop the now-unused `db`, `tunnelSessions` and `eq` imports from `tunnelHttp.ts` if nothing else uses them).

`apps/api/src/routes/tunnels.ts`: import `{ cancelPendingAgentCommandsByPrefix } from '../services/agentCommandAwait'` and `{ TUNNEL_CLOSED_ERROR, tunnelHttpCommandPrefix } from './tunnelHttpCore'`. In DELETE `/:id`, directly after the `db.update(… status: 'disconnected' …)` and before `revokeViewerSession(id)`:

```ts
    // Spec §4: Close cancels this tunnel's in-flight proxied requests so no
    // device response lands after the user saw "disconnected".
    cancelPendingAgentCommandsByPrefix(tunnelHttpCommandPrefix(id), TUNNEL_CLOSED_ERROR);
```

- [ ] **Step 4: Run the tests to verify they pass**
  Run: `cd apps/api && npx vitest run src/services/agentCommandAwait.test.ts src/routes/tunnelHttpCore.test.ts src/routes/tunnelHttp.test.ts src/routes/tunnels.test.ts`
  Expected: all PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add apps/api/src/services/agentCommandAwait.ts apps/api/src/services/agentCommandAwait.test.ts apps/api/src/routes/tunnelHttpCore.ts apps/api/src/routes/tunnelHttp.ts apps/api/src/routes/tunnelHttp.test.ts apps/api/src/routes/tunnels.ts apps/api/src/routes/tunnels.test.ts
  git commit -m "fix(network-proxy): conditional session activation + Close cancels in-flight requests"
  ```

### Task 4: `http-ticket` returns a server-built `url` (and `mode=tab`)

**Files:**
- Modify: `apps/api/src/routes/tunnels.ts` (POST `/:id/http-ticket`, ~lines 1285–1357)
- Modify: `apps/api/src/routes/tunnels.test.ts` (`describe('POST /tunnels/:id/http-ticket')`, ~line 3317)

**Interfaces:**
- Consumes: `getTunnelOriginConfig`, `buildTunnelEnterUrl`, `buildPathModeTicketUrl`, `__resetTunnelOriginConfigForTests` (Task 1).
- Produces: the response `{ ticket: { ticket: string; expiresInSeconds: number }, url: string, mode: 'host' | 'path' }` and the query `?mode=frame|tab` (default `frame`). The audit row details gain `mode` and `context`.

- [ ] **Step 1: Write the failing tests** (append inside the existing `describe('POST /tunnels/:id/http-ticket', …)`; add `import { __resetTunnelOriginConfigForTests } from '../config/tunnelOrigin';` at the top):

```ts
  describe('server-built url', () => {
    afterEach(() => {
      delete process.env.TUNNEL_ORIGIN_TEMPLATE;
      delete process.env.TUNNEL_FRAME_ANCESTOR;
      __resetTunnelOriginConfigForTests();
    });

    it('returns a path-mode url when host mode is off', async () => {
      vi.mocked(db.select).mockReturnValueOnce(makeSelectChain([sessionRecord]) as any);
      vi.mocked(db.insert).mockReturnValue(makeAuditAwareInsertChain([]) as any);
      const res = await app.request(`/tunnels/${SESSION_ID}/http-ticket`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ticket).toEqual({ ticket: 'ws-ticket-abc', expiresInSeconds: 60 });
      expect(body.url).toBe(`/api/v1/tunnel-http/${SESSION_ID}/?__bzt=ws-ticket-abc`);
      expect(body.mode).toBe('path');
    });

    it('returns the tunnel-origin enter url in host mode', async () => {
      process.env.TUNNEL_ORIGIN_TEMPLATE = 'https://{id}.us.breezetunnel.test';
      process.env.TUNNEL_FRAME_ANCESTOR = 'https://app.breeze-app.test';
      __resetTunnelOriginConfigForTests();
      vi.mocked(db.select).mockReturnValueOnce(makeSelectChain([sessionRecord]) as any);
      vi.mocked(db.insert).mockReturnValue(makeAuditAwareInsertChain([]) as any);
      const res = await app.request(`/tunnels/${SESSION_ID}/http-ticket`, { method: 'POST' });
      const body = await res.json();
      expect(body.url).toBe(`https://${SESSION_ID}.us.breezetunnel.test/__bz/enter?t=ws-ticket-abc`);
      expect(body.mode).toBe('host');
    });

    it('builds a new-tab url for ?mode=tab', async () => {
      process.env.TUNNEL_ORIGIN_TEMPLATE = 'https://{id}.us.breezetunnel.test';
      process.env.TUNNEL_FRAME_ANCESTOR = 'https://app.breeze-app.test';
      __resetTunnelOriginConfigForTests();
      vi.mocked(db.select).mockReturnValueOnce(makeSelectChain([sessionRecord]) as any);
      vi.mocked(db.insert).mockReturnValue(makeAuditAwareInsertChain([]) as any);
      const res = await app.request(`/tunnels/${SESSION_ID}/http-ticket?mode=tab`, { method: 'POST' });
      expect((await res.json()).url).toBe(`https://${SESSION_ID}.us.breezetunnel.test/__bz/enter?t=ws-ticket-abc&mode=tab`);
    });

    it('rejects an unknown mode', async () => {
      const res = await app.request(`/tunnels/${SESSION_ID}/http-ticket?mode=popup`, { method: 'POST' });
      expect(res.status).toBe(400);
    });
  });
```

- [ ] **Step 2: Run to verify it fails**
  Run: `cd apps/api && npx vitest run src/routes/tunnels.test.ts -t "server-built url"`
  Expected: FAIL. `body.url` is undefined, and `?mode=popup` returns 200.
- [ ] **Step 3: Implement** in `tunnels.ts`:

```ts
import { buildPathModeTicketUrl, buildTunnelEnterUrl, getTunnelOriginConfig } from '../config/tunnelOrigin';

const httpTicketQuerySchema = z.object({ mode: z.enum(['frame', 'tab']).optional() });

// route: add the validator after zValidator('param', idParamSchema):
  zValidator('query', httpTicketQuerySchema),

// inside the handler, after `const { id } = c.req.valid('param');`
    const context = c.req.valid('query').mode ?? 'frame';

// replace `return c.json({ ticket });` and extend the audit details:
    const tunnelOrigin = getTunnelOriginConfig();
    const url = tunnelOrigin
      ? buildTunnelEnterUrl(tunnelOrigin, id, ticket.ticket, context)
      : buildPathModeTicketUrl(id, ticket.ticket);
    const mode = tunnelOrigin ? 'host' : 'path';
    // (audit call above: details become { deviceId, type, mode, context })
    return c.json({ ticket, url, mode });
```

- [ ] **Step 4: Run the tests to verify they pass**
  Run: `cd apps/api && npx vitest run src/routes/tunnels.test.ts`
  Expected: PASS (including the pre-existing `returns { ticket } …` case).
- [ ] **Step 5: Commit**
  ```bash
  git add apps/api/src/routes/tunnels.ts apps/api/src/routes/tunnels.test.ts
  git commit -m "feat(network-proxy): http-ticket returns server-built url + mode"
  ```

### Task 5: Host classification, assertion header and dispatch wiring (tunnel hosts fail closed)

**Files:**
- Create: `apps/api/src/middleware/tunnelHostDispatch.ts`, `apps/api/src/middleware/tunnelHostDispatch.test.ts`
- Create: `apps/api/src/routes/tunnelHost.ts` (fail-closed scaffold; Task 8 replaces the handler)
- Create: `apps/api/src/index.tunnelHostOrder.test.ts`
- Modify: `apps/api/src/middleware/security.ts` (+ `security.test.ts`), `apps/api/src/middleware/globalRateLimit.ts` (+ test), `apps/api/src/index.ts` (~lines 449–506)

**Interfaces:**
- Consumes: `getTunnelOriginConfig`, `isTunnelDomainHost`, `TunnelOriginConfig` (Task 1).
- Produces:
  ```ts
  export const TUNNEL_SITE_ASSERTION_HEADER = 'x-breeze-tunnel-site';
  export const TUNNEL_SITE_ASSERTION_VALUE = '1';
  export type TunnelHostDecision = { kind: 'app' } | { kind: 'tunnel' } | { kind: 'reject'; reason: 'tunnel_host_without_assertion' | 'tunnel_assertion_on_app_host' | 'tunnel_assertion_while_disabled' };
  export function decideTunnelHost(hostHeader: string | undefined, assertion: string | undefined, config: TunnelOriginConfig | null): TunnelHostDecision;
  export function tunnelHostClassifier(getConfig?: () => TunnelOriginConfig | null): MiddlewareHandler;
  export function tunnelHostDispatch(tunnelApp: { fetch: (req: Request, env?: unknown) => Response | Promise<Response> }): MiddlewareHandler;
  export function isTunnelSurface(c: Context): boolean;
  export function exceptTunnelSurface(mw: MiddlewareHandler): MiddlewareHandler;
  // routes/tunnelHost.ts
  export const tunnelHostRoutes: Hono;
  // security.ts option: skipHeadersWhen?: (c: Context) => boolean
  // globalRateLimit.ts: export const TUNNEL_HOST_BUCKET: IsolatedBucket = { prefix: '', name: 'tunnelhost', limit: 1200 }
  ```

- [ ] **Step 1: Write the failing tests**:

```ts
// apps/api/src/middleware/tunnelHostDispatch.test.ts
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { parseTunnelOriginConfig } from '../config/tunnelOrigin';
import {
  decideTunnelHost,
  exceptTunnelSurface,
  tunnelHostClassifier,
  tunnelHostDispatch,
} from './tunnelHostDispatch';

const ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const TUNNEL_HOST = `${ID}.us.breezetunnel.test`;
const parsed = parseTunnelOriginConfig({
  NODE_ENV: 'production', PUBLIC_APP_URL: 'https://us.breeze-app.test',
  TUNNEL_ORIGIN_TEMPLATE: 'https://{id}.us.breezetunnel.test',
});
if (!parsed.ok || !parsed.config) throw new Error('fixture config invalid');
const CONFIG = parsed.config;

function makeApp(config = CONFIG) {
  const tunnelApp = new Hono();
  tunnelApp.all('*', async (c) => c.text(`tunnel|${c.req.method}|${c.req.path}|${await c.req.text()}`));
  const app = new Hono();
  app.use('*', tunnelHostClassifier(() => config));
  app.use('*', exceptTunnelSurface(secureHeaders({ xFrameOptions: 'DENY' })));
  app.use('*', tunnelHostDispatch(tunnelApp));
  app.get('/api/v1/secret', (c) => c.text('app-route'));
  app.post('/api/v1/secret', (c) => c.text('app-route'));
  return app;
}

describe('decideTunnelHost', () => {
  it.each([
    [TUNNEL_HOST, '1', CONFIG, 'tunnel'],
    [`a.b.us.breezetunnel.test`, '1', CONFIG, 'tunnel'],
    ['us.breezetunnel.test', '1', CONFIG, 'tunnel'],
    [TUNNEL_HOST, undefined, CONFIG, 'reject'],
    ['us.breezetunnel.test', undefined, CONFIG, 'reject'],
    [TUNNEL_HOST, 'forged', CONFIG, 'reject'],
    ['us.breeze-app.test', '1', CONFIG, 'reject'],
    ['us.breeze-app.test', undefined, CONFIG, 'app'],
    [TUNNEL_HOST, '1', null, 'reject'],
    [TUNNEL_HOST, undefined, null, 'app'],
  ] as const)('host %s assertion %s → %s', (host, assertion, config, kind) => {
    expect(decideTunnelHost(host, assertion, config).kind).toBe(kind);
  });
});

describe('tunnel host dispatch', () => {
  it('sends an asserted tunnel host to the tunnel app — even for /api paths — without app headers', async () => {
    const res = await makeApp().request('/api/v1/secret', { headers: { host: TUNNEL_HOST, 'x-breeze-tunnel-site': '1' } });
    expect(await res.text()).toBe('tunnel|GET|/api/v1/secret|');
    expect(res.headers.get('x-frame-options')).toBeNull();
  });

  it('passes a POST body through to the tunnel app', async () => {
    const res = await makeApp().request('/form', {
      method: 'POST', body: 'a=1', headers: { host: TUNNEL_HOST, 'x-breeze-tunnel-site': '1' },
    });
    expect(await res.text()).toBe('tunnel|POST|/form|a=1');
  });

  it('serves app routes on app hosts with app headers', async () => {
    const res = await makeApp().request('/api/v1/secret', { headers: { host: 'us.breeze-app.test' } });
    expect(await res.text()).toBe('app-route');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('421s a tunnel-pattern Host without the assertion and an app Host with it', async () => {
    const app = makeApp();
    expect((await app.request('/api/v1/secret', { headers: { host: TUNNEL_HOST } })).status).toBe(421);
    expect((await app.request('/api/v1/secret', { headers: { host: 'us.breeze-app.test', 'x-breeze-tunnel-site': '1' } })).status).toBe(421);
  });

  it('ignores X-Forwarded-Host for the decision', async () => {
    const res = await makeApp().request('/api/v1/secret', { headers: { host: 'us.breeze-app.test', 'x-forwarded-host': TUNNEL_HOST } });
    expect(await res.text()).toBe('app-route');
  });

  it('with host mode off, any assertion is refused and tunnel-looking hosts are ordinary app hosts', async () => {
    const app = makeApp(null as never);
    expect((await app.request('/api/v1/secret', { headers: { host: TUNNEL_HOST, 'x-breeze-tunnel-site': '1' } })).status).toBe(421);
    expect(await (await app.request('/api/v1/secret', { headers: { host: TUNNEL_HOST } })).text()).toBe('app-route');
  });
});
```

```ts
// apps/api/src/index.tunnelHostOrder.test.ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Static contract (like caddyWebBillingCarveouts.test.ts): importing index.ts
// boots the world, so pin the middleware ORDER from source instead.
const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8');
const at = (needle: string) => {
  const i = src.indexOf(needle);
  expect(i, `${needle} not found in index.ts`).toBeGreaterThan(-1);
  return i;
};

describe('tunnel host middleware order (spec §3)', () => {
  it('classifies after metrics/logging and dispatches after body limit + rate limit, before CORS', () => {
    const metrics = at("app.use('*', metricsMiddleware)");
    const logger = at("app.use('*', requestPathLogger())");
    const classifier = at("app.use('*', tunnelHostClassifier())");
    const bodyLimit = at('createGlobalBodyLimitMiddleware(');
    const rateLimit = at("app.use('*', globalRateLimit())");
    const dispatch = at("app.use('*', tunnelHostDispatch(tunnelHostRoutes))");
    const cors = at('cors({');
    expect(metrics).toBeLessThan(classifier);
    expect(logger).toBeLessThan(classifier);
    expect(classifier).toBeLessThan(bodyLimit);
    expect(bodyLimit).toBeLessThan(dispatch);
    expect(rateLimit).toBeLessThan(dispatch);
    expect(dispatch).toBeLessThan(cors);
  });

  it('exempts tunnel surfaces from the app security-header stack', () => {
    expect(src).toMatch(/exceptPathPrefix\(TUNNEL_HTTP_PATH_PREFIX, exceptTunnelSurface\(mw\)\)/);
    expect(src).toMatch(/skipHeadersWhen: isTunnelSurface/);
  });
});
```

Append to `apps/api/src/middleware/globalRateLimit.test.ts`:

```ts
  it('meters tunnel-host traffic in its own bucket, never the shared dashboard bucket', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      if (c.req.header('x-test-tunnel') === '1') c.set('tunnelSurface', true);
      return next();
    });
    app.use('*', globalRateLimit({ limit: 2, windowSeconds: 60 }));
    app.get('*', (c) => c.text('ok'));

    for (let i = 0; i < 5; i += 1) {
      expect((await app.request('/any/device/path.js', { headers: { 'x-test-tunnel': '1' } })).status).toBe(200);
    }
    expect((await app.request('/api/v1/dashboard')).status).toBe(200);
    expect((await app.request('/api/v1/dashboard')).status).toBe(200);
    expect((await app.request('/api/v1/dashboard')).status).toBe(429);
  });
```

Append to `apps/api/src/middleware/security.test.ts` (reuse its `createApp` helper pattern):

```ts
  it('skips its response headers when skipHeadersWhen returns true', async () => {
    const app = new Hono();
    app.use('*', securityMiddleware({ nodeEnv: 'production', skipHeadersWhen: (c) => c.req.header('host') === 'tunnel.test' }));
    app.get('/', (c) => c.text('ok'));
    expect((await app.request('/', { headers: { host: 'tunnel.test' } })).headers.get('content-security-policy')).toBeNull();
    expect((await app.request('/', { headers: { host: 'app.test' } })).headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
```

- [ ] **Step 2: Run to verify they fail**
  Run: `cd apps/api && npx vitest run src/middleware/tunnelHostDispatch.test.ts src/index.tunnelHostOrder.test.ts src/middleware/globalRateLimit.test.ts src/middleware/security.test.ts`
  Expected: FAIL (unresolved import, missing index.ts needles, a 429 on the third tunnel request, and a CSP header present).
- [ ] **Step 3: Implement.**

```ts
// apps/api/src/middleware/tunnelHostDispatch.ts
/**
 * Network Proxy host mode (spec 2026-10-06 §3). Tunnel hosts and app hosts
 * share api:3001, so the Caddy-set `X-Breeze-Tunnel-Site` assertion is the
 * only ingress signal: every Caddy site block strips it, only the tunnel block
 * sets it. A tunnel-domain Host without it, or an app Host with it, is 421.
 * X-Forwarded-Host is never consulted.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { getTunnelOriginConfig, isTunnelDomainHost, type TunnelOriginConfig } from '../config/tunnelOrigin';

export const TUNNEL_SITE_ASSERTION_HEADER = 'x-breeze-tunnel-site';
export const TUNNEL_SITE_ASSERTION_VALUE = '1';

declare module 'hono' {
  interface ContextVariableMap {
    tunnelSurface: boolean;
  }
}

export type TunnelHostDecision =
  | { kind: 'app' }
  | { kind: 'tunnel' }
  | { kind: 'reject'; reason: 'tunnel_host_without_assertion' | 'tunnel_assertion_on_app_host' | 'tunnel_assertion_while_disabled' };

export function decideTunnelHost(
  hostHeader: string | undefined,
  assertion: string | undefined,
  config: TunnelOriginConfig | null,
): TunnelHostDecision {
  const asserted = assertion !== undefined;
  if (!config) return asserted ? { kind: 'reject', reason: 'tunnel_assertion_while_disabled' } : { kind: 'app' };
  const onTunnelDomain = isTunnelDomainHost(hostHeader, config);
  if (onTunnelDomain) {
    return assertion === TUNNEL_SITE_ASSERTION_VALUE
      ? { kind: 'tunnel' }
      : { kind: 'reject', reason: 'tunnel_host_without_assertion' };
  }
  return asserted ? { kind: 'reject', reason: 'tunnel_assertion_on_app_host' } : { kind: 'app' };
}

export function tunnelHostClassifier(getConfig: () => TunnelOriginConfig | null = getTunnelOriginConfig): MiddlewareHandler {
  return async (c, next) => {
    const decision = decideTunnelHost(c.req.header('host'), c.req.header(TUNNEL_SITE_ASSERTION_HEADER), getConfig());
    if (decision.kind === 'reject') {
      c.set('rejectReason', decision.reason);
      return c.text('Misdirected request', 421);
    }
    if (decision.kind === 'tunnel') c.set('tunnelSurface', true);
    return next();
  };
}

export function isTunnelSurface(c: Context): boolean {
  return c.get('tunnelSurface') === true;
}

/** Skip `mw` entirely on tunnel surfaces (app CSP/XFO/CORS must never merge into device responses). */
export function exceptTunnelSurface(mw: MiddlewareHandler): MiddlewareHandler {
  return async (c, next) => (isTunnelSurface(c) ? next() : mw(c, next));
}

/** Terminal for tunnel surfaces: no app route, auth middleware, CORS or static handler runs after this. */
export function tunnelHostDispatch(
  tunnelApp: { fetch: (req: Request, env?: unknown) => Response | Promise<Response> },
): MiddlewareHandler {
  return async (c, next) => {
    if (!isTunnelSurface(c)) return next();
    return tunnelApp.fetch(c.req.raw, c.env);
  };
}
```

```ts
// apps/api/src/routes/tunnelHost.ts  (scaffold — Task 8 replaces the handler)
import { Hono } from 'hono';

/**
 * Network Proxy host-mode app (spec 2026-10-06 §3–§6). Reached only through
 * tunnelHostDispatch for an asserted tunnel Host. Until the full handler
 * lands (W02), every tunnel-host request fails closed.
 */
export const tunnelHostRoutes = new Hono();
tunnelHostRoutes.all('*', (c) => c.text('Not found', 404));
```

`apps/api/src/middleware/security.ts`: add to `SecurityMiddlewareOptions`:

```ts
  /** Predicate form of skipHeadersPathPrefix (tunnel-host requests, spec 2026-10-06 §3). */
  skipHeadersWhen?: (c: Context) => boolean;
```

and replace `if (!skipHeadersPathPrefix || !path.startsWith(skipHeadersPathPrefix)) {` with:

```ts
    const skipHeaders = (skipHeadersPathPrefix !== undefined && path.startsWith(skipHeadersPathPrefix))
      || options?.skipHeadersWhen?.(c) === true;
    if (!skipHeaders) {
```

`apps/api/src/middleware/globalRateLimit.ts`:

```ts
/**
 * Tunnel-host requests (Network Proxy host mode) carry arbitrary device paths,
 * so the path-prefix buckets above can't isolate them: one device admin page
 * loading 100 subresources would otherwise drain the shared dashboard budget
 * of every user behind the same IP (plan G7). The tunnel route adds its own
 * per-user/tunnel/agent budgets on top (tunnelHttpBudget.ts).
 */
export const TUNNEL_HOST_BUCKET: IsolatedBucket = { prefix: '', name: 'tunnelhost', limit: 1200 };

// in the middleware, replace `const bucket = isolatedBuckets.find(...)` with:
    const bucket = c.get('tunnelSurface') === true
      ? TUNNEL_HOST_BUCKET
      : isolatedBuckets.find(b => c.req.path.startsWith(b.prefix));
```

(`globalRateLimit.ts` must `import './tunnelHostDispatch';` for the `ContextVariableMap` augmentation, or use `c.get('tunnelSurface' as never)`. Prefer the import with a one-line comment.)

`apps/api/src/index.ts`:

```ts
import { tunnelHostRoutes } from './routes/tunnelHost';
import { exceptTunnelSurface, isTunnelSurface, tunnelHostClassifier, tunnelHostDispatch } from './middleware/tunnelHostDispatch';

app.use('*', metricsMiddleware);
app.use('*', requestPathLogger());
// Network Proxy host mode (spec 2026-10-06 §3): classify by Host + the Caddy
// tunnel-site assertion. Runs after metrics/logging (they cover tunnel traffic)
// and before every app header/CORS middleware (those skip tunnel surfaces).
app.use('*', tunnelHostClassifier());

const TUNNEL_HTTP_PATH_PREFIX = '/api/v1/tunnel-http/';
const exceptTunnelHttp = (mw: MiddlewareHandler) => exceptPathPrefix(TUNNEL_HTTP_PATH_PREFIX, exceptTunnelSurface(mw));
// … secureHeaders block unchanged …
app.use('*', securityMiddleware({ skipHeadersPathPrefix: TUNNEL_HTTP_PATH_PREFIX, skipHeadersWhen: isTunnelSurface }));
// … createGlobalBodyLimitMiddleware unchanged …
app.use('*', globalRateLimit());
// Tunnel hosts end here: body limit, rate limit, metrics and logging already
// ran; no app route, auth, prettyJSON or CORS is reachable on a tunnel host.
app.use('*', tunnelHostDispatch(tunnelHostRoutes));
app.use('*', prettyJSON());
```

Update the long comment above `TUNNEL_HTTP_PATH_PREFIX` with one sentence: "Tunnel hosts (host mode) are exempted the same way via `exceptTunnelSurface` / `skipHeadersWhen`."

- [ ] **Step 4: Run the tests to verify they pass**
  Run: `cd apps/api && npx vitest run src/middleware/tunnelHostDispatch.test.ts src/index.tunnelHostOrder.test.ts src/middleware/globalRateLimit.test.ts src/middleware/security.test.ts src/routes/tunnelHttp.test.ts`
  Expected: PASS.
- [ ] **Step 5: Run the full API unit suite once** (W01 touches shared middleware):
  Run: `cd apps/api && npx vitest run 2>&1 | tail -15`
  Expected: `Test Files  N passed`, with no new failures compared with `main`.
- [ ] **Step 6: Typecheck and commit**
  ```bash
  cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"
  git add apps/api/src/middleware/tunnelHostDispatch.ts apps/api/src/middleware/tunnelHostDispatch.test.ts apps/api/src/routes/tunnelHost.ts apps/api/src/index.tunnelHostOrder.test.ts apps/api/src/middleware/security.ts apps/api/src/middleware/security.test.ts apps/api/src/middleware/globalRateLimit.ts apps/api/src/middleware/globalRateLimit.test.ts apps/api/src/index.ts
  git commit -m "feat(network-proxy): Host classification + tunnel-site assertion + fail-closed dispatch"
  ```

**W01 PR:** open against `main` with `Closes #<W01 sub-issue>`. In the description, list the two intended path-mode changes (conditional activation; Close cancels in-flight requests → 502 "Tunnel closed") and state "host mode unreachable: tunnel hosts 404". Run one review round (`/pr-review-toolkit:review-pr`). The change is high blast radius (auth/remote access), so use Sonnet or Opus per CLAUDE.md Model Routing.

---

# W02 — API host mode (PR 2 of 2)

### Task 6: Host-mode header and cookie rules (pure) + `injectBase` option

**Files:**
- Create: `apps/api/src/routes/tunnelHostHeaders.ts`, `apps/api/src/routes/tunnelHostHeaders.test.ts`
- Modify: `apps/api/src/routes/tunnelHttpRewrite.ts` (`rewriteTunnelHtml`, #8110 line 177)
- Modify: `apps/api/src/routes/tunnelHttpRewrite.test.ts` (create if absent; colocated)

**Interfaces:**
- Consumes: `HOP_BY_HOP`, `collectForwardableHeaders` (Task 2), `TunnelCookieContext` (Task 1), `rewriteTunnelUrl`.
- Produces:
  ```ts
  export const TUNNEL_FRAME_COOKIE = '__Host-bzt';
  export const TUNNEL_TAB_COOKIE = '__Host-bzt-top';
  export const RESERVED_PROXY_COOKIE_NAMES: ReadonlySet<string>; // lowercase
  export function rewriteHostModeDeviceCookie(setCookie: string, context: TunnelCookieContext): string | null;
  export function stripProxyCookies(cookieHeader: string): string;
  export function buildHostModeUpstreamHeaders(reqHeaders: Record<string, string>, opts: { tunnelOrigin: string; targetOrigin: string }): Record<string, string[]>;
  export function hostModeCsp(frameAncestor: string | null): string;
  export function applyHostModeBaseHeaders(headers: Headers, frameAncestor: string | null): void;
  export function buildHostModeResponseHeaders(upstream: Record<string, string[]>, opts: { context: TunnelCookieContext; targetOrigin: string; frameAncestor: string }): { headers: Headers; contentType: string };
  // tunnelHttpRewrite.ts
  export function rewriteTunnelHtml(html: string, options: TunnelRewriteOptions, behavior?: { injectBase?: boolean }): string;
  ```

- [ ] **Step 1: Write the failing tests**:

```ts
// apps/api/src/routes/tunnelHostHeaders.test.ts
import { describe, expect, it } from 'vitest';
import {
  applyHostModeBaseHeaders,
  buildHostModeResponseHeaders,
  buildHostModeUpstreamHeaders,
  rewriteHostModeDeviceCookie,
  stripProxyCookies,
} from './tunnelHostHeaders';
import { rewriteTunnelHtml } from './tunnelHttpRewrite';

const TUNNEL_ORIGIN = 'https://eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.us.breezetunnel.test';
const TARGET = 'http://192.168.1.50:80';
const ANCESTOR = 'https://us.breeze-app.test';

describe('device Set-Cookie (spec §5)', () => {
  it('strips Domain and forces Secure; SameSite=None; Partitioned in the iframe context, keeping name/value/Path', () => {
    expect(rewriteHostModeDeviceCookie('SID=abc; Domain=192.168.1.50; Path=/cgi; SameSite=Strict; HttpOnly', 'frame'))
      .toBe('SID=abc; Path=/cgi; HttpOnly; Secure; SameSite=None; Partitioned');
  });

  it('forces Secure; SameSite=Lax, unpartitioned, in the new-tab context', () => {
    expect(rewriteHostModeDeviceCookie('SID=abc; Partitioned; Secure; SameSite=None', 'tab'))
      .toBe('SID=abc; Secure; SameSite=Lax');
  });

  it('drops the reserved proxy cookie names (any case) but passes other __Host- cookies', () => {
    expect(rewriteHostModeDeviceCookie('__Host-bzt=evil; Path=/', 'frame')).toBeNull();
    expect(rewriteHostModeDeviceCookie('__HOST-BZT-TOP=evil; Path=/', 'tab')).toBeNull();
    expect(rewriteHostModeDeviceCookie('__Host-dev=1; Path=/; Secure', 'frame'))
      .toBe('__Host-dev=1; Path=/; Secure; SameSite=None; Partitioned');
    expect(rewriteHostModeDeviceCookie('garbage-without-equals', 'frame')).toBeNull();
  });
});

describe('upstream request headers', () => {
  it('strips proxy cookies, keeps device cookies, never forwards credentials or Referer', () => {
    expect(stripProxyCookies('__Host-bzt=x; SID=1; __Host-bzt-top=y; __Host-dev=2')).toBe('SID=1; __Host-dev=2');
    const headers = buildHostModeUpstreamHeaders(
      { accept: '*/*', cookie: '__Host-bzt=x; SID=1', authorization: 'Bearer t', referer: `${TUNNEL_ORIGIN}/a` },
      { tunnelOrigin: TUNNEL_ORIGIN, targetOrigin: TARGET },
    );
    expect(headers).toEqual({ accept: ['*/*'], cookie: ['SID=1'] });
  });

  it('rewrites a same-tunnel Origin to the device origin (default port elided) and drops any other Origin', () => {
    expect(buildHostModeUpstreamHeaders({ origin: TUNNEL_ORIGIN }, { tunnelOrigin: TUNNEL_ORIGIN, targetOrigin: TARGET }).origin)
      .toEqual(['http://192.168.1.50']);
    expect(buildHostModeUpstreamHeaders({ origin: ANCESTOR }, { tunnelOrigin: TUNNEL_ORIGIN, targetOrigin: TARGET }).origin)
      .toBeUndefined();
  });
});

describe('response headers (spec §6)', () => {
  it('applies the host-mode security headers and strips device CORS/CSP/XFO/cache headers', () => {
    const { headers, contentType } = buildHostModeResponseHeaders({
      'Content-Type': ['text/html'],
      'Access-Control-Allow-Origin': ['*'],
      'Content-Security-Policy': ["default-src 'self'"],
      'X-Frame-Options': ['DENY'],
      'Cache-Control': ['public, max-age=3600'],
      'Service-Worker-Allowed': ['/'],
      'Transfer-Encoding': ['chunked'],
      'X-Device': ['kept'],
    }, { context: 'frame', targetOrigin: TARGET, frameAncestor: ANCESTOR });
    expect(contentType).toBe('text/html');
    expect(headers.get('content-security-policy')).toBe(`frame-ancestors ${ANCESTOR} 'self'`);
    expect(headers.get('cache-control')).toBe('no-store');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('referrer-policy')).toBe('no-referrer');
    expect(headers.get('access-control-allow-origin')).toBeNull();
    expect(headers.get('x-frame-options')).toBeNull();
    expect(headers.get('service-worker-allowed')).toBeNull();
    expect(headers.get('transfer-encoding')).toBeNull();
    expect(headers.get('x-device')).toBe('kept');
  });

  it('maps only device-origin absolute Locations; relative and foreign Locations pass through', () => {
    const loc = (l: string) => buildHostModeResponseHeaders({ Location: [l] }, { context: 'frame', targetOrigin: TARGET, frameAncestor: ANCESTOR }).headers.get('location');
    expect(loc('http://192.168.1.50/login?x=1')).toBe('/login?x=1');
    expect(loc('/home')).toBe('/home');
    expect(loc('next.html')).toBe('next.html');
    expect(loc('https://vendor.example/help')).toBe('https://vendor.example/help');
  });

  it('base headers never overwrite a CSP the handler already set, and fail closed without config', () => {
    const h = new Headers({ 'content-security-policy': "default-src 'none'" });
    applyHostModeBaseHeaders(h, ANCESTOR);
    expect(h.get('content-security-policy')).toBe("default-src 'none'");
    const empty = new Headers();
    applyHostModeBaseHeaders(empty, null);
    expect(empty.get('content-security-policy')).toBe("frame-ancestors 'none'");
  });
});

describe('rewriteTunnelHtml host mode', () => {
  it('injects no <base> and maps only absolute device URLs', () => {
    const out = rewriteTunnelHtml(
      '<html><head></head><body><a href="rel/x">r</a><img src="/root.png"><a href="http://192.168.1.50/abs">a</a></body></html>',
      { basePath: '/', targetOrigin: TARGET },
      { injectBase: false },
    );
    expect(out).not.toContain('<base');
    expect(out).toContain('href="rel/x"');
    expect(out).toContain('src="/root.png"');
    expect(out).toContain('href="/abs"');
  });
});
```

- [ ] **Step 2: Run to verify it fails**
  Run: `cd apps/api && npx vitest run src/routes/tunnelHostHeaders.test.ts`
  Expected: FAIL, "Failed to resolve import ./tunnelHostHeaders".
- [ ] **Step 3: Implement**:

```ts
// apps/api/src/routes/tunnelHostHeaders.ts
/**
 * Host-mode request/response header rules (spec 2026-10-06 §5–§6). Pure.
 * The device owns the whole tunnel origin, so its cookies keep their names;
 * only the proxy's own two cookie names are reserved.
 */
import type { TunnelCookieContext } from '../config/tunnelOrigin';
import { HOP_BY_HOP, collectForwardableHeaders } from './tunnelHttpCore';
import { rewriteTunnelUrl } from './tunnelHttpRewrite';

export const TUNNEL_FRAME_COOKIE = '__Host-bzt';
export const TUNNEL_TAB_COOKIE = '__Host-bzt-top';
export const RESERVED_PROXY_COOKIE_NAMES: ReadonlySet<string> = new Set([
  TUNNEL_FRAME_COOKIE.toLowerCase(), TUNNEL_TAB_COOKIE.toLowerCase(),
]);

export function rewriteHostModeDeviceCookie(setCookie: string, context: TunnelCookieContext): string | null {
  const parts = setCookie.split(';');
  const pair = parts[0]?.trim() ?? '';
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  if (RESERVED_PROXY_COOKIE_NAMES.has(pair.slice(0, eq).trim().toLowerCase())) return null;
  const kept = parts.slice(1).map((p) => p.trim())
    .filter((p) => p.length > 0 && !/^(domain|samesite|secure|partitioned)(\s*=|$)/i.test(p));
  const forced = context === 'tab' ? ['Secure', 'SameSite=Lax'] : ['Secure', 'SameSite=None', 'Partitioned'];
  return [pair, ...kept, ...forced].join('; ');
}

export function stripProxyCookies(cookieHeader: string): string {
  return cookieHeader.split(';').map((s) => s.trim()).filter((s) => {
    if (!s) return false;
    const eq = s.indexOf('=');
    const name = (eq === -1 ? s : s.slice(0, eq)).trim().toLowerCase();
    return !RESERVED_PROXY_COOKIE_NAMES.has(name);
  }).join('; ');
}

export function buildHostModeUpstreamHeaders(
  reqHeaders: Record<string, string>,
  opts: { tunnelOrigin: string; targetOrigin: string },
): Record<string, string[]> {
  const headers = collectForwardableHeaders(reqHeaders);
  const cookies = stripProxyCookies(reqHeaders['cookie'] ?? '');
  if (cookies) headers['cookie'] = [cookies];
  // Only an admitted, same-tunnel Origin is forwarded — rewritten to the
  // device's own origin so device CSRF checks pass. Never the app origin.
  if (reqHeaders['origin'] === opts.tunnelOrigin) headers['origin'] = [new URL(opts.targetOrigin).origin];
  return headers;
}

export function hostModeCsp(frameAncestor: string | null): string {
  return frameAncestor ? `frame-ancestors ${frameAncestor} 'self'` : "frame-ancestors 'none'";
}

/** Applied to EVERY tunnel-host response (including errors). Keeps a handler-set CSP. */
export function applyHostModeBaseHeaders(headers: Headers, frameAncestor: string | null): void {
  if (!headers.has('content-security-policy')) headers.set('content-security-policy', hostModeCsp(frameAncestor));
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
}

const DROPPED_RESPONSE_HEADERS = new Set([
  'content-length', 'content-security-policy', 'content-security-policy-report-only', 'x-frame-options',
  'cache-control', 'referrer-policy', 'x-content-type-options', 'service-worker-allowed',
]);

export function buildHostModeResponseHeaders(
  upstream: Record<string, string[]>,
  opts: { context: TunnelCookieContext; targetOrigin: string; frameAncestor: string },
): { headers: Headers; contentType: string } {
  const headers = new Headers();
  let contentType = '';
  for (const [k, values] of Object.entries(upstream)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || lk.startsWith('access-control-') || DROPPED_RESPONSE_HEADERS.has(lk)) continue;
    if (lk === 'content-type') {
      contentType = values[0] ?? '';
      if (contentType) headers.set('content-type', contentType);
      continue;
    }
    if (lk === 'location') {
      if (values[0]) headers.set('location', rewriteTunnelUrl(values[0], { basePath: '/', targetOrigin: opts.targetOrigin }));
      continue;
    }
    if (lk === 'set-cookie') {
      for (const v of values) {
        const rewritten = rewriteHostModeDeviceCookie(v, opts.context);
        if (rewritten) headers.append('set-cookie', rewritten);
      }
      continue;
    }
    for (const v of values) headers.append(k, v);
  }
  headers.set('content-security-policy', hostModeCsp(opts.frameAncestor));
  applyHostModeBaseHeaders(headers, opts.frameAncestor);
  return { headers, contentType };
}
```

`apps/api/src/routes/tunnelHttpRewrite.ts`: change the signature and the injection line of `rewriteTunnelHtml`:

```ts
export function rewriteTunnelHtml(
  html: string,
  options: TunnelRewriteOptions,
  behavior: { injectBase?: boolean } = {},
): string {
  // Host mode (spec §5): the device owns the origin, so relative URLs already
  // resolve correctly and a <base href="/"> would BREAK them. Path mode keeps it.
  const injectBase = behavior.injectBase ?? true;
  const injection = (injectBase ? `<base href="${options.basePath}">` : '') + browserShim(options);
```

Leave the rest of the function unchanged. The existing `<base>`-stripping branch keeps removing device `<base>` tags in both modes, so in host mode a device `<base>` is removed too.

> Reviewer note: in host mode a device `<base href>` *is* legitimate. If the W04 lab finds a device that relies on its own `<base>`, change the strip to apply only when `injectBase` is true. The pinned test above does not cover that case, on purpose (YAGNI until observed).

- [ ] **Step 4: Run to verify it passes**
  Run: `cd apps/api && npx vitest run src/routes/tunnelHostHeaders.test.ts src/routes/tunnelHttp.test.ts`
  Expected: PASS (path mode still injects `<base>`).
- [ ] **Step 5: Commit**
  ```bash
  git add apps/api/src/routes/tunnelHostHeaders.ts apps/api/src/routes/tunnelHostHeaders.test.ts apps/api/src/routes/tunnelHttpRewrite.ts
  git commit -m "feat(network-proxy): host-mode header/cookie rules + injectBase option"
  ```

### Task 7: Request admission (§4a) + Service-Worker refusal (pure)

**Files:**
- Create: `apps/api/src/routes/tunnelHostAdmission.ts`, `apps/api/src/routes/tunnelHostAdmission.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TunnelAdmissionInput { method: string; path: string; secFetchSite?: string; secFetchDest?: string;
    origin?: string; serviceWorker?: string; tunnelOrigin: string }
  export type TunnelAdmissionResult = { ok: true } | { ok: false; status: 403 | 404;
    reason: 'service_worker' | 'cross_site' | 'foreign_origin' | 'missing_origin' | 'enter_not_navigation' };
  export function admitTunnelHostRequest(input: TunnelAdmissionInput): TunnelAdmissionResult;
  ```

- [ ] **Step 1: Write the failing tests**:

```ts
// apps/api/src/routes/tunnelHostAdmission.test.ts
import { describe, expect, it } from 'vitest';
import { admitTunnelHostRequest, type TunnelAdmissionInput } from './tunnelHostAdmission';

const T = 'https://eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.us.breezetunnel.test';
const SIBLING = 'https://ffffffff-ffff-4fff-8fff-ffffffffffff.us.breezetunnel.test';
const base: TunnelAdmissionInput = { method: 'GET', path: '/', tunnelOrigin: T };
const admit = (over: Partial<TunnelAdmissionInput>) => admitTunnelHostRequest({ ...base, ...over });

describe('admitTunnelHostRequest (spec §4a)', () => {
  it.each(['same-origin', 'none'])('admits Sec-Fetch-Site %s', (site) => {
    expect(admit({ secFetchSite: site })).toEqual({ ok: true });
  });

  it.each(['same-site', 'cross-site'])('refuses Sec-Fetch-Site %s — GET included', (site) => {
    expect(admit({ secFetchSite: site })).toMatchObject({ ok: false, status: 403, reason: 'cross_site' });
    expect(admit({ secFetchSite: site, method: 'POST', origin: T })).toMatchObject({ ok: false, reason: 'cross_site' });
  });

  it('admits the app’s cross-site iframe/top-level navigation to /__bz/enter only', () => {
    expect(admit({ path: '/__bz/enter', secFetchSite: 'cross-site', secFetchDest: 'iframe' })).toEqual({ ok: true });
    expect(admit({ path: '/__bz/enter', secFetchSite: 'cross-site', secFetchDest: 'document' })).toEqual({ ok: true });
    expect(admit({ path: '/__bz/enter', secFetchSite: 'cross-site', secFetchDest: 'image' })).toMatchObject({ ok: false, reason: 'enter_not_navigation' });
    expect(admit({ path: '/__bz/enter', method: 'POST', secFetchSite: 'cross-site' })).toMatchObject({ ok: false, reason: 'enter_not_navigation' });
    expect(admit({ path: '/__bz/ping', secFetchSite: 'cross-site' })).toMatchObject({ ok: false, reason: 'cross_site' });
  });

  describe('Sec-Fetch-Site absent (older browsers)', () => {
    it('requires a matching Origin on unsafe methods', () => {
      expect(admit({ method: 'POST', origin: T })).toEqual({ ok: true });
      expect(admit({ method: 'POST' })).toMatchObject({ ok: false, reason: 'missing_origin' });
      expect(admit({ method: 'DELETE', origin: 'null' })).toMatchObject({ ok: false, reason: 'foreign_origin' });
      expect(admit({ method: 'POST', origin: SIBLING })).toMatchObject({ ok: false, reason: 'foreign_origin' });
    });

    it('admits a plain GET but refuses a GET carrying a foreign Origin', () => {
      expect(admit({})).toEqual({ ok: true });
      expect(admit({ origin: SIBLING })).toMatchObject({ ok: false, reason: 'foreign_origin' });
    });
  });

  it('refuses a foreign Origin even when Sec-Fetch-Site claims same-origin', () => {
    expect(admit({ secFetchSite: 'same-origin', method: 'POST', origin: SIBLING })).toMatchObject({ ok: false, reason: 'foreign_origin' });
  });

  it('404s service-worker script fetches before anything else', () => {
    expect(admit({ serviceWorker: 'script', secFetchSite: 'same-origin' })).toEqual({ ok: false, status: 404, reason: 'service_worker' });
    expect(admit({ secFetchDest: 'serviceworker', secFetchSite: 'same-origin' })).toEqual({ ok: false, status: 404, reason: 'service_worker' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**
  Run: `cd apps/api && npx vitest run src/routes/tunnelHostAdmission.test.ts`
  Expected: FAIL (module missing).
- [ ] **Step 3: Implement**:

```ts
// apps/api/src/routes/tunnelHostAdmission.ts
/**
 * Cross-tunnel request admission (spec 2026-10-06 §4a), enforced before any
 * auth, gate or dispatch. All tunnel iframes share the app's cookie partition
 * (and sibling tunnel hosts are same-site until PSL inclusion), so a page on
 * tunnel A can send a request to tunnel B that carries B's partitioned cookie.
 * Rules apply to GET too: device GETs often have side effects.
 */
export interface TunnelAdmissionInput {
  method: string;
  path: string;
  secFetchSite?: string;
  secFetchDest?: string;
  origin?: string;
  serviceWorker?: string;
  tunnelOrigin: string;
}

export type TunnelAdmissionResult =
  | { ok: true }
  | { ok: false; status: 403 | 404; reason: 'service_worker' | 'cross_site' | 'foreign_origin' | 'missing_origin' | 'enter_not_navigation' };

const SAFE_METHODS = new Set(['GET', 'HEAD']);
const norm = (v: string | undefined) => v?.trim().toLowerCase();

export function admitTunnelHostRequest(input: TunnelAdmissionInput): TunnelAdmissionResult {
  // A device-registered service worker would persist on the tunnel origin and
  // intercept later sessions (spec §6).
  if (norm(input.serviceWorker) === 'script' || norm(input.secFetchDest) === 'serviceworker') {
    return { ok: false, status: 404, reason: 'service_worker' };
  }
  const method = input.method.toUpperCase();

  // The one cross-site entry point: the app's iframe / new-tab navigation,
  // protected by the one-time ticket.
  if (input.path === '/__bz/enter') {
    const dest = norm(input.secFetchDest);
    if (method !== 'GET' || (dest !== undefined && dest !== 'iframe' && dest !== 'document')) {
      return { ok: false, status: 403, reason: 'enter_not_navigation' };
    }
    return { ok: true };
  }

  if (input.origin !== undefined && input.origin !== input.tunnelOrigin) {
    return { ok: false, status: 403, reason: 'foreign_origin' };
  }
  const site = norm(input.secFetchSite);
  if (site !== undefined) {
    return site === 'same-origin' || site === 'none' ? { ok: true } : { ok: false, status: 403, reason: 'cross_site' };
  }
  if (!SAFE_METHODS.has(method) && input.origin === undefined) {
    return { ok: false, status: 403, reason: 'missing_origin' };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run to verify it passes**
  Run: `cd apps/api && npx vitest run src/routes/tunnelHostAdmission.test.ts`
  Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add apps/api/src/routes/tunnelHostAdmission.ts apps/api/src/routes/tunnelHostAdmission.test.ts
  git commit -m "feat(network-proxy): host-mode request admission (Sec-Fetch-Site/Origin) + SW refusal"
  ```

### Task 8: `tunnelHostRoutes` — `/__bz/enter`, `/__bz/ping` and the proxied request

**Files:**
- Modify: `apps/api/src/routes/tunnelHost.ts` (replace the Task 5 scaffold)
- Create: `apps/api/src/routes/tunnelHost.test.ts`

**Interfaces:**
- Consumes: Task 1 (`getTunnelOriginConfig`, `matchTunnelHost`, `buildTunnelOrigin`), Task 2/3 core, Task 6 headers, Task 7 admission.
- Produces: `tunnelHostRoutes` (a Hono app), plus the exported `TUNNEL_COOKIE_BLOCKED_MESSAGE_TYPE = 'breeze-tunnel-cookie-blocked'`, which W03 Task 13 consumes.

- [ ] **Step 1: Write the failing tests** (mock pattern copied from `tunnelHttp.test.ts`):

```ts
// apps/api/src/routes/tunnelHost.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const TUNNEL_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER_TUNNEL = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const DEVICE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER_ID = 'uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu';
const AGENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOST = `${TUNNEL_ID}.us.breezetunnel.test`;
const ORIGIN = `https://${HOST}`;
const ANCESTOR = 'https://us.breeze-app.test';

let joinRow: any;
let activationRows: Array<{ id: string }> = [{ id: TUNNEL_ID }];
let capturedUpdates: Record<string, unknown>[] = [];

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ innerJoin: vi.fn(() => ({ where: vi.fn(() => ({
      limit: vi.fn(async () => (joinRow ? [joinRow] : [])),
    })) })) })) })),
    update: vi.fn(() => ({ set: vi.fn((v: Record<string, unknown>) => {
      capturedUpdates.push(v);
      return { where: vi.fn(() => Object.assign(Promise.resolve(undefined), { returning: vi.fn(async () => activationRows) })) };
    }) })),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
}));
vi.mock('../db/schema', () => ({
  tunnelSessions: { id: 'tunnelSessions.id', deviceId: 'tunnelSessions.deviceId', status: 'tunnelSessions.status' },
  devices: { id: 'devices.id' },
}));
const { consumeWsTicketMock } = vi.hoisted(() => ({ consumeWsTicketMock: vi.fn() }));
vi.mock('../services/remoteSessionAuth', () => ({ consumeWsTicket: consumeWsTicketMock }));
vi.mock('./agentWs', () => ({ isAgentConnected: vi.fn(() => true) }));
const { sendCommandMock } = vi.hoisted(() => ({ sendCommandMock: vi.fn() }));
vi.mock('../services/agentCommandAwait', () => ({ sendCommandToAgentAwaitResult: sendCommandMock }));
vi.mock('../services/remoteAccessPolicy', () => ({ checkRemoteAccess: vi.fn(async () => ({ allowed: true })) }));
const { authorizeContinuationMock } = vi.hoisted(() => ({ authorizeContinuationMock: vi.fn() }));
vi.mock('../services/remoteWsAuthorization', () => ({ authorizeRemoteSessionContinuation: authorizeContinuationMock }));
vi.mock('../services/clientIp', () => ({ getTrustedClientIp: vi.fn(() => '203.0.113.7'), trustsForwardedHeadersFrom: vi.fn(() => false) }));
vi.mock('../services/tunnelAllowlist', () => ({ getActiveAllowlistPatterns: vi.fn(async () => ['192.168.1.0/24']) }));

import { tunnelHostRoutes } from './tunnelHost';
import { __resetTunnelOriginConfigForTests } from '../config/tunnelOrigin';

function row(status = 'active') {
  return {
    session: { userId: USER_ID, status, orgId: ORG_ID, type: 'proxy', targetHost: '192.168.1.50', targetPort: 80,
      scheme: 'http', skipTlsVerify: false, createdAt: new Date(), startedAt: null, lastActivityAt: null },
    device: { id: DEVICE_ID, siteId: null, status: 'online', agentId: AGENT_ID },
  };
}
function agentOk(over: Partial<{ status: number; headers: Record<string, string[]>; body: string }> = {}) {
  return { status: 'completed', stdout: JSON.stringify({
    status: over.status ?? 200, headers: over.headers ?? { 'content-type': ['text/plain'] },
    bodyB64: Buffer.from(over.body ?? 'device-ok').toString('base64'),
  }) };
}
const req = (path: string, init: RequestInit & { host?: string } = {}) => {
  const headers = new Headers(init.headers);
  headers.set('host', init.host ?? HOST);
  return tunnelHostRoutes.request(`http://${init.host ?? HOST}${path}`, { ...init, headers });
};
async function enter(context: 'frame' | 'tab' = 'frame'): Promise<string> {
  consumeWsTicketMock.mockResolvedValueOnce({ ok: true, sessionId: TUNNEL_ID, sessionType: 'tunnel-http', userId: USER_ID, expiresAt: Date.now() + 60_000 });
  const res = await req(`/__bz/enter?t=TKT${context === 'tab' ? '&mode=tab' : ''}`, { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': context === 'tab' ? 'document' : 'iframe' } });
  expect(res.status).toBe(200);
  const cookie = res.headers.get('set-cookie') ?? '';
  const m = cookie.match(/(__Host-bzt(?:-top)?=[^;]+)/);
  if (!m) throw new Error(`no proxy cookie in ${cookie}`);
  return m[1]!;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TUNNEL_ORIGIN_TEMPLATE = 'https://{id}.us.breezetunnel.test';
  process.env.TUNNEL_FRAME_ANCESTOR = ANCESTOR;
  __resetTunnelOriginConfigForTests();
  joinRow = row();
  activationRows = [{ id: TUNNEL_ID }];
  capturedUpdates = [];
  authorizeContinuationMock.mockResolvedValue({ ok: true, context: {} });
  sendCommandMock.mockResolvedValue(agentOk());
});
afterEach(() => {
  delete process.env.TUNNEL_ORIGIN_TEMPLATE;
  delete process.env.TUNNEL_FRAME_ANCESTOR;
  __resetTunnelOriginConfigForTests();
});

describe('/__bz/enter', () => {
  it('returns a bootstrap page (never a redirect) that sets a partitioned __Host-bzt cookie', async () => {
    consumeWsTicketMock.mockResolvedValueOnce({ ok: true, sessionId: TUNNEL_ID, sessionType: 'tunnel-http', userId: USER_ID, expiresAt: Date.now() + 60_000 });
    const res = await req('/__bz/enter?t=TKT', { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'iframe' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^__Host-bzt=/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=None/);
    expect(cookie).toMatch(/Partitioned/);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(res.headers.get('content-security-policy')).toMatch(new RegExp(`frame-ancestors ${ANCESTOR} 'self'`));
    expect(res.headers.get('content-security-policy')).toMatch(/script-src 'nonce-/);
    const html = await res.text();
    expect(html).toContain("fetch('/__bz/ping'");
    expect(html).toContain('breeze-tunnel-cookie-blocked');
    expect(capturedUpdates).toContainEqual(expect.objectContaining({ status: 'active' }));
  });

  it('sets an unpartitioned SameSite=Lax __Host-bzt-top for mode=tab', async () => {
    const cookie = await enter('tab');
    expect(cookie).toMatch(/^__Host-bzt-top=/);
  });

  it('refuses a ticket minted for another tunnel, a non-http ticket and a bad mode', async () => {
    consumeWsTicketMock.mockResolvedValueOnce({ ok: true, sessionId: OTHER_TUNNEL, sessionType: 'tunnel-http', userId: USER_ID, expiresAt: Date.now() + 60_000 });
    expect((await req('/__bz/enter?t=TKT')).status).toBe(401);
    consumeWsTicketMock.mockResolvedValueOnce({ ok: true, sessionId: TUNNEL_ID, sessionType: 'tunnel', userId: USER_ID, expiresAt: Date.now() + 60_000 });
    expect((await req('/__bz/enter?t=TKT')).status).toBe(401);
    expect((await req('/__bz/enter?t=TKT&mode=popup')).status).toBe(401);
  });

  it('does not reopen a closed session (exchange after or racing Close)', async () => {
    joinRow = row('disconnected');
    consumeWsTicketMock.mockResolvedValueOnce({ ok: true, sessionId: TUNNEL_ID, sessionType: 'tunnel-http', userId: USER_ID, expiresAt: Date.now() + 60_000 });
    const closed = await req('/__bz/enter?t=TKT');
    expect(closed.status).toBe(404);
    expect(closed.headers.get('set-cookie')).toBeNull();

    joinRow = row('active');
    activationRows = [];
    consumeWsTicketMock.mockResolvedValueOnce({ ok: true, sessionId: TUNNEL_ID, sessionType: 'tunnel-http', userId: USER_ID, expiresAt: Date.now() + 60_000 });
    const raced = await req('/__bz/enter?t=TKT');
    expect(raced.status).toBe(404);
    expect(raced.headers.get('set-cookie')).toBeNull();
  });

  it('fails closed on revoked live authority before minting a cookie', async () => {
    authorizeContinuationMock.mockResolvedValueOnce({ ok: false, status: 403, reason: 'permission_denied' });
    consumeWsTicketMock.mockResolvedValueOnce({ ok: true, sessionId: TUNNEL_ID, sessionType: 'tunnel-http', userId: USER_ID, expiresAt: Date.now() + 60_000 });
    const res = await req('/__bz/enter?t=TKT');
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('/__bz/ping and reserved paths', () => {
  it('204s with a valid cookie, 401s without', async () => {
    const cookie = await enter();
    expect((await req('/__bz/ping', { headers: { cookie, 'sec-fetch-site': 'same-origin' } })).status).toBe(204);
    expect((await req('/__bz/ping', { headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(401);
  });

  it('never forwards /__bz/* (plain or percent-encoded) to the device', async () => {
    const cookie = await enter();
    for (const p of ['/__bz/other', '/%5F%5Fbz/enter?t=x', '/%5f%5fBZ/x']) {
      const res = await req(p, { headers: { cookie, 'sec-fetch-site': 'same-origin' } });
      expect(res.status).toBe(404);
    }
    expect(sendCommandMock).not.toHaveBeenCalled();
  });
});

describe('proxied requests', () => {
  it('runs every gate, forwards the unmodified device path, and refreshes the cookie', async () => {
    const cookie = await enter();
    const res = await req('/cgi-bin/status.cgi?x=1', { headers: { cookie, 'sec-fetch-site': 'same-origin' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('device-ok');
    const payload = sendCommandMock.mock.calls[0]![1].payload;
    expect(payload.path).toBe('/cgi-bin/status.cgi?x=1');
    expect(payload.headers.cookie).toBeUndefined();
    expect(res.headers.get('set-cookie')).toMatch(/^__Host-bzt=/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(authorizeContinuationMock).toHaveBeenCalledWith(expect.objectContaining({ sessionId: TUNNEL_ID, userId: USER_ID }), expect.any(Array));
  });

  it('rejects a cookie minted for tunnel A on tunnel B’s host', async () => {
    const cookie = await enter();
    const res = await req('/', { host: `${OTHER_TUNNEL}.us.breezetunnel.test`, headers: { cookie, 'sec-fetch-site': 'same-origin' } });
    expect(res.status).toBe(401);
  });

  it('refuses a cross-tunnel request before auth or dispatch', async () => {
    const cookie = await enter();
    const res = await req('/reboot', { headers: { cookie, 'sec-fetch-site': 'same-site' } });
    expect(res.status).toBe(403);
    expect(sendCommandMock).not.toHaveBeenCalled();
  });

  it('404s a service-worker script fetch', async () => {
    const cookie = await enter();
    expect((await req('/sw.js', { headers: { cookie, 'sec-fetch-site': 'same-origin', 'service-worker': 'script' } })).status).toBe(404);
  });

  it('applies the 12h cap, device-offline and policy gates exactly like path mode', async () => {
    const cookie = await enter();
    joinRow = { ...row(), session: { ...row().session, createdAt: new Date(Date.now() - 13 * 3600_000) } };
    expect((await req('/', { headers: { cookie, 'sec-fetch-site': 'same-origin' } })).status).toBe(410);
    joinRow = { ...row(), device: { ...row().device, status: 'offline' } };
    expect((await req('/', { headers: { cookie, 'sec-fetch-site': 'same-origin' } })).status).toBe(502);
  });

  it('drops a device Set-Cookie for the reserved names and rewrites device cookies', async () => {
    const cookie = await enter();
    sendCommandMock.mockResolvedValueOnce(agentOk({ headers: { 'content-type': ['text/plain'], 'set-cookie': ['__Host-bzt=evil; Path=/', 'SID=1; Domain=192.168.1.50; Path=/'] } }));
    const res = await req('/', { headers: { cookie, 'sec-fetch-site': 'same-origin' } });
    const all = res.headers.getSetCookie();
    expect(all.some((c) => c.startsWith('__Host-bzt=evil'))).toBe(false);
    expect(all).toContain('SID=1; Path=/; Secure; SameSite=None; Partitioned');
  });

  it('rewrites only absolute device URLs in HTML and never injects <base>', async () => {
    const cookie = await enter();
    sendCommandMock.mockResolvedValueOnce(agentOk({
      headers: { 'content-type': ['text/html'] },
      body: '<html><head></head><body><a href="http://192.168.1.50/a">x</a><a href="b">y</a></body></html>',
    }));
    const html = await (await req('/', { headers: { cookie, 'sec-fetch-site': 'same-origin' } })).text();
    expect(html).toContain('href="/a"');
    expect(html).toContain('href="b"');
    expect(html).not.toContain('<base');
  });

  it('404s everything when host mode is off', async () => {
    delete process.env.TUNNEL_ORIGIN_TEMPLATE;
    __resetTunnelOriginConfigForTests();
    expect((await req('/__bz/enter?t=TKT')).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify it fails**
  Run: `cd apps/api && npx vitest run src/routes/tunnelHost.test.ts`
  Expected: FAIL (the scaffold 404s everything).
- [ ] **Step 3: Implement** (replace the whole of `tunnelHost.ts`):

```ts
// apps/api/src/routes/tunnelHost.ts
/**
 * Network Proxy host mode (spec 2026-10-06 §3–§6). Reached only through
 * tunnelHostDispatch for an asserted tunnel Host, so no app route, auth
 * middleware, CORS or app security header ever runs here. Every path-mode
 * gate runs via tunnelHttpCore; only auth, admission, rewriting and response
 * headers differ.
 */
import { Hono, type Context } from 'hono';
import { getCookie, generateCookie } from 'hono/cookie';
import { randomBytes } from 'node:crypto';
import { consumeWsTicket } from '../services/remoteSessionAuth';
import { getTrustedClientIp } from '../services/clientIp';
import {
  buildTunnelOrigin, getTunnelOriginConfig, matchTunnelHost, type TunnelCookieContext,
} from '../config/tunnelOrigin';
import {
  HOST_COOKIE_AUDIENCE, HTTP_TUNNEL_COOKIE_TTL_SECONDS, activateTunnelSessionOnExchange,
  authorizeTunnelContinuation, bumpTunnelActivity, decodeUpstreamBody, deviceTargetOrigin,
  dispatchTunnelHttpRequest, loadOwnedTunnelSession, runTunnelRequestGates, signTunnelCookie, verifyTunnelCookie,
} from './tunnelHttpCore';
import { admitTunnelHostRequest } from './tunnelHostAdmission';
import {
  TUNNEL_FRAME_COOKIE, TUNNEL_TAB_COOKIE, applyHostModeBaseHeaders, buildHostModeResponseHeaders,
  buildHostModeUpstreamHeaders, hostModeCsp,
} from './tunnelHostHeaders';
import { rewriteTunnelCss, rewriteTunnelHtml } from './tunnelHttpRewrite';

export const TUNNEL_COOKIE_BLOCKED_MESSAGE_TYPE = 'breeze-tunnel-cookie-blocked';
const ENTER_PATH = '/__bz/enter';
const PING_PATH = '/__bz/ping';

export const tunnelHostRoutes = new Hono();

// Every response — including 401/403/404/421/5xx — gets the host-mode
// security headers (a handler-set CSP, e.g. the enter page's nonce CSP, wins).
tunnelHostRoutes.use('*', async (c, next) => {
  await next();
  applyHostModeBaseHeaders(c.res.headers, getTunnelOriginConfig()?.frameAncestor ?? null);
});

function cookieName(context: TunnelCookieContext): string {
  return context === 'tab' ? TUNNEL_TAB_COOKIE : TUNNEL_FRAME_COOKIE;
}

async function proxyAuthCookie(userId: string, tunnelId: string, context: TunnelCookieContext): Promise<string> {
  const value = await signTunnelCookie(userId, tunnelId, { audience: HOST_COOKIE_AUDIENCE, context });
  // __Host-: no Domain, Path=/, Secure — a sibling tunnel host can neither set nor overwrite it.
  return context === 'tab'
    ? generateCookie(TUNNEL_TAB_COOKIE, value, { path: '/', secure: true, httpOnly: true, sameSite: 'Lax', maxAge: HTTP_TUNNEL_COOKIE_TTL_SECONDS })
    : generateCookie(TUNNEL_FRAME_COOKIE, value, { path: '/', secure: true, httpOnly: true, sameSite: 'None', partitioned: true, maxAge: HTTP_TUNNEL_COOKIE_TTL_SECONDS });
}

async function authenticate(c: Context, tunnelId: string): Promise<{ userId: string; context: TunnelCookieContext } | null> {
  for (const context of ['frame', 'tab'] as const) {
    const userId = await verifyTunnelCookie(getCookie(c, cookieName(context)), tunnelId, { audience: HOST_COOKIE_AUDIENCE, context });
    if (userId) return { userId, context };
  }
  return null;
}

function isReservedPath(rawPathname: string): boolean {
  let decoded = rawPathname;
  try {
    decoded = decodeURIComponent(rawPathname);
  } catch {
    return true; // undecodable → never forward
  }
  return decoded.toLowerCase().startsWith('/__bz/') || decoded.toLowerCase() === '/__bz';
}

/**
 * 200 bootstrap, NOT a 302 (plan G1): a redirect inherits the cross-site
 * taint of the app's iframe navigation, so §4a would refuse the device's `/`.
 * The page confirms the cookie stuck (CHIPS/3PC) via a same-origin ping, then
 * navigates same-origin; otherwise it tells the parent to offer a new tab.
 */
function enterPage(nonce: string, tunnelId: string, frameAncestor: string, context: TunnelCookieContext): string {
  const cfg = JSON.stringify({ tunnelId, ancestor: frameAncestor, framed: context === 'frame', type: TUNNEL_COOKIE_BLOCKED_MESSAGE_TYPE })
    .replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Connecting…</title></head>`
    + `<body><p id="m">Connecting…</p><script nonce="${nonce}">(function(){var c=${cfg};`
    + `function blocked(){document.getElementById('m').textContent='This browser blocked the proxy session. Open the device in a new tab from Breeze.';`
    + `if(c.framed&&window.parent!==window){try{window.parent.postMessage({type:c.type,tunnelId:c.tunnelId},c.ancestor);}catch(e){}}}`
    + `fetch('/__bz/ping',{credentials:'same-origin',cache:'no-store'}).then(function(r){if(r.status===204){location.replace('/');}else{blocked();}},blocked);`
    + `})();</script></body></html>`;
}

async function handleEnter(c: Context, tunnelId: string, frameAncestor: string): Promise<Response> {
  const ticket = c.req.query('t');
  const mode = c.req.query('mode');
  if (!ticket || (mode !== undefined && mode !== 'tab')) return c.text('Unauthorized', 401);
  const context: TunnelCookieContext = mode === 'tab' ? 'tab' : 'frame';

  const consumed = await consumeWsTicket(ticket, { ip: getTrustedClientIp(c), userAgent: c.req.header('user-agent') ?? '' });
  if (!consumed.ok || consumed.sessionId !== tunnelId || consumed.sessionType !== 'tunnel-http') {
    return c.text('Unauthorized', 401);
  }
  const liveAuthority = await authorizeTunnelContinuation(tunnelId, consumed.userId);
  if (!liveAuthority.ok) return c.text('Access denied', liveAuthority.status);
  const owned = await loadOwnedTunnelSession(tunnelId, consumed.userId);
  if (!owned) return c.text('Not found', 404);
  if (!(await activateTunnelSessionOnExchange(tunnelId, !owned.startedAt))) return c.text('Not found', 404);

  const nonce = randomBytes(16).toString('base64');
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; ${hostModeCsp(frameAncestor)}`,
  });
  headers.append('set-cookie', await proxyAuthCookie(consumed.userId, tunnelId, context));
  return new Response(enterPage(nonce, tunnelId, frameAncestor, context), { status: 200, headers });
}

tunnelHostRoutes.all('*', async (c) => {
  const config = getTunnelOriginConfig();
  if (!config) return c.text('Not found', 404);
  const tunnelId = matchTunnelHost(c.req.header('host'), config);
  if (!tunnelId) return c.text('Not found', 404);
  const tunnelOrigin = buildTunnelOrigin(config, tunnelId);
  const url = new URL(c.req.url);

  const admission = admitTunnelHostRequest({
    method: c.req.method, path: url.pathname, tunnelOrigin,
    secFetchSite: c.req.header('sec-fetch-site'), secFetchDest: c.req.header('sec-fetch-dest'),
    origin: c.req.header('origin'), serviceWorker: c.req.header('service-worker'),
  });
  if (!admission.ok) return c.text(admission.status === 404 ? 'Not found' : 'Cross-site request blocked', admission.status);

  if (url.pathname === ENTER_PATH) return handleEnter(c, tunnelId, config.frameAncestor);
  const auth = await authenticate(c, tunnelId);
  if (url.pathname === PING_PATH) return auth ? c.body(null, 204) : c.text('Unauthorized', 401);
  if (isReservedPath(url.pathname)) return c.text('Not found', 404);
  if (!auth) return c.text('Unauthorized', 401);

  const gate = await runTunnelRequestGates(tunnelId, auth.userId);
  if (!gate.ok) return c.text(gate.message, gate.status);
  const { session } = gate;
  await bumpTunnelActivity(tunnelId, session.lastActivityAt);

  const targetOrigin = deviceTargetOrigin(session);
  const method = c.req.method.toUpperCase();
  const bodyB64 = method === 'GET' || method === 'HEAD' ? '' : Buffer.from(await c.req.arrayBuffer()).toString('base64');
  const outcome = await dispatchTunnelHttpRequest(tunnelId, session, {
    method,
    path: url.pathname + url.search,
    headers: buildHostModeUpstreamHeaders(c.req.header(), { tunnelOrigin, targetOrigin }),
    bodyB64,
  });
  if (!outcome.ok) return c.text(outcome.message, outcome.status);

  const { upstream } = outcome;
  const { headers, contentType } = buildHostModeResponseHeaders(upstream.headers ?? {}, {
    context: auth.context, targetOrigin, frameAncestor: config.frameAncestor,
  });
  headers.append('set-cookie', await proxyAuthCookie(auth.userId, tunnelId, auth.context));

  let body: Buffer | string = Buffer.from(upstream.bodyB64 ?? '', 'base64');
  const lowered = contentType.toLowerCase();
  const isHtml = lowered.includes('text/html');
  if (isHtml || lowered.includes('text/css')) {
    const decoded = await decodeUpstreamBody(body, headers.get('content-encoding'));
    if (!decoded.ok) return c.text('Malformed upstream content encoding', 502);
    if (decoded.decoded) {
      const options = { basePath: '/', targetOrigin };
      body = isHtml
        ? rewriteTunnelHtml(decoded.body.toString('utf8'), options, { injectBase: false })
        : rewriteTunnelCss(decoded.body.toString('utf8'), options);
      headers.delete('content-encoding');
      headers.set('content-length', String(Buffer.byteLength(body)));
    }
  }
  return new Response(typeof body === 'string' ? body : new Uint8Array(body), { status: upstream.status, headers });
});
```

- [ ] **Step 4: Run to verify it passes**
  Run: `cd apps/api && npx vitest run src/routes/tunnelHost.test.ts src/middleware/tunnelHostDispatch.test.ts src/routes/tunnelHttp.test.ts`
  Expected: PASS. If `res.headers.getSetCookie` is missing in the test runtime, use `res.headers.get('set-cookie')!.split(/, (?=[^;]+=)/)`.
- [ ] **Step 5: Typecheck and commit**
  ```bash
  cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"
  git add apps/api/src/routes/tunnelHost.ts apps/api/src/routes/tunnelHost.test.ts
  git commit -m "feat(network-proxy): tunnelHostRoutes — /__bz/enter bootstrap, ping, proxied requests"
  ```

### Task 9: Rate/concurrency budgets, metrics, log redaction

**Files:**
- Create: `apps/api/src/services/tunnelHttpBudget.ts`, `apps/api/src/services/tunnelHttpBudget.test.ts`
- Create: `apps/api/src/services/tunnelHttpMetrics.ts`
- Modify: `apps/api/src/routes/tunnelHost.ts`, `apps/api/src/routes/tunnelHttp.ts` (metrics only), `apps/api/src/middleware/tunnelHostDispatch.ts` (metric on reject)
- Modify: `apps/api/src/routes/tunnelHost.test.ts`
- Create: `apps/api/src/middleware/tunnelHostLogRedaction.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const TUNNEL_HTTP_RATE_LIMITS: { readonly user: 1200; readonly tunnel: 900; readonly agent: 2400; readonly windowSeconds: 60 };
  export const TUNNEL_HTTP_CONCURRENCY_LIMITS: { readonly user: 24; readonly tunnel: 12; readonly agent: 32 };
  export type TunnelBudgetScope = 'user' | 'tunnel' | 'agent';
  export interface TunnelBudgetKeys { userId: string; tunnelId: string; agentId: string }
  export function checkTunnelHttpRate(keys: TunnelBudgetKeys): Promise<{ ok: true } | { ok: false; scope: TunnelBudgetScope; retryAfterSeconds: number }>;
  export function acquireTunnelHttpSlot(keys: TunnelBudgetKeys): { ok: true; release: () => void } | { ok: false; scope: TunnelBudgetScope };
  export function __resetTunnelHttpBudgetForTests(): void;
  // tunnelHttpMetrics.ts
  export type TunnelHttpMode = 'path' | 'host';
  export type TunnelHttpOutcome = 'proxied' | 'auth_failed' | 'admission_refused' | 'gate_denied' | 'rate_limited' | 'dispatch_failed' | 'host_rejected';
  export function recordTunnelHttpOutcome(mode: TunnelHttpMode, outcome: TunnelHttpOutcome): void;
  ```

- [ ] **Step 1: Write the failing tests**:

```ts
// apps/api/src/services/tunnelHttpBudget.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rateLimiterMock } = vi.hoisted(() => ({ rateLimiterMock: vi.fn() }));
vi.mock('./rate-limit', () => ({ rateLimiter: rateLimiterMock }));
vi.mock('./redis', () => ({ getRedis: vi.fn(() => ({})) }));

import {
  TUNNEL_HTTP_CONCURRENCY_LIMITS, __resetTunnelHttpBudgetForTests, acquireTunnelHttpSlot, checkTunnelHttpRate,
} from './tunnelHttpBudget';

const keys = { userId: 'u1', tunnelId: 't1', agentId: 'a1' };

beforeEach(() => {
  __resetTunnelHttpBudgetForTests();
  rateLimiterMock.mockReset();
  rateLimiterMock.mockResolvedValue({ allowed: true, remaining: 1, resetAt: new Date(Date.now() + 60_000) });
});

describe('tunnel http budgets', () => {
  it('checks tunnel, user and agent rate buckets and reports the first exhausted scope', async () => {
    expect(await checkTunnelHttpRate(keys)).toEqual({ ok: true });
    expect(rateLimiterMock.mock.calls.map((c) => c[1])).toEqual([
      'tunnel-http:rate:tunnel:t1', 'tunnel-http:rate:user:u1', 'tunnel-http:rate:agent:a1',
    ]);
    rateLimiterMock.mockResolvedValueOnce({ allowed: true, remaining: 1, resetAt: new Date() })
      .mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + 30_000) });
    expect(await checkTunnelHttpRate(keys)).toMatchObject({ ok: false, scope: 'user' });
  });

  it('caps in-flight requests per tunnel and frees the slot on release (idempotently)', () => {
    const slots = Array.from({ length: TUNNEL_HTTP_CONCURRENCY_LIMITS.tunnel }, () => acquireTunnelHttpSlot(keys));
    expect(slots.every((s) => s.ok)).toBe(true);
    expect(acquireTunnelHttpSlot(keys)).toEqual({ ok: false, scope: 'tunnel' });
    const first = slots[0]!;
    if (first.ok) { first.release(); first.release(); }
    expect(acquireTunnelHttpSlot(keys).ok).toBe(true);
    expect(acquireTunnelHttpSlot(keys)).toEqual({ ok: false, scope: 'tunnel' });
  });
});
```

Append to `apps/api/src/routes/tunnelHost.test.ts` (add the mocks at the top with the others):

```ts
const { rateMock, slotMock } = vi.hoisted(() => ({
  rateMock: vi.fn(async () => ({ ok: true })),
  slotMock: vi.fn(() => ({ ok: true, release: vi.fn() })),
}));
vi.mock('../services/tunnelHttpBudget', () => ({ checkTunnelHttpRate: rateMock, acquireTunnelHttpSlot: slotMock }));
const { metricMock } = vi.hoisted(() => ({ metricMock: vi.fn() }));
vi.mock('../services/tunnelHttpMetrics', () => ({ recordTunnelHttpOutcome: metricMock }));

describe('budgets and metrics', () => {
  it('429s with Retry-After when a rate budget is exhausted, before dispatch', async () => {
    const cookie = await enter();
    rateMock.mockResolvedValueOnce({ ok: false, scope: 'tunnel', retryAfterSeconds: 17 } as never);
    const res = await req('/', { headers: { cookie, 'sec-fetch-site': 'same-origin' } });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('17');
    expect(sendCommandMock).not.toHaveBeenCalled();
    expect(metricMock).toHaveBeenCalledWith('host', 'rate_limited');
  });

  it('429s when the concurrency budget is full and releases the slot after dispatch', async () => {
    const cookie = await enter();
    slotMock.mockReturnValueOnce({ ok: false, scope: 'agent' } as never);
    expect((await req('/', { headers: { cookie, 'sec-fetch-site': 'same-origin' } })).status).toBe(429);
    const release = vi.fn();
    slotMock.mockReturnValueOnce({ ok: true, release } as never);
    await req('/', { headers: { cookie, 'sec-fetch-site': 'same-origin' } });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('counts admission refusals, auth failures and successes by mode', async () => {
    await req('/', { headers: { 'sec-fetch-site': 'cross-site' } });
    await req('/', { headers: { 'sec-fetch-site': 'same-origin' } });
    const cookie = await enter();
    await req('/', { headers: { cookie, 'sec-fetch-site': 'same-origin' } });
    expect(metricMock).toHaveBeenCalledWith('host', 'admission_refused');
    expect(metricMock).toHaveBeenCalledWith('host', 'auth_failed');
    expect(metricMock).toHaveBeenCalledWith('host', 'proxied');
  });
});
```

```ts
// apps/api/src/middleware/tunnelHostLogRedaction.test.ts
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { parseTunnelOriginConfig } from '../config/tunnelOrigin';
import { requestPathLogger } from './requestPathLogger';
import { tunnelHostClassifier, tunnelHostDispatch } from './tunnelHostDispatch';

describe('tunnel host request logging', () => {
  it('never logs the ticket, cookies or the device path', async () => {
    const parsed = parseTunnelOriginConfig({ NODE_ENV: 'production', PUBLIC_APP_URL: 'https://us.breeze-app.test', TUNNEL_ORIGIN_TEMPLATE: 'https://{id}.us.breezetunnel.test' });
    if (!parsed.ok || !parsed.config) throw new Error('bad fixture');
    const lines: string[] = [];
    const tunnelApp = new Hono();
    tunnelApp.all('*', (c) => c.text('x', 401));
    const app = new Hono();
    app.use('*', requestPathLogger((m) => lines.push(m)));
    app.use('*', tunnelHostClassifier(() => parsed.config));
    app.use('*', tunnelHostDispatch(tunnelApp));
    await app.request('/__bz/enter?t=SECRET-TICKET-123', {
      headers: { host: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.us.breezetunnel.test', 'x-breeze-tunnel-site': '1', cookie: '__Host-bzt=SECRET-COOKIE' },
    });
    const joined = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(joined).not.toContain('SECRET-TICKET-123');
    expect(joined).not.toContain('SECRET-COOKIE');
    expect(joined).not.toContain('__bz/enter');
  });
});
```

- [ ] **Step 2: Run to verify they fail**
  Run: `cd apps/api && npx vitest run src/services/tunnelHttpBudget.test.ts src/routes/tunnelHost.test.ts src/middleware/tunnelHostLogRedaction.test.ts`
  Expected: the budget and metric tests FAIL (modules missing, 200 instead of 429). The log-redaction test may already PASS, because `requestPathLogger` logs only the matched route label. Keep it as a regression pin.
- [ ] **Step 3: Implement**:

```ts
// apps/api/src/services/tunnelHttpBudget.ts
/**
 * Network Proxy request budgets (spec 2026-10-06 §9): per-user, per-tunnel and
 * per-agent rate (Redis sliding window via rateLimiter — fails closed without
 * Redis, like ticket storage) and in-flight concurrency (process-local, like
 * the agentCommandAwait correlation map it protects).
 */
import { getRedis } from './redis';
import { rateLimiter } from './rate-limit';

export const TUNNEL_HTTP_RATE_LIMITS = { user: 1200, tunnel: 900, agent: 2400, windowSeconds: 60 } as const;
export const TUNNEL_HTTP_CONCURRENCY_LIMITS = { user: 24, tunnel: 12, agent: 32 } as const;
export type TunnelBudgetScope = 'user' | 'tunnel' | 'agent';
export interface TunnelBudgetKeys { userId: string; tunnelId: string; agentId: string }

const SCOPES: readonly TunnelBudgetScope[] = ['tunnel', 'user', 'agent'];
const idFor = (keys: TunnelBudgetKeys, scope: TunnelBudgetScope) =>
  scope === 'user' ? keys.userId : scope === 'tunnel' ? keys.tunnelId : keys.agentId;

export async function checkTunnelHttpRate(
  keys: TunnelBudgetKeys,
): Promise<{ ok: true } | { ok: false; scope: TunnelBudgetScope; retryAfterSeconds: number }> {
  const redis = getRedis();
  for (const scope of SCOPES) {
    const result = await rateLimiter(redis, `tunnel-http:rate:${scope}:${idFor(keys, scope)}`,
      TUNNEL_HTTP_RATE_LIMITS[scope], TUNNEL_HTTP_RATE_LIMITS.windowSeconds);
    if (!result.allowed) {
      return { ok: false, scope, retryAfterSeconds: Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000)) };
    }
  }
  return { ok: true };
}

const inFlight = new Map<string, number>();

export function acquireTunnelHttpSlot(
  keys: TunnelBudgetKeys,
): { ok: true; release: () => void } | { ok: false; scope: TunnelBudgetScope } {
  const entries = SCOPES.map((scope) => [scope, `${scope}:${idFor(keys, scope)}`] as const);
  for (const [scope, key] of entries) {
    if ((inFlight.get(key) ?? 0) >= TUNNEL_HTTP_CONCURRENCY_LIMITS[scope]) return { ok: false, scope };
  }
  for (const [, key] of entries) inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      for (const [, key] of entries) {
        const next = (inFlight.get(key) ?? 1) - 1;
        if (next <= 0) inFlight.delete(key);
        else inFlight.set(key, next);
      }
    },
  };
}

export function __resetTunnelHttpBudgetForTests(): void {
  inFlight.clear();
}
```

```ts
// apps/api/src/services/tunnelHttpMetrics.ts
/** Network Proxy outcome counter by mode (spec §9). Leaf module: prom-client + metricsRegistry only. */
import { Counter } from 'prom-client';
import { metricsRegistry } from './metricsRegistry';

export type TunnelHttpMode = 'path' | 'host';
export type TunnelHttpOutcome =
  | 'proxied' | 'auth_failed' | 'admission_refused' | 'gate_denied' | 'rate_limited' | 'dispatch_failed' | 'host_rejected';

const tunnelHttpRequests = new Counter({
  name: 'tunnel_http_requests_total',
  help: 'Network Proxy requests by mode and outcome',
  labelNames: ['mode', 'outcome'] as const,
  registers: [metricsRegistry],
});

export function recordTunnelHttpOutcome(mode: TunnelHttpMode, outcome: TunnelHttpOutcome): void {
  tunnelHttpRequests.inc({ mode, outcome });
}
```

Wire the budgets and metrics into `tunnelHost.ts`. Import `checkTunnelHttpRate`, `acquireTunnelHttpSlot` and `recordTunnelHttpOutcome`, then:
- after `if (!admission.ok)`: call `recordTunnelHttpOutcome('host', 'admission_refused')` before returning;
- in `handleEnter`, on each `401` return: `recordTunnelHttpOutcome('host', 'auth_failed')`;
- in the ping 401 and `if (!auth)`: `recordTunnelHttpOutcome('host', 'auth_failed')`;
- after `if (!gate.ok)`: `recordTunnelHttpOutcome('host', 'gate_denied')`;
- replace the dispatch section starting at `await bumpTunnelActivity(...)` with:

```ts
  const budgetKeys = { userId: auth.userId, tunnelId, agentId: session.agentId };
  const rate = await checkTunnelHttpRate(budgetKeys);
  if (!rate.ok) {
    recordTunnelHttpOutcome('host', 'rate_limited');
    c.header('retry-after', String(rate.retryAfterSeconds));
    return c.text('Too many requests', 429);
  }
  const slot = acquireTunnelHttpSlot(budgetKeys);
  if (!slot.ok) {
    recordTunnelHttpOutcome('host', 'rate_limited');
    c.header('retry-after', '1');
    return c.text('Too many concurrent requests', 429);
  }
  let outcome: Awaited<ReturnType<typeof dispatchTunnelHttpRequest>>;
  try {
    await bumpTunnelActivity(tunnelId, session.lastActivityAt);
    const method = c.req.method.toUpperCase();
    const bodyB64 = method === 'GET' || method === 'HEAD' ? '' : Buffer.from(await c.req.arrayBuffer()).toString('base64');
    outcome = await dispatchTunnelHttpRequest(tunnelId, session, {
      method, path: url.pathname + url.search,
      headers: buildHostModeUpstreamHeaders(c.req.header(), { tunnelOrigin, targetOrigin }), bodyB64,
    });
  } finally {
    slot.release();
  }
  if (!outcome.ok) {
    recordTunnelHttpOutcome('host', 'dispatch_failed');
    return c.text(outcome.message, outcome.status);
  }
```

(`targetOrigin` stays computed before this block), and call `recordTunnelHttpOutcome('host', 'proxied')` immediately before the final `return new Response(...)`.

In `tunnelHttp.ts` (path mode, metrics only, no behaviour change), call `recordTunnelHttpOutcome('path', …)`: `admission_refused` on the cross-site 403, `auth_failed` on each 401, `gate_denied` on `!gate.ok`, `dispatch_failed` on `!outcome.ok`, and `proxied` before the final `return new Response(...)`. Then add `vi.mock('../services/tunnelHttpMetrics', () => ({ recordTunnelHttpOutcome: vi.fn() }))` to `tunnelHttp.test.ts`.

In `tunnelHostDispatch.ts`, call `recordTunnelHttpOutcome('host', 'host_rejected')` in the reject branch.

- [ ] **Step 4: Run to verify they pass**
  Run: `cd apps/api && npx vitest run src/services/tunnelHttpBudget.test.ts src/routes/tunnelHost.test.ts src/middleware/tunnelHostLogRedaction.test.ts src/middleware/tunnelHostDispatch.test.ts src/routes/tunnelHttp.test.ts`
  Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add apps/api/src/services/tunnelHttpBudget.ts apps/api/src/services/tunnelHttpBudget.test.ts apps/api/src/services/tunnelHttpMetrics.ts apps/api/src/routes/tunnelHost.ts apps/api/src/routes/tunnelHost.test.ts apps/api/src/routes/tunnelHttp.ts apps/api/src/routes/tunnelHttp.test.ts apps/api/src/middleware/tunnelHostDispatch.ts apps/api/src/middleware/tunnelHostLogRedaction.test.ts
  git commit -m "feat(network-proxy): per-user/tunnel/agent budgets + outcome metrics + log redaction pin"
  ```

### Task 10: Caddy tunnel site block + real-Caddy routing contract in CI

**Files:**
- Modify: `docker/Caddyfile.prod` (header comment, app-block strip, new tunnel block at the end)
- Create: `scripts/check-tunnel-site-routing.sh`
- Modify: `.github/workflows/ci.yml` (Lint job, next to `bash scripts/check-caddyfile-local-certs.sh` ~line 268)
- Modify: `docker-compose.yml` and `deploy/docker-compose.prod.yml` (caddy `environment:`)

**Interfaces:**
- Consumes: the assertion name and value from Task 5 (`X-Breeze-Tunnel-Site: 1`).
- Produces: the env vars `TUNNEL_SITE_ADDRESS` (default `http://tunnel-disabled.invalid`) and `TUNNEL_TLS_DIRECTIVE` (default empty) for the caddy service.

This task deviates from the wave split in the brief: the Caddy *block* lands in W01 because the spec requires a real-Caddy integration test for W01 merge (§3, §9). W04 only sets the env on the droplets.

- [ ] **Step 1: Write the failing contract script**:

```bash
#!/usr/bin/env bash
# scripts/check-tunnel-site-routing.sh
#
# Real-Caddy routing contract for the Network Proxy tunnel site block
# (spec docs/superpowers/specs/monitoring/2026-10-06-network-proxy-tunnel-origin-design.md §3).
# Drives docker/Caddyfile.prod through real caddy with forged Host and
# X-Breeze-Tunnel-Site headers against stub upstreams that echo
# "<service>|<host>|<assertion>|<path>". A missing prerequisite is a hard
# failure under CI and a skip locally (same policy as check-caddyfile-local-certs.sh).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CADDYFILE="${REPO_ROOT}/docker/Caddyfile.prod"
CADDY_IMAGE="${CADDY_IMAGE_REF:-caddy:2-alpine}"
CURL_IMAGE="${CURL_IMAGE_REF:-curlimages/curl:8.10.1}"
SUFFIX="us.breezetunnel.test"
TUNNEL_ID="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
NET="breeze-tunnel-routing-$$"

skip_or_fail() {
  if [ -n "${CI:-}" ]; then echo "FAIL: $1" >&2; exit 1; fi
  echo "SKIP: $1"; exit 0
}
command -v docker >/dev/null 2>&1 || skip_or_fail "docker CLI not found"
docker info >/dev/null 2>&1 || skip_or_fail "docker daemon unreachable"

WORK="$(mktemp -d)"
cleanup() {
  docker rm -f "${NET}-edge" "${NET}-stub" >/dev/null 2>&1 || true
  docker network rm "${NET}" >/dev/null 2>&1 || true
  rm -rf "${WORK}"
}
trap cleanup EXIT

cat > "${WORK}/stub.Caddyfile" <<'EOF'
{
	admin off
	auto_https off
}
:3001 {
	respond "api|{host}|{header.X-Breeze-Tunnel-Site}|{path}"
}
:4321 {
	respond "web|{host}|{header.X-Breeze-Tunnel-Site}|{path}"
}
:4322 {
	respond "portal|{host}|{header.X-Breeze-Tunnel-Site}|{path}"
}
:3002 {
	respond "billing|{host}|{header.X-Breeze-Tunnel-Site}|{path}"
}
EOF

docker network create "${NET}" >/dev/null
docker run -d --name "${NET}-stub" --network "${NET}" \
  --network-alias api --network-alias web --network-alias portal --network-alias billing \
  -v "${WORK}/stub.Caddyfile:/etc/caddy/Caddyfile:ro" "${CADDY_IMAGE}" >/dev/null
docker run -d --name "${NET}-edge" --network "${NET}" --network-alias edge \
  -e CADDY_SITE_ADDRESS=':80' \
  -e TUNNEL_SITE_ADDRESS="http://*.${SUFFIX}, http://*.*.${SUFFIX}" \
  -v "${CADDYFILE}:/etc/caddy/Caddyfile:ro" "${CADDY_IMAGE}" >/dev/null

probe() { # probe <host> <path> [extra curl args...]
  local host="$1" path="$2"; shift 2
  docker run --rm --network "${NET}" "${CURL_IMAGE}" -s --max-time 5 -H "Host: ${host}" "$@" "http://edge:80${path}"
}
for _ in $(seq 1 30); do
  [ "$(probe app.example.test /x 2>/dev/null | cut -d'|' -f1)" = "web" ] && break
  sleep 1
done

fail=0
expect() { # expect <label> <expected> <host> <path> [extra curl args...]
  local label="$1" expected="$2"; shift 2
  local got; got="$(probe "$@")"
  if [ "${got}" = "${expected}" ]; then echo "ok   ${label}"; else echo "FAIL ${label}: expected '${expected}' got '${got}'"; fail=1; fi
}

TH="${TUNNEL_ID}.${SUFFIX}"
expect "tunnel / → api with assertion"            "api|${TH}|1|/"                  "${TH}" /
expect "tunnel /api/* → api, never app routing"   "api|${TH}|1|/api/v1/auth/me"    "${TH}" /api/v1/auth/me
expect "tunnel /portal/* → api, never portal"     "api|${TH}|1|/portal/login"      "${TH}" /portal/login
expect "tunnel /billing/* → api, never billing"   "api|${TH}|1|/billing/x"         "${TH}" /billing/x
expect "tunnel forged assertion is replaced"      "api|${TH}|1|/"                  "${TH}" / -H "X-Breeze-Tunnel-Site: forged"
expect "deeper tunnel host → api (API 404s it)"   "api|a.b.${SUFFIX}|1|/"          "a.b.${SUFFIX}" /
expect "app /api strips a forged assertion"       "api|app.example.test||/api/v1/health" app.example.test /api/v1/health -H "X-Breeze-Tunnel-Site: 1"
expect "app / strips a forged assertion"          "web|app.example.test||/"        app.example.test / -H "X-Breeze-Tunnel-Site: 1"

# Disabled default: with TUNNEL_SITE_ADDRESS unset the file must still adapt.
docker run --rm -v "${CADDYFILE}:/etc/caddy/Caddyfile:ro" "${CADDY_IMAGE}" caddy adapt --config /etc/caddy/Caddyfile >/dev/null \
  && echo "ok   adapts with TUNNEL_SITE_ADDRESS unset" || { echo "FAIL adapt with TUNNEL_SITE_ADDRESS unset"; fail=1; }

exit "${fail}"
```

  Run: `chmod +x scripts/check-tunnel-site-routing.sh && bash scripts/check-tunnel-site-routing.sh`
  Expected: FAIL. The tunnel-host cases return `web|…` or `api|…||…` (no tunnel block yet), and the forged app assertion reaches the upstream (`|1|`).

- [ ] **Step 2: Implement the Caddyfile changes.**
  - Header comment (after the `CADDY_LOCAL_CERTS` paragraph):
    ```
    #   TUNNEL_SITE_ADDRESS Optional. Network Proxy tunnel wildcard(s) (spec
    #                       docs/superpowers/specs/monitoring/2026-10-06-network-proxy-tunnel-origin-design.md).
    #                       Behind Cloudflare Tunnel: `http://*.<region>.<tunnel-domain>, http://*.*.<region>.<tunnel-domain>`.
    #                       Unset = `http://tunnel-disabled.invalid` (matches nothing).
    #                       Must be a different registrable domain from CADDY_SITE_ADDRESS.
    #
    #   TUNNEL_TLS_DIRECTIVE Optional. Empty (default) or a full `tls <cert> <key>`
    #                       line for an Origin CA wildcard when Caddy terminates TLS
    #                       for the tunnel domain itself. Expands like CADDY_LOCAL_CERTS.
    ```
  - In the `{$CADDY_SITE_ADDRESS::80}` block, directly under `request_header -X-Breeze-Client-Cert-Serial`:
    ```
      # Network Proxy: only the tunnel site block below may assert a tunnel
      # host. Strip any client-supplied copy before every route (same reason
      # as the mTLS strip above: header_up deletes run after sets).
      request_header -X-Breeze-Tunnel-Site
    ```
  - Append at the end of the file:
    ```
    # --- Network Proxy tunnel origin (host mode) ---------------------------------
    # Serves NOTHING but the API's tunnel-host handler: no web, portal, billing or
    # OAuth routes. The API rejects a tunnel Host without the assertion and an
    # app Host with it, and treats every host at or under the tunnel suffix as
    # tunnel surface (deeper labels 404 there). Keep WebSocket upgrade headers
    # intact (reverse_proxy default) for the future WebSocket wave.
    {$TUNNEL_SITE_ADDRESS:http://tunnel-disabled.invalid} {
    	{$TUNNEL_TLS_DIRECTIVE}
    	request_header -X-Breeze-Tunnel-Site
    	request_header -X-Breeze-Client-Cert-Verified
    	request_header -X-Breeze-Client-Cert-Serial
    	reverse_proxy api:3001 {
    		header_up X-Breeze-Tunnel-Site 1
    		header_up -Cf-Client-Cert-Verified
    		header_up -Cf-Client-Cert-Serial
    		header_up -Cf-Client-Cert-Der-Base64
    		header_up -Cf-Client-Cert-Sha256
    	}
    	header {
    		Strict-Transport-Security "max-age=31536000"
    		-Server
    	}
    }
    ```
  - Compose: in `docker-compose.yml` and `deploy/docker-compose.prod.yml`, under the `caddy` service `environment:`, add:
    ```yaml
      # Network Proxy host mode (optional). Default matches nothing.
      TUNNEL_SITE_ADDRESS: ${TUNNEL_SITE_ADDRESS:-http://tunnel-disabled.invalid}
      TUNNEL_TLS_DIRECTIVE: ${TUNNEL_TLS_DIRECTIVE:-}
    ```
  - `.env.example`, next to the `TUNNEL_ORIGIN_TEMPLATE` block:
    ```bash
    # Caddy site address for the tunnel domain (see docker/Caddyfile.prod).
    # TUNNEL_SITE_ADDRESS=
    # TUNNEL_TLS_DIRECTIVE=
    ```
  - `.github/workflows/ci.yml`, directly after the `bash scripts/check-caddyfile-local-certs.sh` step:
    ```yaml
          - name: Network Proxy tunnel site routing (real Caddy)
            run: bash scripts/check-tunnel-site-routing.sh
    ```
- [ ] **Step 3: Run the contract and the neighbouring Caddy guards**
  Run: `bash scripts/check-tunnel-site-routing.sh && bash scripts/check-caddyfile-local-certs.sh && bash scripts/check-agent-mtls-edge-policy.sh && cd apps/api && npx vitest run src/config/caddyWebBillingCarveouts.test.ts src/config/composeBindMounts.test.ts src/config/envComposeParity.test.ts`
  Expected: every `ok`, exit 0, and the vitest files PASS. If `check-agent-mtls-edge-policy.sh` flags the new block, it is because a site block lacks the mTLS strips. They are included, so read its message and align the block rather than the guard.
- [ ] **Step 4: Commit**
  ```bash
  git add docker/Caddyfile.prod scripts/check-tunnel-site-routing.sh .github/workflows/ci.yml docker-compose.yml deploy/docker-compose.prod.yml .env.example
  git commit -m "feat(network-proxy): Caddy tunnel site block + real-Caddy routing contract in CI"
  ```

### Task 11: W01 exit — security checklist trace and full suites

**Files:**
- No code. The PR description carries the trace table.

- [ ] **Step 1: Run every suite this wave touched, plus the full API unit suite**
  ```bash
  cd apps/api && npx vitest run src/config src/routes/tunnelHttp src/routes/tunnelHost src/routes/tunnels.test.ts src/middleware src/services/tunnelHttpBudget.test.ts src/services/agentCommandAwait.test.ts src/system/connections src/index.tunnelHostOrder.test.ts
  cd apps/api && npx vitest run 2>&1 | tail -8
  bash scripts/check-tunnel-site-routing.sh
  ```
  Expected: all green, and the full-suite file count matches `main` plus the new files.
- [ ] **Step 2: Paste this trace into the W02 PR description** (spec §9 → pinning test):

| §9 item | Pinned by |
|---|---|
| Tunnel host never serves app routes; app host never reaches tunnel handling (forged Host and assertion) | `tunnelHostDispatch.test.ts`, `check-tunnel-site-routing.sh` |
| Validator rejects a same-registrable-domain config | `tunnelOrigin.test.ts` (3 cases), `validate.test.ts` |
| `__Host-bzt` bound to tunnel id; A's cookie rejected on B | `tunnelHttpCore.test.ts`, `tunnelHost.test.ts` "rejects a cookie minted for tunnel A…" |
| Every path-mode gate runs in host mode | `tunnelHost.test.ts` "runs every gate…", "12h cap, device-offline…" |
| `/__bz/*` never forwarded; device cannot set reserved names | `tunnelHost.test.ts` reserved paths; `tunnelHostHeaders.test.ts` reserved names |
| `frame-ancestors` only the configured app origin (+ `'self'`) | `tunnelHostHeaders.test.ts`, `tunnelHost.test.ts` enter CSP |
| Device `Domain=` stripped | `tunnelHostHeaders.test.ts` |
| Origin rewrite never forwards the app origin or credentials | `tunnelHostHeaders.test.ts` upstream headers |
| Cross-tunnel refused before dispatch (GET included, SFS absent) | `tunnelHostAdmission.test.ts`, `tunnelHost.test.ts` |
| Proxy cookies never reach the device; other `__Host-*` pass | `tunnelHostHeaders.test.ts` |
| Exchange racing Close does not reopen; tickets die on Close | `tunnelHttp.test.ts` + `tunnelHost.test.ts` revocation cases (G8) |
| `Service-Worker: script` refused | `tunnelHostAdmission.test.ts`, `tunnelHost.test.ts` |
| Budgets, log redaction, metrics by mode | `tunnelHttpBudget.test.ts`, `tunnelHost.test.ts` budgets, `tunnelHostLogRedaction.test.ts` |

- [ ] **Step 3: Review round.** Run one `/pr-review-toolkit:review-pr` pass on W02, with an Opus or Sonnet security reviewer briefed with this plan's Review Focus and G1–G10. Act only on confirmed, consequential findings. Then enqueue with `gh pr merge <N>`.

---

# W03 — Web (1 PR)

### Task 12: `resolveProxyTarget` — exact URL validation before render

**Files:**
- Create: `apps/web/src/lib/proxyTunnelUrl.ts`, `apps/web/src/lib/proxyTunnelUrl.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ProxyTicketContext = 'frame' | 'tab';
  export type ProxyTarget = { mode: 'host'; src: string; origin: string } | { mode: 'path'; src: string };
  export const HOST_MODE_SANDBOX: string;
  export const PATH_MODE_SANDBOX: string;
  export function resolveProxyTarget(input: { url: unknown; tunnelId: string; context: ProxyTicketContext; appOrigin: string; apiBase: string }): ProxyTarget | null;
  ```

- [ ] **Step 1: Write the failing tests**:

```ts
// apps/web/src/lib/proxyTunnelUrl.test.ts
import { describe, expect, it } from 'vitest';
import { HOST_MODE_SANDBOX, PATH_MODE_SANDBOX, resolveProxyTarget } from './proxyTunnelUrl';

const ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const base = { tunnelId: ID, context: 'frame' as const, appOrigin: 'https://us.breeze-app.test', apiBase: 'https://us.breeze-app.test' };
const host = (u: string, over: Partial<typeof base> = {}) => resolveProxyTarget({ ...base, ...over, url: u });

describe('resolveProxyTarget', () => {
  it('accepts the exact host-mode enter URL for this tunnel', () => {
    expect(host(`https://${ID}.us.breezetunnel.test/__bz/enter?t=TKT`)).toEqual({
      mode: 'host', src: `https://${ID}.us.breezetunnel.test/__bz/enter?t=TKT`, origin: `https://${ID}.us.breezetunnel.test`,
    });
    expect(host(`https://${ID}.us.breezetunnel.test/__bz/enter?t=TKT&mode=tab`, { context: 'tab' })?.mode).toBe('host');
  });

  it.each([
    ['another tunnel id', `https://ffffffff-ffff-4fff-8fff-ffffffffffff.us.breezetunnel.test/__bz/enter?t=T`],
    ['the app origin itself', 'https://us.breeze-app.test/__bz/enter?t=T'],
    ['a subdomain of the app host', `https://${ID}.us.breeze-app.test/__bz/enter?t=T`],
    ['plain http on a public name', `http://${ID}.us.breezetunnel.test/__bz/enter?t=T`],
    ['userinfo', `https://u:p@${ID}.us.breezetunnel.test/__bz/enter?t=T`],
    ['a fragment', `https://${ID}.us.breezetunnel.test/__bz/enter?t=T#x`],
    ['another path', `https://${ID}.us.breezetunnel.test/?t=T`],
    ['an empty ticket', `https://${ID}.us.breezetunnel.test/__bz/enter?t=`],
    ['an extra param', `https://${ID}.us.breezetunnel.test/__bz/enter?t=T&x=1`],
    ['mode=tab in the iframe context', `https://${ID}.us.breezetunnel.test/__bz/enter?t=T&mode=tab`],
    ['javascript:', 'javascript:alert(1)'],
    ['a non-string', 42],
  ])('rejects %s', (_label, url) => {
    expect(resolveProxyTarget({ ...base, url })).toBeNull();
  });

  it('accepts http + port only for *.localhost (dev / e2e)', () => {
    expect(resolveProxyTarget({ ...base, appOrigin: 'http://localhost:18480', apiBase: 'http://localhost:18480',
      url: `http://${ID}.tunnel.localhost:18480/__bz/enter?t=T` })?.mode).toBe('host');
  });

  it('accepts the server path-mode URL for this tunnel and resolves it against the API base', () => {
    expect(host(`/api/v1/tunnel-http/${ID}/?__bzt=T`)).toEqual({ mode: 'path', src: `https://us.breeze-app.test/api/v1/tunnel-http/${ID}/?__bzt=T` });
    expect(host(`/api/v1/tunnel-http/ffffffff-ffff-4fff-8fff-ffffffffffff/?__bzt=T`)).toBeNull();
    expect(host('//evil.example/api')).toBeNull();
  });

  it('keeps allow-same-origin out of the path-mode sandbox', () => {
    expect(HOST_MODE_SANDBOX).toBe('allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads');
    expect(PATH_MODE_SANDBOX).not.toContain('allow-same-origin');
  });
});
```

- [ ] **Step 2: Run to verify it fails**
  Run: `cd apps/web && npx vitest run src/lib/proxyTunnelUrl.test.ts`
  Expected: FAIL (module missing).
- [ ] **Step 3: Implement**:

```ts
// apps/web/src/lib/proxyTunnelUrl.ts
/**
 * Exact validation of the server-built proxy URL before it is rendered
 * (spec 2026-10-06 §6/§7). The web image has no runtime copy of
 * TUNNEL_ORIGIN_TEMPLATE (plan G3), so this checks STRUCTURE — this tunnel's
 * id as the leftmost label, /__bz/enter, a lone ticket — and refuses anything
 * on the app or API origin/host. allow-same-origin is only ever added for a
 * URL that passed here; the server validator guarantees the separate
 * registrable domain.
 */
export type ProxyTicketContext = 'frame' | 'tab';
export type ProxyTarget = { mode: 'host'; src: string; origin: string } | { mode: 'path'; src: string };

export const HOST_MODE_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads';
export const PATH_MODE_SANDBOX = 'allow-scripts allow-forms allow-popups';

function originOf(raw: string): string | null {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

export function resolveProxyTarget(input: {
  url: unknown; tunnelId: string; context: ProxyTicketContext; appOrigin: string; apiBase: string;
}): ProxyTarget | null {
  const { url, tunnelId, context, appOrigin, apiBase } = input;
  if (typeof url !== 'string' || url.length === 0) return null;

  const pathPrefix = `/api/v1/tunnel-http/${tunnelId}/?__bzt=`;
  if (url.startsWith('/')) {
    if (!url.startsWith(pathPrefix) || url.length === pathPrefix.length || /[#\s]/.test(url)) return null;
    return { mode: 'path', src: `${apiBase.replace(/\/$/, '')}${url}` };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const hostname = parsed.hostname;
  const devLocal = parsed.protocol === 'http:' && hostname.endsWith('.localhost');
  if (parsed.protocol !== 'https:' && !devLocal) return null;
  if (parsed.username || parsed.password || parsed.hash || parsed.pathname !== '/__bz/enter') return null;
  const labels = hostname.split('.');
  if (labels.length < 3 || labels[0] !== tunnelId.toLowerCase()) return null;

  const appOrigins = [originOf(appOrigin), originOf(apiBase)].filter((o): o is string => o !== null);
  if (appOrigins.includes(parsed.origin)) return null;
  for (const o of appOrigins) {
    const appHost = new URL(o).hostname;
    // `localhost` is its own site; *.localhost tunnel hosts are allowed in dev.
    if (appHost.includes('.') && (hostname === appHost || hostname.endsWith(`.${appHost}`))) return null;
  }

  const keys = [...parsed.searchParams.keys()].sort().join(',');
  if (!parsed.searchParams.get('t')) return null;
  if (context === 'frame' && keys !== 't') return null;
  if (context === 'tab' && (keys !== 'mode,t' || parsed.searchParams.get('mode') !== 'tab')) return null;
  return { mode: 'host', src: parsed.toString(), origin: parsed.origin };
}
```

- [ ] **Step 4: Run to verify it passes**
  Run: `cd apps/web && npx vitest run src/lib/proxyTunnelUrl.test.ts`
  Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add apps/web/src/lib/proxyTunnelUrl.ts apps/web/src/lib/proxyTunnelUrl.test.ts
  git commit -m "feat(web): validate server-built proxy URLs before render"
  ```

### Task 13: ProxyTunnelPage — server URL, mode sandbox, cookie-blocked notice, `runAction` close

**Files:**
- Modify: `apps/web/src/components/remote/ProxyTunnelPage.tsx`
- Modify: `apps/web/src/components/remote/ProxyTunnelPage.test.tsx`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/remote.json` (`proxyTunnelPage`)

**Interfaces:**
- Consumes: `resolveProxyTarget`, `HOST_MODE_SANDBOX`, `PATH_MODE_SANDBOX` (Task 12); the API response `{ ticket, url, mode }` (Task 4); the message type `'breeze-tunnel-cookie-blocked'` (Task 8); `runAction` and `ActionError`.
- Produces: the data-testids `network-proxy-frame` (with `data-proxy-mode`), `proxy-close`, `proxy-open-new-tab`, `proxy-cookie-blocked-notice` and `proxy-status`. W03 Task 15 uses them.

- [ ] **Step 1: Write the failing tests** (append to `ProxyTunnelPage.test.tsx`; add the Toast mock at the top):

```tsx
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));

const HOST_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const HOST_URL = `https://${HOST_ID}.us.breezetunnel.test/__bz/enter?t=TKT`;

function hostModeFetch(overrides: Record<string, () => Response> = {}) {
  fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
    const key = `${opts?.method ?? 'GET'} ${url}`;
    if (overrides[key]) return overrides[key]!();
    if (key === `POST /tunnels/${HOST_ID}/http-ticket`) {
      return makeResponse({ ticket: { ticket: 'TKT', expiresInSeconds: 300 }, url: HOST_URL, mode: 'host' });
    }
    if (key === `GET /tunnels/${HOST_ID}`) return makeResponse({ status: 'active', idleSeconds: 0 });
    return makeResponse({});
  });
}

describe('ProxyTunnelPage host mode', () => {
  it('renders the server URL with the host-mode sandbox', async () => {
    hostModeFetch();
    render(<ProxyTunnelPage tunnelId={HOST_ID} target="10.1.2.209:80" />);
    const frame = await screen.findByTestId('network-proxy-frame');
    expect(frame.getAttribute('src')).toBe(HOST_URL);
    expect(frame.getAttribute('data-proxy-mode')).toBe('host');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads');
  });

  it('refuses a server URL on the app origin and never renders a same-origin sandbox', async () => {
    hostModeFetch({
      [`POST /tunnels/${HOST_ID}/http-ticket`]: () => makeResponse({ ticket: { ticket: 'T', expiresInSeconds: 300 }, url: 'http://localhost:3000/__bz/enter?t=T', mode: 'host' }),
    });
    render(<ProxyTunnelPage tunnelId={HOST_ID} target="10.1.2.209:80" />);
    expect(await screen.findByText('The server returned an invalid proxy address.')).toBeTruthy();
    expect(screen.queryByTestId('network-proxy-frame')).toBeNull();
  });

  it('shows the cookie-blocked notice only for a message from the tunnel origin about this tunnel', async () => {
    hostModeFetch();
    render(<ProxyTunnelPage tunnelId={HOST_ID} target="10.1.2.209:80" />);
    await screen.findByTestId('network-proxy-frame');
    window.dispatchEvent(new MessageEvent('message', { origin: 'https://evil.test', data: { type: 'breeze-tunnel-cookie-blocked', tunnelId: HOST_ID } }));
    expect(screen.queryByTestId('proxy-cookie-blocked-notice')).toBeNull();
    window.dispatchEvent(new MessageEvent('message', { origin: `https://${HOST_ID}.us.breezetunnel.test`, data: { type: 'breeze-tunnel-cookie-blocked', tunnelId: HOST_ID } }));
    expect(await screen.findByTestId('proxy-cookie-blocked-notice')).toBeTruthy();
  });

  it('shows "Disconnected" only after the DELETE succeeds', async () => {
    let deleteOk = false;
    hostModeFetch({
      [`DELETE /tunnels/${HOST_ID}`]: () => (deleteOk ? makeResponse({ closed: true }) : makeResponse({ error: 'boom' }, false)),
    });
    render(<ProxyTunnelPage tunnelId={HOST_ID} target="10.1.2.209:80" />);
    await screen.findByTestId('network-proxy-frame');
    screen.getByTestId('proxy-close').click();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/tunnels/${HOST_ID}`, { method: 'DELETE' }));
    expect(screen.getByTestId('proxy-close')).not.toHaveProperty('disabled', true);
    expect(screen.queryByText('Disconnected')).toBeNull();
    deleteOk = true;
    screen.getByTestId('proxy-close').click();
    expect(await screen.findByTestId('proxy-session-expired-overlay')).toBeTruthy();
  });

  it('falls back to composing the path URL when an older API returns no url', async () => {
    fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === `/tunnels/${TUNNEL_ID}/http-ticket` && opts?.method === 'POST') return makeResponse({ ticket: { ticket: 'TKT-abc', expiresInSeconds: 300 } });
      return makeResponse({ status: 'connecting' });
    });
    render(<ProxyTunnelPage tunnelId={TUNNEL_ID} target="10.1.2.209:80" />);
    const frame = await screen.findByTestId('network-proxy-frame');
    expect(frame.getAttribute('data-proxy-mode')).toBe('path');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-popups');
  });
});
```

- [ ] **Step 2: Run to verify it fails**
  Run: `cd apps/web && npx vitest run src/components/remote/ProxyTunnelPage.test.tsx`
  Expected: the new host-mode cases FAIL. The pre-existing cases still pass.
- [ ] **Step 3: Implement.**

Locale keys (in each `remote.json`, inside `proxyTunnelPage`; add `closeFailed` and `invalidProxyUrl` inside `errors`):

| key | en | de-DE | es-419 | fr-CA / fr-FR | it-IT | pt-BR | tr-TR |
|---|---|---|---|---|---|---|---|
| `errors.invalidProxyUrl` | The server returned an invalid proxy address. | Der Server hat eine ungültige Proxy-Adresse zurückgegeben. | El servidor devolvió una dirección de proxy no válida. | Le serveur a renvoyé une adresse de proxy non valide. | Il server ha restituito un indirizzo proxy non valido. | O servidor retornou um endereço de proxy inválido. | Sunucu geçersiz bir proxy adresi döndürdü. |
| `errors.closeFailed` | Failed to close the tunnel | Tunnel konnte nicht geschlossen werden | No se pudo cerrar el túnel | Impossible de fermer le tunnel | Impossibile chiudere il tunnel | Não foi possível fechar o túnel | Tünel kapatılamadı |
| `cookieBlocked.title` | This browser blocked the embedded proxy session | Dieser Browser hat die eingebettete Proxy-Sitzung blockiert | Este navegador bloqueó la sesión de proxy incrustada | Ce navigateur a bloqué la session proxy intégrée | Questo browser ha bloccato la sessione proxy incorporata | Este navegador bloqueou a sessão de proxy incorporada | Bu tarayıcı gömülü proxy oturumunu engelledi |
| `cookieBlocked.body` | Open the device in a new tab to continue. | Öffnen Sie das Gerät in einem neuen Tab, um fortzufahren. | Abra el dispositivo en una pestaña nueva para continuar. | Ouvrez l'appareil dans un nouvel onglet pour continuer. | Apri il dispositivo in una nuova scheda per continuare. | Abra o dispositivo em uma nova aba para continuar. | Devam etmek için cihazı yeni bir sekmede açın. |

Component changes (`ProxyTunnelPage.tsx`):

```tsx
import { runAction, ActionError } from '@/lib/runAction';
import { showToast } from '@/components/shared/Toast';
import {
  HOST_MODE_SANDBOX, PATH_MODE_SANDBOX, resolveProxyTarget, type ProxyTarget, type ProxyTicketContext,
} from '@/lib/proxyTunnelUrl';

const COOKIE_BLOCKED_MESSAGE_TYPE = 'breeze-tunnel-cookie-blocked';

function apiBase(): string {
  return import.meta.env.PUBLIC_API_URL || window.location.origin;
}

// Replaces buildProxyUrl(): legacy fallback ONLY for an API that predates `url`.
function legacyPathUrl(tunnelId: string, ticket: string): string {
  return `/api/v1/tunnel-http/${tunnelId}/?__bzt=${encodeURIComponent(ticket)}`;
}

// state: replace `proxyUrl` with
  const [target, setTarget] = useState<ProxyTarget | null>(null);
  const [cookieBlocked, setCookieBlocked] = useState(false);
  const [closing, setClosing] = useState(false);

// replaces mintTicket: requestTicket does NOT touch iframe state, so the new-tab flow can reuse it.
  const requestTicket = useCallback(async (context: ProxyTicketContext): Promise<ProxyTarget | null> => {
    try {
      const res = await fetchWithAuth(`/tunnels/${tunnelId}/http-ticket${context === 'tab' ? '?mode=tab' : ''}`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || stableT('proxyTunnelPage.errors.obtainTicket'));
      }
      const body = await res.json();
      const ticket = typeof body.ticket === 'string' ? body.ticket : body.ticket?.ticket;
      if (!ticket) throw new Error(stableT('proxyTunnelPage.errors.invalidTicket'));
      const url = typeof body.url === 'string' ? body.url : legacyPathUrl(tunnelId, ticket);
      const resolved = resolveProxyTarget({ url, tunnelId, context, appOrigin: window.location.origin, apiBase: apiBase() });
      if (!resolved) throw new Error(stableT('proxyTunnelPage.errors.invalidProxyUrl'));
      return resolved;
    } catch (err) {
      const message = err instanceof Error ? err.message : stableT('proxyTunnelPage.errors.prepareConnection');
      // A failed NEW-TAB mint must not tear down a working iframe: toast instead.
      if (context === 'frame') setError(message);
      else showToast({ type: 'error', message });
      return null;
    }
  }, [tunnelId, stableT]);

  const mintTicket = useCallback(async (): Promise<boolean> => {
    const next = await requestTicket('frame');
    if (!next) return false;
    setCookieBlocked(false);
    setTarget(next);
    return true;
  }, [requestTicket]);

// cookie-blocked listener (host mode only, exact origin + tunnel id)
  useEffect(() => {
    if (target?.mode !== 'host') return;
    const expectedOrigin = target.origin;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; tunnelId?: unknown } | null;
      if (event.origin !== expectedOrigin || data?.type !== COOKIE_BLOCKED_MESSAGE_TYPE || data.tunnelId !== tunnelId) return;
      setCookieBlocked(true);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [target, tunnelId]);

// close: "disconnected" only after the DELETE succeeds (spec §4)
  const handleClose = useCallback(async () => {
    setClosing(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/tunnels/${tunnelId}`, { method: 'DELETE' }),
        errorFallback: t('proxyTunnelPage.errors.closeFailed'),
      });
      setStatus('disconnected');
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('proxyTunnelPage.errors.closeFailed') });
    } finally {
      setClosing(false);
    }
  }, [tunnelId, t]);
```

In the JSX:
- the Close `<button>` gets `data-testid="proxy-close"`, `onClick={() => void handleClose()}` and `disabled={closing || status === 'disconnected' || status === 'failed'}`;
- the status `<span>` gets `data-testid="proxy-status"`;
- `proxyUrl ? (<iframe …` becomes `target ? (<iframe src={target.src} data-proxy-mode={target.mode} sandbox={target.mode === 'host' ? HOST_MODE_SANDBOX : PATH_MODE_SANDBOX} …` (keep `title`, `data-testid`, `className` and `onLoad`; replace the old sandbox comment with: "Host mode: allow-same-origin is safe ONLY because resolveProxyTarget proved the URL is not on the app/API origin (spec §6). Path mode: opaque origin.");
- immediately above the iframe container's overlays, add:
  ```tsx
  {cookieBlocked && (
    <div data-testid="proxy-cookie-blocked-notice" className="absolute inset-x-0 top-0 z-10 border-b bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
      <strong>{t('proxyTunnelPage.cookieBlocked.title')}</strong>{' '}{t('proxyTunnelPage.cookieBlocked.body')}
    </div>
  )}
  ```
- The "Open In New Tab" anchor is replaced in Task 14. For this task, render it only when `target` is set, and keep `href={target.src}` temporarily.

- [ ] **Step 4: Run to verify it passes**
  Run: `cd apps/web && npx vitest run src/components/remote/ProxyTunnelPage.test.tsx src/components/remote/ProxyTunnelPage.localeStability.test.tsx src/lib/i18n/localeParity.test.ts src/lib/__tests__/no-silent-mutations.test.ts`
  Expected: PASS. If the existing first test asserted a `src` *containing* the path, it still passes, because the legacy fallback resolves to `${origin}/api/v1/tunnel-http/…`.
- [ ] **Step 5: Commit**
  ```bash
  git add apps/web/src/components/remote/ProxyTunnelPage.tsx apps/web/src/components/remote/ProxyTunnelPage.test.tsx apps/web/src/locales
  git commit -m "feat(web): proxy page uses validated server URL, host-mode sandbox, cookie-blocked notice, runAction close"
  ```

### Task 14: "Open in New Tab" with a fresh ticket and no opener

**Files:**
- Modify: `apps/web/src/components/remote/ProxyTunnelPage.tsx`
- Modify: `apps/web/src/components/remote/ProxyTunnelPage.test.tsx`

**Interfaces:**
- Consumes: `requestTicket('tab')` (Task 13).

- [ ] **Step 1: Write the failing test**:

```tsx
describe('Open in New Tab', () => {
  it('opens a blank tab synchronously, severs the opener, then navigates it to a fresh mode=tab ticket', async () => {
    const tabUrl = `https://${HOST_ID}.us.breezetunnel.test/__bz/enter?t=TAB&mode=tab`;
    hostModeFetch({
      [`POST /tunnels/${HOST_ID}/http-ticket?mode=tab`]: () => makeResponse({ ticket: { ticket: 'TAB', expiresInSeconds: 300 }, url: tabUrl, mode: 'host' }),
    });
    const replace = vi.fn();
    const fakeWin = { opener: {} as unknown, location: { replace }, close: vi.fn() };
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(fakeWin as unknown as Window);

    render(<ProxyTunnelPage tunnelId={HOST_ID} target="10.1.2.209:80" />);
    (await screen.findByTestId('proxy-open-new-tab')).click();

    expect(openSpy).toHaveBeenCalledWith('about:blank', '_blank');
    await waitFor(() => expect(replace).toHaveBeenCalledWith(tabUrl));
    expect(fakeWin.opener).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(`/tunnels/${HOST_ID}/http-ticket?mode=tab`, { method: 'POST' });
    openSpy.mockRestore();
  });

  it('closes the blank tab when the mint fails', async () => {
    hostModeFetch({ [`POST /tunnels/${HOST_ID}/http-ticket?mode=tab`]: () => makeResponse({ error: 'nope' }, false) });
    const fakeWin = { opener: {}, location: { replace: vi.fn() }, close: vi.fn() };
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(fakeWin as unknown as Window);
    render(<ProxyTunnelPage tunnelId={HOST_ID} target="10.1.2.209:80" />);
    (await screen.findByTestId('proxy-open-new-tab')).click();
    await waitFor(() => expect(fakeWin.close).toHaveBeenCalled());
    openSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run to verify it fails**
  Run: `cd apps/web && npx vitest run src/components/remote/ProxyTunnelPage.test.tsx -t "Open in New Tab"`
  Expected: FAIL (`proxy-open-new-tab` not found, or no `window.open` call).
- [ ] **Step 3: Implement**:

```tsx
  // Spec §4/§7 + plan G5: open synchronously inside the click (popup blockers
  // reject window.open after an await), sever the opener so device content in
  // the tab can never reach this app window, THEN navigate to a fresh,
  // validated mode=tab ticket. Each context (iframe, tab) gets its own ticket.
  const handleOpenNewTab = useCallback(async () => {
    const win = window.open('about:blank', '_blank');
    if (win) win.opener = null;
    const next = await requestTicket('tab');
    if (!next) {
      win?.close();
      return;
    }
    if (win) win.location.replace(next.src);
    else window.open(next.src, '_blank', 'noopener,noreferrer');
  }, [requestTicket]);
```

Replace the `<a href={proxyUrl} target="_blank" …>` with:

```tsx
          {target && (
            <button
              type="button"
              data-testid="proxy-open-new-tab"
              onClick={() => void handleOpenNewTab()}
              className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              <ExternalLink className="h-4 w-4" />
              {t('proxyTunnelPage.openInNewTab')}
            </button>
          )}
```

In the cookie-blocked notice from Task 13, add a button after the body text: `<button type="button" className="ml-2 underline" onClick={() => void handleOpenNewTab()}>{t('proxyTunnelPage.openInNewTab')}</button>`.

- [ ] **Step 4: Run to verify it passes**
  Run: `cd apps/web && npx vitest run src/components/remote/ProxyTunnelPage.test.tsx`
  Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add apps/web/src/components/remote/ProxyTunnelPage.tsx apps/web/src/components/remote/ProxyTunnelPage.test.tsx
  git commit -m "feat(web): open-in-new-tab mints a fresh tab ticket and severs the opener"
  ```

### Task 15: Playwright e2e against a wt-stack with `*.tunnel.localhost`

**Files:**
- Modify: `scripts/dev/wt-stack/env.ts` (`RUNTIME_KEYS`) + `scripts/dev/wt-stack/env.test.ts`
- Create: `e2e-tests/helpers/tunnelOriginStack.ts`
- Create: `e2e-tests/tests/network-proxy-tunnel-origin.spec.ts`
- Create: `e2e-tests/playwright.tunnel-origin.config.ts`

**Interfaces:**
- Consumes: the W01 env vars and Caddy block; the W03 testids.
- Produces: `enableTunnelOriginOnStack(): { port: number; suffix: string }`, `seedProxyTunnel(): string`.

- [ ] **Step 1: Write the failing wt-stack test** (append to `scripts/dev/wt-stack/env.test.ts`, reusing that file's temp-dir pattern):

```ts
  it('keeps the tunnel-origin runtime keys across a re-up', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wtstack-'));
    writeFileSync(path.join(dir, '.env'), '');
    setStackEnvValues(dir, { TUNNEL_ORIGIN_TEMPLATE: 'http://{id}.tunnel.localhost:5', TUNNEL_FRAME_ANCESTOR: 'http://localhost:5', TUNNEL_SITE_ADDRESS: 'http://*.tunnel.localhost' });
    writeEnvStack(dir, { arch: 'x64' });
    expect(readStackEnvValue(dir, 'TUNNEL_ORIGIN_TEMPLATE')).toBe('http://{id}.tunnel.localhost:5');
    expect(readStackEnvValue(dir, 'TUNNEL_SITE_ADDRESS')).toBe('http://*.tunnel.localhost');
  });
```

  Run: `npx vitest run scripts/dev/wt-stack/env.test.ts`
  Expected: FAIL (`writeEnvStack` drops non-runtime keys).
- [ ] **Step 2: Implement** in `scripts/dev/wt-stack/env.ts`:

```ts
const RUNTIME_KEYS = [
  'WEBAUTHN_ORIGIN', 'WEBAUTHN_RP_ID',
  // Network Proxy host mode on a local stack (e2e-tests/helpers/tunnelOriginStack.ts).
  'TUNNEL_ORIGIN_TEMPLATE', 'TUNNEL_FRAME_ANCESTOR', 'TUNNEL_SITE_ADDRESS',
] as const;
```

  Run: `npx vitest run scripts/dev/wt-stack/env.test.ts`
  Expected: PASS.
- [ ] **Step 3: Write the helper**:

```ts
// e2e-tests/helpers/tunnelOriginStack.ts
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setStackEnvValues } from '../../scripts/dev/wt-stack/env';
import { composeArgs } from './topologyPhysicalSeed';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const SUFFIX = 'tunnel.localhost';

function stack(): { webPort: number; baseUrl: string } {
  const file = process.env.E2E_STACK_FILE ?? path.join(repoRoot, '.breeze-stack.json');
  return JSON.parse(readFileSync(file, 'utf8')) as { webPort: number; baseUrl: string };
}

/** Turn on host mode for this worktree stack (idempotent) and recreate api + caddy. */
export function enableTunnelOriginOnStack(): { port: number; suffix: string } {
  const { webPort } = stack();
  setStackEnvValues(repoRoot, {
    TUNNEL_ORIGIN_TEMPLATE: `http://{id}.${SUFFIX}:${webPort}`,
    TUNNEL_FRAME_ANCESTOR: `http://localhost:${webPort}`,
    TUNNEL_SITE_ADDRESS: `http://*.${SUFFIX}, http://*.*.${SUFFIX}`,
  });
  execFileSync('docker', [...composeArgs(), 'up', '-d', '--no-deps', 'api', 'caddy'], { cwd: repoRoot, stdio: 'inherit' });
  execFileSync('docker', [...composeArgs(), 'exec', '-T', 'api', 'sh', '-c',
    'for i in $(seq 1 90); do wget -qO- http://127.0.0.1:3001/health >/dev/null 2>&1 && exit 0; sleep 2; done; exit 1'],
  { cwd: repoRoot, stdio: 'inherit' });
  return { port: webPort, suffix: SUFFIX };
}

/** A fresh pending proxy tunnel on the seeded macOS device, owned by the e2e admin. No agent is connected. */
export function seedProxyTunnel(): string {
  const sql = `INSERT INTO tunnel_sessions (device_id, user_id, org_id, type, status, target_host, target_port, scheme)
    SELECT d.id, u.id, d.org_id, 'proxy', 'pending', '192.0.2.10', 80, 'http'
    FROM devices d, users u WHERE d.agent_id = 'e2e-macos-agent' AND u.email = 'admin@breeze.local'
    RETURNING id;`;
  const out = execFileSync('docker', [...composeArgs(), 'exec', '-T', 'postgres', 'psql', '-U', 'breeze', '-d', 'breeze', '-tA', '-c',
    `SELECT set_config('breeze.scope','system',false); ${sql}`], { cwd: repoRoot, encoding: 'utf8' });
  const id = out.split('\n').map((l) => l.trim()).find((l) => /^[0-9a-f-]{36}$/.test(l));
  if (!id) throw new Error(`seedProxyTunnel: no id in ${out}`);
  return id;
}
```

- [ ] **Step 4: Write the spec and config**:

```ts
// e2e-tests/tests/network-proxy-tunnel-origin.spec.ts
import { expect, test } from '@playwright/test';
import { enableTunnelOriginOnStack, seedProxyTunnel } from '../helpers/tunnelOriginStack';

let port = 0;
test.beforeAll(() => { ({ port } = enableTunnelOriginOnStack()); });

const tunnelHost = (id: string) => `${id}.tunnel.localhost`;

test('iframe loads from the tunnel origin with the host-mode sandbox and authenticates', async ({ page }) => {
  const id = seedProxyTunnel();
  const enter = page.waitForResponse((r) => new URL(r.url()).hostname === tunnelHost(id) && new URL(r.url()).pathname === '/__bz/enter');
  // The seeded device has no connected agent: an AUTHENTICATED device request ends at the bridge gate (502), never 401.
  const root = page.waitForResponse((r) => new URL(r.url()).hostname === tunnelHost(id) && new URL(r.url()).pathname === '/');
  await page.goto(`/remote/proxy/${id}?target=192.0.2.10:80`);
  const frame = page.getByTestId('network-proxy-frame');
  await expect(frame).toHaveAttribute('data-proxy-mode', 'host');
  await expect(frame).toHaveAttribute('sandbox', /allow-same-origin/);
  expect(new URL((await frame.getAttribute('src'))!).hostname).toBe(tunnelHost(id));
  expect((await enter).status()).toBe(200);
  expect((await root).status()).toBe(502);
});

test('Open in New Tab opens a top-level tunnel tab with its own ticket', async ({ page, context }) => {
  const id = seedProxyTunnel();
  await page.goto(`/remote/proxy/${id}?target=192.0.2.10:80`);
  await expect(page.getByTestId('network-proxy-frame')).toBeVisible();
  const popupPromise = context.waitForEvent('page');
  await page.getByTestId('proxy-open-new-tab').click();
  const popup = await popupPromise;
  const root = await popup.waitForResponse((r) => new URL(r.url()).pathname === '/');
  expect(new URL(popup.url()).hostname).toBe(tunnelHost(id));
  expect(root.status()).toBe(502);
  expect(await popup.evaluate(() => window.opener)).toBeNull();
});

test('Close shows Disconnected only after the DELETE succeeds', async ({ page }) => {
  const id = seedProxyTunnel();
  await page.goto(`/remote/proxy/${id}?target=192.0.2.10:80`);
  await expect(page.getByTestId('network-proxy-frame')).toBeVisible();
  await page.route(`**/api/v1/tunnels/${id}`, (route) => route.request().method() === 'DELETE'
    ? route.fulfill({ status: 500, body: '{"error":"boom"}', contentType: 'application/json' }) : route.continue());
  await page.getByTestId('proxy-close').click();
  await expect(page.getByTestId('proxy-session-expired-overlay')).toHaveCount(0);
  await page.unroute(`**/api/v1/tunnels/${id}`);
  await page.getByTestId('proxy-close').click();
  await expect(page.getByTestId('proxy-session-expired-overlay')).toBeVisible();
});

test('a tunnel host never serves app routes', async ({ page }) => {
  // Browser navigation, not the Node request context: Node's resolver is not
  // guaranteed to map *.localhost to loopback; Chromium/Firefox do.
  const id = seedProxyTunnel();
  const res = await page.goto(`http://${tunnelHost(id)}:${port}/api/v1/auth/me`);
  expect(res!.status()).toBe(401);
  expect(res!.headers()['content-security-policy']).toMatch(/^frame-ancestors /);
  expect(await res!.text()).toBe('Unauthorized');
});
```

```ts
// e2e-tests/playwright.tunnel-origin.config.ts
import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testMatch: /network-proxy-tunnel-origin\.spec\.ts/,
  workers: 1,
  projects: [
    { name: 'chromium', use: { ...base.use, ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...base.use, ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...base.use, ...devices['Desktop Safari'] } },
  ],
});
```

(If `playwright.config.ts` wires the authenticated `storageState` through a setup project, copy that `projects` entry and its `dependencies` into this config, matching how `playwright.config.ts` defines `chromium`.)

- [ ] **Step 5: Run against a fresh worktree stack**
  ```bash
  pnpm wt-stack up
  cd e2e-tests && npx playwright test -c playwright.tunnel-origin.config.ts --project chromium --project firefox
  npx playwright test -c playwright.tunnel-origin.config.ts --project webkit || echo "webkit: record result (W00 Task 0.3 says whether *.localhost resolves/secure in WebKit)"
  ```
  Expected: 4/4 pass in Chromium and Firefox. Record the WebKit result in the PR. The spec allows "WebKit where available".
- [ ] **Step 6: Tear down and commit**
  ```bash
  pnpm wt-stack down
  git add scripts/dev/wt-stack/env.ts scripts/dev/wt-stack/env.test.ts e2e-tests/helpers/tunnelOriginStack.ts e2e-tests/tests/network-proxy-tunnel-origin.spec.ts e2e-tests/playwright.tunnel-origin.config.ts
  git commit -m "test(e2e): network proxy host mode against a wt-stack (*.tunnel.localhost)"
  ```

**W03 PR:** `Closes #<W03 sub-issue>`. Run the web suite (`cd apps/web && npx vitest run src/components/remote src/lib`), then one review round.

---

# W04 — Infra and rollout (docs PR + ops; no app code)

### Task 16: Self-host and operator docs

**Files:**
- Create: `apps/docs/src/content/docs/deploy/network-proxy-tunnel-origin.mdx`
- Modify: `apps/docs/src/content/docs/deploy/environment.mdx` (server section: three vars), `apps/docs/src/content/docs/features/remote-access.mdx` (Network Proxy: host vs path mode)

- [ ] **Step 1: Write the page.** Required sections, each with concrete values (use `tunnel.example.net` and never the hosted domain):
  1. *What host mode changes.* Device UIs on `https://<tunnel-id>.<region>.tunnel.example.net`, and why that needs a separate registrable domain.
  2. *Requirements.* A second domain, wildcard DNS `*.<region>`, and a wildcard cert (Let's Encrypt DNS-01 on a custom Caddy build, a Cloudflare Origin CA cert, or Cloudflare Tunnel + ACM).
  3. *Configuration.* `TUNNEL_ORIGIN_TEMPLATE=https://{id}.us.tunnel.example.net`, `TUNNEL_FRAME_ANCESTOR=https://breeze.example.com`, `TUNNEL_SITE_ADDRESS=*.us.tunnel.example.net, *.*.us.tunnel.example.net` (or the `http://` form behind Cloudflare Tunnel), and `TUNNEL_TLS_DIRECTIVE="tls /etc/caddy/tunnel.pem /etc/caddy/tunnel.key"` with the compose volume mount.
  4. *Validation errors.* Quote the boot-refusal messages from `tunnelOrigin.ts`.
  5. *Cloudflare.* Cache bypass and challenges off for the tunnel hostnames.
  6. *Without a second domain.* Leave the vars unset and path mode keeps working.
  7. *Public Suffix List.* Why it matters (sibling cookie tossing) and that host mode is opt-in until then.
- [ ] **Step 2: Build the docs**: `cd apps/docs && pnpm build 2>&1 | tail -5`. Expected: build succeeds. `registry.test.ts`'s docsUrl check also passes because the server docsUrl is unchanged.
- [ ] **Step 3: Commit**: `git add apps/docs && git commit -m "docs(network-proxy): self-host guide for the dedicated tunnel origin"`

### Task 17: Hosted enablement on US **[TODD for steps marked]**

**Files:**
- None in repo (droplet `.env`, `/opt/breeze/docker-compose.yml`, `/opt/breeze/cloudflared/config.yml`, the Cloudflare dashboard). Record what was done in `internal/` notes, never in public files.

- [ ] **Step 1: Preconditions.** W01, W02 and W03 are merged and shipped in a release deployed to US. W00 results are recorded.
- [ ] **Step 2 [TODD]: Confirm** that ACM on the tunnel zone is Active for `*.us.<tunnel-domain>` and `*.eu.<tunnel-domain>` (W00 Task 0.1), and that the cache-bypass and challenge-off rules exist.
- [ ] **Step 3: Cloudflare Tunnel ingress (US).** Add above the catch-all in `/opt/breeze/cloudflared/config.yml`:
  ```yaml
    - hostname: "*.us.<tunnel-domain>"
      service: http://caddy:80
  ```
  Back up first (`cp config.yml config.yml.bak-tunnel-origin`). DNS `*.us` CNAME → `<tunnel-uuid>.cfargotunnel.com`, proxied (kept from W00).
- [ ] **Step 4a (expected, cloudflared path): droplet env.** In `/opt/breeze/.env`:
  ```bash
  TUNNEL_ORIGIN_TEMPLATE=https://{id}.us.<tunnel-domain>
  TUNNEL_FRAME_ANCESTOR=https://us.2breeze.app
  TUNNEL_SITE_ADDRESS=http://*.us.<tunnel-domain>, http://*.*.us.<tunnel-domain>
  ```
  and map them in `/opt/breeze/docker-compose.yml`, which drifts from the repo (see CLAUDE.md "When introducing a new required env var"). Map `TUNNEL_ORIGIN_TEMPLATE: ${TUNNEL_ORIGIN_TEMPLATE:-}` and `TUNNEL_FRAME_ANCESTOR: ${TUNNEL_FRAME_ANCESTOR:-}` under **api** `environment:`, and `TUNNEL_SITE_ADDRESS: ${TUNNEL_SITE_ADDRESS:-http://tunnel-disabled.invalid}` plus `TUNNEL_TLS_DIRECTIVE: ${TUNNEL_TLS_DIRECTIVE:-}` under **caddy** `environment:`. Confirm the deployed Caddyfile is the repo version that carries the tunnel block: `ssh root@<us-droplet> "grep -c TUNNEL_SITE_ADDRESS /opt/breeze/Caddyfile* /opt/breeze/docker/Caddyfile.prod 2>/dev/null"`.
- [ ] **Step 4b (only if W00 found A-record → Caddy:443) [TODD]: Origin CA.** In the Cloudflare dashboard, create an Origin CA certificate for `*.us.<tunnel-domain>`. Install it as `/opt/breeze/caddy-tunnel/origin.pem` and `origin.key` (mode 600), mount that directory read-only into caddy, set `TUNNEL_TLS_DIRECTIVE=tls /etc/caddy-tunnel/origin.pem /etc/caddy-tunnel/origin.key` and `TUNNEL_SITE_ADDRESS=*.us.<tunnel-domain>`, and set SSL mode Full (strict) on the tunnel zone.
- [ ] **Step 5: Roll**:
  ```bash
  ssh root@<us-droplet> "cd /opt/breeze && cp .env .env.bak-pre-tunnel-origin && docker compose up -d api caddy tunnel && docker compose logs --since 2m api | grep -iE 'tunnel-origin|CONFIGURATION VALIDATION' || true"
  curl -sf https://us.2breeze.app/health
  ```
  Expected: `/health` is 200 and there are no validation errors in the log.
- [ ] **Step 6: Version parity** (CLAUDE.md "assert version parity after deploying"): run the documented `SKEW`/`OK` loop on the US droplet. Every line must be `OK`.
- [ ] **Step 7: Smoke from outside**:
  ```bash
  ID=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee
  curl -s -o /dev/null -w '%{http_code}\n' "https://$ID.us.<tunnel-domain>/"                       # 401 (unknown/unauth tunnel)
  curl -s -o /dev/null -w '%{http_code}\n' "https://$ID.us.<tunnel-domain>/api/v1/auth/me"         # 401, never the app's JSON
  curl -sI "https://$ID.us.<tunnel-domain>/" | grep -iE 'content-security-policy|cache-control|x-frame-options'
  curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Breeze-Tunnel-Site: 1' https://us.2breeze.app/api/v1/health  # not 421 → assertion stripped at the edge block
  ```
  Expected: `frame-ancestors https://us.2breeze.app 'self'`, `no-store`, and no `x-frame-options`.
- [ ] **Step 8: Rollback recipe** (record it, do not run it): remove the three `TUNNEL_*` lines from `.env`, then `docker compose up -d api caddy`. Path mode resumes immediately, and no data migration is involved.

### Task 18: Lab verification matrix (US, host mode on)

**Files:**
- Create: `docs/superpowers/plans/monitoring/evidence/tunnel-origin-lab-YYYY-MM-DD.md`. Results only, with device models and no IPs or hostnames.

- [ ] **Step 1: Devices.** Use (a) a SonicWall on SonicOS 7 (the #8110 splash-hang class), (b) a modern printer UI of the #5906 Xerox class (root-relative SPA), and (c) a device with a form-POST login (the login-loop class). All must be reachable from a lab agent. Never run a second agent on a host that has the installed agent (memory rule).
- [ ] **Step 2: Matrix.** Each device × Chrome stable, Firefox stable and Safari 26.x, × the iframe and the new tab. Record, for each cell: login works, the dashboard renders, a settings page renders, a static asset loads, `localStorage` works (DevTools), logout and re-login works, Close → "Disconnected" appears and further clicks in the iframe fail, and an idle re-mint works after 6 minutes.
- [ ] **Step 3: Negative checks** (one browser): (i) open two tunnels to different devices in two tabs and confirm from DevTools that a `fetch('https://<other-id>.us.<tunnel-domain>/', {credentials:'include'})` from tunnel A's console returns 403; (ii) register a service worker from tunnel A's console (`navigator.serviceWorker.register('/sw.js')`) and confirm it fails (404); (iii) confirm the `Application → Cookies` panel shows `__Host-bzt` as Partitioned in the iframe.
- [ ] **Step 4: Gate.** Every cell passes, or a filed issue explains a device-specific gap with path mode still available. Then commit the evidence file: `git add docs/superpowers/plans/monitoring/evidence && git commit -m "docs(network-proxy): host-mode lab matrix results"`.

### Task 19: EU enablement, PSL submission and the default-flip gate **[TODD for PSL + default flip]**

**Files:**
- None in repo, except the PSL PR link recorded in the spec results.

- [ ] **Step 1: EU.** Repeat Task 17 Steps 3–7 with `eu` in place of `us` and `TUNNEL_FRAME_ANCESTOR=https://eu.2breeze.app`. Run the version-parity loop on EU.
- [ ] **Step 2 [TODD]: PSL submission.** Open a PR to `publicsuffix/list` adding `us.<tunnel-domain>` and `eu.<tunnel-domain>` to the PRIVATE section (owner: LanternOps). Add the `_psl` TXT record on the tunnel zone with the PR URL, as the PSL requires. Record the PR URL in the spec results.
- [ ] **Step 3: Track inclusion.** Check monthly that the entries are in Chromium's, Firefox's and WebKit's shipped lists (the release notes or the bundled `effective_tld_names.dat` of a stable build). Record the version numbers when they are found.
- [ ] **Step 4 [TODD]: Default flip.** Only after Step 3 confirms inclusion in shipped lists for all three engines does Todd decide whether hosted users get host mode by default. The spec's opt-in-until-PSL rule applies. Until then, host mode stays env-enabled per region as rolled out above. Before the flip, the opt-in mechanism must be clarified with Todd. **Open item:** the spec does not say whether "opt-in" means per region (env, as built here) or per partner. If it means per partner, that is a follow-up wave needing a setting and a resolver, under the "Settings — one concept, one home" rules.

---

# W05 — WebSocket proxying (later; no tasks)

Host mode makes WebSocket upgrades feasible: the device owns its origin, and the Caddy tunnel block already keeps upgrade headers intact. But it needs an agent-side streaming channel (today's `http_request` command is request/response over the agent WebSocket), per-connection budgets, idle and close semantics tied to `tunnel_sessions`, and Close-time teardown across replicas. That is a separate spec, written after host mode has been the default for one release, and nothing in W00–W04 depends on it.

---

## Self-review (done while writing)

- **Spec coverage.**
  - §1 origin shape and PSL: Tasks 1, 19.
  - §2 config and validator: Task 1.
  - §3 routing, assertion, X-Forwarded-Host, Caddy 404 and real Caddy: Tasks 5, 10, plus W00 0.2.
  - §3 shared core: Task 2.
  - §4 enter, cookies, CHIPS fallback, new tab and revocation: Tasks 3, 8, 13, 14.
  - §4a admission: Task 7.
  - §5 rewriting, cookies and Origin: Tasks 6, 8.
  - §6 headers, SW and sandbox: Tasks 6, 7, 12, 13.
  - §7 web: Tasks 12–14.
  - §8 infra: Tasks 10, 17, 19, plus W00 0.1.
  - §9 checklist: Task 11 trace.
  - Waves: covered.
- **Placeholder scan.** No TBD or TODO. `<tunnel-domain>`, `<us-droplet>` and `<tunnel-uuid>` are deliberate operator inputs (never-commit values), defined in W00 Task 0.1.
- **Type consistency.** These names are used identically across tasks: `TunnelCookieContext` ('frame' | 'tab'), `getTunnelOriginConfig`, `matchTunnelHost`, `buildTunnelOrigin`, `HOST_COOKIE_AUDIENCE`, `activateTunnelSessionOnExchange`, `TUNNEL_CLOSED_ERROR`, `tunnelHttpCommandPrefix`, `ReachableTunnel`, `runTunnelRequestGates`, `dispatchTunnelHttpRequest`, `decodeUpstreamBody`, `TUNNEL_FRAME_COOKIE` / `TUNNEL_TAB_COOKIE`, `admitTunnelHostRequest`, `recordTunnelHttpOutcome`, `resolveProxyTarget`, and the message type `breeze-tunnel-cookie-blocked`.
- **Review Focus.** Each of the five lines has a pinning test in its owning task (Tasks 8, 1/5, 8, 7, 3/8).
