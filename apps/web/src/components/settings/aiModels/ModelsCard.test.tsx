import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { jsonRes, CONN, GW, GATEWAY_CONNECTION } from './testFixtures';
import { OFF, PM, RATES, offeringRow as row, synthRow, snapWith as snap } from './offeringFixtures';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const showToast = vi.fn();
vi.mock('../../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import ModelsCard from './ModelsCard';

beforeEach(() => { fetchWithAuth.mockReset(); showToast.mockReset(); });

describe('ModelsCard', () => {
  it('adds and enables a not-yet-added platform model in one call, toasting the rate', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: OFF, enabled: true, updatedAt: '2026-10-01T00:00:00.000Z' }));
    const onChanged = vi.fn();
    render(<ModelsCard snapshot={snap([synthRow({ platformModelId: PM, rates: RATES })])} onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId(`ai-offering-enable-pm-${PM}`));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(`/ai/models/offerings/platform/${PM}`, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ enabled: true }),
    })));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: expect.stringMatching(/\$3\.00.*\$15\.00/) })));
    expect(onChanged).toHaveBeenCalled();
  });

  it('disables the switch with the reason when the enable gate blocks it', () => {
    render(<ModelsCard snapshot={snap([row({ id: OFF, enableBlocker: 'plan_required' })])} onChanged={vi.fn()} />);
    expect((screen.getByTestId(`ai-offering-enable-${OFF}`) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId(`ai-offering-blocker-${OFF}`).textContent).toMatch(/plan/i);
  });

  it('explains a residency blocker', () => {
    render(<ModelsCard snapshot={snap([row({ id: OFF, enableBlocker: 'residency_unavailable' })])} onChanged={vi.fn()} />);
    expect(screen.getByTestId(`ai-offering-blocker-${OFF}`).textContent).toMatch(/region/i);
  });

  it('a connection problem warns but does not block the switch', () => {
    render(<ModelsCard snapshot={snap([row({ id: OFF, connectionId: CONN, funding: 'partner_key', enableBlocker: 'connection_unavailable' })])} onChanged={vi.fn()} />);
    expect((screen.getByTestId(`ai-offering-enable-${OFF}`) as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByTestId(`ai-offering-blocker-${OFF}`)).toBeTruthy();
  });

  it('an already-enabled row stays switch-off-able even if it became blocked', () => {
    render(<ModelsCard snapshot={snap([row({ id: OFF, enabled: true, enableBlocker: 'plan_required' })])} onChanged={vi.fn()} />);
    expect((screen.getByTestId(`ai-offering-enable-${OFF}`) as HTMLInputElement).disabled).toBe(false);
  });

  it('disable confirm lists affected surfaces and only then sends force', async () => {
    render(<ModelsCard snapshot={snap([row({ id: OFF, enabled: true, defaultFor: [{ surface: 'chat', level: 'partner', orgId: null }, { surface: 'helper', level: 'org', orgId: 'o1' }] })])} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId(`ai-offering-enable-${OFF}`));
    const dialog = await screen.findByTestId('ai-offering-disable-confirm');
    const surfaces = within(dialog).getByTestId('ai-offering-disable-confirm-surfaces').textContent ?? '';
    expect(surfaces).toMatch(/Chat/);
    expect(surfaces).toMatch(/Helper/);
    expect(fetchWithAuth).not.toHaveBeenCalled();
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: OFF, enabled: false, inUse: [] }));
    fireEvent.click(screen.getByTestId('ai-offering-disable-confirm-submit'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(`/ai/models/offerings/${OFF}/enabled`, expect.objectContaining({
      body: JSON.stringify({ enabled: false, force: true }),
    })));
  });

  it('disabling a non-default offering sends no force and no confirm', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: OFF, enabled: false, inUse: [] }));
    render(<ModelsCard snapshot={snap([row({ id: OFF, enabled: true })])} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId(`ai-offering-enable-${OFF}`));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(`/ai/models/offerings/${OFF}/enabled`, expect.objectContaining({
      body: JSON.stringify({ enabled: false }),
    })));
    expect(screen.queryByTestId('ai-offering-disable-confirm')).toBeNull();
  });

  it('a stale in-use race (409 offering_in_use) opens the same confirm', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'in use', code: 'offering_in_use', details: { inUse: [{ surface: 'helper', level: 'org', orgId: 'o1' }] } }, 409));
    render(<ModelsCard snapshot={snap([row({ id: OFF, enabled: true, defaultFor: [] })])} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId(`ai-offering-enable-${OFF}`));
    const dialog = await screen.findByTestId('ai-offering-disable-confirm');
    expect(within(dialog).getByTestId('ai-offering-disable-confirm-surfaces').textContent).toMatch(/Helper/);
  });

  it('shows price, fast rate, no-price, unverified and lifecycle badges', () => {
    render(<ModelsCard snapshot={snap([
      row({ id: OFF, fastRates: RATES, thinkingMode: 'unknown', lifecycle: 'retired', defaultFor: [{ surface: 'chat', level: 'partner', orgId: null }] }),
      row({ id: 'o2', rates: null }),
    ])} onChanged={vi.fn()} />);
    const price = screen.getByTestId(`ai-offering-price-${OFF}`).textContent ?? '';
    expect(price).toMatch(/\$3\.00/);
    expect(price).toMatch(/Fast/);
    expect(screen.getByTestId('ai-offering-price-o2').textContent).toMatch(/No price/);
    const rowText = screen.getByTestId(`ai-offering-row-${OFF}`).textContent ?? '';
    expect(rowText).toMatch(/unverified/i);
    expect(rowText).toMatch(/retired/i);
  });

  it('groups by connection, platform first, and keeps Details off synthesized rows', () => {
    render(<ModelsCard snapshot={snap([
      row({ id: 'o-conn', connectionId: CONN, funding: 'partner_key', displayName: 'Mine' }),
      synthRow({ platformModelId: PM, displayName: 'Plat' }),
    ])} onChanged={vi.fn()} />);
    const text = screen.getByTestId('ai-models-card').textContent ?? '';
    expect(text.indexOf('Breeze platform')).toBeLessThan(text.indexOf('Anthropic'));
    expect((screen.getByTestId(`ai-offering-edit-pm-${PM}`) as HTMLButtonElement).disabled).toBe(true);
  });

  it('opens the drawer from Details', () => {
    render(<ModelsCard snapshot={snap([row({ id: OFF })])} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId(`ai-offering-edit-${OFF}`));
    expect(screen.getByTestId('ai-offering-drawer')).toBeTruthy();
  });

  it('shows a registry-unavailable 503 as an error toast and does not reload', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'upgrading', code: 'registry_unavailable' }, 503));
    const onChanged = vi.fn();
    render(<ModelsCard snapshot={snap([row({ id: OFF })])} onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId(`ai-offering-enable-${OFF}`));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringMatching(/upgrad/i) })));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('shows a registry-busy 503 with the localized try-again message', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'server text', code: 'registry_busy' }, 503));
    render(<ModelsCard snapshot={snap([row({ id: OFF })])} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId(`ai-offering-enable-${OFF}`));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: 'Another AI configuration change is in progress. Try again in a moment.',
    })));
  });

  describe('gateway (BYO OpenAI-compatible) models', () => {
    const gwSnap = (offerings: ReturnType<typeof row>[], managedBy: 'env' | null = null) =>
      ({ ...snap(offerings), connections: [{ ...GATEWAY_CONNECTION, managedBy }] });
    const gw = (over: Parameters<typeof row>[0] = {}) => row({ id: OFF, connectionId: GW, funding: 'partner_key', source: 'discovered', ...over });

    it.each([
      ['verified', null, /^Verified/],
      ['unverified', null, /Not verified/],
      ['failed', 'Tool call returned no arguments', /Verification failed: Tool call returned no arguments/],
      ['stale', null, /Re-verify: endpoint changed/],
    ] as const)('shows the %s verification badge', (state, summary, expected) => {
      render(<ModelsCard snapshot={gwSnap([gw({ verification: { state, at: null, harnessVersion: null, summary } })])} onChanged={vi.fn()} />);
      expect(screen.getByTestId(`ai-model-verification-${OFF}`).textContent).toMatch(expected);
    });

    it('shows no verification badge for a non-gateway offering', () => {
      render(<ModelsCard snapshot={snap([row({ id: OFF })])} onChanged={vi.fn()} />);
      expect(screen.queryByTestId(`ai-model-verification-${OFF}`)).toBeNull();
    });

    it('an unpriced gateway model disables its switch and says to set a price', () => {
      render(<ModelsCard snapshot={gwSnap([gw({ rates: null, priceSource: null, enableBlocker: 'unpriced', verification: { state: 'unverified', at: null, harnessVersion: null, summary: null } })])} onChanged={vi.fn()} />);
      expect((screen.getByTestId(`ai-offering-enable-${OFF}`) as HTMLInputElement).disabled).toBe(true);
      expect(screen.getByTestId(`ai-offering-blocker-${OFF}`).textContent).toBe('Set a price to enable');
    });

    it('offers Add model on a gateway connection (even with no models yet) and opens the manual form', () => {
      render(<ModelsCard snapshot={gwSnap([])} onChanged={vi.fn()} />);
      fireEvent.click(screen.getByTestId(`ai-models-add-manual-${GW}`));
      expect(screen.getByTestId('ai-manual-model-id')).toBeTruthy();
    });

    it('does not offer Add model on a non-gateway connection or an env-managed one', () => {
      const { unmount } = render(<ModelsCard snapshot={snap([row({ id: OFF, connectionId: CONN, funding: 'partner_key' })])} onChanged={vi.fn()} />);
      expect(screen.queryByTestId(`ai-models-add-manual-${CONN}`)).toBeNull();
      unmount();
      render(<ModelsCard snapshot={gwSnap([gw()], 'env')} onChanged={vi.fn()} />);
      expect(screen.queryByTestId(`ai-models-add-manual-${GW}`)).toBeNull();
    });
  });
});
