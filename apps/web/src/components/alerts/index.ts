// Alert List and Types
export { default as AlertList } from './AlertList';
export type { Alert, AlertSeverity, AlertStatus } from './AlertList';

// Alert Details
export { default as AlertDetails } from './AlertDetails';
export type { NotificationHistory, StatusChange } from './AlertDetails';

// Alert Rules
//
// AlertRuleList / AlertRulesPage were removed with #3988: /alerts/rules/* has
// been a 301 to /configuration-policies since d8a6bc833 (2026-02-22), so both
// components — and the "Test" verdict fix #3923 landed in them six months
// later — were unreachable from any route. Alert rules are edited in the
// Configuration Policy Alerts tab
// (components/configurationPolicies/featureTabs/AlertRuleTab.tsx), and the Test
// verdict now lives beside it in AlertRuleTestModal.tsx.
export { default as AlertRuleForm } from './AlertRuleForm';
export type { AlertRuleFormValues, AlertRuleConditionFormValues } from './AlertRuleForm';

// Alert Templates
export { default as AlertTemplateList } from './AlertTemplateList';
export { default as AlertTemplateEditor } from './AlertTemplateEditor';

// Alert Rule Editor
export { default as AlertRuleEditor } from './AlertRuleEditor';

// Alert Correlation
export { default as AlertCorrelationView } from './AlertCorrelationView';
export { default as CorrelatedAlertGroups } from './CorrelatedAlertGroups';

// Notification Channels
export { default as NotificationChannelList } from './NotificationChannelList';
export type { NotificationChannel, NotificationChannelType } from './NotificationChannelList';

export { default as NotificationChannelForm } from './NotificationChannelForm';
export type { NotificationChannelFormValues } from './NotificationChannelForm';

// Summary Widget
export { default as AlertsSummary, AlertsSummaryCompact } from './AlertsSummary';

// Page Components
export { default as AlertsPage } from './AlertsPage';
export { default as AlertRuleEditPage } from './AlertRuleEditPage';
export { default as NotificationChannelsPage } from './NotificationChannelsPage';
