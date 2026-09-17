---
tracking_issue: LanternOps/breeze#__PARENT__
---
# Partner Sending Domains W02: Data Model, Config and Adapters — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Plan amendments

Deviations from the spec or the plan index, each forced by the real code. Every
one was verified by reading the file cited.

1. **`config/env.ts` is not the env declaration site.** Spec §11 says the new
   variables are "declared in `apps/api/src/config/env.ts`". That file contains
   no `EMAIL_*` name at all — it is a grab-bag of hand-written readers
   (`envFlag`, `isHosted` at `env.ts:321-323`). The real declaration site is the
   zod `envObjectSchema` in `apps/api/src/config/validate.ts` (existing email
   block at `validate.ts:804-809`). W02 declares the keys there and puts the
   typed reader in `services/emailDomains/config.ts`, modelled on
   `config/partnerTrustMode.ts` (call-time `process.env` read, `isHosted()`
   short-circuit, warn-and-fall-back on a bad value). **Nothing is added to
   `env.ts`.**
2. **The root `docker-compose.yml` must be mapped too**, not only
   `deploy/docker-compose.prod.yml` as spec §11 says.
   `apps/api/src/config/envComposeParity.test.ts` (required **Test API** job)
   asserts two pairs: `.env.example` ↔ `docker-compose.yml` and
   `deploy/.env.example` ↔ `deploy/docker-compose.prod.yml`. A var documented in
   one `.env.example` and absent from its paired compose file fails CI.
3. **A fifth registration list the spec missed.**
   `ALLOWED_WITHOUT_CAPABILITY_CHECK` in
   `apps/api/src/__tests__/partner-wide-write-coverage.test.ts:64` derives the
   partner-axis table set from the **live Drizzle schema** (`partnerAxisTableNames()`,
   `:313-330`: any table with `partnerId` and no `notNull` `orgId`) and then
   greps every file under `src/routes/**` and `src/services/**` for
   `.insert|update|delete(<table>` without `canManagePartnerWidePolicies`.
   `services/emailDomains/domainRelease.ts` mutates `partnerSendingDomains`, so
   it reds the required **Test API** job unless it is allowlisted with a reason
   of at least 20 characters. Spec §3.5 claims no list beyond
   `PARTNER_TENANT_TABLES` applies; that is wrong. Task 2 registers it.
4. **`createDomain` takes `partnerSlug`.** Spec §5's interface hands the adapter
   only `partnerRef` (the partner id), but the `static` allow-list binds entries
   by **slug** (`domain:partner-slug`, §2.1/§5.1). The input object gains
   `partnerSlug?: string | null`; `resend` and the future `ses` adapter ignore
   it. W03 resolves the slug from the `partners` row it already loads.
5. **`static`'s `getDomain(key)` keys on the domain name.**
   `provider_domain_id` is always null for `static` (§3.1), so there is no id to
   pass. The adapter's `getDomain` delegates to `findDomainByName`. It never
   returns `verified` — an accepted test send owns that transition (§5.1) — so
   W03's `syncSendingDomain` MUST treat a `pending` result from an adapter with
   `verifiesByDns === false` as "no change" and only act on `failed`. Stated
   here because W02 owns the adapter contract.
6. **The composite FK is NOT `DEFERRABLE`.** CLAUDE.md's deferrable rule is
   scoped to composite FKs on an **`org_id`** column, because the org merge runs
   `SET CONSTRAINTS ALL DEFERRED`. Verified: the only `SET CONSTRAINTS`
   statements in the repo are `services/orgMerge.ts:1060` and
   `services/quoteService.ts:1231`, both org-axis; there is no partner merge
   anywhere (`grep -rln "partnerMerge\|mergePartner" apps/api/src` → nothing).
   Precedent for a non-deferrable partner composite FK:
   `huntress_org_mappings_integration_partner_fkey`
   (`migrations/2026-06-12-a-huntress-partner-mapping.sql:59-63`) and the
   `pax8_*` twins. Plain `ON DELETE CASCADE`, no deferral.
7. **The `static` send-error classifier is text-based on the platform-transport
   path.** W01's `deliverRaw` inherits today's `sendEmail` body: the Resend
   branch throws `new Error('Resend error: ' + error.message)`
   (`services/email.ts:264-266`), discarding `error.name` and
   `error.statusCode`; the Mailgun branch throws
   `Mailgun API error (<status>): <body>` (`email.ts:804-808`); the SMTP branch
   does not catch at all (`email.ts:300`), so nodemailer's error arrives intact
   with `responseCode` / `response`. The classifier therefore keys on
   `responseCode`/`response` when present and on message text otherwise, with
   `ambiguous` as the default. Carrying a structured cause out of `deliverRaw`
   is a W04 follow-up, not a W02 change.
8. **Resend SDK 6.18.0's `DomainStatus` omits `temporary_failure`.** The
   installed union is
   `'pending' | 'verified' | 'failed' | 'not_started' | 'partially_verified' | 'partially_failed'`
   (`node_modules/resend/dist/index.d.mts:94`); `temporary_failure` exists only
   on `DomainRecordStatus` (`:93`). The API does return it at domain level
   (spec §0.2), so the mapper accepts it as a runtime string and maps it to
   `at_risk`, with `pending` + one warning for anything else.
9. **`isConsumerEmailDomain` takes an email address, not a domain**
   (`services/consumerEmailDomains.ts:79`, via `emailDomainOf` at `:66`). So
   `assertSendingDomainAllowed(domain)` calls it as
   `isConsumerEmailDomain('postmaster@' + domain)`.
10. **The outbox joins `INTENTIONAL_UNSCOPED` only, not `EXEMPT_TABLES`.**
    `EXEMPT_TABLES` (`rls-coverage.integration.test.ts:57`) only subtracts from
    offender scans that reach a table through `org_id` auto-discovery or an
    explicit shape list. `email_provider_domain_releases` has neither, so it is
    never surfaced. Precedent: `sso_sessions`, `installed_extensions`,
    `extension_schema_history` are all in `INTENTIONAL_UNSCOPED` and not in
    `EXEMPT_TABLES`.
11. **`EMAIL_DOMAINS_PROVIDER` is declared `z.string().optional()`, not a zod
    enum.** Compose maps optional vars as `${VAR:-}`, so an unset var arrives as
    `""`; a bare `z.enum` would refuse boot on every upgraded deployment. The
    value check lives in the `superRefine` instead, where `""` and unset both
    mean "off".
12. **`tldts` is not installed anywhere in the repo** (verified across
    `package.json`, `apps/*/package.json`, `packages/*/package.json` and
    `node_modules`). Task 4 adds it to `apps/api` as a new dependency.

---

**Goal:** Land every artefact the partner-sending-domain feature needs before
anything calls out: three tables with partner-axis RLS and a `BEFORE DELETE`
release guard, their Drizzle models, the allowlist registrations, the shared
validators and DTOs W05's UI is built against, the `EMAIL_DOMAINS_*`
configuration with its deployment-mode boot rules, the `EmailDomainProvider`
interface with `resend` / `static` / `fake` adapters, the
`custom_sending_domain` capability, and the provider-release path wired into
`cascadeDeletePartner` and `finalizePartnerOffboarding`. With
`EMAIL_DOMAINS_PROVIDER` unset — the default everywhere, hosted and self-hosted
— nothing in this wave changes behaviour for any tenant.

**Architecture:** One migration creates `partner_sending_domains` and
`partner_sender_identities` (RLS shape 3, partner-axis: one `FOR ALL TO
breeze_app` policy `breeze_current_scope() = 'system' OR
breeze_has_partner_access(partner_id)`, the
`2026-09-25-time-entry-source-and-suggestion-decisions.sql` template) plus
`email_provider_domain_releases`, a system-only outbox with **no `partner_id`
column** so `cascadeDeletePartner`'s `information_schema` sweep cannot erase the
provider handle it exists to keep. A `BEFORE DELETE` trigger on
`partner_sending_domains` raises when the row still owns a
`provider_domain_id`, so any delete path that forgets to release fails loudly;
`releaseSendingDomainsForPartner` is the one path that satisfies it, and it is
called first in both partner-destroying functions. The provider layer is a thin
interface with three adapters and a registry that returns `null` when
`EMAIL_DOMAINS_PROVIDER` is unset — the single switch that keeps the wave dark.
Domain normalisation splits in two: the structural, platform-independent half
(`normalizeSendingDomain`) lives in `packages/shared` so the web reuses it; the
policy half (platform domains, consumer domains, public suffixes, the operator
denylist) lives in `services/emailDomains/domainPolicy.ts` because it reads
server configuration.

**Tech Stack:** PostgreSQL + hand-written SQL migration, Drizzle ORM, Zod
(`packages/shared`), Vitest (unit + integration on real Postgres), the `resend`
npm SDK 6.18.0, `tldts` (new dependency), React (two small web edits for the
capability mirror).

**Spec:** `docs/superpowers/specs/integrations/2026-09-17-partner-sending-domains-design.md`
§2.1 (deployment modes), §3.1–§3.5 (data model, registration and lifecycle
contracts), §4.1 and §4.4 (domain and identity rules), §5, §5.1, §5.2 (provider
interface, adapters, status model), §9.1 (eligibility capability, caps), §11
(configuration), §13 (error handling), §14 (testing).
Plan index: `docs/superpowers/plans/integrations/2026-09-17-partner-sending-domains.md`
— amendment 1 (W02 split, release hooks ship here with the guard), amendment 3
(`PartnerLaneSendFailure` class), and the "Defined in W02" name list, which is
binding.

## Global Constraints

- **Migration name `apps/api/migrations/2026-10-20-100000-partner-sending-domains.sql`.**
  Before committing, run `ls apps/api/migrations/*.sql | sort | tail -1`. If the
  newest committed migration sorts at or after `2026-10-20-100000`, rename this
  file upward so it sorts last, and update every reference to it in this plan's
  test steps. Newest on `origin/main` when this plan was written:
  `2026-10-17-140000-snmp-metrics-instance-width.sql`.
- **The migration is idempotent and has no inner `BEGIN`/`COMMIT`.**
  `CREATE TABLE IF NOT EXISTS`, `CREATE [UNIQUE] INDEX IF NOT EXISTS`,
  `DROP POLICY IF EXISTS` / `pg_policies` existence guards,
  `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER`, `DO $$` guards for the
  composite FK. `autoMigrate` wraps each file in one transaction.
- **It is DDL only — no `set_config('breeze.scope', 'system', true)` is needed
  or permitted.** `apps/api/src/db/migrationRlsScope.test.ts` requires the
  elevation only for files that `INSERT`/`UPDATE`/`DELETE`/`MERGE`. This
  migration writes no rows. **Never add this file to that test's frozen
  baseline.**
- **RLS lives in the creating migration.** Enable + force + policies for all
  three tables, plus `GRANT SELECT, INSERT, UPDATE, DELETE ... TO breeze_app` —
  `cascadeDeletePartner` issues hard `DELETE`s as `breeze_app` under a system
  RLS context, so the DELETE grant is load-bearing.
- **`email_provider_domain_releases` MUST NOT have a `partner_id` column.**
  `cascadeDeletePartner` deletes from every `public` table that has one
  (`services/tenantCascade.ts:1762-1769`), which would erase the provider handle
  this table exists to keep.
- **Never delete a provider domain with `provider_managed = false`, and never
  write an outbox row for one.** A row adopted from the operator's own provider
  account is their primary sending domain; deleting it is unrecoverable.
- **Partner FKs carry no `ON DELETE CASCADE`** (spec §3.1). The partner sweep
  deletes these rows explicitly, and a database-level cascade would bypass the
  release guard.
- **No new env var is ever required by an upgrade.** Every `EMAIL_DOMAINS_*`
  key is optional. Any `requireIf` is keyed on `EMAIL_DOMAINS_PROVIDER` only,
  **never** on `EMAIL_PROVIDER` — `requireIf(EMAIL_PROVIDER === 'resend', …)`
  would refuse boot on every Resend self-host that upgrades.
- **Rigor is high** (tenancy, partner cascade, credentials). Red first on every
  task: write the failing assertion, run it, watch it fail, then implement.
  Before the PR, bring up a stack (`pnpm test-stack up`), run the RLS and
  integration contract suites, and tear it down (`pnpm test-stack down`) —
  nothing reaps it for you.
- **Test command form:** `cd apps/api && npx vitest run <path>` (never
  `pnpm --filter <pkg> test -- --run <path>`: pnpm forwards the literal `--`,
  vitest swallows `--run`, and the whole suite runs in watch mode).
  `packages/shared` and `apps/web` use the same `cd <dir> && npx vitest run
  <path>` form.
- **Branch `feature/__PARENT__-partner-sending-domains/wave-__W02__`; PR body
  contains `Closes #__W02__`.** `get_feature_status` before starting.
- **Commit after every task** with the trailer
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File Structure

| Path | Responsibility | Task |
|---|---|---|
| `apps/api/migrations/2026-10-20-100000-partner-sending-domains.sql` | three tables, constraints, indexes, RLS, release-guard trigger | 1 |
| `apps/api/src/db/schema/emailSendingDomains.ts` | Drizzle `partnerSendingDomains`, `partnerSenderIdentities`, `emailProviderDomainReleases` | 1 |
| `apps/api/src/db/schema/index.ts` | export the new schema module | 1 |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` | `PARTNER_TENANT_TABLES` ×2, `INTENTIONAL_UNSCOPED` ×1 | 2 |
| `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` | `ALLOWED_WITHOUT_CAPABILITY_CHECK` entry for `domainRelease.ts` | 2 |
| `packages/shared/src/validators/sendingDomains.ts` (+ `.test.ts`) | `normalizeSendingDomain`, constants, Zod schemas | 3 |
| `packages/shared/src/types/sendingDomains.ts` | `SendingDomainDto`, `SenderIdentityDto`, `SendingDomainsCapabilityDto`, `SendingDomainsListResponse`, `SendingDomainDnsRecordDto` | 3 |
| `packages/shared/src/validators/index.ts`, `packages/shared/src/types/index.ts` | re-exports | 3 |
| `apps/api/src/services/emailDomains/domainPolicy.ts` (+ `.test.ts`) | `assertSendingDomainAllowed` | 4 |
| `apps/api/package.json` | `tldts` dependency | 4 |
| `apps/api/src/config/validate.ts` | zod keys + deployment-mode `superRefine` block | 5 |
| `apps/api/src/config/validate.test.ts` | deployment-mode matrix (spec §14) | 5 |
| `apps/api/src/config/envComposeParity.test.ts` | `EMAIL_DOMAINS_*` plumbing pin | 5 |
| `apps/api/src/services/emailDomains/config.ts` (+ `.test.ts`) | `getEmailDomainsConfig`, `isPartnerLaneConfigured` | 5 |
| `.env.example`, `deploy/.env.example`, `docker-compose.yml`, `deploy/docker-compose.prod.yml` | documentation + compose mapping | 5 |
| `apps/api/src/services/emailDomains/provider.ts` | spec §5 types, `PartnerLaneMessage`, `PartnerLaneSendFailure` | 6 |
| `apps/api/src/services/emailDomains/providerRegistry.ts` (+ `.test.ts`) | `getEmailDomainProvider`, `resetEmailDomainProviderForTests` | 6 |
| `apps/api/src/services/emailDomains/adapters/resend.ts` (+ `.test.ts`, `resendSendErrorFixtures.ts`) | Resend adapter, status map, record map, send-error classifier | 7 |
| `apps/api/src/services/emailDomains/adapters/static.ts` (+ `.test.ts`) | operator-attested adapter over `deliverRaw` | 8 |
| `apps/api/src/services/emailDomains/adapters/fake.ts` | deterministic adapter for unit/integration/E2E/wt-stack | 8 |
| `apps/api/src/services/emailDomains/adapters/adapterContract.test.ts` | one suite over `fake`, `static`, mocked `resend` | 9 |
| `apps/api/src/services/partnerTrust.ts`, `partnerTrust.test.ts` | `custom_sending_domain` capability | 10 |
| `apps/web/src/lib/trustProbation.ts`, `apps/web/src/components/trust/TrustProbationBanner.tsx` | capability mirrors | 10 |
| `apps/api/src/services/emailDomains/domainRelease.ts` (+ `.test.ts`) | `releaseSendingDomainsForPartner` | 11 |
| `apps/api/src/services/tenantCascade.ts`, `apps/api/src/services/tenantOffboarding.ts` | release hooks | 11 |
| `apps/api/src/__tests__/integration/partnerSendingDomainsRls.integration.test.ts` | live-Postgres contract suite | 12 |

---

## Task 1: Migration and Drizzle schema

**Files:**
- Create: `apps/api/migrations/2026-10-20-100000-partner-sending-domains.sql`
- Create: `apps/api/src/db/schema/emailSendingDomains.ts`
- Modify: `apps/api/src/db/schema/index.ts` (append one `export * from` line after `export * from './toolSources';`, currently the last line, `:167`)

**Interfaces:**
- Produces: tables `partner_sending_domains`, `partner_sender_identities`,
  `email_provider_domain_releases`; function
  `public.breeze_sending_domain_release_guard()`; trigger
  `partner_sending_domains_release_guard`; Drizzle exports
  `partnerSendingDomains`, `partnerSenderIdentities`,
  `emailProviderDomainReleases` plus their `$inferSelect` type aliases.
- Consumes: `partners` (`db/schema/orgs.ts`), `users` (`db/schema/users.ts`),
  `public.breeze_current_scope()`, `public.breeze_has_partner_access(uuid)`.

- [ ] **Step 1: Confirm the migration slot**

Run: `ls apps/api/migrations/*.sql | sort | tail -1`
Expected: a name sorting **before** `2026-10-20-100000-partner-sending-domains.sql`. If not, rename upward (e.g. `2026-10-21-100000-…`) and use the new name everywhere below.

- [ ] **Step 2: Write the migration**

`apps/api/migrations/2026-10-20-100000-partner-sending-domains.sql`:

```sql
-- Partner sending domains (spec 2026-09-17-partner-sending-domains-design §3).
-- W02 of the partner-sending-domains feature. Lands DARK: with
-- EMAIL_DOMAINS_PROVIDER unset nothing reads or writes these tables.
--
-- TENANCY:
--   partner_sending_domains, partner_sender_identities — RLS shape 3
--     (partner-axis). One FOR ALL TO breeze_app policy,
--     breeze_current_scope() = 'system' OR breeze_has_partner_access(partner_id),
--     on both USING and WITH CHECK. Template:
--     2026-09-25-time-entry-source-and-suggestion-decisions.sql.
--     Deliberately NO org_id and NO device_id, so they are registered in
--     PARTNER_TENANT_TABLES only — no CORE_ORG_CASCADE_DELETE_ORDER, no device
--     lists, no CORE_TENANT_EXPORT_POLICY, no org-merge registry.
--     cascadeDeletePartner discovers both by their partner_id column.
--   email_provider_domain_releases — INTENTIONAL_UNSCOPED. Forced RLS with a
--     single system-only policy. It MUST NOT have a partner_id column:
--     cascadeDeletePartner deletes from every public table that has one
--     (services/tenantCascade.ts:1762-1769), which would erase the provider
--     handle this outbox exists to keep across the partner's deletion.
--
-- The partner FKs deliberately carry NO ON DELETE CASCADE (§3.1): the partner
-- sweep deletes these rows explicitly, and a database cascade would bypass the
-- release guard below.
--
-- The composite FK is NOT DEFERRABLE. CLAUDE.md's deferrable rule covers
-- composite FKs on an org_id column, because the ORG merge runs
-- SET CONSTRAINTS ALL DEFERRED (services/orgMerge.ts:1060). There is no partner
-- merge in this repo. Precedent for a non-deferrable partner composite:
-- huntress_org_mappings_integration_partner_fkey (2026-06-12-a).
--
-- DDL only: no rows written, so no breeze.scope election
-- (apps/api/src/db/migrationRlsScope.test.ts). Idempotent; no inner
-- BEGIN/COMMIT (autoMigrate wraps the file).

-- 1) partner_sending_domains -------------------------------------------------
CREATE TABLE IF NOT EXISTS partner_sending_domains (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id             uuid NOT NULL REFERENCES partners(id),
  -- Lowercase ASCII A-label, already normalised by normalizeSendingDomain.
  domain                 varchar(253) NOT NULL,
  provider               varchar(20) NOT NULL,
  -- NULL while provisioning and after release. ALWAYS null for `static`.
  provider_domain_id     text,
  -- false when the provider domain pre-existed Breeze asking for it (§5.1).
  -- A false row is NEVER deleted at the provider and never written to the outbox.
  provider_managed       boolean NOT NULL DEFAULT true,
  -- Committed BEFORE the provider create call, so a retry can tell "ours from a
  -- crashed attempt" (provider createdAt newer) from "pre-existing" (older).
  provision_attempted_at timestamptz,
  provider_region        varchar(32),
  status                 varchar(20) NOT NULL DEFAULT 'provisioning',
  status_reason          varchar(64),
  -- Public DNS data only, never secrets. jsonb => excludedOpen if this table
  -- ever gains an org_id (it must not).
  dns_records            jsonb NOT NULL DEFAULT '[]'::jsonb,
  check_requested_at     timestamptz,
  last_checked_at        timestamptz,
  next_check_at          timestamptz,
  check_attempts         integer NOT NULL DEFAULT 0,
  -- First verification. Sticky: never cleared once set.
  verified_at            timestamptz,
  status_changed_at      timestamptz NOT NULL DEFAULT now(),
  last_test_at           timestamptz,
  last_test_status       varchar(16),
  last_test_error        text,
  -- Most recent domain_unusable refusal. Written by the WORKER from the
  -- sync-domain payload, never by the send path (which may be in a context that
  -- cannot write this table).
  last_send_error        text,
  last_send_error_at     timestamptz,
  created_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_sending_domains_status_chk
    CHECK (status IN ('provisioning','pending','verified','at_risk','failed','suspended','removing')),
  CONSTRAINT partner_sending_domains_provider_chk
    CHECK (provider IN ('resend','ses','static','fake')),
  CONSTRAINT partner_sending_domains_status_reason_chk
    CHECK (status_reason IS NULL OR status_reason IN (
      'provider_conflict','provider_rejected','quota_exhausted','dns_not_detected',
      'dns_removed','platform_suspended','abuse_auto','failed_expired','user_removed')),
  CONSTRAINT partner_sending_domains_test_status_chk
    CHECK (last_test_status IS NULL OR last_test_status IN ('pending','sent','failed')),
  -- `static` has no provider object at all (§3.1).
  CONSTRAINT partner_sending_domains_static_no_provider_id_chk
    CHECK (provider <> 'static' OR provider_domain_id IS NULL),
  CONSTRAINT partner_sending_domains_domain_lower_chk
    CHECK (domain = lower(domain) AND domain NOT LIKE '%.'),
  CONSTRAINT partner_sending_domains_dns_records_array_chk
    CHECK (jsonb_typeof(dns_records) = 'array')
);

-- One row owns a name, pending or verified, across every partner. Mirrors
-- partner_inbound_domains_domain_uq. Squatting is bounded by expiry (§4.3).
CREATE UNIQUE INDEX IF NOT EXISTS partner_sending_domains_domain_uq
  ON partner_sending_domains (domain);
-- Referenced by the identities composite FK below.
CREATE UNIQUE INDEX IF NOT EXISTS partner_sending_domains_id_partner_uq
  ON partner_sending_domains (id, partner_id);
CREATE INDEX IF NOT EXISTS partner_sending_domains_partner_idx
  ON partner_sending_domains (partner_id);
CREATE INDEX IF NOT EXISTS partner_sending_domains_next_check_idx
  ON partner_sending_domains (next_check_at) WHERE next_check_at IS NOT NULL;

ALTER TABLE partner_sending_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_sending_domains FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'partner_sending_domains'
      AND policyname = 'partner_sending_domains_partner_access'
  ) THEN
    CREATE POLICY partner_sending_domains_partner_access ON partner_sending_domains
      FOR ALL TO breeze_app
      USING      (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
END $$;
-- DELETE is load-bearing: cascadeDeletePartner's partner_id sweep issues hard
-- DELETEs as breeze_app under a system RLS context (no role switch).
GRANT SELECT, INSERT, UPDATE, DELETE ON partner_sending_domains TO breeze_app;

-- 2) Provider release guard (§3.5) -------------------------------------------
-- A row may only be deleted after the service has confirmed provider deletion
-- or written the outbox row, and nulled provider_domain_id in the SAME
-- transaction. A delete path that forgets fails loudly instead of leaking a
-- provider domain. No breeze.* elevation and no SECURITY DEFINER: the function
-- reads only OLD and raises.
CREATE OR REPLACE FUNCTION public.breeze_sending_domain_release_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.provider_domain_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'partner_sending_domains row still owns a provider domain',
      DETAIL  = format('domain=%s provider=%s provider_domain_id=%s',
                       OLD.domain, OLD.provider, OLD.provider_domain_id),
      HINT    = 'Release first: releaseSendingDomainsForPartner() (or the removal path) writes an email_provider_domain_releases row for a provider_managed domain and NULLs provider_domain_id in the same transaction.';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS partner_sending_domains_release_guard ON partner_sending_domains;
CREATE TRIGGER partner_sending_domains_release_guard
  BEFORE DELETE ON partner_sending_domains
  FOR EACH ROW EXECUTE FUNCTION public.breeze_sending_domain_release_guard();

-- 3) partner_sender_identities -----------------------------------------------
-- One row per (partner, stream). A stream with no row sends from the platform
-- sender; there is no implicit fallback between streams.
CREATE TABLE IF NOT EXISTS partner_sender_identities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id        uuid NOT NULL REFERENCES partners(id),
  sending_domain_id uuid NOT NULL,
  stream            varchar(20) NOT NULL,
  local_part        varchar(64) NOT NULL,
  -- NULL => the partner's name is used.
  display_name      varchar(78),
  reply_to          varchar(320),
  updated_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_sender_identities_stream_chk
    CHECK (stream IN ('support','billing','general')),
  -- Mirrors senderLocalPartSchema in packages/shared (§4.4). The reserved-name
  -- refusal (postmaster/abuse/mailer-daemon) stays app-layer: it is product
  -- policy, not an integrity invariant.
  CONSTRAINT partner_sender_identities_local_part_chk
    CHECK (local_part ~ '^[a-z0-9]([a-z0-9._+-]{0,62}[a-z0-9])?$' AND local_part NOT LIKE '%..%'),
  CONSTRAINT partner_sender_identities_display_name_chk
    CHECK (display_name IS NULL OR (display_name !~ '[\r\n"<>\\]' AND display_name NOT LIKE '%@%' AND display_name NOT LIKE '%://%'))
);

DO $$ BEGIN
  -- Tenant-consistent FK: an identity can only point at a domain owned by the
  -- SAME partner. ON DELETE CASCADE so removing a domain removes its identities
  -- (the domain delete itself is gated by the release guard above).
  -- NOT DEFERRABLE — see the header note.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partner_sender_identities_domain_partner_fk') THEN
    ALTER TABLE partner_sender_identities
      ADD CONSTRAINT partner_sender_identities_domain_partner_fk
      FOREIGN KEY (sending_domain_id, partner_id)
      REFERENCES partner_sending_domains (id, partner_id)
      ON DELETE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS partner_sender_identities_partner_stream_uq
  ON partner_sender_identities (partner_id, stream);
CREATE INDEX IF NOT EXISTS partner_sender_identities_domain_idx
  ON partner_sender_identities (sending_domain_id);

ALTER TABLE partner_sender_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_sender_identities FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'partner_sender_identities'
      AND policyname = 'partner_sender_identities_partner_access'
  ) THEN
    CREATE POLICY partner_sender_identities_partner_access ON partner_sender_identities
      FOR ALL TO breeze_app
      USING      (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
      WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON partner_sender_identities TO breeze_app;

-- 4) email_provider_domain_releases (system outbox, §3.3) --------------------
-- "Delete this provider domain" work that must survive the partner's rows being
-- deleted. NO partner_id column, on purpose — see the header.
CREATE TABLE IF NOT EXISTS email_provider_domain_releases (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider           varchar(20) NOT NULL,
  provider_domain_id text NOT NULL,
  provider_region    varchar(32),
  domain             varchar(253) NOT NULL,
  reason             varchar(32) NOT NULL,
  requested_at       timestamptz NOT NULL DEFAULT now(),
  attempts           integer NOT NULL DEFAULT 0,
  next_attempt_at    timestamptz NOT NULL DEFAULT now(),
  last_error         text,
  CONSTRAINT email_provider_domain_releases_provider_chk
    CHECK (provider IN ('resend','ses','static','fake')),
  CONSTRAINT email_provider_domain_releases_reason_chk
    CHECK (reason IN ('user_removed','failed_expired','partner_released','force_release'))
);

CREATE UNIQUE INDEX IF NOT EXISTS email_provider_domain_releases_provider_domain_uq
  ON email_provider_domain_releases (provider, provider_domain_id);
CREATE INDEX IF NOT EXISTS email_provider_domain_releases_due_idx
  ON email_provider_domain_releases (next_attempt_at);

ALTER TABLE email_provider_domain_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_provider_domain_releases FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'email_provider_domain_releases'
      AND policyname = 'email_provider_domain_releases_system_only'
  ) THEN
    -- Same shape as abuse_script_hosts_system_only (2026-07-25) and
    -- installed_extensions: only a context that set breeze.scope = 'system' can
    -- see or write these rows.
    CREATE POLICY email_provider_domain_releases_system_only
      ON email_provider_domain_releases
      FOR ALL TO breeze_app
      USING      (current_setting('breeze.scope', true) = 'system')
      WITH CHECK (current_setting('breeze.scope', true) = 'system');
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON email_provider_domain_releases TO breeze_app;
```

- [ ] **Step 3: Write the Drizzle schema**

`apps/api/src/db/schema/emailSendingDomains.ts`:

```ts
import { pgTable, uuid, text, varchar, boolean, integer, timestamp, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { partners } from './orgs';
import { users } from './users';

/**
 * Partner sending domains (spec 2026-09-17-partner-sending-domains-design §3.1).
 * Tenancy: RLS shape 3 (partner-axis), no org_id and no device_id — registered
 * in PARTNER_TENANT_TABLES only. A BEFORE DELETE trigger raises when
 * provider_domain_id is still set; services/emailDomains/domainRelease.ts is
 * the path that satisfies it.
 */
export const partnerSendingDomains = pgTable('partner_sending_domains', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  domain: varchar('domain', { length: 253 }).notNull(),
  provider: varchar('provider', { length: 20 }).$type<'resend' | 'ses' | 'static' | 'fake'>().notNull(),
  providerDomainId: text('provider_domain_id'),
  providerManaged: boolean('provider_managed').notNull().default(true),
  provisionAttemptedAt: timestamp('provision_attempted_at', { withTimezone: true }),
  providerRegion: varchar('provider_region', { length: 32 }),
  status: varchar('status', { length: 20 })
    .$type<'provisioning' | 'pending' | 'verified' | 'at_risk' | 'failed' | 'suspended' | 'removing'>()
    .notNull()
    .default('provisioning'),
  statusReason: varchar('status_reason', { length: 64 }),
  dnsRecords: jsonb('dns_records').notNull().default([]),
  checkRequestedAt: timestamp('check_requested_at', { withTimezone: true }),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  nextCheckAt: timestamp('next_check_at', { withTimezone: true }),
  checkAttempts: integer('check_attempts').notNull().default(0),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),
  lastTestAt: timestamp('last_test_at', { withTimezone: true }),
  lastTestStatus: varchar('last_test_status', { length: 16 }).$type<'pending' | 'sent' | 'failed'>(),
  lastTestError: text('last_test_error'),
  lastSendError: text('last_send_error'),
  lastSendErrorAt: timestamp('last_send_error_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  uniqueIndex('partner_sending_domains_domain_uq').on(t.domain),
  uniqueIndex('partner_sending_domains_id_partner_uq').on(t.id, t.partnerId),
  index('partner_sending_domains_partner_idx').on(t.partnerId)
]);

