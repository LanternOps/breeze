# M365 Tenant Sync Foundation — Wave 1: Manifest v3 + upgrade consent

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** bump the `customer-graph-read` permission manifest from v2 to v3 with the four application permissions the whole tenant-sync program needs, and ship a re-consent path that lets a customer's Global Administrator approve them **without ever taking the existing connection out of service**. After this wave every v2 connection derives `manifest-stale`, the API exposes that derivation, and an amber banner with "Approve new permissions" starts a consent flow that promotes the row in place on success and changes nothing on failure.

**Architecture:** three seams. (1) `packages/shared/src/m365/profiles.ts` is the single manifest source — bumping `version` to 3 and appending four `applicationPermissionAssignments` automatically drives `deriveGrantHealth`, the executor's grant reconciliation, both web cards' `matchesTrustedManifest` check, and the deploy doc. (2) The connection-lifecycle factory (`createConnectionService`) gains an `initiateUpgradeConsent` / `transitionUpgradeConsentToIdentity` / `applyUpgradeVerificationResult` triple that binds a consent session to the **existing** connection id and attempt and never writes `status`. (3) The shared two-phase consent callback learns to route on a new `m365_consent_sessions.purpose` column, so an upgrade session expects an *executable* connection, skips `markConsentAttemptFailed` entirely, and promotes `permission_manifest_version` + `consent_generation` in place.

**Tech Stack:** TypeScript, Hono (API), Drizzle ORM + hand-written SQL migrations (Postgres, RLS), Zod (`@breeze/shared/m365`), Vitest (unit + integration), React 19 + Astro islands + i18next (web).

**Spec:** `docs/superpowers/specs/integrations/2026-09-08-m365-tenant-sync-foundation-design.md` — this plan implements §2 in full (§2.1 scopes, §2.2 re-consent without interruption) plus the DTO/card changes §2.2 items 1 and 3. Wave table and shared interface contract: `docs/superpowers/plans/integrations/2026-09-08-m365-tenant-sync-0-overview.md`.

## Global constraints (copied from the overview; this wave inherits them)

- Migration file name must sort after the newest committed migration (`2026-10-14-100500-ai-operator-task-client-idempotency.sql` as of 2026-09-08; re-check with `ls apps/api/migrations | sort | tail -1`). Idempotent, no inner `BEGIN`/`COMMIT`.
- All new tables are shape 1: `org_id NOT NULL` → `organizations(id)`, policy `USING (public.breeze_has_org_access(org_id))` FOR ALL. **This wave creates no tables** — it adds one column to an existing one.
- Composite FKs on `(x, org_id)` are `DEFERRABLE INITIALLY IMMEDIATE`.
- Every jsonb column is `excludedOpen`; every column whose name contains `mfa` or `hash` is `reviewedIncluded` in `CORE_TENANT_EXPORT_POLICY`. **`m365_consent_sessions` is already in `CORE_ORG_CASCADE_DELETE_ORDER` (`tenantCascade.ts:320`), so the new `purpose` column MUST be classified in `CORE_TENANT_EXPORT_POLICY` in the same PR** — this is the registration list that fires on a new *column*.
- BullMQ custom job ids contain no `:` — not exercised in this wave.
- Fail-closed: no Redis budget signal = deny; missing flag = off.
- Never edit a shipped migration. Never call the bare pool in request code.
- Test one file with `cd apps/api && npx vitest run <path>` (never `pnpm … test -- --run`).
- Executor projection allowlists are the only fields that leave the executor.

## Wave-specific constraints

- **The manifest is the only place a Graph app-role GUID may be typed.** Task 1 fetches them from the live Microsoft Graph service principal and cross-checks a second source. Never type a GUID from memory; a wrong `appRoleId` makes `deriveGrantHealth` report a permanent `grant_missing` that no admin can fix.
- **An upgrade never writes `status`.** `initiateConsent` moves a connection to `pending-consent`, which stops reads if the admin abandons the flow (spec §2.2). The upgrade path is a separate transition precisely so that cannot happen. Any code path in this wave that writes `m365_connections.status` during an upgrade is a defect.
- **`markConsentAttemptFailed` sets `status = 'pending-consent'`** (`connectionService.ts:522-536`). Reaching it from an upgrade callback would take a live connection out of service on a *cancelled* consent. It must be skipped for `purpose = 'upgrade'`.
- **An upgrade may never rebind the tenant.** `applyIdentityVerificationResult` accepts a binding when `tenantId IS NULL OR tenantId = result.tenantId` (`connectionService.ts:596-599`). The upgrade equivalent requires strict equality against the already-stored tenant; a mismatch is a silent no-op, never a rebind.
- Blast radius is recorded per task. Two fixture sets hard-code the nine v2 grants and WILL go red on Task 2 — that is the check working, and they are fixed inside that task, not worked around.

---

## Task ordering & dependencies

