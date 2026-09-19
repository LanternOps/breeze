---
tracking_issue: LanternOps/breeze#5721
---
# Organizations Account Board W02: Board Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the split-view `/settings/organizations` page with a full-width account-readiness board at `/organizations` that lists every customer with its Setup, Account data and Open tickets exceptions as repair links, keeps the manual drag/arrow-key order, and consumes the W01 `GET /orgs/account-readiness` endpoint in batches.

**Architecture:** One pure module (`lib/orgReadiness.ts`) holds every chip rule, applicability rule, filter predicate, sort comparator, repair-link map and hash (de)serialiser, unit-tested table-driven. Three hooks under `components/organizations/board/` own the I/O the page composes: `useAccountReadiness` (200-id batches, concurrency 2, latest-wins, per-batch failure + retry), `useManualOrder` (the incumbent's reorder PATCH through `runAction`, `reorderPending` serialisation, authoritative refetch on failure) and `useArchivedOrganizations` (on-demand `includeArchived=true` walk with server-side search, debounce and a request-token race guard). `OrganizationsBoardPage.tsx` composes them with `RollupBand`, a toolbar and `AccountBoardTable` (a `ResponsiveTable` with lifted `SortableTh`, roving-tabindex rows, drag handle and phone `DataCard`s); `ReadinessChips` renders the exception anchors. Route move: new `pages/organizations/index.astro`, a 301 at `pages/settings/organizations/index.astro`, and a sweep of every link, guard and test that pointed at the old path.

**Tech Stack:** Astro + React 19 islands, react-i18next (eight locales), Tailwind (existing tokens only), Vitest + Testing Library (jsdom), Playwright (`data-testid` only), `runAction`, `useHashState`, `shared/ActionMenu`, `shared/ResponsiveTable`.

**Spec:** `docs/superpowers/specs/web-ui/2026-09-13-organizations-account-board-design.md` — this plan is the **W02** row of its Rollout table. W01 (the API) is assumed merged: `GET /orgs/account-readiness?orgIds=<csv>` returns `{ partnerId, capabilities, serviceManagementMode, orgs[] }` exactly as the spec's `AccountReadinessResponse`. W03 (Integrations column, connectors, "Unlinked" filter) is **not** implemented here; the column/filter config leaves a typed slot for it.

## Global Constraints

- **Every mutation goes through `runAction`** (`apps/web/src/lib/runAction.ts`): create org POST, reorder PATCH, restore POST. The `no-silent-mutations` adopted-path list (`apps/web/src/lib/__tests__/no-silent-mutations.test.ts`, `TARGET_GLOBS`) is updated in the same PR: `src/components/settings/OrganizationsPage.tsx` is replaced by `src/components/organizations/board/OrganizationsBoardPage.tsx` **and** `src/components/organizations/board/useManualOrder.ts`.
- **Hash-only URL state.** Navigable state is `#lens=<setup|account|both>&filter=<key>` via `useHashState`; a bare `#<uuid>` scrolls to and highlights that row. No query params. No `window.location.hash` read inside a `useState` initializer (`no-hash-in-usestate` contract).
- **Eight-locale parity with real translations.** Every new key lands in `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/organizations.json` (and `pages.json` for the title) with the verbatim translations in Task 4. `localeParity`, `translationCoverage` and `keyUsage` (`apps/web/src/lib/i18n/*.test.ts`) must stay green; no route or filesystem path may be a translatable value (repair links live in code). Dynamic keys carry `/* i18n-dynamic */` and their static prefix must name an existing group.
- **No new design tokens.** Colours are the existing semantic classes (`text-success`, `border-warning/40 bg-warning/10 text-warning-strong`, `border-destructive/30 bg-destructive/10 text-destructive`, `bg-primary/5`, `text-muted-foreground`); status pills come from `lib/orgStatus.ts`; skeletons use the existing `skeleton` class.
- **Keep #5708's accessibility contracts:** one Tab stop per row (roving `tabindex` on the name link, the drag handle and the row-menu trigger), Arrow/Home/End move the stop without selecting, a polite live region announces keyboard moves, the reorder handle stays mounted while a PATCH is in flight, dialogs are `shared/Dialog`/the existing modals, the row menu is `shared/ActionMenu`, sortable headers carry `aria-sort`, band cells are buttons with `aria-pressed`, chips are real anchors whose accessible name includes the org name. There is no selected row, so `aria-current` is not used.
- **Applicability before any "Complete":** internal orgs get no Account chips (dash, not Complete); non-active statuses get no billing chips; non-native mode never evaluates overdue invoices; a section absent from `capabilities` hides its column, band cell, filter and sort option entirely (never zeros); archived rows carry no chips.
- **Manual order semantics unchanged:** drag and arrow-key reorder only under Manual order + no search + All filter; PATCH `/orgs/organizations/order` via `runAction`; `reorderPending` disables dragging until reconciliation settles; on failure re-read the list silently (never restore a local snapshot); a 403 surfaces as the toast `runAction` raises.
- **Readiness batching:** at most 200 ids per request, at most two requests in flight, latest-wins when the id set changes, one failed batch marks only its rows "Unavailable" and the band "partial" with Try again.
- Web tests run with `cd apps/web && npx vitest run <path>` (never `pnpm … test -- --run`); full suite `cd apps/web && npx vitest run`; typecheck `cd apps/web && npx tsc --noEmit -p tsconfig.json`.
- Branch: `feature/5721-organizations-account-board/wave-5723`; PR body `Closes #5723` plus the two locale review lines from `apps/web/src/locales/README.md` (`pt-BR strings are machine-drafted pending native review` and `es-419, fr-FR, fr-CA, de-DE, and it-IT strings are machine-drafted pending native review`). The issue numbers are the only placeholders in this plan.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/web/src/lib/orgReadiness.ts` (+ `.test.ts`) | Wire types of the readiness response; `deriveReadinessChips` with every chip + applicability rule; repair-link map; lens/filter/sort/column config; `matchesFilter`, `compareRows`, `sortRows`, `searchMatches`; `parseBoardHash`/`serializeBoardHash`; `purgeCountdownDays`, `shouldShowDeviceCount` (moved from the incumbent) |
| `apps/web/src/components/shared/SortableTh.tsx` (+ `.test.tsx`) | Sortable `<th>` lifted from `billing/shared`, with a `namespace` prop; `billing/shared/SortableTh.tsx` becomes a re-export shim |
| `apps/web/src/components/shared/ActionMenu.tsx` (+ `.test.tsx`) | Gains `href` (link items), `description` (second line), `separatorBefore`, `triggerTabIndex` |
| `apps/web/src/components/organizations/board/useAccountReadiness.ts` (+ `.test.tsx`) | Batched readiness fetch: 200 ids, concurrency 2, latest-wins, per-batch failure, retry |
| `apps/web/src/components/organizations/board/useManualOrder.ts` (+ `.test.tsx`) | Drag + arrow-key reorder, `runAction` PATCH, `reorderPending`, authoritative refetch |
| `apps/web/src/components/organizations/board/useArchivedOrganizations.ts` (+ `.test.tsx`) | On-demand archived fetch with server-side search, debounce, race guard, `archivedTruncated` |
| `apps/web/src/components/organizations/board/ReadinessChips.tsx` (+ `.test.tsx`) | Chip anchors / Complete / dash / Unavailable / skeleton for one cell |
| `apps/web/src/components/organizations/board/RollupBand.tsx` (+ `.test.tsx`) | Band of `aria-pressed` filter buttons; dashes until batches land; partial + Try again |
| `apps/web/src/components/organizations/board/AccountBoardTable.tsx` (+ `.test.tsx`) | `ResponsiveTable`: sortable headers, roving rows, drag handle, row menu, phone cards |
| `apps/web/src/components/organizations/board/OrganizationsBoardPage.tsx` (+ `.render.test.tsx`, `.keyboard.test.tsx`, `.reorder.test.tsx`, `.rowMenu.test.tsx`, `.archived.test.tsx`) | The page island: list, readiness, lens/filter/sort/search/hash, dialogs, restore, footer |
| `apps/web/src/components/organizations/board/boardTestKit.ts` | Shared fixtures and the fetch router used by every page test |
| `apps/web/src/pages/organizations/index.astro` | Mounts the board, title `titles.organizations` |
| `apps/web/src/pages/settings/organizations/index.astro` | `return Astro.redirect('/organizations', 301);` |
| `apps/web/src/locales/*/organizations.json`, `pages.json`, `settings.json` | New `orgBoard.*` + `shared.sortableTh` blocks, `titles.organizations`; removal of the split-view-only `organizationsPage.*` keys |
| `e2e-tests/pages/OrganizationsBoardPage.ts`, `e2e-tests/tests/organizations-board.spec.ts` | Playwright Page Object + spec |

Deleted: `apps/web/src/components/settings/OrganizationsPage.tsx` and its fourteen `OrganizationsPage.*.test.tsx` files (three of them relocated, see Task 12), the `section` variant of `SiteList`.

---

### Task 1: Pure readiness rules — `deriveReadinessChips` and the org-cell helpers

**Files:**
- Create: `apps/web/src/lib/orgReadiness.ts`
- Test: `apps/web/src/lib/orgReadiness.test.ts`

**Interfaces:**
- Consumes: `Organization` (`apps/web/src/components/settings/organizationTypes.ts`), `ServiceManagementMode` (`apps/web/src/stores/orgStore.ts`), `isArchiveLifecycleOrg` (`apps/web/src/lib/archiveLifecycle.ts`).
- Produces: types `ReadinessCapabilities`, `ReadinessPrimaryContact`, `ReadinessTickets`, `ReadinessOrg`, `AccountReadinessResponse`, `ReadinessRowState`, `ChipKey`, `RepairTarget`, `ReadinessChip`, `DerivedChips`, `ReadinessOrgRow`; constants `STALE_CHECK_IN_DAYS`, `REPAIR_TARGETS`; functions `repairHref(target, orgId)`, `staleCheckInDays(lastSeenAt, now)`, `deriveReadinessChips(org, readiness, capabilities, mode, now): DerivedChips | null`, `shouldShowDeviceCount(count)`, `purgeCountdownDays(purgeAt, now?)`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/src/lib/orgReadiness.test.ts
import { describe, expect, it } from 'vitest';
import {
  deriveReadinessChips,
  purgeCountdownDays,
  repairHref,
  shouldShowDeviceCount,
  staleCheckInDays,
  STALE_CHECK_IN_DAYS,
  type ChipKey,
  type ReadinessCapabilities,
  type ReadinessOrg,
} from './orgReadiness';

const NOW = new Date('2026-09-13T12:00:00.000Z');
const ORG_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const ALL_CAPS: ReadinessCapabilities = {
  sites: true, devices: true, policies: true, contacts: true, portalUsers: true, invoices: true, tickets: true, integrations: false,
};

type Overrides = Partial<Omit<ReadinessOrg, 'setup' | 'account'>> & {
  setup?: Partial<ReadinessOrg['setup']>;
  account?: Partial<ReadinessOrg['account']>;
};

/** A fully set-up, fully documented active customer — every chip test removes one thing from it. */
function readiness(overrides: Overrides = {}): ReadinessOrg {
  const { setup, account, ...rest } = overrides;
  return {
    orgId: ORG_ID,
    type: 'customer',
    status: 'active',
    ...rest,
    setup: { sites: 1, devices: 2, lastSeenAt: '2026-09-13T11:00:00.000Z', policyAssigned: true, ...setup },
    account: {
      primaryContact: { name: 'Jane Doe', email: 'jane@alpha.test', phone: '+1 555 0100', mobile: null },
      billingRoleContact: true,
      billingAddress: true,
      pendingInvitations: 0,
      overdueInvoices: 0,
      ...account,
    },
  };
}

const liveOrg = { id: ORG_ID, status: 'active' as const, type: 'customer' as const };
const daysAgo = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000 - extraMs).toISOString();
const derive = (
  r: ReadinessOrg | undefined,
  caps: ReadinessCapabilities | null = ALL_CAPS,
  mode: 'native' | 'external' | 'off' = 'native',
  org: Parameters<typeof deriveReadinessChips>[0] = liveOrg,
) => deriveReadinessChips(org, r, caps, mode, NOW);
const keys = (chips: Array<{ key: ChipKey }>) => chips.map((c) => c.key);

describe('deriveReadinessChips — a complete org', () => {
  it('yields no chips and an applicable account section', () => {
    expect(derive(readiness())).toEqual({ setup: [], account: [], accountApplicable: true });
  });

  it('returns null while the org has no readiness payload or the capabilities are unknown', () => {
    expect(derive(undefined)).toBeNull();
    expect(derive(readiness(), null)).toBeNull();
  });
});

describe('deriveReadinessChips — Setup chips', () => {
  it.each<[string, Overrides, ChipKey[], string]>([
    ['no site', { setup: { sites: 0 } }, ['noSite'], `/organizations/${ORG_ID}#sites`],
    ['no devices enrolled (and no check-in chip on top of it)', { setup: { devices: 0, lastSeenAt: null } }, ['noDevices'], `/organizations/${ORG_ID}#devices`],
    ['no agent has checked in', { setup: { devices: 3, lastSeenAt: null } }, ['noCheckIn'], `/organizations/${ORG_ID}#devices`],
    ['stale check-in at exactly the threshold', { setup: { lastSeenAt: daysAgo(STALE_CHECK_IN_DAYS) } }, ['staleCheckIn'], `/organizations/${ORG_ID}#devices`],
    ['no policy assigned', { setup: { policyAssigned: false } }, ['noPolicy'], '/configuration-policies'],
  ])('%s', (_name, overrides, expectedKeys, href) => {
    const result = derive(readiness(overrides))!;
    expect(keys(result.setup)).toEqual(expectedKeys);
    expect(result.setup[0].href).toBe(href);
    expect(result.setup[0].tone).toBe('warning');
  });

  it('reports the whole number of stale days', () => {
    const result = derive(readiness({ setup: { lastSeenAt: daysAgo(9, 5 * 60 * 60 * 1000) } }))!;
    expect(result.setup).toEqual([expect.objectContaining({ key: 'staleCheckIn', count: 9 })]);
  });

  it('does not flag a check-in younger than the threshold', () => {
    expect(derive(readiness({ setup: { lastSeenAt: daysAgo(STALE_CHECK_IN_DAYS - 1, 23 * 60 * 60 * 1000) } }))!.setup).toEqual([]);
  });

  it('does not flag an unparseable timestamp', () => {
    expect(derive(readiness({ setup: { lastSeenAt: 'not-a-date' } }))!.setup).toEqual([]);
  });

  it('keeps the spec order: site, devices, policy', () => {
    const result = derive(readiness({ setup: { sites: 0, devices: 0, policyAssigned: false } }))!;
    expect(keys(result.setup)).toEqual(['noSite', 'noDevices', 'noPolicy']);
  });

  it('still evaluates Setup for an internal org', () => {
    const result = derive(readiness({ type: 'internal', setup: { sites: 0 } }))!;
    expect(keys(result.setup)).toEqual(['noSite']);
  });
});

describe('deriveReadinessChips — Account data chips', () => {
  it.each<[string, Overrides, ChipKey[], string, 'warning' | 'destructive']>([
    ['no primary contact (and no email/phone chips on top of it)', { account: { primaryContact: null } }, ['primaryContact'], `/organizations/${ORG_ID}#contacts`, 'warning'],
    ['primary contact without email', { account: { primaryContact: { name: 'Jane Doe', email: null, phone: '+1', mobile: null } } }, ['contactEmail'], `/organizations/${ORG_ID}#contacts`, 'warning'],
    ['primary contact with neither phone nor mobile', { account: { primaryContact: { name: 'Jane Doe', email: 'j@x.test', phone: null, mobile: null } } }, ['contactPhone'], `/organizations/${ORG_ID}#contacts`, 'warning'],
    ['no billing-role contact', { account: { billingRoleContact: false } }, ['billingContact'], `/organizations/${ORG_ID}#contacts`, 'warning'],
    ['no billing address', { account: { billingAddress: false } }, ['billingAddress'], `/settings/organizations/${ORG_ID}`, 'warning'],
    ['overdue invoices', { account: { overdueInvoices: 2 } }, ['overdueInvoices'], `/organizations/${ORG_ID}#billing`, 'destructive'],
    ['invitations not accepted', { account: { pendingInvitations: 1 } }, ['invitation'], `/organizations/${ORG_ID}#contacts`, 'warning'],
  ])('%s', (_name, overrides, expectedKeys, href, tone) => {
    const result = derive(readiness(overrides))!;
    expect(keys(result.account)).toEqual(expectedKeys);
    expect(result.account[0].href).toBe(href);
    expect(result.account[0].tone).toBe(tone);
  });

  it('a mobile number satisfies reachability when the phone is empty', () => {
    const result = derive(readiness({ account: { primaryContact: { name: 'Jane Doe', email: 'j@x.test', phone: null, mobile: '+1 555 0199' } } }))!;
    expect(result.account).toEqual([]);
  });

  it('carries the counts for overdue invoices and pending invitations', () => {
    const result = derive(readiness({ account: { overdueInvoices: 3, pendingInvitations: 2 } }))!;
    expect(result.account).toEqual([
      expect.objectContaining({ key: 'overdueInvoices', count: 3 }),
      expect.objectContaining({ key: 'invitation', count: 2 }),
    ]);
  });

  it('keeps the spec order: contact, billing contact, billing address, overdue, invitation', () => {
    const result = derive(readiness({
      account: { primaryContact: null, billingRoleContact: false, billingAddress: false, overdueInvoices: 1, pendingInvitations: 1 },
    }))!;
    expect(keys(result.account)).toEqual(['primaryContact', 'billingContact', 'billingAddress', 'overdueInvoices', 'invitation']);
  });
});

describe('deriveReadinessChips — applicability rules', () => {
  it('an internal org gets no Account chips and is marked not applicable, even with everything missing', () => {
    const result = derive(readiness({
      type: 'internal',
      account: { primaryContact: null, billingRoleContact: false, billingAddress: false, overdueInvoices: 4, pendingInvitations: 2 },
    }))!;
    expect(result.account).toEqual([]);
    expect(result.accountApplicable).toBe(false);
  });

  it('the readiness payload type wins over the list row type', () => {
    const result = derive(readiness({ type: 'internal', account: { primaryContact: null } }), ALL_CAPS, 'native', { ...liveOrg, type: 'customer' })!;
    expect(result.account).toEqual([]);
  });

  it.each(['trial', 'suspended', 'churned', 'offboarding', 'merging'])(
    'a %s org gets contact chips but no billing chips',
    (status) => {
      const result = derive(readiness({
        status,
        account: { primaryContact: { name: 'Jane Doe', email: null, phone: '+1', mobile: null }, billingRoleContact: false, billingAddress: false, overdueInvoices: 2 },
      }))!;
      expect(keys(result.account)).toEqual(['contactEmail']);
    },
  );

  it('does not evaluate overdue invoices outside native service-management mode', () => {
    expect(derive(readiness({ account: { overdueInvoices: 2 } }), ALL_CAPS, 'external')!.account).toEqual([]);
    expect(derive(readiness({ account: { overdueInvoices: 2 } }), ALL_CAPS, 'off')!.account).toEqual([]);
  });

  it.each<[keyof ReadinessCapabilities, Overrides]>([
    ['sites', { setup: { sites: 0 } }],
    ['devices', { setup: { devices: 0 } }],
    ['policies', { setup: { policyAssigned: false } }],
    ['invoices', { account: { overdueInvoices: 2 } }],
    ['portalUsers', { account: { pendingInvitations: 2 } }],
    ['contacts', { account: { primaryContact: null } }],
  ])('a section absent from capabilities (%s) contributes no chip', (capability, overrides) => {
    const result = derive(readiness(overrides), { ...ALL_CAPS, [capability]: false })!;
    expect([...result.setup, ...result.account]).toEqual([]);
  });

  it('an archived org has no chips at all', () => {
    const result = derive(
      readiness({ setup: { sites: 0 }, account: { primaryContact: null } }),
      ALL_CAPS,
      'native',
      { id: ORG_ID, status: 'archived', archived: true },
    )!;
    expect(result).toEqual({ setup: [], account: [], accountApplicable: false });
  });

  it('an org mid-archive-drain (offboarding + archived flag) has no chips either', () => {
    const result = derive(readiness({ setup: { sites: 0 } }), ALL_CAPS, 'native', { id: ORG_ID, status: 'offboarding', archived: true })!;
    expect(result.setup).toEqual([]);
  });
});

