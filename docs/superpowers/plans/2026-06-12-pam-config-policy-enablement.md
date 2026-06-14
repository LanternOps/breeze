# PAM Config-Policy Enablement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `pam` feature type to the Config Policy system that controls whether the agent's Windows UAC interception (ETW elevation capture) is enabled per device, delivered via heartbeat — while rule authoring, approvals, and audit stay in the standalone `/pam` control plane.

**Architecture:** Pattern B (inline settings, no normalized table). A new `pam` config-policy feature link carries `{ uacInterceptionEnabled: boolean }`. The API resolves it through the standard closest-wins hierarchy (device > device_group > site > organization > partner) exactly like the existing `helper` feature, and ships the resolved flag in the heartbeat response as a top-level `uacInterceptionEnabled` field. The Go agent stores it in an atomic flag (default **ON**) and `etwlua` drops UAC events while disabled. **Default is ON**: today every Windows agent captures UAC prompts unconditionally, so a device with no `pam` feature link must keep capturing — this preserves production behavior on upgrade, and the flag is a `*bool` on the agent so an old server that doesn't send the field also resolves to ON.

**What this plan deliberately does NOT do:** PAM rules, the elevation request queue, and audit stay org/site-scoped in `/pam` (`pam_rules` table). Closest-wins override semantics are correct for an enable toggle but wrong for security rule chains (a device-level policy would silently shadow org baseline rules), so rules are not folded into config policies. See the design discussion summarized at the end of this doc.

**Tech Stack:** Hono + Drizzle (API), React/Astro (web), Go (agent), Vitest + Go `testing`.

**Environment note:** Prefix all `pnpm` / `npx` commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` (default node 23 breaks pnpm engine-strict). Go agent code lives in `agent/`, **not** `apps/agent/`.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `apps/api/migrations/2026-06-12-pam-feature-type.sql` | Create | Add `pam` to the `config_feature_type` Postgres enum |
| `apps/api/src/db/schema/configurationPolicies.ts` | Modify (line 43) | Add `'pam'` to `configFeatureTypeEnum` |
| `apps/api/src/services/configurationPolicy.ts` | Modify (line 40) | Add `'pam'` to `ConfigFeatureType` union |
| `packages/shared/src/validators/index.ts` | Modify (line 435) | Add `'pam'` to `addFeatureLinkSchema.featureType` enum |
| `apps/api/src/services/aiToolsConfigPolicy.ts` | Modify (~lines 555-570) | Add `'pam'` to `manage_policy_feature_link` enum + document its settings shape |
| `apps/api/src/routes/agents/pamSettings.ts` | Create | Pure `PamSettings` type, `PAM_DEFAULTS`, `parsePamSettings()` (dependency-free, unit-testable) |
| `apps/api/src/routes/agents/pamSettings.test.ts` | Create | Unit tests for `parsePamSettings` |
| `apps/api/src/routes/agents/helpers.ts` | Modify (append after line 2213) | `resolveDevicePamSettings()` (hierarchy query) + `buildPamConfigUpdate()` (Redis-cached) |
| `apps/api/src/routes/agents/heartbeat.ts` | Modify (~lines 22, 594, 636) | Resolve pam config, add `uacInterceptionEnabled` to heartbeat response |
| `apps/api/src/routes/agents/heartbeat.test.ts` | Modify (~line 96 + new test) | Mock `buildPamConfigUpdate`, assert response field |
| `apps/web/src/components/configurationPolicies/featureTabs/types.ts` | Modify (lines 1, 42) | Add `'pam'` to `FeatureType` union + `FEATURE_META` |
| `apps/web/src/components/configurationPolicies/featureTabs/PamTab.tsx` | Create | Feature tab: enable toggle + link out to `/pam` console |
| `apps/web/src/components/configurationPolicies/featureTabs/PamTab.test.tsx` | Create | Tab render + save payload tests |
| `apps/web/src/components/configurationPolicies/ConfigPolicyDetailPage.tsx` | Modify (lines ~44, 65-83, 296) | Wire PamTab into tabs/icons/render switch |
| `agent/internal/heartbeat/heartbeat.go` | Modify (~lines 98, 201, 2343, +new funcs) | `UacInterceptionEnabled *bool` response field, atomic flag, handler, getter |
| `agent/internal/heartbeat/uac_interception_test.go` | Create | Table-driven test for the handler |
| `agent/internal/etwlua/etwlua.go` | Modify (lines 128-130, 187-213, 217+) | Extend `HeartbeatPoster` interface, gate `handleEvent` + ticker drain |
| `agent/internal/etwlua/etwlua_test.go` | Modify | Extend `fakeHB`, add gating test |

---

### Task 1: API feature-type plumbing (enum, validator, AI tool)

**Files:**
- Create: `apps/api/migrations/2026-06-12-pam-feature-type.sql`
- Modify: `apps/api/src/db/schema/configurationPolicies.ts:43`
- Modify: `apps/api/src/services/configurationPolicy.ts:40`
- Modify: `packages/shared/src/validators/index.ts:435`
- Modify: `apps/api/src/services/aiToolsConfigPolicy.ts:555-570`

- [ ] **Step 1: Create the migration**

Write `apps/api/migrations/2026-06-12-pam-feature-type.sql` (exact content, mirroring `2026-04-04-remote-access-feature-type.sql` — idempotent, no inner BEGIN/COMMIT):

```sql
ALTER TYPE "config_feature_type" ADD VALUE IF NOT EXISTS 'pam';
```

- [ ] **Step 2: Add `'pam'` to the Drizzle enum**

In `apps/api/src/db/schema/configurationPolicies.ts`, the enum currently ends:

```typescript
export const configFeatureTypeEnum = pgEnum('config_feature_type', [
  'patch',
  'alert_rule',
  'backup',
  'security',
  'monitoring',
  'maintenance',
  'compliance',
  'automation',
  'event_log',
  'software_policy',
  'sensitive_data',
  'peripheral_control',
  'warranty',
  'helper',
  'remote_access',
]);
```

Add `'pam',` after `'remote_access',` (before the closing `]`).

- [ ] **Step 3: Add `'pam'` to the service union**

In `apps/api/src/services/configurationPolicy.ts:40`, append `| 'pam'` to the union:

```typescript
type ConfigFeatureType = 'patch' | 'alert_rule' | 'backup' | 'security' | 'monitoring' | 'maintenance' | 'compliance' | 'automation' | 'event_log' | 'software_policy' | 'sensitive_data' | 'peripheral_control' | 'warranty' | 'helper' | 'remote_access' | 'pam';
```

- [ ] **Step 4: Add `'pam'` to the shared Zod validator**

In `packages/shared/src/validators/index.ts:435`, append `'pam'` to the enum array:

```typescript
  featureType: z.enum(['patch', 'alert_rule', 'backup', 'security', 'monitoring', 'maintenance', 'compliance', 'automation', 'event_log', 'software_policy', 'sensitive_data', 'peripheral_control', 'warranty', 'helper', 'remote_access', 'pam']),
