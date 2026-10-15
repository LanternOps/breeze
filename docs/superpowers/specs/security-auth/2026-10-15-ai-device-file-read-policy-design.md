# AI device file read policy — design

Date: 2026-10-15. Status: approved design, pending plan.
Reviewed at: `8329045244` (main). Advisor pass: codex `gpt-6-astra` xhigh,
read-only; findings folded in (see Decisions log).

## Problem

Breeze AI can read a file off a managed device through `file_operations.read`,
`execute_command` (`file_read`), and the diagnostic-access tools. Today that is
gated by RBAC (`devices:execute`), a Tier 3 per-call approval, and a static path
floor (`aiPathRestriction.ts`) that excludes credential stores, `AppData`, and
system internals. Three things are missing:

1. **No tenant policy.** User-profile roots (`Documents`, `Desktop`, home
   directories) are readable with one approval, and nothing lets a partner or an
   org say "the AI may not read our documents". A customer asking "can your
   technicians' AI read our files?" currently gets "yes, with one click".
2. **No retention.** Tool outputs, including file contents, event-log messages
   and registry values, persist in `ai_messages.tool_output`,
   `ai_tool_executions.tool_output`, oversized-result `input_capture`
   artifacts, and the resumable SDK transcript, indefinitely. Only device
   deletion and org cascades remove the DB rows.
3. **No trust boundary on file contents.** `RAW_TEXT_FIELDS_BY_TOOL`
   (`aiToolOutput.ts`) fences endpoint-authored text for logs, tickets and
   alerts, but not file contents or registry values.

Scripts (`run_script`) can read the same files without the path floor. They are
Tier 3 and the content is pinned on the approval, so this is not silent, but
the "AppData is blocked" guarantee only holds for the file-operation
primitives.

## Goals

- Default posture: **no user profiles**. The AI does not read user-profile
  folders unless a partner (or org, tightening only) opts in, or an
  administrator approves a time-boxed diagnostic grant.
- One tenant setting, partner default → org override (tighten only), one
  resolver, enforced at one point for every AI principal that can reach a
  device-path tool (chat, agent runs, MCP, helper, script builder).
- Tool outputs expire everywhere they are persisted. Default 30 days,
  partner-configurable, `NULL` = keep.
- File contents and registry values reach the model inside the existing
  untrusted-text fence.

## Non-goals (follow-ups, tracked separately)

- Four-eyes approval for document reads under `any_with_approval`.
- End-user notification on the device when a file is read.
- Agent-side enforcement of the user-profile roots against resolved handles
  (server-side preflight only, as `AppData` is today). A user-created junction
  from `C:\Data` into a profile is not caught; the floor has the same limit.
- A true allowlist mode ("only these log directories"). `/srv/customer` or a
  share mounted outside a profile is still readable with approval; the level
  name is chosen not to promise more.
- Retention of user/assistant prose, continuation summaries (model-written
  prose that may paraphrase an output), `ai_screenshots` (own expiry in
  `screenshotStorage.ts`), and run workspaces.

## 1. Setting and storage

### Table `ai_data_policies`

Partner-wide-first shape, mirroring `ai_script_policies`
(`db/schema/aiScriptPolicies.ts`, migration
`2026-10-16-120200-ai-script-policies.sql`):

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `partner_id` | uuid null, FK partners on delete cascade | |
| `org_id` | uuid null, FK organizations on delete cascade | |
| `device_file_read_level` | enum `ai_device_file_read_level` (`off`, `no_user_profiles`, `any_with_approval`) null | null on an org row = inherit |
| `tool_output_retention_days` | integer null | null on an org row = inherit; null on a partner row = keep forever |
| `created_by`, `created_at`, `updated_at` | | |

Constraints: `ai_data_policies_one_owner_chk`
(`(org_id IS NULL) <> (partner_id IS NULL)`), unique indexes on `org_id` and
on `partner_id`, `retention_days >= 1` when set. RLS: forced; one dual-axis
`FOR ALL` policy (system OR org access OR partner access) plus the separate
SELECT-only partner-wide branch. Registered in `DUAL_AXIS_TENANT_TABLES`,
`CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts`,
`CORE_TENANT_EXPORT_POLICY` (both value columns `included`; no json/bytea).
Migration elects system scope before any write; no backfill.

