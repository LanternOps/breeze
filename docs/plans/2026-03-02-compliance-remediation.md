# Compliance Remediation Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade compliance rule remediation from a raw UUID text field to per-rule remediation with searchable script and software deployment pickers, rule descriptions, smart defaults, and drag-to-reorder.

**Architecture:** Each compliance rule gets an optional `remediation` object (`script` | `software_deploy` | `none`) stored in the `rules` JSONB. Two new picker modal components fetch from existing `/scripts` and `/software/catalog` APIs. The backend decompose/assemble and evaluation logic are updated to handle per-rule remediation. The rule-set-level `remediationScriptId` DB column remains for backward compat but the frontend stops using it.

**Tech Stack:** React (frontend components), Hono API (backend services), existing `/scripts` and `/software/catalog` endpoints, native HTML drag/drop.

---

### Task 1: Create RemediationScriptPicker Modal

**Files:**
- Create: `apps/web/src/components/configurationPolicies/featureTabs/RemediationScriptPicker.tsx`

**Step 1: Create the component file**

Adapt from existing `apps/web/src/components/devices/ScriptPickerModal.tsx` (lines 1-248). Key differences from the device script picker:
- No `runAs` selection (remediation always runs as system)
- No `deviceHostname` display
- Callback returns `{ id, name, language, osTypes }` only (no runAs)
- Same search, category filter, and OS filter UX

```tsx
import { useState, useMemo, useEffect } from 'react';
import { X, Search, Loader2, FileCode } from 'lucide-react';
import { fetchWithAuth } from '../../../stores/auth';

type ScriptLanguage = 'powershell' | 'bash' | 'python' | 'cmd';
type OSType = 'windows' | 'macos' | 'linux';

export type SelectedScript = {
  id: string;
  name: string;
  language: ScriptLanguage;
  osTypes: OSType[];
};

type RemediationScriptPickerProps = {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (script: SelectedScript) => void;
};

const languageConfig: Record<ScriptLanguage, { label: string; color: string; icon: string }> = {
  powershell: { label: 'PowerShell', color: 'bg-blue-500/20 text-blue-700', icon: 'PS' },
  bash: { label: 'Bash', color: 'bg-green-500/20 text-green-700', icon: '$' },
  python: { label: 'Python', color: 'bg-yellow-500/20 text-yellow-700', icon: 'Py' },
  cmd: { label: 'CMD', color: 'bg-gray-500/20 text-gray-700', icon: '>' },
};

export default function RemediationScriptPicker({ isOpen, onClose, onSelect }: RemediationScriptPickerProps) {
  // State: scripts[], loading, error, query, categoryFilter
  // Fetch from GET /scripts on open
  // Filter by query + category
  // Render same layout as ScriptPickerModal but without runAs selector
  // On click: onSelect({ id, name, language, osTypes }), onClose()
}
```

Follow the exact same structure as `ScriptPickerModal.tsx`:
- `useEffect` on `isOpen` to fetch scripts via `fetchWithAuth('/scripts')`
- Transform response `data` array into `SelectedScript[]`
- `useMemo` for categories and filtered scripts
- Modal with header, search+category filters, scrollable list, footer with count+cancel
- Each script row shows language badge, name, description, category pill, OS types

**Step 2: Verify the component renders**

Import it in ComplianceTab temporarily and render with `isOpen={true}` to confirm it loads scripts. Then remove the temporary render.

**Step 3: Commit**

```bash
git add apps/web/src/components/configurationPolicies/featureTabs/RemediationScriptPicker.tsx
git commit -m "feat(compliance): add RemediationScriptPicker modal component"
```

---

### Task 2: Create SoftwareCatalogPicker Modal

**Files:**
- Create: `apps/web/src/components/configurationPolicies/featureTabs/SoftwareCatalogPicker.tsx`

**Step 1: Create the component file**

Similar pattern to RemediationScriptPicker. Fetches from `GET /software/catalog` (mounted at `/software/catalog` in `apps/api/src/index.ts:640`).

```tsx
import { useState, useMemo, useEffect } from 'react';
import { X, Search, Loader2, Package } from 'lucide-react';
import { fetchWithAuth } from '../../../stores/auth';

export type SelectedSoftware = {
  catalogId: string;
  catalogName: string;
  vendor?: string;
  versionId?: string;
  versionLabel?: string;
};

type SoftwareCatalogPickerProps = {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (software: SelectedSoftware) => void;
};
```

