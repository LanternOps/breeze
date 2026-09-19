---
tracking_issue: LanternOps/breeze#5287
wave_issue: LanternOps/breeze#5289
branch: feature/5287-monitoring-automation-unification/wave-5289-web
---

# Monitoring & Automation Unification — W02 Web and Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give technicians the Monitors page, the monitor editor, the config-policy Monitors tab, legacy-rule conversion, and the AI/MCP tools on top of the W02 API (`…-02-api-foundation.md`), and make every managed row read-only in the existing UIs.

**Architecture:** `/monitoring` becomes the Monitors list (the network page moves to `/monitoring/network`; the W01 tab strip gains Monitors and Legacy rules). A `MonitorEditor` composes six cards over one react-hook-form; the Respond card reuses an `ActionsEditor` extracted from `AutomationForm` so both forms share one action UI. Condition fields render from a per-kind field map that mirrors `monitorConditionSchemas` in `@breeze/shared`. The config-policy `MonitorsTab` follows `VulnerabilityTab` (`useFeatureLink` + `onLinkChanged`) and stores `{ items: [{ monitorId, enabled, overrides }] }`. Managed automations/templates render read-only with a link to their monitor. MCP gets `list_monitors` / `get_monitor` (Tier 1) and `manage_monitors` (Tier 3).

**Tech Stack:** Astro pages + React islands, react-hook-form + zod (`@breeze/shared` validators), react-i18next with a new `monitoring` namespace (auto-registered from `locales/<locale>/monitoring.json`), Vitest + jsdom; Hono `registerTool` pattern for AI tools.

**Spec:** `docs/superpowers/specs/monitoring/2026-09-08-monitoring-automation-unification-design.md` (§Navigation and web, §API, §AI)

**Tracking:** feature LanternOps/breeze#5287, wave #5289. Branch `feature/5287-monitoring-automation-unification/wave-5289-web`, cut from the API plan's branch once its PR is merged (or rebased onto main after). PR body `Closes #5289`.

## Global Constraints

- Depends on the API plan's routes: `GET/POST /monitors`, `GET /monitors/kinds`, `GET/PATCH/DELETE /monitors/:id`, `POST /monitors/:id/attachments`, `DELETE /monitors/:id/attachments/:attachmentId`, `GET /monitors/:id/devices`, `POST /monitors/:id/test`, `POST /alerts/rules/:id/convert-to-monitor`, and `managedByMonitorId` on automation / rule / template payloads.
- New namespace file `apps/web/src/locales/<locale>/monitoring.json` in all 8 locales (`de-DE, en, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR`). `keyUsage.test.ts` fails on any `t('…')` key missing from `en`; `localeParity.test.ts` fails on any key missing from a locale. Dynamic keys need the `/* i18n-dynamic */` marker.
- Mutations go through `runAction` (`apps/web/src/lib/runAction.ts`); the `no-silent-mutations` test guards the handler set.
- Hash state for in-page tabs; path-based tab strip for the hub (W01 decision).
- Managed rows (`managedByMonitorId` set) are never editable from the automation, alert-rule, or template UIs — the API returns 409, and the UI must not offer the button.
- Every task: red test first, `pnpm --filter @breeze/web test --run <file>`, commit. Before the PR: lint, the i18n suites, `pnpm --filter @breeze/web build`.

---

### Task 1: Extract `ActionsEditor` from `AutomationForm`

**Files:**
- Create: `apps/web/src/components/automations/ActionsEditor.tsx`, `ActionsEditor.test.tsx`
- Modify: `apps/web/src/components/automations/AutomationForm.tsx:62-84` (`actionSchema` → export), `:280-284` (`useFieldArray` for actions), `:648-700` (the rendered actions section)
- Test: `apps/web/src/components/automations/AutomationForm.test.tsx` (existing; must stay green)

**Interfaces:**
- Produces: `export const actionSchema` (moved, unchanged shape, now also accepts `'ai_triage'` **only** when the `allowAiTriage` prop is set — see below) and

