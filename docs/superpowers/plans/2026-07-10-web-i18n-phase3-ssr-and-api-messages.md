# Web Console i18n Phase-3: SSR Shell + API Message Localization Implementation Plan

> **STATUS: FUTURE / ROADMAP.** Written 2026-07-10 against the codebase as of commit `237d8c56` (Phase 2 planned, not yet executed). Prerequisites: Phase-2 Tasks 1–4 (namespaces, enforcement tests, vocabulary) and at least Wave 1 merged. Line numbers and counts WILL have drifted — re-verify every "today" claim before executing, but the architectural decisions below were made against real code and should hold.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A pt-BR user gets a Portuguese page shell on first paint (title, `<html lang>`, static Astro headings) and Portuguese error toasts/messages for the most-surfaced API failures — closing the two gaps Phase 2 deliberately left: server-rendered shell strings and server-authored message strings.

**Architecture:** Two independent workstreams. **(A) SSR shell:** locale cookie written alongside localStorage → read in Astro middleware into `Astro.locals.locale` → pure-function server translation (`tServer(locale, key)`) for `.astro` templates and layout `<title>`/`lang`. No per-request i18next instance — `.astro` rendering passes locale explicitly as a function argument, so there is no singleton race. React islands keep the Phase-1 hydration swap (per-request island SSR is explicitly rejected, see Decisions). **(B) API messages:** additive `code` field on error responses via a helper + shared code catalog — never changing existing prose `error` strings (they are load-bearing for out-of-PR tests and AI tools) — with the web mapping `code → t('errors:…')` centrally inside `runAction`, falling back to server prose.

**Tech Stack:** Astro middleware + `Astro.cookies`, the Phase-2 locale JSON layout, `packages/shared` constants, existing `runAction`/`apiError.ts` seams.

## Global Constraints

- All Phase-1/2 constraints carry over (locales `['en','pt-BR']`, structured keys, parity + keyUsage tests, `data-testid` untouchable).
- **Additive-only API contract:** existing `error` prose strings must not change value — `refactor_output_contract_sweep` lesson: prose→codes conversions break out-of-PR tests and AI tools repo-wide. New `code` fields ride alongside.
- Cookie is a *mirror* of the localStorage preference for SSR's benefit — localStorage stays the client source of truth; disagreement resolves toward localStorage on hydration.
- Cookie attributes: `Path=/; Max-Age=31536000; SameSite=Lax` — NOT `HttpOnly` (client JS writes it), no `Secure` flag hardcoded (dev is http; derive from request protocol if set server-side, but this plan only writes it client-side).
- `.astro` files never import the client i18n module (`lib/i18n/index.ts`) — server shells use only the pure `tServer` module to avoid initializing the client singleton during SSR of pages.

## Decisions (made now so they don't get re-litigated)

1. **No per-request i18next for React island SSR.** The shared singleton renders islands for concurrent requests; per-request language would race, and wrapping ~162 islands in providers is prohibitive churn. Islands keep SSR-English + hydration swap. With the shell (title, lang, static headings) already in Portuguese, the residual island flash is cosmetically minor. Revisit only if Astro/react-i18next grow first-class per-request support.
2. **No mass error-string conversion.** 3,264 `c.json({ error: … })` sites stay as they are. Codes are adopted in waves on the routes whose errors users actually see (auth, devices, tickets, settings, billing), targeting coverage of *surfaced-frequency*, not site-count.
3. **Zod validation errors** get one generic translated envelope on the web side ("Check the highlighted fields" style), not per-message translation — zod messages are developer-authored English of unbounded variety.

---

### Task 1: Locale cookie + `<html lang>` + `Astro.locals.locale`

