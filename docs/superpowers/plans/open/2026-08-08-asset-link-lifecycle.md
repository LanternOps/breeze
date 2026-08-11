# Asset-Link Lifecycle — hidden-and-automatic linking, durable unlink

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make discovered-asset ↔ managed-device identity linking hidden and automatic: MAC/IP auto-link does the work, manual unlink sticks (suppression), the asset modal loses its link controls, and the network device page becomes the single quiet override surface. Closes #3261.

**Architecture:** One new column (`auto_link_suppressed_at` on `discovered_assets`), small conditionals in the unlink route and discovery worker, web display/control moves. Invariant (spec §Goals): the link drives display + alert attribution ONLY — never proxy routing or any security decision (MAC/IP matching is on-LAN spoofable; privilege-free linking is what makes hidden-and-automatic safe).

**Tech Stack:** Hono, Drizzle + SQL migration, Vitest, React islands, i18n ×7.

**Spec reference:** `docs/superpowers/specs/monitoring/2026-08-08-asset-link-lifecycle-design.md` (approved 2026-08-08). Note §A4: this deliberately reverses the 2026-06-27 manual-only-unlink rule — rationale in the spec.

**Out of scope:** Devices-list absence semantics, inline link/unlink from the list, `PUBLIC_ENABLE_NETWORK_DEVICES_IN_LIST` flip (#1424); proxy surfaces (#3199); auto-link matcher changes; unique constraint on `linked_device_id`.

**Coordination note:** `AssetDetailModal.tsx` is also edited by `2026-08-08-proxy-access-consolidation.md` (Task 6) — land that first.

---

## Task 1 — Migration + schema + export policy

- [ ] `apps/api/migrations/2026-08-XX-asset-link-suppression.sql` (idempotent, no inner BEGIN): `ALTER TABLE discovered_assets ADD COLUMN IF NOT EXISTS auto_link_suppressed_at timestamptz`
- [ ] Mirror in `apps/api/src/db/schema/discovery.ts`
- [ ] Register `auto_link_suppressed_at` → `included` in `CORE_TENANT_EXPORT_POLICY` (`tenantExportPolicyRegistry.ts`) — org-cascade table; the export-policy suite only runs in the Integration Tests job, so a missed registration is a green-PR/red-main failure
- [ ] `pnpm db:migrate && pnpm db:check-drift`

## Task 2 — API: unlink/suppression semantics (`routes/discovery.ts`)

- [ ] `DELETE /discovery/assets/:id/link`: drop the manual-only 403 (`:1533-1535`) — auto links unlink too; clear `linked_device_id`/`link_source`; set `auto_link_suppressed_at = now()`; approval status untouched (2026-06-27 decision stands)
- [ ] `POST /discovery/assets/:id/link` (manual link): clear `auto_link_suppressed_at` (explicit human assertion outranks a past unlink)
- [ ] Asset list route: add `linkedDeviceId` filter param (org-scoped as today) for the DeviceDetails back-link
- [ ] Tests: unlink succeeds for `link_source='auto'`; sets suppression; manual link clears it; filter scoping

## Task 3 — Worker: suppression skip (`jobs/discoveryWorker.ts`)

- [ ] Auto-linker (`:875-922`): skip assets where `auto_link_suppressed_at IS NOT NULL`; cross-site self-healing (`:841-862`) must NOT set suppression (it isn't a user's "no")
- [ ] **The unlink-then-rescan test** (`discoveryWorker.test.ts` — currently zero unlink coverage): manual unlink → rescan same MAC/IP → assert no re-link; manual link → rescan → auto-linking resumed

## Task 4 — Web: hidden controls, visible state, one override surface

- [ ] `AssetDetailModal.tsx`: remove the "Link to managed device" section (`:552-605`) entirely; add read-only "Same device as {name}" line (links to `/devices/<linkedDeviceId>`) when linked
- [ ] `DiscoveredAssetList.tsx`: replace the bare green check + name (`:508-513`) with the labeled `sameDeviceAs` badge ("Same device as {name}", links to the device); stop passing the `devices` prop (both modal pickers are gone after #3199)
- [ ] `NetworkDeviceDetailPage.tsx` — single override surface: provenance in the label ("— auto-detected" / "— set manually"), Unlink for both provenances, suppressed-state line ("Auto-linking disabled — unlinked by a user"), "Link manually…" action with a site-scoped picker (`GET /devices?siteId=…` — API requires same-org AND same-site, `discovery.ts:1458-1464`), errors via `extractApiError`, mutations via `runAction`
- [ ] `DeviceDetails.tsx`: "Network asset" back-link row (list when N>1) via the `linkedDeviceId` filter
- [ ] Tests: modal has NO link controls (read-only line only, when linked); badge label + href; override surface provenance/unlink/suppressed/picker; back-link 1 and N

## Task 5 — Locales + verification

- [ ] All 7 locales `discovery.json`: `sameDeviceAs`, provenance labels, suppressed-state, "Link manually…", back-link keys; retire the removed link-section keys
- [ ] Full API + web suites AND the contract suites (`vitest.config.rls.ts`, `vitest.integration.config.ts`) — export-policy registration is only exercised there
- [ ] Quick UI pass: unlink an auto-linked asset, run a scan, confirm it stays unlinked and the suppressed line shows; manual link clears it
