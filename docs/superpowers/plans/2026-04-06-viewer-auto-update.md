# Viewer Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the viewer's manual update gate with Tauri's built-in updater plugin for fully automatic, silent updates via GitHub Releases.

**Architecture:** Add `tauri-plugin-updater` + `tauri-plugin-process` to the Rust backend. On launch, spawn an async task that checks the GitHub Releases endpoint for updates, downloads and installs silently, applies on next restart. Remove all frontend update-checking code. CI generates signed update artifacts and a merged `latest.json` manifest.

**Tech Stack:** Tauri 2 (tauri-plugin-updater, tauri-plugin-process), Rust, GitHub Actions, Ed25519 signing

**Spec:** `docs/superpowers/specs/2026-04-06-viewer-auto-update-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `apps/viewer/src-tauri/Cargo.toml` | Add updater + process plugin deps, tokio with time feature |
| Modify | `apps/viewer/src-tauri/tauri.conf.json` | Enable updater artifacts, add updater plugin config |
| Modify | `apps/viewer/src-tauri/src/lib.rs` | Register plugins, spawn auto-update task |
| Modify | `apps/viewer/src/App.tsx` | Remove update gate UI and all update-related state |
| Delete | `apps/viewer/src/lib/version.ts` | No longer needed — Rust handles updates |
| Modify | `apps/viewer/package.json` | Remove unused deps if applicable |
| Modify | `.github/workflows/release.yml` | Wire signing key, upload updater artifacts, merge manifest |

---

### Task 1: Generate Signing Keypair (Manual One-Time Setup)

**Files:**
- None (local + GitHub Secrets)

This task must be done by the developer manually before CI can produce signed builds.

- [ ] **Step 1: Generate the keypair**

```bash
cd apps/viewer
pnpm tauri signer generate -w ~/.tauri/breeze-viewer.key
```

This outputs:
- Private key: `~/.tauri/breeze-viewer.key`
- Public key: printed to stdout (save this — needed for Task 3)

- [ ] **Step 2: Add private key to GitHub Secrets**

Go to `https://github.com/LanternOps/breeze/settings/secrets/actions` and create:
- `TAURI_SIGNING_PRIVATE_KEY` — paste the full contents of `~/.tauri/breeze-viewer.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — paste the password you chose (or leave empty if none)

- [ ] **Step 3: Save the public key for later**

Copy the public key string (starts with `dW5...` or similar base64). You'll paste it into `tauri.conf.json` in Task 3.

---

### Task 2: Add Rust Dependencies

**Files:**
- Modify: `apps/viewer/src-tauri/Cargo.toml`

- [ ] **Step 1: Add dependencies to Cargo.toml**

In `apps/viewer/src-tauri/Cargo.toml`, add to the `[dependencies]` section:

```toml
tauri-plugin-updater = "2"
tauri-plugin-process = "2"
tokio = { version = "1", features = ["time"] }
```

The full `[dependencies]` section should look like:

```toml
[dependencies]
tauri = { version = "2", features = ["devtools"] }
tauri-plugin-deep-link = "2"
tauri-plugin-shell = "2"
tauri-plugin-updater = "2"
tauri-plugin-process = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tauri-plugin-clipboard-manager = "2.3.2"
tokio = { version = "1", features = ["time"] }
```

- [ ] **Step 2: Verify it compiles**

```bash
cd apps/viewer/src-tauri && cargo check
```

Expected: compiles with no errors (warnings OK).

- [ ] **Step 3: Commit**

```bash
git add apps/viewer/src-tauri/Cargo.toml apps/viewer/src-tauri/Cargo.lock
git commit -m "feat(viewer): add tauri-plugin-updater and tauri-plugin-process deps"
```

---

### Task 3: Configure Tauri Updater in tauri.conf.json

**Files:**
- Modify: `apps/viewer/src-tauri/tauri.conf.json`

- [ ] **Step 1: Add createUpdaterArtifacts to bundle config**

In `tauri.conf.json`, add `"createUpdaterArtifacts": true` inside the `"bundle"` object. The bundle section becomes:

```json
"bundle": {
  "active": true,
  "createUpdaterArtifacts": true,
  "targets": "all",
  "icon": [
    "icons/32x32.png",
    "icons/128x128.png",
    "icons/128x128@2x.png",
    "icons/icon.icns",
    "icons/icon.ico"
  ]
}
```

- [ ] **Step 2: Add updater plugin config**

In the `"plugins"` object (alongside the existing `"deep-link"` entry), add the `"updater"` config. Replace `PUBLIC_KEY_FROM_TASK_1` with the actual public key string from Task 1 Step 3:

```json
"plugins": {
  "deep-link": {
    "desktop": {
      "schemes": ["breeze"]
    }
  },
  "updater": {
    "pubkey": "PUBLIC_KEY_FROM_TASK_1",
    "endpoints": [
      "https://github.com/LanternOps/breeze/releases/latest/download/latest.json"
    ]
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/viewer/src-tauri/tauri.conf.json
git commit -m "feat(viewer): configure tauri-plugin-updater with GitHub Releases endpoint"
```

---

### Task 4: Add Auto-Update Logic to Rust Backend

**Files:**
- Modify: `apps/viewer/src-tauri/src/lib.rs:1-5` (imports)
- Modify: `apps/viewer/src-tauri/src/lib.rs:256-344` (run function, setup closure)

- [ ] **Step 1: Add the auto_update function**

Add this function above the `run()` function (before line 256) in `lib.rs`:

```rust
/// Check for updates and silently download + install if available.
/// The update is staged and applied on next app restart — active sessions are never interrupted.
async fn auto_update(app: tauri::AppHandle) {
    // Delay to let session windows and WebRTC setup proceed first
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("Failed to create updater: {}", e);
            return;
        }
    };

    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return, // already up to date
        Err(e) => {
            eprintln!("Update check failed: {}", e);
            return;
        }
    };

    eprintln!("Update {} available, downloading...", update.version);

    if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
        eprintln!("Update download/install failed: {}", e);
        return;
    }

    eprintln!("Update installed, will apply on next restart");
}
```

- [ ] **Step 2: Add the UpdaterExt import**

At the top of `lib.rs` (line 1), add the import. The imports become:

```rust
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_updater::UpdaterExt;
```

- [ ] **Step 3: Register plugins in the builder**

In the `run()` function, add the two new plugins after the existing plugin registrations. Change lines 258-261 from:

```rust
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
```

to:

```rust
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::init())
        .plugin(tauri_plugin_process::init())
