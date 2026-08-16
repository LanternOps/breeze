import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({ fetchWithAuth: vi.fn() }));
const i18nMocks = vi.hoisted(() => ({ applyLocale: vi.fn() }));
const appearanceMocks = vi.hoisted(() => ({ writeLocalePreference: vi.fn() }));

const toastMocks = vi.hoisted(() => ({ showToast: vi.fn() }));

vi.mock('../../stores/auth', () => ({ fetchWithAuth: authMocks.fetchWithAuth }));
vi.mock('../shared/Toast', () => ({ showToast: toastMocks.showToast }));

vi.mock('@/lib/i18n', async () => {
  const actual = await vi.importActual<typeof import('@/lib/i18n')>('@/lib/i18n');
  return { ...actual, applyLocale: i18nMocks.applyLocale };
});

vi.mock('@/lib/appearance', async () => {
  const actual = await vi.importActual<typeof import('@/lib/appearance')>('@/lib/appearance');
  return { ...actual, writeLocalePreference: appearanceMocks.writeLocalePreference };
});

import RegionalSetupStep from './RegionalSetupStep';

const PARTNER = {
  settings: { timezone: 'Europe/Paris', language: 'fr-FR' },
  currencyCode: 'EUR',
  invoiceNumberPrefix: 'FAC',
  invoiceTermsDays: 45,
};

function jsonRes(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

/** Every mutating call in the step, keyed by URL, for assertion lookups. */
function patchBody(url: string): Record<string, unknown> | undefined {
  const call = authMocks.fetchWithAuth.mock.calls.find(
    (c) => c[0] === url && c[1]?.method === 'PATCH',
  );
  return call ? JSON.parse(call[1].body as string) : undefined;
}

describe('RegionalSetupStep (#3204)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18nMocks.applyLocale.mockResolvedValue({ locale: 'en', usedFallback: false });
    authMocks.fetchWithAuth.mockResolvedValue(jsonRes(PARTNER));
  });

  async function renderLoaded(props: Partial<React.ComponentProps<typeof RegionalSetupStep>> = {}) {
    const onNext = vi.fn();
    render(<RegionalSetupStep siteId="site-1" onNext={onNext} {...props} />);
    await waitFor(() => expect(screen.getByTestId('setup-currency')).toBeInTheDocument());
    return { onNext };
  }

  it('prefills from the partner rather than the UTC/USD/English defaults', async () => {
    await renderLoaded();

    expect(screen.getByTestId('setup-language')).toHaveValue('fr-FR');
    expect(screen.getByTestId('setup-currency')).toHaveValue('EUR');
    // TimezoneSelect renders the committed zone on its trigger button.
    expect(screen.getByTestId('setup-timezone')).toHaveTextContent('Europe/Paris');
  });

  /**
   * The whole point of the step: the site created one step earlier defaults to
   * 'UTC' independently of the partner, so a partner-only write would leave the
   * site — which is what device schedules actually resolve against — on UTC.
   */
  it('writes the timezone to BOTH the partner and the site', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(patchBody('/orgs/sites/site-1')).toBeDefined());
    expect(patchBody('/orgs/partners/me')).toEqual({
      settings: { timezone: 'Europe/Paris', language: 'fr-FR' },
    });
    expect(patchBody('/orgs/sites/site-1')).toEqual({ timezone: 'Europe/Paris' });
  });

  /**
   * `partnerBillingSettingsSchema` makes invoiceNumberPrefix and
   * invoiceTermsDays REQUIRED, and the service writes both unconditionally. A
   * currency-only body would 400; hardcoded 'INV'/30 would silently overwrite
   * whatever the partner already had.
   */
  it('echoes the loaded invoice prefix and terms back on the currency PATCH', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.selectOptions(screen.getByTestId('setup-currency'), 'GBP');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(patchBody('/partner/billing-settings')).toBeDefined());
    expect(patchBody('/partner/billing-settings')).toEqual({
      currencyCode: 'GBP',
      invoiceNumberPrefix: 'FAC',
      invoiceTermsDays: 45,
    });
  });

  it('applies the chosen language immediately so the rest of setup is translated', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.selectOptions(screen.getByTestId('setup-language'), 'de-DE');

    expect(appearanceMocks.writeLocalePreference).toHaveBeenCalledWith('de-DE');
    expect(i18nMocks.applyLocale).toHaveBeenCalledWith('de-DE');
    expect(toastMocks.showToast).not.toHaveBeenCalled();
  });

  /**
   * When the language chunk fails to load, applyLocale renders English instead
   * — but the select still shows the chosen language and submit still persists
   * it. Without the toast, what the user sees and what gets saved diverge with
   * no signal at all.
   */
  it('warns when the chosen language chunk fails to load and English renders', async () => {
    i18nMocks.applyLocale.mockResolvedValue({ locale: 'de-DE', usedFallback: true });
    const user = userEvent.setup();
    await renderLoaded();

    await user.selectOptions(screen.getByTestId('setup-language'), 'de-DE');

    await waitFor(() =>
      expect(toastMocks.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error' }),
      ),
    );
  });

  /**
   * The load effect must run exactly once. `useTranslation`'s `t` gets a new
   * identity on every language change, so listing it as a dependency would
   * refetch the partner — and reset the currency the user had already picked —
   * on the very interaction the language select exists to perform.
   */
  it('does not reload (or discard picked values) when the language changes', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    const loadsAfterMount = authMocks.fetchWithAuth.mock.calls.length;

    await user.selectOptions(screen.getByTestId('setup-currency'), 'GBP');
    await user.selectOptions(screen.getByTestId('setup-language'), 'de-DE');

    await new Promise((r) => setTimeout(r, 50));
    expect(authMocks.fetchWithAuth.mock.calls.length).toBe(loadsAfterMount);
    expect(screen.getByTestId('setup-currency')).toHaveValue('GBP');
  });

  /**
   * Advancing after a failed write would silently ship the very defaults this
   * step exists to replace, and the wizard never returns here.
   */
  it('does NOT advance when a write fails, and surfaces the API error', async () => {
    const user = userEvent.setup();
    authMocks.fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH' && url === '/partner/billing-settings') {
        return Promise.resolve(jsonRes({ error: 'Insufficient permissions' }, false, 403));
      }
      return Promise.resolve(jsonRes(PARTNER));
    });
    const { onNext } = await renderLoaded();

    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(screen.getByText(/insufficient permissions/i)).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 50));
    expect(onNext).not.toHaveBeenCalled();
  });

  it('skips the site PATCH entirely when no site id is available', async () => {
    const user = userEvent.setup();
    const { onNext } = await renderLoaded({ siteId: null });

    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(onNext).toHaveBeenCalled(), { timeout: 2000 });
    const siteCalls = authMocks.fetchWithAuth.mock.calls.filter((c) =>
      String(c[0]).startsWith('/orgs/sites/'),
    );
    expect(siteCalls).toEqual([]);
  });

  /**
   * A failed load must not silently present UTC/USD/English as if they were the
   * stored settings — the step would then look like it had nothing to change.
   */
  it('reports a load failure and still offers usable detected values', async () => {
    authMocks.fetchWithAuth.mockResolvedValue(jsonRes({ error: 'boom' }, false, 500));
    await renderLoaded();

    expect(screen.getByText(/couldn't load|could not load/i)).toBeInTheDocument();
    expect(screen.getByTestId('setup-currency')).toHaveValue('USD');
  });
});
