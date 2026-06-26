import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { fetchWithAuth } = vi.hoisted(() => ({
  fetchWithAuth: vi.fn()
}));

vi.mock('../../lib/featureFlags', async (orig) => ({
  ...(await orig<typeof import('../../lib/featureFlags')>()),
  ENABLE_EDR_INTEGRATIONS: true
}));

vi.mock('./EdrSummaryPanel', () => ({
  default: () => <div data-testid="edr-summary-stub" />
}));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth
}));

import SecurityDashboard from './SecurityDashboard';

const makeTextResponse = (payload: unknown): Response =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: vi.fn().mockResolvedValue(JSON.stringify(payload))
  }) as unknown as Response;

describe('SecurityDashboard EDR panel', () => {
  it('renders the EDR summary panel when the flag is on', async () => {
    fetchWithAuth.mockResolvedValue(makeTextResponse({}));

    render(<SecurityDashboard />);

    await waitFor(() => {
      expect(screen.getByTestId('edr-summary-stub')).toBeInTheDocument();
    });
  });
});
