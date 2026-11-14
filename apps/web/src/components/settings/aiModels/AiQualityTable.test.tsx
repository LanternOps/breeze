import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { jsonRes } from './testFixtures';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import { navigateTo } from '@/lib/navigation';
import AiQualityTable from './AiQualityTable';

beforeEach(() => fetchWithAuth.mockReset());

describe('AiQualityTable', () => {
  it('sends the range only when both ends are set, and reports the resolved range', async () => {
    const onRange = vi.fn();
    fetchWithAuth.mockResolvedValue(jsonRes({ groupBy: 'surface', from: '2026-10-01', to: '2026-10-17', orgId: null, rows: [], totals: {}, sources: { failovers: true, continuations: true } }));
    render(<AiQualityTable groupBy="surface" orgId={null} from="" to="" onRange={onRange} />);
    expect(await screen.findByTestId('ai-quality-empty')).toBeTruthy();
    expect(fetchWithAuth.mock.calls[0][0]).toBe('/ai/models/usage/quality?groupBy=surface');
    expect(onRange).toHaveBeenCalledWith({ from: '2026-10-01', to: '2026-10-17' });
  });
  it('401 routes to login', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({}, 401));
    render(<AiQualityTable groupBy="model" orgId={null} from="" to="" onRange={vi.fn()} />);
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/login', { replace: true }));
  });
  it('a malformed body or a failure shows the error state and logs it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchWithAuth.mockResolvedValue(jsonRes({ rows: 'nope' }));
    render(<AiQualityTable groupBy="model" orgId={null} from="" to="" onRange={vi.fn()} />);
    expect(await screen.findByTestId('ai-quality-error')).toBeTruthy();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
  it('groups by tool profile: header, profile labels, unrecorded rows and the refused tool-call column (W04 #11397)', async () => {
    const m = {
      invocations: 10, costCents: 100, refusals: 0, refusalRate: 0, refusedToolBatches: 3, refusedToolBatchRate: 0.3,
      failovers: null, failoverRate: null, conversations: 3, costPerConversationCents: 33, sessions: 3, flagged: 0, autoFlagged: 0,
      flagRate: 0, switchedAway: 0, continued: null, leftRate: 0, resolvedSessions: 0, medianTurnsToResolution: null,
      agentRuns: 0, agentRunsCompleted: 0, agentCompletionRate: null,
    };
    fetchWithAuth.mockResolvedValue(jsonRes({
      groupBy: 'tool_profile', from: '2026-10-01', to: '2026-10-17', orgId: null,
      rows: [{ ...m, key: 'minimal', label: null, connectionName: null }, { ...m, key: 'unrecorded', label: null, connectionName: null, refusedToolBatches: 0, refusedToolBatchRate: 0 }],
      totals: m, sources: { failovers: false, continuations: false },
    }));
    render(<AiQualityTable groupBy="tool_profile" orgId={null} from="" to="" onRange={vi.fn()} />);
    const table = await screen.findByTestId('ai-quality-table');
    expect(fetchWithAuth.mock.calls[0][0]).toBe('/ai/models/usage/quality?groupBy=tool_profile');
    expect(table.querySelector('thead')!.textContent).toMatch(/Tool profile/);
    expect(table.querySelector('thead')!.textContent).toMatch(/Unusable tool calls/);
    expect(screen.getByTestId('ai-quality-row-minimal').textContent).toMatch(/^Minimal/);
    expect(screen.getByTestId('ai-quality-row-unrecorded').textContent).toMatch(/^Not recorded/);
    expect(screen.getByTestId('ai-quality-refused-batch-minimal').textContent).toMatch(/30%.*3 refused/);
    expect(screen.getByTestId('ai-quality-refused-batch-unrecorded').textContent).toBe('0%');
  });
});