The component should:
1. Fetch catalog list from `GET /software/catalog?limit=100` via `fetchWithAuth`
2. Response shape: `{ data: CatalogItem[], pagination }` where each item has `id, name, vendor, category, description, isManaged`
3. Show search input + category filter (categories from `apps/api/src/routes/software.ts:62-65`: browser, utility, compression, productivity, communication, developer, media, security)
4. Each row shows: name, vendor badge, category pill, managed badge
5. After selecting a catalog item, fetch its versions from `GET /software/catalog/${id}/versions` (if versions exist, show a secondary step to pick version or "Latest")
6. On select: call `onSelect({ catalogId, catalogName, vendor, versionId?, versionLabel? })` then `onClose()`

Two-step selection flow:
- Step 1: Pick catalog entry (list view)
- Step 2: Pick version (shown inline below selection, or "Latest" default)

**Step 2: Verify the component renders**

Same as Task 1 — temporary import to confirm it fetches and displays catalog items.

**Step 3: Commit**

```bash
git add apps/web/src/components/configurationPolicies/featureTabs/SoftwareCatalogPicker.tsx
git commit -m "feat(compliance): add SoftwareCatalogPicker modal component"
```

---

### Task 3: Update ComplianceTab Types and Data Model

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/ComplianceTab.tsx` (lines 8-43)

**Step 1: Update the type definitions**

Replace the existing types at lines 8-43 with the new per-rule remediation model:

```tsx
// Line 8-27: Update ComplianceRule type
type ComplianceRule = {
  type: RuleType;
  description?: string;  // NEW: optional notes (e.g. "SOC2 3.1.a")
  // Existing type-specific fields unchanged:
  softwareName?: string;
  softwareVersion?: string;
  versionOperator?: string;
  prohibitedName?: string;
  minGb?: number;
  diskPath?: string;
  osType?: string;
  minOsVersion?: string;
  registryPath?: string;
  registryValueName?: string;
  registryExpectedValue?: string;
  configFilePath?: string;
  configKey?: string;
  configExpectedValue?: string;
  // NEW: per-rule remediation
  remediation?: RemediationAction;
};

// NEW type: Add before ComplianceRule
type RemediationAction =
  | { type: 'script'; scriptId: string; scriptName?: string }
  | { type: 'software_deploy'; catalogId: string; versionId?: string; catalogName?: string }
  | { type: 'none' };
```

Update `ComplianceItem` (lines 29-35) — remove `remediationScriptId`:

```tsx
type ComplianceItem = {
  name: string;
  rules: ComplianceRule[];
  enforcementLevel: EnforcementLevel;
  checkIntervalMinutes: number;
  // remediationScriptId REMOVED — now per-rule
};
```

Update `defaultItem` (lines 37-43) — remove `remediationScriptId`, add default remediation:

```tsx
const defaultItem: ComplianceItem = {
  name: '',
  rules: [{ type: 'required_software', softwareName: '', softwareVersion: '', versionOperator: 'gte' }],
  enforcementLevel: 'monitor',
  checkIntervalMinutes: 60,
};
```

**Step 2: Add smart default helper**

Add after the `osTypes` const (line 67):

```tsx
function defaultRemediationType(ruleType: RuleType): RemediationAction['type'] {
  switch (ruleType) {
    case 'required_software': return 'software_deploy';
    case 'prohibited_software':
    case 'registry_check':
    case 'config_check':
      return 'script';
    default:
      return 'none';
  }
}
```

**Step 3: Update addRule to apply smart default**

In the `addRule` function (line 131-138), change the new rule creation to include a default remediation:

```tsx
const addRule = (itemIndex: number) => {
  setItems((prev) =>
    prev.map((item, i) => {
      if (i !== itemIndex) return item;
      const newType: RuleType = 'required_software';
      return {
        ...item,
        rules: [
          ...item.rules,
          {
            type: newType,
            softwareName: '',
            softwareVersion: '',
            versionOperator: 'gte',
            remediation: { type: defaultRemediationType(newType) } as RemediationAction,
          },
        ],
      };
    })
  );
};
```

**Step 4: Commit**

```bash
git add apps/web/src/components/configurationPolicies/featureTabs/ComplianceTab.tsx
git commit -m "feat(compliance): update types for per-rule remediation model"
```

---

### Task 4: Add Per-Rule Remediation UI to ComplianceTab

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/ComplianceTab.tsx`

