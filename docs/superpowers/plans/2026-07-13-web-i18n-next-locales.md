# Web i18n Next Locales Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add complete, selectable, persisted `es-419`, `fr-FR`, and `de-DE` translations to the Breeze web console.

**Architecture:** Extend the single shared `SupportedLocale` contract through web preference handling, API validation, and both language controls. Keep English eager and all non-English catalogs auto-discovered/lazy-loaded. After the shared contract is committed, build the three 21-file catalogs concurrently in isolated worktrees, one locale directory per worker, then integrate and verify them together.

**Tech Stack:** TypeScript, React, Astro, Hono, Zod, i18next/react-i18next, JSON locale namespaces, Vitest, pnpm.

## Global Constraints

- Locale identifiers are exactly `es-419`, `fr-FR`, and `de-DE`.
- Language labels are exactly `Español (Latinoamérica)`, `Français (France)`, and `Deutsch (Deutschland)`.
- `es-419` uses neutral Latin American Spanish; avoid `vosotros`, Spain-specific wording, and regional slang.
- `fr-FR` uses professional France French.
- `de-DE` uses professional Germany German and formal `Sie` forms when direct address is unavoidable.
- Preserve JSON keys, namespace filenames, interpolation identifiers inside `{{...}}`, `Trans` markup placeholders, product/vendor names, commands, paths, URLs, and API literals.
- Preserve established technical acronyms and terms when translation would reduce precision: RMM, MSP, SLA, API, PowerShell, SNMP, DNS, IP, and contextually `endpoint`.
- Do not translate `data-testid`, log messages, or API payload values.
- English remains the eager synchronous fallback; do not add locale-specific imports to `apps/web/src/lib/i18n/index.ts`.
- Each locale catalog is machine-drafted pending native review. Release/PR text must contain: `es-419, fr-FR, and de-DE strings are machine-drafted pending native review`.
- On Node 26, prefix Vitest commands with `NODE_OPTIONS=--no-experimental-webstorage` so jsdom owns `window.localStorage`.
- Translation workers may edit only their assigned `apps/web/src/locales/<locale>/` directory and must commit their catalog independently.

## File ownership map

**Shared contract owner:**

- `packages/shared/src/types/index.ts` — canonical `SupportedLocale` union.
- `apps/web/src/lib/appearance.ts` — supported client locale tuple, validation, normalization, and browser-language matching.
- `apps/web/src/components/settings/ThemingSettings.tsx` — per-user language cards.
- `apps/web/src/components/settings/PartnerRegionalTab.tsx` — partner-default language selector.
- `apps/web/src/locales/en/settings.json` — English labels/descriptions for all options.
- `apps/web/src/locales/pt-BR/settings.json` — Portuguese labels/descriptions for all options.
- `apps/api/src/routes/users.ts` — `/users/me` locale persistence and partner-default response filtering.
- `apps/api/src/routes/orgs.ts` — partner settings locale schema.
- `apps/web/src/lib/__tests__/localePreference.test.ts`, `apps/web/src/components/settings/ThemingSettings.test.tsx`, `apps/web/src/components/settings/PartnerSettingsPage.test.tsx`, `apps/api/src/routes/users.test.ts`, and `apps/api/src/routes/orgs.test.ts` — shared contract tests.

**Catalog workers:**

- Spanish worker owns only `apps/web/src/locales/es-419/*.json`.
- French worker owns only `apps/web/src/locales/fr-FR/*.json`.
- German worker owns only `apps/web/src/locales/de-DE/*.json`.

**Integration owner:**

- `apps/web/src/lib/i18n/localeParity.test.ts` — required-locale assertion.
- `apps/web/src/lib/i18n/translationCoverage.test.ts` — gross untranslated-copy guard.
- `apps/web/src/locales/README.md` — expanded locale and review instructions.

---

### Task 1: Extend the shared supported-locale contract

**Files:**