```tsx
export interface ActionsEditorProps {
  /** react-hook-form field-array name, e.g. 'actions' or 'recurrenceActions' */
  name: string;
  /** Show the ai_triage option (monitor editor with an AI agent selected). Default false. */
  allowAiTriage?: boolean;
  /** Hide the "when offline" selector (monitor responses are always device-bound; queueing still applies). Default false. */
  compact?: boolean;
}
export default function ActionsEditor(props: ActionsEditorProps): JSX.Element;   // uses useFormContext(); parent must wrap in <FormProvider>
```

- [ ] **Step 1: Write the failing test** (`ActionsEditor.test.tsx`)

```tsx
import '@/lib/i18n';
import { render, screen, fireEvent } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import { describe, it, expect } from 'vitest';
import ActionsEditor from './ActionsEditor';

function Host({ allowAiTriage = false }: { allowAiTriage?: boolean }) {
  const form = useForm({ defaultValues: { actions: [{ type: 'run_script' }] } });
  return (
    <FormProvider {...form}>
      <ActionsEditor name="actions" allowAiTriage={allowAiTriage} />
      <output data-testid="count">{form.watch('actions').length}</output>
    </FormProvider>
  );
}

describe('ActionsEditor (#5289)', () => {
  it('adds and removes actions through the form context', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: /add action/i }));
    expect(screen.getByTestId('count').textContent).toBe('2');
    fireEvent.click(screen.getAllByRole('button', { name: /remove action/i })[0]);
    expect(screen.getByTestId('count').textContent).toBe('1');
  });

  it('offers ai_triage only when allowed', () => {
    const { unmount } = render(<Host />);
    expect(screen.queryByRole('option', { name: /ai triage/i })).toBeNull();
    unmount();
    render(<Host allowAiTriage />);
    expect(screen.getByRole('option', { name: /ai triage/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @breeze/web test --run src/components/automations/ActionsEditor.test.tsx` → module not found.

- [ ] **Step 3: Extract** — move the JSX between the actions `<h3>` (line ~651) and the end of the actions list into `ActionsEditor`, replacing `register`/`control`/`errors`/`watch` with `const { register, control, formState: { errors }, watch } = useFormContext();` and `useFieldArray({ control, name })`. Keep every existing i18n key (`automationForm.actions.*`, `automationForm.sections.*`) so no locale changes are needed. The remove button gets `aria-label={t('automationForm.actions.removeAction')}` (add this key to `scripts.json` in all 8 locales if it does not exist: en `"Remove action"`, de-DE `"Aktion entfernen"`, es-419 `"Quitar acción"`, fr-CA/fr-FR `"Retirer l'action"`, it-IT `"Rimuovi azione"`, pt-BR `"Remover ação"`, tr-TR `"Eylemi kaldır"`). In `AutomationForm`, wrap the `<form>` in `<FormProvider {...formMethods}>` and render `<ActionsEditor name="actions" />` where the section was. Add `'ai_triage'` to `actionSchema`'s enum; `ActionsEditor` filters it out of the `<select>` options unless `allowAiTriage`.

- [ ] **Step 4: Run both suites — PASS.** `pnpm --filter @breeze/web test --run src/components/automations`. Commit: `git commit -m "refactor(web): extract ActionsEditor from AutomationForm (#5289)"`.

---

### Task 2: `monitoring` locale namespace + kind field map

**Files:**
- Create: `apps/web/src/locales/{8 locales}/monitoring.json`
- Create: `apps/web/src/components/monitoring/monitorKindFields.ts`, `monitorKindFields.test.ts`

**Interfaces:**
- Produces:

```ts
export type FieldKind = 'number' | 'text' | 'select' | 'operator';
export interface KindField { key: string; labelKey: string; kind: FieldKind; options?: readonly string[]; min?: number; max?: number; step?: number; optional?: boolean; unit?: string }
export const MONITOR_KIND_FIELDS: Record<MonitorKind, readonly KindField[]>;   // MonitorKind from @breeze/shared
export function defaultConditionFor(kind: MonitorKind): Record<string, unknown>;  // first valid values, e.g. cpu → { operator: 'gt', value: 90, durationMinutes: 5 }
```

Field map (keys must match `monitorConditionSchemas` in `packages/shared/src/validators/monitors.ts` exactly):