/**
 * One sender identity per (partner, stream). The composite FK
 * (sending_domain_id, partner_id) -> partner_sending_domains(id, partner_id)
 * ON DELETE CASCADE is SQL-only (Drizzle's references() is single-column); see
 * the 2026-10-20-100000 migration. Deliberately NOT deferrable — there is no
 * partner merge.
 */
export const partnerSenderIdentities = pgTable('partner_sender_identities', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  sendingDomainId: uuid('sending_domain_id').notNull(),
  stream: varchar('stream', { length: 20 }).$type<'support' | 'billing' | 'general'>().notNull(),
  localPart: varchar('local_part', { length: 64 }).notNull(),
  displayName: varchar('display_name', { length: 78 }),
  replyTo: varchar('reply_to', { length: 320 }),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  uniqueIndex('partner_sender_identities_partner_stream_uq').on(t.partnerId, t.stream),
  index('partner_sender_identities_domain_idx').on(t.sendingDomainId)
]);

/**
 * System outbox for provider-side domain releases (spec §3.3). INTENTIONALLY
 * has NO partner_id column: cascadeDeletePartner deletes from every public
 * table that has one, which would erase the provider handle this table exists
 * to keep. Registered in INTENTIONAL_UNSCOPED, forced RLS, system-only policy.
 */
export const emailProviderDomainReleases = pgTable('email_provider_domain_releases', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: varchar('provider', { length: 20 }).$type<'resend' | 'ses' | 'static' | 'fake'>().notNull(),
  providerDomainId: text('provider_domain_id').notNull(),
  providerRegion: varchar('provider_region', { length: 32 }),
  domain: varchar('domain', { length: 253 }).notNull(),
  reason: varchar('reason', { length: 32 })
    .$type<'user_removed' | 'failed_expired' | 'partner_released' | 'force_release'>()
    .notNull(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  lastError: text('last_error')
}, (t) => [
  uniqueIndex('email_provider_domain_releases_provider_domain_uq').on(t.provider, t.providerDomainId),
  index('email_provider_domain_releases_due_idx').on(t.nextAttemptAt)
]);

export type PartnerSendingDomain = typeof partnerSendingDomains.$inferSelect;
export type PartnerSenderIdentity = typeof partnerSenderIdentities.$inferSelect;
export type EmailProviderDomainRelease = typeof emailProviderDomainReleases.$inferSelect;
```

Append to `apps/api/src/db/schema/index.ts` (after the final `export * from './toolSources';`):

```ts
export * from './emailSendingDomains';
```

- [ ] **Step 4: Run the migration guards**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/api/migrations/2026-10-20-100000-partner-sending-domains.sql
scripts/check-migration-naming.sh --staged
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
```
Expected: naming guard PASS; both suites PASS. `migrationRlsScope.test.ts` must pass **without** adding this file to its baseline — the migration writes no rows.

- [ ] **Step 5: Apply against a live database and check drift**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
pnpm test-stack up
pnpm db:migrate
pnpm db:check-drift
```
Expected: the migration applies; `db:check-drift` reports no drift. Leave the stack up for Task 12; it is torn down in Task 13.

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-10-20-100000-partner-sending-domains.sql apps/api/src/db/schema/emailSendingDomains.ts apps/api/src/db/schema/index.ts
git commit -m "feat(db): partner sending domains, sender identities and the provider release outbox

Three tables for the partner sending-domain feature (spec §3). Both partner-axis
tables are RLS shape 3; the outbox is system-only and deliberately carries no
partner_id so cascadeDeletePartner cannot erase the provider handle. A BEFORE
DELETE guard on partner_sending_domains raises while the row still owns a
provider domain.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 2: Registrations

Four registration facts, each verified against the real code:

| List | Verdict |
|---|---|
| `PARTNER_TENANT_TABLES` (`rls-coverage.integration.test.ts:186`) | **both partner tables** — mandatory. `it('every public base table is classified by exactly one tenancy bucket')` (`:1346`) reds on an unclassified table; `it('every partner-tenant public table has RLS on and all four DML commands covered by breeze_has_partner_access')` (`:1667`) then checks the policies. |
| `INTENTIONAL_UNSCOPED` (`:87`) | **the outbox** — mandatory, same classification test. Not `EXEMPT_TABLES`: that set only subtracts from offender scans reached via `org_id` auto-discovery (`:1552` pins `col.column_name = 'org_id'`) or an explicit shape list, and the outbox is in neither. Precedent: `sso_sessions`, `installed_extensions`, `extension_schema_history`. |
| `ALLOWED_WITHOUT_CAPABILITY_CHECK` (`partner-wide-write-coverage.test.ts:64`) | **`services/emailDomains/domainRelease.ts`** — mandatory (plan amendment 3). The partner-axis set is derived from the live Drizzle schema, so `partnerSendingDomains` joins it automatically the moment Task 1 lands. |
| `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_DEVICE_CASCADE_DELETE_TABLES`, `CORE_DEVICE_ORG_DENORMALIZED_TABLES`, `TICKET_ORG_DENORMALIZED_TABLES`, `CUSTOM_ORG_REWRITE_TABLES`, `AUDIT_ADMIN_REQUIRED_TABLES`, `CORE_TENANT_EXPORT_POLICY`, `orgMergeRegistry` | **none apply.** All three tables have no `org_id`, no `device_id` and no `ticket_id`. `tenantCascade.integration.test.ts:55` only demands membership for tables with an `org_id` column (`:66` pins `c.column_name = 'org_id'`), and `tenant-export-policy.integration.test.ts`'s `readLiveColumns()` (`:11-23`) selects only the tables already in `getOrgCascadeDeleteOrder()`. `cascadeDeletePartner` needs **no** registration: it discovers partner tables from `information_schema` at `services/tenantCascade.ts:1762-1769` and orders them with `topologicalCascadeOrder` (`:1125`), which puts `partner_sender_identities` before `partner_sending_domains` from the real FK edge. |

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`INTENTIONAL_UNSCOPED` — insert before the closing `]);` at `:118`; `PARTNER_TENANT_TABLES` — insert before the closing `]);` at `:319`)
- Modify: `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` (`ALLOWED_WITHOUT_CAPABILITY_CHECK`, insert before the closing `};` that follows the `services/orgArchive.ts` entry)

**Interfaces:**
- Consumes: the three table names created in Task 1.
- Produces: nothing importable. These are contract-test registrations.

- [ ] **Step 1: Watch the classification contract fail**

Run (needs the stack from Task 1 Step 5):
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run --config vitest.config.rls-coverage.ts
```
Expected: FAIL on `every public base table is classified by exactly one tenancy bucket`, naming `partner_sending_domains`, `partner_sender_identities` and `email_provider_domain_releases` as unclassified.

Then:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run src/__tests__/partner-wide-write-coverage.test.ts
```
Expected: PASS for now — `domainRelease.ts` does not exist until Task 11. Re-run it at the end of Task 11; the entry added below is what keeps it green then. (Adding the allowlist entry now would red `it('the allowlist has no stale entries')`, so **this entry is added in Task 11, not here.** Only the two `rls-coverage` edits happen in this task.)

- [ ] **Step 2: Register the two partner-axis tables**

In `rls-coverage.integration.test.ts`, immediately **before** the `]);` that closes `PARTNER_TENANT_TABLES` (`:319`), after the `['org_merge_events', 'partner_id'],` entry:

```ts
  // partner_sending_domains / partner_sender_identities (spec 2026-09-17,
  // partner sending domains W02): the MSP's custom outbound From domain and
  // one sender identity per (partner, mail stream). Partner-axis (Shape 3),
  // deliberately no org_id — the From domain is the MSP's identity, and a
  // per-org sending domain is the internal-phishing shape (spec §3.1). No
  // org_id means no cascade / export-policy / org-merge registration;
  // cascadeDeletePartner's dynamic partner_id sweep erases both, and its
  // topological order puts identities before domains via the composite FK.
  // GRANT includes DELETE for that sweep. The sibling outbox
  // email_provider_domain_releases is INTENTIONAL_UNSCOPED above — it must
  // never gain a partner_id column.
  // Functional cross-partner forge proof: partnerSendingDomainsRls.integration.test.ts.
  ['partner_sending_domains', 'partner_id'],
  ['partner_sender_identities', 'partner_id'],
```

- [ ] **Step 3: Register the outbox**

In the same file, immediately **before** the `]);` that closes `INTENTIONAL_UNSCOPED` (`:118`), after the `'extension_schema_history', …` entry:

```ts
  'email_provider_domain_releases', // Provider-side "delete this domain" outbox (spec 2026-09-17 partner sending domains §3.3). Deliberately carries NO partner_id: cascadeDeletePartner deletes from every table that has one, which would erase the provider handle this table exists to keep across the partner's deletion. No tenant axis. Forced RLS, single system-only policy → only system context. Not in EXEMPT_TABLES: with no org_id and no shape-list entry, no offender scan reaches it.
```

- [ ] **Step 4: Run the contract suite green**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run --config vitest.config.rls-coverage.ts
```
Expected: PASS, including the partner-tenant policy test at `:1667` (the migration's `FOR ALL` policy references `breeze_has_partner_access` and therefore covers all four DML commands) and the FORCE-RLS test at `:1285`.

- [ ] **Step 5: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "test(api): register partner sending-domain tables in the RLS coverage contract

partner_sending_domains and partner_sender_identities join PARTNER_TENANT_TABLES
(shape 3); email_provider_domain_releases joins INTENTIONAL_UNSCOPED. No org
cascade, device, ticket-move, export-policy or org-merge registration applies —
none of the three has an org_id, device_id or ticket_id column.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 3: Shared validators and DTO types

**Files:**
- Create: `packages/shared/src/validators/sendingDomains.ts`
- Create: `packages/shared/src/validators/sendingDomains.test.ts`
- Create: `packages/shared/src/types/sendingDomains.ts`
- Modify: `packages/shared/src/validators/index.ts` (add `export * from './sendingDomains';` beside the other leaf re-exports at `:23-30`)
- Modify: `packages/shared/src/types/index.ts` (add `export * from './sendingDomains';` after `export * from './deviceFunction';` at `:817`)

**Interfaces:**
- Produces (the plan index's "Defined in W02" list, verbatim names):
  ```ts
  export const SENDING_DOMAIN_STATUSES: readonly ['provisioning','pending','verified','at_risk','failed','suspended','removing'];
  export const SENDING_DOMAIN_STATUS_REASONS: readonly ['provider_conflict','provider_rejected','quota_exhausted','dns_not_detected','dns_removed','platform_suspended','abuse_auto','failed_expired','user_removed'];
  export const PARTNER_MAIL_STREAMS: readonly ['support','billing','general'];
  export type SendingDomainStatusValue = (typeof SENDING_DOMAIN_STATUSES)[number];
  export type SendingDomainStatusReason = (typeof SENDING_DOMAIN_STATUS_REASONS)[number];
  export type PartnerMailStreamValue = (typeof PARTNER_MAIL_STREAMS)[number];
  export type SendingDomainRejection =
    | 'empty' | 'scheme' | 'path' | 'port' | 'at_sign' | 'wildcard' | 'ip_literal'
    | 'too_few_labels' | 'label_length' | 'label_charset' | 'too_long' | 'numeric_tld' | 'idn_invalid';
  export type NormalizeSendingDomainResult =
    | { ok: true; domain: string }
    | { ok: false; reason: SendingDomainRejection };
  export function normalizeSendingDomain(input: string): NormalizeSendingDomainResult;
  export const RESERVED_SENDER_LOCAL_PARTS: readonly ['postmaster','abuse','mailer-daemon'];
  export const senderLocalPartSchema: z.ZodType<string, z.ZodTypeDef, string>;
  export const senderDisplayNameSchema: z.ZodType<string, z.ZodTypeDef, string>;
  export const createSendingDomainSchema: z.ZodType<{ domain: string }, z.ZodTypeDef, { domain: string }>;
  export const upsertSenderIdentitySchema: z.ZodType<{ sendingDomainId: string; localPart: string; displayName?: string | null; replyTo?: string | null }, …>;
  ```
  and the DTOs `SendingDomainDnsRecordDto`, `SendingDomainDto`, `SenderIdentityDto`, `SendingDomainsCapabilityDto`, `SendingDomainsListResponse`.
  Fields W05 depends on and that must stay **required** (not optional, not
  nullable): `SendingDomainDto.statusChangedAt` (the 72 h retry window on a
  `failed` row), `SenderIdentityDto.domain` and `SenderIdentityDto.fromAddress`
  (the identity card renders the exact From without re-joining). All three are
  declared required below and pinned by the DTO-shape test in Step 1.
- Consumes: `zod`, the WHATWG `URL` global (identical in Node 22 and every shipped browser).

- [ ] **Step 1: Write the failing table-driven tests**

`packages/shared/src/validators/sendingDomains.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  normalizeSendingDomain,
  senderLocalPartSchema,
  senderDisplayNameSchema,
  createSendingDomainSchema,
  upsertSenderIdentitySchema,
  PARTNER_MAIL_STREAMS,
  SENDING_DOMAIN_STATUSES,
  SENDING_DOMAIN_STATUS_REASONS,
  RESERVED_SENDER_LOCAL_PARTS,
  type SendingDomainRejection
} from './sendingDomains';

describe('normalizeSendingDomain — accepted', () => {
  const cases: Array<[string, string]> = [
    ['acme.com', 'acme.com'],
    ['  ACME.com  ', 'acme.com'],
    ['Mail.Acme.Com', 'mail.acme.com'],
    ['acme.com.', 'acme.com'],
    ['acme.com...', 'acme.com'],
    ['a.co', 'a.co'],
    ['deep.sub.domain.acme.co.uk', 'deep.sub.domain.acme.co.uk'],
    ['xn--exmple-cua.com', 'xn--exmple-cua.com'],
    ['exämple.com', 'xn--exmple-cua.com'],
    ['ACME-mail.com', 'acme-mail.com'],
    ['a1.b2.example', 'a1.b2.example'],
    [`${'a'.repeat(63)}.com`, `${'a'.repeat(63)}.com`]
  ];
  it.each(cases)('normalizes %s -> %s', (input, expected) => {
    expect(normalizeSendingDomain(input)).toEqual({ ok: true, domain: expected });
  });
});

describe('normalizeSendingDomain — rejected', () => {
  const cases: Array<[string, SendingDomainRejection]> = [
    ['', 'empty'],
    ['   ', 'empty'],
    ['.', 'empty'],
    ['https://acme.com', 'scheme'],
    ['http://acme.com', 'scheme'],
    ['//acme.com', 'scheme'],
    ['acme.com/mail', 'path'],
    ['acme.com?x=1', 'path'],
    ['acme.com#frag', 'path'],
    ['acme.com:587', 'port'],
    ['user@acme.com', 'at_sign'],
    ['*.acme.com', 'wildcard'],
    ['192.0.2.10', 'ip_literal'],
    ['255.255.255.255', 'ip_literal'],
    ['[2001:db8::1]', 'port'],
    ['localhost', 'too_few_labels'],
    ['acme', 'too_few_labels'],
    ['acme..com', 'label_length'],
    ['.acme.com', 'label_length'],
    [`${'a'.repeat(64)}.com`, 'label_length'],
    ['-acme.com', 'label_charset'],
    ['acme-.com', 'label_charset'],
    ['ac me.com', 'label_charset'],
    ['acme_mail.com', 'label_charset'],
    [`${Array.from({ length: 5 }, () => 'a'.repeat(50)).join('.')}.com`, 'too_long'],
    ['acme.123', 'numeric_tld'],
    ['acme.0', 'numeric_tld']
  ];
  it.each(cases)('rejects %s with %s', (input, reason) => {
    expect(normalizeSendingDomain(input)).toEqual({ ok: false, reason });
  });
});

describe('senderLocalPartSchema', () => {
  const accepted = ['support', 'billing', 'notifications', 'help-desk', 'a', 'a.b', 'a+b', 'a_b', 'x1', 'a'.repeat(64)];
  it.each(accepted)('accepts %s', (v) => {
    expect(senderLocalPartSchema.parse(v)).toBe(v.toLowerCase());
  });
  it('lowercases and trims', () => {
    expect(senderLocalPartSchema.parse('  Support  ')).toBe('support');
  });
  const rejected = ['', '.support', 'support.', '-support', 'support-', 'sup..port', 'sup port', 'sup@port', 'a'.repeat(65), 'ü'];
  it.each(rejected)('rejects %s', (v) => {
    expect(senderLocalPartSchema.safeParse(v).success).toBe(false);
  });
  it.each(RESERVED_SENDER_LOCAL_PARTS)('refuses the reserved local part %s', (v) => {
    expect(senderLocalPartSchema.safeParse(v).success).toBe(false);
  });
});

describe('senderDisplayNameSchema', () => {
  it('strips header-breaking characters', () => {
    expect(senderDisplayNameSchema.parse('Acme\r\nBcc: evil@x.com')).toBe('Acme Bcc: evil@x.com');
  });
  it('collapses whitespace and trims', () => {
    expect(senderDisplayNameSchema.parse('  Acme   MSP  ')).toBe('Acme MSP');
  });
  it('accepts a plain name', () => {
    expect(senderDisplayNameSchema.parse('Acme MSP Support')).toBe('Acme MSP Support');
  });
  const rejected = [
    '',
    '   ',
    '"<>\\',
    'billing@acme.com',
    'Acme <billing@acme.com>',
    'Click https://evil.example',
    'a'.repeat(79)
  ];
  it.each(rejected)('rejects %s', (v) => {
    expect(senderDisplayNameSchema.safeParse(v).success).toBe(false);
  });
});

describe('createSendingDomainSchema', () => {
  it('normalizes on parse', () => {
    expect(createSendingDomainSchema.parse({ domain: '  ACME.com. ' })).toEqual({ domain: 'acme.com' });
  });
  it('rejects a structurally invalid domain', () => {
    expect(createSendingDomainSchema.safeParse({ domain: 'https://acme.com' }).success).toBe(false);
  });
  it('is strict', () => {
    expect(createSendingDomainSchema.safeParse({ domain: 'acme.com', partnerId: 'x' }).success).toBe(false);
  });
});

describe('upsertSenderIdentitySchema', () => {
  const uuid = '11111111-2222-3333-4444-555555555555';
  it('accepts the minimal body', () => {
    expect(upsertSenderIdentitySchema.parse({ sendingDomainId: uuid, localPart: 'Support' }))
      .toEqual({ sendingDomainId: uuid, localPart: 'support' });
  });
  it('accepts an explicit null displayName and replyTo', () => {
    expect(upsertSenderIdentitySchema.parse({ sendingDomainId: uuid, localPart: 'billing', displayName: null, replyTo: null }))
      .toEqual({ sendingDomainId: uuid, localPart: 'billing', displayName: null, replyTo: null });
  });
  it('rejects a non-uuid domain id', () => {
    expect(upsertSenderIdentitySchema.safeParse({ sendingDomainId: 'nope', localPart: 'support' }).success).toBe(false);
  });
  it('rejects a non-email replyTo', () => {
    expect(upsertSenderIdentitySchema.safeParse({ sendingDomainId: uuid, localPart: 'support', replyTo: 'nope' }).success).toBe(false);
  });
  it('rejects a stream field — the stream comes from the route path, never the body', () => {
    expect(upsertSenderIdentitySchema.safeParse({ sendingDomainId: uuid, localPart: 'support', stream: 'support' }).success).toBe(false);
  });
});

describe('constant sets', () => {
  it('pins the status set the migration CHECK allows', () => {
    expect([...SENDING_DOMAIN_STATUSES]).toEqual([
      'provisioning', 'pending', 'verified', 'at_risk', 'failed', 'suspended', 'removing'
    ]);
  });
  it('pins the status reason set the migration CHECK allows', () => {
    expect([...SENDING_DOMAIN_STATUS_REASONS]).toEqual([
      'provider_conflict', 'provider_rejected', 'quota_exhausted', 'dns_not_detected',
      'dns_removed', 'platform_suspended', 'abuse_auto', 'failed_expired', 'user_removed'
    ]);
  });
  it('pins the stream set W01 PartnerMailStream declares', () => {
    expect([...PARTNER_MAIL_STREAMS]).toEqual(['support', 'billing', 'general']);
  });
});

describe('DTO shape W05 is built against', () => {
  // A runtime fixture typed as the DTO: an omitted or wrongly-nullable field is
  // a compile error, and the assertions below keep the fields W05 depends on
  // from quietly becoming optional later.
  const domainDto: SendingDomainDto = {
    id: '11111111-2222-3333-4444-555555555555',
    domain: 'acme.com',
    provider: 'resend',
    status: 'failed',
    statusReason: 'dns_not_detected',
    statusChangedAt: '2026-09-17T10:00:00.000Z',
    dnsRecords: [],
    verifiedAt: null,
    lastCheckedAt: '2026-09-17T09:00:00.000Z',
    lastTestAt: null,
    lastTestStatus: null,
    lastTestError: null,
    lastSendError: null,
    lastSendErrorAt: null,
    providerManaged: true,
    createdAt: '2026-09-15T10:00:00.000Z'
  };

  const identityDto: SenderIdentityDto = {
    id: '66666666-7777-8888-9999-000000000000',
    stream: 'support',
    sendingDomainId: domainDto.id,
    domain: 'acme.com',
    localPart: 'support',
    displayName: 'Acme MSP Support',
    replyTo: null,
    fromAddress: 'support@acme.com',
    updatedAt: '2026-09-17T10:00:00.000Z'
  };

  it('statusChangedAt is a REQUIRED ISO string — W05 computes the 72 h retry window on a failed row from it', () => {
    expect(typeof domainDto.statusChangedAt).toBe('string');
    expect(Number.isNaN(Date.parse(domainDto.statusChangedAt))).toBe(false);
    // Required, so it cannot be narrowed to include null/undefined.
    const required: string = domainDto.statusChangedAt;
    expect(required).toBe('2026-09-17T10:00:00.000Z');
  });

  it('SenderIdentityDto.domain and .fromAddress are REQUIRED — the identity card renders the From without re-joining', () => {
    const domain: string = identityDto.domain;
    const fromAddress: string = identityDto.fromAddress;
    expect(domain).toBe('acme.com');
    expect(fromAddress).toBe(`${identityDto.localPart}@${identityDto.domain}`);
  });
});
```

The fixture needs the DTO types in scope — add
`import type { SendingDomainDto, SenderIdentityDto } from '../types/sendingDomains';`
to the top of this test file.

Run: `cd packages/shared && npx vitest run src/validators/sendingDomains.test.ts`
Expected: FAIL — `Cannot find module './sendingDomains'`.

- [ ] **Step 2: Implement the validators**

`packages/shared/src/validators/sendingDomains.ts`:

```ts
import { z } from 'zod';

/**
 * Partner sending domains — shared validation (spec 2026-09-17 §4.1, §4.4).
 *
 * This module is the PLATFORM-INDEPENDENT half: trim/lowercase/A-label
 * conversion and the structural rejections, so the web form and the API agree
 * character for character. The policy half — platform-owned domains, consumer
 * mailbox providers, public suffixes, the operator denylist — reads server
 * configuration and lives in
 * apps/api/src/services/emailDomains/domainPolicy.ts.
 */

export const SENDING_DOMAIN_STATUSES = [
  'provisioning', 'pending', 'verified', 'at_risk', 'failed', 'suspended', 'removing'
] as const;
export type SendingDomainStatusValue = (typeof SENDING_DOMAIN_STATUSES)[number];

export const SENDING_DOMAIN_STATUS_REASONS = [
  'provider_conflict', 'provider_rejected', 'quota_exhausted', 'dns_not_detected',
  'dns_removed', 'platform_suspended', 'abuse_auto', 'failed_expired', 'user_removed'
] as const;
export type SendingDomainStatusReason = (typeof SENDING_DOMAIN_STATUS_REASONS)[number];

/**
 * Must stay identical to W01's `PartnerMailStream`
 * (apps/api/src/services/emailDomains/mailPurposes.ts). A compile-time parity
 * assertion lives in apps/api/src/services/emailDomains/provider.ts.
 */
export const PARTNER_MAIL_STREAMS = ['support', 'billing', 'general'] as const;
export type PartnerMailStreamValue = (typeof PARTNER_MAIL_STREAMS)[number];

export type SendingDomainRejection =
  | 'empty' | 'scheme' | 'path' | 'port' | 'at_sign' | 'wildcard' | 'ip_literal'
  | 'too_few_labels' | 'label_length' | 'label_charset' | 'too_long' | 'numeric_tld' | 'idn_invalid';

export type NormalizeSendingDomainResult =
  | { ok: true; domain: string }
  | { ok: false; reason: SendingDomainRejection };

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const LDH_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const ALL_DIGITS = /^\d+$/;

/**
 * Trim, lowercase, strip trailing dots, reject structurally, then convert IDN
 * to its A-label via the WHATWG URL parser — which applies UTS-46 identically
 * in Node and every browser, so no punycode dependency is needed on either side.
 */
export function normalizeSendingDomain(input: string): NormalizeSendingDomainResult {
  const raw = (input ?? '').trim().toLowerCase();
  if (raw.length === 0) return { ok: false, reason: 'empty' };

  // Structural rejections run BEFORE the URL parse, so each one gets its own
  // reason instead of collapsing into a generic parse failure.
  if (raw.includes('://') || raw.startsWith('//')) return { ok: false, reason: 'scheme' };
  if (raw.includes('/') || raw.includes('?') || raw.includes('#')) return { ok: false, reason: 'path' };
  if (raw.includes('@')) return { ok: false, reason: 'at_sign' };
  if (raw.includes('*')) return { ok: false, reason: 'wildcard' };
  // Covers both `acme.com:587` and an IPv6 literal, which can only appear
  // bracketed and always carries colons.
  if (raw.includes(':')) return { ok: false, reason: 'port' };

  const trimmedDots = raw.replace(/\.+$/, '');
  if (trimmedDots.length === 0) return { ok: false, reason: 'empty' };

  let hostname: string;
  try {
    hostname = new URL(`http://${trimmedDots}`).hostname;
  } catch {
    return { ok: false, reason: 'idn_invalid' };
  }
  // The URL parser keeps a trailing root dot; strip it again post-parse.
  hostname = hostname.replace(/\.+$/, '');
  if (hostname.length === 0) return { ok: false, reason: 'empty' };
  if (hostname.startsWith('[')) return { ok: false, reason: 'ip_literal' };
  if (IPV4_LITERAL.test(hostname)) return { ok: false, reason: 'ip_literal' };
  if (hostname.length > 253) return { ok: false, reason: 'too_long' };

  const labels = hostname.split('.');
  if (labels.length < 2) return { ok: false, reason: 'too_few_labels' };
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return { ok: false, reason: 'label_length' };
    if (!LDH_LABEL.test(label)) return { ok: false, reason: 'label_charset' };
  }
  if (ALL_DIGITS.test(labels[labels.length - 1]!)) return { ok: false, reason: 'numeric_tld' };

  return { ok: true, domain: hostname };
}

/**
 * Refused because mail to them must reach a human or a bounce processor at the
 * DOMAIN owner, never a Breeze-generated notification stream (RFC 5321 §4.5.1,
 * RFC 2142).
 */
export const RESERVED_SENDER_LOCAL_PARTS = ['postmaster', 'abuse', 'mailer-daemon'] as const;

export const SENDER_LOCAL_PART_PATTERN = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;
export const SENDER_LOCAL_PART_MAX = 64;
export const SENDER_DISPLAY_NAME_MAX = 78;

export const senderLocalPartSchema = z
  .string()
  .max(SENDER_LOCAL_PART_MAX)
  .transform((v) => v.trim().toLowerCase())
  .refine((v) => SENDER_LOCAL_PART_PATTERN.test(v), { message: 'local_part_invalid' })
  .refine((v) => !v.includes('..'), { message: 'local_part_consecutive_dots' })
  .refine((v) => !(RESERVED_SENDER_LOCAL_PARTS as readonly string[]).includes(v), {
    message: 'local_part_reserved'
  });

/**
 * Passes the same header-safety strip `EmailService.fromWithDisplayName`
 * applies (services/email.ts:235), then refuses the "display name that looks
 * like another address" spoof. The `@` / `://` checks run AFTER the strip so
 * `Acme <billing@acme.com>` cannot smuggle an address past by wrapping it in
 * angle brackets.
 */
