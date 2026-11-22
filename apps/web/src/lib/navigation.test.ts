import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Control the dynamic `astro:transitions/client` import. The vitest config
// aliases this virtual module to a stub, but we re-mock it here so we can
// assert on / reject from `navigate`.
const navigateMock = vi.fn();
vi.mock('astro:transitions/client', () => ({
  navigate: (...args: unknown[]) => navigateMock(...args),
}));

import { navigateTo, navigateToMicrosoftLogin } from './navigation';

describe('navigateTo same-origin guard', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    navigateMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // #12476: the router's fragment-only shortcut pushStates with no hashchange,
  // so hashchange subscribers (useHashState) never see the new fragment.
  describe('same path, different fragment', () => {
    afterEach(() => {
      window.history.pushState({}, '', '/');
    });

    it('assigns location.hash (firing hashchange) instead of calling the router', async () => {
      window.history.pushState({}, '', '/approvals#proposal-AAAA');
      const onHashChange = vi.fn();
      window.addEventListener('hashchange', onHashChange);
      try {
        const mode = await navigateTo('/approvals#proposal-BBBB');
        expect(navigateMock).not.toHaveBeenCalled();
        expect(window.location.hash).toBe('#proposal-BBBB');
        await new Promise((r) => setTimeout(r, 0));
        expect(onHashChange).toHaveBeenCalledTimes(1);
        expect(mode).toBe('soft');
      } finally {
        window.removeEventListener('hashchange', onHashChange);
      }
    });

    it('still routes when the path differs', async () => {
      window.history.pushState({}, '', '/approvals#proposal-AAAA');
      await navigateTo('/devices#proposal-BBBB');
      expect(navigateMock).toHaveBeenCalledWith('/devices#proposal-BBBB', { history: 'auto' });
    });

    it('still routes when the query differs', async () => {
      window.history.pushState({}, '', '/approvals?x=1#a');
      await navigateTo('/approvals?x=2#a');
      expect(navigateMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('safe internal paths pass through unchanged', () => {
    const safePaths = [
      '/',
      '/devices/123?tab=info',
      '/settings#x',
      '/alerts?severity=high',
      '/configuration-policies/abc-def',
    ];

    for (const path of safePaths) {
      it(`passes ${JSON.stringify(path)} to navigate verbatim`, async () => {
        await navigateTo(path);
        expect(navigateMock).toHaveBeenCalledTimes(1);
        expect(navigateMock).toHaveBeenCalledWith(path, { history: 'auto' });
      });
    }
  });

  describe('unsafe inputs are replaced with the "/" fallback', () => {
    const unsafePaths = [
      'https://evil.com',
      '//evil.com',
      '/\\evil.com',
      'javascript:alert(1)',
      'relative/no/leading/slash',
      '/with\u0000control',
      // Identity-provider hand-offs are external too: passing one here lands
      // the user on the dashboard instead (#11572). They go through
      // navigateToMicrosoftLogin.
      'https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=example',
    ];

    for (const path of unsafePaths) {
      it(`rewrites ${JSON.stringify(path)} to "/"`, async () => {
        await navigateTo(path);
        expect(navigateMock).toHaveBeenCalledTimes(1);
        expect(navigateMock).toHaveBeenCalledWith('/', { history: 'auto' });
      });
    }
  });

  it('honors the replace option in the history mode', async () => {
    await navigateTo('/devices/123', { replace: true });
    expect(navigateMock).toHaveBeenCalledWith('/devices/123', { history: 'replace' });
  });

  describe('catch / fallback branch uses the sanitized value', () => {
    let assignSpy: ReturnType<typeof vi.fn>;
    let replaceSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      assignSpy = vi.fn();
      replaceSpy = vi.fn();
      // jsdom's window.location is not directly assignable; redefine it with
      // assign/replace stubs so we can observe the fallback navigation.
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { assign: assignSpy, replace: replaceSpy } as unknown as Location,
      });
      navigateMock.mockRejectedValue(new Error('navigate failed'));
    });

    it('falls back to window.location.assign with a safe path', async () => {
      await navigateTo('/devices/123?tab=info');
      expect(assignSpy).toHaveBeenCalledWith('/devices/123?tab=info');
      expect(replaceSpy).not.toHaveBeenCalled();
    });

    it('falls back to window.location.assign with the "/" fallback for unsafe input', async () => {
      await navigateTo('https://evil.com');
      expect(assignSpy).toHaveBeenCalledWith('/');
    });

    it('falls back to window.location.replace with a safe path when replace is set', async () => {
      await navigateTo('/settings#x', { replace: true });
      expect(replaceSpy).toHaveBeenCalledWith('/settings#x');
      expect(assignSpy).not.toHaveBeenCalled();
    });

    it('falls back to window.location.replace with "/" for unsafe input when replace is set', async () => {
      await navigateTo('//evil.com', { replace: true });
      expect(replaceSpy).toHaveBeenCalledWith('/');
    });
  });
});

