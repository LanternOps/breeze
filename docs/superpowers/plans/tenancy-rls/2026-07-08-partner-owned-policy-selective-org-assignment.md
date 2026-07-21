# Partner-owned Config Policy — Selective Org Assignment (Library Model) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a partner-owned configuration policy act as a reusable library — created empty, then assigned to a selectable subset of organizations (and lower levels) instead of the current all-orgs-or-nothing.

**Architecture:** The resolver already resolves partner-owned policies that carry `organization`-level assignments; only a write-side guard (`validateAssignmentTarget`) blocks creating them, an auto-seed forces new partner policies to all-orgs, and the UI hides the picker. This plan relaxes the validator (with an in-partner target check), adds a route auth gate, removes the create-time auto-seed, relabels the create option, and adds an "Organizations" multi-select panel. No schema change, no migration.

**Tech Stack:** Hono + TypeScript API, Drizzle ORM, Vitest (unit + integration), React + Tailwind web, Zustand (`useOrgStore`).

**Spec:** `docs/superpowers/specs/tenancy-rls/2026-07-07-partner-owned-policy-selective-org-assignment-design.md` · **Issue:** #2280

## Global Constraints

- Repo: `LanternOps/breeze`. Work on branch `ToddHebebrand/config-policy-epic` (current).
- Tenant isolation: `config_policy_assignments` RLS is the real backstop; app-layer checks are defense-in-depth. Never weaken RLS.
- Partner-wide write capability gate is `canManagePartnerWidePolicies(auth)` — single source of truth in `apps/api/src/services/partnerWideAccess.ts`. Do not reimplement it.
- Partner axis is flat — never traverse a partner tree. `organizations.partner_id` is the join column.
- Web mutations go through `fetchWithAuth` + surface errors (existing AssignmentsTab pattern); reuse it.
- Commit after each task. Do not merge or close the issue.
- Run API tests single-fork where noted (integration DB on `:5433`).

---

### Task 1: Relax `validateAssignmentTarget` for partner-owned lower-level targets

**Files:**
- Modify: `apps/api/src/services/configurationPolicy.ts:1167-1257` (the `validateAssignmentTarget` function; partner-owned branch at `:1177-1185`)
- Test: `apps/api/src/services/configurationPolicy.validateAssignment.test.ts`

**Interfaces:**
- Consumes: nothing new. Uses already-imported `organizations`, `sites`, `deviceGroups`, `devices` tables and `and`, `eq` from drizzle (all already imported in this file).
- Produces: `validateAssignmentTarget(policyOwner: { orgId: string | null; partnerId: string | null }, level: ConfigAssignmentLevel, targetId: string): Promise<{ valid: boolean; error?: string }>` — signature unchanged; partner-owned policies now return `{ valid: true }` for `organization`/`site`/`device_group`/`device` when the target's owning org has `partner_id === policyOwner.partnerId`.

- [ ] **Step 1: Update the existing unit tests to the new contract**

In `configurationPolicy.validateAssignment.test.ts`, the current test *"rejects a partner-owned policy assigned below the Partner level"* (`:34-43`) asserts the old behavior. Replace it and add coverage. First add a chainable-select mock helper at the top of the file (after the existing `selectMock` hoist):

```typescript
// Build a drizzle-style select chain that resolves to `rows`. Covers both the
// no-join org lookup and the innerJoin site/group/device lookups — every branch
// ends in `.limit(1)` returning an array.
function mockSelectResolving(rows: unknown[]) {
  const chain: any = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  selectMock.mockReturnValue(chain);
}
```

Replace the `:34-43` test with:

```typescript
it('accepts a partner-owned policy assigned to an in-partner organization', async () => {
  mockSelectResolving([{ id: ORG_ID }]);
  const result = await validateAssignmentTarget(
    { orgId: null, partnerId: PARTNER_ID },
    'organization',
    ORG_ID
  );
  expect(result.valid).toBe(true);
  expect(selectMock).toHaveBeenCalled();
});

it('rejects a partner-owned policy assigned to an out-of-partner organization', async () => {
  mockSelectResolving([]); // org exists but not under this partner → no row
  const result = await validateAssignmentTarget(
    { orgId: null, partnerId: PARTNER_ID },
    'organization',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  );
  expect(result.valid).toBe(false);
  expect(result.error).toMatch(/not in this partner/i);
});

it('accepts a partner-owned policy assigned to an in-partner device', async () => {
  mockSelectResolving([{ id: '33333333-3333-3333-3333-333333333333' }]);
  const result = await validateAssignmentTarget(
    { orgId: null, partnerId: PARTNER_ID },
    'device',
    '33333333-3333-3333-3333-333333333333'
  );
  expect(result.valid).toBe(true);
});
```