export const senderDisplayNameSchema = z
  .string()
  .max(SENDER_DISPLAY_NAME_MAX)
  .transform((v) => v.replace(/[\r\n"<>\\]/g, ' ').replace(/\s+/g, ' ').trim())
  .refine((v) => v.length > 0, { message: 'display_name_empty' })
  .refine((v) => !v.includes('@') && !v.includes('://'), { message: 'display_name_spoof' });

export const createSendingDomainSchema = z
  .object({
    // Generous raw bound; normalizeSendingDomain enforces the real 253 limit
    // after A-label conversion, which can lengthen the string.
    domain: z.string().min(1).max(512)
  })
  .strict()
  .transform((body, ctx) => {
    const normalized = normalizeSendingDomain(body.domain);
    if (!normalized.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['domain'], message: normalized.reason });
      return z.NEVER;
    }
    return { domain: normalized.domain };
  });

export const upsertSenderIdentitySchema = z
  .object({
    sendingDomainId: z.string().uuid(),
    localPart: senderLocalPartSchema,
    displayName: senderDisplayNameSchema.nullish(),
    replyTo: z.string().email().max(320).nullish()
  })
  // `stream` is a path parameter (PUT /identities/:stream), never a body field.
  .strict();
```

Add to `packages/shared/src/validators/index.ts`, beside the other leaf re-exports (after `export * from './businessEmail';`, `:23`):

```ts
export * from './sendingDomains';
```

- [ ] **Step 3: Write the DTO module**

`packages/shared/src/types/sendingDomains.ts`:

```ts
import type {
  PartnerMailStreamValue,
  SendingDomainStatusReason,
  SendingDomainStatusValue
} from '../validators/sendingDomains';

/** Provider identifiers a row can carry (spec §3.1 CHECK). */
export type SendingDomainProviderId = 'resend' | 'ses' | 'static' | 'fake';

/**
 * One normalised DNS record the partner must publish. `host` is the label as
 * the provider returns it; `fqdn` is what must actually resolve, computed by
 * the adapter so the UI never has to concatenate.
 */
export interface SendingDomainDnsRecordDto {
  purpose: 'dkim' | 'spf' | 'return_path_mx' | 'other';
  type: 'TXT' | 'CNAME' | 'MX';
  host: string;
  fqdn: string;
  value: string;
  priority?: number;
  ttl?: string;
  status: 'pending' | 'verified' | 'failed';
}

/** A `partner_sending_domains` row as the API renders it. Timestamps are ISO-8601. */
export interface SendingDomainDto {
  id: string;
  domain: string;
  provider: SendingDomainProviderId;
  status: SendingDomainStatusValue;
  statusReason: SendingDomainStatusReason | null;
  /**
   * When `status` last changed. REQUIRED, never null — the column is
   * `NOT NULL DEFAULT now()`. W05 needs it to compute the 72 h retry window on
   * a `failed` row (spec §4.3, §10), which no other field carries.
   */
  statusChangedAt: string;
  dnsRecords: SendingDomainDnsRecordDto[];
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastTestAt: string | null;
  lastTestStatus: 'pending' | 'sent' | 'failed' | null;
  lastTestError: string | null;
  lastSendError: string | null;
  lastSendErrorAt: string | null;
  /**
   * false when the provider domain pre-existed Breeze asking for it. The UI
   * says so on the remove confirmation: removing such a row drops the local row
   * only and never touches the operator's provider account.
   */
  providerManaged: boolean;
  createdAt: string;
}

/** A `partner_sender_identities` row, joined to its domain. */
export interface SenderIdentityDto {
  id: string;
  stream: PartnerMailStreamValue;
  sendingDomainId: string;
  domain: string;
  localPart: string;
  displayName: string | null;
  replyTo: string | null;
  /** Computed `localPart@domain` — the exact From this stream will send with. */
  fromAddress: string;
  updatedAt: string;
}

/**
 * What the settings tab needs before it renders anything.
 * `supported: false` hides the tab; `eligible: false` locks it with `reason`.
 */
export interface SendingDomainsCapabilityDto {
  supported: boolean;
  provider: SendingDomainProviderId | null;
  /** false for `static`: no DNS wizard, no "Check now", no polling. */
  verifiesByDns: boolean;
  eligible: boolean;
  reason?: string;
  maxDomains: number;
}

export interface SendingDomainsListResponse {
  capability: SendingDomainsCapabilityDto;
  domains: SendingDomainDto[];
  identities: SenderIdentityDto[];
}
```

Add to `packages/shared/src/types/index.ts` after `export * from './deviceFunction';` (`:817`):

```ts
export * from './sendingDomains';
```

- [ ] **Step 4: Run and typecheck**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/packages/shared
npx vitest run src/validators/sendingDomains.test.ts
npx tsc --noEmit -p tsconfig.json
```
Expected: all cases PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add packages/shared/src/validators/sendingDomains.ts packages/shared/src/validators/sendingDomains.test.ts packages/shared/src/validators/index.ts packages/shared/src/types/sendingDomains.ts packages/shared/src/types/index.ts
git commit -m "feat(shared): sending-domain normalisation, identity schemas and DTOs

normalizeSendingDomain does the platform-independent half of spec §4.1 (trim,
lowercase, trailing dot, IDN->A-label via WHATWG URL, structural rejections) so
the web form and the API agree exactly. Identity rules per §4.4. DTOs are the
contract W05's settings tab is built against.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 4: API-only domain policy (`assertSendingDomainAllowed`)

**Files:**
- Modify: `apps/api/package.json` (add the `tldts` dependency — see Step 1)
- Create: `apps/api/src/services/emailDomains/domainPolicy.ts`
- Create: `apps/api/src/services/emailDomains/domainPolicy.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SendingDomainPolicyRejection = 'platform_domain' | 'consumer_domain' | 'public_suffix' | 'denylisted';
  export class SendingDomainPolicyError extends Error { readonly reason: SendingDomainPolicyRejection }
  export function assertSendingDomainAllowed(domain: string): void;   // throws SendingDomainPolicyError
  export const PLATFORM_OWNED_DOMAINS: readonly ['2breeze.app', 'breezermm.com', 'lanternops.io'];
  ```
- Consumes: `isConsumerEmailDomain` (`services/consumerEmailDomains.ts:79` — takes an **email address**, so it is called as `isConsumerEmailDomain('postmaster@' + domain)`), `isHosted` (`config/env.ts:321`), `getEmailDomainsConfig().denylist` (Task 5 — this task lands first, so read `process.env.EMAIL_DOMAINS_DENYLIST` directly here and leave a `TODO(W02 Task 5)`-free direct read; Task 5's config module re-exposes the same parse and this module switches to it in Task 5 Step 5).
- Callers: W03's `createSendingDomain`. Input is always an **already normalised** domain from `normalizeSendingDomain`.

- [ ] **Step 1: Add the dependency**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
pnpm --filter @breeze/api add tldts
```
Expected: `apps/api/package.json` gains `"tldts": "^<resolved>"` in `dependencies`, and `pnpm-lock.yaml` updates. Do **not** hand-edit the version — let pnpm resolve it, and commit the lockfile change with this task.

- [ ] **Step 2: Write the failing tests**

`apps/api/src/services/emailDomains/domainPolicy.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { assertSendingDomainAllowed, SendingDomainPolicyError } from './domainPolicy';

const SAVED: Record<string, string | undefined> = {};
const KEYS = ['IS_HOSTED', 'EMAIL_FROM', 'TICKETS_INBOUND_DOMAIN', 'PUBLIC_APP_URL', 'EMAIL_DOMAINS_DENYLIST'];

beforeEach(() => {
  for (const k of KEYS) { SAVED[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k]!;
  }
});

function reasonOf(domain: string): string | null {
  try {
    assertSendingDomainAllowed(domain);
    return null;
  } catch (err) {
    if (err instanceof SendingDomainPolicyError) return err.reason;
    throw err;
  }
}

describe('assertSendingDomainAllowed — accepted', () => {
  it.each(['acme.com', 'mail.acme.com', 'acme.co.uk', 'deep.sub.acme.com', 'acme-msp.io'])(
    'accepts %s on a self-hosted instance',
    (domain) => {
      expect(reasonOf(domain)).toBeNull();
    },
  );

  it('accepts the EMAIL_FROM domain on a SELF-HOSTED instance — it IS the MSP domain', () => {
    process.env.EMAIL_FROM = 'support@acme.com';
    expect(reasonOf('acme.com')).toBeNull();
  });
});

describe('assertSendingDomainAllowed — platform domains (hosted only)', () => {
  beforeEach(() => { process.env.IS_HOSTED = 'true'; });

  it.each(['2breeze.app', 'breezermm.com', 'lanternops.io', 'mail.2breeze.app', 'a.b.breezermm.com'])(
    'refuses the static platform domain %s',
    (domain) => {
      expect(reasonOf(domain)).toBe('platform_domain');
    },
  );

  it('refuses the EMAIL_FROM domain and its subdomains', () => {
    process.env.EMAIL_FROM = '"Breeze" <no-reply@send.breeze.example>';
    expect(reasonOf('send.breeze.example')).toBe('platform_domain');
    expect(reasonOf('x.send.breeze.example')).toBe('platform_domain');
  });

  it('refuses the TICKETS_INBOUND_DOMAIN', () => {
    process.env.TICKETS_INBOUND_DOMAIN = 'tickets.breeze.example';
    expect(reasonOf('tickets.breeze.example')).toBe('platform_domain');
  });

  it('refuses the PUBLIC_APP_URL host', () => {
    process.env.PUBLIC_APP_URL = 'https://app.breeze.example/path';
    expect(reasonOf('app.breeze.example')).toBe('platform_domain');
  });

  it('does not refuse a domain that merely ENDS WITH a platform name without a dot boundary', () => {
    expect(reasonOf('notbreezermm.com')).toBeNull();
  });
});

describe('assertSendingDomainAllowed — platform domains do NOT apply self-hosted', () => {
  it('accepts the EMAIL_FROM domain when IS_HOSTED is unset', () => {
    process.env.EMAIL_FROM = 'support@acme.com';
    expect(reasonOf('acme.com')).toBeNull();
  });
  it('still refuses the Breeze-owned static list self-hosted', () => {
    // A self-hoster cannot prove ownership of 2breeze.app either.
    expect(reasonOf('2breeze.app')).toBe('platform_domain');
  });
});

describe('assertSendingDomainAllowed — consumer mailbox providers', () => {
  it.each(['gmail.com', 'outlook.com', 'yahoo.co.uk', 'icloud.com', 'proton.me'])(
    'refuses %s',
    (domain) => {
      expect(reasonOf(domain)).toBe('consumer_domain');
    },
  );
  it('does not refuse a subdomain of a consumer provider (exact-match set)', () => {
    expect(reasonOf('mail.gmail.com')).toBeNull();
  });
});

describe('assertSendingDomainAllowed — public suffixes', () => {
  it.each(['com', 'co.uk', 'com.au', 'github.io', 'herokuapp.com'])(
    'refuses the registrable-boundary suffix %s',
    (domain) => {
      expect(reasonOf(domain)).toBe('public_suffix');
    },
  );
  it('accepts a name registered under one', () => {
    expect(reasonOf('acme.co.uk')).toBeNull();
    expect(reasonOf('acme.github.io')).toBeNull();
  });
});

describe('assertSendingDomainAllowed — operator denylist', () => {
  it('refuses an exact entry', () => {
    process.env.EMAIL_DOMAINS_DENYLIST = 'blocked.example, other.example';
    expect(reasonOf('blocked.example')).toBe('denylisted');
    expect(reasonOf('other.example')).toBe('denylisted');
  });
  it('refuses a subdomain of an entry', () => {
    process.env.EMAIL_DOMAINS_DENYLIST = 'blocked.example';
    expect(reasonOf('mail.blocked.example')).toBe('denylisted');
  });
  it('is case- and whitespace-insensitive', () => {
    process.env.EMAIL_DOMAINS_DENYLIST = '  BLOCKED.Example  ';
    expect(reasonOf('blocked.example')).toBe('denylisted');
  });
  it('leaves unrelated domains alone', () => {
    process.env.EMAIL_DOMAINS_DENYLIST = 'blocked.example';
    expect(reasonOf('acme.com')).toBeNull();
  });
});

describe('rejection precedence', () => {
  it('reports platform_domain before anything else', () => {
    process.env.IS_HOSTED = 'true';
    process.env.EMAIL_DOMAINS_DENYLIST = '2breeze.app';
    expect(reasonOf('2breeze.app')).toBe('platform_domain');
  });
});
```

Run: `cd apps/api && npx vitest run src/services/emailDomains/domainPolicy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`apps/api/src/services/emailDomains/domainPolicy.ts`:

```ts
import { parse as parseTld } from 'tldts';
import { isHosted } from '../../config/env';
import { isConsumerEmailDomain } from '../consumerEmailDomains';

/**
 * API-only sending-domain policy (spec §4.1, "The API additionally rejects").
 *
 * The structural half — trim, lowercase, trailing dot, IDN->A-label, label
 * shape — is `normalizeSendingDomain` in @breeze/shared, shared with the web
 * form. These rules are here instead because they read server configuration
 * and a public-suffix list the browser bundle has no business carrying.
 *
 * Input is always an ALREADY NORMALISED domain (lowercase A-label, no trailing
 * dot). Callers run normalizeSendingDomain first.
 */

export type SendingDomainPolicyRejection =
  | 'platform_domain'
  | 'consumer_domain'
  | 'public_suffix'
  | 'denylisted';

export class SendingDomainPolicyError extends Error {
  constructor(readonly reason: SendingDomainPolicyRejection) {
    super(`sending domain refused: ${reason}`);
    this.name = 'SendingDomainPolicyError';
  }
}

/**
 * Breeze-owned names. Refused in EVERY deployment mode — nobody self-hosting
 * can prove ownership of these either — unlike the env-derived platform domains
 * below, which are hosted-only because on a self-hosted instance EMAIL_FROM's
 * domain IS the MSP's own domain and is exactly what the operator will add.
 */
export const PLATFORM_OWNED_DOMAINS = ['2breeze.app', 'breezermm.com', 'lanternops.io'] as const;

function domainOfAddressOrHost(raw: string | undefined): string | null {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return null;
  // `"Breeze" <no-reply@2breeze.app>` or a bare address.
  const at = value.lastIndexOf('@');
  const candidate = at >= 0 ? value.slice(at + 1) : value;
  return candidate.replace(/[>\s]+$/g, '').replace(/\.+$/, '') || null;
}

function hostOfUrl(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase().replace(/\.+$/, '') || null;
  } catch {
    return null;
  }
}

/** Exact match, or a dot-boundary subdomain. `notbreezermm.com` is NOT a match. */
function isSelfOrSubdomainOf(domain: string, parent: string): boolean {
  return domain === parent || domain.endsWith(`.${parent}`);
}

export function parseDomainDenylist(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase().replace(/\.+$/, ''))
    .filter((entry) => entry.length > 0);
}

export function assertSendingDomainAllowed(domain: string): void {
  const target = domain.trim().toLowerCase();

  // 1. Platform-owned names. Checked FIRST so the reason a partner sees is the
  //    accurate one even when the domain would also trip a later rule.
  for (const owned of PLATFORM_OWNED_DOMAINS) {
    if (isSelfOrSubdomainOf(target, owned)) throw new SendingDomainPolicyError('platform_domain');
  }
  if (isHosted()) {
    const platformDerived = [
      domainOfAddressOrHost(process.env.EMAIL_FROM),
      domainOfAddressOrHost(process.env.TICKETS_INBOUND_DOMAIN),
      hostOfUrl(process.env.PUBLIC_APP_URL)
    ].filter((value): value is string => value !== null);
    for (const owned of platformDerived) {
      if (isSelfOrSubdomainOf(target, owned)) throw new SendingDomainPolicyError('platform_domain');
    }
  }

  // 2. Consumer mailbox providers. isConsumerEmailDomain takes an ADDRESS, not
  //    a domain (services/consumerEmailDomains.ts:79 -> emailDomainOf at :66),
  //    so a local part is prepended. `postmaster` is never delivered anywhere —
  //    the string is only split on '@'.
  if (isConsumerEmailDomain(`postmaster@${target}`)) {
    throw new SendingDomainPolicyError('consumer_domain');
  }

  // 3. Public suffixes. `parseTld(...).domain` is null exactly when the input IS
  //    a suffix (or is otherwise unregistrable). allowPrivateDomains folds in
  //    github.io / herokuapp.com, which nobody may claim wholesale.
  const parsed = parseTld(target, { allowPrivateDomains: true });
  if (!parsed.domain || parsed.publicSuffix === target) {
    throw new SendingDomainPolicyError('public_suffix');
  }

  // 4. The operator's own denylist.
  for (const denied of parseDomainDenylist(process.env.EMAIL_DOMAINS_DENYLIST)) {
    if (isSelfOrSubdomainOf(target, denied)) throw new SendingDomainPolicyError('denylisted');
  }
}
```

- [ ] **Step 4: Run and commit**

Run: `cd apps/api && npx vitest run src/services/emailDomains/domainPolicy.test.ts` → all PASS.

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/api/package.json pnpm-lock.yaml apps/api/src/services/emailDomains/domainPolicy.ts apps/api/src/services/emailDomains/domainPolicy.test.ts
git commit -m "feat(api): sending-domain policy rejections (platform, consumer, public suffix, denylist)

The API-only half of spec §4.1. Platform-domain rejection is hosted-only for the
env-derived names, because on a self-hosted instance EMAIL_FROM's domain IS the
MSP's own domain. Adds tldts — the repo had no public-suffix list.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 5: Configuration — schema, boot rules, reader, documentation, compose

Ten optional variables (spec §11). **Every one is optional; none is ever
required by an upgrade.** Validation fails only on a contradiction the operator
introduced (`resend` with no key, `fake` in production) or a hosted-only rule
(`static` on hosted, identical keys on hosted).

**Files:**
- Modify: `apps/api/src/config/validate.ts` — zod keys after the email block (`:809`); a production `requireIf` after the last email `requireIf` (`:1712`); an unconditional deployment-mode block immediately before the `});` that closes the `.superRefine(...)` callback (after the APNS block, `~:2168`)
- Modify: `apps/api/src/config/validate.test.ts` — new cases after the email H-3 block (`:2162`), before the Cloudflare comment (`:2164`)
- Modify: `apps/api/src/config/envComposeParity.test.ts` — an `EMAIL_DOMAINS_*` pin describe, copying the QBO template (`:260-289`)
- Create: `apps/api/src/services/emailDomains/config.ts`
- Create: `apps/api/src/services/emailDomains/config.test.ts`
- Modify: `.env.example` (append after `MAILGUN_TIMEOUT_MS=120000`, `:348`)
- Modify: `deploy/.env.example` (append after `# SMTP_PASS=`, `:247`)
- Modify: `docker-compose.yml` (insert after `MAILGUN_TIMEOUT_MS: ${MAILGUN_TIMEOUT_MS:-}`, `:420`)
- Modify: `deploy/docker-compose.prod.yml` (insert after `MAILGUN_TIMEOUT_MS: ${MAILGUN_TIMEOUT_MS:-}`, `:137`)
- Modify: `apps/api/src/services/emailDomains/domainPolicy.ts` (switch the denylist read to the config module — Step 6)

**Interfaces:**
- Produces:
  ```ts
  export type EmailDomainsProviderId = 'resend' | 'static' | 'fake';
  export interface StaticAllowedEntry { domain: string; partnerSlug: string | null }
  export interface EmailDomainsConfig {
    provider: EmailDomainsProviderId | null;
    resendApiKey: string | null;
    resendSendingKey: string | null;   // falls back to resendApiKey
    region: string;
    maxPerPartner: number;
    dailySendCap: number;              // 0 = unlimited
    partnerAllowlist: string[];
    denylist: string[];
    staticAllowed: StaticAllowedEntry[];
    webhookSecret: string | null;
  }
  export function getEmailDomainsConfig(): EmailDomainsConfig;
  export function isPartnerLaneConfigured(): boolean;
  export function findStaticAllowedEntry(domain: string, partnerSlug: string | null): StaticAllowedEntry | null;
  ```
- Consumes: `isHosted` (`config/env.ts:321`).
- Callers: `providerRegistry.ts` (Task 6), all three adapters (Tasks 7-8),
  `domainPolicy.ts` (Step 6), W03's service and worker.

- [ ] **Step 1: Write the failing deployment-mode matrix (spec §14)**

Insert into `apps/api/src/config/validate.test.ts` immediately after the email
H-3 cases end (`:2162`), inside the same
`describe('Feature-flagged production secrets (H-3)', …)`:

```ts
    // --- Partner sending domains (EMAIL_DOMAINS_*) ---------------------------
    // Deployment-mode matrix, spec §14. The load-bearing property is the FIRST
    // case: an upgrade with none of these set must boot unchanged.
    it('boots with every EMAIL_DOMAINS_* variable unset (upgrade is a no-op)', () => {
      withEnv({ ...prodBase }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    it('boots with EMAIL_DOMAINS_PROVIDER empty — compose maps optional vars as ${VAR:-}', () => {
      withEnv({ ...prodBase, EMAIL_DOMAINS_PROVIDER: '' }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    it('refuses an unrecognised EMAIL_DOMAINS_PROVIDER value', () => {
      withEnv({ ...prodBase, EMAIL_DOMAINS_PROVIDER: 'mailgun' }, () => {
        expect(() => validateConfig()).toThrow(/EMAIL_DOMAINS_PROVIDER/);
      });
    });

    it('refuses EMAIL_DOMAINS_PROVIDER=resend without EMAIL_DOMAINS_RESEND_API_KEY', () => {
      withEnv({ ...prodBase, EMAIL_DOMAINS_PROVIDER: 'resend', EMAIL_DOMAINS_RESEND_API_KEY: '' }, () => {
        expect(() => validateConfig()).toThrow(/EMAIL_DOMAINS_RESEND_API_KEY/);
      });
    });

    it('accepts EMAIL_DOMAINS_PROVIDER=resend with its own key', () => {
      withEnv({
        ...prodBase,
        EMAIL_DOMAINS_PROVIDER: 'resend',
        RESEND_API_KEY: 're_platform',
        EMAIL_DOMAINS_RESEND_API_KEY: 're_partner_lane',
      }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    it('refuses EMAIL_DOMAINS_PROVIDER=fake in production', () => {
      withEnv({ ...prodBase, EMAIL_DOMAINS_PROVIDER: 'fake' }, () => {
        expect(() => validateConfig()).toThrow(/EMAIL_DOMAINS_PROVIDER/);
      });
    });

    it('accepts EMAIL_DOMAINS_PROVIDER=fake outside production', () => {
      withEnv({ ...validEnv, NODE_ENV: 'development', EMAIL_DOMAINS_PROVIDER: 'fake' }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    it('refuses EMAIL_DOMAINS_PROVIDER=static when IS_HOSTED=true', () => {
      withEnv({ ...prodBase, IS_HOSTED: 'true', EMAIL_DOMAINS_PROVIDER: 'static' }, () => {
        expect(() => validateConfig()).toThrow(/EMAIL_DOMAINS_PROVIDER/);
      });
    });

    it('accepts EMAIL_DOMAINS_PROVIDER=static when self-hosted', () => {
      withEnv({
        ...prodBase,
        IS_HOSTED: 'false',
        EMAIL_DOMAINS_PROVIDER: 'static',
        EMAIL_DOMAINS_STATIC_ALLOWED: 'acme.com,other.com:other-slug',
      }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    it('refuses an EMAIL_DOMAINS_RESEND_API_KEY identical to RESEND_API_KEY when hosted', () => {
      withEnv({
        ...prodBase,
        IS_HOSTED: 'true',
        EMAIL_DOMAINS_PROVIDER: 'resend',
        RESEND_API_KEY: 're_same',
        EMAIL_DOMAINS_RESEND_API_KEY: 're_same',
      }, () => {
        expect(() => validateConfig()).toThrow(/EMAIL_DOMAINS_RESEND_API_KEY/);
      });
    });

    it('accepts identical keys when self-hosted, and says so once', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      withEnv({
        ...prodBase,
        IS_HOSTED: 'false',
        EMAIL_DOMAINS_PROVIDER: 'resend',
        RESEND_API_KEY: 're_same',
        EMAIL_DOMAINS_RESEND_API_KEY: 're_same',
      }, () => {
        expect(() => validateConfig()).not.toThrow();
        const lines = [...warn.mock.calls, ...info.mock.calls].map((c) => String(c[0]));
        expect(lines.filter((l) => l.includes('EMAIL_DOMAINS_RESEND_API_KEY'))).toHaveLength(1);
      });
      warn.mockRestore();
      info.mockRestore();
    });

    it('never keys any EMAIL_DOMAINS requirement on EMAIL_PROVIDER', () => {
      // The self-host regression this guards: a Resend self-host that upgrades
      // must not be asked for a partner-lane key it has never heard of.
      withEnv({ ...prodBase, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_platform' }, () => {
        expect(() => validateConfig()).not.toThrow();
      });
    });

    it.each([
      'EMAIL_DOMAINS_PROVIDER',
      'EMAIL_DOMAINS_STATIC_ALLOWED',
      'EMAIL_DOMAINS_RESEND_API_KEY',
      'EMAIL_DOMAINS_RESEND_SENDING_KEY',
      'EMAIL_DOMAINS_REGION',
      'EMAIL_DOMAINS_MAX_PER_PARTNER',
      'EMAIL_DOMAINS_DAILY_SEND_CAP',
      'EMAIL_DOMAINS_PARTNER_ALLOWLIST',
      'EMAIL_DOMAINS_DENYLIST',
      'EMAIL_DOMAINS_WEBHOOK_SECRET',
    ])('%s is declared in the env schema', (name) => {
      expect(ENV_SCHEMA_KEYS).toContain(name);
    });
```

`vi` must be imported in that file — add it to the existing `vitest` import if absent.

Run: `cd apps/api && npx vitest run src/config/validate.test.ts`
Expected: FAIL on the `ENV_SCHEMA_KEYS` cases and the refusal cases.

- [ ] **Step 2: Declare the keys**

In `apps/api/src/config/validate.ts`, immediately after the existing email block
(`:809`, after `MAILGUN_DOMAIN: z.string().optional(),`):

```ts
    // -- Partner sending domains (spec 2026-09-17) ---------------------------
    // ALL optional, and none is ever required by an upgrade. Declared as plain
    // strings (not z.enum): compose maps optional vars as ${VAR:-}, so an unset
    // variable arrives as "" and a bare enum would refuse boot on every
    // deployment that upgrades. Value checks live in the superRefine, where ""
    // and unset both mean "the feature is off".
    EMAIL_DOMAINS_PROVIDER: z.string().optional(),
    EMAIL_DOMAINS_STATIC_ALLOWED: z.string().optional(),
    EMAIL_DOMAINS_RESEND_API_KEY: z.string().optional(),
    EMAIL_DOMAINS_RESEND_SENDING_KEY: z.string().optional(),
    EMAIL_DOMAINS_REGION: z.string().optional(),
    EMAIL_DOMAINS_MAX_PER_PARTNER: z.string().optional(),
    EMAIL_DOMAINS_DAILY_SEND_CAP: z.string().optional(),
    EMAIL_DOMAINS_PARTNER_ALLOWLIST: z.string().optional(),
    EMAIL_DOMAINS_DENYLIST: z.string().optional(),
    EMAIL_DOMAINS_WEBHOOK_SECRET: z.string().optional(),
```

- [ ] **Step 3: The production requirement**

In the same file, immediately after the last email `requireIf` (the
`MAILGUN_DOMAIN` one ending at `:1712`), still inside the `if (isProduction) {`
block that opened at `:1210`:

```ts
      // Partner sending domains. KEYED ON EMAIL_DOMAINS_PROVIDER ONLY — never
      // on EMAIL_PROVIDER. A requireIf(EMAIL_PROVIDER === 'resend', …) here
      // would refuse boot on every Resend self-host that upgrades, which is the
      // exact promise spec §11 makes.
      const emailDomainsProviderProd = (data.EMAIL_DOMAINS_PROVIDER ?? '').trim().toLowerCase();
      requireIf(
        emailDomainsProviderProd === 'resend',
        'EMAIL_DOMAINS_RESEND_API_KEY',
        data.EMAIL_DOMAINS_RESEND_API_KEY,
        'EMAIL_DOMAINS_PROVIDER=resend (a full_access key; a sending-only key cannot manage domains)',
        ctx,
      );
      if (emailDomainsProviderProd === 'fake') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['EMAIL_DOMAINS_PROVIDER'],
          message:
            'EMAIL_DOMAINS_PROVIDER=fake is refused in production. The fake provider verifies domains deterministically and sends nothing real; it exists for unit, integration, E2E and wt-stack runs only. Use `resend`, `static`, or leave it unset.',
        });
      }
```

- [ ] **Step 4: The unconditional deployment-mode rules**

In the same file, immediately **before** the `});` that closes the
`.superRefine((data, ctx) => { … })` callback (after the APNS block, `~:2168`):

```ts
    // --- Partner sending domains: deployment-mode rules (spec §2.1, §11) ----
    // Outside the isProduction block on purpose: a hosted staging instance must
    // refuse `static` and identical keys exactly as production does, and an
    // unrecognised provider value is a misconfiguration in any NODE_ENV.
    const emailDomainsProvider = (data.EMAIL_DOMAINS_PROVIDER ?? '').trim().toLowerCase();
    if (emailDomainsProvider !== '') {
      const hostedInstance = ['true', '1', 'yes', 'on'].includes((data.IS_HOSTED ?? '').trim().toLowerCase());
      if (!['resend', 'static', 'fake'].includes(emailDomainsProvider)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['EMAIL_DOMAINS_PROVIDER'],
          message: `EMAIL_DOMAINS_PROVIDER must be one of resend, static, fake — got ${JSON.stringify(emailDomainsProvider)}. Leave it unset to keep custom sending domains off (the default).`,
        });
      }
      if (emailDomainsProvider === 'static' && hostedInstance) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['EMAIL_DOMAINS_PROVIDER'],
          message:
            'EMAIL_DOMAINS_PROVIDER=static is refused when IS_HOSTED=true. The static adapter is an OPERATOR ATTESTATION that the instance mail relay may send as the listed domains; on hosted there is no such operator and no DNS proof, so a partner could claim a domain it does not own. Use `resend` on hosted.',
        });
      }
      if (emailDomainsProvider === 'resend') {
        const platformKey = (data.RESEND_API_KEY ?? '').trim();
        const partnerKey = (data.EMAIL_DOMAINS_RESEND_API_KEY ?? '').trim();
        if (platformKey && partnerKey && platformKey === partnerKey) {
          if (hostedInstance) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['EMAIL_DOMAINS_RESEND_API_KEY'],
              message:
                'EMAIL_DOMAINS_RESEND_API_KEY must differ from RESEND_API_KEY when IS_HOSTED=true. Resend enforces bounce and spam limits ACCOUNT-WIDE, so a partner domain sharing the platform account can pause password-reset and security mail for every tenant. Create a second Resend team for the partner lane.',
            });
          } else {
            console.info(
              '[config] EMAIL_DOMAINS_RESEND_API_KEY matches RESEND_API_KEY — partner-domain mail will share this account\'s sending reputation with platform mail (password resets, security notices). That is supported self-hosted; a second Resend account isolates them.',
            );
          }
        }
      }
    }
```

- [ ] **Step 5: Write the config reader with its own failing test**

`apps/api/src/services/emailDomains/config.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getEmailDomainsConfig, isPartnerLaneConfigured, findStaticAllowedEntry } from './config';

const KEYS = [
  'IS_HOSTED', 'EMAIL_DOMAINS_PROVIDER', 'EMAIL_DOMAINS_STATIC_ALLOWED',
  'EMAIL_DOMAINS_RESEND_API_KEY', 'EMAIL_DOMAINS_RESEND_SENDING_KEY', 'EMAIL_DOMAINS_REGION',
  'EMAIL_DOMAINS_MAX_PER_PARTNER', 'EMAIL_DOMAINS_DAILY_SEND_CAP',
  'EMAIL_DOMAINS_PARTNER_ALLOWLIST', 'EMAIL_DOMAINS_DENYLIST', 'EMAIL_DOMAINS_WEBHOOK_SECRET'
];
const SAVED: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of KEYS) { SAVED[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => {
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]!;
  }
});

describe('getEmailDomainsConfig — defaults', () => {
  it('is off with everything unset', () => {
    const cfg = getEmailDomainsConfig();
    expect(cfg.provider).toBeNull();
    expect(isPartnerLaneConfigured()).toBe(false);
  });
  it('treats an empty string as unset (compose maps ${VAR:-})', () => {
    process.env.EMAIL_DOMAINS_PROVIDER = '';
    expect(getEmailDomainsConfig().provider).toBeNull();
  });
  it('ignores an unrecognised value rather than throwing (boot validation already refused it)', () => {
    process.env.EMAIL_DOMAINS_PROVIDER = 'mailgun';
    expect(getEmailDomainsConfig().provider).toBeNull();
  });
  it('defaults region to us-east-1 and maxPerPartner to 3', () => {
    const cfg = getEmailDomainsConfig();
    expect(cfg.region).toBe('us-east-1');
    expect(cfg.maxPerPartner).toBe(3);
  });
  it('defaults the daily send cap to 2000 hosted and unlimited self-hosted', () => {
    process.env.IS_HOSTED = 'true';
    expect(getEmailDomainsConfig().dailySendCap).toBe(2000);
    process.env.IS_HOSTED = 'false';
    expect(getEmailDomainsConfig().dailySendCap).toBe(0);
  });
  it('treats 0 as unlimited and rejects a non-numeric override by falling back', () => {
    process.env.IS_HOSTED = 'true';
    process.env.EMAIL_DOMAINS_DAILY_SEND_CAP = '0';
    expect(getEmailDomainsConfig().dailySendCap).toBe(0);
    process.env.EMAIL_DOMAINS_DAILY_SEND_CAP = 'lots';
    expect(getEmailDomainsConfig().dailySendCap).toBe(2000);
  });
});

describe('getEmailDomainsConfig — keys and lists', () => {
  it('falls the sending key back to the management key', () => {
    process.env.EMAIL_DOMAINS_RESEND_API_KEY = 're_full';
    const cfg = getEmailDomainsConfig();
    expect(cfg.resendApiKey).toBe('re_full');
    expect(cfg.resendSendingKey).toBe('re_full');
  });
  it('uses a distinct sending key when given', () => {
    process.env.EMAIL_DOMAINS_RESEND_API_KEY = 're_full';
    process.env.EMAIL_DOMAINS_RESEND_SENDING_KEY = 're_send';
    expect(getEmailDomainsConfig().resendSendingKey).toBe('re_send');
  });
  it('parses the partner allowlist and the denylist', () => {
    process.env.EMAIL_DOMAINS_PARTNER_ALLOWLIST = ' p1 , p2 ,, ';
    process.env.EMAIL_DOMAINS_DENYLIST = 'Blocked.Example , other.example.';
    const cfg = getEmailDomainsConfig();
    expect(cfg.partnerAllowlist).toEqual(['p1', 'p2']);
    expect(cfg.denylist).toEqual(['blocked.example', 'other.example']);
  });
});

describe('EMAIL_DOMAINS_STATIC_ALLOWED parsing', () => {
  it('parses bare and partner-bound entries', () => {
    process.env.EMAIL_DOMAINS_STATIC_ALLOWED = 'acme.com, Other.COM:other-slug , ';
    expect(getEmailDomainsConfig().staticAllowed).toEqual([
      { domain: 'acme.com', partnerSlug: null },
      { domain: 'other.com', partnerSlug: 'other-slug' }
    ]);
  });
  it('drops an entry with an empty domain or an empty slug after the colon', () => {
    process.env.EMAIL_DOMAINS_STATIC_ALLOWED = ':slug, acme.com:, ok.com';
    expect(getEmailDomainsConfig().staticAllowed).toEqual([{ domain: 'ok.com', partnerSlug: null }]);
  });
});

describe('findStaticAllowedEntry', () => {
  beforeEach(() => {
    process.env.EMAIL_DOMAINS_STATIC_ALLOWED = 'open.com, bound.com:acme';
  });
  it('matches an unbound entry for any partner', () => {
    expect(findStaticAllowedEntry('open.com', 'anyone')).toEqual({ domain: 'open.com', partnerSlug: null });
    expect(findStaticAllowedEntry('open.com', null)).toEqual({ domain: 'open.com', partnerSlug: null });
  });
  it('matches a bound entry only for its partner', () => {
    expect(findStaticAllowedEntry('bound.com', 'acme')).toEqual({ domain: 'bound.com', partnerSlug: 'acme' });
    expect(findStaticAllowedEntry('bound.com', 'other')).toBeNull();
    expect(findStaticAllowedEntry('bound.com', null)).toBeNull();
  });
  it('does not match a subdomain or an unlisted domain', () => {
    expect(findStaticAllowedEntry('mail.open.com', 'anyone')).toBeNull();
    expect(findStaticAllowedEntry('nope.com', 'anyone')).toBeNull();
  });
});

describe('isPartnerLaneConfigured', () => {
  it.each(['resend', 'static', 'fake'])('is true for %s', (provider) => {
    process.env.EMAIL_DOMAINS_PROVIDER = provider;
    expect(isPartnerLaneConfigured()).toBe(true);
  });
});
```

`apps/api/src/services/emailDomains/config.ts`:

```ts
import { isHosted } from '../../config/env';

/**
 * Parsed EMAIL_DOMAINS_* configuration (spec §11).
 *
 * Read at CALL TIME, never at module scope — the `config/partnerTrustMode.ts`
 * pattern. Tests flip a variable per case without `vi.resetModules()`, and a
 * worker restart is enough to pick up an operator's change.
 *
 * This module never throws. `config/validate.ts` already refused an
 * unrecognised provider, `fake` in production, `static` on hosted and identical
 * Resend keys on hosted at boot; anything that reaches here is either valid or
 * a value a non-validating entrypoint supplied, and "off" is the safe reading.
 */

export type EmailDomainsProviderId = 'resend' | 'static' | 'fake';

export interface StaticAllowedEntry {
  domain: string;
  /** null = any partner on the instance may claim it (the single-partner case). */
  partnerSlug: string | null;
}

export interface EmailDomainsConfig {
  provider: EmailDomainsProviderId | null;
  resendApiKey: string | null;
  resendSendingKey: string | null;
  region: string;
  maxPerPartner: number;
  /** 0 = unlimited. */
  dailySendCap: number;
  partnerAllowlist: string[];
  denylist: string[];
  staticAllowed: StaticAllowedEntry[];
  webhookSecret: string | null;
}

export const DEFAULT_EMAIL_DOMAINS_REGION = 'us-east-1';
export const DEFAULT_EMAIL_DOMAINS_MAX_PER_PARTNER = 3;
export const DEFAULT_HOSTED_DAILY_SEND_CAP = 2000;

function str(name: string): string | null {
  const value = (process.env[name] ?? '').trim();
  return value.length > 0 ? value : null;
}

function csv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function nonNegativeInt(name: string, fallback: number): number {
  const raw = str(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.warn(`[emailDomains] Ignoring non-integer ${name}=${JSON.stringify(raw)}; using ${fallback}.`);
    return fallback;
  }
  return parsed;
}

/** `domain` or `domain:partner-slug`, comma-separated. */
export function parseStaticAllowed(raw: string | undefined): StaticAllowedEntry[] {
  const entries: StaticAllowedEntry[] = [];
  for (const item of (raw ?? '').split(',')) {
    const trimmed = item.trim();
    if (trimmed.length === 0) continue;
    const colon = trimmed.indexOf(':');
    const domain = (colon >= 0 ? trimmed.slice(0, colon) : trimmed).trim().toLowerCase().replace(/\.+$/, '');
    const slug = colon >= 0 ? trimmed.slice(colon + 1).trim().toLowerCase() : '';
    if (domain.length === 0) continue;
    // `acme.com:` is an operator typo, not "bound to nobody" — drop it rather
    // than silently widening the entry to every partner on the instance.
    if (colon >= 0 && slug.length === 0) continue;
    entries.push({ domain, partnerSlug: colon >= 0 ? slug : null });
  }
  return entries;
}

export function getEmailDomainsConfig(): EmailDomainsConfig {
  const rawProvider = (process.env.EMAIL_DOMAINS_PROVIDER ?? '').trim().toLowerCase();
  const provider: EmailDomainsProviderId | null =
    rawProvider === 'resend' || rawProvider === 'static' || rawProvider === 'fake' ? rawProvider : null;

  const resendApiKey = str('EMAIL_DOMAINS_RESEND_API_KEY');

  return {
    provider,
    resendApiKey,
    // An optional sending_access key keeps the management key off the send
    // path; without one the send path reuses the full_access key (spec §11).
    resendSendingKey: str('EMAIL_DOMAINS_RESEND_SENDING_KEY') ?? resendApiKey,
    region: str('EMAIL_DOMAINS_REGION') ?? DEFAULT_EMAIL_DOMAINS_REGION,
    maxPerPartner: nonNegativeInt('EMAIL_DOMAINS_MAX_PER_PARTNER', DEFAULT_EMAIL_DOMAINS_MAX_PER_PARTNER),
    // Unlimited self-hosted: a self-hoster's volume is their own business, and a
    // default that silently moved their ticket mail back to EMAIL_FROM at
    // message 2,001 would be a bug report, not a protection (spec §9.1).
    dailySendCap: nonNegativeInt('EMAIL_DOMAINS_DAILY_SEND_CAP', isHosted() ? DEFAULT_HOSTED_DAILY_SEND_CAP : 0),
    partnerAllowlist: csv('EMAIL_DOMAINS_PARTNER_ALLOWLIST'),
    denylist: csv('EMAIL_DOMAINS_DENYLIST').map((d) => d.toLowerCase().replace(/\.+$/, '')),
    staticAllowed: parseStaticAllowed(process.env.EMAIL_DOMAINS_STATIC_ALLOWED),
    webhookSecret: str('EMAIL_DOMAINS_WEBHOOK_SECRET')
  };
}

export function isPartnerLaneConfigured(): boolean {
  return getEmailDomainsConfig().provider !== null;
}

/**
 * Exact-domain lookup with the partner binding applied. An unbound entry
 * matches any partner; a bound entry matches only its slug. Subdomains do NOT
 * match — the operator lists precisely what the relay may send as.
 */
export function findStaticAllowedEntry(domain: string, partnerSlug: string | null): StaticAllowedEntry | null {
  const target = domain.trim().toLowerCase().replace(/\.+$/, '');
  for (const entry of getEmailDomainsConfig().staticAllowed) {
    if (entry.domain !== target) continue;
    if (entry.partnerSlug === null) return entry;
    if (partnerSlug !== null && entry.partnerSlug === partnerSlug.trim().toLowerCase()) return entry;
  }
  return null;
}
```

Then change `domainPolicy.ts` to use it — replace the local `parseDomainDenylist(process.env.EMAIL_DOMAINS_DENYLIST)` call with `getEmailDomainsConfig().denylist`, add `import { getEmailDomainsConfig } from './config';`, and delete the now-unused `parseDomainDenylist` export. `domainPolicy.test.ts` keeps working unchanged: both read the same variable at call time.

- [ ] **Step 6: Document and map the variables**

Append to `.env.example` after `MAILGUN_TIMEOUT_MS=120000` (`:348`):

```
# --------------------------------------------
# Custom sender addresses / partner sending domains (optional)
# --------------------------------------------
# OFF by default. With EMAIL_DOMAINS_PROVIDER unset nothing changes: the
# settings tab is hidden, the routes 404, the worker is not registered, and
# every email is sent exactly as before. Upgrading never requires any of these.
#
# EMAIL_DOMAINS_PROVIDER picks HOW a sending domain is proven:
#   - unset  : feature off (default).
#   - static : you attest that this instance's mail relay may send as the
#              domains you list below. Use this on SMTP or Mailgun, where there
#              is no domain API for Breeze to check. SPF/DKIM for those domains
#              are YOUR mail setup; Breeze cannot verify them. A domain becomes
#              usable once a test send from it is accepted by the relay.
#   - resend : Breeze creates the domain in your Resend account and shows the
#              DKIM/SPF records to publish. Needs a full_access key — a
#              sending-only key cannot manage domains.
#   - fake   : deterministic test double. Refused in production.
#
# NOTE: this is the domain Breeze SENDS AS, which is not TICKETS_INBOUND_DOMAIN
# (what Breeze RECEIVES on) and not MAILGUN_DOMAIN.
EMAIL_DOMAINS_PROVIDER=
# `static` only. Comma-separated `domain` or `domain:partner-slug`. An unbound
# entry may be claimed by any partner on this instance, which is right for a
# single-partner install.
EMAIL_DOMAINS_STATIC_ALLOWED=
# `resend` only. full_access key of the account that holds partner domains. One
# account for both lanes is fine self-hosted; the trade-off is that partner
# domains then share your platform mail's sending reputation.
EMAIL_DOMAINS_RESEND_API_KEY=
# Optional sending_access key of the same account, so the send path never holds
# the management key. Falls back to EMAIL_DOMAINS_RESEND_API_KEY.
EMAIL_DOMAINS_RESEND_SENDING_KEY=
# Resend region for newly created domains: us-east-1, eu-west-1, sa-east-1, ap-northeast-1.
EMAIL_DOMAINS_REGION=us-east-1
# Sending domains one partner may hold.
EMAIL_DOMAINS_MAX_PER_PARTNER=3
# Partner-lane messages per partner per UTC day. 0 = unlimited (the self-hosted
# default). Over the cap a message goes out from EMAIL_FROM as it would today.
EMAIL_DOMAINS_DAILY_SEND_CAP=0
# Comma-separated partner ids. Empty means every eligible partner.
EMAIL_DOMAINS_PARTNER_ALLOWLIST=
# Extra domains nobody on this instance may add, comma-separated.
EMAIL_DOMAINS_DENYLIST=
# Delivery-webhook signing secret. Unset leaves the endpoint inert.
EMAIL_DOMAINS_WEBHOOK_SECRET=
```

Append to `deploy/.env.example` after `# SMTP_PASS=` (`:247`):

```
# ── Custom sender addresses (optional; off unless EMAIL_DOMAINS_PROVIDER is set) ──
# Hosted uses `resend` with a SEPARATE Resend team from RESEND_API_KEY — Resend
# enforces bounce/spam limits account-wide, so partner-domain mail must not
# share the account that carries password resets. `static` is refused when
# IS_HOSTED=true.
EMAIL_DOMAINS_PROVIDER=
EMAIL_DOMAINS_RESEND_API_KEY=
EMAIL_DOMAINS_RESEND_SENDING_KEY=
EMAIL_DOMAINS_REGION=us-east-1
EMAIL_DOMAINS_MAX_PER_PARTNER=3
EMAIL_DOMAINS_DAILY_SEND_CAP=2000
EMAIL_DOMAINS_PARTNER_ALLOWLIST=
EMAIL_DOMAINS_DENYLIST=
EMAIL_DOMAINS_STATIC_ALLOWED=
EMAIL_DOMAINS_WEBHOOK_SECRET=
```

Insert into `docker-compose.yml`'s `x-api-env: &api-env` anchor after
`MAILGUN_TIMEOUT_MS: ${MAILGUN_TIMEOUT_MS:-}` (`:420`), before the inbound
comment at `:421`:

```yaml
  # Custom sender addresses / partner sending domains. All optional; unset =
  # feature off. Compose interpolation only happens for vars listed here, so a
  # value in .env alone is inert.
  EMAIL_DOMAINS_PROVIDER: ${EMAIL_DOMAINS_PROVIDER:-}
  EMAIL_DOMAINS_STATIC_ALLOWED: ${EMAIL_DOMAINS_STATIC_ALLOWED:-}
  EMAIL_DOMAINS_RESEND_API_KEY: ${EMAIL_DOMAINS_RESEND_API_KEY:-}
  EMAIL_DOMAINS_RESEND_SENDING_KEY: ${EMAIL_DOMAINS_RESEND_SENDING_KEY:-}
  EMAIL_DOMAINS_REGION: ${EMAIL_DOMAINS_REGION:-}
  EMAIL_DOMAINS_MAX_PER_PARTNER: ${EMAIL_DOMAINS_MAX_PER_PARTNER:-}
  EMAIL_DOMAINS_DAILY_SEND_CAP: ${EMAIL_DOMAINS_DAILY_SEND_CAP:-}
  EMAIL_DOMAINS_PARTNER_ALLOWLIST: ${EMAIL_DOMAINS_PARTNER_ALLOWLIST:-}
  EMAIL_DOMAINS_DENYLIST: ${EMAIL_DOMAINS_DENYLIST:-}
  EMAIL_DOMAINS_WEBHOOK_SECRET: ${EMAIL_DOMAINS_WEBHOOK_SECRET:-}
```

Insert the identical ten lines into `deploy/docker-compose.prod.yml`'s
`x-api-env: &api-env` anchor after `MAILGUN_TIMEOUT_MS: ${MAILGUN_TIMEOUT_MS:-}`
(`:137`), before `ANTHROPIC_API_KEY` (`:138`). One insertion covers both the
`api` service (`<<: *api-env`, `:462`) and the `worker` service (`:520`).

- [ ] **Step 7: Pin the plumbing**

Add to `apps/api/src/config/envComposeParity.test.ts`, after the QuickBooks
describe (`:289`), copying its four-axis template:

```ts
/**
 * Partner sending domains (spec 2026-09-17 §11). Pinned on all four axes for
 * the same reason QBO_* is: a variable that validate.ts accepts but that no
 * compose file maps is a silent no-op — setting it in .env does nothing and the
 * feature just stays dark, which is indistinguishable from "not configured yet".
 */
describe('EMAIL_DOMAINS_* env plumbing (partner sending domains W02)', () => {
  const ROOT_COMPOSE = readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8');
  const PROD_COMPOSE = readFileSync(path.join(REPO_ROOT, 'deploy/docker-compose.prod.yml'), 'utf8');
  const EMAIL_DOMAINS_VARS = [
    'EMAIL_DOMAINS_PROVIDER',
    'EMAIL_DOMAINS_STATIC_ALLOWED',
    'EMAIL_DOMAINS_RESEND_API_KEY',
    'EMAIL_DOMAINS_RESEND_SENDING_KEY',
    'EMAIL_DOMAINS_REGION',
    'EMAIL_DOMAINS_MAX_PER_PARTNER',
    'EMAIL_DOMAINS_DAILY_SEND_CAP',
    'EMAIL_DOMAINS_PARTNER_ALLOWLIST',
    'EMAIL_DOMAINS_DENYLIST',
    'EMAIL_DOMAINS_WEBHOOK_SECRET',
  ] as const;

  it.each(EMAIL_DOMAINS_VARS)('%s is declared in the validate.ts schema', (name) => {
    expect(ENV_SCHEMA_KEYS).toContain(name);
  });

  it.each(EMAIL_DOMAINS_VARS)('%s is documented in the root .env.example', (name) => {
    expect(documentedEnvExampleVars('.env.example')).toContain(name);
  });

  it.each(EMAIL_DOMAINS_VARS)('%s is documented in deploy/.env.example', (name) => {
    expect(documentedEnvExampleVars('deploy/.env.example')).toContain(name);
  });

  it.each(EMAIL_DOMAINS_VARS)('%s reaches the api container in docker-compose.yml', (name) => {
    expect(isReferencedInCompose(name, ROOT_COMPOSE)).toBe(true);
  });

  it.each(EMAIL_DOMAINS_VARS)('%s reaches the api container in deploy/docker-compose.prod.yml', (name) => {
    expect(isReferencedInCompose(name, PROD_COMPOSE)).toBe(true);
  });
});
```

- [ ] **Step 8: Run everything and commit**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run src/config/validate.test.ts src/config/envComposeParity.test.ts src/config/composeBindMounts.test.ts src/services/emailDomains/config.test.ts src/services/emailDomains/domainPolicy.test.ts
```
Expected: all PASS. `composeBindMounts.test.ts` is unaffected (it walks
`services[*].volumes`, never `environment:`) — run it anyway to prove the
compose edits did not break YAML parsing.

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/api/src/config/validate.ts apps/api/src/config/validate.test.ts apps/api/src/config/envComposeParity.test.ts apps/api/src/services/emailDomains/config.ts apps/api/src/services/emailDomains/config.test.ts apps/api/src/services/emailDomains/domainPolicy.ts .env.example deploy/.env.example docker-compose.yml deploy/docker-compose.prod.yml
git commit -m "feat(api): EMAIL_DOMAINS_* configuration, boot rules and compose plumbing

Ten optional variables (spec §11). Every requireIf is keyed on
EMAIL_DOMAINS_PROVIDER, never on EMAIL_PROVIDER, so a Resend self-host that
upgrades is never asked for a partner-lane key. fake is refused in production,
static when IS_HOSTED=true, and an EMAIL_DOMAINS_RESEND_API_KEY identical to
RESEND_API_KEY when hosted — self-hosted gets one informational line instead.
Mapped in BOTH compose files; envComposeParity pins all four axes.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 6: Provider interface and registry

**Files:**
- Create: `apps/api/src/services/emailDomains/provider.ts`
- Create: `apps/api/src/services/emailDomains/providerRegistry.ts`
- Create: `apps/api/src/services/emailDomains/providerRegistry.test.ts`

**Interfaces:**
- Produces: spec §5's types verbatim (`SendingDomainStatus`, `ProviderDnsRecord`,
  `ProviderDomain`, `PartnerLaneSendError`, `EmailDomainProvider`), plus
  `PartnerLaneMessage = RawEmailMessage`,
  `class PartnerLaneSendFailure extends Error { readonly error: PartnerLaneSendError }`,
  `class ProviderDomainConflictError`, `class ProviderDomainRejectedError`,
  `getEmailDomainProvider(): EmailDomainProvider | null`,
  `resetEmailDomainProviderForTests(): void`.
- Consumes: `RawEmailMessage` and `PartnerMailStream` from **W01** (`services/email.ts`,
  `services/emailDomains/mailPurposes.ts`), `getEmailDomainsConfig()` (Task 5),
  the three adapter factories (Tasks 7-8 — write this task's registry with the
  imports in place and implement the adapters next; the registry test is skipped
  until then, see Step 3).
- **Explicitly NOT produced here:** the find-then-create classification of spec
  §5.1 (the four cases: nothing found → create; found with a provider
  `createdAt` newer than `provision_attempted_at` → ours from a crashed attempt;
  found and older → pre-existing, `provider_managed = false`; ambiguous →
  not managed). That is **orchestration, and W03's `syncSendingDomain` performs
  it** using `findDomainByName`, `createDomain` and `ProviderDomain.createdAt`.
  W02's only obligation is that the adapter methods return what that logic
  needs: `findDomainByName` returns `null` when the provider has no such domain
  and a `ProviderDomain` with a populated `createdAt` when it does (or
  `createdAt: undefined` when the provider does not report one, which W03 must
  treat as the ambiguous case → `provider_managed = false`).

- [ ] **Step 1: Write `provider.ts`**

```ts
import type { RawEmailMessage } from '../email';
import type { PartnerMailStream } from './mailPurposes';
import { PARTNER_MAIL_STREAMS } from '@breeze/shared';

/**
 * Provider-neutral sending-domain interface (spec §5).
 *
 * Adapters are PURE with respect to Breeze's database: they never read or write
 * a table. They take what they need as arguments and return provider facts.
 * Orchestration — which row moves to which status, when to create versus adopt
 * — belongs to W03's syncSendingDomain.
 */

/** Compile-time parity: @breeze/shared's PARTNER_MAIL_STREAMS must equal W01's union. */
type _StreamParity =
  PartnerMailStream extends (typeof PARTNER_MAIL_STREAMS)[number]
    ? ((typeof PARTNER_MAIL_STREAMS)[number] extends PartnerMailStream ? true : never)
    : never;
const _streamParity: _StreamParity = true;
void _streamParity;

export type SendingDomainStatus =
  | 'provisioning' | 'pending' | 'verified' | 'at_risk'
  | 'failed' | 'suspended' | 'removing';

export interface ProviderDnsRecord {
  purpose: 'dkim' | 'spf' | 'return_path_mx' | 'other';
  type: 'TXT' | 'CNAME' | 'MX';
  host: string;        // as the provider returns it (relative label)
  fqdn: string;        // computed: what must resolve
  value: string;
  priority?: number;
  ttl?: string;
  status: 'pending' | 'verified' | 'failed';
}

export interface ProviderDomain {
  providerDomainId: string | null;   // null for `static`
  region?: string;
  /**
   * Provider-side creation time, when the provider reports one. W03 compares
   * it with the row's committed `provision_attempted_at` to tell "ours from a
   * crashed attempt" from "pre-existing" (§5.1 cases 3 and 4). `undefined` is
   * the AMBIGUOUS case and must resolve to provider_managed = false: leaking a
   * provider domain is recoverable, deleting someone's mail domain is not.
   */
  createdAt?: Date;
  state: 'pending' | 'verified' | 'at_risk' | 'failed';
  records: ProviderDnsRecord[];      // empty for `static`
}

export type PartnerLaneSendError =
  | { kind: 'domain_unusable' }                    // provider says the domain cannot send
  | { kind: 'lane_unavailable' }                   // 429, account paused, quota
  | { kind: 'message_rejected'; detail: string }   // bad recipient, too large
  | { kind: 'ambiguous'; detail: string };         // timeout, 5xx, network

/**
 * Plan-index amendment 3: the spec types the error as a union and says `send`
 * "throws" it. A union cannot be thrown usefully, so adapters throw this class
 * and callers read `.error`.
 */
export class PartnerLaneSendFailure extends Error {
  constructor(readonly error: PartnerLaneSendError) {
    super(`partner lane send failed: ${error.kind}`);
    this.name = 'PartnerLaneSendFailure';
  }
}

/** The provider already holds this name (or another team does). → `failed`/`provider_conflict`. */
export class ProviderDomainConflictError extends Error {
  constructor(readonly domain: string, message?: string) {
    super(message ?? `provider already holds ${domain}`);
    this.name = 'ProviderDomainConflictError';
  }
}

/** The provider refused the request outright. → `failed`/`provider_rejected`. */
export class ProviderDomainRejectedError extends Error {
  constructor(readonly domain: string, message?: string) {
    super(message ?? `provider refused ${domain}`);
    this.name = 'ProviderDomainRejectedError';
  }
}

/** W01's raw message shape. The partner lane never builds its own envelope. */
export type PartnerLaneMessage = RawEmailMessage;

export interface CreateProviderDomainInput {
  domain: string;
  region?: string;
  /** The partner id. Resend tags with it; SES will map it to tenant `bz-<id>`. */
  partnerRef: string;
  /**
   * Plan amendment 4: the partner's slug. Only `static` uses it, to honour a
   * `domain:partner-slug` binding in EMAIL_DOMAINS_STATIC_ALLOWED. `resend` and
   * `ses` ignore it.
   */
  partnerSlug?: string | null;
}

export interface EmailDomainProvider {
  readonly id: 'resend' | 'ses' | 'static' | 'fake';
  /** false for `static`: no wizard, no DNS records, no polling for verification. */
  readonly verifiesByDns: boolean;
  createDomain(i: CreateProviderDomainInput): Promise<ProviderDomain>;
  findDomainByName(domain: string): Promise<ProviderDomain | null>;
  /**
   * `static` has no provider object, so its key is the DOMAIN NAME and this
   * method delegates to findDomainByName (plan amendment 5). Every other
   * adapter takes its provider domain id.
   */
  getDomain(providerDomainId: string): Promise<ProviderDomain>;
  requestVerification(providerDomainId: string): Promise<void>;
  /** A 404 from the provider is SUCCESS: the domain is already gone. */
  deleteDomain(providerDomainId: string): Promise<void>;
  /** Drift report only (hosted). `static` returns []. */
  listDomains(): Promise<Array<{ providerDomainId: string; domain: string }>>;
  /**
   * Throws PartnerLaneSendFailure. `tags` always carries partner_id, domain_id,
   * stream and purpose so delivery webhooks can attribute events (§9.3).
   */
  send(m: PartnerLaneMessage & { partnerRef: string; tags: Record<string, string> }):
    Promise<{ providerMessageId: string }>;
}
```

- [ ] **Step 2: Write the failing registry test**

`apps/api/src/services/emailDomains/providerRegistry.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getEmailDomainProvider, resetEmailDomainProviderForTests } from './providerRegistry';

const KEYS = ['EMAIL_DOMAINS_PROVIDER', 'EMAIL_DOMAINS_RESEND_API_KEY', 'IS_HOSTED'];
const SAVED: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) { SAVED[k] = process.env[k]; delete process.env[k]; }
  resetEmailDomainProviderForTests();
});
afterEach(() => {
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]!;
  }
  resetEmailDomainProviderForTests();
});

