import { randomUUID } from 'crypto';
import type {
  BackupConfig,
  BackupPolicy,
  BackupSnapshot,
  RestoreJob,
  BackupJob,
  SnapshotTreeItem,
  BackupVerification,
  RecoveryReadiness
} from './types';
import { minutesAgo } from './helpers';

export const DEFAULT_BACKUP_ORG_ID = 'org-123';

export const backupConfigs: BackupConfig[] = [
  {
    id: 'cfg-s3-primary',
    name: 'Primary S3',
    provider: 's3',
    enabled: true,
    details: {
      bucket: 'breeze-backups',
      region: 'us-east-1',
      prefix: 'org-001',
      storageClass: 'STANDARD_IA',
      encryption: 'AES256'
    },
    createdAt: minutesAgo(43200),
    updatedAt: minutesAgo(1440),
    lastTestedAt: minutesAgo(180)
  },
  {
    id: 'cfg-local-nas',
    name: 'Local NAS',
    provider: 'local',
    enabled: true,
    details: {
      path: '/mnt/backup-nas',
      retentionDays: 30,
      compression: 'lz4'
    },
    createdAt: minutesAgo(51840),
    updatedAt: minutesAgo(720),
    lastTestedAt: minutesAgo(360)
  }
];

export const backupPolicies: BackupPolicy[] = [
  {
    id: 'pol-daily-endpoints',
    name: 'Daily Endpoints',
    configId: 'cfg-s3-primary',
    enabled: true,
    targets: {
      deviceIds: ['dev-001', 'dev-002', 'dev-003'],
      siteIds: ['site-nyc'],
      groupIds: []
    },
    schedule: {
      frequency: 'daily',
      time: '02:00',
      timezone: 'UTC'
    },
    retention: {
      keepDaily: 7,
      keepWeekly: 4,
      keepMonthly: 3
    },
    createdAt: minutesAgo(40320),
    updatedAt: minutesAgo(1440)
  },
  {
    id: 'pol-weekly-servers',
    name: 'Weekly Servers',
    configId: 'cfg-local-nas',
    enabled: true,
    targets: {
      deviceIds: ['dev-004'],
      siteIds: ['site-dc'],
      groupIds: ['grp-servers']
    },
    schedule: {
      frequency: 'weekly',
      time: '03:30',
      timezone: 'UTC',
      dayOfWeek: 0
    },
    retention: {
      keepDaily: 4,
      keepWeekly: 8,
      keepMonthly: 6
    },
    createdAt: minutesAgo(38880),
    updatedAt: minutesAgo(2880)
  }
];

export const backupSnapshots: BackupSnapshot[] = [
  {
    id: 'snap-001',
    deviceId: 'dev-001',
    configId: 'cfg-s3-primary',
    jobId: 'job-001',
    createdAt: minutesAgo(170),
    sizeBytes: 321987654,
    fileCount: 45678,
    label: 'Daily 2025-02-14',
    location: 's3://breeze-backups/org-001/dev-001/2025-02-14'
  },
  {
    id: 'snap-002',
    deviceId: 'dev-002',
    configId: 'cfg-s3-primary',
    jobId: 'job-002',
    createdAt: minutesAgo(300),
    sizeBytes: 258734112,
    fileCount: 39210,
    label: 'Daily 2025-02-13',
    location: 's3://breeze-backups/org-001/dev-002/2025-02-13'
  },
  {
    id: 'snap-003',
    deviceId: 'dev-004',
    configId: 'cfg-local-nas',
    jobId: 'job-004',
    createdAt: minutesAgo(1480),
    sizeBytes: 987654321,
    fileCount: 78234,
    label: 'Weekly 2025-02-10',
    location: 'file:///mnt/backup-nas/dev-004/2025-02-10'
  }
];

