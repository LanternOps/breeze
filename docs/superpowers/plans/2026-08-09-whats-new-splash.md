# What's-New Splash Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dismissible "Welcome to version X — what's new" splash shown to authenticated users after a release, with "Got it" (mark seen) / "Show me later" (snooze) actions and a persistent "What's new" reopen link. Content bundled with the web build; dismissal state in `localStorage`.

**Architecture:** Three focused units — a bundled data module, a pure decision module (fully unit-testable with injected storage), and a React island that reuses the shared `Dialog` primitive. Mounted once in the authenticated shell. No API, no DB, no agent changes.

**Tech Stack:** Astro + React islands, `react-i18next`, Vitest + jsdom, `@breeze/shared` `semverCompare`. Reuses `apps/web/src/components/shared/Dialog.tsx` (focus-trap, Esc, backdrop, scroll-lock, aria — do not re-implement a11y).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-09-whats-new-splash-design.md` — authoritative.
- **Scope:** `apps/web` only.
- **i18n key parity:** every new key MUST exist in all 7 locales (`en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`) or `apps/web/src/lib/i18n/localeParity.test.ts` reds main. Chrome strings are i18n'd; changelog entry content is English-only (documented non-goal).
- **`WEB_VERSION` sentinel:** `'dev'` (local/un-versioned builds) — the auto-splash never shows in dev.
- **`semverCompare(a, b)` returns `number | null`** (null = unparseable) — every call must handle null.
- **No `runAction`:** no network/mutation; `localStorage` only.
- **This feature is unrelated to the current branch** (`ToddHebebrand/constrained-signed-installer`). Implement on a fresh branch off `main`.

---

### Task 1: Changelog data module

**Files:**
- Create: `apps/web/src/lib/whatsNew.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface WhatsNewEntry { version: string; date: string; title: string; highlights: string[]; learnMoreUrl?: string }`; `const WHATS_NEW_ENTRIES: WhatsNewEntry[]` (newest-first).

- [ ] **Step 1: Create the module with the type and a seed entry**

```ts
// apps/web/src/lib/whatsNew.ts

/** One release's "what's new" content, bundled with the web build. */
export interface WhatsNewEntry {
  /** Exact release version, e.g. "0.105.0". Compared with semverCompare. */
  version: string;
  /** ISO date, e.g. "2026-08-12". */
  date: string;
  /** One-line headline. */
  title: string;
  /** 2–5 short bullets. */
  highlights: string[];
  /** Optional deep link (docs / release notes). */
  learnMoreUrl?: string;
}

/**
 * Newest-first. Authored per release alongside the release-notes flow.
 * Entry content is English-only in v1 (see spec non-goals).
 */
export const WHATS_NEW_ENTRIES: WhatsNewEntry[] = [
  {
    version: '0.105.0',
    date: '2026-08-12',
    title: 'Faster fleet views and clearer device health',
    highlights: [
      'Fleet lists load noticeably faster on large tenants.',
      'Device health cards surface reliability at a glance.',
    ],
    learnMoreUrl: 'https://breezermm.com/release-notes',
  },
];
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && pnpm exec tsc --noEmit`
Expected: PASS (no type errors from the new module).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/whatsNew.ts
git commit -m "feat(web): add bundled what's-new changelog data module"
```

---

### Task 2: Decision logic module (pure, unit-tested)

**Files:**
- Create: `apps/web/src/lib/whatsNewState.ts`
- Test: `apps/web/src/lib/whatsNewState.test.ts`

**Interfaces:**
- Consumes: `semverCompare` (`@breeze/shared`), `WEB_VERSION` (`./version`), `WHATS_NEW_ENTRIES`/`WhatsNewEntry` (`./whatsNew`).
- Produces:
  - `const LAST_SEEN_KEY = 'breeze.whatsNew.lastSeenVersion'`
  - `interface WhatsNewDecision { entry: WhatsNewEntry | null; baselineToSet: string | null }`
  - `function decideWhatsNew(storage: Pick<Storage,'getItem'|'setItem'>, webVersion?: string, entries?: WhatsNewEntry[]): WhatsNewDecision`
  - `function markSeen(storage: Pick<Storage,'setItem'>, version: string): void`
  - `function latestApplicableEntry(webVersion?: string, entries?: WhatsNewEntry[]): WhatsNewEntry | null`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/src/lib/whatsNewState.test.ts