describe('getEmailDomainProvider', () => {
  it('returns null when EMAIL_DOMAINS_PROVIDER is unset — the switch that keeps W02 dark', () => {
    expect(getEmailDomainProvider()).toBeNull();
  });

  it('returns null for an empty string', () => {
    process.env.EMAIL_DOMAINS_PROVIDER = '';
    expect(getEmailDomainProvider()).toBeNull();
  });

  it('returns the fake adapter', () => {
    process.env.EMAIL_DOMAINS_PROVIDER = 'fake';
    const provider = getEmailDomainProvider();
    expect(provider?.id).toBe('fake');
    expect(provider?.verifiesByDns).toBe(true);
  });

  it('returns the static adapter, which does not verify by DNS', () => {
    process.env.EMAIL_DOMAINS_PROVIDER = 'static';
    const provider = getEmailDomainProvider();
    expect(provider?.id).toBe('static');
    expect(provider?.verifiesByDns).toBe(false);
  });

  it('returns the resend adapter when a key is present', () => {
    process.env.EMAIL_DOMAINS_PROVIDER = 'resend';
    process.env.EMAIL_DOMAINS_RESEND_API_KEY = 're_full';
    const provider = getEmailDomainProvider();
    expect(provider?.id).toBe('resend');
    expect(provider?.verifiesByDns).toBe(true);
  });

  it('returns null for resend WITHOUT a key instead of constructing a client that throws', () => {
    // `new Resend(undefined)` throws from the SDK constructor. Boot validation
    // already refuses this combination in production; a non-validating
    // entrypoint must degrade to "unsupported", never crash on first use.
    process.env.EMAIL_DOMAINS_PROVIDER = 'resend';
    expect(getEmailDomainProvider()).toBeNull();
  });

  it('caches the instance and resets on demand', () => {
    process.env.EMAIL_DOMAINS_PROVIDER = 'fake';
    const first = getEmailDomainProvider();
    expect(getEmailDomainProvider()).toBe(first);
    resetEmailDomainProviderForTests();
    expect(getEmailDomainProvider()).not.toBe(first);
  });
});
```

Run: `cd apps/api && npx vitest run src/services/emailDomains/providerRegistry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the registry**

`apps/api/src/services/emailDomains/providerRegistry.ts`:

```ts
import { getEmailDomainsConfig } from './config';
import type { EmailDomainProvider } from './provider';
import { createResendDomainProvider } from './adapters/resend';
import { createStaticDomainProvider } from './adapters/static';
import { createFakeDomainProvider } from './adapters/fake';

/**
 * The single switch that keeps this wave dark: with EMAIL_DOMAINS_PROVIDER
 * unset this returns null, the settings tab is hidden, the routes 404 and the
 * worker is never registered.
 *
 * `undefined` = not yet resolved; `null` = resolved to "no provider". The
 * distinction matters because null is a legitimate cached answer.
 */
let cached: EmailDomainProvider | null | undefined;

export function getEmailDomainProvider(): EmailDomainProvider | null {
  if (cached !== undefined) return cached;
  const config = getEmailDomainsConfig();
  switch (config.provider) {
    case 'resend':
      // No key => degrade to "unsupported" rather than constructing a Resend
      // client, whose constructor throws on a missing key. config/validate.ts
      // already refuses this combination in production.
      cached = config.resendApiKey ? createResendDomainProvider() : null;
      break;
    case 'static':
      cached = createStaticDomainProvider();
      break;
    case 'fake':
      cached = createFakeDomainProvider();
      break;
    default:
      cached = null;
  }
  return cached;
}

export function resetEmailDomainProviderForTests(): void {
  cached = undefined;
}
```

