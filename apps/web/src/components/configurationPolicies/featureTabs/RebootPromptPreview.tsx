import { useTranslation } from "react-i18next";
import {
  rebootPromptTextSchemas,
  REBOOT_PROMPT_COUNTDOWN_PLACEHOLDER,
} from "@breeze/shared";
import { resolvedFormattingLocale } from "@/lib/i18n/format";

/**
 * What the person at the computer sees on the restart prompt (#10190 W05,
 * #10181), rendered from the patch policy being edited.
 *
 * It mirrors the agent rather than inventing its own rules:
 *   - operator title / body / button fill the card; a field the agent would
 *     drop (fails the shared plain-text schema) falls back to the built-in
 *     text, exactly as SanitizeRebootPromptText does on the device;
 *   - the built-in English copy is the agent catalog's (`restart.prompt`);
 *   - `{{countdown}}` is shown as a sample `M:SS` countdown, the format Assist
 *     uses for `{remaining}`; the text is rendered as text, never markup;
 *   - the default (safe) action is Postpone when the policy allows a
 *     deferral, otherwise OK (dismiss only); the restart button is never the
 *     default. Postpone's time follows ComputeDeferral (reboot_deferral.go):
 *     scheduled time + interval, clamped to the deadline the API derives
 *     (scheduled time + max deferrals × interval). A maintenance window can
 *     only make that deadline earlier, so "no later than" stays true.
 *
 * Times are examples: the restart is assumed to be scheduled at `now`.
 */

const MINUTE_MS = 60_000;
/** agent/internal/patching/reboot_plan.go MinRebootDelay. */
const MIN_REBOOT_DELAY_MS = MINUTE_MS;

export interface RebootPromptPreviewSettings {
  rebootDelayMinutes: number;
  rebootAllowDeferral: boolean;
  rebootMaxDeferrals: number;
  rebootDeferralMinutes: number;
  rebootPromptTitle: string | null;
  rebootPromptBody: string | null;
  rebootPromptButton: string | null;
}

type TimingSettings = Pick<
  RebootPromptPreviewSettings,
  | "rebootDelayMinutes"
  | "rebootAllowDeferral"
  | "rebootMaxDeferrals"
  | "rebootDeferralMinutes"
>;

export interface RebootPreviewTimes {
  restartAtMs: number;
  /** null when the first prompt would offer no Postpone. */
  postponeUntilMs: number | null;
  /** The latest a restart can be postponed to; null without a deferral. */
  deadlineMs: number | null;
}

export function computeRebootPreviewTimes(
  settings: TimingSettings,
  nowMs: number,
): RebootPreviewTimes {
  const delayMinutes = Math.max(0, settings.rebootDelayMinutes || 0);
  const restartAtMs = nowMs + delayMinutes * MINUTE_MS;
  const max = settings.rebootMaxDeferrals || 0;
  const interval = settings.rebootDeferralMinutes || 0;
  if (!settings.rebootAllowDeferral || max <= 0 || interval <= 0) {
    return { restartAtMs, postponeUntilMs: null, deadlineMs: null };
  }
  const deadlineMs = restartAtMs + max * interval * MINUTE_MS;
  const target = Math.min(restartAtMs + interval * MINUTE_MS, deadlineMs);
  const granted = target > restartAtMs && target - nowMs >= MIN_REBOOT_DELAY_MS;
  return { restartAtMs, postponeUntilMs: granted ? target : null, deadlineMs };
}

function sampleCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** The operator's text when the agent would keep it, else null. */
function operatorText(
  schema: (typeof rebootPromptTextSchemas)[keyof typeof rebootPromptTextSchemas],
  value: string | null,
): string | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface RebootPromptPreviewProps {
  settings: RebootPromptPreviewSettings;
  /** BCP 47 locale for the example times; defaults to the console's. */
  locale?: string;
  /** IANA time zone for the example times; defaults to the browser's. */
  timeZone?: string;
  /** Example "now" (Unix ms); defaults to the render time. */
  now?: number;
}

