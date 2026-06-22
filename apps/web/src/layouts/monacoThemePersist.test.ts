import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The fix for #1589 lives in a standalone public script (loaded globally from
// Layout.astro), not inside the React editor component. Load and execute the
// real file so the test exercises shipped behavior, mirroring themeBootstrap.
const SCRIPT_SOURCE = readFileSync(
  join(process.cwd(), 'public/monaco-theme-persist.js'),
  'utf8'
);

function runGlobalScript(): void {
  // The IIFE reads/writes window + document, both provided by the jsdom env.
  // SCRIPT_SOURCE is our own committed file read from disk (no interpolation,
  // no external input) — this just executes the shipped script under test.
  // eslint-disable-next-line no-new-func -- executes the trusted file under test
  new Function(SCRIPT_SOURCE)();
}

function makeBeforeSwapEvent(): Event & { newDocument: Document } {
  const newDocument = document.implementation.createHTMLDocument('');
  return Object.assign(new Event('astro:before-swap'), { newDocument });
}

describe('monaco-theme-persist global handler (issue #1589)', () => {
  beforeEach(() => {
    // Window persists across Astro swaps; the script guards on this flag. Reset
    // it (and any injected styles) so each test starts from a clean global.
    delete (window as unknown as { __monacoThemePersist?: boolean }).__monacoThemePersist;
    document.head.querySelectorAll('style.monaco-colors').forEach((el) => el.remove());
  });

  afterEach(() => {
    document.head.querySelectorAll('style.monaco-colors').forEach((el) => el.remove());
  });

  // The headline regression #1593 missed: the failing navigation is
  // scripts-list -> editor, where the editor component (and any listener it
  // owns) is NOT mounted. This global handler must still clone the theme style
  // forward with no component rendered at all.
  it('clones the live monaco-colors style into the incoming document with no editor component mounted', () => {
    runGlobalScript();

    const live = document.createElement('style');
    live.className = 'monaco-colors';
    live.textContent = '.monaco-editor { color: #d4d4d4; }';
    document.head.appendChild(live);

    const event = makeBeforeSwapEvent();
    document.dispatchEvent(event);

    const cloned = event.newDocument.head.querySelector('style.monaco-colors');
    expect(cloned).not.toBeNull();
    expect(cloned?.textContent).toBe('.monaco-editor { color: #d4d4d4; }');
  });

  it('does not duplicate the style when the incoming document already carries one', () => {
    runGlobalScript();

    const live = document.createElement('style');
    live.className = 'monaco-colors';
    live.textContent = '.monaco-editor { color: #d4d4d4; }';
    document.head.appendChild(live);

    const event = makeBeforeSwapEvent();
    const carried = event.newDocument.createElement('style');
    carried.className = 'monaco-colors';
    carried.textContent = '/* already present */';
    event.newDocument.head.appendChild(carried);

    document.dispatchEvent(event);

    expect(event.newDocument.head.querySelectorAll('style.monaco-colors')).toHaveLength(1);
    expect(event.newDocument.head.querySelector('style.monaco-colors')?.textContent).toBe(
      '/* already present */'
    );
  });

  it('no-ops when no monaco-colors style is present (editor never mounted this session)', () => {
    runGlobalScript();

    const event = makeBeforeSwapEvent();
    expect(() => document.dispatchEvent(event)).not.toThrow();
    expect(event.newDocument.head.querySelector('style.monaco-colors')).toBeNull();
  });

  it('registers the swap listener only once even if the script is evaluated again', () => {
    runGlobalScript();
    runGlobalScript(); // re-execution on a later page load must be a no-op

    const live = document.createElement('style');
    live.className = 'monaco-colors';
    live.textContent = '.monaco-editor { color: #d4d4d4; }';
    document.head.appendChild(live);

    const event = makeBeforeSwapEvent();
    document.dispatchEvent(event);

    // A double-registered listener would still leave exactly one node (guarded
    // by the existence check), so assert the guard flag instead.
    expect((window as unknown as { __monacoThemePersist?: boolean }).__monacoThemePersist).toBe(true);
    expect(event.newDocument.head.querySelectorAll('style.monaco-colors')).toHaveLength(1);
  });
});

describe('Layout wires the monaco-theme-persist script (issue #1589)', () => {
  it('loads the global handler before <ClientRouter /> so it is installed before the first swap', () => {
    const source = readFileSync(join(process.cwd(), 'src/layouts/Layout.astro'), 'utf8');

    expect(source).toContain('<script is:inline src="/monaco-theme-persist.js"></script>');
    expect(source.indexOf('src="/monaco-theme-persist.js"')).toBeLessThan(
      source.indexOf('<ClientRouter />')
    );
  });
});
