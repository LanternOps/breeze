# Partner-Level Inheritable Settings — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add partner-level default settings that child organizations inherit, with locked (read-only) enforcement at the org level when the partner has set a value.

**Architecture:** Extend `partners.settings` JSONB with new inheritable categories. New `effectiveSettings.ts` service merges partner + org settings and computes locked field list. New `GET /organizations/:id/effective-settings` endpoint serves merged data. PATCH/PUT routes enforce locks. UI disables locked fields with "Managed by partner" labels.

**Tech Stack:** Hono, Drizzle ORM, PostgreSQL JSONB, React, TypeScript

---

## Task 1: Extend Shared Types

**Files:**
- Modify: `packages/shared/src/types/index.ts`

- [ ] **Step 1: Add inheritable category interfaces to PartnerSettings**

In `packages/shared/src/types/index.ts`, find the `PartnerSettings` interface (around line 433) and extend it with the new categories. Add these interfaces before `PartnerSettings` and then extend the interface:

```typescript
// Add before PartnerSettings interface:

export interface InheritableSecuritySettings {
  minLength?: number;
  complexity?: 'standard' | 'strict' | 'passphrase';
  expirationDays?: number;
  requireMfa?: boolean;
  allowedMethods?: { totp?: boolean; sms?: boolean };
  sessionTimeout?: number;
  maxSessions?: number;
  ipAllowlist?: string[];
}

export interface InheritableNotificationSettings {
  fromAddress?: string;
  replyTo?: string;
  useCustomSmtp?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpUsername?: string;
  smtpEncryption?: 'tls' | 'ssl' | 'none';
  slackWebhookUrl?: string;
  slackChannel?: string;
  webhooks?: string[];
  preferences?: Record<string, Record<string, boolean>>;
}

export interface InheritableEventLogSettings {
  enabled?: boolean;
  elasticsearchUrl?: string;
  elasticsearchApiKey?: string;
  elasticsearchUsername?: string;
  elasticsearchPassword?: string;
  indexPrefix?: string;
}

export interface InheritableDefaultSettings {
  policyDefaults?: Record<string, string>;
  deviceGroup?: string;
  alertThreshold?: string;
  autoEnrollment?: {
    enabled: boolean;
    requireApproval: boolean;
    sendWelcome: boolean;
  };
  agentUpdatePolicy?: string;
  maintenanceWindow?: string;
}

export interface InheritableBrandingSettings {
  logoUrl?: string;
  primaryColor?: string;
  secondaryColor?: string;
  theme?: 'light' | 'dark' | 'system';
  customCss?: string;
}

export interface InheritableAiBudgetSettings {
  enabled?: boolean;
  monthlyBudgetCents?: number | null;
  dailyBudgetCents?: number | null;
  maxTurnsPerSession?: number;
  messagesPerMinutePerUser?: number;
  messagesPerHourPerOrg?: number;
  approvalMode?: 'per_step' | 'action_plan' | 'auto_approve' | 'hybrid_plan';
}

export interface EffectiveOrgSettings {
  security?: InheritableSecuritySettings;
  notifications?: InheritableNotificationSettings;
  eventLogs?: InheritableEventLogSettings;
  defaults?: InheritableDefaultSettings;
  branding?: InheritableBrandingSettings;
  aiBudgets?: InheritableAiBudgetSettings;
  locked: string[];
}
```

Then extend the existing `PartnerSettings` interface to include the new optional categories:

```typescript
export interface PartnerSettings {
  // existing fields stay
  timezone?: string;
  dateFormat?: DateFormat;
  timeFormat?: TimeFormat;
  language?: 'en';
  businessHours?: { ... };
  contact?: { ... };
  // NEW inheritable categories
  security?: InheritableSecuritySettings;
  notifications?: InheritableNotificationSettings;
  eventLogs?: InheritableEventLogSettings;
  defaults?: InheritableDefaultSettings;
  branding?: InheritableBrandingSettings;
  aiBudgets?: InheritableAiBudgetSettings;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/shared/src/types/index.ts
git commit -m "feat: add inheritable settings types to PartnerSettings"
```

---

## Task 2: Create effectiveSettings Service

**Files:**
- Create: `apps/api/src/services/effectiveSettings.ts`

- [ ] **Step 1: Create the service file**

