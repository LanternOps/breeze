# Fleet Migration / Decommission Report — Design

**Date:** 2026-08-08
**Status:** Ready for review
**Issue:** #3244 (epic #3249)

Filed under `onboarding-signup` alongside the other migration-epic specs.

## Summary

Surface the competing-management-tool detection Breeze already collects as a
**fleet-level report**, so an MSP can answer "which endpoints still run the RMM we
are migrating off, and is it safe to uninstall it there?" without an N+1 loop over
every device.

This is a surfacing feature. The detection already ships and is correct; nothing in
the agent changes.

## Context

- **Detection exists.** `agent/internal/mgmtdetect/signatures.go` fingerprints 11
  competing RMMs by name under `CategoryRMM` — ConnectWise Automate, ScreenConnect,
  Datto RMM, NinjaOne, Atera, SyncroMSP, N-able, Kaseya VSA, Pulseway, Level,
  Tactical RMM — plus `CategoryRemoteAccess` (TeamViewer, AnyDesk, Splashtop,
  LogMeIn, BeyondTrust, GoTo Resolve, RustDesk) and ~50 more across MDM, endpoint
  security, backup, SIEM and VPN.
- **Storage is a jsonb column**, not a table: `devices.management_posture`
  (`db/schema/devices.ts:100`). Ingest schema at
  `routes/agents/schemas.ts:393` (`managementPostureIngestSchema`):

  ```
  { collectedAt, scanDurationMs,
    categories: { rmm: [{ name, version?, status, serviceName?, details? }], … },
    identity: { joinType, azureAdJoined, domainJoined, … } }
  ```

  `status` is `'active' | 'installed' | 'unknown'`.
- **Only a per-device read exists** — `GET /devices/:id/management-posture`
  (`routes/devices/core.ts`), rendered by
  `apps/web/src/components/devices/DeviceManagementTab.tsx`, one device at a time.
- **The documented workaround** is `apps/docs/.../migration/toolkit.mdx` Recipe 5:
  loop the per-device endpoint across the whole fleet and grep the JSON. That is the
  answer we currently give for the highest-stakes step of a migration.

## Why it matters

Phases 4 and 6 of a migration (verify enrollment, decommission) are where migrations
fail, and the failure is always the same: the incumbent agent is uninstalled on a
machine where Breeze enrollment was never verified, leaving an unmanaged endpoint
that needs a site visit.

The incumbent's own console **cannot** answer this — it cannot see a machine whose
agent is already broken, and those are exactly the machines that strand. Breeze can,
because it reports from an agent that works. That asymmetry is the whole value of
this feature.

## Design Decisions

| Decision | Choice |
|---|---|
| Aggregation | **On-the-fly over the jsonb. No denormalized detections table.** |
| Freshness | **Posture age is a first-class output**, not a footnote. |
| Never-scanned devices | **Counted explicitly**, never dropped by the join. |
| Status handling | `active` and `installed` both count as present; reported separately. |
| Scope | RMM + remote-access categories in v1; the schema is generic so others follow free. |
| Automated uninstall | **Out of scope**, deliberately. |

## 1. Aggregation — on the fly, no new table

The obvious alternative is denormalising detections into
`device_management_detections(device_id, org_id, category, product, status, …)` so
they can be indexed and grouped. **Rejected.**

The jsonb is the source of truth, rewritten by the agent on every posture scan. A
denormalized copy must be kept in step on every ingest, and a missed sync reports a
competing agent as *removed when it is still installed*. For a decommission report
that is precisely the failure that strands endpoints — the report would say "safe to
uninstall" about a machine where it is not. A drifting cache is worse than a slower
query here.

Note this is the opposite call from the link table in
`2026-08-08-bulk-org-site-import-design.md` §0, for a principled reason: there, the
single-valued model caused silent data *corruption*; here, denormalising would cause
silent *staleness*. Both decisions avoid the silent-wrong outcome.

Cost is acceptable at the stated target (10,000+ agents): the per-org report filters
on the indexed `org_id`, and the partner-wide roll-up is an on-demand report, not a
hot path. Revisit only on measurement — and if it comes to it, prefer a materialised
view refreshed from the jsonb over a hand-maintained table, so drift stays impossible.

**Two queries, not one.** The detection roll-up and the coverage denominators cannot
come from the same `GROUP BY`, and conflating them was a real defect in an earlier
draft of this spec — see the warning below.

*(a) Detections — one row per product/status:*

```sql
SELECT d.org_id,
       e.value->>'name'   AS product,
       e.value->>'status' AS status,
       count(DISTINCT d.id) AS device_count,
       count(DISTINCT d.id) FILTER (
         WHERE (d.management_posture->>'collectedAt')::timestamptz > now() - $3::interval
       ) AS fresh_device_count
FROM devices d
CROSS JOIN LATERAL jsonb_array_elements(
  COALESCE(d.management_posture->'categories'->$1, '[]'::jsonb)
) e
WHERE d.deleted_at IS NULL
  AND ($2::uuid IS NULL OR d.org_id = $2)
GROUP BY 1, 2, 3;
```

`count(DISTINCT d.id)`, not `count(*)`: a posture array that lists the same product
twice (two services, two install paths) would otherwise double-count the device.

*(b) Coverage — one row per org, computed without the lateral join:*