import { describe, it, expect } from 'vitest';
import { decideWhatsNew, markSeen, latestApplicableEntry, LAST_SEEN_KEY } from './whatsNewState';
import type { WhatsNewEntry } from './whatsNew';

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    _map: map,
  };
}

const ENTRIES: WhatsNewEntry[] = [
  { version: '0.105.0', date: '2026-08-12', title: 'B', highlights: ['b'] },
  { version: '0.104.0', date: '2026-08-08', title: 'A', highlights: ['a'] },
];

describe('decideWhatsNew', () => {
  it('never shows on dev builds', () => {
    const s = fakeStorage();
    expect(decideWhatsNew(s, 'dev', ENTRIES)).toEqual({ entry: null, baselineToSet: null });
    expect(s._map.has(LAST_SEEN_KEY)).toBe(false);
  });

  it('first-ever load sets baseline without showing', () => {
    const s = fakeStorage();
    expect(decideWhatsNew(s, '0.105.0', ENTRIES)).toEqual({ entry: null, baselineToSet: '0.105.0' });
  });

  it('shows the newest entry above the floor and at/below web version', () => {
    const s = fakeStorage({ [LAST_SEEN_KEY]: '0.104.0' });
    const d = decideWhatsNew(s, '0.105.0', ENTRIES);
    expect(d.entry?.version).toBe('0.105.0');
    expect(d.baselineToSet).toBeNull();
  });

  it('shows nothing when floor equals newest', () => {
    const s = fakeStorage({ [LAST_SEEN_KEY]: '0.105.0' });
    expect(decideWhatsNew(s, '0.105.0', ENTRIES).entry).toBeNull();
  });

  it('suppresses entries newer than the running web version', () => {
    const s = fakeStorage({ [LAST_SEEN_KEY]: '0.103.0' });
    // web is 0.104.0, so 0.105.0 must not show; 0.104.0 should.
    expect(decideWhatsNew(s, '0.104.0', ENTRIES).entry?.version).toBe('0.104.0');
  });

  it('shows nothing after markSeen', () => {
    const s = fakeStorage({ [LAST_SEEN_KEY]: '0.104.0' });
    markSeen(s, '0.105.0');
    expect(decideWhatsNew(s, '0.105.0', ENTRIES).entry).toBeNull();
  });
});

