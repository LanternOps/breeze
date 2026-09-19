import { useTranslation } from "react-i18next";
import { formatTimeUntil } from "@/lib/formatTime";
import type { Device } from "./DeviceList";

/**
 * What became of the agent-uninstall a Remove queued (#3987 item 7).
 *
 * Removing a device with "uninstall the Breeze agent" queues a durable command
 * and then drops the socket; whether the endpoint actually came off is settled
 * later, by a machine that may be powered down for a week. This is the only
 * place the console answers "did the agent go away?".
 *
 * Three input states, and they are NOT interchangeable:
 *
 *   `undefined` → the payload does not carry the field (a device-list row).
 *                 Render nothing: we do not know, and guessing "left
 *                 installed" would be a false claim on every removed row.
 *   `null`      → the detail payload says this Remove queued no uninstall.
 *   an object   → an uninstall exists; `state` says how far it got.
 */

type Tone = "info" | "success" | "warning" | "muted";

export interface UninstallStateBadgeProps {
  uninstall: Device["uninstall"];
  /** The device's status — the badge is only meaningful on a removed device. */
  status: string;
  /** Inline text instead of a pill, for the Removed panel in the settings modal. */
  compact?: boolean;
  /** Injectable for tests; defaults to the wall clock. */
  now?: Date;
}

const PILL_TONE: Record<Tone, string> = {
  info: "bg-info/15 text-info border-info/30",
  success: "bg-success/15 text-success border-success/30",
  warning: "bg-warning/15 text-warning border-warning/30",
  muted: "bg-muted text-muted-foreground border-border",
};

const COMPACT_TONE: Record<Tone, string> = {
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  muted: "text-muted-foreground",
};

export default function UninstallStateBadge({
  uninstall,
  status,
  compact,
  now,
}: UninstallStateBadgeProps) {
  const { t } = useTranslation("devices");

  if (status !== "decommissioned") return null;
  // `undefined` (field absent) and `null` (explicitly no uninstall) are
  // different answers — see the component doc.
  if (uninstall === undefined) return null;

  let label: string;
  let tone: Tone;
  let state: string;

  if (uninstall === null) {
    state = "none";
    tone = "muted";
    label = t("uninstallState.none");
  } else {
    state = uninstall.state;
    // An explicit switch, not `t(\`uninstallState.${state}\`)`: the value comes
    // off the wire, so a stale client against a newer server must land
    // somewhere sane rather than painting a raw translation key across the
    // device header — and keyUsage.test.ts can only verify literal keys.
    switch (uninstall.state) {
      case "pending": {
        tone = "info";
        // The deadline is what makes this actionable: it tells a tech whether
        // to wait for the machine to come back or to go touch it. Null (and a
        // deadline already in the past) fall back to deadline-free copy rather
        // than printing a nonsensical or already-shut window.
        const when = uninstall.expiresAt
          ? formatTimeUntil(uninstall.expiresAt, now)
          : null;
        label = when
          ? t("uninstallState.pending", { when })
          : t("uninstallState.pendingNoDeadline");
        break;
      }
      case "sent":
        tone = "info";
        // "delivered", never "uninstalled": `sent` means the agent's command
        // handler acked it, not that the teardown finished (#3995).
        label = t("uninstallState.sent");
        break;
      case "completed":
        tone = "success";
        label = t("uninstallState.completed");
        break;
      case "expired":
        tone = "warning";
        label = t("uninstallState.expired");
        break;
      case "failed":
        tone = "warning";
        label = t("uninstallState.failed");
        break;
      case "cancelled":
        tone = "muted";
        label = t("uninstallState.cancelled");
        break;
      default:
        return null;
    }
  }

  if (compact) {
    return (
      <p
        data-testid="uninstall-state"
        data-state={state}
        className={`text-xs ${COMPACT_TONE[tone]}`}
      >
        {label}
      </p>
    );
  }

  return (
    <span
      data-testid="uninstall-state"
      data-state={state}
      className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-xs font-medium ${PILL_TONE[tone]}`}
    >
      {label}
    </span>
  );
}
