# Proxy Access Consolidation — session lifetime, single entry point, verified end-to-end

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 5-minute session cliff (both mechanisms), make proxy-tunnel status honest server-side, fold "Enable Proxy Access" into an idempotent single-port Connect, consolidate to one entry point on `/devices/network/:id`, and verify end-to-end against a live target. Closes #3199.

**Architecture:** Per-request `http_request` agent-command model unchanged (no streaming, 16 MiB cap, no WebSocket device UIs). Changes are: API-side session lifetime (sliding cookie refresh + observable 12 h cap + `lastActivityAt`), stop opening the unused legacy TCP socket for proxy tunnels, `active` at ticket exchange with lazy expiry on read, a new `POST /tunnels/proxy-connect` op, and web-UI consolidation. No agent changes.

**Tech Stack:** Hono routes, Drizzle + hand-written SQL migration, Vitest (unit + integration), React islands, i18n ×7 locales.

**Spec reference:** `docs/superpowers/specs/monitoring/2026-08-08-proxy-access-consolidation-design.md` (approved 2026-08-08). Read it fully before starting — it carries the review-hardened details (cap must write the row terminal; cookie refresh and activity bump pinned to one post-gate code point; collapse on the index key, not exact duplicates; no ticket in the proxy-connect response).

**Out of scope:** proxy rows in `/remote/sessions` history; `/remote` hub card; migrating existing over-broad `source='discovery'` allowlist rules; identity-link lifecycle (that's `2026-08-08-asset-link-lifecycle.md` / #3261).

**Coordination note:** both plans edit `AssetDetailModal.tsx` — land this plan's modal change (proxy-section removal) before the linking plan's (link-section removal).

---

## Task 1 — Migration + schema + export policy

- [ ] Write `apps/api/migrations/2026-08-XX-proxy-session-lifetime.sql` (idempotent, no inner BEGIN/COMMIT): `ALTER TABLE tunnel_sessions ADD COLUMN IF NOT EXISTS last_activity_at timestamptz`; collapse `tunnel_allowlists` rows colliding on `(org_id, direction, pattern, COALESCE(site_id,'00000000-0000-0000-0000-000000000000'))` — survivor = oldest row, `enabled = bool_or(enabled)` across the group, deletions wrapped in `DO $$ ... GET DIAGNOSTICS ... RAISE WARNING 'collapsed % duplicate allowlist rows'` (report even 0); then `CREATE UNIQUE INDEX IF NOT EXISTS` (expression index on the same key — no WHERE clause)
- [ ] Mirror `lastActivityAt` in `apps/api/src/db/schema/tunnels.ts`
- [ ] Register `last_activity_at` → `included` in `CORE_TENANT_EXPORT_POLICY` (`apps/api/src/services/tenantExportPolicyRegistry.ts`) — org-cascade table; skipping this passes PR CI and breaks main
- [ ] Migration test: re-apply is a no-op; collapse idempotent; index rejects re-insert
- [ ] `pnpm db:migrate && pnpm db:check-drift` (package-local if pnpm unusable — see memory)

## Task 2 — API: session lifetime (`tunnelHttp.ts`)

- [ ] Sliding refresh: after ALL gates (`loadOwnedTunnelSession` + owner/online/agent/policy re-checks, `tunnelHttp.ts:281-291`), at ONE code point: append refreshed cookie (same attrs, fresh 300 s maxAge) to `respHeaders` directly (`:421` — `setCookie(c,…)` will not attach to the hand-built `Response`) AND bump `lastActivityAt` (throttled: only when >30 s newer)
- [ ] 12 h absolute cap (`HTTP_TUNNEL_MAX_SESSION_HOURS = 12` off `createdAt`): mark row terminal (`status:'disconnected'`, `errorMessage:'session_expired'`, system-context write like the `tls_cert_untrusted` pattern `:357-361`) and 410 — never a silent in-iframe-only failure
- [ ] `status:'active'` at successful ticket→cookie exchange; `startedAt` only when still null
- [ ] Tests (`tunnelHttp.test.ts`): refresh cookie with Max-Age on the returned response's headers; 401 expired cookie; past-cap terminal write + 410; active at exchange, `startedAt` not reset on re-mint; throttling; NO bump on gate-rejected requests

## Task 3 — API: create/list lifecycle (`tunnels.ts`)

- [ ] Skip the `tunnel_open` agent command when `type === 'proxy'` (`:385-395`) — the raw TCP socket is unused on this path and its 5-min agent reap is death mechanism #2
- [ ] `POST /tunnels/:id/http-ticket`: 410 (coded) when past the 12 h cap
- [ ] `GET /tunnels`: lazy expiry before returning — flip caller-owned proxy rows to `disconnected` when `active` with `lastActivityAt` >10 min stale, OR `pending` >10 min old with `lastActivityAt IS NULL` (abandoned pre-exchange rows now have no reaper); join `devices` for per-row `siteId`; return server-computed `idleSeconds` (`now − COALESCE(lastActivityAt, createdAt)`)
- [ ] `POST /tunnels/allowlist`: map 23505 unique-violation → 409
- [ ] Tests (`tunnels.test.ts`): no `tunnel_open` for proxy; lazy expiry both branches; `siteId` + `idleSeconds` shape; http-ticket 410; 23505→409

## Task 4 — API: proxy-connect + error codes

- [ ] `POST /tunnels/proxy-connect` (same middleware stack as `POST /tunnels`): input `{deviceId, discoveredAssetId, port, scheme, skipTlsVerify}`; resolve asset org-checked, derive `ip`/`siteId`; ensure single-port rule `ip/32:<port>` (`direction:'destination'`, `siteId`, `discoveredAssetId`, `source:'discovery'`) — insert-if-absent upsert against the Task-1 index; existing-but-disabled rule → 403 `PROXY_TARGET_DISABLED` (never silently re-enable); create tunnel row; return `{tunnel}` only — NO ticket (the new tab mints its own)
- [ ] `GET /discovery/assets/:id` (`discovery.ts`): add `suggestedBridgeDeviceId` — the agent device from the asset's last discovery scan, else null
- [ ] `requireMfa()` 403 gains `code:'MFA_REQUIRED'` (`middleware/auth.ts:774-776`)
- [ ] Tests: proxy-connect idempotency (two calls → one rule); single-port pattern + siteId + discoveredAssetId; disabled-rule 403; MFA code; suggestedBridgeDeviceId

## Task 5 — Web: `ProxyTunnelPage`

- [ ] Poll handling: overlay "Session expired — Reconnect" when `status` terminal or `idleSeconds > 330`; kill the onLoad-only green badge over dead frames
- [ ] Reconnect: connectable row → re-mint ticket + reload iframe with fresh `?__bzt=`; terminal row → create new tunnel from `GET /tunnels/:id` fields (`deviceId/targetHost/targetPort/scheme/skipTlsVerify`) and navigate
- [ ] `tls_cert_untrusted` error screen: real "Reconnect allowing self-signed certificate" button (new tunnel with `skipTlsVerify:true`); no capability data in URLs (WEB2-01)
- [ ] Back → `/devices/network/<assetId>` when `asset` query param present, else `/remote`
- [ ] Tests: overlay on stale idleSeconds; both reconnect branches; TLS-retry navigation

## Task 6 — Web: entry point + consolidation

- [ ] `NetworkDeviceDetailPage.tsx`: per-port "Open Web UI" action on web-ish open-port pills (80/443/8080/8443/8006/9443/http/https service match) → popover titled "Proxy to {ip}:{port}" with "through agent" select (default `suggestedBridgeDeviceId`, NEVER `linkedDeviceId`), scheme, self-signed checkbox (https only), Connect via `runAction` → `window.open('/remote/proxy/<id>?target=…&asset=<assetId>')`
- [ ] `AssetDetailModal.tsx`: delete the whole Proxy Access section (`:608-728`) → link to `/devices/network/<assetId>`; delete `proxyEnabled` phantom state + `handleEnableProxy`/`handleConnectProxy`
- [ ] `OrgRemoteAccessSettings.tsx`: proxy rows link to `/remote/proxy/<id>?target=…`
- [ ] Tests: popover render/default/connect; modal renders link and no proxy mutations; settings row href

## Task 7 — Strings + docs

- [ ] All 7 locales (`de-DE,en,es-419,fr-CA,fr-FR,it-IT,pt-BR`) `remote.json`: fix `tunnelFailed` (:317, en = "Tunnel failed to open" per the sibling at :82) and `invalidTicket` (:313); rewrite `tlsUntrusted` for the in-place retry; new keys (popover, overlay, reconnect buttons)
- [ ] `apps/docs/.../remote-access.mdx`: new entry-point steps, real self-signed reconnect, session model (sliding activity window, 12 h cap, iframe-reload loses in-frame form state), accurate per-request description
- [ ] Prepend a superseded-by-spec note to `docs/superpowers/plans/monitoring/2026-06-25-network-proxy-http-reverse-proxy.md` (0/40 boxes; shipped without verification — don't let audits read it as complete)

## Task 8 — Verification

- [ ] Full API + web test suites AND the separate contract suites (`vitest.config.rls.ts`, `vitest.integration.config.ts` — export-policy + cascade tests live only there; local `pnpm test` green ≠ CI green)
- [ ] Live-target verification (the 2026-06-25 plan's never-done Task 8): real printer/switch web UI through a real agent — initial load, >5 min idle then resume, self-signed HTTPS retry, Settings visibility + kill; record in `docs/testing/FEATURE_TEST_LOG.md` replacing the `:3145` PARTIAL/BLOCKED entry
