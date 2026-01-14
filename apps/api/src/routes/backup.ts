import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { authMiddleware } from '../middleware/auth';

export const backupRoutes = new Hono();

backupRoutes.use('*', authMiddleware);

type BackupProvider = 's3' | 'local';

type BackupConfig = {
  id: string;
  name: string;
  provider: BackupProvider;
  enabled: boolean;
  details: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastTestedAt?: string;
};

type BackupPolicySchedule = {
  frequency: 'daily' | 'weekly' | 'monthly';
  time: string;
  timezone: string;
  dayOfWeek?: number;
  dayOfMonth?: number;
};

type BackupPolicy = {
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

type BackupJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
type BackupJobType = 'backup' | 'restore';
type BackupJobTrigger = 'scheduled' | 'manual' | 'restore';

type BackupJob = {
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

type BackupSnapshot = {
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

type SnapshotTreeItem = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  sizeBytes?: number;
  modifiedAt?: string;
  children?: SnapshotTreeItem[];
};

type RestoreJob = {
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

function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function toDateOrNull(value?: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.getTime();
}

function getNextRun(schedule: BackupPolicySchedule) {
  const now = new Date();
  const timeParts = schedule.time.split(':').map((value) => Number.parseInt(value ?? '0', 10));
  const hour = timeParts[0] ?? 0;
  const minute = timeParts[1] ?? 0;
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);

  if (schedule.frequency === 'weekly' && typeof schedule.dayOfWeek === 'number') {
    const diff = (schedule.dayOfWeek - next.getDay() + 7) % 7;
    next.setDate(next.getDate() + diff);
  } else if (schedule.frequency === 'monthly' && typeof schedule.dayOfMonth === 'number') {
    next.setDate(schedule.dayOfMonth);
  }

  if (next <= now) {
    if (schedule.frequency === 'daily') {
      next.setDate(next.getDate() + 1);
    } else if (schedule.frequency === 'weekly') {
      next.setDate(next.getDate() + 7);
    } else {
      next.setMonth(next.getMonth() + 1);
      if (typeof schedule.dayOfMonth === 'number') {
        next.setDate(schedule.dayOfMonth);
      }
    }
  }

  return next.toISOString();
}

const backupConfigs: BackupConfig[] = [
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

const backupPolicies: BackupPolicy[] = [
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

const backupSnapshots: BackupSnapshot[] = [
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

const restoreJobs: RestoreJob[] = [
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

const backupJobs: BackupJob[] = [
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

const snapshotContents: Record<string, SnapshotTreeItem[]> = {
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

const configSchema = z.object({
  name: z.string().min(1),
  provider: z.enum(['s3', 'local']),
  enabled: z.boolean().optional(),
  details: z.record(z.any()).optional()
});

const configUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  details: z.record(z.any()).optional()
});

const policyTargetsSchema = z.object({
  deviceIds: z.array(z.string()).optional(),
  siteIds: z.array(z.string()).optional(),
  groupIds: z.array(z.string()).optional()
});

const policyScheduleSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  timezone: z.string().optional(),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  dayOfMonth: z.number().int().min(1).max(28).optional()
});

const policyRetentionSchema = z.object({
  keepDaily: z.number().int().min(1).optional(),
  keepWeekly: z.number().int().min(1).optional(),
  keepMonthly: z.number().int().min(1).optional()
});

const policySchema = z.object({
  name: z.string().min(1),
  configId: z.string().min(1),
  enabled: z.boolean().optional(),
  targets: policyTargetsSchema.optional(),
  schedule: policyScheduleSchema,
  retention: policyRetentionSchema.optional()
});

const policyUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  configId: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  targets: policyTargetsSchema.partial().optional(),
  schedule: policyScheduleSchema.partial().optional(),
  retention: policyRetentionSchema.partial().optional()
});

const jobListSchema = z.object({
  status: z.enum(['queued', 'running', 'completed', 'failed', 'canceled']).optional(),
  device: z.string().optional(),
  deviceId: z.string().optional(),
  date: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional()
});

const snapshotListSchema = z.object({
  deviceId: z.string().optional(),
  configId: z.string().optional()
});

const restoreSchema = z.object({
  snapshotId: z.string().min(1),
  deviceId: z.string().min(1).optional(),
  targetPath: z.string().optional()
});

backupRoutes.get('/configs', (c) => {
  return c.json({ data: backupConfigs });
});

backupRoutes.post('/configs', zValidator('json', configSchema), async (c) => {
  const payload = c.req.valid('json');
  const now = new Date().toISOString();
  const config: BackupConfig = {
    id: randomUUID(),
    name: payload.name,
    provider: payload.provider,
    enabled: payload.enabled ?? true,
    details: payload.details ?? {},
    createdAt: now,
    updatedAt: now
  };

  backupConfigs.push(config);
  return c.json(config, 201);
});

backupRoutes.get('/configs/:id', (c) => {
  const config = backupConfigs.find((item) => item.id === c.req.param('id'));
  if (!config) {
    return c.json({ error: 'Config not found' }, 404);
  }
  return c.json(config);
});

backupRoutes.patch('/configs/:id', zValidator('json', configUpdateSchema), async (c) => {
  const config = backupConfigs.find((item) => item.id === c.req.param('id'));
  if (!config) {
    return c.json({ error: 'Config not found' }, 404);
  }

  const payload = c.req.valid('json');
  if (payload.name !== undefined) config.name = payload.name;
  if (payload.enabled !== undefined) config.enabled = payload.enabled;
  if (payload.details !== undefined) {
    config.details = { ...config.details, ...payload.details };
  }
  config.updatedAt = new Date().toISOString();

  return c.json(config);
});

backupRoutes.delete('/configs/:id', (c) => {
  const index = backupConfigs.findIndex((item) => item.id === c.req.param('id'));
  if (index === -1) {
    return c.json({ error: 'Config not found' }, 404);
  }
  backupConfigs.splice(index, 1);
  return c.json({ deleted: true });
});

backupRoutes.post('/configs/:id/test', (c) => {
  const config = backupConfigs.find((item) => item.id === c.req.param('id'));
  if (!config) {
    return c.json({ error: 'Config not found' }, 404);
  }
  const checkedAt = new Date().toISOString();
  config.lastTestedAt = checkedAt;
  return c.json({
    id: config.id,
    provider: config.provider,
    status: 'success',
    checkedAt
  });
});

backupRoutes.get('/policies', (c) => {
  return c.json({ data: backupPolicies });
});

backupRoutes.post('/policies', zValidator('json', policySchema), async (c) => {
  const payload = c.req.valid('json');
  const config = backupConfigs.find((item) => item.id === payload.configId);
  if (!config) {
    return c.json({ error: 'Config not found' }, 400);
  }

  const now = new Date().toISOString();
  const policy: BackupPolicy = {
    id: randomUUID(),
    name: payload.name,
    configId: payload.configId,
    enabled: payload.enabled ?? true,
    targets: {
      deviceIds: payload.targets?.deviceIds ?? [],
      siteIds: payload.targets?.siteIds ?? [],
      groupIds: payload.targets?.groupIds ?? []
    },
    schedule: {
      frequency: payload.schedule.frequency,
      time: payload.schedule.time,
      timezone: payload.schedule.timezone ?? 'UTC',
      dayOfWeek: payload.schedule.dayOfWeek,
      dayOfMonth: payload.schedule.dayOfMonth
    },
    retention: {
      keepDaily: payload.retention?.keepDaily ?? 7,
      keepWeekly: payload.retention?.keepWeekly ?? 4,
      keepMonthly: payload.retention?.keepMonthly ?? 3
    },
    createdAt: now,
    updatedAt: now
  };

  backupPolicies.push(policy);
  return c.json(policy, 201);
});

backupRoutes.patch('/policies/:id', zValidator('json', policyUpdateSchema), async (c) => {
  const policy = backupPolicies.find((item) => item.id === c.req.param('id'));
  if (!policy) {
    return c.json({ error: 'Policy not found' }, 404);
  }

  const payload = c.req.valid('json');
  if (payload.name !== undefined) policy.name = payload.name;
  if (payload.enabled !== undefined) policy.enabled = payload.enabled;
  if (payload.configId !== undefined) policy.configId = payload.configId;
  if (payload.targets !== undefined) {
    policy.targets = {
      deviceIds: payload.targets.deviceIds ?? policy.targets.deviceIds,
      siteIds: payload.targets.siteIds ?? policy.targets.siteIds,
      groupIds: payload.targets.groupIds ?? policy.targets.groupIds
    };
  }
  if (payload.schedule !== undefined) {
    policy.schedule = {
      frequency: payload.schedule.frequency ?? policy.schedule.frequency,
      time: payload.schedule.time ?? policy.schedule.time,
      timezone: payload.schedule.timezone ?? policy.schedule.timezone,
      dayOfWeek: payload.schedule.dayOfWeek ?? policy.schedule.dayOfWeek,
      dayOfMonth: payload.schedule.dayOfMonth ?? policy.schedule.dayOfMonth
    };
  }
  if (payload.retention !== undefined) {
    policy.retention = {
      keepDaily: payload.retention.keepDaily ?? policy.retention.keepDaily,
      keepWeekly: payload.retention.keepWeekly ?? policy.retention.keepWeekly,
      keepMonthly: payload.retention.keepMonthly ?? policy.retention.keepMonthly
    };
  }
  policy.updatedAt = new Date().toISOString();

  return c.json(policy);
});

backupRoutes.delete('/policies/:id', (c) => {
  const index = backupPolicies.findIndex((item) => item.id === c.req.param('id'));
  if (index === -1) {
    return c.json({ error: 'Policy not found' }, 404);
  }
  backupPolicies.splice(index, 1);
  return c.json({ deleted: true });
});

backupRoutes.get('/jobs', zValidator('query', jobListSchema), (c) => {
  const query = c.req.valid('query');
  const deviceFilter = query.deviceId ?? query.device;
  const from = toDateOrNull(query.from);
  const to = toDateOrNull(query.to);

  let results = [...backupJobs];

  if (query.status) {
    results = results.filter((job) => job.status === query.status);
  }

  if (deviceFilter) {
    results = results.filter((job) => job.deviceId === deviceFilter);
  }

  if (query.date) {
    const datePrefix = query.date.slice(0, 10);
    results = results.filter((job) => (job.startedAt ?? job.createdAt).startsWith(datePrefix));
  }

  if (from) {
    results = results.filter((job) => {
      const timestamp = toDateOrNull(job.startedAt ?? job.createdAt);
      return timestamp !== null && timestamp >= from;
    });
  }

  if (to) {
    results = results.filter((job) => {
      const timestamp = toDateOrNull(job.startedAt ?? job.createdAt);
      return timestamp !== null && timestamp <= to;
    });
  }

  results.sort((a, b) => {
    const aTime = toDateOrNull(a.startedAt ?? a.createdAt) ?? 0;
    const bTime = toDateOrNull(b.startedAt ?? b.createdAt) ?? 0;
    return bTime - aTime;
  });

  return c.json({ data: results });
});

backupRoutes.get('/jobs/:id', (c) => {
  const job = backupJobs.find((item) => item.id === c.req.param('id'));
  if (!job) {
    return c.json({ error: 'Job not found' }, 404);
  }
  return c.json(job);
});

backupRoutes.post('/jobs/run/:deviceId', (c) => {
  const deviceId = c.req.param('deviceId');
  const policy = backupPolicies.find((item) => item.targets.deviceIds.includes(deviceId));
  const configId = policy?.configId ?? backupConfigs[0]?.id;
  if (!configId) {
    return c.json({ error: 'No backup config available' }, 400);
  }

  const now = new Date().toISOString();
  const job: BackupJob = {
    id: randomUUID(),
    type: 'backup',
    trigger: 'manual',
    deviceId,
    configId,
    policyId: policy?.id ?? null,
    status: 'running',
    startedAt: now,
    createdAt: now,
    updatedAt: now
  };

  backupJobs.push(job);
  return c.json(job, 201);
});

backupRoutes.post('/jobs/:id/cancel', (c) => {
  const job = backupJobs.find((item) => item.id === c.req.param('id'));
  if (!job) {
    return c.json({ error: 'Job not found' }, 404);
  }

  if (job.status !== 'running' && job.status !== 'queued') {
    return c.json({ error: 'Job is not cancelable' }, 409);
  }

  job.status = 'canceled';
  job.completedAt = new Date().toISOString();
  job.updatedAt = job.completedAt;
  job.error = 'Canceled by user';

  return c.json(job);
});

backupRoutes.get('/snapshots', zValidator('query', snapshotListSchema), (c) => {
  const query = c.req.valid('query');
  let results = [...backupSnapshots];

  if (query.deviceId) {
    results = results.filter((snapshot) => snapshot.deviceId === query.deviceId);
  }

  if (query.configId) {
    results = results.filter((snapshot) => snapshot.configId === query.configId);
  }

  results.sort((a, b) => {
    const aTime = toDateOrNull(a.createdAt) ?? 0;
    const bTime = toDateOrNull(b.createdAt) ?? 0;
    return bTime - aTime;
  });

  return c.json({ data: results });
});

backupRoutes.get('/snapshots/:id', (c) => {
  const snapshot = backupSnapshots.find((item) => item.id === c.req.param('id'));
  if (!snapshot) {
    return c.json({ error: 'Snapshot not found' }, 404);
  }
  return c.json(snapshot);
});

backupRoutes.get('/snapshots/:id/browse', (c) => {
  const snapshot = backupSnapshots.find((item) => item.id === c.req.param('id'));
  if (!snapshot) {
    return c.json({ error: 'Snapshot not found' }, 404);
  }

  return c.json({
    snapshotId: snapshot.id,
    data: snapshotContents[snapshot.id] ?? []
  });
});

backupRoutes.post('/restore', zValidator('json', restoreSchema), async (c) => {
  const payload = c.req.valid('json');
  const snapshot = backupSnapshots.find((item) => item.id === payload.snapshotId);
  if (!snapshot) {
    return c.json({ error: 'Snapshot not found' }, 404);
  }

  const now = new Date().toISOString();
  const restoreJob: RestoreJob = {
    id: randomUUID(),
    snapshotId: snapshot.id,
    deviceId: payload.deviceId ?? snapshot.deviceId,
    status: 'queued',
    targetPath: payload.targetPath,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    updatedAt: now,
    progress: 0
  };

  restoreJobs.push(restoreJob);
  backupJobs.push({
    id: restoreJob.id,
    type: 'restore',
    trigger: 'restore',
    deviceId: restoreJob.deviceId,
    configId: snapshot.configId,
    snapshotId: snapshot.id,
    status: 'queued',
    createdAt: now,
    updatedAt: now
  });

  return c.json(restoreJob, 201);
});

backupRoutes.get('/restore/:id', (c) => {
  const restoreJob = restoreJobs.find((item) => item.id === c.req.param('id'));
  if (!restoreJob) {
    return c.json({ error: 'Restore job not found' }, 404);
  }
  return c.json(restoreJob);
});

backupRoutes.get('/dashboard', (c) => {
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const protectedDevices = new Set(
    backupPolicies.flatMap((policy) => policy.targets.deviceIds)
  );
  const recentJobs = [...backupJobs].sort((a, b) => {
    const aTime = toDateOrNull(a.startedAt ?? a.createdAt) ?? 0;
    const bTime = toDateOrNull(b.startedAt ?? b.createdAt) ?? 0;
    return bTime - aTime;
  });

  const lastDayJobs = backupJobs.filter((job) => {
    const timestamp = toDateOrNull(job.startedAt ?? job.createdAt) ?? 0;
    return timestamp >= dayAgo;
  });

  const completed = lastDayJobs.filter((job) => job.status === 'completed').length;
  const failed = lastDayJobs.filter((job) => job.status === 'failed').length;
  const running = lastDayJobs.filter((job) => job.status === 'running').length;
  const queued = lastDayJobs.filter((job) => job.status === 'queued').length;
  const totalBytes = backupSnapshots.reduce((sum, snap) => sum + snap.sizeBytes, 0);

  return c.json({
    data: {
      totals: {
        configs: backupConfigs.length,
        policies: backupPolicies.length,
        jobs: backupJobs.length,
        snapshots: backupSnapshots.length
      },
      jobsLast24h: {
        completed,
        failed,
        running,
        queued
      },
      storage: {
        totalBytes,
        snapshots: backupSnapshots.length
      },
      coverage: {
        protectedDevices: protectedDevices.size
      },
      latestJobs: recentJobs.slice(0, 5)
    }
  });
});

backupRoutes.get('/status/:deviceId', (c) => {
  const deviceId = c.req.param('deviceId');
  const policy = backupPolicies.find((item) => item.targets.deviceIds.includes(deviceId));
  const jobs = backupJobs
    .filter((job) => job.deviceId === deviceId)
    .sort((a, b) => {
      const aTime = toDateOrNull(a.startedAt ?? a.createdAt) ?? 0;
      const bTime = toDateOrNull(b.startedAt ?? b.createdAt) ?? 0;
      return bTime - aTime;
    });

  const lastJob = jobs[0] ?? null;
  const lastSuccess = jobs.find((job) => job.status === 'completed') ?? null;
  const lastFailure = jobs.find((job) => job.status === 'failed') ?? null;

  return c.json({
    data: {
      deviceId,
      protected: Boolean(policy),
      policyId: policy?.id ?? null,
      lastJob,
      lastSuccessAt: lastSuccess?.completedAt ?? null,
      lastFailureAt: lastFailure?.completedAt ?? null,
      nextScheduledAt: policy ? getNextRun(policy.schedule) : null
    }
  });
});
