import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
import { fetchWithAuth } from '../../stores/auth';
import ScriptProposalDetail from './ScriptProposalDetail';

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const jsonResponse = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

beforeEach(() => vi.clearAllMocks());

describe('ScriptProposalDetail', () => {
  it('renders the goal, risk tier, and review summary for a reviewed proposal', async () => {
    // Real ScriptProposalDetailDto shape (packages/shared/src/types/scriptProposals.ts):
    // { proposal: {...}, review: {...} | null, devices, executions, verification, viewer }.
    fetchWithAuthMock.mockResolvedValueOnce(
      jsonResponse({
        proposal: { status: 'executed', goal: 'Restart the print spooler', riskTier: 'low' },
        review: { summary: 'Restarts spooler.service via systemctl.' },
      }),
    );

    render(<ScriptProposalDetail proposalId="proposal-1" />);

    await waitFor(() => expect(screen.getByText('Restart the print spooler')).toBeTruthy());
    expect(screen.getByText('Restarts spooler.service via systemctl.')).toBeTruthy();
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/ai/script-proposals/proposal-1');
  });

  it('renders "evidence erased" when the proposal 404s with error: not_found (source org merged/erased)', async () => {
    // The real route (routes/ai/scriptProposals.ts) returns exactly this
    // body for a genuinely gone row.
    fetchWithAuthMock.mockResolvedValueOnce(jsonResponse({ error: 'not_found' }, 404));

    render(<ScriptProposalDetail proposalId="proposal-2" />);

    await waitFor(() => expect(screen.getByTestId('script-proposal-evidence-erased')).toBeTruthy());
  });

  it('renders a load error for a non-404 failure (e.g. 403 forbidden)', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(jsonResponse({ error: 'forbidden' }, 403));

    render(<ScriptProposalDetail proposalId="proposal-3" />);

    await waitFor(() => expect(screen.getByText(/couldn't load/i)).toBeTruthy());
  });

  it('renders a load error, not "evidence erased", when the 404 is feature_disabled', async () => {
    // The same route 404s the whole surface when the wave flag is off — that
    // must never read as "this proposal's evidence was destroyed".
    fetchWithAuthMock.mockResolvedValueOnce(jsonResponse({ error: 'feature_disabled' }, 404));

    render(<ScriptProposalDetail proposalId="proposal-4" />);

    await waitFor(() => expect(screen.getByText(/couldn't load/i)).toBeTruthy());
    expect(screen.queryByTestId('script-proposal-evidence-erased')).toBeNull();
  });

  // #11287: raw status strings are not for humans, and the override actions
  // live on the approvals page.
  it('shows a human status label and links a review_failed proposal to Approvals', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      jsonResponse({
        proposal: { status: 'review_failed', goal: 'Clear temp files', riskTier: 'low' },
        review: { summary: 'The reviewer could not finish.' },
      }),
    );
    render(<ScriptProposalDetail proposalId="proposal-9" />);
    await waitFor(() => expect(screen.getByText('Clear temp files')).toBeTruthy());
    expect(screen.queryByText('review_failed')).toBeNull();
    expect(screen.getByText('AI review failed')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Review in Approvals' });
    expect(link.getAttribute('href')).toBe('/approvals#proposal-proposal-9');
  });

  it('offers no Approvals link once a proposal is past review (executed)', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      jsonResponse({ proposal: { status: 'executed', goal: 'g', riskTier: 'low' }, review: null }),
    );
    render(<ScriptProposalDetail proposalId="proposal-10" />);
    await waitFor(() => expect(screen.getByText('g')).toBeTruthy());
    expect(screen.getByText('Executed')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Review in Approvals' })).toBeNull();
  });
});
