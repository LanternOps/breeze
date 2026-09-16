import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import '@/lib/i18n';

vi.mock('./ContractsList', () => ({ ContractsList: () => <div data-testid="stub-list" />, default: () => <div data-testid="stub-list" /> }));
vi.mock('./CurrencyMismatchesTab', () => ({ default: () => <div data-testid="stub-currency" /> }));

import ContractsTabs from './ContractsTabs';

// A fresh deep-link load (e.g. a bookmark, or a link from outside the app) has
// no `history.state` yet. Astro's `navigate()` throws a TypeError reading it
// inside its own async `updateDOM`, which Astro swallows internally — the
// error never reaches `navigateTo`'s try/catch, so its `window.location`
// fallback never runs and the address bar/title are left stranded on
// /contracts. This legacy-hash redirect is a cross-page jump that must not
// leave a history entry and must work from a cold load either way, so it
// bypasses `navigateTo`/Astro's client router entirely and drives
// `window.location.replace` directly.
//
// jsdom's real `Location.replace` is not implemented and errors when called
// unmocked (see apps/web/src/stores/auth.test.ts's `mockLocation`), so stub
// `window.location` the same way here.
function mockLocation(hash: string) {
  const originalLocation = window.location;
  const replace = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, hash, replace },
  });
  return {
    replace,
    restore: () => {
      Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    },
  };
}

describe('ContractsTabs legacy deep links', () => {
  let location: ReturnType<typeof mockLocation>;

  beforeEach(() => {
    vi.clearAllMocks();
    location = mockLocation('');
  });

  afterEach(() => {
    location.restore();
  });

  it('redirects #tab=templates to the agreement templates route with a full-page navigation', () => {
    location.restore();
    location = mockLocation('#tab=templates');
    render(<ContractsTabs />);
    expect(location.replace).toHaveBeenCalledWith('/agreements/templates');
  });

  it('redirects #tab=documents to the signed agreements route with a full-page navigation', () => {
    location.restore();
    location = mockLocation('#tab=documents');
    render(<ContractsTabs />);
    expect(location.replace).toHaveBeenCalledWith('/agreements/signed');
  });

  it('leaves #tab=currency-mismatches alone', () => {
    location.restore();
    location = mockLocation('#tab=currency-mismatches');
    render(<ContractsTabs />);
    expect(location.replace).not.toHaveBeenCalled();
  });

  it('renders the contracts list with no tab bar by default', () => {
    render(<ContractsTabs />);
    expect(document.querySelector('[data-testid="contracts-tab-contracts"]')).toBeNull();
    expect(document.querySelector('[data-testid="contracts-tab-templates"]')).toBeNull();
    expect(document.querySelector('[data-testid="contracts-tab-documents"]')).toBeNull();
  });
});
