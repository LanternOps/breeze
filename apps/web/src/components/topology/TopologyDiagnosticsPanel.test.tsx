import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { diagnosticPlanFixture, TOPOLOGY_FIXTURE_IDS as ids } from '../../../../../packages/shared/src/testing/topologyFixtures';
import { fetchWithAuth } from '../../stores/auth';
import TopologyDiagnosticsPanel from './TopologyDiagnosticsPanel';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const plan = diagnosticPlanFixture();
const run = { id: ids.snapshot, attemptId: ids.binding, commandId: ids.step, state: 'queued', plan, assessment: 'unknown', coverage: 'none', reasons: [], steps: [], queuedAt: plan.acceptedAt, startedAt: null, deadline: plan.deadline, finishedAt: null, cancelRequestedAt: null, failureReason: null };
beforeEach(() => {
  window.location.hash = '#topology';
  vi.mocked(fetchWithAuth).mockReset().mockImplementation(async (url) => {
    if (String(url).includes('/collectors')) return new Response(JSON.stringify({ items: [{ origin: plan.origin, eligible: true, reasons: [], families: ['ipv4'], rank: 0 }], nextCursor: null }));
    return new Response(JSON.stringify(run));
  });
});
afterEach(() => { cleanup(); window.location.hash = ''; });
it('opening is passive; explicit start carries the chosen same-site origin and unique idempotency key', async () => {
  render(<TopologyDiagnosticsPanel siteId={ids.site} subject={plan.subject} graphRevision="1" onClose={() => {}} />);
  await waitFor(() => expect(screen.getByTestId('topology-diagnostic-start')).toBeEnabled());
  expect(vi.mocked(fetchWithAuth).mock.calls.every(([, options]) => options?.method !== 'POST')).toBe(true);
  fireEvent.click(screen.getByTestId('topology-diagnostic-start'));
  expect(await screen.findByTestId(`topology-run-${run.id}`)).toBeVisible();
  const post = vi.mocked(fetchWithAuth).mock.calls.find(([, options]) => options?.method === 'POST')!;
  expect(JSON.parse(post[1]!.body as string)).toMatchObject({ originDeviceId: plan.origin.deviceId, contextKey: 'default', family: 'ipv4', subject: plan.subject });
  expect(post[1]?.headers).toHaveProperty('Idempotency-Key');
  expect(window.location.hash).toContain(run.id);
});
it('cancel remains Stop requested until terminal acknowledgement', async () => {
  render(<TopologyDiagnosticsPanel siteId={ids.site} subject={plan.subject} graphRevision="1" onClose={() => {}} />);
  await waitFor(() => expect(screen.getByTestId('topology-diagnostic-start')).toBeEnabled());
  fireEvent.click(screen.getByTestId('topology-diagnostic-start'));
  await screen.findByTestId(`topology-run-${run.id}`);
  vi.mocked(fetchWithAuth).mockResolvedValueOnce(new Response(JSON.stringify({ ...run, cancelRequestedAt: plan.acceptedAt })));
  fireEvent.click(screen.getByTestId('topology-diagnostic-stop'));
  await waitFor(() => expect(screen.getByTestId('topology-diagnostic-stop')).toBeDisabled());
  expect(screen.getByText(/Stop requested ·/)).toBeVisible();
});
