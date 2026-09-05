import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

import ScriptEditPage from './ScriptEditPage';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';

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

vi.mock('./ScriptForm', () => ({
  default: () => <div>script form</div>
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