This file does not compile until Tasks 7 and 8 land the three adapter modules.
Write it now, leave the test red on the missing adapter imports, and turn it
green at the end of Task 8.

- [ ] **Step 4: Commit the interface**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/api/src/services/emailDomains/provider.ts apps/api/src/services/emailDomains/providerRegistry.ts apps/api/src/services/emailDomains/providerRegistry.test.ts
git commit -m "feat(api): EmailDomainProvider interface and provider registry

Spec §5 types verbatim, plus PartnerLaneMessage = RawEmailMessage and the
PartnerLaneSendFailure carrier class (plan index amendment 3). The registry
returns null when EMAIL_DOMAINS_PROVIDER is unset — the one switch that keeps
this wave dark. Adapters land in the next two commits.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 7: The `resend` adapter

Written against the **installed** SDK, `resend@6.18.0` (`apps/api/package.json:101`
declares `^6.18.0`; `pnpm-lock.yaml:10605` pins `resend@6.18.0`). Facts taken
from `node_modules/resend/dist/index.d.mts` and verified before writing:

- `domains.create(payload: CreateDomainOptions)` takes **camelCase**
  `{ name, region?, customReturnPath?, … }` (`:1281-1290`). The snake_case
  `custom_return_path` is the internal wire type (`DomainApiOptions`, `:108-118`)
  and must **not** be passed.
- `DomainRegion = 'us-east-1' | 'eu-west-1' | 'sa-east-1' | 'ap-northeast-1'` (`:38`).
- `DomainStatus = 'pending' | 'verified' | 'failed' | 'not_started' | 'partially_verified' | 'partially_failed'` (`:94`) — **no `temporary_failure`** at domain level in this SDK version, though the API returns it (plan amendment 8).
- Records are a discriminated union on `record`: `'SPF' | 'DKIM' | 'Receiving' | 'Tracking' | 'TrackingCAA'`, with `type` `'MX'|'TXT'|'CNAME'|'CAA'`, `ttl: string` (not a number) and `priority` required only on `Receiving` (`:45-92`).
- `domains.verify(id)` returns **only the id** (`VerifyDomainsResponseSuccess`, `:1336-1339`) — it does not return the updated status, so a caller that needs one follows with `getDomain`.
- `domains.list()` returns `{ data: { data: Domain[], object, has_more } }` and the per-domain rows carry **no `records[]`** (`:1306-1313`, `:96-106`).
- The SDK **returns** errors, it never throws (except `new Resend(undefined)`): every call resolves to `{ data, error, headers }` with `ErrorResponse = { message: string; statusCode: number | null; name: RESEND_ERROR_CODE_KEY }` (`:120-139`). A network failure yields `statusCode: null` with `name: 'application_error'`, which is **indistinguishable by name** from a server 5xx — so the classifier keys on `statusCode` too.

**Files:**
- Create: `apps/api/src/services/emailDomains/adapters/resend.ts`
- Create: `apps/api/src/services/emailDomains/adapters/resendSendErrorFixtures.ts`
- Create: `apps/api/src/services/emailDomains/adapters/resend.test.ts`

**Interfaces:**
- Produces: `createResendDomainProvider(): EmailDomainProvider`,
  `mapResendDomainStatus(raw: string): ProviderDomain['state']`,
  `normalizeResendRecords(domain: string, records: unknown[]): ProviderDnsRecord[]`,
  `classifyResendSendError(error: { name: string; statusCode: number | null; message: string }): PartnerLaneSendError`,
  `RESEND_SEND_ERROR_FIXTURES`.
- Consumes: `Resend` (`resend`), `getEmailDomainsConfig()` (Task 5), the Task 6 types.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/emailDomains/adapters/resend.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const domainsCreate = vi.fn();
const domainsGet = vi.fn();
const domainsVerify = vi.fn();
const domainsRemove = vi.fn();
const domainsList = vi.fn();
const emailsSend = vi.fn();

vi.mock('resend', () => ({
  Resend: class {
    constructor(public readonly key?: string) {}
    domains = { create: domainsCreate, get: domainsGet, verify: domainsVerify, remove: domainsRemove, list: domainsList };
    emails = { send: emailsSend };
  }
}));

import {
  createResendDomainProvider,
  mapResendDomainStatus,
  normalizeResendRecords,
  classifyResendSendError,
  RESEND_SEND_ERROR_FIXTURES
} from './resend';
import { PartnerLaneSendFailure, ProviderDomainConflictError } from '../provider';

const KEYS = ['EMAIL_DOMAINS_RESEND_API_KEY', 'EMAIL_DOMAINS_RESEND_SENDING_KEY', 'EMAIL_DOMAINS_REGION'];
const SAVED: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const fn of [domainsCreate, domainsGet, domainsVerify, domainsRemove, domainsList, emailsSend]) fn.mockReset();
  for (const k of KEYS) { SAVED[k] = process.env[k]; delete process.env[k]; }
  process.env.EMAIL_DOMAINS_RESEND_API_KEY = 're_full';
});
afterEach(() => {
  for (const k of KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]!; }
});

describe('mapResendDomainStatus (spec §5.2)', () => {
  it.each([
    ['not_started', 'pending'],
    ['pending', 'pending'],
    ['verified', 'verified'],
    ['partially_verified', 'verified'],
    ['temporary_failure', 'at_risk'],
    ['partially_failed', 'at_risk'],
    ['failed', 'failed']
  ] as const)('maps %s -> %s', (raw, expected) => {
    expect(mapResendDomainStatus(raw)).toBe(expected);
  });

  it('maps an UNKNOWN status to pending and warns — the unknown case never sends', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(mapResendDomainStatus('brand_new_status')).toBe('pending');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('brand_new_status');
    warn.mockRestore();
  });
});

describe('normalizeResendRecords', () => {
  it('computes fqdn from a relative label and classifies purposes', () => {
    const records = normalizeResendRecords('acme.com', [
      { record: 'DKIM', name: 'resend._domainkey', type: 'CNAME', ttl: 'Auto', status: 'pending', value: 'x.dkim.amazonses.com' },
      { record: 'SPF', name: 'send', type: 'TXT', ttl: 'Auto', status: 'verified', value: 'v=spf1 include:amazonses.com ~all' },
      { record: 'SPF', name: 'send', type: 'MX', ttl: 'Auto', status: 'verified', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 }
    ]);
    expect(records).toEqual([
      { purpose: 'dkim', type: 'CNAME', host: 'resend._domainkey', fqdn: 'resend._domainkey.acme.com', value: 'x.dkim.amazonses.com', ttl: 'Auto', status: 'pending' },
      { purpose: 'spf', type: 'TXT', host: 'send', fqdn: 'send.acme.com', value: 'v=spf1 include:amazonses.com ~all', ttl: 'Auto', status: 'verified' },
      { purpose: 'return_path_mx', type: 'MX', host: 'send', fqdn: 'send.acme.com', value: 'feedback-smtp.us-east-1.amazonses.com', ttl: 'Auto', priority: 10, status: 'verified' }
    ]);
  });

  it('does not double-suffix a host the provider already returned as an FQDN', () => {
    const [record] = normalizeResendRecords('acme.com', [
      { record: 'DKIM', name: 'resend._domainkey.acme.com', type: 'CNAME', ttl: 'Auto', status: 'pending', value: 'x' }
    ]);
    expect(record!.fqdn).toBe('resend._domainkey.acme.com');
  });

  it('treats an empty or @ host as the apex', () => {
    expect(normalizeResendRecords('acme.com', [{ record: 'SPF', name: '@', type: 'TXT', ttl: 'Auto', status: 'pending', value: 'v=spf1' }])[0]!.fqdn).toBe('acme.com');
    expect(normalizeResendRecords('acme.com', [{ record: 'SPF', name: '', type: 'TXT', ttl: 'Auto', status: 'pending', value: 'v=spf1' }])[0]!.fqdn).toBe('acme.com');
  });

  it('collapses not_started and temporary_failure record statuses onto pending', () => {
    const records = normalizeResendRecords('acme.com', [
      { record: 'DKIM', name: 'a', type: 'CNAME', ttl: 'Auto', status: 'not_started', value: 'x' },
      { record: 'DKIM', name: 'b', type: 'CNAME', ttl: 'Auto', status: 'temporary_failure', value: 'y' }
    ]);
    expect(records.map((r) => r.status)).toEqual(['pending', 'pending']);
  });

  it('drops a record whose type we cannot publish in the UI (CAA tracking record)', () => {
    expect(normalizeResendRecords('acme.com', [
      { record: 'TrackingCAA', name: 'x', type: 'CAA', ttl: 'Auto', status: 'pending', value: 'z' }
    ])).toEqual([]);
  });

  it('survives a malformed record without throwing', () => {
    expect(normalizeResendRecords('acme.com', [null, 42, { nope: true }])).toEqual([]);
  });
});

describe('createDomain', () => {
  it('sends camelCase customReturnPath-free payload with name + region and returns the mapped domain', async () => {
    process.env.EMAIL_DOMAINS_REGION = 'eu-west-1';
    domainsCreate.mockResolvedValue({
      data: {
        id: 'dom_1', name: 'acme.com', status: 'not_started', region: 'eu-west-1',
        created_at: '2026-09-17T10:00:00.000Z',
        records: [{ record: 'DKIM', name: 'resend._domainkey', type: 'CNAME', ttl: 'Auto', status: 'not_started', value: 'x' }]
      },
      error: null
    });
    const result = await createResendDomainProvider().createDomain({ domain: 'acme.com', partnerRef: 'p1' });
    expect(domainsCreate).toHaveBeenCalledWith({ name: 'acme.com', region: 'eu-west-1' });
    expect(result).toEqual({
      providerDomainId: 'dom_1',
      region: 'eu-west-1',
      createdAt: new Date('2026-09-17T10:00:00.000Z'),
      state: 'pending',
      records: [{ purpose: 'dkim', type: 'CNAME', host: 'resend._domainkey', fqdn: 'resend._domainkey.acme.com', value: 'x', ttl: 'Auto', status: 'pending' }]
    });
  });

  it('falls back to us-east-1 when EMAIL_DOMAINS_REGION is unset', async () => {
    domainsCreate.mockResolvedValue({ data: { id: 'd', name: 'acme.com', status: 'pending', region: 'us-east-1', created_at: '2026-09-17T10:00:00.000Z', records: [] }, error: null });
    await createResendDomainProvider().createDomain({ domain: 'acme.com', partnerRef: 'p1' });
    expect(domainsCreate).toHaveBeenCalledWith({ name: 'acme.com', region: 'us-east-1' });
  });

  it('refuses an unrecognised region rather than sending it', async () => {
    process.env.EMAIL_DOMAINS_REGION = 'mars-1';
    await expect(createResendDomainProvider().createDomain({ domain: 'acme.com', partnerRef: 'p1' }))
      .rejects.toThrow(/mars-1/);
    expect(domainsCreate).not.toHaveBeenCalled();
  });

  it('raises a conflict when the provider says the domain already exists', async () => {
    domainsCreate.mockResolvedValue({ data: null, error: { name: 'validation_error', statusCode: 422, message: 'A domain with this name already exists.' } });
    await expect(createResendDomainProvider().createDomain({ domain: 'acme.com', partnerRef: 'p1' }))
      .rejects.toBeInstanceOf(ProviderDomainConflictError);
  });

  it('raises a rejection for any other provider error', async () => {
    domainsCreate.mockResolvedValue({ data: null, error: { name: 'invalid_parameter', statusCode: 400, message: 'bad name' } });
    await expect(createResendDomainProvider().createDomain({ domain: 'acme.com', partnerRef: 'p1' }))
      .rejects.toThrow(/bad name/);
  });
});

describe('findDomainByName', () => {
  it('returns null when the account holds no such domain', async () => {
    domainsList.mockResolvedValue({ data: { data: [{ id: 'd1', name: 'other.com', status: 'verified', region: 'us-east-1', created_at: '2026-01-01T00:00:00.000Z' }], object: 'list', has_more: false }, error: null });
    expect(await createResendDomainProvider().findDomainByName('acme.com')).toBeNull();
  });

  it('fetches the full record set with get() — list() does not return records', async () => {
    domainsList.mockResolvedValue({ data: { data: [{ id: 'd1', name: 'acme.com', status: 'verified', region: 'us-east-1', created_at: '2026-01-01T00:00:00.000Z' }], object: 'list', has_more: false }, error: null });
    domainsGet.mockResolvedValue({ data: { id: 'd1', object: 'domain', name: 'acme.com', status: 'verified', region: 'us-east-1', created_at: '2026-01-01T00:00:00.000Z', records: [] }, error: null });
    const found = await createResendDomainProvider().findDomainByName('acme.com');
    expect(domainsGet).toHaveBeenCalledWith('d1');
    expect(found).toEqual({ providerDomainId: 'd1', region: 'us-east-1', createdAt: new Date('2026-01-01T00:00:00.000Z'), state: 'verified', records: [] });
  });

  it('matches case-insensitively', async () => {
    domainsList.mockResolvedValue({ data: { data: [{ id: 'd1', name: 'ACME.com', status: 'pending', region: 'us-east-1', created_at: '2026-01-01T00:00:00.000Z' }], object: 'list', has_more: false }, error: null });
    domainsGet.mockResolvedValue({ data: { id: 'd1', name: 'ACME.com', status: 'pending', region: 'us-east-1', created_at: '2026-01-01T00:00:00.000Z', records: [] }, error: null });
    expect(await createResendDomainProvider().findDomainByName('acme.com')).not.toBeNull();
  });

  it('propagates a list failure instead of reporting "not found"', async () => {
    // Reporting null here would make W03 CREATE a domain that already exists.
    domainsList.mockResolvedValue({ data: null, error: { name: 'restricted_api_key', statusCode: 401, message: 'This API key is restricted to only send emails.' } });
    await expect(createResendDomainProvider().findDomainByName('acme.com')).rejects.toThrow(/restricted/i);
  });
});

describe('deleteDomain', () => {
  it('succeeds', async () => {
    domainsRemove.mockResolvedValue({ data: { id: 'd1', object: 'domain', deleted: true }, error: null });
    await expect(createResendDomainProvider().deleteDomain('d1')).resolves.toBeUndefined();
  });
  it('treats not_found as success — the domain is already gone', async () => {
    domainsRemove.mockResolvedValue({ data: null, error: { name: 'not_found', statusCode: 404, message: 'Domain not found' } });
    await expect(createResendDomainProvider().deleteDomain('d1')).resolves.toBeUndefined();
  });
  it('throws on any other error', async () => {
    domainsRemove.mockResolvedValue({ data: null, error: { name: 'application_error', statusCode: 500, message: 'boom' } });
    await expect(createResendDomainProvider().deleteDomain('d1')).rejects.toThrow(/boom/);
  });
});

describe('requestVerification', () => {
  it('calls verify and ignores its id-only response', async () => {
    domainsVerify.mockResolvedValue({ data: { id: 'd1', object: 'domain' }, error: null });
    await expect(createResendDomainProvider().requestVerification('d1')).resolves.toBeUndefined();
    expect(domainsVerify).toHaveBeenCalledWith('d1');
  });
  it('throws on error', async () => {
    domainsVerify.mockResolvedValue({ data: null, error: { name: 'not_found', statusCode: 404, message: 'nope' } });
    await expect(createResendDomainProvider().requestVerification('d1')).rejects.toThrow(/nope/);
  });
});

describe('send', () => {
  const message = {
    from: 'support@acme.com', to: 'customer@example.com', subject: 'Ticket #1',
    html: '<p>hi</p>', text: 'hi', partnerRef: 'p1',
    tags: { partner_id: 'p1', domain_id: 'd1', stream: 'support', purpose: 'ticket_customer_notification' }
  };

  it('maps tags into Resend name/value pairs and returns the message id', async () => {
    emailsSend.mockResolvedValue({ data: { id: 'msg_1' }, error: null });
    const result = await createResendDomainProvider().send(message);
    expect(result).toEqual({ providerMessageId: 'msg_1' });
    const payload = emailsSend.mock.calls[0]![0];
    expect(payload.from).toBe('support@acme.com');
    expect(payload.tags).toEqual([
      { name: 'partner_id', value: 'p1' },
      { name: 'domain_id', value: 'd1' },
      { name: 'stream', value: 'support' },
      { name: 'purpose', value: 'ticket_customer_notification' }
    ]);
  });

  it('sanitises tag values to the charset Resend accepts (letters, digits, _ and -)', async () => {
    emailsSend.mockResolvedValue({ data: { id: 'msg_1' }, error: null });
    await createResendDomainProvider().send({ ...message, tags: { purpose: 'ticket.customer_notification', domain: 'acme.com' } });
    expect(emailsSend.mock.calls[0]![0].tags).toEqual([
      { name: 'purpose', value: 'ticket_customer_notification' },
      { name: 'domain', value: 'acme_com' }
    ]);
  });

  it('throws PartnerLaneSendFailure carrying the classified error', async () => {
    emailsSend.mockResolvedValue({ data: null, error: { name: 'rate_limit_exceeded', statusCode: 429, message: 'Too many requests' } });
    await expect(createResendDomainProvider().send(message)).rejects.toBeInstanceOf(PartnerLaneSendFailure);
    await expect(createResendDomainProvider().send(message)).rejects.toMatchObject({ error: { kind: 'lane_unavailable' } });
  });
});

describe('classifyResendSendError', () => {
  it.each([
    [{ name: 'invalid_from_address', statusCode: 422, message: 'The from address is not valid.' }, 'domain_unusable'],
    [{ name: 'validation_error', statusCode: 403, message: 'The acme.com domain is not verified. Please verify your domain.' }, 'domain_unusable'],
    [{ name: 'not_found', statusCode: 404, message: 'Domain not found' }, 'domain_unusable'],
    [{ name: 'rate_limit_exceeded', statusCode: 429, message: 'Too many requests' }, 'lane_unavailable'],
    [{ name: 'daily_quota_exceeded', statusCode: 429, message: 'Daily quota reached' }, 'lane_unavailable'],
    [{ name: 'monthly_quota_exceeded', statusCode: 429, message: 'Monthly quota reached' }, 'lane_unavailable'],
    [{ name: 'restricted_api_key', statusCode: 401, message: 'restricted' }, 'lane_unavailable'],
    [{ name: 'invalid_api_key', statusCode: 401, message: 'bad key' }, 'lane_unavailable'],
    [{ name: 'missing_api_key', statusCode: 401, message: 'no key' }, 'lane_unavailable'],
    [{ name: 'security_error', statusCode: 451, message: 'account paused' }, 'lane_unavailable'],
    [{ name: 'validation_error', statusCode: 422, message: 'to must be a valid email' }, 'message_rejected'],
    [{ name: 'invalid_parameter', statusCode: 400, message: 'subject too long' }, 'message_rejected'],
    [{ name: 'missing_required_field', statusCode: 422, message: 'subject is required' }, 'message_rejected'],
    [{ name: 'invalid_attachment', statusCode: 422, message: 'attachment too large' }, 'message_rejected'],
    [{ name: 'application_error', statusCode: 500, message: 'Internal server error' }, 'ambiguous'],
    [{ name: 'internal_server_error', statusCode: 500, message: 'boom' }, 'ambiguous'],
    // statusCode === null is the SDK's "never reached Resend" signal.
    [{ name: 'application_error', statusCode: null, message: 'Unable to fetch data. The request could not be resolved.' }, 'ambiguous'],
    [{ name: 'brand_new_error_code', statusCode: 418, message: 'who knows' }, 'ambiguous']
  ] as const)('classifies %j as %s', (error, kind) => {
    expect(classifyResendSendError(error as never).kind).toBe(kind);
  });

  it('checks the domain-refusal text BEFORE the validation_error rule, so a not-verified refusal falls back instead of being lost', () => {
    expect(classifyResendSendError({ name: 'validation_error', statusCode: 403, message: 'The domain is not verified.' }).kind).toBe('domain_unusable');
  });

  it('classifies every recorded fixture to its recorded kind', () => {
    for (const fixture of RESEND_SEND_ERROR_FIXTURES) {
      expect(classifyResendSendError(fixture.error), fixture.label).toMatchObject({ kind: fixture.expectedKind });
    }
  });
});
```

Run: `cd apps/api && npx vitest run src/services/emailDomains/adapters/resend.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2: Write the fixture module**

`apps/api/src/services/emailDomains/adapters/resendSendErrorFixtures.ts`:

```ts
import type { PartnerLaneSendError } from '../provider';

/**
 * Recorded Resend send-error shapes.
 *
 * Spec §0.2 lists the exact error Resend returns for a send from an unverified
 * domain as NOT VERIFIED against the live API. These entries are the best
 * current reading of the SDK's error codes; W03's lab step (a real send from a
 * pending domain on the partner-lane account) REPLACES the `error` payloads
 * below with what the API actually returned and, if a classification is wrong,
 * fixes classifyResendSendError rather than the expectation.
 *
 * `source: 'observed'` means someone recorded it from a live call.
 */
export interface ResendSendErrorFixture {
  label: string;
  source: 'assumed' | 'observed';
  error: { name: string; statusCode: number | null; message: string };
  expectedKind: PartnerLaneSendError['kind'];
}

export const RESEND_SEND_ERROR_FIXTURES: readonly ResendSendErrorFixture[] = [
  {
    label: 'send from a domain that has not verified yet',
    source: 'assumed',
    error: { name: 'validation_error', statusCode: 403, message: 'The acme.com domain is not verified. Please, add and verify your domain on https://resend.com/domains' },
    expectedKind: 'domain_unusable'
  },
  {
    label: 'send from a domain that is not in the account at all',
    source: 'assumed',
    error: { name: 'validation_error', statusCode: 403, message: 'You can only send testing emails to your own email address. To send emails to other recipients, please verify a domain.' },
    expectedKind: 'domain_unusable'
  },
  {
    label: 'malformed From header',
    source: 'assumed',
    error: { name: 'invalid_from_address', statusCode: 422, message: 'Invalid `from` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.' },
    expectedKind: 'domain_unusable'
  },
  {
    label: 'account rate limit (10 req/s per team)',
    source: 'assumed',
    error: { name: 'rate_limit_exceeded', statusCode: 429, message: 'Too many requests. You can only make 10 requests per second.' },
    expectedKind: 'lane_unavailable'
  },
  {
    label: 'daily quota exhausted',
    source: 'assumed',
    error: { name: 'daily_quota_exceeded', statusCode: 429, message: 'You have reached your daily email sending quota.' },
    expectedKind: 'lane_unavailable'
  },
  {
    label: 'sending-only key used for a management call',
    source: 'assumed',
    error: { name: 'restricted_api_key', statusCode: 401, message: 'This API key is restricted to only send emails.' },
    expectedKind: 'lane_unavailable'
  },
  {
    label: 'bad recipient address',
    source: 'assumed',
    error: { name: 'validation_error', statusCode: 422, message: 'Invalid `to` field. Please use the correct email format.' },
    expectedKind: 'message_rejected'
  },
  {
    label: 'attachment over the size limit',
    source: 'assumed',
    error: { name: 'invalid_attachment', statusCode: 422, message: 'Attachment is too large.' },
    expectedKind: 'message_rejected'
  },
  {
    label: 'provider 5xx',
    source: 'assumed',
    error: { name: 'application_error', statusCode: 500, message: 'Internal server error. We are unable to process your request right now, please try again later.' },
    expectedKind: 'ambiguous'
  },
  {
    label: 'network failure — the SDK reports statusCode null, never reached Resend',
    source: 'assumed',
    error: { name: 'application_error', statusCode: null, message: 'Unable to fetch data. The request could not be resolved.' },
    expectedKind: 'ambiguous'
  }
];
```

- [ ] **Step 3: Write the adapter**

`apps/api/src/services/emailDomains/adapters/resend.ts`:

```ts
import { Resend } from 'resend';
import { getEmailDomainsConfig } from '../config';
import {
  PartnerLaneSendFailure,
  ProviderDomainConflictError,
  ProviderDomainRejectedError,
  type CreateProviderDomainInput,
  type EmailDomainProvider,
  type PartnerLaneMessage,
  type PartnerLaneSendError,
  type ProviderDnsRecord,
  type ProviderDomain
} from '../provider';

export { RESEND_SEND_ERROR_FIXTURES } from './resendSendErrorFixtures';
import { RESEND_SEND_ERROR_FIXTURES as _fixtures } from './resendSendErrorFixtures';
void _fixtures;

/** The four regions the SDK's DomainRegion union allows (index.d.mts:38). */
const RESEND_REGIONS = ['us-east-1', 'eu-west-1', 'sa-east-1', 'ap-northeast-1'] as const;
type ResendRegion = (typeof RESEND_REGIONS)[number];

interface ResendErrorShape { name: string; statusCode: number | null; message: string }

/**
 * Spec §5.2, keyed on whether SENDING is usable.
 *
 * `temporary_failure` is not in resend@6.18.0's DomainStatus union — it only
 * appears on DomainRecordStatus — but the live API does return it at domain
 * level (spec §0.2), so it is matched as a runtime string. Anything unknown
 * maps to `pending` and warns: the unknown case must never send.
 */
export function mapResendDomainStatus(raw: string): ProviderDomain['state'] {
  switch (raw) {
    case 'not_started':
    case 'pending':
      return 'pending';
    case 'verified':
    case 'partially_verified':
      return 'verified';
    case 'temporary_failure':
    case 'partially_failed':
      return 'at_risk';
    case 'failed':
      return 'failed';
    default:
      console.warn(`[emailDomains/resend] Unknown domain status ${JSON.stringify(raw)}; treating as pending so it cannot send.`);
      return 'pending';
  }
}

function mapRecordStatus(raw: unknown): ProviderDnsRecord['status'] {
  // not_started and temporary_failure both mean "not proven yet" for display.
  return raw === 'verified' ? 'verified' : raw === 'failed' ? 'failed' : 'pending';
}

function mapRecordPurpose(record: unknown, type: unknown): ProviderDnsRecord['purpose'] {
  if (record === 'DKIM') return 'dkim';
  if (record === 'SPF') return type === 'MX' ? 'return_path_mx' : 'spf';
  return 'other';
}

/** `send` -> `send.acme.com`; `@`/`''` -> the apex; an already-absolute host is left alone. */
function toFqdn(host: string, domain: string): string {
  const trimmed = host.trim().replace(/\.+$/, '');
  if (trimmed === '' || trimmed === '@') return domain;
  if (trimmed === domain || trimmed.endsWith(`.${domain}`)) return trimmed;
  return `${trimmed}.${domain}`;
}

export function normalizeResendRecords(domain: string, records: unknown[]): ProviderDnsRecord[] {
  const out: ProviderDnsRecord[] = [];
  for (const raw of records ?? []) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const type = r.type;
    // CAA (the tracking CAA record) has no place in ProviderDnsRecord's type
    // union and we never enable click/open tracking, so it is dropped rather
    // than shown to a partner as something to publish.
    if (type !== 'TXT' && type !== 'CNAME' && type !== 'MX') continue;
    const host = typeof r.name === 'string' ? r.name : '';
    const value = typeof r.value === 'string' ? r.value : '';
    const record: ProviderDnsRecord = {
      purpose: mapRecordPurpose(r.record, type),
      type,
      host,
      fqdn: toFqdn(host, domain),
      value,
      status: mapRecordStatus(r.status)
    };
    if (typeof r.ttl === 'string') record.ttl = r.ttl;
    if (typeof r.priority === 'number') record.priority = r.priority;
    out.push(record);
  }
  return out;
}

/**
 * Four kinds (spec §5). ORDER IS LOAD-BEARING: the domain-refusal text is
 * checked before the generic validation_error rule, because Resend returns
 * `validation_error` for "the domain is not verified" and misclassifying that
 * as `message_rejected` would LOSE the message instead of falling back to the
 * platform lane.
 *
 * The default is `ambiguous`, never `message_rejected`: §8.4 never retries an
 * ambiguous failure on the other lane, so a wrong guess there cannot produce a
 * duplicate — while a wrong `domain_unusable` guess only costs one harmless
 * platform-lane send.
 */
export function classifyResendSendError(error: ResendErrorShape): PartnerLaneSendError {
  const name = error?.name ?? '';
  const status = error?.statusCode ?? null;
  const message = error?.message ?? '';
  const lower = message.toLowerCase();

  const looksLikeDomainRefusal =
    lower.includes('not verified') ||
    lower.includes('domain is not') ||
    lower.includes('verify your domain') ||
    lower.includes('verify a domain') ||
    lower.includes('domain not found');

  if (name === 'invalid_from_address') return { kind: 'domain_unusable' };
  if (looksLikeDomainRefusal) return { kind: 'domain_unusable' };
  if (name === 'not_found' && lower.includes('domain')) return { kind: 'domain_unusable' };

  if (
    name === 'rate_limit_exceeded' ||
    name === 'daily_quota_exceeded' ||
    name === 'monthly_quota_exceeded' ||
    name === 'missing_api_key' ||
    name === 'invalid_api_key' ||
    name === 'restricted_api_key' ||
    name === 'invalid_access' ||
    name === 'security_error' ||
    status === 429
  ) {
    return { kind: 'lane_unavailable' };
  }

  if (
    name === 'validation_error' ||
    name === 'invalid_parameter' ||
    name === 'missing_required_field' ||
    name === 'invalid_attachment' ||
    name === 'invalid_idempotency_key' ||
    status === 413
  ) {
    return { kind: 'message_rejected', detail: message };
  }

  return { kind: 'ambiguous', detail: `${name}${status === null ? '' : ` (${status})`}: ${message}` };
}

/** Resend tag values accept ASCII letters, digits, `_` and `-` only. */
function sanitizeTagValue(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256);
}

function resolveRegion(): ResendRegion {
  const configured = getEmailDomainsConfig().region;
  if (!(RESEND_REGIONS as readonly string[]).includes(configured)) {
    throw new Error(
      `[emailDomains/resend] EMAIL_DOMAINS_REGION=${JSON.stringify(configured)} is not a Resend region. Use one of ${RESEND_REGIONS.join(', ')}.`
    );
  }
  return configured as ResendRegion;
}

function toProviderDomain(data: Record<string, unknown>, domainName: string): ProviderDomain {
  const createdRaw = data.created_at;
  const created = typeof createdRaw === 'string' ? new Date(createdRaw) : undefined;
  const result: ProviderDomain = {
    providerDomainId: String(data.id),
    state: mapResendDomainStatus(String(data.status)),
    records: normalizeResendRecords(domainName, Array.isArray(data.records) ? data.records : [])
  };
  if (typeof data.region === 'string') result.region = data.region;
  if (created && !Number.isNaN(created.getTime())) result.createdAt = created;
  return result;
}

export function createResendDomainProvider(): EmailDomainProvider {
  const config = getEmailDomainsConfig();
  // The adapter NEVER falls back to RESEND_API_KEY: a self-hoster's existing key
  // is almost always sending_access, which cannot manage domains (spec §5.1).
  const management = new Resend(config.resendApiKey ?? undefined);
  const sending = config.resendSendingKey && config.resendSendingKey !== config.resendApiKey
    ? new Resend(config.resendSendingKey)
    : management;

  return {
    id: 'resend',
    verifiesByDns: true,

    async createDomain(input: CreateProviderDomainInput): Promise<ProviderDomain> {
      const region = resolveRegion();
      // camelCase payload: `customReturnPath` is the PUBLIC field name in
      // resend@6.18.0; the snake_case form is the internal wire type. We leave
      // the return path at its default (`send`), which is what §4.2 documents.
      const { data, error } = await management.domains.create({ name: input.domain, region });
      if (error) {
        const lower = (error.message ?? '').toLowerCase();
        if (lower.includes('already exists') || lower.includes('already registered') || error.statusCode === 409) {
          throw new ProviderDomainConflictError(input.domain, error.message);
        }
        throw new ProviderDomainRejectedError(input.domain, `${error.name}: ${error.message}`);
      }
      return toProviderDomain(data as unknown as Record<string, unknown>, input.domain);
    },

    async findDomainByName(domain: string): Promise<ProviderDomain | null> {
      const { data, error } = await management.domains.list();
      if (error) {
        // Reporting "not found" on a list failure would make W03 create a
        // domain the account already holds, which is the one call that can
        // trigger Resend's cross-team claim flow. Throw instead.
        throw new Error(`[emailDomains/resend] listDomains failed: ${error.name}: ${error.message}`);
      }
      const target = domain.trim().toLowerCase();
      const match = (data?.data ?? []).find((d) => String(d.name).trim().toLowerCase() === target);
      if (!match) return null;
      // list() returns no records[] — fetch the full object.
      return this.getDomain(String(match.id));
    },

    async getDomain(providerDomainId: string): Promise<ProviderDomain> {
      const { data, error } = await management.domains.get(providerDomainId);
      if (error) throw new Error(`[emailDomains/resend] getDomain failed: ${error.name}: ${error.message}`);
      const record = data as unknown as Record<string, unknown>;
      return toProviderDomain(record, String(record.name ?? ''));
    },

    async requestVerification(providerDomainId: string): Promise<void> {
      // The response carries only the id — it does NOT report the new status,
      // so callers that need one follow with getDomain on the next sweep.
      const { error } = await management.domains.verify(providerDomainId);
      if (error) throw new Error(`[emailDomains/resend] verify failed: ${error.name}: ${error.message}`);
    },

    async deleteDomain(providerDomainId: string): Promise<void> {
      const { error } = await management.domains.remove(providerDomainId);
      // 404 is success: the domain is already gone, which is the state we want.
      if (error && error.statusCode !== 404 && error.name !== 'not_found') {
        throw new Error(`[emailDomains/resend] deleteDomain failed: ${error.name}: ${error.message}`);
      }
    },

    async listDomains(): Promise<Array<{ providerDomainId: string; domain: string }>> {
      const { data, error } = await management.domains.list();
      if (error) throw new Error(`[emailDomains/resend] listDomains failed: ${error.name}: ${error.message}`);
      return (data?.data ?? []).map((d) => ({ providerDomainId: String(d.id), domain: String(d.name) }));
    },

    async send(m: PartnerLaneMessage & { partnerRef: string; tags: Record<string, string> }) {
      const { data, error } = await sending.emails.send({
        from: m.from,
        to: m.to,
        cc: m.cc,
        subject: m.subject,
        html: m.html,
        text: m.text,
        replyTo: m.replyTo,
        headers: m.headers,
        attachments: m.attachments?.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType
        })),
        tags: Object.entries(m.tags).map(([name, value]) => ({ name, value: sanitizeTagValue(value) }))
      } as Parameters<typeof sending.emails.send>[0]);
      if (error) throw new PartnerLaneSendFailure(classifyResendSendError(error));
      return { providerMessageId: String(data!.id) };
    }
  };
}
```