export const restoreJobs: RestoreJob[] = [
  {
    id: 'restore-001',
    snapshotId: 'snap-002',
    deviceId: 'dev-002',
    status: 'completed',
    targetPath: '/var/restore',
    createdAt: minutesAgo(800),
    startedAt: minutesAgo(790),
    completedAt: minutesAgo(760),
    updatedAt: minutesAgo(760),
    progress: 100,
    bytesRestored: 258734112
  },
  {
    id: 'restore-002',
    snapshotId: 'snap-003',
    deviceId: 'dev-004',
    status: 'running',
    targetPath: '/srv/restore',
    createdAt: minutesAgo(40),
    startedAt: minutesAgo(35),
    updatedAt: minutesAgo(5),
    progress: 45
  }
];

export const backupJobs: BackupJob[] = [
  {
    id: 'job-001',
    type: 'backup',
    trigger: 'scheduled',
    deviceId: 'dev-001',
    configId: 'cfg-s3-primary',
    policyId: 'pol-daily-endpoints',
    snapshotId: 'snap-001',
    status: 'completed',
    startedAt: minutesAgo(180),
    completedAt: minutesAgo(170),
    createdAt: minutesAgo(181),
    updatedAt: minutesAgo(170),
    sizeBytes: 321987654
  },
  {
    id: 'job-002',
    type: 'backup',
    trigger: 'scheduled',
    deviceId: 'dev-002',
    configId: 'cfg-s3-primary',
    policyId: 'pol-daily-endpoints',
    snapshotId: 'snap-002',
    status: 'completed',
    startedAt: minutesAgo(320),
    completedAt: minutesAgo(300),
    createdAt: minutesAgo(321),
    updatedAt: minutesAgo(300),
    sizeBytes: 258734112
  },
  {
    id: 'job-003',
    type: 'backup',
    trigger: 'scheduled',
    deviceId: 'dev-003',
    configId: 'cfg-s3-primary',
    policyId: 'pol-daily-endpoints',
    status: 'running',
    startedAt: minutesAgo(25),
    createdAt: minutesAgo(26),
    updatedAt: minutesAgo(5)
  },
  {
    id: 'job-004',
    type: 'backup',
    trigger: 'scheduled',
    deviceId: 'dev-004',
    configId: 'cfg-local-nas',
    policyId: 'pol-weekly-servers',
    snapshotId: 'snap-003',
    status: 'completed',
    startedAt: minutesAgo(1500),
    completedAt: minutesAgo(1480),
    createdAt: minutesAgo(1501),
    updatedAt: minutesAgo(1480),
    sizeBytes: 987654321
  },
  {
    id: 'job-005',
    type: 'backup',
    trigger: 'manual',
    deviceId: 'dev-005',
    configId: 'cfg-s3-primary',
    status: 'failed',
    startedAt: minutesAgo(600),
    completedAt: minutesAgo(590),
    createdAt: minutesAgo(601),
    updatedAt: minutesAgo(590),
    error: 'Network timeout'
  },
  {
    id: 'restore-001',
    type: 'restore',
    trigger: 'restore',
    deviceId: 'dev-002',
    configId: 'cfg-s3-primary',
    snapshotId: 'snap-002',
    status: 'completed',
    startedAt: minutesAgo(790),
    completedAt: minutesAgo(760),
    createdAt: minutesAgo(800),
    updatedAt: minutesAgo(760)
  },
  {
    id: 'restore-002',
    type: 'restore',
    trigger: 'restore',
    deviceId: 'dev-004',
    configId: 'cfg-local-nas',
    snapshotId: 'snap-003',
    status: 'running',
    startedAt: minutesAgo(35),
    createdAt: minutesAgo(40),
    updatedAt: minutesAgo(5)
  }
];