Keep the three unchanged tests (org-owned-at-partner footgun, partner-owned targeting own partner, partner-owned targeting a different partner) — they still pass and guard the pure-early-return branches.

- [ ] **Step 2: Run the tests to verify the two new positive/negative cases fail**

Run: `pnpm --filter @breeze/api test -- configurationPolicy.validateAssignment`
Expected: FAIL — "accepts a partner-owned policy assigned to an in-partner organization" fails because the current code returns `{ valid: false, error: 'Partner-wide policies can only be assigned at the Partner level' }`.

- [ ] **Step 3: Rewrite the partner-owned branch in `validateAssignmentTarget`**

Replace the current partner-owned block (`configurationPolicy.ts:1174-1185`):

```typescript
  // Partner-owned policies (#1724) span all of the partner's orgs and may only
  // carry a partner-level assignment targeting their own partner. Org/site/
  // group/device assignments are nonsensical for a policy with no owning org.
  if (policyOwner.partnerId) {
    if (level !== 'partner') {
      return { valid: false, error: 'Partner-wide policies can only be assigned at the Partner level' };
    }
    if (targetId !== policyOwner.partnerId) {
      return { valid: false, error: 'A partner-wide policy can only target its own partner' };
    }
    return { valid: true };
  }
```

with:

```typescript
  // Partner-owned policies (#1724, #2280) are reusable libraries: a partner-level
  // assignment applies them to ALL orgs, and org/site/group/device assignments
  // apply them to a chosen subset. Every non-partner target must resolve to an org
  // owned by THIS partner (organizations.partner_id) — cross-partner targets are
  // rejected here (defense-in-depth; RLS is the real backstop).
  if (policyOwner.partnerId) {
    const partnerId = policyOwner.partnerId;
    switch (level) {
      case 'partner':
        return targetId === partnerId
          ? { valid: true }
          : { valid: false, error: 'A partner-wide policy can only target its own partner' };

      case 'organization': {
        const [org] = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(and(eq(organizations.id, targetId), eq(organizations.partnerId, partnerId)))
          .limit(1);
        return org
          ? { valid: true }
          : { valid: false, error: 'Target organization is not in this partner' };
      }

      case 'site': {
        const [site] = await db
          .select({ id: sites.id })
          .from(sites)
          .innerJoin(organizations, eq(sites.orgId, organizations.id))
          .where(and(eq(sites.id, targetId), eq(organizations.partnerId, partnerId)))
          .limit(1);
        return site
          ? { valid: true }
          : { valid: false, error: 'Target site is not in this partner' };
      }

      case 'device_group': {
        const [group] = await db
          .select({ id: deviceGroups.id })
          .from(deviceGroups)
          .innerJoin(organizations, eq(deviceGroups.orgId, organizations.id))
          .where(and(eq(deviceGroups.id, targetId), eq(organizations.partnerId, partnerId)))
          .limit(1);
        return group
          ? { valid: true }
          : { valid: false, error: 'Target device group is not in this partner' };
      }

      case 'device': {
        const [device] = await db
          .select({ id: devices.id })
          .from(devices)
          .innerJoin(organizations, eq(devices.orgId, organizations.id))
          .where(and(eq(devices.id, targetId), eq(organizations.partnerId, partnerId)))
          .limit(1);
        return device
          ? { valid: true }
          : { valid: false, error: 'Target device is not in this partner' };
      }

      default:
        return { valid: false, error: 'Unsupported assignment target level' };
    }
  }
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `pnpm --filter @breeze/api test -- configurationPolicy.validateAssignment`
Expected: PASS (all 6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/configurationPolicy.ts apps/api/src/services/configurationPolicy.validateAssignment.test.ts
git commit -m "feat(config-policy): allow partner-owned policy assignment to in-partner org/site/group/device (#2280)"
```

---

### Task 2: Gate partner-owned assignment writes at every level

**Files:**
- Modify: `apps/api/src/routes/configurationPolicies/assignments.ts:54-134` (POST handler)
- Test: `apps/api/src/routes/configurationPolicies/assignments.test.ts`