| kind | fields |
|---|---|
| cpu, memory, disk | `operator` (operator), `value` (number 0–100, unit `%`), `durationMinutes` (number 1–1440, optional) |
| offline | `durationMinutes` (number 1–10080) |
| event_log | `category` (select security/hardware/application/system), `level` (select warning/error/critical), `sourcePattern` (text, optional), `messagePattern` (text, optional), `countThreshold` (number ≥1), `windowMinutes` (number 1–1440) |
| patch_compliance | `operator`, `value` (0–100, `%`) |
| service | `serviceName` (text), `consecutiveFailures` (number 1–20, optional) |
| process | `processName` (text), `consecutiveFailures` (optional) |
| process_resource | `resource` (select cpu/memory), `processName` (text), `operator`, `value` (number ≥0), `durationMinutes` (optional) |
| cert_expiry | `withinDays` (number 1–365) |
| bandwidth | `direction` (select in/out/total), `operator`, `value` (number, unit `Mbps`), `durationMinutes` (optional) |
| disk_io | `direction` (select read/write/total), `operator`, `value` (unit `MB/s`), `durationMinutes` (optional) |
| network_errors | `interfaceName` (text, optional), `errorType` (select in/out/total), `operator`, `value` (number ≥0), `windowMinutes` (optional) |

- [ ] **Step 1: Failing test** — for every `MonitorKind`, `monitorConditionSchemas[kind].safeParse(defaultConditionFor(kind)).success === true`, and every `KindField.key` is a key of the schema's shape.

- [ ] **Step 2: Implement the map and `en/monitoring.json`** with these top-level blocks (every key referenced by later tasks lives here):

```json
{
  "hub": { "title": "Monitoring & Automation", "tabs": { "monitors": "Monitors", "network": "Network", "delivery": "Delivery", "legacyRules": "Legacy rules" } },
  "list": { "title": "Monitors", "description": "Watch a condition, respond on the device, notify, and escalate when it keeps happening.", "new": "New monitor", "empty": "No monitors yet.", "columns": { "name": "Name", "kind": "Kind", "severity": "Severity", "deployedTo": "Deployed to", "enabled": "Enabled", "owner": "Owner" }, "allOrgs": "All orgs", "policiesCount_one": "{{count}} policy", "policiesCount_other": "{{count}} policies", "notDeployed": "Not deployed", "errors": { "fetch": "Failed to load monitors", "delete": "Failed to delete monitor" }, "deleteConfirm": "Delete monitor {{name}}? Its alert rule and response automation are removed too." },
  "editor": { "titleNew": "New monitor", "titleEdit": "Edit monitor", "sections": { "watch": "What to watch", "noise": "Severity & noise", "respond": "Respond", "notify": "Notify", "escalate": "Escalate to a human", "deployed": "Deployed to" }, "fields": { "name": "Name", "description": "Description", "kind": "Kind", "severity": "Severity", "cooldownMinutes": "Cooldown (minutes)", "autoResolve": "Auto-resolve when the condition clears", "deliveryMode": "Delivery", "channels": "Channels", "escalationPolicy": "Escalation policy", "recurrenceThreshold": "Escalate after", "recurrenceWindowDays": "episodes within (days)", "pauseResponses": "Pause automatic responses until a person resets", "aiAgent": "AI agent (enables AI triage responses)" }, "deliveryModes": { "inherit": "Use routing rules", "channels": "Routing rules plus these channels", "none": "Do not notify" }, "responsesHint": "Responses run on the device that breached, in order.", "recurrenceHint": "Counted in breach episodes: a new episode starts only after the condition recovered.", "ownerScope": { "legend": "Owner", "partner": "All organizations (partner-wide)", "organization": "This organization only" }, "actions": { "save": "Save monitor", "saving": "Saving…", "test": "Test on a device", "deploy": "Deploy to…", "delete": "Delete" }, "errors": { "load": "Failed to load monitor", "save": "Failed to save monitor", "test": "Test failed" }, "testResult": { "triggered": "Condition met on {{device}}", "notTriggered": "Condition not met on {{device}}" } },
  "kinds": { "cpu": "CPU usage", "memory": "Memory usage", "disk": "Disk usage", "offline": "Device offline", "event_log": "Event log", "patch_compliance": "Patch compliance", "service": "Service stopped", "process": "Process stopped", "process_resource": "Process resource", "cert_expiry": "Certificate expiry", "bandwidth": "Bandwidth", "disk_io": "Disk I/O", "network_errors": "Network errors" },
  "fields": { "operator": "Comparison", "value": "Value", "durationMinutes": "For at least (minutes)", "category": "Category", "level": "Level", "sourcePattern": "Source matches", "messagePattern": "Message matches", "countThreshold": "Occurrences", "windowMinutes": "Within (minutes)", "serviceName": "Service name", "processName": "Process name", "consecutiveFailures": "Consecutive failures", "resource": "Resource", "withinDays": "Expires within (days)", "direction": "Direction", "errorType": "Error direction", "interfaceName": "Interface (optional)" },
  "operators": { "gt": "greater than", "gte": "at least", "lt": "less than", "lte": "at most", "eq": "equal to", "neq": "not equal to" },
  "deploy": { "title": "Deploy monitor", "existingPolicy": "Attach to an existing configuration policy", "newPolicy": "Create a policy for", "levels": { "organization": "this organization", "site": "a site", "device_group": "a device group" }, "policyName": "Policy name", "attach": "Attach", "detachConfirm": "Detach from {{policy}}?", "errors": { "attach": "Failed to attach monitor", "detach": "Failed to detach monitor" } },
  "policyTab": { "title": "Monitors", "description": "Monitors attached to this policy. Disabled rows switch a monitor off for this policy's scope; overrides change thresholds for it.", "attachExisting": "Attach existing", "createNew": "Create monitor", "empty": "No monitors attached.", "columns": { "monitor": "Monitor", "kind": "Kind", "enabled": "Enabled", "overrides": "Overrides", "source": "Source" }, "inherited": "Inherited from parent", "overrideEditor": { "title": "Override for this policy", "clear": "Clear overrides" }, "save": "Save", "errors": { "save": "Failed to save monitors" } },
  "legacy": { "title": "Legacy alert rules", "description": "Standalone alert rules that are not managed by a monitor. Convert them to get responses, delivery and escalation in one place.", "empty": "No legacy rules.", "convert": "Convert to monitor", "converted": "Converted", "notConvertible": "This rule's conditions cannot be expressed as a single monitor.", "errors": { "fetch": "Failed to load alert rules", "convert": "Failed to convert rule" } },
  "managed": { "badge": "Managed by monitor", "readOnly": "This {{kind}} is generated from a monitor and cannot be edited here.", "open": "Open monitor" },
  "devices": { "title": "Devices", "columns": { "device": "Device", "enabled": "Enabled", "overrides": "Overrides", "source": "Source policy" }, "empty": "No devices are covered by this monitor yet." }
}
```

