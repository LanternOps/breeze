import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import '@/lib/i18n';

import ScriptProvenancePanel from './ScriptProvenancePanel';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import type { ScriptVersionDto } from '@breeze/shared';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const navigateToMock = vi.mocked(navigateTo);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const headVersion: ScriptVersionDto = {
  id: 'v1',
  version: 1,
  contentDigest: 'digest-1',
  changelog: null,
  createdAt: '2026-01-01T00:00:00Z',
  origin: 'ai_proposal',
  proposalId: 'p1',
  reviewId: 'r1',
  reviewedAt: '2026-01-01T00:05:00Z',
  approvedBy: 'user-1',
  approverName: 'Jane Doe',
  approvedAt: '2026-01-01T00:10:00Z',
  approvalMethod: 'direct_ui',
  reviewSummary: 'Targets one service',
  reviewRiskTier: 'low',
  reviewModel: 'gpt-6-astra',
  reviewEvidenceErased: false,
};

describe('ScriptProvenancePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the head version origin, review summary and approver', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ versions: [headVersion] }));
    render(<ScriptProvenancePanel scriptId="s1" />);
    expect(await screen.findByTestId('script-provenance-origin')).toHaveTextContent('AI proposal');
    expect(screen.getByTestId('script-provenance-review-summary')).toHaveTextContent('Targets one service');
    expect(screen.getByTestId('script-provenance-approver')).toBeInTheDocument();
  });

  it('links to the source proposal when the evidence is intact', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ versions: [headVersion] }));
    render(<ScriptProvenancePanel scriptId="s1" />);
    expect(await screen.findByTestId('script-provenance-proposal-link')).toHaveAttribute(
      'href',
      expect.stringContaining('p1')
    );
  });

  it('says the evidence was erased instead of showing a broken link', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ versions: [{ ...headVersion, reviewEvidenceErased: true, reviewSummary: null }] })
    );
    render(<ScriptProvenancePanel scriptId="s1" />);
    expect(await screen.findByTestId('script-provenance-erased')).toBeInTheDocument();
    expect(screen.queryByTestId('script-provenance-proposal-link')).not.toBeInTheDocument();
  });

  it('shows a Reviewed badge for an intact review at the head version', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ versions: [headVersion] }));
    render(<ScriptProvenancePanel scriptId="s1" />);
    expect(await screen.findByTestId('script-provenance-badge-reviewed')).toBeInTheDocument();
  });

  it('shows "Edited since review" when the head version is human with no review', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        versions: [
          { ...headVersion, id: 'v2', version: 2, origin: 'human', reviewId: null, reviewSummary: null, reviewEvidenceErased: false },
          headVersion,
        ],
      })
    );
    render(<ScriptProvenancePanel scriptId="s1" />);
    expect(await screen.findByTestId('script-provenance-edited-since-review')).toBeInTheDocument();
    expect(screen.queryByTestId('script-provenance-badge-reviewed')).not.toBeInTheDocument();
  });

  it('renders nothing intrusive for a plain human script with no history', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ versions: [] }));
    render(<ScriptProvenancePanel scriptId="s1" />);
    expect(await screen.findByTestId('script-provenance-empty')).toBeInTheDocument();
  });

  it('redirects to login on a 401', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({}, false, 401));
    render(<ScriptProvenancePanel scriptId="s1" />);
    await waitFor(() => expect(navigateToMock).toHaveBeenCalledWith('/login', { replace: true }));
  });
});
