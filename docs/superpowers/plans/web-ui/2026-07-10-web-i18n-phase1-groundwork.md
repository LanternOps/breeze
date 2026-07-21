# Web Console i18n Phase-1 Groundwork Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the i18n framework, a persisted per-user language preference (`en` / `pt-BR`), locale-aware number/currency/date formatting seams, and a translated seed surface (sidebar nav) — so the community can start contributing pt-BR translations incrementally.

**Architecture:** i18next + react-i18next as a module-level singleton shared by all React islands (no per-island provider needed — `initReactI18next` registers the default instance that `useTranslation()` falls back to). Locale preference follows the existing `appearance.ts` pattern (localStorage key + normalize/read/write/subscribe), persists server-side via the existing `users.preferences` jsonb machinery (`PATCH /users/me`), and gets applied on login/refresh through the existing `fetchAndApplyPreferences` → `applyAppearancePreferences` path. Translations live in bundled JSON files (`apps/web/src/locales/<locale>/common.json`) with structured keys.

**Tech Stack:** i18next, react-i18next, existing Astro 7 (`output: 'server'`) + React 19 islands, Vitest + jsdom, Zod-validated Hono API.

## Global Constraints

- Node is pinned to v22.20.0; use `pnpm` (workspace). Worktrees need `pnpm install` before tests.
- Web tests: Vitest + jsdom, co-located next to source (`foo.ts` → `foo.test.ts`), `apps/web/vitest.config.ts` picks up `src/**/*.test.{ts,tsx}` automatically.
- API tests: co-located, Drizzle-mock pattern (see `breeze-testing` skill if writing new API tests).
- Mutations in web components must go through `runAction` (here: everything rides the existing `saveUserPreferences` helper, which already wraps `runAction` — do not add new raw `fetchWithAuth` mutations).
- Supported locales in Phase 1: exactly `['en', 'pt-BR']`. The string list appears in two places (web `LOCALE_OPTIONS`, API `validatePreferenceEnum` call) — keep them identical.
- Strict CSP (`default-src 'self'`): locale JSON must be bundled via static import, never fetched from a CDN.
- Translation keys are structured (`nav.dashboard`), NOT natural-language keys. English is the fallback language; a missing pt-BR key renders English, never a raw key (always pass `defaultValue` at nav call sites).
- Do NOT translate: `data-testid` attributes (e2e contract), log messages, API payload values, permission/resource identifiers.
- No changes to `.astro` pages, Astro config i18n routing, or URL structure — locale is a user setting, not a route segment.
- **Known accepted tradeoff (document, don't fight):** SSR renders islands in English; a pt-BR user's islands re-render client-side in pt-BR after hydration (React recovers from the text mismatch by client-rendering the island). Cookie-based SSR locale is an explicit non-goal of Phase 1.

## Out of Scope (Phase 2+)

- Extracting the ~5–10k remaining hardcoded strings across 915 components (community-driven, incremental).
- API-originated messages (~3,400 strings), emails, PDF reports.
- Partner-level default language (the disabled `PartnerRegionalTab` "Language" box stays as-is; `PartnerSettingsPage.tsx:369` already persists `language: 'en'` in the partner settings blob — resolution order user→partner→browser is Phase 2).
- Migrating the 146 scattered `.toFixed(` call sites to `formatNumber` (Phase 2 uses the helper landed here).

---

### Task 1: Locale preference primitives in `appearance.ts`

**Files:**
- Modify: `apps/web/src/lib/appearance.ts` (263 lines — append locale block following the existing TimeFormat pattern)
- Test: `apps/web/src/lib/__tests__/localePreference.test.ts` (create)

**Interfaces:**
- Consumes: existing private helpers `readStorageValue(key)` / `writeStorageValue(key, value)` in `appearance.ts`.
- Produces (relied on by Tasks 2–6):
  - `LOCALE_OPTIONS: readonly ['en', 'pt-BR']`, `type LocalePreference = 'en' | 'pt-BR'`, `LOCALE_STORAGE_KEY = 'breeze.locale'`
  - `isValidLocale(value: unknown): value is LocalePreference`
  - `normalizeLocale(value: unknown): LocalePreference | undefined`
  - `readLocalePreference(): LocalePreference | undefined` — explicit user choice only
  - `detectBrowserLocale(): LocalePreference` — navigator match, base-language aware (`pt` → `pt-BR`, `en-GB` → `en`), default `'en'`
  - `readResolvedLocalePreference(): LocalePreference` — `readLocalePreference() ?? detectBrowserLocale()`
  - `writeLocalePreference(value: LocalePreference): void` — persists + notifies subscribers
  - `subscribeLocale(fn: (value: LocalePreference) => void): () => void`
  - `AppearancePreferences` gains optional `locale?: LocalePreference`; `applyAppearancePreferences` applies it.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/__tests__/localePreference.test.ts`:

```ts
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import {
  LOCALE_OPTIONS,
  LOCALE_STORAGE_KEY,
  isValidLocale,
  normalizeLocale,
  readLocalePreference,
  detectBrowserLocale,
  readResolvedLocalePreference,
  writeLocalePreference,
  subscribeLocale,
  applyAppearancePreferences,
} from '../appearance';

describe('locale preference', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exposes exactly en and pt-BR', () => {
    expect(LOCALE_OPTIONS).toEqual(['en', 'pt-BR']);
  });

  it('validates locales', () => {
    expect(isValidLocale('en')).toBe(true);
    expect(isValidLocale('pt-BR')).toBe(true);
    expect(isValidLocale('fr')).toBe(false);
    expect(isValidLocale(42)).toBe(false);
    expect(normalizeLocale('pt-BR')).toBe('pt-BR');
    expect(normalizeLocale('junk')).toBeUndefined();
  });

  it('round-trips through localStorage', () => {
    expect(readLocalePreference()).toBeUndefined();
    writeLocalePreference('pt-BR');
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('pt-BR');
    expect(readLocalePreference()).toBe('pt-BR');
  });

  it('ignores garbage in localStorage', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'klingon');
    expect(readLocalePreference()).toBeUndefined();
  });

  it('detects pt-BR from navigator, including base-language pt', () => {
    vi.stubGlobal('navigator', { languages: ['pt-BR', 'en'], language: 'pt-BR' });
    expect(detectBrowserLocale()).toBe('pt-BR');
    vi.stubGlobal('navigator', { languages: ['pt', 'en'], language: 'pt' });
    expect(detectBrowserLocale()).toBe('pt-BR');
    vi.stubGlobal('navigator', { languages: ['en-GB'], language: 'en-GB' });
    expect(detectBrowserLocale()).toBe('en');
    vi.stubGlobal('navigator', { languages: ['fr-FR'], language: 'fr-FR' });
    expect(detectBrowserLocale()).toBe('en');
  });

  it('resolves stored preference over browser detection', () => {
    vi.stubGlobal('navigator', { languages: ['pt-BR'], language: 'pt-BR' });
    expect(readResolvedLocalePreference()).toBe('pt-BR');
    writeLocalePreference('en');
    expect(readResolvedLocalePreference()).toBe('en');
  });

  it('notifies subscribers on write and supports unsubscribe', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeLocale((v) => seen.push(v));
    writeLocalePreference('pt-BR');
    expect(seen).toEqual(['pt-BR']);
    unsubscribe();
    writeLocalePreference('en');
    expect(seen).toEqual(['pt-BR']);
  });

  it('applyAppearancePreferences applies locale when present', () => {
    applyAppearancePreferences({ locale: 'pt-BR' });
    expect(readLocalePreference()).toBe('pt-BR');
    applyAppearancePreferences({});
    expect(readLocalePreference()).toBe('pt-BR'); // untouched when absent
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm vitest run src/lib/__tests__/localePreference.test.ts`
Expected: FAIL — `LOCALE_OPTIONS` (and friends) have no exported member in `../appearance`.

- [ ] **Step 3: Implement the locale block in `appearance.ts`**

Add near the other `*_OPTIONS` consts (top of file):

```ts
export const LOCALE_OPTIONS = ['en', 'pt-BR'] as const;
export type LocalePreference = (typeof LOCALE_OPTIONS)[number];
```

Add `LOCALE_STORAGE_KEY` next to the other storage keys (after line 29):

```ts
export const LOCALE_STORAGE_KEY = 'breeze.locale';
```

Add `locale` to the preferences bag (the `AppearancePreferences` type, lines 15–20):

```ts
export type AppearancePreferences = {
  theme?: ThemePreference;
  density?: Density;
  font?: FontPreference;
  timeFormat?: TimeFormatPreference;
  locale?: LocalePreference;
};
```

Add validators/read/write/subscribe following the exact TimeFormat pattern (place the guard near `isValidTimeFormat`, the read/detect/resolve trio near `readTimeFormatPreference`, the write near `writeTimeFormatPreference`, and the subscriber set near `timeFormatSubscribers`):

```ts
export function isValidLocale(value: unknown): value is LocalePreference {
  return typeof value === 'string' && (LOCALE_OPTIONS as readonly string[]).includes(value);
}

export function normalizeLocale(value: unknown): LocalePreference | undefined {
  return isValidLocale(value) ? value : undefined;
}

export function readLocalePreference(): LocalePreference | undefined {
  return normalizeLocale(readStorageValue(LOCALE_STORAGE_KEY));
}

export function detectBrowserLocale(): LocalePreference {
  if (typeof navigator === 'undefined') {
    return 'en';
  }
  const candidates = [...(navigator.languages ?? []), navigator.language].filter(
    (v): v is string => typeof v === 'string' && v.length > 0
  );
  for (const candidate of candidates) {
    const match = LOCALE_OPTIONS.find(
      (option) =>
        option.toLowerCase() === candidate.toLowerCase() ||
        option.split('-')[0] === candidate.split('-')[0]
    );
    if (match) {
      return match;
    }
  }
  return 'en';
}

export function readResolvedLocalePreference(): LocalePreference {
  return readLocalePreference() ?? detectBrowserLocale();
}

export function writeLocalePreference(value: LocalePreference): void {
  if (!isValidLocale(value)) return;
  writeStorageValue(LOCALE_STORAGE_KEY, value);
  notifyLocale(value);
}
```

Subscriber plumbing (next to `timeFormatSubscribers`, mirroring `notifyTimeFormat`/`subscribeTimeFormat`):

```ts
const localeSubscribers = new Set<(value: LocalePreference) => void>();

function notifyLocale(value: LocalePreference): void {
  for (const fn of localeSubscribers) {
    try { fn(value); } catch { /* Subscriber errors must not break setter. */ }
  }
}

export function subscribeLocale(fn: (value: LocalePreference) => void): () => void {
  localeSubscribers.add(fn);
  return () => { localeSubscribers.delete(fn); };
}
```

Extend `applyAppearancePreferences` (lines 164–169) with one line:

```ts
export function applyAppearancePreferences(preferences: AppearancePreferences): void {
  if (preferences.theme)      { writeThemePreference(preferences.theme); }
  if (preferences.density)    { writeDensity(preferences.density); }
  if (preferences.font)       { writeFontPreference(preferences.font); }
  if (preferences.timeFormat) { writeTimeFormatPreference(preferences.timeFormat); }
  if (preferences.locale)     { writeLocalePreference(preferences.locale); }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && pnpm vitest run src/lib/__tests__/localePreference.test.ts`
Expected: PASS (all 8 tests).

Also run the existing appearance-adjacent suites to catch regressions:
`cd apps/web && pnpm vitest run src/lib`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/appearance.ts apps/web/src/lib/__tests__/localePreference.test.ts
git commit -m "feat(web): locale preference primitives (en, pt-BR) in appearance layer"
```

---

### Task 2: i18next runtime + seed locale JSON

**Files:**
- Create: `apps/web/src/locales/en/common.json`
- Create: `apps/web/src/locales/pt-BR/common.json`
- Create: `apps/web/src/locales/README.md`
- Create: `apps/web/src/lib/i18n/index.ts`
- Test: `apps/web/src/lib/i18n/i18n.test.ts` (co-located)
- Modify: `apps/web/package.json` (via `pnpm add`)

**Interfaces:**
- Consumes: `readResolvedLocalePreference`, `subscribeLocale`, `writeLocalePreference`, `type LocalePreference` from `../appearance` (Task 1).
- Produces (relied on by Tasks 4–6):
  - Module `apps/web/src/lib/i18n/index.ts` whose **import has the side effect** of initializing the shared i18next instance and subscribing it to locale changes. Components call `useTranslation()` from `react-i18next` directly after importing this module once.
  - Named export `i18n` (the i18next instance) for tests and imperative use.
  - Named export `setLocale(locale: LocalePreference): void` — writes the preference (which notifies i18next via the subscription).
  - Translation namespaces: single `common` namespace, `defaultNS: 'common'`.

- [ ] **Step 1: Install dependencies**

```bash
cd apps/web && pnpm add i18next react-i18next
```

Expected: both added to `apps/web/package.json` dependencies; lockfile updated at repo root.

- [ ] **Step 2: Create the seed locale files**

`apps/web/src/locales/en/common.json`:

```json
{
  "nav": {
    "dashboard": "Dashboard",
    "devices": "Devices",
    "alerts": "Alerts",
    "tickets": "Tickets",
    "incidents": "Incidents",
    "remoteAccess": "Remote Access",
    "scripts": "Scripts",
    "patches": "Patches",
    "vulnerabilities": "Vulnerabilities",
    "sectionAiFleet": "AI & Fleet",
    "sectionMonitoring": "Monitoring",
    "sectionSecurity": "Security",
    "sectionOperations": "Operations",
    "sectionBackup": "Backup",
    "sectionReporting": "Reporting",
    "sectionSettings": "Settings"
  },
  "settings": {
    "language": {
      "title": "Language",
      "description": "Language for the Breeze console. More languages coming — contributions welcome.",
      "englishLabel": "English",
      "englishDescription": "English (United States)",
      "ptBRLabel": "Português (Brasil)",
      "ptBRDescription": "Portuguese (Brazil)"
    }
  }
}
```

`apps/web/src/locales/pt-BR/common.json`:

```json
{
  "nav": {
    "dashboard": "Painel",
    "devices": "Dispositivos",
    "alerts": "Alertas",
    "tickets": "Chamados",
    "incidents": "Incidentes",
    "remoteAccess": "Acesso Remoto",
    "scripts": "Scripts",
    "patches": "Patches",
    "vulnerabilities": "Vulnerabilidades",
    "sectionAiFleet": "IA e Frota",
    "sectionMonitoring": "Monitoramento",
    "sectionSecurity": "Segurança",
    "sectionOperations": "Operações",
    "sectionBackup": "Backup",
    "sectionReporting": "Relatórios",
    "sectionSettings": "Configurações"
  },
  "settings": {
    "language": {
      "title": "Idioma",
      "description": "Idioma do console Breeze. Mais idiomas em breve — contribuições são bem-vindas.",
      "englishLabel": "English",
      "englishDescription": "Inglês (Estados Unidos)",
      "ptBRLabel": "Português (Brasil)",
      "ptBRDescription": "Português (Brasil)"
    }
  }
}
```

`apps/web/src/locales/README.md`:

```markdown
# Web console translations

One folder per locale (BCP-47 tag), one `common.json` namespace per folder.

## Adding a string
1. Add the key + English text to `en/common.json` (structured keys: `area.thing`, camelCase leaves).
2. Add the translation to every other locale folder. Missing keys fall back to English at runtime — never to a raw key, as long as call sites pass `defaultValue`.
3. In components: `const { t } = useTranslation();` then `t('nav.dashboard', { defaultValue: 'Dashboard' })`.
   The component tree must have imported `@/lib/i18n` somewhere (module side effect initializes the shared instance).

## Adding a locale
1. Create `src/locales/<tag>/common.json` (copy `en/`, translate values, keep keys identical).
2. Register it in `apps/web/src/lib/i18n/index.ts` (resources map) and add the tag to
   `LOCALE_OPTIONS` in `apps/web/src/lib/appearance.ts`.
3. Add the tag to the `validatePreferenceEnum(prefs, 'locale', ...)` allowlist in
   `apps/api/src/routes/users.ts` (PATCH /users/me).
4. Add an option to the Language fieldset in
   `apps/web/src/components/settings/ThemingSettings.tsx`.
5. The key-parity test (`src/lib/i18n/i18n.test.ts`) will fail until keys match `en/` exactly.

Do NOT translate `data-testid` values, log messages, or API payload values.
```

- [ ] **Step 3: Write the failing test**

Create `apps/web/src/lib/i18n/i18n.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { i18n, setLocale } from './index';
import { LOCALE_STORAGE_KEY } from '../appearance';
import en from '../../locales/en/common.json';
import ptBR from '../../locales/pt-BR/common.json';

function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value !== null && typeof value === 'object'
      ? flattenKeys(value as Record<string, unknown>, path)
      : [path];
  });
}

describe('i18n runtime', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    await i18n.changeLanguage('en');
  });

  it('initializes and translates in English by default', () => {
    expect(i18n.isInitialized).toBe(true);
    expect(i18n.t('nav.dashboard')).toBe('Dashboard');
  });

  it('translates to pt-BR after setLocale, and persists the preference', () => {
    setLocale('pt-BR');
    expect(i18n.language).toBe('pt-BR');
    expect(i18n.t('nav.dashboard')).toBe('Painel');
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('pt-BR');
  });

  it('falls back to English for keys missing in pt-BR', () => {
    setLocale('pt-BR');
    expect(i18n.t('nav.dashboard', { defaultValue: 'Dashboard' })).toBe('Painel');
    // A key that exists only in en must fall back, not render the raw key:
    expect(i18n.t('some.future.key', { defaultValue: 'Future thing' })).toBe('Future thing');
  });

  it('pt-BR has exactly the same keys as en (parity)', () => {
    expect(flattenKeys(ptBR).sort()).toEqual(flattenKeys(en).sort());
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd apps/web && pnpm vitest run src/lib/i18n/i18n.test.ts`
Expected: FAIL — cannot resolve `./index` (module doesn't exist yet).

- [ ] **Step 5: Implement `apps/web/src/lib/i18n/index.ts`**

```ts
// Shared i18next instance for all React islands.
//
// Importing this module (side effect) initializes i18next and registers it as
// react-i18next's default instance, so `useTranslation()` works in any island
// without a provider. Locale changes flow through the appearance-layer
// preference (localStorage + subscriber bus) so every island re-renders when
// the user switches language in ThemingSettings.
//
// SSR note: on the server there is no localStorage, so SSR always renders
// English. A pt-BR user's islands re-render client-side after hydration.
// Cookie-based SSR locale is an explicit Phase-2 follow-up.
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../../locales/en/common.json';
import ptBR from '../../locales/pt-BR/common.json';
import {
  readResolvedLocalePreference,
  subscribeLocale,
  writeLocalePreference,
  type LocalePreference,
} from '../appearance';

if (!i18next.isInitialized) {
  void i18next.use(initReactI18next).init({
    resources: {
      en: { common: en },
      'pt-BR': { common: ptBR },
    },
    lng: typeof window === 'undefined' ? 'en' : readResolvedLocalePreference(),
    fallbackLng: 'en',
    defaultNS: 'common',
    // React already escapes interpolated values.
    interpolation: { escapeValue: false },
    // Resources are bundled, so init synchronously — first render has strings.
    initImmediate: false,
    returnNull: false,
  });

  subscribeLocale((locale: LocalePreference) => {
    void i18next.changeLanguage(locale);
  });
}

export const i18n = i18next;

/** Set the console language: persists the preference and switches i18next. */
export function setLocale(locale: LocalePreference): void {
  writeLocalePreference(locale);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/web && pnpm vitest run src/lib/i18n/i18n.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Verify the type check and full web unit suite stay green**

Run: `cd apps/web && pnpm vitest run src/lib && pnpm astro check 2>&1 | tail -5`
Expected: tests PASS; `astro check` reports no new errors (note: `astro check` includes test files).

If `astro check` complains about JSON module resolution, add `"resolveJsonModule": true` to `apps/web/tsconfig.json` `compilerOptions` (Vite handles JSON imports at runtime regardless).

- [ ] **Step 8: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/locales apps/web/src/lib/i18n
git commit -m "feat(web): i18next runtime with bundled en/pt-BR locale resources"
```

---

### Task 3: Server-side persistence of the locale preference

**Files:**
- Modify: `apps/api/src/routes/users.ts` (the `validatePreferenceEnum` chain in PATCH `/users/me`, lines ~577–591)
- Modify: `apps/web/src/stores/auth.ts` (`UserPreferences` interface, lines 20–25)
- Test: extend the existing PATCH `/users/me` preferences tests in `apps/api/src/routes/users.test.ts` (locate the existing `timeFormat`/`theme` validation cases — search for `Invalid timeFormat` — and clone them)

**Interfaces:**
- Consumes: existing `validatePreferenceEnum(prefs, key, validValues, label)` helper (`users.ts:520`), existing preferences merge machinery, `type LocalePreference` from `apps/web/src/lib/appearance.ts` (web side).
- Produces: `PATCH /users/me` accepts `preferences.locale ∈ {'en','pt-BR'}` and rejects anything else with 400; `GET /users/me` already returns `preferences` untouched, so no read-side change. Web `UserPreferences` type carries `locale?: LocalePreference` (relied on by Task 4).

**No migration needed** — `users.preferences` is untyped jsonb and the merge/64KB/audit machinery already handles unknown keys; we're only adding the enum allowlist entry so garbage can't be stored.

- [ ] **Step 1: Write the failing API tests**

In `apps/api/src/routes/users.test.ts`, find the existing describe block covering PATCH `/users/me` preference validation (it has cases asserting 400 for invalid `theme`/`timeFormat` values). Clone that exact request/mock pattern for two new cases (match the file's local helper names — the shape below shows intent, the surrounding file dictates the mock setup):

```ts
it('rejects an invalid locale preference', async () => {
  // same authenticated-request setup as the invalid-timeFormat case above
  const res = await patchMe({ preferences: { locale: 'klingon' } });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toBe('Invalid locale value. Must be en or pt-BR.');
});

it('accepts and merges a valid locale preference', async () => {
  // same authenticated-request setup as the valid-timeFormat case above
  const res = await patchMe({ preferences: { locale: 'pt-BR' } });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.preferences).toMatchObject({ locale: 'pt-BR' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && pnpm vitest run src/routes/users.test.ts`
Expected: the invalid-locale case FAILS (route currently accepts any string under 64 chars — returns 200, not 400). The valid case may already pass; keep it as a regression guard.

- [ ] **Step 3: Add the allowlist entry**

In `apps/api/src/routes/users.ts`, extend the validation chain (after the `timeFormat` line at ~591):

```ts
          ?? validatePreferenceEnum(prefs, 'timeFormat', ['12h', '24h'], '12h or 24h')
          ?? validatePreferenceEnum(prefs, 'locale', ['en', 'pt-BR'], 'en or pt-BR');
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && pnpm vitest run src/routes/users.test.ts`
Expected: PASS (both new cases + all existing).

- [ ] **Step 5: Add `locale` to the web `UserPreferences` type**

In `apps/web/src/stores/auth.ts` (lines 20–25), extend the interface and its import from the appearance module (match the file's existing import of `ThemePreference`/`Density`/`FontPreference`/`TimeFormatPreference`):

```ts
export interface UserPreferences {
  theme?: ThemePreference;
  density?: Density;
  font?: FontPreference;
  timeFormat?: TimeFormatPreference;
  locale?: LocalePreference;
}
```

No further wiring needed: `fetchAndApplyPreferences` (auth.ts:878) already calls `applyAppearancePreferences(data.preferences)`, which now applies `locale` (Task 1) — so a server-stored locale takes effect on login/refresh on any device.

- [ ] **Step 6: Verify web types + tests stay green**

Run: `cd apps/web && pnpm vitest run src/stores src/lib`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/users.ts apps/api/src/routes/users.test.ts apps/web/src/stores/auth.ts
git commit -m "feat: persist per-user locale preference (en, pt-BR) via users.preferences"
```

---

### Task 4: Language selector in per-user settings (ThemingSettings)

**Files:**
- Modify: `apps/web/src/components/settings/ThemingSettings.tsx` (247 lines — add a Language fieldset cloning the Time Format fieldset)
- Test: extend `apps/web/src/components/settings/ThemingSettings.test.tsx` if it exists; otherwise create it co-located.

**Interfaces:**
- Consumes: `setLocale` from `@/lib/i18n` (Task 2), `readResolvedLocalePreference`, `type LocalePreference`, `LOCALE_OPTIONS` from `@/lib/appearance` (Task 1), existing `saveUserPreferences` (`apps/web/src/lib/userPreferences.ts` — already wraps `runAction`), existing `handleAppearanceChange` pattern (ThemingSettings.tsx:96–129).
- Produces: a user-visible Language fieldset that (a) applies the language immediately (optimistic, via `applyAppearancePreferences` → subscriber → `i18next.changeLanguage`), and (b) persists it server-side through the existing preferences PATCH.

- [ ] **Step 1: Write the failing test**

If `ThemingSettings.test.tsx` exists, extend it following its established mock setup; otherwise create it. Core assertions (adapt render/mocks to the file's conventions — it renders fieldsets of radio-style options):

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ThemingSettings from './ThemingSettings';

const saveUserPreferences = vi.fn().mockResolvedValue({ locale: 'pt-BR' });
vi.mock('../../lib/userPreferences', () => ({
  saveUserPreferences: (...args: unknown[]) => saveUserPreferences(...args),
}));

describe('ThemingSettings language fieldset', () => {
  beforeEach(() => {
    window.localStorage.clear();
    saveUserPreferences.mockClear();
  });

  it('renders both language options', () => {
    render(<ThemingSettings />);
    expect(screen.getByText('Language')).toBeInTheDocument();
    expect(screen.getByText('English')).toBeInTheDocument();
    expect(screen.getByText('Português (Brasil)')).toBeInTheDocument();
  });

  it('selecting Português persists locale pt-BR and applies it locally', async () => {
    render(<ThemingSettings />);
    await userEvent.click(screen.getByText('Português (Brasil)'));
    expect(saveUserPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ locale: 'pt-BR' }),
      expect.any(String)
    );
    expect(window.localStorage.getItem('breeze.locale')).toBe('pt-BR');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm vitest run src/components/settings/ThemingSettings.test.tsx`
Expected: FAIL — no "Language" fieldset rendered.

- [ ] **Step 3: Implement the fieldset**

In `ThemingSettings.tsx`:

1. Add imports:

```tsx
import { readResolvedLocalePreference, type LocalePreference } from '../../lib/appearance';
import '../../lib/i18n'; // side effect: initialize shared i18next instance
```

2. Add the options const next to `timeFormatOptions` (line 42):

```tsx
const localeOptions = [
  { value: 'en' as const, label: 'English', description: 'English (United States)' },
  { value: 'pt-BR' as const, label: 'Português (Brasil)', description: 'Portuguese (Brazil)' },
];
```

3. Add local state next to the other preference states:

```tsx
const [localePreference, setLocalePreference] = useState<LocalePreference>(() =>
  readResolvedLocalePreference()
);
```

4. Extend `handleAppearanceChange` (lines 96–129): widen the patch type to include `'locale'` and include it in `next` (the `Required<UserPreferences>` now demands it after Task 3's type change):

```tsx
const handleAppearanceChange = async (
  patch: Partial<Pick<Required<UserPreferences>, 'theme' | 'density' | 'font' | 'timeFormat' | 'locale'>>
) => {
  const next: Required<UserPreferences> = {
    theme: patch.theme ?? themePreference,
    // ...existing density/font/timeFormat lines unchanged...
    locale: patch.locale ?? localePreference,
  };
  // ...existing body unchanged: applyAppearancePreferences(next) already
  // switches the language optimistically via the locale subscriber...
```

and after the successful save (where the other `set*` calls resolve saved values), add:

```tsx
setLocalePreference(next.locale);
```

5. Render the fieldset after the Time Format fieldset, cloning its exact option-row markup with `localeOptions`, checked state `localePreference === option.value`, and `onChange={() => handleAppearanceChange({ locale: option.value })}`. Use the fieldset title `Language` and helper text `Language for the Breeze console.` (Keep these two strings hardcoded-English for now OR translate them via `t('settings.language.title')` — translating them is the nicer dogfood; the keys already exist in both locale files from Task 2.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && pnpm vitest run src/components/settings/ThemingSettings.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the settings suite + type check**

Run: `cd apps/web && pnpm vitest run src/components/settings && pnpm astro check 2>&1 | tail -5`
Expected: PASS / no new errors. (Task 3's `Required<UserPreferences>` change means any other `Required<UserPreferences>` construction sites must also be updated — `astro check` will find them; fix by adding `locale: readResolvedLocalePreference()` or widening as appropriate.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/settings/ThemingSettings.tsx apps/web/src/components/settings/ThemingSettings.test.tsx
git commit -m "feat(web): per-user language selector (English, Português) in theming settings"
```

---

### Task 5: Locale-aware date/number/currency formatting seams

**Files:**
- Modify: `apps/web/src/lib/dateTimeFormat.ts` (`splitFormatOptions`, line 66)
- Create: `apps/web/src/lib/i18n/format.ts`
- Test: `apps/web/src/lib/i18n/format.test.ts` (create); extend `dateTimeFormat`'s existing co-located test if present, else add cases to `format.test.ts`.

**Interfaces:**
- Consumes: `readLocalePreference` from `../appearance` (Task 1). **Deliberately `readLocalePreference` (explicit choice only), NOT `readResolvedLocalePreference`** — when the user has never chosen a language, `Intl` receives `undefined` and keeps using the browser locale, exactly as today. Zero behavior change for existing users.
- Produces (Phase-2 call sites will migrate onto these):
  - `formatNumber(value: number, options?: Intl.NumberFormatOptions): string`
  - `formatCurrency(value: number, currency?: string, options?: Intl.NumberFormatOptions): string` (default currency `'USD'`)
  - `formatPercent(value: number, options?: Intl.NumberFormatOptions): string` (value is a fraction: `0.42` → `42%`)
  - `formatDateTime`/`formatDate`/`formatTime` (existing) now honor the stored locale preference when the caller doesn't pass one.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/i18n/format.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { formatNumber, formatCurrency, formatPercent } from './format';
import { LOCALE_STORAGE_KEY } from '../appearance';
import { formatDate } from '../dateTimeFormat';

const NBSP = ' ';

describe('locale-aware number formatting', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('formats with pt-BR separators when the preference is set', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'pt-BR');
    expect(formatNumber(1234.5, { minimumFractionDigits: 2 })).toBe('1.234,50');
    expect(formatCurrency(1234.5, 'BRL')).toBe(`R$${NBSP}1.234,50`);
    expect(formatPercent(0.425, { maximumFractionDigits: 1 })).toBe('42,5%');
  });

  it('formats with en separators when the preference is en', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
    expect(formatNumber(1234.5, { minimumFractionDigits: 2 })).toBe('1,234.50');
    expect(formatCurrency(1234.5)).toBe('$1,234.50');
  });

  it('falls through to the runtime default locale when no preference is set', () => {
    // No stored preference: must not throw, must return a formatted string.
    expect(typeof formatNumber(1234.5)).toBe('string');
  });
});

describe('dateTimeFormat honors the stored locale', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('renders pt-BR date order when the preference is set', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'pt-BR');
    // 2026-03-09 → pt-BR is day-first
    expect(formatDate('2026-03-09T12:00:00Z', { timeZone: 'UTC' })).toBe('09/03/2026');
  });

  it('explicit locale option still wins', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'pt-BR');
    expect(formatDate('2026-03-09T12:00:00Z', { locale: 'en-US', timeZone: 'UTC' })).toBe('3/9/2026');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm vitest run src/lib/i18n/format.test.ts`
Expected: FAIL — `./format` does not exist; the pt-BR `formatDate` case fails (returns browser-locale format).

Note: if the exact pt-BR date string differs in your Node ICU (e.g. `09/03/2026` vs `9/3/2026`), adjust the expectation to the actual full-ICU output — pin what Node 22 full-icu actually emits, don't fight it.

- [ ] **Step 3: Implement `apps/web/src/lib/i18n/format.ts`**

```ts
// Locale-aware number formatting for the web console.
//
// Uses the user's explicit language preference when set; otherwise passes
// `undefined` to Intl so the browser locale applies (same behavior as the
// bare `toLocaleString()` calls these helpers replace). Phase 2 migrates
// scattered `.toFixed()` / hardcoded '$' call sites onto these helpers.
import { readLocalePreference } from '../appearance';

export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(readLocalePreference(), options).format(value);
}

export function formatCurrency(
  value: number,
  currency = 'USD',
  options: Intl.NumberFormatOptions = {}
): string {
  return new Intl.NumberFormat(readLocalePreference(), {
    style: 'currency',
    currency,
    ...options,
  }).format(value);
}

/** value is a fraction: 0.42 → "42%" */
export function formatPercent(value: number, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(readLocalePreference(), { style: 'percent', ...options }).format(value);
}
```

- [ ] **Step 4: Wire the stored locale into `dateTimeFormat.ts`**

In `apps/web/src/lib/dateTimeFormat.ts`, import `readLocalePreference` from `./appearance` and change `splitFormatOptions` (line 66):

```ts
function splitFormatOptions({ fallback, locale, timeFormat, ...intlOptions }: UserDateTimeFormatOptions) {
  return {
    fallback,
    locale: locale ?? readLocalePreference(),
    timeFormat: getEffectiveTimeFormat(timeFormat),
    intlOptions,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/web && pnpm vitest run src/lib/i18n/format.test.ts src/lib`
Expected: PASS, including all pre-existing `dateTimeFormat` tests (they don't set the locale key, so `readLocalePreference()` returns `undefined` and behavior is unchanged).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/i18n/format.ts apps/web/src/lib/i18n/format.test.ts apps/web/src/lib/dateTimeFormat.ts
git commit -m "feat(web): locale-aware number/currency/percent helpers + date format seam"
```

---

### Task 6: Seed surface — translated sidebar navigation

**Files:**
- Modify: `apps/web/src/components/layout/Sidebar.tsx` (832 lines — `topLevelNav` at 164–174, `NavSection`/`navSections` at 179+, plus the render sites for item names and section labels)
- Test: extend `apps/web/src/components/layout/Sidebar.nav.test.tsx` (existing structural nav test — `navSections` is exported for it)

**Interfaces:**
- Consumes: `useTranslation` from `react-i18next`, side-effect import of `@/lib/i18n` (Task 2), translation keys `nav.*` (Task 2 seed JSON).
- Produces: `NavItem` and `NavSection` gain an optional `labelKey?: string`; render sites use `t(labelKey, { defaultValue: name/label })`. Untranslated nested items (Security/Operations/etc. children) keep rendering their English `name` via the `defaultValue` fallback — they get keys in Phase 2.

- [ ] **Step 1: Write the failing test**

Add to `Sidebar.nav.test.tsx` (follow its existing render/mocks — it already mounts the sidebar for structural assertions):

```tsx
import { i18n } from '../../lib/i18n';

describe('sidebar i18n seed', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('renders pt-BR top-level labels when the language is pt-BR', async () => {
    await i18n.changeLanguage('pt-BR');
    renderSidebar(); // the file's existing helper
    expect(screen.getByText('Painel')).toBeInTheDocument();
    expect(screen.getByText('Dispositivos')).toBeInTheDocument();
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  });

  it('renders English labels by default', () => {
    renderSidebar();
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
  });

  it('every topLevelNav entry has a labelKey resolvable in both locales', () => {
    for (const item of topLevelNav) {   // export topLevelNav alongside navSections
      expect(item.labelKey, `missing labelKey for ${item.name}`).toBeTruthy();
      expect(i18n.t(item.labelKey!, { lng: 'pt-BR' })).not.toBe(item.labelKey);
      expect(i18n.t(item.labelKey!, { lng: 'en' })).toBe(item.name);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm vitest run src/components/layout/Sidebar.nav.test.tsx`
Expected: FAIL — 'Painel' not found; `labelKey` undefined.

- [ ] **Step 3: Implement**

In `Sidebar.tsx`:

1. Imports:

```tsx
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
```

2. Extend the types: add `labelKey?: string;` to `NavItem`, and to `NavSection` (line 179–184).

3. Add keys to `topLevelNav` (export it for the test, matching how `navSections` is exported):

```tsx
export const topLevelNav: NavItem[] = [
  { name: 'Dashboard', labelKey: 'nav.dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Devices', labelKey: 'nav.devices', href: '/devices', icon: Monitor, requiredPermission: { resource: 'devices', action: 'read' } },
  { name: 'Alerts', labelKey: 'nav.alerts', href: '/alerts', icon: Bell, requiredPermission: { resource: 'alerts', action: 'read' } },
  { name: 'Tickets', labelKey: 'nav.tickets', href: '/tickets', icon: Ticket, requiredPermission: { resource: 'tickets', action: 'read' } },
  { name: 'Incidents', labelKey: 'nav.incidents', href: '/incidents', icon: ShieldAlert, requiredPermission: { resource: 'alerts', action: 'read' } },
  { name: 'Remote Access', labelKey: 'nav.remoteAccess', href: '/remote', icon: Terminal, requiredPermission: { resource: 'remote', action: 'access' } },
  { name: 'Scripts', labelKey: 'nav.scripts', href: '/scripts', icon: FileCode, requiredPermission: { resource: 'scripts', action: 'read' } },
  { name: 'Patches', labelKey: 'nav.patches', href: '/patches', icon: Download, requiredPermission: { resource: 'devices', action: 'read' } },
  { name: 'Vulnerabilities', labelKey: 'nav.vulnerabilities', href: '/vulnerabilities', icon: Bug, requiredPermission: { resource: 'devices', action: 'read' } },
];
```

4. Add `labelKey` to the seven section headers in `navSections`: `'nav.sectionAiFleet'`, `'nav.sectionMonitoring'`, `'nav.sectionSecurity'`, `'nav.sectionOperations'`, `'nav.sectionBackup'`, `'nav.sectionReporting'`, `'nav.sectionSettings'`. Leave nested section items without `labelKey` (Phase 2).

5. In the component body add `const { t } = useTranslation();` and change every render site that outputs `item.name` or `section.label` as visible text to:

```tsx
{item.labelKey ? t(item.labelKey, { defaultValue: item.name }) : item.name}
```

```tsx
{section.labelKey ? t(section.labelKey, { defaultValue: section.label }) : section.label}
```

Sweep ALL render sites in the file (collapsed tooltips, aria-labels built from `name`, section headers, mobile variant if present) — grep within the file for `item.name` and `section.label` and convert each *visible-text* usage; leave `key={item.name}` React keys and any `data-testid` usage untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && pnpm vitest run src/components/layout`
Expected: PASS — new i18n cases plus all existing Sidebar suites (`nav`, `rbac`, `billing`, `featuregate`, `scrollpersist`, `staleness` — these assert structure via `name`/`href`, which are unchanged).

- [ ] **Step 5: Full web suite + type check**

Run: `cd apps/web && pnpm vitest run && pnpm astro check 2>&1 | tail -5`
Expected: PASS / no new errors.

- [ ] **Step 6: Live smoke check**

Bring up the worktree stack (use the `worktree-stack` skill if not already running) and verify in a browser:
1. Log in → Profile → Theming settings → select "Português (Brasil)".
2. Sidebar top-level items switch to Painel/Dispositivos/Alertas/… without reload.
3. Reload the page → still pt-BR (localStorage) — expect a brief English flash on SSR'd islands (accepted Phase-1 tradeoff).
4. Log in from a fresh browser profile with the same user → pt-BR applies after `fetchAndApplyPreferences` (server-persisted).
5. Switch back to English → everything reverts.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/layout/Sidebar.tsx apps/web/src/components/layout/Sidebar.nav.test.tsx
git commit -m "feat(web): translated sidebar navigation as pt-BR i18n seed surface"
```

---

## Self-Review Notes

- **Spec coverage:** framework (Task 2), locale system + persistence (Tasks 1, 3), selector UI (Task 4), formatting seams (Task 5), pt-BR seed + contributor docs (Tasks 2, 6). Partner default explicitly deferred.
- **Type consistency:** `LocalePreference` originates in `appearance.ts` (Task 1) and is imported everywhere else; `UserPreferences.locale` added in Task 3 before Task 4 constructs `Required<UserPreferences>`; `setLocale` defined in Task 2, consumed in Task 4 (indirectly via `handleAppearanceChange` → `applyAppearancePreferences`); `labelKey` defined and consumed within Task 6.
- **Task ordering:** strictly sequential — each task only consumes interfaces from earlier tasks.
- **Known judgment calls an implementer may hit:** exact pt-BR ICU output strings in Node (pin to actual output); other `Required<UserPreferences>` construction sites surfaced by `astro check` after Task 3 (add `locale`); `resolveJsonModule` may need enabling in `apps/web/tsconfig.json`.
