# Large File Refactoring Plan

## Overview

Several files in the codebase exceed 1000 lines and should be refactored for maintainability. This plan outlines a strategy to break these files into smaller, more focused modules.

## Files to Refactor

### API Routes (apps/api/src/routes/)

| File | Lines | Priority | Complexity |
|------|-------|----------|------------|
| security.ts | 1851 | High | High |
| policies.ts | 1807 | High | High |
| alertTemplates.ts | 1774 | Medium | Medium |
| backup.ts | 1669 | High | High |
| snmp.ts | 1596 | Medium | Medium |
| reports.ts | 1530 | Medium | Medium |
| software.ts | 1476 | Medium | Medium |
| alerts.ts | 1405 | Medium | Medium |
| devices.ts | 1369 | High | High |
| systemTools.ts | 1280 | Low | Low |
| remote.ts | 1269 | Medium | Medium |
| automations.ts | 1237 | Medium | Medium |
| roles.ts | 1094 | Low | Low |
| patches.ts | 1049 | Low | Medium |

### Services (apps/api/src/services/)

| File | Lines | Priority | Complexity |
|------|-------|----------|------------|
| plugins.ts | 1054 | Low | Medium |

### Other API Files

| File | Lines | Priority | Complexity |
|------|-------|----------|------------|
| openapi.ts | 3424 | Low | Low (auto-generated patterns) |
| deploymentWorker.ts | 861 | Medium | High |

### Frontend Components (apps/web/src/components/)

| File | Lines | Priority | Complexity |
|------|-------|----------|------------|
| AutomationEditor.tsx | 2044 | High | High |
| ReportBuilder.tsx | 1955 | High | High |
| PolicyEditor.tsx | 1814 | High | High |
| DeviceGroupsPage.tsx | 1489 | Medium | Medium |
| DeviceCompare.tsx | 1426 | Medium | Medium |
| AlertTemplateEditor.tsx | 1391 | Medium | Medium |
| DeploymentWizard.tsx | 1312 | Medium | High |
| RegistryEditor.tsx | 1262 | Medium | Medium |
| ScriptEditor.tsx | 1205 | Medium | Medium |
| ScheduledTasks.tsx | 1157 | Low | Medium |
| ScheduledReports.tsx | 1085 | Low | Medium |
| AccessReviewPage.tsx | 1051 | Low | Medium |
| DashboardCustomizer.tsx | 1020 | Low | Medium |
| SecurityDashboard.tsx | 1013 | Low | Medium |

---

## Refactoring Strategy

### Phase 1: High Priority API Routes (Week 1-2)

#### 1. security.ts (1851 lines) → Split into:
```
routes/security/
├── index.ts           # Route exports and composition
├── threats.ts         # Threat detection and management (~400 lines)
├── scans.ts           # Security scanning endpoints (~350 lines)
├── policies.ts        # Security policy CRUD (~350 lines)
├── status.ts          # Device security status (~300 lines)
├── compliance.ts      # Compliance reporting (~250 lines)
└── helpers.ts         # Shared utilities, mappers (~200 lines)
```

#### 2. policies.ts (1807 lines) → Split into:
```
routes/policies/
├── index.ts           # Route exports
├── crud.ts            # Create, Read, Update, Delete (~400 lines)
├── assignments.ts     # Policy-device assignments (~350 lines)
├── compliance.ts      # Compliance checking (~350 lines)
├── templates.ts       # Policy templates (~300 lines)
├── versions.ts        # Version history (~200 lines)
└── mappers.ts         # Response mappers (~200 lines)
```

#### 3. backup.ts (1669 lines) → Split into:
```
routes/backup/
├── index.ts           # Route exports
├── configs.ts         # Backup configuration CRUD (~400 lines)
├── jobs.ts            # Backup/restore job management (~400 lines)
├── snapshots.ts       # Snapshot management (~350 lines)
├── policies.ts        # Backup policies (~300 lines)
├── dashboard.ts       # Dashboard stats (~150 lines)
└── helpers.ts         # Shared utilities (~100 lines)
```

#### 4. devices.ts (1369 lines) → Split into:
```
routes/devices/
├── index.ts           # Route exports
├── crud.ts            # Device CRUD operations (~350 lines)
├── commands.ts        # Device command execution (~300 lines)
├── metrics.ts         # Metrics and monitoring (~250 lines)
├── inventory.ts       # Hardware/software inventory (~250 lines)
├── bulk.ts            # Bulk operations (~150 lines)
└── mappers.ts         # Response mappers (~100 lines)
```

