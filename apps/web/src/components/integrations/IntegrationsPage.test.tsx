import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let scope: 'system' | 'partner' | 'organization' | null = 'partner';

// Mock authScope so we can drive the Distributors-tab scope gate.
vi.mock('../../lib/authScope', () => ({
  getJwtClaims: () => ({ scope, orgId: null, partnerId: 'partner-1' }),
  loginPathWithNext: () => '/login'
}));

// Stub the heavy child panels so the test stays focused on tab/sub-tab wiring.
vi.mock('../webhooks/WebhooksPage', () => ({ default: () => <div data-testid="stub-webhooks" /> }));
vi.mock('../psa/PsaConnectionsPage', () => ({ default: () => <div data-testid="stub-psa" /> }));
vi.mock('./SecurityIntegration', () => ({ default: () => <div data-testid="stub-security" /> }));
vi.mock('./HuntressIntegration', () => ({ default: () => <div data-testid="stub-huntress" /> }));
vi.mock('./MonitoringIntegration', () => ({ default: () => <div data-testid="stub-monitoring" /> }));
vi.mock('./GoogleWorkspaceIntegration', () => ({ default: () => <div data-testid="stub-google" /> }));
vi.mock('./M365Integration', () => ({ default: () => <div data-testid="stub-m365" /> }));
vi.mock('./Pax8Integration', () => ({ default: () => <div data-testid="stub-pax8" /> }));
vi.mock('../settings/TdSynnexCatalogPanel', () => ({ default: () => <div data-testid="stub-tdsynnex" /> }));

import IntegrationsPage from './IntegrationsPage';

describe('IntegrationsPage — Distributors tab', () => {
  beforeEach(() => {
    scope = 'partner';
  });

  it('shows a Distributors top-level tab', () => {
    render(<IntegrationsPage />);
    expect(screen.getByRole('button', { name: /Distributors/i })).toBeTruthy();
  });

  it('renders Pax8 by default and TD SYNNEX when the sub-tab is selected (partner scope)', () => {
    render(<IntegrationsPage />);
    fireEvent.click(screen.getByRole('button', { name: /Distributors/i }));

    // pax8 is the default sub-tab
    expect(screen.getByTestId('stub-pax8')).toBeTruthy();
    expect(screen.queryByTestId('stub-tdsynnex')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'TD SYNNEX' }));
    expect(screen.getByTestId('stub-tdsynnex')).toBeTruthy();
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
