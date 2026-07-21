# Editable Inbound Email Alias Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let partner admins set an editable inbound email local-part (decoupled from `partners.slug`) so they can fix a misclassified bootstrap inbox address without operator/DB access.

**Architecture:** Add a nullable `partners.inbound_local_part` column. The inbound resolver matches a recipient against the alias **OR** the slug (so the old slug address never stops working). Outbound Reply-To derivation prefers the alias, falling back to slug. Partner admins edit it via `PATCH /orgs/partners/me` with format + cross-tenant-uniqueness guards, surfaced in the existing Inbound email settings card.

**Tech Stack:** TypeScript, Hono (API), Drizzle ORM (postgres.js), hand-written SQL migrations, Vitest, React + `useState` (web).

## Global Constraints

- Spec: `docs/superpowers/specs/ticketing/2026-06-29-inbound-alias-design.md`.
- Column: `inbound_local_part varchar(63)`, **nullable**; `NULL` means "use slug". No backfill.
- Local-part format: `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`, lowercase, max 63.
- Reserved local-parts (rejected): `postmaster`, `abuse`, `noreply`, `no-reply`, `mailer-daemon`, `webmaster`.
- Uniqueness is enforced **at write time** (no DB unique constraint): reject if any *other* partner's `slug` OR `inbound_local_part` equals the candidate → HTTP 409.
- Slug column is never modified by this feature.
- Migrations are hand-written SQL in `apps/api/migrations/`, applied by `pnpm db:migrate`; CI runs `pnpm check:migrations` against an empty Postgres. New files must sort **after** the latest existing migration filename.
- API single-test command (run from `apps/api/`): `pnpm test:run <path>` (optionally `-t "<name>"`).
- Route error convention in `orgs.ts`: `return c.json({ error: '...' }, <status>)` (this file does NOT throw `HTTPException`).

---

### Task 1: Schema column + migration

**Files:**
- Modify: `apps/api/src/db/schema/orgs.ts` (partners table, after `slug` at line 14)
- Create: `apps/api/migrations/2026-07-05-partner-inbound-local-part.sql`

**Interfaces:**
- Produces: `partners.inboundLocalPart` (Drizzle column, `string | null`) and DB column `partners.inbound_local_part varchar(63)`.

- [ ] **Step 1: Add the column to the Drizzle schema**

In `apps/api/src/db/schema/orgs.ts`, inside the `partners` pgTable, immediately after line 14 (`slug: ...`):

```ts
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  inboundLocalPart: varchar('inbound_local_part', { length: 63 }),
```

- [ ] **Step 2: Write the migration**

Create `apps/api/migrations/2026-07-05-partner-inbound-local-part.sql`:

```sql
-- Decouple the partner inbound ticket address from partners.slug.
-- NULL means "use slug" (resolver/outbound fall back). See
-- docs/superpowers/specs/ticketing/2026-06-29-inbound-alias-design.md.
ALTER TABLE partners ADD COLUMN IF NOT EXISTS inbound_local_part varchar(63);
```

- [ ] **Step 3: Apply + verify the migration against a real Postgres**

Run (from `apps/api/`): `pnpm check:migrations`
Expected: PASS — all migrations (including the new file) apply cleanly to an empty database, no checksum/drift errors.

- [ ] **Step 4: Verify schema/migration drift is clean**

Run (from `apps/api/`): `pnpm db:check-drift`
Expected: no drift reported for `partners.inbound_local_part`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema/orgs.ts apps/api/migrations/2026-07-05-partner-inbound-local-part.sql
git commit -m "feat(tickets): add partners.inbound_local_part column + migration"
```

---

### Task 2: Outbound Reply-To derivation prefers the alias

**Files:**
- Modify: `apps/api/src/services/inboundEmail/outboundThreading.ts:43-51`
- Modify: `apps/api/src/jobs/ticketNotifyWorker.ts:171-180, 225-235`
- Modify: `apps/api/src/services/ticketConfigService.ts:358-388`
- Test: `apps/api/src/services/inboundEmail/outboundThreading.test.ts`

**Interfaces:**
- Consumes: `partners.inboundLocalPart` (Task 1).
- Produces: `partnerInboundAddress(localPart: string, configuredOverride: string | undefined): string | null` — first arg is now the resolved local-part (callers pass `inboundLocalPart ?? slug`). `ticketConfigService` inbound object now includes `inboundLocalPart: string | null`.

- [ ] **Step 1: Write the failing test for `partnerInboundAddress`**

Add to `apps/api/src/services/inboundEmail/outboundThreading.test.ts` (mirror the existing describe block for this function; if the file has no env for `domain()`, follow the existing tests' setup in that file):

```ts
it('builds the derived address from the provided local-part', () => {
  // domain() resolves to TICKETS_INBOUND_DOMAIN; existing tests in this file
  // already establish how it is configured — reuse that setup.
  expect(partnerInboundAddress('support', undefined)).toBe('support@tickets.example.com');
});

