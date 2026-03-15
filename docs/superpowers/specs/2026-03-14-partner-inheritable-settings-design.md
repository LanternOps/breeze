# Partner-Level Inheritable Settings

## Overview

Add partner-level default settings that are inherited by all child organizations. When a partner sets a value, it becomes the effective value for all orgs and is locked (read-only) at the org level. Orgs can only configure fields the partner left unset.

## Data Model

### Partner Settings Extension

Extend the existing `partners.settings` JSONB column to include all inheritable categories:

```typescript
partners.settings = {
  // existing fields
  timezone, dateFormat, timeFormat, businessHours, contact,

  // NEW inheritable defaults
  security: { minLength, complexity, expirationDays, requireMfa, allowedMethods, sessionTimeout, maxSessions, ipAllowlist },
  notifications: { fromAddress, replyTo, useCustomSmtp, smtpHost, smtpPort, smtpUsername, smtpEncryption, slackWebhookUrl, slackChannel, webhooks, preferences },
  eventLogs: { enabled, elasticsearchUrl, elasticsearchApiKey, elasticsearchUsername, elasticsearchPassword, indexPrefix },
  defaults: { policyDefaults, deviceGroup, alertThreshold, autoEnrollment, agentUpdatePolicy, maintenanceWindow },
  branding: { logoUrl, primaryColor, secondaryColor, theme, customCss },
  aiBudgets: { enabled, monthlyBudgetCents, dailyBudgetCents, maxTurnsPerSession, messagesPerMinutePerUser, messagesPerHourPerOrg, approvalMode }
}
```

### Org Side

No schema changes. `organizations.settings` JSONB and `aiBudgets` table remain as-is. Fields with their key absent from the org JSONB inherit from partner.

## Merge Rule

Per-category, field-level merge:

```
For each category (security, notifications, branding, etc.):
  For each field in that category:
    effective[field] = field exists in orgCategory ? orgCategory[field] : partnerCategory[field]
    if field exists in partnerCategory → add "category.field" to locked list
```

**Key semantic**: A field is "set" if its key exists in the JSONB object, regardless of value (`null`, `false`, `0` all count as set). A field is "unset" only if the key is absent. This means:
- Org sets a field to `null` → org's `null` is used (field is present)
- Org has no key for the field → partner value is used
- To "yield" a field back to partner control, the org must delete the key from their settings (not set it to `null`)

### AI Budgets Merge

The `aiBudgets` table is a separate table, not JSONB on the org. Merge works the same way:

```
For each field in partners.settings.aiBudgets:
  effective[field] = aiBudgets row has non-null value ? aiBudgets[field] : partnerAiBudgets[field]
  if field exists in partnerAiBudgets → add "aiBudgets.field" to locked list
```

If no `aiBudgets` row exists for the org, partner values are the full effective config. When the partner clears a field, the org's `aiBudgets` row value (if any) becomes effective again.

### Lock Rule

Any field where the partner has set a value (key exists in partner settings) is read-only at the org level. The API rejects attempts to update locked fields. The UI disables them.

## API Layer

### New Service: `apps/api/src/services/effectiveSettings.ts`

**`getEffectiveOrgSettings(orgId)`**:
- Joins `organizations` → `partners` on `partnerId` to fetch both in one query
- Also queries `aiBudgets` row for the org (if exists)
- Deep merges per category: `security`, `notifications`, `eventLogs`, `defaults`, `branding`
- Merges `partners.settings.aiBudgets` with org's `aiBudgets` row
- Returns `{ effective: mergedSettings, locked: string[] }` where `locked` is a flat list of field paths (e.g. `["security.requireMfa", "aiBudgets.approvalMode"]`)

**`assertNotLocked(partnerSettings, category, patchFields)`**:
- Helper used by PATCH/PUT routes to enforce locks
- Receives the partner's settings for a category and the field keys being updated
- Throws `403` with message `"Field <category>.<field> is managed by partner policy"` if any locked field is in the patch

### New Endpoint: `GET /orgs/organizations/:id/effective-settings`

- Scope: `requireScope('organization', 'partner', 'system')`
- Calls `getEffectiveOrgSettings(orgId)`
- Returns `{ effective, locked }`
- The existing `GET /orgs/organizations/:id` continues to return the raw org record (no change)

### Org Settings PATCH — `PATCH /orgs/organizations/:id`

Before writing, for each settings category in the patch payload:
1. Load partner settings for the org's partner
2. Extract the field keys being changed in that category
3. Call `assertNotLocked(partnerSettings[category], patchFields)`
4. If no lock violation, write only the non-locked fields to org settings