Translate every key for the other seven locales (same structure). Use the vocabulary already in each locale's `alerts.json` / `scripts.json` for severity, channel, and policy terms so the product reads consistently.

- [ ] **Step 3: Run** `pnpm --filter @breeze/web test --run src/components/monitoring/monitorKindFields.test.ts src/lib/i18n/localeParity.test.ts` → PASS. Commit: `git commit -m "feat(web): monitoring locale namespace + monitor kind field map (#5289)"`.

---

### Task 3: Monitors list at `/monitoring`; network page moves to `/monitoring/network`; strip gains Monitors and Legacy rules

**Files:**
- Create: `apps/web/src/components/monitoring/MonitorsListPage.tsx`, `MonitorsListPage.test.tsx`
- Create: `apps/web/src/pages/monitoring/network.astro` (renders the existing `MonitoringPage` with title "Monitoring")
- Modify: `apps/web/src/pages/monitoring/index.astro` (renders `MonitorsListPage`)
- Modify: `apps/web/src/components/monitoring/MonitoringTabStrip.tsx` (W01): `TABS` becomes `[{ href: '/monitoring', labelKey: 'monitors' }, { href: '/monitoring/network', labelKey: 'network' }, { href: '/monitoring/delivery', labelKey: 'delivery' }, { href: '/monitoring/rules', labelKey: 'legacyRules' }]`; labels move from `common:monitoringTabs.*` to `monitoring:hub.tabs.*` (delete the W01 `monitoringTabs` block from all 8 `common.json` files in the same commit); active resolution: longest matching prefix, with `/monitoring/monitors/*` mapping to `/monitoring`
- Modify: `apps/web/src/components/monitoring/MonitoringPage.tsx` (its strip `currentPath` becomes `/monitoring/network`)
- Modify: `apps/web/src/components/layout/Sidebar.tsx` `pathAliases` += `'/monitoring/network': '/monitoring', '/monitoring/rules': '/monitoring'` (prefix matching already covers `/monitoring/monitors/...`)
- Test: `MonitoringTabStrip.test.tsx` (update), `Sidebar.nav.test.tsx` (no change expected)