1. **Task 1** — verify the four app-role GUIDs (no code).
2. **Task 2** — manifest v3 (needs Task 1's GUIDs).
3. **Task 3** — `purpose` column: migration + Drizzle + export policy. Independent of 1/2.
4. **Task 4** — consent-session service plumbing (needs Task 3).
5. **Task 5** — `initiateUpgradeConsent` (needs Task 4).
6. **Task 6** — `transitionUpgradeConsentToIdentity` + `applyUpgradeVerificationResult` (needs Task 4, and Task 2 for the version it promotes to).
7. **Task 7** — retest/attempt-rotation FK hazard introduced by Task 5 (needs Task 4).
8. **Task 8** — DTO fields on both route surfaces (needs Task 2).
9. **Task 9** — `POST /m365/connections/:id/upgrade-consent` (needs Task 5, Task 8).
10. **Task 10** — consent callback upgrade branch (needs Tasks 4, 6).
11. **Task 11** — web card banner + button + parsers + locales (needs Tasks 2, 8, 9).
12. **Task 12** — deploy doc + release note (needs Task 1's GUIDs).
13. **Task 13** — integration coverage (needs Tasks 3–7).
14. **Task 14** — wave verification + PR.

Commit after every task.

---

### Task 1: Verify the four Microsoft Graph app-role GUIDs from the live service principal

Spec §2.1 ("App-role GUIDs are verified at implementation by reading the Microsoft Graph service principal's `appRoles`, never typed from memory").

**Files:**
- Create: `<scratchpad>/graph-app-roles.json` — a throwaway record of the fetched values. **Not committed.** (`<scratchpad>` is the session scratchpad directory; anywhere outside the repo works.)
- Modify: none.
- Test: none (this task produces four constants that Task 2's test asserts).

**Interfaces:**
- Produces: the four verified `appRoleId` GUIDs for `Policy.Read.All`, `RoleManagement.Read.Directory`, `SecurityEvents.Read.All`, `AuditLogsQuery.Read.All`, consumed verbatim by Task 2 (`profiles.ts`, `profiles.test.ts`) and Task 12 (deploy doc table).
- Consumes: any Microsoft Entra tenant access token for `https://graph.microsoft.com`. Reading the Graph service principal's `appRoles` needs no elevated permission — any token for the tenant can do it.

- [ ] **Step 1: Fetch the app roles from the Microsoft Graph service principal**

The Microsoft Graph resource application id is the fixed, well-known `00000003-0000-0000-c000-000000000000`.

```bash
# One tenant token, any tenant. Azure CLI is the least-friction source.
TOKEN="$(az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv)"

curl -sS -H "Authorization: Bearer ${TOKEN}" \
  "https://graph.microsoft.com/v1.0/servicePrincipals?\$filter=appId+eq+'00000003-0000-0000-c000-000000000000'&\$select=appRoles" \
  > /tmp/graph-sp.json

python3 - <<'PY'
import json
wanted = {
    "Policy.Read.All",
    "RoleManagement.Read.Directory",
    "SecurityEvents.Read.All",
    "AuditLogsQuery.Read.All",
}
sp = json.load(open("/tmp/graph-sp.json"))["value"][0]
found = {
    r["value"]: r["id"]
    for r in sp["appRoles"]
    if r["value"] in wanted and "Application" in r.get("allowedMemberTypes", [])
}
missing = wanted - set(found)
assert not missing, f"not found as application roles: {sorted(missing)}"
print(json.dumps(found, indent=2, sort_keys=True))
PY
```

Record the printed object at `<scratchpad>/graph-app-roles.json`. Every one of the four must appear with `allowedMemberTypes` containing `Application` — a delegated-only role with the same name would be the wrong GUID and would never reconcile.

- [ ] **Step 2: Cross-check every GUID against a second independent source**

Open <https://learn.microsoft.com/en-us/graph/permissions-reference> and read the **Identifier** field of each of the four permissions' *application* variant. All four must match the fetched values **character for character**. If any disagrees, stop and resolve the disagreement before writing code — do not average, do not pick one.

If `az` is unavailable, the permissions-reference doc becomes the primary source and the second source is a live Entra "API permissions" blade for an app that already holds the role (the blade shows the role id in the request URL), or `microsoftgraph/msgraph-metadata`'s published metadata. Two independent sources are required either way.

- [ ] **Step 3: Record the four values in the format Task 2 pastes**

Append to `<scratchpad>/graph-app-roles.json` a comment-free block ready to paste, e.g.:

```
AuditLogsQuery.Read.All        -> <fetched guid>
Policy.Read.All                -> <fetched guid>
RoleManagement.Read.Directory  -> <fetched guid>
SecurityEvents.Read.All        -> <fetched guid>
```

There is nothing to commit in this task. Task 2's commit carries the values.

---

### Task 2: Bump `customer-graph-read` to manifest v3 with the four new application permissions

Spec §2.1.

**Files:**
- Modify: `packages/shared/src/m365/profiles.ts` — `customer-graph-read` `version` (line 90), `applicationPermissions` (lines 96-106), `applicationPermissionAssignments` (lines 107-153)
- Test: `packages/shared/src/m365/profiles.test.ts` — `CUSTOMER_GRAPH_READ_ASSIGNMENTS` (lines 10-56) and the `defines the exact version 2 …` case (lines 59-67)
- Modify (blast radius, same commit): `apps/web/src/components/integrations/M365CustomerGraphReadCard.test.tsx` — `REQUIRED_GRANTS` (lines 98-114), the `manifestVersion: 2` fixtures (lines 120, 136), and the `renders the exact nine fixed permissions…` case (lines 179-196)
- Modify (blast radius, same commit): `apps/api/src/routes/m365CustomerGraphRead.test.ts` — `permissionManifestVersion: 2` / `manifestVersion: 2` fixtures (lines 106, 162, 187, 204, 304, 331, 369)
- Modify (blast radius, same commit): `apps/api/src/routes/m365ConsentCallback.test.ts` — `manifestVersion: 2` fixtures (lines 285, 343, 549, 565, 719)
- Modify (blast radius, same commit): `apps/api/src/services/m365ControlPlane/connectionService.test.ts` — `permissionManifestVersion: 2` fixtures (lines 209, 231, 246, 341, 454, 522)
- Modify (blast radius, same commit): `apps/api/src/__tests__/integration/m365ConnectionLifecycle.integration.test.ts` — `permissionManifestVersion: 2` (lines 98, 116, 129, 167)

**Interfaces:**
- Produces: `M365_PERMISSION_PROFILES['customer-graph-read'].version === 3` and thirteen entries in `applicationPermissions` / `applicationPermissionAssignments`. Consumed by `deriveGrantHealth` (`connectionService.ts:110-155`), the route envelopes (`m365CustomerGraphRead.ts:126-130`), and `matchesTrustedManifest` in both web cards.
- Consumes: the four GUIDs recorded in Task 1.
- Signature unchanged: `getM365PermissionProfile(id: M365ConnectionProfile): M365PermissionProfileManifest`.

**Why v2 fixtures go red rather than being pinned:** `deriveGrantHealth` compares `row.permissionManifestVersion !== currentManifest.version` first (`connectionService.ts:137`), so every fixture that claims a healthy v2 connection now derives `manifest-stale`. That is the behaviour this whole wave exists to produce. Update the fixtures to 3 where they model a *current* connection; keep 2 only where the test is specifically about a stale row.

- [ ] **Step 1: Write the failing manifest test**

Replace `CUSTOMER_GRAPH_READ_ASSIGNMENTS` in `packages/shared/src/m365/profiles.test.ts` (lines 10-56) with the thirteen-entry alphabetised list, and replace the version assertion. Paste the four GUIDs from `<scratchpad>/graph-app-roles.json` in place of every `<VERIFIED …>` token — the file must not contain a `<` after this step.

```ts
const CUSTOMER_GRAPH_READ_ASSIGNMENTS = [
  {
    resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
    appRoleId: '9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30',
    value: 'Application.Read.All',
  },
  {
    resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
    appRoleId: 'b0afded3-3588-46d8-8b3d-9842eff778da',
    value: 'AuditLog.Read.All',
  },
  {
    resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
    appRoleId: '<VERIFIED AuditLogsQuery.Read.All appRoleId from Task 1>',
    value: 'AuditLogsQuery.Read.All',
  },
  {
    resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
    appRoleId: '7438b122-aefc-4978-80ed-43db9fcc7715',
    value: 'Device.Read.All',
  },
  {
    resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
    appRoleId: 'dc377aa6-52d8-4e23-b271-2a7ae04cedf3',
    value: 'DeviceManagementConfiguration.Read.All',
  },
  {
    resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
    appRoleId: '2f51be20-0bb4-4fed-bf7b-db946066c75e',
    value: 'DeviceManagementManagedDevices.Read.All',
  },
  {
    resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
    appRoleId: '5b567255-7703-4780-807c-7be8301ae99b',
    value: 'Group.Read.All',
  },
  {
    resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
    appRoleId: '498476ce-e0fe-48b0-b801-37ba7e2685c6',
    value: 'Organization.Read.All',
  },
  {
    resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
    appRoleId: '<VERIFIED Policy.Read.All appRoleId from Task 1>',
    value: 'Policy.Read.All',
  },
  {
    resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
    appRoleId: '<VERIFIED RoleManagement.Read.Directory appRoleId from Task 1>',
    value: 'RoleManagement.Read.Directory',
  },
  {
    resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
    appRoleId: '<VERIFIED SecurityEvents.Read.All appRoleId from Task 1>',
    value: 'SecurityEvents.Read.All',
  },
  {
    resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
    appRoleId: '332a536c-c7ef-4017-ab91-336970924f0d',
    value: 'Sites.Read.All',
  },
  {
    resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
    appRoleId: 'df021288-bdef-4463-88db-98f22de89214',
    value: 'User.Read.All',
  },
] as const;
```

Replace the version-2 case (lines 58-67) with:

```ts
describe('shared M365 permission profiles', () => {
  it('defines the exact version 3 customer Graph read assignments', () => {
    const profile = M365_PERMISSION_PROFILES['customer-graph-read'];

    expect(profile.version).toBe(3);
    expect(profile.applicationPermissionAssignments).toEqual(CUSTOMER_GRAPH_READ_ASSIGNMENTS);
    expect(profile.applicationPermissions).toEqual(
      CUSTOMER_GRAPH_READ_ASSIGNMENTS.map(({ value }) => value),
    );
  });

  it('adds exactly the four tenant-sync scopes on top of the v2 set', () => {
    // Asserted as an exact delta rather than with toContain, so ADDING a fifth
    // scope fails too: every application permission on this profile is granted
    // tenant-wide by a customer's Global Administrator, and the whole point of
    // one manifest bump is that the set is deliberate (spec §2.1).
    const v2 = [
      'Application.Read.All', 'AuditLog.Read.All', 'Device.Read.All',
      'DeviceManagementConfiguration.Read.All', 'DeviceManagementManagedDevices.Read.All',
      'Group.Read.All', 'Organization.Read.All', 'Sites.Read.All', 'User.Read.All',
    ];
    const profile = M365_PERMISSION_PROFILES['customer-graph-read'];
    const added = profile.applicationPermissions.filter((value) => !v2.includes(value));
    expect([...added].sort()).toEqual([
      'AuditLogsQuery.Read.All',
      'Policy.Read.All',
      'RoleManagement.Read.Directory',
      'SecurityEvents.Read.All',
    ]);
    expect(profile.applicationPermissions).toHaveLength(13);
  });

  it('flags every stored v2 row for consent reconciliation', () => {
    expect(connectionNeedsConsentReconciliation('customer-graph-read', 2)).toBe(true);
    expect(connectionNeedsConsentReconciliation('customer-graph-read', 3)).toBe(false);
  });

  it('gives every assignment a real GUID on the Microsoft Graph resource app', () => {
    // A typo'd appRoleId produces a permanent grant_missing that no customer
    // administrator can ever clear, because the role they approve is not the
    // role Breeze reconciles against.
    const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const profile = M365_PERMISSION_PROFILES['customer-graph-read'];
    const ids = new Set<string>();
    for (const grant of profile.applicationPermissionAssignments ?? []) {
      expect(grant.resourceApplicationId).toBe('00000003-0000-0000-c000-000000000000');
      expect(grant.appRoleId).toMatch(guid);
      ids.add(grant.appRoleId);
    }
    expect(ids.size).toBe(13);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/shared && npx vitest run src/m365/profiles.test.ts
```
Expected: FAIL — `expected 2 to be 3` on the version assertion, and `applicationPermissionAssignments` reported as a 9-element array against the 13-element expectation.

- [ ] **Step 3: Bump the manifest**

In `packages/shared/src/m365/profiles.ts`, replace `version: 2,` on line 90 with the commented bump, replace the `applicationPermissions` array (lines 96-106), and append four assignment objects before the closing `]` of `applicationPermissionAssignments` (line 153), keeping both lists alphabetised and in the same order. Paste the same verified GUIDs.

```ts
  'customer-graph-read': {
    id: 'customer-graph-read',
    // v3 (2026-09-08): tenant-sync foundation, spec §2.1. Four application
    // permissions added in ONE bump so customers re-consent once for the whole
    // posture program: Policy.Read.All (conditional access + named locations,
    // chosen over Policy.Read.ConditionalAccess so CA templates need no second
    // re-consent), RoleManagement.Read.Directory (admin role membership),
    // SecurityEvents.Read.All (Secure Score), AuditLogsQuery.Read.All (the
    // unified audit log tool, granted now rather than in a second wave).
    // MFA registration state and role-assignable group expansion need no new
    // scope — AuditLog.Read.All and Group.Read.All already cover them.
    version: 3,
    ownerAxis: 'organization',
    authMode: 'application-certificate',
    credentialDomain: 'customer-graph-read',
    executor: 'graph-read',
    delegatedPermissions: [],
    applicationPermissions: [
      'Application.Read.All',
      'AuditLog.Read.All',
      'AuditLogsQuery.Read.All',
      'Device.Read.All',
      'DeviceManagementConfiguration.Read.All',
      'DeviceManagementManagedDevices.Read.All',
      'Group.Read.All',
      'Organization.Read.All',
      'Policy.Read.All',
      'RoleManagement.Read.Directory',
      'SecurityEvents.Read.All',
      'Sites.Read.All',
      'User.Read.All',
    ],
```

and in `applicationPermissionAssignments`, in alphabetical position:

```ts
      {
        resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
        appRoleId: '<VERIFIED AuditLogsQuery.Read.All appRoleId from Task 1>',
        value: 'AuditLogsQuery.Read.All',
      },
```
(after `AuditLog.Read.All`), and

```ts
      {
        resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
        appRoleId: '<VERIFIED Policy.Read.All appRoleId from Task 1>',
        value: 'Policy.Read.All',
      },
      {
        resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
        appRoleId: '<VERIFIED RoleManagement.Read.Directory appRoleId from Task 1>',
        value: 'RoleManagement.Read.Directory',
      },
      {
        resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
        appRoleId: '<VERIFIED SecurityEvents.Read.All appRoleId from Task 1>',
        value: 'SecurityEvents.Read.All',
      },
```
(after `Organization.Read.All`, before `Sites.Read.All`).

- [ ] **Step 4: Run the shared test to verify it passes**

```bash
cd packages/shared && npx vitest run src/m365/profiles.test.ts
```
Expected: PASS. Then confirm no GUID placeholder survived:
```bash
grep -n '<VERIFIED' packages/shared/src/m365/profiles.ts packages/shared/src/m365/profiles.test.ts
```
Expected: no output.

- [ ] **Step 5: Fix the fixture blast radius**

```bash
cd apps/web && npx vitest run src/components/integrations/M365CustomerGraphReadCard.test.tsx
```
Expected before fixing: FAIL — `matchesTrustedManifest` now rejects the 9-grant envelope, so `parseEnvelope` returns `null`, the card renders `loadState === "error"`, and nearly every case fails on a missing heading.

In `M365CustomerGraphReadCard.test.tsx`, extend `REQUIRED_GRANTS` (lines 98-114) with the four new `[appRoleId, value]` pairs in the same alphabetical order as the manifest, change `manifestVersion: 2` to `3` at lines 120 and 136, and update the count case:

```ts
  it("renders the exact thirteen fixed permissions and no credential inputs for an empty envelope", async () => {
    fetchWithAuthMock.mockResolvedValue(makeResponse(envelope()));

    render(<M365CustomerGraphReadCard />);

    expect(
      await screen.findByRole("heading", { name: "Customer Graph Read" }),
    ).toBeInTheDocument();
    for (const grant of REQUIRED_GRANTS) {
      expect(screen.getByText(grant.value)).toBeInTheDocument();
    }
    expect(screen.getAllByTestId("required-grant")).toHaveLength(13);
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryByLabelText(/client secret|certificate|vault/i)).not.toBeInTheDocument();
    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      `/m365/connections?orgId=${ORG_A}`,
    );
  });
```

In the four API test files listed under **Files**, change every `permissionManifestVersion: 2` / `manifestVersion: 2` that models a *healthy, current* connection to `3`. The single exception is `connectionService.test.ts:282`, which asserts `manifest-stale` for a deliberately stale row — leave its `permissionManifestVersion: 1` alone.

- [ ] **Step 6: Run every affected suite**

```bash
cd packages/shared && npx vitest run src/m365
cd apps/api && npx vitest run src/services/m365ControlPlane src/routes/m365
cd apps/web && npx vitest run src/components/integrations
```
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/m365/profiles.ts packages/shared/src/m365/profiles.test.ts \
  apps/web/src/components/integrations/M365CustomerGraphReadCard.test.tsx \
  apps/api/src/routes/m365CustomerGraphRead.test.ts \
  apps/api/src/routes/m365ConsentCallback.test.ts \
  apps/api/src/services/m365ControlPlane/connectionService.test.ts \
  apps/api/src/__tests__/integration/m365ConnectionLifecycle.integration.test.ts && \
git commit -m "feat(m365): bump customer-graph-read manifest to v3 with four tenant-sync scopes" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 3: Add `m365_consent_sessions.purpose` — migration, Drizzle column, export-policy registration

Spec §2.2 ("Define how the callback distinguishes an upgrade session from a first-time session").

**Files:**
- Create: `apps/api/migrations/2026-10-15-090000-m365-consent-session-purpose.sql`
- Modify: `apps/api/src/db/schema/m365.ts` — new `M365ConsentPurpose` type near line 101, `purpose` column in `m365ConsentSessions` (after line 118), `purposeCheck` in the table config (after line 154)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` — the `m365_consent_sessions` entry (line 295)
- Test: `apps/api/src/db/schema/m365ConsentSessionPurpose.test.ts` (create)

**Interfaces:**
- Produces: `export type M365ConsentPurpose = 'initial' | 'upgrade';` from `apps/api/src/db/schema/m365.ts`, and `m365ConsentSessions.purpose`. Consumed by Task 4 (`consentSessionService.ts`), Task 6 (`connectionService.ts`), Task 10 (`m365ConsentCallback.ts`).
- Consumes: nothing.

**Migration name check.** `ls apps/api/migrations | sort | tail -1` reports `2026-10-14-100500-ai-operator-task-client-idempotency.sql` as of 2026-09-08. `2026-10-15-090000-…` sorts strictly after it. Re-run the command before creating the file; if the tail has moved past 2026-10-15, pick the next day and update every reference below. Do **not** use today's calendar date — shipped filenames run more than two weeks ahead of real time (CLAUDE.md).

**No `breeze.scope` needed.** The migration is pure DDL: `ADD COLUMN` with a constant default plus a `CHECK`. It runs no `SELECT`/`UPDATE`/`DELETE`, so the `migrationRlsScope` guard does not apply and no `set_config('breeze.scope', 'system', true)` line belongs in it.

- [ ] **Step 1: Write the failing schema/registration test**

Create `apps/api/src/db/schema/m365ConsentSessionPurpose.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import { m365ConsentSessions } from './m365';
import { CORE_TENANT_EXPORT_POLICY } from '../../services/tenantExportPolicyRegistry';

const MIGRATION = join(
  __dirname,
  '../../../migrations/2026-10-15-090000-m365-consent-session-purpose.sql',
);

describe('m365_consent_sessions.purpose', () => {
  it('exists on the Drizzle table with an initial default', () => {
    const columns = getTableColumns(m365ConsentSessions);
    expect(columns.purpose).toBeDefined();
    expect(columns.purpose.name).toBe('purpose');
    expect(columns.purpose.notNull).toBe(true);
    expect(columns.purpose.default).toBe('initial');
  });

  it('is classified in the tenant export policy', () => {
    // m365_consent_sessions is in CORE_ORG_CASCADE_DELETE_ORDER, so every one
    // of its columns must be bucketed or tenant-export-policy.integration
    // fails — the registration list that fires on a new COLUMN, not just a new
    // table (CLAUDE.md).
    const policy = CORE_TENANT_EXPORT_POLICY['m365_consent_sessions'];
    expect(policy).toBeDefined();
    expect(policy!.columns['purpose']).toBe('included');
  });

  it('ships an idempotent migration that constrains the two legal values', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS purpose');
    expect(sql).toContain("DEFAULT 'initial'");
    expect(sql).toContain('m365_consent_sessions_purpose_check');
    expect(sql).toContain("CHECK (purpose IN ('initial', 'upgrade'))");
    // autoMigrate wraps each file in client.begin(...) — an inner transaction
    // emits "there is already a transaction in progress" and serves nothing.
    expect(sql).not.toMatch(/^\s*BEGIN;/m);
    expect(sql).not.toMatch(/^\s*COMMIT;/m);
  });
});
```

> `CORE_TENANT_EXPORT_POLICY` entries are built by `tablePolicy(orgKey, groups)`; read `apps/api/src/services/tenantExportPolicyRegistry.ts:17` for the exact shape the helper returns and adjust `policy!.columns['purpose']` to whatever field name that helper actually produces (`columns`, `decisions`, …). Do not guess — read it, then write the assertion against the real shape.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/api && npx vitest run src/db/schema/m365ConsentSessionPurpose.test.ts
```
Expected: FAIL — `expected undefined to be defined` for `columns.purpose`, and `ENOENT` opening the migration path.

- [ ] **Step 3: Write the migration**

Create `apps/api/migrations/2026-10-15-090000-m365-consent-session-purpose.sql`:

```sql
-- M365 tenant sync foundation, spec §2.2 — distinguish a first-time consent
-- session from a manifest UPGRADE consent session.
--
-- Why a column and not an inference from connection status: an upgrade session
-- is minted against an ACTIVE connection and must never move it to
-- pending-consent, so the callback has to know which flow it is resuming
-- BEFORE it decides which connection statuses are legal. Inferring it from the
-- connection's current status would make the callback's behaviour depend on a
-- row that a concurrent re-consent can change underneath it.
--
-- DDL only: no DML, so no breeze.scope setting is required. Existing rows are
-- all first-time sessions, which is exactly the DEFAULT.

ALTER TABLE m365_consent_sessions
  ADD COLUMN IF NOT EXISTS purpose varchar(16) NOT NULL DEFAULT 'initial';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'm365_consent_sessions_purpose_check'
      AND conrelid = 'public.m365_consent_sessions'::regclass
  ) THEN
    ALTER TABLE m365_consent_sessions
      ADD CONSTRAINT m365_consent_sessions_purpose_check
      CHECK (purpose IN ('initial', 'upgrade'));
  END IF;
END $$;
```

Verify the name:
```bash
bash scripts/check-migration-naming.sh --staged
```
(run it after `git add` of the migration in Step 6; it only inspects staged additions).

- [ ] **Step 4: Add the Drizzle column and check constraint**

In `apps/api/src/db/schema/m365.ts`, after line 101 (`export type M365ConsentPhase = …`):

```ts
/**
 * Which flow a consent session belongs to. `initial` is a first-time (or
 * full re-)consent that moves the connection through pending-consent →
 * verifying. `upgrade` is a manifest bump on a connection that stays
 * executable for the whole flow (spec §2.2) — the callback must never call
 * markConsentAttemptFailed on one, because that sets status = 'pending-consent'
 * and would take a live connection out of service on a cancelled consent.
 */
export type M365ConsentPurpose = 'initial' | 'upgrade';
```

Inside `m365ConsentSessions`, after `codeVerifier` (line 118):

```ts
    purpose: varchar('purpose', { length: 16 })
      .$type<M365ConsentPurpose>()
      .notNull()
      .default('initial'),
```

In the table config, after `phaseFieldsCheck` (line 168):

```ts
    purposeCheck: check(
      'm365_consent_sessions_purpose_check',
      sql`${t.purpose} IN ('initial', 'upgrade')`,
    ),
```

- [ ] **Step 5: Register the column in the export policy**

In `apps/api/src/services/tenantExportPolicyRegistry.ts` line 295, add `"purpose"` to the `included` array of the `m365_consent_sessions` entry (a two-value enum naming a flow, not a secret and not an open container):

```ts
  "m365_consent_sessions": tablePolicy("org_id", {"included":["id","phase","purpose","connection_id","org_id","profile","consent_attempt_id","user_id","expires_at","created_at"],"reviewedIncluded":[],"excludedSensitive":["state_hash","tenant_hint_hash","nonce","code_verifier"],"excludedOpen":[]}),
```

- [ ] **Step 6: Run the test, drift check, and naming guard**

```bash
cd apps/api && npx vitest run src/db/schema/m365ConsentSessionPurpose.test.ts src/db/autoMigrate.test.ts
```
Expected: PASS.

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm --filter @breeze/api db:migrate && pnpm --filter @breeze/api db:check-drift
```
Expected: migration applies, drift check reports no drift. (Needs a local Postgres; if none is running, note it and let the Integration Tests job cover it — do not skip the drift check silently.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-10-15-090000-m365-consent-session-purpose.sql \
  apps/api/src/db/schema/m365.ts \
  apps/api/src/db/schema/m365ConsentSessionPurpose.test.ts \
  apps/api/src/services/tenantExportPolicyRegistry.ts && \
bash scripts/check-migration-naming.sh --staged && \
git commit -m "feat(m365): add purpose to m365_consent_sessions for upgrade consent" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 4: Consent-session service — carry `purpose`, read it without consuming, delete by connection

Spec §2.2.

**Files:**
- Modify: `apps/api/src/services/m365ControlPlane/consentSessionService.ts` — imports (lines 4-9), `ConsentSessionOwnerInput` (lines 24-30), `insertConsentSessionInTransaction` (lines 70-91), `createAdminConsentSessionInTransaction` (lines 98-108), `insertPreparedIdentityVerificationSessionInTransaction` (lines 149-168); append two new exports after line 222
- Test: `apps/api/src/services/m365ControlPlane/consentSessionService.test.ts` (existing)

**Interfaces:**
- Produces:
```ts
export type { M365ConsentPurpose } from '../../db/schema';
export interface ConsentSessionPurposeLookup {
  rawState: string;
  phase: M365ConsentPhase;
  connectionId: string;
  consentAttemptId: string;
  profile: M365ConsentSessionProfile;
}
export async function readConsentSessionPurpose(
  input: ConsentSessionPurposeLookup,
): Promise<M365ConsentPurpose | null>;
export async function deleteConsentSessionsForConnection(input: {
  connectionId: string;
  orgId: string;
  profile: M365ConsentSessionProfile;
}): Promise<void>;
```
  plus `ConsentSessionOwnerInput.purpose?: M365ConsentPurpose`. Consumed by Task 5, Task 6, Task 7, Task 10.
- Consumes: `M365ConsentPurpose` from Task 3.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/services/m365ControlPlane/consentSessionService.test.ts`, matching whatever `db` mock the file already installs (read its top-of-file `vi.mock('../../db', …)` and reuse it verbatim — do not introduce a second mocking style):

```ts
describe('consent session purpose', () => {
  it('defaults an admin consent session to the initial flow', async () => {
    const { values } = captureInsert();               // existing helper in this file
    await createAdminConsentSession({
      connectionId: CONNECTION_ID,
      orgId: ORG_ID,
      consentAttemptId: ATTEMPT_ID,
      userId: USER_ID,
      profile: 'customer-graph-read',
    });
    expect(values.purpose).toBe('initial');
  });

  it('stamps an upgrade admin consent session as an upgrade', async () => {
    const { values } = captureInsert();
    await createAdminConsentSession({
      connectionId: CONNECTION_ID,
      orgId: ORG_ID,
      consentAttemptId: ATTEMPT_ID,
      userId: USER_ID,
      profile: 'customer-graph-read',
      purpose: 'upgrade',
    });
    expect(values.purpose).toBe('upgrade');
  });

  it('carries the purpose onto the identity-verification session', async () => {
    const { values } = captureInsert();
    await insertPreparedIdentityVerificationSessionInTransaction({
      connectionId: CONNECTION_ID,
      orgId: ORG_ID,
      consentAttemptId: ATTEMPT_ID,
      userId: USER_ID,
      profile: 'customer-graph-read',
      purpose: 'upgrade',
    }, prepareIdentityVerificationSession({ tenantHint: TENANT_ID }));
    expect(values.purpose).toBe('upgrade');
  });

  it('reads a purpose without deleting the session', async () => {
    // The callback needs the purpose BEFORE it decides which connection
    // statuses are legal; the authoritative consume happens later and
    // re-checks every binding column. This lookup is a router, never an
    // authorization — so it must not consume.
    const deleted: unknown[] = [];
    stubSelect([{ purpose: 'upgrade' }]);              // existing helper
    onDelete((where) => { deleted.push(where); return []; });
    const purpose = await readConsentSessionPurpose({
      rawState: 'raw-state',
      phase: 'admin_consent',
      connectionId: CONNECTION_ID,
      consentAttemptId: ATTEMPT_ID,
      profile: 'customer-graph-read',
    });
    expect(purpose).toBe('upgrade');
    expect(deleted).toHaveLength(0);
  });

  it('returns null when no live session matches', async () => {
    stubSelect([]);
    await expect(readConsentSessionPurpose({
      rawState: 'raw-state',
      phase: 'admin_consent',
      connectionId: CONNECTION_ID,
      consentAttemptId: ATTEMPT_ID,
      profile: 'customer-graph-read',
    })).resolves.toBeNull();
  });

  it('deletes every session of a connection regardless of attempt', async () => {
    // Used before an attempt-id rotation, which has no ON UPDATE CASCADE: an
    // upgrade session on an executable connection would otherwise raise 23503.
    const wheres: unknown[] = [];
    onDelete((where) => { wheres.push(where); return []; });
    await deleteConsentSessionsForConnection({
      connectionId: CONNECTION_ID,
      orgId: ORG_ID,
      profile: 'customer-graph-read',
    });
    expect(wheres).toHaveLength(1);
  });
});
```

If the helper names above (`captureInsert`, `stubSelect`, `onDelete`) do not exist under those names, read the file's existing `describe` blocks and reuse whatever capture helpers it already has. Do not add a second mocking style.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/api && npx vitest run src/services/m365ControlPlane/consentSessionService.test.ts
```
Expected: FAIL — `readConsentSessionPurpose is not a function` / `deleteConsentSessionsForConnection is not a function`, and `expect(values.purpose).toBe('initial')` receiving `undefined`.

- [ ] **Step 3: Carry the purpose through the inserts**

In `apps/api/src/services/m365ControlPlane/consentSessionService.ts`, extend the schema import (lines 4-9) with `M365ConsentPurpose`:

```ts
import {
  m365ConsentSessions,
  type M365ConsentPhase,
  type M365ConsentPurpose,
  type M365ConsentSessionRow,
  type NewM365ConsentSessionRow,
} from '../../db/schema';

export type { M365ConsentPurpose };
```

Extend `ConsentSessionOwnerInput` (lines 24-30):

```ts
export interface ConsentSessionOwnerInput {
  connectionId: string;
  orgId: string;
  consentAttemptId: string;
  userId: string;
  profile: M365ConsentSessionProfile;
  /**
   * Which flow this session belongs to. Omitted means `initial`: the
   * pending-consent → verifying path. `upgrade` marks a manifest bump on a
   * connection that stays executable throughout (spec §2.2).
   */
  purpose?: M365ConsentPurpose;
}
```

In `insertConsentSessionInTransaction` (line 80), make the value explicit rather than relying on the spread plus the column default:

```ts
    const rows = await db.insert(m365ConsentSessions).values({
      ...input,
      stateHash: sha256Hex(rawState),
      profile: input.profile,
      purpose: input.purpose ?? 'initial',
      expiresAt,
    }).onConflictDoNothing({
      target: m365ConsentSessions.stateHash,
    }).returning();
```

And in `insertPreparedIdentityVerificationSessionInTransaction` (line 153):

```ts
  const rows = await db.insert(m365ConsentSessions).values({
    ...input,
    stateHash: sha256Hex(prepared.rawState),
    profile: input.profile,
    purpose: input.purpose ?? 'initial',
    phase: 'identity_verification',
    tenantHintHash: prepared.tenantHintHash,
    nonce: prepared.nonce,
    codeVerifier: prepared.codeVerifier,
    expiresAt: prepared.expiresAt,
  }).onConflictDoNothing({
    target: m365ConsentSessions.stateHash,
  }).returning();
```

- [ ] **Step 4: Add the purpose lookup and the by-connection delete**

Append to `apps/api/src/services/m365ControlPlane/consentSessionService.ts`:

```ts
export interface ConsentSessionPurposeLookup {
  rawState: string;
  phase: M365ConsentPhase;
  connectionId: string;
  consentAttemptId: string;
  profile: M365ConsentSessionProfile;
}

/**
 * Reads which flow a live consent session belongs to WITHOUT consuming it.
 *
 * The callback must know this before it can decide which connection statuses
 * are legal for the callback it is servicing — an upgrade session expects an
 * `active`/`degraded` connection, a first-time session expects
 * `pending-consent`/`verifying`. The authoritative consume happens afterwards
 * and re-checks state hash, phase, expiry, connection, org, profile and
 * attempt, so this lookup routes and never authorizes. Deliberately not scoped
 * by org: the org id is not known until the attempt is loaded, and state_hash
 * is unique.
 */
export async function readConsentSessionPurpose(
  input: ConsentSessionPurposeLookup,
): Promise<M365ConsentPurpose | null> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const rows = await db.select({ purpose: m365ConsentSessions.purpose })
      .from(m365ConsentSessions)
      .where(and(
        eq(m365ConsentSessions.stateHash, sha256Hex(input.rawState)),
        eq(m365ConsentSessions.phase, input.phase),
        gt(m365ConsentSessions.expiresAt, sql`now()`),
        eq(m365ConsentSessions.connectionId, input.connectionId),
        eq(m365ConsentSessions.profile, input.profile),
        eq(m365ConsentSessions.consentAttemptId, input.consentAttemptId),
      ))
      .limit(1);
    return rows[0]?.purpose ?? null;
  }));
}

