import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const { fetchWithAuth } = vi.hoisted(() => ({
  fetchWithAuth: vi.fn()
}));

vi.mock('@/stores/auth', () => ({
  fetchWithAuth
}));

import VulnerabilitiesPage from './VulnerabilitiesPage';

function ok(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body
  } as Response;
}

const emptyListPayload = {
  data: [],
  pagination: { page: 1, limit: 50, total: 0, totalPages: 1 },
  summary: { total: 0, active: 0, quarantined: 0, critical: 0 }
};

beforeEach(() => {
  fetchWithAuth.mockReset();
  fetchWithAuth.mockResolvedValue(ok(emptyListPayload));
});

afterEach(() => {
  window.history.replaceState(null, '', window.location.pathname);
});

describe('VulnerabilitiesPage', () => {
  it('initializes the severity filter from #severity= in the hash (dashboard deep link)', async () => {
    window.location.hash = '#severity=critical';
    render(<VulnerabilitiesPage />);

    await waitFor(() => {
      expect(fetchWithAuth).toHaveBeenCalledWith(
        expect.stringContaining('severity=critical'),
        expect.anything()
      );
    });
  });

  it('ignores an unknown severity value in the hash', async () => {
    window.location.hash = '#severity=bogus';
    render(<VulnerabilitiesPage />);

    await waitFor(() => {
      expect(fetchWithAuth).toHaveBeenCalled();
    });
    const [url] = fetchWithAuth.mock.calls[0];
    expect(String(url)).not.toContain('severity=');
  });
});
