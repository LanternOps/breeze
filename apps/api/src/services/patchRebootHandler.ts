/**
 * Patch Reboot Handler
 *
 * Evaluates reboot policies after patch installation and dispatches
 * reboot commands via the existing command queue infrastructure.
 */

import { queueCommandForExecution } from './commandQueue';
import { checkDeviceMaintenanceWindow, resolvePatchConfigForDevice } from './featureConfigResolver';
import { captureException } from './sentry';
import { rebootPromptTextSchemas } from '@breeze/shared/validators';

// ============================================
// Reboot delay resolution (issue #3197)
// ============================================

/**
 * Fallback delay when a device resolves to no effective patch policy.
 *
 * This is the single source of truth for the reboot grace across BOTH reboot
 * paths. Before #3197 the patch path hardcoded 5 and the maintenance-window
 * worker hardcoded its own 15, and they disagreed silently: at 5 minutes the
 * agent's 60/15/5 warning ladder (gated on strict `>`) fired nothing at all, so
 * a patched workstation rebooted with no notice, while the maintenance path
 * happened to warn. Operators configure the real value on the patch
 * Configuration Policy (`config_policy_patch_settings.reboot_delay_minutes`);
 * this constant only covers a device with no policy at all.
 */
export const DEFAULT_REBOOT_DELAY_MINUTES = 15;

/** Inclusive bounds, mirroring the DB CHECK and the zod validator. */
export const MIN_REBOOT_DELAY_MINUTES = 1;
export const MAX_REBOOT_DELAY_MINUTES = 1440;

/**
 * Coerces a policy value into a usable delay. The column is NOT NULL with a
 * CHECK, so this is defense-in-depth against a null from an outer join, a
 * pre-migration row, or a hand-edited database — not the primary validation.
 */
export function clampRebootDelayMinutes(value: unknown): number {
  // Deliberately NOT a bare `Number(value)`: Number(null), Number('') and
  // Number([]) are all 0, which would clamp to MIN — a one-minute warning.
  // Unusable input has to mean "use the safe default", never "give the user the
  // shortest possible notice".
  let parsed: number;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    parsed = Number(value);
  } else {
    return DEFAULT_REBOOT_DELAY_MINUTES;
  }
  if (!Number.isFinite(parsed)) return DEFAULT_REBOOT_DELAY_MINUTES;
  const rounded = Math.round(parsed);
  if (rounded < MIN_REBOOT_DELAY_MINUTES) return MIN_REBOOT_DELAY_MINUTES;
  if (rounded > MAX_REBOOT_DELAY_MINUTES) return MAX_REBOOT_DELAY_MINUTES;
  return rounded;
}

/** The patch settings row `resolvePatchConfigForDevice` hands back, or null. */
type ResolvedPatchSettings = Awaited<ReturnType<typeof resolvePatchConfigForDevice>>;

/**
 * Derives the warning delay from an already-resolved patch settings row.
 * Split out from the async resolver so one policy walk can answer both the
 * delay and the deferral question (see `resolveRebootPlan`).
 */
export function rebootDelayMinutesFrom(
  settings: ResolvedPatchSettings,
  deviceId: string
): number {
  if (!settings) return DEFAULT_REBOOT_DELAY_MINUTES;
  const stored = settings.rebootDelayMinutes;
  const delay = clampRebootDelayMinutes(stored);
  // The column is NOT NULL with CHECK (reboot_delay_minutes BETWEEN 1 AND 1440)
  // and every write path is zod-validated, so a value that needed clamping got
  // past all of that — a CHECK bypass, a hand-edited row, or a NULL leaking
  // through a join. Clamping keeps the reboot warned, but the anomaly must not
  // be the quiet branch: it is more likely to indicate a bug than the throwing
  // path in resolveRebootPlan, which is already reported.
  if (stored !== delay) {
    console.warn(
      `[PatchReboot] device ${deviceId} had an out-of-range stored reboot delay ${String(stored)}; using ${delay}m`
    );
    captureException(
      new Error(
        `Out-of-range config_policy_patch_settings.reboot_delay_minutes ${String(stored)} for device ${deviceId} (clamped to ${delay})`
      )
    );
  }
  return delay;
}

// ============================================
// End-user reboot deferral (issue #3207)
// ============================================

/**
 * The deferral budget shipped on the `schedule_reboot` payload. Fixed for the
 * life of one scheduled reboot: an admin editing the policy mid-countdown must
 * not shrink a user's remaining postponements out from under them, which is why
 * this rides the command payload rather than the heartbeat config block.
 */
export interface RebootDeferralSettings {
  allowDeferral: boolean;
  maxDeferrals: number;
  deferralMinutes: number;
}

