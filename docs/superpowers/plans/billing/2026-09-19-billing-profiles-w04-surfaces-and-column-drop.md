---
tracking_issue: LanternOps/breeze#4628
wave_issue: LanternOps/breeze#6335
spec: docs/superpowers/specs/billing/2026-09-17-billing-profiles-work-types-spec.md
wave: W04
blast_radius: medium
---
# Billing Profiles W04: Remaining Surfaces and the Legacy Column Drop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the consolidation — put a work-type picker on the two surfaces that still have none (the mobile app and the Outlook tech add-in), add work-type and included-minutes dimensions to the billing export, write the docs and the release-note text for the permission change, and **drop the six legacy labour-pricing columns** one release after W02 stopped reading them.

**Architecture:** Four independent halves that happen to ship together, ordered so the drop is last:
- **Surfaces** (Tasks 1–3): mobile and the Office add-in gain `workTypeId` on their time writes. Both are thin clients over the same core `timeEntryService`, so there is no new server logic — only a new optional field on two request schemas and two pickers. Until now the card's "All other work" base row covered them (§7); after this wave a technician on a phone can say "on-site".
- **Reporting** (Task 4): the billing CSV and `listBillables` gain `work_type` and `included_minutes` dimensions. The #3198 business report R2 that the spec names **does not exist in this codebase yet** — see the `NOT VERIFIED` marker in Task 4 — so this wave delivers the dimension on the surfaces that do exist and leaves the note on #3198.
- **Words** (Tasks 5–6): `apps/docs` feature pages and the release-note text for the §10 decision 2 permission change ("technicians who typed rates by hand will need the permission or a card").
- **The drop** (Tasks 7–9): six columns, one idempotent migration, and a grep-proven list of every remaining reader. This is last because it is the only irreversible step.

**Tech Stack:** React Native (mobile), React + Office.js (Outlook add-in), Hono + Drizzle (API), hand-written idempotent SQL migrations, Vitest everywhere, Astro/Starlight (`apps/docs`).

