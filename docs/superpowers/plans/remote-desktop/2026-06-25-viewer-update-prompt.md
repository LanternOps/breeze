# Viewer Interactive Update Prompt — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the viewer's silent auto-restart/auto-close with an interactive "Update X downloaded — [Restart & update] [Remind me later]" prompt when no remote session is active.

**Architecture:** After the Rust auto-updater finishes downloading, it no longer installs/restarts automatically. With no active session it stashes the downloaded `Update` + bytes in managed state and emits a new `Ready` phase; the React banner shows two buttons that call back into Rust via Tauri commands (`apply_pending_update` / `dismiss_pending_update`). With an active session it keeps the existing silent deferral (and, on Windows, no longer interrupts the session to install).

**Tech Stack:** Rust (Tauri v2, `tauri-plugin-updater`), React + TypeScript, Vitest (jsdom).

## Global Constraints

- **Spec:** `docs/superpowers/specs/remote-desktop/2026-06-25-viewer-update-prompt-design.md` — implement exactly that behavior matrix.
- **Copy (verbatim):** banner text `Update {version} downloaded`; buttons `Restart & update` and `Remind me later`.
- **Windows "Remind me later":** drop the downloaded bytes (no install); the updater re-checks next launch.
- **Active remote session:** keep showing the existing `Deferred` notice ("applies when this session ends"); never show the interactive prompt or restart mid-session.
- **Serde tag contract:** the Rust `UpdateStatus` enum is `#[serde(tag = "phase", rename_all = "lowercase")]`; every variant must stay mirrored in `src/lib/updateStatus.ts`, locked by the `update_status_serializes_to_expected_shape` test.
- **`invoke` import path:** `@tauri-apps/api/core` (matches `src/App.tsx`).
- **No component tests:** the viewer has no `@testing-library/react`; test pure logic in `src/lib/*.test.ts` only. Do NOT add testing-library.
- **Worktree setup:** before running frontend tests, run `pnpm install` once from the worktree root (`/Users/toddhebebrand/breeze-worktrees/viewer-update-prompt`) — a fresh worktree has no `node_modules`.
- **Pinned Node:** use the repo's pinned Node (v22.20.0); do not use Node 23 (breaks `engine-strict`).

---

### Task 1: Add the `Ready` update phase to the Rust enum (+ contract test)

**Files:**
- Modify: `apps/viewer/src-tauri/src/lib.rs:452-463` (enum), `:807-852` (serialize test)

**Interfaces:**
- Produces: `UpdateStatus::Ready { version: String }` serializing to `{"phase":"ready","version":"…"}`.

- [ ] **Step 1: Add the failing test case**

In `apps/viewer/src-tauri/src/lib.rs`, inside `update_status_serializes_to_expected_shape`, add a `Ready` case to the `cases` array (after the `Failed` case, before the closing `]`):

```rust
            (
                UpdateStatus::Ready { version: v.clone() },
                json!({ "phase": "ready", "version": "1.2.3" }),
            ),
```

- [ ] **Step 2: Run the test — verify it FAILS to compile**

Run: `cd apps/viewer/src-tauri && cargo test update_status_serializes_to_expected_shape`
Expected: FAIL — `no variant named Ready found for enum UpdateStatus`.

- [ ] **Step 3: Add the `Ready` variant**

In the `UpdateStatus` enum (`lib.rs:452`), add the variant after `Failed { version: String },`:

```rust
    Failed { version: String },
    /// Downloaded and waiting for the user to choose Restart & update or
    /// Remind me later. Only emitted when no remote session is active.
    Ready { version: String },
```

- [ ] **Step 4: Run the test — verify it PASSES**

Run: `cd apps/viewer/src-tauri && cargo test update_status_serializes_to_expected_shape`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/viewer/src-tauri/src/lib.rs
git commit -m "feat(viewer): add Ready phase to UpdateStatus enum"
```

---

### Task 2: Hold the download and gate install/restart behind user commands

**Files:**
- Modify: `apps/viewer/src-tauri/src/lib.rs` — add `PendingUpdate` state struct (near the other state structs, ~`:56`), restructure `auto_update` tail (`:565-607`), add two commands (near the other `#[tauri::command]`s, ~`:262`), register them in the `invoke_handler` (`:617-624`), manage the state in `.setup()` (`:679-682`).