/**
 * The safe value. Every failure path resolves to this — never to "let the user
 * postpone indefinitely because we could not read the policy".
 */
export const DEFERRAL_OFF: RebootDeferralSettings = Object.freeze({
  allowDeferral: false,
  maxDeferrals: 0,
  deferralMinutes: 0,
});

/** Inclusive bounds, mirroring the DB CHECKs and the zod validator. */
export const MAX_REBOOT_DEFERRALS = 10;
export const MIN_REBOOT_DEFERRAL_MINUTES = 5;
export const MAX_REBOOT_DEFERRAL_MINUTES = 1440;
/** Mirrors the `reboot_deferral_minutes` column default. */
export const DEFAULT_REBOOT_DEFERRAL_MINUTES = 60;

/**
 * Same discipline as clampRebootDelayMinutes: unusable input means "use the
 * fallback", never "coerce to a bound". `Number(null)`, `Number('')` and
 * `Number([])` are all 0, and silently reading 0 as a bound would be wrong in
 * both directions here — 0 deferrals is a real value, and 0 minutes is not.
 */
function clampDeferralInt(value: unknown, min: number, max: number, fallback: number): number {
  let parsed: number;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    parsed = Number(value);
  } else {
    return fallback;
  }
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  if (rounded < min) return fallback;
  if (rounded > max) return max;
  return rounded;
}

/**
 * Derives the deferral budget from an already-resolved patch settings row.
 *
 * Fail-safe in both directions: a policy that has not opted in, a row that
 * cannot be read, or a nonsensical count all resolve to OFF. An over-large
 * count or window is clamped to the policy ceiling rather than rejected, so a
 * hand-edited row degrades to "the most we would ever allow", not "unbounded".
 */
export function rebootDeferralSettingsFrom(
  settings: ResolvedPatchSettings
): RebootDeferralSettings {
  if (!settings || settings.rebootAllowDeferral !== true) return DEFERRAL_OFF;
  // A count we cannot make sense of falls back to 0, i.e. deferral off.
  const maxDeferrals = clampDeferralInt(settings.rebootMaxDeferrals, 1, MAX_REBOOT_DEFERRALS, 0);
  if (maxDeferrals === 0) return DEFERRAL_OFF;
  const deferralMinutes = clampDeferralInt(
    settings.rebootDeferralMinutes,
    MIN_REBOOT_DEFERRAL_MINUTES,
    MAX_REBOOT_DEFERRAL_MINUTES,
    DEFAULT_REBOOT_DEFERRAL_MINUTES
  );
  return { allowDeferral: true, maxDeferrals, deferralMinutes };
}

/**
 * The hard stop the agent clamps every deferral against (#3253 — `deadline` has
 * been stored and reported by the agent but never enforced; the deferral state
 * machine in W2 is what gives it a job). With deferral off it is exactly the
 * scheduled reboot time, so an old or non-deferring agent — which already
 * defaults `deadline` to `now + delay` — sees a value that changes nothing.
 *
 * `windowEndsAt` is the maintenance-window close: a reboot issued inside a
 * window may not be postponed past the end of that window. It never pulls the
 * deadline in front of the scheduled reboot itself, which would otherwise
 * describe a reboot that is late before it is even due.
 */
export function computeRebootDeadline(
  now: Date,
  delayMinutes: number,
  deferral: RebootDeferralSettings,
  windowEndsAt?: Date | null
): Date {
  const scheduledAt = now.getTime() + delayMinutes * 60_000;
  const budget = deferral.allowDeferral ? deferral.maxDeferrals * deferral.deferralMinutes : 0;
  const derived = scheduledAt + budget * 60_000;
  if (windowEndsAt && windowEndsAt.getTime() < derived) {
    return new Date(Math.max(windowEndsAt.getTime(), scheduledAt));
  }
  return new Date(derived);
}

// ============================================
// Custom restart-prompt text (issue #8030)
// ============================================

/**
 * Operator-supplied replacement text for the end-user restart prompt. Every
 * field is optional and independent: an absent field means the agent keeps its
 * built-in English copy for that part of the prompt. Rides the schedule_reboot
 * payload for the same reason the deferral budget does — it is fixed for the
 * life of one scheduled reboot.
 */
export interface RebootPromptText {
  title?: string;
  body?: string;
  button?: string;
}

const PROMPT_TEXT_FIELDS = [
  ['title', 'rebootPromptTitle'],
  ['body', 'rebootPromptBody'],
  ['button', 'rebootPromptButton'],
] as const;