**Files:**
- Modify: `apps/web/src/lib/appearance.ts` — mirror locale writes into a cookie
- Modify: `apps/web/src/middleware.ts` — read cookie into `context.locals.locale` (today the middleware ignores `context` entirely; it's CSP-header-only, so this is clean net-new)
- Modify: `apps/web/src/env.d.ts` — declare `App.Locals` (none exists today)
- Modify: all 5 root layouts (`apps/web/src/layouts/Layout.astro:13`, `AuthLayout.astro:13`, `AuthShellBranded.astro:20`, `ErrorLayout.astro:13`, `SetupLayout.astro:13`) — `<html lang="en">` → `<html lang={Astro.locals.locale ?? 'en'}>`
- Test: `apps/web/src/lib/__tests__/localePreference.test.ts` (cookie mirror cases), `apps/web/src/middleware.test.ts` (locals.locale extraction — the middleware already has co-located tests for CSP helpers; follow that file's conventions)

**Interfaces:**
- Consumes: `writeLocalePreference` / `applyResolvedLocalePreferences` (Phase 1/2).
- Produces: `LOCALE_COOKIE_NAME = 'breeze.locale'` exported from `appearance.ts`; `Astro.locals.locale?: 'en' | 'pt-BR'` available to every layout/page (Task 2 relies on it).

- [ ] **Step 1: Cookie mirror in `appearance.ts`** — add next to the storage helpers:

```ts
export const LOCALE_COOKIE_NAME = 'breeze.locale';

function writeLocaleCookie(value: LocalePreference | undefined): void {
  if (typeof document === 'undefined') return;
  try {
    document.cookie = value === undefined
      ? `${LOCALE_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`
      : `${LOCALE_COOKIE_NAME}=${value}; Path=/; Max-Age=31536000; SameSite=Lax`;
  } catch {
    // Cookie write failures must not break the preference itself.
  }
}
```

Call `writeLocaleCookie(value)` inside `writeLocalePreference`, and inside `applyResolvedLocalePreferences` mirror the *resolved* value (and clear on an absent user+partner locale). Tests: write pref → `document.cookie` contains `breeze.locale=pt-BR`; jsdom supports document.cookie.

- [ ] **Step 2: `App.Locals` in `env.d.ts`**

```ts
declare namespace App {
  interface Locals {
    locale?: 'en' | 'pt-BR';
  }
}
```

- [ ] **Step 3: Read the cookie in middleware** — in `middleware.ts`, rename `_context` → `context` and add before `await next()`:

```ts
const cookie = context.cookies.get('breeze.locale')?.value;
context.locals.locale = cookie === 'pt-BR' || cookie === 'en' ? cookie : undefined;
```

(Keep the literal check inline — the middleware must not import client modules; duplicating two literals beats coupling. A comment should point at `LOCALE_OPTIONS` as the source of truth.)

- [ ] **Step 4: `<html lang>` in the 5 layouts**, run web suite + `astro check`, commit.

```bash
git add apps/web/src/lib/appearance.ts apps/web/src/lib/__tests__/localePreference.test.ts apps/web/src/middleware.ts apps/web/src/middleware.test.ts apps/web/src/env.d.ts apps/web/src/layouts
git commit -m "feat(web): locale cookie + Astro.locals.locale + html lang attribute"
```

---

### Task 2: Server-side shell translation (`tServer`) + `.astro` strings

**Files:**
- Create: `apps/web/src/lib/i18n/server.ts` (pure, no i18next, no singleton)
- Create: `apps/web/src/locales/en/pages.json`, `apps/web/src/locales/pt-BR/pages.json`
- Modify: `apps/web/src/layouts/Layout.astro` (title interpolation, meta description), `AuthShellBranded.astro` (tagline at L15, description default at L14), `DashboardLayout.astro` + the page-title plumbing
- Modify: the 13 `.astro` pages with inline user-visible text (`404.astro`, `500.astro`, `vulnerabilities.astro`, `settings/index.astro`, `settings/billing.astro`, `settings/connected-apps.astro`, `settings/organizations/[id]/billing.astro`, `alerts/correlations.astro`, `reports/builder.astro`, `reports/new.astro`, `remote/index.astro`, `remote/tools.astro`, `remote/terminal/[deviceId].astro`)
- Modify: the ~135 thin pages passing `title="…"` → `titleKey="…"` (mechanical sweep)
- Test: `apps/web/src/lib/i18n/server.test.ts`

**Interfaces:**
- Consumes: `Astro.locals.locale` (Task 1); locale JSON layout (Phase 2) — `pages.json` participates in the parity test automatically.
- Produces: `tServer(locale: 'en' | 'pt-BR' | undefined, key: string, vars?: Record<string, string>): string` — dot-path lookup in the bundled `pages` namespace with `{{var}}` interpolation and en fallback; layouts accept `titleKey?: string` (translated) with `title?: string` still honored for stragglers.

- [ ] **Step 1: Write `server.ts` + failing test**

```ts
// Pure server-side translation for .astro shells. Deliberately NOT i18next:
// .astro rendering passes locale explicitly, so a pure function avoids any
// shared-instance language state across concurrent SSR requests. Scope is the
// `pages` namespace only; React islands use the client runtime instead.
import enPages from '../../locales/en/pages.json';
import ptBRPages from '../../locales/pt-BR/pages.json';

const bundles: Record<string, Record<string, unknown>> = { en: enPages, 'pt-BR': ptBRPages };

export function tServer(
  locale: string | undefined,
  key: string,
  vars: Record<string, string> = {}
): string {
  const lookup = (loc: string): string | undefined => {
    let node: unknown = bundles[loc];
    for (const part of key.split('.')) {
      if (node === null || typeof node !== 'object') return undefined;
      node = (node as Record<string, unknown>)[part];
    }
    return typeof node === 'string' ? node : undefined;
  };
  const raw = (locale && lookup(locale)) ?? lookup('en') ?? key;
  return raw.replace(/\{\{(\w+)\}\}/g, (_, name: string) => vars[name] ?? `{{${name}}}`);
}
```

Test: en/pt-BR lookup, fallback to en for missing pt-BR key, raw-key return for unknown key, interpolation, `undefined` locale → en.

- [ ] **Step 2: Seed `pages.json`** — one `titles` subtree (135 keys, harvested by sweeping `title="` in `src/pages`), one subtree per inline-text page (e.g. `notFound.heading` / `notFound.body`), `layout.metaDescription`, `authShell.tagline`. pt-BR drafts flagged machine-drafted as usual. Parity test covers it for free.

- [ ] **Step 3: Layout plumbing** — `Layout.astro` (and `DashboardLayout`, auth layouts) accept `titleKey`; resolve `const pageTitle = titleKey ? tServer(Astro.locals.locale, titleKey) : title;` and render `<title>{pageTitle} | Breeze RMM</title>`. Sweep the ~135 thin pages `title="Devices"` → `titleKey="titles.devices"` (subagent-fleet-friendly, ~15 pages per agent). Convert the 13 inline-text pages to `tServer` calls.

- [ ] **Step 4: Verify** — web suite, `astro check`, parity/keyUsage, then worktree-stack smoke: with pt-BR chosen, a hard reload shows a Portuguese `<title>` and `lang="pt-BR"` in view-source (i.e., server-rendered, not hydrated). Commit.

```bash
git add apps/web/src/lib/i18n/server.ts apps/web/src/lib/i18n/server.test.ts apps/web/src/locales apps/web/src/layouts apps/web/src/pages
git commit -m "feat(web): server-rendered shell translation via locale cookie"
```

---

### Task 3: API error-code infrastructure (additive)

**Files:**
- Create: `packages/shared/src/constants/errorCodes.ts` (+ export from `packages/shared/src/index.ts`)
- Create: `apps/api/src/lib/jsonError.ts`
- Modify: `apps/web/src/lib/runAction.ts` — default `friendly` resolver backed by i18n
- Create: `apps/web/src/locales/en/errors.json`, `apps/web/src/locales/pt-BR/errors.json`
- Test: `apps/api/src/lib/jsonError.test.ts`, extend `apps/web/src/lib/__tests__/` runAction coverage

**Interfaces:**
- Consumes: `runAction`'s existing `friendly?: (code: string) => string | undefined` option and `ActionError.code` (both already exist — `runAction.ts` L20/L49-57); `apiError.ts` extraction shapes.
- Produces:
  - `ERROR_CODES` const object in shared (single source: `NOT_FOUND`, `ACCESS_DENIED`, `VALIDATION_FAILED`, `RATE_LIMITED`, `CONFLICT`, `LIMIT_REACHED`, `MFA_REQUIRED`, `INVALID_CREDENTIALS`, `EXPIRED`, plus domain codes added by waves — `DEVICE_OFFLINE`, `AGENT_UNREACHABLE`, …).
  - `jsonError(c, status, code, message)` → `c.json({ error: message, code }, status)` — API routes adopt it opportunistically; prose stays intact.
  - Web: when a response carries `code`, `runAction` resolves `t('errors:<code>')` (if the key exists) before falling back to server prose; per-call `friendly` overrides still win.

- [ ] **Step 1: Shared catalog** — plain `as const` object + `type ErrorCode = keyof typeof ERROR_CODES`; values are the wire strings (SCREAMING_SNAKE). No zod, no runtime cost.

- [ ] **Step 2: `jsonError` helper + test** (10 lines; test asserts shape `{error, code}` and status passthrough).

- [ ] **Step 3: Web mapping** — in `runAction.ts`, where `code` is extracted today (L49), insert before the `friendly` hook:

```ts
if (code && i18n.exists(code, { ns: 'errors' })) {
  message = i18n.t(`errors:${code}`);
}
```

with `errors.json` keyed by code: `"NOT_FOUND": "Not found"` / `"NOT_FOUND": "Não encontrado"`, etc. Seed the ~10 generic codes both locales. keyUsage test note: `t(\`errors:${code}\`)` is dynamic — mark the line `// i18n-dynamic`; parity still enforces the JSON files.

- [ ] **Step 4: Zod envelope** — in `apps/web/src/lib/apiError.ts`, when the parsed shape is the zod-issues form, return `t('errors:VALIDATION_FAILED')` as the headline (keep field details in the toast body/console). Commit.

```bash
git commit -m "feat: additive API error codes with client-side translation seam"
```

---

### Task 4: Code-adoption waves on user-surfaced routes

Same wave mechanics as Phase-2 Task 6. For each route file: identify the error responses users actually hit through the UI (auth failures, not-found, permission, conflict, quota), convert `c.json({ error: 'msg' }, s)` → `jsonError(c, s, ERROR_CODES.X, 'msg')` **keeping the prose byte-identical**, add any new domain codes to the catalog + both `errors.json` files.

| Wave | Route files (`apps/api/src/routes/`) | Rationale |
|---|---|---|
| E1 | `auth/*` (login, password, register, mfa), `users.ts` | Every user sees these |
| E2 | `devices/*`, `agents/*` user-facing errors, `remote/*` session errors | Core workflows |
| E3 | `tickets*`, `alerts*`, `scripts*`, `patches*` | Daily ops |
| E4 | `orgs.ts`, `settings-ish` routes, `billing/quotes/invoices` | Admin + portal-facing |
| E5+ | Long tail, driven by "what still toasts English" reports from pt-BR usage | Demand-driven |

Definition of done per wave: route tests green **unchanged where they assert prose** (byte-identical rule), new code assertions added, parity green, and a worktree-stack smoke showing a translated toast (e.g. wrong password → Portuguese message).

- [ ] Wave E1 · - [ ] Wave E2 · - [ ] Wave E3 · - [ ] Wave E4 · - [ ] E5 backlog triage

---

## Explicitly out of scope (Phase 4 or never)

- Emails, PDFs, notification channels (Phase 4 plan).
- Translating `alert.title`/`alert.message` *content* generated by monitors/workers (stored English in DB rows) — the hardest server-string problem; needs its own design (store structured params, render at read time). Deferred beyond Phase 4 planning.
- Per-request island SSR (Decision 1).

## Self-Review Notes

- Verified-today seams: middleware ignores context (safe to claim), no `App.Locals` exists, `runAction` already has `friendly`/`code`, `apiError.ts` documents the four server shapes, `<html lang>` sites enumerated, 13 inline-text pages enumerated by name.
- Biggest drift risks at execution time: `runAction.ts` line positions; the 135-title count; whether Phase 2 renamed locale JSON paths. All are re-verify-first items, none change the architecture.
- Estimate: Tasks 1–3 ≈ 1–2 days; each adoption wave ≈ ½–1 day.
