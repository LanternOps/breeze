---
tracking_issue: LanternOps/breeze#11377
---

# Portal Registration W1: Invite From Contacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An MSP can give one contact or many contacts browser-portal access from the org's Contacts tab. Each login binds to the contact the MSP picked, and the invite address always matches that contact's email.

**Architecture:** One new service, `services/contacts/portalInvite.ts`, holds a pure planner (`planContactInvite`) and a locked binder (`bindContactLoginForInvite`). It takes the same advisory lock as `linkLoginToContact`. Both routes call it: the existing single invite route (with a new optional `contactId`) and a new capped batch route `invite-contacts`. Both reuse `issueAndSendInvite`. The web reads portal status from the existing partner/system-gated `GET …/portal-users` list, which gains `contactId` and `authMethod`, and joins it to contacts on the client.

**Tech Stack:** Hono + Drizzle (API), Zod (`@breeze/shared`), React island + react-i18next (web), Vitest (unit + `vitest.integration.config.ts` on real Postgres as `breeze_app`).

**Spec:** `docs/superpowers/specs/portal/2026-11-07-portal-registration-options-design.md` §5.5 (minus the SSO email variant, which is W4), §6, §7 row W1.

## Global Constraints

- **Rebase first.** This branch is based on `95a3e48db5`, but `origin/main` is already ahead (`127bb8b543`+). Run `git fetch && git rebase origin/main` before Task 1, and fetch again before the final push.
- **No migration.** `portal_users.contact_id`, the composite FK `portal_users_contact_org_fk (contact_id, org_id) → contacts (id, org_id) DEFERRABLE INITIALLY IMMEDIATE` and `portal_users_contact_idx` already exist (`apps/api/migrations/2026-10-04-100002-portal-users-contact-composite-fk.sql`). This wave adds no table and no column, so nothing is registered for cascade, merge or export. Do not touch `apps/api/migrations/`.
- **Same guards on both routes:** `requireScope('partner', 'system')`, `requireOrgWrite` (ORGS_WRITE), `requireMfa()`, `zValidator`, then `resolveAccessibleOrg(c)`. These are copied from the existing invite route in `apps/api/src/routes/orgPortalUsers.ts:159`.
- **Contacts are always read by `(id, org_id)` together, never by id alone.** Site reach is enforced with `canReachContactSite(auth, contact.siteId)` (exported from `apps/api/src/routes/orgContacts.ts:111`). A contact that is missing, in another org or on a barred site is the same 404 `PORTAL_INVITE_CONTACT_NOT_FOUND`. There is no existence oracle.
- **Email equality is case-insensitive and trimmed**, through `normalizeContactEmail` (`services/contacts/crud.ts:135`). The comparison is `normalizeContactEmail(body.email) === normalizeContactEmail(contact.email)`.
- **A refusal writes nothing.** `already_has_access`, `email_bound_to_other_contact`, `no_email` and `duplicate_email_in_batch` never update `portal_users` or `contacts`. An existing `contact_id` is never overwritten (spec §5.5: the MSP unbinds first).
- **Batch cap: `INVITE_CONTACTS_MAX = 100`.** Each invite sends one email synchronously inside the request, plus a Redis token and a branding read. The UI only selects within a 25-row page.
- **Batch outcomes are exactly** `invited | already_has_access | no_email | email_bound_to_other_contact | duplicate_email_in_batch`. Detail rides in the optional `reason` and `emailSent` fields, never as a sixth outcome.
- **Stable error codes** (response body `{ error, code }`, matching `orgContacts.ts` `validationResponse`): `PORTAL_INVITE_CONTACT_NOT_FOUND` 404, `PORTAL_INVITE_CONTACT_NO_EMAIL` 400, `PORTAL_INVITE_EMAIL_MISMATCH` 400, `PORTAL_INVITE_CONTACT_CONFLICT` 409, `PORTAL_INVITE_LOGIN_EMAIL_DIFFERS` 409, `PORTAL_INVITE_ALREADY_ACTIVE` 409, `PORTAL_INVITE_USER_DISABLED` 409, `PORTAL_INVITE_EXTERNAL_IDENTITY` 409. The three pre-existing 409s on the no-`contactId` path keep their status and message and gain the matching code.
- **Trap: catching a query.** A `catch` around a DB call must wrap the call in `withDbTransaction(...)` (savepoint) and catch *outside* it. Otherwise the request transaction is poisoned and rethrows at COMMIT (#11203). The request transaction commits on any non-throwing return, including 4xx.
- **Trap: new `apps/api/src/services` file.** `parkedFanout.contract.test.ts` discovers only files that read `devices` or carry a Quick-Support/ephemeral exclusion. `portalInvite.ts` does neither, so it needs no entry. Run the contract test anyway (Task 8) to prove it stays green.
- **Trap: locales.** Every new key goes into all 8 locales (`en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR`) under `apps/web/src/locales/<loc>/`, with real translations: `translationCoverage.test.ts` caps exact-English duplicates. Use static key maps, not template strings, so `keyUsage.test.ts` can see them.
- **Trap: API typecheck.** CI runs `pnpm exec tsc --build apps/api/tsconfig.tests.json`. Locally, run `NODE_OPTIONS=--max-old-space-size=12288 pnpm exec tsc --build apps/api/tsconfig.tests.json; echo "exit=$?"`. Never pipe it to `tail`: an OOM reads as green. Exit code 0 is the only pass.
- **Scoped test runs:** `cd apps/api && npx vitest run <file>` (likewise in `apps/web` and `packages/shared`). Never `pnpm --filter <pkg> test -- --run <path>`. Vitest path filters are substring matches, so check the reported file count.
- **Web mutations go through `runAction`.** The caller catch is `handleActionError(err, fallback)`, the pattern `ContactsCard.tsx` already uses. `no-silent-mutations.test.ts` guards this.
- **Settings rule 9:** this wave adds no setting (it is an action on a list), so the PR states "no setting added; places configured before = after = 0".

## Review Focus

1. **A customer (organization-scope) user opens the Contacts tab.** `GET …/portal-users` returns 403 for them. They should see contacts exactly as today: no Portal column, no checkboxes, no portal checkbox on create, and no error toast. Test in Task 7.
2. **The contact's email was edited after its login was bound, and the login is still pending.** Expected: "Resend invite" is refused with `PORTAL_INVITE_LOGIN_EMAIL_DIFFERS` (batch: `already_has_access`, `reason: 'login_email_differs'`). No second login is minted and nothing is mailed to the old address. Tests in Tasks 2 and 3.
3. **The contact's address belongs only to an AI for Office (Entra) login.** Expected: refused as `external_identity`, and no password row is created next to it (browser access for add-in users is W2/W3). The Portal column reads "No access", not "Invited". Tests in Tasks 2, 5 and 6.
4. **Email delivery fails mid-batch** (Redis down or no provider). Expected: the outcome is still `invited` with `emailSent: false`, and the UI warns to use Resend. It must not report a clean success or roll back the login. Tests in Tasks 4 and 7.
5. **A selected contact is deleted while the batch runs.** Expected: the whole batch returns 404 `PORTAL_INVITE_CONTACT_NOT_FOUND`, no email is sent, and no half-written login rows remain (the savepoint rolls back). Test in Task 4.

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `packages/shared/src/validators/portal.ts` | Modify (`:229-239`) | `contactId` on invite; `inviteContactsToPortalSchema`; outcome/code constants and result type |
| `packages/shared/src/validators/portal.test.ts` | Modify | Validator cases |
| `apps/api/src/services/contacts/portalInvite.ts` | Create | `loadOrgContactsForPortalInvite`, pure `planContactInvite`, locked `bindContactLoginForInvite`, `ContactGoneError` |
| `apps/api/src/services/contacts/portalInvite.test.ts` | Create | Table-driven planner tests; binder lock/write tests on a mocked executor |
| `apps/api/src/routes/orgPortalUsers.ts` | Modify (`:159-226`, new route after `:286`) | `contactId` branch on invite; `POST …/invite-contacts` |
| `apps/api/src/routes/orgPortalUsers.contacts.test.ts` | Create | Route tests with the service mocked (the existing `orgPortalUsers.test.ts` select-order mocks stay untouched) |
| `apps/api/src/__tests__/integration/portalContactInvite.integration.test.ts` | Create | Real Postgres/RLS: cross-org, cross-partner, conflict, mismatch, outcomes, FK backstop |
| `apps/api/src/services/portalUserDirectory.ts` | Modify (`:15-63`) | List items carry `contactId`, `authMethod` |
| `apps/api/src/services/portalUserDirectory.test.ts` | Modify | Assert the new fields |
| `apps/web/src/components/settings/contactPortalAccess.ts` | Create | `derivePortalStatus`, `useContactPortalAccess`, `giveContactPortalAccess`, `giveContactsPortalAccess` |
| `apps/web/src/components/settings/contactPortalAccess.test.ts` | Create | Derivation and request-shape tests |
| `apps/web/src/components/settings/ContactsCard.tsx` | Modify | Portal column, row actions, selection + bulk bar, create checkbox |
| `apps/web/src/components/settings/ContactsCard.portal.test.tsx` | Create | UI tests |
| `apps/web/src/components/settings/ContactsCard.test.tsx` | Modify (`mockApi`, `:57-76`) | Serve `…/portal-users` (default `{ data: [] }`) so existing tests do not receive the contacts payload |
| `apps/web/src/locales/<8 locales>/settings.json`, `errors.json` | Modify | `contactsCard.portal.*` and the eight error codes |
| `apps/docs/src/content/docs/features/portal.mdx`, `docs/release-notes/next-release-draft.md` | Modify | MSP docs and release note |

---

### Task 1: Shared validators and result contract

**Files:**
- Modify: `packages/shared/src/validators/portal.ts:229-239`
- Test: `packages/shared/src/validators/portal.test.ts`

**Interfaces:**
- Produces (all exported from `@breeze/shared`):
  - `invitePortalUserSchema`: adds `contactId: z.string().guid().optional()` and stays `.strict()`.
  - `INVITE_CONTACTS_MAX = 100`
  - `inviteContactsToPortalSchema = z.object({ contactIds: z.array(z.string().guid()).min(1).max(INVITE_CONTACTS_MAX) }).strict()`, plus `type InviteContactsToPortalInput`.
  - `CONTACT_PORTAL_INVITE_OUTCOMES = ['invited','already_has_access','no_email','email_bound_to_other_contact','duplicate_email_in_batch'] as const`, plus `type ContactPortalInviteOutcome`.
  - `type AlreadyHasAccessReason = 'active' | 'disabled' | 'external_identity' | 'login_email_differs'`
  - `type ContactPortalInviteResult = { contactId: string; outcome: ContactPortalInviteOutcome; portalUserId?: string; emailSent?: boolean; reason?: AlreadyHasAccessReason }`
  - `PORTAL_INVITE_ERROR_CODES`: an `as const` object with the eight codes from Global Constraints (key = value).

- [ ] **Step 1: Write the failing tests** in `portal.test.ts`:
  - `it('invitePortalUserSchema accepts an optional uuid contactId')`: `{ email:'a@b.co', contactId:<uuid> }` parses; `contactId:'nope'` fails.
  - `it('inviteContactsToPortalSchema caps the batch at 100')`: 100 uuids parse; 101 fail; `[]` fails; an unknown key fails (strict).
  - `it('outcome list is exactly the five spec outcomes')`: `expect([...CONTACT_PORTAL_INVITE_OUTCOMES]).toEqual(['invited','already_has_access','no_email','email_bound_to_other_contact','duplicate_email_in_batch'])`.
- [ ] **Step 2: Run** `cd packages/shared && npx vitest run src/validators/portal.test.ts`. Expected: FAIL (`inviteContactsToPortalSchema` is not exported).
- [ ] **Step 3: Implement** the exports above in `portal.ts`.
- [ ] **Step 4: Run** the same command, then `pnpm --filter @breeze/shared typecheck`. Expected: PASS, exit 0.
- [ ] **Step 5: Commit** `feat(shared): invite-from-contacts validators and outcome contract`

---

### Task 2: Invite planner and binder service

**Files:**
- Create: `apps/api/src/services/contacts/portalInvite.ts`
- Test: `apps/api/src/services/contacts/portalInvite.test.ts`

**Interfaces:**
- Consumes: `ContactExecutor` (`services/contacts/compat.ts:55`), `updateContact`, `normalizeContactEmail` (`crud.ts`), `INBOUND_CONTACT_LOCK_NAMESPACE` (`services/inboundEmail/resolveOrg`), `AlreadyHasAccessReason` (Task 1).
- Produces:
  ```ts
  export interface InviteableContact { id: string; orgId: string; siteId: string | null; name: string | null; email: string | null }
  export async function loadOrgContactsForPortalInvite(exec: ContactExecutor, orgId: string, contactIds: readonly string[]): Promise<InviteableContact[]>
  export interface InviteLoginCandidate { id: string; email: string; contactId: string | null; authMethod: string; status: string; passwordHash: string | null; createdAt: Date }
  export type InvitePlan =
    | { action: 'create' }
    | { action: 'reuse'; login: InviteLoginCandidate; contactLink: 'kept' | 'direct' }
    | { action: 'has_access'; login: InviteLoginCandidate; reason: AlreadyHasAccessReason }
    | { action: 'conflict'; login: InviteLoginCandidate };
  export function planContactInvite(contactId: string, normalizedEmail: string, candidates: InviteLoginCandidate[]): InvitePlan
  export type ContactInviteDecision =
    | { kind: 'invite'; portalUserId: string; email: string; created: boolean; contactLink: 'kept' | 'direct' }
    | { kind: 'already_has_access'; portalUserId: string; reason: AlreadyHasAccessReason }
    | { kind: 'email_bound_to_other_contact'; portalUserId: string };
  export class ContactGoneError extends Error {}
  export async function bindContactLoginForInvite(exec: ContactExecutor, input: {
    orgId: string; contact: InviteableContact; normalizedEmail: string; name: string | null; actor: { userId: string }; now: Date;
  }): Promise<ContactInviteDecision>
  ```

**Planner rules** (the algorithm the signature does not determine). P = candidates with `authMethod === 'password'`, and X = the rest. `email` comparisons are lower-cased.
1. `bound` = P with `contactId === contactId`. If any, take the first by priority: active-with-hash, then pending, then disabled (ties go to the newest `createdAt`). Then: `status === 'disabled'` gives `has_access/disabled`; `passwordHash && status === 'active'` gives `has_access/active`; `email !== normalizedEmail` gives `has_access/login_email_differs`; otherwise `reuse/kept`.
2. If any row in P has `email === normalizedEmail` and a **different non-null** `contactId`, the plan is `conflict`.
3. `unbound` = P with `email === normalizedEmail` and `contactId === null`. If any, take the newest. Then `disabled` gives `has_access/disabled`; active-with-hash gives `has_access/active` (no bind, because a refusal writes nothing); otherwise `reuse/direct`.
4. If X is non-empty (an Entra row bound to this contact or holding this email), the plan is `has_access/external_identity`.
5. Otherwise, `create`.

**Binder steps:**
1. Take `pg_advisory_xact_lock(hashtext(INBOUND_CONTACT_LOCK_NAMESPACE), hashtext(`${orgId}:${normalizedEmail}`))`, the same key `linkLoginToContact` uses (`loginLink.ts:116`).
2. Re-read the contact `WHERE id = $1 AND org_id = $2 FOR KEY SHARE`, selecting `roles`. If nothing comes back, throw `ContactGoneError`.
3. Read candidates: `portal_users WHERE org_id = $orgId AND (contact_id = $contactId OR lower(email) = $normalizedEmail)`.
4. Plan, then write only for `reuse` and `create`:
   - `reuse` updates `{ name: name ?? undefined, status: 'invited', authEpoch: +1, invitedBy, invitedAt: now, updatedAt: now, contactId }` (the same set as `orgPortalUsers.ts:204` plus `contactId`).
   - `create` inserts `{ orgId, email: normalizedEmail, name: name ?? contact.name, passwordHash: null, authMethod: 'password', status: 'invited', invitedBy, invitedAt: now, contactId }`.
   - Both then union the `'portal'` role onto the contact through `updateContact`, but only when it is missing (the short-circuit at `loginLink.ts:156`).

- [ ] **Step 1: Write the failing tests.**
  - `describe('planContactInvite')`, table-driven, one `it` per row, asserting `{action, reason?, login.id?}`:
    - no candidates gives `create`
    - pending password row bound to C gives `reuse/kept`
    - active+hash bound to C gives `has_access/active`
    - disabled bound to C gives `has_access/disabled`
    - pending bound to C with email `old@x` vs `new@x` gives `has_access/login_email_differs`
    - email row bound to other contact D gives `conflict`
    - unbound pending email row gives `reuse/direct`
    - unbound active+hash row gives `has_access/active`
    - Entra-only row with the email gives `has_access/external_identity`
    - Entra row bound to C plus no password row gives `has_access/external_identity`
    - password row bound to C plus Entra twin gives `reuse/kept` (P wins)
    - `Ada@X.test` stored vs `ada@x.test` normalized gives a match
  - `it('takes the inbound advisory lock on (org, normalized email) before any read')`: the first `exec.execute` statement, rendered with `PgDialect().sqlToQuery`, contains `INBOUND_CONTACT_LOCK_NAMESPACE` and `${ORG}:ada@x.test`. Mirror `orgPortalUsers.test.ts:185`.
  - `it('re-reads the contact by id AND org with FOR KEY SHARE and throws ContactGoneError when it is gone')`
  - `it('create inserts a password-method invited row bound to the contact')`: `valuesSpy` gets `{ authMethod:'password', status:'invited', contactId: C, passwordHash: null }`.
  - `it('reuse writes contactId and bumps authEpoch; kept does not change contactId')`
  - `it('has_access and conflict perform no insert, update, or contact write')`: `insert`, `update` and `updateContact` are not called.
  - `it("unions the 'portal' role only when missing")`
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/contacts/portalInvite.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `portalInvite.ts` per the rules above. `loadOrgContactsForPortalInvite` uses `and(eq(contacts.orgId, orgId), inArray(contacts.id, ids))`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): contact-bound portal invite planner and binder`

---

### Task 3: Single invite accepts `contactId`

**Files:**
- Modify: `apps/api/src/routes/orgPortalUsers.ts:159-226` (plus the type at `:115`)
- Test: `apps/api/src/routes/orgPortalUsers.contacts.test.ts` (new; mocks `../services/contacts/portalInvite`, `../db` and `withDbTransaction` as a pass-through, `../services/email`, `./portal/helpers`, `../services/auditEvents`, and `./orgContacts`'s `canReachContactSite` as the real function)

**Interfaces:**
- Consumes: Task 2 exports; `PORTAL_INVITE_ERROR_CODES` (Task 1).
- Produces:
  - `type InviteContactLink = LoginContactOutcome | 'kept' | 'direct'`
  - A module-local `inviteDecisionRefusal(decision): { status: 409; code: string; error: string } | null` mapping:
    - `email_bound_to_other_contact` → `PORTAL_INVITE_CONTACT_CONFLICT`
    - `active` → `PORTAL_INVITE_ALREADY_ACTIVE`
    - `disabled` → `PORTAL_INVITE_USER_DISABLED`
    - `external_identity` → `PORTAL_INVITE_EXTERNAL_IDENTITY`
    - `login_email_differs` → `PORTAL_INVITE_LOGIN_EMAIL_DIFFERS`
  - The response shape is unchanged: `{ data: { id, email, status:'invited', contactLink }, emailSent }`.

**Flow when `contactId` is present** (the existing path is unchanged without it, apart from codes on its three 409s):
1. `loadOrgContactsForPortalInvite(db, org.id, [contactId])`. If the result is empty, or `!canReachContactSite(auth, row.siteId)`, return 404 `PORTAL_INVITE_CONTACT_NOT_FOUND`.
2. `normalizeContactEmail(contact.email)` null → 400 `PORTAL_INVITE_CONTACT_NO_EMAIL`. If it differs from the normalized body email → 400 `PORTAL_INVITE_EMAIL_MISMATCH`.
3. Run `withDbTransaction(() => bindContactLoginForInvite(db, …))` with the catch outside. `ContactGoneError` → 404 `PORTAL_INVITE_CONTACT_NOT_FOUND`.
4. A refusal returns 409 with its code. On `invite` with `!created`: `purgePortalSessionsForUsers` + `purgeClientAiSessionsForUsers` (as `:205-207`). Then `issueAndSendInvite`, then the audit `organization.portal_user.invite` with details `{ email, emailSent, contactLink, contactId }`.

- [ ] **Step 1: Write the failing tests** in `orgPortalUsers.contacts.test.ts`, under `describe('POST …/invite with contactId')`:
  - `it('binds directly to the named contact and never calls linkLoginToContact')`: the binder is called with `contact.id`; the `../services/contacts/loginLink` spy is not called; the response has `contactLink: 'direct'`.
  - `it('accepts a case-different invite email (Ada@Acme.TEST vs ada@acme.test)')`: 200.
  - `it('refuses an email that differs from the contact email with 400 PORTAL_INVITE_EMAIL_MISMATCH and writes nothing')`: the binder is not called and `sendInvite` is not called.
  - `it('404s PORTAL_INVITE_CONTACT_NOT_FOUND when the contact is not in this org')`: the loader returns `[]`. Assert that the loader was called with `(…, ORG_ID, [contactId])`, which proves the org bound is passed.
  - `it('404s a contact pinned to a site the caller cannot reach')`: `authRef.canAccessSite = () => false`.
  - `it('400s PORTAL_INVITE_CONTACT_NO_EMAIL for a contact without an email')`
  - `it.each` over the five refusal decisions → the expected status and code, with no email sent and no audit written.
  - `it('re-invite of a login already bound to the same contact reports contactLink kept and purges sessions')`
  - `it('404s when the contact is deleted between load and bind (ContactGoneError)')`
  - `it('audits contactId and contactLink')`
  - `it('the no-contactId path still 409s an Entra identity, now with code PORTAL_INVITE_EXTERNAL_IDENTITY')`
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/routes/orgPortalUsers.contacts.test.ts src/routes/orgPortalUsers.test.ts`. Expected: the new file FAILS; the existing file PASSES (2 files reported).
- [ ] **Step 3: Implement** the branch and the codes.
- [ ] **Step 4: Run** the same command. Expected: both files PASS.
- [ ] **Step 5: Commit** `feat(api): portal invite binds to a named contact (email must match)`