describe('navigateToMicrosoftLogin', () => {
  const originalLocation = window.location;
  let assignSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    assignSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { assign: assignSpy } as unknown as Location,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  it('performs a full-page navigation to the pinned Microsoft login origin', () => {
    navigateToMicrosoftLogin(
      'https://login.microsoftonline.com/common/adminconsent?client_id=example',
    );
    expect(assignSpy).toHaveBeenCalledWith(
      'https://login.microsoftonline.com/common/adminconsent?client_id=example',
    );
  });

  it.each([
    'http://login.microsoftonline.com/common/adminconsent',
    'https://login.microsoftonline.com.evil.example/common/adminconsent',
    'https://login.microsoftonline.com:444/common/adminconsent',
    `https://user:password${String.fromCharCode(64)}login.microsoftonline.com/common/adminconsent`,
    'not-a-url',
  ])('rejects an untrusted external destination: %s', (url) => {
    expect(() => navigateToMicrosoftLogin(url)).toThrow('Invalid Microsoft login URL');
    expect(assignSpy).not.toHaveBeenCalled();
  });
});

describe('navigateTo reports which path it took', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    navigateMock.mockResolvedValue(undefined);
  });

  it("resolves 'soft' only when the router actually swapped the document (astro:after-swap fired)", async () => {
    navigateMock.mockImplementation(async () => {
      document.dispatchEvent(new Event('astro:after-swap'));
    });
    await expect(navigateTo('/devices')).resolves.toBe('soft');
  });

  it("resolves 'hard' when navigate() resolved without a swap (Astro's own full-load fallbacks never throw)", async () => {
    // e.g. fetch failed / non-HTML response / no view-transitions meta: the
    // router sets location.href and resolves normally.
    navigateMock.mockResolvedValue(undefined);
    await expect(navigateTo('/devices')).resolves.toBe('hard');
  });

  it('does not leave the after-swap listener behind once settled', async () => {
    navigateMock.mockResolvedValue(undefined);
    await navigateTo('/devices');
    const before = navigateMock.mock.calls.length;
    document.dispatchEvent(new Event('astro:after-swap'));
    expect(navigateMock.mock.calls.length).toBe(before); // no side effects either way
  });

  it("resolves 'hard' when it had to fall back to a full navigation", async () => {
    navigateMock.mockRejectedValue(new Error('no router'));
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true, writable: true,
      value: { ...original, assign, replace: vi.fn() },
    });
    try {
      await expect(navigateTo('/devices')).resolves.toBe('hard');
      expect(assign).toHaveBeenCalledWith('/devices');
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, writable: true, value: original });
    }
  });
});

describe('navigateTo router-state seeding (#8331)', () => {
  beforeEach(() => {
    navigateMock.mockReset();
  });

  it('seeds history.state before a replace navigation when a hash write wiped it', async () => {
    window.history.replaceState(null, '', '/devices#foo');
    let stateAtNavigate: unknown = 'unset';
    navigateMock.mockImplementation(async () => {
      stateAtNavigate = window.history.state;
    });
    await navigateTo('/devices', { replace: true });
    expect(stateAtNavigate).toMatchObject({ index: expect.any(Number) });
  });

  it('does not clobber existing router state', async () => {
    window.history.replaceState({ index: 4, scrollX: 0, scrollY: 0 }, '', '/devices');
    navigateMock.mockResolvedValue(undefined);
    await navigateTo('/devices', { replace: true });
    expect(window.history.state).toEqual({ index: 4, scrollX: 0, scrollY: 0 });
  });
});