- Modify: `packages/shared/src/types/index.ts:15`
- Modify: `apps/web/src/lib/appearance.ts:15`
- Modify: `apps/web/src/lib/__tests__/localePreference.test.ts:27-62`
- Modify: `apps/web/src/components/settings/ThemingSettings.tsx:54-58`
- Modify: `apps/web/src/components/settings/ThemingSettings.test.tsx:52-58`
- Modify: `apps/web/src/components/settings/PartnerRegionalTab.tsx:108-113`
- Modify: `apps/web/src/components/settings/PartnerSettingsPage.test.tsx:152-199`
- Modify: `apps/web/src/locales/en/settings.json:2-9`
- Modify: `apps/web/src/locales/pt-BR/settings.json:2-9`
- Modify: `apps/api/src/routes/users.ts:494,619`
- Modify: `apps/api/src/routes/users.test.ts:824-878`
- Modify: `apps/api/src/routes/orgs.ts:355`
- Modify: `apps/api/src/routes/orgs.test.ts:2455-2507`

**Interfaces:**

- Produces: `SupportedLocale = 'en' | 'pt-BR' | 'es-419' | 'fr-FR' | 'de-DE'`.
- Produces: `LOCALE_OPTIONS = ['en', 'pt-BR', 'es-419', 'fr-FR', 'de-DE'] as const`.
- Consumed by: appearance persistence, the two UI controls, API schemas, i18n formatting, and Tasks 2-5.

- [ ] **Step 1: Write failing web preference and control assertions**

Change the exact-options test to:

```ts
it('exposes exactly the supported locales', () => {
  expect(LOCALE_OPTIONS).toEqual(['en', 'pt-BR', 'es-419', 'fr-FR', 'de-DE']);
});
```

Extend the validation test with:

```ts
for (const locale of ['en', 'pt-BR', 'es-419', 'fr-FR', 'de-DE']) {
  expect(isValidLocale(locale)).toBe(true);
  expect(normalizeLocale(locale)).toBe(locale);
}
expect(isValidLocale('fr')).toBe(false);
expect(isValidLocale('de-AT')).toBe(false);
```

Add browser-language cases proving the only supported regional target is selected:

```ts
it.each([
  ['es-MX', 'es-419'],
  ['fr-CA', 'fr-FR'],
  ['de-AT', 'de-DE'],
] as const)('maps browser locale %s to %s', (browserLocale, expected) => {
  vi.stubGlobal('navigator', { languages: [browserLocale], language: browserLocale });
  expect(detectBrowserLocale()).toBe(expected);
});
```

Update `ThemingSettings.test.tsx` to assert all five visible self-names, and update the partner selector assertion to:

```ts
expect(Array.from(languageSelect.options).map(option => option.value)).toEqual([
  'en', 'pt-BR', 'es-419', 'fr-FR', 'de-DE',
]);
```

- [ ] **Step 2: Write failing API acceptance assertions**

Change the invalid user-locale message expectation to:

```ts
expect(body.error).toBe(
  'Invalid locale value. Must be en, pt-BR, es-419, fr-FR, or de-DE.'
);
```

Table-drive the valid user preference request over the three new values, retaining the existing merge assertion:

```ts
it.each(['es-419', 'fr-FR', 'de-DE'] as const)(
  'accepts and merges the %s locale preference',
  async (locale) => {
    const existingPreferences = { theme: 'dark' };
    const mergedPreferences = { ...existingPreferences, locale };
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            email: 'test@example.com',
            passwordHash: 'hash',
            preferences: existingPreferences,
          }]),
        }),
      }),
    } as any);
    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{
          id: 'user-123',
          email: 'test@example.com',
          name: 'Test User',
          avatarUrl: null,
          status: 'active',
          mfaEnabled: false,
          preferences: mergedPreferences,
        }]),
      }),
    });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

    const res = await app.request('/users/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ preferences: { locale } }),
    });

    expect(res.status).toBe(200);
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({
      preferences: mergedPreferences,
    }));
    expect(await res.json()).toMatchObject({ preferences: { locale } });
  },
);
```

Replace the partner-default route case with this table-driven test:

```ts
it.each(['pt-BR', 'es-419', 'fr-FR', 'de-DE'] as const)(
  'accepts %s as the partner default language',
  async (language) => {
    setAuthContext({ scope: 'partner', partnerId: 'partner-123' });
    const currentPartner = { id: 'partner-123', name: 'Acme MSP', settings: {} };
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([currentPartner]),
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: 'org-1' }]),
            }),
          }),
        }),
      } as any);
    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            ...currentPartner,
            settings: { language },
          }]),
        }),
      }),
    } as any);

    const res = await app.request('/orgs/partners/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { language } }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ settings: { language } });
  },
);
```

- [ ] **Step 3: Run the focused tests and verify they fail**

Run:

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @breeze/web exec vitest run \
  src/lib/__tests__/localePreference.test.ts \
  src/components/settings/ThemingSettings.test.tsx \
  src/components/settings/PartnerSettingsPage.test.tsx
pnpm --filter @breeze/api exec vitest run src/routes/users.test.ts src/routes/orgs.test.ts
```

Expected: web assertions show only `en`/`pt-BR`; API requests for the new values return 400.

- [ ] **Step 4: Implement the canonical types and allowlists**

Use these exact values:

```ts
// packages/shared/src/types/index.ts
export type SupportedLocale = 'en' | 'pt-BR' | 'es-419' | 'fr-FR' | 'de-DE';

// apps/web/src/lib/appearance.ts
export const LOCALE_OPTIONS = ['en', 'pt-BR', 'es-419', 'fr-FR', 'de-DE'] as const;

// apps/api/src/routes/orgs.ts
const supportedLocales = ['en', 'pt-BR', 'es-419', 'fr-FR', 'de-DE'] as const
  satisfies readonly SupportedLocale[];
```

In `users.ts`, use the same five-value list both when filtering the authenticated partner default and in `validatePreferenceEnum`; use the label `en, pt-BR, es-419, fr-FR, or de-DE`.

- [ ] **Step 5: Implement both language controls and source catalog keys**

Append these objects to `localeOptions` in `ThemingSettings.tsx`:

```ts
{ value: 'es-419' as const, labelKey: 'language.es419Label', defaultLabel: 'Español (Latinoamérica)', descriptionKey: 'language.es419Description', defaultDescription: 'Spanish (Latin America)' },
{ value: 'fr-FR' as const, labelKey: 'language.frFRLabel', defaultLabel: 'Français (France)', descriptionKey: 'language.frFRDescription', defaultDescription: 'French (France)' },
{ value: 'de-DE' as const, labelKey: 'language.deDELabel', defaultLabel: 'Deutsch (Deutschland)', descriptionKey: 'language.deDEDescription', defaultDescription: 'German (Germany)' },
```

Add matching `<option>` elements to `PartnerRegionalTab.tsx`. Add the six keys below to English `settings.json`:

```json
"es419Label": "Español (Latinoamérica)",
"es419Description": "Spanish (Latin America)",
"frFRLabel": "Français (France)",
"frFRDescription": "French (France)",
"deDELabel": "Deutsch (Deutschland)",
"deDEDescription": "German (Germany)"
```

Add the same self-name labels and these Portuguese descriptions to `pt-BR/settings.json`: `Espanhol (América Latina)`, `Francês (França)`, and `Alemão (Alemanha)`.

- [ ] **Step 6: Run focused tests and type-check**

Run the Step 3 commands, then:

```bash
pnpm --filter @breeze/web exec astro check --minimumSeverity error
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
```

Expected: all focused tests pass and both type-checks exit 0.

- [ ] **Step 7: Commit the shared contract**

```bash
git add packages/shared/src/types/index.ts apps/web/src/lib/appearance.ts \
  apps/web/src/lib/__tests__/localePreference.test.ts \
  apps/web/src/components/settings/ThemingSettings.tsx \
  apps/web/src/components/settings/ThemingSettings.test.tsx \
  apps/web/src/components/settings/PartnerRegionalTab.tsx \
  apps/web/src/components/settings/PartnerSettingsPage.test.tsx \
  apps/web/src/locales/en/settings.json apps/web/src/locales/pt-BR/settings.json \
  apps/api/src/routes/users.ts apps/api/src/routes/users.test.ts \
  apps/api/src/routes/orgs.ts apps/api/src/routes/orgs.test.ts