it('still lets a non-empty override win over the local-part', () => {
  expect(partnerInboundAddress('support', 'tickets@msp.com')).toBe('tickets@msp.com');
});
```

- [ ] **Step 2: Run the test to verify it passes or fails as expected**

Run (from `apps/api/`): `pnpm test:run src/services/inboundEmail/outboundThreading.test.ts`
Expected: the override test PASSES already; the local-part test PASSES (behavior is identical to the old `partnerSlug` arg — this is a rename). If `domain()` isn't configured in the test, FAIL with `null` — match the existing file's env setup so it resolves to `tickets.example.com`.

- [ ] **Step 3: Rename the parameter for clarity (behavior unchanged)**

In `outboundThreading.ts`, update the function signature + doc comment (lines 43-51). Only the parameter name changes; the body already does `${partnerSlug}@${d}`:

```ts
/**
 * The partner's inbound (Reply-To) address. The address is a derived default
 * ({localPart}@TICKETS_INBOUND_DOMAIN, where localPart is the partner's
 * inbound_local_part or, when unset, its slug), OVERRIDABLE for self-hosted via
 * partners.settings.ticketing.inbound.address. The override wins (even with no
 * platform domain configured); a blank/whitespace override is ignored.
 */
export function partnerInboundAddress(
  localPart: string,
  configuredOverride: string | undefined,
): string | null {
  const override = configuredOverride?.trim();
  if (override) return override;
  const d = domain();
  return d ? `${localPart}@${d}` : null;
}
```

- [ ] **Step 4: Update the two callers in `ticketNotifyWorker.ts`**

Caller 1 (lines 171-180) — extend the select and pass the resolved local-part:

```ts
      const partnerRows = await db
        .select({ slug: partners.slug, inboundLocalPart: partners.inboundLocalPart, settings: partners.settings })
        .from(partners)
        .where(eq(partners.id, ticket.partnerId))
        .limit(1);
      const slug = partnerRows[0]?.slug;
      const override = (partnerRows[0]?.settings as
        | { ticketing?: { inbound?: { address?: string } } }
        | undefined)?.ticketing?.inbound?.address;
      if (slug) replyTo = partnerInboundAddress(partnerRows[0]?.inboundLocalPart ?? slug, override) ?? undefined;
```

Caller 2 (lines 225-235) — same shape:

```ts
      const partnerRows = await db
        .select({ slug: partners.slug, name: partners.name, inboundLocalPart: partners.inboundLocalPart, settings: partners.settings })
        .from(partners)
        .where(eq(partners.id, ticket.partnerId))
        .limit(1);
      const slug = partnerRows[0]?.slug;
      // ...existing lines that read `inbound` / autoresponse fields unchanged...
      if (slug) replyTo = partnerInboundAddress(partnerRows[0]?.inboundLocalPart ?? slug, inbound?.address) ?? undefined;
```

- [ ] **Step 5: Update `ticketConfigService.ts` derived address + return object**

In `ticketConfigService.ts`, extend the select (line 359) and the derivation (line 374), and expose `inboundLocalPart` on the returned inbound object (after line 386):

```ts
    const [partner] = await db
      .select({ slug: partners.slug, inboundLocalPart: partners.inboundLocalPart, settings: partners.settings })
      .from(partners)
      .where(eq(partners.id, partnerId))
      .limit(1);

    const slug = partner?.slug ?? '';
    const inboundLocalPart = partner?.inboundLocalPart ?? null;
    // ...settings/inboundCfg/domain/domainConfigured unchanged...
    const effectiveLocalPart = inboundLocalPart ?? slug;
    const derived = domainConfigured && effectiveLocalPart ? `${effectiveLocalPart}@${domain}` : '';
