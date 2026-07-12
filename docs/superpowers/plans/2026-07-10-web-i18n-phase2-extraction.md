# Web Console i18n Phase-2: Full String Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks 6+ (extraction waves) are designed for a parallel subagent fleet, one wave per branch/PR.

**Goal:** Take the web console from "i18n framework + sidebar seed" (Phase 1, shipped) to "every user-facing surface translatable, high-traffic surfaces fully translated in pt-BR", with machinery that keeps translations healthy as the app grows.

**Architecture:** Per-domain translation namespaces (`apps/web/src/locales/<locale>/<namespace>.json`) auto-registered via `import.meta.glob` — English eagerly bundled (sync first render + fallback), other locales lazy-loaded on demand so island bundles stay lean as key counts grow from ~100 to thousands. Two enforcement tests keep the system honest: a cross-locale key-parity test and a static key-usage test (every literal `t('...')` key must exist in `en`). Extraction proceeds in prioritized waves (portal/auth/shell first, settings/long-tail last), each wave an independently shippable PR following a fixed playbook.

**Tech Stack:** i18next + react-i18next (already installed, Phase 1), Vite `import.meta.glob`, Vitest + jsdom, existing `formatNumber`/`formatCurrency`/`formatPercent` helpers (`apps/web/src/lib/i18n/format.ts`, Phase 1).

## Global Constraints

- Node pinned to v22.20.0; pnpm workspace; this worktree (`web-i18n-phase1`) already has `node_modules`.
- Supported locales: exactly `['en', 'pt-BR']` (`LOCALE_OPTIONS` in `apps/web/src/lib/appearance.ts`; API allowlists in `users.ts` and `orgs.ts` must stay in sync).
- Translation keys are structured (`area.thing`, camelCase leaves), one namespace per component file (checkable convention); cross-namespace references use explicit `ns:key` syntax (e.g. `t('common:actions.save')`).
- Never translate: `data-testid` values (e2e contract), React `key=` props, structural fields consumed by tests (`NavItem.name`, `href`), log messages, API payload/request values, permission/resource identifiers, CSV/export column separators.
- pt-BR translations written during extraction are **machine-drafted**: every wave PR description must carry the line `pt-BR strings are machine-drafted pending native review` so community reviewers (mazarine) know what to check.
- Strict CSP: locale JSON stays bundled (static or dynamic import chunks); never fetched cross-origin.
- SSR still renders English; hydrated islands re-render in the resolved locale. Cookie-based SSR locale remains out of scope (Phase 3 candidate). `.astro` page shells (titles/meta) stay English for the same reason — do NOT wrap `.astro` template strings in `t()`.
- API-originated strings (~3,400 error/message literals), emails, and PDF reports are out of scope (Phase 3/4).
- Web mutations keep riding `runAction`/`saveUserPreferences` — extraction never changes behavior, only display strings.

## Prioritization rationale (why waves are ordered this way)

pt-BR demand (issue requester) is MSP techs **and their end-clients**. End-clients only ever see the portal, login, and shared shell — so `portal/`, `auth/`, `layout/`, `dashboard/` go first despite being small. `devices/` is the core tech surface (58 files / 26k lines) and goes second. `settings/` is huge (76 files) but partner-admin-only, so it comes after the daily-driver surfaces.

---

### Task 1: Verify and commit the in-flight partner-default-locale work

The worktree contains ~658 uncommitted lines implementing partner default language (resolution order: user choice → partner default → browser), the enabled partner Language selector, `/users/me` returning `partnerDefaultLocale`, and the complete sidebar nav key set. It was written in a prior session and never verified.

