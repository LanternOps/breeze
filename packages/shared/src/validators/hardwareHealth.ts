import { z } from 'zod';
import { AGENT_REPORTABLE_COMPONENT_TYPES, HARDWARE_SOURCES, HARDWARE_SOURCE_STATUSES, HARDWARE_TIERS } from '../constants/hardwareHealth';
export const hardwareComponentReportSchema = z.object({
  componentKey:z.string().min(1).max(200), componentType:z.enum(AGENT_REPORTABLE_COMPONENT_TYPES),
  parentKey:z.string().max(200).nullable().optional(), source:z.enum(HARDWARE_SOURCES), name:z.string().min(1).max(200),
  model:z.string().max(200).nullable().optional(), serial:z.string().max(200).nullable().optional(), firmware:z.string().max(100).nullable().optional(),
  sizeBytes:z.number().int().nonnegative().nullable().optional(), state:z.string().min(1).max(40), stateDetail:z.string().max(200).nullable().optional(),
  progressPercent:z.number().int().min(0).max(100).nullable().optional(), temperatureC:z.number().int().min(-50).max(200).nullable().optional(),
  predictiveFailure:z.boolean().default(false), alertExempt:z.boolean().default(false), memberErrors:z.boolean().optional(),
  osHealthStatus:z.enum(['healthy','warning','unhealthy']).nullable().optional(), smartPassed:z.boolean().nullable().optional(), attributes:z.record(z.string(),z.unknown()).default({}),
});
export const hardwareSourceReportSchema = z.object({
  source:z.enum(HARDWARE_SOURCES),status:z.enum(HARDWARE_SOURCE_STATUSES),complete:z.boolean().optional(),
  toolVersion:z.string().max(100).optional(),path:z.string().max(500).optional(),durationMs:z.number().int().nonnegative().optional(),
  error:z.string().max(500).optional(),retryAt:z.string().datetime().optional(),warnings:z.array(z.string().max(500)).max(50).optional(),
}).refine(value => value.status !== 'ok' || value.complete !== undefined,{path:['complete'],message:'complete is required for ok sources'});
export const hardwareHealthSnapshotSchema = z.object({
  snapshotId:z.string().uuid(),sequence:z.number().int().nonnegative(),collectedAt:z.string().datetime(),agentVersion:z.string().max(50),
  pollIntervalMinutes:z.number().int().min(5).max(60),diskHealthIntervalMinutes:z.number().int().min(15).max(1440),
  tiersRun:z.array(z.enum(HARDWARE_TIERS)).min(1),sources:z.array(hardwareSourceReportSchema).max(32),components:z.array(hardwareComponentReportSchema).max(2000),
});
export type HardwareHealthSnapshot = z.infer<typeof hardwareHealthSnapshotSchema>;
export type HardwareComponentReport = z.infer<typeof hardwareComponentReportSchema>;
export type HardwareSourceReport = z.infer<typeof hardwareSourceReportSchema>;
export const hardwareMonitoringInlineSettingsSchema = z.object({
  enabled:z.boolean().default(true),pollIntervalMinutes:z.number().int().min(5).max(60).default(10),diskHealthIntervalMinutes:z.number().int().min(15).max(1440).default(60),
});
export type HardwareMonitoringInlineSettings = z.infer<typeof hardwareMonitoringInlineSettingsSchema>;
export const HARDWARE_MONITORING_DEFAULTS: HardwareMonitoringInlineSettings = {enabled:true,pollIntervalMinutes:10,diskHealthIntervalMinutes:60};