**Interfaces:**
- `MonitorsListPage` fetches `GET /monitors`, renders `ResponsiveTable` rows (name → `/monitoring/monitors/:id`, kind label from `monitoring:kinds.*`, severity, deployed-to count from `attachments.length` when the list payload includes it — if the API list omits attachments, show `—` and fetch counts lazily per row on hover is **not** allowed; ask the API plan owner to include `attachmentCount` in the list payload and assert it here), enabled toggle (`PATCH /monitors/:id { enabled }` via `runAction`), `ScopeBadge`-style "All orgs" chip when `partnerId` is set, delete via `ConfirmDialog` + `runAction`. "New monitor" → `/monitoring/monitors/new`.

- [ ] **Step 1: Failing tests** — list renders two rows from a mocked `fetchWithAuth('/monitors')`; "All orgs" chip only on the partner-wide row; delete calls `DELETE /monitors/:id` and refetches; strip marks `/monitoring/monitors/abc` as Monitors active.

- [ ] **Step 2: Implement; run** `pnpm --filter @breeze/web test --run src/components/monitoring src/components/layout src/lib/i18n` → PASS. Commit: `git commit -m "feat(web): Monitors list at /monitoring; network page at /monitoring/network (#5289)"`.

---

### Task 4: Monitor editor

**Files:**
- Create: `apps/web/src/components/monitoring/MonitorEditor.tsx`, `MonitorEditor.test.tsx`, `MonitorConditionFields.tsx`, `DeployMonitorDialog.tsx`, `DeployMonitorDialog.test.tsx`, `MonitorDevicesTable.tsx`
- Create: `apps/web/src/pages/monitoring/monitors/new.astro`, `apps/web/src/pages/monitoring/monitors/[id].astro` (pattern: `pages/settings/alert-templates/[id].astro`, passing `monitorId={id}`)

**Interfaces:**
- `MonitorEditor({ monitorId?: string })`. Form schema: `createMonitorDefinitionSchema` from `@breeze/shared` for create (with `ownerScope`), `updateMonitorDefinitionSchema` for edit; `zodResolver`. Loads `GET /monitors/kinds` once (for `overridableKeys` display and `agentDelivered` warning) and `GET /monitors/:id` in edit mode.
- Cards, in order, each a `<section>` with a heading from `monitoring:editor.sections.*`:
  1. **What to watch** — name, description, kind `<select>` (changing kind resets `condition` to `defaultConditionFor(kind)`), `MonitorConditionFields kind=… name="condition"` rendering from `MONITOR_KIND_FIELDS` (operator → `<select>` of `monitoring:operators.*`; number/text/select inputs with `register(\`condition.${key}\`, { valueAsNumber })`). When `agentDelivered` is true show a one-line hint that the service/process watch must exist in the policy's Service & Process Monitoring tab until W4.
  2. **Severity & noise** — severity select, cooldownMinutes, autoResolve toggle.
  3. **Respond** — `<ActionsEditor name="responses" compact allowAiTriage={!!watch('aiAgentId')} />` + hint `monitoring:editor.responsesHint`; AI agent select (`GET /ai-agents`, existing endpoint used by `AutomationForm`/agent pickers — reuse its component if one exists, else a plain select).
  4. **Notify** — deliveryMode radio (`inherit | channels | none`), channel checkboxes (`GET /alerts/channels`, same list shape `RoutingRuleForm` uses) shown when `channels`, escalation policy select (`GET /alerts/policies`).
  5. **Escalate to a human** — recurrenceThreshold (number ≥2), recurrenceWindowDays (number; the form stores days and submits `recurrenceWindowHours = days * 24`), `<ActionsEditor name="recurrenceActions" compact />`, pause toggle, hint `monitoring:editor.recurrenceHint`. All optional; empty = counter off.
  6. **Deployed to** (edit mode only) — attachments table (policy name → `/configuration-policies/:id`, enabled, overrides summary, detach button) + **Deploy to…** opens `DeployMonitorDialog`.
