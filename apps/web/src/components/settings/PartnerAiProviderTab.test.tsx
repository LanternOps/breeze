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
  catalogEntryId: null,
  catalog: [],
};

const CATALOG_ENTRY = {
  entryId: 'entry-1',
  slug: 'openrouter',
  name: 'OpenRouter',
  dataNote: 'Requests are proxied through OpenRouter and may be logged by them for up to 30 days.',
  models: ['claude-sonnet-4-6', 'claude-haiku-4-5'],
};

const CATALOG_ENTRY_NO_NOTE = {
  entryId: 'entry-2',
  slug: 'vllm-internal',
  name: 'Internal vLLM',
  dataNote: null,
  models: ['claude-sonnet-4-6'],
};

const connectedWithCatalogStatus = {
  ...connectedStatus,
  catalog: [CATALOG_ENTRY, CATALOG_ENTRY_NO_NOTE],
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
    // The GET persists the pin, as the real route does — the post-PATCH refetch
    // is what the select ends up bound to.
    let stored: string | null = 'claude-sonnet-4-6';
    fetchWithAuth.mockImplementation((url: string, options?: RequestInit) => {
      const method = options?.method ?? 'GET';
      if (method === 'PATCH' && url === '/ai/provider') {
        stored = JSON.parse(String(options?.body)).defaultModel;
        return Promise.resolve(jsonRes({ defaultModel: stored, configVersion: 4 }));
      }
      if (method === 'GET' && url === '/ai/provider') {
        return Promise.resolve(jsonRes({ ...connectedStatus, defaultModel: stored }));
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    render(<PartnerAiProviderTab />);

    await waitFor(() => expect(screen.getByTestId('ai-provider-model-select')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('ai-provider-model-select'), { target: { value: 'claude-haiku-4-5' } });

    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/ai/provider', {
      method: 'PATCH',
      body: JSON.stringify({ defaultModel: 'claude-haiku-4-5' }),
    }));
    await waitFor(() => expect(
      (screen.getByTestId('ai-provider-model-select') as HTMLSelectElement).value,
    ).toBe('claude-haiku-4-5'));
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

  // Un-pinning changes the model the resolver ACTUALLY routes (stored pin ->
  // platform default), so the endpoint verification banner has to be recomputed
  // from the server's new effectiveDefaultModel. Merging only the optimistic
  // `defaultModel: null` leaves the pre-un-pin effectiveDefaultModel in state,
  // which suppresses the banner while every AI call 503s (#3922 W4 review).
  it('refetches status after un-pinning so the model-unverified banner reflects the new effective model', async () => {
    let unpinned = false;
    fetchWithAuth.mockImplementation((url: string, options?: RequestInit) => {
      const method = options?.method ?? 'GET';
      if (method === 'PATCH' && url === '/ai/provider') {
        unpinned = true;
        return Promise.resolve(jsonRes({ defaultModel: null, configVersion: 7 }));
      }
      if (method === 'GET' && url === '/ai/provider') {
        return Promise.resolve(jsonRes({
          ...connectedStatus,
          // Pinned to a verified model; un-pinning falls back to a platform
          // default that sits OUTSIDE the entry's verified set.
          defaultModel: unpinned ? null : 'claude-haiku-4-5',
          effectiveDefaultModel: unpinned ? 'claude-opus-4-8' : 'claude-haiku-4-5',
          catalogEntryId: 'entry-1',
          catalog: [CATALOG_ENTRY],
        }));
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    render(<PartnerAiProviderTab />);

    await waitFor(() => expect(screen.getByTestId('ai-provider-model-select')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-provider-endpoint-model-unverified-banner')).toBeNull();

    fireEvent.change(screen.getByTestId('ai-provider-model-select'), { target: { value: '' } });

    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/ai/provider', {
      method: 'PATCH',
      body: JSON.stringify({ defaultModel: null }),
    }));
    await waitFor(() => expect(screen.getByTestId('ai-provider-endpoint-model-unverified-banner')).toBeInTheDocument());
    expect(screen.getByTestId('ai-provider-endpoint-model-unverified-banner').textContent)
      .toContain('claude-opus-4-8');
    // Two GETs: the initial load plus the post-PATCH refetch.
    expect(fetchWithAuth.mock.calls.filter(([url, opts]) => url === '/ai/provider' && !opts)).toHaveLength(2);
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

  describe('endpoint selection (#3922 W4)', () => {
    it('hides the endpoint card when the catalog is empty', async () => {
      mockApi(connectedStatus);
      render(<PartnerAiProviderTab />);

      await waitFor(() => expect(screen.getByTestId('ai-provider-status-card')).toBeInTheDocument());
      expect(screen.queryByTestId('ai-provider-endpoint-card')).toBeNull();
    });

    it('renders a radio row per catalog entry plus the direct option', async () => {
      mockApi(connectedWithCatalogStatus);
      render(<PartnerAiProviderTab />);

      await waitFor(() => expect(screen.getByTestId('ai-provider-endpoint-card')).toBeInTheDocument());
      expect(screen.getByTestId('ai-provider-endpoint-direct-radio')).toBeInTheDocument();
      expect((screen.getByTestId('ai-provider-endpoint-direct-radio') as HTMLInputElement).checked).toBe(true);
      expect(screen.getByTestId('ai-provider-endpoint-radio-entry-1')).toBeInTheDocument();
      expect(screen.getByTestId('ai-provider-endpoint-radio-entry-2')).toBeInTheDocument();
      expect(screen.getByText('OpenRouter')).toBeInTheDocument();
      expect(screen.getByText(/claude-sonnet-4-6, claude-haiku-4-5/)).toBeInTheDocument();
    });

    it('selecting a non-direct entry with a data note opens a confirm dialog quoting it verbatim, gated by consent', async () => {
      mockApi(connectedWithCatalogStatus);
      render(<PartnerAiProviderTab />);

      await waitFor(() => expect(screen.getByTestId('ai-provider-endpoint-radio-entry-1')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('ai-provider-endpoint-radio-entry-1'));

      await waitFor(() => expect(screen.getByTestId('ai-provider-endpoint-confirm-dialog')).toBeInTheDocument());
      expect(screen.getByTestId('ai-provider-endpoint-confirm-dialog').textContent)
        .toContain(CATALOG_ENTRY.dataNote);
      // No request fired yet — nothing submits without the API call.
      expect(fetchWithAuth).not.toHaveBeenCalledWith('/ai/provider/endpoint', expect.anything());

      const confirmButton = screen.getByTestId('ai-provider-endpoint-confirm-submit') as HTMLButtonElement;
      expect(confirmButton.disabled).toBe(true);

      fireEvent.click(screen.getByTestId('ai-provider-endpoint-consent-checkbox'));
      expect(confirmButton.disabled).toBe(false);
    });

    it('submits the endpoint change with acknowledgeDataNote once consent is given', async () => {
      mockApi(connectedWithCatalogStatus, {
        'POST /ai/provider/endpoint': () => jsonRes({ catalogEntryId: 'entry-1', configVersion: 5 }),
      });
      render(<PartnerAiProviderTab />);

      await waitFor(() => expect(screen.getByTestId('ai-provider-endpoint-radio-entry-1')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('ai-provider-endpoint-radio-entry-1'));
      await waitFor(() => expect(screen.getByTestId('ai-provider-endpoint-consent-checkbox')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('ai-provider-endpoint-consent-checkbox'));
      fireEvent.click(screen.getByTestId('ai-provider-endpoint-confirm-submit'));

      await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/ai/provider/endpoint', {
        method: 'POST',
        body: JSON.stringify({ catalogEntryId: 'entry-1', acknowledgeDataNote: true }),
      }));
    });

    // Belt-and-braces: the confirm button is `disabled` while consent is
    // missing AND handleConfirmEntry re-checks it. This pins the outcome a user
    // can observe — a click with the box unchecked must send nothing — so
    // dropping either protection alone leaves the other holding the line, and
    // dropping both turns this red.
    it('sends no request when the confirm button is clicked without consent', async () => {
      mockApi(connectedWithCatalogStatus);
      render(<PartnerAiProviderTab />);

      await waitFor(() => expect(screen.getByTestId('ai-provider-endpoint-radio-entry-1')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('ai-provider-endpoint-radio-entry-1'));

      await waitFor(() => expect(screen.getByTestId('ai-provider-endpoint-consent-checkbox')).toBeInTheDocument());
      expect((screen.getByTestId('ai-provider-endpoint-consent-checkbox') as HTMLInputElement).checked).toBe(false);

      fireEvent.click(screen.getByTestId('ai-provider-endpoint-confirm-submit'));
      await Promise.resolve();

      expect(fetchWithAuth).not.toHaveBeenCalledWith('/ai/provider/endpoint', expect.anything());
      // mockApi throws on an unexpected request, which runAction would turn into
      // an error toast — a second, independent detector for a leaked POST.
      expect(showToast).not.toHaveBeenCalled();
      // The dialog is still waiting on consent, not dismissed.
      expect(screen.getByTestId('ai-provider-endpoint-confirm-dialog')).toBeInTheDocument();
    });

    // A 400 here is reachable in the wild: the catalog entry gained a data note
    // server-side after this page loaded, so the client submits
    // acknowledgeDataNote:false in good faith. The dialog must stay open with
    // the reason shown, not vanish leaving the old selection and no explanation.
    it('keeps the confirm dialog open and surfaces the API error when the endpoint switch is rejected', async () => {
      mockApi(connectedWithCatalogStatus, {
        'POST /ai/provider/endpoint': () => jsonRes(
          { error: 'You must acknowledge the data-handling note for this endpoint.' },
          400,
        ),
      });
      render(<PartnerAiProviderTab />);

      await waitFor(() => expect(screen.getByTestId('ai-provider-endpoint-radio-entry-2')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('ai-provider-endpoint-radio-entry-2'));
      await waitFor(() => expect(screen.getByTestId('ai-provider-endpoint-confirm-dialog')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('ai-provider-endpoint-confirm-submit'));

      await waitFor(() => expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          message: 'You must acknowledge the data-handling note for this endpoint.',
        }),
      ));
      expect(screen.getByTestId('ai-provider-endpoint-confirm-dialog')).toBeInTheDocument();
      // switchingEndpoint reset — the dialog is usable again, not stuck spinning.
      await waitFor(() => expect(
        (screen.getByTestId('ai-provider-endpoint-confirm-submit') as HTMLButtonElement).disabled,
      ).toBe(false));
      // The rejected switch changed nothing: still on Anthropic (direct).
      expect((screen.getByTestId('ai-provider-endpoint-direct-radio') as HTMLInputElement).checked).toBe(true);
    });

    it('selecting an entry with no data note needs no consent checkbox', async () => {
      mockApi(connectedWithCatalogStatus, {
        'POST /ai/provider/endpoint': () => jsonRes({ catalogEntryId: 'entry-2', configVersion: 5 }),
      });
      render(<PartnerAiProviderTab />);

      await waitFor(() => expect(screen.getByTestId('ai-provider-endpoint-radio-entry-2')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('ai-provider-endpoint-radio-entry-2'));

      await waitFor(() => expect(screen.getByTestId('ai-provider-endpoint-confirm-dialog')).toBeInTheDocument());
      expect(screen.queryByTestId('ai-provider-endpoint-consent-checkbox')).toBeNull();
      const confirmButton = screen.getByTestId('ai-provider-endpoint-confirm-submit') as HTMLButtonElement;
      expect(confirmButton.disabled).toBe(false);

      fireEvent.click(confirmButton);
      await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/ai/provider/endpoint', {
        method: 'POST',
        body: JSON.stringify({ catalogEntryId: 'entry-2', acknowledgeDataNote: false }),
      }));
    });

    it('selecting the direct option submits immediately with no dialog or consent', async () => {
      mockApi({ ...connectedWithCatalogStatus, catalogEntryId: 'entry-1' }, {
        'POST /ai/provider/endpoint': () => jsonRes({ catalogEntryId: null, configVersion: 6 }),
      });
      render(<PartnerAiProviderTab />);

      await waitFor(() => expect(screen.getByTestId('ai-provider-endpoint-direct-radio')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('ai-provider-endpoint-direct-radio'));

      await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/ai/provider/endpoint', {
        method: 'POST',
        body: JSON.stringify({ catalogEntryId: null, acknowledgeDataNote: false }),
      }));
      expect(screen.queryByTestId('ai-provider-endpoint-confirm-dialog')).toBeNull();
    });

    it('renders the delisted banner when the selected entry is no longer in the catalog', async () => {
      mockApi({
        ...connectedWithCatalogStatus,
        catalogEntryId: 'entry-gone',
      });
      render(<PartnerAiProviderTab />);

      await waitFor(() => expect(screen.getByTestId('ai-provider-endpoint-delisted-banner')).toBeInTheDocument());
      expect(screen.getByTestId('ai-provider-endpoint-delisted-banner').textContent)
        .toContain('This endpoint was delisted by Breeze — AI is paused until you choose another');
    });

    it('does not render the delisted banner while the selected entry is still listed', async () => {
      mockApi({ ...connectedWithCatalogStatus, catalogEntryId: 'entry-1' });
      render(<PartnerAiProviderTab />);

      await waitFor(() => expect(screen.getByTestId('ai-provider-endpoint-card')).toBeInTheDocument());
      expect(screen.queryByTestId('ai-provider-endpoint-delisted-banner')).toBeNull();
    });

    // The recovery path the API's `catalogEntryId: null` escape hatch exists
    // for: the pinned entry is delisted (or the catalog flag was switched off),
    // so `catalog` comes back EMPTY. Gating the card on catalog length alone
    // rendered a healthy "your key, verified" page with no banner and no
    // control able to send `catalogEntryId: null`, while the resolver 503s
    // every AI request and key rotation 409s — leaving DELETE (which destroys
    // the stored key) as the only way out.
    it('still renders the card, the delisted banner, and the direct radio when the catalog comes back empty', async () => {
      mockApi({ ...connectedStatus, catalogEntryId: 'entry-gone', catalog: [] });
      render(<PartnerAiProviderTab />);

      await waitFor(() => expect(screen.getByTestId('ai-provider-endpoint-card')).toBeInTheDocument());
      expect(screen.getByTestId('ai-provider-endpoint-delisted-banner')).toBeInTheDocument();
      expect(screen.getByTestId('ai-provider-endpoint-direct-radio')).toBeInTheDocument();
    });

    it('lets a partner with an empty catalog escape back to Anthropic (direct)', async () => {
      mockApi(
        { ...connectedStatus, catalogEntryId: 'entry-gone', catalog: [] },
        { 'POST /ai/provider/endpoint': () => jsonRes({ catalogEntryId: null, configVersion: 4 }) },
      );
      render(<PartnerAiProviderTab />);

      await waitFor(() => expect(screen.getByTestId('ai-provider-endpoint-direct-radio')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('ai-provider-endpoint-direct-radio'));

      await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/ai/provider/endpoint', {
        method: 'POST',
        body: JSON.stringify({ catalogEntryId: null, acknowledgeDataNote: false }),
      }));
    });

    it('hides the endpoint card entirely when the catalog is empty and nothing is pinned', async () => {
      mockApi({ ...connectedStatus, catalogEntryId: null, catalog: [] });
      render(<PartnerAiProviderTab />);

      await waitFor(() => expect(screen.getByTestId('partner-ai-provider-tab')).toBeInTheDocument());
      expect(screen.queryByTestId('ai-provider-endpoint-card')).toBeNull();
    });

    // The resolver evaluates `defaultModel ?? resolveDefaultModel()`, so a
    // partner who never pinned a model can still hit `model_unverified` when a
    // re-verification shrinks the entry's verified models. Comparing against
    // the stored (null) pin rendered no banner at all while AI 503'd.
    it('renders the model-unverified banner for an unpinned partner using the effective default model', async () => {
      mockApi({
        ...connectedStatus,
        defaultModel: null,
        effectiveDefaultModel: 'claude-opus-4-8',
        catalogEntryId: 'entry-1',
        catalog: [CATALOG_ENTRY],
      });
      render(<PartnerAiProviderTab />);

      await waitFor(() => expect(screen.getByTestId('ai-provider-endpoint-model-unverified-banner')).toBeInTheDocument());
      expect(screen.getByTestId('ai-provider-endpoint-model-unverified-banner').textContent)
        .toContain('claude-opus-4-8');
    });

    it('does not render the model-unverified banner when the effective default model is verified', async () => {
      mockApi({
        ...connectedStatus,
        defaultModel: null,
        effectiveDefaultModel: 'claude-sonnet-4-6',
        catalogEntryId: 'entry-1',
        catalog: [CATALOG_ENTRY],
      });
      render(<PartnerAiProviderTab />);

      await waitFor(() => expect(screen.getByTestId('ai-provider-endpoint-card')).toBeInTheDocument());
      expect(screen.queryByTestId('ai-provider-endpoint-model-unverified-banner')).toBeNull();
    });
  });
});
