import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { AiAgentImpactDto } from '@breeze/shared';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

// Pin the org-scope selectors so the page doesn't reach for a real store —
// same pattern as RunsListPage.test.tsx.
let mockCurrentOrgId: string | null = 'org-1';
let mockAllOrgs = false;
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null; allOrgs: boolean }) => unknown) =>
    selector({ currentOrgId: mockCurrentOrgId, allOrgs: mockAllOrgs }),
}));

// recharts' ResponsiveContainer measures itself with ResizeObserver and renders
// NOTHING at jsdom's zero width, so the real chart can never carry an
// assertion. Stub it and capture the `data` prop instead: the thing under test
// is the DISJOINT series this page computes, not recharts' SVG.
const chartDataCalls: Array<Array<Record<string, unknown>>> = [];
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  BarChart: ({ data, children }: { data?: Array<Record<string, unknown>>; children?: ReactNode }) => {
    chartDataCalls.push(data ?? []);
    return <div>{children}</div>;
  },
  Bar: ({ dataKey }: { dataKey?: string }) => <div data-testid={`ai-impact-chart-series-${dataKey}`} />,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
  Legend: () => null,
}));

// runAction toasts through this module; capturing it here also captures the
// page's own non-ActionError fallback toast.
const toasts: Array<{ message: string; type: string }> = [];
vi.mock('../shared/Toast', () => ({
  showToast: (toast: { message: string; type: string }) => {
    toasts.push(toast);
  },
}));

const exportReportCalls: Array<{ rows: unknown[]; opts: Record<string, unknown> }> = [];
vi.mock('../reports/reportExport', () => ({
  exportReport: (rows: unknown[], opts: Record<string, unknown>) => {
    exportReportCalls.push({ rows, opts });
    return Promise.resolve();
  },
}));

