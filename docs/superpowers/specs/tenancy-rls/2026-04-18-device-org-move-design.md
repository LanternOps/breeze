# Device Org Move — Design Spec

- **Created:** 2026-04-18
- **Status:** Proposed, not yet implemented
- **Related ships:** `ChangeSiteModal` (intra-org site move) landed on 2026-04-18 in feature/vnc-desktop-fallback-deeplink

## Problem

Today a device belongs to exactly one `(orgId, siteId)`. Site can be changed via
`PATCH /devices/:id { siteId }`. Changing `orgId` is not supported. Customers
ask for it when:

- An MSP restructures a customer into multiple tenants.
- A device was enrolled under the wrong organization (mistake during rollout).
- Internal IT moves hardware between business units that are modeled as separate orgs.

Today the only workaround is decommission + re-enroll, which:

- Loses all history (alerts, metrics, patch status, script runs, eventlog) because the new device gets a new UUID.
- Requires physical/remote action on the machine (agent config rewrite or MSI reinstall).
- Triggers new-device policies/automations and spurious alert noise.

## Why this is hard

`org_id` is a primary tenant-isolation key in RLS. Per `CLAUDE.md` the six
tenancy shapes include **Shape 5 (device-id scoped)** where hot agent-write
tables denormalize `org_id` on the row itself. A grep across `apps/api/src/db/schema/`
shows ~60 tables referencing `org_id` or `orgId`. At minimum the following
device-scoped tables need their `org_id` rewritten when a device moves:

- Metrics / performance: `device_metrics`, `device_boot_metrics`, `device_performance`
- Alerts / events: `alerts`, `device_events`, `eventlogs`
- Patches: `device_patches`, `patch_job_results`, `patch_rollbacks`
- Inventory: `device_hardware`, `device_software`, `device_peripherals`, `device_filesystem`
- Sessions / remote: `remote_sessions`, `device_sessions`
- Security: `device_security`, `incident_responses`, `browser_security`
- Changes / audit: `device_changes`, `audit_logs` (device-scoped rows)
- Groups / policies: `device_group_members`, `device_config_policy_links`
- Scripts / automations: `script_runs`, `automation_runs`
- Backup: `backup_verifications`, `backup_policies` (device-scoped rows)
- Diagnostic logs, agent logs, IP history, warranty, etc.

Beyond data: **device groups are scoped to an org**. A device moving to a new
org drops out of all its old groups. Configuration policy links do the same.
This is a feature, not a bug — the new tenant shouldn't inherit the old
tenant's groupings — but it means the move is not "lossless."

## Options

### Option A — Decommission + re-enroll (status quo, explicit flow)

Ship a UI affordance that walks the user through:

1. Generate a re-enroll token for the target org/site.
2. Push a command to the agent to re-enroll against that token.
3. Agent re-enrolls: new device row in the target org, old device row soft-deleted.

**Pros:** No schema changes, no RLS gymnastics, matches existing agent enroll lifecycle.

**Cons:** History does not follow the device. For fleets using alerts/metrics
for trending this is a regression. The new device gets a new UUID, breaking
any external integrations keyed on device ID (PSA, billing, reports).

### Option B — In-place `org_id` rewrite (transactional migration)

Add `POST /devices/:id/move` (system+partner scope) that, in a single
transaction:

1. Verifies caller has write on source org AND target org.
2. Verifies target site belongs to target org.
3. Drops the device out of source-org groups/policies.
4. Rewrites `org_id` on `devices` + every denormalized child table.
5. Writes audit rows on both source and target orgs.

**Pros:** History stays with the device. Device UUID unchanged. No agent
interaction needed (agent doesn't know/care which org it reports to; the
orgId lives on the server side).

**Cons:**

- Large transaction across many tables. High lock contention risk on busy
  fleets. Needs careful batching or a background worker.
- RLS: the transaction must run under `withSystemDbAccessContext` because
  the caller can't have access to rows in both orgs simultaneously under
  normal policy. Must be tightly scoped to the device's row set.
- Missing an emergent table that denormalizes `org_id` = split-brain tenant
  data. Needs a registry of "tables that track device org_id" with CI coverage.
- Group/policy links in source org should be dropped, not moved. Need
  explicit handling per table (move vs. drop vs. copy).

### Option C — System-scope-only admin escape hatch

Same as B but exposed only to system scope, not partner. Support staff run
it on customer request. Gates the risk behind a small blast radius.

**Pros:** Lets us ship the capability with minimum product surface; iterate
before opening to partners.

**Cons:** Doesn't solve self-service for MSPs.

## Recommendation

Start with **Option C** (system-scope only) as Phase 1, evolve to **Option B**
(partner-facing UI) once the registry of denormalized tables is battle-tested.
**Option A** is a user-facing UX alternative worth offering alongside — for
customers who don't care about history, re-enroll is simpler and safer.

## Open questions

1. **History retention policy** — Do `audit_logs` entries from the old org
   follow the device (potentially surfacing the old tenant's data to the new
   tenant via device history)? Likely answer: no, old audit stays with the
   old org; device audit starts fresh in the new org.

2. **Cross-partner moves** — Is moving between partners (not just between
   orgs under the same partner) in scope? If yes, the `requireScope('partner')`
   check needs tightening: both partners' admins must consent, or it becomes
   a system-scope-only operation.

3. **Agent side** — The agent has no orgId, only an agentId + auth token. So
   no agent-side change is needed for B/C, but for A (re-enroll) the agent
   needs a "re-enroll against new token" command. That command exists today
   for token rotation but not for org change — would need extension.

4. **In-flight commands** — If a device is executing a script or has a queued
   patch install when the move happens, what happens to the command? Simplest
   answer: block move until queue drains; complex answer: move the commands
   with the device.

5. **Registry for denormalized `org_id` tables** — Similar to
   `ORG_ID_KEYED_TENANT_TABLES` in `rls-coverage.integration.test.ts`, we
   should add a `DEVICE_ORG_ID_DENORMALIZED_TABLES` list and a CI contract test
   that fails if a new device-scoped table with `org_id` is introduced without
   being added to the list.

## Estimate

- **Option C (MVP, system-scope):** 2-3 days. Build `POST /devices/:id/move`,
  write the denormalized-tables registry, unit + integration tests, no UI.
- **Option B (partner-facing UI):** +2 days on top of C. Adds a
  `ChangeOrgModal` in `DeviceActions`, target-org picker with permission check,
  user-facing audit copy, progress feedback for larger fleets.
- **Option A (re-enroll UX):** 1 day to add a "Move to different org"
  affordance that's really a guided decommission + re-enroll.

## Sequencing

Ship A as a short-term escape hatch (low effort, useful today) while scoping
C for the next milestone. B waits on C's registry and CI test to be proven
before we expose it to partners.
