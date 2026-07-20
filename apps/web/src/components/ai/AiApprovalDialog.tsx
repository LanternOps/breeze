import { useState, useEffect, useRef } from "react";
import {
  ShieldAlert,
  Check,
  X,
  Clock,
  Monitor,
  Hourglass,
  Fingerprint,
} from "lucide-react";
import { cn, widthPercentClass } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { CeremonyError, decideIntentApproval } from "@/lib/intentApprovals";
import { ActionError } from "@/lib/runAction";
import { navigateTo } from "@/lib/navigation";

// Must be <= server-side waitForApproval timeout (300s). Plan approvals use 10-min timeout.
const AUTO_DENY_MS = 5 * 60 * 1000;

/** Keys that are internal identifiers — not useful to show the user */
const HIDDEN_INPUT_KEYS = new Set(["deviceId", "orgId", "siteId", "sessionId"]);

interface ActiveSessionInfo {
  username: string;
  activityState?: string;
  idleMinutes?: number;
  sessionType: string;
}

interface DeviceContext {
  hostname: string;
  displayName?: string;
  status: string;
  lastSeenAt?: string;
  activeSessions?: ActiveSessionInfo[];
}

interface AiApprovalDialogProps {
  toolName: string;
  description: string;
  input: Record<string, unknown>;
  deviceContext?: DeviceContext;
  onApprove: () => void;
  onReject: () => void;
  /**
   * True for Tier-3 durable action-intents (spec §6.1), decided on
   * action_intents via the approvals decide API — never via the legacy
   * sessions-approve endpoint (whole-branch review CRITICAL-3). When the
   * requester is NOT an eligible approver (multi-approver org), this card
   * shows a waiting state only. When the server fanned the approval row out
   * to the requester (sole-operator branch), selfApprovalRequestId is set
   * and the card offers an inline L3 self-approve: WebAuthn ceremony
   * (Touch ID / Windows Hello) + proof POST — satisfying, not bypassing,
   * the decide handler's assurance-level >= 3 gate.
   */
  intentBacked?: boolean;
  /** The viewer's own fanned-out approval row (sole-operator case). */
  selfApprovalRequestId?: string;
  /** Called after a successful inline decide so the parent clears pendingApproval. */
  onIntentDecided?: () => void;
}

function filterInput(input: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!HIDDEN_INPUT_KEYS.has(k)) filtered[k] = v;
  }
  return filtered;
}