### AI Budget PUT — `PUT /ai/budget`

Same pattern: load `partners.settings.aiBudgets`, call `assertNotLocked()` against the budget fields being updated.

### AI Budget Runtime Enforcement

**`checkBudget()` in `aiCostTracker.ts`** must also consult partner settings:
- When checking if AI is enabled and within budget, load effective (merged) budget values
- This ensures a partner setting `enabled: false` actually blocks AI even if the org has no `aiBudgets` row

**`checkAiRateLimit()` in `aiCostTracker.ts`** must load effective rate limits:
- Currently uses hardcoded `20` msgs/min and `200` msgs/hr
- Must load the effective (merged) `messagesPerMinutePerUser` and `messagesPerHourPerOrg`

### Partner Settings PATCH — `PATCH /orgs/partners/me`

- Extend the `partnerSettingsSchema` Zod validator to accept the new categories: `security`, `notifications`, `eventLogs`, `defaults`, `branding`, `aiBudgets`
- Works as today otherwise: merge `{ ...currentSettings, ...body.settings }`
- When a partner sets a new field, it becomes locked for all child orgs

## UI Behavior

### Org Settings Pages (`OrgSettingsPage.tsx`, `AiUsagePage.tsx`)

- On mount, fetch `GET /orgs/organizations/:id/effective-settings` to get `locked[]`
- For each locked field: input is `disabled`, styled with reduced opacity, and a small "Managed by partner" label shown beside it displaying the inherited value
- Non-locked fields work exactly as today

### `OrgEventLogSettings` Component

This component currently self-fetches its data (unlike the other editors which receive props). It must be refactored to also accept a `locked` prop, or it must call the effective-settings endpoint itself to determine which fields are locked.

### Partner Settings Page (`PartnerSettingsPage.tsx`)

- Add new tabs/sections matching the org settings categories: Security, Notifications, Event Logs, Defaults, Branding, AI Budgets
- Reuse the same form components from the org settings editors where possible (pass a `mode: 'partner' | 'org'` prop)
- Empty fields mean "org decides" — placeholder text: "Not set — orgs configure individually"
- Partner admin sees a note: "Values you set here are enforced across all organizations"
- No "Reset to default" at org level — locked fields are read-only. If the partner clears a field, it unlocks for all orgs.

## Edge Cases

### New org created

Starts with empty settings. All partner-set fields are immediately effective and locked. Org admin sees the partner's values from day one.

### Partner sets a field that orgs already overrode

Partner value takes over. The org's stored override becomes inert (stored but ignored). The locked field shows the partner value. If the partner later clears the field, the org's stored override resurfaces.

### Nested objects (e.g. `notifications.webhooks[]`, `security.allowedMethods`)

Treat the whole sub-object as one field. If partner sets `allowedMethods: { totp: true, sms: false }`, the entire object is locked, not individual keys within it.

### Org wants to yield a field back to partner

The org must delete the key from their settings JSONB (not set it to `null`). The PATCH route should support a convention for this — e.g. sending `{ security: { requireMfa: "__unset__" } }` removes the key.

## Files to Modify

### API
- `apps/api/src/services/effectiveSettings.ts` — **NEW**: `getEffectiveOrgSettings()`, `assertNotLocked()`
- `apps/api/src/services/aiCostTracker.ts` — update `checkBudget()` and `checkAiRateLimit()` to load effective merged settings
- `apps/api/src/routes/orgs.ts` — new `GET /:id/effective-settings` endpoint, lock enforcement on PATCH, extend `partnerSettingsSchema` Zod validator with new categories
- `apps/api/src/routes/ai.ts` — lock enforcement on `PUT /ai/budget`

### Shared
- `packages/shared/src/types/index.ts` — extend `PartnerSettings` type with new inheritable categories

### Web
- `apps/web/src/components/settings/PartnerSettingsPage.tsx` — add new tabs (Security, Notifications, Event Logs, Defaults, Branding, AI Budgets)
- `apps/web/src/components/settings/OrgSettingsPage.tsx` — fetch effective-settings, consume `locked` list, disable locked fields
- `apps/web/src/components/settings/AiUsagePage.tsx` — fetch effective-settings for AI budget locks, disable locked fields
- `apps/web/src/components/settings/OrgEventLogSettings.tsx` — refactor to accept `locked` prop
- Org settings editor sub-components — add `mode: 'partner' | 'org'` prop support and locked-field styling