// The drawer has its own full test suite (ImpactWeightsDrawer.test.tsx) —
// stub it here to a thin marker so this page's tests exercise only the
// gating (canEditWeights) and the open/close wiring, not the drawer's own
// save/reset behavior.
vi.mock('./ImpactWeightsDrawer', () => ({
  default: ({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) =>
    open ? (
      <div data-testid="ai-impact-weights-drawer-stub">
        <button type="button" data-testid="stub-drawer-close" onClick={onClose}>
          close
        </button>
        <button type="button" data-testid="stub-drawer-saved" onClick={onSaved}>
          saved
        </button>
      </div>
    ) : null,
}));

import ImpactPage from './ImpactPage';
import { fetchWithAuth } from '../../stores/auth';

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, ok = true, status = 200): Response =>
  ({ ok, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

// NON-UNIFORM by construction: every counter and every day carries a distinct
// value, so a tile or a chart series wired to the wrong field fails instead of
// coincidentally matching its neighbour.
function dto(overrides: Partial<AiAgentImpactDto> = {}): AiAgentImpactDto {
  return {
    schemaVersion: 1,
    window: 30,
    through: '2026-08-31',
    rebuiltAt: '2026-09-01T02:00:00.000Z',
    totals: {
      alertsJudged: 10,
      noiseFlagged: 4,
      suppressionsApplied: 3,
      ticketsTriaged: 7,
      draftsSent: 5,
      fixesProposed: 9,
      fixesExecuted: 2,
      fixWatchesHeld: 6,
      fixWatchesRecurred: 1,
      narrativesDelivered: 8,
      estSecondsSaved: 18_000,
      llmCents: 4321,
    },
    series: [
      {
        day: '2026-08-30',
        alertsJudged: 10,
        noiseFlagged: 4,
        suppressionsApplied: 3,
        ticketsTriaged: 7,
        draftsSent: 5,
        fixesProposed: 9,
        fixesExecuted: 2,
        fixWatchesHeld: 6,
        fixWatchesRecurred: 1,
        narrativesDelivered: 8,
        estSecondsSaved: 12_000,
        llmCents: 1111,
      },
      {
        day: '2026-08-31',
        alertsJudged: 21,
        noiseFlagged: 30,
        suppressionsApplied: 22,
        ticketsTriaged: 23,
        draftsSent: 24,
        fixesProposed: 25,
        fixesExecuted: 26,
        fixWatchesHeld: 27,
        fixWatchesRecurred: 28,
        narrativesDelivered: 29,
        estSecondsSaved: 6_000,
        llmCents: 3210,
      },
    ],
    byOrg: [],
    byOrgTruncated: false,
    positiveFeedback: { up: 12, down: 3, rate: 0.8 },
    promoteEligibleCount: 5,
    weights: {
      effective: {
        alertJudged: 90,
        noiseFlagged: 240,
        ticketTriaged: 360,
        draftSent: 300,
        fixExecuted: 900,
        narrativeDelivered: 1800,
      },
      overrides: null,
    },
    canEditWeights: true,
    ...overrides,
  };
}

function mockImpact(body: AiAgentImpactDto | (() => AiAgentImpactDto)) {
  fetchMock.mockImplementation((url: string) => {
    if (url.startsWith('/api/ai/agents/impact/rebuild')) {
      return Promise.resolve(json({ queued: 1, from: '2026-06-03', through: '2026-08-31' }, true, 202));
    }
    if (url.startsWith('/api/ai/agents/impact')) {
      return Promise.resolve(json({ data: typeof body === 'function' ? body() : body }));
    }
    return Promise.resolve(json({ data: null }, false, 404));
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  chartDataCalls.length = 0;
  toasts.length = 0;
  exportReportCalls.length = 0;
  mockCurrentOrgId = 'org-1';
  mockAllOrgs = false;
  window.location.hash = '';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ImpactPage', () => {
  it('renders each counter tile from the DTO, and the estimate beside actual spend', async () => {
    mockImpact(dto());
    render(<ImpactPage />);

    await waitFor(() => expect(screen.getByTestId('ai-impact-tile-alerts-judged')).toBeInTheDocument());
    expect(screen.getByTestId('ai-impact-tile-alerts-judged')).toHaveTextContent('10');
    expect(screen.getByTestId('ai-impact-tile-noise-flagged')).toHaveTextContent('4');
    expect(screen.getByTestId('ai-impact-tile-tickets-triaged')).toHaveTextContent('7');
    expect(screen.getByTestId('ai-impact-tile-drafts-sent')).toHaveTextContent('5');
    expect(screen.getByTestId('ai-impact-tile-fixes-executed')).toHaveTextContent('2');

    // 18000 s = 5 hours, and the label must say it is an ESTIMATE.
    const estimate = screen.getByTestId('ai-impact-tile-est-seconds-saved');
    expect(estimate).toHaveTextContent('Estimated time saved');
    expect(estimate).toHaveTextContent('5');
    // 4321 cents rendered as money, never as a raw cent count.
    expect(screen.getByTestId('ai-impact-tile-llm-cents')).toHaveTextContent('$43.21');
  });

  it('lists the effective weights in the estimate tile tooltip', async () => {
    mockImpact(dto());
    render(<ImpactPage />);

    await waitFor(() => expect(screen.getByTestId('ai-impact-tile-est-seconds-saved')).toBeInTheDocument());
    const title = screen.getByTestId('ai-impact-tile-est-seconds-saved').getAttribute('title') ?? '';
    // Six priced outcomes, in minutes: 90s, 240s, 360s, 300s, 900s, 1800s.
    for (const minutes of ['1.5', '4', '6', '5', '15', '30']) {
      expect(title).toContain(minutes);
    }
  });

  it('defaults to the 30-day window and refetches + rewrites the hash on change', async () => {
    mockImpact(dto());
    render(<ImpactPage />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe('/api/ai/agents/impact?window=30');

    fireEvent.click(screen.getByTestId('ai-impact-window-90'));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url === '/api/ai/agents/impact?window=90')).toBe(true),
    );
    expect(window.location.hash).toBe('#90');
  });

  it('adopts the window from the hash on mount', async () => {
    window.location.hash = '#7';
    mockImpact(dto());
    render(<ImpactPage />);

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url === '/api/ai/agents/impact?window=7')).toBe(true),
    );
  });

  it('charts DISJOINT series — the non-noise arm is alertsJudged MINUS noiseFlagged', async () => {
    mockImpact(dto());
    render(<ImpactPage />);

    await waitFor(() => expect(chartDataCalls.length).toBeGreaterThan(0));
    const rows = chartDataCalls[chartDataCalls.length - 1];
    expect(rows).toHaveLength(2);
    // Day 1: alertsJudged 10, noiseFlagged 4 -> 6, never 10.
    expect(rows[0]).toMatchObject({
      day: '2026-08-30',
      noiseFlagged: 4,
      alertsJudgedNet: 6,
      ticketsTriaged: 7,
      fixesExecuted: 2,
    });
    // Day 2: noise (30) exceeds judged (21) -> clamped at 0, never negative.
    expect(rows[1]).toMatchObject({
      day: '2026-08-31',
      noiseFlagged: 30,
      alertsJudgedNet: 0,
      ticketsTriaged: 23,
      fixesExecuted: 26,
    });
  });

  it('hides the per-org table when byOrg is empty', async () => {
    mockImpact(dto());
    render(<ImpactPage />);

    await waitFor(() => expect(screen.getByTestId('ai-impact-tile-alerts-judged')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-impact-by-org')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-impact-by-org-truncated')).not.toBeInTheDocument();
  });

  it('shows the per-org table, and the truncation line only when byOrgTruncated', async () => {
    mockImpact(
      dto({
        byOrg: [
          {
            orgId: 'org-1',
            orgName: 'Acme Corp',
            alertsJudged: 11,
            noiseFlagged: 12,
            suppressionsApplied: 13,
            ticketsTriaged: 14,
            draftsSent: 15,
            fixesProposed: 16,
            fixesExecuted: 17,
            fixWatchesHeld: 18,
            fixWatchesRecurred: 19,
            narrativesDelivered: 20,
            estSecondsSaved: 7_200,
            llmCents: 500,
          },
        ],
        byOrgTruncated: true,
      }),
    );
    render(<ImpactPage />);

    await waitFor(() => expect(screen.getByTestId('ai-impact-by-org')).toBeInTheDocument());
    expect(screen.getByTestId('ai-impact-by-org-row-org-1')).toHaveTextContent('Acme Corp');
    expect(screen.getByTestId('ai-impact-by-org-truncated')).toBeInTheDocument();
  });

  it('renders the freshness line, and the never-rebuilt variant when rebuiltAt is null', async () => {
    mockImpact(dto());
    const view = render(<ImpactPage />);

    await waitFor(() => expect(screen.getByTestId('ai-impact-freshness')).toBeInTheDocument());
    expect(screen.getByTestId('ai-impact-freshness')).toHaveTextContent('2026-08-31');
    expect(screen.getByTestId('ai-impact-freshness')).toHaveTextContent('UTC');
    expect(screen.getByTestId('ai-impact-freshness')).not.toHaveTextContent('never');
    view.unmount();

    mockImpact(dto({ rebuiltAt: null }));
    render(<ImpactPage />);
    await waitFor(() => expect(screen.getByTestId('ai-impact-freshness')).toHaveTextContent('never'));
  });

  it('hides the positive-feedback readout when the rate is null', async () => {
    mockImpact(dto());
    const view = render(<ImpactPage />);
    await waitFor(() => expect(screen.getByTestId('ai-impact-positive-feedback')).toBeInTheDocument());
    // Never "precision" / "accuracy" — a thumbs-up is a supervision signal.
    expect(screen.getByTestId('ai-impact-positive-feedback')).toHaveTextContent('Positive feedback rate');
    view.unmount();

    mockImpact(dto({ positiveFeedback: { up: 0, down: 0, rate: null } }));
    render(<ImpactPage />);
    await waitFor(() => expect(screen.getByTestId('ai-impact-tile-alerts-judged')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-impact-positive-feedback')).not.toBeInTheDocument();
  });

  it('POSTs the rebuild, then polls until rebuiltAt advances and stops', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let rebuiltAt = '2026-09-01T02:00:00.000Z';
    mockImpact(() => dto({ rebuiltAt }));
    render(<ImpactPage />);

    await vi.waitFor(() =>
      expect(screen.getByTestId('ai-impact-tile-alerts-judged')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('ai-impact-refresh'));

    // The poll is armed only once the enqueue POST has resolved — a disabled
    // Refresh button is that state made visible.
    await vi.waitFor(() => expect(screen.getByTestId('ai-impact-refresh')).toBeDisabled());
    expect(
      fetchMock.mock.calls.some(([url, init]) =>
        url === '/api/ai/agents/impact/rebuild' && (init as RequestInit | undefined)?.method === 'POST',
      ),
    ).toBe(true);

    // First tick: the rollup has not landed yet, so polling continues.
    const beforeFirstTick = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(beforeFirstTick);
    expect(screen.getByTestId('ai-impact-refresh')).toBeDisabled();

    // Second tick: rebuiltAt advances, so the poll stops.
    rebuiltAt = '2026-09-01T03:00:00.000Z';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByTestId('ai-impact-refresh')).not.toBeDisabled();
    expect(toasts.some((toast) => toast.type === 'success')).toBe(true);

    const settled = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock.mock.calls.length).toBe(settled);
  });

  it('gives up polling after two minutes with a toast', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockImpact(dto());
    render(<ImpactPage />);

    await vi.waitFor(() =>
      expect(screen.getByTestId('ai-impact-tile-alerts-judged')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('ai-impact-refresh'));
    await vi.waitFor(() => expect(screen.getByTestId('ai-impact-refresh')).toBeDisabled());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(125_000);
    });
    expect(screen.getByTestId('ai-impact-refresh')).not.toBeDisabled();
    expect(toasts.some((toast) => toast.type === 'warning')).toBe(true);

    const settled = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock.mock.calls.length).toBe(settled);
  });

  it('surfaces a toast when the rebuild fails, and stays silent on a 401', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/ai/agents/impact/rebuild')) {
        return Promise.resolve(json({ error: 'Rebuild refused' }, false, 500));
      }
      return Promise.resolve(json({ data: dto() }));
    });
    const view = render(<ImpactPage />);

    await waitFor(() => expect(screen.getByTestId('ai-impact-refresh')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('ai-impact-refresh'));
    await waitFor(() => expect(toasts.some((toast) => toast.type === 'error')).toBe(true));
    // A failed enqueue must NOT start the poll.
    expect(screen.getByTestId('ai-impact-refresh')).not.toBeDisabled();
    view.unmount();

    toasts.length = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/ai/agents/impact/rebuild')) {
        return Promise.resolve(json({ error: 'Unauthorized' }, false, 401));
      }
      return Promise.resolve(json({ data: dto() }));
    });
    render(<ImpactPage />);
    await waitFor(() => expect(screen.getByTestId('ai-impact-refresh')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('ai-impact-refresh'));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => url === '/api/ai/agents/impact/rebuild'),
      ).toBe(true),
    );
    expect(toasts).toEqual([]);
  });

  it('translates the rebuild route\u2019s machine tokens instead of toasting them raw', async () => {
    // The route answers 409 `{ error: 'too_many_orgs', limit, count }` above 200
    // accessible orgs and 400 `{ error: 'org_id_required' }` for a system-scoped
    // caller. Neither carries a `code`, so runAction falls back to `body.error`
    // and would toast the bare token at the partner this page is built for.
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/ai/agents/impact/rebuild')) {
        return Promise.resolve(json({ error: 'too_many_orgs', limit: 200, count: 412 }, false, 409));
      }
      return Promise.resolve(json({ data: dto() }));
    });
    const view = render(<ImpactPage />);

    await waitFor(() => expect(screen.getByTestId('ai-impact-refresh')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('ai-impact-refresh'));
    await waitFor(() => expect(toasts.some((toast) => toast.type === 'error')).toBe(true));

    expect(toasts.some((toast) => toast.message.includes('too_many_orgs'))).toBe(false);
    expect(
      toasts.some((toast) => toast.message.includes('more than 200 organizations')),
    ).toBe(true);
    // A refused enqueue must not arm the poll either.
    expect(screen.getByTestId('ai-impact-refresh')).not.toBeDisabled();
    view.unmount();

    toasts.length = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/ai/agents/impact/rebuild')) {
        return Promise.resolve(
          json(
            { error: 'org_id_required', message: 'A system-scoped impact rebuild must name one organization.' },
            false,
            400,
          ),
        );
      }
      return Promise.resolve(json({ data: dto() }));
    });
    render(<ImpactPage />);
    await waitFor(() => expect(screen.getByTestId('ai-impact-refresh')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('ai-impact-refresh'));
    await waitFor(() => expect(toasts.some((toast) => toast.type === 'error')).toBe(true));

    expect(toasts.some((toast) => toast.message.includes('org_id_required'))).toBe(false);
    expect(
      toasts.some((toast) => toast.message.includes('organization switcher')),
    ).toBe(true);
  });

  it('refetches when the org switcher selects a different organization', async () => {
    // `currentOrgId` is not READ inside requestImpact — fetchWithAuth injects
    // `?orgId=` itself — so the only thing keeping it in the dependency list is
    // this behaviour. Without the control re-render below, an autofix that drops
    // the "unused" dep would leave the suite green and the page showing the
    // previous customer’s totals.
    mockImpact(dto());
    const view = render(<ImpactPage />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const afterFirstLoad = fetchMock.mock.calls.length;

    // Control: a re-render with the SAME org must not refetch, so the assertion
    // below is about the scope change and not about render churn.
    view.rerender(<ImpactPage />);
    expect(fetchMock.mock.calls.length).toBe(afterFirstLoad);

    mockCurrentOrgId = 'org-2';
    view.rerender(<ImpactPage />);

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(afterFirstLoad));
  });

  it('renders an error state with a working retry when the load fails', async () => {
    fetchMock.mockResolvedValue(json({ error: 'boom' }, false, 500));
    render(<ImpactPage />);

    await waitFor(() => expect(screen.getByTestId('ai-impact-error')).toBeInTheDocument());

    mockImpact(dto());
    fireEvent.click(screen.getByTestId('ai-impact-retry'));
    await waitFor(() => expect(screen.getByTestId('ai-impact-tile-alerts-judged')).toBeInTheDocument());
  });

  it('shows the edit-weights button only when canEditWeights is true', async () => {
    mockImpact(dto({ canEditWeights: false }));
    const view = render(<ImpactPage />);
    await waitFor(() => expect(screen.getByTestId('ai-impact-tile-alerts-judged')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-impact-edit-weights')).not.toBeInTheDocument();
    view.unmount();

    mockImpact(dto({ canEditWeights: true }));
    render(<ImpactPage />);
    await waitFor(() => expect(screen.getByTestId('ai-impact-edit-weights')).toBeInTheDocument());
  });

  it('opens the weights drawer, and a save refetches the DTO', async () => {
    mockImpact(dto({ canEditWeights: true }));
    render(<ImpactPage />);
    await waitFor(() => expect(screen.getByTestId('ai-impact-edit-weights')).toBeInTheDocument());

    expect(screen.queryByTestId('ai-impact-weights-drawer-stub')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ai-impact-edit-weights'));
    expect(screen.getByTestId('ai-impact-weights-drawer-stub')).toBeInTheDocument();

    const afterOpen = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByTestId('stub-drawer-saved'));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(afterOpen));
    // onSaved also closes the drawer.
    await waitFor(() =>
      expect(screen.queryByTestId('ai-impact-weights-drawer-stub')).not.toBeInTheDocument(),
    );
  });

  it('closes the weights drawer on close without refetching', async () => {
    mockImpact(dto({ canEditWeights: true }));
    render(<ImpactPage />);
    await waitFor(() => expect(screen.getByTestId('ai-impact-edit-weights')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('ai-impact-edit-weights'));
    expect(screen.getByTestId('ai-impact-weights-drawer-stub')).toBeInTheDocument();

    const beforeClose = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByTestId('stub-drawer-close'));
    expect(screen.queryByTestId('ai-impact-weights-drawer-stub')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBe(beforeClose);
  });

  it('exports the PDF with reportType ai_agent_impact, UTC timezone, and uniform metric/value rows', async () => {
    mockImpact(dto());
    render(<ImpactPage />);
    await waitFor(() => expect(screen.getByTestId('ai-impact-export-pdf')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('ai-impact-export-pdf'));

    await waitFor(() => expect(exportReportCalls.length).toBe(1));
    const call = exportReportCalls[0]!;
    expect(call.opts).toMatchObject({ format: 'pdf', reportType: 'ai_agent_impact', timezone: 'UTC' });
    expect(call.rows.length).toBeGreaterThan(0);
    for (const row of call.rows) {
      expect(Object.keys(row as Record<string, unknown>).sort()).toEqual(['metric', 'value']);
    }
  });
});

describe('buildImpactPdfRows', () => {
  it('returns one row per counter, plus estimate/spend/window/through/rebuiltAt, plus the six weights', async () => {
    const { buildImpactPdfRows } = await import('./ImpactPage');
    const t = (key: string) => key;
    const rows = buildImpactPdfRows(dto(), t);
    // 10 counters + estTimeSaved + llmSpend + window + through + rebuiltAt + 6 weights = 21
    expect(rows).toHaveLength(21);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['metric', 'value']);
      expect(typeof row.metric).toBe('string');
      expect(typeof row.value).toBe('string');
    }
  });

  it('renders "never rebuilt" copy when rebuiltAt is null, not a blank/NaN value', async () => {
    const { buildImpactPdfRows } = await import('./ImpactPage');
    const t = (key: string) => key;
    const rows = buildImpactPdfRows(dto({ rebuiltAt: null }), t);
    const rebuiltRow = rows.find((row) => row.metric === 'aiAgentsPage.impact.pdf.metrics.rebuiltAt');
    expect(rebuiltRow?.value).toBe('aiAgentsPage.impact.pdf.neverRebuilt');
  });
});

describe('ImpactPage — promotion-eligible tile', () => {
  it('renders the count and links to the graduation panel', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: dto() }));
    render(<ImpactPage />);

    const tile = await screen.findByTestId('ai-impact-tile-promote-eligible');
    expect(tile).toHaveTextContent('5');
    expect(tile.getAttribute('href')).toBe('/settings/ai-agents');
  });

  it('renders 0 as a tile, not as a hidden one', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: dto({ promoteEligibleCount: 0 }) }));
    render(<ImpactPage />);

    expect(await screen.findByTestId('ai-impact-tile-promote-eligible')).toHaveTextContent('0');
  });

  it('hides the tile when the API returns null (an older API behind a newer build)', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: dto({ promoteEligibleCount: null }) }));
    render(<ImpactPage />);

    await screen.findByTestId('ai-impact-tile-llm-cents');
    expect(screen.queryByTestId('ai-impact-tile-promote-eligible')).toBeNull();
  });
});
