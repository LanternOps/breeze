import type { WispGrantStatus } from '../../services/wisp';
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
