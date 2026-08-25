import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

// #4013. PatchApprovalModal.test.tsx mocks `lib/authScope` with a scope that is
// already known on the first render — the one state a cold page load never
// starts in. Access tokens are deliberately never persisted (`partialize` in
// stores/auth.ts keeps only `user` + `isAuthenticated`), so at first paint the
// store is empty and EVERY user decodes as `scope: null`.
//
// It matters HERE and not only in principle because PatchesPage renders this
// modal UNCONDITIONALLY — `<PatchApprovalModal open={modalOpen} patch={...} />`
// sits in the page body, not behind `{modalOpen && ...}`, and PatchesPage has no
// early return in front of it. So the modal's first render happens during the
// page's cold load, with `patch={null}`, long before anyone opens it. Hooks run
// on that render, which is why the old
// `useMemo(() => getJwtClaims().scope === 'organization', [])` captured the
// empty-store answer and pinned `isOrgScope=false` for the life of the PAGE.
//
// Every case below therefore mounts the modal CLOSED first and opens it later,
// which is the sequence the app actually produces, and mocks neither `authScope`
// nor the auth store.

vi.mock('../../stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../stores/auth')>()),
  fetchWithAuth: vi.fn(),
}));

import PatchApprovalModal from './PatchApprovalModal';
import { useAuthStore } from '../../stores/auth';

const PATCH = {
  id: 'patch-1',
  title: 'Security Update',
  severity: 'critical' as const,
  source: 'Microsoft',
  os: 'Windows',
  releaseDate: '2026-04-01T00:00:00.000Z',
  approvalStatus: 'pending' as const,
};

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

const PARTNER_LEVEL = /patch approvals are managed at the partner level/i;

describe('PatchApprovalModal vs. late-arriving JWT scope (#4013)', () => {
  beforeEach(() => {
    useAuthStore.setState({ tokens: null });
  });

  afterEach(() => {
    useAuthStore.setState({ tokens: null });
  });

  it('org scope arriving after the page mounted the closed modal: explains the denial and disables Approve', async () => {
    // The exact sequence a cold load of /patches produces for an org-scoped
    // user. THE REGRESSION: with the frozen memo the scope was captured here,
    // from an empty store, and stayed `not organization` for the whole page —
    // so this user was handed an enabled Approve button and no explanation, and
    // only found out it was refused after clicking through the confirm dialog.
    const { rerender } = render(<PatchApprovalModal open={false} patch={null} onClose={() => {}} />);

    tokenArrives({ scope: 'organization', orgId: 'org-1' });

    rerender(<PatchApprovalModal open patch={PATCH} ringId={null} onClose={() => {}} />);

    expect(await screen.findByText(PARTNER_LEVEL)).toBeInTheDocument();
    expect(screen.getByTestId('patch-approval-scope-notice')).toHaveTextContent(PARTNER_LEVEL);
    const submit = screen.getByTestId('patch-approval-submit');
    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute('title', 'Patch approvals are managed at the partner level');
  });

  it('partner scope arriving after the closed mount: Approve becomes available, with no false denial', async () => {
    const { rerender } = render(<PatchApprovalModal open={false} patch={null} onClose={() => {}} />);

    tokenArrives({ scope: 'partner', partnerId: 'partner-1' });

    rerender(<PatchApprovalModal open patch={PATCH} ringId={null} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByTestId('patch-approval-submit')).not.toBeDisabled());
    expect(screen.queryByText(PARTNER_LEVEL)).toBeNull();
    expect(screen.getByTestId('patch-approval-submit')).not.toHaveAttribute('title');
  });

  it('unresolved scope: Approve is withheld, but NOT as a partner-level denial', async () => {
    // The third state has to render as its own thing. Disabling submit is the
    // fail-closed half (an unknown scope is not a grant); withholding the
    // "managed at the partner level" banner is the honest half — we have not
    // been told no, we have not been told anything.
    render(<PatchApprovalModal open patch={PATCH} ringId={null} onClose={() => {}} />);

    const submit = await screen.findByTestId('patch-approval-submit');
    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute('title', 'Checking your access...');
    expect(screen.queryByText(PARTNER_LEVEL)).toBeNull();
    // ...and the reason is VISIBLE, not tooltip-only: a disabled button is out
    // of the tab order and has no hover on touch, so `title` alone would leave
    // the modal reading as broken rather than busy.
    expect(screen.getByTestId('patch-approval-scope-notice')).toHaveTextContent('Checking your access...');

    tokenArrives({ scope: 'partner', partnerId: 'partner-1' });

    await waitFor(() => expect(screen.getByTestId('patch-approval-submit')).not.toBeDisabled());
    expect(screen.queryByTestId('patch-approval-scope-notice')).toBeNull();
  });

  it('a token going away again re-withholds Approve instead of keeping the stale grant', async () => {
    // #4013 was a "this value never updates" bug, so pin the reverse direction
    // too: the grant must not outlive the token that justified it. In practice
    // the only path that nulls an in-memory token mid-session is logout
    // (stores/auth.ts — a failed/throttled refresh never calls setTokens(null)),
    // and every logout path navigates away, so this is a guard against a future
    // regression rather than a live sequence.
    render(<PatchApprovalModal open patch={PATCH} ringId={null} onClose={() => {}} />);

    tokenArrives({ scope: 'partner', partnerId: 'partner-1' });
    await waitFor(() => expect(screen.getByTestId('patch-approval-submit')).not.toBeDisabled());

    act(() => {
      useAuthStore.setState({ tokens: null });
    });

    await waitFor(() => expect(screen.getByTestId('patch-approval-submit')).toBeDisabled());
    // Back to pending, NOT to a denial we were never told about.
    expect(screen.getByTestId('patch-approval-scope-notice')).toHaveTextContent('Checking your access...');
    expect(screen.queryByText(PARTNER_LEVEL)).toBeNull();
  });

  it('a present-but-undecodable token resolves without claiming a partner-level denial', async () => {
    render(<PatchApprovalModal open patch={PATCH} ringId={null} onClose={() => {}} />);
    expect(await screen.findByTestId('patch-approval-submit')).toBeDisabled();

    act(() => {
      useAuthStore.setState({ tokens: { accessToken: 'not-a-jwt', expiresInSeconds: 900 } });
    });

    // Resolved, and NOT org-scoped — so the gate matches what `handleSubmit` and
    // the server enforce, both of which key on `scope === 'organization'`. This
    // is deliberately unchanged by the fix: telling someone whose token cannot
    // be decoded that "approvals are managed at the partner level" would be a
    // wrong explanation for what is really a 401 on the next request.
    await waitFor(() => expect(screen.getByTestId('patch-approval-submit')).not.toBeDisabled());
    expect(screen.queryByText(PARTNER_LEVEL)).toBeNull();
  });
});
