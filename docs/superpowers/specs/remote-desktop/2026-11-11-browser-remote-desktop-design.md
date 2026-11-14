---
title: In-browser remote desktop — a WebRTC desktop session in a dashboard tab, for technicians the native viewer cannot serve (Linux first)
status: draft r2 2026-11-11 — revised after an independent design review; awaiting Todd's approval (Gate A)
date: 2026-11-11
related: "#9557 (Linux viewer has no WebRTC); PR #11642 (WebKit settings + documented limitation, merged); #3410, #7415 (WebSocket fallback, service-mode refusal message); precedents: in-browser VNC page, web terminal"
---

# In-browser remote desktop

## 1. Why

A technician on Linux cannot open a remote desktop on a Windows device. Windows agents run as a service, a
service-mode agent accepts desktop over WebRTC only, and the Linux Breeze Viewer has no WebRTC because the
WebKitGTK it bundles is compiled without it. PR #11642 turned on the WebKit settings the viewer was missing and
documented the limitation. It does not make the Linux viewer reach Windows devices.

The maintainer chose to fix this by running the desktop session in a normal browser tab opened from the
dashboard, rather than by shipping a custom WebKitGTK or a Chromium shell for the viewer (#9557, comments of
2026-11-10). A browser session removes the Linux packaging problem instead of moving it, and also serves anyone who
cannot install the viewer.

**Success:** a technician on Linux, in a Chromium-based browser, clicks Connect Desktop on a Windows device and
gets a working session (picture, input, clipboard) in a tab. They don't install anything and no new sign-in path is
involved. A browser that cannot show the stream gets a clear message instead of a blank picture, and cannot send
input to a screen it isn't showing. Audio is in scope only once its negotiation is fixed (§5.10, W3).

### Current state (verified on `main` at `ae686e1ee4`, by reading code; nothing run)

| # | Fact | Source |
|---|---|---|
| F1 | A service- or headless-mode agent refuses the WebSocket desktop stream. Only the WebRTC start is handed to the helper in that mode. | `agent/internal/heartbeat/handlers_desktop.go:711-715`, `:335` |
| F2 | The agent registers pion's default codecs and sends one H.264 track at `profile-level-id=4d001f` (Main, level 3.1, `packetization-mode=1`). It answers PLI/FIR with a keyframe, rate-limited to one per 500 ms after the first. | `agent/internal/remote/desktop/session_webrtc.go:88-91`, `:174-181`, `:213-225` |
| F3 | The viewer makes the offer and the agent answers. The offer has one receive-only **video** transceiver with no codec preference, plus data channels. It has **no audio transceiver**. | `apps/viewer/src/lib/webrtc.ts:224-236`, `:396-412`; `session_webrtc.go:745-754` |
| F4 | The dashboard mints a one-time desktop connect code (`POST /remote/sessions/:id/desktop-connect-code`) and puts it in a `breeze://connect?...&code=...` deep link. | `apps/api/src/routes/remote/sessions.ts:854-899`; `apps/web/src/components/remote/ConnectDesktopButton.tsx:550-572` |
| F5 | The viewer redeems the code at `POST /desktop-ws/connect/exchange` with a plain `fetch` (no auth retry) for a JWT with audience `breeze-viewer`, scoped to one session, 2 h lifetime. | `apps/viewer/src/lib/api.ts:57-70`; `apps/api/src/routes/desktopWs.ts:1784-1851`; `apps/api/src/services/jwt.ts:15`, `:353-375` |
| F6 | The dashboard has no WebRTC code. No file under `apps/web/src` references `RTCPeerConnection`. The web terminal is WebSocket + xterm. | search of `apps/web/src`; `apps/web/src/components/remote/RemoteTerminal.tsx:20`, `:337` |
| F7 | The in-browser VNC page is a thin Astro page (`Layout` + `AuthOverlay` + `ToastContainer` + one `client:only` React island). Its URL carries only the tunnel id, and the page mints its own one-time WebSocket ticket with the dashboard's session. | `apps/web/src/pages/remote/vnc/[tunnelId].astro:14-27`; `apps/web/src/lib/remoteTunnelUrls.ts:1-3`; `apps/web/src/components/remote/VncViewerPage.tsx:52` |
| F8 | 7 of the viewer's 58 non-test source files import `@tauri-apps/*`: `App.tsx`, `components/DesktopViewer.tsx`, `components/QuitConfirm.tsx`, `components/UpdateIndicator.tsx`, `lib/clipboardIO.ts`, `lib/devicePrefs.ts`, `lib/updateActions.ts`. `lib/webrtc.ts` and the input, keymap, ICE and stats modules do not. | search of `apps/viewer/src` |
| F9 | `DesktopViewer.tsx` (3,203 lines, the video and input component) calls Tauri for the window title (`:879`, `:1250`), one-window-per-device registration (`:1349-1380`, `:2852`), saving screenshots (`:2766`), and the clipboard read behind **paste-as-keystrokes**, which is an input path (`:2192-2210`). | `apps/viewer/src/components/DesktopViewer.tsx` |
| F10 | The viewer already has seams a host adapter can use. Clipboard goes through `LocalClipboardIO`, preferences through `PrefsStore`, and Keyboard Lock through `navigator.keyboard`, with a silent no-op where it is missing. | `apps/viewer/src/lib/clipboardSync.ts:58-64`; `apps/viewer/src/lib/devicePrefs.ts:22-25`; `apps/viewer/src/lib/keyboardLock.ts:1-24` |
| F11 | The viewer has no i18n. No file in `apps/viewer/src` imports an i18n library; its UI strings are English literals. | search of `apps/viewer/src` |
| F12 | Creating a desktop session ends the caller's other live sessions of the same type on the same device. | `apps/api/src/routes/remote/sessions.ts:312-355` |
| F13 | The shared component falls back to the WebSocket transport when WebRTC fails, and has an in-session switch to VNC relay and back. Both use viewer-token endpoints. | `DesktopViewer.tsx:1258-1276`, `:666-720` |
| F14 | The native viewer runs in its own Tauri document with its own CSP. The dashboard keeps its access token in page memory. | `apps/viewer/src-tauri/tauri.conf.json:13`; `apps/web/src/stores/auth.ts:364-372` |

### Spike claims checked

The scoping comment on #9557 was a read-only code read. Checked against `main`:

- **No new auth path needed.** Correct (F4, F5). A tab can mint and redeem the same code. §6 does both inside the
  tab so the code never crosses a boundary.
- **About 7 of ~60 viewer files touch Tauri.** Correct: 7 of 58 (F8).
- **None of them are in streaming or input.** Wrong. `lib/webrtc.ts` and the input libraries are Tauri-free, but
  `DesktopViewer.tsx`, which owns the video element and all input handling, imports `invoke` at line 2. Its
  paste-as-keystrokes path reads the clipboard through the Tauri plugin before typing it into the remote (F9). Every
  call can go behind an adapter, so sharing still works, but the component needs surgery, not just a move.
- **The VNC page is a layout template.** Correct (F7).
- **The web terminal is WebSocket + xterm; the dashboard has no WebRTC.** Correct (F6).
- **Viewer offers, agent answers; default codecs plus an H.264 Main `4d001f` track.** Correct (F2, F3).

## 2. Goals

1. A desktop session to any device the technician can already reach, in a tab of a Chromium-based browser, with
   picture, mouse, keyboard, clipboard, monitor switching and view-only. It uses the WebRTC pipeline the viewer
   already uses. Audio is added once W3 has fixed its negotiation (§5.10).