- [ ] **Step 4: Run and commit**

Run: `cd apps/api && npx vitest run src/services/emailDomains/adapters/resend.test.ts` → all PASS.

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/api/src/services/emailDomains/adapters/resend.ts apps/api/src/services/emailDomains/adapters/resendSendErrorFixtures.ts apps/api/src/services/emailDomains/adapters/resend.test.ts
git commit -m "feat(api): Resend sending-domain adapter

Written against resend@6.18.0's real types: camelCase createDomain payload, the
six-member DomainStatus union plus the temporary_failure the API returns but the
SDK type omits, ttl as a string, and the {data,error} envelope the SDK returns
instead of throwing. Send errors classify into the four spec §5 kinds with
ambiguous as the conservative default; the domain-refusal check runs before the
validation_error rule so a not-verified refusal falls back rather than being
lost. Recorded fixtures are the W03 lab step's refresh target.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 8: The `static` and `fake` adapters

**Files:**
- Create: `apps/api/src/services/emailDomains/adapters/static.ts`
- Create: `apps/api/src/services/emailDomains/adapters/static.test.ts`
- Create: `apps/api/src/services/emailDomains/adapters/fake.ts`

**Interfaces:**
- Produces: `createStaticDomainProvider(): EmailDomainProvider`,
  `classifyPlatformTransportError(err: unknown): PartnerLaneSendError`,
  `createFakeDomainProvider(): EmailDomainProvider`,
  `resetFakeDomainProviderState(): void`, `FAKE_PREEXISTING_PREFIX`.
- Consumes: `getEmailService()` (`services/email.ts:409`, returns
  `EmailService | null`) and its **W01** method
  `deliverRaw(message: RawEmailMessage): Promise<void>`;
  `findStaticAllowedEntry` / `getEmailDomainsConfig` (Task 5); Task 6's types.
- Contract notes for W03, restated because W02 owns them:
  - `static.verifiesByDns === false`, so W03 must never call
    `requestVerification` on it and must treat a `pending` result from
    `getDomain`/`findDomainByName` as **no change** — a `verified` static row
    stays verified. The adapter only ever reports `pending` (still listed) or
    `failed` (delisted by the operator, spec §13).
  - `static.getDomain(key)` takes the **domain name**, not a provider id
    (plan amendment 5).

- [ ] **Step 1: Write the failing `static` tests**

`apps/api/src/services/emailDomains/adapters/static.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const deliverRaw = vi.fn();
const getEmailService = vi.fn();
vi.mock('../../email', () => ({ getEmailService }));

import { createStaticDomainProvider, classifyPlatformTransportError } from './static';
import { PartnerLaneSendFailure, ProviderDomainRejectedError } from '../provider';

const KEYS = ['EMAIL_DOMAINS_STATIC_ALLOWED'];
const SAVED: Record<string, string | undefined> = {};
beforeEach(() => {
  deliverRaw.mockReset().mockResolvedValue(undefined);
  getEmailService.mockReset().mockReturnValue({ deliverRaw });
  for (const k of KEYS) { SAVED[k] = process.env[k]; delete process.env[k]; }
  process.env.EMAIL_DOMAINS_STATIC_ALLOWED = 'open.com, bound.com:acme';
});
afterEach(() => {
  for (const k of KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]!; }
});

describe('static adapter shape', () => {
  it('declares itself as an operator attestation, not a DNS verifier', () => {
    const provider = createStaticDomainProvider();
    expect(provider.id).toBe('static');
    expect(provider.verifiesByDns).toBe(false);
  });
});

describe('createDomain', () => {
  it('accepts an unbound entry for any partner and returns a pending, record-free, id-free domain', async () => {
    await expect(createStaticDomainProvider().createDomain({ domain: 'open.com', partnerRef: 'p1', partnerSlug: 'anyone' }))
      .resolves.toEqual({ providerDomainId: null, state: 'pending', records: [] });
  });

  it('accepts a bound entry for its own partner slug', async () => {
    await expect(createStaticDomainProvider().createDomain({ domain: 'bound.com', partnerRef: 'p1', partnerSlug: 'acme' }))
      .resolves.toMatchObject({ state: 'pending' });
  });

  it('refuses a bound entry for a different partner', async () => {
    await expect(createStaticDomainProvider().createDomain({ domain: 'bound.com', partnerRef: 'p2', partnerSlug: 'other' }))
      .rejects.toBeInstanceOf(ProviderDomainRejectedError);
  });

  it('refuses a bound entry when no slug is supplied', async () => {
    await expect(createStaticDomainProvider().createDomain({ domain: 'bound.com', partnerRef: 'p2' }))
      .rejects.toBeInstanceOf(ProviderDomainRejectedError);
  });

  it('refuses a domain the operator has not listed, and says who to ask', async () => {
    await expect(createStaticDomainProvider().createDomain({ domain: 'nope.com', partnerRef: 'p1', partnerSlug: 'acme' }))
      .rejects.toThrow(/administrator/i);
  });

  it('never makes an external call', async () => {
    await createStaticDomainProvider().createDomain({ domain: 'open.com', partnerRef: 'p1' });
    expect(deliverRaw).not.toHaveBeenCalled();
  });
});

describe('findDomainByName / getDomain', () => {
  it('reports a still-listed domain as pending — verification is the test send, not this call', async () => {
    const provider = createStaticDomainProvider();
    await expect(provider.findDomainByName('open.com')).resolves.toEqual({ providerDomainId: null, state: 'pending', records: [] });
    await expect(provider.getDomain('open.com')).resolves.toEqual({ providerDomainId: null, state: 'pending', records: [] });
  });

  it('reports a DELISTED domain as failed, so the operator removing it stops the sends (spec §13)', async () => {
    process.env.EMAIL_DOMAINS_STATIC_ALLOWED = 'other.com';
    await expect(createStaticDomainProvider().getDomain('open.com')).resolves.toEqual({ providerDomainId: null, state: 'failed', records: [] });
  });

  it('findDomainByName returns null for a delisted domain so W03 can tell "not there" from "broken"', async () => {
    process.env.EMAIL_DOMAINS_STATIC_ALLOWED = 'other.com';
    await expect(createStaticDomainProvider().findDomainByName('open.com')).resolves.toBeNull();
  });

  it('ignores the partner binding on re-check — the binding is enforced at create', async () => {
    await expect(createStaticDomainProvider().getDomain('bound.com')).resolves.toMatchObject({ state: 'pending' });
  });
});

describe('deleteDomain / requestVerification / listDomains', () => {
  it('deleteDomain is a no-op: Breeze must never touch the operator\'s relay config', async () => {
    await expect(createStaticDomainProvider().deleteDomain('open.com')).resolves.toBeUndefined();
  });
  it('requestVerification is a no-op: there is no DNS to check', async () => {
    await expect(createStaticDomainProvider().requestVerification('open.com')).resolves.toBeUndefined();
  });
  it('listDomains returns [] — the drift report is hosted-only and static is self-hosted-only', async () => {
    await expect(createStaticDomainProvider().listDomains()).resolves.toEqual([]);
  });
});

describe('send', () => {
  const message = {
    from: '"Acme Support" <support@open.com>', to: 'customer@example.com', subject: 'Ticket #1',
    html: '<p>hi</p>', partnerRef: 'p1', tags: { partner_id: 'p1', stream: 'support' }
  };

  it('hands the message to the platform transport verbatim, custom From included', async () => {
    const result = await createStaticDomainProvider().send(message);
    expect(deliverRaw).toHaveBeenCalledWith(expect.objectContaining({ from: '"Acme Support" <support@open.com>', to: 'customer@example.com', subject: 'Ticket #1' }));
    expect(result.providerMessageId).toMatch(/^static:/);
  });

  it('does NOT forward provider tags — the platform transport has no tag concept', async () => {
    await createStaticDomainProvider().send(message);
    expect(deliverRaw.mock.calls[0]![0]).not.toHaveProperty('tags');
    expect(deliverRaw.mock.calls[0]![0]).not.toHaveProperty('partnerRef');
  });

  it('reports lane_unavailable when email is not configured at all', async () => {
    getEmailService.mockReturnValue(null);
    await expect(createStaticDomainProvider().send(message)).rejects.toMatchObject({ error: { kind: 'lane_unavailable' } });
  });

  it('wraps a transport failure in PartnerLaneSendFailure', async () => {
    deliverRaw.mockRejectedValue(Object.assign(new Error('boom'), {}));
    await expect(createStaticDomainProvider().send(message)).rejects.toBeInstanceOf(PartnerLaneSendFailure);
  });

  it('classifies an SMTP SendAs refusal as domain_unusable so the message falls back instead of being lost', async () => {
    deliverRaw.mockRejectedValue(Object.assign(new Error('Client does not have permissions to send as this sender'), {
      responseCode: 550,
      response: '550 5.7.60 SMTP; Client does not have permissions to send as this sender'
    }));
    await expect(createStaticDomainProvider().send(message)).rejects.toMatchObject({ error: { kind: 'domain_unusable' } });
  });
});

describe('classifyPlatformTransportError', () => {
  const smtp = (responseCode: number, response: string) =>
    Object.assign(new Error(response), { responseCode, response });

  it.each([
    [smtp(550, '550 5.7.60 SMTP; Client does not have permissions to send as this sender'), 'domain_unusable'],
    [smtp(553, '553 5.7.1 Sender address rejected: not owned by user'), 'domain_unusable'],
    [smtp(550, '550 5.7.1 Sender not allowed'), 'domain_unusable'],
    [smtp(551, '551 User not local; sender refused'), 'domain_unusable'],
    [smtp(550, '550 5.1.1 User unknown in virtual mailbox table'), 'message_rejected'],
    [smtp(550, '550 5.1.1 The email account that you tried to reach does not exist'), 'message_rejected'],
    [smtp(552, '552 5.3.4 Message size exceeds fixed maximum message size'), 'message_rejected'],
    [smtp(554, '554 5.7.1 Message rejected as spam'), 'message_rejected'],
    [smtp(421, '421 4.7.0 Try again later'), 'ambiguous'],
    [smtp(451, '451 4.3.0 Temporary server error'), 'ambiguous'],
    [new Error('Resend error: The acme.com domain is not verified.'), 'domain_unusable'],
    [new Error('Mailgun API error (401): {"message":"Domain not found: open.com"}'), 'domain_unusable'],
    [new Error('Mailgun API error (400): {"message":"to parameter is not a valid address"}'), 'message_rejected'],
    [new Error('Resend error: Too many requests'), 'ambiguous'],
    [new Error('Mailgun request timed out after 120000ms'), 'ambiguous'],
    [Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:587'), { code: 'ECONNREFUSED' }), 'ambiguous'],
    ['not even an error', 'ambiguous']
  ] as const)('classifies %s as %s', (err, kind) => {
    expect(classifyPlatformTransportError(err).kind).toBe(kind);
  });

  it('uses a false responseCode safely — nodemailer sets it to false, not undefined, when it cannot parse one', () => {
    expect(classifyPlatformTransportError(Object.assign(new Error('x'), { responseCode: false })).kind).toBe('ambiguous');
  });
});
```

Run: `cd apps/api && npx vitest run src/services/emailDomains/adapters/static.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2: Write the `static` adapter**

`apps/api/src/services/emailDomains/adapters/static.ts`:

```ts
import { getEmailService } from '../../email';
import { findStaticAllowedEntry } from '../config';
import {
  PartnerLaneSendFailure,
  ProviderDomainRejectedError,
  type CreateProviderDomainInput,
  type EmailDomainProvider,
  type PartnerLaneMessage,
  type PartnerLaneSendError,
  type ProviderDomain
} from '../provider';

/**
 * Self-hosted-only "operator attestation" adapter (spec §5.1, D7). Refused when
 * isHosted() by config/validate.ts.
 *
 * It makes NO external calls. The operator lists in EMAIL_DOMAINS_STATIC_ALLOWED
 * the domains this instance's mail relay may send as; Breeze cannot check that
 * the relay signs for them — SPF and DKIM are the operator's mail setup — so
 * there is no DNS wizard and nothing to poll. A row becomes `verified` only
 * when the relay ACCEPTS a test send (W03's `test-send` job), which catches the
 * common failure (the relay refusing the sender) at setup instead of on a
 * customer's invoice.
 *
 * CONTRACT FOR W03: verifiesByDns === false, so this adapter never returns
 * `verified`. `pending` means "still listed — no change", `failed` means the
 * operator delisted it (spec §13). A verified row must stay verified when this
 * adapter reports `pending`.
 */

const NOT_ALLOWED_MESSAGE =
  'This domain is not allowed on this server. Ask your Breeze administrator to add it to EMAIL_DOMAINS_STATIC_ALLOWED.';

/** Sender-refusal signatures. The relay is telling us it will not send AS this domain. */
const SENDER_REFUSAL_MARKERS = [
  '5.7.60',
  'send as this sender',
  'not allowed to send as',
  'sender address rejected',
  'sender not allowed',
  'sender refused',
  'not owned by user',
  'domain is not verified',
  'domain not verified',
  'not a verified domain',
  'unverified domain',
  'domain not found',
  'verify a domain',
  'verify your domain'
];

/** Recipient-side refusals: the message, not the sending domain, is the problem. */
const RECIPIENT_REFUSAL_MARKERS = [
  'user unknown',
  'no such user',
  'does not exist',
  'mailbox unavailable',
  'recipient address rejected',
  'invalid recipient',
  'unrouteable address',
  'is not a valid address',
  'not a valid address'
];

const MESSAGE_REFUSAL_MARKERS = [
  'message size exceeds',
  'message too large',
  'size limit exceeded',
  'rejected as spam',
  'content rejected'
];

function includesAny(haystack: string, markers: readonly string[]): boolean {
  return markers.some((marker) => haystack.includes(marker));
}

/**
 * Classify a failure thrown by the PLATFORM transport (EmailService.deliverRaw).
 *
 * Structure available per transport (plan amendment 7): SMTP errors arrive raw
 * from nodemailer with `responseCode` (a number, or `false` when it could not be
 * parsed) and `response`; Resend and Mailgun failures arrive as a plain Error
 * whose message embeds the provider text.
 *
 * ORDER IS LOAD-BEARING. Sender-refusal text wins over everything, because that
 * is the case that must fall back to EMAIL_FROM rather than throw. Then explicit
 * recipient/message refusals. Only then the bare SMTP code, where 550/551/553
 * default to domain_unusable per spec §5.1 — a harmless extra platform-lane
 * send if we are wrong, versus a lost message if we call a domain refusal
 * `message_rejected`.
 */
export function classifyPlatformTransportError(err: unknown): PartnerLaneSendError {
  const error = err as { responseCode?: unknown; response?: unknown; message?: unknown } | null;
  const message = err instanceof Error ? err.message : String(err ?? '');
  const response = typeof error?.response === 'string' ? error.response : '';
  const haystack = `${message} ${response}`.toLowerCase();

  if (includesAny(haystack, SENDER_REFUSAL_MARKERS)) return { kind: 'domain_unusable' };
  if (includesAny(haystack, RECIPIENT_REFUSAL_MARKERS)) return { kind: 'message_rejected', detail: message };
  if (includesAny(haystack, MESSAGE_REFUSAL_MARKERS)) return { kind: 'message_rejected', detail: message };

  // nodemailer sets responseCode to `false` when the reply had no leading
  // digits, so a truthiness check would be wrong here.
  const code = typeof error?.responseCode === 'number' ? error.responseCode : null;
  if (code !== null) {
    if (code === 550 || code === 551 || code === 553) return { kind: 'domain_unusable' };
    if (code === 552 || code === 554) return { kind: 'message_rejected', detail: message };
    return { kind: 'ambiguous', detail: message };
  }

  return { kind: 'ambiguous', detail: message };
}

const LISTED: ProviderDomain = { providerDomainId: null, state: 'pending', records: [] };
const DELISTED: ProviderDomain = { providerDomainId: null, state: 'failed', records: [] };

export function createStaticDomainProvider(): EmailDomainProvider {
  /** Re-checked on every call: the operator may edit the list and restart. */
  const isListed = (domain: string): boolean => findStaticAllowedEntry(domain, null) !== null
    || findStaticAllowedEntry(domain, '*') !== null
    // A bound entry matches no arbitrary slug, so probe the raw config too.
    || rawListed(domain);

  const rawListed = (domain: string): boolean => {
    const target = domain.trim().toLowerCase().replace(/\.+$/, '');
    // findStaticAllowedEntry applies the binding; for a re-check we only care
    // whether the operator still lists the NAME at all — the partner binding was
    // enforced when the row was created and cannot change without a restart.
    return require('../config').getEmailDomainsConfig().staticAllowed.some((e: { domain: string }) => e.domain === target);
  };

  return {
    id: 'static',
    verifiesByDns: false,

    async createDomain(input: CreateProviderDomainInput): Promise<ProviderDomain> {
      const entry = findStaticAllowedEntry(input.domain, input.partnerSlug ?? null);
      if (!entry) throw new ProviderDomainRejectedError(input.domain, NOT_ALLOWED_MESSAGE);
      return { ...LISTED };
    },

    // The key here is the DOMAIN NAME: `static` never has a provider domain id
    // (plan amendment 5, spec §3.1).
    async findDomainByName(domain: string): Promise<ProviderDomain | null> {
      return isListed(domain) ? { ...LISTED } : null;
    },

    async getDomain(domainName: string): Promise<ProviderDomain> {
      return isListed(domainName) ? { ...LISTED } : { ...DELISTED };
    },

    async requestVerification(): Promise<void> {
      // No DNS to check. W03 must not call this (verifiesByDns === false); a
      // no-op rather than a throw so a future caller cannot break a sweep.
    },

    async deleteDomain(): Promise<void> {
      // Breeze must never change the operator's relay configuration.
    },

    async listDomains(): Promise<Array<{ providerDomainId: string; domain: string }>> {
      // The drift report is hosted-only (§6.4) and `static` is self-hosted-only.
      return [];
    },

    async send(m: PartnerLaneMessage & { partnerRef: string; tags: Record<string, string> }) {
      const service = getEmailService();
      if (!service) {
        // No platform transport configured at all: the lane cannot carry this
        // message, and neither can the fallback. lane_unavailable is honest.
        throw new PartnerLaneSendFailure({ kind: 'lane_unavailable' });
      }
      // Strip the provider-only fields: deliverRaw takes a RawEmailMessage.
      const { partnerRef: _partnerRef, tags: _tags, ...raw } = m;
      void _partnerRef;
      void _tags;
      try {
        await service.deliverRaw(raw);
      } catch (err) {
        throw new PartnerLaneSendFailure(classifyPlatformTransportError(err));
      }
      // The platform transports do not all surface a provider message id, and
      // deliverRaw returns void, so the partner lane synthesises one. W06 has no
      // webhook events for `static` anyway.
      return { providerMessageId: `static:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}` };
    }
  };
}
```

**Simplify `isListed` before committing:** the `require(...)` above is a
placeholder for the ESM import. Replace the two helpers with a single one that
imports `getEmailDomainsConfig` at the top of the file:

```ts
import { findStaticAllowedEntry, getEmailDomainsConfig } from '../config';

/**
 * Whether the operator still lists this NAME. The partner binding is enforced
 * at create; a re-check only asks whether the domain is still allowed at all,
 * so a bound entry re-checks true without the caller carrying a slug.
 */
function isStillListed(domain: string): boolean {
  const target = domain.trim().toLowerCase().replace(/\.+$/, '');
  return getEmailDomainsConfig().staticAllowed.some((entry) => entry.domain === target);
}
```

and use `isStillListed` in `findDomainByName` and `getDomain`. Delete the inner
`isListed`/`rawListed` closures entirely.

- [ ] **Step 3: Write the `fake` adapter**

`apps/api/src/services/emailDomains/adapters/fake.ts`:

```ts
import { getEmailService } from '../../email';
import {
  PartnerLaneSendFailure,
  ProviderDomainConflictError,
  type CreateProviderDomainInput,
  type EmailDomainProvider,
  type PartnerLaneMessage,
  type ProviderDnsRecord,
  type ProviderDomain
} from '../provider';

/**
 * Deterministic provider for unit, integration, E2E and wt-stack runs (spec
 * §5.1). Refused in production by config/validate.ts.
 *
 * Behaviour is keyed on the DOMAIN NAME so a test needs no setup:
 *   *.verify.test     -> verifies on the first check
 *   *.fail.test       -> fails verification, and refuses to send (domain_unusable)
 *   conflict.test     -> createDomain raises ProviderDomainConflictError
 *   preexisting.*     -> findDomainByName reports an ALREADY VERIFIED domain
 *                        created in the year 2000, which drives spec §5.1
 *                        case 4 (adopt with provider_managed = false)
 *   anything else     -> stays pending
 *
 * `send` hands the message to the platform transport verbatim, so a local
 * Mailpit shows the custom From.
 */

export const FAKE_PREEXISTING_PREFIX = 'preexisting.';
const PREEXISTING_CREATED_AT = new Date('2000-01-01T00:00:00.000Z');

/** Domains this process has created. Reset between test files. */
const created = new Map<string, { domain: string; createdAt: Date; region?: string }>();

export function resetFakeDomainProviderState(): void {
  created.clear();
}

function fakeId(domain: string): string {
  return `fake-${domain}`;
}

function domainOfId(providerDomainId: string): string {
  return providerDomainId.startsWith('fake-') ? providerDomainId.slice('fake-'.length) : providerDomainId;
}

function stateFor(domain: string): ProviderDomain['state'] {
  if (domain === 'conflict.test' || domain.endsWith('.conflict.test')) return 'pending';
  if (domain === 'fail.test' || domain.endsWith('.fail.test')) return 'failed';
  if (domain === 'verify.test' || domain.endsWith('.verify.test')) return 'verified';
  if (domain.startsWith(FAKE_PREEXISTING_PREFIX)) return 'verified';
  return 'pending';
}

function recordsFor(domain: string, state: ProviderDomain['state']): ProviderDnsRecord[] {
  const status: ProviderDnsRecord['status'] = state === 'verified' ? 'verified' : state === 'failed' ? 'failed' : 'pending';
  return [
    { purpose: 'dkim', type: 'CNAME', host: 'resend._domainkey', fqdn: `resend._domainkey.${domain}`, value: `fake-dkim.${domain}.example`, ttl: 'Auto', status },
    { purpose: 'spf', type: 'TXT', host: 'send', fqdn: `send.${domain}`, value: 'v=spf1 include:fake.example ~all', ttl: 'Auto', status },
    { purpose: 'return_path_mx', type: 'MX', host: 'send', fqdn: `send.${domain}`, value: 'feedback-smtp.fake.example', ttl: 'Auto', priority: 10, status }
  ];
}

function domainFor(domain: string, createdAt: Date, region?: string): ProviderDomain {
  const state = stateFor(domain);
  const result: ProviderDomain = { providerDomainId: fakeId(domain), state, records: recordsFor(domain, state), createdAt };
  if (region) result.region = region;
  return result;
}

export function createFakeDomainProvider(): EmailDomainProvider {
  return {
    id: 'fake',
    verifiesByDns: true,

    async createDomain(input: CreateProviderDomainInput): Promise<ProviderDomain> {
      if (input.domain === 'conflict.test' || input.domain.endsWith('.conflict.test')) {
        throw new ProviderDomainConflictError(input.domain, 'fake provider: this domain is already claimed');
      }
      const createdAt = new Date();
      created.set(input.domain, { domain: input.domain, createdAt, region: input.region });
      return domainFor(input.domain, createdAt, input.region);
    },

    async findDomainByName(domain: string): Promise<ProviderDomain | null> {
      // The `preexisting.` prefix drives §5.1 case 4 without any seeding: the
      // provider reports a domain OLDER than any provision_attempted_at, so
      // W03 must adopt it with provider_managed = false and never delete it.
      if (domain.startsWith(FAKE_PREEXISTING_PREFIX)) {
        return domainFor(domain, PREEXISTING_CREATED_AT);
      }
      const existing = created.get(domain);
      return existing ? domainFor(existing.domain, existing.createdAt, existing.region) : null;
    },

    async getDomain(providerDomainId: string): Promise<ProviderDomain> {
      const domain = domainOfId(providerDomainId);
      const existing = created.get(domain);
      return domainFor(domain, existing?.createdAt ?? PREEXISTING_CREATED_AT, existing?.region);
    },

    async requestVerification(): Promise<void> {
      // Verification is decided by the domain name, so this is a no-op.
    },

    async deleteDomain(providerDomainId: string): Promise<void> {
      // Deleting an unknown id is success — the 404-as-success contract.
      created.delete(domainOfId(providerDomainId));
    },

    async listDomains(): Promise<Array<{ providerDomainId: string; domain: string }>> {
      return [...created.values()].map((entry) => ({ providerDomainId: fakeId(entry.domain), domain: entry.domain }));
    },

    async send(m: PartnerLaneMessage & { partnerRef: string; tags: Record<string, string> }) {
      const fromDomain = (m.from.match(/<([^<>\s]+@([^<>\s]+))>/)?.[2] ?? m.from.split('@')[1] ?? '').toLowerCase();
      if (fromDomain === 'fail.test' || fromDomain.endsWith('.fail.test')) {
        throw new PartnerLaneSendFailure({ kind: 'domain_unusable' });
      }
      const service = getEmailService();
      if (!service) throw new PartnerLaneSendFailure({ kind: 'lane_unavailable' });
      const { partnerRef: _partnerRef, tags: _tags, ...raw } = m;
      void _partnerRef;
      void _tags;
      try {
        await service.deliverRaw(raw);
      } catch (err) {
        throw new PartnerLaneSendFailure({ kind: 'ambiguous', detail: err instanceof Error ? err.message : String(err) });
      }
      return { providerMessageId: `fake:${Date.now().toString(36)}` };
    }
  };
}
```

- [ ] **Step 4: Run, including the registry test that was left red in Task 6**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run src/services/emailDomains/adapters/static.test.ts src/services/emailDomains/providerRegistry.test.ts
npx tsc --noEmit -p tsconfig.json
```
Expected: all PASS; no type errors. `providerRegistry.test.ts` is green now that all three adapter modules exist.

- [ ] **Step 5: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/api/src/services/emailDomains/adapters/static.ts apps/api/src/services/emailDomains/adapters/static.test.ts apps/api/src/services/emailDomains/adapters/fake.ts
git commit -m "feat(api): static and fake sending-domain adapters

static is the self-hosted operator attestation (spec D7): no external calls, an
allow-list check with an optional partner-slug binding, and sends through the
platform transport with a custom From. Its send-error classifier puts
sender-refusal text ahead of the bare SMTP code, so a 550 5.7.60 SendAs refusal
falls back to EMAIL_FROM instead of losing the message. fake is deterministic on
the domain name, including a preexisting.* prefix that drives the adopt-and-never-
delete case W03 has to get right.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 9: The adapter contract suite

One suite, three adapters. It asserts the properties every adapter must hold
whatever it talks to, so a fourth adapter (SES) inherits the test for free.

**Files:**
- Create: `apps/api/src/services/emailDomains/adapters/adapterContract.test.ts`

**Interfaces:**
- Consumes: all three factories, `resetFakeDomainProviderState`, the Task 6 types.
- Produces: nothing importable.

- [ ] **Step 1: Write the suite**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const domainsCreate = vi.fn();
const domainsGet = vi.fn();
const domainsVerify = vi.fn();
const domainsRemove = vi.fn();
const domainsList = vi.fn();
const emailsSend = vi.fn();
vi.mock('resend', () => ({
  Resend: class {
    domains = { create: domainsCreate, get: domainsGet, verify: domainsVerify, remove: domainsRemove, list: domainsList };
    emails = { send: emailsSend };
  }
}));

