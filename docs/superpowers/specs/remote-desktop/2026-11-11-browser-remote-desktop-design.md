---
title: In-browser remote desktop — a WebRTC desktop session in a dashboard tab, for technicians the native viewer cannot serve (Linux first)
status: draft 2026-11-11 — awaiting Todd's approval (Gate A)
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
gets a working session (picture, input, clipboard, audio) in a tab. They don't install anything and no new sign-in
path is involved. A browser that cannot decode the stream gets a clear message and is never left on a blank
picture.

### Current state (verified on `main` at `ae686e1ee4`, by reading code; nothing run)

| # | Fact | Source |
|---|---|---|
| F1 | A service- or headless-mode agent refuses the WebSocket desktop stream. Only the WebRTC start is handed to the helper in that mode. | `agent/internal/heartbeat/handlers_desktop.go:711-715`, `:335` |
| F2 | The agent registers pion's default codecs and sends one H.264 track at `profile-level-id=4d001f` (Main, level 3.1). It answers PLI/FIR with a keyframe, rate-limited to one per 500 ms after the first. | `agent/internal/remote/desktop/session_webrtc.go:88-91`, `:174-181`, `:213-225` |
| F3 | The viewer makes the offer and the agent answers. The viewer adds a receive-only video transceiver with no codec preference, so the offer carries whatever video codecs the engine has. | `apps/viewer/src/lib/webrtc.ts:227`, `:396-412`; `session_webrtc.go:745-754` |
| F4 | The dashboard mints a one-time desktop connect code (`POST /remote/sessions/:id/desktop-connect-code`) and puts it in a `breeze://connect?...&code=...` deep link. | `apps/api/src/routes/remote/sessions.ts:854-899`; `apps/web/src/components/remote/ConnectDesktopButton.tsx:550-572` |
| F5 | The viewer redeems the code at `POST /desktop-ws/connect/exchange` for a JWT with audience `breeze-viewer`, scoped to one session, 2 h lifetime. | `apps/viewer/src/lib/api.ts:57-70`; `apps/api/src/routes/desktopWs.ts:1784-1851`; `apps/api/src/services/jwt.ts:15`, `:353-375` |
| F6 | The dashboard has no WebRTC code. No file under `apps/web/src` references `RTCPeerConnection`. The web terminal is WebSocket + xterm. | search of `apps/web/src`; `apps/web/src/components/remote/RemoteTerminal.tsx:20`, `:337` |
| F7 | The in-browser VNC page is a thin Astro page (`Layout` + `AuthOverlay` + `ToastContainer` + one `client:only` React island). Its URL carries only the tunnel id, and the page mints its own one-time WebSocket ticket with the dashboard's session. | `apps/web/src/pages/remote/vnc/[tunnelId].astro:14-27`; `apps/web/src/lib/remoteTunnelUrls.ts:1-3`; `apps/web/src/components/remote/VncViewerPage.tsx:52` |
| F8 | 7 of the viewer's 58 non-test source files import `@tauri-apps/*`: `App.tsx`, `components/DesktopViewer.tsx`, `components/QuitConfirm.tsx`, `components/UpdateIndicator.tsx`, `lib/clipboardIO.ts`, `lib/devicePrefs.ts`, `lib/updateActions.ts`. `lib/webrtc.ts` and the input, keymap, ICE and stats modules do not. | search of `apps/viewer/src` |
| F9 | `DesktopViewer.tsx` (3,203 lines, the video and input component) calls Tauri for window title (`:879`, `:1250`), one-window-per-device registration (`:1349-1380`, `:2852`), clipboard read for paste-as-keystrokes (`:2200`) and saving screenshots (`:2766`). | `apps/viewer/src/components/DesktopViewer.tsx` |
| F10 | The viewer already has seams a host adapter can use. Clipboard goes through `LocalClipboardIO`, preferences through `PrefsStore`, and Keyboard Lock through `navigator.keyboard`, with a silent no-op where it is missing. | `apps/viewer/src/lib/clipboardSync.ts:58-64`; `apps/viewer/src/lib/devicePrefs.ts:22-25`; `apps/viewer/src/lib/keyboardLock.ts:1-24` |
| F11 | The viewer has no i18n. No file in `apps/viewer/src` imports an i18n library; its UI strings are English literals. | search of `apps/viewer/src` |
| F12 | Creating a desktop session ends the caller's other live sessions of the same type on the same device. | `apps/api/src/routes/remote/sessions.ts:312-355` |

### Spike claims checked

The scoping comment on #9557 was a read-only code read. Checked against `main`:

- **No new auth path needed.** Correct (F4, F5). A tab can mint and redeem the same code. §5.4 recommends doing both
  inside the tab so the code never crosses a boundary.
- **About 7 of ~60 viewer files touch Tauri.** Correct: 7 of 58 (F8).
- **None of them are in streaming or input.** Partly wrong. `lib/webrtc.ts` and the input libraries are Tauri-free,
  but `DesktopViewer.tsx`, which owns the video element and all input handling, imports `invoke` at line 2 and calls
  Tauri in the places listed in F9. None of those calls are on the media or input path itself, so the conclusion
  holds (the component can be shared behind an adapter), but the component needs surgery, not just a move.
- **The VNC page is a layout template.** Correct (F7).
- **The web terminal is WebSocket + xterm; the dashboard has no WebRTC.** Correct (F6).
- **Viewer offers, agent answers; default codecs plus an H.264 Main `4d001f` track.** Correct (F2, F3).

## 2. Goals

1. A desktop session to any device the technician can already reach, in a tab of a Chromium-based browser, with
   picture, mouse, keyboard, clipboard, audio, monitor switching and view-only. It uses the WebRTC pipeline the
   viewer already uses.
2. One viewer frontend, shared by the Tauri app and the dashboard, so a fix to streaming or input lands in both.
3. No new authentication or authorization path. Every check that gates the native viewer gates the tab, at the
   same points.
4. A browser that cannot decode the stream is told so before a session is created, or within seconds if decoding
   fails after connecting. It is never left on a blank picture.
5. The audit trail says whether a session ran in a browser.

## 3. Non-goals

- Firefox support in v1, or any browser without H.264 WebRTC decode (maintainer decision 2026-11-11).
- A VP8 fallback on the agent (follow-up, §13).
- Fixing the Linux native viewer (custom WebKitGTK or Chromium shell). Not planned.
- VNC-relay sessions in the new page. The in-browser VNC page already covers them (F7).
- Remote desktop on the mobile app or in the customer portal.
- Recording, file transfer or multi-session switching beyond what the viewer already does.

## 4. Anti-goals: a failure even if it technically works

- **The connect code or viewer token appears in a URL, browser history, a `Referer` header, a server access log or
  `postMessage`.**
- **A reload, restored tab, bookmark or forwarded link starts a session the technician did not just ask for.**
- **A Firefox user sees a black rectangle and a spinner.**
- **The native viewer regresses** because of the extraction. It ships to technicians' machines on three OSes.
- **A second sign-in path**, or a check that runs for the viewer but is skipped for the tab.
- **The browser option crowds out the native viewer** on Windows and macOS, where the viewer is the better tool.

## 5. Design

### 5.1 Who it is for, and where it is offered

Linux technicians first. It works on any OS, and it also helps anyone who cannot install the viewer, such as a
locked-down workstation or a borrowed machine.

**Recommendation (D1):** offer it on every OS, but make it the primary click only on Linux.

- **Linux** (detected by the existing `detectOS` helper, `apps/web/src/lib/viewerDownload.ts:45-65`): the primary
  Connect Desktop click opens the browser session. "Breeze Viewer" stays in the menu for devices the Linux viewer can
  reach (macOS and Linux agents not in service mode).
- **Windows and macOS:** the primary click still hands off to the viewer. "Open in browser" is in the menu, and on
  the card shown when the viewer did not pick up the deep link (`ConnectDesktopButton.tsx:636-637`).

OS detection only picks the default here. It never decides whether the browser session is allowed. That is the
capability check in §5.6.

### 5.2 Sharing the viewer frontend

Options:

| Option | For | Against |
|---|---|---|
| **A. Shared workspace package behind a host adapter** (`packages/remote-desktop-ui`, source-exported like `packages/document-ui`) | One copy of the streaming and input code. A Tauri-free package can be enforced by a test. Precedent exists: `@breeze/document-ui` is consumed from source (`packages/document-ui/package.json`, `main: ./src/index.ts`). Both apps already use React 19, Tailwind 4 and zustand 5 (`apps/viewer/package.json`, `apps/web/package.json`). | The largest piece of work. It touches the shipped native viewer. Web's Tailwind must scan the package's sources (inferred). |
| B. Web imports from `apps/viewer/src` by path alias | No package to create | One app reaching into another app. Breaks as soon as the viewer moves a file. Tauri imports leak into the web bundle. |
| C. Build the viewer as a separate static bundle and serve it under the web origin | No refactor of the component | A second React and Tailwind build. It escapes web theming, i18n, `AuthOverlay` and the toast host. A second CSP surface to keep right. |
| D. Copy the viewer code into web | Fast | Two copies of a 3,200-line component that drift. Every input fix must be made twice. |