**Step 1: Add imports for the new pickers**

At the top of the file (after line 6), add:

```tsx
import RemediationScriptPicker, { type SelectedScript } from './RemediationScriptPicker';
import SoftwareCatalogPicker, { type SelectedSoftware } from './SoftwareCatalogPicker';
import { FileCode, Package, GripVertical } from 'lucide-react';
```

Update the existing lucide import to remove any duplicates.

**Step 2: Add picker state**

Inside the component (after line 104), add state for which picker is open:

```tsx
const [scriptPickerRule, setScriptPickerRule] = useState<{ itemIndex: number; ruleIndex: number } | null>(null);
const [softwarePickerRule, setSoftwarePickerRule] = useState<{ itemIndex: number; ruleIndex: number } | null>(null);
```

**Step 3: Add remediation handler functions**

After the `removeRule` function (line 147), add:

```tsx
const updateRemediation = (itemIndex: number, ruleIndex: number, remediation: RemediationAction) => {
  updateRule(itemIndex, ruleIndex, { remediation });
};

const handleScriptSelected = (script: SelectedScript) => {
  if (!scriptPickerRule) return;
  updateRemediation(scriptPickerRule.itemIndex, scriptPickerRule.ruleIndex, {
    type: 'script',
    scriptId: script.id,
    scriptName: script.name,
  });
  setScriptPickerRule(null);
};

const handleSoftwareSelected = (software: SelectedSoftware) => {
  if (!softwarePickerRule) return;
  updateRemediation(softwarePickerRule.itemIndex, softwarePickerRule.ruleIndex, {
    type: 'software_deploy',
    catalogId: software.catalogId,
    catalogName: software.catalogName,
    versionId: software.versionId,
  });
  setSoftwarePickerRule(null);
};
```

**Step 4: Add description field to each rule card**

Inside the rule card `<div>` (after the rule type selector at line 313, before the type-specific fields), add:

```tsx
<div>
  <label className="text-xs font-medium text-muted-foreground">Description (optional)</label>
  <input
    value={rule.description ?? ''}
    onChange={(e) => updateRule(index, ri, { description: e.target.value })}
    placeholder="e.g. SOC2 requirement 3.1.a"
    className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-sm"
  />
</div>
```

**Step 5: Add per-rule remediation section**

After all the type-specific fields (after line 401, before the rule delete button), add a remediation section:

```tsx
{/* Per-rule remediation */}
<div className="mt-3 border-t pt-3">
  <label className="text-xs font-medium text-muted-foreground">Remediation Action</label>
  <div className="mt-1.5 flex gap-2">
    {(['none', 'script', 'software_deploy'] as const).map((rt) => (
      <label
        key={rt}
        className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition ${
          (rule.remediation?.type ?? 'none') === rt
            ? 'border-primary/40 bg-primary/10 text-primary'
            : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        <input
          type="radio"
          name={`remediation-${index}-${ri}`}
          value={rt}
          checked={(rule.remediation?.type ?? 'none') === rt}
          onChange={() => updateRemediation(index, ri, { type: rt } as RemediationAction)}
          className="hidden"
        />
        {rt === 'none' && 'None'}
        {rt === 'script' && <><FileCode className="h-3 w-3" /> Run Script</>}
        {rt === 'software_deploy' && <><Package className="h-3 w-3" /> Deploy Software</>}
      </label>
    ))}
  </div>

  {/* Selected script display */}
  {rule.remediation?.type === 'script' && (
    <div className="mt-2">
      {rule.remediation.scriptName ? (
        <div className="flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2">
          <FileCode className="h-4 w-4 text-muted-foreground" />
          <span className="flex-1 text-sm">{rule.remediation.scriptName}</span>
          <button
            type="button"
            onClick={() => setScriptPickerRule({ itemIndex: index, ruleIndex: ri })}
            className="text-xs text-primary hover:underline"
          >
            Change
          </button>
          <button
            type="button"
            onClick={() => updateRemediation(index, ri, { type: 'none' })}
            className="text-xs text-muted-foreground hover:text-destructive"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setScriptPickerRule({ itemIndex: index, ruleIndex: ri })}
          className="w-full rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground hover:border-primary/40 hover:text-foreground"
        >
          Select a remediation script...
        </button>
      )}
    </div>
  )}

  {/* Selected software display */}
  {rule.remediation?.type === 'software_deploy' && (
    <div className="mt-2">
      {rule.remediation.catalogName ? (
        <div className="flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2">
          <Package className="h-4 w-4 text-muted-foreground" />
          <span className="flex-1 text-sm">{rule.remediation.catalogName}</span>
          <button
            type="button"
            onClick={() => setSoftwarePickerRule({ itemIndex: index, ruleIndex: ri })}
            className="text-xs text-primary hover:underline"
          >
            Change
          </button>
          <button
            type="button"
            onClick={() => updateRemediation(index, ri, { type: 'none' })}
            className="text-xs text-muted-foreground hover:text-destructive"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setSoftwarePickerRule({ itemIndex: index, ruleIndex: ri })}
          className="w-full rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground hover:border-primary/40 hover:text-foreground"
        >
          Select software to deploy...
        </button>
      )}
    </div>
  )}
</div>
```