**Interfaces:**
- Consumes: `UpdateStatus::Ready` (Task 1); existing `emit_update_status`, `lock_or_recover`, `SessionMap`, `UpdateStatus::{Installing,Restarting,Failed,Deferred}`.
- Produces: Tauri commands `apply_pending_update` and `dismiss_pending_update` (called by the frontend in Task 4).

> No unit test — Tauri command + `#[cfg]` platform branches aren't unit-testable without a live updater. The deliverable is verified by `cargo build` + `cargo test` (the serialize test from Task 1 must still pass) and the manual checks in the spec. Keep the platform logic thin.

- [ ] **Step 1: Add the `PendingUpdate` state struct**

Near the other managed-state structs in `lib.rs` (e.g. just after `struct SessionMap(...)` at `:56`), add:

```rust
/// A downloaded-but-not-yet-applied update, awaiting the user's choice in the
/// `Ready` prompt. The `Update` handle is retained because `install()` is a
/// method on it. Only ever holds a value when no remote session is active.
struct PendingUpdate(Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>>);
```

- [ ] **Step 2: Manage the state in `.setup()`**

In the `.setup()` closure where the other states are managed (`lib.rs:679-682`), add after `app.manage(WindowCounter(Mutex::new(0)));`:

```rust
            app.manage(PendingUpdate(Mutex::new(None)));
```

- [ ] **Step 3: Restructure the `auto_update` tail**

Replace everything from the `eprintln!("Update {} downloaded, installing...", …)` line (`lib.rs:565`) through the end of the `#[cfg(not(target_os = "windows"))]` block (`:606`) — i.e. the old unconditional `install()` and the restart block — with:

```rust
    eprintln!("Update {} downloaded", update.version);

    // Decide what to do with the download based on whether a remote session is
    // live. Restarting/installing mid-session would kill it, so an active
    // session always defers; otherwise we hand the choice to the user.
    let has_active_sessions = app
        .try_state::<SessionMap>()
        .map(|s| {
            let map = lock_or_recover(&s.0, "session_map");
            !map.is_empty()
        })
        .unwrap_or(false);

    if has_active_sessions {
        // Don't interrupt a live session. macOS/Linux can swap the binary on
        // disk now (takes effect next launch); Windows can't install without
        // exiting, so drop the download and re-check on next launch.
        #[cfg(not(target_os = "windows"))]
        {
            if let Err(e) = update.install(bytes) {
                eprintln!("Deferred update disk-swap failed: {}", e);
            }
        }
        #[cfg(target_os = "windows")]
        {
            drop((update, bytes));
        }
        eprintln!("Active remote session — deferring update to next launch");
        emit_update_status(&app, UpdateStatus::Deferred { version });
        return;
    }

    // No active session — stash the download and let the user choose via the
    // Ready prompt (apply_pending_update / dismiss_pending_update).
    if let Some(pending) = app.try_state::<PendingUpdate>() {
        *lock_or_recover(&pending.0, "pending_update") = Some((update, bytes));
        eprintln!("Update {} ready — awaiting user choice", version);
        emit_update_status(&app, UpdateStatus::Ready { version });
    } else {
        eprintln!("PendingUpdate state missing; cannot present update prompt");
    }
```

> Note: `version` is the `let version = update.version.clone();` already bound at `lib.rs:520`. The old `emit_update_status(&app, UpdateStatus::Installing …)` at `:569` is removed here — `Installing` is now emitted by `apply_pending_update` instead.

- [ ] **Step 4: Add the two commands**

After the existing commands (e.g. after `update_session_hostname`, ~`lib.rs:262`), add:

```rust
/// "Restart & update": apply the stashed update now. On macOS/Linux this swaps
/// the binary and restarts; on Windows `install()` launches the installer and
/// the process exits. No-op if nothing is pending (e.g. a double click).
#[tauri::command]
fn apply_pending_update(app: tauri::AppHandle, pending: tauri::State<'_, PendingUpdate>) {
    let taken = {
        let mut slot = lock_or_recover(&pending.0, "pending_update");
        slot.take()
    };
    let Some((update, bytes)) = taken else {
        return;
    };
    let version = update.version.clone();

    #[cfg(target_os = "windows")]
    {
        emit_update_status(&app, UpdateStatus::Installing { version: version.clone() });
        // install() launches the installer and terminates the process; on
        // success nothing after this runs. Reaching past it means it failed.
        if let Err(e) = update.install(bytes) {
            eprintln!("Update install failed: {}", e);
            emit_update_status(&app, UpdateStatus::Failed { version });
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Err(e) = update.install(bytes) {
            eprintln!("Update install failed: {}", e);
            emit_update_status(&app, UpdateStatus::Failed { version });
            return;
        }
        emit_update_status(&app, UpdateStatus::Restarting { version });
        app.restart();
    }
}

/// "Remind me later": discard the prompt. On macOS/Linux swap the binary on
/// disk so the next launch is updated; on Windows drop the download (re-checks
/// next launch). No-op if nothing is pending.
#[tauri::command]
fn dismiss_pending_update(pending: tauri::State<'_, PendingUpdate>) {
    let taken = {
        let mut slot = lock_or_recover(&pending.0, "pending_update");
        slot.take()
    };
    let Some((update, bytes)) = taken else {
        return;
    };

    #[cfg(not(target_os = "windows"))]
    {
        if let Err(e) = update.install(bytes) {
            eprintln!("Deferred update disk-swap failed: {}", e);
        }
    }
    #[cfg(target_os = "windows")]
    {
        drop((update, bytes));
    }
}
```

- [ ] **Step 5: Register the commands in the invoke handler**

In `tauri::generate_handler![ … ]` (`lib.rs:617-624`), add the two names after `update_session_hostname,`:

```rust
            update_session_hostname,
            apply_pending_update,
            dismiss_pending_update,
```

- [ ] **Step 6: Build + run the Rust tests**

Run: `cd apps/viewer/src-tauri && cargo build && cargo test`
Expected: builds cleanly; `update_status_serializes_to_expected_shape` and existing tests PASS.

> If `cargo build` complains that `Update` is not `Send + Sync` (managed state requires it), STOP and report — the fallback is to box the install closure differently; do not silently change behavior.

- [ ] **Step 7: Commit**

```bash
git add apps/viewer/src-tauri/src/lib.rs
git commit -m "feat(viewer): gate update install/restart behind user choice"
```

---

### Task 3: Add the `ready` phase to the frontend status helper (+ tests)

**Files:**
- Modify: `apps/viewer/src/lib/updateStatus.ts`
- Test: `apps/viewer/src/lib/updateStatus.test.ts`

**Interfaces:**
- Consumes: the `ready` serde shape `{ phase: 'ready', version: string }` (Task 1).
- Produces: `UpdateStatus` union includes `ready`; `updateStatusMessage` returns `Update {version} downloaded`; `isUpdateActive('ready') === false`; `shouldAutoDismiss('ready') === false`.

- [ ] **Step 1: Write the failing tests**

In `apps/viewer/src/lib/updateStatus.test.ts`, add a new block (place near the other `describe`s):

```ts
describe('ready phase', () => {
  const ready: UpdateStatus = { phase: 'ready', version: '1.2.3' };

  it('messages as a downloaded-and-waiting prompt', () => {
    expect(updateStatusMessage(ready)).toBe('Update 1.2.3 downloaded');
  });

  it('is not "active" (no progress affordance)', () => {
    expect(isUpdateActive(ready)).toBe(false);
  });

  it('does not auto-dismiss (stays pinned until the user acts)', () => {
    expect(shouldAutoDismiss(ready)).toBe(false);
  });

  it('is accepted by the IPC-boundary guard', () => {
    expect(isUpdateStatus({ phase: 'ready', version: '1.2.3' })).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests — verify they FAIL**

Run: `cd apps/viewer && pnpm install && pnpm exec vitest run src/lib/updateStatus.test.ts`
Expected: FAIL — `updateStatusMessage` has no `ready` case / type error on the `ready` literal.

- [ ] **Step 3: Implement the `ready` phase**

In `apps/viewer/src/lib/updateStatus.ts`:

a) Add to the union (after the `failed` line, `:21`):

```ts
  | { phase: 'failed'; version: string }
  | { phase: 'ready'; version: string };
