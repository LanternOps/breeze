---
tracking_issue: LanternOps/breeze#4186
spec: docs/superpowers/specs/mobile/2026-08-28-location-time-suggestions-design.md
waves_planned: [W1, W2]
waves_not_planned: [W3 (held — Gate A Q3), W4 (outside Gate A approval)]
---

# Location-Aware Time Suggestions (W1 + W2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A technician who opens the Breeze app at a client site sees "Looks like you're at Acme Corp — Main Office. [Start timer]"; one tap starts an ordinary `time_entries` row stamped `source='location'`, `org_id`, `site_id`. Nothing is written without the tap, and the phone's position never leaves the phone except as a deliberately-pinned site coordinate.

**Architecture:** W1 adds six nullable location columns to `sites`, a nullable `site_id` to `time_entries`, a narrow `sites:set_location` permission with its own pin route (no MFA step-up), an `orgId`/`siteId`/`source` extension to `POST /time-entries/start` and `POST /time-entries` (the offline replay path), one read endpoint `GET /time-entries/location-sites` that hands the phone the partner flag plus its candidate sites in one call, and a partner toggle in the existing Time Tracking settings card. W2 adds `expo-location` (foreground "While Using" only), a pure-TS matcher/suppression module, an `ArrivalSheet` modal, the phone-side site pin, and the foreground "still at Acme?" stop prompt — reusing W03–W05's timer orchestration and offline local-timer path unchanged.

**Tech Stack:** Hono + Drizzle + hand-written SQL migrations (API); Zod in `@breeze/shared`; Vitest unit + real-Postgres integration suites; React web settings card (+8 locales); Expo SDK 57 / React Native 0.86 / Redux Toolkit (mobile; Vitest on pure `.ts` modules only).

