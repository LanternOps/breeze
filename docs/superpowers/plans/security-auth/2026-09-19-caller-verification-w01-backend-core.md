# Caller Verification W01: Backend Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the four tenant tables, destination provenance, canonical bindings, policy resolver, callback workflow, single-use gate, rejection fence and authenticated API, with readiness disabled. Leave fixed interfaces for W02–W05.

**Architecture:** PostgreSQL enforces ownership and relationship integrity. Short ambient transactions serialize requester and target binding locks; a contact lock serializes starts and destination writes. Pure policy/tier functions drive both previews and release checks. Verification rows are durable work records; external delivery occurs only after commit. Hono performs permission/MFA checks; services independently enforce org/site reach. No M365 mutation backend is wired until W05.

**Tech Stack:** PostgreSQL 15+, hand-written SQL, Drizzle, Hono, shared Zod, Vitest with Drizzle mocks and a real Postgres/Redis integration stack.

**Spec:** `docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md` v5: D1, D4, D6–D8, D11–D16, D18; Data model; Tiers and establishment; Service layer; authenticated API excluding administrative/device-suggestions; independent login telemetry; W01 tests. Cross-wave names and signatures come from `docs/superpowers/plans/security-auth/2026-09-19-caller-verification.md`; its signatures supersede the design's older `freshForSubject` / `resolveSubject` names. Review-note corrections in v5 supersede earlier notes saying unbound workstation is tier 2 or FK deletion is NO ACTION.

## Global Constraints

- RLS enabled + forced + policies in the creating migration. Three shape-1 tables use `breeze_has_org_access(org_id)`; policies use dual ownership with a separate SELECT-only partner branch.
- Composite FKs carrying `org_id` are `DEFERRABLE INITIALLY IMMEDIATE`. Requester/destination also carry `contact_id`; column-specific `ON DELETE SET NULL (requester_binding_id)`, `(target_binding_id)`, `(destination_id)` preserve ownership columns.
- Migrations are idempotent, without inner BEGIN/COMMIT. DML migrations start with `SELECT set_config('breeze.scope','system',true);`; backfill reports even a zero count with `RAISE WARNING`.
- Reserved slots: `2026-10-15-180000`, `180100`, `180200`. Before every implementation commit run `ls apps/api/migrations | sort | tail -1`; this checkout also contains directory `preflight`, so inspect `printf '%s\n' apps/api/migrations/*.sql | sort | tail -1`. Compare committed/main SQL names and rename the three **unshipped** files upward together if needed; sweep test references. Never rename shipped migrations.
- Never name a column `device_id` or `ticket_id` on the new tables. `workstation_device_ref`, `ticket_ref`, and `consumed_intent_ref` are snapshots without FKs. No JSON/JSONB/bytea on the four new tables.
- Register all columns/tables in cascade, export and merge contracts. `required_tier_reset_password` is `reviewedIncluded`; token/match/decoy/reverse/value-hash material is `excludedSensitive`.
- Readiness flag `CALLER_VERIFICATION_ENABLED` defaults false. The cross-wave contract says exactly `=== 'true'`; do not accept `1`/`yes`/`on` for this particular flag. Every feature route returns 404 `feature_disabled` while off — AFTER authentication, not before it: `apps/api/src/__tests__/routerAuthGate.contract.test.ts` requires every mounted route to answer an unauthenticated request with 401, and that repo contract wins over hiding the router from anonymous probes. Existing M365 flows stay unchanged until W05.
- Use ambient `db` inside request transactions; `assertInTransaction` guards multi-write helpers. System jobs enter `runOutsideDbContext(() => withSystemDbAccessContext(...))`. Do not assume a nested system context elevates a request. Never perform Graph/email/agent I/O while holding the request transaction.
- Lock order: identity namespace, then contact locks, then binding locks; binding UUIDs deduplicated and sorted ascending. Gate, rejection, rebinding and W05 dispatch share `withSubjectLocks`. Re-read mutable state after acquiring locks.
- Web mutations use `runAction`. W04 supplies real translations in all 8 locales (`en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`); W01 creates no web surface or locale files.
- Branch `feature/<parent#>-caller-verification/wave-<sub#>`; PR body `Closes #<sub#>`. These issue-number tokens are workflow inputs from the wave issue, not invented issue numbers. Implementation commits below are future executor instructions; writing this plan does not execute them.
- Tests use `cd apps/api && npx vitest run <path>` and `cd packages/shared && npx vitest run <path>`. Integration requires `pnpm test-stack up` / `pnpm test-stack down`. Read `.claude/skills/breeze-testing/SKILL.md`; mirror `contacts/crud.test.ts:1`, `contacts/import.test.ts:1`, `routes/orgContacts.test.ts:1` hoisting, real UUIDs and SQL-condition assertions.
- Verified drift: `routes/index.ts` does not exist; mount at `apps/api/src/index.ts:834`. `canReachContactSite` is private (`routes/orgContacts.ts:110`): export it. Graph import does not exist in `contacts/import.ts`; add a trusted server-read entry point, never reinterpret uploaded Entra links as proof. `CUSTOM_EXECUTORS` lives in `orgMergeCustomExecutors.ts:1150`, imported by `orgMerge.ts:49`.
- Add `fence_override_until` (required by spec rejection prose but omitted from its column table). Two scalar publication markers, `delivery_published_at` and `rejection_notified_at`, make the verification row itself the durable outbox; include them in export. A worker retries unmarked committed rows. In-app/incident/timeline writes are deduplicated; external email is at-least-once across provider-success/process-crash, because the current email API has no provider idempotency contract. Do not claim exactly-once SMTP.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-15-180000-caller-verification-tables.sql` | Six enums; bindings, destinations, verifications; FKs/RLS/indexes |
| `apps/api/migrations/2026-10-15-180100-caller-verification-policies.sql` | Nullable policy fields, XOR, owner uniques, dual-axis RLS |
| `apps/api/migrations/2026-10-15-180200-caller-verification-destinations-backfill.sql` | Conservative scoped provenance backfill |
| `apps/api/src/db/schema/callerVerification.ts`, `callerVerification.test.ts` | Tables/enums, relationship/name tests |
| `apps/api/src/db/schema/index.ts` | Public Drizzle exports |
| `apps/api/src/services/tenantCascade.ts`, `tenantExportPolicyRegistry.ts`, `orgMergeRegistry.ts` | Complete registrations |
| `apps/api/src/services/orgMergeCustomExecutors.ts`, `orgMerge.ts` | Resolve collisions before moves; expire/revoke after moves |
| `apps/api/src/services/callerVerification/{types,errors,locks,policy,tiers,subjects,destinations,service,gate,rejection,index}.ts` | Cross-wave contract modules |
| `apps/api/src/services/callerVerification/{access,ports,effects,merge,testing}.ts` | Explicit new internal helpers; testing is test-only |
| `apps/api/src/services/callerVerification/{directory,loginObservation}.ts`, `{directory,loginObservation}.test.ts` | Task 8: Graph picker, reachable sync/reconciliation and independent session evidence |
| `agent/internal/collectors/sessions.go`, `sessions_test.go`, `session_principal_windows.go`, `session_principal_unix.go` | Task 8: authenticated OS principal telemetry and retry preservation |
| `apps/api/src/routes/agents/{schemas,sessions}.ts`, `sessions.test.ts` | Task 8: authenticated session ingestion and device/org-bound observation |
| `apps/api/src/services/callerVerification/deviceMove.ts`, `deviceMove.test.ts`, `apps/api/src/routes/devices/moveOrg.ts`, `moveOrg.test.ts` | Task 13: original-org workstation revocation inside move transaction |
| `apps/api/src/routes/config.ts`, `config.test.ts` | Task 14: server readiness response consumed by W04 |
| `apps/api/src/middleware/selfManagedDbContextRoutes.ts`, `selfManagedDbContextRoutes.test.ts` | Task 14: short DB scopes around Graph search, sync and attestation |
| `apps/api/src/services/callerVerification/{locks,policy,tiers,subjects,destinations,service,gate,rejection,merge,writers,readiness}.test.ts` | Unit and source-contract coverage |
| `apps/api/src/services/actionIntents/revokeIntentsForSubject.ts` | W05 replacement seam, returns empty arrays in W01 |
| `apps/api/src/services/contacts/{crud,compat,import}.ts`, `types.ts` | Destination provenance and trusted directory entry point |
| `apps/api/src/routes/orgContacts.ts`, `services/inboundEmail/resolveOrg.ts`, `services/aiToolsOrgs.ts` | Writer source and site-reach integration |
| `apps/api/src/services/contacts/import.test.ts` | Uploaded Entra links never create bindings |
| `packages/shared/src/validators/callerVerification.ts`, `callerVerification.test.ts`, `index.ts` | Shared request schemas |
| `apps/api/src/routes/callerVerification.ts`, `callerVerification.test.ts`, `apps/api/src/index.ts` | Authenticated router and actual root mount |
| `apps/api/src/services/ticketService.ts`, `ticketEvents.ts` | Transactional system comment + ID-only verification event/outbox |
| `apps/api/src/jobs/callerVerificationPublisher.ts`, `services/workerRegistry.ts` | Post-commit publication/retry lifecycle |
| `apps/api/src/config/{env,validate}.ts`, `.env.example`, `docker-compose.yml`, `deploy/docker-compose.prod.yml` | Default-off flag, validation and container pass-through |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` | Both dual-axis allowlists |
| `apps/api/src/__tests__/integration/callerVerification.integration.test.ts` | Task 15: RLS/FKs, merge/deletion/races, live authenticated route matrix, projections, sync/login/move, admin cap/audit and decision/receipt rollback |

### Task 1: Create the three evidence tables and enums

**Files:** Create `apps/api/migrations/2026-10-15-180000-caller-verification-tables.sql`; Create `apps/api/src/db/schema/callerVerification.test.ts` (migration assertions first).

**Interfaces:** Consumes `contacts(id,org_id)` unique (`schema/contacts.ts:82`), `users(id)`, `device_commands(id)`. Produces the six named enums and three tables from the index, with nullable FK references after erasure.

- [ ] **Step 1: Write the failing migration contract test.** Create the issue-derived implementation branch before edits (the wave issue supplies both numbers):

```bash
: "${CALLER_PARENT_ISSUE:?Set the parent issue number from the wave issue}"
: "${CALLER_WAVE_ISSUE:?Set the W01 issue number from the wave issue}"
git switch -c "feature/${CALLER_PARENT_ISSUE}-caller-verification/wave-${CALLER_WAVE_ISSUE}"
```


```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const migration = () => readFileSync(new URL('../../../migrations/2026-10-15-180000-caller-verification-tables.sql', import.meta.url), 'utf8');
describe('caller verification migration', () => {
  it('uses column-specific nullable references and deferrable ownership', () => {
    const s = migration();
    for (const col of ['requester_binding_id', 'target_binding_id', 'destination_id'])
      expect(s).toContain(`ON DELETE SET NULL (${col}) DEFERRABLE INITIALLY IMMEDIATE`);
    expect(s).not.toMatch(/\b(device_id|ticket_id)\s+uuid/i);
    expect(s).toContain("WHERE revoked_at IS NULL");
    expect(s).toContain("WHERE status='verified' AND consumed_at IS NULL");
    expect(s).toContain('FORCE ROW LEVEL SECURITY');
  });
});
```

- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/db/schema/callerVerification.test.ts`. Expected: ENOENT for the reserved migration.
- [ ] **Step 3: Write the migration.** All constraints inside CREATE TABLE are idempotent because the table creation itself is guarded; indexes/policies are separately replayable.

```sql
DO $$ BEGIN CREATE TYPE caller_verification_method AS ENUM
 ('workstation','sms','email','callback_attestation','administrative_stepup');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE caller_verification_status AS ENUM
 ('pending','verified','rejected_by_user','wrong_choice','expired','undeliverable','cancelled','revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE caller_verification_action_scope AS ENUM ('reset_password','disable_user','any');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE caller_verification_binding_source AS ENUM ('directory_sync','technician_attested','observed_login');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE caller_verification_destination_kind AS ENUM ('email','mobile');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE caller_verification_destination_source AS ENUM
 ('technician','import','inbound_email','ai_tool','portal_self_service');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS caller_verification_subject_bindings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id),
 contact_id uuid NOT NULL, entra_tenant_id varchar(64), entra_oid varchar(64), upn_snapshot varchar(320),
 os_principal varchar(255), os_username varchar(255), source caller_verification_binding_source NOT NULL,
 established_at timestamptz NOT NULL DEFAULT now(), attested_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 attested_at timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT cv_bindings_contact_org_fk FOREIGN KEY(contact_id,org_id) REFERENCES contacts(id,org_id)
  ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT cv_bindings_entra_pair_chk CHECK ((entra_tenant_id IS NULL) = (entra_oid IS NULL)),
 CONSTRAINT cv_bindings_identity_chk CHECK (entra_oid IS NOT NULL OR os_principal IS NOT NULL),
 CONSTRAINT cv_bindings_id_org_uq UNIQUE(id,org_id),
 CONSTRAINT cv_bindings_id_contact_org_uq UNIQUE(id,contact_id,org_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS cv_bindings_entra_active_uq
 ON caller_verification_subject_bindings(org_id,entra_tenant_id,entra_oid) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cv_bindings_os_active_uq
 ON caller_verification_subject_bindings(org_id,os_principal) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS caller_verification_destinations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id), contact_id uuid NOT NULL,
 kind caller_verification_destination_kind NOT NULL, value_hash char(64) NOT NULL, value_redacted varchar(64) NOT NULL,
 set_at timestamptz NOT NULL DEFAULT now(), superseded_at timestamptz,
 set_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 source caller_verification_destination_source NOT NULL,
 attested_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL, attested_at timestamptz,
 CONSTRAINT cv_destinations_contact_org_fk FOREIGN KEY(contact_id,org_id) REFERENCES contacts(id,org_id)
  ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT cv_destinations_id_org_uq UNIQUE(id,org_id),
 CONSTRAINT cv_destinations_id_contact_org_uq UNIQUE(id,contact_id,org_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS cv_destinations_current_uq ON caller_verification_destinations(contact_id,kind)
 WHERE superseded_at IS NULL;
CREATE TABLE IF NOT EXISTS caller_verifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES organizations(id), contact_id uuid NOT NULL,
 requester_binding_id uuid, target_binding_id uuid, target_entra_tenant_id varchar(64), target_entra_oid varchar(64),
 initiated_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, technician_label varchar(255) NOT NULL,
 action_scope caller_verification_action_scope NOT NULL, target_label varchar(320),
 method caller_verification_method NOT NULL, reason text, stepup_session_id text, stepup_auth_epoch integer,
 stepup_mfa_epoch integer, stepup_verified_at timestamptz,
 status caller_verification_status NOT NULL DEFAULT 'pending', tier smallint NOT NULL CONSTRAINT cv_tier_chk CHECK(tier BETWEEN 0 AND 3),
 tier_reason varchar(64) NOT NULL, match_value char(2) NOT NULL, decoy_values char(2)[] NOT NULL,
 reverse_code char(4) NOT NULL, challenge_token_hash char(64), destination_id uuid, destination_redacted varchar(64),
 workstation_device_ref uuid, device_hostname varchar(255), os_username varchar(255), os_principal_observed varchar(255),
 agent_command_id uuid REFERENCES device_commands(id) ON DELETE SET NULL, ticket_ref uuid, ticket_number varchar(32),
 attempt_no smallint NOT NULL CONSTRAINT cv_attempt_chk CHECK(attempt_no > 0), expires_at timestamptz NOT NULL,
 decided_at timestamptz, decided_from_ip inet, consumed_intent_ref uuid, consumed_at timestamptz, attestation_note text,
 fence_override_until timestamptz, delivery_published_at timestamptz, rejection_notified_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT cv_contact_org_fk FOREIGN KEY(contact_id,org_id) REFERENCES contacts(id,org_id)
  ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT cv_requester_fk FOREIGN KEY(requester_binding_id,contact_id,org_id)
  REFERENCES caller_verification_subject_bindings(id,contact_id,org_id)
  ON DELETE SET NULL (requester_binding_id) DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT cv_target_fk FOREIGN KEY(target_binding_id,org_id) REFERENCES caller_verification_subject_bindings(id,org_id)
  ON DELETE SET NULL (target_binding_id) DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT cv_destination_fk FOREIGN KEY(destination_id,contact_id,org_id)
  REFERENCES caller_verification_destinations(id,contact_id,org_id)
  ON DELETE SET NULL (destination_id) DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT cv_id_org_uq UNIQUE(id,org_id), CONSTRAINT cv_id_contact_org_uq UNIQUE(id,contact_id,org_id),
 CONSTRAINT cv_choices_chk CHECK (match_value ~ '^[0-9]{2}$' AND cardinality(decoy_values)=2 AND array_position(decoy_values,NULL) IS NULL
  AND decoy_values[1] ~ '^[0-9]{2}$' AND decoy_values[2] ~ '^[0-9]{2}$'
  AND match_value <> ALL(decoy_values) AND decoy_values[1] <> decoy_values[2] AND reverse_code ~ '^[0-9]{4}$'),
 CONSTRAINT cv_admin_chk CHECK(method <> 'administrative_stepup' OR
  (action_scope='disable_user' AND reason IS NOT NULL AND length(btrim(reason)) >= 20 AND stepup_session_id IS NOT NULL
   AND stepup_auth_epoch IS NOT NULL AND stepup_mfa_epoch IS NOT NULL AND stepup_verified_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS cv_contact_history_idx ON caller_verifications(org_id,contact_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS cv_token_uq ON caller_verifications(challenge_token_hash) WHERE challenge_token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cv_command_uq ON caller_verifications(agent_command_id) WHERE agent_command_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cv_gate_idx ON caller_verifications(contact_id,status,consumed_at)
 WHERE status='verified' AND consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS cv_target_idx ON caller_verifications(org_id,target_binding_id,created_at DESC);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['caller_verification_subject_bindings','caller_verification_destinations','caller_verifications'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation ON %I',t);
  EXECUTE format('CREATE POLICY breeze_org_isolation ON %I FOR ALL USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id))',t);
 END LOOP;
END $$;
```

- [ ] **Step 4:** Run `cd apps/api && npx vitest run src/db/schema/callerVerification.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`. Expected: PASS; live constraints are exercised in Task 15, not inferred from regex tests.
- [ ] **Step 5: Commit.**

```bash
ls apps/api/migrations | sort | tail -1
git add apps/api/migrations/2026-10-15-180000-caller-verification-tables.sql apps/api/src/db/schema/callerVerification.test.ts
git commit -m "feat(caller-verification): add evidence tables and ownership constraints"
```

### Task 2: Nullable policies and conservative destination backfill

**Files:** Create `apps/api/migrations/2026-10-15-180100-caller-verification-policies.sql`, `apps/api/migrations/2026-10-15-180200-caller-verification-destinations-backfill.sql`; Modify `apps/api/src/db/schema/callerVerification.test.ts` (Task 1 creation, add policy/backfill assertions after its describe block).

**Interfaces:** Consumes `breeze_current_partner_id()` and policy template `apps/api/migrations/2026-10-05-110000-config-policy-partner-wide-select.sql:86`. Produces nullable inheritance fields, owner XOR and import-sourced historical destinations.

- [ ] **Step 1: Add the failing tests.**

```ts
it('separates partner read from write authority and elects scope before backfill', () => {
  const read = (name: string) => readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8');
  const p = read('2026-10-15-180100-caller-verification-policies.sql');
  expect(p).toContain('FOR SELECT USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id())');
  expect(p).toContain('((org_id IS NULL) <> (partner_id IS NULL))');
  expect(p).not.toMatch(/required_tier_reset_password\s+smallint\s+NOT NULL/i);
  const b = read('2026-10-15-180200-caller-verification-destinations-backfill.sql');
  expect(b.trimStart().startsWith("SELECT set_config('breeze.scope','system',true);")).toBe(true);
  expect(b).toContain('RAISE WARNING');
});
```

- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/db/schema/callerVerification.test.ts`. Expected: ENOENT for policies.
- [ ] **Step 3: Implement the two files in order.**

```sql
CREATE TABLE IF NOT EXISTS caller_verification_policies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid REFERENCES organizations(id), partner_id uuid REFERENCES partners(id),
 required_tier_reset_password smallint CONSTRAINT cv_policy_reset_tier_chk CHECK(required_tier_reset_password BETWEEN 0 AND 3),
 required_tier_disable_user smallint CONSTRAINT cv_policy_disable_tier_chk CHECK(required_tier_disable_user BETWEEN 0 AND 3),
 disable_user_authorizer_roles text[], verification_ttl_minutes integer CONSTRAINT cv_policy_ttl_chk CHECK(verification_ttl_minutes BETWEEN 5 AND 240),
 allowed_methods text[] CONSTRAINT cv_policy_methods_chk CHECK(allowed_methods <@ ARRAY['workstation','sms','email','callback_attestation']::text[]),
 workstation_timeout_seconds integer CONSTRAINT cv_policy_timeout_chk CHECK(workstation_timeout_seconds BETWEEN 30 AND 300),
 destination_min_age_days integer CONSTRAINT cv_policy_age_chk CHECK(destination_min_age_days BETWEEN 0 AND 90),
 require_attested_destination boolean, require_ticket boolean, allow_cross_technician_use boolean,
 allow_administrative_disable boolean, max_attempts_per_hour smallint CONSTRAINT cv_policy_attempts_chk CHECK(max_attempts_per_hour BETWEEN 1 AND 100),
 cooling_off_hours integer CONSTRAINT cv_policy_cooling_chk CHECK(cooling_off_hours BETWEEN 1 AND 720),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 CONSTRAINT caller_verification_policies_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL)),
 CONSTRAINT cv_policy_org_uq UNIQUE(org_id), CONSTRAINT cv_policy_partner_uq UNIQUE(partner_id)
);
ALTER TABLE caller_verification_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE caller_verification_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cv_policy_owner ON caller_verification_policies;
CREATE POLICY cv_policy_owner ON caller_verification_policies FOR ALL
 USING (public.breeze_current_scope()='system' OR public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id))
 WITH CHECK (public.breeze_current_scope()='system' OR public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
DROP POLICY IF EXISTS cv_policy_partner_select ON caller_verification_policies;
CREATE POLICY cv_policy_partner_select ON caller_verification_policies
 FOR SELECT USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());
```

The next block is the entire `180200` file. Normalize email with trim/lower and mobile by stripping formatting. Preserve one provenance row for every nonblank legacy value, including malformed legacy values; `attestDestination` and method availability reject unusable addresses/numbers until corrected. Never guess a mobile country code. SHA-256 uses built-in `sha256(bytea)`/`encode`, not an assumed extension.

```sql
SELECT set_config('breeze.scope','system',true);
DO $$ DECLARE n bigint; BEGIN
 INSERT INTO caller_verification_destinations(org_id,contact_id,kind,value_hash,value_redacted,set_at,source)
 SELECT c.org_id,c.id,v.kind::caller_verification_destination_kind,
  encode(sha256(convert_to(v.value,'UTF8')),'hex'),
  CASE WHEN v.kind='email' THEN left(left(v.value,1)||'***@'||split_part(v.value,'@',2),64)
       ELSE '+***'||right(v.value,2) END,
  c.updated_at,'import'
 FROM contacts c CROSS JOIN LATERAL (VALUES
  ('email',nullif(lower(btrim(c.email)),'')),
  ('mobile',nullif(regexp_replace(c.mobile,'[[:space:]().-]','','g'),''))) v(kind,value)
 WHERE v.value IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM caller_verification_destinations d WHERE d.contact_id=c.id AND d.kind=v.kind::caller_verification_destination_kind)
 ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS n = ROW_COUNT;
 RAISE WARNING 'caller verification destinations backfilled: %',n;
END $$;
```

- [ ] **Step 4:** Run `cd apps/api && npx vitest run src/db/schema/callerVerification.test.ts src/db/migrationRlsScope.test.ts`. Expected: PASS. Task 15 replays DML and verifies it does not reset ages or attestations.
- [ ] **Step 5: Commit.**

```bash
ls apps/api/migrations | sort | tail -1
git add apps/api/migrations/2026-10-15-180100-caller-verification-policies.sql apps/api/migrations/2026-10-15-180200-caller-verification-destinations-backfill.sql apps/api/src/db/schema/callerVerification.test.ts
git commit -m "feat(caller-verification): add inherited policies and destination backfill"
```

### Task 3: Drizzle schema and every tenant registration

**Files:** Create `apps/api/src/db/schema/callerVerification.ts`; Modify `apps/api/src/db/schema/index.ts:150`, `apps/api/src/db/schema/callerVerification.test.ts` (Task 1 creation), `apps/api/src/services/tenantCascade.ts:347`, `apps/api/src/services/tenantExportPolicyRegistry.ts:41`, `apps/api/src/services/orgMergeRegistry.ts:126,536`, `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:315,587`.

**Interfaces:** Produces `callerVerifications`, `callerVerificationSubjectBindings`, `callerVerificationDestinations`, `callerVerificationPolicies`, all six `callerVerification*Enum` exports, and `BindingRow`, `DestinationRow`, `PolicyRow`, `VerificationRow` inferred types. Consumes `getTableConfig` for the static name contract.

- [ ] **Step 1: Extend the schema test.**

```ts
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as cv from './callerVerification';
it('exports all four tables without walker-discovered snapshot columns', () => {
  for (const table of [cv.callerVerifications, cv.callerVerificationSubjectBindings, cv.callerVerificationDestinations, cv.callerVerificationPolicies]) {
    const names = getTableConfig(table).columns.map(c => c.name);
    expect(names).not.toContain('device_id'); expect(names).not.toContain('ticket_id');
  }
  const names = getTableConfig(cv.callerVerifications).columns.map(c => c.name);
  expect(names).toEqual(expect.arrayContaining(['stepup_auth_epoch','consumed_at','fence_override_until','ticket_ref','workstation_device_ref']));
});
```

- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/db/schema/callerVerification.test.ts`. Expected: missing schema module.
- [ ] **Step 3: Implement the schema.** SQL remains authoritative for DEFERRABLE and column-specific SET NULL, as in `schema/aiOperatorTasks.ts:336`. Do not add single-column FKs in place of composites.

```ts
import { sql } from 'drizzle-orm';
import { pgTable, pgEnum, uuid, varchar, char, text, timestamp, smallint, integer, boolean, inet, foreignKey, unique, uniqueIndex, index, check } from 'drizzle-orm/pg-core';
import { contacts } from './contacts';
import { organizations, partners } from './orgs';
import { users } from './users';
import { deviceCommands } from './devices';
export const callerVerificationMethodEnum = pgEnum('caller_verification_method',['workstation','sms','email','callback_attestation','administrative_stepup']);
export const callerVerificationStatusEnum = pgEnum('caller_verification_status',['pending','verified','rejected_by_user','wrong_choice','expired','undeliverable','cancelled','revoked']);
export const callerVerificationActionScopeEnum = pgEnum('caller_verification_action_scope',['reset_password','disable_user','any']);
export const callerVerificationBindingSourceEnum = pgEnum('caller_verification_binding_source',['directory_sync','technician_attested','observed_login']);
export const callerVerificationDestinationKindEnum = pgEnum('caller_verification_destination_kind',['email','mobile']);
export const callerVerificationDestinationSourceEnum = pgEnum('caller_verification_destination_source',['technician','import','inbound_email','ai_tool','portal_self_service']);
const time = (name: string) => timestamp(name,{withTimezone:true});
export const callerVerificationSubjectBindings = pgTable('caller_verification_subject_bindings', {
 id:uuid('id').primaryKey().defaultRandom(), orgId:uuid('org_id').notNull().references(()=>organizations.id), contactId:uuid('contact_id').notNull(),
 entraTenantId:varchar('entra_tenant_id',{length:64}), entraOid:varchar('entra_oid',{length:64}), upnSnapshot:varchar('upn_snapshot',{length:320}),
 osPrincipal:varchar('os_principal',{length:255}), osUsername:varchar('os_username',{length:255}), source:callerVerificationBindingSourceEnum('source').notNull(),
 establishedAt:time('established_at').notNull().defaultNow(), attestedByUserId:uuid('attested_by_user_id').references(()=>users.id,{onDelete:'set null'}),
 attestedAt:time('attested_at'), revokedAt:time('revoked_at'), createdAt:time('created_at').notNull().defaultNow(), updatedAt:time('updated_at').notNull().defaultNow(),
},t=>[
 foreignKey({name:'cv_bindings_contact_org_fk',columns:[t.contactId,t.orgId],foreignColumns:[contacts.id,contacts.orgId]}).onDelete('cascade'),
 unique('cv_bindings_id_org_uq').on(t.id,t.orgId), unique('cv_bindings_id_contact_org_uq').on(t.id,t.contactId,t.orgId),
 uniqueIndex('cv_bindings_entra_active_uq').on(t.orgId,t.entraTenantId,t.entraOid).where(sql`${t.revokedAt} IS NULL`),
 uniqueIndex('cv_bindings_os_active_uq').on(t.orgId,t.osPrincipal).where(sql`${t.revokedAt} IS NULL`),
 check('cv_bindings_entra_pair_chk',sql`(${t.entraTenantId} IS NULL) = (${t.entraOid} IS NULL)`),
 check('cv_bindings_identity_chk',sql`${t.entraOid} IS NOT NULL OR ${t.osPrincipal} IS NOT NULL`),
]);
export const callerVerificationDestinations = pgTable('caller_verification_destinations', {
 id:uuid('id').primaryKey().defaultRandom(), orgId:uuid('org_id').notNull().references(()=>organizations.id), contactId:uuid('contact_id').notNull(),
 kind:callerVerificationDestinationKindEnum('kind').notNull(), valueHash:char('value_hash',{length:64}).notNull(), valueRedacted:varchar('value_redacted',{length:64}).notNull(),
 setAt:time('set_at').notNull().defaultNow(), supersededAt:time('superseded_at'), setByUserId:uuid('set_by_user_id').references(()=>users.id,{onDelete:'set null'}),
 source:callerVerificationDestinationSourceEnum('source').notNull(), attestedByUserId:uuid('attested_by_user_id').references(()=>users.id,{onDelete:'set null'}), attestedAt:time('attested_at'),
},t=>[
 foreignKey({name:'cv_destinations_contact_org_fk',columns:[t.contactId,t.orgId],foreignColumns:[contacts.id,contacts.orgId]}).onDelete('cascade'),
 unique('cv_destinations_id_org_uq').on(t.id,t.orgId), unique('cv_destinations_id_contact_org_uq').on(t.id,t.contactId,t.orgId),
 uniqueIndex('cv_destinations_current_uq').on(t.contactId,t.kind).where(sql`${t.supersededAt} IS NULL`),
]);
export const callerVerifications = pgTable('caller_verifications', {
 id:uuid('id').primaryKey().defaultRandom(), orgId:uuid('org_id').notNull().references(()=>organizations.id), contactId:uuid('contact_id').notNull(),
 requesterBindingId:uuid('requester_binding_id'), targetBindingId:uuid('target_binding_id'), targetEntraTenantId:varchar('target_entra_tenant_id',{length:64}), targetEntraOid:varchar('target_entra_oid',{length:64}),
 initiatedByUserId:uuid('initiated_by_user_id').notNull().references(()=>users.id,{onDelete:'restrict'}), technicianLabel:varchar('technician_label',{length:255}).notNull(),
 actionScope:callerVerificationActionScopeEnum('action_scope').notNull(), targetLabel:varchar('target_label',{length:320}), method:callerVerificationMethodEnum('method').notNull(),
 reason:text('reason'), stepupSessionId:text('stepup_session_id'), stepupAuthEpoch:integer('stepup_auth_epoch'), stepupMfaEpoch:integer('stepup_mfa_epoch'), stepupVerifiedAt:time('stepup_verified_at'),
 status:callerVerificationStatusEnum('status').notNull().default('pending'), tier:smallint('tier').notNull(), tierReason:varchar('tier_reason',{length:64}).notNull(),
 matchValue:char('match_value',{length:2}).notNull(), decoyValues:char('decoy_values',{length:2}).array().notNull(), reverseCode:char('reverse_code',{length:4}).notNull(), challengeTokenHash:char('challenge_token_hash',{length:64}),
 destinationId:uuid('destination_id'), destinationRedacted:varchar('destination_redacted',{length:64}), workstationDeviceRef:uuid('workstation_device_ref'), deviceHostname:varchar('device_hostname',{length:255}),
 osUsername:varchar('os_username',{length:255}), osPrincipalObserved:varchar('os_principal_observed',{length:255}), agentCommandId:uuid('agent_command_id').references(()=>deviceCommands.id,{onDelete:'set null'}),
 ticketRef:uuid('ticket_ref'), ticketNumber:varchar('ticket_number',{length:32}), attemptNo:smallint('attempt_no').notNull(), expiresAt:time('expires_at').notNull(), decidedAt:time('decided_at'), decidedFromIp:inet('decided_from_ip'),
 consumedIntentRef:uuid('consumed_intent_ref'), consumedAt:time('consumed_at'), attestationNote:text('attestation_note'), fenceOverrideUntil:time('fence_override_until'),
 deliveryPublishedAt:time('delivery_published_at'), rejectionNotifiedAt:time('rejection_notified_at'), createdAt:time('created_at').notNull().defaultNow(),
},t=>[
 foreignKey({name:'cv_contact_org_fk',columns:[t.contactId,t.orgId],foreignColumns:[contacts.id,contacts.orgId]}).onDelete('cascade'),
 foreignKey({name:'cv_requester_fk',columns:[t.requesterBindingId,t.contactId,t.orgId],foreignColumns:[callerVerificationSubjectBindings.id,callerVerificationSubjectBindings.contactId,callerVerificationSubjectBindings.orgId]}).onDelete('set null'),
 foreignKey({name:'cv_target_fk',columns:[t.targetBindingId,t.orgId],foreignColumns:[callerVerificationSubjectBindings.id,callerVerificationSubjectBindings.orgId]}).onDelete('set null'),
 foreignKey({name:'cv_destination_fk',columns:[t.destinationId,t.contactId,t.orgId],foreignColumns:[callerVerificationDestinations.id,callerVerificationDestinations.contactId,callerVerificationDestinations.orgId]}).onDelete('set null'),
 unique('cv_id_org_uq').on(t.id,t.orgId), unique('cv_id_contact_org_uq').on(t.id,t.contactId,t.orgId),
 index('cv_contact_history_idx').on(t.orgId,t.contactId,t.createdAt.desc()), index('cv_target_idx').on(t.orgId,t.targetBindingId,t.createdAt.desc()),
 uniqueIndex('cv_token_uq').on(t.challengeTokenHash).where(sql`${t.challengeTokenHash} IS NOT NULL`), uniqueIndex('cv_command_uq').on(t.agentCommandId).where(sql`${t.agentCommandId} IS NOT NULL`),
 index('cv_gate_idx').on(t.contactId,t.status,t.consumedAt).where(sql`${t.status}='verified' AND ${t.consumedAt} IS NULL`),
 check('cv_tier_chk',sql`${t.tier} BETWEEN 0 AND 3`), check('cv_attempt_chk',sql`${t.attemptNo}>0`),
 check('cv_choices_chk',sql`${t.matchValue} ~ '^[0-9]{2}$' AND cardinality(${t.decoyValues})=2 AND array_position(${t.decoyValues},NULL) IS NULL AND ${t.decoyValues}[1] ~ '^[0-9]{2}$' AND ${t.decoyValues}[2] ~ '^[0-9]{2}$' AND ${t.matchValue} <> ALL(${t.decoyValues}) AND ${t.decoyValues}[1] <> ${t.decoyValues}[2] AND ${t.reverseCode} ~ '^[0-9]{4}$'`),
 check('cv_admin_chk',sql`${t.method} <> 'administrative_stepup' OR (${t.actionScope}='disable_user' AND ${t.reason} IS NOT NULL AND length(btrim(${t.reason}))>=20 AND ${t.stepupSessionId} IS NOT NULL AND ${t.stepupAuthEpoch} IS NOT NULL AND ${t.stepupMfaEpoch} IS NOT NULL AND ${t.stepupVerifiedAt} IS NOT NULL)`),
]);
export const callerVerificationPolicies = pgTable('caller_verification_policies', {
 id:uuid('id').primaryKey().defaultRandom(), orgId:uuid('org_id').references(()=>organizations.id), partnerId:uuid('partner_id').references(()=>partners.id),
 requiredTierResetPassword:smallint('required_tier_reset_password'), requiredTierDisableUser:smallint('required_tier_disable_user'), disableUserAuthorizerRoles:text('disable_user_authorizer_roles').array(),
 verificationTtlMinutes:integer('verification_ttl_minutes'), allowedMethods:text('allowed_methods').array(), workstationTimeoutSeconds:integer('workstation_timeout_seconds'), destinationMinAgeDays:integer('destination_min_age_days'),
 requireAttestedDestination:boolean('require_attested_destination'), requireTicket:boolean('require_ticket'), allowCrossTechnicianUse:boolean('allow_cross_technician_use'), allowAdministrativeDisable:boolean('allow_administrative_disable'),
 maxAttemptsPerHour:smallint('max_attempts_per_hour'), coolingOffHours:integer('cooling_off_hours'), createdAt:time('created_at').notNull().defaultNow(), updatedAt:time('updated_at').notNull().defaultNow(), updatedByUserId:uuid('updated_by_user_id').references(()=>users.id,{onDelete:'set null'}),
},t=>[
 unique('cv_policy_org_uq').on(t.orgId),unique('cv_policy_partner_uq').on(t.partnerId),
 check('caller_verification_policies_one_owner_chk',sql`(${t.orgId} IS NULL) <> (${t.partnerId} IS NULL)`),
 check('cv_policy_reset_tier_chk',sql`${t.requiredTierResetPassword} BETWEEN 0 AND 3`),check('cv_policy_disable_tier_chk',sql`${t.requiredTierDisableUser} BETWEEN 0 AND 3`),
 check('cv_policy_ttl_chk',sql`${t.verificationTtlMinutes} BETWEEN 5 AND 240`),check('cv_policy_timeout_chk',sql`${t.workstationTimeoutSeconds} BETWEEN 30 AND 300`),
 check('cv_policy_age_chk',sql`${t.destinationMinAgeDays} BETWEEN 0 AND 90`),check('cv_policy_attempts_chk',sql`${t.maxAttemptsPerHour} BETWEEN 1 AND 100`),
 check('cv_policy_cooling_chk',sql`${t.coolingOffHours} BETWEEN 1 AND 720`),check('cv_policy_methods_chk',sql`${t.allowedMethods} <@ ARRAY['workstation','sms','email','callback_attestation']::text[]`),
]);
export type BindingRow = typeof callerVerificationSubjectBindings.$inferSelect;
export type DestinationRow = typeof callerVerificationDestinations.$inferSelect;
export type PolicyRow = typeof callerVerificationPolicies.$inferSelect;
export type VerificationRow = typeof callerVerifications.$inferSelect;
```

Append `export * from './callerVerification';` to schema/index.ts. Register these exact values (each list entry includes its trailing comma):

```ts
// tenantCascade.ts CORE_ORG_CASCADE_DELETE_ORDER, alphabetical storage order:
'caller_verification_destinations', 'caller_verification_policies',
'caller_verification_subject_bindings', 'caller_verifications',
// orgMergeRegistry.ts SPECIAL entries:
caller_verification_subject_bindings: { kind: 'custom', note: 'Revoke both colliding identities before repoint; expire loser grants after move.' },
caller_verification_policies: { kind: 'keep-survivor' },
// REPOINT_TABLES:
'caller_verification_destinations', 'caller_verifications',
// Both DUAL_AXIS_TENANT_TABLES and XOR_OWNERSHIP_DUAL_AXIS_TABLES:
'caller_verification_policies',
```

The verified registry discriminant is `kind` (`orgMergeRegistry.ts:22`); `keep-survivor` takes no note. Do not add duplicate entries. Export entries enumerate every physical column, including the explicit scalar additions:

```ts
caller_verification_subject_bindings: tablePolicy('org_id', { included: ['id','org_id','contact_id','entra_tenant_id','entra_oid','upn_snapshot','os_principal','os_username','source','established_at','attested_by_user_id','attested_at','revoked_at','created_at','updated_at'], reviewedIncluded: [], excludedSensitive: [], excludedOpen: [] }),
caller_verification_destinations: tablePolicy('org_id', { included: ['id','org_id','contact_id','kind','value_redacted','set_at','superseded_at','set_by_user_id','source','attested_by_user_id','attested_at'], reviewedIncluded: [], excludedSensitive: ['value_hash'], excludedOpen: [] }),
caller_verifications: tablePolicy('org_id', {
 included: ['id','org_id','contact_id','requester_binding_id','target_binding_id','target_entra_tenant_id','target_entra_oid','initiated_by_user_id','technician_label','action_scope','target_label','method','reason','stepup_session_id','stepup_auth_epoch','stepup_verified_at','status','tier','tier_reason','destination_id','destination_redacted','workstation_device_ref','device_hostname','os_username','os_principal_observed','agent_command_id','ticket_ref','ticket_number','attempt_no','expires_at','decided_at','decided_from_ip','consumed_intent_ref','consumed_at','attestation_note','fence_override_until','delivery_published_at','rejection_notified_at','created_at'],
 reviewedIncluded: [], excludedSensitive: ['challenge_token_hash','match_value','decoy_values','reverse_code'], excludedOpen: [],
 specific: { stepup_mfa_epoch: { decision:'include',reviewedSensitiveName:true,rationale:'Non-secret MFA epoch snapshot, included per caller-verification spec.' } },
}),
caller_verification_policies: tablePolicy('org_id', { included: ['id','org_id','partner_id','required_tier_disable_user','disable_user_authorizer_roles','verification_ttl_minutes','allowed_methods','workstation_timeout_seconds','destination_min_age_days','require_attested_destination','require_ticket','allow_cross_technician_use','allow_administrative_disable','max_attempts_per_hour','cooling_off_hours','created_at','updated_at','updated_by_user_id'], reviewedIncluded: ['required_tier_reset_password'], excludedSensitive: [], excludedOpen: [] }),
```

`stepup_mfa_epoch` remains included as the spec requires; the `specific` classification adds the review metadata required by the existing suspicious-name guard (`tenantExportPolicy.ts:38`, matching `mfa`).

- [ ] **Step 4:** Run `cd apps/api && npx vitest run src/db/schema/callerVerification.test.ts`. Expected: PASS. Task 16 runs real cascade/export/RLS coverage; no exemption entry is added.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/db/schema/callerVerification.ts apps/api/src/db/schema/callerVerification.test.ts apps/api/src/db/schema/index.ts apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "feat(caller-verification): register schema for isolation export and erasure"
```

### Task 4: Resolve binding collisions before org merge, revoke grants afterward

**Files:** Create `apps/api/src/services/callerVerification/merge.ts`, `apps/api/src/services/callerVerification/merge.test.ts`; Modify `apps/api/src/services/orgMergeCustomExecutors.ts:1150` and its `CUSTOM_RESOLVE_EXECUTORS` map, `apps/api/src/services/orgMerge.ts:1069,1106`.

**Interfaces:** Consumes `CustomMergeExecutor = (loserOrgId: string, survivorOrgId: string) => Promise<MergeTableOutcome>`, where `MergeTableOutcome = { moved: number; dropped: number; notes: string[] }`. Produces `resolveBindingMerge: CustomMergeExecutor`, `moveBindings: CustomMergeExecutor`, `captureLoserContacts(orgId: string): Promise<string[]>`, `finishBindingMerge(ids: string[], survivorOrgId: string): Promise<void>`; all run in the engine's existing system transaction.

- [ ] **Step 1: Write a SQL-sequence unit test.**

```ts
import { it, expect, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const m = vi.hoisted(()=>({execute:vi.fn(),insert:vi.fn()}));
vi.mock('../../db',()=>({db:m,assertInTransaction:vi.fn()}));
import { resolveBindingMerge, finishBindingMerge } from './merge';
it('revokes both sides and preserves consumed grants',async()=>{
 m.execute.mockResolvedValue([]);
 await resolveBindingMerge('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222');
 const first = new PgDialect().sqlToQuery(m.execute.mock.calls[0]![0]).sql;
 expect(first).toContain('UNION'); expect(first).toContain('revoked_at = now()');
 await finishBindingMerge(['33333333-3333-4333-8333-333333333333'],'22222222-2222-4222-8222-222222222222');
 const last = new PgDialect().sqlToQuery(m.execute.mock.calls[1]![0]).sql;
 expect(last).toContain('consumed_at IS NULL'); expect(last).toContain("WHEN status='pending' THEN 'expired'");
});
```

- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/callerVerification/merge.test.ts`. Expected: missing module.
- [ ] **Step 3: Implement helpers and wire both merge phases.**

```ts
import { sql } from 'drizzle-orm';
import { db, assertInTransaction } from '../../db';
import { extractRowCount } from '../../db/rowCount';
import type { CustomMergeExecutor } from '../orgMergeCustomExecutors';
export const resolveBindingMerge: CustomMergeExecutor = async(loser,survivor)=>{
 assertInTransaction('resolveBindingMerge');
 await db.execute(sql`WITH pairs AS (
  SELECT l.id AS l_id,s.id AS s_id FROM caller_verification_subject_bindings l
  JOIN caller_verification_subject_bindings s ON s.org_id=${survivor}::uuid AND s.revoked_at IS NULL
   AND ((l.entra_tenant_id=s.entra_tenant_id AND l.entra_oid=s.entra_oid) OR l.os_principal=s.os_principal)
  WHERE l.org_id=${loser}::uuid AND l.revoked_at IS NULL
 ), conflicts AS (SELECT l_id AS id FROM pairs UNION SELECT s_id FROM pairs), changed AS (
  UPDATE caller_verification_subject_bindings b SET revoked_at = now(),updated_at=now()
  FROM conflicts c WHERE b.id=c.id RETURNING b.*
 ) INSERT INTO audit_logs(org_id,actor_type,actor_id,action,resource_type,resource_id,result,details)
 SELECT org_id,'system','00000000-0000-0000-0000-000000000000','caller_verification.binding_conflict',
 'caller_verification',id,'success',jsonb_build_object('loserOrgId',${loser}::text,'survivorOrgId',${survivor}::text) FROM changed`);
 return {moved:0,dropped:0,notes:[]};
};
export const moveBindings: CustomMergeExecutor = async(loser,survivor)=>({
 moved:extractRowCount(await db.execute(sql`UPDATE caller_verification_subject_bindings SET org_id=${survivor}::uuid WHERE org_id=${loser}::uuid`)),dropped:0,notes:[],
});
export async function captureLoserContacts(orgId:string):Promise<string[]>{
 const rows=await db.execute(sql`SELECT id FROM contacts WHERE org_id=${orgId}::uuid`);
 return (rows as unknown as Array<{id:string}>).map(r=>r.id);
}
export async function finishBindingMerge(ids:string[],survivorOrgId:string):Promise<void>{
 if(!ids.length)return;
 await db.execute(sql`UPDATE caller_verifications SET status=CASE WHEN status='pending' THEN 'expired'::caller_verification_status ELSE 'revoked'::caller_verification_status END
 WHERE contact_id IN (${sql.join(ids.map(id=>sql`${id}::uuid`),sql`,`)})
 AND (status='pending' OR (status='verified' AND consumed_at IS NULL))`);
 // Also revoke survivor grants whose requester/target lost its canonical binding.
 await db.execute(sql`UPDATE caller_verifications v SET status='revoked' WHERE v.org_id=${survivorOrgId}::uuid AND v.status='verified' AND v.consumed_at IS NULL
 AND EXISTS(SELECT 1 FROM caller_verification_subject_bindings b WHERE b.id IN(v.requester_binding_id,v.target_binding_id) AND b.revoked_at IS NOT NULL)`);
}
```

In `orgMergeCustomExecutors.ts`, import `resolveBindingMerge, moveBindings`; add `'caller_verification_subject_bindings': resolveBindingMerge` to `CUSTOM_RESOLVE_EXECUTORS`, and `'caller_verification_subject_bindings': moveBindings` to `CUSTOM_EXECUTORS`. In `orgMerge.ts`, import `captureLoserContacts, finishBindingMerge`; immediately before `const policies = getOrgMergePolicies()` add `const callerContactIds = await captureLoserContacts(loser.id);`; after both complete passes and before `runPostPassFixups`, add `await finishBindingMerge(callerContactIds, survivor.id);`. The entire resolve pass precedes every move, so unique indexes cannot fail before collision revocation. No new transaction or asynchronous audit service is used.

- [ ] **Step 4:** Run `cd apps/api && npx vitest run src/services/callerVerification/merge.test.ts src/services/orgMerge.test.ts src/services/orgMergeCustomExecutors.test.ts`. Expected: PASS; the unit test inspects the first finish UPDATE and the second is scoped to this merge’s survivor. Live merge is in Task 15.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/callerVerification/merge.ts apps/api/src/services/callerVerification/merge.test.ts apps/api/src/services/orgMerge.ts apps/api/src/services/orgMergeCustomExecutors.ts
git commit -m "feat(caller-verification): revoke ambiguous bindings before org merge"
```

### Task 5: Contract types, transaction locks, access and readiness

**Files:** Create `apps/api/src/services/callerVerification/types.ts`, `apps/api/src/services/callerVerification/errors.ts`, `apps/api/src/services/callerVerification/locks.ts`, `apps/api/src/services/callerVerification/access.ts`, `apps/api/src/services/callerVerification/ports.ts`, `apps/api/src/services/callerVerification/locks.test.ts`, `apps/api/src/services/callerVerification/readiness.test.ts`; Modify `apps/api/src/config/env.ts:111`, `apps/api/src/config/validate.ts:626,1814`, `.env.example:1102`, `docker-compose.yml:281`, `deploy/docker-compose.prod.yml:269`.

**Interfaces:** Consumes `assertInTransaction(label: string): void` (`db/index.ts:768`) and transaction-routed `db`. Produces the exact type/error/lock signatures below and explicit injectable future-wave ports. Port defaults refuse, never manufacture assurance.

- [ ] **Step 1: Write failing lock and flag tests.**

```ts
// locks.test.ts
import { expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { withSubjectLocks, type Tx } from './locks';
it('deduplicates and orders both identities before work', async()=>{
 const execute=vi.fn().mockResolvedValue([]), work=vi.fn().mockResolvedValue(42);
 expect(await withSubjectLocks({execute} as unknown as Tx,['b',null,'a','b'],work)).toBe(42);
 expect(execute.mock.calls.map(([q])=>new PgDialect().sqlToQuery(q).params)).toEqual([['a'],['b']]);
 expect(work.mock.invocationCallOrder[0]).toBeGreaterThan(execute.mock.invocationCallOrder[1]!);
});
// readiness.test.ts
import { afterEach, expect, it, vi } from 'vitest';
import { callerVerificationEnabled } from '../../config/env';
afterEach(()=>vi.unstubAllEnvs());
it.each([undefined,'','false','1','yes','TRUE','true'])('exact readiness value %s',value=>{
 vi.stubEnv('CALLER_VERIFICATION_ENABLED',value);
 expect(callerVerificationEnabled()).toBe(value==='true');
});
```

- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/callerVerification/locks.test.ts src/services/callerVerification/readiness.test.ts`. Expected: missing modules/getter.
- [ ] **Step 3: Implement foundational modules.**

```ts
// types.ts
export type CallerVerificationAction = 'reset_password' | 'disable_user';
export type CallerVerificationActionScope = CallerVerificationAction | 'any';
export type CallerVerificationMethod = 'workstation' | 'sms' | 'email' | 'callback_attestation' | 'administrative_stepup';
export type CallerVerificationStatus = 'pending' | 'verified' | 'rejected_by_user' | 'wrong_choice' | 'expired' | 'undeliverable' | 'cancelled' | 'revoked';
export interface EntraSubject { entraTenantId: string; entraOid: string }
export interface CallerVerificationActor { userId: string; partnerId: string | null; scope: 'partner' | 'organization'; accessibleOrgIds: string[] | null; allowedSiteIds: string[] | null; displayName: string }
export type { BindingRow, DestinationRow, PolicyRow, VerificationRow } from '../../db/schema/callerVerification';
export type DestinationSource = 'technician' | 'import' | 'inbound_email' | 'ai_tool' | 'portal_self_service';
// errors.ts
import type { CallerVerificationAction, CallerVerificationStatus, CallerVerificationMethod } from './types';
export type CallerVerificationRefusal =
 | 'no_fresh_verification' | 'grant_consumed' | 'subject_unmatched' | 'subject_ambiguous'
 | 'subject_mailboxes_unknown' | 'tenant_mismatch' | 'contact_fenced' | 'requester_not_authorized'
 | 'technician_mismatch' | 'target_rebound' | 'stepup_invalidated' | 'administrative_disabled' | 'feature_disabled';
export class CallerVerificationRequiredError extends Error {
 constructor(public readonly payload: { orgId: string; contactId: string | null; action: CallerVerificationAction; requiredTier: number; reason: CallerVerificationRefusal; latest: { id: string; status: CallerVerificationStatus; method: CallerVerificationMethod; decidedAt: string | null } | null }) {
  super(payload.reason); this.name='CallerVerificationRequiredError';
 }
}
export class CallerVerificationValidationError extends Error {
 constructor(public readonly code: string, message: string) { super(message); this.name='CallerVerificationValidationError'; }
}
// locks.ts
import { sql } from 'drizzle-orm';
import { db } from '../../db';
export type Tx = Pick<typeof db,'execute'>;
export async function withSubjectLocks<T>(tx: Tx, bindingIds: Array<string | null>, fn: () => Promise<T>): Promise<T> {
 for(const id of [...new Set(bindingIds.filter((id):id is string=>id!==null))].sort())
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${id}))`);
 return fn();
}
export async function lockContact(orgId:string,contactId:string):Promise<void>{
 await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`caller-contact:${orgId}:${contactId}`}))`);
}
// access.ts
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { contacts } from '../../db/schema/contacts';
import type { CallerVerificationActor, BindingRow, CallerVerificationActionScope } from './types';
import { CallerVerificationValidationError as Invalid } from './errors';
export async function reachableContact(actor:CallerVerificationActor,orgId:string,id:string){
 if(actor.accessibleOrgIds!==null&&!actor.accessibleOrgIds.includes(orgId))throw new Invalid('not_found','Contact not found');
 const [row]=await db.select().from(contacts).where(and(eq(contacts.id,id),eq(contacts.orgId,orgId))).limit(1);
 if(!row||(row.siteId!==null&&actor.allowedSiteIds!==null&&!actor.allowedSiteIds.includes(row.siteId)))throw new Invalid('not_found','Contact not found');
 return row;
}
export function requesterAuthorized(action:CallerVerificationActionScope, requester:BindingRow|null,target:BindingRow|null,contact:{siteId:string|null;roles:string[]},roles:string[]):boolean{
 if(action==='any')return requester===null||target===null||requester.id===target.id;
 if(!requester||!target||requester.revokedAt||target.revokedAt)return false;
 if(requester.id===target.id)return true;
 return action==='disable_user'&&contact.siteId===null&&contact.roles.some(r=>roles.includes(r));
}
// ports.ts: new seams, not claims that these adapters already exist.
import type { CallerVerificationActor, EntraSubject, VerificationRow } from './types';
import { CallerVerificationValidationError as Invalid } from './errors';
export interface CallerVerificationPorts {
 mailboxes(input:{orgId:string;target:EntraSubject}):Promise<string[]>;
 administrativeEligible(row:VerificationRow):Promise<boolean>;
 consumeStepUp(actor:CallerVerificationActor,input:{orgId:string;target:EntraSubject;reason:string;stepUpGrantId:string}):Promise<{sid:string;authEpoch:number;mfaEpoch:number}>;
 available(method:'workstation'|'sms'|'email',orgId:string,deviceId?:string):Promise<boolean>;
 prepare(row:VerificationRow,token:string|null):Promise<void>;
 deliver(id:string):Promise<void>;
}
export const callerVerificationPorts:CallerVerificationPorts={
 mailboxes:async()=>{throw new Invalid('subject_mailboxes_unknown','Mailbox read adapter is unavailable');},
 administrativeEligible:async()=>false,
 consumeStepUp:async()=>{throw new Invalid('stepup_invalidated','Interactive step-up adapter is unavailable');},
 available:async()=>false,
 prepare:async()=>{throw new Invalid('method_disabled','Delivery adapter is unavailable');},
 deliver:async()=>{throw new Invalid('method_disabled','Delivery adapter is unavailable');},
};
export function configureCallerVerificationPorts(ports:Partial<CallerVerificationPorts>):void{Object.assign(callerVerificationPorts,ports);}
```

`prepare` is a transaction-only persistence port: W02 creates `device_commands` and stamps `agent_command_id` in it; W03 persists its sealed delivery payload there. It must never send. W01 exposes only callback; absence of a delivery adapter makes links/workstation unavailable even with the readiness flag manually enabled. Never persist clear link tokens in the new tables, audit, or logs.

In `config/env.ts`, add `export function callerVerificationEnabled(): boolean { return process.env.CALLER_VERIFICATION_ENABLED === 'true'; }`. In `envObjectSchema` add `CALLER_VERIFICATION_ENABLED: z.enum(['true','false','']).optional()`. This deliberately tighter flag contract needs no generic boolean superRefine. Add `CALLER_VERIFICATION_ENABLED=false` to `.env.example`; add `CALLER_VERIFICATION_ENABLED: ${CALLER_VERIFICATION_ENABLED:-false}` to both API compose environment maps. Include it in the existing config test's environment cleanup list when testing through that file.

- [ ] **Step 4:** Run `cd apps/api && npx vitest run src/services/callerVerification/locks.test.ts src/services/callerVerification/readiness.test.ts src/config/validate.test.ts src/config/envComposeParity.test.ts`. Expected: PASS, unset/off/invalid values never enable the feature.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/callerVerification/types.ts apps/api/src/services/callerVerification/errors.ts apps/api/src/services/callerVerification/locks.ts apps/api/src/services/callerVerification/access.ts apps/api/src/services/callerVerification/ports.ts apps/api/src/services/callerVerification/locks.test.ts apps/api/src/services/callerVerification/readiness.test.ts apps/api/src/config/env.ts apps/api/src/config/validate.ts .env.example docker-compose.yml deploy/docker-compose.prod.yml
git commit -m "feat(caller-verification): define contracts locks and default-off readiness"
```

### Task 6: Pure baseline-then-tighten policy and tier calculation

**Files:** Create `apps/api/src/services/callerVerification/policy.ts`, `apps/api/src/services/callerVerification/policy.test.ts`, `apps/api/src/services/callerVerification/tiers.ts`, `apps/api/src/services/callerVerification/tiers.test.ts`.

**Interfaces:** `resolveEffectivePolicy(partnerRow: PolicyRow | null, orgRow: PolicyRow | null): EffectiveCallerVerificationPolicy`; `getEffectivePolicy(orgId: string): Promise<EffectiveCallerVerificationPolicy>`; `computeTier(input: { method: CallerVerificationMethod; boundPrincipal: boolean; destinationEstablished: boolean; policy: EffectiveCallerVerificationPolicy }): { tier: 0 | 1 | 2 | 3; reason: 'bound_principal' | 'unbound_principal' | 'destination_established' | 'destination_recent' | 'attestation' | 'administrative' | 'method_disabled' }`.

- [ ] **Step 1: Write tests for partner loosening, org tightening, provenance and all methods.**

```ts
// policy.test.ts
import { expect,it } from 'vitest';
import { resolveEffectivePolicy } from './policy';
import type { PolicyRow } from './types';
const row=(p:Partial<PolicyRow>)=>p as PolicyRow;
it('uses partner as baseline; defaults do not override tier zero',()=>{
 const p=resolveEffectivePolicy(row({requiredTierResetPassword:0}),row({verificationTtlMinutes:240}));
 expect(p.requiredTierResetPassword).toBe(0); expect(p.provenance.requiredTierResetPassword).toBe('partner');
 expect(p.verificationTtlMinutes).toBe(30); expect(p.ignored).toContain('verificationTtlMinutes');
});
it('applies every tightening operator',()=>{
 const p=resolveEffectivePolicy(null,row({requiredTierResetPassword:3,requiredTierDisableUser:3,verificationTtlMinutes:5,workstationTimeoutSeconds:30,destinationMinAgeDays:90,requireAttestedDestination:true,requireTicket:true,allowCrossTechnicianUse:true,allowAdministrativeDisable:false,allowedMethods:['sms'],disableUserAuthorizerRoles:[],maxAttemptsPerHour:1,coolingOffHours:48}));
 expect(p).toMatchObject({requiredTierResetPassword:3,requiredTierDisableUser:3,verificationTtlMinutes:5,workstationTimeoutSeconds:30,destinationMinAgeDays:90,requireAttestedDestination:true,requireTicket:true,allowCrossTechnicianUse:false,allowAdministrativeDisable:false,allowedMethods:['sms'],disableUserAuthorizerRoles:[],maxAttemptsPerHour:1,coolingOffHours:48});
 expect(p.ignored).toEqual(['allowCrossTechnicianUse']);
});
// tiers.test.ts
import { expect,it } from 'vitest';
import { computeTier } from './tiers';
import { resolveEffectivePolicy } from './policy';
it.each(['workstation','sms','email','callback_attestation','administrative_stepup'] as const)('computes %s',method=>{
 const policy=resolveEffectivePolicy(null,null);
 expect(computeTier({method,boundPrincipal:false,destinationEstablished:false,policy}).tier).toBe(method==='administrative_stepup'?3:1);
 expect(computeTier({method,boundPrincipal:true,destinationEstablished:true,policy}).tier).toBe(method==='workstation'||method==='administrative_stepup'?3:method==='callback_attestation'?1:2);
 policy.allowedMethods=[];
 expect(computeTier({method,boundPrincipal:true,destinationEstablished:true,policy}).tier).toBe(method==='administrative_stepup'?3:0);
});
```

- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/callerVerification/policy.test.ts src/services/callerVerification/tiers.test.ts`. Expected: missing modules.
- [ ] **Step 3: Implement all operators; equality retains baseline provenance.** For mixed array requests, intersect and report the field ignored if any requested member was outside the baseline.

```ts
// policy.ts
import { and,eq,isNull,or } from 'drizzle-orm';
import { db } from '../../db';
import { organizations } from '../../db/schema/orgs';
import { callerVerificationPolicies } from '../../db/schema/callerVerification';
import type { PolicyRow } from './types';
export interface EffectiveCallerVerificationPolicy {
 requiredTierResetPassword: number; requiredTierDisableUser: number;
 disableUserAuthorizerRoles: string[]; verificationTtlMinutes: number;
 allowedMethods: Array<'workstation' | 'sms' | 'email' | 'callback_attestation'>;
 workstationTimeoutSeconds: number; destinationMinAgeDays: number;
 requireAttestedDestination: boolean; requireTicket: boolean;
 allowCrossTechnicianUse: boolean; allowAdministrativeDisable: boolean;
 maxAttemptsPerHour: number; coolingOffHours: number;
 provenance: Record<string, 'default' | 'partner' | 'org'>; ignored: string[];
}
export const CALLER_VERIFICATION_POLICY_DEFAULTS: Omit<EffectiveCallerVerificationPolicy, 'provenance' | 'ignored'> = {
 requiredTierResetPassword:2,requiredTierDisableUser:2,disableUserAuthorizerRoles:['admin'],verificationTtlMinutes:30,
 allowedMethods:['workstation','sms','email','callback_attestation'],workstationTimeoutSeconds:120,destinationMinAgeDays:7,
 requireAttestedDestination:false,requireTicket:false,allowCrossTechnicianUse:false,allowAdministrativeDisable:true,maxAttemptsPerHour:3,coolingOffHours:24,
};
type Key=keyof typeof CALLER_VERIFICATION_POLICY_DEFAULTS;
const operators:Record<Key,'max'|'min'|'or'|'and'|'intersection'>={
 requiredTierResetPassword:'max',requiredTierDisableUser:'max',disableUserAuthorizerRoles:'intersection',verificationTtlMinutes:'min',allowedMethods:'intersection',
 workstationTimeoutSeconds:'min',destinationMinAgeDays:'max',requireAttestedDestination:'or',requireTicket:'or',allowCrossTechnicianUse:'and',allowAdministrativeDisable:'and',maxAttemptsPerHour:'min',coolingOffHours:'max',
};
export function resolveEffectivePolicy(partnerRow: PolicyRow | null, orgRow: PolicyRow | null): EffectiveCallerVerificationPolicy {
 const result=structuredClone(CALLER_VERIFICATION_POLICY_DEFAULTS) as EffectiveCallerVerificationPolicy;
 result.provenance={}; result.ignored=[];
 for(const key of Object.keys(operators) as Key[]){
  const base=partnerRow?.[key]??CALLER_VERIFICATION_POLICY_DEFAULTS[key], requested=orgRow?.[key];
  let effective:unknown=base; result.provenance[key]=partnerRow?.[key]!=null?'partner':'default';
  if(requested!=null){
   switch(operators[key]){
    case 'max':effective=Math.max(base as number,requested as number);break;
    case 'min':effective=Math.min(base as number,requested as number);break;
    case 'or':effective=Boolean(base)||Boolean(requested);break;
    case 'and':effective=Boolean(base)&&Boolean(requested);break;
    case 'intersection':effective=(base as string[]).filter(v=>(requested as string[]).includes(v));break;
   }
   const equal=(a:unknown,b:unknown)=>Array.isArray(a)&&Array.isArray(b)?a.length===b.length&&a.every(v=>b.includes(v)):a===b;
   if(!equal(effective,requested))result.ignored.push(key);
   if(!equal(effective,base))result.provenance[key]='org';
  }
  (result as unknown as Record<string,unknown>)[key]=effective;
 }
 return result;
}
export async function getEffectivePolicy(orgId: string): Promise<EffectiveCallerVerificationPolicy> {
 const [org]=await db.select({partnerId:organizations.partnerId}).from(organizations).where(eq(organizations.id,orgId)).limit(1);
 if(!org)throw new Error('Organization not found');
 const rows=await db.select().from(callerVerificationPolicies).where(or(eq(callerVerificationPolicies.orgId,orgId),and(isNull(callerVerificationPolicies.orgId),eq(callerVerificationPolicies.partnerId,org.partnerId))));
 return resolveEffectivePolicy(rows.find(r=>r.partnerId===org.partnerId)??null,rows.find(r=>r.orgId===orgId)??null);
}
export function policyResponse(partnerRow:PolicyRow|null,orgRow:PolicyRow|null,owner:'org'|'partner'){
 const {provenance:_provenance,ignored:_ignored,...baseline}=resolveEffectivePolicy(partnerRow,null);
 return {row:owner==='partner'?partnerRow:orgRow,defaults:structuredClone(CALLER_VERIFICATION_POLICY_DEFAULTS),baseline,effective:resolveEffectivePolicy(partnerRow,owner==='org'?orgRow:null)};
}
export async function getPolicyResponse(owner:'org'|'partner',ownerId:string){
 if(owner==='partner'){
  const [row]=await db.select().from(callerVerificationPolicies).where(eq(callerVerificationPolicies.partnerId,ownerId)).limit(1);
  return policyResponse(row??null,null,'partner');
 }
 const [org]=await db.select().from(organizations).where(eq(organizations.id,ownerId)).limit(1);
 if(!org)throw new Error('Organization not found');
 const rows=await db.select().from(callerVerificationPolicies).where(or(eq(callerVerificationPolicies.orgId,ownerId),and(isNull(callerVerificationPolicies.orgId),eq(callerVerificationPolicies.partnerId,org.partnerId))));
 return policyResponse(rows.find(r=>r.partnerId===org.partnerId)??null,rows.find(r=>r.orgId===ownerId)??null,'org');
}
// tiers.ts
import type { CallerVerificationMethod } from './types';
import type { EffectiveCallerVerificationPolicy } from './policy';
export function computeTier(input: { method: CallerVerificationMethod; boundPrincipal: boolean; destinationEstablished: boolean; policy: EffectiveCallerVerificationPolicy }): { tier: 0 | 1 | 2 | 3; reason: 'bound_principal' | 'unbound_principal' | 'destination_established' | 'destination_recent' | 'attestation' | 'administrative' | 'method_disabled' } {
 const {method,policy}=input;
 if(method==='administrative_stepup')return {tier:policy.allowAdministrativeDisable?3:0,reason:'administrative'};
 if(!policy.allowedMethods.includes(method))return {tier:0,reason:'method_disabled'};
 if(method==='callback_attestation')return {tier:1,reason:'attestation'};
 if(method==='workstation')return input.boundPrincipal?{tier:3,reason:'bound_principal'}:{tier:1,reason:'unbound_principal'};
 return input.destinationEstablished?{tier:2,reason:'destination_established'}:{tier:1,reason:'destination_recent'};
}
```

Add to `policy.test.ts`; Task 15 also checks both HTTP verbs/scopes with real rows:

```ts
import { policyResponse,CALLER_VERIFICATION_POLICY_DEFAULTS } from './policy';
it.each(['org','partner'] as const)('returns independent defaults, baseline and effective for %s',owner=>{
 const partner=row({requiredTierResetPassword:1,verificationTtlMinutes:60});
 const org=row({requiredTierResetPassword:3,verificationTtlMinutes:15});
 const result=policyResponse(partner,org,owner);
 expect(result.row).toBe(owner==='org'?org:partner);
 expect(result.defaults).toEqual(CALLER_VERIFICATION_POLICY_DEFAULTS);
 expect(result.baseline).toMatchObject({requiredTierResetPassword:1,verificationTtlMinutes:60});
 expect(result.effective).toMatchObject({requiredTierResetPassword:owner==='org'?3:1,verificationTtlMinutes:owner==='org'?15:60});
 expect(result.baseline).not.toHaveProperty('provenance');
});
```

- [ ] **Step 4:** Run `cd apps/api && npx vitest run src/services/callerVerification/policy.test.ts src/services/callerVerification/tiers.test.ts`. Expected: PASS; no Graph calls in either pure function.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/callerVerification/policy.ts apps/api/src/services/callerVerification/policy.test.ts apps/api/src/services/callerVerification/tiers.ts apps/api/src/services/callerVerification/tiers.test.ts
git commit -m "feat(caller-verification): resolve policy floors and assurance tiers"
```

### Task 7: Destination history, establishment and every contact writer

**Files:** Create `apps/api/src/services/callerVerification/destinations.ts`, `apps/api/src/services/callerVerification/destinations.test.ts`, `apps/api/src/services/callerVerification/writers.test.ts`, `apps/api/src/services/callerVerification/testing.ts`; Modify `apps/api/src/services/contacts/crud.ts:29,467,493,511,606`, `apps/api/src/services/contacts/compat.ts:88,144,150`, `apps/api/src/services/contacts/import.ts:850,898`, `apps/api/src/routes/orgContacts.ts:300,342`, `apps/api/src/services/inboundEmail/resolveOrg.ts:133`, `apps/api/src/services/aiToolsOrgs.ts:505`, `apps/api/src/services/contacts/crud.test.ts:1`, `apps/api/src/services/contacts/compat.test.ts:1`, `apps/api/src/services/contacts/import.test.ts:1`. Read-only verified paths: `routes/reports/recipients.ts:176`, `services/contacts/loginLink.ts:163`, `routes/portal/profile.ts:50`.

**Interfaces:** `recordDestinationChange(input: { orgId: string; contactId: string; kind: 'email' | 'mobile'; value: string | null; source: DestinationSource; userId: string | null }): Promise<void>`; `currentDestination(orgId: string, contactId: string, kind: 'email' | 'mobile'): Promise<DestinationRow | null>`; `isEstablished(row: DestinationRow, policy: EffectiveCallerVerificationPolicy, now?: Date): boolean`; `attestDestination(actor: CallerVerificationActor, orgId: string, destinationId: string): Promise<DestinationRow>`. Internal executor overload preserves the caller's transaction, including explicit CRUD transaction handles.

- [ ] **Step 1: Write establishment and writer-contract tests.** First create the test-only chain utility:

```ts
// testing.ts
import { vi } from 'vitest';
export function makeDbMock(){
 const results:unknown[][]=[],calls:Array<{name:string;args:unknown[]}>=[];
 const chain:any={};
 for(const name of ['select','from','where','limit','orderBy','for','insert','values','update','set','returning','onConflictDoNothing'])chain[name]=(...args:unknown[])=>{calls.push({name,args});return chain;};
 chain.then=(yes:(v:unknown)=>unknown,no:(e:unknown)=>unknown)=>Promise.resolve(results.shift()??[]).then(yes,no);
 chain.execute=vi.fn(async()=>[]);return {db:chain,results,calls};
}
```

```ts
// destinations.test.ts
import { expect,it,vi } from 'vitest';
import { makeDbMock } from './testing';
import { isEstablished,normalizeDestination,recordDestinationChangeWithExecutor,destinationHash } from './destinations';
import { resolveEffectivePolicy } from './policy';
import type { DestinationRow } from './types';
it('requires age AND human provenance, even after attestation',()=>{
 const now=new Date('2026-09-19T00:00:00Z'),policy=resolveEffectivePolicy(null,null);
 const d={setAt:new Date('2026-09-12T00:00:00Z'),supersededAt:null,source:'import',attestedAt:null} as DestinationRow;
 expect(isEstablished(d,policy,now)).toBe(false);
 expect(isEstablished({...d,attestedAt:now},policy,now)).toBe(true);
 expect(isEstablished({...d,source:'technician',setAt:now},policy,now)).toBe(false);
 expect(isEstablished({...d,source:'technician'}, {...policy,requireAttestedDestination:true},now)).toBe(false);
 expect(isEstablished({...d,source:'technician',supersededAt:now},policy,now)).toBe(false);
 expect(normalizeDestination('email',' A@EXAMPLE.COM ')).toBe('a@example.com');
 expect(normalizeDestination('mobile','(555) 123-4567')).toBeNull();
});
it('unchanged normalized values do not renew age; A→B→A creates new rows',async()=>{
 const exec=makeDbMock(),input={orgId:'11111111-1111-4111-8111-111111111111',contactId:'22222222-2222-4222-8222-222222222222',kind:'email' as const,value:'a@example.com',source:'import' as const,userId:null};
 const old={id:'33333333-3333-4333-8333-333333333333',valueHash:destinationHash('a@example.com')};
 exec.results.push([old]);await recordDestinationChangeWithExecutor(exec.db,{...input,value:' A@EXAMPLE.COM '});expect(exec.calls.filter(c=>c.name==='insert'||c.name==='update')).toEqual([]);
 exec.results.push([old],[],[]);await recordDestinationChangeWithExecutor(exec.db,{...input,value:'b@example.com'});
 exec.results.push([{...old,valueHash:destinationHash('b@example.com')}],[],[]);await recordDestinationChangeWithExecutor(exec.db,input);
 const writes=exec.calls.filter(c=>c.name==='values').map(c=>c.args[0]);expect(writes).toHaveLength(2);
 expect(writes[1]).toMatchObject({valueHash:old.valueHash,source:'import'});expect(writes[1]).not.toHaveProperty('setAt');expect(writes[1]).not.toHaveProperty('attestedAt');
 exec.results.push([old],[]);await recordDestinationChangeWithExecutor(exec.db,{...input,value:null});expect(exec.calls.filter(c=>c.name==='insert')).toHaveLength(2);
});
// writers.test.ts — source inventory is intentional; behavior tests remain in CRUD/import.
import { readFileSync,readdirSync } from 'node:fs';
import { join,relative } from 'node:path';
import { expect,it } from 'vitest';
const root=new URL('../..',import.meta.url).pathname;
const walk=(d:string):string[]=>readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(d,e.name)):[join(d,e.name)]);
it('every direct contact destination writer records provenance',()=>{
 const known=['services/contacts/crud.ts','services/contacts/compat.ts','services/contacts/import.ts'];
 for(const path of walk(root).filter(p=>p.endsWith('.ts')&&!p.includes('.test.')&&!p.includes('/__tests__/'))){
  const s=readFileSync(path,'utf8');
  if(!/\.(insert|update)\(contacts\)/.test(s))continue;
  const rel=relative(root,path);
  if(['services/contacts/loginLink.ts','services/orgMergeCustomExecutors.ts'].includes(rel)){
   expect(s).not.toMatch(/\.set\(\{[^}]*\b(email|mobile):/s);continue;
  }
  expect(known).toContain(rel);expect(s).toContain('recordDestinationChange');
 }
 const portal=readFileSync(join(root,'routes/portal/profile.ts'),'utf8');
 expect(portal).not.toMatch(/\.(insert|update)\(contacts\)/);
 for(const [p,source] of [['routes/orgContacts.ts','technician'],['services/inboundEmail/resolveOrg.ts','inbound_email'],['services/aiToolsOrgs.ts','ai_tool']] as const)
  expect(readFileSync(join(root,p),'utf8')).toContain(`destinationSource: '${source}'`);
});
```

- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/callerVerification/destinations.test.ts src/services/callerVerification/writers.test.ts`. Expected: missing helper/provenance markers.
- [ ] **Step 3: Implement and instrument writes.** Invalid legacy values supersede prior destinations but create no usable destination. A→B→A inserts a fresh epoch for A, never resurrects old age/attestation. Same normalized value is a no-op even if a different source writes it.

```ts
import { createHash } from 'node:crypto';
import { and,eq,isNull,sql } from 'drizzle-orm';
import { db,assertInTransaction } from '../../db';
import { callerVerificationDestinations as d } from '../../db/schema/callerVerification';
import type { ContactExecutor } from '../contacts/compat';
import type { DestinationSource,DestinationRow,CallerVerificationActor } from './types';
import type { EffectiveCallerVerificationPolicy } from './policy';
import { reachableContact } from './access';
import { CallerVerificationValidationError as Invalid } from './errors';
export function normalizeDestination(kind:'email'|'mobile',value:string|null):string|null{
 if(!value)return null;
 const v=kind==='email'?value.trim().toLowerCase():value.replace(/[\s().-]/g,'');
 return (kind==='email'?/^[^@\s]+@[^@\s]+$/:/^\+[1-9][0-9]{7,14}$/).test(v)?v:null;
}
export const destinationHash=(value:string)=>createHash('sha256').update(value).digest('hex');
export function redactDestination(kind:'email'|'mobile',value:string):string{
 return (kind==='email'?`${value[0]}***@${value.split('@')[1]}`:`+***${value.slice(-2)}`).slice(0,64);
}
type Change={orgId:string;contactId:string;kind:'email'|'mobile';value:string|null;source:DestinationSource;userId:string|null};
export async function recordDestinationChange(input: Change): Promise<void>{
 assertInTransaction('recordDestinationChange');await recordDestinationChangeWithExecutor(db,input);
}
export async function recordDestinationChangeWithExecutor(exec:ContactExecutor,input:Change):Promise<void>{
 await exec.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`caller-contact:${input.orgId}:${input.contactId}`}))`);
 const [old]=await exec.select().from(d).where(and(eq(d.orgId,input.orgId),eq(d.contactId,input.contactId),eq(d.kind,input.kind),isNull(d.supersededAt))).limit(1);
 const value=normalizeDestination(input.kind,input.value),hash=value?destinationHash(value):null;
 if(old?.valueHash===hash||(!old&&!value))return;
 if(old)await exec.update(d).set({supersededAt:new Date()}).where(eq(d.id,old.id));
 if(value)await exec.insert(d).values({orgId:input.orgId,contactId:input.contactId,kind:input.kind,valueHash:hash!,valueRedacted:redactDestination(input.kind,value),source:input.source,setByUserId:input.userId});
}
export async function currentDestination(orgId: string, contactId: string, kind: 'email' | 'mobile'): Promise<DestinationRow | null>{
 const [row]=await db.select().from(d).where(and(eq(d.orgId,orgId),eq(d.contactId,contactId),eq(d.kind,kind),isNull(d.supersededAt))).limit(1);return row??null;
}
export function isEstablished(row: DestinationRow, policy: EffectiveCallerVerificationPolicy, now=new Date()): boolean{
 return row.supersededAt===null&&row.setAt.getTime()<=now.getTime()-policy.destinationMinAgeDays*86400000
 &&(row.source==='technician'||row.attestedAt!==null)&&(!policy.requireAttestedDestination||row.attestedAt!==null);
}
export async function attestDestination(actor: CallerVerificationActor, orgId: string, destinationId: string): Promise<DestinationRow>{
 const [row]=await db.select().from(d).where(and(eq(d.id,destinationId),eq(d.orgId,orgId))).limit(1);
 if(!row)throw new Invalid('not_found','Destination not found');const contact=await reachableContact(actor,orgId,row.contactId);
 const normalized=normalizeDestination(row.kind,contact[row.kind]);if(!normalized||destinationHash(normalized)!==row.valueHash)throw new Invalid('destination_changed','Correct the current destination before attesting it');
 await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`caller-contact:${orgId}:${row.contactId}`}))`);
 const [updated]=await db.update(d).set({attestedAt:new Date(),attestedByUserId:actor.userId}).where(and(eq(d.id,row.id),isNull(d.supersededAt))).returning();
 if(!updated)throw new Invalid('destination_changed','Destination was superseded');
 await db.execute(sql`INSERT INTO audit_logs(org_id,actor_type,actor_id,action,resource_type,resource_id,result)
 VALUES(${orgId}::uuid,'user',${actor.userId}::uuid,'caller_verification.destination_attested','caller_verification',${row.id}::uuid,'success')`);
 return updated;
}
```

Extend `ContactActor` (`crud.ts:29`) with `destinationSource?: DestinationSource` and import the type from `../callerVerification/types`; import `recordDestinationChangeWithExecutor` in CRUD, compat and import. In `createContact`, immediately after `.returning(contactColumns())` and before `reprojectPrimaryContact`, add:

```ts
if(created)for(const kind of ['email','mobile'] as const)await recordDestinationChangeWithExecutor(exec,{orgId:input.orgId,contactId:created.id,kind,value:created[kind],source:actor.destinationSource??'technician',userId:actor.userId});
```

In `updateContact`, after `if (!updated) return null` at :625 and before the reproject loop, add:

```ts
for(const kind of ['email','mobile'] as const)await recordDestinationChangeWithExecutor(exec,{orgId,contactId,kind,value:updated[kind],source:actor.destinationSource??'technician',userId:actor.userId});
```

In `createImportedContact`, after `const contactId = (created as { id: string }).id` at :865, add:

```ts
for(const kind of ['email','mobile'] as const)await recordDestinationChangeWithExecutor(db,{orgId,contactId,kind,value:r[kind],source:'import',userId:null});
```

Pass `{...actor,destinationSource:'import'}` as `updateContact`'s final argument in `applyMatchedContact`. In compat's existing UPDATE branch, after the write and before return, add:

```ts
await recordDestinationChangeWithExecutor(exec,{orgId,contactId:existing.id,kind:'email',value:next.email,source:'technician',userId:actorId??null});
```

Replace compat's final insert with `const [created] = await exec.insert(contacts).values({orgId,siteId,...next,roles:defaultRoles,isPrimary:true,createdBy:actorId??null}).returning({id:contacts.id});` followed by:

```ts
await recordDestinationChangeWithExecutor(exec,{orgId,contactId:created!.id,kind:'email',value:next.email,source:'technician',userId:actorId??null});
```

In `orgContacts.ts:166`, import `ContactActor` from `../services/contacts/crud`, change `actorFrom`'s return type to `ContactActor`, and return `{userId:(c.get('auth') as AuthContext).user?.id??null,destinationSource: 'technician'}`. In `resolveOrg.ts:133` pass `{userId:null,destinationSource: 'inbound_email'}`. In `aiToolsOrgs.ts:518` pass `{userId:auth.user.id,destinationSource: 'ai_tool'}`. Report-recipient/login-link creation remains human-sourced through CRUD. Portal profile has no contact email/mobile writer; the contract pins that fact. The existing CRUD/import/compat fixture queues model their old SQL chains. Add this explicit mock to each of `apps/api/src/services/contacts/crud.test.ts:1`, `apps/api/src/services/contacts/import.test.ts:1`, `apps/api/src/services/contacts/compat.test.ts:1`; the helper's own suite above exercises the new SQL behavior. Use the retained spy in each existing create/update test to check its caller provenance.

```ts
vi.mock('../callerVerification/destinations',()=>({recordDestinationChangeWithExecutor:vi.fn().mockResolvedValue(undefined)}));
```

In the existing `commitContactImport` creation test (`import.test.ts:499`), import the spy and append this concrete assertion:

```ts
import { recordDestinationChangeWithExecutor } from '../callerVerification/destinations';
expect(recordDestinationChangeWithExecutor).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({orgId:ORG,kind:'email',value:'jane@acme.example',source:'import'}));
```

- [ ] **Step 4:** Run `cd apps/api && npx vitest run src/services/callerVerification/destinations.test.ts src/services/callerVerification/writers.test.ts src/services/contacts/crud.test.ts src/services/contacts/compat.test.ts src/services/contacts/import.test.ts src/routes/orgContacts.test.ts`. Expected: PASS; unrelated-field updates preserve `set_at`.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/callerVerification/testing.ts apps/api/src/services/callerVerification/destinations.ts apps/api/src/services/callerVerification/destinations.test.ts apps/api/src/services/callerVerification/writers.test.ts apps/api/src/services/contacts/crud.ts apps/api/src/services/contacts/compat.ts apps/api/src/services/contacts/import.ts apps/api/src/services/contacts/crud.test.ts apps/api/src/services/contacts/compat.test.ts apps/api/src/services/contacts/import.test.ts apps/api/src/routes/orgContacts.ts apps/api/src/services/inboundEmail/resolveOrg.ts apps/api/src/services/aiToolsOrgs.ts
git commit -m "feat(caller-verification): track destination provenance at every writer"
```

