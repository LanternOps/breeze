Closes #10726 (W1 of #10725, spec/plan in #10722)

An alert can now be owned by something other than a device. This wave adds the foundation and every guard; **no producer creates device-less alerts yet** (W3 does).

## Changes
- **Migration `2027-01-17-120000-alerts-owner-kind.sql`**
  - `alerts.device_id` becomes nullable.
  - Adds `owner_kind` (`device` | `topology_site` | `backup_workload`) and `owner_ref`.
  - CHECK `alerts_owner_chk` enforces legal owner combinations.
  - Partial unique index `alerts_open_owner_uidx`: at most one open alert per org-level owner.
  - Backfills `topology_site`; idempotent, system scope.
- **`createSourcedAlert`** accepts `{ deviceId: null, owner: { kind: 'backup_workload', ref } }`.
  - Dedupes atomically through `ON CONFLICT` on the new index.
  - Publishes with a null site and `owner` / `ownerKey` fields.
  - Never enqueues device correlation.
- **G1:** `alert.*` events with no device skip automations **and** flows with reason `alert_has_no_device`. They never fall back to static, org or partner targets.
  - Plan decision, narrower than spec G1: the whole automation is skipped in v1, including notify-only ones. Org-level alerts still reach notification channels through delivery routing.
- **G5:** site-restricted callers fail closed on org-level alerts (approved decision 1). This covers the alert routes, the by-id gate, tickets, mobile, the AI tools and the join-free batch helper. That helper previously admitted every non-topology alert when device IDs weren't pre-resolved.
- **G4:** the notification throttle is keyed by `alertOwnerKey`: `device:<id>`, `topology:<site>:<key>` or `backup_workload:<ref>`. Device keys are unchanged.
- **G3/G7/G8/G11 and the nullable sweep:** all 76 type errors from the nullable `deviceId` are classified:

  | Class | Count | Handling |
  |---|---|---|
  | Rule-only path | 10 | Narrow; throw `alert_has_no_device` if reached |
  | Skippable consumer | 42 | Skip with `alert_has_no_device` (verdict, correlation, RCA, fix memory, monitor conversion history, compliance reconcile) |
  | Display | 24 | Pass `null` through |

  No `!` or `as string` casts.
- **Contract tests:**
  - Every alert insert sets `owner_kind` explicitly.
  - `deviceLessAlertConsumers.integration.test.ts` sends one `backup_workload` alert through every consumer the spec lists.
- **Flows audit (G1):** `flows/eventTrigger.ts` could fan static steps out across the event's org. It now gets the same skip.

## Testing
- **API typecheck:** `tsc --build tsconfig.tests.json` exits 0.
- **Full API unit suite:** 103,428 passed. The 2 failures are `eeBootStopGroup.test.ts`, where `/bin/ps` is not permitted in the sandbox; this is unrelated to this PR.
- **Integration:** the owner, site-scope, RLS and device-less consumer suites pass. All 42 cascade, merge and export contract suites pass locally.
- **Review:** one independent pass found nothing at confidence ≥ 80.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