---

### Task 4: Batch `POST /organizations/:id/portal-users/invite-contacts`

**Files:**
- Modify: `apps/api/src/routes/orgPortalUsers.ts` (new handler after bulk-invite, `:286`)
- Test: `apps/api/src/routes/orgPortalUsers.contacts.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: the response `{ data: { results: ContactPortalInviteResult[]; counts: Record<ContactPortalInviteOutcome, number> } }`, always 200 once validation passes. The audit actions are:
  - `organization.portal_user.invite` per invited contact, with details `{ email, emailSent, contactLink, contactId, source: 'invite_contacts' }`.
  - `organization.portal_user.invite_contacts` once, with `resourceType: 'organization'` and details `{ requested, counts }`.

**Flow:**
1. Dedupe `contactIds` while keeping first-seen order.
2. Load the contacts in the org, then filter by `canReachContactSite`. If fewer remain than unique ids, return 404 `PORTAL_INVITE_CONTACT_NOT_FOUND` for the whole batch. There is no partial processing and no per-id oracle.
3. Classify: a null normalized email gives `no_email`. A normalized email shared by two or more requested contacts gives `duplicate_email_in_batch` for **every** contact in that group; there is no guess about who is the "real" one, mirroring the `ambiguous` rule in `loginLink.ts:131-136`.
4. **Phase 1 (DB):** a single `withDbTransaction(async () => { for … bindContactLoginForInvite })` covers the remaining contacts sequentially, with the catch outside. `ContactGoneError` → 404 for the batch, and the savepoint rolls back every bind.
5. **Phase 2 (side effects, after phase 1 succeeds):** for each `invite` decision, purge sessions if `!created`, call `issueAndSendInvite`, and record `emailSent`. Map refusals to `already_has_access` (with `reason`) or `email_bound_to_other_contact`.

- [ ] **Step 1: Write the failing tests** under `describe('POST …/invite-contacts')`:
  - `it('returns exactly one result per unique contactId with the five outcomes')`: a fixture of 5 contacts yields `invited`, `already_has_access` (`reason:'active'`), `no_email`, `email_bound_to_other_contact`, and two contacts sharing an email → both `duplicate_email_in_batch`. Assert `results.map(r => [r.contactId, r.outcome])` exactly, plus `counts`.
  - `it('never binds or emails a duplicate_email_in_batch or no_email contact')`: the binder is called only for eligible ids.
  - `it('dedupes a contactId repeated in the request')`
  - `it('404s the whole batch when any contactId is outside the org, and sends nothing')`: the loader returns 1 of 2.
  - `it('404s the whole batch when a contact is on an unreachable site')`
  - `it('404s and sends no email when a contact disappears mid-batch (ContactGoneError)')`: `sendInvite` is not called.
  - `it('reports invited with emailSent:false when the email service fails')`: `sendInvite` rejects.
  - `it('400s more than 100 contactIds')` (validator wired).
  - `it('writes one invite audit per invited contact and one invite_contacts summary')`
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/routes/orgPortalUsers.contacts.test.ts`. Expected: FAIL (404 route).
- [ ] **Step 3: Implement** the handler (`zValidator('json', inviteContactsToPortalSchema)`, same guard chain).
- [ ] **Step 4: Run** the same command plus `src/routes/orgPortalUsers.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): batch invite-contacts with per-contact outcomes`

