import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '../../stores/auth';
import ImpactPanel from './ImpactPanel';
import RecentChangesPanel from './RecentChangesPanel';
import { changesFixture, impactFixture, OPS } from './operationsFixtures';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });
beforeEach(() => { vi.mocked(fetchWithAuth).mockReset(); });
afterEach(() => cleanup());
const onlyGets = () => vi.mocked(fetchWithAuth).mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET');

it('loads impact only on request, separates measured failures from possible dependencies, and labels uncertainty', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(json(impactFixture()));
  render(<ImpactPanel siteId={OPS.site} subject={{ kind: 'relationship', id: OPS.relationship }} graphRevision="3" />);
  expect(fetchWithAuth).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId('topology-impact-load'));
  const measured = await screen.findByTestId('topology-impact-measured');
  expect(within(measured).getAllByTestId('topology-impact-measured-item')).toHaveLength(1);
  const potential = within(screen.getByTestId('topology-impact-potential')).getAllByTestId('topology-impact-potential-item');
  expect(potential[0]).toHaveTextContent('Desk switch');
  expect(potential[0]).toHaveTextContent('whether it carries traffic is not verified');
  expect(potential[1]).toHaveTextContent('possible only');
  expect(screen.getByTestId('topology-impact-routed')).toHaveTextContent('1 silent hops');
  expect(screen.getByTestId('topology-impact-cause')).toHaveTextContent('No cause is suggested');
  expect(screen.getByTestId('topology-impact-no-alerts')).toBeVisible();
  const [url] = vi.mocked(fetchWithAuth).mock.calls[0]!;
  expect(String(url)).toBe(`/topology/sites/${OPS.site}/impact?subjectKind=relationship&subjectId=${OPS.relationship}&windowMinutes=5&graphRevision=3`);
  expect(onlyGets()).toBe(true);
});

it('marks hypothetical analysis, partial traversal, and a changed map', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValueOnce(json(impactFixture({ subject: { kind: 'node', id: OPS.node, measured: false }, measuredFailures: [], coverage: 'partial', reasons: ['traversal_limit'] })));
  render(<ImpactPanel siteId={OPS.site} subject={{ kind: 'node', id: OPS.node }} graphRevision="3" />);
  fireEvent.click(screen.getByTestId('topology-impact-load'));
  expect(await screen.findByTestId('topology-impact-hypothetical')).toBeVisible();
  expect(screen.getByTestId('topology-impact-partial')).toHaveTextContent('traversal limit');
  vi.mocked(fetchWithAuth).mockResolvedValueOnce(json({ error: 'Graph revision changed', code: 'graph_revision_changed' }, 409));
  fireEvent.click(screen.getByTestId('topology-impact-load'));
  expect(await screen.findByTestId('topology-impact-changed')).toBeVisible();
});

it('recent changes are on demand, labelled by kind and category, and mark expired detail', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(json(changesFixture({ cursor: 'next-page' })));
  render(<RecentChangesPanel siteId={OPS.site} />);
  expect(fetchWithAuth).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId('topology-changes-load'));
  const rows = await screen.findAllByTestId('topology-change');
  expect(rows[0]).toHaveTextContent('Connection observed');
  expect(rows[0]).toHaveTextContent('Physical link');
  expect(within(rows[1]!).getByTestId('topology-change-expired')).toHaveTextContent('Detail expired');
  vi.mocked(fetchWithAuth).mockResolvedValueOnce(json(changesFixture({ changes: [], cursor: null })));
  fireEvent.click(screen.getByTestId('topology-changes-more'));
  await waitFor(() => expect(String(vi.mocked(fetchWithAuth).mock.calls[1]![0])).toContain('cursor=next-page'));
  expect(onlyGets()).toBe(true);
});