- Create-only `ownerScope` radio (copy `PolicyForm.tsx:86-117`; show when `useDefaultOwnerScope().isPartnerScope`), defaulting to `defaultOwnerScope`.
- Header actions: **Test on a device** (device picker → `POST /monitors/:id/test { deviceId }`; edit mode only; result toast from `monitoring:editor.testResult.*`), **Save** (`POST /monitors` → navigate to `/monitoring/monitors/:id`; `PATCH /monitors/:id`), **Delete** (`ConfirmDialog`).
- `DeployMonitorDialog({ monitorId, onDeployed })`: radio "existing policy" (select from `GET /configuration-policies?limit=200`) vs "create a policy for" (level select organization/site/device_group, target select from `/sites` / `/groups`, name defaulting to `Monitors — <target name>`), submits `POST /monitors/:id/attachments`.
- `MonitorDevicesTable({ monitorId })`: `GET /monitors/:id/devices` (W2 shape), rendered under the Deployed card as a collapsible "Devices" list.

- [ ] **Step 1: Failing tests** (`MonitorEditor.test.tsx`, mock `fetchWithAuth`):
  - create mode: choosing kind `disk` renders `operator`, `value`, `durationMinutes` fields with defaults; submitting posts a body whose `condition` equals `{ operator: 'gt', value: 90, durationMinutes: 5 }` and `ownerScope: 'organization'`;
  - setting recurrence threshold 3 and window 10 days submits `recurrenceWindowHours: 240`;
  - `ai_triage` option is absent until an AI agent is selected;
  - edit mode: loads `GET /monitors/m1`, shows the Deployed card with one attachment, detach calls `DELETE /monitors/m1/attachments/a1`.
  - `DeployMonitorDialog.test.tsx`: existing-policy path posts `{ configPolicyId }`; create path posts `{ createPolicyFor: { level: 'site', targetId, name } }`.

- [ ] **Step 2: Implement; run** `pnpm --filter @breeze/web test --run src/components/monitoring` → PASS. Commit: `git commit -m "feat(web): monitor editor with deploy dialog (#5289)"`.

---

### Task 5: Config-policy `Monitors` tab

