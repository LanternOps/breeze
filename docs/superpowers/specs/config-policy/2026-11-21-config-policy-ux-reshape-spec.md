---
title: Configuration policies UX reshape (applies-to first, draft until live, visible inheritance)
status: draft
date: 2026-11-21
origin: "Design shaping session with Todd, 2026-11-21: six reported problems with Config Policies"
related_issues: [12306, 9565, 6670, 12309, 11776, 12293, 6339, 12263, 3381, 12308, 9408]
companion_spec: 2026-11-21-device-own-settings-spec.md
---

# Configuration policies UX reshape

## Problem

A tech wants one sentence to be true: "these devices get these settings". The product splits
that sentence across four screens and three scope-like ideas with different names.

| # | Reported problem | What the product does today | Issue |
|---|---|---|---|
| 1 | "All orgs" vs one org is confusing | Create asks "Scope: Partner library / A specific organization". That is *ownership*: permanent, and its default follows the global org switcher (`useDefaultOwnerScope`). Where the policy *applies* is a different, later step. | none here; #12308 is the same confusion on backup setup |
| 2 | Must save before seeing the options | Create takes name, description, status, owner and parent only (`createConfigPolicySchema`). Feature tabs exist only after the first save. | none |
| 3 | Assignments are hidden | Assignments is the last of 29 tabs (Overview, 26 features, Compliance Status, Assignments), behind "More" at normal widths, with no count and no warning when empty. | #12306 |
| 4 | Assignments must be chosen again after create | Nothing is assigned on create, by design (comment in the create handler, `routes/configurationPolicies/crud.ts`). Choosing "A specific organization" does not assign to it. | #12306 (item 4) |
| 5 | Inheritance isn't obvious | Two mechanisms share one word. A policy can have a parent policy (one level). Separately, the closest assignment wins per feature. The second is explained only on the device page. | #9565 (device side; the chain display shipped in #9575) |
| 6 | No obvious per-device change | A device can be targeted only from an org-owned policy's Assignments tab, through a picker capped at 200 devices. Nothing on the device page starts it. | #6670 |

