import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let scope: 'system' | 'partner' | 'organization' | null = 'partner';

// Mock authScope so we can drive the Distributors-tab scope gate.
vi.mock('../../lib/authScope', () => ({
  getJwtClaims: () => ({ scope, orgId: null, partnerId: 'partner-1' }),
  loginPathWithNext: () => '/login'
}));

// Stub the heavy child panels so the test stays focused on tab/sub-tab wiring.
vi.mock('../webhooks/WebhooksPage', () => ({ default: () => <div data-testid="stub-webhooks" /> }));
vi.mock('./CommunicationIntegrations', () => ({ default: () => <div data-testid="stub-notifications" /> }));
vi.mock('../psa/PsaConnectionsPage', () => ({ default: () => <div data-testid="stub-psa" /> }));
vi.mock('./SecurityIntegration', () => ({ default: () => <div data-testid="stub-security" /> }));
vi.mock('./HuntressIntegration', () => ({ default: () => <div data-testid="stub-huntress" /> }));
vi.mock('./MonitoringIntegration', () => ({ default: () => <div data-testid="stub-monitoring" /> }));
vi.mock('./GoogleWorkspaceIntegration', () => ({ default: () => <div data-testid="stub-google" /> }));
vi.mock('./M365Integration', () => ({ default: () => <div data-testid="stub-m365" /> }));
vi.mock('./Pax8Integration', () => ({ default: () => <div data-testid="stub-pax8" /> }));
vi.mock('../settings/TdSynnexCatalogPanel', () => ({ default: () => <div data-testid="stub-tdsynnex" /> }));
vi.mock('../settings/TdSynnexEcExpressPanel', () => ({ default: () => <div data-testid="stub-tdsynnex-ec" /> }));

import IntegrationsPage from './IntegrationsPage';

describe('IntegrationsPage — Distributors tab', () => {
  beforeEach(() => {
    scope = 'partner';
  });

  it('shows a Distributors top-level tab', () => {
    render(<IntegrationsPage />);
    expect(screen.getByRole('button', { name: /Distributors/i })).toBeTruthy();
  });

  it('renders Pax8 by default and TD SYNNEX Pricing when the sub-tab is selected (partner scope)', () => {
    render(<IntegrationsPage />);
    fireEvent.click(screen.getByRole('button', { name: /Distributors/i }));

    // pax8 is the default sub-tab
    expect(screen.getByTestId('stub-pax8')).toBeTruthy();
    expect(screen.queryByTestId('stub-tdsynnex-ec')).toBeNull();

    // The legacy Digital Bridge "TD SYNNEX" tab is hidden; EC Express
    // "TD SYNNEX Pricing" is the surfaced TD SYNNEX connector.
    expect(screen.queryByRole('button', { name: 'TD SYNNEX' })).toBeNull();
    expect(screen.queryByTestId('stub-tdsynnex')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'TD SYNNEX Pricing' }));
    expect(screen.getByTestId('stub-tdsynnex-ec')).toBeTruthy();
    expect(screen.queryByTestId('stub-pax8')).toBeNull();
  });

  it('lets a system-scope user use the Distributors tab', () => {
    scope = 'system';
    render(<IntegrationsPage />);
    fireEvent.click(screen.getByRole('button', { name: /Distributors/i }));
    expect(screen.getByTestId('stub-pax8')).toBeTruthy();
    expect(screen.queryByTestId('distributors-org-scope')).toBeNull();
  });

  it('gates the Distributors tab for org-scope users with a partner-only message', () => {
    scope = 'organization';
    render(<IntegrationsPage />);
    fireEvent.click(screen.getByRole('button', { name: /Distributors/i }));

    expect(screen.getByTestId('distributors-org-scope')).toBeTruthy();
    // No panels and no sub-tab bar for org-scope users.
    expect(screen.queryByTestId('stub-pax8')).toBeNull();
    expect(screen.queryByTestId('stub-tdsynnex')).toBeNull();
    expect(screen.queryByRole('button', { name: 'TD SYNNEX' })).toBeNull();
  });
});

// The 5 legacy /settings/integrations/* routes 301-redirect here with a hash
// (#psa, #security, #monitoring, #huntress). This is the contract that makes
// those redirects land on the right tab — guard it so a refactor of `tabs` or
// the hash initializer doesn't silently send every old bookmark to Webhooks.
describe('IntegrationsPage — URL hash deep-linking', () => {
  beforeEach(() => {
    scope = 'partner';
    window.location.hash = '';
  });
  afterEach(() => {
    window.location.hash = '';
  });

  it('selects a top-level tab from the hash (#psa)', () => {
    window.location.hash = '#psa';
    render(<IntegrationsPage />);
    expect(screen.getByTestId('stub-psa')).toBeTruthy();
    expect(screen.queryByTestId('stub-webhooks')).toBeNull();
  });

  it('selects the Monitoring tab from #monitoring', () => {
    window.location.hash = '#monitoring';
    render(<IntegrationsPage />);
    expect(screen.getByTestId('stub-monitoring')).toBeTruthy();
  });

  it('selects the Notifications tab from #notifications', () => {
    window.location.hash = '#notifications';
    render(<IntegrationsPage />);
    expect(screen.getByTestId('stub-notifications')).toBeTruthy();
    expect(screen.queryByTestId('stub-webhooks')).toBeNull();
  });

  it('selects the Security tab (default SentinelOne sub-tab) from #security', () => {
    window.location.hash = '#security';
    render(<IntegrationsPage />);
    expect(screen.getByTestId('stub-security')).toBeTruthy();
    expect(screen.queryByTestId('stub-huntress')).toBeNull();
  });

  it('activates the Security tab AND Huntress sub-tab from the #huntress sub-tab hash', () => {
    window.location.hash = '#huntress';
    render(<IntegrationsPage />);
    expect(screen.getByTestId('stub-huntress')).toBeTruthy();
    expect(screen.queryByTestId('stub-security')).toBeNull();
  });

  it('falls back to the default tab when the hash is unknown', () => {
    window.location.hash = '#bogus';
    render(<IntegrationsPage />);
    expect(screen.getByTestId('stub-webhooks')).toBeTruthy();
    expect(screen.queryByTestId('stub-psa')).toBeNull();
  });

  it('lets a valid hash override the initialTab prop', () => {
    window.location.hash = '#monitoring';
    render(<IntegrationsPage initialTab="psa" />);
    expect(screen.getByTestId('stub-monitoring')).toBeTruthy();
    expect(screen.queryByTestId('stub-psa')).toBeNull();
  });
});
