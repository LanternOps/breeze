import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Monaco loader is a singleton inside @monaco-editor/react. We assert that
// our helper points it at our self-hosted assets (/monaco/vs) instead of the
// library's hardcoded cdn.jsdelivr.net default — the whole point of #1023.
const config = vi.fn();

// configureMonacoLoader dynamically imports this module; vi.mock intercepts the
// dynamic import too.
vi.mock('@monaco-editor/react', () => ({
  loader: {
    config: (...args: unknown[]) => config(...args),
  },
}));

describe('configureMonacoLoader', () => {
  beforeEach(() => {
    config.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('points the Monaco loader at the self-hosted /monaco/vs path', async () => {
    const { configureMonacoLoader } = await import('./monacoLoader');
    await configureMonacoLoader();

    expect(config).toHaveBeenCalledTimes(1);
    expect(config).toHaveBeenCalledWith({ paths: { vs: '/monaco/vs' } });
  });

  it('never points the loader at an external CDN', async () => {
    const { configureMonacoLoader } = await import('./monacoLoader');
    await configureMonacoLoader();

    const arg = JSON.stringify(config.mock.calls[0]?.[0] ?? {});
    expect(arg).not.toContain('jsdelivr');
    expect(arg).not.toContain('http');
  });

  it('is idempotent — configures the loader at most once across repeated calls', async () => {
    const { configureMonacoLoader } = await import('./monacoLoader');
    await configureMonacoLoader();
    await configureMonacoLoader();
    await configureMonacoLoader();

    expect(config).toHaveBeenCalledTimes(1);
  });
});