```

And in the returned `inbound` object, add the field next to `slug` (line 386):

```ts
      slug,
      inboundLocalPart,
      domainConfigured,
```

- [ ] **Step 6: Run the outbound tests + typecheck**

Run (from `apps/api/`): `pnpm test:run src/services/inboundEmail/outboundThreading.test.ts`
Expected: PASS.
Run (from `apps/api/`): `pnpm build` (or the repo's typecheck script)
Expected: no type errors in `ticketNotifyWorker.ts` / `ticketConfigService.ts`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/inboundEmail/outboundThreading.ts apps/api/src/jobs/ticketNotifyWorker.ts apps/api/src/services/ticketConfigService.ts apps/api/src/services/inboundEmail/outboundThreading.test.ts
git commit -m "feat(tickets): outbound Reply-To prefers inbound_local_part, falls back to slug"
```

---

### Task 3: Inbound resolver matches alias OR slug

**Files:**
- Modify: `apps/api/src/services/inboundEmail/resolvePartner.ts:1, 21`
- Test: `apps/api/src/services/inboundEmail/resolvePartner.test.ts:16-19` (schema mock) + new case

**Interfaces:**
- Consumes: `partners.inboundLocalPart` (Task 1).
- Produces: `resolvePartnerByRecipient` now resolves a recipient whose local-part equals either `inbound_local_part` or `slug`.

- [ ] **Step 1: Update the failing test (schema mock + new assertion)**

In `resolvePartner.test.ts`, add `inboundLocalPart` to the partners schema mock (line 18) so the new `or(...)` clause references a defined column placeholder:

```ts
  partners: { __t: 'partners', slug: 'slug', inboundLocalPart: 'inboundLocalPart', id: 'id' }
```

Add a case after the existing slug test (this suite is fully mocked — the db mock returns injected `partnerRows` for any partners query, so this documents the alias/slug contract; true OR-isolation is covered by the manual verification step in Task 6):

```ts
  it('resolves the partner for an alias address on the platform domain', async () => {
    dbMocks.partnerRows = [{ id: 'p-2' }];
    expect(await resolvePartnerByRecipient('support@tickets.example.com')).toBe('p-2');
  });

  it('returns null when no partner matches the local-part', async () => {
    dbMocks.partnerRows = [];
    expect(await resolvePartnerByRecipient('nobody@tickets.example.com')).toBeNull();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `apps/api/`): `pnpm test:run src/services/inboundEmail/resolvePartner.test.ts`
Expected: FAIL — `resolvePartner.ts` does not yet import `or`, so referencing `partners.inboundLocalPart` in the query will error (or the new behavior isn't wired). Confirm the failure is in the resolver, not the mock.

- [ ] **Step 3: Implement the OR match**

In `resolvePartner.ts`, line 1, add `or` to the import:

```ts
import { eq, or } from 'drizzle-orm';
```

Replace line 21 (the partners lookup) so it matches alias OR slug:

```ts
    const p = await db.select({ id: partners.id }).from(partners)
      .where(or(eq(partners.inboundLocalPart, local), eq(partners.slug, local))).limit(1);
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `apps/api/`): `pnpm test:run src/services/inboundEmail/resolvePartner.test.ts`
Expected: PASS (all cases, including the pre-existing slug test).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/inboundEmail/resolvePartner.ts apps/api/src/services/inboundEmail/resolvePartner.test.ts
git commit -m "feat(tickets): inbound resolver matches inbound_local_part OR slug"
```

---

### Task 4: `PATCH /orgs/partners/me` accepts inboundLocalPart (validated + unique)

**Files:**
- Modify: `apps/api/src/routes/orgs.ts` (imports; `updatePartnerSettingsSchema` line 460-464; handler write ~line 585-591)
- Test: `apps/api/src/routes/orgs.test.ts`

**Interfaces:**
- Consumes: `partners.inboundLocalPart` (Task 1); route error convention `c.json({ error }, status)`.
- Produces: `PATCH /orgs/partners/me` accepts `{ inboundLocalPart: string | null }` — valid value persists; bad format → 422 (zValidator); reserved word → 422; collision with another partner's slug/alias → 409; `null` clears it.

- [ ] **Step 1: Write failing route tests**

Add to `apps/api/src/routes/orgs.test.ts` (mirror the file's existing pattern for mounting `orgRoutes` and injecting partner auth). Use a per-test `db.select` override to simulate a collision:

```ts
import { db } from '../db'; // already mocked in this file

