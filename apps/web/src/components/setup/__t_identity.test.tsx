import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { i18n } from '../../lib/i18n';

const authMocks = vi.hoisted(() => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: authMocks.fetchWithAuth }));

import RegionalSetupStep from './RegionalSetupStep';

function jsonRes(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

describe('t identity real i18n (committed HEAD version)', () => {
  it('traces effect reruns', async () => {
    authMocks.fetchWithAuth.mockResolvedValue(jsonRes({
      settings: { timezone: 'Europe/Paris', language: 'fr-FR' },
      currencyCode: 'EUR', invoiceNumberPrefix: 'FAC', invoiceTermsDays: 45,
    }));
    const onNext = vi.fn();
    render(<RegionalSetupStep siteId="site-1" onNext={onNext} />);
    await waitFor(() => expect(screen.getByTestId('setup-currency')).toBeInTheDocument());
    console.log('=== mounted, now changing language ===');

    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId('setup-language'), 'de-DE');
    await waitFor(() => expect(i18n.language).toBe('de-DE'), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 300));
    console.log('=== done ===');
  });
});
