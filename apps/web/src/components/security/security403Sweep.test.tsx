import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';

const { fetchWithAuth } = vi.hoisted(() => ({ fetchWithAuth: vi.fn() }));

// Both import specifiers are in use across this directory ("@/stores/auth" and
// the relative "../../stores/auth"); mock both so every component under test
// resolves to the same spy. Partial mocks: orgStore (pulled in by
// SecurityPolicyEditor) needs the module's other real exports.
vi.mock('@/stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/auth')>()),
  fetchWithAuth,
}));
vi.mock('../../stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/auth')>()),
  fetchWithAuth,
}));

vi.mock('../../lib/featureFlags', () => ({ ENABLE_EDR_INTEGRATIONS: true }));

import AdminAuditPage from './AdminAuditPage';
import AntivirusPage from './AntivirusPage';
import DeviceSecurityStatus from './DeviceSecurityStatus';
import EdrSummaryPanel from './EdrSummaryPanel';
import EncryptionPage from './EncryptionPage';
import FirewallPage from './FirewallPage';
import HuntressIncidentList from './HuntressIncidentList';
import PasswordPolicyPage from './PasswordPolicyPage';
import RecommendationsPage from './RecommendationsPage';
import RecoveryKeysPanel from './RecoveryKeysPanel';
import S1ThreatList from './S1ThreatList';
import SecurityPolicyEditor from './SecurityPolicyEditor';
import SecurityScanManager from './SecurityScanManager';
import ThreatDetail from './ThreatDetail';
import ThreatList from './ThreatList';
import VulnerabilitiesPage from './VulnerabilitiesPage';

/**
 * A permission denial resolves (does NOT reject) with a non-ok 403 Response.
 * Before #2472 these pages collapsed that into `new Error("403 Forbidden")`, so
 * a denial was indistinguishable from a 500 and got a Retry button that could
 * only ever 403 again.
 */
const forbidden = () =>
  ({
    ok: false,
    status: 403,
    statusText: 'Forbidden',
    json: async () => ({}),
    text: async () => '',
  }) as unknown as Response;

/** A genuinely transient failure — Retry is meaningful here, so it must stay. */
const serverError = () =>
  ({
    ok: false,
    status: 500,
    statusText: 'Internal Server Error',
    json: async () => ({}),
    text: async () => '',
  }) as unknown as Response;

/** Every page converted by #2472, with the testId its AccessDenied panel carries. */
const CONVERTED = [
  ['AdminAuditPage', <AdminAuditPage />, 'security-admin-audit-denied'],
  ['AntivirusPage', <AntivirusPage />, 'security-antivirus-denied'],
  ['EncryptionPage', <EncryptionPage />, 'security-encryption-denied'],
  ['FirewallPage', <FirewallPage />, 'security-firewall-denied'],
  ['PasswordPolicyPage', <PasswordPolicyPage />, 'security-password-policy-denied'],
  ['RecommendationsPage', <RecommendationsPage />, 'security-recommendations-denied'],
  ['VulnerabilitiesPage', <VulnerabilitiesPage />, 'security-vulnerabilities-denied'],
  ['ThreatList', <ThreatList />, 'security-threat-list-denied'],
  ['ThreatDetail', <ThreatDetail threatId="threat-1" />, 'security-threat-detail-denied'],
  ['DeviceSecurityStatus', <DeviceSecurityStatus deviceId="dev-1" />, 'device-security-status-denied'],
  ['RecoveryKeysPanel', <RecoveryKeysPanel deviceId="dev-1" />, 'recovery-keys-denied'],
  ['SecurityPolicyEditor', <SecurityPolicyEditor policyId="pol-1" />, 'security-policy-editor-denied'],
  ['SecurityScanManager', <SecurityScanManager />, 'security-scan-manager-denied'],
  ['EdrSummaryPanel', <EdrSummaryPanel />, 'edr-summary-denied'],
  ['S1ThreatList', <S1ThreatList />, 's1-denied'],
  ['HuntressIncidentList', <HuntressIncidentList />, 'huntress-denied'],
] as const;

/**
 * Render and drive every pending microtask/timer to completion.
 *
 * The mocked fetches resolve immediately, so a handful of flushes settles the
 * whole `fetch -> .json() -> setState` chain. This exists because asserting
 * ABSENCE (`queryByTestId(...)).toBeNull()`) inside a bare `waitFor` is vacuous:
 * waitFor resolves on the first tick, when the component is still loading and
 * the panel is legitimately not in the DOM yet. The 403 cases below assert
 * PRESENCE through this same helper, which proves the flush is long enough for
 * the absence assertions to mean something.
 */
async function renderSettled(element: React.ReactElement) {
  const result = render(element);
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return result;
}

