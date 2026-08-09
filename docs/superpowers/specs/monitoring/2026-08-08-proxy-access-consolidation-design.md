# Proxy Access — entry-point consolidation, session lifetime, end-to-end verification

**Date:** 2026-08-08
**Status:** Approved (owner, 2026-08-08) — independent adversarial
code-verified review incorporated; Codex quorum unavailable.
**Plan:** `docs/superpowers/plans/monitoring/2026-08-08-proxy-access-consolidation.md`
**Issues addressed:** #3199
**Branch:** —

## Problem

Proxy access (viewing a non-agent LAN device's web UI — printer, switch, NAS, iLO —
bridged through an enrolled agent) shipped from the 2026-06-25 plan
(`docs/superpowers/plans/monitoring/2026-06-25-network-proxy-http-reverse-proxy.md`,
0/40 boxes checked) without a spec, without live-target verification
(`docs/testing/FEATURE_TEST_LOG.md:3145` — PARTIAL/BLOCKED), and with a cluster of
defects that share two root causes:

**Root cause A — the session dies at ~5 minutes via two independent mechanisms,
and the UI cannot see either.**

1. The `bz_tunnel_<id>` cookie is set only at ticket exchange
   (`apps/api/src/routes/tunnelHttp.ts:267-273`, `maxAge` 300 s, `clockTolerance` 0)
   and never refreshed → every iframe sub-resource 401s after 5 min.
2. `POST /tunnels` still fires the legacy `tunnel_open` command for `type:'proxy'`
   (`apps/api/src/routes/tunnels.ts:385-395`), so the agent dials a raw TCP socket
   the HTTP path never uses. The agent reaper closes it after 5 idle minutes
   (`agent/internal/tunnel/manager.go` `defaultIdleTimeout`), the resulting
   `tun-closed` flips the session to `disconnected`, and `loadOwnedTunnelSession`
   then 404s (`tunnelHttp.ts:169,283`).
3. The iframe is sandboxed without `allow-same-origin`
   (`apps/web/src/components/remote/ProxyTunnelPage.tsx:183-188`), so the parent
   cannot observe the 401/404s; the green "Connected" badge is driven purely by
   iframe `onLoad` (`:190`) and stays green over a dead frame.

**Root cause B — the enable/connect flow was built around phantom client state,
so every surface disagrees.**

4. `proxyEnabled` is returned by no API (repo-wide: zero hits in `apps/api`);
   `AssetDetailModal.tsx:103` reads `(asset as any)?.proxyEnabled`, so the modal
   always shows "Enable Proxy Access", and each click bare-inserts another
   allowlist row (`tunnels.ts:530-542` — no dedupe, no unique constraint).
5. The rule it inserts spans `ip/32:<minPort>-<maxPort>` across **all** discovered
   ports (`AssetDetailModal.tsx:278-290` — ports 22 and 9100 become `22-9100`) and
   omits `siteId`, making the rule invisible in the Settings rule list (which
   queries by site, `tunnels.ts:492`).
