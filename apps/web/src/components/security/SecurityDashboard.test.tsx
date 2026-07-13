import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { fetchWithAuth } = vi.hoisted(() => ({
  fetchWithAuth: vi.fn()
}));

vi.mock('@/stores/auth', () => ({
  fetchWithAuth
}));

vi.mock('../../lib/featureFlags', () => ({
  ENABLE_EDR_INTEGRATIONS: false
}));

import SecurityDashboard from './SecurityDashboard';

// fetchJson in the component reads response.text(), not json().
function ok(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body)
  } as Response;
}

const overviewPayload = {
  securityScore: 62,
  antivirus: { protected: 40, unprotected: 3 },
  firewall: { enabled: 38, disabled: 5 },
  encryption: { bitlockerEnabled: 20, filevaultEnabled: 10, total: 43 },
  passwordPolicyCompliance: 53,
  adminAccountAudit: {
    defaultAccounts: 1,
    weakAccounts: 2,
    deviceCount: 5,
    devices: [
      { id: 'dev-1', name: 'FIN-WS-014', issue: 'default_account' },
      { id: 'dev-2', name: 'FIN-WS-015', issue: 'weak_password' },
      { id: 'dev-3', name: 'FIN-WS-016', issue: 'weak_password' },
      { id: 'dev-4', name: 'FIN-WS-017', issue: 'weak_password' },
      { id: 'dev-5', name: 'FIN-WS-018', issue: 'stale_account' }
    ]
  },
  recommendations: [],
  trend: []
};

const threatsPayload = {
  summary: { critical: 2, high: 1, medium: 1, low: 1 }
};

const emptyOverviewPayload = {
  securityScore: 0,
  antivirus: { protected: 0, unprotected: 0 },
  firewall: { enabled: 0, disabled: 0 },
  encryption: { bitlockerEnabled: 0, filevaultEnabled: 0, total: 0 },
  passwordPolicyCompliance: 0,
  adminAccountAudit: { defaultAccounts: 0, weakAccounts: 0, deviceCount: 0, devices: [] },
  recommendations: [],
  trend: []
};

const emptyThreatsPayload = {
  summary: { critical: 0, high: 0, medium: 0, low: 0 }
};

function routeSecurity(overview: unknown, threats: unknown) {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url.startsWith('/security/dashboard')) {
      return overview instanceof Error
        ? Promise.reject(overview)
        : Promise.resolve(ok(overview));
    }
    if (url.startsWith('/security/threats')) {
      return threats instanceof Error
        ? Promise.reject(threats)
        : Promise.resolve(ok(threats));
    }
    return Promise.resolve(ok({}));
  });
}

beforeEach(() => {
  fetchWithAuth.mockReset();
});

