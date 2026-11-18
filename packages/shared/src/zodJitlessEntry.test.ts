import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every runtime `@breeze/shared` entry the web bundle can reach must set zod's
 * `jitless` before it constructs a schema. zod >= 4.6 reads its eval probe
 * (`new Function('')`) when an object schema is constructed, which the web CSP
 * (no 'unsafe-eval') reports as a violation (topology-browser-gate). The
 * barrels therefore start with `import './validators/topologyZod'`.
 */
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { exports: Record<string, string> };
const entries = Object.entries(pkg.exports).filter(([key]) => !key.startsWith('./testing'));

describe('browser-side zod eval probe', () => {
  const realFunction = globalThis.Function;
  afterEach(() => {
    globalThis.Function = realFunction;
    delete (globalThis as { document?: unknown }).document;
    vi.resetModules();
  });

  it.each(entries)('%s does not probe eval in a browser context', async (_key, file) => {
    vi.resetModules();
    (globalThis as { document?: unknown }).document = {};
    const probes: string[] = [];
    globalThis.Function = new Proxy(realFunction, {
      construct(target, args) {
        probes.push(String(args[0] ?? ''));
        return Reflect.construct(target, args);
      },
    });
    await import(/* @vite-ignore */ join(__dirname, '..', file));
    expect(probes.filter((code) => code === '')).toEqual([]);
  });
});
