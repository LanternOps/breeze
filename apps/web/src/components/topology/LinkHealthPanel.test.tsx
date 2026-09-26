import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '../../stores/auth';
import LinkHealthPanel from './LinkHealthPanel';
import { linkHealthFixture, OPS, unmeasuredLinkFixture } from './operationsFixtures';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });
beforeEach(() => { vi.mocked(fetchWithAuth).mockReset(); });
afterEach(() => cleanup());

it('shows each endpoint port measured on its own, freshness, and a one-sided counter as not measured', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(json(linkHealthFixture()));
  const onOpenHistory = vi.fn();
  render(<LinkHealthPanel siteId={OPS.site} relationshipId={OPS.relationship} labels={{ source: 'port-24', target: null }} onOpenHistory={onOpenHistory} />);
  expect(await screen.findByTestId('topology-health-freshness')).toHaveTextContent('Fresh until');
  const source = screen.getByTestId('topology-link-endpoint-source');
  expect(source).toHaveTextContent('port-24');
  expect(source).toHaveTextContent('Capacity 1 Gbps');
  expect(source).toHaveTextContent('Received: 1 Mbps');
  expect(source).toHaveTextContent('Receive errors: Not measured');
  expect(screen.getByTestId('topology-link-endpoint-target')).toHaveTextContent('Port not identified');
  fireEvent.click(screen.getByTestId('topology-history-open-source'));
  expect(onOpenHistory).toHaveBeenCalledWith(OPS.port, 'port-24');
  expect(vi.mocked(fetchWithAuth).mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
});

it('never presents an unmeasured link as healthy', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(json(unmeasuredLinkFixture()));
  render(<LinkHealthPanel siteId={OPS.site} relationshipId={OPS.relationship} labels={{ source: null, target: null }} onOpenHistory={() => {}} />);
  expect(await screen.findByTestId('topology-health-freshness')).toHaveTextContent('Not measured');
  expect(screen.getByTestId('topology-link-status')).toHaveTextContent('Not measured');
  expect(screen.queryByTestId('topology-history-open-source')).toBeNull();
});

it('states when port measurement cannot describe a connection', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(json(linkHealthFixture({ interfaceEvidence: { applies: false, reason: 'membership_relationship' }, endpoints: { source: null, target: null } })));
  render(<LinkHealthPanel siteId={OPS.site} relationshipId={OPS.relationship} labels={{ source: null, target: null }} onOpenHistory={() => {}} />);
  expect(await screen.findByTestId('topology-link-interface-evidence')).toHaveTextContent('does not describe this connection');
});