function formatIdle(minutes: number, justNow: string): string {
  if (minutes < 1) return justNow;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatDeviceIdle(lastSeenAt: string | undefined): string | null {
  if (!lastSeenAt) return null;
  const diffMs = Date.now() - new Date(lastSeenAt).getTime();
  if (diffMs < 60_000) return null;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function UserSessionBadge({ session }: { session: ActiveSessionInfo }) {
  const { t } = useTranslation("ai");
  const state = session.activityState ?? "unknown";
  const isActive = state === "active";
  const idleText =
    !isActive && session.idleMinutes != null && session.idleMinutes > 0
      ? t("aiApprovalDialog.idleFor", {
          duration: formatIdle(
            session.idleMinutes,
            t("aiApprovalDialog.justNow"),
          ),
        })
      : null;

  const stateColors: Record<string, string> = {
    active: "text-green-400",
    idle: "text-yellow-400",
    locked: "text-amber-400",
    away: "text-gray-400",
    disconnected: "text-gray-500",
  };

  const stateLabel =
    idleText ??
    t(/* i18n-dynamic */ `aiApprovalDialog.sessionStates.${state}`, { defaultValue: state });

  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className="text-gray-300">{session.username}</span>
      {session.sessionType !== "console" && (
        <span className="text-gray-600 uppercase text-[10px]">
          {session.sessionType}
        </span>
      )}
      <span className={stateColors[state] ?? "text-gray-500"}>
        {stateLabel}
      </span>
    </span>
  );
}

function DeviceBadge({ ctx }: { ctx: DeviceContext }) {
  const { t } = useTranslation("ai");
  const name = ctx.displayName || ctx.hostname;
  const isOnline = ctx.status === "online";
  const sessions = ctx.activeSessions ?? [];
  const deviceIdleText = !isOnline ? formatDeviceIdle(ctx.lastSeenAt) : null;

  return (
    <div className="mt-2 rounded-md bg-gray-100/60 px-2.5 py-1.5 text-xs dark:bg-gray-800/60">
      <div className="flex items-center gap-2">
        <Monitor className="h-3.5 w-3.5 text-gray-400 shrink-0" />
        <span className="font-medium text-gray-900 truncate dark:text-gray-200">
          {name}
        </span>
        <span className="text-gray-600">&middot;</span>
        <span className={isOnline ? "text-green-400" : "text-gray-500"}>
          {isOnline
            ? t("common:states.online")
            : deviceIdleText
              ? t("aiApprovalDialog.offlineFor", { duration: deviceIdleText })
              : t("common:states.offline")}
        </span>
      </div>
      {sessions.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 pl-5.5">
          {sessions.map((s, i) => (
            <UserSessionBadge key={i} session={s} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function AiApprovalDialog({
  toolName,
  description,
  input,
  deviceContext,
  onApprove,
  onReject,
  intentBacked,
  selfApprovalRequestId,
  onIntentDecided,
}: AiApprovalDialogProps) {
  const { t } = useTranslation("ai");
  const [remainingMs, setRemainingMs] = useState(AUTO_DENY_MS);
  const [intentDecideState, setIntentDecideState] = useState<
    "idle" | "deciding" | "needs_device" | "decided" | "unavailable"
  >("idle");
  const [decidedAs, setDecidedAs] = useState<"approve" | "deny" | null>(null);
  const [intentError, setIntentError] = useState<string | null>(null);

  const canSelfDecide = Boolean(intentBacked && selfApprovalRequestId);
  // The card is only passive (no time signal, nothing to act on) in the
  // four-eyes case. The sole-operator card is actionable and its intent still
  // expires after CHAT_EXPIRY_MS, so it gets the countdown too.
  const showCountdown = !intentBacked || canSelfDecide;

  // Read inside the interval callback without listing the state in the
  // effect's deps — doing so would restart the timer (and reset `start`) on
  // every decide-state transition.
  const decideStateRef = useRef(intentDecideState);
  useEffect(() => {
    decideStateRef.current = intentDecideState;
  }, [intentDecideState]);

  const handleIntentDecision = async (decision: "approve" | "deny") => {
    // Deny must stay reachable from `needs_device` (it needs no WebAuthn
    // proof — the helper skips the ceremony and the server's L3 gate only
    // guards `approved`). Only an in-flight or already-settled decision
    // blocks a new one.
    if (!selfApprovalRequestId) return;
    if (
      intentDecideState === "deciding" ||
      intentDecideState === "decided" ||
      intentDecideState === "unavailable"
    )
      return;
    if (decision === "approve" && intentDecideState === "needs_device") return;
    const priorState = intentDecideState;
    setIntentDecideState("deciding");
    setIntentError(null);
    try {
      const outcome = await decideIntentApproval(selfApprovalRequestId, decision);
      if (outcome === "needs_device") {
        setIntentDecideState("needs_device");
        return;
      }
      // Terminal: the parent normally unmounts this card via onIntentDecided,
      // but don't depend on that — settle into a decided state so the button
      // never sits frozen on "Waiting for verification…" if the clear lags.
      // Still non-idle, so the double-submit guard above holds.
      setDecidedAs(decision);
      setIntentDecideState("decided");
      onIntentDecided?.();
    } catch (err) {
      // 409 (already decided elsewhere) / 410 (expired) are TERMINAL for this
      // row. Falling back to `idle` would re-offer a button whose only possible
      // outcome is another WebAuthn prompt followed by the same rejection.
      if (err instanceof ActionError && (err.status === 409 || err.status === 410)) {
        if (err.status === 410) setIntentError(t("aiApprovalDialog.expired"));
        else setIntentError(t("aiApprovalDialog.alreadyDecided"));
        setIntentDecideState("unavailable");
        onIntentDecided?.();
        return;
      }
      // Never surface err.message: a failed WebAuthn ceremony throws a
      // browser/library-authored (untranslated) error, and server rejections
      // were already toasted by runAction. Show a localized line instead.
      // Discriminate on WHERE it failed (CeremonyError ⇒ nothing was POSTed),
      // not on the error class — @simplewebauthn wraps a user-cancelled prompt
      // in a plain `WebAuthnError extends Error`, never a DOMException.
      setIntentError(
        err instanceof CeremonyError
          ? t("aiApprovalDialog.verificationFailed")
          : t("aiApprovalDialog.decideFailed"),
      );
      // Restore the pre-attempt state: a failed deny from `needs_device` must
      // not fall back to `idle`, which would re-offer an Approve button that
      // cannot succeed (no registered authenticator).
      setIntentDecideState(priorState === "needs_device" ? "needs_device" : "idle");
    }
  };

  // Four-eyes intent-backed cards are passive — somebody else decides them on
  // the /approvals surface, so there is no deadline worth showing here. The
  // sole-operator card DOES get the countdown: the underlying intent expires
  // after CHAT_EXPIRY_MS and without a timer the user only learns that by
  // completing a Touch ID prompt and collecting a 410.
  //
  // onReject() stays suppressed for EVERY intent-backed card at zero: the
  // client-side auto-deny is a legacy-Tier-2 mechanism and firing it against a
  // durable intent would just POST a self-approval-shaped request the backend
  // correctly refuses. The self-approve card instead settles into the same
  // terminal "expired" presentation a server 410 produces.
  useEffect(() => {
    if (intentBacked && !canSelfDecide) return;
    const start = Date.now();
    const interval = setInterval(() => {
      const remaining = AUTO_DENY_MS - (Date.now() - start);
      if (remaining <= 0) {
        clearInterval(interval);
        setRemainingMs(0);
        if (!intentBacked) {
          onReject();
          return;
        }
        // Don't clobber an in-flight ceremony or an already-settled row — the
        // server's own 409/410 is authoritative for those.
        if (
          decideStateRef.current === "idle" ||
          decideStateRef.current === "needs_device"
        ) {
          setIntentError(t("aiApprovalDialog.expired"));
          setIntentDecideState("unavailable");
        }
      } else {
        setRemainingMs(remaining);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [onReject, intentBacked, canSelfDecide, t]);

  const minutes = Math.floor(remainingMs / 60000);
  const seconds = Math.floor((remainingMs % 60000) / 1000);
  const countdown = `${minutes}:${seconds.toString().padStart(2, "0")}`;
  const progressPct = (remainingMs / AUTO_DENY_MS) * 100;

  const visibleInput = filterInput(input);
  const hasVisibleInput = Object.keys(visibleInput).length > 0;

  const isUrgent = showCountdown && remainingMs < 30_000;

  return (
    <div
      role="alertdialog"
      aria-label={t("aiApprovalDialog.ariaLabel", { toolName })}
      className="my-2 rounded-lg border border-amber-600/50 bg-amber-100/30 p-3 dark:bg-amber-950/30"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Four-eyes intents wait on somebody else (hourglass). When the
              viewer is the sole eligible approver the card is actionable, so
              it must not read "waiting" above the user's own buttons. */}
          {intentBacked && !canSelfDecide ? (
            <Hourglass className="h-4 w-4 text-amber-400" />
          ) : (
            <ShieldAlert className="h-4 w-4 text-amber-400" />
          )}
          <span className="text-sm font-medium text-amber-700 dark:text-amber-300">
            {canSelfDecide
              ? t("aiApprovalDialog.selfApproveTitle")
              : intentBacked
                ? t("aiApprovalDialog.pendingApproverTitle")
                : t("aiApprovalDialog.title")}
          </span>
        </div>
        {showCountdown && (
          <div
            className="flex items-center gap-1.5 text-xs text-gray-500"
            role="timer"
            aria-label={t("aiApprovalDialog.timeRemaining", { minutes, seconds })}
          >
            <Clock className="h-3 w-3" />
            <span>{countdown}</span>
          </div>
        )}
      </div>
      {isUrgent && (
        <span className="sr-only" role="alert">
          {t("aiApprovalDialog.urgentWarning")}
        </span>
      )}

      {/* Countdown progress bar */}
      {showCountdown && (
        <div
          className="mt-2 h-0.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800"
          role="progressbar"
          aria-valuenow={Math.round(progressPct)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t("aiApprovalDialog.progressLabel")}
        >
          <div
            className={cn(
              "h-full rounded-full bg-amber-500/60 transition-all duration-1000 ease-linear",
              widthPercentClass(progressPct),
            )}
          />
        </div>
      )}

      <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
        {description}
      </p>

      {intentBacked && !canSelfDecide && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t("aiApprovalDialog.pendingApproverDescription")}
        </p>
      )}

      {deviceContext && <DeviceBadge ctx={deviceContext} />}

      {hasVisibleInput && (
        <details className="mt-2 group">
          <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-400 select-none">
            {t("aiApprovalDialog.showParameters")}
          </summary>
          <pre className="mt-1 max-h-24 overflow-auto rounded bg-gray-100 px-3 py-2 text-xs text-gray-500 dark:bg-gray-900 dark:text-gray-400">
            {JSON.stringify(visibleInput, null, 2)}
          </pre>
        </details>
      )}

      {/* Legacy (non-intent) Tier-2 path — unchanged. */}
      {!intentBacked && (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={onApprove}
            className="flex items-center gap-1.5 rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-green-500"
          >
            <Check className="h-3.5 w-3.5" />
            {t("aiApprovalDialog.approve")}
          </button>
          <button
            type="button"
            onClick={onReject}
            className="flex items-center gap-1.5 rounded-md bg-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
          >
            <X className="h-3.5 w-3.5" />
            {t("aiApprovalDialog.reject")}
          </button>
        </div>
      )}

      {/* Sole-operator inline self-approve: the server fanned the approval
          row out to the requester, so deciding it here is legitimate — the
          approve path attaches a WebAuthn L3 proof (Touch ID / Windows
          Hello), which is exactly what the decide handler's self-approve
          gate requires. Multi-approver intents never get these buttons
          (selfApprovalRequestId is undefined — four-eyes preserved).

          Hidden once the row is settled (`decided`) or terminally unusable
          (`unavailable` — a 409/410 from the server), so a doomed retry is
          never offered.

          Gated on "not yet decided" rather than on idle|deciding: in the
          `needs_device` state only APPROVE is impossible (no registered
          authenticator ⇒ no L3 proof). Deny needs no proof at all, so it must
          survive — otherwise the user's only exits from `needs_device` are
          registering an authenticator or waiting out the 5-minute expiry. */}
      {canSelfDecide &&
        intentDecideState !== "decided" &&
        intentDecideState !== "unavailable" && (
        <div className="mt-3 flex gap-2">
          {intentDecideState !== "needs_device" && (
            <button
              type="button"
              disabled={intentDecideState === "deciding"}
              onClick={() => handleIntentDecision("approve")}
              className="flex items-center gap-1.5 rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-green-500 disabled:opacity-50"
            >
              <Fingerprint className="h-3.5 w-3.5" />
              {intentDecideState === "deciding"
                ? t("aiApprovalDialog.verifying")
                : t("aiApprovalDialog.approveVerify")}
            </button>
          )}
          <button
            type="button"
            disabled={intentDecideState === "deciding"}
            onClick={() => handleIntentDecision("deny")}
            className="flex items-center gap-1.5 rounded-md bg-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-300 disabled:opacity-50 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
          >
            <X className="h-3.5 w-3.5" />
            {t("aiApprovalDialog.deny")}
          </button>
        </div>
      )}

      {/* Terminal confirmation — the parent normally unmounts the card here,
          but if that clear lags the user sees a settled result rather than a
          permanently disabled "Waiting for verification…" button. */}
      {canSelfDecide && intentDecideState === "decided" && (
        <p
          role="status"
          className="mt-3 flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300"
        >
          {decidedAs === "deny" ? (
            <X className="h-3.5 w-3.5 text-gray-500" />
          ) : (
            <Check className="h-3.5 w-3.5 text-green-500" />
          )}
          {decidedAs === "deny"
            ? t("aiApprovalDialog.deniedToast")
            : t("aiApprovalDialog.approvedToast")}
        </p>
      )}

      {canSelfDecide && intentError && (
        <p role="alert" className="mt-2 text-xs text-red-500">
          {intentError}
        </p>
      )}

      {canSelfDecide && intentDecideState === "needs_device" && (
        <div className="mt-3 rounded-md bg-gray-100/60 px-3 py-2 text-xs text-gray-600 dark:bg-gray-800/60 dark:text-gray-300">
          {t("aiApprovalDialog.noApproverDevice")}{" "}
          <button
            type="button"
            onClick={() => navigateTo("/settings/profile")}
            className="font-medium text-blue-500 underline hover:text-blue-400"
          >
            {t("aiApprovalDialog.registerDevice")}
          </button>
        </div>
      )}
    </div>
  );
}
