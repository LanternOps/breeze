import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: m.fetchWithAuth }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
import AccountingTenantPicker from './AccountingTenantPicker';

const ok = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
// NOTE: no manual `beforeEach(() => m.fetchWithAuth.mockReset())` here — this
// project's vitest.config.ts already sets `clearMocks: true, restoreMocks:
// true` globally. Adding a redundant manual `.mockReset()` in `beforeEach`
// alongside that global config reproducibly made vitest invoke the mocked
// `fetchWithAuth` an extra, spurious time during test cleanup (observed with
// zero args / `null`, tripping every test in this file with a
// "Cannot read properties of undefined" from inside the mock body). Rely on
// the global config instead; each `it()` sets its own `mockImplementation`.

describe('AccountingTenantPicker', () => {
  it('lists the organisations and connects the chosen one', async () => {
    m.fetchWithAuth.mockImplementation((url: string) => url.endsWith('/tenants')
      ? ok({ data: [{ tenantId: 't-A', name: 'Alpha Ltd' }, { tenantId: 't-B', name: 'Beta Ltd' }], expiresAt: null })
      : ok({ connected: true }));
    const onDone = vi.fn();
    render(<AccountingTenantPicker provider="xero" onUnauthorized={vi.fn()} onDone={onDone} />);
    fireEvent.click(await screen.findByTestId('xero-tenant-option-t-B'));
    fireEvent.click(screen.getByTestId('xero-tenant-select'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const [url, init] = m.fetchWithAuth.mock.calls.find(([u]) => String(u).endsWith('/tenants/select'))!;
    expect(url).toBe('/accounting/xero/tenants/select');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ tenantId: 't-B' });
  });

  it('shows the expired state with only Cancel available', async () => {
    m.fetchWithAuth.mockImplementation((url: string) => url.endsWith('/tenants')
      ? ok({ error: 'expired', code: 'tenant_selection_expired' }, 409)
      : ok({ cancelled: true }));
    const onDone = vi.fn();
    render(<AccountingTenantPicker provider="xero" onUnauthorized={vi.fn()} onDone={onDone} />);
    expect(await screen.findByTestId('xero-tenant-expired')).toBeTruthy();
    expect(screen.queryByTestId('xero-tenant-select')).toBeNull();
    fireEvent.click(screen.getByTestId('xero-tenant-cancel'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('a 409 tenant_held on select keeps the picker open (the user can choose another)', async () => {
    m.fetchWithAuth.mockImplementation((url: string) => url.endsWith('/tenants')
      ? ok({ data: [{ tenantId: 't-A', name: 'Alpha Ltd' }], expiresAt: null })
      : ok({ error: 'This Xero organisation is connected to another Breeze account', code: 'accounting_tenant_held' }, 409));
    const onDone = vi.fn();
    render(<AccountingTenantPicker provider="xero" onUnauthorized={vi.fn()} onDone={onDone} />);
    fireEvent.click(await screen.findByTestId('xero-tenant-option-t-A'));
    fireEvent.click(screen.getByTestId('xero-tenant-select'));
    await waitFor(() => expect(m.fetchWithAuth).toHaveBeenCalledTimes(2));
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByTestId('xero-tenant-picker')).toBeTruthy();
  });

  // R2: GET /tenants 404 no_pending_selection — the row is gone (raced away by
  // something else), so the picker hands control back to the panel to reload.
  it('a 404 no_pending_selection on load calls onDone (the row is gone)', async () => {
    m.fetchWithAuth.mockImplementation((url: string) => url.endsWith('/tenants')
      ? ok({ error: 'gone', code: 'no_pending_selection' }, 404)
      : ok({}));
    const onDone = vi.fn();
    render(<AccountingTenantPicker provider="xero" onUnauthorized={vi.fn()} onDone={onDone} />);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  // R2: the deadline line, formatted from expiresAt, and auto-expiry when the
  // deadline passes while the picker stays open. Uses REAL timers with a
  // short (50ms) deadline rather than fake timers: RTL's `findBy*` polling
  // relies on `setInterval`, which fake timers freeze — combining the two
  // deadlocked this test (and, since the hung promise never reached its
  // `finally`, left fake timers globally active and deadlocked every test
  // after it in this file too).
  it('renders the deadline from expiresAt and auto-expires when it passes', async () => {
    const expiresAt = new Date(Date.now() + 50).toISOString();
    m.fetchWithAuth.mockImplementation((url: string) => url.endsWith('/tenants')
      ? ok({ data: [{ tenantId: 't-A', name: 'Alpha Ltd' }], expiresAt })
      : ok({}));
    render(<AccountingTenantPicker provider="xero" onUnauthorized={vi.fn()} onDone={vi.fn()} />);
    expect(await screen.findByTestId('xero-tenant-deadline')).toBeTruthy();
    expect(await screen.findByTestId('xero-tenant-expired', {}, { timeout: 3000 })).toBeTruthy();
  });

  it('renders no deadline line when expiresAt is null', async () => {
    m.fetchWithAuth.mockImplementation((url: string) => url.endsWith('/tenants')
      ? ok({ data: [{ tenantId: 't-A', name: 'Alpha Ltd' }], expiresAt: null })
      : ok({}));
    render(<AccountingTenantPicker provider="xero" onUnauthorized={vi.fn()} onDone={vi.fn()} />);
    await screen.findByTestId('xero-tenant-option-t-A');
    expect(screen.queryByTestId('xero-tenant-deadline')).toBeNull();
  });

  // R2: the error state (load failed) gets a Retry button that re-runs the load.
  it('a load failure shows Retry, which re-runs the load', async () => {
    let calls = 0;
    m.fetchWithAuth.mockImplementation((url: string) => {
      if (!url.endsWith('/tenants')) return ok({});
      calls += 1;
      return calls === 1
        ? ok({ error: 'rate limited', code: 'rate_limited' }, 429)
        : ok({ data: [{ tenantId: 't-A', name: 'Alpha Ltd' }], expiresAt: null });
    });
    render(<AccountingTenantPicker provider="xero" onUnauthorized={vi.fn()} onDone={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('xero-tenant-retry'));
    expect(await screen.findByTestId('xero-tenant-option-t-A')).toBeTruthy();
    expect(calls).toBe(2);
  });

  // R2: grant_superseded on select reloads the list instead of just clearing
  // the choice — the grant itself changed, so the old options may be stale.
  it('grant_superseded on select reloads the tenant list', async () => {
    let tenantCalls = 0;
    m.fetchWithAuth.mockImplementation((url: string) => {
      if (url.endsWith('/tenants')) {
        tenantCalls += 1;
        return tenantCalls === 1
          ? ok({ data: [{ tenantId: 't-A', name: 'Alpha Ltd' }], expiresAt: null })
          : ok({ data: [{ tenantId: 't-C', name: 'Gamma Ltd' }], expiresAt: null });
      }
      return ok({ error: 'superseded', code: 'grant_superseded' }, 409);
    });
    const onDone = vi.fn();
    render(<AccountingTenantPicker provider="xero" onUnauthorized={vi.fn()} onDone={onDone} />);
    fireEvent.click(await screen.findByTestId('xero-tenant-option-t-A'));
    fireEvent.click(screen.getByTestId('xero-tenant-select'));
    await waitFor(() => expect(tenantCalls).toBe(2));
    expect(await screen.findByTestId('xero-tenant-option-t-C')).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });

  // R2: a 401 on the GET calls onUnauthorized.
  it('a 401 on load calls onUnauthorized', async () => {
    m.fetchWithAuth.mockImplementation((url: string) => url.endsWith('/tenants')
      ? ok({}, 401)
      : ok({}));
    const onUnauthorized = vi.fn();
    render(<AccountingTenantPicker provider="xero" onUnauthorized={onUnauthorized} onDone={vi.fn()} />);
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
  });
});