**Spec:** `docs/superpowers/specs/mobile/2026-08-28-location-time-suggestions-design.md` (§1 framing, §2 data model, §3 API, §4 W2 mobile). Gate A decisions (issue #4186 comment, 2026-09-02): Q1 reuse the existing `time_entries.source` column; Q2 add a narrower `sites:set_location` permission in W1; Q3 W3 background geofencing held until a real-device Android matrix exists. The plan argues from the spec; read both.

Evidence labels: **[verified]** = read on `origin/main` @ `9b9f3fc28d` in this worktree while writing the plan; **[inferred]**; **[not-checked]**.

---

## Premise check against current main

| Spec premise | Current main | Consequence for the plan |
|---|---|---|
| Depends on #3206 W02–W05 | #3206 and all W01–W08 sub-issues CLOSED [verified `gh issue view 3206`, `gh issue list`] | No dependency wait. W1 and W2 can both start; W2 merges after W1. |
| `sites` has no lat/lng | True. `apps/api/src/db/schema/orgs.ts:258-272`: `id, org_id, name, address(jsonb), timezone, contact(jsonb), settings(jsonb), created_at, updated_at, partner_export_updated_at` [verified] | Add columns (Task 1). |
| `sites` in org cascade + export policy | `tenantCascade.ts:814` `'sites'`; `tenantExportPolicyRegistry.ts:749` sites entry [verified] | Six new columns must be classified at `:749` (Task 1). |
| `time_entries.source` to be created by whichever wave lands first | **Already shipped** by #3206 W06: `migrations/2026-09-25-time-entry-source-and-suggestion-decisions.sql:13`, CHECK `time_entries_source_chk` includes `'location'`; widened with `ai_suggested` in `2026-10-16-190100-time-entry-ai-suggested-source.sql:10-13`. Drizzle `schema/timeTracking.ts:79` [verified] | No `source` DDL. Only `site_id` is new. `source` already in export policy `tenantExportPolicyRegistry.ts:859` [verified]. |
| `/start` derives `org_id` from `ticketId` only | True. `services/timeEntryService.ts:834-847` [verified]. `startTimerSchema` = `{workTypeId?, ticketId?, description?}` at `packages/shared/src/validators/timeEntries.ts:86` [verified] | Extend (Task 4). |
| An org-only link helper would have to be written | **Already exists**: `resolveAndLockOrgLink(orgId, actor)` at `timeEntryService.ts:626`, docstring names "later the location wave's `/start {orgId}`" [verified] | Reuse it — do not write a second org-access check. |
| `/start` 409 `ENTRY_RUNNING` = "a timer is already running" | **Changed.** `startTimer` auto-stops the caller's previous timer (`stopRunningEntry`, `:862`); 409 is only a lost insert race (`:914`) [verified]. Mobile already maps it to "Another timer change landed first" (`apps/mobile/src/screens/tickets/timerActions.ts:175`) [verified] | ArrivalSheet must not start while a timer runs (suppression rule, spec §4) — otherwise the tap would silently stop the running timer. 409 handling stays the existing copy. |
| "The #3206 offline queue all works unchanged" | **Partially false.** An offline start is a device-local timer (`services/localTimer.ts`), and its stop queues a `create` (`POST /time-entries`) — `createTimeEntrySchema` has no `orgId` [verified `validators/timeEntries.ts:56-71`]. A ticketless location visit started offline would land with `org_id NULL`, `source 'manual'`. | `POST /time-entries` also accepts `orgId`/`siteId`/`source` (Task 4); `LocalTimer` carries them (Task 12). |
| Partner setting `timeTracking.locationSuggestions` | W06 reserved it: `timeTrackingSessionSuggestionsSchema` is `.passthrough()` "so a sibling block … `timeTracking.locationSuggestions` is neither rejected nor stripped" (`packages/shared/src/validators/partnerTicketingSettings.ts:55-68`); PATCH deep-merges `timeTracking` one level (`routes/orgs.ts:1104-1110`) [verified] | Add a strict `locationSuggestions` inner object to the same schema + tolerant reader (Task 3). |
| Mobile caches `GET /orgs/sites` | No sites client in mobile [verified]. `GET /orgs/sites` is paginated at max 100 (`utils/pagination.ts:1-4`), returns `address/contact/settings` jsonb, no org name, and the partner flag would need a second read (`GET /partners/me` needs `organizations:read`, `routes/orgs.ts:987`) [verified] | New `GET /time-entries/location-sites` (Task 5, **OD-1**). `GET /orgs/sites` still returns the new columns for free (`db.select()` full row, `orgs.ts:2934`) [verified]. |
| Tickets cache in AsyncStorage | No — tickets are Redux-only (`store/ticketsSlice.ts`); `TicketSummary` has `orgId`, no `siteId` (`services/tickets.ts:28-36`) [verified] | Ticket step filters `state.tickets` by `orgId` (Task 13). |
| Mobile has `expo-location` | Not installed; no location `infoPlist` strings or Android permissions (`apps/mobile/app.json`) [verified] | Task 10. |
| Bottom sheet component | No sheet library; W06 precedent is an RN `Modal` (`screens/time/SuggestionConfirmSheet.tsx`) [verified] | ArrivalSheet is a `Modal` (OD-6). |
| Newest migration | `2026-12-13-110200-org-erasure-fk-child-actions.sql` [verified `ls apps/api/migrations | sort | tail`] | New files: `2026-12-14-100000-…`, `2026-12-14-100100-…` (bump if main moves). |

---

## Wave table

| Wave | Scope | Tasks | Deps | Migrations | Blast radius | Model tier |
|---|---|---|---|---|---|---|
| **W1** — data + API + toggle | columns, `sites:set_location`, pin route, `/start` + `POST /` org/site/source, `GET /location-sites`, partner flag + web toggle, docs | 1–9 | none (#3206 closed) | 2: `2026-12-14-100000-site-location-columns.sql`, `2026-12-14-100100-sites-set-location-permission.sql` | **High** — migration, new permission/role grants, auth gate without MFA, time-entry money stamping path, export-policy contract | Opus orchestrates; Sonnet implements Tasks 1–6 under red-first; Sonnet review round (`/pr-review-toolkit:review-pr`); Integration Tests + RLS coverage locally |
| **W2** — foreground prompt (mobile) | `expo-location`, matcher, suppression, ArrivalSheet, site pin, stop prompt, analytics, docs | 10–17 | W1 merged (needs the routes) | none | **Medium** — customer-device code shipping through App Store review; no server writes beyond W1's routes | Sonnet implements pure modules (red-first); Opus/Claude does RN wiring + permission copy; one Sonnet review |
| W3 — background geofencing | spec §5 | — | real-device Android matrix (Gate A Q3) | — | — | **Not planned** (held) |
| W4 — web map pin + geocoding | spec §6 | — | Gate A approved W1–W2 only | — | — | **Not planned**; separate plan on approval |

PR per wave, both based on `main` (never stacked: `ci.yml` runs only on `pull_request: branches: [main]`). Branches (orchestrator registers the feature after approval): `feature/4186-location-time-suggestions/wave-<W1#>`, `…/wave-<W2#>`.

---

## Global Constraints

- **Suggest, never write** (spec §1). No code path creates or stops a `time_entries` row without a technician tap. The W2 stop prompt stops only on tap and uses the tap time (no `endedAt`).
- **Technician position never leaves the phone** (spec §1). No API route accepts a technician coordinate except `POST /orgs/sites/:id/location` (an explicit site pin). No coordinate, site name, org name or distance in any analytics event, log line, Sentry breadcrumb, or audit detail beyond the pinned site's own lat/lng on `site.location_set`.
- **Off by default, two opt-ins:** partner flag `partners.settings.timeTracking.locationSuggestions = { enabled:false, defaultRadiusM:150 }` **and** the per-device OS permission. Either false → no prompt, no position read, no permission dialog.
- **Ranges** (spec §2.1/§2.4, verbatim): latitude ±90, longitude ±180, `geofence_radius_m` 50..1000 (null = partner default), `defaultRadiusM` 50..1000, `numeric(9,6)` storage. Lat/lng are a pair — both or neither (CHECK `sites_location_pair_chk` + zod refine).
- **`location_source` vocabulary:** `'technician' | 'manual' | 'geocoded'` (CHECK `sites_location_source_chk`). Pin route stamps `technician`; site PATCH stamps `manual`; `geocoded` reserved for W4.
- **`source` from a client:** only `'timer'` (default) on `/start` and `'location'` on `/start` and `POST /`. Every other value stays server-stamped. `remote_session`, `support_session`, `ai_suggested` are rejected by zod (400).
- **Org rule on `/start` and `POST /`:** `orgId` without `ticketId` → `resolveAndLockOrgLink`; both present → ticket org wins, mismatch is `422 ORG_MISMATCH` (code already in the union, `timeEntryService.ts:51`). `siteId` must belong to the resolved org (`422 SITE_ORG_MISMATCH`) and be readable by the caller (site-confined users: `allowedSiteIds`).
- **Migrations:** idempotent, no inner `BEGIN/COMMIT`, writes elect `set_config('breeze.scope','system',true)` first (`migrationRlsScope.test.ts`), filenames sort after the newest committed migration — re-check `ls apps/api/migrations | sort | tail -1` before pushing; the pre-push hook re-checks against `origin/main`.
- **Export policy fires on new columns** (CLAUDE.md). Both suites (`tenant-export-policy`, `tenantExportErasureRoundtrip`) are Integration-Tests-only: run them locally via `pnpm test-stack up`.
- **No new table** → no RLS policy, no cascade-list or merge-registry entry. `time_entries.site_id → sites(id) ON DELETE SET NULL` adds an FK edge between two cascade tables; `topologicalCascadeOrder()` derives order from FKs at runtime (`tenantCascade.ts:1326-1343`) [verified] — prove no cycle with `tenantCascade.integration.test.ts`.
- **Web:** mutation handlers via `runAction`; every new i18n key in `en` and all seven other locales (`localeParity.test.ts`).
- **Mobile:** tests are `src/**/*.test.ts` only (`apps/mobile/vitest.config.ts`) — logic in pure `.ts` modules, components thin. `apps/mobile` does **not** depend on `@breeze/shared` [verified `package.json`] — the haversine lives in mobile.
- **Test commands:** `cd apps/api && npx vitest run <files>`; mobile `cd apps/mobile && npx vitest run <files>`; never `pnpm … test -- --run`. Typecheck: `cd apps/api && npx tsc --noEmit` (12 GB heap: `NODE_OPTIONS=--max-old-space-size=12288`, do not pipe to `tail`), `cd apps/mobile && npx tsc --noEmit`, `cd apps/web && npx tsc --noEmit`, `cd packages/shared && npx tsc --noEmit`.
- **Settings rule 9** (CLAUDE.md): the W1 PR description states home = Ticketing settings → Time Tracking tab (`TicketingSettingsTabs.tsx:36,140`), level = partner, resolver = `getLocationSuggestionSettings` (Task 3), count of places configured before 0 / after 1.
- **Release notes:** every task that adds operator-visible surface appends a bullet to `docs/release-notes/next-release-draft.md` in the same commit.

## Review Focus

1. **Tap while a timer is already running.** `/start` auto-stops the running timer server-side; a prompt shown on stale "no timer" state would silently end the tech's current work. Suppression must read live Redux `time.running` *and* the local timer at sheet-render time and again at tap time (Task 11 tests + Task 13 guard).
2. **Two sites inside each other's radius (office park).** Must be a distance-sorted picker, never an auto-pick, even when one is 5 m closer (Task 11 test `two candidates → picker`).
3. **Fix accuracy worse than the radius.** Spec rule `≤ max(radius, accuracy)` + 500 m cutoff; a 450 m fix must not match every site in a 450 m circle as "you're here" without the picker (Task 11 test).
4. **Org deleted / tech loses access to an org after the site list was cached.** `/start {orgId}` must 403 `ORG_DENIED`, and the mobile sheet must show the error and drop the cached site list rather than retry-loop (Task 4 test + Task 13 outcome mapping).
5. **Offline arrival.** Start offline → local timer → stop queues `create`; the `create` must carry `orgId/siteId/source:'location'` or the entry lands org-less (Task 4 `POST /` test + Task 12 test).

---

## OS permission flows (privacy requirement)

W2 requests **foreground ("While Using") permission only**. No `Always`, no `UIBackgroundModes`, no `ACCESS_BACKGROUND_LOCATION` in W2 — those are W3 (held).

**iOS** (single-step dialog)
1. The partner flag is on and the user has never been asked → the app shows an in-app explainer card on the Time tab: "Breeze can suggest starting a timer when you arrive at a client site. Your location is checked on this phone only and never sent to Breeze." [Turn on] [Not now].
2. **Turn on** → `Location.requestForegroundPermissionsAsync()` → system dialog with `NSLocationWhenInUseUsageDescription` (Task 10 copy). Options: *Allow Once*, *Allow While Using App*, *Don't Allow*. iOS also offers a *Precise* toggle.
   - *Allow While Using* → feature active.
   - *Allow Once* → active for this launch; next launch `getForegroundPermissionsAsync()` returns `undetermined` again — the explainer is NOT re-shown automatically (OD-7 default: re-ask only from Settings → Location suggestions row).
   - *Don't Allow* → `denied`, `canAskAgain:false`. App never re-prompts; Settings row shows "Location is off for Breeze — open iOS Settings" → `Linking.openSettings()`.
   - *Precise off* (approximate, ~1–3 km accuracy) → every read exceeds the 500 m accuracy cutoff, so no prompt ever fires; Settings row shows "Precise location is off — suggestions need it" (detect via `accuracy` on the permission response `ios.accuracy === 'reduced'`).
3. **Not now** → store `breeze.location.explainerDismissedAt`; re-offer after 30 days at most.

**Android** (API 31+)
1. Same explainer card.
2. `requestForegroundPermissionsAsync()` → dialog offering *Precise* / *Approximate* and *While using the app* / *Only this time* / *Don't allow*. Manifest declares `ACCESS_COARSE_LOCATION` + `ACCESS_FINE_LOCATION`.
   - Approximate only → same "Precise location is off" state as iOS (detect `android.accuracy === 'coarse'`).
   - Two consecutive denials → Android stops showing the dialog (`canAskAgain:false`); same Settings deep link.
3. Location services globally off → `Location.hasServicesEnabledAsync()` false → no read, no prompt, Settings row explains.

**What runs where:** the position is read with `getCurrentPositionAsync({accuracy: Balanced})` only while the app is foregrounded, compared in JS against the cached site list, and discarded. The only network write involving a coordinate is the explicit **"Save my current location as <site>"** button, which sends the current fix as the site's pin (`Accuracy.High`, accuracy must be ≤ 100 m).

---

## File Structure

**W1 — API / shared / web**

| File | Action | Responsibility |
|---|---|---|
| `apps/api/migrations/2026-12-14-100000-site-location-columns.sql` | Create | `sites` 6 columns + 2 CHECKs; `time_entries.site_id` FK + partial index |
| `apps/api/migrations/2026-12-14-100100-sites-set-location-permission.sql` | Create | `permissions` row + role grants |
| `apps/api/src/db/schema/orgs.ts:258-272` | Modify | Drizzle columns on `sites` |
| `apps/api/src/db/schema/timeTracking.ts` | Modify | `siteId` on `timeEntries` |
| `apps/api/src/services/tenantExportPolicyRegistry.ts:749,859` | Modify | classify 7 new columns |
| `packages/shared/src/constants/permissions.ts:146-148` | Modify | `SITES_SET_LOCATION` |
| `apps/api/src/db/seed.ts` (~230, ~354, ~420, ~476) | Modify | catalog row + role grants |
| `packages/shared/src/validators/siteLocation.ts` | Create | `siteLocationPinSchema`, `siteLocationFields`, range constants |
| `packages/shared/src/validators/siteLocation.test.ts` | Create | validator tests |
| `packages/shared/src/validators/partnerTicketingSettings.ts:55-126` | Modify | `locationSuggestions` block + `readTimeTrackingLocationSuggestions` |
| `packages/shared/src/validators/timeEntries.ts:56-95,181` | Modify | `orgId/siteId/source` on start + create; `clientTimeEntrySourceSchema` |
| `apps/api/src/services/timeSuggestionSettings.ts` | Modify | `getLocationSuggestionSettings` |
| `apps/api/src/services/timeEntryService.ts:626-720,834-930` | Modify | org/site/source resolution on start + create |
| `apps/api/src/services/siteLocation.ts` | Create | `assertSiteInOrg`, `pinSiteLocation`, `listLocationSites` |
| `apps/api/src/routes/siteLocation.ts` | Create | `POST /orgs/sites/:id/location` sub-router |
| `apps/api/src/routes/timeEntries/locationSites.ts` | Create | `GET /time-entries/location-sites` |
| `apps/api/src/routes/orgs.ts:402-416, 3118` | Modify | site schemas accept location fields; PATCH stamps `manual` |
| `apps/web/src/components/settings/TimeTrackingSettingsCard.tsx` | Modify | toggle + radius |
| `apps/web/src/locales/*/…` | Modify | 8 locales |
| `apps/docs/src/content/docs/features/mobile.mdx`, `reference/users-and-roles.mdx`, `reference/organizations-and-sites.mdx` | Modify | docs |

**W2 — mobile**

| File | Action | Responsibility |
|---|---|---|
| `apps/mobile/package.json`, `app.json` | Modify | `expo-location`, plugin, usage strings |
| `apps/mobile/src/services/geo.ts` (+ test) | Create | `haversineMeters` |
| `apps/mobile/src/services/locationSites.ts` (+ test) | Create | client + 24 h AsyncStorage cache for `GET /time-entries/location-sites` |
| `apps/mobile/src/services/arrivalMatch.ts` (+ test) | Create | candidate match + suppression + stop-prompt decision (pure) |
| `apps/mobile/src/services/arrivalMemory.ts` (+ test) | Create | AsyncStorage: dismissals, last stop per site, last pick per site |
| `apps/mobile/src/services/locationPermission.ts` (+ test) | Create | permission state machine (pure mapping of expo responses) |
| `apps/mobile/src/services/localTimer.ts` | Modify | `orgId?/siteId?/source?` on `LocalTimer` |
| `apps/mobile/src/services/timeEntries.ts:173-200` | Modify | `startTimer` / `createTimeEntry` input gains `orgId/siteId/source` |
| `apps/mobile/src/screens/tickets/timerActions.ts:111` | Modify | `startForSite` (sibling of `startForTicket`) |
| `apps/mobile/src/screens/time/ArrivalSheet.tsx` + `arrivalSheetLogic.ts` (+ test) | Create | sheet UI + pure step logic |
| `apps/mobile/src/screens/time/useArrivalPrompt.ts` | Create | AppState/focus triggers, debounce, orchestration |
| `apps/mobile/src/screens/time/SitePinButton.tsx` + `sitePinLogic.ts` (+ test) | Create | "Save my current location as …" |
| `apps/mobile/src/navigation/MainNavigator.tsx:238` | Modify | mount `useArrivalPrompt` + `ArrivalSheet` beside `TimerBar` |
| `apps/mobile/src/screens/tickets/TicketDetailScreen.tsx`, `screens/time/TimesheetScreen.tsx` | Modify | mount `SitePinButton` |
| `apps/mobile/src/lib/analytics.ts` callers | — | four events, no customer data |

---

# W1 — Data model, API, partner toggle

### Task 1: Migration + Drizzle + export-policy classification (Rigor: high)

**Files:**
- Create: `apps/api/migrations/2026-12-14-100000-site-location-columns.sql`
- Modify: `apps/api/src/db/schema/orgs.ts:258-272`, `apps/api/src/db/schema/timeTracking.ts` (after `source` at `:79`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:749` (sites), `:859` (time_entries)
- Create: `apps/api/src/__tests__/integration/siteLocationColumns.integration.test.ts`

**Interfaces:**
- Produces: Drizzle `sites.latitude/longitude` (`number | null`, `mode:'number'`), `sites.geofenceRadiusM`, `sites.locationSource`, `sites.locationSetBy`, `sites.locationSetAt`; `timeEntries.siteId`.

- [ ] **Step 1: Write the failing integration test**

```ts
// apps/api/src/__tests__/integration/siteLocationColumns.integration.test.ts
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';

describe('site location columns migration', () => {
  it('adds the six sites columns with the spec types', async () => {
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT column_name, data_type, numeric_precision, numeric_scale, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'sites' AND column_name IN
        ('latitude','longitude','geofence_radius_m','location_source','location_set_by','location_set_at')
      ORDER BY column_name`));
    expect(rows).toEqual([
      { column_name: 'geofence_radius_m', data_type: 'integer', numeric_precision: 32, numeric_scale: 0, is_nullable: 'YES' },
      { column_name: 'latitude', data_type: 'numeric', numeric_precision: 9, numeric_scale: 6, is_nullable: 'YES' },
      { column_name: 'location_set_at', data_type: 'timestamp with time zone', numeric_precision: null, numeric_scale: null, is_nullable: 'YES' },
      { column_name: 'location_set_by', data_type: 'uuid', numeric_precision: null, numeric_scale: null, is_nullable: 'YES' },
      { column_name: 'location_source', data_type: 'character varying', numeric_precision: null, numeric_scale: null, is_nullable: 'YES' },
      { column_name: 'longitude', data_type: 'numeric', numeric_precision: 9, numeric_scale: 6, is_nullable: 'YES' },
    ]);
  });

  it.each([
    ['lat without lng', sql`UPDATE sites SET latitude = 1, longitude = NULL WHERE id = (SELECT id FROM sites LIMIT 1)`, 'sites_location_pair_chk'],
    ['radius below 50', sql`UPDATE sites SET geofence_radius_m = 49 WHERE id = (SELECT id FROM sites LIMIT 1)`, 'sites_geofence_radius_chk'],
    ['radius above 1000', sql`UPDATE sites SET geofence_radius_m = 1001 WHERE id = (SELECT id FROM sites LIMIT 1)`, 'sites_geofence_radius_chk'],
    ['unknown source', sql`UPDATE sites SET location_source = 'gps' WHERE id = (SELECT id FROM sites LIMIT 1)`, 'sites_location_source_chk'],
  ])('rejects %s', async (_label, stmt, constraint) => {
    await expect(withSystemDbAccessContext(() => db.execute(stmt))).rejects.toThrow(constraint);
  });

  it('adds time_entries.site_id → sites ON DELETE SET NULL', async () => {
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT confdeltype FROM pg_constraint WHERE conname = 'time_entries_site_id_fkey'`));
    expect(rows).toEqual([{ confdeltype: 'n' }]);
  });
});
```

The `it.each` UPDATEs need at least one `sites` row: seed one in a `beforeAll` with the org/site fixture helper the neighbouring integration suites use (`grep -l "insert(sites)" apps/api/src/__tests__/integration | head -1` and copy its fixture).

- [ ] **Step 2: Run it — expect FAIL** (`pnpm test-stack up` first)

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/siteLocationColumns.integration.test.ts`
Expected: FAIL — `column_name` rows empty, constraint names not found.

- [ ] **Step 3: Write the migration**

```sql
-- #4186 W1: site pin columns + time-entry site link (location-aware time suggestions).
-- The only coordinate stored server-side is a deliberately pinned SITE location;
-- no technician position is ever written. All columns nullable; existing rows untouched.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS latitude numeric(9,6);
ALTER TABLE sites ADD COLUMN IF NOT EXISTS longitude numeric(9,6);
ALTER TABLE sites ADD COLUMN IF NOT EXISTS geofence_radius_m integer;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS location_source varchar(16);
ALTER TABLE sites ADD COLUMN IF NOT EXISTS location_set_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS location_set_at timestamptz;

ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_location_pair_chk;
ALTER TABLE sites ADD CONSTRAINT sites_location_pair_chk
  CHECK ((latitude IS NULL) = (longitude IS NULL));
ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_location_range_chk;
ALTER TABLE sites ADD CONSTRAINT sites_location_range_chk
  CHECK ((latitude IS NULL OR latitude BETWEEN -90 AND 90) AND (longitude IS NULL OR longitude BETWEEN -180 AND 180));
ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_geofence_radius_chk;
ALTER TABLE sites ADD CONSTRAINT sites_geofence_radius_chk
  CHECK (geofence_radius_m IS NULL OR geofence_radius_m BETWEEN 50 AND 1000);
ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_location_source_chk;
ALTER TABLE sites ADD CONSTRAINT sites_location_source_chk
  CHECK (location_source IS NULL OR location_source IN ('technician','manual','geocoded'));

-- Informational link only; does not participate in RLS (time_entries is partner-axis).
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS site_id uuid;
DO $$ BEGIN
  ALTER TABLE time_entries ADD CONSTRAINT time_entries_site_id_fkey
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS time_entries_site_id_idx ON time_entries (site_id) WHERE site_id IS NOT NULL;
```

`location_set_by ON DELETE SET NULL`: a user delete must not block on a site pin. Check the users-erasure path (`grep -n "location_set_by\|SET NULL" apps/api/src/services/tenantCascade.ts` — user-reference columns are normally nulled by FK action, not listed) [inferred]. No `UPDATE`/`INSERT` in this file, so no `breeze.scope` elevation.

- [ ] **Step 4: Drizzle columns**

```ts
// schema/orgs.ts — inside the sites table, after partnerExportUpdatedAt
latitude: numeric('latitude', { precision: 9, scale: 6, mode: 'number' }),
longitude: numeric('longitude', { precision: 9, scale: 6, mode: 'number' }),
geofenceRadiusM: integer('geofence_radius_m'),
locationSource: varchar('location_source', { length: 16 }),
locationSetBy: uuid('location_set_by').references(() => users.id, { onDelete: 'set null' }),
locationSetAt: timestamp('location_set_at', { withTimezone: true }),
```

(`numeric(..., {mode:'number'})` precedent: `schema/aiPlatformModels.ts:21` [verified]. If importing `users` into `orgs.ts` creates a circular import, declare the column without `.references()` and add a comment pointing at the SQL FK — the SQL is authoritative.)

```ts
// schema/timeTracking.ts — after `source`
siteId: uuid('site_id').references(() => sites.id, { onDelete: 'set null' }),
```

- [ ] **Step 5: Export policy** — `tenantExportPolicyRegistry.ts:749` append to `sites` `included`: `"latitude","longitude","geofence_radius_m","location_source","location_set_by","location_set_at"`; `:859` append `"site_id"` to `time_entries` `included`. (All scalar; none match `SUSPICIOUS_NAME_PARTS`.)

- [ ] **Step 6: Run** the Task 1 test, then `tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts`, `tenantCascade.integration.test.ts`, `orgMergeRegistry.integration.test.ts`, and `apps/api/src/db/autoMigrate.test.ts` + `migrationRlsScope.test.ts`. Expected: all PASS. Then `pnpm db:check-drift`.

- [ ] **Step 7: Commit** — `feat(api): site pin columns and time-entry site link (#4186)`; append to `docs/release-notes/next-release-draft.md` under Migrations: "Adds nullable location columns to `sites` and `site_id` to `time_entries` (no backfill, no table rewrite)."

---

### Task 2: `sites:set_location` permission (Rigor: high)

**Files:**
- Modify: `packages/shared/src/constants/permissions.ts:146-148`
- Modify: `apps/api/src/db/seed.ts` (catalog ~`:230`; Partner Technician ~`:354`; Org Admin ~`:420`; Org Technician ~`:476`)
- Create: `apps/api/migrations/2026-12-14-100100-sites-set-location-permission.sql`
- Create: `apps/api/src/__tests__/integration/sitesSetLocationPermissionMigration.integration.test.ts` (model: `aiSessionsUsePermissionMigration.integration.test.ts`)

**Interfaces:**
- Produces: `PERMISSIONS.SITES_SET_LOCATION = { resource: 'sites', action: 'set_location' }`.

- [ ] **Step 1: Failing test** — copy the structure of `aiSessionsUsePermissionMigration.integration.test.ts`, replacing the permission tuple and asserting:

```ts
it('grants sites:set_location to the three system roles and nothing else', async () => {
  const rows = await withSystemDbAccessContext(() => db.execute(sql`
    SELECT r.name, r.scope FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE p.resource = 'sites' AND p.action = 'set_location'
      AND r.partner_id IS NULL AND r.is_system = TRUE
    ORDER BY r.scope, r.name`));
  expect(rows).toEqual([
    { name: 'Org Admin', scope: 'organization' },
    { name: 'Org Technician', scope: 'organization' },
    { name: 'Partner Technician', scope: 'partner' },
  ]);
});
it('is idempotent', async () => { /* re-run the file via readFileSync + db.execute; expect one permissions row */ });
it('does not grant a custom role named "Org Admin" (is_system = FALSE)', async () => { /* insert custom role, re-run, expect no grant */ });
```

- [ ] **Step 2: Run — FAIL** (no permission row).

- [ ] **Step 3: Migration** — byte-for-byte the shape of `2026-10-23-110000-ai-sessions-use-permission.sql` [verified]: `SELECT set_config('breeze.scope','system',true);` → `INSERT INTO permissions (resource, action, description) SELECT 'sites','set_location','Pin a site''s map location from the field' WHERE NOT EXISTS (…)` → `DO $$` grant to `is_system = TRUE AND ((scope='organization' AND name IN ('Org Admin','Org Technician')) OR (scope='partner' AND name='Partner Technician'))` `ON CONFLICT (role_id, permission_id) DO NOTHING` with `GET DIAGNOSTICS n = ROW_COUNT; RAISE NOTICE 'granted sites:set_location to % roles', n;`. Header comment: why a narrower permission (Gate A Q2: technicians hold `sites:read` only, `seed.ts:354,476` [verified]); Partner Admin has `*:*`.

- [ ] **Step 4: Constant + seed** — `SITES_SET_LOCATION: { resource: 'sites', action: 'set_location' },` after `SITES_DELETE`; seed catalog row `{ resource: 'sites', action: 'set_location', description: … }`; add `'sites:set_location'` to the three role grant lists.

- [ ] **Step 5: Run** the new test + `cd apps/api && npx vitest run src/db/seed` (if a seed/permission-catalog parity test exists: `grep -rln "PERMISSIONS" apps/api/src/**/*.test.ts | grep -i seed`). Expected PASS.

- [ ] **Step 6: Commit** `feat(api): sites:set_location permission (#4186)`; docs bullet in `apps/docs/src/content/docs/reference/users-and-roles.mdx` permission table (same commit).

---

### Task 3: Shared validators + partner flag reader (Rigor: low)

**Files:**
- Create: `packages/shared/src/validators/siteLocation.ts`, `siteLocation.test.ts`
- Modify: `packages/shared/src/validators/partnerTicketingSettings.ts:55-126` (+ its test file)
- Modify: `packages/shared/src/validators/index.ts` (export)
- Modify: `apps/api/src/services/timeSuggestionSettings.ts` (+ test)

**Interfaces:**
- Produces:
  - `SITE_RADIUS_MIN_M = 50`, `SITE_RADIUS_MAX_M = 1000`, `LOCATION_DEFAULT_RADIUS_M = 150`
  - `siteLocationPinSchema: z.ZodType<{ latitude: number; longitude: number; geofenceRadiusM?: number }>`
  - `siteLocationFieldsSchema` — `{ latitude?: number|null; longitude?: number|null; geofenceRadiusM?: number|null }` with pair refine
  - `readTimeTrackingLocationSuggestions(partnerSettings: unknown): { settings: { enabled?: boolean; defaultRadiusM?: number }; valid: boolean }`
  - API: `getLocationSuggestionSettings(partnerId: string): Promise<{ enabled: boolean; defaultRadiusM: number }>`; `parseLocationSuggestionSettings(raw: unknown)`

- [ ] **Step 1: Failing tests**

```ts
// siteLocation.test.ts
import { describe, it, expect } from 'vitest';
import { siteLocationPinSchema, siteLocationFieldsSchema } from './siteLocation';

describe('siteLocationPinSchema', () => {
  it.each([
    [{ latitude: 41.5, longitude: -81.7 }, true],
    [{ latitude: 90, longitude: 180, geofenceRadiusM: 1000 }, true],
    [{ latitude: 90.0001, longitude: 0 }, false],
    [{ latitude: 0, longitude: -180.5 }, false],
    [{ latitude: 0, longitude: 0, geofenceRadiusM: 49 }, false],
    [{ latitude: 0, longitude: 0, geofenceRadiusM: 150.5 }, false],
    [{ latitude: 'nope', longitude: 0 }, false],
    [{ latitude: 1 }, false],
  ])('%j → %s', (input, ok) => {
    expect(siteLocationPinSchema.safeParse(input).success).toBe(ok);
  });
  it('rounds to 6 decimals', () => {
    expect(siteLocationPinSchema.parse({ latitude: 41.12345678, longitude: -81.98765432 }))
      .toEqual({ latitude: 41.123457, longitude: -81.987654 });
  });
});

describe('siteLocationFieldsSchema', () => {
  it('rejects only one of the pair', () => {
    expect(siteLocationFieldsSchema.safeParse({ latitude: 1 }).success).toBe(false);
    expect(siteLocationFieldsSchema.safeParse({ latitude: null, longitude: 2 }).success).toBe(false);
  });
  it('accepts clearing both', () => {
    expect(siteLocationFieldsSchema.safeParse({ latitude: null, longitude: null }).success).toBe(true);
  });
  it('accepts neither (partial update of other site fields)', () => {
    expect(siteLocationFieldsSchema.safeParse({}).success).toBe(true);
  });
});
```

```ts
// partnerTicketingSettings.test.ts additions
it('accepts timeTracking.locationSuggestions alongside sessionSuggestions', () => {
  expect(timeTrackingSessionSuggestionsSchema.safeParse({
    sessionSuggestions: { enabled: true },
    locationSuggestions: { enabled: true, defaultRadiusM: 200 },
  }).success).toBe(true);
});
it('rejects a typo inside locationSuggestions (strict)', () => {
  expect(timeTrackingSessionSuggestionsSchema.safeParse({ locationSuggestions: { enabld: true } }).success).toBe(false);
});
it('rejects defaultRadiusM out of range', () => {
  expect(timeTrackingSessionSuggestionsSchema.safeParse({ locationSuggestions: { defaultRadiusM: 20 } }).success).toBe(false);
});
it('readTimeTrackingLocationSuggestions is tolerant', () => {
  expect(readTimeTrackingLocationSuggestions({})).toEqual({ settings: {}, valid: true });
  expect(readTimeTrackingLocationSuggestions({ timeTracking: { locationSuggestions: { enabled: 'yes' } } }).valid).toBe(false);
});
```

```ts
// apps/api/src/services/timeSuggestionSettings.test.ts additions
it.each([
  [undefined, { enabled: false, defaultRadiusM: 150 }],
  [{ timeTracking: { locationSuggestions: { enabled: true } } }, { enabled: true, defaultRadiusM: 150 }],
  [{ timeTracking: { locationSuggestions: { enabled: 'true' } } }, { enabled: false, defaultRadiusM: 150 }],
  [{ timeTracking: { locationSuggestions: { enabled: true, defaultRadiusM: 5000 } } }, { enabled: true, defaultRadiusM: 150 }],
])('parseLocationSuggestionSettings(%j)', (raw, expected) => {
  expect(parseLocationSuggestionSettings(raw)).toEqual(expected);
});
```

- [ ] **Step 2: Run — FAIL.** `cd packages/shared && npx vitest run src/validators/siteLocation.test.ts src/validators/partnerTicketingSettings.test.ts`; `cd apps/api && npx vitest run src/services/timeSuggestionSettings.test.ts`.

- [ ] **Step 3: Implement**

```ts
// packages/shared/src/validators/siteLocation.ts
import { z } from 'zod';
export const SITE_RADIUS_MIN_M = 50;
export const SITE_RADIUS_MAX_M = 1000;
export const LOCATION_DEFAULT_RADIUS_M = 150;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const lat = z.number().finite().min(-90).max(90).transform(round6);
const lng = z.number().finite().min(-180).max(180).transform(round6);
const radius = z.number().int().min(SITE_RADIUS_MIN_M).max(SITE_RADIUS_MAX_M);

export const siteLocationPinSchema = z.object({
  latitude: lat,
  longitude: lng,
  geofenceRadiusM: radius.optional(),
}).strict();

export const siteLocationFieldsSchema = z.object({
  latitude: lat.nullable().optional(),
  longitude: lng.nullable().optional(),
  geofenceRadiusM: radius.nullable().optional(),
}).refine(
  (v) => (v.latitude === undefined) === (v.longitude === undefined)
      && ((v.latitude ?? null) === null) === ((v.longitude ?? null) === null),
  { message: 'latitude and longitude must be set together', path: ['latitude'] },
);
```

`partnerTicketingSettings.ts`: add to the `timeTrackingSessionSuggestionsSchema` object

```ts
locationSuggestions: z.object({
  enabled: z.boolean().optional(),
  defaultRadiusM: z.number().int().min(SITE_RADIUS_MIN_M).max(SITE_RADIUS_MAX_M).optional(),
}).strict().optional(),
```

update the doc comment (it now owns both blocks), and add `readTimeTrackingLocationSuggestions` mirroring `readTimeTrackingSessionSuggestions` (`:112-126`) line-for-line on the `locationSuggestions` key. In `timeSuggestionSettings.ts` add `LOCATION_SUGGESTION_DEFAULTS`, `parseLocationSuggestionSettings` (enabled only on explicit `true`; radius integer in 50..1000 else default) and `getLocationSuggestionSettings(partnerId)` reading `partners.settings` in the caller's DB context exactly like `getSessionSuggestionSettings` (`:44-56`).

- [ ] **Step 4: Run — PASS.** Typecheck shared + api.
- [ ] **Step 5: Commit** `feat(shared): site location validators and location-suggestion partner flag (#4186)`.

---

### Task 4: `/start` and `POST /` accept `orgId` / `siteId` / `source` (Rigor: high — money stamping + org access)

**Files:**
- Modify: `packages/shared/src/validators/timeEntries.ts:56-95` (+ test)
- Create: `apps/api/src/services/siteLocation.ts` (only `assertSiteInOrg` in this task)
- Modify: `apps/api/src/services/timeEntryService.ts:644-720` (`createTimeEntry`), `:834-930` (`startTimer`)
- Modify: `apps/api/src/routes/timeEntries/timeEntries.ts:156-178` and the `POST /` handler
- Test: `apps/api/src/services/timeEntryService.test.ts` (or the existing service test file — `ls apps/api/src/services/timeEntryService*.test.ts`), `apps/api/src/routes/timeEntries/timeEntries.test.ts`, new `apps/api/src/__tests__/integration/timeEntryLocationStart.integration.test.ts`

**Interfaces:**
- Consumes: `resolveAndLockOrgLink(orgId, actor)` (`timeEntryService.ts:626`); `PERMISSIONS`; `UserPermissions.allowedSiteIds`.
- Produces:
  - shared `clientTimeEntrySourceSchema = z.enum(['timer','location'])`
  - `startTimerSchema` + `{ orgId?: string; siteId?: string; source?: 'timer'|'location' }` (refine: `siteId` requires `orgId` or `ticketId`)
  - `createTimeEntrySchema` + `{ orgId?: string; siteId?: string; source?: 'location' }`
  - `TimeEntryActor.allowedSiteIds?: string[]` (threaded from `c.get('permissions')` in `timeActorFrom`)
  - `assertSiteInOrg(siteId: string, orgId: string, allowedSiteIds?: string[]): Promise<void>` — throws `TimeEntryServiceError(…, 422, 'SITE_ORG_MISMATCH')` / `(…, 403, 'SITE_DENIED')`
  - `TimeEntryServiceErrorCode` gains `'SITE_ORG_MISMATCH' | 'SITE_DENIED'`

- [ ] **Step 1: Failing tests**

Validator (`timeEntries.test.ts` in shared):

```ts
it.each([
  [{}, true],
  [{ orgId: ORG, source: 'location' }, true],
  [{ orgId: ORG, siteId: SITE, source: 'location' }, true],
  [{ siteId: SITE }, false],                       // site without org or ticket
  [{ orgId: ORG, source: 'remote_session' }, false],
  [{ orgId: ORG, source: 'ai_suggested' }, false],
])('startTimerSchema %j → %s', (input, ok) => {
  expect(startTimerSchema.safeParse(input).success).toBe(ok);
});
it('createTimeEntrySchema rejects source "timer" (a typed entry is never a timer)', () => {
  expect(createTimeEntrySchema.safeParse({ ...validCreate, source: 'timer' }).success).toBe(false);
});
```

Service (mock-db style of the existing service test):

```ts
describe('startTimer with orgId', () => {
  it('stamps org, site and source=location for a ticketless site visit', async () => { /* expect insert values { orgId: ORG, siteId: SITE, ticketId: null, source: 'location' } and the org currency */ });
  it('ticket org wins; mismatched orgId is 422 ORG_MISMATCH', async () => { /* ticket in ORG_A, input.orgId ORG_B */ });
  it('orgId outside accessibleOrgIds is 403 ORG_DENIED', async () => {});
  it('siteId in another org is 422 SITE_ORG_MISMATCH', async () => {});
  it('siteId outside allowedSiteIds is 403 SITE_DENIED', async () => {});
  it('no orgId, no ticketId keeps today\'s behaviour (org null, source timer)', async () => {});
  it('audit/event payload carries source location', async () => {});
});
describe('createTimeEntry with orgId (offline replay of a location visit)', () => {
  it('stamps org currency via resolveAndLockOrgLink and source=location', async () => {});
  it('ticket org wins over orgId; mismatch 422', async () => {});
});
```

Routes (`timeEntries.test.ts`): `POST /start {orgId, siteId, source:'location'}` → service called with those fields and `actor.allowedSiteIds` populated from `permsRef`; `POST /start {source:'remote_session'}` → 400; service `TimeEntryServiceError('…',422,'SITE_ORG_MISMATCH')` → 422 body `{ code: 'SITE_ORG_MISMATCH' }`.

Integration (`timeEntryLocationStart.integration.test.ts`, real Postgres, partner-scope request context): partner P1 tech starts with `orgId` of an org under P1 → row has `org_id`, `site_id`, `source='location'`, `currency_code` = org currency (proves `time_entries_currency_required_when_org_chk` holds); same tech with an org under P2 → 403 `ORG_DENIED`, zero rows.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement**

Shared:

```ts
export const clientTimeEntrySourceSchema = z.enum(['timer', 'location']);
export const startTimerSchema = z.object({
  workTypeId: z.string().uuid().nullable().optional(),
  ticketId: z.string().guid().optional(),
  orgId: z.string().guid().optional(),
  siteId: z.string().guid().optional(),
  source: clientTimeEntrySourceSchema.optional(),
  description: z.string().max(10_000).optional(),
}).refine((v) => !v.siteId || v.orgId || v.ticketId, { message: 'siteId requires orgId or ticketId', path: ['siteId'] });
```

`createTimeEntrySchema`: add `orgId`, `siteId`, `source: z.literal('location').optional()` before the existing `.refine` (keep the `endedAt > startedAt` refine; add the siteId refine as a second `.refine`).

Service — extract a shared helper used by both paths, placed after `resolveAndLockOrgLink`:

```ts
/**
 * #4186: org/site provenance for a ticketless (or ticket-checked) entry.
 * Ticket org always wins (creation barrier #3778 — the ticket path holds the
 * ticket + org locks). Site membership is read unlocked AFTER the org SHARE
 * lock so `organizations` stays this transaction's first lock.
 */
async function resolveLocationLink(
  input: { ticketId?: string; orgId?: string; siteId?: string },
  ticketOrgId: string | null,
  actor: TimeEntryActor,
): Promise<{ orgLink: { orgId: string; currencyCode: string } | null; siteId: string | null }> {
  if (input.ticketId) {
    if (input.orgId && input.orgId !== ticketOrgId) {
      throw new TimeEntryServiceError('orgId does not match the ticket organization', 422, 'ORG_MISMATCH');
    }
    if (input.siteId) await assertSiteInOrg(input.siteId, ticketOrgId!, actor.allowedSiteIds);
    return { orgLink: null, siteId: input.siteId ?? null };
  }
  if (!input.orgId) return { orgLink: null, siteId: null };
  const orgLink = await resolveAndLockOrgLink(input.orgId, actor);
  if (input.siteId) await assertSiteInOrg(input.siteId, orgLink.orgId, actor.allowedSiteIds);
  return { orgLink, siteId: input.siteId ?? null };
}
```

In `startTimer`: after the ticket block, `const loc = await resolveLocationLink(input, orgId, actor); if (loc.orgLink) { orgId = loc.orgLink.orgId; currencyCode = loc.orgLink.currencyCode; }`; insert `siteId: loc.siteId, source: input.source ?? 'timer'`; event payload `source: entry.source`. In `createTimeEntry`: when `input.orgId` and no `provenance.orgLink`, call `resolveLocationLink` and feed its `orgLink` into the existing `else if (provenance.orgLink)` branch; `source: input.source ?? provenance.source`; `siteId`.

```ts
// services/siteLocation.ts
export async function assertSiteInOrg(siteId: string, orgId: string, allowedSiteIds?: string[]) {
  if (allowedSiteIds && !allowedSiteIds.includes(siteId)) {
    throw new TimeEntryServiceError('Access to this site denied', 403, 'SITE_DENIED');
  }
  const [site] = await db.select({ orgId: sites.orgId }).from(sites).where(eq(sites.id, siteId)).limit(1);
  if (!site || site.orgId !== orgId) {
    throw new TimeEntryServiceError('Site does not belong to this organization', 422, 'SITE_ORG_MISMATCH');
  }
}
```

(The `sites` read runs in the request DB context — RLS hides a site in an inaccessible org, which collapses to `SITE_ORG_MISMATCH`; that is intended: no existence oracle.)

Update the `time_entries.source` comment at `schema/timeTracking.ts:76-78` — "server-stamped except `timer`/`location`, which `/start` and `POST /` accept from the client (#4186)".

- [ ] **Step 4: Run — PASS** (unit + the new integration file). Also run `routes/timeEntries/suggestions.test.ts` and `services/timeSuggestionService*.test.ts` — they share `createTimeEntry`.
- [ ] **Step 5: Commit** `feat(api): org and site on timer start and entry create (#4186)`.

---

### Task 5: `GET /time-entries/location-sites` (Rigor: high — tenancy read)

**Files:**
- Modify: `apps/api/src/services/siteLocation.ts` (add `listLocationSites`)
- Create: `apps/api/src/routes/timeEntries/locationSites.ts`, `locationSites.test.ts`
- Modify: `apps/api/src/routes/timeEntries/timeEntries.ts` (mount before `/:id`, next to `timeSuggestionRoutes`)
- Create: `apps/api/src/__tests__/integration/locationSites.integration.test.ts`

**Interfaces:**
- Consumes: `getLocationSuggestionSettings` (Task 3); `notInHiddenOrgCondition` (`services/unassignedPool/visibility.ts:38`); `hasPermission` (`services/permissions.ts:312`).
- Produces: response

```ts
type LocationSitesResponse = {
  enabled: boolean;
  defaultRadiusM: number;
  canSetLocation: boolean;          // caller holds sites:set_location
  sites: Array<{
    id: string; orgId: string; orgName: string; name: string;
    latitude: number | null; longitude: number | null; geofenceRadiusM: number | null;
    locationSource: 'technician' | 'manual' | 'geocoded' | null;
  }>;
  truncated: boolean;               // true when LOCATION_SITES_LIMIT hit
};
```

- [ ] **Step 1: Failing tests**

Route unit: flag off → `200 { enabled:false, defaultRadiusM:150, canSetLocation:false, sites:[], truncated:false }` and `listLocationSites` NOT called; flag on → service called with `{ accessibleOrgIds, allowedSiteIds }`; caller without `sites:read` → `sites: []` (still 200 — the flag answer is useful; the phone hides the feature); org-scope token → 403 (router `requireScope('partner','system')`); registered before `/:id` (assert `GET /location-sites` hits this handler, not the `:id` handler — copy the registration-order test pattern used for suggestions in `timeEntries.test.ts`).

Integration: partner P1 tech with `orgAccess='selected'` [org A] sees A's sites, not B's (same partner) nor P2's; the hidden quick-support org's site is absent; a site-confined user sees only `allowedSiteIds`; `LOCATION_SITES_LIMIT + 1` sites → `truncated:true`.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement**

```ts
// services/siteLocation.ts
export const LOCATION_SITES_LIMIT = 2000;
export async function listLocationSites(scope: { accessibleOrgIds: string[] | null; allowedSiteIds?: string[] }) {
  if (scope.accessibleOrgIds?.length === 0 || scope.allowedSiteIds?.length === 0) return { sites: [], truncated: false };
  const conds = [notInHiddenOrgCondition(sites.orgId)];
  if (scope.accessibleOrgIds) conds.push(inArray(sites.orgId, scope.accessibleOrgIds));
  if (scope.allowedSiteIds) conds.push(inArray(sites.id, scope.allowedSiteIds));
  const rows = await db.select({
      id: sites.id, orgId: sites.orgId, orgName: organizations.name, name: sites.name,
      latitude: sites.latitude, longitude: sites.longitude, geofenceRadiusM: sites.geofenceRadiusM,
      locationSource: sites.locationSource,
    })
    .from(sites).innerJoin(organizations, eq(organizations.id, sites.orgId))
    .where(and(...conds))
    .orderBy(organizations.name, sites.name, sites.id)
    .limit(LOCATION_SITES_LIMIT + 1);
  return { sites: rows.slice(0, LOCATION_SITES_LIMIT), truncated: rows.length > LOCATION_SITES_LIMIT };
}
```

Runs in the request DB context (RLS-backed; never `withSystemDbAccessContext`). The org filter excludes non-active orgs if `organizations` carries a status column used by `GET /orgs/organizations` — mirror that predicate (`grep -n "status" apps/api/src/routes/orgs.ts | grep -i organizations | head`) [not-checked].

Route (`locationSites.ts`): gates `requireScope('partner','system')` + `TIME_ENTRIES_READ`; reads `getLocationSuggestionSettings(auth.partnerId)`; returns the disabled shape early; `canSetLocation = hasPermission(perms, 'sites', 'set_location')`; `canReadSites = hasPermission(perms, 'sites', 'read')`; calls `listLocationSites` only if `canReadSites`.

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `feat(api): location-sites read for the mobile arrival prompt (#4186)`.

---

### Task 6: `POST /orgs/sites/:id/location` + site PATCH location fields (Rigor: high — auth gate without MFA)

**Files:**
- Modify: `apps/api/src/services/siteLocation.ts` (add `pinSiteLocation`)
- Create: `apps/api/src/routes/siteLocation.ts`, `siteLocation.test.ts`
- Modify: `apps/api/src/routes/orgs.ts:402-416` (schemas), `:3118-3194` (PATCH), mount `orgRoutes.route('/', siteLocationRoutes)` near the other `/sites` routes
- Test: `apps/api/src/routes/orgs.test.ts` (or the sites route test file — `ls apps/api/src/routes/orgs*.test.ts`)

**Interfaces:**
- Consumes: `siteLocationPinSchema`, `siteLocationFieldsSchema` (Task 3); `PERMISSIONS.SITES_SET_LOCATION` (Task 2); `ensureOrgAccess`, `isHoldingOrg`, `canAccessSite`, `writeRouteAudit`.
- Produces: `POST /api/v1/orgs/sites/:id/location` → `200 { data: { id, latitude, longitude, geofenceRadiusM, locationSource:'technician', locationSetBy, locationSetAt } }`; audit action `site.location_set`.

- [ ] **Step 1: Failing tests**

```ts
describe('POST /orgs/sites/:id/location', () => {
  it('pins and stamps technician/setBy/setAt; no MFA required', async () => { /* auth.mfa=false; expect 200; db update values */ });
  it('403 without sites:set_location even with sites:read', async () => {});
  it('passes with sites:* wildcard / Partner Admin *:*', async () => {});
  it('404 for a site the caller cannot see', async () => {});
  it('403 for a site outside allowedSiteIds', async () => {});
  it('409 for the unassigned holding org', async () => {});
  it('400 on lat out of range / missing longitude / unknown key', async () => {});
  it('writes site.location_set audit with { latitude, longitude, geofenceRadiusM } only', async () => {});
  it('accepts organization-scope tokens (Org Technician)', async () => {});
});
describe('PATCH /orgs/sites/:id location fields', () => {
  it('stamps location_source=manual when lat/lng change', async () => {});
  it('clearing lat+lng nulls source/setBy/setAt', async () => {});
  it('still requires MFA (unchanged gate)', async () => {});
  it('400 when only latitude is sent', async () => {});
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement**

```ts
// routes/siteLocation.ts
export const siteLocationRoutes = new Hono();
const requireSetLocation = requirePermission(PERMISSIONS.SITES_SET_LOCATION.resource, PERMISSIONS.SITES_SET_LOCATION.action);

// Deliberately NO requireMfa(): a site coordinate is not credential material and
// a field tech pins it from the phone (spec §3, Gate A Q2). Every other site
// field stays behind PATCH /sites/:id + requireMfa().
siteLocationRoutes.post('/sites/:id/location',
  requireScope('organization', 'partner', 'system'), requireSetLocation,
  zValidator('param', z.object({ id: z.string().guid() })),
  zValidator('json', siteLocationPinSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');
    const [site] = await db.select({ id: sites.id, orgId: sites.orgId, name: sites.name }).from(sites).where(eq(sites.id, id)).limit(1);
    if (!site) return c.json({ error: 'Site not found' }, 404);
    if (!(await ensureOrgAccess(site.orgId, auth))) return c.json({ error: 'Access to this site denied' }, 403);
    if (await isHoldingOrg(site.orgId)) return c.json(PROTECTED_ORG_ERROR, 409);
    const perms = c.get('permissions') as UserPermissions | undefined;
    if (perms?.allowedSiteIds && !canAccessSite(perms, site.id)) return c.json({ error: 'Access to this site denied' }, 403);
    const body = c.req.valid('json');
    const updated = await pinSiteLocation(site.id, body, auth.user.id);
    if (!updated) return c.json({ error: 'Failed to update site' }, 500);
    writeRouteAudit(c, { orgId: site.orgId, action: 'site.location_set', resourceType: 'site', resourceId: site.id, resourceName: site.name,
      details: { latitude: body.latitude, longitude: body.longitude, geofenceRadiusM: body.geofenceRadiusM ?? null } });
    return c.json({ data: updated });
  });
```

`ensureOrgAccess`, `isHoldingOrg`, `PROTECTED_ORG_ERROR`, `canAccessSite` live in or are imported by `routes/orgs.ts` — import from their defining modules (`grep -n "export.*ensureOrgAccess\|export.*isHoldingOrg\|export.*PROTECTED_ORG_ERROR\|export function canAccessSite" -r apps/api/src`); if one is file-local to `orgs.ts`, export it rather than duplicate. Mount: confirm `orgRoutes` already applies `authMiddleware` to `/sites/*` before mounting (check the top of `routes/orgs.ts`); the sub-router adds no auth middleware of its own.

`pinSiteLocation` sets `latitude, longitude, geofenceRadiusM (only when provided), locationSource:'technician', locationSetBy: userId, locationSetAt: new Date(), updatedAt: new Date()` and returns the selected fields.

PATCH: `siteBaseSchema` gains `.merge(siteLocationFieldsSchema)` semantics (zod `refine` objects cannot `.merge` — add the three fields to `siteBaseSchema` and put the pair refine on `createSiteSchema` / `updateSiteSchema` with `superRefine`). In the handler, when `data.latitude !== undefined`: if non-null stamp `locationSource:'manual', locationSetBy: auth.user.id, locationSetAt: new Date()`; if null also null those three.

- [ ] **Step 4: Run — PASS.** Plus existing `orgs` site tests.
- [ ] **Step 5: Commit** `feat(api): pin a site location from the field (#4186)`; docs: `reference/organizations-and-sites.mdx` "Site location" subsection.

---

### Task 7: `GET /time-entries` returns and filters `siteId` (Rigor: low)

**Files:** `packages/shared/src/validators/timeEntries.ts:97` (`listTimeEntriesQuerySchema` + `siteId`), `apps/api/src/services/timeEntryService.ts` (`listTimeEntries` select + condition), tests alongside.

- [ ] **Step 1:** Failing route test: `GET /time-entries?siteId=S` → service receives `siteId`; service test: condition `eq(timeEntries.siteId, S)` added; result rows include `siteId` and `source` (assert both keys present on the mapped row; if `source` is already returned, the assertion passes for it and the `siteId` half is the red one).
- [ ] **Step 2:** FAIL. **Step 3:** implement (add to select list / condition list). **Step 4:** PASS. **Step 5:** commit `feat(api): filter time entries by site (#4186)`.

---

### Task 8: Web Time Tracking toggle (Rigor: low)

**Files:**
- Modify: `apps/web/src/components/settings/TimeTrackingSettingsCard.tsx` (+ its test if one exists: `ls apps/web/src/components/settings/TimeTrackingSettingsCard*`)
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/…` (same namespace file the card's existing keys use)

- [ ] **Step 1: Failing test** (jsdom) — renders "Suggest a timer when a technician arrives at a client site" switch off by default; toggling on reveals "Default arrival radius (m)" number input (50–1000); Save sends `PATCH /orgs/partners/me` body `{ settings: { timeTracking: { locationSuggestions: { enabled: true, defaultRadiusM: 150 } } } }` through `runAction`; a radius of 20 shows an inline error and does not submit. Helper text: "Each technician must also allow location on their phone. Location is checked on the phone and is never sent to Breeze."
- [ ] **Step 2:** FAIL. **Step 3:** implement next to the existing session-suggestions block — same save pattern as that block (Settings rule 7: if the card's existing toggle autosaves, autosave; if it uses page Save, use page Save). **Step 4:** PASS + `localeParity.test.ts` + `no-silent-mutations.test.ts` + web typecheck.
- [ ] **Step 5:** commit `feat(web): location suggestion toggle in Time Tracking settings (#4186)`.

---

### Task 9: W1 docs, contract suites, PR (Rigor: high gate)

- [ ] `apps/docs/src/content/docs/features/mobile.mdx`: "Arrival suggestions (coming in the next app release)" stub is **not** added in W1 — docs land with W2. W1 docs = Tasks 2/6 reference updates only.
- [ ] Run locally against `pnpm test-stack up`: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`; integration files from Tasks 1, 2, 4, 5 + `tenantCascade`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `orgMergeRegistry`, `orgLifecycleFoundations` (merge contract — `time_entries.site_id` is a plain FK, not composite, so it is unaffected [inferred], run it anyway). Full API unit suite once (`cd apps/api && npx vitest run`, batches if the host is loaded) — `orgMerge.test.ts` only reds in the full run.
- [ ] `pnpm test-stack down`.
- [ ] PR body: settings rule-9 block; "Spec deviations" list from this plan (OD-1, OD-2, the `POST /` extension); no security-impact wording.
- [ ] `/pr-review-toolkit:review-pr` (Sonnet reviewers), one round.

---

# W2 — Foreground arrival prompt (mobile)

### Task 10: `expo-location` + permission state machine (Rigor: medium — App Review copy)

**Files:**
- Modify: `apps/mobile/package.json` (`npx expo install expo-location` — SDK-57-matched version), `apps/mobile/app.json`
- Create: `apps/mobile/src/services/locationPermission.ts`, `locationPermission.test.ts`

**Interfaces:**
- Produces:

```ts
export type LocationPermissionState =
  | 'undetermined' | 'granted' | 'granted-approximate' | 'denied-can-ask' | 'denied-blocked' | 'services-off';
export function toLocationPermissionState(
  perm: { status: 'granted'|'denied'|'undetermined'; canAskAgain: boolean; ios?: { accuracy?: 'full'|'reduced' }; android?: { accuracy?: 'fine'|'coarse'|'none' } },
  servicesEnabled: boolean,
): LocationPermissionState;
export function canReadForArrival(s: LocationPermissionState): boolean; // only 'granted'
```

- [ ] **Step 1: Failing table test** covering every row of the "OS permission flows" section: `services-off` wins over all; `granted + ios reduced` → `granted-approximate`; `granted + android coarse` → `granted-approximate`; `denied + canAskAgain:false` → `denied-blocked`; `denied + canAskAgain:true` → `denied-can-ask`; `canReadForArrival` true only for `granted`.
- [ ] **Step 2:** FAIL. **Step 3:** implement (pure; no `expo-location` import in this file so the node test env needs no native stub).
- [ ] **Step 4: app.json**

```json
"ios": { "infoPlist": {
  "NSLocationWhenInUseUsageDescription": "Breeze checks your location on this phone while the app is open to suggest starting a timer when you arrive at a client site. Your location is not sent to Breeze unless you choose to save it as a site's location."
}},
"android": { "permissions": ["ACCESS_COARSE_LOCATION", "ACCESS_FINE_LOCATION"] },
"plugins": [["expo-location", { "locationWhenInUsePermission": "<same string>", "isIosBackgroundLocationEnabled": false, "isAndroidBackgroundLocationEnabled": false }]]
```

Assert in a config test (`apps/mobile/src/config/appJson.test.ts` — create if absent) that `app.json` contains **no** `NSLocationAlways*`, no `UIBackgroundModes` containing `location`, no `ACCESS_BACKGROUND_LOCATION` (guards W3 leaking into W2).
- [ ] **Step 5:** PASS; `cd apps/mobile && npx tsc --noEmit`. Commit `feat(mobile): foreground location permission (#4186)`.

---

### Task 11: Haversine + arrival matcher + suppression (Rigor: medium — pure, Sonnet)

**Files:** Create `apps/mobile/src/services/geo.ts`, `geo.test.ts`, `arrivalMatch.ts`, `arrivalMatch.test.ts`

**Interfaces:**
- Produces:

```ts
// geo.ts
export function haversineMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number;

// arrivalMatch.ts
export const MAX_FIX_ACCURACY_M = 500;
export const DISMISS_SUPPRESS_MS = 4 * 3600_000;
export const RECENT_STOP_SUPPRESS_MS = 30 * 60_000;
export const READ_DEBOUNCE_MS = 5 * 60_000;
export type SiteCandidate = { siteId: string; orgId: string; orgName: string; siteName: string; distanceM: number };
export type Fix = { latitude: number; longitude: number; accuracyM: number | null; atMs: number };
export type CachedSite = { id: string; orgId: string; orgName: string; name: string; latitude: number | null; longitude: number | null; geofenceRadiusM: number | null };
export function matchCandidates(fix: Fix, sites: CachedSite[], defaultRadiusM: number): SiteCandidate[];
export type ArrivalDecision =
  | { kind: 'none'; reason: 'flag-off' | 'timer-running' | 'poor-accuracy' | 'no-candidates' | 'all-suppressed' }
  | { kind: 'prompt'; candidates: SiteCandidate[]; preselectSiteId: string | null };
export function decideArrival(input: {
  enabled: boolean; timerRunning: boolean; fix: Fix; sites: CachedSite[]; defaultRadiusM: number;
  dismissedAt: Record<string, number>; lastStopAt: Record<string, number>; lastPick: Record<string, string>; nowMs: number;
}): ArrivalDecision;
export function shouldReadPosition(lastReadMs: number | null, nowMs: number, manualRefresh: boolean): boolean;
export type StopDecision = { kind: 'none' } | { kind: 'prompt'; siteId: string };
export function decideStillHere(input: {
  running: { source: string | null; siteId: string | null } | null;
  site: CachedSite | null; defaultRadiusM: number;
  farReads: Array<{ atMs: number; distanceM: number }>; // reads > 2× radius, newest last
}): StopDecision;
```

- [ ] **Step 1: Failing tests** (table-driven)

```ts
it('haversine: 1° latitude ≈ 111.2 km', () => {
  expect(haversineMeters({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 })).toBeCloseTo(111_195, -2);
});
it('haversine: identical points = 0; antimeridian 179.999/-179.999 ≈ 222 m at equator', () => {});

describe('matchCandidates', () => {
  it('drops sites without coordinates', () => {});
  it('uses site radius, else partner default', () => {});
  it('widens to fix accuracy: radius 100, accuracy 300, site 250 m away → match', () => {});
  it('sorts by distance, ties by siteName', () => {});
});
describe('decideArrival', () => {
  it('flag off → none/flag-off (checked first)', () => {});
  it('timer running → none/timer-running even with candidates', () => {});
  it('accuracy 501 → poor-accuracy; accuracy null → poor-accuracy', () => {});
  it('one candidate → prompt with that one', () => {});
  it('two candidates 5 m apart → prompt with both, never auto-picked', () => {});
  it('dismissed 3h59m ago → suppressed; 4h01m → shown', () => {});
  it('stopped at this site 29 min ago → suppressed; other candidate still shown', () => {});
  it('lastPick for a candidate → preselectSiteId', () => {});
});
describe('shouldReadPosition', () => {
  it('first read → true; 4m59s later → false; manual refresh → true; 5m → true', () => {});
});
describe('decideStillHere', () => {
  it('only for source=location timers with a site', () => {});
  it('needs two far reads ≥ 5 min apart', () => {});
  it('one far read → none; two far reads 4 min apart → none', () => {});
  it('far = > 2× (site radius ?? default)', () => {});
});
```

- [ ] **Step 2:** FAIL. **Step 3:** implement (Earth radius 6_371_000 m; clamp the haversine `a` to [0,1]). **Step 4:** PASS. **Step 5:** commit `feat(mobile): arrival matcher and suppression rules (#4186)`.

---

### Task 12: Sites client/cache, arrival memory, timer plumbing (Rigor: medium)

**Files:**
- Create: `apps/mobile/src/services/locationSites.ts` (+ test), `arrivalMemory.ts` (+ test)
- Modify: `apps/mobile/src/services/localTimer.ts:16-40`, `services/timeEntries.ts:173-215`, `screens/tickets/timerActions.ts` (+ `timerActions.test.ts`), the stop→`create` mapping (find with `grep -n "kind: 'create'" apps/mobile/src -r`)

**Interfaces:**
- Consumes: `coreRequest` (`services/api.ts`); AsyncStorage stub `src/testing/asyncStorageStub.ts`.
- Produces:

```ts
// locationSites.ts
export const LOCATION_SITES_CACHE_KEY = 'breeze.locationSites.v1';
export const LOCATION_SITES_TTL_MS = 24 * 3600_000;
export type LocationSitesSnapshot = { enabled: boolean; defaultRadiusM: number; canSetLocation: boolean; sites: CachedSite[]; fetchedAtMs: number };
export async function getLocationSites(opts: { nowMs: number; force?: boolean }): Promise<LocationSitesSnapshot | null>;
export async function invalidateLocationSites(): Promise<void>;

// arrivalMemory.ts  (key 'breeze.arrival.v1'; entries older than 24 h pruned on write)
export async function readArrivalMemory(): Promise<{ dismissedAt: Record<string, number>; lastStopAt: Record<string, number>; lastPick: Record<string, string> }>;
export async function recordDismiss(siteIds: string[], nowMs: number): Promise<void>;
export async function recordStopAtSite(siteId: string, nowMs: number): Promise<void>;
export async function recordPick(groupKey: string, siteId: string): Promise<void>; // groupKey = sorted candidate ids joined by ','

// localTimer.ts — LocalTimer gains:
orgId?: string | null; siteId?: string | null; source?: 'timer' | 'location';

// timeEntries.ts — startTimer input gains orgId?, siteId?, source?; createTimeEntry input gains orgId?, siteId?, source?: 'location'

// timerActions.ts
export async function startForSite(
  target: { orgId: string; siteId: string; ticketId: string | null },
  deps: StartDeps,
): Promise<StartOutcome>;
```

- [ ] **Step 1: Failing tests**
  - `getLocationSites`: no cache → fetches; fresh cache (<24 h) → no fetch; stale → fetch; fetch fails with stale cache → returns stale; 403 → returns `null` and clears cache; `enabled:false` response cached (so a disabled partner is not re-fetched every foreground); `logout` reset clears the key (add the key to the logout-clear list — `grep -rn "localTimer.v1\|removeItem" apps/mobile/src/store | head` to find it).
  - `arrivalMemory`: round-trip; prune > 24 h; corrupted JSON → empty memory, no throw.
  - `startForSite`: sends `{ ticketId?, orgId, siteId, source:'location' }`; offline → local timer carries `orgId/siteId/source`; `ENTRY_RUNNING` → existing `already-running` outcome; `ORG_DENIED`/403 → `{ ok:false, reason:'forbidden' }` (same mapping as `startForTicket`) **and** calls `invalidateLocationSites()` via an injected dep.
  - stop of a local location timer queues `create` with `orgId`, `siteId`, `source:'location'` (and with `ticketId` when present); a legacy `LocalTimer` with none of the three keys produces today's `create` byte-for-byte.
- [ ] **Step 2:** FAIL. **Step 3:** implement — `startForSite` reuses `startForTicket`'s body: refactor the body into `startWith(target: { ticketId: string | null; orgId?: string; siteId?: string; source?: 'location' }, deps, options)` and make both exported functions thin wrappers (keeps one copy of the persist-before-network ordering). **Step 4:** PASS + existing `timerActions.test.ts`, `timeEntryQueue.test.ts`, `timerReconcile.test.ts`. **Step 5:** commit `feat(mobile): site-aware timer start and location sites cache (#4186)`.

---

### Task 13: ArrivalSheet + trigger hook (Rigor: medium — Claude does the RN wiring)

**Files:**
- Create: `apps/mobile/src/screens/time/arrivalSheetLogic.ts` (+ test), `ArrivalSheet.tsx`, `useArrivalPrompt.ts`
- Modify: `apps/mobile/src/navigation/MainNavigator.tsx:238` (mount beside `TimerBar`), Tickets tab pull-to-refresh handler (pass `manualRefresh:true`)

**Interfaces:**
- Consumes: `decideArrival`, `shouldReadPosition` (Task 11); `getLocationSites`, arrival memory, `startForSite` (Task 12); `toLocationPermissionState` (Task 10); Redux `state.time.running`, `state.tickets` (open tickets, `orgId`).
- Produces:

```ts
// arrivalSheetLogic.ts
export type SheetStep =
  | { step: 'pick-site'; candidates: SiteCandidate[]; highlighted: string | null }
  | { step: 'pick-ticket'; site: SiteCandidate; tickets: Array<{ id: string; label: string }>; preselectedTicketId: string | null }
  | { step: 'confirm-no-ticket'; site: SiteCandidate };
export function initialStep(candidates: SiteCandidate[], preselect: string | null, ticketsForOrg: (orgId: string) => Array<{ id: string; label: string }>): SheetStep;
export function afterSitePicked(site: SiteCandidate, ticketsForOrg: (orgId: string) => Array<{ id: string; label: string }>): SheetStep;
export function arrivalCopy(step: SheetStep): { title: string; primary: string; secondary: string };
```

- [ ] **Step 1: Failing tests** (`arrivalSheetLogic.test.ts`)
  - 1 candidate, 0 tickets → `confirm-no-ticket`; title "Looks like you're at Acme Corp — Main Office." primary "Start timer" secondary "Not now".
  - 1 candidate, 1 ticket → `pick-ticket` with that ticket preselected (still one confirming tap).
  - 1 candidate, 3 tickets → `pick-ticket` with none preselected + "Site visit — no ticket" row.
  - 2 candidates → `pick-site`, rows "Acme Corp — Main Office · 40 m", distance rounded to 10 m under 1 km, title "You're near:"; `highlighted` = preselect.
  - tickets filter: only status not closed/resolved and assigned to me (match the Tickets tab "My open" filter — find its selector with `grep -rn "createSelector\|selectMy" apps/mobile/src/store/ticketsSlice.ts`).
- [ ] **Step 2:** FAIL. **Step 3:** implement logic; then the thin `ArrivalSheet.tsx` (RN `Modal`, layout copied from `SuggestionConfirmSheet.tsx`) and `useArrivalPrompt`:
  - triggers: `AppState` → `active` (precedent `navigation/AppLockGate.tsx:148`), Home/Tickets tab focus, Tickets pull-to-refresh (`manualRefresh`);
  - order of checks (cheap → expensive, no permission dialog ever from this hook): snapshot `enabled` → `timerRunning` (Redux + `readLocalTimer()`) → permission state `granted` (via `getForegroundPermissionsAsync`, never `request…`) → `shouldReadPosition` → `getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })` → `decideArrival`;
  - **re-check `timerRunning` at tap time**; if a timer started meanwhile, close the sheet without starting;
  - Start → `startForSite`; success → `recordPick`; `already-running` → existing toast copy; any error → toast, close;
  - Not now → `recordDismiss(all candidate ids)`;
  - analytics `track('location_prompt_shown', { candidates: n })`, `location_prompt_started`, `location_prompt_dismissed` — no ids, names or distances (`lib/analytics.ts:13-16`).
- [ ] **Step 4:** PASS + `npx tsc --noEmit`. **Step 5:** commit `feat(mobile): arrival prompt sheet (#4186)`.

---

### Task 14: Site pin from the phone (Rigor: medium)

**Files:** Create `apps/mobile/src/screens/time/sitePinLogic.ts` (+ test), `SitePinButton.tsx`, `apps/mobile/src/services/siteLocationApi.ts`; modify `TicketDetailScreen.tsx`, `TimesheetScreen.tsx` entry editor.

**Interfaces:**
- Produces:

```ts
export const PIN_MAX_ACCURACY_M = 100;
export function pinTargets(snapshot: LocationSitesSnapshot | null, orgId: string | null): CachedSite[]; // org's sites w/o coords; [] unless canSetLocation
export type PinOutcome = { ok: true } | { ok: false; message: string };
export function pinPreflight(fix: Fix | null): PinOutcome; // accuracy null or > 100 → "Location isn't precise enough here. Step outside or near a window and try again."
// siteLocationApi.ts
export async function pinSiteLocation(siteId: string, fix: { latitude: number; longitude: number }): Promise<void>; // POST /orgs/sites/:id/location
```

- [ ] **Step 1: Failing tests:** `pinTargets` hidden when `canSetLocation:false`, when the snapshot is disabled, when the org has no unpinned sites; multiple unpinned sites → all listed (UI shows a picker); `pinPreflight` at 100 → ok, 101 → message, null → message.
- [ ] **Step 2:** FAIL. **Step 3:** implement; button label "Save my current location as <site>"; uses `getCurrentPositionAsync({ accuracy: Location.Accuracy.High })`; success → `invalidateLocationSites()` + `track('site_pinned')` + toast "Saved. Breeze will suggest a timer next time you're here."; 403 → toast "You don't have permission to set site locations." and invalidate snapshot. If permission is `undetermined`, this button **may** call `requestForegroundPermissionsAsync()` (it is an explicit user action) — the arrival hook never does.
- [ ] **Step 4:** PASS. **Step 5:** commit `feat(mobile): pin a site location from the phone (#4186)`.

---

### Task 15: "Still at Acme?" foreground stop prompt (Rigor: medium)

**Files:** extend `useArrivalPrompt.ts`; `arrivalMatch.ts` `decideStillHere` already tested (Task 11); persist far-read history in `arrivalMemory` (`farReads` keyed by running entry id, cleared on stop).

- [ ] **Step 1: Failing tests** (`arrivalMemory.test.ts`): `recordFarRead(entryKey, read)` keeps the last 3; `clearFarReads(entryKey)`; and (`arrivalSheetLogic.test.ts`) `stillHereCopy({ siteName, runningMinutes: 148 })` → `"Still at Acme Corp? Timer has been running 2h 28m."`, primary "Stop", secondary "Keep running".
- [ ] **Step 2:** FAIL. **Step 3:** on each foreground read with a running `source:'location'` timer, record far reads; on `decideStillHere → prompt`, show the sheet; **Stop** calls the existing stop action (tap time; no `endedAt`) and `recordStopAtSite`; **Keep running** clears far reads.
- [ ] **Step 4:** PASS. **Step 5:** commit `feat(mobile): foreground still-on-site check (#4186)`.

---

### Task 16: Settings row + explainer (Rigor: low)

**Files:** the mobile Settings screen (`grep -rln "Settings" apps/mobile/src/screens | head`), create `apps/mobile/src/screens/settings/locationSettingsLogic.ts` (+ test).

- [ ] **Step 1: Failing test:** `locationRowCopy(state, partnerEnabled)` for every `LocationPermissionState` × enabled, matching the "OS permission flows" copy (partner off → row hidden; `denied-blocked` → "Location is off for Breeze — open Settings"; `granted-approximate` → "Precise location is off — suggestions need it"; `granted` → "On"; `undetermined` → "Turn on"). Explainer card visibility: partner on + `undetermined` + not dismissed within 30 days.
- [ ] **Step 2:** FAIL. **Step 3:** implement; "Turn on" → `requestForegroundPermissionsAsync()`; blocked → `Linking.openSettings()`. **Step 4:** PASS. **Step 5:** commit `feat(mobile): location suggestion settings row (#4186)`.

---

### Task 17: W2 docs, device check, PR

- [ ] `apps/docs/src/content/docs/features/mobile.mdx`: "Arrival suggestions" section — what it does, partner toggle location, both opt-ins, what is and is not sent, how to pin a site, iOS/Android permission states table (copy from this plan's OS section).
- [ ] Release-notes bullet.
- [ ] Manual device check (iOS simulator `Features → Location → Custom Location` + one Android emulator): flag off → no dialog; first-run explainer → grant → arrive (custom location at a pinned site) → sheet → start → timer bar shows; deny → never re-prompts; approximate → no prompt + settings row message; pin flow with accuracy > 100 m rejected. Record results in the PR body (verified vs not-checked).
- [ ] Full mobile suite `cd apps/mobile && npx vitest run`, typecheck.
- [ ] `/pr-review-toolkit:review-pr`, one round.

---

## Open Decisions

Each has a recommended default the implementer applies unless Todd overrides.

**OD-1 — Mobile data source: new `GET /time-entries/location-sites` vs spec's `GET /orgs/sites`.**
- **A — new endpoint (plan default):** one call returns flag + radius default + `canSetLocation` + all candidate sites with org names; no 100-row paging; no `address/contact/settings` jsonb on the phone; the phone needs no `organizations:read` to learn the flag. Con: one more route (deviates from spec §3 "mobile caches `/orgs/sites`").
- **B — spec as written:** page `GET /orgs/sites` + read the flag somewhere. Con: up to N/100 requests, no org names (needs a third call), and Partner/Org Technicians cannot read `GET /partners/me`.
- **Recommend A** — the spec's premise ("already returns the full row") holds, but the flag and org name do not ride along.

**OD-2 — `endedAt` on `POST /time-entries/stop` (spec §2.4): build in W1 or defer to W3?**
- **A — defer to W3 (plan default):** its only caller is the background exit event; W3 is held. YAGNI; avoids an unused, client-supplied time field on a billing path.
- **B — build in W1 per spec:** ready when W3 unblocks; con: unused, untested-in-practice surface.
- **Recommend A.**

**OD-3 — Accepting `source` from the client.**
- **A — restricted enum `timer|location` on `/start`, `location` on `POST /` (plan default):** provenance is informational (reporting "how much time was location-started"), not trust-bearing; billing, approval, and RLS ignore it. Con: relaxes the "server-stamped only" comment at `timeTracking.ts:76-78`.
- **B — server infers `location` whenever `siteId` is present:** con: a manual "site visit" pick (future) would be mislabelled.
- **Recommend A.**

**OD-4 — Who gets `sites:set_location` by default.**
- **A — Partner Technician + Org Technician + Org Admin (plan default)** (Partner Admin via `*:*`). The people who go on-site can pin.
- **B — Org Admin only:** pin path dead for most techs (the reason Gate A Q2 added the permission).
- **Recommend A.**

**OD-5 — Stale `site_id` after a ticket/device org move.** `time_entries.org_id` is rewritten by the ticket mover (`ticketService.ts`) and the device mover (`deviceOrgMove/moveDeviceOrgInTransaction.ts`); `site_id` would keep pointing at a site in the old org.
- **A — read-side guard (plan default):** any reader that resolves a site from `time_entries.site_id` (none in W1/W2 — `GET /time-entries` returns the raw id) must also require `sites.org_id = time_entries.org_id`; record this rule in the `siteId` Drizzle comment. Movers untouched — no change to their lock-order/deadlock contracts.
- **B — movers null `site_id`:** cleaner data; con: edits two high-blast movers and their lock-order lists for an informational column.
- **Recommend A**; revisit if a report ever groups by site.

**OD-6 — Sheet component.** **A — RN `Modal` per W06 precedent (plan default)**; **B — add `@gorhom/bottom-sheet`** (native feel, new dependency + reanimated config). **Recommend A.**

**OD-7 — Re-asking after "Allow Once" (iOS) / "Only this time" (Android).** **A — do not re-show the explainer; the Settings row offers "Turn on" (plan default)**; **B — re-show the explainer each launch** (nags). **Recommend A.**

**OD-8 — Site list size cap.** `LOCATION_SITES_LIMIT = 2000` with `truncated:true` (phone matches what it got). **A — cap + truncated flag (plan default)**; **B — server-side nearest-N with a coordinate in the query** — rejected: sends the position to the server, crossing spec §1's privacy line. **Recommend A.**

**OD-9 — W4 (web map pin) not approved at Gate A.** Without it, pins come only from phones and from `PATCH /orgs/sites/:id` (API). **A — keep W4 out of this plan (plan default)**; **B — add plain lat/lng/radius number inputs to the web site form in W1** (small, no map). **Recommend A** unless MSPs need to pre-pin sites from the office before rollout — then B as a W1 add-on task.

## Not planned here

- **W3 background geofencing** — held (Gate A Q3) until a real-device Android matrix exists (Samsung/Xiaomi battery managers). Owns `endedAt` (OD-2), `Always` permission, `expo-task-manager`, 20-region cap.
- **W4 web map pin + optional geocoding** — outside Gate A approval; separate spec gate + plan.