2. One viewer frontend, shared by the Tauri app and the dashboard, so a fix to streaming or input lands in both.
3. No new authentication or authorization path. Every check that gates the native viewer gates the tab, at the
   same points.
4. A browser that cannot show the stream is told so, either before a session is created or as soon as the media
   proves it. Remote input is never live while the technician cannot see the screen.
5. The audit trail records the origin that redeemed the viewer credential, so a browser start can be told apart.

## 3. Non-goals

- Firefox support in v1, or any browser without H.264 WebRTC decode (maintainer decision 2026-11-11).
- A VP8 fallback on the agent (follow-up, §15).
- Fixing the Linux native viewer (custom WebKitGTK or Chromium shell). Not planned.
- VNC-relay sessions or the WebSocket stream in the new page (§5.4).
- Isolating the session in a separate origin (deferred, §5.2 option E).
- Remote desktop on the mobile app or in the customer portal.
- Recording, file transfer or multi-session switching beyond what the viewer already does.

## 4. Anti-goals: a failure even if it technically works

- **The connect code or viewer token appears in a URL, browser history, a `Referer` header, a server access log,
  `postMessage` or a telemetry payload.**
- **A reload, restored tab, bookmark or forwarded link starts a session the technician did not just ask for**, or
  silently replaces one.
- **A Firefox user sees a black rectangle and a spinner**, or can type into a remote screen they cannot see.
- **The native viewer regresses** because of the extraction. It ships to technicians' machines on three OSes.
- **A second sign-in path**, or a check that runs for the viewer but is skipped for the tab.
- **The browser option crowds out the native viewer** on Windows and macOS, where the viewer is the better tool,
  or overrides a partner's configured third-party remote tool.
- **A session outlives the technician's sign-out** in any tab.

## 5. Design

### 5.1 Who it is for, and where it is offered

Linux technicians first. It works on any OS, and it also helps anyone who cannot install the viewer, such as a
locked-down workstation or a borrowed machine.

**Recommendation (D1):** offer it on every OS, but make it the default only on Linux, and only within the built-in
path.

- **A configured third-party remote tool stays the default.** Today the partner's default tool launches before the
  built-in viewer is considered (`ConnectDesktopButton.tsx:489-492`), and that order is kept.
- **Linux** (detected by the existing `detectOS` helper, `apps/web/src/lib/viewerDownload.ts:45-65`): where the
  built-in path is the default, the primary click opens the browser session. "Breeze Viewer" stays in the menu for
  devices the Linux viewer can reach (macOS and Linux agents not in service mode).
- **Windows and macOS:** the built-in default still hands off to the viewer. "Open in browser" is in the menu, and
  on the card shown when the viewer did not pick up the deep link (`ConnectDesktopButton.tsx:636-637`).

OS detection only picks the default here. It never decides whether the browser session is allowed; that is the
preflight in §5.7.

### 5.2 Sharing the viewer frontend

Options:

| Option | For | Against |
|---|---|---|
| **A. Shared workspace package behind a host adapter** (`packages/remote-desktop-ui`, source-exported like `packages/document-ui`) | One copy of the streaming and input code. A Tauri-free package can be enforced by a test. Precedent exists: `@breeze/document-ui` is consumed from source (`packages/document-ui/package.json`, `main: ./src/index.ts`) and has its own CI job (`.github/workflows/ci.yml:1554-1585`). Both apps already use React 19, Tailwind 4 and zustand 5 (`apps/viewer/package.json`, `apps/web/package.json`). | The largest piece of work. It touches the shipped native viewer. Web's Tailwind must scan the package's sources (inferred). |
| B. Web imports from `apps/viewer/src` by path alias | No package to create | One app reaching into another app. Breaks as soon as the viewer moves a file. Tauri imports leak into the web bundle. |
| C. Build the viewer as a separate static bundle and serve it under the web origin | No refactor of the component | A second React and Tailwind build. It escapes web theming, i18n, `AuthOverlay` and the toast host. A second CSP surface to keep right. Same origin as the dashboard, so no isolation gain. |
| D. Copy the viewer code into web | Fast | Two copies of a 3,200-line component that drift. Every input fix must be made twice. |
| E. **A separate-origin viewer shell** (option A's package, served from its own origin with a minimal CSP and no dashboard scripts, launched with a one-time code) | The only option that puts the live session outside the reach of script running in the dashboard origin (§5.6). Independent of A: it reuses the same package. | A second origin to deploy, configure and certify, plus a cross-origin code hand-off, CORS, cookies and the self-hosting docs. Self-hosters would need another hostname. |

**Recommendation: A for v1, with E recorded as the deferred isolation option.** A is needed for E anyway, so
choosing A now loses nothing. The scoping comment also noted that a Chromium shell for the Linux viewer would need
the same adapter refactor.

**What moves into the package:** the Tauri-free libraries (F8, including `webrtc.ts`, `iceTrickle.ts`,
`reliableInput.ts`, `inputSequencer.ts`, `keymap.ts`, `wheel.ts`, `clipboardSync.ts`, `statsReporter.ts`,
`revocationLease.ts`, `keyboardLock.ts`, `transports/`) and their tests, then `DesktopViewer.tsx`, `ViewerToolbar.tsx`
and the chips and modals it renders, with every Tauri call replaced by a host call.

**What stays in `apps/viewer`:** `App.tsx` (deep-link intake, `parseDeepLink`), `QuitConfirm.tsx`,
`UpdateIndicator.tsx`, `updateActions.ts`, and the Tauri host implementation.

### 5.3 The host adapter

A single interface the package receives as a prop or context. Draft shape (left to the builder):

| Host capability | Tauri host (today's behaviour) | Browser host |
|---|---|---|
| `connect` (how the viewer gets a session id and a viewer token) | Deep-link params (`protocol.ts:7-14`), then `exchangeDesktopConnectCode` | The launch transaction in §6.1 |
| `transports` (which transports and hand-offs are allowed) | WebRTC, WebSocket fallback, in-session VNC switch (F13) | WebRTC only (§5.4) |
| `clipboard: LocalClipboardIO`, and the paste-as-keystrokes read | `createTauriClipboardIO` (`clipboardIO.ts:68`); Tauri `readText` (`DesktopViewer.tsx:2200`) | Async Clipboard API. Text and PNG in Chromium. Reads need the `clipboard-read` permission; any read or write needs the page focused. |
| `prefs: PrefsStore` | Tauri store (`devicePrefs.ts:137-139`) | `localStorage` behind try/catch, falling back to the in-memory store (`devicePrefs.ts:123`) |
| `setTitle(hostname)` | `update_session_hostname` | `document.title` |
| `registerSession` / `registerDevice` (one window per device) | Tauri commands (`DesktopViewer.tsx:1349-1380`) | `BroadcastChannel` per device: a newer tab tells an older tab for the same device that it was replaced, so the older tab shows "Opened in another tab" instead of a generic revocation. The server already ends the older session (F12). |
| `saveScreenshot(bytes)` | `save_screenshot` (`DesktopViewer.tsx:2766`) | Download via a blob URL |
| `fullscreen` + Keyboard Lock | Already through `navigator.keyboard` (`keyboardLock.ts`) | The same code. Chromium honours the lock only in fullscreen. |
| `onLeave` (closing with a live session) | `QuitConfirm` | `beforeunload` prompt while connected (§5.6) |
| `onSignOut` | None | Teardown on sign-out or account change (§6.3) |
| `strings` (UI copy) | English catalog | The web i18n `t` for the `remoteDesktop` namespace, or English (D3) |
| Updater, deep-link intake, quit prompt | Present | Absent |

A unit test fails the build if any file in the package imports `@tauri-apps/*`.

### 5.4 Browser host transport policy

The browser host allows **WebRTC only**.

- **No WebSocket fallback.** The shared component falls back to WebSocket when WebRTC fails (F13). In a browser that
  passed the preflight, a WebRTC failure is a network or agent problem, and the WebSocket stream cannot serve the
  service-mode agents this feature is for (F1). Allowing it would add an untested media path to v1. The browser host
  shows the WebRTC failure instead.
- **No in-session VNC switch.** The switch creates and closes VNC tunnels through viewer-token endpoints
  (`DesktopViewer.tsx:666-720`) and brings noVNC into the page. A browser technician who needs VNC relay uses the
  dashboard's existing VNC page (F7), which Connect Desktop already picks when VNC is the only route
  (`ConnectDesktopButton.tsx:494-502`).
- The toolbar hides the controls for disallowed transports. The host's `transports` setting is the single switch, so
  allowing either later is a host change only.

### 5.5 Session audit and origin attribution

Today `session_initiated` records device, hostname and type (`sessions.ts:383-395`). `session_offer_submitted`
records `via: 'viewer_token'` (`desktopWs.ts:2082-2093`). Both go into `audit_logs.details`, a `jsonb` column
(`apps/api/src/db/schema/audit.ts:32`), written by `logSessionAudit` (`apps/api/src/routes/remote/helpers.ts:349-380`).

**Recommendation (D5):** add an `exchangeOrigin` attribution, defined precisely:

- **Meaning:** "the origin observed when the viewer credential was exchanged". It is **not** proof of which program
  is presenting the token now, and a token handed elsewhere keeps its original label.
- **Values:** `browser` when the `Origin` header of `POST /desktop-ws/connect/exchange` exactly matches a configured
  dashboard origin; `viewer` when it exactly matches a Tauri origin (`TAURI_ORIGINS`,
  `apps/api/src/services/corsOrigins.ts:3-6`); `unknown` for anything else (missing, `null`, a foreign origin), and
  for tokens minted before this change. The dashboard set is the deployment's own web origin(s), not the whole CORS
  allowlist (`corsOrigins.ts:43-52`), which can contain other origins. The exact configuration source is left to the
  builder.
- **Never used for authorization.** It only goes into audit details and reporting.
- **Where it lives:** a claim in the viewer token. All three JWT sites must carry it: mint
  (`createViewerAccessToken`, `apps/api/src/services/jwt.ts:353-375`), descendant mint (copies its claims explicitly,
  `jwt.ts:424-437`), and verify (rebuilds the payload explicitly, `jwt.ts:441-460`). A token with no claim verifies as
  `unknown`.
- **Where it is written:** into `session_offer_submitted` details, next to `via`. That event is written before the
  start is dispatched to the agent (`desktopWs.ts:2082-2093`), so it records an **attempted** start, not proof that a
  browser session ran. Reports must say "browser start attempts".
- **No table or column changes.**

A browser page cannot forge its `Origin`, so a browser exchange is never labelled `viewer`. A non-browser client can
send anything, which is why the value stays informational.

### 5.6 Threat model: what a tab changes

**The boundary moves.** The native viewer is a separate process with its own document and CSP (F14). In a tab, the
desktop session runs in the dashboard origin. Keeping the viewer token in memory only prevents persistence and URL
leakage. **It does not defend against script running in the dashboard origin** (an injected script, a compromised
dependency, a broad-access extension), and neither does anything else in the page. Such script can already use the
dashboard's own authority, which is held in page memory too (F14). A browser session adds live screen pixels, the
synced clipboard and remote control of the device to what that script could reach. Today that would mean
persuading a technician to open a session in a separate application.

**v1 accepts this boundary** and narrows it:

- **Minimal scripts on the page.** The desktop page loads only what the session needs, not the dashboard shell's
  widgets, AI panes or third-party scripts. The page's script list is reviewed in W5 and pinned by a test.
- **Telemetry exclusions.** No credential, connect code, clipboard contents or screen content in error reports,
  breadcrumbs or replays. The web Sentry config already masks all text and inputs, blocks all media and captures no
  network payloads (`apps/web/sentry.client.config.ts:21-28`). The desktop page keeps those settings and excludes
  the video element and clipboard flows from capture. A test asserts the config the page runs with.
- **`Cache-Control: no-store`** on the connect-code and exchange responses. No such header was found on these
  routes in `sessions.ts` or `desktopWs.ts`.
- **`isTrusted` filter.** The browser host drops keyboard and mouse events whose `isTrusted` is false. This stops
  synthetic events from ordinary page code. It is **not** a defence against a compromised page context, which can
  bypass the handlers entirely.
- **Option E** (§5.2) is the structural fix, deferred.
- An optional binding of the connect code to the issuing user agent (§6.1) is weak hardening against code theft, not
  an XSS mitigation.

**Other exposures:**

| Exposure | Handling |
|---|---|
| **Reload, restored tabs, bookmarks, forwarded links** can reopen `/remote/desktop/<deviceId>`. | The page never starts a session on load. It waits for an explicit Connect in the tab (D6, §6.2). A forwarded link is inert without the recipient's own sign-in, `remote:access` and MFA. |
| **Browser shortcuts** (Ctrl+W, Ctrl+T, Ctrl+N) are kept by the browser unless the tab is fullscreen with Keyboard Lock. Ctrl+W meant for the remote closes the tab. | `beforeunload` confirmation while connected. The toolbar's Send Keys menu stays the way to send reserved combinations outside fullscreen. Ctrl+Alt+Del is a command, unaffected. |
| **Clipboard permission persists per origin.** After a technician grants `clipboard-read`, any later dashboard page on that origin can read the clipboard without asking (inferred from the browser permission model). | Clipboard sync only runs while the session tab is focused and connected. Stated in docs. |
| **Background tabs.** Chromium throttles timers in hidden tabs. The viewer renews its lease view every 25 s (`apps/viewer/src/lib/revocationLease.ts:19`). | Pages with live WebRTC connections are believed to be exempt from intensive throttling (inferred, not checked). Lab leg: 10 minutes hidden, session must survive. |
| **Screenshots** go to the browser's downloads folder and download history. | Stated in docs. |
| **Remote screen in tab thumbnails or history previews.** | History holds only the device id. Thumbnails are the browser's business; not mitigated. |

**CSP and framing.** The page inherits the dashboard CSP. `frame-ancestors 'none'` (`apps/web/astro.config.mjs:79`)
means it cannot be framed. `connect-src` is replaced at runtime with an allowlist made of `'self'`, the configured
API origin, the docs origin, the Sentry origin, any `CSP_CONNECT_HOSTS`, and Cloudflare's analytics endpoint
(`apps/web/src/middleware.ts:128-150`, `apps/web/src/lib/csp.ts:128-153`). No CSP change is expected. Two *inferred*
points must be confirmed by a **connected-session CSP check** in W5. The existing CSP guard cannot confirm them: it
loads only public routes, answers API calls with 404, and records only inline-script violations
(`apps/web/scripts/check-csp-violations.ts:13-14`, `:55-64`, `:67-77`). The points are that ICE and TURN traffic is
not governed by `connect-src`, and that a `MediaStream` attached through `srcObject` is not a URL load under
`default-src 'self'`.

`Permissions-Policy` denies camera, microphone, geolocation and payment only (`apps/web/src/middleware.ts:227`;
`docker/Caddyfile.prod:480`), leaving clipboard, fullscreen and Keyboard Lock available to the same origin. The page
asks for no microphone or camera. `Referrer-Policy` defaults to `strict-origin-when-cross-origin`
(`apps/web/src/middleware.ts:126-127`), so same-origin requests carry the full URL and cross-origin requests carry
only the origin. Since the URL carries no secret, no page-level override is needed.

### 5.7 Checks on this path

Every check runs at the same point it does for the native viewer, because the tab calls the same endpoints.

| Check | Where it runs |
|---|---|
| Signed-in user | `authMiddleware` on `/remote/*` (`apps/api/src/routes/remote/index.ts:17`) |
| `remote:access` permission | `requirePermission(REMOTE_ACCESS)` on `/remote/*` (`remote/index.ts:18-23`). Re-checked live at exchange (`desktopWs.ts:1802-1810` → `apps/api/src/services/remoteWsAuthorization.ts:423-440`). |
| MFA | `requireMfa()` on `/remote/*` (`remote/index.ts:24`; `apps/api/src/middleware/auth.ts:1140-1164`). Automation principals are refused there. The viewer token records `mfaSatisfied: true` on that basis (`desktopWs.ts:1840`). |
| Step-up / recent re-authentication | **Not found** on the remote session, connect-code or exchange routes. Not added by this design. |
| Org and site scope | `getDeviceWithOrgCheck` on create (`sessions.ts:238-244`). `currentSessionCapabilityDenial` re-reads the site ceiling on mint (`sessions.ts:112-128`, `:883`). Re-checked live at exchange. |
| Session ownership | `hasSessionOwnership` on mint (`sessions.ts:869`). The exchange compares the code's user and email to the live user (`desktopWs.ts:1792-1813`). |
| Remote access policy (`webrtcDesktop`) | On create (`sessions.ts:251-265`) and on mint (`sessions.ts:119-127`) via `checkRemoteAccess` (`apps/api/src/services/remoteAccessPolicy.ts:312`) |
| Partner trust (`remote_control`) | On create (`apps/api/src/services/remoteSessionCreate.ts:99-120`), on exchange (`desktopWs.ts:1816-1834`), and on live continuation (`remoteWsAuthorization.ts:406-415`) |
| Agent desktop-start capability, concurrency caps | On create (`sessions.ts:274-310`) |
| Continuous revocation | The agent renews the session's revocation lease over its own command socket (`agent/internal/heartbeat/heartbeat.go:1587-1591`; `apps/api/src/routes/agentWs.ts:3591`). The viewer renews through `/viewer/lease/renew` (`desktopWs.ts:2188-2224`), which also checks the token's `jti` revocation (`:2199`) and tells the viewer when access is withdrawn. |
| End-user consent / notify | Agent-side, unchanged; the browser path sends the same start |

### 5.8 Media preflight and the watchdog

**Detection is capability-based, not user-agent based.** User-agent sniffing gets both directions wrong.
H.264 support varies within Chromium (distribution builds) and within Firefox (Debian's default pref, the
OpenH264 plugin download, Fedora's system plugin, as measured on #9557), and a user agent shows neither.
The user agent is used only to choose the default (§5.1) and never to decide whether the session is allowed.

**Preflight, before any session is created.** This is evidence, not proof. The W3C WebRTC spec describes reported
capabilities as optimistic.

1. `RTCRtpReceiver.getCapabilities('video')` lists `video/H264`. If the API is missing, fall through.
2. A throwaway `RTCPeerConnection` with a receive-only video transceiver calls `createOffer`, then closes. The offer
   must contain an `H264/90000` payload with `packetization-mode=1`. The exact `profile-level-id` is not required:
   browsers commonly offer Baseline and still decode the agent's Main stream (Firefox did on #9557, where pion matched
   on MIME type). The real offer also carries data channels and ICE candidates (F3), so the probe models only the
   codec part.
3. A failed preflight shows the unsupported message (§5.9). A passed preflight only allows the technician to
   connect.

**Success comes from real media.** After connecting, the page decides from stats and from the video element, and
treats each failure separately:

| Observation | Meaning | Response |
|---|---|---|
| No video packets arrive within the start window | Network, agent or consent problem, not the browser | The existing start-failure and no-video paths (the agent has its own no-video watchdog, #5300); not the unsupported message |
| Packets arrive, decoded frames do not advance | The browser cannot decode the stream | Request one keyframe (the existing control message), then a terminal failure with the unsupported message |
| Frames decode but none is presented (`requestVideoFrameCallback` never fires, `videoWidth` stays 0) | Presentation failure | Terminal failure with a "can't display the video" message |
| After the first frame: packets keep arriving but decoding stops advancing | Later stall | Request a keyframe, wait a bounded time, then a terminal failure. An idle remote desktop sends few or no frames, so a stall is only declared while packets are arriving. |
| Stats lack `framesDecoded` or the inbound video report | Unknown | Never read as 0. The existing stats code maps a missing value to 0 (`apps/viewer/src/lib/statsReporter.ts:99-101`), so the watchdog reads raw reports and falls back to presentation callbacks. |
| Track replaced (reconnect, monitor switch) or tab hidden | Counters reset or pause | Re-arm the watchdog on a new track. Suspend stall detection while the tab is hidden. |

**Input gate.** Today input is available as soon as the connection reports connected and the input channel is
open (`DesktopViewer.tsx:770-777`, `:1842-1850`). In the browser host, **remote input stays disabled until the first
frame is presented**, and is disabled again during a terminal watchdog failure.

**Terminal watchdog failure** releases held keys and buttons, suppresses auto-reconnect, ends the session with the
API, closes the peer, and shows the message. It does not leave a live session behind a message.

Thresholds are left to the builder and set from lab data.

### 5.9 Unsupported browsers: copy intent

Final wording lives in the web locale files.

- Title: the browser can't show the remote desktop.
- Body: remote desktop in the browser needs H.264 video, which this browser doesn't offer. Use Chrome, Edge or
  another Chromium-based browser, or the Breeze Viewer.
- Actions: **Download Breeze Viewer** (existing download info), **Copy link** (to open the same page in another
  browser), **Back to device**.
- No blame and no jargon beyond "H.264", which a technician can search for. Firefox is not named, because the check
  doesn't know it is Firefox.
- Watchdog variants: "Connected, but this browser isn't decoding the video" and "Connected, but the video can't be
  displayed", with the same actions.

The dashboard runs the preflight before offering the entry: an unsupported browser sees "Open in browser" disabled,
with the reason. The page runs it again on load, since it can be opened directly.

**Browsers that pass the preflight but are not Chromium** (Firefox with OpenH264, Safari): see D2.

### 5.10 Audio

**Audio does not work through the current offer, by code reading (inferred, not run).** The viewer's offer has no
audio transceiver (F3). The agent adds its PCMU track before applying the offer
(`session_webrtc.go:494-512`, `:745`), but an answer cannot add a media section the offer lacks (JSEP), so the
track has nowhere to go. Separately, the audio `ontrack` handler is installed only after `createWebRTCSession`
returns (`apps/viewer/src/lib/transports/webrtc.ts:81-102`), and that function has already applied the answer
(`webrtc.ts:445-449`), so a track event fired during that step would miss the handler. This is the shared code, so
the same applies to the native viewer.

**Therefore:** the browser session does not promise audio until W3 lands. W3 first confirms the finding on a native
viewer. If audio is broken, W3 adds a receive-only audio transceiver to the offer and installs the track handler
before the remote description is applied, with a lab check on the native viewers and the browser. If audio turns out
to work today, W3 closes with that finding and no change. Autoplay is then the remaining browser issue: the audio
toggle click is the user gesture.

### 5.11 Dashboard entry points

- **Connect Desktop menu:** today the split-button menu only appears when a third-party remote tool is configured
  (`ConnectDesktopButton.tsx:1275`). It must appear whenever the browser option exists, listing **Breeze Viewer** and
  **Open in browser** (plus any third-party tools as today). `ConnectChoice` (`:30`) gains a `{ kind: 'browser' }`
  member.
- **Default on Linux** within the built-in path (D1). The partner's default third-party tool keeps precedence.
- **Viewer did not open:** the card shown after the deep-link poll times out (`:636-637`) gains **Open in browser**,
  like the VNC card's existing button (`:713-719`). The browser tab creates its own session, which ends the pending
  session from the failed hand-off (F12).
- **RDS session picker** runs before the tab opens, as it does for the viewer. Its choice goes in the fragment as a
  non-secret identifier.
- **VNC fallback is unchanged.** When the device can only be reached over VNC relay, the existing in-browser VNC page
  is the browser option.
- All entry points are behind the runtime flag until the lab leg passes (D4).

### 5.12 The page

`apps/web/src/pages/remote/desktop/[deviceId].astro`, built like the VNC and terminal pages (F7;
`apps/web/src/pages/remote/terminal/[deviceId].astro:12-34`): `Layout` with a `titleKey`, `AuthOverlay`,
`ToastContainer`, and one `client:only="react"` island that composes the browser host with the shared component. It
loads nothing else (§5.6). States: disabled (flag off) | checking → unsupported | ready (Connect button) → connecting
→ connected → ended (with reason). The ended state offers **Connect again** and **Back to device**.

## 6. Lifecycle contract (browser host)

One place that says what the tab does at each lifecycle point. Each rule needs a test (§10).

### 6.1 Launch

1. The technician picks "Open in browser" (or the Linux default). The dashboard calls `window.open` synchronously
   inside the click, so no popup blocker gets involved, with `/remote/desktop/<deviceId>`. The URL carries the device
   id and, for RDS hosts, the chosen Windows session in the fragment. Both are identifiers, not credentials.
2. The page runs the preflight (§5.8) and shows the ready state. **Nothing is created until the technician clicks
   Connect in the tab** (D6).
3. On Connect, the page runs one **launch transaction**: `POST /remote/sessions` → `POST
   /remote/sessions/:id/desktop-connect-code` → `POST /desktop-ws/connect/exchange` → WebRTC connect. The create and
   mint calls use the dashboard session (`fetchWithAuth`). The exchange uses a **plain request with no automatic
   retry**: `fetchWithAuth` re-sends a request after a 401 and a token refresh unless `skipUnauthorizedRetry` is set
   (`apps/web/src/stores/auth.ts:1551-1570`, `:1364`), and the exchange consumes its code before authorizing
   (`desktopWs.ts:1790-1810`). Use the viewer's bare `exchangeDesktopConnectCode` (`apps/viewer/src/lib/api.ts:57-70`)
   or set the flag.
4. **Single flight.** One transaction per tab at a time. A second Connect, a reload, or a teardown aborts the
   transaction in flight (`AbortController`) and discards its late results. The one-shot guard covers the whole
   chain, not only the exchange; the API asks clients to guard the exchange against React strict-mode double-firing
   (`desktopWs.ts:1780-1783`), and the viewer does (`DesktopViewer.tsx:169`).
5. **Partial failure cleans up.** If the session was created and any later step fails, the page ends that session,
   as Connect Desktop does today when minting fails (`ConnectDesktopButton.tsx:553-561`). A failed exchange is never
   retried with the same code; a retry is a new mint. An aborted transaction ends any session it created.
6. The viewer token is passed to the shared component in memory only, never in `localStorage`, `sessionStorage`, a
   cookie or a URL. The session id and the signed-in user id may be kept in `sessionStorage` (per tab, not
   credentials). They are discarded when the signed-in user differs.

**Why mint and redeem in the same page.** The code travels only from one response body to the next request body:

| Carrier | Assessment |
|---|---|
| Query string (`?code=`) | Rejected. It lands in history and the reverse proxy's access log, and in the `Referer` of same-origin requests the page makes. |
| Fragment (`#code=`) | Not sent to the server, but kept in history and visible to anything that reads the URL until scrubbed with `history.replaceState`. Workable, and unnecessary. |
| `postMessage` from the opener | Needs an opener relation (no `noopener`), strict origin checks on both sides, and a load race. Workable, more moving parts, no benefit. |
| **Mint and redeem in the tab** | **Chosen.** Nothing crosses a window, process or URL boundary. |

The exchange step is kept, although the page already holds the dashboard's session, so that the shared component
consumes the same narrow credential in both hosts and no viewer route has to accept the dashboard's token.

**Single use and TTL, as implemented:** the code is 24 random bytes, base64url
(`apps/api/src/services/remoteSessionAuth.ts:121-123`, `:434`). It lives 2 minutes (`:11`), in Redis with `SETEX`
outside development and test (`:104-111`, `:441-449`). It is redeemed by an atomic `GET`+`DEL` (`:195-201`,
`:457-466`), so a second redemption fails even inside the TTL. The record holds session id, user id and email
(`:66-71`). It is not bound to the caller's IP or user agent, unlike the 60-second WebSocket ticket (`:23-36`,
`:394-405`). That is reasonable for the native viewer, which redeems from another process. In the tab, binding the
code to the issuing user agent is optional weak hardening (§5.6).

### 6.2 Reload, restored tab, or Connect again

Unloading the page closes the peer. The agent treats a closed or failed peer as the end of the session and reports
it at once (`session_webrtc.go:678-688`). The API ends the session unless the viewer marked a reconnect first
(`agentWs.ts:3880-3900`; the viewer marks it before closing its old peer, `DesktopViewer.tsx:1020-1027`). A page
being unloaded cannot be relied on to finish that asynchronous mark (inferred). **Resume after reload is therefore
best effort, not a guarantee.**

The contract:

1. After any reload or restore, the page shows the ready state. It never connects on load.
2. On Connect, if `sessionStorage` holds a session id for the same signed-in user, the page tries to **resume**: mint
   a code for that session (allowed only while it is `pending`, `connecting` or `active`, `sessions.ts:877`), exchange
   it, and re-offer through the existing reconnect path (`desktopWs.ts:1870-1879`). The offer route refuses ended
   sessions (`desktopWs.ts:1963-1971`).
3. If resume is refused because the session ended, the page says so ("The previous session ended") and offers
   **Start a new session** as a separate, explicit action. **It never silently replaces a session.**
4. *Not checked:* whether a resumed start re-prompts the end user in consent mode. This is a lab-leg item.

### 6.3 Sign-out and account change

- **Same tab:** the browser host registers a logout hook (`apps/web/src/stores/logoutHooks.ts:24-27`). `evictLocalAuthState`
  runs the hooks before clearing storage (`apps/web/src/stores/auth.ts:2005-2011`).
- **Other tabs:** the hooks run only in the tab that signs out. No cross-tab logout listener was found in
  `auth.ts`. The same eviction removes `breeze-auth` from `localStorage` (`auth.ts:2011`), which fires a `storage`
  event in other same-origin tabs (Web Storage behaviour, inferred for this code). The desktop tab listens for that
  removal, and for a change of signed-in user id on token refresh, and treats either as sign-out.
- **Teardown on sign-out:** release held keys, stop clipboard sync and drop any pending clipboard data, stop all
  tracks and the audio element, close the peer, end the session with the API (best effort, using the viewer token),
  then clear the viewer token and the `sessionStorage` entries.
- *Not checked:* whether a dashboard sign-out ends the user's live remote sessions server-side. The browser host does
  not rely on it.

### 6.4 Tab closed or browser crashed

Cleanup comes from **peer loss**, not from the lease.

- When the peer goes `disconnected`, the agent releases held input at once and allows 20 s to recover. When it is
  `failed` or `closed`, the agent stops the session immediately. Either way it reports the stop to the API
  (`session_webrtc.go:636-688`), which ends the session unless a reconnect mark holds it briefly
  (`agentWs.ts:3880-3900`).
- The revocation lease does **not** detect a missing viewer. The agent renews it over its own command socket
  (`heartbeat.go:1587-1591`; `agentWs.ts:3591`). Its timings (60 s TTL, 25 s renew, 90 s agent grace,
  `apps/api/src/services/remoteRevocationLease.ts:51-61`) bound a lost control plane, not a lost viewer.
- A closed tab with no reconnect mark therefore ends the session as soon as the agent sees the peer close, or within
  about 20 s of a silent network loss. The lab leg measures both.

## 7. Tenancy and data

**No table is added and no column is added** under the recommended options. The attribution lives in
`audit_logs.details` (`jsonb`) and in a JWT claim. Nothing new needs RLS, cascade, merge or export registration.

If D5 option (b) is chosen (a column on `remote_sessions` so session history can show a Browser badge), the column
needs an export-policy classification. `remote_sessions` is registered in `CORE_TENANT_EXPORT_POLICY`
(`apps/api/src/services/tenantExportPolicyRegistry.ts:839`). A `text` enum-like column would go under `included`
after review. The migration must follow `apps/api/migrations/README.md`.

**Settings:** none added. A browser session uses the existing `webrtcDesktop` capability of the Remote Access
policy (`remoteAccessPolicy.ts:24`). Places the concept is configured: 0 before, 0 after. The rollout flag in D4 is
a temporary deployment flag, not a setting, and is removed after the lab leg. If the maintainer wants partners to be
able to forbid browser sessions (D7), its home is that same Remote Access policy, at the existing policy levels.
That makes 1 place after.

## 8. i18n

Web locales under `apps/web/src/locales/`: **`en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`**
(8). Every new key goes into all 8 (`apps/web/src/locales/README.md`, steps 2-3; parity is enforced by
`apps/web/src/lib/i18n/localeParity.test.ts`). pt-BR additions carry the machine-drafted note the README requires.

New web-owned strings (in `remote.json` and a page title key), all translated from day one:

- the menu item and its disabled reason, the Linux-default label, the failed hand-off button;
- on the page: disabled, checking, unsupported, both watchdog variants, Connect, ended, previous session ended / start
  a new session, opened in another tab, signed out, and the leave confirmation.

**In-session viewer UI** (toolbar, notices, chips) is English in the viewer today (F11). The package takes a string
catalog from the host (§5.3), so the strings are externalized during the extraction with an English catalog. Whether
the 8 translations block the browser launch is D3.

## 9. Rollout

**Recommendation (D4, changed after the independent review): a runtime flag, removed after the lab leg passes.**

- The flag is served by `GET /api/v1/config`, like the registration gate (a build-time `PUBLIC_*` flag would not work
  for prebuilt images, `apps/web/src/lib/featureFlags.ts:43-46`). It defaults to off.
- With the flag off, the page shows a disabled state and makes **no session, code or exchange calls**, and every
  entry point is hidden. Hiding links alone is not enough, because the page can be opened by URL.
- The lab leg runs with the flag on in the lab, testing the real entry points and the page together.
- W7 removes the flag. The env var needs a compose mapping and a row in the environment docs while it exists, and
  both come out with the flag.

## 10. Testing

Rigor: full. This touches remote-session auth flow and code that ships to technicians' machines (the viewer).

| Layer | What | Where it runs |
|---|---|---|
| Package (unit) | All viewer library tests move with their modules and are collected by the package's own job. A host contract test with a fake host covers clipboard denied, prefs unavailable, Keyboard Lock missing and screenshot failure. A guard test makes sure the package has no `@tauri-apps/*` import. | new package job, modelled on `test-document-ui` (`ci.yml:1554-1585`) |
| Native viewer | The existing `apps/viewer` tests still pass (`ci.yml:1477`). A manual smoke of the Tauri viewer on **Windows, macOS and Linux** after each W2 step and W3 covers deep link, stream, input, paste-as-keystrokes, clipboard both ways, screenshot, quit prompt, one window per device, WebSocket fallback, and the VNC switch. | CI and manual |
| Browser host (unit) | Preflight against recorded offer SDPs (Chromium with H.264, Firefox without, Firefox with OpenH264 offering Baseline only). Each watchdog row in §5.8, including missing stats and track replacement. The input gate before the first frame. Terminal failure releases input, does not reconnect, and ends the session. The `isTrusted` filter. Transport policy (no WebSocket, no VNC switch). | `test-web` |
| Lifecycle (unit) | Every rule in §6. The single flight aborts a stale transaction. Partial failure at each step ends the created session. The exchange is never retried and never goes through the 401 retry. A reload shows ready, never connects. A failed resume offers a new session and never replaces silently. Sign-out in the same tab and in another tab tears down. The token is never written to storage, a URL or telemetry. | `test-web` |
| API | Attribution: web origin, each Tauri origin, missing, `null`, foreign, and a legacy token without the claim. The claim survives the descendant mint and verify. It appears in `session_offer_submitted`. `no-store` on the code and exchange responses. Existing single-use, TTL and live-authorization tests are unchanged. | `test-api` |
| Web components | Menu shows with no third-party tools. Third-party default kept. Linux default. Disabled item in an unsupported browser. Failed hand-off card. RDS choice carried in the fragment, never a credential. Everything hidden with the flag off. | `test-web` |
| E2E (Playwright, `data-testid`) | Flag off: no session calls. Flag on: the page renders, the unsupported state appears in a browser without H.264, Connect is required, and no request URL contains a connect code. Playwright's bundled Chromium may lack H.264 (inferred; its docs point to the `chrome` channel for proprietary codecs), so the supported path needs the `chrome` channel or stays manual. No agent streams in CI. | e2e job |
| CSP while connected | A connected-session check (lab, or a stack with a dev agent) that records **every** CSP violation, not only inline scripts, while streaming, switching monitors and using the clipboard. The existing guard does not cover this (§5.6). | W5 manual and lab |
| Docker | The web image builds with the new package listed in the deps-stage manifest list (`apps/web/Dockerfile:17-30`, which warns that a missing package fails only at bundle time). | image build |

### Lab leg (W6, blocking)

Real Linux browsers against a real Windows agent in service mode, with the hardware (MFT, Main profile) encoder:
Google Chrome on Linux (amd64), Debian 13 distro Chromium, Fedora distro Chromium, and Ubuntu's snap Chromium. The
snap could not be tested in containers on #9557. The real entry points are used with the flag on, including the
Linux default, the "viewer did not open" card, and the RDS session picker.

**Exit criteria.** Every item passes on Google Chrome and Debian Chromium; the Fedora and snap results are recorded
against them. Any failure blocks W7 until it is fixed and re-run. Filing an issue is not a pass.

| Area | Pass when |
|---|---|
| Picture | 10 minutes of mixed use with no blank picture and no freeze longer than 2 s (thresholds fixed in the lab plan before the run). The first frame appears before input is enabled. Monitor switch works. |
| Input | Drag-select, typing on a non-US layout, paste-as-keystrokes, view-only blocks input, fullscreen Keyboard Lock (Alt+Tab and the Windows key reach the remote), Send Keys outside fullscreen, and Ctrl+W asks before closing. |
| Clipboard | Text and image both ways while focused. Nothing syncs while unfocused. |
| Audio (after W3) | Audio plays after the toggle. |
| Auth | The session's `session_offer_submitted` row has `exchangeOrigin: browser` (needs W4). A user without MFA or `remote:access` cannot start. Sign-out in another tab ends the session. |
| Cleanup | Closing the tab ends the session at the API within the agent's peer-loss window (§6.4). Reload shows ready and follows §6.2, and whether consent re-prompts is recorded. A second tab for the same device replaces the first, and the first says so. 10 minutes as a hidden tab and the session survives. |
| Unsupported | Debian Firefox ESR (default prefs) and a fresh Ubuntu Firefox profile get the message, never a blank picture or live input. |
| CSP | The connected-session check records no violations. |

**Fedora GOP-loss check (R1):** compare the agent's sent-frame count with the tab's `framesDecoded`,
`keyFramesDecoded` and `pliCount` over the 10 minutes, with Debian Chromium and Google Chrome as controls. It fails
the leg only if Fedora breaks the picture criterion.

**Cannot be covered locally or in CI:** a Windows service-mode agent with its user helper, real hardware-encoder
output, distro and snap browser builds, headed GPU decode, Wayland versus X11 behaviour of fullscreen and Keyboard
Lock, and background-tab throttling over minutes.

## 11. Docs

- `apps/docs/src/content/docs/features/remote-access.mdx:671-673`: the caution "The Linux viewer cannot connect to
  Windows devices yet" gets a pointer to the browser session.
- `apps/docs/src/content/docs/deploy/binaries.mdx:223`: same.
- `remote-access.mdx` gets a new section, "Remote desktop in a browser". It covers:
  - supported browsers (Chromium-based, H.264) and how to open it;
  - what differs from the viewer: shortcuts only in fullscreen, clipboard permission and focus, audio needs a click,
    one tab per device, screenshots go to downloads, no WebSocket or VNC switching inside the tab;
  - that the session runs in the dashboard's origin, and the advice to use a browser profile without broad-access
    extensions;
  - the informational `exchangeOrigin` audit field and what it does not prove.
- The environment docs row for the rollout flag, added in W5 and removed in W7.
- Release notes for the release that ships W7, and for W3 if it changes native audio.

## 12. Waves

Each wave can be merged on its own and has an outcome someone can check.

| Wave | Contents | Verifiable outcome |
|---|---|---|
| W1 | Create `packages/remote-desktop-ui` and move the Tauri-free viewer libraries and their tests into it. Wire the package's CI job (vitest + typecheck, modelled on `test-document-ui`) so the moved tests are still collected; `apps/viewer`'s `src/**/*.test.ts` include (`apps/viewer/vitest.config.ts:8`) stops seeing them. Tests that read component source (for example `serviceModeRefusal.test.ts:5` imports `DesktopViewer.tsx?raw`) stay in `apps/viewer` until the component moves. No behaviour change. | The diff is moves and import paths. The package job runs and passes, and its test count matches the tests removed from the viewer. Viewer tests and build pass. |
| W2a | Host interface. `DesktopViewer` stays in `apps/viewer` and calls the host instead of Tauri. Tauri host implemented. | No `@tauri-apps` import in `DesktopViewer.tsx`. Native smoke passes on Windows, macOS and Linux. |
| W2b | Move `DesktopViewer`, `ViewerToolbar` and the components they render into the package, with their tests. Add the no-Tauri guard test. | Moves only. Guard test. Native smoke on all three OSes. |
| W2c | Externalize the UI strings to an English catalog the host provides. | Snapshot of rendered strings unchanged. Native smoke on one OS. |
| W3 | Audio negotiation (§5.10): confirm on a native viewer. If broken, add a receive-only audio transceiver and install the track handler before the answer is applied. | Lab: audio plays after the toggle on the three native viewers, or the wave closes with "works today". |
| W4 | API: the `exchangeOrigin` attribution, carried in the claim at all three JWT sites and written to the audit detail. `no-store` on the code and exchange responses. **Prerequisite for the lab leg's audit check.** | API tests. A native viewer start records `viewer`; a legacy token records `unknown`. |
| W5 | The browser host, preflight, watchdog, input gate, lifecycle contract (§6), transport policy, `isTrusted` filter, minimal-script page and telemetry config, `/remote/desktop/[deviceId]`, the entry points, page strings in 8 locales, and the runtime flag (default off, page start disabled when off). The new package goes into the web Dockerfile's manifest list. Connected-session CSP check against a dev agent. | Unit, lifecycle and E2E tests. Image builds. With the flag on, a Chromium tab streams from a dev agent, and Firefox shows the message. With the flag off, nothing starts. |
| W6 | Lab leg (§10), no code. Results are written up on #9557. | Every exit criterion passes. |
| W7 | Remove the flag. Docs and release note. | Flag gone from code, compose and env docs. Docs build. |
| W8 (optional) | Translate the in-session viewer strings into the 8 web locales (D3). | Locale parity covers the new namespace. |

W4 does not depend on W1-W3 and can land first. W3 depends on W1, because the offer code is in the package. W5
depends on W2b and W4. W6 depends on W5 (and W3 for its audio row). W7 depends on W6.

## 13. Risks

- **R1. Fedora Chromium lost about one GOP per 15 s on Main profile only** (#9557, synthetic x264 clip). The cause is
  not established. The test server may not have answered PLI, while the real agent does (F2), so the real loss may be
  smaller (inferred). Proposed check: §10, Fedora GOP-loss check. If it reproduces on the real agent, the release
  notes name it as a known issue, and a follow-up evaluates offering Constrained Baseline where the encoder supports
  it.
- **R2. Native viewer regression** from W1-W3. Mitigated by moves-only W1 and W2b, the guard test, and three-OS
  smoke tests.
- **R3. Background-tab throttling** stalling the viewer's lease view or the stats. Verified in the lab.
- **R4. Distro Chromium builds without H.264.** Handled by the preflight and the watchdog, never by a blank picture.
- **R5. Dashboard-origin script** reaching a live session (§5.6). Accepted for v1 with mitigations. Option E is the
  structural fix.

## 14. Independent review

An independent design review (Codex, requested by the coordinator) asked for changes to r1. Each point was checked
against the cited code before it was adopted. Changes in r2:

- **Factual fixes:**
  - crash and tab-close cleanup now comes from peer loss, not the lease, which the agent renews itself (§6.4);
  - the existing CSP guard's real coverage is stated, and a connected-session check is added (§5.6, §10);
  - paste-as-keystrokes is recognised as an input path, so the spike claim is marked wrong (§1);
  - the `Referer` wording is corrected (§5.6, §6.1).
- **Lifecycle contract** added (§6): the launch transaction with single flight and partial-failure cleanup, no
  auto-retry on the exchange, reload to an explicit Connect with best-effort resume and no silent replacement, and
  sign-out teardown across tabs.
- **Preflight is evidence, not authoritative**, and success comes from real media. The watchdog separates no packets,
  no decode, no presentation, a later stall and missing stats. Input is gated on the first frame, and a terminal
  failure releases input, suppresses reconnect and ends the session (§5.8).
- **Threat model** stated plainly, with mitigations, and a separate-origin shell recorded as deferred option E
  (§5.2, §5.6).
- **Origin attribution** defined precisely: exchange-time origin, exact matching, `unknown` otherwise, not
  authorization, all three JWT sites, and the audit row recording an attempted start (§5.5).
- **Audio** finding confirmed by code reading; parity is no longer promised until W3 (§5.10).
- **Transport policy** added: WebRTC only in the browser (§5.4).
- **Waves:**
  - package CI wiring in W1;
  - W2 split into three steps, with native smoke tests on all three OSes;
  - the audio wave added;
  - the attribution wave made a prerequisite of the lab leg's audit check;
  - the Dockerfile manifest and the connected-session CSP check added to W5;
  - the lab leg given pass/fail exit criteria.
- **Decisions:** D4 now recommends a runtime flag and D6 now recommends an explicit Connect, both changed after the
  review. D1 now keeps a configured third-party default. D2 adds feature-by-feature degradation.

No review point was rejected.

## 15. Out of scope and follow-ups

- **VP8 fallback on the agent,** chosen when the viewer's offer has no H.264. VP8 decoded on stock Debian and Fedora
  Firefox with nothing installed (#9557). This would bring Firefox into scope.
- Constrained Baseline offer (R1).
- A separate-origin viewer shell (option E).
- WebSocket fallback or the VNC switch inside the browser tab (§5.4).
- Auto-connect on launch (D6, option a), once one-shot intent ownership, expiry and reload behaviour are specified.
- A Browser badge in session history (D5 b).
- A policy switch to forbid browser sessions (D7 b).
- Translated in-session strings in the native viewer, which would need a locale source.

## 16. Decisions for the maintainer

**D1. Should the browser session be offered on every OS, or only on Linux?**
- (a) Every OS. The default on Linux within the built-in path, and a menu item plus the failed-hand-off card
  elsewhere. A partner's configured third-party default tool stays the default everywhere. *Pro:* helps anyone
  without the viewer, and gives a recovery path when the hand-off fails. *Con:* one more menu item for Windows and
  macOS users.
- (b) Linux only. *Pro:* smallest surface. *Con:* leaves out locked-down machines and failed hand-offs on other OSes.
- (c) Every OS, equal standing. *Con:* steers Windows and macOS users away from the better tool.
- **Recommend (a).** The cost is one menu item, and the failed-hand-off card is where it saves a session. The
  independent review agreed and asked that third-party defaults be preserved, which (a) now states.

**D2. What happens in a non-Chromium browser that passes the preflight (Firefox with OpenH264, Safari)?**
- (a) Allow it, with a one-line "this browser isn't officially supported" notice. Clipboard, audio and Keyboard Lock
  each degrade on their own when missing. *Pro:* consistent with capability-based detection; Fedora Firefox decoded
  the stream. *Con:* support questions from an untested path.
- (b) Block by engine, using the user agent. *Pro:* matches "Chromium only" literally. *Con:* user-agent gating,
  which this design otherwise avoids, and it refuses a browser that works.
- (c) Allow silently. *Con:* hides that it's untested.
- **Recommend (a).** The watchdog and the input gate still catch a browser that advertises H.264 and then cannot
  show it.

**D3. Must the in-session viewer strings be translated before the browser entry ships?**
- (a) No. Ship with English in-session UI (as the native viewer is today), and translate all page chrome, failure,
  sign-out and leave messages. W8 translates the in-session strings later. *Pro:* doesn't hold the Linux fix on about
  100 strings × 7 locales (inferred count). *Con:* mixed-language screen for non-English users at first.
- (b) Yes. W8 runs before W7. *Pro:* consistent from day one. *Con:* delays the fix.
- **Recommend (a).** The strings are externalized in W2c either way, so W8 is mechanical.

**D4. How is the browser session kept away from users until the lab leg passes?**
- (a) No flag; gate on wave order, with the page merged but not linked. *Pro:* no env-var plumbing. *Con:* the page
  can be opened by URL before the lab leg, with media, input and cleanup behaviour not yet validated.
- (b) A runtime flag via `GET /config`, default off, that disables the page's start behaviour as well as the entry
  points, removed after the lab leg passes. *Pro:* nothing unvalidated can start in production, and the lab tests
  the real flow. *Con:* an env var, a compose mapping and a docs row for a few weeks, then a removal wave.
- (c) Keep the functional page (W5) unmerged until the lab leg passes. *Pro:* no flag. *Con:* the lab tests a branch,
  and a long-lived branch drifts against the viewer refactor.
- **Recommend (b).** r1 recommended (a). The independent review pointed out that an unlinked page is not a gate,
  because "same auth" does not make unvalidated media, input and cleanup behaviour harmless. I agree and changed the
  recommendation.

**D5. How should the audit record a browser session?**
- (a) An `exchangeOrigin` value (§5.5), carried in the viewer token and written to `session_offer_submitted`
  details. No schema change. *Pro:* no migration, old viewers record `unknown` without changes. *Con:* not visible in
  the session history list, and it records attempted starts.
- (b) As (a), plus a column on `remote_sessions` for a history badge. *Con:* a migration plus an export-policy
  classification for a display nicety.
- **Recommend (a).** (b) can follow if anyone asks for the badge.

**D6. Should the tab connect on its own when it opens?**
- (a) Auto-connect when launched fresh from Connect Desktop, otherwise show a Connect button. *Pro:* one click for the
  normal path. *Con:* needs a one-shot launch intent whose ownership, expiry, consumption and reload behaviour are
  not yet specified. Done loosely, it lets a restored tab start a session and a consent prompt by itself.
- (b) Always require an explicit Connect in the tab. *Pro:* simplest. Reloads, restored tabs and links can never
  start a session unasked. The click also counts as a user gesture for fullscreen, clipboard and later audio.
  *Con:* every session takes two clicks.
- (c) Always auto-connect. *Con:* a restored browser session starts remote sessions, and consent prompts, by itself.
- **Recommend (b) for v1.** r1 recommended (a). The independent review argued that (a) is safe only once the launch
  intent is fully specified, and I agree. (a) stays a follow-up once that is written.

**D7. Should partners be able to forbid browser sessions separately from the native viewer?**
- (a) No. The browser uses the existing `webrtcDesktop` capability. *Pro:* no new setting; the checks are identical.
  *Con:* an MSP worried about the dashboard origin has no lever except training.
- (b) Yes, a switch in the Remote Access policy. *Con:* a new setting, its resolver, and the UI. Enforcement would
  depend on `exchangeOrigin`, which is informational (§5.5), so a non-browser client could get around it.
- **Recommend (a).** A control that rests on a value the client chooses is not one to advertise.

## 17. Left to the builder

- The package name, its module boundaries, and the exact host interface.
- The watchdog thresholds and start window, set from lab data.
- The configuration source for the dashboard origin(s) used by `exchangeOrigin`.
- The flag's env var name.
- Whether to bind the connect code to the issuing user agent when the browser mints it (§6.1).
- The catalog format for externalized viewer strings.
