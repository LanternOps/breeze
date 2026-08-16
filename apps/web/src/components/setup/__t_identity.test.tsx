import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../../src/stores/auth', () => ({ fetchWithAuth: authMocks.fetchWithAuth }));

import RegionalSetupStep from '../../../src/components/setup/RegionalSetupStep';

function jsonRes(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

describe('t identity real i18n', () => {
  it('refetches partner data when the real i18n language changes (unmocked applyLocale)', async () => {
    authMocks.fetchWithAuth.mockResolvedValue(jsonRes({
      settings: { timezone: 'Europe/Paris', language: 'fr-FR' },
      currencyCode: 'EUR', invoiceNumberPrefix: 'FAC', invoiceTermsDays: 45,
    }));
    const onNext = vi.fn();
    render(<RegionalSetupStep siteId="site-1" onNext={onNext} />);
    await waitFor(() => expect(screen.getByTestId('setup-currency')).toBeInTheDocument());
    const callsAfterMount = authMocks.fetchWithAuth.mock.calls.length;

    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('setup-currency'), 'GBP');
    await user.selectOptions(screen.getByTestId('setup-language'), 'de-DE');
    await new Promise((r) => setTimeout(r, 300));

    console.log('calls after mount:', callsAfterMount, 'calls now:', authMocks.fetchWithAuth.mock.calls.length);
    console.log('currency value now:', (screen.getByTestId('setup-currency') as HTMLSelectElement).value);
  });
});