```typescript
import { db } from '../db';
import { organizations } from '../db/schema/orgs';
import { partners } from '../db/schema/orgs';
import { aiBudgets } from '../db/schema/ai';
import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';

const INHERITABLE_CATEGORIES = [
  'security', 'notifications', 'eventLogs', 'defaults', 'branding'
] as const;

type Category = typeof INHERITABLE_CATEGORIES[number];

/**
 * Merge a single settings category: org fields override partner fields.
 * Returns { effective, lockedFields } where lockedFields are paths
 * where the partner has set a value (key exists in partner category).
 */
function mergeCategory(
  category: string,
  partnerCat: Record<string, unknown> | undefined,
  orgCat: Record<string, unknown> | undefined
): { effective: Record<string, unknown>; lockedFields: string[] } {
  const lockedFields: string[] = [];
  const effective: Record<string, unknown> = {};

  if (!partnerCat && !orgCat) return { effective, lockedFields };

  // Start with partner values
  if (partnerCat) {
    for (const [key, value] of Object.entries(partnerCat)) {
      effective[key] = value;
      lockedFields.push(`${category}.${key}`);
    }
  }

  // Overlay org values for non-locked fields only
  if (orgCat) {
    for (const [key, value] of Object.entries(orgCat)) {
      if (!partnerCat || !(key in partnerCat)) {
        effective[key] = value;
      }
      // If partner set this key, org value is ignored (locked)
    }
  }

  return { effective, lockedFields };
}

/**
 * Merge AI budget settings from partner JSONB + org aiBudgets table row.
 */
function mergeAiBudgets(
  partnerBudgets: Record<string, unknown> | undefined,
  orgBudgetRow: Record<string, unknown> | null
): { effective: Record<string, unknown>; lockedFields: string[] } {
  const lockedFields: string[] = [];
  const effective: Record<string, unknown> = {};

  if (!partnerBudgets && !orgBudgetRow) return { effective, lockedFields };

  // Start with partner values
  if (partnerBudgets) {
    for (const [key, value] of Object.entries(partnerBudgets)) {
      effective[key] = value;
      lockedFields.push(`aiBudgets.${key}`);
    }
  }

  // Overlay org budget row values for non-locked fields
  if (orgBudgetRow) {
    const budgetFields = [
      'enabled', 'monthlyBudgetCents', 'dailyBudgetCents',
      'maxTurnsPerSession', 'messagesPerMinutePerUser',
      'messagesPerHourPerOrg', 'approvalMode'
    ];
    for (const key of budgetFields) {
      if (!partnerBudgets || !(key in partnerBudgets)) {
        if (orgBudgetRow[key] !== undefined && orgBudgetRow[key] !== null) {
          effective[key] = orgBudgetRow[key];
        }
      }
    }
  }

  return { effective, lockedFields };
}

/**
 * Get effective (merged) settings for an organization.
 * Joins partner defaults with org overrides.
 */
export async function getEffectiveOrgSettings(orgId: string) {
  // Fetch org + partner in parallel
  const [org] = await db
    .select({
      id: organizations.id,
      settings: organizations.settings,
      partnerId: organizations.partnerId,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org) throw new HTTPException(404, { message: 'Organization not found' });

  const [partner] = await db
    .select({ settings: partners.settings })
    .from(partners)
    .where(eq(partners.id, org.partnerId))
    .limit(1);

  const [orgBudget] = await db
    .select()
    .from(aiBudgets)
    .where(eq(aiBudgets.orgId, orgId))
    .limit(1);

  const partnerSettings = (partner?.settings as Record<string, unknown>) || {};
  const orgSettings = (org.settings as Record<string, unknown>) || {};

  const allLocked: string[] = [];
  const effective: Record<string, unknown> = {};

  // Merge each inheritable category
  for (const cat of INHERITABLE_CATEGORIES) {
    const partnerCat = partnerSettings[cat] as Record<string, unknown> | undefined;
    const orgCat = orgSettings[cat] as Record<string, unknown> | undefined;
    const { effective: merged, lockedFields } = mergeCategory(cat, partnerCat, orgCat);
    if (Object.keys(merged).length > 0) {
      effective[cat] = merged;
    }
    allLocked.push(...lockedFields);
  }

  // Merge AI budgets
  const partnerBudgets = partnerSettings.aiBudgets as Record<string, unknown> | undefined;
  const orgBudgetData = orgBudget
    ? {
        enabled: orgBudget.enabled,
        monthlyBudgetCents: orgBudget.monthlyBudgetCents,
        dailyBudgetCents: orgBudget.dailyBudgetCents,
        maxTurnsPerSession: orgBudget.maxTurnsPerSession,
        messagesPerMinutePerUser: orgBudget.messagesPerMinutePerUser,
        messagesPerHourPerOrg: orgBudget.messagesPerHourPerOrg,
        approvalMode: orgBudget.approvalMode,
      }
    : null;
  const { effective: budgetEffective, lockedFields: budgetLocked } =
    mergeAiBudgets(partnerBudgets, orgBudgetData);
  if (Object.keys(budgetEffective).length > 0) {
    effective.aiBudgets = budgetEffective;
  }
  allLocked.push(...budgetLocked);

  return { effective, locked: allLocked };
}

/**
 * Assert that no locked fields are being updated.
 * Throws 403 if any field in the patch is locked by partner policy.
 */
export async function assertNotLocked(
  orgId: string,
  category: string,
  patchFields: string[]
): Promise<void> {
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org) throw new HTTPException(404, { message: 'Organization not found' });

  const [partner] = await db
    .select({ settings: partners.settings })
    .from(partners)
    .where(eq(partners.id, org.partnerId))
    .limit(1);

  const partnerSettings = (partner?.settings as Record<string, unknown>) || {};
  const partnerCat = partnerSettings[category] as Record<string, unknown> | undefined;

  if (!partnerCat) return; // No partner settings for this category = nothing locked

  for (const field of patchFields) {
    if (field in partnerCat) {
      throw new HTTPException(403, {
        message: `Field ${category}.${field} is managed by partner policy`,
      });
    }
  }
}

/**
 * Get effective AI budget values for runtime checks (checkBudget, checkAiRateLimit).
 * Returns merged budget config without the full settings overhead.
 */
export async function getEffectiveAiBudget(orgId: string) {
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org) return null;

  const [partner] = await db
    .select({ settings: partners.settings })
    .from(partners)
    .where(eq(partners.id, org.partnerId))
    .limit(1);

  const [orgBudget] = await db
    .select()
    .from(aiBudgets)
    .where(eq(aiBudgets.orgId, orgId))
    .limit(1);

  const partnerSettings = (partner?.settings as Record<string, unknown>) || {};
  const partnerBudgets = partnerSettings.aiBudgets as Record<string, unknown> | undefined;

  // If neither exists, return null (no limits)
  if (!partnerBudgets && !orgBudget) return null;

  // Build effective budget: partner values win where set
  const effective = {
    enabled: true as boolean,
    monthlyBudgetCents: null as number | null,
    dailyBudgetCents: null as number | null,
    maxTurnsPerSession: 50,
    messagesPerMinutePerUser: 20,
    messagesPerHourPerOrg: 200,
    approvalMode: 'per_step' as string,
  };

  // Apply org budget row first (lower priority)
  if (orgBudget) {
    effective.enabled = orgBudget.enabled;
    effective.monthlyBudgetCents = orgBudget.monthlyBudgetCents;
    effective.dailyBudgetCents = orgBudget.dailyBudgetCents;
    effective.maxTurnsPerSession = orgBudget.maxTurnsPerSession;
    effective.messagesPerMinutePerUser = orgBudget.messagesPerMinutePerUser;
    effective.messagesPerHourPerOrg = orgBudget.messagesPerHourPerOrg;
    effective.approvalMode = orgBudget.approvalMode;
  }

  // Apply partner values (higher priority — overrides org)
  if (partnerBudgets) {
    if ('enabled' in partnerBudgets) effective.enabled = partnerBudgets.enabled as boolean;
    if ('monthlyBudgetCents' in partnerBudgets) effective.monthlyBudgetCents = partnerBudgets.monthlyBudgetCents as number | null;
    if ('dailyBudgetCents' in partnerBudgets) effective.dailyBudgetCents = partnerBudgets.dailyBudgetCents as number | null;
    if ('maxTurnsPerSession' in partnerBudgets) effective.maxTurnsPerSession = partnerBudgets.maxTurnsPerSession as number;
    if ('messagesPerMinutePerUser' in partnerBudgets) effective.messagesPerMinutePerUser = partnerBudgets.messagesPerMinutePerUser as number;
    if ('messagesPerHourPerOrg' in partnerBudgets) effective.messagesPerHourPerOrg = partnerBudgets.messagesPerHourPerOrg as number;
    if ('approvalMode' in partnerBudgets) effective.approvalMode = partnerBudgets.approvalMode as string;
  }

  return effective;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/services/effectiveSettings.ts
git commit -m "feat: add effectiveSettings service for partner→org inheritance"
```

