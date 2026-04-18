# VNC-in-Viewer — session handoff (2026-04-17)

## Where we are

**PR #476** is open on `feature/vnc-desktop-fallback-deeplink` with 3 commits. The full in-viewer WebRTC↔VNC switcher (PRs #471, #472, #473) has shipped in `v0.62.25-rc.6`. This PR fixes the issues that surfaced during end-to-end testing of rc.6:

1. `9254210e` — `ConnectDesktopButton`'s VNC auto-fallback now hands off to the Tauri viewer via `breeze://vnc?...&code=...` deep link instead of navigating the browser straight to `/remote/vnc/:id`. (Previously only the secondary "VNC Remote" button did this; the primary "Remote Desktop" button bypassed the viewer.)
2. `337b2d4f` — Six discovered-during-testing bugs bundled:
   - API: `POST /vnc-exchange` now builds `wsUrl` from `PUBLIC_APP_URL` instead of `c.req.url`. Behind Caddy-behind-Cloudflare, `c.req.url` sees the internal HTTP hostname → viewer got `ws://` to an unreachable host.
   - Viewer: `pollDesktopAccess` and `tunnel.ts` were missing the `/api/v1/` prefix → 404s routed through to the web catch-all → looked like 403 CORS preflight failures to the viewer.
   - Viewer: `DesktopViewer` now calls `setTransportState('vnc')` BEFORE constructing RFB so the container `<div>` is visible at construction (RFB caches 0×0 dimensions otherwise).
   - Viewer: `vnc.ts` grew a `ResizeObserver` that toggles `scaleViewport` on container resize, mirroring the web client.
   - Viewer: `vite.config.ts`'s `optimizeDeps.esbuildOptions.target` now `esnext` so `pnpm tauri dev` can prebundle noVNC's top-level await.
   - Viewer (Tauri/Rust): `auto_update` is skipped in debug builds so `pnpm tauri dev` can't get clobbered by `latest.json` pointing at an older stable.
   - docker-compose: `PUBLIC_APP_URL` / `DASHBOARD_URL` now defer to `.env` overrides so deployments that decouple from `BREEZE_DOMAIN` (Caddy stays on `:80`, Cloudflare fronts TLS) can set them directly.
3. `92d51fe3` — Two WKWebView-specific fixes so VNC frames actually render:
   - `rfb.resizeSession = true` — macOS Screen Sharing was sending raw 2940×1912 (~22 MB) frames to Retina Macs. WKWebView couldn't keep up. With resize negotiation enabled, the server right-sizes its framebuffer.
   - **16 ms pump** — `setInterval` that calls `rfb._handleMessage()` directly whenever the receive queue has data. WKWebView batches WebSocket message delivery so noVNC's handler fires in bursts and the decoder stalls waiting for the next event; continuous pumping drains the queue incrementally like Safari does naturally.

All changes have 89/89 viewer tests green, 11/11 API tunnel tests green, `tsc --noEmit` clean.

## What works end-to-end now

- Click "Remote Desktop" on a macOS device at the login window → agent reports `desktopAccess.mode=unavailable` → web issues tunnel + short-lived connect code → deep-links `breeze://vnc?tunnel=...&code=...` to the Tauri viewer.
- Viewer exchanges the code (one-shot, 60 s TTL) for a fresh access token + wsUrl.
- noVNC prompts for macOS username + password (ARD auth), operator enters them, screen renders.
- Input works, cursor works, keyboard works.
- Auto-handoff between WebRTC ↔ VNC still works (not regressed).

## What's still broken — open work

### 1. Agent WebSocket reconnect during active tunnels (HIGH)

**Symptom:** viewer renders the Mac login screen fine for a while, then freezes. The diag pattern at freeze:

```
[VNC-diag] ws: 1 ... FBUs-recv: 126 FBU-reqs-sent: 127 ... rQ-len: 0
```

— pending request from client, server silent, viewer's WS still open, but no bytes flowing.

**Root cause (confirmed via API logs during a freeze):**

```
Agent 63e4fe1a... disconnected. Active connections: 3
Agent 63e4fe1a... connected via WebSocket. Active connections: 4
```

The Mac agent's control WebSocket is dropping and reconnecting. When it dies, any in-flight tunnel-ws for that agent goes with it, so `screensharingd` data stops reaching the API. The viewer's own WS stays connected so it doesn't see an error — it just waits forever for updates that never come.

This is **not** a VNC/WKWebView issue — it affects every long-running tunnel the agent owns. Likely candidates:
- Cloudflare WebSocket idle timeout (~100 s) — agent's keepalive may not be pinging often enough under CF's fronting.
- Local network blips, DNS hiccups on the Mac.
- Agent's heartbeat interval is too sparse.

**Where to start:**
- Check `agent/internal/ws/` or equivalent for WS keepalive / ping interval.
- Look at agent diagnostic logs via `docker exec -i breeze-postgres psql -U breeze -d breeze` — filter `device_id=804d096a-6400-4c6d-ab2a-8bee3e69268a` for "websocket closed" / "reconnecting" messages and correlate timing with viewer freezes.
- If this is Cloudflare timing out, bumping the agent's ping interval to <60 s should fix it.
- Consider tunnel-ws auto-reestablish: when agent reconnects, the API could notice which tunnels the agent owned and re-open them instead of letting the viewer/user reconnect manually.