**Interfaces:**
- Consumes: `canManagePartnerWidePolicies`, `PARTNER_WIDE_WRITE_DENIED_MESSAGE` (both already imported in this route), `getConfigPolicy` returning `{ orgId, partnerId, ... }`.
- Produces: POST `/:id/assignments` returns `403` for any assignment on a partner-owned policy (`policy.orgId === null`) when `!canManagePartnerWidePolicies(auth)`, regardless of level.

- [ ] **Step 1: Write the failing route test**

Add to `assignments.test.ts` (follow the existing `describe`/mock setup in that file — it already mocks `getConfigPolicy` and `validateAssignmentTarget`; check whether it mocks `canManagePartnerWidePolicies` and, if not, add it to the existing `vi.mock('../../services/configurationPolicy', ...)` factory as `canManagePartnerWidePolicies: canManagePartnerWideMock`, with `const { canManagePartnerWideMock } = vi.hoisted(() => ({ canManagePartnerWideMock: vi.fn() }))`):

```typescript
it('rejects an org-level assignment on a partner-owned policy without partner-wide access (403)', async () => {
  getConfigPolicyMock.mockResolvedValue({
    id: POLICY_ID, orgId: null, partnerId: PARTNER_ID, name: 'Library Policy',
  });
  canManagePartnerWideMock.mockReturnValue(false);
  validateAssignmentTargetMock.mockResolvedValue({ valid: true });

  const res = await app.request(`/${POLICY_ID}/assignments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ level: 'organization', targetId: ORG_ID, priority: 0 }),
  });

  expect(res.status).toBe(403);
});

