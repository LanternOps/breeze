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
    case 'android_push_not_configured':
      return {
        notificationsRow: "Push notifications aren't available on Android yet.",
        pairedDevicesHint:
          "Push isn't available on Android yet, so this phone can't register itself. Phones that register for pushes appear here.",
      };
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
