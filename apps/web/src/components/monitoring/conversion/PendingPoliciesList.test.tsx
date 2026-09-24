import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
import { fetchWithAuth } from '../../../stores/auth';
import PendingPoliciesList from './PendingPoliciesList';
const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(body) }) as unknown as Response;

describe('PendingPoliciesList', () => {
  beforeEach(() => vi.mocked(fetchWithAuth).mockReset());

  // #6644 review finding 5: the list reads the same org-scoped endpoint (and
  // the same predicate) as the banner's count, so the two cannot disagree.
  it('lists the pending policies the banner counts, for the selected org, deep-linking to their Monitors tab', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(json({ data: {
      policies: 2, rows: 5,
      pendingPolicies: [{ id: 'p-1', name: 'Servers' }, { id: 'p-3', name: 'Workstations' }],
    } }));
    render(<PendingPoliciesList orgId="org-1" />);
    const first = await screen.findByTestId('pending-policy-p-1');
    expect(first.querySelector('a')).toHaveAttribute('href', '/configuration-policies/p-1#monitors');
    expect(first.textContent).toContain('Servers');
    expect(screen.getByTestId('pending-policy-p-3').textContent).toContain('Workstations');
    expect(fetchWithAuth).toHaveBeenCalledWith('/monitor-definitions/conversion/pending?orgId=org-1');
  });

  it('asks for the partner-wide pending set when no org is selected', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(json({ data: { policies: 0, rows: 0, pendingPolicies: [] } }));
    render(<PendingPoliciesList orgId={null} />);
    expect(await screen.findByTestId('pending-policies-empty')).toBeInTheDocument();
    expect(fetchWithAuth).toHaveBeenCalledWith('/monitor-definitions/conversion/pending');
  });

  it('shows an error, not the empty state, when the fetch fails', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(json({ error: 'boom' }, 500));
    render(<PendingPoliciesList orgId="org-1" />);
    expect(await screen.findByTestId('pending-policies-error')).toBeInTheDocument();
    expect(screen.queryByTestId('pending-policies-empty')).toBeNull();
  });
});
