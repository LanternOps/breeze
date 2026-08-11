# Script Library Import / Export — Design

**Date:** 2026-08-08
**Status:** Ready for review
**Issue:** #3245 (epic #3249)

Filed under `onboarding-signup` alongside the other migration-epic specs.

## Summary

Add a versioned JSON **script bundle** format with export and import, so a script
library can move into Breeze from another RMM, between a staging and production
instance, or between partners — carrying the metadata that makes a library a library
rather than a pile of files.

The bundle is a durable public contract and it carries executable content that runs
as SYSTEM on customer endpoints, so §4 is the part of this design that matters most.

## Context

- **No import or export exists.** `routes/scripts.ts` and `routes/scriptLibrary.ts`
  have no bundle, upload, or export endpoint. The one route named "import",
  `POST /scripts/import/:id` (`scripts.ts:363`), clones a script that is *already*
  in the system library — it ingests nothing. **New routes must not collide with it**;
  this design uses `/scripts/bundle/*`.
- **The data model is richer than the workaround preserves.** `db/schema/scripts.ts`:
  `scripts` (with `orgId` **and** `partnerId` — already dual-ownership capable),
  plus `scriptCategories` (hierarchical via `parentId`), `scriptTags`,
  `scriptToTags`, `scriptVersions`, `scriptTemplates`.
- **The documented workaround** — `apps/docs/.../migration/toolkit.mdx` Recipe 6 —
  loops `POST /scripts` over a directory. It moves content and drops everything else:
  parameters, category, tags, `exitCodeSeverityMapping`, version history.
