# What's-New Splash — Design Spec

**Date:** 2026-08-09
**Status:** approved (design), pending implementation plan
**Scope:** `apps/web` only. No API, no DB, no agent changes.

## Goal

Show authenticated users a dismissible "Welcome to version X — what's new" splash on
login after a release, with **"Got it"** (mark seen) and **"Show me later"** (snooze)
actions, plus a persistent **"What's new"** reopen link. Content is bundled with the
web build; dismissal state is per-browser `localStorage`.

This is a standalone feature. It is *also* the surface the later hosted-constrained
installer **migration banner** will attach to — but that banner is server-driven,
persistent, and **out of scope here** (see "Out of scope").

## Non-goals (YAGNI)

- **No server-side dismissal.** `localStorage` only; dismissal is per-browser in v1.
- **No multi-version catch-up view.** If a user skipped several releases, show only
  the single newest applicable entry.
- **No migration banner.** Separate, server-driven, lands later on this same surface.
- **No localized changelog content.** Splash chrome is i18n'd; entry copy is English v1.

## Architecture

One React island, decision logic extracted to a pure module, content in a data
module. Three files, one responsibility each:

| File | Responsibility |
|---|---|
| `apps/web/src/lib/whatsNew.ts` | Bundled changelog **data** — newest-first `WhatsNewEntry[]`. |
| `apps/web/src/lib/whatsNewState.ts` | Pure **decision logic**: which entry to show, and the read/write of the `localStorage` baseline. No React, no DOM beyond an injected storage. |
| `apps/web/src/components/whatsNew/WhatsNewSplash.tsx` | Modal **UI** + reopen link. Consumes the logic module. |

Mounted once in `apps/web/src/layouts/DashboardLayout.astro` (the authenticated
shell) as `<WhatsNewSplash client:only="react" />`. On mount it renders the modal
only when the logic module returns an entry; otherwise renders nothing.

### Data shape

```ts
// apps/web/src/lib/whatsNew.ts
export interface WhatsNewEntry {
  version: string;        // exact release version, e.g. "0.105.0"
  date: string;           // ISO date, e.g. "2026-08-12"
  title: string;          // one-line headline
  highlights: string[];   // 2–5 short bullets
  learnMoreUrl?: string;  // optional deep link (docs / release notes)
}

// Newest first. Authored per release alongside the release-notes flow.
export const WHATS_NEW_ENTRIES: WhatsNewEntry[] = [ /* … */ ];
```

### Decision logic

```ts
// apps/web/src/lib/whatsNewState.ts
import { semverCompare } from '@breeze/shared';
import { WEB_VERSION } from './version';
import { WHATS_NEW_ENTRIES, type WhatsNewEntry } from './whatsNew';

export const LAST_SEEN_KEY = 'breeze.whatsNew.lastSeenVersion';

export interface WhatsNewDecision {
  entry: WhatsNewEntry | null;   // the entry to show, or null
  baselineToSet: string | null;  // first-ever-load: silently set lastSeen, don't show
}

// Pure: storage is injected so it is trivially testable.
export function decideWhatsNew(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  webVersion: string = WEB_VERSION,
  entries: WhatsNewEntry[] = WHATS_NEW_ENTRIES,
): WhatsNewDecision { /* … */ }
```

Rules (exact):
1. If `webVersion === 'dev'` → `{entry: null, baselineToSet: null}` (never show on
   un-versioned/local builds; matches the `WEB_VERSION` `'dev'` sentinel).
2. `floor = storage.getItem(LAST_SEEN_KEY)`.
3. **First-ever load** (`floor` absent/empty) → `{entry: null, baselineToSet: webVersion}`.
   The caller writes the baseline so brand-new users are not greeted with a changelog;
   the *next* release is the first they see.