---

## Task 3: Extend Partner Settings Zod Schema + Add API Routes

**Files:**
- Modify: `apps/api/src/routes/orgs.ts`

- [ ] **Step 1: Extend partnerSettingsSchema with inheritable categories**

Find the `partnerSettingsSchema` (around line 294) and add the new category schemas after the existing fields:

```typescript
const partnerSettingsSchema = z.object({
  // ... existing fields stay ...
  timezone: z.string().optional(),
  dateFormat: z.enum(['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD']).optional(),
  timeFormat: z.enum(['12h', '24h']).optional(),
  language: z.literal('en').optional(),
  businessHours: z.object({
    preset: z.enum(['24/7', 'business', 'extended', 'custom']),
    custom: z.record(z.string(), dayScheduleSchema).optional()
  }).optional(),
  contact: z.object({
    name: z.string().optional(),
    email: z.string().email().optional().or(z.literal('')),
    phone: z.string().optional(),
    website: z.string().optional()
  }).optional(),
  // NEW inheritable categories
  security: z.object({
    minLength: z.number().int().min(6).max(128).optional(),
    complexity: z.enum(['standard', 'strict', 'passphrase']).optional(),
    expirationDays: z.number().int().min(0).optional(),
    requireMfa: z.boolean().optional(),
    allowedMethods: z.object({ totp: z.boolean().optional(), sms: z.boolean().optional() }).optional(),
    sessionTimeout: z.number().int().min(1).optional(),
    maxSessions: z.number().int().min(1).optional(),
    ipAllowlist: z.array(z.string()).optional(),
  }).optional(),
  notifications: z.object({
    fromAddress: z.string().optional(),
    replyTo: z.string().optional(),
    useCustomSmtp: z.boolean().optional(),
    smtpHost: z.string().optional(),
    smtpPort: z.number().int().optional(),
    smtpUsername: z.string().optional(),
    smtpEncryption: z.enum(['tls', 'ssl', 'none']).optional(),
    slackWebhookUrl: z.string().optional(),
    slackChannel: z.string().optional(),
    webhooks: z.array(z.string()).optional(),
    preferences: z.record(z.string(), z.record(z.string(), z.boolean())).optional(),
  }).optional(),
  eventLogs: z.object({
    enabled: z.boolean().optional(),
    elasticsearchUrl: z.string().optional(),
    elasticsearchApiKey: z.string().optional(),
    elasticsearchUsername: z.string().optional(),
    elasticsearchPassword: z.string().optional(),
    indexPrefix: z.string().optional(),
  }).optional(),
  defaults: z.object({
    policyDefaults: z.record(z.string(), z.string()).optional(),
    deviceGroup: z.string().optional(),
    alertThreshold: z.string().optional(),
    autoEnrollment: z.object({
      enabled: z.boolean(),
      requireApproval: z.boolean(),
      sendWelcome: z.boolean(),
    }).optional(),
    agentUpdatePolicy: z.string().optional(),
    maintenanceWindow: z.string().optional(),
  }).optional(),
  branding: z.object({
    logoUrl: z.string().optional(),
    primaryColor: z.string().optional(),
    secondaryColor: z.string().optional(),
    theme: z.enum(['light', 'dark', 'system']).optional(),
    customCss: z.string().optional(),
  }).optional(),
  aiBudgets: z.object({
    enabled: z.boolean().optional(),
    monthlyBudgetCents: z.number().int().min(0).nullable().optional(),
    dailyBudgetCents: z.number().int().min(0).nullable().optional(),
    maxTurnsPerSession: z.number().int().min(1).max(200).optional(),
    messagesPerMinutePerUser: z.number().int().min(1).max(100).optional(),
    messagesPerHourPerOrg: z.number().int().min(1).max(10000).optional(),
    approvalMode: z.enum(['per_step', 'action_plan', 'auto_approve', 'hybrid_plan']).optional(),
  }).optional(),
});
```