**Recommendation: A.** The scoping comment also noted that a Chromium shell for the Linux viewer would need the same
adapter refactor, so the work is not wasted whatever happens to the native viewer.

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
| `connect` (how the viewer gets a session id and a viewer token) | Deep-link params (`protocol.ts:7-14`), then `exchangeDesktopConnectCode` | In-page create, mint and exchange (§5.4) |
| `clipboard: LocalClipboardIO` | `createTauriClipboardIO` (`clipboardIO.ts:68`) | Async Clipboard API. Text and PNG in Chromium. Reads need the `clipboard-read` permission; any read or write needs the page focused. |
| `prefs: PrefsStore` | Tauri store (`devicePrefs.ts:137-139`) | `localStorage` behind try/catch, falling back to the in-memory store (`devicePrefs.ts:123`) |
| `setTitle(hostname)` | `update_session_hostname` | `document.title` |
| `registerSession` / `registerDevice` (one window per device) | Tauri commands (`DesktopViewer.tsx:1349-1380`) | `BroadcastChannel` per device: a newer tab tells an older tab for the same device that it was replaced, so the older tab shows "Opened in another tab" instead of a generic revocation. The server already ends the older session (F12). |
| `saveScreenshot(bytes)` | `save_screenshot` (`DesktopViewer.tsx:2766`) | Download via a blob URL |
| `fullscreen` + Keyboard Lock | Already through `navigator.keyboard` (`keyboardLock.ts`) | The same code. Chromium honours the lock only in fullscreen. |
| `onLeave` (closing with a live session) | `QuitConfirm` | `beforeunload` prompt while connected (§5.5) |
| `strings` (UI copy) | English catalog | The web i18n `t` for the `remoteDesktop` namespace, or English (D3) |
| Updater, deep-link intake, quit prompt | Present | Absent |

A unit test fails the build if any file in the package imports `@tauri-apps/*`.

### 5.4 Session start in a tab: where the code goes

**Flow (recommended):**

1. The technician picks "Open in browser" (or the Linux primary click). The dashboard calls `window.open` synchronously
   inside the click, so no popup blocker gets involved, with `/remote/desktop/<deviceId>`. The URL carries the device
   id and, for RDS hosts, the chosen Windows session in the fragment. Both are identifiers, not credentials. The tab
   also gets a launch intent (§5.5).
2. The page runs the capability check (§5.6) **before** creating anything, so an unsupported browser never creates
   a session or prompts the end user.
3. Still in the page, using the dashboard's own session (`fetchWithAuth`, as the VNC page does, F7):
   `POST /remote/sessions` → `POST /remote/sessions/:id/desktop-connect-code` → `POST /desktop-ws/connect/exchange`.
4. The viewer token is passed to the shared component in memory. From then on the tab uses exactly the endpoints the
   native viewer uses (`/desktop-ws/:id/viewer/*`).

**Why mint and redeem in the same page.** The code travels only from one response body to the next request body. It
is never put in a URL, so it cannot reach history, a `Referer`, the reverse proxy's access log, or a browser extension
reading the address bar. The alternatives were weighed:

| Carrier | Assessment |
|---|---|
| Query string (`?code=`) | Rejected. It lands in history and access logs, and in the `Referer` of any request the page makes. |
| Fragment (`#code=`) | Not sent to the server, but kept in history and visible to anything that reads the URL until scrubbed with `history.replaceState`. Workable, and unnecessary. |
| `postMessage` from the opener | Needs an opener relation (no `noopener`), strict origin checks on both sides, and a load race. Workable, more moving parts, no benefit. |
| **Mint and redeem in the tab** | **Chosen.** Nothing crosses a window, process or URL boundary. |

The exchange step is kept, although the page already holds the dashboard's session, so that the shared component
consumes the same narrow credential in both hosts and no new viewer route has to accept the dashboard's token.

**Single use and TTL, as implemented:**

- The code is 24 random bytes, base64url (`apps/api/src/services/remoteSessionAuth.ts:121-123`, `:434`). It lives
  2 minutes (`:11`), in Redis with `SETEX` outside development and test (`:104-111`, `:441-449`).
- It is redeemed by an atomic `GET`+`DEL` (`:195-201`, `:457-466`), so a second redemption fails even inside the
  TTL. The exchange route says so, and asks clients to guard against React strict-mode double-firing
  (`apps/api/src/routes/desktopWs.ts:1780-1783`). The viewer has such a guard (`DesktopViewer.tsx:169`), and the
  browser host needs one too.