### Task 8: Canonical bindings and a real trusted directory-import entry point

**Files:** Create `apps/api/src/services/callerVerification/directory.ts`, `directory.test.ts`, `loginObservation.ts`, `loginObservation.test.ts`, `agent/internal/collectors/session_principal_windows.go`, `session_principal_unix.go`; Modify `agent/internal/collectors/sessions.go`, `sessions_test.go`, `apps/api/src/routes/agents/schemas.ts`, `sessions.ts`, `sessions.test.ts`; Create `apps/api/src/services/callerVerification/subjects.ts`, `apps/api/src/services/callerVerification/subjects.test.ts`; Modify `apps/api/src/services/contacts/import.ts:724,841`, `apps/api/src/services/contacts/import.test.ts:1`. Existing Graph seam: `apps/api/src/services/m365ControlPlane/readActionService.ts:108`; connection lookup at 139; shared read action at `packages/shared/src/m365/readActions.ts:49`.

**Interfaces:** `resolveTargetBinding(orgId: string, subject: EntraSubject): Promise<BindingRow>`; `bindingsForContact(orgId: string, contactId: string): Promise<BindingRow[]>`; `upsertDirectorySyncBinding(input: { orgId: string; contactId: string; entraTenantId: string; entraOid: string; upn: string | null }): Promise<void>`; `attestBinding(actor: CallerVerificationActor, input: { orgId: string; contactId: string; entraTenantId: string; entraOid: string; upn: string | null }): Promise<BindingRow>`; `observeLogin(input: { orgId: string; contactId: string; osPrincipal: string; osUsername: string; upn: string | null }): Promise<void>`; `revokeBinding(actor: CallerVerificationActor, orgId: string, bindingId: string): Promise<void>`.

- [ ] **Step 1: Write refusal and CSV-isolation tests.**

```ts
// subjects.test.ts
import { expect,it,vi } from 'vitest';
const m=vi.hoisted(()=>({rows:[] as unknown[]}));
vi.mock('../../db',()=>({db:{select:()=>({from:()=>({where:()=>({limit:async()=>m.rows})})})}}));
import { resolveTargetBinding } from './subjects';
it.each([0,2])('fails closed for %s active matches',async n=>{
 m.rows=Array.from({length:n},()=>({id:'11111111-1111-4111-8111-111111111111'}));
 await expect(resolveTargetBinding('22222222-2222-4222-8222-222222222222',{entraTenantId:'tenant',entraOid:'oid'})).rejects.toMatchObject({payload:{reason:n?'subject_ambiguous':'subject_unmatched'}});
});
// Add to existing import.test.ts, using its real fixture helpers:
vi.mock('../callerVerification/subjects',()=>({upsertDirectorySyncBinding:vi.fn()}));
import { upsertDirectorySyncBinding } from '../callerVerification/subjects';
it('CSV/API Entra labels are never directory evidence',async()=>{
 stubState();stubWrites();
 const summary=await commitContactImport([{organizationId:ORG,name:'Uploaded',email:'upload@example.com',externalSystem:'entra',externalId:'33333333-3333-4333-8333-333333333333'}],CTX,ACTOR);
 expect(summary.imported).toHaveLength(1);expect(summary.errors).toEqual([]);
 expect(upsertDirectorySyncBinding).not.toHaveBeenCalled();
});
```

The fixture uses the real flat `CommitContactRowInput` (`organizationId`, `externalSystem`, `externalId`), verified in `import.test.ts:499`. Successful contact creation is the positive control.

- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/callerVerification/subjects.test.ts src/services/contacts/import.test.ts`. Expected: missing binding service.
- [ ] **Step 3: Implement canonical bindings.** A conflicting claim commits two revoked rows and an audit; it never throws after the revocation and thereby rolls it back. Explicit attestation may resolve a previously revoked identity; automated sync may not silently resurrect it.

```ts
import { and,eq,isNull,or,sql } from 'drizzle-orm';
import { db,assertInTransaction } from '../../db';
import { callerVerificationSubjectBindings as b,callerVerifications as v } from '../../db/schema/callerVerification';
import type { BindingRow,EntraSubject,CallerVerificationActor } from './types';
import { CallerVerificationRequiredError,CallerVerificationValidationError as Invalid } from './errors';
import { reachableContact } from './access';
import { withSubjectLocks } from './locks';
type Claim={orgId:string;contactId:string;entraTenantId:string;entraOid:string;upn:string|null};
export async function bindingsForContact(orgId:string,contactId:string):Promise<BindingRow[]>{return db.select().from(b).where(and(eq(b.orgId,orgId),eq(b.contactId,contactId),isNull(b.revokedAt)));}
export async function resolveTargetBinding(orgId:string,subject:EntraSubject):Promise<BindingRow>{
 const rows=await db.select().from(b).where(and(eq(b.orgId,orgId),eq(b.entraTenantId,subject.entraTenantId),eq(b.entraOid,subject.entraOid),isNull(b.revokedAt))).limit(2);
 if(rows.length!==1)throw new CallerVerificationRequiredError({orgId,contactId:null,action:'reset_password',requiredTier:2,reason:rows.length?'subject_ambiguous':'subject_unmatched',latest:null});return rows[0]!;
}
async function claim(input:Claim,source:'directory_sync'|'technician_attested',userId:string|null):Promise<BindingRow>{
 assertInTransaction('claimBinding');
 await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`caller-identity:${input.orgId}`}))`);
 const rows=await db.select().from(b).where(and(eq(b.orgId,input.orgId),eq(b.entraTenantId,input.entraTenantId),eq(b.entraOid,input.entraOid)));
 const active=rows.filter(r=>!r.revokedAt),same=active.find(r=>r.contactId===input.contactId),conflict=active.some(r=>r.contactId!==input.contactId);
 return withSubjectLocks(db,active.map(r=>r.id),async()=>{
  if(same&&!conflict){const [r]=await db.update(b).set({upnSnapshot:input.upn,updatedAt:new Date(),...(source==='technician_attested'?{source,attestedAt:new Date(),attestedByUserId:userId}:{})}).where(eq(b.id,same.id)).returning();return r!;}
  const blocked=conflict||(source==='directory_sync'&&rows.some(r=>r.revokedAt!==null));
  if(conflict){
   await db.update(b).set({revokedAt:new Date(),updatedAt:new Date()}).where(and(eq(b.orgId,input.orgId),eq(b.entraTenantId,input.entraTenantId),eq(b.entraOid,input.entraOid),isNull(b.revokedAt)));
   await db.update(v).set({status:'revoked'}).where(and(eq(v.orgId,input.orgId),isNull(v.consumedAt),eq(v.status,'verified'),sql`(${v.requesterBindingId} IN (${sql.join(active.map(r=>sql`${r.id}::uuid`),sql`,`)}) OR ${v.targetBindingId} IN (${sql.join(active.map(r=>sql`${r.id}::uuid`),sql`,`)}))`));
  }
  const [r]=await db.insert(b).values({orgId:input.orgId,contactId:input.contactId,entraTenantId:input.entraTenantId,entraOid:input.entraOid,upnSnapshot:input.upn,source,revokedAt:blocked?new Date():null,attestedByUserId:userId,attestedAt:userId?new Date():null}).returning();
  await db.execute(sql`INSERT INTO audit_logs(org_id,actor_type,actor_id,action,resource_type,resource_id,result)
   VALUES(${input.orgId}::uuid,${userId?'user':'system'}::actor_type,${userId??'00000000-0000-0000-0000-000000000000'}::uuid,
   ${blocked?'caller_verification.binding_conflict':'caller_verification.binding_created'},'caller_verification',${r!.id}::uuid,'success')`);
  return r!;
 });
}
export async function upsertDirectorySyncBinding(input:Claim):Promise<void>{await claim(input,'directory_sync',null);}
export async function attestBinding(actor:CallerVerificationActor,input:Claim):Promise<BindingRow>{await reachableContact(actor,input.orgId,input.contactId);return claim(input,'technician_attested',actor.userId);}
export async function observeLogin(input:{orgId:string;contactId:string;osPrincipal:string;osUsername:string;upn:string|null}):Promise<void>{
 if(!input.upn)return;
 assertInTransaction('observeLogin');
 await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`caller-identity:${input.orgId}`}))`);
 const matches=await db.select().from(b).where(and(eq(b.orgId,input.orgId),isNull(b.revokedAt),sql`${b.entraOid} IS NOT NULL AND ${b.entraTenantId} IS NOT NULL`,sql`lower(${b.upnSnapshot})=lower(${input.upn})`)).limit(2);
 if(matches.length!==1||matches[0]!.contactId!==input.contactId)return;const target=matches[0]!;
 const others=await db.select().from(b).where(and(eq(b.orgId,input.orgId),eq(b.osPrincipal,input.osPrincipal),isNull(b.revokedAt)));
 await withSubjectLocks(db,[target.id,...others.map(r=>r.id)],async()=>{
  if(others.some(r=>r.contactId!==input.contactId)){
   const ids=[target.id,...others.map(r=>r.id)];
   await db.execute(sql`UPDATE caller_verification_subject_bindings SET revoked_at=now(),updated_at=now() WHERE id IN (${sql.join(ids.map(id=>sql`${id}::uuid`),sql`,`)})`);
   await db.execute(sql`UPDATE caller_verifications SET status='revoked' WHERE org_id=${input.orgId}::uuid AND status='verified' AND consumed_at IS NULL AND (requester_binding_id IN (${sql.join(ids.map(id=>sql`${id}::uuid`),sql`,`)}) OR target_binding_id IN (${sql.join(ids.map(id=>sql`${id}::uuid`),sql`,`)}))`);
   await db.execute(sql`INSERT INTO audit_logs(org_id,actor_type,actor_id,action,resource_type,resource_id,result) VALUES(${input.orgId}::uuid,'system','00000000-0000-0000-0000-000000000000','caller_verification.binding_conflict','caller_verification',${target.id}::uuid,'success')`);return;
  }
  await db.update(b).set({osPrincipal:input.osPrincipal,osUsername:input.osUsername,source:'observed_login',updatedAt:new Date()}).where(and(eq(b.id,target.id),isNull(b.revokedAt)));
 });
}
export async function revokeBinding(actor:CallerVerificationActor,orgId:string,bindingId:string):Promise<void>{
 const [row]=await db.select().from(b).where(and(eq(b.id,bindingId),eq(b.orgId,orgId))).limit(1);if(!row)throw new Invalid('not_found','Binding not found');
 await reachableContact(actor,orgId,row.contactId);
 await withSubjectLocks(db,[row.id],async()=>{
  await db.update(b).set({revokedAt:new Date(),updatedAt:new Date()}).where(eq(b.id,row.id));
  await db.update(v).set({status:'revoked'}).where(and(eq(v.orgId,orgId),isNull(v.consumedAt),eq(v.status,'verified'),or(eq(v.requesterBindingId,row.id),eq(v.targetBindingId,row.id))));
  await db.execute(sql`INSERT INTO audit_logs(org_id,actor_type,actor_id,action,resource_type,resource_id,result) VALUES(${orgId}::uuid,'user',${actor.userId}::uuid,'caller_verification.binding_revoked','caller_verification',${row.id}::uuid,'success')`);
 });
}
```

Add this **new**, server-only Graph-backed branch to `contacts/import.ts`; the existing CSV/API `commitContactImport` does not call it. Exact additional imports are `AuthContext`, `dbAccessContextFromAuth` from `../../middleware/auth`, `withDbAccessContext` from `../../db`, `m365Connections` from `../../db/schema`, `executeM365ReadAction` from `../m365ControlPlane/readActionService`, `upsertDirectorySyncBinding`, `attestBinding`, `bindingsForContact` from `../callerVerification/subjects`, `reachableContact` from `../callerVerification/access`, and `BindingRow`, `CallerVerificationActor` from `../callerVerification/types`. The manual binding route supplies the internal literal `technician_attested`; trusted sync callers use the default. Neither mode accepts uploaded Graph user objects.

```ts
export async function importDirectoryContact(auth:AuthContext,input:{orgId:string;contactId:string;directoryObjectId:string;expectedTenantId:string},mode:'directory_sync'|'technician_attested'='directory_sync'):Promise<BindingRow>{
 const ctx=dbAccessContextFromAuth(auth),actor:CallerVerificationActor={userId:auth.user.id,partnerId:auth.partnerId,scope:auth.scope==='organization'?'organization':'partner',accessibleOrgIds:auth.accessibleOrgIds,allowedSiteIds:auth.allowedSiteIds??null,displayName:auth.user.name??auth.user.email};
 const connection=await withDbAccessContext(ctx,async()=>{
  await reachableContact(actor,input.orgId,input.contactId);
  const [c]=await db.select().from(m365Connections).where(and(eq(m365Connections.orgId,input.orgId),eq(m365Connections.profile,'customer-graph-read'))).limit(1);
  if(!c?.tenantId||c.tenantId!==input.expectedTenantId||!['active','degraded'].includes(c.status))throw new Error('Directory connection or tenant is not ready');return c;
 });
 const result=await executeM365ReadAction(auth,{type:'m365.user.get',userIdOrUpn:input.directoryObjectId},input.orgId);
 if(!result.ok)throw new Error(result.message);if(result.kind!=='resource')throw new Error('Expected a directory user');
 const user=result.resource as {id:string;userPrincipalName?:string;mail?:string;displayName?:string};
 if(user.id.toLowerCase()!==input.directoryObjectId.toLowerCase())throw new Error('Directory object mismatch');
 return withDbAccessContext(ctx,async()=>{
  const [current]=await db.select().from(m365Connections).where(eq(m365Connections.id,connection.id)).limit(1).for('share');
  if(current?.tenantId!==connection.tenantId||!['active','degraded'].includes(current.status))throw new Error('Directory tenant changed');
  await reachableContact(actor,input.orgId,input.contactId);
  const claim={orgId:input.orgId,contactId:input.contactId,entraTenantId:connection.tenantId!,entraOid:user.id,upn:user.userPrincipalName??null};
  if(mode==='technician_attested')return attestBinding(actor,claim);
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`caller-identity:${input.orgId}`}))`);
  await updateContact(db,input.contactId,input.orgId,{email:user.mail??user.userPrincipalName??undefined},{userId:auth.user.id,destinationSource:'import'});
  await upsertDirectorySyncBinding(claim);
  const rows=await db.select().from(callerVerificationSubjectBindings).where(and(eq(callerVerificationSubjectBindings.orgId,input.orgId),eq(callerVerificationSubjectBindings.contactId,input.contactId),eq(callerVerificationSubjectBindings.entraOid,user.id))).orderBy(desc(callerVerificationSubjectBindings.createdAt)).limit(1);
  return rows[0]!;
 });
}
```

Import `callerVerificationSubjectBindings` from `../../db/schema/callerVerification` and `desc, sql` from `drizzle-orm` for the final history read and identity advisory lock. Returning a revoked conflict row lets the caller report 409 without throwing away committed revocations. The manual path validates server evidence first and stamps an attestation in one transaction without changing the contact destination. Directory deletion is inferred only from a complete authoritative sync, never a partial page; W01 exposes explicit revocation and never auto-deletes history.

- [ ] **Step 3a: Add reachable directory search and authoritative sync.** Create `services/callerVerification/directory.ts` and `directory.test.ts`. Existing `executeM365ReadAction` returns collection `items` and `truncated`; `m365.user.list` accepts `pageSize:50` and the executor bounds pagination. A truncated snapshot can import selected users but must never revoke disappearances. Only full-org administrators may enumerate the org-wide directory; this endpoint has no contact/site selector. Binding a known OID still checks the selected contact's site through `importDirectoryContact`.

