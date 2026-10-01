import '@/lib/i18n';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

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

describe('VulnerabilitiesPage filter selects accessible name (#7156)', () => {
  it('gives the severity/status/category filter selects a real accessible name', async () => {
    render(<VulnerabilitiesPage />);
    expect(await screen.findByRole('combobox', { name: 'Severity' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Category' })).toBeInTheDocument();
  });
});

describe('VulnerabilitiesPage checkbox accessible names', () => {
  it('names the select-all and per-row checkboxes', async () => {
    fetchWithAuth.mockResolvedValue(ok({
      ...emptyListPayload,
      data: [{
        id: 't1', deviceId: 'd1', deviceName: 'HOST-1', name: 'Evil.Exe', category: 'trojan',
        severity: 'high', status: 'active', detectedAt: '2026-09-01T00:00:00Z', filePath: 'C:\\evil.exe'
      }]
    }));
    render(<VulnerabilitiesPage />);
    await screen.findAllByText('Evil.Exe');
    expect(screen.getAllByRole('checkbox', { name: 'Select all threats' }).length).toBeGreaterThan(0);
    // Table row + mobile card each expose a named row checkbox.
    expect(screen.getAllByRole('checkbox', { name: 'Select threat Evil.Exe' }).length).toBeGreaterThan(0);
    for (const cb of screen.getAllByRole('checkbox')) {
      expect(cb).toHaveAccessibleName();
    }
  });
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
