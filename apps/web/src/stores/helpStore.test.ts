import { beforeEach, describe, expect, it, vi } from 'vitest';

// open() lazily imports ./aiStore to close the AI panel; stub it so tests
// don't pull in the real aiStore (network/auth) module.
vi.mock('./aiStore', () => ({
  useAiStore: {
    getState: () => ({ close: vi.fn() })
  }
}));

import { getDocsForPath, DOCS_BASE_URL } from '@breeze/shared';
import { useHelpStore } from './helpStore';

const setPathname = (pathname: string) => {
  Object.defineProperty(window, 'location', {
    value: { pathname },
    writable: true,
    configurable: true
  });
};

describe('help store open() href hardening', () => {
  beforeEach(() => {
    useHelpStore.setState({
      isOpen: false,
      docsUrl: DOCS_BASE_URL,
      label: 'Documentation'
    });
    setPathname('/devices');
  });

  it('keeps a DOCS_BASE_URL-prefixed url as docsUrl and opens', () => {
    const trusted = `${DOCS_BASE_URL}/features/device-groups/`;

    useHelpStore.getState().open(trusted);

    const state = useHelpStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.docsUrl).toBe(trusted);
    expect(state.label).toBe('Documentation');
  });

  it.each([
    'javascript:alert(1)',
    'https://evil.example/x',
    '//evil.com',
    // Prefix-bypass lookalike: shares the DOCS_BASE_URL string prefix but is a
    // different origin. The old startsWith() check let this through; an origin
    // check must reject it. This case would have caught the original bug.
    'https://docs.breezermm.com.evil.com',
    'https://docs.breezermm.com@evil.com/x',
    'https://docs.breezermm.comevil.com'
  ])('does not write untrusted url %s into docsUrl', (malicious) => {
    const expected = getDocsForPath('/devices');

    useHelpStore.getState().open(malicious);

    const state = useHelpStore.getState();
    expect(state.isOpen).toBe(true);
    // The malicious value must never reach the iframe-bound docsUrl.
    expect(state.docsUrl).not.toBe(malicious);
    // Instead it falls back to the safe contextual docs page.
    expect(state.docsUrl).toBe(expected.url);
    expect(state.label).toBe(expected.label);
  });

  it('resolves contextual docs via getDocsForPath when called with no arg', () => {
    setPathname('/alerts');
    const expected = getDocsForPath('/alerts');

    useHelpStore.getState().open();

    const state = useHelpStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.docsUrl).toBe(expected.url);
    expect(state.label).toBe(expected.label);
  });
});