- The code record holds the session id, user id and email (`remoteSessionAuth.ts:66-71`). It is not bound to the
  caller's IP or user agent, unlike the 60-second WebSocket ticket (`:23-36`, `:394-405`). That is reasonable for
  the native viewer, which redeems from a different process. In the tab, minting and redeeming happen in the same
  browser, so binding the code to the issuing user agent would be cheap hardening. It is listed as a builder option,
  not a requirement.

**Token storage in the page.** The viewer token is held in memory only, never in `localStorage`, `sessionStorage`,
a cookie or a URL. That matches the dashboard, which keeps its own access token in memory and restores it from a
refresh cookie (`apps/web/src/stores/auth.ts:364-372`). A reload drops the viewer token; the page redoes step 3. The
session id, which is not a credential, is kept in `sessionStorage` so a reload resumes the same session through the
reconnect path the viewer already uses (`desktopWs.ts:1870-1879`) instead of creating a new one. *Not checked:*
whether a resumed start re-prompts the end user in consent mode. This is a lab-leg item.

### 5.5 What a tab exposes that the native viewer does not

| Exposure | Handling |
|---|---|
| **Browser extensions** with access to the dashboard origin can read the page (including the video and the in-memory viewer token) and dispatch synthetic events. The dashboard's terminal and its own access token are exposed the same way today (inferred), so this is not a new class. The viewer token is narrower than the dashboard token (one session, `breeze-viewer` audience, `jwt.ts:373`). | The browser host drops keyboard and mouse events whose `isTrusted` is false before they reach the input channel. The docs recommend a browser profile without broad-access extensions for remote work. |
| **Reload, restored tabs, bookmarks, forwarded links** can reopen `/remote/desktop/<deviceId>`. | The page auto-connects only with a fresh launch intent from Connect Desktop in the same browser. Otherwise it shows the device name and a **Connect** button (D6). A forwarded link is inert: the recipient needs their own session, `remote:access` and MFA. |
| **Browser shortcuts** (Ctrl+W, Ctrl+T, Ctrl+N) are kept by the browser unless the tab is fullscreen with Keyboard Lock. Ctrl+W meant for the remote closes the tab. | `beforeunload` confirmation while connected. The toolbar's Send Keys menu stays the way to send reserved combinations outside fullscreen. Ctrl+Alt+Del is a command, unaffected. |
| **Clipboard permission persists per origin.** After a technician grants `clipboard-read`, any later dashboard page on that origin can read the clipboard without asking (inferred from the browser permission model). | Clipboard sync only runs while the session tab is focused and connected. Stated in docs. |
| **Background tabs.** Chromium throttles timers in hidden tabs. The lease renews every 25 s with a 90 s grace (`apps/api/src/services/remoteRevocationLease.ts:54`, `:61`). | Pages with live WebRTC connections are believed to be exempt from intensive throttling (inferred, not checked). Lab leg: 10 minutes hidden, session must survive. |
| **Crash or killed browser.** No quit prompt runs. | The revocation lease ends the session after its grace, as for a crashed viewer (inferred: same lease path). |
| **Screenshots** go to the browser's downloads folder and download history. | Stated in docs. |
| **Session restore of a remote screen** in tab thumbnails or history previews. | History holds only the device id. Thumbnails are the browser's business; not mitigated. |

**CSP and framing.** The page inherits the dashboard CSP: `frame-ancestors 'none'` (`apps/web/astro.config.mjs:79`)
so it cannot be framed, and `connect-src` is tightened at runtime to the configured API origin
(`apps/web/src/middleware.ts:128-150`, `apps/web/src/lib/csp.ts:128-153`). No CSP change is expected. Two
*inferred* points need confirming with the CSP drift guard the web build already runs (`apps/web/astro.config.mjs:91-99`):
ICE and TURN traffic is not governed by `connect-src`, and a `MediaStream` attached through `srcObject` is not a URL
load under `default-src 'self'`. `Permissions-Policy` denies camera, microphone, geolocation and payment only
(`apps/web/src/middleware.ts:227`; `docker/Caddyfile.prod:480`), leaving clipboard, fullscreen and Keyboard Lock
available to the same origin. The page asks for no microphone or camera. `Referrer-Policy` defaults to
`strict-origin-when-cross-origin` (`apps/web/src/middleware.ts:126-127`). Since the URL carries no secret, no
page-level override is needed.

### 5.6 Checks on this path

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
| Continuous revocation | Lease renew every 25 s (`desktopWs.ts:2188-2224`), which also checks viewer-token `jti` revocation (`:2199`) |
| End-user consent / notify | Agent-side, unchanged; the browser path sends the same start |

