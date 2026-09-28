import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: m.fetchWithAuth }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
import AccountingSettingsStep from './AccountingSettingsStep';

const ok = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
const options = {
  organisation: { name: 'Demo Company (UK)', isDemoCompany: true },
  incomeAccounts: [{ ref: '200', label: '200 · Sales', detail: 'REVENUE' }],
  taxRates: [{ ref: 'OUTPUT2', label: '20% (VAT on Income)', detail: '20%' }, { ref: 'NONE', label: 'No VAT', detail: '0%' }],
  bankAccounts: [{ ref: 'bank-1', label: 'Business Bank Account', detail: '12-3456' }],
};
const empty = { defaultIncomeAccountRef: null, defaultTaxCodeRef: null, defaultExemptTaxCodeRef: null, defaultPaymentAccountRef: null };
const oneSet = { ...empty, defaultTaxCodeRef: 'OUTPUT2' };

describe('AccountingSettingsStep', () => {
  it('shows the organisation with a demo badge and the four pickers', async () => {
    m.fetchWithAuth.mockReturnValue(ok({ data: options }));
    render(<AccountingSettingsStep provider="xero" values={empty} onSaved={vi.fn()} onUnauthorized={vi.fn()} />);
    expect((await screen.findByTestId('xero-organisation-name')).textContent).toContain('Demo Company (UK)');
    expect(screen.getByTestId('xero-demo-badge')).toBeTruthy();
    for (const f of ['defaultIncomeAccountRef', 'defaultTaxCodeRef', 'defaultExemptTaxCodeRef', 'defaultPaymentAccountRef']) {
      expect(screen.getByTestId(`xero-setting-${f}`)).toBeTruthy();
    }
  });

  it('no badge for a real organisation', async () => {
    m.fetchWithAuth.mockReturnValue(ok({ data: { ...options, organisation: { name: 'Acme Ltd', isDemoCompany: false } } }));
    render(<AccountingSettingsStep provider="xero" values={empty} onSaved={vi.fn()} onUnauthorized={vi.fn()} />);
    await screen.findByTestId('xero-organisation-name');
    expect(screen.queryByTestId('xero-demo-badge')).toBeNull();
  });

  it('saves all four refs with one page Save ("" → null)', async () => {
    m.fetchWithAuth.mockImplementation((_url: string, init?: RequestInit) => init?.method === 'PATCH'
      ? ok({ ...empty, defaultTaxCodeRef: 'OUTPUT2', defaultExemptTaxCodeRef: 'NONE' })
      : ok({ data: options }));
    const onSaved = vi.fn();
    render(<AccountingSettingsStep provider="xero" values={empty} onSaved={onSaved} onUnauthorized={vi.fn()} />);
    fireEvent.change(await screen.findByTestId('xero-setting-defaultTaxCodeRef'), { target: { value: 'OUTPUT2' } });
    fireEvent.change(screen.getByTestId('xero-setting-defaultExemptTaxCodeRef'), { target: { value: 'NONE' } });
    fireEvent.click(screen.getByTestId('xero-settings-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [url, init] = m.fetchWithAuth.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'PATCH')!;
    expect(url).toBe('/accounting/xero/settings');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      defaultIncomeAccountRef: null, defaultTaxCodeRef: 'OUTPUT2', defaultExemptTaxCodeRef: 'NONE', defaultPaymentAccountRef: null,
    });
  });

  // Prompt to (re-)pick defaults when the SAVED values are all four null.
  it('shows the pick-defaults notice when all saved values are null', async () => {
    m.fetchWithAuth.mockReturnValue(ok({ data: options }));
    render(<AccountingSettingsStep provider="xero" values={empty} onSaved={vi.fn()} onUnauthorized={vi.fn()} />);
    await screen.findByTestId('xero-organisation-name');
    expect(screen.getByTestId('xero-settings-unset')).toBeTruthy();
  });

  it('hides the pick-defaults notice once one saved value is set', async () => {
    m.fetchWithAuth.mockReturnValue(ok({ data: options }));
    render(<AccountingSettingsStep provider="xero" values={oneSet} onSaved={vi.fn()} onUnauthorized={vi.fn()} />);
    await screen.findByTestId('xero-organisation-name');
    expect(screen.queryByTestId('xero-settings-unset')).toBeNull();
  });

  // Load-failure retry.
  it('shows a retry button on a load failure, and retry recovers', async () => {
    m.fetchWithAuth
      .mockReturnValueOnce(ok({ error: 'provider_error' }, 502))
      .mockReturnValueOnce(ok({ data: options }));
    render(<AccountingSettingsStep provider="xero" values={empty} onSaved={vi.fn()} onUnauthorized={vi.fn()} />);
    const retry = await screen.findByTestId('xero-settings-retry');
    fireEvent.click(retry);
    expect((await screen.findByTestId('xero-organisation-name')).textContent).toContain('Demo Company (UK)');
  });

  // Draft sync: a rerender with a new-but-equal `values` object must not wipe
  // an unsaved pick (the panel passes an inline object literal each render).
  it('keeps an unsaved draft pick across a rerender with a new-but-equal values object', async () => {
    m.fetchWithAuth.mockReturnValue(ok({ data: options }));
    const { rerender } = render(<AccountingSettingsStep provider="xero" values={empty} onSaved={vi.fn()} onUnauthorized={vi.fn()} />);
    fireEvent.change(await screen.findByTestId('xero-setting-defaultTaxCodeRef'), { target: { value: 'OUTPUT2' } });
    rerender(<AccountingSettingsStep provider="xero" values={{ ...empty }} onSaved={vi.fn()} onUnauthorized={vi.fn()} />);
    expect((screen.getByTestId('xero-setting-defaultTaxCodeRef') as HTMLSelectElement).value).toBe('OUTPUT2');
  });

  // The MFA-required 403 must render the same persistent hint the panel's
  // own PATCH handlers show, not runAction's generic toast.
  it('shows the MFA-required hint on a 403 MFA save failure and does not call onSaved', async () => {
    m.fetchWithAuth.mockImplementation((_url: string, init?: RequestInit) => init?.method === 'PATCH'
      ? ok({ error: 'MFA required' }, 403)
      : ok({ data: options }));
    const onSaved = vi.fn();
    render(<AccountingSettingsStep provider="xero" values={empty} onSaved={onSaved} onUnauthorized={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('xero-settings-save'));
    const hint = await screen.findByTestId('xero-settings-mfa');
    expect(hint.getAttribute('role')).toBe('alert');
    expect(onSaved).not.toHaveBeenCalled();
  });

  // A saved ref absent from the fetched options list must stay
  // visible/selected rather than silently reading as blank.
  it('keeps a saved ref visible even when absent from the fetched options', async () => {
    m.fetchWithAuth.mockReturnValue(ok({ data: options }));
    render(<AccountingSettingsStep provider="xero" values={{ ...empty, defaultPaymentAccountRef: 'gone-1' }} onSaved={vi.fn()} onUnauthorized={vi.fn()} />);
    const select = await screen.findByTestId('xero-setting-defaultPaymentAccountRef') as HTMLSelectElement;
    expect(select.value).toBe('gone-1');
    expect(Array.from(select.options).some((o) => o.value === 'gone-1')).toBe(true);
  });
});
