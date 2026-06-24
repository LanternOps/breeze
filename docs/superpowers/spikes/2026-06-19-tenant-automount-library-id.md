# Spike — `TenantAutoMount` library-ID format vs Microsoft Graph IDs

**Date:** 2026-06-19 (research) — **2026-06-22 (desk research complete)**
**Status:** 🟡 **RESEARCH COMPLETE — verdict provisionally CLEAN, pending live Windows round-trip validation**
**Gates:** Sub-project A §4 (agent applier) and §5 (Graph library picker UX). See `docs/superpowers/specs/2026-06-19-onedrive-helper-library-sync-design.md` §6 and `docs/superpowers/plans/2026-06-19-onedrive-helper-server-foundation.md` Task 1.

## Question

Can a `TenantAutoMount` library ID — the composite value OneDrive reads to silently
mount a SharePoint document library — be **constructed purely from Microsoft Graph
IDs**, so the MSP can browse-and-pick libraries instead of pasting the cryptic
"Copy library ID" string?

- **CLEAN** → the Graph library picker (Task 6 `listSharePointLibraries`) is viable as designed; the agent applier constructs keys server-side from Graph.
- **NOT CLEAN** → fall back to assisted "Copy library ID" capture (operator pastes the sync-client-produced ID); the picker degrades to a verification helper.

## Verdict (desk research): **CLEAN** — every composite field is a native Graph field

