import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '../../stores/auth';
import InterfaceHistoryPanel from './InterfaceHistoryPanel';
import { historyFixture, OPS } from './operationsFixtures';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });
beforeEach(() => { vi.mocked(fetchWithAuth).mockReset().mockImplementation(async () => json(historyFixture())); });
afterEach(() => cleanup());

it('draws each generation as its own series, keeps a measured zero, and shows a gap as not measured', async () => {
  render(<InterfaceHistoryPanel siteId={OPS.site} interfaceId={OPS.port} label="port-24" />);
  const series = await screen.findAllByTestId('topology-history-series');
  expect(series.map((node) => node.getAttribute('data-epoch'))).toEqual(['gen:1', 'gen:2']);
  expect(screen.getByTestId('topology-history-generation-break')).toHaveTextContent('generation');
  expect(within(series[0]!).getByText(/Previous interface generation/)).toBeVisible();
  expect(within(series[0]!).getByText(/Source stopped/)).toBeVisible();
  expect(within(series[1]!).getByText(/Bits per second/)).toBeVisible();
  expect(within(series[1]!).getByTestId('topology-history-gaps')).toHaveTextContent('collection gap');
  // The chart never bridges the null bucket: the current series is two separate marks.
  const chart = within(series[1]!).getByTestId('topology-history-chart');
  expect(chart.querySelectorAll('polyline, circle')).toHaveLength(2);
  // The table carries exactly the chart's values: zero stays zero, null is "Not measured".
  const values = screen.getAllByTestId('topology-history-value').map((cell) => cell.textContent);
  expect(values).toEqual(['2.5 Mbps', '0 bps', 'Not measured', '1 Mbps']);
});

it('reads once per explicit choice with GET only, and changing the metric requests only its series', async () => {
  render(<InterfaceHistoryPanel siteId={OPS.site} interfaceId={OPS.port} label="port-24" />);
  await screen.findAllByTestId('topology-history-series');
  expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  const [url, options] = vi.mocked(fetchWithAuth).mock.calls[0]!;
  expect(String(url)).toContain(`/topology/sites/${OPS.site}/interfaces/${OPS.port}/history?series=in_bps%2Cout_bps`);
  expect(options?.method ?? 'GET').toBe('GET');
  fireEvent.change(screen.getByTestId('topology-history-metric'), { target: { value: 'errors' } });
  await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(2));
  expect(String(vi.mocked(fetchWithAuth).mock.calls[1]![0])).toContain('series=in_errors_per_second%2Cout_errors_per_second%2Cin_discards_per_second%2Cout_discards_per_second');
  expect(vi.mocked(fetchWithAuth).mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
});

it('surfaces a denied chart read without data', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(json({ error: 'Forbidden' }, 403));
  render(<InterfaceHistoryPanel siteId={OPS.site} interfaceId={OPS.port} label="port-24" />);
  expect(await screen.findByTestId('topology-history-error')).toHaveTextContent('Access to this topology is denied');
  expect(screen.queryByTestId('topology-history-series')).toBeNull();
});