---

### Task 5: Integration tests on real Postgres (authorization proof)

**Files:**
- Create: `apps/api/src/__tests__/integration/portalContactInvite.integration.test.ts`. Copy the harness from `portalUserInvite.integration.test.ts:36-105`: `import './setup'`, `buildMspApp`, `mfaTokenFor`, `getTestDb()` superuser seeding, and `setupTestEnvironment({ scope: 'partner' })`.

**Interfaces:**
- Consumes: the Task 3/4 routes. Contacts are seeded with `getTestDb().insert(contacts)`.

- [ ] **Step 1: Write the tests:**
  - `it('binds the new login to the named contact (contact_id set, auth_method password, status invited)')`
  - `it('refuses a contactId from a sibling org of the SAME partner with 404 and creates no portal_users row in either org')`: `orgA2 = createOrganization({ partnerId: envA.partner.id })`; the contact is in orgA2, posted to orgA. RLS does not hide it here, so this proves the app-layer `(id, org_id)` bound.
  - `it('refuses a contactId from another partner with 404 (RLS-hidden)')`
  - `it('refuses an email that does not equal the contact email (400 PORTAL_INVITE_EMAIL_MISMATCH), no row written')`
  - `it('409 PORTAL_INVITE_CONTACT_CONFLICT when the address has a login bound to a different contact, and the existing binding is unchanged')`: re-select the row and `expect(row.contactId).toBe(otherContact.id)`.
  - `it('re-invite of a login bound to the same contact keeps the binding (contactLink kept)')`
  - `it('invite-contacts returns all five outcomes against real rows')`, using the same fixture shape as Task 4.
  - `it('invite-contacts with an Entra-only login on the address reports already_has_access/external_identity and creates no password row')`
  - `it('the composite FK still rejects a cross-org contact_id written directly')`: as `breeze_app` inside `withSystemDbAccessContext`, a direct `update(portalUsers).set({ contactId: orgA2Contact.id })` on an orgA login rejects with code `23503`. This proves the DB backstop exists, independent of the route.