/**
 * Deletes every consent session of a connection, whatever attempt it belongs
 * to. Needed before any write that rotates `consent_attempt_id`: the composite
 * FK `m365_consent_sessions_connection_identity_fkey` has ON DELETE CASCADE
 * but NO ON UPDATE CASCADE, so rotating the parent while a session lives
 * raises 23503 rather than cascading. Before upgrade consent existed, an
 * executable connection never carried a live session and no caller needed
 * this — see connectionService.retestConnection.
 */
export async function deleteConsentSessionsForConnection(input: {
  connectionId: string;
  orgId: string;
  profile: M365ConsentSessionProfile;
}): Promise<void> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    await db.delete(m365ConsentSessions).where(and(
      eq(m365ConsentSessions.connectionId, input.connectionId),
      eq(m365ConsentSessions.orgId, input.orgId),
      eq(m365ConsentSessions.profile, input.profile),
    ));
  }));
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd apps/api && npx vitest run src/services/m365ControlPlane/consentSessionService.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/m365ControlPlane/consentSessionService.ts \
  apps/api/src/services/m365ControlPlane/consentSessionService.test.ts && \
git commit -m "feat(m365): carry consent-session purpose and add a non-consuming purpose lookup" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 5: `initiateUpgradeConsent` — mint an admin-consent session on a live connection without touching status

Spec §2.2 item 2.

**Files:**
- Modify: `apps/api/src/services/m365ControlPlane/connectionService.ts` — `ConnectionLifecycleErrorCode` (lines 93-97), `ConnectionService` interface (lines 226-262), new function inside `createConnectionService` after `initiateConsent` (line 452), returned object (lines 758-769), read-profile aliases (lines 795-806)
- Modify: `apps/api/src/services/m365ControlPlane/writeActionConnectionService.ts` — no new alias needed this wave (the actions upgrade route is out of scope), but the factory return type gains the member, so confirm the file still typechecks
- Test: `apps/api/src/services/m365ControlPlane/connectionService.test.ts` (existing)

**Interfaces:**
- Produces:
```ts
export interface InitiateUpgradeConsentInput {
  connectionId: string;
  orgId: string;
  auth: AuthContext;
}
// on ConnectionService<P, Client>:
initiateUpgradeConsent(input: InitiateUpgradeConsentInput): Promise<InitiatedConsent<P>>;
// read-profile alias:
export const initiateCustomerGraphReadUpgradeConsent =
  readConnectionService.initiateUpgradeConsent;
```
  Consumed by Task 9 (`m365CustomerGraphRead.ts`).
- Consumes: `createAdminConsentSessionInTransaction` and `deleteConsentSessionsForAttemptInTransaction` (already imported at `connectionService.ts:17-22`), now with `purpose: 'upgrade'` from Task 4.

**Contract deviation, recorded:** the overview's shared contract writes the signature as `(input: { connectionId; orgId; auth; returnTo? })`. `returnTo` is dropped — the callback's terminal redirect is a fixed `/integrations#m365/<profile>` base (`m365ConsentCallback.ts:348`), there is no return-to plumbing anywhere in the two-phase flow, and adding a caller-supplied redirect target to a consent callback is an open-redirect surface that would need its own allowlist. Task 14's PR body records the deviation.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/m365ControlPlane/connectionService.test.ts`. First extend the hoisted `columns` object (lines 57-61) with the two columns the upgrade path touches, and the hoisted `consentMocks` with the by-connection delete:

```ts
  columns: {
    id: { name: 'id' }, orgId: { name: 'org_id' }, tenantId: { name: 'tenant_id' },
    clientId: { name: 'client_id' }, profile: { name: 'profile' },
    consentAttemptId: { name: 'consent_attempt_id' }, status: { name: 'status' },
    consentGeneration: { name: 'consent_generation' },
    permissionManifestVersion: { name: 'permission_manifest_version' },
  },
```

then the cases:

```ts
describe('initiateUpgradeConsent', () => {
  const EXECUTABLE = {
    id: '11111111-1111-4111-8111-111111111111',
    orgId: '22222222-2222-4222-8222-222222222222',
    tenantId: '33333333-3333-4333-8333-333333333333',
    clientId: '44444444-4444-4444-8444-444444444444',
    profile: 'customer-graph-read',
    permissionManifestVersion: 2,
    observedGrants: [],
    consentAttemptId: '55555555-5555-4555-8555-555555555555',
    grantsVerifiedAt: new Date('2026-09-01T00:00:00.000Z'),
    displayName: 'Contoso',
    status: 'active',
    lastVerifiedAt: new Date('2026-09-01T00:00:00.000Z'),
    lastErrorCode: null,
  };

  it('binds the session to the EXISTING attempt and never writes status', async () => {
    dbMocks.selectResults = [[EXECUTABLE], [EXECUTABLE]];
    const initiated = await initiateCustomerGraphReadUpgradeConsent({
      connectionId: EXECUTABLE.id,
      orgId: EXECUTABLE.orgId,
      auth: authFixture(),
    });

    expect(consentMocks.createAdmin).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: EXECUTABLE.id,
      orgId: EXECUTABLE.orgId,
      consentAttemptId: EXECUTABLE.consentAttemptId,
      purpose: 'upgrade',
    }));
    // The whole point of the transition: no UPDATE on m365_connections at all,
    // so an abandoned upgrade cannot strand a working connection in
    // pending-consent (spec §2.2).
    expect(dbMocks.updateSets).toHaveLength(0);
    expect(initiated.connection.status).toBe('active');
    expect(initiated.connection.consentAttemptId).toBe(EXECUTABLE.consentAttemptId);
    expect(initiated.consentUrl).toContain('https://login.microsoftonline.com/common/adminconsent');
    expect(initiated.consentUrl).toContain('state=');
  });

  it('supersedes an abandoned upgrade session before minting a new one', async () => {
    dbMocks.selectResults = [[EXECUTABLE], [EXECUTABLE]];
    await initiateCustomerGraphReadUpgradeConsent({
      connectionId: EXECUTABLE.id,
      orgId: EXECUTABLE.orgId,
      auth: authFixture(),
    });
    expect(dbMocks.order.indexOf('delete-session'))
      .toBeLessThan(dbMocks.order.indexOf('insert-session'));
  });

  it('serializes against re-consent on the same owner/profile advisory lock', async () => {
    dbMocks.selectResults = [[EXECUTABLE], [EXECUTABLE]];
    await initiateCustomerGraphReadUpgradeConsent({
      connectionId: EXECUTABLE.id,
      orgId: EXECUTABLE.orgId,
      auth: authFixture(),
    });
    expect(dbMocks.order[0]).toBe('lock');
  });

  it('refuses a connection that is not executable', async () => {
    dbMocks.selectResults = [[]];
    await expect(initiateCustomerGraphReadUpgradeConsent({
      connectionId: EXECUTABLE.id,
      orgId: EXECUTABLE.orgId,
      auth: authFixture(),
    })).rejects.toMatchObject({ code: 'connection_not_found' });
    expect(consentMocks.createAdmin).not.toHaveBeenCalled();
  });

  it('refuses when the stored manifest is already current', async () => {
    // Nothing to approve; minting a consent URL would send an administrator to
    // Microsoft to re-approve what they already approved.
    dbMocks.selectResults = [[{ ...EXECUTABLE, permissionManifestVersion: 3 }]];
    await expect(initiateCustomerGraphReadUpgradeConsent({
      connectionId: EXECUTABLE.id,
      orgId: EXECUTABLE.orgId,
      auth: authFixture(),
    })).rejects.toMatchObject({ code: 'manifest_current' });
    expect(consentMocks.createAdmin).not.toHaveBeenCalled();
  });
});
```

`authFixture()` must return the same `AuthContext` shape the file's existing retest cases pass — reuse that helper; if it is inline in those cases, hoist it rather than inventing a second one.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/api && npx vitest run src/services/m365ControlPlane/connectionService.test.ts -t 'initiateUpgradeConsent'
```
Expected: FAIL — `initiateCustomerGraphReadUpgradeConsent is not a function`.

- [ ] **Step 3: Add the error code and the interface member**

In `connectionService.ts`, extend `ConnectionLifecycleErrorCode` (lines 93-97):

```ts
export type ConnectionLifecycleErrorCode =
  | 'connection_not_found'
  | 'connection_not_executable'
  | 'stale_attempt'
  | 'tenant_already_bound'
  | 'manifest_current';
```

Add the input type next to `InitiateConsentInput` (line 215):

```ts
export interface InitiateUpgradeConsentInput {
  connectionId: string;
  orgId: string;
  /**
   * The caller's exact scope. The connection is loaded under it so RLS — not
   * an app-layer org comparison — is what proves the caller may touch this
   * row, mirroring loadRetestSnapshot.
   */
  auth: AuthContext;
}
```

Add to the `ConnectionService` interface (after `initiateConsent`, line 227):

```ts
  initiateUpgradeConsent(input: InitiateUpgradeConsentInput): Promise<InitiatedConsent<P>>;
```

- [ ] **Step 4: Implement the transition**

Insert into `createConnectionService`, immediately after `initiateConsent` ends (line 452):

```ts
  /**
   * Starts a manifest UPGRADE consent on an already-executable connection.
   *
   * Differs from initiateConsent in the two ways that matter (spec §2.2):
   *   - it does not rotate `consent_attempt_id`, so the session binds to the
   *     EXISTING attempt through the composite FK; and
   *   - it writes nothing to m365_connections at all, so an administrator who
   *     abandons the Microsoft flow leaves a fully working connection behind.
   *     initiateConsent moves the row to `pending-consent`, which stops reads.
   */
  async function initiateUpgradeConsent(
    input: InitiateUpgradeConsentInput,
  ): Promise<InitiatedConsent<P>> {
    const config = deps.loadRuntimeConfig();

    // Phase 1 — authorize under the caller's own scope. RLS is the authority
    // for "may this caller see this connection"; the org id in the predicate
    // is a narrowing, not the check.
    const current = await withDbAccessContext(dbAccessContextFromAuth(input.auth), async () => {
      const rows = await db.select().from(m365Connections).where(and(
        eq(m365Connections.id, input.connectionId),
        eq(m365Connections.orgId, input.orgId),
        eq(m365Connections.profile, profile),
        inArray(m365Connections.status, [...EXECUTABLE_STATUSES]),
      )).limit(1);
      const value = rows[0] ? snapshot(rows[0]) : null;
      if (!value) throw lifecycleError('connection_not_found');
      if (!value.tenantId) throw lifecycleError('connection_not_executable');
      return value;
    });
    if (current.permissionManifestVersion === deps.manifest.version) {
      throw lifecycleError('manifest_current');
    }

    // Phase 2 — mint the session in a system transaction. m365_consent_sessions
    // is system-scope-only RLS (2026-07-14-m365-customer-graph-read-consent.sql
    // :281-289), so this cannot run under the caller's context.
    return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      // Same key initiateConsent takes, so an upgrade and a full re-consent on
      // the same owner/profile can never interleave.
      await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.orgId}/${profile}`}, 0))`);
      const rows = await db.select().from(m365Connections).where(and(
        eq(m365Connections.id, current.id),
        eq(m365Connections.orgId, input.orgId),
        eq(m365Connections.profile, profile),
        eq(m365Connections.consentAttemptId, current.consentAttemptId),
        inArray(m365Connections.status, [...EXECUTABLE_STATUSES]),
      )).limit(1).for('update');
      const locked = rows[0] ? snapshot(rows[0]) : null;
      if (!locked) throw lifecycleError('stale_attempt');

      // An abandoned earlier upgrade left a live session on this same attempt.
      // Superseding it keeps at most one outstanding upgrade per connection.
      await deleteConsentSessionsForAttemptInTransaction({
        connectionId: locked.id,
        orgId: locked.orgId,
        consentAttemptId: locked.consentAttemptId,
        profile,
      });

      const created = await createAdminConsentSessionInTransaction({
        connectionId: locked.id,
        orgId: locked.orgId,
        consentAttemptId: locked.consentAttemptId,
        userId: input.auth.user.id,
        profile,
        purpose: 'upgrade',
      });
      const consentUrl = new URL('https://login.microsoftonline.com/common/adminconsent');
      consentUrl.searchParams.set('client_id', config.clientId);
      consentUrl.searchParams.set('redirect_uri', config.callbackUrl);
      consentUrl.searchParams.set('state', created.rawState);
      return { connection: locked, rawState: created.rawState, consentUrl: consentUrl.toString() };
    }));
  }
```

Add `initiateUpgradeConsent,` to the returned object (line 759) and the read-profile alias after line 795:

```ts
export const initiateCustomerGraphReadUpgradeConsent = readConnectionService.initiateUpgradeConsent;
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd apps/api && npx vitest run src/services/m365ControlPlane/connectionService.test.ts src/services/m365ControlPlane/writeActionConnectionService.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/m365ControlPlane/connectionService.ts \
  apps/api/src/services/m365ControlPlane/connectionService.test.ts && \
git commit -m "feat(m365): add initiateUpgradeConsent that never changes connection status" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 6: Upgrade identity transition and in-place promotion

Spec §2.2 item 2 ("The callback, on success, runs the existing verification path and, if the observed grants satisfy v3, promotes `permissionManifestVersion` to 3 in place and bumps `consentGeneration`. On failure or abandonment nothing changes").

**Files:**
- Modify: `apps/api/src/services/m365ControlPlane/connectionService.ts` — `ConnectionService` interface (lines 226-262), two new functions after `applyIdentityVerificationResult` (line 600), returned object (lines 758-769), read aliases (lines 795-806)
- Modify: `apps/api/src/services/m365ControlPlane/writeActionConnectionService.ts` — export the two new members as actions aliases for symmetry (lines 35-44)
- Test: `apps/api/src/services/m365ControlPlane/connectionService.test.ts` (existing)

**Interfaces:**
- Produces:
```ts
// on ConnectionService<P, Client>:
transitionUpgradeConsentToIdentity(input: {
  attempt: M365ConsentAttemptSnapshot<P>;
  rawAdminState: string;
  prepared: PreparedIdentityVerificationSession;
}): Promise<{
  connection: M365ConnectionSnapshot<P>;
  identity: Awaited<ReturnType<typeof insertPreparedIdentityVerificationSessionInTransaction>>;
  actorId: string;
}>;
applyUpgradeVerificationResult(
  input: M365ConsentAttemptSnapshot<P>,
  result: CompleteConsentResult,
): Promise<M365ConnectionSnapshot<P>>;
```
  Consumed by Task 10 (`m365ConsentCallback.ts` dependency wiring for both profiles).
- Consumes: `deriveGrantHealth` and `lifecycleErrorForHealth` (already in this file, lines 110 and 170), `consumeConsentSessionInTransaction`, `insertPreparedIdentityVerificationSessionInTransaction`.

**Promotion rule (decided here, asserted by the tests):**

| Callback outcome | `permission_manifest_version` | `consent_generation` | `status` | other columns |
|---|---|---|---|---|
| `result.success === false` | unchanged | unchanged | unchanged | none written |
| `applicationId` ≠ configured client | unchanged | unchanged | unchanged | none written |
| `result.tenantId` ≠ stored tenant | unchanged | unchanged | unchanged | none written |
| `grantReconciliation !== 'complete'` | unchanged | unchanged | unchanged | none written |
| success, all v3 grants observed | → `manifest.version` | `+ 1` | derived (`active`/`degraded`) | `observedGrants`, `grantsVerifiedAt`, `lastVerifiedAt`, `displayName`, `lastErrorCode` |
| success, some v3 grants missing | unchanged | unchanged | **unchanged** | `observedGrants`, `grantsVerifiedAt`, `lastVerifiedAt`, `displayName`, `lastErrorCode = 'grant_missing'` |