```

- [ ] **Step 5: Add `'pam'` to the AI tool**

In `apps/api/src/services/aiToolsConfigPolicy.ts`, the `manage_policy_feature_link` tool's `featureType` enum (lines 565-570) currently ends with `'warranty', 'helper',`. Append `'remote_access', 'pam',` **only if** `'remote_access'` is also missing (it was absent at last read — add both so the tool catches up with the schema); otherwise just add `'pam',`:

```typescript
            enum: [
              'patch', 'alert_rule', 'backup', 'security', 'monitoring',
              'maintenance', 'compliance', 'automation', 'event_log',
              'software_policy', 'sensitive_data', 'peripheral_control',
              'warranty', 'helper', 'remote_access', 'pam',
            ],
```

In the same tool's `description` string (the block above line 557 that documents per-feature inline settings shapes — find the `- helper:` bullet), add this line after the helper bullet:

```
- pam: inlineSettings {uacInterceptionEnabled: boolean} — Windows UAC elevation prompt capture (default true when no policy assigns it). PAM rules/approvals are managed separately in the /pam console, not via config policies.
```

- [ ] **Step 6: Verify drift + type-check**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
```

Expected: no drift; tsc shows only the pre-existing errors in `agents.test.ts` and `apiKeyAuth.test.ts` (known baseline — anything else is yours).

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-06-12-pam-feature-type.sql apps/api/src/db/schema/configurationPolicies.ts apps/api/src/services/configurationPolicy.ts packages/shared/src/validators/index.ts apps/api/src/services/aiToolsConfigPolicy.ts
git commit -m "feat(pam): add 'pam' config-policy feature type (enum, validator, AI tool)"
```

---

### Task 2: Pure settings parser (`pamSettings.ts`)

**Files:**
- Create: `apps/api/src/routes/agents/pamSettings.ts`
- Test: `apps/api/src/routes/agents/pamSettings.test.ts`

This is a dependency-free module so it can be unit-tested without the heavy Drizzle/module mocks that `helpers.ts` requires.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/agents/pamSettings.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { PAM_DEFAULTS, parsePamSettings } from './pamSettings';

describe('parsePamSettings', () => {
  it('defaults to interception enabled', () => {
    expect(PAM_DEFAULTS.uacInterceptionEnabled).toBe(true);
  });

  it('returns defaults for null/undefined/non-object input', () => {
    expect(parsePamSettings(null)).toEqual(PAM_DEFAULTS);
    expect(parsePamSettings(undefined)).toEqual(PAM_DEFAULTS);
    expect(parsePamSettings('nope')).toEqual(PAM_DEFAULTS);
    expect(parsePamSettings(42)).toEqual(PAM_DEFAULTS);
  });

  it('honors an explicit false', () => {
    expect(parsePamSettings({ uacInterceptionEnabled: false })).toEqual({
      uacInterceptionEnabled: false,
    });
  });

  it('honors an explicit true', () => {
    expect(parsePamSettings({ uacInterceptionEnabled: true })).toEqual({
      uacInterceptionEnabled: true,
    });
  });

  it('falls back to default when the key is missing or mistyped', () => {
    expect(parsePamSettings({})).toEqual(PAM_DEFAULTS);
    expect(parsePamSettings({ uacInterceptionEnabled: 'false' })).toEqual(PAM_DEFAULTS);
    expect(parsePamSettings({ uacInterceptionEnabled: 0 })).toEqual(PAM_DEFAULTS);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/agents/pamSettings.test.ts
```