```ts
// directory.ts
import { z } from 'zod';
import { and,eq,isNull,sql } from 'drizzle-orm';
import { db,withDbAccessContext } from '../../db';
import { m365Connections } from '../../db/schema';
import { callerVerificationSubjectBindings as b } from '../../db/schema/callerVerification';
import { dbAccessContextFromAuth,type AuthContext } from '../../middleware/auth';
import { executeM365ReadAction } from '../m365ControlPlane/readActionService';
import { importDirectoryContact } from '../contacts/import';
import { withSubjectLocks } from './locks';
import { CallerVerificationValidationError as Invalid } from './errors';
export interface DirectoryUser { entraTenantId:string;entraOid:string;upn:string;displayName:string }
export interface DirectorySearch { available:boolean;users:DirectoryUser[];truncated:boolean }
const ready=(c:{tenantId:string|null;status:string}|undefined)=>!!c?.tenantId&&['active','degraded'].includes(c.status);
async function connection(auth:AuthContext,orgId:string){
 if(auth.allowedSiteIds!=null||(auth.scope!=='system'&&!auth.canAccessOrg(orgId)))throw new Invalid('not_found','Directory not found');
 return withDbAccessContext(dbAccessContextFromAuth(auth),async()=>{
  const [c]=await db.select().from(m365Connections).where(and(eq(m365Connections.orgId,orgId),eq(m365Connections.profile,'customer-graph-read'))).limit(1);return c;
 });
}
async function snapshot(auth:AuthContext,orgId:string,search?:string){
 const before=await connection(auth,orgId);if(!ready(before))return null;
 const result=await executeM365ReadAction(auth,{type:'m365.user.list',...(search?{search}:{}),pageSize:50},orgId);
 if(!result.ok||result.kind!=='collection')throw new Invalid('directory_unavailable','Directory read unavailable');
 const parsed=z.array(z.object({id:z.string().uuid(),userPrincipalName:z.string().min(1).max(320),displayName:z.string().max(255).nullable().optional()})).safeParse(result.items);
 if(!parsed.success)throw new Invalid('directory_unavailable','Invalid directory response');
 const after=await connection(auth,orgId);
 if(!ready(after)||after!.id!==before!.id||after!.tenantId!==before!.tenantId)throw new Invalid('directory_changed','Directory tenant changed');
 return {connection:before!,users:parsed.data,truncated:result.truncated};
}
export async function directoryUsers(auth:AuthContext,orgId:string,search:string):Promise<DirectorySearch>{
 const s=await snapshot(auth,orgId,search);
 return s?{available:true,truncated:s.truncated,users:s.users.map(u=>({entraTenantId:s.connection.tenantId!,entraOid:u.id,upn:u.userPrincipalName,displayName:u.displayName??u.userPrincipalName}))}:{available:false,users:[],truncated:false};
}
export async function syncDirectory(auth:AuthContext,orgId:string,mappings:{contactId:string;entraOid:string}[]){
 const s=await snapshot(auth,orgId);if(!s)throw new Invalid('directory_unavailable','Directory unavailable');
 const seen=new Set(s.users.map(u=>u.id.toLowerCase()));
 for(const m of mappings){
  if(!seen.has(m.entraOid.toLowerCase()))throw new Invalid('directory_unavailable','Selected user missing from sync');
  await importDirectoryContact(auth,{orgId,contactId:m.contactId,directoryObjectId:m.entraOid,expectedTenantId:s.connection.tenantId!},'directory_sync');
 }
 if(s.truncated)return {imported:mappings.length,revoked:0,complete:false};
 return withDbAccessContext(dbAccessContextFromAuth(auth),async()=>{
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`caller-identity:${orgId}`}))`);
  const [current]=await db.select().from(m365Connections).where(and(eq(m365Connections.id,s.connection.id),eq(m365Connections.orgId,orgId))).limit(1).for('share');
  if(!ready(current)||current!.tenantId!==s.connection.tenantId)throw new Invalid('directory_changed','Directory tenant changed');
  // Include observed_login and technician_attested: source can change without changing canonical identity.
  const rows=await db.select().from(b).where(and(eq(b.orgId,orgId),eq(b.entraTenantId,s.connection.tenantId!),isNull(b.revokedAt)));
  const missing=rows.filter(r=>r.entraOid&&!seen.has(r.entraOid.toLowerCase()));
  await withSubjectLocks(db,missing.map(r=>r.id),async()=>{
   for(const row of missing){
    await db.update(b).set({revokedAt:new Date(),updatedAt:new Date()}).where(and(eq(b.id,row.id),eq(b.orgId,orgId),isNull(b.revokedAt)));
    await db.execute(sql`UPDATE caller_verifications SET status='revoked' WHERE org_id=${orgId}::uuid AND consumed_at IS NULL AND status IN ('pending','verified') AND (requester_binding_id=${row.id}::uuid OR target_binding_id=${row.id}::uuid)`);
    await db.execute(sql`INSERT INTO audit_logs(org_id,actor_type,actor_id,action,resource_type,resource_id,result) VALUES(${orgId}::uuid,'user',${auth.user.id}::uuid,'caller_verification.directory_missing','caller_verification',${row.id}::uuid,'success')`);
   }
  });
  return {imported:mappings.length,revoked:missing.length,complete:true};
 });
}
```

The explicit sync POST below is the execution path: Graph, not uploaded external IDs, supplies each claim. Earlier valid imports can commit before a later import fails; **no disappearance reconciliation runs unless every import and the full snapshot succeed**. A complete empty snapshot revokes all active bindings in that tenant. No connection, failed read, malformed response, truncated page, or tenant switch implies deletion.

```ts
// directory.test.ts
import { beforeEach,expect,it,vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const m=vi.hoisted(()=>({queue:[] as unknown[][],read:vi.fn(),import:vi.fn(),update:vi.fn(),execute:vi.fn(),locks:vi.fn()}));
vi.mock('../../db',()=>({db:{
 select:()=>{let rows:unknown[]|undefined;const q:any={from:()=>q,where:()=>q,limit:()=>q,for:()=>q,then:(resolve:any)=>{rows??=m.queue.shift()??[];return Promise.resolve(rows).then(resolve);}};return q;},
 update:()=>({set:(value:unknown)=>({where:async(predicate:unknown)=>m.update(value,predicate)})}),execute:m.execute,
},withDbAccessContext:async(_ctx:unknown,fn:()=>unknown)=>fn()}));
vi.mock('../../middleware/auth',()=>({dbAccessContextFromAuth:()=>({})}));
vi.mock('../m365ControlPlane/readActionService',()=>({executeM365ReadAction:m.read}));
vi.mock('../contacts/import',()=>({importDirectoryContact:m.import}));
vi.mock('./locks',()=>({withSubjectLocks:async(_db:unknown,ids:unknown,fn:()=>unknown)=>{m.locks(ids);return fn();}}));
import { directoryUsers,syncDirectory } from './directory';
import type { AuthContext } from '../../middleware/auth';
const org='11111111-1111-4111-8111-111111111111',tenant='22222222-2222-4222-8222-222222222222',oid='33333333-3333-4333-8333-333333333333';
const c={id:'44444444-4444-4444-8444-444444444444',orgId:org,tenantId:tenant,status:'active'};
const auth={scope:'organization',user:{id:oid},canAccessOrg:(id:string)=>id===org} as AuthContext;
beforeEach(()=>{vi.clearAllMocks();m.queue=[];m.read.mockResolvedValue({ok:true,kind:'collection',items:[{id:oid,userPrincipalName:'alex@example.com',displayName:'Alex'}],truncated:false});m.import.mockResolvedValue({id:oid});});
it('projects verified tenant and W04 envelope payload',async()=>{
 m.queue.push([c],[c]);expect(await directoryUsers(auth,org,'alex')).toEqual({available:true,truncated:false,users:[{entraTenantId:tenant,entraOid:oid,upn:'alex@example.com',displayName:'Alex'}]});
});
it('reports missing connection without Graph',async()=>{
 m.queue.push([]);expect(await directoryUsers(auth,org,'alex')).toEqual({available:false,users:[],truncated:false});expect(m.read).not.toHaveBeenCalled();
});
it.each([{...auth,allowedSiteIds:['site']},{...auth,canAccessOrg:()=>false}])('refuses restricted access',async restricted=>{
 await expect(directoryUsers(restricted as AuthContext,org,'alex')).rejects.toMatchObject({code:'not_found'});expect(m.read).not.toHaveBeenCalled();
});
it('rejects a tenant change during search',async()=>{
 m.queue.push([c],[{...c,tenantId:oid}]);await expect(directoryUsers(auth,org,'alex')).rejects.toMatchObject({code:'directory_changed'});
});
it('reconciles only absent identities under shared locks and preserves consumed history',async()=>{
 const missing='66666666-6666-4666-8666-666666666666';
 m.queue.push([c],[c],[c],[{id:missing,entraOid:missing},{id:oid,entraOid:oid}]);
 expect(await syncDirectory(auth,org,[{contactId:oid,entraOid:oid}])).toEqual({imported:1,revoked:1,complete:true});
 expect(m.import).toHaveBeenCalledWith(auth,{orgId:org,contactId:oid,directoryObjectId:oid,expectedTenantId:tenant},'directory_sync');
 expect(m.update).toHaveBeenCalledTimes(1);expect(m.locks).toHaveBeenCalledWith([missing]);
 const sqls=m.execute.mock.calls.map(([q])=>new PgDialect().sqlToQuery(q));
 const revoke=sqls.find(q=>q.sql.includes('UPDATE caller_verifications'))!;
 expect(revoke.sql).toContain('consumed_at IS NULL');expect(revoke.params).toEqual([org,missing,missing]);
});
it('does not reconcile partial pages',async()=>{
 m.queue.push([c],[c]);m.read.mockResolvedValue({ok:true,kind:'collection',items:[],truncated:true});
 expect(await syncDirectory(auth,org,[])).toEqual({imported:0,revoked:0,complete:false});expect(m.update).not.toHaveBeenCalled();
});
it.each(['graph','import','tenant'] as const)('never reconciles after %s failure',async failure=>{
 m.queue.push([c],[c],[failure==='tenant'?{...c,tenantId:oid}:c]);
 if(failure==='graph')m.read.mockResolvedValue({ok:false,message:'private provider detail'});
 if(failure==='import')m.import.mockRejectedValue(new Error('write failed'));
 await expect(syncDirectory(auth,org,[{contactId:oid,entraOid:oid}])).rejects.toThrow();expect(m.update).not.toHaveBeenCalled();
});
it('sanitizes upstream search failures',async()=>{
 m.queue.push([c]);m.read.mockResolvedValue({ok:false,message:'secret upstream response'});
 await expect(directoryUsers(auth,org,'alex')).rejects.toMatchObject({code:'directory_unavailable',message:'Directory read unavailable'});
});
```

Task 14 installs the following handlers after `orgPath`/`base` are declared. Import `z` from `zod` and `{directoryUsers,syncDirectory}` from `../services/callerVerification/directory`:

```ts
callerVerificationRoutes.get(`${orgPath}/caller-verification-directory-users`,...base,read,
 zValidator('query',z.object({search:z.string().trim().min(1).max(120).regex(/^[^"'\\]+$/)})),async c=>
 c.json({data:await directoryUsers(c.get('auth') as AuthContext,oid(c),c.req.valid('query').search)}));
callerVerificationRoutes.post(`${orgPath}/caller-verification-directory-sync`,...base,write,requireMfa(),
 zValidator('json',z.object({mappings:z.array(z.object({contactId:z.string().uuid(),entraOid:z.string().uuid()}).strict()).max(200)}).strict()),async c=>
 c.json({data:await syncDirectory(c.get('auth') as AuthContext,oid(c),c.req.valid('json').mappings)}));
```

Add these entries to `selfManagedDbContextRoutes.ts` along with the binding POST in Task 14; all DB phases above open explicit auth contexts and all Graph calls occur between them:

```ts
{method:'GET',pattern:/^\/api\/v1\/orgs\/[^/]+\/caller-verification-directory-users\/?$/},
{method:'POST',pattern:/^\/api\/v1\/orgs\/[^/]+\/caller-verification-directory-sync\/?$/},
```

Add to `selfManagedDbContextRoutes.test.ts`:

```ts
it.each([['GET','caller-verification-directory-users'],['POST','caller-verification-directory-sync']])('self-manages %s %s', (method,path)=>{
 expect(isSelfManagedDbContextRoute(method,`/api/v1/orgs/o/${path}`)).toBe(true);
 expect(isSelfManagedDbContextRoute(method==='GET'?'POST':'GET',`/api/v1/orgs/o/${path}`)).toBe(false);
});
```

Extend Task 14's `routes` matrix with these two entries:

```ts
['GET',`/orgs/${org}/caller-verification-directory-users?search=alex`],
['POST',`/orgs/${org}/caller-verification-directory-sync`],
```
 Those route additions are committed in Task 14, after `base` exists. Run the new service tests now with `cd apps/api && npx vitest run src/services/callerVerification/directory.test.ts`; include `directory.ts` and `directory.test.ts` in this task's commit.

- [ ] **Step 3b: Observe authenticated login telemetry independently of a challenge.** Modify `agent/internal/collectors/sessions.go`, `sessions_test.go`, `apps/api/src/routes/agents/schemas.ts`, `sessions.ts`, `sessions.test.ts`; create the two platform collector files and `services/callerVerification/loginObservation.ts`, `loginObservation.test.ts` below. Existing `Heartbeat.sendSessionInventory` in `agent/internal/heartbeat/heartbeat.go` already transmits and retries both slices; no new transport or helper message is introduced.

Add `Principal *SessionPrincipal` with JSON tag `json:"principal,omitempty"` to both `UserSession` and `UserSessionEvent`. Define the type and collector-local injection point (test instances inject; production instances use the OS reader, avoiding global mutable seams):

```go
type SessionPrincipal struct {
 SID string `json:"sid,omitempty"`
 UID *uint32 `json:"uid,omitempty"`
 Username string `json:"username"`
 UPN string `json:"upn,omitempty"`
}
// Add inside SessionCollector:
principalReader func(string, string, uint32) *SessionPrincipal
// Add method:
func (c *SessionCollector) readPrincipal(username, session string, uid uint32) *SessionPrincipal {
 if c.principalReader != nil { return c.principalReader(username, session, uid) }
 return principalForSession(username, session, uid)
}
```

In `refreshSessions`'s `UserSession` literal add `Principal:c.readPrincipal(detected.Username,detected.Session,detected.UID)`. At the start of `applyEvent`, before `c.mu.Lock`, compute the login evidence and use it in both that branch's `UserSession` literal and the appended `UserSessionEvent` literal:

```go
var principal *SessionPrincipal
if event.Type == sessionbroker.SessionLogin {
 principal = c.readPrincipal(event.Username, event.Session, event.UID)
}
// Add to both literals:
Principal: principal,
```

```go
// agent/internal/collectors/session_principal_windows.go
//go:build windows

package collectors

import (
 "strconv"
 "strings"
 "golang.org/x/sys/windows"
)

func principalForSession(username, session string, _ uint32) *SessionPrincipal {
 id, err := strconv.ParseUint(session, 10, 32)
 if err != nil { return nil }
 var token windows.Token
 if windows.WTSQueryUserToken(uint32(id), &token) != nil { return nil }
 defer token.Close()
 u, err := token.GetTokenUser()
 if err != nil { return nil }
 account, domain, _, err := u.User.Sid.LookupAccount("")
 if err != nil { return nil }
 canonical := account
 if domain != "" { canonical = domain + `\` + account }
 // WTSUserName supplies an unqualified name; token still comes from this session.
 if !strings.EqualFold(account, username) && !strings.EqualFold(canonical, username) { return nil }
 p := &SessionPrincipal{SID:u.User.Sid.String(), Username:username}
 upn, err := windows.TranslateAccountName(canonical, windows.NameSamCompatible, windows.NameUserPrincipal, 256)
 if err == nil { p.UPN = upn }
 return p
}
```

```go
// agent/internal/collectors/session_principal_unix.go
//go:build !windows

package collectors

func principalForSession(username, _ string, uid uint32) *SessionPrincipal {
 return &SessionPrincipal{UID:&uid, Username:username}
}
```

No Unix UPN is synthesized. Unavailable Windows tokens/UPNs also produce no binding observation; neither local account names nor email-like usernames prove directory identity. SID comes from the session token, not from caller-controlled fields. Add this test to existing `sessions_test.go` (imports `testing`, `time`, `encoding/json`, `sessionbroker` already exist):

```go
func TestLoginPrincipalSurvivesCollectionAndRetry(t *testing.T) {
 c := &SessionCollector{sessions:make(map[string]UserSession), principalReader:func(username, session string, uid uint32)*SessionPrincipal {
  return &SessionPrincipal{SID:"S-1-5-21-1", Username:username, UPN:"alex@example.com"}
 }}
 c.applyEvent(sessionbroker.SessionEvent{Type:sessionbroker.SessionLogin,Username:"alex",Session:"2"},time.Now())
 rows,err:=c.Collect()
 if err!=nil || len(rows)!=1 || rows[0].Principal==nil || rows[0].Principal.UPN!="alex@example.com" { t.Fatalf("rows=%+v err=%v",rows,err) }
 events:=c.DrainEvents(256)
 if len(events)!=1 || events[0].Principal==nil { t.Fatal("login identity missing") }
 c.RequeueEvents(events)
 again:=c.DrainEvents(256)
 if len(again)!=1 || again[0].Principal.SID!="S-1-5-21-1" { t.Fatal("retry lost principal") }
 encoded,err:=json.Marshal(again[0])
 if err!=nil { t.Fatal(err) }
 var wire struct { Principal *SessionPrincipal `json:"principal"` }
 if err=json.Unmarshal(encoded,&wire);err!=nil || wire.Principal==nil || wire.Principal.UPN!="alex@example.com" { t.Fatalf("wire=%s err=%v",encoded,err) }
}
```

Add the following schema before `submitSessionsSchema` and `principal:sessionPrincipalSchema.optional()` inside **both** nested session/event objects:

```ts
const sessionPrincipalSchema=z.object({
 sid:z.string().regex(/^S-\d(?:-\d+)+$/).max(184).optional(),
 uid:z.number().int().min(0).max(4294967295).optional(),
 username:z.string().min(1).max(255),upn:z.string().min(1).max(320).optional(),
}).refine(p=>(p.sid!==undefined)!==(p.uid!==undefined),'Exactly one SID or UID is required');
```

```ts
// loginObservation.ts
import { and,eq,isNotNull,isNull,sql } from 'drizzle-orm';
import { db,assertInTransaction } from '../../db';
import { callerVerificationSubjectBindings as b } from '../../db/schema/callerVerification';
import { observeLogin } from './subjects';
export type SessionPrincipal={sid?:string;uid?:number;username:string;upn?:string};
export async function observeSessionPrincipal(orgId:string,hostname:string,username:string,p:SessionPrincipal|undefined):Promise<void>{
 if(!p?.upn||p.username.toLowerCase()!==username.toLowerCase()||((p.sid!==undefined)===(p.uid!==undefined)))return;
 assertInTransaction('observeSessionPrincipal');
 await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`caller-identity:${orgId}`}))`);
 const rows=await db.select().from(b).where(and(eq(b.orgId,orgId),isNull(b.revokedAt),isNotNull(b.entraTenantId),isNotNull(b.entraOid),sql`lower(${b.upnSnapshot})=lower(${p.upn})`)).limit(2);
 if(rows.length!==1)return;
 await observeLogin({orgId,contactId:rows[0]!.contactId,osPrincipal:p.sid??`uid:${p.uid}@${hostname}`,osUsername:p.username,upn:p.upn});
}
```

The `observeLogin` implementation above also checks uniqueness across the entire org, including W02 calls with an explicit contact. Its identity namespace lock is acquired before subject locks. Directory import takes this namespace lock before `updateContact` can acquire a contact lock; this matches `applyDecision` → `handleRejection` and avoids a contact/identity lock inversion.

In `routes/agents/sessions.ts`, import `observeSessionPrincipal` from `../../services/callerVerification/loginObservation`. Immediately after the existing device-not-found return add:

```ts
if(agent?.agentId!==agentId||agent.orgId!==device.orgId)return c.json({error:'Device not found'},403);
```

After the existing `await db.transaction(...)` and before event publication, use the authenticated ambient transaction established by `agentAuth.ts` (the nested session transaction has released its savepoint, not committed the outer request). Do not swallow observation errors: fail the upload so the existing agent retry path retains the events. The binding helper is idempotent. This does not claim arbitrary JavaScript errors roll back all session inventory writes: the current agent-auth middleware awaits Hono `next()` without rethrowing `c.error`. Task 15 separately proves decision/receipt atomicity inside the explicit result transaction required by W02.

```ts
for(const session of activeSessions)await observeSessionPrincipal(device.orgId,device.hostname,session.username,session.principal);
for(const event of data.events??[])if(event.type==='login')await observeSessionPrincipal(device.orgId,device.hostname,event.username,event.principal);
```

```ts
// loginObservation.test.ts
import { beforeEach,expect,it,vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const m=vi.hoisted(()=>({rows:[] as {contactId:string}[],observe:vi.fn(),where:vi.fn()}));
vi.mock('../../db',()=>({assertInTransaction:vi.fn(),db:{execute:vi.fn(),select:()=>({from:()=>({where:(q:unknown)=>{m.where(q);return {limit:async()=>m.rows};}})})}}));
vi.mock('./subjects',()=>({observeLogin:m.observe}));
import { observeSessionPrincipal } from './loginObservation';
const org='11111111-1111-4111-8111-111111111111',contact='22222222-2222-4222-8222-222222222222';
const principal={sid:'S-1-5-21-1',username:'alex',upn:'alex@example.com'};
beforeEach(()=>{vi.clearAllMocks();m.rows=[];});
it.each([{rows:[]},{rows:[{contactId:contact},{contactId:org}]}])('ignores unmatched and ambiguous UPN',async({rows})=>{
 m.rows=rows;await observeSessionPrincipal(org,'host','alex',principal);expect(m.observe).not.toHaveBeenCalled();
});
it('resolves exactly one existing binding in the authenticated org',async()=>{
 m.rows=[{contactId:contact}];await observeSessionPrincipal(org,'host','alex',principal);
 expect(m.observe).toHaveBeenCalledWith({orgId:org,contactId:contact,osPrincipal:principal.sid,osUsername:'alex',upn:principal.upn});
 const query=new PgDialect().sqlToQuery(m.where.mock.calls[0]![0]);
 expect(query.sql).toContain('"org_id" =');expect(query.params).toContain(org);expect(query.sql).toContain('lower(');
});
it('never substitutes username or inconsistent principal',async()=>{
 await observeSessionPrincipal(org,'host','alex',{uid:0,username:'alex'});
 await observeSessionPrincipal(org,'host','alex',{uid:501,username:'mallory',upn:principal.upn});
 expect(m.observe).not.toHaveBeenCalled();expect(m.where).not.toHaveBeenCalled();
});
```

In existing `sessions.test.ts`, add `vi.mock('../../services/callerVerification/loginObservation',()=>({observeSessionPrincipal:vi.fn()}))` and its import. Before `app.route` in `beforeEach`, install `app.use('*',async(c,next)=>{c.set('agent',{agentId:AGENT_ID,orgId:'org-1'});await next();})`. Existing positive cases continue using their device/transaction mocks. Add inside the describe:

```ts
it('forwards independent login principal from an authenticated session report',async()=>{
 mockDeviceLookup();const principal={sid:'S-1-5-21-1',username:'alex',upn:'alex@example.com'};
 const response=await app.request(`/agents/${AGENT_ID}/sessions`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessions:[],events:[{type:'login',username:'alex',sessionType:'console',principal}]})});
 expect(response.status).toBe(200);
 expect(observeSessionPrincipal).toHaveBeenCalledWith('org-1','host-1','alex',principal);
});
it('refuses a token from another org before observation',async()=>{
 const foreign=new Hono();foreign.use('*',async(c,next)=>{c.set('agent',{agentId:AGENT_ID,orgId:'org-2'});await next();});foreign.route('/agents',sessionsRoutes);
 mockDeviceLookup();const response=await foreign.request(`/agents/${AGENT_ID}/sessions`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessions:[]})});
 expect(response.status).toBe(403);expect(observeSessionPrincipal).not.toHaveBeenCalled();expect(db.transaction).not.toHaveBeenCalled();
});
```

Run `(cd agent && go test -race ./internal/collectors/... ./internal/heartbeat/...)` and `(cd apps/api && npx vitest run src/services/callerVerification/loginObservation.test.ts src/routes/agents/sessions.test.ts)`. Compile the Windows collector in a Windows CI runner with `cd agent && go test -race ./internal/collectors/...`; a Unix-only pass does not exercise WTS. Task 15 adds live org-isolation/ambiguity and rollback evidence. Commit this extension explicitly after those unit suites:

```bash
git add agent/internal/collectors/sessions.go agent/internal/collectors/sessions_test.go agent/internal/collectors/session_principal_windows.go agent/internal/collectors/session_principal_unix.go apps/api/src/routes/agents/schemas.ts apps/api/src/routes/agents/sessions.ts apps/api/src/routes/agents/sessions.test.ts apps/api/src/services/callerVerification/loginObservation.ts apps/api/src/services/callerVerification/loginObservation.test.ts apps/api/src/services/callerVerification/subjects.ts
git commit -m "feat(caller-verification): observe directory-bound principals on login"
```

- [ ] **Step 4:** Run `cd apps/api && npx vitest run src/services/callerVerification/subjects.test.ts src/services/contacts/import.test.ts`. Expected: PASS with positive CSV creation and zero binding calls.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/callerVerification/directory.ts apps/api/src/services/callerVerification/directory.test.ts apps/api/src/services/callerVerification/subjects.ts apps/api/src/services/callerVerification/subjects.test.ts apps/api/src/services/contacts/import.ts apps/api/src/services/contacts/import.test.ts
git commit -m "feat(caller-verification): bind canonical subjects only from trusted evidence"
```

### Task 9: Shared Zod request contracts

**Files:** Create `packages/shared/src/validators/callerVerification.ts`, `packages/shared/src/validators/callerVerification.test.ts`; Modify `packages/shared/src/validators/index.ts:1209` (append export).

**Interfaces:** Produces `startCallerVerificationSchema`, `attestCallerVerificationSchema`, `callerVerificationBindingSchema`, `callerVerificationPolicySchema`, `callerVerificationFenceOverrideSchema`, `administrativeCallerVerificationSchema`, `callerVerificationMethodsQuerySchema`. Consumes existing contact role vocabulary: `billing`, `technical`, `escalation`, `admin`, `site`, `after_hours`, `portal` (`services/contacts/types.ts:55`).

- [ ] **Step 1: Write validator tests.**

```ts
import { expect,it } from 'vitest';
import { startCallerVerificationSchema as start,callerVerificationPolicySchema as policy,administrativeCallerVerificationSchema as admin } from './callerVerification';
const id='11111111-1111-4111-8111-111111111111';
it('requires an explicit workstation target and forbids administrative challenge starts',()=>{
 expect(start.safeParse({contactId:id,method:'workstation',actionScope:'reset_password'}).success).toBe(false);
 expect(start.safeParse({contactId:id,method:'workstation',actionScope:'reset_password',deviceId:id,username:'alice'}).success).toBe(true);
 expect(start.safeParse({contactId:id,method:'administrative_stepup',actionScope:'disable_user'}).success).toBe(false);
 expect(start.safeParse({contactId:'bad',method:'sms',actionScope:'any'}).success).toBe(false);
});
it('preserves null inheritance and boundary zero without silently defaulting a policy',()=>{
 expect(policy.parse({requiredTierResetPassword:0,allowedMethods:[],requireTicket:null})).toEqual({requiredTierResetPassword:0,allowedMethods:[],requireTicket:null});
 for(const v of [-1,4])expect(policy.safeParse({requiredTierResetPassword:v}).success).toBe(false);
 expect(policy.safeParse({allowedMethods:['administrative_stepup']}).success).toBe(false);
 expect(policy.safeParse({disableUserAuthorizerRoles:['it_admin']}).success).toBe(false);
 expect(policy.safeParse({verificationTtlMinutes:241}).success).toBe(false);
});
it('requires a meaningful administrative reason',()=>{
 expect(admin.safeParse({targetContactId:id,stepUpGrantId:id,reason:'short'}).success).toBe(false);
 expect(admin.safeParse({targetContactId:id,stepUpGrantId:id,reason:'Confirmed offboarding by HR.'}).success).toBe(true);
});
```

- [ ] **Step 2:** Run `cd packages/shared && npx vitest run src/validators/callerVerification.test.ts`. Expected: missing module.
- [ ] **Step 3: Implement and export.**

```ts
import { z } from 'zod';
const id=z.string().uuid();
const method=z.enum(['workstation','sms','email','callback_attestation']);
const action=z.enum(['reset_password','disable_user','any']);
const reason=z.string().trim().min(20).max(4000);
export const startCallerVerificationSchema=z.object({contactId:id,targetContactId:id.optional(),method,actionScope:action,deviceId:id.optional(),username:z.string().trim().min(1).max(255).optional(),ticketId:id.optional(),note:z.string().trim().max(4000).optional()}).strict().superRefine((v,c)=>{
 if(v.method==='workstation'&&(!v.deviceId||!v.username))c.addIssue({code:'custom',path:['deviceId'],message:'Workstation requires deviceId and username'});
 if(v.targetContactId&&v.targetContactId!==v.contactId&&v.actionScope!=='disable_user')c.addIssue({code:'custom',path:['targetContactId'],message:'Only disable_user permits a different target'});
});
export const attestCallerVerificationSchema=z.object({note:z.string().trim().min(20).max(4000)}).strict();
export const callerVerificationBindingSchema=z.object({entraTenantId:id,entraOid:id,upn:z.string().trim().max(320).nullable()}).strict();
export const callerVerificationFenceOverrideSchema=z.object({reason}).strict();
export const administrativeCallerVerificationSchema=z.object({targetContactId:id,reason,stepUpGrantId:id}).strict();
export const callerVerificationMethodsQuerySchema=z.object({actionScope:action.default('any')});
const nullable=<T extends z.ZodTypeAny>(s:T)=>s.nullable().optional();
export const callerVerificationPolicySchema=z.object({
 requiredTierResetPassword:nullable(z.number().int().min(0).max(3)),requiredTierDisableUser:nullable(z.number().int().min(0).max(3)),
 disableUserAuthorizerRoles:nullable(z.array(z.enum(['billing','technical','escalation','admin','site','after_hours','portal'])).max(7)),
 verificationTtlMinutes:nullable(z.number().int().min(5).max(240)),allowedMethods:nullable(z.array(method).max(4)),
 workstationTimeoutSeconds:nullable(z.number().int().min(30).max(300)),destinationMinAgeDays:nullable(z.number().int().min(0).max(90)),
 requireAttestedDestination:nullable(z.boolean()),requireTicket:nullable(z.boolean()),allowCrossTechnicianUse:nullable(z.boolean()),allowAdministrativeDisable:nullable(z.boolean()),
 maxAttemptsPerHour:nullable(z.number().int().min(1).max(100)),coolingOffHours:nullable(z.number().int().min(1).max(720)),
}).strict();
```

Append `export * from './callerVerification';` to `validators/index.ts`.

- [ ] **Step 4:** Run `cd packages/shared && npx vitest run src/validators/callerVerification.test.ts && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add packages/shared/src/validators/callerVerification.ts packages/shared/src/validators/callerVerification.test.ts packages/shared/src/validators/index.ts
git commit -m "feat(shared): validate caller verification requests and policy patches"
```

### Task 10: Ordered release gate with single-use consume CAS

**Files:** Create `apps/api/src/services/callerVerification/gate.ts`, `apps/api/src/services/callerVerification/gate.test.ts`.

**Interfaces:** `GateInput { orgId: string; action: CallerVerificationAction; target: EntraSubject; backendTenantId: string; technicianUserId: string; intentId: string; mode: 'check' | 'consume' }`; `requireCallerVerification(input: GateInput): Promise<{ verificationId: string; tier: number }>`; `isCallerVerificationEnabled(): boolean`; internal `fencedUntil(orgId: string, contactId: string, policy: EffectiveCallerVerificationPolicy): Promise<Date | null>`. Tier-zero returns `{verificationId:'',tier:0}` as an explicit bypass result; W05 must not mistake it for a consumed grant.

- [ ] **Step 1: Test order and default adapter behavior.**

```ts
import { beforeEach,expect,it,vi } from 'vitest';
const m=vi.hoisted(()=>({policy:vi.fn(),resolve:vi.fn(),destination:vi.fn(),mailboxes:vi.fn(),eligible:vi.fn(),results:[] as unknown[][]}));
vi.mock('./policy',()=>({getEffectivePolicy:m.policy}));
vi.mock('./subjects',()=>({resolveTargetBinding:m.resolve}));
vi.mock('./locks',()=>({withSubjectLocks:(_db:unknown,_ids:unknown,f:()=>unknown)=>f()}));
vi.mock('./ports',()=>({callerVerificationPorts:{mailboxes:m.mailboxes,administrativeEligible:m.eligible}}));
vi.mock('./destinations',async original=>({...await original<typeof import('./destinations')>(),currentDestination:m.destination,isEstablished:()=>true}));
vi.mock('../../db',()=>{const chain:any={};for(const name of ['select','from','where','orderBy','limit','update','set','returning'])chain[name]=()=>chain;chain.then=(f:any)=>Promise.resolve(m.results.shift()??[]).then(f);return {runOutsideDbContext:(f:()=>unknown)=>f(),withSystemDbAccessContext:(f:()=>unknown)=>f(),db:chain};});
import { requireCallerVerification } from './gate';
import { destinationHash } from './destinations';
const input={orgId:'11111111-1111-4111-8111-111111111111',action:'reset_password' as const,target:{entraTenantId:'tenant',entraOid:'oid'},backendTenantId:'wrong',technicianUserId:'22222222-2222-4222-8222-222222222222',intentId:'33333333-3333-4333-8333-333333333333',mode:'consume' as const};
it('checks flag, then tier zero, then backend tenant, before resolving subject',async()=>{
 vi.stubEnv('CALLER_VERIFICATION_ENABLED','false');await expect(requireCallerVerification(input)).rejects.toMatchObject({payload:{reason:'feature_disabled'}});expect(m.policy).not.toHaveBeenCalled();
 vi.stubEnv('CALLER_VERIFICATION_ENABLED','true');m.policy.mockResolvedValue({requiredTierResetPassword:0});expect(await requireCallerVerification(input)).toEqual({verificationId:'',tier:0});expect(m.resolve).not.toHaveBeenCalled();
 m.policy.mockResolvedValue({requiredTierResetPassword:2});await expect(requireCallerVerification(input)).rejects.toMatchObject({payload:{reason:'tenant_mismatch'}});expect(m.resolve).not.toHaveBeenCalled();
});
const policy={requiredTierResetPassword:1,requiredTierDisableUser:1,verificationTtlMinutes:30,coolingOffHours:24,allowedMethods:['workstation','sms','email','callback_attestation'],allowCrossTechnicianUse:false,allowAdministrativeDisable:true,disableUserAuthorizerRoles:['admin'],destinationMinAgeDays:7,requireAttestedDestination:false};
const binding={id:'44444444-4444-4444-8444-444444444444',orgId:input.orgId,contactId:'55555555-5555-4555-8555-555555555555',entraTenantId:'tenant',entraOid:'oid',osPrincipal:'sid',revokedAt:null};
function candidate(patch:Record<string,unknown>={}){return {id:'66666666-6666-4666-8666-666666666666',orgId:input.orgId,contactId:binding.contactId,requesterBindingId:binding.id,targetBindingId:binding.id,targetEntraTenantId:'tenant',targetEntraOid:'oid',status:'verified',method:'callback_attestation',actionScope:'reset_password',initiatedByUserId:input.technicianUserId,decidedAt:new Date(),consumedAt:null,consumedIntentRef:null,destinationId:'destination',workstationDeviceRef:'77777777-7777-4777-8777-777777777777',...patch};}
beforeEach(()=>{vi.clearAllMocks();m.results.length=0;vi.stubEnv('CALLER_VERIFICATION_ENABLED','true');m.policy.mockResolvedValue({...policy});m.resolve.mockResolvedValue(binding);m.eligible.mockResolvedValue(true);m.mailboxes.mockResolvedValue(['other@example.com']);m.destination.mockResolvedValue({id:'destination',valueHash:destinationHash('caller@example.com')});});
function seed(row:ReturnType<typeof candidate>,devicePresent=true){m.results.push([row],[],[],[],[row],[],[binding],[{id:binding.contactId,siteId:null,roles:['admin']}],...(row.method==='workstation'?[devicePresent?[{id:row.workstationDeviceRef}]:[]]:[]),[{id:row.id}]);}
it.each([
 [{consumedAt:new Date(),consumedIntentRef:'other'},'grant_consumed'],
 [{targetEntraOid:'substituted'},'target_rebound'],
 [{initiatedByUserId:'other'},'technician_mismatch'],
 [{decidedAt:new Date(0)},'no_fresh_verification'],
] as const)('refuses changed candidate %j without consuming',async(patch,reason)=>{
 seed(candidate(patch));await expect(requireCallerVerification({...input,backendTenantId:'tenant'})).rejects.toMatchObject({payload:{reason}});
});
it('does not elevate unbound workstation even if its stored tier was 3',async()=>{
 m.policy.mockResolvedValue({...policy,requiredTierResetPassword:2});seed(candidate({method:'workstation',tier:3,osPrincipalObserved:null}));
 await expect(requireCallerVerification({...input,backendTenantId:'tenant'})).rejects.toMatchObject({payload:{reason:'no_fresh_verification'}});
});
it('refuses a moved workstation even for same-intent consumed retry',async()=>{
 seed(candidate({method:'workstation',consumedAt:new Date(),consumedIntentRef:input.intentId}),false);
 await expect(requireCallerVerification({...input,backendTenantId:'tenant'})).rejects.toMatchObject({payload:{reason:'target_rebound'}});
});
it('email mailbox uncertainty refuses while callback needs no mailbox read',async()=>{
 m.mailboxes.mockRejectedValue(new Error('offline'));seed(candidate({method:'email'}));await expect(requireCallerVerification({...input,backendTenantId:'tenant'})).rejects.toMatchObject({payload:{reason:'subject_mailboxes_unknown'}});
 m.results.length=0;m.mailboxes.mockClear();const row=candidate();seed(row);expect(await requireCallerVerification({...input,backendTenantId:'tenant'})).toEqual({verificationId:row.id,tier:1});expect(m.mailboxes).not.toHaveBeenCalled();
});
it('same mailbox aliases and removed methods cannot supply assurance',async()=>{
 m.mailboxes.mockResolvedValue(['SMTP:Caller@example.com']);seed(candidate({method:'email'}));await expect(requireCallerVerification({...input,backendTenantId:'tenant'})).rejects.toMatchObject({payload:{reason:'no_fresh_verification'}});
 m.results.length=0;m.policy.mockResolvedValue({...policy,allowedMethods:[]});seed(candidate());await expect(requireCallerVerification({...input,backendTenantId:'tenant'})).rejects.toMatchObject({payload:{reason:'no_fresh_verification'}});
});
it('invalidated administrative proof refuses before any consume',async()=>{
 const row=candidate({method:'administrative_stepup',actionScope:'disable_user',requesterBindingId:null,stepupVerifiedAt:new Date()});seed(row);m.eligible.mockResolvedValue(false);
 await expect(requireCallerVerification({...input,action:'disable_user',backendTenantId:'tenant'})).rejects.toMatchObject({payload:{reason:'stepup_invalidated'}});
});

```

- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/callerVerification/gate.test.ts`. Expected: missing gate.
- [ ] **Step 3: Implement in the spec's exact order.** The system context is an internal gate boundary; inputs must be server-resolved by W05, never accepted from a public consume route. Mailbox I/O takes place between short system transactions. For a caller already in a request transaction, W05 must invoke after that outer transaction closes; `runOutsideDbContext` alone does not commit an outer transaction.

```ts
import { and,eq,desc,sql,isNull } from 'drizzle-orm';
import { db,runOutsideDbContext,withSystemDbAccessContext } from '../../db';
import { callerVerifications as v,callerVerificationSubjectBindings as b } from '../../db/schema/callerVerification';
import { contacts } from '../../db/schema/contacts';
import { devices } from '../../db/schema/devices';
import { callerVerificationEnabled } from '../../config/env';
import type { CallerVerificationAction,EntraSubject,VerificationRow } from './types';
import { CallerVerificationRequiredError, type CallerVerificationRefusal } from './errors';
import { getEffectivePolicy,type EffectiveCallerVerificationPolicy } from './policy';
import { resolveTargetBinding } from './subjects';
import { currentDestination,isEstablished,destinationHash,normalizeDestination } from './destinations';
import { requesterAuthorized } from './access';
import { computeTier } from './tiers';
import { withSubjectLocks } from './locks';
import { callerVerificationPorts as ports } from './ports';
export interface GateInput {orgId:string;action:CallerVerificationAction;target:EntraSubject;backendTenantId:string;technicianUserId:string;intentId:string;mode:'check'|'consume'}
export function isCallerVerificationEnabled(): boolean { return callerVerificationEnabled(); }
export async function fencedUntil(orgId:string,contactId:string,policy:EffectiveCallerVerificationPolicy):Promise<Date|null>{
 const rows=await db.select().from(v).where(and(eq(v.orgId,orgId),eq(v.contactId,contactId),eq(v.status,'rejected_by_user')));
 const times=rows.filter(r=>r.decidedAt&&(!r.fenceOverrideUntil||r.fenceOverrideUntil.getTime()<=Date.now())).map(r=>r.decidedAt!.getTime()+policy.coolingOffHours*3600000).filter(n=>n>Date.now());
 return times.length?new Date(Math.max(...times)):null;
}
export async function requireCallerVerification(input:GateInput):Promise<{verificationId:string;tier:number}>{
 let latest:VerificationRow|null=null,requiredTier=2,contactId:string|null=null;
 const refuse=(reason:CallerVerificationRefusal):never=>{throw new CallerVerificationRequiredError({orgId:input.orgId,contactId,action:input.action,requiredTier,reason,latest:latest?{id:latest.id,status:latest.status,method:latest.method,decidedAt:latest.decidedAt?.toISOString()??null}:null});};
 if(!isCallerVerificationEnabled())refuse('feature_disabled');
 return runOutsideDbContext(async()=>{
  const initial=await withSystemDbAccessContext(async()=>{
   const p=await getEffectivePolicy(input.orgId);requiredTier=input.action==='reset_password'?p.requiredTierResetPassword:p.requiredTierDisableUser;
   if(requiredTier===0)return {p,target:null,rows:[] as VerificationRow[]};
   if(input.backendTenantId!==input.target.entraTenantId)refuse('tenant_mismatch');
   let target;try{target=await resolveTargetBinding(input.orgId,input.target);}catch(e){
    if(e instanceof CallerVerificationRequiredError){
     const [historical]=await db.select().from(v).where(and(eq(v.orgId,input.orgId),eq(v.targetEntraTenantId,input.target.entraTenantId),eq(v.targetEntraOid,input.target.entraOid))).orderBy(desc(v.createdAt)).limit(1);
     latest=historical??null;if(historical)refuse('target_rebound');refuse(e.payload.reason);
    }throw e;
   }
   contactId=target.contactId;
   const rows=await db.select().from(v).where(and(eq(v.orgId,input.orgId),eq(v.targetBindingId,target.id))).orderBy(desc(v.createdAt));
   latest=rows[0]??null;
   await withSubjectLocks(db,[target.id,...rows.filter(r=>r.status==='verified').map(r=>r.requesterBindingId)],async()=>{
    if(await fencedUntil(input.orgId,target.contactId,p))refuse('contact_fenced');
    for(const row of rows.filter(r=>r.status==='verified'))if(await fencedUntil(input.orgId,row.contactId,p))refuse('contact_fenced');
   });return {p,target,rows};
  },'callerVerification.gate.prepare');
  if(!initial.target)return {verificationId:'',tier:0};
  // Fetch only for email candidates. Failures are remembered, not applied to unrelated methods.
  let mailboxHashes:Set<string>|null=null;
  if(initial.rows.some(r=>r.status==='verified'&&r.method==='email')){
   try{mailboxHashes=new Set((await ports.mailboxes({orgId:input.orgId,target:input.target})).map(a=>a.replace(/^smtp:/i,'')).map(a=>normalizeDestination('email',a)).filter((a):a is string=>!!a).map(destinationHash));}catch{mailboxHashes=null;}
  }
  let reason:CallerVerificationRefusal='no_fresh_verification';
  for(const candidate of initial.rows){
   const result=await withSystemDbAccessContext(()=>withSubjectLocks(db,[candidate.requesterBindingId,initial.target!.id],async()=>{
    // The policy, binding, roles, destinations and fence are current under the consume locks.
    const p=await getEffectivePolicy(input.orgId);requiredTier=input.action==='reset_password'?p.requiredTierResetPassword:p.requiredTierDisableUser;
    if(requiredTier===0)return {verificationId:'',tier:0};
    const target=await resolveTargetBinding(input.orgId,input.target);
    if(await fencedUntil(input.orgId,target.contactId,p))refuse('contact_fenced');
    const [r]=await db.select().from(v).where(and(eq(v.orgId,input.orgId),eq(v.id,candidate.id))).limit(1);if(!r)return null;latest=r;
    if(await fencedUntil(input.orgId,r.contactId,p))refuse('contact_fenced');
    if(r.status!=='verified'){if(r.status==='revoked')reason='target_rebound';return null;}
    if(r.targetBindingId!==target.id||r.targetEntraTenantId!==input.target.entraTenantId||r.targetEntraOid!==input.target.entraOid){reason='target_rebound';return null;}
    if(r.consumedAt&&r.consumedIntentRef!==input.intentId){reason='grant_consumed';return null;}
    if(r.actionScope!==input.action&&r.actionScope!=='any')return null;
    if(!p.allowCrossTechnicianUse&&r.initiatedByUserId!==input.technicianUserId){reason='technician_mismatch';return null;}
    let bound=false,destinationEstablished=false;
    if(r.method==='administrative_stepup'){
     if(input.action!=='disable_user'||r.actionScope!=='disable_user')return null;
     if(!p.allowAdministrativeDisable){reason='administrative_disabled';return null;}
     if(!r.stepupVerifiedAt||r.stepupVerifiedAt.getTime()<=Date.now()-p.verificationTtlMinutes*60000||!(await ports.administrativeEligible(r))){reason='stepup_invalidated';return null;}
    }else{
     if(!r.decidedAt||r.decidedAt.getTime()<=Date.now()-p.verificationTtlMinutes*60000)return null;
     const [requester]=r.requesterBindingId?await db.select().from(b).where(and(eq(b.id,r.requesterBindingId),eq(b.orgId,input.orgId),isNull(b.revokedAt))).limit(1):[];
     if(!requester){reason='subject_unmatched';return null;}
     const [contact]=await db.select().from(contacts).where(and(eq(contacts.id,r.contactId),eq(contacts.orgId,input.orgId))).limit(1);
     if(!contact||!requesterAuthorized(input.action,requester,target,contact,p.disableUserAuthorizerRoles)){reason='requester_not_authorized';return null;}
     bound=!!r.osPrincipalObserved&&requester.osPrincipal===r.osPrincipalObserved;
     if(r.method==='workstation'){
      const [device]=r.workstationDeviceRef?await db.select({id:devices.id}).from(devices).where(and(eq(devices.id,r.workstationDeviceRef),eq(devices.orgId,input.orgId))).limit(1):[];
      if(!device){reason='target_rebound';return null;}
     }
     if(r.method==='sms'||r.method==='email'){
      const d=await currentDestination(input.orgId,r.contactId,r.method==='sms'?'mobile':'email');
      if(!d||d.id!==r.destinationId)return null;destinationEstablished=isEstablished(d,p);
      if(r.method==='email'){
       if(mailboxHashes===null){reason='subject_mailboxes_unknown';return null;}
       if(mailboxHashes.has(d.valueHash))return null;
      }
     }
    }
    const tier=computeTier({method:r.method,boundPrincipal:bound,destinationEstablished,policy:p}).tier;if(tier<requiredTier)return null;
    if(input.mode==='consume'&&!r.consumedAt){
     const changed=await db.update(v).set({consumedAt:new Date(),consumedIntentRef:input.intentId}).where(and(eq(v.id,r.id),eq(v.orgId,input.orgId),eq(v.status,'verified'),isNull(v.consumedAt))).returning({id:v.id});
     if(!changed.length){reason='grant_consumed';return null;}
    }
    return {verificationId:r.id,tier};
   }),'callerVerification.gate.consume');
   if(result)return result;
  }
  // No grant must not suppress an existing target fence.
  await withSystemDbAccessContext(()=>withSubjectLocks(db,[initial.target!.id],async()=>{if(await fencedUntil(input.orgId,initial.target!.contactId,initial.p))refuse('contact_fenced');}),'callerVerification.gate.empty');
  return refuse(reason);
 });
}
```

Before selecting each candidate, fence checks precede candidate eligibility. Administrative branch skips requester/destination/allowed-method checks but retains target/fence/technician/action/consume checks. The injected eligibility checker must perform only DB/session-state checks, no interactive factor prompt. Recomputed tier never trusts `row.tier`. A refusal leaves `consumed_at` unchanged. Same-intent retry returns the same grant. W05's backend dispatch additionally requires the row already be consumed by its intent, and uses these locks for `dispatch_started_at`.

- [ ] **Step 4:** Run `cd apps/api && npx vitest run src/services/callerVerification/gate.test.ts src/services/callerVerification/policy.test.ts src/services/callerVerification/tiers.test.ts`. Expected: PASS; Task 15 supplies the two-transaction consume race. The concrete unit matrix covers policy/tier/subject/technician/email/admin refusals; the live suite supplies ownership and retry semantics.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/callerVerification/gate.ts apps/api/src/services/callerVerification/gate.test.ts
git commit -m "feat(caller-verification): enforce current assurance and single-use grants"
```

### Task 11: Fence-first rejection, ticket effects and durable notifications

**Files:** Create `apps/api/src/services/callerVerification/rejection.ts`, `apps/api/src/services/callerVerification/effects.ts`, `apps/api/src/services/callerVerification/rejection.test.ts`, `apps/api/src/services/actionIntents/revokeIntentsForSubject.ts`; Modify `apps/api/src/services/ticketService.ts:125,1300`, `apps/api/src/services/ticketEvents.ts:43`, `apps/api/src/jobs/ticketOutboxPublisher.ts:180`.

**Interfaces:** `handleRejection(verificationId: string): Promise<void>`; `fenceOverride(actor: CallerVerificationActor, orgId: string, contactId: string, reason: string): Promise<void>`; internal `recordEffect(row: VerificationRow, event: string, actorUserId?: string): Promise<void>`; new `addCallerVerificationSystemComment(input: { orgId: string; ticketId: string; verificationId: string; event: string }): Promise<void>`. Consumes `revokeIntentsForSubject(input: { orgId: string; bindingIds: string[]; verificationId: string }): Promise<{ cancelled: string[]; alreadyExecuting: string[]; alreadyDispatched: string[] }>` and produces its mandated W05 stub. Uses `incidents.sourceType/sourceRef` (`incidentResponse.ts:61`), `createNotification(input: CreateNotificationInput): Promise<string|null>` (`userNotifications.ts:66`) and `getEmailService()?.sendEmail(params)` (`email.ts:240,409`).

- [ ] **Step 1: Write a sequence/idempotency test using Drizzle mocks.**

```ts
import { expect,it,vi } from 'vitest';
const state=vi.hoisted(()=>({status:'expired',calls:[] as string[]}));
vi.mock('./effects',()=>({recordEffect:async()=>{state.calls.push('audit-ticket');}}));
vi.mock('../actionIntents/revokeIntentsForSubject',()=>({revokeIntentsForSubject:async()=>{state.calls.push('revoke-intents');return {cancelled:[],alreadyExecuting:['e'],alreadyDispatched:['d']};}}));
vi.mock('./policy',()=>({getEffectivePolicy:async()=>({coolingOffHours:24})}));
vi.mock('../../db',()=>({assertInTransaction:vi.fn(),db:{
 execute:async()=>[],
 select:()=>({from:()=>({where:()=>({limit:async()=>[{id:'11111111-1111-4111-8111-111111111111',orgId:'22222222-2222-4222-8222-222222222222',contactId:'33333333-3333-4333-8333-333333333333',status:state.status,requesterBindingId:null,targetBindingId:null}],then:(f:any)=>Promise.resolve([]).then(f)})})}),
 update:()=>({set:(v:any)=>{state.calls.push(v.status==='rejected_by_user'?'fence':'revoke-grants');if(v.status==='rejected_by_user')state.status=v.status;return {where:()=>({returning:async()=>[{id:'11111111-1111-4111-8111-111111111111',orgId:'22222222-2222-4222-8222-222222222222',contactId:'33333333-3333-4333-8333-333333333333',status:state.status}],then:(f:any)=>Promise.resolve([]).then(f)})};}}),
 insert:()=>({values:()=>{state.calls.push('incident');return {onConflictDoNothing:async()=>[]};}}),
}}));
import { handleRejection } from './rejection';
it('fences before incident/revocation and retries without duplicate effects',async()=>{
 await handleRejection('11111111-1111-4111-8111-111111111111');
 expect(state.calls.slice(0,5)).toEqual(['fence','incident','revoke-grants','revoke-intents','audit-ticket']);
 const n=state.calls.length;await handleRejection('11111111-1111-4111-8111-111111111111');expect(state.calls).toHaveLength(n);
});
```

- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/callerVerification/rejection.test.ts`. Expected: missing module.
- [ ] **Step 3: Implement rejection and override.** Create the mandated W05 intent-revocation seam first:

```ts
// services/actionIntents/revokeIntentsForSubject.ts — the only intentional no-op, mandated W05 seam:
export async function revokeIntentsForSubject(input:{orgId:string;bindingIds:string[];verificationId:string}):Promise<{cancelled:string[];alreadyExecuting:string[];alreadyDispatched:string[]}>{
 void input;return {cancelled:[],alreadyExecuting:[],alreadyDispatched:[]};
}
```

 The fence is the row's status/decision timestamp, written first in the same transaction. Gather every target of an outstanding requester grant before locks, then lock the sorted union. The contact lock blocks new starts while that set is gathered.

```ts
// rejection.ts
import { and,eq,ne,isNull,or,sql } from 'drizzle-orm';
import { db,assertInTransaction } from '../../db';
import { callerVerifications as v,callerVerificationSubjectBindings as b } from '../../db/schema/callerVerification';
import { incidents } from '../../db/schema/incidentResponse';
import type { CallerVerificationActor } from './types';
import { CallerVerificationValidationError as Invalid } from './errors';
import { getEffectivePolicy } from './policy';
import { lockContact,withSubjectLocks } from './locks';
import { reachableContact } from './access';
import { recordEffect } from './effects';
import { revokeIntentsForSubject } from '../actionIntents/revokeIntentsForSubject';
export async function handleRejection(verificationId:string):Promise<void>{
 assertInTransaction('handleRejection');
 const [initial]=await db.select().from(v).where(eq(v.id,verificationId)).limit(1);if(!initial)throw new Invalid('not_found','Verification not found');
 await lockContact(initial.orgId,initial.contactId);
 const grants=await db.select().from(v).where(and(eq(v.orgId,initial.orgId),eq(v.contactId,initial.contactId)));
 const bindings=await db.select().from(b).where(and(eq(b.orgId,initial.orgId),eq(b.contactId,initial.contactId)));
 const ids=[...bindings.map(r=>r.id),...grants.flatMap(r=>[r.requesterBindingId,r.targetBindingId])];
 await withSubjectLocks(db,ids,async()=>{
  const [fresh]=await db.select().from(v).where(eq(v.id,verificationId)).limit(1);if(!fresh||fresh.status==='rejected_by_user')return;
  const [row]=await db.update(v).set({status:'rejected_by_user',decidedAt:new Date(),fenceOverrideUntil:null,rejectionNotifiedAt:null}).where(and(eq(v.id,verificationId),ne(v.status,'rejected_by_user'))).returning();if(!row)return;
  await db.insert(incidents).values({orgId:row.orgId,title:'Caller denied an identity-change request',classification:'social_engineering',severity:'p2',status:'detected',sourceType:'caller_verification',sourceRef:row.id,affectedUsers:[row.contactId],detectedAt:new Date(),summary:'Caller selected This is not me. Review related identity actions.'}).onConflictDoNothing({target:[incidents.orgId,incidents.sourceType,incidents.sourceRef],where:sql`${incidents.sourceRef} IS NOT NULL`});
  await db.update(v).set({status:'revoked'}).where(and(eq(v.orgId,row.orgId),ne(v.id,row.id),eq(v.status,'verified'),isNull(v.consumedAt),or(eq(v.contactId,row.contactId),sql`${v.targetBindingId} IN (SELECT id FROM caller_verification_subject_bindings WHERE contact_id=${row.contactId}::uuid AND org_id=${row.orgId}::uuid)`)));
  const outcome=await revokeIntentsForSubject({orgId:row.orgId,bindingIds:bindings.map(r=>r.id),verificationId:row.id});
  await recordEffect(row,'rejected');
  await db.execute(sql`UPDATE incidents SET summary=${`Caller rejection fenced the subject. Already executing: ${outcome.alreadyExecuting.join(', ')||'none'}. Dispatched before rejection; confirm in Entra whether the change landed: ${outcome.alreadyDispatched.join(', ')||'none'}.`}
   WHERE org_id=${row.orgId}::uuid AND source_type='caller_verification' AND source_ref=${row.id}`);
 });
}
export async function fenceOverride(actor:CallerVerificationActor,orgId:string,contactId:string,reason:string):Promise<void>{
 if(reason.trim().length<20)throw new Invalid('invalid_reason','Override reason must contain at least 20 characters');
 await reachableContact(actor,orgId,contactId);await lockContact(orgId,contactId);
 const bindings=await db.select().from(b).where(and(eq(b.orgId,orgId),eq(b.contactId,contactId))),p=await getEffectivePolicy(orgId);
 await withSubjectLocks(db,bindings.map(r=>r.id),async()=>{
  await db.update(v).set({fenceOverrideUntil:sql`${v.decidedAt}+(${p.coolingOffHours}*interval '1 hour')`}).where(and(eq(v.orgId,orgId),eq(v.contactId,contactId),eq(v.status,'rejected_by_user')));
  await db.execute(sql`INSERT INTO audit_logs(org_id,actor_type,actor_id,action,resource_type,resource_id,result,details) VALUES(${orgId}::uuid,'user',${actor.userId}::uuid,'caller_verification.fence_override','caller_verification',${contactId}::uuid,'success',${JSON.stringify({reason:reason.trim()})}::jsonb)`);
 });
}
// effects.ts
import { sql } from 'drizzle-orm';
import { db,assertInTransaction } from '../../db';
import type { VerificationRow } from './types';
import { addCallerVerificationSystemComment } from '../ticketService';
export async function recordEffect(row:VerificationRow,event:string,actorUserId?:string):Promise<void>{
 assertInTransaction('callerVerification.recordEffect');
 await db.execute(sql`INSERT INTO audit_logs(org_id,actor_type,actor_id,action,resource_type,resource_id,result,details)
 VALUES(${row.orgId}::uuid,${actorUserId?'user':'system'}::actor_type,${actorUserId??'00000000-0000-0000-0000-000000000000'}::uuid,${`caller_verification.${event}`},'caller_verification',${row.id}::uuid,'success',${JSON.stringify({initiatedByUserId:row.initiatedByUserId,method:row.method,status:row.status,targetEntraTenantId:row.targetEntraTenantId,targetEntraOid:row.targetEntraOid,reason:row.reason})}::jsonb)`);
 if(row.ticketRef)await addCallerVerificationSystemComment({orgId:row.orgId,ticketId:row.ticketRef,verificationId:row.id,event});
}
```

In `ticketService.ts` add this exported helper. Reuse its existing `writeTicketOutbox`; no audit helper that opens another transaction. Ticket deletion/movement after a snapshot must not block rejection: return when the current ticket no longer belongs to the org.

```ts
export async function addCallerVerificationSystemComment(input:{orgId:string;ticketId:string;verificationId:string;event:string}):Promise<void>{
 const [ticket]=await db.select().from(tickets).where(and(eq(tickets.id,input.ticketId),eq(tickets.orgId,input.orgId))).limit(1);if(!ticket)return;
 const [comment]=await db.insert(ticketComments).values({ticketId:ticket.id,userId:null,portalUserId:null,authorName:'Breeze',authorType:'internal',commentType:'system',originPrincipalKind:'system',content:`Caller verification ${input.event} (${input.verificationId})`,isPublic:false}).returning({id:ticketComments.id});
 await writeTicketOutbox(input.orgId,ticket.id,'ticket.commented',{commentId:comment!.id,isPublic:false,verificationId:input.verificationId,partnerId:ticket.partnerId,event:input.event});
}
```

The caller's transition CAS is this helper's idempotency boundary: only a successful transition invokes it, and it shares the transaction. Add `verificationId?: string` to `TicketEvent`'s `ticket.commented` payload at `ticketEvents.ts:43`. In `ticketOutboxPublisher.ts:200`, inside `publishClaimedRows`' existing try block and before pushing the published ID, emit the caller event after commit:

```ts
if(row.event_type==='ticket.commented'&&typeof row.payload?.verificationId==='string'&&typeof row.payload?.commentId==='string'){
 await emitTicketEvent({type:'ticket.commented',ticketId:row.ticket_id,orgId:row.org_id,partnerId:typeof row.payload.partnerId==='string'?row.payload.partnerId:null,
  eventId:`caller-${row.payload.verificationId}-${String(row.payload.event)}`,payload:{commentId:row.payload.commentId,isPublic:false,verificationId:row.payload.verificationId}});
}
```

Import `emitTicketEvent` from `../services/ticketEvents`. The existing event outbox remains the durable source; `emitTicketEvent` itself is best-effort and never the transaction boundary.

No security-recipient resolver exists. Add `securityRecipients(orgId:string): Promise<Array<{id:string;email:string}>>` in `effects.ts`: select active org members or partner members whose actual role grants `alerts:read` (the existing incident-read permission at `routes/incidents.ts:37`) (including explicit wildcard grants), requiring partner `orgAccess='all'` or an explicit selected org. Exclude site-constrained org members from org-wide incident detail. This is the smallest existing-permissions-based recipient rule, not a new preference setting.

```ts
export async function securityRecipients(orgId:string):Promise<Array<{id:string;email:string}>>{
 const rows=await db.execute(sql`SELECT DISTINCT u.id,u.email FROM users u WHERE u.status='active' AND EXISTS (
  SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id
  WHERE p.resource IN ('alerts','*') AND p.action IN ('read','*') AND (
   EXISTS(SELECT 1 FROM organization_users ou WHERE ou.user_id=u.id AND ou.org_id=${orgId}::uuid AND ou.role_id=rp.role_id AND ou.site_ids IS NULL)
   OR EXISTS(SELECT 1 FROM partner_users pu JOIN organizations o ON o.partner_id=pu.partner_id WHERE o.id=${orgId}::uuid AND pu.user_id=u.id AND pu.role_id=rp.role_id AND (pu.org_access='all' OR (pu.org_access='selected' AND o.id=ANY(pu.org_ids))))))`);
 return rows as unknown as Array<{id:string;email:string}>;
}
```

- [ ] **Step 4:** Run `cd apps/api && npx vitest run src/services/callerVerification/rejection.test.ts src/services/ticketEvents.test.ts src/services/ticketEventsContract.test.ts`. Expected: PASS. Rejection's live transaction test also asserts one incident, one rejection audit, one ticket comment on retry; in-app fan-out uses existing dedupe behavior from `userNotifications.test.ts`.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/callerVerification/rejection.ts apps/api/src/services/callerVerification/effects.ts apps/api/src/services/callerVerification/rejection.test.ts apps/api/src/services/actionIntents/revokeIntentsForSubject.ts apps/api/src/services/ticketService.ts apps/api/src/services/ticketEvents.ts apps/api/src/jobs/ticketOutboxPublisher.ts
git commit -m "feat(caller-verification): fence rejected subjects and publish security effects"
```

### Task 12: Start workflow, private read models, ticket validation and availability

**Files:** Create `apps/api/src/services/callerVerification/service.ts`, `apps/api/src/services/callerVerification/service.test.ts`.

**Interfaces:** Exact exported contracts:

```ts
export interface StartInput { orgId: string; contactId: string; targetContactId?: string; method: Exclude<CallerVerificationMethod, 'administrative_stepup'>; actionScope: CallerVerificationActionScope; deviceId?: string; username?: string; ticketId?: string; note?: string }
export interface VerificationView { id: string; orgId: string; contactId: string; targetContactId: string | null; method: CallerVerificationMethod; status: CallerVerificationStatus; tier: number; tierReason: string; actionScope: CallerVerificationActionScope; targetLabel: string | null; technicianLabel: string; initiatedByUserId: string; expiresAt: string; decidedAt: string | null; consumedAt: string | null; ticketRef: string | null; ticketNumber: string | null; destinationRedacted: string | null; deviceHostname: string | null; osUsername: string | null; createdAt: string; secrets?: { matchValue: string; decoyValues: string[]; reverseCode: string } /* initiator only */ }
export interface MethodAvailability { method: CallerVerificationMethod; available: boolean; tier: number; reason: string; unavailableReason?: 'method_disabled' | 'no_destination' | 'helper_outdated' | 'no_binding' | 'administrative_disabled' | 'feature_disabled' }
export async function start(actor: CallerVerificationActor, input: StartInput): Promise<VerificationView>;
export async function get(actor: CallerVerificationActor, orgId: string, id: string): Promise<VerificationView>;
export async function listForContact(actor: CallerVerificationActor, orgId: string, contactId: string): Promise<{ rows: VerificationView[]; fencedUntil: string | null }>;
export async function methodsForContact(actor: CallerVerificationActor, orgId: string, contactId: string, actionScope: CallerVerificationActionScope): Promise<MethodAvailability[]>;
export async function freshForTicket(actor: CallerVerificationActor, orgId: string, ticketId: string): Promise<{ row: VerificationView | null; isFresh: boolean; isConsumed: boolean }>;
```

- [ ] **Step 1: Write a reusable chain-aware mock and real tests.** `testing.ts` is imported only by tests. `PgDialect` assertions inspect actual generated predicates, not mocked success alone.

```ts
// service.test.ts
import { beforeEach,expect,it,vi } from 'vitest';
const ref=vi.hoisted(()=>({db:null as any,policy:vi.fn(),bindings:vi.fn()}));
vi.mock('../../db',()=>({db:new Proxy({}, {get:(_,key)=>ref.db[key]}),assertInTransaction:vi.fn(),runOutsideDbContext:(f:()=>unknown)=>f(),withSystemDbAccessContext:(f:()=>unknown)=>f(),getCurrentDbAccessContext:()=>({scope:'organization'})}));
vi.mock('./effects',()=>({recordEffect:vi.fn()}));
vi.mock('./gate',()=>({fencedUntil:async()=>null}));
vi.mock('./policy',async original=>({...await original<typeof import('./policy')>(),getEffectivePolicy:ref.policy}));
vi.mock('./subjects',()=>({bindingsForContact:ref.bindings}));
vi.mock('./destinations',async original=>({...await original<typeof import('./destinations')>(),currentDestination:async()=>null}));
import { makeDbMock } from './testing';
import { resolveEffectivePolicy } from './policy';
import { start,view,challengeSecrets } from './service';
import type { VerificationRow,CallerVerificationActor } from './types';
const org='11111111-1111-4111-8111-111111111111',user='22222222-2222-4222-8222-222222222222';
const actor:CallerVerificationActor={userId:user,partnerId:null,scope:'organization',accessibleOrgIds:[org],allowedSiteIds:null,displayName:'Technician'};
let state:ReturnType<typeof makeDbMock>;
beforeEach(()=>{state=makeDbMock();ref.db=state.db;vi.stubEnv('CALLER_VERIFICATION_ENABLED','true');ref.policy.mockResolvedValue(resolveEffectivePolicy(null,null));ref.bindings.mockImplementation(async(_org:string,contactId:string)=>[{id:contactId,contactId,orgId:org,entraOid:contactId,entraTenantId:'tenant',revokedAt:null}]);});
it('generates three distinct two-digit choices and four-digit reverse code',()=>{
 for(let i=0;i<100;i++){const s=challengeSecrets();expect(new Set([s.matchValue,...s.decoyValues]).size).toBe(3);expect(s.reverseCode).toMatch(/^\d{4}$/);}
});
it('creator-only secrets are an explicit projection',()=>{
 const now=new Date();const row={id:user,orgId:org,contactId:user,createdAt:now,expiresAt:now,decidedAt:null,consumedAt:null,initiatedByUserId:user,matchValue:'42',decoyValues:['11','73'],reverseCode:'1234',challengeTokenHash:'private'} as VerificationRow;
 expect(view(row,user,null).secrets?.matchValue).toBe('42');
 expect(view(row,'other',null)).not.toHaveProperty('secrets');expect(view(row,user,null)).not.toHaveProperty('challengeTokenHash');
});
it('flag-off start fails before database work',async()=>{
 vi.stubEnv('CALLER_VERIFICATION_ENABLED','false');
 await expect(start(actor,{orgId:org,contactId:user,method:'callback_attestation',actionScope:'any'})).rejects.toMatchObject({code:'feature_disabled'});
});
const contact={id:user,orgId:org,name:'Requester',siteId:null,roles:['admin'],email:null,mobile:null};
const input={orgId:org,contactId:user,method:'callback_attestation' as const,actionScope:'any' as const};
it('counts every attempt under the contact lock and stops at the cap',async()=>{
 state.results.push([contact],[contact],[contact],[contact],[contact],[{count:3}]);
 await expect(start(actor,input)).rejects.toMatchObject({code:'attempt_cap'});expect(state.calls.filter(c=>c.name==='insert')).toEqual([]);expect(state.db.execute).toHaveBeenCalled();
});
it('rejects a ticket belonging to another requester',async()=>{
 state.results.push([contact],[contact],[contact],[{id:user,requesterContactId:'33333333-3333-4333-8333-333333333333',deletedAt:null}]);
 await expect(start(actor,{...input,ticketId:user})).rejects.toMatchObject({code:'not_found'});expect(state.calls.filter(c=>c.name==='insert')).toEqual([]);
});
it('denies foreign org and sibling-site targets before creating an attempt',async()=>{
 await expect(start(actor,{...input,orgId:'33333333-3333-4333-8333-333333333333'})).rejects.toMatchObject({code:'not_found'});
 state.results.push([contact],[{...contact,siteId:'44444444-4444-4444-8444-444444444444'}]);
 await expect(start({...actor,allowedSiteIds:[]},input)).rejects.toMatchObject({code:'not_found'});expect(state.calls.filter(c=>c.name==='insert')).toEqual([]);
});
it('a site-level manager cannot authorize another account at initiation',async()=>{
 const target='33333333-3333-4333-8333-333333333333';state.results.push([{...contact,siteId:'44444444-4444-4444-8444-444444444444'}],[{...contact,id:target}]);
 await expect(start(actor,{...input,targetContactId:target,actionScope:'disable_user'})).rejects.toMatchObject({code:'requester_not_authorized'});
});
it('does not advertise or start a workstation without its adapter',async()=>{
 state.results.push([contact],[contact],[contact]);await expect(start(actor,{...input,method:'workstation',deviceId:user,username:'caller'})).rejects.toMatchObject({code:'helper_outdated'});expect(state.calls.filter(c=>c.name==='insert')).toEqual([]);
});
it('creates a callback row and returns its initiator secrets',async()=>{
 const now=new Date(),row={id:user,...input,initiatedByUserId:user,createdAt:now,expiresAt:now,decidedAt:null,consumedAt:null,matchValue:'42',decoyValues:['11','73'],reverseCode:'1234'};
 state.results.push([contact],[contact],[contact],[contact],[contact],[{count:0}],[row],[{count:1}],[]);
 expect((await start(actor,input)).secrets).toEqual({matchValue:'42',decoyValues:['11','73'],reverseCode:'1234'});expect(state.calls.filter(c=>c.name==='insert')).toHaveLength(1);
});
```

- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/callerVerification/service.test.ts`. Expected: missing service module.
- [ ] **Step 3: Implement initiation and read functions.** Copy the three interfaces above into `service.ts`; imports and bodies follow. The gate and transactional effects already exist from the preceding tasks.

```ts
import { randomInt,randomBytes,createHash } from 'node:crypto';
import { and,eq,isNull,desc,sql,or } from 'drizzle-orm';
import { db,assertInTransaction } from '../../db';
import { callerVerifications as v,callerVerificationSubjectBindings as b } from '../../db/schema/callerVerification';
import { tickets } from '../../db/schema/portal';
import { devices } from '../../db/schema/devices';
import { callerVerificationEnabled } from '../../config/env';
import type { CallerVerificationActor,CallerVerificationMethod,CallerVerificationStatus,CallerVerificationActionScope,VerificationRow } from './types';
import { CallerVerificationValidationError as Invalid } from './errors';
import { getEffectivePolicy } from './policy';
import { reachableContact,requesterAuthorized } from './access';
import { bindingsForContact } from './subjects';
import { currentDestination,isEstablished,normalizeDestination } from './destinations';
import { computeTier } from './tiers';
import { lockContact,withSubjectLocks } from './locks';
import { callerVerificationPorts as ports } from './ports';
import { fencedUntil } from './gate';
import { recordEffect } from './effects';
export function challengeSecrets(){
 const choices=new Set<string>();while(choices.size<3)choices.add(String(randomInt(10,100)));
 const [matchValue,...decoyValues]=[...choices];return {matchValue:matchValue!,decoyValues,reverseCode:String(randomInt(0,10000)).padStart(4,'0')};
}
export function view(r:VerificationRow,userId:string|null,targetContactId:string|null):VerificationView{
 return {id:r.id,orgId:r.orgId,contactId:r.contactId,targetContactId,method:r.method,status:r.status,tier:r.tier,tierReason:r.tierReason,actionScope:r.actionScope,targetLabel:r.targetLabel,technicianLabel:r.technicianLabel,initiatedByUserId:r.initiatedByUserId,expiresAt:r.expiresAt.toISOString(),decidedAt:r.decidedAt?.toISOString()??null,consumedAt:r.consumedAt?.toISOString()??null,ticketRef:r.ticketRef,ticketNumber:r.ticketNumber,destinationRedacted:r.destinationRedacted,deviceHostname:r.deviceHostname,osUsername:r.osUsername,createdAt:r.createdAt.toISOString(),...(r.initiatedByUserId===userId?{secrets:{matchValue:r.matchValue,decoyValues:r.decoyValues,reverseCode:r.reverseCode}}:{})};
}
export async function loadVerification(orgId:string,id:string):Promise<VerificationRow>{
 const [r]=await db.select().from(v).where(and(eq(v.orgId,orgId),eq(v.id,id))).limit(1);if(!r)throw new Invalid('not_found','Verification not found');return r;
}
async function targetContact(r:VerificationRow):Promise<string|null>{
 if(!r.targetBindingId)return null;const [t]=await db.select().from(b).where(and(eq(b.id,r.targetBindingId),eq(b.orgId,r.orgId))).limit(1);return t?.contactId??null;
}
export async function get(actor:CallerVerificationActor,orgId:string,id:string):Promise<VerificationView>{
 const r=await loadVerification(orgId,id);await reachableContact(actor,orgId,r.contactId);const target=await targetContact(r);if(target)await reachableContact(actor,orgId,target);return projectVerification(r,actor.userId,target);
}
export async function methodsForContact(actor:CallerVerificationActor,orgId:string,contactId:string,actionScope:CallerVerificationActionScope):Promise<MethodAvailability[]>{
 const contact=await reachableContact(actor,orgId,contactId);const p=await getEffectivePolicy(orgId),bindings=await bindingsForContact(orgId,contactId),rows:MethodAvailability[]=[];
 for(const method of ['workstation','sms','email','callback_attestation'] as const){
  const destination=method==='sms'||method==='email'?await currentDestination(orgId,contactId,method==='sms'?'mobile':'email'):null;
  const tier=computeTier({method,boundPrincipal:bindings.some(r=>!!r.osPrincipal),destinationEstablished:!!destination&&isEstablished(destination,p),policy:p});
  const unavailableReason=!callerVerificationEnabled()?'feature_disabled':!p.allowedMethods.includes(method)?'method_disabled':actionScope!=='any'&&!bindings.some(r=>!!r.entraOid)?'no_binding':(method==='sms'||method==='email')&&(!destination||!normalizeDestination(method==='sms'?'mobile':'email',method==='sms'?contact.mobile:contact.email))?'no_destination':method!=='callback_attestation'&&!(await ports.available(method,orgId))?method==='workstation'?'helper_outdated':'method_disabled':undefined;
  rows.push({method,available:!unavailableReason,...tier,unavailableReason});
 }
 return rows;
}
export async function start(actor:CallerVerificationActor,input:StartInput):Promise<VerificationView>{
 if(!callerVerificationEnabled())throw new Invalid('feature_disabled','Caller verification is disabled');assertInTransaction('startCallerVerification');
 const {orgId,contactId}=input;const requester=await reachableContact(actor,orgId,contactId),target=await reachableContact(actor,orgId,input.targetContactId??contactId);
 const p=await getEffectivePolicy(orgId),rb=(await bindingsForContact(orgId,contactId)).filter(r=>r.entraOid),tb=(await bindingsForContact(orgId,target.id)).filter(r=>r.entraOid);
 if(input.actionScope!=='any'&&(rb.length!==1||tb.length!==1))throw new Invalid('subject_unmatched','Exactly one canonical binding is required');
 if(!requesterAuthorized(input.actionScope,rb[0]??null,tb[0]??null,requester,p.disableUserAuthorizerRoles))throw new Invalid('requester_not_authorized','Requester cannot authorize this target');
 const methods=await methodsForContact(actor,orgId,contactId,input.actionScope),method=methods.find(m=>m.method===input.method)!;
 if(!method.available)throw new Invalid(method.unavailableReason!,'Method unavailable');
 let ticket:typeof tickets.$inferSelect|undefined;
 if(p.requireTicket&&!input.ticketId)throw new Invalid('ticket_required','A ticket is required');
 if(input.ticketId){[ticket]=await db.select().from(tickets).where(and(eq(tickets.id,input.ticketId),eq(tickets.orgId,orgId))).limit(1);
  if(!ticket||ticket.deletedAt||ticket.requesterContactId!==contactId)throw new Invalid('not_found','Ticket not found');await assertTicketDeviceReach(actor,orgId,ticket.deviceId);}
 let device:typeof devices.$inferSelect|undefined;
 if(input.deviceId){[device]=await db.select().from(devices).where(and(eq(devices.id,input.deviceId),eq(devices.orgId,orgId))).limit(1).for('share');
  if(!device||actor.allowedSiteIds!==null&&(!device.siteId||!actor.allowedSiteIds.includes(device.siteId)))throw new Invalid('not_found','Device not found');}
 if(input.method==='workstation'&&(!device||!input.username))throw new Invalid('device_required','Workstation requires device and username');
 await lockContact(orgId,contactId);
 return withSubjectLocks(db,[rb[0]?.id??null,tb[0]?.id??null],async()=>{
  if(await fencedUntil(orgId,contactId,p)||await fencedUntil(orgId,target.id,p))throw new Invalid('contact_fenced','Contact is fenced');
  const currentR=(await bindingsForContact(orgId,contactId)).find(r=>r.id===rb[0]?.id)??null,currentT=(await bindingsForContact(orgId,target.id)).find(r=>r.id===tb[0]?.id)??null;
  const currentRequester=await reachableContact(actor,orgId,contactId);await reachableContact(actor,orgId,target.id);
  if(!requesterAuthorized(input.actionScope,currentR,currentT,currentRequester,p.disableUserAuthorizerRoles))throw new Invalid('requester_not_authorized','Requester changed');
  const [{count}]=await db.select({count:sql<number>`count(*)::int`}).from(v).where(and(eq(v.orgId,orgId),eq(v.contactId,contactId),sql`${v.createdAt}>now()-interval '1 hour'`));
  if(count!>=p.maxAttemptsPerHour)throw new Invalid('attempt_cap','Contact attempt limit reached');
  const dest=input.method==='sms'||input.method==='email'?await currentDestination(orgId,contactId,input.method==='sms'?'mobile':'email'):null;
  const token=dest?randomBytes(32).toString('base64url'):null,secret=challengeSecrets(),now=new Date();
  const computed=computeTier({method:input.method,boundPrincipal:false,destinationEstablished:!!dest&&isEstablished(dest,p),policy:p});
  const [row]=await db.insert(v).values({orgId,contactId,requesterBindingId:currentR?.id??null,targetBindingId:currentT?.id??null,targetEntraTenantId:currentT?.entraTenantId,targetEntraOid:currentT?.entraOid,initiatedByUserId:actor.userId,technicianLabel:actor.displayName,actionScope:input.actionScope,targetLabel:currentT?.upnSnapshot??target.name,method:input.method,status:'pending',tier:computed.tier,tierReason:computed.reason,...secret,challengeTokenHash:token?createHash('sha256').update(token).digest('hex'):null,destinationId:dest?.id,destinationRedacted:dest?.valueRedacted,workstationDeviceRef:device?.id,deviceHostname:device?.hostname,osUsername:input.username,ticketRef:ticket?.id,ticketNumber:(ticket?.internalNumber??ticket?.ticketNumber)?.slice(0,32),attemptNo:count!+1,expiresAt:new Date(now.getTime()+(input.method==='callback_attestation'?0:input.method==='workstation'?p.workstationTimeoutSeconds*1000:600000)),attestationNote:input.note}).returning();
  if(input.method!=='callback_attestation')await ports.prepare(row!,token);
  await recordEffect(row!,'started',actor.userId);return projectVerification(row!,actor.userId,target.id);
 });
}
export async function listForContact(actor:CallerVerificationActor,orgId:string,contactId:string):Promise<{rows:VerificationView[];fencedUntil:string|null}>{
 await reachableContact(actor,orgId,contactId);const p=await getEffectivePolicy(orgId);
 const records=await db.select().from(v).where(and(eq(v.orgId,orgId),eq(v.contactId,contactId))).orderBy(desc(v.createdAt)).limit(50);
 const rows:VerificationView[]=[];for(const r of records){const target=await targetContact(r);if(target)await reachableContact(actor,orgId,target);rows.push(await projectVerification(r,actor.userId,target));}
 return {rows,fencedUntil:(await fencedUntil(orgId,contactId,p))?.toISOString()??null};
}
async function assertTicketDeviceReach(actor:CallerVerificationActor,orgId:string,deviceId:string|null):Promise<void>{
 if(!deviceId)return;const [device]=await db.select().from(devices).where(and(eq(devices.id,deviceId),eq(devices.orgId,orgId))).limit(1);
 if(!device||actor.allowedSiteIds!==null&&(!device.siteId||!actor.allowedSiteIds.includes(device.siteId)))throw new Invalid('not_found','Ticket not found');
}
export async function freshForTicket(actor:CallerVerificationActor,orgId:string,ticketId:string):Promise<{row:VerificationView|null;isFresh:boolean;isConsumed:boolean}>{
 const [ticket]=await db.select().from(tickets).where(and(eq(tickets.id,ticketId),eq(tickets.orgId,orgId))).limit(1);
 if(!ticket?.requesterContactId||ticket.deletedAt)throw new Invalid('not_found','Ticket not found');await assertTicketDeviceReach(actor,orgId,ticket.deviceId);
 const history=await listForContact(actor,orgId,ticket.requesterContactId),p=await getEffectivePolicy(orgId);
 const [ticketRow]=await db.select().from(v).where(and(eq(v.orgId,orgId),eq(v.ticketRef,ticketId),eq(v.contactId,ticket.requesterContactId))).orderBy(desc(v.createdAt)).limit(1);
 const row=ticketRow?await get(actor,orgId,ticketRow.id):history.rows[0]??null;
 return {row,isFresh:!!row&&row.status==='verified'&&!history.fencedUntil&&!!row.decidedAt&&Date.parse(row.decidedAt)>Date.now()-p.verificationTtlMinutes*60000,isConsumed:!!row?.consumedAt};
}
```

- [ ] **Step 3a: Produce the additive HTTP view at every authenticated service return.** Keep `VerificationView` and the index signatures unchanged; the runtime result is a structural extension. `get`, `start`, `listForContact`, and Task 13's administrative factory call `projectVerification` below; cancel/attest/ticket already call those readers. W05 retains these returns. `applyDecision` is internal and continues using the secret-free base `view`. Add imports `incidents` from `../../db/schema/incidentResponse`, `actionIntents` from `../../db/schema/actionIntents`, and `CallerVerificationAction` from `./types`.

```ts
export type VerificationDetails=VerificationView & {
 remainingAttempts:number|null;usableUntil:string|null;incidentId:string|null;
 consumedAction:CallerVerificationAction|null;
 undeliverableReason:'no_session_for_user'|'session_not_console'|'helper_outdated'|'sms_failed'|'email_failed'|null;
};
export function verificationDetails(r:VerificationRow,userId:string|null,targetId:string|null,
 policy:Awaited<ReturnType<typeof getEffectivePolicy>>,attempts:number,incidentId:string|null,actionName:string|null):VerificationDetails{
 const reasons=['no_session_for_user','session_not_console','helper_outdated','sms_failed','email_failed'] as const;
 const reason=reasons.find(value=>value===r.reason)??null;
 const proofAt=r.method==='administrative_stepup'?r.stepupVerifiedAt:r.decidedAt;
 return {...view(r,userId,targetId),remainingAttempts:Math.max(0,policy.maxAttemptsPerHour-attempts),
  usableUntil:r.status==='verified'&&proofAt?new Date(proofAt.getTime()+policy.verificationTtlMinutes*60000).toISOString():null,
  incidentId,consumedAction:!r.consumedAt?null:actionName==='m365_reset_password'?'reset_password':actionName==='m365_disable_user'?'disable_user':null,
  undeliverableReason:r.status==='undeliverable'?reason:null};
}
export async function projectVerification(r:VerificationRow,userId:string|null,targetId:string|null):Promise<VerificationDetails>{
 const policy=await getEffectivePolicy(r.orgId);
 const [attempts]=await db.select({count:sql<number>`count(*)::int`}).from(v)
  .where(and(eq(v.orgId,r.orgId),eq(v.contactId,r.contactId),sql`${v.createdAt}>now()-interval '1 hour'`));
 const [incident]=await db.select({id:incidents.id}).from(incidents)
  .where(and(eq(incidents.orgId,r.orgId),eq(incidents.sourceType,'caller_verification'),eq(incidents.sourceRef,r.id))).limit(1);
 const [intent]=r.consumedAt&&r.consumedIntentRef?await db.select({actionName:actionIntents.actionName}).from(actionIntents)
  .where(and(eq(actionIntents.orgId,r.orgId),eq(actionIntents.id,r.consumedIntentRef))).limit(1):[];
 return verificationDetails(r,userId,targetId,policy,Number(attempts?.count??0),incident?.id??null,intent?.actionName??null);
}
```

A deleted or moved intent yields `consumedAction:null`; never infer the consumed action from `actionScope='any'`. Persist delivery failure in `reason` in Task 13's decision UPDATE so this reader has a producer. Unknown internal reasons map to null rather than leaking provider text. Grant expiry uses the current policy TTL and administrative proof time, not challenge expiry. `usableUntil` is descriptive, not a gate decision.

Add to `service.test.ts` (reuse `actor`, `org`, `user` and the real policy resolver):

```ts
import { verificationDetails } from './service';
it('projects required fields without secrets or guessing consumed any-scope action',()=>{
 const at=new Date('2026-09-19T12:00:00Z'),p=resolveEffectivePolicy(null,null);
 const row={id:user,orgId:org,contactId:user,initiatedByUserId:user,method:'callback_attestation',status:'verified',
  createdAt:at,expiresAt:at,decidedAt:at,consumedAt:at,actionScope:'any',reason:null} as VerificationRow;
 const result=verificationDetails(row,'another-user',null,p,4,'incident','m365_disable_user');
 expect(result).toMatchObject({remainingAttempts:0,usableUntil:'2026-09-19T12:30:00.000Z',incidentId:'incident',consumedAction:'disable_user',undeliverableReason:null});
 expect(result).not.toHaveProperty('secrets');expect(verificationDetails(row,null,null,p,0,null,null).consumedAction).toBeNull();
 expect(verificationDetails({...row,method:'administrative_stepup',stepupVerifiedAt:new Date('2026-09-19T11:59:00Z')},null,null,p,0,null,null).usableUntil).toBe('2026-09-19T12:29:00.000Z');
});
it.each(['no_session_for_user','session_not_console','helper_outdated','sms_failed','email_failed'] as const)('projects persisted delivery reason %s',reason=>{
 const at=new Date(),row={id:user,orgId:org,contactId:user,createdAt:at,expiresAt:at,decidedAt:at,consumedAt:null,status:'undeliverable',reason} as VerificationRow;
 expect(verificationDetails(row,null,null,resolveEffectivePolicy(null,null),1,null,null)).toMatchObject({remainingAttempts:2,usableUntil:null,undeliverableReason:reason});
});
```

The successful callback mock above includes the count and incident queries used by this projection. Task 15 supplies real HTTP response-contract checks for all currently mounted reads/mutations and a factory check for W05's administrative response. Run `cd apps/api && npx vitest run src/services/callerVerification/service.test.ts` before the existing Step 5 commit.

The attempt count and INSERT share the contact advisory lock and ambient transaction; every initiation path, including administrative creation, takes it. Number-choice expiry and grant TTL are different: callback's challenge expires immediately, but its later attestation starts grant freshness. `freshForTicket` is a badge read, never an authorization decision; gate rechecks current tier and subject.

- [ ] **Step 4:** Run `cd apps/api && npx vitest run src/services/callerVerification/service.test.ts`. Expected: PASS. The cap, ticket, site, D15 and adapter cases all assert refusal before insertion.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/callerVerification/service.ts apps/api/src/services/callerVerification/service.test.ts
git commit -m "feat(caller-verification): start challenges and expose scoped private views"
```

### Task 13: Decisions, administrative factory and durable publication

**Files:** Create `apps/api/src/services/callerVerification/deviceMove.ts`, `deviceMove.test.ts`; Modify `apps/api/src/routes/devices/moveOrg.ts`, `moveOrg.test.ts`, `apps/api/src/services/callerVerification/service.ts` and `apps/api/src/services/callerVerification/service.test.ts` (Task 12 creation); Create `apps/api/src/jobs/callerVerificationPublisher.ts`; Modify `apps/api/src/services/workerRegistry.ts:1083`.

**Interfaces:** Consumes the rejection handler and transaction-only delivery ports; produces `publishCallerVerificationEffects(): Promise<void>` plus these exact cross-wave exports:

```ts
export async function cancel(actor: CallerVerificationActor, orgId: string, id: string): Promise<VerificationView>;
export async function attest(actor: CallerVerificationActor, orgId: string, id: string, note: string): Promise<VerificationView>;
export async function applyDecision(input: { verificationId: string; decision: { kind: 'choice'; value: string } | { kind: 'not_me' } | { kind: 'timeout' } | { kind: 'undeliverable'; reason: string }; principal?: { osPrincipal: string; osUsername: string; upn: string | null }; fromIp?: string }): Promise<VerificationView>;
export async function createAdministrative(actor: CallerVerificationActor, input: { orgId: string; targetContactId: string; reason: string; stepUpGrantId: string }): Promise<VerificationView>;
export async function revokeIntentsForSubject(input: { orgId: string; bindingIds: string[]; verificationId: string }): Promise<{ cancelled: string[]; alreadyExecuting: string[]; alreadyDispatched: string[] }>;
```

- [ ] **Step 1: Add transition tests to `service.test.ts`.**

```ts
import { decisionStatus } from './service';
it.each(['pending','verified','wrong_choice','expired','undeliverable','cancelled','revoked'] as const)('accepts late not_me from %s',status=>{
 expect(decisionStatus(status,new Date(0),{kind:'not_me'},'42')).toBe('rejected_by_user');
});
it('only a live pending number choice verifies; timeout never approves',()=>{
 expect(decisionStatus('pending',new Date(Date.now()+60000),{kind:'choice',value:'42'},'42')).toBe('verified');
 expect(decisionStatus('pending',new Date(Date.now()+60000),{kind:'choice',value:'11'},'42')).toBe('wrong_choice');
 expect(decisionStatus('pending',new Date(0),{kind:'choice',value:'42'},'42')).toBe('expired');
 expect(decisionStatus('verified',new Date(0),{kind:'timeout'},'42')).toBeNull();
 expect(decisionStatus('rejected_by_user',new Date(0),{kind:'not_me'},'42')).toBeNull();
});
```

- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/callerVerification/service.test.ts`. Expected: missing `decisionStatus` export.
- [ ] **Step 3: Add transition bodies and the post-commit publisher.** Add `getCurrentDbAccessContext`, `withSystemDbAccessContext` to the db import; import `handleRejection` from `./rejection`. `applyDecision` reuses any existing authorized transaction and opens a system transaction only when no context exists; W03 must retain this any-context check, not narrow it to system scope. The identity namespace lock precedes subject locks so W02 can safely call `observeLogin` afterward in the same transaction; W02/W03 must authenticate command/token ownership before calling it.

```ts
export function decisionStatus(status:CallerVerificationStatus,expiresAt:Date,decision:Parameters<typeof applyDecision>[0]['decision'],match:string):CallerVerificationStatus|null{
 if(decision.kind==='not_me')return status==='rejected_by_user'?null:'rejected_by_user';
 if(status!=='pending')return null;
 if(decision.kind==='timeout'||expiresAt.getTime()<=Date.now())return 'expired';
 if(decision.kind==='undeliverable')return 'undeliverable';
 return decision.value===match?'verified':'wrong_choice';
}
export async function cancel(actor:CallerVerificationActor,orgId:string,id:string):Promise<VerificationView>{
 await get(actor,orgId,id);
 const [row]=await db.update(v).set({status:'cancelled',decidedAt:new Date()}).where(and(eq(v.orgId,orgId),eq(v.id,id),eq(v.status,'pending'))).returning();
 if(row)await recordEffect(row,'cancelled',actor.userId);return get(actor,orgId,id);
}
export async function attest(actor:CallerVerificationActor,orgId:string,id:string,note:string):Promise<VerificationView>{
 if(note.trim().length<20)throw new Invalid('invalid_note','Callback note must contain at least 20 characters');
 await get(actor,orgId,id);const row=await loadVerification(orgId,id);
 if(row.method!=='callback_attestation')throw new Invalid('invalid_method','Only callback attempts can be attested');
 await withSubjectLocks(db,[row.requesterBindingId,row.targetBindingId],async()=>{
  const p=await getEffectivePolicy(orgId);if(await fencedUntil(orgId,row.contactId,p))throw new Invalid('contact_fenced','Contact is fenced');
  const [changed]=await db.update(v).set({status:'verified',decidedAt:new Date(),attestationNote:note.trim(),tier:1,tierReason:'attestation'}).where(and(eq(v.id,id),eq(v.orgId,orgId),eq(v.status,'pending'))).returning();
  if(changed)await recordEffect(changed,'verified',actor.userId);
 });return get(actor,orgId,id);
}
export async function applyDecision(input:{verificationId:string;decision:{kind:'choice';value:string}|{kind:'not_me'}|{kind:'timeout'}|{kind:'undeliverable';reason:string};principal?:{osPrincipal:string;osUsername:string;upn:string|null};fromIp?:string}):Promise<VerificationView>{
 const decide=async()=>{
  const [row]=await db.select().from(v).where(eq(v.id,input.verificationId)).limit(1);if(!row)throw new Invalid('not_found','Verification not found');
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`caller-identity:${row.orgId}`}))`);
  if(input.decision.kind==='not_me'){await handleRejection(row.id);return view(await loadVerification(row.orgId,row.id),null,await targetContact(row));}
  return withSubjectLocks(db,[row.requesterBindingId,row.targetBindingId],async()=>{
   const fresh=await loadVerification(row.orgId,row.id),status=decisionStatus(fresh.status,fresh.expiresAt,input.decision,fresh.matchValue);if(!status)return view(fresh,null,await targetContact(fresh));
   const p=await getEffectivePolicy(row.orgId),bindings=await bindingsForContact(row.orgId,row.contactId);
   const bound=!!input.principal&&bindings.some(b=>b.osPrincipal===input.principal!.osPrincipal&&!!input.principal!.upn&&b.upnSnapshot?.toLowerCase()===input.principal!.upn.toLowerCase());
   const dest= row.method==='sms'||row.method==='email'?await currentDestination(row.orgId,row.contactId,row.method==='sms'?'mobile':'email'):null;
   const tier=computeTier({method:row.method,boundPrincipal:bound,destinationEstablished:!!dest&&dest.id===row.destinationId&&isEstablished(dest,p),policy:p});
   const [changed]=await db.update(v).set({status,decidedAt:new Date(),decidedFromIp:input.fromIp,osPrincipalObserved:input.principal?.osPrincipal,tier:tier.tier,tierReason:tier.reason,...(input.decision.kind==='undeliverable'?{reason:input.decision.reason}:{})}).where(and(eq(v.id,row.id),eq(v.status,'pending'),...(status==='verified'||status==='wrong_choice'?[sql`${v.expiresAt}>now()`]:[]))).returning();
   if(changed)await recordEffect(changed,status);return view(changed??await loadVerification(row.orgId,row.id),null,await targetContact(row));
  });
 };
 if(getCurrentDbAccessContext())return decide();
 return withSystemDbAccessContext(decide,'callerVerification.applyDecision');
}
export async function createAdministrative(actor:CallerVerificationActor,input:{orgId:string;targetContactId:string;reason:string;stepUpGrantId:string}):Promise<VerificationView>{
 if(!callerVerificationEnabled())throw new Invalid('feature_disabled','Caller verification is disabled');
 if(input.reason.trim().length<20)throw new Invalid('invalid_reason','Administrative reason must contain at least 20 characters');
 const target=await reachableContact(actor,input.orgId,input.targetContactId),p=await getEffectivePolicy(input.orgId);
 if(!p.allowAdministrativeDisable)throw new Invalid('administrative_disabled','Administrative disable is disabled');
 const bindings=(await bindingsForContact(input.orgId,target.id)).filter(b=>b.entraOid&&b.entraTenantId);if(bindings.length!==1)throw new Invalid('subject_unmatched','Canonical target required');
 const binding=bindings[0]!;
 // W05 adapter consumes exactly the operation/org/tenant/OID/reason/session/epoch-bound interactive proof.
 await lockContact(input.orgId,target.id);
 return withSubjectLocks(db,[binding.id],async()=>{
  if(await fencedUntil(input.orgId,target.id,p))throw new Invalid('contact_fenced','Target is fenced');
  const current=(await bindingsForContact(input.orgId,target.id)).find(r=>r.id===binding.id);if(!current||current.entraOid!==binding.entraOid||current.entraTenantId!==binding.entraTenantId)throw new Invalid('target_rebound','Target binding changed');
  const [{count}]=await db.select({count:sql<number>`count(*)::int`}).from(v).where(and(eq(v.orgId,input.orgId),eq(v.contactId,target.id),sql`${v.createdAt}>now()-interval '1 hour'`));if(count!>=p.maxAttemptsPerHour)throw new Invalid('attempt_cap','Contact attempt limit reached');
  const proof=await ports.consumeStepUp(actor,{orgId:input.orgId,target:{entraTenantId:binding.entraTenantId!,entraOid:binding.entraOid!},reason:input.reason.trim(),stepUpGrantId:input.stepUpGrantId});
  const now=new Date();const [row]=await db.insert(v).values({orgId:input.orgId,contactId:target.id,requesterBindingId:null,targetBindingId:binding.id,targetEntraTenantId:binding.entraTenantId,targetEntraOid:binding.entraOid,initiatedByUserId:actor.userId,technicianLabel:actor.displayName,actionScope:'disable_user',targetLabel:binding.upnSnapshot??target.name,method:'administrative_stepup',reason:input.reason.trim(),stepupSessionId:proof.sid,stepupAuthEpoch:proof.authEpoch,stepupMfaEpoch:proof.mfaEpoch,stepupVerifiedAt:now,status:'verified',tier:3,tierReason:'administrative',...challengeSecrets(),attemptNo:count!+1,decidedAt:now,expiresAt:new Date(now.getTime()+p.verificationTtlMinutes*60000)}).returning();
  await recordEffect(row!,'administrative_created',actor.userId);return projectVerification(row!,actor.userId,target.id);
 });
}

```