**Spec:** `docs/superpowers/specs/billing/2026-09-17-billing-profiles-work-types-spec.md` — §3.6 (removing the old pricing fields, incl. the sweep list), §3.7 + §10 decision 2 (the permission binds everyone; release-noted), §4.3 ("Six columns leave (§3.6) one release after the cut-over"), §4.4 (registration lists), §5 (business reports #3198), §6 (API surface), §7 (mobile and the add-in get pickers in the last wave), §9 (wave list: W04 = "mobile + add-in pickers, report / CSV dimensions, docs, drop the six columns").

## Wave preconditions

W01, W02 **and W03** are merged, and **W02 has been in a shipped release** — §3.6: "The resolver stops reading the columns the day the conversion runs; the columns are dropped one release later." §6: the category and org-ticket-settings APIs "stop accepting the six removed fields (ignored with a deprecation warning for one release, then rejected)" — **this wave is that release**, so Task 7 flips ignore→reject.

> **Amended 2026-09-20 (#6472):** the ignore→reject flip that Task 7 was going to make shipped early, in the #6472 fix PR. The "grace release" never preserved behaviour — the retired writes were already discarded behind a 200 — so the category and org-ticket-settings APIs reject the three retired input fields from v0.116 (v0.115.0 shipped without the fix and still ignores them). "W02 has been in a shipped release" is therefore **not** the gate for this wave. Parts A–C can proceed once W03 is merged. Part D (the drop) is gated on the explicit checks in #6472 instead: no remaining reader of the six columns (Task 7 Step 1), conversion invariants verified on production data, an archive-or-refuse step for legacy rows the conversion skipped (off-list currency orgs; rates whose `rate_currency` differs from the org currency — see `2026-10-24-200200-labour-pricing-conversion.sql` lines 203 and 209-210), and a rollback note that states tenant export fails on the previous image once the columns are gone (`tenantExportPolicy.ts` rejects registry/live column mismatches).

| Artifact | Spec reference | Status |
|---|---|---|
| `work_types` table + `GET /work-types` | §4.2, §6 | `NOT VERIFIED: confirm against merged W01` — route path and response field names |
| `time_entries.work_type_id`, accepted on create / start / update | §4.3, §6 | `NOT VERIFIED: confirm against merged W01/W02` |
| `ticket_categories.default_work_type_id` + the server-side stamp-time default | §3.1 | `NOT VERIFIED: confirm against merged W01` |
| `time_entries.coverage` | §3.4 | `NOT VERIFIED: confirm against merged W02` |
| `resolveBillingRule()` reads no legacy column | §3.6 | Task 7 Step 1 proves this by grep before dropping anything |
| `partners.labour_pricing_converted_at` set for every partner | §3.6 item 5 | Task 8 Step 1 asserts it in production data before the drop |
| `billable_minutes` + `COALESCE` readers | §3.5 | W03 |

**Step 0 of Task 1 is a precondition check that stops the executor** if these are absent.

## Global Constraints

- **Never edit a shipped migration.** Fix forward. Renaming counts as editing (`breeze_migrations` keys on filename).
- **Migration filename must sort after the newest committed migration.** As of 2026-09-19 the newest committed file here is `apps/api/migrations/2026-10-20-140000-tickets-partner-org-composite-fk.sql`, but W01–W03 land files ahead of this wave — **re-check with `ls apps/api/migrations | sort | tail -5` before naming**. This plan uses `2026-10-25-090000-drop-legacy-labour-pricing-columns.sql`. Never an epoch prefix (sorts before all of 2026); never a `2026-08-06-g-` infix (closed date block).
- **Migration idempotency:** `DROP COLUMN IF EXISTS`, `DROP CONSTRAINT IF EXISTS`. A re-apply must be a no-op. No inner `BEGIN;`/`COMMIT;`. This migration writes **no rows**, so no `set_config('breeze.scope','system',true)` is required — but if a step is added that writes rows, it must elect system scope first or the write silently matches zero rows.
- **Export-policy registration (CLAUDE.md):** `org_ticket_settings` is in `CORE_ORG_CASCADE_DELETE_ORDER`, so its `CORE_TENANT_EXPORT_POLICY` entry (`apps/api/src/services/tenantExportPolicyRegistry.ts:422`) enumerates every column. Dropping three of them means **removing three names from that array in the same PR**, or the integration-only `tenant-export-policy.integration.test.ts` fails on a column that no longer exists. `ticket_categories` has no `org_id` and correctly has **no** export-policy entry (verified: `grep -n ticket_categories apps/api/src/services/tenantExportPolicyRegistry.ts` returns nothing), so its three columns need no registry change.
- **Which suites are integration-only** (need real Postgres, **never** run under `pnpm test` and so **cannot** fail the Test API job): everything in `apps/api/src/__tests__/integration/`. The drop touches at least eight of them — Task 9 lists each by path.
- **Test commands:** `cd apps/api && npx vitest run <explicit paths>`. Never `pnpm --filter <pkg> test -- --run <path>` (the `--` is forwarded literally; vitest runs the whole suite in watch mode). Never a trailing-slash directory filter — `vitest run src/routes/auth/` silently skips `src/routes/auth.test.ts`. Integration: `pnpm test-stack up`, then `--config vitest.integration.config.ts`, then `pnpm test-stack down`.
- **Mobile has no i18n layer** (verified: no `useTranslation` / `i18next` under `apps/mobile/src`, no locale files) — mobile strings are inline English. **The Outlook add-in likewise has no locale directory** (verified: `apps/outlook-addin/src/locales` does not exist). Only the *web* app's eight locales (`apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/`) need real translations, and this wave adds web strings only in Task 4.
- **All web mutations go through `runAction`** (`apps/web/src/lib/runAction.ts`). Mobile and the add-in have their own error surfaces (`runAction` is web-only) — use each app's existing pattern.
- **Vocabulary (§5):** never "agreement". The screen is **Rates**; a card is a **billing profile**; the labour label is a **work type**.

---

## File structure

| Path | Responsibility | Half |
|---|---|---|
| `apps/mobile/src/services/workTypes.ts` (+ `.test.ts`) | New. `fetchWorkTypes()` over `coreRequest`, plus a short-lived in-memory cache | Mobile |
| `apps/mobile/src/services/timeEntries.ts` | `CreateTimeEntryInput` / `StartTimerInput` / `UpdateTimeEntryInput` gain `workTypeId?`; `TimeEntry` gains `workTypeId` + `workTypeName` | Mobile |
| `apps/mobile/src/services/timeEntryQueue.ts` (+ `.test.ts`) | The offline queue must carry `workTypeId` through a replay | Mobile |
| `apps/mobile/src/components/WorkTypePicker.tsx` (+ `.test.tsx`) | New. The picker control | Mobile |
| `apps/mobile/src/screens/tickets/TicketDetailScreen.tsx` | MOUNT: picker in the log-time form and the timer start sheet | Mobile |
| `apps/mobile/src/screens/tickets/TicketDetailScreen.test.tsx` | Screen-level mount proof | Mobile |
| `apps/mobile/src/screens/time/SuggestionConfirmSheet.tsx` (+ test) | MOUNT: picker on the AI suggestion confirm path | Mobile |
| `apps/api/src/routes/officeAddin/schemas.ts` | `workTypeId` on `addinLogTimeSchema` (`:104`) and `addinStartTimerSchema` (`:87`) | Add-in |
| `apps/api/src/routes/officeAddin/time.ts` | Pass `workTypeId` through to the service | Add-in |
| `apps/api/src/routes/officeAddin/time.test.ts` | Passthrough + rejection cases | Add-in |
| `apps/api/src/routes/officeAddin/workTypes.ts` (+ test) | New. `GET /office-addin/time/work-types` behind the existing `time-read` capability | Add-in |
| `apps/outlook-addin/src/tech/api.ts` (+ `.test.ts`) | `LogTimeRequest`/`StartTimerRequest` gain `workTypeId?`; new `fetchWorkTypes()` | Add-in |
| `apps/outlook-addin/src/tech/TimeWidget.tsx` (+ `.test.tsx`) | MOUNT: the picker in the manual log form and the start control | Add-in |
| `apps/api/src/services/timeEntryService.ts` | `listBillables` rows gain `workTypeName` and `coverage` | Reporting |
| `apps/api/src/routes/tickets/export.ts` | Two new CSV columns | Reporting |
| `apps/web/src/components/billing/BillablesExportCard.tsx` (+ test) | Column-list copy mentions the new dimensions | Reporting |
| `apps/web/src/locales/*/billing.json` (8 files) | The one new web string | Reporting |
| `apps/docs/src/content/docs/features/rates.mdx` (new) | The Rates screen, work types, minimums and rounding | Docs |
| `apps/docs/src/content/docs/features/ticketing.mdx` | "Categories and SLAs" (`:255`) and "Time Tracking & Parts" (`:299`) rewritten for the new model | Docs |
| `apps/docs/src/content/docs/features/invoices.mdx` | The minimum/rounding note on invoice lines | Docs |
| `docs/release-notes/next-release-draft.md` | The permission-change paragraph | Docs |
| `apps/api/migrations/2026-10-25-090000-drop-legacy-labour-pricing-columns.sql` (new) | The drop | Drop |
| `apps/api/src/db/schema/ticketConfig.ts:43-46`, `apps/api/src/db/schema/tickets.ts:26-29` | Six Drizzle columns removed | Drop |
| `apps/api/src/services/tenantExportPolicyRegistry.ts:422` | Three column names removed from `org_ticket_settings` | Drop |
| `packages/shared/src/validators/ticketConfig.ts:65-66`, `packages/shared/src/validators/tickets.ts:201-202` | Deprecated-ignore → reject | Drop |
| …plus the full reader sweep enumerated in Task 7 | | Drop |

---

# Part A — Surfaces

### Task 1: Mobile — fetch work types and carry `workTypeId` through the write path

**Files:**
- Create: `apps/mobile/src/services/workTypes.ts`, `apps/mobile/src/services/workTypes.test.ts`
- Create: `apps/mobile/src/components/WorkTypePicker.tsx`, `apps/mobile/src/components/WorkTypePicker.test.tsx`
- Modify: `apps/mobile/src/services/timeEntries.ts`
- Modify: `apps/mobile/src/services/timeEntryQueue.ts`, `apps/mobile/src/services/timeEntryQueue.test.ts`

**Interfaces:**
- Consumes: `coreRequest` (`apps/mobile/src/services/api.ts`) — the phone calls the **core** endpoints, not `/api/v1/mobile/*`, exactly as `timeEntries.ts`'s header documents.
- Produces:
  - `export interface WorkType { id: string; name: string; isActive: boolean; sortOrder: number }`
  - `export async function fetchWorkTypes(): Promise<WorkType[]>` — active work types, sorted by `sortOrder` then `name`.
  - `export function WorkTypePicker(props: { workTypes: WorkType[]; value: string | null; onChange: (id: string | null) => void; disabled?: boolean; testID?: string }): JSX.Element`
  - `CreateTimeEntryInput`, `StartTimerInput` and `UpdateTimeEntryInput` each gain `workTypeId?: string | null`; `TimeEntry` gains `workTypeId: string | null` and `workTypeName?: string | null`.

**Why `workTypeId` is optional and `null` is meaningful.** §3.1: when a caller sends **no** `workTypeId` and the entry has a ticket, the service applies the ticket category's default work type *server-side at stamp time*. That is what keeps old mobile builds correctly priced. So "field absent" must stay a distinct state from "explicitly none" — send `undefined` to mean "let the server decide", and `null` only when the technician actively cleared it.

- [ ] **Step 0: Precondition check — stop if W01/W02/W03 have not merged**

```bash
cd /path/to/worktree
grep -n "workTypeId\|work_type_id" apps/api/src/db/schema/tickets.ts
grep -n "billableMinutes" apps/api/src/db/schema/tickets.ts
ls apps/api/src/routes/billingProfiles.ts
grep -rn "work-types" apps/api/src/routes/billingProfiles.ts | head
git log --oneline -20 -- apps/api/migrations | head -20
```
All must succeed, and the last must show W01/W02/W03 migrations. **Record the exact `GET /work-types` response field names** — every `NOT VERIFIED: confirm against merged W01` marker in this plan resolves to them. If anything is missing, **stop** and report which wave has not merged.

Also confirm W02 shipped in a release before dropping columns later in this plan:

```bash
gh release list --limit 10
git tag --contains "$(git log --format=%H -1 --grep='#4628 W02' | head -1)" | head
```
> `NOT VERIFIED: confirm W02 is in a shipped release tag before Task 8 runs.` If it is not, do Parts A–C and leave Part D (the drop) for the next release.

- [ ] **Step 1: Write the failing service test**

```ts
// apps/mobile/src/services/workTypes.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const coreRequest = vi.fn();
vi.mock('./api', () => ({ coreRequest: (...a: unknown[]) => coreRequest(...a) }));

import { fetchWorkTypes, __resetWorkTypeCacheForTests } from './workTypes';

beforeEach(() => { coreRequest.mockReset(); __resetWorkTypeCacheForTests(); });

describe('fetchWorkTypes', () => {
  it('calls the core work-types endpoint and returns only ACTIVE types', async () => {
    coreRequest.mockResolvedValue({ workTypes: [
      { id: 'wt-2', name: 'On-site', isActive: true, sortOrder: 2 },
      { id: 'wt-x', name: 'Retired', isActive: false, sortOrder: 0 },
      { id: 'wt-1', name: 'Remote', isActive: true, sortOrder: 1 },
    ] });
    const types = await fetchWorkTypes();
    expect(coreRequest).toHaveBeenCalledWith('/work-types');
    expect(types.map((w) => w.id)).toEqual(['wt-1', 'wt-2']);
  });

  it('sorts by sortOrder then name, so two types at the same rank are still stable', async () => {
    coreRequest.mockResolvedValue({ workTypes: [
      { id: 'b', name: 'Beta', isActive: true, sortOrder: 0 },
      { id: 'a', name: 'Alpha', isActive: true, sortOrder: 0 },
    ] });
    expect((await fetchWorkTypes()).map((w) => w.name)).toEqual(['Alpha', 'Beta']);
  });

  it('caches within the TTL so a picker opening twice does not re-hit the network', async () => {
    coreRequest.mockResolvedValue({ workTypes: [] });
    await fetchWorkTypes();
    await fetchWorkTypes();
    expect(coreRequest).toHaveBeenCalledTimes(1);
  });

  it('returns an empty list rather than throwing when the partner has no work types', async () => {
    coreRequest.mockResolvedValue({ workTypes: [] });
    await expect(fetchWorkTypes()).resolves.toEqual([]);
  });

  it('propagates a transport error — the caller decides whether to hide the picker', async () => {
    coreRequest.mockRejectedValue(new Error('offline'));
    await expect(fetchWorkTypes()).rejects.toThrow('offline');
  });
});
```

> `NOT VERIFIED: confirm against merged W01` — the path `/work-types` and the envelope key `workTypes`. §6 mounts work types on `routes/billingProfiles.ts` as `GET /work-types`; confirm the mount prefix in `apps/api/src/index.ts` and adjust the literal here if the external path differs.

- [ ] **Step 2: Run and watch it fail**

```bash
cd apps/mobile && npx vitest run src/services/workTypes.test.ts
```
Expected: FAIL — cannot resolve `./workTypes`.

- [ ] **Step 3: Write the service**

```ts
// apps/mobile/src/services/workTypes.ts
import { coreRequest } from './api';

/**
 * Work types for the phone's pickers (#4628 §7 — mobile gets a picker in the
 * last wave; until this shipped, every mobile entry fell to the card's "All
 * other work" base row or the ticket category's server-side default).
 *
 * `/api/v1/mobile/*` has no billing routes, so this calls the core endpoint
 * with the token the app already holds — the same approach as
 * `services/timeEntries.ts` and `services/tickets.ts`.
 *
 * Rates are NEVER computed on the phone. This returns labels only; the server
 * resolves the card row and stamps the money (§3.3, §3.4).
 */
export interface WorkType {
  id: string;
  name: string;
  isActive: boolean;
  sortOrder: number;
}

const TTL_MS = 5 * 60_000;
let cache: { at: number; value: WorkType[] } | null = null;

/** @internal test seam */
export function __resetWorkTypeCacheForTests(): void {
  cache = null;
}

export async function fetchWorkTypes(): Promise<WorkType[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const res = (await coreRequest('/work-types')) as { workTypes?: WorkType[] };
  const value = (res.workTypes ?? [])
    .filter((w) => w.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  cache = { at: Date.now(), value };
  return value;
}
```

- [ ] **Step 4: Extend the time-entry types**

In `apps/mobile/src/services/timeEntries.ts`, add to `TimeEntry` (after `description`):

```ts
  /** #4628 — the label the technician picked. The server stamps the money. */
  workTypeId: string | null;
  workTypeName?: string | null;
```

and to `CreateTimeEntryInput`, `StartTimerInput` and `UpdateTimeEntryInput`:

```ts
  /**
   * #4628 §3.1. OMIT the field to let the server apply the ticket category's
   * default work type at stamp time — that is what keeps older builds priced
   * correctly. Send `null` only when the technician actively cleared it.
   */
  workTypeId?: string | null;
```

> `NOT VERIFIED: confirm against merged W01` — the exact input interface names in this file; read the file and match them.

- [ ] **Step 5: Carry it through the offline queue**

`apps/mobile/src/services/timeEntryQueue.ts` enqueues creates and stops for replay. Add `workTypeId` to the queued payload type and to whatever serialisation the queue performs, then pin it:

```ts
// apps/mobile/src/services/timeEntryQueue.test.ts (append)
it('a queued create replays with the workTypeId the technician picked (#4628 W04)', async () => {
  await enqueueCreate({ ticketId: 'tk-1', startedAt: ISO_A, endedAt: ISO_B, description: 'On-site fix', workTypeId: 'wt-onsite' });
  const sent = await drainQueueCapturingRequests();
  expect(sent[0].body).toMatchObject({ workTypeId: 'wt-onsite' });
});

it('a queued create with NO workTypeId replays without the field, so the server default still applies (#4628 §3.1)', async () => {
  await enqueueCreate({ ticketId: 'tk-1', startedAt: ISO_A, endedAt: ISO_B, description: 'Something' });
  const sent = await drainQueueCapturingRequests();
  expect(sent[0].body).not.toHaveProperty('workTypeId');
});
```

> `NOT VERIFIED` — `enqueueCreate` / `drainQueueCapturingRequests` are this file's existing helpers; match their real names.

- [ ] **Step 6: Write the picker and its test**

```tsx
// apps/mobile/src/components/WorkTypePicker.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react-native';
import { WorkTypePicker } from './WorkTypePicker';

const TYPES = [
  { id: 'wt-1', name: 'Remote', isActive: true, sortOrder: 1 },
  { id: 'wt-2', name: 'On-site', isActive: true, sortOrder: 2 },
];

describe('WorkTypePicker', () => {
  it('renders one option per work type plus a "Default" option', () => {
    const { getByTestId } = render(<WorkTypePicker workTypes={TYPES} value={null} onChange={() => {}} testID="wt" />);
    expect(getByTestId('wt-option-default')).toBeTruthy();
    expect(getByTestId('wt-option-wt-1')).toBeTruthy();
    expect(getByTestId('wt-option-wt-2')).toBeTruthy();
  });

  it('reports the chosen id', () => {
    const onChange = vi.fn();
    const { getByTestId } = render(<WorkTypePicker workTypes={TYPES} value={null} onChange={onChange} testID="wt" />);
    fireEvent.press(getByTestId('wt-option-wt-2'));
    expect(onChange).toHaveBeenCalledWith('wt-2');
  });

  it('"Default" reports undefined, NOT null — so the server applies the category default (#4628 §3.1)', () => {
    const onChange = vi.fn();
    const { getByTestId } = render(<WorkTypePicker workTypes={TYPES} value={'wt-2'} onChange={onChange} testID="wt" />);
    fireEvent.press(getByTestId('wt-option-default'));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('renders nothing at all when the partner has no work types — no empty control', () => {
    const { queryByTestId } = render(<WorkTypePicker workTypes={[]} value={null} onChange={() => {}} testID="wt" />);
    expect(queryByTestId('wt')).toBeNull();
  });
});
```

Then write `WorkTypePicker.tsx` to satisfy exactly that: a horizontal row of pressable chips, one per type plus a leading "Default" chip; `testID={`${testID}-option-${id}`}`; returns `null` when `workTypes.length === 0`; the selected chip carries `accessibilityState={{ selected: true }}`. Match the styling of the existing chip/segment control in `apps/mobile/src/components/` — read one before writing.

> Adjust `onChange`'s signature to `(id: string | null | undefined) => void` so "Default" can report `undefined`.

- [ ] **Step 7: Run and watch it all pass**

```bash
cd apps/mobile && npx vitest run \
  src/services/workTypes.test.ts \
  src/services/timeEntryQueue.test.ts \
  src/components/WorkTypePicker.test.tsx
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/src/services/workTypes.ts apps/mobile/src/services/workTypes.test.ts \
        apps/mobile/src/services/timeEntries.ts \
        apps/mobile/src/services/timeEntryQueue.ts apps/mobile/src/services/timeEntryQueue.test.ts \
        apps/mobile/src/components/WorkTypePicker.tsx apps/mobile/src/components/WorkTypePicker.test.tsx
git commit -m "feat(mobile): work-type service, types and picker control (#4628 W04)"
```

---

### Task 2: Mobile MOUNT — put the picker on the screens that log time

**Files:**
- Modify: `apps/mobile/src/screens/tickets/TicketDetailScreen.tsx`
- Modify: `apps/mobile/src/screens/time/SuggestionConfirmSheet.tsx`
- Test: `apps/mobile/src/screens/tickets/TicketDetailScreen.test.tsx`, `apps/mobile/src/screens/time/SuggestionConfirmSheet.test.tsx`

**Interfaces:**
- Consumes: `fetchWorkTypes`, `WorkTypePicker` (Task 1).
- Produces: nothing new — this is the composition step.

**This task exists because a wave that builds a component and never wires it into the page is this repo's known failure mode.** Task 1's tests render the picker directly; these tests render the *screen* and assert the picker appears and its value reaches the request body.

- [ ] **Step 1: Write the failing screen tests**

```tsx
// apps/mobile/src/screens/tickets/TicketDetailScreen.test.tsx (append)
describe('work-type picker (#4628 W04)', () => {
  it('MOUNT: the log-time form renders the picker from a real work-types fetch', async () => {
    mockCoreRequest('/work-types', { workTypes: [{ id: 'wt-1', name: 'Remote', isActive: true, sortOrder: 1 }] });
    const { findByTestId } = renderTicketDetail({ ticketId: 'tk-1' });
    fireEvent.press(await findByTestId('log-time-button'));
    expect(await findByTestId('log-time-work-type-option-wt-1')).toBeTruthy();
  });

  it('MOUNT: the chosen work type reaches the POST body', async () => {
    mockCoreRequest('/work-types', { workTypes: [{ id: 'wt-1', name: 'Remote', isActive: true, sortOrder: 1 }] });
    const { findByTestId, getByTestId } = renderTicketDetail({ ticketId: 'tk-1' });
    fireEvent.press(await findByTestId('log-time-button'));
    fireEvent.press(getByTestId('log-time-work-type-option-wt-1'));
    fireEvent.changeText(getByTestId('log-time-description'), 'Reset the switch');
    fireEvent.press(getByTestId('log-time-submit'));
    const post = await lastCoreRequestFor('/time-entries');
    expect(post.body).toMatchObject({ workTypeId: 'wt-1' });
  });

  it('leaving the picker on Default omits workTypeId entirely (§3.1 server-side category default)', async () => {
    mockCoreRequest('/work-types', { workTypes: [{ id: 'wt-1', name: 'Remote', isActive: true, sortOrder: 1 }] });
    const { findByTestId, getByTestId } = renderTicketDetail({ ticketId: 'tk-1' });
    fireEvent.press(await findByTestId('log-time-button'));
    fireEvent.changeText(getByTestId('log-time-description'), 'Reset the switch');
    fireEvent.press(getByTestId('log-time-submit'));
    const post = await lastCoreRequestFor('/time-entries');
    expect(post.body).not.toHaveProperty('workTypeId');
  });

  it('a work-types fetch failure hides the picker and does NOT block logging time', async () => {
    mockCoreRequestFailure('/work-types', new Error('offline'));
    const { findByTestId, queryByTestId, getByTestId } = renderTicketDetail({ ticketId: 'tk-1' });
    fireEvent.press(await findByTestId('log-time-button'));
    expect(queryByTestId('log-time-work-type')).toBeNull();
    fireEvent.changeText(getByTestId('log-time-description'), 'Reset the switch');
    fireEvent.press(getByTestId('log-time-submit'));
    await expect(lastCoreRequestFor('/time-entries')).resolves.toBeTruthy();
  });

  it('MOUNT: starting a timer also carries the chosen work type (timers are priced at START, §3.7)', async () => {
    mockCoreRequest('/work-types', { workTypes: [{ id: 'wt-2', name: 'On-site', isActive: true, sortOrder: 2 }] });
    const { findByTestId, getByTestId } = renderTicketDetail({ ticketId: 'tk-1' });
    fireEvent.press(await findByTestId('start-timer-button'));
    fireEvent.press(getByTestId('start-timer-work-type-option-wt-2'));
    fireEvent.press(getByTestId('start-timer-confirm'));
    const post = await lastCoreRequestFor('/time-entries/start');
    expect(post.body).toMatchObject({ workTypeId: 'wt-2' });
  });
});
```

```tsx
// apps/mobile/src/screens/time/SuggestionConfirmSheet.test.tsx (append)
it('MOUNT: confirming an AI time suggestion carries a work type (#4628 W04)', async () => {
  mockCoreRequest('/work-types', { workTypes: [{ id: 'wt-1', name: 'Remote', isActive: true, sortOrder: 1 }] });
  const { findByTestId, getByTestId } = renderSuggestionConfirmSheet({ suggestionId: 's-1' });
  fireEvent.press(await findByTestId('suggestion-work-type-option-wt-1'));
  fireEvent.press(getByTestId('suggestion-confirm'));
  const post = await lastCoreRequestFor('/time-entries/suggestions/confirm');
  expect(post.body).toMatchObject({ workTypeId: 'wt-1' });
});
```

> `NOT VERIFIED` — `renderTicketDetail`, `mockCoreRequest`, `lastCoreRequestFor`, and every `testID` above. Read both screens first and **use the testIDs that already exist** for the log-time form, submit button and timer sheet; only the `-work-type-*` ones are new. The suggestions-confirm endpoint is `/time-entries/suggestions/confirm` (`apps/mobile/src/services/timeSuggestions.ts:178`).

- [ ] **Step 2: Run and watch them fail**

```bash
cd apps/mobile && npx vitest run src/screens/tickets/TicketDetailScreen.test.tsx src/screens/time/SuggestionConfirmSheet.test.tsx
```
Expected: FAIL — no such testID.

- [ ] **Step 3: Mount the picker on both screens**

In each screen, load work types once on mount and fail soft:

```tsx
  const [workTypes, setWorkTypes] = useState<WorkType[]>([]);
  const [workTypeId, setWorkTypeId] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    // Fail soft: a technician must always be able to log time. A work-types
    // fetch failure hides the picker; the server then applies the ticket
    // category's default work type at stamp time (#4628 §3.1).
    fetchWorkTypes()
      .then((types) => { if (!cancelled) setWorkTypes(types); })
      .catch(() => { if (!cancelled) setWorkTypes([]); });
    return () => { cancelled = true; };
  }, []);
```

Render `<WorkTypePicker workTypes={workTypes} value={workTypeId ?? null} onChange={setWorkTypeId} testID="log-time-work-type" />` above the description field, and include the field in the request body **only when it is defined**:

```tsx
  await createTimeEntry({
    ticketId,
    startedAt,
    endedAt,
    description,
    // Omitted when the technician left it on Default (#4628 §3.1).
    ...(workTypeId !== undefined ? { workTypeId } : {}),
  });
```

Repeat for the timer sheet (`testID="start-timer-work-type"`) and `SuggestionConfirmSheet` (`testID="suggestion-work-type"`).

- [ ] **Step 4: Run and watch them pass**

```bash
cd apps/mobile && npx vitest run src/screens src/services src/components
```
Expected: PASS. Check the reported **file count** — a bare substring filter can pull in unrelated matches.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/screens/tickets/TicketDetailScreen.tsx apps/mobile/src/screens/tickets/TicketDetailScreen.test.tsx \
        apps/mobile/src/screens/time/SuggestionConfirmSheet.tsx apps/mobile/src/screens/time/SuggestionConfirmSheet.test.tsx
git commit -m "feat(mobile): mount the work-type picker on log-time, timer start and AI confirm (#4628 W04)"
```

---

### Task 3: Office add-in — `workTypeId` on the two write endpoints, and the picker

**Files:**
- Modify: `apps/api/src/routes/officeAddin/schemas.ts:87-115`
- Modify: `apps/api/src/routes/officeAddin/time.ts`
- Create: `apps/api/src/routes/officeAddin/workTypes.ts`
- Test: `apps/api/src/routes/officeAddin/time.test.ts` (extend), `apps/api/src/routes/officeAddin/workTypes.test.ts` (new)
- Modify: `apps/outlook-addin/src/tech/api.ts`, `apps/outlook-addin/src/tech/api.test.ts`
- Modify: `apps/outlook-addin/src/tech/TimeWidget.tsx`, `apps/outlook-addin/src/tech/TimeWidget.test.tsx`

**Interfaces:**
- Consumes: `createTimeEntry` / `startTimer` from `timeEntryService` (already imported at `apps/api/src/routes/officeAddin/time.ts:5-12`); `requireAddinCapability('time-read')`.
- Produces:
  - `addinLogTimeSchema` and `addinStartTimerSchema` gain `workTypeId: z.string().uuid().optional()`.
  - `GET /office-addin/time/work-types` → `{ workTypes: Array<{ id, name }> }`.
  - `apps/outlook-addin/src/tech/api.ts`: `LogTimeRequest.workTypeId?: string`, `StartTimerRequest.workTypeId?: string`, and `export async function fetchWorkTypes(fetchImpl?: FetchLike): Promise<{ workTypes: AddinWorkType[] }>`.

**Note on the override gate.** §3.7 enforces `time_entries:manage_billing` **in the service**, via `manageBilling` on `TimeEntryActor` — precisely because the add-in "passes billing fields straight through and would bypass a route gate". The add-in's actor builder hardcodes `manageAll: false` (`apps/api/src/routes/officeAddin/time.ts:35-44`); confirm W02 gave it a `manageBilling` field there too, and that it is **not** hardcoded `true`.

- [ ] **Step 1: Write the failing API tests**

```ts
// apps/api/src/routes/officeAddin/time.test.ts (append)
describe('work type on add-in time writes (#4628 W04)', () => {
  it('POST /office-addin/time/log passes workTypeId through to createTimeEntry', async () => {
    createTimeEntryMock.mockResolvedValue({ id: 'te-1' });
    const res = await request('/office-addin/time/log', {
      ticketId: TICKET_ID, startedAt: ISO_A, endedAt: ISO_B,
      description: 'On-site fix', workTypeId: WORK_TYPE_ID,
    });
    expect(res.status).toBe(201);
    expect(createTimeEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ workTypeId: WORK_TYPE_ID }),
      expect.anything()
    );
  });

  it('omitting workTypeId leaves the field OFF the service input, so the category default applies (§3.1)', async () => {
    createTimeEntryMock.mockResolvedValue({ id: 'te-1' });
    await request('/office-addin/time/log', { ticketId: TICKET_ID, startedAt: ISO_A, endedAt: ISO_B, description: 'x' });
    const [input] = createTimeEntryMock.mock.calls[0];
    expect(input).not.toHaveProperty('workTypeId');
  });

  it('a non-uuid workTypeId is a 400, not a silently dropped field', async () => {
    const res = await request('/office-addin/time/log', {
      ticketId: TICKET_ID, startedAt: ISO_A, endedAt: ISO_B, description: 'x', workTypeId: 'Remote',
    });
    expect(res.status).toBe(400);
  });

  it('POST /office-addin/time/start passes workTypeId through — timers are priced at START (§3.7)', async () => {
    startTimerMock.mockResolvedValue({ id: 'te-2', ticketId: TICKET_ID, startedAt: new Date(), description: null });
    await request('/office-addin/time/start', { ticketId: TICKET_ID, workTypeId: WORK_TYPE_ID });
    expect(startTimerMock).toHaveBeenCalledWith(
      expect.objectContaining({ workTypeId: WORK_TYPE_ID }),
      expect.anything()
    );
  });

  it('the add-in actor does NOT hold manageBilling — the service gate must still bind it (§3.7)', async () => {
    createTimeEntryMock.mockResolvedValue({ id: 'te-1' });
    await request('/office-addin/time/log', { ticketId: TICKET_ID, startedAt: ISO_A, endedAt: ISO_B, description: 'x' });
    const [, actor] = createTimeEntryMock.mock.calls[0];
    expect(actor.manageBilling).toBe(false);
    expect(actor.manageAll).toBe(false);
  });
});
```

```ts
// apps/api/src/routes/officeAddin/workTypes.test.ts (new)
describe('GET /office-addin/time/work-types (#4628 W04)', () => {
  it('returns the partner\'s active work types as id + name only', async () => {
    listWorkTypesMock.mockResolvedValue([
      { id: 'wt-1', name: 'Remote', isActive: true, sortOrder: 1, partnerId: PARTNER_ID, notes: 'internal' },
    ]);
    const res = await get('/office-addin/time/work-types');
    expect(res.status).toBe(200);
    // Narrow projection on purpose: the add-in needs a label, not the card.
    expect(await res.json()).toEqual({ workTypes: [{ id: 'wt-1', name: 'Remote' }] });
  });

  it('requires the time-read capability', async () => {
    const res = await get('/office-addin/time/work-types', { capabilities: [] });
    expect(res.status).toBe(403);
  });
});
```

> `NOT VERIFIED: confirm against merged W01` — `listWorkTypes`'s module path and signature. Read `apps/api/src/routes/billingProfiles.ts` and reuse whatever service function it calls; do **not** query `work_types` directly from this route.

- [ ] **Step 2: Run and watch them fail**

```bash
cd apps/api && npx vitest run src/routes/officeAddin/time.test.ts src/routes/officeAddin/workTypes.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Extend the schemas**

`apps/api/src/routes/officeAddin/schemas.ts` — add to `addinStartTimerSchema` (`:87`) and to the object inside `addinLogTimeSchema` (`:105`):

```ts
    /**
     * #4628 §3.1. OMIT to let the server apply the ticket category's default
     * work type at stamp time; that is what kept pre-W04 add-in builds priced
     * correctly and is still the right behaviour for "I didn't say".
     */
    workTypeId: z.string().uuid().optional(),
```

- [ ] **Step 4: Pass it through and add the read route**

In `apps/api/src/routes/officeAddin/time.ts`, thread `workTypeId` into the `createTimeEntry` / `startTimer` calls with the same `...(v !== undefined ? { workTypeId: v } : {})` spread used on mobile — never `workTypeId: body.workTypeId ?? null`, which would turn "unspecified" into "explicitly none" and lose every category default.

Create `apps/api/src/routes/officeAddin/workTypes.ts` following `time.ts`'s structure exactly (router, `officeAddinTechAuthMiddleware`, `requireAddinCapability('time-read')`), projecting to `{ id, name }`, and mount it in `apps/api/src/routes/officeAddin/index.ts` under `/time`.

- [ ] **Step 5: Extend the add-in client and mount the picker**

`apps/outlook-addin/src/tech/api.ts` — add `workTypeId?: string` to `LogTimeRequest` (`:268-272`) and to the start-timer request type, plus:

```ts
export interface AddinWorkType { id: string; name: string; }

/** GET /office-addin/time/work-types — labels for the TimeWidget picker (#4628). */
export async function fetchWorkTypes(fetchImpl?: FetchLike): Promise<{ workTypes: AddinWorkType[] }> {
  return (await get('/office-addin/time/work-types', {}, fetchImpl)) as { workTypes: AddinWorkType[] };
}
```

> `NOT VERIFIED` — this file's internal `get` helper name; `post` exists at `:279`, so read the file and use the matching read helper.

Then in `TimeWidget.tsx`, MOUNT a `<select>` labelled "Work type" in both the manual log form and beside the start control, defaulting to an empty option whose value means *omit the field* — mirroring the tri-state treatment the widget's own header already documents for `isBillable` ("the field is omitted from the `logTime` request entirely unless the technician actually clicks it"). Hide the select when `workTypes` is empty or the fetch failed; a 403 already hides the whole widget (`TimeWidget.tsx:58-61`), so reuse that `forbidden` path rather than adding a second one.

- [ ] **Step 6: Write the MOUNT test for the widget**

```tsx
// apps/outlook-addin/src/tech/TimeWidget.test.tsx (append)
it('MOUNT: the manual log form renders a work-type select from the real endpoint (#4628 W04)', async () => {
  mockJson('/office-addin/time/work-types', { workTypes: [{ id: 'wt-1', name: 'Remote' }] });
  mockJson('/office-addin/time/running', { running: null });
  render(<TimeWidget linkedTicket={{ id: 'tk-1', internalNumber: 'T-1' }} onBanner={() => {}} />);
  const select = await screen.findByLabelText('Work type');
  expect(within(select).getByRole('option', { name: 'Remote' })).toBeInTheDocument();
});

it('MOUNT: the chosen work type reaches the logTime body', async () => {
  mockJson('/office-addin/time/work-types', { workTypes: [{ id: 'wt-1', name: 'Remote' }] });
  mockJson('/office-addin/time/running', { running: null });
  const posted = capturePosts('/office-addin/time/log');
  render(<TimeWidget linkedTicket={{ id: 'tk-1', internalNumber: 'T-1' }} onBanner={() => {}} />);
  await userEvent.selectOptions(await screen.findByLabelText('Work type'), 'wt-1');
  await userEvent.type(screen.getByLabelText(/description/i), 'Reset the switch');
  await userEvent.type(screen.getByLabelText(/duration/i), '30');
  await userEvent.click(screen.getByRole('button', { name: /log/i }));
  expect(posted()[0]).toMatchObject({ workTypeId: 'wt-1' });
});

it('leaving the select on its blank option omits workTypeId (§3.1)', async () => {
  mockJson('/office-addin/time/work-types', { workTypes: [{ id: 'wt-1', name: 'Remote' }] });
  mockJson('/office-addin/time/running', { running: null });
  const posted = capturePosts('/office-addin/time/log');
  render(<TimeWidget linkedTicket={{ id: 'tk-1', internalNumber: 'T-1' }} onBanner={() => {}} />);
  await userEvent.type(await screen.findByLabelText(/description/i), 'Reset the switch');
  await userEvent.type(screen.getByLabelText(/duration/i), '30');
  await userEvent.click(screen.getByRole('button', { name: /log/i }));
  expect(posted()[0]).not.toHaveProperty('workTypeId');
});

it('a work-types fetch failure hides the select and still lets the technician log time', async () => {
  mockFailure('/office-addin/time/work-types', 500);
  mockJson('/office-addin/time/running', { running: null });
  render(<TimeWidget linkedTicket={{ id: 'tk-1', internalNumber: 'T-1' }} onBanner={() => {}} />);
  await screen.findByLabelText(/description/i);
  expect(screen.queryByLabelText('Work type')).not.toBeInTheDocument();
});
```

> `NOT VERIFIED` — `mockJson`, `capturePosts`, `mockFailure` and the existing field labels; read the top of `TimeWidget.test.tsx` and match its conventions. A `<select>` with no matching option silently reads `''` (a known repo trap) — the blank-option assertion above is what catches that.

- [ ] **Step 7: Run and watch them pass**

```bash
cd apps/api && npx vitest run src/routes/officeAddin
cd ../outlook-addin && npx vitest run src/tech
```
Expected: PASS both.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/officeAddin apps/outlook-addin/src/tech
git commit -m "feat(office-addin): work-type picker and workTypeId on log/start (#4628 W04)"
```

---

# Part B — Reporting dimensions

### Task 4: Work-type and included-minutes dimensions on the billing export

**Files:**
- Modify: `apps/api/src/services/timeEntryService.ts` — `listBillables` (`:1323`), `BillableRowBase` (`:1290`)
- Modify: `apps/api/src/routes/tickets/export.ts` (`CSV_HEADERS` at `:12`, the row builder at `:31-38`)
- Test: `apps/api/src/services/timeEntryService.test.ts`, `apps/api/src/routes/tickets/export.test.ts`
- Modify: `apps/web/src/components/billing/BillablesExportCard.tsx` (+ test)
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/billing.json`

**Interfaces:**
- Consumes: `time_entries.work_type_id`, `time_entries.coverage`, `time_entries.billable_minutes` (W01/W02/W03); `work_types.name`.
- Produces: `BillableRowBase` gains `workTypeName: string | null` and `coverage: 'billable' | 'included' | 'non_billable' | null`; `BillableRow` for `kind: 'time'` gains `includedMinutes: number` (0 for a non-included row). The CSV gains two columns, **appended** to the end of `CSV_HEADERS`.

**Why appended, not inserted.** The billables CSV is a file customers and accountants already have import mappings for. New columns go at the **end** so an existing column-index mapping keeps working. `kind: 'part'` rows get empty strings for both — a part has no work type.

> **`NOT VERIFIED: the #3198 "R2" business report does not exist in this repo.** Spec §5 says "R2 gains a work-type group-by and an included-minutes column". A search for a business-report R2 surface found none (`apps/api/src/services/` has `endpointManagementReport`, `hardwareLifecycleReport`, `identityAccessReport`, `managementPostureReport`, `contractCurrencyReportService` — none is the #3198 business review). **Verify against #3198 before starting.** If R2 has since shipped, add the group-by there as well, following whatever dimension pattern that report uses. If it has not, this task delivers the dimension on the surfaces that exist today (the billables CSV and `listBillables`) and the executor posts a note on #3198 recording that `time_entries.work_type_id` and `coverage` are available and that R2 owes the group-by — which is what §5 asks for ("note goes on #3198 at registration").

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/timeEntryService.test.ts (append)
describe('listBillables work-type and coverage dimensions (#4628 W04)', () => {
  it('joins the work type name onto time rows', async () => {
    queueBillableTimeRows([{
      date: new Date('2026-03-03T09:00:00Z'), orgName: 'Acme', ticketNumber: 'T-1',
      description: 'On-site', technician: 'Pat', minutes: 60, billableMinutes: 60,
      rate: '225.00', currencyCode: 'USD', billingStatus: 'not_billed', isApproved: true,
      workTypeName: 'On-site', coverage: 'billable',
    }]);
    const { rows } = await listBillables(FROM, TO);
    expect(rows[0]).toMatchObject({ workTypeName: 'On-site', coverage: 'billable', includedMinutes: 0 });
  });

  it('an entry with no work type reports null, not an empty string', async () => {
    queueBillableTimeRows([{ /* …as above… */ workTypeName: null, coverage: 'billable' }]);
    const { rows } = await listBillables(FROM, TO);
    expect(rows[0].workTypeName).toBeNull();
  });

  it('an INCLUDED entry reports its minutes as includedMinutes and still adds no money', async () => {
    queueBillableTimeRows([{
      date: new Date('2026-03-03T09:00:00Z'), orgName: 'Acme', ticketNumber: 'T-1',
      description: 'Covered remote', technician: 'Pat', minutes: 45, billableMinutes: 45,
      rate: null, currencyCode: 'USD', billingStatus: 'contract', isApproved: true,
      workTypeName: 'Remote', coverage: 'included',
    }]);
    const { rows, totalsByCurrency } = await listBillables(FROM, TO);
    expect(rows[0]).toMatchObject({ coverage: 'included', includedMinutes: 45, amount: '0.00' });
    expect(totalsByCurrency).toEqual([]);
  });

  it('part rows carry no work type and no included minutes', async () => {
    queueBillablePartRows([{ /* an ordinary part row */ }]);
    const { rows } = await listBillables(FROM, TO);
    expect(rows[0]).toMatchObject({ kind: 'part', workTypeName: null, coverage: null });
  });
});
```

```ts
// apps/api/src/routes/tickets/export.test.ts (append)
it('the billables CSV appends work_type and included_minutes as the LAST two columns (#4628 W04)', async () => {
  listBillablesMock.mockResolvedValue({ rows: [{
    kind: 'time', date: new Date('2026-03-03T09:00:00Z'), orgName: 'Acme', ticketNumber: 'T-1',
    description: 'On-site', technician: 'Pat', quantity: '1.00', rate: '225.00', amount: '225.00',
    currencyCode: 'USD', billingStatus: 'not_billed', isApproved: true,
    workTypeName: 'On-site', coverage: 'billable', includedMinutes: 0,
  }], totalsByCurrency: [] });
  const csv = await (await get('/tickets/export/billables.csv?from=…&to=…')).text();
  const [header, row] = csv.split('\n');
  // Appended, never inserted: existing importers map by column index.
  expect(header.endsWith('work_type,included_minutes')).toBe(true);
  expect(row.endsWith('On-site,0')).toBe(true);
});

it('a part row leaves both new columns empty', async () => {
  listBillablesMock.mockResolvedValue({ rows: [{
    kind: 'part', date: new Date('2026-03-03T09:00:00Z'), orgName: 'Acme', ticketNumber: 'T-1',
    description: 'SSD', technician: 'Pat', quantity: '1', rate: '200.00', amount: '200.00',
    currencyCode: 'USD', billingStatus: 'not_billed', isApproved: null,
    workTypeName: null, coverage: null, includedMinutes: 0,
  }], totalsByCurrency: [] });
  const csv = await (await get('/tickets/export/billables.csv?from=…&to=…')).text();
  expect(csv.split('\n')[1].endsWith(',,')).toBe(true);
});
```

> `NOT VERIFIED` — `export.test.ts` may not exist yet (`apps/api/src/routes/tickets/export.ts` has no co-located test in this worktree). If so, create it, following the harness in `apps/api/src/routes/tickets/parts.test.ts`.

- [ ] **Step 2: Run and watch them fail**

```bash
cd apps/api && npx vitest run src/services/timeEntryService.test.ts src/routes/tickets/export.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/api/src/services/timeEntryService.ts` — add to `BillableRowBase` (`:1290`):

```ts
  /** #4628 — the labour label, or null for a part / an entry with none. */
  workTypeName: string | null;
  /** #4628 §3.4 — the card row's coverage as stamped; null for a part. */
  coverage: 'billable' | 'included' | 'non_billable' | null;
```

and to the `kind: 'time'` variant: `includedMinutes: number;`.

In the `timeRows` select (`:1345`), `leftJoin(workTypes, eq(timeEntries.workTypeId, workTypes.id))` and project `workTypeName: workTypes.name, coverage: timeEntries.coverage`. In the row builder (`:1301`):

```ts
    const billedMinutes = (r.billableMinutes ?? r.minutes) ?? 0;
    rows.push({
      kind: 'time',
      …
      workTypeName: r.workTypeName,
      coverage: r.coverage,
      // Only an `included` row contributes included minutes; everything else
      // reports 0 so the column sums cleanly in a spreadsheet.
      includedMinutes: r.coverage === 'included' ? billedMinutes : 0,
```

Part rows get `workTypeName: null, coverage: null`.

`apps/api/src/routes/tickets/export.ts:12` — append to `CSV_HEADERS`:

```ts
const CSV_HEADERS = ['type', 'date', 'organization', 'ticket', 'description', 'technician', 'quantity', 'rate', 'amount', 'currency', 'billing_status', 'approved',
  // #4628 W04 — APPENDED, never inserted: existing importers map by column index.
  'work_type', 'included_minutes'];
```

and to the row push:

```ts
        r.isApproved === null ? '' : String(r.isApproved),
        r.workTypeName ?? '',
        r.kind === 'time' ? String(r.includedMinutes) : ''
```

- [ ] **Step 4: Update the web export card copy + 8 locales**

`apps/web/src/locales/en/billing.json`, under the `billablesExport` object:

```json
    "columnsNote": "Includes work type and contract-included minutes for each time entry."
```

with real translations:

| Locale | `columnsNote` |
|---|---|
| `de-DE` | `"Enthält für jeden Zeiteintrag die Tätigkeitsart und die vertraglich enthaltenen Minuten."` |
| `es-419` | `"Incluye el tipo de trabajo y los minutos cubiertos por el contrato de cada registro de tiempo."` |
| `fr-CA` | `"Comprend le type de travail et les minutes incluses au contrat pour chaque saisie de temps."` |
| `fr-FR` | `"Comprend le type de travail et les minutes incluses au contrat pour chaque saisie de temps."` |
| `it-IT` | `"Include il tipo di lavoro e i minuti inclusi nel contratto per ogni voce di tempo."` |
| `pt-BR` | `"Inclui o tipo de trabalho e os minutos cobertos pelo contrato de cada lançamento de tempo."` |
| `tr-TR` | `"Her zaman kaydı için çalışma türünü ve sözleşmeye dahil dakikaları içerir."` |

Render it in `BillablesExportCard.tsx` and pin it with a test. This is a read-only note — no new mutation, so no `runAction` change.

- [ ] **Step 5: Post the #3198 note**

```bash
gh issue comment 3198 --body "#4628 W04 landed \`time_entries.work_type_id\` and \`time_entries.coverage\`, plus \`billable_minutes\` (W03). The billables CSV now carries \`work_type\` and \`included_minutes\`. R2 still owes the work-type group-by and the included-minutes column from the billing-profiles spec §5."
```

- [ ] **Step 6: Run and watch them pass**

```bash
cd apps/api && npx vitest run src/services/timeEntryService.test.ts src/routes/tickets/export.test.ts
cd ../web && npx vitest run src/components/billing/BillablesExportCard.test.tsx src/lib/i18n
```
Expected: PASS, including `localeParity` / `translationCoverage` / `keyUsage`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/timeEntryService.ts apps/api/src/routes/tickets/export.ts \
        apps/api/src/services/timeEntryService.test.ts apps/api/src/routes/tickets/export.test.ts \
        apps/web/src/components/billing/BillablesExportCard.tsx apps/web/src/components/billing/BillablesExportCard.test.tsx \
        apps/web/src/locales/*/billing.json
git commit -m "feat(billing): work-type and included-minutes dimensions on the billables export (#4628 W04)"
```

---

# Part C — Docs and release notes

### Task 5: `apps/docs` — the Rates page and the ticketing rewrite

**Files:**
- Create: `apps/docs/src/content/docs/features/rates.mdx`
- Modify: `apps/docs/src/content/docs/features/ticketing.mdx` — "Categories and SLAs" (`:255`), "Time Tracking & Parts" (`:299`)
- Modify: `apps/docs/src/content/docs/features/invoices.mdx`

**Interfaces:** none — prose. But the prose is a contract with the release note in Task 6 and must use the §5 vocabulary: **Rates** (screen), **billing profile** (card), **work type** (label), **never "agreement"**.

- [ ] **Step 1: Write `rates.mdx`**

Follow the frontmatter and component conventions of a sibling page — read `apps/docs/src/content/docs/features/contracts.mdx` first and match its `title` / `description` frontmatter and its use of Starlight components. Cover, in this order:

1. **What the screen is** — Settings → Billing → Rates. Rows are billing profiles, columns are work types, plus an "All other work" column. A cell reads `$150`, `Included`, `Non-billable` or `$225 · 1 h min`.
2. **Work types** — a label for what the work was, picked on the time entry, so one ticket can mix remote and on-site. A ticket category may name a default work type, applied server-side when nobody picks one.
3. **Which card an organization uses** — the one assigned to it, otherwise the partner's default for that organization's currency. One card per organization; no inheritance, no fall-through. A card in the wrong currency is never used and never converted.
4. **Coverage** — *Billable at $X* / *Included* / *Non-billable*. Included time appears on the ticket and in the customer portal as contract-covered, carries no rate, and **does not draw down an hour block**.
5. **Minimums and rounding** — a minimum is per row ("on-site has a one-hour minimum"); rounding is one increment for the whole card ("we bill in 15-minute blocks"). Worked time is always recorded exactly; the invoice line says both ("On-site — 0.50 h worked, 1.00 h billed"). Timesheets and utilization report time *worked*.
6. **Stamping** — the card's terms are copied onto the entry when it is created. Editing a card, archiving it or reassigning an organization **never** re-prices an entry that already exists. Changing the entry's own work type does re-price it.
7. **Deviating from the card** — needs `time_entries:manage_billing`; the entry is then flagged as overridden for the approval queue.
8. **What moved** — the three rate fields are gone from ticket categories, and the labour section is gone from an organization's ticket settings. Existing settings were converted into cards automatically.

- [ ] **Step 2: Rewrite the two `ticketing.mdx` sections**

- "Categories and SLAs" (`:255`) — remove the default-billable / default-rate / rate-currency prose; replace with one paragraph: a category may name a **default work type**, and pricing lives on the Rates screen (link to `rates.mdx`).
- "Time Tracking & Parts" (`:299`) — add the work-type picker and the one-line outcome ("Included in Silver", "$225/h · 1 h minimum"); note that the rate input is read-only without `time_entries:manage_billing`.

- [ ] **Step 3: Add the invoice note to `invoices.mdx`**

One short subsection under the time-entry line discussion: a line's quantity is the **billed** quantity after the card's minimum and rounding; when it differs from the time worked, the line says so; there is still exactly one line per time entry.

- [ ] **Step 4: Build the docs**

```bash
cd apps/docs && pnpm astro check && pnpm build
```
Expected: PASS, no broken links. (A docs-only change would skip the code jobs in CI, but this PR is not docs-only, so the full suite runs.)

- [ ] **Step 5: Commit**

```bash
git add apps/docs/src/content/docs/features/rates.mdx \
        apps/docs/src/content/docs/features/ticketing.mdx \
        apps/docs/src/content/docs/features/invoices.mdx
git commit -m "docs: Rates screen, work types, minimums and rounding (#4628 W04)"
```

---

### Task 6: Release-note text for the permission change and the column drop

**Files:**
- Modify: `docs/release-notes/next-release-draft.md`

**Interfaces:** none — but this text is the *only* warning self-hosters and partners get before a technician loses the ability to type a rate. §10 decision 2 chose option **A** precisely on the condition that it is "called out in the release notes", and §3.6 requires the dry-run report to reach self-hosters the same way.

- [ ] **Step 1: Add the entry**

Append to `docs/release-notes/next-release-draft.md`, matching the file's existing heading structure:

```markdown
### Billing profiles: labour pricing now lives in one place

**Action required for some partners.**

Rates, minimums and rounding now come from a **billing profile** — a rate card on
**Settings → Billing → Rates**. Rows are profiles, columns are work types.

- **Typing a rate on a time entry now needs the `time_entries:manage_billing`
  permission.** Partner Admin roles hold it already (they carry `*:*`). Any other
  role whose technicians set rates by hand must be granted it in the role editor,
  or those technicians must be given a rate card that prices their work. Nothing
  reconciles this for you — check your roles before upgrading.
- **The three rate fields on ticket categories and the labour section of an
  organization's ticket settings are gone.** They were converted into billing
  profiles in the previous release; **this release drops the underlying columns.**
  If you query `ticket_categories.default_billable`, `default_hourly_rate` or
  `rate_currency`, or `org_ticket_settings.default_billable`,
  `default_hourly_rate` or `rate_currency` from a report or an integration,
  repoint it at the billing-profile tables before upgrading.
- **Uncategorised tickets in an organization that never set a billable default
  used to be silently non-billable.** They are now priced by the profile's
  "All other work" row. The conversion's dry-run report named every affected
  organization; if you did not read it before the previous release, review those
  organizations' recent entries now.
- **Minimums and rounding** apply per entry. Time worked is still recorded
  exactly — timesheets and utilization report worked time; invoices report the
  billed quantity, and the line says both.
- Mobile and the Outlook add-in now have work-type pickers.
```

- [ ] **Step 2: Commit**

```bash
git add docs/release-notes/next-release-draft.md
git commit -m "docs(release): billing-profiles permission change and legacy column drop (#4628 W04)"
```

---

# Part D — The drop

### Task 7: Remove every remaining reader of the six columns

**Files:** the sweep below. **Do this before the migration** — dropping a column that code still selects is a runtime 42703, not a compile error, on any code path Drizzle builds dynamically.

**Interfaces:**
- Produces: zero references to `defaultBillable` / `default_billable` / `defaultHourlyRate` / `default_hourly_rate` / `rateCurrency` / `rate_currency` on `ticket_categories` or `org_ticket_settings` outside `apps/api/migrations/` (shipped migrations keep theirs — never edit a shipped migration).

**The verified reader list**, from `grep -rn '<name>' --include='*.ts' --include='*.tsx' --include='*.json' --include='*.sql' apps packages ee` at the time of writing (419 hits across 50 files). **Re-run the grep after W02** — W02's "legacy fields out of the UI and API" step removes many of these; what remains is this task's work.

| File:line | What it is | W04 action |
|---|---|---|
| `apps/api/src/db/schema/ticketConfig.ts:43,45,46` | `orgTicketSettings.defaultHourlyRate` / `.rateCurrency` (NOT NULL) / `.defaultBillable` | **Delete all three properties** |
| `apps/api/src/db/schema/tickets.ts:26,27,29` | `ticketCategories.defaultBillable` (NOT NULL DEFAULT true) / `.defaultHourlyRate` / `.rateCurrency` | **Delete all three properties** and the `rateCurrency` comment at `:28` |
| `apps/api/src/services/tenantExportPolicyRegistry.ts:422` | `org_ticket_settings` `included` array | **Remove `"default_hourly_rate"`, `"default_billable"`, `"rate_currency"`** — required; `tenant-export-policy.integration.test.ts` fails on a classified column that no longer exists |
| `apps/api/src/services/timeEntryService.ts:197,204-206,233-237,265,267` | `getCategoryDefaults`, `resolveDefaultRate`, `resolveTicketLink` | W02 should have replaced these with `resolveBillingRule()`. **If any remain, delete them**; `resolveDefaultRate` is exported and imported by `timeEntryService.test.ts:149` — remove it there too. §9 keeps a legacy resolver "as a test-only fixture" — if W02 moved it into the parity test, leave that copy alone and delete only the production one |
| `apps/api/src/services/ticketConfigService.ts:195-205,624-633,649-651,680,690-728` | `getOrgBillingDefaults` read, upsert, and the `rate_currency` restamp `CASE` | **Delete the billing half**; SLA handling stays. `:728`'s `.values({ orgId, rateCurrency: orgCurrencyCode, … })` must lose `rateCurrency` or the insert fails on a dropped column |
| `apps/api/src/routes/orgTicketSettings.ts:65` | the pre-transaction stale-read comment about stamping `rate_currency` | **Delete the comment and whatever it guards** |
| `apps/api/src/routes/ticketCategories.ts:77,197-208,274-298` | POST/PATCH currency stamping | **Delete the whole stamping block**; `partnerCurrency()` may become unused here — remove it if so |
| `apps/api/src/services/orgCurrencyService.ts:62,297-307,331-332` | readiness `orgDefaultRate` warning | §3.6: **rewritten** as "assigned card currency mismatch" — reads `org_billing_profile_assignments` + `billing_profiles.currency_code`. `NOT VERIFIED: confirm W02 already did this rewrite`; if it did not, it belongs here, and the response field rename is an **API contract change** its consumer must follow |
| `apps/web/src/components/billing/OrgBillingSettings.tsx:35,390` | consumes `orgDefaultRate.rateCurrency` | Follow whatever shape the rewritten readiness response has |
| `apps/web/src/components/settings/OrgTicketSettingsEditor.tsx:22,23,25,95,97,98,133,134,137,141,142` | the labour section | §3.6/§7: **SLA only.** W02 should have done this; verify and finish |
| `apps/web/src/components/settings/TicketCategoriesPage.tsx:22-26,39,40,108-113,139,224,225,233,246,247,509,510,516-522` | three pricing fields | §3.6/§7: replaced by one "Default work type" select. W02 should have done this; verify and finish |
| `apps/web/src/locales/*/settings.json` (8 files) | `ticketCategoriesPage.defaultHourlyRate` and siblings | **Delete the orphaned keys in all eight.** `keyUsage` fails on an unused key |
| `packages/shared/src/validators/ticketConfig.ts:58,65,66` | `defaultHourlyRate`, `defaultBillable` on the org ticket-settings schema | §6: this release **rejects** them. Remove the fields and add a `.strict()`-equivalent rejection (see Step 2) |
| `packages/shared/src/validators/tickets.ts:194,201,202` | `defaultBillable`, `defaultHourlyRate` on the category schema | Same |
| `packages/shared/src/validators/ticketConfig.test.ts`, `tickets.test.ts` | validator cases for the removed fields | Replace with rejection cases |
| `apps/api/src/services/aiTimeEntryProposal.ts:31-32` | comment describing the legacy chain | **Rewrite the comment** to name `resolveBillingRule()` |
| `apps/api/src/services/timeEntryService.test.ts`, `ticketConfigService.test.ts`, `orgCurrencyService.test.ts`, `aiTimeEntryProposal.test.ts`, `ticketCategories.test.ts`, `orgTicketSettings.test.ts` | unit fixtures | Update or delete the affected cases |
| `apps/web/src/components/settings/OrgTicketSettingsEditor.test.tsx`, `TicketCategoriesPage.test.tsx`, `apps/web/src/components/billing/OrgBillingSettings.test.tsx` | web fixtures | Same |
| `apps/api/src/__tests__/integration/ticketingCurrencyMigration.integration.test.ts`, `ticketingCurrencyBackfill.integration.test.ts` | **assert the constraints this migration drops** | §3.6 names these two explicitly. Rewrite them to assert the constraints existed *historically* via `breeze_migrations`, or delete the assertions that reference dropped columns. **These are integration-only — they cannot fail the Test API job** |
| `apps/api/src/__tests__/integration/orgCurrencyChange.integration.test.ts`, `orgCurrencyCreationBarrier.integration.test.ts`, `orgMerge.integration.test.ts`, `ticket-config-rls.integration.test.ts`, `orgStampingDefaultsErrorMapping.integration.test.ts`, `time-entries-rls.integration.test.ts`, `aiTimeEntryProposal.integration.test.ts`, `multiCurrencyWave6TicketAssembly.integration.test.ts`, `multiCurrencyWave6VoidReissue.integration.test.ts` | seed the columns | Remove the column from every seed insert |
| `apps/api/migrations/2026-06-09-a-native-ticketing-core.sql`, `2026-06-13-a-ticketing-configuration.sql`, `2026-08-30-ticketing-currency.sql` | shipped | **Never edit.** Their statements are `IF NOT EXISTS`-guarded and re-apply as no-ops against a database where the column has since been dropped — the drop is forward-only |

**No MCP tool, seed or script reads these columns** (§3.6, confirmed by the grep: no hits under `apps/api/src/services/aiTools*.ts`, `apps/api/scripts/`, or any seed file).

- [ ] **Step 1: Prove the production readers are gone before touching anything**

```bash
cd /path/to/worktree
grep -rn "defaultBillable\|default_billable\|defaultHourlyRate\|default_hourly_rate\|rateCurrency\|rate_currency" \
  --include="*.ts" --include="*.tsx" apps packages ee \
  | grep -v node_modules | grep -v "/migrations/" | grep -v "\.test\." | grep -v "__tests__"
```
Write the output into the PR body. Every line must be handled by this task; a line you cannot explain is a reader you are about to break.

- [ ] **Step 2: Flip the validators from ignore to reject (red first)**

```ts
// packages/shared/src/validators/ticketConfig.test.ts (replace the deprecated-field cases)
it('REJECTS the removed labour fields — one release after they were ignored (#4628 §6)', () => {
  const r = orgTicketSettingsUpdateSchema.safeParse({ slaOverrides: {}, defaultHourlyRate: 150 });
  expect(r.success).toBe(false);
  if (!r.success) expect(r.error.issues[0].message).toMatch(/billing profile/i);
});

it('accepts a body with no labour fields at all', () => {
  expect(orgTicketSettingsUpdateSchema.safeParse({ slaOverrides: {} }).success).toBe(true);
});
```

```ts
// packages/shared/src/validators/tickets.test.ts (same treatment)
it('REJECTS defaultBillable / defaultHourlyRate on a category (#4628 §6)', () => {
  expect(ticketCategoryCreateSchema.safeParse({ name: 'Network', defaultBillable: true }).success).toBe(false);
  expect(ticketCategoryCreateSchema.safeParse({ name: 'Network', defaultHourlyRate: 150 }).success).toBe(false);
});
```

Run them (`cd packages/shared && npx vitest run src/validators/ticketConfig.test.ts src/validators/tickets.test.ts`) and watch them **fail** — today Zod *strips* unknown keys (both files say so at `ticketConfig.ts:58` and `tickets.ts:194`), so the parses currently succeed.

Then implement, using a `superRefine` rather than `.strict()` so the message names the replacement instead of an anonymous "Unrecognized key":

```ts
/** #4628 §6: the six labour-pricing fields were ignored with a deprecation
 *  warning for one release and are rejected from this one. */
const REMOVED_LABOUR_FIELDS = ['defaultBillable', 'defaultHourlyRate', 'rateCurrency'] as const;

function rejectRemovedLabourFields(value: Record<string, unknown>, ctx: z.RefinementCtx) {
  for (const key of REMOVED_LABOUR_FIELDS) {
    if (key in value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} was removed — labour pricing now lives on a billing profile (Settings → Billing → Rates).`,
      });
    }
  }
}
```

Attach it as `.passthrough().superRefine(rejectRemovedLabourFields)` on both schemas. **The `.passthrough()` is load-bearing:** in Zod 4 an object schema's default `strip` mode removes undeclared keys *before* `superRefine` runs, so a bare `.superRefine(...)` never sees the removed field and the request is silently accepted — exactly the regression this task closes (verified against the repo's zod@^4). The red test in Step 1 is the proof: it must go red without `.passthrough()` and green with it. Because passthrough now lets *other* unknown keys reach the handler, the route must keep building its update from named fields only (never spread the parsed body into `.set()`); add a test that an unrelated unknown key is not persisted.
> `NOT VERIFIED: confirm against merged W02` — the exact schema export names in both validator files.

- [ ] **Step 3: Work the sweep table top to bottom**

Delete each reader. After every few files: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit` — TypeScript is the cheap half of this sweep, and the Drizzle schema deletions will surface most of it.

