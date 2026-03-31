export type BackupProvider = 's3' | 'local';

export type BackupConfig = {
  id: string;
  name: string;
  provider: BackupProvider;
  enabled: boolean;
  details: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastTestedAt?: string;
};

export type BackupPolicySchedule = {
  frequency: 'daily' | 'weekly' | 'monthly';
  time: string;
  timezone: string;
  dayOfWeek?: number;
  dayOfMonth?: number;
  windowStart?: string;
  windowEnd?: string;
};

export type BackupPolicyRetention = {
  preset?: 'standard' | 'extended' | 'compliance' | 'custom';
  retentionDays?: number;
  maxVersions?: number;
  keepDaily?: number;
  keepWeekly?: number;
  keepMonthly?: number;
  keepYearly?: number;
  weeklyDay?: number;
};

export type BackupPolicyTargets = {
  deviceIds: string[];
  siteIds: string[];
  groupIds: string[];
};

export type BackupPolicy = {
  id: string;
  name: string;
  configId: string;
  enabled: boolean;
  targets: BackupPolicyTargets;
  schedule: BackupPolicySchedule;
  retention: BackupPolicyRetention;
  createdAt: string;
  updatedAt: string;
};

export type BackupJobStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'partial';

export type BackupJobType = 'scheduled' | 'manual' | 'incremental';

export type BackupJob = {
  id: string;
  type: BackupJobType;
  deviceId: string;
  configId: string;
  policyId?: string | null;
  snapshotId?: string | null;
  status: BackupJobStatus;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  totalSize?: number | null;
  fileCount?: number | null;
  errorCount?: number | null;
  errorLog?: string | null;
};

export type BackupSnapshot = {
  id: string;
  deviceId: string;
  configId?: string | null;
  jobId: string;
  providerSnapshotId?: string | null;
  createdAt: string;
  sizeBytes: number | null;
  fileCount: number | null;
  label: string | null;
  location: string | null;
};

export type SnapshotTreeItem = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  sizeBytes?: number;
  modifiedAt?: string;
  children?: SnapshotTreeItem[];
};

export type RestoreJob = {
  id: string;
  snapshotId: string;
  deviceId: string;
  restoreType?: 'full' | 'selective' | 'bare_metal' | null;
  selectedPaths?: string[] | null;
  status: BackupJobStatus;
  targetPath?: string | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt: string;
  restoredSize?: number | null;
  restoredFiles?: number | null;
};

export type BackupVerificationType = 'integrity' | 'test_restore';
export type BackupVerificationStatus = 'pending' | 'running' | 'passed' | 'failed' | 'partial';

export function normalizeBackupVerificationType(value?: string | null): BackupVerificationType {
  return value === 'integrity' ? 'integrity' : 'test_restore';
}

export type BackupVerification = {
  id: string;
  orgId: string;
  deviceId: string;
  backupJobId: string;
  snapshotId?: string | null;
  verificationType: BackupVerificationType;
  status: BackupVerificationStatus;
  startedAt: string;
  completedAt?: string | null;
  restoreTimeSeconds?: number | null;
  filesVerified: number;
  filesFailed: number;
  sizeBytes?: number | null;
  details?: Record<string, unknown> | null;
  createdAt: string;
};

export type RecoveryRiskFactor = {
  code: string;
  severity: 'low' | 'medium' | 'high';
  message: string;
};

export type RecoveryReadiness = {
  id: string;
  orgId: string;
  deviceId: string;
  readinessScore: number;
  estimatedRtoMinutes?: number | null;
  estimatedRpoMinutes?: number | null;
  riskFactors: RecoveryRiskFactor[];
  calculatedAt: string;
};
