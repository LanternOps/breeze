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

export type BackupPolicy = {
  id: string;
  name: string;
  configId: string;
  enabled: boolean;
  targets: {
    deviceIds: string[];
    siteIds: string[];
    groupIds: string[];
  };
  schedule: BackupPolicySchedule;
  retention: {
    keepDaily: number;
    keepWeekly: number;
    keepMonthly: number;
  };
  createdAt: string;
  updatedAt: string;
};

export type BackupJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
export type BackupJobType = 'backup' | 'restore';
export type BackupJobTrigger = 'scheduled' | 'manual' | 'restore';

export type BackupJob = {
  id: string;
  type: BackupJobType;
  trigger: BackupJobTrigger;
  deviceId: string;
  configId: string;
  policyId?: string | null;
  snapshotId?: string | null;
  status: BackupJobStatus;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  sizeBytes?: number;
  error?: string | null;
};

export type BackupSnapshot = {
  id: string;
  deviceId: string;
  configId: string;
  jobId: string;
  createdAt: string;
  sizeBytes: number;
  fileCount: number;
  label: string;
  location: string;
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
  targetPath?: string;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt: string;
  progress?: number;
  bytesRestored?: number;
};
