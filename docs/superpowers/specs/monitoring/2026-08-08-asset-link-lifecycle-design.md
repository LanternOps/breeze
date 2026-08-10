# Discovered-asset linking — durable unlink, legible link state, scoped picker

**Date:** 2026-08-08
**Status:** Approved (owner, 2026-08-08) — includes the owner-directed
hidden-and-automatic reframe; revisits one decision from the 2026-06-27 unlink
design (flagged in §A4).
**Plan:** `docs/superpowers/plans/open/2026-08-08-asset-link-lifecycle.md`
**Issues addressed:** #3261 (companion to #3199)
**Branch:** —

## Problem

Linking is an identity assertion — "this scanned IP is that agent-managed box" —
used for dedupe (linked assets are hidden from the unified Devices list,
`apps/api/src/routes/devices/network.ts:118-119`) and alert attribution
(`monitorWorker.ts:241-256`, `networkBaseline.ts:432-464`). The semantics are
sound and the modal copy even explains them. The lifecycle and display are not:

1. **Manual unlink self-destructs.** `DELETE /discovery/assets/:id/link` clears
   both `linked_device_id` AND `link_source`
   (`apps/api/src/routes/discovery.ts:1542-1547`). The next discovery scan sees
   `alreadyLinked === false` (`discoveryWorker.ts:852-853`), re-runs the
   auto-linker, re-matches the same MAC/IP (`:879-892`), and writes
   `linkSource:'auto'` (`:894-898`). Auto-links cannot be unlinked — the
   endpoint 403s (`discovery.ts:1533-1535`) and both Unlink buttons hide behind
   `isManualLink` (`AssetDetailModal.tsx:583`,
   `NetworkDeviceDetailPage.tsx:497`). So Unlink works exactly once, then the
   link returns within one scan cycle in a form the user can never undo, and
   the device flickers in/out of the Devices list on scan cadence. Nothing in
   the schema records "user said no"; `discoveryWorker.test.ts` has zero
   unlink coverage.
2. **Auto-links can't be unlinked at all.** The 2026-06-27 design
   (`2026-06-27-unlink-network-discovered-device-design.md:38-39`) chose
   manual-only unlink — defensible then, because without suppression an
   auto-link unlink would be undone next scan anyway. Auto is the common case
   (every MAC/IP match), so the practical effect is "linking is not
   user-controllable".
3. **Link state is illegible everywhere.**
   - Discovery list: bare green check + device name, no label, no i18n key
     (`DiscoveredAssetList.tsx:508-513`), adjacent to the "Monitored" badge —
     reads as a status, not a relationship.
   - The asset modal never renders `linkedDeviceName` (fetched, used zero
     times); a "Currently linked to {name}" line ships with #3199's spec.
   - The managed device's page (`DeviceDetails.tsx`, 829 lines) contains zero
     references to discovery — the relationship is invisible from the device
     side, and a linked asset's own page is reachable only by direct URL
     (linked assets are excluded from the list that links to it).
4. **The link picker is unscoped and sometimes empty.**
   `DiscoveredAssetList.tsx:337-350` fetches bare `/devices`; the API requires
   same-org and same-site (`discovery.ts:1458-1464`), so the dropdown offers
   devices guaranteed to 403, and failures render generic
   `"Failed to link asset"` (`AssetDetailModal.tsx:141-143`) instead of the
   server message. The `/discovery?asset=` deep-link path passes no `devices`
   prop at all (`DiscoveryPage.tsx:709-719`) → empty picker.
5. **No state-aware affordances.** Button always reads "Link asset"; hidden
   Unlink comes with no explanation.

## Goals

- **Linking is hidden and automatic.** MAC/IP auto-link does the work; the
  manual link UI disappears from the primary discovery surface (the asset
  modal). Users interact with *proxy*, not with linking — the two must never
  again share a surface (product direction set 2026-08-08 with the owner).
- Unlink that stays unlinked: a recorded suppression the auto-linker respects,
  available for auto-links too (supersedes the manual-only rule).
- Link *state* stays visible where it explains something (function-first
  "Same device as X" wording); link *controls* live on exactly one quiet
  surface — the network device detail page.
