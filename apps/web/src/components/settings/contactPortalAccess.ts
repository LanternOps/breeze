import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import {
  CONTACT_PORTAL_INVITE_OUTCOMES,
  type ContactPortalInviteOutcome,
  type ContactPortalInviteResponse,
  type ContactPortalInviteResult,
} from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction } from '@/lib/runAction';
import { showToast } from '../shared/Toast';

/**
 * Portal access for the Contacts tab (portal registration W01, #11378).
 *
 * Status is read from the existing partner/system-gated
 * `GET /orgs/organizations/:id/portal-users` and joined to contacts here, so
 * portal data never rides on the contacts list (which organization-scope
 * tokens can read).
 */

export type ContactPortalStatus = 'none' | 'invited' | 'active' | 'disabled' | 'requested';

export type PortalLogin = {
  id: string;
  email: string;
  contactId: string | null;
  authMethod: string;
  browserAccess: 'granted' | 'none';
  effectiveStatus: 'active' | 'disabled' | 'pending_setup';
};

type ContactRef = { id: string; email: string | null };
type Derived = { status: ContactPortalStatus; portalUserId: string | null };

const NONE: Derived = { status: 'none', portalUserId: null };

const STATUS_BY_EFFECTIVE: Record<PortalLogin['effectiveStatus'], ContactPortalStatus> = {
  active: 'active',
  pending_setup: 'invited',
  disabled: 'disabled',
};

// active > pending > disabled
const PRIORITY: Record<PortalLogin['effectiveStatus'], number> = {
  active: 3,
  pending_setup: 2,
  disabled: 1,
};

function best(logins: PortalLogin[]): PortalLogin | null {
  let top: PortalLogin | null = null;
  for (const l of logins) {
    if (!top || PRIORITY[l.effectiveStatus] > PRIORITY[top.effectiveStatus]) top = l;
  }
  return top;
}

/**
 * Only logins with browser access (`browserAccess === 'granted'`) count: an
 * add-in-only login gives the person add-in access, not browser access, so the
 * contact reads "No access". A contact with no counted login whose email has a
 * pending access request reads "Requested".
 * A login bound to the contact wins; otherwise an unbound login with the same
 * email (what the API reports as `already_has_access` for it) is used.
 */
export function derivePortalStatus(
  contact: ContactRef,
  logins: PortalLogin[],
  pendingEmails: ReadonlySet<string> = new Set(),
): Derived {
  const withBrowser = logins.filter((l) => l.browserAccess === 'granted');
  const bound = best(withBrowser.filter((l) => l.contactId === contact.id));
  let chosen = bound;
  if (!chosen && contact.email) {
    const wanted = contact.email.trim().toLowerCase();
    chosen = best(
      withBrowser.filter((l) => l.contactId === null && l.email.trim().toLowerCase() === wanted),
    );
  }
  if (!chosen) {
    if (contact.email && pendingEmails.has(contact.email.trim().toLowerCase())) {
      return { status: 'requested', portalUserId: null };
    }
    return NONE;
  }
  return { status: STATUS_BY_EFFECTIVE[chosen.effectiveStatus], portalUserId: chosen.id };
}

const base = (orgId: string) => `/orgs/organizations/${orgId}/portal-users`;
// An org holds at most 200 pending requests (the API cap), and the list route
// takes up to 200 per page, so one page covers every pending email.
const requestsUrl = (orgId: string) => `/orgs/organizations/${orgId}/portal-access-requests?status=pending&limit=200`;

async function fetchPendingEmails(orgId: string): Promise<Set<string>> {
  try {
    const res = await fetchWithAuth(requestsUrl(orgId));
    if (!res.ok) {
      console.warn('[useContactPortalAccess] access requests load failed', res.status);
      return new Set();
    }
    const body = (await res.json()) as { data?: Array<{ email?: string }> };
    return new Set(
      (body.data ?? []).flatMap((r) => (r.email ? [r.email.trim().toLowerCase()] : [])),
    );
  } catch (err) {
    console.warn('[useContactPortalAccess] access requests load failed', err);
    return new Set();
  }
}

