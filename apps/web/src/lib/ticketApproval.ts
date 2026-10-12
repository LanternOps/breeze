import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '../stores/auth';
import { formatMinutes } from './timeFormat';
import { formatMoney } from '../components/billing/shared/format';
import { broadcastBillingChanged, onBillingChanged, onTimerChanged } from './timerActions';

/** Customer work approval (#8196): shapes of GET /tickets/:id/approval-summary. */
export type Effective<T> = { value: T; source: 'org' | 'partner' | 'default' };
export type ApprovalTrigger = 'budget' | 'after_hours';
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
export type DecisionMethod = 'verbal' | 'email' | 'signed_document' | 'other';

export interface ApprovalRequest {
  id: string;
  ticketId: string;
  orgId: string;
  trigger: ApprovalTrigger;
  origin: 'auto' | 'staff';
  status: ApprovalStatus;
  revision: number;
  enforcement: 'soft' | 'hard';
  requestedAt: string;
  expiresAt: string;
  message: string | null;
  requestedExtensionMinutes: number | null;
  requestedExtensionAmount: string | null;
  currencyCode: string | null;
  coverageStartsAt: string | null;
  coverageEndsAt: string | null;
  approverEmails: string[];
  notifyEmails: string[];
  decidedAt: string | null;
  decisionOrigin: 'customer' | 'on_behalf' | null;
  signerName: string | null;
  signerEmail: string | null;
  decisionMethod: DecisionMethod | null;
  decisionReference: string | null;
  decisionNote: string | null;
  decidedRevision: number | null;
  approvedExtensionMinutes: number | null;
  approvedExtensionAmount: string | null;
  heldEntryCount: number;
  requestedByUserName: string | null;
  decidedByUserName: string | null;
}

export interface ApprovalSummary {
  policy: {
    enabled: Effective<boolean>;
    budgetTrigger: Effective<boolean>;
    afterHoursTrigger: Effective<boolean>;
    enforcement: Effective<'soft' | 'hard'>;
    requestTtlHours: Effective<number>;
  };
  budget: { minutes: number | null; amount: string | null; currency: string | null };
  consumed: { minutes: number; amount: string | null };
  held: { minutes: number; amount: string | null; entryCount: number; unpricedEntryCount: number };
  approvedExtensions: { minutes: number; amount: string | null };
  ceiling: { minutes: number | null; amount: string | null };
  requests: ApprovalRequest[];
}

type TFn = (key: string, options?: Record<string, unknown>) => string;

/** 409 codes the approval endpoints (and the writers they gate) can answer. */
const ERROR_KEYS: Record<string, string> = {
  REQUEST_NOT_PENDING: 'requestNotPending',
  REQUEST_CHANGED: 'requestChanged',
  REQUEST_EXPIRED: 'requestExpired',
  REQUEST_ALREADY_PENDING: 'requestAlreadyPending',
  REQUEST_NOT_REASKABLE: 'requestNotReaskable',
  NOTHING_HELD: 'nothingHeld',
  APPROVALS_DISABLED: 'approvalsDisabled',
  ENTRY_NOT_RESOLVABLE: 'entryNotResolvable',
  APPROVAL_REQUEST_PENDING: 'approvalRequestPending',
  SOURCE_AWAITING_APPROVAL: 'sourceAwaitingApproval',
  APPROVAL_REQUIRED: 'approvalRequired',
};

/**
 * runAction `friendly` factory: localized copy for the approval 409 codes. The
 * server's English message is only the fallback when a code is not ours.
 * Keys are namespace-prefixed (`tickets:`), so any translator works.
 */
export function approvalFriendly(t: TFn): (code: string) => string | undefined {
  return (code) => {
    const key = ERROR_KEYS[code];
    return key ? t(/* i18n-dynamic */ `tickets:ticketApproval.errors.${key}`) : undefined;
  };
}

/** Fired after any approval mutation; the summary hook and time lists reload. */
export function notifyApprovalChanged(): void {
  broadcastBillingChanged();
}

/**
 * Loads the approval summary and keeps it fresh: reloads on ticket switch and on
 * the shared billing / timer change events. A 403/404 (org-scope caller, or the
 * feature off) resolves to `summary: null` and the cards render nothing.
 */
export function useTicketApprovalSummary(ticketId: string): {
  summary: ApprovalSummary | null;
  loading: boolean;
  reload: () => Promise<void>;
} {
  const [summary, setSummary] = useState<ApprovalSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const latest = useRef(ticketId);
  latest.current = ticketId;

  const reload = useCallback(async () => {
    const requested = ticketId;
    try {
      const res = await fetchWithAuth(`/tickets/${ticketId}/approval-summary`);
      const body = res.ok ? ((await res.json().catch(() => null)) as { data?: ApprovalSummary } | null) : null;
      if (requested !== latest.current) return; // a response for the previously selected ticket
      setSummary(body?.data ?? null);
    } catch {
      if (requested === latest.current) setSummary(null);
    } finally {
      if (requested === latest.current) setLoading(false);
    }
  }, [ticketId]);

  useEffect(() => {
    setSummary(null);
    setLoading(true);
    void reload();
    const offBilling = onBillingChanged(() => void reload());
    const offTimer = onTimerChanged(() => void reload());
    return () => { offBilling(); offTimer(); };
  }, [reload]);

  return { summary, loading, reload };
}

/** "1h + €150.00" for a request's ask; empty string when it asks for neither. */
export function formatApprovalAsk(
  r: Pick<ApprovalRequest, 'requestedExtensionMinutes' | 'requestedExtensionAmount' | 'currencyCode'>,
): string {
  const parts: string[] = [];
  if (r.requestedExtensionMinutes) parts.push(formatMinutes(r.requestedExtensionMinutes));
  if (r.requestedExtensionAmount) {
    parts.push(r.currencyCode ? formatMoney(r.requestedExtensionAmount, r.currencyCode) : r.requestedExtensionAmount);
  }
  return parts.join(' + ');
}
