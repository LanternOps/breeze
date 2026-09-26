import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import MonitoringPolicyPanel from './MonitoringPolicyPanel';
import { armStateFixture, monitoringFixture, OPS, policyListFixture } from './operationsFixtures';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });
type Handler = (url: string, init?: RequestInit) => Response | undefined;
let armResponses: Array<() => Response>;
let monitoring: ReturnType<typeof monitoringFixture>;
function mockApi(extra?: Handler) {
  vi.mocked(fetchWithAuth).mockImplementation(async (input, init) => {
    const url = String(input);
    const handled = extra?.(url, init);
    if (handled) return handled;
    if (url.endsWith('/arm')) return armResponses.shift()!();
    if (url.includes('/monitoring')) return json(monitoring);
    if (url.includes('/policies')) return json(policyListFixture());
    return json({ error: 'unexpected' }, 500);
  });
}
const posts = () => vi.mocked(fetchWithAuth).mock.calls.filter(([, init]) => init?.method && init.method !== 'GET');
beforeEach(() => {
  vi.mocked(fetchWithAuth).mockReset(); vi.mocked(showToast).mockReset();
  monitoring = monitoringFixture(); armResponses = [];
  mockApi();
});
afterEach(() => cleanup());

it('opening and previewing are passive; preview shows destinations, context, cadence and daily volume', async () => {
  render(<MonitoringPolicyPanel siteId={OPS.site} canConfigure />);
  expect(await screen.findByTestId('topology-monitor-status')).toHaveTextContent('Enable requested, not active');
  fireEvent.click(screen.getByTestId('topology-monitor-preview'));
  expect(screen.getByTestId('topology-monitor-volume')).toHaveTextContent('288 checks per day');
  expect(screen.getByTestId('topology-monitor-preview-panel')).toHaveTextContent('Reported gateway');
  expect(screen.getByTestId('topology-monitor-preview-panel')).toHaveTextContent('Up to two routing contexts');
  expect(posts()).toEqual([]);
});

it('enables through the arm endpoint with the reviewed revision and announces the returned enabled state', async () => {
  armResponses.push(() => { monitoring = monitoringFixture({ enabled: true, nextScheduledAt: '2026-09-26T10:20:00.000Z' }); return json(armStateFixture()); });
  render(<MonitoringPolicyPanel siteId={OPS.site} canConfigure />);
  fireEvent.click(await screen.findByTestId('topology-monitor-preview'));
  fireEvent.click(screen.getByTestId('topology-monitor-enable'));
  await waitFor(() => expect(screen.getByTestId('topology-monitor-status')).toHaveTextContent('Enabled'));
  const [url, init] = posts()[0]!;
  expect(String(url)).toBe(`/topology/sites/${OPS.site}/policies/${OPS.policy}/arm`);
  expect(JSON.parse(String(init!.body))).toEqual({ expectedRevision: '4' });
  expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Monitoring enabled' }));
});

it('asks for a topology_arm step-up only when the server requires it, bound to the exact site, action and policy', async () => {
  armResponses.push(() => json({ error: 'A fresh step-up verification is required', code: 'step_up_required' }, 403));
  armResponses.push(() => json(armStateFixture()));
  mockApi((url) => url === '/users/me' ? json({ mfaMethod: 'totp' }) : url === '/auth/passkeys' ? json({ passkeys: [] })
    : url === '/auth/mfa/step-up' ? json({ stepUpGrantId: 'grant-1' }) : undefined);
  render(<MonitoringPolicyPanel siteId={OPS.site} canConfigure />);
  fireEvent.click(await screen.findByTestId('topology-monitor-preview'));
  fireEvent.click(screen.getByTestId('topology-monitor-enable'));
  fireEvent.change(await screen.findByTestId('topology-arm-stepup-code'), { target: { value: '123456' } });
  fireEvent.click(screen.getByTestId('topology-arm-stepup-confirm'));
  await waitFor(() => expect(posts().filter(([url]) => String(url).endsWith('/arm'))).toHaveLength(2));
  const mint = posts().find(([url]) => url === '/auth/mfa/step-up')!;
  expect(JSON.parse(String(mint[1]!.body))).toEqual({ method: 'totp', code: '123456', operation: 'topology_arm', resource: { siteId: OPS.site, action: 'arm_policy', subjectId: OPS.policy } });
  const retried = posts().filter(([url]) => String(url).endsWith('/arm'))[1]!;
  expect(JSON.parse(String(retried[1]!.body))).toEqual({ expectedRevision: '4', stepUpGrantId: 'grant-1' });
  await waitFor(() => expect(screen.queryByTestId('topology-arm-stepup')).toBeNull());
});