- **Invariant, stated explicitly:** the identity link is display + alert
  attribution only. Nothing security-bearing (proxy routing, access decisions,
  allowlists) may ever key off `linkedDeviceId`. MAC/IP matching is spoofable
  by anything on the LAN; that is acceptable *only* while the link confers no
  privileges — this invariant is what makes hidden-and-automatic safe.

## Non-goals (YAGNI)

- Devices-list absence semantics, inline link/unlink from the list, and the
  `PUBLIC_ENABLE_NETWORK_DEVICES_IN_LIST` flag flip — #1424 owns these.
- Proxy bridge defaulting and the modal's Proxy Access section — #3199.
- Multi-link modeling changes (N assets → one device stays legal; no unique
  constraint added).
- Merging/copying data on link (unchanged: link remains association-only).

## Architecture

### A. Durable unlink (API + worker + schema)

1. **`auto_link_suppressed_at`** — new nullable `timestamptz` on
   `discovered_assets`. Set by manual unlink; cleared by any manual link.
   Registered in `CORE_TENANT_EXPORT_POLICY` (`included`) in the same PR —
   `discovered_assets` is an org-cascade table, so an unregistered ADD COLUMN
   fails the export-policy integration suite.
2. **Unlink** (`DELETE /discovery/assets/:id/link`): drop the `isManualLink`
   403 — auto and manual links unlink identically. Clear
   `linked_device_id`/`link_source`, set `auto_link_suppressed_at = now()`.
   Approval status stays untouched (2026-06-27 decision, unchanged).
3. **Auto-linker** (`discoveryWorker.ts:875-922`): skip the asset entirely when
   `auto_link_suppressed_at IS NOT NULL`. Suppression is per-asset, not
   per-pair: MAC/IP matching would almost always re-find the same device, and
   per-asset is one column with no matching-logic changes. A later *manual*
   link clears suppression, so auto-linking resumes only after a human
   re-asserts identity.
4. **Design decision this reverses (flagged for review):** 2026-06-27 chose
   manual-only unlink. That predates suppression — unlinking an auto-link was
   then pointless (undone next scan). With suppression, unlink is meaningful
   for both provenances, and keeping the 403 would preserve defect 2 while
   fixing defect 1. The `link_source` provenance column itself stays — it
   still distinguishes "human asserted this" for role-propagation
   (`discoveryWorker.ts:901-916`) and audit.

### B. Hidden controls, visible state (web + API)

1. **The asset modal's "Link to managed device" section is removed entirely**
   (`AssetDetailModal.tsx:552-605`). In its place: one read-only line,
   "Same device as {name}" (linking to `/devices/<linkedDeviceId>`), rendered
   only when linked. Combined with #3199 (which removes the Proxy Access
   section), the modal ends up with **zero device pickers** — the structural
   fix for the twin-dropdown confusion.
