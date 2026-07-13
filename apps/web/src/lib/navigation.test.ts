import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Control the dynamic `astro:transitions/client` import. The vitest config
// aliases this virtual module to a stub, but we re-mock it here so we can
// assert on / reject from `navigate`.
const navigateMock = vi.fn();
vi.mock('astro:transitions/client', () => ({
  navigate: (...args: unknown[]) => navigateMock(...args),
}));

import { navigateTo } from './navigation';

describe('navigateTo same-origin guard', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    navigateMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it('rechecks a caller guard after the dynamic import before navigating', async () => {
    let current = true;
    navigateMock.mockImplementationOnce(async () => undefined);

    const navigation = navigateTo('/devices/123', {
      guard: () => current,
    });
    current = false;
    await navigation;

    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('does not use the location fallback when a caller guard becomes stale', async () => {
    const assignSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { assign: assignSpy, replace: vi.fn() } as unknown as Location,
    });
    let checks = 0;
    navigateMock.mockRejectedValueOnce(new Error('navigate failed'));

    await navigateTo('/devices/123', { guard: () => ++checks === 1 });

    expect(assignSpy).not.toHaveBeenCalled();
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