```sql
SELECT d.org_id,
       count(*) AS total_devices,
       count(*) FILTER (WHERE d.management_posture IS NULL)        AS never_scanned,
       count(*) FILTER (WHERE d.management_posture IS NOT NULL
         AND (d.management_posture->>'collectedAt')::timestamptz <= now() - $3::interval
       )                                                           AS stale,
       count(*) FILTER (WHERE d.management_posture IS NOT NULL
         AND COALESCE(jsonb_array_length(
               COALESCE(d.management_posture->'categories'->$1, '[]'::jsonb)), 0) = 0
       )                                                           AS scanned_none_detected
FROM devices d
WHERE d.deleted_at IS NULL
  AND ($2::uuid IS NULL OR d.org_id = $2)
GROUP BY 1;
```

<!-- The two-query split is the correction; do not merge these back together. -->

**Why not one query with a `LEFT JOIN LATERAL`.** It is tempting, and it is wrong.
A `LEFT JOIN` does preserve devices with no detections — but it preserves all of them
as the *same* `(product NULL, status NULL)` group, collapsing three distinct
populations that mean completely different things:

| Population | Meaning |
|---|---|
| `management_posture IS NULL` | **Never scanned** — status unknown |
| Scanned, category key absent | Scanned, nothing of that category found |
| Scanned, empty array | Scanned, nothing of that category found |

Only the last two mean "clean". Merging them means a never-scanned device is
output-indistinguishable from a verified-clean one — which is the precise failure this
feature exists to prevent, arrived at from the other direction. The `CROSS JOIN` in (a)
is correct *because* (b) supplies the denominators separately; the danger was never the
join type, it was trying to get both answers from one grouping.

Devices with `management_posture IS NULL` must never be summarised as anything other
than **unknown**. On a migration they are the machines most likely to be a problem.

## 2. Freshness is part of the answer

`collectedAt` must be surfaced everywhere a count is. "0 devices still have Datto RMM"
is only true if the scan is recent; on a device that last checked in 40 days ago it
means nothing.

- Every summary row carries `deviceCount` **and** `freshDeviceCount` within a caller-
  supplied staleness window (default 7 days).
- The response carries an explicit `staleDeviceCount` and `neverScannedCount` per org.
- The UI must not render a bare zero. Zero-with-12-stale is a different fact from
  zero-with-everything-fresh, and only one of them means "safe to uninstall".

## 3. Endpoints

Both on the existing devices surface, `authMiddleware` + org scoping as usual.

- `GET /devices/management-posture/summary`
  Query: `orgId?`, `category?` (default `rmm`), `stalenessDays?` (default 7).
  Returns per-org, per-product, per-status counts plus the stale/never-scanned
  totals. **This is the load-bearing endpoint** — Recipe 5 in the migration toolkit
  collapses from one request per device to one request.
- `GET /devices/management-posture/devices`
  Query: `product`, `category?`, `orgId?`, `status?`, plus standard pagination.
  The drill-down behind a count.

Both are read-only and org-scoped by the caller's access context; a partner-scoped
caller gets their whole estate, an org-scoped caller gets one org.

## 4. Web UI

A fleet page grouping devices by detected product, filterable by organization and
site, with per-org migration progress: enrolled, still carrying a competing RMM,
carrying **both** (the healthy mid-migration state), and Breeze-only.

Two things the UI must do rather than may:

- **Show posture age** next to every count, per §2.
- **Call out orphaned remote-access agents as a security finding, not migration
  housekeeping.** ScreenConnect survives a ConnectWise Automate uninstall; Splashtop
  survives Atera and Syncro uninstalls. `mgmtdetect` fingerprints these independently
  under `CategoryRemoteAccess`. An unattended remote-access agent on a customer
  endpoint that nobody monitors is a standing exposure, and this report is the only
  place it becomes visible.

Export to CSV, so the report can go to the customer as evidence of a completed
migration.

## 5. Testing

- **The never-scanned case is the priority test.** Build a fixture org containing all
  four populations at once — never scanned, scanned-stale, scanned-clean, and
  scanned-with-a-detection — and assert each lands in exactly one bucket with the
  right count. A single-population fixture passes against the collapsed one-query
  form that this spec had to correct, so the mixed fixture *is* the test.
- Assert `never_scanned + stale + fresh-clean + fresh-detected == total_devices` for
  the fixture: the buckets must partition the fleet with nothing double-counted or
  dropped.
- Devices with an empty category array, and with a category absent entirely, both land
  in `scanned_none_detected` — **not** in `never_scanned`.
- A posture array listing the same product twice counts the device once
  (`count(DISTINCT d.id)`).
- `active` vs `installed` counted separately; `unknown` neither dropped nor merged.
- Staleness window boundaries; `freshDeviceCount <= deviceCount` always.
- Org scoping: an org-scoped token sees only its own devices; cross-org counts never
  leak into a partner-scoped roll-up for a partner that does not own the org.
- No new table, so **no RLS/cascade/export registration** — `devices` is already
  registered and `management_posture` is already classified `excludedOpen` (jsonb).
  Adding no column keeps the export-policy suite untouched.

## Deferred

| Item | Why not now |
|---|---|
| Integration with the saved-filter / device-filter DSL, so "has Datto RMM installed" composes with other device filters | More elegant than dedicated endpoints but a bigger surface; the dedicated endpoints unblock the migration story first |
| Materialised view if measurement shows the on-the-fly query is too slow | Premature without numbers; the shape is designed so this is a drop-in change |
| Trend over time ("competing agents removed per week") | Needs posture history, which is not retained — the jsonb is overwritten each scan |
| Other categories (backup, EDR, SIEM) as consolidation reports | The query is generic; this is UI surface, not new mechanism |

## Explicitly not planned

**Automated uninstall of a competing RMM.** Detection informs; the operator decides
and drives removal through their own tooling. There is no competitor-uninstall logic
anywhere in the repo today, and adding remote "uninstall the competitor" capability
is a deliberate product and security decision, not a migration convenience.
