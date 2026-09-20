import '@/lib/i18n';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
import { fetchWithAuth } from '../../../stores/auth';
import DeliveryPreview from './DeliveryPreview';
import DeliveryRuleSetPreview from './DeliveryRuleSetPreview';
const fetchMock = vi.mocked(fetchWithAuth);
const json = (body: unknown, status = 200) => ({ ok: status === 200, status, json: async () => body }) as Response;
const answer = { skippedChannelIds: [], source: 'routing_rule', channelIds: ['ch'], escalationPolicyId: 'ep',
  routingRuleId: 'r', routingRuleName: 'Pages', display: 'API English display',
  description: { channels: [{ id: 'ch', name: 'PagerDuty', enabled: true }],
    escalationPolicy: { id: 'ep', name: 'On-call' }, owner: 'partner' } };
beforeEach(() => { vi.clearAllMocks(); window.location.hash = ''; fetchMock.mockResolvedValue(json(answer)); });
describe('DeliveryPreview', () => {
  it('shows channel names, partner provenance, and independently resolved escalation', async () => {
    render(<DeliveryPreview orgId="org-1" severity="critical" kind="cpu" />);
    expect(await screen.findByTestId('delivery-preview-result')).toHaveTextContent('Critical → PagerDuty');
    expect(screen.getByTestId('delivery-preview-result')).toHaveTextContent('Partner rule: Pages');
    expect(screen.getByTestId('delivery-preview-result')).toHaveTextContent('Escalates via On-call');
    expect(fetchMock.mock.calls[0]![0]).toContain('kind=cpu');
    expect(fetchMock.mock.calls[0]![0]).not.toContain('monitorId=');
  });
  it('shows skipped destinations and still shows independent escalation', async () => {
    fetchMock.mockResolvedValue(json({ ...answer, channelIds: [], skippedChannelIds: [
      { id: 'disabled-channel', reason: 'disabled' }, { id: 'foreign-channel', reason: 'unavailable' }, { id: 'gone-channel', reason: 'unavailable' },
    ] }));
    render(<DeliveryPreview orgId="org-1" severity="high" />);
    const result = await screen.findByTestId('delivery-preview-result');
    expect(result).toHaveTextContent('disabled-channel: disabled');
    expect(result).toHaveTextContent('foreign-channel: unavailable');
    expect(result).toHaveTextContent('gone-channel: unavailable');
    expect(result).toHaveTextContent('Escalates via On-call');
  });
  it('shows the explicit draft escalation instead of the row escalation', async () => {
    render(<DeliveryPreview orgId="org-1" severity="critical" escalationOverride={{ id: 'draft', name: 'Weekend' }} />);
    expect(await screen.findByTestId('delivery-preview-result')).toHaveTextContent('Escalates via Weekend');
    expect(screen.getByTestId('delivery-preview-result')).not.toHaveTextContent('On-call');
  });
  it('asks for a concrete organization without guessing a partner-wide result', () => {
    render(<DeliveryPreview orgId={null} severity="high" />);
    expect(screen.getByText('Select an organization to preview delivery.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('shows errors and retries instead of inventing an inbox-only result', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Unavailable' }, 500));
    render(<DeliveryPreview orgId="org-1" severity="high" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not preview delivery.');
    expect(screen.queryByTestId('delivery-preview-result')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('delivery-preview-result')).toBeInTheDocument();
  });
  it('does not render an old response after changing organization', async () => {
    let finishOld!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finishOld = resolve; }));
    const view = render(<DeliveryPreview orgId="old" severity="high" />);
    view.rerender(<DeliveryPreview orgId="new" severity="high" />);
    await screen.findByTestId('delivery-preview-result');
    await act(async () => finishOld(json({ ...answer, routingRuleName: 'Old org' })));
    expect(screen.getByTestId('delivery-preview-result')).not.toHaveTextContent('Old org');
  });
  it('stores rule-set preview selection in the hash, not the page query', async () => {
    fetchMock.mockImplementation(async url => url.startsWith('/orgs/sites') ? json({ data: [] }) : json(answer));
    render(<DeliveryRuleSetPreview orgId="org-1" />);
    fireEvent.change(screen.getByTestId('delivery-preview-severity'), { target: { value: 'critical' } });
    await waitFor(() => expect(window.location.hash).toBe('#preview/critical/all/all'));
    expect(window.location.search).toBe('');
  });
});
