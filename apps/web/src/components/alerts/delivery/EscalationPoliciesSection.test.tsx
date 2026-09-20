import '@/lib/i18n';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
import { fetchWithAuth } from '../../../stores/auth';
import EscalationPoliciesSection from './EscalationPoliciesSection';
import type { EscalationPolicy } from './deliveryActions';
import type { NotificationChannel } from '../NotificationChannelList';

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: 'x', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;
const channels = [{ id: 'ch-1', name: 'NOC Slack', type: 'slack', enabled: true, config: {} }] as unknown as NotificationChannel[];

function renderSection(policies: EscalationPolicy[], isPartnerScope = true) {
  const onChanged = vi.fn(async () => {});
  render(<EscalationPoliciesSection policies={policies} channels={channels} currentOrgId="org-1" isPartnerScope={isPartnerScope} defaultOwnerScope="organization" onChanged={onChanged} onUnauthorized={() => {}} />);
  return { onChanged };
}

beforeEach(() => { vi.clearAllMocks(); fetchMock.mockImplementation(async url => url.startsWith('/alerts/delivery/rails') ? json({ data: [{ id: 'user-1', name: 'Alex' }] }) : json({ id: 'ep' })); });

describe('EscalationPoliciesSection (W05b)', () => {
  it('lists policies with owner badge and step count; empty state otherwise', () => {
    renderSection([{ id: 'ep-1', name: 'On-call', stepCount: 2, inherited: true }]);
    const row = screen.getByTestId('escalation-row-ep-1');
    expect(within(row).getByText('On-call')).toBeInTheDocument();
    expect(within(row).getByText('2 steps')).toBeInTheDocument();
    expect(within(row).getByTestId('escalation-partner-wide-badge')).toBeInTheDocument();
    expect(within(row).queryByTestId('escalation-row-edit')).toBeNull();
    expect(within(row).queryByTestId('escalation-row-delete')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('renders the empty state', () => {
    renderSection([]);
    expect(screen.getByTestId('escalation-empty')).toBeInTheDocument();
  });
  it('creates a policy from the drawer: name, one step with delay + channel, POST body typed', async () => {
    const { onChanged } = renderSection([]);
    fireEvent.click(screen.getByTestId('escalation-new'));
    const drawer = await screen.findByTestId('escalation-policy-drawer');
    fireEvent.change(within(drawer).getByTestId('escalation-name'), { target: { value: 'Page on-call' } });
    fireEvent.change(within(drawer).getByTestId('escalation-step-0-delay'), { target: { value: '15' } });
    fireEvent.click(within(drawer).getByLabelText('NOC Slack'));
    await waitFor(() => expect(within(drawer).getByTestId('escalation-policy-drawer-save')).toBeEnabled());
    fireEvent.click(within(drawer).getByTestId('escalation-policy-drawer-save'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const post = fetchMock.mock.calls.find(([u, i]) => u === '/alerts/policies' && (i as RequestInit)?.method === 'POST')!;
    expect(JSON.parse((post[1] as RequestInit).body as string)).toMatchObject({ name: 'Page on-call', steps: [{ delayMinutes: 15, channelIds: ['ch-1'] }] });
  });
  it('saves user-only targets and repeats, preserving both when editing', async () => {
    renderSection([{ id: 'ep-user', orgId: 'org-1', partnerId: null, name: 'Alex on-call',
      steps: [{ delayMinutes: 5, channelIds: [], userIds: ['user-1'], repeat: { everyMinutes: 10, maxTimes: 2 } }] }]);
    fireEvent.click(within(screen.getByTestId('escalation-row-ep-user')).getByTestId('escalation-row-edit'));
    expect(await screen.findByLabelText('Alex')).toBeChecked();
    expect(screen.getByTestId('escalation-step-0-every')).toHaveValue(10);
    fireEvent.click(screen.getByTestId('escalation-policy-drawer-save'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/alerts/policies/ep-user', expect.objectContaining({ method: 'PUT' })));
    const call = fetchMock.mock.calls.find(([, options]) => options?.method === 'PUT')!;
    expect(JSON.parse(call[1]!.body as string).steps[0]).toEqual({ delayMinutes: 5, channelIds: [], userIds: ['user-1'], repeat: { everyMinutes: 10, maxTimes: 2 } });
  });
  it('save is disabled while a step has no target', async () => {
    renderSection([]);
    fireEvent.click(screen.getByTestId('escalation-new'));
    const drawer = await screen.findByTestId('escalation-policy-drawer');
    fireEvent.change(within(drawer).getByTestId('escalation-name'), { target: { value: 'x' } });
    expect(within(drawer).getByTestId('escalation-policy-drawer-save')).toBeDisabled();
  });
  it('delete asks for confirmation then DELETEs', async () => {
    const { onChanged } = renderSection([{ id: 'ep-1', orgId: 'org-1', partnerId: null, name: 'On-call', steps: [{ delayMinutes: 5, channelIds: ['ch-1'] }] }]);
    fireEvent.click(within(screen.getByTestId('escalation-row-ep-1')).getByTestId('escalation-row-delete'));
    fireEvent.click(await screen.findByTestId('escalation-delete-confirm'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/alerts/policies/ep-1', expect.objectContaining({ method: 'DELETE' })));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});


describe('escalation validation and read failures', () => {
  it.each([['every', 1441], ['every', 0], ['times', 11], ['times', 0]])('rejects repeat %s=%s', async (field, value) => {
    renderSection([{ id: 'ep', orgId: 'org-1', partnerId: null, name: 'On-call',
      steps: [{ delayMinutes: 5, channelIds: [], userIds: ['user-1'], repeat: { everyMinutes: 1440, maxTimes: 10 } }] }]);
    fireEvent.click(screen.getByTestId('escalation-row-edit'));
    await screen.findByLabelText('Alex');
    expect(screen.getByTestId('escalation-policy-drawer-save')).toBeEnabled();
    fireEvent.change(screen.getByTestId(`escalation-step-0-${field}`), { target: { value } });
    expect(screen.getByTestId('escalation-policy-drawer-save')).toBeDisabled();
  });
  it('rejects more than 50 occurrences and accepts exactly 50', async () => {
    renderSection([{ id: 'ep', orgId: 'org-1', partnerId: null, name: 'On-call',
      steps: Array.from({ length: 5 }, () => ({ delayMinutes: 5, channelIds: [], userIds: ['user-1'], repeat: { everyMinutes: 10, maxTimes: 10 } })) }]);
    fireEvent.click(screen.getByTestId('escalation-row-edit'));
    await screen.findAllByLabelText('Alex');
    expect(screen.getByTestId('escalation-policy-drawer-save')).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('A policy can send at most 50 notifications.');
    fireEvent.change(screen.getByTestId('escalation-step-0-times'), { target: { value: 5 } });
    expect(screen.getByTestId('escalation-policy-drawer-save')).toBeEnabled();
  });
  it('blocks saving on a failed user read and enables it after Retry succeeds', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'failed' }, false));
    renderSection([{ id: 'ep', orgId: 'org-1', partnerId: null, name: 'On-call', steps: [{ delayMinutes: 5, channelIds: ['ch-1'] }] }]);
    fireEvent.click(screen.getByTestId('escalation-row-edit'));
    await screen.findByRole('alert');
    expect(screen.getByTestId('escalation-policy-drawer-save')).toBeDisabled();
    fireEvent.click(screen.getByTestId('escalation-step-0-users-retry'));
    await waitFor(() => expect(screen.getByTestId('escalation-policy-drawer-save')).toBeEnabled());
  });
  it('clears user targets and reloads the picker when ownership changes', async () => {
    renderSection([]);
    fireEvent.click(screen.getByTestId('escalation-new'));
    fireEvent.click(await screen.findByLabelText('Alex'));
    fireEvent.click(screen.getByTestId('escalation-owner-partner'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/alerts/delivery/rails?rail=users&ownerScope=partner'));
    expect(await screen.findByLabelText('Alex')).not.toBeChecked();
  });
});

it.each([null, { length: 1 }, [null]])('opens malformed legacy steps from the list: %j (G1)', async (steps) => {
  renderSection([{ id: 'legacy', orgId: 'org-1', partnerId: null, name: 'Legacy', steps } as unknown as EscalationPolicy]);
  fireEvent.click(screen.getByTestId('escalation-row-edit'));
  expect(await screen.findByTestId('escalation-legacy-repaired')).toBeInTheDocument();
});