**Step 6: Remove old rule-set-level remediation field**

Delete lines 457-466 (the "Remediation Script ID (optional)" input and its grid wrapper). The check interval field should now take full width:

```tsx
<div>
  <label className="text-xs font-medium text-muted-foreground">Check Interval (minutes)</label>
  <input
    type="number"
    min={5}
    max={1440}
    value={item.checkIntervalMinutes}
    onChange={(e) => updateItem(index, { checkIntervalMinutes: Number(e.target.value) || 60 })}
    className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
  />
</div>
```

**Step 7: Add picker modals before the closing `</FeatureTabShell>`**

Just before `</FeatureTabShell>` (line 474), add:

```tsx
<RemediationScriptPicker
  isOpen={!!scriptPickerRule}
  onClose={() => setScriptPickerRule(null)}
  onSelect={handleScriptSelected}
/>
<SoftwareCatalogPicker
  isOpen={!!softwarePickerRule}
  onClose={() => setSoftwarePickerRule(null)}
  onSelect={handleSoftwareSelected}
/>
```

**Step 8: Commit**

```bash
git add apps/web/src/components/configurationPolicies/featureTabs/ComplianceTab.tsx
git commit -m "feat(compliance): add per-rule remediation UI with script and software pickers"
```

---

### Task 5: Add Drag-to-Reorder Rules

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/ComplianceTab.tsx`

**Step 1: Add drag state**

Inside the component, add:

```tsx
const [dragIndex, setDragIndex] = useState<{ item: number; rule: number } | null>(null);
const [dragOverIndex, setDragOverIndex] = useState<{ item: number; rule: number } | null>(null);
```

**Step 2: Add drag handler functions**

```tsx
const handleDragStart = (itemIndex: number, ruleIndex: number) => {
  setDragIndex({ item: itemIndex, rule: ruleIndex });
};

const handleDragOver = (e: React.DragEvent, itemIndex: number, ruleIndex: number) => {
  e.preventDefault();
  if (dragIndex && dragIndex.item === itemIndex) {
    setDragOverIndex({ item: itemIndex, rule: ruleIndex });
  }
};

const handleDrop = (itemIndex: number, ruleIndex: number) => {
  if (!dragIndex || dragIndex.item !== itemIndex) return;
  const fromIdx = dragIndex.rule;
  const toIdx = ruleIndex;
  if (fromIdx === toIdx) return;

  setItems((prev) =>
    prev.map((item, i) => {
      if (i !== itemIndex) return item;
      const rules = [...item.rules];
      const [moved] = rules.splice(fromIdx, 1);
      rules.splice(toIdx, 0, moved);
      return { ...item, rules };
    })
  );
  setDragIndex(null);
  setDragOverIndex(null);
};

const handleDragEnd = () => {
  setDragIndex(null);
  setDragOverIndex(null);
};
```

**Step 3: Add drag handle and drag attributes to each rule card**

In the rule card div (around line 301), update the outer `<div>` for each rule to include drag attributes:

```tsx
<div
  key={ri}
  draggable
  onDragStart={() => handleDragStart(index, ri)}
  onDragOver={(e) => handleDragOver(e, index, ri)}
  onDrop={() => handleDrop(index, ri)}
  onDragEnd={handleDragEnd}
  className={`rounded-md border bg-muted/20 p-3 ${
    dragOverIndex?.item === index && dragOverIndex?.rule === ri ? 'border-primary/40' : ''
  }`}