git commit -m "feat(i18n): register Spanish French and German locales"
```

- [ ] **Step 8: Create isolated catalog worktrees at the shared-contract commit**

```bash
git worktree add /Users/toddhebebrand/breeze/.worktrees/web-i18n-es-419-catalog \
  -b feat/web-i18n-es-419-catalog HEAD
git worktree add /Users/toddhebebrand/breeze/.worktrees/web-i18n-fr-fr-catalog \
  -b feat/web-i18n-fr-fr-catalog HEAD
git worktree add /Users/toddhebebrand/breeze/.worktrees/web-i18n-de-de-catalog \
  -b feat/web-i18n-de-de-catalog HEAD
```

Expected: three clean worktrees, all starting at the Task 1 commit. Dispatch one translation worker to each path and enforce the directory ownership in Global Constraints.

---

### Task 2: Build the Latin American Spanish catalog

**Files:**

- Create: `apps/web/src/locales/es-419/admin.json`
- Create: `apps/web/src/locales/es-419/ai.json`
- Create: `apps/web/src/locales/es-419/alerts.json`
- Create: `apps/web/src/locales/es-419/auth.json`
- Create: `apps/web/src/locales/es-419/backup.json`
- Create: `apps/web/src/locales/es-419/billing.json`
- Create: `apps/web/src/locales/es-419/common.json`
- Create: `apps/web/src/locales/es-419/devices.json`
- Create: `apps/web/src/locales/es-419/discovery.json`
- Create: `apps/web/src/locales/es-419/integrations.json`
- Create: `apps/web/src/locales/es-419/patches.json`
- Create: `apps/web/src/locales/es-419/peripherals.json`
- Create: `apps/web/src/locales/es-419/policies.json`
- Create: `apps/web/src/locales/es-419/portal.json`
- Create: `apps/web/src/locales/es-419/remote.json`
- Create: `apps/web/src/locales/es-419/reports.json`
- Create: `apps/web/src/locales/es-419/scripts.json`
- Create: `apps/web/src/locales/es-419/security.json`
- Create: `apps/web/src/locales/es-419/settings.json`
- Create: `apps/web/src/locales/es-419/tickets.json`
- Create: `apps/web/src/locales/es-419/vulnerabilities.json`

**Interfaces:**

- Consumes: the exact English namespace filenames, key structure, and interpolation tokens.
- Produces: a complete lazy-loadable `es-419` i18next resource tree.

- [ ] **Step 1: Copy the complete English namespace set**

Create `apps/web/src/locales/es-419/` and copy all 21 English JSON namespace files. Confirm both directories list the same filenames:

```bash
diff -u \
  <(find apps/web/src/locales/en -maxdepth 1 -name '*.json' -exec basename {} \; | sort) \
  <(find apps/web/src/locales/es-419 -maxdepth 1 -name '*.json' -exec basename {} \; | sort)
```

Expected: no output.

- [ ] **Step 2: Translate every leaf value namespace-by-namespace**

Translate all user-visible string leaves into neutral Latin American Spanish. Use `ustedes`, `equipo`/`dispositivo` according to context, and `aplicar parches`. Keep all five `settings.language.*Label` values as language self-names. Do not change any key or interpolation token.

- [ ] **Step 3: Verify structure and interpolation**

Run:

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @breeze/web exec vitest run \
  src/lib/i18n/localeParity.test.ts
```

Expected: the dynamically generated `es-419 matches en...` and `es-419 preserves interpolation variables` cases pass.

- [ ] **Step 4: Verify the catalog is actually translated**

Run a leaf comparison against English:

```bash
node - <<'NODE'
const fs = require('fs');
const path = require('path');
const flatten = (obj, out = []) => {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') flatten(value, out);
    else out.push(String(value));
  }
  return out;
};
let same = 0, total = 0;
for (const file of fs.readdirSync('apps/web/src/locales/en').filter(f => f.endsWith('.json'))) {
  const en = flatten(JSON.parse(fs.readFileSync(path.join('apps/web/src/locales/en', file))));
  const target = flatten(JSON.parse(fs.readFileSync(path.join('apps/web/src/locales/es-419', file))));
  total += en.length;
  same += en.filter((value, index) => value === target[index]).length;
}
console.log({ same, total, exactDuplicateRatio: same / total });
if (same / total >= 0.20) process.exit(1);
NODE
```