/**
 * Derives the prompt text from an already-resolved patch settings row,
 * re-validating each stored value with the same schema every write path uses.
 * A value that fails (a hand-edited row, a pre-validator write) is dropped —
 * that field falls back to the built-in text — and reported, because shipping
 * unvalidated text to an end user's screen is the outcome to avoid, and a
 * silently English prompt is not a reason to fail the reboot.
 */
export function rebootPromptTextFrom(
  settings: ResolvedPatchSettings,
  deviceId: string
): RebootPromptText {
  if (!settings) return {};
  const text: RebootPromptText = {};
  for (const [field, column] of PROMPT_TEXT_FIELDS) {
    const stored = (settings as Record<string, unknown>)[column];
    const parsed = rebootPromptTextSchemas[field].safeParse(stored);
    if (!parsed.success) {
      console.warn(
        `[PatchReboot] device ${deviceId} has an invalid stored ${column}; using the built-in text`
      );
      captureException(
        new Error(`Invalid config_policy_patch_settings.${column} for device ${deviceId}; dropped`)
      );
      continue;
    }
    if (parsed.data !== null) text[field] = parsed.data;
  }
  return text;
}

/**
 * The prompt keys for the schedule_reboot payload. Only SET fields are emitted:
 * an absent key is what tells the agent to keep its built-in text, and it is
 * also what an agent predating #8030 sees — so an unset policy produces a
 * payload byte-identical to before.
 */
export function rebootPromptPayload(text: RebootPromptText): Record<string, string> {
  const payload: Record<string, string> = {};
  if (text.title) payload.promptTitle = text.title;
  if (text.body) payload.promptBody = text.body;
  if (text.button) payload.promptButton = text.button;
  return payload;
}

/** Everything one policy walk answers for a single reboot dispatch. */
export interface ResolvedRebootPlan {
  delayMinutes: number;
  deferral: RebootDeferralSettings;
  promptText: RebootPromptText;
}

/**
 * Resolves how long the logged-in user is warned before this device reboots and
 * how many times they may postpone it, from the device's effective patch
 * Configuration Policy — in a single walk of the assignment hierarchy.
 *
 * `resolvePatchConfigForDevice` already walks that hierarchy with partner-wide
 * visibility and returns the whole row, so both settings ride an existing
 * partner-linkable surface rather than a new table.
 *
 * A resolution failure falls back to the safe values rather than propagating.
 * That is a deliberate trade, not a swallowed error: this runs after patches
 * have already been installed, so throwing would strand the device with an
 * unfinalized update and no reboot, which is worse than rebooting on the
 * default 15-minute warning with deferral off. The failure is reported to
 * Sentry so it cannot hide.
 */
export async function resolveRebootPlan(
  deviceId: string,
  deps = { resolvePatchConfigForDevice }
): Promise<ResolvedRebootPlan> {
  try {
    const settings = await deps.resolvePatchConfigForDevice(deviceId);
    return {
      delayMinutes: rebootDelayMinutesFrom(settings, deviceId),
      deferral: rebootDeferralSettingsFrom(settings),
      promptText: rebootPromptTextFrom(settings, deviceId),
    };
  } catch (err) {
    console.warn(
      `[PatchReboot] failed to resolve reboot policy for device ${deviceId}, falling back to ${DEFAULT_REBOOT_DELAY_MINUTES}m with deferral off:`,
      err
    );
    captureException(err instanceof Error ? err : new Error(String(err)));
    return { delayMinutes: DEFAULT_REBOOT_DELAY_MINUTES, deferral: DEFERRAL_OFF, promptText: {} };
  }
}

export async function resolveRebootDelayMinutes(
  deviceId: string,
  deps = { resolvePatchConfigForDevice }
): Promise<number> {
  return (await resolveRebootPlan(deviceId, deps)).delayMinutes;
}

export async function resolveRebootDeferralSettings(
  deviceId: string,
  deps = { resolvePatchConfigForDevice }
): Promise<RebootDeferralSettings> {
  return (await resolveRebootPlan(deviceId, deps)).deferral;
}

// ============================================
// Types
// ============================================

export interface RebootEvaluation {
  shouldReboot: boolean;
  reason: string;
  deferred: boolean;
  /**
   * Close of the maintenance window this decision was made inside, or null for
   * every other policy (#3207). This is the ONLY place the post-patch reboot
   * path learns when the window shuts, so it is a required field rather than an
   * optional one: a future branch that forgets it fails to compile instead of
   * silently uncapping the deferral deadline.
   */
  windowEndsAt: Date | null;
}

export interface RebootResult {
  success: boolean;
  error?: string;
  /** The delay actually dispatched, so the caller can record it on the job. */
  delayMinutes?: number;
}

export type RebootPolicy = 'never' | 'if_required' | 'always' | 'maintenance_window';

