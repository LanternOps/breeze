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
