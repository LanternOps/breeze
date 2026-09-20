import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
import { fetchWithAuth } from '../../../stores/auth';
import RoutingRuleDrawer from './RoutingRuleDrawer';

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function renderDrawer() {
  const onSave = vi.fn();
  render(<RoutingRuleDrawer open mode="rule" rule={null} ownerScope="organization" showOwnerScope={false}
    orgId="org-1" channels={[{ id: 'ch-1', name: 'NOC', type: 'email', enabled: true }]} policies={[]} saving={false}
    onSave={onSave} onCancel={() => {}} />);
  return { onSave };
}

beforeEach(() => { vi.clearAllMocks(); fetchMock.mockResolvedValue(json({ data: [] })); });

describe('routing sites loading', () => {
  it.each(['http', 'network'])('shows a retryable %s failure without blocking a rule with no site filter', async (failure) => {
    if (failure === 'http') fetchMock.mockResolvedValueOnce(json({ error: 'failed' }, false));
    else fetchMock.mockRejectedValueOnce(new Error('offline'));
    const { onSave } = renderDrawer();
    expect(await screen.findByTestId('routing-sites-error')).toHaveTextContent('Could not load sites. Try again.');
    fireEvent.change(screen.getByTestId('routing-rule-name'), { target: { value: 'NOC alerts' } });
    fireEvent.click(screen.getByTestId('routing-rule-channel-ch-1'));
    expect(screen.getByTestId('routing-rule-drawer-save')).toBeEnabled();
    fireEvent.click(screen.getByTestId('routing-rule-drawer-save'));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ siteIds: [] }));
    fetchMock.mockResolvedValueOnce(json({ data: [{ id: 'site-1', name: 'HQ' }] }));
    fireEvent.click(screen.getByTestId('routing-sites-retry'));
    expect(await screen.findByTestId('routing-rule-site-site-1')).toHaveTextContent('HQ');
    expect(screen.queryByTestId('routing-sites-error')).toBeNull();
  });

  it('does not show an error or Retry for an organization with no sites', async () => {
    renderDrawer();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/orgs/sites?organizationId=org-1&limit=100'));
    expect(screen.queryByTestId('routing-sites-error')).toBeNull();
    expect(screen.queryByTestId('routing-sites-retry')).toBeNull();
  });
});

describe('routing drawer layout', () => {
  it('keeps the footer outside the scrollable form body', async () => {
    renderDrawer();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = screen.getByTestId('routing-rule-drawer-body');
    const footer = screen.getByTestId('routing-rule-drawer-footer');
    expect(body).toHaveClass('flex-1', 'overflow-y-auto');
    expect(body).toContainElement(screen.getByTestId('routing-rule-name'));
    expect(footer).toContainElement(screen.getByTestId('routing-rule-drawer-save'));
    expect(body).not.toContainElement(footer);
    expect(body.parentElement).toBe(footer.parentElement);
  });
});