The last row is why the connection can never be made *less* executable by an upgrade: recording an observation is informational, and `deriveGrantHealth` still returns `manifest-stale` because the stored version did not move, so the card keeps offering the banner.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/services/m365ControlPlane/connectionService.test.ts`:

```ts
describe('upgrade consent verification', () => {
  const MANIFEST = M365_PERMISSION_PROFILES['customer-graph-read'];
  const REQUIRED = [...(MANIFEST.applicationPermissionAssignments ?? [])];
  const ATTEMPT = {
    id: '11111111-1111-4111-8111-111111111111',
    orgId: '22222222-2222-4222-8222-222222222222',
    profile: 'customer-graph-read' as const,
    consentAttemptId: '55555555-5555-4555-8555-555555555555',
    status: 'active' as const,
  };
  const STORED = {
    ...ATTEMPT,
    tenantId: '33333333-3333-4333-8333-333333333333',
    clientId: '44444444-4444-4444-8444-444444444444',
    permissionManifestVersion: 2,
    observedGrants: [],
    grantsVerifiedAt: new Date('2026-09-01T00:00:00.000Z'),
    displayName: 'Contoso',
    lastVerifiedAt: new Date('2026-09-01T00:00:00.000Z'),
    lastErrorCode: null,
  };
  function successResult(observedGrants: unknown[]) {
    return {
      success: true as const,
      tenantId: STORED.tenantId,
      applicationId: '55555555-5555-4555-8555-555555555555', // matches runtimeConfig mock
      organizationDisplayName: 'Contoso',
      manifestVersion: MANIFEST.version,
      verifiedAt: '2026-09-08T10:00:00.000Z',
      grantReconciliation: 'complete' as const,
      grantsVerifiedAt: '2026-09-08T10:00:01.000Z',
      observedGrants,
    };
  }

  it('promotes the manifest version and bumps the consent generation on a full approval', async () => {
    dbMocks.selectResults = [[STORED]];
    dbMocks.updateResults = [[{ ...STORED, permissionManifestVersion: 3, observedGrants: REQUIRED }]];
    await applyUpgradeVerificationResult(ATTEMPT, successResult(REQUIRED) as never);

    const set = dbMocks.updateSets[0]!;
    expect(set.permissionManifestVersion).toBe(3);
    expect(set.consentGeneration).toBeDefined();      // sql`consent_generation + 1`
    expect(set.status).toBe('active');
    expect(set.lastErrorCode).toBeNull();
    expect(set.observedGrants).toEqual(REQUIRED);
  });

  it('records the observation but does NOT promote when a v3 grant is missing', async () => {
    const partial = REQUIRED.slice(0, REQUIRED.length - 1);
    dbMocks.selectResults = [[STORED]];
    dbMocks.updateResults = [[{ ...STORED, observedGrants: partial }]];
    await applyUpgradeVerificationResult(ATTEMPT, successResult(partial) as never);

    const set = dbMocks.updateSets[0]!;
    expect(set.permissionManifestVersion).toBeUndefined();
    expect(set.consentGeneration).toBeUndefined();
    expect(set.status).toBeUndefined();               // never made less executable
    expect(set.lastErrorCode).toBe('grant_missing');
    expect(set.observedGrants).toEqual(partial);
  });

  it('writes nothing at all when the administrator abandoned or the provider failed', async () => {
    dbMocks.selectResults = [[STORED]];
    const applied = await applyUpgradeVerificationResult(
      ATTEMPT,
      { success: false, errorCode: 'consent_cancelled' } as never,
    );
    expect(dbMocks.updateSets).toHaveLength(0);
    expect(applied.permissionManifestVersion).toBe(2);
    expect(applied.status).toBe('active');
  });

  it('refuses to rebind: a different verified tenant is a silent no-op', async () => {
    // applyIdentityVerificationResult accepts a binding when tenant_id IS NULL
    // OR equal. An upgrade always has a bound tenant, so anything but equality
    // is an attempt to move a live connection to another tenant.
    dbMocks.selectResults = [[STORED]];
    await applyUpgradeVerificationResult(
      ATTEMPT,
      { ...successResult(REQUIRED), tenantId: '99999999-9999-4999-8999-999999999999' } as never,
    );
    expect(dbMocks.updateSets).toHaveLength(0);
  });

  it('writes nothing when grant reconciliation was unavailable', async () => {
    dbMocks.selectResults = [[STORED]];
    await applyUpgradeVerificationResult(
      ATTEMPT,
      { ...successResult(REQUIRED), grantReconciliation: 'unavailable' } as never,
    );
    expect(dbMocks.updateSets).toHaveLength(0);
  });

  it('rejects an attempt whose connection is not executable', async () => {
    await expect(applyUpgradeVerificationResult(
      { ...ATTEMPT, status: 'pending-consent' },
      successResult(REQUIRED) as never,
    )).rejects.toMatchObject({ code: 'stale_attempt' });
  });
});

describe('transitionUpgradeConsentToIdentity', () => {
  const ATTEMPT = {
    id: '11111111-1111-4111-8111-111111111111',
    orgId: '22222222-2222-4222-8222-222222222222',
    profile: 'customer-graph-read' as const,
    consentAttemptId: '55555555-5555-4555-8555-555555555555',
    status: 'active' as const,
  };

  it('consumes the admin session and inserts an upgrade identity session without an UPDATE', async () => {
    consentMocks.validStates.add('admin-state');
    consentMocks.consumeAdmin.mockResolvedValueOnce({
      userId: '66666666-6666-4666-8666-666666666666',
      purpose: 'upgrade',
    });
    dbMocks.selectResults = [[{ ...ATTEMPT, tenantId: 't', clientId: 'c', permissionManifestVersion: 2, observedGrants: [], grantsVerifiedAt: null, displayName: null, lastVerifiedAt: null, lastErrorCode: null }]];

    const prepared = { rawState: 'identity-state', tenantHintHash: 'h', nonce: 'n', codeVerifier: 'v', codeChallenge: 'c', expiresAt: new Date() };
    const result = await transitionUpgradeConsentToIdentity({
      attempt: ATTEMPT,
      rawAdminState: 'admin-state',
      prepared: prepared as never,
    });

    expect(result.actorId).toBe('66666666-6666-4666-8666-666666666666');
    expect(dbMocks.updateSets).toHaveLength(0);       // status untouched
    expect(consentMocks.insertIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'upgrade', consentAttemptId: ATTEMPT.consentAttemptId }),
      expect.anything(),
    );
  });

  it('refuses an admin session that is not an upgrade session', async () => {
    // Defense in depth against a first-time session reaching the upgrade
    // branch: the router read the purpose without consuming, so the consumed
    // row is the authority.
    consentMocks.consumeAdmin.mockResolvedValueOnce({
      userId: '66666666-6666-4666-8666-666666666666',
      purpose: 'initial',
    });
    await expect(transitionUpgradeConsentToIdentity({
      attempt: ATTEMPT,
      rawAdminState: 'admin-state',
      prepared: {} as never,
    })).rejects.toMatchObject({ code: 'stale_attempt' });
  });
});
```

Import `applyUpgradeVerificationResult` and `transitionUpgradeConsentToIdentity` from `./connectionService` alongside the file's existing imports.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/api && npx vitest run src/services/m365ControlPlane/connectionService.test.ts -t 'upgrade'
```
Expected: FAIL — `applyUpgradeVerificationResult is not a function` and `transitionUpgradeConsentToIdentity is not a function`.

- [ ] **Step 3: Implement both functions**

In `connectionService.ts`, add both interface members after `applyIdentityVerificationResult` in the `ConnectionService` interface (line 246):

```ts
  transitionUpgradeConsentToIdentity(input: {
    attempt: M365ConsentAttemptSnapshot<P>;
    rawAdminState: string;
    prepared: PreparedIdentityVerificationSession;
  }): Promise<{
    connection: M365ConnectionSnapshot<P>;
    identity: Awaited<ReturnType<typeof insertPreparedIdentityVerificationSessionInTransaction>>;
    actorId: string;
  }>;
  applyUpgradeVerificationResult(
    input: M365ConsentAttemptSnapshot<P>,
    result: CompleteConsentResult,
  ): Promise<M365ConnectionSnapshot<P>>;
```

and the implementations after `applyIdentityVerificationResult` ends (line 600):

```ts
  function isExecutable(status: M365ConnectionStatus): boolean {
    return EXECUTABLE_STATUSES.includes(status as typeof EXECUTABLE_STATUSES[number]);
  }

  /**
   * Upgrade counterpart of transitionAdminConsentToIdentity. Same consume +
   * insert, minus the status write: the connection is `active`/`degraded`
   * throughout an upgrade and moving it to `verifying` would stop reads for the
   * duration of a Microsoft round trip.
   */
  async function transitionUpgradeConsentToIdentity(input: {
    attempt: M365ConsentAttemptSnapshot<P>;
    rawAdminState: string;
    prepared: PreparedIdentityVerificationSession;
  }): Promise<{
    connection: M365ConnectionSnapshot<P>;
    identity: Awaited<ReturnType<typeof insertPreparedIdentityVerificationSessionInTransaction>>;
    actorId: string;
  }> {
    if (!isExecutable(input.attempt.status)) throw lifecycleError('stale_attempt');
    return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      const adminSession = await consumeConsentSessionInTransaction({
        rawState: input.rawAdminState,
        phase: 'admin_consent',
        connectionId: input.attempt.id,
        orgId: input.attempt.orgId,
        consentAttemptId: input.attempt.consentAttemptId,
        profile,
      });
      if (!adminSession) throw lifecycleError('stale_attempt');
      // The consumed row is the authority on which flow this is; the callback's
      // non-consuming lookup only routed us here.
      if (adminSession.purpose !== 'upgrade') throw lifecycleError('stale_attempt');

      const rows = await db.select().from(m365Connections)
        .where(attemptPredicate(input.attempt)).limit(1).for('update');
      const connection = rows[0] ? snapshot(rows[0]) : null;
      if (!connection) throw lifecycleError('stale_attempt');

      const identity = await insertPreparedIdentityVerificationSessionInTransaction({
        connectionId: input.attempt.id,
        orgId: input.attempt.orgId,
        consentAttemptId: input.attempt.consentAttemptId,
        userId: adminSession.userId,
        profile,
        purpose: 'upgrade',
      }, input.prepared);
      return { connection, identity, actorId: adminSession.userId };
    }));
  }

  /**
   * Applies an upgrade callback result in place (spec §2.2).
   *
   * Every early return is a deliberate no-op: an abandoned, cancelled, or
   * failed upgrade must leave the connection exactly as it was, still
   * executing on the grants it already holds. The one write path never lowers
   * executability — a partial approval records what was observed and leaves
   * the stored manifest version, so deriveGrantHealth keeps reporting
   * manifest-stale and the card keeps offering the banner.
   */
  async function applyUpgradeVerificationResult(
    input: M365ConsentAttemptSnapshot<P>,
    result: CompleteConsentResult,
  ): Promise<M365ConnectionSnapshot<P>> {
    if (!isExecutable(input.status)) throw lifecycleError('stale_attempt');
    return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      const rows = await db.select().from(m365Connections)
        .where(attemptPredicate(input)).limit(1).for('update');
      const current = rows[0] ? snapshot(rows[0]) : null;
      if (!current) throw lifecycleError('stale_attempt');

      if (!result.success) return current;
      // The executor is fixed-profile, but the control plane checks the proof
      // against its own code/config-owned application, exactly as the
      // first-time path does.
      if (result.applicationId !== deps.loadRuntimeConfig().clientId) return current;
      // Strict equality, not "NULL or equal": an upgrade always has a bound
      // tenant, so a different tenant is a rebind attempt, never a binding.
      if (result.tenantId !== current.tenantId) return current;
      if (result.grantReconciliation !== 'complete') return current;

      const verifiedAt = new Date(result.verifiedAt);
      const grantsVerifiedAt = new Date(result.grantsVerifiedAt);
      const health = deriveGrantHealth({
        status: current.status,
        permissionManifestVersion: deps.manifest.version,
        observedGrants: result.observedGrants,
        grantsVerifiedAt,
        lastErrorCode: null,
      }, deps.manifest);
      const promote = health.missingGrants.length === 0
        && result.manifestVersion === deps.manifest.version;

      const set = promote
        ? {
            displayName: result.organizationDisplayName,
            observedGrants: result.observedGrants,
            grantsVerifiedAt,
            lastVerifiedAt: verifiedAt,
            permissionManifestVersion: deps.manifest.version,
            consentGeneration: sql`${m365Connections.consentGeneration} + 1`,
            status: health.state === 'active' ? 'active' as const : 'degraded' as const,
            lastErrorCode: lifecycleErrorForHealth(health),
            updatedAt: new Date(),
          }
        : {
            displayName: result.organizationDisplayName,
            observedGrants: result.observedGrants,
            grantsVerifiedAt,
            lastVerifiedAt: verifiedAt,
            lastErrorCode: 'grant_missing',
            updatedAt: new Date(),
          };
      return requireCasRow(await db.update(m365Connections).set(set)
        .where(attemptPredicate(input)).returning());
    }));
  }
```

Add both to the returned object (line 759) and to the read aliases (after line 800):

```ts
export const transitionUpgradeConsentToIdentity = readConnectionService.transitionUpgradeConsentToIdentity;
export const applyUpgradeVerificationResult = readConnectionService.applyUpgradeVerificationResult;
```

and to `writeActionConnectionService.ts` after line 40:

```ts
export const transitionUpgradeConsentToIdentityForActions = actionsConnectionService.transitionUpgradeConsentToIdentity;
export const applyUpgradeVerificationResultForActions = actionsConnectionService.applyUpgradeVerificationResult;
```

> `M365ConnectionStatus` is already imported at `connectionService.ts:14`; no new import is needed for `isExecutable`.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/api && npx vitest run src/services/m365ControlPlane/connectionService.test.ts src/services/m365ControlPlane/writeActionConnectionService.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365ControlPlane/connectionService.ts \
  apps/api/src/services/m365ControlPlane/connectionService.test.ts \
  apps/api/src/services/m365ControlPlane/writeActionConnectionService.ts && \
git commit -m "feat(m365): promote the read manifest in place on a successful upgrade consent" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 7: Close the attempt-rotation FK hazard the upgrade path introduces

No spec section — this is a defect **created by Task 5** and must not leave the wave.

**Files:**
- Modify: `apps/api/src/services/m365ControlPlane/connectionService.ts` — imports (lines 17-22), `retestConnection` (lines 687-706)
- Test: `apps/api/src/services/m365ControlPlane/connectionService.test.ts` (existing)

**Interfaces:**
- Consumes: `deleteConsentSessionsForConnection` from Task 4.
- Produces: no new export; `retestConnection`'s signature is unchanged.

**The hazard, stated precisely.** `loadRetestSnapshot` rotates `consent_attempt_id` (`connectionService.ts:625-628`). The composite FK `m365_consent_sessions_connection_identity_fkey` (`db/schema/m365.ts:127-136`) has `ON DELETE CASCADE` but **no** `ON UPDATE CASCADE`, so rotating the parent while a child row references the old attempt raises `23503`. Before this wave that could not happen: sessions only existed while a connection was `pending-consent`/`verifying`, and retest only runs on `active`/`degraded`. Upgrade consent breaks that invariant by design — it mints a session on an executable connection. Without this task, clicking **Retest** during an in-flight upgrade returns a 409 "Connection operation could not be completed" that no one can explain.

Superseding the upgrade is the right resolution, not blocking the retest: retest is an explicit operator action, the upgrade has written nothing, and the administrator can restart it from the same banner.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/m365ControlPlane/connectionService.test.ts`:

```ts
describe('retest with an upgrade consent in flight', () => {
  it('supersedes the connection\'s consent sessions before rotating the attempt id', async () => {
    // The attempt-id rotation in loadRetestSnapshot has no ON UPDATE CASCADE
    // on m365_consent_sessions_connection_identity_fkey, so a live upgrade
    // session would make the rotation raise 23503.
    const CURRENT = {
      id: '11111111-1111-4111-8111-111111111111',
      orgId: '22222222-2222-4222-8222-222222222222',
      tenantId: '33333333-3333-4333-8333-333333333333',
      clientId: '44444444-4444-4444-8444-444444444444',
      profile: 'customer-graph-read',
      permissionManifestVersion: 3,
      observedGrants: [],
      consentAttemptId: '55555555-5555-4555-8555-555555555555',
      grantsVerifiedAt: new Date('2026-09-01T00:00:00.000Z'),
      displayName: 'Contoso',
      status: 'active',
      lastVerifiedAt: new Date('2026-09-01T00:00:00.000Z'),
      lastErrorCode: null,
    };
    dbMocks.selectResults = [[CURRENT]];
    dbMocks.updateResults = [[CURRENT], [CURRENT]];

    await retestCustomerGraphReadConnection({
      id: CURRENT.id,
      orgId: CURRENT.orgId,
      auth: authFixture(),
      executorClient: { retestCustomerGraphRead: async () => ({ success: false, errorCode: 'credential_unavailable' }) } as never,
    });

    expect(consentMocks.deleteForConnection).toHaveBeenCalledWith({
      connectionId: CURRENT.id,
      orgId: CURRENT.orgId,
      profile: 'customer-graph-read',
    });
    expect(dbMocks.order.indexOf('delete-session-by-connection'))
      .toBeLessThan(dbMocks.order.indexOf('update'));
  });
});
```

Extend the hoisted `consentMocks` with:

```ts
    deleteForConnection: vi.fn(async () => {
      dbMocks.order.push('delete-session-by-connection');
    }),
```

and add it to the existing `vi.mock('./consentSessionService', …)` factory as `deleteConsentSessionsForConnection: consentMocks.deleteForConnection`.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/api && npx vitest run src/services/m365ControlPlane/connectionService.test.ts -t 'upgrade consent in flight'
```
Expected: FAIL — `expected "deleteForConnection" to be called with …, but it was never called`.

- [ ] **Step 3: Supersede sessions before the rotation**

Extend the consent-session import block (`connectionService.ts:17-22`):

