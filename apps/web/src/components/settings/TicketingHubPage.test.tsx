import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '../../lib/i18n';

vi.mock('../../lib/authScope', () => ({
  getJwtClaims: () => ({ scope: 'partner', orgId: null, partnerId: 'partner-1' }),
  useJwtClaims: () => ({ status: 'resolved' as const, claims: { scope: 'partner', orgId: null, partnerId: 'partner-1' } }),
}));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ can: () => false }),
}));

import TicketingHubPage from './TicketingHubPage';

describe('TicketingHubPage', () => {
  it('mounts the ticketing tabs at the top level', () => {
    render(<I18nextProvider i18n={i18n}><TicketingHubPage /></I18nextProvider>);
    expect(screen.getByTestId('ticketing-settings-tabs')).toBeInTheDocument();
  });
});
