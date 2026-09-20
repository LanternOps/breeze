import '@/lib/i18n';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: 'org-1' }) }));
vi.mock('@/hooks/useDefaultOwnerScope', () => ({ useDefaultOwnerScope: () => ({ isPartnerScope: false, defaultOwnerScope: 'organization' }) }));
vi.mock('./AlertsTabStrip', () => ({ default: () => null }));
vi.mock('./delivery/ChannelsSection', () => ({ default: () => <div data-testid="channels-ready" /> }));
vi.mock('./delivery/RoutingSection', () => ({ default: () => <button data-testid="routing-default-edit">Edit</button> }));
vi.mock('./delivery/EscalationPoliciesSection', () => ({ default: () => <button data-testid="escalation-new">New</button> }));
import { fetchWithAuth } from '../../stores/auth';
import DeliveryPage from './DeliveryPage';
const fetchMock = vi.mocked(fetchWithAuth);
beforeEach(() => vi.clearAllMocks());
it.each(['routing','escalation'])('a failed %s read never offers an inbox-only default; Retry restores it', async rail => {
  let failed = true;
  fetchMock.mockImplementation(async url => ({ ok: !(failed && url.includes(`rail=${rail}`)), status: failed && url.includes(`rail=${rail}`) ? 500 : 200,
    json: async () => ({ data: [] }) }) as Response);
  render(<DeliveryPage />);
  await screen.findByTestId(`delivery-${rail}-error`);
  expect(screen.getByTestId('channels-ready')).toBeInTheDocument();
  expect(screen.queryByTestId('routing-default-edit')).toBeNull();
  if (rail === 'escalation') expect(screen.queryByTestId('escalation-new')).toBeNull();
  failed = false; fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByTestId('routing-default-edit')).toBeInTheDocument();
});
