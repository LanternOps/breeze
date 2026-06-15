import { describe, expect, it } from 'vitest';
import { bootAddin } from './boot';
import type { RuntimeConfig } from './config';

describe('bootAddin', () => {
  it('awaits the config loader BEFORE rendering', async () => {
    const order: string[] = [];
    let releaseLoad: () => void = () => {};
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const loader = (async () => {
      order.push('load:start');
      await loadGate;
      order.push('load:done');
      return { apiBaseUrl: 'http://localhost:3001', entraClientId: '' } satisfies RuntimeConfig;
    }) as unknown as typeof import('./config').loadRuntimeConfig;

    const booted = bootAddin(() => order.push('render'), loader);

    // The loader has started but not resolved — render must NOT have happened.
    await Promise.resolve();
    expect(order).toEqual(['load:start']);

    releaseLoad();
    await booted;
    expect(order).toEqual(['load:start', 'load:done', 'render']);
  });

  it('still renders when the loader resolves immediately', async () => {
    const order: string[] = [];
    const loader = (async () => {
      order.push('load');
      return { apiBaseUrl: 'http://localhost:3001', entraClientId: '' } satisfies RuntimeConfig;
    }) as unknown as typeof import('./config').loadRuntimeConfig;
    await bootAddin(() => order.push('render'), loader);
    expect(order).toEqual(['load', 'render']);
  });
});
