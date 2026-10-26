import '@/lib/i18n';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: 'org-1' }) }));
vi.mock('@/hooks/useDefaultOwnerScope', () => ({ useDefaultOwnerScope: () => ({ isPartnerScope: false, defaultOwnerScope: 'organization' }) }));
vi.mock('./AlertsTabStrip', () => ({ default: () => null }));
vi.mock('./delivery/ChannelsSection', () => ({ default: () => <div data-testid="channels-ready" /> }));
vi.mock('./delivery/RoutingSection', () => ({ default: () => null }));
vi.mock('./delivery/EscalationPoliciesSection', () => ({ default: () => null }));
vi.mock('./delivery/DeliveryRuleSetPreview', () => ({ default: () => null }));
import { fetchWithAuth } from '../../stores/auth';
import DeliveryPage from './DeliveryPage';
const fetchMock = vi.mocked(fetchWithAuth);
beforeEach(() => vi.clearAllMocks());

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

it('renders inherited partner-wide channels as read-only cards under a "Shared by your partner" heading (#9625)', async () => {
  fetchMock.mockImplementation(async (url) => String(url).includes('rail=channels')
    ? ok({ data: [], inherited: [{ id: 'c1', name: 'MSP Ops Slack', type: 'slack', enabled: true, inherited: true }] })
    : ok({ data: [] }));
  render(<DeliveryPage />);
  const section = await screen.findByTestId('delivery-inherited-channels');
  expect(screen.getByRole('heading', { name: 'Shared by your partner' })).toBeInTheDocument();
  const card = within(section).getByTestId('delivery-inherited-channel-c1');
  expect(within(card).getByText('MSP Ops Slack')).toBeInTheDocument();
  expect(within(card).getByText('Partner-wide')).toBeInTheDocument();
  expect(within(card).getByText('Owned by your partner; read-only here.')).toBeInTheDocument();
  expect(section.tagName).not.toBe('UL');
});

it('shows a display label for the inherited channel type, not the raw lowercase enum', async () => {
  fetchMock.mockImplementation(async (url) => String(url).includes('rail=channels')
    ? ok({ data: [], inherited: [{ id: 'c2', name: 'On-call', type: 'pagerduty', enabled: true, inherited: true }] })
    : ok({ data: [] }));
  render(<DeliveryPage />);
  const card = await screen.findByTestId('delivery-inherited-channel-c2');
  expect(within(card).getByText('PagerDuty')).toBeInTheDocument();
  expect(within(card).queryByText('pagerduty')).toBeNull();
});

it('renders nothing for the inherited block when there are no partner-wide channels', async () => {
  fetchMock.mockImplementation(async () => ok({ data: [] }));
  render(<DeliveryPage />);
  await screen.findByTestId('channels-ready');
  expect(screen.queryByTestId('delivery-inherited-channels')).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Shared by your partner' })).toBeNull();
});