export function useContactPortalAccess(orgId: string): {
  available: boolean;
  statusFor: (c: ContactRef) => Derived;
  reload: () => Promise<void>;
} {
  const [available, setAvailable] = useState(false);
  const [logins, setLogins] = useState<PortalLogin[]>([]);
  const [pendingEmails, setPendingEmails] = useState<ReadonlySet<string>>(new Set());
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = (seq.current += 1);
    try {
      const [res, pending] = await Promise.all([fetchWithAuth(base(orgId)), fetchPendingEmails(orgId)]);
      if (mine !== seq.current) return;
      if (res.status === 401) {
        void navigateTo('/login', { replace: true });
        setAvailable(false);
        return;
      }
      // Organization-scope callers are refused here by design: they simply do
      // not get the portal UI, and there is nothing to report.
      if (res.status === 403 || res.status === 404) {
        setAvailable(false);
        setLogins([]);
        setPendingEmails(new Set());
        return;
      }
      if (!res.ok) throw new Error(`portal users load failed: ${res.status}`);
      const body = (await res.json()) as { data?: PortalLogin[] };
      if (mine !== seq.current) return;
      setLogins(body.data ?? []);
      setPendingEmails(pending);
      setAvailable(true);
    } catch (err) {
      if (mine !== seq.current) return;
      console.warn('[useContactPortalAccess] portal users load failed', err);
      setAvailable(false);
    }
  }, [orgId]);

  useEffect(() => {
    setAvailable(false);
    setLogins([]);
    setPendingEmails(new Set());
    void reload();
    return () => { seq.current += 1; };
  }, [reload]);

  const statusFor = useCallback((c: ContactRef) => derivePortalStatus(c, logins, pendingEmails), [logins, pendingEmails]);
  return { available, statusFor, reload };
}

const unauthorized = () => { void navigateTo('/login', { replace: true }); };

export async function giveContactPortalAccess(
  orgId: string,
  contact: { id: string; email: string; name: string | null },
  t: TFunction,
  opts: { resend?: boolean } = {},
): Promise<void> {
  const result = await runAction<{ emailSent?: boolean }>({
    request: () => fetchWithAuth(`${base(orgId)}/invite`, {
      method: 'POST',
      body: JSON.stringify({
        email: contact.email,
        ...(contact.name ? { name: contact.name } : {}),
        contactId: contact.id,
      }),
    }),
    errorFallback: t('settings:contactsCard.portal.errors.invite'),
    onUnauthorized: unauthorized,
  });
  if (result?.emailSent === false) {
    showToast({
      type: 'warning',
      message: opts.resend
        ? t('settings:contactsCard.portal.toasts.resendEmailFailed')
        : t('settings:contactsCard.portal.toasts.inviteEmailFailed'),
    });
  } else {
    showToast({ type: 'success', message: t('settings:contactsCard.portal.toasts.invited') });
  }
}

// Static map (no template keys) so keyUsage.test.ts can see every key.
const OUTCOME_LABEL_KEYS: Record<ContactPortalInviteOutcome, string> = {
  invited: 'settings:contactsCard.portal.outcomes.invited',
  already_has_access: 'settings:contactsCard.portal.outcomes.already_has_access',
  no_email: 'settings:contactsCard.portal.outcomes.no_email',
  email_bound_to_other_contact: 'settings:contactsCard.portal.outcomes.email_bound_to_other_contact',
  duplicate_email_in_batch: 'settings:contactsCard.portal.outcomes.duplicate_email_in_batch',
};

export async function giveContactsPortalAccess(
  orgId: string,
  contactIds: string[],
  t: TFunction,
): Promise<ContactPortalInviteResult[]> {
  const body = await runAction<ContactPortalInviteResponse>({
    request: () => fetchWithAuth(`${base(orgId)}/invite-contacts`, {
      method: 'POST',
      body: JSON.stringify({ contactIds }),
    }),
    errorFallback: t('settings:contactsCard.portal.errors.bulkInvite'),
    onUnauthorized: unauthorized,
  });
  const { results, counts } = body.data;
  const emailsNotSent = results.filter((r) => r.outcome === 'invited' && !r.emailSent).length;
  const details = [
    ...CONTACT_PORTAL_INVITE_OUTCOMES
      .filter((o) => counts[o] > 0)
      .map((o) => t(/* i18n-dynamic */ OUTCOME_LABEL_KEYS[o], { count: counts[o] })),
    ...(emailsNotSent > 0
      ? [t('settings:contactsCard.portal.outcomes.emailNotSent', { count: emailsNotSent })]
      : []),
  ].join(' · ');
  const clean = CONTACT_PORTAL_INVITE_OUTCOMES.every((o) => o === 'invited' || counts[o] === 0)
    && emailsNotSent === 0;
  showToast({
    type: clean ? 'success' : 'warning',
    message: t('settings:contactsCard.portal.toasts.bulkSummary', { details }),
  });
  return results;
}
