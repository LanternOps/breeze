import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

// #4013. TicketingSettingsTabs.test.tsx mocks `lib/authScope` with a partner
// scope that is already known on the first render — which is exactly the state a
// cold page load does NOT start in. Access tokens are deliberately never
// persisted (`partialize` in stores/auth.ts keeps only `user` +
// `isAuthenticated`), so at first paint the store is empty and EVERY user
// decodes as `scope: null`.
//
// This suite therefore mocks neither `authScope` nor the auth store: it drives
// the real `useJwtClaims` against the real store so the token genuinely arrives
// after mount, which is the only way to pin the bug. The gate used to be
// `useMemo(() => getJwtClaims().scope === 'partner', [])`, whose empty dep array
// froze the empty-store answer for the life of the mount — so Intake Forms,
// Inbound Email and Canned Responses stayed hidden from partner users forever,
// on precisely the surface the permanent `/settings/ticketing` 301 and the M365
// consent return both land on.

const { grantedActions } = vi.hoisted(() => ({ grantedActions: new Set<string>() }));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({
    can: (resource: string, action: string) => grantedActions.has(`${resource}:${action}`),
  }),
}));

// Stub child components — this suite is about the scope gate, not the cards.
vi.mock('./TicketCategoriesPage', () => ({ default: () => <div data-testid="stub-ticket-categories-page" /> }));
vi.mock('./BillablesExportCard', () => ({ default: () => <div data-testid="stub-billables-export-card" /> }));
vi.mock('./TicketStatusesTab', () => ({ default: () => <div data-testid="stub-ticket-statuses-tab" /> }));
vi.mock('./TicketPrioritiesTab', () => ({ default: () => <div data-testid="stub-ticket-priorities-tab" /> }));
vi.mock('./InboundEmailCard', () => ({ default: () => <div data-testid="stub-inbound-email-card" /> }));
vi.mock('./M365MailboxCard', () => ({ default: () => <div data-testid="m365-mailbox-card" /> }));
vi.mock('./CannedResponsesCard', () => ({ default: () => <div data-testid="stub-canned-responses-card" /> }));
vi.mock('./TicketFormsCard', () => ({ default: () => <div data-testid="stub-ticket-forms-card" /> }));

import TicketingSettingsTabs from './TicketingSettingsTabs';
import { useAuthStore } from '../../stores/auth';
import { i18n } from '@/lib/i18n';

function makeToken(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/=/g, '');
  const body = btoa(JSON.stringify(payload)).replace(/=/g, '');
  return `${header}.${body}.sig`;
}

/** Simulate /auth/refresh returning an access token some time after first paint. */
function tokenArrives(payload: Record<string, unknown>) {
  act(() => {
    useAuthStore.setState({ tokens: { accessToken: makeToken(payload), expiresInSeconds: 900 } });
  });
}

const PARTNER_ONLY = [
  { tab: 'forms', panel: 'ticketing-tab-panel-forms', card: 'stub-ticket-forms-card' },
  { tab: 'inbound', panel: 'ticketing-tab-panel-inbound', card: 'stub-inbound-email-card' },
  { tab: 'canned', panel: 'ticketing-tab-panel-canned', card: 'stub-canned-responses-card' },
] as const;

