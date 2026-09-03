# Mobile Platform Attestation for L4 (`is_platform_bound`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop trusting the client-asserted `authenticator_devices.is_platform_bound` flag for L4 (critical-tier) approvals from mobile, and replace it with a server-verified platform attestation — Apple App Attest over a Secure-Enclave P-256 key on iOS, Android Key Attestation (+ Play Integrity) on Android.

**Architecture:** A new `platform_bound_basis` enum column on `authenticator_devices` records *why* a key is considered platform-bound, alongside the attestation evidence that proves it. The L4 rung in `escalateAchievedLevel` stops reading the bare boolean and instead requires a basis in a server-side trusted set plus a non-null `attestation_verified_at`. Mobile registration gains a two-step, challenge-bound protocol (`/mobile/challenge` → `/mobile/verify`) so the platform attestation and a registration-time proof-of-possession are both bound to a single-use server nonce. The mobile client grows a local Expo native module that mints a real hardware key (Secure Enclave P-256 / Android StrongBox-or-TEE) and produces the attestation.

**Tech Stack:** Hono + Drizzle + Postgres (RLS shape 6) + Redis; Expo SDK 57 / RN 0.86 with a local Expo module (Swift + Kotlin); `@peculiar/asn1-android` + `@peculiar/asn1-x509` (ASN.1), `@levischuck/tiny-cbor` (CBOR), `jose` (Play Integrity JWS) — all three already present in `pnpm-lock.yaml` transitively.

**Spec:** `docs/superpowers/specs/security-auth/2026-06-14-breeze-authenticator-step-up-approvals-design.md` (§5 the L1–L4 ladder, §7.2 platform-bound derivation). Issue: `LanternOps/breeze#1374`. This plan is the delta that closes the gap that spec's §5 left open.

---

## ⚠️ BLAST RADIUS: HIGH — auth surface

This plan changes the predicate that decides whether a **critical-tier approval** (PAM privilege elevation, tier-4 AI actions, destructive/blocklist overrides) is accepted. Getting it wrong in one direction re-opens a critical-tier bypass; getting it wrong in the other direction locks technicians out of approving incident-response elevations from their phone.

Per the repo's rigor calibration this is **full rigor**: red-first TDD on every task, integration tests against real Postgres for every migration, one independent code-review round per wave, and no wave merges without the RLS + integration contract suites run explicitly (they do **not** run under `pnpm test` — see Global Constraints).

Every wave that touches `authenticatorAssurance.ts`, `authenticator.ts`, or the migration set is in scope for that rigor. W07 (copy/telemetry) is not.

---

## Global Constraints

Copy these verbatim into every task's working assumptions.

**Tenancy / RLS (CLAUDE.md tenancy section — read before writing the migration):**
- `authenticator_devices` is **tenancy shape 6 (user-id scoped)**. Its RLS is already `ENABLE` + `FORCE` with policy `authenticator_devices_user_scope` (`USING (user_id = breeze_current_user_id() OR breeze_current_scope() = 'system')`), created in `apps/api/migrations/2026-06-14-a-authenticator-foundation.sql:47-63`. It is already registered in `USER_ID_SCOPED_TABLES` at `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:739`. **This plan adds columns only — no new policy, no new allowlist entry.**
- **This plan creates NO new table.** If you find yourself adding one (e.g. an `authenticator_device_attestations` child), STOP: it needs RLS + policies in the same migration, an entry in `USER_ID_SCOPED_TABLES`, and a `<table>Rls.integration.test.ts` suite. The plan deliberately puts attestation state on the existing device row instead, 1:1 with the immutable signing key it describes, to avoid exactly that.
- **All four cascade/export registration lists: NO entry required. Verified, not assumed.** `authenticator_devices` has no `org_id` column and no `device_id` column, so:
  | List | File | Required? |
  |---|---|---|
  | `CORE_ORG_CASCADE_DELETE_ORDER` | `apps/api/src/services/tenantCascade.ts` | **No** — no `org_id` column |
  | `CORE_DEVICE_CASCADE_DELETE_TABLES` | `apps/api/src/routes/devices/core.ts` | **No** — no `device_id` column (`mobile_device_id` FKs `mobile_devices`, not `devices`) |
  | `CORE_DEVICE_ORG_DENORMALIZED_TABLES` | `apps/api/src/routes/devices/core.ts` | **No** — same |
  | `CORE_TENANT_EXPORT_POLICY` | `apps/api/src/services/tenantExportPolicyRegistry.ts` | **No** — the export policy only classifies columns of tables that appear in `CORE_ORG_CASCADE_DELETE_ORDER` |
  Prove it before you write the migration, don't take this table's word for it:
  ```bash
  grep -n "authenticator_devices" apps/api/src/services/tenantCascade.ts \
    apps/api/src/services/tenantExportPolicyRegistry.ts \
    apps/api/src/routes/devices/core.ts
  # expected: zero matches
  ```
  Rows are reaped by `user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE` when the user is deleted, and `users` is itself org-cascaded.
