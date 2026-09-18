---
tracking_issue: LanternOps/breeze#6223
---
# Settings Consolidation W01: Placement — Implementation Plan

> Wave mapping: W01 = #6224 (this plan), W02-API = #6225, W02-WEB = #6226.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move billing and ticketing settings screens into the placement the audit
decided on (§4/§8 Decision 1) — nothing about how any field behaves, resolves, or is
stored changes. `Settings → Ticketing` becomes its own page, symmetrical with
`Settings → Billing`; Billing gains a Defaults/Documents/Rates(reserved)/Connections
tab order and sheds its three catalog-prefill fields to a new Catalog defaults card;
dead/duplicate URLs redirect; the partner Modules switch and the `canManageInbound`
gate get fixed homes/names; a guard test makes "every settings page is reachable"
mechanical from here on.

**This is the only #6164 wave that gates #4628 W02** (billing profiles / rate cards
— and, transitively, block hours #4547, which is p1). #4628 W01 (work
types) can run in parallel with this wave; #4628 W02 is blocked until this wave
merges (audit §7: "Wave 0 goes first... #4628 W02 follows Wave 0"). Keep this wave
as small as it can reasonably be — read "Conflicts with #4628" below before touching
`TicketCategoriesPage.tsx`, `OrgTicketSettingsEditor.tsx`, or `OrgBillingSettings.tsx`.

**Architecture:** Every existing tab/card component (`TicketStatusesTab`,
`TicketPrioritiesTab`, `TicketCategoriesPage`, `TicketFormsCard`, `InboundEmailCard`,
`M365MailboxCard`, `CannedResponsesCard`, `TicketChecklistTemplatesPage`,
`TimeTrackingSettingsCard`, `PartnerModulesCard`) is reused as-is — only the shell
that mounts them moves. `TicketingSettingsTabs.tsx` is repurposed in place from an
8-sub-tab, two-hash-level embed into the single-level 7-tab body of a new standalone
`/settings/ticketing` page, using `useHashTab` (`apps/web/src/lib/useHashState.ts`).
`PartnerBillingSettings.tsx` is split into a new tabbed shell
(`PartnerBillingSettingsPage.tsx`, also `useHashTab`) around two new
sub-components (`BillingDefaultsTab.tsx`, `BillingDocumentsTab.tsx`) plus a new
read-only `BillingConnectionsTab.tsx`; the PATCH endpoint, payload shape, and field
set are untouched — the split only changes which fields render in which section of
one still-single Save. The tab config carries a fourth, **reserved and unrendered**
`rates` entry between Documents and Connections so #4628 W02 can add the real Rates
tab as a one-entry flip instead of re-laying-out the page. Three fields move from Billing to a new
`CatalogDefaultsCard.tsx` mounted on the existing Catalog page, reusing the exact
same `/partner/billing-settings` PATCH (verified to accept a partial payload
provided the three always-required fields ride along). `.astro` files for retired
routes become one-line 301 redirects. A new `settingsPageRegistry.test.ts` enumerates
every file under `pages/settings/**` and fails on any orphan.

**Tech Stack:** Astro + React islands, react-i18next (eight locales), `runAction`,
`useHashTab`/`useHashState`, Vitest + Testing Library (jsdom), Playwright
(`data-testid` only).

**Spec:** `docs/superpowers/specs/web-ui/2026-09-17-billing-ticketing-settings-audit.md`
— this plan implements **Wave 0** of that document's §5 table (moves M0–M9), per
§8 Decision 1 (A: two symmetrical pages) and Decision 5 (one tracked feature, Wave 0
first). Waves 1–2 (inheritance UI, save-pattern unification, behaviour changes) are
separate plans, not built here.

## Split recommendation

**One PR is right-sized here and is what this plan builds**, but flagged for the
executor: M0 (the Ticketing page) is roughly 40% of the diff by itself (repurposing
an 8-tab embedded component into a 7-tab standalone page, plus the guard test, plus
every redirect and sidebar entry it touches). If review turns out to want a smaller
diff, the clean cut is **W01a = Tasks 1–7 (M0, M1, M2, M3, M9's guard test written
red in Task 1 and turned green in Task 7)** and **W01b = Tasks 8–17 (M4–M8:
Billing/Catalog/Invoices/Connections/Modules, CLAUDE.md/PR template, the
mount/composition test, and final verification)**, landed as two PRs against the
same wave sub-issue in sequence (W01b's `TARGET_GLOBS` edits and the final
`settingsPageRegistry`/mount-composition tests both assume W01a is already merged).
Task 8's Connections-tab placeholder (see Task 8's own note, added during the
2026-09-17 coherence pass) means Tasks 8 and 11 no longer have a forward
dependency on each other, so a split could in principle cut between them too —
but there is no reason to: both are squarely inside W01b's Billing-page work.
Default: ship as one PR unless review pushes back.

## Global Constraints

- **URL state is hash-only.** New pages use `useHashTab` (`apps/web/src/lib/useHashState.ts`) — never a query param, never `window.location.hash` read inside a `useState` initializer.
- **Every mutation goes through `runAction`.** `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` `TARGET_GLOBS` already lists `src/components/settings/PartnerSettingsPage.tsx`, `src/components/settings/InboundEmailCard.tsx`, `src/components/settings/CatalogItemsTab.tsx`, `src/components/billing/PartnerBillingSettings.tsx` — every new/renamed file that inherits a mutation from one of these must be added to that list in the same task.
- **Eight-locale parity with real translations.** Every new/renamed key lands in `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/{settings,billing,pages}.json` with the verbatim strings given in this plan (translations below are machine-drafted, matching the disclosure already used elsewhere in `apps/web/src/locales/README.md`: "es-419, fr-FR, fr-CA, de-DE, it-IT, pt-BR and tr-TR strings are machine-drafted pending native review"). `localeParity`, `translationCoverage`, `keyUsage` (`apps/web/src/lib/i18n/*.test.ts`) must stay green.
- **No API/schema change in this wave.** Every task PATCHes the same endpoints with the same field names verified below. `partnerBillingSettingsSchema` (`packages/shared/src/validators/invoices.ts`) requires `currencyCode`, `invoiceNumberPrefix`, `invoiceTermsDays` on every PATCH to `/partner/billing-settings` — any new caller of that endpoint (the Catalog defaults card) must send those three current values too, never a 3-field-only payload.
- Web tests: `cd apps/web && npx vitest run <explicit paths>` — never `pnpm … test -- --run`, never a trailing-slash directory filter (misses dotted siblings).
- Full web suite: `cd apps/web && npx vitest run`. Typecheck: `cd apps/web && npx tsc --noEmit -p tsconfig.json` (verify this script exists in `apps/web/package.json` before Task 14 — CLAUDE.md notes there is no root typecheck script).
- Branch: `feature/6164-settings-consolidation/wave-<TBD>` (the wave sub-issue number is not yet registered — the orchestrator fills this in via `feature-lifecycle` `register_feature`/`start_wave` before dispatch). PR body: `Closes #<wave sub-issue>` plus the audit's rule 9 statement (§3.9): *"This PR adds/moves N settings surfaces. Home: <domain>. Level: <partner|org>. Resolver: unchanged (placement only). Count of places this concept is configured — before: X, after: Y."*
- **Mount-only for three files shared with #4628 (concurrent, in flight — see "Conflicts with #4628" below):** `TicketCategoriesPage.tsx`, `OrgTicketSettingsEditor.tsx`, `OrgBillingSettings.tsx`. This wave may change *where* each is rendered (which parent mounts it, what tab/route wraps it) and the shell around it, but never their internal JSX, state, props contract, API calls, or locale keys. Any task that cannot avoid touching one of their internals must be called out in that section first, kept to the minimum line count, and flagged again at the task itself before it is executed.

---

## Conflicts with #4628

#4628 (billing profiles / rate cards, tracked separately, running concurrently) edits
the *inside* of three components this wave only moves the *placement* of:

| File | #4628's change (out of scope here) | This wave's touch | Mount-only? |
|---|---|---|---|
| `apps/web/src/components/settings/TicketCategoriesPage.tsx` | W01 adds a "Default work type" select; its W02 cut-over removes the three pricing fields (`defaultBillable`, `defaultHourlyRate`, `rateCurrency`); `defaultTimeEntryMinutes` stays | Task 2 imports it unchanged into the restructured `TicketingSettingsTabs.tsx` and renders `<TicketCategoriesPage />` under the `categories` tab exactly as today — the diff never opens this file, only its (unchanged) import path and call site | **Yes — verified** |
| `apps/web/src/components/settings/OrgTicketSettingsEditor.tsx` | W02 deletes its billing section (`defaultHourlyRate`, `defaultBillable`) | Not rendered, re-parented, or referenced by any task in this plan — it stays inside `OrgSettingsPage.tsx`'s existing Ticketing tab, untouched. Named in the Global Constraints' `TARGET_GLOBS` note only because it already appears there at its current, unmoved path | **Yes — not touched at all** |
| `apps/web/src/components/billing/OrgBillingSettings.tsx` | W02 adds a "Billing profile" select and changes the currency-readiness contract | Task 5 (M1) redirects only the *standalone* `.astro` wrapper (`pages/settings/organizations/[id]/billing.astro`) to the org settings page's existing `#billing` hash — it never opens `OrgBillingSettings.tsx`; the component keeps mounting exactly where `OrgSettingsPage.tsx` already mounts it | **Yes — verified: Task 5's Files block lists only the two `.astro`/e2e files, not this component** |