export const backupVerifications: BackupVerification[] = [
  {
    id: 'verify-001',
    orgId: DEFAULT_BACKUP_ORG_ID,
    deviceId: 'dev-001',
    backupJobId: 'job-001',
    snapshotId: 'snap-001',
    verificationType: 'integrity',
    status: 'passed',
    startedAt: minutesAgo(165),
    completedAt: minutesAgo(164),
    restoreTimeSeconds: 43,
    filesVerified: 45678,
    filesFailed: 0,
    sizeBytes: 321987654,
    details: { source: 'post-backup-integrity-check', checksumAlgorithm: 'sha256' },
    createdAt: minutesAgo(164)
  },
  {
    id: 'verify-002',
    orgId: DEFAULT_BACKUP_ORG_ID,
    deviceId: 'dev-002',
    backupJobId: 'job-002',
    snapshotId: 'snap-002',
    verificationType: 'test_restore',
    status: 'passed',
    startedAt: minutesAgo(250),
    completedAt: minutesAgo(244),
    restoreTimeSeconds: 320,
    filesVerified: 39210,
    filesFailed: 0,
    sizeBytes: 258734112,
    details: {
      source: 'weekly-test-restore',
      isolatedRestorePath: '/tmp/breeze/restore-tests/dev-002/weekly',
      cleanup: { attempted: true, removed: true }
    },
    createdAt: minutesAgo(244)
  },
  {
    id: 'verify-003',
    orgId: DEFAULT_BACKUP_ORG_ID,
    deviceId: 'dev-004',
    backupJobId: 'job-004',
    snapshotId: 'snap-003',
    verificationType: 'test_restore',
    status: 'failed',
    startedAt: minutesAgo(1380),
    completedAt: minutesAgo(1375),
    restoreTimeSeconds: 605,
    filesVerified: 77120,
    filesFailed: 1114,
    sizeBytes: 987654321,
    details: {
      source: 'weekly-test-restore',
      isolatedRestorePath: '/tmp/breeze/restore-tests/dev-004/weekly',
      cleanup: { attempted: true, removed: true },
      reason: 'checksum mismatch on restored VM image'
    },
    createdAt: minutesAgo(1375)
  }
];

export const recoveryReadinessRecords: RecoveryReadiness[] = [
  {
    id: 'readiness-001',
    orgId: DEFAULT_BACKUP_ORG_ID,
    deviceId: 'dev-001',
    readinessScore: 96,
    estimatedRtoMinutes: 8,
    estimatedRpoMinutes: 170,
    riskFactors: [],
    calculatedAt: minutesAgo(120)
  },
  {
    id: 'readiness-002',
    orgId: DEFAULT_BACKUP_ORG_ID,
    deviceId: 'dev-002',
    readinessScore: 90,
    estimatedRtoMinutes: 12,
    estimatedRpoMinutes: 300,
    riskFactors: [
      { code: 'rpo_window_growing', severity: 'low', message: 'Latest backup is older than 4 hours.' }
    ],
    calculatedAt: minutesAgo(120)
  },
  {
    id: 'readiness-003',
    orgId: DEFAULT_BACKUP_ORG_ID,
    deviceId: 'dev-004',
    readinessScore: 58,
    estimatedRtoMinutes: 26,
    estimatedRpoMinutes: 1480,
    riskFactors: [
      { code: 'recent_verification_failure', severity: 'high', message: 'Latest test restore failed.' },
      { code: 'rto_above_target', severity: 'medium', message: 'Restore duration exceeds 20 minute target.' }
    ],
    calculatedAt: minutesAgo(120)
  }
];

