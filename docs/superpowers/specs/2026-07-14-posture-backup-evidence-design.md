# Posture report: third-party backup evidence

**Status: PARKED — design only, not approved for implementation.**

Parked on 2026-07-14 on a scope objection (see [Why this is parked](#why-this-is-parked)).
Do not implement from this document without settling that question first.

## Problem

The Security & Compliance Posture report reports backup as a control, but it can
only see Breeze's own backup:

- `backup_configs.provider` is `local | s3 | azure_blob | google_cloud` — storage
  *targets* for Breeze's own backup, not vendors.
- `c2c_connections.provider` is `microsoft_365 | google_workspace` — the *source
  Breeze backs up*, not the backup vendor.

There is no representation of "a third-party product protects this customer".
A repo-wide grep for Cove, Dropsuite, Veeam, Acronis, Datto, Axcient and N-able
returns nothing.

So `backupConfigured: Boolean(backup || c2c)` answers *"is Breeze backing this
customer up?"*, not *"is this customer backed up?"*. For a customer protected by
Cove, the report renders **Backup: No** in red and fires *"Configure backups — no
backup solution is currently detected for this organization."* That is a false
negative on a document whose stated purpose is filling out cyber-insurance
applications.

### This explains the `backupRequired: false` default

The posture template card defaults `backupRequired` to `false`
(`ReportTemplates.tsx:349`, re-forced at `:427`), and it is the only UI path that
can create a posture report — `handleUseTemplate` intercepts the type before the
builder sees it, because the builder cannot round-trip it.

`docs/features/reports.mdx` justifies the default as suiting "workstation-oriented
assessments". The report cannot express that: the device query filters on `org_id`,
optional `sites`, and the permission set — there is no OS or device-type filter
(`securityComplianceReport.ts:180-196`). You can scope to a *site*, not to
workstations-versus-servers.

The real reason is this gap. For any MSP not using Breeze's own backup the control
is permanently red, so defaulting it off was the only sane move. **The default is a
workaround for missing evidence, not a product preference** — which is why
"just flip the default to `true`" is wrong: it converts a misleading
"Not required" into a flatly incorrect "No" for every Cove customer.

### Secondary flaw

`Boolean(backup || c2c)` collapses endpoint and SaaS backup into one boolean. A
customer with SaaS backup but no endpoint backup renders **Backup: Yes**, and the
endpoint gap disappears. The Cove/Dropsuite split is exactly this distinction and
the current model cannot hold it.

## Why this is parked

This design turns the posture report into a reporting plane for software Breeze
does not manage. Breeze would be storing, rendering and standing behind claims
about third-party products it has no visibility into and no relationship with.

That is a product-direction decision, not a technical one, and it generalises
immediately: if backup is attested, why not EDR, DNS filtering, or MFA? The same
false-negative argument applies to every control where an MSP uses a tool Breeze
doesn't integrate. Answering it for backup alone sets the precedent for all of
them without anyone deciding to.

**Settle before implementing:** is "record and render evidence about tools we do
not manage" something Breeze does at all? If yes, it wants a deliberate,
report-wide answer rather than a backup-shaped one. If no, the gap needs a
different fix — most likely a real Cove/Dropsuite integration, or accepting that
the posture report only speaks to what Breeze observes and saying so plainly on
the document.

## Decisions taken before parking

Recorded so the thread isn't lost, not as settled scope.

| Question | Decision | Reasoning |
|---|---|---|
| How does Breeze learn Cove/Dropsuite protects a customer? | Attestation | Covers the long tail no integration roadmap finishes. Ships without vendor APIs. |
| Who owns an attestation? | **Org-only** | See justification below — required by CLAUDE.md for a non-dual-axis config table. |
| How is "not applicable" decided? | Derived | Org has devices → endpoint in scope. Org has M365/Google → SaaS in scope. The report already runs all three queries, so it costs nothing and needs no per-org config. |
| What happens to `backupRequired`? | Escape hatch, default **on** — *after* attestation ships | Derivation answers scope; the toggle becomes a rare "exclude backup from this assessment". |

### Org-only ownership justification (CLAUDE.md requirement)

CLAUDE.md requires an explicit justification whenever a new config table is
org-owned rather than `org_id` XOR `partner_id`.

**An attestation is not a policy.** Partner-wide-first (epic #2135) exists for
rules an MSP authors once and applies broadly — "require backup", "approve these
patches". "Cove protects Acme Ltd" is a *fact about one customer*: evidence, not a
reusable rule. Evidence being org-scoped is correct. That Cove is the MSP's house
standard is a data-entry convenience, not a policy relationship. This is the same
reasoning that makes `backup_configs` org-owned.

The cost was accepted knowingly: the vendor is re-entered per customer.

Note the split this exposes — the *attestation* is org-scoped evidence, but
`backupRequired` (is-backup-in-scope) is policy-shaped and may belong at partner
level. Unresolved.

## Design sketch

### Data model

```
backup_attestations
  id          uuid pk
  org_id      uuid not null → organizations(id)   -- shape 1 RLS
  kind        enum('endpoint','saas')  not null
  vendor      varchar(80)              not null   -- 'Cove', 'Dropsuite', free text
  note        text                     null
  attested_by uuid not null → users(id)
  attested_at timestamptz not null default now()
  unique (org_id, kind)
```

A table rather than `organizations.settings` because:

- **Provenance is the product.** "Cove — attested by todd@lanternops.io, 14 Jul
  2026" is materially stronger evidence than "Cove". An unsigned, undated claim is
  near worthless to an underwriter; a named person and a date is something someone
  stands behind. That needs real columns.
- **Staleness becomes visible.** `attested_at` lets the PDF show the date and lets
  the report flag an attestation gone stale rather than presenting a two-year-old
  claim as current fact.
- `organizations.settings` has a recorded `z.any()` validation gap on its PATCH
  path; insurance evidence should not sit behind it.

`vendor` is free text, not an enum — the point is the long tail, and an enum means
a migration per new vendor. Cost: no curated list, inconsistent naming.

RLS: direct `org_id` column → shape 1, `breeze_has_org_access(org_id)`,
auto-discovered by the coverage contract test. Policies ship in the creating
migration.

### Evaluation

Backup splits into two independent controls:

| | In scope when | Evidence precedence |
|---|---|---|
| Endpoint/server | org has devices | Breeze `backup_configs` → attestation → none |
| SaaS/cloud | org has M365 or Google connection | Breeze `c2c_connections` → attestation → none |

Both gated on `backupRequired`. Out-of-scope rows are omitted, not rendered N/A.
Breeze-native evidence beats an attestation for the same kind: if Breeze runs the
backup that is strictly better evidence, and it stops a stale attestation
contradicting live data.

Three states:

- **Verified** — Breeze ran it. Green. Can report `backupEncrypted`.
- **Attested** — declared. Green, labeled `Cove — attested by <user>, <date>`.
- **Absent, in scope** — red; "Configure backups" recommendation fires.

Attested renders green rather than neutral, deliberately. The report's ethos is
honesty about gaps — an unassessed control reads N/A, never a favorable score. An
attestation isn't something Breeze assessed, but it isn't a gap either: it's a
named person putting their name to a claim. Rendering an accurate attestation as
neutral punishes the truth and pushes the MSP back to unticking the box. The label
carries the caveat, not the colour.

`backupEncrypted` stays `null` → N/A for attested evidence. Cove's encryption
posture is unknown and must not be implied.

**The score does not move.** `postureScore` is read verbatim from the precomputed
`security_posture_org_snapshots` weighting, where backup was never a term. This
changes what the document shows, not what it scores, keeping the change off the
scoring path.

### Persisted shape

`PostureControls` lives in `report_runs.result` and its header mandates that legacy
snapshots still render. Additive only:

```ts
backupEvidence?: {
  endpoint?: { inScope: boolean; source: 'breeze'|'attested'|'none';
               vendor?: string; encrypted?: boolean|null;
               attestedBy?: string; attestedAt?: string };
  saas?:     { inScope: boolean; source: 'breeze'|'attested'|'none';
               vendor?: string; attestedBy?: string; attestedAt?: string };
};
// legacy — retained, still written, read only as fallback
backupRequired?: boolean;
backupConfigured?: boolean;
backupEncrypted?: boolean | null;
```

The PDF branches on `backupEvidence` presence. Existing report runs keep rendering
through today's `buildPostureBackupMetric` unchanged.

### Not designed yet

Parked before reaching: PDF layout for the two rows, the org-settings UI, i18n
keys, and the test plan.

## Sequencing, if this ever proceeds

1. `backupRequired` **stays default-off** until attestation exists. Flipping it
   first makes every Cove customer read "Backup: No".
2. The attestation change flips the default to on in the same PR that makes on
   truthful.
3. `docs/features/reports.mdx` currently justifies the off-default as suiting
   "workstation-oriented assessments", which is not a thing the report can do. The
   honest interim sentence is that Breeze currently detects only its own backup.
   That correction is independent of this design and can land on its own.

## Related

- `docs/superpowers/specs/2026-07-14-security-compliance-posture-report-corrections-design.md`
- CLAUDE.md → "Partner-Wide First (config/policy tables) — epic #2135"
- CLAUDE.md → "Tenant Isolation / RLS", shape 1