### Phase 2: Medium Priority API Routes (Week 3-4)

#### 5. alertTemplates.ts, snmp.ts, reports.ts, software.ts, alerts.ts
Each follows similar pattern:
- Extract CRUD operations
- Extract business logic
- Extract mappers/helpers
- Create index.ts for route composition

### Phase 3: High Priority Frontend Components (Week 5-6)

#### 6. AutomationEditor.tsx (2044 lines) → Split into:
```
components/automations/
├── AutomationEditor/
│   ├── index.tsx          # Main component, state management
│   ├── TriggerSection.tsx # Trigger configuration (~300 lines)
│   ├── ConditionBuilder.tsx # Condition building UI (~350 lines)
│   ├── ActionEditor.tsx   # Action configuration (~300 lines)
│   ├── ScheduleConfig.tsx # Scheduling options (~200 lines)
│   ├── Preview.tsx        # Automation preview (~150 lines)
│   ├── hooks.ts           # Custom hooks (~200 lines)
│   └── types.ts           # Type definitions
```

#### 7. ReportBuilder.tsx (1955 lines) → Split into:
```
components/reports/
├── ReportBuilder/
│   ├── index.tsx          # Main component
│   ├── DataSourcePicker.tsx
│   ├── FieldSelector.tsx
│   ├── FilterBuilder.tsx
│   ├── ChartConfigurator.tsx
│   ├── LayoutEditor.tsx
│   ├── PreviewPanel.tsx
│   ├── hooks.ts
│   └── types.ts
```

#### 8. PolicyEditor.tsx (1814 lines) → Split into:
```
components/policies/
├── PolicyEditor/
│   ├── index.tsx
│   ├── RuleBuilder.tsx
│   ├── TargetSelector.tsx
│   ├── EnforcementConfig.tsx
│   ├── ScheduleConfig.tsx
│   ├── PreviewPanel.tsx
│   ├── hooks.ts
│   └── types.ts
```

### Phase 4: Medium Priority Frontend (Week 7-8)

Remaining components follow similar splitting patterns based on logical sections.

---

## Refactoring Guidelines

### API Route Splitting

1. **Create a directory** for each route file being split
2. **Keep the index.ts minimal** - only route composition
3. **Extract handlers** into separate files by domain
4. **Share utilities** via a helpers.ts file
5. **Keep mappers together** for consistency
6. **Maintain backward compatibility** - same route paths

### Frontend Component Splitting

1. **Create a directory** for each large component
2. **Use compound component pattern** where applicable
3. **Extract hooks** for reusable logic
4. **Extract types** into separate file
5. **Keep related state together** - don't over-split
6. **Use context** for deep prop drilling cases

### Testing Strategy

1. **Before refactoring**: Ensure existing tests pass
2. **During refactoring**: Write tests for extracted modules
3. **After refactoring**: Verify integration tests still pass
4. **Coverage goal**: Maintain or improve current coverage

### Migration Strategy

1. **One file at a time** - avoid parallel refactoring
2. **Feature flag** for risky changes
3. **Incremental commits** - easy to bisect issues
4. **Review each phase** before proceeding

---

## Success Criteria

- [ ] No file exceeds 500 lines (target) or 800 lines (acceptable)
- [ ] All existing tests pass
- [ ] No regression in functionality
- [ ] Improved code organization (logical groupings)
- [ ] Easier to navigate and understand
- [ ] Reduced merge conflicts (smaller files)

---

## Estimated Timeline

| Phase | Duration | Files |
|-------|----------|-------|
| Phase 1 | 2 weeks | security, policies, backup, devices |
| Phase 2 | 2 weeks | alertTemplates, snmp, reports, software, alerts |
| Phase 3 | 2 weeks | AutomationEditor, ReportBuilder, PolicyEditor |
| Phase 4 | 2 weeks | Remaining frontend components |

**Total: 8 weeks** (can be parallelized with multiple developers)

---

## Next Steps

1. Start with `devices.ts` as pilot (high value, moderate complexity)
2. Establish patterns and conventions from pilot
3. Apply patterns to remaining files
4. Document new structure in CLAUDE.md
