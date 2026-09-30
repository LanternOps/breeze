import { decryptForColumn } from './secretCrypto';
import type { PushoverConfig, PushoverPriority } from './notificationSenders';

/**
 * Partner-level Pushover defaults from `partners.settings.notifications`,
 * inherited by any Pushover channel that leaves the matching field blank.
 */
export interface PartnerPushoverDefaults {
  appToken?: string;
  defaultUser?: string;
  defaultSound?: string;
  defaultPriority?: PushoverPriority;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The application token and user key are stored sealed
 * (`SETTINGS_SECRET_JSON_PATHS`), so they are opened here, at use. A value
 * stored before sealing passes through unchanged. Throws when a sealed value
 * cannot be opened (retired key, corrupt value); callers record that as the
 * send or test failure rather than sending the sealed string as a credential.
 */
export function readPartnerPushoverDefaults(partnerSettings: unknown): PartnerPushoverDefaults {
  const notifications = isRecord(partnerSettings) && isRecord(partnerSettings.notifications)
    ? partnerSettings.notifications
    : {};
  const defaults: PartnerPushoverDefaults = {};

  if (nonBlank(notifications.pushoverAppToken)) {
    defaults.appToken = decryptForColumn('partners', 'settings', notifications.pushoverAppToken) ?? undefined;
  }
  if (nonBlank(notifications.pushoverDefaultUser)) {
    defaults.defaultUser = decryptForColumn('partners', 'settings', notifications.pushoverDefaultUser) ?? undefined;
  }
  if (nonBlank(notifications.pushoverDefaultSound)) {
    defaults.defaultSound = notifications.pushoverDefaultSound;
  }
  if (typeof notifications.pushoverDefaultPriority === 'number') {
    defaults.defaultPriority = notifications.pushoverDefaultPriority as PushoverPriority;
  }
  return defaults;
}

/** Fill the fields a Pushover channel config leaves blank from the partner defaults. */
export function applyPartnerPushoverDefaults(
  config: PushoverConfig,
  defaults: PartnerPushoverDefaults,
): PushoverConfig {
  const merged: PushoverConfig = { ...config };
  if (!nonBlank(merged.token) && defaults.appToken) merged.token = defaults.appToken;
  if (!nonBlank(merged.user) && defaults.defaultUser) merged.user = defaults.defaultUser;
  if (merged.sound === undefined && defaults.defaultSound) merged.sound = defaults.defaultSound;
  if (merged.priority === undefined && defaults.defaultPriority !== undefined) {
    merged.priority = defaults.defaultPriority;
  }
  return merged;
}