Expected: `exactDuplicateRatio` is below `0.20`.

- [ ] **Step 5: Commit only the Spanish directory**

```bash
git add apps/web/src/locales/es-419
git commit -m "feat(i18n): add Latin American Spanish catalog"
```

---

### Task 3: Build the France French catalog

**Files:**

- Create: `apps/web/src/locales/fr-FR/admin.json`
- Create: `apps/web/src/locales/fr-FR/ai.json`
- Create: `apps/web/src/locales/fr-FR/alerts.json`
- Create: `apps/web/src/locales/fr-FR/auth.json`
- Create: `apps/web/src/locales/fr-FR/backup.json`
- Create: `apps/web/src/locales/fr-FR/billing.json`
- Create: `apps/web/src/locales/fr-FR/common.json`
- Create: `apps/web/src/locales/fr-FR/devices.json`
- Create: `apps/web/src/locales/fr-FR/discovery.json`
- Create: `apps/web/src/locales/fr-FR/integrations.json`
- Create: `apps/web/src/locales/fr-FR/patches.json`
- Create: `apps/web/src/locales/fr-FR/peripherals.json`
- Create: `apps/web/src/locales/fr-FR/policies.json`
- Create: `apps/web/src/locales/fr-FR/portal.json`
- Create: `apps/web/src/locales/fr-FR/remote.json`
- Create: `apps/web/src/locales/fr-FR/reports.json`
- Create: `apps/web/src/locales/fr-FR/scripts.json`
- Create: `apps/web/src/locales/fr-FR/security.json`
- Create: `apps/web/src/locales/fr-FR/settings.json`
- Create: `apps/web/src/locales/fr-FR/tickets.json`
- Create: `apps/web/src/locales/fr-FR/vulnerabilities.json`

**Interfaces:**

- Consumes: the exact English namespace filenames, key structure, and interpolation tokens.
- Produces: a complete lazy-loadable `fr-FR` i18next resource tree.

- [ ] **Step 1: Copy the complete English namespace set**

Create `apps/web/src/locales/fr-FR/`, copy all English JSON files, and run:

```bash
diff -u \
  <(find apps/web/src/locales/en -maxdepth 1 -name '*.json' -exec basename {} \; | sort) \
  <(find apps/web/src/locales/fr-FR -maxdepth 1 -name '*.json' -exec basename {} \; | sort)
```

Expected: no output.

- [ ] **Step 2: Translate every leaf value namespace-by-namespace**

Translate all user-visible values into concise professional France French. Prefer standard France enterprise-IT terminology, retain recognized acronyms and product-specific terms, and keep the five `settings.language.*Label` values as language self-names. Preserve all keys and interpolation tokens exactly.

- [ ] **Step 3: Verify structure and interpolation**

Run:

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @breeze/web exec vitest run \
  src/lib/i18n/localeParity.test.ts