it('allows an org-level assignment on a partner-owned policy with partner-wide access (201)', async () => {
  getConfigPolicyMock.mockResolvedValue({
    id: POLICY_ID, orgId: null, partnerId: PARTNER_ID, name: 'Library Policy',
  });
  canManagePartnerWideMock.mockReturnValue(true);
  validateAssignmentTargetMock.mockResolvedValue({ valid: true });
  assignPolicyMock.mockResolvedValue({ id: 'assign-1', level: 'organization', targetId: ORG_ID });

  const res = await app.request(`/${POLICY_ID}/assignments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ level: 'organization', targetId: ORG_ID, priority: 0 }),
  });

  expect(res.status).toBe(201);
});
```

Reuse the file's existing constants/mocks (`app`, `POLICY_ID`, `ORG_ID`, `PARTNER_ID`, `getConfigPolicyMock`, `assignPolicyMock`, `validateAssignmentTargetMock`); add any missing ones alongside the existing declarations. The auth mock must present a partner-scope user — copy the pattern from the existing POST tests in the same file.

- [ ] **Step 2: Run the test to verify the 403 case fails**

Run: `pnpm --filter @breeze/api test -- routes/configurationPolicies/assignments`
Expected: FAIL — "rejects an org-level assignment on a partner-owned policy without partner-wide access" returns 201, not 403, because the current gate only fires for `level === 'partner'`.

- [ ] **Step 3: Add the top-level guard and remove the now-redundant inner check**

In the POST handler, immediately after the 404 check (`assignments.ts:60`, right after `if (!policy) return ...404`), insert:

```typescript
    // Partner-owned policies (org_id NULL) are the partner library (#2280).
    // ANY assignment on one — at any level — pushes config into orgs the caller
    // may not fully control, so all writes require full partner org access, the
    // same capability that gates partner-wide create/update/delete. This
    // supersedes the per-level check that used to live only in the partner block.
    if (policy.orgId === null && !canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }
```

Then, in the existing `if (data.level === 'partner')` block, **remove** the now-redundant inner capability sub-check (`assignments.ts:78-87`, the comment plus `if (!canManagePartnerWidePolicies(auth)) { return c.json(... 403); }`). Keep the `targetId` derivation (`:70-77`) intact — that logic is still needed to pin the partner target server-side.

- [ ] **Step 4: Run the route tests to verify they pass**

Run: `pnpm --filter @breeze/api test -- routes/configurationPolicies/assignments`
Expected: PASS (new 403/201 tests plus all existing assignment tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/configurationPolicies/assignments.ts apps/api/src/routes/configurationPolicies/assignments.test.ts
git commit -m "feat(config-policy): require partner-wide access for any partner-owned policy assignment (#2280)"
```

---

### Task 3: Stop auto-seeding the partner-level assignment on create

**Files:**
- Modify: `apps/api/src/routes/configurationPolicies/crud.ts:82-104` (partner-owned create branch)
- Test: `apps/api/src/routes/configurationPolicies/crud.test.ts`

**Interfaces:**
- Consumes: `createConfigPolicy`, `writeRouteAudit` (unchanged).
- Produces: creating a partner-owned policy performs exactly one write (the policy insert) and **no** assignment insert; audit `details` no longer contains `autoAssignedPartnerWide`.

- [ ] **Step 1: Write / update the failing test**

In `crud.test.ts`, find the test covering partner-owned create (it currently asserts `assignPolicy` was called with `'partner'`). Replace that assertion with the empty-create contract:

```typescript
it('creates a partner-owned policy WITHOUT auto-assigning it to all orgs (#2280 library model)', async () => {
  canManagePartnerWideMock.mockReturnValue(true);
  createConfigPolicyMock.mockResolvedValue({ id: POLICY_ID, orgId: null, partnerId: PARTNER_ID, name: 'Lib' });

  const res = await app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Lib', ownerScope: 'partner' }),
  });

  expect(res.status).toBe(201);
  // Library policies start empty — no partner-level (or any) assignment seeded.
  expect(assignPolicyMock).not.toHaveBeenCalled();
});
```

Reuse the file's existing mocks/constants (`app`, `POLICY_ID`, `PARTNER_ID`, `createConfigPolicyMock`, `assignPolicyMock`, `canManagePartnerWideMock`, and the partner-scope auth mock). If the old test name still exists, delete it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @breeze/api test -- routes/configurationPolicies/crud`
Expected: FAIL — `assignPolicyMock` was called once (current code seeds the partner assignment at `crud.ts:95`).

- [ ] **Step 3: Remove the auto-seed**

In `crud.ts`, partner-owned branch, delete the seed and its comment (`:83-95`, the block from `// Seed the matching partner-level assignment ...` through `await assignPolicy(policy.id, 'partner', auth.partnerId, 0, auth.user.id);`). Update the audit `details` (`:102`) from:

```typescript
        details: { ownerScope: 'partner', partnerId: auth.partnerId, autoAssignedPartnerWide: true },
```

to:

```typescript
        // Library model (#2280): partner-owned policies are created empty and
        // applied via explicit assignments on the Organizations panel.
        details: { ownerScope: 'partner', partnerId: auth.partnerId },
```

Leave `const policy = await createConfigPolicy({ partnerId: auth.partnerId }, data, auth.user.id);` and the `return c.json(policy, 201);` intact. If `assignPolicy` is now unused in this file, remove it from the import at `crud.ts:16`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @breeze/api test -- routes/configurationPolicies/crud`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/configurationPolicies/crud.ts apps/api/src/routes/configurationPolicies/crud.test.ts
git commit -m "feat(config-policy): create partner-owned policies empty, no auto-seed (#2280)"
```

---

### Task 4: Relabel the create-form partner option

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/ConfigPolicyCreatePage.tsx:247-266`
- Test: `apps/web/src/components/configurationPolicies/ConfigPolicyCreatePage.test.tsx`

**Interfaces:**
- Consumes/Produces: no field change — the radio still sets `ownerScope: 'partner'`. Only visible copy changes.

- [ ] **Step 1: Write the failing test**

Add to `ConfigPolicyCreatePage.test.tsx` (match the file's existing render helper / partner-scope setup):

```typescript
it('labels the partner option as a reusable library, not "all organizations"', async () => {
  renderCreatePage({ scope: 'partner' }); // use the file's existing render helper
  expect(await screen.findByText(/Partner library/i)).toBeInTheDocument();
  expect(
    screen.getByText(/applies to no organizations until you assign it/i)
  ).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @breeze/web test -- ConfigPolicyCreatePage`
Expected: FAIL — text "Partner library" not found (current label is "All organizations (partner-wide)").

- [ ] **Step 3: Update the label and helper copy**

In `ConfigPolicyCreatePage.tsx`, change the partner radio label (`:253`) from:

```tsx
                  All organizations <span className="text-muted-foreground">(partner-wide)</span>
```

to:

```tsx
                  Partner library <span className="text-muted-foreground">(assign to organizations after creating)</span>
```

And replace the `{ownerScope === 'partner' && (...)}` helper block (`:285`+) body with:

```tsx
                  <p className="mt-2 text-sm text-muted-foreground">
                    Create a reusable policy owned by your partner. It applies to no
                    organizations until you assign it on the policy&apos;s Organizations tab.
                  </p>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @breeze/web test -- ConfigPolicyCreatePage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/configurationPolicies/ConfigPolicyCreatePage.tsx apps/web/src/components/configurationPolicies/ConfigPolicyCreatePage.test.tsx
git commit -m "feat(config-policy): relabel partner create option as reusable library (#2280)"
```

---

### Task 5: "Organizations" multi-select panel for partner-owned policies

**Files:**
- Create: `apps/web/src/components/configurationPolicies/OrganizationScopePanel.tsx`
- Create: `apps/web/src/components/configurationPolicies/OrganizationScopePanel.test.tsx`
- Modify: `apps/web/src/components/configurationPolicies/AssignmentsTab.tsx:478-523` (replace the `isPartnerOwned` branch body with `<OrganizationScopePanel .../>`)

**Interfaces:**
- Consumes: `useOrgStore((s) => s.organizations)` → `Organization[]` with `{ id: string; name: string }` (already loaded for the partner; same source the create page uses). `fetchWithAuth` for `GET/POST/DELETE /configuration-policies/:id/assignments`. `extractApiError` for messages.
- Produces: `OrganizationScopePanel({ policyId, partnerId }: { policyId: string; partnerId: string })` default export — renders the master "All orgs" toggle + org checklist, writing `partner`/`organization`-level assignments.

- [ ] **Step 1: Write the failing component test**

`OrganizationScopePanel.test.tsx`:

```typescript
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import OrganizationScopePanel from './OrganizationScopePanel';

const fetchWithAuthMock = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuthMock(...a) }));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (sel: (s: unknown) => unknown) =>
    sel({ organizations: [
      { id: 'org-acme', name: 'Acme Corp' },
      { id: 'org-contoso', name: 'Contoso Ltd' },
    ] }),
}));