The contact lock, hourly count, cap-before-proof-consumption, `attemptNo:count!+1`, and `recordEffect(row!,'administrative_created',actor.userId)` are implemented invariants, not a stub. W05 replaces only the proof adapter and retains these operations and the additive view projection. Administrative proof defaults to refusal in W01. W05 registers the consumer using actual session/epochs; it cannot use the synthesized release `mfa:true`. Do not add the administrative route or step-up operation here. `not_me` is not processed by the ordinary pending/expiry CAS; the rejection helper owns that atomic transition.

- [ ] **Step 3a: Revoke workstation grants inside the device move transaction.** Create `apps/api/src/services/callerVerification/deviceMove.ts` and `deviceMove.test.ts`; modify `apps/api/src/routes/devices/moveOrg.ts`. The route already owns an explicit `tx`; pass it through both queries and advisory locks. Never open a second context or use ambient `db` for this hook.

```ts
// deviceMove.ts
import { sql } from 'drizzle-orm';
import { withSubjectLocks,type Tx } from './locks';
export async function revokeWorkstationGrantsForMove(tx:Tx,sourceOrgId:string,deviceId:string):Promise<void>{
 const rows=await tx.execute(sql`SELECT requester_binding_id,target_binding_id FROM caller_verifications
  WHERE org_id=${sourceOrgId}::uuid AND workstation_device_ref=${deviceId}::uuid
  AND method='workstation' AND status IN ('pending','verified')`);
 const ids=(rows as unknown as Array<{requester_binding_id:string|null;target_binding_id:string|null}>).flatMap(r=>[r.requester_binding_id,r.target_binding_id]);
 await withSubjectLocks(tx,ids,async()=>{
  await tx.execute(sql`UPDATE caller_verifications
   SET status=CASE WHEN status='pending' THEN 'expired'::caller_verification_status ELSE 'revoked'::caller_verification_status END
   WHERE org_id=${sourceOrgId}::uuid AND workstation_device_ref=${deviceId}::uuid
   AND method='workstation' AND status IN ('pending','verified') AND consumed_at IS NULL`);
 });
}
```

