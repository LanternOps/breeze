import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import ExtensionElementHost from './ExtensionElementHost';

const loadExtensionModule = vi.fn();
vi.mock('@/lib/extensions/registry', () => ({
  loadExtensionModule: (...a: unknown[]) => loadExtensionModule(...a),
}));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...a: unknown[]) => navigateTo(...a) }));

const showToast = vi.fn();
vi.mock('@/components/shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

const fetchWithAuth = vi.fn();
vi.mock('@/stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

const MODULE_URL = '/api/v1/extensions/assets/demo/abc123/index.js';

function defineElement(tag: string, captureContext?: (ctx: unknown) => void) {
  if (customElements.get(tag)) return;
  class TestElement extends HTMLElement {
    set context(value: unknown) {
      captureContext?.(value);
    }
  }
  customElements.define(tag, TestElement);
}

function dispatchHostEvent(target: Element, detail: unknown) {
  target.dispatchEvent(
    new CustomEvent('breeze-extension-event', { detail, bubbles: true, composed: true }),
  );
}

beforeEach(() => {
  loadExtensionModule.mockReset();
  navigateTo.mockReset();
  showToast.mockReset();
  fetchWithAuth.mockReset();
});

describe('ExtensionElementHost', () => {
  it('imports only the exact advertised module URL, mounts the declared element, and freezes its context', async () => {
    let captured: unknown;
    defineElement('ext-demo-widget-mount', (ctx) => { captured = ctx; });
    loadExtensionModule.mockResolvedValue({});

    render(
      <ExtensionElementHost
        extensionName="demo"
        moduleUrl={MODULE_URL}
        elementName="ext-demo-widget-mount"
        context={{ contractVersion: 1, extensionName: 'demo', path: '/dashboard', organizationId: 'org-1' }}
      />,
    );

    await waitFor(() => expect(loadExtensionModule).toHaveBeenCalledWith(MODULE_URL));
    expect(loadExtensionModule).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      const host = screen.getByTestId('extension-element-host');
      expect(host.querySelector('ext-demo-widget-mount')).not.toBeNull();
    });

    expect(captured).toEqual({
      contractVersion: 1,
      extensionName: 'demo',
      path: '/dashboard',
      organizationId: 'org-1',
    });
    expect(Object.isFrozen(captured)).toBe(true);
  });

  describe('host API (#11922: extension requests must carry the session)', () => {
    type Captured = { order: string[]; hostApi?: unknown };

    function defineRecordingElement(tag: string, captured: Captured) {
      if (customElements.get(tag)) return;
      class RecordingElement extends HTMLElement {
        set hostApi(value: unknown) {
          captured.order.push('hostApi');
          captured.hostApi = value;
        }
        set context(_value: unknown) {
          captured.order.push('context');
        }
      }
      customElements.define(tag, RecordingElement);
    }

    async function mountWithHostApi(tag: string, extensionName = 'demo') {
      const captured: Captured = { order: [] };
      defineRecordingElement(tag, captured);
      loadExtensionModule.mockResolvedValue({});
      render(
        <ExtensionElementHost
          extensionName={extensionName}
          moduleUrl={MODULE_URL}
          elementName={tag}
          context={{ contractVersion: 1, extensionName, path: '/dashboard', organizationId: 'org-1' }}
        />,
      );
      await waitFor(() => expect(captured.order).toContain('context'));
      return captured;
    }

    it('assigns a frozen host API scoped to the extension BEFORE context', async () => {
      const captured = await mountWithHostApi('ext-demo-hostapi-order');
      // Elements start fetching from their context setter, so the capability must already be there.
      expect(captured.order).toEqual(['hostApi', 'context']);
      const hostApi = captured.hostApi as { contractVersion: number; extensionName: string; apiBase: string };
      expect(Object.isFrozen(hostApi)).toBe(true);
      expect(hostApi.contractVersion).toBe(1);
      expect(hostApi.extensionName).toBe('demo');
      expect(hostApi.apiBase).toBe('/api/v1/ext/demo/');
    });

    it('sends an in-namespace request through the authenticated app fetch', async () => {
      const captured = await mountWithHostApi('ext-demo-hostapi-fetch');
      fetchWithAuth.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
      const hostApi = captured.hostApi as { fetch: (p: string, i?: RequestInit) => Promise<Response> };

      const response = await hostApi.fetch('/api/v1/ext/demo/items?orgId=org-1', {
        method: 'POST',
        body: '{}',
        headers: { authorization: 'Bearer forged' },
      });

      expect(response.status).toBe(200);
      expect(fetchWithAuth).toHaveBeenCalledTimes(1);
      const [path, init] = fetchWithAuth.mock.calls[0]!;
      expect(path).toBe('/api/v1/ext/demo/items?orgId=org-1');
      expect(init.method).toBe('POST');
      expect(init.body).toBe('{}');
      // The host's fetchWithAuth owns the Authorization header; a forged one never survives.
      expect((init.headers as Headers).has('authorization')).toBe(false);
    });

    it('refuses another extension\'s namespace, core API routes and absolute URLs without sending anything', async () => {
      const captured = await mountWithHostApi('ext-demo-hostapi-refuse');
      const hostApi = captured.hostApi as { fetch: (p: string) => Promise<Response> };

      for (const path of [
        '/api/v1/ext/other/items',
        '/api/v1/devices',
        'https://evil.example/api/v1/ext/demo/items',
        '//evil.example/api/v1/ext/demo/items',
        '/api/v1/ext/demo/../../devices',
      ]) {
        await expect(hostApi.fetch(path), path).rejects.toThrow(/refused/);
      }
      expect(fetchWithAuth).not.toHaveBeenCalled();
    });
  });

  it('renders the unavailable state when the declared element never registers', async () => {
    loadExtensionModule.mockResolvedValue({}); // resolves, but the module never calls customElements.define
    render(
      <ExtensionElementHost
        extensionName="demo"
        moduleUrl={MODULE_URL}
        elementName="ext-demo-widget-never-registered"
        context={{}}
      />,
    );
    expect(await screen.findByTestId('extension-element-unavailable')).toBeInTheDocument();
  });

  it('renders the unavailable state on a rejected module promise', async () => {
    loadExtensionModule.mockRejectedValue(new Error('network error'));
    render(
      <ExtensionElementHost
        extensionName="demo"
        moduleUrl={MODULE_URL}
        elementName="ext-demo-widget-rejected"
        context={{}}
      />,
    );
    const fallback = await screen.findByTestId('extension-element-unavailable');
    expect(fallback).toBeInTheDocument();
    // No stack trace / raw error message ever reaches the DOM.
    expect(fallback.textContent).not.toMatch(/network error/i);
  });

  it('renders the unavailable state on an invalid/mismatched element name (module registers a different tag)', async () => {
    defineElement('ext-demo-actual-registered-tag');
    loadExtensionModule.mockResolvedValue({});
    render(
      <ExtensionElementHost
        extensionName="demo"
        moduleUrl={MODULE_URL}
        elementName="ext-demo-declared-but-different-tag"
        context={{}}
      />,
    );
    const fallback = await screen.findByTestId('extension-element-unavailable');
    expect(fallback.textContent).toContain('ext-demo-declared-but-different-tag');
  });

  it('routes a valid in-namespace navigate event to navigateTo', async () => {
    defineElement('ext-demo-widget-navigate');
    loadExtensionModule.mockResolvedValue({});
    render(
      <ExtensionElementHost
        extensionName="demo"
        moduleUrl={MODULE_URL}
        elementName="ext-demo-widget-navigate"
        context={{}}
      />,
    );
    const host = await screen.findByTestId('extension-element-host');
    const el = host.querySelector('ext-demo-widget-navigate')!;

    act(() => {
      dispatchHostEvent(el, { version: 1, type: 'navigate', path: '/extensions/demo/sub' });
    });

    expect(navigateTo).toHaveBeenCalledWith('/extensions/demo/sub');
  });

  it('routes a valid toast event to showToast', async () => {
    defineElement('ext-demo-widget-toast');
    loadExtensionModule.mockResolvedValue({});
    render(
      <ExtensionElementHost
        extensionName="demo"
        moduleUrl={MODULE_URL}
        elementName="ext-demo-widget-toast"
        context={{}}
      />,
    );
    const host = await screen.findByTestId('extension-element-host');
    const el = host.querySelector('ext-demo-widget-toast')!;

    act(() => {
      dispatchHostEvent(el, { version: 1, type: 'toast', tone: 'success', message: 'Saved' });
    });

    expect(showToast).toHaveBeenCalledWith({ message: 'Saved', type: 'success' });
  });

  it('rejects (swallows, does not route) a malformed event', async () => {
    defineElement('ext-demo-widget-malformed');
    loadExtensionModule.mockResolvedValue({});
    render(
      <ExtensionElementHost
        extensionName="demo"
        moduleUrl={MODULE_URL}
        elementName="ext-demo-widget-malformed"
        context={{}}
      />,
    );
    const host = await screen.findByTestId('extension-element-host');
    const el = host.querySelector('ext-demo-widget-malformed')!;

    act(() => {
      dispatchHostEvent(el, { version: 1, type: 'navigate' }); // missing required `path`
    });

    expect(navigateTo).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('rejects (swallows, does not route) an out-of-namespace navigate event', async () => {
    defineElement('ext-demo-widget-out-of-namespace');
    loadExtensionModule.mockResolvedValue({});
    render(
      <ExtensionElementHost
        extensionName="demo"
        moduleUrl={MODULE_URL}
        elementName="ext-demo-widget-out-of-namespace"
        context={{}}
      />,
    );
    const host = await screen.findByTestId('extension-element-host');
    const el = host.querySelector('ext-demo-widget-out-of-namespace')!;

    act(() => {
      dispatchHostEvent(el, { version: 1, type: 'navigate', path: '/extensions/someone-else/x' });
    });

    expect(navigateTo).not.toHaveBeenCalled();
  });

  it('error boundary attributes an unexpected render failure by extension + element, without a stack trace', async () => {
    // Force an unexpected synchronous throw from the imperative mount path
    // (distinct from the anticipated "never registered" / "rejected"
    // failure modes already covered above) by having the element's context
    // setter itself throw.
    const tag = 'ext-demo-widget-throws';
    if (!customElements.get(tag)) {
      class ThrowingElement extends HTMLElement {
        set context(_value: unknown) {
          throw new Error('boom: unexpected extension element failure');
        }
      }
      customElements.define(tag, ThrowingElement);
    }
    loadExtensionModule.mockResolvedValue({});

    render(
      <ExtensionElementHost
        extensionName="demo"
        moduleUrl={MODULE_URL}
        elementName={tag}
        context={{}}
      />,
    );

    const fallback = await screen.findByTestId('extension-element-unavailable');
    expect(fallback.textContent).toContain('demo');
    expect(fallback.textContent).toContain(tag);
    expect(fallback.textContent).not.toMatch(/boom/i);
  });
});