- [ ] **Step 2: Bring up the stack** with `pnpm test-stack up`, then run `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/portalContactInvite.integration.test.ts`. Expected: PASS (1 file).
- [ ] **Step 3: Mutation control (prove the test can fail).** Temporarily replace `eq(contacts.orgId, orgId)` in `loadOrgContactsForPortalInvite` with `sql\`true\``. Re-run and confirm the sibling-org test goes **red** (the FK makes the bind 23503, or the row appears). Then temporarily change the email comparison to always-equal and confirm the mismatch test goes **red**. Restore both, re-run, and confirm green. Record both red runs in the PR body.
- [ ] **Step 4: Run** the existing `portalUserInvite.integration.test.ts` too (no regression), then `pnpm test-stack down`.
- [ ] **Step 5: Commit** `test(api): invite-from-contacts integration coverage (cross-org, conflict, outcomes)`

---

### Task 6: Portal status source for the Contacts tab

**Decision:** read the existing `GET /orgs/organizations/:id/portal-users` (partner/system-gated) and join it on the client by `contactId`. Do not extend `GET …/contacts`. The contacts list admits organization-scope tokens and its `listContacts` service is shared with AI tools, so portal data stays behind the gate that already protects it.

**Files:**
- Modify: `apps/api/src/services/portalUserDirectory.ts:15-63`. Add `contactId` and `authMethod` to the select, the row type and `toListItem`.
- Modify: `apps/api/src/services/portalUserDirectory.test.ts`
- Create: `apps/web/src/components/settings/contactPortalAccess.ts`, `contactPortalAccess.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ContactPortalStatus = 'none' | 'invited' | 'active' | 'disabled';
  export type PortalLogin = { id: string; email: string; contactId: string | null; authMethod: string; effectiveStatus: 'active' | 'disabled' | 'pending_setup' };
  export function derivePortalStatus(contact: { id: string; email: string | null }, logins: PortalLogin[]): { status: ContactPortalStatus; portalUserId: string | null };
  export function useContactPortalAccess(orgId: string): { available: boolean; statusFor: (c: { id: string; email: string | null }) => { status: ContactPortalStatus; portalUserId: string | null }; reload: () => Promise<void> };
  export async function giveContactPortalAccess(orgId: string, contact: { id: string; email: string; name: string | null }, t: TFunction): Promise<void>;   // runAction POST …/invite { email, name, contactId }
  export async function giveContactsPortalAccess(orgId: string, contactIds: string[], t: TFunction): Promise<ContactPortalInviteResult[]>; // runAction POST …/invite-contacts
  ```
