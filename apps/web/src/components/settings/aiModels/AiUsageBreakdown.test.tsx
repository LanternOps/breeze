import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { jsonRes } from './testFixtures';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import { navigateTo } from '@/lib/navigation';
import AiUsageBreakdown from './AiUsageBreakdown';

const A = 'platform:platform:claude-sonnet-x';
const ORG = '22222222-2222-4222-8222-222222222222';

const totals = { invocations: 80, costCents: 1234, inputTokens: 1, outputTokens: 2, refusals: 2, refusalRate: 0.025, fallbacks: 1 };
const emptyBreakdown = (groupBy: string) => ({
  groupBy, from: '2026-10-01', to: '2026-10-17', orgId: null, rows: [],
  totals: { invocations: 0, costCents: 0, inputTokens: 0, outputTokens: 0, refusals: 0, refusalRate: 0, fallbacks: 0 },
});

beforeEach(() => {
  fetchWithAuth.mockReset();
  window.location.hash = '';
});

describe('AiUsageBreakdown', () => {
  it('loads month-to-date by model and renders rows with refusal rate, footer totals and footnote', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({
      groupBy: 'model', from: '2026-10-01', to: '2026-10-17', orgId: null,
      rows: [{ key: A, label: 'Model A', invocations: 80, costCents: 1234, inputTokens: 1, outputTokens: 2, refusals: 2, refusalRate: 0.025, fallbacks: 1 }],
      totals,
    }));
    render(<AiUsageBreakdown orgId={null} />);
    expect((await screen.findByTestId(`ai-usage-breakdown-refusals-${A}`)).textContent).toMatch(/2 \(2\.5%\)/);
    expect(fetchWithAuth.mock.calls[0][0]).toMatch(/^\/ai\/models\/usage\?groupBy=model/);
    expect(fetchWithAuth.mock.calls[0][0]).not.toMatch(/from=/);
    expect(screen.getByTestId(`ai-usage-breakdown-row-${A}`).textContent).toMatch(/Model A.*\$12\.34/);
    expect(screen.getByTestId('ai-usage-breakdown-totals').textContent).toMatch(/\$12\.34/);
    expect(screen.getByTestId('ai-usage-breakdown').textContent).toMatch(/Refusal rate is per model call/);
    expect((screen.getByTestId('ai-usage-range-from') as HTMLInputElement).value).toBe('2026-10-01');
  });

  it('switches grouping, passes the org filter, and writes the hash', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes(emptyBreakdown('surface')));
    render(<AiUsageBreakdown orgId={ORG} />);
    fireEvent.click(await screen.findByTestId('ai-usage-groupby-surface'));
    await waitFor(() => expect(fetchWithAuth.mock.calls.at(-1)![0]).toMatch(new RegExp(`groupBy=surface.*orgId=${ORG}`)));
    expect(window.location.hash).toBe('#usage-by-surface');
  });

  it('reads the grouping from the hash on mount', async () => {
    window.location.hash = '#usage-by-org';
    fetchWithAuth.mockResolvedValue(jsonRes(emptyBreakdown('org')));
    render(<AiUsageBreakdown orgId={null} />);
    await waitFor(() => expect(fetchWithAuth.mock.calls[0][0]).toMatch(/groupBy=org/));
    expect(screen.getByTestId('ai-usage-groupby-org').getAttribute('aria-selected')).toBe('true');
  });

  it('follows hashchange', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes(emptyBreakdown('model')));
    render(<AiUsageBreakdown orgId={null} />);
    await screen.findByTestId('ai-usage-breakdown-empty');
    window.location.hash = '#usage-by-user';
    await waitFor(() => expect(fetchWithAuth.mock.calls.at(-1)![0]).toMatch(/groupBy=user/));
  });

  it('sends a range only once both dates are chosen', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes(emptyBreakdown('model')));
    render(<AiUsageBreakdown orgId={null} />);
    await screen.findByTestId('ai-usage-breakdown-empty');
    fireEvent.change(screen.getByTestId('ai-usage-range-from'), { target: { value: '2026-09-01' } });
    await waitFor(() => expect(fetchWithAuth.mock.calls.at(-1)![0]).toMatch(/from=2026-09-01&to=2026-10-17/));
  });

  it('labels surfaces and the system user with localized names', async () => {
    window.location.hash = '#usage-by-user';
    fetchWithAuth.mockResolvedValue(jsonRes({
      ...emptyBreakdown('user'),
      rows: [{ key: 'system', label: 'system', invocations: 1, costCents: 0, inputTokens: 0, outputTokens: 0, refusals: 0, refusalRate: 0, fallbacks: 0 }],
    }));
    render(<AiUsageBreakdown orgId={null} />);
    expect((await screen.findByTestId('ai-usage-breakdown-row-system')).textContent).toMatch(/System \/ agents/);
  });

  it('marks a model row whose serving connection was disconnected, and only that row', async () => {
    const GONE = 'partner_key:dddddddd-dddd-4ddd-8ddd-dddddddddddd:claude-sonnet-x';
    const LIVE = 'partner_key:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee:claude-sonnet-x';
    const row = (key: string, connectionDisconnected: boolean) => ({
      key, label: 'Sonnet X', invocations: 1, costCents: 10, inputTokens: 1, outputTokens: 1, refusals: 0, refusalRate: 0, fallbacks: 0, connectionDisconnected,
    });
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ ...emptyBreakdown('model'), rows: [row(GONE, true), row(LIVE, false)], totals }));
    render(<AiUsageBreakdown orgId={null} />);
    const marker = await screen.findByTestId(`ai-usage-breakdown-disconnected-${GONE}`);
    expect(marker.textContent).toBe('Disconnected');
    expect(marker.getAttribute('title')).toMatch(/connection that served these calls/i);
    expect(screen.getByTestId(`ai-usage-breakdown-row-${GONE}`).textContent).toMatch(/Sonnet X\s*Disconnected/);
    expect(screen.queryByTestId(`ai-usage-breakdown-disconnected-${LIVE}`)).toBeNull();
  });

  it('shows the empty state', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes(emptyBreakdown('model')));
    render(<AiUsageBreakdown orgId={null} />);
    await screen.findByTestId('ai-usage-breakdown-empty');
  });

  it('shows the error state on a failed load and logs the status', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'x' }, 500));
    render(<AiUsageBreakdown orgId={null} />);
    await screen.findByTestId('ai-usage-breakdown-error');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('AiUsageBreakdown'), expect.objectContaining({ message: '500' }));
    log.mockRestore();
  });

  it('routes a 401 to login instead of the error state', async () => {
    vi.mocked(navigateTo).mockClear();
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'x' }, 401));
    render(<AiUsageBreakdown orgId={null} />);
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/login', { replace: true }));
    expect(screen.queryByTestId('ai-usage-breakdown-error')).toBeNull();
  });
});
