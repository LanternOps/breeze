// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import sanitizeFixture from '../../../../packages/shared/src/fixtures/prompt-catalog/identity-name-sanitize.json';
import {
  identityDisplayName,
  identityFromWire,
  logoObjectUrl,
  usePromptIdentity,
  type PromptIdentityApi,
  type PromptIdentityNotice,
  type PromptIdentityWire,
} from './identity';

// The 1x1 PNG from packages/shared/src/fixtures/prompt-host/branding_sync.set.json.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQj18LAAHMASx1OSTTAAAAAElFTkSuQmCC';
const SHA_A = 'c96253573225f1fa2044af43896a96056903b359eed7af9fad90bd626127ba99';
const SHA_B = 'a'.repeat(64);

const set = (over: Partial<PromptIdentityWire> = {}): PromptIdentityWire => ({
  version: 1,
  state: 'set',
  partnerName: 'Example IT Services',
  primaryColor: '#1F5FAD',
  logo: { sha256: SHA_A, mime: 'image/png', bytes: 69, data: PNG_B64 },
  locale: 'de-DE',
  ...over,
});
const none = (version = 2): PromptIdentityWire => ({
  version,
  state: 'none',
  partnerName: null,
  primaryColor: null,
  logo: null,
  locale: 'en',
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('identity name sanitize fixture (shared with the agent and the API)', () => {
  const cases = (sanitizeFixture as { cases: { name: string; input: string; expected: string | null }[] }).cases;

  it('has rows', () => {
    expect(cases.length).toBeGreaterThan(10);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    // The wire name is re-sanitized on the Assist side (defence in depth)...
    const identity = identityFromWire(set({ partnerName: c.input }));
    expect(identity?.partnerName ?? null).toBe(c.expected);
    // ...and an empty result shows the localized generic name.
    expect(identityDisplayName(identity, 'en')).toBe(c.expected ?? 'Your IT support team');
  });
});

describe('identityFromWire', () => {
  it('drops a cleared (none) identity', () => {
    expect(identityFromWire(none())).toBeNull();
    expect(identityFromWire(null)).toBeNull();
    expect(identityDisplayName(null, 'de-DE')).toBe('Ihr IT-Support-Team');
  });

  it('keeps only a strict #RRGGBB colour and an allowed logo type', () => {
    expect(identityFromWire(set({ primaryColor: 'red' }))?.primaryColor).toBeNull();
    expect(identityFromWire(set({ primaryColor: '#1F5FAD' }))?.primaryColor).toBe('#1F5FAD');
    const svg = set({ logo: { sha256: SHA_A, mime: 'image/svg+xml', bytes: 69, data: PNG_B64 } });
    expect(identityFromWire(svg)?.logo).toBeNull();
  });
});

describe('logoObjectUrl', () => {
  it('turns the base64 bytes into a typed Blob object URL', async () => {
    let blob: Blob | null = null;
    const create = vi.fn((b: Blob) => {
      blob = b;
      return 'blob:assist/1';
    });
    expect(logoObjectUrl({ sha256: SHA_A, mime: 'image/png', data: PNG_B64 }, create)).toBe('blob:assist/1');
    expect(blob!.type).toBe('image/png');
    expect(blob!.size).toBe(69);
  });

  it('refuses bad base64, wrong types and oversized logos, never a remote URL, and says why', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const create = vi.fn(() => 'blob:x');
    expect(logoObjectUrl({ sha256: SHA_A, mime: 'image/png', data: 'not base64!!' }, create)).toBeNull();
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('not base64'));
    expect(logoObjectUrl({ sha256: SHA_A, mime: 'image/png', data: 'https://example.invalid/logo.png' }, create)).toBeNull();
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('not base64'));
    const big = btoa('x'.repeat(262_145));
    expect(logoObjectUrl({ sha256: SHA_A, mime: 'image/png', data: big }, create)).toBeNull();
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('too large'));
    expect(logoObjectUrl({ sha256: SHA_A, mime: 'image/svg+xml' as 'image/png', data: PNG_B64 }, create)).toBeNull();
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('type'));
    expect(create).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(4);
  });
});

/** Rust's API: `get` returns the current identity, the event is a version notice. */
function fakeApi(first: PromptIdentityWire) {
  let current = first;
  let notify: ((n: PromptIdentityNotice) => void) | null = null;
  const unlisten = vi.fn(() => {
    notify = null;
  });
  const api: PromptIdentityApi = {
    get: vi.fn(async () => current),
    subscribe: vi.fn(async (cb: (n: PromptIdentityNotice) => void) => {
      notify = cb;
      return unlisten;
    }),
  };
  return {
    api,
    unlisten,
    push: async (w: PromptIdentityWire) => {
      current = w;
      await act(async () => notify?.({ version: w.version }));
    },
  };
}

