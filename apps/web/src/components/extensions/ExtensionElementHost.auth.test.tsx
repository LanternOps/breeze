// #11922 end-to-end on the client: the host API handed to an extension
// element must reach the network through the REAL fetchWithAuth, carrying the
// session's Bearer token — not a forged one from the extension, and never a
// bare unauthenticated fetch. ExtensionElementHost.test.tsx mocks
// fetchWithAuth; this file deliberately does not.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import ExtensionElementHost from './ExtensionElementHost';
import { useAuthStore, type Tokens, type User } from '@/stores/auth';

const loadExtensionModule = vi.fn();
vi.mock('@/lib/extensions/registry', () => ({
  loadExtensionModule: (...a: unknown[]) => loadExtensionModule(...a),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}));
vi.mock('@/lib/appearance', () => ({
  applyAppearancePreferences: vi.fn(),
  applyResolvedLocalePreferences: vi.fn(),
}));

const user: User = { id: 'user-1', email: 'admin@example.com', name: 'Admin', mfaEnabled: false };
const tokens: Tokens = { accessToken: 'session-access-token', expiresInSeconds: 3600 };

type HostApi = { fetch: (path: string, init?: RequestInit) => Promise<Response> };

describe('ExtensionElementHost host API over the real fetchWithAuth', () => {
  let networkFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useAuthStore.getState().login(user, tokens);
    networkFetch = vi.fn(async () => new Response('{"sources":[]}', { status: 200 }));
    vi.stubGlobal('fetch', networkFetch);
    loadExtensionModule.mockResolvedValue({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the extension request with the session Bearer token, replacing a forged one', async () => {
    const tag = 'ext-demo-auth-roundtrip';
    let hostApi: HostApi | undefined;
    if (!customElements.get(tag)) {
      customElements.define(tag, class extends HTMLElement {
        set hostApi(value: unknown) { hostApi = value as HostApi; }
        set context(_value: unknown) { /* not needed */ }
      });
    }

    render(
      <ExtensionElementHost
        extensionName="demo"
        moduleUrl="/api/v1/extensions/assets/demo/abc123/index.js"
        elementName={tag}
        context={{ contractVersion: 1, extensionName: 'demo', path: '/x', organizationId: 'org-1' }}
      />,
    );
    await waitFor(() => expect(hostApi).toBeDefined());

    const response = await hostApi!.fetch('/api/v1/ext/demo/sources?orgId=org-1', {
      headers: { authorization: 'Bearer forged-by-extension' },
    });

    expect(response.status).toBe(200);
    expect(networkFetch).toHaveBeenCalledTimes(1);
    const [url, init] = networkFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/v1\/ext\/demo\/sources\?orgId=org-1$/);
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer session-access-token');
    expect(init.credentials).toBe('include');
  });
});
