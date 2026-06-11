# Site-scope baseline triage (the 93 input-sourced offenders)

**Status:** ✅ COMPLETE — baseline fully burned down (0 entries). All 93 resolved: **52 fixed**, **41 vetted-exempt**.

**Progress:**
- ✅ **Batch 1 (PR #1041, `fix/site-scope-mutations`):** all 8 high-severity MUTATIONS fixed (TDD); 24 EXEMPT-AGENT + 10 EXEMPT-FALSE-POSITIVE moved to `SITE_SCOPE_INPUT_EXEMPT`. Baseline: 93 → 51.
- ✅ **Batch 2 wave 1 (PR #1042, `fix/site-scope-reads`, Codex gpt-5.5, reviewed):** 18 READ gaps — backup (8), mobile (3), monitoring (3), reports (4). Baseline: 51 → 33.
- ✅ **Batch 2 wave 2 (PR #1042, Codex gpt-5.5, reviewed):** 26 READ gaps — software (3), remote-lists (3), groups (3), and misc (17: alerts, changes, cisHardening×2, deployments, networkChanges, patches/compliance, playbooks×2, policyManagement/compliance, psa×2, snmp, discovery `/assets`, networkBaselines `/`, tunnels, auditLogs). Baseline: 33 → 7.
- ✅ **Aggregates vetted:** the 7 EXEMPT-AGGREGATE handlers re-verified as counts/summaries-only (no per-device rows) and moved to `SITE_SCOPE_INPUT_EXEMPT`. Baseline: 7 → **0**.

**`SITE_SCOPE_INPUT_EXEMPT` now holds 41 entries** (24 agent + 10 false-positive + 7 aggregate). The input-sourced detector now gates all new code with no remaining debt.

**Noted follow-up (not a gap):** the 7 aggregate endpoints return org-wide totals that still span sites a restricted user can't see — counts only, no per-device disclosure. If product wants the aggregates themselves site-scoped, that's a separate, lower-priority change.
**Date:** 2026-05-31
**Source:** Codex `gpt-5.5`, `model_reasoning_effort=high`, read-only, over the worktree at this branch.
**Validation:** Claude spot-checked a sample (5/5 correct): the agent-auth mount
(`routes/agents/index.ts:41`), two REAL-GAP device joins (remote/sessions `GET /sessions`,
softwareInventory `GET /:name/devices`), one EXEMPT-AGGREGATE (metrics `GET /` returns counts),
and one EXEMPT-FALSE-POSITIVE (remote `getDeviceWithOrgCheck` site gate). Treat EXEMPT-AGGREGATE
as the softest call — re-confirm "counts only, no per-device rows" when burning each down.

## Summary

| Category | Count | Meaning |
|---|---:|---|
| REAL-GAP | 52 | user-facing, device data filtered org-only — a site-restricted user reaches cross-site data. FIX. |
| EXEMPT-AGENT | 24 | agent/helper/viewer token path, no user `permissions` context. Move to `SITE_SCOPE_INPUT_EXEMPT`. |
| EXEMPT-AGGREGATE | 7 | returns only org-wide counts/distributions, no device rows. Move to exempt after re-confirm. |
| EXEMPT-FALSE-POSITIVE | 10 | not the bug class (platform-admin, portal/mobile non-RMM, or a gate the scanner missed). |
| **Total** | **93** | matches `SITE_SCOPE_INPUT_BASELINE`. |

The full per-route report (with Codex's one-line justification for every entry) is the source of
record; the actionable REAL-GAP set is reproduced below.

## REAL-GAP (52) — fix by narrowing to the caller's accessible devices

Pattern: when `permissions.allowedSiteIds` is set, resolve allowed device IDs (org devices whose
`siteId` passes `canAccessSite`) and either 403 an explicit out-of-scope `deviceId`/`siteId` or
add `inArray(<table>.deviceId, allowedDeviceIds)` (`or(isNull(...), inArray(...))` for nullable
columns). Mirror `resolveSiteAllowedDeviceIds` from browserSecurity/software.

### High severity — MUTATIONS (fix first)
- `routes/devices/provision.ts:POST /provision` (L183) — require `canAccessSite(perms, data.siteId)` before insert.
- `routes/discovery.ts:POST /assets/:id/link` (L1026) — gate `existing.siteId` and `targetDevice.siteId`.
- `routes/discovery.ts:DELETE /assets/:id` (L1152) — gate `discoveredAssets.siteId` before delete cascade.
- `routes/networkBaselines.ts:POST /` (L204) — require `canAccessSite` for `body.siteId`.
- `routes/remote/sessions.ts:DELETE /sessions/stale` (L85) — **conditional gate**: site-gated only when `deviceId` given; when omitted it cleans all org sessions. Narrow the no-deviceId path to allowed sites.
- `routes/remote/sessions.ts:POST /sessions/:id/offer` (L701) — `getSessionWithOrgCheck` lacks site gate; check `result.device.siteId`.
- `routes/scripts.ts:POST /executions/:id/cancel` (L987) — `canAccessDeviceSite` before cancel.
- `routes/softwarePolicies.ts:POST /:id/remediate` (L623) — narrow explicit + implicit target devices by site.

### High severity — READS
- `routes/alerts/alerts.ts:GET /` (L96)
- `routes/backup/jobs.ts:GET /jobs` (L88), `GET /jobs/:id` (L118)
- `routes/backup/restore.ts:GET /restore` (L109)
- `routes/backup/snapshots.ts:GET /snapshots` (L214)
- `routes/backup/vault.ts:GET /` (L48)
- `routes/changes.ts:GET /` (L129)
- `routes/cisHardening.ts:GET /compliance` (L469), `GET /remediations` (L955)
- `routes/deployments.ts:GET /:id/devices` (L769)
- `routes/groups.ts:GET /:id/devices` (L596)
- `routes/mobile.ts:GET /alerts/inbox` (L581), `GET /devices` (L846), `GET /search` (L1226)
- `routes/monitoring.ts:GET /assets` (L194), `GET /assets/:id` (L285), `GET /results` (L762)
- `routes/networkChanges.ts:GET /` (L149)
- `routes/patches/compliance.ts:GET /compliance` (L155)
- `routes/playbooks.ts:GET /executions` (L145), `GET /executions/:id` (L183)
- `routes/policyManagement/compliance.ts:GET /:id/compliance` (L519)
- `routes/remote/sessions.ts:GET /sessions` (L308), `GET /sessions/history` (L441)
- `routes/remote/transfers.ts:GET /transfers` (L225)
- `routes/reports/data.ts:GET /data/device-inventory` (L60), `GET /data/software-inventory` (L140), `GET /data/metrics` (L473)
- `routes/reports/generate.ts:POST /generate` (L120)
- `routes/snmp.ts:GET /dashboard` (L680)
- `routes/softwareInventory.ts:GET /:name/devices` (L536)
- `routes/softwarePolicies.ts:GET /violations` (L352)

### Medium / low severity — READS
- `routes/auditLogs.ts:GET /logs/:id` (L588)
- `routes/backup/bmr.ts:GET /bmr/tokens` (L363)
- `routes/backup/dashboard.ts:GET /dashboard` (L171)
- `routes/backup/sla.ts:GET /events` (L232)
- `routes/discovery.ts:GET /assets` (L836)
- `routes/groups.ts:GET /` (L245), `GET /:id/membership-log` (L1014)
- `routes/networkBaselines.ts:GET /` (L166)
- `routes/psa.ts:GET /connections/:id/tickets` (L742), `GET /tickets` (L688)
- `routes/softwareInventory.ts:GET /` (L235)
- `routes/tunnels.ts:GET /allowlist` (L342) — low; only if allowlist rows are site-specific.

## EXEMPT-AGENT (24) — agent/helper/viewer token paths, no user permissions

`routes/agents/*` (boot-performance, changes, commands, connections, elevation-requests, enroll,
inventory ×5, patches, sessions, state ×2 = 16) — mounted under `agentAuthMiddleware`
(`routes/agents/index.ts:41`). `routes/desktopWs.ts:POST /connect/exchange` — connect-code
exchange, system DB context. `routes/helper/index.ts` chat endpoints (×5) — `helperAuth` `brz_`
token, session bound to helper device. `routes/tunnels.ts` `GET /desktop-access`,
`POST /upgrade-to-webrtc`, `POST /downgrade-to-vnc` — viewer-JWT path (`requireViewerToken`).

## EXEMPT-AGGREGATE (7) — counts only, re-confirm before exempting

`routes/huntress.ts:GET /status`, `routes/metrics.ts:GET /` + `GET /trends`,
`routes/reports/data.ts:GET /data/compliance`, `routes/sentinelOne.ts:GET /status`,
`routes/softwarePolicies.ts:GET /compliance/overview`, `routes/updateRings.ts:GET /:id/compliance`.

## EXEMPT-FALSE-POSITIVE (10)

- Not RMM-device / not user-permissions context: `routes/admin/abuse.ts` (platform admin),
  `routes/lifecycle.ts` mobile-device endpoints (×2), `routes/mobile.ts:POST /devices` +
  `POST /notifications/register` (mobile client rows), `routes/portal/assets.ts` (×3, portal session auth).
- **Scanner miss (genuinely gated via cross-file helper):** `routes/remote/sessions.ts:POST /sessions`
  and `routes/remote/transfers.ts:POST /transfers` use `getDeviceWithOrgCheck(..., permissions)`
  (`routes/remote/helpers.ts:132`), which 403s on `SITE_ACCESS_DENIED`. The scanner's
  local-helper resolution is same-file only, so these read as offenders. They stay in the baseline
  as known false positives; a future import-aware resolver could clear them precisely. (Do NOT add
  `getDeviceWithOrgCheck` as a blanket gate token — it would mask `DELETE /sessions/stale`, which
  gates only its deviceId path.)

## Recommended fix order
1. High-severity mutations (8): provision, discovery link/delete, network-baseline create, stale-session cleanup, remote offer, script cancel, software remediation.
2. Broad read surfaces: mobile, reports, backup, monitoring, software inventory, compliance detail.
3. Secondary: groups, playbooks, PSA, audit-log detail, SNMP dashboard, tunnel allowlist.
4. Each fix ships with `allowedSiteIds` regression tests (out-of-scope `deviceId`/`siteId` → 403; unfiltered list narrowed), and removes its entry from `SITE_SCOPE_INPUT_BASELINE`. Move confirmed EXEMPT-* entries to `SITE_SCOPE_INPUT_EXEMPT` with the justification above.