- [ ] **Step 4: Verify the sweep is complete**

```bash
grep -rn "defaultBillable\|default_billable\|defaultHourlyRate\|default_hourly_rate\|rateCurrency\|rate_currency" \
  --include="*.ts" --include="*.tsx" --include="*.json" apps packages ee \
  | grep -v node_modules | grep -v "/migrations/"
```
Expected: **empty**, except for any copy kept deliberately inside the W02 parity test's legacy-resolver fixture (§9). Anything else is a missed reader.

- [ ] **Step 5: Typecheck everything and run the unit suites**

```bash
pnpm --filter @breeze/shared build
cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit
cd ../web && npx tsc --noEmit
cd ../.. && pnpm --filter @breeze/shared test --run
pnpm --filter @breeze/api test --run
pnpm --filter @breeze/web test --run
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(billing): remove every reader of the six legacy labour-pricing columns (#4628 W04)"
```

---

### Task 8: The drop migration

**Files:**
- Create: `apps/api/migrations/2026-10-25-090000-drop-legacy-labour-pricing-columns.sql`

**Interfaces:**
- Produces: `ticket_categories` and `org_ticket_settings` without their three labour columns each; the CHECK and FKs from `2026-08-30-ticketing-currency.sql` that depended on them, gone.

Postgres drops a CHECK and an FK automatically when a column they depend on is dropped, so the explicit `DROP CONSTRAINT IF EXISTS` statements below are belt-and-braces: they make the intent readable and keep the file a no-op on a database where a previous partial run already removed the column.

