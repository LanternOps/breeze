import * as SecureStore from 'expo-secure-store';

/**
 * Stable per-installation device id sent on every API call as
 * `X-Breeze-Mobile-Device-Id`. Used by the API to:
 *   - identify the row in `mobile_devices` for the calling phone
 *   - reject calls from devices the user has marked blocked (lost phone)
 *   - skip pushes / data fan-out to revoked installs
 *
 * Persisted in SecureStore so it survives logout/login. A re-pair after a
 * block creates a fresh row server-side because the install id IS still
 * the same — the API enrolment path inserts a new row with a different
 * `mobile_devices.id` and only matches the device_id when the existing
 * row is `status='active'`. (See route note in apps/api/src/routes/mobile.ts.)
 */
const KEY = 'breeze_mobile_device_id';

let cached: string | null = null;

function generateUuid(): string {
  // RFC 4122 v4 (no crypto.randomUUID() in RN runtime).
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += '-';
    } else if (i === 14) {
      out += '4';
    } else if (i === 19) {
      out += hex[(Math.random() * 4) | 0 | 8];
    } else {
      out += hex[(Math.random() * 16) | 0];
    }
  }
  return out;
}

export async function getOrCreateInstallationId(): Promise<string> {
  if (cached) return cached;

  try {
    const existing = await SecureStore.getItemAsync(KEY);
    if (existing && existing.length > 0) {
      cached = existing;
      return existing;
    }
  } catch {
    // SecureStore unavailable in some test environments — fall through
  }

  const fresh = generateUuid();
  try {
    await SecureStore.setItemAsync(KEY, fresh);
  } catch {
    // Best-effort: even a transient memory id is better than no header.
  }
  cached = fresh;
  return fresh;
}

export function _resetInstallationIdForTests(): void {
  cached = null;
}