2. **Discovery list:** replace the bare check+name with a labeled badge —
   `discoveredAssetList.sameDeviceAs` = "Same device as {{name}}" — visually
   distinct from the "Monitored" status badge, linking to
   `/devices/<linkedDeviceId>`. Wording deliberately describes what the link
   *does* (identity/dedupe) and avoids any proxy phrasing — "link" being read
   as proxy routing is the documented failure mode (#1730's old copy taught
   that model; #3199 removes its last code-level remnant).
3. **Device → asset back-link:** `DeviceDetails` gains a "Network asset" row
   (Overview area) when discovered assets link to the device: asset label/IP
   linking to `/devices/network/<assetId>`; render as a short list when more
   than one. Data: `GET /discovery/assets?linkedDeviceId=<id>` (existing list
   route + new filter param, org-scoped as today).

### C. Single override surface: the network device page

1. **`NetworkDeviceDetailPage`'s Discovery section becomes the only manual
   surface.** It already shows "Linked Device" + Unlink (`:483-512`); it
   grows: provenance in the label ("Same device as {name} — auto-detected" /
   "— set manually"), Unlink for both provenances (per A2), the
   suppressed-state line ("Auto-linking disabled — unlinked by a user"), and a
   small "Link manually…" action for the one case auto-link can't handle
   (cross-subnet discovery where no MAC is visible and IPs don't match).
2. **The manual picker is site-scoped and self-sufficient:** fetches
   `GET /devices?siteId=<asset's siteId>` on open (the API requires same-org
   AND same-site, `discovery.ts:1458-1464`, so an unscoped list offers
   guaranteed-403 options), surfaces server errors via `extractApiError`, and
   wraps mutations in `runAction` (this component is already migrated).
3. **`DiscoveredAssetList` stops passing the `devices` prop** — with both
   modal pickers gone (this spec + #3199), nothing consumes it, and the
   `/discovery?asset=` deep-link path stops being a degraded rendering.

## In-scope fixes

| Site | Change |
|---|---|
| `apps/api/migrations/2026-08-XX-*.sql` | `auto_link_suppressed_at` column (idempotent) |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | `auto_link_suppressed_at` → `included` |
| `apps/api/src/db/schema/discovery.ts` | column mirror |
| `apps/api/src/routes/discovery.ts` | unlink: drop manual-only 403, set suppression; manual link clears it; `linkedDeviceId` filter on the asset list route |
| `apps/api/src/jobs/discoveryWorker.ts` | auto-linker skips suppressed assets |
| `apps/web/src/components/discovery/AssetDetailModal.tsx` | remove the Link section; read-only "Same device as {name}" line |
| `apps/web/src/components/discovery/DiscoveredAssetList.tsx` | labeled "Same device as {name}" badge; stop passing the devices prop |
| `apps/web/src/components/devices/NetworkDeviceDetailPage.tsx` | single override surface: provenance label, Unlink for auto-links, suppressed-state line, site-scoped "Link manually…" (`runAction`) |
| `apps/web/src/components/devices/DeviceDetails.tsx` | "Network asset" back-link row |
| `apps/web/src/locales/*/discovery.json` (×7) | `sameDeviceAs`, provenance/suppressed-state, "Link manually…", back-link keys |

## Error handling

- Unlink of an already-unlinked asset → existing 404/no-op semantics unchanged.
- Manual link while suppressed → succeeds and clears suppression (explicit
  human assertion outranks a past unlink).
- Link to cross-site device → server error now surfaces verbatim on the
  override surface (and should no longer be offerable from the scoped picker).
- Worker: suppression check is a plain column filter — no new failure modes;
  cross-site link self-healing (`discoveryWorker.ts:841-862`) is unchanged and
  does NOT set suppression (it isn't a user's "no").

## Testing

- `discoveryWorker.test.ts`: **unlink-then-rescan** — manual unlink, run the
  worker against the same MAC/IP, assert no re-link; then manual link, rescan,
  assert auto-linking resumed for other matches. (Currently zero unlink
  coverage.)
- `discovery.ts` route tests: unlink succeeds for `link_source='auto'`; sets
  `auto_link_suppressed_at`; manual link clears it; `linkedDeviceId` filter
  scopes correctly.
- Export-policy integration suite green with the new column registered.
- Web: modal renders NO link controls (read-only line only, when linked);
  badge renders with label + href; override surface shows provenance, Unlink
  for auto-links, suppressed line, and a site-scoped manual picker;
  DeviceDetails back-link renders for 1 and N assets.

## Build sequence (for the implementation plan)

1. Migration + schema mirror + export-policy registration.
2. API: unlink/suppression semantics; `linkedDeviceId` filter.
3. Worker: suppression skip + the unlink-then-rescan test.
4. Web: modal link-section removal (+ read-only line); badge; override
   surface on the network device page; DeviceDetails back-link.
5. Locales (×7).

## Rollback / risk

- Additive column; every behavior change is a small conditional — each phase
  independently revertible.
- Risk: users who *relied* on auto-relink after unlink (unlikely — unlink is
  currently manual-links-only, so nobody can unlink an auto-link today) —
  mitigated by manual link clearing suppression.
- Reversal of the manual-only unlink rule is called out in A4 for the spec
  reviewer to veto.
