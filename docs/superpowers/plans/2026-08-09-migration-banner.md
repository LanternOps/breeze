# Agent Migration Banner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the agent-reported `migrationRequired` signal on the web dashboard: persist it on the `devices` row, expose a fleet count, and show a **persistent, non-dismissible** banner to admins of a self-hosted instance when any device reports it — telling them to migrate to the self-host agent edition.

**Architecture:** The agent already emits `agentEdition` / `migrationRequired` on the heartbeat (shipped separately, inert for self-host). This plan is the consumer: (1) two new `devices` columns + the export-policy classification the repo requires for new columns; (2) heartbeat schema accepts + persists the fields (self-healing write); (3) the existing `GET /devices/stats` aggregate gains `migrationRequiredCount`; (4) a site-wide banner island reads that count and renders a persistent notice. No agent changes.

**Tech Stack:** API (Hono + Drizzle + Zod), Postgres (hand-written idempotent migration), web (Astro + React islands, react-i18next), Vitest.

## Global Constraints

- **DB blast radius → full rigor.** `devices` is a registered `org_id`-cascade + export-policy table. Adding COLUMNS fires the **export-policy contract** (`tenant-export-policy.integration.test.ts`): both new columns MUST be classified in `CORE_TENANT_EXPORT_POLICY` in the same change or CI reds. RLS needs no new policy (columns inherit the table's row policy); no cascade-list change (same table, no new FK). See `CLAUDE.md` "Cascade registration" — the export-policy row is the one that fires on a new column.
- **Migration conventions:** hand-written SQL in `apps/api/migrations/`, filename `2026-08-09-<slug>.sql` (today's date sorts last — do NOT reuse the closed `2026-08-06` block). Idempotent (`ADD COLUMN IF NOT EXISTS`). No inner `BEGIN/COMMIT`. Re-applying must be a no-op. Run `pnpm db:check-drift` after. Check the migrations dir first for any other `2026-08-09-*` file and use the `-a-/-b-` infix only if a same-day dependency exists.
- **Self-healing write:** persist both fields UNCONDITIONALLY every heartbeat (the `outboundNetworkPolicyVersion` pattern, NOT the sticky `isVirtual` pattern) so a resolved condition (device re-enrolls to hosted, or allowlist changes) clears the banner on the next beat. An omitted field → default (`migration_required=false`, `agent_edition=null`).
- **Banner is PERSISTENT** — no dismiss control, no local "seen" state. It renders `null` purely on the server condition and reappears until the fleet count is 0 (model: `MacOSPermissionsBanner`). This is deliberately NOT the what's-new splash pattern.
- **i18n key parity:** new web strings in all 7 locales (`en, de-DE, es-419, fr-CA, fr-FR, it-IT, pt-BR`) or `localeParity.test.ts` reds.
- **Web mutations use `runAction`** — N/A here (read-only banner; no mutation).
- **Fresh branch off `main`** (unrelated to current branch). Neutral commit messages.

---

### Task 1: `devices` columns + migration + export-policy classification

**Files:**
- Modify: `apps/api/src/db/schema/devices.ts` (two columns, near `agent_server_url` / `outbound_network_policy_version`)
- Create: `apps/api/migrations/2026-08-09-device-agent-edition-migration-required.sql`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (classify both columns)

**Interfaces:**
- Produces: `devices.agentEdition` (`agent_edition varchar(20)`, nullable) and `devices.migrationRequired` (`migration_required boolean not null default false`) in the Drizzle schema; both classified `included` in the export policy.

- [ ] **Step 1: Add the columns to the Drizzle schema**

In `apps/api/src/db/schema/devices.ts`, near the existing `agentServerUrl` / `outboundNetworkPolicyVersion` columns, add:

```ts
  agentEdition: varchar('agent_edition', { length: 20 }),
  migrationRequired: boolean('migration_required').notNull().default(false),
```

(Confirm `varchar`/`boolean` are already imported in this file — they are, since existing columns use them.)

- [ ] **Step 2: Write the idempotent migration**

Create `apps/api/migrations/2026-08-09-device-agent-edition-migration-required.sql`:

```sql
-- Agent-reported build edition + migration-needed flag (heartbeat telemetry).
-- Non-sensitive; drives the self-hosted migration banner. Written unconditionally
-- every heartbeat (self-healing), so a resolved condition clears next beat.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS agent_edition varchar(20);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS migration_required boolean NOT NULL DEFAULT false;
```

(First check `ls apps/api/migrations/ | grep 2026-08-09` — if another same-day migration exists and this depends on it, use the `-a-/-b-` infix; otherwise the plain name is correct.)

- [ ] **Step 3: Classify both columns in the export policy**

In `apps/api/src/services/tenantExportPolicyRegistry.ts`, find the `devices` table entry (built via `tablePolicy(orgKey, groups)`). Add both new columns to its **`included`** group — they are ordinary non-sensitive telemetry (varchar enum + boolean; no `SUSPICIOUS_NAME_PARTS`, not json/bytea, so `included` is correct, not `excludedOpen`/`excludedSensitive`). Match the exact shape of the existing `included` list for `devices` (read it first; add `'agent_edition'` and `'migration_required'` alongside columns like `agent_server_url`).

- [ ] **Step 4: Verify drift + export-policy contract**

Run:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm --filter @breeze/api db:check-drift
```
Expected: no drift (schema matches migration).

Then the export-policy contract (needs a live DB — the integration config):
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts tenant-export-policy
```
Expected: PASS — both columns are classified; an unclassified column fails this suite.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema/devices.ts apps/api/migrations/2026-08-09-device-agent-edition-migration-required.sql apps/api/src/services/tenantExportPolicyRegistry.ts
git commit -m "feat(devices): add agent_edition + migration_required columns (export-policy classified)"
```

---

### Task 2: Heartbeat accepts + persists the fields (self-healing)

**Files:**
- Modify: `apps/api/src/routes/agents/schemas.ts` (`heartbeatSchema`, near `securityCapabilities`)
- Modify: `apps/api/src/routes/agents/heartbeat.ts` (`deviceUpdates` in the main-agent branch)
- Test: `apps/api/src/routes/agents/heartbeat.test.ts` (or the existing heartbeat test file — place alongside)

**Interfaces:**
- Consumes: `devices.agentEdition` / `devices.migrationRequired` (Task 1).
- Produces: heartbeat requests may carry `agentEdition?: 'hosted'|'self-host'` + `migrationRequired?: boolean`; both persisted to the device row every beat.

- [ ] **Step 1: Write the failing test**

Add to the heartbeat route test (mirror an existing heartbeat test's request/setup):

```ts
it('persists agentEdition + migrationRequired from the heartbeat, self-healing', async () => {
  // POST a heartbeat with the fields set → device row updated.
  await postHeartbeat(deviceId, { /* ...base fields..., */ agentEdition: 'hosted', migrationRequired: true });
  let row = await getDevice(deviceId);
  expect(row.agentEdition).toBe('hosted');
  expect(row.migrationRequired).toBe(true);

  // POST a later heartbeat WITHOUT the fields → cleared to defaults (self-healing).
  await postHeartbeat(deviceId, { /* ...base fields... */ });
  row = await getDevice(deviceId);
  expect(row.migrationRequired).toBe(false);
  expect(row.agentEdition).toBeNull();
});
```

(Use the file's existing helpers for posting a heartbeat and reading the device row — read an adjacent test and reuse them; do not invent a harness.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run heartbeat`
Expected: FAIL — fields not accepted/persisted.

- [ ] **Step 3: Add the schema fields**

In `apps/api/src/routes/agents/schemas.ts`, in `heartbeatSchema` next to `securityCapabilities`:

```ts
    agentEdition: z.enum(['hosted', 'self-host']).optional().catch(undefined),
    migrationRequired: z.boolean().optional().catch(undefined),
```

(`.optional().catch(undefined)` — the repo convention so a malformed telemetry value degrades instead of 400ing the whole heartbeat.)

- [ ] **Step 4: Persist them unconditionally in `deviceUpdates`**

In `apps/api/src/routes/agents/heartbeat.ts`, in the `deviceUpdates` object built in the main (non-watchdog) branch, add:

```ts
    agentEdition: data.agentEdition ?? null,
    migrationRequired: data.migrationRequired ?? false,
```

(Unconditional, like `outboundNetworkPolicyVersion` — an omitted field self-heals to the default. Confirm the Drizzle property names match the schema: `agentEdition`, `migrationRequired`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @breeze/api exec vitest run heartbeat`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/agents/schemas.ts apps/api/src/routes/agents/heartbeat.ts apps/api/src/routes/agents/heartbeat.test.ts
git commit -m "feat(agents): accept + persist agentEdition/migrationRequired on heartbeat (self-healing)"
```

---

### Task 3: `GET /devices/stats` exposes `migrationRequiredCount`

**Files:**
- Modify: `apps/api/src/routes/devices/stats.ts` (add a filtered count to the existing aggregate)
- Modify: `apps/web/src/components/dashboard/types.ts` (`DeviceStats`)
- Test: `apps/api/src/routes/devices/stats.test.ts` (alongside)

**Interfaces:**
- Consumes: `devices.migrationRequired` (Task 1).
- Produces: `GET /devices/stats` response `data` gains `migrationRequiredCount: number`; `DeviceStats` type gains the same field.

**Context:** `stats.ts` already does an in-SQL aggregate over the tenant-scoped `devices` set (ambient RLS via `authMiddleware` + `buildDeviceScope`), and the dashboard already fetches it on every load. One more filtered count is far cheaper than a new endpoint or a device list.

- [ ] **Step 1: Write the failing test**

Add to `stats.test.ts` (mirror the existing stats test setup):

```ts
it('counts devices with migrationRequired', async () => {
  // seed 2 devices with migration_required=true, 1 false, in the tenant
  const res = await getStats();
  expect(res.data.migrationRequiredCount).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run devices/stats`
Expected: FAIL — field absent.

- [ ] **Step 3: Add the filtered count**

In `stats.ts`, extend the existing aggregate `select` with a filtered count and include it in the response. Read the current query and add, in the same `db.select({...})`:

```ts
    migrationRequiredCount: sql<number>`count(*) filter (where ${devices.migrationRequired})`.mapWith(Number),
```

and add `migrationRequiredCount` to the returned `data` object. (Match how the existing counts — `total`/`online` — are selected and mapped; reuse the same `sql`/`count` import already in the file.)

- [ ] **Step 4: Add to the web type**

In `apps/web/src/components/dashboard/types.ts`, add to `DeviceStats`:

```ts
  migrationRequiredCount: number;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @breeze/api exec vitest run devices/stats`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/devices/stats.ts apps/web/src/components/dashboard/types.ts apps/api/src/routes/devices/stats.test.ts
git commit -m "feat(devices): add migrationRequiredCount to /devices/stats"
```

---

### Task 4: Persistent `MigrationRequiredBanner` + i18n + mount

**Files:**
- Create: `apps/web/src/components/devices/MigrationRequiredBanner.tsx`
- Modify: `apps/web/src/layouts/DashboardLayout.astro` (mount site-wide)
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR}/common.json`
- Test: `apps/web/src/components/devices/MigrationRequiredBanner.test.tsx` + run `localeParity.test.ts`

**Interfaces:**
- Consumes: `GET /devices/stats` → `migrationRequiredCount` (Task 3); `useFeatures()` (self-hosted proxy); the admin-permission check.
- Produces: a `default` export `MigrationRequiredBanner` (no props).

**Context:** Model the show/hide on `MacOSPermissionsBanner.tsx` (self-fetching, polls, renders `null` on a pure server-condition check, zero dismiss state), but mount it site-wide like `ContextScopeLine`. Gate on THREE conditions, all client-side: self-hosted deployment, `migrationRequiredCount > 0`, and the current user is an admin.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/devices/MigrationRequiredBanner.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import MigrationRequiredBanner from './MigrationRequiredBanner';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: any) => (o?.count != null ? `${k}:${o.count}` : k) }) }));
// Mock the data source + gates to the SHOWN state; then flip each gate to prove it hides.
// (Mirror how sibling banner tests mock fetchWithAuth / useFeatures / the admin check —
//  read MacOSPermissionsBanner.test.tsx or an adjacent banner test and reuse its mocking style.)

