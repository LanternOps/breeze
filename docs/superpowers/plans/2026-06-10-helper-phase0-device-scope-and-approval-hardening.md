# Helper Phase 0 — Device-Scope & Approval Hardening (finding A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close security finding A (HIGH) — make the Breeze Helper token unable to reach any device but its own and unable to self-approve actions — without depending on PR #1183.

**Architecture:** A central device-scope gate in `executeTool` keyed on a new `AuthContext.helperDeviceId` forces every Helper tool's device input to the Helper's own device and denies org-wide tools; the Helper defaults to a curated single-device read-only tool set; the self-approve endpoint is removed so approvals can only come from the existing authenticated `/ai` path.

**Tech Stack:** Hono, TypeScript, Drizzle ORM, Vitest (`apps/api/vitest.config.ts`). Node pinned: prefix commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`.

**Spec:** `docs/superpowers/specs/2026-06-10-helper-privileged-action-pam-governance-design.md` (Phase 0 only — Phase 1 PAM integration is a separate plan).

**Worktree/base:** `/Users/toddhebebrand/breeze-sec-fixes`, branch off `origin/main`. Run all commands from the worktree root.

---

## File Structure

- **Modify** `apps/api/src/middleware/auth.ts` — add `helperDeviceId?: string` to `AuthContext` (interface at lines 16-64).
- **Modify** `apps/api/src/services/aiTools.ts` — add `HELPER_TOOL_SCOPING` map + `applyHelperDeviceScope()` (pure, exported), wire into `executeTool` (247-268); add `helperDeviceId` lock to `verifyDeviceAccess` (90-106).
- **Create** `apps/api/src/services/aiTools.helperScope.test.ts` — unit tests for the gate + lock.
- **Modify** `apps/api/src/routes/helper/index.ts` — set `helperDeviceId` in the synthetic `AuthContext` (135-159); change `DEFAULT_PERMISSION_LEVEL` (line 34) to `'basic'`; delete the self-approve endpoint (641-690).
- **Create** `apps/api/src/routes/helper/helperApprove.removed.test.ts` — asserts the self-approve route is gone.
- **Modify** `apps/api/src/services/helperToolFilter.ts` — revise the `basic` set to the curated single-device allowlist.
- **Create** `apps/api/src/services/helperToolFilter.test.ts` — asserts `basic` set matches the scoping map and excludes org-wide/mutating tools.

Branch name for the work: `fix/helper-phase0-device-scope`. Create it off `origin/main` before Task 1:

```bash
cd /Users/toddhebebrand/breeze-sec-fixes && git fetch origin -q && git checkout -b fix/helper-phase0-device-scope origin/main
```

---

### Task 1: Add `helperDeviceId` to `AuthContext`

**Files:**
- Modify: `apps/api/src/middleware/auth.ts` (interface `AuthContext`, lines 16-64)

- [ ] **Step 1: Add the field**

In `apps/api/src/middleware/auth.ts`, inside `export interface AuthContext { ... }`, after the `canAccessSite?` member (around line 63), add:

```ts
  /**
   * Set ONLY for Breeze Helper sessions (helperAuth). When present, the
   * AI-tools executeTool gate forces every tool's device input to this device
   * id and denies org-wide tools — the Helper can act only on its own device.
   * Undefined for all normal (user/agent) contexts.
   */
  helperDeviceId?: string;
```

- [ ] **Step 2: Verify it compiles**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit 2>&1 | grep -E "middleware/auth" || echo "auth.ts clean"`
Expected: `auth.ts clean` (the new optional field breaks nothing; pre-existing errors in `agents.test.ts`/`apiKeyAuth.test.ts` are unrelated).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/middleware/auth.ts
git commit -m "feat(auth): add optional AuthContext.helperDeviceId for Helper device-scoping"
```

---

### Task 2: Add the central Helper device-scope gate to `aiTools`

**Files:**
- Modify: `apps/api/src/services/aiTools.ts` (add map + `applyHelperDeviceScope`; wire into `executeTool` at 247-268)
- Test: `apps/api/src/services/aiTools.helperScope.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/aiTools.helperScope.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { applyHelperDeviceScope, HELPER_TOOL_SCOPING } from './aiTools';

