# M365 Typed Graph Read Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose 12 typed Microsoft Graph read actions on the `customer-graph-read` connection as Breeze AI tools, executed inside the isolated `m365-graph-read-executor`.

**Architecture:** A closed Zod discriminated-union catalog in `packages/shared/src/m365/` is the single contract; the executor gains one bounded `POST /v1/read-action` op that dispatches the union to fixed Graph URL templates with field projection; the API gains `readActionService` (state gates, Redis rate budgets, audit) and `aiToolsM365.ts` (6 AI tools). No DB migration.

**Tech Stack:** TypeScript, Zod, Hono, jose (EdDSA), prom-client, ioredis (via `getRedis`), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-18-m365-typed-graph-read-tools-design.md` — read it first.

## Global Constraints

- No DB migration in this phase. No schema changes to `m365_connections`.
- Executor requests carry only `correlationId` + `tenantId` + action; never credential references.
- The executor never returns raw Graph payloads: every item is projected through the per-action field allowlist before leaving the executor.
- All Graph URLs are built from fixed templates against `https://graph.microsoft.com/v1.0` only; callers never supply paths or headers.
- New env vars: `M365_GRAPH_READ_TOOLS_ENABLED` (default off) + `M365_GRAPH_READ_TOOLS_ORG_IDS` (comma-separated UUIDs or `*`).
- Do not change the behavior of `probeTenant`, `complete-consent`, or `retest` — additive changes only.
- Rate budget constants: 30 actions/minute, 2,000 actions/day per connection. Fail closed (`read_rate_limited`) if Redis is unavailable.
- Reads execute for connections in `active` and `degraded` status only.
- Site-restricted AI sessions are refused. The restriction signal is
  `auth.allowedSiteIds` being defined (undefined = unrestricted) — NOT
  `auth.canAccessSite`, which is always a defined closure for org-scope contexts.
- Run repo commands with the pinned Node version (`node_pinned_version` memory: Node 22.20.0 via nvm); wrong Node causes false test failures.
- Never edit the two shipped consent/retest contract schemas' existing fields; extending files is fine.

## File Map

| File | Action | Responsibility |
|---|---|---|
| `packages/shared/src/m365/readActions.ts` | Create | Action ids, field allowlists, request/result schemas |
| `packages/shared/src/m365/index.ts` | Modify | Re-export readActions |
| `apps/m365-graph-read-executor/src/microsoft/graphClient.ts` | Modify | `readResource`/`readCollection` + status-aware error codes |
| `apps/m365-graph-read-executor/src/microsoft/readActions.ts` | Create | Dispatch table, query building, projection |
| `apps/m365-graph-read-executor/src/operations.ts` | Modify | `readActionOperation` (credential → token → dispatch) |
| `apps/m365-graph-read-executor/src/internalAuth.ts` | Modify | `ExecutorOperation` += `'read-action'` |
| `apps/m365-graph-read-executor/src/app.ts` | Modify | Route + dependency |
| `apps/m365-graph-read-executor/src/index.ts` | Modify | Wire `readAction` |
| `apps/api/src/services/m365ControlPlane/graphReadExecutorClient.ts` | Modify | `executeReadAction` method |
| `apps/api/src/services/m365ControlPlane/runtimeConfig.ts` | Modify | Tools flag + org allowlist |
| `apps/api/src/services/m365ControlPlane/readActionBudget.ts` | Create | Redis fixed-window budget |
| `apps/api/src/services/m365ControlPlane/readActionMetrics.ts` | Create | Counter + audit helper |
| `apps/api/src/services/m365ControlPlane/readActionService.ts` | Create | Authz ladder + execution |
| `apps/api/src/services/aiToolsM365.ts` | Create | 6 AI tools |
| `apps/api/src/services/aiTools.ts` | Modify | Register module |
| `apps/api/src/services/aiGuardrails.ts` | Modify | Permission entries |
| `apps/api/src/services/aiToolSchemasM365.ts` + schema hub | Create/Modify | Input schemas (parity test enforces) |
| `apps/api/src/services/aiAgentSystemPrompt.ts` | Modify | Tool listing line |
| `docs/deploy/m365-customer-graph-read-executor.md` | Modify | New env vars |
| `docs/runbooks/m365-customer-graph-read-real-tenant.md` | Modify | Read-action acceptance section |

---

### Task 1: Shared read-action contracts

**Files:**
- Create: `packages/shared/src/m365/readActions.ts`
- Modify: `packages/shared/src/m365/index.ts` (add `export * from './readActions';`)
- Test: `packages/shared/src/m365/readActions.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module; `zod` only).
- Produces (used by Tasks 3, 4, 5, 8):
  - `M365_READ_ACTION_IDS: readonly string[]` and type `M365ReadActionId`
  - `M365_READ_ACTION_FIELDS: Record<M365ReadActionId, readonly string[]>`
  - `m365ReadActionSchema` (discriminated union on `type`), type `M365ReadAction`
  - `readActionRequestSchema` = `{ correlationId, tenantId, action }`, type `ReadActionRequest`
  - `readActionFailureCodeSchema`, type `ReadActionFailureCode`
  - `readActionResultSchema`, type `ReadActionResult`

- [ ] **Step 1: Write the failing test**

`packages/shared/src/m365/readActions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  M365_READ_ACTION_IDS,
  M365_READ_ACTION_FIELDS,
  m365ReadActionSchema,
  readActionRequestSchema,
  readActionResultSchema,
  readActionFailureCodeSchema,
} from './readActions';

const GUID = '11111111-2222-3333-4444-555555555555';