Expected: FAIL — `Cannot find module './pamSettings'`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/routes/agents/pamSettings.ts`:

```typescript
/**
 * PAM config-policy feature ('pam') — inline settings shape.
 *
 * Controls whether the agent's ETW UAC interception posts elevation events.
 * Rule authoring / approvals / audit are NOT configured here — they live in
 * the standalone /pam control plane (pam_rules, elevation_requests).
 */
export interface PamSettings {
  uacInterceptionEnabled: boolean;
}

/**
 * Default ON: UAC capture has always been unconditional on Windows agents.
 * A device with no 'pam' feature link anywhere in its hierarchy must keep
 * capturing, so upgrades are behavior-preserving. Admins opt OUT via policy.
 */
export const PAM_DEFAULTS: PamSettings = {
  uacInterceptionEnabled: true,
};

export function parsePamSettings(inlineSettings: unknown): PamSettings {
  if (!inlineSettings || typeof inlineSettings !== 'object') return PAM_DEFAULTS;
  const s = inlineSettings as Record<string, unknown>;
  return {
    uacInterceptionEnabled:
      typeof s.uacInterceptionEnabled === 'boolean'
        ? s.uacInterceptionEnabled
        : PAM_DEFAULTS.uacInterceptionEnabled,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/agents/pamSettings.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/agents/pamSettings.ts apps/api/src/routes/agents/pamSettings.test.ts
git commit -m "feat(pam): pure PamSettings parser with default-on semantics"
```

---

### Task 3: Hierarchy resolver + heartbeat delivery

**Files:**
- Modify: `apps/api/src/routes/agents/helpers.ts` (append after `buildHelperConfigUpdate`, line 2213)
- Modify: `apps/api/src/routes/agents/heartbeat.ts` (import block ~line 22; after line 594; response object line 636)
- Test: `apps/api/src/routes/agents/heartbeat.test.ts`

- [ ] **Step 1: Add the resolver + cached builder to `helpers.ts`**

Append at the end of `apps/api/src/routes/agents/helpers.ts` (after line 2213). All Drizzle imports (`devices`, `organizations`, `deviceGroupMemberships`, `configPolicyAssignments`, `configurationPolicies`, `configPolicyFeatureLinks`, `eq`, `and`, `or`, `inArray`) and `LEVEL_PRIORITY` / `getRedis` are already imported/defined in this file for the helper resolver — only add the `pamSettings` import at the top of the file:

```typescript
import { PAM_DEFAULTS, parsePamSettings, type PamSettings } from './pamSettings';
```

Then append:

```typescript
// ---------------------------------------------------------------------------
// PAM (config-policy feature 'pam') — UAC interception enablement
// ---------------------------------------------------------------------------

async function resolveDevicePamSettings(deviceId: string): Promise<PamSettings> {
  // 1. Load device
  const [device] = await db
    .select({ orgId: devices.orgId, siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) return PAM_DEFAULTS;

  // 2. Load org (for partnerId)
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, device.orgId))
    .limit(1);

  // 3. Load device group memberships
  const groupRows = await db
    .select({ groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships)
    .where(eq(deviceGroupMemberships.deviceId, deviceId));
  const groupIds = groupRows.map((r) => r.groupId);

  // 4. Build target match conditions
  const targetConditions = [
    and(eq(configPolicyAssignments.level, 'device'), eq(configPolicyAssignments.targetId, deviceId)),
    and(eq(configPolicyAssignments.level, 'site'), eq(configPolicyAssignments.targetId, device.siteId)),
    and(eq(configPolicyAssignments.level, 'organization'), eq(configPolicyAssignments.targetId, device.orgId)),
  ];
  if (groupIds.length > 0) {
    targetConditions.push(
      and(eq(configPolicyAssignments.level, 'device_group'), inArray(configPolicyAssignments.targetId, groupIds))!
    );
  }
  if (org?.partnerId) {
    targetConditions.push(
      and(eq(configPolicyAssignments.level, 'partner'), eq(configPolicyAssignments.targetId, org.partnerId))!
    );
  }

  // 5. Single query: assignments → active policies → pam feature link (pure JSONB)
  const rows = await db
    .select({
      level: configPolicyAssignments.level,
      assignmentPriority: configPolicyAssignments.priority,
      inlineSettings: configPolicyFeatureLinks.inlineSettings,
    })
    .from(configPolicyAssignments)
    .innerJoin(configurationPolicies, eq(configPolicyAssignments.configPolicyId, configurationPolicies.id))
    .innerJoin(configPolicyFeatureLinks, and(
      eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id),
      eq(configPolicyFeatureLinks.featureType, 'pam'),
    ))
    .where(and(
      eq(configurationPolicies.status, 'active'),
      eq(configurationPolicies.orgId, device.orgId),
      or(...targetConditions),
    ));

  if (rows.length === 0) return PAM_DEFAULTS;

  // 6. Sort by level priority DESC, then assignment priority ASC — first match wins
  rows.sort((a, b) => {
    const levelDiff = (LEVEL_PRIORITY[b.level] ?? 0) - (LEVEL_PRIORITY[a.level] ?? 0);
    if (levelDiff !== 0) return levelDiff;
    return a.assignmentPriority - b.assignmentPriority;
  });

  return parsePamSettings(rows[0]?.inlineSettings);
}

const PAM_CACHE_TTL_SECONDS = 120;

/**
 * Build PAM config update payload for heartbeat response.
 * Resolves the 'pam' feature link via the config policy hierarchy;
 * defaults to interception ENABLED when no policy assigns the feature.
 */
export async function buildPamConfigUpdate(deviceId: string): Promise<PamSettings> {
  const redis = getRedis();
  const cacheKey = `pam:settings:device:${deviceId}`;

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as PamSettings;
    } catch (cacheErr) {
      console.warn(`[pam] Redis cache read failed for device ${deviceId}:`, cacheErr);
    }
  }

  const settings = await resolveDevicePamSettings(deviceId);

  if (redis) {
    try {
      await redis.set(cacheKey, JSON.stringify(settings), 'EX', PAM_CACHE_TTL_SECONDS);
    } catch (cacheErr) {
      console.warn(`[pam] Redis cache write failed for device ${deviceId}:`, cacheErr);
    }
  }

  return settings;
}
```

- [ ] **Step 2: Write the failing heartbeat test**

In `apps/api/src/routes/agents/heartbeat.test.ts`, the `vi.mock('./helpers', ...)` block (lines 89-97) currently ends with `buildHelperConfigUpdate: vi.fn(() => undefined),`. Add one line so the block becomes:

```typescript
vi.mock('./helpers', () => ({
  maybeQueueThresholdFilesystemAnalysis: vi.fn(),
  buildPolicyProbeConfigUpdate: vi.fn(() => undefined),
  normalizeAgentArchitecture: vi.fn((s: string) => s),
  compareAgentVersions: vi.fn(() => 0),
  buildEventLogConfigUpdate: vi.fn(() => undefined),
  buildMonitoringConfigUpdate: vi.fn(() => undefined),
  buildHelperConfigUpdate: vi.fn(() => undefined),
  buildPamConfigUpdate: vi.fn(async () => ({ uacInterceptionEnabled: false })),
}));
```

Then add a new test. Locate the file's existing happy-path heartbeat test (one that does a successful `app.request(...)` POST and reads the JSON body — use the same `buildApp()` + request invocation and DB select-chain setup verbatim from that test; only the assertions below are new):

```typescript
it('includes uacInterceptionEnabled resolved from the pam config policy', async () => {
  // ...same arrange + request invocation as the existing happy-path heartbeat test...
  expect(res.status).toBe(200);
  const body = await res.json();
  // The ./helpers mock returns { uacInterceptionEnabled: false } — assert it
  // flows through to the top-level response field (not nested in configUpdate).
  expect(body.uacInterceptionEnabled).toBe(false);
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/agents/heartbeat.test.ts
```

Expected: the new test FAILS (`body.uacInterceptionEnabled` is `undefined`); all pre-existing tests still pass.

- [ ] **Step 4: Wire it into `heartbeat.ts`**

In `apps/api/src/routes/agents/heartbeat.ts`:

(a) Add `buildPamConfigUpdate` to the existing `./helpers` import block (around line 22, next to `buildHelperConfigUpdate`).

(b) After the `monitoringSettings` block (which ends at line 594), insert:

```typescript
  let pamSettings: { uacInterceptionEnabled: boolean } | null = null;
  try {
    pamSettings = await buildPamConfigUpdate(device.id);
  } catch (err) {
    console.error(`[agents] failed to build pam config update for ${agentId}:`, err);
  }
```

(c) In the `mainResponse` object (lines 622-638), add one field after `helperSettings`:

```typescript
      helperEnabled: helperSettings?.enabled ?? false,
      helperSettings: helperSettings ?? undefined,
      uacInterceptionEnabled: pamSettings?.uacInterceptionEnabled ?? true,
      manageRemoteManagement: manageRemoteManagement || undefined,
```

Note the `?? true` — if the resolver threw, fail OPEN (interception stays on), consistent with default-ON. Do **not** use `|| undefined` here: an explicit `false` must be serialized.

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/agents/heartbeat.test.ts src/routes/agents/pamSettings.test.ts
```

Expected: PASS. (Memory note: the full API suite has known parallel flakiness — verify via these affected files only; trust CI for the rest.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/agents/helpers.ts apps/api/src/routes/agents/heartbeat.ts apps/api/src/routes/agents/heartbeat.test.ts
git commit -m "feat(pam): resolve pam config policy per device and deliver uacInterceptionEnabled via heartbeat"
```

---

### Task 4: Web UI — PamTab feature tab

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/types.ts`
- Create: `apps/web/src/components/configurationPolicies/featureTabs/PamTab.tsx`
- Test: `apps/web/src/components/configurationPolicies/featureTabs/PamTab.test.tsx`
- Modify: `apps/web/src/components/configurationPolicies/ConfigPolicyDetailPage.tsx`

- [ ] **Step 1: Add `pam` to the frontend types**

In `featureTabs/types.ts` line 1, append `| 'pam'` to the `FeatureType` union:

```typescript
export type FeatureType = 'patch' | 'alert_rule' | 'backup' | 'security' | 'monitoring' | 'maintenance' | 'compliance' | 'automation' | 'event_log' | 'software_policy' | 'sensitive_data' | 'peripheral_control' | 'warranty' | 'helper' | 'remote_access' | 'pam';
```

In `FEATURE_META` (after the `remote_access` entry, line 41), add:

```typescript
  pam:         { label: 'Privileged Access', fetchUrl: null,              description: 'Windows UAC elevation prompt capture (PAM)' },
```

- [ ] **Step 2: Write the failing tab test**

Create `featureTabs/PamTab.test.tsx` (harness identical to `RemoteAccessTab.test.tsx`):

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PamTab from './PamTab';

// useFeatureLink wraps the save/remove API calls; stub it so we can assert the
// payload the tab submits without hitting the network.
const saveMock = vi.fn(async () => ({ id: 'link-1' }));
const removeMock = vi.fn(async () => true);

vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: saveMock,
    remove: removeMock,
    saving: false,
    error: null,
    clearError: vi.fn(),
  }),
}));

