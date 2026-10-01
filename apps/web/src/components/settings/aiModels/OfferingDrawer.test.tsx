import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AiOfferingDto } from '@breeze/shared';
import { jsonRes, CONN } from './testFixtures';
import { OFF, RATES, offeringRow as row } from './offeringFixtures';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const showToast = vi.fn();
vi.mock('../../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import OfferingDrawer from './OfferingDrawer';

const SUPPORT_FAST: AiOfferingDto['optionSupport'] = { effort: [], thinkingDisplay: [], speed: ['standard', 'fast'], inferenceGeo: [] };
const body = () => JSON.parse(fetchWithAuth.mock.calls[0][1].body);

beforeEach(() => { fetchWithAuth.mockReset(); showToast.mockReset(); });

describe('OfferingDrawer', () => {
  it('sends only changed fields with expectedUpdatedAt', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: OFF, updatedAt: '2026-10-02T00:00:00.000Z' }));
    render(<OfferingDrawer offering={row({ id: OFF, updatedAt: '2026-10-01T00:00:00.000Z' })} offerings={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ai-offering-premium'));
    fireEvent.click(screen.getByTestId('ai-offering-save'));
    await waitFor(() => expect(body()).toEqual({ expectedUpdatedAt: '2026-10-01T00:00:00.000Z', requiredPermission: 'ai_models:premium' }));
    expect(fetchWithAuth.mock.calls[0][0]).toBe(`/ai/models/offerings/${OFF}`);
    expect(fetchWithAuth.mock.calls[0][1].method).toBe('PATCH');
  });

  it('disables Save until something changed', () => {
    render(<OfferingDrawer offering={row()} offerings={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect((screen.getByTestId('ai-offering-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('hides price inputs on a platform offering and shows the source', () => {
    render(<OfferingDrawer offering={row({ id: OFF, pricesEditable: false, priceSource: 'platform' })} offerings={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByTestId('ai-offering-price-input')).toBeNull();
    expect(screen.getByTestId('ai-offering-drawer').textContent).toMatch(/Breeze platform/);
  });

  it('edits prices on an own-priced offering and sends all four', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: OFF, updatedAt: 'x' }));
    render(<OfferingDrawer offering={row({ id: OFF, connectionId: CONN, funding: 'partner_key', pricesEditable: true, priceSource: 'offering', rates: RATES, ownPrices: RATES })} offerings={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('ai-offering-price-input'), { target: { value: '400' } });
    fireEvent.click(screen.getByTestId('ai-offering-save'));
    await waitFor(() => expect(body().prices).toEqual({ ...RATES, inputCentsPerM: 400 }));
  });

  it('blocks a partly filled price set', () => {
    render(<OfferingDrawer offering={row({ id: OFF, pricesEditable: true, ownPrices: RATES, priceSource: 'offering' })} offerings={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('ai-offering-price-output'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('ai-offering-save'));
    expect(fetchWithAuth).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('offers only same-connection enabled offerings as the refusal fallback', () => {
    const others = [
      row({ id: 'o2', connectionId: null, enabled: true, displayName: 'Same' }),
      row({ id: 'o3', connectionId: CONN, enabled: true, displayName: 'Other conn' }),
      row({ id: 'o4', connectionId: null, enabled: false, displayName: 'Off' }),
      row({ id: OFF, connectionId: null, enabled: true, displayName: 'Self' }),
    ];
    render(<OfferingDrawer offering={row({ id: OFF, connectionId: null })} offerings={others} onClose={vi.fn()} onSaved={vi.fn()} />);
    const opts = [...(screen.getByTestId('ai-offering-refusal-fallback') as HTMLSelectElement).options].map((o) => o.textContent);
    expect(opts).toEqual(['None', 'Same']);
  });

  it('a rename keeps stored option restrictions (no allowedOptions in the patch)', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: OFF, updatedAt: '2026-10-02T00:00:00.000Z' }));
    render(<OfferingDrawer offering={row({ id: OFF, updatedAt: '2026-10-01T00:00:00.000Z', fastRates: RATES,
      optionSupport: { effort: ['low'], thinkingDisplay: ['summarized'], speed: ['standard', 'fast'], inferenceGeo: [] },
      allowedOptions: { speed: ['standard'], thinkingDisplay: ['summarized'] } })} offerings={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('ai-offering-display-name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByTestId('ai-offering-save'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    expect(body()).toEqual({ expectedUpdatedAt: '2026-10-01T00:00:00.000Z', displayName: 'Renamed' });
  });

  it('merges an effort edit into the stored allow-list, preserving speed and thinkingDisplay', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: OFF, updatedAt: 'x' }));
    render(<OfferingDrawer offering={row({ id: OFF, fastRates: RATES,
      optionSupport: { effort: ['low', 'high'], thinkingDisplay: ['summarized'], speed: ['standard', 'fast'], inferenceGeo: [] },
      allowedOptions: { speed: ['standard'], thinkingDisplay: ['summarized'] } })} offerings={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ai-offering-allowed-effort-high'));
    fireEvent.click(screen.getByTestId('ai-offering-save'));
    await waitFor(() => expect(body().allowedOptions).toEqual({ speed: ['standard'], thinkingDisplay: ['summarized'], effort: ['low'] }));
  });

  it('allowing Fast on a platform offering also requires the premium permission', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: OFF, updatedAt: 'x' }));
    render(<OfferingDrawer offering={row({ id: OFF, funding: 'platform', fastRates: RATES, optionSupport: SUPPORT_FAST, allowedOptions: { speed: ['standard'] } })} offerings={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ai-offering-allow-fast'));
    const premium = screen.getByTestId('ai-offering-premium') as HTMLInputElement;
    expect([premium.checked, premium.disabled]).toEqual([true, true]);
    fireEvent.click(screen.getByTestId('ai-offering-save'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    // Fast allowed = unrestricted speed, so the stored speed list is dropped (allowedOptions → null).
    expect(body()).toEqual({ expectedUpdatedAt: '2026-10-01T00:00:00.000Z', allowedOptions: null, requiredPermission: 'ai_models:premium' });
  });

  it('a legacy fast-capable platform row (no stored restriction or permission) opens with Save disabled', () => {
    render(<OfferingDrawer offering={row({ id: OFF, funding: 'platform', fastRates: RATES, optionSupport: SUPPORT_FAST, allowedOptions: null, requiredPermission: null })} offerings={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect((screen.getByTestId('ai-offering-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('renaming a legacy fast-capable platform row sends only the name (never adds requiredPermission)', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: OFF, updatedAt: 'x' }));
    render(<OfferingDrawer offering={row({ id: OFF, funding: 'platform', fastRates: RATES, optionSupport: SUPPORT_FAST, allowedOptions: null, requiredPermission: null })} offerings={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('ai-offering-display-name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByTestId('ai-offering-save'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    expect(body()).toEqual({ expectedUpdatedAt: '2026-10-01T00:00:00.000Z', displayName: 'Renamed' });
  });

  it('lists Fast only when the model has a fast rate', () => {
    render(<OfferingDrawer offering={row({ id: OFF, fastRates: null, optionSupport: SUPPORT_FAST })} offerings={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect([...(screen.getByTestId('ai-offering-default-speed') as HTMLSelectElement).options].map((o) => o.value)).not.toContain('fast');
    expect(screen.queryByTestId('ai-offering-allow-fast')).toBeNull();
  });

  it('lists Fast with its rate once allowed', () => {
    render(<OfferingDrawer offering={row({ id: OFF, fastRates: RATES, optionSupport: SUPPORT_FAST, allowedOptions: { speed: ['standard'] } })} offerings={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    const speed = screen.getByTestId('ai-offering-default-speed') as HTMLSelectElement;
    expect([...speed.options].map((o) => o.value)).not.toContain('fast');
    fireEvent.click(screen.getByTestId('ai-offering-allow-fast'));
    const fast = [...speed.options].find((o) => o.value === 'fast');
    expect(fast?.textContent).toMatch(/\$3\.00/);
  });

  it('a stale write toasts, reloads and closes', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'stale', code: 'stale_write' }, 409));
    const onClose = vi.fn();
    const onSaved = vi.fn();
    render(<OfferingDrawer offering={row({ id: OFF })} offerings={[]} onClose={onClose} onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('ai-offering-premium'));
    fireEvent.click(screen.getByTestId('ai-offering-save'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSaved).toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('surfaces the approvals:decide 403 and stays open', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'x', code: 'APPROVALS_DECIDE_REQUIRED' }, 403));
    const onClose = vi.fn();
    render(<OfferingDrawer offering={row({ id: OFF })} offerings={[]} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ai-offering-premium'));
    fireEvent.click(screen.getByTestId('ai-offering-save'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/approvals:decide/) })));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('verify queues a model check for the offering connection via runAction and toasts', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ queued: true, connectionId: CONN }, 202));
    const onClose = vi.fn();
    render(<OfferingDrawer offering={row({ id: OFF, connectionId: CONN, funding: 'partner_key' })} offerings={[]} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ai-offering-verify'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(`/ai/models/offerings/${OFF}/verify`, expect.objectContaining({ method: 'POST' })));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: expect.stringMatching(/check queued/i) })));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('verify failure toasts and stays open', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'Model not found', code: 'not_found' }, 404));
    const onClose = vi.fn();
    render(<OfferingDrawer offering={row({ id: OFF, connectionId: CONN, funding: 'partner_key' })} offerings={[]} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ai-offering-verify'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('hides verify for platform offerings (the operator verifies those)', () => {
    render(<OfferingDrawer offering={row({ id: OFF, connectionId: null, funding: 'platform' })} offerings={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByTestId('ai-offering-verify')).toBeNull();
  });
});