**No task in this plan requires an exception.** `PartnerBillingSettings.tsx` (deleted
and split across Task 8/11) and `CatalogSettingsPage.tsx` (Task 9) are **not** on
this list — they are partner-level billing/catalog files #4628 does not touch, so
their split is unrestricted placement work, not a mount-only concern. If a task turns out
to need one line inside `TicketCategoriesPage.tsx`, `OrgTicketSettingsEditor.tsx`, or
`OrgBillingSettings.tsx` during execution (e.g. a missing `data-testid` the
composition test needs), the executor stops, adds a row to this table naming the
exact line, and gets it reviewed before proceeding — and never touches
`defaultBillable`, `defaultHourlyRate`, `defaultTimeEntryMinutes`, `defaultWorkType`,
`billingProfileId`, or any currency-readiness field while doing so, since those are
#4628's fields mid-flight.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/web/src/lib/__tests__/settingsPageRegistry.test.ts` (new) | M9 guard: every `pages/settings/**` page is nav-linked, index-linked, a redirect, or an allowlisted dynamic route |
| `apps/web/src/components/settings/TicketingSettingsTabs.tsx` (modified) | Repurposed from 8 sub-tabs/two hash levels to 7 top-level tabs (Statuses, Priorities & SLAs, Categories, Intake forms, Email, Templates, Time capture); `Export` removed (moves out per M5); `syncHash` becomes the only mode (no more embedded/`initialTab` case) |
| `apps/web/src/pages/settings/ticketing/index.astro` (new) | Mounts the ticketing hub at `/settings/ticketing` |
| `apps/web/src/components/settings/TicketingHubPage.tsx` (new) | Thin page shell: heading + `TicketingSettingsTabs` |
| `apps/web/src/components/settings/PartnerSettingsPage.tsx` (modified) | Ticketing tab becomes a link-out card (no longer embeds `TicketingSettingsTabs`); `modules` becomes its own `TabDef` (M7); Company tab no longer renders `PartnerModulesCard` |
| `apps/web/src/pages/settings/ticketing.astro` (modified) | Redirect target changes from `/settings/partner#ticketing` to `/settings/ticketing` |
| `apps/web/src/pages/settings/organizations/[id]/billing.astro` (modified) | Becomes a 301 to `/settings/organizations/<id>#billing` (M1) |
| `apps/web/src/components/settings/TicketingSettingsPage.tsx` (deleted) | Dead code (M2) |
| `apps/web/src/components/settings/TicketingSettingsPage.test.tsx` (deleted) | Its only importer besides itself (M2) |
| `apps/web/src/pages/settings/webhooks/index.astro` (modified) | Becomes a 301 to `/integrations#webhooks` (M2) |
| `apps/web/src/components/webhooks/WebhooksPage.tsx` | No change — still mounted at `/integrations/webhooks` |
| `apps/web/src/components/billing/PartnerBillingSettings.tsx` (deleted, split) | Replaced by the four files below (M4) |
| `apps/web/src/components/billing/PartnerBillingSettingsPage.tsx` (new) | Tabbed shell: Defaults / Documents / Rates (reserved, unrendered) / Connections, one shared load+save; Task 8 stubs Connections as a placeholder panel, Task 11 wires in the real `BillingConnectionsTab` |
| `apps/web/src/components/billing/BillingDefaultsTab.tsx` (new) | Currency, tax rate, invoice prefix, payment terms |
| `apps/web/src/components/billing/BillingDocumentsTab.tsx` (new) | Auto-email, device appendix, AI style pointer removed (moves to Catalog), document theme/page size, footer, Company card (name/phone/website/address/terms) |
| `apps/web/src/components/billing/BillingConnectionsTab.tsx` (new) | Read-only Stripe/QuickBooks status + links to `/integrations#accounting`; Catalog/Distributors cross-link — plain links only, no billables export here (M5 lands on Invoices, see below) |
| `apps/web/src/components/settings/BillablesExportCard.tsx` → `apps/web/src/components/billing/BillablesExportCard.tsx` (moved) | Body unchanged; keeps its `settings` i18n namespace (M5) |
| `apps/web/src/components/billing/InvoicesPage.tsx` (modified) | Gains an "Export billables" header button (hidden when `lockedOrgId` is set) opening `BillablesExportCard` in a `shared/Dialog`, gated on `!isOrgScoped && can('tickets','read') && can('time_entries','read')` (M5) |
| `apps/web/src/components/settings/CatalogSettingsPage.tsx` (modified) | Mounts new `CatalogDefaultsCard` above `CatalogItemsTab` (gated on the page's own existing `isOrgScoped` check) |
| `apps/web/src/components/settings/CatalogDefaultsCard.tsx` (new) | `defaultMarkupPercent`, `autoTaxHardware`, `catalogAiStyle` — PATCHes `/partner/billing-settings` with those 3 fields plus the 3 always-required ones |
| `apps/web/src/components/settings/TicketingSettingsTabs.tsx` templates tab | Mounts `CannedResponsesCard` + `TicketChecklistTemplatesPage` under one "Templates" tab (M3) |
| `apps/web/src/components/settings/DeliverableTemplatesPage.tsx` | No code change — gains a Billing-section nav entry (M3) |
| `apps/web/src/components/layout/Sidebar.tsx` (modified) | New `Ticketing` item in the Settings section; new `Deliverable Templates` item in the Billing section |
| `apps/web/src/components/settings/PartnerModulesCard.tsx` | No code change — remounted under its own tab instead of inside Company (M7) |
| `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (modified) | `TARGET_GLOBS` updated for every renamed/new file carrying a mutation |
| `apps/web/src/lib/runActionAllowlist.ts` | Reviewed in Task 14; no entries expected to change |
| `apps/web/src/locales/*/{settings,billing,pages}.json` | New/renamed keys, given verbatim per task |
| `e2e-tests/pages/OrgBillingSettingsPage.ts` (modified) | `url()` still returns the old standalone URL for the *redirect* assertion; new navigation helper added for the tab URL |
| `e2e-tests/tests/multi-currency.spec.ts` (modified) | Uses the updated page object |
| `.github/PULL_REQUEST_TEMPLATE.md` (modified) | Rule 9 checklist line (M6/§6) |
| `CLAUDE.md` (modified) | New "Settings — one concept, one home" section (§6) |

---

### Task 1: Guard test — every `pages/settings/**` page is reachable (M9, red first)

This must be written and run to a **known-failing** state before any nav entries in
later tasks land, per the brief's "order tasks so it fails on today's tree" rule.
Today, `apps/web/src/pages/settings/ticket-checklist-templates.astro` and
`apps/web/src/pages/settings/deliverable-templates.astro` have zero sidebar entries
(verified: `rg -n "ticket-checklist-templates|deliverable-templates|TicketChecklistTemplates|DeliverableTemplates" apps/web/src/components/layout/Sidebar.tsx` returns nothing) — that is exactly what should make this fail now.

**Files:**
- Create: `apps/web/src/lib/__tests__/settingsPageRegistry.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks — pure filesystem/text scan.
- Produces: nothing consumed by later tasks; this is the acceptance gate for M9 (this test file is re-run, not modified, at the end of every later task that touches a settings route).

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/__tests__/settingsPageRegistry.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = resolve(__dirname, '../..');
const SETTINGS_PAGES_DIR = join(WEB_SRC, 'pages/settings');
const SIDEBAR_PATH = join(WEB_SRC, 'components/layout/Sidebar.tsx');
const SETTINGS_INDEX_PATH = join(WEB_SRC, 'components/settings/SettingsIndexPage.tsx');

// Every entry here is a filed, justified exception — not a place to silence a
// new orphan. Add an entry only with a one-line reason.
const ALLOWLIST: Record<string, string> = {
  // Base org settings route; children are linked from the org list, not the sidebar.
  'organizations/[id].astro': 'dynamic org detail route, reached from /organizations',
  'organizations/index.astro': 'listed directly in the Settings sidebar as Organizations',
};

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, base));
    else if (entry.endsWith('.astro')) out.push(relative(base, full));
  }
  return out;
}

function isRedirectOnly(fullPath: string): boolean {
  const src = readFileSync(fullPath, 'utf-8');
  return /Astro\.redirect\(/.test(src);
}

describe('every pages/settings/** page is reachable (M9)', () => {
  const sidebarSrc = readFileSync(SIDEBAR_PATH, 'utf-8');
  let settingsIndexSrc = '';
  try {
    settingsIndexSrc = readFileSync(SETTINGS_INDEX_PATH, 'utf-8');
  } catch {
    settingsIndexSrc = '';
  }

  const pages = walk(SETTINGS_PAGES_DIR);

  it.each(pages)('%s is linked, redirected, or allowlisted', (relPath) => {
    if (ALLOWLIST[relPath]) return; // documented exception
    const fullPath = join(SETTINGS_PAGES_DIR, relPath);
    if (isRedirectOnly(fullPath)) return; // (c) redirect

    // Route as it would appear in an href: strip the trailing /index.astro or
    // the .astro extension, and any dynamic segment.
    const routeSuffix = relPath
      .replace(/\/index\.astro$/, '')
      .replace(/\.astro$/, '')
      .replace(/\[[^\]]+\]/g, '');
    const routeFragment = `/settings/${routeSuffix}`.replace(/\/{2,}/g, '/').replace(/\/$/, '');

    const inSidebar = sidebarSrc.includes(routeFragment);
    const inIndex = settingsIndexSrc.includes(routeFragment);
    expect(
      inSidebar || inIndex,
      `${relPath} (route ~ "${routeFragment}") is not in Sidebar.tsx, not in ` +
        `SettingsIndexPage.tsx, not a redirect, and not in the ALLOWLIST above. ` +
        `Add a nav entry, a redirect, or a justified allowlist line.`
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails on today's tree**

Run: `cd apps/web && npx vitest run src/lib/__tests__/settingsPageRegistry.test.ts`
Expected: FAIL — at minimum `ticket-checklist-templates.astro` and
`deliverable-templates.astro` report not linked/redirected/allowlisted (confirm the
actual failing set; if `SettingsIndexPage.tsx` does not exist under that exact name,
the `readFileSync` catch keeps `settingsIndexSrc` empty and the assertion still runs
against `sidebarSrc` alone — do not skip the test on that catch).

- [ ] **Step 3: Commit the red test on its own**

```bash
git add apps/web/src/lib/__tests__/settingsPageRegistry.test.ts
git commit -m "test(web): add settings page reachability guard (red — M9)"
```

This test goes green again only once Task 7 (nav entries) and Task 9 (checklist
templates folded into Templates tab, its own page now redundant — see Task 7) land.

---

### Task 2: Repurpose `TicketingSettingsTabs.tsx` into the 7-tab single-level shape (M0)

Verified current shape (`apps/web/src/components/settings/TicketingSettingsTabs.tsx`):
`VALID_TABS = ['statuses','priorities','categories','forms','export','inbound','canned','timeTracking']`,
parsed off a `#tab=` fragment (line 47-56), `canManageInbound` derived locally from
JWT scope (lines 115-123) gates `forms`/`inbound`/`canned`/`timeTracking`. Target
shape (audit §4): Statuses · Priorities & SLAs · Categories · Intake forms · Email ·
Templates · Time capture — `export` (Billables) is removed here (moves in Task 10,
M5) and `inbound`+`canned` become two of the composed tabs (`email`, `templates`).
`CustomerDomainsCard` is already rendered *inside* `InboundEmailCard.tsx` (verified:
`apps/web/src/components/settings/InboundEmailCard.tsx:8,519` imports and renders
it) — so "Email" only needs `InboundEmailCard` + `M365MailboxCard`, no new wiring
for domains.

**Files:**
- Modify: `apps/web/src/components/settings/TicketingSettingsTabs.tsx`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/settings.json`
- Test: `apps/web/src/components/settings/TicketingSettingsTabs.test.tsx` (existing — extend)

**Interfaces:**
- Consumes: `TicketStatusesTab`, `TicketPrioritiesTab`, `TicketCategoriesPage`, `TicketFormsCard`, `InboundEmailCard`, `M365MailboxCard`, `CannedResponsesCard`, `TicketChecklistTemplatesPage`, `TimeTrackingSettingsCard` (all unchanged imports, same paths).
- Produces: `TicketingSettingsTabs()` with no props (drops `syncHash`/`initialTab` — the component now always owns its own hash; the embedded-in-partner-hub case is removed in Task 3). Exported `TICKETING_HUB_TABS: readonly string[]` = `['statuses','priorities','categories','forms','email','templates','timeTracking']` for Task 3's link-card copy and Task 6's e2e page object.

- [ ] **Step 1: Write the failing test additions**

```tsx
// apps/web/src/components/settings/TicketingSettingsTabs.test.tsx
// (append to the existing file's describe blocks — do not remove existing
// statuses/priorities/categories coverage, which is unaffected)
it('renders the merged Email tab (inbound + M365, no separate customer-domains tab)', async () => {
  renderWithPartnerScope();
  await userEvent.click(screen.getByTestId('ticketing-tab-email'));
  expect(screen.getByTestId('ticketing-tab-panel-email')).toBeInTheDocument();
  expect(screen.queryByTestId('ticketing-tab-panel-inbound')).not.toBeInTheDocument();
  expect(screen.queryByTestId('ticketing-tab-canned')).not.toBeInTheDocument();
});

it('renders the merged Templates tab (canned responses + checklist templates)', async () => {
  renderWithPartnerScope();
  await userEvent.click(screen.getByTestId('ticketing-tab-templates'));
  expect(screen.getByTestId('ticketing-tab-panel-templates')).toBeInTheDocument();
});

it('has no Export tab (moved out under M5)', () => {
  renderWithPartnerScope();
  expect(screen.queryByTestId('ticketing-tab-export')).not.toBeInTheDocument();
});

it('renders Time capture (renamed from Time Tracking)', async () => {
  renderWithPartnerScope();
  await userEvent.click(screen.getByTestId('ticketing-tab-timeTracking'));
  expect(screen.getByTestId('ticketing-tab-panel-timeTracking')).toBeInTheDocument();
  expect(screen.getByText('Time capture')).toBeInTheDocument();
});
```

(`renderWithPartnerScope` is the existing helper already used by this test file's
partner-only-tab assertions — reuse it, do not redefine it.)

- [ ] **Step 2: Run to confirm the new assertions fail**

Run: `cd apps/web && npx vitest run src/components/settings/TicketingSettingsTabs.test.tsx`
Expected: FAIL — `ticketing-tab-email`/`ticketing-tab-templates` not found (current
tab ids are `inbound`/`canned`/`export`).

- [ ] **Step 3: Rewrite the component**

```tsx
// apps/web/src/components/settings/TicketingSettingsTabs.tsx
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import TicketCategoriesPage from './TicketCategoriesPage';
import TicketStatusesTab from './TicketStatusesTab';
import TicketPrioritiesTab from './TicketPrioritiesTab';
import InboundEmailCard from './InboundEmailCard';
import M365MailboxCard from './M365MailboxCard';
import CannedResponsesCard from './CannedResponsesCard';
import TicketFormsCard from './TicketFormsCard';
import TicketChecklistTemplatesPage from './TicketChecklistTemplatesPage';
import TimeTrackingSettingsCard from './TimeTrackingSettingsCard';
import { useJwtClaims } from '../../lib/authScope';
import { usePermissions } from '../../lib/permissions';
import { useHashTab } from '../../lib/useHashState';

export const TICKETING_HUB_TABS = [
  'statuses', 'priorities', 'categories', 'forms', 'email', 'templates', 'timeTracking',
] as const;
export type TicketingHubTab = (typeof TICKETING_HUB_TABS)[number];

// Tabs that require partner scope server-side (Forms/Email/Templates/Time capture
// all touch partner-wide config or PATCH /orgs/partners/me). BASE_TABS render for
// any scope.
const PARTNER_ONLY_TABS: Array<{ id: TicketingHubTab; labelKey: string }> = [
  { id: 'forms', labelKey: 'ticketingSettingsTabs.intakeForms' },
  { id: 'email', labelKey: 'ticketingSettingsTabs.email' },
  { id: 'templates', labelKey: 'ticketingSettingsTabs.templates' },
  { id: 'timeTracking', labelKey: 'ticketingSettingsTabs.timeCapture' },
];
const PARTNER_ONLY_TAB_IDS: readonly TicketingHubTab[] = PARTNER_ONLY_TABS.map((tab) => tab.id);

const BASE_TABS: Array<{ id: TicketingHubTab; labelKey: string }> = [
  { id: 'statuses', labelKey: 'ticketingSettingsTabs.statuses' },
  { id: 'priorities', labelKey: 'ticketingSettingsTabs.prioritiesSLAs' },
  { id: 'categories', labelKey: 'ticketingSettingsTabs.categories' },
];

/**
 * `/settings/ticketing` — single-level hash tabs, symmetrical with
 * PartnerBillingSettingsPage. Was embedded two-hash-levels deep in the Partner
 * hub (`#ticketing` then `#tab=`); the Partner hub's Ticketing tab is now a
 * link out to this page (see PartnerSettingsPage.tsx). All child components are
 * unchanged imports — only this shell's tab set and hash ownership changed.
 */
export default function TicketingSettingsTabs() {
  const { t } = useTranslation('settings');
  const { can } = usePermissions();
  const canReadMailbox = can('ticket_mailbox', 'read');

  // Renamed from `canManageInbound` (M8): the name predates the tab covering
  // Forms/Email/Templates/Time capture and is a local derived const only — grep
  // confirms zero usages outside this file and no wire-shape dependency.
  const jwt = useJwtClaims();
  const inboundAccess: 'unresolved' | 'allowed' | 'denied' =
    jwt.status === 'unresolved' ? 'unresolved' : jwt.claims.scope === 'partner' ? 'allowed' : 'denied';
  const canManagePartnerTicketing = inboundAccess === 'allowed';

  const TABS = [...BASE_TABS, ...(canManagePartnerTicketing ? PARTNER_ONLY_TABS : [])].map((tab) => ({
    ...tab,
    label: t(/* i18n-dynamic */ tab.labelKey),
  }));

  const [activeTab, setActiveTab] = useHashTab<TicketingHubTab>(TICKETING_HUB_TABS, 'statuses');

  const switchTab = (tab: TicketingHubTab) => {
    window.location.hash = tab;
    setActiveTab(tab);
  };

  return (
    <div className="space-y-6">
      <div role="tablist" className="flex flex-wrap gap-1 border-b" data-testid="ticketing-settings-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => switchTab(tab.id)}
            data-testid={`ticketing-tab-${tab.id}`}
            className={cn(
              'border-b-2 px-4 py-2 text-sm font-medium transition-colors -mb-px',
              activeTab === tab.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {inboundAccess === 'unresolved' && PARTNER_ONLY_TAB_IDS.includes(activeTab) && (
        <div data-testid="ticketing-tab-panel-pending" className="text-sm text-muted-foreground">
          {t('ticketingSettingsTabs.checkingAccess')}
        </div>
      )}

      {activeTab === 'statuses' && (
        <div data-testid="ticketing-tab-panel-statuses"><TicketStatusesTab /></div>
      )}
      {activeTab === 'priorities' && (
        <div data-testid="ticketing-tab-panel-priorities"><TicketPrioritiesTab /></div>
      )}
      {activeTab === 'categories' && <TicketCategoriesPage />}
      {activeTab === 'forms' && canManagePartnerTicketing && (
        <div data-testid="ticketing-tab-panel-forms"><TicketFormsCard /></div>
      )}
      {activeTab === 'email' && canManagePartnerTicketing && (
        <div data-testid="ticketing-tab-panel-email" className="space-y-6">
          <InboundEmailCard />
          {canReadMailbox ? <M365MailboxCard /> : null}
        </div>
      )}
      {activeTab === 'templates' && canManagePartnerTicketing && (
        <div data-testid="ticketing-tab-panel-templates" className="space-y-6">
          <CannedResponsesCard />
          <TicketChecklistTemplatesPage />
        </div>
      )}
      {activeTab === 'timeTracking' && canManagePartnerTicketing && (
        <div data-testid="ticketing-tab-panel-timeTracking"><TimeTrackingSettingsCard /></div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Add the locale keys** — `ticketingSettingsTabs.email`, `ticketingSettingsTabs.templates`, `ticketingSettingsTabs.timeCapture` (new); `ticketingSettingsTabs.export`/`inboundEmail`/`cannedResponses`/`timeTracking` (old keys) stay in the files (removing unused keys is Task 3's job, once `BASE_TABS`/`PARTNER_ONLY_TABS` above are the only readers) — add to `apps/web/src/locales/<locale>/settings.json`, inside the existing `ticketingSettingsTabs` object:

en: `"email": "Email", "templates": "Templates", "timeCapture": "Time capture"`
de-DE: `"email": "E-Mail", "templates": "Vorlagen", "timeCapture": "Zeiterfassung"`
es-419: `"email": "Correo electrónico", "templates": "Plantillas", "timeCapture": "Registro de tiempo"`
fr-CA: `"email": "Courriel", "templates": "Modèles", "timeCapture": "Saisie du temps"`
fr-FR: `"email": "E-mail", "templates": "Modèles", "timeCapture": "Saisie du temps"`
it-IT: `"email": "Email", "templates": "Modelli", "timeCapture": "Rilevazione tempo"`
pt-BR: `"email": "E-mail", "templates": "Modelos", "timeCapture": "Registro de tempo"`
tr-TR: `"email": "E-posta", "templates": "Şablonlar", "timeCapture": "Zaman kaydı"`

- [ ] **Step 5: Run the test file**

Run: `cd apps/web && npx vitest run src/components/settings/TicketingSettingsTabs.test.tsx`
Expected: PASS

- [ ] **Step 6: Run the locale contract tests**

Run: `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/settings/TicketingSettingsTabs.tsx apps/web/src/components/settings/TicketingSettingsTabs.test.tsx apps/web/src/locales/*/settings.json
git commit -m "refactor(web): repurpose TicketingSettingsTabs into single-level 7-tab shape (M0, M3, M5, M8)"
```

---

### Task 3: New `/settings/ticketing` page; Partner hub's Ticketing tab becomes a link (M0)

**Files:**
- Create: `apps/web/src/components/settings/TicketingHubPage.tsx`
- Create: `apps/web/src/pages/settings/ticketing/index.astro`
- Modify: `apps/web/src/pages/settings/ticketing.astro` (currently redirects to `/settings/partner#ticketing` — verified content: `return Astro.redirect('/settings/partner#ticketing', 301);`)
- Modify: `apps/web/src/components/settings/PartnerSettingsPage.tsx` (Ticketing `TabDef`/panel replaced by a link card)
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/{settings,pages}.json`
- Test: `apps/web/src/components/settings/TicketingHubPage.test.tsx` (new)
- Test: `apps/web/src/components/settings/PartnerSettingsPage.ticketingLink.test.tsx` (new)

**Interfaces:**
- Consumes: `TicketingSettingsTabs` (Task 2, no props).
- Produces: `TicketingHubPage()` (no props), mounted by the new `.astro` file.

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/web/src/components/settings/TicketingHubPage.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import TicketingHubPage from './TicketingHubPage';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '../../lib/i18n';

it('mounts the ticketing tabs at the top level', () => {
  render(<I18nextProvider i18n={i18n}><TicketingHubPage /></I18nextProvider>);
  expect(screen.getByTestId('ticketing-settings-tabs')).toBeInTheDocument();
});
```

```tsx
// apps/web/src/components/settings/PartnerSettingsPage.ticketingLink.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PartnerSettingsPage from './PartnerSettingsPage';
import { renderWithProviders } from '../../lib/testUtils'; // existing test helper used by PartnerSettingsPage's own suite

it('the Ticketing tab is a link to /settings/ticketing, not an embedded tab group', async () => {
  renderWithProviders(<PartnerSettingsPage />);
  await userEvent.click(await screen.findByTestId('partner-settings-tab-ticketing'));
  const link = await screen.findByTestId('partner-settings-ticketing-link');
  expect(link).toHaveAttribute('href', '/settings/ticketing');
  expect(screen.queryByTestId('ticketing-settings-tabs')).not.toBeInTheDocument();
});
```

(If `renderWithProviders` is not the actual helper name used by
`PartnerSettingsPage.test.tsx`, use whatever that existing suite's own render
wrapper is — read that file's imports before writing this step for real, since
this plan's placeholder name must match the real helper.)

- [ ] **Step 2: Run to confirm failure**

Run: `cd apps/web && npx vitest run src/components/settings/TicketingHubPage.test.tsx src/components/settings/PartnerSettingsPage.ticketingLink.test.tsx`
Expected: FAIL — `TicketingHubPage` module not found; `partner-settings-ticketing-link` not found (current markup embeds `TicketingSettingsTabs` directly).

- [ ] **Step 3: Create the page shell**

```tsx
// apps/web/src/components/settings/TicketingHubPage.tsx
import { useTranslation } from 'react-i18next';
import TicketingSettingsTabs from './TicketingSettingsTabs';

export default function TicketingHubPage() {
  const { t } = useTranslation('settings');
  return (
    <div className="space-y-6" data-testid="ticketing-hub-page">
      <div>
        <h1 className="text-xl font-semibold">{t('ticketingHubPage.heading')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('ticketingHubPage.description')}</p>
      </div>
      <TicketingSettingsTabs />
    </div>
  );
}
```

```astro
---
// apps/web/src/pages/settings/ticketing/index.astro
import DashboardLayout from '../../../layouts/DashboardLayout.astro';
import TicketingHubPage from '../../../components/settings/TicketingHubPage';
---

<DashboardLayout titleKey="titles.settingsTicketing">
  <TicketingHubPage client:load />
</DashboardLayout>
```

```astro
---
// apps/web/src/pages/settings/ticketing.astro
// Superseded standalone page moved to /settings/ticketing/ (M0). Old bookmarks to
// this exact path (no trailing content) still land correctly.
return Astro.redirect('/settings/ticketing', 301);
---
```

- [ ] **Step 4: Replace the embedded tab group in `PartnerSettingsPage.tsx` with a link card**

Read `apps/web/src/components/settings/PartnerSettingsPage.tsx` around line 699
(`<TicketingSettingsTabs syncHash={false} initialTab={...} />`) and the `ticketing`
`TabDef` at line 116 before editing — this step replaces that one render branch and
drops the now-dead `deepLinkTicketMailbox` capture (lines 183-189) since the M365
consent return no longer needs to deep-link into an embedded sub-tab; it redirects
straight to `/settings/ticketing#email` instead (Task 8 updates the M365 OAuth
consent-return URL builder to point there).

```tsx
// apps/web/src/components/settings/PartnerSettingsPage.tsx — replace the
// `{activeTab === 'ticketing' && ( ... <TicketingSettingsTabs .../> ... )}` block
{activeTab === 'ticketing' && (
  <div className="rounded-lg border bg-card p-6 shadow-xs" data-testid="partner-settings-ticketing-panel">
    <h2 className="text-lg font-semibold">{t('partnerSettingsPage.tabs.ticketing.label')}</h2>
    <p className="mt-1 text-sm text-muted-foreground">{t('partnerSettingsPage.tabs.ticketing.description')}</p>
    <a
      href="/settings/ticketing"
      data-testid="partner-settings-ticketing-link"
      className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
    >
      {t('partnerSettingsPage.tabs.ticketing.linkCta')}
    </a>
  </div>
)}
```

Also remove the `deepLinkTicketMailbox` `useState` capture (no longer read anywhere
once the embedded `TicketingSettingsTabs initialTab` prop is gone) and the now-dead
`import TicketingSettingsTabs from './TicketingSettingsTabs';` at the top of the
file.

- [ ] **Step 5: Update copy** — change `partnerSettingsPage.tabs.ticketing.description` (was: "Statuses, SLAs, exports") since exports move out (Task 10) and add `partnerSettingsPage.tabs.ticketing.linkCta` + `ticketingHubPage.heading`/`.description` + `titles.settingsTicketing`:

en (`settings.json`): `"description": "Statuses, SLAs, categories, forms"`, `"linkCta": "Manage ticketing settings →"`; `"ticketingHubPage": { "heading": "Ticketing Settings", "description": "Statuses, SLAs, categories, intake forms, email, templates and time capture — applied across all of your organizations." }`
en (`pages.json`, alongside the existing `"settingsBilling"` key): `"settingsTicketing": "Ticketing Settings"`

de-DE: description `"Status, SLAs, Kategorien, Formulare"`; linkCta `"Ticketing-Einstellungen verwalten →"`; ticketingHubPage heading `"Ticketing-Einstellungen"`, description `"Status, SLAs, Kategorien, Erfassungsformulare, E-Mail, Vorlagen und Zeiterfassung — für alle Organisationen."`; pages settingsTicketing `"Ticketing-Einstellungen"`

es-419: description `"Estados, SLA, categorías, formularios"`; linkCta `"Administrar configuración de tickets →"`; heading `"Configuración de tickets"`, description `"Estados, SLA, categorías, formularios de admisión, correo electrónico, plantillas y registro de tiempo, aplicados a todas tus organizaciones."`; pages settingsTicketing `"Configuración de tickets"`

fr-CA: description `"Statuts, ERS, catégories, formulaires"`; linkCta `"Gérer les paramètres de billetterie →"`; heading `"Paramètres de billetterie"`, description `"Statuts, ERS, catégories, formulaires d'admission, courriel, modèles et saisie du temps, appliqués à toutes vos organisations."`; pages settingsTicketing `"Paramètres de billetterie"`

fr-FR: description `"Statuts, SLA, catégories, formulaires"`; linkCta `"Gérer les paramètres de tickets →"`; heading `"Paramètres de tickets"`, description `"Statuts, SLA, catégories, formulaires d'admission, e-mail, modèles et saisie du temps, appliqués à toutes vos organisations."`; pages settingsTicketing `"Paramètres de tickets"`

it-IT: description `"Stati, SLA, categorie, moduli"`; linkCta `"Gestisci impostazioni ticket →"`; heading `"Impostazioni ticket"`, description `"Stati, SLA, categorie, moduli di apertura, email, modelli e rilevazione del tempo, applicati a tutte le tue organizzazioni."`; pages settingsTicketing `"Impostazioni ticket"`

pt-BR: description `"Status, SLAs, categorias, formulários"`; linkCta `"Gerenciar configurações de tickets →"`; heading `"Configurações de tickets"`, description `"Status, SLAs, categorias, formulários de abertura, e-mail, modelos e registro de tempo, aplicados a todas as suas organizações."`; pages settingsTicketing `"Configurações de tickets"`

tr-TR: description `"Durumlar, SLA'lar, kategoriler, formlar"`; linkCta `"Bilet ayarlarını yönet →"`; heading `"Bilet Ayarları"`, description `"Tüm organizasyonlarınıza uygulanan durumlar, SLA'lar, kategoriler, giriş formları, e-posta, şablonlar ve zaman kaydı."`; pages settingsTicketing `"Bilet Ayarları"`

- [ ] **Step 6: Run tests**

Run: `cd apps/web && npx vitest run src/components/settings/TicketingHubPage.test.tsx src/components/settings/PartnerSettingsPage.ticketingLink.test.tsx src/components/settings/PartnerSettingsPage.test.tsx`
Expected: PASS

- [ ] **Step 7: Run locale contract tests and commit**

Run: `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts`
Expected: PASS

```bash
git add apps/web/src/components/settings/TicketingHubPage.tsx apps/web/src/pages/settings/ticketing/index.astro apps/web/src/pages/settings/ticketing.astro apps/web/src/components/settings/PartnerSettingsPage.tsx apps/web/src/components/settings/TicketingHubPage.test.tsx apps/web/src/components/settings/PartnerSettingsPage.ticketingLink.test.tsx apps/web/src/locales/*/settings.json apps/web/src/locales/*/pages.json
git commit -m "feat(web): stand up /settings/ticketing; Partner hub Ticketing tab links out (M0)"
```

---

### Task 4: Redirect old ticketing sub-tab URLs and add the Sidebar entry (M0 cont'd)

The old two-level URL was `/settings/partner#ticketing` then a client-side
`#tab=<sub>` fragment owned entirely by `TicketingSettingsTabs`'s own hash listener
(never server-redirectable, since both fragments live on the client). Any
`#tab=<old-id>` deep link a user has bookmarked from the old embed only works if
the fragment maps onto a tab id `TicketingSettingsTabs` still recognizes. Since
`useHashTab` (Task 2) already falls back to the default tab (`statuses`) for any
unrecognized hash, `#tab=inbound` and `#tab=canned` bookmarks silently land on
Statuses instead of 404ing — acceptable for Wave 0 (no data loss, just a
non-precise landing tab); document this explicitly rather than silently accept it.

**Files:**
- Modify: `apps/web/src/components/layout/Sidebar.tsx`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/common.json` (nav label)
- Test: `apps/web/src/components/layout/Sidebar.test.tsx` (existing — extend)

**Interfaces:**
- Consumes: route `/settings/ticketing` (Task 3).
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/layout/Sidebar.test.tsx (append)
it('lists a Ticketing item under Settings, linking to /settings/ticketing', () => {
  renderSidebar({ partnerScope: true }); // existing helper in this file
  const item = screen.getByRole('link', { name: /ticketing/i });
  expect(item).toHaveAttribute('href', '/settings/ticketing');
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd apps/web && npx vitest run src/components/layout/Sidebar.test.tsx`
Expected: FAIL — no link with that accessible name.

- [ ] **Step 3: Add the nav item** — in the Settings section's `items` array (the block containing `{ name: 'Partner', ... href: '/settings/partner', ... }`, `{ name: 'Billing', ... href: '/settings/billing', ... }`):

```tsx
{ name: 'Ticketing', labelKey: 'nav.ticketing', href: '/settings/ticketing', icon: Ticket, partnerScopeOnly: true },
```

(`Ticket` icon is already imported in `Sidebar.tsx` — verified used by
`PartnerSettingsPage.tsx`'s own `TAB_GROUPS` `icon: Ticket` reference for the same
concept; confirm the same `lucide-react` import exists in `Sidebar.tsx` and reuse
it, do not add a duplicate import under a different local name.)

- [ ] **Step 4: Add the locale key** `nav.ticketing` to `common.json` in all 8 locales:

en `"Ticketing"`, de-DE `"Ticketing"`, es-419 `"Tickets"`, fr-CA `"Billetterie"`, fr-FR `"Tickets"`, it-IT `"Ticket"`, pt-BR `"Tickets"`, tr-TR `"Bilet Sistemi"`

- [ ] **Step 5: Run tests**

Run: `cd apps/web && npx vitest run src/components/layout/Sidebar.test.tsx`
Expected: PASS

- [ ] **Step 6: Run the guard test from Task 1** — it should now report ticketing-related paths as resolved (it was never failing on ticketing.astro/ticketing/index.astro to begin with, since `isRedirectOnly` and route matching already covered them; this step exists to catch any regression)

Run: `cd apps/web && npx vitest run src/lib/__tests__/settingsPageRegistry.test.ts`
Expected: still shows the two templates-page failures from Task 1 (unchanged until Task 7) — no new failures.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/layout/Sidebar.tsx apps/web/src/components/layout/Sidebar.test.tsx apps/web/src/locales/*/common.json
git commit -m "feat(web): add Ticketing sidebar entry under Settings (M0)"
```

---

### Task 5: Redirect `/settings/organizations/[id]/billing` to the tab (M1)

Verified current file mounts `OrgBillingSettings` standalone with no redirect
(`apps/web/src/pages/settings/organizations/[id]/billing.astro`). The org settings
page's own Billing tab hash is `billing` (verified:
`apps/web/src/components/settings/OrgSettingsPage.tsx:69`,
`{ key: 'billing', hash: 'billing', ... }`), mounted at
`apps/web/src/pages/settings/organizations/[id].astro`. Target:
`/settings/organizations/<id>#billing`.

**Files:**
- Modify: `apps/web/src/pages/settings/organizations/[id]/billing.astro`
- Modify: `e2e-tests/pages/OrgBillingSettingsPage.ts`
- Modify: `e2e-tests/tests/multi-currency.spec.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Write the failing e2e assertion** — `e2e-tests/pages/OrgBillingSettingsPage.ts` currently (verified) exposes `url = (orgId) => \`/settings/organizations/${orgId}/billing\`` used by `multi-currency.spec.ts:99`. Add a redirect-following navigation and assert the landed URL:

```ts
// e2e-tests/pages/OrgBillingSettingsPage.ts (add alongside the existing url())
/** The current canonical tab URL — where the old standalone URL now redirects to. */
tabUrl = (orgId: string) => `/settings/organizations/${orgId}#billing`;

async gotoLegacyUrlAndExpectRedirect(orgId: string) {
  await this.page.goto(this.url(orgId));
  await this.page.waitForURL(`**${this.tabUrl(orgId)}`);
}
```

```ts
// e2e-tests/tests/multi-currency.spec.ts (add a new test near the existing billing.url() usage)
test('the legacy standalone billing URL redirects to the org settings Billing tab', async ({ page }) => {
  const billing = new OrgBillingSettingsPage(page);
  await billing.gotoLegacyUrlAndExpectRedirect(orgId); // orgId from the existing test fixture in this file
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd e2e-tests && npx playwright test multi-currency.spec.ts -g "legacy standalone billing URL"`
Expected: FAIL — `waitForURL` times out (the page currently stays on `/billing`, no redirect).

- [ ] **Step 3: Implement the redirect**

```astro
---
// apps/web/src/pages/settings/organizations/[id]/billing.astro
// Standalone URL retired (M1) — the org settings page's own Billing tab is now the
// single entry point (audit finding A2: "two URLs, no redirect between them").
const { id } = Astro.params;
if (!id) return Astro.redirect('/organizations');
return Astro.redirect(`/settings/organizations/${id}#billing`, 301);
---
```

- [ ] **Step 4: Run e2e test**

Run: `cd e2e-tests && npx playwright test multi-currency.spec.ts -g "legacy standalone billing URL"`
Expected: PASS

- [ ] **Step 5: Run the guard test** — confirm `organizations/[id]/billing.astro` is now recognized as a redirect

Run: `cd apps/web && npx vitest run src/lib/__tests__/settingsPageRegistry.test.ts`
Expected: unchanged pass/fail set from Task 4 (this file was never failing — it has no nav entry today either, but `isRedirectOnly` only starts returning true after this step; verify it did NOT silently need an allowlist entry before this step landed — if it did, that is a real gap Task 1 should have caught and this step closes it).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/settings/organizations/\[id\]/billing.astro e2e-tests/pages/OrgBillingSettingsPage.ts e2e-tests/tests/multi-currency.spec.ts
git commit -m "fix(web): redirect standalone org billing URL to the settings tab (M1)"
```

---

### Task 6: Delete dead `TicketingSettingsPage.tsx`; redirect `/settings/webhooks` (M2)

Verified: `rg -ln "TicketingSettingsPage" apps/web/src apps/web/e2e-tests` returns only
`TicketingSettingsPage.tsx` and `TicketingSettingsPage.test.tsx` themselves, plus one
unrelated hit in `e2e-tests/release-checklist-v0.70-results.md` (a historical
markdown log, not code — leave it, it's a dated record, not a live reference).
Verified: `apps/web/src/pages/settings/webhooks/index.astro` mounts `WebhooksPage`
directly (no redirect today); `apps/web/src/pages/integrations/webhooks/index.astro`
exists as the other entry point (not read in full here — confirm it also mounts
`WebhooksPage` before assuming it's the right redirect target, since the audit
flagged this pair "not fully verified").

**Files:**
- Delete: `apps/web/src/components/settings/TicketingSettingsPage.tsx`
- Delete: `apps/web/src/components/settings/TicketingSettingsPage.test.tsx`
- Modify: `apps/web/src/pages/settings/webhooks/index.astro`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed later.

- [ ] **Step 1: Confirm the redirect target renders the same component** — before writing the redirect, read `apps/web/src/pages/integrations/webhooks/index.astro` and confirm it imports `WebhooksPage` from the same path as `apps/web/src/pages/settings/webhooks/index.astro` (`../../../components/webhooks/WebhooksPage`, adjusted for the different directory depth). If it renders something else, stop and flag this step — the audit's "not fully verified" note means this is the one fact in M2 to re-check before writing the redirect, not to assume.

- [ ] **Step 2: Write the failing test** — add a route-registry style assertion:

```ts
// apps/web/src/lib/__tests__/settingsPageRegistry.test.ts — this file's ALLOWLIST
// does not need an entry for webhooks/index.astro once it's a redirect; add one
// targeted test instead, in a new small file:
```

```ts
// apps/web/src/pages/settings/webhooks/__tests__/redirect.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

it('redirects to /integrations#webhooks', () => {
  const src = readFileSync(resolve(__dirname, '../index.astro'), 'utf-8');
  expect(src).toMatch(/Astro\.redirect\(['"]\/integrations#webhooks['"]/);
});
```

- [ ] **Step 3: Run to confirm it fails**

Run: `cd apps/web && npx vitest run src/pages/settings/webhooks/__tests__/redirect.test.ts`
Expected: FAIL — current file mounts `WebhooksPage`, no `Astro.redirect` call.

- [ ] **Step 4: Delete the dead files and write the redirect**

```bash
git rm apps/web/src/components/settings/TicketingSettingsPage.tsx apps/web/src/components/settings/TicketingSettingsPage.test.tsx
```

```astro
---
// apps/web/src/pages/settings/webhooks/index.astro
// Duplicate of /integrations#webhooks (same WebhooksPage component, two URLs,
// audit finding A6). Redirect to the one surviving entry point.
return Astro.redirect('/integrations#webhooks', 301);
---
```

- [ ] **Step 5: Run the new test and the guard test**

Run: `cd apps/web && npx vitest run src/pages/settings/webhooks/__tests__/redirect.test.ts src/lib/__tests__/settingsPageRegistry.test.ts`
Expected: PASS; guard test's failing set unchanged from Task 5 (this path was
already unlinked-but-not-yet-a-redirect before this step — same reasoning as
Task 5 Step 5; if it was flagged, this step is the fix).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/settings/webhooks/index.astro apps/web/src/pages/settings/webhooks/__tests__/redirect.test.ts
git commit -m "chore(web): delete dead TicketingSettingsPage; redirect duplicate webhooks URL (M2)"
```

Note (audit §5 M2, deferred): dropping the org settings page's dead `contacts`/
`contracts` tabs ("after one release") is explicitly **not** in this task — leave
`apps/web/src/components/settings/OrgSettingsPage.tsx`'s `contacts`/`contracts`
`TabKey`s and their redirect-`useEffect`s untouched.

---

### Task 7: Nav entry for Deliverable templates; checklist templates already folded (M3)

Checklist templates were already absorbed into the Ticketing hub's Templates tab in
Task 2 (`TicketChecklistTemplatesPage` mounted alongside `CannedResponsesCard`).
This task removes `apps/web/src/pages/settings/ticket-checklist-templates.astro` as
a now-redundant second entry point and gives Deliverable Templates its Billing nav
entry (audit §4: "Deliverable templates move under Billing … with a nav entry").
This is also what turns Task 1's guard test green for both previously-orphaned
pages.

**Files:**
- Modify: `apps/web/src/pages/settings/ticket-checklist-templates.astro` (becomes a redirect to `/settings/ticketing#templates`)
- Modify: `apps/web/src/components/layout/Sidebar.tsx` (new `Deliverable Templates` item in the Billing section)
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/common.json`

**Interfaces:**
- Consumes: `/settings/ticketing#templates` (Task 2/3).
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/web/src/components/layout/Sidebar.test.tsx (append)
it('lists Deliverable Templates under the Billing nav section', () => {
  renderSidebar({ partnerScope: true, serviceManagementMode: 'native' });
  const item = screen.getByRole('link', { name: /deliverable templates/i });
  expect(item).toHaveAttribute('href', '/settings/deliverable-templates');
});
```

```ts
// apps/web/src/pages/settings/__tests__/checklistTemplatesRedirect.test.ts
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

it('ticket-checklist-templates.astro redirects into the Ticketing hub Templates tab', () => {
  const src = readFileSync(resolve(__dirname, '../ticket-checklist-templates.astro'), 'utf-8');
  expect(src).toMatch(/Astro\.redirect\(['"]\/settings\/ticketing#templates['"]/);
});
```

- [ ] **Step 2: Run to confirm both fail**

Run: `cd apps/web && npx vitest run src/components/layout/Sidebar.test.tsx src/pages/settings/__tests__/checklistTemplatesRedirect.test.ts`
Expected: FAIL on both.

- [ ] **Step 3: Redirect the standalone checklist-templates page**

```astro
---
// apps/web/src/pages/settings/ticket-checklist-templates.astro
// Folded into the Ticketing hub's Templates tab alongside canned responses (M3).
return Astro.redirect('/settings/ticketing#templates', 301);
---
```

- [ ] **Step 4: Add the Sidebar entry** — in the Billing nav section's `items` array (alongside `{ name: 'Product Catalog', ... href: '/settings/catalog', ... }`):

```tsx
{ name: 'Deliverable Templates', labelKey: 'nav.deliverableTemplates', href: '/settings/deliverable-templates', icon: LayoutTemplate, partnerScopeOnly: true },
```

(`LayoutTemplate` is the icon `DeliverableTemplatesPage.tsx` itself imports from
`lucide-react` — verified at the top of that file — reuse the same icon name in
`Sidebar.tsx`'s existing `lucide-react` import list.)

- [ ] **Step 5: Add the locale key** `nav.deliverableTemplates`:

en `"Deliverable Templates"`, de-DE `"Liefervorlagen"`, es-419 `"Plantillas de entregables"`, fr-CA `"Modèles de livrables"`, fr-FR `"Modèles de livrables"`, it-IT `"Modelli di consegna"`, pt-BR `"Modelos de entregáveis"`, tr-TR `"Teslimat Şablonları"`

- [ ] **Step 6: Run tests**

Run: `cd apps/web && npx vitest run src/components/layout/Sidebar.test.tsx src/pages/settings/__tests__/checklistTemplatesRedirect.test.ts`
Expected: PASS

- [ ] **Step 7: Run the M9 guard test — this is the step that turns it green**

Run: `cd apps/web && npx vitest run src/lib/__tests__/settingsPageRegistry.test.ts`
Expected: PASS (all pages now nav-linked, index-linked, redirected, or allowlisted — `ticket-checklist-templates.astro` is now `isRedirectOnly`; `deliverable-templates.astro` route fragment `/settings/deliverable-templates` now appears in `Sidebar.tsx`).

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/pages/settings/ticket-checklist-templates.astro apps/web/src/components/layout/Sidebar.tsx apps/web/src/components/layout/Sidebar.test.tsx apps/web/src/pages/settings/__tests__/checklistTemplatesRedirect.test.ts apps/web/src/locales/*/common.json
git commit -m "feat(web): fold checklist templates into Ticketing Templates tab; nav entry for deliverable templates (M3) — settings page registry guard now green"
```

---

### Task 8: Split Billing settings into Defaults / Documents / Connections tabs (M4 part 1)

Verified current shape: `PartnerBillingSettings.tsx` (470 lines) is a **single flat
component with no tab mechanism at all** — two `<section>` cards ("Defaults",
"Company") and one page-level Save that PATCHes `/partner/billing-settings` with
every field every time (verified full payload construction, lines 129-156).
Verified API contract (`apps/api/src/services/invoiceService.ts:886-939`,
`packages/shared/src/validators/invoices.ts` `partnerBillingSettingsSchema`):
`currencyCode`, `invoiceNumberPrefix`, `invoiceTermsDays` are **required** on every
PATCH; every other field is `!== undefined`-guarded (a partial payload for those is
safe; the three required fields are not). This task introduces a tabbed shell that
still submits one shared payload — the split is presentational only.

**Files:**
- Delete: `apps/web/src/components/billing/PartnerBillingSettings.tsx`
- Delete: `apps/web/src/components/billing/PartnerBillingSettings.test.tsx` (existing — content migrates into the new files' tests, see Step 3)
- Create: `apps/web/src/components/billing/PartnerBillingSettingsPage.tsx`
- Create: `apps/web/src/components/billing/BillingDefaultsTab.tsx`
- Create: `apps/web/src/components/billing/BillingDocumentsTab.tsx`
- Modify: `apps/web/src/pages/settings/billing.astro`
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (`TARGET_GLOBS`: remove `src/components/billing/PartnerBillingSettings.tsx`, add `src/components/billing/PartnerBillingSettingsPage.tsx`)
- Test: `apps/web/src/components/billing/PartnerBillingSettingsPage.test.tsx` (new)
- Test: `apps/web/src/components/billing/BillingDefaultsTab.test.tsx` (new)
- Test: `apps/web/src/components/billing/BillingDocumentsTab.test.tsx` (new)
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/{settings,pages}.json`

**Interfaces:**
- Consumes: `currencyLabel`/`currencyOptions` (`@/lib/currencies`), `pctFromFraction` (`./invoiceTypes`), `isHttpUrl`/`httpUrlErrorMessage` (`@breeze/shared`), `resetPartnerCurrencyCache` (`@/lib/partnerCurrencyCache`) — all unchanged.
- Produces: `PartnerBillingSettingsPage()` (no props) owns load/save state and passes typed props down to `BillingDefaultsTab` and `BillingDocumentsTab`:
  ```ts
  type BillingFormState = {
    currencyCode: string; taxPercent: string; prefix: string; termsDays: string;
    autoEmailInvoice: boolean; deviceAppendix: boolean; footer: string;
    documentTheme: 'classic' | 'condensed'; documentPageSize: 'letter' | 'a4';
    companyName: string; phone: string; website: string;
    addr1: string; addr2: string; city: string; region: string; postal: string; country: string; terms: string;
  };
  type BillingFormSetters = { [K in keyof BillingFormState as `set${Capitalize<K>}`]: (v: BillingFormState[K]) => void };
  ```
  (Note: `markupPercent`/`autoTaxHardware`/`aiStyle` are **removed** from this state — they move to `CatalogDefaultsCard` in Task 9, which owns its own load/save of the same three fields against the same endpoint.)

- [ ] **Step 1: Write the failing test for the new shell**

```tsx
// apps/web/src/components/billing/PartnerBillingSettingsPage.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '../../lib/i18n';
import PartnerBillingSettingsPage from './PartnerBillingSettingsPage';

// fetchWithAuth mock follows the same pattern as the deleted
// PartnerBillingSettings.test.tsx — read that file's mock setup before writing
// this for real and reuse its GET/PATCH fixture shape for /orgs/partners/me and
// /partner/billing-settings.

it('has three visible tabs: Defaults, Documents, Connections', async () => {
  render(<I18nextProvider i18n={i18n}><PartnerBillingSettingsPage /></I18nextProvider>);
  expect(await screen.findByTestId('billing-settings-tab-defaults')).toBeInTheDocument();
  expect(screen.getByTestId('billing-settings-tab-documents')).toBeInTheDocument();
  expect(screen.getByTestId('billing-settings-tab-connections')).toBeInTheDocument();
});

it('reserves a Rates slot for #4628 W02 without rendering it (do not remove — see "Conflicts with #4628")', async () => {
  render(<I18nextProvider i18n={i18n}><PartnerBillingSettingsPage /></I18nextProvider>);
  await screen.findByTestId('billing-settings-tab-defaults');
  expect(screen.queryByTestId('billing-settings-tab-rates')).not.toBeInTheDocument();
});

it('one Save button submits the full payload regardless of which tab is active', async () => {
  render(<I18nextProvider i18n={i18n}><PartnerBillingSettingsPage /></I18nextProvider>);
  await userEvent.click(await screen.findByTestId('billing-settings-tab-documents'));
  expect(screen.getByTestId('partner-billing-save')).toBeInTheDocument();
  expect(screen.queryByTestId('partner-billing-markup')).not.toBeInTheDocument(); // moved to Catalog (M4 part 2)
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd apps/web && npx vitest run src/components/billing/PartnerBillingSettingsPage.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Build the shell + two tabs** — the shell owns exactly the same `load`/`save` logic as the deleted `PartnerBillingSettings.tsx` (lines 73-175), minus the three catalog fields; the two tab components are pure presentational, receiving state+setters as props.

```tsx
// apps/web/src/components/billing/PartnerBillingSettingsPage.tsx
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, handleActionError } from '../../lib/runAction';
import { pctFromFraction } from './invoiceTypes';
import { isHttpUrl } from '@breeze/shared';
import { resetPartnerCurrencyCache } from '@/lib/partnerCurrencyCache';
import { useHashTab } from '../../lib/useHashState';
import BillingDefaultsTab from './BillingDefaultsTab';
import BillingDocumentsTab from './BillingDocumentsTab';
// `BillingConnectionsTab` does not exist yet — Task 11 creates it and swaps out
// the inline placeholder panel below for the real import. Keeping this task's
// own diff buildable/testable on its own (no forward dependency on a later
// task's file) is why the Connections panel starts as a placeholder here.

const UNAUTHORIZED = () => void navigateTo('/login', { replace: true });
// `rates` is NOT in BILLING_TABS: it is a reserved slot in the TABS config below
// (a typed entry with no button and no panel), not a selectable/hash-addressable
// tab yet. #4628 W02 adds the Rates panel and flips that one entry's `reserved`
// flag — it does not re-order or re-lay-out this page. Do not add 'rates' to
// this array or to activeTab's type until #4628 W02 does so itself.
const BILLING_TABS = ['defaults', 'documents', 'connections'] as const;
type BillingTab = (typeof BILLING_TABS)[number];

interface PartnerBilling {
  currencyCode: string; defaultTaxRate: string | null; invoiceNumberPrefix: string; invoiceTermsDays: number;
  autoEmailInvoiceOnQuoteAccept: boolean; invoiceDeviceAppendix: boolean; invoiceFooter: string | null;
  documentTheme: 'classic' | 'condensed'; documentPageSize: 'letter' | 'a4';
  billingCompanyName: string | null; billingPhone: string | null; billingWebsite: string | null;
  billingAddressLine1: string | null; billingAddressLine2: string | null; billingAddressCity: string | null;
  billingAddressRegion: string | null; billingAddressPostalCode: string | null; billingAddressCountry: string | null;
  billingTermsAndConditions: string | null;
}

export default function PartnerBillingSettingsPage() {
  const { t } = useTranslation('billing');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useHashTab<BillingTab>(BILLING_TABS, 'defaults');

  const [currencyCode, setCurrencyCode] = useState('USD');
  const [taxPercent, setTaxPercent] = useState('');
  const [prefix, setPrefix] = useState('INV');
  const [termsDays, setTermsDays] = useState('30');
  const [autoEmailInvoice, setAutoEmailInvoice] = useState(true);
  const [deviceAppendix, setDeviceAppendix] = useState(false);
  const [footer, setFooter] = useState('');
  const [documentTheme, setDocumentTheme] = useState<'classic' | 'condensed'>('classic');
  const [documentPageSize, setDocumentPageSize] = useState<'letter' | 'a4'>('letter');
  const [companyName, setCompanyName] = useState('');
  const [phone, setPhone] = useState('');
  const [website, setWebsite] = useState('');
  const [addr1, setAddr1] = useState('');
  const [addr2, setAddr2] = useState('');
  const [city, setCity] = useState('');
  const [region, setRegion] = useState('');
  const [postal, setPostal] = useState('');
  const [country, setCountry] = useState('');
  const [terms, setTerms] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetchWithAuth('/orgs/partners/me');
      if (res.status === 401) return UNAUTHORIZED();
      if (!res.ok) throw new Error('load failed');
      const p = (await res.json()) as PartnerBilling;
      setCurrencyCode(p.currencyCode ?? 'USD');
      setTaxPercent(pctFromFraction(p.defaultTaxRate));
      setPrefix(p.invoiceNumberPrefix ?? 'INV');
      setTermsDays(String(p.invoiceTermsDays ?? 30));
      setAutoEmailInvoice(p.autoEmailInvoiceOnQuoteAccept !== false);
      setDeviceAppendix(p.invoiceDeviceAppendix === true);
      setFooter(p.invoiceFooter ?? '');
      setDocumentTheme(p.documentTheme ?? 'classic');
      setDocumentPageSize(p.documentPageSize ?? 'letter');
      setCompanyName(p.billingCompanyName ?? '');
      setPhone(p.billingPhone ?? '');
      setWebsite(p.billingWebsite ?? '');
      setAddr1(p.billingAddressLine1 ?? '');
      setAddr2(p.billingAddressLine2 ?? '');
      setCity(p.billingAddressCity ?? '');
      setRegion(p.billingAddressRegion ?? '');
      setPostal(p.billingAddressPostalCode ?? '');
      setCountry(p.billingAddressCountry ?? '');
      setTerms(p.billingTermsAndConditions ?? '');
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const websiteTrimmed = website.trim();
  const websiteInvalid = websiteTrimmed !== '' && !isHttpUrl(websiteTrimmed);

  const save = useCallback(async () => {
    if (saving || websiteInvalid) return;
    setSaving(true);
    try {
      const pct = taxPercent.trim();
      const defaultTaxRate = pct === '' ? null : Number(pct) / 100;
      await runAction({
        request: () => fetchWithAuth('/partner/billing-settings', {
          method: 'PATCH',
          body: JSON.stringify({
            currencyCode: currencyCode.trim().toUpperCase(),
            defaultTaxRate,
            invoiceNumberPrefix: prefix.trim(),
            invoiceTermsDays: Number(termsDays),
            autoEmailInvoiceOnQuoteAccept: autoEmailInvoice,
            invoiceDeviceAppendix: deviceAppendix,
            invoiceFooter: footer.trim() === '' ? null : footer,
            documentTheme,
            documentPageSize,
            billingCompanyName: companyName.trim() === '' ? null : companyName.trim(),
            billingPhone: phone.trim() === '' ? null : phone.trim(),
            billingWebsite: website.trim() === '' ? null : website.trim(),
            billingAddressLine1: addr1.trim() === '' ? null : addr1.trim(),
            billingAddressLine2: addr2.trim() === '' ? null : addr2.trim(),
            billingAddressCity: city.trim() === '' ? null : city.trim(),
            billingAddressRegion: region.trim() === '' ? null : region.trim(),
            billingAddressPostalCode: postal.trim() === '' ? null : postal.trim(),
            billingAddressCountry: country.trim() === '' ? null : country.trim().toUpperCase(),
            billingTermsAndConditions: terms.trim() === '' ? null : terms,
          }),
        }),
        errorFallback: t('partnerBillingSettings.saveError'),
        successMessage: t('partnerBillingSettings.saveSuccess'),
        onUnauthorized: UNAUTHORIZED,
      });
      resetPartnerCurrencyCache();
      void load();
    } catch (err) {
      handleActionError(err, t('partnerBillingSettings.saveError'));
    } finally {
      setSaving(false);
    }
  }, [saving, websiteInvalid, currencyCode, taxPercent, prefix, termsDays, autoEmailInvoice, deviceAppendix,
      footer, documentTheme, documentPageSize, companyName, phone, website, addr1, addr2, city, region, postal, country, terms, load, t]);

  if (loading) return <p className="text-sm text-muted-foreground">{t('partnerBillingSettings.loading')}</p>;
  if (loadError) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground" data-testid="partner-billing-load-error">
        {t('partnerBillingSettings.loadError')}{' '}
        <button type="button" onClick={() => void load()} className="underline hover:text-foreground">{t('common:actions.retry')}</button>
      </div>
    );
  }

  // Tab order is Defaults · Documents · Rates (reserved) · Connections — the
  // audit's target layout (§4). `rates` is a typed, unrendered placeholder so
  // #4628 W02 can add the real tab as a one-entry diff (flip `reserved` off,
  // supply a real labelKey) instead of re-laying-out this array. Never remove
  // or reorder this entry.
  const TABS: Array<{ id: BillingTab | 'rates'; labelKey: string; reserved?: true }> = [
    { id: 'defaults', labelKey: 'partnerBillingSettingsTabs.defaults' },
    { id: 'documents', labelKey: 'partnerBillingSettingsTabs.documents' },
    { id: 'rates', labelKey: 'partnerBillingSettingsTabs.rates', reserved: true },
    { id: 'connections', labelKey: 'partnerBillingSettingsTabs.connections' },
  ];
  // Cast is safe: filtering out `reserved` entries leaves only real BillingTab
  // ids, but TS can't narrow a `.filter()` predicate without a type guard —
  // a plain cast here is simpler than one and this array is tiny and local.
  const renderedTabs = TABS.filter((tab) => !tab.reserved) as Array<{ id: BillingTab; labelKey: string }>;

  return (
    <div className="space-y-6" data-testid="partner-billing-settings">
      <div role="tablist" className="flex gap-1 border-b" data-testid="billing-settings-tabs">
        {renderedTabs.map((tab) => (
          <button
            key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id}
            onClick={() => { window.location.hash = tab.id; setActiveTab(tab.id); }}
            data-testid={`billing-settings-tab-${tab.id}`}
            className={activeTab === tab.id ? 'border-b-2 border-primary px-4 py-2 text-sm font-medium -mb-px' : 'border-b-2 border-transparent px-4 py-2 text-sm font-medium text-muted-foreground -mb-px'}
          >
            {t(/* i18n-dynamic */ tab.labelKey)}
          </button>
        ))}
      </div>

      {activeTab === 'defaults' && (
        <BillingDefaultsTab
          currencyCode={currencyCode} setCurrencyCode={setCurrencyCode}
          taxPercent={taxPercent} setTaxPercent={setTaxPercent}
          prefix={prefix} setPrefix={setPrefix}
          termsDays={termsDays} setTermsDays={setTermsDays}
        />
      )}
      {activeTab === 'documents' && (
        <BillingDocumentsTab
          autoEmailInvoice={autoEmailInvoice} setAutoEmailInvoice={setAutoEmailInvoice}
          deviceAppendix={deviceAppendix} setDeviceAppendix={setDeviceAppendix}
          footer={footer} setFooter={setFooter}
          documentTheme={documentTheme} setDocumentTheme={setDocumentTheme}
          documentPageSize={documentPageSize} setDocumentPageSize={setDocumentPageSize}
          companyName={companyName} setCompanyName={setCompanyName}
          phone={phone} setPhone={setPhone}
          website={website} setWebsite={setWebsite} websiteInvalid={websiteInvalid}
          addr1={addr1} setAddr1={setAddr1} addr2={addr2} setAddr2={setAddr2}
          city={city} setCity={setCity} region={region} setRegion={setRegion}
          postal={postal} setPostal={setPostal} country={country} setCountry={setCountry}
          terms={terms} setTerms={setTerms}
        />
      )}
      {/* Task 11 (M6) replaces this placeholder with the real <BillingConnectionsTab />
          import once that file exists — see the note above the imports. */}
      {activeTab === 'connections' && (
        <div data-testid="billing-connections-tab-placeholder" className="text-sm text-muted-foreground">
          {t('partnerBillingSettingsTabs.connectionsComingSoon')}
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="button" onClick={() => void save()} disabled={saving || websiteInvalid}
          data-testid="partner-billing-save"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {saving ? t('common:states.saving') : t('partnerBillingSettings.saveButton')}
        </button>
      </div>
    </div>
  );
}
```

`BillingDefaultsTab.tsx` and `BillingDocumentsTab.tsx` are the exact JSX already
verified in `PartnerBillingSettings.tsx` lines 194-251 (currency/tax/prefix/terms)
and lines 268-457 (auto-email through Company card), respectively, converted to
accept the props above instead of closing over local state — copy those verified
JSX blocks into the two new files with `data-testid` attributes unchanged (every
`data-testid="partner-billing-*"` in the deleted file must reappear verbatim in
whichever new file now owns that field, since e2e specs and existing unit tests key
off them).

- [ ] **Step 4: Mount the new shell**

```astro
---
// apps/web/src/pages/settings/billing.astro
import DashboardLayout from '../../layouts/DashboardLayout.astro';
import PartnerBillingSettingsPage from '../../components/billing/PartnerBillingSettingsPage';
import { tServer } from '../../lib/i18n/server';

const locale = Astro.locals.locale;
---

<DashboardLayout titleKey="titles.settingsBilling">
  <div class="space-y-6">
    <div>
      <h1 class="text-xl font-semibold">{tServer(locale, 'settingsBillingPage.heading')}</h1>
      <p class="mt-1 text-sm text-muted-foreground">
        {tServer(locale, 'settingsBillingPage.description')}
      </p>
    </div>
    <PartnerBillingSettingsPage client:load />
  </div>
</DashboardLayout>
```

- [ ] **Step 5: Add locale keys** — `partnerBillingSettingsTabs.{defaults,documents,connections,connectionsComingSoon}` (the last one is Task 8's own placeholder text — Task 11 removes it once the real Connections panel replaces the placeholder, in the same task that removes the key's only reader):

en: `"defaults": "Defaults", "documents": "Documents", "connections": "Connections", "connectionsComingSoon": "Connections are being wired up in a follow-up step of this wave."`
de-DE: `"defaults": "Standardwerte", "documents": "Dokumente", "connections": "Verbindungen", "connectionsComingSoon": "Verbindungen werden in einem folgenden Schritt dieser Welle eingerichtet."`
es-419: `"defaults": "Valores predeterminados", "documents": "Documentos", "connections": "Conexiones", "connectionsComingSoon": "Las conexiones se están configurando en un paso posterior de esta ola."`
fr-CA: `"defaults": "Valeurs par défaut", "documents": "Documents", "connections": "Connexions", "connectionsComingSoon": "Les connexions sont configurées dans une étape ultérieure de cette vague."`
fr-FR: `"defaults": "Valeurs par défaut", "documents": "Documents", "connections": "Connexions", "connectionsComingSoon": "Les connexions sont configurées dans une étape ultérieure de cette vague."`
it-IT: `"defaults": "Predefiniti", "documents": "Documenti", "connections": "Connessioni", "connectionsComingSoon": "Le connessioni verranno configurate in un passaggio successivo di questa fase."`
pt-BR: `"defaults": "Padrões", "documents": "Documentos", "connections": "Conexões", "connectionsComingSoon": "As conexões estão sendo configuradas em uma etapa posterior desta onda."`
tr-TR: `"defaults": "Varsayılanlar", "documents": "Belgeler", "connections": "Bağlantılar", "connectionsComingSoon": "Bağlantılar bu dalganın sonraki bir adımında kuruluyor."`

(These land in `apps/web/src/locales/<locale>/billing.json` next to the existing
`partnerBillingSettings` object, as a new sibling `partnerBillingSettingsTabs` key.
`connectionsComingSoon` is intra-wave scaffolding, not user-facing for long — it
only ever ships if Task 8 and Task 11 land as genuinely separate PRs; if executed
back-to-back in one PR/session, per the Split recommendation's default, it never
reaches a real user between the two commits.)

- [ ] **Step 6: Update `TARGET_GLOBS`**

```ts
// apps/web/src/lib/__tests__/no-silent-mutations.test.ts
// remove: 'src/components/billing/PartnerBillingSettings.tsx',
// add:
'src/components/billing/PartnerBillingSettingsPage.tsx',
```

- [ ] **Step 7: Run tests**

Run: `cd apps/web && npx vitest run src/components/billing/PartnerBillingSettingsPage.test.tsx src/components/billing/BillingDefaultsTab.test.tsx src/components/billing/BillingDocumentsTab.test.tsx src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS

- [ ] **Step 8: Run locale contract tests**

Run: `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/billing/PartnerBillingSettingsPage.tsx apps/web/src/components/billing/BillingDefaultsTab.tsx apps/web/src/components/billing/BillingDocumentsTab.tsx apps/web/src/components/billing/PartnerBillingSettings.tsx apps/web/src/components/billing/PartnerBillingSettings.test.tsx apps/web/src/pages/settings/billing.astro apps/web/src/lib/__tests__/no-silent-mutations.test.ts apps/web/src/locales/*/billing.json apps/web/src/components/billing/*.test.tsx
git commit -m "refactor(web): split Billing settings into Defaults/Documents/Connections tabs (M4)"
```

(No forward dependency on Task 11: this task's `PartnerBillingSettingsPage.tsx`
renders an inline placeholder for the Connections tab, not the real
`BillingConnectionsTab` component — Task 11 builds that component and swaps the
placeholder out. Task 8 is independently buildable, testable, and committable on
its own, regardless of which side of the W01a/W01b split it ends up on.)

---

### Task 9: Catalog defaults card — move 3 fields off Billing (M4 part 2)

Verified readers of these 3 fields, confirming the audit claim they never enter
price resolution: `apps/web/src/components/settings/TdSynnexCatalogPanel.tsx:190-196,294`
and `TdSynnexEcExpressPanel.tsx:153-159,278` (import pre-fill), and
`apps/web/src/components/billing/quotes/QuoteEditor.tsx:650-651` ("Auto-fill from
web" pre-fill). `apps/api/src/routes/catalog/enrich.ts:24` separately reads
`catalogAiStyle` for AI copy generation. No hit anywhere near `resolvePrice` —
confirmed, they do not participate in price resolution. Verified DB columns
(`apps/api/src/db/schema/orgs.ts:125,129,138`, table `partners`):
`defaultMarkupPercent numeric(6,2)`, `autoTaxHardware boolean not null default true`,
`catalogAiStyle text`. Same PATCH endpoint (`/partner/billing-settings`); the three
always-required fields (`currencyCode`, `invoiceNumberPrefix`, `invoiceTermsDays`)
must ride along on this card's own PATCH.

**Files:**
- Create: `apps/web/src/components/settings/CatalogDefaultsCard.tsx`
- Modify: `apps/web/src/components/settings/CatalogSettingsPage.tsx` (the real page
  component that renders `CatalogItemsTab` and already owns the `isOrgScoped`
  check this card's gating reuses — verified by reading the file: it imports
  `getJwtClaims`, computes `const isOrgScoped = getJwtClaims().scope ===
  'organization';`, and returns `<CatalogItemsTab />` inside its non-org-scoped
  branch. `CatalogItemsTab.tsx` itself is untouched by this task.)
- Create: `apps/web/src/components/settings/CatalogSettingsPage.test.tsx` (this
  file does not exist yet — verified by listing the directory; `CatalogItemsTab.tsx`
  has its own separate test files, `CatalogItemsTab.test.tsx` and
  `CatalogItemsTab.permissions.test.tsx`, neither of which cover the page shell)
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (`TARGET_GLOBS`: add `src/components/settings/CatalogDefaultsCard.tsx`)
- Test: `apps/web/src/components/settings/CatalogDefaultsCard.test.tsx` (new)
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/settings.json`

**Interfaces:**
- Consumes: `fetchWithAuth`, `runAction`, `handleActionError` (same as Task 8); the `billing` i18n namespace's existing `partnerBillingSettings.defaults.{defaultMarkup,markupHelp,autoTaxHardware,autoTaxHardwareHelp,aiStyle,aiStyleHelp,aiStylePlaceholder}` keys, reused as-is (no new copy needed for the field labels — only the card title/description are new, under `settings.json`).
- Produces: `CatalogDefaultsCard()` (no props).

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/settings/CatalogDefaultsCard.test.tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '../../lib/i18n';
import CatalogDefaultsCard from './CatalogDefaultsCard';

const fetchMock = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...args: unknown[]) => fetchMock(...args) }));

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30,
      defaultMarkupPercent: '12.50', autoTaxHardware: true, catalogAiStyle: 'Concise',
    }),
  });
});

it('loads and renders the three catalog defaults', async () => {
  render(<I18nextProvider i18n={i18n}><CatalogDefaultsCard /></I18nextProvider>);
  expect(await screen.findByTestId('catalog-defaults-markup')).toHaveValue(12.5);
  expect(screen.getByTestId('catalog-defaults-auto-tax-hardware')).toBeChecked();
});

it('PATCHes the three required base fields alongside the three catalog fields', async () => {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // the PATCH response
  render(<I18nextProvider i18n={i18n}><CatalogDefaultsCard /></I18nextProvider>);
  await screen.findByTestId('catalog-defaults-markup');
  await userEvent.click(screen.getByTestId('catalog-defaults-save'));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  const [, patchInit] = fetchMock.mock.calls[1];
  const body = JSON.parse((patchInit as RequestInit).body as string);
  expect(body).toMatchObject({
    currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30,
    defaultMarkupPercent: 12.5, autoTaxHardware: true, catalogAiStyle: 'Concise',
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd apps/web && npx vitest run src/components/settings/CatalogDefaultsCard.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the card**

```tsx
// apps/web/src/components/settings/CatalogDefaultsCard.tsx
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';

interface PartnerCatalogDefaults {
  currencyCode: string; invoiceNumberPrefix: string; invoiceTermsDays: number;
  defaultMarkupPercent: string | null; autoTaxHardware: boolean; catalogAiStyle: string | null;
}

/**
 * Moved off Billing settings (M4): these three fields only ever pre-fill catalog
 * import (TD SYNNEX/EC Express) and the quote editor's "Auto-fill from web" —
 * verified, they never enter resolvePrice. Same PATCH endpoint as Billing
 * settings; the three base fields it requires ride along unedited.
 */
export default function CatalogDefaultsCard() {
  const { t } = useTranslation(['settings', 'billing']);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [base, setBase] = useState<{ currencyCode: string; invoiceNumberPrefix: string; invoiceTermsDays: number } | null>(null);
  const [markupPercent, setMarkupPercent] = useState('');
  const [autoTaxHardware, setAutoTaxHardware] = useState(true);
  const [aiStyle, setAiStyle] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetchWithAuth('/orgs/partners/me');
      if (!res.ok) throw new Error('load failed');
      const p = (await res.json()) as PartnerCatalogDefaults;
      setBase({ currencyCode: p.currencyCode, invoiceNumberPrefix: p.invoiceNumberPrefix, invoiceTermsDays: p.invoiceTermsDays });
      setMarkupPercent(p.defaultMarkupPercent != null ? String(Number(p.defaultMarkupPercent)) : '');
      setAutoTaxHardware(p.autoTaxHardware ?? true);
      setAiStyle(p.catalogAiStyle ?? '');
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async () => {
    if (saving || !base) return;
    setSaving(true);
    try {
      const trimmed = markupPercent.trim();
      await runAction({
        request: () => fetchWithAuth('/partner/billing-settings', {
          method: 'PATCH',
          body: JSON.stringify({
            currencyCode: base.currencyCode,
            invoiceNumberPrefix: base.invoiceNumberPrefix,
            invoiceTermsDays: base.invoiceTermsDays,
            defaultMarkupPercent: trimmed === '' ? null : Number(trimmed),
            autoTaxHardware,
            catalogAiStyle: aiStyle.trim() === '' ? null : aiStyle.trim(),
          }),
        }),
        errorFallback: t('catalogDefaultsCard.saveError'),
        successMessage: t('catalogDefaultsCard.saveSuccess'),
      });
      void load();
    } catch (err) {
      handleActionError(err, t('catalogDefaultsCard.saveError'));
    } finally {
      setSaving(false);
    }
  }, [saving, base, markupPercent, autoTaxHardware, aiStyle, load, t]);

  if (loading) return <p className="text-sm text-muted-foreground">{t('catalogDefaultsCard.loading')}</p>;
  if (loadError) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground" data-testid="catalog-defaults-load-error">
        {t('catalogDefaultsCard.loadError')}{' '}
        <button type="button" onClick={() => void load()} className="underline hover:text-foreground">{t('common:actions.retry')}</button>
      </div>
    );
  }

  return (
    <section className="rounded-lg border bg-card p-6 shadow-xs" data-testid="catalog-defaults-card">
      <h2 className="text-lg font-semibold">{t('catalogDefaultsCard.title')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('catalogDefaultsCard.description')}</p>
      <div className="mt-4">
        <label className="text-sm font-medium" htmlFor="cd-markup">{t('billing:partnerBillingSettings.defaults.defaultMarkup')}</label>
        <input
          id="cd-markup" type="number" min={0} max={9999.99} step="0.01" value={markupPercent}
          onChange={(e) => setMarkupPercent(e.target.value)} placeholder={t('common:labels.none')}
          data-testid="catalog-defaults-markup"
          className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm sm:w-64"
        />
        <p className="mt-1 text-xs text-muted-foreground">{t('billing:partnerBillingSettings.defaults.markupHelp')}</p>
      </div>
      <div className="mt-4">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox" checked={autoTaxHardware} onChange={(e) => setAutoTaxHardware(e.target.checked)}
            data-testid="catalog-defaults-auto-tax-hardware" className="h-4 w-4 rounded border"
          />
          <span className="text-sm font-medium">{t('billing:partnerBillingSettings.defaults.autoTaxHardware')}</span>
        </label>
        <p className="mt-1 text-xs text-muted-foreground">{t('billing:partnerBillingSettings.defaults.autoTaxHardwareHelp')}</p>
      </div>
      <div className="mt-4">
        <label className="text-sm font-medium" htmlFor="cd-ai-style">{t('billing:partnerBillingSettings.defaults.aiStyle')}</label>
        <textarea
          id="cd-ai-style" rows={4} value={aiStyle} maxLength={2000}
          onChange={(e) => setAiStyle(e.target.value)}
          placeholder={t('billing:partnerBillingSettings.defaults.aiStylePlaceholder')}
          data-testid="catalog-defaults-ai-style"
          className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
        />
        <p className="mt-1 text-xs text-muted-foreground">{t('billing:partnerBillingSettings.defaults.aiStyleHelp')}</p>
      </div>
      <div className="mt-4 flex justify-end">
        <button
          type="button" onClick={() => void save()} disabled={saving}
          data-testid="catalog-defaults-save"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {saving ? t('common:states.saving') : t('catalogDefaultsCard.saveButton')}
        </button>
      </div>
    </section>
  );
}
```

- [ ] **Step 3a: Write the failing test for the mount point**

`CatalogSettingsPage.test.tsx` does not exist yet — this is its first test file
(`CatalogItemsTab.test.tsx`/`CatalogItemsTab.permissions.test.tsx` cover the child
component only, not the page shell that will own `CatalogDefaultsCard`):

```tsx
// apps/web/src/components/settings/CatalogSettingsPage.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import CatalogSettingsPage from './CatalogSettingsPage';

it('mounts CatalogDefaultsCard above the item list for a partner-scoped user (M4)', async () => {
  render(<CatalogSettingsPage />);
  expect(await screen.findByTestId('catalog-defaults-card')).toBeInTheDocument();
  expect(screen.getByTestId('catalog-settings-page')).toBeInTheDocument();
});
```

Run: `cd apps/web && npx vitest run src/components/settings/CatalogSettingsPage.test.tsx`
Expected: FAIL — module resolves, but `catalog-defaults-card` is not in the tree
yet (`CatalogSettingsPage.tsx` does not import `CatalogDefaultsCard` until Step 4).

- [ ] **Step 4: Mount it above `CatalogItemsTab`**

```tsx
// apps/web/src/components/settings/CatalogSettingsPage.tsx — add above <CatalogItemsTab />
import CatalogDefaultsCard from './CatalogDefaultsCard';
// ...
{!isOrgScoped && <CatalogDefaultsCard />}
<CatalogItemsTab />
```

- [ ] **Step 5: Add locale keys** — `catalogDefaultsCard.{title,description,loading,loadError,saveError,saveSuccess,saveButton}` in `settings.json`:

en: `"title": "Catalog defaults", "description": "Used to pre-fill catalog imports and the quote editor's auto-fill — these never affect price resolution directly.", "loading": "Loading catalog defaults...", "loadError": "Failed to load catalog defaults.", "saveError": "Failed to save catalog defaults", "saveSuccess": "Catalog defaults saved", "saveButton": "Save"`

de-DE: `"title": "Katalog-Standardwerte", "description": "Wird verwendet, um Katalogimporte und die automatische Angebotsausfüllung vorzubefüllen — diese wirken sich nicht direkt auf die Preisermittlung aus.", "loading": "Katalog-Standardwerte werden geladen...", "loadError": "Katalog-Standardwerte konnten nicht geladen werden.", "saveError": "Katalog-Standardwerte konnten nicht gespeichert werden", "saveSuccess": "Katalog-Standardwerte gespeichert", "saveButton": "Speichern"`

es-419: `"title": "Valores predeterminados del catálogo", "description": "Se usan para prellenar las importaciones del catálogo y el autocompletado del editor de cotizaciones; no afectan directamente la resolución de precios.", "loading": "Cargando valores predeterminados del catálogo...", "loadError": "No se pudieron cargar los valores predeterminados del catálogo.", "saveError": "No se pudieron guardar los valores predeterminados del catálogo", "saveSuccess": "Valores predeterminados del catálogo guardados", "saveButton": "Guardar"`

fr-CA: `"title": "Valeurs par défaut du catalogue", "description": "Utilisées pour préremplir les importations du catalogue et le remplissage automatique de l'éditeur de soumissions — sans effet direct sur la résolution des prix.", "loading": "Chargement des valeurs par défaut du catalogue...", "loadError": "Échec du chargement des valeurs par défaut du catalogue.", "saveError": "Échec de l'enregistrement des valeurs par défaut du catalogue", "saveSuccess": "Valeurs par défaut du catalogue enregistrées", "saveButton": "Enregistrer"`

fr-FR: `"title": "Valeurs par défaut du catalogue", "description": "Utilisées pour préremplir les imports du catalogue et le remplissage automatique de l'éditeur de devis — sans effet direct sur la résolution des prix.", "loading": "Chargement des valeurs par défaut du catalogue...", "loadError": "Échec du chargement des valeurs par défaut du catalogue.", "saveError": "Échec de l'enregistrement des valeurs par défaut du catalogue", "saveSuccess": "Valeurs par défaut du catalogue enregistrées", "saveButton": "Enregistrer"`

it-IT: `"title": "Valori predefiniti del catalogo", "description": "Usati per precompilare le importazioni del catalogo e il riempimento automatico dell'editor dei preventivi — non incidono direttamente sulla risoluzione del prezzo.", "loading": "Caricamento dei valori predefiniti del catalogo...", "loadError": "Impossibile caricare i valori predefiniti del catalogo.", "saveError": "Impossibile salvare i valori predefiniti del catalogo", "saveSuccess": "Valori predefiniti del catalogo salvati", "saveButton": "Salva"`

pt-BR: `"title": "Padrões do catálogo", "description": "Usados para pré-preencher importações do catálogo e o preenchimento automático do editor de orçamentos — não afetam diretamente a resolução de preços.", "loading": "Carregando padrões do catálogo...", "loadError": "Falha ao carregar os padrões do catálogo.", "saveError": "Falha ao salvar os padrões do catálogo", "saveSuccess": "Padrões do catálogo salvos", "saveButton": "Salvar"`

tr-TR: `"title": "Katalog varsayılanları", "description": "Katalog içe aktarmalarını ve teklif düzenleyicisinin otomatik doldurmasını önceden doldurmak için kullanılır — fiyat çözümlemesini doğrudan etkilemez.", "loading": "Katalog varsayılanları yükleniyor...", "loadError": "Katalog varsayılanları yüklenemedi.", "saveError": "Katalog varsayılanları kaydedilemedi", "saveSuccess": "Katalog varsayılanları kaydedildi", "saveButton": "Kaydet"`

- [ ] **Step 6: Update `TARGET_GLOBS`**

```ts
// apps/web/src/lib/__tests__/no-silent-mutations.test.ts — add
'src/components/settings/CatalogDefaultsCard.tsx',
```

- [ ] **Step 7: Run tests**

Run: `cd apps/web && npx vitest run src/components/settings/CatalogDefaultsCard.test.tsx src/components/settings/CatalogSettingsPage.test.tsx src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS

- [ ] **Step 8: Run locale contract tests and commit**

Run: `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts`

```bash
git add apps/web/src/components/settings/CatalogDefaultsCard.tsx apps/web/src/components/settings/CatalogSettingsPage.tsx apps/web/src/components/settings/CatalogDefaultsCard.test.tsx apps/web/src/components/settings/CatalogSettingsPage.test.tsx apps/web/src/lib/__tests__/no-silent-mutations.test.ts apps/web/src/locales/*/settings.json
git commit -m "feat(web): move catalog pre-fill defaults off Billing settings onto the Catalog page (M4)"
```

---

### Task 10: Billables export moves from Ticketing settings to the Invoices page (M5)

**Orchestrator decision, overriding this plan's earlier draft** (which proposed
Billing → Connections): an export action inside a *settings* tab — Billing or
Ticketing — repeats exactly the defect the audit is fixing (rule 2: "settings live
with their domain; actions and reports are not settings") and guarantees a second
move later. The billables CSV export belongs where billables are reviewed: the
Invoices list.

Task 2 already removed `TicketingSettingsTabs.tsx`'s `export` tab and its
`BillablesExportCard` import/callsite — the rewritten component's Step 3 import
list has no `BillablesExportCard` in it. **Task 2 is the one task that owns that
deletion.** This task owns the other half only: give the card a new home and move
its file there.

Verified gating: `GET /tickets/export/billables.csv`
(`apps/api/src/routes/tickets/export.ts:14-19`) requires
`requireScope('partner', 'system')` plus `tickets:read`
(`PERMISSIONS.TICKETS_READ` = `{ resource: 'tickets', action: 'read' }`,
`packages/shared/src/constants/permissions.ts:60`) and `time_entries:read`
(`PERMISSIONS.TIME_ENTRIES_READ` = `{ resource: 'time_entries', action: 'read' }`,
same file line 107) — no org-scoped caller can ever succeed. `InvoicesPage.tsx`
already carries the exact hooks needed to mirror that gate client-side, so this is
not a NOT VERIFIED item: `useJwtClaims()` → `isOrgScoped` (line 120, the same
"stays visible while unresolved, hidden only once resolved as an org token"
convention the file already uses for its QuickBooks bulk-push action, lines
112-120) and `usePermissions().can()` (line 111, already used at line 494 for
`can('invoices', 'write')` gating the existing "New invoice" button). Verified
`InvoicesPage`'s org-locked/embedded mode: `lockedOrgId?: string` prop (documented
lines 98-107) — used when the page is mounted inside the org record's Contracts &
Billing tab. The export button must not render there: the export itself is
partner-wide with an optional org filter *inside* the dialog, so a per-org-locked
view gains nothing from it and showing it would invite confusion about scope.

**Files:**
- Move (`git mv`): `apps/web/src/components/settings/BillablesExportCard.tsx` → `apps/web/src/components/billing/BillablesExportCard.tsx`
- Move (`git mv`): `apps/web/src/components/settings/BillablesExportCard.test.tsx` → `apps/web/src/components/billing/BillablesExportCard.test.tsx`
- Modify: `apps/web/src/components/billing/InvoicesPage.tsx`
- Modify: `apps/web/src/components/billing/InvoicesPage.test.tsx`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/billing.json`

**Interfaces:**
- Consumes: `BillablesExportCard` (moved; body unchanged — it keeps its existing
  `useTranslation('settings')` call and reads `billablesExport.*` from
  `settings.json` as it does today. This task does **not** migrate those keys to
  `billing.json` — only the component file itself moves; the i18n namespace is
  unrelated to where the file lives and re-homing it would be an unnecessary,
  unrelated diff), `Dialog` (`../shared/Dialog`, already imported by
  `InvoicesPage.tsx`), `useJwtClaims`, `usePermissions` (both already imported
  and already in scope inside `InvoicesPage.tsx`).
- Produces: nothing new consumed by later tasks. Task 16's mount/composition test
  and Task 17's manual checklist both assert this new location, not a
  Connections-tab one.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/billing/InvoicesPage.test.tsx (append)
it('shows an Export billables button that opens BillablesExportCard in a dialog (M5)', async () => {
  wireDefault();
  render(<InvoicesPage />);
  await waitFor(() => expect(screen.getByTestId('invoices-table')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('invoices-export-billables-open'));
  expect(await screen.findByTestId('billables-export-card')).toBeInTheDocument();
});

it('hides the Export billables button when the page is locked to one org', async () => {
  wireDefault();
  render(<InvoicesPage lockedOrgId="org-1" />);
  await waitFor(() => expect(screen.getByTestId('invoices-table')).toBeInTheDocument());
  expect(screen.queryByTestId('invoices-export-billables-open')).not.toBeInTheDocument();
});
```

(`fireEvent` is already imported by this test file, line 1 — reuse it; do not add
a `@testing-library/user-event` import this file doesn't otherwise use.)

- [ ] **Step 2: Run to confirm it fails**

Run: `cd apps/web && npx vitest run src/components/billing/InvoicesPage.test.tsx`
Expected: FAIL — no `invoices-export-billables-open` testid exists yet.

- [ ] **Step 3: Move the card**

```bash
git mv apps/web/src/components/settings/BillablesExportCard.tsx apps/web/src/components/billing/BillablesExportCard.tsx
git mv apps/web/src/components/settings/BillablesExportCard.test.tsx apps/web/src/components/billing/BillablesExportCard.test.tsx
```

No import sweep needed beyond this: Task 2 already removed
`TicketingSettingsTabs.tsx`'s import of this component, and `rg -n
"BillablesExportCard" apps/web/src` (run before this move, in this worktree)
returns only the component and its own test — no other file imports it. Its
`no-silent-mutations` status is unaffected by the move: it performs a `GET`
download via `fetchWithAuth`, never a POST/PUT/PATCH/DELETE, so it was never in
`TARGET_GLOBS` and does not need to be added now.

- [ ] **Step 4: Add the button and dialog to `InvoicesPage.tsx`**

```tsx
// apps/web/src/components/billing/InvoicesPage.tsx — near the top with the
// other same-directory component imports
import BillablesExportCard from './BillablesExportCard';
```

```tsx
// apps/web/src/components/billing/InvoicesPage.tsx — inside the component body,
// alongside the existing `const [assembleOpen, setAssembleOpen] = useState(false);` (line 155)
const [exportOpen, setExportOpen] = useState(false);
```

```tsx
// apps/web/src/components/billing/InvoicesPage.tsx — header block, next to the
// existing `can('invoices', 'write')` "New invoice" button (lines 494-503):
{!lockedOrgId && !isOrgScoped && can('tickets', 'read') && can('time_entries', 'read') && (
  <button
    type="button"
    onClick={() => setExportOpen(true)}
    data-testid="invoices-export-billables-open"
    className="inline-flex h-10 items-center justify-center rounded-md border px-4 text-sm font-medium hover:bg-muted/40"
  >
    {t('invoicesPage.exportBillables')}
  </button>
)}
```

```tsx
// apps/web/src/components/billing/InvoicesPage.tsx — alongside the existing
// New-invoice <Dialog> block (near line 884), a second dialog for the export card
<Dialog
  open={exportOpen}
  onClose={() => setExportOpen(false)}
  title={t('invoicesPage.exportBillablesDialogTitle')}
  labelledBy="invoices-export-billables-title"
  maxWidth="lg"
  className="p-6"
>
  <h2 id="invoices-export-billables-title" className="sr-only">{t('invoicesPage.exportBillablesDialogTitle')}</h2>
  <BillablesExportCard />
</Dialog>
```

- [ ] **Step 5: Add the locale keys** `invoicesPage.exportBillables` and
  `invoicesPage.exportBillablesDialogTitle` in `billing.json` (the namespace
  `InvoicesPage.tsx` already uses via `useTranslation('billing')`):

en: `"exportBillables": "Export billables", "exportBillablesDialogTitle": "Export billables"`
de-DE: `"exportBillables": "Abrechenbare Leistungen exportieren", "exportBillablesDialogTitle": "Abrechenbare Leistungen exportieren"`
es-419: `"exportBillables": "Exportar facturables", "exportBillablesDialogTitle": "Exportar facturables"`
fr-CA: `"exportBillables": "Exporter les éléments facturables", "exportBillablesDialogTitle": "Exporter les éléments facturables"`
fr-FR: `"exportBillables": "Exporter les éléments facturables", "exportBillablesDialogTitle": "Exporter les éléments facturables"`
it-IT: `"exportBillables": "Esporta fatturabili", "exportBillablesDialogTitle": "Esporta fatturabili"`
pt-BR: `"exportBillables": "Exportar itens faturáveis", "exportBillablesDialogTitle": "Exportar itens faturáveis"`
tr-TR: `"exportBillables": "Faturalandırılabilirleri dışa aktar", "exportBillablesDialogTitle": "Faturalandırılabilirleri dışa aktar"`

- [ ] **Step 6: Run tests**

Run: `cd apps/web && npx vitest run src/components/billing/InvoicesPage.test.tsx src/components/billing/BillablesExportCard.test.tsx`
Expected: PASS (the moved test file needs no internal changes — it imports
`./BillablesExportCard` relatively, which still resolves after the move).

- [ ] **Step 7: Run locale contract tests**

Run: `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/billing/BillablesExportCard.tsx apps/web/src/components/billing/BillablesExportCard.test.tsx apps/web/src/components/settings/BillablesExportCard.tsx apps/web/src/components/settings/BillablesExportCard.test.tsx apps/web/src/components/billing/InvoicesPage.tsx apps/web/src/components/billing/InvoicesPage.test.tsx apps/web/src/locales/*/billing.json
git commit -m "feat(web): move billables export from Ticketing settings to the Invoices page (M5)"
```

---

### Task 11: Billing Connections tab + Catalog/Distributors cross-links (M6)

**No read-only Stripe/QuickBooks connection-status endpoint exists for a
plain-links Connections tab to call without an API change** — grep for a GET
status route under `apps/api/src/routes` matching stripe/quickbooks status returned
nothing; `StripePaymentsIntegration.tsx`/`QuickbooksIntegration.tsx` each own their
full read+write flow on `/integrations#accounting` already. Per the brief's explicit
fallback ("if none exists WITHOUT an API change, make it plain links and say so"):
this tab is plain links, not a status widget. Verified hash targets:
`apps/web/src/components/integrations/IntegrationsPage.tsx:78-79` tab id
`"accounting"` → `/integrations#accounting`; `:73-74` tab id `"distributors"` →
`/integrations#distributors`.

**Files:**
- Create: `apps/web/src/components/billing/BillingConnectionsTab.tsx`
- Modify: `apps/web/src/components/billing/PartnerBillingSettingsPage.tsx` (swap Task 8's inline placeholder for the real `<BillingConnectionsTab />` import)
- Modify: `apps/web/src/components/settings/CatalogSettingsPage.tsx` (distributors cross-link)
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/billing.json` (also removes Task 8's now-unused `connectionsComingSoon` key, its only reader)
- Test: `apps/web/src/components/billing/BillingConnectionsTab.test.tsx` (new)
- Test: `apps/web/src/components/billing/PartnerBillingSettingsPage.test.tsx` (existing — extend, see Step 4a)
- Test: `apps/web/src/components/settings/CatalogSettingsPage.test.tsx` (created by Task 9 — extend)
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/settings.json`

**Interfaces:**
- Consumes: nothing (plain `<a>` links).
- Produces: `BillingConnectionsTab()` (no props), wired into `PartnerBillingSettingsPage.tsx` in Step 4a below (Task 8 only stubbed the tab's panel — this task is what actually connects it).

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/web/src/components/billing/BillingConnectionsTab.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '../../lib/i18n';
import BillingConnectionsTab from './BillingConnectionsTab';

it('links to Integrations → Accounting for Stripe/QuickBooks — never a second editor', async () => {
  render(<I18nextProvider i18n={i18n}><BillingConnectionsTab /></I18nextProvider>);
  const link = await screen.findByTestId('billing-connections-accounting-link');
  expect(link).toHaveAttribute('href', '/integrations#accounting');
});

it('links to Catalog and Distributors', async () => {
  render(<I18nextProvider i18n={i18n}><BillingConnectionsTab /></I18nextProvider>);
  expect(screen.getByTestId('billing-connections-catalog-link')).toHaveAttribute('href', '/settings/catalog');
  expect(screen.getByTestId('billing-connections-distributors-link')).toHaveAttribute('href', '/integrations#distributors');
});
```

```tsx
// apps/web/src/components/settings/CatalogSettingsPage.test.tsx (append —
// this file was created in Task 9; import render/screen the same way its
// first test does, no new setup needed)
it('links to Distributors under Integrations', () => {
  render(<CatalogSettingsPage />);
  expect(screen.getByTestId('catalog-distributors-link')).toHaveAttribute('href', '/integrations#distributors');
});
```

- [ ] **Step 2: Run to confirm both fail**

Run: `cd apps/web && npx vitest run src/components/billing/BillingConnectionsTab.test.tsx src/components/settings/CatalogSettingsPage.test.tsx`
Expected: FAIL — module not found / link not found.

- [ ] **Step 3: Implement**

```tsx
// apps/web/src/components/billing/BillingConnectionsTab.tsx
import { useTranslation } from 'react-i18next';

export default function BillingConnectionsTab() {
  const { t } = useTranslation('billing');
  return (
    <div className="space-y-4" data-testid="billing-connections-tab">
      <section className="rounded-lg border bg-card p-6 shadow-xs">
        <h2 className="text-lg font-semibold">{t('billingConnectionsTab.accounting.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('billingConnectionsTab.accounting.description')}</p>
        <a
          href="/integrations#accounting" data-testid="billing-connections-accounting-link"
          className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          {t('billingConnectionsTab.accounting.cta')}
        </a>
      </section>
      <section className="rounded-lg border bg-card p-6 shadow-xs">
        <h2 className="text-lg font-semibold">{t('billingConnectionsTab.catalog.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('billingConnectionsTab.catalog.description')}</p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:gap-4">
          <a href="/settings/catalog" data-testid="billing-connections-catalog-link" className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
            {t('billingConnectionsTab.catalog.catalogCta')}
          </a>
          <a href="/integrations#distributors" data-testid="billing-connections-distributors-link" className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
            {t('billingConnectionsTab.catalog.distributorsCta')}
          </a>
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Add the Catalog page's own distributors link**

```tsx
// apps/web/src/components/settings/CatalogSettingsPage.tsx — add below the heading block
<a
  href="/integrations#distributors" data-testid="catalog-distributors-link"
  className="text-sm font-medium text-primary hover:underline"
>
  {t('catalogSettingsPage.distributorsLink')}
</a>
```

- [ ] **Step 4a: Wire the real component into `PartnerBillingSettingsPage.tsx`, replacing Task 8's placeholder**

```tsx
// apps/web/src/components/billing/PartnerBillingSettingsPage.tsx
// Replace the "BillingConnectionsTab does not exist yet" comment and its
// import placeholder (added in Task 8) with the real import:
import BillingConnectionsTab from './BillingConnectionsTab';
```

```tsx
// apps/web/src/components/billing/PartnerBillingSettingsPage.tsx — replace the
// placeholder panel added in Task 8:
{activeTab === 'connections' && <BillingConnectionsTab />}
```

Add a test confirming the swap took effect (append to the existing
`PartnerBillingSettingsPage.test.tsx` suite from Task 8):

```tsx
// apps/web/src/components/billing/PartnerBillingSettingsPage.test.tsx (append)
it('the Connections tab renders the real BillingConnectionsTab, not the Task 8 placeholder (M6)', async () => {
  render(<I18nextProvider i18n={i18n}><PartnerBillingSettingsPage /></I18nextProvider>);
  await userEvent.click(await screen.findByTestId('billing-settings-tab-connections'));
  expect(await screen.findByTestId('billing-connections-tab')).toBeInTheDocument();
  expect(screen.queryByTestId('billing-connections-tab-placeholder')).not.toBeInTheDocument();
});
```

Run: `cd apps/web && npx vitest run src/components/billing/PartnerBillingSettingsPage.test.tsx`
Expected: PASS once Step 4's `BillingConnectionsTab.tsx` exists and this step's wiring lands (write this test, confirm it fails first against Task 8's placeholder state, then land the wiring above — same red-first discipline as every other step).

- [ ] **Step 5: Add locale keys**

`billingConnectionsTab.accounting.{title,description,cta}`, `billingConnectionsTab.catalog.{title,description,catalogCta,distributorsCta}` in `billing.json`; `catalogSettingsPage.distributorsLink` in `settings.json`. Also **remove** `partnerBillingSettingsTabs.connectionsComingSoon` (Task 8's placeholder copy, all 8 locales) from `billing.json` now that Step 4a removed its only reader — leaving it in place would trip `keyUsage.test.ts`'s unused-key check.

en: accounting title `"Accounting"`, description `"Stripe and QuickBooks connect under Integrations — manage them there."`, cta `"Manage accounting connections →"`; catalog title `"Catalog & distributors"`, description `"Product Catalog and distributor connections (Pax8, TD SYNNEX) live in two places — jump between them here."`, catalogCta `"Open Product Catalog →"`, distributorsCta `"Open Distributors →"`; catalogSettingsPage.distributorsLink `"Manage distributor connections →"`

de-DE: accounting title `"Buchhaltung"`, description `"Stripe und QuickBooks werden unter Integrationen verbunden — dort verwalten."`, cta `"Buchhaltungsverbindungen verwalten →"`; catalog title `"Katalog & Distributoren"`, description `"Produktkatalog und Distributorverbindungen (Pax8, TD SYNNEX) befinden sich an zwei Orten — hier wechseln."`, catalogCta `"Produktkatalog öffnen →"`, distributorsCta `"Distributoren öffnen →"`; distributorsLink `"Distributorverbindungen verwalten →"`

es-419: accounting title `"Contabilidad"`, description `"Stripe y QuickBooks se conectan en Integraciones — adminístralos allí."`, cta `"Administrar conexiones contables →"`; catalog title `"Catálogo y distribuidores"`, description `"El catálogo de productos y las conexiones de distribuidores (Pax8, TD SYNNEX) están en dos lugares — cambia entre ellos aquí."`, catalogCta `"Abrir catálogo de productos →"`, distributorsCta `"Abrir distribuidores →"`; distributorsLink `"Administrar conexiones de distribuidores →"`

fr-CA: accounting title `"Comptabilité"`, description `"Stripe et QuickBooks se connectent sous Intégrations — gérez-les là-bas."`, cta `"Gérer les connexions comptables →"`; catalog title `"Catalogue et distributeurs"`, description `"Le catalogue de produits et les connexions aux distributeurs (Pax8, TD SYNNEX) se trouvent à deux endroits — passez de l'un à l'autre ici."`, catalogCta `"Ouvrir le catalogue de produits →"`, distributorsCta `"Ouvrir les distributeurs →"`; distributorsLink `"Gérer les connexions aux distributeurs →"`

fr-FR: accounting title `"Comptabilité"`, description `"Stripe et QuickBooks se connectent sous Intégrations — gérez-les là-bas."`, cta `"Gérer les connexions comptables →"`; catalog title `"Catalogue et distributeurs"`, description `"Le catalogue produits et les connexions aux distributeurs (Pax8, TD SYNNEX) se trouvent à deux endroits — basculez entre les deux ici."`, catalogCta `"Ouvrir le catalogue produits →"`, distributorsCta `"Ouvrir les distributeurs →"`; distributorsLink `"Gérer les connexions aux distributeurs →"`

it-IT: accounting title `"Contabilità"`, description `"Stripe e QuickBooks si collegano da Integrazioni — gestiscili lì."`, cta `"Gestisci connessioni contabili →"`; catalog title `"Catalogo e distributori"`, description `"Il catalogo prodotti e le connessioni ai distributori (Pax8, TD SYNNEX) si trovano in due punti — passa dall'uno all'altro qui."`, catalogCta `"Apri catalogo prodotti →"`, distributorsCta `"Apri distributori →"`; distributorsLink `"Gestisci connessioni distributori →"`

pt-BR: accounting title `"Contabilidade"`, description `"Stripe e QuickBooks se conectam em Integrações — gerencie-os lá."`, cta `"Gerenciar conexões contábeis →"`; catalog title `"Catálogo e distribuidores"`, description `"O catálogo de produtos e as conexões de distribuidores (Pax8, TD SYNNEX) ficam em dois lugares — alterne entre eles aqui."`, catalogCta `"Abrir catálogo de produtos →"`, distributorsCta `"Abrir distribuidores →"`; distributorsLink `"Gerenciar conexões de distribuidores →"`

tr-TR: accounting title `"Muhasebe"`, description `"Stripe ve QuickBooks, Entegrasyonlar altında bağlanır — onları orada yönetin."`, cta `"Muhasebe bağlantılarını yönet →"`; catalog title `"Katalog ve distribütörler"`, description `"Ürün Kataloğu ve distribütör bağlantıları (Pax8, TD SYNNEX) iki yerde bulunur — buradan geçiş yapın."`, catalogCta `"Ürün Kataloğunu aç →"`, distributorsCta `"Distribütörleri aç →"`; distributorsLink `"Distribütör bağlantılarını yönet →"`

- [ ] **Step 6: Run tests**

Run: `cd apps/web && npx vitest run src/components/billing/BillingConnectionsTab.test.tsx src/components/billing/PartnerBillingSettingsPage.test.tsx src/components/settings/CatalogSettingsPage.test.tsx`
Expected: PASS

- [ ] **Step 7: Run locale contract tests and commit**

```bash
git add apps/web/src/components/billing/BillingConnectionsTab.tsx apps/web/src/components/billing/BillingConnectionsTab.test.tsx apps/web/src/components/billing/PartnerBillingSettingsPage.tsx apps/web/src/components/billing/PartnerBillingSettingsPage.test.tsx apps/web/src/components/settings/CatalogSettingsPage.tsx apps/web/src/components/settings/CatalogSettingsPage.test.tsx apps/web/src/locales/*/billing.json apps/web/src/locales/*/settings.json
git commit -m "feat(web): Billing Connections tab (plain links, no API change) + Catalog↔Distributors cross-link (M6)"
```

---

### Task 12: Modules switch gets its own tab (M7)

Verified `PartnerModulesCard.tsx` needs no code change — only its mount point moves,
from inside the Company tab's JSX (`apps/web/src/components/settings/PartnerSettingsPage.tsx:614`,
`<PartnerModulesCard serviceManagementMode={partner?.serviceManagementMode} />`) to
its own `TabDef`. Verified `external` handling: `OFFERED_MODES = ['native', 'off']`
(`PartnerModulesCard.tsx:18`) — the code comment (lines 9-17) explicitly states
`external` needs "a PSA connection picker that ships with the external
service-desk feature", not built here; the card already renders neither radio
checked and shows an explanatory note (`externalNote`, line 149-153) when the
stored mode is `external`. No change needed to satisfy the brief's "if not simple,
keep it display-only and note it" — it already is. This task is placement only.

**Files:**
- Modify: `apps/web/src/components/settings/PartnerSettingsPage.tsx`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/settings.json`
- Test: `apps/web/src/components/settings/PartnerSettingsPage.modulesTab.test.tsx` (new)

**Interfaces:**
- Consumes: `PartnerModulesCard` (unchanged).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/settings/PartnerSettingsPage.modulesTab.test.tsx
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PartnerSettingsPage from './PartnerSettingsPage';
import { renderWithProviders } from '../../lib/testUtils'; // match the real helper name from PartnerSettingsPage.test.tsx

it('Modules is its own tab, not embedded in Company', async () => {
  renderWithProviders(<PartnerSettingsPage />);
  await userEvent.click(await screen.findByTestId('partner-settings-tab-company'));
  expect(screen.queryByTestId('partner-modules-card')).not.toBeInTheDocument();
  await userEvent.click(screen.getByTestId('partner-settings-tab-modules'));
  expect(await screen.findByTestId('partner-modules-card')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd apps/web && npx vitest run src/components/settings/PartnerSettingsPage.modulesTab.test.tsx`
Expected: FAIL — `partner-modules-card` still renders under the Company tab.

- [ ] **Step 3: Move the `TabDef` and the render branch**

```tsx
// apps/web/src/components/settings/PartnerSettingsPage.tsx
// 1. TabKey union — add 'modules':
type TabKey = 'company' | 'regional' | 'security' | 'notifications' | 'eventLogs' | 'defaults' | 'branding' | 'loginBranding' | 'aiBudgets' | 'aiProvider' | 'remoteAccess' | 'ticketing' | 'modules';

// 2. TAB_GROUPS — add a new TabDef to the "Company" group (selfSaving, matching
//    PartnerModulesCard's own autosave-per-click behavior, same convention as
//    the existing 'ticketing'/'aiProvider'/'loginBranding' selfSaving tabs):
{ key: 'modules', hash: 'modules', label: 'partnerSettingsPage.tabs.modules.label', description: 'partnerSettingsPage.tabs.modules.description', icon: Blocks, selfSaving: true },

// 3. SnapshotKey exclusion — add 'modules' alongside 'ticketing' | 'loginBranding' | 'aiProvider':
type SnapshotKey = Exclude<TabKey, 'ticketing' | 'loginBranding' | 'aiProvider' | 'modules'>;

// 4. Remove <PartnerModulesCard .../> from the Company tab's render branch (line ~614).

// 5. Add a new render branch:
{activeTab === 'modules' && (
  <PartnerModulesCard serviceManagementMode={partner?.serviceManagementMode} />
)}
```

(`Blocks` is the icon `PartnerModulesCard.tsx` itself imports from `lucide-react`
— reuse the same import name in `PartnerSettingsPage.tsx`, which does not
currently import it; add `Blocks` to that file's existing `lucide-react` import
line.)

- [ ] **Step 4: Add locale keys** — `partnerSettingsPage.tabs.modules.{label,description}` (the field-level `partnerSettingsPage.modules.*` keys stay unchanged, still read by `PartnerModulesCard.tsx` itself):

en: `"label": "Modules", "description": "Service desk & billing on/off"`
de-DE: `"label": "Module", "description": "Service Desk & Abrechnung ein/aus"`
es-419: `"label": "Módulos", "description": "Mesa de servicio y facturación activadas/desactivadas"`
fr-CA: `"label": "Modules", "description": "Bureau de service et facturation activés/désactivés"`
fr-FR: `"label": "Modules", "description": "Service desk et facturation activés/désactivés"`
it-IT: `"label": "Moduli", "description": "Service desk e fatturazione on/off"`
pt-BR: `"label": "Módulos", "description": "Central de serviços e faturamento ativados/desativados"`
tr-TR: `"label": "Modüller", "description": "Servis masası ve faturalandırma açık/kapalı"`

- [ ] **Step 5: Run tests**

Run: `cd apps/web && npx vitest run src/components/settings/PartnerSettingsPage.modulesTab.test.tsx src/components/settings/PartnerSettingsPage.test.tsx`
Expected: PASS

- [ ] **Step 6: Run locale contract tests and commit**

```bash
git add apps/web/src/components/settings/PartnerSettingsPage.tsx apps/web/src/components/settings/PartnerSettingsPage.modulesTab.test.tsx apps/web/src/locales/*/settings.json
git commit -m "feat(web): give the service management Modules switch its own partner-hub tab (M7)"
```

---

### Task 13: M365 consent-return deep link points at the new Ticketing page (follow-up from Task 3)

Task 3 removed `TicketingSettingsTabs`'s `initialTab` prop and the embedded-in-hub
case. The M365 OAuth consent flow used to return to
`/settings/partner?ticketMailbox=…#ticketing` and rely on `PartnerSettingsPage`
capturing the `ticketMailbox` query param once at mount to deep-link the embedded
group's Inbound sub-tab. Since Email is now a top-level hash tab on the standalone
page, the consent-return URL builder should point straight at
`/settings/ticketing?ticketMailbox=…#email` instead. Find the URL builder before
writing this task's diff — do not guess its call site.

**Files:**
- Modify: whichever file constructs the M365 OAuth consent redirect URL (grep `ticketMailbox` across `apps/web/src` and `apps/api/src` to find it — likely `apps/web/src/components/settings/M365MailboxCard.tsx` or an API-side OAuth callback route; confirm before editing)
- Modify: `apps/web/src/components/settings/TicketingHubPage.tsx` or `TicketingSettingsTabs.tsx` (read the `ticketMailbox` query param on mount to seed the Email tab, replacing the removed `initialTab` prop mechanism)

**Interfaces:**
- Consumes: `useHashTab` (Task 2).
- Produces: nothing new.

- [ ] **Step 1: Locate the consent-return URL builder**

Run: `cd apps/web/src && rg -n "ticketMailbox" .` and `cd apps/api/src && rg -n "ticketMailbox" .`
Record the exact file(s) and line(s) found — this plan does not fabricate that
location; whoever executes this task fills in the real path here before writing
code.

- [ ] **Step 2: Write the failing test**

```tsx
// apps/web/src/components/settings/TicketingHubPage.test.tsx (append)
it('deep-links to the Email tab when ?ticketMailbox= is present, before scope resolves', async () => {
  window.history.pushState({}, '', '/settings/ticketing?ticketMailbox=abc123');
  render(<I18nextProvider i18n={i18n}><TicketingHubPage /></I18nextProvider>);
  expect(await screen.findByTestId('ticketing-tab-panel-pending')).toBeInTheDocument();
});
```

- [ ] **Step 3: Run to confirm it fails**

Run: `cd apps/web && npx vitest run src/components/settings/TicketingHubPage.test.tsx`
Expected: FAIL — the query param is not read anywhere yet, so the page opens on Statuses (no pending panel).

- [ ] **Step 4: Seed the Email tab from the query param, then update the consent-return URL builder found in Step 1** — apply the exact `useState(() => ...)`-once capture pattern `TicketingSettingsTabs.tsx` used to use (verified original lines 186-189 in the pre-Task-2 file), moved into `TicketingSettingsTabs.tsx`'s own mount:

```tsx
// apps/web/src/components/settings/TicketingSettingsTabs.tsx — inside the
// component, before the useHashTab call:
const [deepLinkMailbox] = useState(
  () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('ticketMailbox')
);
const [activeTab, setActiveTab] = useHashTab<TicketingHubTab>(TICKETING_HUB_TABS, deepLinkMailbox ? 'email' : 'statuses');
```

Then update whatever file Step 1 found to redirect to
`/settings/ticketing?ticketMailbox=<id>#email` instead of
`/settings/partner?ticketMailbox=<id>#ticketing`.

- [ ] **Step 5: Run tests and commit**

Run: `cd apps/web && npx vitest run src/components/settings/TicketingHubPage.test.tsx src/components/settings/TicketingSettingsTabs.test.tsx`

```bash
git add apps/web/src/components/settings/TicketingSettingsTabs.tsx apps/web/src/components/settings/TicketingHubPage.test.tsx
# plus whichever file Step 1 found
git commit -m "fix(web): point the M365 consent-return deep link at /settings/ticketing#email (follow-up to M0)"
```

---

### Task 14: Rename `canManageInbound` (web-side only, confirmed no wire contract) (M8)

Already done as part of Task 2's rewrite (renamed to `canManagePartnerTicketing`
inline). Verified: `rg -n "canManageInbound" apps/web/src apps/api/src
packages/shared/src` returns only the 8 hits inside
`TicketingSettingsTabs.tsx` itself (1 definition + 1 comment + 6 usages) — no other
file, no API route, no shared type references this string. This task is the
sweep-and-confirm step, not new renaming work.

**Files:**
- Verify only: no files modified beyond what Task 2 already changed.

**Interfaces:**
- Consumes: Task 2's `TicketingSettingsTabs.tsx`.
- Produces: nothing new.

- [ ] **Step 1: Confirm the rename is complete and the old name is gone**

Run: `cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-brave-river-1840 && rg -n "canManageInbound" apps/web/src apps/api/src packages/shared/src`
Expected: no output (zero matches) — Task 2's rewrite already replaced every
usage with `canManagePartnerTicketing`.

- [ ] **Step 2: Confirm no test asserts on the old variable/testid name**

Run: `cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-brave-river-1840 && rg -n "canManageInbound" apps/web/src --type-add 'testfile:*.test.tsx' -t testfile`
Expected: no output. If any test file still references the old name (e.g. via a
mock or a comment), fix it in this step and re-run.

- [ ] **Step 3: No commit needed** — this task's diff is empty if Task 2 was done correctly; if Step 1 or 2 found a leftover, commit that fix:

```bash
git add -A
git commit -m "chore(web): confirm canManageInbound rename is complete, no wire-contract dependency (M8)"
```

---

### Task 15: CLAUDE.md section + PR template line (§6)

**Files:**
- Modify: `CLAUDE.md`
- Modify: `.github/PULL_REQUEST_TEMPLATE.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Add the CLAUDE.md section** — insert after the "Web Mutation Handlers — `runAction`" section (before "## Working Style"):

```markdown
### Settings — one concept, one home

Rules from the 2026-09-17 billing/ticketing settings audit
(`docs/superpowers/specs/web-ui/2026-09-17-billing-ticketing-settings-audit.md`),
enforced going forward for every settings surface, not just billing/ticketing:

1. **One concept, one home.** A setting is edited in exactly one place per level.
2. **Settings live with their domain.** Billing settings under Billing, ticketing
   under Ticketing. Actions and reports are not settings.
3. **Two levels, one direction.** Partner default → org override → snapshotted on
   the document. The org always wins; a stated exception must say so in the UI
   where it applies.
4. **One inheritance control.** Blank = inherit; the field always shows the
   inherited *value* and where it comes from.
5. **One resolver per concept**, used by draft, issue and render.
6. **One snapshot moment.** Whatever prints on a customer document is frozen when
   the document becomes customer-visible.
7. **One save pattern per screen type.** Forms: page Save. Lists: row drawer Save.
   Switches with immediate effect: autosave with a toast. Never mixed in a card.
8. **Every screen is in the nav, at one URL.** Old URLs redirect. Enforced by
   `apps/web/src/lib/__tests__/settingsPageRegistry.test.ts`.
9. **A PR that adds a setting states its home, level, resolver, and the number of
   places the concept is configured before and after.** A count that goes up needs
   a removal plan. Required in the PR description for any PR touching
   `pages/settings/**` or a `*Settings*` component — see the PR template.
```

- [ ] **Step 2: Add the PR template line** — read `.github/PULL_REQUEST_TEMPLATE.md` first to place this consistently with its existing checklist style, then add:

```markdown
- [ ] If this PR touches `pages/settings/**` or a `*Settings*` component: states the setting's home, level, resolver, and the count of places it's configured before/after (CLAUDE.md "Settings — one concept, one home", rule 9).
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md .github/PULL_REQUEST_TEMPLATE.md
git commit -m "docs: add 'Settings — one concept, one home' rules to CLAUDE.md and PR template (§6)"
```

---

### Task 16: Mount/composition verification — every moved surface, every redirect

**Files:**
- Test: `apps/web/src/components/settings/settingsConsolidationW01.mount.test.tsx` (new)

**Interfaces:**
- Consumes: `TicketingHubPage` (Task 3), `PartnerBillingSettingsPage` (Task 8), `CatalogSettingsPage`/`CatalogDefaultsCard` (Task 9), `PartnerSettingsPage` (Tasks 3, 12).
- Produces: nothing — this is the final acceptance test for the wave.

`InvoicesPage`'s export button/dialog (Task 10, M5) is deliberately **not**
re-asserted in this file. Task 10 already has its own render-mocked composition
coverage (`InvoicesPage.test.tsx`'s two new tests, Task 10 Step 1) using the
correct existing `fetchWithAuth`/`useAuthStore` mock shape for that component.
This smoke file mounts four unrelated page shells side by side with no fetch
mocking at all today — bolting `InvoicesPage`'s heavier data-fetching
requirements onto it would either need a file-wide `vi.mock('../../stores/auth',
...)` that risks changing what the other three assertions below actually
exercise, or a bespoke one-off simplification, both of which this task's own
convention (below) says to avoid. Trimmed for that reason; Task 10 is the
mount-verified task for M5.

- [ ] **Step 1: Write the composition test**

```tsx
// apps/web/src/components/settings/settingsConsolidationW01.mount.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '../../lib/i18n';
import TicketingHubPage from './TicketingHubPage';
import PartnerBillingSettingsPage from '../billing/PartnerBillingSettingsPage';
import CatalogSettingsPage from './CatalogSettingsPage';
import PartnerSettingsPage from './PartnerSettingsPage';

// Each assertion below names one data-testid from a module this wave moved or
// newly mounted — the smoke test for "the page shell actually wires it up",
// per the "wave plans need an explicit mount task" lesson.

describe('W01 placement — every moved/mounted module renders from its new shell', () => {
  it('TicketingHubPage mounts the 7-tab TicketingSettingsTabs', async () => {
    render(<I18nextProvider i18n={i18n}><TicketingHubPage /></I18nextProvider>);
    expect(await screen.findByTestId('ticketing-settings-tabs')).toBeInTheDocument();
  });

  it('PartnerBillingSettingsPage mounts Defaults/Documents/Connections and the Connections tab reaches accounting/catalog/distributors links', async () => {
    render(<I18nextProvider i18n={i18n}><PartnerBillingSettingsPage /></I18nextProvider>);
    await userEvent.click(await screen.findByTestId('billing-settings-tab-connections'));
    expect(await screen.findByTestId('billing-connections-accounting-link')).toBeInTheDocument();
    expect(screen.getByTestId('billing-connections-catalog-link')).toBeInTheDocument();
    expect(screen.getByTestId('billing-connections-distributors-link')).toBeInTheDocument();
  });

  it('CatalogSettingsPage mounts CatalogDefaultsCard above the item list', async () => {
    render(<I18nextProvider i18n={i18n}><CatalogSettingsPage /></I18nextProvider>);
    expect(await screen.findByTestId('catalog-defaults-card')).toBeInTheDocument();
    expect(screen.getByTestId('catalog-distributors-link')).toBeInTheDocument();
  });

  it('PartnerSettingsPage: Ticketing tab is a link, Modules is its own tab', async () => {
    render(<I18nextProvider i18n={i18n}><PartnerSettingsPage /></I18nextProvider>);
    await userEvent.click(await screen.findByTestId('partner-settings-tab-ticketing'));
    expect(await screen.findByTestId('partner-settings-ticketing-link')).toHaveAttribute('href', '/settings/ticketing');
    await userEvent.click(screen.getByTestId('partner-settings-tab-modules'));
    expect(await screen.findByTestId('partner-modules-card')).toBeInTheDocument();
  });
});
```

(If any test's render setup needs the same auth/store mocking as the individual
suites for these components already use, copy that mocking, not a bespoke
simplification — these are smoke tests over real composition, not isolated units.)

- [ ] **Step 2: Run it**

Run: `cd apps/web && npx vitest run src/components/settings/settingsConsolidationW01.mount.test.tsx`
Expected: PASS (if any assertion fails here, it means an earlier task's Files
block was incomplete — go back and fix that task, not this test).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/settings/settingsConsolidationW01.mount.test.tsx
git commit -m "test(web): mount/composition smoke test for W01 placement moves"
```

---

### Task 17: Final verification

- [ ] **Step 1: Full targeted test run**

Run:
```bash
cd apps/web && npx vitest run \
  src/lib/__tests__/settingsPageRegistry.test.ts \
  src/lib/__tests__/no-silent-mutations.test.ts \
  src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts \
  src/components/settings/TicketingSettingsTabs.test.tsx \
  src/components/settings/TicketingHubPage.test.tsx \
  src/components/settings/PartnerSettingsPage.test.tsx \
  src/components/settings/PartnerSettingsPage.ticketingLink.test.tsx \
  src/components/settings/PartnerSettingsPage.modulesTab.test.tsx \
  src/components/billing/PartnerBillingSettingsPage.test.tsx \
  src/components/billing/BillingDefaultsTab.test.tsx \
  src/components/billing/BillingDocumentsTab.test.tsx \
  src/components/billing/BillingConnectionsTab.test.tsx \
  src/components/billing/InvoicesPage.test.tsx \
  src/components/billing/BillablesExportCard.test.tsx \
  src/components/settings/CatalogDefaultsCard.test.tsx \
  src/components/settings/CatalogSettingsPage.test.tsx \
  src/components/layout/Sidebar.test.tsx \
  src/pages/settings/webhooks/__tests__/redirect.test.ts \
  src/pages/settings/__tests__/checklistTemplatesRedirect.test.ts \
  src/components/settings/settingsConsolidationW01.mount.test.tsx
```
Expected: PASS, every file.

- [ ] **Step 2: Full web suite** (confirms nothing else broke — e.g. any test that imported the deleted `PartnerBillingSettings.tsx`/`TicketingSettingsPage.tsx` directly)

Run: `cd apps/web && npx vitest run`
Expected: PASS. Grep the output for `PartnerBillingSettings` and
`TicketingSettingsPage` (without the `Page`/`Tab` suffixes that survive) to confirm
no stale import slipped through.

- [ ] **Step 3: Typecheck** — verify the script exists first (CLAUDE.md notes there is no root typecheck script; `apps/web`'s own `package.json` may still define one)

Run: `cat apps/web/package.json | grep -A1 '"typecheck"'` — if present, run `cd apps/web && npx tsc --noEmit -p tsconfig.json`; if absent, run `cd apps/web && npx tsc --noEmit` directly against the existing `tsconfig.json`.
Expected: 0 errors.

- [ ] **Step 4: Lint**

Run: `cd apps/web && pnpm lint` (or the root `pnpm lint` scoped, per CLAUDE.md's root scripts list — confirm which actually runs against `apps/web` before relying on it)
Expected: 0 errors.

- [ ] **Step 5: e2e for the one route this wave changed with a Playwright fixture**

Run: `cd e2e-tests && npx playwright test multi-currency.spec.ts`
Expected: PASS.

- [ ] **Step 6: Manual route checklist** (dev server or `pnpm test-stack up`, whichever this session already has running — do not stand up a fresh stack solely for this if one exists)

- [ ] `/settings/ticketing` loads, shows 7 tabs, Email tab shows Inbound Email + M365 (no separate Customer Domains tab), Templates tab shows Canned Responses + Checklist Templates
- [ ] `/settings/ticketing.astro` and old `/settings/partner#ticketing` still land somewhere sane (redirect chain: `ticketing.astro` → `/settings/ticketing`; `#ticketing` hash on the partner hub still shows the link-out card, not a 404)
- [ ] `/settings/billing` shows Defaults / Documents / Connections tabs; Connections tab shows the accounting/catalog/distributors links only (no billables export here); Save still works end-to-end (PATCH succeeds, values persist across reload)
- [ ] `/settings/catalog` shows the new Catalog defaults card above the item list; editing markup/auto-tax/AI style and saving persists
- [ ] `/settings/organizations/<id>/billing` redirects to `/settings/organizations/<id>#billing`
- [ ] `/settings/webhooks` redirects to `/integrations#webhooks`
- [ ] `/settings/ticket-checklist-templates` redirects to `/settings/ticketing#templates`
- [ ] Sidebar shows Ticketing under Settings and Deliverable Templates under Billing
- [ ] Partner hub → Modules tab shows the service management radio, no longer inside Company
- [ ] Billing → Invoices list shows an "Export billables" button next to "New invoice" (not shown when the page is embedded/org-locked inside an org record's Contracts & Billing tab); it opens `BillablesExportCard` in a dialog and the download still works

- [ ] **Step 7: Update the PR body** with the audit rule-9 statement (per Global Constraints) and `Closes #<wave sub-issue>`, then hand off per the Execution Handoff below.

---

## Self-review notes

- **Spec coverage:** M0 (Tasks 2-4, 13), M1 (Task 5), M2 (Task 6), M3 (Tasks 2, 7), M4 (Tasks 8-9), M5 (Task 10), M6 (Task 11), M7 (Task 12), M8 (Tasks 2, 14), M9 (Tasks 1, 4, 7), §6 CLAUDE.md/PR template (Task 15). All nine moves plus §6 are covered.
- **Not built here (explicitly out of Wave 0 scope, confirmed against §5):** Rates tab (typed slot only, M4 note — no task builds UI for it), M10-M20 (Waves 1-2), dropping the dead org `contacts`/`contracts` tabs (explicitly deferred "after one release" per M2's own text).
- **Placeholder scan:** every code block above is complete, runnable TypeScript/Astro against files this plan's author read in this worktree; the one deliberate exception is Task 13 Step 1, which directs the executor to grep for a call site rather than naming it, because that call site was not located during planning — flagged as NOT VERIFIED below, not silently guessed.
- **Type consistency:** `TicketingHubTab`/`TICKETING_HUB_TABS` (Task 2) is the single source both `TicketingSettingsTabs.tsx` and its tests use; `BillingFormState`/`BillingTab` (Task 8) is the single source `PartnerBillingSettingsPage.tsx`, `BillingDefaultsTab.tsx`, `BillingDocumentsTab.tsx` share.

## NOT VERIFIED (flagged rather than guessed)

- The exact test-render helper name used by `PartnerSettingsPage.test.tsx` (Tasks 3, 12 reference `renderWithProviders` as a placeholder for whatever that suite's real helper is called — read that file before writing those steps for real).
- Whether `apps/web/src/pages/integrations/webhooks/index.astro` renders the same `WebhooksPage` component as the redirected-from `settings/webhooks/index.astro` (Task 6 Step 1 requires confirming this before writing the redirect — the audit itself flagged this pair "not fully verified").
- The exact call site that constructs the M365 OAuth consent-return URL containing `?ticketMailbox=` (Task 13 Step 1 — grepped for the param's *usage* inside `TicketingSettingsTabs.tsx`/`PartnerSettingsPage.tsx` but did not trace the redirect's construction, which may be server-side in `apps/api/src`).
- Whether `apps/web/package.json` defines its own `typecheck` script (Task 17 Step 3 checks before assuming either form).
- Whether `pnpm lint` (root) actually scopes to `apps/web` or needs a package filter (Task 17 Step 4).

**Resolved during the coherence pass (2026-09-17, orchestrator review):** M5's
destination (Task 10) is now the Invoices page, not an interim Connections-tab
placement — `BillablesExportCard.tsx`'s root `data-testid` (`billables-export-card`)
was read and confirmed directly, and the gating permissions (`tickets:read`,
`time_entries:read`, partner/system scope) were verified against
`apps/api/src/routes/tickets/export.ts:14-19` and
`packages/shared/src/constants/permissions.ts:60,107`. No dedicated "billables
review" screen was ever needed — the Invoices list already is one.

## Execution Handoff

Plan complete and saved to
`docs/superpowers/plans/web-ui/2026-09-17-settings-consolidation-w01-placement.md`.
Before dispatch: register the feature/wave via `feature-lifecycle`
(`register_feature` with `tracking_issue: LanternOps/breeze#6164`, then
`add_wave`/`start_wave` for this Wave 0 plan) so the branch name and `Closes #`
placeholders above resolve to real issue numbers.

Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using `executing-plans`, batch execution with checkpoints.