describe('m365 read action contracts', () => {
  it('defines exactly the 12 catalog actions with non-empty field allowlists', () => {
    expect(M365_READ_ACTION_IDS).toEqual([
      'm365.user.list', 'm365.user.get', 'm365.signins.list',
      'm365.intune.device.list', 'm365.intune.device.get',
      'm365.group.list', 'm365.group.get', 'm365.group.members.list',
      'm365.org.get', 'm365.org.skus.list',
      'm365.sites.list', 'm365.site.get',
    ]);
    for (const id of M365_READ_ACTION_IDS) {
      expect(M365_READ_ACTION_FIELDS[id].length).toBeGreaterThan(0);
      expect(new Set(M365_READ_ACTION_FIELDS[id]).size).toBe(M365_READ_ACTION_FIELDS[id].length);
    }
  });

  it('accepts every action variant at its bounds', () => {
    const variants = [
      { type: 'm365.user.list', search: 'ada', accountEnabled: true, pageSize: 50 },
      { type: 'm365.user.get', userIdOrUpn: 'ada@contoso.com' },
      { type: 'm365.signins.list', userPrincipalName: 'ada@contoso.com', sinceHours: 168, pageSize: 50 },
      { type: 'm365.intune.device.list', complianceState: 'noncompliant', pageSize: 50 },
      { type: 'm365.intune.device.get', deviceId: GUID },
      { type: 'm365.group.list', search: 'staff', pageSize: 50 },
      { type: 'm365.group.get', groupId: GUID },
      { type: 'm365.group.members.list', groupId: GUID, pageSize: 100 },
      { type: 'm365.org.get' },
      { type: 'm365.org.skus.list' },
      { type: 'm365.sites.list', search: 'intranet' },
      { type: 'm365.site.get', siteId: 'contoso.sharepoint.com,111,222' },
    ];
    for (const action of variants) {
      expect(m365ReadActionSchema.safeParse(action).success, JSON.stringify(action)).toBe(true);
      expect(readActionRequestSchema.safeParse({
        correlationId: GUID, tenantId: GUID, action,
      }).success).toBe(true);
    }
  });

  it('rejects out-of-bound and unknown inputs', () => {
    expect(m365ReadActionSchema.safeParse({ type: 'm365.user.list', pageSize: 51 }).success).toBe(false);
    expect(m365ReadActionSchema.safeParse({ type: 'm365.signins.list', sinceHours: 169 }).success).toBe(false);
    expect(m365ReadActionSchema.safeParse({ type: 'm365.sites.list' }).success).toBe(false); // search required
    expect(m365ReadActionSchema.safeParse({ type: 'm365.user.get', userIdOrUpn: "a'; drop--@x.com" }).success).toBe(false);
    expect(m365ReadActionSchema.safeParse({ type: 'm365.mail.send' }).success).toBe(false);
    expect(m365ReadActionSchema.safeParse({ type: 'm365.user.list', extra: 1 }).success).toBe(false);
  });

  it('round-trips collection, resource, and failure results', () => {
    expect(readActionResultSchema.safeParse({
      success: true, kind: 'collection', items: [{ id: GUID }], truncated: false,
    }).success).toBe(true);
    expect(readActionResultSchema.safeParse({
      success: true, kind: 'resource', resource: { id: GUID },
    }).success).toBe(true);
    expect(readActionResultSchema.safeParse({
      success: false, errorCode: 'graph_throttled', retryAfterSeconds: 30,
    }).success).toBe(true);
    expect(readActionFailureCodeSchema.safeParse('grant_missing').success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/shared test -- readActions`
Expected: FAIL — cannot resolve `./readActions`.

- [ ] **Step 3: Write the implementation**

`packages/shared/src/m365/readActions.ts`:

```ts
import { z } from 'zod';

const guidSchema = z.string().guid();
// UPN or object id. Forbids quotes/whitespace so values can be embedded in
// $filter expressions without escaping ambiguity.
const userIdOrUpnSchema = z.string().min(3).max(320).regex(/^[A-Za-z0-9._%+@-]+$/);
const searchTermSchema = z.string().min(1).max(120).regex(/^[^"'\\]+$/);
// Graph composite site id: host,siteCollectionGuid-ish,siteGuid-ish (comma-separated tokens).
const siteIdSchema = z.string().min(1).max(300).regex(/^[A-Za-z0-9.,_-]+$/);

const pageSize = (max: number) => z.number().int().min(1).max(max).optional();

export const M365_READ_ACTION_IDS = [
  'm365.user.list', 'm365.user.get', 'm365.signins.list',
  'm365.intune.device.list', 'm365.intune.device.get',
  'm365.group.list', 'm365.group.get', 'm365.group.members.list',
  'm365.org.get', 'm365.org.skus.list',
  'm365.sites.list', 'm365.site.get',
] as const;

export type M365ReadActionId = typeof M365_READ_ACTION_IDS[number];

/** Per-action projection allowlists. The executor projects every returned
 *  object through these; they are the only fields that ever leave it. */
export const M365_READ_ACTION_FIELDS: Record<M365ReadActionId, readonly string[]> = {
  'm365.user.list': ['id', 'userPrincipalName', 'displayName', 'mail', 'accountEnabled', 'jobTitle', 'department', 'createdDateTime'],
  'm365.user.get': ['id', 'userPrincipalName', 'displayName', 'mail', 'accountEnabled', 'jobTitle', 'department', 'createdDateTime', 'assignedLicenses', 'usageLocation', 'onPremisesSyncEnabled'],
  'm365.signins.list': ['id', 'createdDateTime', 'userPrincipalName', 'userId', 'appDisplayName', 'ipAddress', 'clientAppUsed', 'conditionalAccessStatus', 'isInteractive', 'status', 'location', 'deviceDetail'],
  'm365.intune.device.list': ['id', 'deviceName', 'operatingSystem', 'osVersion', 'complianceState', 'lastSyncDateTime', 'userPrincipalName', 'managedDeviceOwnerType', 'enrolledDateTime'],
  'm365.intune.device.get': ['id', 'deviceName', 'operatingSystem', 'osVersion', 'complianceState', 'lastSyncDateTime', 'userPrincipalName', 'managedDeviceOwnerType', 'enrolledDateTime', 'model', 'manufacturer', 'serialNumber', 'azureADDeviceId', 'jailBroken', 'managementAgent'],
  'm365.group.list': ['id', 'displayName', 'mail', 'groupTypes', 'securityEnabled', 'membershipRule', 'createdDateTime'],
  'm365.group.get': ['id', 'displayName', 'mail', 'groupTypes', 'securityEnabled', 'membershipRule', 'createdDateTime', 'description'],
  'm365.group.members.list': ['id', 'displayName', 'userPrincipalName', 'mail'],
  'm365.org.get': ['id', 'displayName', 'verifiedDomains', 'countryLetterCode', 'createdDateTime'],
  'm365.org.skus.list': ['id', 'skuId', 'skuPartNumber', 'consumedUnits', 'prepaidUnits', 'appliesTo', 'capabilityStatus'],
  'm365.sites.list': ['id', 'name', 'displayName', 'webUrl', 'createdDateTime', 'lastModifiedDateTime'],
  'm365.site.get': ['id', 'name', 'displayName', 'webUrl', 'createdDateTime', 'lastModifiedDateTime'],
};

export const m365ReadActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('m365.user.list'),
    search: searchTermSchema.optional(),
    accountEnabled: z.boolean().optional(),
    department: searchTermSchema.optional(),
    pageSize: pageSize(50),
  }).strict(),
  z.object({
    type: z.literal('m365.user.get'),
    userIdOrUpn: userIdOrUpnSchema,
  }).strict(),
  z.object({
    type: z.literal('m365.signins.list'),
    userPrincipalName: userIdOrUpnSchema.optional(),
    sinceHours: z.number().int().min(1).max(168).optional(),
    pageSize: pageSize(50),
  }).strict(),
  z.object({
    type: z.literal('m365.intune.device.list'),
    complianceState: z.enum(['compliant', 'noncompliant', 'inGracePeriod', 'unknown']).optional(),
    operatingSystem: z.enum(['Windows', 'macOS', 'iOS', 'Android', 'Linux']).optional(),
    pageSize: pageSize(50),
  }).strict(),
  z.object({
    type: z.literal('m365.intune.device.get'),
    deviceId: guidSchema,
  }).strict(),
  z.object({
    type: z.literal('m365.group.list'),
    search: searchTermSchema.optional(),
    pageSize: pageSize(50),
  }).strict(),
  z.object({
    type: z.literal('m365.group.get'),
    groupId: guidSchema,
  }).strict(),
  z.object({
    type: z.literal('m365.group.members.list'),
    groupId: guidSchema,
    pageSize: pageSize(100),
  }).strict(),
  z.object({ type: z.literal('m365.org.get') }).strict(),
  z.object({ type: z.literal('m365.org.skus.list') }).strict(),
  z.object({
    type: z.literal('m365.sites.list'),
    search: searchTermSchema,
  }).strict(),
  z.object({
    type: z.literal('m365.site.get'),
    siteId: siteIdSchema,
  }).strict(),
]);

export type M365ReadAction = z.infer<typeof m365ReadActionSchema>;

export const readActionRequestSchema = z.object({
  correlationId: guidSchema,
  tenantId: guidSchema,
  action: m365ReadActionSchema,
}).strict();

export type ReadActionRequest = z.infer<typeof readActionRequestSchema>;

export const readActionFailureCodeSchema = z.enum([
  'credential_unavailable',
  'application_token_invalid',
  'graph_permission_missing',
  'graph_license_required',
  'graph_not_found',
  'graph_throttled',
  'graph_response_too_large',
  'graph_request_timeout',
  'graph_transport_failed',
  'graph_response_invalid',
]);

export type ReadActionFailureCode = z.infer<typeof readActionFailureCodeSchema>;

const readActionItemSchema = z.record(z.unknown());

export const readActionResultSchema = z.union([
  z.object({
    success: z.literal(true),
    kind: z.literal('collection'),
    items: z.array(readActionItemSchema),
    truncated: z.boolean(),
  }).strict(),
  z.object({
    success: z.literal(true),
    kind: z.literal('resource'),
    resource: readActionItemSchema,
  }).strict(),
  z.object({
    success: z.literal(false),
    errorCode: readActionFailureCodeSchema,
    retryAfterSeconds: z.number().int().min(1).max(300).optional(),
  }).strict(),
]);

export type ReadActionResult = z.infer<typeof readActionResultSchema>;
```

Then add to `packages/shared/src/m365/index.ts`:

```ts
export * from './readActions';
```

(Read `index.ts` first; if it re-exports named symbols instead of `*`, follow its style.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @breeze/shared test -- readActions`
Expected: PASS (4 tests). Also run `pnpm --filter @breeze/shared test` — full shared suite green.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/m365/readActions.ts packages/shared/src/m365/readActions.test.ts packages/shared/src/m365/index.ts
git commit -m "feat(m365): add typed Graph read-action contracts"
```

---

### Task 2: Executor graphClient — bounded read methods with status-aware errors

**Files:**
- Modify: `apps/m365-graph-read-executor/src/microsoft/graphClient.ts`
- Test: `apps/m365-graph-read-executor/src/microsoft/graphClient.test.ts` (extend)

**Interfaces:**
- Consumes: existing `createMicrosoftGraphClient`, `OpaqueAccessToken`.
- Produces (used by Task 3):
  - `GraphClientErrorCode` extended with `'graph_permission_missing' | 'graph_license_required' | 'graph_not_found' | 'graph_throttled'`
  - `GraphClientError` gains optional readonly `retryAfterSeconds?: number`
  - `MicrosoftGraphClient` gains:
    - `readResource(input: { accessToken: OpaqueAccessToken; path: string; select: readonly string[] }): Promise<Record<string, unknown>>`
    - `readCollection(input: { accessToken: OpaqueAccessToken; path: string; query: Record<string, string>; consistencyLevelEventual?: boolean; maxItems: number; maxPages: number }): Promise<{ items: Record<string, unknown>[]; truncated: boolean }>`

**Behavioral contract:**
- Both methods build URLs with the existing `graphUrl` helper; `path` must start with `/` and is always supplied by the dispatch table (Task 3), never a caller.
- Unlike `probeTenant`'s `request()` (which collapses every non-OK to `graph_provider_rejected`), the read path inspects `response.status` **after** reading the bounded body:
  - `403` whose JSON body has `error.code === 'Authentication_RequestFromNonPremiumTenantOrB2CTenant'` → `graph_license_required`; any other 403 → `graph_permission_missing`
  - `404` → `graph_not_found`
  - `429` → `graph_throttled` with `retryAfterSeconds` from the `Retry-After` header (integer seconds, clamped to [1, 300], default 60)
  - other non-OK → `graph_provider_rejected`
- `readCollection` does NOT throw on hitting `maxItems`/`maxPages`: it stops following `@odata.nextLink`, trims `items` to `maxItems`, and returns `truncated: true`. Next-link origin/path enforcement reuses `fixedCollectionNextLink` unchanged.
- Timeout/byte budgets reuse the existing per-call `RequestBudget` machinery; `maxResponseBytes` stays the client-level 512 KiB.
- `probeTenant` behavior is untouched (existing tests must pass unmodified).

- [ ] **Step 1: Write failing tests** — extend `graphClient.test.ts` with a `describe('read methods')` block using the same `fetch` stubbing style as the existing tests (read the file's current test helpers first and reuse them):

```ts
describe('graph read methods', () => {
  it('readResource projects nothing itself and returns the parsed object', async () => {
    const fetchStub = jsonResponder({ id: 'u1', displayName: 'Ada' });
    const client = createMicrosoftGraphClient({ applicationId: APP_ID }, { fetch: fetchStub });
    const resource = await client.readResource({ accessToken: TOKEN, path: '/users/u1', select: ['id', 'displayName'] });
    expect(resource).toEqual({ id: 'u1', displayName: 'Ada' });
    expect(new URL(fetchStub.mock.calls[0][0] as string).searchParams.get('$select')).toBe('id,displayName');
  });

  it('maps 403 to graph_permission_missing and license 403 to graph_license_required', async () => {
    await expect(clientWithStatus(403, { error: { code: 'Authorization_RequestDenied' } })
      .readResource({ accessToken: TOKEN, path: '/users/u1', select: ['id'] }))
      .rejects.toMatchObject({ code: 'graph_permission_missing' });
    await expect(clientWithStatus(403, { error: { code: 'Authentication_RequestFromNonPremiumTenantOrB2CTenant' } })
      .readCollection({ accessToken: TOKEN, path: '/auditLogs/signIns', query: {}, maxItems: 10, maxPages: 1 }))
      .rejects.toMatchObject({ code: 'graph_license_required' });
  });

  it('maps 404 to graph_not_found and 429 to graph_throttled with bounded retryAfterSeconds', async () => {
    await expect(clientWithStatus(404, {}).readResource({ accessToken: TOKEN, path: '/users/nope', select: ['id'] }))
      .rejects.toMatchObject({ code: 'graph_not_found' });
    await expect(clientWithStatus(429, {}, { 'retry-after': '17' })
      .readCollection({ accessToken: TOKEN, path: '/users', query: {}, maxItems: 10, maxPages: 1 }))
      .rejects.toMatchObject({ code: 'graph_throttled', retryAfterSeconds: 17 });
  });

  it('truncates instead of throwing when maxItems or maxPages is reached', async () => {
    // Stub two pages of 3 items each with a valid same-path nextLink; maxItems 4.
    const result = await twoPageClient().readCollection({
      accessToken: TOKEN, path: '/users', query: {}, maxItems: 4, maxPages: 5,
    });
    expect(result.items).toHaveLength(4);
    expect(result.truncated).toBe(true);
  });

  it('sets ConsistencyLevel header and $count only when consistencyLevelEventual', async () => {
    const fetchStub = jsonResponder({ value: [] });
    await createMicrosoftGraphClient({ applicationId: APP_ID }, { fetch: fetchStub }).readCollection({
      accessToken: TOKEN, path: '/users', query: { '$search': '"displayName:ada"' },
      consistencyLevelEventual: true, maxItems: 10, maxPages: 1,
    });
    const [, init] = fetchStub.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ ConsistencyLevel: 'eventual' });
  });
});
```

(Adapt helper names — `jsonResponder`, `clientWithStatus`, `twoPageClient`, `APP_ID`, `TOKEN` — to the file's existing fixtures; write small local helpers if none fit.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @breeze/m365-graph-read-executor test -- graphClient`
Expected: FAIL — `readResource is not a function`.

- [ ] **Step 3: Implement** inside `createMicrosoftGraphClient`:

```ts
// Status-aware single request used only by the read methods.
async function readRequest(
  url: string,
  accessToken: OpaqueAccessToken,
  budget: RequestBudget,
  headers?: Record<string, string>,
): Promise<unknown> {
  if (budget.requests >= maxRequestCount) throw failure('graph_response_too_large');
  budget.requests += 1;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      headers: { authorization: `Bearer ${accessToken}`, ...headers },
      signal: controller.signal,
    });
    const responseBody = await readBoundedBody(response, budget, maxResponseBytes);
    if (!response.ok) throw readFailure(response, responseBody);
    return parseJson(responseBody);
  } catch (error) {
    if (error instanceof GraphClientError) throw error;
    if (timedOut) throw failure('graph_request_timeout');
    throw failure('graph_transport_failed');
  } finally {
    clearTimeout(timer);
  }
}
```

with module-level helpers:

```ts
const LICENSE_ERROR_CODE = 'Authentication_RequestFromNonPremiumTenantOrB2CTenant';

function retryAfterSeconds(response: Response): number {
  const raw = response.headers.get('retry-after');
  const parsed = raw !== null && /^[0-9]{1,4}$/.test(raw) ? Number(raw) : 60;
  return Math.min(300, Math.max(1, parsed));
}

function graphErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.code === 'string') {
      return parsed.error.code;
    }
  } catch { /* not JSON */ }
  return undefined;
}

function readFailure(response: Response, body: string): GraphClientError {
  if (response.status === 403) {
    return failure(graphErrorCode(body) === LICENSE_ERROR_CODE
      ? 'graph_license_required'
      : 'graph_permission_missing');
  }
  if (response.status === 404) return failure('graph_not_found');
  if (response.status === 429) {
    return new GraphClientError('graph_throttled', retryAfterSeconds(response));
  }
  return failure('graph_provider_rejected');
}
```

`GraphClientError` constructor becomes `constructor(readonly code: GraphClientErrorCode, readonly retryAfterSeconds?: number)`. Extend the `GraphClientErrorCode` union with the four new codes. Then the two public methods:

```ts
async readResource(input) {
  if (!configValid || typeof input.accessToken !== 'string' || !input.accessToken
    || !input.path.startsWith('/')) {
    throw failure('graph_request_invalid');
  }
  const budget = { bytes: 0, requests: 0, items: 0 };
  const body = await readRequest(
    graphUrl(input.path, { '$select': input.select.join(',') }),
    input.accessToken,
    budget,
  );
  if (!isRecord(body)) throw failure('graph_response_invalid');
  return body;
},

async readCollection(input) {
  if (!configValid || typeof input.accessToken !== 'string' || !input.accessToken
    || !input.path.startsWith('/')
    || !positiveInteger(input.maxItems) || !positiveInteger(input.maxPages)) {
    throw failure('graph_request_invalid');
  }
  const budget = { bytes: 0, requests: 0, items: 0 };
  const headers = input.consistencyLevelEventual ? { ConsistencyLevel: 'eventual' } : undefined;
  const expectedPath = `/v1.0${input.path}`;
  const items: Record<string, unknown>[] = [];
  let truncated = false;
  let url: string | undefined = graphUrl(input.path, input.query);
  let pages = 0;
  while (url !== undefined) {
    pages += 1;
    const page = parseCollectionPage(await readRequest(url, input.accessToken, budget, headers));
    for (const value of page.value) {
      if (!isRecord(value)) throw failure('graph_response_invalid');
      if (items.length >= input.maxItems) { truncated = true; break; }
      items.push(value);
    }
    if (truncated) break;
    if (page.nextLink !== undefined && pages >= input.maxPages) { truncated = true; break; }
    url = page.nextLink === undefined
      ? undefined
      : fixedCollectionNextLink(page.nextLink, expectedPath);
  }
  return { items, truncated };
},
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @breeze/m365-graph-read-executor test -- graphClient`
Expected: PASS, including all pre-existing `probeTenant` tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/m365-graph-read-executor/src/microsoft/graphClient.ts apps/m365-graph-read-executor/src/microsoft/graphClient.test.ts
git commit -m "feat(m365): add status-aware bounded Graph read methods"
```

---

### Task 3: Executor dispatch table + projection

**Files:**
- Create: `apps/m365-graph-read-executor/src/microsoft/readActions.ts`
- Test: `apps/m365-graph-read-executor/src/microsoft/readActions.test.ts`

**Interfaces:**
- Consumes: Task 1 (`M365ReadAction`, `M365_READ_ACTION_FIELDS`, `ReadActionResult`), Task 2 (`MicrosoftGraphClient.readResource/readCollection`, `GraphClientError`).
- Produces (used by Task 4's operation):
  - `executeGraphReadAction(action: M365ReadAction, context: { accessToken: OpaqueAccessToken; graphClient: MicrosoftGraphClient }): Promise<ReadActionResult>`

**Dispatch table** (all paths fixed literals; ids URL-encoded via `encodeURIComponent`; caps: default `pageSize` 25 where optional, `maxPages` 4 except sign-ins 2 and sites 1, `maxItems = pageSize × maxPages`):

| Action | Path | Query | Notes |
|---|---|---|---|
| `m365.user.list` | `/users` | `$select`, `$top`; `$search="displayName:{s}" OR "userPrincipalName:{s}"` when `search`; `$filter` from `accountEnabled` / `department eq '{d}'` | `consistencyLevelEventual: true` + `$count=true` when `$search` used |
| `m365.user.get` | `/users/{encodeURIComponent(userIdOrUpn)}` | `$select` | resource |
| `m365.signins.list` | `/auditLogs/signIns` | `$select`, `$top`; `$filter=createdDateTime ge {sinceIso}` (+ ` and userPrincipalName eq '{upn}'`) | `sinceIso` = now − `sinceHours` (default 24) |
| `m365.intune.device.list` | `/deviceManagement/managedDevices` | `$select`, `$top`; `$filter` from `complianceState eq '{v}'` / `operatingSystem eq '{v}'` | enum-validated values only |
| `m365.intune.device.get` | `/deviceManagement/managedDevices/{deviceId}` | `$select` | resource |
| `m365.group.list` | `/groups` | `$select`, `$top`; `$search="displayName:{s}"` when `search` | consistency when `$search` |
| `m365.group.get` | `/groups/{groupId}` | `$select` | resource |
| `m365.group.members.list` | `/groups/{groupId}/members` | `$select`, `$top` | items may be non-user directoryObjects; projection handles |
| `m365.org.get` | `/organization` | `$select` | collection of exactly ≤1; return first as resource, else `graph_not_found` |
| `m365.org.skus.list` | `/subscribedSkus` | `$select` | no `$top` support on this endpoint — rely on maxItems 60 |
| `m365.sites.list` | `/sites` | `search={term}`, `$select`, `$top` (pageSize ≤ 25) | 1 page |
| `m365.site.get` | `/sites/{encodeURIComponent(siteId)}` | `$select` | resource |

`$filter` string values are only ever enum members, ISO timestamps generated locally, or `userIdOrUpn`/`search` values already regex-restricted by the shared schema to exclude `'`, `"`, and `\` — assert this with a comment referencing the schema, and still wrap values with `encodeURIComponent`-safe URLSearchParams (the existing `graphUrl` uses `searchParams.set`, which handles encoding).

Projection:

```ts
function project(item: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) if (field in item) out[field] = item[field];
  return out;
}
```

Error mapping: catch `GraphClientError` and return `{ success: false, errorCode, retryAfterSeconds }` for the codes in `readActionFailureCodeSchema`; map `graph_provider_rejected`/`graph_request_invalid`/`organization_probe_failed` to `graph_response_invalid` (they indicate a Breeze-side or provider contract problem, not caller error). Never rethrow out of `executeGraphReadAction` except programmer errors.

- [ ] **Step 1: Write failing tests** — `readActions.test.ts` with a stub `graphClient` recording calls. Cover minimum: (a) every one of the 12 actions produces a call with the exact expected `path` and `$select` (table-driven over `M365_READ_ACTION_IDS`); (b) `m365.user.list` with `search` sets `$search`, `$count`, and `consistencyLevelEventual`; (c) `m365.signins.list` builds `createdDateTime ge` from the provided clock and appends the UPN clause; (d) projection strips fields not in the allowlist (stub returns an extra `passwordProfile` key → absent from result); (e) `m365.org.get` with empty collection → `{ success: false, errorCode: 'graph_not_found' }`; (f) a `GraphClientError('graph_throttled', 30)` from the stub → failure result with `retryAfterSeconds: 30`. Inject the clock: `executeGraphReadAction(action, { accessToken, graphClient, now: () => new Date('2026-07-18T00:00:00Z') })` (add optional `now` to the context; default `() => new Date()`).

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/m365-graph-read-executor test -- readActions` → FAIL (module not found).

- [ ] **Step 3: Implement** `readActions.ts` per the table above. Skeleton:

```ts
import {
  M365_READ_ACTION_FIELDS,
  type M365ReadAction,
  type ReadActionResult,
  readActionFailureCodeSchema,
} from '@breeze/shared/m365';
import { GraphClientError, type MicrosoftGraphClient } from './graphClient';
import type { OpaqueAccessToken } from './tokenClient';

export interface GraphReadActionContext {
  accessToken: OpaqueAccessToken;
  graphClient: MicrosoftGraphClient;
  now?: () => Date;
}

function failureResult(error: unknown): ReadActionResult {
  if (error instanceof GraphClientError) {
    const parsed = readActionFailureCodeSchema.safeParse(error.code);
    const errorCode = parsed.success ? parsed.data : 'graph_response_invalid' as const;
    return error.retryAfterSeconds === undefined
      ? { success: false, errorCode }
      : { success: false, errorCode, retryAfterSeconds: error.retryAfterSeconds };
  }
  throw error;
}
```

then one `switch (action.type)` (or a table of handlers keyed by type) building query/paths exactly per the dispatch table, each returning `{ success: true, kind: 'collection', items: items.map((item) => project(item, fields)), truncated }` or `{ success: true, kind: 'resource', resource: project(resource, fields) }`, all wrapped in one `try { ... } catch (error) { return failureResult(error); }`.

- [ ] **Step 4: Run tests** — expected PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/m365-graph-read-executor/src/microsoft/readActions.ts apps/m365-graph-read-executor/src/microsoft/readActions.test.ts
git commit -m "feat(m365): add executor read-action dispatch with projection"
```

---

### Task 4: Executor operation, route, and internal-auth op

**Files:**
- Modify: `apps/m365-graph-read-executor/src/internalAuth.ts` (line 8: `export type ExecutorOperation = 'complete-consent' | 'retest' | 'read-action';`)
- Modify: `apps/m365-graph-read-executor/src/operations.ts`
- Modify: `apps/m365-graph-read-executor/src/app.ts`
- Modify: `apps/m365-graph-read-executor/src/index.ts` (wire `readAction` — read the file; it constructs `createExecutorOperations` and passes named ops into `createExecutorApp`)
- Test: `operations.test.ts`, `app.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1 (`readActionRequestSchema`, `ReadActionRequest`, `ReadActionResult`), Task 3 (`executeGraphReadAction`).
- Produces: executor dependency `readAction(request: ReadActionRequest): Promise<ReadActionResult>`; HTTP `POST /v1/read-action`.

- [ ] **Step 1: Write failing operation tests** in `operations.test.ts` (reuse its existing fixture style for `certificateProvider`/`createTokenClient` stubs):
  - invalid tenant GUID in request → schema rejects at app layer, but `readActionOperation` itself with a bad-format tenant returns `{ success:false, errorCode:'application_token_invalid' }`? **No** — keep symmetry with `retestOperation`: guard `CANONICAL_UUID.test(request.tenantId)`; on failure return `{ success: false, errorCode: 'graph_response_invalid' }`.
  - credential provider throws → `credential_unavailable`.
  - `MicrosoftTokenClientError` from `acquireGraphAppToken` → `application_token_invalid`.
  - happy path: stubbed `executeGraphReadAction` result is returned verbatim and the token client received `{ tenantId: request.tenantId }`.
  - certificate PEM fields are blanked after completion (same `finally` scrubbing as `retestOperation` — assert `credential.certificatePem === ''`).

- [ ] **Step 2: Write failing app tests** in `app.test.ts`:
  - `POST /v1/read-action` with valid auth + body → 200 with the stubbed dependency result.
  - authenticator called with `operation: 'read-action'`.
  - body whose `correlationId` differs from the authenticated one → 401.
  - invalid action body → 400 `invalid_request`.
  - Confirm the existing 404 test for `/v1/arbitrary` still passes.

- [ ] **Step 3: Run to verify failures** — `pnpm --filter @breeze/m365-graph-read-executor test -- operations app` → FAIL.

- [ ] **Step 4: Implement.**

`operations.ts` — add:

```ts
import { readActionResultSchema, type ReadActionRequest, type ReadActionResult } from '@breeze/shared/m365';
import { executeGraphReadAction } from './microsoft/readActions';

export async function readActionOperation(
  request: ReadActionRequest,
  dependencies: ExecutorOperationDependencies,
): Promise<ReadActionResult> {
  if (!CANONICAL_UUID.test(request.tenantId)) {
    return { success: false, errorCode: 'graph_response_invalid' };
  }
  const credential = await fetchCredential(dependencies);
  if (typeof credential === 'string') {
    return { success: false, errorCode: credential === 'credential_unavailable' ? 'credential_unavailable' : 'application_token_invalid' };
  }
  let tokenClient: MicrosoftTokenClient | undefined;
  try {
    try {
      tokenClient = dependencies.createTokenClient(credential);
    } catch {
      return { success: false, errorCode: 'credential_unavailable' };
    }
    let accessToken;
    try {
      accessToken = await tokenClient.acquireGraphAppToken({ tenantId: request.tenantId });
    } catch {
      return { success: false, errorCode: 'application_token_invalid' };
    }
    return readActionResultSchema.parse(await executeGraphReadAction(request.action, {
      accessToken,
      graphClient: dependencies.graphClient,
    }));
  } finally {
    tokenClient = undefined;
    credential.certificatePem = '';
    credential.privateKeyPem = '';
  }
}
```

and extend `createExecutorOperations`'s return with `readAction: (request: ReadActionRequest) => readActionOperation(request, dependencies)`.

`app.ts` — add to `ExecutorAppDependencies`: `readAction(request: ReadActionRequest): Promise<ReadActionResult>;`. In `execute`, before the retest fallthrough, add:

```ts
if (operation === 'read-action') {
  const request = readActionRequestSchema.safeParse(parsed);
  if (!request.success) return context.json({ error: 'invalid_request' }, 400);
  if (request.data.correlationId !== authentication.correlationId) {
    return context.json({ error: 'unauthorized' }, 401);
  }
  try {
    const result = readActionResultSchema.safeParse(await dependencies.readAction(request.data));
    return result.success ? context.json(result.data) : context.json({ error: 'internal_error' }, 500);
  } catch {
    return context.json({ error: 'internal_error' }, 500);
  }
}
```

plus `app.post('/v1/read-action', (context) => execute(context, 'read-action'));` and the new imports. Wire `readAction` through `index.ts`.

- [ ] **Step 5: Run the full executor suite** — `pnpm --filter @breeze/m365-graph-read-executor test` → all green (existing 185 + new).

- [ ] **Step 6: Commit**

```bash
git add apps/m365-graph-read-executor/src
git commit -m "feat(m365): serve bounded read-action executor op"
```

---

### Task 5: API executor client — `executeReadAction`

**Files:**
- Modify: `apps/api/src/services/m365ControlPlane/graphReadExecutorClient.ts`
- Test: `apps/api/src/services/m365ControlPlane/graphReadExecutorClient.test.ts` (extend, matching existing test style)

**Interfaces:**
- Consumes: Task 1 schemas.
- Produces (used by Task 8): `GraphReadExecutorClient.executeReadAction(input: ReadActionRequest): Promise<ReadActionResult>`.

**Changes:**
- Local `type ExecutorOperation = 'complete-consent' | 'retest' | 'read-action';`
- `operationEndpoint`: replace the ternary with a map `{ 'complete-consent': '/v1/complete-consent', retest: '/v1/retest', 'read-action': '/v1/read-action' }`.
- Response size: `invoke` gains a per-call `maxBytes` argument; consent/retest keep `maxResponseBytes` (32 KiB default), `read-action` uses `READ_ACTION_MAX_RESPONSE_BYTES = 256 * 1024`.
- New method mirrors the existing two:

```ts
executeReadAction(input) {
  const parsed = readActionRequestSchema.safeParse(input);
  if (!parsed.success) return Promise.reject(unavailable());
  return invoke('read-action', parsed.data, (value) => readActionResultSchema.parse(value), READ_ACTION_MAX_RESPONSE_BYTES);
},
```

- [ ] **Step 1: Write failing tests**: (a) `executeReadAction` posts to `/v1/read-action` with an EdDSA JWT whose `operation` claim is `read-action` and whose `bodySha256` matches the sent body; (b) a valid executor failure body parses through; (c) an executor 404 (old executor) → rejects with `GraphReadExecutorClientError` (`executor_unavailable`); (d) a 200 body larger than 32 KiB but under 256 KiB parses successfully (proves the raised read cap).
- [ ] **Step 2: Run** `pnpm --filter @breeze/api test -- graphReadExecutorClient` → FAIL.
- [ ] **Step 3: Implement** per above.
- [ ] **Step 4: Run** same command → PASS.
- [ ] **Step 5: Commit** — `git add apps/api/src/services/m365ControlPlane/graphReadExecutorClient.*` ; `git commit -m "feat(m365): add read-action executor client op"`

---

### Task 6: Runtime config — tools flag + org allowlist

**Files:**
- Modify: `apps/api/src/services/m365ControlPlane/runtimeConfig.ts`
- Test: `apps/api/src/services/m365ControlPlane/runtimeConfig.test.ts` (extend)

**Interfaces:**
- Produces (used by Tasks 8, 9): `isM365GraphReadToolsEnabledForOrg(orgId: string, source?: Environment): boolean`

**Implementation:** mirror `parseOnboardingOrgIds`/`isM365CustomerGraphReadOnboardingEnabledForOrg` exactly, with envs `M365_GRAPH_READ_TOOLS_ENABLED` and `M365_GRAPH_READ_TOOLS_ORG_IDS`:

```ts
function parseGraphReadToolsOrgIds(source: Environment): '*' | readonly string[] {
  const raw = source.M365_GRAPH_READ_TOOLS_ORG_IDS?.trim();
  if (!raw) {
    if (!flagEnabled(source.M365_GRAPH_READ_TOOLS_ENABLED)) return [];
    throw new Error('M365_GRAPH_READ_TOOLS_ORG_IDS is required when M365 Graph read tools are enabled');
  }
  if (raw === '*') return '*';
  const ids = raw.split(',').map((value) => value.trim());
  if (ids.some((value) => !CANONICAL_UUID.test(value))) {
    throw new Error('M365_GRAPH_READ_TOOLS_ORG_IDS must be literal * or comma-separated canonical UUIDs');
  }
  return [...new Set(ids)];
}

export function isM365GraphReadToolsEnabledForOrg(
  orgId: string,
  source: Environment = process.env,
): boolean {
  if (!flagEnabled(source.M365_GRAPH_READ_TOOLS_ENABLED)) return false;
  if (!CANONICAL_UUID.test(orgId)) return false;
  return (() => {
    const allowlist = parseGraphReadToolsOrgIds(source);
    return allowlist === '*' || allowlist.includes(orgId);
  })();
}
```

Note this helper deliberately does NOT call `loadM365CustomerGraphReadRuntimeConfig` (which requires all executor envs); the tool gate must be cheap and side-effect free. Also extend `validateM365CustomerGraphReadRuntimeConfigAtBoot` to call `loadM365CustomerGraphReadRuntimeConfig` when the tools flag is enabled too (tools imply the executor must be configured).

- [ ] **Step 1: Failing tests**: off by default; enabled+`*` → true for any UUID; enabled+list → membership only; enabled with empty org ids env → throws; boot validation runs when only the tools flag is set.
- [ ] **Step 2: Run** `pnpm --filter @breeze/api test -- runtimeConfig` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(m365): add graph read tools rollout flag"` (with the two files).

---

### Task 7: Redis read-action budget

**Files:**
- Create: `apps/api/src/services/m365ControlPlane/readActionBudget.ts`
- Test: `apps/api/src/services/m365ControlPlane/readActionBudget.test.ts`

**Interfaces:**
- Consumes: `getRedis` from `apps/api/src/services/redis` (same import as `agentWorkExpectation.ts`).
- Produces (used by Task 8): `consumeM365ReadActionBudget(connectionId: string): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }>`

**Implementation:**

```ts
import { getRedis } from '../redis';

export const M365_READ_ACTIONS_PER_MINUTE = 30;
export const M365_READ_ACTIONS_PER_DAY = 2_000;

export async function consumeM365ReadActionBudget(
  connectionId: string,
): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
  const now = Date.now();
  const minuteWindow = Math.floor(now / 60_000);
  const minuteKey = `m365-read-budget-min-${connectionId}-${minuteWindow}`;
  const dayKey = `m365-read-budget-day-${connectionId}-${new Date(now).toISOString().slice(0, 10)}`;
  try {
    const redis = getRedis();
    const [minuteCount, , dayCount] = await redis
      .multi()
      .incr(minuteKey)
      .expire(minuteKey, 120)
      .incr(dayKey)
      .expire(dayKey, 60 * 60 * 26)
      .exec()
      .then((results) => (results ?? []).map(([, value]) => value));
    if (typeof minuteCount === 'number' && minuteCount > M365_READ_ACTIONS_PER_MINUTE) {
      return { allowed: false, retryAfterSeconds: 60 - Math.floor((now % 60_000) / 1_000) };
    }
    if (typeof dayCount === 'number' && dayCount > M365_READ_ACTIONS_PER_DAY) {
      return { allowed: false, retryAfterSeconds: 3_600 };
    }
    return { allowed: true };
  } catch {
    // Fail closed: no budget signal, no Graph call.
    return { allowed: false, retryAfterSeconds: 60 };
  }
}
```

(Adjust the `multi().exec()` result destructure to the actual ioredis types in this repo — check how existing code reads `exec()` results.)

- [ ] **Step 1: Failing tests** with a mocked `getRedis` (vi.mock `../redis`): under limit → allowed; 31st call in a minute → denied with retryAfter ≤ 60; 2,001st of the day → denied; redis throws → denied (fail-closed).
- [ ] **Step 2: Run** `pnpm --filter @breeze/api test -- readActionBudget` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(m365): add per-connection read-action budget"`.

---

### Task 8: `readActionService` — authz ladder + audit/metrics

**Files:**
- Create: `apps/api/src/services/m365ControlPlane/readActionMetrics.ts`
- Create: `apps/api/src/services/m365ControlPlane/readActionService.ts`
- Test: `apps/api/src/services/m365ControlPlane/readActionService.test.ts`

**Interfaces:**
- Consumes: Task 5 (`executeReadAction`), Task 6 (`isM365GraphReadToolsEnabledForOrg`), Task 7 (`consumeM365ReadActionBudget`), existing `loadM365CustomerGraphReadRuntimeConfig`, `m365Connections` schema, `resolveWritableToolOrgId` + `AuthContext` from `aiTools.ts`/middleware, `writeAuditEvent` (note: `AuthContext` extends `RequestLike`, so `auth` itself is the audit request arg).
- Produces (used by Task 9):

```ts
export type M365ReadActionRefusalCode =
  | 'tools_disabled' | 'site_scope_denied' | 'org_context_required'
  | 'connection_not_ready' | 'read_rate_limited' | 'executor_unavailable';

export type M365ReadActionServiceResult =
  | { ok: true; kind: 'collection'; items: Record<string, unknown>[]; truncated: boolean }
  | { ok: true; kind: 'resource'; resource: Record<string, unknown> }
  | { ok: false; code: M365ReadActionRefusalCode | ReadActionFailureCode; message: string; retryAfterSeconds?: number };

export async function executeM365ReadAction(
  auth: AuthContext,
  action: M365ReadAction,
  inputOrgId?: string,
): Promise<M365ReadActionServiceResult>;
```

**Ladder (exact order):**
1. `if (auth.allowedSiteIds) return { ok: false, code: 'site_scope_denied', message: 'Microsoft 365 tools are not available to site-restricted sessions.' };` (`allowedSiteIds` defined = site-restricted; `canAccessSite` is always defined for org scope and must NOT be used as the signal)
2. Resolve org via `resolveWritableToolOrgId(auth, inputOrgId)`; error → `org_context_required` with the returned message.
3. `if (!isM365GraphReadToolsEnabledForOrg(orgId)) return { ok: false, code: 'tools_disabled', message: 'Microsoft 365 Graph read tools are not enabled for this organization.' };`
4. Load connection: `db.select().from(m365Connections).where(and(eq(m365Connections.orgId, orgId), eq(m365Connections.profile, 'customer-graph-read'))).limit(1)` — request-path query, runs under the caller's RLS context (do NOT use a system context). Absent row, or `status` not in `('active','degraded')`, or `tenantId === null` → `connection_not_ready` with a message naming the state and next step ("Connect Microsoft 365 in Integrations settings" / "Run Retest on the Microsoft 365 card").
5. `consumeM365ReadActionBudget(connection.id)` → denied → `read_rate_limited` (+ retryAfterSeconds).
6. Build client via `loadM365CustomerGraphReadRuntimeConfig()` + the same `runtimeClient(config)` construction pattern `connectionService.ts:233-240` uses (export a tiny factory from `connectionService.ts` or duplicate the 8-line construction — do NOT change `connectionService`'s existing exports' behavior). Call `client.executeReadAction({ correlationId: randomUUID(), tenantId: connection.tenantId, action })`. `GraphReadExecutorClientError` → `executor_unavailable`.
7. Executor failure result → `{ ok: false, code: result.errorCode, message: FAILURE_MESSAGES[result.errorCode], retryAfterSeconds }` where `FAILURE_MESSAGES` maps every `ReadActionFailureCode` to one plain sentence (permission → "…run Retest on the Microsoft 365 card", license → "This tenant does not include Entra ID P1/P2, which Microsoft requires for sign-in logs.").
8. Audit + metric on every executed attempt (steps 6–7 outcomes, not refusals before the connection is known): call `recordM365ReadActionEvent(auth, { orgId, connectionId, actionType: action.type, outcome, itemCount, truncated, actorId: auth.userId })`.

`readActionMetrics.ts` (pattern-match `metrics.ts`): counter `breeze_m365_graph_read_actions_total` with labels `action`, `outcome` (`outcome` = `'ok' | ReadActionFailureCode | 'executor_unavailable'`), a `registerM365GraphReadActionPrometheusCounter(registry)` (register it wherever `registerM365CustomerGraphReadPrometheusCounter` is called — grep for that call site and add alongside), and `recordM365ReadActionEvent(request: RequestLike, input)` that calls `writeAuditEvent(request, { orgId, action: 'm365.customer_graph_read.action_executed', resourceType: 'm365_connection', resourceId: connectionId, details: { actionType, outcome, itemCount, truncated }, result: outcome === 'ok' ? 'success' : 'failure', actorType: 'user', actorId })`. Details never include Graph payloads.

- [ ] **Step 1: Failing tests** (Drizzle mock pattern per the `breeze-testing` skill — invoke that skill before writing these): site-scoped auth refused before any DB call; disabled flag refused; missing connection / `pending-consent` / `revoked` → `connection_not_ready`; `degraded` proceeds; budget denial surfaces retryAfter; executor happy path returns items; executor `graph_permission_missing` maps to failure message + audit `result: 'failure'`; `GraphReadExecutorClientError` → `executor_unavailable`; audit called with `itemCount` and no payload keys.
- [ ] **Step 2: Run** `pnpm --filter @breeze/api test -- readActionService` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(m365): add read-action control-plane service"`.

---

### Task 9: AI tools — `aiToolsM365.ts` + guardrails + schemas + prompt

**Files:**
- Create: `apps/api/src/services/aiToolsM365.ts`
- Modify: `apps/api/src/services/aiTools.ts` (import + `registerM365Tools(aiTools);` at the end of the registration block)
- Modify: `apps/api/src/services/aiGuardrails.ts` (6 entries near the `query_c2c_connections` entry at line ~441)
- Create/Modify: input schemas — read `apps/api/src/services/aiToolSchemas.ts` to learn how domain schema files (e.g. `aiToolSchemasBackup.ts`) are composed, then add `aiToolSchemasM365.ts` and hook it in identically
- Modify: `apps/api/src/services/aiAgentSystemPrompt.ts` (add a `- **Microsoft 365**: …` line listing the 6 tools)
- Test: `apps/api/src/services/aiToolsM365.test.ts`

**Interfaces:**
- Consumes: Task 8 (`executeM365ReadAction`), `AiTool` from `aiTools.ts`.
- Produces: 6 registered tools, all `tier: 1`, no `deviceArgs`:

| Tool | Input schema | Maps to |
|---|---|---|
| `m365_query_users` | `{ mode: 'list'\|'get', search?, userIdOrUpn?, accountEnabled?, department?, limit? }` | `m365.user.list` / `m365.user.get` |
| `m365_query_signins` | `{ userPrincipalName?, sinceHours?, limit? }` | `m365.signins.list` |
| `m365_query_intune_devices` | `{ mode: 'list'\|'get', deviceId?, complianceState?, operatingSystem?, limit? }` | `m365.intune.device.list` / `.get` |
| `m365_query_groups` | `{ mode: 'list'\|'get'\|'members', groupId?, search?, limit? }` | `m365.group.list` / `.get` / `.members.list` |
| `m365_query_org` | `{ include: 'profile'\|'licenses' }` | `m365.org.get` / `m365.org.skus.list` |
| `m365_query_sites` | `{ mode: 'list'\|'get', search?, siteId? }` | `m365.sites.list` / `m365.site.get` |

Handler pattern (per tool):

```ts
handler: safeHandler('m365_query_users', async (input, auth) => {
  const action = input.mode === 'get'
    ? { type: 'm365.user.get' as const, userIdOrUpn: String(input.userIdOrUpn ?? '') }
    : {
        type: 'm365.user.list' as const,
        ...(input.search ? { search: String(input.search) } : {}),
        ...(typeof input.accountEnabled === 'boolean' ? { accountEnabled: input.accountEnabled } : {}),
        ...(input.department ? { department: String(input.department) } : {}),
        pageSize: clampLimit(input.limit, 25, 50),
      };
  const parsed = m365ReadActionSchema.safeParse(action);
  if (!parsed.success) return JSON.stringify({ error: 'Invalid parameters for this Microsoft 365 query.' });
  const result = await executeM365ReadAction(auth, parsed.data, typeof input.orgId === 'string' ? input.orgId : undefined);
  return JSON.stringify(result.ok
    ? (result.kind === 'collection'
        ? { items: result.items, truncated: result.truncated, note: result.truncated ? 'Result capped; narrow the query for more.' : undefined }
        : { resource: result.resource })
    : { error: result.message, code: result.code, retryAfterSeconds: result.retryAfterSeconds });
})
```

Copy `safeHandler`/`clampLimit` locally (the file-local helper convention in `aiToolsC2C.ts` — they are not exported). Every `definition.description` must state the cap ("Returns at most 50 users per call…") and that data comes live from the customer's Microsoft 365 tenant. Include an optional `orgId` property in each tool's input schema (partner sessions), described as "Organization id; required only when the session spans multiple organizations."

Guardrails (`aiGuardrails.ts`): all 6 names → `{ resource: 'organizations', action: 'read' }`.

Site-scope defense in depth: the authoritative refusal lives in `readActionService`
(Task 8, ladder step 1). Additionally, grep for where the chat pipeline narrows the
`aiTools` map per session (e.g. tier/guardrail filtering before tools are handed to the
model). If such a per-session filter exists, exclude the six `m365_*` tools there for
sessions with `auth.allowedSiteIds` defined (the site-restriction signal), and add
one test for it. If no such filter
exists, skip this — do NOT invent a new filtering layer for this feature.

- [ ] **Step 1: Failing tests** (`aiToolsM365.test.ts`, mocking `./m365ControlPlane/readActionService`): each tool maps its inputs to the exact expected action variant; `limit` clamps to the per-action max; a refusal result serializes `{ error, code }`; registration test asserts all 6 names exist in the `aiTools` map with `tier: 1`.
- [ ] **Step 2: Run** `pnpm --filter @breeze/api test -- aiToolsM365` → FAIL. **Step 3: Implement all five file changes.**
- [ ] **Step 4: Run the parity + gate suites** — these are the dual-map drift traps:

```
pnpm --filter @breeze/api test -- aiToolsM365 aiToolsRegistryParity aiGuardrails aiToolSchemas executeToolGate
```

Expected: PASS. If the parity test names another required registry (e.g. a schemas map or prompt list), fix forward until green — do not allowlist-exclude the new tools.
- [ ] **Step 5: Commit** — `git add apps/api/src/services/aiTools*.ts apps/api/src/services/aiGuardrails.ts apps/api/src/services/aiAgentSystemPrompt.ts` ; `git commit -m "feat(ai): add Microsoft 365 Graph read tools"`.

---

### Task 10: Docs — deploy env vars + real-tenant runbook

**Files:**
- Modify: `docs/deploy/m365-customer-graph-read-executor.md` — add `M365_GRAPH_READ_TOOLS_ENABLED` and `M365_GRAPH_READ_TOOLS_ORG_IDS` rows to the API env-var table (default off; `*` last in rollout; tools flag implies the executor envs must be configured — boot validation enforces), and note the new `/v1/read-action` op in the network/ops description plus the new Prometheus counter `breeze_m365_graph_read_actions_total`.
- Modify: `docs/runbooks/m365-customer-graph-read-real-tenant.md` — append a "Read-action acceptance" section: execute each of the 12 actions once via the AI tools against the disposable tenant; verify projection (no field outside the allowlist in any response); permission-drift scenario (remove `AuditLog.Read.All` via the approved appRoleAssignment procedure → `m365_query_signins` returns the permission-missing guidance, other tools keep working); non-premium tenant → `graph_license_required` message; budget check (31 rapid calls → `read_rate_limited`); audit events present with counts only.
- Modify: `.env.example` files ONLY if the existing M365 envs appear there (grep first: `grep -rn "M365_CUSTOMER_GRAPH_READ" --include='.env*' .`) — use generic placeholders per repo policy.

- [ ] **Step 1: Make the doc edits.**
- [ ] **Step 2: Check docs build if touched files feed it** — `grep -rn "m365-customer-graph-read" apps/docs/src 2>/dev/null | head`; if referenced, run the docs build per its README.
- [ ] **Step 3: Commit** — `git commit -m "docs(m365): document graph read tools rollout and acceptance"`.

---

### Task 11: Full verification gate

- [ ] **Step 1: Focused suites**

```
pnpm --filter @breeze/shared test
pnpm --filter @breeze/m365-graph-read-executor test
pnpm --filter @breeze/api test -- m365 aiTools
```

Expected: all green.

- [ ] **Step 2: Types, lint, builds**

```
pnpm --filter @breeze/shared build
pnpm --filter @breeze/api exec tsc --noEmit
pnpm --filter @breeze/m365-graph-read-executor build
pnpm --filter @breeze/api lint --no-error-on-unmatched-pattern src/services/m365ControlPlane src/services/aiToolsM365.ts
```

(Adjust lint invocation to the repo's actual lint script — check `apps/api/package.json`.) Note the known heavy-branch tsc memory ceiling (`f472bf58a` raised CI heap); if local tsc OOMs, use `NODE_OPTIONS=--max-old-space-size=8192`.

- [ ] **Step 3: Web + full API suites are NOT expected to change** — run `pnpm --filter @breeze/api test` once to confirm no collateral damage.
- [ ] **Step 4: `git diff --check`** — no whitespace errors.
- [ ] **Step 5: Commit any stragglers, then run `/code-review`** (one round, per the review-recursion cap) before opening the PR.

---

## Self-Review Notes (already applied)

- Spec §4/§6/§7 were corrected before this plan was written: executor envelope is `correlationId`+`tenantId` only; the internal JWT claim is `operation`; AI-tool flag gating is runtime (handler) not registration-time; env var is `M365_GRAPH_READ_TOOLS_ORG_IDS`.
- `m365.org.skus.list`: `/subscribedSkus` does not support `$top` — the plan relies on `maxItems` and notes it in the dispatch table.
- Type consistency: `ReadActionRequest`/`ReadActionResult`/`M365ReadAction` names are used identically across Tasks 1, 3, 4, 5, 8; the service refusal codes (`M365ReadActionRefusalCode`) are distinct from executor `ReadActionFailureCode` and both surface through `M365ReadActionServiceResult.code`.
- Deploy order safety: old executor 404s `/v1/read-action` → client `executor_unavailable` (Task 5 test c) — matches spec §10.
