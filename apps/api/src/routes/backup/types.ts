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
};

export type BackupPolicyRetention = {
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
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
  status: BackupJobStatus;
  targetPath?: string | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt: string;
  restoredSize?: number | null;
  restoredFiles?: number | null;
};
