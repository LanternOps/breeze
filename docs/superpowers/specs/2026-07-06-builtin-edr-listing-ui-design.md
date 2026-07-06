# Built-in EDR Listing UI — Ready-to-Deploy Redesign

**Date:** 2026-07-06
**Branch:** `ToddHebebrand/software-deploy-UI`
**Status:** Design approved — ready for implementation plan
**Area:** `apps/web/src/components/software/`

## Problem

Built-in EDR packages (Huntress, SentinelOne) are provisioned into the Software
Library when the corresponding integration is connected (`ensureBuiltinPackage`,
`apps/api/src/services/builtinDeploymentPackages.ts`). But when a user opens the
Huntress listing today it looks like a bare, generic package that still needs
work:

- Generic grey `Package` icon — identical to every other package, no branding.
- Detail modal says passively: *"Built-in package managed by the Huntress integration."*
- The Deploy button carries a tooltip *"Deploys to mapped organizations only"* —
  which reads like an unmet prerequisite.
- **No readiness signal.** Whether the deployment account key is set and orgs are
  mapped is invisible until a deploy *fails* with a fail-fast message from
  `edrInstallerResolver.ts` (e.g. *"Huntress account key not configured"*).

The result: a fully-working, ready-to-go integration *looks* like a chore the
user still has to finish.

## Goal

When a built-in EDR listing is opened, it should read as a first-class,
integrated product that is **visibly ready to deploy** — and, when it genuinely
is not ready, it should say exactly which one thing is missing rather than
looking uniformly unfinished.

Four confirmed intents (all in scope):
1. **Show it's ready-to-deploy** — a readiness panel, not silence.
2. **Make it look intentional** — product framing (name, blurb, "Managed built-in"
   chip) and a tinted security icon per provider. **No official brand marks/logos**
   (avoids trademark/asset concerns) — a `ShieldCheck` tinted with the provider
   accent replaces the generic grey box.
3. **Guide the deploy flow** — Deploy preselects this package; clarify it targets mapped orgs.
4. **Hide the prereq-looking cues** — when ready, no warnings/tooltips; for Huntress nothing is ever uploaded.

**Scope:** both built-in EDR providers (Huntress + SentinelOne), via one
provider-aware component set. Huntress surfaces account-key + org-mapping
readiness; SentinelOne surfaces installer-upload + site-token readiness.

## Non-goals / Out of scope

- The custom **"Add Package"** single-step modal and the generic installer-URL
  variable affordance — that is the sibling shaping's territory
  (`software_deploy_ui_shape_single_step_package_and_url_vars`; the untracked
  `apps/web/src/lib/installerVariables.ts` on this branch). Do **not** fold that
  work into this change.
- No backend changes. Readiness is derived from existing endpoints. If a needed
  signal turns out to be missing, that is a flagged deviation to raise, not a
  silent scope expansion.

## Approach

Approach **B** of three considered:

- **A — Special-case inside `SoftwareCatalog.tsx`.** Rejected: that file is already
  ~595 lines and mixes generic + built-in concerns; inlining bloats it further.
- **B — Extract dedicated built-in components + a readiness hook + a branding map (chosen).**
  Clean isolation, testable, keeps Huntress/S1 consistent, no backend change.
- **C — Backend-enriched catalog** (embed a `readiness` object per item in
  `/software/catalog`). Rejected as overkill: there is one integration per
  partner, so a single readiness fetch already covers every Huntress card; the
  RLS-scoped counts + tests aren't worth it.

## Backend facts this relies on (no changes required)

- `GET /software/catalog` (`apps/api/src/routes/software.ts`) already returns per
  item: `integrationProvider`, `isManaged`, `iconUrl`, `websiteUrl`, `versionCount`.
- `GET /huntress/integration` (`apps/api/src/routes/huntress.ts:286`) returns, at
  partner scope: `isActive`, `hasAccountKey`, `lastSyncOrgs` (count of orgs synced
  from Huntress = mapped-org count), `lastSyncAt`, `lastSyncStatus`. At org scope
  it returns `{ data: null, mapped: false }` when the caller's org is not mapped.
- SentinelOne readiness comes from the catalog item itself (`versionCount ≥ 1` =
  installer uploaded) plus the S1 integration status endpoint for the site token
  (mirror of the Huntress status endpoint; confirm exact field name during build
  — `apps/api/src/routes/sentinelOne.ts`).

## Components

All new files under `apps/web/src/components/software/`.

### `providerBranding.ts`
A static, declarative map keyed by `IntegrationProvider`:
```
provider → {
  label:        string          // "Huntress"
  icon:         LucideIcon        // ShieldCheck (NOT an official logo)
  accent:       string           // tailwind class group for the tinted icon + chip
  blurb:        string           // "Managed endpoint detection & response — installs the latest agent automatically."
  readiness:    ReadinessSpec    // ordered checks + how to read them (see below)
}
```
- **No official brand marks/logos** (per decision — avoids trademark/asset
  concerns, and `ensureBuiltinPackage` stores `iconUrl: null` anyway). Each
  provider gets a `ShieldCheck` lucide icon tinted with its accent class,
  replacing the generic grey `Package` box. "Intentional" comes from the accent +
  product framing (name, blurb, chip), not a logo.