// ============================================
// Policy evaluation
// ============================================

export async function evaluateRebootPolicy(
  deviceId: string,
  rebootPolicy: string,
  anyPatchRequiresReboot: boolean
): Promise<RebootEvaluation> {
  switch (rebootPolicy) {
    case 'never':
      return { shouldReboot: false, reason: 'Reboot policy is never', deferred: false, windowEndsAt: null };

    case 'if_required':
      if (anyPatchRequiresReboot) {
        return { shouldReboot: true, reason: 'Installed patch requires reboot', deferred: false, windowEndsAt: null };
      }
      return { shouldReboot: false, reason: 'No installed patch requires reboot', deferred: false, windowEndsAt: null };

    case 'always':
      return { shouldReboot: true, reason: 'Reboot policy is always', deferred: false, windowEndsAt: null };

    case 'maintenance_window': {
      const maintenanceStatus = await checkDeviceMaintenanceWindow(deviceId);
      if (maintenanceStatus.active) {
        return {
          shouldReboot: true,
          reason: 'In active maintenance window',
          deferred: false,
          windowEndsAt: maintenanceStatus.windowEndsAt,
        };
      }
      return {
        shouldReboot: false,
        reason: 'Outside maintenance window — reboot deferred',
        deferred: true,
        windowEndsAt: null,
      };
    }

    default:
      // Unknown policy — treat as if_required for safety
      if (anyPatchRequiresReboot) {
        return { shouldReboot: true, reason: `Unknown reboot policy "${rebootPolicy}", defaulting to if_required`, deferred: false, windowEndsAt: null };
      }
      return { shouldReboot: false, reason: `Unknown reboot policy "${rebootPolicy}", no reboot needed`, deferred: false, windowEndsAt: null };
  }
}

// ============================================
// Reboot execution
// ============================================

export async function executeReboot(
  deviceId: string,
  reason: string,
  options: {
    /**
     * Explicit delay in minutes. Omit to resolve it from the device's effective
     * patch policy — which is what callers should normally do. There is no
     * hardcoded default any more: the old `delayMinutes = 5` was #3197, because
     * 5 minutes reached none of the agent's warning thresholds.
     */
    delayMinutes?: number;
    /**
     * Explicit deferral budget (#3207). Omit to resolve it from the device's
     * effective patch policy. Supplying it alongside `delayMinutes` is the only
     * way to dispatch without a policy lookup at all.
     */
    deferral?: RebootDeferralSettings;
    /**
     * Explicit restart-prompt text (#8030). Omit to resolve it from the device's
     * effective patch policy. The policy walk is skipped only when delay,
     * deferral AND prompt text are all supplied.
     */
    promptText?: RebootPromptText;
    /**
     * Close of the maintenance window this reboot was issued inside, if any.
     * Caps the deadline so a user cannot postpone past the end of the window.
     */
    windowEndsAt?: Date | null;
    /**
     * Owning org, for the cross-tenant guard in queueCommandForExecution. This
     * path runs from a BullMQ worker under a system DB context (RLS off), so
     * without it a mismatched device id would receive a reboot.
     */
    expectedOrgId?: string;
  } = {}
): Promise<RebootResult> {
  const explicitDelay =
    options.delayMinutes !== undefined ? clampRebootDelayMinutes(options.delayMinutes) : undefined;
  // One policy walk answers every question; skipped entirely only when the
  // caller has already supplied all of them.
  const plan =
    explicitDelay !== undefined && options.deferral !== undefined && options.promptText !== undefined
      ? null
      : await resolveRebootPlan(deviceId);
  const delayMinutes = explicitDelay ?? plan!.delayMinutes;
  const deferral = options.deferral ?? plan!.deferral;
  const promptText = options.promptText ?? plan!.promptText;
  const deadline = computeRebootDeadline(new Date(), delayMinutes, deferral, options.windowEndsAt);

  const result = await queueCommandForExecution(
    deviceId,
    'schedule_reboot',
    {
      delayMinutes,
      reason,
      source: 'patch_job',
      // #3207. Additive keys: an agent that predates them reads only the three
      // above, and `allowDeferral` absent must never mean "enabled".
      deadline: deadline.toISOString(),
      allowDeferral: deferral.allowDeferral,
      maxDeferrals: deferral.maxDeferrals,
      deferralMinutes: deferral.deferralMinutes,
      // #8030. Additive and only present when set; see rebootPromptPayload.
      ...rebootPromptPayload(promptText),
    },
    { expectedOrgId: options.expectedOrgId }
  );

  if (result.error) {
    return { success: false, error: result.error };
  }

  return { success: true, delayMinutes };
}