>
  <div className="flex items-start gap-2">
    <div className="mt-1 cursor-grab text-muted-foreground active:cursor-grabbing">
      <GripVertical className="h-4 w-4" />
    </div>
    <div className="flex-1 space-y-2">
      {/* existing rule content */}
    </div>
    {/* existing delete button */}
  </div>
</div>
```

**Step 4: Commit**

```bash
git add apps/web/src/components/configurationPolicies/featureTabs/ComplianceTab.tsx
git commit -m "feat(compliance): add drag-to-reorder rules within rule sets"
```

---

### Task 6: Update Backend Decompose/Assemble for Per-Rule Remediation

**Files:**
- Modify: `apps/api/src/services/configurationPolicy.ts` (lines 261-279, 438-455)

**Step 1: Update the decompose function**

At line 261-279, the decompose case for `compliance` currently reads `item.remediationScriptId` and stores it in the column. Now it should also preserve per-rule remediation data in the `rules` JSONB.

The `rules` JSONB already stores the rule array as-is — so per-rule `remediation` objects inside each rule are already persisted via `rules: item.rules ?? {}`. No decompose change needed for the remediation data itself.

However, for backward compat, extract a `remediationScriptId` from the first rule's script remediation if present:

```typescript
case 'compliance': {
  const items = Array.isArray(s.items) ? s.items : [];
  if (items.length > 0) {
    const VALID_ENFORCEMENT = ['monitor', 'warn', 'enforce'] as const;
    type Enforcement = (typeof VALID_ENFORCEMENT)[number];
    await tx.insert(configPolicyComplianceRules).values(
      items.map((item: Record<string, unknown>, idx: number) => {
        // Extract remediationScriptId from per-rule remediation for backward compat
        let scriptId: string | null = null;
        if (typeof item.remediationScriptId === 'string') {
          scriptId = item.remediationScriptId;
        } else if (Array.isArray(item.rules)) {
          const firstScript = (item.rules as Record<string, unknown>[]).find(
            (r) => (r.remediation as Record<string, unknown>)?.type === 'script'
          );
          if (firstScript) {
            const rem = firstScript.remediation as Record<string, unknown>;
            if (typeof rem?.scriptId === 'string') scriptId = rem.scriptId;
          }
        }
        return {
          featureLinkId: linkId,
          name: String(item.name ?? `Compliance Rule ${idx + 1}`),
          rules: item.rules ?? {},
          enforcementLevel: (VALID_ENFORCEMENT.includes(item.enforcementLevel as Enforcement) ? item.enforcementLevel : 'monitor') as Enforcement,
          checkIntervalMinutes: typeof item.checkIntervalMinutes === 'number' ? item.checkIntervalMinutes : 60,
          remediationScriptId: scriptId,
          sortOrder: typeof item.sortOrder === 'number' ? item.sortOrder : idx,
        };
      })
    );
  }
  break;
}
```

**Step 2: Update the assemble function**

At lines 438-455, no change needed — the `rules` JSONB field already contains the per-rule remediation objects. The assemble function returns `rules: r.rules` which includes the full rule array with remediation data.

**Step 3: Commit**

```bash
git add apps/api/src/services/configurationPolicy.ts
git commit -m "feat(compliance): update decompose to extract scriptId from per-rule remediation"
```

---

### Task 7: Update Policy Evaluation to Use Per-Rule Remediation

**Files:**
- Modify: `apps/api/src/services/policyEvaluationService.ts` (around lines 1623-1634)

**Step 1: Update the remediation trigger logic**

The current code at lines 1623-1634 checks `complianceRule.remediationScriptId` (a column on the rule set row). Now we need to also check per-rule remediation data from the `rules` JSONB.

Find the evaluation loop where individual rules are checked (around line 1580-1620). After each rule evaluation, if the rule is non-compliant and has a `remediation` object, trigger the appropriate action.

The key change is at lines 1623-1634. Replace with:

```typescript
// Trigger remediation if enforcement is 'enforce'
let remediationTriggered = false;
if (status === 'non_compliant' && complianceRule.enforcementLevel === 'enforce') {
  // Check per-rule remediation first (from rules JSONB)
  const rulesArray = Array.isArray(complianceRule.rules) ? complianceRule.rules as Record<string, unknown>[] : [];
  const failedRulesWithRemediation = rulesArray.filter((r) => {
    const rem = r.remediation as Record<string, unknown> | undefined;
    return rem && rem.type !== 'none';
  });

  for (const failedRule of failedRulesWithRemediation) {
    const rem = failedRule.remediation as Record<string, unknown>;
    if (rem.type === 'script' && typeof rem.scriptId === 'string') {
      // Use existing triggerConfigPolicyRemediation with the scriptId
      const tempRule = { ...complianceRule, remediationScriptId: rem.scriptId as string };
      const triggered = await triggerConfigPolicyRemediation(tempRule, targetDevice);
      if (triggered) remediationTriggered = true;
    }
    // software_deploy remediation: create a software deployment (future enhancement)
    // For now, log it as a pending remediation action
    if (rem.type === 'software_deploy' && typeof rem.catalogId === 'string') {
      console.log(`[ConfigPolicyCompliance] Software deploy remediation for catalogId=${rem.catalogId} on device=${device.id} — not yet implemented`);
    }
  }

  // Fallback: check legacy remediationScriptId on the rule set
  if (!remediationTriggered && complianceRule.remediationScriptId) {
    remediationTriggered = await triggerConfigPolicyRemediation(complianceRule, targetDevice);
  }
}
```

**Step 2: Commit**

```bash
git add apps/api/src/services/policyEvaluationService.ts
git commit -m "feat(compliance): support per-rule remediation in policy evaluation"
```

---

### Task 8: Migration of Existing Data (Backward Compat)

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/ComplianceTab.tsx` (the `loadItems` function)