describe('usePromptIdentity', () => {
  it('holds the synced identity and drops it when cleared', async () => {
    const { api, push } = fakeApi(set());
    const urls = { create: vi.fn(() => 'blob:assist/a'), revoke: vi.fn() };
    const { result } = renderHook(() => usePromptIdentity(api, true, urls));
    await waitFor(() => expect(result.current.identity?.partnerName).toBe('Example IT Services'));
    expect(result.current.locale).toBe('de-DE');
    expect(result.current.logoUrl).toBe('blob:assist/a');
    await push(none());
    expect(result.current.identity).toBeNull();
    expect(result.current.logoUrl).toBeNull();
    expect(result.current.locale).toBe('en');
    expect(urls.revoke).toHaveBeenCalledWith('blob:assist/a');
  });

  it('the event is only a notice: the identity is pulled through the label-checked command', async () => {
    const { api, push } = fakeApi(set());
    const { result } = renderHook(() => usePromptIdentity(api, true, { create: () => 'blob:x', revoke: () => {} }));
    await waitFor(() => expect(result.current.identity).not.toBeNull());
    expect(api.get).toHaveBeenCalledTimes(1);
    await push(set({ version: 4, partnerName: 'Example IT' }));
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(result.current.identity?.partnerName).toBe('Example IT');
  });

  it('revokes the old logo URL when the logo changes, and on unmount', async () => {
    const { api, push } = fakeApi(set());
    let n = 0;
    const urls = { create: vi.fn(() => `blob:assist/${++n}`), revoke: vi.fn() };
    const { result, unmount } = renderHook(() => usePromptIdentity(api, true, urls));
    await waitFor(() => expect(result.current.logoUrl).toBe('blob:assist/1'));
    // Same logo, newer version: the URL is kept, not re-created.
    await push(set({ version: 5, partnerName: 'Example IT' }));
    expect(result.current.logoUrl).toBe('blob:assist/1');
    await push(set({ version: 6, logo: { sha256: SHA_B, mime: 'image/png', bytes: 69, data: PNG_B64 } }));
    expect(result.current.logoUrl).toBe('blob:assist/2');
    expect(urls.revoke).toHaveBeenCalledWith('blob:assist/1');
    unmount();
    expect(urls.revoke).toHaveBeenCalledWith('blob:assist/2');
  });

  it('keeps the newer of two pulls that resolve out of order', async () => {
    const resolvers: ((w: PromptIdentityWire) => void)[] = [];
    let notify: ((n: PromptIdentityNotice) => void) | null = null;
    const api: PromptIdentityApi = {
      get: vi.fn(() => new Promise<PromptIdentityWire>((r) => resolvers.push(r))),
      subscribe: vi.fn(async (cb) => {
        notify = cb;
        return () => {};
      }),
    };
    const { result } = renderHook(() => usePromptIdentity(api, true, { create: () => 'blob:x', revoke: () => {} }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    act(() => notify?.({ version: 9 }));
    expect(api.get).toHaveBeenCalledTimes(2);
    await act(async () => resolvers[1]!(none(9)));
    await act(async () => resolvers[0]!(set({ version: 3 })));
    expect(result.current.identity).toBeNull();
  });

  it('a failed pull is logged and the next notice recovers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { api, push } = fakeApi(set());
    (api.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce('busy');
    const { result } = renderHook(() => usePromptIdentity(api, true, { create: () => 'blob:x', revoke: () => {} }));
    await waitFor(() => expect(warn).toHaveBeenCalledWith('[prompt] could not load the MSP identity', 'busy'));
    expect(result.current.identity).toBeNull();
    await push(set({ version: 2 }));
    expect(result.current.identity?.partnerName).toBe('Example IT Services');
  });

  it('unmounting before the subscription resolves still unlistens', async () => {
    let resolveSub: (fn: () => void) => void = () => {};
    const unlisten = vi.fn();
    const api: PromptIdentityApi = {
      get: vi.fn(async () => set()),
      subscribe: vi.fn(() => new Promise<() => void>((r) => (resolveSub = r))),
    };
    const { unmount } = renderHook(() => usePromptIdentity(api, true));
    unmount();
    await act(async () => resolveSub(unlisten));
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(api.get).not.toHaveBeenCalled();
  });

  it('can skip decoding the logo (a window that only needs the locale)', async () => {
    const { api } = fakeApi(set());
    const urls = { create: vi.fn(() => 'blob:x'), revoke: vi.fn() };
    const { result } = renderHook(() => usePromptIdentity(api, true, urls, { decodeLogo: false }));
    await waitFor(() => expect(result.current.locale).toBe('de-DE'));
    expect(result.current.logoUrl).toBeNull();
    expect(urls.create).not.toHaveBeenCalled();
  });

  it('does nothing outside Tauri', () => {
    const { api } = fakeApi(set());
    const { result } = renderHook(() => usePromptIdentity(api, false));
    expect(result.current.identity).toBeNull();
    expect(api.subscribe).not.toHaveBeenCalled();
  });
});
