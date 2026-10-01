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
    fireEvent.change(screen.getByTestId('ai-models-rate-inputCentsPerM'), { target: { value: '400' } });
    fireEvent.change(screen.getByTestId('ai-models-rate-outputCentsPerM'), { target: { value: '2000' } });
    fireEvent.change(screen.getByTestId('ai-models-rate-cacheReadCentsPerM'), { target: { value: '20' } });
    fireEvent.change(screen.getByTestId('ai-models-rate-cacheWriteCentsPerM'), { target: { value: '500' } });
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

  it('refuses a partial price set before calling the API', async () => {
    mockApi();
    render(<AiModels />);
    fireEvent.click(await screen.findByTestId('ai-models-row-id-new-edit'));
    fireEvent.change(await screen.findByTestId('ai-models-rate-inputCentsPerM'), { target: { value: '400' } });
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