**Files (already modified, verify + commit only):**
- `apps/api/src/routes/orgs.ts`, `orgs.test.ts` — `partnerSettingsSchema.language` widened to `z.enum(['en', 'pt-BR'])`
- `apps/api/src/routes/users.ts`, `users.test.ts` — `/users/me` returns `partnerDefaultLocale` derived from the authenticated partner's settings
- `apps/web/src/lib/appearance.ts`, `__tests__/localePreference.test.ts` — `PARTNER_LOCALE_STORAGE_KEY`, `readPartnerLocalePreference`, `applyResolvedLocalePreferences` (clears a previous account's cached choice — cross-account leakage guard)
- `apps/web/src/components/settings/PartnerRegionalTab.tsx`, `PartnerSettingsPage.tsx`, `PartnerSettingsPage.test.tsx` — working Language selector
- `apps/web/src/components/layout/Sidebar.tsx`, `Sidebar.nav.test.tsx`, `apps/web/src/locales/*/common.json` — labelKeys for all nested nav items

**Interfaces:**
- Consumes: Phase-1 primitives (`LocalePreference`, `subscribeLocale`, i18n runtime).
- Produces: `applyResolvedLocalePreferences(userLocale, partnerLocale)` and `readPartnerLocalePreference()` in `appearance.ts`; `/users/me` response field `partnerDefaultLocale: 'en' | 'pt-BR' | null`. Later tasks treat locale resolution as settled.

- [x] **Step 1: Confirm the client applies `partnerDefaultLocale` on login/refresh**

Check the wiring end (this is the one piece the diff may have missed):

Run: `grep -rn "applyResolvedLocalePreferences\|partnerDefaultLocale" apps/web/src/stores/auth.ts apps/web/src/components --include='*.tsx' --include='*.ts' | grep -v test`

Expected: a call site in `apps/web/src/stores/auth.ts` (`fetchAndApplyPreferences` or the `/users/me` handler) passing `data.preferences?.locale` and `data.partnerDefaultLocale`. If absent, add it inside `fetchAndApplyPreferences` (auth.ts ~line 878), right after the existing `applyAppearancePreferences` call:

```ts
applyResolvedLocalePreferences(data.preferences?.locale, data.partnerDefaultLocale);
```

(and import `applyResolvedLocalePreferences` from `../lib/appearance`).

- [x] **Step 2: Run every touched suite**

```bash
cd apps/api && pnpm vitest run src/routes/users.test.ts src/routes/orgs.test.ts
cd ../web && pnpm vitest run src/lib src/components/settings src/components/layout
```

Expected: PASS. If anything fails, fix before committing — this diff has never been verified.

- [x] **Step 3: Type check**

Run: `cd apps/web && pnpm astro check 2>&1 | tail -5`
Expected: no new errors.

- [x] **Step 4: Commit**

```bash
git add apps/api/src/routes/orgs.ts apps/api/src/routes/orgs.test.ts \
        apps/api/src/routes/users.ts apps/api/src/routes/users.test.ts \
        apps/web/src/lib/appearance.ts apps/web/src/lib/__tests__/localePreference.test.ts \
        apps/web/src/components/settings/PartnerRegionalTab.tsx \
        apps/web/src/components/settings/PartnerSettingsPage.tsx \
        apps/web/src/components/settings/PartnerSettingsPage.test.tsx \
        apps/web/src/components/layout/Sidebar.tsx \
        apps/web/src/components/layout/Sidebar.nav.test.tsx \
        apps/web/src/locales/en/common.json apps/web/src/locales/pt-BR/common.json \
        apps/web/src/stores/auth.ts
git commit -m "feat: partner default locale with user-choice precedence + full nav translations"
```

---

### Task 2: Namespace scaffolding with lazy locale loading

Today `apps/web/src/lib/i18n/index.ts` statically imports two `common.json` files. Thousands of keys × N locales in every island bundle won't scale. Restructure: per-domain namespace files, `en` eager, other locales lazy.

**Files:**
- Modify: `apps/web/src/lib/i18n/index.ts` (full rewrite below)
- Modify: `apps/web/src/lib/i18n/i18n.test.ts` (async language switches)
- Create: `apps/web/src/locales/en/settings.json`, `apps/web/src/locales/pt-BR/settings.json` (migrate the existing `settings.*` and `partnerSettings.*` trees out of `common.json`)
- Modify: `apps/web/src/locales/en/common.json`, `apps/web/src/locales/pt-BR/common.json` (remove migrated trees; `nav.*` stays — the sidebar renders on every page)
- Modify: call sites of migrated keys: `apps/web/src/components/settings/ThemingSettings.tsx`, `PartnerRegionalTab.tsx` (switch to `useTranslation('settings')`)
- Modify: `apps/web/src/locales/README.md` (namespace conventions)

**Interfaces:**
- Consumes: Phase-1 `subscribeLocale`, `readResolvedLocalePreference`, `writeLocalePreference`.
- Produces (all later tasks rely on):
  - Any file at `apps/web/src/locales/<locale>/<ns>.json` is auto-registered — adding a namespace requires **zero** registration code.
  - `loadLocale(locale: LocalePreference): Promise<void>` — idempotent lazy loader (exported for tests).
  - `setLocale(locale: LocalePreference): void` — unchanged signature; switching to a non-English locale is now async under the hood (loads chunks, then `changeLanguage`).
  - Convention: component files declare `useTranslation('<ns>')` once; shared vocabulary via `t('common:actions.save')`.

- [x] **Step 1: Write the failing test**

Replace the language-switch cases in `apps/web/src/lib/i18n/i18n.test.ts` (keep the parity test — Task 3 generalizes it):

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { i18n, setLocale, loadLocale } from './index';
import { LOCALE_STORAGE_KEY } from '../appearance';

describe('i18n runtime (namespaced, lazy locales)', () => {
  beforeEach(async () => {
    window.localStorage.clear();
    await i18n.changeLanguage('en');
  });

  it('initializes synchronously with English', () => {
    expect(i18n.isInitialized).toBe(true);
    expect(i18n.t('nav.dashboard')).toBe('Dashboard');
  });

  it('auto-registers every en namespace file', () => {
    // settings.json created in this task; common.json pre-existing
    expect(i18n.hasResourceBundle('en', 'common')).toBe(true);
    expect(i18n.hasResourceBundle('en', 'settings')).toBe(true);
  });

  it('lazy-loads pt-BR and translates after setLocale', async () => {
    setLocale('pt-BR');
    await loadLocale('pt-BR'); // idempotent await for test determinism
    await vi.waitFor(() => expect(i18n.language).toBe('pt-BR'));
    expect(i18n.t('nav.dashboard')).toBe('Painel');
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('pt-BR');
  });

  it('resolves cross-namespace keys with explicit ns prefix', async () => {
    await loadLocale('pt-BR');
    await i18n.changeLanguage('pt-BR');
    expect(i18n.t('settings:language.title')).toBe('Idioma');
  });
});
```

(add `vi` to the vitest import)

- [x] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm vitest run src/lib/i18n/i18n.test.ts`
Expected: FAIL — `loadLocale` not exported; `settings` bundle missing.

- [x] **Step 3: Migrate the settings keys**

Create `apps/web/src/locales/en/settings.json` containing the current `settings` and `partnerSettings` subtrees from `en/common.json` **hoisted one level** (the file name is the namespace):

```json
{
  "language": { "...": "move the whole settings.language subtree here verbatim" },
  "partner": { "...": "move the whole partnerSettings subtree here, renamed to partner.*" }
}
```

Do the same for `pt-BR/settings.json` from `pt-BR/common.json`. Delete both subtrees from the two `common.json` files (keep `nav`). Update the two call-site components: `ThemingSettings.tsx` and `PartnerRegionalTab.tsx` use `const { t } = useTranslation('settings')` and drop the `settings.`/`partnerSettings.` prefixes (`t('language.title')`, `t('partner.…')`).

- [x] **Step 4: Rewrite `apps/web/src/lib/i18n/index.ts`**

```ts
// Shared i18next instance for all React islands.
//
// Namespaces are auto-registered from apps/web/src/locales/<locale>/<ns>.json:
// English is bundled eagerly (synchronous first render + fallback language);
// every other locale is code-split and loaded on demand, so adding thousands
// of keys does not grow the common island bundle for English users.
//
// SSR intentionally renders English; the resolved client locale applies during
// hydration. Cookie-based SSR locale selection is deferred beyond Phase 2.
import i18next, { type Resource } from 'i18next';
import { initReactI18next } from 'react-i18next';
import {
  readResolvedLocalePreference,
  subscribeLocale,
  writeLocalePreference,
  type LocalePreference,
} from '../appearance';

const eagerEnglish = import.meta.glob('../../locales/en/*.json', { eager: true });
const lazyLocales = import.meta.glob('../../locales/*/*.json');

function parseLocalePath(path: string): { locale: string; ns: string } | null {
  const match = path.match(/locales\/([^/]+)\/([^/]+)\.json$/);
  return match ? { locale: match[1], ns: match[2] } : null;
}

const resources: Resource = { en: {} };
for (const [path, mod] of Object.entries(eagerEnglish)) {
  const parsed = parseLocalePath(path);
  if (!parsed) continue;
  (resources.en as Record<string, unknown>)[parsed.ns] = (mod as { default: unknown }).default;
}

const loadedLocales = new Set<string>(['en']);

/** Idempotently load a locale's namespace chunks into i18next. */
export async function loadLocale(locale: LocalePreference): Promise<void> {
  if (loadedLocales.has(locale)) return;
  const entries = Object.entries(lazyLocales).filter(
    ([path]) => parseLocalePath(path)?.locale === locale
  );
  await Promise.all(
    entries.map(async ([path, loader]) => {
      const parsed = parseLocalePath(path);
      if (!parsed) return;
      const mod = (await loader()) as { default: Record<string, unknown> };
      i18next.addResourceBundle(locale, parsed.ns, mod.default, true, true);
    })
  );
  loadedLocales.add(locale);
}

function applyLocale(locale: LocalePreference): void {
  void loadLocale(locale).then(() => i18next.changeLanguage(locale));
}

if (!i18next.isInitialized) {
  void i18next.use(initReactI18next).init({
    resources,
    lng: 'en',
    fallbackLng: 'en',
    defaultNS: 'common',
    interpolation: { escapeValue: false },
    // Bundled English initializes synchronously for the first render.
    initAsync: false,
    returnNull: false,
  });

  if (typeof window !== 'undefined') {
    const resolved = readResolvedLocalePreference();
    if (resolved !== 'en') applyLocale(resolved);
  }
  subscribeLocale(applyLocale);
}

export const i18n = i18next;

/** Persist the console language; the appearance subscriber switches i18next. */
export function setLocale(locale: LocalePreference): void {
  writeLocalePreference(locale);
}
```

- [x] **Step 5: Run tests to verify they pass**

Run: `cd apps/web && pnpm vitest run src/lib/i18n src/components/settings src/components/layout src/lib`
Expected: PASS — including the Sidebar and settings suites against the migrated keys. If a settings test asserts on the old `settings.` key strings, update it with the new namespace-relative keys.

- [x] **Step 6: Type check + build smoke**

Run: `cd apps/web && pnpm astro check 2>&1 | tail -5 && pnpm build 2>&1 | tail -15`
Expected: no new type errors; build output shows pt-BR JSON emitted as separate chunks (grep the build log for `pt-BR`), confirming English bundles don't carry them.

- [x] **Step 7: Update `apps/web/src/locales/README.md`**

Replace the "Adding a string" / "Adding a locale" sections to reflect: namespace-per-domain files, auto-registration (no index.ts edits), one `useTranslation('<ns>')` per component file, `common:` prefix for shared vocabulary, and the machine-draft review flag for PR descriptions.

- [x] **Step 8: Commit**

```bash
git add apps/web/src/lib/i18n apps/web/src/locales apps/web/src/components/settings/ThemingSettings.tsx apps/web/src/components/settings/PartnerRegionalTab.tsx
git commit -m "feat(web): per-domain i18n namespaces with lazy non-English locale loading"
```

---

### Task 3: Enforcement — key parity across locales + static key-usage check

Two tests that make 900-file extraction safe to crowdsource: (1) every locale has exactly the `en` key set, per namespace; (2) every literal `t('...')` key in source resolves in `en`.

**Files:**
- Create: `apps/web/src/lib/i18n/localeParity.test.ts` (generalizes + replaces the single-file parity case in `i18n.test.ts`)
- Create: `apps/web/src/lib/i18n/keyUsage.test.ts`

**Interfaces:**
- Consumes: the `apps/web/src/locales/` directory layout from Task 2.
- Produces: red CI whenever (a) a wave adds an `en` key without its pt-BR sibling or vice versa, (b) a `t()` call references a nonexistent key, (c) a file uses keys from a namespace it didn't declare. Waves 1–7 rely on these as their safety net.

- [x] **Step 1: Write `localeParity.test.ts`** (fails only when locales drift — write it, then verify it passes now and fails when you temporarily delete a pt-BR key)

```ts
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = join(dirname(fileURLToPath(import.meta.url)), '../../locales');

function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value !== null && typeof value === 'object'
      ? flattenKeys(value as Record<string, unknown>, path)
      : [path];
  });
}

function readNamespaces(locale: string): Map<string, string[]> {
  const dir = join(localesDir, locale);
  return new Map(
    readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => [f, flattenKeys(JSON.parse(readFileSync(join(dir, f), 'utf8'))).sort()])
  );
}

describe('locale parity', () => {
  const locales = readdirSync(localesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const reference = readNamespaces('en');

  it('has at least en and pt-BR', () => {
    expect(locales).toEqual(expect.arrayContaining(['en', 'pt-BR']));
  });

  for (const locale of locales.filter((l) => l !== 'en')) {
    it(`${locale} matches en namespace files and keys exactly`, () => {
      const target = readNamespaces(locale);
      expect([...target.keys()].sort()).toEqual([...reference.keys()].sort());
      for (const [ns, keys] of reference) {
        expect(target.get(ns), `namespace ${ns}`).toEqual(keys);
      }
    });
  }
});
```

Remove the now-redundant parity case from `i18n.test.ts`.

- [x] **Step 2: Write `keyUsage.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { i18n } from './index';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '../..');

// Dynamic keys (t(variable)) can't be checked statically; files using them add
// an explicit marker comment on the line: // i18n-dynamic
const T_CALL = /(?<![\w.])t\(\s*['"]([\w][\w.:-]*)['"]/g;
const USE_TRANSLATION = /useTranslation\(\s*['"]([\w-]+)['"]\s*\)/;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== 'node_modules' && entry !== '__mocks__') yield* walk(path);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      yield path;
    }
  }
}

describe('translation key usage', () => {
  it('every literal t() key resolves in en', () => {
    const problems: string[] = [];
    for (const file of walk(srcDir)) {
      const source = readFileSync(file, 'utf8');
      const fileNs = source.match(USE_TRANSLATION)?.[1] ?? 'common';
      for (const line of source.split('\n')) {
        if (line.includes('i18n-dynamic')) continue;
        for (const match of line.matchAll(T_CALL)) {
          const raw = match[1];
          const [ns, key] = raw.includes(':') ? raw.split(':', 2) : [fileNs, raw];
          if (!i18n.exists(key, { ns, lng: 'en' })) {
            problems.push(`${file.replace(srcDir, 'src')}: t('${raw}') → missing en ${ns}:${key}`);
          }
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
});
```

- [x] **Step 3: Run both, verify green, then verify they actually bite**

Run: `cd apps/web && pnpm vitest run src/lib/i18n`
Expected: PASS.

Then temporarily (a) delete one key from `pt-BR/common.json` → parity test FAILS naming the namespace; (b) change one `t('nav.dashboard'…)` in Sidebar.tsx to `t('nav.doesNotExist'…)` → keyUsage FAILS naming file and key. Revert both, re-run, PASS. (The false-positive risk in `keyUsage` is a bare `t(` from a non-i18next helper — if the sweep flags one, tighten the regex or add the marker comment.)

- [x] **Step 4: Commit**

```bash
git add apps/web/src/lib/i18n/localeParity.test.ts apps/web/src/lib/i18n/keyUsage.test.ts apps/web/src/lib/i18n/i18n.test.ts
git commit -m "test(web): locale parity and static translation-key-usage enforcement"
```

---

### Task 4: Shared vocabulary + contributor conventions

A `common` vocabulary prevents 50 duplicate "Cancel" keys across namespaces, and the conventions doc is what makes wave PRs reviewable by contributors.

**Files:**
- Modify: `apps/web/src/locales/en/common.json`, `apps/web/src/locales/pt-BR/common.json`
- Modify: `apps/web/src/locales/README.md`

**Interfaces:**
- Produces: `common:actions.*`, `common:states.*`, `common:labels.*` vocabulary used by every wave; documented rules for interpolation, plurals, and `<Trans>`.

- [x] **Step 1: Add the vocabulary to `en/common.json`** (alongside the existing `nav` tree)

```json
{
  "actions": {
    "save": "Save", "cancel": "Cancel", "delete": "Delete", "edit": "Edit",
    "create": "Create", "add": "Add", "remove": "Remove", "close": "Close",
    "confirm": "Confirm", "search": "Search", "filter": "Filter", "refresh": "Refresh",
    "export": "Export", "download": "Download", "upload": "Upload", "copy": "Copy",
    "retry": "Retry", "back": "Back", "next": "Next", "done": "Done", "apply": "Apply",
    "enable": "Enable", "disable": "Disable", "view": "View", "run": "Run"
  },
  "states": {
    "loading": "Loading…", "saving": "Saving…", "saved": "Saved",
    "error": "Something went wrong", "empty": "No results found",
    "enabled": "Enabled", "disabled": "Disabled", "active": "Active", "inactive": "Inactive",
    "online": "Online", "offline": "Offline", "pending": "Pending", "unknown": "Unknown"
  },
  "labels": {
    "name": "Name", "description": "Description", "status": "Status", "type": "Type",
    "organization": "Organization", "site": "Site", "device": "Device", "user": "User",
    "createdAt": "Created", "updatedAt": "Updated", "actions": "Actions", "all": "All",
    "yes": "Yes", "no": "No", "none": "None", "optional": "Optional", "required": "Required"
  }
}
```

pt-BR (`pt-BR/common.json`), same tree:

```json
{
  "actions": {
    "save": "Salvar", "cancel": "Cancelar", "delete": "Excluir", "edit": "Editar",
    "create": "Criar", "add": "Adicionar", "remove": "Remover", "close": "Fechar",
    "confirm": "Confirmar", "search": "Pesquisar", "filter": "Filtrar", "refresh": "Atualizar",
    "export": "Exportar", "download": "Baixar", "upload": "Enviar", "copy": "Copiar",
    "retry": "Tentar novamente", "back": "Voltar", "next": "Avançar", "done": "Concluído", "apply": "Aplicar",
    "enable": "Ativar", "disable": "Desativar", "view": "Visualizar", "run": "Executar"
  },
  "states": {
    "loading": "Carregando…", "saving": "Salvando…", "saved": "Salvo",
    "error": "Algo deu errado", "empty": "Nenhum resultado encontrado",
    "enabled": "Ativado", "disabled": "Desativado", "active": "Ativo", "inactive": "Inativo",
    "online": "Online", "offline": "Offline", "pending": "Pendente", "unknown": "Desconhecido"
  },
  "labels": {
    "name": "Nome", "description": "Descrição", "status": "Status", "type": "Tipo",
    "organization": "Organização", "site": "Local", "device": "Dispositivo", "user": "Usuário",
    "createdAt": "Criado em", "updatedAt": "Atualizado em", "actions": "Ações", "all": "Todos",
    "yes": "Sim", "no": "Não", "none": "Nenhum", "optional": "Opcional", "required": "Obrigatório"
  }
}
```

- [x] **Step 2: Document conventions in `apps/web/src/locales/README.md`**

Append a "Conventions for extraction PRs" section covering, with these exact examples:
- **Interpolation:** `"deleteConfirm": "Delete {{name}}?"` → `t('deleteConfirm', { name: device.name })`. Never concatenate translated fragments.
- **Plurals:** `"deviceCount_one": "{{count}} device"`, `"deviceCount_other": "{{count}} devices"` → `t('deviceCount', { count })`. pt-BR uses the same `_one`/`_other` suffixes (add `_many` only if i18next warns — CLDR pt handles it).
- **Rich text:** embedded markup uses `<Trans i18nKey="ns:key">plain <strong>bold</strong> text</Trans>` from react-i18next — never split a sentence across multiple `t()` calls.
- **Reuse:** check `common:actions/states/labels` before minting a key; a plain "Save" button is always `t('common:actions.save')`.
- **Scope:** visible text, `placeholder`, `title`, `aria-label`, toast/message strings. NOT: `data-testid`, React keys, structural test fields, API values.
- **Machine-draft flag** for PR descriptions (verbatim line given in Global Constraints).

- [x] **Step 3: Run enforcement, commit**

Run: `cd apps/web && pnpm vitest run src/lib/i18n`
Expected: PASS (parity holds for the new vocabulary).

```bash
git add apps/web/src/locales
git commit -m "feat(web): shared i18n vocabulary (actions/states/labels) + contributor conventions"
```

---

### Task 5: Locale-aware number/currency call-site migration

Phase 1 landed `formatNumber`/`formatCurrency`/`formatPercent` (`apps/web/src/lib/i18n/format.ts`); nothing uses them yet. pt-BR swaps `.`/`,`, so raw `.toFixed()` and hardcoded `$` render wrong.

**Files:**
- Modify: `apps/web/src/lib/timeFormat.ts` (`formatMoney` — the hardcoded-`$` helper)
- Modify: display-path call sites found by the sweep (~146 `.toFixed(` + ~26 currency literals across components)
- Test: `apps/web/src/lib/__tests__/timeFormat.test.ts` (existing expectations updated)

**Interfaces:**
- Consumes: `formatNumber`/`formatCurrency` from `apps/web/src/lib/i18n/format.ts` (Phase 1).
- Produces: no new API — behavior-only change (display numbers honor the explicit user locale; unset preference keeps browser-default behavior, so English users see no change).

- [x] **Step 1: Reimplement `formatMoney` on `formatCurrency`**

In `apps/web/src/lib/timeFormat.ts`, replace the body (keep the exported signature — it takes API numeric strings and falls back on garbage):

```ts
import { formatCurrency } from './i18n/format';

export function formatMoney(value: string | number | null | undefined): string {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value ?? '');
  return formatCurrency(Number.isFinite(parsed) ? parsed : 0);
}
```

Existing test `expect(formatMoney('1234.5')).toBe('$1,234.50')` still passes (no stored locale in that test → browser/en default). Add one pt-BR case:

```ts
it('honors the stored locale', () => {
  window.localStorage.setItem('breeze.locale', 'pt-BR');
  expect(formatMoney('1234.5')).toBe(`R$ 1.234,50`);
  window.localStorage.clear();
});
```

Wait — `formatMoney` is USD-denominated (`$`); pt-BR users of USD-billing partners should see `US$ 1.234,50` (pt-BR formatting of USD), not BRL. `formatCurrency(value)` defaults to USD and locale pt-BR renders `US$ 1.234,50` — assert that exact string (verify actual Node ICU output and pin it).

- [x] **Step 2: Generate the sweep inventory**

```bash
cd apps/web && grep -rn "\.toFixed(" src/components src/lib --include='*.tsx' --include='*.ts' | grep -v '\.test\.' > /tmp/tofixed-sweep.txt
grep -rnE "['\`\"]\\\$\\\$?\{|style: *'currency'|\\\$\\\{.*toFixed" src/components --include='*.tsx' | grep -v '\.test\.' >> /tmp/tofixed-sweep.txt
wc -l /tmp/tofixed-sweep.txt
```

- [x] **Step 3: Migrate display-path call sites**

For each hit, apply exactly one of:
- **Display number** (`{value.toFixed(1)}%`, table cells, stat tiles): → `formatNumber(value, { maximumFractionDigits: 1 })` / `formatPercent(value / 100, …)` — import from `@/lib/i18n/format` or the correct relative path.
- **Display currency** (`` `$${total.toFixed(2)}` ``): → `formatCurrency(total)`.
- **Skip and annotate nothing** (leave untouched): values fed back into `parseFloat`/comparisons, chart-library internals that require `en` numerics, CSV/export payloads, byte-math intermediate steps, `width`/style computations. When in doubt whether a value reaches the user's eyes, leave it and note it in the PR description.

This is mechanical but judgment-laden — suited to a subagent fleet fanning out per directory with the rules above, ~10–15 files per agent.

- [x] **Step 4: Verify**

Run: `cd apps/web && pnpm vitest run && pnpm astro check 2>&1 | tail -5`
Expected: PASS / no new errors. Spot-check in the browser (worktree-stack): set pt-BR, visit a billing or dashboard page with numbers, confirm `1.234,56` separators; switch to English, confirm `1,234.56`.

- [x] **Step 5: Commit**

```bash
git add -A apps/web/src
git commit -m "feat(web): route display numbers/currency through locale-aware formatters"
```

---

### Task 6: Extraction waves (the long march)

Repeated application of one playbook, wave by wave. Each wave: its own branch off the integration branch, one PR, independently shippable, enforcement tests green.

**The playbook (every wave, every file):**
1. `const { t } = useTranslation('<ns>')` — the wave's namespace, one per file.
2. Wrap every user-visible string: JSX text, `placeholder`, `title`, `aria-label`, button/label text, toast messages, confirm dialogs, empty states, table headers. Use `common:` vocabulary where it fits.
3. Interpolation/plurals/`<Trans>` per the README conventions (Task 4).
4. Add keys to `en/<ns>.json` AND `pt-BR/<ns>.json` (machine-draft pt-BR; keep key order mirrored).
5. Leave alone: `data-testid`, React keys, structural fields tests assert on, values sent to the API.
6. Update co-located tests that assert on literal strings (prefer asserting via `data-testid` + translated string, or switch the assertion to the en string which remains the default).
7. Verify: `pnpm vitest run src/components/<dir> src/lib/i18n && pnpm astro check` — parity + keyUsage green is the definition of done.
8. PR description: surface covered, file count, key count, the machine-draft flag line, any skipped strings with reasons.

**Worked example** (the pattern, applied to real code — `PartnerRegionalTab.tsx`'s Time Format field):

Before:
```tsx
<label className="text-sm font-medium">Time Format</label>
<label className="flex items-center gap-2">
  <input type="radio" name="timeFormat" checked={timeFormat === '12h'}
    onChange={() => onTimeFormatChange('12h')} className="h-4 w-4" />
  <span className="text-sm">12-hour</span>
</label>
```

After (ns `settings`, keys in both locale files):
```tsx
<label className="text-sm font-medium">{t('partner.timeFormat.label')}</label>
<label className="flex items-center gap-2">
  <input type="radio" name="timeFormat" checked={timeFormat === '12h'}
    onChange={() => onTimeFormatChange('12h')} className="h-4 w-4" />
  <span className="text-sm">{t('partner.timeFormat.twelveHour')}</span>
</label>
```

```json
// en/settings.json                          // pt-BR/settings.json
"partner": {                                 "partner": {
  "timeFormat": {                              "timeFormat": {
    "label": "Time Format",                      "label": "Formato de Hora",
    "twelveHour": "12-hour"                      "twelveHour": "12 horas"
  }                                            }
}                                            }
```

**Wave inventory** (non-test `.tsx` files / lines, from `apps/web/src/components/`; namespaces created per wave):

| Wave | Surfaces (namespace ← directories) | Files | Lines | Why this order |
|---|---|---|---|---|
| 1 | `portal` ← portal/; `auth` ← auth/, setup/; `common` additions ← layout/, dashboard/, shared/, filters/, account/ | ~72 | ~13k | End-client + first-contact surfaces; shell renders on every page |
| 2a | `devices` ← devices/ (list, detail tabs, groups) — first half | ~29 | ~13k | Core daily tech surface |
| 2b | `devices` ← devices/ second half + `patches` ← patches/ | ~38 | ~17k | |
| 3 | `alerts` ← alerts/; `tickets` ← tickets/; `scripts` ← scripts/, automations/; `vulnerabilities` ← vulnerabilities/ | ~57 | ~21k | Daily ops workflows |
| 4 | `settings` ← settings/ (76 files — split into 3 sub-PRs: partner tabs, org settings, profile/misc) | ~76 | ~28k | Biggest dir, admin-only |
| 5 | `security` ← security/, pam/, sensitiveData/, dnsSecurity/, cisHardening/, auditBaselines/, ai-risk/; `remote` ← remote/; `backup` ← backup/, dr/ | ~78 | ~25k | |
| 6 | `billing` ← billing/, contracts/; `integrations` ← integrations/; `policies` ← configurationPolicies/, software/; `discovery` ← discovery/ | ~112 | ~35k | |
| 7 | Long tail: reports/, analytics/, admin/, audit/, ai/, clientAi/, workspace/, peripherals/, remaining dirs | ~90 | ~25k | Lower traffic |

Rough total: ~520 files, ~180k lines, est. 3,500–7,000 keys. **Each wave is a checkpoint** — pausable indefinitely after any wave with everything shipped so far fully functional (untranslated surfaces just render English via `defaultValue`-free keys that don't exist yet — they were never wrapped).

- [x] **Wave 1** — portal/auth/shell (execute playbook; branch `i18n-wave-1-portal-auth-shell`)
- [x] **Wave 2a** — devices first half
- [x] **Wave 2b** — devices second half + patches
- [x] **Wave 3** — alerts/tickets/scripts/vulnerabilities
- [x] **Wave 4** — settings (3 sub-PRs)
- [x] **Wave 5** — security/remote/backup
- [x] **Wave 6** — billing/integrations/policies/discovery
- [x] **Wave 7** — long tail
- [x] **Post-wave residue sweep:** static visible-string residue hunt, with stragglers fixed and enforcement coverage expanded
- [x] **Manual validation:** pt-BR click-through of the top 10 pages (OrbStack worktree stack), with confirmed stragglers fixed and re-verified

Per-wave execution notes for the orchestrator:
- Fan out subagents ~10–15 files each **within one namespace/wave at a time**; parallel agents must not edit the same `<ns>.json` — have each agent return its key/value pairs and let a single merge step write the JSON files, or assign each agent a distinct top-level key prefix.
- After merging each wave branch, run the full web suite + `astro check`, then the enforcement pair (`src/lib/i18n`) as the gate.
- pt-BR review: tag the wave PR with the machine-draft line; community review (mazarine) can follow asynchronously — corrections are one-line JSON edits protected by parity tests.

---

## Self-Review Notes

- **Coverage vs Phase-1 out-of-scope list:** string extraction (Task 6), partner default (Task 1 — already coded, verify+commit), `.toFixed` migration (Task 5). Deliberately still out: API messages/emails/PDF (Phase 3/4), SSR cookie locale and `.astro` shell strings (documented in Global Constraints).
- **Type consistency:** `loadLocale`/`setLocale` defined in Task 2, consumed in Task 2's tests and Task 6 flows; enforcement tests (Task 3) depend only on the Task-2 directory layout; `formatCurrency` consumed in Task 5 comes from Phase-1 `format.ts` (verified to exist).
- **Sequencing:** Tasks 1→4 are strictly ordered; Task 5 and Wave 1 can run in parallel once Task 4 lands.
- **Judgment calls implementers will hit:** exact ICU output strings for `US$`/pt-BR (pin actual Node output); `keyUsage` regex false positives (tighten or use the `i18n-dynamic` marker); wave 4's settings dir needing 3 sub-PRs; parallel-agent JSON merge conflicts (merge-step pattern above).