```

b) Add to `KNOWN_PHASES` (`:33-40`):

```ts
  failed: true,
  ready: true,
```

c) Add a case in `updateStatusMessage` (before `default:`, `:92`):

```ts
    case 'ready':
      return `Update ${status.version} downloaded`;
```

d) Add a case in `isUpdateActive` — group it with the non-active phases (`:109-111`):

```ts
    case 'deferred':
    case 'failed':
    case 'ready':
      return false;
```

> `shouldAutoDismiss` needs no change: it returns true only for `deferred`/`failed`, so `ready` is already false.

- [ ] **Step 4: Run the tests — verify they PASS**

Run: `cd apps/viewer && pnpm exec vitest run src/lib/updateStatus.test.ts`
Expected: PASS (all cases, including the new block).

- [ ] **Step 5: Commit**

```bash
git add apps/viewer/src/lib/updateStatus.ts apps/viewer/src/lib/updateStatus.test.ts
git commit -m "feat(viewer): add ready phase to update status helper"
```

---

### Task 4: Add the `updateActions` IPC wrappers (+ tests)

**Files:**
- Create: `apps/viewer/src/lib/updateActions.ts`
- Test: `apps/viewer/src/lib/updateActions.test.ts`

**Interfaces:**
- Consumes: Tauri commands `apply_pending_update` / `dismiss_pending_update` (Task 2); `invoke` from `@tauri-apps/api/core`.
- Produces: `applyPendingUpdate(): Promise<void>` and `dismissPendingUpdate(): Promise<void>` (used by the component in Task 5).

- [ ] **Step 1: Write the failing tests**

Create `apps/viewer/src/lib/updateActions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { applyPendingUpdate, dismissPendingUpdate } from './updateActions';

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe('updateActions', () => {
  it('applyPendingUpdate invokes the apply command', async () => {
    await applyPendingUpdate();
    expect(invoke).toHaveBeenCalledWith('apply_pending_update');
  });

  it('dismissPendingUpdate invokes the dismiss command', async () => {
    await dismissPendingUpdate();
    expect(invoke).toHaveBeenCalledWith('dismiss_pending_update');
  });
});
```

- [ ] **Step 2: Run the tests — verify they FAIL**

Run: `cd apps/viewer && pnpm exec vitest run src/lib/updateActions.test.ts`
Expected: FAIL — `Cannot find module './updateActions'`.

- [ ] **Step 3: Implement the wrappers**

Create `apps/viewer/src/lib/updateActions.ts`:

```ts
import { invoke } from '@tauri-apps/api/core';

/**
 * "Restart & update": apply the downloaded update now. On macOS/Linux the
 * viewer reinstalls and restarts; on Windows the installer launches and the
 * process exits. Backed by the `apply_pending_update` Tauri command.
 */
export function applyPendingUpdate(): Promise<void> {
  return invoke('apply_pending_update');
}

/**
 * "Remind me later": dismiss the update prompt. macOS/Linux swaps the binary
 * on disk for next launch; Windows re-checks on next launch. Backed by the
 * `dismiss_pending_update` Tauri command.
 */