it('never announces a blocked arm as active', async () => {
  armResponses.push(() => { monitoring = monitoringFixture({ enabled: false, blockedReason: 'no_eligible_context' }); return json(armStateFixture({ enabled: false, blockedReason: 'no_eligible_context', nextScheduledAt: null })); });
  render(<MonitoringPolicyPanel siteId={OPS.site} canConfigure />);
  fireEvent.click(await screen.findByTestId('topology-monitor-preview'));
  fireEvent.click(screen.getByTestId('topology-monitor-enable'));
  await waitFor(() => expect(screen.getByTestId('topology-monitor-status')).toHaveTextContent('Blocked: no eligible context'));
  expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ message: 'Monitoring was not enabled: no eligible context' }));
  expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'Monitoring enabled' }));
});

it('a changed target revision (409) asks for a reload and a revoked authority leaves the policy off', async () => {
  armResponses.push(() => json({ error: 'Topology configuration changed', code: 'revision_conflict' }, 409));
  armResponses.push(() => json({ error: 'Permission denied', code: 'topology_permission_denied' }, 403));
  render(<MonitoringPolicyPanel siteId={OPS.site} canConfigure />);
  fireEvent.click(await screen.findByTestId('topology-monitor-preview'));
  fireEvent.click(screen.getByTestId('topology-monitor-enable'));
  expect(await screen.findByTestId('topology-monitor-conflict')).toHaveTextContent('changed since you opened it');
  fireEvent.click(screen.getByTestId('topology-monitor-reload'));
  fireEvent.click(await screen.findByTestId('topology-monitor-preview'));
  fireEvent.click(screen.getByTestId('topology-monitor-enable'));
  await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
  expect(screen.getByTestId('topology-monitor-status')).not.toHaveTextContent(/^Enabled/);
});

it('read-only users see status and no arming controls; a subject filter narrows to its policies', async () => {
  const { unmount } = render(<MonitoringPolicyPanel siteId={OPS.site} canConfigure={false} />);
  await screen.findByTestId('topology-monitor-status');
  expect(screen.queryByTestId('topology-monitor-enable')).toBeNull();
  expect(screen.getByText('You can view monitoring but not change it.')).toBeVisible();
  unmount();
  render(<MonitoringPolicyPanel siteId={OPS.site} canConfigure subject={{ kind: 'node', id: OPS.node }} />);
  expect(await screen.findByTestId('topology-monitor-none')).toHaveTextContent('No monitoring policy targets this item.');
});

it('reads the compile marker not_armed as a pending request and needs activation intent before arming', async () => {
  monitoring = monitoringFixture({ blockedReason: 'not_armed' });
  const { unmount } = render(<MonitoringPolicyPanel siteId={OPS.site} canConfigure />);
  expect(await screen.findByTestId('topology-monitor-status')).toHaveTextContent('Enable requested, not active');
  unmount();
  monitoring = monitoringFixture({ activationIntent: false });
  mockApi((url) => url.includes('/policies') && !url.includes('/monitoring') ? json(policyListFixture({ activationIntent: false })) : undefined);
  render(<MonitoringPolicyPanel siteId={OPS.site} canConfigure />);
  expect(await screen.findByTestId('topology-monitor-status')).toHaveTextContent('Not enabled');
  fireEvent.click(screen.getByTestId('topology-monitor-preview'));
  expect(screen.getByTestId('topology-monitor-intent-required')).toBeVisible();
  expect(screen.queryByTestId('topology-monitor-enable')).toBeNull();
});

it('a refused arm (409 no eligible collector) is an error, not a revision conflict, and nothing reads as enabled', async () => {
  armResponses.push(() => json({ error: 'No eligible collector observes a routing context for this policy', code: 'no_eligible_collector' }, 409));
  render(<MonitoringPolicyPanel siteId={OPS.site} canConfigure />);
  fireEvent.click(await screen.findByTestId('topology-monitor-preview'));
  fireEvent.click(screen.getByTestId('topology-monitor-enable'));
  await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'No eligible collector observes a routing context for this policy' })));
  expect(screen.queryByTestId('topology-monitor-conflict')).toBeNull();
  expect(screen.getByTestId('topology-monitor-status')).toHaveTextContent('Enable requested, not active');
});
