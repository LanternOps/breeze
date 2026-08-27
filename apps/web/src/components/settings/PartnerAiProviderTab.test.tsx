import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

// Deliberately NOT mocking runAction: these tests exercise the real
// no-silent-mutations wrapper so failure toasts carry the API's `error` text.
import PartnerAiProviderTab from './PartnerAiProviderTab';

function jsonRes(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const SUPPORTED_MODELS = ['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-8'];

const platformStatus = {
  configured: false,
  provider: null,
  keyLast4: null,
  defaultModel: null,
  status: 'platform',
  verifiedAt: null,
  lastError: null,
  supportedModels: SUPPORTED_MODELS,
};

const connectedStatus = {
  configured: true,
  provider: 'anthropic',
  keyLast4: '7890',
  defaultModel: 'claude-sonnet-4-6',
  status: 'active',
  verifiedAt: '2026-08-23T12:00:00.000Z',
  lastError: null,
  supportedModels: SUPPORTED_MODELS,
};

/** Route the mock fetch by method+url; GET / falls through to `initial`. */
function mockApi(initial: unknown, handlers: Record<string, () => Response> = {}) {
  fetchWithAuth.mockImplementation((url: string, options?: RequestInit) => {
    const method = options?.method ?? 'GET';
    const handler = handlers[`${method} ${url}`];
    if (handler) return Promise.resolve(handler());
    if (method === 'GET' && url === '/ai/provider') return Promise.resolve(jsonRes(initial));
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  showToast.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PartnerAiProviderTab', () => {
  it('renders the platform-key state when no partner key is configured', async () => {
    mockApi(platformStatus);
    render(<PartnerAiProviderTab />);

    await waitFor(() => expect(screen.getByTestId('ai-provider-status-card')).toBeInTheDocument());
    expect(screen.getByText('Platform key')).toBeInTheDocument();
    // No model select / disconnect until a key is connected.
    expect(screen.queryByTestId('ai-provider-model-select')).toBeNull();
    expect(screen.queryByTestId('ai-provider-disconnect')).toBeNull();
    // Workspace enrichment disclosure is always visible.
    expect(screen.getByTestId('ai-provider-workspace-note').textContent)
      .toContain('Workspace content enrichment uses your configured AI provider and appears in your AI usage');
  });

  it('renders the connected state from GET (last4, verified date, model)', async () => {
    mockApi(connectedStatus);
    render(<PartnerAiProviderTab />);

    await waitFor(() => expect(screen.getByText('Your key •••• 7890')).toBeInTheDocument());
    expect(screen.getByText(/^Verified /).textContent).toMatch(/Verified .*2026/);
    expect(screen.getByTestId('ai-provider-disconnect')).toBeInTheDocument();
    // The select's rendered value is bound to the FETCHED defaultModel — an
    // orphan select reading '' would silently show "Platform default" here.
    expect((screen.getByTestId('ai-provider-model-select') as HTMLSelectElement).value)
      .toBe('claude-sonnet-4-6');
  });

  it('saves the key via POST, refetches the stored state, and never renders the key afterwards', async () => {
    const secret = 'sk-ant-api03-super-secret-key-1234567890';
    // Model the real API: POST echoes the EFFECTIVE model (stored ?? platform
    // default) while the stored default_model stays NULL on a fresh connect.
    // The component must refetch rather than merge the POST echo, so the
    // select shows "Platform default", not a pin that was never saved.
    let connected = false;
    fetchWithAuth.mockImplementation((url: string, options?: RequestInit) => {
      const method = options?.method ?? 'GET';
      if (method === 'POST' && url === '/ai/provider/key') {
        connected = true;
        return Promise.resolve(jsonRes({
          configured: true,
          provider: 'anthropic',
          keyLast4: '7890',
          defaultModel: 'claude-sonnet-4-6',
          status: 'active',
          verifiedAt: '2026-08-23T12:00:00.000Z',
          lastError: null,
        }));
      }
      if (method === 'GET' && url === '/ai/provider') {
        return Promise.resolve(jsonRes(connected
          ? { ...connectedStatus, keyLast4: '7890', defaultModel: null }
          : platformStatus));
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    const { container } = render(<PartnerAiProviderTab />);

    await waitFor(() => expect(screen.getByTestId('ai-provider-key-input')).toBeInTheDocument());
    const input = screen.getByTestId('ai-provider-key-input') as HTMLInputElement;
    expect(input.type).toBe('password'); // write-only field
    fireEvent.change(input, { target: { value: secret } });
    fireEvent.click(screen.getByTestId('ai-provider-save-key'));

    await waitFor(() => expect(screen.getByText('Your key •••• 7890')).toBeInTheDocument());
    expect(fetchWithAuth).toHaveBeenCalledWith('/ai/provider/key', {
      method: 'POST',
      body: JSON.stringify({ apiKey: secret }),
    });
    // The key must be gone from the input and absent from the DOM entirely.
    expect(input.value).toBe('');
    expect(container.innerHTML).not.toContain(secret);
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', message: 'Anthropic key saved and verified.' }),
    );
    // Stored default_model is NULL — the POST echo's effective model must not
    // appear as a selected pin.
    expect((screen.getByTestId('ai-provider-model-select') as HTMLSelectElement).value).toBe('');
  });

  it('surfaces the API error message when the key is rejected', async () => {
    mockApi(platformStatus, {
      'POST /ai/provider/key': () => jsonRes({ error: 'Anthropic denied access for that API key.' }, 409),
    });
    render(<PartnerAiProviderTab />);

    await waitFor(() => expect(screen.getByTestId('ai-provider-key-input')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('ai-provider-key-input'), {
      target: { value: 'sk-ant-api03-rejected-key-1234567890' },
    });
    fireEvent.click(screen.getByTestId('ai-provider-save-key'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'Anthropic denied access for that API key.' }),
    ));
    // Still the platform state — the rejected key connected nothing.
    expect(screen.getByText('Platform key')).toBeInTheDocument();
  });

  it('PATCHes the default model on change and keeps the select bound', async () => {
    mockApi(connectedStatus, {
      'PATCH /ai/provider': () => jsonRes({ defaultModel: 'claude-haiku-4-5', configVersion: 4 }),
    });
    render(<PartnerAiProviderTab />);

    await waitFor(() => expect(screen.getByTestId('ai-provider-model-select')).toBeInTheDocument());
    const select = screen.getByTestId('ai-provider-model-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'claude-haiku-4-5' } });

    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/ai/provider', {
      method: 'PATCH',
      body: JSON.stringify({ defaultModel: 'claude-haiku-4-5' }),
    }));
    expect(select.value).toBe('claude-haiku-4-5');
  });

  it('sends defaultModel null when "Platform default" is selected', async () => {
    mockApi(connectedStatus, {
      'PATCH /ai/provider': () => jsonRes({ defaultModel: null, configVersion: 4 }),
    });
    render(<PartnerAiProviderTab />);

    await waitFor(() => expect(screen.getByTestId('ai-provider-model-select')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('ai-provider-model-select'), { target: { value: '' } });

    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/ai/provider', {
      method: 'PATCH',
      body: JSON.stringify({ defaultModel: null }),
    }));
  });

  it('reverts the model selection when the PATCH fails', async () => {
    mockApi(connectedStatus, {
      'PATCH /ai/provider': () => jsonRes({ error: 'Unsupported model.' }, 400),
    });
    render(<PartnerAiProviderTab />);

    await waitFor(() => expect(screen.getByTestId('ai-provider-model-select')).toBeInTheDocument());
    const select = screen.getByTestId('ai-provider-model-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'claude-haiku-4-5' } });

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'Unsupported model.' }),
    ));
    await waitFor(() => expect(select.value).toBe('claude-sonnet-4-6'));
  });

  it('disconnects after confirmation and returns to the platform state', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockApi(connectedStatus, {
      'DELETE /ai/provider': () => jsonRes({ configured: false, status: 'platform' }),
    });
    render(<PartnerAiProviderTab />);

    await waitFor(() => expect(screen.getByTestId('ai-provider-disconnect')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('ai-provider-disconnect'));

    await waitFor(() => expect(screen.getByText('Platform key')).toBeInTheDocument());
    expect(window.confirm).toHaveBeenCalled();
    expect(fetchWithAuth).toHaveBeenCalledWith('/ai/provider', { method: 'DELETE' });
    expect(screen.queryByTestId('ai-provider-model-select')).toBeNull();
  });

  it('does not DELETE when the disconnect confirmation is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    mockApi(connectedStatus);
    render(<PartnerAiProviderTab />);

    await waitFor(() => expect(screen.getByTestId('ai-provider-disconnect')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('ai-provider-disconnect'));

    expect(fetchWithAuth).not.toHaveBeenCalledWith('/ai/provider', { method: 'DELETE' });
    expect(screen.getByText('Your key •••• 7890')).toBeInTheDocument();
  });

  it('renders the lastError banner with a reconnect hint in the error state', async () => {
    mockApi({
      ...connectedStatus,
      status: 'error',
      lastError: 'Anthropic rejected the saved key (401 authentication_error).',
    });
    render(<PartnerAiProviderTab />);

    await waitFor(() => expect(screen.getByTestId('ai-provider-error-banner')).toBeInTheDocument());
    const banner = screen.getByTestId('ai-provider-error-banner');
    expect(banner.textContent).toContain('Anthropic rejected the saved key (401 authentication_error).');
    expect(banner.textContent).toContain('until you save a working key below');
  });

  it('shows the permission message on a 403 instead of the platform card', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ error: 'Permission denied' }, 403));
    render(<PartnerAiProviderTab />);

    await waitFor(() => expect(screen.getByTestId('ai-provider-forbidden')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-provider-status-card')).toBeNull();
  });
});
