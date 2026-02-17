import { z } from 'zod';
import type { SecurityPostureItem } from '../../services/securityPosture';

export const providerCatalog = {
  windows_defender: { id: 'windows_defender', name: 'Microsoft Defender', vendor: 'Microsoft' },
  bitdefender: { id: 'bitdefender', name: 'Bitdefender', vendor: 'Bitdefender' },
  sophos: { id: 'sophos', name: 'Sophos', vendor: 'Sophos' },
  sentinelone: { id: 'sentinelone', name: 'SentinelOne Singularity', vendor: 'SentinelOne' },
  crowdstrike: { id: 'crowdstrike', name: 'CrowdStrike Falcon', vendor: 'CrowdStrike' },
  malwarebytes: { id: 'malwarebytes', name: 'Malwarebytes', vendor: 'Malwarebytes' },
  eset: { id: 'eset', name: 'ESET', vendor: 'ESET' },
  kaspersky: { id: 'kaspersky', name: 'Kaspersky', vendor: 'Kaspersky' },
  other: { id: 'other', name: 'Other', vendor: 'Other' }
} as const;

export type ProviderKey = keyof typeof providerCatalog;
export type SecurityState = 'protected' | 'at_risk' | 'unprotected' | 'offline';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type ThreatStatus = 'active' | 'quarantined' | 'removed';

export type StatusRow = {
  deviceId: string;
  orgId: string;
  deviceName: string;
  os: 'windows' | 'macos' | 'linux';
  deviceState: 'online' | 'offline' | 'maintenance' | 'decommissioned' | 'quarantined';
  provider: ProviderKey;
  providerVersion: string | null;
  definitionsVersion: string | null;
  definitionsDate: Date | null;
  realTimeProtection: boolean;
  threatCount: number;
  firewallEnabled: boolean;
  encryptionStatus: string;
  encryptionDetails: unknown;
  localAdminSummary: unknown;
  passwordPolicySummary: unknown;
  gatekeeperEnabled: boolean | null;
  lastScan: Date | null;
  lastScanType: string | null;
};

export type ThreatRow = {
  id: string;
  deviceId: string;
  orgId: string;
  deviceName: string;
  provider: ProviderKey;
  threatName: string;
  threatType: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: ThreatStatus;
  filePath: string;
  detectedAt: Date;
  resolvedAt: Date | null;
};

export type PostureFactorKey = keyof SecurityPostureItem['factors'];

export type PolicyCheckResponse = {
  rule: string;
  key: string;
  pass: boolean;
  current?: string;
  required?: string;
};

export type ParsedPasswordPolicy = {
  checks: PolicyCheckResponse[];
  compliant: boolean;
};

export type ParsedAdminAccount = {
  username: string;
  isBuiltIn: boolean;
  enabled: boolean;
  lastLogin: string;
  passwordAgeDays: number;
  issues: Array<'default_account' | 'weak_password' | 'stale_account'>;
};

export type ParsedAdminSummary = {
  accounts: ParsedAdminAccount[];
  totalAdmins: number;
  localAccounts: number;
  issueTypes: Array<'default_account' | 'weak_password' | 'stale_account'>;
  issueCounts: {
    defaultAccounts: number;
    weakPasswords: number;
    staleAccounts: number;
  };
};

export type Be9Recommendation = {
  id: string;
  title: string;
  description: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  impact: 'high' | 'medium' | 'low';
  effort: 'low' | 'medium' | 'high';
  affectedDevices: number;
  steps: string[];
};

export const postureComponentModel: Array<{ category: PostureFactorKey; label: string; weight: number }> = [
  { category: 'patch_compliance', label: 'Patch Compliance', weight: 25 },
  { category: 'encryption', label: 'Disk Encryption', weight: 15 },
  { category: 'av_health', label: 'AV Health', weight: 15 },
  { category: 'firewall', label: 'Firewall Status', weight: 10 },
  { category: 'open_ports', label: 'Open Ports Exposure', weight: 10 },
  { category: 'password_policy', label: 'Password Policy', weight: 10 },
  { category: 'os_currency', label: 'OS Currency', weight: 10 },
  { category: 'admin_exposure', label: 'Admin Exposure', weight: 5 }
];

export const priorityRank: Record<'critical' | 'high' | 'medium' | 'low', number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1
};

export const listStatusQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  providerId: z.string().optional(),
  status: z.enum(['protected', 'at_risk', 'unprotected', 'offline']).optional(),
  riskLevel: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  os: z.enum(['windows', 'macos', 'linux']).optional(),
  orgId: z.string().uuid().optional(),
  search: z.string().optional()
});

export const listThreatsQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  status: z.enum(['active', 'quarantined', 'removed']).optional(),
  category: z.enum(['trojan', 'pup', 'malware', 'ransomware', 'spyware']).optional(),
  providerId: z.string().optional(),
  orgId: z.string().uuid().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  search: z.string().optional()
});

export const scanRequestSchema = z.object({
  scanType: z.enum(['quick', 'full', 'custom']),
  paths: z.array(z.string().min(1)).optional()
});

export const listScansQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  status: z.enum(['queued', 'running', 'completed', 'failed']).optional(),
  scanType: z.enum(['quick', 'full', 'custom']).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional()
});

export const listPoliciesQuerySchema = z.object({
  providerId: z.string().optional(),
  scanSchedule: z.enum(['daily', 'weekly', 'monthly', 'manual']).optional(),
  search: z.string().optional()
});

export const createPolicySchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  providerId: z.string().optional(),
  scanSchedule: z.enum(['daily', 'weekly', 'monthly', 'manual']).default('weekly'),
  realTimeProtection: z.boolean().default(true),
  autoQuarantine: z.boolean().default(true),
  severityThreshold: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  exclusions: z.array(z.string().min(1)).optional().default([])
});

export const updatePolicySchema = createPolicySchema.partial();

export const dashboardQuerySchema = z.object({
  orgId: z.string().uuid().optional()
});

export const deviceIdParamSchema = z.object({
  deviceId: z.string().uuid()
});

export const threatIdParamSchema = z.object({
  id: z.string().uuid()
});

export const policyIdParamSchema = z.object({
  id: z.string().uuid()
});

export const recommendationActionSchema = z.object({
  id: z.string()
});

export const trendsQuerySchema = z.object({
  period: z.enum(['7d', '30d', '90d']).optional().default('30d')
});

export const postureQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  minScore: z.string().optional(),
  maxScore: z.string().optional(),
  riskLevel: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  search: z.string().optional()
});

export const firewallQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  status: z.enum(['enabled', 'disabled']).optional(),
  os: z.enum(['windows', 'macos', 'linux']).optional(),
  search: z.string().optional()
});

export const encryptionQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  status: z.enum(['encrypted', 'partial', 'unencrypted']).optional(),
  os: z.enum(['windows', 'macos', 'linux']).optional(),
  search: z.string().optional()
});

export const passwordPolicyQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  compliance: z.enum(['compliant', 'non_compliant']).optional(),
  os: z.enum(['windows', 'macos', 'linux']).optional(),
  search: z.string().optional()
});

export const adminAuditQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  issue: z.enum(['default_account', 'weak_password', 'stale_account', 'no_issues']).optional(),
  os: z.enum(['windows', 'macos', 'linux']).optional(),
  search: z.string().optional()
});

export const recommendationsQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  category: z.string().optional(),
  status: z.enum(['open', 'dismissed', 'completed']).optional(),
  orgId: z.string().uuid().optional()
});