describe('helpers', () => {
  it('staleCheckInDays floors whole days and rejects garbage', () => {
    expect(staleCheckInDays(daysAgo(3, 60_000), NOW)).toBe(3);
    expect(staleCheckInDays('nope', NOW)).toBeNull();
  });

  it('repairHref maps every target', () => {
    expect(repairHref('sites', ORG_ID)).toBe(`/organizations/${ORG_ID}#sites`);
    expect(repairHref('devices', ORG_ID)).toBe(`/organizations/${ORG_ID}#devices`);
    expect(repairHref('contacts', ORG_ID)).toBe(`/organizations/${ORG_ID}#contacts`);
    expect(repairHref('billing', ORG_ID)).toBe(`/organizations/${ORG_ID}#billing`);
    expect(repairHref('settings', ORG_ID)).toBe(`/settings/organizations/${ORG_ID}`);
    expect(repairHref('policies', ORG_ID)).toBe('/configuration-policies');
  });

  // #3699 — the org card renders `{{count}} devices`; the org-scoped projection
  // omits the count and a bare " devices" read as a loading bug. 0 is a real value.
  it('shouldShowDeviceCount shows real numbers including zero, hides absent and non-finite', () => {
    expect(shouldShowDeviceCount(12)).toBe(true);
    expect(shouldShowDeviceCount(0)).toBe(true);
    expect(shouldShowDeviceCount(undefined)).toBe(false);
    expect(shouldShowDeviceCount(Number.NaN)).toBe(false);
  });

  it('purgeCountdownDays rounds up and collapses null/garbage to null', () => {
    expect(purgeCountdownDays('2026-09-14T00:00:01.000Z', NOW)).toBe(1);
    expect(purgeCountdownDays('2026-09-13T12:00:00.000Z', NOW)).toBe(0);
    expect(purgeCountdownDays(null, NOW)).toBeNull();
    expect(purgeCountdownDays(undefined, NOW)).toBeNull();
    expect(purgeCountdownDays('garbage', NOW)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npx vitest run src/lib/orgReadiness.test.ts`
Expected: FAIL — `Failed to resolve import "./orgReadiness"`.

- [ ] **Step 3: Write the module**

```ts
// apps/web/src/lib/orgReadiness.ts
import type { Organization } from '@/components/settings/organizationTypes';
import type { ServiceManagementMode } from '@/stores/orgStore';
import { isArchiveLifecycleOrg } from '@/lib/archiveLifecycle';

/* ----------------------------------------------------------------------------
 * Wire contract of GET /orgs/account-readiness (W01). Mirrors the spec's
 * AccountReadinessResponse. A section withheld by permission or mode is absent
 * from `capabilities` AND from every org; the web treats absence as "not
 * evaluated" — never as zero and never as evidence of completeness.
 * ------------------------------------------------------------------------- */
export interface ReadinessCapabilities {
  sites: boolean;
  devices: boolean;
  policies: boolean;
  contacts: boolean;
  portalUsers: boolean;
  invoices: boolean;
  tickets: boolean;
  /** W03: connected_apps:read. Nothing in W02 reads it. */
  integrations: boolean;
}

export interface ReadinessPrimaryContact {
  name: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
}

export interface ReadinessTickets {
  open: number;
  awaitingCustomer: number;
  slaBreached: number;
}

export interface ReadinessOrg {
  orgId: string;
  type: 'customer' | 'internal' | 'quick_support';
  status: string;
  setup: {
    sites?: number;
    devices?: number;
    /** max(last_seen_at) over non-decommissioned devices; null = never; absent = not evaluated. */
    lastSeenAt?: string | null;
    policyAssigned: boolean;
  };
  account: {
    primaryContact: ReadinessPrimaryContact | null;
    billingRoleContact: boolean;
    billingAddress: boolean;
    pendingInvitations?: number;
    overdueInvoices?: number;
  };
  /** W03: per-system mapping state. Typed loosely until the Integrations column lands. */
  integrations?: unknown[];
  tickets?: ReadinessTickets;
}

export interface AccountReadinessResponse {
  partnerId: string;
  capabilities: ReadinessCapabilities;
  serviceManagementMode: ServiceManagementMode;
  orgs: ReadinessOrg[];
}

/** Per-row fetch state kept by `useAccountReadiness`; declared here so this
 *  pure module can type `BoardRow` without importing the hook. */
export type ReadinessRowState = 'pending' | 'ready' | 'failed';

/* --------------------------------- Chips --------------------------------- */

export const STALE_CHECK_IN_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type SetupChipKey = 'noSite' | 'noDevices' | 'noCheckIn' | 'staleCheckIn' | 'noPolicy';
export type AccountChipKey =
  | 'primaryContact'
  | 'contactEmail'
  | 'contactPhone'
  | 'billingContact'
  | 'billingAddress'
  | 'overdueInvoices'
  | 'invitation';
export type ChipKey = SetupChipKey | AccountChipKey;
export type RepairTarget = 'sites' | 'devices' | 'policies' | 'contacts' | 'settings' | 'billing';

export interface ReadinessChip {
  key: ChipKey;
  /** amber = something missing, red = something wrong (spec: Account data cell). */
  tone: 'warning' | 'destructive';
  target: RepairTarget;
  href: string;
  /** Interpolated into the label: stale days, overdue invoices, pending invitations. */
  count?: number;
}

export interface DerivedChips {
  setup: ReadinessChip[];
  account: ReadinessChip[];
  /** False for internal orgs: their Account cell renders a dash, never "Complete". */
  accountApplicable: boolean;
}

/** Where each chip repairs. Record tab hashes are `ORG_RECORD_TABS` ids (orgRecordTabs.ts). */
export const REPAIR_TARGETS: Record<ChipKey, RepairTarget> = {
  noSite: 'sites',
  noDevices: 'devices',
  noCheckIn: 'devices',
  staleCheckIn: 'devices',
  noPolicy: 'policies',
  primaryContact: 'contacts',
  contactEmail: 'contacts',
  contactPhone: 'contacts',
  billingContact: 'contacts',
  billingAddress: 'settings',
  overdueInvoices: 'billing',
  invitation: 'contacts',
};

export function repairHref(target: RepairTarget, orgId: string): string {
  switch (target) {
    case 'sites':
      return `/organizations/${orgId}#sites`;
    case 'devices':
      return `/organizations/${orgId}#devices`;
    case 'contacts':
      return `/organizations/${orgId}#contacts`;
    case 'billing':
      return `/organizations/${orgId}#billing`;
    case 'settings':
      return `/settings/organizations/${orgId}`;
    case 'policies':
      return '/configuration-policies';
  }
}

/** Whole days since `lastSeenAt` (floored); null when unparseable so no NaN ever reaches a label. */
export function staleCheckInDays(lastSeenAt: string, now: Date): number | null {
  const seen = new Date(lastSeenAt).getTime();
  if (Number.isNaN(seen)) return null;
  return Math.floor((now.getTime() - seen) / DAY_MS);
}

function chip(key: ChipKey, orgId: string, tone: ReadinessChip['tone'], count?: number): ReadinessChip {
  const target = REPAIR_TARGETS[key];
  const base: ReadinessChip = { key, tone, target, href: repairHref(target, orgId) };
  return count === undefined ? base : { ...base, count };
}

export type ReadinessOrgRow = Pick<Organization, 'id' | 'status' | 'type' | 'archived'>;

/**
 * Every Setup and Account chip plus every applicability rule from the spec, in
 * one place and nowhere else. Returns null when the org has no readiness
 * payload yet or the capabilities are unknown: the cell then renders a skeleton
 * or a dash, never "Complete".
 */
export function deriveReadinessChips(
  org: ReadinessOrgRow,
  readiness: ReadinessOrg | undefined,
  capabilities: ReadinessCapabilities | null,
  mode: ServiceManagementMode,
  now: Date,
): DerivedChips | null {
  if (!readiness || !capabilities) return null;
  // Archived and archive-draining orgs are listed only under the Archived
  // filter and carry no readiness chips.
  if (isArchiveLifecycleOrg(org)) return { setup: [], account: [], accountApplicable: false };

  const type = readiness.type ?? org.type ?? 'customer';
  const status = readiness.status ?? org.status;
  const setup: ReadinessChip[] = [];
  const account: ReadinessChip[] = [];

  // ---- Setup: applies to every live org, internal included ----
  if (capabilities.sites && readiness.setup.sites === 0) setup.push(chip('noSite', org.id, 'warning'));
  if (capabilities.devices && typeof readiness.setup.devices === 'number') {
    const devices = readiness.setup.devices;
    if (devices === 0) {
      setup.push(chip('noDevices', org.id, 'warning'));
    } else if (readiness.setup.lastSeenAt === null) {
      setup.push(chip('noCheckIn', org.id, 'warning'));
    } else if (typeof readiness.setup.lastSeenAt === 'string') {
      const days = staleCheckInDays(readiness.setup.lastSeenAt, now);
      if (days !== null && days >= STALE_CHECK_IN_DAYS) setup.push(chip('staleCheckIn', org.id, 'warning', days));
    }
  }
  if (capabilities.policies && !readiness.setup.policyAssigned) setup.push(chip('noPolicy', org.id, 'warning'));

  // ---- Account data: customer orgs only ----
  const accountApplicable = type === 'customer';
  if (accountApplicable) {
    if (capabilities.contacts) {
      const primary = readiness.account.primaryContact;
      if (!primary) {
        account.push(chip('primaryContact', org.id, 'warning'));
      } else {
        if (primary.email === null) account.push(chip('contactEmail', org.id, 'warning'));
        if (primary.phone === null && primary.mobile === null) account.push(chip('contactPhone', org.id, 'warning'));
      }
    }
    // Billing checks apply to ACTIVE customer orgs only: trial, suspended,
    // churned, offboarding and merging orgs are not billed as customers.
    const billingApplies = status === 'active';
    if (billingApplies && capabilities.contacts && !readiness.account.billingRoleContact) {
      account.push(chip('billingContact', org.id, 'warning'));
    }
    if (billingApplies && !readiness.account.billingAddress) account.push(chip('billingAddress', org.id, 'warning'));
    if (billingApplies && capabilities.invoices && mode === 'native' && (readiness.account.overdueInvoices ?? 0) > 0) {
      account.push(chip('overdueInvoices', org.id, 'destructive', readiness.account.overdueInvoices));
    }
    if (capabilities.portalUsers && (readiness.account.pendingInvitations ?? 0) > 0) {
      account.push(chip('invitation', org.id, 'warning', readiness.account.pendingInvitations));
    }
  }

  return { setup, account, accountApplicable };
}

/* ------------------------- Organization cell helpers ---------------------- */
// Moved verbatim from the retired settings/OrganizationsPage.tsx (#3699, #4166).

/**
 * Whether the org cell should render its `{{count}} devices` label. The count
 * is absent for organization-scoped callers (minimal projection of
 * `GET /orgs/organizations`); interpolating `undefined` produced a bare
 * " devices". `0` is a real value and must render, so this is not a truthiness check.
 */
export function shouldShowDeviceCount(count: number | undefined): boolean {
  return typeof count === 'number' && Number.isFinite(count);
}

/**
 * Days remaining until an archived org's scheduled purge, rounded UP so a
 * countdown reading "1 day" never flips to "0 days" while any part of that day
 * remains. `null` covers both `purgeAt: null` ("kept indefinitely") and an
 * unparseable timestamp, so callers treat the two identically instead of
 * rendering `NaN`.
 */
export function purgeCountdownDays(purgeAt: string | null | undefined, now: Date = new Date()): number | null {
  if (!purgeAt) return null;
  const target = new Date(purgeAt);
  if (Number.isNaN(target.getTime())) return null;
  return Math.ceil((target.getTime() - now.getTime()) / DAY_MS);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run src/lib/orgReadiness.test.ts`
Expected: PASS (all `describe` blocks green).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/orgReadiness.ts apps/web/src/lib/orgReadiness.test.ts
git commit -m "feat(web): pure account-readiness rules — deriveReadinessChips with every chip and applicability rule (W02 #5723)"
```

---

### Task 2: Lens, filters, sort, columns, search and hash serialisation

**Files:**
- Modify: `apps/web/src/lib/orgReadiness.ts` (append below the org-cell helpers)
- Test: `apps/web/src/lib/orgReadiness.test.ts` (append)

**Interfaces:**
- Produces: `BOARD_LENSES`, `BoardLens`, `DEFAULT_LENS`, `BOARD_FILTERS`, `BoardFilter`, `DEFAULT_FILTER`, `BOARD_SORTS`, `BoardSort`, `BOARD_COLUMNS`, `BoardColumn`, `BoardRow`, `isBoardLens`, `isBoardFilter`, `isBoardSort`, `visibleColumns(lens, capabilities)`, `visibleFilters(capabilities)`, `lensForFilter(filter, lens)`, `matchesFilter(filter, row)`, `compareRows(sort)`, `sortRows(rows, sort)`, `searchMatches(query, org, readiness)`, `BoardHashState`, `parseBoardHash(hash)`, `serializeBoardHash({ lens, filter })`.

- [ ] **Step 1: Append the failing tests**

```ts
// apps/web/src/lib/orgReadiness.test.ts — append below the existing imports/tests
import {
  BOARD_COLUMNS,
  BOARD_FILTERS,
  compareRows,
  lensForFilter,
  matchesFilter,
  parseBoardHash,
  searchMatches,
  serializeBoardHash,
  sortRows,
  visibleColumns,
  visibleFilters,
  type BoardRow,
} from './orgReadiness';

function row(overrides: {
  name?: string;
  status?: BoardRow['org']['status'];
  archived?: true;
  setup?: number;
  account?: number;
  open?: number;
  primary?: { name: string | null; email: string | null } | null;
}): BoardRow {
  const setupChips = Array.from({ length: overrides.setup ?? 0 }, () => ({
    key: 'noSite' as const, tone: 'warning' as const, target: 'sites' as const, href: '#',
  }));
  const accountChips = Array.from({ length: overrides.account ?? 0 }, () => ({
    key: 'primaryContact' as const, tone: 'warning' as const, target: 'contacts' as const, href: '#',
  }));
  const org = {
    id: 'aaaaaaaa-1111-4111-8111-111111111111',
    name: overrides.name ?? 'Alpha Ltd',
    status: overrides.status ?? ('active' as const),
    createdAt: '2026-01-01T00:00:00Z',
    ...(overrides.archived ? { archived: true as const } : {}),
  };
  const readiness: BoardRow['readiness'] = {
    orgId: org.id,
    type: 'customer',
    status: org.status,
    setup: { policyAssigned: true },
    account: {
      primaryContact: overrides.primary === undefined
        ? { name: 'Jane Doe', email: 'jane@alpha.test', phone: null, mobile: null }
        : overrides.primary && { ...overrides.primary, phone: null, mobile: null },
      billingRoleContact: true,
      billingAddress: true,
    },
    tickets: { open: overrides.open ?? 0, awaitingCustomer: 0, slaBreached: 0 },
  };
  return { org, readiness, state: 'ready', chips: { setup: setupChips, account: accountChips, accountApplicable: true } };
}

describe('filters', () => {
  it('has the spec order and leaves W03 room', () => {
    expect([...BOARD_FILTERS]).toEqual(['all', 'setupIncomplete', 'accountMissing', 'openTickets', 'trial', 'archived']);
    expect([...BOARD_COLUMNS]).toEqual(['setup', 'account', 'integrations', 'tickets']);
  });

  it('matchesFilter implements every predicate', () => {
    expect(matchesFilter('all', row({}))).toBe(true);
    expect(matchesFilter('setupIncomplete', row({ setup: 1 }))).toBe(true);
    expect(matchesFilter('setupIncomplete', row({}))).toBe(false);
    expect(matchesFilter('accountMissing', row({ account: 2 }))).toBe(true);
    expect(matchesFilter('accountMissing', row({}))).toBe(false);
    expect(matchesFilter('openTickets', row({ open: 3 }))).toBe(true);
    expect(matchesFilter('openTickets', row({ open: 0 }))).toBe(false);
    expect(matchesFilter('trial', row({ status: 'trial' }))).toBe(true);
    expect(matchesFilter('trial', row({}))).toBe(false);
    expect(matchesFilter('archived', row({ archived: true }))).toBe(true);
    expect(matchesFilter('archived', row({}))).toBe(false);
  });

  it('a row whose readiness has not landed matches no readiness filter', () => {
    const pending: BoardRow = { ...row({}), readiness: undefined, state: 'pending', chips: null };
    expect(matchesFilter('setupIncomplete', pending)).toBe(false);
    expect(matchesFilter('accountMissing', pending)).toBe(false);
    expect(matchesFilter('openTickets', pending)).toBe(false);
    expect(matchesFilter('all', pending)).toBe(true);
  });

  it('visibleFilters drops Open tickets without the tickets capability and always keeps Archived', () => {
    const caps = { sites: true, devices: true, policies: true, contacts: true, portalUsers: true, invoices: true, tickets: false, integrations: false };
    expect(visibleFilters(caps)).toEqual(['all', 'setupIncomplete', 'accountMissing', 'trial', 'archived']);
    expect(visibleFilters({ ...caps, tickets: true })).toEqual([...BOARD_FILTERS]);
    expect(visibleFilters(null)).toEqual(['all', 'setupIncomplete', 'accountMissing', 'trial', 'archived']);
  });

  it('lensForFilter forces Both only when the filter’s evidence is hidden', () => {
    expect(lensForFilter('setupIncomplete', 'account')).toBe('both');
    expect(lensForFilter('setupIncomplete', 'setup')).toBe('setup');
    expect(lensForFilter('accountMissing', 'setup')).toBe('both');
    expect(lensForFilter('accountMissing', 'account')).toBe('account');
    expect(lensForFilter('openTickets', 'setup')).toBe('setup');
    expect(lensForFilter('trial', 'account')).toBe('account');
    expect(lensForFilter('all', 'setup')).toBe('setup');
  });
});

describe('columns', () => {
  const caps = { sites: true, devices: true, policies: true, contacts: true, portalUsers: true, invoices: true, tickets: true, integrations: true };

  it('follows the lens and the tickets capability; Integrations stays off until W03', () => {
    expect(visibleColumns('both', caps)).toEqual(['setup', 'account', 'tickets']);
    expect(visibleColumns('setup', caps)).toEqual(['setup', 'tickets']);
    expect(visibleColumns('account', caps)).toEqual(['account', 'tickets']);
    expect(visibleColumns('both', { ...caps, tickets: false })).toEqual(['setup', 'account']);
  });

  it('renders Setup and Account (always-true capabilities) before the first batch lands, never Tickets', () => {
    expect(visibleColumns('both', null)).toEqual(['setup', 'account']);
  });
});

describe('sort', () => {
  const a = row({ name: 'Alpha', open: 1 });
  const b = row({ name: 'Beta', open: 5 });
  const c = row({ name: 'Gamma', open: 5 });

  it('manual keeps the given order (same array reference)', () => {
    const rows = [c, a, b];
    expect(compareRows('manual')).toBeNull();
    expect(sortRows(rows, 'manual')).toBe(rows);
  });

  it('name sorts A to Z', () => {
    expect(sortRows([c, a, b], 'name').map((r) => r.org.name)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('tickets sorts by open count descending, then name', () => {
    expect(sortRows([c, a, b], 'tickets').map((r) => r.org.name)).toEqual(['Beta', 'Gamma', 'Alpha']);
  });

  it('tickets treats an unknown count as zero', () => {
    const unknown: BoardRow = { ...row({ name: 'Zed' }), readiness: undefined, state: 'pending', chips: null };
    expect(sortRows([unknown, a], 'tickets').map((r) => r.org.name)).toEqual(['Alpha', 'Zed']);
  });
});

describe('search', () => {
  const r = row({ name: 'Alpha Ltd', primary: { name: 'Jane Doe', email: 'jane@alpha.test' } });

  it('matches org name, contact name and contact email, case-insensitively', () => {
    expect(searchMatches('alpha', r.org, r.readiness)).toBe(true);
    expect(searchMatches('JANE', r.org, r.readiness)).toBe(true);
    expect(searchMatches('@alpha.test', r.org, r.readiness)).toBe(true);
    expect(searchMatches('nothing', r.org, r.readiness)).toBe(false);
  });

  it('an empty query matches everything and a missing contact matches only the name', () => {
    expect(searchMatches('   ', r.org, r.readiness)).toBe(true);
    const noContact = row({ name: 'Alpha Ltd', primary: null });
    expect(searchMatches('jane', noContact.org, noContact.readiness)).toBe(false);
    expect(searchMatches('jane', r.org, undefined)).toBe(false);
  });
});

describe('hash', () => {
  it('serialises lens and filter explicitly so a localStorage default can never override a chosen value', () => {
    expect(serializeBoardHash({ lens: 'both', filter: 'all' })).toBe('lens=both&filter=all');
    expect(serializeBoardHash({ lens: 'setup', filter: 'trial' })).toBe('lens=setup&filter=trial');
  });

  it('parses its own output, with or without the leading #', () => {
    expect(parseBoardHash('#lens=setup&filter=archived')).toEqual({ lens: 'setup', filter: 'archived' });
    expect(parseBoardHash('lens=account')).toEqual({ lens: 'account' });
    expect(parseBoardHash('filter=openTickets')).toEqual({ filter: 'openTickets' });
  });

  it('ignores unknown values and falls back to undefined for an empty or foreign hash', () => {
    expect(parseBoardHash('')).toBeUndefined();
    expect(parseBoardHash('#')).toBeUndefined();
    expect(parseBoardHash('lens=nope&filter=unlinked')).toBeUndefined();
    expect(parseBoardHash('lens=setup&filter=unlinked')).toEqual({ lens: 'setup' });
    expect(parseBoardHash('tickets')).toBeUndefined();
  });

  it('treats a bare uuid as a row highlight (the incumbent’s selected-org deep link)', () => {
    expect(parseBoardHash('#AAAAAAAA-1111-4111-8111-111111111111')).toEqual({ highlightOrgId: 'aaaaaaaa-1111-4111-8111-111111111111' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npx vitest run src/lib/orgReadiness.test.ts`
Expected: FAIL — the new named imports are `undefined` / not exported.

- [ ] **Step 3: Append the implementation**

```ts
// apps/web/src/lib/orgReadiness.ts — append at the end of the file

/* ---------------------- Lens, filters, sort, columns ---------------------- */

export const BOARD_LENSES = ['setup', 'account', 'both'] as const;
export type BoardLens = (typeof BOARD_LENSES)[number];
export const DEFAULT_LENS: BoardLens = 'both';

/** Chip order = band order. W03 inserts 'unlinked' between accountMissing and openTickets. */
export const BOARD_FILTERS = ['all', 'setupIncomplete', 'accountMissing', 'openTickets', 'trial', 'archived'] as const;
export type BoardFilter = (typeof BOARD_FILTERS)[number];
export const DEFAULT_FILTER: BoardFilter = 'all';

export const BOARD_SORTS = ['manual', 'name', 'tickets'] as const;
export type BoardSort = (typeof BOARD_SORTS)[number];

/** Readiness columns in render order. 'integrations' is the W03 slot. */
export const BOARD_COLUMNS = ['setup', 'account', 'integrations', 'tickets'] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];
/** W03 replaces this constant with `capabilities.integrations`; until the column has a renderer it stays off. */
const INTEGRATIONS_COLUMN_ENABLED = false;

export interface BoardRow {
  org: Organization;
  readiness: ReadinessOrg | undefined;
  state: ReadinessRowState;
  chips: DerivedChips | null;
}

export const isBoardLens = (value: string): value is BoardLens => (BOARD_LENSES as readonly string[]).includes(value);
export const isBoardFilter = (value: string): value is BoardFilter => (BOARD_FILTERS as readonly string[]).includes(value);
export const isBoardSort = (value: string): value is BoardSort => (BOARD_SORTS as readonly string[]).includes(value);

const LENS_HIDES: Record<BoardLens, BoardColumn | null> = { setup: 'account', account: 'setup', both: null };
/** Which column carries a filter's evidence; applying it under a lens that hides that column forces Both. */
const FILTER_EVIDENCE: Partial<Record<BoardFilter, BoardColumn>> = {
  setupIncomplete: 'setup',
  accountMissing: 'account',
  openTickets: 'tickets',
};

export function visibleColumns(lens: BoardLens, capabilities: ReadinessCapabilities | null): BoardColumn[] {
  return BOARD_COLUMNS.filter((column) => {
    if (LENS_HIDES[lens] === column) return false;
    if (column === 'integrations') return INTEGRATIONS_COLUMN_ENABLED && capabilities?.integrations === true;
    if (column === 'tickets') return capabilities?.tickets === true;
    return true; // setup / account: policies + contacts are always-true capabilities
  });
}

/** A capability-trimmed section takes its filter with it; Archived is always discoverable. */
export function visibleFilters(capabilities: ReadinessCapabilities | null): BoardFilter[] {
  return BOARD_FILTERS.filter((filter) => (filter === 'openTickets' ? capabilities?.tickets === true : true));
}

export function lensForFilter(filter: BoardFilter, lens: BoardLens): BoardLens {
  const evidence = FILTER_EVIDENCE[filter];
  return evidence !== undefined && LENS_HIDES[lens] === evidence ? 'both' : lens;
}

export function matchesFilter(filter: BoardFilter, row: BoardRow): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'setupIncomplete':
      return (row.chips?.setup.length ?? 0) > 0;
    case 'accountMissing':
      return (row.chips?.account.length ?? 0) > 0;
    case 'openTickets':
      return (row.readiness?.tickets?.open ?? 0) > 0;
    case 'trial':
      return row.org.status === 'trial';
    case 'archived':
      return row.org.archived === true;
  }
}

export function compareRows(sort: BoardSort): ((a: BoardRow, b: BoardRow) => number) | null {
  if (sort === 'name') return (a, b) => a.org.name.localeCompare(b.org.name);
  if (sort === 'tickets') {
    return (a, b) =>
      (b.readiness?.tickets?.open ?? 0) - (a.readiness?.tickets?.open ?? 0) || a.org.name.localeCompare(b.org.name);
  }
  return null; // manual: the server's stored partner order, untouched
}

export function sortRows(rows: BoardRow[], sort: BoardSort): BoardRow[] {
  const compare = compareRows(sort);
  return compare ? [...rows].sort(compare) : rows;
}

/** Search over org name, primary contact name and email — client-side over the loaded list plus the readiness payload. */
export function searchMatches(query: string, org: Pick<Organization, 'name'>, readiness: ReadinessOrg | undefined): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (org.name.toLowerCase().includes(q)) return true;
  const primary = readiness?.account.primaryContact;
  if (!primary) return false;
  return (primary.name?.toLowerCase().includes(q) ?? false) || (primary.email?.toLowerCase().includes(q) ?? false);
}

/* ---------------------------------- Hash ---------------------------------- */

export interface BoardHashState {
  lens?: BoardLens;
  filter?: BoardFilter;
  /** A bare `#<uuid>`: scroll to and briefly highlight that row. */
  highlightOrgId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `lens=setup&filter=all` → state; a bare uuid → row highlight; anything else → undefined (useHashState's default). */
export function parseBoardHash(hash: string): BoardHashState | undefined {
  const raw = hash.replace(/^#/, '');
  if (!raw) return undefined;
  if (UUID_RE.test(raw)) return { highlightOrgId: raw.toLowerCase() };
  const params = new URLSearchParams(raw);
  const lens = params.get('lens');
  const filter = params.get('filter');
  const state: BoardHashState = {};
  if (lens && isBoardLens(lens)) state.lens = lens;
  if (filter && isBoardFilter(filter)) state.filter = filter;
  return Object.keys(state).length > 0 ? state : undefined;
}

/** Always both keys: the hash must win over the localStorage default for BOTH values once the user has chosen. */
export function serializeBoardHash(state: { lens: BoardLens; filter: BoardFilter }): string {
  return `lens=${state.lens}&filter=${state.filter}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run src/lib/orgReadiness.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/orgReadiness.ts apps/web/src/lib/orgReadiness.test.ts
git commit -m "feat(web): board lens/filter/sort/column config, search and hash serialisation for the account board (W02 #5723)"
```

---

### Task 3: Shared primitives — lift `SortableTh` (namespace prop) and extend `ActionMenu` (links, description, separators, trigger tabindex)

**Files:**
- Create: `apps/web/src/components/shared/SortableTh.tsx`
- Move: `apps/web/src/components/billing/shared/SortableTh.test.tsx` → `apps/web/src/components/shared/SortableTh.test.tsx` (`git mv`), then extend
- Modify: `apps/web/src/components/billing/shared/SortableTh.tsx` (becomes a re-export shim; callers `ContractsList.tsx:20`, `InvoicesPage.tsx`, `quotes/QuotesPage.tsx` keep importing from it)
- Modify: `apps/web/src/components/shared/ActionMenu.tsx`
- Test: `apps/web/src/components/shared/ActionMenu.test.tsx` (append)

**Interfaces:**
- Produces: `SortableTh<K>` with `namespace?: string` (default `'billing'`) reading `shared.sortableTh.{sortBy,sortByWithDirection,ascending,descending}` from that catalog via the `ns` option; `ActionMenuItem` gains `href?: string` (renders `<a role="menuitem">`), `description?: string`, `separatorBefore?: boolean`, and `onSelect` becomes optional; `ActionMenuProps` gains `triggerTabIndex?: number`.
- Consumes: `useMenuKeyboard` (`billing/shared/menuKeyboard.ts`) — unchanged; it walks `[role="menuitem"]`, so link items and separators need no keyboard code.

- [ ] **Step 1: Move the SortableTh test and add the namespace probe (failing)**

Run: `git mv apps/web/src/components/billing/shared/SortableTh.test.tsx apps/web/src/components/shared/SortableTh.test.tsx`

Edit the moved file: change `import { SortableTh } from './SortableTh';` (unchanged text, now resolving to the shared file once it exists), add `import { i18n } from '@/lib/i18n';` and append inside `describe('SortableTh', …)`:

```tsx
  it('reads its labels from the catalog named by `namespace`', () => {
    i18n.addResourceBundle('en', 'probe', {
      shared: { sortableTh: { sortBy: 'PROBE {{label}}', sortByWithDirection: 'PROBE {{label}} {{direction}}', ascending: 'up', descending: 'down' } },
    }, true, true);
    renderTh({ namespace: 'probe', activeSort: 'total', direction: 'asc' });
    expect(screen.getByTestId('sort-total')).toHaveAttribute('aria-label', 'PROBE Total up');
  });

  it('defaults to the billing catalog so existing callers are unchanged', () => {
    renderTh({ activeSort: 'total', direction: 'desc' });
    expect(screen.getByTestId('sort-total')).toHaveAttribute('aria-label', 'Sort by Total, Descending');
  });
```

- [ ] **Step 2: Append the ActionMenu tests (failing)**

```tsx
// apps/web/src/components/shared/ActionMenu.test.tsx — append inside the existing describe
  it('renders an item with `href` as a real link menuitem with a second line, and still closes on activation', () => {
    const onSelect = vi.fn();
    render(
      <ActionMenu
        label="Row actions"
        items={[
          { id: 'open', label: 'Open record', href: '/organizations/abc' },
          { id: 'contact', label: 'Contact Jane Doe', description: 'jane@alpha.test · +1 555', href: 'mailto:jane@alpha.test', onSelect },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Row actions' }));
    const link = screen.getByRole('menuitem', { name: /Contact Jane Doe/ });
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', 'mailto:jane@alpha.test');
    expect(link).toHaveTextContent('jane@alpha.test · +1 555');
    expect(screen.getByRole('menuitem', { name: 'Open record' })).toHaveAttribute('href', '/organizations/abc');
    fireEvent.click(link);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('draws a separator above items that ask for one, and the arrow keys skip it', () => {
    render(
      <ActionMenu
        label="Row actions"
        items={[
          { id: 'a', label: 'First', onSelect: () => undefined },
          { id: 'b', label: 'Second', onSelect: () => undefined, separatorBefore: true },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Row actions' }));
    expect(screen.getAllByRole('separator')).toHaveLength(1);
    const first = screen.getByRole('menuitem', { name: 'First' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Second' }));
  });

  it('puts the trigger on the tabindex the caller asks for (roving rows)', () => {
    render(<ActionMenu label="Row actions" triggerTabIndex={-1} items={[{ id: 'a', label: 'First', onSelect: () => undefined }]} />);
    expect(screen.getByRole('button', { name: 'Row actions' })).toHaveAttribute('tabindex', '-1');
  });
```

- [ ] **Step 3: Run both suites to verify they fail**

Run: `cd apps/web && npx vitest run src/components/shared/SortableTh.test.tsx src/components/shared/ActionMenu.test.tsx`
Expected: SortableTh — `Failed to resolve import "./SortableTh"`; ActionMenu — the link item renders as a `<button>` without an `href`, no separator, `triggerTabIndex` ignored.

- [ ] **Step 4: Write the shared SortableTh and the shim**

```tsx
// apps/web/src/components/shared/SortableTh.tsx
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

/**
 * Shared sortable table header. Lifted from `components/billing/shared` (W02 of
 * the account board) with one addition: `namespace` names the catalog that
 * holds `shared.sortableTh.*`, so non-billing surfaces do not have to reach
 * into the billing catalog for their accessible labels. Markup and classes are
 * byte-compatible with the billing original.
 *
 * `align="right"` reverses the icon/label order and right-aligns the cell (used
 * for numeric money columns); `align="left"` (default) is used for text/date
 * columns.
 */
export interface SortableThProps<K extends string> {
  label: string;
  sortKey: K;
  /** The currently active sort key, if any. */
  activeSort: K | null | undefined;
  /** Direction of the active sort — only consulted when this column is active. */
  direction: 'asc' | 'desc';
  onSort: (key: K) => void;
  align?: 'left' | 'right';
  testId?: string;
  /** Catalog holding `shared.sortableTh.{sortBy,sortByWithDirection,ascending,descending}`.
   *  Defaults to `billing`, the namespace this component was lifted from. */
  namespace?: string;
}

export function SortableTh<K extends string>({
  label,
  sortKey,
  activeSort,
  direction,
  onSort,
  align = 'left',
  testId,
  namespace = 'billing',
}: SortableThProps<K>) {
  // Bound to `billing` so the keyUsage contract resolves the literal keys; the
  // runtime `ns` option redirects the lookup to the caller's catalog.
  const { t } = useTranslation('billing');
  const ns = namespace;
  const active = activeSort === sortKey;
  const ariaLabel = active
    ? t('shared.sortableTh.sortByWithDirection', {
        ns,
        label,
        direction: direction === 'asc' ? t('shared.sortableTh.ascending', { ns }) : t('shared.sortableTh.descending', { ns }),
      })
    : t('shared.sortableTh.sortBy', { ns, label });
  const thClass = align === 'right' ? 'px-3 py-3 text-right font-medium' : 'px-3 py-3 font-medium';
  const buttonClass =
    align === 'right'
      ? 'inline-flex flex-row-reverse items-center gap-1 hover:text-foreground'
      : 'inline-flex items-center gap-1 hover:text-foreground';
  return (
    <th className={thClass} aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => onSort(sortKey)} className={buttonClass} data-testid={testId} aria-label={ariaLabel}>
        {label}
        {active ? (
          direction === 'asc' ? (
            <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          )
        ) : (
          <ChevronsUpDown className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </button>
    </th>
  );
}

export default SortableTh;
```

Replace the whole of `apps/web/src/components/billing/shared/SortableTh.tsx` with:

```ts
// Re-export shim: the component now lives in components/shared (account board
// W02). Billing callers keep this import path; new callers import from
// '@/components/shared/SortableTh' and pass `namespace`.
export { SortableTh, type SortableThProps } from '../../shared/SortableTh';
export { default } from '../../shared/SortableTh';
```

- [ ] **Step 5: Rewrite ActionMenu with the new item shapes**

```tsx
// apps/web/src/components/shared/ActionMenu.tsx
import { Fragment, useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { useMenuKeyboard } from '../billing/shared/menuKeyboard';

export interface ActionMenuItem {
  id: string;
  label: string;
  /** Second, muted line under the label (e.g. a contact's email and phone). */
  description?: string;
  /** Renders the item as a real link (`<a role="menuitem">`) so `mailto:`/`tel:`
   *  and record links stay middle-clickable. `onSelect` is optional then. */
  href?: string;
  /** Required unless `href` is set; still called (after focus returns to the
   *  trigger) when both are present. */
  onSelect?: () => void;
  /** `destructive` renders the item in the destructive colour: reserve it for
   *  actions that cannot be undone (merge), not for reversible ones (archive). */
  tone?: 'default' | 'destructive';
  /** Draws a divider above this item — grouping without a separate item type. */
  separatorBefore?: boolean;
  testId?: string;
}

export interface ActionMenuProps {
  /** Accessible name of the trigger, e.g. "More actions". */
  label: string;
  items: ActionMenuItem[];
  testId?: string;
  /** Classes on the trigger button. Defaults to the secondary-button look. */
  triggerClassName?: string;
  /** Tab index of the trigger; a roving-tabindex row passes -1 for every row but the active one. */
  triggerTabIndex?: number;
}

/**
 * Overflow menu for a header's or a row's rare actions, per the WAI-ARIA
 * menu-button pattern: trigger carries `aria-haspopup="menu"` + `aria-expanded`,
 * the popup is `role="menu"` of `role="menuitem"`s, the first item takes focus
 * on open, Arrow/Home/End move between items, Tab and an outside click close,
 * and Escape closes and returns focus to the trigger. Renders nothing when there
 * are no items, so callers can pass a permission-filtered list without
 * guarding the trigger themselves.
 */
export function ActionMenu({ label, items, testId, triggerClassName, triggerTabIndex }: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => setOpen(false), []);
  const { listRef, onKeyDown: onMenuKeyDown } = useMenuKeyboard(open, close);

  useEffect(() => {
    if (!open) return;
    const onDocumentMouseDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocumentMouseDown);
    return () => document.removeEventListener('mousedown', onDocumentMouseDown);
  }, [open]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    onMenuKeyDown(event);
  };

  if (items.length === 0) return null;

  const itemClass = (item: ActionMenuItem) =>
    `block w-full whitespace-nowrap px-3 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent ${
      item.tone === 'destructive' ? 'text-destructive' : ''
    }`;

  const activate = (item: ActionMenuItem) => {
    // Focus the trigger BEFORE the item unmounts and before the handler runs:
    // a dialog opened by `onSelect` captures `document.activeElement` on mount
    // as its restore target, and without this it captured <body> (the
    // menuitem was already gone in the same commit).
    triggerRef.current?.focus();
    setOpen(false);
    item.onSelect?.();
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        data-testid={testId}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        tabIndex={triggerTabIndex}
        onClick={() => setOpen((value) => !value)}
        className={
          triggerClassName ??
          'inline-flex h-9 items-center justify-center rounded-md border bg-background px-2.5 text-sm font-medium transition hover:bg-muted'
        }
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={listRef}
          role="menu"
          aria-label={label}
          onKeyDown={handleKeyDown}
          className="absolute right-0 z-20 mt-1 min-w-44 overflow-hidden rounded-md border bg-popover py-1 shadow-md"
        >
          {items.map((item) => {
            const body = (
              <>
                {item.label}
                {item.description && <span className="block text-xs text-muted-foreground">{item.description}</span>}
              </>
            );
            return (
              <Fragment key={item.id}>
                {item.separatorBefore && <div role="separator" className="my-1 border-t" />}
                {item.href ? (
                  <a role="menuitem" tabIndex={-1} href={item.href} data-testid={item.testId} onClick={() => activate(item)} className={itemClass(item)}>
                    {body}
                  </a>
                ) : (
                  <button type="button" role="menuitem" tabIndex={-1} data-testid={item.testId} onClick={() => activate(item)} className={itemClass(item)}>
                    {body}
                  </button>
                )}
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Run the suites and the billing callers' suites to verify they pass**

Run: `cd apps/web && npx vitest run src/components/shared/SortableTh.test.tsx src/components/shared/ActionMenu.test.tsx src/components/contracts src/components/billing/InvoicesPage src/components/billing/quotes/QuotesPage`
Expected: PASS. (The probe test registers its own `probe` bundle, so it does not depend on Task 4; the billing callers' suites prove the shim keeps their import path working.)

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json`
Expected: no errors (the `onSelect` optionality is backward-compatible; every existing caller passes it).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/shared/SortableTh.tsx apps/web/src/components/shared/SortableTh.test.tsx apps/web/src/components/billing/shared/SortableTh.tsx apps/web/src/components/shared/ActionMenu.tsx apps/web/src/components/shared/ActionMenu.test.tsx
git commit -m "refactor(web): lift SortableTh to shared with a namespace prop; ActionMenu link items, descriptions, separators, trigger tabindex (W02 #5723)"
```

---

### Task 4: i18n — `orgBoard.*` and `shared.sortableTh` in all eight locales, `titles.organizations`, coverage baselines

**Files:**
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/organizations.json` (add `orgBoard` and `shared` as siblings of `orgRecord`)
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/pages.json` (add `titles.organizations` next to `titles.organizationsDetail`)
- Modify: `apps/web/src/lib/i18n/translationCoverage.test.ts` (`organizations.json` baselines: `fr-FR` 8 → 10, `fr-CA` 7 → 9, `tr-TR` 1 → 2)

**Interfaces:**
- Produces: every key the components in Tasks 5–11 call. Key set (identical in all eight files): `orgBoard.{title,description,loading}`, `orgBoard.actions.{addOrganization,tryAgain,clearFilters,openRecord,contact,newTicket,workHere,settings,archive,merge,restore,restoring}`, `orgBoard.rowMenu.label`, `orgBoard.search.label`, `orgBoard.lens.{label,setup,account,both}`, `orgBoard.filters.{label,all,setupIncomplete,accountMissing,openTickets,trial,archived}`, `orgBoard.sort.{label,manual,name,tickets}`, `orgBoard.columns.{organization,setup,account,tickets,actions}`, `orgBoard.band.{label,all,allSub,setupIncomplete,accountMissing,openTickets,openTicketsSub,pending,partial}`, `orgBoard.chips.{noSite,noDevices,noCheckIn,staleCheckIn_one,staleCheckIn_other,noPolicy,primaryContact,contactEmail,contactPhone,billingContact,billingAddress,overdueInvoices_one,overdueInvoices_other,invitation_one,invitation_other,complete,notApplicable,unavailable,stillNeeded,link}`, `orgBoard.repair.{sites,devices,policies,contacts,settings,billing}`, `orgBoard.tickets.{open,awaiting,sla}`, `orgBoard.meta.{workspace,devices_one,devices_other,sites_one,sites_other,archivedBadge,archivingBadge,keptIndefinitely,purgeToday,purgeCountdown_one,purgeCountdown_other}`, `orgBoard.reorder.{handle,hint,dragToReorder,moved}`, `orgBoard.footer.{summary,summaryWithTickets,manualHint}`, `orgBoard.empty.{title,description,noMatches}`, `orgBoard.archived.{loading,empty,noMatches,truncatedNote,fetchError}`, `orgBoard.restore.{success,recreateRequiredNote,suspendedNote}`, `orgBoard.restore.errors.{restore,mfaRequired,purging}`, `orgBoard.add.{title,description,submit,created}`, `orgBoard.errors.{fetchOrganizations,generic,saveOrder,saveOrganization,readiness}`, `shared.sortableTh.{ascending,descending,sortBy,sortByWithDirection}`, `pages:titles.organizations`.

- [ ] **Step 1: Run the parity contract to see the current baseline is green (control)**

Run: `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts`
Expected: PASS (this is the control; the next steps must keep it green).

- [ ] **Step 2: Add the English block**

Insert into `apps/web/src/locales/en/organizations.json` as top-level siblings after `orgRecord` (keep `orgRecord` untouched):

```json
  "orgBoard": {
    "title": "Organizations",
    "description": "Every customer, what it still needs, and what is open.",
    "loading": "Loading organizations…",
    "actions": {
      "addOrganization": "Add organization",
      "tryAgain": "Try again",
      "clearFilters": "Clear filters",
      "openRecord": "Open record",
      "contact": "Contact {{name}}",
      "newTicket": "New ticket",
      "workHere": "Work in this org",
      "settings": "Settings",
      "archive": "Archive organization",
      "merge": "Merge into another organization",
      "restore": "Restore",
      "restoring": "Restoring…"
    },
    "rowMenu": { "label": "Actions for {{name}}" },
    "search": { "label": "Search organizations, contacts and emails" },
    "lens": { "label": "Lens", "setup": "Setup", "account": "Account", "both": "Both" },
    "filters": {
      "label": "Filter",
      "all": "All",
      "setupIncomplete": "Setup incomplete",
      "accountMissing": "Account data missing",
      "openTickets": "Open tickets",
      "trial": "Trial",
      "archived": "Archived"
    },
    "sort": { "label": "Sort", "manual": "Manual order", "name": "A to Z", "tickets": "Open tickets" },
    "columns": { "organization": "Organization", "setup": "Setup", "account": "Account data", "tickets": "Open tickets", "actions": "Row actions" },
    "band": {
      "label": "Account readiness",
      "all": "Accounts",
      "allSub": "{{trial}} trial · {{suspended}} suspended",
      "setupIncomplete": "Setup incomplete",
      "accountMissing": "Account data missing",
      "openTickets": "Open tickets",
      "openTicketsSub": "{{count}} SLA breached",
      "pending": "Checking organizations…",
      "partial": "Some organizations could not be checked."
    },
    "chips": {
      "noSite": "No site",
      "noDevices": "No devices enrolled",
      "noCheckIn": "No agent has checked in",
      "staleCheckIn_one": "No agent check-in for {{count}} day",
      "staleCheckIn_other": "No agent check-in for {{count}} days",
      "noPolicy": "No policy assigned",
      "primaryContact": "Primary contact",
      "contactEmail": "Contact email",
      "contactPhone": "Contact phone",
      "billingContact": "Billing contact",
      "billingAddress": "Billing address",
      "overdueInvoices_one": "{{count}} overdue invoice",
      "overdueInvoices_other": "{{count}} overdue invoices",
      "invitation_one": "{{count}} invitation not accepted",
      "invitation_other": "{{count}} invitations not accepted",
      "complete": "Complete",
      "notApplicable": "Not applicable",
      "unavailable": "Unavailable",
      "stillNeeded": "Still needed",
      "link": "{{chip}} for {{orgName}}"
    },
    "repair": {
      "sites": "Open the Sites tab for {{orgName}}",
      "devices": "Open the Devices tab for {{orgName}}",
      "policies": "Open configuration policies",
      "contacts": "Open the Contacts tab for {{orgName}}",
      "settings": "Open settings for {{orgName}}",
      "billing": "Open the Billing tab for {{orgName}}"
    },
    "tickets": { "open": "{{count}} open", "awaiting": "{{count}} awaiting customer", "sla": "{{count}} SLA breached" },
    "meta": {
      "workspace": "Workspace",
      "devices_one": "{{count}} device",
      "devices_other": "{{count}} devices",
      "sites_one": "{{count}} site",
      "sites_other": "{{count}} sites",
      "archivedBadge": "Archived",
      "archivingBadge": "Archiving…",
      "keptIndefinitely": "Kept indefinitely",
      "purgeToday": "Purges today",
      "purgeCountdown_one": "Purges in {{count}} day",
      "purgeCountdown_other": "Purges in {{count}} days"
    },
    "reorder": {
      "handle": "Reorder {{name}}",
      "hint": "Use the up and down arrow keys to move this organization.",
      "dragToReorder": "Drag to reorder",
      "moved": "{{name}} moved to position {{position}} of {{total}}"
    },
    "footer": {
      "summary": "{{accounts}} active accounts · {{devices}} devices",
      "summaryWithTickets": "{{accounts}} active accounts · {{devices}} devices · {{tickets}} open tickets",
      "manualHint": "Manual order: drag a row or use the arrow keys on its handle."
    },
    "empty": {
      "title": "No organizations yet",
      "description": "Add your first customer to start tracking setup and account data.",
      "noMatches": "No organizations match your search or filter."
    },
    "archived": {
      "loading": "Loading archived organizations…",
      "empty": "No archived organizations.",
      "noMatches": "No archived organizations match your search.",
      "truncatedNote": "Showing the first {{count}} archived organizations. Search to narrow the list.",
      "fetchError": "Failed to load archived organizations"
    },
    "restore": {
      "success": "{{name}} restored — status: {{status}}.",
      "recreateRequiredNote": "Before it's fully usable again: {{items}}",
      "suspendedNote": "It was suspended before being archived, so it has been restored as suspended — resolve that before it resumes normal access.",
      "errors": {
        "restore": "Failed to restore the organization",
        "mfaRequired": "Restoring organizations requires multi-factor authentication. Enable MFA in your profile security settings, then try again.",
        "purging": "This organization is already being permanently deleted and can no longer be restored."
      }
    },
    "add": {
      "title": "Add organization",
      "description": "Create a new organization with the details below.",
      "submit": "Create organization",
      "created": "{{name}} added. Its row shows what to set up next."
    },
    "errors": {
      "fetchOrganizations": "Failed to fetch organizations",
      "generic": "An error occurred",
      "saveOrder": "Failed to save organization order",
      "saveOrganization": "Failed to save organization",
      "readiness": "Could not check account readiness for some organizations."
    }
  },
  "shared": {
    "sortableTh": {
      "ascending": "Ascending",
      "descending": "Descending",
      "sortBy": "Sort by {{label}}",
      "sortByWithDirection": "Sort by {{label}}, {{direction}}"
    }
  }
```

And in `apps/web/src/locales/en/pages.json`, next to `"organizationsDetail": "Organization"` add `"organizations": "Organizations"`.

- [ ] **Step 3: Add de-DE**

`apps/web/src/locales/de-DE/organizations.json` (same position); `pages.json` gets `"organizations": "Organisationen"`.

```json
  "orgBoard": {
    "title": "Organisationen",
    "description": "Jeder Kunde, was ihm noch fehlt und was offen ist.",
    "loading": "Organisationen werden geladen…",
    "actions": {
      "addOrganization": "Organisation hinzufügen",
      "tryAgain": "Erneut versuchen",
      "clearFilters": "Filter zurücksetzen",
      "openRecord": "Datensatz öffnen",
      "contact": "{{name}} kontaktieren",
      "newTicket": "Neues Ticket",
      "workHere": "In dieser Organisation arbeiten",
      "settings": "Einstellungen",
      "archive": "Organisation archivieren",
      "merge": "In eine andere Organisation zusammenführen",
      "restore": "Wiederherstellen",
      "restoring": "Wird wiederhergestellt…"
    },
    "rowMenu": { "label": "Aktionen für {{name}}" },
    "search": { "label": "Organisationen, Kontakte und E-Mail-Adressen durchsuchen" },
    "lens": { "label": "Ansicht", "setup": "Einrichtung", "account": "Konto", "both": "Beide" },
    "filters": {
      "label": "Filtern",
      "all": "Alle",
      "setupIncomplete": "Einrichtung unvollständig",
      "accountMissing": "Kontodaten fehlen",
      "openTickets": "Offene Tickets",
      "trial": "Testphase",
      "archived": "Archiviert"
    },
    "sort": { "label": "Sortieren", "manual": "Manuelle Reihenfolge", "name": "A bis Z", "tickets": "Offene Tickets" },
    "columns": { "organization": "Organisation", "setup": "Einrichtung", "account": "Kontodaten", "tickets": "Offene Tickets", "actions": "Zeilenaktionen" },
    "band": {
      "label": "Kontobereitschaft",
      "all": "Konten",
      "allSub": "{{trial}} in Testphase · {{suspended}} gesperrt",
      "setupIncomplete": "Einrichtung unvollständig",
      "accountMissing": "Kontodaten fehlen",
      "openTickets": "Offene Tickets",
      "openTicketsSub": "{{count}} SLA verletzt",
      "pending": "Organisationen werden geprüft…",
      "partial": "Einige Organisationen konnten nicht geprüft werden."
    },
    "chips": {
      "noSite": "Kein Standort",
      "noDevices": "Keine Geräte registriert",
      "noCheckIn": "Kein Agent hat sich gemeldet",
      "staleCheckIn_one": "Seit {{count}} Tag keine Agent-Meldung",
      "staleCheckIn_other": "Seit {{count}} Tagen keine Agent-Meldung",
      "noPolicy": "Keine Richtlinie zugewiesen",
      "primaryContact": "Hauptansprechpartner",
      "contactEmail": "Kontakt-E-Mail",
      "contactPhone": "Kontakttelefon",
      "billingContact": "Rechnungskontakt",
      "billingAddress": "Rechnungsadresse",
      "overdueInvoices_one": "{{count}} überfällige Rechnung",
      "overdueInvoices_other": "{{count}} überfällige Rechnungen",
      "invitation_one": "{{count}} Einladung nicht angenommen",
      "invitation_other": "{{count}} Einladungen nicht angenommen",
      "complete": "Vollständig",
      "notApplicable": "Nicht zutreffend",
      "unavailable": "Nicht verfügbar",
      "stillNeeded": "Noch offen",
      "link": "{{chip}} für {{orgName}}"
    },
    "repair": {
      "sites": "Registerkarte „Standorte“ für {{orgName}} öffnen",
      "devices": "Registerkarte „Geräte“ für {{orgName}} öffnen",
      "policies": "Konfigurationsrichtlinien öffnen",
      "contacts": "Registerkarte „Kontakte“ für {{orgName}} öffnen",
      "settings": "Einstellungen für {{orgName}} öffnen",
      "billing": "Registerkarte „Abrechnung“ für {{orgName}} öffnen"
    },
    "tickets": { "open": "{{count}} offen", "awaiting": "{{count}} warten auf Kunde", "sla": "{{count}} SLA verletzt" },
    "meta": {
      "workspace": "Arbeitsbereich",
      "devices_one": "{{count}} Gerät",
      "devices_other": "{{count}} Geräte",
      "sites_one": "{{count}} Standort",
      "sites_other": "{{count}} Standorte",
      "archivedBadge": "Archiviert",
      "archivingBadge": "Wird archiviert…",
      "keptIndefinitely": "Wird unbegrenzt aufbewahrt",
      "purgeToday": "Wird heute endgültig gelöscht",
      "purgeCountdown_one": "Wird in {{count}} Tag endgültig gelöscht",
      "purgeCountdown_other": "Wird in {{count}} Tagen endgültig gelöscht"
    },
    "reorder": {
      "handle": "{{name}} neu anordnen",
      "hint": "Verschieben Sie diese Organisation mit den Pfeiltasten nach oben und unten.",
      "dragToReorder": "Zum Neuanordnen ziehen",
      "moved": "{{name}} wurde an Position {{position}} von {{total}} verschoben"
    },
    "footer": {
      "summary": "{{accounts}} aktive Konten · {{devices}} Geräte",
      "summaryWithTickets": "{{accounts}} aktive Konten · {{devices}} Geräte · {{tickets}} offene Tickets",
      "manualHint": "Manuelle Reihenfolge: Zeile ziehen oder die Pfeiltasten auf dem Griff verwenden."
    },
    "empty": {
      "title": "Noch keine Organisationen",
      "description": "Fügen Sie Ihren ersten Kunden hinzu, um Einrichtung und Kontodaten im Blick zu behalten.",
      "noMatches": "Keine Organisationen entsprechen Ihrer Suche oder Ihrem Filter."
    },
    "archived": {
      "loading": "Archivierte Organisationen werden geladen…",
      "empty": "Keine archivierten Organisationen.",
      "noMatches": "Keine archivierten Organisationen entsprechen Ihrer Suche.",
      "truncatedNote": "Zeigt die ersten {{count}} archivierten Organisationen. Suchen Sie, um die Liste einzugrenzen.",
      "fetchError": "Archivierte Organisationen konnten nicht geladen werden"
    },
    "restore": {
      "success": "{{name}} wiederhergestellt — Status: {{status}}.",
      "recreateRequiredNote": "Bevor sie wieder vollständig nutzbar ist: {{items}}",
      "suspendedNote": "Sie war vor der Archivierung gesperrt, daher wurde sie als gesperrt wiederhergestellt — beheben Sie dies, bevor sie den normalen Zugriff wieder aufnimmt.",
      "errors": {
        "restore": "Die Organisation konnte nicht wiederhergestellt werden",
        "mfaRequired": "Das Wiederherstellen von Organisationen erfordert Multi-Faktor-Authentifizierung. Aktivieren Sie MFA in Ihren Profil-Sicherheitseinstellungen und versuchen Sie es erneut.",
        "purging": "Diese Organisation wird bereits endgültig gelöscht und kann nicht mehr wiederhergestellt werden."
      }
    },
    "add": {
      "title": "Organisation hinzufügen",
      "description": "Erstellen Sie eine neue Organisation mit den unten aufgeführten Details.",
      "submit": "Organisation erstellen",
      "created": "{{name}} hinzugefügt. Die Zeile zeigt, was als Nächstes einzurichten ist."
    },
    "errors": {
      "fetchOrganizations": "Organisationen konnten nicht abgerufen werden",
      "generic": "Es ist ein Fehler aufgetreten",
      "saveOrder": "Organisationsreihenfolge konnte nicht gespeichert werden",
      "saveOrganization": "Die Organisation konnte nicht gespeichert werden",
      "readiness": "Die Kontobereitschaft einiger Organisationen konnte nicht geprüft werden."
    }
  },
  "shared": {
    "sortableTh": {
      "ascending": "Aufsteigend",
      "descending": "Absteigend",
      "sortBy": "Sortieren nach {{label}}",
      "sortByWithDirection": "Sortieren nach {{label}}, {{direction}}"
    }
  }
```

- [ ] **Step 4: Add es-419**

`pages.json`: `"organizations": "Organizaciones"`.

```json
  "orgBoard": {
    "title": "Organizaciones",
    "description": "Cada cliente, lo que aún le falta y lo que está abierto.",
    "loading": "Cargando organizaciones…",
    "actions": {
      "addOrganization": "Agregar organización",
      "tryAgain": "Intentar otra vez",
      "clearFilters": "Limpiar filtros",
      "openRecord": "Abrir registro",
      "contact": "Contactar a {{name}}",
      "newTicket": "Nuevo ticket",
      "workHere": "Trabajar en esta organización",
      "settings": "Configuración",
      "archive": "Archivar organización",
      "merge": "Fusionar con otra organización",
      "restore": "Restaurar",
      "restoring": "Restaurando…"
    },
    "rowMenu": { "label": "Acciones para {{name}}" },
    "search": { "label": "Buscar organizaciones, contactos y correos" },
    "lens": { "label": "Vista", "setup": "Configuración", "account": "Cuenta", "both": "Ambas" },
    "filters": {
      "label": "Filtrar",
      "all": "Todas",
      "setupIncomplete": "Configuración incompleta",
      "accountMissing": "Faltan datos de la cuenta",
      "openTickets": "Tickets abiertos",
      "trial": "Prueba",
      "archived": "Archivadas"
    },
    "sort": { "label": "Ordenar", "manual": "Orden manual", "name": "De la A a la Z", "tickets": "Tickets abiertos" },
    "columns": { "organization": "Organización", "setup": "Configuración", "account": "Datos de la cuenta", "tickets": "Tickets abiertos", "actions": "Acciones de fila" },
    "band": {
      "label": "Preparación de cuentas",
      "all": "Cuentas",
      "allSub": "{{trial}} en prueba · {{suspended}} suspendidas",
      "setupIncomplete": "Configuración incompleta",
      "accountMissing": "Faltan datos de la cuenta",
      "openTickets": "Tickets abiertos",
      "openTicketsSub": "{{count}} SLA incumplidos",
      "pending": "Verificando organizaciones…",
      "partial": "No se pudieron verificar algunas organizaciones."
    },
    "chips": {
      "noSite": "Sin sitio",
      "noDevices": "Sin dispositivos inscritos",
      "noCheckIn": "Ningún agente se ha reportado",
      "staleCheckIn_one": "Sin reporte de agentes desde hace {{count}} día",
      "staleCheckIn_other": "Sin reporte de agentes desde hace {{count}} días",
      "noPolicy": "Sin política asignada",
      "primaryContact": "Contacto principal",
      "contactEmail": "Correo del contacto",
      "contactPhone": "Teléfono del contacto",
      "billingContact": "Contacto de facturación",
      "billingAddress": "Dirección de facturación",
      "overdueInvoices_one": "{{count}} factura vencida",
      "overdueInvoices_other": "{{count}} facturas vencidas",
      "invitation_one": "{{count}} invitación sin aceptar",
      "invitation_other": "{{count}} invitaciones sin aceptar",
      "complete": "Completo",
      "notApplicable": "No aplica",
      "unavailable": "No disponible",
      "stillNeeded": "Pendiente",
      "link": "{{chip}} de {{orgName}}"
    },
    "repair": {
      "sites": "Abrir la pestaña Sitios de {{orgName}}",
      "devices": "Abrir la pestaña Dispositivos de {{orgName}}",
      "policies": "Abrir las políticas de configuración",
      "contacts": "Abrir la pestaña Contactos de {{orgName}}",
      "settings": "Abrir la configuración de {{orgName}}",
      "billing": "Abrir la pestaña Facturación de {{orgName}}"
    },
    "tickets": { "open": "{{count}} abiertos", "awaiting": "{{count}} en espera del cliente", "sla": "{{count}} SLA incumplidos" },
    "meta": {
      "workspace": "Espacio de trabajo",
      "devices_one": "{{count}} dispositivo",
      "devices_other": "{{count}} dispositivos",
      "sites_one": "{{count}} sitio",
      "sites_other": "{{count}} sitios",
      "archivedBadge": "Archivada",
      "archivingBadge": "Archivando…",
      "keptIndefinitely": "Se conserva indefinidamente",
      "purgeToday": "Se elimina hoy",
      "purgeCountdown_one": "Se elimina en {{count}} día",
      "purgeCountdown_other": "Se elimina en {{count}} días"
    },
    "reorder": {
      "handle": "Reordenar {{name}}",
      "hint": "Usa las flechas arriba y abajo para mover esta organización.",
      "dragToReorder": "Arrastre para reordenar",
      "moved": "{{name}} se movió a la posición {{position}} de {{total}}"
    },
    "footer": {
      "summary": "{{accounts}} cuentas activas · {{devices}} dispositivos",
      "summaryWithTickets": "{{accounts}} cuentas activas · {{devices}} dispositivos · {{tickets}} tickets abiertos",
      "manualHint": "Orden manual: arrastre una fila o use las flechas sobre su control."
    },
    "empty": {
      "title": "Aún no hay organizaciones",
      "description": "Agregue su primer cliente para empezar a seguir la configuración y los datos de la cuenta.",
      "noMatches": "Ninguna organización coincide con tu búsqueda o filtro."
    },
    "archived": {
      "loading": "Cargando organizaciones archivadas…",
      "empty": "No hay organizaciones archivadas.",
      "noMatches": "Ninguna organización archivada coincide con su búsqueda.",
      "truncatedNote": "Mostrando las primeras {{count}} organizaciones archivadas. Busque para acotar la lista.",
      "fetchError": "No se pudieron cargar las organizaciones archivadas"
    },
    "restore": {
      "success": "{{name}} restaurada — estado: {{status}}.",
      "recreateRequiredNote": "Antes de que esté completamente utilizable de nuevo: {{items}}",
      "suspendedNote": "Estaba suspendida antes de archivarse, así que se restauró como suspendida — resuelva eso antes de que la organización reanude el acceso normal.",
      "errors": {
        "restore": "No se pudo restaurar la organización",
        "mfaRequired": "Restaurar organizaciones requiere autenticación multifactor. Active la MFA en la configuración de seguridad de su perfil y vuelva a intentarlo.",
        "purging": "Esta organización ya se está eliminando permanentemente y no se puede restaurar."
      }
    },
    "add": {
      "title": "Agregar organización",
      "description": "Cree una nueva organización con los detalles a continuación.",
      "submit": "Crear organización",
      "created": "{{name}} agregada. Su fila muestra qué configurar a continuación."
    },
    "errors": {
      "fetchOrganizations": "No se han podido recuperar las organizaciones",
      "generic": "Se produjo un error",
      "saveOrder": "No se pudo guardar el orden de la organización",
      "saveOrganization": "No se pudo guardar la organización",
      "readiness": "No se pudo verificar la preparación de algunas organizaciones."
    }
  },
  "shared": {
    "sortableTh": {
      "ascending": "Ascendente",
      "descending": "Descendente",
      "sortBy": "Ordenar por {{label}}",
      "sortByWithDirection": "Ordenar por {{label}}, {{direction}}"
    }
  }
```

- [ ] **Step 5: Add fr-FR**

`pages.json`: `"organizations": "Organisations"`.

```json
  "orgBoard": {
    "title": "Organisations",
    "description": "Chaque client, ce qu'il lui manque encore et ce qui est en cours.",
    "loading": "Chargement des organisations…",
    "actions": {
      "addOrganization": "Ajouter l’organisation",
      "tryAgain": "Réessayer",
      "clearFilters": "Effacer les filtres",
      "openRecord": "Ouvrir la fiche",
      "contact": "Contacter {{name}}",
      "newTicket": "Nouveau ticket",
      "workHere": "Travailler dans cette organisation",
      "settings": "Paramètres",
      "archive": "Archiver l'organisation",
      "merge": "Fusionner avec une autre organisation",
      "restore": "Restaurer",
      "restoring": "Restauration…"
    },
    "rowMenu": { "label": "Actions pour {{name}}" },
    "search": { "label": "Rechercher des organisations, des contacts et des e-mails" },
    "lens": { "label": "Vue", "setup": "Configuration", "account": "Compte", "both": "Les deux" },
    "filters": {
      "label": "Filtrer",
      "all": "Toutes",
      "setupIncomplete": "Configuration incomplète",
      "accountMissing": "Données du compte manquantes",
      "openTickets": "Tickets ouverts",
      "trial": "Essai",
      "archived": "Archivées"
    },
    "sort": { "label": "Trier", "manual": "Ordre manuel", "name": "De A à Z", "tickets": "Tickets ouverts" },
    "columns": { "organization": "Organisation", "setup": "Configuration", "account": "Données du compte", "tickets": "Tickets ouverts", "actions": "Actions sur la ligne" },
    "band": {
      "label": "Préparation des comptes",
      "all": "Comptes",
      "allSub": "{{trial}} en essai · {{suspended}} suspendues",
      "setupIncomplete": "Configuration incomplète",
      "accountMissing": "Données du compte manquantes",
      "openTickets": "Tickets ouverts",
      "openTicketsSub": "{{count}} SLA dépassés",
      "pending": "Vérification des organisations…",
      "partial": "Certaines organisations n'ont pas pu être vérifiées."
    },
    "chips": {
      "noSite": "Aucun site",
      "noDevices": "Aucun appareil inscrit",
      "noCheckIn": "Aucun agent ne s'est signalé",
      "staleCheckIn_one": "Aucun agent signalé depuis {{count}} jour",
      "staleCheckIn_other": "Aucun agent signalé depuis {{count}} jours",
      "noPolicy": "Aucune politique attribuée",
      "primaryContact": "Contact principal",
      "contactEmail": "E-mail du contact",
      "contactPhone": "Téléphone du contact",
      "billingContact": "Contact de facturation",
      "billingAddress": "Adresse de facturation",
      "overdueInvoices_one": "{{count}} facture en retard",
      "overdueInvoices_other": "{{count}} factures en retard",
      "invitation_one": "{{count}} invitation non acceptée",
      "invitation_other": "{{count}} invitations non acceptées",
      "complete": "Complet",
      "notApplicable": "Sans objet",
      "unavailable": "Indisponible",
      "stillNeeded": "Reste à faire",
      "link": "{{chip}} pour {{orgName}}"
    },
    "repair": {
      "sites": "Ouvrir l'onglet Sites de {{orgName}}",
      "devices": "Ouvrir l'onglet Appareils de {{orgName}}",
      "policies": "Ouvrir les politiques de configuration",
      "contacts": "Ouvrir l'onglet Contacts de {{orgName}}",
      "settings": "Ouvrir les paramètres de {{orgName}}",
      "billing": "Ouvrir l'onglet Facturation de {{orgName}}"
    },
    "tickets": { "open": "{{count}} ouverts", "awaiting": "{{count}} en attente du client", "sla": "{{count}} SLA dépassés" },
    "meta": {
      "workspace": "Espace de travail",
      "devices_one": "{{count}} appareil",
      "devices_other": "{{count}} appareils",
      "sites_one": "{{count}} site",
      "sites_other": "{{count}} sites",
      "archivedBadge": "Archivée",
      "archivingBadge": "Archivage en cours…",
      "keptIndefinitely": "Conservée indéfiniment",
      "purgeToday": "Suppression définitive aujourd'hui",
      "purgeCountdown_one": "Suppression définitive dans {{count}} jour",
      "purgeCountdown_other": "Suppression définitive dans {{count}} jours"
    },
    "reorder": {
      "handle": "Réorganiser {{name}}",
      "hint": "Utilisez les flèches haut et bas pour déplacer cette organisation.",
      "dragToReorder": "Glisser pour réorganiser",
      "moved": "{{name}} déplacée en position {{position}} sur {{total}}"
    },
    "footer": {
      "summary": "{{accounts}} comptes actifs · {{devices}} appareils",
      "summaryWithTickets": "{{accounts}} comptes actifs · {{devices}} appareils · {{tickets}} tickets ouverts",
      "manualHint": "Ordre manuel : faites glisser une ligne ou utilisez les flèches sur sa poignée."
    },
    "empty": {
      "title": "Aucune organisation pour l'instant",
      "description": "Ajoutez votre premier client pour commencer à suivre la configuration et les données du compte.",
      "noMatches": "Aucune organisation ne correspond à votre recherche ou à votre filtre."
    },
    "archived": {
      "loading": "Chargement des organisations archivées…",
      "empty": "Aucune organisation archivée.",
      "noMatches": "Aucune organisation archivée ne correspond à votre recherche.",
      "truncatedNote": "Affichage des {{count}} premières organisations archivées. Effectuez une recherche pour affiner la liste.",
      "fetchError": "Échec du chargement des organisations archivées"
    },
    "restore": {
      "success": "{{name}} restaurée — statut : {{status}}.",
      "recreateRequiredNote": "Avant qu'elle soit à nouveau pleinement utilisable : {{items}}",
      "suspendedNote": "Elle était suspendue avant son archivage ; elle a donc été restaurée à l'état suspendu — réglez ce point avant qu'elle ne reprenne un accès normal.",
      "errors": {
        "restore": "Échec de la restauration de l'organisation",
        "mfaRequired": "La restauration des organisations nécessite l'authentification multifacteur. Activez la MFA dans les paramètres de sécurité de votre profil, puis réessayez.",
        "purging": "Cette organisation est déjà en cours de suppression définitive et ne peut plus être restaurée."
      }
    },
    "add": {
      "title": "Ajouter l’organisation",
      "description": "Créez une nouvelle organisation avec les détails ci-dessous.",
      "submit": "Créer une organisation",
      "created": "{{name}} ajoutée. Sa ligne indique ce qu'il reste à configurer."
    },
    "errors": {
      "fetchOrganizations": "Impossible de récupérer des organisations",
      "generic": "Une erreur s’est produite",
      "saveOrder": "Impossible d’enregistrer l’ordre organisationnel",
      "saveOrganization": "Impossible d’enregistrer l’organisation",
      "readiness": "Impossible de vérifier la préparation de certaines organisations."
    }
  },
  "shared": {
    "sortableTh": {
      "ascending": "Croissant",
      "descending": "Décroissant",
      "sortBy": "Trier par {{label}}",
      "sortByWithDirection": "Trier par {{label}}, {{direction}}"
    }
  }
```

- [ ] **Step 6: Add fr-CA**

`pages.json`: `"organizations": "Organisations"`. Same as fr-FR **except** these keys (Canadian French vocabulary): `actions.newTicket: "Nouveau billet"`, `search.label: "Rechercher des organisations, des contacts et des courriels"`, `chips.contactEmail: "Courriel du contact"`, `filters.openTickets`, `sort.tickets`, `columns.tickets`, `band.openTickets`: `"Billets ouverts"`, `tickets.open: "{{count}} ouverts"` (unchanged), `footer.summaryWithTickets: "{{accounts}} comptes actifs · {{devices}} appareils · {{tickets}} billets ouverts"`. Copy the fr-FR block, then apply exactly those substitutions (eight keys: `actions.newTicket`, `search.label`, `chips.contactEmail`, `filters.openTickets`, `sort.tickets`, `columns.tickets`, `band.openTickets`, `footer.summaryWithTickets`).

- [ ] **Step 7: Add it-IT**

`pages.json`: `"organizations": "Organizzazioni"`.

```json
  "orgBoard": {
    "title": "Organizzazioni",
    "description": "Ogni cliente, cosa gli manca ancora e cosa è aperto.",
    "loading": "Caricamento organizzazioni…",
    "actions": {
      "addOrganization": "Aggiungi organizzazione",
      "tryAgain": "Riprova",
      "clearFilters": "Cancella filtri",
      "openRecord": "Apri scheda",
      "contact": "Contatta {{name}}",
      "newTicket": "Nuovo ticket",
      "workHere": "Lavora in questa organizzazione",
      "settings": "Impostazioni",
      "archive": "Archivia organizzazione",
      "merge": "Unisci a un'altra organizzazione",
      "restore": "Ripristina",
      "restoring": "Ripristino in corso…"
    },
    "rowMenu": { "label": "Azioni per {{name}}" },
    "search": { "label": "Cerca organizzazioni, contatti ed e-mail" },
    "lens": { "label": "Vista", "setup": "Configurazione", "account": "Anagrafica", "both": "Entrambe" },
    "filters": {
      "label": "Filtra",
      "all": "Tutte",
      "setupIncomplete": "Configurazione incompleta",
      "accountMissing": "Dati anagrafici mancanti",
      "openTickets": "Ticket aperti",
      "trial": "Prova",
      "archived": "Archiviate"
    },
    "sort": { "label": "Ordina", "manual": "Ordine manuale", "name": "Dalla A alla Z", "tickets": "Ticket aperti" },
    "columns": { "organization": "Organizzazione", "setup": "Configurazione", "account": "Dati anagrafici", "tickets": "Ticket aperti", "actions": "Azioni della riga" },
    "band": {
      "label": "Completezza anagrafiche",
      "all": "Anagrafiche",
      "allSub": "{{trial}} in prova · {{suspended}} sospese",
      "setupIncomplete": "Configurazione incompleta",
      "accountMissing": "Dati anagrafici mancanti",
      "openTickets": "Ticket aperti",
      "openTicketsSub": "{{count}} SLA violati",
      "pending": "Verifica delle organizzazioni…",
      "partial": "Non è stato possibile verificare alcune organizzazioni."
    },
    "chips": {
      "noSite": "Nessun sito",
      "noDevices": "Nessun dispositivo registrato",
      "noCheckIn": "Nessun agente si è collegato",
      "staleCheckIn_one": "Nessun agente collegato da {{count}} giorno",
      "staleCheckIn_other": "Nessun agente collegato da {{count}} giorni",
      "noPolicy": "Nessun criterio assegnato",
      "primaryContact": "Contatto principale",
      "contactEmail": "E-mail del contatto",
      "contactPhone": "Telefono del contatto",
      "billingContact": "Contatto di fatturazione",
      "billingAddress": "Indirizzo di fatturazione",
      "overdueInvoices_one": "{{count}} fattura scaduta",
      "overdueInvoices_other": "{{count}} fatture scadute",
      "invitation_one": "{{count}} invito non accettato",
      "invitation_other": "{{count}} inviti non accettati",
      "complete": "Completo",
      "notApplicable": "Non applicabile",
      "unavailable": "Non disponibile",
      "stillNeeded": "Ancora da fare",
      "link": "{{chip}} per {{orgName}}"
    },
    "repair": {
      "sites": "Apri la scheda Siti di {{orgName}}",
      "devices": "Apri la scheda Dispositivi di {{orgName}}",
      "policies": "Apri i criteri di configurazione",
      "contacts": "Apri la scheda Contatti di {{orgName}}",
      "settings": "Apri le impostazioni di {{orgName}}",
      "billing": "Apri la scheda Fatturazione di {{orgName}}"
    },
    "tickets": { "open": "{{count}} aperti", "awaiting": "{{count}} in attesa del cliente", "sla": "{{count}} SLA violati" },
    "meta": {
      "workspace": "Spazio di lavoro",
      "devices_one": "{{count}} dispositivo",
      "devices_other": "{{count}} dispositivi",
      "sites_one": "{{count}} sito",
      "sites_other": "{{count}} siti",
      "archivedBadge": "Archiviata",
      "archivingBadge": "Archiviazione in corso…",
      "keptIndefinitely": "Conservata indefinitamente",
      "purgeToday": "Eliminata definitivamente oggi",
      "purgeCountdown_one": "Eliminata definitivamente tra {{count}} giorno",
      "purgeCountdown_other": "Eliminata definitivamente tra {{count}} giorni"
    },
    "reorder": {
      "handle": "Riordina {{name}}",
      "hint": "Usa le frecce su e giù per spostare questa organizzazione.",
      "dragToReorder": "Trascina per riordinare",
      "moved": "{{name}} spostata alla posizione {{position}} di {{total}}"
    },
    "footer": {
      "summary": "{{accounts}} anagrafiche attive · {{devices}} dispositivi",
      "summaryWithTickets": "{{accounts}} anagrafiche attive · {{devices}} dispositivi · {{tickets}} ticket aperti",
      "manualHint": "Ordine manuale: trascina una riga o usa le frecce sulla sua maniglia."
    },
    "empty": {
      "title": "Ancora nessuna organizzazione",
      "description": "Aggiungi il tuo primo cliente per iniziare a monitorare configurazione e dati anagrafici.",
      "noMatches": "Nessuna organizzazione corrisponde alla ricerca o al filtro."
    },
    "archived": {
      "loading": "Caricamento delle organizzazioni archiviate…",
      "empty": "Nessuna organizzazione archiviata.",
      "noMatches": "Nessuna organizzazione archiviata corrisponde alla ricerca.",
      "truncatedNote": "Vengono mostrate le prime {{count}} organizzazioni archiviate. Cerca per restringere l'elenco.",
      "fetchError": "Impossibile caricare le organizzazioni archiviate"
    },
    "restore": {
      "success": "{{name}} ripristinata — stato: {{status}}.",
      "recreateRequiredNote": "Prima che sia di nuovo pienamente utilizzabile: {{items}}",
      "suspendedNote": "Era sospesa prima dell'archiviazione, quindi è stata ripristinata come sospesa — risolvi questo aspetto prima che riprenda l'accesso normale.",
      "errors": {
        "restore": "Impossibile ripristinare l'organizzazione",
        "mfaRequired": "Il ripristino delle organizzazioni richiede l'autenticazione a più fattori. Abilita l'MFA nelle impostazioni di sicurezza del tuo profilo, quindi riprova.",
        "purging": "Questa organizzazione è già in fase di eliminazione definitiva e non può più essere ripristinata."
      }
    },
    "add": {
      "title": "Aggiungi organizzazione",
      "description": "Crea una nuova organizzazione con i dettagli qui sotto.",
      "submit": "Crea organizzazione",
      "created": "{{name}} aggiunta. La riga mostra cosa configurare adesso."
    },
    "errors": {
      "fetchOrganizations": "Impossibile recuperare le organizzazioni",
      "generic": "Si è verificato un errore",
      "saveOrder": "Impossibile salvare l'ordine delle organizzazioni",
      "saveOrganization": "Impossibile salvare l'organizzazione",
      "readiness": "Impossibile verificare la completezza di alcune organizzazioni."
    }
  },
  "shared": {
    "sortableTh": {
      "ascending": "Crescente",
      "descending": "Decrescente",
      "sortBy": "Ordina per {{label}}",
      "sortByWithDirection": "Ordina per {{label}}, {{direction}}"
    }
  }
```

- [ ] **Step 8: Add pt-BR**

`pages.json`: `"organizations": "Organizações"`.

```json
  "orgBoard": {
    "title": "Organizações",
    "description": "Cada cliente, o que ainda falta e o que está em aberto.",
    "loading": "Carregando organizações…",
    "actions": {
      "addOrganization": "Adicionar organização",
      "tryAgain": "Tente novamente",
      "clearFilters": "Limpar filtros",
      "openRecord": "Abrir registro",
      "contact": "Contatar {{name}}",
      "newTicket": "Novo chamado",
      "workHere": "Trabalhar nesta organização",
      "settings": "Configurações",
      "archive": "Arquivar organização",
      "merge": "Mesclar com outra organização",
      "restore": "Restaurar",
      "restoring": "Restaurando…"
    },
    "rowMenu": { "label": "Ações para {{name}}" },
    "search": { "label": "Buscar organizações, contatos e e-mails" },
    "lens": { "label": "Visão", "setup": "Configuração", "account": "Conta", "both": "Ambas" },
    "filters": {
      "label": "Filtrar",
      "all": "Todas",
      "setupIncomplete": "Configuração incompleta",
      "accountMissing": "Dados da conta ausentes",
      "openTickets": "Chamados abertos",
      "trial": "Avaliação",
      "archived": "Arquivadas"
    },
    "sort": { "label": "Ordenar", "manual": "Ordem manual", "name": "De A a Z", "tickets": "Chamados abertos" },
    "columns": { "organization": "Organização", "setup": "Configuração", "account": "Dados da conta", "tickets": "Chamados abertos", "actions": "Ações da linha" },
    "band": {
      "label": "Prontidão das contas",
      "all": "Contas",
      "allSub": "{{trial}} em avaliação · {{suspended}} suspensas",
      "setupIncomplete": "Configuração incompleta",
      "accountMissing": "Dados da conta ausentes",
      "openTickets": "Chamados abertos",
      "openTicketsSub": "{{count}} SLA violados",
      "pending": "Verificando organizações…",
      "partial": "Não foi possível verificar algumas organizações."
    },
    "chips": {
      "noSite": "Sem local",
      "noDevices": "Nenhum dispositivo inscrito",
      "noCheckIn": "Nenhum agente se reportou",
      "staleCheckIn_one": "Nenhum agente se reportou há {{count}} dia",
      "staleCheckIn_other": "Nenhum agente se reportou há {{count}} dias",
      "noPolicy": "Nenhuma política atribuída",
      "primaryContact": "Contato principal",
      "contactEmail": "E-mail do contato",
      "contactPhone": "Telefone do contato",
      "billingContact": "Contato de faturamento",
      "billingAddress": "Endereço de faturamento",
      "overdueInvoices_one": "{{count}} fatura vencida",
      "overdueInvoices_other": "{{count}} faturas vencidas",
      "invitation_one": "{{count}} convite não aceito",
      "invitation_other": "{{count}} convites não aceitos",
      "complete": "Completo",
      "notApplicable": "Não se aplica",
      "unavailable": "Indisponível",
      "stillNeeded": "Ainda pendente",
      "link": "{{chip}} de {{orgName}}"
    },
    "repair": {
      "sites": "Abrir a aba Locais de {{orgName}}",
      "devices": "Abrir a aba Dispositivos de {{orgName}}",
      "policies": "Abrir as políticas de configuração",
      "contacts": "Abrir a aba Contatos de {{orgName}}",
      "settings": "Abrir as configurações de {{orgName}}",
      "billing": "Abrir a aba Faturamento de {{orgName}}"
    },
    "tickets": { "open": "{{count}} abertos", "awaiting": "{{count}} aguardando o cliente", "sla": "{{count}} SLA violados" },
    "meta": {
      "workspace": "Espaço de trabalho",
      "devices_one": "{{count}} dispositivo",
      "devices_other": "{{count}} dispositivos",
      "sites_one": "{{count}} local",
      "sites_other": "{{count}} locais",
      "archivedBadge": "Arquivada",
      "archivingBadge": "Arquivando…",
      "keptIndefinitely": "Mantida indefinidamente",
      "purgeToday": "Excluída definitivamente hoje",
      "purgeCountdown_one": "Excluída definitivamente em {{count}} dia",
      "purgeCountdown_other": "Excluída definitivamente em {{count}} dias"
    },
    "reorder": {
      "handle": "Reordenar {{name}}",
      "hint": "Use as setas para cima e para baixo para mover esta organização.",
      "dragToReorder": "Arraste para reordenar",
      "moved": "{{name}} movida para a posição {{position}} de {{total}}"
    },
    "footer": {
      "summary": "{{accounts}} contas ativas · {{devices}} dispositivos",
      "summaryWithTickets": "{{accounts}} contas ativas · {{devices}} dispositivos · {{tickets}} chamados abertos",
      "manualHint": "Ordem manual: arraste uma linha ou use as setas na sua alça."
    },
    "empty": {
      "title": "Ainda não há organizações",
      "description": "Adicione seu primeiro cliente para começar a acompanhar a configuração e os dados da conta.",
      "noMatches": "Nenhuma organização corresponde à sua busca ou filtro."
    },
    "archived": {
      "loading": "Carregando organizações arquivadas…",
      "empty": "Nenhuma organização arquivada.",
      "noMatches": "Nenhuma organização arquivada corresponde à sua pesquisa.",
      "truncatedNote": "Mostrando as primeiras {{count}} organizações arquivadas. Pesquise para restringir a lista.",
      "fetchError": "Falha ao carregar as organizações arquivadas"
    },
    "restore": {
      "success": "{{name}} restaurada — status: {{status}}.",
      "recreateRequiredNote": "Antes que ela esteja totalmente utilizável de novo: {{items}}",
      "suspendedNote": "Ela estava suspensa antes de ser arquivada, então foi restaurada como suspensa — resolva isso antes que ela retome o acesso normal.",
      "errors": {
        "restore": "Falha ao restaurar a organização",
        "mfaRequired": "Restaurar organizações requer autenticação multifator. Ative o MFA nas configurações de segurança do seu perfil e tente novamente.",
        "purging": "Esta organização já está sendo excluída definitivamente e não pode mais ser restaurada."
      }
    },
    "add": {
      "title": "Adicionar organização",
      "description": "Crie uma nova organização com os detalhes abaixo.",
      "submit": "Criar organização",
      "created": "{{name}} adicionada. A linha mostra o que configurar a seguir."
    },
    "errors": {
      "fetchOrganizations": "Falha ao buscar organizações",
      "generic": "Ocorreu um erro",
      "saveOrder": "Falha ao salvar a ordem das organizações",
      "saveOrganization": "Falha ao salvar a organização",
      "readiness": "Não foi possível verificar a prontidão de algumas organizações."
    }
  },
  "shared": {
    "sortableTh": {
      "ascending": "crescente",
      "descending": "decrescente",
      "sortBy": "Ordenar por {{label}}",
      "sortByWithDirection": "Ordenar por {{label}}, {{direction}}"
    }
  }
```

- [ ] **Step 9: Add tr-TR**

`pages.json`: `"organizations": "Organizasyonlar"`.

```json
  "orgBoard": {
    "title": "Kuruluşlar",
    "description": "Her müşteri, hâlâ neye ihtiyacı olduğu ve neyin açık olduğu.",
    "loading": "Kuruluşlar yükleniyor…",
    "actions": {
      "addOrganization": "Kuruluş ekle",
      "tryAgain": "Tekrar deneyin",
      "clearFilters": "Filtreleri temizle",
      "openRecord": "Kaydı aç",
      "contact": "{{name}} ile iletişime geç",
      "newTicket": "Yeni bilet",
      "workHere": "Bu kuruluşta çalış",
      "settings": "Ayarlar",
      "archive": "Kuruluşu arşivle",
      "merge": "Başka bir kuruluşla birleştir",
      "restore": "Geri yükle",
      "restoring": "Geri yükleniyor…"
    },
    "rowMenu": { "label": "{{name}} için işlemler" },
    "search": { "label": "Kuruluş, kişi ve e-posta ara" },
    "lens": { "label": "Görünüm", "setup": "Kurulum", "account": "Hesap", "both": "Her ikisi" },
    "filters": {
      "label": "Filtrele",
      "all": "Tümü",
      "setupIncomplete": "Kurulum tamamlanmadı",
      "accountMissing": "Hesap verileri eksik",
      "openTickets": "Açık biletler",
      "trial": "Deneme",
      "archived": "Arşivlenenler"
    },
    "sort": { "label": "Sırala", "manual": "Elle sıralama", "name": "A'dan Z'ye", "tickets": "Açık biletler" },
    "columns": { "organization": "Kuruluş", "setup": "Kurulum", "account": "Hesap verileri", "tickets": "Açık biletler", "actions": "Satır işlemleri" },
    "band": {
      "label": "Hesap hazırlığı",
      "all": "Hesaplar",
      "allSub": "{{trial}} deneme · {{suspended}} askıda",
      "setupIncomplete": "Kurulum tamamlanmadı",
      "accountMissing": "Hesap verileri eksik",
      "openTickets": "Açık biletler",
      "openTicketsSub": "{{count}} SLA ihlali",
      "pending": "Kuruluşlar denetleniyor…",
      "partial": "Bazı kuruluşlar denetlenemedi."
    },
    "chips": {
      "noSite": "Site yok",
      "noDevices": "Kayıtlı cihaz yok",
      "noCheckIn": "Hiçbir agent bağlanmadı",
      "staleCheckIn_one": "{{count}} gündür agent bağlanmadı",
      "staleCheckIn_other": "{{count}} gündür agent bağlanmadı",
      "noPolicy": "Atanmış politika yok",
      "primaryContact": "Birincil kişi",
      "contactEmail": "Kişi e-postası",
      "contactPhone": "Kişi telefonu",
      "billingContact": "Fatura kişisi",
      "billingAddress": "Fatura adresi",
      "overdueInvoices_one": "{{count}} gecikmiş fatura",
      "overdueInvoices_other": "{{count}} gecikmiş fatura",
      "invitation_one": "{{count}} davet kabul edilmedi",
      "invitation_other": "{{count}} davet kabul edilmedi",
      "complete": "Tamam",
      "notApplicable": "Uygulanamaz",
      "unavailable": "Kullanılamıyor",
      "stillNeeded": "Hâlâ gerekli",
      "link": "{{orgName}} için {{chip}}"
    },
    "repair": {
      "sites": "{{orgName}} için Siteler sekmesini aç",
      "devices": "{{orgName}} için Cihazlar sekmesini aç",
      "policies": "Yapılandırma politikalarını aç",
      "contacts": "{{orgName}} için Kişiler sekmesini aç",
      "settings": "{{orgName}} ayarlarını aç",
      "billing": "{{orgName}} için Faturalandırma sekmesini aç"
    },
    "tickets": { "open": "{{count}} açık", "awaiting": "{{count}} müşteri yanıtı bekliyor", "sla": "{{count}} SLA ihlali" },
    "meta": {
      "workspace": "Çalışma alanı",
      "devices_one": "{{count}} cihaz",
      "devices_other": "{{count}} cihaz",
      "sites_one": "{{count}} site",
      "sites_other": "{{count}} site",
      "archivedBadge": "Arşivlendi",
      "archivingBadge": "Arşivleniyor…",
      "keptIndefinitely": "Süresiz olarak saklanıyor",
      "purgeToday": "Bugün kalıcı olarak silinecek",
      "purgeCountdown_one": "{{count}} gün içinde kalıcı olarak silinecek",
      "purgeCountdown_other": "{{count}} gün içinde kalıcı olarak silinecek"
    },
    "reorder": {
      "handle": "{{name}} sırasını değiştir",
      "hint": "Bu kuruluşu taşımak için yukarı ve aşağı ok tuşlarını kullanın.",
      "dragToReorder": "Yeniden sıralamak için sürükleyin",
      "moved": "{{name}}, {{total}} kuruluş içinde {{position}}. sıraya taşındı"
    },
    "footer": {
      "summary": "{{accounts}} etkin hesap · {{devices}} cihaz",
      "summaryWithTickets": "{{accounts}} etkin hesap · {{devices}} cihaz · {{tickets}} açık bilet",
      "manualHint": "Elle sıralama: bir satırı sürükleyin veya tutamacında ok tuşlarını kullanın."
    },
    "empty": {
      "title": "Henüz kuruluş yok",
      "description": "Kurulumu ve hesap verilerini izlemeye başlamak için ilk müşterinizi ekleyin.",
      "noMatches": "Aramanızla veya filtrenizle eşleşen kuruluş yok."
    },
    "archived": {
      "loading": "Arşivlenen kuruluşlar yükleniyor…",
      "empty": "Arşivlenmiş kuruluş yok.",
      "noMatches": "Aramanızla eşleşen arşivlenmiş kuruluş yok.",
      "truncatedNote": "İlk {{count}} arşivlenmiş kuruluş gösteriliyor. Listeyi daraltmak için arama yapın.",
      "fetchError": "Arşivlenen kuruluşlar yüklenemedi"
    },
    "restore": {
      "success": "{{name}} geri yüklendi — durum: {{status}}.",
      "recreateRequiredNote": "Tekrar tam olarak kullanılabilir olmadan önce: {{items}}",
      "suspendedNote": "Arşivlenmeden önce askıya alınmıştı, bu nedenle askıya alınmış olarak geri yüklendi — normal erişimi sürdürmeden önce bunu çözün.",
      "errors": {
        "restore": "Kuruluş geri yüklenemedi",
        "mfaRequired": "Kuruluşları geri yüklemek çok faktörlü kimlik doğrulama gerektirir. Profil güvenlik ayarlarınızda MFA'yı etkinleştirin ve tekrar deneyin.",
        "purging": "Bu kuruluş zaten kalıcı olarak siliniyor ve artık geri yüklenemez."
      }
    },
    "add": {
      "title": "Kuruluş ekle",
      "description": "Aşağıdaki ayrıntılarla yeni bir kuruluş oluşturun.",
      "submit": "Kuruluş oluştur",
      "created": "{{name}} eklendi. Satırı sırada ne kurulacağını gösterir."
    },
    "errors": {
      "fetchOrganizations": "Kuruluşlar getirilemedi",
      "generic": "Bir hata oluştu",
      "saveOrder": "Kuruluş sırası kaydedilemedi",
      "saveOrganization": "Kuruluş kaydedilemedi",
      "readiness": "Bazı kuruluşların hesap hazırlığı denetlenemedi."
    }
  },
  "shared": {
    "sortableTh": {
      "ascending": "Artan",
      "descending": "Azalan",
      "sortBy": "Şuna göre sırala: {{label}}",
      "sortByWithDirection": "Şuna göre sırala: {{label}}, {{direction}}"
    }
  }
```

- [ ] **Step 10: Bump the three reviewed duplicate baselines**

In `apps/web/src/lib/i18n/translationCoverage.test.ts`:
- `fr-FR` block: `'organizations.json': 8` → `'organizations.json': 10, // … ; +2 W02 account board: orgBoard.meta.sites_one/_other "{{count}} site(s)" spell identically in fr-FR`
- `fr-CA` block: `'organizations.json': 7` → `9` with the same comment (fr-CA).
- `tr-TR` block: `'organizations.json': 1` → `2, // … ; +1 W02 account board: orgBoard.meta.sites_one "{{count}} site" is the same cognate in tr-TR`

Every other new value differs from English by construction (verified in Step 11); do not bump any other baseline.

- [ ] **Step 11: Run the parity and coverage contracts**

Run: `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts`
Expected: PASS. If `translationCoverage` reports a regression, the message names the key: translate that value (never copy English) rather than bumping a baseline.

- [ ] **Step 12: Commit**

```bash
git add apps/web/src/locales apps/web/src/lib/i18n/translationCoverage.test.ts
git commit -m "i18n(web): orgBoard.* and shared.sortableTh in eight locales, titles.organizations (W02 #5723)

pt-BR strings are machine-drafted pending native review
es-419, fr-FR, fr-CA, de-DE, and it-IT strings are machine-drafted pending native review"
```

---

### Task 5: `useAccountReadiness` — 200-id batches, concurrency 2, latest-wins, per-batch failure, retry

**Files:**
- Create: `apps/web/src/components/organizations/board/useAccountReadiness.ts`
- Test: `apps/web/src/components/organizations/board/useAccountReadiness.test.tsx`

**Interfaces:**
- Consumes: `fetchWithAuth`, `handleSessionExpired` (`@/stores/auth`); types from `@/lib/orgReadiness`.
- Produces: `READINESS_BATCH_SIZE = 200`, `READINESS_CONCURRENCY = 2`, `chunkIds(ids, size?)`, `ReadinessStatus = 'idle' | 'loading' | 'partial' | 'ready'`, `AccountReadinessState { capabilities, mode, byOrg, rowState, status, retry }`, `useAccountReadiness(orgIds: readonly string[]): AccountReadinessState`.

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/web/src/components/organizations/board/useAccountReadiness.test.tsx
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithAuth, handleSessionExpired } from '@/stores/auth';
import { chunkIds, READINESS_BATCH_SIZE, READINESS_CONCURRENCY, useAccountReadiness } from './useAccountReadiness';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn(), handleSessionExpired: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);

const CAPS = { sites: true, devices: true, policies: true, contacts: true, portalUsers: true, invoices: true, tickets: true, integrations: false };
const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;
const ids = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
const requestedIds = (call: number) => new URL(String(fetchMock.mock.calls[call][0]), 'http://x').searchParams.get('orgIds')!.split(',');
const body = (orgIds: string[], mode: 'native' | 'external' | 'off' = 'native') => ({
  partnerId: 'p1',
  capabilities: CAPS,
  serviceManagementMode: mode,
  orgs: orgIds.map((orgId) => ({
    orgId, type: 'customer', status: 'active',
    setup: { sites: 1, devices: 1, lastSeenAt: null, policyAssigned: true },
    account: { primaryContact: null, billingRoleContact: true, billingAddress: true },
  })),
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(handleSessionExpired).mockReset();
});

describe('chunkIds', () => {
  it('splits into batches of 200', () => {
    expect(chunkIds(ids(450)).map((c) => c.length)).toEqual([200, 200, 50]);
    expect(READINESS_BATCH_SIZE).toBe(200);
    expect(READINESS_CONCURRENCY).toBe(2);
  });
});

describe('useAccountReadiness', () => {
  it('requests one batch per 200 ids, fills rows per batch and lands on ready', async () => {
    fetchMock.mockImplementation(async (input) => jsonResponse(body(new URL(String(input), 'http://x').searchParams.get('orgIds')!.split(','))));
    const all = ids(250);
    const { result } = renderHook(() => useAccountReadiness(all));
    expect(result.current.status).toBe('loading');
    expect(result.current.rowState.get(all[0])).toBe('pending');

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestedIds(0)).toHaveLength(200);
    expect(requestedIds(1)).toHaveLength(50);
    expect(result.current.byOrg.size).toBe(250);
    expect(result.current.rowState.get(all[249])).toBe('ready');
    expect(result.current.capabilities).toEqual(CAPS);
    expect(result.current.mode).toBe('native');
  });

  it('never has more than two batches in flight', async () => {
    const holds: Array<(r: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { holds.push(resolve); }));
    const all = ids(1000); // 5 batches
    const { result } = renderHook(() => useAccountReadiness(all));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => { holds[0](jsonResponse(body(requestedIds(0)))); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await act(async () => { holds[1](jsonResponse(body(requestedIds(1)))); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    await act(async () => { holds[2](jsonResponse(body(requestedIds(2)))); holds[3](jsonResponse(body(requestedIds(3)))); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    await act(async () => { holds[4](jsonResponse(body(requestedIds(4)))); });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.byOrg.size).toBe(1000);
  });

  it('latest-wins: a response for a superseded id set is discarded', async () => {
    const holds: Array<(r: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { holds.push(resolve); }));
    const first = ids(2);
    const second = ['ffffffff-0000-4000-8000-000000000001'];
    const { result, rerender } = renderHook(({ list }: { list: string[] }) => useAccountReadiness(list), { initialProps: { list: first } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender({ list: second });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(result.current.rowState.get(first[0])).toBeUndefined();

    await act(async () => { holds[1](jsonResponse(body(second))); });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => { holds[0](jsonResponse(body(first))); }); // the stale one resolves last
    expect(result.current.byOrg.has(first[0])).toBe(false);
    expect(result.current.byOrg.has(second[0])).toBe(true);
    expect(result.current.status).toBe('ready');
  });

  it('a failed batch marks only its rows failed, reports partial, and retry re-requests only that batch', async () => {
    const all = ids(250);
    fetchMock.mockImplementation(async (input) => {
      const requested = new URL(String(input), 'http://x').searchParams.get('orgIds')!.split(',');
      return requested.length === 50 && fetchMock.mock.calls.length <= 2 ? jsonResponse({ error: 'boom' }, false, 500) : jsonResponse(body(requested));
    });
    const { result } = renderHook(() => useAccountReadiness(all));
    await waitFor(() => expect(result.current.status).toBe('partial'));
    expect(result.current.rowState.get(all[0])).toBe('ready');
    expect(result.current.rowState.get(all[249])).toBe('failed');
    expect(result.current.byOrg.size).toBe(200);

    await act(async () => { result.current.retry(); });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(requestedIds(2)).toHaveLength(50);
    expect(result.current.byOrg.size).toBe(250);
  });

  it('a thrown fetch counts as a failed batch, not a crash', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useAccountReadiness(ids(1)));
    await waitFor(() => expect(result.current.status).toBe('partial'));
  });

  it('hands a 401 to handleSessionExpired', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Unauthorized' }, false, 401));
    renderHook(() => useAccountReadiness(ids(1)));
    await waitFor(() => expect(handleSessionExpired).toHaveBeenCalled());
  });

  it('the same ids in a different order (a manual reorder) do not refetch', async () => {
    fetchMock.mockImplementation(async (input) => jsonResponse(body(new URL(String(input), 'http://x').searchParams.get('orgIds')!.split(','))));
    const all = ids(3);
    const { result, rerender } = renderHook(({ list }: { list: string[] }) => useAccountReadiness(list), { initialProps: { list: all } });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    rerender({ list: [...all].reverse() });
    await act(async () => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('ready');
  });

  it('is idle with no ids', () => {
    const { result } = renderHook(() => useAccountReadiness([]));
    expect(result.current.status).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npx vitest run src/components/organizations/board/useAccountReadiness.test.tsx`
Expected: FAIL — `Failed to resolve import "./useAccountReadiness"`.

- [ ] **Step 3: Write the hook**

```ts
// apps/web/src/components/organizations/board/useAccountReadiness.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithAuth, handleSessionExpired } from '@/stores/auth';
import type { ServiceManagementMode } from '@/stores/orgStore';
import type {
  AccountReadinessResponse,
  ReadinessCapabilities,
  ReadinessOrg,
  ReadinessRowState,
} from '@/lib/orgReadiness';

/** The endpoint's hard cap on `orgIds` (400 above it). */
export const READINESS_BATCH_SIZE = 200;
/** At most two readiness requests in flight — the spec's ceiling for the web. */
export const READINESS_CONCURRENCY = 2;

export type ReadinessStatus = 'idle' | 'loading' | 'partial' | 'ready';

export interface AccountReadinessState {
  /** From the last batch that landed; null until the first one does. */
  capabilities: ReadinessCapabilities | null;
  mode: ServiceManagementMode | null;
  byOrg: ReadonlyMap<string, ReadinessOrg>;
  rowState: ReadonlyMap<string, ReadinessRowState>;
  status: ReadinessStatus;
  /** Re-requests only the batches that failed; rows that already landed are kept. */
  retry: () => void;
}

export function chunkIds(ids: readonly string[], size = READINESS_BATCH_SIZE): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

type BatchResult = { kind: 'ok'; response: AccountReadinessResponse } | { kind: 'failed' } | { kind: 'unauthorized' };

async function fetchBatch(ids: string[]): Promise<BatchResult> {
  try {
    const res = await fetchWithAuth(`/orgs/account-readiness?orgIds=${ids.join(',')}`);
    if (res.status === 401) return { kind: 'unauthorized' };
    if (!res.ok) return { kind: 'failed' };
    const body = (await res.json()) as AccountReadinessResponse | null;
    // An envelope without `orgs`/`capabilities` is not a readiness payload; treat it as a failed batch, never as "all complete".
    if (!body || typeof body !== 'object' || !Array.isArray(body.orgs) || !body.capabilities) return { kind: 'failed' };
    return { kind: 'ok', response: body };
  } catch {
    return { kind: 'failed' };
  }
}

/**
 * Batched account-readiness reads for the board. Every change to the SET of
 * ids starts a new generation: state is reset and the old generation's
 * responses are discarded on arrival (latest-wins). A manual reorder changes
 * the order, not the set, so it never refetches.
 */
export function useAccountReadiness(orgIds: readonly string[]): AccountReadinessState {
  const key = [...orgIds].sort().join(',');
  const [capabilities, setCapabilities] = useState<ReadinessCapabilities | null>(null);
  const [mode, setMode] = useState<ServiceManagementMode | null>(null);
  const [byOrg, setByOrg] = useState<Map<string, ReadinessOrg>>(() => new Map());
  const [rowState, setRowState] = useState<Map<string, ReadinessRowState>>(() => new Map());
  const [inFlight, setInFlight] = useState(0);
  const [failedChunks, setFailedChunks] = useState<string[][]>([]);
  const generation = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const runChunks = useCallback(async (chunks: string[][], gen: number) => {
    const queue = [...chunks];
    setInFlight((n) => n + chunks.length);
    const worker = async () => {
      for (;;) {
        const chunk = queue.shift();
        if (!chunk) return;
        const result = await fetchBatch(chunk);
        // Latest-wins: a response for a superseded id set never touches state —
        // the newer generation already reset everything it is about to fill.
        if (!mounted.current || gen !== generation.current) return;
        if (result.kind === 'unauthorized') {
          handleSessionExpired();
          return;
        }
        if (result.kind === 'failed') {
          setRowState((prev) => {
            const next = new Map(prev);
            for (const id of chunk) next.set(id, 'failed');
            return next;
          });
          setFailedChunks((prev) => [...prev, chunk]);
        } else {
          const { response } = result;
          setCapabilities(response.capabilities);
          setMode(response.serviceManagementMode);
          setByOrg((prev) => {
            const next = new Map(prev);
            for (const org of response.orgs) next.set(org.orgId, org);
            return next;
          });
          setRowState((prev) => {
            const next = new Map(prev);
            for (const id of chunk) next.set(id, 'ready');
            return next;
          });
        }
        setInFlight((n) => n - 1);
      }
    };
    await Promise.all(Array.from({ length: Math.min(READINESS_CONCURRENCY, chunks.length) }, worker));
  }, []);

  useEffect(() => {
    const gen = ++generation.current;
    const ids = key ? key.split(',') : [];
    setByOrg(new Map());
    setFailedChunks([]);
    setRowState(new Map<string, ReadinessRowState>(ids.map((id) => [id, 'pending'])));
    setInFlight(0);
    if (ids.length === 0) return;
    void runChunks(chunkIds(ids), gen);
  }, [key, runChunks]);

  const retry = useCallback(() => {
    if (failedChunks.length === 0) return;
    const chunks = failedChunks;
    setFailedChunks([]);
    setRowState((prev) => {
      const next = new Map(prev);
      for (const id of chunks.flat()) next.set(id, 'pending');
      return next;
    });
    void runChunks(chunks, generation.current);
  }, [failedChunks, runChunks]);

  const status: ReadinessStatus = key === '' ? 'idle' : inFlight > 0 ? 'loading' : failedChunks.length > 0 ? 'partial' : 'ready';

  return { capabilities, mode, byOrg, rowState, status, retry };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run src/components/organizations/board/useAccountReadiness.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/organizations/board/useAccountReadiness.ts apps/web/src/components/organizations/board/useAccountReadiness.test.tsx
git commit -m "feat(web): useAccountReadiness — 200-id batches, concurrency 2, latest-wins, per-batch failure and retry (W02 #5723)"
```

---

### Task 6: `useManualOrder` — drag and arrow-key reorder through `runAction`, serialised by `reorderPending`

**Files:**
- Create: `apps/web/src/components/organizations/board/useManualOrder.ts`
- Test: `apps/web/src/components/organizations/board/useManualOrder.test.tsx`

**Interfaces:**
- Consumes: `runAction` (`@/lib/runAction`), `fetchWithAuth`/`handleSessionExpired`, `orgBoard.errors.saveOrder`, `orgBoard.reorder.moved`.
- Produces: `ManualOrderApi { reorderPending, announcement, draggedOrgId, dragOverOrgId, onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd, move }`, `useManualOrder({ organizations, setOrganizations, refetch })`.

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/web/src/components/organizations/board/useManualOrder.test.tsx
import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import type { Organization } from '@/components/settings/organizationTypes';
import { fetchWithAuth } from '@/stores/auth';
import { showToast } from '@/components/shared/Toast';
import { useManualOrder } from './useManualOrder';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn(), handleSessionExpired: vi.fn() }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);

const A: Organization = { id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'Alpha Ltd', status: 'active', createdAt: '2026-01-01T00:00:00Z' };
const B: Organization = { id: 'bbbbbbbb-2222-4222-8222-222222222222', name: 'Beta Ltd', status: 'active', createdAt: '2026-01-02T00:00:00Z' };
const C: Organization = { id: 'cccccccc-3333-4333-8333-333333333333', name: 'Gamma Ltd', status: 'active', createdAt: '2026-01-03T00:00:00Z' };

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function Harness({ initial, refetch }: { initial: Organization[]; refetch: () => Promise<void> }) {
  const [organizations, setOrganizations] = useState(initial);
  const order = useManualOrder({ organizations, setOrganizations, refetch });
  return (
    <div>
      <div data-testid="announcement">{order.announcement}</div>
      <div data-testid="pending">{String(order.reorderPending)}</div>
      <ul>
        {organizations.map((org) => (
          <li
            key={org.id}
            data-testid={`row-${org.id}`}
            draggable
            onDragStart={(e) => order.onDragStart(e, org)}
            onDragOver={(e) => order.onDragOver(e, org)}
            onDragLeave={order.onDragLeave}
            onDrop={(e) => order.onDrop(e, org)}
            onDragEnd={order.onDragEnd}
          >
            {org.name}
            <button type="button" data-testid={`down-${org.id}`} onClick={() => order.move(org, 1)}>down</button>
            <button type="button" data-testid={`up-${org.id}`} onClick={() => order.move(org, -1)}>up</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const renderedIds = () => Array.from(document.querySelectorAll('[data-testid^="row-"]')).map((el) => el.getAttribute('data-testid')!.replace('row-', ''));
const patches = () => fetchMock.mock.calls.filter(([url, init]) => String(url) === '/orgs/organizations/order' && init?.method === 'PATCH');
const lastPatchBody = () => JSON.parse(String(patches().at(-1)![1]!.body)) as { orderedIds: string[] };

function drag(sourceId: string, targetId: string) {
  const dataTransfer = { effectAllowed: '', setData: vi.fn(), dropEffect: '' };
  fireEvent.dragStart(screen.getByTestId(`row-${sourceId}`), { dataTransfer });
  fireEvent.dragOver(screen.getByTestId(`row-${targetId}`), { dataTransfer });
  fireEvent.drop(screen.getByTestId(`row-${targetId}`), { dataTransfer });
}

beforeEach(() => {
  fetchMock.mockReset();
  toastMock.mockReset();
});

describe('useManualOrder', () => {
  it('a keyboard move splices the list, PATCHes the new order and announces the move', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const refetch = vi.fn().mockResolvedValue(undefined);
    render(<Harness initial={[A, B, C]} refetch={refetch} />);

    fireEvent.click(screen.getByTestId(`down-${A.id}`));
    expect(renderedIds()).toEqual([B.id, A.id, C.id]);
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(lastPatchBody()).toEqual({ orderedIds: [B.id, A.id, C.id] });
    expect(screen.getByTestId('announcement')).toHaveTextContent('Alpha Ltd moved to position 2 of 3');
    await waitFor(() => expect(screen.getByTestId('pending')).toHaveTextContent('false'));
    expect(refetch).not.toHaveBeenCalled();
  });

  it('a move off either end is a no-op', () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    render(<Harness initial={[A, B]} refetch={vi.fn()} />);
    fireEvent.click(screen.getByTestId(`up-${A.id}`));
    fireEvent.click(screen.getByTestId(`down-${B.id}`));
    expect(renderedIds()).toEqual([A.id, B.id]);
    expect(patches()).toHaveLength(0);
  });

  it('a drag-and-drop PATCHes the new order without an announcement', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    render(<Harness initial={[A, B, C]} refetch={vi.fn()} />);
    drag(C.id, A.id);
    expect(renderedIds()).toEqual([C.id, A.id, B.id]);
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(lastPatchBody()).toEqual({ orderedIds: [C.id, A.id, B.id] });
    expect(screen.getByTestId('announcement')).toHaveTextContent('');
  });

  it('a rejected PATCH (403) toasts through runAction and re-reads the authoritative order', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Forbidden' }, false, 403));
    const refetch = vi.fn().mockResolvedValue(undefined);
    render(<Harness initial={[A, B, C]} refetch={refetch} />);
    fireEvent.click(screen.getByTestId(`down-${A.id}`));
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Forbidden' }));
    await waitFor(() => expect(screen.getByTestId('pending')).toHaveTextContent('false'));
  });

  it('a transport failure (fetch throws) also re-reads rather than restoring a local snapshot', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const refetch = vi.fn().mockResolvedValue(undefined);
    render(<Harness initial={[A, B, C]} refetch={refetch} />);
    fireEvent.click(screen.getByTestId(`down-${A.id}`));
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('ignores a second move while the first PATCH is in flight', async () => {
    let release: ((r: Response) => void) | undefined;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { release = resolve; }));
    render(<Harness initial={[A, B, C]} refetch={vi.fn()} />);
    fireEvent.click(screen.getByTestId(`down-${A.id}`));
    await waitFor(() => expect(screen.getByTestId('pending')).toHaveTextContent('true'));
    const mid = renderedIds();
    fireEvent.click(screen.getByTestId(`down-${C.id}`));
    drag(C.id, B.id);
    expect(renderedIds()).toEqual(mid);
    expect(patches()).toHaveLength(1);
    release!(jsonResponse({ ok: true }));
    await waitFor(() => expect(screen.getByTestId('pending')).toHaveTextContent('false'));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npx vitest run src/components/organizations/board/useManualOrder.test.tsx`
Expected: FAIL — `Failed to resolve import "./useManualOrder"`.

- [ ] **Step 3: Write the hook**

```ts
// apps/web/src/components/organizations/board/useManualOrder.ts
import { useCallback, useState, type DragEvent, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { Organization } from '@/components/settings/organizationTypes';
import { fetchWithAuth, handleSessionExpired } from '@/stores/auth';
import { runAction } from '@/lib/runAction';

export interface ManualOrderApi {
  /** True from the PATCH until reconciliation settles. Dragging is disabled and
   *  keyboard moves are ignored meanwhile, which SERIALISES reorders: every
   *  stale-order race needs a second move to overlap the first request. */
  reorderPending: boolean;
  /** Last keyboard move, read out by the page's polite live region. */
  announcement: string;
  draggedOrgId: string | null;
  dragOverOrgId: string | null;
  onDragStart: (event: DragEvent<HTMLElement>, org: Organization) => void;
  onDragOver: (event: DragEvent<HTMLElement>, org: Organization) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>, target: Organization) => void;
  onDragEnd: () => void;
  /** Keyboard reorder: one step up or down. Ignored, not hidden, while a PATCH is in flight. */
  move: (org: Organization, delta: -1 | 1) => void;
}

export interface UseManualOrderOptions {
  organizations: Organization[];
  setOrganizations: Dispatch<SetStateAction<Organization[]>>;
  /** Authoritative silent re-read after a failed PATCH (must not blank the page). */
  refetch: () => Promise<void>;
}

function moveItem(list: Organization[], sourceIndex: number, targetIndex: number): Organization[] {
  const next = [...list];
  const [moved] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, moved);
  return next;
}

export function useManualOrder({ organizations, setOrganizations, refetch }: UseManualOrderOptions): ManualOrderApi {
  const { t } = useTranslation('organizations');
  const [reorderPending, setReorderPending] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [draggedOrgId, setDraggedOrgId] = useState<string | null>(null);
  const [dragOverOrgId, setDragOverOrgId] = useState<string | null>(null);

  const persist = useCallback(
    async (orderedIds: string[]) => {
      setReorderPending(true);
      try {
        await runAction({
          request: () =>
            fetchWithAuth('/orgs/organizations/order', { method: 'PATCH', body: JSON.stringify({ orderedIds }) }),
          errorFallback: t('orgBoard.errors.saveOrder'),
          onUnauthorized: handleSessionExpired,
        });
      } catch {
        // Only the server knows what persisted: runAction collapses a lost
        // response and a rejected PATCH to the same throw, so re-read rather
        // than restore a local snapshot (which would lie in one direction or
        // the other). `reorderPending` keeps a second drag from overlapping
        // this GET. The error toast already fired inside runAction.
        await refetch();
      } finally {
        setReorderPending(false);
      }
    },
    [refetch, t],
  );

  const reorder = useCallback(
    (sourceId: string, targetId: string, announce: boolean) => {
      const sourceIndex = organizations.findIndex((o) => o.id === sourceId);
      const targetIndex = organizations.findIndex((o) => o.id === targetId);
      if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) return;
      const next = moveItem(organizations, sourceIndex, targetIndex);
      setOrganizations(next);
      if (announce) {
        setAnnouncement(
          t('orgBoard.reorder.moved', { name: organizations[sourceIndex].name, position: targetIndex + 1, total: next.length }),
        );
      }
      void persist(next.map((o) => o.id));
    },
    [organizations, persist, setOrganizations, t],
  );

  const onDragStart = useCallback((event: DragEvent<HTMLElement>, org: Organization) => {
    setDraggedOrgId(org.id);
    event.dataTransfer.effectAllowed = 'move';
    // Firefox requires data to be set or the drag never fires.
    try {
      event.dataTransfer.setData('text/plain', org.id);
    } catch {
      /* jsdom / older engines without a DataTransfer store */
    }
  }, []);

  const onDragOver = useCallback(
    (event: DragEvent<HTMLElement>, org: Organization) => {
      if (!draggedOrgId || draggedOrgId === org.id) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (dragOverOrgId !== org.id) setDragOverOrgId(org.id);
    },
    [draggedOrgId, dragOverOrgId],
  );

  const onDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    // Only clear when leaving the row entirely, not when entering a child.
    const related = event.relatedTarget as Node | null;
    if (!related || !(event.currentTarget as Node).contains(related)) setDragOverOrgId(null);
  }, []);

  const onDrop = useCallback(
    (event: DragEvent<HTMLElement>, target: Organization) => {
      event.preventDefault();
      setDragOverOrgId(null);
      const sourceId = draggedOrgId;
      setDraggedOrgId(null);
      if (!sourceId || reorderPending) return;
      reorder(sourceId, target.id, false);
    },
    [draggedOrgId, reorder, reorderPending],
  );

  const onDragEnd = useCallback(() => {
    setDraggedOrgId(null);
    setDragOverOrgId(null);
  }, []);

  const move = useCallback(
    (org: Organization, delta: -1 | 1) => {
      if (reorderPending) return;
      const index = organizations.findIndex((o) => o.id === org.id);
      if (index === -1) return;
      const targetIndex = index + delta;
      if (targetIndex < 0 || targetIndex >= organizations.length) return;
      reorder(org.id, organizations[targetIndex].id, true);
    },
    [organizations, reorder, reorderPending],
  );

  return { reorderPending, announcement, draggedOrgId, dragOverOrgId, onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd, move };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run src/components/organizations/board/useManualOrder.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/organizations/board/useManualOrder.ts apps/web/src/components/organizations/board/useManualOrder.test.tsx
git commit -m "feat(web): useManualOrder — drag/arrow-key reorder via runAction with reorderPending and authoritative refetch (W02 #5723)"
```

---

### Task 7: `useArchivedOrganizations` — on-demand fetch with server-side search, debounce and race guard

**Files:**
- Create: `apps/web/src/components/organizations/board/useArchivedOrganizations.ts`
- Test: `apps/web/src/components/organizations/board/useArchivedOrganizations.test.tsx`

**Interfaces:**
- Consumes: `fetchAllOrganizations` (`@/lib/fetchAllOrganizations`), `fetchWithAuth`/`handleSessionExpired`, `orgBoard.archived.fetchError`, `orgBoard.errors.generic`.
- Produces: `ARCHIVED_SEARCH_DEBOUNCE_MS = 300`, `ArchivedOrganizationsApi { archivedOrgs, loading, error, truncated, loaded, remove }`, `useArchivedOrganizations({ enabled, search })`.

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/web/src/components/organizations/board/useArchivedOrganizations.test.tsx
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import type { Organization } from '@/components/settings/organizationTypes';
import { fetchWithAuth } from '@/stores/auth';
import { ARCHIVED_SEARCH_DEBOUNCE_MS, useArchivedOrganizations } from './useArchivedOrganizations';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn(), handleSessionExpired: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);

const LIVE: Organization = { id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'Alpha Ltd', status: 'active', createdAt: '2026-01-01T00:00:00Z' };
const GAMMA: Organization = { id: 'cccccccc-3333-4333-8333-333333333333', name: 'Gamma LLC', status: 'archived', createdAt: '2026-01-03T00:00:00Z', archived: true, purgeAt: '2026-10-13T00:00:00.000Z' };
const DELTA: Organization = { id: 'dddddddd-4444-4444-8444-444444444444', name: 'Delta Inc', status: 'archived', createdAt: '2026-01-04T00:00:00Z', archived: true, purgeAt: null };

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

/** Mimics the API's server-side `search` over the archived rows (orgs.ts / archivedOrgReads.ts). */
function mockApi(opts: { archived?: Organization[]; truncated?: boolean } = {}) {
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(String(input), 'http://localhost');
    const search = url.searchParams.get('search')?.toLowerCase();
    const archived = (opts.archived ?? [GAMMA, DELTA]).filter((o) => (search ? o.name.toLowerCase().includes(search) : true));
    return jsonResponse({ data: [LIVE, ...archived], pagination: { page: 1, limit: 100, total: 1 }, archivedTruncated: opts.truncated ?? false });
  });
}
const archivedCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('includeArchived=true'));
const flush = async (ms = ARCHIVED_SEARCH_DEBOUNCE_MS + 50) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => { vi.useFakeTimers(); fetchMock.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe('useArchivedOrganizations', () => {
  it('does not fetch while disabled, even if the search changes', async () => {
    mockApi();
    const { rerender } = renderHook(({ enabled, search }) => useArchivedOrganizations({ enabled, search }), { initialProps: { enabled: false, search: '' } });
    rerender({ enabled: false, search: 'gam' });
    await flush();
    expect(archivedCalls()).toHaveLength(0);
  });

  it('fetches with includeArchived=true after the debounce, keeps only archived rows and reports truncation', async () => {
    mockApi({ truncated: true });
    const { result } = renderHook(() => useArchivedOrganizations({ enabled: true, search: '' }));
    await flush(ARCHIVED_SEARCH_DEBOUNCE_MS - 50);
    expect(archivedCalls()).toHaveLength(0);
    await flush(100);
    expect(archivedCalls()).toHaveLength(1);
    expect(String(archivedCalls()[0][0])).toContain('includeArchived=true');
    expect(result.current.archivedOrgs.map((o) => o.id)).toEqual([GAMMA.id, DELTA.id]);
    expect(result.current.truncated).toBe(true);
    expect(result.current.loaded).toBe(true);
    expect(result.current.loading).toBe(false);
  });

  it('forwards the search term as the API `search` param and the server narrows the rows', async () => {
    mockApi();
    const { result, rerender } = renderHook(({ search }) => useArchivedOrganizations({ enabled: true, search }), { initialProps: { search: '' } });
    await flush();
    rerender({ search: 'gamma' });
    await flush();
    expect(String(archivedCalls()[1][0])).toContain('search=gamma');
    expect(result.current.archivedOrgs.map((o) => o.id)).toEqual([GAMMA.id]);
  });

  it('drops a stale response that resolves after a newer one, even though it started first', async () => {
    const holds: Array<{ search: string | null; resolve: (r: Response) => void }> = [];
    fetchMock.mockImplementation((input) => new Promise<Response>((resolve) => {
      holds.push({ search: new URL(String(input), 'http://localhost').searchParams.get('search'), resolve });
    }));
    const { result, rerender } = renderHook(({ search }) => useArchivedOrganizations({ enabled: true, search }), { initialProps: { search: '' } });
    await flush();
    rerender({ search: 'delta' });
    await flush();
    expect(holds.map((h) => h.search)).toEqual([null, 'delta']);

    await act(async () => { holds[1].resolve(jsonResponse({ data: [LIVE, DELTA], archivedTruncated: false })); });
    expect(result.current.archivedOrgs.map((o) => o.id)).toEqual([DELTA.id]);
    await act(async () => { holds[0].resolve(jsonResponse({ data: [LIVE, GAMMA, DELTA], archivedTruncated: false })); });
    expect(result.current.archivedOrgs.map((o) => o.id)).toEqual([DELTA.id]);
    expect(result.current.loading).toBe(false);
  });

  it('surfaces a failed fetch as an error message', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'nope' }, false, 500));
    const { result } = renderHook(() => useArchivedOrganizations({ enabled: true, search: '' }));
    await flush();
    expect(result.current.error).toBe('Failed to load archived organizations');
  });

  it('remove() drops a row locally (after a restore)', async () => {
    mockApi();
    const { result } = renderHook(() => useArchivedOrganizations({ enabled: true, search: '' }));
    await flush();
    act(() => result.current.remove(GAMMA.id));
    expect(result.current.archivedOrgs.map((o) => o.id)).toEqual([DELTA.id]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npx vitest run src/components/organizations/board/useArchivedOrganizations.test.tsx`
Expected: FAIL — `Failed to resolve import "./useArchivedOrganizations"`.

- [ ] **Step 3: Write the hook**

```ts
// apps/web/src/components/organizations/board/useArchivedOrganizations.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { Organization } from '@/components/settings/organizationTypes';
import { fetchWithAuth, handleSessionExpired } from '@/stores/auth';
import { fetchAllOrganizations } from '@/lib/fetchAllOrganizations';

/** Debounce for the search-driven refetch: a full page walk is real network
 *  work, slow enough to still be in flight when the next keystroke fires. */
export const ARCHIVED_SEARCH_DEBOUNCE_MS = 300;

export interface ArchivedOrganizationsApi {
  archivedOrgs: Organization[];
  loading: boolean;
  error?: string;
  /** Mirrors the list endpoint's `archivedTruncated` (archived rows are capped at the page limit, not paginated). */
  truncated: boolean;
  /** True once any fetch has landed — the Archived filter chip shows its count from then on. */
  loaded: boolean;
  /** Drop a row locally (after a restore) without waiting for a refetch. */
  remove: (orgId: string) => void;
}

/**
 * The Archived filter's rows. Fetched ONLY while `enabled` (the filter is
 * active) with `includeArchived=true` — deliberately not threaded through the
 * org store's page walk, which stays on the plain unarchived query every other
 * reader relies on. Walks every page (archived rows ride along on the LAST live
 * page only) and forwards `search` server-side, so an archived org past the
 * truncation cap stays reachable. A monotonic request id makes an older
 * response inert even when it resolves last.
 */
export function useArchivedOrganizations({ enabled, search }: { enabled: boolean; search: string }): ArchivedOrganizationsApi {
  const { t } = useTranslation('organizations');
  const [archivedOrgs, setArchivedOrgs] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [truncated, setTruncated] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const requestIdRef = useRef(0);

  const fetchArchived = useCallback(
    async (term: string) => {
      const requestId = ++requestIdRef.current;
      setLoading(true);
      setError(undefined);
      let wasTruncated = false;
      try {
        const all = await fetchAllOrganizations<Organization>(async (page, limit) => {
          const searchParam = term ? `&search=${encodeURIComponent(term)}` : '';
          const response = await fetchWithAuth(`/orgs/organizations?page=${page}&limit=${limit}&includeArchived=true${searchParam}`);
          if (!response.ok) {
            if (response.status === 401) {
              handleSessionExpired();
              return null;
            }
            throw new Error(t('orgBoard.archived.fetchError'));
          }
          const body = await response.json();
          // Present only on the page that carries the archived block; a page
          // that never looked must not overwrite a `true` from an earlier page.
          if (typeof body?.archivedTruncated === 'boolean') wasTruncated = body.archivedTruncated;
          return body;
        });
        if (requestId !== requestIdRef.current || all === null) return;
        setArchivedOrgs(all.filter((org) => org.archived === true));
        setTruncated(wasTruncated);
        setLoaded(true);
      } catch (err) {
        if (requestId !== requestIdRef.current) return;
        setError(err instanceof Error ? err.message : t('orgBoard.errors.generic'));
      } finally {
        if (requestId === requestIdRef.current) setLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => {
      void fetchArchived(search.trim());
    }, ARCHIVED_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, search, fetchArchived]);

  const remove = useCallback((orgId: string) => setArchivedOrgs((prev) => prev.filter((o) => o.id !== orgId)), []);

  return { archivedOrgs, loading, error, truncated, loaded, remove };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run src/components/organizations/board/useArchivedOrganizations.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/organizations/board/useArchivedOrganizations.ts apps/web/src/components/organizations/board/useArchivedOrganizations.test.tsx
git commit -m "feat(web): useArchivedOrganizations — on-demand archived fetch with server-side search, debounce and race guard (W02 #5723)"
```

---

### Task 8: `ReadinessChips` and `RollupBand`

**Files:**
- Create: `apps/web/src/components/organizations/board/ReadinessChips.tsx`
- Create: `apps/web/src/components/organizations/board/RollupBand.tsx`
- Test: `apps/web/src/components/organizations/board/ReadinessChips.test.tsx`
- Test: `apps/web/src/components/organizations/board/RollupBand.test.tsx`

**Interfaces:**
- Consumes: `BoardRow`, `ReadinessChip`, `BoardFilter` (`@/lib/orgReadiness`), `formatNumber` (`@/lib/i18n/format`), `orgBoard.chips.*`, `orgBoard.repair.*`, `orgBoard.band.*`, `orgBoard.actions.tryAgain`.
- Produces: `ReadinessChips({ row, section: 'setup' | 'account' | 'all', testIdPrefix? })` (default prefix `org-board-chip`; test ids `<prefix>-<chipKey>`, `org-board-chips-pending`, `org-board-chips-unavailable`, `org-board-chips-complete`); `RollupCell { key, count, sub?, subTone?, pressed, onPress }`, `RollupStatus`, `RollupBand({ cells, status, onRetry })` (test ids `org-board-band`, `org-board-band-<key>`, `org-board-band-<key>-count`, `org-board-band-partial`, `org-board-band-retry`).

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/web/src/components/organizations/board/ReadinessChips.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '@/lib/i18n';
import type { BoardRow } from '@/lib/orgReadiness';
import { ReadinessChips } from './ReadinessChips';

const ORG_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const base: BoardRow = {
  org: { id: ORG_ID, name: 'Alpha Ltd', status: 'active', createdAt: '2026-01-01T00:00:00Z' },
  readiness: undefined,
  state: 'ready',
  chips: { setup: [], account: [], accountApplicable: true },
};

describe('ReadinessChips', () => {
  it('renders a skeleton while the row’s batch is pending', () => {
    render(<ReadinessChips row={{ ...base, state: 'pending', chips: null }} section="setup" />);
    expect(screen.getByTestId('org-board-chips-pending')).toBeInTheDocument();
    expect(screen.queryByTestId('org-board-chips-complete')).not.toBeInTheDocument();
  });

  it('renders Unavailable when the row’s batch failed', () => {
    render(<ReadinessChips row={{ ...base, state: 'failed', chips: null }} section="setup" />);
    expect(screen.getByTestId('org-board-chips-unavailable')).toHaveTextContent('Unavailable');
  });

  it('renders a dash when readiness landed without this org (never Complete)', () => {
    render(<ReadinessChips row={{ ...base, chips: null }} section="setup" />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByTestId('org-board-chips-complete')).not.toBeInTheDocument();
  });

  it('renders one quiet Complete check when nothing is missing', () => {
    render(<ReadinessChips row={base} section="setup" />);
    expect(screen.getByTestId('org-board-chips-complete')).toHaveTextContent('Complete');
  });

  it('renders a dash, not Complete, for the Account cell of an org the section does not apply to', () => {
    render(<ReadinessChips row={{ ...base, chips: { setup: [], account: [], accountApplicable: false } }} section="account" />);
    expect(screen.getByTitle('Not applicable')).toHaveTextContent('—');
    expect(screen.queryByTestId('org-board-chips-complete')).not.toBeInTheDocument();
  });

  it('renders each chip as an anchor to its repair link, named with the org', () => {
    const row: BoardRow = {
      ...base,
      chips: {
        setup: [
          { key: 'noSite', tone: 'warning', target: 'sites', href: `/organizations/${ORG_ID}#sites` },
          { key: 'staleCheckIn', tone: 'warning', target: 'devices', href: `/organizations/${ORG_ID}#devices`, count: 9 },
        ],
        account: [{ key: 'overdueInvoices', tone: 'destructive', target: 'billing', href: `/organizations/${ORG_ID}#billing`, count: 2 }],
        accountApplicable: true,
      },
    };
    render(<ReadinessChips row={row} section="all" />);
    const noSite = screen.getByRole('link', { name: 'No site for Alpha Ltd' });
    expect(noSite).toHaveAttribute('href', `/organizations/${ORG_ID}#sites`);
    expect(noSite).toHaveAttribute('title', 'Open the Sites tab for Alpha Ltd');
    expect(noSite).toHaveAttribute('data-testid', 'org-board-chip-noSite');
    expect(screen.getByRole('link', { name: 'No agent check-in for 9 days for Alpha Ltd' })).toBeInTheDocument();
    const overdue = screen.getByRole('link', { name: '2 overdue invoices for Alpha Ltd' });
    expect(overdue.className).toContain('text-destructive');
    expect(noSite.className).toContain('text-warning-strong');
  });

  it('honours a custom test-id prefix (phone cards)', () => {
    const row: BoardRow = { ...base, chips: { setup: [{ key: 'noPolicy', tone: 'warning', target: 'policies', href: '/configuration-policies' }], account: [], accountApplicable: true } };
    render(<ReadinessChips row={row} section="setup" testIdPrefix="org-board-card-chip" />);
    expect(screen.getByTestId('org-board-card-chip-noPolicy')).toHaveAttribute('href', '/configuration-policies');
  });
});
```

```tsx
// apps/web/src/components/organizations/board/RollupBand.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import { RollupBand, type RollupCell } from './RollupBand';

function cells(overrides: Partial<Record<RollupCell['key'], Partial<RollupCell>>> = {}): RollupCell[] {
  const make = (key: RollupCell['key'], count: number | null): RollupCell => ({ key, count, pressed: false, onPress: vi.fn(), ...overrides[key] });
  return [make('all', 12), make('setupIncomplete', 3), make('accountMissing', 5), make('openTickets', 2)];
}

describe('RollupBand', () => {
  it('renders one aria-pressed button per cell with its count and applies the filter on press', () => {
    const onPress = vi.fn();
    render(<RollupBand cells={cells({ setupIncomplete: { pressed: true, onPress } })} status="ready" onRetry={() => undefined} />);
    expect(screen.getByTestId('org-board-band-all-count')).toHaveTextContent('12');
    expect(screen.getByTestId('org-board-band-setupIncomplete')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('org-board-band-all')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: /Setup incomplete/ })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('org-board-band-setupIncomplete'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('shows dashes for counts that have not landed and no partial line while loading', () => {
    render(<RollupBand cells={cells({ setupIncomplete: { count: null }, openTickets: { count: null } })} status="loading" onRetry={() => undefined} />);
    expect(screen.getByTestId('org-board-band-setupIncomplete-count')).toHaveTextContent('—');
    expect(screen.getByTestId('org-board-band-all-count')).toHaveTextContent('12');
    expect(screen.queryByTestId('org-board-band-partial')).not.toBeInTheDocument();
  });

  it('renders sub-lines in the requested tone', () => {
    render(<RollupBand cells={cells({ all: { sub: '2 trial · 1 suspended' }, openTickets: { sub: '1 SLA breached', subTone: 'destructive' } })} status="ready" onRetry={() => undefined} />);
    expect(screen.getByText('2 trial · 1 suspended').className).toContain('text-muted-foreground');
    expect(screen.getByText('1 SLA breached').className).toContain('text-destructive');
  });

  it('says partial with a Try again action when a batch failed', () => {
    const onRetry = vi.fn();
    render(<RollupBand cells={cells()} status="partial" onRetry={onRetry} />);
    expect(screen.getByTestId('org-board-band-partial')).toHaveTextContent('Some organizations could not be checked.');
    fireEvent.click(screen.getByTestId('org-board-band-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npx vitest run src/components/organizations/board/ReadinessChips.test.tsx src/components/organizations/board/RollupBand.test.tsx`
Expected: FAIL — both modules unresolved.

- [ ] **Step 3: Write `ReadinessChips`**

```tsx
// apps/web/src/components/organizations/board/ReadinessChips.tsx
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { BoardRow, ReadinessChip } from '@/lib/orgReadiness';

export type ChipSection = 'setup' | 'account' | 'all';

const TONE_CLASS: Record<ReadinessChip['tone'], string> = {
  warning: 'border-warning/40 bg-warning/10 text-warning-strong hover:bg-warning/20',
  destructive: 'border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/20',
};

export interface ReadinessChipsProps {
  row: BoardRow;
  /** `all` = setup then account, for the phone card's single "Still needed" list. */
  section: ChipSection;
  /** `org-board-chip` on the table, `org-board-card-chip` on the phone cards (both render in jsdom). */
  testIdPrefix?: string;
}

/**
 * Exception-only readiness cell: one anchor per missing thing (each repairs
 * somewhere), a single quiet check when nothing is missing, a dash when the
 * section does not apply or the org was not in the payload, "Unavailable"
 * when the row's batch failed, and a skeleton while the batch is in flight.
 * Chips stop click propagation so the row's open-record hit area never fires
 * on top of a repair link.
 */
export function ReadinessChips({ row, section, testIdPrefix = 'org-board-chip' }: ReadinessChipsProps) {
  const { t } = useTranslation('organizations');
  const orgName = row.org.name;

  if (row.state === 'pending') {
    return (
      <span data-testid="org-board-chips-pending" className="inline-flex items-center gap-1.5" aria-busy="true">
        <span className="skeleton h-5 w-24 rounded-full" aria-hidden="true" />
        <span className="sr-only">{t('orgBoard.band.pending')}</span>
      </span>
    );
  }
  if (row.state === 'failed') {
    return (
      <span data-testid="org-board-chips-unavailable" className="text-xs text-muted-foreground">
        {t('orgBoard.chips.unavailable')}
      </span>
    );
  }
  const chips = row.chips;
  if (!chips) return <span className="text-muted-foreground">—</span>;
  if (section === 'account' && !chips.accountApplicable) {
    return (
      <span className="text-muted-foreground" title={t('orgBoard.chips.notApplicable')}>
        —
      </span>
    );
  }
  const list = section === 'setup' ? chips.setup : section === 'account' ? chips.account : [...chips.setup, ...chips.account];
  if (list.length === 0) {
    return (
      <span data-testid="org-board-chips-complete" className="inline-flex items-center gap-1 text-xs font-medium text-success">
        <Check className="h-3.5 w-3.5" aria-hidden="true" />
        {t('orgBoard.chips.complete')}
      </span>
    );
  }
  return (
    <span className="flex flex-wrap gap-1">
      {list.map((chip) => {
        const label = t(/* i18n-dynamic */ `orgBoard.chips.${chip.key}`, { count: chip.count });
        return (
          <a
            key={chip.key}
            href={chip.href}
            data-testid={`${testIdPrefix}-${chip.key}`}
            aria-label={t('orgBoard.chips.link', { chip: label, orgName })}
            title={t(/* i18n-dynamic */ `orgBoard.repair.${chip.target}`, { orgName })}
            onClick={(event) => event.stopPropagation()}
            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium leading-none transition ${TONE_CLASS[chip.tone]}`}
          >
            {label}
          </a>
        );
      })}
    </span>
  );
}
```

- [ ] **Step 4: Write `RollupBand`**

```tsx
// apps/web/src/components/organizations/board/RollupBand.tsx
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { BoardFilter } from '@/lib/orgReadiness';
import { formatNumber } from '@/lib/i18n/format';

export interface RollupCell {
  key: BoardFilter;
  /** null → dash: the readiness batches have not all landed yet. */
  count: number | null;
  sub?: string | null;
  subTone?: 'muted' | 'destructive';
  pressed: boolean;
  onPress: () => void;
}

export type RollupStatus = 'idle' | 'loading' | 'partial' | 'ready';

export interface RollupBandProps {
  /** Same order and wording as the filter chips (the page builds them from `visibleFilters`). */
  cells: RollupCell[];
  status: RollupStatus;
  onRetry: () => void;
}

/**
 * The roll-up band: one `aria-pressed` button per filter, counts over the LIVE
 * unfiltered list, dashes until every batch has landed, and a "partial" line
 * with Try again when a batch failed. Two per row on a phone, the last cell
 * full width when the count is odd.
 */
export function RollupBand({ cells, status, onRetry }: RollupBandProps) {
  const { t } = useTranslation('organizations');
  const odd = cells.length % 2 === 1;
  return (
    <section aria-label={t('orgBoard.band.label')} data-testid="org-board-band" className="space-y-2">
      <div role="group" aria-label={t('orgBoard.band.label')} className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {cells.map((cell, index) => {
          const last = index === cells.length - 1;
          return (
            <button
              key={cell.key}
              type="button"
              aria-pressed={cell.pressed}
              data-testid={`org-board-band-${cell.key}`}
              onClick={cell.onPress}
              className={`rounded-lg border bg-card p-4 text-left shadow-xs transition hover:border-primary/40 ${
                cell.pressed ? 'border-primary ring-1 ring-primary/40' : ''
              } ${last && odd ? 'col-span-2 md:col-span-1' : ''}`}
            >
              <span className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t(/* i18n-dynamic */ `orgBoard.band.${cell.key}`)}
              </span>
              <span className="mt-1 block text-2xl font-semibold tabular-nums" data-testid={`org-board-band-${cell.key}-count`}>
                {cell.count === null ? '—' : formatNumber(cell.count)}
              </span>
              {cell.sub && (
                <span className={`mt-0.5 block text-xs ${cell.subTone === 'destructive' ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {cell.sub}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {status === 'partial' && (
        <p role="status" data-testid="org-board-band-partial" className="flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
          <span>{t('orgBoard.band.partial')}</span>
          <button type="button" data-testid="org-board-band-retry" onClick={onRetry} className="font-medium text-primary hover:underline">
            {t('orgBoard.actions.tryAgain')}
          </button>
        </p>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run src/components/organizations/board/ReadinessChips.test.tsx src/components/organizations/board/RollupBand.test.tsx src/lib/i18n/keyUsage.test.ts`
Expected: PASS (keyUsage confirms every literal and dynamic-prefix key resolves in `en/organizations.json`).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/organizations/board/ReadinessChips.tsx apps/web/src/components/organizations/board/ReadinessChips.test.tsx apps/web/src/components/organizations/board/RollupBand.tsx apps/web/src/components/organizations/board/RollupBand.test.tsx
git commit -m "feat(web): ReadinessChips (repair-link anchors) and RollupBand (aria-pressed filter cells, partial state) (W02 #5723)"
```

---

### Task 9: `AccountBoardTable` — sortable headers, roving rows, drag handle, row menu, phone cards

**Files:**
- Create: `apps/web/src/components/organizations/board/AccountBoardTable.tsx`
- Test: `apps/web/src/components/organizations/board/AccountBoardTable.test.tsx`

**Interfaces:**
- Consumes: `ResponsiveTable`, `DataCard` (`@/components/shared/ResponsiveTable`), `SortableTh` (`@/components/shared/SortableTh`, `namespace="organizations"`), `ActionMenu`/`ActionMenuItem` (`@/components/shared/ActionMenu`), `ReadinessChips`, `ManualOrderApi`, `statusColors`/`statusLabelKeys`/`FALLBACK_STATUS_CLASS` (`@/lib/orgStatus`), `purgeCountdownDays`/`shouldShowDeviceCount`/`BoardColumn`/`BoardRow`/`BoardSort` (`@/lib/orgReadiness`).
- Produces: `REORDER_HINT_ID = 'org-board-reorder-hint'`, `AccountBoardTableProps`, `AccountBoardTable`. Test ids: `org-board-table`, `org-board-row-<id>`, `org-board-name-<id>`, `org-board-drag-handle`, `org-board-more-<id>`, `org-board-tickets-<id>`, `org-board-workspace-marker`, `org-board-archived-badge`, `org-board-archived-purge`, `org-board-sort-name`, `org-board-sort-tickets`, `org-board-card-<id>`, `org-board-card-name-<id>`, `org-board-card-more-<id>`, chips `org-board-chip-<key>` (table) / `org-board-card-chip-<key>` (cards).

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/organizations/board/AccountBoardTable.test.tsx
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import type { BoardRow } from '@/lib/orgReadiness';
import { AccountBoardTable, type AccountBoardTableProps } from './AccountBoardTable';
import type { ManualOrderApi } from './useManualOrder';

const NOW = new Date('2026-09-13T12:00:00.000Z');
const A_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const B_ID = 'bbbbbbbb-2222-4222-8222-222222222222';

function row(id: string, name: string, extra: Partial<BoardRow> = {}, org: Partial<BoardRow['org']> = {}): BoardRow {
  return {
    org: { id, name, status: 'active', deviceCount: 3, createdAt: '2026-01-01T00:00:00Z', ...org },
    readiness: {
      orgId: id, type: 'customer', status: 'active',
      setup: { sites: 2, devices: 3, lastSeenAt: '2026-09-13T11:00:00.000Z', policyAssigned: true },
      account: { primaryContact: null, billingRoleContact: true, billingAddress: true },
      tickets: { open: 4, awaitingCustomer: 1, slaBreached: 2 },
    },
    state: 'ready',
    chips: { setup: [{ key: 'noSite', tone: 'warning', target: 'sites', href: `/organizations/${id}#sites` }], account: [], accountApplicable: true },
    ...extra,
  };
}

const manualOrder: ManualOrderApi = {
  reorderPending: false, announcement: '', draggedOrgId: null, dragOverOrgId: null,
  onDragStart: vi.fn(), onDragOver: vi.fn(), onDragLeave: vi.fn(), onDrop: vi.fn(), onDragEnd: vi.fn(), move: vi.fn(),
};

function renderTable(overrides: Partial<AccountBoardTableProps> = {}) {
  const props: AccountBoardTableProps = {
    rows: [row(A_ID, 'Alpha Ltd'), row(B_ID, 'Beta Ltd', {}, { status: 'trial' })],
    columns: ['setup', 'account', 'tickets'],
    sort: 'manual',
    onSortChange: vi.fn(),
    activeRowId: A_ID,
    onRowKeyDown: vi.fn(),
    registerRowRef: vi.fn(),
    onOpenRecord: vi.fn(),
    highlightedOrgId: null,
    workspaceOrgId: B_ID,
    manualOrder,
    menuItemsFor: (r) => [{ id: 'open', label: `Open ${r.org.name}`, href: `/organizations/${r.org.id}` }],
    archivedView: false,
    now: NOW,
    ...overrides,
  };
  render(<AccountBoardTable {...props} />);
  return props;
}
const desktop = () => within(screen.getByTestId('responsive-table-desktop'));
const cards = () => within(screen.getByTestId('responsive-table-cards'));

describe('AccountBoardTable', () => {
  it('renders the columns it is given, with sortable Organization and Open tickets headers', () => {
    renderTable({ sort: 'tickets' });
    const headers = desktop().getAllByRole('columnheader').map((th) => th.textContent?.trim());
    expect(headers).toEqual(['Manual order', 'Organization', 'Setup', 'Account data', 'Open tickets', 'Row actions']);
    expect(desktop().getByTestId('org-board-sort-tickets').closest('th')).toHaveAttribute('aria-sort', 'descending');
    expect(desktop().getByTestId('org-board-sort-name').closest('th')).toHaveAttribute('aria-sort', 'none');
  });

  it('hides a column that is not in `columns` (lens or capability trimmed)', () => {
    renderTable({ columns: ['setup'] });
    const headers = desktop().getAllByRole('columnheader').map((th) => th.textContent?.trim());
    expect(headers).toEqual(['Manual order', 'Organization', 'Setup', 'Row actions']);
    expect(desktop().queryByTestId(`org-board-tickets-${A_ID}`)).not.toBeInTheDocument();
  });

  it('clicking a sortable header asks for that sort', () => {
    const { onSortChange } = renderTable();
    fireEvent.click(desktop().getByTestId('org-board-sort-name'));
    expect(onSortChange).toHaveBeenCalledWith('name');
    fireEvent.click(desktop().getByTestId('org-board-sort-tickets'));
    expect(onSortChange).toHaveBeenCalledWith('tickets');
  });

  it('the name link is the roving tab stop and every other control on the row follows it', () => {
    renderTable();
    const rowA = desktop().getByTestId(`org-board-row-${A_ID}`);
    const rowB = desktop().getByTestId(`org-board-row-${B_ID}`);
    expect(within(rowA).getByTestId(`org-board-name-${A_ID}`)).toHaveAttribute('tabindex', '0');
    expect(within(rowA).getByTestId('org-board-drag-handle')).toHaveAttribute('tabindex', '0');
    expect(within(rowA).getByTestId(`org-board-more-${A_ID}`)).toHaveAttribute('tabindex', '0');
    expect(within(rowB).getByTestId(`org-board-name-${B_ID}`)).toHaveAttribute('tabindex', '-1');
    expect(within(rowB).getByTestId('org-board-drag-handle')).toHaveAttribute('tabindex', '-1');
    expect(within(rowB).getByTestId(`org-board-more-${B_ID}`)).toHaveAttribute('tabindex', '-1');
    expect(within(rowA).getByTestId(`org-board-name-${A_ID}`)).not.toHaveAttribute('aria-current');
  });

  it('forwards row key presses with the row index, and ArrowDown on the handle moves the org', () => {
    const { onRowKeyDown } = renderTable();
    fireEvent.keyDown(desktop().getByTestId(`org-board-name-${B_ID}`), { key: 'ArrowUp' });
    expect(onRowKeyDown).toHaveBeenCalledWith(expect.anything(), 1);
    fireEvent.keyDown(within(desktop().getByTestId(`org-board-row-${A_ID}`)).getByTestId('org-board-drag-handle'), { key: 'ArrowDown' });
    expect(manualOrder.move).toHaveBeenCalledWith(expect.objectContaining({ id: A_ID }), 1);
  });

  it('shows no handle without manual order', () => {
    renderTable({ manualOrder: null });
    expect(desktop().queryByTestId('org-board-drag-handle')).not.toBeInTheDocument();
  });

  it('a handle in flight is marked busy and the row is not draggable', () => {
    renderTable({ manualOrder: { ...manualOrder, reorderPending: true } });
    const rowA = desktop().getByTestId(`org-board-row-${A_ID}`);
    expect(within(rowA).getByTestId('org-board-drag-handle')).toHaveAttribute('aria-busy', 'true');
    expect(rowA).toHaveAttribute('draggable', 'false');
  });

  it('row click opens the record; chip and menu clicks do not', () => {
    const { onOpenRecord } = renderTable();
    fireEvent.click(desktop().getByTestId(`org-board-row-${A_ID}`));
    expect(onOpenRecord).toHaveBeenCalledWith(expect.objectContaining({ id: A_ID }));
    fireEvent.click(desktop().getByTestId('org-board-chip-noSite'));
    fireEvent.click(desktop().getByTestId(`org-board-more-${B_ID}`));
    expect(onOpenRecord).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('menuitem', { name: 'Open Beta Ltd' })).toHaveAttribute('href', `/organizations/${B_ID}`);
  });

  it('renders the meta line: exception-only status pill, workspace marker, device and site counts', () => {
    renderTable();
    const rowA = desktop().getByTestId(`org-board-row-${A_ID}`);
    const rowB = desktop().getByTestId(`org-board-row-${B_ID}`);
    expect(within(rowA).queryByText('Active')).not.toBeInTheDocument();
    expect(within(rowB).getByText('Trial')).toBeInTheDocument();
    expect(within(rowB).getByTestId('org-board-workspace-marker')).toHaveTextContent('Workspace');
    expect(within(rowA).queryByTestId('org-board-workspace-marker')).not.toBeInTheDocument();
    expect(within(rowA).getByText('3 devices')).toBeInTheDocument();
    expect(within(rowA).getByText('2 sites')).toBeInTheDocument();
  });

  it('renders the ticket cell with awaiting and SLA lines', () => {
    renderTable();
    const cell = desktop().getByTestId(`org-board-tickets-${A_ID}`);
    expect(cell).toHaveTextContent('4 open');
    expect(cell).toHaveTextContent('1 awaiting customer');
    expect(within(cell).getByText('2 SLA breached').className).toContain('text-destructive');
  });

  it('marks the highlighted row', () => {
    renderTable({ highlightedOrgId: B_ID });
    expect(desktop().getByTestId(`org-board-row-${B_ID}`)).toHaveAttribute('data-highlighted', 'true');
    expect(desktop().getByTestId(`org-board-row-${A_ID}`)).not.toHaveAttribute('data-highlighted');
  });

  it('archived view: muted rows with badge and purge countdown, no readiness cells, no handle', () => {
    renderTable({
      archivedView: true,
      manualOrder: null,
      rows: [
        row(A_ID, 'Gamma LLC', { readiness: undefined, chips: null }, { status: 'archived', archived: true, purgeAt: '2026-10-13T00:00:00.000Z' }),
        row(B_ID, 'Epsilon Corp', { readiness: undefined, chips: null }, { status: 'offboarding', archived: true, offboardingTarget: 'archive', purgeAt: null }),
      ],
    });
    const gamma = desktop().getByTestId(`org-board-row-${A_ID}`);
    expect(within(gamma).getByTestId('org-board-archived-badge')).toHaveTextContent('Archived');
    expect(within(gamma).getByTestId('org-board-archived-purge')).toHaveTextContent('Purges in 30 days');
    const epsilon = desktop().getByTestId(`org-board-row-${B_ID}`);
    expect(within(epsilon).getByTestId('org-board-archived-badge')).toHaveTextContent('Archiving…');
    expect(within(epsilon).getByTestId('org-board-archived-purge')).toHaveTextContent('Kept indefinitely');
    expect(desktop().queryByRole('columnheader', { name: 'Setup' })).not.toBeInTheDocument();
    expect(desktop().queryByTestId('org-board-drag-handle')).not.toBeInTheDocument();
  });

  it('phone cards carry the same rows with a single "Still needed" list and their own test ids', () => {
    renderTable();
    const cardA = cards().getByTestId(`org-board-card-${A_ID}`);
    expect(within(cardA).getByTestId(`org-board-card-name-${A_ID}`)).toHaveAttribute('href', `/organizations/${A_ID}`);
    expect(within(cardA).getByText('Still needed')).toBeInTheDocument();
    expect(within(cardA).getByTestId('org-board-card-chip-noSite')).toBeInTheDocument();
    expect(within(cardA).getByTestId(`org-board-card-more-${A_ID}`)).toBeInTheDocument();
    expect(within(cardA).getByText('4 open')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/organizations/board/AccountBoardTable.test.tsx`
Expected: FAIL — module unresolved.

- [ ] **Step 3: Write the table**

```tsx
// apps/web/src/components/organizations/board/AccountBoardTable.tsx
import type { KeyboardEvent, ReactNode } from 'react';
import { GripVertical } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { ActionMenu, type ActionMenuItem } from '@/components/shared/ActionMenu';
import { DataCard, ResponsiveTable } from '@/components/shared/ResponsiveTable';
import { SortableTh } from '@/components/shared/SortableTh';
import { FALLBACK_STATUS_CLASS, statusColors, statusLabelKeys } from '@/lib/orgStatus';
import { purgeCountdownDays, shouldShowDeviceCount, type BoardColumn, type BoardRow, type BoardSort } from '@/lib/orgReadiness';
import type { Organization } from '@/components/settings/organizationTypes';
import type { Organization as StoreOrganization } from '@/stores/orgStore';
import { ReadinessChips } from './ReadinessChips';
import type { ManualOrderApi } from './useManualOrder';

/** `aria-describedby` target for every reorder handle: the page renders one hidden sentence with this id. */
export const REORDER_HINT_ID = 'org-board-reorder-hint';

export interface AccountBoardTableProps {
  rows: BoardRow[];
  /** Capability- and lens-trimmed, in render order (`visibleColumns`). */
  columns: BoardColumn[];
  sort: BoardSort;
  onSortChange: (sort: BoardSort) => void;
  /** Roving tabindex: the one row whose name link, handle and menu trigger are in the Tab order. */
  activeRowId: string | null;
  onRowKeyDown: (event: KeyboardEvent<HTMLAnchorElement>, index: number) => void;
  registerRowRef: (orgId: string, el: HTMLAnchorElement | null) => void;
  onOpenRecord: (org: Organization) => void;
  highlightedOrgId: string | null;
  workspaceOrgId: string | null;
  /** Present only while manual order applies (manual sort, no search, All filter). */
  manualOrder: ManualOrderApi | null;
  menuItemsFor: (row: BoardRow) => ActionMenuItem[];
  /** Archived filter: muted rows, badge + purge countdown, no readiness cells. */
  archivedView: boolean;
  now: Date;
}

const ROW_MENU_TRIGGER_CLASS =
  'inline-flex h-8 w-8 items-center justify-center rounded-md border bg-background text-sm transition hover:bg-muted';

export function AccountBoardTable({
  rows,
  columns,
  sort,
  onSortChange,
  activeRowId,
  onRowKeyDown,
  registerRowRef,
  onOpenRecord,
  highlightedOrgId,
  workspaceOrgId,
  manualOrder,
  menuItemsFor,
  archivedView,
  now,
}: AccountBoardTableProps) {
  const { t } = useTranslation('organizations');
  const { t: tSettings } = useTranslation('settings');
  const showSetup = !archivedView && columns.includes('setup');
  const showAccount = !archivedView && columns.includes('account');
  const showTickets = !archivedView && columns.includes('tickets');
  const dragEnabled = manualOrder !== null && !manualOrder.reorderPending;
  const rowTabIndex = (org: Organization) => (activeRowId === org.id ? 0 : -1);

  const statusPill = (org: Organization) => {
    const key = org.status as StoreOrganization['status'];
    const label = statusLabelKeys[key] ? tSettings(/* i18n-dynamic */ statusLabelKeys[key]) : org.status;
    return (
      <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 font-medium leading-none ${statusColors[key] ?? FALLBACK_STATUS_CLASS}`}>
        {label}
      </span>
    );
  };

  const purgeLine = (org: Organization) => {
    const days = purgeCountdownDays(org.purgeAt, now);
    if (days === null) return t('orgBoard.meta.keptIndefinitely');
    if (days <= 0) return t('orgBoard.meta.purgeToday');
    return t('orgBoard.meta.purgeCountdown', { count: days });
  };

  // Only the TABLE row registers the roving ref: both surfaces render in the
  // DOM (the cards are `sm:hidden`), and the last registration would win.
  const renderName = (row: BoardRow, index: number, surface: 'table' | 'card') => (
    <a
      ref={surface === 'table' ? (el) => registerRowRef(row.org.id, el) : undefined}
      href={`/organizations/${row.org.id}`}
      data-testid={surface === 'table' ? `org-board-name-${row.org.id}` : `org-board-card-name-${row.org.id}`}
      tabIndex={rowTabIndex(row.org)}
      title={row.org.name}
      onKeyDown={(event) => onRowKeyDown(event, index)}
      onClick={(event) => event.stopPropagation()}
      className="block max-w-xs truncate text-sm font-medium hover:underline"
    >
      {row.org.name}
    </a>
  );

  const renderMeta = (row: BoardRow) => {
    const org = row.org;
    const sites = row.readiness?.setup.sites;
    return (
      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {archivedView ? (
          <>
            <span
              data-testid="org-board-archived-badge"
              className={`inline-flex items-center rounded-full border px-1.5 py-0.5 font-medium leading-none ${
                org.status === 'offboarding' ? statusColors.offboarding : statusColors.archived
              }`}
            >
              {org.status === 'offboarding' ? t('orgBoard.meta.archivingBadge') : t('orgBoard.meta.archivedBadge')}
            </span>
            <span data-testid="org-board-archived-purge">{purgeLine(org)}</span>
          </>
        ) : (
          <>
            {/* Exception-only: `active` is the steady state the other pills are exceptions to. */}
            {org.status !== 'active' && statusPill(org)}
            {/* Marker only, never a pin: at most one row carries it, so it reads as a landmark. */}
            {workspaceOrgId === org.id && (
              <span
                data-testid="org-board-workspace-marker"
                className="inline-flex items-center rounded-full border border-primary/30 bg-primary/5 px-1.5 py-0.5 font-medium leading-none text-primary"
              >
                {t('orgBoard.meta.workspace')}
              </span>
            )}
            {shouldShowDeviceCount(org.deviceCount) && <span>{t('orgBoard.meta.devices', { count: org.deviceCount })}</span>}
            {typeof sites === 'number' && <span>{t('orgBoard.meta.sites', { count: sites })}</span>}
          </>
        )}
      </span>
    );
  };

  const renderTickets = (row: BoardRow): ReactNode => {
    if (row.state === 'pending') return <span className="skeleton inline-block h-4 w-10" aria-hidden="true" />;
    if (row.state === 'failed') return <span className="text-xs text-muted-foreground">{t('orgBoard.chips.unavailable')}</span>;
    const tickets = row.readiness?.tickets;
    if (!tickets) return <span className="text-muted-foreground">—</span>;
    return (
      <span className="block" data-testid={`org-board-tickets-${row.org.id}`}>
        <span className={`text-sm tabular-nums ${tickets.open === 0 ? 'text-muted-foreground' : 'font-medium'}`}>
          {t('orgBoard.tickets.open', { count: tickets.open })}
        </span>
        {(tickets.awaitingCustomer > 0 || tickets.slaBreached > 0) && (
          <span className="mt-0.5 flex flex-wrap gap-x-2 text-xs">
            {tickets.awaitingCustomer > 0 && (
              <span className="text-muted-foreground">{t('orgBoard.tickets.awaiting', { count: tickets.awaitingCustomer })}</span>
            )}
            {tickets.slaBreached > 0 && <span className="text-destructive">{t('orgBoard.tickets.sla', { count: tickets.slaBreached })}</span>}
          </span>
        )}
      </span>
    );
  };

  const renderMenu = (row: BoardRow, surface: 'table' | 'card') => (
    <span onClick={(event) => event.stopPropagation()}>
      <ActionMenu
        label={t('orgBoard.rowMenu.label', { name: row.org.name })}
        testId={surface === 'table' ? `org-board-more-${row.org.id}` : `org-board-card-more-${row.org.id}`}
        items={menuItemsFor(row)}
        triggerClassName={ROW_MENU_TRIGGER_CLASS}
        triggerTabIndex={rowTabIndex(row.org)}
      />
    </span>
  );

  // Shown whenever manual order applies; DRAGGING is enabled only while no
  // reorder is in flight. Tying the handle's presence to the in-flight flag
  // unmounted the focused handle on every keyboard move (review of #5708).
  const renderHandle = (row: BoardRow) =>
    manualOrder && (
      <button
        type="button"
        data-testid="org-board-drag-handle"
        aria-label={t('orgBoard.reorder.handle', { name: row.org.name })}
        aria-describedby={REORDER_HINT_ID}
        aria-busy={manualOrder.reorderPending || undefined}
        title={t('orgBoard.reorder.dragToReorder')}
        tabIndex={rowTabIndex(row.org)}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault();
          manualOrder.move(row.org, event.key === 'ArrowUp' ? -1 : 1);
        }}
        className="cursor-grab rounded p-0.5 text-muted-foreground/40 transition group-hover:text-muted-foreground group-focus-within:text-muted-foreground active:cursor-grabbing"
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    );

  const table = (
    <table className="w-full min-w-[1040px] text-sm" data-testid="org-board-table">
      <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
        <tr>
          {manualOrder && (
            <th className="w-8 px-2 py-3">
              <span className="sr-only">{t('orgBoard.sort.manual')}</span>
            </th>
          )}
          <SortableTh
            namespace="organizations"
            label={t('orgBoard.columns.organization')}
            sortKey="name"
            activeSort={sort === 'name' ? 'name' : null}
            direction="asc"
            onSort={() => onSortChange('name')}
            testId="org-board-sort-name"
          />
          {showSetup && <th className="px-3 py-3 font-medium">{t('orgBoard.columns.setup')}</th>}
          {showAccount && <th className="px-3 py-3 font-medium">{t('orgBoard.columns.account')}</th>}
          {showTickets && (
            <SortableTh
              namespace="organizations"
              label={t('orgBoard.columns.tickets')}
              sortKey="tickets"
              activeSort={sort === 'tickets' ? 'tickets' : null}
              direction="desc"
              onSort={() => onSortChange('tickets')}
              testId="org-board-sort-tickets"
            />
          )}
          <th className="w-12 px-2 py-3">
            <span className="sr-only">{t('orgBoard.columns.actions')}</span>
          </th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {rows.map((row, index) => {
          const org = row.org;
          const isDragging = manualOrder !== null && manualOrder.draggedOrgId === org.id;
          const isDropTarget = manualOrder !== null && manualOrder.dragOverOrgId === org.id && manualOrder.draggedOrgId !== org.id;
          const highlighted = highlightedOrgId === org.id;
          return (
            /* The <tr> is a whole-row hit area for the mouse; the name link is
               the keyboard and assistive-tech route to the same record. */
            <tr
              key={org.id}
              data-testid={`org-board-row-${org.id}`}
              data-highlighted={highlighted || undefined}
              onClick={() => onOpenRecord(org)}
              draggable={dragEnabled}
              onDragStart={manualOrder && dragEnabled ? (event) => manualOrder.onDragStart(event, org) : undefined}
              onDragOver={manualOrder && dragEnabled ? (event) => manualOrder.onDragOver(event, org) : undefined}
              onDragLeave={manualOrder && dragEnabled ? manualOrder.onDragLeave : undefined}
              onDrop={manualOrder && dragEnabled ? (event) => manualOrder.onDrop(event, org) : undefined}
              onDragEnd={manualOrder && dragEnabled ? manualOrder.onDragEnd : undefined}
              className={`group cursor-pointer align-top transition hover:bg-muted/50 ${archivedView ? 'opacity-70' : ''} ${
                isDragging ? 'opacity-50' : ''
              } ${isDropTarget ? 'border-t-2 border-t-primary' : ''} ${highlighted ? 'bg-primary/5 ring-1 ring-inset ring-primary/40' : ''}`}
            >
              {manualOrder && <td className="px-2 py-3">{renderHandle(row)}</td>}
              <td className="px-3 py-3">
                <div className="min-w-0">
                  {renderName(row, index, 'table')}
                  {renderMeta(row)}
                </div>
              </td>
              {showSetup && (
                <td className="px-3 py-3">
                  <ReadinessChips row={row} section="setup" />
                </td>
              )}
              {showAccount && (
                <td className="px-3 py-3">
                  <ReadinessChips row={row} section="account" />
                </td>
              )}
              {showTickets && <td className="px-3 py-3">{renderTickets(row)}</td>}
              <td className="px-2 py-3 text-right">{renderMenu(row, 'table')}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  const cards = rows.map((row, index) => {
    const org = row.org;
    return (
      <DataCard
        key={org.id}
        onClick={() => onOpenRecord(org)}
        className={`${archivedView ? 'opacity-70' : ''} ${highlightedOrgId === org.id ? 'ring-1 ring-primary/40' : ''}`}
      >
        <div data-testid={`org-board-card-${org.id}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              {renderName(row, index, 'card')}
              {renderMeta(row)}
            </div>
            {renderMenu(row, 'card')}
          </div>
          {(showSetup || showAccount) && (
            <div className="mt-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('orgBoard.chips.stillNeeded')}</p>
              <div className="mt-1">
                <ReadinessChips
                  row={row}
                  section={showSetup && showAccount ? 'all' : showSetup ? 'setup' : 'account'}
                  testIdPrefix="org-board-card-chip"
                />
              </div>
            </div>
          )}
          {showTickets && (
            <div className="mt-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('orgBoard.columns.tickets')}</p>
              <div className="mt-1">{renderTickets(row)}</div>
            </div>
          )}
        </div>
      </DataCard>
    );
  });

  return <ResponsiveTable table={table} cards={cards} />;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/organizations/board/AccountBoardTable.test.tsx src/lib/__tests__/no-clipped-tables.test.ts`
Expected: PASS. (The `min-w-[1040px]` table sits inside `ResponsiveTable`'s `overflow-x-auto` wrapper, which is exactly what `no-clipped-tables` sanctions; the page itself never scrolls sideways.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/organizations/board/AccountBoardTable.tsx apps/web/src/components/organizations/board/AccountBoardTable.test.tsx
git commit -m "feat(web): AccountBoardTable — responsive table with sortable headers, roving rows, drag handle, row menu and phone cards (W02 #5723)"
```

---

### Task 10: `OrganizationsBoardPage` — the island, the shared test kit, and the render tests

**Files:**
- Create: `apps/web/src/components/organizations/board/OrganizationsBoardPage.tsx`
- Create: `apps/web/src/components/organizations/board/boardTestKit.ts`
- Test: `apps/web/src/components/organizations/board/OrganizationsBoardPage.render.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 1–9; `OrganizationForm`, `MergeOrgModal`, `ArchiveOrgModal` (`@/components/settings/*`), `BulkOrgImport`, `Dialog`, `showToast`, `useOrgStore` (`currentOrgId`, `serviceManagementMode`, `getState().fetchOrganizations`), `useJwtClaims`, `usePermissions`, `runAction`/`ActionError`/`handleActionError`, `navigateTo`, `applyOrgSwitch`, `useHashState`, `fetchAllOrganizations`, `formatNumber`, `statusLabelKeys`, `orgRecord.actions.workHereToast`.
- Produces: default export `OrganizationsBoardPage`, `ORG_LIST_SORT_STORAGE_KEY = 'breeze.orgList.sort'`, `ORG_BOARD_LENS_STORAGE_KEY = 'breeze.orgBoard.lens'`, `ROW_HIGHLIGHT_MS = 2000`, `RESTORE_PURGING_ERROR_TEXT`. Page test ids: `org-board`, `org-board-heading`, `org-board-add`, `bulk-org-import-toggle`, `org-board-search`, `org-board-filter-<key>`, `org-board-filter-<key>-count`, `org-board-lens-<key>`, `org-board-sort`, `org-board-skeleton`, `org-board-empty`, `org-board-no-matches`, `org-board-clear-filters`, `org-board-footer`, `org-board-reorder-announcement`, `org-board-archived-truncated-note`, `org-board-archived-empty`, `org-board-error`. Row-menu item test ids: `org-board-menu-open-record`, `org-board-menu-contact`, `org-board-menu-new-ticket`, `org-board-menu-work-here`, `org-board-menu-settings`, `org-board-menu-archive`, `org-board-menu-merge`, `org-board-menu-restore`.
- Kit: `ALL_CAPS`, `ALPHA`, `BETA`, `GAMMA`, `ARCHIVED_ORG`, `DRAINING_ORG`, `NEW_ORG_ID`, `readinessFor(org, overrides)`, `jsonResponse`, `mockBoardApi(fetchMock, options)`, `flush(ms)`, `renderedRowIds()`.

- [ ] **Step 1: Write the test kit**

```ts
// apps/web/src/components/organizations/board/boardTestKit.ts
/**
 * Fixtures and the fetch router shared by every OrganizationsBoardPage test.
 * Not a test file itself (no `.test.` suffix), so vitest never runs it; it
 * carries no `t()` calls and no hash reads, so the contract scans ignore it.
 * Each test file still declares its own `vi.mock(...)` block (vi.mock is
 * hoisted per file and cannot be shared).
 */
import { act } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import type { Organization } from '@/components/settings/organizationTypes';
import type { AccountReadinessResponse, ReadinessCapabilities, ReadinessOrg } from '@/lib/orgReadiness';

export const ALL_CAPS: ReadinessCapabilities = {
  sites: true, devices: true, policies: true, contacts: true, portalUsers: true, invoices: true, tickets: true, integrations: false,
};

export const ALPHA: Organization = { id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'Alpha Ltd', status: 'active', type: 'customer', deviceCount: 3, createdAt: '2026-01-01T00:00:00Z' };
export const BETA: Organization = { id: 'bbbbbbbb-2222-4222-8222-222222222222', name: 'Beta Ltd', status: 'trial', type: 'customer', deviceCount: 5, createdAt: '2026-01-02T00:00:00Z' };
export const GAMMA: Organization = { id: 'cccccccc-3333-4333-8333-333333333333', name: 'Gamma Internal', status: 'active', type: 'internal', deviceCount: 0, createdAt: '2026-01-03T00:00:00Z' };
export const ARCHIVED_ORG: Organization = { id: 'dddddddd-4444-4444-8444-444444444444', name: 'Delta Archived', status: 'archived', deviceCount: 0, createdAt: '2026-01-04T00:00:00Z', archived: true, purgeAt: '2026-10-13T00:00:00.000Z' };
/** #4166 — mid-archive drain: read-only through the archived door, still uninstalling agents. */
export const DRAINING_ORG: Organization = { id: 'eeeeeeee-5555-4555-8555-555555555555', name: 'Epsilon Draining', status: 'offboarding', offboardingTarget: 'archive', deviceCount: 2, createdAt: '2026-01-05T00:00:00Z', archived: true, purgeAt: null };
export const NEW_ORG_ID = 'ffffffff-6666-4666-8666-666666666666';

export type ReadinessOverrides = Partial<Omit<ReadinessOrg, 'setup' | 'account' | 'orgId'>> & {
  setup?: Partial<ReadinessOrg['setup']>;
  account?: Partial<ReadinessOrg['account']>;
};

/** A complete readiness row for `org` (every check satisfied); tests remove things from it. */
export function readinessFor(org: Organization, overrides: ReadinessOverrides = {}): ReadinessOrg {
  const { setup, account, ...rest } = overrides;
  return {
    orgId: org.id,
    type: org.type ?? 'customer',
    status: org.status,
    tickets: { open: 0, awaitingCustomer: 0, slaBreached: 0 },
    ...rest,
    setup: { sites: 1, devices: org.deviceCount ?? 0, lastSeenAt: '2026-09-13T11:00:00.000Z', policyAssigned: true, ...setup },
    account: {
      primaryContact: { name: 'Jane Doe', email: 'jane@alpha.test', phone: '+1 555 0100', mobile: null },
      billingRoleContact: true,
      billingAddress: true,
      pendingInvitations: 0,
      overdueInvoices: 0,
      ...account,
    },
  };
}

export const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

export interface BoardApiOptions {
  orgs?: Organization[];
  /** Readiness rows by org id; ids not listed get `readinessFor(org)` (complete). */
  readiness?: Record<string, ReadinessOrg>;
  capabilities?: ReadinessCapabilities;
  mode?: 'native' | 'external' | 'off';
  archivedOrgs?: Organization[];
  archivedTruncated?: boolean;
  /** Return a Response (or a promise of one) to override a readiness batch; undefined → default body. `call` is 1-based. */
  onReadiness?: (ids: string[], call: number) => Response | Promise<Response> | undefined;
  onOrder?: (call: number) => Response | Promise<Response>;
  onRestore?: () => { body: unknown; status?: number };
  onArchive?: () => unknown;
  onMergePoll?: () => unknown;
}

export interface BoardApi {
  /** What the list GET returns; mutate to model a server whose order or membership changed. */
  state: { orgs: Organization[] };
  readinessCalls: string[][];
}

/** Routes every fetch the page and its modals issue. The archived branch applies
 *  the API's server-side `search` so tests can prove the param narrows results. */
export function mockBoardApi(fetchMock: Mock, opts: BoardApiOptions = {}): BoardApi {
  const state = { orgs: [...(opts.orgs ?? [ALPHA, BETA, GAMMA])] };
  const readinessCalls: string[][] = [];
  let orderCalls = 0;
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method;

    if (url.startsWith('/orgs/account-readiness?')) {
      const ids = new URL(url, 'http://localhost').searchParams.get('orgIds')!.split(',');
      readinessCalls.push(ids);
      const override = opts.onReadiness?.(ids, readinessCalls.length);
      if (override) return override;
      const known = [...state.orgs, ...(opts.archivedOrgs ?? [])];
      const body: AccountReadinessResponse = {
        partnerId: 'partner-1',
        capabilities: opts.capabilities ?? ALL_CAPS,
        serviceManagementMode: opts.mode ?? 'native',
        orgs: ids.flatMap((id) => {
          const org = known.find((o) => o.id === id);
          return org ? [opts.readiness?.[id] ?? readinessFor(org)] : [];
        }),
      };
      return jsonResponse(body);
    }
    if (url.includes('includeArchived=true')) {
      const search = new URL(url, 'http://localhost').searchParams.get('search')?.toLowerCase();
      const archived = (opts.archivedOrgs ?? []).filter((org) => (search ? org.name.toLowerCase().includes(search) : true));
      return jsonResponse({
        data: [...state.orgs, ...archived],
        pagination: { page: 1, limit: 100, total: state.orgs.length },
        archivedTruncated: opts.archivedTruncated ?? false,
      });
    }
    if (url.startsWith('/orgs/organizations?') && !method) {
      return jsonResponse({ data: state.orgs, pagination: { page: 1, limit: 100, total: state.orgs.length } });
    }
    if (url === '/orgs/organizations/order' && method === 'PATCH') {
      orderCalls += 1;
      return opts.onOrder ? opts.onOrder(orderCalls) : jsonResponse({ ok: true });
    }
    if (url === '/orgs/organizations' && method === 'POST') {
      const values = JSON.parse(String(init?.body)) as { name: string; status: Organization['status'] };
      state.orgs = [...state.orgs, { id: NEW_ORG_ID, name: values.name, status: values.status, type: 'customer', deviceCount: 0, createdAt: '2026-09-13T12:00:00Z' }];
      return jsonResponse({ id: NEW_ORG_ID, name: values.name });
    }
    if (method === 'POST' && /\/organizations\/[^/]+\/restore$/.test(url)) {
      const result = opts.onRestore?.() ?? { body: { status: 'active', recreateRequired: [] } };
      const status = result.status ?? 200;
      return jsonResponse(result.body, status < 400, status);
    }
    if (method === 'POST' && /\/organizations\/[^/]+\/archive$/.test(url)) {
      return jsonResponse(opts.onArchive?.() ?? { status: 'offboarding', purgeAt: '2026-11-24T00:00:00.000Z' }, true, 202);
    }
    if (method === 'POST' && url.endsWith('/merge-preview')) {
      return jsonResponse({ tables: [{ table: 'devices', policy: 'repoint-dedupe', loserRows: 4, wouldDrop: 0 }], totalMovableRows: 4, verdict: 'ok', warnings: [] });
    }
    if (method === 'POST' && /\/organizations\/[^/]+\/merge$/.test(url)) return jsonResponse({ jobId: 'job-1' }, true, 202);
    if (url.includes('/merge-runs/')) {
      return jsonResponse(opts.onMergePoll?.() ?? { state: 'completed', result: { tables: { devices: { moved: 4, dropped: 0 } }, warnings: [], mergeEventId: 'evt-1' } });
    }
    return jsonResponse({ data: [] });
  });
  return { state, readinessCalls };
}

/** Advance fake timers inside act; default 0 settles a resolved mock fetch's microtask chain. */
export async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Rendered order of the DESKTOP table's rows, top to bottom (the phone cards also render in jsdom). */
export const renderedRowIds = (): string[] =>
  Array.from(document.querySelectorAll('[data-testid="responsive-table-desktop"] [data-testid^="org-board-row-"]')).map((el) =>
    (el.getAttribute('data-testid') ?? '').replace('org-board-row-', ''),
  );
```

- [ ] **Step 2: Write the failing render tests**

Every page test file starts with this mock block (copy it verbatim into each of the five `OrganizationsBoardPage.*.test.tsx` files; `vi.mock` is hoisted per file and cannot live in the kit):

```tsx
vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn(), handleSessionExpired: vi.fn() }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));
const navigateTo = vi.hoisted(() => vi.fn());
vi.mock('@/lib/navigation', () => ({ navigateTo }));
const applyOrgSwitchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orgSwitch', () => ({ applyOrgSwitch: applyOrgSwitchMock }));
// The workspace (OrgSwitcher) selection and the partner's Service Management
// mode, read through store selectors; mutate per test before rendering.
const store = vi.hoisted(() => ({
  currentOrgId: null as string | null,
  organizations: [] as Array<{ id: string; name: string }>,
  serviceManagementMode: 'native' as 'native' | 'external' | 'off',
  fetchOrganizations: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: Object.assign((selector?: (s: typeof store) => unknown) => (selector ? selector(store) : undefined), {
    getState: () => store,
  }),
}));
// Partner-scope gating (merge) and the tickets:write gate (New ticket).
const auth = vi.hoisted(() => ({
  scope: 'partner' as 'system' | 'partner' | 'organization' | null,
  permissions: [{ resource: '*', action: '*' }] as Array<{ resource: string; action: string }>,
}));
vi.mock('@/lib/authScope', () => ({
  useJwtClaims: () => ({ status: 'resolved' as const, claims: { scope: auth.scope, orgId: null, partnerId: 'partner-1' } }),
  getJwtClaims: () => ({ scope: auth.scope, orgId: null, partnerId: 'partner-1' }),
}));
vi.mock('@/lib/permissions', () => ({
  hasPermission: () => true,
  usePermissions: () => ({
    permissions: auth.permissions,
    can: (resource: string, action: string) =>
      auth.permissions.some((p) => (p.resource === resource || p.resource === '*') && (p.action === action || p.action === '*')),
  }),
}));
```

```tsx
// apps/web/src/components/organizations/board/OrganizationsBoardPage.render.test.tsx
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OrganizationsBoardPage, { ORG_BOARD_LENS_STORAGE_KEY, ORG_LIST_SORT_STORAGE_KEY, ROW_HIGHLIGHT_MS } from './OrganizationsBoardPage';
import { fetchWithAuth } from '@/stores/auth';
import { ALL_CAPS, ALPHA, BETA, GAMMA, flush, jsonResponse, mockBoardApi, readinessFor, renderedRowIds } from './boardTestKit';

// … the mock block from Step 2, verbatim …

const fetchMock = vi.mocked(fetchWithAuth);
const desktop = () => within(screen.getByTestId('responsive-table-desktop'));
const row = (id: string) => within(desktop().getByTestId(`org-board-row-${id}`));

/** ALPHA has no site; BETA (trial) lacks a contact email and has 2 open tickets (1 SLA breached); GAMMA is internal with no devices. */
function standardReadiness() {
  return {
    [ALPHA.id]: readinessFor(ALPHA, { setup: { sites: 0 } }),
    [BETA.id]: readinessFor(BETA, {
      account: { primaryContact: { name: 'Bob Beta', email: null, phone: '+1 555 0200', mobile: null } },
      tickets: { open: 2, awaitingCustomer: 1, slaBreached: 1 },
    }),
    [GAMMA.id]: readinessFor(GAMMA, { setup: { devices: 0 }, account: { primaryContact: null } }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-13T12:00:00.000Z'));
  fetchMock.mockReset();
  navigateTo.mockReset();
  window.location.hash = '';
  window.localStorage.clear();
  store.currentOrgId = null;
  store.serviceManagementMode = 'native';
  auth.scope = 'partner';
  auth.permissions = [{ resource: '*', action: '*' }];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('OrganizationsBoardPage — cold load', () => {
  it('renders the frame and skeleton rows, then rows from the list, then chips once the batch lands', async () => {
    let release: ((r: Response) => void) | undefined;
    mockBoardApi(fetchMock, { onReadiness: () => new Promise<Response>((resolve) => { release = resolve; }) });
    render(<OrganizationsBoardPage />);
    expect(screen.getByTestId('org-board-heading')).toHaveTextContent('Organizations');
    expect(screen.getByRole('button', { name: 'Add organization' })).toBeInTheDocument();
    expect(screen.getByTestId('org-board-skeleton')).toBeInTheDocument();

    await flush();
    expect(screen.queryByTestId('org-board-skeleton')).not.toBeInTheDocument();
    expect(renderedRowIds()).toEqual([ALPHA.id, BETA.id, GAMMA.id]);
    expect(row(ALPHA.id).getAllByTestId('org-board-chips-pending').length).toBeGreaterThan(0);
    expect(screen.getByTestId('org-board-band-setupIncomplete-count')).toHaveTextContent('—');
    expect(screen.getByTestId('org-board-band-all-count')).toHaveTextContent('3');

    release!(jsonResponse({ partnerId: 'partner-1', capabilities: ALL_CAPS, serviceManagementMode: 'native', orgs: Object.values(standardReadiness()) }));
    await flush();
    expect(row(ALPHA.id).getByTestId('org-board-chip-noSite')).toHaveAttribute('href', `/organizations/${ALPHA.id}#sites`);
    expect(row(ALPHA.id).getByRole('link', { name: 'No site for Alpha Ltd' })).toBeInTheDocument();
    expect(row(BETA.id).getByTestId('org-board-chip-contactEmail')).toHaveAttribute('href', `/organizations/${BETA.id}#contacts`);
    expect(row(GAMMA.id).getByTestId('org-board-chip-noDevices')).toBeInTheDocument();
    // Internal org: Account cell is a dash, never "Complete".
    expect(row(GAMMA.id).getByTitle('Not applicable')).toHaveTextContent('—');
    expect(screen.getByTestId('org-board-band-setupIncomplete-count')).toHaveTextContent('2');
    expect(screen.getByTestId('org-board-band-accountMissing-count')).toHaveTextContent('1');
    expect(screen.getByTestId('org-board-band-openTickets-count')).toHaveTextContent('1');
    expect(screen.getByTestId('org-board-band-all')).toHaveTextContent('1 trial · 0 suspended');
    expect(screen.getByTestId('org-board-band-openTickets')).toHaveTextContent('1 SLA breached');
    expect(screen.getByTestId('org-board-footer')).toHaveTextContent('3 active accounts · 8 devices · 2 open tickets');
  });

  it('shows the empty state with Add organization when there are no organizations', async () => {
    mockBoardApi(fetchMock, { orgs: [] });
    render(<OrganizationsBoardPage />);
    await flush();
    expect(within(screen.getByTestId('org-board-empty')).getByRole('button', { name: 'Add organization' })).toBeInTheDocument();
    expect(screen.getByTestId('org-board-band-all-count')).toHaveTextContent('0');
  });

  it('shows the error card with Try again when the list cannot load', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ error: 'boom' }, false, 500));
    render(<OrganizationsBoardPage />);
    await flush();
    expect(screen.getByTestId('org-board-error')).toHaveTextContent('Failed to fetch organizations');
    mockBoardApi(fetchMock);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await flush();
    expect(renderedRowIds()).toEqual([ALPHA.id, BETA.id, GAMMA.id]);
  });
});

describe('OrganizationsBoardPage — lens, filters, sort', () => {
  it('the Setup lens hides the Account column, writes the hash and remembers itself per browser', async () => {
    mockBoardApi(fetchMock, { readiness: standardReadiness() });
    render(<OrganizationsBoardPage />);
    await flush();
    expect(desktop().getByRole('columnheader', { name: 'Account data' })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('org-board-lens-setup'));
    expect(screen.getByTestId('org-board-lens-setup')).toHaveAttribute('aria-pressed', 'true');
    expect(desktop().queryByRole('columnheader', { name: 'Account data' })).not.toBeInTheDocument();
    expect(desktop().getByRole('columnheader', { name: 'Setup' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#lens=setup&filter=all');
    expect(window.localStorage.getItem(ORG_BOARD_LENS_STORAGE_KEY)).toBe('setup');
  });

  it('a filter whose evidence the lens hides switches the lens to Both for that view (without overwriting the stored lens)', async () => {
    window.localStorage.setItem(ORG_BOARD_LENS_STORAGE_KEY, 'account');
    mockBoardApi(fetchMock, { readiness: standardReadiness() });
    render(<OrganizationsBoardPage />);
    await flush();
    expect(desktop().queryByRole('columnheader', { name: 'Setup' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('org-board-filter-setupIncomplete'));
    expect(screen.getByTestId('org-board-lens-both')).toHaveAttribute('aria-pressed', 'true');
    expect(desktop().getByRole('columnheader', { name: 'Setup' })).toBeInTheDocument();
    expect(renderedRowIds()).toEqual([ALPHA.id, GAMMA.id]);
    expect(window.location.hash).toBe('#lens=both&filter=setupIncomplete');
    expect(window.localStorage.getItem(ORG_BOARD_LENS_STORAGE_KEY)).toBe('account');
  });

  it('a band cell applies its filter and reads as pressed alongside the chip', async () => {
    mockBoardApi(fetchMock, { readiness: standardReadiness() });
    render(<OrganizationsBoardPage />);
    await flush();
    fireEvent.click(screen.getByTestId('org-board-band-openTickets'));
    expect(renderedRowIds()).toEqual([BETA.id]);
    expect(screen.getByTestId('org-board-band-openTickets')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('org-board-filter-openTickets')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('org-board-filter-openTickets-count')).toHaveTextContent('1');
  });

  it('Trial narrows by status and its count is known before any batch lands', async () => {
    mockBoardApi(fetchMock, { onReadiness: () => new Promise<Response>(() => undefined) });
    render(<OrganizationsBoardPage />);
    await flush();
    expect(screen.getByTestId('org-board-filter-trial-count')).toHaveTextContent('1');
    fireEvent.click(screen.getByTestId('org-board-filter-trial'));
    expect(renderedRowIds()).toEqual([BETA.id]);
  });

  it('a hash deep link restores lens and filter on mount', async () => {
    window.location.hash = 'lens=account&filter=accountMissing';
    mockBoardApi(fetchMock, { readiness: standardReadiness() });
    render(<OrganizationsBoardPage />);
    await flush();
    expect(screen.getByTestId('org-board-lens-account')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('org-board-filter-accountMissing')).toHaveAttribute('aria-pressed', 'true');
    expect(renderedRowIds()).toEqual([BETA.id]);
  });

  it('search matches name, contact name and email; Clear filters resets search and filter', async () => {
    mockBoardApi(fetchMock, { readiness: standardReadiness() });
    render(<OrganizationsBoardPage />);
    await flush();
    const search = screen.getByRole('searchbox', { name: 'Search organizations, contacts and emails' });
    fireEvent.change(search, { target: { value: 'jane@' } });
    expect(renderedRowIds()).toEqual([ALPHA.id]);
    fireEvent.change(search, { target: { value: 'bob beta' } });
    expect(renderedRowIds()).toEqual([BETA.id]);
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByTestId('org-board-no-matches')).toHaveTextContent('No organizations match your search or filter.');
    fireEvent.click(screen.getByTestId('org-board-clear-filters'));
    expect(renderedRowIds()).toEqual([ALPHA.id, BETA.id, GAMMA.id]);
    expect(search).toHaveValue('');
  });

  it('sorts by open tickets (desc, then name) and by name; only Manual order shows the handle; the choice is remembered', async () => {
    mockBoardApi(fetchMock, { readiness: standardReadiness() });
    render(<OrganizationsBoardPage />);
    await flush();
    expect(desktop().getAllByTestId('org-board-drag-handle')).toHaveLength(3);
    fireEvent.change(screen.getByTestId('org-board-sort'), { target: { value: 'tickets' } });
    expect(renderedRowIds()).toEqual([BETA.id, ALPHA.id, GAMMA.id]);
    expect(desktop().queryByTestId('org-board-drag-handle')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(ORG_LIST_SORT_STORAGE_KEY)).toBe('tickets');
    fireEvent.click(desktop().getByTestId('org-board-sort-name'));
    expect(renderedRowIds()).toEqual([ALPHA.id, BETA.id, GAMMA.id]);
    expect(screen.getByTestId('org-board-sort')).toHaveValue('name');
  });

  it('adopts a remembered sort on mount and ignores the retired "devices" value', async () => {
    window.localStorage.setItem(ORG_LIST_SORT_STORAGE_KEY, 'name');
    mockBoardApi(fetchMock);
    const { unmount } = render(<OrganizationsBoardPage />);
    await flush();
    expect(screen.getByTestId('org-board-sort')).toHaveValue('name');
    unmount();
    window.localStorage.setItem(ORG_LIST_SORT_STORAGE_KEY, 'devices');
    render(<OrganizationsBoardPage />);
    await flush();
    expect(screen.getByTestId('org-board-sort')).toHaveValue('manual');
  });
});

describe('OrganizationsBoardPage — readiness states', () => {
  it('a failed batch shows Unavailable on its rows and "partial" with Try again in the band; retry fills them in', async () => {
    mockBoardApi(fetchMock, {
      readiness: standardReadiness(),
      onReadiness: (_ids, call) => (call === 1 ? jsonResponse({ error: 'boom' }, false, 500) : undefined),
    });
    render(<OrganizationsBoardPage />);
    await flush();
    expect(row(ALPHA.id).getAllByTestId('org-board-chips-unavailable').length).toBeGreaterThan(0);
    expect(screen.getByTestId('org-board-band-partial')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('org-board-band-retry'));
    await flush();
    expect(screen.queryByTestId('org-board-band-partial')).not.toBeInTheDocument();
    expect(row(ALPHA.id).getByTestId('org-board-chip-noSite')).toBeInTheDocument();
  });

  it('a section absent from capabilities hides its column, band cell, filter and sort option — never zeros', async () => {
    mockBoardApi(fetchMock, { readiness: standardReadiness(), capabilities: { ...ALL_CAPS, tickets: false } });
    render(<OrganizationsBoardPage />);
    await flush();
    expect(desktop().queryByRole('columnheader', { name: 'Open tickets' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('org-board-band-openTickets')).not.toBeInTheDocument();
    expect(screen.queryByTestId('org-board-filter-openTickets')).not.toBeInTheDocument();
    const options = Array.from(screen.getByTestId('org-board-sort').querySelectorAll('option')).map((o) => o.value);
    expect(options).toEqual(['manual', 'name']);
    expect(screen.getByTestId('org-board-footer')).toHaveTextContent('3 active accounts · 8 devices');
    expect(screen.getByTestId('org-board-footer')).not.toHaveTextContent('open tickets');
  });

  it('phone cards carry a single "Still needed" list per org', async () => {
    mockBoardApi(fetchMock, { readiness: standardReadiness() });
    render(<OrganizationsBoardPage />);
    await flush();
    const card = within(screen.getByTestId('responsive-table-cards')).getByTestId(`org-board-card-${ALPHA.id}`);
    expect(within(card).getByText('Still needed')).toBeInTheDocument();
    expect(within(card).getByTestId('org-board-card-chip-noSite')).toBeInTheDocument();
  });

  it('a bare uuid hash scrolls to, focuses and briefly highlights that row', async () => {
    window.location.hash = BETA.id;
    mockBoardApi(fetchMock, { readiness: standardReadiness() });
    render(<OrganizationsBoardPage />);
    await flush();
    expect(desktop().getByTestId(`org-board-row-${BETA.id}`)).toHaveAttribute('data-highlighted', 'true');
    expect(row(BETA.id).getByTestId(`org-board-name-${BETA.id}`)).toHaveAttribute('tabindex', '0');
    await flush(ROW_HIGHLIGHT_MS);
    expect(desktop().getByTestId(`org-board-row-${BETA.id}`)).not.toHaveAttribute('data-highlighted');
  });

  it('row click opens the record', async () => {
    mockBoardApi(fetchMock, { readiness: standardReadiness() });
    render(<OrganizationsBoardPage />);
    await flush();
    fireEvent.click(desktop().getByTestId(`org-board-row-${ALPHA.id}`));
    expect(navigateTo).toHaveBeenCalledWith(`/organizations/${ALPHA.id}`);
  });
});
```

- [ ] **Step 3: Run the render tests to verify they fail**

Run: `cd apps/web && npx vitest run src/components/organizations/board/OrganizationsBoardPage.render.test.tsx`
Expected: FAIL — `Failed to resolve import "./OrganizationsBoardPage"`.

- [ ] **Step 4: Write the page**

```tsx
// apps/web/src/components/organizations/board/OrganizationsBoardPage.tsx
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { Organization } from '@/components/settings/organizationTypes';
import OrganizationForm from '@/components/settings/OrganizationForm';
import MergeOrgModal from '@/components/settings/MergeOrgModal';
import ArchiveOrgModal from '@/components/settings/ArchiveOrgModal';
import BulkOrgImport from '@/components/organizations/BulkOrgImport';
import { Dialog } from '@/components/shared/Dialog';
import type { ActionMenuItem } from '@/components/shared/ActionMenu';
import { showToast } from '@/components/shared/Toast';
import { fetchWithAuth, handleSessionExpired } from '@/stores/auth';
import { useOrgStore } from '@/stores/orgStore';
import { useJwtClaims } from '@/lib/authScope';
import { usePermissions } from '@/lib/permissions';
import { runAction, ActionError, handleActionError } from '@/lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { applyOrgSwitch } from '@/lib/orgSwitch';
import { useHashState } from '@/lib/useHashState';
import { fetchAllOrganizations } from '@/lib/fetchAllOrganizations';
import { formatNumber } from '@/lib/i18n/format';
import { statusLabelKeys } from '@/lib/orgStatus';
import {
  BOARD_LENSES,
  BOARD_SORTS,
  DEFAULT_FILTER,
  DEFAULT_LENS,
  deriveReadinessChips,
  isBoardLens,
  isBoardSort,
  lensForFilter,
  matchesFilter,
  parseBoardHash,
  searchMatches,
  serializeBoardHash,
  sortRows,
  visibleColumns,
  visibleFilters,
  type BoardFilter,
  type BoardHashState,
  type BoardLens,
  type BoardRow,
  type BoardSort,
} from '@/lib/orgReadiness';
import { useAccountReadiness } from './useAccountReadiness';
import { useManualOrder } from './useManualOrder';
import { useArchivedOrganizations } from './useArchivedOrganizations';
import { RollupBand, type RollupCell } from './RollupBand';
import { AccountBoardTable, REORDER_HINT_ID } from './AccountBoardTable';

type ModalMode = 'closed' | 'add' | 'archive' | 'merge';

/** Per-browser conveniences, never authoritative state. Exported for the tests. */
export const ORG_LIST_SORT_STORAGE_KEY = 'breeze.orgList.sort'; // the key #5708 introduced
export const ORG_BOARD_LENS_STORAGE_KEY = 'breeze.orgBoard.lens';
export const ROW_HIGHLIGHT_MS = 2000;
/**
 * The restore route (`apps/api/src/routes/orgArchive.ts`) answers a purging
 * target with a bare `{ error: '<this text>' }, 410` and no machine `code`,
 * so this literal is the only handle `runAction`'s `friendly` lookup has. A
 * copy edit to that route must update this constant too, or the match falls
 * back to the raw (still correct, just unlocalized) backend text.
 */
export const RESTORE_PURGING_ERROR_TEXT = 'Organization is already purging and can no longer be restored';
const ADD_ORG_TITLE_ID = 'org-board-add-dialog-title';
const SKELETON_ROWS = 6;
const noop = () => {};
// The island is server-rendered (`client:load`); localStorage is adopted
// post-commit, pre-paint, so the first client render matches the SSR HTML.
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

type OrganizationFormValues = {
  name: string;
  slug: string;
  type: 'customer' | 'internal';
  status: 'active' | 'trial' | 'suspended' | 'churned' | 'offboarding';
  maxDevices: number;
  contractStart?: string;
  contractEnd?: string;
};

function readStoredSort(): BoardSort {
  try {
    const stored = window.localStorage.getItem(ORG_LIST_SORT_STORAGE_KEY);
    return stored && isBoardSort(stored) ? stored : 'manual';
  } catch {
    return 'manual';
  }
}

function readStoredLens(): BoardLens {
  try {
    const stored = window.localStorage.getItem(ORG_BOARD_LENS_STORAGE_KEY);
    return stored && isBoardLens(stored) ? stored : DEFAULT_LENS;
  } catch {
    return DEFAULT_LENS;
  }
}

function storeLocal(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* per-browser nicety only; nothing depends on it persisting */
  }
}

const PRIMARY_BUTTON =
  'inline-flex h-9 items-center justify-center whitespace-nowrap rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:opacity-90';
const SECONDARY_BUTTON =
  'inline-flex h-9 items-center justify-center whitespace-nowrap rounded-md border bg-background px-3 text-sm font-medium transition hover:bg-muted';
const CHIP_BUTTON = (pressed: boolean) =>
  `inline-flex h-8 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition ${
    pressed ? 'border-foreground bg-foreground text-background' : 'bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
  }`;

export default function OrganizationsBoardPage() {
  const { t } = useTranslation('organizations');
  const { t: tSettings } = useTranslation('settings');
  // Merge is partner-scope only (the API's merge routes require partner/system
  // scope). `useJwtClaims()` so this stays reactive to the token landing after
  // cold load (#4013's lesson).
  const jwt = useJwtClaims();
  const canMergeOrgs = jwt.status === 'resolved' && jwt.claims.scope === 'partner';
  const { can } = usePermissions();
  const workspaceOrgId = useOrgStore((s) => s.currentOrgId);
  const storeMode = useOrgStore((s) => s.serviceManagementMode);

  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [targetOrg, setTargetOrg] = useState<Organization | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sort, setSort] = useState<BoardSort>('manual');
  const [storedLens, setStoredLens] = useState<BoardLens>(DEFAULT_LENS);
  // Navigable state lives in the hash (#lens=…&filter=…, or a bare #<uuid>
  // row highlight); localStorage supplies the lens default when the hash is empty.
  const [hashState, setHashState] = useHashState<BoardHashState>({}, parseBoardHash);
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const [highlightedOrgId, setHighlightedOrgId] = useState<string | null>(null);
  const [restoringOrgId, setRestoringOrgId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLAnchorElement>());

  useIsomorphicLayoutEffect(() => {
    setStoredLens(readStoredLens());
    setSort(readStoredSort());
  }, []);

  const lens: BoardLens = hashState.lens ?? storedLens;
  const filter: BoardFilter = hashState.filter ?? DEFAULT_FILTER;

  const orgIds = useMemo(() => organizations.map((o) => o.id), [organizations]);
  const readiness = useAccountReadiness(orgIds);
  const capabilities = readiness.capabilities;
  const mode = readiness.mode ?? storeMode;
  const archived = useArchivedOrganizations({ enabled: filter === 'archived', search: searchQuery });

  /** `silent` keeps the rows on screen: a reorder reconciliation must not blank the list under its own error toast. */
  const fetchOrganizations = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent === true;
      try {
        if (!silent) setLoading(true);
        setError(undefined);
        const list = await fetchAllOrganizations<Organization>(async (page, limit) => {
          const response = await fetchWithAuth(`/orgs/organizations?page=${page}&limit=${limit}`);
          if (!response.ok) {
            if (response.status === 401) {
              // Idempotent: either no-ops into the redirect fetchWithAuth already
              // started, or performs the logout for a 401 that survived a refresh.
              handleSessionExpired();
              return null;
            }
            throw new Error(t('orgBoard.errors.fetchOrganizations'));
          }
          return response.json();
        });
        if (list === null) return;
        setOrganizations(list);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('orgBoard.errors.generic'));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [t],
  );
  const refetchSilently = useCallback(() => fetchOrganizations({ silent: true }), [fetchOrganizations]);
  const manualOrder = useManualOrder({ organizations, setOrganizations, refetch: refetchSilently });

  // Refresh both this list and the global org store (side nav / switcher).
  // allSettled so a store hiccup does not undo a create that already committed.
  const refreshOrgs = useCallback(async () => {
    const results = await Promise.allSettled([fetchOrganizations(), useOrgStore.getState().fetchOrganizations()]);
    const rejected = results.find((r) => r.status === 'rejected');
    if (rejected && rejected.status === 'rejected') console.warn('[OrganizationsBoardPage] org refresh partially failed', rejected.reason);
  }, [fetchOrganizations]);

  useEffect(() => {
    void fetchOrganizations();
  }, [fetchOrganizations]);

  // ---- Derived rows ----
  const rows: BoardRow[] = useMemo(() => {
    const now = new Date();
    return organizations.map((org) => {
      const r = readiness.byOrg.get(org.id);
      return { org, readiness: r, state: readiness.rowState.get(org.id) ?? 'pending', chips: deriveReadinessChips(org, r, capabilities, mode, now) };
    });
  }, [organizations, readiness.byOrg, readiness.rowState, capabilities, mode]);

  const archivedRows: BoardRow[] = useMemo(
    () => archived.archivedOrgs.map((org) => ({ org, readiness: undefined, state: 'ready' as const, chips: null })),
    [archived.archivedOrgs],
  );

  const filteredRows = useMemo(() => {
    if (filter === 'archived') {
      // Client-side re-filter of whatever is loaded, in ADDITION to the server-
      // side `search` the hook forwards: rows from the previous query can still
      // be on screen for one round trip.
      const q = searchQuery.trim().toLowerCase();
      return sortRows(archivedRows.filter((row) => !q || row.org.name.toLowerCase().includes(q)), sort);
    }
    return sortRows(rows.filter((row) => matchesFilter(filter, row) && searchMatches(searchQuery, row.org, row.readiness)), sort);
  }, [archivedRows, filter, rows, searchQuery, sort]);

  /** Manual order only means something against the full, server-ordered list. */
  const manualOrderActive = sort === 'manual' && filter === 'all' && searchQuery.trim().length === 0;
  const columns = useMemo(() => visibleColumns(lens, capabilities), [lens, capabilities]);
  const filters = useMemo(() => visibleFilters(capabilities), [capabilities]);
  const readinessKnown = readiness.status === 'ready' || readiness.status === 'partial';

  /** The one row whose controls are in the Tab order, re-resolved against the current filtered list. */
  const activeOrgId = useMemo(() => {
    if (activeRowId && filteredRows.some((r) => r.org.id === activeRowId)) return activeRowId;
    return filteredRows[0]?.org.id ?? null;
  }, [activeRowId, filteredRows]);

  // ---- Hash / lens / filter / sort ----
  const applyHash = useCallback(
    (next: { lens: BoardLens; filter: BoardFilter }) => {
      setHashState(next);
      window.location.hash = serializeBoardHash(next);
    },
    [setHashState],
  );
  const changeLens = useCallback(
    (next: BoardLens) => {
      setStoredLens(next);
      storeLocal(ORG_BOARD_LENS_STORAGE_KEY, next);
      applyHash({ lens: next, filter });
    },
    [applyHash, filter],
  );
  // Applying a filter whose evidence the lens hides switches the lens to Both
  // FOR THIS VIEW (hash only) — the remembered lens is untouched.
  const changeFilter = useCallback((next: BoardFilter) => applyHash({ lens: lensForFilter(next, lens), filter: next }), [applyHash, lens]);
  const changeSort = (next: BoardSort) => {
    setSort(next);
    storeLocal(ORG_LIST_SORT_STORAGE_KEY, next);
  };
  const clearFilters = () => {
    setSearchQuery('');
    applyHash({ lens, filter: DEFAULT_FILTER });
  };

  // Bare `#<uuid>` (the incumbent's selected-org deep link, still produced by
  // OrgSettingsPage/SiteDetailPage bookmarks): scroll to, focus and highlight.
  useEffect(() => {
    const id = hashState.highlightOrgId;
    if (!id || loading) return;
    const el = rowRefs.current.get(id);
    if (!el) return;
    setActiveRowId(id);
    setHighlightedOrgId(id);
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
    const timer = window.setTimeout(() => setHighlightedOrgId(null), ROW_HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [hashState.highlightOrgId, loading, organizations]);

  // ---- Counts for the band and the filter chips (live, unfiltered list) ----
  const counts = useMemo(() => {
    const count = (f: BoardFilter) => rows.filter((r) => matchesFilter(f, r)).length;
    return {
      trial: count('trial'),
      suspended: rows.filter((r) => r.org.status === 'suspended').length,
      setupIncomplete: readinessKnown ? count('setupIncomplete') : null,
      accountMissing: readinessKnown ? count('accountMissing') : null,
      openTickets: readinessKnown ? count('openTickets') : null,
      slaBreached: rows.reduce((sum, r) => sum + (r.readiness?.tickets?.slaBreached ?? 0), 0),
      openTicketTotal: rows.reduce((sum, r) => sum + (r.readiness?.tickets?.open ?? 0), 0),
      deviceTotal: organizations.reduce((sum, o) => sum + (o.deviceCount ?? 0), 0),
      archived: archived.loaded ? archived.archivedOrgs.length : null,
    };
  }, [rows, organizations, readinessKnown, archived.loaded, archived.archivedOrgs.length]);

  const filterCount = (key: BoardFilter): number | null => {
    switch (key) {
      case 'setupIncomplete':
        return counts.setupIncomplete;
      case 'accountMissing':
        return counts.accountMissing;
      case 'openTickets':
        return counts.openTickets;
      case 'trial':
        return counts.trial;
      case 'archived':
        return counts.archived;
      default:
        return null;
    }
  };

  const bandCells: RollupCell[] = useMemo(
    () =>
      filters
        .filter((key) => key !== 'trial' && key !== 'archived')
        .map((key): RollupCell => {
          const pressed = filter === key;
          const onPress = () => changeFilter(key);
          if (key === 'all') {
            return { key, count: rows.length, sub: t('orgBoard.band.allSub', { trial: counts.trial, suspended: counts.suspended }), pressed, onPress };
          }
          if (key === 'openTickets') {
            return {
              key,
              count: counts.openTickets,
              sub: readinessKnown ? t('orgBoard.band.openTicketsSub', { count: counts.slaBreached }) : null,
              subTone: counts.slaBreached > 0 ? 'destructive' : 'muted',
              pressed,
              onPress,
            };
          }
          return { key, count: key === 'setupIncomplete' ? counts.setupIncomplete : counts.accountMissing, pressed, onPress };
        }),
    [filters, filter, rows.length, counts, readinessKnown, changeFilter, t],
  );

  // ---- Keyboard: Arrow/Home/End move the roving stop, never a selection ----
  const handleRowKeyDown = (event: KeyboardEvent<HTMLAnchorElement>, index: number) => {
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = Math.min(index + 1, filteredRows.length - 1);
    else if (event.key === 'ArrowUp') next = Math.max(index - 1, 0);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = filteredRows.length - 1;
    if (next === null) return;
    event.preventDefault();
    if (next === index) return;
    const target = filteredRows[next];
    setActiveRowId(target.org.id);
    rowRefs.current.get(target.org.id)?.focus();
  };
  const registerRowRef = useCallback((orgId: string, el: HTMLAnchorElement | null) => {
    if (el) rowRefs.current.set(orgId, el);
    else rowRefs.current.delete(orgId);
  }, []);

  // ---- Row actions ----
  const openRecord = (org: Organization) => void navigateTo(`/organizations/${org.id}`);
  const handleWorkHere = (org: Organization) => void applyOrgSwitch(org.id, t('orgRecord.actions.workHereToast', { orgName: org.name }));
  const handleArchive = (org: Organization) => {
    setTargetOrg(org);
    setModalMode('archive');
  };
  const handleMerge = (org: Organization) => {
    setTargetOrg(org);
    setModalMode('merge');
  };
  const handleCloseModal = () => setModalMode('closed');
  /** LIST-STATE UPDATE ONLY: the modal stays open on its own `done` phase. */
  const handleArchiveComplete = (archivedId: string) => setOrganizations((prev) => prev.filter((o) => o.id !== archivedId));
  const handleArchiveDoneClose = () => {
    setTargetOrg(null);
    handleCloseModal();
  };
  /** NOT a refetch: the loser ends up a terminal `status='merging'` shell that a refetch would still return. */
  const handleMergeComplete = (loserId: string) => setOrganizations((prev) => prev.filter((o) => o.id !== loserId));
  const handleMergeDoneClose = () => {
    setTargetOrg(null);
    handleCloseModal();
  };

  const restoreFriendly = (code: string) => {
    if (code === 'MFA_REQUIRED') return t('orgBoard.restore.errors.mfaRequired');
    if (code === RESTORE_PURGING_ERROR_TEXT) return t('orgBoard.restore.errors.purging');
    return undefined;
  };

  /** Optimistic: drop from the archived rows, add to the live list under the status the API reports; the global store hears about it separately. */
  const handleRestore = async (org: Organization) => {
    setRestoringOrgId(org.id);
    try {
      const data = await runAction<{ status: string; recreateRequired: string[] }>({
        request: () => fetchWithAuth(`/orgs/organizations/${org.id}/restore`, { method: 'POST' }),
        errorFallback: t('orgBoard.restore.errors.restore'),
        friendly: restoreFriendly,
        onUnauthorized: handleSessionExpired,
      });
      const restoredStatus = data.status as Organization['status'];
      const restoredOrg: Organization = { ...org, status: restoredStatus, archived: undefined, purgeAt: undefined, offboardingTarget: undefined };
      archived.remove(org.id);
      setOrganizations((prev) => [...prev, restoredOrg]);
      useOrgStore
        .getState()
        .fetchOrganizations()
        .catch((storeErr: unknown) => console.warn('[OrganizationsBoardPage] org store refresh failed after restore', storeErr));
      const parts = [t('orgBoard.restore.success', { name: org.name, status: tSettings(/* i18n-dynamic */ statusLabelKeys[restoredStatus]) })];
      if (data.recreateRequired.length > 0) parts.push(t('orgBoard.restore.recreateRequiredNote', { items: data.recreateRequired.join('; ') }));
      if (restoredStatus === 'suspended') parts.push(t('orgBoard.restore.suspendedNote'));
      showToast({ message: parts.join(' '), type: 'success' });
    } catch (err) {
      handleActionError(err, t('orgBoard.restore.errors.restore'));
    } finally {
      setRestoringOrgId(null);
    }
  };

  const handleSubmit = async (values: OrganizationFormValues) => {
    setSubmitting(true);
    try {
      // runAction, not setError: the page banner renders behind the dialog overlay.
      const createdOrg = await runAction<{ id?: string } | null>({
        request: () => fetchWithAuth('/orgs/organizations', { method: 'POST', body: JSON.stringify(values) }),
        errorFallback: t('orgBoard.errors.saveOrganization'),
        onUnauthorized: handleSessionExpired,
        parseSuccess: (data) => (data ?? null) as { id?: string } | null,
      });
      await refreshOrgs();
      handleCloseModal();
      if (createdOrg?.id) {
        // The new row's Setup chips ARE the "what next" — highlight it rather than
        // opening a site dialog here (sites are the record's job).
        setHashState({ highlightOrgId: createdOrg.id });
        window.location.hash = createdOrg.id;
        showToast({ type: 'success', message: t('orgBoard.add.created', { name: values.name }) });
      }
    } catch (err) {
      if (!(err instanceof ActionError)) {
        showToast({ message: err instanceof Error ? err.message : t('orgBoard.errors.generic'), type: 'error' });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const menuItemsFor = useCallback(
    (row: BoardRow): ActionMenuItem[] => {
      const org = row.org;
      const recordHref = `/organizations/${org.id}`;
      if (org.archived === true) {
        return [
          { id: 'open', label: t('orgBoard.actions.openRecord'), href: recordHref, testId: 'org-board-menu-open-record' },
          {
            id: 'restore',
            label: restoringOrgId === org.id ? t('orgBoard.actions.restoring') : t('orgBoard.actions.restore'),
            onSelect: () => void handleRestore(org),
            testId: 'org-board-menu-restore',
          },
        ];
      }
      const items: ActionMenuItem[] = [{ id: 'open', label: t('orgBoard.actions.openRecord'), href: recordHref, testId: 'org-board-menu-open-record' }];
      const primary = row.readiness?.account.primaryContact ?? null;
      const phone = primary?.phone ?? primary?.mobile ?? null;
      if (primary && (primary.email || phone)) {
        // Name, or the email when the contact has no name, or the number when it has neither.
        const displayName = primary.name || primary.email || phone || '';
        items.push({
          id: 'contact',
          label: t('orgBoard.actions.contact', { name: displayName }),
          description: [primary.email, phone].filter(Boolean).join(' · '),
          href: primary.email ? `mailto:${primary.email}` : `tel:${phone}`,
          testId: 'org-board-menu-contact',
        });
      }
      if (mode === 'native' && can('tickets', 'write')) {
        items.push({ id: 'ticket', label: t('orgBoard.actions.newTicket'), href: `/tickets/new#orgId=${org.id}`, testId: 'org-board-menu-new-ticket' });
      }
      items.push({ id: 'work', label: t('orgBoard.actions.workHere'), separatorBefore: true, onSelect: () => handleWorkHere(org), testId: 'org-board-menu-work-here' });
      items.push({ id: 'settings', label: t('orgBoard.actions.settings'), onSelect: () => void navigateTo(`/settings/organizations/${org.id}`), testId: 'org-board-menu-settings' });
      items.push({ id: 'archive', label: t('orgBoard.actions.archive'), separatorBefore: true, onSelect: () => handleArchive(org), testId: 'org-board-menu-archive' });
      if (canMergeOrgs) {
        items.push({ id: 'merge', label: t('orgBoard.actions.merge'), tone: 'destructive', onSelect: () => handleMerge(org), testId: 'org-board-menu-merge' });
      }
      return items;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handlers are stable closures over state setters; restoringOrgId/mode/can/canMergeOrgs are the inputs that change
    [t, restoringOrgId, mode, can, canMergeOrgs],
  );

  // ---- Render ----
  const initialLoading = loading && organizations.length === 0;

  if (error && organizations.length === 0) {
    return (
      <div data-testid="org-board-error" className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button type="button" onClick={() => void fetchOrganizations()} className={`mt-4 ${PRIMARY_BUTTON}`}>
          {t('orgBoard.actions.tryAgain')}
        </button>
      </div>
    );
  }

  const footer = (
    <p data-testid="org-board-footer" className="text-xs text-muted-foreground">
      {capabilities?.tickets && readinessKnown
        ? t('orgBoard.footer.summaryWithTickets', {
            accounts: formatNumber(organizations.length),
            devices: formatNumber(counts.deviceTotal),
            tickets: formatNumber(counts.openTicketTotal),
          })
        : t('orgBoard.footer.summary', { accounts: formatNumber(organizations.length), devices: formatNumber(counts.deviceTotal) })}
      {manualOrderActive && <> · {t('orgBoard.footer.manualHint')}</>}
    </p>
  );

  const renderTableRegion = () => {
    if (initialLoading) {
      return (
        <div data-testid="org-board-skeleton" aria-busy="true" className="divide-y rounded-lg border bg-card shadow-xs">
          <p className="sr-only">{t('orgBoard.loading')}</p>
          {Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3" aria-hidden="true">
              <div className="skeleton h-4 w-4" />
              <div className="skeleton h-4 w-40" />
              <div className="skeleton h-5 w-24 rounded-full" />
              <div className="skeleton h-5 w-24 rounded-full" />
              <div className="skeleton h-4 w-12" />
            </div>
          ))}
        </div>
      );
    }
    if (filter === 'archived') {
      if (archived.loading && !archived.loaded) {
        return <div className="rounded-lg border bg-card px-4 py-8 text-center text-sm text-muted-foreground">{t('orgBoard.archived.loading')}</div>;
      }
      if (archived.error) {
        return <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{archived.error}</div>;
      }
      if (filteredRows.length === 0) {
        // Keyed on whether a search is active: once a term is present the loaded
        // rows ARE the server-filtered result, so empty means "no match".
        return (
          <div data-testid="org-board-archived-empty" className="rounded-lg border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
            {searchQuery.trim() ? t('orgBoard.archived.noMatches') : t('orgBoard.archived.empty')}
          </div>
        );
      }
      return (
        <>
          {archived.truncated && (
            <p data-testid="org-board-archived-truncated-note" className="text-xs text-muted-foreground">
              {t('orgBoard.archived.truncatedNote', { count: archived.archivedOrgs.length })}
            </p>
          )}
          <AccountBoardTable
            rows={filteredRows}
            columns={columns}
            sort={sort}
            onSortChange={changeSort}
            activeRowId={activeOrgId}
            onRowKeyDown={handleRowKeyDown}
            registerRowRef={registerRowRef}
            onOpenRecord={openRecord}
            highlightedOrgId={highlightedOrgId}
            workspaceOrgId={workspaceOrgId}
            manualOrder={null}
            menuItemsFor={menuItemsFor}
            archivedView
            now={new Date()}
          />
        </>
      );
    }
    if (organizations.length === 0) {
      return (
        <div data-testid="org-board-empty" className="rounded-lg border bg-card p-8">
          <div className="max-w-lg">
            <h2 className="mb-2 text-lg font-semibold">{t('orgBoard.empty.title')}</h2>
            <p className="mb-6 text-sm text-muted-foreground">{t('orgBoard.empty.description')}</p>
            <button type="button" onClick={() => setModalMode('add')} className={PRIMARY_BUTTON}>
              {t('orgBoard.actions.addOrganization')}
            </button>
          </div>
        </div>
      );
    }
    if (filteredRows.length === 0) {
      return (
        <div data-testid="org-board-no-matches" className="rounded-lg border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          <p>{t('orgBoard.empty.noMatches')}</p>
          <button type="button" data-testid="org-board-clear-filters" onClick={clearFilters} className="mt-3 font-medium text-primary hover:underline">
            {t('orgBoard.actions.clearFilters')}
          </button>
        </div>
      );
    }
    return (
      <AccountBoardTable
        rows={filteredRows}
        columns={columns}
        sort={sort}
        onSortChange={changeSort}
        activeRowId={activeOrgId}
        onRowKeyDown={handleRowKeyDown}
        registerRowRef={registerRowRef}
        onOpenRecord={openRecord}
        highlightedOrgId={highlightedOrgId}
        workspaceOrgId={workspaceOrgId}
        manualOrder={manualOrderActive ? manualOrder : null}
        menuItemsFor={menuItemsFor}
        archivedView={false}
        now={new Date()}
      />
    );
  };

  return (
    <div className="space-y-6" data-testid="org-board">
      {/* Header — same anatomy as the Devices page. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 data-testid="org-board-heading" className="text-xl font-semibold tracking-tight">
            {t('orgBoard.title')}
          </h1>
          <p className="text-muted-foreground">{t('orgBoard.description')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" data-testid="bulk-org-import-toggle" onClick={() => setShowBulkImport((v) => !v)} className={SECONDARY_BUTTON}>
            {tSettings('bulkOrgImport.title')}
          </button>
          <button type="button" data-testid="org-board-add" onClick={() => setModalMode('add')} className={PRIMARY_BUTTON}>
            {t('orgBoard.actions.addOrganization')}
          </button>
        </div>
      </div>

      {showBulkImport && (
        <BulkOrgImport onImported={() => void fetchOrganizations()} onClose={() => setShowBulkImport(false)} onUnauthorized={handleSessionExpired} />
      )}

      {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}

      <RollupBand cells={bandCells} status={readiness.status} onRetry={readiness.retry} />

      {/* Toolbar: search · filter chips · lens · sort */}
      <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 shadow-xs lg:flex-row lg:items-center lg:justify-between">
        <input
          type="search"
          data-testid="org-board-search"
          placeholder={t('orgBoard.search.label')}
          aria-label={t('orgBoard.search.label')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring lg:w-72"
        />
        <div role="group" aria-label={t('orgBoard.filters.label')} className="flex min-w-0 flex-wrap gap-1">
          {filters.map((key) => {
            const count = filterCount(key);
            return (
              <button key={key} type="button" data-testid={`org-board-filter-${key}`} aria-pressed={filter === key} onClick={() => changeFilter(key)} className={CHIP_BUTTON(filter === key)}>
                {t(/* i18n-dynamic */ `orgBoard.filters.${key}`)}
                {count !== null && (
                  <span data-testid={`org-board-filter-${key}-count`} className="tabular-nums opacity-70">
                    {formatNumber(count)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <div role="group" aria-label={t('orgBoard.lens.label')} className="flex rounded-md border">
            {BOARD_LENSES.map((key) => (
              <button
                key={key}
                type="button"
                data-testid={`org-board-lens-${key}`}
                aria-pressed={lens === key}
                onClick={() => changeLens(key)}
                className={`h-9 px-3 text-xs font-medium transition first:rounded-l-md last:rounded-r-md ${lens === key ? 'bg-muted' : 'hover:bg-muted/50'}`}
              >
                {t(/* i18n-dynamic */ `orgBoard.lens.${key}`)}
              </button>
            ))}
          </div>
          <select
            data-testid="org-board-sort"
            aria-label={t('orgBoard.sort.label')}
            value={sort}
            onChange={(e) => changeSort(e.target.value as BoardSort)}
            // `py-0` overrides the forms plugin's vertical padding, which otherwise pushes the text out of the box.
            className="h-9 shrink-0 rounded-md border bg-background py-0 pl-2 pr-7 text-xs leading-none focus:outline-hidden focus:ring-2 focus:ring-ring"
          >
            {BOARD_SORTS.filter((s) => s !== 'tickets' || capabilities?.tickets === true).map((s) => (
              <option key={s} value={s}>
                {t(/* i18n-dynamic */ `orgBoard.sort.${s}`)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p id={REORDER_HINT_ID} className="sr-only">
        {t('orgBoard.reorder.hint')}
      </p>
      <div data-testid="org-board-reorder-announcement" role="status" aria-live="polite" className="sr-only">
        {manualOrder.announcement}
      </div>

      {renderTableRegion()}
      {!initialLoading && organizations.length > 0 && filter !== 'archived' && footer}

      {modalMode === 'add' && (
        <Dialog open onClose={submitting ? noop : handleCloseModal} title={t('orgBoard.add.title')} labelledBy={ADD_ORG_TITLE_ID} maxWidth="2xl" alignTop>
          <div className="border-b px-6 py-4">
            <h2 id={ADD_ORG_TITLE_ID} className="text-lg font-semibold">
              {t('orgBoard.add.title')}
            </h2>
            <p className="text-sm text-muted-foreground">{t('orgBoard.add.description')}</p>
          </div>
          <OrganizationForm onSubmit={handleSubmit} onCancel={handleCloseModal} submitLabel={t('orgBoard.add.submit')} loading={submitting} className="space-y-6 p-6" />
        </Dialog>
      )}
      {modalMode === 'archive' && targetOrg && (
        <ArchiveOrgModal org={targetOrg} onClose={handleCloseModal} onArchived={handleArchiveComplete} onDoneClose={handleArchiveDoneClose} />
      )}
      {modalMode === 'merge' && targetOrg && (
        <MergeOrgModal loserOrg={targetOrg} orgs={organizations} onClose={handleCloseModal} onMerged={handleMergeComplete} onDoneClose={handleMergeDoneClose} />
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run the render tests, the contract scans and the typecheck**

Run: `cd apps/web && npx vitest run src/components/organizations/board/OrganizationsBoardPage.render.test.tsx src/lib/__tests__/no-hash-in-usestate.test.ts src/lib/__tests__/no-envelope-fallthrough.test.ts src/lib/__tests__/no-translated-comparisons.test.ts src/lib/i18n/keyUsage.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: all PASS, no type errors. (`no-silent-mutations` is updated in Task 12, once the incumbent is deleted; until then both files exist and the guard only inspects the incumbent.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/organizations/board/OrganizationsBoardPage.tsx apps/web/src/components/organizations/board/boardTestKit.ts apps/web/src/components/organizations/board/OrganizationsBoardPage.render.test.tsx
git commit -m "feat(web): OrganizationsBoardPage — account board island with band, toolbar, hash state, readiness batches and dialogs (W02 #5723)"
```

---

### Task 11: Ported contracts — keyboard rows, reorder reconciliation, row menu + dialogs + workspace marker, archived filter + restore

These four suites carry the incumbent's contracts (`OrganizationsPage.keyboard/mutationFeedback/actions/archive/merge/scope/archived.test.tsx`) onto the board. Write each file, run it, and fix the page where a ported assertion fails — the assertions are the contract, the page is what bends.

**Files:**
- Test: `apps/web/src/components/organizations/board/OrganizationsBoardPage.keyboard.test.tsx`
- Test: `apps/web/src/components/organizations/board/OrganizationsBoardPage.reorder.test.tsx`
- Test: `apps/web/src/components/organizations/board/OrganizationsBoardPage.rowMenu.test.tsx`
- Test: `apps/web/src/components/organizations/board/OrganizationsBoardPage.archived.test.tsx`

**Interfaces:**
- Consumes: the page and kit from Task 10; the modals' existing test ids (`org-archive-modal`, `org-archive-submit`, `org-archive-done`, `org-archive-close`, `org-merge-survivor-select`, `org-merge-confirm-input`, `org-merge-submit`, `org-merge-modal`, `org-merge-done`, `org-merge-close`).

- [ ] **Step 1: Keyboard operability**

```tsx
// apps/web/src/components/organizations/board/OrganizationsBoardPage.keyboard.test.tsx
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OrganizationsBoardPage from './OrganizationsBoardPage';
import { fetchWithAuth } from '@/stores/auth';
import { ALPHA, BETA, GAMMA, flush, jsonResponse, mockBoardApi, renderedRowIds } from './boardTestKit';

// … the mock block from Task 10 Step 2, verbatim …

const fetchMock = vi.mocked(fetchWithAuth);
const desktop = () => within(screen.getByTestId('responsive-table-desktop'));
const name = (id: string) => desktop().getByTestId(`org-board-name-${id}`);
const handle = (id: string) => within(desktop().getByTestId(`org-board-row-${id}`)).getByTestId('org-board-drag-handle');
const patches = () => fetchMock.mock.calls.filter(([url, init]) => String(url) === '/orgs/organizations/order' && init?.method === 'PATCH');

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  navigateTo.mockReset();
  window.location.hash = '';
  window.localStorage.clear();
  store.currentOrgId = null;
  auth.scope = 'partner';
});
afterEach(() => {
  vi.useRealTimers();
});

describe('OrganizationsBoardPage — keyboard operability', () => {
  it('names the search input', async () => {
    mockBoardApi(fetchMock);
    render(<OrganizationsBoardPage />);
    await flush();
    expect(screen.getByRole('searchbox', { name: 'Search organizations, contacts and emails' })).toBeInTheDocument();
  });

  it('the first row’s name link is the roving tab stop; rows never carry aria-current', async () => {
    mockBoardApi(fetchMock);
    render(<OrganizationsBoardPage />);
    await flush();
    expect(name(ALPHA.id)).toHaveAttribute('tabindex', '0');
    expect(name(BETA.id)).toHaveAttribute('tabindex', '-1');
    expect(name(ALPHA.id)).not.toHaveAttribute('aria-current');
    expect(desktop().getByTestId(`org-board-row-${ALPHA.id}`)).not.toHaveAttribute('aria-current');
  });

  it('Arrow/Home/End move focus and the tab stop without opening a record', async () => {
    mockBoardApi(fetchMock);
    render(<OrganizationsBoardPage />);
    await flush();
    name(ALPHA.id).focus();
    fireEvent.keyDown(name(ALPHA.id), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(name(BETA.id));
    expect(name(BETA.id)).toHaveAttribute('tabindex', '0');
    expect(name(ALPHA.id)).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(name(BETA.id), { key: 'End' });
    expect(document.activeElement).toBe(name(GAMMA.id));
    fireEvent.keyDown(name(GAMMA.id), { key: 'Home' });
    expect(document.activeElement).toBe(name(ALPHA.id));
    fireEvent.keyDown(name(ALPHA.id), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(name(ALPHA.id));
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it('the handle and the row menu trigger share the row’s tab stop', async () => {
    mockBoardApi(fetchMock);
    render(<OrganizationsBoardPage />);
    await flush();
    expect(handle(ALPHA.id)).toHaveAttribute('tabindex', '0');
    expect(handle(BETA.id)).toHaveAttribute('tabindex', '-1');
    expect(desktop().getByTestId(`org-board-more-${ALPHA.id}`)).toHaveAttribute('tabindex', '0');
    expect(desktop().getByTestId(`org-board-more-${BETA.id}`)).toHaveAttribute('tabindex', '-1');
  });

  it('the reorder handle moves the org with the arrow keys, persists the order, and announces the move', async () => {
    mockBoardApi(fetchMock);
    render(<OrganizationsBoardPage />);
    await flush();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Alpha Ltd' }), { key: 'ArrowDown' });
    await flush();
    expect(patches()).toHaveLength(1);
    expect(JSON.parse(String(patches()[0][1]!.body))).toEqual({ orderedIds: [BETA.id, ALPHA.id, GAMMA.id] });
    expect(renderedRowIds()).toEqual([BETA.id, ALPHA.id, GAMMA.id]);
    expect(screen.getByTestId('org-board-reorder-announcement')).toHaveTextContent('Alpha Ltd moved to position 2 of 3');
  });

  it('a held arrow key keeps walking the row: the handle stays mounted and focused while the PATCH is in flight', async () => {
    const holds: Array<(r: Response) => void> = [];
    mockBoardApi(fetchMock, { onOrder: () => new Promise<Response>((resolve) => { holds.push(resolve); }) });
    render(<OrganizationsBoardPage />);
    await flush();
    const alphaHandle = screen.getByRole('button', { name: 'Reorder Alpha Ltd' });
    alphaHandle.focus();
    fireEvent.keyDown(alphaHandle, { key: 'ArrowDown' });
    // Synchronously after the move, before the PATCH settles: same element, still focused, marked busy.
    expect(screen.getByRole('button', { name: 'Reorder Alpha Ltd' })).toBe(alphaHandle);
    expect(document.activeElement).toBe(alphaHandle);
    expect(alphaHandle).toHaveAttribute('aria-busy', 'true');
    holds[0](jsonResponse({ ok: true }));
    await flush();
    fireEvent.keyDown(alphaHandle, { key: 'ArrowUp' });
    holds[1](jsonResponse({ ok: true }));
    await flush();
    expect(patches().map(([, init]) => JSON.parse(String(init!.body)).orderedIds)).toEqual([
      [BETA.id, ALPHA.id, GAMMA.id],
      [ALPHA.id, BETA.id, GAMMA.id],
    ]);
    expect(document.activeElement).toBe(alphaHandle);
  });

  it('Add organization opens a real dialog that Escape closes', async () => {
    mockBoardApi(fetchMock);
    render(<OrganizationsBoardPage />);
    await flush();
    fireEvent.click(screen.getByTestId('org-board-add'));
    const dialog = screen.getByRole('dialog', { name: 'Add organization' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
```

Run: `cd apps/web && npx vitest run src/components/organizations/board/OrganizationsBoardPage.keyboard.test.tsx`
Expected: PASS. Fix the page if not; the page must bend, not the assertions.

- [ ] **Step 2: Reorder reconciliation (drag path, 403 toast, transport ambiguity, no blanking)**

```tsx
// apps/web/src/components/organizations/board/OrganizationsBoardPage.reorder.test.tsx
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OrganizationsBoardPage from './OrganizationsBoardPage';
import { fetchWithAuth, handleSessionExpired } from '@/stores/auth';
import { showToast } from '@/components/shared/Toast';
import { ALPHA, BETA, GAMMA, flush, jsonResponse, mockBoardApi, renderedRowIds } from './boardTestKit';

// … the mock block from Task 10 Step 2, verbatim …

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);
const sessionExpiredMock = vi.mocked(handleSessionExpired);
const desktop = () => within(screen.getByTestId('responsive-table-desktop'));
const listGets = () => fetchMock.mock.calls.filter(([url, init]) => String(url).startsWith('/orgs/organizations?') && init?.method === undefined).length;

/** Drag the desktop row with `sourceId` onto the row with `targetId`. */
function drag(sourceId: string, targetId: string) {
  const dataTransfer = { effectAllowed: '', setData: vi.fn(), dropEffect: '' };
  fireEvent.dragStart(desktop().getByTestId(`org-board-row-${sourceId}`), { dataTransfer });
  fireEvent.dragOver(desktop().getByTestId(`org-board-row-${targetId}`), { dataTransfer });
  fireEvent.drop(desktop().getByTestId(`org-board-row-${targetId}`), { dataTransfer });
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  toastMock.mockReset();
  sessionExpiredMock.mockReset();
  navigateTo.mockReset();
  window.location.hash = '';
  window.localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('OrganizationsBoardPage — the list GET is not a second, poorer redirect', () => {
  it('routes a 401 through handleSessionExpired instead of a bare /login navigation', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ error: 'Unauthorized' }, false, 401));
    render(<OrganizationsBoardPage />);
    await flush();
    expect(sessionExpiredMock).toHaveBeenCalled();
    expect(navigateTo).not.toHaveBeenCalledWith('/login', expect.anything());
  });
});

describe('OrganizationsBoardPage — a failed reorder reconciles with the server', () => {
  it('a drag PATCHes the new order and keeps it on success', async () => {
    mockBoardApi(fetchMock);
    render(<OrganizationsBoardPage />);
    await flush();
    drag(BETA.id, ALPHA.id);
    await flush();
    expect(renderedRowIds()).toEqual([BETA.id, ALPHA.id, GAMMA.id]);
    const patch = fetchMock.mock.calls.find(([url, init]) => String(url) === '/orgs/organizations/order' && init?.method === 'PATCH');
    expect(JSON.parse(String(patch![1]!.body))).toEqual({ orderedIds: [BETA.id, ALPHA.id, GAMMA.id] });
  });

  it('adopts the server order after an ambiguous transport failure that actually committed', async () => {
    const api = mockBoardApi(fetchMock, {
      onOrder: () => {
        api.state.orgs = [BETA, ALPHA, GAMMA]; // the write landed; only the ack was lost
        throw new Error('connection reset');
      },
    });
    render(<OrganizationsBoardPage />);
    await flush();
    const before = listGets();
    drag(BETA.id, ALPHA.id);
    await flush();
    expect(listGets()).toBeGreaterThan(before);
    expect(renderedRowIds()).toEqual([BETA.id, ALPHA.id, GAMMA.id]);
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('restores the server order when the PATCH is rejected with 403, surfacing the server’s message as a toast', async () => {
    mockBoardApi(fetchMock, { onOrder: () => jsonResponse({ error: 'Forbidden' }, false, 403) });
    render(<OrganizationsBoardPage />);
    await flush();
    drag(BETA.id, ALPHA.id);
    expect(renderedRowIds()).toEqual([BETA.id, ALPHA.id, GAMMA.id]); // optimistic
    await flush();
    expect(renderedRowIds()).toEqual([ALPHA.id, BETA.id, GAMMA.id]); // reconciled
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Forbidden' }));
  });

  it('refuses a second reorder while the first is still in flight', async () => {
    let release: ((r: Response) => void) | undefined;
    mockBoardApi(fetchMock, { onOrder: () => new Promise<Response>((resolve) => { release = resolve; }) });
    render(<OrganizationsBoardPage />);
    await flush();
    drag(BETA.id, ALPHA.id);
    await flush();
    const afterFirst = renderedRowIds();
    drag(GAMMA.id, BETA.id); // attempted mid-flight
    expect(renderedRowIds()).toEqual(afterFirst);
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/orgs/organizations/order')).toHaveLength(1);
    release!(jsonResponse({ ok: true }));
    await flush();
  });

  it('reconciles without blanking the table to the skeleton', async () => {
    let releaseGet: (() => void) | undefined;
    let gets = 0;
    const api = mockBoardApi(fetchMock, { onOrder: () => jsonResponse({ error: 'nope' }, false, 500) });
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith('/orgs/organizations?') && init?.method === undefined) {
        gets += 1;
        if (gets > 1) return new Promise<Response>((resolve) => { releaseGet = () => resolve(jsonResponse({ data: api.state.orgs })); });
      }
      return base(input, init);
    });
    render(<OrganizationsBoardPage />);
    await flush();
    drag(BETA.id, ALPHA.id);
    await flush();
    expect(releaseGet).toBeDefined();
    expect(renderedRowIds()).toHaveLength(3);
    expect(screen.queryByTestId('org-board-skeleton')).not.toBeInTheDocument();
    releaseGet!();
    await flush();
    expect(renderedRowIds()).toEqual([ALPHA.id, BETA.id, GAMMA.id]);
  });
});
```

Run: `cd apps/web && npx vitest run src/components/organizations/board/OrganizationsBoardPage.reorder.test.tsx`
Expected: PASS.

- [ ] **Step 3: Row menu inventory, gates, dialogs, workspace marker**

```tsx
// apps/web/src/components/organizations/board/OrganizationsBoardPage.rowMenu.test.tsx
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OrganizationsBoardPage from './OrganizationsBoardPage';
import { fetchWithAuth } from '@/stores/auth';
import { ALPHA, BETA, GAMMA, flush, mockBoardApi, readinessFor, renderedRowIds } from './boardTestKit';

// … the mock block from Task 10 Step 2, verbatim …

const fetchMock = vi.mocked(fetchWithAuth);
const desktop = () => within(screen.getByTestId('responsive-table-desktop'));

function openMenu(id: string) {
  fireEvent.click(desktop().getByTestId(`org-board-more-${id}`));
  return within(screen.getByRole('menu'));
}
const itemIds = (menu: ReturnType<typeof within>) =>
  menu.getAllByRole('menuitem').map((el) => (el.getAttribute('data-testid') ?? '').replace('org-board-menu-', ''));

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  navigateTo.mockReset();
  applyOrgSwitchMock.mockReset();
  store.fetchOrganizations.mockClear();
  window.location.hash = '';
  window.localStorage.clear();
  store.currentOrgId = null;
  store.serviceManagementMode = 'native';
  auth.scope = 'partner';
  auth.permissions = [{ resource: '*', action: '*' }];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('OrganizationsBoardPage — row menu', () => {
  it('lists the full inventory for a partner in native mode with tickets:write', async () => {
    mockBoardApi(fetchMock);
    render(<OrganizationsBoardPage />);
    await flush();
    const menu = openMenu(ALPHA.id);
    expect(itemIds(menu)).toEqual(['open-record', 'contact', 'new-ticket', 'work-here', 'settings', 'archive', 'merge']);
    expect(menu.getAllByRole('separator')).toHaveLength(2);
    expect(menu.getByTestId('org-board-menu-open-record')).toHaveAttribute('href', `/organizations/${ALPHA.id}`);
    const contact = menu.getByTestId('org-board-menu-contact');
    expect(contact).toHaveTextContent('Contact Jane Doe');
    expect(contact).toHaveTextContent('jane@alpha.test · +1 555 0100');
    expect(contact).toHaveAttribute('href', 'mailto:jane@alpha.test');
    expect(menu.getByTestId('org-board-menu-new-ticket')).toHaveAttribute('href', `/tickets/new#orgId=${ALPHA.id}`);
    expect(menu.getByTestId('org-board-menu-merge').className).toContain('text-destructive');
  });

  it('a nameless contact is named by its email; a contact with only a mobile number gets a tel: link', async () => {
    mockBoardApi(fetchMock, {
      readiness: {
        [ALPHA.id]: readinessFor(ALPHA, { account: { primaryContact: { name: null, email: 'ops@alpha.test', phone: null, mobile: null } } }),
        [BETA.id]: readinessFor(BETA, { account: { primaryContact: { name: 'Sam', email: null, phone: null, mobile: '+1 555 0300' } } }),
      },
    });
    render(<OrganizationsBoardPage />);
    await flush();
    const alpha = openMenu(ALPHA.id);
    expect(alpha.getByTestId('org-board-menu-contact')).toHaveTextContent('Contact ops@alpha.test');
    expect(alpha.getByTestId('org-board-menu-contact')).toHaveAttribute('href', 'mailto:ops@alpha.test');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    const beta = openMenu(BETA.id);
    expect(beta.getByTestId('org-board-menu-contact')).toHaveTextContent('Contact Sam');
    expect(beta.getByTestId('org-board-menu-contact')).toHaveAttribute('href', 'tel:+1 555 0300');
  });

  it('hides Contact when there is no primary contact', async () => {
    mockBoardApi(fetchMock, { readiness: { [GAMMA.id]: readinessFor(GAMMA, { account: { primaryContact: null } }) } });
    render(<OrganizationsBoardPage />);
    await flush();
    expect(itemIds(openMenu(GAMMA.id))).not.toContain('contact');
  });

  it('hides New ticket outside native mode', async () => {
    mockBoardApi(fetchMock, { mode: 'external' });
    render(<OrganizationsBoardPage />);
    await flush();
    expect(itemIds(openMenu(ALPHA.id))).not.toContain('new-ticket');
  });

  it('hides New ticket without tickets:write', async () => {
    auth.permissions = [{ resource: 'organizations', action: 'read' }, { resource: 'tickets', action: 'read' }];
    mockBoardApi(fetchMock);
    render(<OrganizationsBoardPage />);
    await flush();
    expect(itemIds(openMenu(ALPHA.id))).not.toContain('new-ticket');
  });

  it('hides Merge outside partner scope', async () => {
    auth.scope = 'organization';
    mockBoardApi(fetchMock);
    render(<OrganizationsBoardPage />);
    await flush();
    const ids = itemIds(openMenu(ALPHA.id));
    expect(ids).toContain('archive');
    expect(ids).not.toContain('merge');
  });

  it('Work in this org switches the workspace; Settings navigates to the org settings page', async () => {
    mockBoardApi(fetchMock);
    render(<OrganizationsBoardPage />);
    await flush();
    fireEvent.click(openMenu(ALPHA.id).getByTestId('org-board-menu-work-here'));
    expect(applyOrgSwitchMock).toHaveBeenCalledWith(ALPHA.id, 'Switched to Alpha Ltd');
    fireEvent.click(openMenu(BETA.id).getByTestId('org-board-menu-settings'));
    expect(navigateTo).toHaveBeenCalledWith(`/settings/organizations/${BETA.id}`);
  });

  it('marks the workspace org’s row and nothing else', async () => {
    store.currentOrgId = BETA.id;
    mockBoardApi(fetchMock);
    render(<OrganizationsBoardPage />);
    await flush();
    expect(within(desktop().getByTestId(`org-board-row-${BETA.id}`)).getByTestId('org-board-workspace-marker')).toHaveTextContent('Workspace');
    expect(within(desktop().getByTestId(`org-board-row-${ALPHA.id}`)).queryByTestId('org-board-workspace-marker')).not.toBeInTheDocument();
    expect(renderedRowIds()).toEqual([ALPHA.id, BETA.id, GAMMA.id]); // marker only, never pinned to the top
  });
});

describe('OrganizationsBoardPage — archive and merge dialogs', () => {
  it('Archive opens the real ArchiveOrgModal; on 202 the row leaves the list and the modal stays on its done summary until Close', async () => {
    mockBoardApi(fetchMock);
    render(<OrganizationsBoardPage />);
    await flush();
    fireEvent.click(openMenu(ALPHA.id).getByTestId('org-board-menu-archive'));
    expect(screen.getByTestId('org-archive-modal')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('org-archive-submit'));
    await flush();
    expect(screen.getByTestId('org-archive-modal')).toBeInTheDocument();
    expect(screen.getByTestId('org-archive-done')).toBeInTheDocument();
    expect(renderedRowIds()).toEqual([BETA.id, GAMMA.id]);
    fireEvent.click(screen.getByTestId('org-archive-close'));
    await flush();
    expect(screen.queryByTestId('org-archive-modal')).not.toBeInTheDocument();
  });

  it('Merge opens MergeOrgModal; completion drops the loser and the summary stays until Close', async () => {
    mockBoardApi(fetchMock);
    render(<OrganizationsBoardPage />);
    await flush();
    fireEvent.click(openMenu(ALPHA.id).getByTestId('org-board-menu-merge'));
    fireEvent.change(screen.getByTestId('org-merge-survivor-select'), { target: { value: BETA.id } });
    await flush();
    fireEvent.change(screen.getByTestId('org-merge-confirm-input'), { target: { value: ALPHA.name } });
    fireEvent.click(screen.getByTestId('org-merge-submit'));
    await flush(); // merge POST (202) + the immediate first poll: 'completed'
    expect(screen.getByTestId('org-merge-modal')).toBeInTheDocument();
    expect(screen.getByTestId('org-merge-done')).toBeInTheDocument();
    expect(renderedRowIds()).toEqual([BETA.id, GAMMA.id]);
    fireEvent.click(screen.getByTestId('org-merge-close'));
    await flush();
    expect(screen.queryByTestId('org-merge-modal')).not.toBeInTheDocument();
  });
});
```

Run: `cd apps/web && npx vitest run src/components/organizations/board/OrganizationsBoardPage.rowMenu.test.tsx`
Expected: PASS.

- [ ] **Step 4: Archived filter and restore**

```tsx
// apps/web/src/components/organizations/board/OrganizationsBoardPage.archived.test.tsx
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OrganizationsBoardPage from './OrganizationsBoardPage';
import { fetchWithAuth } from '@/stores/auth';
import { showToast } from '@/components/shared/Toast';
import { ARCHIVED_ORG, DRAINING_ORG, ALPHA, BETA, GAMMA, flush, mockBoardApi, renderedRowIds } from './boardTestKit';
import { ARCHIVED_SEARCH_DEBOUNCE_MS } from './useArchivedOrganizations';

// … the mock block from Task 10 Step 2, verbatim …

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);
const desktop = () => within(screen.getByTestId('responsive-table-desktop'));
const row = (id: string) => within(desktop().getByTestId(`org-board-row-${id}`));
const archivedFetches = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('includeArchived=true'));
const settle = () => flush(ARCHIVED_SEARCH_DEBOUNCE_MS + 50);

async function openArchived() {
  fireEvent.click(screen.getByTestId('org-board-filter-archived'));
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-13T00:00:00.000Z')); // ARCHIVED_ORG purges exactly 30 days later
  fetchMock.mockReset();
  toastMock.mockReset();
  navigateTo.mockReset();
  store.fetchOrganizations.mockClear();
  window.location.hash = '';
  window.localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('OrganizationsBoardPage — Archived filter', () => {
  it('is always offered, fetches only when applied, and then shows its count', async () => {
    mockBoardApi(fetchMock, { archivedOrgs: [ARCHIVED_ORG] });
    render(<OrganizationsBoardPage />);
    await settle();
    expect(screen.getByTestId('org-board-filter-archived')).toBeInTheDocument();
    expect(screen.queryByTestId('org-board-filter-archived-count')).not.toBeInTheDocument();
    expect(archivedFetches()).toHaveLength(0);
    await openArchived();
    expect(archivedFetches()).toHaveLength(1);
    expect(renderedRowIds()).toEqual([ARCHIVED_ORG.id]);
    expect(screen.getByTestId('org-board-filter-archived-count')).toHaveTextContent('1');
    expect(window.location.hash).toBe('#lens=both&filter=archived');
  });

  it('renders the badge and purge countdown; a draining org reads Archiving…', async () => {
    mockBoardApi(fetchMock, { archivedOrgs: [ARCHIVED_ORG, DRAINING_ORG] });
    render(<OrganizationsBoardPage />);
    await settle();
    await openArchived();
    expect(row(ARCHIVED_ORG.id).getByTestId('org-board-archived-badge')).toHaveTextContent('Archived');
    expect(row(ARCHIVED_ORG.id).getByTestId('org-board-archived-purge')).toHaveTextContent('Purges in 30 days');
    expect(row(DRAINING_ORG.id).getByTestId('org-board-archived-badge')).toHaveTextContent('Archiving…');
    expect(row(DRAINING_ORG.id).getByTestId('org-board-archived-purge')).toHaveTextContent('Kept indefinitely');
    expect(desktop().queryByRole('columnheader', { name: 'Setup' })).not.toBeInTheDocument();
    expect(desktop().queryByTestId('org-board-drag-handle')).not.toBeInTheDocument();
  });

  it('the row menu of an archived row offers Open record and Restore only', async () => {
    mockBoardApi(fetchMock, { archivedOrgs: [ARCHIVED_ORG] });
    render(<OrganizationsBoardPage />);
    await settle();
    await openArchived();
    fireEvent.click(desktop().getByTestId(`org-board-more-${ARCHIVED_ORG.id}`));
    const ids = within(screen.getByRole('menu')).getAllByRole('menuitem').map((el) => el.getAttribute('data-testid'));
    expect(ids).toEqual(['org-board-menu-open-record', 'org-board-menu-restore']);
  });

  it('forwards the search term server-side and narrows the rows; no-match copy differs from empty copy', async () => {
    mockBoardApi(fetchMock, { archivedOrgs: [ARCHIVED_ORG, { ...DRAINING_ORG, name: 'Zeta Archived', status: 'archived' }] });
    render(<OrganizationsBoardPage />);
    await settle();
    await openArchived();
    fireEvent.change(screen.getByTestId('org-board-search'), { target: { value: 'zeta' } });
    await settle();
    expect(String(archivedFetches().at(-1)![0])).toContain('search=zeta');
    expect(renderedRowIds()).toEqual([DRAINING_ORG.id]);
    fireEvent.change(screen.getByTestId('org-board-search'), { target: { value: 'nothing' } });
    await settle();
    expect(screen.getByTestId('org-board-archived-empty')).toHaveTextContent('No archived organizations match your search.');
  });

  it('shows the empty copy when there are truly no archived organizations', async () => {
    mockBoardApi(fetchMock, { archivedOrgs: [] });
    render(<OrganizationsBoardPage />);
    await settle();
    await openArchived();
    expect(screen.getByTestId('org-board-archived-empty')).toHaveTextContent('No archived organizations.');
  });

  it('surfaces archivedTruncated as the note it is today', async () => {
    mockBoardApi(fetchMock, { archivedOrgs: [ARCHIVED_ORG], archivedTruncated: true });
    render(<OrganizationsBoardPage />);
    await settle();
    await openArchived();
    expect(screen.getByTestId('org-board-archived-truncated-note')).toHaveTextContent('Showing the first 1 archived organizations.');
  });
});

describe('OrganizationsBoardPage — restore', () => {
  async function restore(id: string) {
    fireEvent.click(desktop().getByTestId(`org-board-more-${id}`));
    fireEvent.click(screen.getByTestId('org-board-menu-restore'));
    await settle();
  }

  it('on 200, POSTs the specific org, moves it to the live list under its returned status, surfaces recreateRequired and refreshes the store', async () => {
    mockBoardApi(fetchMock, {
      archivedOrgs: [ARCHIVED_ORG],
      onRestore: () => ({ body: { status: 'trial', recreateRequired: ['Agents that completed the archive uninstall must be re-enrolled.'] } }),
    });
    render(<OrganizationsBoardPage />);
    await settle();
    await openArchived();
    await restore(ARCHIVED_ORG.id);
    expect(fetchMock).toHaveBeenCalledWith(`/orgs/organizations/${ARCHIVED_ORG.id}/restore`, { method: 'POST' });
    expect(desktop().queryByTestId(`org-board-row-${ARCHIVED_ORG.id}`)).not.toBeInTheDocument(); // gone from Archived
    fireEvent.click(screen.getByTestId('org-board-filter-all'));
    await settle();
    expect(renderedRowIds()).toEqual([ALPHA.id, BETA.id, GAMMA.id, ARCHIVED_ORG.id]);
    expect(row(ARCHIVED_ORG.id).getByText('Trial')).toBeInTheDocument();
    expect(store.fetchOrganizations).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: expect.stringContaining('re-enrolled') }));
  });

  it('a suspended pre-archive status restores as suspended, with the suspended note', async () => {
    mockBoardApi(fetchMock, { archivedOrgs: [ARCHIVED_ORG], onRestore: () => ({ body: { status: 'suspended', recreateRequired: [] } }) });
    render(<OrganizationsBoardPage />);
    await settle();
    await openArchived();
    await restore(ARCHIVED_ORG.id);
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: expect.stringContaining('suspended') }));
  });

  it('on 410, shows the exact purging-refusal copy and leaves the org archived', async () => {
    mockBoardApi(fetchMock, {
      archivedOrgs: [ARCHIVED_ORG],
      onRestore: () => ({ body: { error: 'Organization is already purging and can no longer be restored' }, status: 410 }),
    });
    render(<OrganizationsBoardPage />);
    await settle();
    await openArchived();
    await restore(ARCHIVED_ORG.id);
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'This organization is already being permanently deleted and can no longer be restored.' }),
    );
    expect(desktop().getByTestId(`org-board-row-${ARCHIVED_ORG.id}`)).toBeInTheDocument();
    expect(store.fetchOrganizations).not.toHaveBeenCalled();
  });

  it('on 409, surfaces the raw backend message verbatim and leaves the org archived', async () => {
    mockBoardApi(fetchMock, {
      archivedOrgs: [ARCHIVED_ORG],
      onRestore: () => ({ body: { error: 'Organization cannot be restored from its current status' }, status: 409 }),
    });
    render(<OrganizationsBoardPage />);
    await settle();
    await openArchived();
    await restore(ARCHIVED_ORG.id);
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Organization cannot be restored from its current status' }));
    expect(desktop().getByTestId(`org-board-row-${ARCHIVED_ORG.id}`)).toBeInTheDocument();
  });
});
```

Run: `cd apps/web && npx vitest run src/components/organizations/board/OrganizationsBoardPage.archived.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run every board suite together**

Run: `cd apps/web && npx vitest run src/components/organizations/board src/lib/orgReadiness.test.ts`
Expected: PASS, no unhandled-rejection warnings.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/organizations/board/OrganizationsBoardPage.keyboard.test.tsx apps/web/src/components/organizations/board/OrganizationsBoardPage.reorder.test.tsx apps/web/src/components/organizations/board/OrganizationsBoardPage.rowMenu.test.tsx apps/web/src/components/organizations/board/OrganizationsBoardPage.archived.test.tsx
git commit -m "test(web): port the organizations page contracts (keyboard, reorder reconciliation, row menu, dialogs, archived, restore) to the board (W02 #5723)"
```

---

### Task 12: Route move, 301 redirect, link sweep, contract registrations, deletion of the split view and its keys

**Files:**
- Create: `apps/web/src/pages/organizations/index.astro`
- Modify: `apps/web/src/pages/settings/organizations/index.astro` (becomes the redirect)
- Modify: `apps/web/src/pages/settings/organization.astro:2`, `apps/web/src/pages/settings/sites/index.astro:2`, `apps/web/src/pages/organizations/[id].astro:6`, `apps/web/src/pages/settings/organizations/[id]/billing.astro:7`, `apps/web/src/pages/settings/index.astro:79`
- Modify: `apps/web/src/components/layout/Sidebar.tsx:200`, `apps/web/src/lib/keyboard/goToShortcuts.ts:19`, `apps/web/src/components/organizations/record/OrganizationRecordPage.tsx:244,255,331`, `apps/web/src/components/settings/OrgSettingsPage.tsx:823,827,873`, `apps/web/src/components/settings/SiteDetailPage.tsx:352,366,387,388,397`, `apps/web/src/components/settings/EnrollmentKeyManager.tsx:876`, `apps/web/src/components/billing/InvoiceEditor.tsx:849`, `apps/web/src/components/devices/AddDeviceModal.tsx:757`, `apps/web/src/lib/orgSwitch.ts:57`, `apps/web/src/lib/routeScope.ts:62`, `apps/web/src/lib/i18n/index.ts:44-57`, `apps/web/src/layouts/DashboardLayout.astro:27`
- Modify tests: `apps/web/src/components/layout/Sidebar.module.test.tsx:56`, `apps/web/src/lib/orgSwitch.test.ts:54-55`, `apps/web/src/lib/routeScope.test.ts:83-85`, `apps/web/src/components/settings/OrgSettingsPage.test.tsx:526`
- Delete: `apps/web/src/components/settings/OrganizationsPage.tsx` and `OrganizationsPage.{actions,archive,archived,firstSite,keyboard,layout,listControls,merge,mutationFeedback,recordLink,scope,deviceCount}.test.tsx`
- Move: `OrganizationsPage.statusMaps.test.tsx` → `apps/web/src/lib/orgStatus.test.ts`; `OrganizationsPage.pagination.test.tsx` → `apps/web/src/lib/fetchAllOrganizations.test.ts`
- Modify: `apps/web/src/components/settings/index.ts:17`, `apps/web/src/components/settings/SiteList.tsx` (drop the `section` variant), `apps/web/src/components/settings/SiteList.test.tsx:19-45`
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts:47-54`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/settings.json` (remove the split-view-only keys)

**Interfaces:**
- Produces: the page at `/organizations`; `/settings/organizations` → 301; `getOrgSwitchRedirect('/organizations/:id') === '/organizations'`; `getRouteScope('/organizations') === 'partner-settings'`; the `no-silent-mutations` adopted set names the two new files.

- [ ] **Step 1: Update the tests that pin the old route (failing)**

- `apps/web/src/components/layout/Sidebar.module.test.tsx:56`: `const ORGANIZATIONS = 'a[href="/organizations"]';`
- `apps/web/src/lib/orgSwitch.test.ts:54-55`: both expectations become `.toBe('/organizations')`.
- `apps/web/src/lib/routeScope.test.ts:83-85`: replace the `it('leaves the bare /organizations prefix unregistered …')` block with:

```ts
  it('classifies the organizations BOARD at the bare /organizations path as partner settings (the org picker itself works fleet-wide)', () => {
    expect(getRouteScope('/organizations')).toBe('partner-settings');
    expect(getRouteScope('/organizations/')).toBe('partner-settings');
  });
```

- `apps/web/src/components/settings/OrgSettingsPage.test.tsx:526`: `expect(restoreLink.getAttribute('href')).toBe('/organizations#filter=archived');`

Run: `cd apps/web && npx vitest run src/components/layout/Sidebar.module.test.tsx src/lib/orgSwitch.test.ts src/lib/routeScope.test.ts src/components/settings/OrgSettingsPage.test.tsx`
Expected: FAIL on exactly those four assertions.

- [ ] **Step 2: Create the page and the redirect**

```astro
---
// apps/web/src/pages/organizations/index.astro
import DashboardLayout from '../../layouts/DashboardLayout.astro';
import OrganizationsBoardPage from '../../components/organizations/board/OrganizationsBoardPage';
---

<DashboardLayout titleKey="titles.organizations">
  <OrganizationsBoardPage client:load />
</DashboardLayout>
```

Replace the whole of `apps/web/src/pages/settings/organizations/index.astro` with the repo's redirect idiom (`pages/settings/organization.astro`):

```astro
---
return Astro.redirect('/organizations', 301);
---
```

Point the two older 301 stubs straight at the new home so nobody pays a double hop: `apps/web/src/pages/settings/organization.astro` and `apps/web/src/pages/settings/sites/index.astro` both become `return Astro.redirect('/organizations', 301);`.

- [ ] **Step 3: Sweep every link, guard and registry**

Apply each edit exactly:

| File:line | Old | New |
|---|---|---|
| `pages/organizations/[id].astro:6` | `Astro.redirect('/settings/organizations')` | `Astro.redirect('/organizations')` |
| `pages/settings/organizations/[id]/billing.astro:7` | same | same |
| `pages/settings/index.astro:79` | `href="/settings/organizations"` | `href="/organizations"` |
| `components/layout/Sidebar.tsx:200` | `href: '/settings/organizations'` | `href: '/organizations'` |
| `lib/keyboard/goToShortcuts.ts:19` | `href: '/settings/organizations'` | `href: '/organizations'` |
| `components/organizations/record/OrganizationRecordPage.tsx:244` and `:255` | `actionHref="/settings/organizations"` | `actionHref="/organizations"` |
| `OrganizationRecordPage.tsx:331` | `navigateTo('/settings/organizations')` | `navigateTo('/organizations')` |
| `components/settings/OrgSettingsPage.tsx:823` and `:827` | `href="/settings/organizations"` | `href="/organizations"` |
| `OrgSettingsPage.tsx:873` | ``href={`/settings/organizations#${displayOrg.id}`}`` | `href="/organizations#filter=archived"` (an archived org lives under the Archived filter, not in the live list a bare-uuid hash highlights) |
| `components/settings/SiteDetailPage.tsx:352` and `:366` | `href="/settings/organizations"` | `href="/organizations"` |
| `SiteDetailPage.tsx:387` | `href: '/settings/organizations'` | `href: '/organizations'` |
| `SiteDetailPage.tsx:388` | ``href: `/settings/organizations#${org.id}` `` | ``href: `/organizations/${org.id}` `` (the org breadcrumb goes to the record) |
| `SiteDetailPage.tsx:397` | ``href={org ? `/settings/organizations#${org.id}` : '/settings/organizations'}`` | ``href={org ? `/organizations/${org.id}` : '/organizations'}`` |
| `components/settings/EnrollmentKeyManager.tsx:876` | `href="/settings/organizations"` | `href="/organizations"` |
| `components/billing/InvoiceEditor.tsx:849` | `href="/settings/organizations"` | `href="/organizations"` |
| `components/devices/AddDeviceModal.tsx:757` | `href="/settings/organizations"` | `href="/organizations"` |
| `lib/orgSwitch.ts:57` | `return '/settings/organizations';` | `return '/organizations';` (and update the comment above it: "→ the organizations board") |

`apps/web/src/lib/routeScope.ts` — insert directly after line 62 (`{ pattern: /^\/organizations\/[^/]+(\/.*)?$/, kind: 'org-record' },`):

```ts
  // The organizations BOARD (account-readiness directory, W02): the org picker
  // itself, so it works fleet-wide like the settings list it replaced.
  { pattern: /^\/organizations\/?$/, kind: 'partner-settings' },
```

`apps/web/src/lib/i18n/index.ts` — add to `localizedDocumentTitleKeys` after the `'/devices'` line:

```ts
  '/organizations': 'nav.organizations',
```

`apps/web/src/layouts/DashboardLayout.astro:27` — make this the first statement of `getAccentClass`:

```ts
  if (path.startsWith('/organizations')) return 'bg-primary';
```

- [ ] **Step 4: Delete the split view and relocate the three re-export tests**

```bash
git rm apps/web/src/components/settings/OrganizationsPage.tsx \
  apps/web/src/components/settings/OrganizationsPage.actions.test.tsx \
  apps/web/src/components/settings/OrganizationsPage.archive.test.tsx \
  apps/web/src/components/settings/OrganizationsPage.archived.test.tsx \
  apps/web/src/components/settings/OrganizationsPage.deviceCount.test.tsx \
  apps/web/src/components/settings/OrganizationsPage.firstSite.test.tsx \
  apps/web/src/components/settings/OrganizationsPage.keyboard.test.tsx \
  apps/web/src/components/settings/OrganizationsPage.layout.test.tsx \
  apps/web/src/components/settings/OrganizationsPage.listControls.test.tsx \
  apps/web/src/components/settings/OrganizationsPage.merge.test.tsx \
  apps/web/src/components/settings/OrganizationsPage.mutationFeedback.test.tsx \
  apps/web/src/components/settings/OrganizationsPage.recordLink.test.tsx \
  apps/web/src/components/settings/OrganizationsPage.scope.test.tsx
git mv apps/web/src/components/settings/OrganizationsPage.statusMaps.test.tsx apps/web/src/lib/orgStatus.test.ts
git mv apps/web/src/components/settings/OrganizationsPage.pagination.test.tsx apps/web/src/lib/fetchAllOrganizations.test.ts
```

Rewrite the two moved files' imports (bodies unchanged):

```ts
// apps/web/src/lib/orgStatus.test.ts — replace the two import lines
import { describe, it, expect } from 'vitest';
import { statusColors, statusLabelKeys } from './orgStatus';
import type { Organization } from '../components/settings/organizationTypes';
```

```ts
// apps/web/src/lib/fetchAllOrganizations.test.ts — replace the import block
import { describe, expect, it, vi } from 'vitest';
import { fetchAllOrganizations, ORGANIZATIONS_MAX_PAGES, ORGANIZATIONS_PAGE_SIZE } from './fetchAllOrganizations';
```

In `apps/web/src/lib/orgStatus.test.ts`, change the `it.each` title from `'OrganizationsPage has a label key and color class for %s'` to `'has a label key and color class for %s'`. (`shouldShowDeviceCount` and `purgeCountdownDays` are covered by `lib/orgReadiness.test.ts` since Task 1.)

`apps/web/src/components/settings/index.ts`: delete line 17 (`export { default as OrganizationsPage } from './OrganizationsPage';`).

`apps/web/src/components/settings/SiteList.tsx` — remove the `section` variant, which only the split view used:
- delete the `variant?: 'card' | 'section';` prop and its doc comment from `SiteListProps`;
- change the signature to `export default function SiteList({ sites, onAddSite, onEdit, onDelete, onSiteClick }: SiteListProps) {`;
- delete `const isSection = variant === 'section';`, replace `const showListChrome = !isSection || sites.length >= SITE_SEARCH_THRESHOLD;` with `const showListChrome = true;` and then simplify: remove the `showListChrome` guards and the `useEffect` that cleared the query (both existed only for the section variant), replace `const Heading = isSection ? 'h3' : 'h2';` and `<Heading className={isSection ? 'text-sm font-semibold' : 'text-lg font-semibold'}>` with a plain `<h2 className="text-lg font-semibold">`, and the root `className={isSection ? '' : 'rounded-lg border bg-card p-6 shadow-xs'}` with `className="rounded-lg border bg-card p-6 shadow-xs"`. Remove the now-unused `useEffect` import if nothing else in the file uses it. `SITE_SEARCH_THRESHOLD` stays exported (`SiteList.test.tsx` imports it).
- `apps/web/src/components/settings/SiteList.test.tsx`: delete the three `section variant …` tests and the `'a search typed above the threshold …'` test (lines 19-45); keep `'card variant (default) …'` and rename it `'keeps its card chrome, h2 heading, count and search'`.

`apps/web/src/lib/__tests__/no-silent-mutations.test.ts` — replace lines 47-54 (the comment and the `'src/components/settings/OrganizationsPage.tsx'` entry) with:

```ts
  // Account board (W02): org create and restore go through runAction in the
  // page; the drag/arrow-key reorder PATCH lives in its own hook. Both are
  // listed because TARGET_GLOBS is a literal file list, not directory-wide.
  'src/components/organizations/board/OrganizationsBoardPage.tsx',
  'src/components/organizations/board/useManualOrder.ts',
```

- [ ] **Step 5: Remove the split-view-only `organizationsPage.*` keys from all eight `settings.json` files**

These 60 keys were used only by the deleted page (58) or by nothing at all (`actions.editOrganization`, `actions.deleting`). Everything else under `organizationsPage` (`actions.tryAgain`, `errors.{generic,saveSite,deleteSite,loadSites}`, `status.*`, `sites.loading`, `siteModal.*`, `deleteSite.*`, `merge.*` except `openButton`, `archive.*`) is still read by `lib/orgStatus.ts`, `ArchiveOrgModal`, `MergeOrgModal`, `useSiteCrud`, `SiteModals` and `OrgSitesTab` and MUST stay.

Run from the repo root:

```bash
node -e '
const fs = require("fs");
const REMOVE = [
  "loading", "title", "description",
  "actions.addOrganization", "actions.editOrganization", "actions.archiveOrganization", "actions.deleting",
  "actions.openRecord", "actions.openSettings", "actions.openSettingsFor", "actions.openRecordFor", "actions.more",
  "errors.fetchOrganizations", "errors.saveOrder", "errors.saveOrganization",
  "deviceCount", "list", "emptySelection", "add", "merge.openButton", "archived", "restore", "scope",
];
for (const locale of ["en", "de-DE", "es-419", "fr-CA", "fr-FR", "it-IT", "pt-BR", "tr-TR"]) {
  const path = `apps/web/src/locales/${locale}/settings.json`;
  const json = JSON.parse(fs.readFileSync(path, "utf8"));
  for (const key of REMOVE) {
    const parts = key.split(".");
    let node = json.organizationsPage;
    for (const part of parts.slice(0, -1)) node = node?.[part];
    if (node) delete node[parts[parts.length - 1]];
  }
  fs.writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
}'
git diff --stat apps/web/src/locales
```

Expected: eight `settings.json` files changed, each by the same number of removed lines (every deletion is inside `organizationsPage`); `git diff apps/web/src/locales/en/settings.json` shows only removals. If the diff shows whitespace churn outside `organizationsPage`, the file's indentation differed from two spaces — revert and remove the keys by hand instead.

- [ ] **Step 6: Run the contracts, the updated tests and the typecheck**

Run: `cd apps/web && npx vitest run src/lib/__tests__/no-silent-mutations.test.ts src/lib/i18n src/lib/routeScope.test.ts src/lib/orgSwitch.test.ts src/lib/orgStatus.test.ts src/lib/fetchAllOrganizations.test.ts src/components/layout/Sidebar.module.test.tsx src/components/settings/OrgSettingsPage.test.tsx src/components/settings/SiteDetailPage.test.tsx src/components/settings/SiteList.test.tsx src/components/organizations/record && npx tsc --noEmit -p tsconfig.json`
Expected: PASS; no type errors; `grep -rn "settings/organizations'" apps/web/src --include='*.tsx' --include='*.ts' --include='*.astro' | grep -v '\.test\.' | grep -v 'settings/organizations/'` prints nothing (only per-org `/settings/organizations/<id>` paths remain).

- [ ] **Step 7: Commit**

```bash
git add -A apps/web/src apps/web/src/pages
git commit -m "feat(web): move the organizations directory to /organizations, 301 the settings path, delete the split view and its keys (W02 #5723)"
```

---

### Task 13: E2E — Page Object and spec, and the record spec's entry step

**Files:**
- Create: `e2e-tests/pages/OrganizationsBoardPage.ts`
- Create: `e2e-tests/tests/organizations-board.spec.ts`
- Modify: `e2e-tests/tests/organization-record.spec.ts:70-75` (step 1 enters from the board)

**Interfaces:**
- Consumes: the page's `data-testid`s (`org-board`, `org-board-row-<id>`, `org-board-chip-<key>`, `org-board-filter-<key>`, `org-board-lens-<key>`, `org-board-more-<id>`, `org-board-band-<key>`, `org-board-menu-open-record`, `org-board-search`), `waitForAppReady` (`e2e-tests/pages/hydration.ts`), `clearRefreshState` (`e2e-tests/test-helpers.ts`), the `authedPage` fixture.

- [ ] **Step 1: Write the Page Object**

```ts
// e2e-tests/pages/OrganizationsBoardPage.ts
import type { Page } from '@playwright/test';
import { waitForAppReady } from './hydration';

/**
 * The organizations account board (`/organizations`, account-board W02).
 * Selectors are `data-testid` only per `e2e-tests/README.md`. Desktop table
 * ids only — the phone cards carry `org-board-card-*` ids and are not modeled.
 */
export class OrganizationsBoardPage {
  constructor(private page: Page) {}

  url = '/organizations';

  root = () => this.page.getByTestId('org-board');
  heading = () => this.page.getByTestId('org-board-heading');
  search = () => this.page.getByTestId('org-board-search');
  row = (orgId: string) => this.page.getByTestId(`org-board-row-${orgId}`);
  chip = (orgId: string, key: string) => this.row(orgId).getByTestId(`org-board-chip-${key}`);
  filter = (key: 'all' | 'setupIncomplete' | 'accountMissing' | 'openTickets' | 'trial' | 'archived') => this.page.getByTestId(`org-board-filter-${key}`);
  lens = (key: 'setup' | 'account' | 'both') => this.page.getByTestId(`org-board-lens-${key}`);
  band = (key: 'all' | 'setupIncomplete' | 'accountMissing' | 'openTickets') => this.page.getByTestId(`org-board-band-${key}`);
  bandCount = (key: 'all' | 'setupIncomplete' | 'accountMissing' | 'openTickets') => this.page.getByTestId(`org-board-band-${key}-count`);
  more = (orgId: string) => this.page.getByTestId(`org-board-more-${orgId}`);
  menuOpenRecord = () => this.page.getByTestId('org-board-menu-open-record');
  columnHeader = (key: 'name' | 'tickets') => this.page.getByTestId(`org-board-sort-${key}`);

  async goto() {
    await this.page.goto(this.url);
    await waitForAppReady(this.page, 'org-board');
  }
}
```

- [ ] **Step 2: Write the spec**

```ts
// e2e-tests/tests/organizations-board.spec.ts
import type { APIRequestContext, Page, Request } from '@playwright/test';
import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import { OrganizationsBoardPage } from '../pages/OrganizationsBoardPage';

/**
 * Organizations account board (W02). One serial test sharing one login and
 * one org created up front — the same reasoning as organization-record.spec.ts:
 * separate tests would each replay the storageState and trip the API's
 * refresh-reuse detection. The org is created inline against the real API;
 * no seeded org fixture exists.
 */
test.describe.configure({ mode: 'serial' });
test.beforeEach(clearRefreshState);

/** Recover the access token the app itself is using (minting one here would rotate the refresh cookie and revoke the page's session). */
async function readAccessToken(page: Page): Promise<string> {
  let token: string | null = null;
  const onRequest = (req: Request) => {
    if (token) return;
    const header = req.headers()['authorization'];
    if (header?.startsWith('Bearer ') && req.url().includes('/api/v1/')) token = header.slice(7);
  };
  page.on('request', onRequest);
  try {
    await page.goto('/');
    await expect.poll(() => token, { message: 'an authenticated /api/v1 request from the app', timeout: 30_000 }).toBeTruthy();
  } finally {
    page.off('request', onRequest);
  }
  return token!;
}

async function apiJson<T>(request: APIRequestContext, token: string, method: 'get' | 'post', path: string, data?: unknown): Promise<T> {
  const res = await request[method](path, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { data }),
  });
  expect(res.ok(), `${method.toUpperCase()} ${path} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

test.describe('organizations board', () => {
  test('lists a new org with its setup chips, filters and lenses it, and opens the record from the row menu', async ({ authedPage: page }, testInfo) => {
    test.setTimeout(120_000);
    const board = new OrganizationsBoardPage(page);
    const token = await readAccessToken(page);
    const stamp = `${Date.now()}-${testInfo.retry}`;
    const org = await apiJson<{ id: string; name: string }>(page.request, token, 'post', '/api/v1/orgs/organizations', {
      name: `E2E Board ${stamp}`,
      slug: `e2e-board-${stamp}`,
    });

    await test.step('1. the board lists the org with a "No devices enrolled" repair chip', async () => {
      await board.goto();
      await expect(board.heading()).toBeVisible();
      await board.search().fill(org.name);
      await expect(board.row(org.id)).toBeVisible();
      const chip = board.chip(org.id, 'noDevices');
      await expect(chip).toBeVisible();
      await expect(chip).toHaveAttribute('href', `/organizations/${org.id}#devices`);
    });

    await test.step('2. the band cell and the filter chip agree, and the Setup incomplete filter keeps the row', async () => {
      await board.search().fill('');
      await expect.poll(async () => (await board.bandCount('setupIncomplete').textContent())?.trim(), { timeout: 30_000 }).not.toBe('—');
      await board.band('setupIncomplete').click();
      await expect(board.band('setupIncomplete')).toHaveAttribute('aria-pressed', 'true');
      await expect(board.filter('setupIncomplete')).toHaveAttribute('aria-pressed', 'true');
      await board.search().fill(org.name);
      await expect(board.row(org.id)).toBeVisible();
      await expect(page).toHaveURL(/#lens=both&filter=setupIncomplete$/);
    });

    await test.step('3. the Account lens hides the Setup chips; a Setup filter forces the lens back to Both', async () => {
      await board.lens('account').click();
      await expect(board.lens('account')).toHaveAttribute('aria-pressed', 'true');
      await expect(board.chip(org.id, 'noDevices')).toHaveCount(0);
      await board.filter('setupIncomplete').click();
      await expect(board.lens('both')).toHaveAttribute('aria-pressed', 'true');
      await expect(board.chip(org.id, 'noDevices')).toBeVisible();
    });

    await test.step('4. the row menu opens the record', async () => {
      await board.more(org.id).click();
      await board.menuOpenRecord().click();
      await page.waitForURL(`**/organizations/${org.id}`);
    });

    await test.step('5. the old settings path redirects to the board', async () => {
      await page.goto('/settings/organizations');
      await page.waitForURL((url) => url.pathname === '/organizations');
      await expect(board.root()).toBeVisible();
    });
  });
});
```

- [ ] **Step 3: Re-point the record spec's entry step**

In `e2e-tests/tests/organization-record.spec.ts`, replace step 1 (`'1. opens from the settings list at /organizations/:id'`) with:

```ts
    await test.step('1. opens from the organizations board at /organizations/:id', async () => {
      await page.goto('/organizations');
      await waitForAppReady(page, 'org-board');
      await page.getByTestId('org-board-search').fill(orgA.name);
      await page.getByTestId(`org-board-row-${orgA.id}`).click();
      await page.waitForURL(`**/organizations/${orgA.id}`);
      await waitForAppReady(page, 'org-record-header');
      await expect(record.header()).toContainText(orgA.name);
    });
```

- [ ] **Step 4: Run both specs against a worktree stack**

```bash
pnpm wt-stack up            # from the worktree root; emits the stack descriptor the Playwright config reads
cd e2e-tests && pnpm test tests/organizations-board.spec.ts tests/organization-record.spec.ts
cd .. && pnpm wt-stack down # nothing reaps the stack for you
```

Expected: both specs PASS. Iterate until green — do not merge a spec that has not been verified against a running stack (`e2e-tests/README.md`).

- [ ] **Step 5: Commit**

```bash
git add e2e-tests/pages/OrganizationsBoardPage.ts e2e-tests/tests/organizations-board.spec.ts e2e-tests/tests/organization-record.spec.ts
git commit -m "test(e2e): organizations board spec and page object; record spec enters from the board (W02 #5723)"
```

---

### Task 14: Full verification, spec cross-check and PR

**Files:**
- No new files. Verification only; fix-forward commits if anything is red.

- [ ] **Step 1: Typecheck and the full web suite**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: 0 type errors; every file green, including the contract scans (`no-silent-mutations`, `no-hash-in-usestate`, `no-envelope-fallthrough`, `no-clipped-tables`, `no-translated-comparisons`, `localeParity`, `translationCoverage`, `keyUsage`, `routeScope`).

- [ ] **Step 2: Build the web app (Astro page and redirect compile)**

Run: `pnpm --filter @breeze/web build`
Expected: succeeds; `dist` contains `organizations/index.html`.

- [ ] **Step 3: Cross-check the spec with fresh eyes**

Walk the spec's W02 surface and confirm each line has a home: Applicability table (Task 1 tests, one `it` per rule) · Page anatomy 1-5 (Task 10 render) · Organization cell (Task 9) · Setup and Account cells (Tasks 1, 8) · Open tickets cell (Task 9) · Row menu incl. gates and archived variant (Task 11 rowMenu + archived) · Filters/lens/sort/URL state (Tasks 2, 10) · States: cold load, batch failure, permission-trimmed, empty, long values (Tasks 9, 10) · Accessibility (Tasks 3, 9, 11 keyboard) · Routes (Task 12) · i18n (Task 4) · Testing bullets (Tasks 1-11, 13). Anything without a home is a fix-forward commit, not a follow-up.

- [ ] **Step 4: Sweep for the incumbent's names**

Run: `grep -rn "OrganizationsPage\b\|organizationsPage\.list\.\|organizationsPage\.archived\.\|organizationsPage\.restore\.\|org-detail-panel\|org-select-" apps/web/src e2e-tests --include='*.ts' --include='*.tsx' --include='*.astro' | grep -v 'OrganizationsBoardPage'`
Expected: no output.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin feature/5721-organizations-account-board/wave-5723
gh pr create --title "feat(web): Organizations account board — /organizations replaces the split view (W02)" --body "$(cat <<'EOF'
Closes #5723

Web half of the Organizations Account Board (spec: docs/superpowers/specs/web-ui/2026-09-13-organizations-account-board-design.md, W02 row).

- New `/organizations` page: Setup · Account data · Open tickets columns, exception-only repair-link chips, Setup/Account/Both lens, filters + roll-up band, Manual order / A to Z / Open tickets sort, `#lens=…&filter=…` hash state, bare `#<uuid>` row highlight.
- Readiness read in 200-id batches, two in flight, latest-wins, per-batch failure → "Unavailable" rows + "partial" band with Try again.
- Manual drag / arrow-key order kept (PATCH via runAction, reorderPending, authoritative refetch, 403 toast).
- Row menu: Open record · Contact (mailto/tel, nameless fallback) · New ticket (native + tickets:write) · Work in this org · Settings · Archive · Merge (partner scope); archived rows: Open record · Restore.
- `/settings/organizations` → 301; sidebar, back-links, guards, accent bar, `getOrgSwitchRedirect`, route scope registry moved.
- Split view deleted (page, 14 tests, `SiteList` section variant, 60 `settings.json` keys); `no-silent-mutations` adopted path updated.
- `orgBoard.*` in all eight locales; `SortableTh` lifted to `components/shared` with a `namespace` prop; `ActionMenu` gains link items, descriptions, separators, trigger tabindex.
- E2E: `organizations-board.spec.ts`.

Not in this wave (W03): Integrations column, connectors, "Unlinked" filter, "No active contract".

pt-BR strings are machine-drafted pending native review
es-419, fr-FR, fr-CA, de-DE, and it-IT strings are machine-drafted pending native review

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Then run the review round (`/pr-review-toolkit:review-pr`) and enqueue with `gh pr merge <N>` once `CI Success` is green — never `--admin`.

---

## Self-review (writing-plans checklist, run 2026-09-13)

**Spec coverage.** Every W02 requirement maps to a task: applicability rules and both chip tables → Task 1; filters/lens/sort/hash → Tasks 2, 10; row menu and gates → Tasks 3, 10, 11; band → Tasks 8, 10; cold load / batch failure / permission-trimmed / empty / long values → Tasks 9, 10; manual order → Tasks 6, 11; archived on demand + `archivedTruncated` → Tasks 7, 11; routes → Task 12; i18n → Task 4; E2E test ids → Task 13; no-silent-mutations, no-hash, i18n contracts → Tasks 10, 12. Deliberately out of scope (W03): Integrations column, connectors, Unlinked filter — the config leaves a typed slot (`BOARD_COLUMNS` 'integrations', `INTEGRATIONS_COLUMN_ENABLED`).

**Placeholder scan.** No TBD/TODO/"similar to". The only placeholders are `5721` and `5723` (issue numbers), as allowed.

**Type consistency.** `deriveReadinessChips(org, readiness, capabilities, mode, now): DerivedChips | null` is used identically in Tasks 1, 9, 10; `BoardRow { org, readiness, state, chips }` in Tasks 2, 8, 9, 10; `ManualOrderApi` fields in Tasks 6, 9, 10; `AccountReadinessState { capabilities, mode, byOrg, rowState, status, retry }` in Tasks 5, 10; `RollupCell`/`RollupStatus` in Tasks 8, 10; `ActionMenuItem.href/description/separatorBefore` and `triggerTabIndex` in Tasks 3, 9, 10; `SortableTh namespace` in Tasks 3, 9; test ids in Tasks 9-13 match the E2E Page Object.

**Ambiguities resolved (recorded so the executor does not re-decide them):**
1. Tickets column/band/filter render only once `capabilities.tickets === true` has arrived; Setup and Account (always-true capabilities) render with skeleton cells from the first paint. Rationale: a column that appears is less jarring than one that vanishes for a partner who never had it.
2. "Contact <name>" is one two-line item whose `href` is `mailto:` when an email exists, else `tel:` with phone-or-mobile; hidden when the contact has neither (not only when there is no contact). Name falls back to email, then number.
3. After Add organization the board highlights the new row (bare-uuid hash) and toasts; the incumbent's "add the first site" dialog is not carried over — sites are the record's job and the row's "No site" chip is the repair link.
4. The stored lens is adopted in a layout effect (not a `useState` initializer) so the SSR HTML and first client render match; the same treatment is applied to the remembered sort, and a stored `'devices'` sort (the retired option) falls back to manual.
5. `useAccountReadiness` keys its generation on the SORTED id set, so a manual reorder never refetches; any change to the set (create, archive, restore, merge) refetches everything (incremental fetch is a follow-up, not needed at 200 ids per request).
6. Archived filter chip count = number of archived rows currently loaded (after the first fetch), including under a search.
7. Old `#<uuid>` deep links that pointed at an ARCHIVED org (`OrgSettingsPage` restore link) now go to `/organizations#filter=archived`; `SiteDetailPage`'s org breadcrumb goes to the record.
8. `getOrgSwitchRedirect('/organizations')` stays `null` (the board re-navigates in place under the new scope).