Import `revokeWorkstationGrantsForMove` from `../../services/callerVerification/deviceMove` in `routes/devices/moveOrg.ts`. Inside its existing transaction, after locked source/target validation and PAM checks, immediately before `tx.update(devices).set({orgId:targetOrgId,...})`, insert:

```ts
const [callerMoveDevice]=await tx.select({orgId:devices.orgId}).from(devices).where(eq(devices.id,deviceId)).limit(1).for('update');
if(callerMoveDevice?.orgId!==sourceOrgId)throw new Error('Device organization changed during move');
await revokeWorkstationGrantsForMove(tx,sourceOrgId,deviceId);
```

Prevent a concurrent start from publishing a new old-org grant after the hook's snapshot: in Task 12's `start` device lookup append `.for('share')` to its existing `.limit(1)` query. The device share lock remains until the start's grant INSERT commits; the move's device row lock waits for it. Conversely, a lookup after the move cannot match the old org. Acquire the device lock before contact/subject locks on both paths. The new `SELECT ... FOR UPDATE` above is required: this checkout's route does not yet lock the device before its UPDATE. Keep the existing ascending organization locks first, then the new device lock, then the hook's subject locks. Snapshots and consumed history remain untouched, including the original org. The hook locks consumed verified rows too (without updating them); Task 10 rechecks the device org under these same subject locks even on same-intent retries. Its device read deliberately has no row lock, avoiding reversal of move/start device-before-subject ordering. Thus an already consumed but undispatched grant cannot regain authorization after movement.

```ts
// deviceMove.test.ts
import { expect,it,vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { revokeWorkstationGrantsForMove } from './deviceMove';
it('uses the move transaction, ordered shared locks, original org and unused-only update',async()=>{
 const execute=vi.fn().mockResolvedValueOnce([{requester_binding_id:'b',target_binding_id:'a'}]).mockResolvedValue([]);
 await revokeWorkstationGrantsForMove({execute} as never,'org','device');
 const queries=execute.mock.calls.map(([q])=>new PgDialect().sqlToQuery(q));
 expect(queries.map(q=>q.params)).toEqual([['org','device'],['a'],['b'],['org','device']]);
 expect(queries[3]!.sql).toContain('consumed_at IS NULL');
 expect(queries[3]!.sql).not.toContain('SET org_id');expect(queries[3]!.sql).not.toContain('consumed_at=');
});
```

Update existing `apps/api/src/routes/devices/moveOrg.test.ts` so its real route harness recognizes the new locked device read. At the top of `rigTransactionSuccess`'s `tx.select` implementation, before its payload branch, insert:

```ts
if(cols&&'orgId' in cols){
 return {from:()=>({where:()=>({limit:()=>({for:async(mode:string)=>{
  statements.push(`SELECT devices FOR ${mode}`);return [{orgId:SOURCE_ORG}];
 }})})})};
}
```

In its existing lock-order test, keep the assertions for indices 0–5 (constraints, orgs, PAM, re-home, detach), and replace `expect(statements[6]).toBe('UPDATE devices')` with:

```ts
expect(statements[6]).toBe('SELECT devices FOR update');
expect(collapseStmt(statements[7]!)).toContain('SELECT requester_binding_id,target_binding_id FROM caller_verifications');
expect(collapseStmt(statements[8]!)).toContain('UPDATE caller_verifications');
expect(statements[9]).toBe('UPDATE devices');
```

The empty-grant fixture takes no subject advisory locks; the dedicated helper test above covers their ordered acquisition. The live move test supplies actual grants and consumed history. Include `moveOrg.test.ts` in Step 5's commit.

Run `cd apps/api && npx vitest run src/services/callerVerification/deviceMove.test.ts src/services/callerVerification/service.test.ts src/routes/devices/moveOrg.test.ts src/routes/devices/moveOrg.coverage.test.ts`. Task 15 calls the real authenticated move route, verifies an eligible old grant before movement, refuses its subsequent use and checks unchanged consumed history. Include the helper/tests/move route in Step 5's commit.

Implement the publisher with a BullMQ repeat job, outside request context. A stable queue job and concurrency 1 serialize the publisher; multiple replicas use the same job ID/queue. Each committed rejection is scanned until marked. Create notifications with per-user verification dedupe keys; send email outside DB contexts; mark only after successful completion. SMTP provider ambiguity is the explicit at-least-once limitation in Global Constraints.

```ts
// jobs/callerVerificationPublisher.ts
import { Queue,Worker } from 'bullmq';
import { and,eq,isNull,or,ne,sql } from 'drizzle-orm';
import { db,runOutsideDbContext,withSystemDbAccessContext } from '../db';
import { callerVerifications as v } from '../db/schema/callerVerification';
import { getBullMQConnection } from '../services/redis';
import { createNotification } from '../services/userNotifications';
import { getEmailService } from '../services/email';
import { securityRecipients } from '../services/callerVerification/effects';
import { callerVerificationPorts } from '../services/callerVerification/ports';
import { applyDecision } from '../services/callerVerification/service';
const scoped=<T>(fn:()=>Promise<T>)=>runOutsideDbContext(()=>withSystemDbAccessContext(fn,'callerVerification.publisher'));
export async function publishCallerVerificationEffects():Promise<void>{
 const rows=await scoped(()=>db.select().from(v).where(or(and(eq(v.status,'rejected_by_user'),isNull(v.rejectionNotifiedAt)),and(eq(v.status,'pending'),or(isNull(v.deliveryPublishedAt),and(ne(v.method,'callback_attestation'),sql`${v.expiresAt}<=now()`))))).limit(100));
 for(const row of rows){
  if(row.status==='pending'){
   if(row.method!=='callback_attestation'&&row.expiresAt.getTime()<=Date.now()){await applyDecision({verificationId:row.id,decision:{kind:'timeout'}});continue;}
   if(row.method!=='callback_attestation')await callerVerificationPorts.deliver(row.id);
   await scoped(()=>db.update(v).set({deliveryPublishedAt:new Date()}).where(eq(v.id,row.id)));continue;
  }
  const recipients=await scoped(()=>securityRecipients(row.orgId)),email=getEmailService();if(!email)throw new Error('Caller rejection email transport unavailable');
  for(const person of recipients){
   await scoped(()=>createNotification({userId:person.id,orgId:row.orgId,type:'security',priority:'high',title:'Caller rejected an identity-change request',message:'The subject is fenced. Review the security incident.',link:'/security/incidents',dedupeKey:`caller-rejection-${row.id}`,metadata:{verificationId:row.id}}));
   await email.sendEmail({to:person.email,subject:'Caller verification security incident',html:'<p>A caller rejected an identity-change request. Open Breeze security incidents to review the subject fence and related actions.</p>',text:'A caller rejected an identity-change request. Open Breeze security incidents to review.',headers:{'Message-ID':`<caller-${row.id}-${person.id}@notifications.invalid>`}});
  }
  await scoped(()=>db.update(v).set({rejectionNotifiedAt:new Date()}).where(eq(v.id,row.id)));
 }
}
let queue:Queue|null=null,worker:Worker|null=null;
export async function initializeCallerVerificationPublisher():Promise<void>{
 const name='caller-verification-publisher';queue=new Queue(name,{connection:getBullMQConnection()});
 worker=new Worker(name,()=>publishCallerVerificationEffects(),{connection:getBullMQConnection(),concurrency:1});
 await queue.add('publish',{}, {jobId:'caller-verification-publish',repeat:{every:5000},removeOnComplete:20,removeOnFail:100});
}
export async function shutdownCallerVerificationPublisher():Promise<void>{await worker?.close();await queue?.close();worker=null;queue=null;}
```

Add the registry entry beside the existing ticket publisher (`workerRegistry.ts:1083`):

```ts
{ name:'callerVerificationPublisher',placement:'global',load:async()=>{
 const m=await import('../jobs/callerVerificationPublisher');return {init:m.initializeCallerVerificationPublisher,shutdown:m.shutdownCallerVerificationPublisher};
}},
```