### 2. Token-expiry polling loop stops silently (MEDIUM)

`pollDesktopAccess` correctly detects 401/403 and stops polling (fix #3 in prior commit). But the viewer doesn't surface this — the "Switch to WebRTC" pill just stops updating and no error is shown. On long sessions past the access token's 15 min TTL, operators don't know why the pill seems dead.

**Fix:** when `pollDesktopAccess` returns `{ ok: false, reason: 'unauthorized' }`, surface a subtle UI indicator — e.g., change the toolbar dropdown's subtitle to "Session token expired; disconnect + reconnect to refresh" or similar.

### 3. Diagnostic logging dropped in the final commit (LOW)

The `[VNC-diag]` 2-second logger + RFB internal hooks were stripped from `vnc.ts` for the committed version — they were noisy and looking like production debug logs. If future WKWebView issues surface, the instrumentation is in commit `3fa41aef` (pre-strip) on this branch's reflog, or can be re-added quickly following the same pattern.

## How to run the dev flow locally

For reference so the next session can test quickly:

**Docker (code-mounted hot reload):**
```bash
cd /Users/toddhebebrand/breeze
ln -sf docker-compose.override.yml.dev docker-compose.override.yml
docker compose up --build -d
```
Containers use `breeze-api:dev` / `breeze-web:dev` built from local source.

**.env prerequisites** (already set on this machine):
- `PUBLIC_APP_URL=https://2breeze.app` — explicit, separate from `BREEZE_DOMAIN`. Required because docker-compose now reads these from `.env` first.
- `DASHBOARD_URL=https://2breeze.app` — same.
- `BREEZE_DOMAIN` stays commented out (Caddy stays on `:80`, Cloudflare fronts TLS).

**Viewer dev build** (version bumped to 999.0.0 locally so Tauri updater can't downgrade; do NOT commit the bump):
```bash
cd apps/viewer/src-tauri
# Edit tauri.conf.json, set "version": "999.0.0" (temporarily — don't commit)
cd ..
pnpm tauri build
# DMG at src-tauri/target/release/bundle/dmg/Breeze Viewer_999.0.0_aarch64.dmg

# Install over any existing viewer:
killall "Breeze Viewer" 2>/dev/null
rm -rf "/Applications/Breeze Viewer.app"
open "src-tauri/target/release/bundle/dmg/Breeze Viewer_999.0.0_aarch64.dmg"
xattr -dr com.apple.quarantine "/Applications/Breeze Viewer.app"
```

Open devtools in the viewer: right-click → Inspect Element, or Cmd+Option+I.

**Target device for testing:** macOS device id `804d096a-6400-4c6d-ab2a-8bee3e69268a` (the user's Mac next to them).

## Process notes for the next session

- The VNC work is ~3 days of effort over many PRs. Don't rewrite from scratch; the switcher infrastructure, deep-link auth flow, and tunnel plumbing all work. Focus on fixes.
- PR #476 should probably land before any more work on top of it.
- Force-pushing to `feature/vnc-desktop-fallback-deeplink` is safe — it's the user's own branch, only PR #476 attached, no other collaborators.
- The user has a working Breeze Viewer installed at `/Applications/Breeze Viewer.app` (as of session end, 999.0.0 build from this branch). They can reinstall via the `pnpm tauri build` flow above.

## Files of note

- `apps/viewer/src/lib/transports/vnc.ts` — VNC transport implementation, where the pump + resizeSession live.
- `apps/viewer/src/lib/desktopAccess.ts` — polling helper that distinguishes 401 from network errors.
- `apps/viewer/src/lib/tunnel.ts` — `createVncTunnel` / `closeTunnel` for the viewer's auto-handoff tunnel creation.
- `apps/viewer/src/components/DesktopViewer.tsx` — the main switcher component; see `connectVncTransport`, `switchTransport`, `attemptReconnect` (VNC branch), and the `case 'desktop_state':` handler.
- `apps/api/src/routes/tunnels.ts` — `POST /tunnels/:id/connect-code` (line ~540) and `POST /vnc-exchange/:code` (line ~620). The exchange builds wsUrl from `PUBLIC_APP_URL`.
- `apps/api/src/services/remoteSessionAuth.ts` — `createVncConnectCode` / `consumeVncConnectCode`, mirrors the desktop connect-code pattern.
- `apps/web/src/components/remote/ConnectDesktopButton.tsx` — primary button, VNC auto-fallback issues a code + tries the deep link.
- `apps/web/src/components/remote/ConnectVncButton.tsx` — secondary "VNC Remote" button.

## Spec + plan reference

- `docs/superpowers/specs/2026-04-16-viewer-webrtc-vnc-switcher-design.md`
- `docs/superpowers/plans/2026-04-16-viewer-webrtc-vnc-switcher.md`
