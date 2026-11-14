---
title: Customer-side mobile support app, view-only screen share (iOS + Android)
issue: LanternOps/breeze#8795
status: draft, for maintainer review (spec only, no code)
builds_on: docs/superpowers/specs/2026-07-06-one-off-support-session-design.md (Quick Support), LanternOps/breeze#3386 (browser view-only), #3153 (Milestone A)
---

# Customer-side mobile support app: design

Status: draft. Issue #8795 asks for the GoToAssist flow on phones: install a store app, type a support code, the technician sees the screen. The maintainer's reply on the issue says to start from the Quick Support design and open a spec before code, so the session model lines up. This is that spec. An adversarial Codex review (gpt-6-astra, 2026-10-15) produced 14 findings; all are folded in and marked `[C<n>]` where they changed the design.

## 1. Summary

A second, customer-facing Expo app (`apps/mobile-support`, separate bundle id, separate store listings) that has no account, accepts a Quick Support code, shows a consent screen naming the partner, and streams the phone screen **view-only** to the technician's existing viewer.

The session **is** a Quick Support session. The technician generates the code on the existing Quick Support page, the code is redeemed on the existing public support surface, and the stream rides the existing `remote_sessions` row, the existing viewer, the existing TURN provisioning, the existing audit actions and the existing reaper. What is new is a **sender channel**: a code-authenticated WebSocket on the public support surface that stands in for the agent command socket for a device that has no agent. The phone is the SDP answerer exactly as the Go agent is today, and it must honour the same lease, fence and consent contract the agent does, because the viewer path is shared and nothing on it is relaxed.

The phone never becomes a managed device. It is an ephemeral `devices` row in the partner's hidden Quick Support org, purged by the reaper, the same as a Windows Quick Support stub.

## 2. Goals

- A technician sees an iPhone, iPad or Android screen in the viewer within a minute of reading a code aloud, with no account on the phone.
- One session model. No parallel "mobile session" tables, codes or viewer.
- Abuse posture at least as strong as Quick Support today: same code entropy, TTLs, miss budget, trust gates, and an informed consent screen that names the partner.
- Self-hosters can use the store app against their own server.

## 3. Non-goals