it('persists a valid inboundLocalPart', async () => {
  // default db.select mock returns [] (no collision); update().set().where().returning() returns the partner
  vi.mocked(db.update).mockReturnValueOnce({ set: () => ({ where: () => ({ returning: () =>
    Promise.resolve([{ id: 'self', inboundLocalPart: 'support' }]) }) }) } as any);
  const res = await callPatchPartnersMe({ inboundLocalPart: 'support' }); // helper used by sibling tests
  expect(res.status).toBe(200);
});

it('rejects an invalid format with 422', async () => {
  const res = await callPatchPartnersMe({ inboundLocalPart: 'Bad Address!' });
  expect(res.status).toBe(422); // zValidator rejects before handler
});

it('rejects a reserved local-part with 422', async () => {
  const res = await callPatchPartnersMe({ inboundLocalPart: 'postmaster' });
  expect(res.status).toBe(422);
});

it('rejects a collision with another partner with 409', async () => {
  vi.mocked(db.select).mockReturnValueOnce({ from: () => ({ where: () => ({ limit: () =>
    Promise.resolve([{ id: 'other-partner' }]) }) }) } as any);
  const res = await callPatchPartnersMe({ inboundLocalPart: 'taken' });
  expect(res.status).toBe(409);
});

it('clears the alias when null is sent', async () => {
  vi.mocked(db.update).mockReturnValueOnce({ set: () => ({ where: () => ({ returning: () =>
    Promise.resolve([{ id: 'self', inboundLocalPart: null }]) }) }) } as any);
  const res = await callPatchPartnersMe({ inboundLocalPart: null });
  expect(res.status).toBe(200);
});
```

> If `orgs.test.ts` has no shared `callPatchPartnersMe` helper, build the request the same way the existing `/partners/me` tests do (construct the Hono app, set auth context, `app.request('/partners/me', { method: 'PATCH', body: JSON.stringify(...) })`). Reuse that file's existing harness — do not invent a new one.

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `apps/api/`): `pnpm test:run src/routes/orgs.test.ts -t inboundLocalPart`
Expected: FAIL — schema/handler don't accept the field yet (valid case 200 path missing field write; format/reserved/collision not enforced).

- [ ] **Step 3: Add the field to the validation schema**

In `orgs.ts`, extend `updatePartnerSettingsSchema` (lines 460-464):

```ts
const updatePartnerSettingsSchema = z.object({
  settings: partnerSettingsSchema.optional(),
  name: z.string().min(1).optional(),
  billingEmail: z.string().email().optional(),
  inboundLocalPart: z
    .string()
    .max(63)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Use lowercase letters, numbers, and hyphens only')
    .nullable()
    .optional()
});
```

- [ ] **Step 4: Add imports + reserved set near the top of `orgs.ts`**

Ensure the drizzle import line includes `or` and `ne` (it already imports `and`, `eq`, `isNull`):

```ts
import { and, eq, isNull, ne, or } from 'drizzle-orm';
```

Add a module-level constant (near the other top-of-file consts):

```ts
const RESERVED_INBOUND_LOCAL_PARTS = new Set([
  'postmaster', 'abuse', 'noreply', 'no-reply', 'mailer-daemon', 'webmaster'
]);
```

- [ ] **Step 5: Enforce reserved + uniqueness and write the column in the handler**

In the `PATCH /orgs/partners/me` handler, BEFORE the `db.update(partners)` call (before line 605), add the guard; and add the write into `updateData` (near lines 590-591):

```ts
    if (body.inboundLocalPart !== undefined) {
      if (body.inboundLocalPart === null) {
        updateData.inboundLocalPart = null;
      } else {
        const candidate = body.inboundLocalPart.toLowerCase();
        if (RESERVED_INBOUND_LOCAL_PARTS.has(candidate)) {
          return c.json({ error: 'That inbound address is reserved' }, 422);
        }
        const clash = await db
          .select({ id: partners.id })
          .from(partners)
          .where(and(
            or(eq(partners.inboundLocalPart, candidate), eq(partners.slug, candidate)),
            ne(partners.id, auth.partnerId as string),
            isNull(partners.deletedAt)
          ))
          .limit(1);
        if (clash[0]) {
          return c.json({ error: 'That inbound address is already taken' }, 409);
        }
        updateData.inboundLocalPart = candidate;
      }
    }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run (from `apps/api/`): `pnpm test:run src/routes/orgs.test.ts -t inboundLocalPart`