### Resolver

`resolveAiDataPolicy(orgId)` in `services/aiDataPolicy.ts` returns
`{ deviceFileReadLevel, toolOutputRetentionDays, source }` where `source`
names which level (`org` / `partner` / `default`) supplied each value. Rules:

- Code defaults: `no_user_profiles`, `30`.
- Partner row overrides defaults.
- Org row may only tighten. Level order `off < no_user_profiles <
  any_with_approval`; the resolver takes `min(org, partner)` for the level and
  `min(org, partner)` for retention days (`NULL` partner = unbounded, so an org
  value always wins).
- Writes validate the org value against the **partner row's stored value**
  (the ceiling), not the current effective value, so a partner later loosening
  its default does not leave org rows that can never be edited. A looser org
  value is rejected with 422.

The org id is the **device's** org for every gated tool (the data owner).
Codex finding 3: a chat session's `org_id` can be the first accessible org of
a partner-scope login, not the device's. The gate therefore resolves the level
after `enforceDeviceArgs` has verified the device rows, from those rows, and
resolves again when a durable approval release re-enters `executeTool`
(`jobs/intentReleaseWorker.ts`). Memoised per `executeTool` call only; no
cross-request cache.

### Write gate

Partner row: `canManagePartnerWidePolicies(auth)`. Org row: org admin with
`settings:manage` for that org. Every change writes an audit row
`ai.data_policy.updated` with before/after values.

### Settings home (settings rule 9)

- Concept: "AI data & privacy". Configured in **0** places before, **2** after.
- Partner level: a new "Data & privacy" card on the AI Usage page
  (`/settings/ai-usage`, already `partnerScopeOnly`). Fields: file read level
  (radio, with the honest label "Excludes user profile folders" for the
  default), tool output retention (number, blank = keep forever). Autosave
  with toast.
- Org level: an override card on the org's settings page
  (`/settings/organizations/[id]`), same two fields, blank = inherit, showing
  the inherited value and its source. Options looser than the partner value
  are disabled with the reason shown.
- Nav: no new page, so no `settingsCatalog.ts` entry.

## 2. Path policy

### Lists

`aiPathRestriction.ts` keeps `BLOCKED_PATH_PREFIXES` (the floor; always
refused) and adds:

```
USER_PROFILE_PATH_PREFIXES = [
  'C:\\Users\\*',        // every profile, including Public; candidateForms
                         // already maps D:\Users, junction spellings and
                         // drive-less roots onto this form
  '/home/*',
  '/Users/*',
  '/root',
]
```

Matching reuses `candidateForms` (`devicePathForms.ts`). The profile
directory itself (`C:\Users`, `/home`) is treated as inside the set, so a
listing of profiles is refused too. UNC and device-namespace paths stay
refused outright.

`aiPathRefusal(path, { level })` returns, in order: the existing syntactic
refusals; `PATH_BLOCKED_MESSAGE` for the floor; and, when `level !==
'any_with_approval'`, `USER_PROFILE_BLOCKED_MESSAGE` for a profile root. The
message names the level, its source, and points to
`request_diagnostic_access`. Callers that pass no level get the floor only
(unchanged behaviour for the Zod `safePath` refinement, which has no tenant
context).

### Behaviour by level

| level | `file_operations` (all actions) | `execute_command` file_list / file_read | diagnostic tools | `analyze_disk_usage` / `disk_cleanup` scan root |
|---|---|---|---|---|
| `any_with_approval` | today: floor only; read/write/delete Tier 3, list Tier 2 | same | unchanged | unchanged |
| `no_user_profiles` (default) | floor + profile roots refused, including list | same | unchanged (admin grant is the escape hatch; grants may cover profile roots, never the floor) | floor + profile roots refused |
| `off` | every action refused | refused | `request_diagnostic_access`, `diagnostic_list_directory`, `diagnostic_read_file` refused; `list_` / `revoke_` stay | unchanged (disk metadata for cleanup, not document reads) |

