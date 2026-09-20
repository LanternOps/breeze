import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
import { fetchWithAuth } from '../../../stores/auth';
import PendingPoliciesList from './PendingPoliciesList';
const json = (body: unknown) => ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(body) }) as unknown as Response;

describe('PendingPoliciesList', () => {
  it('lists only policies that still carry a legacy link, deep-linking to their Monitors tab', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(json({ data: [
      { id: 'p-1', name: 'Servers', orgId: 'org-1', partnerId: null, featureLinks: [{ id: 'l1', featureType: 'alert_rule' }, { id: 'l2', featureType: 'monitors' }] },
      { id: 'p-2', name: 'Clean', orgId: 'org-1', partnerId: null, featureLinks: [{ id: 'l3', featureType: 'monitors' }] },
      { id: 'p-3', name: 'Partner base', orgId: null, partnerId: 'pt-1', featureLinks: [{ id: 'l4', featureType: 'monitoring' }] },
    ] }));
    render(<PendingPoliciesList />);
    const first = await screen.findByTestId('pending-policy-p-1');
    expect(first.querySelector('a')).toHaveAttribute('href', '/configuration-policies/p-1#monitors');
    expect(first.textContent).toContain('Inline alert rule');
    expect(screen.getByTestId('pending-policy-p-3').textContent).toContain('Service/process watch');
    expect(screen.queryByTestId('pending-policy-p-2')).toBeNull();
    expect(fetchWithAuth).toHaveBeenCalledWith('/configuration-policies?limit=100');
  });
  it('says so when no policy carries legacy links', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(json({ data: [] }));
    render(<PendingPoliciesList />);
    expect(await screen.findByTestId('pending-policies-empty')).toBeInTheDocument();
  });
});