```

Expected: the dynamically generated `fr-FR matches en...` and `fr-FR preserves interpolation variables` cases pass.

- [ ] **Step 4: Verify the catalog is actually translated**

Run this exact leaf comparison:

```bash
TARGET_LOCALE=fr-FR node - <<'NODE'
const fs = require('fs');
const path = require('path');
const locale = process.env.TARGET_LOCALE;
const flatten = (obj, out = []) => {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') flatten(value, out);
    else out.push(String(value));
  }
  return out;
};
let same = 0, total = 0;
for (const file of fs.readdirSync('apps/web/src/locales/en').filter(f => f.endsWith('.json'))) {
  const en = flatten(JSON.parse(fs.readFileSync(path.join('apps/web/src/locales/en', file))));
  const target = flatten(JSON.parse(fs.readFileSync(path.join('apps/web/src/locales', locale, file))));
  total += en.length;
  same += en.filter((value, index) => value === target[index]).length;
}
console.log({ locale, same, total, exactDuplicateRatio: same / total });
if (same / total >= 0.20) process.exit(1);
NODE
```

Expected: `exactDuplicateRatio` is below `0.20`.

- [ ] **Step 5: Commit only the French directory**

```bash
git add apps/web/src/locales/fr-FR
git commit -m "feat(i18n): add France French catalog"
```

---

### Task 4: Build the Germany German catalog

**Files:**

- Create: `apps/web/src/locales/de-DE/admin.json`
- Create: `apps/web/src/locales/de-DE/ai.json`
- Create: `apps/web/src/locales/de-DE/alerts.json`
- Create: `apps/web/src/locales/de-DE/auth.json`
- Create: `apps/web/src/locales/de-DE/backup.json`
- Create: `apps/web/src/locales/de-DE/billing.json`
- Create: `apps/web/src/locales/de-DE/common.json`
- Create: `apps/web/src/locales/de-DE/devices.json`
- Create: `apps/web/src/locales/de-DE/discovery.json`
- Create: `apps/web/src/locales/de-DE/integrations.json`
- Create: `apps/web/src/locales/de-DE/patches.json`
- Create: `apps/web/src/locales/de-DE/peripherals.json`
- Create: `apps/web/src/locales/de-DE/policies.json`
- Create: `apps/web/src/locales/de-DE/portal.json`
- Create: `apps/web/src/locales/de-DE/remote.json`
- Create: `apps/web/src/locales/de-DE/reports.json`
- Create: `apps/web/src/locales/de-DE/scripts.json`
- Create: `apps/web/src/locales/de-DE/security.json`
- Create: `apps/web/src/locales/de-DE/settings.json`
- Create: `apps/web/src/locales/de-DE/tickets.json`
- Create: `apps/web/src/locales/de-DE/vulnerabilities.json`

**Interfaces:**

- Consumes: the exact English namespace filenames, key structure, and interpolation tokens.
- Produces: a complete lazy-loadable `de-DE` i18next resource tree.

- [ ] **Step 1: Copy the complete English namespace set**

Create `apps/web/src/locales/de-DE/`, copy all English JSON files, and run:

```bash
diff -u \
  <(find apps/web/src/locales/en -maxdepth 1 -name '*.json' -exec basename {} \; | sort) \
  <(find apps/web/src/locales/de-DE -maxdepth 1 -name '*.json' -exec basename {} \; | sort)
```

Expected: no output.

- [ ] **Step 2: Translate every leaf value namespace-by-namespace**

Translate all user-visible values into professional Germany German. Use impersonal UI phrasing where possible and formal `Sie` consistently where direct address is required. Preserve established enterprise-IT English terms when they are the recognized German term. Keep the five `settings.language.*Label` values as language self-names and preserve all keys/interpolation tokens.

- [ ] **Step 3: Verify structure and interpolation**

Run:

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @breeze/web exec vitest run \
  src/lib/i18n/localeParity.test.ts
```

Expected: the dynamically generated `de-DE matches en...` and `de-DE preserves interpolation variables` cases pass.

- [ ] **Step 4: Verify the catalog is actually translated**

Run this exact leaf comparison:

```bash
TARGET_LOCALE=de-DE node - <<'NODE'
const fs = require('fs');
const path = require('path');
const locale = process.env.TARGET_LOCALE;
const flatten = (obj, out = []) => {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') flatten(value, out);
    else out.push(String(value));
  }
  return out;
};
let same = 0, total = 0;
for (const file of fs.readdirSync('apps/web/src/locales/en').filter(f => f.endsWith('.json'))) {
  const en = flatten(JSON.parse(fs.readFileSync(path.join('apps/web/src/locales/en', file))));
  const target = flatten(JSON.parse(fs.readFileSync(path.join('apps/web/src/locales', locale, file))));
  total += en.length;
  same += en.filter((value, index) => value === target[index]).length;
}
console.log({ locale, same, total, exactDuplicateRatio: same / total });
if (same / total >= 0.20) process.exit(1);
NODE
```

Expected: `exactDuplicateRatio` is below `0.20`.

