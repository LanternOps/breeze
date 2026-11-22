---
title: Device-own settings (change one feature for one device, from the device page)
status: draft
date: 2026-11-21
origin: "#6670; wave W4 of the configuration policies UX reshape"
related_issues: [6670, 12293, 9565, 9408, 10712]
companion_spec: 2026-11-21-config-policy-ux-reshape-spec.md
---

# Device-own settings

## Problem

A tech often needs one setting on one machine: a different patch window for a server, an extra
monitor on the front-desk PC. Today that takes a named policy, a feature link, and a device-level
assignment made from an org-owned policy's Assignments tab through a picker capped at 200
devices. The one-off then sits in the Config Policies list beside fleet policies, and the device
page offers no way to start or to see "what is set specifically here" (#6670).

## Users & scope (partner vs org)

- **Partner tech** on a device page: changes a feature for that device without leaving it.
- **Org-scope admin** with access to the device: the same. Own settings belong to the device's
  organization, exactly as an org-owned policy assigned at device level does today.
- A device belongs to one organization, so own settings are always org-owned. This is the stated
  exception to partner-wide-first (#2135): there is no "all organizations" form of one device.

## Proposed design

### What the tech sees

On the device Config tab, each feature card gains **Change for this device**. It opens the same
feature form the policy editor uses, pre-filled with the effective values and their source.
After Save the card reads **Set on this device**, with **Reset to inherited** and a preview of
what the device falls back to. A feature the device does not get at all offers **Set for this
device**. The source is never shown as a policy name or a policy link.

A second, separate action covers the other job: **Apply a policy to this device** adds an
ordinary device-level assignment of an existing policy. Where the device's own setting outranks a
feature of an applied policy, the card says so.

The device list gains a badge and a filter for devices with their own settings. The Config
Policies list shows only a count that links to that filter.

### Rules

- Own settings win over every policy for that feature on that device, including another policy
  assigned directly to the device. Other features keep resolving as before.
- Whole-feature replace, as everywhere else, with one exception: **monitors accumulate** in the
  resolver today (closest attachment wins per monitor), so on a device the action is "add or
  adjust a monitor", not "replace the set" (Decision 2).
- An explicit empty setting ("no automations on this device") is a real override and must hold.
- Reset needs the same permission as removing that feature from a policy, because the fallback
  can switch on behaviour the caller could not have configured.

### Storage: quorum result

**Result: A, agreed by both advisors on current main.** The first round ran on a tree 2,175
commits old and split (Codex C, this spec A). It was re-run at `46f3a89d01` with the readers
measured. Both now choose A, with the release gates listed below.

Options considered: (A) a `configuration_policies` row flagged as device-owned plus one real
device-level assignment; (B) a separate overrides table; (C) the flagged row with no assignment,
its target derived at read time through a new targets view.

- **B is rejected by both advisors.** Runtime reads typed rows keyed by the feature link
  (14 normalized tables key off `feature_link_id`), and execution authority is stamped on the
  link. A second representation would let the device page show one thing while the agent runs
  another.
- **Agreed by both:** the flagged row, org-owned, reusing real feature links; dedicated device
  routes; one catalog definition that hides these rows from every lister; a real-database parity
  fixture as the acceptance gate.
- **First round (October tree).** Codex recommended C: an assignment row is independently
  mutable, same-level ties are broken by priority and age rather than by kind, and device
  delete re-validates surviving assignments. This spec chose A because C must change every
  reader that starts from assignments, and a missed reverse lookup silently drops a job while
  the device page looks correct.
- **Second round (main; readers measured by Codex, each function read).**
  - 11 files choose a device's winning policy with their own assignment query: 32 independent
    queries, 16 of them in `featureConfigResolver.ts`.
  - `devicePolicySet.ts` (#8142) is one shared read for 12 heartbeat feature types, but every
    resolver on it still ranks in its own code and keeps a live fallback query.
  - 6 files find or count a policy's devices with their own query (11 queries). The shared
    expansion in `configPolicyAssignmentDevices.ts` (#8442) expands a target it is handed; the
    patch scheduler and both ring counts still discover targets themselves, and the scheduler
    skips a policy whose discovery returns nothing.
  - On those numbers both advisors choose A. One real row is seen by all 43 queries from the
    first day. C must migrate each of them, and a miss fails silently.
- **How A answers C's objections:**
  - The assignment is not user-mutable. A device-owned policy has exactly one assignment (level
    `device`, target = its owning device, no role or OS filter), enforced in the assignment
    integrity guards; every other insert, update or delete on it is rejected.
  - Precedence over an ordinary device-level assignment comes from a reserved priority below the
    ordinary range. Every device-winner comparator on main lets the lower number win except
    warranty (`warrantyInlineFromRows`, higher wins, on both of its paths). Warranty keeps its
    rule among ordinary policies and gains one owned-first check ahead of it. No other reader
    changes.
  - The reservation is enforced in the database, not in the HTTP validator. The column is a
    plain integer with no range check, and the AI tool passes a priority straight to
    `assignPolicy`. Audit existing values, then add the range check for ordinary rows.
  - Device delete removes device-level assignments before the device row (the #12293 fix, needed
    regardless).
- **Switch criteria.** Wave D2 builds the parity fixture before any UI, as an extension of
  the #8142 parity suite: two devices, a partner
  parent policy, an ordinary filtered device-level assignment, one own feature. It must show the
  same winner in the effective-config API, the agent heartbeat payload and the worker path, the
  sibling feature and the second device falling through, an explicit empty override holding, and
  reset restoring the fallback. It must also show an org merge and a permanent delete succeeding
  with own settings present, and the device not being scheduled a second time under the policy
  that lost. If A cannot pass it, move to C. The row shape is identical, so
  the switch changes readers, not data.
- **Release gates for A** (from the second round):
  - A database-owned transition that carries the protected assignment through an org merge
    and validates the final owner and target together. Today a merge is expected to fail when
    the losing organization owns both a policy and a device that policy is assigned to (see
    "Device lifecycle").
  - Tests for direct insert, retarget, filter change and delete of the protected row,
    concurrent writes, single and bulk permanent delete, and merge with ordinary and protected
    device-level assignments.
  - An explicit empty automation or compliance setting must win. Today both resolvers
    inner-join the child rows before choosing a winner, so an empty link vanishes and a
    broader policy wins. Choose the winning link first, then return its children. This is a
    defect today for any policy, under either storage option.
  - Backup legal holds and immutability are combined across every applicable policy, not
    taken from one winner. A device's own backup setting must not weaken them.
- **Switch to C** if A cannot pass the merge, delete and concurrent-write tests, or once
  forward and reverse discovery both run through one mechanically enforced target source. At
  that point the reason to keep a physical row is gone.
- **Longer term.** Readers each rebuild the same ranking (eight copies of the level table on
  main, mixed tiebreaks). One shared "targets for this device, ranked" definition is the right
  end state and would make own-first structural. `devicePolicySet.ts` is the first half of it
  (one read, ranking still per reader). A does not block it.

### Data model contract (A)

- `configuration_policies.owner_device_id uuid NULL`, immutable after insert (including
  `NULL → value`), `UNIQUE … WHERE owner_device_id IS NOT NULL`.
- `CHECK (owner_device_id IS NULL OR (org_id IS NOT NULL AND partner_id IS NULL AND
  parent_policy_id IS NULL AND status = 'active'))`. Fixed internal name; never displayed.
- `FOREIGN KEY (owner_device_id, org_id) REFERENCES devices (id, org_id) ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE`. The cascade is the backstop; the delete path removes the row
  explicitly.
- A device-owned row can never be a parent, never be referenced as a whole-policy
  `featurePolicyId`, and never take any assignment other than its own. Enforced in the database
  guards (parent guard, feature-reference guard, assignment integrity) and mirrored in the API.
- The existing unique `(config_policy_id, feature_type)` gives one own setting per feature.
- The row is created on the first own setting and kept until the device is deleted, so history
  rows that carry a policy id (alerts, automation runs, patch jobs) keep their reference when the
  last feature is reset. "Has own settings" means it has at least one feature link.

### Leak contract

Device-owned rows must never surface where policies are listed, counted, picked or opened.

- One catalog definition (`owner_device_id IS NULL`) applied before count, pagination or lookup
  by id. Generic `/configuration-policies/:id` routes return the ordinary not-found result for a
  device-owned id.
- Known call sites to move onto it: `listConfigPolicies` and its count, eligible parents,
  create-with-parent, assignment routes and preview, target listing, the Site and Device Groups
  pickers, AI tools (list, manage, duplicate-name checks, compliance summary), the partner API
  policy and assignment sources, compliance stat counts, group policy names, monitor attachment
  backlinks and counts, backup profile backlinks, fleet-design evidence and preview, generated
  policy lookups.
- Enforcement is mechanical: a contract test in the style of
  `featureLinkReaders.contract.test.ts` fails any read of `configuration_policies`, Drizzle or
  raw SQL, outside a named allowlist (storage, integrity, export, lifecycle, the device
  configuration service, resolvers). The list above is a starting point, not the proof.
- Reference-integrity checks still see own links. Deleting an update ring that a device's own
  setting uses is blocked, and the message names the device, not a hidden policy.

### API

- `GET /devices/:id/configuration` returns, per feature, the effective value, its source
  (`sourceKind: 'device_own'` when own) and the fallback, computed by resolving the same snapshot
  with the device's own link for that feature excluded.
- `PUT` and `DELETE /devices/:id/configuration/:featureType` set and reset one feature. They
  check device access including the caller's site ceiling, create the row lazily, and reuse the
  feature-link service unchanged: validation, normalized writes, step-up, execution-authority
  stamping, audit, delivery-cache invalidation.
- "Apply a policy to this device" uses the existing assignment create with `level: 'device'`.
- Later: an AI tool `configure_device {deviceId, featureType, settings}` over the same service.

### Device lifecycle

| Event | Behaviour |
|---|---|
| Decommission (soft delete) and restore | Own settings are kept, so a restored device comes back as it was (Decision 3). |
| Permanent delete, single and bulk | Delete device-level assignments for the device, then the device-owned row, then the device. Without the first step the delete fails today with a 409 (#12293). |
| Site move within the org | Nothing stored changes; the fallback is recomputed. Site-bound execution authority is re-checked at dispatch, as today. |
| Org move | Own settings are removed, and the move confirmation lists the affected features (Decision 1). Today a device with any device-level assignment of its own organization's policy cannot change organization: the database refuses the update (an integration test pins this), and the move service has no step that clears such assignments. Reproduce through the service in D0. |
| Org merge | **A's main exposure. Expected to fail today (inferred from the trigger and merge code, not yet reproduced).** The assignment re-check on a device or policy org change is an immediate statement trigger, and the validator has no merge exemption (newest definition: `2027-01-12-200200-config-assignment-partner-device-group-targets.sql`, re-read on main). The merge itself repoints organization-level assignments only (`orgMerge.ts`). A device-level assignment of an org-owned policy may therefore block a merge today. Under A every device with own settings carries one; under C none does. Reproduce in D0; it is one of the switch criteria. |
| Org cascade delete | Already covered: the table is registered and sorts before `devices`. |

### Features offered

"Change for this device" is offered only for a feature whose every reader honours a device-level
assignment and whose delivery follows the resolved winner. Each offered feature needs a row in
the parity fixture.

- **Expected to qualify:** patches, maintenance, event logs (collection settings), automations,
  compliance, software policy, data discovery, warranty (after the sort fix), Breeze Assist,
  remote access, privileged access, vulnerability scanning, hardware monitoring, time sync,
  security, backup, OneDrive Helper.
- **Different shape:** monitors (additive). Software policy joins them if open PR #11295
  (#10712, several software policies per device) merges.
- **Undecided, added to main since the draft:** workload inventory, system protection,
  security agents, containment, vendor updates, Wake-on-LAN. Each needs its readers checked.
- **Not offered:** device lifecycle and event-log retention, whose readers consider only
  organization and partner levels; peripheral control, until its delivery is confirmed to follow
  the resolved winner (#9722 moved it onto config-policy assignment; re-check, it may qualify).

## Tenancy & data model impact

- One new nullable column and one composite FK on `configuration_policies`; no new table, so no
  new cascade or merge registration. The column needs a `CORE_TENANT_EXPORT_POLICY`
  classification (`included`).
- RLS policies are unchanged: the row is org-owned and falls under the existing org isolation.
- The owner-immutability trigger already rejects `org_id` changes outside system scope; that
  cost is why own settings are removed on an org move and not carried (Decision 1).
- The composite FK follows the repo rule (`DEFERRABLE INITIALLY IMMEDIATE`). It is a new FK
  into `devices`, so it falls under the erasure FK ledger
  (`orgCascadeFkOnDelete.integration.test.ts`); the explicit `ON DELETE CASCADE` is what keeps it
  out of the allowlist. This table tripped that ledger once already (#5123).
- `owner_device_id` is not named `device_id`, so the device-list contract tests do not pick the
  table up. That is intended (the generic device movers assume a whole-table device shape), and
  explicit delete, purge and move tests replace them.
- Rigor is high for D1 and D2: migration, guard triggers, agent-delivered configuration.

## Out of scope

- "Promote to a reusable policy".
- Editing a shared linked entity from the device page; the device form selects among entities
  the caller may use and edits the feature's own fields.
- The shared ranking definition for all readers.
- Tenant export of feature links, which carries no policy's links today.

## Waves

| Wave | Scope | Depends on |
|---|---|---|
| D0 | #12293 (device delete removes device-level assignments). Fix the empty automation and compliance override. Audit existing assignment priorities ahead of the database range check. Contract test pinning priority direction. Reproduce org move and org merge with a device-level assignment of an org-owned policy. Independent of everything else. | none |
| D1 | Column, constraints, guards; catalog definition; lister sweep; leak contract test | D0 |
| D2 | Device configuration service and routes; source kind and fallback in resolution; parity fixture (acceptance gate, switch criteria above) | D1 |
| D3 | Device Config tab actions, device list badge and filter, "Apply a policy to this device" | D2, reshape W1 |
| D4 | AI tool `configure_device` | D2 |

## Decisions (Todd, 2026-11-21)

The four product calls, as decided. The spec stays `draft` until it is approved as a whole.

1. **Org move: own settings are removed.** The move confirmation lists the affected features.
   The engine already does this for device-group memberships. Own settings are not carried or
   remapped: that means re-owning the row in system scope and re-validating every linked
   reference (rings, backup destinations, OneDrive libraries) against the destination, and
   some cannot be valid there.
2. **Monitors on one device are additive.** This matches the resolver and the "alert me if
   DYMO disappears from this PC" case.
   - Overlap with #9408 (plan drafted, no PR): that plan gives a monitor's "Deploy to…" a
     device target by minting one configuration policy per monitor, which are the one-off
     list rows this spec removes.
   - Settled with this decision: for a single-device target that route writes the device's
     own settings. For a group it keeps its minted policy.
3. **Decommissioned devices keep own settings**, so a restore is faithful.
4. **The first release offers every feature that passes the parity fixture.** The
   per-feature cost is one fixture row.

## Evidence notes

- **Two commits.** Drafted against `8329045244` (2026-10-08); the worktree was 2,175 commits
  behind. Re-checked against main at `46f3a89d01` (2026-11-22).
- **Re-read on current main:** the warranty ranking; `validateAssignmentTarget`; the newest
  database assignment-target validator (`2027-01-12-200200`); the org merge assignment
  fix-up; `devicePolicySet.ts` and `configPolicyAssignmentDevices.ts` (headers and exports,
  not every caller); the assign validator's priority bounds; that #12293 is still open.
- **Read at the drafting commit only:** the grep of the other resolver sorts; the 2026-09-06
  inheritance spec; `docs/agents/tenancy-rls.md`.
- **From a fact-gathering pass at the drafting commit (not re-read on main):** table shapes,
  the polymorphic `target_id` and its trigger-based integrity, the effective-links view and its
  contract test, the normalized tables, reader and lister inventories, the delete mechanism
  behind #12293, registry entries, the owner-immutability trigger.
- **From Codex's independent review, also at the drafting commit (not re-read):** peripheral delivery choosing policies per
  device class; the patch scheduler expanding assignments before creating jobs; `devices`
  carrying a unique `(id, org_id)`; the reset-authorization precedent.
- **From Codex's second review at `46f3a89d01`** (each function read by Codex; spot-checked
  here: the integration test that expects the refused device move, the statement-level
  trigger on `devices`, the unbounded priority column, the inner join in the automation
  resolver): the reader and discovery counts, warranty's two paths, the empty-link defect,
  the backup protection aggregate, the org move and org merge findings.
- **Unresolved, must be reproduced in D0:** an org merge where the losing organization owns a
  policy assigned at device level to one of its devices (expected to fail); a device org move
  through the move service with such an assignment (the raw update is refused).