Graph exposes a [`sharePointIds`](https://learn.microsoft.com/en-us/graph/api/resources/sharepointids?view=graph-rest-1.0)
complex type that returns **exactly** the fields the `TenantAutoMount` composite needs:
`tenantId`, `siteId`, `webId`, `listId`, `siteUrl`. No reverse-engineering, no
comma-splitting of the site-id triple, no client-side sync to harvest the value.

> ⚠️ **This is a desk verdict from documented behavior, not yet a live mount.**
> The one thing only a real box can prove is that OneDrive *accepts a
> Graph-constructed value and mounts the library*. That is the Windows test below.

## The composite format (ground truth from a real value)

The registry value is `HKCU\SOFTWARE\Policies\Microsoft\OneDrive\TenantAutoMount`,
one named value per library (the value **name** is cosmetic — OneDrive uses the
library's own title). The value **data** is this `&`-separated composite:

```
tenantId=<GUID, no braces>&siteId={<GUID>}&webId={<GUID>}&listId={<GUID>}&webUrl=<url-encoded>&version=1
```

Literal real-world example (from call4cloud):

```
tenantId=02ad5f9c-3696-477b-8cb3-9ba4e0a9ac9c&siteId={87a9f4b2-757b-4663-b19e-d58398f0f1e4}&webId={d1135130-a5e3-41d2-a8f1-a547508eaf04}&listId={265BA069-9F1C-4065-83AC-B7C7A0CE4C28}&webUrl=https://wvdcloud901026.sharepoint.com/sites/Office%5FTemplates&version=1
```

**Format rules observed:**

| Field | Braces? | Notes |
|---|---|---|
| `tenantId` | **no** braces | Entra tenant GUID |
| `siteId` | **`{ }`** braces | SharePoint **site collection** GUID |
| `webId` | **`{ }`** braces | SharePoint **web** GUID (== siteId for a modern root-only site, differs for subsites) |
| `listId` | **`{ }`** braces | document library's list GUID (example is upper-cased; GUIDs are case-insensitive) |
| `webUrl` | n/a | URL-encoded site URL (note `_` → `%5F` in the example — standard percent-encoding) |
| `version` | n/a | literal `1` |
| separators | — | literal `&` in the **registry** form. (Intune OMA-URI needs `&` HTML-encoded as `&amp;` — not our path; we write the registry directly.) |

## Graph → composite mapping (the construction formula)

**One Graph call** yields every field, expanding `sharePointIds` on each drive:

```http
GET /v1.0/sites/{site-id}/drives?$select=name,id&$expand=list($select=id,sharePointIds)
```

Each returned drive (= one document library) carries
`list.sharePointIds = { tenantId, siteId, webId, listId, siteUrl, ... }`. Build:

```
tenantId = sharePointIds.tenantId                         # plain, no braces
siteId   = "{" + sharePointIds.siteId + "}"               # wrap in braces
webId    = "{" + sharePointIds.webId  + "}"               # wrap in braces
listId   = "{" + sharePointIds.listId + "}"               # wrap in braces
webUrl   = urlEncode(sharePointIds.siteUrl)               # or site.webUrl
value    = `tenantId=${tenantId}&siteId=${siteId}&webId=${webId}&listId=${listId}&webUrl=${webUrl}&version=1`
```

Belt-and-suspenders (no `sharePointIds` needed): Graph's site id is itself the
triple `{hostname},{siteCollectionId},{webId}`
([Working with SharePoint sites in Graph](https://learn.microsoft.com/en-us/graph/api/resources/sharepoint?view=graph-rest-1.0)),
so `siteId`/`webId` can also be split out of `GET /sites/{id}.id`. The
`sharePointIds` path is preferred — it gives `listId` and `tenantId` directly too.

## Implications for the already-shipped server foundation (#1679)

The data model already accommodates **either** spike outcome — no schema change needed:

- `config_policy_onedrive_libraries` already has `library_id` (the full composite),
  plus discrete `site_id` / `web_id` / `list_id` / `site_url` columns. CLEAN means
  we populate `library_id` server-side from Graph; the discrete columns stay as
  captured provenance.
- **Task 6 `listSharePointLibraries` should be extended** to select
  `$expand=list($select=id,sharePointIds)` and return `tenantId/siteId/webId/listId/siteUrl`
  per library (today it returns `siteId/siteName/siteUrl/driveId/listId/libraryName`
  from the drive's `list.id`, which is the listId but omits tenantId/webId). The
  composite-builder (agent-applier plan) consumes those fields. Small, additive.

## Carried gotchas to bake into the agent applier (§4)

1. **Files On-Demand is a hard prerequisite** — `TenantAutoMount` is a no-op unless
   OneDrive is silently signed in *and* FOD is on. (This is exactly why the spec has
   the helper own `SilentAccountConfig` + `FilesOnDemandEnabled` base config first.)
2. **8-hour mount delay** — OneDrive applies AutoMount on a timer (up to 8h). Set
   `HKCU\SOFTWARE\Microsoft\OneDrive\Accounts\Business1\TimerAutoMount = 1` (QWORD)
   to force near-immediate processing; OneDrive resets it after running. The applier
   should poke this after writing keys.
3. **Per-user is HKCU** — the policy/mount state lives under the user hive. System
   context alone won't drive HKCU mounts; the applier must write per active-session
   SID (`HKU\<SID>\...`) — matches §4's per-session design.
4. **Previously-unsynced libraries do NOT re-mount** — if a user once "stopped
   sync" on a library, OneDrive will not silently re-mount it from AutoMount.
   Detect *real* mount state (read `Accounts\Business1` tenant/scope cache), and
   record the gap as **drift** rather than rewriting the key forever. (Already the
   §4 design + `onedrive_device_state.driftEntries`.)

## Windows validation procedure (run on a real box) — the live gate

> 📋 **Copy-pasteable PowerShell runbook:** [`2026-06-19-tenant-automount-windows-runbook.md`](./2026-06-19-tenant-automount-windows-runbook.md) — open that on the Windows box. The summary below is the same procedure.

Prereqs: a Windows box signed into a OneDrive **Business** account on a test tenant,
OneDrive Files On-Demand enabled, and Graph access (the org's M365 connection or
Graph Explorer) to that tenant.

1. **Ground truth.** In the browser, on a test SharePoint library, **Sync → Copy
   library ID**. Save the verbatim string. Confirm it matches the composite shape
   above (tenantId no-braces, siteId/webId/listId braced, webUrl encoded, version=1).

2. **Pull the same library from Graph** and confirm the fields line up 1:1:
   ```http
   GET /v1.0/sites/{hostname}:/sites/{path}?$select=id,webUrl,sharepointIds
   GET /v1.0/sites/{site-id}/drives?$select=name,id&$expand=list($select=id,sharePointIds)
   ```
   Check: does `sharePointIds.siteId/webId/listId/tenantId` equal the braced GUIDs in
   the copied string? (Case-insensitive.) Does `siteUrl`/`webUrl` match?

3. **Construct & round-trip on a CLEAN test user** (one that has *never* synced this
   library, to avoid the no-re-mount trap):
   - Build the composite **purely from the Graph fields** (formula above).
   - Write it: `New-ItemProperty 'HKCU:\SOFTWARE\Policies\Microsoft\OneDrive\TenantAutoMount' -Name 'SpikeTest' -Value '<graph-built-value>' -PropertyType String`
   - Force the timer: set `...\Accounts\Business1\TimerAutoMount` = 1 (QWORD).
   - Restart OneDrive: `& "$env:LOCALAPPDATA\Microsoft\OneDrive\OneDrive.exe"`
   - **Confirm the library actually appears in File Explorer and in the
     `Accounts\Business1` tenant/scope cache** (not just that the key exists).

4. **Record the decision** in this doc:
   - **CLEAN confirmed** → document any field-casing/encoding quirks found; greenlight
     the agent applier + Graph picker as designed.
   - **NOT CLEAN** → capture what diverged (a field Graph can't supply, an encoding
     OneDrive rejects); the data model already holds the discrete IDs, so the only
     change is sourcing `library_id` via operator paste, and the picker becomes a
     verification helper.

## Sources

- [IT Admins — Use OneDrive policies to control sync settings (Microsoft Learn)](https://learn.microsoft.com/en-us/sharepoint/use-group-policy)
- [SharePointIds resource type (Microsoft Graph v1.0)](https://learn.microsoft.com/en-us/graph/api/resources/sharepointids?view=graph-rest-1.0)
- [Working with SharePoint sites in Microsoft Graph](https://learn.microsoft.com/en-us/graph/api/resources/sharepoint?view=graph-rest-1.0)
- [Introducing the OneDrive AutoMountTeamSites setting — Nicola Suter](https://nicolasuter.ch/onedrive-automountteamsites/)
- [Automount OneDrive Team Sites / TimerAutoMount — call4cloud](https://call4cloud.nl/timer-automount-of-onedrive-team-sites/)
- [Automatically syncing Teams/SharePoint libraries — Katy's Tech Blog](https://katystech.blog/office365/automatically-syncing-teams-sharepoint-libraries)
- [Scripting a SharePoint/OneDrive/Teams library to sync — Undocumented Features](https://www.undocumented-features.com/2022/04/12/scripting-a-sharepoint-onedrive-or-teams-library-to-sync-with-the-onedrive-for-business-client/)
- [Clarification on SharePoint composite Site ID (Microsoft Q&A)](https://learn.microsoft.com/en-us/answers/questions/1189234/clarification-on-sharepoint-composite-site-id)