```ts
import {
  consumeConsentSessionInTransaction,
  createAdminConsentSessionInTransaction,
  deleteConsentSessionsForAttemptInTransaction,
  deleteConsentSessionsForConnection,
  insertPreparedIdentityVerificationSessionInTransaction,
  type M365ConsentSessionProfile,
  type PreparedIdentityVerificationSession,
} from './consentSessionService';
```

and change `retestConnection` (lines 687-706):

```ts
  async function retestConnection(input: {
    id: string;
    orgId: string;
    auth: AuthContext;
    correlationId?: string;
    executorClient?: Client;
  }): Promise<M365ConnectionSnapshot<P>> {
    return runOutsideDbContext(async () => {
      // loadRetestSnapshot rotates consent_attempt_id, and the consent-session
      // composite FK has ON DELETE CASCADE but no ON UPDATE CASCADE — so a
      // live session on this connection would make the rotation raise 23503.
      // Before upgrade consent existed, an executable connection never carried
      // one. Superseding an in-flight upgrade is the correct resolution: the
      // upgrade has written nothing, retest is an explicit operator action,
      // and the banner restarts it. Narrow race: an upgrade started between
      // this delete and the rotation still 409s, which is the pre-existing
      // failure mode, not a new one.
      await deleteConsentSessionsForConnection({
        connectionId: input.id,
        orgId: input.orgId,
        profile,
      });
      const retestSnapshot = await loadRetestSnapshot(input);
      let result: RetestResult;
      try {
        const client = input.executorClient ?? deps.createExecutorClient(deps.loadRuntimeConfig());
        result = await deps.retest(client, {
          correlationId: input.correlationId ?? randomUUID(),
          tenantId: retestSnapshot.tenantId,
        });
      } catch {
        return recordRetestExecutorUnavailable(retestSnapshot);
      }
      return applyRetestResult(retestSnapshot, result);
    });
  }
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/api && npx vitest run src/services/m365ControlPlane/connectionService.test.ts src/routes/m365CustomerGraphRead.test.ts src/routes/m365CustomerGraphActions.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/m365ControlPlane/connectionService.ts \
  apps/api/src/services/m365ControlPlane/connectionService.test.ts && \
git commit -m "fix(m365): supersede live consent sessions before retest rotates the attempt id" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 8: Expose `grantHealth`, `manifestVersion`, `currentManifestVersion` on both connection DTOs

Spec §2.2 item 1 ("the DTO forwards stored status only and hard-codes `manifestVersion: 2`").

**Files:**
- Modify: `apps/api/src/routes/m365CustomerGraphRead.ts` — imports (lines 16-24), `CustomerGraphReadConnectionDto` (lines 68-81), `CustomerGraphReadEnvelope.profile.manifestVersion` literal (line 87), `toConnectionDto` (lines 101-118)
- Modify: `apps/api/src/routes/m365CustomerGraphActions.ts` — the same four sites (imports, DTO lines 72-85, envelope literal line 91, `toConnectionDto` lines 104-121)
- Test: `apps/api/src/routes/m365CustomerGraphRead.test.ts`, `apps/api/src/routes/m365CustomerGraphActions.test.ts` (both existing)

**Interfaces:**
- Produces (both DTOs, identical field names):
```ts
  grantHealth: GrantHealthState;      // 'active'|'degraded'|'missing'|'unexpected'|'both'|'manifest-stale'
  manifestVersion: number;            // stored on the row (already present; the type literal on the envelope changes)
  currentManifestVersion: number;     // the code manifest's version
```
  Consumed by Task 11 (both web cards).
- Consumes: `deriveGrantHealth` and `GrantHealthState` from `services/m365ControlPlane/connectionService`.

**Why the envelope literal must change too.** `CustomerGraphReadEnvelope.profile.manifestVersion` is typed `2` (line 87) while it is assigned `profileManifest.version` (line 128). After Task 2 that assignment is `3` and the file stops compiling. The actions envelope has the same literal-`1` shape (line 91); it does not break this wave, but it is the identical latent bug and is widened in the same commit.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/routes/m365CustomerGraphRead.test.ts`:

```ts
describe('connection DTO grant health', () => {
  it('exposes the derived health, the stored version, and the current version', async () => {
    // deriveGrantHealth already returns manifest-stale for a lagging row
    // (connectionService.ts:137); before this change the DTO forwarded stored
    // status only, so the web card could not tell a stale manifest from a
    // healthy one (spec §2.2).
    mocks.list.mockResolvedValue([connection({ permissionManifestVersion: 2 })]);
    authRef.current = orgAuth();

    const response = await app.request(`/m365/connections?orgId=${ORG_ID}`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.connection.grantHealth).toBe('manifest-stale');
    expect(body.connection.manifestVersion).toBe(2);
    expect(body.connection.currentManifestVersion).toBe(3);
  });

  it('reports active health for a current, fully granted connection', async () => {
    mocks.list.mockResolvedValue([connection({
      permissionManifestVersion: 3,
      status: 'active',
      observedGrants: [...M365_PERMISSION_PROFILES['customer-graph-read'].applicationPermissionAssignments],
      grantsVerifiedAt: new Date('2026-09-08T10:00:00.000Z'),
    })]);
    authRef.current = orgAuth();

    const body = await (await app.request(`/m365/connections?orgId=${ORG_ID}`)).json();

    expect(body.connection.grantHealth).toBe('active');
    expect(body.connection.manifestVersion).toBe(3);
    expect(body.connection.currentManifestVersion).toBe(3);
  });
});
```