- **No MDM**: no profiles, no app push, no policy, no compliance.
- **No input control**: the viewer cannot tap, type or scroll on the phone. iOS does not allow it at all; Android would need an Accessibility Service, which is a separate product decision and a separate Play policy review.
- **No file transfer, no clipboard, no terminal, no audio** in v1.
- **No managed-device enrollment and no persistent agent.** The app holds no credentials after a session ends. The "device row that stays in the list" from the issue is out of scope; see decision 7.
- **No browser view-only path** (#3386 stays parked and separate), and no changes to the Windows/macOS stub.
- **No recording.** There is no recording pipeline today (section 4); the mobile session does not add one.

## 4. Existing architecture (verified on `main` at 79cc7ffc7b)

| Fact | Where |
|---|---|
| Public support routes are unauthenticated by design; the code is the auth; ~27 bits, 15-min TTL, per-IP limits, two-tier miss budget, atomic single-use claim | `apps/api/src/routes/supportPublic.ts:35-55` |
| `/check/:code` returns `{valid, branding:{partnerName,logoUrl,accentColor,headline}, signed}`; invalid is a bare `{valid:false}` | `supportPublic.ts:162-223` |
| `/redeem` flips `pending -> claimed`, mints a single-use child enrollment key, audits `support_session_claimed` with `actor: 'end_user'` | `supportPublic.ts:478-589` |
| Redeem `osType` is `windows | macos | linux` only | `packages/shared/src/validators/quickSupport.ts:74` |
| Code alphabet `23456789`, length 9, 15-min code TTL, 8-h hard cap; `code_hash` unique **per database only** | `quickSupport.ts:34-35`, `apps/api/src/services/quickSupportCode.ts:5,12`, `db/schema/supportSessions.ts:27` |
| Miss budget has a per-source /64 tier and a deployment-wide ~500/min backstop, checked before valid lookups | `supportPublic.ts:43-51,154-160`, `services/supportCodeMissBudget.ts:100` |
| Trust gate at redeem/download: `installer_distribute` via `anonymousInstallerDistributionAllowed` | `supportPublic.ts:92-111, 390, 516` |
| Trust gate at creation: `remote_control` | `apps/api/src/services/remoteSessionCreate.ts:105` |
| Creation needs partner or system scope, `remote:access` + MFA | `apps/api/src/routes/remote/supportSessions.ts:64-66`, `routes/remote/index.ts:16-17` |
| `support_sessions` is Shape 1 RLS, has `device_id` (SET NULL), `attributed_org_id`, `hard_expires_at`; registered in cascade, merge, export, device-detach lists | `apps/api/src/db/schema/supportSessions.ts:21-44`; `migrations/2026-08-13-a-quick-support-sessions.sql:94-110`; `services/tenantCascade.ts:906`, `orgMergeRegistry.ts:1158`, `tenantExportPolicyRegistry.ts:862`, `routes/devices/core.ts:208,382` |
| Ephemeral devices: `devices.is_ephemeral`, hidden `quick_support` org per partner, `excludeQuickSupportOrgs()` / `excludeEphemeralDevices()` | `db/schema/devices.ts:110`, `services/quickSupportOrg.ts:12,22,45-80` |
| `devices.os_type` enum is `windows | macos | linux`, NOT NULL; `agent_id` NOT NULL | `db/schema/devices.ts:8,19,64` |
| `remote_sessions.device_id` NOT NULL -> `devices` | `db/schema/remote.ts:26` |
| Reaper: 5-min pass; `claimed` with `device_id IS NULL` expires after 20 min; `ready` offline 5 min = end-user stop; purge 6 h after end | `apps/api/src/jobs/quickSupportReaper.ts:27-34,76-90` |
| Quick Support end sends `support_end` to `device.agentId`, revokes tokens, decommissions the device, force-closes the socket | `services/quickSupportEnd.ts:55-75` |
| Session teardown dispatches `stop_desktop` through the durable relay keyed by `agentId` (cross-instance) | `services/remoteSessionTeardown.ts:164-170`, `services/agentCommandRelay.ts:204` |
| Viewer is the offerer: `recvonly` video transceiver; creates `input` and `control` data channels; no `setCodecPreferences`; falls back to JPEG-over-WebSocket (`desktop_stream_start` to the agent) when WebRTC fails | `apps/viewer/src/lib/webrtc.ts:199,205-206`; `apps/viewer/src/components/DesktopViewer.tsx:1203`; `routes/desktopWs.ts:1115-1128,2162-2235` |
| Agent is the answerer: H264 `packetization-mode=1;profile-level-id=4d001f`, PCMU audio, creates `cursor`/`clipboard` channels, non-trickle ICE (answer after first candidate + 500 ms) | `agent/internal/remote/desktop/session_webrtc.go:161-175,434-466,641-745` |
| Offer delivery: API -> agent command `{id:'desk-start-<sessionId>-<uuid>', type:'start_desktop', payload:{sessionId,startGeneration,offer,iceServers,clipboard,idleTimeoutMinutes,maxSessionDurationHours,revocationLease,prompt?}}`; fails 500 when `device.agentId` is missing | `routes/remote/sessions.ts:1019-1024,1156-1173`, `routes/remote/helpers.ts:494-496` |
| Answer intake: `command_result` whose `commandId` must equal the issued `desk-start-*` id, `event in answer|ice_candidate|peer_disconnected|session_started|consent_denied|clipboard_summary`; accepted only from the authenticated agent WS keyed on `authenticatedAgent.deviceId`; consent-mode starts activate only with a coherent `consentReason` marker | `routes/agentWs.ts:4529-4540,3666-3708` |
| Revocation lease: TTL 60 s, renew every 25 s via `revocation_lease_renew` -> `revocation_lease` / `revocation_lease_revoked`; the agent stops on expiry | `services/remoteRevocationLease.ts:8-10`, `agentWs.ts:3219-3262`, `session_webrtc.go:150-163` |
| Start fence: `isDesktopStartCapable` requires the device's lease and fence protocol versions, and the gate comment says the generation is only meaningful when the endpoint honours it; stop carries `terminalGeneration` | `remoteRevocationLease.ts:860-870,919-931`, `sessions.ts:271-285,1445-1453` |
| Agent idle watchdog counts viewer input as activity (default `idleTimeoutMinutes` 5) | `agent/internal/remote/desktop/session.go:172` |
| Viewer auth: single-use desktop-connect code -> `POST /desktop-ws/connect/exchange` -> bearer viewer token; returns `{accessToken, hostname, osType}` | `sessions.ts:840-884`, `routes/desktopWs.ts:1759-1825` |
| ICE servers: STUN + coturn REST creds from `TURN_HOST`/`TURN_SECRET`, TTL 60-900 s, username embeds `deviceId | 'no-device'` | `routes/remote/helpers.ts:36-101` |
| Consent prompt payload is built server-side and shown by the agent/helper | `helpers.ts:762-822`, `sessions.ts:1050-1079` |
| Audit: `logSessionAudit` writes `audit_logs` rows `resourceType:'remote_session'`; actions `session_initiated`, `session_offer_submitted`, `session_ended`, `session_consent_*`, `support_session_created|claimed|ended` | `helpers.ts:349-377`; call sites in section 7.6 |
| Recording: only `remote_sessions.recording_url` text, set by the client at end; no producer anywhere | `db/schema/remote.ts:60`, `sessions.ts:1352-1381` |
| `/quick` page detects `ios`/`android` and tells the user to go to a Windows PC; download hidden | `apps/web/src/components/quick/QuickLandingPage.tsx:37,62-85,189,237-244`; `locales/en/quick.json:52-54` |
| Technician app: Expo SDK `~57.0.26`, RN `0.86.3`, bundle `com.breeze.rmm`, CNG (`ios/` generated by `expo prebuild`), one custom Expo module (`modules/breeze-attestation`), iOS via Xcode Cloud post-clone hook, Android AAB via local Gradle + Play App Signing; `eas.json` exists but EAS has never been used | `apps/mobile/package.json:25,48`; `app.json`; `STORE_SUBMISSION.md:1-10,60-100`; `ios/ci_scripts/ci_post_clone.sh:1-15`; `modules/breeze-attestation/expo-module.config.json` |
| Technician app server choice: hosted presets US/EU plus a user-entered URL in SecureStore; validator accepts `http:` as well as `https:`; Associated Domains are fixed at build time so a store build cannot cover a self-hosted domain | `apps/mobile/src/services/serverConfig.ts:11-13,20-29,90-111`; `app.config.js` header comment |
| No `getDisplayMedia`, `MediaProjection`, `ReplayKit` or `react-native-webrtc` anywhere in `apps/` or `packages/` | grep, 2026-10-15 |

## 5. UX flow

### Technician

1. Opens Quick Support (existing `QuickSupportPage.tsx`), optionally picks an attribution org and label, clicks Create. **Unchanged.** One code works for a Windows stub and for a phone; the technician does not choose up front.
2. The code panel gains a **QR code** of the existing HTTPS landing link (`/quick?code=`), and one copy line: "On a phone or tablet: install Breeze Support, pick <region>, enter this code" (section 8). The copyable link stays HTTPS so a desktop recipient still lands on the stub download `[C14]`.
3. Status panel shows `waiting -> code entered on iPhone 15 (iOS 18.1) -> sharing`. The existing **Connect** button opens the viewer as today.
4. The viewer shows the stream with the input toolbar disabled, no JPEG fallback, and a "View only" badge (section 6.7).
5. **End session** works as today and also closes the sender socket, which stops the share on the phone.

### Customer (phone)

1. Installs **Breeze Support** (working title; decision 5) from the store. No sign-in. First screen: region picker (United States / Europe / Other server...), one code field, and "Scan code".
2. Enters the code. The app calls `/support/check/:code` on the chosen server; an invalid code shows the same bare "invalid or expired" state as `/quick`.
3. **Consent screen** (section 9.3): partner name and logo from `/check` branding, what will be shared, what the technician cannot do, and the "if you were not expecting this" warning. Buttons: **Share my screen** / **Cancel**.
4. OS consent: iOS shows the system broadcast picker (the user taps "Start Broadcast"); Android shows the MediaProjection dialog (entire screen vs single app on Android 14+). The app cannot skip either.
5. Sharing. iOS shows the system red status indicator; Android shows a persistent notification with a **Stop sharing** action. The app's own screen shows "Sharing with <partner>" and a Stop button.
6. Stop: the user stops from the notification/status bar, the app, or by the technician ending the session. The app returns to the code screen and holds nothing.

## 6. Session model

### 6.1 Lifecycle (reused) and transitions `[C8]`

```
pending --redeem(ios|android)--> claimed --sender WS connects (device row created)--> ready <--viewer offer/answer--> active (derived)
   |  15-min code TTL                 | 20-min limbo (device_id IS NULL, unchanged clause)    | sender gone > 5 min -> ended/end_user
   v                                   v                                                     | share_stopped        -> ended/end_user (immediate)
expired                             ended (reason: tech | end_user | expired | error)
```

Transitions are defined separately because they are not the same event:

| Event | Sender | Server |
|---|---|---|
| Viewer disconnects or technician closes the viewer | tears down the peer; **keeps capturing** and keeps the socket, waiting for the next `start_desktop` | `remote_sessions` row ends as today; support session stays `ready` |
| Signalling socket lost (network blip) | keeps capturing; reconnects with the retained sender token with backoff for up to 5 min, then stops | treats the device as offline; reaper ends after `END_USER_STOP_MS` (5 min) |
| OS stops capture (user taps Stop, Android screen lock on 15 QPR1+, extension killed) | sends `share_stopped` if the socket is up, then wipes token, code and server | ends the support session immediately with `end_user`; wipes `sender_token_hash` |
| Technician End, reaper, revocation | receives `stop_desktop` + socket close; stops capture; wipes everything | existing `endSupportSession` path via the dispatcher (6.6) |

"Holds nothing" (section 3) applies once the support session has ended, not during a reconnect window. On Android a stopped projection cannot be resumed without a new consent dialog, so a resumed share after an OS stop is a new session with a new code.

### 6.2 Data model changes (all columns, no new table)

| Change | Classification |
|---|---|
| `os_type` enum gains `ios`, `android` | enum only; a repo-wide sweep of `osType` switches is a W1 task (see Risks) |
| `support_sessions.client_kind` `text NOT NULL DEFAULT 'agent'` (`agent | mobile`) | `support_sessions` is in `CORE_ORG_CASCADE_DELETE_ORDER`, so the column is classified in `CORE_TENANT_EXPORT_POLICY`: `included` |
| `support_sessions.sender_token_hash` `text NULL` (SHA-256) | `excludedSensitive`, same as `code_hash` |
| `devices` row for the phone, created at **first sender-socket connect** `[C9]`: `is_ephemeral = true`, `os_type = ios|android`, `agent_id = 'mob-<uuid>'` (NOT NULL and unique; it is the relay key, section 6.6), `hostname` = model string, lease/fence protocol-version columns set to the current values because the sender implements both (6.4) | existing columns; the hidden org keeps it out of lists, billing and policy as today |

No new table, so no new RLS, cascade, merge or export registration. `remote_sessions.device_id` stays NOT NULL. Migration is a `-a-` (enum) / `-b-` (columns) pair for the 55P04 reason noted in the Quick Support spec, named after the newest shipped migration, with `set_config('breeze.scope','system',true)` if it writes rows.

**Rejected alternative:** a separate agentless session (nullable `remote_sessions.device_id` or a new `mobile_share_sessions` table). It would re-implement concurrency caps, viewer exchange, audit and reaper, and it is exactly the "parallel signaling path" the 2026-07-06 spec rejected.

### 6.3 Sender authentication (new)

`POST /support/redeem` with `osType: 'ios' | 'android'` and `clientKind: 'mobile'` does **not** mint an enrollment key. Inside the same atomic claim it generates a 256-bit random **sender token**, stores its SHA-256 on `support_sessions.sender_token_hash`, sets `client_kind = 'mobile'`, and returns `{ sessionId, hardExpiresAt, senderToken, partnerName }`. No `senderWsUrl` is returned: the app derives `wss://<selected server>/api/v1/support/sender/ws` from the server it already validated, so a response cannot redirect signalling elsewhere `[C7]`. The token is single-session, expires at `hard_expires_at`, and is wiped (`NULL`) by `endSupportSession`.

Same rate limits (`REDEEM_LIMIT` 10/min per IP), same miss budget, same `installer_distribute` trust check with route tag `'mobile-redemption'`, same `support_session_claimed` audit with `details.clientKind = 'mobile'`, `platform`, `osVersion`, `model`. `device_id` stays NULL until the socket connects, so the unchanged 20-min limbo clause (`quickSupportReaper.ts:76-90`) expires a claim whose user cancelled the OS consent dialog or whose app crashed `[C9]`.

### 6.4 Sender channel (new): `GET /support/sender/ws` `[C2][C3][C4][C5]`

Mounted on the public support surface next to `/check`, `/redeem`, `/download`; **outside** `/remote` so no JWT middleware applies. Upgrade requires `Authorization: Bearer <senderToken>`; the server hashes it, loads the session under `withSystemDbAccessContext`, and refuses unless `status in (claimed, ready)` and `hard_expires_at > now`. On first connect it creates the device row (6.2) and sets `ready`. One socket per session: a second connection replaces the first and the first is closed with a fenced reason so a stale socket cannot answer a newer generation. Upgrade attempts are limited to 10/min per IP.

Messages carry the **complete agent command envelope**, unchanged, so the API's intake code is extracted once and shared, not forked (the answer intake at `agentWs.ts:3666-3708` is inline today; W1 extracts it into `services/desktopAnswerIntake.ts` used by both sockets):

| Direction | Message | Notes |
|---|---|---|
| server -> sender | `{id:'desk-start-<remoteSessionId>-<uuid>', type:'start_desktop', payload}` | the same envelope and payload built at `sessions.ts:1156-1173`. `payload.sessionId` is the **`remote_sessions` id**, never the support-session id. `clipboard` is always `false`. `prompt` is **present** with `mode:'consent'`, `consentUnavailableBehavior:'block'` and the partner display string, binding the start to consent mode |
| server -> sender | `{id, type:'stop_desktop', payload:{sessionId, terminalGeneration}}` | same as `buildStopDesktopCommand`; the sender records the terminal generation and ignores any later `start_desktop` with `startGeneration <= terminalGeneration` (the start fence), and acks with a `command_result` so teardown reconciliation sees it |
| sender -> server | `{type:'command_result', commandId:<the issued id>, status:'completed', result:{event:'answer', sessionId, answer, consentReason:'user', consentOutcome:'granted'}}` | the shape `agentWs.ts:4529-4540` validates; `commandId` must be the issued `desk-start-*` id; the marker is the existing version-2 `user`/`granted` pair, so the existing `session_consent_granted` audit fires and an answer without it cannot activate a consent-mode start |
| sender -> server | `result.event = 'consent_denied' | 'session_started' | 'peer_disconnected' | 'share_stopped'` | `share_stopped` is new (6.1) |
| sender -> server | `{type:'revocation_lease_renew', sessionId, leaseId}` every 25 s | same handler as `agentWs.ts:3219-3262`; server replies `revocation_lease` or `revocation_lease_revoked`; the sender stops capture when the lease (60 s) is not renewed in time or is revoked, exactly as `session_webrtc.go:150-163` |
| both | `{type:'ping'}` / `{type:'pong'}` | 30 s; bumps the device row's `last_seen` so the reaper's offline logic is unchanged |

Offer delivery branch: where `sessions.ts:1019` and `desktopWs.ts:1931` require `device.agentId` and call `sendCommandToAgent`, a device with `is_ephemeral && os_type in (ios, android)` is delivered through the dispatcher in 6.6. `isDesktopStartCapable` is satisfied because the ephemeral row carries the current protocol versions **and the sender implements lease renewal and the generation fence**; the W1 Node test sender proves both (section 11) before the versions are written. ICE is non-trickle on both sides as today; the sender answers after gathering completes or 2 s.

### 6.5 Idle timeout for a view-only sender `[C10]`

The agent treats viewer input as activity, which never happens here. The sender does not run an input-idle watchdog. Instead `idleTimeoutMinutes` means **viewer absence**: if no viewer peer has been connected for that many minutes while capture is running, the sender stops and sends `share_stopped`. While a viewer is connected and video is flowing the session is active. The lab checklist includes a 30-minute uninterrupted view.

### 6.6 End, revocation and reaping go through one dispatcher `[C6]`

`quickSupportEnd.ts:61` sends `support_end` to `device.agentId`, `remoteSessionTeardown.ts:164` sends `stop_desktop` through `dispatchCommandToAgent`, and the reaper and revocation paths use the same relay. The sender socket **registers under its `mob-<uuid>` agent id in the same socket registry the relay delivers to**, so every existing start/stop/`support_end`/revocation path reaches it unchanged across API instances. A `support_end` on the sender socket means: stop capture, wipe, close. No path is special-cased by client kind except offer delivery and the device-row creation.

### 6.7 What the phone must speak, and what the technician sees `[C11]`

- Receive a raw-SDP offer with one `recvonly` video m-line and the `input`, `control` (and possibly `input-r`) data channels. Ignore all data channels; never open `cursor` or `clipboard`.
- Answer with one `sendonly` H264 track. `react-native-webrtc` exposes the platform hardware H264 encoder on both OSes (to confirm in W2/W3: Main 3.1 / `packetization-mode=1` is negotiated; the agent uses the same fmtp, so the viewer already decodes it).
- Honour `stop_desktop` with the generation fence, lease renewal, `maxSessionDurationHours`, the viewer-absence timeout, and socket closure.
- Cannot: inject input, transfer files, show the helper pill, run a terminal, survive the user ending the broadcast, or capture DRM-protected surfaces (black on both OSes).

Viewer: `connect/exchange` already returns `osType`; for `ios`/`android` the viewer hides the input toolbar, never sends on `input`/`control`, suppresses clipboard UI, shows "View only", and **disables the JPEG-over-WebSocket fallback** with an actionable "could not connect; ask the person to stop and start sharing again" error. Server side, `desktop_stream_start` is refused for mobile devices with a clear error code so no code path can reach it.

## 7. App architecture

### 7.1 Monorepo layout

```
apps/mobile            technician app (unchanged)
apps/mobile-support    NEW customer app: Expo, CNG, no account
packages/mobile-core   NEW: serverConfig (presets + URL validation), api client base, theme tokens,
                       Sentry/PostHog bootstrap, i18n loader, config plugins shared by both apps
```

`packages/mobile-core` is extracted from `apps/mobile/src/services/serverConfig.ts`, `services/api.ts` base and `theme/`, with the technician app switched to import it in the same PR (W2) so there is one copy. The extracted validator gains a `requireTls` option; the support app requires `https:` (and therefore `wss:`) in release builds, with `http:` allowed only in dev builds `[C7]`. The support app shares **no** auth, push, attestation or screens.

### 7.2 Native modules

| Platform | Mechanism | Where it lives |
|---|---|---|
| iOS (up to iOS 26) | ReplayKit **Broadcast Upload Extension** (`BreezeSupportBroadcast`) in an App Group with the app. The extension owns its own WebRTC peer and the sender WebSocket (7.3). Main app hands `{server, senderToken, remote/support session ids}` to the extension via the App Group keychain access group before showing `RPSystemBroadcastPickerView`. | `apps/mobile-support/modules/breeze-screen-share/ios` (Expo module) + an Expo config plugin that adds the extension target, App Group entitlement and `NSExtension` plist |
| iOS 27+ `[C1]` | Codex reports that Apple documents ScreenCaptureKit for iOS/iPadOS 27 with background capture from the app process and deprecates `RPBroadcastSampleHandler`. **Not verified by the author.** W3 opens with a spike on both paths; if ScreenCaptureKit holds, the extension stays as the path for the supported floor (decision 10) and the 27+ path runs in-process. | same module, platform-conditional |
| Android | `MediaProjection` from a **foreground service** declared `android:foregroundServiceType="mediaProjection"` with `FOREGROUND_SERVICE_MEDIA_PROJECTION`; `startForeground()` before `getMediaProjection()`; the service owns the peer and socket so sharing survives backgrounding. | `modules/breeze-screen-share/android` (Expo module) + config plugin for the manifest entries |
| Both | `react-native-webrtc` via `@config-plugins/react-native-webrtc`; `expo-dev-client` for local runs (Expo Go cannot host either native piece) | `apps/mobile-support` |

**iOS facts.** On the extension path the main app cannot capture the system screen; only the extension can, and only after the user taps Start Broadcast in the system picker (we present the picker, we cannot press it). The extension runs in its own process with a memory ceiling widely reported as ~50 MB (not documented by Apple), is killed silently when it exceeds it, and cannot inject input. The user ends it from the red status indicator or the picker. Our app being suspended does not stop the broadcast.

**Android facts.** Consent is per session (the `MediaProjection` token cannot be reused); Android 14 adds the single-app / entire-screen chooser and kills the projection if the foreground service stops; Android 15 blocks capture of apps that opt out and of the keyboard by default; Android 15 QPR1+ stops the projection on screen lock `[C8]`. The exact behaviour of single-app mode when the user switches apps mid-share needs a lab check in W2.

### 7.3 iOS: why the peer lives in the extension (extension path)

Two patterns exist: (a) the extension forwards `CMSampleBuffer`s to the main app over an App Group Unix socket and the main app runs WebRTC; (b) the extension runs the WebRTC peer itself. (a) fails this product: the point is that the user leaves our app to show the broken one, and an app with no audio/VoIP background mode is suspended within seconds, dropping the stream. Keeping it alive with a silent audio session is an App Review rejection risk. (b) is the pattern commercial support SDKs use (believed: Twilio, Agora, Jitsi have variants). Cost: the signalling client (WebSocket + JSON + token + lease renewal) is duplicated in Swift inside the extension, encoding must stay within the memory ceiling (default 720p / 15 fps, raise after measurement), and session state reaches the main app only through App Group `UserDefaults` for display. **W3 starts with a spike that measures extension memory at 720p and 1080p before any UI work.**

### 7.4 Build, sign, release

Same pipeline as the technician app, second app record: CNG with `expo prebuild`, iOS archive from the local Xcode project or Xcode Cloud (same post-clone hook), Android AAB via Gradle with Play App Signing and a second upload key. New Apple bundle id and App Group id, new Play package (`com.breeze.support`, decision 5), no Firebase project (no push). `EXPO_PUBLIC_API_URL` gate reused as the default hosted region, not "the server".

### 7.5 Store listings and review

- **Apple:** screen-sharing support apps are an established category (TeamViewer QuickSupport, GoToAssist, Zoom). Expect review to require a clear purpose string, demo instructions that work during review, and that the app does nothing without a code. The 15-min code TTL is a review hazard: `APP_REVIEW_NOTES.md` carries live-code instructions and a reviewer-tenant code-minting link that a LanternOps staff member watches during review windows. Uncertain: whether Apple asks for the broadcast extension's purpose separately.
- **Google:** declare the foreground service type in the Play Console "Foreground service" declaration (required for `mediaProjection` since target SDK 34) and complete the Data Safety form (screen content is transmitted, not collected). Uncertain: whether Play's remote-access policy requires an additional declaration beyond that; check before W4.

### 7.6 Audit and provenance

Unchanged trail, same `audit_logs` rows via `logSessionAudit`:

- `support_session_created` (`supportSessions.ts:120`): unchanged; the creator is the technician.
- `support_session_claimed` (`supportPublic.ts:575`): details gain `clientKind: 'mobile'`, `platform`, `osVersion`, `model`, plus the already-recorded IP.
- `session_initiated` / `session_offer_submitted` / `session_ended` (`sessions.ts:377,1114,1483`): produced by the unchanged viewer path.
- `session_consent_granted`: fired by the shared answer intake from the real consent marker (6.4), with the device id as actor as `agentWs.ts:3729` does; it is bound to the `startGeneration` it answers.
- New `support_session_share_stopped` when the end user stops from the phone.

Recording: none, as today. If #3068 lands it will consume `remote_sessions` and pick this session up automatically.

## 8. Hosted vs self-hosted: how the app finds the server `[C12][C13][C14]`

The store app is built once by LanternOps. Self-hosters cannot publish it, and iOS Associated Domains are fixed at build time (`app.config.js`), so universal links to a self-hosted `/quick?code=` can never open the store app.

Options considered:

- **A. Region/server encoded in the displayed code.** Rejected: the 9-digit code has no spare entropy, and lengthening it hurts the phone-call use case.
- **B. Probe every hosted region with `/check`.** Rejected: codes are unique per database only, so the same live code can exist in US and EU and "first valid wins" could hand a screen to the wrong partner; and every healthy join would burn a miss in the other region against the deployment-wide backstop.
- **C. Explicit region picker in the app** (United States / Europe / Other server...), remembered on the device as a convenience, named by the technician in the copy line. No probing, no ambiguity.
- **D. HTTPS landing link as the QR payload.** The technician's existing `/quick?code=` link, as a QR. On a phone the `/quick` page stops saying "go to a Windows PC" and becomes the handoff: store badges plus an **Open in Breeze Support** button whose target is `breezesupport://join?server=<this host>&code=<code>`. On a desktop the page is unchanged. A self-hosted `/quick` page therefore hands its own host to the app with no typing.
- **E. Manual server entry** under "Other server...", TLS required in release builds.

**Decision: C + D + E.** The spoken code alone works once the user has picked the region the technician named; the QR/link works for everyone including self-host; the manual field is the fallback. A self-hoster whose user only has the spoken code must also be told the server address, as for the technician app today.

## 9. Tenancy and security

### 9.1 Scoping

Partner-scoped by construction: the code resolves to a `support_sessions` row in the partner's hidden org; the phone's device row lives in that org; `remote_sessions` inherits it. No `partner_id` column is added, so Partner-Wide First does not apply (nothing here is a config table). Org merge, cascade and export already cover `support_sessions` and `devices`.

### 9.2 Who may issue a code to a phone

Exactly who may issue one today. Creation is gated by `remote_control` (`remoteSessionCreate.ts:105`), which the probation design denies for probation and restricted partners (`2026-09-02-partner-trust-probation-design.md:110`). Redemption is gated by `installer_distribute` (`supportPublic.ts:516`), also denied under probation (`:112`). Under `PARTNER_TRUST_MODE=enforce` a probation partner cannot get a phone to share; under `shadow` the denial is logged. Noted discrepancy, out of scope here: the probation spec (`:122`) says creation should also require `installer_distribute`; the code checks it only at the public routes.

Caller verification (`2026-09-18-caller-verification-design.md`, behind `CALLER_VERIFICATION_ENABLED`) does not gate support sessions; it is a technician-side anti-vishing check for M365 identity actions. It is not added as a gate here, but the consent screen is its mirror image: the **end user** verifies the **technician's** organisation before sharing.

### 9.3 Consent screen content (fixed, not partner-editable beyond branding)

1. Partner logo and name from `/check` branding: "**<Partner>** wants to see your screen." Breeze appears only in the footer ("Powered by Breeze"). If branding is absent the screen says "A support technician" and shows no logo; it never says "Breeze wants".
2. "They will see everything on your screen, including notifications and messages, until you stop. They **cannot** touch, type, open apps, or copy files."
3. "If you were not expecting this, do not share. Close this app and contact the support people you normally deal with." (same copy as `quick.json:80`).
4. Share my screen / Cancel. Then the OS consent dialog, which we cannot and do not bypass. Tapping Share is what produces the consent marker in 6.4; Cancel sends nothing and the claim expires through the limbo clause.

While sharing: "Sharing with <Partner> since 14:02 · Stop" and the OS indicator.

### 9.4 Rate limits, entropy, replay

- Codes: unchanged (~27 bits, 15 min, single-use, `CHECK_LIMIT` 30/min, `REDEEM_LIMIT` 10/min, miss budget). The phone adds no new guessing surface: `/check` and `/redeem` are the same endpoints, and the region picker means a join costs no misses.
- Sender token: 256-bit, hashed at rest, bound to one session, expires at `hard_expires_at`, wiped on end; a redeemed code cannot be redeemed again, so a second phone cannot join. Socket upgrade 10/min per IP; one live socket per session, fenced replacement.
- Transport: `https`/`wss` only in release builds; the socket origin is derived from the validated server, never from a response.
- Replay of a captured `start_desktop` payload is useless without the viewer's live offer; an answer is accepted only once per `startGeneration` and only with the issued `commandId`.
- After the session ends the app stores nothing (no token, no code, no session), so a lost phone holds nothing. The region choice is the only persisted value.

## 10. Settings

None. Home/level/resolver: n/a. Places this concept is configured before: 0; after: 0. The hidden org's `remote_access` consent policy is not consulted for mobile senders: the server always binds the start to `mode:'consent'`, which is stricter than any policy value (decision 6).

## 11. Testing

- **API route tests:** redeem with `osType ios/android` returns a sender token and no enrollment key, leaves `device_id` NULL; redeem is refused under probation `enforce`; sender WS refuses a bad/expired/ended token, creates the device row on first connect, and a second socket evicts the first with a fenced close; offer delivery routes to the sender socket for ephemeral mobile devices and still to the agent otherwise; an answer with the wrong `commandId` or without the consent marker does not activate; lease not renewed for 60 s revokes; `stop_desktop` carries `terminalGeneration` and a later lower-generation start is ignored by the test sender; `share_stopped` ends with `end_user`; `desktop_stream_start` is refused for mobile devices; audit details carry `clientKind`.
- **Node test sender** (`apps/api/src/test/fixtures/mobileSender.ts`): a headless implementation of 6.4 (envelope, lease renewal, fence, consent marker) used by the route tests and by a wt-stack end-to-end run against the real viewer; it is the executable definition of the contract the apps must meet.
- **Contract suites (Integration Tests job):** export-policy classification of the two new columns; `osType` enum change does not break `rls-coverage` or cascade; reaper expires a mobile claim at 20 min and purges a mobile ephemeral device at 6 h.
- **Shared validators:** `redeemSupportSessionSchema` accepts the new `osType` values and `clientKind`.
- **Viewer:** with `osType: 'ios'` the input/clipboard UI is hidden, no `input` bytes are sent, and the JPEG fallback is not attempted (unit tests on the transport and `DesktopViewer`).
- **Web:** QR renders the HTTPS landing link; `/quick` on a mobile UA shows the handoff; locale parity for the new keys in all seven locales.
- **Mobile (Vitest):** code normalisation, join-URL parsing, TLS-required server validation from `packages/mobile-core`.
- **Lab (manual, recorded in the wave issue):** iPhone + iPad on the supported floor and latest iOS, Pixel + Samsung on 14 and 15; extension memory at 720p/1080p; cellular-to-Wi-Fi handover with the 5-min reconnect; user kills the app mid-share; screen lock on Android 15; technician End; 30-min uninterrupted view; 8-h cap.

## 12. Rollout in waves

| Wave | Scope | Gate to start | Gate to finish |
|---|---|---|---|
| W0 | This spec | — | Maintainer approves decisions in section 13 |
| W1 | Server + web + viewer: enum + columns migration, redeem mobile branch, sender WS, shared answer intake, dispatcher registration, offer/answer branching, viewer view-only mode (no fallback), `/quick` mobile handoff, QR + copy line, audit details, Node test sender | W0 | Route + contract tests green; the Node test sender completes offer/answer, lease renewal, fence and End against the real viewer in a wt-stack |
| W2 | `packages/mobile-core` extraction + `apps/mobile-support` scaffold + **Android** share | W1 merged | Lab checklist on Pixel + Samsung; internal-track Play build installed by the reporter's team |
| W3 | **iOS**: capture-path spike (extension vs ScreenCaptureKit 27+), then the broadcast extension | W2 app scaffold; memory spike passed | Lab checklist on iPhone + iPad; TestFlight external build |
| W4 | Store release: listings, review notes, reviewer code path, Data Safety / foreground-service declarations, docs page, Discord announcement | W2 + W3 | Both stores approved; hosted docs updated; self-host docs describe the QR/handoff and manual server entry |

Android first because its capture model has no memory ceiling or extension process, so the shared RN code gets proven before the iOS-specific work.

## 13. Open decisions for maintainer approval

1. **Reuse ephemeral `devices` + extend `os_type`** (6.2) vs a nullable `remote_sessions.device_id`. Recommend: reuse; it is the shape Quick Support already chose, and the enum sweep is bounded.
2. **Sender channel = separate public WebSocket carrying the unchanged agent command envelope, registered in the relay under its agent id** (6.4, 6.6) vs teaching the phone the real agent WS protocol (auth, heartbeat, mTLS). Recommend: separate socket; the agent protocol carries far more than a phone should ever hold, and the envelope reuse keeps intake and teardown shared.
3. **iOS peer in the extension** (7.3) vs socket-forward to the main app. Recommend: extension, gated on the W3 memory spike.
4. **Server discovery = region picker + HTTPS landing link/QR with in-page handoff + manual server entry** (section 8). Recommend: yes.
5. **App name and ids.** "Breeze Support", `com.breeze.support` on both stores, App Group `group.com.breeze.support`. Recommend: as stated; the technician app keeps `com.breeze.rmm`.
6. **Server always binds mobile starts to consent mode; the in-app Share tap is the consent evidence** (6.4, 10). Recommend: yes; stricter than any policy value and it keeps the existing consent audit.
7. **Persistent phone row in the device list** (the issue's "device row" ask). Recommend: no in this spec; it is managed-device enrollment and conflicts with "no account, holds nothing". Track as a follow-up tied to #8794 (ABM) if still wanted after W4.
8. **Default capture ceiling** 720p / 15 fps on both platforms, raised per platform after lab measurement. Recommend: yes.
9. **Wave order Android before iOS.** Recommend: yes, for the reason in section 12.
10. **Supported OS floor.** iOS 17+ / Android 14+ (targets the current foreground-service and projection rules; avoids two generations of MediaProjection behaviour). Recommend: yes; revisit the iOS floor after the W3 ScreenCaptureKit spike.

## 14. Risks

- **`os_type` enum sweep.** Every `switch (device.osType)` and every `windows | macos | linux` Zod enum in `apps/api`, `apps/web`, `apps/viewer`, `packages/shared` must tolerate two new values. The hidden org keeps mobile rows out of lists, but exhaustiveness checks and the viewer exchange typing will still break at compile time; W1 carries the sweep with a grep list in the PR.
- **Two native signalling clients.** Lease renewal and the fence must be implemented in Swift (extension) and Kotlin (service), not only in RN; the Node test sender is the contract, and the lab checklist proves each native client against it.
- **iOS capture-path churn.** If the ScreenCaptureKit report holds, two iOS capture paths coexist for several OS generations. Mitigation: the spike decides before UI work, and the floor decision (10) bounds it.
- **iOS extension memory.** Exceeding the ceiling kills the broadcast silently; the stream just stops. Mitigation: spike first, conservative defaults, telemetry on extension termination reason.
- **Store review latency and rejection.** Each store cycle is days; a rejected review on W4 blocks the release but not the server code, which ships inert.
- **Abuse optics.** A store app that shares a phone screen to a stranger is the scam shape. Mitigations are the existing trust gates, partner-named consent bound into the session start, no "control", audit with IP and model, and the fact that the code can only be minted by an MFA'd, trusted-state partner user. Reviewed with the abuse-sweep process before W4 goes public.
- **Self-host usability.** Without the QR/handoff the self-host path needs a typed server address; documented, not solved.
- **Version skew.** The app ships against the sender-channel contract; a self-hosted server older than W1 returns the old `/redeem` shape. The app detects a missing `senderToken` and shows "This server does not support phone sharing yet (needs Breeze vX)".