- [ ] **Step 2: Add GET /organizations/:id/effective-settings endpoint**

Add this new route near the existing `GET /organizations/:id` route. Import `getEffectiveOrgSettings` from the service:

```typescript
import { getEffectiveOrgSettings, assertNotLocked } from '../services/effectiveSettings';

orgRoutes.get('/organizations/:id/effective-settings',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const id = c.req.param('id')!;

    // Org-scoped users can only see their own org
    if (auth.scope === 'organization' && id !== auth.orgId) {
      return c.json({ error: 'Access denied' }, 403);
    }
    if (auth.scope === 'partner' && !auth.canAccessOrg(id)) {
      return c.json({ error: 'Organization not found' }, 404);
    }

    const result = await getEffectiveOrgSettings(id);
    return c.json(result);
  }
);
```

- [ ] **Step 3: Add lock enforcement to PATCH /organizations/:id**

In the existing `updateOrgHandler`, add lock enforcement before the database write. After `const data = c.req.valid('json');` add:

```typescript
// Enforce partner locks on settings categories
if (data.settings) {
  const settingsObj = data.settings as Record<string, unknown>;
  for (const category of ['security', 'notifications', 'eventLogs', 'defaults', 'branding']) {
    if (settingsObj[category] && typeof settingsObj[category] === 'object') {
      const fields = Object.keys(settingsObj[category] as Record<string, unknown>);
      await assertNotLocked(id, category, fields);
    }
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/orgs.ts
git commit -m "feat: extend partner schema + effective-settings endpoint + lock enforcement"
```

