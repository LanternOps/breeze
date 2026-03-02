# Compliance Remediation Improvements Design

## Problem
The compliance feature's remediation is limited to a single raw UUID text field for a script ID per rule set. Users cannot browse/select scripts or software deployments, and remediation is not granular to individual rules.

## Design

### Per-Rule Remediation Model
Each compliance rule gets an optional `remediation` object instead of a single rule-set-level `remediationScriptId`:

```typescript
type RemediationAction =
  | { type: 'script'; scriptId: string; scriptName?: string }
  | { type: 'software_deploy'; catalogId: string; versionId?: string; catalogName?: string }
  | { type: 'none' };
```

This lives in the `rules` JSONB column — no schema migration needed. The existing `remediationScriptId` column stays but becomes unused by new code.

### Per-Rule Description Field
Each rule gets an optional `description` string for context (e.g. "SOC2 requirement 3.1.a").

### Smart Defaults
When a rule is created, auto-suggest the remediation type:
- `required_software` → `software_deploy`
- `prohibited_software` → `script`
- `registry_check` → `script`
- `config_check` → `script`
- `disk_space_minimum` → `none`
- `os_version` → `none`

### Searchable Picker Modals
- **RemediationScriptPicker**: Adapted from existing `ScriptPickerModal` — search, category filter, OS filter, language badges
- **SoftwareCatalogPicker**: Fetches `/software-catalog`, shows name/vendor/category, optional version selection

### Drag-to-Reorder Rules
Native HTML drag/drop on rule cards within each rule set. Updates sort order on save.

### UI Layout Per Rule
```
┌─────────────────────────────────────────────┐
│ ≡ Rule: Required Software                   │
│ Description: [optional notes field       ]  │
│ [type-specific fields...]                   │
│                                             │
│ Remediation (when enforce mode):            │
│ ○ None  ● Run Script  ○ Deploy Software     │
│ [Selected: "Install CrowdStrike" (PS)]  ✕   │
└─────────────────────────────────────────────┘
```

## Files

| File | Action | Purpose |
|------|--------|---------|
| `ComplianceTab.tsx` | Modify | Per-rule remediation, description, drag-to-reorder, remove rule-set scriptId |
| `RemediationScriptPicker.tsx` | Create | Script picker modal for remediation |
| `SoftwareCatalogPicker.tsx` | Create | Software catalog/version picker modal |
| `configurationPolicy.ts` (service) | Modify | Decompose/assemble per-rule remediation in JSONB |
| `policyEvaluationService.ts` | Modify | Read remediation from individual rules |
