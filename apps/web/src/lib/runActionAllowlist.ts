// Files in the targeted set permitted to call fetchWithAuth with a mutating
// method WITHOUT runAction, with the reason. Keep this list short and justified.
export const RUN_ACTION_ALLOWLIST: ReadonlyArray<{ file: string; reason: string }> = [
  { file: 'apps/web/src/services/deviceActions.ts', reason: 'typed Wake service (WakeCommandError) — the pattern runAction generalizes' },
  { file: 'apps/web/src/stores/auth.ts', reason: 'transport/auth store, not a UI action handler' },
];

// KNOWN UNMIGRATED — pre-existing components with mutating fetchWithAuth NOT yet
// routed through runAction. OUT OF WS-A scope (sweeping migration is a non-goal).
// These are NOT silent-failure-safe yet; migrate opportunistically and move each
// into TARGET_GLOBS in no-silent-mutations.test.ts as it's done. Tracked, not hidden.
export const RUN_ACTION_MIGRATION_BACKLOG: ReadonlyArray<string> = [
  'apps/web/src/components/devices/AddDeviceModal.tsx',
  'apps/web/src/components/devices/ChangeSiteModal.tsx',
  'apps/web/src/components/devices/CreateGroupModal.tsx',
  'apps/web/src/components/devices/DeviceBootPerformanceTab.tsx',
  'apps/web/src/components/devices/DeviceFilesystemTab.tsx',
  'apps/web/src/components/devices/DeviceGroupsPage.tsx',
  'apps/web/src/components/devices/DeviceList.tsx',
  'apps/web/src/components/devices/DevicePatchStatusTab.tsx',
  'apps/web/src/components/devices/DeviceSecurityTab.tsx',
  'apps/web/src/components/devices/DeviceSettingsModal.tsx',
  'apps/web/src/components/devices/DeviceWarrantyCard.tsx',
  'apps/web/src/components/alerts/AlertCorrelationView.tsx',
  'apps/web/src/components/alerts/AlertDetailPage.tsx',
  'apps/web/src/components/alerts/AlertRuleEditor.tsx',
  'apps/web/src/components/alerts/AlertRulesPage.tsx',
  'apps/web/src/components/alerts/AlertTemplateEditor.tsx',
  'apps/web/src/components/alerts/AlertTemplateList.tsx',
  'apps/web/src/components/alerts/AlertsPage.tsx',
  'apps/web/src/components/alerts/CorrelatedAlertGroups.tsx',
];