import type { FeatureTabProps } from './types';

const baseProps: FeatureTabProps = {
  policyId: 'policy-1',
  existingLink: undefined,
  linkedPolicyId: null,
  onLinkChanged: vi.fn(),
};

function inlineSettingsFromCall(call: unknown[]): Record<string, unknown> | undefined {
  for (const arg of call) {
    if (arg && typeof arg === 'object' && 'inlineSettings' in (arg as object)) {
      return (arg as { inlineSettings: Record<string, unknown> }).inlineSettings;
    }
  }
  return undefined;
}

describe('PamTab', () => {
  beforeEach(() => {
    saveMock.mockClear();
    removeMock.mockClear();
  });

  it('renders the UAC interception toggle, defaulted ON', () => {
    render(<PamTab {...baseProps} />);
    expect(screen.getByText('Capture Windows UAC elevation prompts')).toBeTruthy();
  });

  it('links rule management out to the /pam console', () => {
    render(<PamTab {...baseProps} />);
    const link = screen.getByRole('link', { name: /privileged access console/i }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/pam');
  });

  it('saves uacInterceptionEnabled=false after toggling off', async () => {
    render(<PamTab {...baseProps} />);

    const label = screen.getByText('Capture Windows UAC elevation prompts');
    const row = label.closest('div')?.parentElement as HTMLElement;
    const toggleButton = row.querySelector('button') as HTMLButtonElement;
    fireEvent.click(toggleButton);

    const saveButton = screen
      .getAllByRole('button')
      .find((b) => /save/i.test(b.textContent ?? '')) as HTMLButtonElement;
    expect(saveButton).toBeTruthy();
    fireEvent.click(saveButton);

    expect(saveMock).toHaveBeenCalled();
    const settings = inlineSettingsFromCall(saveMock.mock.calls[0]);
    expect(settings).toEqual({ uacInterceptionEnabled: false });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/configurationPolicies/featureTabs/PamTab.test.tsx
```

Expected: FAIL — `Cannot find module './PamTab'`.

- [ ] **Step 4: Create `PamTab.tsx`**

Create `featureTabs/PamTab.tsx` (skeleton mirrors `HelperTab.tsx` exactly — same inherit/override/revert plumbing):

```tsx
import { useState, useEffect } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { FeatureTabProps } from './types';
import { FEATURE_META } from './types';
import { useFeatureLink } from './useFeatureLink';
import FeatureTabShell from './FeatureTabShell';

type PamSettings = {
  uacInterceptionEnabled: boolean;
};

// Default ON — matches agent behavior when no policy assigns this feature.
const defaults: PamSettings = {
  uacInterceptionEnabled: true,
};

export default function PamTab({ policyId, existingLink, onLinkChanged, linkedPolicyId, parentLink }: FeatureTabProps) {
  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);
  const isInherited = !!parentLink && !existingLink;
  const effectiveLink = existingLink ?? parentLink;
  const [settings, setSettings] = useState<PamSettings>(() => ({
    ...defaults,
    ...(effectiveLink?.inlineSettings as Partial<PamSettings> | undefined),
  }));

  useEffect(() => {
    const link = existingLink ?? parentLink;
    if (link?.inlineSettings) {
      setSettings((prev) => ({ ...prev, ...(link.inlineSettings as Partial<PamSettings>) }));
    }
  }, [existingLink, parentLink]);

  const handleSave = async () => {
    clearError();
    const result = await save(existingLink?.id ?? null, {
      featureType: 'pam',
      featurePolicyId: linkedPolicyId,
      inlineSettings: { ...settings },
    });
    if (result) onLinkChanged(result, 'pam');
  };

  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, 'pam');
  };

  const handleOverride = async () => {
    clearError();
    const result = await save(null, {
      featureType: 'pam',
      featurePolicyId: linkedPolicyId,
      inlineSettings: { ...settings },
    });
    if (result) onLinkChanged(result, 'pam');
  };

  const handleRevert = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, 'pam');
  };

  const meta = FEATURE_META.pam;

  return (
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<ShieldCheck className="h-5 w-5" />}
      isConfigured={!!existingLink || isInherited}
      saving={saving}
      error={error}
      onSave={handleSave}
      onRemove={existingLink && !linkedPolicyId ? handleRemove : undefined}
      isInherited={isInherited}
      onOverride={isInherited ? handleOverride : undefined}
      onRevert={!isInherited && !!linkedPolicyId && !!existingLink ? handleRevert : undefined}
    >
      <div className="space-y-6">
        {/* UAC interception toggle */}
        <div className="flex items-center justify-between rounded-md border bg-background px-4 py-3">
          <div>
            <p className="text-sm font-medium">Capture Windows UAC elevation prompts</p>
            <p className="text-xs text-muted-foreground">
              The agent observes UAC consent prompts and records them as elevation requests for PAM review. Capture is on by default when no policy sets this.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setSettings((prev) => ({ ...prev, uacInterceptionEnabled: !prev.uacInterceptionEnabled }))}
            className={`relative inline-flex h-6 w-11 items-center rounded-full border transition ${settings.uacInterceptionEnabled ? 'bg-emerald-500/80' : 'bg-muted'}`}
          >
            <span className={`inline-block h-5 w-5 rounded-full bg-white transition ${settings.uacInterceptionEnabled ? 'translate-x-5' : 'translate-x-1'}`} />
          </button>
        </div>

        {/* Pointer to the PAM control plane */}
        <div className="rounded-md border bg-muted/40 px-4 py-3">
          <p className="text-sm font-medium">Approval rules live in the PAM console</p>
          <p className="mt-1 text-xs text-muted-foreground">
            This policy only controls whether devices capture elevation prompts. Verdicts (auto-approve, deny, require approval), the request queue, and audit history are managed in the{' '}
            <a href="/pam" className="underline underline-offset-2 hover:text-foreground">Privileged Access console</a>.
          </p>
        </div>
      </div>
    </FeatureTabShell>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/configurationPolicies/featureTabs/PamTab.test.tsx
