import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

// Deliberately NOT mocking runAction: these tests exercise the real
// no-silent-mutations wrapper so failure toasts carry the API's `error` text.
import LlmProviderCatalog from './LlmProviderCatalog';

function jsonRes(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const draftEntry = {
  entryId: 'entry-1',
  slug: 'openrouter',
  name: 'OpenRouter',
  status: 'draft',
  activeRevisionId: null,
  notes: null,
  createdAt: '2026-08-01T00:00:00Z',
  revisions: [
    {
      revisionId: 'rev-1',
      revision: 1,
      baseUrl: 'https://openrouter.ai/api/anthropic',
      authMode: 'x-api-key',
      modelMap: {
        'claude-sonnet-4-6': {
          providerModel: 'anthropic/claude-sonnet-4-6',
          inputCentsPerM: 300,
          outputCentsPerM: 1500,
          cacheReadCentsPerM: 30,
          cacheWriteCentsPerM: 375,
        },
      },
      dataNote: null,
      createdAt: '2026-08-01T00:00:00Z',
      verifiedModels: [],
      verifications: [],
    },
  ],
};

/** Route the mock fetch by method+url; GET / falls through to `initial`. */
function mockApi(initial: unknown, handlers: Record<string, () => Response> = {}) {
  fetchWithAuth.mockImplementation((url: string, options?: RequestInit) => {
    const method = options?.method ?? 'GET';
    const handler = handlers[`${method} ${url}`];
    if (handler) return Promise.resolve(handler());
    if (method === 'GET' && url === '/admin/llm-provider-catalog') return Promise.resolve(jsonRes(initial));
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  showToast.mockReset();
});

describe('LlmProviderCatalog', () => {
  it('shows a platform-admin-required panel on a 403', async () => {
    mockApi(null);
    fetchWithAuth.mockResolvedValue(jsonRes({ error: 'platform admin access required' }, 403));
    render(<LlmProviderCatalog />);
    await screen.findByTestId('llm-catalog-requires-platform-admin');
  });

  it('renders catalog entries with slug, name, and status', async () => {
    mockApi([draftEntry]);
    render(<LlmProviderCatalog />);
    await screen.findByText('OpenRouter');
    expect(screen.getByText('openrouter')).toBeTruthy();
    expect(screen.getByTestId('llm-catalog-row-entry-1-status').textContent).toBe('Draft');
    expect(screen.getByTestId('llm-catalog-total').textContent).toBe('1');
  });

  it('shows empty state when no entries returned', async () => {
    mockApi([]);
    render(<LlmProviderCatalog />);
    await screen.findByTestId('llm-catalog-empty');
  });

  it('creates a new catalog entry via runAction and refetches', async () => {
    mockApi([], {
      'POST /admin/llm-provider-catalog': () => jsonRes({ id: 'entry-2' }, 201),
    });
    render(<LlmProviderCatalog />);
    await screen.findByTestId('llm-catalog-empty');

    fireEvent.click(screen.getByTestId('llm-catalog-add-entry'));
    fireEvent.change(screen.getByTestId('llm-catalog-entry-slug'), { target: { value: 'litellm' } });
    fireEvent.change(screen.getByTestId('llm-catalog-entry-name'), { target: { value: 'LiteLLM' } });

    mockApi([{ ...draftEntry, entryId: 'entry-2', slug: 'litellm', name: 'LiteLLM', revisions: [] }], {
      'POST /admin/llm-provider-catalog': () => jsonRes({ id: 'entry-2' }, 201),
    });

    fireEvent.click(screen.getByTestId('llm-catalog-entry-submit'));

    await screen.findByText('LiteLLM');
    const call = fetchWithAuth.mock.calls.find(([url, opts]) => url === '/admin/llm-provider-catalog' && (opts as RequestInit)?.method === 'POST');
    expect(call).toBeTruthy();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body).toEqual({ slug: 'litellm', name: 'LiteLLM', notes: undefined });
  });

  it('toasts the API error message when entry creation fails', async () => {
    mockApi([], {
      'POST /admin/llm-provider-catalog': () => jsonRes({ error: 'Unsupported catalog model ids: foo' }, 400),
    });
    render(<LlmProviderCatalog />);
    await screen.findByTestId('llm-catalog-empty');

    fireEvent.click(screen.getByTestId('llm-catalog-add-entry'));
    fireEvent.change(screen.getByTestId('llm-catalog-entry-slug'), { target: { value: 'x' } });
    fireEvent.change(screen.getByTestId('llm-catalog-entry-name'), { target: { value: 'X' } });
    fireEvent.click(screen.getByTestId('llm-catalog-entry-submit'));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
        type: 'error',
        message: 'Unsupported catalog model ids: foo',
      }));
    });
  });

  it('expands a row to show its revisions and disables activate until every mapped model is verified', async () => {
    mockApi([draftEntry]);
    render(<LlmProviderCatalog />);
    await screen.findByText('OpenRouter');

    fireEvent.click(screen.getByTestId('llm-catalog-row-entry-1-toggle'));

    await screen.findByTestId('llm-catalog-revision-rev-1');
    const activateBtn = screen.getByTestId('llm-catalog-revision-rev-1-activate') as HTMLButtonElement;
    expect(activateBtn.disabled).toBe(true);
  });

  it('enables activate once the mapped model shows a passing verification', async () => {
    const verifiedEntry = {
      ...draftEntry,
      revisions: [{
        ...draftEntry.revisions[0],
        verifiedModels: ['claude-sonnet-4-6'],
      }],
    };
    mockApi([verifiedEntry]);
    render(<LlmProviderCatalog />);
    await screen.findByText('OpenRouter');
    fireEvent.click(screen.getByTestId('llm-catalog-row-entry-1-toggle'));

    await screen.findByTestId('llm-catalog-revision-rev-1');
    const activateBtn = screen.getByTestId('llm-catalog-revision-rev-1-activate') as HTMLButtonElement;
    expect(activateBtn.disabled).toBe(false);
  });

  it('runs a verification with a transient key and clears it afterward', async () => {
    mockApi([draftEntry], {
      'POST /admin/llm-provider-catalog/revisions/rev-1/verify': () => jsonRes({ passed: true, steps: [], harnessVersion: 'v1' }),
    });
    render(<LlmProviderCatalog />);
    await screen.findByText('OpenRouter');
    fireEvent.click(screen.getByTestId('llm-catalog-row-entry-1-toggle'));
    await screen.findByTestId('llm-catalog-revision-rev-1');

    fireEvent.click(screen.getByTestId('llm-catalog-revision-rev-1-claude-sonnet-4-6-verify'));
    expect(screen.getByTestId('llm-catalog-verify-modal')).toBeTruthy();

    const keyInput = screen.getByTestId('llm-catalog-verify-apikey') as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: 'sk-transient-test-key' } });
    fireEvent.click(screen.getByTestId('llm-catalog-verify-submit'));

    await screen.findByTestId('llm-catalog-verify-result');
    expect(screen.getByTestId('llm-catalog-verify-result').textContent).toBe('Passed');
    // The key must never linger in the input once the request completes.
    expect((screen.getByTestId('llm-catalog-verify-apikey') as HTMLInputElement).value).toBe('');

    const call = fetchWithAuth.mock.calls.find(([url]) => url === '/admin/llm-provider-catalog/revisions/rev-1/verify');
    expect(call).toBeTruthy();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body).toEqual({ modelId: 'claude-sonnet-4-6', apiKey: 'sk-transient-test-key' });
  });

  it('renders each diagnostic step and its message, not just the verdict pill', async () => {
    mockApi([draftEntry], {
      'POST /admin/llm-provider-catalog/revisions/rev-1/verify': () => jsonRes({
        passed: false,
        steps: [
          { name: 'DNS resolution', ok: true },
          { name: 'HTTP request', ok: false, detail: 'HTTP 405 Method Not Allowed' },
        ],
        harnessVersion: 'v1',
      }),
    });
    render(<LlmProviderCatalog />);
    await screen.findByText('OpenRouter');
    fireEvent.click(screen.getByTestId('llm-catalog-row-entry-1-toggle'));
    await screen.findByTestId('llm-catalog-revision-rev-1');

    fireEvent.click(screen.getByTestId('llm-catalog-revision-rev-1-claude-sonnet-4-6-verify'));
    const keyInput = screen.getByTestId('llm-catalog-verify-apikey') as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: 'sk-transient-test-key' } });
    fireEvent.click(screen.getByTestId('llm-catalog-verify-submit'));

    await screen.findByTestId('llm-catalog-verify-result');
    expect(screen.getByText('HTTP 405 Method Not Allowed')).toBeTruthy();
    expect(screen.getByText('DNS resolution')).toBeTruthy();
    expect(screen.getByText('HTTP request')).toBeTruthy();
  });

  describe('the List button mirrors the activation gate', () => {
    // The API re-runs assertAllModelsVerified on a `listed` transition, so an
    // enabled List button on a half-verified active revision is a button whose
    // only outcome is a 409 toast. It has to read the SAME allVerified rule the
    // Activate button does, not merely "an active revision exists".
    const withActiveRevision = (verifiedModels: string[]) => ({
      ...draftEntry,
      activeRevisionId: 'rev-1',
      revisions: [{ ...draftEntry.revisions[0], verifiedModels }],
    });

    it('disables List when the entry has no active revision at all', async () => {
      mockApi([draftEntry]);
      render(<LlmProviderCatalog />);
      await screen.findByText('OpenRouter');

      const listBtn = screen.getByTestId('llm-catalog-row-entry-1-list') as HTMLButtonElement;
      expect(listBtn.disabled).toBe(true);
    });

    it('disables List when the active revision has an unverified mapped model', async () => {
      mockApi([withActiveRevision([])]);
      render(<LlmProviderCatalog />);
      await screen.findByText('OpenRouter');

      const listBtn = screen.getByTestId('llm-catalog-row-entry-1-list') as HTMLButtonElement;
      expect(listBtn.disabled).toBe(true);
      // A disabled control with no explanation is the failure mode this
      // replaces — the operator has to be told to go verify the revision.
      expect(listBtn.title).toBe(
        'Every mapped model on the active revision needs a passing verification before this provider can be listed.',
      );
    });

    it('enables List once every model on the active revision is verified', async () => {
      mockApi([withActiveRevision(['claude-sonnet-4-6'])]);
      render(<LlmProviderCatalog />);
      await screen.findByText('OpenRouter');

      const listBtn = screen.getByTestId('llm-catalog-row-entry-1-list') as HTMLButtonElement;
      expect(listBtn.disabled).toBe(false);
      expect(listBtn.title).toBe('');
    });
  });

  it('sets status to delisted via runAction after confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockApi([draftEntry], {
      'PATCH /admin/llm-provider-catalog/entry-1/status': () => jsonRes({ success: true }),
    });
    render(<LlmProviderCatalog />);
    await screen.findByText('OpenRouter');

    mockApi([{ ...draftEntry, status: 'delisted' }], {
      'PATCH /admin/llm-provider-catalog/entry-1/status': () => jsonRes({ success: true }),
    });
    fireEvent.click(screen.getByTestId('llm-catalog-row-entry-1-delist'));

    await waitFor(() => {
      expect(screen.getByTestId('llm-catalog-row-entry-1-status').textContent).toBe('Delisted');
    });
    confirmSpy.mockRestore();
  });
});
