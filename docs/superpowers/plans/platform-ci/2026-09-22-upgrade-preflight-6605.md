---
issue: LanternOps/breeze#6605
parent_decision: LanternOps/breeze#6472
---

# Upgrade preflight: breaking-change manifest, boot report, version history

Decision on #6472 (2026-09-22): release-count deprecation windows are not a
safety control. The replacement control is visibility before mutation: the
operator is told, before migrations run, every retirement an upgrade crosses.

## Wave 1 (this PR)

| Scope item (#6605) | Where |
|---|---|
| 1. Cumulative manifest shipped in the image, validated in CI | `apps/api/src/upgrade/breaking-changes.json` (bundled into `dist/*.cjs`), schema in `breakingChangesManifest.ts`, CI checks in `breakingChangesManifest.test.ts` |
| 2. Preflight entrypoint before `autoMigrate` | `node dist/scripts/upgrade-preflight.cjs [--strict]` (`apps/api/scripts/upgrade-preflight.ts`) |
| 3. Report logged once at boot | `initializeDatabaseForStartup({ upgradeChecks: true })`, before `migrate()` |
| 5. `(version, first_seen_at)` per boot | `breeze_version_history`, written after migrations succeed |

### Contracts

- **Report, never refuse.** Boot always continues. A preflight or recording
  failure is a `warn` line. Only the operator-invoked CLI with `--strict` (or
  `BREEZE_UPGRADE_PREFLIGHT_STRICT=true`) exits 1, when a removal is or may be
  crossed. Deprecations alone never fail strict mode.
- **Missing history widens the report.** No history table, an empty one, one
  holding only non-release versions, an unreachable database, or an image
  without a release `APP_VERSION` (including the `0.2.0` Dockerfile default):
  every retirement in effect for this image is listed as *possibly* crossed.
  The report never says "no issues" in that state.
- **Cumulative manifest.** Entries are never deleted. `RECORDED_ENTRY_IDS` in
  the test is the ratchet. An image must describe every retirement a
  deployment on any older version could cross by jumping straight to it.
- **Manifest agrees with enforcement.** Each entry's test checks its fields
  against the code register (for the seed entry,
  `RETIRED_LABOUR_PRICING_FIELDS`), checks that the validators reject them, and
  checks that the rejection message names the same removal version.
- **Prerelease = its release.** `0.116.0-rc.1` counts as having crossed
  0.116.0's removals.

### `breeze_version_history` is intentionally system-scoped

Platform bookkeeping of the same kind as `breeze_migrations`. It holds no
tenant data and has no `org_id`, so no tenancy shape applies. It has no RLS.
It is written only at boot over the migration connection (`DATABASE_URL`,
schema owner).

- Registered in `PLATFORM_INFRASTRUCTURE_TABLES`
  (`rls-coverage.integration.test.ts`) and `CORE_NON_DRIZZLE_TABLES`
  (`extensions/tenancyTripwire.ts`).
- `breeze_app` is SELECT-only. The migration revokes INSERT, UPDATE, DELETE
  and TRUNCATE, and `ensureAppRole` re-revokes them on every boot, because its
  blanket grant would otherwise restore them. `ensureAppRole.appendOnlyCoverage.test.ts`
  enforces the pairing. A request-path write could forge or erase what the
  next preflight believes the deployment ran.
- The table has no org cascade, export-policy or merge registration because it
  has no `org_id`.

## Wave 2 (follow-up): Settings → System → Deprecations

Scope item 4. It lists active and upcoming retirements for the deployment,
each with its replacement, and the recorded version history.

- A read-only system-scope API route returns the bundled manifest and the
  `buildPreflightReport` result, reading `breeze_version_history` with the
  request role's SELECT grant.
- A web page under Settings → System, registered in `settingsPageRegistry`.
  Per the settings rules it is a report, not a setting: it adds no
  configurable concept. The PR description must still state its home, level,
  resolver, and the count of places it is configured before and after (0 → 0).
- Who can view it: platform or system admins only, because the table is
  deployment-wide rather than per-tenant. This needs a decision before building.
