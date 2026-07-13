import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

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

describe('403 is a permissions state, not a retryable error (#2472)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe.each(CONVERTED)('%s', (_name, element, deniedTestId) => {
    it('renders the access-denied panel when the load is forbidden', async () => {
      fetchWithAuth.mockResolvedValue(forbidden());
      render(element);

      expect(await screen.findByTestId(deniedTestId)).toBeInTheDocument();
    });

    it('offers no Retry/Refresh beside the denial — it could only 403 again', async () => {
      fetchWithAuth.mockResolvedValue(forbidden());
      render(element);
      await screen.findByTestId(deniedTestId);

      expect(screen.queryByRole('button', { name: /retry|try again|refresh/i })).toBeNull();
    });

    it('renders no numeric stat tiles behind the denial — never fabricated zeros', async () => {
      fetchWithAuth.mockResolvedValue(forbidden());
      const { container } = render(element);
      await screen.findByTestId(deniedTestId);

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

    it('keeps the retryable error path for a non-403 failure', async () => {
      fetchWithAuth.mockResolvedValue(serverError());
      render(element);

      // A 500 is transient: it must NOT be reported as a permission problem.
      await vi.waitFor(() => {
        expect(screen.queryByTestId(deniedTestId)).toBeNull();
      });
    });
  });
});