Expected: PASS (valid 200, bad-format 422, reserved 422, collision 409, null clears 200).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/orgs.ts apps/api/src/routes/orgs.test.ts
git commit -m "feat(tickets): partner admins can set inbound_local_part via PATCH /orgs/partners/me"
```

---

### Task 5: Editable inbound alias field in the settings card

**Files:**
- Modify: `apps/web/src/components/settings/InboundEmailCard.tsx` (`InboundConfig` interface lines 23-34; load mapping lines 87-97; address render lines 300-324; `saveConfig` lines 142-193)

**Interfaces:**
- Consumes: `/ticket-config` now returns `inbound.inboundLocalPart` (Task 2, Step 5); `PATCH /orgs/partners/me` accepts top-level `{ inboundLocalPart }` (Task 4).
- Produces: an editable local-part input that previews `{value}@{domain}` and saves via the existing `runAction`/`fetchWithAuth` path.

- [ ] **Step 1: Extend the config type + load mapping**

In `InboundEmailCard.tsx`, add to the `InboundConfig` interface (lines 23-34):

```ts
  inboundLocalPart: string | null;
```

In the loader that maps `/ticket-config` → state (lines 87-97), carry the field through:

```ts
  inboundLocalPart: body.data.inbound.inboundLocalPart ?? null,
```

- [ ] **Step 2: Add local draft state + derive the effective local-part**

Near the other `useState` declarations, add:

```ts
  const [localPartDraft, setLocalPartDraft] = useState('');
```

Initialize it whenever `cfg` loads (in the same effect/callback that sets `cfg`):

```ts
  // effective current local-part = explicit alias, else the slug-derived address local-part
  setLocalPartDraft(cfg?.inboundLocalPart ?? (cfg?.address?.split('@')[0] ?? ''));
```

- [ ] **Step 3: Replace the read-only address with an editable field**

Replace the read-only `<input readOnly value={cfg.address} .../>` block (lines 304-309) with an editable local-part input + live domain preview. Keep the Copy button and the unconfigured-domain branch (lines 319-323) intact:

```tsx
            <div className="mt-0.5 flex items-center gap-2">
              <input
                value={localPartDraft}
                onChange={(e) => setLocalPartDraft(e.target.value)}
                className="w-40 rounded-md border px-2.5 py-1.5 text-sm"
                data-testid="inbound-localpart"
                aria-label="Inbound address local part"
              />
              <span className="text-sm text-muted-foreground">@{cfg.address.split('@')[1] ?? ''}</span>
              <button
                type="button"
                onClick={saveLocalPart}
                disabled={saving || localPartDraft === (cfg.inboundLocalPart ?? cfg.address.split('@')[0])}
                className="rounded-md border px-2.5 py-1.5 text-sm"
                data-testid="inbound-localpart-save"
              >
                Save
              </button>
              <button
                type="button"
                onClick={copyAddress}
                className="rounded-md border px-2.5 py-1.5 text-sm"
                data-testid="inbound-address-copy"
              >
                Copy
              </button>
            </div>
```

- [ ] **Step 4: Add the `saveLocalPart` handler (confirm + PATCH top-level field)**

Add near `saveConfig` (this PATCHes the top-level field, NOT `settings.ticketing.inbound`):

```tsx
  const saveLocalPart = useCallback(async () => {
    if (!cfg) return;
    const value = localPartDraft.trim().toLowerCase();
    const current = cfg.inboundLocalPart ?? cfg.address.split('@')[0];
    if (value === current) return;
    const ok = window.confirm(
      'Customers using your current address will still reach you. New replies will be sent from the new address. Change it?'
    );
    if (!ok) return;
    setSaving(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth('/orgs/partners/me', {
            method: 'PATCH',
            body: JSON.stringify({ inboundLocalPart: value }),
          }),
        errorFallback: SAVE_ERROR,
        successMessage: 'Inbound address updated',
        friendly: friendlyCode,
        onUnauthorized: UNAUTHORIZED,
      });
      const domainPart = cfg.address.split('@')[1] ?? '';
      setCfg({ ...cfg, inboundLocalPart: value, address: cfg.addressOverride ?? `${value}@${domainPart}` });
    } catch (err) {
      handleActionError(err, SAVE_ERROR);
    } finally {
      setSaving(false);
    }
  }, [cfg, localPartDraft]);