const deliverRaw = vi.fn();
const getEmailService = vi.fn();
vi.mock('../../email', () => ({ getEmailService }));

import { createResendDomainProvider } from './resend';
import { createStaticDomainProvider } from './static';
import { createFakeDomainProvider, resetFakeDomainProviderState } from './fake';
import { PartnerLaneSendFailure, type EmailDomainProvider } from '../provider';

const KEYS = ['EMAIL_DOMAINS_RESEND_API_KEY', 'EMAIL_DOMAINS_REGION', 'EMAIL_DOMAINS_STATIC_ALLOWED'];
const SAVED: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const fn of [domainsCreate, domainsGet, domainsVerify, domainsRemove, domainsList, emailsSend]) fn.mockReset();
  deliverRaw.mockReset().mockResolvedValue(undefined);
  getEmailService.mockReset().mockReturnValue({ deliverRaw });
  resetFakeDomainProviderState();
  for (const k of KEYS) { SAVED[k] = process.env[k]; delete process.env[k]; }
  process.env.EMAIL_DOMAINS_RESEND_API_KEY = 're_full';
  process.env.EMAIL_DOMAINS_STATIC_ALLOWED = 'contract.example';
  // Happy-path Resend doubles; individual cases override.
  domainsCreate.mockResolvedValue({ data: { id: 'dom_1', name: 'contract.example', status: 'not_started', region: 'us-east-1', created_at: '2026-09-17T10:00:00.000Z', records: [] }, error: null });
  domainsGet.mockResolvedValue({ data: { id: 'dom_1', name: 'contract.example', status: 'verified', region: 'us-east-1', created_at: '2026-09-17T10:00:00.000Z', records: [] }, error: null });
  domainsVerify.mockResolvedValue({ data: { id: 'dom_1', object: 'domain' }, error: null });
  domainsRemove.mockResolvedValue({ data: { id: 'dom_1', object: 'domain', deleted: true }, error: null });
  domainsList.mockResolvedValue({ data: { data: [], object: 'list', has_more: false }, error: null });
  emailsSend.mockResolvedValue({ data: { id: 'msg_1' }, error: null });
});
afterEach(() => {
  for (const k of KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]!; }
});

interface AdapterCase {
  name: string;
  build: () => EmailDomainProvider;
  id: EmailDomainProvider['id'];
  verifiesByDns: boolean;
  /** A domain this adapter will accept from createDomain. */
  domain: string;
  /** The key its getDomain / deleteDomain take. */
  key: string;
  /** Whether createDomain returns a provider domain id. */
  hasProviderDomainId: boolean;
}

const ADAPTERS: AdapterCase[] = [
  { name: 'fake', build: createFakeDomainProvider, id: 'fake', verifiesByDns: true, domain: 'contract.example', key: 'fake-contract.example', hasProviderDomainId: true },
  { name: 'static', build: createStaticDomainProvider, id: 'static', verifiesByDns: false, domain: 'contract.example', key: 'contract.example', hasProviderDomainId: false },
  { name: 'resend (mocked SDK)', build: createResendDomainProvider, id: 'resend', verifiesByDns: true, domain: 'contract.example', key: 'dom_1', hasProviderDomainId: true }
];

describe.each(ADAPTERS)('EmailDomainProvider contract — $name', (adapter) => {
  it('declares its id and whether it verifies by DNS', () => {
    const provider = adapter.build();
    expect(provider.id).toBe(adapter.id);
    expect(provider.verifiesByDns).toBe(adapter.verifiesByDns);
  });

  it('implements every method of the interface', () => {
    const provider = adapter.build();
    for (const method of ['createDomain', 'findDomainByName', 'getDomain', 'requestVerification', 'deleteDomain', 'listDomains', 'send'] as const) {
      expect(typeof provider[method], method).toBe('function');
    }
  });

  it('createDomain returns a ProviderDomain whose shape the state machine can consume', async () => {
    const result = await adapter.build().createDomain({ domain: adapter.domain, partnerRef: 'p1', partnerSlug: 'acme' });
    expect(['pending', 'verified', 'at_risk', 'failed']).toContain(result.state);
    expect(Array.isArray(result.records)).toBe(true);
    if (adapter.hasProviderDomainId) expect(result.providerDomainId).toEqual(expect.any(String));
    else expect(result.providerDomainId).toBeNull();
  });

  it('every returned DNS record carries a computed fqdn and a tri-state status', async () => {
    const result = await adapter.build().createDomain({ domain: adapter.domain, partnerRef: 'p1', partnerSlug: 'acme' });
    for (const record of result.records) {
      expect(record.fqdn.endsWith(adapter.domain)).toBe(true);
      expect(['TXT', 'CNAME', 'MX']).toContain(record.type);
      expect(['pending', 'verified', 'failed']).toContain(record.status);
      expect(['dkim', 'spf', 'return_path_mx', 'other']).toContain(record.purpose);
    }
  });

  it('findDomainByName returns null for a name the provider does not hold', async () => {
    domainsList.mockResolvedValue({ data: { data: [], object: 'list', has_more: false }, error: null });
    process.env.EMAIL_DOMAINS_STATIC_ALLOWED = 'something.else';
    expect(await adapter.build().findDomainByName('never-created.example')).toBeNull();
  });

  it('deleteDomain treats an unknown key as success (404-as-success)', async () => {
    domainsRemove.mockResolvedValue({ data: null, error: { name: 'not_found', statusCode: 404, message: 'Domain not found' } });
    await expect(adapter.build().deleteDomain('definitely-not-there')).resolves.toBeUndefined();
  });

  it('listDomains returns an array', async () => {
    await expect(adapter.build().listDomains()).resolves.toEqual(expect.any(Array));
  });

  it('send returns a provider message id on success', async () => {
    const result = await adapter.build().send({
      from: `support@${adapter.domain}`, to: 'customer@example.com', subject: 's', html: '<p>h</p>',
      partnerRef: 'p1', tags: { partner_id: 'p1', domain_id: 'd1', stream: 'support', purpose: 'ticket_customer_notification' }
    });
    expect(result.providerMessageId).toEqual(expect.any(String));
    expect(result.providerMessageId.length).toBeGreaterThan(0);
  });

  it('send throws PartnerLaneSendFailure with one of the four kinds, never a bare Error', async () => {
    emailsSend.mockResolvedValue({ data: null, error: { name: 'application_error', statusCode: 500, message: 'boom' } });
    deliverRaw.mockRejectedValue(new Error('boom'));
    const provider = adapter.build();
    let raised: unknown;
    try {
      await provider.send({
        from: `support@${adapter.domain}`, to: 'customer@example.com', subject: 's', html: '<p>h</p>',
        partnerRef: 'p1', tags: {}
      });
    } catch (err) {
      raised = err;
    }
    expect(raised).toBeInstanceOf(PartnerLaneSendFailure);
    expect(['domain_unusable', 'lane_unavailable', 'message_rejected', 'ambiguous'])
      .toContain((raised as PartnerLaneSendFailure).error.kind);
  });

  it('an adapter that does not verify by DNS returns no records at all', async () => {
    const result = await adapter.build().createDomain({ domain: adapter.domain, partnerRef: 'p1', partnerSlug: 'acme' });
    if (!adapter.verifiesByDns) expect(result.records).toEqual([]);
  });
});

describe('find-then-create inputs W03 relies on (spec §5.1)', () => {
  it('fake: a freshly created domain reports a createdAt NEWER than a just-recorded attempt time', async () => {
    const attemptedAt = new Date(Date.now() - 1000);
    const provider = createFakeDomainProvider();
    await provider.createDomain({ domain: 'crashed.example', partnerRef: 'p1' });
    const found = await provider.findDomainByName('crashed.example');
    // Case 3: ours, from an attempt that crashed before the local update.
    expect(found!.createdAt!.getTime()).toBeGreaterThan(attemptedAt.getTime());
  });

  it('fake: a preexisting.* domain reports a createdAt OLDER than any attempt, and is already verified', async () => {
    const found = await createFakeDomainProvider().findDomainByName('preexisting.acme.example');
    // Case 4: pre-existing -> adopt with provider_managed = false, never delete.
    expect(found!.createdAt!.getTime()).toBeLessThan(Date.now());
    expect(found!.createdAt!.getFullYear()).toBe(2000);
    expect(found!.state).toBe('verified');
  });

  it('resend: findDomainByName reports the provider createdAt so W03 can compare it', async () => {
    domainsList.mockResolvedValue({ data: { data: [{ id: 'dom_9', name: 'contract.example', status: 'verified', region: 'us-east-1', created_at: '2024-05-05T00:00:00.000Z' }], object: 'list', has_more: false }, error: null });
    domainsGet.mockResolvedValue({ data: { id: 'dom_9', name: 'contract.example', status: 'verified', region: 'us-east-1', created_at: '2024-05-05T00:00:00.000Z', records: [] }, error: null });
    const found = await createResendDomainProvider().findDomainByName('contract.example');
    expect(found).toMatchObject({ providerDomainId: 'dom_9', createdAt: new Date('2024-05-05T00:00:00.000Z'), state: 'verified' });
  });
});
```

- [ ] **Step 2: Run and commit**

Run: `cd apps/api && npx vitest run src/services/emailDomains/adapters/adapterContract.test.ts` → all PASS.

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/api/src/services/emailDomains/adapters/adapterContract.test.ts
git commit -m "test(api): one EmailDomainProvider contract suite over fake, static and mocked resend

Properties every adapter must hold whatever it talks to: the declared id and
verifiesByDns, a consumable ProviderDomain, fqdn on every record, null for an
unheld name, 404-as-success on delete, and a PartnerLaneSendFailure carrying one
of the four kinds rather than a bare Error. Plus the find-then-create inputs
W03's orchestration reads.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 10: The `custom_sending_domain` capability

`GatedCapability` appears in **exactly one** API file and has **no**
`Record<GatedCapability, …>`, mapped type, capability array or `never`
exhaustiveness check anywhere in `apps/`, `packages/` or `ee/`. The web keeps
its own copy of the union, and that copy **does** have an exhaustive record —
which is the only compile error the change produces.

**Files:**
- Modify: `apps/api/src/services/partnerTrust.ts:10` (the single-line union)
- Modify: `apps/api/src/services/partnerTrust.test.ts:242` (the `it.each` tuple)
- Modify: `apps/web/src/lib/trustProbation.ts:4-8` (union) and `:19-24` (runtime `Set`)
- Modify: `apps/web/src/components/trust/TrustProbationBanner.tsx:30-35` (`CAPABILITY_LABELS`)

**Interfaces:**
- Produces: `GatedCapability` gains `'custom_sending_domain'`; `requireCapability('custom_sending_domain')` becomes available to W03's write routes, and `evaluateCapabilityContinuationForState('custom_sending_domain', …)` to W04's `resolveSender`.
- Consumes: nothing new.
- Verified behaviour (`partnerTrust.ts:200-223`): `decide` has a `default:` branch at `:220-221` and no exhaustiveness check, so the new value takes the default branch with **no** forced API compile error. `trusted` short-circuits to allow at `:205`; `probation` denies `TRUST_PROBATION`/`probation_default_deny`; `restricted` denies `TRUST_RESTRICTED`/**`restricted`** (a different reason string — do not assert one reason for both); `partnerTrustMode() === 'off'` returns `{ allow: true }` at `:226-227` before the partner row is even read, and `partnerTrustMode()` returns `'off'` whenever `!isHosted()` (`config/partnerTrustMode.ts:12`), so on self-hosted the gate is open with no configuration.

- [ ] **Step 1: Write the failing tests**

In `apps/api/src/services/partnerTrust.test.ts`, extend the `it.each` tuple at
`:242` and add three cases after that block:

```ts
  it.each(['remote_control', 'device_execute', 'installer_distribute', 'custom_sending_domain'] as const)(
    'denies %s in probation',
    async (cap) => {
      const d = await evaluateCapability(cap, { partnerId: 'p1' });
      expect(d).toMatchObject({ allow: false, code: 'TRUST_PROBATION', capability: cap });
      expect(audit).toHaveBeenCalledWith(expect.objectContaining({
        action: 'partner.trust.capability_denied',
      }));
    },
  );

  it('denies custom_sending_domain for a restricted partner with reason "restricted"', async () => {
    state.trustState = 'restricted';
    const d = await evaluateCapability('custom_sending_domain', { partnerId: 'p1' });
    expect(d).toMatchObject({ allow: false, code: 'TRUST_RESTRICTED', reason: 'restricted' });
  });

  it('allows custom_sending_domain for a trusted partner and writes no audit row', async () => {
    state.trustState = 'trusted';
    expect(await evaluateCapability('custom_sending_domain', { partnerId: 'p1' })).toEqual({ allow: true });
    expect(audit).not.toHaveBeenCalled();
  });

  it('allows custom_sending_domain in off mode without reading the partner row — the self-hosted path', async () => {
    vi.mocked(partnerTrustMode).mockReturnValue('off');
    state.trustState = 'probation';
    expect(await evaluateCapability('custom_sending_domain', { partnerId: 'p1' })).toEqual({ allow: true });
    expect(audit).not.toHaveBeenCalled();
  });
```

Run: `cd apps/api && npx vitest run src/services/partnerTrust.test.ts`
Expected: FAIL — `'custom_sending_domain'` is not assignable to `GatedCapability`.

- [ ] **Step 2: Widen the API union**

`apps/api/src/services/partnerTrust.ts:10` — append the new value last, matching
the file's historical add-at-the-end order (the union is not alphabetised):

```ts
export type GatedCapability = 'remote_control' | 'device_execute' | 'installer_distribute' | 'agent_enroll' | 'custom_sending_domain';
```

Run: `cd apps/api && npx vitest run src/services/partnerTrust.test.ts` → PASS.

- [ ] **Step 3: Mirror it in the web, in all three places**

`apps/web/src/lib/trustProbation.ts` — the union at `:4-8` (one member per line,
same order as the API):

```ts
export type TrustCapability =
  | 'remote_control'
  | 'device_execute'
  | 'installer_distribute'
  | 'agent_enroll'
  | 'custom_sending_domain';
```

and the runtime `Set` at `:19-24` — **this is the dangerous one**: `isTrustDenial`
returns `false` for an unrecognised capability, so a 403 would fall through to a
generic error toast and the trust banner would never appear. No compiler catches
it.

```ts
const TRUST_CAPABILITIES = new Set<TrustCapability>([
  'remote_control',
  'device_execute',
  'installer_distribute',
  'agent_enroll',
  'custom_sending_domain',
]);
```

`apps/web/src/components/trust/TrustProbationBanner.tsx:30-35` — this
`Record<TrustDenial['capability'], string>` is exhaustive, so widening the union
without this edit is a TS2741 missing-property error. It is read at `:115` with
no fallback, so a missing key renders "undefined is temporarily unavailable."

```ts
const CAPABILITY_LABELS: Record<TrustDenial['capability'], string> = {
  remote_control: 'Remote control',
  device_execute: 'Script execution',
  installer_distribute: 'Installer distribution',
  agent_enroll: 'Agent enrollment',
  custom_sending_domain: 'Custom sending domain',
};
```

- [ ] **Step 4: Typecheck the web and commit**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web
npx astro check
npx vitest run src/lib src/components/trust
```
Expected: no type errors; web tests PASS.

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/api/src/services/partnerTrust.ts apps/api/src/services/partnerTrust.test.ts apps/web/src/lib/trustProbation.ts apps/web/src/components/trust/TrustProbationBanner.tsx
git commit -m "feat(api,web): custom_sending_domain gated capability

Takes partnerTrust.decide's default branch: denied on probation and restricted,
allowed for trusted, and open with no configuration self-hosted because
partnerTrustMode() returns off whenever !isHosted(). The web mirror needs all
three edits — the union, the runtime Set that isTrustDenial checks (silent
failure, no compiler), and the exhaustive label record (compile error).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 11: The provider-release path and its two hooks

**Files:**
- Create: `apps/api/src/services/emailDomains/domainRelease.ts`
- Create: `apps/api/src/services/emailDomains/domainRelease.test.ts`
- Modify: `apps/api/src/services/tenantCascade.ts` (import after `:52`; call inside `cascadeDeletePartner` between the `purge_started` audit that ends at `:1609` and the child-org lookup that starts at `:1611`)
- Modify: `apps/api/src/services/tenantOffboarding.ts` (import after `:30`; call inside `finalizePartnerOffboarding` immediately after `if (flipped.length === 0) return null;` at `:1025`)
- Modify: `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` (`ALLOWED_WITHOUT_CAPABILITY_CHECK`)

**Interfaces:**
- Produces: `releaseSendingDomainsForPartner(partnerId: string): Promise<number>` — returns the number of rows whose `provider_domain_id` it nulled. **No provider calls**: it only writes the outbox and clears the local handle, so it is safe inside a destructive path that must not depend on a third party being up.
- Consumes: `db`, `withSystemDbAccessContext`, `getCurrentDbAccessContext` (`db/index.ts:650, 742, 933`), `partnerSendingDomains`, `emailProviderDomainReleases` (Task 1).

**DB-context handling — verified, and the reason the shape below is what it is:**

- `withDbAccessContext` **early-returns `fn()` when a context already exists**
  (`db/index.ts:654-656`). It joins; it does not nest a transaction. So
  `withSystemDbAccessContext` inside this function opens a fresh system
  transaction when there is no ambient context, and joins when there is one.
- `cascadeDeletePartner` has **no ambient context** — it wraps each statement in
  its own `withSystemDbAccessContext` and its comment at `:1619-1620` explicitly
  forbids an outer wrapper ("would nest transactions"). So this function opens
  its own, exactly like every other step there.
- `finalizePartnerOffboarding` **already runs inside** one:
  `sweepOffboardingTenants` calls it under
  `runOutsideDbContext(() => withSystemDbAccessContext(async () => { … }))`
  (`tenantOffboarding.ts:1436-1458`). The inner `withSystemDbAccessContext` joins
  that transaction — no second pooled connection, no #1105 hold.
- `runOutsideDbContext` is **not** used here. It does not close the ambient
  transaction; it only silences the #1105 tripwire (memory
  `runoutsidedbcontext_does_not_close_outer_txn`), and the ambient context in
  both callers is already system scope, which is what this work needs.
- Because `withSystemDbAccessContext` joins whatever is ambient, a future caller
  inside a **request** context would silently run these writes under a
  partner/org scope and match zero rows. The function therefore asserts the
  ambient scope first and throws.

- [ ] **Step 1: Write the failing unit test**

`apps/api/src/services/emailDomains/domainRelease.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface DomainRow {
  id: string; domain: string; provider: string;
  providerDomainId: string | null; providerRegion: string | null; providerManaged: boolean;
}

const state = {
  ambient: null as { scope: string } | null,
  rows: [] as DomainRow[],
  inserted: [] as Record<string, unknown>[],
  updates: [] as { set: Record<string, unknown> }[],
  systemContextOpened: 0
};

vi.mock('../../db', () => ({
  getCurrentDbAccessContext: () => state.ambient,
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => {
    state.systemContextOpened++;
    return fn();
  },
  db: {
    select: () => ({ from: () => ({ where: async () => state.rows }) }),
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        onConflictDoNothing: async () => { state.inserted.push(row); }
      })
    }),
    update: () => ({
      set: (set: Record<string, unknown>) => ({ where: async () => { state.updates.push({ set }); } })
    })
  }
}));

import { releaseSendingDomainsForPartner } from './domainRelease';

beforeEach(() => {
  state.ambient = null;
  state.rows = [];
  state.inserted = [];
  state.updates = [];
  state.systemContextOpened = 0;
});

const managed = (over: Partial<DomainRow> = {}): DomainRow => ({
  id: 'row-1', domain: 'acme.com', provider: 'resend',
  providerDomainId: 'dom_1', providerRegion: 'us-east-1', providerManaged: true, ...over
});

describe('releaseSendingDomainsForPartner', () => {
  it('returns 0 and writes nothing when the partner holds no provider domains', async () => {
    expect(await releaseSendingDomainsForPartner('p1')).toBe(0);
    expect(state.inserted).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it('writes an outbox row BEFORE nulling the handle, for a provider_managed domain', async () => {
    state.rows = [managed()];
    expect(await releaseSendingDomainsForPartner('p1')).toBe(1);
    expect(state.inserted).toEqual([expect.objectContaining({
      provider: 'resend', providerDomainId: 'dom_1', providerRegion: 'us-east-1',
      domain: 'acme.com', reason: 'partner_released'
    })]);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]!.set).toMatchObject({ providerDomainId: null });
  });

  it('NEVER writes an outbox row for a domain Breeze does not manage — that is the operator\'s own sending domain', async () => {
    state.rows = [managed({ providerManaged: false })];
    expect(await releaseSendingDomainsForPartner('p1')).toBe(1);
    expect(state.inserted).toEqual([]);
    // The handle is still cleared, so the BEFORE DELETE guard lets the row go.
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]!.set).toMatchObject({ providerDomainId: null });
  });

  it('handles a mix, writing one outbox row and clearing both handles', async () => {
    state.rows = [managed({ id: 'a' }), managed({ id: 'b', domain: 'b.com', providerDomainId: 'dom_2', providerManaged: false })];
    expect(await releaseSendingDomainsForPartner('p1')).toBe(2);
    expect(state.inserted).toHaveLength(1);
    expect(state.updates).toHaveLength(2);
  });

  it('makes no provider call — it is import-clean of the provider registry', async () => {
    state.rows = [managed()];
    await releaseSendingDomainsForPartner('p1');
    // Nothing to assert on a mock here: the guarantee is structural, and the
    // source-scan below is what enforces it.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./domainRelease.ts', import.meta.url), 'utf8'));
    expect(source).not.toContain('providerRegistry');
    expect(source).not.toContain('getEmailDomainProvider');
  });

  it('opens a system context (cascadeDeletePartner has no ambient one)', async () => {
    state.rows = [managed()];
    await releaseSendingDomainsForPartner('p1');
    expect(state.systemContextOpened).toBe(1);
  });

  it('joins an ambient SYSTEM context (finalizePartnerOffboarding already holds one)', async () => {
    state.ambient = { scope: 'system' };
    state.rows = [managed()];
    await expect(releaseSendingDomainsForPartner('p1')).resolves.toBe(1);
  });

  it('THROWS inside a tenant-scoped ambient context rather than silently matching zero rows', async () => {
    state.ambient = { scope: 'partner' };
    await expect(releaseSendingDomainsForPartner('p1')).rejects.toThrow(/system scope/i);
    expect(state.updates).toEqual([]);
  });
});
```

Run: `cd apps/api && npx vitest run src/services/emailDomains/domainRelease.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement `domainRelease.ts`**

```ts
import { and, eq, isNotNull } from 'drizzle-orm';
import { db, getCurrentDbAccessContext, withSystemDbAccessContext } from '../../db';
import { emailProviderDomainReleases, partnerSendingDomains } from '../../db/schema';

/**
 * Release every provider-side sending domain a partner still owns (spec §3.5).
 *
 * WHY THIS EXISTS. `partner_sending_domains` carries a BEFORE DELETE trigger
 * that raises while `provider_domain_id` is set, so any path that deletes a
 * partner's rows without releasing first aborts loudly instead of silently
 * leaking a domain in the provider account. This is the one function that
 * satisfies the guard, and it is called FIRST in both partner-destroying paths.
 *
 * ORDER IS LOAD-BEARING. The outbox row is written BEFORE the handle is
 * nulled, so a crash between the two leaves a releasable outbox row rather than
 * an orphaned provider domain nobody can name any more. The outbox table
 * deliberately has no partner_id, so cascadeDeletePartner's sweep leaves it
 * standing.
 *
 * `provider_managed = false` rows get their handle cleared but NO outbox row:
 * that provider domain pre-existed Breeze asking for it and is very likely the
 * operator's primary sending domain. Leaking one is recoverable; deleting
 * someone's mail domain is not.
 *
 * NO PROVIDER CALLS. This runs inside destructive paths that must not depend on
 * a third party being reachable; the worker drains the outbox later.
 *
 * DB CONTEXT. `withSystemDbAccessContext` JOINS an existing context rather than
 * nesting (db/index.ts:654-656), which is exactly right for the two callers:
 * `cascadeDeletePartner` holds none and gets a fresh system transaction;
 * `finalizePartnerOffboarding` already runs inside one (sweepOffboardingTenants
 * wraps it) and this joins it — no second pooled connection. Because joining is
 * unconditional, a future caller inside a REQUEST context would run these
 * writes under a tenant scope and match zero rows, so the ambient scope is
 * asserted first.
 */
export async function releaseSendingDomainsForPartner(partnerId: string): Promise<number> {
  const ambient = getCurrentDbAccessContext();
  if (ambient && ambient.scope !== 'system') {
    throw new Error(
      `[emailDomains] releaseSendingDomainsForPartner must run in system scope; ambient scope is '${ambient.scope}'. ` +
        'withSystemDbAccessContext joins an existing context rather than elevating, so running here would match zero rows and leak every provider domain this partner owns.'
    );
  }

  return withSystemDbAccessContext(async () => {
    const rows = await db
      .select({
        id: partnerSendingDomains.id,
        domain: partnerSendingDomains.domain,
        provider: partnerSendingDomains.provider,
        providerDomainId: partnerSendingDomains.providerDomainId,
        providerRegion: partnerSendingDomains.providerRegion,
        providerManaged: partnerSendingDomains.providerManaged
      })
      .from(partnerSendingDomains)
      .where(and(
        eq(partnerSendingDomains.partnerId, partnerId),
        isNotNull(partnerSendingDomains.providerDomainId)
      ));

    let released = 0;
    for (const row of rows) {
      if (row.providerManaged && row.providerDomainId) {
        // onConflictDoNothing: the (provider, provider_domain_id) unique index
        // makes a re-run idempotent, which matters because cascadeDeletePartner
        // is documented as idempotent and the offboarding sweep can retry.
        await db
          .insert(emailProviderDomainReleases)
          .values({
            provider: row.provider,
            providerDomainId: row.providerDomainId,
            providerRegion: row.providerRegion,
            domain: row.domain,
            reason: 'partner_released'
          })
          .onConflictDoNothing({
            target: [emailProviderDomainReleases.provider, emailProviderDomainReleases.providerDomainId]
          });
      }
      await db
        .update(partnerSendingDomains)
        .set({ providerDomainId: null, updatedAt: new Date() })
        .where(eq(partnerSendingDomains.id, row.id));
      released++;
    }
    return released;
  }, 'emailDomains.releaseSendingDomainsForPartner');
}
```

- [ ] **Step 3: Hook `cascadeDeletePartner`**

`apps/api/src/services/tenantCascade.ts` — add the import after
`import { deleteObjects } from './s3Storage';` (`:52`):

```ts
import { releaseSendingDomainsForPartner } from './emailDomains/domainRelease';
```

Then, inside `cascadeDeletePartner`, between the closing `});` of the
`purge_started` `createAuditLog` call (`:1609`) and the `// Lookup child orgs …`
comment (`:1611`):

```ts
  // Release provider-side sending domains BEFORE any delete (spec §3.5).
  // partner_sending_domains carries a BEFORE DELETE guard that raises while the
  // row still owns a provider_domain_id, so the partner-axis sweep below would
  // abort the purge without this. It writes an email_provider_domain_releases
  // row for every provider_managed domain — that table has no partner_id, so it
  // survives the sweep and the worker drains it afterwards — and never one for
  // a domain Breeze did not create. No provider call is made here.
  //
  // It runs after the forensic breadcrumb above on purpose: the purge_started
  // audit must exist even if this step throws. It opens its own system context,
  // like every other statement in this function (see the nesting warning below).
  await releaseSendingDomainsForPartner(partnerId);
```

- [ ] **Step 4: Hook `finalizePartnerOffboarding`**

`apps/api/src/services/tenantOffboarding.ts` — add the import after
`import { getEmailService } from './email';` (`:30`):

```ts
import { releaseSendingDomainsForPartner } from './emailDomains/domainRelease';
```

Then, inside `finalizePartnerOffboarding`, immediately after
`if (flipped.length === 0) return null;` (`:1025`):

```ts
  // Release provider-side sending domains (spec §3.5). Placed AFTER the status
  // CAS so a lost race — another sweep already flipped this partner — cannot
  // release domains for a partner that is no longer offboarding. This function
  // already runs inside runOutsideDbContext(() => withSystemDbAccessContext(…))
  // from sweepOffboardingTenants, and withSystemDbAccessContext JOINS an
  // existing context rather than nesting, so no second pooled connection is
  // taken. Makes no provider call.
  await releaseSendingDomainsForPartner(partnerId);
```

- [ ] **Step 5: Register `domainRelease.ts` in the partner-wide write allowlist**

`apps/api/src/__tests__/partner-wide-write-coverage.test.ts` — add to
`ALLOWED_WITHOUT_CAPABILITY_CHECK`, before the closing `};` after the
`services/orgArchive.ts` entry:

```ts
  // --- partner sending domains (spec 2026-09-17 W02) -----------------------
  'services/emailDomains/domainRelease.ts': 'releaseSendingDomainsForPartner has no caller-facing surface at all: it is invoked only by cascadeDeletePartner and finalizePartnerOffboarding, both of which run in system context on a partner already being destroyed, and it takes the partner id from those functions rather than from any request. It writes exactly two things — an outbox row and provider_domain_id = NULL — and creates no partner-owned configuration, so there is no partner-wide policy decision for canManagePartnerWidePolicies to gate.',
```

- [ ] **Step 6: Run everything this task touches**

