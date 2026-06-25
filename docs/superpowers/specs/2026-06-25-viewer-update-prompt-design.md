# Viewer interactive update prompt — design

**Date:** 2026-06-25
**Branch:** `feat/viewer-update-prompt`
**Area:** `apps/viewer` (Tauri + React remote-desktop viewer)

## Problem

The viewer auto-updates silently. Commit `34ab25adb` (#1450) added an
`UpdateIndicator` banner so the download/install no longer *looks* like a crash,
but the viewer still **closes itself without giving the user any choice**:

- **No active session, macOS/Linux:** after `update.install()` swaps the binary,
  `auto_update` calls `app.restart()` immediately (`lib.rs:604`). The "restarting…"
  banner flashes but the app relaunches the same instant — no chance to react.
- **Windows (any case):** `update.install(bytes)` (`lib.rs:573`) launches the
  MSI/NSIS installer and the process exits. The window just vanishes. This fires
  even when a remote session is active, interrupting it.

We want the user to **optionally close and re-open** instead of the viewer
deciding for them.

## Goal

When an update has downloaded and **no remote session is active**, present an
interactive prompt and never close without an explicit click:

```
⬆  Update 1.2.3 downloaded
   [ Restart & update ]   [ Remind me later ]
```

When a remote session **is** active, keep the existing non-interactive
"applies when this session ends" deferral — restarting mid-session would kill
the live session.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Interaction model | Interactive prompt with **Restart & update** / **Remind me later**. Never closes without a click (no-session case). |
| Windows "Remind me later" | **Re-prompt next launch** — drop the downloaded bytes, banner dismisses, `auto_update` re-checks and re-prompts on next start. (Windows can't swap in place + keep running.) |
| Active remote session | **Keep deferring silently** — show the existing "applies when this session ends" notice, no buttons. Prompt only appears with no active session. |
| Copy | Banner: `Update {version} downloaded`. Buttons: `Restart & update` / `Remind me later`. |

**Rejected:** countdown-with-cancel (still closes on its own if the user steps
away — doesn't solve "closes without notice").

## Behavior matrix

| Situation | Today | New |
|---|---|---|
| No active session | macOS/Linux: silent `app.restart()`. Windows: installer launches, window vanishes | **Interactive `Ready` prompt:** `Update X downloaded — [Restart & update] [Remind me later]` |
| Active remote session | macOS/Linux: defers (notice, binary already swapped, no restart). Windows: **installer launches and kills the session** | macOS/Linux: defer + swap-on-disk (unchanged). Windows: defer **without installing** — no longer interrupts the session |
| "Restart & update" clicked | — | macOS/Linux: `install()` → `app.restart()`. Windows: `install()` (process exits, installer runs, relaunches) |
| "Remind me later" clicked | — | macOS/Linux: `install()` swaps binary silently, banner dismisses, applies next launch. Windows: drop bytes, banner dismisses, re-checks next launch |

## Architecture

### Rust — `apps/viewer/src-tauri/src/lib.rs`

1. **Pending-update state.** Add a Tauri-managed
   `PendingUpdate(Mutex<Option<PendingUpdateInner>>)` where `PendingUpdateInner`
   holds the downloaded `tauri_plugin_updater::Update` and its `Vec<u8>` bytes.
   The `Update` handle is needed because `install()` is a method on it.

2. **Restructure `auto_update`.** After a successful `download(...)`:
   - Compute `has_active_sessions` (existing logic at `lib.rs:590`).
   - **Active session** → emit `UpdateStatus::Deferred`. On macOS/Linux call
     `update.install(bytes)` first so the binary is swapped for next launch
     (matches today). On Windows do **not** install (don't interrupt the
     session) — drop the bytes; it re-checks next launch.
   - **No active session** → store `(update, bytes)` in `PendingUpdate`, emit the
     new `UpdateStatus::Ready { version }`, and return. Do **not** install or
     restart. The prompt now drives what happens next.

   The previous unconditional `update.install(bytes)` at `lib.rs:573` and the
   `app.restart()` at `lib.rs:604` are removed from the auto path; the install /
   restart now happen only in response to the commands below.

3. **Two new `#[tauri::command]`s** (registered in the `invoke_handler`):
   - `apply_pending_update(app)`: take the stored `(update, bytes)`.
     - macOS/Linux: emit `Restarting`, `update.install(bytes)`, then `app.restart()`.
     - Windows: emit `Installing`, `update.install(bytes)` (process exits).
     - On install error → emit `Failed`, clear pending state.
     - If nothing is pending (double-click race) → no-op.
   - `dismiss_pending_update(app)` ("Remind me later"): take + clear the pending
     entry.
     - macOS/Linux: `update.install(bytes)` to swap the binary silently (applies
       next launch). Errors are logged but non-fatal (next launch re-checks).
     - Windows: drop the bytes (no install). Next launch re-checks and re-prompts.
     - Emits nothing — the frontend hides the banner locally on click.

4. **`UpdateStatus` enum:** add the `Ready { version }` variant. Update the
   `serialize_*` contract test that locks the serde tag names / field shapes so
   the Rust and TS definitions can't drift.

### Frontend

1. **`apps/viewer/src/lib/updateStatus.ts`**
   - Add `{ phase: 'ready'; version: string }` to the `UpdateStatus` union and to
     `KNOWN_PHASES` (the exhaustiveness map — adding to the union without the map
     is a compile error, so both must change together).
   - `updateStatusMessage`: `ready` → `Update {version} downloaded`.
   - `isUpdateActive`: `ready` → `false` (no progress bar / pulse).
   - `shouldAutoDismiss`: `ready` → `false` (stays pinned until the user acts).

2. **`apps/viewer/src/components/UpdateIndicator.tsx`**
   - When `status.phase === 'ready'`, render two buttons:
     - **Restart & update** → `invoke('apply_pending_update')`.
     - **Remind me later** → `invoke('dismiss_pending_update')` then
       `setStatus(null)` to hide the banner locally.
   - Make the banner container `pointer-events-auto` **only** in the `ready`
     phase (it is `pointer-events-none` today and must stay so for the
     informational phases, which sit over the remote-desktop canvas).
   - Use an upload/arrow icon for `ready` (e.g. `ArrowUpCircle`); keep existing
     icons for the other phases.
   - Guard against double-invoke: disable the buttons after the first click.

### Tests

- **`apps/viewer/src/lib/updateStatus.test.ts`** — add cases for the `ready`
  phase: message text, `isUpdateActive === false`, `shouldAutoDismiss === false`,
  and `isUpdateStatus` acceptance of a well-formed `ready` payload.
- **`apps/viewer/src/components/UpdateIndicator.test.tsx`** (if present, else add)
  — `ready` renders both buttons and wires them to the right `invoke` calls;
  "Remind me later" hides the banner; buttons disable after click. Mock
  `@tauri-apps/api/core`'s `invoke`.
- **Rust `serialize_*` contract test** — assert the `ready` tag serializes as
  `{"phase":"ready","version":"..."}`.
- Command-level behavior (`apply` / `dismiss` branching by platform) is hard to
  unit-test without a live updater; cover it with `#[cfg]`-gated logic kept thin
  and a manual verification note (below).

## Edge cases

- **Double-click / re-entrancy:** commands take-and-clear the `Mutex<Option<…>>`
  atomically, so a second click finds `None` and no-ops. Frontend also disables
  buttons after first click.
- **Install failure on apply:** emit `Failed`, clear pending state so the banner
  doesn't stay stuck on "Installing…".
- **Window closed while prompt is up:** existing last-window-close → `exit(0)`
  path (`lib.rs:756`) is unchanged; the un-applied update is simply re-checked on
  next launch (macOS already has the binary swapped only if a prior dismiss ran,
  otherwise it re-downloads — acceptable).
- **`Deferred` copy:** unchanged ("applies when this session ends") since it now
  only fires in the active-session branch.

## Out of scope

- No change to the 3-second startup delay or the update-check cadence.
- No persistence of "remind me later" across launches (Windows re-prompts each
  launch by design; macOS applies on next launch so there's nothing to nag).
- No change to the Helper Tauri app — this is the **viewer** only.

## Manual verification

- macOS, no session: trigger an update → prompt appears → "Remind me later"
  hides it and the app keeps running; relaunch shows the new version. "Restart &
  update" relaunches into the new version immediately.
- macOS, active session: update finishes → "applies when this session ends"
  notice, session uninterrupted.
- Windows, no session: prompt appears → "Restart & update" runs the installer;
  "Remind me later" hides it and a fresh launch re-prompts.
- Windows, active session: update finishes → deferred notice, session **not**
  interrupted (the key bug fix on Windows).