- [ ] **Step 4:** Run `cd apps/api && npx vitest run src/services/callerVerification/service.test.ts`. Expected: PASS, including late rejection on every non-rejected state. The W05 seam still returns the three explicit empty arrays from Task 11.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/callerVerification/deviceMove.ts apps/api/src/services/callerVerification/deviceMove.test.ts apps/api/src/routes/devices/moveOrg.ts apps/api/src/routes/devices/moveOrg.test.ts apps/api/src/services/callerVerification/service.ts apps/api/src/services/callerVerification/service.test.ts apps/api/src/jobs/callerVerificationPublisher.ts apps/api/src/services/workerRegistry.ts
git commit -m "feat(caller-verification): implement decisions and administrative factory seam"
```

### Task 14: Authenticated routes, policy writes and barrel exports

**Files:** Modify `apps/api/src/routes/config.ts`, `apps/api/src/routes/config.test.ts`; Create `apps/api/src/routes/callerVerification.ts`, `apps/api/src/routes/callerVerification.test.ts`, `apps/api/src/services/callerVerification/index.ts`; Modify `apps/api/src/routes/orgContacts.ts:110`, `apps/api/src/index.ts:834`, `apps/api/src/middleware/selfManagedDbContextRoutes.ts:30`, `apps/api/src/middleware/selfManagedDbContextRoutes.test.ts:291`.

**Interfaces:** Produces the `/config` readiness field, directory search/sync routes from Task 8, and every authenticated spec API route except `/administrative` and device-suggestions, plus the callback `/attest` and specified fence-override POST. Consumes actual `authMiddleware`, `requireScope`, `requirePermission`, `requireMfa`, `PERMISSIONS.ORGS_READ/ORGS_WRITE`, `canReachContactSite`, `canManagePartnerWidePolicies`. Binding Graph reads use the existing self-managed context route mechanism (`auth.ts:768`) so no outer transaction stays open across Graph.

- [ ] **Step 1: Write route tests with functional authorization stubs.**

```ts
import { beforeEach,expect,it,vi } from 'vitest';
import { Hono } from 'hono';
const m=vi.hoisted(()=>({auth:null as any,read:true,write:true,mfa:true,get:vi.fn(),start:vi.fn()}));
vi.mock('../middleware/auth',()=>({
 authMiddleware:async(c:any,n:any)=>{if(!m.auth)return c.json({error:'unauthorized'},401);c.set('auth',m.auth);return n();},
 requireScope:(...s:string[])=>async(c:any,n:any)=>s.includes(c.get('auth').scope)?n():c.json({},403),
 requirePermission:(_r:string,a:string)=>async(c:any,n:any)=>(a==='write'&&!m.write)||(a==='read'&&!m.read)?c.json({},403):n(),
 requireMfa:()=>async(c:any,n:any)=>m.mfa?n():c.json({},403),
 withAuthDbAccessContext:(_a:unknown,f:()=>unknown)=>f(),
}));
vi.mock('./orgContacts',()=>({canReachContactSite:(_a:unknown,site:string|null)=>site===null}));
vi.mock('../services/rate-limit',()=>({rateLimiter:async()=>({allowed:true,remaining:9,resetAt:Date.now()+600000})}));
vi.mock('../services/redis',()=>({getRedis:()=>null}));
vi.mock('../services/contacts/import',()=>({importDirectoryContact:vi.fn()}));
vi.mock('../services/callerVerification/service',()=>({get:m.get,start:m.start,cancel:vi.fn(),attest:vi.fn(),listForContact:vi.fn(),methodsForContact:vi.fn(),freshForTicket:vi.fn()}));
import { callerVerificationRoutes } from './callerVerification';
const app=new Hono().route('/',callerVerificationRoutes),org='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const path=`/orgs/${org}/caller-verifications`,contactPath=`/orgs/${org}/contacts/${id}`;
const routes=[['POST',path],['GET',`${path}/${id}`],['POST',`${path}/${id}/cancel`],['POST',`${path}/${id}/attest`],['GET',`${contactPath}/caller-verifications`],['GET',`${contactPath}/caller-verifications/methods`],['POST',`${contactPath}/caller-verification-bindings`],['DELETE',`${contactPath}/caller-verification-bindings/${id}`],['POST',`${contactPath}/caller-verification-destinations/${id}/attest`],['POST',`${contactPath}/caller-verifications/fence-override`],['GET',`/orgs/${org}/tickets/${id}/caller-verification`],['GET',`/orgs/${org}/caller-verification-policy`],['PUT',`/orgs/${org}/caller-verification-policy`],['GET','/partner/caller-verification-policy'],['PUT','/partner/caller-verification-policy']] as const;
beforeEach(()=>{vi.clearAllMocks();m.read=true;m.write=true;m.mfa=true;m.auth={scope:'organization',user:{id,name:'Tech'},partnerId:null,accessibleOrgIds:[org],allowedSiteIds:null,canAccessOrg:()=>true};vi.stubEnv('CALLER_VERIFICATION_ENABLED','true');});
it.each(routes)('%s %s is dark before auth, then auth and permission protected',async(method,url)=>{
 vi.stubEnv('CALLER_VERIFICATION_ENABLED','false');expect((await app.request(url,{method})).status).toBe(404);
 vi.stubEnv('CALLER_VERIFICATION_ENABLED','true');const auth=m.auth;m.auth=null;expect((await app.request(url,{method})).status).toBe(401);m.auth=auth;
 if(method==='GET')m.read=false;else m.write=false;expect((await app.request(url,{method})).status).toBe(403);
 if(method!=='GET'){m.write=true;m.mfa=false;expect((await app.request(url,{method})).status).toBe(403);}
});
it('passes only validated start input and returns 202',async()=>{
 m.start.mockResolvedValue({id});const response=await app.request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contactId:id,method:'callback_attestation',actionScope:'any'})});expect(response.status).toBe(202);expect(m.start).toHaveBeenCalledWith(expect.objectContaining({userId:id}),expect.objectContaining({orgId:org,contactId:id}));
 m.get.mockResolvedValue({id});expect((await app.request(`${path}/${id}`)).status).toBe(200);expect((await app.request(`${path}/not-a-uuid`)).status).toBe(400);
});
it('404s every route while dark, then requires authentication',async()=>{
 vi.stubEnv('CALLER_VERIFICATION_ENABLED','false');expect((await app.request(`${path}/${id}`)).status).toBe(404);
 vi.stubEnv('CALLER_VERIFICATION_ENABLED','true');m.auth=null;expect((await app.request(`${path}/${id}`)).status).toBe(401);
});
it('requires write plus MFA and validates start bodies',async()=>{
 vi.stubEnv('CALLER_VERIFICATION_ENABLED','true');m.auth={scope:'organization',user:{id,name:'Tech'},partnerId:null,accessibleOrgIds:[org],allowedSiteIds:null,canAccessOrg:()=>true};
 const request=()=>app.request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contactId:id,method:'callback_attestation',actionScope:'any'})});
 m.write=false;expect((await request()).status).toBe(403);m.write=true;m.mfa=false;expect((await request()).status).toBe(403);m.mfa=true;
 expect((await app.request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status).toBe(400);expect(m.start).not.toHaveBeenCalled();
});
```

- [ ] **Step 1a: Cover the public readiness producer.** Extend existing `apps/api/src/routes/config.test.ts` inside its `GET /config` describe (reuse `request`). Add `callerVerification:false` to both existing exact `features` expectations. In its `beforeEach`, `vi.stubEnv('CALLER_VERIFICATION_ENABLED','false')`; in `afterEach`, `vi.unstubAllEnvs()`.

```ts
it.each(['true','false','','garbage'])('returns caller verification readiness for %s',async value=>{
 vi.stubEnv('CALLER_VERIFICATION_ENABLED',value);
 const {status,body}=await request();
 expect(status).toBe(200);expect(body.features.callerVerification).toBe(value==='true');
});
```

In `apps/api/src/routes/config.ts`, import `isCallerVerificationEnabled` from `../services/callerVerification/gate` and add this property inside the existing `features` object:

```ts
callerVerification: isCallerVerificationEnabled(),
```

Run `cd apps/api && npx vitest run src/routes/config.test.ts src/services/callerVerification/readiness.test.ts`. Both response values must pass through the real getter. W01 keeps unset false. W05 Task 14 must **replace** Task 5's inherited unset expectation when activating the default, preserving explicit-false and invalid cases; use this exact replacement there (not in W01):

```ts
it.each([[undefined,true],['',false],['false',false],['1',false],['yes',false],['TRUE',false],['garbage',false],['true',true]] as const)(
 'activated readiness value %s', (value,expected)=>{
  vi.stubEnv('CALLER_VERIFICATION_ENABLED',value);
  expect(callerVerificationEnabled()).toBe(expected);
 });
```

That later activation runs `cd apps/api && npx vitest run src/services/callerVerification/readiness.test.ts src/config/env.callerVerification.test.ts src/routes/config.test.ts`; its activation commit includes the inherited readiness test. W01's Step 5 below commits only the default-off producer and tests.

- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/routes/callerVerification.test.ts`. Expected: missing router.
- [ ] **Step 3: Implement the thin router.** Route-local middleware avoids a wildcard flag/auth gate accidentally applying to unrelated APIs. Export `canReachContactSite` in orgContacts; its null-site exception is preserved exactly.

```ts
import { Hono,type Context,type MiddlewareHandler } from 'hono';
import { zValidator } from '../lib/validation';
import { and,eq,isNull,sql } from 'drizzle-orm';
import { startCallerVerificationSchema,attestCallerVerificationSchema,callerVerificationBindingSchema,callerVerificationPolicySchema,callerVerificationFenceOverrideSchema,callerVerificationMethodsQuerySchema } from '@breeze/shared';
import { authMiddleware,requireScope,requirePermission,requireMfa,withAuthDbAccessContext,type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { canManagePartnerWidePolicies } from '../services/partnerWideAccess';
import { canReachContactSite } from './orgContacts';
import { db } from '../db';
import { callerVerificationPolicies as p,callerVerificationSubjectBindings as b,callerVerificationDestinations as d } from '../db/schema/callerVerification';
import { organizations } from '../db/schema/orgs';
import { callerVerificationEnabled } from '../config/env';
import * as service from '../services/callerVerification/service';
import { bindingsForContact,attestBinding,revokeBinding } from '../services/callerVerification/subjects';
import { attestDestination,isEstablished } from '../services/callerVerification/destinations';
import { reachableContact } from '../services/callerVerification/access';
import { fenceOverride } from '../services/callerVerification/rejection';
import { getEffectivePolicy,resolveEffectivePolicy,getPolicyResponse } from '../services/callerVerification/policy';
import { CallerVerificationRequiredError,CallerVerificationValidationError } from '../services/callerVerification/errors';
import { importDirectoryContact } from '../services/contacts/import';
import type { CallerVerificationActor } from '../services/callerVerification/types';
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';
export const callerVerificationRoutes=new Hono();
const enabled:MiddlewareHandler=async(c,next)=>callerVerificationEnabled()?next():c.json({error:'Not found'},404);
const read=requirePermission(PERMISSIONS.ORGS_READ.resource,PERMISSIONS.ORGS_READ.action),write=requirePermission(PERMISSIONS.ORGS_WRITE.resource,PERMISSIONS.ORGS_WRITE.action);
const uuidParams:MiddlewareHandler=async(c,next)=>{for(const [key,value] of Object.entries(c.req.param()))if(['orgId','contactId','id','bindingId','ticketId'].includes(key)&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))return c.json({error:'Invalid identifier'},400);return next();};
const base=[enabled,authMiddleware,requireScope('organization','partner','system'),uuidParams] as const;
const actor=(c:Context):CallerVerificationActor=>{const a=c.get('auth') as AuthContext;return {userId:a.user.id,partnerId:a.partnerId,scope:a.scope==='organization'?'organization':'partner',accessibleOrgIds:a.accessibleOrgIds,allowedSiteIds:a.allowedSiteIds??null,displayName:a.user.name??a.user.email};};
const oid=(c:Context)=>c.req.param('orgId')!,cid=(c:Context)=>c.req.param('contactId')!;
const orgPath='/orgs/:orgId',cv=`${orgPath}/caller-verifications`,contact=`${orgPath}/contacts/:contactId`;
async function contactCheck(c:Context){const a=c.get('auth') as AuthContext;const row=await reachableContact(actor(c),oid(c),cid(c));if(!canReachContactSite(a,row.siteId))throw new CallerVerificationValidationError('not_found','Contact not found');return row;}
callerVerificationRoutes.onError((e,c)=>{
 if(e instanceof CallerVerificationRequiredError)return c.json({error:'caller_verification_required',requiresCallerVerification:e.payload},409);
 if(e instanceof CallerVerificationValidationError)return c.json({error:e.message,code:e.code},e.code==='not_found'||e.code==='feature_disabled'?404:e.code==='attempt_cap'?429:400);
 throw e;
});
callerVerificationRoutes.post(cv,...base,write,requireMfa(),zValidator('json',startCallerVerificationSchema),async c=>{
 const limit=await rateLimiter(getRedis(),`caller-start:${actor(c).userId}`,10,600);if(!limit.allowed)return c.json({error:'Rate limited'},429);
 return c.json({data:await service.start(actor(c),{...c.req.valid('json'),orgId:oid(c)})},202);
});
callerVerificationRoutes.get(`${cv}/:id`,...base,read,async c=>c.json({data:await service.get(actor(c),oid(c),c.req.param('id'))}));
callerVerificationRoutes.post(`${cv}/:id/cancel`,...base,write,requireMfa(),async c=>c.json({data:await service.cancel(actor(c),oid(c),c.req.param('id'))}));
callerVerificationRoutes.post(`${cv}/:id/attest`,...base,write,requireMfa(),zValidator('json',attestCallerVerificationSchema),async c=>c.json({data:await service.attest(actor(c),oid(c),c.req.param('id'),c.req.valid('json').note)}));
callerVerificationRoutes.get(`${contact}/caller-verifications`,...base,read,async c=>{
 await contactCheck(c);const orgId=oid(c),contactId=cid(c),policy=await getEffectivePolicy(orgId);
 const destinations=await db.select().from(d).where(and(eq(d.orgId,orgId),eq(d.contactId,contactId),isNull(d.supersededAt)));
 return c.json({data:{...await service.listForContact(actor(c),orgId,contactId),bindings:await bindingsForContact(orgId,contactId),destinations:destinations.map(r=>({id:r.id,kind:r.kind,valueRedacted:r.valueRedacted,setAt:r.setAt,source:r.source,attestedAt:r.attestedAt,established:isEstablished(r,policy)}))}});
});
callerVerificationRoutes.get(`${contact}/caller-verifications/methods`,...base,read,zValidator('query',callerVerificationMethodsQuerySchema),async c=>{await contactCheck(c);return c.json({data:await service.methodsForContact(actor(c),oid(c),cid(c),c.req.valid('query').actionScope)});});
callerVerificationRoutes.post(`${contact}/caller-verification-bindings`,...base,write,requireMfa(),zValidator('json',callerVerificationBindingSchema),async c=>{
 const auth=c.get('auth') as AuthContext,body=c.req.valid('json');await withAuthDbAccessContext(auth,()=>contactCheck(c));
 const row=await importDirectoryContact(auth,{orgId:oid(c),contactId:cid(c),directoryObjectId:body.entraOid,expectedTenantId:body.entraTenantId},'technician_attested');
 return c.json({data:row},row.revokedAt?409:201);
});
callerVerificationRoutes.delete(`${contact}/caller-verification-bindings/:bindingId`,...base,write,requireMfa(),async c=>{
 await contactCheck(c);const [row]=await db.select().from(b).where(and(eq(b.id,c.req.param('bindingId')),eq(b.orgId,oid(c)),eq(b.contactId,cid(c)))).limit(1);
 if(!row)return c.json({error:'Not found'},404);await revokeBinding(actor(c),oid(c),row.id);return c.json({data:{ok:true}});
});
callerVerificationRoutes.post(`${contact}/caller-verification-destinations/:id/attest`,...base,write,requireMfa(),async c=>{
 await contactCheck(c);const [row]=await db.select().from(d).where(and(eq(d.id,c.req.param('id')),eq(d.orgId,oid(c)),eq(d.contactId,cid(c)))).limit(1);
 if(!row)return c.json({error:'Not found'},404);const result=await attestDestination(actor(c),oid(c),row.id);return c.json({data:{id:result.id,attestedAt:result.attestedAt}});
});
callerVerificationRoutes.post(`${contact}/caller-verifications/fence-override`,...base,write,requireMfa(),zValidator('json',callerVerificationFenceOverrideSchema),async c=>{await contactCheck(c);await fenceOverride(actor(c),oid(c),cid(c),c.req.valid('json').reason);return c.json({data:{ok:true}});});
callerVerificationRoutes.get(`${orgPath}/tickets/:ticketId/caller-verification`,...base,read,async c=>c.json({data:await service.freshForTicket(actor(c),oid(c),c.req.param('ticketId'))}));
for(const owner of ['org','partner'] as const){
 const path=owner==='org'?`${orgPath}/caller-verification-policy`:'/partner/caller-verification-policy';
 const ownerWhere=async(c:Context)=>{
  const a=c.get('auth') as AuthContext;if(owner==='partner'){if(!a.partnerId||a.scope==='organization')throw new CallerVerificationValidationError('not_found','Policy not found');return eq(p.partnerId,a.partnerId);}
  if(a.scope!=='system'&&!a.canAccessOrg(oid(c)))throw new CallerVerificationValidationError('not_found','Policy not found');
  const [org]=await db.select({id:organizations.id}).from(organizations).where(eq(organizations.id,oid(c))).limit(1);if(!org)throw new CallerVerificationValidationError('not_found','Policy not found');return eq(p.orgId,oid(c));
 };
 callerVerificationRoutes.get(path,...base,read,async c=>{await ownerWhere(c);return c.json({data:await getPolicyResponse(owner,owner==='org'?oid(c):(c.get('auth') as AuthContext).partnerId!)});});
 callerVerificationRoutes.put(path,...base,write,requireMfa(),zValidator('json',callerVerificationPolicySchema),async c=>{
  const a=c.get('auth') as AuthContext;if(owner==='partner'&&!canManagePartnerWidePolicies(a))return c.json({error:'Partner-wide administration required'},403);
  const where=await ownerWhere(c);await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`caller-policy:${owner}:${owner==='org'?oid(c):a.partnerId}`}))`);
  const [before]=await db.select().from(p).where(where).limit(1),patch=c.req.valid('json');
  const [row]=before?await db.update(p).set({...patch,updatedByUserId:a.user.id,updatedAt:new Date()}).where(where).returning():await db.insert(p).values({...patch,orgId:owner==='org'?oid(c):null,partnerId:owner==='partner'?a.partnerId:null,updatedByUserId:a.user.id}).returning();
  const old=resolveEffectivePolicy(before??null,null),next=resolveEffectivePolicy(row!,null);
  const weakened=owner==='partner'&&(next.requiredTierResetPassword<old.requiredTierResetPassword||next.requiredTierDisableUser<old.requiredTierDisableUser||(next.destinationMinAgeDays===0&&old.destinationMinAgeDays!==0)||(!old.allowCrossTechnicianUse&&next.allowCrossTechnicianUse));
  await db.execute(sql`INSERT INTO audit_logs(org_id,actor_type,actor_id,action,resource_type,resource_id,result,details) VALUES(${owner==='org'?oid(c):null}::uuid,'user',${a.user.id}::uuid,${weakened?'caller_verification.policy_weakened':'caller_verification.policy_updated'},'caller_verification',${row!.id}::uuid,'success',${JSON.stringify({before:before??null,after:row})}::jsonb)`);
  return c.json({data:await getPolicyResponse(owner,owner==='org'?oid(c):a.partnerId!)});
 });
}
```

Add this precise self-managed entry alongside Task 8's directory GET/sync POST entries so all three Graph operations manage their own short DB phases:

```ts
{ method:'POST',pattern:/^\/api\/v1\/orgs\/[^/]+\/contacts\/[^/]+\/caller-verification-bindings\/?$/ },
```

Append the exact route-selection test to `selfManagedDbContextRoutes.test.ts`:

```ts
it('self-manages the Graph binding POST but not ordinary verification writes',()=>{
 const path='/api/v1/orgs/o/contacts/c/caller-verification-bindings';
 expect(isSelfManagedDbContextRoute('POST',path)).toBe(true);
 expect(isSelfManagedDbContextRoute('DELETE',`${path}/b`)).toBe(false);
 expect(isSelfManagedDbContextRoute('POST','/api/v1/orgs/o/caller-verifications')).toBe(false);
});
```
 The binding, directory-search and directory-sync handlers' every DB phase explicitly uses `withAuthDbAccessContext`; its Graph fetch runs with no held transaction. Mount in `apps/api/src/index.ts` with `import { callerVerificationRoutes } from './routes/callerVerification';` and `api.route('/', callerVerificationRoutes);` beside line 834. No unauthenticated `/verify` route is added.

Create `services/callerVerification/index.ts`:

```ts
export * from './types';
export * from './errors';
export * from './locks';
export * from './policy';
export * from './tiers';
export * from './subjects';
export * from './destinations';
export * from './service';
export * from './gate';
export * from './rejection';
```

- [ ] **Step 4:** Run `cd apps/api && npx vitest run src/routes/callerVerification.test.ts src/routes/orgContacts.test.ts src/middleware/selfManagedDbContextRoutes.test.ts`. Expected: PASS. The route matrix tests flag/auth/permissions/MFA for every descriptor; service tests exercise foreign-org/site/ticket denial and the integration suite checks child ownership at the database boundary.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/routes/config.ts apps/api/src/routes/config.test.ts apps/api/src/routes/callerVerification.ts apps/api/src/routes/callerVerification.test.ts apps/api/src/routes/orgContacts.ts apps/api/src/index.ts apps/api/src/services/callerVerification/index.ts apps/api/src/middleware/selfManagedDbContextRoutes.ts apps/api/src/middleware/selfManagedDbContextRoutes.test.ts
git commit -m "feat(caller-verification): expose permission-gated verification and policy APIs"
```

### Task 15: One live-DB suite for isolation, merge, erasure and races

**Files:** Create `apps/api/src/__tests__/integration/callerVerification.integration.test.ts` only. Existing harness: `setup.ts:54,84`, `db-utils.ts:129,176,216`; real merge example `orgMerge.integration.test.ts:789`.

**Interfaces:** Consumes production `withDbAccessContext`, `withSystemDbAccessContext`, `executeOrgMerge(input: ExecuteOrgMergeInput): Promise<OrgMergeResult>`, `requireCallerVerification`, real JWT-authenticated routers and directory/login helpers; produces live assertions for SQLSTATE 42501/23503/23514/22001, own-site positive controls, sibling/foreign refusals, response projections, sync completion, move invalidation, atomic decisions and exactly-one-consumer semantics. No mocked RLS and no rollback-only merge fixture.

- [ ] **Step 1: Write the integration tests below.** Each rejected write has its own transaction; a 42501 must be the database error, not an application guard. The normal integration runner already attaches setup; do not attach a second truncate hook.

```ts
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach,afterEach,expect,it } from 'vitest';
import { and,eq,sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { createPartner,createOrganization,createUser } from './db-utils';
import { db,withDbAccessContext,withSystemDbAccessContext } from '../../db';
import { contacts } from '../../db/schema/contacts';
import { actionIntents } from '../../db/schema/actionIntents';
import { auditLogs } from '../../db/schema/audit';
import { incidents } from '../../db/schema/incidentResponse';
import { tickets,ticketComments } from '../../db/schema/portal';
import { ticketOutbox } from '../../db/schema/ticketOutbox';
import { callerVerifications as v,callerVerificationSubjectBindings as b,callerVerificationDestinations as d,callerVerificationPolicies as p } from '../../db/schema/callerVerification';
import { executeOrgMerge } from '../../services/orgMerge';
import { requireCallerVerification } from '../../services/callerVerification/gate';
import { handleRejection } from '../../services/callerVerification/rejection';
let partner:string,A:string,B:string,user:string,ca:string,cb:string,ca2:string,ba:string,bb:string,ba2:string,da:string,dbb:string;
const tenant='11111111-1111-4111-8111-111111111111',oid='22222222-2222-4222-8222-222222222222';
const sys=<T>(fn:()=>Promise<T>)=>withSystemDbAccessContext(fn,'callerVerification.integration');
const org=(id:string)=>({scope:'organization' as const,orgId:id,accessibleOrgIds:[id],accessiblePartnerIds:[],currentPartnerId:partner,userId:user});
function values(orgId=A,contactId=ca){return {orgId,contactId,initiatedByUserId:user,technicianLabel:'Tech',actionScope:'reset_password' as const,method:'callback_attestation' as const,status:'verified' as const,tier:1,tierReason:'attestation',matchValue:'42',decoyValues:['11','73'],reverseCode:'1234',attemptNo:1,expiresAt:new Date(),decidedAt:new Date(),targetEntraTenantId:tenant,targetEntraOid:oid};}
async function grant(patch:Partial<typeof v.$inferInsert>={}){const [r]=await sys(()=>db.insert(v).values({...values(),requesterBindingId:ba,targetBindingId:ba,...patch}).returning());return r!;}
async function code(promise:Promise<unknown>,expected:string){try{await promise;throw new Error('Expected a SQLSTATE failure');}catch(e){const err=e as {code?:string;cause?:{code?:string}};expect(err.code??err.cause?.code).toBe(expected);}}
beforeEach(async()=>{
 process.env.CALLER_VERIFICATION_ENABLED='true';process.env.ORG_MERGE_FENCE_DRAIN_MS='0';
 partner=(await createPartner())!.id;A=(await createOrganization({partnerId:partner}))!.id;B=(await createOrganization({partnerId:partner}))!.id;
 user=(await createUser({partnerId:partner,email:`cv-${randomUUID()}@example.com`,status:'active'}))!.id;
 await sys(async()=>{
  const rows=await db.insert(contacts).values([{orgId:A,name:'A',roles:['admin']},{orgId:B,name:'B'},{orgId:A,name:'A2'}]).returning();[ca,cb,ca2]=rows.map(r=>r.id) as [string,string,string];
  const bindings=await db.insert(b).values([{orgId:A,contactId:ca,entraTenantId:tenant,entraOid:oid,source:'directory_sync',osPrincipal:'sid:collision'},{orgId:B,contactId:cb,entraTenantId:tenant,entraOid:oid,source:'directory_sync',osPrincipal:'sid:collision'},{orgId:A,contactId:ca2,entraTenantId:tenant,entraOid:randomUUID(),source:'directory_sync'}]).returning();[ba,bb,ba2]=bindings.map(r=>r.id) as [string,string,string];
  const destinations=await db.insert(d).values([{orgId:A,contactId:ca,kind:'email',valueHash:'a'.repeat(64),valueRedacted:'a***@example.com',source:'import'},{orgId:B,contactId:cb,kind:'email',valueHash:'b'.repeat(64),valueRedacted:'b***@example.com',source:'import'}]).returning();[da,dbb]=destinations.map(r=>r.id) as [string,string];
  await db.insert(p).values({partnerId:partner,requiredTierResetPassword:1,requiredTierDisableUser:1});
 });
});
afterEach(()=>{delete process.env.CALLER_VERIFICATION_ENABLED;delete process.env.ORG_MERGE_FENCE_DRAIN_MS;});
it('cross-org insert forgery is 42501 on all four tables; own writes succeed',async()=>{
 const attempts=[
  ()=>db.insert(b).values({orgId:B,contactId:cb,entraTenantId:tenant,entraOid:randomUUID(),source:'directory_sync'}),
  ()=>db.insert(d).values({orgId:B,contactId:cb,kind:'mobile',valueHash:'c'.repeat(64),valueRedacted:'+***12',source:'import'}),
  ()=>db.insert(v).values({...values(B,cb),requesterBindingId:bb,targetBindingId:bb}),
  ()=>db.insert(p).values({orgId:B,requiredTierResetPassword:3}),
 ];
 for(const attempt of attempts)await code(withDbAccessContext(org(A),async()=>{await attempt();}),'42501');
 await withDbAccessContext(org(A),async()=>{await db.insert(p).values({orgId:A,requireTicket:true});expect(await db.select().from(b)).toHaveLength(2);});
});
it('system context cannot forge composite ownership, including same-org other contact',async()=>{
 for(const patch of [{requesterBindingId:bb},{targetBindingId:bb},{destinationId:dbb},{requesterBindingId:ba2}])await code(grant(patch),'23503');
 const [otherDestination]=await sys(()=>db.insert(d).values({orgId:A,contactId:ca2,kind:'mobile',valueHash:'d'.repeat(64),valueRedacted:'+***13',source:'technician'}).returning());
 await code(grant({destinationId:otherDestination!.id}),'23503');
 expect((await grant({destinationId:da})).destinationId).toBe(da);
});
it('replaying the backfill preserves existing epochs and never supplies attestation',async()=>{
 const historical=new Date('2026-01-01T00:00:00Z');
 await sys(()=>db.update(contacts).set({email:'legacy@example.com',mobile:'+15551234567',updatedAt:historical}).where(eq(contacts.id,ca2)));
 const body=readFileSync(new URL('../../../migrations/2026-10-15-180200-caller-verification-destinations-backfill.sql',import.meta.url),'utf8');
 const block=body.slice(body.indexOf('DO $$'));
 await sys(()=>db.execute(sql.raw(block)));
 const first=await sys(()=>db.select().from(d).where(eq(d.contactId,ca2)));expect(first).toHaveLength(2);
 for(const row of first)expect(row).toMatchObject({source:'import',setAt:historical,attestedAt:null});
 await sys(()=>db.update(d).set({attestedAt:new Date(),attestedByUserId:user}).where(eq(d.id,first[0]!.id)));
 const before=await sys(()=>db.select().from(d).where(eq(d.contactId,ca2)));
 await sys(()=>db.execute(sql.raw(block)));
 expect(await sys(()=>db.select().from(d).where(eq(d.contactId,ca2)))).toEqual(before);
});
it('XOR rejects both and neither owner; org token sees but cannot mutate partner baseline',async()=>{
 await code(sys(()=>db.insert(p).values({orgId:A,partnerId:partner})),'23514');await code(sys(()=>db.insert(p).values({})),'23514');
 await withDbAccessContext(org(A),async()=>{
  expect((await db.select().from(p).where(eq(p.partnerId,partner))).length).toBe(1);
  expect(await db.update(p).set({requiredTierResetPassword:0}).where(eq(p.partnerId,partner)).returning()).toEqual([]);
  expect(await db.delete(p).where(eq(p.partnerId,partner)).returning()).toEqual([]);
 });
 const other=await createPartner();await code(withDbAccessContext(org(A),()=>db.insert(p).values({partnerId:other!.id})),'42501');
});
it('direct child deletion nulls only reference columns; requester hard-delete cascades history',async()=>{
 const r=await grant({destinationId:da});
 await sys(()=>db.delete(d).where(eq(d.id,da)));await sys(()=>db.delete(b).where(eq(b.id,ba)));
 const [kept]=await sys(()=>db.select().from(v).where(eq(v.id,r.id)));
 expect(kept).toMatchObject({orgId:A,contactId:ca,requesterBindingId:null,targetBindingId:null,destinationId:null});
 await sys(()=>db.insert(b).values({orgId:A,contactId:ca,entraTenantId:tenant,entraOid:randomUUID(),source:'directory_sync'}));
 await sys(()=>db.insert(d).values({orgId:A,contactId:ca,kind:'mobile',valueHash:'e'.repeat(64),valueRedacted:'+***11',source:'technician'}));
 await sys(()=>db.delete(contacts).where(eq(contacts.id,ca)));
 expect(await sys(()=>db.select().from(v).where(eq(v.id,r.id)))).toEqual([]);
 expect(await sys(()=>db.select().from(d).where(eq(d.contactId,ca)))).toEqual([]);
 expect(await sys(()=>db.select().from(b).where(eq(b.contactId,ca)))).toEqual([]);
});
it('deleting target contact leaves requester history and refuses target_rebound',async()=>{
 const [target]=await sys(()=>db.select().from(b).where(eq(b.id,ba2)));
 const r=await grant({actionScope:'disable_user',targetBindingId:ba2,targetEntraOid:target!.entraOid});
 await sys(()=>db.delete(contacts).where(eq(contacts.id,ca2)));
 const [kept]=await sys(()=>db.select().from(v).where(eq(v.id,r.id)));expect(kept).toMatchObject({contactId:ca,orgId:A,targetBindingId:null,targetEntraOid:target!.entraOid});
 await expect(requireCallerVerification({orgId:A,action:'disable_user',target:{entraTenantId:tenant,entraOid:target!.entraOid!},backendTenantId:tenant,technicianUserId:user,intentId:randomUUID(),mode:'consume'})).rejects.toMatchObject({payload:{reason:'target_rebound'}});
});
it('exactly one of two intents consumes; same-intent retry succeeds',async()=>{
 const r=await grant(),ids=[randomUUID(),randomUUID()];
 const input={orgId:A,action:'reset_password' as const,target:{entraTenantId:tenant,entraOid:oid},backendTenantId:tenant,technicianUserId:user,mode:'consume' as const};
 const results=await Promise.allSettled(ids.map(intentId=>requireCallerVerification({...input,intentId})));
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
 const [stored]=await sys(()=>db.select().from(v).where(eq(v.id,r.id)));expect(stored!.consumedAt).not.toBeNull();
 expect(await requireCallerVerification({...input,intentId:stored!.consumedIntentRef!})).toEqual({verificationId:r.id,tier:1});
});
it('late rejection is idempotent and revokes other unconsumed grants',async()=>{
 const [ticket]=await sys(()=>db.insert(tickets).values({orgId:A,partnerId:partner,requesterContactId:ca,ticketNumber:`CV-${randomUUID()}`,subject:'Caller verification test'}).returning());
 const late=await grant({status:'expired',ticketRef:ticket!.id}),other=await grant();
 await sys(()=>handleRejection(late.id));await sys(()=>handleRejection(late.id));
 expect(await sys(()=>db.select().from(incidents).where(eq(incidents.sourceRef,late.id)))).toHaveLength(1);
 expect(await sys(()=>db.select().from(auditLogs).where(and(eq(auditLogs.resourceId,late.id),eq(auditLogs.action,'caller_verification.rejected'))))).toHaveLength(1);
 const [row]=await sys(()=>db.select().from(v).where(eq(v.id,other.id)));expect(row!.status).toBe('revoked');
 expect(await sys(()=>db.select().from(ticketComments).where(eq(ticketComments.ticketId,ticket!.id)))).toHaveLength(1);
 const outbox=await sys(()=>db.select().from(ticketOutbox).where(eq(ticketOutbox.ticketId,ticket!.id)));expect(outbox).toHaveLength(1);expect(outbox[0]!.payload).toMatchObject({verificationId:late.id,event:'rejected'});
});
it('real committed org merge handles pending, consumed and colliding identities',async()=>{
 const pending=await grant({orgId:B,contactId:cb,requesterBindingId:bb,targetBindingId:bb,status:'pending',decidedAt:null});
 const fresh=await grant({orgId:B,contactId:cb,requesterBindingId:bb,targetBindingId:bb});
 const intentId=randomUUID();
 await sys(()=>db.insert(actionIntents).values({id:intentId,orgId:B,partnerId:partner,requestedByUserId:user,source:'mcp_api',originPrincipalKind:'user_session',originPrincipalId:user,actionName:'m365_disable_user',argumentDigest:'a'.repeat(64),targetSummary:'Disable user',impactSummary:'Blocks sign-in',riskTier:3,idempotencyKey:randomUUID(),correlationId:randomUUID(),expiresAt:new Date(Date.now()+60000)}));
 const consumed=await grant({orgId:B,contactId:cb,requesterBindingId:bb,targetBindingId:bb,consumedAt:new Date(),consumedIntentRef:intentId});
 await sys(()=>db.insert(p).values([{orgId:A,requireTicket:true},{orgId:B,requireTicket:false}]));
 await executeOrgMerge({loserOrgId:B,survivorOrgId:A,partnerId:partner,performedBy:user});
 const all=await sys(()=>db.select().from(v));
 expect(all.find(r=>r.id===pending.id)).toMatchObject({orgId:A,status:'expired'});
 expect(all.find(r=>r.id===fresh.id)).toMatchObject({orgId:A,status:'revoked'});
 expect(all.find(r=>r.id===consumed.id)).toMatchObject({orgId:A,consumedIntentRef:intentId});expect(all.find(r=>r.id===consumed.id)!.consumedAt).not.toBeNull();
 const mergedBindings=await sys(()=>db.select().from(b));expect(mergedBindings.filter(r=>[ba,bb].includes(r.id)).every(r=>r.orgId===A&&r.revokedAt!==null)).toBe(true);
 expect((await sys(()=>db.select().from(p).where(eq(p.orgId,A))))[0]!.requireTicket).toBe(true);
 expect((await getTestDb().select().from(actionIntents).where(eq(actionIntents.id,intentId)))[0]!.orgId).toBe(B);
 expect((await sys(()=>db.select().from(auditLogs).where(eq(auditLogs.action,'caller_verification.binding_conflict')))).length).toBeGreaterThanOrEqual(2);
});
```

- [ ] **Step 1a: Exercise the real authenticated HTTP routes, not service substitutes.** Append the following to the same integration file, merging imports. JWT issuance, memberships, permissions, site reach, RLS and service mutations are real. Only the external directory-read seam is mocked. Mount `/api/v1` so the self-managed Graph-route selector is exercised. `setupTestEnvironment` and `createAccessToken` are the existing harness used by `billingEvidenceDeviceMove.integration.test.ts`; site membership/cache invalidation follows `alertsReadAuthorization.integration.test.ts`.