describe('403 is a permissions state, not a retryable error (#2472)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe.each(CONVERTED)('%s', (_name, element, deniedTestId) => {
    it('renders the access-denied panel when the load is forbidden', async () => {
      fetchWithAuth.mockResolvedValue(forbidden());
      await renderSettled(element);

      expect(screen.getByTestId(deniedTestId)).toBeInTheDocument();
    });

    it('offers no Retry/Refresh beside the denial — it could only 403 again', async () => {
      fetchWithAuth.mockResolvedValue(forbidden());
      await renderSettled(element);
      expect(screen.getByTestId(deniedTestId)).toBeInTheDocument();

      expect(screen.queryByRole('button', { name: /retry|try again|refresh/i })).toBeNull();
    });

    it('renders no numeric stat tiles behind the denial — never fabricated zeros', async () => {
      fetchWithAuth.mockResolvedValue(forbidden());
      const { container } = await renderSettled(element);
      expect(screen.getByTestId(deniedTestId)).toBeInTheDocument();

      // The core hazard: a fully-403'd page that still paints its summary tiles
      // from a zeroed default tells a user who merely lacks permission that they
      // have "0 critical vulnerabilities" / "0% AV coverage" — a confident,
      // fabricated all-clear. The denied branch must terminate the render before
      // any tile is produced, so no standalone number survives in the DOM.
      const strayNumbers = Array.from(container.querySelectorAll('p, span, td, h2, h3'))
        .map((el) => el.textContent?.trim() ?? '')
        .filter((text) => /^\d+%?$/.test(text));

      expect(strayNumbers).toEqual([]);
    });

    it('does NOT report a 500 as a permission problem (it stays retryable)', async () => {
      fetchWithAuth.mockResolvedValue(serverError());
      await renderSettled(element);

      // Settled (same helper the 403 cases above assert presence through), so this
      // absence is a real observation, not a race won during the loading frame.
      expect(fetchWithAuth).toHaveBeenCalled();
      expect(screen.queryByTestId(deniedTestId)).toBeNull();
    });
  });
});

/** A 200 whose body parses. */
const okJson = (payload: unknown) =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

describe('a failed read is never rendered as an all-clear (#2472)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('AntivirusPage: a failed /security/dashboard shows "—", not a fabricated 0% coverage', async () => {
    // The device list loads; only the dashboard (the stat tiles) fails. Coercing
    // the missing dashboard to 0 painted "Coverage 0%" with no banner at all.
    fetchWithAuth.mockImplementation((url: string) =>
      Promise.resolve(
        url.startsWith('/security/dashboard')
          ? serverError()
          : okJson({
              data: [
                { deviceId: 'd1', deviceName: 'WS-1', os: 'windows', status: 'protected' },
              ],
              pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
            }),
      ),
    );

    const { container } = await renderSettled(<AntivirusPage />);

    // The device we CAN see still renders...
    expect(screen.getByText('WS-1')).toBeInTheDocument();
    // ...but every unreadable stat tile is an em dash, never "0" / "0%".
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(4);
    const tileValues = Array.from(container.querySelectorAll('p'))
      .map((el) => el.textContent?.trim() ?? '')
      .filter((text) => /^0%?$/.test(text));
    expect(tileValues).toEqual([]);
  });

  it('SecurityScanManager: a PARTIAL scan-history failure is surfaced, not hidden behind rows', async () => {
    // d1's history loads, d2's 403s. The table therefore looks complete and is not.
    fetchWithAuth.mockImplementation((url: string) => {
      if (url.startsWith('/security/status')) {
        return Promise.resolve(
          okJson({
            data: [
              { deviceId: 'd1', deviceName: 'WS-1', os: 'windows', status: 'protected' },
              { deviceId: 'd2', deviceName: 'WS-2', os: 'windows', status: 'protected' },
            ],
          }),
        );
      }
      if (url.startsWith('/security/scans/d2')) return Promise.resolve(forbidden());
      return Promise.resolve(
        okJson({
          data: [
            {
              id: 'scan-1',
              deviceId: 'd1',
              status: 'completed',
              scanType: 'quick',
              startedAt: '2026-07-01T00:00:00Z',
            },
          ],
        }),
      );
    });

    await renderSettled(<SecurityScanManager />);

    // Rows we could read are still shown — but the loss is stated, with counts.
    const warning = screen.getByTestId('scan-history-partial-failure');
    expect(warning).toBeInTheDocument();
    expect(warning.textContent).toMatch(/1 of 2/);
    // The whole panel is NOT replaced by AccessDenied: /security/status succeeded,
    // so the user can still start scans.
    expect(screen.queryByTestId('security-scan-manager-denied')).toBeNull();
  });

  it('SecurityScanManager: a superseded (aborted) load is not reported as a failure', async () => {
    // Promise.allSettled never rejects, so the outer AbortError guard cannot see
    // aborted per-device fetches. They must not be counted as real failures.
    fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/security/status')) {
        return Promise.resolve(
          okJson({
            data: [{ deviceId: 'd1', deviceName: 'WS-1', os: 'windows', status: 'protected' }],
          }),
        );
      }
      // Simulate the caller having aborted this in-flight per-device fetch.
      const err = new DOMException('Aborted', 'AbortError');
      void init;
      return Promise.reject(err);
    });

    await renderSettled(<SecurityScanManager />);

    // An abort is a superseded request, not unreadable data — no scary warning.
    expect(screen.queryByTestId('scan-history-partial-failure')).toBeNull();
  });

  it('VulnerabilitiesPage: a failed bulk action stays on screen through the refetch', async () => {
    // The bug: the catch called setError(), then the unconditional fetchData()
    // opened with setError(undefined) — React batched both and the user saw
    // NOTHING while the threat stayed listed as active.
    fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(forbidden());
      return Promise.resolve(
        okJson({
          data: [
            {
              id: 't1',
              threatName: 'EICAR',
              severity: 'critical',
              status: 'active',
              deviceName: 'WS-1',
            },
          ],
          pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
        }),
      );
    });

    await renderSettled(<VulnerabilitiesPage />);

    const checkbox = screen.getAllByRole('checkbox')[0];
    await act(async () => {
      checkbox.click();
    });
    const quarantine = screen.getByRole('button', { name: /quarantine/i });
    await act(async () => {
      quarantine.click();
    });
    // Let the POST reject AND the follow-up refetch resolve.
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    expect(screen.getByTestId('vulnerabilities-action-error')).toBeInTheDocument();
  });
});
