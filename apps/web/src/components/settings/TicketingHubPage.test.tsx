import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '../../lib/i18n';

let jwtStatus: 'unresolved' | 'resolved' = 'resolved';
vi.mock('../../lib/authScope', () => ({
  getJwtClaims: () => ({ scope: 'partner', orgId: null, partnerId: 'partner-1' }),
  useJwtClaims: () =>
    jwtStatus === 'unresolved'
      ? { status: 'unresolved' as const }
      : { status: 'resolved' as const, claims: { scope: 'partner', orgId: null, partnerId: 'partner-1' } },
}));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ can: () => false }),
}));

import TicketingHubPage from './TicketingHubPage';

describe('TicketingHubPage', () => {
  beforeEach(() => {
    jwtStatus = 'resolved';
    window.history.pushState({}, '', '/settings/ticketing');
  });

  afterEach(() => {
    window.history.pushState({}, '', '/settings/ticketing');
  });

  it('mounts the ticketing tabs at the top level', () => {
    render(<I18nextProvider i18n={i18n}><TicketingHubPage /></I18nextProvider>);
    expect(screen.getByTestId('ticketing-settings-tabs')).toBeInTheDocument();
  });

  it('deep-links to the Email tab when ?ticketMailbox= is present, before scope resolves', async () => {
    jwtStatus = 'unresolved';
    window.history.pushState({}, '', '/settings/ticketing?ticketMailbox=abc123');
    render(<I18nextProvider i18n={i18n}><TicketingHubPage /></I18nextProvider>);
    expect(await screen.findByTestId('ticketing-tab-panel-pending')).toBeInTheDocument();
  });
});