describe('latestApplicableEntry', () => {
  it('returns newest entry <= web version regardless of floor', () => {
    expect(latestApplicableEntry('0.104.0', ENTRIES)?.version).toBe('0.104.0');
  });
  it('returns newest entry on dev (for demoability)', () => {
    expect(latestApplicableEntry('dev', ENTRIES)?.version).toBe('0.105.0');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && pnpm exec vitest run src/lib/whatsNewState.test.ts`
Expected: FAIL — module/functions undefined.

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/lib/whatsNewState.ts
import { semverCompare } from '@breeze/shared';
import { WEB_VERSION } from './version';
import { WHATS_NEW_ENTRIES, type WhatsNewEntry } from './whatsNew';

export const LAST_SEEN_KEY = 'breeze.whatsNew.lastSeenVersion';

export interface WhatsNewDecision {
  /** The entry to show, or null. */
  entry: WhatsNewEntry | null;
  /** First-ever load only: caller writes this baseline and shows nothing. */
  baselineToSet: string | null;
}

function highest(entries: WhatsNewEntry[]): WhatsNewEntry | null {
  return entries.reduce<WhatsNewEntry | null>((best, e) => {
    if (!best) return e;
    const c = semverCompare(e.version, best.version);
    return c !== null && c > 0 ? e : best;
  }, null);
}

/** Pure: storage is injected so it is trivially testable. */
export function decideWhatsNew(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  webVersion: string = WEB_VERSION,
  entries: WhatsNewEntry[] = WHATS_NEW_ENTRIES,
): WhatsNewDecision {
  if (webVersion === 'dev') return { entry: null, baselineToSet: null };

  const floor = storage.getItem(LAST_SEEN_KEY);
  if (!floor) return { entry: null, baselineToSet: webVersion };

  const applicable = entries.filter((e) => {
    const aboveFloor = semverCompare(e.version, floor);
    const atMostWeb = semverCompare(e.version, webVersion);
    return aboveFloor !== null && aboveFloor > 0 && atMostWeb !== null && atMostWeb <= 0;
  });
  return { entry: highest(applicable), baselineToSet: null };
}

export function markSeen(storage: Pick<Storage, 'setItem'>, version: string): void {
  storage.setItem(LAST_SEEN_KEY, version);
}

/** Newest entry the running build has shipped, ignoring dismissal (for reopen). */
export function latestApplicableEntry(
  webVersion: string = WEB_VERSION,
  entries: WhatsNewEntry[] = WHATS_NEW_ENTRIES,
): WhatsNewEntry | null {
  if (webVersion === 'dev') return highest(entries);
  const applicable = entries.filter((e) => {
    const c = semverCompare(e.version, webVersion);
    return c !== null && c <= 0;
  });
  return highest(applicable);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && pnpm exec vitest run src/lib/whatsNewState.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/whatsNewState.ts apps/web/src/lib/whatsNewState.test.ts
git commit -m "feat(web): add what's-new decision logic with localStorage baseline"
```

---

### Task 3: i18n chrome strings across all locales

**Files:**
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR}/common.json`
- Test: `apps/web/src/lib/i18n/localeParity.test.ts` (existing — run, don't edit)

**Interfaces:**
- Produces: a `whatsNew` object in the `common` namespace with keys `title` (interpolates `{{version}}`), `gotIt`, `later`, `learnMore`, `link`.

- [ ] **Step 1: Add the `whatsNew` block to each locale's `common.json`**

`en/common.json` — add:
```json
"whatsNew": {
  "title": "What's new in {{version}}",
  "gotIt": "Got it",
  "later": "Show me later",
  "learnMore": "Learn more",
  "link": "What's new"
}
```

`de-DE/common.json`:
```json
"whatsNew": {
  "title": "Neu in {{version}}",
  "gotIt": "Verstanden",
  "later": "Später anzeigen",
  "learnMore": "Mehr erfahren",
  "link": "Neuigkeiten"
}
```

`es-419/common.json`:
```json
"whatsNew": {
  "title": "Novedades en {{version}}",
  "gotIt": "Entendido",
  "later": "Mostrar más tarde",
  "learnMore": "Más información",
  "link": "Novedades"
}
```

`fr-FR/common.json` **and** `fr-CA/common.json`:
```json
"whatsNew": {
  "title": "Nouveautés de la version {{version}}",
  "gotIt": "Compris",
  "later": "Afficher plus tard",
  "learnMore": "En savoir plus",
  "link": "Nouveautés"
}
```

`it-IT/common.json`:
```json
"whatsNew": {
  "title": "Novità nella versione {{version}}",
  "gotIt": "Ho capito",
  "later": "Mostra più tardi",
  "learnMore": "Scopri di più",
  "link": "Novità"
}
```

`pt-BR/common.json`:
```json
"whatsNew": {
  "title": "Novidades na versão {{version}}",
  "gotIt": "Entendi",
  "later": "Mostrar mais tarde",
  "learnMore": "Saiba mais",
  "link": "Novidades"
}
```

(Insert the block as a valid JSON member — mind the trailing comma on the preceding member. Place it alphabetically if the file is sorted, otherwise at the end of the top-level object.)

- [ ] **Step 2: Run the parity test**

Run: `cd apps/web && pnpm exec vitest run src/lib/i18n/localeParity.test.ts`
Expected: PASS — all 7 locales carry identical key sets.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/locales/*/common.json
git commit -m "feat(web): add what's-new splash i18n strings across locales"
```

---

### Task 4: `WhatsNewSplash` component

**Files:**
- Create: `apps/web/src/components/whatsNew/WhatsNewSplash.tsx`
- Test: `apps/web/src/components/whatsNew/WhatsNewSplash.test.tsx`

**Interfaces:**
- Consumes: `Dialog` (`../shared/Dialog`), `decideWhatsNew`/`markSeen`/`latestApplicableEntry`/`LAST_SEEN_KEY` (Task 2), `useTranslation('common')`.
- Produces: `default` export `WhatsNewSplash` (no props). Listens for a `window` event `breeze:whats-new:open` to reopen (Task 5's Sidebar link dispatches it — islands don't share React state, so a window event is the bridge).

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/web/src/components/whatsNew/WhatsNewSplash.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import WhatsNewSplash from './WhatsNewSplash';
import { LAST_SEEN_KEY } from '../../lib/whatsNewState';

// t returns key + interpolated version so assertions are stable without real i18n.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) =>
      opts?.version ? `${k}:${opts.version}` : k,
  }),
}));

