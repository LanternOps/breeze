/**
 * Copy for the Settings sheet when push registration reported `unsupported`
 * (services/notifications.ts). `unsupported` is a deliberate "not built /
 * not possible here" resting state — not a failure — so the sheet must stop
 * asserting the capability (an ON Notifications toggle) and explain instead.
 *
 * Kept as a pure module (approverBannerCopy.ts precedent) so the
 * reason → copy mapping is unit-tested rather than re-litigated in JSX.
 * Issue #3118.
 */
export interface PushUnavailableCopy {
  /** Replaces the Notifications toggle description. */
  notificationsRow: string;
  /** Replaces the paired-devices empty hint, which otherwise reads as an error. */
  pairedDevicesHint: string;
}

export function pushUnavailableCopy(reason: string | null): PushUnavailableCopy {
  switch (reason) {
    case 'not_physical_device':
      return {
        notificationsRow: "Push notifications aren't available in the simulator.",
        pairedDevicesHint:
          "Simulators can't register for pushes, so this device isn't listed. Phones that register for pushes appear here.",
      };
    default:
      return {
        notificationsRow: "Push notifications aren't available on this device.",
        pairedDevicesHint:
          "This device can't register for pushes, so it isn't listed. Phones that register for pushes appear here.",
      };
  }
}

/**
 * Copy for the Settings sheet's Notifications row across ALL push-registration
 * states (#3143, extending the #3118 treatment above).
 *
 * The old Notifications / Critical-only toggles were write-only: they persisted
 * to AsyncStorage but nothing consumed the keys, and the client has no seam
 * that could honor them — the foreground display handler never sees
 * background/lock-screen pushes, which is where approval pushes land. So the
 * row is now a status readout instead of a control: the one real control the
 * user has (the OS notification permission) lives in system Settings, and the
 * row deep-links there when that's actionable.
 *
 * Only `ok` may claim pushes are being delivered — every other status must
 * tell the truth that they aren't. In particular `failed` must carry the
 * explanation here too, because ApprovalGate's failure banner is dismissible
 * per session and this row is what remains after dismissal.
 */
export type PushRowStatus = 'idle' | 'ok' | 'failed' | 'unsupported';

export interface NotificationsRowCopy {
  /** Description under the "Notifications" label. */
  description: string;
  /**
   * True when tapping the row should open the app's system notification
   * settings (Linking.openSettings) — the real on/off control.
   */
  opensSystemSettings: boolean;
  /**
   * Replaces the paired-devices empty hint when this device cannot register
   * itself (`unsupported`); null means keep the default hint.
   */
  pairedDevicesHint: string | null;
}

export function notificationsRowCopy(
  status: PushRowStatus,
  reason: string | null
): NotificationsRowCopy {
  switch (status) {
    case 'idle':
      return {
        description: 'Checking push registration…',
        opensSystemSettings: false,
        pairedDevicesHint: null,
      };
    case 'ok':
      return {
        description:
          'Approval pushes and alerts are delivered to this phone. Tap to manage them in Settings.',
        opensSystemSettings: true,
        pairedDevicesHint: null,
      };
    case 'unsupported': {
      const copy = pushUnavailableCopy(reason);
      return {
        description: copy.notificationsRow,
        opensSystemSettings: false,
        pairedDevicesHint: copy.pairedDevicesHint,
      };
    }
    case 'failed':
      // Phrasing mirrors ApprovalGate's PushFailedBanner ("Push notifications
      // aren't registered … allowed for Breeze in Settings … sign in again")
      // so the two surfaces never contradict each other.
      if (reason === 'permission_denied') {
        return {
          description:
            "Push notifications aren't registered — notifications are turned off for Breeze in Settings. Tap to allow them, then sign in again.",
          opensSystemSettings: true,
          pairedDevicesHint: null,
        };
      }
      return {
        description:
          "Push notifications aren't registered, so approval requests won't reach this phone. Sign in again to retry.",
        opensSystemSettings: false,
        pairedDevicesHint: null,
      };
  }
}