### `useEdrReadiness.ts`
A hook that fetches the provider status **once** per mount and returns a
normalized, provider-agnostic readiness object:
```
{ loading, error,
  checks: Array<{ key, label, ok: boolean, detail?: string, fixHref?: string }>,
  ready: boolean,          // every check ok
  firstGap?: check         // the first not-ok check, for the "one next step" UI
}
```
- Huntress: reads `GET /huntress/integration` via `fetchWithAuth`.
  - `connected` = `data != null && data.isActive`
  - `accountKeyConfigured` = `data.hasAccountKey`
  - `orgsMapped` = `data.lastSyncOrgs > 0` (detail: "N orgs mapped")
- SentinelOne: `installerUploaded` from the catalog item's `versionCount`;
  `siteTokenConfigured` from the S1 status endpoint; `connected` likewise.
- Errors surface as a non-blocking readiness-unknown state (never a silent
  "looks ready"): if the status call fails, show "Couldn't verify setup" rather
  than a false green.

### `BuiltinPackageDetail.tsx`
Rendered as the detail-modal body when `selectedSoftware.integrationProvider` is
set (replacing the current generic Details tab body for built-ins). Composition:
- **Header:** provider tinted `ShieldCheck` icon + name + `blurb`; a "Managed
  built-in" chip. Website link if present. (No official logo.)
- **Readiness panel:** the ordered checks from `useEdrReadiness`, each a
  row with a check/alert icon.
  - **All green:** a single confident line ("Ready to deploy to N mapped orgs")
    and the primary **Deploy** CTA. No warnings, no prereq tooltips.
  - **Any red:** render only the readiness rows plus **one** highlighted next
    step derived from `firstGap` (e.g. "Add your Huntress account key in
    Integrations") with a deep link. Deploy stays visible but is disabled with a
    title naming the specific gap — not the generic "mapped organizations only".
- Keep the existing Versions tab reachable for built-ins (S1 uploads its
  installer there). For Huntress, the Versions tab is informational (a single
  templated `latest`).

## `SoftwareCatalog.tsx` changes

- **Card (grid):** for built-in EDR items, render the provider tinted `ShieldCheck`
  icon instead of the grey `Package` box, and a subtle readiness **pill** (green "Ready" /
  amber "Setup needed" / neutral "Checking…") driven by the shared readiness
  fetch. Because there is one integration per partner, fetch readiness **once** at
  the catalog level and pass it down — do not issue one request per card.
- **Remove the misleading generic cue** for Huntress: the current
  `needsInstallerUpload` text/tooltip must not apply to Huntress (it never
  uploads). S1's upload need is expressed as a readiness item, not ad-hoc text.
- **Guided deploy / preselect:** the card and detail Deploy buttons currently call
  `setShowDeployWizard(true)` with **no package**. They must preselect the clicked
  package into `DeploymentWizard` (the fix already flagged in the sibling memory).
- Built-in detail body delegates to `BuiltinPackageDetail`; non-built-in items
  keep the existing Details/Delete/Deploy body unchanged.

## `DeploymentWizard.tsx` changes

- Accept a `preselectedPackage` (or `preselectedCatalogId`) prop and start on the
  chosen package rather than an empty selection.
- For a built-in EDR package, show a short context line that it deploys to mapped
  orgs only. **Stretch (nice-to-have, not core):** filter the org/device picker to
  only mapped orgs. Core requirement is the preselect + the context line.

## Error handling

- All reads via `fetchWithAuth`. Any mutation via `runAction` (repo rule
  `no-silent-mutations`). This change is read-heavy; the only mutation path is the
  existing deploy dispatch inside the wizard, already wrapped.
- Readiness fetch failure → explicit "couldn't verify setup" state, never a false
  ready. The server already fails deploys loudly with specific messages
  (`edrInstallerResolver.ts`), so the UI's job is to *pre-surface* those gaps, not
  to re-implement them — the honest fallback is deferring to the server's
  fail-fast message.

## Testing

- `BuiltinPackageDetail.test.tsx` — all-green ready state; each single-gap state
  (missing account key, no mapped orgs, disconnected) renders exactly one next
  step and disables Deploy with the right title; readiness-unknown on fetch error.
- `useEdrReadiness` — Huntress mapping of `{ isActive, hasAccountKey, lastSyncOrgs }`
  → checks; org-scope `mapped:false`; error path.
- Update `SoftwareCatalog.test.tsx` — built-in card renders brand mark + pill;
  Deploy preselects the package (assert the wizard receives it); Huntress card
  shows no "upload installer" cue.
- No backend change → no new integration tests.

## Rollout / flag interplay

- No new flag. The EDR connect UI is already gated by the build-time web flag
  `PUBLIC_ENABLE_EDR_INTEGRATIONS`; this change only affects how built-in EDR
  packages render inside the already-reachable Software Library, so it needs no
  additional gating.

## Build order

1. `providerBranding.ts` (tinted `ShieldCheck` per provider — no logo assets).
2. `useEdrReadiness.ts` with Huntress wired; unit tests.
3. `BuiltinPackageDetail.tsx` (readiness panel + guided CTA); tests.
4. `SoftwareCatalog.tsx` — brand mark + pill on cards, delegate built-in detail
   body, preselect deploy; update tests.
5. `DeploymentWizard.tsx` — accept preselected package + built-in context line.
6. SentinelOne readiness wiring (installer-upload + site-token) reusing the shell.
7. Harden pass: readiness-unknown state, empty/zero-org edge, dark theme.