- **Derivation rule:** consider only `authMethod === 'password'` logins. Use the login bound to `contact.id` if one exists. Otherwise use an unbound login whose lower-cased email equals the contact's (this is what `already_has_access` reports for it). Priority is active > pending > disabled. `pending_setup` maps to `invited`. Nothing found gives `none`.
- **Hook rule:** 403 or 404 on the list gives `available: false` with no toast (organization-scope caller). 401 → `navigateTo('/login', { replace: true })`. Other failures give `available: false` plus `console.warn`.
- **Toasts** inside the give functions: single `emailSent === false` → warning `contactsCard.portal.toasts.inviteEmailFailed`, else success `contactsCard.portal.toasts.invited`. Batch → one toast built from `counts` (warning if anything was not `invited` or any `emailSent === false`). Errors come from `runAction` + `errors:<CODE>`.

- [ ] **Step 1: Write the failing tests:**
  - API: `it('portal user list items carry contactId and authMethod but never passwordHash')`
  - Web, table-driven `derivePortalStatus`:
    - a bound active login gives `active`
    - bound pending gives `invited`
    - bound disabled gives `disabled`
    - an Entra-only bound login gives `none`
    - an unbound active login with the same email (mixed case) gives `active`
    - bound disabled plus another active login bound to the same contact gives `active`
    - a login bound to another contact with the same email gives `none`
    - a contact with no email and no bound login gives `none`
  - `it('giveContactPortalAccess posts email, name and contactId to the invite route')`
  - `it('giveContactsPortalAccess posts contactIds to invite-contacts and returns results')`
  - `it('useContactPortalAccess reports available:false on 403 without a toast')`
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/portalUserDirectory.test.ts` and `cd apps/web && npx vitest run src/components/settings/contactPortalAccess.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both changes.
- [ ] **Step 4: Re-run** both, plus `cd apps/api && npx vitest run src/services/aiToolsOrgAdminReads.test.ts src/routes/orgPortalUsers.test.ts` and `cd apps/web && npx vitest run src/lib/__tests__/no-silent-mutations.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: expose portal login contact binding for the contacts tab`