### 5.7 Unsupported browsers

**Detection is capability-based, not user-agent based.** User-agent sniffing gets both directions wrong.
H.264 support varies within Chromium (distribution builds) and within Firefox (Debian's default pref, the
OpenH264 plugin download, Fedora's system plugin, as measured on #9557), and a user agent shows neither.
The user agent is used only to choose the default (§5.1) and never to decide whether the session is allowed.

Three layers:

1. **Fast path:** `RTCRtpReceiver.getCapabilities('video')` lists `video/H264`. If the API is missing, fall through.
2. **Authoritative check:** create a throwaway `RTCPeerConnection` with a receive-only video transceiver, call
   `createOffer`, and look for an `H264/90000` rtpmap, then close it. This is literally the offer the agent will see
   (F3), so it cannot disagree with negotiation. No network traffic and no permission prompt (inferred).
3. **Runtime watchdog:** after connecting, if video packets arrive but `framesDecoded` stays at 0 for a few seconds
   (threshold left to the builder), end the session and show the same message. This covers a browser that
   advertises H.264 and then fails, such as a Firefox profile whose OpenH264 download is still in progress. The
   viewer already reads these stats (`apps/viewer/src/lib/statsReporter.ts:76-136`).

The dashboard runs layers 1 and 2 before offering the entry. An unsupported browser sees "Open in browser" disabled,
with the reason. The page runs them again on load, since it can be opened directly.

**Copy intent** (final wording in the web locale files):

- Title: the browser can't show the remote desktop.
- Body: remote desktop in the browser needs H.264 video, which this browser doesn't offer. Use Chrome, Edge or
  another Chromium-based browser, or the Breeze Viewer.
- Actions: **Download Breeze Viewer** (existing download info), **Copy link** (to open the same page in another
  browser), **Back to device**.
- No blame and no jargon beyond "H.264", which a technician can search for. Firefox is not named, because the check
  doesn't know it is Firefox.
- Watchdog variant: "Connected, but this browser isn't decoding the video", with the same actions.

**Browsers that pass the check but are not Chromium** (Firefox with OpenH264, Safari): see D2.

### 5.8 Dashboard entry points

- **Connect Desktop menu:** today the split-button menu only appears when a third-party remote tool is configured
  (`ConnectDesktopButton.tsx:1275`). It must appear whenever the browser option exists, listing **Breeze Viewer** and
  **Open in browser** (plus any third-party tools as today). `ConnectChoice` (`:30`) gains a `{ kind: 'browser' }`
  member.
- **Primary click on Linux** opens the browser session (D1).
- **Viewer did not open:** the card shown after the deep-link poll times out (`:636-637`) gains **Open in browser**,
  like the VNC card's existing button (`:713-719`). The pending session from the failed hand-off is ended by the new
  create (F12).
- **RDS session picker** runs before the tab opens, as it does for the viewer. Its choice goes in the fragment.
- **VNC fallback is unchanged.** When the device can only be reached over VNC relay, the existing in-browser VNC page
  is the browser option.

### 5.9 The page

`apps/web/src/pages/remote/desktop/[deviceId].astro`, built like the VNC and terminal pages (F7;
`apps/web/src/pages/remote/terminal/[deviceId].astro:12-34`): `Layout` with a `titleKey`, `AuthOverlay`,
`ToastContainer`, and one `client:only="react"` island that composes the browser host with the shared component.
States: checking → unsupported | ready (Connect button) → connecting → connected → ended (with reason). The ended state
offers **Reconnect** and **Back to device**.

### 5.10 Session audit

Today `session_initiated` records device, hostname and type (`sessions.ts:383-395`). `session_offer_submitted`, written
for every viewer start, records `via: 'viewer_token'` (`desktopWs.ts:2082-2093`). Both go into `audit_logs.details`,
a `jsonb` column (`apps/api/src/db/schema/audit.ts:32`) written by `logSessionAudit`
(`apps/api/src/routes/remote/helpers.ts:349-380`).

**Recommendation (D5):** at `/connect/exchange`, derive `client` from the request's `Origin` header. The configured web
origin gives `browser`, a Tauri origin gives `viewer`, anything else gives `unknown`. Carry it as a claim in the viewer
token, and descendant tokens inherit it. Write it into `session_offer_submitted` details, next to `via`.

- A browser page cannot forge its `Origin`, so a browser session is never recorded as a viewer session. A non-browser
  client can send anything, so the field is **informational, not a control**, and the docs say so.
- Deriving it server-side, rather than taking it from the request body, means older viewers need no change.
- No table or column changes.

## 6. Tenancy and data

**No table is added and no column is added** under the recommended options. The audit field lives in
`audit_logs.details` (`jsonb`) and in a JWT claim. Nothing new needs RLS, cascade, merge or export registration.

If D5 option (b) is chosen (a `client` column on `remote_sessions` so session history can show a Browser badge),
the column needs an export-policy classification. `remote_sessions` is registered in `CORE_TENANT_EXPORT_POLICY`
(`apps/api/src/services/tenantExportPolicyRegistry.ts:839`). A `text` enum-like column would go under `included`
after review. The migration must follow `apps/api/migrations/README.md`.

**Settings:** none added under the recommendation. A browser session uses the existing `webrtcDesktop` capability of
the Remote Access policy (`remoteAccessPolicy.ts:24`). Places the concept is configured: 0 before, 0 after. If the
maintainer wants partners to be able to forbid browser sessions (D7), its home is that same Remote Access policy, at
the existing policy levels. That makes 1 place after.

## 7. i18n

Web locales under `apps/web/src/locales/`: **`en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`**
(8). Every new key goes into all 8 (`apps/web/src/locales/README.md`, steps 2-3; parity is enforced by
`apps/web/src/lib/i18n/localeParity.test.ts`). pt-BR additions carry the machine-drafted note the README requires.

New web-owned strings (in `remote.json` and a page title key): the menu item and its disabled reason, the
Linux-default label, the failed hand-off button, and on the page the checking, unsupported, watchdog, Connect,
ended, "opened in another tab" and leave-confirmation states.

**In-session viewer UI** (toolbar, notices, chips) is English in the viewer today (F11). The package takes a string
catalog from the host (§5.3), so the strings are externalized during the extraction with an English catalog. Whether
the 8 translations block the browser launch is D3.

## 8. Testing

Rigor: full. This touches remote-session auth flow and code that ships to technicians' machines (the viewer).

| Layer | What | Where it runs |
|---|---|---|
| Package (unit) | All viewer library tests move with their modules, unchanged. A host contract test with a fake host covers clipboard denied, prefs unavailable, Keyboard Lock missing and screenshot failure. A guard test makes sure the package has no `@tauri-apps/*` import. | `test-web` / package vitest |
| Native viewer | The existing `apps/viewer` tests still pass against the package. A manual smoke of the Tauri viewer on one OS per extraction wave covers deep link, stream, input, clipboard both ways, screenshot, quit prompt and one window per device. | CI and manual |
| Browser host (unit) | Capability detector against recorded offer SDPs (Chromium with H.264, Firefox without, Firefox with OpenH264). The watchdog trips on packets without decoded frames and stays quiet on a normal start. The `isTrusted` filter, the `BroadcastChannel` hand-over, the strict-mode one-shot exchange, and that the token is never written to storage or the URL. | `test-web` |
| API | `client` derived from `Origin` (web origin, Tauri origins, missing, foreign). The claim appears in `session_offer_submitted` and is inherited by descendant tokens. Existing single-use, TTL and live-authorization tests for the code are unchanged. | `test-api` |
| Web components | Menu shows with no third-party tools; Linux primary; disabled item in an unsupported browser; failed hand-off card; RDS choice carried in the fragment, never a credential. | `test-web` |
| E2E (Playwright, `data-testid`) | The page renders, the unsupported state appears in a browser without H.264, the Connect button appears without launch intent, and no request URL contains a connect code. Playwright's bundled Chromium may lack H.264 (inferred; its docs point to the `chrome` channel for proprietary codecs), so the supported path needs the `chrome` channel or stays manual. No agent streams in CI. | e2e job |
| CSP | The new page is added to the CSP drift guard's page list. Zero violations while connected. | web CI |

**Lab leg (blocking before the entry point ships, §11 W5).** Real Linux browsers against a real Windows agent in
service mode, with the hardware (MFT, Main profile) encoder:

1. Google Chrome on Linux (amd64), Debian 13 distro Chromium, Fedora distro Chromium, and Ubuntu's snap Chromium.
   The snap could not be tested in containers on #9557.
2. Each: connect, 10 minutes of mixed use, input (drag-select, typing on a non-US layout), clipboard both ways (text
   and image), audio on, monitor switch, view-only, fullscreen with Keyboard Lock (Alt+Tab and the Windows key reach
   the remote), Ctrl+W protection, reload mid-session (resume, and whether consent re-prompts), a second tab for the
   same device, and 10 minutes as a hidden tab.
3. **Fedora GOP-loss check (open risk, §12 R1):** compare the agent's sent-frame count with the tab's `framesDecoded`,
   `keyFramesDecoded` and `pliCount` over the 10 minutes, with Debian Chromium and Google Chrome as controls.
4. Unsupported path: Debian Firefox ESR (default prefs) and a fresh Ubuntu Firefox profile get the message, never a
   blank picture.
5. Audit: the session's `session_offer_submitted` row says `client: browser`.

**Cannot be covered locally or in CI:** a Windows service-mode agent with its user helper, real hardware-encoder
output, distro and snap browser builds, headed GPU decode, Wayland versus X11 behaviour of fullscreen and Keyboard
Lock, and background-tab throttling over minutes.

## 9. Docs

- `apps/docs/src/content/docs/features/remote-access.mdx:671-673`: the caution "The Linux viewer cannot connect to
  Windows devices yet" gets a pointer to the browser session.
- `apps/docs/src/content/docs/deploy/binaries.mdx:223`: same.
- `remote-access.mdx` gets a new section, "Remote desktop in a browser". It covers supported browsers (Chromium-based,
  H.264), how to open it, what differs from the viewer (shortcuts only in fullscreen, clipboard permission and focus,
  audio needs a click, one tab per device, screenshots go to downloads), the extension advice, and the informational
  audit field.
- Release notes for the release that ships W6.

## 10. Rollout

**Recommendation (D4): no runtime flag. The rollout is gated by wave order.** The page (W4) ships with no link to it,
so it is reachable only by URL, and it is harmless: same auth, same checks. The entry points (W6) merge only after
the lab leg (W5) passes. A build-time `PUBLIC_*` flag would not work for prebuilt images
(`apps/web/src/lib/featureFlags.ts:43-46`). A runtime flag would mean an env var, a compose mapping, docs and a later
removal, all to protect an additive menu item.

## 11. Waves

Each wave can be merged on its own and has an outcome someone can check.

| Wave | Contents | Verifiable outcome |
|---|---|---|
| W1 | Create `packages/remote-desktop-ui`. Move the Tauri-free viewer libraries and their tests. `apps/viewer` imports from the package. No behaviour change. | The diff is moves and import paths. Viewer tests pass from the package. The viewer builds. |
| W2 | Host adapter: move `DesktopViewer`, `ViewerToolbar` and the components they render. Replace every Tauri call with a host call. Tauri host in `apps/viewer`. Externalize UI strings to an English catalog. Add the no-Tauri guard test. | The package has no `@tauri-apps` import (test). Manual smoke of the native viewer on one OS. |
| W3 | API: `client` from `Origin` at exchange, the viewer-token claim, and the audit detail. | API tests. A viewer session records `client: viewer`. |
| W4 | Browser host, capability detector, watchdog, launch-intent guard, `beforeunload`, `isTrusted` filter, the page `/remote/desktop/[deviceId]` (no link to it yet), and page strings in 8 locales. | Unit and E2E tests. Manually, a Chromium tab streams from a dev agent. The unsupported state shows in Firefox. |
| W5 | Lab leg (§8), no code. Results are written up on #9557. | Every lab item passes, or failures are filed and triaged before W6. |
| W6 | Entry points (menu, Linux primary, failed hand-off card), strings in 8 locales, docs, release note. | Component and E2E tests. Docs build. |
| W7 (optional) | Translate the in-session viewer strings into the 8 web locales (D3). | Locale parity covers the new namespace. |

W3 does not depend on W1 or W2 and can land first. W4 depends on W2. W6 depends on W4 and W5.

## 12. Risks

- **R1. Fedora Chromium lost about one GOP per 15 s on Main profile only** (#9557, synthetic x264 clip). The cause is
  not established. The test server may not have answered PLI, while the real agent does (F2), so the real loss may be
  smaller (inferred). Proposed check: lab item 3. If it reproduces on the real agent, the release notes name it as a
  known issue, and a follow-up evaluates offering Constrained Baseline where the encoder supports it. It does not
  block v1 unless the stream is unusable.
- **R2. Native viewer regression** from W1 and W2. Mitigated by moves-only W1, the guard test, and the manual smoke.
- **R3. Background-tab throttling** stalling lease renewal. Mitigated by verifying in the lab, and by the lease grace.
- **R4. Distro Chromium builds without H.264.** Handled by the capability check, never by a blank picture.

## 13. Out of scope and follow-ups

- **VP8 fallback on the agent,** chosen when the viewer's offer has no H.264. VP8 decoded on stock Debian and Fedora
  Firefox with nothing installed (#9557). This would bring Firefox into scope.
- Constrained Baseline offer (R1).
- A Browser badge in session history (D5 b).
- A policy switch to forbid browser sessions (D7 b).
- Translated in-session strings in the native viewer, which would need a locale source.

## 14. Decisions for the maintainer

**D1. Should the browser session be offered on every OS, or only on Linux?**
- (a) Every OS. Primary click on Linux, menu item and failed-hand-off card elsewhere. *Pro:* helps anyone without the
  viewer, and gives a recovery path when the hand-off fails. *Con:* one more menu item for Windows and macOS users.
- (b) Linux only. *Pro:* smallest surface. *Con:* leaves out locked-down machines and failed hand-offs on other OSes.
- (c) Every OS, equal standing. *Con:* steers Windows and macOS users away from the better tool.
- **Recommend (a):** the cost is one menu item, and the failed-hand-off card is where it saves a session.

**D2. What happens in a non-Chromium browser that passes the H.264 check (Firefox with OpenH264, Safari)?**
- (a) Allow it, with a one-line "this browser isn't officially supported" notice. *Pro:* consistent with
  capability-based detection; Fedora Firefox decoded the stream. *Con:* support questions from an untested path.
- (b) Block by engine, using the user agent. *Pro:* matches "Chromium only" literally. *Con:* user-agent gating,
  which this design otherwise avoids, and it refuses a browser that works.
- (c) Allow silently. *Con:* hides that it's untested.
- **Recommend (a):** the watchdog still catches a browser that advertises H.264 and then cannot decode it.

**D3. Must the in-session viewer strings be translated before the browser entry ships?**
- (a) No. Ship with English in-session UI (as the native viewer is today) and translated page chrome. W7 translates
  later. *Pro:* doesn't hold the Linux fix on about 100 strings × 7 locales (inferred count). *Con:* mixed-language
  screen for non-English users at first.
- (b) Yes. W7 runs before W6. *Pro:* consistent from day one. *Con:* delays the fix.
- **Recommend (a):** the strings are externalized in W2 either way, so W7 is mechanical.

**D4. Should the rollout use a runtime flag?**
- (a) No flag. Gate the entry points on wave order and the lab leg. *Pro:* no env-var plumbing to add and later
  remove. *Con:* no off switch after release short of a revert.
- (b) A runtime flag via `GET /config`, default off. *Pro:* an off switch per deployment. *Con:* env var, compose
  mapping, docs and a cleanup wave.
- **Recommend (a):** the feature is additive, uses existing auth, and the lab leg is the real gate.

**D5. How should the audit record a browser session?**
- (a) A `client` value derived from `Origin`, carried in the viewer token and written to `session_offer_submitted`
  details. No schema change. *Pro:* no migration, works with old viewers. *Con:* not visible in the session history
  list.
- (b) As (a), plus a `client` column on `remote_sessions` for a history badge. *Con:* a migration plus an
  export-policy classification for a display nicety.
- **Recommend (a).** (b) can follow if anyone asks for the badge.

**D6. Should the tab connect on its own when it opens?**
- (a) Auto-connect only with a fresh launch intent from Connect Desktop. Otherwise show a Connect button. *Pro:* one
  click for the normal path. Reloads, restored tabs and links never start a session unasked. *Con:* the intent
  hand-over is one more mechanism to test.
- (b) Always require a click in the tab. *Pro:* simplest. The click also counts as a user gesture for audio,
  fullscreen and clipboard. *Con:* every session takes two clicks.
- (c) Always auto-connect. *Con:* a restored browser session starts remote sessions, and consent prompts, by itself.
- **Recommend (a).**

**D7. Should partners be able to forbid browser sessions separately from the native viewer?**
- (a) No. The browser uses the existing `webrtcDesktop` capability. *Pro:* no new setting; the checks are identical.
  *Con:* an MSP worried about browser extensions has no lever except training.
- (b) Yes, a switch in the Remote Access policy. *Con:* a new setting, its resolver, and the UI. Enforcement depends
  on the `client` value, which §5.10 says is informational, so a non-browser client could get around it.
- **Recommend (a).** A control that rests on a value the client chooses is not one to advertise.

## 15. Left to the builder

- The package name, its module boundaries, and the exact host interface.
- The watchdog threshold, and how the launch intent is handed over (it must not be a credential and must not be
  replayable from a URL).
- Whether to bind the connect code to the issuing user agent when the browser mints it (§5.4).
- The catalog format for externalized viewer strings.

Advisor quorum: not run for this draft. Recommended before the plan, on §5.2 (shared package) and §5.10 (token claim),
which are the cross-module contracts.