- [ ] **Step 1: Confirm the preconditions in real data**

Against a production-like database (or the integration stack after the conversion migration has run):

```sql
-- Every partner must have been converted; §3.6 item 5 makes this the idempotency marker.
-- `partners` is FORCE ROW LEVEL SECURITY: without system scope this read sees ZERO
-- rows and reports a truthful-looking 0. Elect scope in the same transaction.
BEGIN;
SELECT set_config('breeze.scope', 'system', true);
SELECT count(*) AS total, count(*) FILTER (WHERE labour_pricing_converted_at IS NULL) AS unconverted FROM partners;
COMMIT;
```
`total` must be > 0 — a `0 / 0` answer means the read was RLS-blind, not that every partner converted.
Expected: `0`. If it is not, **stop** — dropping the columns would destroy pricing that was never converted.

- [ ] **Step 2: Check the filename still sorts last**

```bash
ls apps/api/migrations | sort | tail -5
```
The new file must sort after every line printed. Rename if not.

- [ ] **Step 3: Write the migration**

```sql
-- apps/api/migrations/2026-10-25-090000-drop-legacy-labour-pricing-columns.sql
-- #4628 W04 — spec §3.6 / §4.3.
-- Drops the six legacy labour-pricing columns, one release after the cut-over
-- converted them into billing profiles and the resolver stopped reading them.
-- Labour pricing now lives in exactly one place: billing_profiles +
-- billing_profile_rules, assigned per org via org_billing_profile_assignments.
--
-- Writes NO rows, so no breeze.scope elevation is needed. If a future edit adds
-- an UPDATE/DELETE/INSERT here, it MUST be preceded by
--   SELECT set_config('breeze.scope','system',true);
-- or it will silently match zero rows under FORCE ROW LEVEL SECURITY.
--
-- autoMigrate wraps this file in a transaction — no BEGIN/COMMIT here.
-- Fully idempotent: every statement is IF EXISTS, so a re-apply is a no-op.

-- Safety interlock: refuse to drop if any partner was never converted (§3.6
-- item 5). partners.labour_pricing_converted_at is the conversion's own
-- idempotency marker, so this is the same question the conversion asked.
DO $$
DECLARE unconverted integer; total integer;
BEGIN
  -- MUST be first. `partners` is FORCE RLS and breeze_current_scope() defaults to
  -- 'none': without this the count below sees zero rows, `unconverted` is always 0
  -- and the interlock passes with nothing converted (fail-open).
  PERFORM set_config('breeze.scope', 'system', true);
  SELECT count(*), count(*) FILTER (WHERE labour_pricing_converted_at IS NULL)
    INTO total, unconverted FROM partners;
  RAISE WARNING 'billing profiles W04 interlock: % partner(s) visible, % unconverted', total, unconverted;
  IF unconverted > 0 THEN
    RAISE EXCEPTION 'refusing to drop legacy labour-pricing columns: % partner(s) were never converted to billing profiles (run the #4628 W02 conversion first)', unconverted;
  END IF;
  RAISE WARNING 'billing profiles W04: all partners converted; dropping the six legacy labour-pricing columns';
END $$;

-- 1) ticket_categories --------------------------------------------------------
-- The CHECK from 2026-08-30-ticketing-currency.sql:108 ties default_hourly_rate
-- to rate_currency; the FK ties rate_currency to supported_currencies. Both
-- would fall with the columns, but naming them keeps the intent legible.
ALTER TABLE ticket_categories DROP CONSTRAINT IF EXISTS ticket_categories_rate_currency_chk;
ALTER TABLE ticket_categories DROP CONSTRAINT IF EXISTS ticket_categories_rate_currency_fkey;
ALTER TABLE ticket_categories DROP COLUMN IF EXISTS default_billable;
ALTER TABLE ticket_categories DROP COLUMN IF EXISTS default_hourly_rate;
ALTER TABLE ticket_categories DROP COLUMN IF EXISTS rate_currency;

-- 2) org_ticket_settings ------------------------------------------------------
-- This row is now SLA-only (§3.6): it is exactly the row pricing was moved out of.
ALTER TABLE org_ticket_settings DROP CONSTRAINT IF EXISTS org_ticket_settings_rate_currency_fkey;
ALTER TABLE org_ticket_settings DROP COLUMN IF EXISTS default_billable;
ALTER TABLE org_ticket_settings DROP COLUMN IF EXISTS default_hourly_rate;
ALTER TABLE org_ticket_settings DROP COLUMN IF EXISTS rate_currency;

DO $$
DECLARE remaining integer;
BEGIN
  SELECT count(*) INTO remaining
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND ((table_name = 'ticket_categories' AND column_name IN ('default_billable','default_hourly_rate','rate_currency'))
      OR (table_name = 'org_ticket_settings' AND column_name IN ('default_billable','default_hourly_rate','rate_currency')));
  IF remaining <> 0 THEN
    RAISE EXCEPTION 'billing profiles W04: % legacy labour-pricing column(s) survived the drop', remaining;
  END IF;
  RAISE WARNING 'billing profiles W04: all six legacy labour-pricing columns dropped';
END $$;
```