const PARTNER_ID = '22222222-2222-2222-2222-222222222222';

function jsonRes(body: unknown, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
}

beforeEach(() => {
  fetchWithAuthMock.mockReset();
});

describe('OrganizationScopePanel', () => {
  it('checks orgs that already have an organization-level assignment', async () => {
    fetchWithAuthMock.mockReturnValueOnce(
      jsonRes({ data: [{ id: 'a1', level: 'organization', targetId: 'org-acme', priority: 0 }] })
    );
    render(<OrganizationScopePanel policyId="p1" partnerId={PARTNER_ID} />);
    const acme = await screen.findByRole('checkbox', { name: /Acme Corp/i });
    expect(acme).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Contoso Ltd/i })).not.toBeChecked();
  });

  it('POSTs an organization assignment when an org is checked', async () => {
    fetchWithAuthMock
      .mockReturnValueOnce(jsonRes({ data: [] }))                       // initial list
      .mockReturnValueOnce(jsonRes({ id: 'a2', level: 'organization', targetId: 'org-contoso' }, true, 201)) // POST
      .mockReturnValueOnce(jsonRes({ data: [{ id: 'a2', level: 'organization', targetId: 'org-contoso', priority: 0 }] })); // refetch
    render(<OrganizationScopePanel policyId="p1" partnerId={PARTNER_ID} />);
    const contoso = await screen.findByRole('checkbox', { name: /Contoso Ltd/i });
    fireEvent.click(contoso);
    await waitFor(() =>
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/configuration-policies/p1/assignments',
        expect.objectContaining({ method: 'POST' })
      )
    );
    const body = JSON.parse((fetchWithAuthMock.mock.calls[1][1] as RequestInit).body as string);
    expect(body).toMatchObject({ level: 'organization', targetId: 'org-contoso' });
  });

  it('POSTs a partner assignment (no targetId) when All orgs is toggled on', async () => {
    fetchWithAuthMock
      .mockReturnValueOnce(jsonRes({ data: [] }))
      .mockReturnValueOnce(jsonRes({ id: 'ap', level: 'partner', targetId: PARTNER_ID }, true, 201))
      .mockReturnValueOnce(jsonRes({ data: [{ id: 'ap', level: 'partner', targetId: PARTNER_ID, priority: 0 }] }));
    render(<OrganizationScopePanel policyId="p1" partnerId={PARTNER_ID} />);
    const allOrgs = await screen.findByRole('checkbox', { name: /All organizations/i });
    fireEvent.click(allOrgs);
    await waitFor(() => {
      const body = JSON.parse((fetchWithAuthMock.mock.calls[1][1] as RequestInit).body as string);
      expect(body.level).toBe('partner');
      expect(body).not.toHaveProperty('targetId');
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @breeze/web test -- OrganizationScopePanel`
Expected: FAIL — module `./OrganizationScopePanel` not found.

- [ ] **Step 3: Implement the panel**

Create `OrganizationScopePanel.tsx`:

```tsx
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Search } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { extractApiError } from '@/lib/apiError';

type Assignment = { id: string; level: string; targetId: string; priority: number };

type Props = { policyId: string; partnerId: string };

// Partner-owned policies (#2280) are a reusable library. "All organizations"
// (a single partner-level assignment) and a subset (N organization-level
// assignments) are mutually exclusive: turning on All orgs removes per-org
// rows; checking any org removes the partner row. Site/group/device precision
// lives in the advanced Assignments tab.
export default function OrganizationScopePanel({ policyId, partnerId }: Props) {
  const organizations = useOrgStore((s) => s.organizations);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null); // org id or '__all__'
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string>();

  const fetchAssignments = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithAuth(`/configuration-policies/${policyId}/assignments`);
      if (!res.ok) throw new Error(extractApiError(await res.json().catch(() => null), 'Failed to load assignments'));
      const data = await res.json();
      setAssignments(Array.isArray(data.data) ? data.data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [policyId]);

  useEffect(() => { fetchAssignments(); }, [fetchAssignments]);

  const partnerAssignment = assignments.find((a) => a.level === 'partner');
  const allOrgs = !!partnerAssignment;
  const orgAssignmentByOrgId = useMemo(() => {
    const m = new Map<string, Assignment>();
    assignments.filter((a) => a.level === 'organization').forEach((a) => m.set(a.targetId, a));
    return m;
  }, [assignments]);

  const post = (body: Record<string, unknown>) =>
    fetchWithAuth(`/configuration-policies/${policyId}/assignments`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  const del = (aid: string) =>
    fetchWithAuth(`/configuration-policies/${policyId}/assignments/${aid}`, { method: 'DELETE' });

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusyId(id);
    setError(undefined);
    try { await fn(); await fetchAssignments(); }
    catch (err) { setError(err instanceof Error ? err.message : 'An error occurred'); }
    finally { setBusyId(null); }
  };

  const toggleAllOrgs = () =>
    run('__all__', async () => {
      if (allOrgs) {
        if (partnerAssignment) {
          const r = await del(partnerAssignment.id);
          if (!r.ok) throw new Error(extractApiError(await r.json().catch(() => null), 'Failed to remove'));
        }
      } else {
        // Clear any per-org rows first, then apply partner-wide.
        for (const a of orgAssignmentByOrgId.values()) {
          const r = await del(a.id);
          if (!r.ok) throw new Error(extractApiError(await r.json().catch(() => null), 'Failed to remove'));
        }
        const r = await post({ level: 'partner', priority: 0 }); // server derives targetId (#1724)
        if (!r.ok) throw new Error(extractApiError(await r.json().catch(() => null), 'Failed to assign all orgs'));
      }
    });

  const toggleOrg = (orgId: string) =>
    run(orgId, async () => {
      const existing = orgAssignmentByOrgId.get(orgId);
      if (existing) {
        const r = await del(existing.id);
        if (!r.ok) throw new Error(extractApiError(await r.json().catch(() => null), 'Failed to remove'));
      } else {
        // Checking a specific org drops the all-orgs row so the two never coexist.
        if (partnerAssignment) {
          const r = await del(partnerAssignment.id);
          if (!r.ok) throw new Error(extractApiError(await r.json().catch(() => null), 'Failed to narrow'));
        }
        const r = await post({ level: 'organization', targetId: orgId, priority: 0 });
        if (!r.ok) throw new Error(extractApiError(await r.json().catch(() => null), 'Failed to assign org'));
      }
    });

  const filtered = organizations.filter((o) =>
    o.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
      )}
      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <h2 className="text-lg font-semibold">Organizations</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          This partner library policy applies only to the organizations you select.
        </p>

        <label className="mt-4 flex items-center gap-3 rounded-md border bg-muted/30 p-3">
          <input
            type="checkbox"
            aria-label="All organizations (partner-wide)"
            checked={allOrgs}
            disabled={busyId !== null}
            onChange={toggleAllOrgs}
          />
          <span className="text-sm font-medium">All organizations (partner-wide)</span>
        </label>

        <div className="mt-4 flex items-center rounded-md border px-3 py-2">
          <Search className="mr-2 h-4 w-4 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search organizations..."
            className="w-full bg-transparent text-sm outline-hidden placeholder:text-muted-foreground"
          />
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <div className="mt-3 max-h-80 divide-y overflow-y-auto rounded-md border">
            {filtered.map((org) => (
              <label key={org.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  aria-label={org.name}
                  checked={allOrgs || orgAssignmentByOrgId.has(org.id)}
                  disabled={allOrgs || busyId !== null}
                  onChange={() => toggleOrg(org.id)}
                />
                <span>{org.name}</span>
              </label>
            ))}
            {filtered.length === 0 && (
              <p className="px-3 py-4 text-sm text-muted-foreground">No organizations match your search.</p>
            )}
          </div>
        )}
        {allOrgs && (
          <p className="mt-2 text-xs text-muted-foreground">
            Applied to all organizations. Uncheck &ldquo;All organizations&rdquo; to pick a subset.
          </p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @breeze/web test -- OrganizationScopePanel`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Wire the panel into AssignmentsTab**

In `AssignmentsTab.tsx`, add the import at the top:

```tsx
import OrganizationScopePanel from './OrganizationScopePanel';
```

Replace the entire `if (isPartnerOwned) { return ( ... ); }` block (`:478-523`) with:

```tsx
  if (isPartnerOwned && partnerId) {
    return <OrganizationScopePanel policyId={policyId} partnerId={partnerId} />;
  }
```

The advanced site/group/device flow stays available: the generic org-owned form below is unchanged, and per Task 1 the API now accepts those levels for partner-owned policies too (a follow-up can surface them here; out of scope for this task). Remove any now-unused helpers/imports in AssignmentsTab that were only used by the deleted partner-owned block (e.g. if `Plus`/`filterFields`/`priorityField` become unused in that branch — verify with the TypeScript build in Step 6; the org-owned branch still uses them, so likely no removal needed).

- [ ] **Step 6: Run web build + AssignmentsTab tests**

Run: `pnpm --filter @breeze/web test -- AssignmentsTab && pnpm --filter @breeze/web exec tsc --noEmit`
Expected: PASS / no type errors. If `AssignmentsTab.test.tsx` asserted the old partner-owned copy ("applies to all organizations in your partner"), update those assertions to expect the `OrganizationScopePanel` (e.g. mock or assert the "Organizations" heading).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/configurationPolicies/OrganizationScopePanel.tsx apps/web/src/components/configurationPolicies/OrganizationScopePanel.test.tsx apps/web/src/components/configurationPolicies/AssignmentsTab.tsx apps/web/src/components/configurationPolicies/AssignmentsTab.test.tsx
git commit -m "feat(config-policy): Organizations multi-select panel for partner-owned policies (#2280)"
```

---

### Task 6: Integration coverage — subset resolution + cross-partner rejection

**Files:**
- Modify: `apps/api/src/__tests__/integration/configurationPolicyPartnerResolution.integration.test.ts` (add subset-resolution case)
- Modify: `apps/api/src/__tests__/integration/configurationPoliciesPartnerRls.integration.test.ts` (add cross-partner assignment forge case)

**Interfaces:**
- Consumes: the real-DB fixtures/helpers already used in those suites (partner, two orgs under it, a device per org, `withDbAccessContext`, the `breeze_app` forge helper). Reuse them — do not invent new fixtures.

- [ ] **Step 1: Add the subset-resolution test**

In `configurationPolicyPartnerResolution.integration.test.ts`, add (adapting names to the file's existing fixture helpers):

```typescript
it('partner-owned policy assigned to ONE org resolves only for that org (#2280)', async () => {
  // Fixture: partner P with org A + device dA, org B + device dB (reuse suite setup).
  const policy = await createPartnerOwnedPolicy(P, { name: 'Subset Lib' });
  await addFeatureLink(policy.id, { featureType: 'monitoring', inlineSettings: { watches: [] } });
  // Assign to org A only — no partner-level assignment.
  await assignPolicy(policy.id, 'organization', orgA.id, 0, adminUserId);

  const effA = await resolveEffectiveConfig(dA.id, systemAuth);
  const effB = await resolveEffectiveConfig(dB.id, systemAuth);

  expect(effA.features.monitoring?.sourcePolicyId).toBe(policy.id);
  expect(effB.features.monitoring).toBeUndefined(); // org B was never assigned
});
```

- [ ] **Step 2: Add the cross-partner forge test**

In `configurationPoliciesPartnerRls.integration.test.ts`, add:

```typescript
it('rejects a forged assignment of a partner-owned policy to an out-of-partner org (42501)', async () => {
  // policyP1 is partner-owned by partner P1; orgQ belongs to a DIFFERENT partner.
  await expect(
    forgeAsBreezeApp(() =>
      insertAssignment({ configPolicyId: policyP1.id, level: 'organization', targetId: orgQ.id })
    )
  ).rejects.toThrow(/row-level security|42501/i);
});
```

Use the suite's existing `forgeAsBreezeApp` / raw-insert helper and its cross-partner fixtures (`policyP1`, `orgQ`). If a helper name differs, match the file's actual helper.

- [ ] **Step 3: Run the integration suites (real DB on :5433, single fork)**

Run: `pnpm --filter @breeze/api test:integration -- configurationPolicyPartnerResolution configurationPoliciesPartnerRls`
Expected: PASS. (If the integration DB isn't up, start it per `apps/api` integration config; see `test_integration_config_run_mechanics`.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/configurationPolicyPartnerResolution.integration.test.ts apps/api/src/__tests__/integration/configurationPoliciesPartnerRls.integration.test.ts
git commit -m "test(config-policy): subset resolution + cross-partner assignment forge (#2280)"
```

---

### Task 7: Call-site sweep + full verification

**Files:** none created; this task confirms nothing else assumed `partner-owned ⇒ partner-level-only`.

- [ ] **Step 1: Sweep every assignment write / resolve path**

Run and read each hit:

```bash
grep -rn "validateAssignmentTarget\|assignPolicy\|level: 'partner'\|autoAssignedPartnerWide\|Partner-wide policies can only" apps/api/src
```

Confirm no remaining code (a) rejects lower-level assignments for partner-owned policies, (b) re-seeds a partner assignment on create, or (c) asserts old copy. Pay attention to `apps/api/src/services/aiToolsConfigPolicy.ts:221` and `:239` (the AI `assign_policy_to_target` path uses the same `validateAssignmentTarget`, so it is unblocked automatically — verify its comment/guards don't independently reject lower levels for partner-owned) and `apps/api/src/jobs/patchSchedulerWorker.ts:215` (a comment assuming partner-wide never carries a lower assignment — update the comment if now inaccurate; confirm the code path still behaves).

- [ ] **Step 2: Run the full API + web unit suites**

Run: `pnpm --filter @breeze/api test && pnpm --filter @breeze/web test`
Expected: PASS. Fix any test that encoded the old all-or-one behavior.

- [ ] **Step 3: Commit any sweep fixes**

```bash
git add -A
git commit -m "chore(config-policy): sweep call sites for partner-owned subset assignment (#2280)"
```

---

## Self-Review

**Spec coverage:**
- Layer 0 (create path) → Tasks 3 (API) + 4 (web label). ✓
- Layer 1 (validator relax + in-partner check) → Task 1. ✓
- Layer 1 authorization (route gate at all levels) → Task 2. ✓
- Layer 2 (API surface — no new endpoints) → reused in Tasks 2/5. ✓
- Layer 3 (Organizations panel, mutual exclusivity, advanced tab still reachable) → Task 5. ✓
- Layer 4 (RLS backstop) → Task 6 forge test. ✓
- Layer 5 (call-site sweep, AI tools, patch scheduler) → Task 7. ✓
- Testing matrix (validator unit, resolver, partner-RLS integration) → Tasks 1/6. ✓

**Placeholder scan:** No TBD/TODO. Every code step shows concrete code. Test steps note "match the file's existing helper" only for fixture-name adaptation, which is honest given real-DB suites; the assertions themselves are concrete.

**Type consistency:** `validateAssignmentTarget` signature unchanged across Tasks 1/2. `OrganizationScopePanel({ policyId, partnerId })` defined in Task 5 Step 3 and consumed identically in Step 5. Assignment shape `{ id, level, targetId, priority }` consistent between panel and API. `ownerScope: 'partner'` unchanged in Task 4.

**Scope:** Single feature, one PR. No decomposition needed.