describe('TicketingSettingsTabs vs. late-arriving JWT scope (#4013)', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    grantedActions.clear();
    useAuthStore.setState({ tokens: null });
    window.location.hash = '';
  });

  afterEach(async () => {
    useAuthStore.setState({ tokens: null });
    window.location.hash = '';
    await i18n.changeLanguage('en');
  });

  it('partner scope arriving after first paint reveals all three partner-only tabs', async () => {
    render(<TicketingSettingsTabs />);

    // First paint: no token, so the scope is unknown. The tabs fail closed —
    // an unknown scope is never treated as a grant.
    expect(await screen.findByTestId('ticketing-tab-statuses')).toBeInTheDocument();
    for (const { tab } of PARTNER_ONLY) {
      expect(screen.queryByTestId(`ticketing-tab-${tab}`)).toBeNull();
    }
    // The default tab is not partner-only, so there is nothing pending to say.
    expect(screen.queryByTestId('ticketing-tab-panel-pending')).toBeNull();

    tokenArrives({ scope: 'partner', partnerId: 'partner-1' });

    // THE REGRESSION: with the frozen memo these never appeared, at all, ever.
    for (const { tab } of PARTNER_ONLY) {
      await waitFor(() => expect(screen.getByTestId(`ticketing-tab-${tab}`)).toBeInTheDocument());
    }
    // The four base tabs are still there — the gate only ever adds.
    expect(screen.getByTestId('ticketing-tab-export')).toBeInTheDocument();
  });

  it.each(PARTNER_ONLY)(
    '#tab=$tab deep link on a cold load: shows a pending placeholder, then the real panel once the token lands',
    async ({ tab, panel, card }) => {
      window.location.hash = `#tab=${tab}`;

      render(<TicketingSettingsTabs />);

      // The deep-linked sub-tab survives the unresolved window (nothing here
      // rewrites the hash), but its body cannot render yet. Rather than an
      // indefinite blank area, say the answer is still pending — that is the
      // ONLY thing distinguishing 'unresolved' from a settled 'denied'.
      expect(await screen.findByTestId('ticketing-tab-panel-pending')).toBeInTheDocument();
      expect(screen.queryByTestId(panel)).toBeNull();
      expect(screen.queryByTestId(card)).toBeNull();
      expect(window.location.hash).toBe(`#tab=${tab}`);

      tokenArrives({ scope: 'partner', partnerId: 'partner-1' });

      await waitFor(() => expect(screen.getByTestId(panel)).toBeInTheDocument());
      expect(screen.getByTestId(card)).toBeInTheDocument();
      expect(screen.queryByTestId('ticketing-tab-panel-pending')).toBeNull();
    },
  );

  it('M365 consent return (initialTab=inbound, embedded): pending, then the inbound card', async () => {
    // PartnerSettingsPage passes initialTab='inbound' when it sees the
    // ?ticketMailbox= deep link. That is a full-page navigation back from
    // Microsoft, so it is always a cold load — the worst case for the old memo,
    // which left the user staring at an empty Ticketing tab.
    render(<TicketingSettingsTabs syncHash={false} initialTab="inbound" />);

    expect(await screen.findByTestId('ticketing-tab-panel-pending')).toBeInTheDocument();
    expect(screen.queryByTestId('stub-inbound-email-card')).toBeNull();

    tokenArrives({ scope: 'partner', partnerId: 'partner-1' });

    await waitFor(() => expect(screen.getByTestId('stub-inbound-email-card')).toBeInTheDocument());
    expect(screen.queryByTestId('ticketing-tab-panel-pending')).toBeNull();
    // The separate ticket_mailbox:read gate is unaffected by the scope fix.
    expect(screen.queryByTestId('m365-mailbox-card')).toBeNull();
  });

  it('org scope arriving after first paint keeps the partner-only tabs hidden, and stops saying "pending"', async () => {
    window.location.hash = '#tab=inbound';

    render(<TicketingSettingsTabs />);
    expect(await screen.findByTestId('ticketing-tab-panel-pending')).toBeInTheDocument();

    tokenArrives({ scope: 'organization', orgId: 'org-1' });

    // Settled denial: the placeholder goes away (we are no longer waiting for an
    // answer) and nothing partner-only is offered. Reactivity must not become a
    // grant for the wrong scope — this is the other direction of the fix.
    await waitFor(() => expect(screen.queryByTestId('ticketing-tab-panel-pending')).toBeNull());
    for (const { tab, panel } of PARTNER_ONLY) {
      expect(screen.queryByTestId(`ticketing-tab-${tab}`)).toBeNull();
      expect(screen.queryByTestId(panel)).toBeNull();
    }
    expect(screen.getByTestId('ticketing-tab-statuses')).toBeInTheDocument();
  });

  it('a hashchange onto a partner-only sub-tab during the unresolved window defers rather than denies', async () => {
    // Browser back/forward can land on a partner-only sub-tab before the refresh
    // round trip has finished. The hashchange listener runs the same parseHash
    // as mount, so the gate must reach the same pending state that way too.
    render(<TicketingSettingsTabs />);
    expect(await screen.findByTestId('ticketing-tab-panel-statuses')).toBeInTheDocument();

    act(() => {
      window.location.hash = '#tab=canned';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    expect(screen.getByTestId('ticketing-tab-panel-pending')).toBeInTheDocument();
    expect(screen.queryByTestId('ticketing-tab-canned')).toBeNull();
    expect(window.location.hash).toBe('#tab=canned');

    tokenArrives({ scope: 'partner', partnerId: 'partner-1' });

    await waitFor(() => expect(screen.getByTestId('stub-canned-responses-card')).toBeInTheDocument());
    expect(window.location.hash).toBe('#tab=canned');
  });

  it('a token going away again re-hides the partner-only tabs instead of keeping the stale grant', async () => {
    // #4013 was a "this value never updates" bug, so pin the reverse direction
    // too. In practice the only path that nulls an in-memory token mid-session
    // is logout (stores/auth.ts — a failed or throttled refresh never calls
    // setTokens(null)), and every logout path navigates away; this is a guard
    // against a future regression, not a live sequence.
    window.location.hash = '#tab=inbound';
    render(<TicketingSettingsTabs />);

    tokenArrives({ scope: 'partner', partnerId: 'partner-1' });
    await waitFor(() => expect(screen.getByTestId('stub-inbound-email-card')).toBeInTheDocument());

    act(() => {
      useAuthStore.setState({ tokens: null });
    });

    // Back to pending, NOT to a denial we were never told about — and the
    // deep-linked sub-tab is still in the URL, so the grant restores in place.
    await waitFor(() => expect(screen.getByTestId('ticketing-tab-panel-pending')).toBeInTheDocument());
    expect(screen.queryByTestId('stub-inbound-email-card')).toBeNull();
    expect(screen.queryByTestId('ticketing-tab-inbound')).toBeNull();
    expect(window.location.hash).toBe('#tab=inbound');

    tokenArrives({ scope: 'partner', partnerId: 'partner-1' });
    await waitFor(() => expect(screen.getByTestId('stub-inbound-email-card')).toBeInTheDocument());
  });

  it('a present-but-undecodable token is a settled denial, not a permanent "pending"', async () => {
    window.location.hash = '#tab=canned';
    render(<TicketingSettingsTabs />);
    expect(await screen.findByTestId('ticketing-tab-panel-pending')).toBeInTheDocument();

    act(() => {
      useAuthStore.setState({ tokens: { accessToken: 'not-a-jwt', expiresInSeconds: 900 } });
    });

    // We looked and the answer is "no claims" — resolved, and fails closed. The
    // server rejects such a token with a 401 rather than degrading the page, so
    // the user is on their way out anyway; what matters is that we do not spin.
    await waitFor(() => expect(screen.queryByTestId('ticketing-tab-panel-pending')).toBeNull());
    expect(screen.queryByTestId('ticketing-tab-canned')).toBeNull();
    expect(screen.queryByTestId('ticketing-tab-panel-canned')).toBeNull();
  });
});
