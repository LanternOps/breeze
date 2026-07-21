import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import {
  useExtensionNavigation,
  extensionNavLinksFromRegistry,
} from './useExtensionNavigation';
import type { RuntimeWebRegistry, RuntimeWebExtension } from '@/lib/extensions/registry';

const getExtensionRegistry = vi.fn();
vi.mock('@/lib/extensions/registry', () => ({
  getExtensionRegistry: (...a: unknown[]) => getExtensionRegistry(...a),
}));

function extension(over: Partial<RuntimeWebExtension> = {}): RuntimeWebExtension {
  return {
    name: 'demo',
    version: '1.0.0',
    digest: 'abc123',
    moduleUrl: '/api/v1/extensions/assets/demo/abc123/index.js',
    pages: [],
    navigation: [],
    slots: [],
    ...over,
  };
}

function registry(extensions: RuntimeWebExtension[]): RuntimeWebRegistry {
  return { apiVersion: 'breeze.extensions.web/v1', revision: 'rev-1', extensions };
}

beforeEach(() => {
  getExtensionRegistry.mockReset();
});

describe('extensionNavLinksFromRegistry (pure projection)', () => {
  it('builds a namespaced href from the extension name and nav item path', () => {
    const links = extensionNavLinksFromRegistry(
      registry([
        extension({
          name: 'demo',
          navigation: [{ id: 'main', label: 'Demo Dashboard', path: '/dashboard', order: undefined }],
        }),
      ]),
    );
    expect(links).toEqual([{ name: 'Demo Dashboard', href: '/extensions/demo/dashboard' }]);
  });

  it('orders by order -> extension name -> contribution id', () => {
    const links = extensionNavLinksFromRegistry(
      registry([
        extension({
          name: 'zeta',
          navigation: [
            { id: 'b', label: 'Zeta B', path: '/b', order: 1 },
            { id: 'a', label: 'Zeta A', path: '/a', order: 1 },
          ],
        }),
        extension({
          name: 'alpha',
          navigation: [
            { id: undefined, label: 'Alpha Unordered', path: '/x', order: undefined },
            { id: 'first', label: 'Alpha First', path: '/first', order: 0 },
          ],
        }),
      ]),
    );
    // order 0 first (Alpha First), then order 1 tie-broken by extension name
    // (alpha < zeta is irrelevant here, both order-1 items are on zeta, so
    // tie-broken by contribution id 'a' < 'b'), then undefined-order items last.
    expect(links.map((l) => l.name)).toEqual(['Alpha First', 'Zeta A', 'Zeta B', 'Alpha Unordered']);
  });

  it('drops a disabled extension entirely (registry omits it — enabled-only by construction)', () => {
    const links = extensionNavLinksFromRegistry(registry([]));
    expect(links).toEqual([]);
  });

  it('SECURITY: rejects a nav item whose constructed href would not stay under /extensions/<name>/', () => {
    // absoluteWebPath already forbids '..' server-side, but this hook must
    // not trust that — re-derive and re-validate independently.
    const links = extensionNavLinksFromRegistry(
      registry([
        extension({
          name: 'demo',
          navigation: [{ id: 'evil', label: 'Escape', path: '/../../settings/users', order: undefined }],
        }),
      ]),
    );
    expect(links).toEqual([]);
  });

  it('SECURITY: rejects a well-formed-looking path that would smuggle a different extension namespace', () => {
    const links = extensionNavLinksFromRegistry(
      registry([
        extension({
          name: 'demo',
          navigation: [{ id: 'x', label: 'X', path: '/../other/page', order: undefined }],
        }),
      ]),
    );
    expect(links).toEqual([]);
  });
});

describe('useExtensionNavigation', () => {
  it('returns the enabled navigation links once the registry resolves', async () => {
    getExtensionRegistry.mockResolvedValue(
      registry([
        extension({ name: 'demo', navigation: [{ id: 'main', label: 'Demo', path: '/dashboard', order: undefined }] }),
      ]),
    );

    const { result } = renderHook(() => useExtensionNavigation());
    expect(result.current).toEqual([]);

    await waitFor(() =>
      expect(result.current).toEqual([{ name: 'Demo', href: '/extensions/demo/dashboard' }]),
    );
  });

  it('never throws to the caller: a registry fetch failure resolves to an empty list', async () => {
    getExtensionRegistry.mockRejectedValue(new Error('extension registry request failed with status 401'));

    const { result } = renderHook(() => useExtensionNavigation());

    await waitFor(() => expect(getExtensionRegistry).toHaveBeenCalled());
    expect(result.current).toEqual([]);
  });

  it('returns no links when no extension contributes navigation', async () => {
    getExtensionRegistry.mockResolvedValue(registry([extension({ name: 'demo', navigation: [] })]));

    const { result } = renderHook(() => useExtensionNavigation());
    await waitFor(() => expect(getExtensionRegistry).toHaveBeenCalled());
    expect(result.current).toEqual([]);
  });
});