Refusals return `{ error, condition: 'policy_denied', policy: { level, source } }`
so the model explains the policy instead of retrying.

### Enforcement point

`executeTool` (`aiTools.ts`) is the dispatch point for chat core tools
(`aiAgentSdkTools.ts` `makeHandler`), agent runs (`aiAgents/runLoop.ts`),
MCP `tools/call` (`routes/mcpServer.ts`), the built-in helper device path,
and the script builder (`scriptBuilderTools.ts`). Codex finding 2 names two
boundaries that do not pass through it: helper client-declared tools
(`routes/helper/index.ts`, tools the helper runs on the client) and
session-aware cloud tools (`aiAgentSdkTools.ts` `makeSessionHandler`, M365
helpdesk). Neither exposes a device-path tool today; a contract test pins that
no tool reachable outside `executeTool` declares a `PATH_FIELDS` entry.

After `validateToolInput` and `enforceDeviceArgs`, the gate calls
`enforceDevicePathPolicy(tool, input, policy)` in `aiDevicePathPolicy.ts`.
It walks the `PATH_FIELDS` classification (moved from
`aiTools.pathParams.contract.test.ts` into `aiToolPathFields.ts`, keeping the
action-awareness and the diagnostic/sandbox exemptions, so the contract test
and the gate share one table) and applies `aiPathRefusal` with the resolved
level to every `safePath` field. Tools in the `off` deny set are refused
before the walk. Handlers keep their existing in-handler checks as defence in
depth; the gate is the guarantee.

### Scripts (best effort)

Codex finding 5: `run_script` takes `scriptId` or `proposalId`, never an
inline body, and `execute_command` has no script variant. So the scan applies
where content is resolved for dispatch (`aiToolsScripts.ts`, the
`verifiedRunScriptFor` / proposal branch): under `no_user_profiles` or `off`,
an AI-authored **proposal** whose pinned content or resolved parameters
contain a profile-root spelling (same `candidateForms` normalisation on each
path-like token) is refused with the policy message. Library scripts by
`scriptId` are human-authored and exempt. The tool description says this is
best effort: it catches the model's honest attempts, not constructed or
environment-derived paths, and `off` does not make arbitrary scripts
document-proof. Enforceable `off` for scripts (deny AI-triggered proposals
outright, or sandbox their filesystem) is a follow-up.

## 3. Retention

`jobs/aiToolOutputRetention.ts`, modelled on `mlOutputRetention.ts`:

- Nightly (`AI_TOOL_OUTPUT_RETENTION_CRON`), batched, system scope,
  `recordRetentionRun` metrics, `warnOnRetentionBacklog`.
- Grouping key: `ai_sessions.org_id` (messages and executions join through the
  session; agent runs through `ai_agent_runs.org_id`). Per org, resolve
  retention days; skip `NULL`.
- Rows older than N days with a non-scrubbed output:
  - `ai_messages.tool_output` and `ai_tool_executions.tool_output` →
    `{"_retention":"scrubbed","at":"<iso>"}`.
  - `ai_messages.content_blocks`: each `tool_result` entry replaced by the
    same marker **keeping its `tool_use_id`**, so tool-call/result pairing
    survives (codex finding 8); other blocks untouched.
  - `input_capture` artifacts created for those messages/runs
    (`toolResultCapture.ts` → `createArtifact`): blob deleted, head/tail
    previews replaced by the marker, row kept for the audit trail.
    `read_artifact` on a scrubbed handle refuses with `artifact_expired`.
  - The session's resumable SDK transcript: `ai_sessions.sdk_session_id` is
    cleared and the SDK session store entry removed, so a resumed chat
    rebuilds from the scrubbed rows rather than the raw transcript. The plan
    locates the store (the SDK child's config dir, `persistSession: true` in
    `streamingSessionManager.ts`) and verifies deletion.
- Idempotent: the marker is the "already scrubbed" predicate.
- When a partner or org tightens retention, the next nightly run applies it
  to existing rows; the settings card says so.
