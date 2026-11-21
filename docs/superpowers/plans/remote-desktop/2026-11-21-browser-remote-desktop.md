---
spec_issue: LanternOps/breeze#9557
spec: docs/superpowers/specs/remote-desktop/2026-11-11-browser-remote-desktop-design.md
spec_pr: LanternOps/breeze#11749
refs: [LanternOps/breeze#12329, LanternOps/breeze#12330, LanternOps/breeze#12343]
base: origin/main @ e8ba47ef00
status: awaiting Gate B
date: 2026-11-21
---

# In-browser remote desktop: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each wave (and each W5 PR) is one PR off a fresh `origin/main`. Read the spec section named in each wave before you start it.

**Goal:** A technician on Linux, in a Chromium-based browser, clicks Connect Desktop on a Windows device and gets a working session (picture, input, clipboard) in a dashboard tab. Nothing is installed, no new sign-in path is added, and a browser that cannot show the stream says so instead of showing a blank picture.

**Architecture:** The viewer's Tauri-free code moves into a source-exported workspace package, `@breeze/remote-desktop-ui` (W1). `DesktopViewer` stops calling Tauri and calls a host interface instead (W2a), then moves into the package (W2b). The dashboard gets a thin Astro page, `/remote/desktop/[deviceId]`, whose island composes a browser host with the shared component. That page runs its own launch transaction (create, mint, exchange) on an explicit Connect click (W5). A runtime flag served by `GET /api/v1/config` keeps every entry point and the page's start behaviour dark until the lab leg passes (W6), and W7 removes it. The API records the origin seen at exchange time as an informational `exchangeOrigin` claim (W4). An audio fix (W3) is applied only if a check on the shipped native viewer confirms audio is broken.

**Tech stack:** Astro + React 19 islands, Tailwind 4, zustand 5, Hono, `jose` JWTs, WebRTC (pion on the agent), Tauri 2 (native viewer), Vitest (jsdom), Playwright (`data-testid`), Go `testing`.

**Spec:** `docs/superpowers/specs/remote-desktop/2026-11-11-browser-remote-desktop-design.md` (PR #11749, head `e47dbb0b91`, Gate A approved 2026-11-21 with D1 (a), D2 (a), D3 (a), D4 (b), D5 (a), D6 (b), D7 (a), plus the approval notes at the top of §16). The path resolves on `main` only once #11749 has merged. This plan cites the spec by section number.

**Evidence labels:** *verified* means read in code at `e8ba47ef00`. *Inferred* means reasoned but not run. *Not checked* marks an open fact that a task or a gate must settle.

## Waves

| Wave | Scope | Owner | PRs | Depends on | Ships alone as | Release consequence |
|---|---|---|---|---|---|---|
| **W1** | Create `packages/remote-desktop-ui` and move the Tauri-free viewer libraries and their tests into it. CI job, no-Tauri guard, `parseDeepLink` kept out of the package | contributor (#12329) | 1 | #11749 merged | Moves only. The package job runs. | Binary-affecting (`apps/viewer/**`, new `packages/remote-desktop-ui/**`): full release only |
| **W2a** | Host interface. `DesktopViewer` calls the host, not Tauri. Tauri host implemented. | in-house | 1 (L) | W1 | No `@tauri-apps` in `DesktopViewer.tsx`; native viewer unchanged | Binary-affecting |
| **W2b** | Move `DesktopViewer`, `ViewerToolbar` and the components they render into the package, with tests and a fake-host contract test | in-house | 1 (M, mostly moves) | W2a | Moves only | Binary-affecting |
| **W2c** | Externalize in-session strings to an English catalog the host can replace | in-house | 1 (M) | W2b | Rendered strings unchanged | Binary-affecting |
| **W3** | Audio. Confirm on the shipped native viewer first; fix the offer and the track handler only if the check says it is broken. | in-house | 0 or 1 (S) | W1 (fix only) | Audio plays on the native viewers, or the wave closes as "works today" | Binary-affecting if a fix ships (viewer + agent test) |
| **W4** | `exchangeOrigin` claim at all three JWT sites, written to `session_offer_submitted`; `Cache-Control: no-store` on the code and exchange responses | contributor (#12330) | 1 (S) | none | API only. A native start records `viewer`. | Server-only |
| **W5** | Runtime flag; shared-component hooks; browser host, preflight, watchdog and lifecycle; page; entry points | in-house | 5 (W5a–W5e) | W2b, W4 | Dark behind the flag until W7 | W5b binary-affecting; W5a, W5c, W5d and W5e server-only |
| **W6** | Lab leg, no code; results on #9557 | in-house, plus the contributor as one test site | 0 | W5 (W3 for the audio row) | Exit criteria pass | none |
| **W7** | Remove the flag; docs; release note | in-house | 1 (S) | W6 | Feature on everywhere | Server-only |
| **W8** (optional) | Translate in-session strings into the 8 locales (D3 (a): after W7) | in-house | 1 (M) | W2c | Locale parity covers the new namespace | Binary-affecting |

W4 can land first. W2c and W3 are independent of W5: with D3 (a) the browser runs the English catalog, which is the package default. The critical path is W1 → W2a → W2b → W5b → W5c → W5d → W5e → W6 → W7.

## Spec citations that drifted

The drift check ran against `e8ba47ef00`. Of 133 `path:line` citations, 68 are unchanged, 63 moved with the same code, and 2 point at code that changed. No file is missing.

**Changed, or new facts that matter to this plan:**

| Spec | What changed | Effect on the plan |
|---|---|---|
| F8, §16 note | 8 of 62 viewer source files import Tauri, not 7 of 58. The 8th is `apps/viewer/src/lib/nativeSessionEnd.ts` (#12129, added after the spec). | W1 keeps it in the viewer. W2a's host gains a session-end capability. |
| F9, §5.3 | `DesktopViewer.tsx` is 3,368 lines. Since the spec it also imports `getCurrentWebviewWindow` (`:3`), listens for `session-window-closing` (`:2971`), and arms and disarms a native session end (`createNativeSessionEnd` `:287`; `.track` at `:730`, `:755`, `:1241`, `:1277`, `:1332`; `.disarm` `:3048`). | Two host capabilities that §5.3's table does not list: `sessionEnd` and `onCloseRequested` (W2a). |
| §6.3, §6.4 | There is now a viewer-token hang-up route, `POST /desktop-ws/:id/viewer/end` (`desktopWs.ts:1961`, #11931). The viewer calls it through `endDesktopSession` (`apps/viewer/src/lib/api.ts:120`, 2 s timeout). | "End the session with the API using the viewer token" now has a real endpoint. Used by W5b teardown. See open question Q1. |
| F1 | `handlers_desktop.go:341`: a Linux Wayland seat session can also go to a per-session helper (#12117). | None for Windows targets. |
| §5.7 | `remoteWsAuthorization.ts:404-428`: tunnels re-prove partner trust on every authorization; desktop is unchanged. | None. |
| §10 | No blocking CI job runs arbitrary Playwright specs. `portal-dev-e2e` runs a fixed list and is non-blocking (`ci.yml:5109`). | The E2E spec in W5d is run by hand through `pnpm wt-stack test`; its output goes in the PR. |
| §5.1 | `detectOS` in `apps/web/src/lib/viewerDownload.ts:45` is module-private. It also returns `linux` for Android and ChromeOS (`navigator.platform` fallback). | W5e exports it. Android and ChromeOS get the browser default, which is acceptable because no native viewer serves them. |

**Moved (same code, new lines) — use these when building:**

| Spec citation | Now |
|---|---|
| `handlers_desktop.go:711-715` | `agent/internal/heartbeat/handlers_desktop.go:729-733` |
| `session_webrtc.go:174-181`, `:213-225`, `:494-512`, `:636-688`, `:678-688`, `:745-754` | `agent/internal/remote/desktop/session_webrtc.go:192-199`, `:231-243`, `:524-542`, `:666-718`, `:708-718`, `:775-784` |
| `sessions.ts:854-899` (mint), `:312-355` (F12), `:383-395`, `:238-310` create checks, `:869/:877/:883` | `apps/api/src/routes/remote/sessions.ts:857-902`, `:311-354` (now sets `endReason: 'superseded'`), `:382-394`, `:237-309`, `:872/:880/:886` |
| `desktopWs.ts:1784-1851` (exchange), `:2082-2093` (offer audit), `:1963-1971`, `:2188-2224`, `:1870-1879` | `apps/api/src/routes/desktopWs.ts:1785-1852`, `:2145-2156`, `:2026-2034`, `:2251-2287`, `:1871-1880` |
| `remoteWsAuthorization.ts:423-440`; `remoteSessionCreate.ts:99-120`; `middleware/auth.ts:1140-1164`; `remoteAccessPolicy.ts:312`, `:24` | `:433-450`; `:126-147`; `:1142-1166`; `:315`, `:25` |
| `heartbeat.go:1587-1591`; `agentWs.ts:3591`, `:3880-3900` | `:1656-1660`; `:3603`, `:3902-3922` |
| `DesktopViewer.tsx:169`, `:666-720`, `:770-777`, `:879`, `:1020-1027`, `:1250`, `:1258-1276`, `:1349-1380`, `:1842-1850`, `:2192-2210`, `:2200`, `:2766`, `:2852` | `:175`, `:703-757`, `:807-815`, `:921`, `:1103-1110`, `:1338`, `:1346-1364`, `:1437-1468`, `:1934-1942`, `:2303-2321`, `:2311`, `:2877`, `:2994` |
| `clipboardSync.ts:58-64`; `RemoteTerminal.tsx:20`, `:337` | `:73-79`; `:22`, `:339` |
| `ConnectDesktopButton.tsx:1275`, `:713-719` | `:1278`, `:717-723` (the others still hold: `:30`, `:489-492`, `:494-502`, `:550-572`, `:636-637`) |
| `ci.yml:1554-1585` (`test-document-ui`), `:1477` (viewer tests) | `.github/workflows/ci.yml:1610-1641`, `:1533` |
| `Caddyfile.prod:480`; `tenantExportPolicyRegistry.ts:839` | `docker/Caddyfile.prod:498`; `:866` |
| `remote-access.mdx:671-673`; `binaries.mdx:223` | `apps/docs/src/content/docs/features/remote-access.mdx:715-717`; `apps/docs/src/content/docs/deploy/binaries.mdx:349` |

## Global constraints

- **No new auth path.** The tab calls the same create, mint and exchange endpoints the native viewer uses (§5.7). No viewer route accepts the dashboard token. No route gains a browser-only branch.
- **The connect code and the viewer token never appear in a URL, browser history, a `Referer`, a log, `postMessage`, `localStorage`, `sessionStorage`, a cookie or a telemetry payload** (§4, §6.1.6). Only the session id and the signed-in user id may go in `sessionStorage`.
- **The exchange request never retries.** Use the bare `exchangeDesktopConnectCode` from the package, or `fetchWithAuth` with `skipUnauthorizedRetry: true` (`apps/web/src/stores/auth.ts:1364`, `:1553`). The exchange consumes the code before it authorizes.
- **Nothing starts on page load** (D6 (b)). A session is created only by a Connect click in the tab.
- **Remote input stays disabled until the first frame is presented**, and is disabled again on a terminal watchdog failure (§5.8). This applies to the browser host only. The native viewer is unchanged.
- **The browser host allows WebRTC only** (§5.4). No WebSocket fallback and no in-session VNC switch.
- **`exchangeOrigin` is informational.** It never feeds an authorization decision (§5.5, D7 (a)).
- **No tables or columns** (D5 (a)). No migration, and no RLS, cascade, merge or export registration change. If a task finds it needs one, stop and raise it at Gate B.
- **Package rules.** No file under `packages/remote-desktop-ui/src` imports `@tauri-apps/*`, enforced by a test from W1 on. `parseDeepLink` is not importable by the web app (§16 note). The web app never imports `@breeze/remote-desktop-ui/transports/vnc`, which pulls in noVNC.
- **Placement rule for W5.** `packages/remote-desktop-ui/**` is binary-affecting once W1 adds it to `scripts/release/binary-affecting-paths.txt`. Any change there forces a full release and a native smoke. Browser-only logic (preflight, watchdog, launch transaction, browser host) therefore lives in `apps/web/src/lib/remoteDesktop/`. Only the hooks the shared component must expose go in the package (W5b).
- **Web.** Every new control has a `data-testid`. Every new string goes into all 8 locales (`en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR`), and pt-BR additions carry the machine-drafted note `apps/web/src/locales/README.md` requires. Never `t(cond ? a : b)`. Mutations go through `runAction`, except the bare exchange, which gets a `runActionAllowlist.ts` entry with its reason.
- **Settings:** none added (§7, D7 (a)). The flag is a temporary deployment flag. Places the concept is configured: 0 before, 0 after.
- **Public repo:** no customer, tenant or lab host names, IPs or regions in code, tests, docs, the plan or PR text. Write "lab Windows host".
- **PR text:** `Refs #9557` only. Never a closing keyword for #9557, even negated. Each wave PR adds `Closes #<wave sub-issue>` only after Gate B registers the sub-issues.

## Review focus

1. **A Connect double-click, a reload mid-transaction, or a sign-out during the exchange.** At most one session exists and no orphan is left behind. The late result of an aborted transaction is discarded, and the session it created is ended. Test: W5c Task 6, `aborting after create ends the created session and ignores the late mint`.
2. **The exchange answers 401 because the dashboard access token expired between mint and exchange.** The code must not be re-sent. The page reports the failure and the next Connect mints a new code. Test: W5c Task 6, `exchange 401 is terminal and never re-sent`.
3. **A browser that advertises H.264 in its offer but never decodes it** (a distro Chromium without proprietary codecs, or Firefox before its OpenH264 download finishes). The tab never takes input, and ends the session with the "isn't decoding" message. Test: W5c Task 5, `packets without decoded frames → one keyframe request, then terminal decode failure`, plus W5b Task 3, `input stays closed until markFirstFrame`.
4. **An idle remote desktop** (nothing changes on screen, so few or no frames are sent). It is never declared stalled. Test: W5c Task 5, `no packets after the first frame is idle, not a stall`.
5. **The native viewer after W2a and W2b**, on three OSes: deep link, paste-as-keystrokes, quit prompt, one window per device, and session end on window close (#12129). Pinned by `tauriHost.test.ts`, the raw-source guard, and the three-OS smoke checklist in W2a.

---

## Contributor PRs (W1, W4): how they are taken

The contributor's #12329 and #12330 were read line by line at heads `ef318998d3` and `e3b0ad937c`. Neither was run, and no CI ran on either (fork workflows never approved). Both were invited back once #11749 merges, with the changes the maintainer named on #9557 (comment of 2026-11-21). The W1 and W4 sections state acceptance criteria the PRs can meet as written, and note where each PR already meets or misses them.

Maintainer steps for each reopened PR, in this order:

1. **Hostile-intent screen** on the new head SHA, before anyone builds, installs or approves workflows for it (see `gh-queue` step 0). #12329 touches `pnpm-lock.yaml`, `.github/workflows/ci.yml`, `.github/scripts/*` and `scripts/release/*`. Read each of those hunks in full.
2. **Lockfile review (W1):** the only expected `pnpm-lock.yaml` changes are a new `packages/remote-desktop-ui` importer and `@novnc/novnc` moving from `apps/viewer` to that importer. Anything else (a new registry, a resolution change, a new transitive dependency) blocks the PR.
3. **Approve fork workflows**, then check that `CI Success` ran with `test-remote-desktop-ui` reporting (W1) or `test-api` (W4).
4. **Rebase check:** both PRs predate the `POST /:id/viewer/end` insertion and other moves listed above, so expect conflicts in `desktopWs.ts` and its tests (W4) and in viewer imports (W1).
5. The maintainer-run checks in each wave's section.

The CI and release-guard edits in #12329 stay in that PR. The package job must land with the move, or the moved tests stop running in CI (spec W1 outcome). They are reviewed as part of step 1.

---

## W1: shared package, moves only (contributor, #12329)

Spec §5.2, §12 W1, §16 notes. **Outcome:** the diff is moves and import paths. The package job runs and passes, and its test count equals the count removed from the viewer.

### Acceptance criteria

| # | Criterion | #12329 at `ef318998d3` |
|---|---|---|
| A1 | `packages/remote-desktop-ui` exists, source-exported like `packages/document-ui` (`main`/`types`/`exports` → `./src/index.ts`), `private: true` | meets |
| A2 | Every non-Tauri module in `apps/viewer/src/lib/` (incl. `transports/`) moves with its test as a 100% rename. Stays in the viewer: `App.tsx`, all components, `clipboardIO.ts`, `devicePrefs.ts`, `nativeSessionEnd.ts`, `updateActions.ts`, `updateStatus.ts`, `deepLinkGate.ts`, and tests that import component source with `?raw` | meets (89 renames; `nativeSessionEnd.ts` kept) |
| A3 | `parseDeepLink` is not importable from the package. **Preferred:** split `protocol.ts`, moving `buildWsUrl` and the connection param types to the package (`src/protocol.ts`) and keeping `parseDeepLink` in `apps/viewer/src/lib/deepLink.ts`. **Accepted alternative:** move the file whole and drop `parseDeepLink` from `src/index.ts` and `exports`. | **misses**: moved whole, re-exported from the barrel, and `App.tsx` imports it from the package |
| A4 | No-Tauri guard test in the package: `src/__tests__/noTauriImports.test.ts` reads every file under `src/` and fails on `@tauri-apps/`. A second assertion fails if `index.ts` exports `parseDeepLink`. | **misses** |
| A5 | CI job `test-remote-desktop-ui` (vitest + typecheck), copied from `test-document-ui` (`ci.yml:1610-1641`), in `ci-success` `needs`, both result branches, `ci-area-gating.test.mjs`, `ci-gate.test.mjs` count, and `queue-selection.mjs` (unit map, prefix map, and the viewer area also covering the package) | meets on reading, not run: the inventory matches `git grep test-document-ui -- .github scripts docs`, and the `ci-gate.test.mjs` count of 28 holds because `THINNABLE` derives from `JOB_CLASSES` in `queue-selection.mjs` (`ci-gate-thin.mjs:15`, `:29`), which the PR edits |
| A6 | `packages/remote-desktop-ui/**` added to `scripts/release/binary-affecting-paths.txt`, with the coverage test updated | meets |
| A7 | `@source "../../../packages/remote-desktop-ui/src";` in `apps/viewer/src/index.css` (`displayScaling.ts` builds class strings) | meets |
| A8 | noVNC stays a lazy chunk: `transports/vnc` is a subpath export, not in the barrel | meets |
| A9 | Stale path references updated: Go comments under `agent/internal/remote/desktop/` (`input_copy_chord.go:10`, `input_text.go:35`, `:48`, `input_text_test.go:196`, `session_control.go:331`), the fixture at `.github/scripts/classify-pr-paths.test.mjs:880`, `apps/api/src/routes/desktopWs_inputSchema.test.ts`, `consentTiming.ts`, and `e2e-tests/perf-harness/*` | **partly**: API, e2e and `ci-area-gating` updated; Go comments and the `classify-pr-paths` fixture not |
| A10 | Docs counts updated (`docs/agents/testing.md`, `docs/agents/merge-and-deploy.md` thinnable-job counts) | meets |

### Maintainer verification (before merge)

- [ ] **Steps 1–4 above.**
- [ ] **Scoped runs:** `cd packages/remote-desktop-ui && npx vitest run` and `pnpm --filter=@breeze/remote-desktop-ui typecheck`. Then `cd apps/viewer && npx vitest run && pnpm exec tsc --noEmit`. Record file and test counts: package + viewer after must equal viewer before (the PR body claims 44 + 23 files, 772 + 195 tests, against 67 / 967 before).
- [ ] **Guard control:** add `import '@tauri-apps/api/core'` to a scratch file under `packages/remote-desktop-ui/src/` and see `noTauriImports.test.ts` fail. Then remove it.
- [ ] **Bundle comparison** (PR CI does not build the viewer): `cd apps/viewer && pnpm build` on `main` and on the PR head. Compare the `dist/assets` file list and sizes; the main JS may differ by a few bytes, and the noVNC chunk must be unchanged. Run `cmp` on the CSS: it must be byte-identical, which proves the `@source` line.
- [ ] **Three-OS native smoke** (checklist in W2a, "Native smoke"), on a locally built viewer from the PR head (`cd apps/viewer && pnpm tauri build`, unsigned) on Windows, macOS and Linux.
- [ ] **CI jobs green:** `CI Success`, including `test-viewer`, `test-remote-desktop-ui`, `lint` (runs the `.github/scripts` tests) and `typecheck`.

**Rollback:** revert the PR. W1 changes no runtime behaviour. Because the PR is binary-affecting, a revert after release also needs a full release.

---

## W2a: host interface, Tauri host (in-house)

Spec §5.3, §12 W2a. **Outcome:** `DesktopViewer.tsx` has no `@tauri-apps` import and no `invoke(` call. The native viewer behaves exactly as before on three OSes.

### Task 1: host interface in the package, Tauri host in the viewer

**Files:**
- Create: `packages/remote-desktop-ui/src/host.ts` (+ export from `index.ts`)
- Create: `apps/viewer/src/host/tauriHost.ts` and `tauriHost.test.ts`
- Modify: `apps/viewer/src/components/DesktopViewer.tsx` (every Tauri call site in the drift table: `:2`, `:3`, `:7`, `:42`, `:101`, `:287`, `:564`, `:730`, `:755`, `:921`, `:1241`, `:1277`, `:1332`, `:1338`, `:1437-1468`, `:2311`, `:2877`, `:2971`, `:2994`, `:3048`)
- Modify: `apps/viewer/src/App.tsx` (creates the host and passes it in)
- Modify: `apps/viewer/src/lib/devicePrefs.ts` (the `PrefsStore` type moves to `host.ts`; the Tauri store stays)
- Create: `apps/viewer/src/components/DesktopViewer.noTauri.test.ts`

**Interfaces:**
- Produces, in `host.ts`:
  ```ts
  export interface RemoteDesktopHost {
    kind: 'tauri' | 'browser';
    transports: { websocketFallback: boolean; vncSwitch: boolean };
    clipboard: LocalClipboardIO;                       // clipboardSync.ts:73-79
    readPasteText(): Promise<string | null>;           // paste-as-keystrokes source (DesktopViewer.tsx:2303-2321)
    prefs: PrefsStore;
    setTitle(hostname: string): void;
    registerSession(sessionId: string): void;
    unregisterSession(): void;
    registerDevice(deviceId: string): void;
    sessionEnd: {
      track(auth: AuthenticatedConnectionParams | null): void;
      disarm(sessionId: string | null | undefined): Promise<void>;
    };
    onCloseRequested(handler: () => Promise<void>): () => void;
    saveScreenshot(bytes: Uint8Array, suggestedName: string): Promise<void>;
  }
  ```
  `DesktopViewer` props gain `host: RemoteDesktopHost`. Connection input stays as today: deep-link `ConnectionParams` exchanged inside the component. W5b adds the pre-authorized variant. This is a deliberate narrowing of §5.3's `connect` row: the browser hands the component an already exchanged credential instead of a host callback (§17 leaves the interface to the builder).
- Produces, in `tauriHost.ts`: `createTauriHost(deps?: { invoke?: Invoke; window?: () => WebviewWindowLike }): RemoteDesktopHost`, with `transports: { websocketFallback: true, vncSwitch: true }`. It wraps `createTauriClipboardIO`, the Tauri store, `createNativeSessionEnd`, `update_session_hostname`, `register_session`, `unregister_session`, `register_device`, `save_screenshot`, the `session-window-closing` listener, and the Tauri `readText` with today's `navigator.clipboard.readText()` fallback.

- [ ] **Step 1: Write the failing tests.**
  - `DesktopViewer.noTauri.test.ts`: import `./DesktopViewer.tsx?raw`; `expect(src).not.toMatch(/@tauri-apps\//)`; `expect(src).not.toMatch(/\binvoke\(/)`.
  - `tauriHost.test.ts`, with mocked `invoke` and window: `setTitle calls update_session_hostname with the hostname`; `registerSession / registerDevice / unregisterSession call their commands`; `saveScreenshot calls save_screenshot with the bytes`; `readPasteText falls back to navigator.clipboard when the plugin throws`; `sessionEnd.track arms with apiUrl, accessToken and sessionId; track(null) disarms`; `onCloseRequested subscribes to session-window-closing and the unsubscribe stops it`; `a rejected invoke is logged, never thrown`.
- [ ] **Step 2: Run them and see them fail.** `cd apps/viewer && npx vitest run src/components/DesktopViewer.noTauri.test.ts src/host/tauriHost.test.ts`
- [ ] **Step 3: Implement.** Move each Tauri call behind the host. Keep the error handling at each call site exactly as it is (log and continue).
- [ ] **Step 4: Run them and see them pass,** plus the whole viewer suite and typecheck: `cd apps/viewer && npx vitest run && pnpm exec tsc --noEmit`, and `cd packages/remote-desktop-ui && npx vitest run && pnpm exec tsc --noEmit` (the guard covers the new `host.ts`).
- [ ] **Step 5: Commit.** `refactor(viewer): DesktopViewer calls a host interface instead of Tauri (Refs #9557)`

### Native smoke (W1, W2a, W2b, W2c, W3, W5b)

Run on a viewer built from the branch head (`cd apps/viewer && pnpm tauri build`, unsigned, registered as the `breeze://` handler). If an OS refuses an unsigned deep-link handler, use a release-candidate tag. Targets: a Windows device in service mode for the Windows and macOS viewers. For the Linux viewer, which has no WebRTC, use a macOS or Linux agent over the WebSocket transport, and confirm a Windows service-mode device still shows the service-mode refusal message. Pass when every line holds:

- [ ] Connect Desktop opens exactly one viewer window (#11753). A second connect to the same device focuses or replaces the window (one window per device).
- [ ] Picture, mouse, keyboard on a non-US layout, drag-select, scroll, monitor switch, view-only.
- [ ] Paste-as-keystrokes types the local clipboard into the remote.
- [ ] Clipboard text and image both ways.
- [ ] Screenshot saves to the chosen location.
- [ ] Window title shows the hostname.
- [ ] The quit prompt appears on close with a live session. After closing, session history shows the session ended by the operator (#12129), not as a dropped connection.
- [ ] WebSocket fallback (block UDP or use a device without WebRTC) and the in-session VNC switch and back (macOS agent with VNC relay).

**W2a PR:** the body lists the smoke results per OS. CI: `test-viewer`, `test-remote-desktop-ui`, `typecheck`. **Rollback:** revert; binary-affecting, so a full release.

---

## W2b: move the component into the package (in-house)

Spec §5.2, §10 "Package (unit)", §12 W2b. **Outcome:** moves only, plus one new contract test. Native smoke on three OSes.

### Task 1: move `DesktopViewer` and the components it renders

**Files:**
- Move (100% renames, then import-path edits): `apps/viewer/src/components/{DesktopViewer,ViewerToolbar,ClipboardChip,ImeCaptureInput,KeyboardModeControl,CredentialsPromptModal}.tsx` and their tests, including the `?raw` source tests left in the viewer by W1 (for example `serviceModeRefusal.test.ts`, `DesktopViewer.reliableInput.test.ts`, `DesktopViewer.noTauri.test.ts`) → `packages/remote-desktop-ui/src/components/`
- Modify: `packages/remote-desktop-ui/package.json` (peer deps `react`, `react-dom` ^19; dependency `lucide-react` matching the viewer's version; devDeps `@testing-library/react`). Export the component from `index.ts`.
- Modify: `apps/viewer/src/App.tsx` (import from the package), `apps/viewer/package.json`
- Stay: `QuitConfirm.tsx`, `UpdateIndicator.tsx` (Tauri)
- Create: `packages/remote-desktop-ui/src/components/hostContract.test.tsx`

**Interfaces:** consumes `RemoteDesktopHost` (W2a). Produces `export { default as DesktopViewer } from './components/DesktopViewer'`.

- [ ] **Step 1: Write the failing contract test** (it fails because the component is not in the package yet). Render `DesktopViewer` with a fake host and a fake connection whose transport stubs reach `connected`: `clipboard read denied shows the clipboard chip error and keeps the session`, `prefs that throw fall back to in-memory defaults`, `navigator.keyboard missing leaves fullscreen working with no lock`, `saveScreenshot rejecting shows an error toast, session continues`.
- [ ] **Step 2: Run and see it fail.** `cd packages/remote-desktop-ui && npx vitest run src/components/hostContract.test.tsx`
- [ ] **Step 3: Move the files** (`git mv`, then fix imports only). The no-Tauri guard now covers the component.
- [ ] **Step 4: Run the package suite, the viewer suite and both typechecks;** they pass. The viewer's file and test counts drop by exactly what the package gained.
- [ ] **Step 5: Maintainer bundle comparison** as in W1 (CSS byte-identical, chunk list unchanged), then the **three-OS native smoke**.
- [ ] **Step 6: Commit.** `refactor(viewer): move DesktopViewer and its components into @breeze/remote-desktop-ui (Refs #9557)`

**Rollback:** revert; full release.

---

## W2c: externalize in-session strings (in-house)

Spec §8, D3 (a), §12 W2c. **Outcome:** the rendered strings are unchanged. Native smoke on one OS.

### Task 1: English catalog, host override

**Files:**
- Create: `packages/remote-desktop-ui/src/strings/en.ts`, `strings/types.ts`, `strings/StringsContext.tsx`
- Create: `packages/remote-desktop-ui/src/components/renderedStrings.test.tsx` (+ its committed snapshot)
- Modify: every package component with an English literal shown to the user; `host.ts` (`strings?: Partial<ViewerStrings>`)

**Interfaces:** produces `type ViewerStrings = typeof en` (a flat record of string keys to string templates with `{name}` placeholders); `formatViewerString(template: string, vars?: Record<string, string | number>): string`; `useViewerStrings(): ViewerStrings`, which merges `host.strings` over `en`.

- [ ] **Step 1: Characterization test first, on the unchanged code.** `renderedStrings.test.tsx` renders the toolbar (every menu open), the notices and chips, and the error states with fixed props, then snapshots `container.textContent` for each. Commit it green **before** any extraction. It is a characterization test, not a red one; its job is to stay green through the refactor.
- [ ] **Step 2: Write the failing override test:** `host.strings overrides one key and leaves the rest English`.
- [ ] **Step 3: Extract** literals into `en.ts` and read them through `useViewerStrings()`. Errors built by string concatenation (for example `DesktopViewer.tsx:152-165`) become templates.
- [ ] **Step 4: Run** `cd packages/remote-desktop-ui && npx vitest run`. The snapshot is unchanged and the override test passes.
- [ ] **Step 5: Native smoke on one OS** (Windows). Commit: `refactor(remote-desktop-ui): in-session strings come from a catalog the host can replace (Refs #9557)`

---

## W3: audio (in-house)

Spec §5.10, §12 W3. The spec's finding is *inferred* from code reading: the offer has no audio transceiver (`webrtc.ts:227`, verified still true), and the audio `ontrack` wrapper is installed after the answer is applied (`transports/webrtc.ts:94-111`, `webrtc.ts:447`). This wave confirms the finding before changing anything.

### Step 0: confirm on the shipped native viewer (no build, no code)

- [ ] On the current released Windows viewer and macOS viewer, connect to a **Windows device in service mode that is playing sound** (a video or a test tone in the signed-in user's session).
- [ ] **Observable:** the toolbar's audio toggle renders only when an audio track reached the viewer (`ViewerToolbar.tsx:831`, `capabilities?.audio && hasAudioTrack`). Record whether the toggle is present. If it is present, turn it on and record whether sound plays.
- [ ] Repeat on the WebSocket transport as a control: audio is WebRTC-only there, so no toggle is expected.
- [ ] Post the result on #9557 with viewer and agent versions.

**Decision tree:**

| Step 0 result | Meaning | W3 does |
|---|---|---|
| No toggle on either viewer | Finding confirmed: no audio m-line negotiated (inferred), or the track is missed | Task 1 (transceiver + early handler) |
| Toggle present, sound plays | Finding wrong: audio works today | No code. Close W3 with the evidence. W6's audio row still runs in the browser. If only the browser then lacks audio, the handler timing is the cause: do Task 1 step 3b only. |
| Toggle present, silent | m-line and track exist; capture (for example service-mode loopback through the helper) yields no samples | Out of scope. File an issue. The browser makes no audio promise, and W6's audio row is recorded, not blocking. |

### Task 1 (only if Step 0 confirms): receive-only audio transceiver and an early handler

**Files:**
- Modify: `packages/remote-desktop-ui/src/webrtc.ts` (offer: add `pc.addTransceiver('audio', { direction: 'recvonly' })` **after** the video transceiver so video keeps the first m-line; `createWebRTCSession` gains `onAudioTrack?: (track: MediaStreamTrack) => void`, called from the `pc.ontrack` set before `setLocalDescription`)
- Modify: `packages/remote-desktop-ui/src/transports/webrtc.ts:94-111` (drop the after-the-fact `ontrack` wrap; build the `Audio` element from `onAudioTrack`)
- Test: `webrtc.test.ts`, `transports/webrtc.test.ts`
- Create: `agent/internal/remote/desktop/session_webrtc_audio_test.go` (test only)

- [ ] **Step 1: Write the failing tests.**
  - `offer has a recvonly audio m-line after video`: parse the offer SDP from the mocked pc; the first `m=` is `video`, and an `m=audio` with `a=recvonly` follows.
  - `audio track delivered when ontrack fires inside setRemoteDescription`: the mock pc fires `ontrack({ track: { kind: 'audio' } })` synchronously inside `setRemoteDescription`; expect `onAudioTrack` to have been called once.
  - `video ontrack still wires the video element and jitterBufferTarget` (regression).
  - Go: `TestAnswerCarriesAudioWhenOffered` builds the agent's peer connection with the PCMU track, applies an offer with recvonly video and recvonly audio, and asserts the answer has `m=audio` with `a=sendonly` and `PCMU/8000`. Also `TestAnswerWithoutAudioOfferStillHasVideo`, the legacy offer from old viewers.
- [ ] **Step 2: Run and see them fail.** `cd packages/remote-desktop-ui && npx vitest run src/webrtc.test.ts src/transports/webrtc.test.ts` and `cd agent && go test -race ./internal/remote/desktop/ -run 'TestAnswer(CarriesAudio|WithoutAudioOffer)'` (the second Go test passes today; it is a guard).
- [ ] **Step 3: Implement.** **3b** (alone, if Step 0 found audio working natively but the browser misses it): only the early handler change.
- [ ] **Step 4: Run and see them pass.** Full package suite.
- [ ] **Step 5: Lab matrix** (every row must keep video working; audio expected only where marked):

  | Viewer | Agent | Expect |
  |---|---|---|
  | Windows, macOS | Windows service mode, current release | toggle + sound |
  | Windows, macOS | Windows service mode, previous release (N-1) | toggle + sound (the agent always adds its PCMU track) |
  | Windows, macOS | macOS agent | video works; toggle silent or absent; no error |
  | Windows, macOS | Linux agent (X11) | video works; no error |
  | Linux viewer | macOS agent (WebSocket) | unchanged (no audio on WebSocket) |

- [ ] **Step 6: Commit.** `fix(viewer): negotiate the agent's audio track and catch it during setRemoteDescription (Refs #9557)`. The release note names the native audio fix.

**Rollback:** revert. Old agents never relied on an audio m-line, so the revert restores today's offer. Full release.

---

## W4: `exchangeOrigin` and `no-store` (contributor, #12330)

Spec §5.5, §5.6, §16 "one dashboard origin". **Outcome:** API tests pass, a native start records `viewer`, and a legacy token records `unknown`.

### Acceptance criteria

| # | Criterion | #12330 at `e3b0ad937c` |
|---|---|---|
| B1 | `classifyExchangeOrigin(origin: string \| undefined): 'browser' \| 'viewer' \| 'unknown'` in `apps/api/src/services/exchangeOrigin.ts`. `browser` means an exact match with the **single** dashboard origin: `new URL(PUBLIC_APP_URL \|\| DASHBOARD_URL).origin`, and an opaque `"null"` parse is rejected. `viewer` means an exact match with `TAURI_ORIGINS` (`apps/api/src/services/corsOrigins.ts`). Anything else is `unknown`. The CORS allowlist is not consulted. | meets |
| B2 | All three JWT sites carry the claim: mint (`createViewerAccessToken`), descendant mint (copied from the parent), and verify (only `browser`/`viewer` accepted; missing or any other value → `unknown`) | meets |
| B3 | `session_offer_submitted` details carry `exchangeOrigin` next to `via` (`desktopWs.ts:2145-2156` on main) | meets |
| B4 | `Cache-Control: no-store` on every response the mint handler (`sessions.ts:857-902`) and the exchange handler (`desktopWs.ts:1785-1852`) produce, success and error. Responses produced earlier by middleware or validation hold no code or token and are out of scope. | meets |
| B5 | Tests: dashboard, each Tauri origin, missing, `null`, foreign, scheme/port/subdomain/trailing-slash near misses, `DASHBOARD_URL` fallback, a legacy token and forged values → `unknown`, descendant survival, the audit detail, `no-store` on success and error | meets, with one defect: the test titled `labels no origin "browser" when no dashboard URL is configured` asserts `unknown` and must be renamed (for example `labels a localhost origin "unknown" when no dashboard URL is configured`) |
| B6 | The new describe block in `desktopWs.test.ts` does not separate the `#8947` comment from its describe (`concurrent second offer (#8947)`) | **misses**: inserted between them |
| B7 | PR body states the origin precedence correctly: `passkeys.ts` reads `WEBAUTHN_ORIGIN` first (`apps/api/src/services/passkeys.ts:152-154`); `exchangeOrigin` deliberately uses `PUBLIC_APP_URL` then `DASHBOARD_URL`, as `config/tunnelOrigin.ts:127-128` does | **misses** (body says it matches `passkeys.ts`) |
| B8 | No new env var, table, column or migration | meets |
| B9 | The new `services/exchangeOrigin.ts` passes the services contract suites in `apps/api/src/__tests__/` (for example `parkedFanout.contract.test.ts`, which discovers only files that read `devices` or carry device-exclusion helpers) | not checked by run. By reading, the file is not discovered (it reads no tables); run `cd apps/api && npx vitest run src/__tests__/parkedFanout.contract.test.ts` to confirm |

### Maintainer verification

- [ ] Steps 1–4 of "Contributor PRs".
- [ ] `cd apps/api && npx vitest run src/services/exchangeOrigin.test.ts src/services/jwt.test.ts src/routes/desktopWs.test.ts src/routes/desktopWs_utils_http.test.ts src/routes/remote/sessions.test.ts` passes. Then `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p apps/api; echo exit=$?` (check the exit code; never pipe it to `tail`).
- [ ] **Native label check on a stack built from the PR:** start a WebRTC session from the Windows and macOS viewers. Each `session_offer_submitted` row has `exchangeOrigin: 'viewer'`. This depends on each Tauri webview sending exactly `http://tauri.localhost` (Windows) or `tauri://localhost` (macOS). The Linux viewer is **not observable through this row**: it never submits a WebRTC offer (no WebRTC, F1). If one OS records `unknown`, the PR is still correct, but file the finding before W6.
- [ ] CI: `test-api`, `typecheck`, `CI Success`.

**Rollback:** revert. Tokens without the claim already verify as `unknown`.

---

## W5: the browser session (in-house)

Spec §5.1, §5.3–§5.9, §5.11, §5.12, §6, §8, §9, §10. Five PRs, in order. Each one is mergeable alone because the flag (W5a) keeps everything after it dark.

| PR | Tasks | Paths | Separate PR? |
|---|---|---|---|
| W5a | Task 1: runtime flag | API config, env, compose, env docs, `featuresStore` | yes, can land any time |
| W5b | Tasks 2–3: shared-component hooks (input gate, media hooks, terminal failure, `isTrusted`, transport policy, pre-authorized connection, lifecycle events) | `packages/remote-desktop-ui` (**binary-affecting**) | yes. Tauri host passes nothing, so the native viewer is unchanged. Native smoke on Windows and macOS. |
| W5c | Tasks 4–7: preflight, watchdog, launch transaction, browser host | `apps/web/src/lib/remoteDesktop/` | yes, inert (no page yet) |
| W5d | Task 8: the page | `apps/web/src/pages/remote/desktop/`, island, Dockerfile, locales | yes. Reachable only by URL; flag off → disabled state. |
| W5e | Task 9: entry points; connected-session CSP check | `ConnectDesktopButton.tsx` and friends, locales | yes |

One fixer per task. Tasks 4–7 can go to parallel fixers once W5b has merged, because they share only the interfaces stated below.

### Task 1 (W5a): runtime flag via `GET /config`

D4 (b), §9. Proposed name: `BREEZE_BROWSER_DESKTOP_ENABLED` (§17 leaves the name to the builder). Default off. The precedent is vendor updates (`BREEZE_OEM_UPDATES_ENABLED`).

**Files (every row W7 removes again):**
- Modify: `apps/api/src/config/env.ts` (`browserDesktopEnabled(): boolean` = `envFlag('BREEZE_BROWSER_DESKTOP_ENABLED', false)`)
- Modify: `apps/api/src/config/validate.ts` (schema key plus the boolean refine, copying `BREEZE_OEM_UPDATES_ENABLED` at `:914` and `:2612-2617`)
- Modify: `apps/api/src/system/connections/internalEnvVars.ts` (entry: "browser remote desktop rollout flag (#9557, removed after the lab leg)")
- Modify: `apps/api/src/routes/config.ts` (`features.browserDesktop: browserDesktopEnabled()`, with a comment naming #9557 and W7)
- Modify: `docker-compose.yml` and `deploy/docker-compose.prod.yml` (`BREEZE_BROWSER_DESKTOP_ENABLED: ${BREEZE_BROWSER_DESKTOP_ENABLED:-false}` in the api env block, beside `BREEZE_OEM_UPDATES_ENABLED`)
- Modify: `.env.example` and `deploy/.env.example` (commented `# BREEZE_BROWSER_DESKTOP_ENABLED=false` with a one-line note)
- Modify: `apps/docs/src/content/docs/deploy/environment.mdx` (row: default `false`, "Not available yet. Turns on remote desktop in the browser for testing; removed in a later release.")
- Modify: `apps/docs/src/content/docs/deploy/upgrades.mdx` (the release's "new `api` mappings" row, as `BREEZE_OEM_UPDATES_ENABLED` has at `:509`: "Nothing. Leave it unset.")
- `apps/api/src/data/docsIndex.json` carries environment-docs text but is built by `scripts/build-docs-index.ts`; no workflow was found that enforces its freshness (*not checked* beyond a grep), so regenerate it only if the release process does
- Modify: `apps/web/src/stores/featuresStore.ts` (`browserDesktop: boolean` in `Features`, default `false` in `DEFAULT_FEATURES`, closed when `/config` is unreachable)
- Test: `apps/api/src/routes/config.test.ts`, `apps/api/src/config/validate.test.ts`, `apps/web/src/stores/featuresStore.test.ts`

**Interfaces:** produces `features.browserDesktop: boolean` on `GET /api/v1/config`, read on the web through `useFeaturesStore`. W5d and W5e read nothing else.

- [ ] **Step 1: Write the failing tests:** `config exposes features.browserDesktop false by default`, `config exposes true when BREEZE_BROWSER_DESKTOP_ENABLED=true`, `validate rejects a non-boolean BREEZE_BROWSER_DESKTOP_ENABLED`, `featuresStore defaults browserDesktop to false and keeps it false when /config fails`, `featuresStore reads browserDesktop true from /config` (guards against a parser that drops the new field while fetch-mocked tests pass).
- [ ] **Step 2: Run and see them fail.** `cd apps/api && npx vitest run src/routes/config.test.ts src/config/validate.test.ts`; `cd apps/web && npx vitest run src/stores/featuresStore.test.ts`
- [ ] **Step 3: Implement** every file above.
- [ ] **Step 4: Run them, plus the compose contracts:** `cd apps/api && npx vitest run src/config/envComposeParity.test.ts src/config/envReadComposeCoverage.test.ts src/system/connections/envInventory.test.ts`. All green.
- [ ] **Step 5: Commit.** `feat(remote): BREEZE_BROWSER_DESKTOP_ENABLED rollout flag on GET /config, default off (Refs #9557)`

**Turning it on in a worktree stack** (W5d step 5, W5e step 5): add `BREEZE_BROWSER_DESKTOP_ENABLED=true` to the worktree's `.env.stack` (compose reads it last, `scripts/dev/wt-stack/compose.ts:21`; the api gets it through the `x-api-env` anchor in `docker-compose.yml`), then restart the api container. The stack's API source is baked, so a code change needs `pnpm wt-stack up --rebuild`.

CI: `test-api`, `test-web`, `docs-check`. **Rollback:** revert. Nothing reads the flag yet.

### Task 2 (W5b): connection input, transport policy and lifecycle events in the shared component

**Files:**
- Modify: `packages/remote-desktop-ui/src/host.ts`, `src/components/DesktopViewer.tsx`, `src/components/ViewerToolbar.tsx`
- Test: `packages/remote-desktop-ui/src/components/DesktopViewer.browserPolicy.test.tsx`

**Interfaces:**
- Produces: the `DesktopViewer` prop `connection: ConnectionInput`:
  ```ts
  type ConnectionInput =
    | { kind: 'deepLink'; params: ConnectionParams }                 // today's path (Tauri)
    | { kind: 'authorized'; auth: AuthenticatedConnectionParams; deviceId: string; hostname?: string; targetSessionId?: number };
  ```
  With `authorized`, the component skips its exchange (the `:175` guard and `:1277-1338` exchange) and connects directly.
- Produces, in `RemoteDesktopHost`: `lifecycle?: { subscribe(cb: (e: { kind: 'replaced' } | { kind: 'signed-out' }) => void): () => void }`. On an event the component runs **teardown**: release held keys and buttons, stop clipboard sync and drop pending clipboard data, stop all tracks and the audio element, close the peer, call `endDesktopSession` with the viewer token (best effort; `api.ts:120`), then show `ended` with a reason of `replaced` or `signed-out`. `onEnded?: (reason: EndedReason) => void` on the props reports it to the page.
- Honours `host.transports`: with `websocketFallback: false`, a WebRTC failure is terminal (no switch at `:1346-1364`). With `vncSwitch: false`, the toolbar hides the VNC switch and `:703-757` is unreachable.

- [ ] **Step 1: Write the failing tests:** `authorized connection never calls exchangeDesktopConnectCode`; `websocketFallback false: WebRTC failure shows the error, never opens a WebSocket`; `vncSwitch false hides the switch control`; `lifecycle replaced: releases keys, closes the peer, calls endDesktopSession once, shows ended(replaced)`; `lifecycle signed-out: same teardown, ended(signed-out)`; `no lifecycle on the host: nothing subscribes` (Tauri parity).
- [ ] **Step 2: Run and see them fail.** `cd packages/remote-desktop-ui && npx vitest run src/components/DesktopViewer.browserPolicy.test.tsx`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the package suite, the viewer suite and both typechecks.
- [ ] **Step 5: Commit.** `feat(remote-desktop-ui): pre-authorized connection, host transport policy and lifecycle teardown (Refs #9557)`

### Task 3 (W5b): input gate, media hooks, terminal failure, `isTrusted`

§5.8 input gate and terminal failure; §5.6 `isTrusted`.

**Files:** `host.ts`, `DesktopViewer.tsx` (input enable at `:807-815`, `getInputSender` at `:1934-1942`, key and pointer handlers); test `src/components/DesktopViewer.inputGate.test.tsx`

**Interfaces:**
- Produces, in `RemoteDesktopHost`:
  ```ts
  media?: { attach(ctx: PeerMediaContext): () => void };           // called on each new video track; returns detach
  dropUntrustedInput?: boolean;                                    // browser: true
  interface PeerMediaContext {
    pc: RTCPeerConnection;
    video: HTMLVideoElement;
    requestKeyframe(): void;          // the existing keyframe control message
    markFirstFrame(): void;           // opens the input gate
    failTerminal(kind: 'decode' | 'present' | 'stall'): void;
  }
  ```
- With `media` present, input is live only when the transport is ready **and** `markFirstFrame()` has been called for the current track **and** no terminal failure happened. A new track (reconnect, monitor switch) calls `attach` again and closes the gate until the next `markFirstFrame`.
- `failTerminal` releases held keys and buttons, suppresses auto-reconnect, ends the session with `endDesktopSession`, closes the peer, and calls `onEnded({ kind: 'media', detail: kind })`. It never leaves a live session behind a message.
- With `dropUntrustedInput`, keyboard, pointer, wheel and paste handlers return early when `event.isTrusted === false`.

- [ ] **Step 1: Write the failing tests:** `input stays closed until markFirstFrame` (a synthetic connected transport plus a key event: no input message sent); `markFirstFrame opens input`; `a replaced track closes input until the next markFirstFrame`; `failTerminal releases held keys, sends no input after, calls endDesktopSession once, does not reconnect`; `dropUntrustedInput drops an isTrusted=false keydown and pointerdown`; `no media hook: input opens on connect as today` (Tauri parity).
- [ ] **Step 2: Run and see them fail.** `cd packages/remote-desktop-ui && npx vitest run src/components/DesktopViewer.inputGate.test.tsx`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full package suite, the viewer suite and typechecks.
- [ ] **Step 5: Native smoke on Windows and macOS** (input, reconnect, monitor switch) to show the defaults did not move.
- [ ] **Step 6: Commit.** `feat(remote-desktop-ui): host-driven first-frame input gate, terminal media failure and isTrusted filter (Refs #9557)`

**W5b PR:** binary-affecting, so it rides a full release. CI: `test-remote-desktop-ui`, `test-viewer`, `typecheck`. **Rollback:** revert; full release.

### Task 4 (W5c): media preflight

§5.8 "Preflight". Placement: `apps/web` (browser only).

**Files:** create `apps/web/src/lib/remoteDesktop/mediaPreflight.ts` and `mediaPreflight.test.ts`, plus fixtures `apps/web/src/lib/remoteDesktop/__fixtures__/offer-chromium-h264.sdp`, `offer-firefox-no-h264.sdp`, `offer-firefox-openh264-baseline.sdp` (recorded or hand-written from real offers, generic, with no IPs: replace candidates with `0.0.0.0`).

**Interfaces:**
- Produces: `offerHasUsableH264(sdp: string): boolean` (an `a=rtpmap:<pt> H264/90000` whose `a=fmtp:<pt>` includes `packetization-mode=1`; any `profile-level-id`).
- Produces: `runMediaPreflight(env?: { RTCPeerConnection?: typeof RTCPeerConnection; RTCRtpReceiver?: typeof RTCRtpReceiver; userAgentData?: { brands?: { brand: string }[] } }): Promise<PreflightResult>`
  ```ts
  type PreflightResult =
    | { ok: true; engine: 'chromium' | 'other' }     // 'other' drives the D2 (a) "not officially supported" notice
    | { ok: false; reason: 'no-webrtc' | 'no-h264' };
  ```
  Steps: (1) if `RTCRtpReceiver.getCapabilities('video')` exists and lists no `video/H264`, return `no-h264`; (2) create a throwaway peer with one recvonly video transceiver, `createOffer`, close it in `finally`, and test the SDP with `offerHasUsableH264`. `engine` is `chromium` when `userAgentData.brands` includes `Chromium`. That value only chooses the notice (D2 (a)) and never gates.

- [ ] **Step 1: Failing tests:** `chromium fixture passes`, `firefox without H.264 fails no-h264`, `firefox OpenH264 Baseline-only passes` (any profile), `H.264 without packetization-mode=1 fails`, `missing RTCPeerConnection → no-webrtc`, `getCapabilities missing falls through to the offer probe`, `the probe peer is closed even when createOffer throws`, `brands without Chromium → engine other`.
- [ ] **Step 2–4:** `cd apps/web && npx vitest run src/lib/remoteDesktop/mediaPreflight.test.ts`: red, implement, green.
- [ ] **Step 5: Commit.** `feat(web): H.264 media preflight for the browser desktop (Refs #9557)`

### Task 5 (W5c): media watchdog

§5.8 table. Placement: `apps/web`.

**Files:** create `apps/web/src/lib/remoteDesktop/mediaWatchdog.ts` and `mediaWatchdog.test.ts`, plus `apps/web/src/lib/remoteDesktop/rawInboundVideo.ts` (reads the raw `inbound-rtp` video report and never maps a missing field to 0; see the `statsReporter.ts:99-101` warning in the spec).

**Interfaces:**
- Produces: `readInboundVideo(report: RTCStatsReport): InboundVideoSample | null`, where `InboundVideoSample = { packetsReceived?: number; framesDecoded?: number }` (fields `undefined` when absent).
- Produces: `createMediaWatchdog(io: WatchdogIO, t?: Partial<WatchdogThresholds>): MediaWatchdog`
  ```ts
  interface WatchdogIO { now(): number; requestKeyframe(): void; onFirstFrame(): void; onTerminal(kind: 'decode' | 'present' | 'stall'): void; onNoMedia(): void }
  interface WatchdogThresholds { startWindowMs: number; decodeGraceMs: number; presentGraceMs: number; stallGraceMs: number }
  interface MediaWatchdog { onStats(s: InboundVideoSample | null): void; onFramePresented(meta: { width: number }): void; onTrackReplaced(): void; setHidden(hidden: boolean): void; dispose(): void }
  ```
  Provisional defaults, to be retuned from W6 data and recorded in the W6 write-up: `startWindowMs 15000`, `decodeGraceMs 5000`, `presentGraceMs 3000`, `stallGraceMs 8000`.
- Wiring (done in Task 7): `PeerMediaContext` from W5b → poll `pc.getStats()` once a second into `onStats`; `video.requestVideoFrameCallback` into `onFramePresented` (fall back to polling `videoWidth > 0` where rVFC is missing); `onFirstFrame` → `ctx.markFirstFrame()`; `onTerminal` → `ctx.failTerminal(kind)`; `onNoMedia` → the existing no-video and start-failure paths (not the unsupported message).

- [ ] **Step 1: Failing tests,** one per §5.8 row, on a fake clock:
  - `no packets within startWindow → onNoMedia, never onTerminal`
  - `packets without decoded frames → one keyframe request, then terminal decode failure`
  - `frames decoded but never presented → terminal present failure`
  - `first presented frame → onFirstFrame once`
  - `after first frame: packets rising, framesDecoded flat → keyframe, then stall after stallGrace`
  - `no packets after the first frame is idle, not a stall`
  - `missing framesDecoded is unknown: falls back to presentation, never reads 0`
  - `onTrackReplaced re-arms (counters reset, first frame needed again)`
  - `hidden tab suspends stall detection; visible resumes with a fresh baseline`
  - `readInboundVideo returns undefined fields, not 0, when absent`
- [ ] **Step 2–4:** `cd apps/web && npx vitest run src/lib/remoteDesktop/mediaWatchdog.test.ts`: red, implement, green.
- [ ] **Step 5: Commit.** `feat(web): media watchdog for the browser desktop (Refs #9557)`

### Task 6 (W5c): launch transaction and tab session memory

§6.1, §6.2. Placement: `apps/web`.

**Files:** create `apps/web/src/lib/remoteDesktop/launchTransaction.ts` (+ test) and `tabSession.ts` (+ test); modify `apps/web/src/lib/runActionAllowlist.ts` (the bare exchange, with reason "single-use code; must not retry or toast generically").

**Interfaces:**
- Produces:
  ```ts
  interface LaunchDeps {
    createSession(deviceId: string, signal: AbortSignal): Promise<{ id: string }>;          // fetchWithAuth POST /remote/sessions (runAction for the toast)
    mintCode(sessionId: string, signal: AbortSignal): Promise<{ code: string }>;            // fetchWithAuth POST /remote/sessions/:id/desktop-connect-code
    exchange(sessionId: string, code: string, signal: AbortSignal): Promise<ExchangeResult>; // bare exchangeDesktopConnectCode, never retried
    endSession(sessionId: string): Promise<void>;                                           // existing dashboard end route, best effort
    apiUrl: string;                                                                         // import.meta.env.PUBLIC_API_URL || location.origin, as ConnectDesktopButton.tsx:565
  }
  type LaunchOutcome =
    | { kind: 'connected'; auth: AuthenticatedConnectionParams; hostname?: string }
    | { kind: 'resume-refused' }                     // previous session ended; page offers "Start a new session"
    | { kind: 'failed'; step: 'create' | 'mint' | 'exchange'; message: string; status?: number }
    | { kind: 'aborted' };
  function createLaunchController(deps: LaunchDeps): {
    connect(intent: { deviceId: string; resumeSessionId?: string }): Promise<LaunchOutcome>;
    abort(): void;               // aborts the in-flight chain; any session it created is ended
  };
  ```
  `tabSession.ts`: `rememberTabSession(v: { sessionId: string; userId: string }): void`, `readTabSession(userId: string): string | null` (returns null and clears the entry when the stored user differs), `clearTabSession(): void`. All are wrapped in try/catch, and they store **only** those two ids.
- Rules: single flight (a second `connect` aborts the first, and its late results are discarded). Partial failure ends the created session. A failed exchange is never retried with the same code. Resume mints for `resumeSessionId` and, on a 4xx saying the session ended, returns `resume-refused` and never silently creates a new one.

- [ ] **Step 1: Failing tests:**
  - `happy path: create → mint → exchange in order, returns connected`
  - `second connect aborts the first; the first's late mint is ignored and its session ended`
  - `aborting after create ends the created session and ignores the late mint`
  - `mint failure ends the session` / `exchange failure ends the session`
  - `exchange 401 is terminal and never re-sent` (exchange called exactly once)
  - `exchange is never routed through fetchWithAuth's 401 retry` (assert the dep is the bare function, or that `skipUnauthorizedRetry: true` is set)
  - `resume: mint for the stored session; ended → resume-refused, createSession never called`
  - `the code and the token never reach storage, history or the console` (spy on `Storage.prototype.setItem`, `history.pushState`/`replaceState` and `console.*`; assert no argument contains the code or token)
  - `tabSession: other user's entry is discarded`, `stores nothing but sessionId and userId`
- [ ] **Step 2–4:** `cd apps/web && npx vitest run src/lib/remoteDesktop/launchTransaction.test.ts src/lib/remoteDesktop/tabSession.test.ts src/lib/__tests__/no-silent-mutations.test.ts`: red, implement, green.
- [ ] **Step 5: Commit.** `feat(web): single-flight launch transaction for the browser desktop (Refs #9557)`

### Task 7 (W5c): browser host

§5.3 "Browser host" column, §6.3, §5.6.

**Files:** create `apps/web/src/lib/remoteDesktop/browserHost.ts` (+ test).

**Interfaces:**
- Consumes: `RemoteDesktopHost`, `PeerMediaContext` (W5b); `createMediaWatchdog`, `readInboundVideo` (Task 5); `registerLogoutHook` (`apps/web/src/stores/logoutHooks.ts`); the auth store's user id.
- Produces: `createBrowserHost(deps: { deviceId: string; getUserId(): string | null; strings?: Partial<ViewerStrings>; onMediaFailure?(kind: 'decode' | 'present' | 'stall'): void }): RemoteDesktopHost & { setConnected(v: boolean): void; dispose(): void }` with:
  - `kind: 'browser'`, `transports: { websocketFallback: false, vncSwitch: false }`, `dropUntrustedInput: true`
  - `clipboard`: the Async Clipboard API, active only while `document.hasFocus()` and connected; reads that are refused resolve to null (the chip shows the denial)
  - `readPasteText`: `navigator.clipboard.readText()` or null
  - `prefs`: `localStorage` under `breeze-remote-desktop-prefs:<deviceId>` in try/catch, falling back to memory
  - `setTitle`: `document.title`
  - `registerSession`/`registerDevice`: a `BroadcastChannel('breeze-remote-desktop:' + deviceId)`; a newer tab posts `{ type: 'claim', at }`, and an older tab emits `lifecycle` `replaced`. The message carries no ids beyond the channel name.
  - `sessionEnd`: no-op (see Q1). `onCloseRequested`: registers `beforeunload` (`preventDefault` while connected)
  - `saveScreenshot`: Blob URL download, revoked after the click
  - `media.attach`: wires the watchdog to the context (Task 5 "Wiring")
  - `lifecycle`: emits `signed-out` on the logout hook, on a `storage` event with `key === 'breeze-auth'` and `newValue === null`, or when `getUserId()` changes from the value at connect
- [ ] **Step 1: Failing tests:** `clipboard read while unfocused returns null and does not call the API`; `prefs survive a throwing localStorage`; `second host for the same device emits replaced on the first`; `logout hook emits signed-out`; `storage removal of breeze-auth emits signed-out`; `user id change emits signed-out`; `beforeunload prevented only while connected`; `saveScreenshot creates and revokes a blob URL`; `media.attach: first presented frame calls markFirstFrame; decode failure calls failTerminal('decode')`; `dispose unregisters every listener`.
- [ ] **Step 2–4:** `cd apps/web && npx vitest run src/lib/remoteDesktop/browserHost.test.ts`: red, implement, green.
- [ ] **Step 5: Commit.** `feat(web): browser host for the shared remote desktop component (Refs #9557)`

**W5c PR:** CI `test-web`. Inert: nothing imports these modules yet. **Rollback:** revert.

### Task 8 (W5d): the page

§5.6 (minimal scripts, telemetry), §5.9, §5.12, §8, §10 "Docker".

**Files:**
- Create: `apps/web/src/pages/remote/desktop/[deviceId].astro`. It uses `Layout` with `titleKey="titles.remoteDesktopDevice"`, `<AuthOverlay client:load />`, `<ToastContainer client:load />`, and one `<BrowserDesktopPage deviceId={deviceId!} client:only="react" />`. Nothing else.
- Create: `apps/web/src/components/remote/desktop/BrowserDesktopPage.tsx` (+ `BrowserDesktopPage.test.tsx`), `UnsupportedBrowserCard.tsx`
- Create: `apps/web/src/lib/remoteDesktopUrls.ts` (+ test): `buildBrowserDesktopUrl(deviceId: string, opts?: { targetSessionId?: number }): string` → `/remote/desktop/<id>` plus `#ws=<n>` when set; `parseBrowserDesktopFragment(hash: string): { targetSessionId?: number }`, which ignores unknown keys and non-integer values
- Modify: `apps/web/package.json` (`"@breeze/remote-desktop-ui": "workspace:*"`), `apps/web/Dockerfile` (deps stage: `COPY packages/remote-desktop-ui/package.json ./packages/remote-desktop-ui/`), `apps/web/src/styles/globals.css` (`@source '../../../../packages/remote-desktop-ui/src/**/*.{ts,tsx}';` beside the document-ui line)
- Modify: `apps/web/src/pages/remote/bareLayoutToastHost.test.ts` (add the page to `BARE_REMOTE_PAGES`)
- Create: `apps/web/src/pages/remote/desktop/desktopPageScripts.test.ts`, `apps/web/src/lib/__tests__/remoteDesktopImports.test.ts`
- Modify: `apps/web/src/locales/*/pages.json` (`titles.remoteDesktopDevice`) and `apps/web/src/locales/*/remote.json` (`browserDesktop.*`), all 8 locales
- Create: `e2e-tests/tests/remote-desktop-browser.spec.ts`, plus page-object additions under `e2e-tests/pages/`

**Interfaces:** consumes `features.browserDesktop` (Task 1), `runMediaPreflight` (Task 4), `createLaunchController` and `tabSession` (Task 6), `createBrowserHost` (Task 7), `DesktopViewer` with `connection.kind === 'authorized'` and `onEnded` (W5b).

**States** (`data-testid` on each root): `browser-desktop-disabled` (flag off: **no** session, code or exchange call) | `browser-desktop-checking` | `browser-desktop-unsupported` (with the variant: `no-h264` | `decode` | `present`) | `browser-desktop-ready` (`browser-desktop-connect` button; `browser-desktop-unofficial-notice` when `engine === 'other'`) | `browser-desktop-connecting` | `browser-desktop-connected` | `browser-desktop-ended` (reasons: `operator`, `replaced` ("Opened in another tab"), `signed-out`, `media`, `failed`; actions `browser-desktop-connect-again`, `browser-desktop-back`) | `browser-desktop-resume-refused` ("The previous session ended", action `browser-desktop-start-new`).
Unsupported actions (§5.9): `browser-desktop-download-viewer` (existing `getViewerDownloadInfo`), `browser-desktop-copy-link`, `browser-desktop-back`.

**Same-document navigation.** `Layout.astro` renders `<ClientRouter />` (`:3`, `:46`), so a link click or browser Back can swap the document without `beforeunload` or `pagehide`. Rules: the "Back to device" link carries `data-astro-reload`; the island runs the W5b teardown (end the session, close the peer, release input) on `astro:before-swap` and on React unmount, exactly once.

**Telemetry (§5.6):** on mount the island calls `Sentry.getReplay()?.stop()` (no replay while the remote screen is on the page). The video element carries the `sentry-block` class. The shared Sentry config is not loosened.

- [ ] **Step 1: Failing tests:**
  - `BrowserDesktopPage`: `flag off renders disabled and makes no fetch to /remote/sessions, /desktop-connect-code or /connect/exchange`; `failed preflight renders unsupported with no session calls`; `ready never connects without a click` (mount, run timers, assert no create call); `reload with a stored session shows ready, not connecting`; `Connect runs the launch transaction once`; `resume-refused shows Start a new session; only that click creates`; `onEnded(media decode) shows the decoding variant`; `engine other shows the unofficial notice`; `unmount while connected runs teardown once (endDesktopSession called once)`; `astro:before-swap while connected runs the same teardown`; `Back link has data-astro-reload`; `Copy link copies location.href` (the URL carries only the device id and the optional `#ws=`).
  - `remoteDesktopUrls`: `fragment carries ws only`, `unknown keys ignored`, `non-integer ws ignored`.
  - `desktopPageScripts.test.ts`: the `.astro` source imports exactly `Layout`, `AuthOverlay`, `ToastContainer`, `BrowserDesktopPage` and `tServer`, and uses no `DashboardLayout`.
  - `remoteDesktopImports.test.ts`: no file under `apps/web/src` imports `@breeze/remote-desktop-ui/transports/vnc` or names `parseDeepLink`.
  - `BrowserDesktopPage` telemetry: `mount stops Sentry replay`, `video element has sentry-block`.
- [ ] **Step 2: Run and see them fail.** `cd apps/web && npx vitest run src/components/remote/desktop src/lib/remoteDesktopUrls.test.ts src/pages/remote src/lib/__tests__/remoteDesktopImports.test.ts src/lib/i18n/localeParity.test.ts` (substring filters; check the reported file count)
- [ ] **Step 3: Implement.** Add every new key to all 8 locales.
- [ ] **Step 4: Run them and see them pass,** plus `src/lib/__tests__/no-silent-mutations.test.ts` and the locale tests under `src/locales/`.
- [ ] **Step 5: E2E, by hand** (no blocking CI job collects new specs): with a worktree stack (`worktree-stack` skill), run `pnpm wt-stack test -- tests/remote-desktop-browser.spec.ts` twice:
  - flag off: `browser-desktop-disabled`, and no request to the session routes (`page.on('request')`);
  - flag on, preflight forced to pass (`page.addInitScript` stubs `RTCRtpReceiver.getCapabilities` and `RTCPeerConnection.prototype.createOffer` to return the Chromium H.264 fixture): the page renders `ready`, no session call happens before the click, and after Connect no request URL contains a connect code;
  - flag on, preflight forced to fail (the init script returns the no-H.264 fixture): `browser-desktop-unsupported`, and no session call.

  `e2e-tests/playwright.config.ts` has only a `chromium` project, and whether its build decodes H.264 is *not checked*, so both outcomes are forced rather than left to the browser.
  
  Attach the output to the PR. The supported streaming path stays manual (Task 9 step 5).
- [ ] **Step 6: Image build.** `docker build -f apps/web/Dockerfile .` succeeds. `release-build-check` runs on the PR because `apps/web/Dockerfile` changed. Confirm it is green.
- [ ] **Step 7: Commit.** `feat(web): /remote/desktop/[deviceId] browser desktop page behind BREEZE_BROWSER_DESKTOP_ENABLED (Refs #9557)`

CI: `test-web`, `build-web` (its CSP guard covers public routes only), `release-build-check`. **Rollback:** revert; the page is reachable by URL only and is disabled with the flag off.

### Task 9 (W5e): entry points

§5.1, D1 (a), §5.11.

**Files:**
- Create: `apps/web/src/components/remote/connectMenuModel.ts` (+ test). This pulls the split-button decision out of `ConnectDesktopButton.tsx` (1,357 lines) so the component does not grow.
- Modify: `apps/web/src/components/remote/ConnectDesktopButton.tsx` (`ConnectChoice` at `:30` gains `{ kind: 'browser' }`; menu at `:1273-1306` built from the model; the compact variant (`:1200-1270`); the fallback card at `:636-637`; the picker hand-off)
- Modify: `apps/web/src/lib/viewerDownload.ts` (export `detectOS`)
- Modify: `apps/web/src/locales/*/remote.json` (`connectDesktopButton.split.openInBrowser`, `.split.openInBrowserUnsupported`, `.split.connectInBrowser` (Linux primary title), `.fallback.openInBrowser`), all 8 locales
- Test: `ConnectDesktopButton.browser.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  type BrowserAvailability = { flag: boolean; preflight: 'pending' | 'ok' | 'unsupported' };
  function buildConnectMenu(input: {
    providers: RemoteAccessProviderOption[]; defaultProviderId: string | null;
    browser: BrowserAvailability; os: 'windows' | 'macos' | 'linux' | null;
    needsVnc: boolean; disabled: boolean; inFlight: boolean;
  }): { primary: 'provider' | 'builtin' | 'browser' | 'vnc'; items: MenuItemModel[]; sessionOptions: MenuItemModel[] };
  ```
  Rules: a configured default third-party tool stays primary on every OS (`:489-492`). `needsVnc` keeps today's VNC route. Otherwise, on Linux with the flag on and the preflight not `unsupported`, the primary is `browser`; elsewhere it is `builtin`. The menu shows whenever there are tools **or** the flag is on. Items: other tools, **Breeze Viewer**, **Open in browser** (disabled with the reason when the preflight is `unsupported`). `sessionOptions` is always `[]` in this wave (see "Room for #12343").
- The browser choice calls `window.open(buildBrowserDesktopUrl(deviceId, { targetSessionId }), '_blank', 'noopener,noreferrer')` **synchronously inside the click handler**, before any `await`. The primary-click decision is therefore made from the page-load props (`remoteAccessDefaultProviderId`, `desktopAccess`, `remoteAccessPolicy`), not from the live `/devices/:id` re-fetch, which happens after an `await` (`:441-455`). The tab repeats every live check through the real endpoints. See Q2.
- RDS hosts (`helperLifecycleMode === 'on-demand'`): the browser choice opens the session picker first, and `window.open` runs in the picker's confirm click with the chosen `targetSessionId`.
- **Viewer did not open** card (`:636-637`): an **Open in browser** button that first ends the pending hand-off session (`endSession(sessionIdRef.current)`, as `handleDismissAndCleanup` does at `:706-714`) and then opens the tab. Under D6 (b) the tab may never create a session, so F12 cannot be relied on to end it.
- The preflight runs once per page load in the dashboard (`runMediaPreflight`, cached in module scope) only while the flag is on.

**Room for #12343** (not planned here; no behaviour): a per-session "ask the user for permission first" control would sit in the split-button menu's `sessionOptions` group, rendered after a separator below the launch choices, so it applies to Breeze Viewer and Open in browser alike. In the browser tab it would sit beside the Connect button in the `ready` state, since that click is what creates the session under D6 (b). `parseBrowserDesktopFragment` already ignores unknown keys, so a later per-session hint can travel without breaking older pages. Nothing in this wave reads or renders `sessionOptions`.

- [ ] **Step 1: Failing tests:**
  - `connectMenuModel`: `menu shows with no third-party tools when the flag is on`; `flag off: no browser item and today's menu`; `third-party default stays primary on Linux`; `Linux, no default tool, flag on → primary browser`; `Windows → primary builtin, browser in menu`; `preflight unsupported → browser item disabled with reason, Linux primary falls back to builtin`; `needsVnc keeps the VNC route`; `sessionOptions is empty`.
  - `ConnectDesktopButton.browser.test.tsx`: `Open in browser calls window.open synchronously with /remote/desktop/<id> and no code` (spy on `window.open`; assert it is called before any fetch resolves, and the URL matches `/^\/remote\/desktop\/[^?#]+(#ws=\d+)?$/`); `no POST /remote/sessions from the dashboard on the browser path`; `RDS: picker confirm opens #ws=<n>`; `fallback card Open in browser ends the pending session then opens the tab`; `flag off hides every browser entry`; `compact variant lists Open in browser`.
- [ ] **Step 2–4:** `cd apps/web && npx vitest run src/components/remote/connectMenuModel.test.ts src/components/remote/ConnectDesktopButton` (the substring also runs the existing `ConnectDesktopButton.*.test.tsx`, which must stay green), then `src/lib/i18n/localeParity.test.ts` and `src/lib/__tests__/no-silent-mutations.test.ts`.
- [ ] **Step 5: Dev-agent check and connected-session CSP check** (§5.6, §10; not CI). On a worktree stack with the flag on and a dev agent enrolled (a Windows VM in service mode is preferred, a macOS or Linux agent is acceptable for this step), use desktop Chrome on any OS:
  - stream, switch monitors, and use the clipboard both ways; the first frame arrives before input works;
  - with a `securitypolicyviolation` listener installed from DevTools before Connect (`document.addEventListener('securitypolicyviolation', e => console.log(e.violatedDirective, e.blockedURI))`), record **every** violation: none is the pass;
  - Firefox with default prefs gets the unsupported message;
  - flag off: nothing starts.
  
  Results go in the W5e PR body. This confirms the spec's two *inferred* CSP points: ICE/TURN is not governed by `connect-src`, and `srcObject` is not a URL load.
- [ ] **Step 6: Commit.** `feat(web): Open in browser on Connect Desktop, Linux default, failed hand-off card (Refs #9557)`

CI: `test-web`. **Rollback:** revert; the entry points disappear and the page stays disabled behind the flag.

---

## W6: lab leg (no code)

Spec §10 "Lab leg". **Blocking for W7.** Results go on #9557 as one comment with a table per browser.

### What the stack must be

The flag is **deployment-wide**: `GET /config` is unauthenticated and reads env only, so turning it on turns the feature on for every tenant of that deployment. The leg therefore runs on:

- **Our lab stack** (required): a self-hosted Breeze at a release candidate containing W1–W5 (and W3 if it shipped), `BREEZE_BROWSER_DESKTOP_ENABLED=true` in `.env` and mapped through compose (W5a does the mapping), with a single dashboard origin equal to `PUBLIC_APP_URL` so the audit check is valid (§16 note). The target is a lab Windows host with the agent in service mode, a signed-in user, and the hardware (MFT, Main profile) encoder.
- **The contributor's site** (additional evidence, offered on #9557): Linux Mint, Mint's own Chromium package, against their Windows 11 Pro service-mode devices. They need their **own** Breeze deployment on the same release candidate with the flag set as above, and agents on that deployment at a version that passes today's desktop-start capability check. If their pilot runs on a hosted deployment instead, see Q3: we do not turn the flag on for a hosted region for this.

What the contributor's results can and cannot cover:

| Item | Contributor site | Must be ours |
|---|---|---|
| Picture, input, clipboard, cleanup, hidden-tab survival on Mint Chromium | yes, recorded as a fifth browser build | — |
| Google Chrome (Linux amd64) and Debian 13 Chromium (the two pass-required builds) | optional | **yes** |
| Fedora Chromium + GOP-loss comparison (needs the agent's sent-frame count from agent logs) | no | **yes** |
| Ubuntu snap Chromium | optional | **yes** if no one else covers it |
| Unsupported: Debian Firefox ESR default prefs; fresh Ubuntu Firefox profile | optional | **yes** |
| Audit row `exchangeOrigin: browser`; a user without MFA or `remote:access` cannot start | only on their own DB | **yes** |
| Connected-session CSP check | optional | **yes** |

### Pass/fail checklist

Every item passes on Google Chrome **and** Debian Chromium. Fedora, snap and Mint results are recorded against them. A failure blocks W7 until it is fixed and re-run; filing an issue is not a pass. Thresholds marked † are fixed in the run sheet before the run starts.

| Area | Pass when |
|---|---|
| Picture | 10 minutes of mixed use; no blank picture; no freeze longer than 2 s†. The first frame appears before any input reaches the remote. Monitor switch works and re-gates input until its first frame. |
| Input | Drag-select; typing on a non-US layout; paste-as-keystrokes; view-only blocks input; fullscreen + Keyboard Lock sends Alt+Tab and the Windows key to the remote (X11 **and** Wayland session where available); Send Keys works outside fullscreen; Ctrl+W asks before closing. |
| Clipboard | Text and image both ways while the tab is focused. Nothing syncs while it is unfocused. |
| Audio | Only if W3 shipped a fix: audio plays after the toggle. Otherwise recorded, not blocking. |
| Auth | The session's `session_offer_submitted` row has `exchangeOrigin: 'browser'`. A user without MFA, and a user without `remote:access`, cannot start (the create call is refused; nothing streams). Signing out in another tab ends the session (`ended(signed-out)`; the session is ended in history). |
| Cleanup | Closing the tab ends the session at the API within the agent's peer-loss window (§6.4; measure both a clean close and a pulled network cable, the latter about 20 s). Reload shows `ready` and follows §6.2 (or Q1's answer); record whether the end user's consent prompt re-appears on resume. A second tab for the same device takes over and the first says "Opened in another tab". 10 minutes as a hidden tab and the session survives. |
| Unsupported | Debian Firefox ESR (default prefs) and a fresh Ubuntu Firefox profile get the unsupported message: never a blank picture, never live input. |
| CSP | The connected-session check (W5e step 5) records no violations. |
| Watchdog thresholds | Record start time to first frame and the longest decode gap per browser. Retune Task 5's provisional thresholds if the data says so (a W6 follow-up PR, server-only). |

**Fedora GOP-loss check (R1):** compare the agent's sent-frame count with the tab's `framesDecoded`, `keyFramesDecoded` and `pliCount` over the 10 minutes, with Chrome and Debian Chromium as controls. It fails the leg only if Fedora breaks the Picture row. If it reproduces, the release note names it as a known issue.

---

## W7: remove the flag (in-house)

Spec §9, §11. **Outcome:** the flag is gone from code, compose and env docs; the docs build.

**Files:** every file in W5 Task 1, reversed: `env.ts`, `validate.ts`, `internalEnvVars.ts`, `routes/config.ts`, both compose files, both `.env.example` files, `environment.mdx`, `featuresStore.ts`. Also: `BrowserDesktopPage.tsx` (drop the `disabled` state), `connectMenuModel.ts` (`browser.flag` becomes always on, or the field is removed), and the tests that pinned flag-off behaviour (inverted, not deleted: "flag off" assertions become "always available" ones). Docs: `apps/docs/src/content/docs/features/remote-access.mdx:715-717` and `deploy/binaries.mdx:349` point to the browser session. Add a new section "Remote desktop in a browser" to `remote-access.mdx` covering every bullet in spec §11. Add an `upgrades.mdx` note that the variable is gone, and the release note.

- [ ] **Step 1: Failing tests:** in `apps/api/src/routes/config.test.ts`, `config does not expose features.browserDesktop` (`expect(body.features).not.toHaveProperty('browserDesktop')`); in `BrowserDesktopPage.test.tsx`, `renders ready with no feature flag loaded` (the store mocked with no `browserDesktop` field). Both fail on main after W5.
- [ ] **Step 2–4:** remove (including the `upgrades.mdx` note that the variable is gone), then `cd apps/api && npx vitest run src/routes/config.test.ts src/config/` and `cd apps/web && npx vitest run src/components/remote src/stores/featuresStore.test.ts`; the `rg` returns only the release note. `pnpm --filter @breeze/docs build` (or the `docs-check` job) passes.
- [ ] **Step 5: Commit.** `feat(remote): remote desktop in the browser is generally available; remove the rollout flag (Refs #9557)`

**Rollback:** after W7 there is no runtime switch. A rollback is a revert of W7 (the flag returns, default off) plus a redeploy. Say so in the W7 PR.

## W8 (optional): translated in-session strings

D3 (a): after W7. Add a `remoteDesktopViewer` namespace to all 8 web locales, built from the W2c catalog keys. The browser host passes `strings` from `t`. Locale parity must cover the namespace. The native viewer stays English (§15).

---

## CI traps

- **Fork PRs run no CI until workflows are approved,** and a stacked PR (base ≠ `main`) runs none at all: `gh workflow run CI --ref <branch>`.
- **The viewer bundle is not built in PR CI.** `test-viewer` runs vitest and `tsc --noEmit` only (`ci.yml:1533-1537`). The bundle comparison and the native smoke are maintainer steps for W1, W2a, W2b, W2c, W3 and W5b.
- **Binary-affecting paths.** After W1, `packages/remote-desktop-ui/**` forces a full release. Do not put browser-only code there (placement rule).
- **Thinnable-job counts** are pinned in `.github/scripts/ci-gate.test.mjs`, `ci-area-gating.test.mjs`, the `ci.yml` comment and two agent docs. W1 bumps them once.
- **Tailwind scanning.** Both the viewer (`apps/viewer/src/index.css`) and the web (`apps/web/src/styles/globals.css`) need an `@source` for the package. Without it, the fit and actual-size classes vanish with every test green.
- **Web Dockerfile deps list.** A package missing from `apps/web/Dockerfile`'s deps stage fails only at bundle time in the image build, never in `build-web`.
- **Locale parity.** A key in `en` only fails CI. All 8, and never `t(cond ? a : b)`.
- **Scoped vitest runs:** never `pnpm --filter <pkg> test -- --run <path>`. Path filters are substring matches, so check the file count (`docs/agents/testing.md`).
- **API typecheck** with a 12 GB heap; check the exit code, never `| tail`.
- **Release notes draft** (`docs/release-notes/next-release-draft.md`) is a merge-queue hot spot; add the W3 and W7 entries in their own small PRs or at release time.

## Open questions for the maintainer (Gate B)

**Q1. When the tab closes or reloads mid-session, should the browser host end the session explicitly, as the native viewer has since #12129?**
- (a) As the approved spec: no explicit end. Cleanup comes from peer loss (§6.4), and Connect after a reload tries a best-effort resume (§6.2). *Pro:* matches the approved text; a reload can sometimes resume. *Con:* session history records a dropped connection, not an operator end; resume rarely succeeds anyway (§6.2 says so).
- (b) Send End on `pagehide` with a `keepalive` request to `POST /desktop-ws/:id/viewer/end` using the viewer token, and drop resume: a reload shows `ready`, and Connect starts a new session. *Pro:* the same deterministic end reason as the native viewer; one less stored id; the `beforeunload` prompt already warns before a reload. *Con:* changes §6.2; a reload can never keep the session.
- Either way, a same-document navigation (`ClientRouter`) runs the teardown (Task 8), so it never leaves a live session behind.
- **Recommend (b).** The native viewer's close behaviour changed after the spec was written, and the end-reason work (#11839, #11931) assumes an explicit hang-up. If (b) is chosen, Task 6 drops `resumeSessionId` and `tabSession.ts`, Task 7's `sessionEnd` sends the keepalive End, and W6's Cleanup row checks the recorded reason.

**Q2. On Linux, the primary click must call `window.open` before any `await`, or the popup blocker steps in, but today's flow re-fetches the device before choosing a route. Which way?**
- (a) Decide the primary route from the page-load props. With no default third-party tool and no VNC-only verdict, open the tab at once; the tab repeats every live check. *Con:* a stale snapshot can open a tab that then says it cannot connect.
- (b) Keep the re-fetch, then show an inline "Open in browser" button. *Con:* three clicks to a session on the Linux default path.
- **Recommend (a).** The props already drive the button's own disabled state, and the tab's checks are the authoritative ones. When a default tool is configured, today's async path runs unchanged; if it falls back to the built-in path on Linux, it shows the inline button.

**Q3. The flag is deployment-wide. How does the contributor test before W7?**
- (a) On their own self-hosted deployment at our release candidate, with the flag set there. We never turn it on for a hosted region. *Con:* they must run a self-hosted stack.
- (b) Add a partner allowlist and an authenticated read of it. *Con:* new plumbing that W7 deletes again, and `GET /config` cannot carry it because it is unauthenticated.
- (c) Turn the flag on in a hosted region. *Con:* every hosted tenant gets an unvalidated feature; this is the outcome D4 (b) exists to prevent.
- **Recommend (a),** and ask the contributor on #9557 which deployment their pilot runs. If it is hosted, their leg waits for W7, and our lab leg alone gates it.

**Q4. Must the contributor's W1 split `protocol.ts`, or is the alternative (move whole, drop `parseDeepLink` from the exports) enough?**
- (a) Split. *Pro:* the parser cannot even be reached by a deep import; the package has no deep-link code. *Con:* not a pure move.
- (b) Move whole, unexported. *Pro:* a pure rename. *Con:* `@breeze/remote-desktop-ui/src/protocol` stays deep-importable unless `exports` blocks it (it does with the current `exports` map, *inferred*).
- **Recommend (a).** It is a small, mechanical split, and it makes the §16 note true by construction.

**Q5. Should W5b (shared-component hooks, binary-affecting) wait for a full release cycle before W5c–W5e build on it?**
- (a) No: merge W5b, then W5c–W5e in sequence; they ship together in the next full release. *Con:* a W5b regression in the native viewer is found at release, not earlier.
- (b) Yes: ship W5b in a release first, then build on it. *Con:* adds a release cycle to the Linux fix.
- **Recommend (a),** with the W5b native smoke on Windows and macOS before merge and the usual release-candidate smoke on all three OSes.

## Self-review notes

- Spec coverage: §5.1 (W5e), §5.2 (W1, W2b), §5.3 (W2a, W5b, W5c Task 7), §5.4 (W5b Task 2), §5.5 (W4), §5.6 (W4 `no-store`, W5b `isTrusted`, W5d telemetry and scripts, W5e CSP), §5.7 (unchanged endpoints; W6 auth row), §5.8 (W5b Task 3, W5c Tasks 4–5), §5.9 (W5d), §5.10 (W3), §5.11 (W5e), §5.12 (W5d), §6.1–§6.4 (W5c Tasks 6–7, W5b Task 2, Q1), §7 (no tables), §8 (W5d, W5e, W2c, W8), §9 (W5a, W7), §10 (each wave; W6), §11 (W5a env row, W7 docs), §16 notes (W1 A3, A4, A9; W4 B1; W1 bundle comparison).
- Nothing in this plan adds a table, a column, a setting, or an auth path.
- Departures from the approved spec, both for Gate B: (1) Q1, if (b) is chosen, replaces §6.2's best-effort resume with an explicit end on close; (2) §5.3's `connect` host capability becomes a `connection` prop variant (`deepLink` | `authorized`, W2a and W5b), so the browser hands the component an already exchanged credential. §17 leaves the interface to the builder; the code still never leaves the page.
