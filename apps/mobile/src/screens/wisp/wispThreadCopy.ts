import type { WispCurrentActivity, WispGrantStatus } from '../../services/wisp';
import type { WispSessionStatus } from './wispThreadState';

/**
 * Wisp W06. Copy and small decisions for `WispThreadScreen`'s summary card
 * and reply box. Pure so they are node-tested; the screen only renders them.
 */

/** One line under the summary when the grant cannot act; null while active. */
export function grantBannerCopy(grant: { status: WispGrantStatus; pausedReason: string | null }): string | null {
  switch (grant.status) {
    case 'active':
      return null;
    case 'paused':
      return grant.pausedReason === 'user_paused'
        ? 'You paused Wisp. Resume to get nudges again.'
        : 'Wisp is paused. It will pick up again once the cause is fixed.';
    case 'revoked':
      return 'Wisp was turned off for this scope.';
    case 'expired':
      return 'This Wisp delegation expired. Turn Wisp on again from the web app.';
  }
}

/** The reply box creates a Wisp session under the grant, so it needs an active one. */
export function replyEnabled(grantStatus: WispGrantStatus, sessionStatus: WispSessionStatus): boolean {
  return grantStatus === 'active' && (sessionStatus === 'idle' || sessionStatus === 'error');
}

export function threadSummaryCopy(summary: string): string {
  const trimmed = summary.trim();
  return trimmed.length > 0 ? trimmed : 'Wisp is watching. Nothing to report yet.';
}

// w00 A32 spend meter — "42¢ of 200¢ today · resets in 6 h"
export type SpendMeterLevel = 'ok' | 'warn' | 'exhausted';

export function spendMeterState(
  spentCents: number | null,
  budgetCents: number | null,
): { level: SpendMeterLevel; ratio: number } | null {
  if (spentCents === null || budgetCents === null) return null;
  if (!Number.isFinite(spentCents) || !Number.isFinite(budgetCents) || budgetCents <= 0) return null;
  const ratio = Math.max(0, spentCents) / budgetCents;
  const level: SpendMeterLevel = ratio >= 1 ? 'exhausted' : ratio >= 0.8 ? 'warn' : 'ok';
  return { level, ratio };
}

export function spendMeterCopy(
  spentCents: number | null,
  budgetCents: number | null,
  budgetResetsAt: string | null,
  now: Date,
): string | null {
  if (!spendMeterState(spentCents, budgetCents)) return null;
  const base = `${Math.round(Math.max(0, spentCents as number))}¢ of ${budgetCents}¢ today`;
  if (!budgetResetsAt) return base;
  const diff = Date.parse(budgetResetsAt) - now.getTime();
  if (!Number.isFinite(diff) || diff <= 0) return base;
  return `${base} · resets in ${Math.ceil(diff / 3_600_000)} h`;
}

// w00 A31 live line
export function liveLineCopy(current: WispCurrentActivity | null): string | null {
  if (!current) return null;
  return current.orgName ? `Wisp is checking ${current.orgName}…` : 'Wisp is checking your customers…';
}

// w00 A29 pause / resume. System pauses resume through their own reconcilers.
export type PauseAction = 'pause' | 'resume';

export function pauseControlState(grant: {
  status: WispGrantStatus;
  pausedReason: string | null;
}): { action: PauseAction; label: string } | null {
  if (grant.status === 'active') return { action: 'pause', label: 'Pause Wisp' };
  if (grant.status === 'paused' && grant.pausedReason === 'user_paused') {
    return { action: 'resume', label: 'Resume Wisp' };
  }
  return null;
}

export function pauseResultCopy(action: PauseAction): string {
  return action === 'pause' ? 'Wisp paused.' : 'Wisp resumed.';
}

export function pauseFailureCopy(action: PauseAction, status: number | undefined): string {
  if (status === 403) return 'Changing Wisp needs a recent MFA sign-in.';
  if (status === 409) return action === 'resume' ? 'Only a pause you made can be resumed here.' : 'Wisp is not active.';
  if (status === 404) return 'This Wisp delegation is gone.';
  return `Could not ${action} Wisp.`;
}