```

Expected: PASS (3 tests).

- [ ] **Step 6: Wire into `ConfigPolicyDetailPage.tsx`**

Four edits:

(a) After the `RemoteAccessTab` import (line 44):
```typescript
import PamTab from './featureTabs/PamTab';
```

(b) Add `ShieldCheck` to the existing `lucide-react` import at the top of the file (it already imports `Monitor` and others — append `ShieldCheck` to that list).

(c) In `featureTabIcons` (lines 65-81), after the `remote_access` entry:
```typescript
  pam: <ShieldCheck className="h-4 w-4" />,
```

(d) In `FEATURE_TYPES` (line 83), append `'pam'`:
```typescript
const FEATURE_TYPES: FeatureType[] = ['patch', 'alert_rule', 'backup', 'monitoring', 'maintenance', 'compliance', 'automation', 'event_log', 'software_policy', 'sensitive_data', 'peripheral_control', 'warranty', 'helper', 'remote_access', 'pam'];
```

(e) In `renderFeatureTab` switch (line 296 area), after the `remote_access` case:
```typescript
      case 'pam': return <PamTab {...props} />;
```

- [ ] **Step 7: Type-check web + run the feature-tab tests**

```bash
cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/configurationPolicies/featureTabs/
```

Expected: clean tsc; all featureTabs tests PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/configurationPolicies/featureTabs/types.ts apps/web/src/components/configurationPolicies/featureTabs/PamTab.tsx apps/web/src/components/configurationPolicies/featureTabs/PamTab.test.tsx apps/web/src/components/configurationPolicies/ConfigPolicyDetailPage.tsx
git commit -m "feat(pam): Privileged Access feature tab in config policies (UAC capture toggle)"
```