> `NOT VERIFIED` — the two FK constraint names. `2026-08-30-ticketing-currency.sql:127` builds them with `format('… %I …', spec[1] || '_' || spec[2] || '_fkey')`, which yields `<table>_<column>_fkey`. Confirm against a live database before relying on the explicit drops: `\d ticket_categories` and `\d org_ticket_settings` in `psql`. The `DROP COLUMN` cascades regardless, so a wrong guess here is cosmetic, not a failure.

- [ ] **Step 4: Apply and check for drift**

```bash
pnpm test-stack up
export DATABASE_URL="$(grep '^DATABASE_URL' .env.test | cut -d= -f2-)"
pnpm db:migrate
pnpm db:check-drift
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
```
Expected: applies cleanly; **no drift** (the Drizzle schema deletions from Task 7 are what make this pass); both DB suites PASS. `autoMigrate.test.ts` also asserts every `readFileSync('../../../migrations/<file>.sql')` reference in the repo resolves — if an integration suite replays a migration by path, this catches a stale reference here instead of minutes into Integration Tests.

- [ ] **Step 5: Apply the migration twice — idempotency**

```bash
psql "$DATABASE_URL" -f apps/api/migrations/2026-10-25-090000-drop-legacy-labour-pricing-columns.sql
psql "$DATABASE_URL" -f apps/api/migrations/2026-10-25-090000-drop-legacy-labour-pricing-columns.sql
```
Expected: the second run succeeds with the same `RAISE WARNING` output and no error.

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-10-25-090000-drop-legacy-labour-pricing-columns.sql
git commit -m "feat(billing)!: drop the six legacy labour-pricing columns (#4628 W04)"
```

---

### Task 9: Full verification before the PR

**Files:** none.

- [ ] **Step 1: Everything unit**

```bash
pnpm --filter @breeze/shared build
cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit
cd ../web && npx tsc --noEmit
cd ../mobile && npx tsc --noEmit
cd ../outlook-addin && npx tsc --noEmit
cd ../.. && pnpm test
```
Expected: PASS. Remember `pnpm test` runs **neither** the RLS nor the integration configs.

- [ ] **Step 2: The integration suites this wave breaks or proves**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/ticketingCurrencyMigration.integration.test.ts \
  src/__tests__/integration/ticketingCurrencyBackfill.integration.test.ts \
  src/__tests__/integration/orgCurrencyChange.integration.test.ts \
  src/__tests__/integration/orgCurrencyCreationBarrier.integration.test.ts \
  src/__tests__/integration/orgMerge.integration.test.ts \
  src/__tests__/integration/ticket-config-rls.integration.test.ts \
  src/__tests__/integration/orgStampingDefaultsErrorMapping.integration.test.ts \
  src/__tests__/integration/time-entries-rls.integration.test.ts \
  src/__tests__/integration/aiTimeEntryProposal.integration.test.ts \
  src/__tests__/integration/multiCurrencyWave6TicketAssembly.integration.test.ts \
  src/__tests__/integration/multiCurrencyWave6VoidReissue.integration.test.ts
```
Expected: all PASS. **Do not skip this**: the export-policy and cascade contracts are integration-only, so a PR that removes three classified column names and forgets the registry reads green in Test API and reddens main.