beforeEach(() => vi.clearAllMocks());

describe('MigrationRequiredBanner', () => {
  it('renders when self-hosted + admin + migrationRequiredCount > 0', async () => {
    // arrange all three gates true, stats returns migrationRequiredCount: 3
    render(<MigrationRequiredBanner />);
    expect(await screen.findByText(/migrationBanner\.message/)).toBeInTheDocument();
  });
  it('renders nothing when count is 0', async () => {
    const { container } = render(<MigrationRequiredBanner />); // stats count 0
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
  it('renders nothing when not self-hosted', async () => {
    const { container } = render(<MigrationRequiredBanner />); // features.billing true
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
  it('renders nothing for a non-admin', async () => {
    const { container } = render(<MigrationRequiredBanner />); // admin check false
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
```

(The exact mocking of `fetchWithAuth`/`useDashboardQuery`, `useFeatures`, and the admin check must mirror an existing banner or dashboard-widget test — read `MacOSPermissionsBanner.test.tsx` and a test that mocks `useFeatures`/permissions, and reuse their approach. Adjust the four cases to toggle one gate each.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/web exec vitest run MigrationRequiredBanner`
Expected: FAIL — component undefined.

- [ ] **Step 3: Write the component**

```tsx
// apps/web/src/components/devices/MigrationRequiredBanner.tsx
import '../../lib/i18n';
import { useTranslation } from 'react-i18next';
import { useDashboardQuery } from '../../hooks/useDashboardQuery';
import { useFeatures } from '../../stores/featuresStore';
import type { DeviceStats } from '../dashboard/types';
// import the admin-permission hook/selector used elsewhere (confirm the real one —
// see how Header.tsx gates admin-only menu items).

const MIGRATION_DOCS_URL = 'https://breezermm.com/docs/self-host-agent'; // confirm/adjust

export default function MigrationRequiredBanner() {
  const { t } = useTranslation('common');
  const features = useFeatures();
  // Self-hosted proxy: no billing AND no support (matches Header.tsx gating).
  const isSelfHosted = !features.billing && !features.support;
  const isAdmin = /* the real admin check — confirm against Header.tsx */ true;

  // Poll the same tenant-scoped stats the dashboard uses. Only fetch when it could show.
  const stats = useDashboardQuery<DeviceStats>('/devices/stats', 0, (j: any) => j.data);
  const count = stats?.migrationRequiredCount ?? 0;

  if (!isSelfHosted || !isAdmin || count <= 0) return null;

  return (
    <div
      role="status"
      className="mb-4 flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200"
    >
      <span>{t('migrationBanner.message', { count })}</span>
      <a href={MIGRATION_DOCS_URL} target="_blank" rel="noreferrer" className="shrink-0 font-medium underline">
        {t('migrationBanner.cta')}
      </a>
    </div>
  );
}
```

(Confirm the real admin-permission check and the `useDashboardQuery` signature/`tick` arg against `DashboardPage.tsx`; match the repo's banner Tailwind conventions by reading `MacOSPermissionsBanner.tsx`. No dismiss control — persistence is the point.)

- [ ] **Step 4: Add i18n strings (all 7 locales)**

Add a `migrationBanner` block to each `common.json`. `en`:
```json
"migrationBanner": {
  "message": "{{count}} device(s) are running the hosted agent edition on this self-hosted server. Migrate to the self-host agent edition.",
  "cta": "How to migrate"
}
```
Provide translated `message`/`cta` for `de-DE, es-419, fr-CA, fr-FR (same as fr-CA), it-IT, pt-BR` (short, standard phrasing). Keep the `{{count}}` placeholder in every locale's `message`.

- [ ] **Step 5: Mount site-wide**

In `apps/web/src/layouts/DashboardLayout.astro`, add the import alongside the other island imports and render it as a sibling of `ContextScopeLine`, immediately above `<slot />`:
```astro
import MigrationRequiredBanner from '../components/devices/MigrationRequiredBanner';
...
  <MigrationRequiredBanner client:load />
  <slot />
```

- [ ] **Step 6: Run tests + parity**

Run:
```bash
pnpm --filter @breeze/web exec vitest run MigrationRequiredBanner src/lib/i18n/localeParity.test.ts && pnpm --filter @breeze/web exec tsc --noEmit
```
Expected: PASS (component + parity + typecheck).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/devices/MigrationRequiredBanner.tsx apps/web/src/layouts/DashboardLayout.astro apps/web/src/locales/*/common.json apps/web/src/components/devices/MigrationRequiredBanner.test.tsx
git commit -m "feat(web): persistent agent-migration banner for self-hosted admins"
```

---

## Post-plan verification

- [ ] Manual: as a self-host admin with a device reporting `migration_required=true`, the banner shows on every authenticated page and does not dismiss; setting the count to 0 hides it; a hosted (billing-enabled) instance never shows it; a non-admin never sees it.
- [ ] `pnpm --filter @breeze/api exec vitest run` (API unit) green; the two integration suites (export-policy + drift) green against a live DB.

## Open design decisions (resolved for v1)

- **No hard grace date in the banner v1** — the message links to migration docs rather than embedding a date (a per-instance configurable deadline is a follow-up). The banner's persistence + count is the pressure; the deadline lives in the docs.
- **Self-hosted detection** reuses the existing `!features.billing && !features.support` proxy (there is no `IS_HOSTED` flag in the web bundle today). If a first-class self-hosted flag is later surfaced to `/config`, swap to it.

## Self-Review

- **Spec coverage:** columns + export-policy (T1) ✓; heartbeat accept+self-healing persist (T2) ✓; fleet count on the already-loaded stats endpoint (T3) ✓; persistent non-dismissible admin banner, site-wide, self-hosted+count>0 gated, i18n (T4) ✓.
- **Contract step:** the export-policy classification (the one that fires on a new column) is Task 1 Step 3 with its own contract-test step — the most-missed item, made explicit.
- **Placeholder scan:** code steps carry real code; the three runtime-confirm points (export-policy `included` list shape, `stats.ts` aggregate shape, the admin-permission check) are flagged "read adjacent code and match," not left vague.
- **Type consistency:** `agentEdition`/`migrationRequired` (Drizzle) ↔ `agent_edition`/`migration_required` (SQL) ↔ `agentEdition`/`migrationRequired` (Zod) ↔ `migrationRequiredCount` (`DeviceStats`) used consistently across tasks.
