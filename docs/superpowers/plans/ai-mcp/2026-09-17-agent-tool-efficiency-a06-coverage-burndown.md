---
tracking_issue: LanternOps/breeze#6147
wave_issue: LanternOps/breeze#6153
branch: feature/6147-agent-tool-efficiency/wave-6153
---
# Agent tool efficiency A-W06: agent-first coverage burn-down + `MCP_COVERAGE` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The reads in-product agents hit and cannot make today exist as tools — time entries (#6139), organization contacts, incidents list, discovered network assets, remediation suggestions, AI-agent reads, sites — each with domain + hint (A-W02), the same permission/org/site checks as its REST route, and a row in the route-binding contract; and a new `MCP_COVERAGE` registry + Test API contract makes "route shipped, tool didn't" a CI failure from now on, with today's known gaps frozen shrink-only.

**Architecture:** Thirteen Tier-1 read tools added to the existing per-domain `aiTools*.ts` files (time entries → `aiToolsTicketing.ts`, contacts/sites → `aiToolsOrgs.ts`, incidents → `aiToolsIncident.ts`, network assets → `aiToolsNetwork.ts`, remediation → new `aiToolsRemediation.ts`, AI-agent reads → `aiToolsAiAgentGovernance.ts`). Handlers call the same service functions the routes call where those take raw ids (`listTimeEntries`, `getRunningTimer`, `getTimesheet`, `listContacts`/`countContacts`, `listAgents`, `ensureOrgAccess`) and re-express the route's org/site guards against `AuthContext` (`auth.canAccessOrg`, `auth.accessibleOrgIds`, `auth.allowedSiteIds`, `siteScopeCondition`, `deviceSiteDenied`) where the route reads a Hono context. Every result is a **safe projection** (named scalar columns; never `timeline`, `evidence`, `parameters`, `outcome`, `snmpData`). `MCP_COVERAGE` (`services/mcpCoverage.ts`) maps every route module under `src/routes/**` to `{ tools }`, `{ exempt, reason }` or `{ gap: '<issue>' }`; the contract test enumerates modules from the filesystem, so a new file with no entry fails, and the `gap` set is frozen shrink-only.

**Tech Stack:** TypeScript, Drizzle, Zod, Vitest (Drizzle mock patterns per the `breeze-testing` skill), the A-W02 registry fields.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-17-agent-tool-efficiency-and-mcp-modernization-design.md` — "Feature A → A-W06", Principles 4, 5, 6; issues #6139, #6141 (P1 table, "Proposed fix" 1–3). Plan index decision D9.

**Tracking:** `get_feature_status LanternOps/breeze#6147`; `start_wave` on #6153; PR `Closes #6153`, and the PR body says `Fixes #6139`. **Depends on A-W02 (#6149) merged** (every new tool needs `domain` + `searchHint`; `CAPABILITY_DOMAINS` may need widening).

**Verified against `origin/main` `5f20013cb`** (2026-09-17). Route handler internals below are from that commit.

---

## Global Constraints

- **Commands.** `cd apps/api && npx vitest run <path>`; typecheck `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`; `pnpm lint`. **After every tool, run the registry contract bundle:**
  ```bash
  cd apps/api && npx vitest run src/services/aiToolsRegistryParity.test.ts src/services/aiTools.domainMetadata.contract.test.ts src/services/aiTools.deviceArgsCoverage.contract.test.ts src/services/aiToolsSiteScope.contract.test.ts src/services/aiGuardrails.routeBinding.contract.test.ts src/services/aiAgentSdkTools.registryParity.contract.test.ts src/services/aiAgentSdkTools.handlerCoverage.contract.test.ts src/services/aiAgentSdkTools.mcpCoverage.test.ts src/services/aiAgents/agentToolCatalog.contract.test.ts src/services/aiAgents/agentToolCatalog.domainRelation.contract.test.ts
  ```
  **Before the PR: `cd apps/api && npx vitest run`.**
