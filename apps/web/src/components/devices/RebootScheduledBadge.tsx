import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import { formatDateTime } from "@/lib/dateTimeFormat";
import type { Device } from "./DeviceList";

/**
 * Console visibility for a scheduled end-user restart (#3207 W5).
 *
 * Deliberately distinct from the `pendingReboot` badge it sits beside: that one
 * means "the OS says a restart is required at some point", this one means "a
 * restart is BOOKED for a specific instant, and here is how much of the
 * deferral budget the end user has spent". A device can show either, both, or
 * neither.
 */

type RebootScheduledBadgeProps = Pick<
  Device,
  | "rebootScheduledAt"
  | "rebootDeadline"
  | "rebootSource"
  | "rebootDeferralsUsed"
  | "rebootMaxDeferrals"
> & {
  /** Injectable for tests; defaults to the wall clock. */
  now?: Date;
};

export default function RebootScheduledBadge({
  rebootScheduledAt,
  rebootDeadline,
  rebootSource,
  rebootDeferralsUsed,
  rebootMaxDeferrals,
  now,
}: RebootScheduledBadgeProps) {
  const { t } = useTranslation("devices");

  if (!rebootScheduledAt) return null;
  const scheduledAt = new Date(rebootScheduledAt);
  if (Number.isNaN(scheduledAt.getTime())) return null;

  // Past its scheduled instant means the agent has already fired the restart
  // and the box is on its way down; the next heartbeat clears the row. Saying
  // "scheduled" for a machine that is already rebooting reads as a stuck job.
  const isRestarting = scheduledAt.getTime() <= (now ?? new Date()).getTime();

  // An explicit switch, not `t(\`...${rebootSource}\`)`. The source is echoed
  // back by the agent, so it is untrusted input: an unrecognized value must
  // land on the generic label rather than be rendered raw or spliced into a
  // translation key (which keyUsage.test.ts also could not verify statically).
  let sourceLabel: string;
  switch (rebootSource) {
    case "patch_job":
      sourceLabel = t("deviceDetails.restartSourcePatchJob");
      break;
    case "maintenance_window":
      sourceLabel = t("deviceDetails.restartSourceMaintenanceWindow");
      break;
    case "manual":
      sourceLabel = t("deviceDetails.restartSourceManual");
      break;
    default:
      sourceLabel = t("deviceDetails.restartSourceUnknown");
  }

  const tooltip = [
    isRestarting
      ? t("deviceDetails.restartInProgressAt", {
          time: formatDateTime(rebootScheduledAt),
        })
      : t("deviceDetails.restartScheduledFor", {
          time: formatDateTime(rebootScheduledAt),
        }),
    sourceLabel,
    rebootDeadline
      ? t("deviceDetails.restartDeadline", {
          time: formatDateTime(rebootDeadline),
        })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // 0 and null differ: 0 is "this restart carries no deferral budget", null is
  // "the agent never told us" (a build that predates deferral reporting). Only
  // the first justifies telling a tech the restart cannot be postponed.
  const maxDeferrals =
    typeof rebootMaxDeferrals === "number" ? rebootMaxDeferrals : null;
  const deferralsUsed =
    typeof rebootDeferralsUsed === "number" ? rebootDeferralsUsed : null;
  const showDeferrals =
    maxDeferrals !== null && deferralsUsed !== null && maxDeferrals > 0;
  const cannotBePostponed = maxDeferrals === 0;

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <span
        data-testid="device-reboot-scheduled"
        data-reboot-state={isRestarting ? "restarting" : "scheduled"}
        title={tooltip}
        className="inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium bg-info/15 text-info border-info/30"
      >
        <RotateCcw className="h-3 w-3" aria-hidden="true" />
        {isRestarting
          ? t("deviceDetails.restartInProgress")
          : t("deviceDetails.restartScheduled")}
      </span>
      {showDeferrals && (
        <span
          data-testid="device-reboot-deferrals"
          title={t("deviceDetails.restartPostponedTooltip")}
          className="inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-xs font-medium bg-warning/15 text-warning border-warning/30"
        >
          {t("deviceDetails.restartPostponed", {
            used: deferralsUsed,
            max: maxDeferrals,
          })}
        </span>
      )}
      {cannotBePostponed && (
        <span
          data-testid="device-reboot-no-deferrals"
          className="inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-xs font-medium bg-muted text-muted-foreground border-border"
        >
          {t("deviceDetails.restartCannotBePostponed")}
        </span>
      )}
    </span>
  );
}