- **`isSystem` is correctly clamped today.** `scripts.ts:525`:
  `const isSystem = auth.scope === 'system' ? (data.isSystem ?? false) : false;`
  and the update schema rejects it outright (`scripts.ts:194`, closing the #633 hole).
  Import must inherit this, not re-open it.
- **Abuse signals are a background sweep, not a create-time gate.**
  `services/abuseSignals/sweep` calls `loadScriptFindings` / `computeScriptSignals`
  over stored scripts (`abuseSignals/index.ts:53-63`). Imported scripts are therefore
  covered automatically **provided import writes ordinary `scripts` rows** — but note
  this is detection after the fact, not prevention.

## Design Decisions

| Decision | Choice |
|---|---|
| Format | Versioned JSON bundle (`bundleVersion: 1`) |
| Tenancy in the bundle | **None.** No `id`, `orgId`, `partnerId`, `createdBy` |
| `isSystem` | **Never honoured from a bundle**, at any caller scope |
| Loose `.ps1`/`.sh` files | Converted to a bundle **client-side**; the server only ever sees JSON |
| Conflicts | Preview → commit, per-script `skip` / `rename` / `new-version` |
| `availability` on import | Defaults to **`'org'`**; `'partner'` requires #3262 fixed |
| Automations/schedules in a bundle | **Excluded** — see §4 |
| Version history | Current version only; `scriptVersions` stays internal |

## 1. Bundle Format

```jsonc
{
  "bundleVersion": 1,
  "exportedAt": "2026-08-08T00:00:00Z",
  "scripts": [
    {
      "name": "Clear print spooler",
      "description": "Stops spooler, clears queue, restarts.",
      "category": "Maintenance",          // by name, resolved/created on import
      "tags": ["printing", "windows"],    // by name
      "osTypes": ["windows"],
      "language": "powershell",
      "content": "…",
      "parameters": { /* as stored */ },
      "timeoutSeconds": 300,
      "runAs": "system",
      "exitCodeSeverityMapping": { /* nullable */ }
    }
  ]
}
```

Categories and tags travel **by name**, not id, and are resolved or created in the
importing tenant. Ids would be meaningless across instances and would leak the source
tenant's identifiers.

`bundleVersion` is checked on import; an unknown version is rejected with a clear
error rather than best-effort parsed. This is the field that lets the format change
later without breaking bundles already in circulation.

## 2. Routes

- `GET /scripts/bundle/export?ids=…` — bundle for the selected scripts.
  Org/partner-scoped to what the caller can already read. System-library scripts are
  exportable (they are not secret) but export with `isSystem` **absent**, so a
  round-trip cannot launder them back in as system scripts.
- `POST /scripts/bundle/preview` — annotate each entry `new` / `name-conflict`, with
  the resolved target and any validation errors. No writes.
- `POST /scripts/bundle/import` — body `{ bundle, mode, availability }` where
  `mode: 'skip' | 'rename' | 'new-version'` and
  `availability: 'org' | 'partner'`.

All three carry the same gating as the script write routes they compose —
authenticated, permission-checked, MFA where the existing create route requires it.
Bounded: max scripts per bundle and max bytes per `content`, both enforced server-side.

`availability: 'partner'` is what an MSP migrating a shared toolkit ultimately wants —
one copy for the whole partner rather than one per organization. It is **not** the
default here, and must not become one until **#3262** is fixed: the partner-wide create
path is currently gated on scope alone, with no `canManagePartnerWidePolicies` check.
Until then, import defaults to `'org'` and `'partner'` is gated on that capability at
the import route. The migration toolkit docs recommend `availability: "partner"` for
hand-rolled `POST /scripts` calls; that guidance should be revisited alongside #3262.

## 3. Import Service

`apps/api/src/services/scriptBundle/`, mirroring the preview→commit shape settled for
org import in `2026-08-08-bulk-org-site-import-design.md` §3 so the two feel the same:

1. Validate `bundleVersion`; validate every entry against the **existing**
   `createScriptSchema` rules (osTypes non-empty, language enum, `timeoutSeconds`
   1–3600, `runAs` enum). Reuse the schema; do not restate it.
2. Resolve categories and tags by name within the target scope, creating what is
   missing.
3. Per script, apply `mode` against an existing same-name script in scope.
4. Write through the **same service path** `POST /scripts` uses — not raw inserts —
   so the `isSystem` clamp, audit, and validation cannot diverge.
5. Per-entry failure is recorded and the rest proceed; the response reports
   `imported` / `skipped` / `renamed` / `versioned` / `errors`.

## 4. Security

This is the section to review hardest. A bundle is executable content that will run
as SYSTEM on every managed endpoint the importer can target.

- **`isSystem` is stripped unconditionally on import**, at every caller scope —
  stricter than `POST /scripts`, which permits it for `auth.scope === 'system'`. A
  bundle is untrusted input regardless of who uploads it; honouring `isSystem` would
  let a crafted bundle inject scripts that present as trusted system-library entries
  to every organization. This is the #633 hole in a new costume, and the mitigation is
  to never read the field rather than to clamp it.
- **No tenancy identifiers are read from the bundle.** `orgId`, `partnerId`,
  `createdBy` and `id` are ignored if present. Ownership comes from the caller's auth
  context only, so a bundle cannot place scripts into a tenant the importer cannot
  reach.
- **No automations, schedules, or triggers in a v1 bundle.** If a bundle could carry
  an automation binding, importing one would be arbitrary scheduled remote code
  execution across a fleet in a single click. Scripts import inert; binding them to
  anything stays a separate, deliberate action.
- **Import never executes anything.** No "run on import" convenience, ever.
- **Every imported script is audited individually** with the bundle's identity, so a
  later finding can be traced to the import that introduced it.
- **Abuse-signal coverage is by construction** — imported scripts are ordinary
  `scripts` rows, so the existing sweep picks them up. Because that is detection
  rather than prevention, the audit trail above is what makes it actionable.
- **Bundles are not trusted by origin in v1.** No signing, no marketplace. A bundle
  is exactly as trustworthy as the person importing it, and the UI should say so.

### Three fields that need their own handling

"Validation parity with `createScriptSchema`" is not sufficient, because for these
three the existing rule is weak, absent, or gated elsewhere.

- **`parameters` is `z.any()`** (`scripts.ts:169`) — no shape, no depth, no size
  limit. The 64KB cap at `scripts.ts:203-206` is *execute-time only*. A bundle would
  otherwise deliver an arbitrary attacker-authored jsonb blob straight into a column
  the export-policy registry itself classifies as a capability-bearing open container.
  **Import must impose its own bound**: a size cap and a depth cap on `parameters`,
  enforced at intake. Do not inherit `z.any()`.
- **`exitCodeSeverityMapping` can suppress alerting.** A schema-valid mapping may send
  every exit code to `null`, so a SYSTEM-level script ships pre-configured never to
  raise an alert on failure — neutering the after-the-fact abuse detection this design
  leans on as its backstop. Import should **reject an all-null mapping**, or drop the
  mapping entirely and let the importer re-add it deliberately.
- **`availability: 'partner'` currently rides an ungated path.** `POST /scripts` gates
  partner-wide creation on `auth.scope === 'partner'` alone
  (`scripts.ts:502-506`); `canManagePartnerWidePolicies` and `partnerOrgAccess` both
  appear **zero times** in that file, contrary to the CLAUDE.md Partner-Wide contract.
  A partner user with `org_access = 'selected'` can therefore push SYSTEM-level code to
  every org under the partner. Tracked as **#3262**.

  **This spec depends on #3262 being fixed first**, and until it is, `availability`
  must default to `'org'` on import — not `'partner'`. Making partner-wide the
  recommended default over an ungated path turns one bundle import into a fleet-wide
  fan-out, which is the amplification this section exists to prevent.

## 5. Web UI

Import/export controls on the script library page.

Export: multi-select → download `.json`.

Import: file picker accepting either a `.json` bundle **or a folder of loose
`.ps1` / `.sh` / `.py` / `.bat` files**, which the browser converts into a bundle —
inferring `language` and `osTypes` from the extension, `name` from the filename —
before anything is sent. This is the same split used for CSV in #3242: the client
does the format work, the server takes one clean JSON contract. It means the loose-
file migration case is covered without the API growing a second intake path.

Preview table with per-entry status and a mode selector, then commit through
`runAction` so partial results surface ("34 imported, 2 renamed, 1 failed").

The import screen must state plainly that scripts run as SYSTEM and that a bundle
should only be imported from a source the operator trusts.

## 6. Testing

- **`isSystem` is ignored from a bundle** — including when the caller *is* system
  scope. This is the regression test that matters most; assert the stored row is
  `isSystem: false`.
- Tenancy fields in a bundle (`orgId`/`partnerId` pointing at another tenant) are
  ignored, and the script lands in the caller's scope.
- Unknown `bundleVersion` rejected, not best-effort parsed.
- Each `mode` behaves: `skip` leaves the original untouched, `rename` suffixes,
  `new-version` appends to `scriptVersions` rather than replacing history.
- Category/tag resolution by name: existing reused, missing created, hierarchy intact.
- Round-trip: export → import into an empty tenant → exported bundle is equivalent.
- Caps: oversized bundle and oversized `content` rejected with a clear error.
- Validation parity: a bundle entry that would fail `POST /scripts` fails import too
  (`timeoutSeconds: 99999`, empty `osTypes`, bad language).
- **Oversized / deeply-nested `parameters` rejected at intake**, not at execute time —
  the existing schema is `z.any()`, so this bound exists only if import adds it.
- **All-null `exitCodeSeverityMapping` rejected** (or stripped), so a bundle cannot
  ship a script pre-configured never to alert.
- **`availability: 'partner'` denied** for a caller failing
  `canManagePartnerWidePolicies`, and the import default is `'org'`.
- No new tables, so **no RLS/cascade/export registration**. `scripts` and its
  satellites are already registered; adding no column leaves the export-policy suite
  untouched.

## Deferred

| Item | Why not now |
|---|---|
| Signed bundles / trusted publishers | Needs a key-distribution story; v1 is explicit that trust comes from the importer |
| A script marketplace or shared community library | Distribution problem, not an import problem |
| Bundling automations, monitors, or alert templates alongside scripts | Each is a separate contract, and automations specifically are the RCE hazard in §4 |
| Exporting full `scriptVersions` history | Internal history; portability does not need it and it multiplies bundle size |
| Server-side zip intake | The client-side conversion in §5 covers the real case without new server intake |