- **Six registrations per tool, none optional** (each has a contract test that fails on omission): the `AiTool` registration (with `domain`, `searchHint`, `tier: 1`, `deviceArgs` when a `deviceId` input exists), `TOOL_PERMISSIONS` (`aiGuardrails.ts:716`, copy the route's permission constant — never guess), `toolInputSchemas` (`aiToolSchemas.ts:100`, keys mirror the advertised schema exactly; unknown keys are stripped, #2814), `TOOL_TIERS` (`aiAgentSdkTools.ts:163`) **and** a `tool()` declaration in `buildBreezeSdkTools` (`BREEZE_MCP_TOOL_NAMES` derives from `TOOL_TIERS`, so a tier without a declaration silently allowlists nothing — #2605), `TOOL_CAPABILITY` (`aiAgents/agentToolCatalog.ts:69`), and a row in `aiGuardrails.routeBinding.contract.test.ts` (`:223+`, shape at `:226`).
- **Tool never weaker than its route** (#6096/#6110): same permission, same org axis, same site axis. A tool may be *stricter*; when it is, the routeBinding row declares it under `toolOnly.extra` with a reason.
- **Fail-closed on the partner axis.** Every service that takes `accessibleOrgIds: string[] | null` treats `null` as *unrestricted* (`timeEntryService.ts:1051+`). Pass `null` only for `auth.scope === 'system'`; a partner token passes `auth.accessibleOrgIds ?? []` — an empty array, never null.
- **Site scope:** `siteScopeCondition(auth, col)` (`aiToolsSiteScope.ts:73`) emits `inArray(col, [])` for an empty allowlist — short-circuit `auth.allowedSiteIds?.length === 0` to an empty result explicitly, as every route does. The site-scope contract (`aiToolsSiteScope.contract.test.ts`) requires one of its `SITE_AXIS_MARKERS` (`allowedSiteIds`, `siteScopeCondition`, `deviceSiteDenied`, `deviceIdSiteDenied`, `resolveSiteAllowedDeviceIds`, …) to appear textually in a handler that takes an optional `siteId`/`deviceId` or touches a site-attributable table.
- **Safe projection is mandatory.** `list_organizations`'s `SAFE_ORG_PROJECTION` comment (`aiToolsOrgs.ts:187-188`) is the standing rule: an unprojected `db.select()` leaks open containers into model context. Never return `incidents.timeline`, `remediation_suggestions.evidence/parameters`, `ai_agent_runs.outcome` (use `buildRunTrace`), `discovered_assets.snmpData`, `sites.settings`-style columns.
- **Never rename or remove anything.** New names only; `manage_tickets`'s `log_time_entry`/`start_timer`/`stop_timer` stay.
- **`quick_support` orgs are hidden by design** (`list_organizations`: `ne(organizations.type, 'quick_support')`; `GET /orgs/sites` uses a correlated `NOT EXISTS`). `list_sites` must exclude them.
- **Helpers are module-private and duplicated per file** (`jsonError`, `partnerScopeRefusal`, `toToolError`, `optionalString`). Reuse the file's own copy; add a private one only if the file has none. Extracting a shared module is not this wave.
- **Commit after every task.** Trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  ```

---

## File Structure

| Path | Responsibility |
|---|---|
| `apps/api/src/services/aiToolsTicketing.ts` (+ `aiToolsTicketing.timeEntries.test.ts`) | `list_time_entries`, `get_running_timer`, `get_timesheet` (Task 1). |
| `apps/api/src/services/aiToolsOrgs.ts` (+ `aiToolsOrgs.contacts.test.ts`, `aiToolsOrgs.sites.test.ts`) | `list_org_contacts` (Task 2); `list_sites`, `get_site` (Task 6). |
| `apps/api/src/services/aiToolsIncident.ts` (+ `aiToolsIncident.list.test.ts`) | `list_incidents` (Task 3). |
| `apps/api/src/services/aiToolsNetwork.ts` (+ `aiToolsNetwork.assets.test.ts`) | `list_network_assets`, `get_network_asset` (Task 4). |
| `apps/api/src/services/aiToolsRemediation.ts` (+ `.test.ts`), `aiTools.ts` registration | `list_remediation_suggestions` (Task 5). |
| `apps/api/src/services/aiToolsAiAgentGovernance.ts` (+ `aiToolsAiAgentGovernance.reads.test.ts`) | `list_ai_agents`, `list_ai_agent_runs`, `get_ai_agent_run` (Task 7). |
| `aiGuardrails.ts`, `aiToolSchemas.ts`, `aiAgentSdkTools.ts`, `aiAgents/agentToolCatalog.ts`, `aiGuardrails.routeBinding.contract.test.ts` | Per-tool registrations (every task). |
| `apps/api/src/services/mcpCoverage.ts`, `apps/api/src/__tests__/mcp-coverage.test.ts` | The registry + contract (Task 8). |

---

## Tool contract table (the whole wave at a glance)

| Tool | Domain / capability | Permission (route constant) | Mirrors | Org axis | Site axis | Inputs |
|---|---|---|---|---|---|---|
| `list_time_entries` | tickets / tickets | `TIME_ENTRIES_READ` (`time_entries:read`) | `timeEntries/timeEntries.ts:195` `GET /` | partner/system only; explicit `orgId` → `auth.canAccessOrg`; `accessibleOrgIds` threaded | none (table has no site axis) | `orgId? ticketId? userId? from? to? running? billingStatus? approved? limit≤200=50 offset=0` |
| `get_running_timer` | tickets / tickets | `TIME_ENTRIES_READ` | `:144` `GET /running` | caller's own user | none | — |
| `get_timesheet` | tickets / tickets | `TIME_ENTRIES_READ` | `:184` `GET /timesheet` | other user only when `manageAll` | none | `weekStart userId?` |
| `list_org_contacts` | accounts / tenancy | `ORGS_READ` (`organizations:read`) | `orgContacts.ts:249` | `orgId` required; `auth.canAccessOrg` | `allowedSiteIds` narrowing; explicit `siteId` checked | `orgId siteId?('none'|uuid) role? limit≤100=25 offset=0` |
| `list_incidents` | monitoring / alerts_monitoring | `ALERTS_READ` (`alerts:read`) | `incidents.ts:168` | `auth.orgCondition` (+ explicit `orgId` guard) | none (route has none) | `orgId? status? severity? classification? assignedTo? startDate? endDate? limit≤100=25 offset=0` |
| `list_network_assets` | network / network | `DEVICES_READ` | `discovery.ts:1064` | `resolveOrgId` semantics | `siteScopeCondition` in SQL, empty short-circuit | `orgId? siteId? approvalStatus? assetType? linkedDeviceId? limit≤200=50` |
| `get_network_asset` | network / network | `DEVICES_READ` | `discovery.ts:1184` | asset's org must be accessible | post-fetch `deviceSiteDenied(auth, row.siteId)` | `assetId` |
| `list_remediation_suggestions` | monitoring / alerts_monitoring | `DEVICES_READ` | `remediationSuggestions.ts:417` | `auth.orgCondition` (+ explicit `orgId` guard the route lacks — stricter) | post-fetch device site filter | `orgId? sourceType? sourceId? deviceId? status='all' limit≤100=25` (`deviceArgs: ['deviceId']`) |
| `list_ai_agents` | ai / (same as `manage_ai_agents`) | `AI_AGENTS_READ` (`ai_agents:read`) | `aiAgents.ts:442` | `listAgents(auth)` (partner-wide rows only for partner scope) | none | `includeDisabled?` |
| `list_ai_agent_runs` | ai / (same) | `AI_AGENTS_READ` | `aiAgents.ts:1202` | `auth.orgCondition` + explicit `orgId` guard | `runSiteScopeCondition(auth)` | `agentId? status? orgId? limit≤50=25` |
| `get_ai_agent_run` | ai / (same) | `AI_AGENTS_READ` | `aiAgents.ts:1344` | `auth.orgCondition` | `runSiteScopeCondition(auth)` | `runId` |
| `list_sites` | accounts / tenancy | `SITES_READ` (`sites:read`) | `orgs.ts:2515` | explicit `orgId` → `ensureOrgAccess`; else scope-based | `siteScopeCondition(auth, sites.id)`, empty short-circuit | `orgId? search? limit≤100=25 offset=0` |
| `get_site` | accounts / tenancy | `SITES_READ` | `orgs.ts:2724` | `ensureOrgAccess(site.orgId)` | `auth.allowedSiteIds` check | `siteId` |

All Tier 1. Hints (≤ 120 chars, A-W02 rules): e.g. `list_time_entries`: "logged time, time entries, timesheet hours by ticket, user or customer; billable/unbilled"; `list_sites`: "sites, locations, offices of a customer organization with device counts".

---

### Task 1: Time entries — `list_time_entries`, `get_running_timer`, `get_timesheet` (#6139)

**Files:**
- Modify: `apps/api/src/services/aiToolsTicketing.ts` (register three tools next to `manage_tickets`)
- Create: `apps/api/src/services/aiToolsTicketing.timeEntries.test.ts`
- Modify: `aiGuardrails.ts` (`TOOL_PERMISSIONS`), `aiToolSchemas.ts`, `aiAgentSdkTools.ts` (`TOOL_TIERS` + three `tool()`), `aiAgents/agentToolCatalog.ts`, `aiGuardrails.routeBinding.contract.test.ts`

**Interfaces consumed** (verbatim from `services/timeEntryService.ts`): `listTimeEntries(filters: ListTimeEntriesFilters): Promise<{ entries: TimeEntryRow[]; total: number }>` (`:1125`; filters `:1051` — `userId?, ticketId?, orgId?, accessibleOrgIds?: string[] | null, from?, to?, running?, billingStatus?, approved?, limit, offset`); `getRunningTimer(userId: string)` (`:1145`); `getTimesheet(userId: string, weekStart: Date, accessibleOrgIds: string[] | null = null)` (`:1168`). Row columns = `entrySelection()` (`:1074-1101`): `id, partnerId, orgId, ticketId, userId, startedAt, endedAt, durationMinutes, description, isBillable, hourlyRate, currencyCode, billingStatus, source, isApproved, approvedBy, approvedAt, createdAt, ticketNumber, ticketSubject, userName` — all scalars, safe to return.

- [ ] **Step 1: Write the failing tests**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const svc = vi.hoisted(() => ({ listTimeEntries: vi.fn(), getRunningTimer: vi.fn(), getTimesheet: vi.fn() }));
vi.mock('./timeEntryService', () => svc);

import { aiTools } from './aiToolNames';
import './aiTools';

const UUID = '11111111-1111-4111-8111-111111111111';
const partnerAuth = (over: Record<string, unknown> = {}) => ({
  scope: 'partner', partnerId: 'p1', orgId: null, accessibleOrgIds: ['o1', 'o2'],
  canAccessOrg: (id: string) => ['o1', 'o2'].includes(id),
  user: { id: 'u1', isPlatformAdmin: false }, ...over,
}) as never;

beforeEach(() => { svc.listTimeEntries.mockReset(); svc.getRunningTimer.mockReset(); svc.getTimesheet.mockReset(); });

describe('list_time_entries', () => {
  const tool = aiTools.get('list_time_entries')!;
  it('is registered as a Tier-1 tickets-domain read', () => {
    expect(tool.tier).toBe(1); expect(tool.domain).toBe('tickets'); expect(tool.searchHint.length).toBeLessThanOrEqual(120);
  });
  it('refuses organization-scoped callers exactly like the route (partner/system only)', async () => {
    const out = JSON.parse(await tool.handler({}, partnerAuth({ scope: 'organization', orgId: 'o1' })));
    expect(out).toMatchObject({ error: expect.any(String), code: 'PARTNER_SCOPE_REQUIRED' });
    expect(svc.listTimeEntries).not.toHaveBeenCalled();
  });
  it('denies an orgId outside the accessible set', async () => {
    const out = JSON.parse(await tool.handler({ orgId: 'o9' }, partnerAuth()));
    expect(out.error).toMatch(/organization/i);
    expect(svc.listTimeEntries).not.toHaveBeenCalled();
  });
  it('pins userId to the caller unless the caller manages all, threads accessibleOrgIds (never null for partner), clamps limit', async () => {
    svc.listTimeEntries.mockResolvedValue({ entries: [{ id: 'e1', durationMinutes: 30 }], total: 1 });
    const out = JSON.parse(await tool.handler({ userId: 'someone-else', limit: 999, running: true }, partnerAuth()));
    expect(svc.listTimeEntries).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', accessibleOrgIds: ['o1', 'o2'], limit: 200, offset: 0, running: true }));
    expect(out).toEqual({ entries: [{ id: 'e1', durationMinutes: 30 }], total: 1, limit: 200, offset: 0 });
  });
  it('lets a platform admin filter by another user, and system scope passes null accessibleOrgIds', async () => {
    svc.listTimeEntries.mockResolvedValue({ entries: [], total: 0 });
    await tool.handler({ userId: 'u2' }, partnerAuth({ scope: 'system', user: { id: 'u1', isPlatformAdmin: true } }));
    expect(svc.listTimeEntries).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u2', accessibleOrgIds: null }));
  });
});

describe('get_running_timer', () => {
  const tool = aiTools.get('get_running_timer')!;
  it('returns the caller\'s running entry or null', async () => {
    svc.getRunningTimer.mockResolvedValue({ id: 'e1', startedAt: '2026-09-17T10:00:00Z' });
    expect(JSON.parse(await tool.handler({}, partnerAuth()))).toEqual({ running: { id: 'e1', startedAt: '2026-09-17T10:00:00Z' } });
    expect(svc.getRunningTimer).toHaveBeenCalledWith('u1');
  });
  it('needs a user principal', async () => {
    expect(JSON.parse(await tool.handler({}, partnerAuth({ user: undefined }))).error).toMatch(/user/i);
  });
});

describe('get_timesheet', () => {
  const tool = aiTools.get('get_timesheet')!;
  it('rejects another user\'s timesheet for a non-admin, exactly like the route', async () => {
    expect(JSON.parse(await tool.handler({ weekStart: '2026-09-14', userId: 'u2' }, partnerAuth())).error).toMatch(/admin/i);
    expect(svc.getTimesheet).not.toHaveBeenCalled();
  });
  it('returns the timesheet for a valid week', async () => {
    svc.getTimesheet.mockResolvedValue({ weekStart: '2026-09-14', days: [], totals: { totalMinutes: 0, billableMinutes: 0, billableAmounts: [] } });
    const out = JSON.parse(await tool.handler({ weekStart: '2026-09-14' }, partnerAuth()));
    expect(svc.getTimesheet).toHaveBeenCalledWith('u1', new Date('2026-09-14'), ['o1', 'o2']);
    expect(out.timesheet.totals.totalMinutes).toBe(0);
  });
  it('rejects an unparseable weekStart', async () => {
    expect(JSON.parse(await tool.handler({ weekStart: 'next monday' }, partnerAuth())).error).toMatch(/weekStart/);
  });
});
```

Run: `cd apps/api && npx vitest run src/services/aiToolsTicketing.timeEntries.test.ts` → FAIL (tools undefined).

- [ ] **Step 2: Implement** in `aiToolsTicketing.ts` (use the file's existing `registerTool`/`aiTools.set` idiom and its private `jsonError`; add one if it has none):

```ts
import { getRunningTimer, getTimesheet, listTimeEntries } from './timeEntryService';

const TIME_BILLING_STATUSES = ['unbilled', 'billed', 'non_billable'] as const;   // ← copy the exact values from packages/shared/src/validators/timeEntries.ts billingStatusSchema

function timeScopeRefusal(auth: AuthContext): string | null {
  // GET /time-entries is requireScope('partner','system') (timeEntries.ts:23) — no org axis on time_entries (spec D4).
  return auth.scope === 'partner' || auth.scope === 'system' ? null
    : JSON.stringify({ error: 'Time entries are readable with a partner or system token only', code: 'PARTNER_SCOPE_REQUIRED' });
}
/** Route parity: timeActorFrom() — platform admin or a *:* grant. The tool cannot see the permissions object, so it honours platform admin + system scope only (stricter; declared in the routeBinding row). */
const managesAllTime = (auth: AuthContext) => auth.scope === 'system' || auth.user?.isPlatformAdmin === true;
const orgAllowlist = (auth: AuthContext): string[] | null => (auth.scope === 'system' ? null : (auth.accessibleOrgIds ?? []));

registerTool({
  tier: 1 as AiToolTier,
  domain: 'tickets',
  searchHint: 'logged time, time entries, timesheet hours by ticket, user or customer; billable vs unbilled',
  deviceArgs: [],
  definition: {
    name: 'list_time_entries',
    description: 'List time entries (logged work) with ticket, user, duration, billable flag and billing status. Filters: ticket, user, organization, date range, running, approval. Read-back for manage_tickets log_time_entry/start_timer/stop_timer.',
    input_schema: {
      type: 'object' as const,
      properties: {
        orgId: { type: 'string', description: 'Organization UUID' },
        ticketId: { type: 'string', description: 'Ticket UUID' },
        userId: { type: 'string', description: 'User UUID (admins only; others always see their own)' },
        from: { type: 'string', description: 'ISO-8601 start (inclusive)' },
        to: { type: 'string', description: 'ISO-8601 end (inclusive)' },
        running: { type: 'boolean', description: 'Only entries with no end time' },
        billingStatus: { type: 'string', enum: [...TIME_BILLING_STATUSES] },
        approved: { type: 'boolean' },
        limit: { type: 'number', description: 'Max rows (default 50, max 200)' },
        offset: { type: 'number', description: 'Rows to skip (default 0)' },
      },
      required: [],
    },
  },
  handler: async (input, auth) => {
    const refusal = timeScopeRefusal(auth); if (refusal) return refusal;
    const orgId = typeof input.orgId === 'string' ? input.orgId : undefined;
    if (orgId && !auth.canAccessOrg(orgId)) return jsonError('Access to this organization denied');
    const limit = Math.min(Math.max(1, Number(input.limit) || 50), 200);
    const offset = Math.max(0, Number(input.offset) || 0);
    const parseDate = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v) : undefined);
    try {
      const { entries, total } = await listTimeEntries({
        userId: managesAllTime(auth) ? (typeof input.userId === 'string' ? input.userId : undefined) : auth.user?.id,
        ticketId: typeof input.ticketId === 'string' ? input.ticketId : undefined,
        orgId,
        accessibleOrgIds: orgAllowlist(auth),
        from: parseDate(input.from), to: parseDate(input.to),
        running: typeof input.running === 'boolean' ? input.running : undefined,
        billingStatus: TIME_BILLING_STATUSES.includes(input.billingStatus as never) ? (input.billingStatus as (typeof TIME_BILLING_STATUSES)[number]) : undefined,
        approved: typeof input.approved === 'boolean' ? input.approved : undefined,
        limit, offset,
      });
      return JSON.stringify({ entries, total, limit, offset });
    } catch (err) { console.error('[list_time_entries]', err); return jsonError('Operation failed. Check server logs for details.'); }
  },
});

registerTool({
  tier: 1 as AiToolTier, domain: 'tickets', searchHint: 'is my timer running, current running time entry, what am I clocked on', deviceArgs: [],
  definition: { name: 'get_running_timer', description: 'Return the caller\'s currently running time entry (started, no end time), or null. Read-back for manage_tickets start_timer.', input_schema: { type: 'object' as const, properties: {}, required: [] } },
  handler: async (_input, auth) => {
    const refusal = timeScopeRefusal(auth); if (refusal) return refusal;
    if (!auth.user?.id) return jsonError('get_running_timer requires a user session');
    try { return JSON.stringify({ running: (await getRunningTimer(auth.user.id)) ?? null }); }
    catch (err) { console.error('[get_running_timer]', err); return jsonError('Operation failed. Check server logs for details.'); }
  },
});

registerTool({
  tier: 1 as AiToolTier, domain: 'tickets', searchHint: 'weekly timesheet, hours per day this week, billable totals for a technician', deviceArgs: [],
  definition: {
    name: 'get_timesheet',
    description: 'Weekly timesheet for one user: per-day entries and totals (total minutes, billable minutes, billable amounts by currency). Other users\' sheets need an admin.',
    input_schema: { type: 'object' as const, properties: { weekStart: { type: 'string', description: 'ISO date of the week start (e.g. 2026-09-14)' }, userId: { type: 'string', description: 'User UUID (admins only)' } }, required: ['weekStart'] },
  },
  handler: async (input, auth) => {
    const refusal = timeScopeRefusal(auth); if (refusal) return refusal;
    if (!auth.user?.id) return jsonError('get_timesheet requires a user session');
    const weekStart = typeof input.weekStart === 'string' ? new Date(input.weekStart) : new Date(NaN);
    if (Number.isNaN(weekStart.getTime())) return jsonError('weekStart must be an ISO-8601 date');
    const target = typeof input.userId === 'string' ? input.userId : auth.user.id;
    if (target !== auth.user.id && !managesAllTime(auth)) return jsonError('Viewing other timesheets requires an admin role');
    try { return JSON.stringify({ timesheet: await getTimesheet(target, weekStart, orgAllowlist(auth)) }); }
    catch (err) { console.error('[get_timesheet]', err); return jsonError('Operation failed. Check server logs for details.'); }
  },
});
```

Registrations:
- `aiGuardrails.ts` `TOOL_PERMISSIONS`: `list_time_entries: { resource: 'time_entries', action: 'read' }`, `get_running_timer: …`, `get_timesheet: …` (same).
- `aiToolSchemas.ts`: `list_time_entries: z.object({ orgId: uuid.optional(), ticketId: uuid.optional(), userId: uuid.optional(), from: z.string().optional(), to: z.string().optional(), running: z.boolean().optional(), billingStatus: z.enum([...]).optional(), approved: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional() })`; `get_running_timer: z.object({})`; `get_timesheet: z.object({ weekStart: z.string(), userId: uuid.optional() })`.
- `aiAgentSdkTools.ts`: `TOOL_TIERS` three `: 1` entries; three `tool('<name>', registryDescription('<name>'), <same Zod shape>, makeHandler('<name>', getAuth, onPreToolUse, onPostToolUse))`.
- `agentToolCatalog.ts` `TOOL_CAPABILITY`: all three `'tickets'`.
- `aiGuardrails.routeBinding.contract.test.ts`: 
  ```ts
  { tool: 'list_time_entries', routeFile: 'timeEntries/timeEntries.ts', method: 'get', path: '/' , toolOnly: { extra: [], reason: 'userId narrowing honours platform admin/system only (route also honours a *:* grant) — stricter' } },
  { tool: 'get_running_timer', routeFile: 'timeEntries/timeEntries.ts', method: 'get', path: '/running' },
  { tool: 'get_timesheet', routeFile: 'timeEntries/timeEntries.ts', method: 'get', path: '/timesheet' },
  ```
  (match the row shape the file uses at `:226`; if `toolOnly` is only for extra *permissions*, put the stricter-narrowing note in a comment above the row instead).

- [ ] **Step 3: Verify and commit**

```bash
cd apps/api && npx vitest run src/services/aiToolsTicketing.timeEntries.test.ts && <registry contract bundle>
git add apps/api/src/services && git commit -m "feat(ai): list_time_entries, get_running_timer, get_timesheet — time entries readable (#6139, A-W06)"
```

---

### Task 2: `list_org_contacts`

**Files:** `aiToolsOrgs.ts` (+ `aiToolsOrgs.contacts.test.ts`), registrations as in Task 1.

**Consumed:** `listContacts(exec, orgId, filters: ContactListFilters, page: { limit; offset }): Promise<ContactRecord[]>` (`services/contacts/crud.ts:334`), `countContacts(exec, orgId, filters)` (`:352`); `ContactListFilters` (`services/contacts/types.ts:33-49`: `siteId?: string | 'none'`, `role?`, `allowedSiteIds?: string[]`); `ContactRecord` = `id, orgId, siteId, name, email, phone, mobile, title, roles, isPrimary, notes, createdAt, updatedAt` (`types.ts:93-97`). `db` is the executor.

- [ ] **Step 1: Failing test** (mock `./contacts/crud`): asserts (a) `orgId` missing → error; (b) `auth.canAccessOrg` false → error and no call; (c) explicit `siteId` outside `auth.allowedSiteIds` → error `Access to this site denied`; (d) with `allowedSiteIds: ['s1']` the filters passed contain `allowedSiteIds: ['s1']`; (e) `siteId: 'none'` passes through; (f) output `{ contacts, total, limit, offset }` and `notes` is **omitted** from each contact (free-text internal notes are not for the model); (g) `limit` clamps to 100.

- [ ] **Step 2: Implement** — handler: `orgId` required (UUID regex `PG_UUID_REGEX` as `orgContacts.ts:78` does); `auth.scope !== 'system' && !auth.canAccessOrg(orgId)` → `jsonError('Access to this organization denied')`; `siteId` = `'none'` | uuid; if uuid and `auth.allowedSiteIds && !auth.allowedSiteIds.includes(siteId)` → denied; filters `{ siteId, role, ...(auth.allowedSiteIds ? { allowedSiteIds: auth.allowedSiteIds } : {}) }`; `const [contacts, total] = await Promise.all([listContacts(db, orgId, filters, { limit, offset }), countContacts(db, orgId, filters)])`; strip `notes`; return `{ contacts, total, limit, offset }`. `domain: 'accounts'`, hint "customer contacts, people at an organization, primary contact, email/phone for a site". Permission `organizations:read`. Capability `tenancy`. routeBinding row `{ tool: 'list_org_contacts', routeFile: 'orgContacts.ts', method: 'get', path: '/organizations/:id/contacts' }`.

- [ ] **Step 3: Verify and commit** — `git commit -m "feat(ai): list_org_contacts (A-W06)"`.

---

### Task 3: `list_incidents`

**Files:** `aiToolsIncident.ts` (+ `aiToolsIncident.list.test.ts`), registrations.

**Consumed:** `incidents` table (`db/schema/incidentResponse.ts:51+`, `orgId NOT NULL`); no service function — the route runs inline Drizzle (`incidents.ts:167-249`). The tool does the same with a **projection**.

- [ ] **Step 1: Failing test** (Drizzle mock per `breeze-testing`): (a) explicit `orgId` not accessible → error; (b) query uses `auth.orgCondition(incidents.orgId)` when no `orgId`; (c) status/severity filters are forwarded; (d) the selected columns never include `timeline` — assert on the mocked `select()` argument keys; (e) output `{ incidents, total, limit, offset }`.

- [ ] **Step 2: Implement** — `SAFE_INCIDENT_PROJECTION` = the scalar columns of `incidents` (read the schema at `db/schema/incidentResponse.ts:51+` and take: `id, orgId, title, status, severity, classification, assignedTo, detectedAt, resolvedAt, createdAt, updatedAt` — use the exact exported column names; **exclude** `timeline` and any jsonb). Conditions: `orgId ? (auth.canAccessOrg(orgId) ? eq(incidents.orgId, orgId) : deny) : auth.orgCondition(incidents.orgId)`; optional `status`, `severity`, `classification` (`ilike`), `assignedTo`, `detectedAt >= startDate`, `<= endDate`; `orderBy(desc(incidents.detectedAt), desc(incidents.createdAt), desc(incidents.id))` (the route's order); `limit` ≤ 100 default 25, `offset`; a `count()` query with the same conditions for `total`. `domain: 'monitoring'`, hint "open incidents, incident list by customer, severity, status, assignee; security incident feed". Permission `alerts:read` (the route's `requireIncidentRead`, `incidents.ts:36`). Capability `alerts_monitoring`. routeBinding `{ tool: 'list_incidents', routeFile: 'incidents.ts', method: 'get', path: '/' }`.

- [ ] **Step 3: Verify and commit** — `git commit -m "feat(ai): list_incidents (A-W06)"`.

---

### Task 4: `list_network_assets`, `get_network_asset`

**Files:** `aiToolsNetwork.ts` (+ `aiToolsNetwork.assets.test.ts`), registrations.

**Consumed:** `discoveredAssets` (`db/schema/discovery.ts:143-146`: `orgId NOT NULL`, `siteId NOT NULL`); `siteScopeCondition(auth, col)` (`aiToolsSiteScope.ts:73`), `deviceSiteDenied(auth, siteId, deviceId?)` (`:198`). Route org semantics (`discovery.ts:69` `resolveOrgId`): organization scope → own org; partner with exactly one accessible org → that org; partner with more and no `orgId` → error "orgId is required when partner has multiple organizations"; system with no `orgId` → error; explicit `orgId` → `auth.canAccessOrg`.

- [ ] **Step 1: Failing test**: (a) partner with two orgs and no `orgId` → the "orgId is required" error; (b) partner with one org auto-resolves; (c) `auth.allowedSiteIds: []` → `{ assets: [], showing: 0, note: SITE_SCOPE_EMPTY_NOTE }` with no query; (d) explicit `siteId` outside the allowlist → denied; (e) projection excludes `snmpData` and `openPorts` (assert selected keys); (f) `get_network_asset` returns `error: 'Asset not found'` for an asset in another org **and** for an asset whose site the caller cannot reach (same message, no oracle); (g) `limit` clamps to 200.

- [ ] **Step 2: Implement** — private `resolveAssetOrgId(auth, requested)` copying `discovery.ts:69-101` against `AuthContext`. `SAFE_ASSET_PROJECTION = { id, orgId, siteId, assetType, approvalStatus, hostname, label, ipAddress, macAddress, manufacturer, model, nicVendor, linkedDeviceId, detectedAssetType, isOnline, firstSeenAt, lastSeenAt }` (exact column names from the schema; no `snmpData`, no `openPorts`, no `notes`). List: conditions `eq(orgId)`, optional `approvalStatus`/`assetType`/`linkedDeviceId`, explicit `siteId` (checked against `auth.allowedSiteIds`) else `siteScopeCondition(auth, discoveredAssets.siteId)`; `auth.allowedSiteIds?.length === 0` short-circuit; `orderBy(desc(lastSeenAt))`, `limit` ≤ 200 default 50; return `{ assets, showing }`. Detail: select by `id` with `auth.orgCondition(discoveredAssets.orgId)`; `!row || deviceSiteDenied(auth, row.siteId, row.linkedDeviceId)` → `jsonError('Asset not found')`; return `{ asset }`. Both `domain: 'network'`; hints "discovered network devices, switches, printers, unmanaged assets on a customer LAN, MAC/IP/vendor" and "one discovered network asset by id: model, IP, MAC, linked device, last seen". Permission `devices:read` (`discovery.ts:42`). Capability `network`. routeBinding rows for `/assets` and `/assets/:id` (both `discovery.ts`).

- [ ] **Step 3: Verify and commit** — `git commit -m "feat(ai): list_network_assets, get_network_asset (A-W06)"`.

---

### Task 5: `list_remediation_suggestions`

**Files:** Create `aiToolsRemediation.ts` (+ `.test.ts`), register in `aiTools.ts` (`registerRemediationTools(aiTools)` beside the other `registerXTools` calls `:288-343`), registrations.

**Consumed:** `remediationSuggestions` (`db/schema/remediationSuggestions.ts:25-27`, `orgId NOT NULL`); DTO keys from `serializeSuggestion` (`routes/remediationSuggestions.ts:247-282`). Site helper: `resolveSiteAllowedDeviceIds(auth, deviceIds)` (`aiToolsSiteScope.ts:100` — read its exact signature; it returns the reachable subset) or `deviceIdSiteDenied(auth, deviceId)` (`:217`).

- [ ] **Step 1: Failing test**: (a) explicit `orgId` not accessible → error (stricter than the route, which has no `orgId` param); (b) default `status: 'all'` adds no status condition; `status: 'suggested'` does; (c) rows with a `deviceId` the caller cannot reach are dropped, device-less rows kept — mock the site helper; (d) projection excludes `evidence` and `parameters`; (e) `deviceArgs` includes `'deviceId'`; (f) `limit` clamps to 100.

- [ ] **Step 2: Implement** — `SAFE_SUGGESTION_PROJECTION`: `id, orgId, sourceType, sourceId, deviceId, alertId, anomalyId, correlationGroupId, rcaId, targetType, scriptId, playbookId, title, rationale, expectedAction, riskTier, status, confidence, elevationRequestId, toolExecutionId, scriptExecutionId, playbookExecutionId, failureMessage, createdAt, updatedAt, acceptedAt, rejectedAt, executedAt` (no `evidence`, `parameters`, `targetDeviceIds`). Conditions: `orgId ? (canAccessOrg ? eq : deny) : auth.orgCondition(...)`, optional `sourceType` (enum `alert|anomaly|correlation|rca`), `sourceId`, `deviceId`, `status !== 'all'`; `orderBy(desc(createdAt))`, `limit` ≤ 100 default 25; post-filter: `const reachable = await resolveSiteAllowedDeviceIds(auth, rows.map(r => r.deviceId).filter(Boolean))` then keep `!r.deviceId || reachable.has(r.deviceId)`; return `{ suggestions, showing }`. `deviceArgs: ['deviceId']`, `domain: 'monitoring'`, hint "AI remediation suggestions for alerts and anomalies, proposed fixes, accepted/rejected/executed status". Permission `devices:read` (`remediationSuggestions.ts:420`). Capability `alerts_monitoring`. routeBinding `{ tool: 'list_remediation_suggestions', routeFile: 'remediationSuggestions.ts', method: 'get', path: '/' }`.

- [ ] **Step 3: Verify and commit** — `git commit -m "feat(ai): list_remediation_suggestions (A-W06)"`.

---

### Task 6: `list_sites`, `get_site`

**Files:** `aiToolsOrgs.ts` (+ `aiToolsOrgs.sites.test.ts`), registrations.

**Consumed:** `sites` (`db/schema/orgs.ts:235-248`), `organizations`, `devices`; `ensureOrgAccess(orgId, auth)` (`routes/systemTools/helpers.ts:10`, async, `true` for system); `siteScopeCondition`; the quick-support exclusion.

- [ ] **Step 1: Failing test**: (a) explicit `orgId` failing `ensureOrgAccess` → error; (b) partner without `orgId` → `inArray(sites.orgId, accessibleOrgIds)`, and an empty `accessibleOrgIds` → `{ sites: [], total: 0 }` with no query; (c) `auth.allowedSiteIds: []` → empty with no query; (d) rows carry `deviceCount`; (e) projection has no `settings`-style jsonb (assert keys); (f) `get_site` → `Site not found` for an inaccessible org **or** a site outside the allowlist; (g) `siteId` must be a UUID (the route lacks the check — the tool adds it).

- [ ] **Step 2: Implement** — list conditions exactly as `orgs.ts:2540-2580`: explicit `orgId` → `await ensureOrgAccess(orgId, auth)` else denied, `eq(sites.orgId, orgId)`; else by scope (`organization` → `eq(sites.orgId, auth.orgId)`; `partner` → `inArray(sites.orgId, auth.accessibleOrgIds ?? [])` with empty short-circuit; `system` → none). Exclude quick-support orgs with `notExists(db.select().from(organizations).where(and(eq(organizations.id, sites.orgId), eq(organizations.type, 'quick_support'))))` (or an inner join with `ne(organizations.type, 'quick_support')`, which is what `list_organizations` does). Site narrowing `siteScopeCondition(auth, sites.id)` + empty short-circuit. Optional `search` → `ilike(sites.name, %escapeLike(search)%)`. Projection `{ id, orgId, name, timezone, address?, createdAt }` (named scalars from the schema). `deviceCount` from a grouped `devices` count excluding `isEphemeral` and `status = 'decommissioned'` (mirror `orgs.ts:2590-2620`). Return `{ sites, total, limit, offset }`. Detail: UUID check → select → `ensureOrgAccess(site.orgId, auth)` → `auth.allowedSiteIds && !auth.allowedSiteIds.includes(site.id)` → all failures `jsonError('Site not found')`; return `{ site }`. Both `domain: 'accounts'`; hints "sites, locations, offices of a customer organization with device counts" / "one site by id: name, organization, timezone, device count". Permission `sites:read` (`orgs.ts:105`). Capability `tenancy`. routeBinding rows `orgs.ts` `/sites` and `/sites/:id`.

- [ ] **Step 3: Verify and commit** — `git commit -m "feat(ai): list_sites, get_site (A-W06)"`.

---

### Task 7: AI-agent reads — `list_ai_agents`, `list_ai_agent_runs`, `get_ai_agent_run`

**Files:** `aiToolsAiAgentGovernance.ts` (+ `aiToolsAiAgentGovernance.reads.test.ts`), registrations.

**Consumed:** `listAgents(auth, { includeDisabled? }): Promise<AiAgentRow[]>` (`services/aiAgents/agentService.ts:484` — carries the partner-wide inclusion rule at `:478-482`; **never rebuild that predicate**); `aiAgentRuns` (`db/schema/aiAgents.ts:86`, `orgId NOT NULL`) + `runSiteScopeCondition(auth)` (`services/aiAgentRunSiteScope.ts:18`); `buildRunTrace` (`services/aiAgents/runTrace.ts` — the SAFE outcome projection; read its signature, it is what `GET /runs/:runId` calls at `aiAgents.ts:1344+`).

- [ ] **Step 1: Failing test**: (a) `list_ai_agents` calls `listAgents(auth, { includeDisabled })` and projects `{ id, name, kind, enabled, orgId, partnerId, profile, createdAt }` (take the exact `AiAgentRow` field names) — no `policySnapshot`/jsonb; (b) `list_ai_agent_runs` uses `auth.orgCondition(aiAgentRuns.orgId)` **and** `runSiteScopeCondition(auth)` (mock it and assert it is in the `where`), denies an inaccessible explicit `orgId`, orders by `startedAt desc`, clamps `limit` to 50, projects `{ id, agentId, orgId, status, profile, startedAt, finishedAt, resolvedModel, costCents, runVerdict }` where `runVerdict` is `outcome->>'runVerdict'` only; (c) `get_ai_agent_run` returns `Run not found` for a bad UUID, an inaccessible org, or a site-denied run, and returns `buildRunTrace(...)`'s output as `trace` — never the raw `outcome` (assert the selected keys).

- [ ] **Step 2: Implement** per the assertions. `domain: 'ai'` for all three; hints "AI agents configured for a partner or customer, enabled state, kind, schedule" / "recent AI agent runs, run status, verdicts, cost by agent or customer" / "one AI agent run: trace, findings, tool calls, outcome summary". Permission `ai_agents:read` (`aiAgents.ts:118`). Capability: the one `manage_ai_agents` already has in `TOOL_CAPABILITY` (read it); if `CAPABILITY_DOMAINS` for that capability lacks `'ai'`, widen it with a reason (A-W02 Task 4 rule). routeBinding rows for `aiAgents.ts` `/`, `/runs`, `/runs/:runId`.

- [ ] **Step 3: Verify and commit** — `git commit -m "feat(ai): list_ai_agents, list_ai_agent_runs, get_ai_agent_run (A-W06)"`.

---

### Task 8: `MCP_COVERAGE` registry and contract test

**Files:**
- Create: `apps/api/src/services/mcpCoverage.ts`, `apps/api/src/__tests__/mcp-coverage.test.ts`

**Interfaces produced:**

```ts
export type McpCoverageEntry =
  | { tools: readonly string[] }                       // route module has a tool surface (list every tool that mirrors a route in it)
  | { exempt: McpExemptReason; note?: string }         // no tool surface by design
  | { gap: string };                                   // known missing tool surface, tracked by an issue ref — FROZEN, shrink-only
export type McpExemptReason =
  | 'agent_transport'        // routes/agents/**, device heartbeat/enrolment — the agent talks, no human tool
  | 'identity'               // auth, oauth, sso, passkeys, api keys, service principals, well-known
  | 'platform_admin'         // routes/admin/** — platform-admin only, never tenant-facing
  | 'inbound_integration'    // webhooks, inbound email, vendor callbacks
  | 'portal'                 // customer portal + public share links
  | 'addin_surface'          // routes/clientAi/**, routes/officeAddin/** — their own tool registries
  | 'device_helper'          // routes/helper/**
  | 'mcp_transport'          // mcpServer.ts itself
  | 'internal_plumbing';     // health, metrics, install scripts, downloads, short links
export const MCP_COVERAGE: Readonly<Record<string, McpCoverageEntry>>;   // key = path relative to apps/api/src/routes/, forward slashes
```

- [ ] **Step 1: Write the failing contract test**

```ts
/**
 * #6141 "make it mechanical, like the cascade lists": every route module has an
 * MCP_COVERAGE entry — a tool surface, a design exemption with a reason, or a
 * FROZEN gap entry with an issue ref. A new route file with no entry fails
 * here; a new `gap` entry fails here (gaps may only be burned down).
 * Precedent: __tests__/partner-wide-write-coverage.test.ts (filesystem walk).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import { MCP_COVERAGE } from '../services/mcpCoverage';
import { aiTools } from '../services/aiToolNames';
import '../services/aiTools';
import { getAllRegisteredToolNames } from '../services/aiTools';

const ROUTES_DIR = resolve(__dirname, '../routes');
const ROUTE_REGISTRATION = /\.(get|post|put|patch|delete)\(\s*['"`]/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.includes('__tests__') && ROUTE_REGISTRATION.test(readFileSync(p, 'utf8'))) out.push(relative(ROUTES_DIR, p).split('\\').join('/'));
  }
  return out.sort();
}