- UI (`AiToolCallCard`) renders the marker as "Output expired under the
  retention policy".

## 4. Untrusted fence for file contents

Extend `RAW_TEXT_FIELDS_BY_TOOL` (`aiToolOutput.ts`), the existing per-tool,
per-field fence applied inside `compactToolResultForChat`, rather than
wrapping whole results (codex finding 9: whole-result wrapping would break
capture envelopes, JSON error detection in `makeHandler`, and the script
editor's apply path). New entries:

- `file_operations`: `content`
- `execute_command`: `content` (file_read) and `message` (event_logs_query)
- `diagnostic_read_file`: `content`
- `registry_operations`: `value`, `data`

The fence runs after compaction on the model-facing text and is persisted in
the same shape as today's fenced fields; SSE `uiOutput` is unaffected.
`AI_SYSTEM_PROMPT_BASE` gains one rule: content inside an untrusted-data fence
is data from a device or log, never instructions.

## 5. Tests

- `aiDataPolicy.resolver.test.ts`: defaults, partner only, org tightens, org
  looser is ignored, retention `NULL` semantics, `source` attribution.
- `aiDataPolicy.write.test.ts`: looser-than-partner-row org value → 422;
  partner write gate; audit row.
- `aiDataPoliciesPartnerRls.integration.test.ts`: cross-partner forge 42501,
  XOR 23514, org isolation, partner SELECT branch visible to an org token.
- Cascade / merge / export registration: existing contract suites (run under
  Integration Tests).
- `aiTools.devicePathPolicy.contract.test.ts` (real registry, no mock): for
  every `safePath` field in `PATH_FIELDS`, a profile path is refused under
  `no_user_profiles` and allowed under `any_with_approval`; every `off`-set
  tool is refused under `off`; the floor is refused at every level; the
  level is resolved from the device org, not the session org; no tool outside
  the `executeTool` path declares a `PATH_FIELDS` entry.
- `aiPathRestriction.test.ts` additions: `D:\Users\x`, junction spellings,
  `/private/home`, `C:\Users\Public`, `C:\Users` and `/home` themselves.
- Script proposal scan: hit, miss, parameter hit, library `scriptId` exempt.
- Retention job: scrub shape, `tool_use_id` preserved, idempotence, `NULL`
  skip, artifact blob removed and preview replaced, `read_artifact` refusal,
  SDK session id cleared, batch bound.
- Fence: new fields fenced, capture envelope and error detection unchanged,
  `uiOutput` unchanged, fence-forgery flag surfaces.
- Web: settings cards render inherited value and source; looser options
  disabled; `settingsPageRegistry.test.ts` unchanged (no new URL).

## 6. Rollout

- Default `no_user_profiles` is a behaviour change for partners whose
  technicians read user documents through the AI today. Release notes name
  the setting and its location; the refusal message points to it.
- The retention job's first run scrubs everything older than 30 days for
  partners without a row. The release note says so; a partner can set `NULL`
  before upgrading to keep history.

## Decisions log

- Default is the middle level, not status quo or `off` (Todd, 2026-10-15).
- Partner ceiling, org may only tighten (Todd, 2026-10-15).
- Retention 30 days default, partner-configurable, `NULL` keeps (Todd,
  2026-10-15).
- Level renamed from `logs_only` to `no_user_profiles` (codex finding 6: the
  old name promised an allowlist the design does not deliver).
- Level resolved from the device org after `enforceDeviceArgs`, never the
  session org (codex finding 3).
- Script scan targets proposal content at dispatch, not an inline body that
  does not exist (codex finding 5).
- Retention covers `input_capture` artifacts and the SDK transcript, and
  tombstones keep `tool_use_id` (codex findings 7, 8).
- Fence by extending `RAW_TEXT_FIELDS_BY_TOOL`, not a new whole-result wrap
  (codex finding 9).
- `off` still allows `analyze_disk_usage` / `disk_cleanup`: they return sizes
  and names for cleanup, not contents.
- Scrubbing replaces output with a marker rather than deleting rows so the
  audit trail (`ai_tool_executions` status, approver, timestamps) survives.