**Files:**
- Create: `apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.tsx`, `MonitorsTab.test.tsx` (copy the `useFeatureLink` mock preamble from `VulnerabilityTab.test.tsx:1-30`)
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/types.ts:55-79` `FEATURE_META` += `monitors: { label: 'Monitors', fetchUrl: '/monitors', description: 'Monitors attached to this policy: condition, response, delivery and escalation in one object' }` (insert after `alert_rule` so the tab order reads Alerts → Monitors)
- Modify: `apps/web/src/components/configurationPolicies/ConfigPolicyDetailPage.tsx:108-128` (`featureTabIcons.monitors = <Radar className="h-4 w-4" />`), `:418-446` (`case 'monitors': return <MonitorsTab {...props} />;`)
- Modify: `packages/shared` `ConfigFeatureType` already includes `'monitors'` from the API plan; the web `FeatureType` derives from it (`types.ts:18`), so the exhaustive `featureTabIcons` record fails to compile until the icon is added — that is the intended tripwire.

**Interfaces:** `MonitorsTab(props: FeatureTabProps)`. State = `items: { monitorId, enabled, overrides, sortOrder }[]` seeded from `existingLink?.inlineSettings.items`; rows joined with `GET /monitors` for name/kind/`overridableKeys` (from `GET /monitors/kinds`). Parent-link rows (`props.parentLink?.inlineSettings.items`) are shown with the `inherited` badge and an **Override here** action that copies the row into `items` with `enabled: false` or opens the override editor. Save → `save(existingLink?.id ?? null, { featureType: 'monitors', featurePolicyId: null, inlineSettings: { items } })` then `onLinkChanged(result, 'monitors')`. Empty `items` → `remove(existingLink.id)` then `onLinkChanged(null, 'monitors')`.

- [ ] **Step 1: Failing tests** — attach existing monitor from the picker and save → `saveMock` called with `inlineSettings.items[0] = { monitorId: 'm1', enabled: true, overrides: undefined, sortOrder: 0 }`; toggle enabled off and set override `value: 95` → saved payload reflects both; a parent-link row renders with the inherited badge and is not in `items` until overridden.

- [ ] **Step 2: Implement; run** `pnpm --filter @breeze/web test --run src/components/configurationPolicies` → PASS (the existing `ConfigPolicyDetailPage` tests must still pass with the new tab in the list). Commit: `git commit -m "feat(web): config-policy Monitors tab (#5289)"`.

---

### Task 6: Legacy rules tab with Convert to monitor

**Files:**
- Create: `apps/web/src/components/monitoring/LegacyRulesPage.tsx`, `LegacyRulesPage.test.tsx`
- Create: `apps/web/src/pages/monitoring/rules.astro`
- Modify: `apps/web/src/components/alerts/AlertsTabStrip.tsx:9` — the `rules` tab href becomes `/monitoring/rules` (it currently points at `/alerts/rules`, which 301s to `/configuration-policies`); update `AlertsTabStrip.test.tsx` accordingly

**Interfaces:** lists `GET /alerts/rules` filtered client-side to `managedByMonitorId == null`; columns name, template, target (`targetType/targetId`), owner chip, active; row action **Convert to monitor** → `POST /alerts/rules/:id/convert-to-monitor` via `runAction`; `201` → `navigateTo('/monitoring/monitors/<monitorId>')`; `409 RULE_NOT_CONVERTIBLE` → inline message `monitoring:legacy.notConvertible` on that row (this is a partial-success style handler, so it is a legitimate `runActionAllowlist.ts` entry only if `runAction` cannot express it — prefer `runAction` with a custom `onError`). Converted rules (`overrideSettings.convertedToMonitorId`) show the `converted` badge and no action.

- [ ] **Step 1: Failing tests** — two rules render, one managed rule is hidden; convert posts to the right path and navigates; 409 shows the not-convertible message.

- [ ] **Step 2: Implement; run** `pnpm --filter @breeze/web test --run src/components/monitoring/LegacyRulesPage.test.tsx src/components/alerts/AlertsTabStrip.test.tsx` → PASS. Commit: `git commit -m "feat(web): legacy alert rules tab with convert-to-monitor (#5289)"`.

---

### Task 7: Managed rows are read-only everywhere else

**Files:**
- Modify: `apps/web/src/components/automations/AutomationsPage.tsx` (filter out `managedByMonitorId` rows from the Jobs list), `AutomationList.tsx:36` (`Automation` type += `managedByMonitorId?: string | null`), `AutomationEditPage.tsx` (when the loaded automation has `managedByMonitorId`, render a read-only banner `monitoring:managed.readOnly` with `monitoring:managed.open` link to `/monitoring/monitors/:id` instead of the form)
- Modify: `apps/web/src/components/alerts/AlertTemplateList.tsx:90` (scope/badge cell: when `managedByMonitorId`, show `monitoring:managed.badge` and disable edit/delete like built-ins), `AlertTemplateEditor.tsx` (same banner as automations)
- Modify: `apps/web/src/components/alerts/AlertDetails.tsx` — when `alert.monitorId` is present, show a "Monitor" row linking to `/monitoring/monitors/:id`
- Test: `AutomationsPage.managed.test.tsx` (extend: a managed-by-monitor automation is not listed), `AutomationEditPage.test.tsx` (extend: banner instead of form), `AlertTemplateList.test.tsx` (extend)

- [ ] **Step 1: Failing tests; Step 2: implement; Step 3: run** `pnpm --filter @breeze/web test --run src/components/automations src/components/alerts` → PASS. Commit: `git commit -m "feat(web): monitor-managed automations, templates and alerts link back to their monitor (#5289)"`.

---

### Task 8: AI / MCP tools

**Files:**
- Create: `apps/api/src/services/aiToolsMonitors.ts`, `aiToolsMonitors.test.ts`
- Modify: `apps/api/src/services/aiTools.ts:274` area — `registerMonitorTools(aiTools);`
- Docs: `apps/docs/src/content/docs/features/mcp-server.mdx` (tool table)

**Interfaces** (follow `registerFleetTools` at `aiToolsFleet.ts:441-460` for `registerTool`/`safeHandler` shape and `pgErrorCode` mapping):

| tool | tier | input | behaviour |
|---|---|---|---|
| `list_monitors` | 1 | `{ kind?, enabled?, limit? }` | `listMonitorDefinitions(auth, filters)`; returns id, name, kind, severity, enabled, ownerScope, attachmentCount |
| `get_monitor` | 1 | `{ monitorId }` | definition + attachments + compiled ids + `GET /monitors/:id/devices` resolution summary |
| `manage_monitors` | 3 | `{ action: 'create' \| 'update' \| 'delete' \| 'enable' \| 'disable' \| 'attach' \| 'detach', monitorId?, definition?, configPolicyId?, attachmentId? }` | calls the Task-4/8 service functions; `create` requires the full `createMonitorDefinitionSchema` body; partner-wide only when `canManagePartnerWidePolicies(auth)` |

Also add the read-only guard to `manage_automations` (`aiToolsFleet.ts:1614-1641`) for `enable`/`disable`/`run` on `managedByMonitorId` rows if the API plan did not already (it should have — verify, do not duplicate).

- [ ] **Step 1: Failing tests** — `list_monitors` returns the mocked rows; `manage_monitors` `create` with an org-scoped auth and `ownerScope: 'partner'` returns `{ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }`; `manage_monitors` is registered with `tier: 3`.

- [ ] **Step 2: Implement; run** `cd apps/api && npx vitest run src/services/aiToolsMonitors.test.ts src/services/aiTools.test.ts` (the registry test that counts/validates tools, if present) → PASS. Commit: `git commit -m "feat(ai): list_monitors / get_monitor / manage_monitors tools (#5289)"`.

---

### Task 9: Docs

**Files:**
- Create: `apps/docs/src/content/docs/features/monitors.mdx` — what a monitor is, the six cards, deploying through policies (cumulative inheritance with disable/override), delivery modes, the recurrence counter (episodes; pause until reset), converting legacy rules, what is read-only and why. Link from `features/alerts.mdx`, `features/automations.mdx` ("responses that used to be alert-triggered automations are now authored on the monitor; existing ones keep working as event rules under Jobs"), `features/configuration-policies.mdx` (Monitors tab), `features/service-monitoring.mdx` (service/process kinds evaluate through monitors; the watch still comes from this tab until W4).
- Modify: `apps/docs/astro.config.mjs` sidebar — add `{ slug: 'features/monitors' }` next to `features/alerts`.
- Update the release-notes source per the `update-breeze-release-notes` skill conventions only if that skill says the current cycle is open; otherwise leave notes to the release run.

- [ ] **Step 1: Write; Step 2:** `pnpm --filter @breeze/docs build` → no broken links. Commit: `git commit -m "docs: Monitors feature page + cross-links (#5289)"`.

---

### Task 10: Verification and PR

- [ ] **Step 1:**

```bash
pnpm --filter @breeze/web lint
pnpm --filter @breeze/web test --run src/components/monitoring src/components/automations src/components/alerts src/components/configurationPolicies src/components/layout src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts
pnpm --filter @breeze/web build
pnpm --filter @breeze/api exec tsc --noEmit && cd apps/api && npx vitest run src/services/aiToolsMonitors.test.ts
```

- [ ] **Step 2: Browser walk on a local stack** (`worktree-stack` skill): create a disk monitor with a run_script response and channel delivery → deploy to a site policy → open the policy's Monitors tab and disable it → `/monitoring` shows "1 policy" → Jobs does not list the managed automation → `/settings/alert-templates` shows the managed template as read-only → convert a legacy rule → `/monitoring/network` still works → sidebar highlights Monitoring on every `/monitoring/*` path.

- [ ] **Step 3: PR** — title `feat(web): W02 Monitors UI, policy tab, legacy conversion, MCP tools (#5287)`; body per task, spec path, `Closes #5289`. Run `/pr-review-toolkit:review-pr`; fix confirmed findings inline; `gh pr merge <N> --squash` on green; then `complete_wave` W02 and write the W03 plan from spec §Evaluation and recurrence.