- **DO NOT add a column to `approval_requests` or `elevation_requests`.** Both ARE in `CORE_ORG_CASCADE_DELETE_ORDER` and both are classified column-by-column in `CORE_TENANT_EXPORT_POLICY` (see `tenantExportPolicyRegistry.ts:199` for `elevation_requests`) — the export-policy contract is the one that fires on a **new column, not just a new table**, and it only fails under **Integration Tests**, never under `pnpm test`. This plan records the attestation basis of an accepted approval in the **audit-log `details` jsonb** and in a Prometheus counter label instead. If a future change really needs it on the row, add the column to `CORE_TENANT_EXPORT_POLICY` in the same PR, bucket `included` (an enum label, not a credential).
- **Partner-wide-first (epic #2135): no new config table is introduced, deliberately.** The only partner-scoped policy surface here is the existing `authenticator_policies`, which is already **shape 3, partner-axis** (`partner_id uuid PRIMARY KEY REFERENCES partners(id)`, policy `authenticator_policies_partner_access`). If a per-partner attestation exception or a per-partner enforcement date is ever needed, it is a **column on `authenticator_policies`**, gated on `canManagePartnerWidePolicies(auth)` (`apps/api/src/services/partnerWideAccess.ts`) — never a new org-scoped table. Do not create one.
- **DB context:** every read/write in this plan is on the request path and goes through the normal `db` handle from `apps/api/src/db/index.ts`. Do not reach for the bare pool. The one exception already in the codebase is `loadPartnerPolicy`, which takes its own system-context escape; do not add another.

**Migrations:**
- **Naming ceiling.** The newest committed migration as of this plan is `apps/api/migrations/2026-10-04-100003-portal-visibility-indexes.sql`. Migrations sort by `localeCompare`, so a new file **must sort after that** — a file named for today's real date (`2026-09-02-…`) would replay ahead of ~5 weeks of shipped migrations. Use the `YYYY-MM-DD-HHMMSS-<slug>.sql` form: `2026-10-05-100000-…`, `2026-10-05-100001-…`. **Re-check before every push** — `origin/main` may have gained a later-sorting migration since you branched; the pre-push hook runs `scripts/check-migration-naming.sh --against-ref origin/main` and will reject you. Rename if it fails (an unmerged migration is still editable).
- **Never** add to the closed `2026-08-06-…` date block.
- Idempotent: `ADD COLUMN IF NOT EXISTS`, enums via `DO $$ … EXCEPTION WHEN duplicate_object THEN NULL; END $$`, constraints via a `pg_constraint` existence check. Re-applying must be a true no-op.
- **No inner `BEGIN;`/`COMMIT;`** — `autoMigrate` already wraps each file in a transaction.
- **Any `UPDATE` must report its row count**, per CLAUDE.md: wrap in `DO $$ … GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN RAISE WARNING 'backfilled % rows', n; END IF; END $$;`. This plan's W01 backfill classifies pre-existing approver keys — if any of those rows ever evidence a critical-tier bypass you want a recorded count, including when it is 0.
- **Never edit a shipped migration.** Fix forward.
- After writing a migration: `pnpm db:check-drift`.

**CI traps (these have all bitten this repo before):**
- **A stacked PR gets ZERO CI.** `.github/workflows/ci.yml` triggers on `pull_request: branches: [main]`, so a PR whose base is a sibling wave branch runs no CI at all — and `gh pr checks` reads green. **Every wave in this plan targets `main`.** If you must stack, dispatch per branch: `gh workflow run CI --ref <branch>`.
- **`pnpm test` does NOT run the RLS or integration suites** (separate configs: `apps/api/vitest.config.rls.ts`, `apps/api/vitest.integration.config.ts`). Local green ≠ CI green. Every wave that touches the migration or `authenticatorAssurance.ts` must run them explicitly against a real database before the PR.
- **Never write `pnpm --filter <pkg> test -- --run <path>`** — pnpm forwards the literal `--` into argv, vitest stops flag parsing there, `--run` is swallowed as a positional filter, and the FULL suite runs in watch mode. Drop the `--`: `pnpm --filter @breeze/api test --run <path>`, or `cd apps/api && npx vitest run <path>`.
- **Vitest's path filter is a plain substring, not a glob.** `vitest run src/routes/authenticator/` (trailing slash) silently skips the sibling `src/routes/authenticator.test.ts`. List files explicitly, and check the reported file count.
- **`apps/mobile` vitest only includes `src/**/*.test.ts` — never `.tsx`** (`apps/mobile/vitest.config.ts:18-25`), and runs `environment: 'node'`. Native modules must be optional-required at runtime and mocked inline with `vi.mock(...)`; there are no `__mocks__` directories. Pattern to copy: `apps/mobile/src/services/approverDevice.test.ts:18-34`.
- Locale parity is enforced across **all 9 locale dirs** (`apps/web/src/locales/{de-DE,en,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}` + README/TERMINOLOGY). A key added to `en` only reddens every branch.

**Naming used consistently across every task below** (do not rename in one task and not another):
- Postgres enum type: `authenticator_platform_bound_basis`
- Drizzle enum export: `authenticatorPlatformBoundBasisEnum`
- TS type: `PlatformBoundBasis`
- Column → Drizzle field: `platform_bound_basis` → `platformBoundBasis`, `attestation_verified_at` → `attestationVerifiedAt`, `attestation_key_id` → `attestationKeyId`, `attested_public_key_sha256` → `attestedPublicKeySha256`, `attestation_evidence` → `attestationEvidence`, `app_integrity_verified_at` → `appIntegrityVerifiedAt`, `possession_verified_at` → `possessionVerifiedAt`, `public_key_alg` → `publicKeyAlg`
- Trusted set constant: `L4_TRUSTED_PLATFORM_BOUND_BASES` (exported from `apps/api/src/services/authenticatorAssurance.ts`)
- Env flag: `BREEZE_AUTHENTICATOR_ATTESTATION_ENFORCED`, read call-time via `authenticatorAttestationEnforced()` in `apps/api/src/config/env.ts`, **default `true`**
- Prometheus counter: `breeze_authenticator_l4_basis_total{basis,outcome}`
- Registration transcript domain tag: `breeze.authenticator.mobile-register.v1`
- Redis attempt key: `authenticator-attest:<attemptId>`, TTL 300s

**Apple / Google identifiers (already committed, use verbatim):**
- iOS bundle id `com.breeze.rmm` (`apps/mobile/app.json:11`); Apple Team ID `D8W6N2JYMA` (`apps/mobile/eas.json:35`) → App Attest `appId` = `D8W6N2JYMA.com.breeze.rmm`.
- Android package `com.breeze.rmm` (`apps/mobile/app.json:43`).

---

## Design decisions (advisor quorum, 2026-09-02)

Convened per CLAUDE.md "Working Style → Design decisions": my position vs. an independent Codex `gpt-5.6-sol` `xhigh` read-only review. Recording the outcomes because several are counter-intuitive and an executor will otherwise "fix" them back.

1. **The current iOS key is not hardware-backed at all — and that is the load-bearing finding.** `react-native-biometrics` 3.0.1 mints an **RSA-2048** key (`apps/mobile/src/services/hardwareSigner.ts:21`, verified server-side as RSA-SHA256 at `apps/api/src/services/mobileHwKey.ts:9-15`). The Apple Secure Enclave supports **only 256-bit EC** private keys, so an RSA key is a Keychain key with a biometric ACL — biometric-gated, but not Secure-Enclave-resident. The comments at `hardwareSigner.ts:11-13` and `apps/mobile/src/services/approverDevice.ts:4` that describe it as Secure Enclave are **wrong**, and this plan corrects them. *(Both advisors agreed. Verified against Apple's `kSecAttrTokenIDSecureEnclave` documentation and the code; not merely inferred.)*
2. **iOS: replace the signer with a Secure-Enclave P-256 key, and use App Attest to attest the app instance and bind that key.** App Attest alone attests *its own* App Attest key and a genuine app instance; folding an RSA SPKI into `clientDataHash` proves the instance vouched for that SPKI, not that the private key lives in hardware. So "keep RSA + App Attest" cannot honestly set `is_platform_bound=true`. The enum reserves `ios_keychain_rsa_app_attest` for that weaker combination and deliberately leaves it **out** of the L4 trusted set. *(Both advisors agreed.)*
3. **Android: Key Attestation is primary; Play Integrity is a separate, complementary gate.** The issue's decision text says "Play Integrity", but Play Integrity attests app/device/Play posture — it says nothing about where a given key lives. Android **Key Attestation** (the KeyStore certificate chain carrying `KeyDescription`, OID `1.3.6.1.4.1.11129.2.1.17`) is what proves `keyMintSecurityLevel ∈ {TrustedEnvironment, StrongBox}` and binds a single-use `attestationChallenge`. This plan implements Key Attestation as the thing that sets the basis, and Play Integrity as an independent app-integrity signal recorded in `app_integrity_verified_at`. Note `attestationSecurityLevel` and `keyMintSecurityLevel` are two different fields; the latter is the one that describes the approval key. *(Both advisors agreed. This is a documented deviation from the literal wording of the issue decision — flagged for approval.)*
4. **Attestation state goes on `authenticator_devices` as columns, not a child table.** One device row is one immutable signing key, so its registration attestation is 1:1. Columns keep the hot L4 lookup a single PK read with no "latest valid child row" ambiguity, and — decisively for this repo — introduce **no new RLS surface and no new registration-list obligations**. Failed attempts belong in the audit log; a replaced key is a new device row. *(Both advisors agreed.)*
5. **Grandfathering: fail closed, but sequence the flip so it is measurable and revertible.** Codex argued for a hard `UPDATE … SET is_platform_bound = false` on every existing `mobile_hw_key` row in the migration; my position was a dated grace window. **Resolution — neither, take the strictly better third option:** the migration only *classifies* (`platform_bound_basis = 'legacy_unattested'`, boolean untouched), and the **code predicate** is what refuses `legacy_unattested` at L4, behind `BREEZE_AUTHENTICATOR_ATTESTATION_ENFORCED` **defaulting to `true`**. Same fail-closed end state as the hard flip, on the same day — but revertible in one env var instead of a second migration, and the counter emits the would-have-denied basis on every path so the blast radius is visible either way. A dated grace window is rejected outright: it knowingly leaves a critical-tier bypass open on a wall clock.
   - **Residual risk, stated plainly:** a technician whose only registered approver device is a phone loses the ability to approve critical-tier requests the moment W01 deploys, until they re-enroll on an attested build (W05/W06). This is bounded by two things: (a) browser WebAuthn platform keys remain L4-eligible throughout, so a tech at a console is unaffected; (b) for partners **not** enforcing (`isEnforcing(policy)` false), the miss records `graceDowngrade` and the approval still goes through. Only *enforcing* partners see a hard denial. **Open question Q1 asks Todd whether to accept that on day one or dark-run first.**
6. **The registration protocol needs a server challenge, so the "deferred proof-of-possession" property changes.** Both App Attest and Key Attestation must bind a single-use server nonce, which forces a challenge round-trip that today's single-POST `/authenticator/devices` does not have. While adding it, move PoP into registration: the client signs the registration transcript with the approval key under a biometric prompt, and the server records `possession_verified_at`. `last_used_at` keeps its existing meaning (null = never used for a real approval) and the UI's "pending" badge keeps working. Note the current "PENDING until first signature" property is **display-only, not a gate** — `apps/api/src/routes/approvals.ts:687-696` issues a mobile nonce for any non-disabled mobile row without consulting `last_used_at`. *(Verified by reading that code, not inferred. Both advisors agreed.)*
7. **Browser WebAuthn keys are an explicit, documented weaker exception.** `generateApproverRegistrationOptions` requests `attestationType: 'none'` (`apps/api/src/services/approverWebAuthn.ts:106`) and derives platform-bound from `deviceType === 'singleDevice' && !backedUp` (`approverWebAuthn.ts:146`) — backup-eligibility flags, not hardware attestation. Tightening that is **out of scope for this plan** (it would change the browser L4 story mid-flight and is a separate decision), so `webauthn_backup_flags` stays in the L4 trusted set and the plan names the exception rather than hiding it. Raised as **open question Q3**.

---

## File Structure

**New — API**
| Path | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-05-100000-authenticator-attestation-state.sql` | Enum + attestation columns + classify-existing backfill |
| `apps/api/migrations/2026-10-05-100001-authenticator-public-key-alg.sql` | `public_key_alg` column (W02) |
| `apps/api/src/services/authenticatorAttestation.ts` | Registration attempt lifecycle (Redis), transcript derivation, verifier dispatch |
| `apps/api/src/services/authenticatorAttestation.test.ts` | Unit tests for the above |
| `apps/api/src/services/attestation/appleAppAttest.ts` | iOS App Attest attestation-object verifier (pure) |
| `apps/api/src/services/attestation/appleAppAttest.test.ts` | Unit tests + synthetic-CA fixtures |
| `apps/api/src/services/attestation/appleAppAttestRootCA.pem` | Apple App Attestation Root CA (public) |
| `apps/api/src/services/attestation/androidKeyAttestation.ts` | Android KeyStore cert-chain + `KeyDescription` verifier (pure) |
| `apps/api/src/services/attestation/androidKeyAttestation.test.ts` | Unit tests + synthetic-CA fixtures |
| `apps/api/src/services/attestation/googleHardwareAttestationRoots.pem` | Google hardware attestation roots (public) |
| `apps/api/src/services/attestation/playIntegrity.ts` | Play Integrity verdict verification (JWS via `jose`) |
| `apps/api/src/services/attestation/playIntegrity.test.ts` | Unit tests |
| `apps/api/src/__tests__/integration/authenticatorAttestation.integration.test.ts` | Migration + L4 predicate against real Postgres |

**Modified — API**
| Path | Change |
|---|---|
| `apps/api/src/db/schema/authenticatorDevices.ts` | New enum + columns; rewrite the stale `isPlatformBound` comment |
| `apps/api/src/services/authenticatorAssurance.ts` | `VerifiedFactor` carries the basis; L4 predicate rewritten |
| `apps/api/src/services/mobileHwKey.ts` | ES256/P-256 verification alongside RS256 |
| `apps/api/src/routes/authenticator.ts` | New `/devices/mobile/challenge` + `/devices/mobile/verify`; legacy `/devices` downgraded |
| `apps/api/src/config/env.ts` | `authenticatorAttestationEnforced()`, Play Integrity config |
| `apps/api/src/services/anomalyMetrics.ts` | `recordAuthenticatorL4Basis` shim |
| `apps/api/src/routes/metrics.ts` | `breeze_authenticator_l4_basis_total` counter + zero-init |
| `packages/shared/src/validators/authenticator.ts` | `mobileAttestationVerifySchema`, `platformBoundBasis` on the device DTO |

**Modified / new — mobile**
| Path | Change |
|---|---|
| `apps/mobile/modules/breeze-attestation/**` | New local Expo module (Swift + Kotlin + TS) |
| `apps/mobile/src/services/hardwareSigner.ts` | New `AttestingSigner` interface; correct the Secure Enclave comments |
| `apps/mobile/src/services/approverDevice.ts` | Two-step attested registration; new outcomes |
| `apps/mobile/src/navigation/approverBannerCopy.ts` | `unattested` severity copy |
| `apps/mobile/app.json` | App Attest entitlement, Play Integrity, module plugin |

**Modified — web**
| Path | Change |
|---|---|
| `apps/web/src/stores/authenticator.ts` | `platformBoundBasis` on `ApproverDevice` |
| `apps/web/src/components/settings/ApproverDevicesSection.tsx` | Honest badge: attested vs. unattested |
| `apps/web/src/locales/*/settings.json` | New keys in **all 9** locales |

---

## Wave / task map

| Wave | Deliverable | Independently shippable? |
|---|---|---|
| **W01** | Attestation columns + fail-closed L4 predicate + flag + metric (API only) | Yes — closes the bypass with no client change |
| **W02** | Challenge/verify registration protocol + ES256 support (API only) | Yes — new endpoints unused until W05 |
| **W03** | Apple App Attest verifier (API only) | Yes — pure module, wired behind platform dispatch |
| **W04** | Android Key Attestation + Play Integrity verifiers (API only) | Yes — same |
| **W05** | iOS: Expo native module (SE P-256 + App Attest) + client wiring | Yes — needs W02+W03 deployed |
| **W06** | Android: native module (StrongBox/TEE + Key Attestation + Play Integrity) | Yes — needs W02+W04 deployed |
| **W07** | Surfacing + rollout: web badge, mobile banner, alerting, docs | Yes |

Waves 3 and 4 are file-disjoint from each other and can run in parallel once W02 lands. **Every wave branches from `main` and targets `main`** (stacked PRs get no CI).

---

# Wave 01 — Attestation state + fail-closed L4 predicate

**Why first:** this is the wave that actually closes the reported gap. After it, an unattested mobile key can no longer reach L4, regardless of what any client asserts. Everything after it is about giving technicians a way back to L4.

Branch: `feature/1374-mobile-attestation/w01-fail-closed`

### Task 1: Migration — enum, columns, classify existing rows

**Files:**
- Create: `apps/api/migrations/2026-10-05-100000-authenticator-attestation-state.sql`
- Modify: `apps/api/src/db/schema/authenticatorDevices.ts`
- Test: `apps/api/src/__tests__/integration/authenticatorAttestation.integration.test.ts`

**Interfaces:**
- Produces: Postgres enum `authenticator_platform_bound_basis`; columns `platform_bound_basis`, `attestation_verified_at`, `attestation_key_id`, `attested_public_key_sha256`, `attestation_evidence`, `app_integrity_verified_at`, `possession_verified_at` on `authenticator_devices`. Drizzle exports `authenticatorPlatformBoundBasisEnum` and `PlatformBoundBasis`.

- [ ] **Step 1: Confirm the migration name still sorts last**

```bash
ls apps/api/migrations/*.sql | sed 's|.*/||' | sort | tail -3
git fetch origin main --quiet && git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -3
```
Expected: nothing sorts after `2026-10-05-100000-…`. If something does, bump to the next free `2026-10-05-1000NN-` (or a later date) and use that name everywhere below.

- [ ] **Step 2: Write the failing integration test**

Create `apps/api/src/__tests__/integration/authenticatorAttestation.integration.test.ts`. Follow the surrounding suites in that directory for DB bootstrap (`authenticatorRls.integration.test.ts` is the closest neighbour — copy its setup/teardown shape).

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../../db';

describe('authenticator_devices attestation state (migration 2026-10-05-100000)', () => {
  it('exposes the platform_bound_basis enum with exactly the expected labels', async () => {
    const rows = await db.execute(sql`
      SELECT e.enumlabel AS label
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'authenticator_platform_bound_basis'
      ORDER BY e.enumsortorder
    `);
    expect((rows as unknown as { label: string }[]).map((r) => r.label)).toEqual([
      'unattested',
      'legacy_unattested',
      'webauthn_backup_flags',
      'ios_keychain_rsa_app_attest',
      'ios_se_p256_app_attest',
      'android_tee_key_attestation',
      'android_strongbox_key_attestation',
    ]);
  });

  it('adds every attestation column with the right nullability and default', async () => {
    const rows = (await db.execute(sql`
      SELECT column_name, is_nullable, column_default, data_type
      FROM information_schema.columns
      WHERE table_name = 'authenticator_devices'
        AND column_name IN (
          'platform_bound_basis','attestation_verified_at','attestation_key_id',
          'attested_public_key_sha256','attestation_evidence',
          'app_integrity_verified_at','possession_verified_at'
        )
      ORDER BY column_name
    `)) as unknown as { column_name: string; is_nullable: string; column_default: string | null }[];
    expect(rows).toHaveLength(7);
    const basis = rows.find((r) => r.column_name === 'platform_bound_basis')!;
    expect(basis.is_nullable).toBe('NO');
    expect(basis.column_default).toContain("'unattested'");
    const evidence = rows.find((r) => r.column_name === 'attestation_evidence')!;
    expect(evidence.is_nullable).toBe('NO');
    // Every other column is nullable — an unattested row has nothing to record.
    for (const name of ['attestation_verified_at','attestation_key_id','attested_public_key_sha256','app_integrity_verified_at','possession_verified_at']) {
      expect(rows.find((r) => r.column_name === name)!.is_nullable).toBe('YES');
    }
  });

  it('classifies every pre-existing mobile_hw_key row as legacy_unattested and leaves the boolean alone', async () => {
    // The migration's backfill is what this asserts. A row inserted AFTER the
    // migration takes the 'unattested' default instead, which is why the
    // fixture is written with an explicit basis rather than relying on state.
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n
      FROM authenticator_devices
      WHERE kind = 'mobile_hw_key'
        AND platform_bound_basis NOT IN ('legacy_unattested','unattested',
            'ios_se_p256_app_attest','android_tee_key_attestation','android_strongbox_key_attestation')
    `)) as unknown as { n: number }[];
    expect(rows[0].n).toBe(0);
  });

  it('classifies every pre-existing webauthn_platform row as webauthn_backup_flags', async () => {
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n
      FROM authenticator_devices
      WHERE kind = 'webauthn_platform' AND platform_bound_basis <> 'webauthn_backup_flags'
    `)) as unknown as { n: number }[];
    expect(rows[0].n).toBe(0);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/authenticatorAttestation.integration.test.ts
```
Expected: FAIL — the enum does not exist, so the first test returns `[]`.

- [ ] **Step 4: Write the migration**

Create `apps/api/migrations/2026-10-05-100000-authenticator-attestation-state.sql`:

```sql
-- #1374 — server-verified platform attestation for L4 (critical-tier) approvals.
--
-- Until now `authenticator_devices.is_platform_bound` was set to TRUE
-- unconditionally for every mobile_hw_key registration (routes/authenticator.ts)
-- with no attestation of any kind, while escalateAchievedLevel() gated L4 on it.
-- This migration adds the state needed to record WHY a key is considered
-- platform-bound. It deliberately does NOT change is_platform_bound: the code
-- predicate refuses an untrusted basis, which is revertible via
-- BREEZE_AUTHENTICATOR_ATTESTATION_ENFORCED without a second migration.
--
-- Shape 6 (user-id scoped). RLS is already ENABLE + FORCE with policy
-- authenticator_devices_user_scope (2026-06-14-a-authenticator-foundation.sql).
-- Columns only — no new policy, no new table, no cascade/export list entry
-- (the table has no org_id and no device_id).

-- 1. Basis enum -------------------------------------------------------------
-- Ordered weakest → strongest so enumsortorder is meaningful in queries.
DO $$ BEGIN
  CREATE TYPE authenticator_platform_bound_basis AS ENUM (
    'unattested',                     -- registered post-#1374 with no attestation
    'legacy_unattested',              -- registered pre-#1374; is_platform_bound was forced true
    'webauthn_backup_flags',          -- browser: singleDevice && !backedUp, NOT hardware attestation
    'ios_keychain_rsa_app_attest',    -- App Attest verified, but the signing key is RSA/Keychain (NOT Secure Enclave)
    'ios_se_p256_app_attest',         -- App Attest verified AND the signing key is a Secure Enclave P-256 key
    'android_tee_key_attestation',    -- Key Attestation verified, keyMintSecurityLevel = TrustedEnvironment
    'android_strongbox_key_attestation' -- Key Attestation verified, keyMintSecurityLevel = StrongBox
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Columns ----------------------------------------------------------------
ALTER TABLE authenticator_devices
  ADD COLUMN IF NOT EXISTS platform_bound_basis authenticator_platform_bound_basis
    NOT NULL DEFAULT 'unattested';
ALTER TABLE authenticator_devices
  ADD COLUMN IF NOT EXISTS attestation_verified_at timestamptz;
-- Apple App Attest keyId (base64) / Android attestation leaf serial. Not secret.
ALTER TABLE authenticator_devices
  ADD COLUMN IF NOT EXISTS attestation_key_id text;
-- SHA-256 of the canonical SPKI DER the attestation actually bound. The L4
-- predicate re-derives this from public_key and compares, so an attestation
-- verified for key A can never vouch for a substituted key B.
ALTER TABLE authenticator_devices
  ADD COLUMN IF NOT EXISTS attested_public_key_sha256 bytea;
-- NORMALIZED, SERVER-VERIFIED claims only (securityLevel, verifiedBootState,
-- appId, verifierVersion, evidence digests). Never the raw client blob, and
-- never an unverified client assertion.
ALTER TABLE authenticator_devices
  ADD COLUMN IF NOT EXISTS attestation_evidence jsonb NOT NULL DEFAULT '{}'::jsonb;
-- Android Play Integrity verdict time. Null on iOS, where App Attest covers
-- app integrity itself.
ALTER TABLE authenticator_devices
  ADD COLUMN IF NOT EXISTS app_integrity_verified_at timestamptz;
-- Registration-time proof-of-possession (W02). Distinct from last_used_at,
-- which keeps its meaning: null = never used for a real approval.
ALTER TABLE authenticator_devices
  ADD COLUMN IF NOT EXISTS possession_verified_at timestamptz;

-- 3. Classify existing rows -------------------------------------------------
-- Row counts are RAISEd because these rows are exactly the ones that could
-- evidence a critical-tier bypass. A recorded 0 is as useful as a recorded 500.
DO $$
DECLARE n integer;
BEGIN
  UPDATE authenticator_devices
     SET platform_bound_basis = 'legacy_unattested'
   WHERE kind = 'mobile_hw_key'
     AND platform_bound_basis = 'unattested';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING '#1374: classified % pre-existing mobile_hw_key rows as legacy_unattested (these lose L4 eligibility)', n;

  UPDATE authenticator_devices
     SET platform_bound_basis = 'webauthn_backup_flags'
   WHERE kind = 'webauthn_platform'
     AND platform_bound_basis = 'unattested';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING '#1374: classified % webauthn_platform rows as webauthn_backup_flags (backup-eligibility flags, not hardware attestation)', n;
END $$;

-- 4. Integrity constraint ---------------------------------------------------
-- A basis that claims real attestation must carry the evidence that proves it.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'authenticator_devices_attested_basis_chk'
  ) THEN
    ALTER TABLE authenticator_devices
      ADD CONSTRAINT authenticator_devices_attested_basis_chk CHECK (
        platform_bound_basis IN ('unattested','legacy_unattested','webauthn_backup_flags')
        OR (attestation_verified_at IS NOT NULL AND attested_public_key_sha256 IS NOT NULL)
      );
  END IF;
END $$;
```

- [ ] **Step 5: Update the Drizzle schema**

In `apps/api/src/db/schema/authenticatorDevices.ts`, add the enum next to `authenticatorKindEnum`:

```ts
export const authenticatorPlatformBoundBasisEnum = pgEnum('authenticator_platform_bound_basis', [
  'unattested',
  'legacy_unattested',
  'webauthn_backup_flags',
  'ios_keychain_rsa_app_attest',
  'ios_se_p256_app_attest',
  'android_tee_key_attestation',
  'android_strongbox_key_attestation',
]);

export type PlatformBoundBasis = (typeof authenticatorPlatformBoundBasisEnum.enumValues)[number];
```

Replace the existing `isPlatformBound` column comment and add the new columns (needs `customType`-free `bytea`; use Drizzle's `customType` helper only if the codebase already has one — otherwise `text` is wrong here, so import `bytea` support via `customType` in this file):

```ts
import { customType } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});
```

```ts
    // DERIVED, NOT ASSERTED. For webauthn_platform this comes from the
    // registration response (singleDevice && !backedUp). For mobile_hw_key it
    // is set only after a verified platform attestation (#1374).
    //
    // Do NOT gate L4 on this boolean alone — read `platformBoundBasis` too.
    // `L4_TRUSTED_PLATFORM_BOUND_BASES` in services/authenticatorAssurance.ts
    // is the single source of truth for which bases may reach critical tier.
    isPlatformBound: boolean('is_platform_bound').notNull(),
    /** WHY this key counts as platform-bound. See #1374. */
    platformBoundBasis: authenticatorPlatformBoundBasisEnum('platform_bound_basis')
      .notNull()
      .default('unattested'),
    attestationVerifiedAt: timestamp('attestation_verified_at', { withTimezone: true }),
    /** Apple App Attest keyId (base64) / Android attestation leaf serial. */
    attestationKeyId: text('attestation_key_id'),
    /** SHA-256 of the canonical SPKI DER the attestation bound. */
    attestedPublicKeySha256: bytea('attested_public_key_sha256'),
    /** Normalized, server-VERIFIED claims only — never a raw client blob. */
    attestationEvidence: jsonb('attestation_evidence').notNull().default({}),
    appIntegrityVerifiedAt: timestamp('app_integrity_verified_at', { withTimezone: true }),
    /** Registration-time PoP (#1374 W02). Distinct from lastUsedAt. */
    possessionVerifiedAt: timestamp('possession_verified_at', { withTimezone: true }),
```

- [ ] **Step 6: Run the migration and the test**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate
pnpm db:check-drift          # must report no drift
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/authenticatorAttestation.integration.test.ts
```
Expected: migrate prints both `WARNING: #1374: classified N …` lines; drift clean; all four tests PASS.

- [ ] **Step 7: Prove the registration lists really need no entry**

```bash
grep -n "authenticator_devices" apps/api/src/services/tenantCascade.ts \
  apps/api/src/services/tenantExportPolicyRegistry.ts \
  apps/api/src/routes/devices/core.ts
```
Expected: zero matches (the table has no `org_id` and no `device_id`). Paste the empty result into the PR body — this is the check code review has historically missed 5/5 times.

- [ ] **Step 8: Commit**

```bash
git add apps/api/migrations/2026-10-05-100000-authenticator-attestation-state.sql \
        apps/api/src/db/schema/authenticatorDevices.ts \
        apps/api/src/__tests__/integration/authenticatorAttestation.integration.test.ts
git commit -m "feat(auth): record platform_bound_basis + attestation state on authenticator_devices (#1374)"
```

---

### Task 2: Fail-closed L4 predicate

**Files:**
- Modify: `apps/api/src/services/authenticatorAssurance.ts`
- Modify: `apps/api/src/config/env.ts`
- Test: `apps/api/src/services/authenticatorAssurance.test.ts`

**Interfaces:**
- Consumes: `PlatformBoundBasis` from Task 1.
- Produces: `export const L4_TRUSTED_PLATFORM_BOUND_BASES: ReadonlySet<PlatformBoundBasis>`; `VerifiedFactor` gains `platformBoundBasis: PlatformBoundBasis` and `attestationVerifiedAt: Date | null`; `authenticatorAttestationEnforced(): boolean` in `config/env.ts`.

- [ ] **Step 1: Write the failing unit tests**

Append to `apps/api/src/services/authenticatorAssurance.test.ts`. The existing `criticalCtx` helper at line ~424 already takes `{ reauth, isPlatformBound, challengeAgeMs }` — extend it with `platformBoundBasis` and `attestationVerifiedAt`, defaulting to a passing combination (`'ios_se_p256_app_attest'` / `new Date()`) so every existing test keeps its meaning.

```ts
describe('#1374 — L4 requires a trusted platform-bound basis, not just the boolean', () => {
  it('denies critical when the basis is legacy_unattested even though isPlatformBound is true', async () => {
    await expect(
      assertApprovalAssurance(criticalCtx({
        reauth: true,
        isPlatformBound: true,
        platformBoundBasis: 'legacy_unattested',
        attestationVerifiedAt: null,
      }))
    ).rejects.toThrow(StepUpRequiredError);
  });

  it('denies critical for an iOS RSA-keychain App Attest basis (attested app, unattested key)', async () => {
    await expect(
      assertApprovalAssurance(criticalCtx({
        reauth: true,
        isPlatformBound: true,
        platformBoundBasis: 'ios_keychain_rsa_app_attest',
        attestationVerifiedAt: new Date(),
      }))
    ).rejects.toThrow(StepUpRequiredError);
  });

  it('denies critical when a trusted basis carries no attestation_verified_at', async () => {
    await expect(
      assertApprovalAssurance(criticalCtx({
        reauth: true,
        isPlatformBound: true,
        platformBoundBasis: 'ios_se_p256_app_attest',
        attestationVerifiedAt: null,
      }))
    ).rejects.toThrow(StepUpRequiredError);
  });

  it.each([
    'ios_se_p256_app_attest',
    'android_tee_key_attestation',
    'android_strongbox_key_attestation',
    'webauthn_backup_flags',
  ] as const)('allows critical for trusted basis %s', async (basis) => {
    const d = await assertApprovalAssurance(criticalCtx({
      reauth: true, isPlatformBound: true, platformBoundBasis: basis, attestationVerifiedAt: new Date(),
    }));
    expect(d.decidedAssuranceLevel).toBe(4);
  });

  it('allows a legacy basis at critical when enforcement is switched OFF (break-glass)', async () => {
    process.env.BREEZE_AUTHENTICATOR_ATTESTATION_ENFORCED = 'false';
    try {
      const d = await assertApprovalAssurance(criticalCtx({
        reauth: true, isPlatformBound: true, platformBoundBasis: 'legacy_unattested', attestationVerifiedAt: null,
      }));
      expect(d.decidedAssuranceLevel).toBe(4);
    } finally {
      delete process.env.BREEZE_AUTHENTICATOR_ATTESTATION_ENFORCED;
    }
  });

  it('still denies critical for a HIGH-tier-only device regardless of basis (isPlatformBound false)', async () => {
    await expect(
      assertApprovalAssurance(criticalCtx({
        reauth: true, isPlatformBound: false, platformBoundBasis: 'ios_se_p256_app_attest', attestationVerifiedAt: new Date(),
      }))
    ).rejects.toThrow(StepUpRequiredError);
  });

  it('does not affect the high tier — L3 never consults the basis', async () => {
    const d = await assertApprovalAssurance(highApprovalCtx({
      isPlatformBound: false,
    }));
    expect(d.decidedAssuranceLevel).toBe(3);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
cd apps/api && npx vitest run src/services/authenticatorAssurance.test.ts
```
Expected: FAIL — `criticalCtx` does not accept `platformBoundBasis`, and every basis currently reaches L4.

- [ ] **Step 3: Add the flag to `config/env.ts`**

The file already has both flag idioms (`env.ts:8-11` truthy/falsey vocabulary, `env.ts:111-113` the call-time shape). Use the **call-time** form — it is flippable in tests without a module reload, and the header comment at `env.ts:100-110` says call-time is preferred for rollout gates.

```ts
/**
 * #1374 — when true (the default), an L4 (critical-tier) approval requires the
 * approver device's `platform_bound_basis` to be in
 * `L4_TRUSTED_PLATFORM_BOUND_BASES`, not merely `is_platform_bound = true`.
 *
 * DEFAULT TRUE, deliberately: pre-#1374 mobile registrations forced
 * is_platform_bound=true with no attestation of any kind, so leaving this off
 * leaves a critical-tier bypass open. Set to `false` ONLY as a break-glass
 * revert — it re-opens that bypass for every legacy mobile key.
 */
export function authenticatorAttestationEnforced(): boolean {
  return envFlag('BREEZE_AUTHENTICATOR_ATTESTATION_ENFORCED', true);
}
```

- [ ] **Step 4: Rewrite the L4 rung**

In `apps/api/src/services/authenticatorAssurance.ts`:

```ts
import { authenticatorAttestationEnforced } from '../config/env';
import type { PlatformBoundBasis } from '../db/schema/authenticatorDevices';

/**
 * The ONLY bases that may reach L4 (critical tier).
 *
 * Deliberately excluded:
 *  - `unattested` / `legacy_unattested` — no attestation was ever verified.
 *  - `ios_keychain_rsa_app_attest` — App Attest proves a genuine app instance
 *    vouched for the SPKI; it does NOT prove the RSA private key lives in
 *    hardware. The Apple Secure Enclave holds only P-256 keys, so an RSA
 *    Keychain key is biometric-gated but software-resident (#1374).
 *
 * `webauthn_backup_flags` IS included, as a documented weaker exception:
 * browser registration requests `attestationType: 'none'` and derives
 * platform-bound from `singleDevice && !backedUp` (services/approverWebAuthn.ts).
 * Tightening that is a separate decision — see #1374 open question Q3. Do not
 * quietly remove it here without closing that question.
 */
export const L4_TRUSTED_PLATFORM_BOUND_BASES: ReadonlySet<PlatformBoundBasis> = new Set([
  'webauthn_backup_flags',
  'ios_se_p256_app_attest',
  'android_tee_key_attestation',
  'android_strongbox_key_attestation',
]);
```

Extend `VerifiedFactor`:

```ts
interface VerifiedFactor {
  decidedVia: 'webauthn_platform' | 'mobile_hw_key';
  authenticatorDeviceId: string;
  isPlatformBound: boolean;
  /** WHY the device counts as platform-bound (#1374). */
  platformBoundBasis: PlatformBoundBasis;
  /** When the attestation behind that basis was verified. Null = never. */
  attestationVerifiedAt: Date | null;
  challengeIssuedAt: number;
}
```

Replace the L4 branch of `escalateAchievedLevel`:

```ts
  // L4 (critical): L3 recency + a genuinely platform-bound key + fresh re-auth.
  //
  // #1374: the boolean alone is not enough. Pre-#1374 mobile registration set
  // is_platform_bound=true unconditionally with no attestation, so a software
  // RSA key read as an L4-capable hardware factor. L4 now additionally requires
  // a basis in L4_TRUSTED_PLATFORM_BOUND_BASES with a recorded verification
  // time. Failure keeps producing StepUpRequiredError(4, 3) — the achieved
  // level is genuinely L3, and a critical tier is never silently downgraded.
  if (!factor.isPlatformBound) {
    throw new StepUpRequiredError(4, 3);
  }
  const basisTrusted =
    L4_TRUSTED_PLATFORM_BOUND_BASES.has(factor.platformBoundBasis) &&
    factor.attestationVerifiedAt !== null;
  if (!basisTrusted && authenticatorAttestationEnforced()) {
    throw new StepUpRequiredError(4, 3);
  }
  if (!ctx.reauthVerified) {
    throw new ReauthRequiredError();
  }
  return 4;
```

**Note the ordering deliberately keeps `attestationVerifiedAt !== null` inside `basisTrusted`**, so `webauthn_backup_flags` rows — which the migration classified but which have no `attestation_verified_at` — would fail. Fix that in the migration by ALSO stamping `attestation_verified_at = created_at` for `webauthn_platform` rows, OR drop the null check for the webauthn basis. **Take the second option** (the flag genuinely was derived at registration, there is no attestation to time-stamp):

```ts
  const basisTrusted =
    L4_TRUSTED_PLATFORM_BOUND_BASES.has(factor.platformBoundBasis) &&
    (factor.platformBoundBasis === 'webauthn_backup_flags' || factor.attestationVerifiedAt !== null);
```

- [ ] **Step 5: Populate the new fields at both verify sites**

In `verifyWebauthnFactor` and `verifyMobileFactor`, the `db.select()` is already `select()` (all columns), so the fields are present on `device`. Add to both return objects:

```ts
    platformBoundBasis: device.platformBoundBasis,
    attestationVerifiedAt: device.attestationVerifiedAt ?? null,
```

- [ ] **Step 6: Run the tests**

```bash
cd apps/api && npx vitest run src/services/authenticatorAssurance.test.ts src/routes/authenticator.test.ts
```
Expected: PASS, including the pre-existing suites. If `authenticator.test.ts` fails on the Drizzle column mock, add the new columns to the mock map at `apps/api/src/routes/authenticator.test.ts:143` (it enumerates column names explicitly).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/authenticatorAssurance.ts apps/api/src/services/authenticatorAssurance.test.ts apps/api/src/config/env.ts apps/api/src/routes/authenticator.test.ts
git commit -m "feat(auth): gate L4 on a trusted platform_bound_basis, not the bare boolean (#1374)"
```

---

### Task 3: Metric + audit detail for every L4 basis decision

**Files:**
- Modify: `apps/api/src/services/anomalyMetrics.ts`
- Modify: `apps/api/src/routes/metrics.ts`
- Modify: `apps/api/src/services/authenticatorAssurance.ts`
- Test: `apps/api/src/services/authenticatorAssurance.test.ts`

**Interfaces:**
- Produces: `recordAuthenticatorL4Basis(basis: string, outcome: 'allowed' | 'denied' | 'would_deny'): void` exported from `apps/api/src/services/anomalyMetrics.ts`.

**Why this shape:** service code must not import `routes/metrics` (import cycle) — the repo's answer is the recorder shim in `anomalyMetrics.ts`, installed at startup via `setAnomalyMetricsRecorder` and a no-op until then. Follow that exactly.

- [ ] **Step 1: Write the failing test**

```ts
it('records the basis and outcome on every critical-tier decision', async () => {
  const spy = vi.spyOn(anomalyMetrics, 'recordAuthenticatorL4Basis');
  await expect(assertApprovalAssurance(criticalCtx({
    reauth: true, isPlatformBound: true, platformBoundBasis: 'legacy_unattested', attestationVerifiedAt: null,
  }))).rejects.toThrow(StepUpRequiredError);
  expect(spy).toHaveBeenCalledWith('legacy_unattested', 'denied');
});

it('records would_deny (not denied) when enforcement is off, so the blast radius is visible either way', async () => {
  process.env.BREEZE_AUTHENTICATOR_ATTESTATION_ENFORCED = 'false';
  const spy = vi.spyOn(anomalyMetrics, 'recordAuthenticatorL4Basis');
  try {
    await assertApprovalAssurance(criticalCtx({
      reauth: true, isPlatformBound: true, platformBoundBasis: 'legacy_unattested', attestationVerifiedAt: null,
    }));
    expect(spy).toHaveBeenCalledWith('legacy_unattested', 'would_deny');
  } finally {
    delete process.env.BREEZE_AUTHENTICATOR_ATTESTATION_ENFORCED;
  }
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd apps/api && npx vitest run src/services/authenticatorAssurance.test.ts
```
Expected: FAIL — `recordAuthenticatorL4Basis` does not exist.

- [ ] **Step 3: Add the shim**

In `apps/api/src/services/anomalyMetrics.ts`, following the existing `recordFailedLogin` shape (declare on the recorder interface, export a no-op-until-installed wrapper):

```ts
/**
 * #1374 — every critical-tier (L4) assurance decision, labelled by the
 * device's platform_bound_basis. `would_deny` fires when the basis is untrusted
 * but BREEZE_AUTHENTICATOR_ATTESTATION_ENFORCED is off, so the blast radius of
 * flipping the flag is measurable before and after the flip.
 */
export function recordAuthenticatorL4Basis(
  basis: string,
  outcome: 'allowed' | 'denied' | 'would_deny',
): void {
  recorder?.recordAuthenticatorL4Basis?.(basis, outcome);
}
```

- [ ] **Step 4: Declare the counter**

In `apps/api/src/routes/metrics.ts`, next to the other auth counters (`failedLoginsTotal` ~line 340):

```ts
const authenticatorL4BasisTotal = new Counter({
  name: 'breeze_authenticator_l4_basis_total',
  help: 'Critical-tier (L4) assurance decisions by approver-device platform_bound_basis (#1374)',
  labelNames: ['basis', 'outcome'] as const,
  registers: [metricsRegistry],
});
```

Zero-init every series in the block at ~line 488, so an absent series never reads as a scrape gap:

```ts
for (const basis of ['unattested','legacy_unattested','webauthn_backup_flags','ios_keychain_rsa_app_attest','ios_se_p256_app_attest','android_tee_key_attestation','android_strongbox_key_attestation']) {
  for (const outcome of ['allowed','denied','would_deny']) {
    authenticatorL4BasisTotal.inc({ basis, outcome }, 0);
  }
}
```

Wire it into the recorder installed via `setAnomalyMetricsRecorder`.

- [ ] **Step 5: Call it from the L4 rung**

`escalateAchievedLevel` is sync and pure today; keep it that way — `recordAuthenticatorL4Basis` is a sync void call, so add it inline at the three L4 exits (untrusted-and-enforced → `'denied'`, untrusted-and-not-enforced → `'would_deny'`, trusted → `'allowed'`).

- [ ] **Step 6: Add the basis to the register audit detail**

In `apps/api/src/routes/authenticator.ts`, the `writeAuthAudit` call for a mobile registration already emits `details: { deviceId, kind, isPlatformBound, mobileDeviceId }`. Add `platformBoundBasis: inserted.platformBoundBasis`. The `action` string convention is `auth.<subsystem>.<event>` and there is no allowlist — keep the existing `auth.authenticator.device.register`, just enrich `details`.

- [ ] **Step 7: Run and commit**

```bash
cd apps/api && npx vitest run src/services/authenticatorAssurance.test.ts src/routes/authenticator.test.ts src/routes/metrics.test.ts
git add -A apps/api/src && git commit -m "feat(auth): emit breeze_authenticator_l4_basis_total per critical-tier decision (#1374)"
```

---

### Task 4: Stop the unconditional `isPlatformBound: true`

**Files:**
- Modify: `apps/api/src/routes/authenticator.ts:372` (the mobile insert)
- Test: `apps/api/src/routes/authenticator.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('registers a legacy (unattested) mobile key as NOT platform-bound (#1374)', async () => {
  // ...existing successful-registration setup from the sibling test at line ~818...
  const inserted = dbState.insertValues[0];
  expect(inserted).toMatchObject({
    kind: 'mobile_hw_key',
    isPlatformBound: false,
    platformBoundBasis: 'unattested',
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd apps/api && npx vitest run src/routes/authenticator.test.ts
```
Expected: FAIL — `isPlatformBound` is `true`, `platformBoundBasis` absent.

- [ ] **Step 3: Change the insert**

```ts
        // #1374: NEVER assert platform-binding for an unattested key. This
        // legacy endpoint has no attestation, so the row registers at L2/L3
        // only. An attested registration goes through
        // POST /devices/mobile/challenge + /devices/mobile/verify (W02).
        isPlatformBound: false,
        platformBoundBasis: 'unattested' as const,
```

Update the block comment at `authenticator.ts:62-72` and the `details` in the audit call (`isPlatformBound: false`).

- [ ] **Step 4: Run, typecheck, commit**

```bash
cd apps/api && npx vitest run src/routes/authenticator.test.ts && npx tsc --noEmit
git commit -am "fix(auth): legacy mobile registration no longer claims platform-binding (#1374)"
```

---

### Task 5: Wave 01 verification + PR

- [ ] **Step 1: Full targeted suites**

```bash
pnpm --filter @breeze/api test --run src/services/authenticatorAssurance.test.ts src/routes/authenticator.test.ts src/services/mobileHwKey.test.ts
pnpm --filter @breeze/shared test --run src/validators/authenticator.test.ts
```

- [ ] **Step 2: The contract suites `pnpm test` does NOT run**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
cd apps/api
npx vitest run --config vitest.config.rls.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/authenticatorAttestation.integration.test.ts src/__tests__/integration/authenticatorRls.integration.test.ts src/__tests__/integration/authenticator-assurance-checks.integration.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts
```
All must pass. The last line is the one that proves the "no registration-list entry needed" claim mechanically.

- [ ] **Step 3: Forge a cross-tenant write as `breeze_app`**

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze -c \
  "INSERT INTO authenticator_devices (user_id, kind, public_key, is_platform_bound, platform_bound_basis) VALUES (gen_random_uuid(),'mobile_hw_key','x',true,'ios_se_p256_app_attest');"
```
Expected: `new row violates row-level security policy` (no `breeze_current_user_id()` set).

- [ ] **Step 4: Merge main, then open the PR**

```bash
git fetch origin main && git merge origin/main
# resolve, re-run step 1-2, then:
gh pr create --base main --title "feat(auth): verify platform attestation before trusting is_platform_bound for L4 — W01 fail-closed (#1374)" --body "..."
```
PR body must include: the empty grep output from Task 1 Step 7; the migration's two `RAISE WARNING` row counts from a real run; and an explicit statement that `BREEZE_AUTHENTICATOR_ATTESTATION_ENFORCED` defaults to `true` and what breaks when it does.

- [ ] **Step 5: One independent code-review round**

Auth surface → per CLAUDE.md model routing, review with Sonnet (precision) or Opus (depth), not the cheap default. Act on confirmed findings only; do not loop.

---

# Wave 02 — Challenge/verify registration protocol + ES256

Branch: `feature/1374-mobile-attestation/w02-registration-protocol`. Base: `main`.

**Goal:** a two-step, challenge-bound mobile registration that a platform attestation can be threaded through, plus server support for P-256 (ES256) signing keys. No attestation verifier yet — the platform dispatch returns `unattested` until W03/W04 land, so this wave is safe to ship alone.

### Task 1: ES256 verification alongside RS256

**Files:**
- Modify: `apps/api/src/services/mobileHwKey.ts`
- Create: `apps/api/migrations/2026-10-05-100001-authenticator-public-key-alg.sql`
- Modify: `apps/api/src/db/schema/authenticatorDevices.ts`
- Test: `apps/api/src/services/mobileHwKey.test.ts`

**Interfaces:**
- Produces: `export type MobileKeyAlg = 'RS256' | 'ES256'`; `verifyMobileSignature(input: { publicKeySpkiB64: string; payload: string; signatureB64: string; alg: MobileKeyAlg })`.

- [ ] **Step 1: Write the failing test**

In `apps/api/src/services/mobileHwKey.test.ts`, generate a real P-256 keypair with `node:crypto` and assert a round-trip:

```ts
import crypto from 'node:crypto';

it('verifies an ES256 (P-256) signature against a stored SPKI key', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const payload = 'nonce-abc';
  const signature = crypto.sign('SHA256', Buffer.from(payload, 'utf8'), privateKey).toString('base64');
  const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  expect(verifyMobileSignature({ publicKeySpkiB64: spki, payload, signatureB64: signature, alg: 'ES256' })).toBe(true);
});

it('rejects an ES256 signature presented as RS256 (algorithm confusion)', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const signature = crypto.sign('SHA256', Buffer.from('n', 'utf8'), privateKey).toString('base64');
  const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  expect(verifyMobileSignature({ publicKeySpkiB64: spki, payload: 'n', signatureB64: signature, alg: 'RS256' })).toBe(false);
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd apps/api && npx vitest run src/services/mobileHwKey.test.ts
```
Expected: FAIL — `alg` is not a parameter and the function hardcodes `'RSA-SHA256'`.

- [ ] **Step 3: Implement**

```ts
export type MobileKeyAlg = 'RS256' | 'ES256';

/**
 * Verify an approval signature over `payload`.
 *
 * `alg` is read from the DEVICE ROW (authenticator_devices.public_key_alg), never
 * from the request — a client-chosen algorithm is an algorithm-confusion vector.
 * Returns false on any malformed input; never throws.
 */
export function verifyMobileSignature(input: {
  publicKeySpkiB64: string;
  payload: string;
  signatureB64: string;
  alg: MobileKeyAlg;
}): boolean {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(input.publicKeySpkiB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const expectedType = input.alg === 'ES256' ? 'ec' : 'rsa';
    if (key.asymmetricKeyType !== expectedType) return false;
    return crypto.verify(
      'SHA256',
      Buffer.from(input.payload, 'utf8'),
      key,
      Buffer.from(input.signatureB64, 'base64'),
    );
  } catch {
    return false;
  }
}
```

Note `crypto.verify('SHA256', …)` dispatches on the key type, so one call covers both; the explicit `asymmetricKeyType` check is what closes the confusion path the second test asserts.

- [ ] **Step 4: Migration + schema for `public_key_alg`**

`apps/api/migrations/2026-10-05-100001-authenticator-public-key-alg.sql` (re-check the sort ceiling first, as in W01 Task 1 Step 1):

```sql
-- #1374 W02 — mobile approver keys may now be P-256 (Secure Enclave / StrongBox)
-- as well as the legacy RSA-2048 that react-native-biometrics mints.
ALTER TABLE authenticator_devices
  ADD COLUMN IF NOT EXISTS public_key_alg varchar(16) NOT NULL DEFAULT 'RS256';
```

Existing rows correctly default to `RS256` — every key registered before this wave is RSA. No backfill `UPDATE`, therefore no row-count `RAISE` needed.

Drizzle: `publicKeyAlg: varchar('public_key_alg', { length: 16 }).notNull().default('RS256'),`

- [ ] **Step 5: Thread `alg` through `verifyMobileFactor`**

In `authenticatorAssurance.ts`, pass `alg: device.publicKeyAlg as MobileKeyAlg`.

- [ ] **Step 6: Run, drift-check, commit**

```bash
pnpm db:migrate && pnpm db:check-drift
cd apps/api && npx vitest run src/services/mobileHwKey.test.ts src/services/authenticatorAssurance.test.ts
git add -A && git commit -m "feat(auth): verify ES256/P-256 approver signatures alongside RS256 (#1374)"
```

---

### Task 2: Registration attempt lifecycle + transcript

**Files:**
- Create: `apps/api/src/services/authenticatorAttestation.ts`
- Create: `apps/api/src/services/authenticatorAttestation.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RegistrationAttempt {
    attemptId: string;
    userId: string;
    challenge: string;      // base64url, 32 random bytes
    issuedAt: number;       // epoch ms
    platform: 'ios' | 'android';
  }
  export const ATTEMPT_TTL_SECONDS = 300;
  export function issueRegistrationAttempt(userId: string, platform: 'ios' | 'android'): Promise<RegistrationAttempt>;
  export function consumeRegistrationAttempt(attemptId: string): Promise<RegistrationAttempt | null>;
  export function registrationTranscript(input: {
    attemptId: string; challenge: string; publicKeyAlg: MobileKeyAlg; publicKeySpkiB64: string;
  }): Buffer;  // 32-byte SHA-256 digest
  ```

- [ ] **Step 1: Write the failing tests**

```ts
describe('registrationTranscript', () => {
  const base = { attemptId: 'a1', challenge: 'c1', publicKeyAlg: 'ES256' as const, publicKeySpkiB64: 'spki' };

  it('is a 32-byte digest', () => {
    expect(registrationTranscript(base)).toHaveLength(32);
  });

  it('is domain-separated — the same field values under a different tag differ', () => {
    // Guards against a signature minted for one Breeze flow being replayed into
    // registration. The tag is inside the hashed input, so this is structural.
    expect(registrationTranscript(base).toString('hex')).not.toBe(
      crypto.createHash('sha256').update(['a1', 'c1', 'ES256', 'spki'].join('\n')).digest('hex'),
    );
  });

  it.each([
    ['attemptId', { attemptId: 'a2' }],
    ['challenge', { challenge: 'c2' }],
    ['publicKeyAlg', { publicKeyAlg: 'RS256' as const }],
    ['publicKeySpkiB64', { publicKeySpkiB64: 'other' }],
  ])('changes when %s changes', (_name, patch) => {
    expect(registrationTranscript({ ...base, ...patch })).not.toEqual(registrationTranscript(base));
  });

  it('is not confusable across field boundaries', () => {
    // 'ab' + 'c' must not collide with 'a' + 'bc'. The newline separator is
    // load-bearing; assert it rather than trusting it.
    expect(registrationTranscript({ ...base, attemptId: 'ab', challenge: 'c' }))
      .not.toEqual(registrationTranscript({ ...base, attemptId: 'a', challenge: 'bc' }));
  });
});

describe('attempt lifecycle', () => {
  it('is single-use — a second consume returns null', async () => {
    const a = await issueRegistrationAttempt('user-1', 'ios');
    expect(await consumeRegistrationAttempt(a.attemptId)).toMatchObject({ userId: 'user-1', platform: 'ios' });
    expect(await consumeRegistrationAttempt(a.attemptId)).toBeNull();
  });

  it('returns null for an unknown attempt id', async () => {
    expect(await consumeRegistrationAttempt('nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd apps/api && npx vitest run src/services/authenticatorAttestation.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Mirror `apps/api/src/services/mobileHwKey.ts` for the Redis shape (`getRedis()`, `setex`, `getdel` — atomic read-and-delete is what makes it single-use).

```ts
import crypto from 'node:crypto';
import { getRedis } from './redis';
import type { MobileKeyAlg } from './mobileHwKey';

export const ATTEMPT_TTL_SECONDS = 300;
const TRANSCRIPT_DOMAIN = 'breeze.authenticator.mobile-register.v1';
const attemptKey = (attemptId: string) => `authenticator-attest:${attemptId}`;

export interface RegistrationAttempt {
  attemptId: string;
  userId: string;
  challenge: string;
  issuedAt: number;
  platform: 'ios' | 'android';
}

/**
 * The bytes both the platform attestation and the registration proof-of-
 * possession are computed over.
 *
 * iOS passes this as App Attest's `clientDataHash`; Android passes it as the
 * KeyStore `setAttestationChallenge`; and the client also signs it with the
 * approval key under a biometric prompt. One digest, three bindings — which is
 * what makes "this attestation vouches for THIS key in THIS attempt" checkable.
 *
 * Domain-separated and newline-delimited so a signature minted for any other
 * Breeze flow, or a different field split with the same concatenation, cannot
 * be replayed in here.
 */
export function registrationTranscript(input: {
  attemptId: string;
  challenge: string;
  publicKeyAlg: MobileKeyAlg;
  publicKeySpkiB64: string;
}): Buffer {
  return crypto
    .createHash('sha256')
    .update(
      [TRANSCRIPT_DOMAIN, input.attemptId, input.challenge, input.publicKeyAlg, input.publicKeySpkiB64].join('\n'),
      'utf8',
    )
    .digest();
}

export async function issueRegistrationAttempt(
  userId: string,
  platform: 'ios' | 'android',
): Promise<RegistrationAttempt> {
  const redis = getRedis();
  if (!redis) throw new Error('redis unavailable');
  const attempt: RegistrationAttempt = {
    attemptId: crypto.randomUUID(),
    userId,
    challenge: crypto.randomBytes(32).toString('base64url'),
    issuedAt: Date.now(),
    platform,
  };
  await redis.setex(attemptKey(attempt.attemptId), ATTEMPT_TTL_SECONDS, JSON.stringify(attempt));
  return attempt;
}

/** Atomic read-and-delete: a replayed attemptId finds nothing. */
export async function consumeRegistrationAttempt(attemptId: string): Promise<RegistrationAttempt | null> {
  const redis = getRedis();
  if (!redis) throw new Error('redis unavailable');
  const stored = await redis.getdel(attemptKey(attemptId));
  if (stored == null) return null;
  try {
    return JSON.parse(stored) as RegistrationAttempt;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run and commit**

```bash
cd apps/api && npx vitest run src/services/authenticatorAttestation.test.ts
git add -A && git commit -m "feat(auth): single-use registration attempt + domain-separated transcript (#1374)"
```

---

### Task 3: The two endpoints

**Files:**
- Modify: `apps/api/src/routes/authenticator.ts`
- Modify: `packages/shared/src/validators/authenticator.ts`
- Test: `apps/api/src/routes/authenticator.test.ts`, `packages/shared/src/validators/authenticator.test.ts`

**Interfaces:**
- Consumes: `issueRegistrationAttempt`, `consumeRegistrationAttempt`, `registrationTranscript` (Task 2); `verifyMobileSignature` with `alg` (Task 1).
- Produces:
  - `POST /api/v1/authenticator/devices/mobile/challenge` → `200 { attemptId, challenge, expiresAt }`
  - `POST /api/v1/authenticator/devices/mobile/verify` → `201 { success, device }`
  - `mobileAttestationVerifySchema` in `@breeze/shared`.

- [ ] **Step 1: Write the failing validator test**

In `packages/shared/src/validators/authenticator.test.ts`:

```ts
describe('mobileAttestationVerifySchema', () => {
  const valid = {
    attemptId: 'a-1', publicKey: 'spki', publicKeyAlg: 'ES256', label: 'iPhone',
    popSignature: 'sig', attestation: { platform: 'ios', attestationObject: 'cbor', keyId: 'kid' },
  };
  it('accepts a well-formed iOS body', () => {
    expect(mobileAttestationVerifySchema.safeParse(valid).success).toBe(true);
  });
  it('accepts a well-formed Android body', () => {
    expect(mobileAttestationVerifySchema.safeParse({
      ...valid,
      attestation: { platform: 'android', certificateChain: ['a', 'b'], playIntegrityToken: 'jwt' },
    }).success).toBe(true);
  });
  it('rejects an unknown attestation platform', () => {
    expect(mobileAttestationVerifySchema.safeParse({ ...valid, attestation: { platform: 'web' } }).success).toBe(false);
  });
  it('rejects an unsupported publicKeyAlg', () => {
    expect(mobileAttestationVerifySchema.safeParse({ ...valid, publicKeyAlg: 'HS256' }).success).toBe(false);
  });
  it('is strict — a stray field is rejected, not silently kept', () => {
    expect(mobileAttestationVerifySchema.safeParse({ ...valid, isPlatformBound: true }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
pnpm --filter @breeze/shared test --run src/validators/authenticator.test.ts
```
Expected: FAIL — export not found.

- [ ] **Step 3: Add the schema**

In `packages/shared/src/validators/authenticator.ts`:

```ts
/**
 * Mobile attested-registration verify body (#1374).
 *
 * `.strict()` throughout: the whole point of this wave is that the client no
 * longer gets to assert anything about platform-binding, so a stray
 * `isPlatformBound` must be a 400, never a silently-dropped field.
 */
export const mobileAttestationSchema = z.discriminatedUnion('platform', [
  z.object({
    platform: z.literal('ios'),
    /** base64 CBOR attestation object from DCAppAttestService.attestKey. */
    attestationObject: z.string().min(1),
    /** base64 App Attest keyId. */
    keyId: z.string().min(1),
  }).strict(),
  z.object({
    platform: z.literal('android'),
    /** base64 DER certs, leaf first, from KeyStore.getCertificateChain. */
    certificateChain: z.array(z.string().min(1)).min(2).max(8),
    /** Play Integrity token; optional for non-Play enterprise distribution. */
    playIntegrityToken: z.string().min(1).optional(),
  }).strict(),
]);

export const mobileAttestationVerifySchema = z.object({
  registerGrantId: z.string().min(1).max(128).optional(),
  attemptId: z.string().min(1).max(64),
  publicKey: z.string().min(1),
  publicKeyAlg: z.enum(['RS256', 'ES256']),
  label: z.string().min(1).max(255),
  /** Registration PoP: signature over the transcript, biometric-gated. */
  popSignature: z.string().min(1),
  attestation: mobileAttestationSchema,
}).strict();

export type MobileAttestationVerify = z.infer<typeof mobileAttestationVerifySchema>;
```

- [ ] **Step 4: Write the failing route tests**

In `apps/api/src/routes/authenticator.test.ts`, following the existing mobile-registration tests (~line 810-500):

```ts
describe('POST /authenticator/devices/mobile/challenge (#1374)', () => {
  it('validates the register grant WITHOUT consuming it and returns an attempt', async () => {
    const res = await app.request('/authenticator/devices/mobile/challenge', {
      method: 'POST', body: JSON.stringify({ registerGrantId: 'g-1', platform: 'ios' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ attemptId: expect.any(String), challenge: expect.any(String) });
    expect(helperMocks.enforceApproverRegisterStepUp).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 'g-1', { consume: false },
    );
  });

  it('403s with no grant, before any attempt is issued', async () => {
    helperMocks.enforceApproverRegisterStepUp.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'register_step_up_required' }), { status: 403 }),
    );
    const res = await app.request('/authenticator/devices/mobile/challenge', {
      method: 'POST', body: JSON.stringify({ platform: 'ios' }),
    });
    expect(res.status).toBe(403);
    expect(attestationMocks.issueRegistrationAttempt).not.toHaveBeenCalled();
  });
});

describe('POST /authenticator/devices/mobile/verify (#1374)', () => {
  it('400s when the attempt is unknown or already consumed, WITHOUT burning the grant', async () => {
    attestationMocks.consumeRegistrationAttempt.mockResolvedValueOnce(null);
    const res = await app.request('/authenticator/devices/mobile/verify', { method: 'POST', body: JSON.stringify(validBody) });
    expect(res.status).toBe(400);
    expect(helperMocks.enforceApproverRegisterStepUp).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), { consume: true },
    );
  });

  it('403s when the attempt belongs to a different user', async () => {
    attestationMocks.consumeRegistrationAttempt.mockResolvedValueOnce({
      attemptId: 'a-1', userId: 'someone-else', challenge: 'c', issuedAt: Date.now(), platform: 'ios',
    });
    const res = await app.request('/authenticator/devices/mobile/verify', { method: 'POST', body: JSON.stringify(validBody) });
    expect(res.status).toBe(403);
  });

  it('401s when the registration PoP signature does not verify', async () => {
    mobileHwKeyMocks.verifyMobileSignature.mockReturnValueOnce(false);
    const res = await app.request('/authenticator/devices/mobile/verify', { method: 'POST', body: JSON.stringify(validBody) });
    expect(res.status).toBe(401);
    expect(dbState.insertValues).toHaveLength(0);
  });

  it('inserts unattested + not platform-bound while no verifier is wired (W02)', async () => {
    const res = await app.request('/authenticator/devices/mobile/verify', { method: 'POST', body: JSON.stringify(validBody) });
    expect(res.status).toBe(201);
    expect(dbState.insertValues[0]).toMatchObject({
      kind: 'mobile_hw_key',
      isPlatformBound: false,
      platformBoundBasis: 'unattested',
      publicKeyAlg: 'ES256',
      possessionVerifiedAt: expect.any(Date),
    });
  });

  it('leaves last_used_at null — PoP at registration does not mean "used for an approval"', async () => {
    await app.request('/authenticator/devices/mobile/verify', { method: 'POST', body: JSON.stringify(validBody) });
    expect(dbState.insertValues[0]).not.toHaveProperty('lastUsedAt');
  });
});
```

- [ ] **Step 5: Run and watch them fail**

```bash
cd apps/api && npx vitest run src/routes/authenticator.test.ts
```
Expected: FAIL — routes 404.

- [ ] **Step 6: Implement the routes**

Add to `apps/api/src/routes/authenticator.ts`. The ordering below is deliberate and is what the tests above pin:

```ts
const mobileChallengeSchema = z.object({
  registerGrantId: registerGrantIdSchema,
  platform: z.enum(['ios', 'android']),
});

// #1374 step 1 of 2. The register grant is validated NON-consuming here (same
// pattern as /devices/webauthn/options) and consumed at /verify, so a client
// that fails attestation does not burn its single-use grant.
authenticatorRoutes.post(
  '/devices/mobile/challenge',
  authMiddleware,
  zValidator('json', mobileChallengeSchema),
  async (c) => {
    const auth = c.get('auth');
    const { registerGrantId, platform } = c.req.valid('json');
    const grantError = await enforceApproverRegisterStepUp(c, auth, registerGrantId, { consume: false });
    if (grantError) return grantError;

    const attempt = await issueRegistrationAttempt(auth.user.id, platform);
    return c.json({
      attemptId: attempt.attemptId,
      challenge: attempt.challenge,
      expiresAt: new Date(attempt.issuedAt + ATTEMPT_TTL_SECONDS * 1000).toISOString(),
    });
  },
);

// #1374 step 2 of 2. Ordering matters and is asserted by the tests:
//   1. schema parse            → 400, no side effects
//   2. consume the attempt     → 400 on unknown/replayed, grant NOT burned
//   3. attempt ownership       → 403, grant NOT burned
//   4. registration PoP        → 401, grant NOT burned, nothing inserted
//   5. platform attestation    → sets the basis (W03/W04; 'unattested' until then)
//   6. consume the grant       → single-use, only once everything else passed
//   7. insert
authenticatorRoutes.post(
  '/devices/mobile/verify',
  authMiddleware,
  zValidator('json', mobileAttestationVerifySchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    const attempt = await consumeRegistrationAttempt(body.attemptId);
    if (!attempt) return c.json({ error: 'registration_attempt_expired' }, 400);
    if (attempt.userId !== auth.user.id) {
      writeAuthAudit(c, {
        orgId: auth.orgId ?? undefined,
        action: 'auth.authenticator.device.register.denied',
        result: 'failure',
        reason: 'attempt_user_mismatch',
        userId: auth.user.id,
        email: auth.user.email,
      });
      return c.json({ error: 'registration_attempt_invalid' }, 403);
    }
    if (attempt.platform !== body.attestation.platform) {
      return c.json({ error: 'registration_attempt_invalid' }, 403);
    }

    const transcript = registrationTranscript({
      attemptId: attempt.attemptId,
      challenge: attempt.challenge,
      publicKeyAlg: body.publicKeyAlg,
      publicKeySpkiB64: body.publicKey,
    });

    const popOk = verifyMobileSignature({
      publicKeySpkiB64: body.publicKey,
      payload: transcript.toString('base64'),
      signatureB64: body.popSignature,
      alg: body.publicKeyAlg,
    });
    if (!popOk) {
      writeAuthAudit(c, {
        orgId: auth.orgId ?? undefined,
        action: 'auth.authenticator.device.register.denied',
        result: 'failure',
        reason: 'pop_signature_invalid',
        userId: auth.user.id,
        email: auth.user.email,
      });
      return c.json({ error: 'registration_pop_invalid' }, 401);
    }

    // W03/W04 replace this with the real per-platform verifier. Until they land
    // the device registers unattested — L2/L3 capable, never L4.
    const attested = await verifyPlatformAttestation({
      attestation: body.attestation,
      transcript,
      publicKeySpkiB64: body.publicKey,
    });

    const grantError = await enforceApproverRegisterStepUp(c, auth, body.registerGrantId, { consume: true });
    if (grantError) return grantError;

    // ... resolve mobileDeviceId exactly as the legacy /devices route does
    //     (readMobileDeviceId + the explicit ownership + status='active' predicate) ...

    const [inserted] = await db.insert(authenticatorDevices).values({
      userId: auth.user.id,
      kind: 'mobile_hw_key',
      label: body.label,
      publicKey: body.publicKey,
      publicKeyAlg: body.publicKeyAlg,
      credentialId: null,
      signCount: 0,
      isPlatformBound: attested.basis !== 'unattested',
      platformBoundBasis: attested.basis,
      attestationVerifiedAt: attested.verifiedAt,
      attestationKeyId: attested.keyId,
      attestedPublicKeySha256: attested.verifiedAt ? sha256CanonicalSpki(body.publicKey) : null,
      attestationEvidence: attested.evidence,
      appIntegrityVerifiedAt: attested.appIntegrityVerifiedAt,
      possessionVerifiedAt: new Date(),
      mobileDeviceId,
      // last_used_at stays null: PoP at registration is not an approval.
    }).returning();
    // ... audit + response as the legacy route does, plus platformBoundBasis in details ...
  },
);
```

Add the W02 stub in `authenticatorAttestation.ts`:

```ts
export interface AttestationResult {
  basis: PlatformBoundBasis;
  verifiedAt: Date | null;
  keyId: string | null;
  evidence: Record<string, unknown>;
  appIntegrityVerifiedAt: Date | null;
}

/**
 * Dispatch to the per-platform verifier. W03 wires iOS, W04 wires Android.
 * Until then every attestation resolves `unattested` — the device registers and
 * works at L2/L3, and simply cannot reach L4. Fail-closed by construction: an
 * unknown or unimplemented platform never yields a trusted basis.
 */
export async function verifyPlatformAttestation(input: {
  attestation: MobileAttestation;
  transcript: Buffer;
  publicKeySpkiB64: string;
}): Promise<AttestationResult> {
  return { basis: 'unattested', verifiedAt: null, keyId: null, evidence: {}, appIntegrityVerifiedAt: null };
}
```

Also add `sha256CanonicalSpki(spkiB64: string): Buffer` to `mobileHwKey.ts` — it must re-export the key through `crypto.createPublicKey(...).export({format:'der', type:'spki'})` before hashing, so a re-encoded but equivalent SPKI hashes the same.

- [ ] **Step 7: Rate-limit both endpoints**

`apps/api/src/routes/authenticator.ts` has no rate limiting today. Both new routes mint/consume server state and are reachable with a valid bearer token, so add the per-user middleware (`apps/api/src/middleware/userRateLimit.ts:11`):

```ts
authenticatorRoutes.post('/devices/mobile/challenge', authMiddleware, userRateLimit('authenticator-attest-challenge', 10, 300), /* … */);
authenticatorRoutes.post('/devices/mobile/verify',    authMiddleware, userRateLimit('authenticator-attest-verify', 10, 300), /* … */);
```

Add a test asserting the 11th call in the window returns 429.

- [ ] **Step 8: Run everything, typecheck, commit**

```bash
pnpm --filter @breeze/shared test --run src/validators/authenticator.test.ts
cd apps/api && npx vitest run src/routes/authenticator.test.ts src/services/authenticatorAttestation.test.ts && npx tsc --noEmit
git add -A && git commit -m "feat(auth): challenge-bound mobile registration with registration-time PoP (#1374)"
```

- [ ] **Step 9: Wave 02 verification + PR**

Run the same contract-suite block as W01 Task 5 Step 2, merge `origin/main`, re-run, open the PR against `main`, one review round.

---

# Wave 03 — Apple App Attest verifier

Branch: `feature/1374-mobile-attestation/w03-app-attest`. Base: `main`. **Requires W02 merged.**

### Task 1: The verifier

**Files:**
- Create: `apps/api/src/services/attestation/appleAppAttest.ts`
- Create: `apps/api/src/services/attestation/appleAppAttest.test.ts`
- Create: `apps/api/src/services/attestation/appleAppAttestRootCA.pem`
- Modify: `apps/api/package.json` (promote `@levischuck/tiny-cbor` to a direct dependency — already in `pnpm-lock.yaml` transitively via `@simplewebauthn/server`)
- Modify: `apps/api/src/config/env.ts` (`APPLE_APP_ATTEST_APP_ID`, `APPLE_APP_ATTEST_ENVIRONMENT`)

**Interfaces:**
- Produces:
  ```ts
  export interface AppAttestInput {
    attestationObjectB64: string;
    keyIdB64: string;
    clientDataHash: Buffer;   // the registration transcript
    appId: string;            // "D8W6N2JYMA.com.breeze.rmm"
    environment: 'production' | 'development';
    /** Injectable for tests. Defaults to the pinned Apple root. */
    rootCertificatesPem?: string[];
    now?: Date;
  }
  export interface AppAttestResult { attestedPublicKeyDer: Buffer; receiptB64: string; }
  export function verifyAppAttestAttestation(input: AppAttestInput): AppAttestResult;  // throws on any failure
  ```

**The verifier must perform every one of these checks** (Apple's documented procedure; each is a separate test below):
1. CBOR-decode the attestation object; `fmt` must be `"apple-appattest"`.
2. Verify the `x5c` chain (credCert → intermediate → the pinned Apple App Attestation Root CA), honouring validity windows against `now`.
3. `clientDataHash` is the caller-supplied transcript; compute `nonce = SHA256(authData || clientDataHash)`.
4. That nonce must equal the single octet string in the credCert extension OID `1.2.840.113635.100.8.2`.
5. `SHA256(credCert public key in uncompressed X9.62 form)` must equal `keyId`.
6. `authData.rpIdHash` must equal `SHA256(appId)`.
7. `authData.signCount` must be `0`.
8. `authData.aaguid` must be `appattestdevelop` (development) or `appattest\0\0\0\0\0\0\0` (production), matching `environment`.
9. `authData.credentialId` must equal `keyId`.

- [ ] **Step 1: Build the fixture generator FIRST**

There is no way to obtain a real App Attest blob in CI, so the tests are driven by a synthetic CA. Create `apps/api/src/services/attestation/__fixtures__/appAttestFixture.ts`:

```ts
/**
 * Mints a synthetic App Attest attestation object signed by a throwaway root,
 * so the verifier's checks are exercised end-to-end in CI. `rootCertificatesPem`
 * on the verifier input exists ONLY for this — production always uses the
 * pinned Apple root.
 *
 * This fixture is the control for every negative test below: each one takes a
 * VALID fixture and mutates exactly one field, so a passing negative test proves
 * the verifier rejected that specific mutation and not something incidental.
 */
export function mintAppAttestFixture(overrides?: {
  clientDataHash?: Buffer; appId?: string; signCount?: number;
  aaguid?: Buffer; nonceExtension?: Buffer; keyId?: Buffer; notAfter?: Date;
}): { attestationObjectB64: string; keyIdB64: string; rootPem: string; attestedPublicKeyDer: Buffer };
```

Build it with `node:crypto` (`X509Certificate`, `createPrivateKey`, `generateKeyPairSync('ec', {namedCurve:'P-256'})`) and `@levischuck/tiny-cbor` for encoding. Certificate construction with the custom extension needs `@peculiar/x509` — add it as a **devDependency** of `apps/api` (it is already in the lockfile tree).

- [ ] **Step 2: Write the failing tests — one per check, each a single-field mutation**

```ts
describe('verifyAppAttestAttestation', () => {
  const appId = 'D8W6N2JYMA.com.breeze.rmm';
  const clientDataHash = crypto.randomBytes(32);

  it('accepts a valid production attestation and returns the attested public key', () => {
    const f = mintAppAttestFixture({ clientDataHash, appId });
    const r = verifyAppAttestAttestation({
      attestationObjectB64: f.attestationObjectB64, keyIdB64: f.keyIdB64,
      clientDataHash, appId, environment: 'production', rootCertificatesPem: [f.rootPem],
    });
    expect(r.attestedPublicKeyDer.equals(f.attestedPublicKeyDer)).toBe(true);
  });

  it('rejects a chain that does not terminate at a trusted root', () => { /* verify against the REAL Apple root */ });
  it('rejects when clientDataHash differs from the one in the nonce (transcript substitution)', () => { /* pass a different clientDataHash */ });
  it('rejects a tampered nonce extension', () => { /* nonceExtension: randomBytes(32) */ });
  it('rejects when keyId does not match SHA256 of the credCert public key', () => { /* keyId: randomBytes(32) */ });
  it('rejects a mismatched appId (rpIdHash)', () => { /* appId: 'OTHER.com.evil.app' */ });
  it('rejects signCount != 0 (a re-attested key)', () => { /* signCount: 1 */ });
  it('rejects a development aaguid when environment is production', () => { /* aaguid: appattestdevelop */ });
  it('rejects an expired credCert', () => { /* notAfter in the past, now: new Date() */ });
  it('rejects a non-apple-appattest fmt', () => { /* re-encode with fmt: 'packed' */ });
  it('rejects malformed CBOR without throwing an unhandled error type', () => {
    expect(() => verifyAppAttestAttestation({ ...base, attestationObjectB64: 'bm90LWNib3I=' })).toThrow(/attestation/i);
  });
});
```

- [ ] **Step 3: Run and watch every test fail**

```bash
cd apps/api && npx vitest run src/services/attestation/appleAppAttest.test.ts
```
Expected: FAIL — module not found. **Do not proceed until each negative test has been observed failing for the right reason** (write the happy path first, confirm the negatives then fail because they *pass*, i.e. the verifier accepted a mutation, before implementing that check).

- [ ] **Step 4: Implement, one check at a time, red→green per check**

Each numbered check above gets its own red→green cycle. Do not batch them: a verifier that skips one check still passes the other eight tests.

- [ ] **Step 5: Pin the Apple root**

Download `Apple_App_Attestation_Root_CA.pem` from `https://www.apple.com/certificateauthority/private/` and commit it at `apps/api/src/services/attestation/appleAppAttestRootCA.pem`. This is a public CA certificate, not infrastructure detail — it is fine in the public repo (contrast the CLAUDE.md rule, which is about IPs/hostnames/regions).

- [ ] **Step 6: Wire the dispatcher**

In `authenticatorAttestation.ts`, replace the iOS branch of `verifyPlatformAttestation`:

```ts
  if (input.attestation.platform === 'ios') {
    const { attestedPublicKeyDer, receiptB64 } = verifyAppAttestAttestation({
      attestationObjectB64: input.attestation.attestationObject,
      keyIdB64: input.attestation.keyId,
      clientDataHash: input.transcript,
      appId: appleAppAttestAppId(),
      environment: appleAppAttestEnvironment(),
    });

    // The App Attest key and the APPROVAL key are two different keys. App
    // Attest proves a genuine app instance on genuine hardware; the transcript
    // binding proves that instance vouched for THIS approval SPKI. What
    // decides the basis is whether the approval key is itself Secure-Enclave
    // resident, which the client asserts by minting a P-256 key with
    // kSecAttrTokenIDSecureEnclave — and which iOS gives us NO API to verify
    // server-side. So: ES256 gets ios_se_p256_app_attest; RS256 (which CANNOT
    // be Secure Enclave — the SE holds only P-256) gets the weaker
    // ios_keychain_rsa_app_attest, which is deliberately NOT L4-trusted.
    const basis: PlatformBoundBasis =
      input.publicKeyAlg === 'ES256' ? 'ios_se_p256_app_attest' : 'ios_keychain_rsa_app_attest';

    return {
      basis,
      verifiedAt: new Date(),
      keyId: input.attestation.keyId,
      evidence: {
        verifier: 'apple_app_attest',
        verifierVersion: 1,
        appId: appleAppAttestAppId(),
        environment: appleAppAttestEnvironment(),
        attestedAppAttestKeySha256: crypto.createHash('sha256').update(attestedPublicKeyDer).digest('hex'),
        receiptSha256: crypto.createHash('sha256').update(Buffer.from(receiptB64, 'base64')).digest('hex'),
      },
      appIntegrityVerifiedAt: new Date(),
    };
  }
```

**The `evidence` jsonb stores digests, never the raw receipt.** The receipt is a bearer artifact for Apple's fraud-metric endpoint; hashing it keeps the forensic link without storing the credential.

- [ ] **Step 7: Env config**

```ts
export const APPLE_APP_ATTEST_APP_ID = process.env.APPLE_APP_ATTEST_APP_ID ?? 'D8W6N2JYMA.com.breeze.rmm';
export function appleAppAttestEnvironment(): 'production' | 'development' {
  return process.env.APPLE_APP_ATTEST_ENVIRONMENT === 'development' ? 'development' : 'production';
}
```
Default to `production` — a misconfigured deploy must not silently accept development attestations. Add both to `deploy/.env.example` with generic placeholders, and note in the PR body that they must be added to `/opt/breeze/.env` **and** mapped in the `api` service's `environment:` block (compose interpolation only happens for listed vars).

- [ ] **Step 8: Run, typecheck, commit, PR**

```bash
cd apps/api && npx vitest run src/services/attestation/ src/services/authenticatorAttestation.test.ts src/routes/authenticator.test.ts && npx tsc --noEmit
```
Then the contract-suite block, merge main, PR against `main`, one review round. **Review this wave with Opus or Sonnet** — it is a cryptographic verifier on the auth path.

---

# Wave 04 — Android Key Attestation + Play Integrity

Branch: `feature/1374-mobile-attestation/w04-android-attestation`. Base: `main`. **Requires W02 merged.** File-disjoint from W03 — can run in parallel.

### Task 1: Key Attestation verifier

**Files:**
- Create: `apps/api/src/services/attestation/androidKeyAttestation.ts` + `.test.ts`
- Create: `apps/api/src/services/attestation/googleHardwareAttestationRoots.pem`
- Create: `apps/api/src/services/attestation/__fixtures__/androidKeyAttestationFixture.ts`
- Modify: `apps/api/package.json` — promote `@peculiar/asn1-android` and `@peculiar/asn1-x509` to direct dependencies (**already in `pnpm-lock.yaml`** via `@simplewebauthn/server`, which implements Android Key attestation for WebAuthn; `@peculiar/asn1-android` exports the `KeyDescription` schema this wave needs)

**Interfaces:**
- Produces:
  ```ts
  export type AndroidSecurityLevel = 'Software' | 'TrustedEnvironment' | 'StrongBox';
  export interface AndroidKeyAttestationResult {
    keyMintSecurityLevel: AndroidSecurityLevel;
    attestationSecurityLevel: AndroidSecurityLevel;
    verifiedBootState: string;
    deviceLocked: boolean;
    attestedPublicKeyDer: Buffer;
    packageName: string | null;
    leafSerial: string;
  }
  export function verifyAndroidKeyAttestation(input: {
    certificateChainDerB64: string[];
    expectedChallenge: Buffer;
    expectedPackageName: string;
    rootCertificatesPem?: string[];
    now?: Date;
  }): AndroidKeyAttestationResult;  // throws on any failure
  ```

**Checks (one test each):**
1. Chain verifies leaf → … → a pinned Google hardware attestation root, validity windows honoured.
2. The leaf carries extension OID `1.3.6.1.4.1.11129.2.1.17`; parse it as `KeyDescription`.
3. `attestationChallenge` equals `expectedChallenge` (the registration transcript) — byte-exact.
4. `keyMintSecurityLevel ∈ {TrustedEnvironment, StrongBox}`; **`Software` is rejected**.
5. `attestationSecurityLevel ∈ {TrustedEnvironment, StrongBox}`.
6. `teeEnforced.rootOfTrust.deviceLocked === true` and `verifiedBootState === 'Verified'`.
7. `teeEnforced.attestationApplicationId` package name equals `com.breeze.rmm`.
8. The purpose/digest/user-auth properties are **hardware-enforced** (present in `teeEnforced`, not `softwareEnforced`) — a property in the software list is attacker-controlled.
9. The leaf's public key equals the SPKI the client registered (checked by the caller against `attested_public_key_sha256`; the verifier returns it).

- [ ] **Step 1: Fixture generator first**, same pattern and same rationale as W03 Task 1 Step 1. Use `@peculiar/x509` (devDependency) to build a chain and `@peculiar/asn1-android`'s `KeyDescription` schema to encode the extension. Signature:

```ts
export function mintAndroidKeyAttestationFixture(overrides?: {
  challenge?: Buffer; keyMintSecurityLevel?: AndroidSecurityLevel;
  attestationSecurityLevel?: AndroidSecurityLevel; verifiedBootState?: string;
  deviceLocked?: boolean; packageName?: string; notAfter?: Date;
  putPurposeInSoftwareEnforced?: boolean;
}): { certificateChainDerB64: string[]; rootPem: string; attestedPublicKeyDer: Buffer };
```

- [ ] **Step 2: Write nine failing tests**, one per check, each mutating exactly one field of a valid fixture. Include explicitly:

```ts
it('rejects keyMintSecurityLevel Software — this is the whole point of the wave', () => {
  const f = mintAndroidKeyAttestationFixture({ keyMintSecurityLevel: 'Software' });
  expect(() => verifyAndroidKeyAttestation({ ...base(f) })).toThrow(/security level/i);
});

it('rejects an unlocked bootloader', () => { /* deviceLocked: false */ });
it('rejects verifiedBootState other than Verified', () => { /* 'Unverified' */ });
it('rejects a challenge that is not the transcript (replay of another attestation)', () => { /* challenge: randomBytes(32) */ });
it('rejects a foreign package name', () => { /* packageName: 'com.evil.app' */ });
it('rejects properties asserted only in softwareEnforced', () => { /* putPurposeInSoftwareEnforced: true */ });
```

- [ ] **Step 3: Run, confirm each fails for the right reason, implement one check per red→green cycle.**

- [ ] **Step 4: Pin the Google roots.** Fetch from `https://developer.android.com/privacy-and-security/security-key-attestation` and commit at `apps/api/src/services/attestation/googleHardwareAttestationRoots.pem`. Public roots — fine in the repo.

- [ ] **Step 5: Commit**

```bash
cd apps/api && npx vitest run src/services/attestation/androidKeyAttestation.test.ts
git add -A && git commit -m "feat(auth): Android Key Attestation verifier (hardware-backed key proof) (#1374)"
```

### Task 2: Play Integrity verdict

**Files:**
- Create: `apps/api/src/services/attestation/playIntegrity.ts` + `.test.ts`
- Modify: `apps/api/src/config/validate.ts` (`PLAY_INTEGRITY_SERVICE_ACCOUNT`)

**Interfaces:**
- Produces: `verifyPlayIntegrityToken(token: string, opts): Promise<{ appRecognitionVerdict: string; deviceRecognitionVerdicts: string[]; packageName: string }>`

**Design note:** Play Integrity is **not** what sets the basis (decision 3). It sets `app_integrity_verified_at` only. It is **optional** in the request schema, so enterprise/non-Play distribution still registers with a Key-Attestation-derived basis and a null `app_integrity_verified_at`.

- [ ] **Step 1: Failing tests** — accept a valid decoded verdict (`MEETS_DEVICE_INTEGRITY`, `PLAY_RECOGNIZED`, matching package); reject a wrong package; reject `UNRECOGNIZED_VERSION`; reject a stale `timestampMillis`; return null (not throw) when no service account is configured, so an unconfigured deploy degrades to Key-Attestation-only rather than refusing registrations.

- [ ] **Step 2: Implement.** Config mirrors `FIREBASE_SERVICE_ACCOUNT` (`apps/api/src/services/notifications.ts:37-67`): raw JSON *or* base64, `private_key`→`privateKey` normalization, `\\n`→newline fixup, module-level singleton. Use `jose` for the JWS.

- [ ] **Step 3: Wire the Android branch of `verifyPlatformAttestation`**

```ts
  if (input.attestation.platform === 'android') {
    const key = verifyAndroidKeyAttestation({
      certificateChainDerB64: input.attestation.certificateChain,
      expectedChallenge: input.transcript,
      expectedPackageName: 'com.breeze.rmm',
    });
    // The attested leaf key MUST be the key being registered.
    if (!key.attestedPublicKeyDer.equals(canonicalSpkiDer(input.publicKeySpkiB64))) {
      throw new Error('android attestation does not cover the registered key');
    }

    const integrity = input.attestation.playIntegrityToken
      ? await verifyPlayIntegrityToken(input.attestation.playIntegrityToken, { packageName: 'com.breeze.rmm' })
      : null;

    return {
      basis: key.keyMintSecurityLevel === 'StrongBox'
        ? 'android_strongbox_key_attestation'
        : 'android_tee_key_attestation',
      verifiedAt: new Date(),
      keyId: key.leafSerial,
      evidence: {
        verifier: 'android_key_attestation',
        verifierVersion: 1,
        keyMintSecurityLevel: key.keyMintSecurityLevel,
        attestationSecurityLevel: key.attestationSecurityLevel,
        verifiedBootState: key.verifiedBootState,
        deviceLocked: key.deviceLocked,
        packageName: key.packageName,
        playIntegrity: integrity ?? null,
      },
      appIntegrityVerifiedAt: integrity ? new Date() : null,
    };
  }
```

- [ ] **Step 4: Run, typecheck, contract suites, PR against `main`, one review round** (Opus/Sonnet — cryptographic verifier on the auth path).

---

# Wave 05 — iOS client: Secure Enclave P-256 + App Attest

Branch: `feature/1374-mobile-attestation/w05-ios-client`. Base: `main`. **Requires W02 + W03 deployed.**

### Task 1: The local Expo module

**Files:**
- Create: `apps/mobile/modules/breeze-attestation/` (via `npx create-expo-module --local breeze-attestation`)
  - `ios/BreezeAttestationModule.swift`
  - `src/index.ts`, `src/BreezeAttestation.types.ts`
  - `expo-module.config.json`
- Modify: `apps/mobile/app.json` — add the App Attest entitlement

**Interfaces (the TS surface every later task codes against):**
```ts
export interface AttestedKey { publicKeySpkiB64: string; alg: 'ES256'; }
export interface IosAttestation { platform: 'ios'; attestationObject: string; keyId: string; }

/** True when the OS supports App Attest AND a hardware key can be minted. */
export function isAttestationAvailable(): Promise<boolean>;
/** Mint a Secure Enclave P-256 key with a biometryCurrentSet ACL. */
export function createAttestedKey(): Promise<AttestedKey>;
/** App-Attest the app instance, binding `transcriptB64` as clientDataHash. */
export function attestApp(transcriptB64: string): Promise<IosAttestation>;
/** Biometric-gated ECDSA-SHA256 over `payloadB64`. Rejects on cancel. */
export function signWithAttestedKey(payloadB64: string, reason: string): Promise<{ signature: string }>;
export function deleteAttestedKey(): Promise<boolean>;
```

**Swift implementation constraints (do not silently relax any of these):**
- `SecKeyCreateRandomKey` with `kSecAttrTokenID: kSecAttrTokenIDSecureEnclave`, `kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom`, `kSecAttrKeySizeInBits: 256`.
- Access control: `SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, [.privateKeyUsage, .biometryCurrentSet], &error)`. `.biometryCurrentSet` (not `.biometryAny`) so enrolling a new face/finger invalidates the key.
- A **fresh** `LAContext` per signature — never a cached, already-evaluated context.
- Export the public key with `SecKeyCopyExternalRepresentation` (X9.62 uncompressed) and wrap it in the SPKI DER header in Swift, so what the server stores is a real SPKI.
- App Attest via `DCAppAttestService.shared`; guard `isSupported`.

- [ ] **Step 1: Scaffold and wire the entitlement**

```bash
cd apps/mobile && npx create-expo-module --local breeze-attestation
```

In `apps/mobile/app.json`, add under `expo.ios`:
```json
"entitlements": { "com.apple.developer.devicecheck.appattest-environment": "production" }
```
Prebuild merges `ios.entitlements` into the generated entitlements file. Verify with `npx expo prebuild -p ios --clean` and grep the generated `ios/breezerrmm/*.entitlements`. **`ios/` is generated and gitignored** (`apps/mobile/.gitignore:49-59`) — do not commit it; Xcode Cloud re-runs prebuild via `ios/ci_scripts/ci_post_clone.sh:163`.

- [ ] **Step 2: Write the failing TS-side tests**

The Swift is **not** unit-testable in CI (same precedent as `hardwareSigner.ts`, which is deliberately untested and flagged for on-device verification — see `apps/mobile/src/services/hardwareSigner.test.ts:11-13`). What IS testable is the JS fallback contract. Create `apps/mobile/src/services/attestingSigner.test.ts`:

```ts
// vitest runs environment:'node' and only picks up src/**/*.test.ts, so the
// native module is never resolvable here — exactly the condition the fallback
// exists for.
it('reports unavailable when the native module cannot be resolved', async () => {
  expect(await getAttestingSigner().isAvailable()).toBe(false);
});
it('refuses to mint a key when unavailable rather than returning a fake one', async () => {
  await expect(getAttestingSigner().createAttestedKey()).rejects.toThrow(/unavailable/i);
});
it('refuses to attest when unavailable', async () => {
  await expect(getAttestingSigner().attestApp('dHJhbnNjcmlwdA==')).rejects.toThrow(/unavailable/i);
});
```

- [ ] **Step 3: Run, watch fail, implement `apps/mobile/src/services/attestingSigner.ts`** using the same optional-require + null-object pattern as `hardwareSigner.ts:71-93` and `nullSigner` at `:38-50`.

- [ ] **Step 4: Correct the stale comments**

`apps/mobile/src/services/hardwareSigner.ts:8-13` and `apps/mobile/src/services/approverDevice.ts:4-9` both claim the current RSA key wraps the Secure Enclave. It does not — the SE holds only P-256 keys. Rewrite both to say what is true: the legacy signer is a **biometric-gated Keychain RSA key**, which is why it registers `unattested` and cannot reach L4; `attestingSigner` is the Secure Enclave path.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/modules apps/mobile/app.json apps/mobile/src/services/attestingSigner.ts apps/mobile/src/services/attestingSigner.test.ts apps/mobile/src/services/hardwareSigner.ts
git commit -m "feat(mobile): Secure Enclave P-256 + App Attest native module (#1374)"
```

### Task 2: Two-step registration in the client

**Files:**
- Modify: `apps/mobile/src/services/approverDevice.ts`
- Test: `apps/mobile/src/services/approverDevice.test.ts`

**Interfaces:**
- Produces: `ApproverRegistrationOutcome` gains `{ status: 'registered'; attested: boolean }` and `{ status: 'failed'; reason: 'attestation_failed' | ... }`.

- [ ] **Step 1: Write the failing tests** (mock `fetch` and `./attestingSigner` inline, exactly as the existing suite mocks `expo-secure-store` at `approverDevice.test.ts:21-24`):

```ts
it('POSTs challenge then verify, carrying the grant only on the challenge call', async () => { /* … */ });
it('signs the transcript returned by the server, not a client-chosen value', async () => { /* … */ });
it('falls back to the legacy unattested endpoint when attestation is unavailable', async () => { /* … */ });
it('returns failed/attestation_failed (not a silent legacy fallback) when attestApp throws', async () => {
  // A DEVICE that supports attestation but FAILS it must not silently degrade
  // to an unattested L2 key — the user needs to know their phone will not
  // approve critical requests.
});
it('does not retry with the same attemptId after a 400', async () => { /* single-use */ });
```

- [ ] **Step 2: Run, watch fail, implement.**

Flow: `isAttestationAvailable()` → if false, keep today's single-POST legacy path (registers `unattested`, works at L2/L3). If true: `POST /devices/mobile/challenge {platform:'ios', registerGrantId}` → `createAttestedKey()` → compute the transcript **client-side using the same formula** (`SHA256(domain\nattemptId\nchallenge\nalg\nspki)`) → `attestApp(transcriptB64)` → `signWithAttestedKey(transcriptB64, 'Register this phone for approvals')` → `POST /devices/mobile/verify`.

Put the transcript formula in **one** shared module, `packages/shared/src/utils/authenticatorTranscript.ts`, imported by both the API service and the mobile client, with a test asserting both produce the same digest for the same inputs. Two independent implementations of a security transcript is how they drift.

- [ ] **Step 3: Run, typecheck, commit**

```bash
pnpm --filter breeze-mobile test && pnpm --filter breeze-mobile exec tsc --noEmit
```

### Task 3: On-device verification (manual, cannot be CI'd)

- [ ] **Step 1:** Build a dev-client (`eas build --profile development --platform ios`) and install on a physical device.
- [ ] **Step 2:** Sign in; confirm the server row lands with `platform_bound_basis = 'ios_se_p256_app_attest'`, `attestation_verified_at` non-null, `public_key_alg = 'ES256'`, `possession_verified_at` non-null, `last_used_at` null.
- [ ] **Step 3:** Approve a **critical-tier** PAM elevation from the phone; confirm `decided_assurance_level = 4` and `last_used_at` is now set.
- [ ] **Step 4:** Enroll a new Face ID identity; confirm the key is invalidated (`.biometryCurrentSet`) and the app reports `failed` rather than silently signing.
- [ ] **Step 5:** Record the results in the PR body. **This is the only proof the Swift path works** — do not claim the wave is done without it.

---

# Wave 06 — Android client: StrongBox/TEE + Key Attestation + Play Integrity

Branch: `feature/1374-mobile-attestation/w06-android-client`. Base: `main`. **Requires W02 + W04 deployed.** Mirrors W05 task-for-task.

- [ ] **Task 1:** Kotlin side of `modules/breeze-attestation`. `KeyGenParameterSpec.Builder(alias, PURPOSE_SIGN)` with `setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))`, `setDigests(DIGEST_SHA256)`, `setAttestationChallenge(transcript)`, `setUserAuthenticationRequired(true)`, `setInvalidatedByBiometricEnrollment(true)`, and `setIsStrongBoxBacked(true)` with a **documented** catch-and-retry on `StrongBoxUnavailableException` falling back to TEE (which yields `android_tee_key_attestation`, still L4-trusted). Export `KeyStore.getCertificateChain(alias)` as base64 DER, leaf first. Play Integrity via `com.google.android.play:integrity`.
- [ ] **Task 2:** Extend `attestingSigner.ts` with the Android branch; the client-side flow is identical to W05 Task 2 (the transcript comes from `packages/shared/src/utils/authenticatorTranscript.ts`), plus the Play Integrity token. Same test list.
- [ ] **Task 3:** On-device verification on (a) a StrongBox device (Pixel 6+) and (b) a TEE-only device. Confirm the two bases land distinctly and both reach L4. Confirm an unlocked-bootloader device is **refused** (`deviceLocked` check, W04 Task 1 check 6).

---

# Wave 07 — Surfacing, rollout, docs

Branch: `feature/1374-mobile-attestation/w07-rollout`. Base: `main`. Low blast radius — copy, badges, dashboards.

- [ ] **Task 1: Web — honest badge.** `apps/web/src/stores/authenticator.ts` gains `platformBoundBasis` on `ApproverDevice`; `apps/api/src/routes/authenticator.ts`'s `toPublicDevice` returns it. `ApproverDevicesSection.tsx:292` currently shows a single "Platform-bound" badge from the boolean — split it into "Hardware-attested" (trusted basis) and a neutral-toned "Not attested" for `unattested`/`legacy_unattested`, with a tooltip saying critical approvals are unavailable from that device. Add keys to **all 9 locale dirs** under `apps/web/src/locales/*/settings.json`; `en` alone reddens every branch. Update `ApproverDevicesSection.test.tsx`.
- [ ] **Task 2: Mobile — banner.** Add an `unattested` severity to `apps/mobile/src/navigation/approverBannerCopy.ts` (that file's header comment sets the standard: the copy must be honest about what action actually fixes it — "update the app and sign in again", not "turn on Face ID"). Wire it in `ApprovalGate.tsx`. Extend `approverBannerCopy.test.ts`.
- [ ] **Task 3: Alerting.** A Prometheus rule on `breeze_authenticator_l4_basis_total{outcome="denied"}` — a sustained non-zero rate after W05/W06 ship means technicians are stuck on unattested keys. Add a `would_deny` panel so the pre-flip blast radius stays visible if the flag is ever reverted.
- [ ] **Task 4: Docs.** Update `apps/docs` for the assurance ladder (what L4 now requires, why a phone may show "not attested", how to re-enroll). Use the `update-breeze-docs` skill. Cite published `docs.breezermm.com` URLs in any comms, not source paths.
- [ ] **Task 5: Legacy endpoint retirement.** Once W05+W06 have shipped and the fleet has rolled, `POST /authenticator/devices` (the single-POST legacy path) can start returning `410 Gone`. **Do not do this in the same wave as W05/W06** — old app builds must keep registering at L2/L3 while users update. File a follow-up issue rather than guessing the date.

---

## Self-review

**Spec coverage.** Issue #1374 asks for: (1) API verification endpoints + key storage → W01 Task 1 (storage), W02 Task 3 (endpoints), W03/W04 (verifiers). (2) Mobile attestation calls → W05, W06. (3) Migration for attestation state → W01 Task 1, W02 Task 1. (4) Backfill/grandfathering policy → W01 Task 1 Step 4 (classify, don't flip) + design decision 5 + open question Q1. (5) Rollout flag + monitoring → W01 Task 2 Step 3 (flag), W01 Task 3 (metric), W07 Task 3 (alerting). (6) HIGH blast radius noted → the banner at the top of this document. The issue's *Proposed Fix* option 2 ("treat unattested mobile keys as L2-only") is what W01 implements as the interim state; option 1 (attest, then trust) is W02–W06.

**Placeholder scan.** No "TBD"/"handle edge cases"/"similar to Task N". The three places that intentionally defer are named and bounded: `verifyPlatformAttestation` returns `unattested` in W02 by design (stated in the code comment, replaced in W03/W04); W06's tasks are described at one level less depth than W05's because they mirror it structurally, and each names its concrete Android API surface; W07 Task 5 defers a date to a follow-up issue rather than inventing one.

**Type consistency.** `PlatformBoundBasis` / `platformBoundBasis` / `authenticator_platform_bound_basis` are used consistently W01→W07. `L4_TRUSTED_PLATFORM_BOUND_BASES` is defined once (W01 Task 2) and referenced by name after. `MobileKeyAlg` is introduced in W02 Task 1 and used in W02 Task 2/3 and W03 Task 1. `registrationTranscript` is defined in W02 Task 2 and moved to `packages/shared` in W05 Task 2 — that move is called out explicitly rather than left as a silent duplicate. `AttestationResult` (W02 Task 3) is the return type both W03 Step 6 and W04 Task 2 Step 3 build.

---

## Open questions for Todd

**Q1 — Ship W01 with `BREEZE_AUTHENTICATOR_ATTESTATION_ENFORCED` defaulting to `true` on day one, or dark-run first?**
- **A — Default `true` (as written).** Pro: the critical-tier bypass closes the day W01 deploys, which is what p1 escalation implies. Con: any technician whose *only* approver device is a phone loses critical-tier approval until W05/W06 ship and they re-enroll — weeks, given App Store review. Bounded by browser WebAuthn still reaching L4, and by non-enforcing partners recording `graceDowngrade` instead of a denial.
- **B — Default `false` for one release, flip after measuring `outcome="would_deny"`.** Pro: exact blast radius known before anyone is blocked. Con: knowingly leaves the bypass open for a release cycle.

**Recommend A** — the metric emits `denied` under A just as it emits `would_deny` under B, so A gives the same visibility without leaving the gap open; and the web path means "no L4 from anywhere" is not the actual failure mode.

**Q2 — Android: Key Attestation as primary, per design decision 3, deviating from the issue's literal "Play Integrity" wording?** Play Integrity cannot attest that a key is hardware-backed; Key Attestation can. The plan implements both, with only Key Attestation setting the basis. This is a deliberate deviation from the decision text and needs a yes.

**Q3 — Do browser WebAuthn keys stay L4-eligible on `webauthn_backup_flags`?** They are derived from `singleDevice && !backedUp` with `attestationType: 'none'` — backup-eligibility flags, not hardware attestation. Keeping them trusted is what makes Q1 option A tolerable. Tightening them is a separate piece of work with its own blast radius. The plan keeps them and names the exception in code; confirm that is the intent.

**Q4 — How many production rows are affected?** The migration will print the count, but a pre-flight number would sharpen Q1. Needs a read against both regions' managed Postgres:
```sql
SELECT kind, platform_bound_basis, count(*) FROM authenticator_devices GROUP BY 1,2;
SELECT count(*) FROM authenticator_policies WHERE require_enrollment = true;  -- enforcing partners
```
I have not run this (prod DB access is out of scope for a planning session) — happy to hand over a dry-run script.
