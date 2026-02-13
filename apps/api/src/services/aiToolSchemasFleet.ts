/**
 * AI Fleet Tool Input Schemas
 *
 * Zod schemas for validating fleet orchestration tool inputs.
 */

import { z } from 'zod';

const uuid = z.string().uuid();

export const fleetToolInputSchemas: Record<string, z.ZodType> = {
  manage_policies: z.object({
    action: z.enum([
      'list', 'get', 'compliance_status', 'compliance_summary',
      'evaluate', 'create', 'update', 'activate', 'deactivate', 'delete', 'remediate',
    ]),
    policyId: uuid.optional(),
    enforcement: z.enum(['monitor', 'warn', 'enforce']).optional(),
    enabled: z.boolean().optional(),
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(2000).optional(),
    rules: z.record(z.unknown()).optional(),
    targets: z.record(z.unknown()).optional(),
    checkIntervalMinutes: z.number().int().min(1).max(1440).optional(),
    remediationScriptId: uuid.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).refine(
    (d) => {
      const needsId = ['get', 'compliance_status', 'evaluate', 'update', 'activate', 'deactivate', 'delete', 'remediate'];
      return !needsId.includes(d.action) || !!d.policyId;
    },
    { message: 'policyId is required for this action' },
  ).refine(
    (d) => d.action !== 'create' || (!!d.name && !!d.rules && !!d.targets),
    { message: 'name, rules, and targets are required for create' },
  ),

  manage_deployments: z.object({
    action: z.enum(['list', 'get', 'device_status', 'create', 'start', 'pause', 'resume', 'cancel']),
    deploymentId: uuid.optional(),
    status: z.enum(['draft', 'pending', 'running', 'paused', 'completed', 'failed', 'cancelled']).optional(),
    name: z.string().min(1).max(200).optional(),
    type: z.string().max(50).optional(),
    payload: z.record(z.unknown()).optional(),
    targetType: z.string().max(20).optional(),
    targetConfig: z.record(z.unknown()).optional(),
    rolloutConfig: z.record(z.unknown()).optional(),
    schedule: z.record(z.unknown()).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).refine(
    (d) => {
      const needsId = ['get', 'device_status', 'start', 'pause', 'resume', 'cancel'];
      return !needsId.includes(d.action) || !!d.deploymentId;
    },
    { message: 'deploymentId is required for this action' },
  ).refine(
    (d) => d.action !== 'create' || (!!d.name && !!d.type && !!d.payload && !!d.targetType && !!d.targetConfig && !!d.rolloutConfig),
    { message: 'name, type, payload, targetType, targetConfig, and rolloutConfig are required for create' },
  ),

  manage_patches: z.object({
    action: z.enum(['list', 'compliance', 'scan', 'approve', 'decline', 'defer', 'bulk_approve', 'install', 'rollback']),
    patchId: uuid.optional(),
    patchIds: z.array(uuid).max(50).optional(),
    deviceIds: z.array(uuid).max(50).optional(),
    source: z.enum(['microsoft', 'apple', 'linux', 'third_party', 'custom']).optional(),
    severity: z.enum(['critical', 'important', 'moderate', 'low', 'unknown']).optional(),
    status: z.enum(['pending', 'approved', 'rejected', 'deferred']).optional(),
    deferUntil: z.string().datetime({ offset: true }).optional(),
    notes: z.string().max(1000).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).refine(
    (d) => {
      const needsPatchId = ['approve', 'decline', 'defer', 'rollback'];
      return !needsPatchId.includes(d.action) || !!d.patchId;
    },
    { message: 'patchId is required for this action' },
  ).refine(
    (d) => d.action !== 'bulk_approve' || (Array.isArray(d.patchIds) && d.patchIds.length > 0),
    { message: 'patchIds is required for bulk_approve' },
  ).refine(
    (d) => d.action !== 'install' || (Array.isArray(d.patchIds) && d.patchIds.length > 0 && Array.isArray(d.deviceIds) && d.deviceIds.length > 0),
    { message: 'patchIds and deviceIds are required for install' },
  ).refine(
    (d) => d.action !== 'scan' || (Array.isArray(d.deviceIds) && d.deviceIds.length > 0),
    { message: 'deviceIds is required for scan' },
  ).refine(
    (d) => d.action !== 'rollback' || (Array.isArray(d.deviceIds) && d.deviceIds.length > 0),
    { message: 'deviceIds is required for rollback' },
  ),

  manage_groups: z.object({
    action: z.enum(['list', 'get', 'preview', 'membership_log', 'create', 'update', 'delete', 'add_devices', 'remove_devices']),
    groupId: uuid.optional(),
    name: z.string().min(1).max(255).optional(),
    type: z.enum(['static', 'dynamic']).optional(),
    siteId: uuid.optional(),
    filterConditions: z.record(z.unknown()).optional(),
    deviceIds: z.array(uuid).max(100).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }).refine(
    (d) => {
      const needsId = ['get', 'membership_log', 'update', 'delete', 'add_devices', 'remove_devices'];
      return !needsId.includes(d.action) || !!d.groupId;
    },
    { message: 'groupId is required for this action' },
  ).refine(
    (d) => d.action !== 'create' || !!d.name,
    { message: 'name is required for create' },
  ).refine(
    (d) => !['add_devices', 'remove_devices'].includes(d.action) || (Array.isArray(d.deviceIds) && d.deviceIds.length > 0),
    { message: 'deviceIds is required for add_devices/remove_devices' },
  ).refine(
    (d) => d.action !== 'preview' || !!d.filterConditions,
    { message: 'filterConditions is required for preview' },
  ),

  manage_maintenance_windows: z.object({
    action: z.enum(['list', 'get', 'active_now', 'create', 'update', 'delete']),
    windowId: uuid.optional(),
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(2000).optional(),
    startTime: z.string().datetime({ offset: true }).optional(),
    endTime: z.string().datetime({ offset: true }).optional(),
    timezone: z.string().max(50).optional(),
    recurrence: z.enum(['once', 'daily', 'weekly', 'monthly', 'custom']).optional(),
    recurrenceRule: z.record(z.unknown()).optional(),
    targetType: z.string().max(50).optional(),
    siteIds: z.array(uuid).optional(),
    groupIds: z.array(uuid).optional(),
    deviceIds: z.array(uuid).optional(),
    suppressAlerts: z.boolean().optional(),
    suppressPatching: z.boolean().optional(),
    suppressAutomations: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).refine(
    (d) => {
      const needsId = ['get', 'update', 'delete'];
      return !needsId.includes(d.action) || !!d.windowId;
    },
    { message: 'windowId is required for this action' },
  ).refine(
    (d) => d.action !== 'create' || (!!d.name && !!d.startTime && !!d.endTime && !!d.targetType),
    { message: 'name, startTime, endTime, and targetType are required for create' },
  ),

  manage_automations: z.object({
    action: z.enum(['list', 'get', 'history', 'create', 'update', 'delete', 'enable', 'disable', 'run']),
    automationId: uuid.optional(),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    trigger: z.record(z.unknown()).optional(),
    conditions: z.record(z.unknown()).optional(),
    actions: z.array(z.record(z.unknown())).min(1).max(20).optional(),
    onFailure: z.enum(['stop', 'continue', 'notify']).optional(),
    enabled: z.boolean().optional(),
    triggerType: z.enum(['schedule', 'event', 'webhook', 'manual']).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).refine(
    (d) => {
      const needsId = ['get', 'history', 'update', 'delete', 'enable', 'disable', 'run'];
      return !needsId.includes(d.action) || !!d.automationId;
    },
    { message: 'automationId is required for this action' },
  ).refine(
    (d) => d.action !== 'create' || (!!d.name && !!d.trigger && Array.isArray(d.actions) && d.actions.length > 0),
    { message: 'name, trigger, and actions are required for create' },
  ),

  manage_alert_rules: z.object({
    action: z.enum(['list_rules', 'get_rule', 'create_rule', 'update_rule', 'delete_rule', 'test_rule', 'list_channels', 'alert_summary']),
    ruleId: uuid.optional(),
    name: z.string().min(1).max(200).optional(),
    templateId: uuid.optional(),
    targetType: z.string().max(50).optional(),
    targetId: uuid.optional(),
    overrideSettings: z.record(z.unknown()).optional(),
    isActive: z.boolean().optional(),
    severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).refine(
    (d) => {
      const needsId = ['get_rule', 'update_rule', 'delete_rule', 'test_rule'];
      return !needsId.includes(d.action) || !!d.ruleId;
    },
    { message: 'ruleId is required for this action' },
  ).refine(
    (d) => d.action !== 'create_rule' || (!!d.name && !!d.templateId && !!d.targetType && !!d.targetId),
    { message: 'name, templateId, targetType, and targetId are required for create_rule' },
  ),

  generate_report: z.object({
    action: z.enum(['list', 'generate', 'data', 'create', 'update', 'delete', 'history']),
    reportId: uuid.optional(),
    reportType: z.enum(['device_inventory', 'software_inventory', 'alert_summary', 'compliance', 'performance', 'executive_summary']).optional(),
    name: z.string().min(1).max(255).optional(),
    config: z.record(z.unknown()).optional(),
    schedule: z.enum(['one_time', 'daily', 'weekly', 'monthly']).optional(),
    format: z.enum(['csv', 'pdf', 'excel']).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).refine(
    (d) => {
      const needsId = ['update', 'delete', 'history'];
      return !needsId.includes(d.action) || !!d.reportId;
    },
    { message: 'reportId is required for this action' },
  ).refine(
    (d) => d.action !== 'generate' || (!!d.reportId || !!d.reportType),
    { message: 'reportId or reportType is required for generate' },
  ).refine(
    (d) => d.action !== 'data' || !!d.reportType,
    { message: 'reportType is required for data' },
  ).refine(
    (d) => d.action !== 'create' || (!!d.name && !!d.reportType),
    { message: 'name and reportType are required for create' },
  ),
};
