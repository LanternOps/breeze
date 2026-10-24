import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

// #9791 C: the Patches page reads its tab through the shared hash grammar
// (parseHashGrammar), and the compliance status filter lives in the hash:
// `#compliance&status=…` ≡ `#status=…`. Legacy tab hashes keep resolving (RF4).

vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: () => true }),
  hasPermission: () => true,
}));
vi.mock('../../components/shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/orgStore', () => {
  const read = () => ({ currentOrgId: null, organizations: [{ id: 'org-1', name: 'Acme Corp' }] });
  return { useOrgStore: Object.assign(read, { getState: read }) };
});
vi.mock('../../lib/authScope', () => {
  const claims = () => ({ scope: 'partner', partnerId: 'p1', orgId: null });
  return { getJwtClaims: claims, useJwtClaims: () => ({ status: 'resolved' as const, claims: claims() }) };
});

import PatchesPage from './PatchesPage';
import { fetchWithAuth } from '../../stores/auth';

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500) =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const complianceCalls = () =>
  fetchMock.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.startsWith('/patches/compliance') && !u.startsWith('/patches/compliance/report'));

const activeTabText = () =>
  screen.getAllByRole('button').find((b) => b.getAttribute('aria-current') === 'page')?.textContent ?? '';

describe('PatchesPage hash grammar (#9791 C)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/update-rings') return json({ data: [] });
      if (url.startsWith('/patches?')) return json({ data: [] });
      if (url.startsWith('/patches/compliance')) {
        return json({ data: { totalDevices: 0, compliantDevices: 0, devicesNeedingPatches: [], devices: [] } });
      }
      if (url.startsWith('/patches/jobs')) return json({ data: [] });
      return json({ data: [] });
    });
  });

  it.each([
    ['#compliance&status=failed', 'failed'],
    ['#status=failed', 'failed'],
    ['#compliance&status=critical', 'critical'],
    ['#compliance&status=compliant', 'compliant'],
    ['#compliance&status=needs-patches', 'needs-patches'],
  ])('%s opens the compliance tab with the %s filter and fetches it', async (hash, status) => {
    window.history.replaceState({}, '', `/patches${hash}`);
    render(<PatchesPage />);
    const select = await screen.findByRole('combobox', { name: 'Compliance status filter' });
    await waitFor(() => expect(select).toHaveValue(status));
    expect(activeTabText()).toMatch(/compliance/i);
    await waitFor(() =>
      expect(complianceCalls().some((u) => new URL(u, 'http://x').searchParams.get('status') === status)).toBe(true),
    );
    // the page never rewrites a status deep link away
    expect(window.location.hash).toBe(hash);
  });

  it('an empty hash is the compliance tab with no status filter', async () => {
    window.history.replaceState({}, '', '/patches');
    render(<PatchesPage />);
    const select = await screen.findByRole('combobox', { name: 'Compliance status filter' });
    expect(select).toHaveValue('all');
    await waitFor(() => expect(complianceCalls().length).toBeGreaterThan(0));
    expect(complianceCalls().every((u) => !u.includes('status='))).toBe(true);
  });

  it('an unknown status falls back to all', async () => {
    window.history.replaceState({}, '', '/patches#compliance&status=bogus');
    render(<PatchesPage />);
    expect(await screen.findByRole('combobox', { name: 'Compliance status filter' })).toHaveValue('all');
  });

  it.each([
    ['#patches', /^patches$/i],
    ['#rings', /rings/i],
    ['#jobs', /jobs/i],
  ])('legacy %s still selects its tab (RF4)', async (hash, label) => {
    window.history.replaceState({}, '', `/patches${hash}`);
    render(<PatchesPage />);
    await waitFor(() => expect(activeTabText().trim()).toMatch(label));
    expect(screen.queryByRole('combobox', { name: 'Compliance status filter' })).toBeNull();
  });

  it('legacy #patches/<id> still selects the patches tab (RF4)', async () => {
    window.history.replaceState({}, '', '/patches#patches/abc-123');
    render(<PatchesPage />);
    await waitFor(() => expect(activeTabText().trim()).toMatch(/^patches$/i));
  });
});