/** Gap entries as of this wave. This list only SHRINKS. Adding a route module with no tool means writing the tool or a real exemption. */
const FROZEN_GAPS: ReadonlySet<string> = new Set([
  // filled by Step 2 — every key in MCP_COVERAGE whose entry is { gap }
]);

describe('MCP_COVERAGE (route module → tool surface)', () => {
  const modules = walk(ROUTES_DIR);
  const registered = new Set(getAllRegisteredToolNames());

  it('enumerates a realistic number of route modules', () => { expect(modules.length).toBeGreaterThan(120); });

  it('every route module has an entry', () => {
    expect(modules.filter((m) => !(m in MCP_COVERAGE)), 'route modules with no MCP_COVERAGE entry').toEqual([]);
  });
  it('every entry names an existing route module', () => {
    const set = new Set(modules);
    expect(Object.keys(MCP_COVERAGE).filter((k) => !set.has(k)), 'entries for files that do not exist / register no routes').toEqual([]);
  });
  it('every tool named exists in the registry, and tool entries are non-empty', () => {
    const bad: string[] = [];
    for (const [k, e] of Object.entries(MCP_COVERAGE)) if ('tools' in e) {
      if (e.tools.length === 0) bad.push(`${k}: empty tools[]`);
      for (const t of e.tools) if (!registered.has(t)) bad.push(`${k}: unknown tool ${t}`);
    }
    expect(bad).toEqual([]);
  });
  it('gap entries are frozen: none outside FROZEN_GAPS, and FROZEN_GAPS has no stale entry', () => {
    const gaps = Object.entries(MCP_COVERAGE).filter(([, e]) => 'gap' in e).map(([k]) => k);
    expect(gaps.filter((g) => !FROZEN_GAPS.has(g)), 'new gap entries — write the tool or a real exemption').toEqual([]);
    expect([...FROZEN_GAPS].filter((g) => !gaps.includes(g)), 'burned down — delete from FROZEN_GAPS').toEqual([]);
    for (const [, e] of Object.entries(MCP_COVERAGE)) if ('gap' in e) expect(e.gap).toMatch(/^(LanternOps\/breeze)?#\d+$/);
  });
  it('the A-W06 tools cover their route modules', () => {
    expect((MCP_COVERAGE['timeEntries/timeEntries.ts'] as { tools: string[] }).tools).toEqual(expect.arrayContaining(['list_time_entries', 'get_running_timer', 'get_timesheet']));
    expect((MCP_COVERAGE['orgs.ts'] as { tools: string[] }).tools).toEqual(expect.arrayContaining(['list_organizations', 'manage_organizations', 'list_sites', 'get_site']));
    expect((MCP_COVERAGE['discovery.ts'] as { tools: string[] }).tools).toEqual(expect.arrayContaining(['list_network_assets', 'get_network_asset', 'network_discovery']));
    expect(aiTools.size).toBeGreaterThan(0);
  });
});
```

Run: `cd apps/api && npx vitest run src/__tests__/mcp-coverage.test.ts` → FAIL (module missing).

- [ ] **Step 2: Populate `MCP_COVERAGE`**

Generate the key list once:

```bash
cd apps/api && node -e "
const {readdirSync,readFileSync,statSync}=require('fs');const {join,relative}=require('path');
const R='src/routes';const re=/\.(get|post|put|patch|delete)\(\s*['\"\`]/;const out=[];
(function w(d){for(const n of readdirSync(d)){const p=join(d,n);if(statSync(p).isDirectory())w(p);else if(p.endsWith('.ts')&&!p.endsWith('.test.ts')&&re.test(readFileSync(p,'utf8')))out.push(relative(R,p));}})(R);
console.log(out.sort().join('\n'));" > /tmp/route-modules.txt; wc -l /tmp/route-modules.txt
```

Then write `mcpCoverage.ts` with one entry per line, in this order of preference:

1. **`{ tools }`** — from the routeBinding pair table (`aiGuardrails.routeBinding.contract.test.ts:223+` — every `routeFile` there gets its tools) plus this wave's tools plus the obvious ones the audit named (`alerts.ts` → `manage_alerts`; `patches.ts` → `manage_patches`; `scripts*.ts` → `list_scripts, run_script, …`; `backup/*` → the backup tools; `tickets/*` → `manage_tickets`; `quotes/*` → `manage_quotes, get_quote, list_quotes`; `invoices/*` → …; `contracts/*` → …; `catalog*` → `search_catalog, get_catalog_item, manage_catalog`; `m365*` → `m365_query_*`; …). A `tools` entry means "this module's reads/writes have a tool surface"; it does not claim every endpoint is covered — that granularity is #6141 P2's job.
2. **`{ exempt, note? }`** by family: `agents/**` → `agent_transport`; `auth*.ts`, `oauth*.ts`, `sso*.ts`, `passkeys*.ts`, `apiKeys*.ts`, `servicePrincipals*.ts`, `wellKnown*.ts` → `identity`; `admin/**` → `platform_admin`; `webhooks*.ts`, `inbound*.ts`, `*Callback*.ts` → `inbound_integration`; `portal*/**`, `public*.ts`, `share*.ts` → `portal`; `clientAi/**`, `officeAddin/**` → `addin_surface`; `helper/**` → `device_helper`; `mcpServer.ts` → `mcp_transport`; `health*.ts`, `metrics*.ts`, `install*.ts`, `download*.ts`, `shortLinks*.ts` → `internal_plumbing`.
3. **`{ gap: '#6141' }`** — everything left that #6141's P1/P2 tables name (network topology/SNMP monitoring routes, `alerts/policies.ts`, `alerts/routing.ts`, `fleetDesign.ts`, `fleetFindings.ts`, `software.ts`, `softwareInventory.ts`, `customFields.ts`, `accessReviews.ts`, `auditBaselines.ts`, `pam.ts`, `sensitiveData.ts`, `ticketChecklistTemplates.ts`, `deliverableTemplates.ts`, `pax8*.ts`, `contracts/generate.ts`, `quotes/lifecycle.ts`, `invoices/lifecycle.ts`, …) or that has no tool and no honest exemption. Use `#6141` for these and a more specific issue ref where one exists (`#6139` is closed by this wave, so no entry may cite it).

Every remaining module without a tool and outside the exempt families is a **gap**, never an exemption of convenience: an `exempt` entry with a `note` that reads like "no tool yet" is the failure mode this test exists to prevent. Copy the resulting `gap` keys into `FROZEN_GAPS`.

- [ ] **Step 3: Verify and commit**

```bash
cd apps/api && npx vitest run src/__tests__/mcp-coverage.test.ts
git add apps/api/src/services/mcpCoverage.ts apps/api/src/__tests__/mcp-coverage.test.ts && git commit -m "test(ai): MCP_COVERAGE route-module → tool-surface contract with frozen gap list (#6141, A-W06)"
```

---

### Task 9: Prompt index, docs, verification, PR

- [ ] **Step 1:** The A-W02 generated index picks the new tools up automatically (`listChatSurfaceToolNames` = `TOOL_TIERS` ∩ registry). Run `cd apps/api && npx vitest run src/services/aiToolIndex.test.ts` and check the rendered index lists all 13 under `Tickets & time`, `Accounts`, `Monitoring & alerts`, `Network`, `AI agents`.
- [ ] **Step 2:** `apps/docs/src/content/docs/features/mcp-server.mdx` tool table (`:225-293`): add the 13 tools with one line each. `cd apps/docs && pnpm astro check`.
- [ ] **Step 3:** Full verification:

```bash
cd apps/api && npx vitest run && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json && pnpm lint
```

- [ ] **Step 4: Live parity check on a stack** (`pnpm wt-stack up`; a partner user and a site-restricted user): for `list_time_entries`, `list_org_contacts`, `list_network_assets`, `list_sites`, compare the tool's result set (via web chat or the MCP server with an `ai:read` key) to the REST route's for the same caller — same rows, no extra columns. Record the four comparisons in the PR body. Tear the stack down.
- [ ] **Step 5: PR** — `feature/6147-agent-tool-efficiency/wave-6153`, body `Closes #6153` and `Fixes #6139`; lists the 13 tools with their permission/org/site posture, the `FROZEN_GAPS` count, and the routeBinding rows that declare "stricter" behaviour. One review round.

---

## Self-review against the spec

- "From #6141, only the gaps in-product agents hit: time entries read (#6139), org contacts read, incident list, network asset list/detail, remediation suggestions, AI-agent reads, `list_sites`" → Tasks 1–7 (13 tools; `get_site` and `get_network_asset` are the read-backs the list tools need).
- "Each new tool ships with domain + hint + read-back" → every registration carries `domain`/`searchHint` (A-W02 contract enforces); the wave is all reads, and `list_time_entries`/`get_running_timer` are the read-back for `manage_tickets`'s three time writes (Principle 5).
- "Adds the `MCP_COVERAGE` route→tool contract test so the gap stops growing" → Task 8, with the frozen gap list so the *existing* gap is honest and shrink-only.
- "tenancy-sensitive reads need route parity tests" → routeBinding rows per tool + the live parity check (Task 9 Step 4); site-scope and device-args contracts run after every task.
- Principle 6 → no renames; `manage_tickets` untouched.