const HELPER_DEVICE = '11111111-1111-1111-1111-111111111111';
const OTHER_DEVICE = '22222222-2222-2222-2222-222222222222';

describe('applyHelperDeviceScope', () => {
  it('forces deviceId to the helper device, overriding a forged value', () => {
    const r = applyHelperDeviceScope('get_device_details', { deviceId: OTHER_DEVICE }, HELPER_DEVICE);
    expect('input' in r && r.input).toEqual({ deviceId: HELPER_DEVICE });
  });

  it('injects deviceId when the caller omitted it', () => {
    const r = applyHelperDeviceScope('analyze_metrics', {}, HELPER_DEVICE);
    expect('input' in r && r.input).toEqual({ deviceId: HELPER_DEVICE });
  });

  it('forces deviceIds to [helperDevice] for array-shaped tools', () => {
    const r = applyHelperDeviceScope('search_logs', { deviceIds: [OTHER_DEVICE], level: ['error'] }, HELPER_DEVICE);
    expect('input' in r && r.input).toEqual({ deviceIds: [HELPER_DEVICE], level: ['error'] });
  });

  it('denies an org-wide tool not in the scoping map', () => {
    const r = applyHelperDeviceScope('query_devices', {}, HELPER_DEVICE);
    expect('error' in r).toBe(true);
  });

  it('every scoped tool maps to a known device field name', () => {
    for (const field of Object.values(HELPER_TOOL_SCOPING)) {
      expect(['deviceId', 'deviceIds']).toContain(field);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/aiTools.helperScope.test.ts --no-file-parallelism`
Expected: FAIL — `applyHelperDeviceScope`/`HELPER_TOOL_SCOPING` are not exported from `./aiTools`.

- [ ] **Step 3: Implement the map and the pure gate**

In `apps/api/src/services/aiTools.ts`, add near the other shared helpers (e.g. just above `export async function executeTool`):

```ts
/**
 * Helper device-scoping (security finding A, Phase 0).
 * Maps each tool the Breeze Helper may run to the input field naming its
 * target device. A tool absent from this map is org-wide and is DENIED under
 * a Helper context. The Helper's default tool set (helperToolFilter `basic`)
 * is kept in sync with these keys.
 */
export const HELPER_TOOL_SCOPING: Record<string, 'deviceId' | 'deviceIds'> = {
  get_device_details: 'deviceId',
  analyze_metrics: 'deviceId',
  analyze_disk_usage: 'deviceId',
  get_cis_device_report: 'deviceId',
  get_s1_status: 'deviceId',
  get_security_posture: 'deviceId',
  take_screenshot: 'deviceId',
  analyze_screen: 'deviceId',
  search_logs: 'deviceIds',
};

/**
 * Force a Helper tool call onto the Helper's own device, or deny it.
 * Pure — the caller (executeTool) applies the result.
 */
export function applyHelperDeviceScope(
  toolName: string,
  input: Record<string, unknown>,
  helperDeviceId: string
): { input: Record<string, unknown> } | { error: string } {
  const field = HELPER_TOOL_SCOPING[toolName];
  if (!field) {
    return { error: `Tool '${toolName}' is not available in the Helper context` };
  }
  const value = field === 'deviceIds' ? [helperDeviceId] : helperDeviceId;
  return { input: { ...input, [field]: value } };
}
```

- [ ] **Step 4: Wire the gate into `executeTool`**

In `apps/api/src/services/aiTools.ts`, replace the body of `executeTool` (lines 247-268) so the Helper gate runs first and the forced input flows through validation, the device-args gate, and the handler:

```ts
export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  auth: AuthContext
): Promise<string> {
  const tool = aiTools.get(toolName);
  if (!tool) throw new Error(`Unknown tool: ${toolName}`);

  // Helper device-scope gate (finding A): force the tool onto the Helper's own
  // device, or deny org-wide tools, before anything else runs.
  let effectiveInput = input;
  if (auth.helperDeviceId) {
    const scoped = applyHelperDeviceScope(toolName, input, auth.helperDeviceId);
    if ('error' in scoped) return JSON.stringify({ error: scoped.error });
    effectiveInput = scoped.input;
  }

  // Validate input against Zod schema before execution
  const validation = validateToolInput(toolName, effectiveInput);
  if (!validation.success) {
    return JSON.stringify({ error: validation.error });
  }

  // Structural device-tenant gate: any id named in `tool.deviceArgs` is
  // org+site-checked before the handler runs, so a tool can't reach a device
  // outside the caller's scope even if its handler forgets to check.
  const gate = await enforceDeviceArgs(tool, effectiveInput, auth);
  if (!gate.ok) return JSON.stringify({ error: gate.error });

  return tool.handler(effectiveInput, auth);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/aiTools.helperScope.test.ts --no-file-parallelism`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/aiTools.ts apps/api/src/services/aiTools.helperScope.test.ts
git commit -m "feat(ai-tools): central Helper device-scope gate in executeTool (finding A)"
```

---

### Task 3: Defense-in-depth lock in `verifyDeviceAccess`

**Files:**
- Modify: `apps/api/src/services/aiTools.ts` (`verifyDeviceAccess`, lines 90-106)
- Test: `apps/api/src/services/aiTools.helperScope.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/aiTools.helperScope.test.ts`:

```ts
import { verifyDeviceAccess } from './aiTools';
import type { AuthContext } from '../middleware/auth';

function helperAuth(deviceId: string): AuthContext {
  return {
    user: { id: deviceId, email: 'h', name: 'h', isPlatformAdmin: false },
    token: {} as AuthContext['token'],
    partnerId: null,
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    helperDeviceId: deviceId,
  };
}

describe('verifyDeviceAccess helper lock', () => {
  it('denies a device other than helperDeviceId without touching the DB', async () => {
    const res = await verifyDeviceAccess(OTHER_DEVICE, helperAuth(HELPER_DEVICE));
    expect('error' in res).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/aiTools.helperScope.test.ts --no-file-parallelism`
Expected: FAIL — without the lock, the function runs the DB select (no mock) and does not return the early error.

- [ ] **Step 3: Add the lock**

In `apps/api/src/services/aiTools.ts`, at the very top of `verifyDeviceAccess` (before building `conditions`, line ~95), add:

```ts
  // Helper device lock (finding A, defense-in-depth): a Helper context may only
  // ever resolve its own device. Return before any DB access.
  if (auth.helperDeviceId && deviceId !== auth.helperDeviceId) {
    return { error: 'Device not found or access denied' };
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/aiTools.helperScope.test.ts --no-file-parallelism`
Expected: PASS (6 tests total).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiTools.ts apps/api/src/services/aiTools.helperScope.test.ts
git commit -m "feat(ai-tools): defense-in-depth helper device lock in verifyDeviceAccess"
```

---

### Task 4: Set `helperDeviceId` in the Helper synthetic auth

**Files:**
- Modify: `apps/api/src/routes/helper/index.ts` (synthetic `AuthContext`, lines 135-159)

- [ ] **Step 1: Add the field to the synthetic context**

In `apps/api/src/routes/helper/index.ts`, in the `syntheticAuth` object literal (after `canAccessOrg: (orgId) => orgId === device.orgId,`, around line 158), add:

```ts
    helperDeviceId: device.id,
```

- [ ] **Step 2: Verify it compiles**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit 2>&1 | grep -E "routes/helper/index" || echo "helper/index.ts clean"`
Expected: `helper/index.ts clean`.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/helper/index.ts
git commit -m "feat(helper): set helperDeviceId on the synthetic auth context"
```

---

### Task 5: Remove the Helper self-approve endpoint

**Files:**
- Modify: `apps/api/src/routes/helper/index.ts` (delete lines 637-690 — the `POST /chat/sessions/:id/approve/:executionId` block and its comment banner)
- Test: `apps/api/src/routes/helper/helperApprove.removed.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/helper/helperApprove.removed.test.ts`. It mounts the real `helperRoutes`, mocks the device lookup so `helperAuth` passes, and asserts the approve path now 404s:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const deviceRow = {
  id: 'dev-1', agentId: 'agent-1', orgId: 'org-1', siteId: 'site-1',
  hostname: 'host', osType: 'windows', osVersion: '11', agentVersion: '1.0.0',
  helperTokenHash: 'hash', previousHelperTokenHash: null,
  previousHelperTokenExpiresAt: null, status: 'online', partnerId: 'p-1',
};

// helperAuth hashes the bearer and looks the device up; make any lookup return our row.
vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ innerJoin: () => ({ where: () => ({ limit: async () => [deviceRow] }) }) }) }) },
  withSystemDbAccessContext: async (fn: () => unknown) => fn(),
  withDbAccessContext: async (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock('../../middleware/agentAuth', () => ({
  matchAgentTokenHash: () => ({ matched: true, usedPrevious: false }),
}));

import { helperRoutes } from './index';

beforeEach(() => vi.clearAllMocks());

describe('Helper self-approve endpoint removal (finding A)', () => {
  it('POST /chat/sessions/:id/approve/:executionId no longer exists (404)', async () => {
    const res = await helperRoutes.request('/chat/sessions/s-1/approve/e-1', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    });
    expect(res.status).toBe(404);
  });
});
```

> Note: if the existing test harness for `helper/index.ts` mocks the db differently, follow that file's pattern instead — the assertion (404 on the approve path with an authenticated helper) is what matters. Use the `breeze-testing` skill's Drizzle mock guidance.

- [ ] **Step 2: Run to verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/helper/helperApprove.removed.test.ts --no-file-parallelism`
Expected: FAIL — the route still exists, so the response is 200/404-from-handler, not a routing 404 (the approve handler returns 404 only when the session/execution is missing; with mocked db it would 409/200). The test expecting a routing 404 fails while the route is present.

- [ ] **Step 3: Delete the endpoint**

In `apps/api/src/routes/helper/index.ts`, delete the entire block from the comment banner `// POST /chat/sessions/:id/approve/:executionId — Approve or reject tool` through the closing `);` of that `helperRoutes.post(...)` (lines ~637-690). Leave the `/chat/sessions/:id/flag` block that follows intact.

- [ ] **Step 4: Run to verify it passes**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/helper/helperApprove.removed.test.ts --no-file-parallelism`
Expected: PASS (route gone → 404).

- [ ] **Step 5: Verify `approveToolSchema` import is still used or removed**

Run: `grep -n "approveToolSchema" apps/api/src/routes/helper/index.ts`
If there are no remaining references, remove `approveToolSchema` from the import on line 17 to keep the file clean. Re-run tsc filter: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit 2>&1 | grep -E "routes/helper/index" || echo "clean"`.
Expected: `clean`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/helper/index.ts apps/api/src/routes/helper/helperApprove.removed.test.ts
git commit -m "fix(helper): remove self-approvable tool-approval endpoint (finding A)"
```

---

### Task 6: Read-only single-device Helper default

**Files:**
- Modify: `apps/api/src/routes/helper/index.ts` (line 34: `DEFAULT_PERMISSION_LEVEL`)
- Modify: `apps/api/src/services/helperToolFilter.ts` (the `basic` array, lines 13-34)
- Test: `apps/api/src/services/helperToolFilter.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/helperToolFilter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { getHelperAllowedTools } from './helperToolFilter';
import { HELPER_TOOL_SCOPING } from './aiTools';

const MUTATING = [
  'manage_alerts', 'manage_services', 'disk_cleanup', 'file_operations',
  'execute_command', 'computer_control', 's1_isolate_device',
];
const ORG_WIDE = [
  'query_devices', 'get_fleet_health', 'get_s1_threats', 'get_log_trends',
  'detect_log_correlations', 'query_audit_log', 'query_change_log',
];

describe('helper basic tool set (finding A, Phase 0)', () => {
  it('basic set is exactly the device-scoped allowlist keys', () => {
    expect([...getHelperAllowedTools('basic')].sort())
      .toEqual(Object.keys(HELPER_TOOL_SCOPING).sort());
  });

  it('basic set contains no mutating tools', () => {
    const basic = getHelperAllowedTools('basic');
    for (const t of MUTATING) expect(basic).not.toContain(t);
  });

  it('basic set contains no org-wide enumeration tools', () => {
    const basic = getHelperAllowedTools('basic');
    for (const t of ORG_WIDE) expect(basic).not.toContain(t);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/helperToolFilter.test.ts --no-file-parallelism`
Expected: FAIL — the current `basic` set includes `query_devices`, `get_fleet_health`, `get_s1_threats`, `query_audit_log`, etc., so it does not equal the scoping keys.

- [ ] **Step 3: Revise the `basic` set**

In `apps/api/src/services/helperToolFilter.ts`, replace the `basic` array (lines 13-34) with exactly the device-scoped allowlist (the `HELPER_TOOL_SCOPING` keys):

```ts
  basic: [
    'get_device_details',
    'analyze_metrics',
    'analyze_disk_usage',
    'get_cis_device_report',
    'get_s1_status',
    'get_security_posture',
    'take_screenshot',
    'analyze_screen',
    'search_logs',
  ],
```

Leave `standard` and `extended` unchanged (their non-scoped tools are denied at runtime by the Task 2 gate; full capability returns under PAM governance in Phase 1).

- [ ] **Step 4: Change the default level**

In `apps/api/src/routes/helper/index.ts` line 34, change:

```ts
const DEFAULT_PERMISSION_LEVEL: HelperPermissionLevel = 'basic';
```

- [ ] **Step 5: Run to verify it passes**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/helperToolFilter.test.ts --no-file-parallelism`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/helperToolFilter.ts apps/api/src/routes/helper/index.ts apps/api/src/services/helperToolFilter.test.ts
git commit -m "fix(helper): read-only single-device default tool set (finding A)"
```

---

### Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run all touched suites together**

Run:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run \
  src/services/aiTools.helperScope.test.ts \
  src/services/helperToolFilter.test.ts \
  src/routes/helper/helperApprove.removed.test.ts \
  src/services/aiTools \
  --no-file-parallelism
```
Expected: all PASS. (`src/services/aiTools` also runs existing aiTools tests — the executeTool change must not regress them.)

- [ ] **Step 2: Run existing helper-route tests (regression)**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/helper --no-file-parallelism`
Expected: PASS. If a pre-existing helper test referenced the deleted approve endpoint, update it to assert removal (do not re-add the endpoint).

- [ ] **Step 3: Typecheck**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit 2>&1 | grep -E "aiTools|helper|middleware/auth" || echo "NONE — changed files clean"`
Expected: `NONE — changed files clean` (ignore only the known pre-existing `agents.test.ts`/`apiKeyAuth.test.ts` errors).

- [ ] **Step 4: Push and open PR**

```bash
git push -u origin fix/helper-phase0-device-scope
gh pr create --repo LanternOps/breeze --base main --head fix/helper-phase0-device-scope \
  --title "fix(helper): Phase 0 device-scope + approval hardening (finding A, HIGH)" \
  --body "Closes the local-user→org-wide-RMM escalation (security finding A). Central executeTool device-scope gate keyed on AuthContext.helperDeviceId forces every Helper tool onto its own device and denies org-wide tools; verifyDeviceAccess defense-in-depth lock; self-approve endpoint removed (approvals only via the authenticated /ai path); Helper default is a curated single-device read-only tool set. Phase 1 (PAM governance of mutating tools) tracked separately. Spec: docs/superpowers/specs/2026-06-10-helper-privileged-action-pam-governance-design.md"
```

---

## Follow-up (NOT in this plan)

Phase 1 — PAM integration (depends on PR #1183): model Helper actions as
`elevation_requests(flow_type='ai_tool_action')` with an `execution_id` link, decide via an
extended `pamRuleEngine`, approve via `POST /pam/elevation-requests/:id/respond`, bridge the
decision back to `ai_tool_executions.status`, manage policy via `pam_rules` + the `/pam` admin
UI, and re-enable mutating Helper tools under that governance. See the spec's Phase 1 section.