- [ ] **Step 5: Commit only the German directory**

```bash
git add apps/web/src/locales/de-DE
git commit -m "feat(i18n): add Germany German catalog"
```

---

### Task 5: Integrate catalogs and add release-quality guards

**Files:**

- Add: `apps/web/src/locales/es-419/*.json` from branch `feat/web-i18n-es-419-catalog`
- Add: `apps/web/src/locales/fr-FR/*.json` from branch `feat/web-i18n-fr-fr-catalog`
- Add: `apps/web/src/locales/de-DE/*.json` from branch `feat/web-i18n-de-de-catalog`
- Modify: `apps/web/src/lib/i18n/localeParity.test.ts:70-72`
- Create: `apps/web/src/lib/i18n/translationCoverage.test.ts`
- Modify: `apps/web/src/locales/README.md`

**Interfaces:**

- Consumes: the three catalog commits and the shared five-locale contract.
- Produces: enforced presence, key and string-leaf parity, interpolation/rich-text-tag safety, source-aligned technical literal protection for the three new catalogs, and both global and per-namespace untranslated-copy caps.

- [ ] **Step 1: Integrate the three independent catalog commits**

Confirm each branch tip modifies only its assigned locale directory, then cherry-pick all three:

```bash
git show --name-only --format='' feat/web-i18n-es-419-catalog | sed '/^$/d'
git show --name-only --format='' feat/web-i18n-fr-fr-catalog | sed '/^$/d'
git show --name-only --format='' feat/web-i18n-de-de-catalog | sed '/^$/d'
git cherry-pick feat/web-i18n-es-419-catalog
git cherry-pick feat/web-i18n-fr-fr-catalog
git cherry-pick feat/web-i18n-de-de-catalog
```

Expected: every listed path begins with that worker's assigned locale directory.

- [ ] **Step 2: Require every shipped locale**

Change the presence test in `localeParity.test.ts` to:

```ts
it('contains every supported locale catalog', () => {
  expect(locales).toEqual(
    expect.arrayContaining(['en', 'pt-BR', 'es-419', 'fr-FR', 'de-DE'])
  );
});
```

- [ ] **Step 3: Add untranslated-copy guards**

Create `translationCoverage.test.ts` with a recursive string flattener keyed by JSON path. For each of `pt-BR`, `es-419`, `fr-FR`, and `de-DE`, compare values with the corresponding English key and assert the overall exact-duplicate ratio is below 20%. Check in reviewed per-locale/per-namespace exact-English duplicate baselines as caps so one namespace cannot regress wholesale while the global ratio still passes:

```ts
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = join(dirname(fileURLToPath(import.meta.url)), '../../locales');
const translatedLocales = ['pt-BR', 'es-419', 'fr-FR', 'de-DE'] as const;

function flatten(obj: Record<string, unknown>, prefix = '', out = new Map<string, string>()) {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object') {
      flatten(value as Record<string, unknown>, path, out);
    } else {
      out.set(path, String(value));
    }
  }
  return out;
}

function readLocale(locale: string) {
  const result = new Map<string, string>();
  for (const file of readdirSync(join(localesDir, locale)).filter(f => f.endsWith('.json'))) {
    for (const [key, value] of flatten(
      JSON.parse(readFileSync(join(localesDir, locale, file), 'utf8'))
    )) {
      result.set(`${file}:${key}`, value);
    }
  }
  return result;
}

describe('translation coverage', () => {
  const english = readLocale('en');
  for (const locale of translatedLocales) {
    it(`${locale} is not an English catalog copy`, () => {
      const translated = readLocale(locale);
      const duplicates = [...english].filter(([key, value]) => translated.get(key) === value);
      expect(duplicates.length / english.size, duplicates.slice(0, 25).map(([key]) => key).join('\n'))
        .toBeLessThan(0.20);
    });
  }
});
```

- [ ] **Step 4: Expand contributor documentation**

Update `apps/web/src/locales/README.md` so its review-flag section names all machine-drafted catalogs and contains the exact required three-locale review sentence from Global Constraints. Retain the existing Portuguese note for historical extraction PRs. Add one sentence that language labels are self-names while descriptions are translated into the active UI language.