describe('SecurityDashboard', () => {
  it('renders score, interpolated captions, and deep links on the happy path', async () => {
    routeSecurity(overviewPayload, threatsPayload);
    render(<SecurityDashboard />);

    expect(await screen.findByText('62')).toBeInTheDocument();
    expect(screen.getByText('Elevated')).toBeInTheDocument();

    // Regression for the #2340 glued-text bug: these must render with a space
    // ("5 open items", never "5open items").
    expect(screen.getByText('5 open items')).toBeInTheDocument();
    expect(screen.getByText('43 devices tracked')).toBeInTheDocument();
    expect(screen.getByText('43 devices audited')).toBeInTheDocument();
    expect(screen.getByText(/^Updated\s/)).toBeInTheDocument();

    // Severity rows deep-link to the pre-filtered vulnerabilities view.
    const criticalRow = screen.getByRole('link', { name: /critical/i });
    expect(criticalRow).toHaveAttribute(
      'href',
      '/security/vulnerabilities#severity=critical'
    );

    // Flagged devices link to the device, with a "+N more" overflow link.
    expect(screen.getByRole('link', { name: /FIN-WS-014/ })).toHaveAttribute(
      'href',
      '/devices/dev-1'
    );
    expect(screen.getByRole('link', { name: '+2 more' })).toHaveAttribute(
      'href',
      '/security/admin-audit'
    );
  });

  it('never fabricates a High risk 0/100 screen when both loads fail', async () => {
    routeSecurity(new Error('network'), new Error('network'));
    render(<SecurityDashboard />);

    expect(
      await screen.findByText(
        "Security data couldn't be loaded. Check your connection and retry."
      )
    ).toBeInTheDocument();

    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getAllByText('Data unavailable').length).toBeGreaterThan(0);
    expect(screen.queryByText('High risk')).toBeNull();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('shows a partial banner and per-card unavailable state when only threats fail', async () => {
    routeSecurity(overviewPayload, new Error('network'));
    render(<SecurityDashboard />);

    expect(
      await screen.findByText(
        "Some security data couldn't be loaded. Values shown may be incomplete."
      )
    ).toBeInTheDocument();

    // Overview data still renders...
    expect(screen.getByText('62')).toBeInTheDocument();
    // ...but the vulnerabilities card reports unavailable instead of zeros.
    expect(screen.getByText('Data unavailable')).toBeInTheDocument();
    expect(screen.queryByText('0 open items')).toBeNull();
  });

  it('renders a real empty state for a tenant with no devices reporting', async () => {
    routeSecurity(emptyOverviewPayload, emptyThreatsPayload);
    render(<SecurityDashboard />);

    expect(
      await screen.findByText('No devices reporting yet')
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /go to devices/i })).toHaveAttribute(
      'href',
      '/devices'
    );
    expect(screen.queryByText('High risk')).toBeNull();
    expect(screen.queryByText('Security Score')).toBeNull();
  });

  describe('403 is a permissions state, not a retryable error (#2429)', () => {
    /** A permission denial: resolves (not rejects) with a non-ok 403 Response. */
    const forbidden = () =>
      ({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: async () => ''
      }) as Response;

    /** Route each security endpoint to a Response, or reject for a transport error. */
    function route(
      overview: unknown | Error | Response,
      threats: unknown | Error | Response
    ) {
      const settle = (v: unknown | Error | Response) => {
        if (v instanceof Error) return Promise.reject(v);
        if (v && typeof v === 'object' && 'ok' in (v as Response)) {
          return Promise.resolve(v as Response);
        }
        return Promise.resolve(ok(v));
      };
      fetchWithAuth.mockImplementation((url: string) => {
        if (url === '/security/dashboard') return settle(overview);
        if (url === '/security/threats') return settle(threats);
        return Promise.resolve(ok({}));
      });
    }

    it('shows an access-denied panel with no Retry when both loads are forbidden', async () => {
      route(forbidden(), forbidden());
      render(<SecurityDashboard />);

      expect(
        await screen.findByTestId('security-dashboard-denied')
      ).toBeInTheDocument();

      // The bug: a 403 got the generic "couldn't be loaded — Retry" banner, and
      // that Retry could only ever 403 again.
      expect(screen.queryByTestId('security-dashboard-retry')).toBeNull();
      expect(
        screen.queryByText(
          "Security data couldn't be loaded. Check your connection and retry."
        )
      ).toBeNull();
      // The page-level Refresh is withheld too — it could only 403 again.
      expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();
    });

    it('renders NO dashboard body behind the denied panel — never fabricated zeros', async () => {
      route(forbidden(), forbidden());
      render(<SecurityDashboard />);

      await screen.findByTestId('security-dashboard-denied');

      // A denied user must not be told, authoritatively, that they have zero
      // vulnerabilities and zero AV coverage. `isEmptyTenant` cannot save us
      // here (it requires overview !== null, and a 403 leaves it null), so the
      // denied branch has to terminate the render.
      expect(screen.queryByText('Security Score')).toBeNull();
      expect(screen.queryByText(/open items/)).toBeNull();
      expect(screen.queryByText(/devices tracked/)).toBeNull();
      expect(screen.queryByText('No devices reporting yet')).toBeNull();
    });

    it('explains the denial without a Retry when only one axis is forbidden', async () => {
      route(overviewPayload, forbidden());
      render(<SecurityDashboard />);

      expect(
        await screen.findByText(
          "Some security data isn't visible to you. Ask an administrator if you need access."
        )
      ).toBeInTheDocument();
      expect(screen.queryByTestId('security-dashboard-retry')).toBeNull();
      // The readable axis still renders.
      expect(screen.getByText('62')).toBeInTheDocument();
    });

    it('still offers Retry when a transient failure accompanies the denial — and says so', async () => {
      route(new Error('network'), forbidden());
      render(<SecurityDashboard />);

      // One axis is genuinely retryable, so the button stays — it can fix that one.
      expect(
        await screen.findByTestId('security-dashboard-retry')
      ).toBeInTheDocument();
      expect(screen.queryByTestId('security-dashboard-denied')).toBeNull();

      // The copy must match the affordance: a Retry sitting under a pure
      // "you lack permission" message reads as unmotivated.
      expect(
        screen.getByText(
          "Some security data couldn't be loaded. Values shown may be incomplete."
        )
      ).toBeInTheDocument();
    });

    it('treats a malformed 200 body as a retryable failure, not an empty tenant', async () => {
      // A truncated/HTML (proxy error page) body used to JSON.parse-fail, get
      // swallowed into null, normalize to all-zeros, and render as a confident
      // "No devices reporting yet" — a clean bill of health for a broken load.
      const garbage = {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '<html>502 Bad Gateway</html>'
      } as Response;
      route(garbage, garbage);
      render(<SecurityDashboard />);

      expect(
        await screen.findByTestId('security-dashboard-load-error')
      ).toBeInTheDocument();
      expect(screen.getByTestId('security-dashboard-retry')).toBeInTheDocument();
      expect(screen.queryByText('No devices reporting yet')).toBeNull();
    });

    it('keeps the plain retryable banner for a non-403 failure', async () => {
      route(new Error('network'), new Error('network'));
      render(<SecurityDashboard />);

      expect(
        await screen.findByText(
          "Security data couldn't be loaded. Check your connection and retry."
        )
      ).toBeInTheDocument();
      expect(screen.getByTestId('security-dashboard-retry')).toBeInTheDocument();
      expect(screen.queryByTestId('security-dashboard-denied')).toBeNull();
    });
  });
});
