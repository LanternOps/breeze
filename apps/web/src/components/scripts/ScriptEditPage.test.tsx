import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

import ScriptEditPage from './ScriptEditPage';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { useScriptAiStore } from '@/stores/scriptAiStore';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

vi.mock('../../stores/orgStore', () => ({
  useOrgStore: Object.assign(() => ({ organizations: [] }), {
    getState: () => ({ organizations: [] })
  })
}));

vi.mock('@/lib/authScope', () => ({
  getJwtClaims: () => ({ scope: 'organization' })
}));

const scriptFormPropsSpy = vi.fn();
vi.mock('./ScriptForm', () => ({
  default: (props: unknown) => {
    scriptFormPropsSpy(props);
    return <div>script form</div>;
  }
}));

const showToastMock = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToastMock(a) }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const navigateToMock = vi.mocked(navigateTo);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

const baseScript = {
  id: 'script-1',
  name: 'Cleanup Temp Files',
  description: '',
  category: 'maintenance',
  language: 'bash',
  osTypes: ['linux'],
  content: 'echo hi',
  parameters: [],
  timeoutSeconds: 300,
  runAs: 'system',
  orgId: 'org-1',
  partnerId: null,
  isSystem: false
};

describe('ScriptEditPage duplicate action (#4887)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a Duplicate button in the header for an existing script', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/scripts/script-1') return makeJsonResponse(baseScript);
      return makeJsonResponse({}, false, 404);
    });

    render(<ScriptEditPage scriptId="script-1" />);

    expect(await screen.findByRole('button', { name: /duplicate/i })).toBeInTheDocument();
  });

  it('does not show a Duplicate button for a never-saved (new) script', () => {
    render(<ScriptEditPage />);

    expect(screen.queryByRole('button', { name: /duplicate/i })).not.toBeInTheDocument();
  });

  it('clones the script and navigates to the new script on success', async () => {
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/scripts/script-1' && !init?.method) return makeJsonResponse(baseScript);
      if (url === '/scripts/script-1/clone' && init?.method === 'POST') {
        return makeJsonResponse({ id: 'script-2', name: 'Cleanup Temp Files (copy)' }, true, 201);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<ScriptEditPage scriptId="script-1" />);

    fireEvent.click(await screen.findByRole('button', { name: /duplicate/i }));

    await waitFor(() => expect(navigateToMock).toHaveBeenCalledWith('/scripts/script-2'));
  });

  it('does not navigate, and shows an error toast, when the clone request fails', async () => {
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/scripts/script-1' && !init?.method) return makeJsonResponse(baseScript);
      if (url === '/scripts/script-1/clone' && init?.method === 'POST') {
        return makeJsonResponse({ error: 'Script not found' }, false, 404);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<ScriptEditPage scriptId="script-1" />);

    fireEvent.click(await screen.findByRole('button', { name: /duplicate/i }));

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  it('shows an error toast (never a silent no-op) if a 2xx clone response is missing an id', async () => {
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/scripts/script-1' && !init?.method) return makeJsonResponse(baseScript);
      if (url === '/scripts/script-1/clone' && init?.method === 'POST') {
        return makeJsonResponse({}, true, 201);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<ScriptEditPage scriptId="script-1" />);

    fireEvent.click(await screen.findByRole('button', { name: /duplicate/i }));

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(navigateToMock).not.toHaveBeenCalled();
  });
});

describe('ScriptEditPage form seeding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to the Custom category when the saved script has none (loose-file imports)', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/scripts/script-1') return makeJsonResponse({ ...baseScript, category: null });
      return makeJsonResponse({}, false, 404);
    });

    render(<ScriptEditPage scriptId="script-1" />);

    await waitFor(() => {
      const calls = scriptFormPropsSpy.mock.calls as Array<[{ defaultValues?: { category?: unknown } }]>;
      expect(calls.some(([p]) => p.defaultValues?.category === 'Custom')).toBe(true);
    });
    expect(
      (scriptFormPropsSpy.mock.calls as Array<[{ defaultValues?: { category?: unknown } }]>).some(
        ([p]) => p.defaultValues?.category === null
      )
    ).toBe(false);
  });
});

describe('ScriptEditPage header (#7151)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stacks the title/back-link and action buttons below md, and keeps the back link from squashing', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/scripts/script-1') return makeJsonResponse(baseScript);
      return makeJsonResponse({}, false, 404);
    });

    render(<ScriptEditPage scriptId="script-1" />);

    const duplicateButton = await screen.findByRole('button', { name: /duplicate/i });
    const headerRow = duplicateButton.closest('[class*="flex-col"]');
    expect(headerRow).not.toBeNull();
    expect(headerRow?.className).toMatch(/md:flex-row/);

    const actionsContainer = duplicateButton.closest('[class*="flex-wrap"]');
    expect(actionsContainer).not.toBeNull();

    // The h-10 w-10 back-link pill must not squash when the row wraps.
    const backLink = screen
      .getAllByRole('link')
      .find((el) => el.getAttribute('href') === '/scripts' && el.className.includes('h-10'));
    expect(backLink?.className).toContain('shrink-0');
  });
});

describe('ScriptEditPage back link (#7158 a11y)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gives the icon-only back-to-scripts link an accessible name', () => {
    render(<ScriptEditPage />);

    expect(screen.getByRole('link', { name: 'Back to Scripts' })).toHaveAttribute('href', '/scripts');
  });
});

describe('ScriptEditPage draft hand-off (AI Suggested Fixes W2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    useScriptAiStore.setState({ panelOpen: false, draftInput: null });
  });

  it('a new script opened from a draft hand-off defaults name/language, opens the AI panel and pre-fills (not sends) the brief', async () => {
    const sendMessageSpy = vi.fn();
    useScriptAiStore.setState({ sendMessage: sendMessageSpy });
    sessionStorage.setItem('breeze.scriptDraftHandoff', JSON.stringify({ brief: 'Clear queue', language: 'powershell', title: 'Clear print queue', suggestionId: 's-1' }));
    render(<ScriptEditPage />);
    await waitFor(() => expect(useScriptAiStore.getState().panelOpen).toBe(true));
    expect(useScriptAiStore.getState().draftInput).toBe('Write a PowerShell script for this fix: Clear queue');
    expect(scriptFormPropsSpy).toHaveBeenCalledWith(expect.objectContaining({
      defaultValues: expect.objectContaining({ name: 'Clear print queue', language: 'powershell', osTypes: ['windows'] }),
    }));
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('breeze.scriptDraftHandoff')).toBeNull();
  });

  it('an existing script never consumes a hand-off', async () => {
    sessionStorage.setItem('breeze.scriptDraftHandoff', JSON.stringify({ brief: 'x', language: 'bash', title: 't', suggestionId: 's' }));
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse(baseScript));
    render(<ScriptEditPage scriptId="script-1" />);
    await screen.findByText('script form');
    expect(useScriptAiStore.getState().panelOpen).toBe(false);
    expect(sessionStorage.getItem('breeze.scriptDraftHandoff')).not.toBeNull();
  });
});