Run:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run src/services/emailDomains/domainRelease.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/services/tenantCascade
npx tsc --noEmit -p tsconfig.json
```
Expected: all PASS (`partner-wide-write-coverage` proves both that the new write
site is accounted for and that the entry is not stale); no type errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/api/src/services/emailDomains/domainRelease.ts apps/api/src/services/emailDomains/domainRelease.test.ts apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantOffboarding.ts apps/api/src/__tests__/partner-wide-write-coverage.test.ts
git commit -m "feat(api): release provider sending domains on partner cascade and offboarding

releaseSendingDomainsForPartner writes an outbox row for every provider_managed
domain and then nulls provider_domain_id, in that order, so a crash between the
two leaves releasable work rather than an unnameable provider domain. It makes
no provider call and never writes an outbox row for a domain Breeze did not
create. Wired first into cascadeDeletePartner and finalizePartnerOffboarding —
without it the BEFORE DELETE guard aborts the partner purge. Registered in
partner-wide-write-coverage's allowlist, which the spec's §3.5 list missed.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 12: Live-Postgres contract suite

**Placement rule:** the file must live in `apps/api/src/__tests__/integration/`.
`vitest.integration.config.ts`'s include list covers
`src/__tests__/integration/**/*.test.ts`; a co-located `*.integration.test.ts`
anywhere else runs in **no CI job at all** unless it is named explicitly in that
list. The harness idiom below is copied from
`aiScriptPoliciesPartnerRls.integration.test.ts:18-105`.

**Files:**
- Create: `apps/api/src/__tests__/integration/partnerSendingDomainsRls.integration.test.ts`

**Interfaces:**
- Consumes: `db`, `withDbAccessContext`, `type DbAccessContext` (`../../db`), the
  Task 1 Drizzle tables, `releaseSendingDomainsForPartner` (Task 11),
  `cascadeDeletePartner` (`../../services/tenantCascade`), `pgErrorCode`
  (`../../utils/pgErrors`), `createOrganization` / `createPartner` (`./db-utils`).
- Produces: nothing importable.

- [ ] **Step 1: Write the suite**

```ts
/**
 * partner_sending_domains / partner_sender_identities / email_provider_domain_releases
 * — live RLS, uniqueness, the tenant-consistent composite FK, the BEFORE DELETE
 * release guard, and the partner-cascade path (spec §3, §14; CLAUDE.md "Tenant
 * Isolation" step 6).
 *
 * The shipped policies (2026-10-20-100000-partner-sending-domains.sql) are:
 *   partner_sending_domains_partner_access     FOR ALL  system OR breeze_has_partner_access(partner_id)
 *   partner_sender_identities_partner_access   FOR ALL  system OR breeze_has_partner_access(partner_id)
 *   email_provider_domain_releases_system_only FOR ALL  breeze.scope = 'system'
 *
 * rls-coverage.integration.test.ts proves the policies EXIST by reading
 * pg_catalog; it cannot prove either enforces anything. This suite drives the
 * real postgres.js driver as `breeze_app` under FORCE RLS, which is the only
 * thing that does.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  emailProviderDomainReleases,
  partnerSenderIdentities,
  partnerSendingDomains
} from '../../db/schema';
import { releaseSendingDomainsForPartner } from '../../services/emailDomains/domainRelease';
import { cascadeDeletePartner } from '../../services/tenantCascade';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null
};
function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], userId: null, currentPartnerId: partnerId };
}
function orgContext(orgId: string, currentPartnerId: string | null): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null, currentPartnerId };
}

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  expect(pgErrorCode(raised)).toBe(code);
}

const SENTINEL_ACTOR = '00000000-0000-0000-0000-000000000000';

const createdPartnerIds: string[] = [];
const createdDomains: string[] = [];

afterEach(async () => {
  const partnerIds = [...new Set(createdPartnerIds)];
  const domains = [...new Set(createdDomains)];
  createdPartnerIds.length = 0;
  createdDomains.length = 0;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (partnerIds.length > 0) {
      await db.delete(partnerSenderIdentities).where(inArray(partnerSenderIdentities.partnerId, partnerIds));
      // Clear the handle first — the BEFORE DELETE guard is exactly what this
      // suite exercises, and cleanup must not trip it.
      await db.update(partnerSendingDomains).set({ providerDomainId: null })
        .where(inArray(partnerSendingDomains.partnerId, partnerIds));
      await db.delete(partnerSendingDomains).where(inArray(partnerSendingDomains.partnerId, partnerIds));
    }
    if (domains.length > 0) {
      await db.delete(emailProviderDomainReleases).where(inArray(emailProviderDomainReleases.domain, domains));
    }
  });
});

async function fixture() {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const orgB = await createOrganization({ partnerId: partnerB.id });
  createdPartnerIds.push(partnerA.id, partnerB.id);
  return { partnerA: partnerA.id, partnerB: partnerB.id, orgA: orgA.id, orgB: orgB.id };
}

let unique = 0;
function uniqueDomain(prefix: string): string {
  unique += 1;
  const name = `${prefix}-${Date.now().toString(36)}-${unique}.test`;
  createdDomains.push(name);
  return name;
}

function seedDomain(partnerId: string, over: Partial<typeof partnerSendingDomains.$inferInsert> = {}) {
  const domain = (over.domain as string | undefined) ?? uniqueDomain('seed');
  if (over.domain) createdDomains.push(over.domain as string);
  return withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(partnerSendingDomains).values({
      partnerId, domain, provider: 'fake', providerDomainId: 'prov-1',
      providerManaged: true, status: 'verified', ...over
    }).returning());
}

describe('partner_sending_domains — RLS (shape 3)', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });

  it('FORGE: partner B cannot insert a domain for partner A (42501)', async () => {
    await expectSqlState(
      () => withDbAccessContext(partnerContext(f.partnerB, []), () =>
        db.insert(partnerSendingDomains).values({
          partnerId: f.partnerA, domain: uniqueDomain('forge'), provider: 'fake'
        }).returning()),
      '42501',
    );
  });

  it('FORGE: partner B cannot read, update or delete partner A\'s row', async () => {
    const [row] = await seedDomain(f.partnerA);
    const read = await withDbAccessContext(partnerContext(f.partnerB, []), () =>
      db.select({ id: partnerSendingDomains.id }).from(partnerSendingDomains));
    expect(read).toHaveLength(0);
    const updated = await withDbAccessContext(partnerContext(f.partnerB, []), () =>
      db.update(partnerSendingDomains).set({ status: 'suspended' })
        .where(eq(partnerSendingDomains.id, row!.id)).returning({ id: partnerSendingDomains.id }));
    expect(updated).toHaveLength(0);
  });

  it('partner A CAN write and read its own row', async () => {
    const domain = uniqueDomain('own');
    const [row] = await withDbAccessContext(partnerContext(f.partnerA, [f.orgA]), () =>
      db.insert(partnerSendingDomains).values({ partnerId: f.partnerA, domain, provider: 'fake' }).returning());
    expect(row?.partnerId).toBe(f.partnerA);
    const read = await withDbAccessContext(partnerContext(f.partnerA, [f.orgA]), () =>
      db.select({ id: partnerSendingDomains.id }).from(partnerSendingDomains)
        .where(eq(partnerSendingDomains.domain, domain)));
    expect(read).toHaveLength(1);
  });

  it('an ORG-scoped context sees ZERO rows even for its own partner — partner-axis tables are invisible to org tokens', async () => {
    await seedDomain(f.partnerA);
    const rows = await withDbAccessContext(orgContext(f.orgA, f.partnerA), () =>
      db.select({ id: partnerSendingDomains.id }).from(partnerSendingDomains));
    expect(rows).toHaveLength(0);
  });

  it('an org-scoped context cannot insert either (42501)', async () => {
    await expectSqlState(
      () => withDbAccessContext(orgContext(f.orgA, f.partnerA), () =>
        db.insert(partnerSendingDomains).values({
          partnerId: f.partnerA, domain: uniqueDomain('orgforge'), provider: 'fake'
        }).returning()),
      '42501',
    );
  });
});

describe('partner_sending_domains — constraints', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });

  it('UNIQUE (domain) holds ACROSS partners — one row owns a name platform-wide (23505)', async () => {
    const domain = uniqueDomain('shared');
    await seedDomain(f.partnerA, { domain });
    await expectSqlState(() => seedDomain(f.partnerB, { domain }), '23505');
  });

  it('rejects a status outside the CHECK set (23514)', async () => {
    await expectSqlState(
      () => withDbAccessContext(SYSTEM_CTX, () =>
        db.execute(sql`INSERT INTO partner_sending_domains (partner_id, domain, provider, status)
                       VALUES (${f.partnerA}, ${uniqueDomain('badstatus')}, 'fake', 'almost_verified')`)),
      '23514',
    );
  });

  it('rejects a provider outside the CHECK set (23514)', async () => {
    await expectSqlState(
      () => withDbAccessContext(SYSTEM_CTX, () =>
        db.execute(sql`INSERT INTO partner_sending_domains (partner_id, domain, provider)
                       VALUES (${f.partnerA}, ${uniqueDomain('badprovider')}, 'sendgrid')`)),
      '23514',
    );
  });

  it('refuses a provider_domain_id on a `static` row — static has no provider object (23514)', async () => {
    await expectSqlState(
      () => seedDomain(f.partnerA, { provider: 'static', providerDomainId: 'should-not-exist' }),
      '23514',
    );
  });
});

describe('partner_sender_identities', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });

  it('the composite FK REJECTS an identity pointing at another partner\'s domain (23503)', async () => {
    const [domainA] = await seedDomain(f.partnerA);
    await expectSqlState(
      () => withDbAccessContext(SYSTEM_CTX, () =>
        db.insert(partnerSenderIdentities).values({
          partnerId: f.partnerB, sendingDomainId: domainA!.id, stream: 'support', localPart: 'support'
        }).returning()),
      '23503',
    );
  });

  it('accepts an identity on the SAME partner\'s domain', async () => {
    const [domainA] = await seedDomain(f.partnerA);
    const [identity] = await withDbAccessContext(partnerContext(f.partnerA, [f.orgA]), () =>
      db.insert(partnerSenderIdentities).values({
        partnerId: f.partnerA, sendingDomainId: domainA!.id, stream: 'support', localPart: 'support'
      }).returning());
    expect(identity?.stream).toBe('support');
  });

  it('UNIQUE (partner_id, stream): one identity per stream (23505)', async () => {
    const [domainA] = await seedDomain(f.partnerA);
    const insert = () => withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(partnerSenderIdentities).values({
        partnerId: f.partnerA, sendingDomainId: domainA!.id, stream: 'billing', localPart: 'billing'
      }).returning());
    await insert();
    await expectSqlState(insert, '23505');
  });

  it('rejects a stream and a local part outside their CHECKs (23514)', async () => {
    const [domainA] = await seedDomain(f.partnerA);
    await expectSqlState(
      () => withDbAccessContext(SYSTEM_CTX, () =>
        db.execute(sql`INSERT INTO partner_sender_identities (partner_id, sending_domain_id, stream, local_part)
                       VALUES (${f.partnerA}, ${domainA!.id}, 'marketing', 'hello')`)),
      '23514',
    );
    await expectSqlState(
      () => withDbAccessContext(SYSTEM_CTX, () =>
        db.execute(sql`INSERT INTO partner_sender_identities (partner_id, sending_domain_id, stream, local_part)
                       VALUES (${f.partnerA}, ${domainA!.id}, 'general', 'bad..local')`)),
      '23514',
    );
  });

  it('FORGE: partner B cannot read partner A\'s identities', async () => {
    const [domainA] = await seedDomain(f.partnerA);
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(partnerSenderIdentities).values({
        partnerId: f.partnerA, sendingDomainId: domainA!.id, stream: 'general', localPart: 'notifications'
      }));
    const rows = await withDbAccessContext(partnerContext(f.partnerB, []), () =>
      db.select({ id: partnerSenderIdentities.id }).from(partnerSenderIdentities));
    expect(rows).toHaveLength(0);
  });

  it('deleting a released domain cascades its identities', async () => {
    const [domainA] = await seedDomain(f.partnerA);
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(partnerSenderIdentities).values({
        partnerId: f.partnerA, sendingDomainId: domainA!.id, stream: 'support', localPart: 'support'
      }));
    await withDbAccessContext(SYSTEM_CTX, async () => {
      await db.update(partnerSendingDomains).set({ providerDomainId: null })
        .where(eq(partnerSendingDomains.id, domainA!.id));
      await db.delete(partnerSendingDomains).where(eq(partnerSendingDomains.id, domainA!.id));
      const left = await db.select({ id: partnerSenderIdentities.id }).from(partnerSenderIdentities)
        .where(eq(partnerSenderIdentities.sendingDomainId, domainA!.id));
      expect(left).toHaveLength(0);
    });
  });
});

describe('the BEFORE DELETE release guard', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });

  it('RAISES when the row still owns a provider domain', async () => {
    const [row] = await seedDomain(f.partnerA, { providerDomainId: 'dom_live' });
    await expectSqlState(
      () => withDbAccessContext(SYSTEM_CTX, () =>
        db.delete(partnerSendingDomains).where(eq(partnerSendingDomains.id, row!.id))),
      'P0001',
    );
  });

  it('names the domain and the provider handle in the error, so an operator can find it', async () => {
    const domain = uniqueDomain('guarded');
    const [row] = await seedDomain(f.partnerA, { domain, providerDomainId: 'dom_live' });
    let raised: unknown;
    try {
      await withDbAccessContext(SYSTEM_CTX, () =>
        db.delete(partnerSendingDomains).where(eq(partnerSendingDomains.id, row!.id)));
    } catch (err) { raised = err; }
    expect(String((raised as { detail?: string; message?: string }).detail ?? (raised as Error).message)).toContain(domain);
  });

  it('ALLOWS the delete once provider_domain_id is null', async () => {
    const [row] = await seedDomain(f.partnerA, { providerDomainId: 'dom_live' });
    await withDbAccessContext(SYSTEM_CTX, async () => {
      await db.update(partnerSendingDomains).set({ providerDomainId: null })
        .where(eq(partnerSendingDomains.id, row!.id));
      await db.delete(partnerSendingDomains).where(eq(partnerSendingDomains.id, row!.id));
      const left = await db.select({ id: partnerSendingDomains.id }).from(partnerSendingDomains)
        .where(eq(partnerSendingDomains.id, row!.id));
      expect(left).toHaveLength(0);
    });
  });
});

describe('email_provider_domain_releases (system-only outbox)', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });

  it('has NO partner_id column — the property that makes it survive the partner sweep', async () => {
    const rows = (await withDbAccessContext(SYSTEM_CTX, () => db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'email_provider_domain_releases'
    `))) as unknown as Array<{ column_name: string }>;
    expect(rows.map((r) => r.column_name)).not.toContain('partner_id');
  });

  it('is INVISIBLE to a partner-scoped context and unwritable from one', async () => {
    const domain = uniqueDomain('outbox');
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(emailProviderDomainReleases).values({
        provider: 'fake', providerDomainId: 'dom_out', domain, reason: 'partner_released'
      }));
    const rows = await withDbAccessContext(partnerContext(f.partnerA, [f.orgA]), () =>
      db.select({ id: emailProviderDomainReleases.id }).from(emailProviderDomainReleases));
    expect(rows).toHaveLength(0);
    await expectSqlState(
      () => withDbAccessContext(partnerContext(f.partnerA, [f.orgA]), () =>
        db.insert(emailProviderDomainReleases).values({
          provider: 'fake', providerDomainId: 'dom_forge', domain: uniqueDomain('forgeout'), reason: 'user_removed'
        }).returning()),
      '42501',
    );
  });

  it('UNIQUE (provider, provider_domain_id) makes a re-release idempotent (23505 without onConflictDoNothing)', async () => {
    const domain = uniqueDomain('dupe');
    const insert = () => withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(emailProviderDomainReleases).values({
        provider: 'fake', providerDomainId: 'dom_dupe', domain, reason: 'partner_released'
      }).returning());
    await insert();
    await expectSqlState(insert, '23505');
  });
});

describe('releaseSendingDomainsForPartner', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });

  it('writes an outbox row for a MANAGED domain and clears the handle', async () => {
    const domain = uniqueDomain('managed');
    await seedDomain(f.partnerA, { domain, providerDomainId: 'dom_managed', providerManaged: true });
    expect(await releaseSendingDomainsForPartner(f.partnerA)).toBe(1);
    await withDbAccessContext(SYSTEM_CTX, async () => {
      const outbox = await db.select().from(emailProviderDomainReleases)
        .where(eq(emailProviderDomainReleases.domain, domain));
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({ provider: 'fake', providerDomainId: 'dom_managed', reason: 'partner_released' });
      const [row] = await db.select({ providerDomainId: partnerSendingDomains.providerDomainId })
        .from(partnerSendingDomains).where(eq(partnerSendingDomains.domain, domain));
      expect(row?.providerDomainId).toBeNull();
    });
  });

  it('writes NO outbox row for an UNMANAGED domain but still clears the handle — the self-hoster\'s primary domain is never deleted', async () => {
    const domain = uniqueDomain('unmanaged');
    await seedDomain(f.partnerA, { domain, providerDomainId: 'dom_theirs', providerManaged: false });
    expect(await releaseSendingDomainsForPartner(f.partnerA)).toBe(1);
    await withDbAccessContext(SYSTEM_CTX, async () => {
      const outbox = await db.select().from(emailProviderDomainReleases)
        .where(eq(emailProviderDomainReleases.domain, domain));
      expect(outbox).toHaveLength(0);
      const [row] = await db.select({ providerDomainId: partnerSendingDomains.providerDomainId })
        .from(partnerSendingDomains).where(eq(partnerSendingDomains.domain, domain));
      expect(row?.providerDomainId).toBeNull();
    });
  });

  it('is idempotent: a second call releases nothing and does not duplicate the outbox row', async () => {
    const domain = uniqueDomain('twice');
    await seedDomain(f.partnerA, { domain, providerDomainId: 'dom_twice', providerManaged: true });
    expect(await releaseSendingDomainsForPartner(f.partnerA)).toBe(1);
    expect(await releaseSendingDomainsForPartner(f.partnerA)).toBe(0);
    await withDbAccessContext(SYSTEM_CTX, async () => {
      const outbox = await db.select().from(emailProviderDomainReleases)
        .where(eq(emailProviderDomainReleases.domain, domain));
      expect(outbox).toHaveLength(1);
    });
  });

  it('touches only the named partner', async () => {
    const domainB = uniqueDomain('other-partner');
    await seedDomain(f.partnerA, { providerDomainId: 'dom_a' });
    await seedDomain(f.partnerB, { domain: domainB, providerDomainId: 'dom_b' });
    await releaseSendingDomainsForPartner(f.partnerA);
    await withDbAccessContext(SYSTEM_CTX, async () => {
      const [row] = await db.select({ providerDomainId: partnerSendingDomains.providerDomainId })
        .from(partnerSendingDomains).where(eq(partnerSendingDomains.domain, domainB));
      expect(row?.providerDomainId).toBe('dom_b');
    });
  });
});

describe('cascadeDeletePartner with live sending domains', () => {
  it('SUCCEEDS, removes both partner-axis tables, and LEAVES the outbox row standing', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    void org;
    const domain = uniqueDomain('cascade');
    // Not registered in createdPartnerIds: the cascade removes the partner, and
    // a stale id would make afterEach delete rows under a partner that is gone.
    const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(partnerSendingDomains).values({
        partnerId: partner.id, domain, provider: 'fake', providerDomainId: 'dom_cascade',
        providerManaged: true, status: 'verified'
      }).returning());
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(partnerSenderIdentities).values({
        partnerId: partner.id, sendingDomainId: row!.id, stream: 'support', localPart: 'support'
      }));

    const stats = await cascadeDeletePartner(partner.id, SENTINEL_ACTOR);
    expect(stats.totalRowsDeleted).toBeGreaterThan(0);

    await withDbAccessContext(SYSTEM_CTX, async () => {
      const domains = await db.select({ id: partnerSendingDomains.id }).from(partnerSendingDomains)
        .where(eq(partnerSendingDomains.partnerId, partner.id));
      expect(domains).toHaveLength(0);
      const identities = await db.select({ id: partnerSenderIdentities.id }).from(partnerSenderIdentities)
        .where(eq(partnerSenderIdentities.partnerId, partner.id));
      expect(identities).toHaveLength(0);
      // The whole point of the partner_id-free outbox: the provider handle
      // outlives the tenant, so the worker can still release it.
      const outbox = await db.select().from(emailProviderDomainReleases)
        .where(and(
          eq(emailProviderDomainReleases.provider, 'fake'),
          eq(emailProviderDomainReleases.providerDomainId, 'dom_cascade')
        ));
      expect(outbox).toHaveLength(1);
      expect(outbox[0]!.domain).toBe(domain);
      await db.delete(emailProviderDomainReleases).where(eq(emailProviderDomainReleases.domain, domain));
    });
  });
});
```

- [ ] **Step 2: Run it**

Run (the stack from Task 1 Step 5 must be up):
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/partnerSendingDomainsRls.integration.test.ts
```
Expected: every case RUNS and PASSES. Check the reported test count — a suite in
the wrong directory reports zero tests and still exits 0.

- [ ] **Step 3: Commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
git add apps/api/src/__tests__/integration/partnerSendingDomainsRls.integration.test.ts
git commit -m "test(api): live-Postgres contract suite for partner sending domains

Cross-partner forge (42501), org-scope zero rows, UNIQUE(domain) across
partners, the composite FK refusing a cross-partner identity, the BEFORE DELETE
release guard raising and then allowing, an outbox that is invisible outside
system scope and carries no partner_id, releaseSendingDomainsForPartner writing
outbox rows only for provider_managed domains, and cascadeDeletePartner
succeeding on a partner with live domains while leaving the outbox row standing.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 13: Verification

Everything below must pass before the PR. Nothing here changes code.

- [ ] **Step 1: Typecheck every package this wave touched**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/packages/shared && npx tsc --noEmit -p tsconfig.json
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api && npx tsc --noEmit -p tsconfig.json
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web && npx astro check
```
Expected: no errors anywhere.

- [ ] **Step 2: Every unit file this wave added or changed**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/packages/shared
npx vitest run src/validators/sendingDomains.test.ts

cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api
npx vitest run \
  src/db/autoMigrate.test.ts \
  src/db/migrationRlsScope.test.ts \
  src/config/validate.test.ts \
  src/config/envComposeParity.test.ts \
  src/config/composeBindMounts.test.ts \
  src/services/emailDomains/config.test.ts \
  src/services/emailDomains/domainPolicy.test.ts \
  src/services/emailDomains/providerRegistry.test.ts \
  src/services/emailDomains/domainRelease.test.ts \
  src/services/emailDomains/adapters/resend.test.ts \
  src/services/emailDomains/adapters/static.test.ts \
  src/services/emailDomains/adapters/adapterContract.test.ts \
  src/services/partnerTrust.test.ts \
  src/__tests__/partner-wide-write-coverage.test.ts

cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/web
npx vitest run src/lib src/components/trust
```
Expected: all PASS. **Check the reported file count on each run** — vitest's
path filter is a plain substring match, so a typo silently scopes to zero files
and still exits 0.

- [ ] **Step 3: The full API unit suite**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain/apps/api && npx vitest run
```
Expected: PASS. This is the job (`Test API`) that catches the partner-wide-write
allowlist and the env-parity pins.

- [ ] **Step 4: Migration guards and drift**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
ls apps/api/migrations/*.sql | sort | tail -1
scripts/check-migration-naming.sh --against-ref origin/main
pnpm db:migrate
pnpm db:check-drift
```
Expected: the migration still sorts last against `origin/main` (rename upward if
not — `origin/main` may have gained one since Task 1); the naming guard passes;
migrate is a no-op on the already-migrated stack; **no drift**.

- [ ] **Step 5: The contract suites**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
pnpm test-stack up   # no-op if it is already up from Task 1

cd apps/api
# rls-coverage has its OWN runner: vitest.integration.config.ts EXCLUDES it,
# because that config's setup.ts TRUNCATEs core tables on beforeEach and this
# test is a read-only pg_catalog inspection.
npx vitest run --config vitest.config.rls-coverage.ts

npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/partnerSendingDomainsRls.integration.test.ts \
  src/__tests__/integration/tenantCascadePartner.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/partnerAxisSystemContext.integration.test.ts
```
Expected: all PASS. The org-cascade, export-policy and erasure-roundtrip suites
are listed to **prove the negative** claimed in Task 2 — that three tables with
no `org_id` need no entry in any of those registries. If one of them reds naming
a new table, the tenancy analysis is wrong and the PR stops here.

- [ ] **Step 6: The manual `breeze_app` forge (CLAUDE.md "Tenant Isolation" step 6)**

Find the test stack's Postgres container, then forge a cross-tenant insert by
hand — this is the check that does not depend on any test harness being correct:

```bash
docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | .Name'
docker exec -it <that project's postgres container> psql -U breeze_app -d breeze
```

```sql
-- No context at all: deny-by-default, zero rows.
SELECT count(*) FROM partner_sending_domains;

-- Forge a row for a partner this session has no access to.
SELECT set_config('breeze.scope', 'partner', false);
SELECT set_config('breeze.accessible_partner_ids', '00000000-0000-0000-0000-0000000000ff', false);
INSERT INTO partner_sending_domains (partner_id, domain, provider)
VALUES ((SELECT id FROM partners LIMIT 1), 'forged.example', 'fake');
-- EXPECTED: ERROR: new row violates row-level security policy for table "partner_sending_domains"

-- The outbox is system-only.
SELECT count(*) FROM email_provider_domain_releases;
-- EXPECTED: 0 rows regardless of what system scope inserted.
```
Expected: the INSERT fails with `new row violates row-level security policy`,
and the outbox select returns 0.

- [ ] **Step 7: Tear the stack down and open the PR**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/outbound-email-domain
pnpm test-stack down
docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'
```
Expected: this worktree's test stack is gone. Say in the PR what, if anything,
was left running.

PR body must contain:
- `Closes #__W02__`
- the three new tables with their tenancy shape and the justification spec §3.1
  requires for a partner-axis (not org-XOR-partner) config table: the From
  domain is the MSP's identity, a per-org sending domain is the internal
  phishing shape, and an internal IT team is a partner with one org;
- the registrations made (`PARTNER_TENANT_TABLES` ×2, `INTENTIONAL_UNSCOPED` ×1,
  `ALLOWED_WITHOUT_CAPABILITY_CHECK` ×1) **and** the registries deliberately not
  touched, with the reason (no `org_id`, no `device_id`, no `ticket_id`);
- the `## Plan amendments` list from the top of this document;
- that the wave lands dark: `EMAIL_DOMAINS_PROVIDER` unset changes nothing.

---

## Self-review

Every in-scope requirement, and the task that discharges it.

| # | Requirement (source) | Task |
|---|---|---|
| 1 | Three tables with every column of spec §3.1, §3.2, §3.3 | 1 |
| 2 | CHECKs on the status, stream and provider value sets (+ status reason, test status, static-has-no-provider-id, lowercase domain, jsonb array) | 1 |
| 3 | `UNIQUE (domain)`, `UNIQUE (id, partner_id)`, `UNIQUE (partner_id, stream)`, `UNIQUE (provider, provider_domain_id)` | 1 |
| 4 | Composite FK `(sending_domain_id, partner_id) → partner_sending_domains(id, partner_id) ON DELETE CASCADE`, non-deferrable with the evidence for that call | 1 + amendment 6 |
| 5 | Indexes: `(partner_id)`, `(next_check_at)`, `(sending_domain_id)`, outbox due index | 1 |
| 6 | RLS enable + force + partner-axis policy from the `2026-09-25-time-entry-…` template; system-only policy on the outbox from the `abuse_script_hosts` precedent; `GRANT … DELETE` for the partner sweep | 1 |
| 7 | `BEFORE DELETE` release-guard trigger | 1 |
| 8 | Idempotent, no inner `BEGIN`/`COMMIT`, DDL only (no `set_config` — confirmed against `migrationRlsScope.test.ts`) | 1 (Steps 2, 4) |
| 9 | Outbox has no `partner_id`; partner FKs carry no `ON DELETE CASCADE` | 1 (asserted live in 12) |
| 10 | Drizzle `emailSendingDomains.ts` + schema-index export; `pnpm db:check-drift` | 1 (Step 5), 13 (Step 4) |
| 11 | `PARTNER_TENANT_TABLES` ×2, `INTENTIONAL_UNSCOPED` ×1 | 2 |
| 12 | Verified that `cascadeDeletePartner` auto-discovers `partner_id` tables and that no org-cascade, device, ticket-move, export-policy or org-merge list applies — with the citations | 2 (table), 13 (Step 5 proves the negative) |
| 13 | The registration list the spec missed (`ALLOWED_WITHOUT_CAPABILITY_CHECK`) | amendment 3, registered in 11 |
| 14 | `normalizeSendingDomain` per §4.1 shared half, table-driven with complete case lists | 3 |
| 15 | Identity rules of §4.4: `local_part` regex + consecutive dots + reserved names; `display_name` strip, 78 chars, no `@` or `://` | 3 |
| 16 | Shared constants and Zod schemas under the index's exact names | 3 |
| 17 | DTOs defined in full for W05's UI (domain row, identity, capability, list response, DNS record), including `SendingDomainDto.statusChangedAt` for the 72 h retry window and required `SenderIdentityDto.domain` / `.fromAddress`, pinned by a DTO-shape test | 3 |
| 18 | API-only rejections in `domainPolicy.ts`: hosted-only platform domains, consumer domains, public suffixes via `tldts`, `EMAIL_DOMAINS_DENYLIST` | 4 |
| 19 | All ten `EMAIL_DOMAINS_*` vars of §11 declared and validated; `requireIf` keyed only on `EMAIL_DOMAINS_PROVIDER`; `fake` refused in production; `static` refused when hosted; identical keys refused when hosted; one info line self-hosted | 5 |
| 20 | `services/emailDomains/config.ts`: `getEmailDomainsConfig`, `isPartnerLaneConfigured`, `EMAIL_DOMAINS_STATIC_ALLOWED` parsing (`domain` / `domain:partner-slug`), cap default 2000 hosted / unlimited self-hosted, `0` = unlimited | 5 |
| 21 | `.env.example`, `deploy/.env.example`, the `&api-env` anchor in `deploy/docker-compose.prod.yml` — **and** the root `docker-compose.yml`, which `envComposeParity.test.ts` also demands | 5 + amendment 2 |
| 22 | Deployment-mode matrix tests per §14, in the real `config/validate.test.ts` | 5 (Step 1) |
| 23 | `composeBindMounts.test.ts` checked (unaffected — it reads `volumes`, not `environment`) and an env-documentation contract test found (`envComposeParity.test.ts`) and satisfied | 5 (Steps 7, 8) |
| 24 | `provider.ts`: spec §5 types verbatim + `PartnerLaneMessage = RawEmailMessage` + `PartnerLaneSendFailure` | 6 |
| 25 | `providerRegistry.ts` with `getEmailDomainProvider` / `resetEmailDomainProviderForTests` | 6 |
| 26 | Find-then-create is W03 orchestration; W02 only guarantees the adapter inputs — stated explicitly and covered by tests | 6 (Interfaces), 9 |
| 27 | `resend` adapter written against the REAL installed signatures, version cited | 7 |
| 28 | Status mapping table §5.2 including unknown → `pending` + warning | 7 |
| 29 | Record normalisation to `ProviderDnsRecord` including the computed `fqdn` | 7 |
| 30 | Send-error classification into the four kinds over status code + error name, conservative `ambiguous` default, plus a recorded-fixture file W03's lab step refreshes | 7 |
| 31 | `static`: allow-list check with partner-slug binding, and how the slug reaches the adapter | 8 + amendment 4 |
| 32 | `static.send` via `getEmailService().deliverRaw`; SMTP/Mailgun/Resend sender refusal (550 5.7.60, 553, "domain not verified") → `domain_unusable`; everything else `ambiguous` / `message_rejected` | 8 |
| 33 | `fake`: deterministic `*.verify.test`, `*.fail.test`, `conflict.test`; `send` via `deliverRaw` | 8 |
| 34 | One adapter contract suite over `fake`, `static` and `resend` with a mocked SDK | 9 |
| 35 | `'custom_sending_domain'` added to `GatedCapability`, every enumerating site edited (API union, web union, web runtime `Set`, web label record), default-branch tests | 10 |
| 36 | `releaseSendingDomainsForPartner` in system context: outbox first for `provider_managed`, then null the handle, no provider calls | 11 |
| 37 | Called first in `cascadeDeletePartner` and in `finalizePartnerOffboarding`, with the exact insertion points and the DB-context reasoning | 11 |
| 38 | Integration suite in the correct directory covering all eight required cases plus constraint and idempotency cases | 12 |
| 39 | Verification: typecheck, listed unit files, `db:check-drift`, RLS + integration contract suites with the exact invocations, and the manual `breeze_app` forge | 13 |
