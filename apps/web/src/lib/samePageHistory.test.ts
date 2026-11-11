import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { claimSamePageHistory } from './samePageHistory';

// The hook is the shipped public script (loaded by every ClientRouter layout);
// execute the real file, mirroring monacoThemePersist.test.ts.
const SCRIPT_SOURCE = readFileSync(join(process.cwd(), 'public/same-page-history.js'), 'utf8');
type HookWindow = typeof window & { __breezeSamePageHistory?: unknown };

function installHook(): void {
  // Our own committed file read from disk: executes the shipped script under test.
  // eslint-disable-next-line no-new-func -- executes the trusted file under test
  new Function(SCRIPT_SOURCE)();
}

const popstate = (state: unknown = { index: 1 }) => window.dispatchEvent(new PopStateEvent('popstate', { state }));

describe('same-page history claims', () => {
  const cleanups: Array<() => void> = [];
  let router: Mock<(event: Event) => void>;

  beforeEach(() => {
    delete (window as HookWindow).__breezeSamePageHistory;
    router = vi.fn<(event: Event) => void>();
  });
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
    delete (window as HookWindow).__breezeSamePageHistory;
  });

  // Chromium runs window listeners in registration order, capture or not: the
  // hook (a classic script) is registered before the router module, which is
  // registered before any island. Here the "router" is even a capture
  // listener added after the hook, the strongest competitor jsdom allows.
  function installRouter() {
    window.addEventListener('popstate', router, true);
    cleanups.push(() => window.removeEventListener('popstate', router, true));
  }

  it('a claim that handles the step keeps the router (and every later listener) from seeing it', () => {
    installHook();
    installRouter();
    const claim = vi.fn(() => true);
    cleanups.push(claimSamePageHistory(claim));

    popstate();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(router).not.toHaveBeenCalled();
  });

  it('a claim that declines leaves the step to the router', () => {
    installHook();
    installRouter();
    const claim = vi.fn(() => false);
    cleanups.push(claimSamePageHistory(claim));

    popstate();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(router).toHaveBeenCalledTimes(1);
  });

  it('an unregistered claim is no longer asked', () => {
    installHook();
    installRouter();
    const claim = vi.fn(() => true);
    claimSamePageHistory(claim)();

    popstate();
    expect(claim).not.toHaveBeenCalled();
    expect(router).toHaveBeenCalledTimes(1);
  });

  it('a claim that throws is logged and does not stop the next claim or the router', () => {
    installHook();
    installRouter();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const next = vi.fn(() => false);
    cleanups.push(claimSamePageHistory(() => { throw new Error('boom'); }));
    cleanups.push(claimSamePageHistory(next));

    popstate();
    expect(error).toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(router).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('installs once, however often the script runs (a swap re-runs new head scripts)', () => {
    installHook();
    installHook();
    const claim = vi.fn(() => true);
    cleanups.push(claimSamePageHistory(claim));
    popstate();
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it('without the hook (a layout that lacks it) the claim still runs, as an ordinary listener', () => {
    const claim = vi.fn(() => true);
    cleanups.push(claimSamePageHistory(claim));
    popstate();
    expect(claim).toHaveBeenCalledTimes(1);
  });
});
