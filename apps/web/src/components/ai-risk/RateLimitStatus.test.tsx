import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, within } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
}));

import { RateLimitStatus } from './RateLimitStatus';

function jsonRes(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function renderIt() {
  const { container, ...utils } = render(<RateLimitStatus />);
  return { container, ...utils, ...within(container) };
}

beforeEach(() => {
  fetchWithAuth.mockReset();
});

describe('RateLimitStatus — effective limits from the API (#6476)', () => {
  it('shows the effective (multiplied) limit served by the API, not a static copy', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({
      orgId: 'org-1',
      multiplier: 3,
      limits: [
        { toolName: 'run_script', baseLimit: 5, limit: 15, windowSeconds: 300 },
        { toolName: 'network_discovery', baseLimit: 2, limit: 6, windowSeconds: 600 },
      ],
    }));
    const { findByTestId, getByTestId } = renderIt();

    const row = await findByTestId('rate-limit-row-run_script');
    expect(fetchWithAuth).toHaveBeenCalledWith('/ai/tool-rate-limits');
    expect(within(row).getByTestId('rate-limit-effective').textContent).toContain('15');
    expect(within(row).getByTestId('rate-limit-base').textContent).toContain('5');
    expect(getByTestId('rate-limit-multiplier-note').textContent).toContain('3');
  });

  it('shows every tool the API returns, including ones the web metadata does not know', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({
      orgId: 'org-1',
      multiplier: 1,
      limits: [{ toolName: 'brand_new_tool', baseLimit: 4, limit: 4, windowSeconds: 60 }],
    }));
    const { findByTestId, queryByTestId } = renderIt();

    const row = await findByTestId('rate-limit-row-brand_new_tool');
    expect(within(row).getByTestId('rate-limit-effective').textContent).toContain('4');
    // Multiplier 1: no base-limit hint and no multiplier note.
    expect(within(row).queryByTestId('rate-limit-base')).toBeNull();
    expect(queryByTestId('rate-limit-multiplier-note')).toBeNull();
  });

  it('shows an error instead of stale numbers when the API fails', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ error: 'boom' }, 500));
    const { findByTestId, queryByTestId } = renderIt();

    expect(await findByTestId('rate-limits-error')).toBeTruthy();
    expect(queryByTestId('rate-limit-row-run_script')).toBeNull();
  });
});
