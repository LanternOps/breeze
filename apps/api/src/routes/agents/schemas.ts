import { z } from 'zod';

export const commandResultSchema = z.object({
  status: z.enum(['completed', 'failed', 'timeout']),
  exitCode: z.number().int().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  durationMs: z.number().int(),
  error: z.string().optional()
});

export const securityProviderValues = [
  'windows_defender',
  'bitdefender',
  'sophos',
  'sentinelone',
  'crowdstrike',
  'malwarebytes',
  'eset',
  'kaspersky',
  'other'
] as const;

export type SecurityProviderValue = (typeof securityProviderValues)[number];

export const securityStatusIngestSchema = z.object({
  provider: z.string().optional(),
  providerVersion: z.string().optional(),
  definitionsVersion: z.string().optional(),
  definitionsDate: z.string().optional(),
  lastScan: z.string().optional(),
  lastScanType: z.string().optional(),
  realTimeProtection: z.boolean().optional(),
  threatCount: z.number().int().min(0).optional(),
  firewallEnabled: z.boolean().optional(),
  encryptionStatus: z.string().optional(),
  encryptionDetails: z.record(z.unknown()).optional(),
  localAdminSummary: z.record(z.unknown()).optional(),
  passwordPolicySummary: z.record(z.unknown()).optional(),
  gatekeeperEnabled: z.boolean().optional(),
  guardianEnabled: z.boolean().optional(),
  windowsSecurityCenterAvailable: z.boolean().optional(),
  avProducts: z.array(
    z.object({
      displayName: z.string().optional(),
      provider: z.string().optional(),
      realTimeProtection: z.boolean().optional(),
      definitionsUpToDate: z.boolean().optional(),
      productState: z.number().int().optional()
    }).passthrough()
  ).optional()
}).passthrough();

export type SecurityStatusPayload = z.infer<typeof securityStatusIngestSchema>;

export const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const securityCommandTypes = {
  collectStatus: 'security_collect_status',
  scan: 'security_scan',
  quarantine: 'security_threat_quarantine',
  remove: 'security_threat_remove',
  restore: 'security_threat_restore'
} as const;

export const filesystemAnalysisCommandType = 'filesystem_analysis';