4. Otherwise the candidate is the **newest** entry where
   `semverCompare(entry.version, floor) > 0` **and**
   `semverCompare(entry.version, webVersion) <= 0` (never show notes for a version this
   build has not actually shipped). If found → `{entry, baselineToSet: null}`, else
   `{entry: null, baselineToSet: null}`.

`markSeen(storage, version)` writes `LAST_SEEN_KEY = version`. Reopen (the "What's
new" link) shows the newest entry with `version <= webVersion` regardless of `floor`.

### Component behavior

On mount, `WhatsNewSplash` calls `decideWhatsNew(window.localStorage)`. If
`baselineToSet` is non-null, it writes it and renders nothing. If `entry` is non-null,
it renders the modal.

Buttons:
- **"Got it"** (primary) → `markSeen(storage, entry.version)`, close.
- **"Show me later"** (secondary) → close, write nothing (reappears next login).
- **Esc / backdrop click** → same as "Show me later".

Reopen entry point: a **"What's new"** button in the sidebar footer
(`apps/web/src/components/layout/Sidebar.tsx`, next to the existing `WEB_VERSION`
label) opens the modal with the latest applicable entry. Reopening does not change
dismissal state; closing from a reopen does not mark seen unless "Got it" is clicked.

## Cross-cutting constraints

- **i18n (required):** all splash chrome strings — title prefix ("What's new in
  {version}"), "Got it", "Show me later", "What's new", aria labels — go through the
  existing i18n system with keys added to **every** locale file (missing keys red main
  via the key-parity gate). Changelog entry `title`/`highlights` are English-only in
  v1 (documented non-goal).
- **No `runAction`:** no network/mutation, so the mutation-feedback contract does not
  apply. `localStorage` writes are synchronous and local.
- **Accessibility:** focus-trapped modal; Esc and backdrop close (= "Show me later");
  focus returns to the trigger (or a sensible anchor) on close; the modal has
  `role="dialog"` + `aria-modal="true"` + a labelled title.
- **Astro islands:** `client:only="react"` (state depends on `window.localStorage`;
  no SSR benefit and avoids a hydration mismatch on the version gate).

## Testing

**`whatsNewState.test.ts`** (vitest, injected fake storage — no DOM):
- `dev` version → no entry, no baseline write.
- First-ever load (empty storage) → no entry, `baselineToSet === WEB_VERSION`.
- `floor` older than newest applicable entry → returns that entry.
- `floor` equal to newest → no entry.
- Entry with `version > webVersion` is suppressed.
- After `markSeen`, the same decision returns no entry.
- Reopen selector returns newest entry `<= webVersion` regardless of floor.

**`WhatsNewSplash.test.tsx`** (vitest + jsdom):
- Renders title + all highlights when an entry is present.
- "Got it" writes `LAST_SEEN_KEY` and closes.
- "Show me later" closes without writing.
- Esc closes without writing.
- Renders nothing when the logic module returns no entry.
- Reopen link opens the modal.

## Files

- Create: `apps/web/src/lib/whatsNew.ts`, `apps/web/src/lib/whatsNewState.ts`,
  `apps/web/src/components/whatsNew/WhatsNewSplash.tsx`, plus the two test files.
- Modify: `apps/web/src/layouts/DashboardLayout.astro` (mount the island),
  `apps/web/src/components/layout/Sidebar.tsx` (reopen link), and every
  `apps/web/src/locales/*/` bundle that holds shared/common chrome keys.

## Out of scope (tracked, not built here)

- **Migration banner** for the hosted-constrained installer rollout (design:
  `internal/abuse/2026-08-09-hosted-constrained-signed-installer.md` §6 step 2):
  server-driven, persistent (does not vanish on dismiss), shows the grace deadline,
  shown only to self-host admins whose fleet reports the hosted edition against a
  non-allowlisted server. It will reuse this splash surface for a one-time prominent
  mention but carries its own persistent banner and its own spec.
- Server-side cross-device dismissal persistence (localStorage → per-user preference).
- Localized changelog entry content.
