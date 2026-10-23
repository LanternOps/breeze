import '@/lib/i18n';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { fetchWithAuth } = vi.hoisted(() => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/stores/auth', () => ({ fetchWithAuth }));

import VulnerabilitiesPage from './VulnerabilitiesPage';
import { encodeThreatsHash, parseThreatsHash } from './threatsHash';

const ok = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as Response;
const emptyListPayload = {
  data: [],
  pagination: { page: 1, limit: 50, total: 0, totalPages: 1 },
  summary: { total: 0, active: 0, quarantined: 0, critical: 0 },
};

beforeEach(() => {
  fetchWithAuth.mockReset();
  fetchWithAuth.mockResolvedValue(ok(emptyListPayload));
});
afterEach(() => {
  window.history.replaceState(null, '', window.location.pathname);
});

const lastUrl = () => String(fetchWithAuth.mock.calls[fetchWithAuth.mock.calls.length - 1]![0]);

describe('threats hash codec', () => {
  it('round-trips status + severity', () => {
    const hash = encodeThreatsHash({ status: 'active', severity: 'critical' });
    expect(hash).toBe('#status=active&severity=critical');
    expect(parseThreatsHash(hash.slice(1))).toEqual({ status: 'active', severity: 'critical' });
  });

  it('ignores invalid values and unknown keys', () => {
    expect(parseThreatsHash('status=nope&severity=bogus&x=1')).toEqual({ status: '', severity: '' });
  });

  it('encodes nothing when empty', () => {
    expect(encodeThreatsHash({})).toBe('');
  });
});

describe('Security VulnerabilitiesPage — #status= / #severity= (#6721)', () => {
  it('#status=active seeds the status filter and the request', async () => {
    window.location.hash = '#status=active';
    render(<VulnerabilitiesPage />);
    await waitFor(() => expect(lastUrl()).toContain('status=active'));
    expect(lastUrl()).not.toContain('severity=');
  });

  it('#status=active&severity=critical seeds both', async () => {
    window.location.hash = '#status=active&severity=critical';
    render(<VulnerabilitiesPage />);
    await waitFor(() => {
      expect(lastUrl()).toContain('status=active');
      expect(lastUrl()).toContain('severity=critical');
    });
  });

  it('keeps #severity=high (existing bookmarks)', async () => {
    window.location.hash = '#severity=high';
    render(<VulnerabilitiesPage />);
    await waitFor(() => expect(lastUrl()).toContain('severity=high'));
    expect(lastUrl()).not.toContain('status=');
  });

  it('shows the seeded status in the select', async () => {
    window.location.hash = '#status=quarantined';
    render(<VulnerabilitiesPage />);
    const select = (await screen.findByRole('combobox', { name: 'Status' })) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('quarantined'));
  });
});