---

## Task 4: Add Lock Enforcement to AI Budget Route

**Files:**
- Modify: `apps/api/src/routes/ai.ts`

- [ ] **Step 1: Add lock check to PUT /ai/budget**

Import and add lock enforcement before `updateBudget()` call:

```typescript
import { assertNotLocked } from '../services/effectiveSettings';
```

In the `PUT /budget` handler, after the access check and before `await updateBudget(orgId, body)`:

```typescript
// Enforce partner locks on AI budget fields
const budgetFields = Object.keys(body);
if (budgetFields.length > 0) {
  await assertNotLocked(orgId, 'aiBudgets', budgetFields);
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/routes/ai.ts
git commit -m "feat: enforce partner locks on AI budget updates"
```

---

## Task 5: Update AI Cost Tracker to Use Effective Settings

**Files:**
- Modify: `apps/api/src/services/aiCostTracker.ts`

- [ ] **Step 1: Update checkBudget() to use effective budget**

Import the service:
```typescript
import { getEffectiveAiBudget } from './effectiveSettings';
```

Replace the `checkBudget` function's budget lookup. Instead of querying `aiBudgets` directly:

```typescript
export async function checkBudget(orgId: string): Promise<string | null> {
  const budget = await getEffectiveAiBudget(orgId);

  // No budget configured = no limits
  if (!budget) return null;
  if (!budget.enabled) return 'AI features are disabled for this organization';

  // ... rest of the function stays the same but uses budget.dailyBudgetCents
  // and budget.monthlyBudgetCents from the effective merged object
```

- [ ] **Step 2: Update checkAiRateLimit() to use effective rate limits**

Replace hardcoded values with effective budget lookup:

```typescript
export async function checkAiRateLimit(
  userId: string,
  orgId: string
): Promise<string | null> {
  const redis = getRedis();

  // Load effective rate limits (partner overrides org)
  const budget = await getEffectiveAiBudget(orgId);
  const msgsPerMin = budget?.messagesPerMinutePerUser ?? 20;
  const msgsPerHour = budget?.messagesPerHourPerOrg ?? 200;

  // Per-user rate limit
  const userResult = await rateLimiter(redis, `ai:msg:user:${userId}`, msgsPerMin, 60);
  if (!userResult.allowed) {
    return `Rate limit exceeded. Try again at ${userResult.resetAt.toISOString()}`;
  }

  // Per-org rate limit
  const orgResult = await rateLimiter(redis, `ai:msg:org:${orgId}`, msgsPerHour, 3600);
  if (!orgResult.allowed) {
    return `Organization rate limit exceeded. Try again at ${orgResult.resetAt.toISOString()}`;
  }

  return null;
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/aiCostTracker.ts
git commit -m "feat: checkBudget and checkAiRateLimit use effective partner-merged settings"
```

---

## Task 6: Partner Settings UI — Add Inheritable Category Tabs

**Files:**
- Modify: `apps/web/src/components/settings/PartnerSettingsPage.tsx`

- [ ] **Step 1: Add state variables and tabs for new categories**

The PartnerSettingsPage currently has a flat form. Add a tab system and form sections for each new category (Security, Notifications, Event Logs, Defaults, Branding, AI Budgets).

Key pattern:
- Add `activeTab` state (default: 'regional' for existing settings)
- Tab buttons at top: Regional, Security, Notifications, Event Logs, Defaults, Branding, AI Budgets
- Each tab renders its own form section
- On save, include all categories in the settings patch (not just the active tab)
- Empty fields show placeholder: "Not set — orgs configure individually"
- Note at top: "Values you set here are enforced across all organizations"