export default function RebootPromptPreview({
  settings,
  locale,
  timeZone,
  now,
}: RebootPromptPreviewProps) {
  const { t } = useTranslation("policies");
  const nowMs = now ?? Date.now();
  const times = computeRebootPreviewTimes(settings, nowMs);
  const timeFormat = new Intl.DateTimeFormat(locale ?? resolvedFormattingLocale(), {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
  const formatTime = (ms: number) => timeFormat.format(new Date(ms));

  const title =
    operatorText(rebootPromptTextSchemas.title, settings.rebootPromptTitle) ??
    t("configurationPolicies.featureTabs.patchTab.rebootPreviewDefaultTitle");
  const operatorBody = operatorText(
    rebootPromptTextSchemas.body,
    settings.rebootPromptBody,
  );
  const body = operatorBody
    ? operatorBody
        .split(REBOOT_PROMPT_COUNTDOWN_PLACEHOLDER)
        .join(sampleCountdown(times.restartAtMs - nowMs))
    : t("configurationPolicies.featureTabs.patchTab.rebootPreviewDefaultBody");
  const restartLabel =
    operatorText(rebootPromptTextSchemas.button, settings.rebootPromptButton) ??
    t("configurationPolicies.featureTabs.patchTab.rebootPreviewRestartNow");
  const hasPostpone = times.postponeUntilMs !== null;

  const defaultMarker = (
    <span
      data-testid="reboot-preview-default-marker"
      className="ml-2 rounded bg-primary-foreground/20 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
    >
      {t("configurationPolicies.featureTabs.patchTab.rebootPreviewDefaultMarker")}
    </span>
  );

  return (
    <section data-testid="reboot-prompt-preview" className="mt-4">
      <p className="text-xs font-medium text-muted-foreground">
        {t("configurationPolicies.featureTabs.patchTab.rebootPreviewHeading")}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("configurationPolicies.featureTabs.patchTab.rebootPreviewDescription")}
      </p>
      <div className="mt-2 max-w-md rounded-lg border bg-card p-4 shadow-sm">
        <p
          data-testid="reboot-preview-title"
          className="text-sm font-semibold text-foreground"
        >
          {title}
        </p>
        <p
          data-testid="reboot-preview-body"
          className="mt-1 whitespace-pre-line text-sm text-foreground"
        >
          {body}
        </p>
        <p
          data-testid="reboot-preview-consequence"
          className="mt-2 text-xs text-muted-foreground"
        >
          {t("configurationPolicies.featureTabs.patchTab.rebootPreviewConsequence", {
            time: formatTime(times.restartAtMs),
          })}
        </p>
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <span
            data-testid="reboot-preview-restart-now"
            data-default="false"
            className="inline-flex items-center rounded-md border bg-background px-3 py-1.5 text-xs font-medium text-foreground"
          >
            {restartLabel}
          </span>
          {/* The safe, default action: Postpone when the policy allows one,
              otherwise an OK that only dismisses the card (the restart still
              happens at the time above). */}
          <span
            data-testid={hasPostpone ? "reboot-preview-postpone" : "reboot-preview-ok"}
            data-default="true"
            className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
          >
            {hasPostpone
              ? t("configurationPolicies.featureTabs.patchTab.rebootPreviewPostponeUntil", {
                  time: formatTime(times.postponeUntilMs!),
                })
              : t("configurationPolicies.featureTabs.patchTab.rebootPreviewOk")}
            {defaultMarker}
          </span>
        </div>
      </div>
      {times.deadlineMs !== null && hasPostpone && (
        <p
          data-testid="reboot-preview-deadline"
          className="mt-2 text-xs text-muted-foreground"
        >
          {t("configurationPolicies.featureTabs.patchTab.rebootPreviewDeadline", {
            time: formatTime(times.deadlineMs),
          })}
        </p>
      )}
    </section>
  );
}
