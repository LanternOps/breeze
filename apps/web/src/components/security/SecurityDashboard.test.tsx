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
});