---

### Task 7: Contacts tab UI and locales

**Files:**
- Modify: `apps/web/src/components/settings/ContactsCard.tsx`, `ContactsCard.test.tsx` (`mockApi` serves `/portal-users` with `{ data: [] }` by default, via a `portalUsers?` / `portalUsersStatus?` option)
- Create: `apps/web/src/components/settings/ContactsCard.portal.test.tsx`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/settings.json` (`contactsCard.portal`) and `errors.json` (the eight codes)

**Interfaces:**
- Consumes: Task 6 exports.
- UI contract (every element renders only when `portal.available`):
  - **Portal column** after Roles: `data-testid="org-contacts-portal-status-${id}"` shows the status label from a static `PORTAL_STATUS_LABEL_KEYS: Record<ContactPortalStatus, string>` map.
  - **Row action:**
    - `none` with an email: "Give portal access" (`org-contacts-portal-give-${id}`).
    - `invited`: "Resend invite" (`org-contacts-portal-resend-${id}`). It posts the same invite-with-`contactId` request, so the email-equals-contact rule holds on resend too.
    - `active` / `disabled`: no action.
    - Busy state disables the button.
  - **Selection:** a checkbox per row (`org-contacts-select-${id}`) and a header select-all for the page (`org-contacts-select-all`). Selection clears when the page, a filter or `orgId` changes. When anything is selected, a bulk button `org-contacts-portal-bulk-give` reads "Give portal access ({{count}})".
  - **Create form:** checkbox `contact-form-portal-access-input`, shown on create only and disabled while the email is blank. After a successful create, `save()` reads `runAction<{ data: Contact }>` and calls `giveContactPortalAccess` with the new contact. An invite failure leaves the contact created (its own toast) and still closes the form.
  - After any portal mutation: `portal.reload()`. Errors go through `handleActionError(err, t('contactsCard.portal.errors.invite'))`.
- **Locale keys** (`settings` namespace, `contactsCard.portal.`):
  - `column`
  - `status.{none,invited,active,disabled}`
  - `actions.{give,resend,bulkGive,selectAll,selectRow}`
  - `form.{giveAccess,needsEmail}`
  - `toasts.{invited,inviteEmailFailed,bulkSummary}`
  - `outcomes.{invited,already_has_access,no_email,email_bound_to_other_contact,duplicate_email_in_batch}`, each phrased as `"<label>: {{count}}"` so no plural forms are needed
  - `errors.{invite,bulkInvite}`
  
  `errors.json` adds the eight `PORTAL_INVITE_*` codes, which `runAction` picks up through `errors:<CODE>` (`runAction.ts:146`).

- [ ] **Step 1: Write the failing tests** in `ContactsCard.portal.test.tsx`:
  - `it('shows a Portal status per contact derived from portal users')`: none, invited, active and disabled fixtures.
  - `it('hides the Portal column, checkboxes and create checkbox when portal-users returns 403, with no toast')`
  - `it('Give portal access posts {email, name, contactId} and reloads portal status')`
  - `it('Resend invite posts the same contact-bound invite')`
  - `it('offers no portal action for active or disabled contacts, or for a contact without email')`
  - `it('bulk Give portal access posts the selected contactIds and toasts the outcome counts')`, with a `{ results, counts }` fixture.
  - `it('warns when a batch invite reports emailSent:false')`
  - `it('clears the selection when the page changes')`
  - `it('creating a contact with Give portal access checked invites the created contact')`: the POST contact is followed by a POST invite with `contactId` equal to the new id.
  - `it('the create checkbox is disabled while the email is blank')`
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/settings/ContactsCard.portal.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the UI. Add the locale keys to all 8 locales with real translations, and the eight codes to all 8 `errors.json`.
- [ ] **Step 4: Run** `cd apps/web && npx vitest run src/components/settings/ContactsCard src/components/organizations/record/OrganizationRecordPage.test.tsx src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts src/locales/humanizedKeyRegression.test.ts src/lib/__tests__/no-silent-mutations.test.ts`. Expected: all PASS. Check that the file count includes `ContactsCard.test.tsx`, `ContactsCard.callerVerification.test.tsx` and `ContactsCard.portal.test.tsx`.
- [ ] **Step 5: Commit** `feat(web): give portal access from the contacts tab (row, bulk, on create)`

---

### Task 8: Docs, release note, full verification

**Files:**
- Modify: `apps/docs/src/content/docs/features/portal.mdx`. Add a "Give contacts portal access" subsection after "Portal invite email" (`:22`) covering: the email must match the contact; an existing binding is never replaced (unbind first); the batch cap of 100; what each batch outcome means.
- Modify: `docs/release-notes/next-release-draft.md`. Append under `## Features / API` with its own heading `### Portal: invite from contacts (W1)`. This file is a merge-queue hot spot, so append and never reflow.