```

- [ ] **Step 4: Spawn auto-update task in setup**

In the `setup` closure, add the auto-update spawn after the deep link listener setup (after line 341, before `Ok(())`). Insert:

```rust
            // Silent auto-update: check, download, stage for next restart
            let update_handle = app.handle().clone();
            tauri::async_runtime::spawn(auto_update(update_handle));
```

The end of the setup closure should look like:

```rust
            app.deep_link().on_open_url(move |event| {
                if let Some(url) = event.urls().first() {
                    let url = url.to_string();
                    let h = app_handle.clone();
                    std::thread::spawn(move || {
                        let h2 = h.clone();
                        let _ = h.run_on_main_thread(move || {
                            route_deep_link(&h2, url);
                        });
                    });
                }
            });

            // Silent auto-update: check, download, stage for next restart
            let update_handle = app.handle().clone();
            tauri::async_runtime::spawn(auto_update(update_handle));

            Ok(())
        })
```

- [ ] **Step 5: Verify it compiles**

```bash
cd apps/viewer/src-tauri && cargo check
```

Expected: compiles with no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/viewer/src-tauri/src/lib.rs
git commit -m "feat(viewer): add silent auto-update via tauri-plugin-updater"
```

---

### Task 5: Remove Frontend Update Gate

**Files:**
- Modify: `apps/viewer/src/App.tsx`
- Delete: `apps/viewer/src/lib/version.ts`

- [ ] **Step 1: Delete version.ts**

```bash
rm apps/viewer/src/lib/version.ts
```

- [ ] **Step 2: Clean up App.tsx imports**

Remove these imports from `App.tsx`:

```tsx
import type { ComponentType } from 'react';
import { checkForUpdate, type UpdateInfo } from './lib/version';
import { ArrowDownCircle, AlertTriangle } from 'lucide-react';
```

And remove these lines:

```tsx
const UpdateIcon = ArrowDownCircle as unknown as ComponentType<{ className?: string }>;
const AlertIcon = AlertTriangle as unknown as ComponentType<{ className?: string }>;
```

The remaining imports should be:

```tsx
import { useEffect, useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import DesktopViewer from './components/DesktopViewer';
import { parseDeepLink, type ConnectionParams } from './lib/protocol';
```

- [ ] **Step 3: Remove update-related state**

Remove these state declarations from the `App` component:

```tsx
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('checking');
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
```

And remove the type:

```tsx
type UpdateStatus = 'checking' | 'current' | 'outdated' | 'error';
```

- [ ] **Step 4: Remove the update check useEffect**

Remove this entire effect (lines 38-52):

```tsx
  // ── Update check — runs in every session window ─────────────────────
  useEffect(() => {
    if (windowLabel === 'main') return;

    checkForUpdate().then((info) => {
      if (info) {
        setUpdateInfo(info);
        setUpdateStatus('outdated');
      } else {
        setUpdateStatus('current');
      }
    }).catch(() => {
      // Can't reach GitHub — allow usage rather than bricking offline
      setUpdateStatus('error');
    });
  }, [windowLabel]);
```

- [ ] **Step 5: Remove handleOpenDownload callback**

Remove this entire callback (lines 116-130):

```tsx
  const handleOpenDownload = useCallback(async () => {
    const url = updateInfo?.downloadUrl || updateInfo?.releaseUrl;
    if (!url) return;
    try {
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(url);
    } catch {
      window.open(url, '_blank');
    }
    try {
      getCurrentWebviewWindow().close();
    } catch {
      // best-effort
    }
  }, [updateInfo]);
```

- [ ] **Step 6: Remove the update gate UI**

Remove the entire "outdated" conditional block (lines 138-169):

```tsx
  // ── Session window: update gate ─────────────────────────────────────
  if (updateStatus === 'outdated' && updateInfo) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-900">
        ...entire update required UI...
      </div>
    );
  }
```

- [ ] **Step 7: Simplify the loading spinner**

Change the loading spinner text. Remove the update-checking conditional — just show "Connecting...":

Replace:

```tsx
        <p className="text-gray-400 text-sm">
          {updateStatus === 'checking' ? 'Checking for updates...' : 'Connecting...'}
        </p>
```

With:

```tsx
        <p className="text-gray-400 text-sm">Connecting...</p>
```

- [ ] **Step 8: Verify the final App.tsx**

The complete `App.tsx` should now be:

```tsx
import { useEffect, useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import DesktopViewer from './components/DesktopViewer';
import { parseDeepLink, type ConnectionParams } from './lib/protocol';

/**
 * Main window: hidden, serves as process anchor (Tauri requires at least one window).
 * Session windows: connect via deep link, show DesktopViewer.
 */
export default function App() {
  const [windowLabel, setWindowLabel] = useState<string>('main');
  const [params, setParams] = useState<ConnectionParams | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastDeepLinkRef = useRef<{ key: string; at: number } | null>(null);

  // Detect window role on mount
  useEffect(() => {
    try {
      const win = getCurrentWebviewWindow();
      setWindowLabel(win.label);
    } catch {
      // fallback: main
    }
  }, []);

  // ── Session window: deep link polling + events ─────────────────────
  const applyDeepLink = useCallback((url: string) => {
    const parsed = parseDeepLink(url);
    if (!parsed) return;

    const key = `${parsed.sessionId}|${parsed.connectCode}|${parsed.apiUrl}`;
    const now = Date.now();
    const last = lastDeepLinkRef.current;
    if (last && last.key === key && now - last.at < 2000) return;

    lastDeepLinkRef.current = { key, at: now };
    invoke('clear_pending_deep_link').catch(() => {});
    setParams(parsed);
    setError(null);
  }, []);

  useEffect(() => {
    if (windowLabel === 'main') return;

    // Path 1: Poll Rust for pending deep link
    let pollCount = 0;
    const maxPolls = 17;
    const pollTimer = setInterval(() => {
      pollCount++;
      invoke<string | null>('get_pending_deep_link').then((url) => {
        if (url) {
          clearInterval(pollTimer);
          applyDeepLink(url);
        } else if (pollCount >= maxPolls) {
          clearInterval(pollTimer);
        }
      }).catch(() => {
        if (pollCount >= maxPolls) clearInterval(pollTimer);
      });
    }, 300);

    // Path 2: Listen for events scoped to THIS window only.
    // Global listen() receives events from all windows — emit_to("session-2")
    // would also trigger session-1's listener, causing cross-window bleed.
    const unlisten = getCurrentWebviewWindow().listen<string>('deep-link-received', (event) => {
      applyDeepLink(event.payload);
    });

    return () => {
      clearInterval(pollTimer);
      unlisten.then((fn) => fn());
    };
  }, [windowLabel, applyDeepLink]);

  const handleDisconnect = useCallback(() => {
    lastDeepLinkRef.current = null;
    getCurrentWebviewWindow().close().catch(() => {
      // If Tauri close fails, clear state to unmount the viewer
      setParams(null);
    });
  }, []);

  const handleError = useCallback((msg: string) => {
    lastDeepLinkRef.current = null;
    setError(msg);
  }, []);

  // ── Main window: hidden, render nothing ─────────────────────────────
  if (windowLabel === 'main') {
    return null;
  }

  // ── Session window: viewer ─────────────────────────────────────────
  if (params) {
    return (
      <DesktopViewer
        params={params}
        onDisconnect={handleDisconnect}
        onError={handleError}
      />
    );
  }

  // Waiting for deep link
  return (
    <div className="flex items-center justify-center h-screen bg-gray-900">
      <div className="text-center">
        <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
        <p className="text-gray-400 text-sm">Connecting...</p>
        {error && (
          <p className="text-red-400 text-sm mt-2">{error}</p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 9: Verify frontend builds**

```bash
cd apps/viewer && pnpm build
```

Expected: builds with no errors.

- [ ] **Step 10: Commit**

```bash
git add -u apps/viewer/src/
git commit -m "feat(viewer): remove manual update gate, updates now handled by Rust updater"
```

---

### Task 6: Update CI to Sign and Upload Updater Artifacts

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Wire signing key in build-viewer job (Windows/Linux)**

In the `build-viewer` job, find the "Build Tauri app" step (around line 825). Change the `TAURI_SIGNING_PRIVATE_KEY` env var from empty string to the secret:

```yaml
      - name: Build Tauri app
        working-directory: apps/viewer
        shell: bash
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
        run: pnpm tauri build --target ${{ matrix.target }}
```

- [ ] **Step 2: Upload per-platform latest.json in build-viewer job**

After the existing "Upload Viewer artifact" step in the `build-viewer` job, add a new step to upload the generated `latest.json`:

```yaml
      - name: Upload Viewer update manifest
        uses: actions/upload-artifact@v7
        with:
          name: viewer-update-manifest-${{ matrix.target }}
          path: apps/viewer/src-tauri/target/${{ matrix.target }}/release/bundle/*/latest.json
          retention-days: 30
          if-no-files-found: warn
```

- [ ] **Step 3: Wire signing key in build-viewer-macos job**

In the `build-viewer-macos` job, find the "Build Tauri app" step (around line 1015). Apply the same signing key change:

```yaml
      - name: Build Tauri app
        working-directory: apps/viewer
        shell: bash
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
        run: pnpm tauri build --target universal-apple-darwin
```

- [ ] **Step 4: Upload per-platform latest.json in build-viewer-macos job**

After the existing "Upload Viewer macOS artifact" step, add:

```yaml
      - name: Upload Viewer macOS update manifest
        uses: actions/upload-artifact@v7
        with:
          name: viewer-update-manifest-macos
          path: apps/viewer/src-tauri/target/universal-apple-darwin/release/bundle/*/latest.json
          retention-days: 30
          if-no-files-found: warn