**Step 1: Update loadItems to migrate legacy remediationScriptId**

In the `loadItems` function (lines 69-81), add migration logic that converts a rule-set-level `remediationScriptId` into per-rule remediation on the first rule:

```tsx
function loadItems(existingLink: FeatureTabProps['existingLink']): ComplianceItem[] {
  const raw = existingLink?.inlineSettings as Record<string, unknown> | null | undefined;
  if (!raw) return [];
  if (Array.isArray((raw as any).items)) {
    const items = (raw as any).items as (ComplianceItem & { remediationScriptId?: string })[];
    // Migrate legacy remediationScriptId to per-rule remediation
    return items.map((item) => {
      if (item.remediationScriptId && item.rules.length > 0) {
        const hasAnyRemediation = item.rules.some((r) => r.remediation && r.remediation.type !== 'none');
        if (!hasAnyRemediation) {
          const rules = [...item.rules];
          rules[0] = {
            ...rules[0],
            remediation: { type: 'script', scriptId: item.remediationScriptId },
          };
          const { remediationScriptId: _, ...rest } = item;
          return { ...rest, rules };
        }
      }
      const { remediationScriptId: _, ...rest } = item;
      return rest;
    });
  }
  // Legacy single-item format — wrap it
  if ((raw as any).rules) {
    const legacy = raw as unknown as Omit<ComplianceItem, 'name'> & { remediationScriptId?: string };
    const { remediationScriptId: _, ...rest } = legacy;
    return [{ ...rest, name: 'Compliance Rule Set 1' }];
  }
  return [];
}
```

**Step 2: Commit**

```bash
git add apps/web/src/components/configurationPolicies/featureTabs/ComplianceTab.tsx
git commit -m "feat(compliance): migrate legacy remediationScriptId to per-rule remediation on load"
```

---

### Task 9: Final Integration Testing

**Step 1: Start dev server**

```bash
pnpm dev
```

**Step 2: Manual verification checklist**

Navigate to Configuration Policies > select/create a policy > Compliance tab:

1. Verify rule sets load correctly (no regression)
2. Add a new rule — confirm smart default remediation type appears
3. Click "Run Script" radio — click "Select a remediation script..." — verify modal opens with scripts list
4. Select a script — verify it appears as a pill with name
5. Click "Deploy Software" radio — click "Select software..." — verify modal opens with catalog
6. Select software — verify it appears as a pill with name
7. Add a description to a rule — verify it saves and reloads
8. Drag a rule to reorder — verify the order updates
9. Save the compliance rule set — verify no errors
10. Reload the page — verify all selections persist (script names, software names, descriptions, order)
11. Test backward compat: if any existing compliance rules had a `remediationScriptId`, verify it migrates to per-rule format

**Step 3: Commit final state**

```bash
git add -A
git commit -m "feat(compliance): complete per-rule remediation with script and software pickers"
```