export const snapshotContents: Record<string, SnapshotTreeItem[]> = {
  'snap-001': [
    {
      name: '/',
      path: '/',
      type: 'directory',
      children: [
        {
          name: 'Users',
          path: '/Users',
          type: 'directory',
          children: [
            {
              name: 'alice',
              path: '/Users/alice',
              type: 'directory',
              children: [
                {
                  name: 'Documents',
                  path: '/Users/alice/Documents',
                  type: 'directory',
                  children: [
                    {
                      name: 'report.pdf',
                      path: '/Users/alice/Documents/report.pdf',
                      type: 'file',
                      sizeBytes: 245760,
                      modifiedAt: minutesAgo(2880)
                    }
                  ]
                }
              ]
            }
          ]
        },
        {
          name: 'etc',
          path: '/etc',
          type: 'directory',
          children: [
            {
              name: 'hosts',
              path: '/etc/hosts',
              type: 'file',
              sizeBytes: 412,
              modifiedAt: minutesAgo(4320)
            }
          ]
        }
      ]
    }
  ],
  'snap-002': [
    {
      name: '/',
      path: '/',
      type: 'directory',
      children: [
        {
          name: 'var',
          path: '/var',
          type: 'directory',
          children: [
            {
              name: 'lib',
              path: '/var/lib',
              type: 'directory',
              children: [
                {
                  name: 'inventory.db',
                  path: '/var/lib/inventory.db',
                  type: 'file',
                  sizeBytes: 981237,
                  modifiedAt: minutesAgo(3500)
                }
              ]
            }
          ]
        },
        {
          name: 'logs',
          path: '/logs',
          type: 'directory',
          children: [
            {
              name: 'system.log',
              path: '/logs/system.log',
              type: 'file',
              sizeBytes: 5001234,
              modifiedAt: minutesAgo(200)
            }
          ]
        }
      ]
    }
  ],
  'snap-003': [
    {
      name: '/',
      path: '/',
      type: 'directory',
      children: [
        {
          name: 'data',
          path: '/data',
          type: 'directory',
          children: [
            {
              name: 'vm-images',
              path: '/data/vm-images',
              type: 'directory',
              children: [
                {
                  name: 'server-01.qcow2',
                  path: '/data/vm-images/server-01.qcow2',
                  type: 'file',
                  sizeBytes: 734003200,
                  modifiedAt: minutesAgo(10080)
                }
              ]
            }
          ]
        }
      ]
    }
  ]
};

export const configOrgById = new Map<string, string>(
  backupConfigs.map((config) => [config.id, DEFAULT_BACKUP_ORG_ID])
);
export const policyOrgById = new Map<string, string>(
  backupPolicies.map((policy) => [policy.id, DEFAULT_BACKUP_ORG_ID])
);
export const snapshotOrgById = new Map<string, string>(
  backupSnapshots.map((snapshot) => [snapshot.id, DEFAULT_BACKUP_ORG_ID])
);
export const restoreOrgById = new Map<string, string>(
  restoreJobs.map((restoreJob) => [restoreJob.id, DEFAULT_BACKUP_ORG_ID])
);
export const jobOrgById = new Map<string, string>(
  backupJobs.map((job) => [job.id, DEFAULT_BACKUP_ORG_ID])
);
export const verificationOrgById = new Map<string, string>(
  backupVerifications.map((verification) => [verification.id, DEFAULT_BACKUP_ORG_ID])
);
export const recoveryReadinessOrgById = new Map<string, string>(
  recoveryReadinessRecords.map((readiness) => [readiness.id, DEFAULT_BACKUP_ORG_ID])
);

export function addBackupVerification(
  verification: Omit<BackupVerification, 'id' | 'createdAt'> & { id?: string; createdAt?: string },
  orgId: string
): BackupVerification {
  const row: BackupVerification = {
    ...verification,
    id: verification.id ?? randomUUID(),
    createdAt: verification.createdAt ?? new Date().toISOString()
  };
  backupVerifications.push(row);
  verificationOrgById.set(row.id, orgId);
  return row;
}

export function upsertRecoveryReadiness(
  readiness: Omit<RecoveryReadiness, 'id'> & { id?: string },
  orgId: string
): RecoveryReadiness {
  const existing = recoveryReadinessRecords.find(
    (item) => item.deviceId === readiness.deviceId && recoveryReadinessOrgById.get(item.id) === orgId
  );

  if (existing) {
    existing.readinessScore = readiness.readinessScore;
    existing.estimatedRtoMinutes = readiness.estimatedRtoMinutes ?? null;
    existing.estimatedRpoMinutes = readiness.estimatedRpoMinutes ?? null;
    existing.riskFactors = readiness.riskFactors;
    existing.calculatedAt = readiness.calculatedAt;
    return existing;
  }

  const row: RecoveryReadiness = {
    id: readiness.id ?? randomUUID(),
    ...readiness
  };
  recoveryReadinessRecords.push(row);
  recoveryReadinessOrgById.set(row.id, orgId);
  return row;
}