export function dismissPendingUpdate(): Promise<void> {
  return invoke('dismiss_pending_update');
}
```

- [ ] **Step 4: Run the tests — verify they PASS**

Run: `cd apps/viewer && pnpm exec vitest run src/lib/updateActions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/viewer/src/lib/updateActions.ts apps/viewer/src/lib/updateActions.test.ts
git commit -m "feat(viewer): add update apply/dismiss IPC wrappers"
```

---

### Task 5: Render the interactive prompt in `UpdateIndicator`

**Files:**
- Modify: `apps/viewer/src/components/UpdateIndicator.tsx`

**Interfaces:**
- Consumes: `applyPendingUpdate` / `dismissPendingUpdate` (Task 4); `ready` phase from `updateStatus.ts` (Task 3).

> No unit test (no testing-library in this app — see Global Constraints). Verified by `tsc` (via `pnpm build`) and the manual checks in the spec.

- [ ] **Step 1: Import the actions and add `useState`**

At the top of `apps/viewer/src/components/UpdateIndicator.tsx`, add the import (after the `updateStatus` import block, `:11`):

```ts
import { applyPendingUpdate, dismissPendingUpdate } from '../lib/updateActions';
```

Add an `acting` guard next to the existing `status` state (`:26`):

```ts
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [acting, setActing] = useState(false);
```

- [ ] **Step 2: Make the banner interactive only for `ready`**

The container's `className` is currently a plain double-quoted string (`:74-77`). Convert it to a template literal so the pointer-events class can be conditional. Replace this exact block:

```tsx
      className="fixed top-3 left-1/2 -translate-x-1/2 z-50 max-w-[90vw]
                 flex flex-col gap-1 px-3 py-2 rounded-lg shadow-lg
                 bg-gray-800/95 border border-gray-700 text-gray-100
                 backdrop-blur-sm pointer-events-none"
```

with (note the backticks and `${...}`):

```tsx
      className={`fixed top-3 left-1/2 -translate-x-1/2 z-50 max-w-[90vw]
                 flex flex-col gap-1 px-3 py-2 rounded-lg shadow-lg
                 bg-gray-800/95 border border-gray-700 text-gray-100
                 backdrop-blur-sm ${status.phase === 'ready' ? 'pointer-events-auto' : 'pointer-events-none'}`}
```

- [ ] **Step 3: Render the two buttons for the `ready` phase**

Immediately after the closing `</div>` of the message row (the `<div className="flex items-center gap-2 text-xs">…</div>` block ending at `:84`) and before the `{active && (` progress block (`:85`), insert:

```tsx
      {status.phase === 'ready' && (
        <div className="flex items-center gap-2 mt-0.5">
          <button
            type="button"
            disabled={acting}
            onClick={() => {
              setActing(true);
              applyPendingUpdate().catch((e) => {
                console.error('Failed to apply update', e);
                setActing(false);
              });
            }}
            className="px-2 py-0.5 rounded bg-blue-600 hover:bg-blue-500
                       disabled:opacity-50 text-xs font-medium"
          >
            Restart &amp; update
          </button>
          <button
            type="button"
            disabled={acting}
            onClick={() => {
              setActing(true);
              dismissPendingUpdate()
                .catch((e) => console.error('Failed to dismiss update', e))
                .finally(() => setStatus(null));
            }}
            className="px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600
                       disabled:opacity-50 text-xs"
          >
            Remind me later
          </button>
        </div>
      )}
```

- [ ] **Step 4: Type-check / build the frontend**

Run: `cd apps/viewer && pnpm build`
Expected: `tsc` passes (no type errors), Vite build succeeds.

- [ ] **Step 5: Run the full viewer frontend test suite**

Run: `cd apps/viewer && pnpm exec vitest run`
Expected: all tests PASS (including the new `updateStatus` and `updateActions` suites).

- [ ] **Step 6: Commit**

```bash
git add apps/viewer/src/components/UpdateIndicator.tsx
git commit -m "feat(viewer): show Restart & update / Remind me later prompt"
```

---

## Final verification (after all tasks)

- [ ] **Rust:** `cd apps/viewer/src-tauri && cargo test` — all pass.
- [ ] **Frontend:** `cd apps/viewer && pnpm exec vitest run` — all pass; `pnpm build` clean.
- [ ] **Manual (per spec "Manual verification"):** confirm — no-session prompt appears and never closes without a click; "Remind me later" hides the banner and the app keeps running; "Restart & update" relaunches into the new version; active-session shows the deferred notice and is NOT interrupted (especially on Windows).
- [ ] Spec behavior matrix re-read against the diff; no auto-`restart()`/auto-`install()` remains on the no-session path.