- [ ] **Step 3: Verify the columns are actually gone, as `breeze_app`**

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze -c "\d ticket_categories" -c "\d org_ticket_settings"
```
Neither listing may show `default_billable`, `default_hourly_rate` or `rate_currency`.

- [ ] **Step 4: Tear the stack down**

```bash
pnpm test-stack down
docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'
```
Nothing from this session may be left running.

- [ ] **Step 5: Open the PR**

Body must contain:
- the **full grep output from Task 7 Step 1** (the proof that no production reader survived);
- the migration's safety interlock and why it refuses on an unconverted partner — with an integration test that replays the drop migration against a DB holding one UNCONVERTED partner and asserts it raises (the control that proves the scope election works; without it the interlock was fail-open);
- the three names removed from `CORE_TENANT_EXPORT_POLICY`;
- the validator flip from ignore to reject, with the exact error message technicians and integrators will now see;
- the release-note text verbatim, so a reviewer checks the warning before it ships;
- whether the #3198 R2 report exists and what was posted on that issue;
- `Closes #<W04 sub-issue>`.

---

## Self-review

**Spec coverage.** §7 "mobile and the add-in get pickers in the last wave" → Tasks 1–3. §5 business reports #3198 → Task 4 (with the honest `NOT VERIFIED` that R2 is unbuilt). §3.6 removal + the full sweep list → Task 7. §4.3 "Six columns leave one release after the cut-over" → Task 8. §6 "ignored with a deprecation warning for one release, then rejected" → Task 7 Step 2. §10 decision 2 release note → Task 6. Docs → Task 5. §4.4 registration lists → Task 7 (`CORE_TENANT_EXPORT_POLICY`); no table is added or removed, so `tenantCascade.ts`, `orgMergeRegistry.ts` and the device/ticket org-move lists are untouched — Task 9 Step 2 runs their suites anyway to prove it.

**Two places the spec and the current code disagree, both flagged inline:**

1. **§5 names a "business report R2" that does not exist in this repo.** No business-review report service was found. Task 4 delivers the dimension on the billables CSV and `listBillables`, and posts the note on #3198 that §5 asks for.
2. **§3.6's sweep list says `tenantExportPolicyRegistry.ts` owes an `org_ticket_settings` entry change — it does, and *only* that one.** `ticket_categories` is partner-owned with no `org_id`, so it has no export-policy entry at all (verified: zero hits). A plan that "removed the ticket_categories entry" would be removing something that was never there.

**One thing deliberately not in this wave:** re-pricing existing entries. §3.7 is absolute — editing a card, archiving it or reassigning an org never touches an existing entry, and neither does dropping a column. Nothing here writes to `time_entries`.