```

- [ ] **Step 5: Add merge-viewer-update-manifest job**

Add this new job after `build-viewer-macos` and before `create-release`:

```yaml
  merge-viewer-update-manifest:
    name: Merge Viewer Update Manifests
    runs-on: ubuntu-latest
    needs: [build-viewer, build-viewer-macos]
    if: >-
      !cancelled()
      && (needs.build-viewer.result == 'success' || needs.build-viewer.result == 'skipped')
      && (needs.build-viewer-macos.result == 'success' || needs.build-viewer-macos.result == 'skipped')
    steps:
      - name: Download all viewer update manifests
        uses: actions/download-artifact@v8
        with:
          path: manifests
          pattern: 'viewer-update-manifest-*'
          merge-multiple: false

      - name: Merge manifests into single latest.json
        shell: bash
        run: |
          # Collect all per-platform latest.json files
          FILES=$(find manifests -name 'latest.json' -type f)
          if [ -z "$FILES" ]; then
            echo "No update manifests found — skipping merge"
            exit 0
          fi

          echo "Found manifests:"
          echo "$FILES"

          # Merge: take version/notes/pub_date from first file, merge all platforms objects
          node -e "
            const fs = require('fs');
            const files = process.argv.slice(1);
            let merged = null;
            for (const f of files) {
              const data = JSON.parse(fs.readFileSync(f, 'utf8'));
              if (!merged) {
                merged = data;
              } else {
                Object.assign(merged.platforms || {}, data.platforms || {});
              }
            }
            fs.writeFileSync('latest.json', JSON.stringify(merged, null, 2));
            console.log('Merged platforms:', Object.keys(merged.platforms || {}));
          " $FILES

          cat latest.json

      - name: Upload merged manifest
        uses: actions/upload-artifact@v7
        with:
          name: viewer-latest-json
          path: latest.json
          retention-days: 30
```

- [ ] **Step 6: Update create-release job dependencies**

In the `create-release` job, add `merge-viewer-update-manifest` to the `needs` array:

```yaml
  create-release:
    name: Create Release
    runs-on: ubuntu-latest
    needs: [build-api, build-web, build-agent, build-windows-msi, build-macos-agent, sign-windows-tauri, build-viewer, build-helper, build-viewer-macos, build-helper-macos, merge-viewer-update-manifest]
```

Also add to the `if` condition:

```yaml
      && (needs.merge-viewer-update-manifest.result == 'success' || needs.merge-viewer-update-manifest.result == 'skipped')
```

- [ ] **Step 7: Update download artifact pattern in create-release**

In the "Download all artifacts" step, add the merged manifest to the pattern:

```yaml
      - name: Download all artifacts
        uses: actions/download-artifact@v8
        with:
          path: artifacts
          pattern: '{api-dist,web-dist,breeze-agent-*,breeze-backup-*,breeze-desktop-helper-*,breeze-watchdog-*,breeze-viewer-*,breeze-helper-*,viewer-latest-json}'
          merge-multiple: false
```

- [ ] **Step 8: Copy latest.json in prepare release assets step**

In the "Prepare release assets" step, after the viewer installer copy block, add:

```bash
          # Copy viewer update manifest
          if [ -d "artifacts/viewer-latest-json" ] && [ -f "artifacts/viewer-latest-json/latest.json" ]; then
            cp artifacts/viewer-latest-json/latest.json release-assets/latest.json
          fi
```

- [ ] **Step 9: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "feat(ci): sign viewer builds and publish auto-update manifest"
```

---

### Task 7: Verify End-to-End

**Files:** None (manual testing)

- [ ] **Step 1: Local build with signing**

Generate a temporary test keypair and build locally to verify artifacts are produced:

```bash
cd apps/viewer
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/breeze-viewer.key)" pnpm tauri build
```

Verify these files exist in the bundle output:
- The installer (`.dmg`, `.msi`, or `.AppImage`)
- An update bundle (`.app.tar.gz` on macOS, `.msi.zip` on Windows, `.AppImage.tar.gz` on Linux)
- A `.sig` signature file for the update bundle
- A `latest.json` manifest

- [ ] **Step 2: Inspect latest.json**

```bash
cat src-tauri/target/*/release/bundle/*/latest.json
```

Verify it contains `version`, `platforms` with your platform key, `signature`, and `url` fields.

- [ ] **Step 3: Verify Rust updater runs on launch**

Build and launch the app. Check stderr output for update check logs:

```bash
cd apps/viewer
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/breeze-viewer.key)" pnpm tauri build
# Run the built app and check logs
```

Expected: Either "Update X available, downloading..." or silence (if already up to date). No crashes, no UI blockage.

- [ ] **Step 4: Verify frontend has no update gate**

Launch the app with a deep link. It should go straight to "Connecting..." → DesktopViewer. No "Update Required" screen.
