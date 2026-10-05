import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

// Deliberately NOT mocking runAction: the real wrapper must surface the API's error text.
import AiModels, { type AdminPlatformModel } from './AiModels';

function jsonRes(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const RATES = { inputCentsPerM: 400, outputCentsPerM: 2000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 500 };
const OPUS: AdminPlatformModel = {
  id: 'id-opus', modelId: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', maxInputTokens: 1_000_000, maxOutputTokens: 128_000,
  derived: { thinkingMode: 'adaptive', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsTools: true, supportsVision: true },
  rates: RATES, optionRates: null,
  optionSupport: { effort: ['low', 'medium', 'high', 'xhigh', 'max'], thinkingDisplay: ['omitted', 'summarized', 'updates'], speed: ['standard', 'fast'], inferenceGeo: [] },
  minPlan: null, promptProfile: 'claude-frontier', platformOffered: true, isPlatformDefault: false, lifecycle: 'available',
  firstSeenAt: '2026-11-13T00:00:00.000Z', lastSeenAt: null, updatedAt: '2026-11-13T00:00:00.000Z',
};
const NEW_MODEL: AdminPlatformModel = {
  ...OPUS, id: 'id-new', modelId: 'vendor-new-model', displayName: 'New model', rates: null, platformOffered: false,
  promptProfile: 'generic', lastSeenAt: '2026-11-20T06:38:00.000Z',
  optionSupport: { effort: ['low', 'medium', 'high', 'xhigh', 'max'], thinkingDisplay: ['omitted', 'summarized'], speed: ['standard'], inferenceGeo: [] },
};
const LIST = { models: [OPUS, NEW_MODEL], planOptions: ['free', 'starter', 'community', 'pro', 'enterprise', 'unlimited'] };

function mockApi(handlers: Record<string, () => Response> = {}) {
  fetchWithAuth.mockImplementation((url: string, options?: RequestInit) => {
    const method = options?.method ?? 'GET';
    const handler = handlers[`${method} ${url}`];
    if (handler) return Promise.resolve(handler());
    if (method === 'GET' && url === '/admin/ai-models') return Promise.resolve(jsonRes(LIST));
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
}

function patchBody(): Record<string, unknown> {
  const call = fetchWithAuth.mock.calls.find(([, opts]) => (opts as RequestInit | undefined)?.method === 'PATCH');
  return JSON.parse(String((call?.[1] as RequestInit).body));
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  showToast.mockReset();
});

describe('AiModels admin page', () => {
  it('lists models with price, lifecycle and a New badge on unpriced discoveries', async () => {
    mockApi();
    render(<AiModels />);
    expect(await screen.findByTestId('ai-models-row-id-opus')).toBeTruthy();
    expect(screen.getByTestId('ai-models-row-id-opus-price').textContent).toBe('$4.00 / $20.00');
    expect(screen.getByTestId('ai-models-row-id-new-price').textContent).toBe('Unpriced');
    expect(screen.getByTestId('ai-models-row-id-new-new')).toBeTruthy();
    expect(screen.queryByTestId('ai-models-row-id-opus-new')).toBeNull();
  });

  it('shows the platform-admin panel on 403', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ error: 'forbidden' }, 403));
    render(<AiModels />);
    expect(await screen.findByTestId('ai-models-requires-platform-admin')).toBeTruthy();
  });

  it('saves a priced, offered model through the row drawer with PATCH', async () => {
    mockApi({ 'PATCH /admin/ai-models/id-new': () => jsonRes({ model: { ...NEW_MODEL, rates: RATES, platformOffered: true } }) });
    render(<AiModels />);
    fireEvent.click(await screen.findByTestId('ai-models-row-id-new-edit'));
    expect(await screen.findByTestId('ai-models-drawer')).toBeTruthy();
    fireEvent.change(screen.getByTestId('ai-models-rate-inputCentsPerM'), { target: { value: '4' } });
    fireEvent.change(screen.getByTestId('ai-models-rate-outputCentsPerM'), { target: { value: '20' } });
    fireEvent.change(screen.getByTestId('ai-models-rate-cacheReadCentsPerM'), { target: { value: '0.2' } });
    fireEvent.change(screen.getByTestId('ai-models-rate-cacheWriteCentsPerM'), { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('ai-models-offered'));
    fireEvent.change(screen.getByTestId('ai-models-min-plan'), { target: { value: 'pro' } });
    fireEvent.click(screen.getByTestId('ai-models-save'));
    await waitFor(() => expect(patchBody()).toEqual({
      rates: RATES,
      optionRates: null,
      optionSupport: { effort: ['low', 'medium', 'high', 'xhigh', 'max'], thinkingDisplay: ['omitted', 'summarized'], speed: ['standard'], inferenceGeo: [] },
      minPlan: 'pro',
      promptProfile: 'generic',
      platformOffered: true,
      isPlatformDefault: false,
    }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
  });

  describe('price units (#7692)', () => {
    const patched = () => fetchWithAuth.mock.calls.some(([, opts]) => (opts as RequestInit | undefined)?.method === 'PATCH');
    const type = (id: string, value: string) => fireEvent.change(screen.getByTestId(id), { target: { value } });

    async function openOpus() {
      mockApi({ 'PATCH /admin/ai-models/id-opus': () => jsonRes({ model: OPUS }) });
      render(<AiModels />);
      fireEvent.click(await screen.findByTestId('ai-models-row-id-opus-edit'));
      await screen.findByTestId('ai-models-drawer');
    }

    it('shows the same unit as the table: stored cents render as dollars in the fields', async () => {
      await openOpus();
      expect(screen.getByTestId('ai-models-row-id-opus-price').textContent).toBe('$4.00 / $20.00');
      expect((screen.getByTestId('ai-models-rate-inputCentsPerM') as HTMLInputElement).value).toBe('4');
      expect((screen.getByTestId('ai-models-rate-outputCentsPerM') as HTMLInputElement).value).toBe('20');
      expect((screen.getByTestId('ai-models-rate-cacheReadCentsPerM') as HTMLInputElement).value).toBe('0.2');
      expect(screen.getByTestId('ai-models-rate-inputCentsPerM-stored').textContent).toContain('$4.00');
    });

    it('typing 2.5 saves 250 cents (a within-10× change needs no confirm)', async () => {
      await openOpus();
      type('ai-models-rate-inputCentsPerM', '2.5');
      fireEvent.click(screen.getByTestId('ai-models-save'));
      await waitFor(() => expect(patched()).toBe(true));
      expect(screen.queryByTestId('ai-models-price-confirm')).toBeNull();
      expect((patchBody().rates as { inputCentsPerM: number }).inputCentsPerM).toBe(250);
    });

    it('a >10× change shows stored → new and does not save until confirmed', async () => {
      await openOpus();
      type('ai-models-rate-inputCentsPerM', '0.025'); // the #7692 slip: 2.5 cents is $0.025
      fireEvent.click(screen.getByTestId('ai-models-save'));
      const confirm = await screen.findByTestId('ai-models-price-confirm');
      expect(confirm.textContent).toContain('$4.00');
      expect(confirm.textContent).toContain('$0.025');
      expect(patched()).toBe(false);
      fireEvent.click(screen.getByTestId('ai-models-price-confirm-save'));
      await waitFor(() => expect(patched()).toBe(true));
      expect((patchBody().rates as { inputCentsPerM: number }).inputCentsPerM).toBe(2.5);
    });

    it('a cancelled confirm does not save', async () => {
      await openOpus();
      type('ai-models-rate-inputCentsPerM', '400');
      fireEvent.click(screen.getByTestId('ai-models-save'));
      await screen.findByTestId('ai-models-price-confirm');
      fireEvent.click(screen.getByTestId('ai-models-price-confirm-back'));
      expect(screen.queryByTestId('ai-models-price-confirm')).toBeNull();
      expect(patched()).toBe(false);
      expect((screen.getByTestId('ai-models-rate-inputCentsPerM') as HTMLInputElement).value).toBe('400');
    });

    it('clearing all prices on a priced model needs confirm and shows Unpriced', async () => {
      await openOpus();
      for (const key of ['inputCentsPerM', 'outputCentsPerM', 'cacheReadCentsPerM', 'cacheWriteCentsPerM']) type(`ai-models-rate-${key}`, '');
      fireEvent.click(screen.getByTestId('ai-models-save'));
      const confirm = await screen.findByTestId('ai-models-price-confirm');
      expect(confirm.textContent).toContain('Unpriced');
      expect(patched()).toBe(false);
    });

    it('a drop to zero needs confirm; exactly 10× does not', async () => {
      await openOpus();
      type('ai-models-rate-inputCentsPerM', '0');
      fireEvent.click(screen.getByTestId('ai-models-save'));
      await screen.findByTestId('ai-models-price-confirm');
      type('ai-models-rate-inputCentsPerM', '40'); // exactly 10× of $4
      expect(screen.queryByTestId('ai-models-price-confirm')).toBeNull();
      fireEvent.click(screen.getByTestId('ai-models-save'));
      await waitFor(() => expect(patched()).toBe(true));
    });

    it('editing a field after the confirm appears dismisses it so a stale confirm cannot approve new values', async () => {
      await openOpus();
      type('ai-models-rate-inputCentsPerM', '0.025');
      fireEvent.click(screen.getByTestId('ai-models-save'));
      await screen.findByTestId('ai-models-price-confirm');
      type('ai-models-rate-inputCentsPerM', '3');
      expect(screen.queryByTestId('ai-models-price-confirm')).toBeNull();
      expect(patched()).toBe(false);
    });

    it('saving without touching prices round-trips the stored cents exactly (0.2 → 20)', async () => {
      await openOpus();
      fireEvent.click(screen.getByTestId('ai-models-save'));
      await waitFor(() => expect(patched()).toBe(true));
      expect(patchBody().rates).toEqual(RATES);
    });

    it('applies the same unit and guard to speed:fast option rates', async () => {
      const withFast = { ...OPUS, optionRates: { 'speed:fast': { inputCentsPerM: 800, outputCentsPerM: 4000, cacheReadCentsPerM: 40, cacheWriteCentsPerM: 1000 } } };
      fetchWithAuth.mockImplementation((_url: string, options?: RequestInit) => {
        if ((options?.method ?? 'GET') === 'PATCH') return Promise.resolve(jsonRes({ model: withFast }));
        return Promise.resolve(jsonRes({ ...LIST, models: [withFast] }));
      });
      render(<AiModels />);
      fireEvent.click(await screen.findByTestId('ai-models-row-id-opus-edit'));
      expect(((await screen.findByTestId('ai-models-fast-rate-inputCentsPerM')) as HTMLInputElement).value).toBe('8');
      type('ai-models-fast-rate-inputCentsPerM', '0.08');
      fireEvent.click(screen.getByTestId('ai-models-save'));
      expect((await screen.findByTestId('ai-models-price-confirm-fast-inputCentsPerM')).textContent).toContain('$8.00');
      expect(patched()).toBe(false);
      fireEvent.click(screen.getByTestId('ai-models-price-confirm-save'));
      await waitFor(() => expect(patched()).toBe(true));
      const body = patchBody() as { optionRates: { 'speed:fast': { inputCentsPerM: number } } };
      expect(body.optionRates['speed:fast'].inputCentsPerM).toBe(8);
    });
  });

  it('refuses a partial price set before calling the API', async () => {
    mockApi();
    render(<AiModels />);
    fireEvent.click(await screen.findByTestId('ai-models-row-id-new-edit'));
    fireEvent.change(await screen.findByTestId('ai-models-rate-inputCentsPerM'), { target: { value: '4' } });
    fireEvent.click(screen.getByTestId('ai-models-save'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(fetchWithAuth.mock.calls.some(([, opts]) => (opts as RequestInit | undefined)?.method === 'PATCH')).toBe(false);
  });

  it('toasts the API error text when a save is refused', async () => {
    mockApi({ 'PATCH /admin/ai-models/id-opus': () => jsonRes({ error: 'Set all four prices before offering this model.' }, 400) });
    render(<AiModels />);
    fireEvent.click(await screen.findByTestId('ai-models-row-id-opus-edit'));
    fireEvent.click(await screen.findByTestId('ai-models-save'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: 'Set all four prices before offering this model.',
    })));
  });

  it('queues a refresh', async () => {
    mockApi({ 'POST /admin/ai-models/refresh': () => jsonRes({ queued: true, jobId: 'j' }, 202) });
    render(<AiModels />);
    await screen.findByTestId('ai-models-table');
    fireEvent.click(screen.getByTestId('ai-models-refresh'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Model refresh queued.' })));
  });

  it('locks the offered and default toggles on the current platform default', async () => {
    mockApi();
    const defaultModel = { ...OPUS, isPlatformDefault: true };
    fetchWithAuth.mockImplementation(() => Promise.resolve(jsonRes({ ...LIST, models: [defaultModel] })));
    render(<AiModels />);
    fireEvent.click(await screen.findByTestId('ai-models-row-id-opus-edit'));
    expect((await screen.findByTestId('ai-models-offered') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('ai-models-default') as HTMLInputElement).disabled).toBe(true);
  });
});
