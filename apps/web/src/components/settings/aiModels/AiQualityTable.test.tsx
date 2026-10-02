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
});