- [ ] **Step 1: Write the docs and the release note.**
- [ ] **Step 2: Typecheck.**
  - API: `NODE_OPTIONS=--max-old-space-size=12288 pnpm exec tsc --build apps/api/tsconfig.tests.json; echo "exit=$?"`. Expected: `exit=0`.
  - Shared: `pnpm --filter @breeze/shared typecheck`.
  - Web: `cd apps/web && pnpm exec astro check`.
- [ ] **Step 3: Contracts and suites.**
  - `cd apps/api && npx vitest run src/__tests__/parkedFanout.contract.test.ts`. Expected: PASS with no new entry.
  - `pnpm --filter @breeze/api test --run src/routes/orgPortalUsers src/services/contacts src/services/portalUserDirectory`
  - With `pnpm test-stack up`: run `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/portalContactInvite.integration.test.ts src/__tests__/integration/portalUserInvite.integration.test.ts src/__tests__/integration/contactImport.integration.test.ts`, then `pnpm test-stack down`.
- [ ] **Step 4: PR body.** Include:
  - the Settings rule 9 line ("no setting added")
  - the two mutation-control red runs from Task 5
  - `Closes #<W1 sub-issue>` once registered
  - a statement that no migration was added
- [ ] **Step 5: Commit** `docs: invite contacts to the customer portal`

---

## Self-review notes

- **Spec coverage (§5.5 minus the SSO email variant):**
  - `contactId` on invite, the email-equals-contact rule, direct bind and conflict refusal: Tasks 2, 3 and 5.
  - Batch with the five outcomes: Tasks 4 and 5.
  - Portal column, row actions, bulk and create checkbox: Tasks 6 and 7.
  - `kept` preservation: Tasks 2, 3 and 5.
  - §6 invariant 4 (identity org = account org) has its W1 analogue (contact org = login org) proven by the Task 5 FK test.
- **Deliberately not in W1:**
  - the `requested` Portal status (needs `portal_access_requests`, W3)
  - SSO invite email (W4)
  - narrowing bulk-invite (W2)
- **Type names checked across tasks:** `ContactPortalInviteResult`, `AlreadyHasAccessReason`, `bindContactLoginForInvite`, `ContactGoneError`, `loadOrgContactsForPortalInvite`, `derivePortalStatus`, `useContactPortalAccess`, `giveContactPortalAccess`, `giveContactsPortalAccess`, `PORTAL_INVITE_ERROR_CODES`, `INVITE_CONTACTS_MAX`.