```

> Note: a 409 (taken) or 422 (bad format/reserved) from the API surfaces through `runAction`'s `errorFallback`/`friendly` handling exactly like the existing save path — no extra wiring needed.

- [ ] **Step 5: Typecheck + run the web build**

Run (from `apps/web/`): `pnpm build` (or the repo's web typecheck/lint script)
Expected: no type errors; `InboundConfig.inboundLocalPart` and `saveLocalPart` resolve.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/settings/InboundEmailCard.tsx
git commit -m "feat(web): editable inbound address local-part in ticketing settings"
```

---

### Task 6: End-to-end manual verification + docs note

**Files:**
- Modify: `docs/` ticketing inbound email doc (whichever file documents `TICKETS_INBOUND_DOMAIN` / inbound setup — locate with `git grep -l TICKETS_INBOUND_DOMAIN docs`)

**Interfaces:**
- Consumes: all prior tasks.

- [ ] **Step 1: Run the full API + web test suites**

Run (from `apps/api/`): `pnpm test:run`
Run (from `apps/web/`): `pnpm test:run` (if present)
Expected: green. No regressions in ticketing/inbound/outbound/orgs suites.

- [ ] **Step 2: Manual resolver round-trip (covers the OR logic a real DB)**

With a local stack + `TICKETS_INBOUND_DOMAIN=tickets.localhost` set:
1. Pick a partner; set its alias via the UI (Settings → Ticketing → Inbound email) to `support`.
2. Confirm the previewed address is `support@tickets.localhost`.
3. Send (or simulate) an inbound email to `support@tickets.localhost` → ticket is created for that partner.
4. Send one to the OLD `{slug}@tickets.localhost` → still creates a ticket for the same partner (slug fallback).
5. Trigger an outbound reply/autoresponse → Reply-To/From is `support@tickets.localhost`.
6. Try setting the alias to another partner's slug/alias → UI shows the 409 "already taken" error.

- [ ] **Step 3: Document the editable alias**

In the located inbound-email doc, add a short note: the inbound address local-part is editable by partner admins (Settings → Ticketing → Inbound email); changing it keeps the previous slug address working; it must be globally unique and lowercase/url-safe.

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs(tickets): document editable inbound address local-part"
```

---

## Self-Review

**Spec coverage:**
- Data model (nullable column, no backfill) → Task 1. ✓
- Resolver matches alias OR slug → Task 3. ✓
- Outbound prefers alias, falls back to slug → Task 2. ✓
- API `PATCH /orgs/partners/me` + format + reserved + uniqueness 409 + clear-to-null → Task 4. ✓
- UI editable field with preview + confirm → Task 5. ✓
- Testing (resolver, outbound, route, migration) → Tasks 1-4 + Task 6 manual. ✓
- Rollout (ships dark, NULL = slug) → Task 1 (nullable, no backfill) + verified in Task 6. ✓

**Deviations from spec (flag to user):**
- Spec mentioned an optional non-unique index on `inbound_local_part`. Omitted: `partners` is a small table (per-instance MSP count), the resolver does a single bounded lookup, and skipping it avoids schema/migration drift-check complexity. Easy to add later if needed.

**Type consistency:**
- `partners.inboundLocalPart` (`string | null`) used identically in Tasks 2-4. ✓
- `partnerInboundAddress(localPart, override)` signature defined in Task 2, consumed by Task 2 callers only. ✓
- `ticketConfigService` inbound object adds `inboundLocalPart`; consumed by Task 5 loader. ✓
- Route returns `c.json({ error }, 409|422|200)` consistent with file convention. ✓

**Placeholder scan:** No TBD/TODO; every code step shows concrete code. The two soft references ("reuse the file's existing harness" in Tasks 4/5) point at concrete existing patterns rather than leaving logic unwritten.