The fetch already loads `partner.settings` — just read the new categories from it. The save already merges `{ ...currentSettings, ...body.settings }` — just include the new categories.

For each new tab, use the same form field pattern as the existing regional settings (useState per field, markDirty on change).

Reuse field structures from the org editors (OrgSecuritySettings, OrgNotificationSettings, etc.) but simplified — no parent/child callback pattern needed since PartnerSettingsPage is self-contained.

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/settings/PartnerSettingsPage.tsx
git commit -m "feat: add inheritable settings tabs to partner settings page"
```

---

## Task 7: Org Settings UI — Consume Locked List

**Files:**
- Modify: `apps/web/src/components/settings/OrgSettingsPage.tsx`
- Modify: `apps/web/src/components/settings/OrgSecuritySettings.tsx`
- Modify: `apps/web/src/components/settings/OrgNotificationSettings.tsx`
- Modify: `apps/web/src/components/settings/OrgBrandingEditor.tsx`
- Modify: `apps/web/src/components/settings/OrgEventLogSettings.tsx`

- [ ] **Step 1: Fetch effective-settings in OrgSettingsPage**

Add a `locked` state and fetch from the new endpoint:

```typescript
const [locked, setLocked] = useState<string[]>([]);

// In fetchOrgDetails or separate useEffect:
const effRes = await fetchWithAuth(`/orgs/organizations/${currentOrgId}/effective-settings`);
if (effRes.ok) {
  const effData = await effRes.json();
  setLocked(effData.locked || []);
}
```

Pass `locked` to each child editor:

```typescript
<OrgSecuritySettings
  security={orgDetails?.settings?.security}
  mtls={orgDetails?.settings?.mtls}
  onDirty={handleDirty}
  onSave={(data) => handleSave('security', data)}
  locked={locked}
/>
```

- [ ] **Step 2: Add locked prop support to child editors**

For each editor component (OrgSecuritySettings, OrgNotificationSettings, OrgBrandingEditor):

1. Add `locked?: string[]` to props type
2. Create helper: `const isLocked = (field: string) => locked?.some(l => l === field) ?? false;`
3. For each form input, add: `disabled={isLocked('security.requireMfa')}`
4. Show label when locked:
```tsx
{isLocked('security.requireMfa') && (
  <span className="text-xs text-muted-foreground italic">Managed by partner</span>
)}
```
5. Style locked inputs: add `opacity-60` class when disabled

- [ ] **Step 3: Refactor OrgEventLogSettings to accept locked prop**

Add `locked?: string[]` to the props type. Use the same `isLocked` helper pattern. Disable fields where `isLocked('eventLogs.enabled')` etc. The component keeps its self-fetch pattern but disables locked fields.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/settings/OrgSettingsPage.tsx
git add apps/web/src/components/settings/OrgSecuritySettings.tsx
git add apps/web/src/components/settings/OrgNotificationSettings.tsx
git add apps/web/src/components/settings/OrgBrandingEditor.tsx
git add apps/web/src/components/settings/OrgEventLogSettings.tsx
git commit -m "feat: org settings UI consumes locked list from partner"
```

---

## Task 8: AI Usage UI — Consume Locked List

**Files:**
- Modify: `apps/web/src/components/settings/AiUsagePage.tsx`

- [ ] **Step 1: Fetch locked fields and disable locked budget inputs**

Add locked state and fetch:

```typescript
const [locked, setLocked] = useState<string[]>([]);

// In fetchData:
const effRes = await fetchWithAuth(`/orgs/organizations/${currentOrgId}/effective-settings`);
if (effRes.ok) {
  const effData = await effRes.json();
  setLocked(effData.locked || []);
}
```

Helper:
```typescript
const isLocked = (field: string) => locked.some(l => l === `aiBudgets.${field}`);
```

For each budget form field (enabled, monthlyBudget, dailyBudget, approvalMode, etc.):
- Add `disabled={isLocked('approvalMode')}` to the input/select
- Add `className={isLocked('approvalMode') ? 'opacity-60' : ''}`
- Show "Managed by partner" label when locked

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/settings/AiUsagePage.tsx
git commit -m "feat: AI usage page respects partner-locked budget fields"
```

---

## Task 9: Final Verification

- [ ] **Step 1: Type check**

```bash
cd apps/api && npx tsc --noEmit
```

- [ ] **Step 2: Verify no regressions in existing tests**

```bash
pnpm test --filter=@breeze/api
```

- [ ] **Step 3: Commit any fixes**