(`app`, `orgAuth()` and `connection()` are the file's existing helpers — reuse them; if `app` is constructed inline per case, follow that pattern instead.)

Append the equivalent pair to `apps/api/src/routes/m365CustomerGraphActions.test.ts`, asserting `currentManifestVersion` is `1` and that a row at `permissionManifestVersion: 1` with verified grants reports `grantHealth: 'active'`.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/api && npx vitest run src/routes/m365CustomerGraphRead.test.ts src/routes/m365CustomerGraphActions.test.ts -t 'grant health'
```
Expected: FAIL — `expected undefined to be 'manifest-stale'`.

- [ ] **Step 3: Widen both DTOs**

In `apps/api/src/routes/m365CustomerGraphRead.ts`, extend the connection-service import (lines 16-24) with `type GrantHealthState`, then:

```ts
export interface CustomerGraphReadConnectionDto {
  id: string;
  tenantId: string | null;
  clientId: string | null;
  displayName: string | null;
  status: CustomerGraphReadConnectionSnapshot['status'];
  /**
   * Derived health, not stored status. `manifest-stale` is the state the
   * upgrade-consent banner keys off: the connection is executing fine on the
   * grants it has, but the code manifest has moved on (spec §2.2).
   */
  grantHealth: GrantHealthState;
  /** Manifest version stored on the row. */
  manifestVersion: number;
  /** Manifest version this build requires. */
  currentManifestVersion: number;
  observedGrants: CanonicalAppRoleAssignment[];
  missingGrants: CanonicalAppRoleAssignment[];
  unexpectedGrants: CanonicalAppRoleAssignment[];
  grantsVerifiedAt: string | null;
  lastVerifiedAt: string | null;
  lastErrorCode: string | null;
}

export interface CustomerGraphReadEnvelope {
  profile: {
    id: typeof PROFILE_ID;
    displayName: string;
    // Was the literal `2`, which stops compiling the moment the manifest
    // moves. The manifest is the single source; the DTO reports it.
    manifestVersion: number;
    requiredGrants: M365ApplicationGrant[];
  };
  onboardingEnabled: boolean;
  connection: CustomerGraphReadConnectionDto | null;
}
```

and in `toConnectionDto` (lines 101-118):

```ts
function toConnectionDto(value: ConnectionWithHealth): CustomerGraphReadConnectionDto {
  const health = value.grantHealth
    ?? deriveGrantHealth(value, profileManifest);
  return {
    id: value.id,
    tenantId: value.tenantId,
    clientId: value.clientId === '' ? null : value.clientId,
    displayName: value.displayName,
    status: value.status,
    grantHealth: health.state,
    manifestVersion: value.permissionManifestVersion,
    currentManifestVersion: profileManifest.version,
    observedGrants: [...health.observedGrants],
    missingGrants: [...health.missingGrants],
    unexpectedGrants: [...health.unexpectedGrants],
    grantsVerifiedAt: iso(value.grantsVerifiedAt),
    lastVerifiedAt: iso(value.lastVerifiedAt),
    lastErrorCode: value.lastErrorCode,
  };
}
```

Apply the identical three-field addition, the identical `manifestVersion: number` widening, and the identical `toConnectionDto` change to `apps/api/src/routes/m365CustomerGraphActions.ts` (`CustomerGraphActionsConnectionDto` lines 72-85, envelope line 91, `toConnectionDto` lines 104-121). The actions surface is read-only exposure this wave — **no upgrade route is added for it.**

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/api && npx vitest run src/routes/m365CustomerGraphRead.test.ts src/routes/m365CustomerGraphActions.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/m365CustomerGraphRead.ts apps/api/src/routes/m365CustomerGraphRead.test.ts \
  apps/api/src/routes/m365CustomerGraphActions.ts apps/api/src/routes/m365CustomerGraphActions.test.ts && \
git commit -m "feat(m365): expose derived grantHealth and both manifest versions on the connection DTOs" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 9: `POST /m365/connections/:id/upgrade-consent`

Spec §2.2 item 2.

**Files:**
- Modify: `apps/api/src/routes/m365CustomerGraphRead.ts` — imports (lines 16-24), new route after the retest handler (line 298)
- Modify: `apps/api/src/services/m365ControlPlane/metrics.ts` — `M365_CUSTOMER_GRAPH_READ_EVENTS` (lines 7-15)
- Test: `apps/api/src/routes/m365CustomerGraphRead.test.ts` (existing)
- Test: `apps/api/src/services/m365ControlPlane/metrics.test.ts` — the exact-events assertion (line 28)

**Interfaces:**
- Produces: `POST /api/v1/m365/connections/:id/upgrade-consent` → `200 { adminConsentUrl: string }` plus the `Set-Cookie` admin-consent browser binding; `404 { error: 'Connection not found' }` for an unknown/foreign/non-executable connection; `409 { error: 'Connection operation could not be completed' }` when the manifest is already current; `403` without `organizations:write`, MFA, or partner-wide write. Consumed by Task 11.
- Consumes: `initiateCustomerGraphReadUpgradeConsent` (Task 5), `buildM365ConsentBindingCookie` (already imported at line 25).
- New audit event: `'m365.customer_graph_read.upgrade_consent_initiated'` with the existing `outcome: 'initiated'`.

**Middleware chain is copied from retest verbatim** (`m365CustomerGraphRead.ts:252-257`): `requireOrgsWrite, requireMfa(), zValidator('param', idParam)`, then `mutationOrg(c)` — which also enforces `canManagePartnerWidePolicies` for partner-scoped callers.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/routes/m365CustomerGraphRead.test.ts`:

```ts
describe('POST /m365/connections/:id/upgrade-consent', () => {
  it('requires MFA exactly like retest', async () => {
    authRef.current = { ...orgAuth(), mfa: false };
    const response = await app.request(
      `/m365/connections/${CONNECTION_ID}/upgrade-consent?orgId=${ORG_ID}`,
      { method: 'POST' },
    );
    expect(response.status).toBe(403);
    expect(mocks.upgrade).not.toHaveBeenCalled();
  });

  it('requires organizations:write', async () => {
    authRef.current = { ...orgAuth(), permissions: new Set(['organizations:read' as const]) };
    const response = await app.request(
      `/m365/connections/${CONNECTION_ID}/upgrade-consent?orgId=${ORG_ID}`,
      { method: 'POST' },
    );
    expect(response.status).toBe(403);
    expect(mocks.upgrade).not.toHaveBeenCalled();
  });

  it('returns the Microsoft admin-consent URL and sets the browser binding', async () => {
    authRef.current = orgAuth();
    mocks.upgrade.mockResolvedValue({
      connection: connection(),
      rawState: 'raw-state',
      consentUrl: 'https://login.microsoftonline.com/common/adminconsent?state=raw-state',
    });

    const response = await app.request(
      `/m365/connections/${CONNECTION_ID}/upgrade-consent?orgId=${ORG_ID}`,
      { method: 'POST' },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      adminConsentUrl: 'https://login.microsoftonline.com/common/adminconsent?state=raw-state',
    });
    expect(response.headers.get('set-cookie')).toContain('binding-cookie=');
    expect(mocks.upgrade).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: CONNECTION_ID,
      orgId: ORG_ID,
    }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'm365.customer_graph_read.upgrade_consent_initiated',
      outcome: 'initiated',
    }));
  });

  it('404s a connection in another organization', async () => {
    authRef.current = orgAuth();
    const response = await app.request(
      `/m365/connections/${CONNECTION_ID}/upgrade-consent?orgId=${OTHER_ORG_ID}`,
      { method: 'POST' },
    );
    expect(response.status).toBe(404);
    expect(mocks.upgrade).not.toHaveBeenCalled();
  });

  it('409s when the stored manifest is already current', async () => {
    authRef.current = orgAuth();
    mocks.upgrade.mockRejectedValue(Object.assign(new Error('manifest_current'), { code: 'manifest_current' }));
    const response = await app.request(
      `/m365/connections/${CONNECTION_ID}/upgrade-consent?orgId=${ORG_ID}`,
      { method: 'POST' },
    );
    expect(response.status).toBe(409);
  });
});
```

Add `upgrade: vi.fn(),` to the hoisted `mocks` object (lines 22-31) and `initiateCustomerGraphReadUpgradeConsent: mocks.upgrade,` to the `vi.mock('../services/m365ControlPlane/connectionService', …)` factory (lines 68-74).

Also extend the exact-events assertion in `apps/api/src/services/m365ControlPlane/metrics.test.ts:28` with `'m365.customer_graph_read.upgrade_consent_initiated'` in its declared position.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/api && npx vitest run src/routes/m365CustomerGraphRead.test.ts -t 'upgrade-consent'
```
Expected: FAIL — every case returns 404 (no route is mounted at that path).

- [ ] **Step 3: Register the audit event**

In `apps/api/src/services/m365ControlPlane/metrics.ts`, add to `M365_CUSTOMER_GRAPH_READ_EVENTS` after `'m365.customer_graph_read.consent_initiated'`:

```ts
  'm365.customer_graph_read.upgrade_consent_initiated',
```

- [ ] **Step 4: Add the route**

Extend the connection-service import in `apps/api/src/routes/m365CustomerGraphRead.ts` with `initiateCustomerGraphReadUpgradeConsent`, then insert after the retest handler (line 298):

```ts
/**
 * Starts a manifest upgrade on an existing connection (spec §2.2). Unlike the
 * consent route above, this one does not move the connection to
 * pending-consent — reads keep working on the grants the customer already
 * approved for the whole duration of the Microsoft round trip, including if
 * the administrator abandons it.
 */
m365CustomerGraphReadRoutes.post(
  '/connections/:id/upgrade-consent',
  requireOrgsWrite,
  requireMfa(),
  zValidator('param', idParam),
  async (c) => {
    const resolved = mutationOrg(c);
    if (resolved instanceof Response) return resolved;
    if (!('orgId' in resolved)) return c.json({ error: 'Connection not found' }, 404);
    const { id } = c.req.valid('param');
    try {
      const correlationId = randomUUID();
      const initiated = await initiateCustomerGraphReadUpgradeConsent({
        connectionId: id,
        orgId: resolved.orgId,
        auth: c.get('auth'),
      });
      c.header('Set-Cookie', buildM365ConsentBindingCookie({
        phase: 'admin_consent',
        rawState: initiated.rawState,
        connectionId: initiated.connection.id,
        consentAttemptId: initiated.connection.consentAttemptId,
        tenantHint: null,
      }), { append: true });
      const auth = c.get('auth');
      recordM365CustomerGraphReadEvent(c, {
        event: 'm365.customer_graph_read.upgrade_consent_initiated',
        orgId: resolved.orgId,
        connectionId: initiated.connection.id,
        profile: PROFILE_ID,
        consentAttemptId: initiated.connection.consentAttemptId,
        manifestVersion: profileManifest.version,
        outcome: 'initiated',
        correlationId,
        actorId: auth.user.id,
        actorEmail: auth.user.email,
      });
      return c.json({ adminConsentUrl: initiated.consentUrl });
    } catch (error) {
      return lifecycleFailure(c, error);
    }
  },
);
```

`lifecycleFailure` (line 182) already maps `connection_not_found` / `connection_not_executable` / `stale_attempt` to 404 and everything else — including `manifest_current` — to 409.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd apps/api && npx vitest run src/routes/m365CustomerGraphRead.test.ts src/services/m365ControlPlane/metrics.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/m365CustomerGraphRead.ts apps/api/src/routes/m365CustomerGraphRead.test.ts \
  apps/api/src/services/m365ControlPlane/metrics.ts apps/api/src/services/m365ControlPlane/metrics.test.ts && \
git commit -m "feat(m365): add the MFA-gated upgrade-consent route for customer graph read" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 10: Route the consent callback on `purpose`

Spec §2.2 item 2 (the callback half).

**Files:**
- Modify: `apps/api/src/routes/m365ConsentCallback.ts` — imports (lines 21-34), `CallbackConnectionServiceLike` (lines 166-181), `CallbackDependencies` (lines 203-226), `buildDefaultDependencies` (lines 339-373), `outcomeFromConnection` neighbourhood (lines 381-387), the route handler (lines 429-628)
- Test: `apps/api/src/routes/m365ConsentCallback.test.ts` (existing)

**Interfaces:**
- Produces: no new export. Three new `CallbackDependencies` members (`readSessionPurpose`, `transitionUpgradePhase`, `applyUpgradeResult`) that `createM365ConsentCallbackRoutes` overrides accept, so the existing DI test style covers the new branch without a database.
- Consumes: `readConsentSessionPurpose` and `ConsentSessionPurposeLookup` and `M365ConsentPurpose` (Task 4); `transitionUpgradeConsentToIdentity` and `applyUpgradeVerificationResult` (Task 6).

**The four behavioural differences an upgrade callback has:**

1. **Legal connection statuses.** A first-time callback expects `pending-consent` (admin phase) or `verifying` (identity phase). An upgrade expects `active` or `degraded` in **both** phases, because nothing ever moved it.
2. **`markConsentAttemptFailed` is never called.** It writes `status = 'pending-consent'` (`connectionService.ts:530`). Calling it from an upgrade turns a *cancelled* consent into an outage. Both call sites (provider error, line 550; executor unavailable, line 584) are gated.
3. **The admin→identity transition and the apply are the upgrade variants.**
4. **The redirect outcome is derived from whether the version actually moved**, not from status — an upgrade that lands with missing grants leaves the connection `active`, and reporting `active` would tell the administrator the approval worked.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/routes/m365ConsentCallback.test.ts`, using the file's existing `createM365ConsentCallbackRoutes({ … })` override style:

```ts
describe('upgrade consent callback', () => {
  const upgradeAdminBinding = {
    phase: 'admin_consent' as const,
    rawState: 'admin-state',
    connectionId: CONNECTION_ID,
    consentAttemptId: ATTEMPT_ID,
    tenantHint: null,
  };
  const upgradeIdentityBinding = {
    phase: 'identity_verification' as const,
    rawState: 'identity-state',
    connectionId: CONNECTION_ID,
    consentAttemptId: ATTEMPT_ID,
    tenantHint: TENANT_ID,
  };
  function executableAttempt(status: 'active' | 'degraded' = 'active') {
    return {
      id: CONNECTION_ID,
      orgId: ORG_ID,
      profile: 'customer-graph-read' as const,
      consentAttemptId: ATTEMPT_ID,
      status,
    };
  }

  it('accepts an ACTIVE connection on the admin phase and uses the upgrade transition', async () => {
    const transitionUpgradePhase = vi.fn().mockResolvedValue({
      connection: { status: 'active' }, actorId: USER_ID,
    });
    const transitionAdminPhase = vi.fn();
    const routes = createM365ConsentCallbackRoutes({
      verifyBindingCookie: vi.fn(() => upgradeAdminBinding),
      readSessionPurpose: vi.fn(async () => 'upgrade' as const),
      loadAttempt: vi.fn(async () => executableAttempt()),
      transitionUpgradePhase,
      transitionAdminPhase,
      prepareIdentitySession: vi.fn(() => ({
        rawState: 'identity-state', tenantHintHash: tenantHintHash(TENANT_ID),
        nonce: 'n', codeVerifier: 'v'.repeat(43), codeChallenge: 'c',
        expiresAt: new Date('2026-09-08T12:10:00.000Z'),
      })),
      buildIdentityUrl: vi.fn(() => 'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize'),
      buildBindingCookie: vi.fn(() => 'binding=identity'),
      loadConfig: vi.fn(() => ({ clientId: 'client', callbackUrl: 'https://console.example.test/api/v1/m365/consent/callback' })),
      audit: vi.fn(),
      metric: vi.fn(),
    });
    const app = new Hono();
    app.route('/api/v1/m365', routes);

    const response = await app.request(
      `/api/v1/m365/consent/callback?state=admin-state&tenant=${TENANT_ID}&admin_consent=true`,
      { headers: { cookie: bindingCookie(upgradeAdminBinding) } },
    );

    expect(response.status).toBe(302);
    expect(transitionUpgradePhase).toHaveBeenCalledTimes(1);
    expect(transitionAdminPhase).not.toHaveBeenCalled();
  });

  it('never marks the attempt failed when the administrator cancels an upgrade', async () => {
    // markConsentAttemptFailed writes status = 'pending-consent'. Reaching it
    // here would take a live connection out of service on a CANCEL.
    const markAttemptFailed = vi.fn();
    const routes = createM365ConsentCallbackRoutes({
      verifyBindingCookie: vi.fn(() => upgradeIdentityBinding),
      readSessionPurpose: vi.fn(async () => 'upgrade' as const),
      loadAttempt: vi.fn(async () => executableAttempt()),
      consumeSession: vi.fn(async () => ({
        userId: USER_ID, purpose: 'upgrade',
        tenantHintHash: tenantHintHash(TENANT_ID), nonce: 'n', codeVerifier: 'v',
      })),
      markAttemptFailed,
      audit: vi.fn(),
      metric: vi.fn(),
    });
    const app = new Hono();
    app.route('/api/v1/m365', routes);

    const response = await app.request(
      '/api/v1/m365/consent/callback?state=identity-state&error=access_denied&error_description=x',
      { headers: { cookie: bindingCookie(upgradeIdentityBinding) } },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('consent_cancelled');
    expect(markAttemptFailed).not.toHaveBeenCalled();
  });

  it('redirects active after a promotion and degraded-with-cause when the version did not move', async () => {
    const cases = [
      { manifestVersion: 3, status: 'active', lastErrorCode: null, expected: 'active' },
      { manifestVersion: 2, status: 'active', lastErrorCode: 'grant_missing', expected: 'grant_missing' },
      { manifestVersion: 2, status: 'active', lastErrorCode: null, expected: 'manifest_stale' },
    ] as const;
    for (const scenario of cases) {
      const routes = createM365ConsentCallbackRoutes({
        verifyBindingCookie: vi.fn(() => upgradeIdentityBinding),
        readSessionPurpose: vi.fn(async () => 'upgrade' as const),
        loadAttempt: vi.fn(async () => executableAttempt()),
        consumeSession: vi.fn(async () => ({
          userId: USER_ID, purpose: 'upgrade',
          tenantHintHash: tenantHintHash(TENANT_ID), nonce: 'n', codeVerifier: 'v',
        })),
        completeIdentity: vi.fn(async () => ({ success: true, tenantId: TENANT_ID })),
        applyUpgradeResult: vi.fn(async () => ({
          id: CONNECTION_ID,
          status: scenario.status,
          lastErrorCode: scenario.lastErrorCode,
          permissionManifestVersion: scenario.manifestVersion,
        })),
        applyIdentityResult: vi.fn(),
        audit: vi.fn(),
        metric: vi.fn(),
      });
      const app = new Hono();
      app.route('/api/v1/m365', routes);

      const response = await app.request(
        '/api/v1/m365/consent/callback?state=identity-state&code=auth-code',
        { headers: { cookie: bindingCookie(upgradeIdentityBinding) } },
      );

      expect(response.headers.get('location')).toContain(scenario.expected);
    }
  });

  it('rejects an upgrade callback against a connection that is no longer executable', async () => {
    const routes = createM365ConsentCallbackRoutes({
      verifyBindingCookie: vi.fn(() => upgradeAdminBinding),
      readSessionPurpose: vi.fn(async () => 'upgrade' as const),
      loadAttempt: vi.fn(async () => ({ ...executableAttempt(), status: 'revoked' as const })),
      audit: vi.fn(),
      metric: vi.fn(),
    });
    const app = new Hono();
    app.route('/api/v1/m365', routes);

    const response = await app.request(
      `/api/v1/m365/consent/callback?state=admin-state&tenant=${TENANT_ID}&admin_consent=true`,
      { headers: { cookie: bindingCookie(upgradeAdminBinding) } },
    );

    expect(response.headers.get('location')).toContain('consent_state_mismatch');
  });

  it('still requires pending-consent for a first-time session', async () => {
    // The purpose router must not loosen the initial flow.
    const routes = createM365ConsentCallbackRoutes({
      verifyBindingCookie: vi.fn(() => upgradeAdminBinding),
      readSessionPurpose: vi.fn(async () => 'initial' as const),
      loadAttempt: vi.fn(async () => executableAttempt()),
      audit: vi.fn(),
      metric: vi.fn(),
    });
    const app = new Hono();
    app.route('/api/v1/m365', routes);

    const response = await app.request(
      `/api/v1/m365/consent/callback?state=admin-state&tenant=${TENANT_ID}&admin_consent=true`,
      { headers: { cookie: bindingCookie(upgradeAdminBinding) } },
    );

    expect(response.headers.get('location')).toContain('consent_state_mismatch');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/api && npx vitest run src/routes/m365ConsentCallback.test.ts -t 'upgrade consent callback'
```
Expected: FAIL — TypeScript rejects `readSessionPurpose` / `transitionUpgradePhase` / `applyUpgradeResult` as unknown override keys, and at runtime every upgrade case redirects to `consent_state_mismatch` because the handler still demands `pending-consent`.

- [ ] **Step 3: Extend the dependency surface**

In `apps/api/src/routes/m365ConsentCallback.ts`, extend the connection-service import (lines 21-27) and the consent-session import (lines 28-34):

```ts
import {
  applyIdentityVerificationResult,
  applyUpgradeVerificationResult,
  markConsentAttemptFailed,
  transitionAdminConsentToIdentity,
  transitionUpgradeConsentToIdentity,
  type M365ConnectionSnapshot,
  type M365ConsentAttemptSnapshot,
} from '../services/m365ControlPlane/connectionService';
import {
  consumeConsentSession,
  hashTenantHint,
  prepareIdentityVerificationSession,
  readConsentSessionPurpose,
  type ConsentSessionPurposeLookup,
  type M365ConsentPurpose,
  type M365ConsentSession,
  type M365ConsentSessionProfile,
  type PreparedIdentityVerificationSession,
} from '../services/m365ControlPlane/consentSessionService';
```

Extend `CallbackConnectionServiceLike` (lines 166-181):

```ts
  transitionUpgradeConsentToIdentity(input: {
    attempt: CallbackAttemptSnapshot;
    rawAdminState: string;
    prepared: PreparedIdentityVerificationSession;
  }): Promise<{ connection: CallbackConnectionSnapshot; actorId: string }>;
  applyUpgradeVerificationResult(
    input: CallbackAttemptSnapshot,
    result: CompleteConsentResult,
  ): Promise<CallbackConnectionSnapshot>;
```

Extend `CallbackDependencies` (lines 203-226) after `consumeSession`:

```ts
  /**
   * Reads which flow this callback is resuming without consuming the session.
   * Needed BEFORE the attempt status is validated, because an upgrade session
   * expects an executable connection and a first-time session expects
   * pending-consent/verifying (spec §2.2).
   */
  readSessionPurpose(input: ConsentSessionPurposeLookup): Promise<M365ConsentPurpose | null>;
  transitionUpgradePhase(input: {
    attempt: CallbackAttemptSnapshot;
    rawAdminState: string;
    prepared: PreparedIdentityVerificationSession;
  }): Promise<{ connection: CallbackConnectionSnapshot; actorId: string }>;
  applyUpgradeResult(
    input: CallbackAttemptSnapshot,
    result: CompleteConsentResult,
  ): Promise<CallbackConnectionSnapshot>;
```

Wire the defaults in `buildDefaultDependencies` (after `consumeSession`, line 358):

```ts
    readSessionPurpose: readConsentSessionPurpose,
    transitionUpgradePhase: connectionService.transitionUpgradeConsentToIdentity,
    applyUpgradeResult: connectionService.applyUpgradeVerificationResult,
```

and add the two members to `defaultConnectionService` for the read profile (line 310):

```ts
function defaultConnectionService(profile: CallbackProfile): CallbackConnectionServiceLike {
  return profile === 'customer-graph-actions'
    ? actionsConnectionService
    : {
      markConsentAttemptFailed,
      transitionAdminConsentToIdentity,
      applyIdentityVerificationResult,
      transitionUpgradeConsentToIdentity,
      applyUpgradeVerificationResult,
    };
}
```

- [ ] **Step 4: Add the status router and the upgrade outcome**

Next to `outcomeFromConnection` (line 381):

```ts
/** Statuses a callback may legally act on, per flow and phase. */
function statusAllowed(
  status: string,
  isUpgrade: boolean,
  phase: M365ConsentBindingPhase,
): boolean {
  // An upgrade never moved the connection, so it is still executable in BOTH
  // phases. A first-time consent walks pending-consent → verifying.
  if (isUpgrade) return status === 'active' || status === 'degraded';
  return status === (phase === 'admin_consent' ? 'pending-consent' : 'verifying');
}

/**
 * An upgrade leaves an executable connection executable even when it fails, so
 * status alone would report `active` for an approval that granted nothing.
 * Whether the stored manifest version actually moved is the real outcome.
 */
function upgradeOutcome(
  value: CallbackConnectionSnapshot,
  currentManifestVersion: number,
): PublicOutcome {
  if (value.permissionManifestVersion !== currentManifestVersion) {
    return PUBLIC_OUTCOMES.has(value.lastErrorCode as PublicOutcome)
      ? value.lastErrorCode as PublicOutcome
      : 'manifest_stale';
  }
  return outcomeFromConnection(value);
}
```

- [ ] **Step 5: Route the handler**

In the route handler, immediately after the `parsed`/state check (line 467), insert:

```ts
    const purpose = await dependencies.readSessionPurpose({
      rawState: binding.rawState,
      phase: binding.phase,
      connectionId: binding.connectionId,
      consentAttemptId: binding.consentAttemptId,
      profile: dependencies.profile,
    });
    // A missing session is not an upgrade; the consume below fails it anyway.
    const isUpgrade = purpose === 'upgrade';
    const currentManifestVersion = M365_PERMISSION_PROFILES[dependencies.profile].version;
```

Replace the admin-branch attempt check (lines 497-500):

```ts
      const attempt = await dependencies.loadAttempt(binding);
      if (!attempt || !statusAllowed(attempt.status, isUpgrade, binding.phase)) {
        return terminalFailure('consent_state_mismatch');
      }
      let actorId: string;
      try {
        const transition = isUpgrade
          ? dependencies.transitionUpgradePhase
          : dependencies.transitionAdminPhase;
        const transitioned = await transition({
          attempt,
          rawAdminState: binding.rawState,
          prepared,
        });
        actorId = transitioned.actorId;
      } catch (error) {
```

Replace the second attempt check (lines 532-536):

```ts
    const attempt = await dependencies.loadAttempt(binding);
    if (!attempt || !statusAllowed(attempt.status, isUpgrade, binding.phase)) {
      return terminalFailure('consent_state_mismatch');
    }
```

Gate the provider-error branch (lines 548-555):

```ts
    if (parsed.kind === 'provider_error') {
      // An upgrade must leave the connection exactly as it was — and
      // markAttemptFailed writes status = 'pending-consent', which would take a
      // live connection out of service on a CANCEL (spec §2.2).
      if (!isUpgrade) {
        try {
          await dependencies.markAttemptFailed(attempt, 'consent_cancelled');
        } catch {
          return terminalFailure('consent_state_mismatch', attempt, session.userId);
        }
      }
      return terminalFailure('consent_cancelled', attempt, session.userId);
    }
```

Gate the executor-unavailable branch (lines 582-589):

```ts
    } catch {
      if (!isUpgrade) {
        try {
          await dependencies.markAttemptFailed(attempt, 'executor_unavailable');
        } catch {
          return terminalFailure('consent_state_mismatch', attempt, session.userId);
        }
      }
      return terminalFailure('executor_unavailable', attempt, session.userId);
    }
```

And the apply block (lines 591-593):

```ts
    try {
      const applied = isUpgrade
        ? await dependencies.applyUpgradeResult(attempt, result)
        : await dependencies.applyIdentityResult(attempt, result);
      const outcome = isUpgrade
        ? upgradeOutcome(applied, currentManifestVersion)
        : outcomeFromConnection(applied);
```

The rest of the success block (the `driftOutcome` derivation and the two audit writes, lines 594-624) is unchanged: an upgrade that lands with missing grants sets `lastErrorCode = 'grant_missing'`, which is exactly the drift event those lines already emit.

> `M365ConsentBindingPhase` is already imported (line 19) and `M365_PERMISSION_PROFILES` at line 3 — no further imports are needed for Steps 4-5.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd apps/api && npx vitest run src/routes/m365ConsentCallback.test.ts
```
Expected: PASS, including every pre-existing first-time-consent case (the purpose router defaults to `initial`, and `readConsentSessionPurpose` returns `null` in those tests' DI overrides — add an explicit `readSessionPurpose: vi.fn(async () => 'initial' as const)` to any pre-existing case that now fails because its override object omits the member).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/m365ConsentCallback.ts apps/api/src/routes/m365ConsentCallback.test.ts && \
git commit -m "feat(m365): route the consent callback on session purpose for upgrade consent" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 11: Web — amber `manifest-stale` banner, "Approve new permissions", and the strict parsers

Spec §2.2 item 3.

**Files:**
- Modify: `apps/web/src/components/integrations/M365CustomerGraphReadCard.tsx` — `Connection` type (lines 68-80), `Envelope` type (lines 82-92), `ActionName` (line 95), `parseConnection` (lines 173-211), `parseEnvelope` (lines 213-236), `errorCopy` memo (lines 503-508), new `startUpgradeConsent` callback after `retest` (line 457), banner JSX inside the ready block (after line 575)
- Modify: `apps/web/src/components/integrations/M365CustomerGraphActionsCard.tsx` — `Connection` type (line 81 area), `Envelope` (line 94), `parseConnection` keys + validation (lines 179-211), `parseEnvelope` literal (line 234). **Parser only — no banner, no button.**
- Modify: `apps/web/src/locales/en/integrations.json` and the seven sibling locales (`de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`)
- Test: `apps/web/src/components/integrations/M365CustomerGraphReadCard.test.tsx`, `apps/web/src/components/integrations/M365CustomerGraphActionsCard.test.tsx` (both existing)

**Interfaces:**
- Consumes: the DTO fields from Task 8 and the route from Task 9.
- Produces: no exported surface change.

**Why the parsers are load-bearing, not cosmetic.** Both cards validate the envelope with `hasExactKeys` (`M365CustomerGraphReadCard.tsx:110-114`), so an *added* server field makes `parseConnection` return `undefined`, `parseEnvelope` return `null`, and the card render `loadState === "error"` — the integration silently disappears from Settings. Both parsers must gain the two new keys in the same PR as Task 8, and the **actions** card must too even though it grows no new UI.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/components/integrations/M365CustomerGraphReadCard.test.tsx`, and add `grantHealth: "active"` + `currentManifestVersion: 3` to the shared `connection()` fixture (lines 128-144) first:

```ts
describe("manifest upgrade banner", () => {
  it("shows the amber banner and the approve button for a manifest-stale connection", async () => {
    fetchWithAuthMock.mockResolvedValue(makeResponse(envelope({
      connection: connection({ manifestVersion: 2, grantHealth: "manifest-stale" }),
    })));

    render(<M365CustomerGraphReadCard />);

    const banner = await screen.findByTestId("m365-read-manifest-stale-banner");
    expect(banner).toHaveTextContent(
      "New Microsoft 365 permissions are required for Conditional Access, Secure Score, and admin role visibility. A Global Administrator must approve them.",
    );
    expect(screen.getByTestId("m365-read-approve-new-permissions")).toBeEnabled();
  });

  it("hides the banner for a current connection", async () => {
    fetchWithAuthMock.mockResolvedValue(makeResponse(envelope({
      connection: connection({ manifestVersion: 3, grantHealth: "active" }),
    })));

    render(<M365CustomerGraphReadCard />);

    expect(await screen.findByRole("heading", { name: "Customer Graph Read" })).toBeInTheDocument();
    expect(screen.queryByTestId("m365-read-manifest-stale-banner")).not.toBeInTheDocument();
  });

  it("starts the upgrade through runAction and navigates to the validated Microsoft URL", async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeResponse(envelope({
        connection: connection({ manifestVersion: 2, grantHealth: "manifest-stale" }),
      })))
      .mockResolvedValueOnce(makeResponse({
        adminConsentUrl: "https://login.microsoftonline.com/common/adminconsent?state=raw",
      }));

    render(<M365CustomerGraphReadCard />);
    fireEvent.click(await screen.findByTestId("m365-read-approve-new-permissions"));

    await waitFor(() => expect(runActionMock).toHaveBeenCalledTimes(1));
    expect(fetchWithAuthMock).toHaveBeenLastCalledWith(
      `/m365/connections/${CONNECTION_ID}/upgrade-consent?orgId=${ORG_A}`,
      { method: "POST" },
    );
    await waitFor(() => expect(navigateToMock).toHaveBeenCalledWith(
      "https://login.microsoftonline.com/common/adminconsent?state=raw",
    ));
  });

  it("refuses to navigate to a non-Microsoft consent URL", async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeResponse(envelope({
        connection: connection({ manifestVersion: 2, grantHealth: "manifest-stale" }),
      })))
      .mockResolvedValueOnce(makeResponse({ adminConsentUrl: "https://evil.example/adminconsent" }));

    render(<M365CustomerGraphReadCard />);
    fireEvent.click(await screen.findByTestId("m365-read-approve-new-permissions"));

    await waitFor(() => expect(runActionMock).toHaveBeenCalledTimes(1));
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  it("disables the approve button without organizations:write", async () => {
    state.canWrite = false;
    fetchWithAuthMock.mockResolvedValue(makeResponse(envelope({
      connection: connection({ manifestVersion: 2, grantHealth: "manifest-stale" }),
    })));

    render(<M365CustomerGraphReadCard />);

    expect(await screen.findByTestId("m365-read-approve-new-permissions")).toBeDisabled();
  });

  it("still renders missing grants degraded rather than the banner once the manifest is current", async () => {
    // Spec §2.2: missing grants after a retest keep the EXISTING degraded
    // rendering; the banner is only for a stale manifest.
    fetchWithAuthMock.mockResolvedValue(makeResponse(envelope({
      connection: connection({
        manifestVersion: 3,
        grantHealth: "missing",
        status: "degraded",
        observedGrants: REQUIRED_GRANTS.slice(0, 12),
        missingGrants: REQUIRED_GRANTS.slice(12),
      }),
    })));

    render(<M365CustomerGraphReadCard />);

    expect(await screen.findByRole("heading", { name: "Customer Graph Read" })).toBeInTheDocument();
    expect(screen.queryByTestId("m365-read-manifest-stale-banner")).not.toBeInTheDocument();
    expect(screen.getByText(REQUIRED_GRANTS[12]!.value)).toBeInTheDocument();
  });

  it("rejects an envelope whose connection is missing the new fields", async () => {
    // hasExactKeys is exact in both directions: a server that has not shipped
    // Task 8 yet must fail closed, not render a half-parsed card.
    const stale = connection();
    delete (stale as Record<string, unknown>).grantHealth;
    fetchWithAuthMock.mockResolvedValue(makeResponse(envelope({ connection: stale })));

    render(<M365CustomerGraphReadCard />);

    expect(await screen.findByText("Microsoft 365 Customer Graph Read is unavailable right now."))
      .toBeInTheDocument();
  });
});
```

(The last case's expected string is the `m365CustomerGraphRead.unavailable` value in `en/integrations.json` — read the file and use its exact text.)

In `apps/web/src/components/integrations/M365CustomerGraphActionsCard.test.tsx`, add `grantHealth: "active"` and `currentManifestVersion: 1` to its `connection()` fixture (lines 113-135) and one case asserting the card still renders — that is the whole actions-side change.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd apps/web && npx vitest run src/components/integrations
```
Expected: FAIL — `Unable to find an element by: [data-testid="m365-read-manifest-stale-banner"]`, and every fixture case failing because the extra `grantHealth`/`currentManifestVersion` keys make `hasExactKeys` reject the connection.

- [ ] **Step 3: Add the locale copy (all eight files)**

In `apps/web/src/locales/en/integrations.json`, under `m365CustomerGraphRead`, add a new `upgrade` object and two `actions` entries:

```json
    "upgrade": {
      "banner": "New Microsoft 365 permissions are required for Conditional Access, Secure Score, and admin role visibility. A Global Administrator must approve them."
    },
```
and inside `m365CustomerGraphRead.actions`:
```json
      "approveNewPermissions": "Approve new permissions",
      "upgradeFailed": "Approval for the new permissions could not be started.",
```

Add the same three keys to every sibling locale — `localeParity.test.ts` compares flattened key sets, leaf types, and interpolation tokens against `en`, so a missing key fails **Test Web**:

| Locale | `upgrade.banner` | `actions.approveNewPermissions` | `actions.upgradeFailed` |
|---|---|---|---|
| `de-DE` | "Neue Microsoft 365-Berechtigungen sind für bedingten Zugriff, die Sicherheitsbewertung und die Sichtbarkeit von Administratorrollen erforderlich. Ein globaler Administrator muss sie genehmigen." | "Neue Berechtigungen genehmigen" | "Die Genehmigung der neuen Berechtigungen konnte nicht gestartet werden." |
| `es-419` | "Se requieren nuevos permisos de Microsoft 365 para el acceso condicional, la puntuación de seguridad y la visibilidad de los roles de administrador. Un administrador global debe aprobarlos." | "Aprobar nuevos permisos" | "No se pudo iniciar la aprobación de los nuevos permisos." |
| `fr-CA` | "De nouvelles autorisations Microsoft 365 sont requises pour l'accès conditionnel, le degré de sécurisation et la visibilité des rôles d'administrateur. Un administrateur général doit les approuver." | "Approuver les nouvelles autorisations" | "L'approbation des nouvelles autorisations n'a pas pu être lancée." |
| `fr-FR` | "De nouvelles autorisations Microsoft 365 sont requises pour l'accès conditionnel, le degré de sécurisation et la visibilité des rôles d'administrateur. Un administrateur général doit les approuver." | "Approuver les nouvelles autorisations" | "L'approbation des nouvelles autorisations n'a pas pu être lancée." |
| `it-IT` | "Sono necessarie nuove autorizzazioni Microsoft 365 per l'accesso condizionale, il punteggio di sicurezza e la visibilità dei ruoli di amministratore. Un amministratore globale deve approvarle." | "Approva le nuove autorizzazioni" | "Non è stato possibile avviare l'approvazione delle nuove autorizzazioni." |
| `pt-BR` | "Novas permissões do Microsoft 365 são necessárias para Acesso Condicional, Pontuação de Segurança e visibilidade de funções de administrador. Um administrador global precisa aprová-las." | "Aprovar novas permissões" | "Não foi possível iniciar a aprovação das novas permissões." |
| `tr-TR` | "Koşullu Erişim, Güvenli Puan ve yönetici rolü görünürlüğü için yeni Microsoft 365 izinleri gereklidir. Bunları bir Genel Yönetici onaylamalıdır." | "Yeni izinleri onayla" | "Yeni izinlerin onayı başlatılamadı." |

- [ ] **Step 4: Widen the read card's types and parser**

In `apps/web/src/components/integrations/M365CustomerGraphReadCard.tsx`, add the health enum next to `STABLE_ERROR_CODES` (line 47):

```tsx
const GRANT_HEALTH_STATES = [
  "active",
  "degraded",
  "missing",
  "unexpected",
  "both",
  "manifest-stale",
] as const;
type GrantHealthState = (typeof GRANT_HEALTH_STATES)[number];
```

Widen `Connection` (lines 68-80) and `Envelope` (lines 82-92):

```tsx
type Connection = {
  id: string;
  tenantId: string | null;
  clientId: string | null;
  displayName: string | null;
  status: ConnectionStatus;
  grantHealth: GrantHealthState;
  manifestVersion: number;
  currentManifestVersion: number;
  observedGrants: Grant[];
  missingGrants: Grant[];
  unexpectedGrants: Grant[];
  grantsVerifiedAt: string | null;
  lastVerifiedAt: string | null;
  lastErrorCode: string | null;
};

type Envelope = {
  profile: {
    id: "customer-graph-read";
    displayName: string;
    // Was the literal 2. The manifest is the source of truth; pinning a number
    // here would have to be edited on every bump.
    manifestVersion: number;
    requiredGrants: Grant[];
  };
  onboardingEnabled: boolean;
  connection: Connection | null;
};

type ActionName = "consent" | "upgrade" | "retest" | "disconnect";
```

Extend `parseConnection` (lines 173-211):

```tsx
  const keys = [
    "id", "tenantId", "clientId", "displayName", "status", "grantHealth",
    "manifestVersion", "currentManifestVersion",
    "observedGrants", "missingGrants", "unexpectedGrants", "grantsVerifiedAt",
    "lastVerifiedAt", "lastErrorCode",
  ];
```
add to the rejection expression (after the `manifestVersion` clause, line 192):
```tsx
    || typeof value.grantHealth !== "string"
      || !(GRANT_HEALTH_STATES as readonly string[]).includes(value.grantHealth)
    || typeof value.currentManifestVersion !== "number"
      || !Number.isSafeInteger(value.currentManifestVersion)
      || value.currentManifestVersion < 1
```
and to the returned object (after `status`, line 202):
```tsx
    grantHealth: value.grantHealth as GrantHealthState,
    manifestVersion: value.manifestVersion,
    currentManifestVersion: value.currentManifestVersion,
```

In `parseEnvelope` (line 230), replace the hard-coded `manifestVersion: 2,` with `manifestVersion: TRUSTED_PROFILE.version,`.

- [ ] **Step 5: Add the upgrade action and the banner**

After the `retest` callback (line 457):

```tsx
  const startUpgradeConsent = useCallback(() => {
    if (!orgId || !data?.connection || !canWrite) return;
    const target = scope;
    const connectionId = data.connection.id;
    void perform(target, "upgrade", async () => {
      try {
        const url = await runAction<string>({
          request: () => scopedRequest(
            target,
            () => fetchWithAuth(
              `/m365/connections/${connectionId}/upgrade-consent?orgId=${target.orgId}`,
              { method: "POST" },
            ),
            { adminConsentUrl: "https://login.microsoftonline.com/organizations/" },
          ),
          parseSuccess: parseConsentUrl,
          errorFallback: t("m365CustomerGraphRead.actions.upgradeFailed"),
        });
        if (isCurrent(target)) navigateTo(url);
      } catch (error) {
        if (isCurrent(target)) {
          handleActionError(error, t("m365CustomerGraphRead.actions.upgradeFailed"));
        }
      }
    });
  }, [canWrite, data, isCurrent, orgId, perform, scope, scopedRequest, t]);
```

Suppress the duplicate `manifest_stale` error line in the `errorCopy` memo (lines 503-508):

```tsx
  const errorCopy = useMemo(() => {
    if (!connection?.lastErrorCode) return null;
    // The banner below already says this, in words an administrator can act on.
    if (connection.grantHealth === "manifest-stale" && connection.lastErrorCode === "manifest_stale") {
      return null;
    }
    return isStableErrorCode(connection.lastErrorCode)
      ? t(/* i18n-dynamic */ `m365CustomerGraphRead.errors.${connection.lastErrorCode}`)
      : t("m365CustomerGraphRead.errors.unknown");
  }, [connection, t]);
```

And the banner, inside the `loadState === "ready"` block right after the `errorCopy` paragraph (line 575):

```tsx
          {connection?.grantHealth === "manifest-stale" && (
            <div
              role="alert"
              data-testid="m365-read-manifest-stale-banner"
              className="rounded-md border border-warning/40 bg-warning/10 p-4 text-sm text-foreground"
            >
              <div className="flex items-start gap-2">
                <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <p>{t("m365CustomerGraphRead.upgrade.banner")}</p>
              </div>
              <button
                type="button"
                onClick={startUpgradeConsent}
                disabled={!canWrite || action !== null}
                data-testid="m365-read-approve-new-permissions"
                className="mt-3 inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                {action === "upgrade" && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
                {t("m365CustomerGraphRead.actions.approveNewPermissions")}
              </button>
            </div>
          )}
```

- [ ] **Step 6: Widen the actions card's parser (no UI change)**

Apply Step 4's `GRANT_HEALTH_STATES` const, `Connection` fields, `Envelope.profile.manifestVersion: number`, `parseConnection` key list, validation clauses, returned fields, and the `parseEnvelope` literal replacement (`manifestVersion: 1,` → `manifestVersion: TRUSTED_PROFILE.version,`) to `apps/web/src/components/integrations/M365CustomerGraphActionsCard.tsx`. Add no banner and no button: there is no actions upgrade route this wave.

- [ ] **Step 7: Run the web tests to verify they pass**

```bash
cd apps/web && npx vitest run src/components/integrations src/lib/i18n/localeParity.test.ts
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/integrations/M365CustomerGraphReadCard.tsx \
  apps/web/src/components/integrations/M365CustomerGraphReadCard.test.tsx \
  apps/web/src/components/integrations/M365CustomerGraphActionsCard.tsx \
  apps/web/src/components/integrations/M365CustomerGraphActionsCard.test.tsx \
  apps/web/src/locales && \
git commit -m "feat(m365): surface manifest-stale with an approve-new-permissions banner" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 12: Deploy doc and self-hoster release note

Spec §2.2 ("Self-hosters with their own read-app registration must add the four app roles before their admins can approve") and §10 item 5.

**Files:**
- Modify: `docs/deploy/m365-customer-graph-read-executor.md` — the permission table (lines 39-51)
- Create: `docs/release-notes/m365-customer-graph-read-manifest-v3.md`
- Test: none (documentation).

**Interfaces:**
- Consumes: the four verified GUIDs from Task 1 — the deploy table and the manifest must agree character for character, because a self-hoster copies the table into their own Entra app registration.

- [ ] **Step 1: Extend the deploy-doc permission table**

In `docs/deploy/m365-customer-graph-read-executor.md`, add four rows in alphabetical position and replace the "All nine roles" sentence (line 51):

```markdown
| Permission | App role ID |
|---|---|
| `Application.Read.All` | `9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30` |
| `AuditLog.Read.All` | `b0afded3-3588-46d8-8b3d-9842eff778da` |
| `AuditLogsQuery.Read.All` | `<VERIFIED AuditLogsQuery.Read.All appRoleId from Task 1>` |
| `Device.Read.All` | `7438b122-aefc-4978-80ed-43db9fcc7715` |
| `DeviceManagementConfiguration.Read.All` | `dc377aa6-52d8-4e23-b271-2a7ae04cedf3` |
| `DeviceManagementManagedDevices.Read.All` | `2f51be20-0bb4-4fed-bf7b-db946066c75e` |
| `Group.Read.All` | `5b567255-7703-4780-807c-7be8301ae99b` |
| `Organization.Read.All` | `498476ce-e0fe-48b0-b801-37ba7e2685c6` |
| `Policy.Read.All` | `<VERIFIED Policy.Read.All appRoleId from Task 1>` |
| `RoleManagement.Read.Directory` | `<VERIFIED RoleManagement.Read.Directory appRoleId from Task 1>` |
| `SecurityEvents.Read.All` | `<VERIFIED SecurityEvents.Read.All appRoleId from Task 1>` |
| `Sites.Read.All` | `332a536c-c7ef-4017-ab91-336970924f0d` |
| `User.Read.All` | `df021288-bdef-4463-88db-98f22de89214` |

All thirteen roles belong to the Microsoft Graph resource application `00000003-0000-0000-c000-000000000000`. The shared code manifest is authoritative. `Application.Read.All` is required for authoritative app-role-assignment reconciliation; it is not exposed as a general application-directory query tool.

The last four arrived with permission manifest **v3** (2026-09-08) for the tenant-sync foundation: `Policy.Read.All` for Conditional Access policies and named locations, `RoleManagement.Read.Directory` for admin role membership, `SecurityEvents.Read.All` for Secure Score, and `AuditLogsQuery.Read.All` for the unified audit log. They were added in one bump so customer administrators re-consent once. Until you add them to your application registration, your customers' administrators cannot approve them, connections stay at manifest v2, and Breeze keeps serving reads on the v2 grants — the upgrade banner in **Settings → Integrations** simply cannot be completed.
```

Replace the `<VERIFIED …>` tokens with the recorded GUIDs, then confirm none survives:
```bash
grep -n '<VERIFIED' docs/deploy/m365-customer-graph-read-executor.md
```
Expected: no output.

- [ ] **Step 2: Cross-check the doc against the code manifest**

```bash
python3 - <<'PY'
import re, pathlib
doc = pathlib.Path('docs/deploy/m365-customer-graph-read-executor.md').read_text()
src = pathlib.Path('packages/shared/src/m365/profiles.ts').read_text()
read = src.split("'customer-graph-read'", 1)[1].split("'customer-graph-actions'", 1)[0]
code = dict(re.findall(r"appRoleId: '([0-9a-f-]{36})',\s*\n\s*value: '([^']+)'", read))
table = {gid: name for name, gid in re.findall(r"\|\s*`([A-Za-z.\-]+)`\s*\|\s*`([0-9a-f-]{36})`\s*\|", doc)}
assert code == table, f"doc/code mismatch:\ncode-only {set(code.items()) - set(table.items())}\ndoc-only  {set(table.items()) - set(code.items())}"
print(f"OK: {len(code)} roles agree between the deploy doc and the shared manifest")
PY
```
Expected: `OK: 13 roles agree …`.

- [ ] **Step 3: Write the release note**

Create `docs/release-notes/m365-customer-graph-read-manifest-v3.md`, following the format of `docs/release-notes/m365-ticket-mailbox-reconsent.md`:

```markdown
# Microsoft 365 Customer Graph Read permission manifest v3

## Action required

This release raises the `customer-graph-read` permission manifest from version 2 to version 3, adding four Microsoft Graph application permissions that the Microsoft 365 tenant-sync features need:

| Permission | Unlocks |
|---|---|
| `Policy.Read.All` | Conditional Access policies and named locations |
| `RoleManagement.Read.Directory` | Directory role assignments and admin counts |
| `SecurityEvents.Read.All` | Microsoft Secure Score and control profiles |
| `AuditLogsQuery.Read.All` | Unified audit log queries |

All four are added in a single bump so each customer administrator re-consents once rather than once per feature.

**Existing connections keep working.** A connection consented under v2 continues to serve every read it served before, on the grants it already holds. It is reported as `manifest-stale` and shows an amber banner in **Settings → Integrations**: "New Microsoft 365 permissions are required for Conditional Access, Secure Score, and admin role visibility. A Global Administrator must approve them." Selecting **Approve new permissions** starts a Microsoft admin-consent flow that leaves the connection executable throughout — if the administrator abandons or cancels it, nothing changes.

**Self-hosters who run their own Customer Graph Read application registration must add the four app roles before their customers' administrators can approve them.** The exact app role IDs are in `docs/deploy/m365-customer-graph-read-executor.md` under "Entra application and permission manifest". Until they are added, the banner appears but the consent cannot complete.

Breeze-hosted customers need no action beyond having a Global Administrator approve the banner.

## Deployment

1. Deploy the database migration and API together. The migration adds one nullable-free column with a default (`m365_consent_sessions.purpose`) and takes no lock beyond a brief `ACCESS EXCLUSIVE` on a small table.
2. Confirm that the API and migration are healthy.
3. Deploy the web UI.
4. Self-hosters: add the four app roles to the Customer Graph Read application registration.
5. Ask each customer's Global Administrator to complete **Approve new permissions**.

There is no ordering hazard between the API and the web UI: the banner is derived server-side and simply does not render until the API ships.

## Verification

Run the following as a database administrator after deployment. It lists connections still on the old manifest — expected to be non-empty until administrators approve, and expected to shrink as they do.

```sql
SELECT id, org_id, tenant_id, display_name, permission_manifest_version, status
FROM m365_connections
WHERE profile = 'customer-graph-read'
  AND status IN ('active', 'degraded')
  AND permission_manifest_version < 3
ORDER BY display_name;
```

Every row in that list must still be `active` or `degraded` — never `pending-consent`. A `customer-graph-read` connection sitting in `pending-consent` after an upgrade attempt would mean the upgrade path wrote a status it must never write; treat it as a defect and re-consent the connection through **Re-consent**.

After a successful approval, the connection's `permission_manifest_version` is 3, its `consent_generation` has increased by one, and `grants_verified_at` is refreshed.

## Rollback

If the application deployment must be rolled back:

- Keep the `m365_consent_sessions.purpose` column. It defaults to `initial`, which is exactly how the previous release's code treats every session.
- Connections already promoted to manifest v3 keep working on the older code: `deriveGrantHealth` compares against whatever manifest that build carries, so a v3 row against a v2 build reports `manifest-stale` and continues serving reads.
- Do not remove the four app roles from the application registration. Extra granted roles are reported as `unexpected` on the card, not as a failure, and removing them would break any connection already promoted.
```

- [ ] **Step 4: Commit**

```bash
git add docs/deploy/m365-customer-graph-read-executor.md \
  docs/release-notes/m365-customer-graph-read-manifest-v3.md && \
git commit -m "docs(m365): document the v3 app roles and the upgrade-consent release note" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 13: Integration coverage for the upgrade path against real Postgres

Spec §9 ("Re-consent tests: v2 row derives `manifest-stale`, DTO exposes it, sync still runs; simulated upgrade callback promotes to v3; abandoned upgrade leaves v2 executing").

**Files:**
- Modify: `apps/api/src/__tests__/integration/m365ConnectionLifecycle.integration.test.ts` — append a new `describe` after the existing cases (file is 266 lines)
- Test: same file.

**Interfaces:**
- Consumes: `initiateCustomerGraphReadUpgradeConsent`, `transitionUpgradeConsentToIdentity`, `applyUpgradeVerificationResult` (Tasks 5, 6), `readConsentSessionPurpose` (Task 4).

**Why real Postgres.** Three of the properties here cannot be proven against a Drizzle mock: that binding a session to the existing attempt satisfies the composite FK; that the `purpose` CHECK rejects a third value; and that `retestConnection` no longer raises 23503 with an upgrade session live. The file already replays against the migrated schema through `./setup` and runs in the **Integration Tests** job.

- [ ] **Step 1: Write the failing integration cases**

Append to `apps/api/src/__tests__/integration/m365ConnectionLifecycle.integration.test.ts`:

```ts
describe('customer Graph-read upgrade consent integration', () => {
  async function executableConnection() {
    const owner = await ownerFixture();
    const initiated = await initiateCustomerGraphReadConsent({
      orgId: owner.orgId,
      actorId: owner.actorId,
    });
    const tenantId = crypto.randomUUID();
    const verifiedAt = new Date('2026-09-01T16:00:00.000Z');
    await withSystemDbAccessContext(() => db.update(m365Connections).set({
      tenantId,
      displayName: 'Contoso',
      permissionManifestVersion: 2,
      observedGrants: [],
      grantsVerifiedAt: verifiedAt,
      lastVerifiedAt: verifiedAt,
      consentedAt: verifiedAt,
      status: 'active',
      lastErrorCode: null,
    }).where(eq(m365Connections.id, initiated.connection.id)));
    return { ...owner, connectionId: initiated.connection.id, tenantId };
  }

  runDb('binds an upgrade session to the existing attempt and leaves the connection active', async () => {
    const fixture = await executableConnection();
    const before = await currentConnection(fixture.orgId);

    const initiated = await initiateCustomerGraphReadUpgradeConsent({
      connectionId: fixture.connectionId,
      orgId: fixture.orgId,
      auth: authContextFor(fixture),          // build from the fixture's org + user
    });

    const after = await currentConnection(fixture.orgId);
    expect(after?.status).toBe('active');
    expect(after?.consentAttemptId).toBe(before?.consentAttemptId);
    expect(after?.permissionManifestVersion).toBe(2);

    const sessions = await withSystemDbAccessContext(() => db.select()
      .from(m365ConsentSessions)
      .where(eq(m365ConsentSessions.connectionId, fixture.connectionId)));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.purpose).toBe('upgrade');
    expect(sessions[0]!.consentAttemptId).toBe(before?.consentAttemptId);
    expect(initiated.consentUrl).toContain('adminconsent');
  });

  runDb('rejects a purpose outside the two legal values', async () => {
    const fixture = await executableConnection();
    const conn = await currentConnection(fixture.orgId);
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO m365_consent_sessions
        (state_hash, phase, purpose, connection_id, org_id, profile, consent_attempt_id, user_id, expires_at)
      VALUES (
        ${'f'.repeat(64)}, 'admin_consent', 'sideways', ${conn!.id}, ${fixture.orgId},
        'customer-graph-read', ${conn!.consentAttemptId}, ${fixture.actorId}, now() + interval '10 minutes'
      )
    `))).rejects.toThrow(/m365_consent_sessions_purpose_check|violates check constraint/);
  });

  runDb('promotes the manifest in place and bumps the consent generation on a full approval', async () => {
    const fixture = await executableConnection();
    await initiateCustomerGraphReadUpgradeConsent({
      connectionId: fixture.connectionId,
      orgId: fixture.orgId,
      auth: authContextFor(fixture),
    });
    const conn = await currentConnection(fixture.orgId);
    const manifest = M365_PERMISSION_PROFILES['customer-graph-read'];

    const applied = await applyUpgradeVerificationResult({
      id: conn!.id,
      orgId: fixture.orgId,
      profile: 'customer-graph-read',
      consentAttemptId: conn!.consentAttemptId!,
      status: 'active',
    }, {
      success: true,
      tenantId: fixture.tenantId,
      applicationId: '55555555-5555-4555-8555-555555555555',
      organizationDisplayName: 'Contoso',
      manifestVersion: manifest.version,
      verifiedAt: '2026-09-08T10:00:00.000Z',
      grantReconciliation: 'complete',
      grantsVerifiedAt: '2026-09-08T10:00:01.000Z',
      observedGrants: [...(manifest.applicationPermissionAssignments ?? [])],
    } as never);

    expect(applied.permissionManifestVersion).toBe(manifest.version);
    expect(applied.status).toBe('active');
    const after = await currentConnection(fixture.orgId);
    expect(after?.consentGeneration).toBe((conn?.consentGeneration ?? 0) + 1);
  });

  runDb('leaves an abandoned upgrade executing on the old manifest', async () => {
    const fixture = await executableConnection();
    await initiateCustomerGraphReadUpgradeConsent({
      connectionId: fixture.connectionId,
      orgId: fixture.orgId,
      auth: authContextFor(fixture),
    });
    const conn = await currentConnection(fixture.orgId);

    await applyUpgradeVerificationResult({
      id: conn!.id,
      orgId: fixture.orgId,
      profile: 'customer-graph-read',
      consentAttemptId: conn!.consentAttemptId!,
      status: 'active',
    }, { success: false, errorCode: 'consent_cancelled' } as never);

    const after = await currentConnection(fixture.orgId);
    expect(after?.status).toBe('active');
    expect(after?.permissionManifestVersion).toBe(2);
    expect(after?.consentGeneration).toBe(conn?.consentGeneration);
    expect(after?.lastVerifiedAt).toEqual(conn?.lastVerifiedAt);
  });

  runDb('lets a retest rotate the attempt while an upgrade session is live', async () => {
    // Before the fix in Task 7 this raised 23503: the consent-session composite
    // FK has ON DELETE CASCADE but no ON UPDATE CASCADE.
    const fixture = await executableConnection();
    await initiateCustomerGraphReadUpgradeConsent({
      connectionId: fixture.connectionId,
      orgId: fixture.orgId,
      auth: authContextFor(fixture),
    });

    await expect(retestCustomerGraphReadConnection({
      id: fixture.connectionId,
      orgId: fixture.orgId,
      auth: authContextFor(fixture),
      executorClient: {
        retestCustomerGraphRead: async () => ({ success: false, errorCode: 'credential_unavailable' }),
      } as never,
    })).resolves.toBeDefined();

    const sessions = await withSystemDbAccessContext(() => db.select()
      .from(m365ConsentSessions)
      .where(eq(m365ConsentSessions.connectionId, fixture.connectionId)));
    expect(sessions).toHaveLength(0);
  });
});
```

Import `initiateCustomerGraphReadUpgradeConsent`, `applyUpgradeVerificationResult` and `retestCustomerGraphReadConnection` from `'../../services/m365ControlPlane/connectionService'`, and add a local `authContextFor(fixture)` helper that returns an org-scoped `AuthContext` shaped exactly like the one `loadRetestSnapshot` already consumes in this suite — read how the file builds one today and reuse it rather than inventing a second shape.

- [ ] **Step 2: Run the integration suite to verify it fails, then passes**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5433/breeze"
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/m365ConnectionLifecycle.integration.test.ts
```
Expected before Tasks 5-7 are in place: FAIL. With them in place: PASS. If no local Postgres is available the cases are skipped by `runDb` — **that is not a pass.** Confirm the shard log in CI shows them executing before claiming coverage.

- [ ] **Step 3: Run the contract suites that this wave's column touches**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts
```
Expected: PASS. `tenant-export-policy` is the one that fails if Task 3 Step 5 was skipped — it fires on a new **column**, and it cannot fail in the Test API job.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/m365ConnectionLifecycle.integration.test.ts && \
git commit -m "test(m365): prove upgrade consent promotes in place and never interrupts reads" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb"
```

---

### Task 14: Wave verification and pull request

**Files:**
- Modify: none.
- Test: the whole wave.

- [ ] **Step 1: Run every suite this wave touched**

```bash
cd packages/shared && npx vitest run src/m365
cd apps/api && npx vitest run src/services/m365ControlPlane src/routes/m365 src/db/schema/m365ConsentSessionPurpose.test.ts src/db/autoMigrate.test.ts
cd apps/web && npx vitest run src/components/integrations src/lib/i18n/localeParity.test.ts
```
Expected: all PASS, with no skipped files.

- [ ] **Step 2: Typecheck all three packages**

```bash
pnpm --filter @breeze/shared typecheck
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
cd apps/web && pnpm exec astro check
```
Expected: no errors. (These are exactly the three commands the CI **Type Check** job runs.)

- [ ] **Step 3: Lint and the migration guards**

```bash
pnpm lint
bash scripts/check-migration-naming.sh
```
Expected: clean. If `check-migration-naming.sh` reports that `2026-10-15-090000-…` no longer sorts last (another branch landed a later migration on main), rename the file, sweep every reference to the old path (`m365ConsentSessionPurpose.test.ts` reads it by name), and re-run `src/db/autoMigrate.test.ts`.

- [ ] **Step 4: Merge main and re-verify**

```bash
git fetch origin main && git merge origin/main
```
Then re-run Steps 1-3. PR CI tests the merge commit, so a green local branch is not a green PR.

- [ ] **Step 5: Confirm the four verified GUIDs agree everywhere**

```bash
python3 - <<'PY'
import re, pathlib
src = pathlib.Path('packages/shared/src/m365/profiles.ts').read_text()
read = src.split("'customer-graph-read'", 1)[1].split("'customer-graph-actions'", 1)[0]
code = dict(re.findall(r"appRoleId: '([0-9a-f-]{36})',\s*\n\s*value: '([^']+)'", read))
for path in ['packages/shared/src/m365/profiles.test.ts',
             'docs/deploy/m365-customer-graph-read-executor.md']:
    text = pathlib.Path(path).read_text()
    for gid, name in code.items():
        assert gid in text, f"{path} is missing the {name} app role id"
assert len(code) == 13, f"expected 13 assignments, found {len(code)}"
print("OK: 13 app role ids agree across manifest, manifest test, and deploy doc")
PY
```
Expected: the OK line.

- [ ] **Step 6: Open the pull request**

```bash
gh pr create --base main \
  --title "feat(m365): manifest v3 + non-interrupting upgrade consent (W01)" \
  --body "$(cat <<'BODY'
Wave 1 of the M365 tenant sync foundation. Implements spec §2 in full.

Spec: `docs/superpowers/specs/integrations/2026-09-08-m365-tenant-sync-foundation-design.md`
Plan: `docs/superpowers/plans/integrations/2026-09-08-m365-tenant-sync-1-manifest-v3-upgrade-consent.md`

## What changed

- **Manifest v3.** `customer-graph-read` gains `Policy.Read.All`, `RoleManagement.Read.Directory`, `SecurityEvents.Read.All` and `AuditLogsQuery.Read.All` in one bump, so customer administrators re-consent once for the whole posture program. Every app role ID was read from the live Microsoft Graph service principal and cross-checked against the permissions-reference doc — none was typed from memory.
- **Upgrade consent.** `POST /m365/connections/:id/upgrade-consent` (MFA-gated, same middleware chain as retest) mints an `admin_consent` session bound to the **existing** connection id and attempt and writes nothing to `m365_connections`. On a successful callback with all v3 grants observed, `permission_manifest_version` is promoted in place and `consent_generation` is bumped. On failure, cancellation, or abandonment nothing changes and the connection keeps executing on its v2 grants. `markConsentAttemptFailed` — which writes `status = 'pending-consent'` — is never reachable from an upgrade.
- **`m365_consent_sessions.purpose`** (`initial` | `upgrade`) tells the shared callback which flow it is resuming before it validates the connection status. One idempotent migration, registered in `CORE_TENANT_EXPORT_POLICY`.
- **DTOs** on both the read and actions surfaces now carry `grantHealth`, `manifestVersion` (stored) and `currentManifestVersion`. Both web card parsers were widened in the same PR — `hasExactKeys` is exact in both directions, so an unparsed extra field would have made the cards render "unavailable".
- **Card.** `manifest-stale` renders an amber banner with an "Approve new permissions" button wired through `runAction`. Missing grants on a current manifest keep the existing degraded rendering.
- **Bug fixed on the way.** `loadRetestSnapshot` rotates `consent_attempt_id`, and the consent-session composite FK has `ON DELETE CASCADE` but no `ON UPDATE CASCADE`. Before this wave an executable connection never carried a live session, so this never fired; upgrade consent breaks that invariant by design. `retestConnection` now supersedes the connection's sessions first, with an integration test that would have raised 23503 without it.

## Deviations from the shared interface contract

- `initiateCustomerGraphReadUpgradeConsent` drops the contract's `returnTo?` parameter. The consent callback's terminal redirect is a fixed `/integrations#m365/<profile>` base with no return-to plumbing anywhere in the two-phase flow, and a caller-supplied redirect target on a consent callback is an open-redirect surface that would need its own allowlist. Nothing in W02–W06 consumes it.

## Testing

- `packages/shared`: manifest v3 asserted as an exact set — adding a fifth scope fails too.
- `apps/api`: connection-service unit cases for every row of the promotion table (promote / record-only / five distinct no-ops), the upgrade identity transition, and the retest ordering; callback DI cases for status routing, the never-fail-an-upgrade rule, and outcome derivation; route cases for MFA, permission, cross-org 404 and 409.
- Integration (real Postgres): session bound to the existing attempt with status unchanged, the `purpose` CHECK, in-place promotion with a `consent_generation` bump, an abandoned upgrade leaving v2 executing, and retest-during-upgrade no longer raising 23503.
- `apps/web`: banner presence/absence, the upgrade `runAction` round trip, non-Microsoft URL refusal, permission gating, and a fail-closed parse when the server omits the new fields.

## Self-hoster impact

Self-hosters running their own Customer Graph Read app registration must add the four app roles before their customers' administrators can approve them — `docs/release-notes/m365-customer-graph-read-manifest-v3.md` and the deploy doc carry the exact IDs. Reads keep working on v2 grants until they do.

Closes #5328

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01Uy7n1p7JUTxD7DUA7WDSsb
BODY
)"
```

- [ ] **Step 7: Confirm CI is green on the merge commit**

```bash
gh pr checks --watch ; true
```
`gh pr checks` exits non-zero while checks are pending, so never chain it with `&&` in a poll loop. The blocking jobs for this wave are **Test API**, **Test Web**, **Type Check**, **Lint**, **Check Migrations**, and **Integration Tests** — the last is where the export-policy and cascade contracts actually run.