// Force a known decision by stubbing the running version and entries indirectly:
// seed localStorage floor below the bundled entry so the newest entry shows.
vi.mock('../../lib/version', () => ({ WEB_VERSION: '99.0.0' }));

beforeEach(() => {
  window.localStorage.clear();
  // floor below any real entry so decideWhatsNew returns the newest bundled entry
  window.localStorage.setItem(LAST_SEEN_KEY, '0.0.1');
});

describe('WhatsNewSplash', () => {
  it('renders the newest entry title + highlights', () => {
    render(<WhatsNewSplash />);
    expect(screen.getByText(/whatsNew\.title:/)).toBeInTheDocument();
    // at least one highlight bullet is present
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0);
  });

  it('"Got it" writes lastSeen and closes', () => {
    render(<WhatsNewSplash />);
    fireEvent.click(screen.getByText('whatsNew.gotIt'));
    expect(window.localStorage.getItem(LAST_SEEN_KEY)).not.toBe('0.0.1');
    expect(screen.queryByText('whatsNew.gotIt')).not.toBeInTheDocument();
  });

  it('"Show me later" closes without writing', () => {
    render(<WhatsNewSplash />);
    fireEvent.click(screen.getByText('whatsNew.later'));
    expect(window.localStorage.getItem(LAST_SEEN_KEY)).toBe('0.0.1');
    expect(screen.queryByText('whatsNew.later')).not.toBeInTheDocument();
  });

  it('renders nothing when there is no applicable entry', () => {
    window.localStorage.clear(); // first-ever load => baseline only, no show
    const { container } = render(<WhatsNewSplash />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && pnpm exec vitest run src/components/whatsNew/WhatsNewSplash.test.tsx`
Expected: FAIL — component undefined.

- [ ] **Step 3: Write the component**

```tsx
// apps/web/src/components/whatsNew/WhatsNewSplash.tsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../shared/Dialog';
import {
  decideWhatsNew,
  markSeen,
  latestApplicableEntry,
  LAST_SEEN_KEY,
} from '../../lib/whatsNewState';
import type { WhatsNewEntry } from '../../lib/whatsNew';

export const REOPEN_EVENT = 'breeze:whats-new:open';

export default function WhatsNewSplash() {
  const { t } = useTranslation('common');
  const [entry, setEntry] = useState<WhatsNewEntry | null>(null);
  const [open, setOpen] = useState(false);

  // Decide once on mount (post-hydration; initial render is null → no SSR mismatch).
  useEffect(() => {
    const decision = decideWhatsNew(window.localStorage);
    if (decision.baselineToSet) {
      window.localStorage.setItem(LAST_SEEN_KEY, decision.baselineToSet);
      return;
    }
    if (decision.entry) {
      setEntry(decision.entry);
      setOpen(true);
    }
  }, []);

  // Reopen from the sidebar link (separate island → window-event bridge).
  useEffect(() => {
    const onReopen = () => {
      const e = latestApplicableEntry();
      if (e) {
        setEntry(e);
        setOpen(true);
      }
    };
    window.addEventListener(REOPEN_EVENT, onReopen);
    return () => window.removeEventListener(REOPEN_EVENT, onReopen);
  }, []);

  if (!entry) return null;

  const gotIt = () => {
    markSeen(window.localStorage, entry.version);
    setOpen(false);
  };
  // Dialog onClose fires on Esc / backdrop → treated as "show me later".
  const later = () => setOpen(false);

  return (
    <Dialog
      open={open}
      onClose={later}
      title={t('whatsNew.title', { version: entry.version })}
      labelledBy="whats-new-heading"
      maxWidth="lg"
      className="p-6"
    >
      <h2 id="whats-new-heading" className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t('whatsNew.title', { version: entry.version })}
      </h2>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{entry.title}</p>
      <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-gray-700 dark:text-gray-300">
        {entry.highlights.map((h, i) => (
          <li key={i}>{h}</li>
        ))}
      </ul>
      {entry.learnMoreUrl && (
        <a
          href={entry.learnMoreUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-block text-sm text-blue-600 hover:underline dark:text-blue-400"
        >
          {t('whatsNew.learnMore')}
        </a>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <button
          type="button"
          onClick={later}
          className="rounded-md px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          {t('whatsNew.later')}
        </button>
        <button
          type="button"
          onClick={gotIt}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          {t('whatsNew.gotIt')}
        </button>
      </div>
    </Dialog>
  );
}
```

(Match button/link Tailwind classes to the repo's existing modal conventions if they differ — inspect `PatchApprovalModal.tsx` or a sibling and mirror its primary/secondary button classes rather than the placeholders above.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && pnpm exec vitest run src/components/whatsNew/WhatsNewSplash.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/whatsNew/
git commit -m "feat(web): add WhatsNewSplash modal component"
```

---

### Task 5: Mount in the shell + sidebar reopen link + verify

**Files:**
- Modify: `apps/web/src/layouts/DashboardLayout.astro` (mount the island)
- Modify: `apps/web/src/components/layout/Sidebar.tsx` (reopen link near the version footer, ~`:792`)

**Interfaces:**
- Consumes: `WhatsNewSplash` (default export), `REOPEN_EVENT` constant, `useTranslation('common')` in Sidebar.

- [ ] **Step 1: Mount the island in `DashboardLayout.astro`**

Add to the imports (alongside the other island imports, ~`:12`):
```astro
import WhatsNewSplash from '../components/whatsNew/WhatsNewSplash';
```
Add near the other persistent overlays (after `ToastContainer`, ~`:57`):
```astro
  <WhatsNewSplash client:load transition:persist />
```

- [ ] **Step 2: Add the reopen link in `Sidebar.tsx`**

In the footer where `WEB_VERSION` renders (~`:792`), add a button that dispatches the reopen event. If `Sidebar` does not already call `useTranslation`, add `const { t } = useTranslation('common');` near the top of the component (import `useTranslation` from `react-i18next`; import `REOPEN_EVENT` from `../whatsNew/WhatsNewSplash`):

```tsx
<button
  type="button"
  onClick={() => window.dispatchEvent(new Event(REOPEN_EVENT))}
  className="text-xs text-gray-400 hover:text-gray-600 hover:underline dark:hover:text-gray-200"
>
  {t('whatsNew.link')}
</button>
```

(Place it adjacent to the version label; match surrounding footer classes.)

- [ ] **Step 3: Typecheck + run the affected web tests**

Run:
```bash
cd apps/web && pnpm exec tsc --noEmit && \
  pnpm exec vitest run src/lib/whatsNewState.test.ts src/components/whatsNew/WhatsNewSplash.test.tsx src/lib/i18n/localeParity.test.ts
```
Expected: PASS.

- [ ] **Step 4: Manual verification (dev server)**

Run the web app, log in, and confirm:
- With `localStorage` cleared: no splash on first load; `breeze.whatsNew.lastSeenVersion` is set to the running version.
- Manually set `localStorage['breeze.whatsNew.lastSeenVersion']` to an older version (e.g. `0.0.1`) and reload: splash appears with the newest entry.
- "Got it" dismisses and does not reappear on reload; "Show me later" dismisses but reappears on reload.
- The sidebar "What's new" link reopens the modal regardless of dismissal state.
- Esc and backdrop click behave as "Show me later".

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/layouts/DashboardLayout.astro apps/web/src/components/layout/Sidebar.tsx
git commit -m "feat(web): mount what's-new splash in shell + sidebar reopen link"
```

---

## Self-Review

- **Spec coverage:** bundled content (T1) ✓; version-gated localStorage trigger + first-load baseline + `dev` skip + `version <= WEB_VERSION` suppression (T2) ✓; "Got it"/"Show me later"/Esc/backdrop (T4, via `Dialog`) ✓; reopen link (T4 event + T5 Sidebar) ✓; i18n chrome across 7 locales, English-only entry content (T3) ✓; reuse `Dialog` for a11y ✓; no `runAction` (no network) ✓.
- **Placeholder scan:** all code is real; Tailwind class strings and the Sidebar insertion point are flagged "mirror the adjacent code" rather than left vague.
- **Type consistency:** `WhatsNewEntry`, `WhatsNewDecision`, `decideWhatsNew`/`markSeen`/`latestApplicableEntry`/`LAST_SEEN_KEY`, `REOPEN_EVENT` used identically across tasks; `semverCompare` null-handling applied at every call.
- **Implementer confirmation points (flagged inline):** exact footer markup/classes in `Sidebar.tsx` (T5), whether `Sidebar` already imports `useTranslation` (T5), and the repo's canonical modal button classes (T4).