6. Server-side `status` never reaches `active` on this path — the only
   `status:'active'` write is the VNC relay handshake (`tunnelWs.ts:939`). The
   Settings "active tunnels" table (`GET /tunnels?status=active`, then a client
   filter on `t.siteId` — a column `tunnel_sessions` doesn't have) is therefore
   doubly empty for proxy.
7. Exactly one launcher exists in the whole app: Discovery → asset modal → fifth
   section. `/devices/network/:id` shows open-port pills with no action
   (`NetworkDeviceDetailPage.tsx:441-456`) and its "Manage in Discovery" deep link
   opens the modal **without a devices list** (`DiscoveryPage.tsx:709-720` passes
   no `devices` prop), so that path's proxy section can never connect. The proxy
   page's Back goes to `/remote`, which has no proxy entry. Settings rows offer
   only Kill.
8. On `tls_cert_untrusted` the error screen renders a string telling the user to
   recreate the session with "Allow self-signed certificate" — a checkbox that
   lives in the asset modal in the other tab. `apps/docs/.../remote-access.mdx:219-221`
   promises a "Reconnect (allow self-signed)" control that doesn't exist.
9. Broken locale strings shipped in all 7 locales: `remote.json:317`
   `"tunnelFailed": "Failed to tunnel failed"` (fr-CA/fr-FR translated it as
   "impossible de creuser un tunnel échoué") and `:313`
   `"invalidTicket": "Failed to invalid ticket"`.
10. MFA + `devices:execute` gate allowlist create, tunnel create, and http-ticket;
    the MFA 403 is a bare string with no machine-readable code
    (`apps/api/src/middleware/auth.ts:774-776`) → opaque failure for non-MFA techs.

## Goals

- One discoverable entry point: per-port "Open Web UI" on `/devices/network/:id`,
  with the asset modal linking there instead of duplicating the flow.
- Sessions that survive normal use: no 5-minute cliff, and an honest
  "Session expired — Reconnect" state when a session does die.
- Idempotent, single-port-scoped allowlisting folded into Connect; the standalone
  "Enable Proxy Access" step (and the phantom `proxyEnabled`) is deleted.
- Server-side status that matches reality, so Settings → Remote Access shows
  proxy sessions and its rows link back to them.
- A real "Reconnect (allow self-signed)" action on the TLS error screen, matching
  what the docs already promise.
- End-to-end verification against a live target, recorded in
  `FEATURE_TEST_LOG.md`.

## Non-goals (YAGNI)

- No persistent tunnel / streaming rewrite: the per-request `http_request` model,
  its 16 MiB body cap, `<base>`-tag URL limitations, and no-WebSocket constraint
  all stand (plan `:605`).
- No proxy rows in `/remote/sessions` history (`remote_sessions` is a different
  table with a closed enum; structural work with no user ask).
- No new card on the `/remote` hub — the entry point is the device page.
- No migration/narrowing of existing over-broad `source:'discovery'` allowlist
  rules — they are left in place (conservative; deleting user-visible security
  config in a migration is worse than the residual over-breadth, and each asset
  gains a correctly-scoped rule on next connect).
- No change to MFA/permission *requirements* — only to how the denial is surfaced.

## Architecture

### A. Session lifetime (API + agent path)

1. **Stop opening the raw TCP socket for proxy tunnels.** In `POST /tunnels`
   (`tunnels.ts:385-395`), skip the `tunnel_open` agent command when
   `type === 'proxy'`. Nothing on the HTTP path uses the socket; with it gone the
   agent reaper can no longer kill the session. (Agent needs no change; the
   `tun-open`/`tun-closed` handling for VNC is untouched.)
2. **Sliding cookie refresh.** In `tunnelHttp.ts`, re-issue the cookie with the
   same attributes and a fresh 300 s `maxAge` on every authenticated proxied
   response. **The refresh and the `lastActivityAt` bump (below) must live at
   the same single code point, after ALL gates** (`loadOwnedTunnelSession` +
   online/agent/policy re-checks, `:281-291`) — if they diverge, a
   policy-denied/offline stretch could keep `lastActivityAt` fresh over a dead
   cookie and resurrect the false green badge. Note the proxy handler returns a
   hand-built `Response`; the refreshed `Set-Cookie` must be appended to
   `respHeaders` itself (`:421`), not via `setCookie(c, …)`, or it silently
   no-ops. WEB2-01 is preserved — no ticket material ever re-enters a URL;
   refresh is pure `Set-Cookie`.
3. **Absolute cap, observable.** When the tunnel row's `createdAt` is older than
   `HTTP_TUNNEL_MAX_SESSION_HOURS = 12`, the proxy route marks the row terminal
   (`status:'disconnected'`, `errorMessage:'session_expired'` — same
   system-context write pattern as `tls_cert_untrusted`, `:357-361`) and 410s;
   `POST /tunnels/:id/http-ticket` also rejects past-cap rows with a coded 410.
   A cap that only 410s inside the sandboxed iframe would be invisible to the
   parent and produce a silent reconnect loop — the terminal row write is what
   lets the poll see it.
4. **`lastActivityAt` on `tunnel_sessions`.** New nullable timestamp column,
   updated by `tunnelHttp` at the point described in (2), throttled (write only
   when >30 s newer than stored). Migration is idempotent per the standard
   rules, and the column is registered in `CORE_TENANT_EXPORT_POLICY`
   (`included` bucket) in the same PR — `tunnel_sessions` is an org-cascade
   table, so an unregistered `ADD COLUMN` fails the export-policy integration
   suite (green-PR/red-main blind spot).
5. **Honest client state — server-computed idle.** `ProxyTunnelPage` already
   polls `GET /tunnels/:id` every 5 s. The API returns a server-computed
   `idleSeconds` (`now − COALESCE(lastActivityAt, createdAt)`) so the client
   never compares a server timestamp against the browser clock. When `status`
   is terminal, or `idleSeconds > 330` (cookie TTL + write-throttle slack),
   replace the green badge with a **"Session expired — Reconnect"** overlay.
   Reconnect mints a new one-time ticket (`POST /tunnels/:id/http-ticket`) and
   reloads the iframe with the fresh `?__bzt=` URL (stripped by the existing
   302). If the row is terminal (`disconnected`/`failed`), Reconnect instead
   creates a new tunnel from the row's own parameters (see D below) and
   navigates to it. (Reconnect reloads the iframe, so in-frame form state is
   lost — worth one line in the user docs.)

### B. Status + Settings

1. **`active` means "a client established a session".** Set `status:'active'`
   in `tunnelHttp` at successful ticket→cookie exchange (`startedAt` only when
   still null, so an idle-resume re-mint doesn't reset session duration).
   `pending` → `active` → `disconnected`/`failed` becomes the real lifecycle
   for proxy rows.
2. **Lazy expiry on read.** `GET /tunnels?status=active` flips stale proxy rows
   to `disconnected` before returning (bounded `UPDATE … WHERE` on the caller's
   own rows — no new reaper job): `active` rows with `lastActivityAt` older
   than 10 min, **and** `pending` rows older than 10 min with
   `lastActivityAt IS NULL` (with `tunnel_open` gone, an abandoned pre-exchange
   row would otherwise stay connectable and invisible forever).
3. **`siteId` via join.** `GET /tunnels` joins `devices` to expose the bridge
   device's `siteId` per row (no new column). `OrgRemoteAccessSettings` keeps its
   per-site grouping, which now actually matches rows.
4. **Clickable rows.** Proxy rows in the Settings table link to
   `/remote/proxy/<id>?target=…`; Kill stays as-is.

### C. Allowlist: fold Enable into Connect

1. **New idempotent server op.** `POST /tunnels/proxy-connect` (same middleware
   stack as `POST /tunnels`: scope + `DEVICES_EXECUTE` + MFA) takes
   `{deviceId, discoveredAssetId, port, scheme, skipTlsVerify}`. It:
   - resolves the asset (org-checked), derives `ip` and `siteId`;
   - **ensures** a single-port rule `ip/32:<port>` (`direction:'destination'`,
     `siteId`, `discoveredAssetId`, `source:'discovery'`) — insert-if-absent.
     If the matching rule exists but is **disabled**, do NOT re-enable (that
     would silently override an explicit admin denial): return a coded 403
     (`PROXY_TARGET_DISABLED`) the popover can render legibly;
   - creates the tunnel session and returns the row. **No ticket in the
     response** — the new tab (`ProxyTunnelPage`) always mints its own, so a
     bundled ticket would be one-time capability material minted for nothing.
2. **Dedupe at the DB.** Expression unique index (no `WHERE` clause — this is
   not a partial index) on
   `tunnel_allowlists (org_id, direction, pattern, COALESCE(site_id, '<nil-uuid>'))`;
   the ensure step upserts against it. The migration first collapses existing
   rows that collide **on the index key** (not merely exact-duplicate rows —
   legacy rows differ in `description`/`created_at`/`enabled`), with an explicit
   survivor rule: keep the oldest row, `enabled = bool_or(enabled)` across the
   group, and a `RAISE WARNING`-reported row count (forensic-trail rule from
   CLAUDE.md). Collapsing only exact duplicates would leave key collisions
   behind and abort the index build — rolling back the whole migration.
   The untouched `POST /tunnels/allowlist` (Settings) must map a 23505
   unique-violation to a 409 instead of a raw 500.
3. **`proxyEnabled` dies.** No Enable step remains, so nothing needs to report it.
   (`GET /discovery/assets/:id` is unchanged.)

### D. Entry-point consolidation (web)

1. **`/devices/network/:id` is the entry point.** Each open-port pill
   (`NetworkDeviceDetailPage.tsx:441-456`) whose port/service looks web-ish
   (80, 443, 8080, 8443, 8006, 9443…, or service matching http/https) gains an
   "Open Web UI" action opening a small connect popover titled
   **"Proxy to {ip}:{port}"**, with a **"through agent"** select (online
   devices), scheme (defaulted from port/service), "Allow self-signed"
   checkbox for https, Connect. The title+field wording states the whole
   relationship (proxy TO the target THROUGH an agent) so the agent picker
   can't be read as anything identity-related. **The bridge default is the discovering agent —
   never the identity-linked device.** `GET /discovery/assets/:id` exposes a
   `suggestedBridgeDeviceId` derived from the asset's last discovery scan's
   agent (fallback: first online device). The modal's current
   linked-device-first default (`AssetDetailModal.tsx:112-122`) is the last
   code-level conflation of identity link and proxy bridge — and it's
   semantically a loopback: the link asserts "this asset IS that device", so
   relaying *to* the asset *through* it is nonsense. The 2026-06-25 plan
   (`:581,:584`) specced the discovering-agent default and explicitly deferred
   it; this closes that follow-up. Connect calls `proxy-connect` via
   `runAction` (this component is already migrated) and opens
   `/remote/proxy/<id>` in a new tab (VNC precedent), with `&asset=<assetId>`
   carried for Back.
2. **Asset modal sheds its Proxy Access section.** `AssetDetailModal` replaces
   the whole section (`:608-728`) with a link to `/devices/network/<assetId>`.
   This also deletes the `devices`-prop dependency that made the
   `/discovery?asset=` deep-link path's proxy section permanently
   non-functional, and ends the two-identical-cards adjacency (Link picker and
   bridge picker were visually twin device dropdowns stacked in matching
   containers, `:552-605` / `:607-728`). While in the file, the surviving
   identity-link section is removed by the companion asset-link-lifecycle spec
   (#3261): linking becomes automatic-and-hidden (MAC/IP auto-link), with a
   read-only "Same device as {name}" display line here and the manual
   override (link/unlink) living only on the network device page. After both
   specs land, the modal carries **no device pickers at all** — which is the
   real fix for the two-twin-dropdowns confusion. (Auto-link/unlink lifecycle
   and list display are #3261's scope, not this spec's.)
3. **Back links.** `ProxyTunnelPage` Back targets
   `/devices/network/<assetId>` when the `asset` param is present, else `/remote`.
4. **TLS retry in place.** On `tls_cert_untrusted` (terminal `failed` row), the
   error screen shows **"Reconnect allowing self-signed certificate"**: the page
   reads the row's own `deviceId/targetHost/targetPort/scheme` from
   `GET /tunnels/:id`, POSTs a new tunnel with `skipTlsVerify:true`, and
   navigates to it. No capability data in URLs; the modal checkbox remains for
   opting in up front.
5. **MFA denial legible.** `requireMfa()` 403 gains `code:'MFA_REQUIRED'`
   (`middleware/auth.ts:774-776`); the connect popover and modal map it to a
   "Remote access requires two-factor authentication — enable it in your profile"
   message.
6. **Strings.** All 7 locales: fix `remote.json` `tunnelFailed` (en:
   "Tunnel failed to open" — copy of the correct sibling at `:82`) and
   `invalidTicket`; rewrite `tlsUntrusted` to match the new in-place retry; new
   keys for the popover, expiry overlay, and reconnect buttons.
7. **Docs.** Update `remote-access.mdx`: new entry-point steps, the now-real
   "Reconnect (allow self-signed)" behavior, session-lifetime description
   (sliding activity window, 12 h cap), and drop the "traffic tunnels" phrasing
   for an accurate per-request description.

## Data flow

```
/devices/network/:id ──"Open Web UI" popover── POST /tunnels/proxy-connect
     │                                              │ ensure ip/32:<port> rule (idempotent;
     │                                              │   disabled rule → 403 PROXY_TARGET_DISABLED)
     │                                              │ insert tunnel row (pending)
     │                                              └ returns {tunnel}   (no ticket)
     └── window.open /remote/proxy/<id>?target=…&asset=<assetId>
              │ page mints own ticket (POST /tunnels/:id/http-ticket)
              │ iframe /api/v1/tunnel-http/<id>/?__bzt=<ticket>
              │   ticket→cookie (302, strips __bzt)  → status:'active'
              │   per request: re-check owner/online/policy, 12h cap
              │                → http_request cmd → agent local fetch
              │                → refresh cookie + bump lastActivityAt (same point)
              └ poll GET /tunnels/:id (idleSeconds) ── stale/terminal → "Expired — Reconnect"
```

## In-scope fixes

| Site | Change |
|---|---|
| `apps/api/src/routes/tunnels.ts` | skip `tunnel_open` for proxy; `proxy-connect` op; allowlist ensure/dedupe (+ 23505→409 on the Settings route); lazy expiry (`active` stale + abandoned `pending`) + `siteId` join + `idleSeconds` in `GET /tunnels`; past-cap 410 on http-ticket |
| `apps/api/src/routes/tunnelHttp.ts` | sliding cookie refresh + `lastActivityAt` bump (single point, post-gates, via `respHeaders`); 12 h cap → terminal row write + 410; `active` on ticket exchange (`startedAt` if null) |
| `apps/api/src/middleware/auth.ts` | `code:'MFA_REQUIRED'` on the MFA 403 |
| `apps/api/src/routes/discovery.ts` | `suggestedBridgeDeviceId` (discovering agent) on `GET /discovery/assets/:id` |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | `last_activity_at` → `included` (org-cascade table; unregistered ADD COLUMN fails the integration suite) |
| `apps/api/migrations/2026-08-XX-*.sql` | `lastActivityAt` column; key-collision collapse (oldest survives, `bool_or(enabled)`, row-count warned) + expression unique index |
| `apps/web/src/components/devices/NetworkDeviceDetailPage.tsx` | per-port "Open Web UI" popover (runAction) |
| `apps/web/src/components/discovery/AssetDetailModal.tsx` | delete Proxy Access section → link to device page |
| `apps/web/src/components/remote/ProxyTunnelPage.tsx` | expiry overlay + Reconnect; TLS retry button; Back to asset |
| `apps/web/src/components/settings/OrgRemoteAccessSettings.tsx` | clickable proxy rows |
| `apps/web/src/locales/*/remote.json`, `*/discovery.json` (×7) | broken strings; new keys |
| `apps/docs/src/content/docs/features/remote-access.mdx` | corrected flow + session model |
| `docs/superpowers/plans/monitoring/2026-06-25-…-reverse-proxy.md` | mark superseded-by-this-spec so audits aren't misled by 0/40 |

## Error handling

- Cookie expired mid-idle → next poll shows the expiry overlay; Reconnect
  re-mints without recreating the tunnel (row still connectable).
- Row terminal (`disconnected`/`failed`) → Reconnect creates a fresh tunnel from
  the row's parameters and navigates.
- `tls_cert_untrusted` → in-place "Reconnect allowing self-signed" (new tunnel,
  `skipTlsVerify:true`).
- Agent offline / policy denied at any proxied request → existing 502/403 paths
  unchanged; the overlay's Reconnect will surface the create-time error
  (`REMOTE_ACCESS_POLICY_DENIED`, `MFA_REQUIRED`, `PROXY_TARGET_DISABLED`) via
  `runAction`.
- 12 h absolute cap → proxy route writes the row terminal
  (`errorMessage:'session_expired'`) and 410s; http-ticket mint also 410s. The
  poll's terminal branch then drives the overlay — never a silent in-iframe 410.
- Rule exists but disabled by an admin → `proxy-connect` 403
  `PROXY_TARGET_DISABLED`; the popover renders it; no silent re-enable.

## Testing

- `tunnelHttp.test.ts`: refresh cookie present (with `Max-Age`) **on the
  returned response's headers** on authenticated responses; 401 on expired
  cookie; past-cap request writes the row terminal and 410s; `active` set at
  exchange, `startedAt` not reset on re-mint; `lastActivityAt` throttling and
  no bump on gate-rejected (offline/policy-denied) requests.
- `tunnels.test.ts`: proxy create sends **no** `tunnel_open`; `proxy-connect`
  idempotency (two calls → one rule); disabled rule → 403
  `PROXY_TARGET_DISABLED` without re-enabling; single-port pattern + `siteId` +
  `discoveredAssetId` on the ensured rule; Settings allowlist route maps 23505
  → 409; lazy expiry flips stale `active` AND abandoned `pending` rows;
  `siteId` join + `idleSeconds` shape; http-ticket 410 past cap.
- Migration test: key-collision collapse is idempotent (oldest survives,
  `bool_or(enabled)`); unique index rejects re-insert.
- Agent: existing `handlers_httpproxy_test.go` unchanged; add a truncation-flag
  case (16 MiB) while in the area.
- Web: `NetworkDeviceDetailPage` popover render + connect via `runAction`,
  bridge default = `suggestedBridgeDeviceId` (never `linkedDeviceId`);
  `ProxyTunnelPage` expiry overlay on stale `lastActivityAt`, TLS-retry
  navigation; `AssetDetailModal` renders link, no proxy mutations remain.
- **Live-target verification (the plan's unfinished Task 8):** against a real
  printer/switch web UI through a real agent — initial load, >5 min idle then
  resume, self-signed HTTPS retry, Settings visibility, kill. Record in
  `FEATURE_TEST_LOG.md` replacing the `:3145` PARTIAL/BLOCKED entry.

## Build sequence (for the implementation plan)

1. Migration: `lastActivityAt` (+ export-policy registration), key-collision
   collapse + expression unique index (+ 23505→409 on the Settings route).
2. API: skip `tunnel_open` for proxy; cookie refresh + cap (terminal write);
   `active` at exchange; `lastActivityAt`; lazy expiry + `siteId` join +
   `idleSeconds`.
3. API: `proxy-connect` (ensure + create, no ticket); `MFA_REQUIRED` +
   `PROXY_TARGET_DISABLED` codes.
4. Web: `ProxyTunnelPage` overlay/reconnect/TLS-retry/Back.
5. Web: network-device popover; modal section removal; Settings links.
6. Strings (×7 locales) + docs + mark old plan superseded.
7. Live-target verification + `FEATURE_TEST_LOG.md`.

## Rollback / risk

- Each phase is independently revertible; the migration only adds a column and
  an index (duplicate collapse is the one destructive step — logged with counts).
- Biggest behavioral risk: flipping `active` at exchange changes what
  `GET /tunnels?status=active` returns for existing dashboards — mitigated by
  the lazy expiry keeping the list honest.
- Sliding refresh extends session exposure vs the old hard 300 s: bounded by the
  12 h cap, per-request policy/online re-checks, and the unchanged MFA gate at
  ticket mint.