```ts
import { Hono } from 'hono';
import { vi } from 'vitest';
import { setupTestEnvironment,createSite } from './db-utils';
import { organizationUsers,devices,deviceCommands,m365Connections } from '../../db/schema';
import { createAccessToken } from '../../services/jwt';
import { clearPermissionCache } from '../../services/permissions';
import { callerVerificationRoutes } from '../../routes/callerVerification';
import { moveOrgRoutes } from '../../routes/devices/moveOrg';
import { createAdministrative,applyDecision } from '../../services/callerVerification/service';
import { observeLogin } from '../../services/callerVerification/subjects';
import { destinationHash } from '../../services/callerVerification/destinations';
import { observeSessionPrincipal } from '../../services/callerVerification/loginObservation';
import { callerVerificationPorts,configureCallerVerificationPorts } from '../../services/callerVerification/ports';
import { CALLER_VERIFICATION_POLICY_DEFAULTS } from '../../services/callerVerification/policy';
import type { CallerVerificationActor } from '../../services/callerVerification/types';
const directoryRead=vi.hoisted(()=>vi.fn());
vi.mock('../../services/m365ControlPlane/readActionService',()=>({executeM365ReadAction:directoryRead}));
const liveApp=new Hono().route('/api/v1',callerVerificationRoutes).route('/api/v1/devices',moveOrgRoutes);
const originalPorts={...callerVerificationPorts};
afterEach(()=>{configureCallerVerificationPorts(originalPorts);directoryRead.mockReset();});
function expectHttpVerification(value:Record<string,unknown>){
 expect(value.remainingAttempts).toEqual(expect.any(Number));
 for(const key of ['usableUntil','incidentId','consumedAction','undeliverableReason']){
  expect(value).toHaveProperty(key);expect(value[key]===null||typeof value[key]==='string',key).toBe(true);
 }
 expect(value).not.toHaveProperty('challengeTokenHash');expect(value).not.toHaveProperty('deliveryPayload');
}
async function liveFixture(scope:'organization'|'partner'='organization',restricted=true){
 const env=await setupTestEnvironment({scope});
 const sibling=await createSite({orgId:env.organization.id}),other=await createOrganization({partnerId:env.partner.id}),otherSite=await createSite({orgId:other.id});
 if(scope==='organization'&&restricted){
  await getTestDb().update(organizationUsers).set({siteIds:[env.site.id]}).where(eq(organizationUsers.userId,env.user.id));
  await clearPermissionCache(env.user.id);
 }
 const token=await createAccessToken({sub:env.user.id,email:env.user.email,roleId:env.role.id,orgId:scope==='organization'?env.organization.id:null,partnerId:env.partner.id,scope,mfa:true,aep:1,mep:1,sid:randomUUID()});
 const request=(method:string,path:string,body?:unknown)=>liveApp.request(`/api/v1${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const tenants=new Map([[env.organization.id,randomUUID()],[other.id,randomUUID()]]);
 const families=await sys(async()=>{
  await db.insert(p).values({partnerId:env.partner.id,requiredTierResetPassword:1});
  for(const [orgId,tenantId] of tenants)await db.insert(m365Connections).values({orgId,tenantId,clientId:randomUUID(),profile:'customer-graph-read',authMode:'application-certificate',credentialDomain:'customer-graph-read',vaultRef:'akv://vault.example/test-certificate/version',credentialVersion:'test-version',permissionManifestVersion:1,status:'active'});
  const result=[];
  for(const [orgId,siteId] of [[env.organization.id,env.site.id],[env.organization.id,sibling.id],[other.id,otherSite.id]] as const){
   const [contact]=await db.insert(contacts).values({orgId,siteId,name:'HTTP caller',roles:['admin'],email:`${randomUUID()}@example.com`}).returning();
   const entraTenantId=tenants.get(orgId)!,entraOid=randomUUID();
   const [binding]=await db.insert(b).values({orgId,contactId:contact!.id,entraTenantId,entraOid,upnSnapshot:contact!.email,source:'directory_sync',osPrincipal:`sid:${entraOid}`}).returning();
   const [destination]=await db.insert(d).values({orgId,contactId:contact!.id,kind:'email',valueHash:destinationHash(contact!.email!),valueRedacted:'h***@example.com',source:'import',setAt:new Date(Date.now()-10*86400000)}).returning();
   const [ticket]=await db.insert(tickets).values({orgId,partnerId:env.partner.id,requesterContactId:contact!.id,ticketNumber:`HTTP-${randomUUID()}`,subject:'Caller route fixture'}).returning();
   const [verification]=await db.insert(v).values({orgId,contactId:contact!.id,requesterBindingId:binding!.id,targetBindingId:binding!.id,targetEntraTenantId:entraTenantId,targetEntraOid:entraOid,initiatedByUserId:env.user.id,technicianLabel:'HTTP technician',method:'callback_attestation',actionScope:'reset_password',status:'pending',tier:1,tierReason:'attestation',matchValue:'42',decoyValues:['11','73'],reverseCode:'1234',attemptNo:1,expiresAt:new Date(Date.now()+600000),ticketRef:ticket!.id,ticketNumber:ticket!.ticketNumber.slice(0,32)}).returning();
   result.push({orgId,siteId,contact:contact!,binding:binding!,destination:destination!,ticket:ticket!,verification:verification!});
  }return result;
 });
 const actor:CallerVerificationActor={userId:env.user.id,partnerId:env.partner.id,scope,accessibleOrgIds:scope==='organization'?[env.organization.id]:[env.organization.id,other.id],allowedSiteIds:scope==='organization'&&restricted?[env.site.id]:null,displayName:env.user.name};
 return {env,request,actor,families};
}
type LiveFamily=Awaited<ReturnType<typeof liveFixture>>['families'][number];
const contactUrl=(f:LiveFamily)=>`/orgs/${f.orgId}/contacts/${f.contact.id}`;
const verificationUrl=(f:LiveFamily)=>`/orgs/${f.orgId}/caller-verifications/${f.verification.id}`;
type RouteCase={name:string;method:string;path:(f:LiveFamily)=>string;body?:(f:LiveFamily)=>unknown;status:number;projection?:'row'|'history'|'ticket'};
const liveCases:RouteCase[]=[
 {name:'get',method:'GET',path:verificationUrl,status:200,projection:'row'},
 {name:'history',method:'GET',path:f=>`${contactUrl(f)}/caller-verifications`,status:200,projection:'history'},
 {name:'methods',method:'GET',path:f=>`${contactUrl(f)}/caller-verifications/methods`,status:200},
 {name:'start',method:'POST',path:f=>`/orgs/${f.orgId}/caller-verifications`,body:f=>({contactId:f.contact.id,method:'callback_attestation',actionScope:'reset_password',ticketId:f.ticket.id}),status:202,projection:'row'},
 {name:'cancel',method:'POST',path:f=>`${verificationUrl(f)}/cancel`,status:200,projection:'row'},
 {name:'attest',method:'POST',path:f=>`${verificationUrl(f)}/attest`,body:()=>({note:'Called the established number and confirmed the requester.'}),status:200,projection:'row'},
 {name:'delete binding',method:'DELETE',path:f=>`${contactUrl(f)}/caller-verification-bindings/${f.binding.id}`,status:200},
 {name:'attest destination',method:'POST',path:f=>`${contactUrl(f)}/caller-verification-destinations/${f.destination.id}/attest`,status:200},
 {name:'override',method:'POST',path:f=>`${contactUrl(f)}/caller-verifications/fence-override`,body:()=>({reason:'Security confirmed the caller using an independent channel.'}),status:200},
 {name:'ticket',method:'GET',path:f=>`/orgs/${f.orgId}/tickets/${f.ticket.id}/caller-verification`,status:200,projection:'ticket'},
];
it.each(liveCases)('authenticated $name permits own site and denies sibling/foreign sites',async entry=>{
 const f=await liveFixture(),own=f.families[0]!;
 if(entry.name==='override')await sys(()=>db.update(v).set({status:'rejected_by_user',decidedAt:new Date()}).where(eq(v.id,own.verification.id)));
 const response=await f.request(entry.method,entry.path(own),entry.body?.(own));
 expect(response.status,await response.clone().text()).toBe(entry.status);const {data}=await response.json();
 if(entry.projection==='row')expectHttpVerification(data);
 if(entry.projection==='history'){expect(data.rows).toHaveLength(1);expectHttpVerification(data.rows[0]);}
 if(entry.projection==='ticket'){expect(data.row.id).toBe(own.verification.id);expectHttpVerification(data.row);}
 if(entry.name==='start')expect(data.id).not.toBe(own.verification.id);
 if(entry.name==='cancel')expect(data.status).toBe('cancelled');
 if(entry.name==='attest'){expect(data.status).toBe('verified');expect(data.usableUntil).not.toBeNull();}
 if(entry.name==='delete binding')expect((await sys(()=>db.select().from(b).where(eq(b.id,own.binding.id))))[0]!.revokedAt).not.toBeNull();
 if(entry.name==='attest destination')expect((await sys(()=>db.select().from(d).where(eq(d.id,own.destination.id))))[0]!.attestedByUserId).toBe(f.env.user.id);
 if(entry.name==='override')expect((await sys(()=>db.select().from(v).where(eq(v.id,own.verification.id))))[0]!.fenceOverrideUntil).not.toBeNull();
 for(const denied of f.families.slice(1)){
  const snapshot=()=>sys(async()=>({verifications:await db.select().from(v).where(eq(v.contactId,denied.contact.id)).orderBy(v.id),bindings:await db.select().from(b).where(eq(b.contactId,denied.contact.id)).orderBy(b.id),destinations:await db.select().from(d).where(eq(d.contactId,denied.contact.id)).orderBy(d.id)}));
  const before=await snapshot(),refusal=await f.request(entry.method,entry.path(denied),entry.body?.(denied));
  expect(refusal.status,await refusal.clone().text()).toBe(404);expect(await snapshot()).toEqual(before);
 }
});
it('manual binding uses Graph evidence and denies inaccessible contacts before Graph',async()=>{
 // Real Graph read actions reject site-constrained sessions, so the positive is unrestricted.
 const f=await liveFixture('organization',false),own=f.families[0]!;
 directoryRead.mockResolvedValue({ok:true,kind:'resource',resource:{id:own.binding.entraOid,userPrincipalName:own.binding.upnSnapshot}});
 const body=(x:LiveFamily)=>({entraTenantId:x.binding.entraTenantId,entraOid:x.binding.entraOid,upn:x.binding.upnSnapshot});
 const path=(x:LiveFamily)=>`${contactUrl(x)}/caller-verification-bindings`;
 const response=await f.request('POST',path(own),body(own));expect(response.status,await response.clone().text()).toBe(201);
 expect((await response.json()).data).toMatchObject({id:own.binding.id,source:'technician_attested',attestedByUserId:f.env.user.id});
 expect(directoryRead).toHaveBeenCalledTimes(1);
 await getTestDb().update(organizationUsers).set({siteIds:[f.env.site.id]}).where(eq(organizationUsers.userId,f.env.user.id));await clearPermissionCache(f.env.user.id);
 for(const denied of f.families.slice(1))expect((await f.request('POST',path(denied),body(denied))).status).toBe(404);
 expect(directoryRead).toHaveBeenCalledTimes(1);
});
it.each(['organization','partner'] as const)('%s policy GET/PUT return defaults, baseline, own row and effective',async scope=>{
 const f=await liveFixture(scope,false),orgId=f.env.organization.id;
 await sys(()=>db.insert(p).values({orgId,requiredTierResetPassword:3}));
 const path=scope==='partner'?'/partner/caller-verification-policy':`/orgs/${orgId}/caller-verification-policy`;
 const check=async(response:Response,baseline:number,effective:number)=>{
  expect(response.status,await response.clone().text()).toBe(200);const {data}=await response.json();
  expect(data.defaults).toEqual(CALLER_VERIFICATION_POLICY_DEFAULTS);expect(data.baseline.requiredTierResetPassword).toBe(baseline);expect(data.effective.requiredTierResetPassword).toBe(effective);
  expect(data.row[scope==='partner'?'partnerId':'orgId']).toBe(scope==='partner'?f.env.partner.id:orgId);
 };
 await check(await f.request('GET',path),1,scope==='partner'?1:3);
 const next=scope==='partner'?0:2;
 await check(await f.request('PUT',path,{requiredTierResetPassword:next}),scope==='partner'?0:1,next);
 await check(await f.request('GET',path),scope==='partner'?0:1,next);
});
it('admin factory keeps cap before proof consumption, incremented attempt and technician audit',async()=>{
 const f=await liveFixture(),own=f.families[0]!;
 await sys(()=>db.update(p).set({maxAttemptsPerHour:2}).where(eq(p.partnerId,f.env.partner.id)));
 const consume=vi.fn(async()=>({sid:randomUUID(),authEpoch:1,mfaEpoch:1}));configureCallerVerificationPorts({consumeStepUp:consume});
 const input={orgId:own.orgId,targetContactId:own.contact.id,reason:'Confirmed employee offboarding with the authorized HR manager.',stepUpGrantId:randomUUID()};
 const result=await sys(()=>createAdministrative(f.actor,input));expectHttpVerification(result as unknown as Record<string,unknown>);
 expect((await sys(()=>db.select().from(v).where(eq(v.id,result.id))))[0]!.attemptNo).toBe(2);
 const audit=await sys(()=>db.select().from(auditLogs).where(and(eq(auditLogs.resourceId,result.id),eq(auditLogs.action,'caller_verification.administrative_created'))));
 expect(audit).toHaveLength(1);expect(audit[0]).toMatchObject({actorType:'user',actorId:f.env.user.id});
 await expect(sys(()=>createAdministrative(f.actor,{...input,stepUpGrantId:randomUUID()}))).rejects.toMatchObject({code:'attempt_cap'});expect(consume).toHaveBeenCalledTimes(1);
});
async function liveDevice(f:LiveFamily){
 const [row]=await sys(()=>db.insert(devices).values({orgId:f.orgId,siteId:f.siteId,agentId:randomUUID(),hostname:'Caller workstation',osType:'windows',osVersion:'11',architecture:'x86_64',agentVersion:'test'}).returning());return row!;
}
it('real device move revokes old workstation authorization but preserves consumed history',async()=>{
 const f=await liveFixture('partner',false),own=f.families[0]!,foreign=f.families[2]!,device=await liveDevice(own);
 await sys(()=>db.update(v).set({method:'workstation',status:'verified',tier:3,tierReason:'bound_principal',decidedAt:new Date(),workstationDeviceRef:device.id,osPrincipalObserved:own.binding.osPrincipal}).where(eq(v.id,own.verification.id)));
 const consumedIntent=randomUUID(),consumedAt=new Date();
 const [consumed]=await sys(()=>db.insert(v).values({...own.verification,id:randomUUID(),method:'workstation',status:'verified',workstationDeviceRef:device.id,decidedAt:new Date(),consumedAt,consumedIntentRef:consumedIntent}).returning());
 const input={orgId:own.orgId,action:'reset_password' as const,target:{entraTenantId:own.binding.entraTenantId!,entraOid:own.binding.entraOid!},backendTenantId:own.binding.entraTenantId!,technicianUserId:f.env.user.id,intentId:randomUUID(),mode:'check' as const};
 expect(await requireCallerVerification(input)).toMatchObject({verificationId:own.verification.id});
 expect(await requireCallerVerification({...input,intentId:consumedIntent})).toMatchObject({verificationId:consumed!.id});
 const response=await f.request('POST',`/devices/${device.id}/move-org`,{orgId:foreign.orgId,siteId:foreign.siteId});expect(response.status,await response.clone().text()).toBe(200);
 expect((await sys(()=>db.select().from(v).where(eq(v.id,own.verification.id))))[0]).toMatchObject({orgId:own.orgId,workstationDeviceRef:device.id,status:'revoked',consumedAt:null});
 expect((await sys(()=>db.select().from(v).where(eq(v.id,consumed!.id))))[0]).toMatchObject({orgId:own.orgId,workstationDeviceRef:device.id,status:'verified',consumedIntentRef:consumedIntent,consumedAt});
 await expect(requireCallerVerification({...input,mode:'consume'})).rejects.toMatchObject({payload:{orgId:own.orgId}});
 await expect(requireCallerVerification({...input,intentId:consumedIntent,mode:'consume'})).rejects.toMatchObject({payload:{reason:'target_rebound'}});
});
```

- [ ] **Step 1b: Verify rollback, independent observations, and directory HTTP execution against Postgres.** Append to the same file; these tests use the real helpers introduced in Tasks 8/13 and the fixture above.

```ts
it.each(['organization','system'] as const)('observation failure rolls back decision, receipt and effects in ambient %s context',async scope=>{
 const f=await liveFixture(),own=f.families[0]!,device=await liveDevice(own);
 const [command]=await sys(()=>db.insert(deviceCommands).values({deviceId:device.id,type:'caller_verify',status:'completed',result:{receipt:'before'}}).returning());
 const decision={verificationId:own.verification.id,decision:{kind:'choice' as const,value:'42'},principal:{osPrincipal:own.binding.osPrincipal!,osUsername:'alex',upn:own.binding.upnSnapshot}};
 const context={scope:'organization' as const,orgId:own.orgId,accessibleOrgIds:[own.orgId],accessiblePartnerIds:[],currentPartnerId:f.env.partner.id,userId:f.env.user.id};
 const attempt=async()=>{
  await db.update(deviceCommands).set({result:{receipt:'handled'}}).where(eq(deviceCommands.id,command!.id));
  expect((await applyDecision(decision)).status).toBe('verified');
  // Real database failure in the observation write, after the decision succeeded.
  await observeLogin({orgId:own.orgId,contactId:own.contact.id,osPrincipal:own.binding.osPrincipal!,osUsername:'x'.repeat(256),upn:own.binding.upnSnapshot});
 };
 await code(scope==='system'?sys(attempt):withDbAccessContext(context,attempt),'22001');
 expect((await sys(()=>db.select().from(v).where(eq(v.id,own.verification.id))))[0]).toMatchObject({status:'pending',decidedAt:null});
 expect((await sys(()=>db.select().from(deviceCommands).where(eq(deviceCommands.id,command!.id))))[0]!.result).toEqual({receipt:'before'});
 expect(await sys(()=>db.select().from(ticketComments).where(eq(ticketComments.ticketId,own.ticket.id)))).toEqual([]);
 expect(await sys(()=>db.select().from(ticketOutbox).where(eq(ticketOutbox.ticketId,own.ticket.id)))).toEqual([]);
 expect(await sys(()=>db.select().from(auditLogs).where(eq(auditLogs.resourceId,own.verification.id)))).toEqual([]);
 // Positive control proves the same path commits all three when observation succeeds.
 await withDbAccessContext(context,async()=>{
  await db.update(deviceCommands).set({result:{receipt:'handled'}}).where(eq(deviceCommands.id,command!.id));
  await applyDecision(decision);
  await observeLogin({orgId:own.orgId,contactId:own.contact.id,...decision.principal});
 });
 expect((await sys(()=>db.select().from(v).where(eq(v.id,own.verification.id))))[0]!.status).toBe('verified');
 expect((await sys(()=>db.select().from(deviceCommands).where(eq(deviceCommands.id,command!.id))))[0]!.result).toEqual({receipt:'handled'});
 expect(await sys(()=>db.select().from(ticketOutbox).where(eq(ticketOutbox.ticketId,own.ticket.id)))).toHaveLength(1);
});
it('independent login resolves only a unique existing binding in its own org',async()=>{
 const upn='observed@example.com',principal={sid:'S-1-5-21-987',username:'alex',upn};
 await sys(()=>db.update(b).set({upnSnapshot:upn}).where(sql`${b.id} IN (${ba}::uuid,${bb}::uuid)`));
 await withDbAccessContext(org(A),()=>observeSessionPrincipal(A,'host','alex',principal));
 expect((await sys(()=>db.select().from(b).where(eq(b.id,ba))))[0]!.osPrincipal).toBe(principal.sid);
 expect((await sys(()=>db.select().from(b).where(eq(b.id,bb))))[0]!.osPrincipal).toBe('sid:collision');
 // Same UPN in another org alone must never create or update a local binding.
 await sys(()=>db.update(b).set({upnSnapshot:'different@example.com',osPrincipal:null}).where(eq(b.id,ba)));
 await withDbAccessContext(org(A),()=>observeSessionPrincipal(A,'host','alex',principal));
 expect((await sys(()=>db.select().from(b).where(eq(b.id,ba))))[0]!.osPrincipal).toBeNull();
 // Two canonical identities in the same org sharing a UPN are ambiguous.
 await sys(()=>db.update(b).set({upnSnapshot:upn}).where(sql`${b.id} IN (${ba}::uuid,${ba2}::uuid)`));
 await withDbAccessContext(org(A),()=>observeSessionPrincipal(A,'host','alex',principal));
 expect((await sys(()=>db.select().from(b).where(eq(b.id,ba))))[0]!.osPrincipal).toBeNull();
 expect((await sys(()=>db.select().from(b).where(eq(b.id,ba2))))[0]!.osPrincipal).toBeNull();
});
it('directory search returns W04 data envelope and enforces real route authorization',async()=>{
 const f=await liveFixture('organization',false),own=f.families[0]!;
 directoryRead.mockResolvedValue({ok:true,kind:'collection',items:[{id:own.binding.entraOid,userPrincipalName:own.binding.upnSnapshot,displayName:'Alex'}],truncated:false});
 const path=`/orgs/${own.orgId}/caller-verification-directory-users?search=alex`;
 const response=await f.request('GET',path);expect(response.status).toBe(200);
 expect(await response.json()).toEqual({data:{available:true,truncated:false,users:[{entraTenantId:own.binding.entraTenantId,entraOid:own.binding.entraOid,upn:own.binding.upnSnapshot,displayName:'Alex'}]}});
 expect((await f.request('GET',`/orgs/${f.families[2]!.orgId}/caller-verification-directory-users?search=alex`)).status).toBe(404);
 await getTestDb().update(organizationUsers).set({siteIds:[f.env.site.id]}).where(eq(organizationUsers.userId,f.env.user.id));await clearPermissionCache(f.env.user.id);
 expect((await f.request('GET',path)).status).toBe(404);expect(directoryRead).toHaveBeenCalledTimes(1);
});
it('directory HTTP search reports unavailable and sanitizes failed reads',async()=>{
 const f=await liveFixture('organization',false),own=f.families[0]!,path=`/orgs/${own.orgId}/caller-verification-directory-users?search=alex`;
 await sys(()=>db.update(m365Connections).set({status:'revoked'}).where(eq(m365Connections.orgId,own.orgId)));
 const unavailable=await f.request('GET',path);expect(unavailable.status).toBe(200);
 expect(await unavailable.json()).toEqual({data:{available:false,users:[],truncated:false}});expect(directoryRead).not.toHaveBeenCalled();
 await sys(()=>db.update(m365Connections).set({status:'active'}).where(eq(m365Connections.orgId,own.orgId)));
 directoryRead.mockResolvedValue({ok:false,message:'private Graph failure'});
 const failed=await f.request('GET',path);expect(failed.status).toBe(400);
 expect(await failed.json()).toEqual({code:'directory_unavailable',error:'Directory read unavailable'});
});
it.each(['complete','partial','failed','tenant-changed'] as const)('directory sync %s controls disappearance reconciliation',async mode=>{
 const f=await liveFixture('organization',false),own=f.families[0]!,missing=f.families[1]!,foreign=f.families[2]!;
 await sys(()=>db.update(v).set({status:'verified',decidedAt:new Date()}).where(eq(v.id,missing.verification.id)));
 const usedAt=new Date(),intentId=randomUUID();
 const [used]=await sys(()=>db.insert(v).values({...missing.verification,id:randomUUID(),status:'verified',decidedAt:new Date(),consumedAt:usedAt,consumedIntentRef:intentId}).returning());
 directoryRead.mockImplementation(async(_auth:unknown,action:{type:string})=>{
  if(mode==='failed')return {ok:false,message:'private upstream error'};
  if(mode==='tenant-changed')await sys(()=>db.update(m365Connections).set({tenantId:randomUUID()}).where(eq(m365Connections.orgId,own.orgId)));
  const resource={id:own.binding.entraOid,userPrincipalName:own.binding.upnSnapshot,mail:own.contact.email,displayName:'Alex'};
  return action.type==='m365.user.get'?{ok:true,kind:'resource',resource}:{ok:true,kind:'collection',items:[resource],truncated:mode==='partial'};
 });
 const response=await f.request('POST',`/orgs/${own.orgId}/caller-verification-directory-sync`,{mappings:[{contactId:own.contact.id,entraOid:own.binding.entraOid}]});
 expect(response.status,await response.clone().text()).toBe(mode==='complete'||mode==='partial'?200:400);
 if(response.status===200)expect((await response.json()).data).toMatchObject({imported:1,complete:mode==='complete',revoked:mode==='complete'?1:0});
 const [lost]=await sys(()=>db.select().from(b).where(eq(b.id,missing.binding.id)));
 expect(lost!.revokedAt!==null).toBe(mode==='complete');
 expect((await sys(()=>db.select().from(v).where(eq(v.id,missing.verification.id))))[0]!.status).toBe(mode==='complete'?'revoked':'verified');
 expect((await sys(()=>db.select().from(b).where(eq(b.id,foreign.binding.id))))[0]!.revokedAt).toBeNull();
 expect((await sys(()=>db.select().from(v).where(eq(v.id,used!.id))))[0]).toMatchObject({status:'verified',consumedAt:usedAt,consumedIntentRef:intentId});
});
```

Run `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/callerVerification.integration.test.ts` after Tasks 8/12–14. These additions are committed by this task's existing Step 5. W02's actual handler/receipt code lands later; it must run these inherited rollback cases as well as its transport-specific handler tests. W03 keeps the any-authorized-context transaction rule; W05 keeps the admin count/audit and additive projection assertions.

The administrative HTTP route remains W05-owned; its W01 factory returns this projection and W05 must retain it. The live route matrix tests mounted W01 routes, and W05 adds the administrative authenticated-route case once it mounts that endpoint.

- [ ] **Step 2:** From repository root run `pnpm test-stack up`, then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/callerVerification.integration.test.ts`. Expected initial failure if any RLS policy, composite FK, merge registration or gate race is incorrect; before implementing Tasks 1–14 this file fails on absent tables/modules. Record the actual SQLSTATE/test name, not just a nonzero exit code.
- [ ] **Step 3: Apply only the minimal corrections exposed by this suite.** The required production operations are already fully assigned in Tasks 1–14. For an FK failure the exact SQL is Task 1's column-specific constraints, for RLS Task 2's separate SELECT policy, for merge Task 4's two-pass hooks, and for concurrency Task 10's lock+CAS. Do not weaken assertions, seed as superuser to bypass the tested write, or add an RLS exemption. Add this catalog assertion to the same file so the smallest correct implementation is mechanical:

```ts
it('all six ownership FKs are deferrable and initially immediate',async()=>{
 const rows=await getTestDb().execute(sql`SELECT conname,condeferrable,condeferred FROM pg_constraint WHERE conname IN ('cv_bindings_contact_org_fk','cv_destinations_contact_org_fk','cv_contact_org_fk','cv_requester_fk','cv_target_fk','cv_destination_fk')`);
 expect(rows).toHaveLength(6);for(const r of rows as unknown as Array<{condeferrable:boolean;condeferred:boolean}>){expect(r.condeferrable).toBe(true);expect(r.condeferred).toBe(false);}
});
```

- [ ] **Step 4:** Re-run `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/callerVerification.integration.test.ts`. Expected: all tests execute and pass, zero skipped; no extra new live-DB file. Keep the stack until Task 16 finishes.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/__tests__/integration/callerVerification.integration.test.ts
git commit -m "test(caller-verification): prove isolation merge erasure and single-use consumption"
```

### Task 16: Wave verification, contract audit and PR

**Files:** Modify `apps/api/src/services/callerVerification/readiness.test.ts` (Task 5, final cross-wave export assertion); no new product scope. Review every implementation file listed above.

**Interfaces:** Consumes all public W01 exports and repository contract suites; produces a reviewed W01 PR with default-off rollout and explicit W02/W03/W05 seams. No merge or deployment in this task.

- [ ] **Step 1: Write the final failing export contract.**

```ts
it('exports every fixed cross-wave service entry point',async()=>{
 const api=await import('./index');
 for(const name of ['resolveEffectivePolicy','getEffectivePolicy','resolveTargetBinding','bindingsForContact','upsertDirectorySyncBinding','attestBinding','observeLogin','revokeBinding','recordDestinationChange','currentDestination','isEstablished','attestDestination','computeTier','start','createAdministrative','cancel','attest','get','listForContact','methodsForContact','freshForTicket','applyDecision','requireCallerVerification','isCallerVerificationEnabled','handleRejection','fenceOverride','withSubjectLocks'])expect(typeof api[name as keyof typeof api],name).toBe('function');
});
```

- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/callerVerification/readiness.test.ts`. Expected: FAIL if any public export is absent. For a deliberate red check, temporarily remove `export * from './rejection';` locally, observe the failing `handleRejection` assertion, then restore it before continuing.
- [ ] **Step 3: Minimal implementation is the verified barrel from Task 14.** Ensure this exact line is present: `export * from './rejection';`. Verify no implementation placeholder or unguarded adapter enables a method. Confirm `revokeIntentsForSubject` is the sole allowed W05 empty-array stub and admin/mailbox ports fail closed.
- [ ] **Step 4: Run targeted, type, contract and integration verification.** All commands below start from repository root in fresh shells; use subshells so paths do not accumulate.

```bash
(cd packages/shared && npx vitest run src/validators/callerVerification.test.ts && npx tsc --noEmit)
(cd apps/api && npx tsc --noEmit)
(cd agent && go test -race ./internal/collectors/... ./internal/heartbeat/...)
(cd apps/api && npx vitest run src/services/callerVerification src/routes/callerVerification.test.ts src/routes/config.test.ts src/routes/agents/sessions.test.ts src/routes/devices/moveOrg.test.ts src/routes/devices/moveOrg.coverage.test.ts src/db/schema/callerVerification.test.ts src/services/contacts src/routes/orgContacts.test.ts src/config/validate.test.ts src/config/envComposeParity.test.ts src/middleware/selfManagedDbContextRoutes.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts)
(cd apps/api && npx vitest run --config vitest.config.rls-coverage.ts src/__tests__/integration/rls-coverage.integration.test.ts)
(cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/callerVerification.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts src/__tests__/integration/orgMerge.integration.test.ts)
scripts/check-migration-naming.sh --against-ref origin/main
pnpm db:check-drift
pnpm test-stack down
```

Expected: all named files execute; typecheck and drift are clean; four tables classified exactly once; all physical columns export-classified; no new PARTNER_WIDE_SELECT_BRANCH_EXEMPT entry; contact/target hard-deletes succeed; merge preserves consumption; one concurrent consume wins. If the stack was stopped after Task 15, run `pnpm test-stack up` first. W01 changes Go session telemetry, so run the collector/heartbeat race suites above; W02 owns the challenge/helper protocol and its release. W01 changes no web implementation; W04 runs its UI suites. W02 must run `cd agent && go test -race ./internal/heartbeat/...`; W04 must run `cd apps/web && npx vitest run <path>` for its actual components.

- [ ] **Step 5: Commit verification, open the PR, and stop before merge.** Read parent/sub issue numbers from the wave issue into `CALLER_PARENT_ISSUE` and `CALLER_WAVE_ISSUE`; branch must match the Global Constraints. Use the following exact commands after the implementation is complete:

```bash
ls apps/api/migrations | sort | tail -1
git add apps/api/src/services/callerVerification/readiness.test.ts
git commit -m "test(caller-verification): verify backend cross-wave exports"
git diff --check
git push -u origin HEAD
python3 - <<'PY'
import os
from pathlib import Path
issue=os.environ['CALLER_WAVE_ISSUE']
Path('/tmp/caller-verification-w01-pr.md').write_text(f'''Implements caller verification backend foundations with readiness disabled: canonical bindings, destination provenance, policy floors, callback attestation, single-use grants and fence-first rejection.

Closes #{issue}

Spec: docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md

Tenancy: four forced-RLS tables; deferrable contact/org references; dual-axis SELECT-only partner baseline; cascade/export/merge registrations verified by live contracts.

Validation: shared/API typechecks, Go collector/heartbeat race suites, targeted unit/route suites, live authenticated caller-verification routes and sync/login/move tests, RLS coverage, export/erasure and real org merge suites.

Rollout: CALLER_VERIFICATION_ENABLED=false. W02 supplies workstation preparation/delivery; W03 supplies links/mailbox reads; W05 supplies interactive step-up, intent revocation and backend enforcement. Existing M365 mutations are unchanged in W01. SMTP retries remain at-least-once across an ambiguous provider result.
''')
PY
gh pr create --base main --title "feat(caller-verification): backend core" --body-file /tmp/caller-verification-w01-pr.md
gh pr checks --watch
```

Run the repository's comprehensive PR review workflow against the concrete implementation; address confirmed auth/tenancy findings, repeat only affected verification, and record results in the PR. W01 does not flip readiness, publish a site, deploy, or merge.

## Self-review

- Coverage: tables/enums/FKs/RLS/indexes (Tasks 1–3), conservative scoped backfill (2), complete lifecycle registrations and collision-first merge (3–4), stable errors/types/locks/default-off readiness (5), baseline-then-tighten operators, defaults/baseline response projections and all tiers (6), every destination writer including compatibility projection (7), trusted Graph binding versus uploaded IDs, picker/search, reachable complete-sync reconciliation, and independent authenticated login telemetry (8), validators (9), current-policy consume gate and same-intent workstation ownership recheck (10), fence/incident/revocation/audit/notifications/override (11), start/read/ticket/secret handling plus all five additive HTTP fields (12), ambient decision atomicity, capped/admin-attributed factory, device-move revocation and publication (13), readiness response, directory wiring, policy projections and authenticated routes (14), live authenticated own-site/denied-site matrix, full response contracts, directory sync, login isolation, decision/receipt rollback, device move, admin cap/audit and DB contracts (15), typecheck/contract suites/PR (16).
- Cross-wave contract: the index's table/enum names, signatures, paths, snapshots and migration slots are retained. W02 command `caller_verify`, payload `{ verificationId, username, technicianName, orgName, actionLabel, targetLabel, reverseCode, choices: [string, string, string], timeoutMs }`, result `{ delivered: boolean, choice?: string | 'not_me' | 'timeout', principal?: { sid?: string; uid?: number; username: string; upn?: string }, helperVersion?: string, error?: 'no_session_for_user' | 'session_not_console' | 'helper_outdated' }`, and IPC `caller_verify_request` / `caller_verify_response` are reserved unchanged. W02 adds `CallerVerify bool \`json:"callerVerify"\``; W03 owns public `/verify/:token`; W05 owns `/orgs/:orgId/caller-verifications/administrative`.
- Verified repository corrections: session reporting already carries snapshots/events and retries, but lacks principal telemetry; its Windows detector supplies bare usernames and WTS tokens provide SID; Graph list reports truncation; device move requires an explicit device row lock before the new hook; real JWT/membership fixtures exercise routes; root router lives in `src/index.ts`; Graph-backed contact import must be added; compatibility projection is an additional email writer; portal profile is not currently a destination writer; site helper needs export; custom merge executors live in their own file; ticket outbox writer is private; security-recipient selection needs an explicit helper; asynchronous audit helpers are not transaction-atomic.
- Security boundaries: no email-string target fallback, no CSV-created directory binding, no tier-2 unbound workstation, no same-mailbox email assurance, no cross-technician reuse by default, no consumed-grant resurrection, no destructive history FK cascade from target B into requester A, no ambient-context pseudo-elevation or decision detachment from authorized transactions, no deletion inferred from partial/failed sync, no device-move reuse, no delivery before commit. Refusal tests and live races are required evidence, not optional review notes.
- Scope: this document is the only file written during planning. Implementation code blocks and commit/PR commands are instructions for the future wave executor. No product code, migration, commit, PR, or running stack is created by writing this plan. Local dependency directories are absent in this planning checkout, so embedded product tests/typechecks are future verification commands; this planning pass checks the document and source references only.