- [ ] **Step 5: Run catalog quality tests**

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @breeze/web exec vitest run \
  src/lib/i18n/localeParity.test.ts \
  src/lib/i18n/translationCoverage.test.ts \
  src/lib/i18n/extractionQuality.test.ts \
  src/lib/i18n/keyUsage.test.ts
```

Expected: all required catalogs exist; namespace/key/string-leaf/interpolation/rich-text/protected-literal checks pass; every non-English duplicate ratio is below 20%; and no namespace exceeds its reviewed exact-English duplicate baseline.

- [ ] **Step 6: Review high-risk operational namespaces**

For each new locale, inspect these exact files for destructive-action clarity, negation, severity, and terminology consistency:

```text
auth.json
backup.json
billing.json
remote.json
security.json
settings.json
```

Search exact English duplicates and review every hit rather than automatically translating product names or commands:

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @breeze/web exec vitest run \
  src/lib/i18n/translationCoverage.test.ts
```

Use the Vitest failure diagnostic if the threshold fails. For a passing catalog, run this read-only residue report and inspect every printed value before accepting it:

```bash
TARGET_LOCALE=es-419 node - <<'NODE'
const fs = require('fs');
const path = require('path');
const locale = process.env.TARGET_LOCALE;
const flatten = (obj, prefix = '', out = new Map()) => {
  for (const [key, value] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') flatten(value, next, out);
    else out.set(next, String(value));
  }
  return out;
};
for (const file of fs.readdirSync('apps/web/src/locales/en').filter(f => f.endsWith('.json'))) {
  const en = flatten(JSON.parse(fs.readFileSync(path.join('apps/web/src/locales/en', file))));
  const target = flatten(JSON.parse(fs.readFileSync(path.join('apps/web/src/locales', locale, file))));
  for (const [key, value] of en) if (target.get(key) === value) console.log(`${file}:${key}\t${value}`);
}
NODE
```

Repeat with `TARGET_LOCALE=fr-FR` and `TARGET_LOCALE=de-DE`. Do not weaken parity/interpolation checks to accommodate a translation mistake.

- [ ] **Step 7: Commit integration guards and documentation**

```bash
git add apps/web/src/lib/i18n/localeParity.test.ts \
  apps/web/src/lib/i18n/translationCoverage.test.ts \
  apps/web/src/locales/README.md
git commit -m "test(i18n): enforce complete translated locale catalogs"
```

---

### Task 6: Run integrated verification

**Files:** No production files should change in this task. Any failure is fixed in the owning task's files and committed separately.

**Interfaces:** Consumes the complete five-locale build and produces release evidence.

- [ ] **Step 1: Run all i18n and locale-control web tests**

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @breeze/web exec vitest run \
  src/lib/i18n \
  src/lib/__tests__/localePreference.test.ts \
  src/components/settings/ThemingSettings.test.tsx \
  src/components/settings/PartnerSettingsPage.test.tsx \
  src/stores/auth.test.ts
```

Expected: all files and tests pass.

- [ ] **Step 2: Run API locale tests**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/users.test.ts src/routes/orgs.test.ts
```

Expected: both route suites pass, including new locale persistence and rejection cases.

- [ ] **Step 3: Run type-checks**

```bash
pnpm --filter @breeze/web exec astro check --minimumSeverity error
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
```

Expected: both commands exit 0.

- [ ] **Step 4: Verify the production web build**

```bash
pnpm --filter @breeze/web build
```

Expected: Astro completes successfully and emits lazy chunks for the three new locale catalogs without adding them to the eager English bundle.

- [ ] **Step 5: Inspect final scope**

```bash
git status --short
git diff origin/main...HEAD --stat
git diff --check origin/main...HEAD
```

Expected: only the approved shared locale plumbing, three locale directories, tests, locale documentation, design, and plan are present; `git diff --check` emits no errors.

- [ ] **Step 6: Record the machine-draft status in handoff**

Include this exact sentence in the final handoff and any PR description:

```text
es-419, fr-FR, and de-DE strings are machine-drafted pending native review
```
