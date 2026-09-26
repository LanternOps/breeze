import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diagnosticPlanFixture } from '../../../../../packages/shared/src/testing/topologyFixtures';
import { fetchWithAuth } from '../../stores/auth';
import TopologyDiagnosticsPanel from './TopologyDiagnosticsPanel';
import TraceResultPanel from './TraceResultPanel';
import { traceRunFixture, OPS } from './operationsFixtures';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
afterEach(() => { cleanup(); window.location.hash = ''; });

it('renders the observed routed path with a silent hop as unknown, never an invented responder', () => {
  render(<TraceResultPanel run={traceRunFixture()} />);
  expect(screen.getByTestId('topology-trace-path')).toHaveTextContent('not a topology connection');
  expect(screen.getByTestId('topology-trace-outcome')).toHaveTextContent('Destination not reached');
  const hops = within(screen.getByTestId('topology-trace-hops')).getAllByTestId('topology-trace-hop');
  expect(hops).toHaveLength(2);
  expect(hops[0]).toHaveTextContent('192.0.2.254');
  expect(hops[0]).toHaveTextContent('1.5 ms');
  expect(hops[1]).toHaveTextContent('Unknown (no reply)');
  expect(hops[1]).not.toHaveTextContent(/\d+\.\d+\.\d+\.\d+/);
});

it('renders nothing for a run without trace steps', () => {
  const run = traceRunFixture();
  const { container } = render(<TraceResultPanel run={{ ...run, steps: [] }} />);
  expect(container).toBeEmptyDOMElement();
});

describe('diagnostics trace request', () => {
  const plan = diagnosticPlanFixture();
  beforeEach(() => {
    window.location.hash = '#topology';
    vi.mocked(fetchWithAuth).mockReset().mockImplementation(async (url) => {
      if (String(url).includes('/collectors')) return new Response(JSON.stringify({ items: [{ origin: plan.origin, eligible: true, reasons: [], families: ['ipv4'], rank: 0 }], nextCursor: null }));
      return new Response(JSON.stringify({ ...traceRunFixture(), state: 'queued', steps: [], finishedAt: null, startedAt: null }));
    });
  });

  it('offers trace_route with bounded hops and probes and sends them only on explicit start', async () => {
    render(<TopologyDiagnosticsPanel siteId={OPS.site} subject={plan.subject} graphRevision="1" onClose={() => {}} />);
    fireEvent.change(screen.getByTestId('topology-recipe'), { target: { value: 'trace_route' } });
    const hops = screen.getByTestId('topology-trace-max-hops');
    expect(hops).toHaveAttribute('max', '30');
    expect(screen.getByTestId('topology-trace-probes')).toHaveAttribute('max', '2');
    fireEvent.change(hops, { target: { value: '8' } });
    fireEvent.change(screen.getByTestId('topology-trace-probes'), { target: { value: '2' } });
    await waitFor(() => expect(screen.getByTestId('topology-trace-start')).toBeEnabled());
    expect(vi.mocked(fetchWithAuth).mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
    fireEvent.click(screen.getByTestId('topology-trace-start'));
    await screen.findByTestId(`topology-run-${OPS.run}`);
    const post = vi.mocked(fetchWithAuth).mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(String(post[1]!.body))).toMatchObject({ recipeId: 'trace_route', trace: { maxHops: 8, probesPerHop: 2 } });
  });
});