Proof case: on a partner onboarding call (#12306) a saved patch policy applied to nothing and
nothing on the page said so. That state must not be reachable silently.

## Users & scope (partner vs org)

- **Partner tech with full org access** (the main author). Thinks "for everyone", "for Acme",
  or "for this one machine". Should never have to choose an ownership type to say that.
- **Partner tech with limited org access.** Cannot write partner-owned state
  (`canManagePartnerWidePolicies`, `services/partnerWideAccess.ts`). Creates org-managed
  policies only; sees MSP-managed ones read-only with the reason stated up front.
- **Org-scope user** (a customer's own admin, or a single-org IT team on an org token). Creates
  org-managed policies for their own org. Today cannot open MSP-managed policies at all
  (`policyAccessCondition`, `services/configurationPolicy.ts`); see Open Decision 2.

Ranges: 1 to 500+ organizations per partner, 10,000+ devices, tens to low hundreds of policies,
26 feature types, 0 to hundreds of targets per policy.

## Decisions already made (Todd, 2026-11-21)

1. Ask only "Applies to". Ownership is derived and shown as a secondary "Managed by" line.
2. A new policy is a draft until one explicit go-live. The existing Inactive status is the draft.
   Edits to a live policy stay immediate, with an accurate reach line instead of draft/publish.
3. Full shape in waves; backend changes allowed.
4. Approved with the brief: feature rail replaces the tab strip; Overview tab removed; no target
   pre-selected on create; owner and parent lock at the first feature save; the renames below;
   the list under a selected org shows policies that apply to that org.

## Proposed design

Thesis: **a policy is a sentence: what it sets, where it applies, whether it is live.** One page
shape serves create and edit. "Where" is a permanent, always-visible part of the policy.
Inheritance is shown at the two places a decision is felt: on the feature (parent policy) and on
the device (precedence).

Visual authority is the web app's existing components and tokens.

### Vocabulary

| Concept | Word in the UI | Retired |
|---|---|---|
| Where a policy applies (assignments) | **Applies to** | Assignments, Scope, Organizations tab |
| Who can edit it (owner) | **Managed by** | Partner library, Partner-wide as a type, A specific organization |
| Policy-to-policy inheritance | **Parent policy**, "Based on X" | Master, baseline, Link to Existing, linked |
| Which assigned policy wins on a device | **Precedence**, "most specific wins" | Inheritance chain, closest-wins priority |
| Inactive | **Draft** / **Paused** (Open Decision 3) | Inactive |

"Baseline" is avoided because security audit baselines already use it across the app. The two
inheritance mechanisms never share a word. API field names do not change.

### Policy page (same for `/new` and `/:id`)

- **Header:** name, description, state pill, and the facts the Overview tab held: "Based on X",
  "Parent of N policies", and "Managed by Acme" only when org-managed. Overview is removed.
- **Applies-to strip** under the header, visible while any feature is open:
  `Applies to  All organizations · Workstations · Windows   212 devices   [Edit]`.
  "Not applied to any device" is a warning state with an Assign action. Long lists truncate
  ("Acme, Birch +12").
- **Feature rail** replaces the 29-tab overflow strip. Vertical, grouped, all 26 features
  visible, each with a text state: *Set here*, *From parent*, *Not set*. The selected feature
  stays in `window.location.hash`. Reuse the pattern in `components/settings/SettingsSectionNav.tsx`.
  Below about 1024px the rail becomes a picker. Proposed groups (Open Decision 5):
  Updates & software · Monitoring · Security · Backup · Access & end user · Lifecycle.
- **Remove from this policy** on every *Set here* feature. Today a feature, once saved,
  cannot be returned to *Not set* from the page (#12263). Remove returns it to *Not set*, or
  to *From parent* when the parent has it.
- **Compliance Status** stays as a results view at the foot of the rail.

### Save model

One pattern per control type (`docs/agents/settings.md` rule 7):

- **Feature:** per-feature Save, as today. New: an unsaved-changes guard on leaving a feature.
- **Name and description:** a small details form with Save and Cancel.
- **Applies to:** edits are staged in the panel and commit on one **Apply** that states the
  change ("adds 64 devices, removes 12"). Today every toggle commits at once, and on a live
  policy this is the widest-reaching edit on the page.
- **State:** Turn on and Pause are explicit actions that state their reach.
- **Reach line** on every save of a live policy: "Save · reaches 212 devices". Reach is devices
  targeted directly plus devices reached through policies based on this one.
- The reach line and the staged Apply are also where a destructive link gets its own
  confirmation, such as a software allowlist that removes everything unlisted (#3381). That
  rule is #3381's; this spec provides the place and the number.

### Create: draft until go-live

- `/configuration-policies/new` opens the full page at once; every feature is browsable before
  anything is saved. The two-card chooser becomes an optional **Start from**: Blank · Based on a
  parent policy · later, Copy of a policy (#12309, #11776).
- The policy is saved as a draft (`status: inactive`) at the first feature Save. Only a name is
  needed first. A draft survives navigation, lists as Draft, and reaches no device.
- **Managed by and Based on are fixed at that first save.** Both are create-only in the API and
  enforced in the database. The page says so before the first save. Afterwards the way to change
  either is Copy.
- Primary action is the go-live, not a save: **"Turn on · reaches 212 devices"**. It needs a
  name and an explicit applies-to decision: at least one target, or the stated choice "Don't
  apply yet".
- No target is pre-selected. The org switcher's current org is the first suggestion in the
  picker. This keeps the create handler's rule in `crud.ts` (never silently over-apply to a whole org)
  while removing the forgotten second step.

### Applies-to editor

One component for both owner kinds, replacing the split between `AssignmentsTab` and
`OrganizationScopePanel` (with its `PartnerGroupAssignmentSection`). It opens from the strip as
a side panel so the feature stays in view.

- Top choice: **All organizations** or **Specific targets**. Specific targets is a list built
  with one drill-down picker (Organization, Site, Device group, Device), searched on the server.
  Device group covers both kinds: an organization's group, and an MSP-owned group that spans
  organizations (#10521). An MSP-owned group is offered only on an MSP-managed policy, which
  is the rule the API and the database already enforce.
- Each target row edits in place: role and OS filters, and Priority under Advanced. The filter
  row leaves room for tag and dynamic filters (#7414, #8957).
- A fixed legend: "Most specific wins, per feature: Device › Device group › Site › Organization
  › All organizations. A closer policy replaces the whole feature; it does not merge."
- Live count at the foot. Zero matching devices is a warning.
- MSP-managed policies gain site, organization-owned device-group and device targets in the UI.
  The API already accepts them (`validateAssignmentTarget`). The panel today offers All
  organizations, single organizations and MSP-owned device groups, nothing narrower.
- An org-managed policy shows its organization locked and offers that org and below.
- **Managed by** is one secondary line. Default for a partner user with full org access: their
  MSP. Before the first save it states the trade plainly (see Open Decision 1).

### Policy list

- An **Applies to** column from real assignments replaces the ownership badge, with a device
  count and a state: Live · Draft · Paused · Not applied · Live through N policies.
  "Managed by Acme" shows only on org-managed rows.
- Filters: state, not applied, organization.
- With one org selected in the switcher: policies that apply to that org, plus drafts. Today
  that view returns the org's own policies plus every partner-owned one
  (`listConfigPolicies`), which stops being useful once partner-owned is the default.

### Inheritance display

- **Parent policy, on the feature.** *From parent* shows the inherited values read-only with
  "From Standard Workstation · Open" (`settings.md` rule 4: show the value and its source), and
  **Change for this policy**, which unlocks the form and writes only on Save. Today Override
  writes a copy at once. *Changed here* offers **Reset to parent** only when the parent has that
  feature; otherwise the action is Remove.
- **Start-from picker.** An MSP-managed policy can only be based on MSP-managed parents; the
  picker says why org-managed ones are absent.
- **A parent is never inert.** Parent status does not gate inheritance and link changes
  propagate live (inheritance spec 2026-09-06, "Semantics"). A draft, paused or unapplied policy
  that others are based on reads "Live through 3 policies · 148 devices", and its saves carry
  that reach.
- **Precedence, on the device** (Config tab). Already shipped (#9575): chain rows link to each
  policy, list what it contributes and mark the features a closer policy won. Still to do: each
  feature card names the winning policy as a link and the level it arrived through; the chain
  says why a policy lost (more specific level, or priority; #9565 notes both rows show priority 0
  with no hint that level decided it); one feature label set, shared with the editor.
- **Precedence, on the policy** (W5). "Outranked on 14 devices" per feature.

### Device page

"Change for this device" and "Apply a policy to this device" are specified in the companion
spec for #6670. This spec delivers only the precedence display above.

### States

- Policy: draft · live · live but not applied (warning) · paused · archived · live through N.
- Feature: not set · set here · from parent · changed from parent · saved but not deployed
  (existing amber state) · unavailable on this policy (say why, offer Copy).
- Applies to: none · all organizations · N organizations · mixed narrower targets · target
  deleted · zero matching devices · count loading · staged, not yet applied.
- Viewer: partner with full access · partner with limited org access (read-only on MSP-managed
  policies with the reason shown before any click) · org user on their own policy · org user on
  an MSP-managed policy (Open Decision 2).

### Assignment homes

The policy page is the home. The Site page tab and the Device Groups bulk action stay as entry
points and use the same row semantics. The target listing drops partner-owned policies for every
non-system caller (`GET /configuration-policies/assignments/target`), so an MSP-managed
policy assigned at a site shows on no screen today. It must show on the Site page for callers
who can see the policy, and in the policy's own target list.

## API changes

Decided here, with the reason for each.

1. **Staged Apply:** `POST /configuration-policies/:id/assignments/apply` taking
   `{ add, update, remove }` in one transaction, with a dry-run mode that returns the device
   delta for the confirmation line. A diff, not a replace-set: a row added from the Site page
   after the panel loaded, or a row the panel cannot render, must survive an Apply. Each added
   target goes through `validateAssignmentTarget` and through the arming gates the single
   assignment POST runs today (HP CMSL collection, vendor-update arming); write gates are
   unchanged.
2. **Reach:** a read returning `{ direct, throughChildren, organizations }` for one policy, and
   in batch for list rows. Counts honour role/OS filters and group membership. Computed inside
   the caller's request context, never a system context: a through-children total must not
   reveal another customer's device counts to an org-scope caller.
3. **List:** rows carry an applies-to summary and derived state. New filters: applies to org,
   not applied. The existing `orgId` filter keeps its meaning for other callers.
4. **Go-live needs no new endpoint.** Assignments already save on an inactive policy (no status
   check found in the assignment route or in `assignPolicy`) and Turn on is the existing status PATCH. The create page sends
   `status: 'inactive'` for a new draft.
5. **Target listing:** include MSP-managed policies for partner-scope callers.
6. **Read scoping** (ships with the W3 owner default, not before): see "Tenancy & data model
   impact" and Open Decision 2.

## Tenancy & data model impact

- **W1 and W2: no schema change.** New reads run under `withDbAccessContext`.
- **W3 changes what a partner-owned policy means.** Until now partner-owned rows were a shared
  library. With MSP-managed as the default they will often be customer-specific. Two
  consequences must ship in the same wave:
  - *Read scoping.* Once partner-owned rows can be customer-specific, a caller may see, open
    or name an MSP-managed policy only when it applies to an organization that caller can
    access. This covers org-scope callers and partner-scope callers with limited organization
    access, on every surface that lists, opens or names policies, the parent picker included.
    W3 ships with a test that a caller limited to one organization cannot list, open or name a
    policy targeted only at another.
  - *Linked entities.* A partner-owned policy can link only partner-owned linked entities
    (software, security, compliance, sensitive-data, peripheral and maintenance policies, backup
    profiles), never an org-owned one, and backup resolves each org's default destination
    (`validateFeaturePolicyExists`, `PARTNER_LINKABLE_FEATURE_TYPES`). OneDrive Helper cannot
    exist on one at all (`ORG_SCOPED_ONLY_FEATURE_TYPES`, which holds only that type today). The
    owner default therefore narrows what a single-customer policy can link. See Open Decision 1.
- **Possible column** `configuration_policies.first_activated_at timestamptz NULL` if Open
  Decision 3 picks two labels. `configuration_policies` is an org-cascade table, so the column
  needs a `CORE_TENANT_EXPORT_POLICY` classification (`included`). No RLS change.
- No new tables. The other config surfaces that share `useDefaultOwnerScope` (33 files import
  it) keep their owner selector: ownership is their only scope control, whereas a config policy has targets.

## Out of scope

- The insides of the 26 feature forms; resolver rules; the one-level parent rule.
- Draft/publish for edits to a live policy.
- Exclusion targeting ("all except Birch") and field-level merging.
- Tag and dynamic filters (#7414, #8957).
- The confirmation rule for destructive links (#3381) and the backup setup pages (#12308).
- Duplicate and copy-between-orgs themselves (#12309, #11776); this spec only names Copy as the
  exit from a locked owner or parent.
- AI tool changes (`aiToolsConfigPolicy.ts`): the create tool's owner default should follow the
  same rule in a follow-up.
- Device-own settings: companion spec.

## Waves

| Wave | Scope | Depends on |
|---|---|---|
| W1 | Applies-to strip (targets, no counts) opening today's editors; not-applied warning on page and list; list Applies-to column, with the list API returning the applies-to summary; vocabulary and the contradictory copy; device Config tab: winner link and level on each card, the reason a policy lost, shared labels (the chain display itself shipped in #9575); hard-coded English badges into i18n. This wave is the scope of #12306 (p1), which has no open PR or plan. | none |
| W2 | Unified applies-to editor with staged Apply; MSP-managed site/group/device targets; reach read and counts; target-listing fix | W1 |
| W3 | One-page create with draft and go-live; feature rail; save-model changes; owner default with the org-scope read rule; list filter by applies-to | W2 |
| W4 | Device-own settings | companion spec, #12293 |
| W5 | "Outranked on N devices"; Copy (#12309, #11776) | W2 |

Rigor: W1 is UI. W2 and W3 touch assignment writes and read scoping across tenants, so they get
full rigor (TDD, contract suites, one independent review). Every wave updates the
`apps/docs` configuration-policies page and the release-notes draft, adds new locale keys in all
eight locales, and uses `runAction` for mutations and `data-testid` for E2E.

## Open Decisions

Product calls for Todd. Each has a recommendation.

1. **Owner default when a policy targets a single organization.** New facts since the shaping
   questions: an MSP-managed policy cannot link that customer's own software/security/backup
   entities or a specific backup destination, cannot carry OneDrive Helper, and (today) is
   invisible to the customer's own admins.
   - A. Always MSP-managed for partner users, with the trade stated on the Managed-by line before
     the first save and in each linked picker. "Acme, then Birch too" keeps working.
   - B. Org-managed when the first target is within one org. Links that org's own entities, but
     spreading to a second org needs Copy.
   - **Recommend A.** It matches partner-wide-first (#2135) and the request behind #11776; the
     cost is that single-customer linked entities must be MSP-owned.
2. **What a customer's own admin sees of MSP-managed policies.**
   - A. A read-only view of the MSP-managed policies that apply to their org, and only those are
     offered as parents.
   - B. Keep them hidden, as today.
   - **Recommend A.** Otherwise the default in decision 1 leaves a customer admin with an empty
     policy list while their devices are fully managed.
3. **Draft and Paused: one label or two.** Two needs the `first_activated_at` column.
   **Recommend two.** "Paused" tells a tech that turning it back on re-applies to known devices.
4. **OneDrive Helper on an MSP-managed policy that targets one org.** It is the only org-only
   feature today. Keep the gate (it is database-enforced and org-bound by design) or lift it. **Recommend keep**, with Copy as the
   stated way out.
5. **Rail groups and their names.** Proposal above; adjust freely. The six features added since
   October would sit as: Vendor updates in Updates & software; Security agents and Containment
   in Security; System protection in Backup; Workload inventory in Monitoring; Wake-on-LAN in
   Access & end user.

## Evidence notes

- **Two commits.** Drafted against `8329045244` (2026-10-08); the worktree was 2,175 commits
  behind. Re-checked against main at `46f3a89d01` (2026-11-22). Line numbers are omitted
  because every one had moved.
- **Re-read on current main:** `useDefaultOwnerScope`; the Scope fieldset in
  `ConfigPolicyCreatePage.tsx`; the create handler comment in `crud.ts`;
  `validateAssignmentTarget`; `assignPolicy` and the assignment POST (no status check; arming
  gates present); `OrganizationScopePanel` and `PartnerGroupAssignmentSection`; the target
  listing route; `policyAccessCondition`; the `listConfigPolicies` org filter;
  `canManagePartnerWidePolicies`; `ORG_SCOPED_ONLY_FEATURE_TYPES`;
  the feature list in `featureTabs/types.ts` (26); the device picker caps of 200; the chain
  display in `DeviceEffectiveConfigTab.tsx`.
- **Read at the drafting commit only:** the body of `validateFeaturePolicyExists` and the
  contents of `PARTNER_LINKABLE_FEATURE_TYPES` (both still exist); the partner-wide select
  migration (`2026-10-05-110000`); the 2026-09-06 inheritance spec.
- **Related work found on main:** partner-owned device groups (#10521, shipped); #9575
  (shipped, part of #9565); #12333 (open PR for #12307, links monitors from the Monitors tab);
  #6339 (target picker listed other orgs' groups; API half fixed, picker check still open, and
  the unified picker must not repeat it at site or device level).
- **From a code-mapping pass at the drafting commit, not re-read:** per-tab save, feature-tab states in `FeatureTabShell`,
  device Config tab contents, picker caps of 200, the Site page and Device Groups entry points.
- **Inferred, verify before relying on it:** unsaved feature edits are lost on tab switch; the
  Assignments tab falls under "More" at most widths.
- **Adjacent defects seen during mapping, to file separately (unverified):** the list page sends
  no `limit` and may show only the first 25 policies; `?feature=` from Breeze Defaults is ignored
  by the create page; saving Overview may drop parent data from the page until reload.
