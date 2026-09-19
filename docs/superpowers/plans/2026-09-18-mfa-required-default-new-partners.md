---
tracking_issue: LanternOps/breeze#6305
---

# Require MFA by Default for New Partners — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every partner created from now on starts with `settings.security.requireMfa = true`; existing partners are untouched; partner policy-managers of partners still off see a per-day-dismissible banner until they turn it on.

**Architecture:** The default is applied at partner creation inside the one shared helper every insert site already calls (`applyNewPartnerDefaultSettings`), never at read time. The dev seed opts out explicitly so local stacks and e2e keep password-only admins. A new React island `MfaPolicyOffBanner` mounts in the dashboard layout, reads `GET /orgs/partners/me`, and mirrors `MfaEnrollmentGraceBanner`'s per-day localStorage dismissal.

**Tech Stack:** Hono + Drizzle (apps/api), Vitest (unit, `vi.mock` Drizzle chains), Vitest integration on real Postgres (`vitest.integration.config.ts`, needs `pnpm test-stack up`), Astro + React islands + react-i18next (apps/web), Vitest + jsdom + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-09-18-mfa-required-default-new-partners-design.md`

## Global Constraints

- `services/partnerDefaultSettings.ts` stays import-free (no db, schema, config imports) — spec D1/F4.
- `services/mfaPolicy.ts` and `mfaPolicy.test.ts` are NOT modified — spec non-goal (read-time semantics unchanged).
- `__tests__/integration/db-utils.ts` `createPartner()` is NOT modified — spec D3.
- The dev seed's Default Partner keeps `security.requireMfa: false` — spec D2.
- Banner dismissal key: `breeze.mfaPolicyOffBannerDismissedOn`, local `YYYY-MM-DD`, comes back next day — spec D4.
- Banner test id: `mfa-policy-off-banner`; i18n block `mfaPolicyOffBanner.*` in the `common` namespace — spec D4.
- Every new i18n key needs a REAL translation in all seven non-English locales (`de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR`); copying English fails `apps/web/src/lib/i18n/translationCoverage.test.ts`.
- Run single test files as `cd apps/api && npx vitest run <path>` / `cd apps/web && npx vitest run <path>` — never `pnpm --filter … test -- --run`.
- Commit after every task; do not push; do not open a PR from inside a task.

---

### Task 1: Default `security.requireMfa = true` in the shared helper

**Files:**
- Modify: `apps/api/src/services/partnerDefaultSettings.ts:46-59`
- Test: `apps/api/src/services/partnerDefaultSettings.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `applyNewPartnerDefaultSettings(settings?: unknown): Record<string, unknown>` now returns `{ ticketing: { inbound: { enabled: false } }, security: { requireMfa: true } }` for empty input. Every existing exact-equality expectation on this helper's output (Tasks 3 and the existing tests below) must include the `security` branch.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('applyNewPartnerDefaultSettings (#3608 / #4520)', …)` block in `apps/api/src/services/partnerDefaultSettings.test.ts`, before its closing `});`:

```ts
  // Spec: docs/superpowers/specs/2026-09-18-mfa-required-default-new-partners-design.md (D1)
  describe('security.requireMfa default (new partners require MFA)', () => {
    it('fills security.requireMfa=true when the caller sends no security branch', () => {
      expect(applyNewPartnerDefaultSettings()).toEqual({
        ticketing: { inbound: { enabled: false } },
        security: { requireMfa: true },
      });
    });

    it('preserves an explicit requireMfa=false (dev seed / customer opt-out)', () => {
      expect(applyNewPartnerDefaultSettings({ security: { requireMfa: false } })).toEqual({
        ticketing: { inbound: { enabled: false } },
        security: { requireMfa: false },
      });
    });

    it('preserves an explicit requireMfa=true', () => {
      expect(applyNewPartnerDefaultSettings({ security: { requireMfa: true } })).toEqual({
        ticketing: { inbound: { enabled: false } },
        security: { requireMfa: true },
      });
    });

    it('preserves unrelated security keys while filling the default', () => {
      expect(
        applyNewPartnerDefaultSettings({
          security: { ipAllowlist: ['10.0.0.0/8'], allowedMethods: { sms: false } },
        }),
      ).toEqual({
        ticketing: { inbound: { enabled: false } },
        security: { ipAllowlist: ['10.0.0.0/8'], allowedMethods: { sms: false }, requireMfa: true },
      });
    });

    it('replaces a non-object security branch rather than preserving garbage', () => {
      expect(applyNewPartnerDefaultSettings({ security: 'nonsense' })).toEqual({
        ticketing: { inbound: { enabled: false } },
        security: { requireMfa: true },
      });
      expect(applyNewPartnerDefaultSettings({ security: null })).toEqual({
        ticketing: { inbound: { enabled: false } },
        security: { requireMfa: true },
      });
    });

    it('does not mutate the caller-supplied security object', () => {
      const input = { security: { ipAllowlist: ['10.0.0.0/8'] } };
      const snapshot = structuredClone(input);
      const out = applyNewPartnerDefaultSettings(input);
      expect(input).toEqual(snapshot);
      expect(out.security).not.toBe(input.security);
    });
  });
```

- [ ] **Step 2: Update the existing exact-equality expectations in the same file**

Every existing `toEqual({ ticketing: … })` in this file must gain `security: { requireMfa: true }` (the helper now always emits it). Edit these assertions:

- "produces the inbound opt-out default when no settings are supplied" → `{ ticketing: { inbound: { enabled: false } }, security: { requireMfa: true } }`
- "treats null settings as absent" → same object.
- "preserves unrelated caller-supplied settings" → `security: { ipAllowlist: ['10.0.0.0/8'], requireMfa: true }, branding: { color: 'blue' }, ticketing: { inbound: { enabled: false } }`
- "preserves sibling keys under ticketing and ticketing.inbound" → add `security: { requireMfa: true }` at top level.
- "does not override an explicit enabled:true from the caller" → `{ ticketing: { inbound: { enabled: true } }, security: { requireMfa: true } }`
- "does not override an explicit enabled:false from the caller" → `{ ticketing: { inbound: { enabled: false } }, security: { requireMfa: true } }`
- "replaces a non-object ticketing branch …" → all three expectations gain `security: { requireMfa: true }`.
- "normalizes a non-object settings value …" → both expectations gain `security: { requireMfa: true }`.

- [ ] **Step 3: Run the file to verify the new tests fail**

Run: `cd apps/api && npx vitest run src/services/partnerDefaultSettings.test.ts`
Expected: FAIL — every assertion expecting `security: { requireMfa: true }` reports the object lacks `security`.

- [ ] **Step 4: Implement the default**

Replace the function body in `apps/api/src/services/partnerDefaultSettings.ts` (keep the file header; add the paragraph below to the function's doc comment):

```ts
/**
 * Merge the new-partner defaults into caller-supplied settings.
 *
 * Caller intent wins: an explicit `ticketing.inbound.enabled` (true or false)
 * is preserved, and every unrelated key is carried through untouched. The
 * default is only filled in where the caller left the flag absent.
 *
 * Values that cannot hold the flag are normalized rather than preserved. The
 * readers traverse `settings.ticketing.inbound.enabled` and treat anything
 * untraversable as absent — i.e. enabled — so preserving a non-object at any
 * level along that path would fail OPEN, which is exactly what #3608 set out to
 * stop. Nothing usable is lost: no reader can interpret those shapes anyway,
 * and the admin route echoes the persisted `settings` back in its 201 response,
 * so a caller who sent a malformed value sees what actually landed.
 *
 * 2026-09-18 (Strix scan follow-up, spec
 * docs/superpowers/specs/2026-09-18-mfa-required-default-new-partners-design.md):
 * new partners also default to `security.requireMfa = true`. Same rules —
 * caller intent wins (an explicit `false` is how the dev seed and a
 * platform-admin opt-out are expressed), unrelated `security.*` keys are
 * preserved, a non-object `security` branch is replaced. Applied ONLY here, at
 * creation: `services/mfaPolicy.ts` still reads an absent key as "not
 * required", so existing partners are untouched on upgrade. Deliberately not
 * hosted-conditional — this module stays import-free.
 *
 * Returns a fresh object; the caller's input is never mutated.
 */
export function applyNewPartnerDefaultSettings(settings?: unknown): Record<string, unknown> {
  const base = isPlainObject(settings) ? { ...settings } : {};
  const ticketing = isPlainObject(base.ticketing) ? { ...base.ticketing } : {};
  const inbound = isPlainObject(ticketing.inbound) ? { ...ticketing.inbound } : {};
  const security = isPlainObject(base.security) ? { ...base.security } : {};

  if (inbound.enabled === undefined) {
    inbound.enabled = false;
  }
  if (security.requireMfa === undefined) {
    security.requireMfa = true;
  }

  ticketing.inbound = inbound;
  base.ticketing = ticketing;
  base.security = security;
  return base;
}
```

- [ ] **Step 5: Run the file to verify it passes**

Run: `cd apps/api && npx vitest run src/services/partnerDefaultSettings.test.ts`
Expected: PASS, all tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/partnerDefaultSettings.ts apps/api/src/services/partnerDefaultSettings.test.ts
git commit -m "feat(auth): new partners default to security.requireMfa=true at creation"
```

---

### Task 2: Dev seed opts out explicitly, with a guard test

**Files:**
- Modify: `apps/api/src/db/seed.ts:1259-1268`
- Test: `apps/api/src/db/seed.test.ts`

**Interfaces:**
- Consumes: `applyNewPartnerDefaultSettings` from Task 1.
- Produces: exported constant `DEV_SEED_DEFAULT_PARTNER_SETTINGS: Record<string, unknown>` from `apps/api/src/db/seed.ts`, used by the seed insert and pinned by the test.

- [ ] **Step 1: Write the failing test**

Change the import line at the top of `apps/api/src/db/seed.test.ts` to:

```ts
import { resolveBootstrapAdminConfig, DEFAULT_PERMISSIONS, SYSTEM_ROLES, DEV_SEED_DEFAULT_PARTNER_SETTINGS } from './seed';
```

Append at the end of the file:

```ts
// Spec D2: docs/superpowers/specs/2026-09-18-mfa-required-default-new-partners-design.md
// New partners default to security.requireMfa=true. The seeded dev/e2e partner
// must OPT OUT: seeded admins log in without a factor, and a forced-enrolment
// wall on every fresh stack is the 2026-09-08 R1 lockout replayed locally.
// This test exists so a future "cleanup" to plain applyNewPartnerDefaultSettings()
// fails here instead of locking every developer out.
describe('dev seed Default Partner settings', () => {
  it('keeps requireMfa=false while still carrying the other new-partner defaults', () => {
    expect(DEV_SEED_DEFAULT_PARTNER_SETTINGS).toEqual({
      ticketing: { inbound: { enabled: false } },
      security: { requireMfa: false },
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/db/seed.test.ts`
Expected: FAIL — `DEV_SEED_DEFAULT_PARTNER_SETTINGS` is undefined (export missing).

- [ ] **Step 3: Export the constant and use it in the seed**

In `apps/api/src/db/seed.ts`, directly after the imports (near line 6 where `applyNewPartnerDefaultSettings` is imported), add:

```ts
/**
 * Settings for the seeded dev/e2e "Default Partner". New partners default to
 * `security.requireMfa = true` (spec
 * docs/superpowers/specs/2026-09-18-mfa-required-default-new-partners-design.md
 * D2), but seeded admins sign in without a factor and e2e pins
 * MFA_FORCE_FOR_PARTNER_ADMIN=false, so the seeded partner opts OUT explicitly.
 * Pinned by db/seed.test.ts — do not "simplify" this back to the bare helper.
 */
export const DEV_SEED_DEFAULT_PARTNER_SETTINGS: Record<string, unknown> =
  applyNewPartnerDefaultSettings({ security: { requireMfa: false } });
```

Then replace the insert's settings line (currently `settings: applyNewPartnerDefaultSettings()` with the `#4520` comment above it) with:

```ts
          // #4520: keep the seeded dev partner on the same inbound opt-out
          // default real partners get, so local behaviour matches production.
          // Spec 2026-09-18 D2: but NOT the requireMfa default — see the
          // constant's doc comment.
          settings: DEV_SEED_DEFAULT_PARTNER_SETTINGS
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/db/seed.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the e2e README note**

In `e2e-tests/README.md`, after the paragraph that ends "The stack must pin it explicitly." (around line 158), add:

```markdown
Separately, new partners now default to the *settings-level* **Require MFA**
(`security.requireMfa = true`, since 2026-09-18). That axis ignores
`MFA_FORCE_FOR_PARTNER_ADMIN`. The seeded Default Partner opts out of it
explicitly in `apps/api/src/db/seed.ts` (`DEV_SEED_DEFAULT_PARTNER_SETTINGS`),
which is why seeded admins can still log in password-only. A partner created
through the UI during a run gets the default and its users must enrol.
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/seed.ts apps/api/src/db/seed.test.ts e2e-tests/README.md
git commit -m "chore(seed): dev Default Partner opts out of the new requireMfa default (guarded)"
```

---

### Task 3: `POST /orgs/partners` route tests reflect the default

**Files:**
- Test: `apps/api/src/routes/orgs.test.ts:628-716`

**Interfaces:**
- Consumes: Task 1's helper output shape.
- Produces: nothing new; the route at `apps/api/src/routes/orgs.ts:513` already calls the helper, so this task is test-only plus one new case for explicit opt-out.

- [ ] **Step 1: Run the existing route tests to see which now fail**

Run: `cd apps/api && npx vitest run src/routes/orgs.test.ts -t "POST /orgs/partners"`
Expected: FAIL on the five settings assertions in the `captureInsertedValues` block (each `toEqual` lacks `security.requireMfa`).

- [ ] **Step 2: Update the five expectations and add two cases**

In `apps/api/src/routes/orgs.test.ts`, inside the block that defines `captureInsertedValues` (starting near line 600):

- "writes settings.ticketing.inbound.enabled=false when the caller sends no settings": change the assertion to
  ```ts
  expect(captured[0]?.settings).toEqual({
    ticketing: { inbound: { enabled: false } },
    security: { requireMfa: true }
  });
  ```
- "adds the default alongside caller-supplied settings without clobbering them": change to
  ```ts
  expect(captured[0]?.settings).toEqual({
    security: { ipAllowlist: ['10.0.0.0/8'], requireMfa: true },
    ticketing: { inbound: { unknownSenderMode: 'triage', enabled: false } }
  });
  ```
- "respects an explicit ticketing.inbound.enabled=true from the caller": change to
  ```ts
  expect(captured[0]?.settings).toEqual({
    ticketing: { inbound: { enabled: true } },
    security: { requireMfa: true }
  });
  ```
- "still folds the legacy allowedMfaMethods alias while applying the default": change to
  ```ts
  expect(captured[0]?.settings).toEqual({
    security: { allowedMethods: { totp: true }, requireMfa: true },
    ticketing: { inbound: { enabled: false } }
  });
  ```
- "normalizes a non-object settings value and echoes the result in the 201 body": change both assertions to
  ```ts
  expect(captured[0]?.settings).toEqual({
    ticketing: { inbound: { enabled: false } },
    security: { requireMfa: true }
  });
  expect(await res.json()).toMatchObject({
    settings: { ticketing: { inbound: { enabled: false } }, security: { requireMfa: true } }
  });
  ```

Then add, after the "normalizes a non-object settings value" case and inside the same `describe`:

```ts
      // Spec D1: a platform admin creating a partner for a customer that has
      // opted out passes requireMfa:false explicitly and it must win.
      it('preserves an explicit security.requireMfa=false from the caller', async () => {
        const captured = captureInsertedValues();

        const res = await app.request('/orgs/partners', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Partner',
            slug: 'partner',
            settings: { security: { requireMfa: false } }
          })
        });

        expect(res.status).toBe(201);
        expect(captured[0]?.settings).toEqual({
          security: { requireMfa: false },
          ticketing: { inbound: { enabled: false } }
        });
      });

      it('echoes security.requireMfa=true in the 201 body when the caller omitted it', async () => {
        captureInsertedValues();

        const res = await app.request('/orgs/partners', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Partner', slug: 'partner' })
        });

        expect(res.status).toBe(201);
        expect(await res.json()).toMatchObject({ settings: { security: { requireMfa: true } } });
      });
```

- [ ] **Step 3: Run the route tests to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/orgs.test.ts -t "POST /orgs/partners"`
Expected: PASS. Then run the whole file once: `cd apps/api && npx vitest run src/routes/orgs.test.ts` — Expected: PASS.

- [ ] **Step 4: Sweep other unit suites that pin the helper's exact output**

Run: `cd apps/api && grep -rln "inbound: { enabled: false } }" src --include='*.test.ts'`
For every file listed other than the two already handled (`partnerDefaultSettings.test.ts`, `orgs.test.ts`), open it and, where the assertion is an exact `toEqual` on a partner `settings` object produced by `applyNewPartnerDefaultSettings` or the create-partner service, add `security: { requireMfa: true }`. Expected candidates: `src/services/partnerCreate.test.ts` (if present) and `src/routes/auth/verifyEmail.test.ts`. Then run each edited file: `cd apps/api && npx vitest run <path>` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/orgs.test.ts $(git diff --name-only -- apps/api/src)
git commit -m "test(api): partner creation tests carry the requireMfa default"
```

---

### Task 4: Registration integration test asserts the real row (trigger scaffolding inverted)

**Files:**
- Modify: `apps/api/src/__tests__/integration/registerPartnerMfaPolicy.integration.test.ts:18-33, 84-88, 234-268`

**Interfaces:**
- Consumes: real `createPartner()` (`services/partnerCreate.ts:98`) now writing `security.requireMfa: true`.
- Produces: nothing; test-only.

Background: today the "settings axis" case installs a `BEFORE INSERT` trigger that injects `requireMfa:true` because the real row never carried it; and the "kill switch off" control proves the role-axis assertions depend on the stored flag by producing a state where *nothing* requires MFA. After Task 1 the real row requires MFA, so (a) the settings-axis case must assert the real row with no trigger, and (b) the control must use the trigger the other way round — inject `requireMfa:false` — to reach "nothing requires MFA" again.

- [ ] **Step 1: Bring up a database and run the file to see the control fail**

Run (from repo root): `pnpm test-stack up` then
`set -a && . ./.env.test && set +a && cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/registerPartnerMfaPolicy.integration.test.ts`
Expected: FAIL on "still mints mfa=true with the kill switch off" (`accessClaims.mfa` is now `false` because the real partner row requires MFA). The settings-axis case still passes (its trigger is now redundant).

- [ ] **Step 2: Rewrite the two cases and the header**

Replace the header lines 22-28 (the "Constructing the required-policy condition" paragraph) with:

```ts
 * Constructing the required-policy condition:
 *   Role axis — `createPartner()` stores force_mfa = true on the tenant
 *   Partner Admin row itself (RMM-QA-164): exercised on the REAL row.
 *   Settings axis — since 2026-09-18 `createPartner()` also writes
 *   `security.requireMfa = true` (applyNewPartnerDefaultSettings, spec
 *   docs/superpowers/specs/2026-09-18-mfa-required-default-new-partners-design.md):
 *   ALSO exercised on the real row, no trigger.
 *   The kill-switch control below is the only case that still needs a
 *   BEFORE INSERT trigger — it must produce a tenant where NOTHING requires
 *   MFA, which the real creation path can no longer mint, so it injects
 *   `requireMfa:false` and turns the role force off.
```

Rename the trigger in `dropTriggers()` and both call sites to `breeze_test_partner_no_require_mfa`:

```ts
async function dropTriggers(): Promise<void> {
  const db = getTestDb();
  await db.execute(sql.raw('DROP TRIGGER IF EXISTS breeze_test_partner_no_require_mfa ON partners'));
}
```

Replace the case `it('does NOT mint mfa=true when the new partner settings require MFA (settings axis)', …)` with:

```ts
  it('stores security.requireMfa=true on the real createPartner row and does NOT mint mfa=true (settings axis, no trigger — spec 2026-09-18 D1)', async () => {
    const { status, body, accessClaims } = await parkAndVerify('RequireMfaCo');
    expect(status).toBe(200);

    const db = getTestDb();
    const rows = await db.execute(sql`
      SELECT settings -> 'security' ->> 'requireMfa' AS require_mfa,
             settings -> 'ticketing' -> 'inbound' ->> 'enabled' AS inbound_enabled
      FROM partners WHERE id = ${body.partner.id}
    `);
    expect(rows[0]?.require_mfa).toBe('true');
    // The other new-partner default still lands alongside it.
    expect(rows[0]?.inbound_enabled).toBe('false');

    expect(accessClaims.mfa).toBe(false);
    expect(body.mfaEnrollmentRequired).toBe(true);
  });
```

Replace the control case `it('still mints mfa=true with the kill switch off (control — …)', …)` with:

```ts
  it('still mints mfa=true when NOTHING requires MFA (control — settings opted out by trigger + kill switch off)', async () => {
    // Since 2026-09-18 the real creation path writes requireMfa=true, so a
    // tenant where nothing requires MFA cannot be produced by createPartner
    // alone. Invert the trigger: strip the settings axis, and turn the role
    // axis off through the documented relief valve (mfaForcePartnerAdmin()
    // reads the env at call time, so no re-import is needed). If this control
    // ever mints mfa=false, the assertions above have stopped depending on the
    // stored flags and are vacuous.
    await installTrigger(
      'breeze_test_partner_no_require_mfa',
      `NEW.settings := COALESCE(NEW.settings, '{}'::jsonb) || '{"security":{"requireMfa":false}}'::jsonb;`,
    );
    await attachTrigger('breeze_test_partner_no_require_mfa', 'partners');

    const previous = process.env.MFA_FORCE_FOR_PARTNER_ADMIN;
    process.env.MFA_FORCE_FOR_PARTNER_ADMIN = 'false';
    try {
      const { status, accessClaims, body } = await parkAndVerify('KillSwitchCo');
      expect(status).toBe(200);
      const rows = await getTestDb().execute(sql`
        SELECT settings -> 'security' ->> 'requireMfa' AS require_mfa
        FROM partners WHERE id = ${body.partner.id}
      `);
      expect(rows[0]?.require_mfa).toBe('false');
      expect(accessClaims.mfa).toBe(true);
      expect(body.mfaEnrollmentRequired).toBe(false);
    } finally {
      process.env.MFA_FORCE_FOR_PARTNER_ADMIN = previous;
    }
  });
```

- [ ] **Step 3: Run the file to verify it passes**

Run: `set -a && . ./.env.test && set +a && cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/registerPartnerMfaPolicy.integration.test.ts`
Expected: PASS, all cases.

- [ ] **Step 4: Prove the settings-axis case discriminates**

Temporarily edit `apps/api/src/services/partnerDefaultSettings.ts` to set `security.requireMfa = false` instead of `true`, rerun the command from Step 3 — Expected: the settings-axis case FAILS on `require_mfa` `'false' !== 'true'`. Revert the edit (`git checkout -- apps/api/src/services/partnerDefaultSettings.ts`), rerun — Expected: PASS.

- [ ] **Step 5: Run the adjacent suites that create partners and mint `mfa:false` tokens, to prove fixtures are unaffected**

Run: `set -a && . ./.env.test && set +a && cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/partnerSettingsAuthority.integration.test.ts src/__tests__/integration/portalUserInvite.integration.test.ts src/__tests__/integration/remoteRevocationLease.integration.test.ts`
Expected: PASS (`db-utils.createPartner` writes no settings — spec D3 — so nothing changes for fixtures).

- [ ] **Step 6: Tear down and commit**

```bash
cd /path/to/repo && pnpm test-stack down
git add apps/api/src/__tests__/integration/registerPartnerMfaPolicy.integration.test.ts
git commit -m "test(integration): registration asserts the real requireMfa row; control inverts the trigger"
```

---

### Task 5: `MfaPolicyOffBanner` island — component, tests, i18n, layout mount, settings-saved event

**Files:**
- Create: `apps/web/src/components/auth/MfaPolicyOffBanner.tsx`
- Create: `apps/web/src/components/auth/MfaPolicyOffBanner.test.tsx`
- Modify: `apps/web/src/layouts/DashboardLayout.astro:8, 58-59`
- Modify: `apps/web/src/components/settings/PartnerSettingsPage.tsx:460-465`
- Modify: `apps/web/src/locales/en/common.json` (append block after `mfaEnrollmentGraceBanner`) and the same block, translated, in `apps/web/src/locales/{de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/common.json`

**Interfaces:**
- Consumes: `useAuthStore` (`user`, `user.canManagePartnerWide`), `fetchWithAuth` from `@/stores/auth`; `useJwtClaims()` from `@/lib/authScope` (`{ status: 'unresolved' } | { status: 'resolved', claims: { scope, orgId, partnerId } }`); `GET /orgs/partners/me` returning `{ settings?: { security?: { requireMfa?: boolean } } }`.
- Produces: default export `MfaPolicyOffBanner: () => JSX.Element | null`; exported constant `PARTNER_SETTINGS_SAVED_EVENT = 'breeze:partner-settings-saved'` from the component file (dispatched by `PartnerSettingsPage` after a successful save).

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/auth/MfaPolicyOffBanner.test.tsx`:

```tsx
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MfaPolicyOffBanner, { PARTNER_SETTINGS_SAVED_EVENT } from './MfaPolicyOffBanner';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('@/lib/i18n', () => ({ default: {} }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

type BannerUser = { id: string; canManagePartnerWide?: boolean } | null;
type Scope = 'system' | 'partner' | 'organization' | null;

const state = vi.hoisted(() => ({
  user: null as BannerUser,
  claims: { status: 'resolved', claims: { scope: 'partner' as Scope, orgId: null, partnerId: 'p1' } } as
    | { status: 'unresolved' }
    | { status: 'resolved'; claims: { scope: Scope; orgId: string | null; partnerId: string | null } },
}));

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector?: (s: { user: BannerUser }) => unknown) => {
      const s = { user: state.user };
      return selector ? selector(s) : s;
    },
    { getState: () => ({ user: state.user }) },
  ),
}));

vi.mock('@/lib/authScope', () => ({
  useJwtClaims: () => state.claims,
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const DISMISS_KEY = 'breeze.mfaPolicyOffBannerDismissedOn';
const TEST_ID = 'mfa-policy-off-banner';

const partnerResponse = (requireMfa: boolean | undefined): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => ({
      id: 'p1',
      name: 'Acme MSP',
      settings: requireMfa === undefined ? {} : { security: { requireMfa } },
    }),
  }) as unknown as Response;

function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

beforeEach(() => {
  state.user = { id: 'user-1', canManagePartnerWide: true };
  state.claims = { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p1' } };
  fetchWithAuthMock.mockReset();
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('MfaPolicyOffBanner', () => {
  it('renders for a partner policy-manager whose partner has requireMfa absent', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(partnerResponse(undefined));

    render(<MfaPolicyOffBanner />);

    expect(await screen.findByTestId(TEST_ID)).toBeInTheDocument();
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/orgs/partners/me');
    expect(screen.getByText('mfaPolicyOffBanner.message')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'mfaPolicyOffBanner.cta' })).toHaveAttribute(
      'href',
      '/settings/partner#security',
    );
  });

  it('renders when requireMfa is explicitly false', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(partnerResponse(false));
    render(<MfaPolicyOffBanner />);
    expect(await screen.findByTestId(TEST_ID)).toBeInTheDocument();
  });

  it('renders nothing when requireMfa is true', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(partnerResponse(true));
    render(<MfaPolicyOffBanner />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    expect(screen.queryByTestId(TEST_ID)).not.toBeInTheDocument();
  });

  it('renders nothing (and never fetches) for an organization-scoped session', async () => {
    state.claims = { status: 'resolved', claims: { scope: 'organization', orgId: 'o1', partnerId: 'p1' } };
    render(<MfaPolicyOffBanner />);
    await act(async () => {});
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId(TEST_ID)).not.toBeInTheDocument();
  });

  it('renders nothing (and never fetches) while the scope is still unresolved', async () => {
    state.claims = { status: 'unresolved' };
    render(<MfaPolicyOffBanner />);
    await act(async () => {});
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('renders nothing (and never fetches) for a partner user who cannot manage partner-wide policies', async () => {
    state.user = { id: 'user-1', canManagePartnerWide: false };
    render(<MfaPolicyOffBanner />);
    await act(async () => {});
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId(TEST_ID)).not.toBeInTheDocument();
  });

  it('renders nothing when there is no authenticated user', async () => {
    state.user = null;
    render(<MfaPolicyOffBanner />);
    await act(async () => {});
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('renders nothing when the fetch fails', async () => {
    fetchWithAuthMock.mockResolvedValueOnce({ ok: false, status: 403 } as unknown as Response);
    render(<MfaPolicyOffBanner />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    expect(screen.queryByTestId(TEST_ID)).not.toBeInTheDocument();
  });

  it("dismisses for the day and writes today's date to localStorage", async () => {
    fetchWithAuthMock.mockResolvedValueOnce(partnerResponse(false));
    render(<MfaPolicyOffBanner />);
    await screen.findByTestId(TEST_ID);

    fireEvent.click(screen.getByLabelText('mfaPolicyOffBanner.dismiss'));

    expect(screen.queryByTestId(TEST_ID)).not.toBeInTheDocument();
    expect(window.localStorage.getItem(DISMISS_KEY)).toBe(todayKey());
  });

  it('stays hidden for the rest of the day once dismissed today', async () => {
    window.localStorage.setItem(DISMISS_KEY, todayKey());
    fetchWithAuthMock.mockResolvedValueOnce(partnerResponse(false));
    render(<MfaPolicyOffBanner />);
    await act(async () => {});
    expect(screen.queryByTestId(TEST_ID)).not.toBeInTheDocument();
  });

  it('comes back when the stored dismissal date is stale (yesterday)', async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    window.localStorage.setItem(
      DISMISS_KEY,
      `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`,
    );
    fetchWithAuthMock.mockResolvedValueOnce(partnerResponse(false));
    render(<MfaPolicyOffBanner />);
    expect(await screen.findByTestId(TEST_ID)).toBeInTheDocument();
  });

  it('re-checks and hides after the partner settings page reports a save that turned MFA on', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(partnerResponse(false))
      .mockResolvedValueOnce(partnerResponse(true));
    render(<MfaPolicyOffBanner />);
    await screen.findByTestId(TEST_ID);

    act(() => {
      window.dispatchEvent(new Event(PARTNER_SETTINGS_SAVED_EVENT));
    });

    await waitFor(() => expect(screen.queryByTestId(TEST_ID)).not.toBeInTheDocument());
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/auth/MfaPolicyOffBanner.test.tsx`
Expected: FAIL — cannot resolve `./MfaPolicyOffBanner`.

- [ ] **Step 3: Implement the component**

Create `apps/web/src/components/auth/MfaPolicyOffBanner.tsx`:

```tsx
import '@/lib/i18n';
import { useCallback, useEffect, useState } from 'react';
import { ShieldAlert, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth, useAuthStore } from '@/stores/auth';
import { useJwtClaims } from '@/lib/authScope';

// Spec: docs/superpowers/specs/2026-09-18-mfa-required-default-new-partners-design.md (D4)
//
// New partners default to security.requireMfa = true. Partners created before
// that default get NO change on upgrade (the policy resolver still reads an
// absent key as "not required") — this banner is the nudge for their
// policy-managers. It never blocks anything: the setting is a choice the
// partner is allowed to make, so it is dismissible for the day (same per-day
// localStorage scheme as MfaEnrollmentGraceBanner), not permanently — there is
// no server-side dismissal store, and the point is a standing reminder.
//
// Gates, all client-side UX only (the server is the authority):
//   - partner scope (org-scoped users can't change it and GET /orgs/partners/me 403s them)
//   - canManagePartnerWide (org_access 'selected' members can't PATCH the setting)
//   - GET /orgs/partners/me → settings.security.requireMfa !== true

export const PARTNER_SETTINGS_SAVED_EVENT = 'breeze:partner-settings-saved';

const DISMISS_STORAGE_KEY = 'breeze.mfaPolicyOffBannerDismissedOn';

/** Local YYYY-MM-DD for "today", used as the per-day dismissal key. */
function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function readDismissedOn(): string | null {
  try {
    return window.localStorage.getItem(DISMISS_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeDismissedOn(value: string): void {
  try {
    window.localStorage.setItem(DISMISS_STORAGE_KEY, value);
  } catch {
    // Dismissal just won't persist across reloads — not fatal.
  }
}

type PartnerMe = { settings?: { security?: { requireMfa?: unknown } } };

export default function MfaPolicyOffBanner() {
  const { t } = useTranslation('common');
  const user = useAuthStore((s) => s.user);
  const claimsState = useJwtClaims();
  const [policyOff, setPolicyOff] = useState(false);
  const [dismissedToday, setDismissedToday] = useState(false);

  useEffect(() => {
    setDismissedToday(readDismissedOn() === localDateKey(new Date()));
  }, []);

  // Absent canManagePartnerWide = session persisted before the field existed;
  // treat as capable (the server enforces regardless) — same reading as the
  // owner-scope pickers.
  const canManage = user?.canManagePartnerWide !== false;
  const isPartnerScope = claimsState.status === 'resolved' && claimsState.claims.scope === 'partner';
  const eligible = Boolean(user) && isPartnerScope && canManage;

  const check = useCallback(async (isCurrent: () => boolean) => {
    try {
      const response = await fetchWithAuth('/orgs/partners/me');
      if (!response.ok) {
        // Render nothing. A 403 here is an org-scoped or restricted session
        // the gates above should already have excluded; anything else is a
        // transient failure and the banner is not worth a broken page.
        if (isCurrent()) setPolicyOff(false);
        return;
      }
      const data = (await response.json().catch(() => null)) as PartnerMe | null;
      if (!isCurrent()) return;
      setPolicyOff(data?.settings?.security?.requireMfa !== true);
    } catch {
      if (isCurrent()) setPolicyOff(false);
    }
  }, []);

  useEffect(() => {
    if (!eligible) {
      setPolicyOff(false);
      return;
    }
    let current = true;
    void check(() => current);
    const onSaved = () => {
      void check(() => current);
    };
    window.addEventListener(PARTNER_SETTINGS_SAVED_EVENT, onSaved);
    return () => {
      current = false;
      window.removeEventListener(PARTNER_SETTINGS_SAVED_EVENT, onSaved);
    };
  }, [eligible, check]);

  if (!eligible || dismissedToday || !policyOff) return null;

  const dismiss = () => {
    writeDismissedOn(localDateKey(new Date()));
    setDismissedToday(true);
  };

  return (
    <div
      role="status"
      data-testid="mfa-policy-off-banner"
      className="mb-4 flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3"
    >
      <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">{t('mfaPolicyOffBanner.message')}</p>
        <div className="mt-3">
          <a
            href="/settings/partner#security"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {t('mfaPolicyOffBanner.cta')}
          </a>
        </div>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('mfaPolicyOffBanner.dismiss')}
        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/auth/MfaPolicyOffBanner.test.tsx`
Expected: PASS, 12 tests.

- [ ] **Step 5: Add the i18n block to all eight locales**

In `apps/web/src/locales/en/common.json`, after the `mfaEnrollmentGraceBanner` block (line ~2536), add (keep the file's trailing brace valid — add a comma after the previous block's closing `}`):

```json
  "mfaPolicyOffBanner": {
    "message": "Multi-factor authentication is not required for your team. Password-only sessions can run scripts, move devices and change policies.",
    "cta": "Require MFA",
    "dismiss": "Dismiss the MFA policy reminder for today"
  }
```

Add the same block, in the same position, to each of the seven other `common.json` files with these translations:

`de-DE`:
```json
  "mfaPolicyOffBanner": {
    "message": "Für Ihr Team ist keine Multi-Faktor-Authentifizierung erforderlich. Sitzungen nur mit Passwort können Skripte ausführen, Geräte verschieben und Richtlinien ändern.",
    "cta": "MFA erzwingen",
    "dismiss": "Erinnerung an die MFA-Richtlinie für heute schließen"
  }
```

`es-419`:
```json
  "mfaPolicyOffBanner": {
    "message": "La autenticación multifactor no es obligatoria para su equipo. Las sesiones solo con contraseña pueden ejecutar scripts, mover dispositivos y cambiar políticas.",
    "cta": "Exigir MFA",
    "dismiss": "Descartar el recordatorio de la política de MFA por hoy"
  }
```

`fr-CA`:
```json
  "mfaPolicyOffBanner": {
    "message": "L'authentification multifacteur n'est pas exigée pour votre équipe. Les sessions avec mot de passe seulement peuvent exécuter des scripts, déplacer des appareils et modifier des politiques.",
    "cta": "Exiger l'AMF",
    "dismiss": "Masquer le rappel de politique AMF pour aujourd'hui"
  }
```

`fr-FR`:
```json
  "mfaPolicyOffBanner": {
    "message": "L'authentification multifacteur n'est pas obligatoire pour votre équipe. Les sessions avec mot de passe seul peuvent exécuter des scripts, déplacer des appareils et modifier des politiques.",
    "cta": "Exiger la MFA",
    "dismiss": "Masquer le rappel de politique MFA pour aujourd'hui"
  }
```

`it-IT`:
```json
  "mfaPolicyOffBanner": {
    "message": "L'autenticazione a più fattori non è obbligatoria per il tuo team. Le sessioni con sola password possono eseguire script, spostare dispositivi e modificare i criteri.",
    "cta": "Richiedi MFA",
    "dismiss": "Ignora per oggi il promemoria sui criteri MFA"
  }
```

`pt-BR`:
```json
  "mfaPolicyOffBanner": {
    "message": "A autenticação multifator não é obrigatória para a sua equipe. Sessões apenas com senha podem executar scripts, mover dispositivos e alterar políticas.",
    "cta": "Exigir MFA",
    "dismiss": "Dispensar o lembrete da política de MFA por hoje"
  }
```

`tr-TR`:
```json
  "mfaPolicyOffBanner": {
    "message": "Ekibiniz için çok faktörlü kimlik doğrulama zorunlu değil. Yalnızca parola ile açılan oturumlar betik çalıştırabilir, cihazları taşıyabilir ve ilkeleri değiştirebilir.",
    "cta": "MFA'yı zorunlu kıl",
    "dismiss": "MFA ilkesi hatırlatmasını bugünlük kapat"
  }
```

Run: `cd apps/web && npx vitest run src/lib/i18n`
Expected: PASS (parity + coverage). If a "does not exceed reviewed namespace duplicate baselines" subtest fails, a translation above is identical to English — fix the translation, never bump the baseline.

- [ ] **Step 6: Mount the island in the dashboard layout**

In `apps/web/src/layouts/DashboardLayout.astro`, after line 8 (`import MfaEnrollmentGraceBanner …`) add:

```astro
import MfaPolicyOffBanner from '../components/auth/MfaPolicyOffBanner';
```

and after `<MfaEnrollmentGraceBanner client:load transition:persist />` add:

```astro
        {/* Partner policy-managers whose partner does not require MFA (spec
            2026-09-18 D4). Per-day dismissible; clears itself once the
            setting is saved on. */}
        <MfaPolicyOffBanner client:load transition:persist />
```

- [ ] **Step 7: Dispatch the saved event from the partner settings page**

In `apps/web/src/components/settings/PartnerSettingsPage.tsx` add to the imports:

```ts
import { PARTNER_SETTINGS_SAVED_EVENT } from '../auth/MfaPolicyOffBanner';
```

and in the save handler, directly after `setPartner(updated);` (line ~463), add:

```ts
      // Lets layout islands that read partner settings (MfaPolicyOffBanner)
      // re-check without a page navigation.
      window.dispatchEvent(new Event(PARTNER_SETTINGS_SAVED_EVENT));
```

Run: `cd apps/web && npx vitest run src/components/settings/PartnerSettingsPage`
Expected: PASS (existing tests; the event is fire-and-forget).

- [ ] **Step 8: Typecheck the web app**

Run: `cd apps/web && npx astro check 2>&1 | tail -5`
Expected: 0 errors (warnings pre-existing are fine).

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/auth/MfaPolicyOffBanner.tsx apps/web/src/components/auth/MfaPolicyOffBanner.test.tsx apps/web/src/layouts/DashboardLayout.astro apps/web/src/components/settings/PartnerSettingsPage.tsx apps/web/src/locales/*/common.json
git commit -m "feat(web): MfaPolicyOffBanner nudges partner policy-managers whose partner does not require MFA"
```

---

### Task 6: Docs and changelog

**Files:**
- Modify: `apps/docs/src/content/docs/security/hardening.mdx:49-50`
- Modify: `apps/docs/src/content/docs/features/scripts.mdx:641`
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `### Security`)

**Interfaces:** none.

- [ ] **Step 1: Hardening checklist**

In `apps/docs/src/content/docs/security/hardening.mdx`, in the `### Authentication` list, insert a new bullet directly after the first bullet ("MFA enabled for all admin accounts …"):

```markdown
- [ ] **Require MFA** is on for your partner (Settings → Partner → Security). Partners created after 2026-09-18 have it on by default; partners created earlier keep whatever they had and their policy-managers see a daily reminder banner until it is turned on. When the partner setting is on, it is locked for every organisation under that partner and users without an enrolled factor are routed to enrolment at their next sign-in. To opt a partner out, turn the toggle off — a platform administrator creating a partner via `POST /orgs/partners` can also pass `settings.security.requireMfa: false`.
```

- [ ] **Step 2: Scripts page**

In `apps/docs/src/content/docs/features/scripts.mdx`, at the end of the paragraph under `### MFA enforcement` (the one ending "…users without a factor are then routed to enrollment before they can run scripts."), append one sentence:

```markdown
 **Require MFA** is on by default for partners created after 2026-09-18.
```

- [ ] **Step 3: Changelog**

In `CHANGELOG.md`, under `## [Unreleased]` → `### Security`, add as the first bullet:

```markdown
- New partners now require MFA by default: `settings.security.requireMfa` is set to `true` at partner creation on every creation path (signup, platform-admin `POST /orgs/partners`, dev seed — the seeded Default Partner opts out so local stacks keep password-only admins). Existing partners are not changed; their policy-managers see a daily-dismissible banner until they turn **Require MFA** on. Self-hosters who do not want it turn the toggle off in Settings → Partner → Security. (Strix scan follow-up, spec `docs/superpowers/specs/2026-09-18-mfa-required-default-new-partners-design.md`.)
```

- [ ] **Step 4: Build the docs site**

Run: `cd apps/docs && pnpm build 2>&1 | tail -3`
Expected: build succeeds (the `docs-check` CI job runs `astro check` + build).

- [ ] **Step 5: Commit**

```bash
git add apps/docs/src/content/docs/security/hardening.mdx apps/docs/src/content/docs/features/scripts.mdx CHANGELOG.md
git commit -m "docs: Require MFA is on by default for new partners"
```

---

## Final verification (before opening the PR)

- [ ] `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json` → exit 0
- [ ] `cd apps/api && npx vitest run src/services/partnerDefaultSettings.test.ts src/db/seed.test.ts src/routes/orgs.test.ts src/services/mfaPolicy.test.ts` → all pass (`mfaPolicy.test.ts` unchanged and still green proves read-time semantics did not move)
- [ ] `pnpm test-stack up`, then `set -a && . ./.env.test && set +a && cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/registerPartnerMfaPolicy.integration.test.ts src/__tests__/integration/partnerSettingsAuthority.integration.test.ts` → pass; `pnpm test-stack down`
- [ ] `cd apps/web && npx vitest run src/components/auth src/lib/i18n src/components/settings/PartnerSettingsPage` → pass
- [ ] `cd apps/web && npx astro check` → 0 errors
- [ ] PR body: this touches `PartnerSettingsPage.tsx` (a `*Settings*` component) only to dispatch an event; state per CLAUDE.md "Settings — one concept, one home" rule 9 that no setting was added — home (Partner → Security), level (partner, locks orgs) and resolver (`getEffectiveMfaPolicy`) are unchanged, and the count of places `requireMfa` is configured stays at 2 (partner tab, org tab).