---

### Task 5: Go agent — heartbeat flag

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go` (struct field ~line 98, atomic ~line 201, response handler ~line 2343, new funcs near `handleHelperEnabled` ~line 2360)
- Test: `agent/internal/heartbeat/uac_interception_test.go`

Design note: the response field is a `*bool` so three states decode distinctly — `nil` (old server, field absent) → enabled; `true` → enabled; `false` → disabled. The stored atomic is **inverted** (`uacInterceptionDisabled`) so the Go zero value means *enabled* — correct before the first heartbeat and with no constructor change needed.

- [ ] **Step 1: Write the failing test**

Create `agent/internal/heartbeat/uac_interception_test.go`:

```go
package heartbeat

import "testing"

func boolPtr(b bool) *bool { return &b }

func TestUACInterceptionFlag(t *testing.T) {
	tests := []struct {
		name        string
		sequence    []*bool // values passed to handleUACInterception in order
		wantEnabled bool
	}{
		{"default before any heartbeat", nil, true},
		{"nil from old server keeps default on", []*bool{nil}, true},
		{"explicit true stays on", []*bool{boolPtr(true)}, true},
		{"explicit false disables", []*bool{boolPtr(false)}, false},
		{"false then true re-enables", []*bool{boolPtr(false), boolPtr(true)}, true},
		{"false then nil re-enables (policy unassigned on old server)", []*bool{boolPtr(false), nil}, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := &Heartbeat{}
			for _, v := range tt.sequence {
				h.handleUACInterception(v)
			}
			if got := h.IsUACInterceptionEnabled(); got != tt.wantEnabled {
				t.Fatalf("IsUACInterceptionEnabled() = %v, want %v", got, tt.wantEnabled)
			}
		})
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd agent && go test -race ./internal/heartbeat/ -run TestUACInterceptionFlag
```

Expected: FAIL — `h.handleUACInterception undefined` (compile error).

- [ ] **Step 3: Implement in `heartbeat.go`**

(a) In `HeartbeatResponse` (line 92-103), after `HelperEnabled`:

```go
	HelperEnabled          bool                   `json:"helperEnabled,omitempty"`
	UacInterceptionEnabled *bool                  `json:"uacInterceptionEnabled,omitempty"`
```

(b) In the `Heartbeat` struct's atomic flag block (after `helperEnabled atomic.Bool`, line 201):

```go
	// uacInterceptionDisabled is set when the server's 'pam' config policy
	// turns UAC capture off for this device. Inverted so the zero value
	// (enabled) matches the default-ON contract before the first heartbeat
	// and against older servers that never send the field.
	uacInterceptionDisabled atomic.Bool
```

(c) In the response-processing function, directly after `h.handleHelperEnabled(response.HelperEnabled)` (line 2343):

```go
	h.handleUACInterception(response.UacInterceptionEnabled)
```

(d) New funcs after `handleHelperEnabled` (line 2370):

```go
// IsUACInterceptionEnabled reports whether etwlua should post UAC elevation
// events. Default true; only an explicit uacInterceptionEnabled=false from
// the server's resolved 'pam' config policy disables it.
func (h *Heartbeat) IsUACInterceptionEnabled() bool {
	return !h.uacInterceptionDisabled.Load()
}

// handleUACInterception updates the UAC interception flag from the heartbeat
// response and logs state transitions. nil (field absent — older server)
// means enabled.
func (h *Heartbeat) handleUACInterception(enabled *bool) {
	disabled := enabled != nil && !*enabled
	prev := h.uacInterceptionDisabled.Swap(disabled)
	if prev != disabled {
		if disabled {
			log.Info("UAC interception disabled by configuration policy")
		} else {
			log.Info("UAC interception enabled by configuration policy")
		}
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd agent && go test -race ./internal/heartbeat/ -run TestUACInterceptionFlag
```

Expected: PASS (6 subtests).

- [ ] **Step 5: Commit**

```bash
git add agent/internal/heartbeat/heartbeat.go agent/internal/heartbeat/uac_interception_test.go
git commit -m "feat(pam): agent honors uacInterceptionEnabled from heartbeat (default on, *bool for old servers)"
```

---

### Task 6: Go agent — gate etwlua on the flag

**Files:**
- Modify: `agent/internal/etwlua/etwlua.go` (`HeartbeatPoster` interface lines 128-130, `Start` ticker case ~line 203, `handleEvent` line 217)
- Test: `agent/internal/etwlua/etwlua_test.go` (extend `fakeHB` lines 16-43, add test)

Note: `fakeHB` is shared by `etwlua_test.go` and `queue_test.go` (same package), so extending it once covers both. `*heartbeat.Heartbeat` satisfies the extended interface via Task 5's `IsUACInterceptionEnabled()` — no change needed in `etwlua_start_windows.go`.

- [ ] **Step 1: Write the failing test**

In `agent/internal/etwlua/etwlua_test.go`, first extend `fakeHB` (the test won't compile until the interface change, which is fine — that IS the failing state). Add a field and method:

```go
// fakeHB records every event it's asked to post and lets tests inject a
// custom error to simulate API outages.
type fakeHB struct {
	mu       sync.Mutex
	received []Event
	failNext atomic.Int32 // number of next posts to fail
	failErr  error
	disabled atomic.Bool // simulates uacInterceptionEnabled=false from the server
}

func (f *fakeHB) IsUACInterceptionEnabled() bool {
	return !f.disabled.Load()
}
```

Then add the test:

```go
func TestHandleEventDroppedWhenInterceptionDisabled(t *testing.T) {
	hb := &fakeHB{}
	hb.disabled.Store(true)
	limiter := ipc.NewRateLimiter(1, dedupeWindow)

	ev := sampleEvent("alice", `C:\Windows\System32\mmc.exe`)
	handleEvent(ev, limiter, hb, nil)
	if got := len(hb.Received()); got != 0 {
		t.Fatalf("expected 0 posts while interception disabled, got %d", got)
	}

	// Re-enable: the same event must post — proving the disabled event was
	// dropped BEFORE the dedupe limiter consumed its slot.
	hb.disabled.Store(false)
	handleEvent(ev, limiter, hb, nil)
	if got := len(hb.Received()); got != 1 {
		t.Fatalf("expected 1 post after re-enable, got %d", got)
	}
}
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd agent && go test -race ./internal/etwlua/
```

Expected: FAIL — the new test fails (event posts even while disabled) since `handleEvent` doesn't check the flag yet. (If you extended `fakeHB` before touching the interface, everything still compiles — extra methods on a fake are fine.)

- [ ] **Step 3: Implement the gate**

In `agent/internal/etwlua/etwlua.go`:

(a) Extend the interface (lines 128-130):

```go
type HeartbeatPoster interface {
	SendElevationRequest(req Event) error
	// IsUACInterceptionEnabled reports the server-resolved 'pam' config
	// policy state. While false, handleEvent drops events entirely (no
	// post, no offline queue) and the periodic queue drain is paused.
	IsUACInterceptionEnabled() bool
}
```

(b) Gate `handleEvent` (line 217) — first statement, BEFORE the dedupe limiter so disabled events don't consume limiter slots:

```go
func handleEvent(ev Event, limiter *ipc.RateLimiter, hb HeartbeatPoster, q *Queue) {
	if !hb.IsUACInterceptionEnabled() {
		return
	}
	key := dedupeKey(ev)
	if !limiter.Allow(key) {
```

(c) Gate the periodic drain in `Start`'s ticker case (line 203-210):

```go
		case <-ticker.C:
			if q != nil && hb.IsUACInterceptionEnabled() {
				if drained, err := q.Drain(hb); err != nil {
					log.Debug("etwlua: periodic drain failed", "error", err.Error())
				} else if drained > 0 {
					log.Info("etwlua: periodic drain succeeded", "events", drained)
				}
			}
```

- [ ] **Step 4: Run the full agent test suite**

```bash
cd agent && go test -race ./internal/etwlua/ ./internal/heartbeat/ && go build ./...
```

Expected: PASS, clean build (the build proves `*heartbeat.Heartbeat` still satisfies `HeartbeatPoster` at the `main.go:624` call site).

- [ ] **Step 5: Commit**

```bash
git add agent/internal/etwlua/etwlua.go agent/internal/etwlua/etwlua_test.go
git commit -m "feat(pam): etwlua drops UAC events while interception is policy-disabled"
```

---

### Task 7: Docs + reference sync

**Files:**
- Modify: `~/.claude/skills/configuration-policy/SKILL.md` (local skill, not committed to repo)
- Modify: `docs/superpowers/specs/2026-06-10-helper-privileged-action-pam-governance-design.md` (append a short note)

- [ ] **Step 1: Update the configuration-policy skill**

In `~/.claude/skills/configuration-policy/SKILL.md`:
- Add `pam` to the "Current Feature Type Registry" table: `| pam | Inline | no normalized table | - |`
- Add `pam` to the inline-settings-only list in "Standalone Policy Prerequisites": append `pam` after `helper`.
- In the "All 14 Feature Type Inline Settings Shapes" area, note the shape: `pam: { uacInterceptionEnabled: boolean }` (default true; rules/approvals live in /pam, not config policies).

- [ ] **Step 2: Append a scope note to the PAM design spec**

At the end of `docs/superpowers/specs/2026-06-10-helper-privileged-action-pam-governance-design.md`, append:

```markdown
## Addendum (2026-06-12): Config-Policy enablement split

UAC interception enablement is now a `pam` config-policy feature (inline
settings `{uacInterceptionEnabled: boolean}`, default ON, closest-wins),
delivered to the agent via the heartbeat `uacInterceptionEnabled` field and
gated in `etwlua.handleEvent`. Rule authoring, the elevation request queue,
and audit remain org/site-scoped in the standalone `/pam` control plane —
closest-wins override semantics are intentionally NOT applied to the rule
chain (a device-level policy must not silently shadow org baseline security
rules). If partner-level rule baselines or device-group rule scoping become
a requirement, revisit as a Pattern A linked feature with explicit
merge (not override) semantics. Plan:
`docs/superpowers/plans/2026-06-12-pam-config-policy-enablement.md`.
```

- [ ] **Step 3: Commit (repo files only)**

```bash
git add docs/superpowers/specs/2026-06-10-helper-privileged-action-pam-governance-design.md
git commit -m "docs(pam): record config-policy enablement split in PAM design spec"
```

---

## Verification checklist (post-implementation)

- [ ] `pnpm db:check-drift` clean (Task 1 enum matches migration)
- [ ] `apps/api`: `npx vitest run src/routes/agents/pamSettings.test.ts src/routes/agents/heartbeat.test.ts` green
- [ ] `apps/web`: `npx vitest run src/components/configurationPolicies/featureTabs/` green, `npx tsc --noEmit` clean
- [ ] `agent`: `go test -race ./...` green, `go build ./...` clean
- [ ] Manual smoke (optional, needs local stack): create a config policy with the Privileged Access tab toggled OFF, assign to a Windows device's org, wait one heartbeat, confirm agent logs `UAC interception disabled by configuration policy` and no new `uac_intercept` elevation requests appear while triggering a UAC prompt on the device
- [ ] RLS: no new tables were created (inline JSONB on existing `config_policy_feature_links`), so no RLS work or allowlist changes are needed

## Design rationale (for future readers)

- **Why a toggle in Config Policies but rules in /pam:** Config-policy resolution is closest-level-wins with a single winner per feature type. That's correct for an enable flag ("org turns it on, this one server turns it off") but dangerous for security rule chains — a device-level feature link would silently shadow org baseline rules like "require approval for unsigned executables." PAM rules need union/priority-merge semantics, which the resolver doesn't have; they stay in `pam_rules` (org/site-scoped, fine-grained targeting via match criteria).
- **Why default ON:** UAC capture has been unconditional on all Windows agents since the feature shipped. Default-OFF would silently stop elevation discovery fleet-wide on upgrade. Decision confirmed by Todd 2026-06-12.
- **Why `*bool` on the agent:** an old API that doesn't send the field must decode as "enabled," not Go's `false` zero value.
- **Why the agent drops events instead of stopping the ETW session:** mirrors the `helperEnabled` atomic-flag precedent; avoids start/stop lifecycle complexity in `etwlua` (session teardown/re-subscribe races). The ETW session keeps running but nothing is posted or queued. If resource usage on disabled devices ever matters, a follow-up can add full session lifecycle management following the `monitor.ApplyConfig` stop-restart pattern.
