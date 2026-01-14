import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { authMiddleware, requireScope } from '../middleware/auth';

export const securityRoutes = new Hono();

type ProviderStatus = 'active' | 'warning' | 'offline';
type SecurityStatusState = 'protected' | 'at_risk' | 'unprotected' | 'offline';
type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
type ThreatSeverity = 'critical' | 'high' | 'medium' | 'low';
type ThreatStatus = 'active' | 'quarantined' | 'removed';
type ThreatCategory = 'trojan' | 'pup' | 'malware' | 'ransomware' | 'spyware';
type ScanStatus = 'queued' | 'running' | 'completed' | 'failed';
type ScanType = 'quick' | 'full' | 'custom';
type ScanSchedule = 'daily' | 'weekly' | 'monthly' | 'manual';

type SecurityProvider = {
  id: string;
  name: string;
  vendor: string;
  version: string;
  status: ProviderStatus;
  lastUpdate: string;
};

type SecurityStatus = {
  deviceId: string;
  deviceName: string;
  orgId: string;
  os: 'windows' | 'macos' | 'linux';
  providerId: string;
  status: SecurityStatusState;
  riskLevel: RiskLevel;
  lastScanAt: string;
  threatsDetected: number;
  definitionsUpdatedAt: string;
  realTimeProtection: boolean;
};

type Threat = {
  id: string;
  deviceId: string;
  deviceName: string;
  orgId: string;
  providerId: string;
  name: string;
  category: ThreatCategory;
  severity: ThreatSeverity;
  status: ThreatStatus;
  detectedAt: string;
  quarantinedAt?: string;
  restoredAt?: string;
  removedAt?: string;
  filePath: string;
  hash: string;
};

type ScanRecord = {
  id: string;
  deviceId: string;
  deviceName: string;
  orgId: string;
  scanType: ScanType;
  status: ScanStatus;
  startedAt: string;
  finishedAt?: string;
  threatsFound: number;
  durationSeconds?: number;
};

type SecurityPolicy = {
  id: string;
  name: string;
  description?: string;
  providerId?: string;
  scanSchedule: ScanSchedule;
  realTimeProtection: boolean;
  autoQuarantine: boolean;
  severityThreshold: RiskLevel;
  exclusions: string[];
  createdAt: string;
  updatedAt: string;
};

type DashboardStats = {
  totalDevices: number;
  protectedDevices: number;
  atRiskDevices: number;
  unprotectedDevices: number;
  offlineDevices: number;
  totalThreatsDetected: number;
  activeThreats: number;
  quarantinedThreats: number;
  removedThreats: number;
  lastScanAt: string | null;
  providers: Array<{
    providerId: string;
    providerName: string;
    deviceCount: number;
    coverage: number;
  }>;
};

const now = new Date();
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

const securityProviders: SecurityProvider[] = [
  {
    id: 'prov-sentinelone',
    name: 'SentinelOne Singularity',
    vendor: 'SentinelOne',
    version: '23.2.1',
    status: 'active',
    lastUpdate: daysAgo(1)
  },
  {
    id: 'prov-defender',
    name: 'Microsoft Defender for Endpoint',
    vendor: 'Microsoft',
    version: '4.18.24020',
    status: 'active',
    lastUpdate: daysAgo(2)
  },
  {
    id: 'prov-crowdstrike',
    name: 'CrowdStrike Falcon',
    vendor: 'CrowdStrike',
    version: '7.15.0',
    status: 'warning',
    lastUpdate: daysAgo(3)
  },
  {
    id: 'prov-bitdefender',
    name: 'Bitdefender GravityZone',
    vendor: 'Bitdefender',
    version: '7.7.2',
    status: 'active',
    lastUpdate: daysAgo(1)
  }
];

const securityStatuses: SecurityStatus[] = [
  {
    deviceId: '0f4b0e2b-9c3f-4a8d-9a2a-6b8f1e2a9a01',
    deviceName: 'NYC-LT-014',
    orgId: '11111111-1111-1111-1111-111111111111',
    os: 'windows',
    providerId: 'prov-sentinelone',
    status: 'protected',
    riskLevel: 'low',
    lastScanAt: hoursAgo(6),
    threatsDetected: 0,
    definitionsUpdatedAt: hoursAgo(12),
    realTimeProtection: true
  },
  {
    deviceId: '6e69f4aa-7a2d-42b9-9a2b-7682f0f48a02',
    deviceName: 'SFO-WS-207',
    orgId: '11111111-1111-1111-1111-111111111111',
    os: 'windows',
    providerId: 'prov-defender',
    status: 'at_risk',
    riskLevel: 'high',
    lastScanAt: daysAgo(2),
    threatsDetected: 3,
    definitionsUpdatedAt: daysAgo(4),
    realTimeProtection: true
  },
  {
    deviceId: 'a3f83e6f-1d3b-49d5-b8a2-949df92b2e03',
    deviceName: 'LON-LT-332',
    orgId: '22222222-2222-2222-2222-222222222222',
    os: 'macos',
    providerId: 'prov-crowdstrike',
    status: 'protected',
    riskLevel: 'medium',
    lastScanAt: hoursAgo(9),
    threatsDetected: 1,
    definitionsUpdatedAt: hoursAgo(10),
    realTimeProtection: true
  },
  {
    deviceId: 'c27b4b8a-2f9d-4ef1-82b9-1d3ac3a7cb04',
    deviceName: 'AUS-SRV-011',
    orgId: '22222222-2222-2222-2222-222222222222',
    os: 'linux',
    providerId: 'prov-bitdefender',
    status: 'unprotected',
    riskLevel: 'critical',
    lastScanAt: daysAgo(30),
    threatsDetected: 2,
    definitionsUpdatedAt: daysAgo(30),
    realTimeProtection: false
  },
  {
    deviceId: 'f1bd7f85-1df4-44aa-8147-6b4dba0b7e05',
    deviceName: 'CHI-VM-022',
    orgId: '11111111-1111-1111-1111-111111111111',
    os: 'windows',
    providerId: 'prov-defender',
    status: 'offline',
    riskLevel: 'medium',
    lastScanAt: daysAgo(5),
    threatsDetected: 1,
    definitionsUpdatedAt: daysAgo(5),
    realTimeProtection: false
  },
  {
    deviceId: 'd9c3f8aa-2e0c-49a6-9b42-3c8a2acb7f06',
    deviceName: 'SEA-LT-091',
    orgId: '22222222-2222-2222-2222-222222222222',
    os: 'macos',
    providerId: 'prov-sentinelone',
    status: 'protected',
    riskLevel: 'low',
    lastScanAt: hoursAgo(10),
    threatsDetected: 0,
    definitionsUpdatedAt: hoursAgo(9),
    realTimeProtection: true
  }
];

const threatSeed: Threat[] = [
  {
    id: '9b0ce8f4-21c0-4f65-8b0a-0b9f8bbf9a11',
    deviceId: '6e69f4aa-7a2d-42b9-9a2b-7682f0f48a02',
    deviceName: 'SFO-WS-207',
    orgId: '11111111-1111-1111-1111-111111111111',
    providerId: 'prov-defender',
    name: 'Trojan:Win32/Emotet',
    category: 'trojan',
    severity: 'critical',
    status: 'active',
    detectedAt: hoursAgo(30),
    filePath: 'C:\\Users\\Public\\Libraries\\invoice.exe',
    hash: '7f7c4e3a0e0b2f6b1a4a2c5a9a1b7f2c'
  },
  {
    id: '1f51a1a2-ef7d-4f48-9a9a-71f2c9c83a12',
    deviceId: '6e69f4aa-7a2d-42b9-9a2b-7682f0f48a02',
    deviceName: 'SFO-WS-207',
    orgId: '11111111-1111-1111-1111-111111111111',
    providerId: 'prov-defender',
    name: 'PUP.Optional.Toolbar',
    category: 'pup',
    severity: 'low',
    status: 'quarantined',
    detectedAt: daysAgo(4),
    quarantinedAt: daysAgo(3),
    filePath: 'C:\\ProgramData\\toolbar\\setup.exe',
    hash: 'a3f3a7d1b7c3e2f9b1a0c8d9e2f1a3b4'
  },
  {
    id: '6a7c79c5-5d6e-4b4f-8c78-5d1a70e96a13',
    deviceId: 'a3f83e6f-1d3b-49d5-b8a2-949df92b2e03',
    deviceName: 'LON-LT-332',
    orgId: '22222222-2222-2222-2222-222222222222',
    providerId: 'prov-crowdstrike',
    name: 'MacOS.AdLoad',
    category: 'malware',
    severity: 'medium',
    status: 'active',
    detectedAt: hoursAgo(20),
    filePath: '/Users/Shared/Library/LaunchAgents/com.apple.search.plist',
    hash: 'bb12f9aa0dce4f4f96c7ef0f1a9e3f2b'
  },
  {
    id: '3fa49e28-cf6a-4a7c-8ddf-dc20e3bf1a14',
    deviceId: 'c27b4b8a-2f9d-4ef1-82b9-1d3ac3a7cb04',
    deviceName: 'AUS-SRV-011',
    orgId: '22222222-2222-2222-2222-222222222222',
    providerId: 'prov-bitdefender',
    name: 'Linux/Ransomware.GandCrab',
    category: 'ransomware',
    severity: 'high',
    status: 'active',
    detectedAt: daysAgo(12),
    filePath: '/opt/tmp/update.bin',
    hash: 'c4d9a1f29d4e3f7c9b4a1e2f3c4d5e6f'
  },
  {
    id: 'd6f2f7b3-9a1b-4f7b-9f58-bd9a1a8d2b15',
    deviceId: 'f1bd7f85-1df4-44aa-8147-6b4dba0b7e05',
    deviceName: 'CHI-VM-022',
    orgId: '11111111-1111-1111-1111-111111111111',
    providerId: 'prov-defender',
    name: 'Win32/Spyware.Keylogger',
    category: 'spyware',
    severity: 'high',
    status: 'removed',
    detectedAt: daysAgo(7),
    removedAt: daysAgo(6),
    filePath: 'C:\\Windows\\Temp\\driver.dll',
    hash: '0f23d8a9c8b7d6e5f4a3b2c1d0e9f8a7'
  },
  {
    id: '9d8d32ed-7b85-4a69-8aef-3c2c53b4d216',
    deviceId: 'c27b4b8a-2f9d-4ef1-82b9-1d3ac3a7cb04',
    deviceName: 'AUS-SRV-011',
    orgId: '22222222-2222-2222-2222-222222222222',
    providerId: 'prov-bitdefender',
    name: 'PUP.Linux.Miner',
    category: 'pup',
    severity: 'medium',
    status: 'quarantined',
    detectedAt: daysAgo(9),
    quarantinedAt: daysAgo(8),
    filePath: '/tmp/miner.sh',
    hash: '9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d'
  }
];

const scanSeed = new Map<string, ScanRecord[]>([
  [
    '0f4b0e2b-9c3f-4a8d-9a2a-6b8f1e2a9a01',
    [
      {
        id: '0e64a8cb-2f12-4b6a-a5c4-4698c001a201',
        deviceId: '0f4b0e2b-9c3f-4a8d-9a2a-6b8f1e2a9a01',
        deviceName: 'NYC-LT-014',
        orgId: '11111111-1111-1111-1111-111111111111',
        scanType: 'quick',
        status: 'completed',
        startedAt: hoursAgo(20),
        finishedAt: hoursAgo(19),
        threatsFound: 0,
        durationSeconds: 420
      }
    ]
  ],
  [
    '6e69f4aa-7a2d-42b9-9a2b-7682f0f48a02',
    [
      {
        id: '7a5fb780-0cd5-4e26-8246-bd3da83a1202',
        deviceId: '6e69f4aa-7a2d-42b9-9a2b-7682f0f48a02',
        deviceName: 'SFO-WS-207',
        orgId: '11111111-1111-1111-1111-111111111111',
        scanType: 'full',
        status: 'completed',
        startedAt: daysAgo(3),
        finishedAt: daysAgo(3),
        threatsFound: 2,
        durationSeconds: 3100
      },
      {
        id: '13cb4b1a-84b2-4a9b-9c3f-4b7e7d6c3203',
        deviceId: '6e69f4aa-7a2d-42b9-9a2b-7682f0f48a02',
        deviceName: 'SFO-WS-207',
        orgId: '11111111-1111-1111-1111-111111111111',
        scanType: 'quick',
        status: 'failed',
        startedAt: daysAgo(1),
        finishedAt: daysAgo(1),
        threatsFound: 0,
        durationSeconds: 120
      }
    ]
  ],
  [
    'a3f83e6f-1d3b-49d5-b8a2-949df92b2e03',
    [
      {
        id: '662f03ea-1e3d-4b13-9f35-901c0e1b4104',
        deviceId: 'a3f83e6f-1d3b-49d5-b8a2-949df92b2e03',
        deviceName: 'LON-LT-332',
        orgId: '22222222-2222-2222-2222-222222222222',
        scanType: 'quick',
        status: 'completed',
        startedAt: hoursAgo(12),
        finishedAt: hoursAgo(11),
        threatsFound: 1,
        durationSeconds: 520
      }
    ]
  ]
]);

const policySeed: SecurityPolicy[] = [
  {
    id: '4ec46f1a-43cf-4c78-b0f2-6bf28d694201',
    name: 'Workstation Baseline',
    description: 'Daily quick scans and auto quarantine for endpoints.',
    providerId: 'prov-defender',
    scanSchedule: 'daily',
    realTimeProtection: true,
    autoQuarantine: true,
    severityThreshold: 'medium',
    exclusions: ['C:\\Program Files\\TrustedApp'],
    createdAt: daysAgo(14),
    updatedAt: daysAgo(2)
  },
  {
    id: 'f3e13eb3-8ad4-4d87-82d6-b3eb9455a202',
    name: 'Server Hardened Policy',
    description: 'Weekly full scans with stricter thresholds.',
    providerId: 'prov-bitdefender',
    scanSchedule: 'weekly',
    realTimeProtection: true,
    autoQuarantine: false,
    severityThreshold: 'high',
    exclusions: ['/var/lib/docker'],
    createdAt: daysAgo(30),
    updatedAt: daysAgo(7)
  }
];

const providerById = new Map(securityProviders.map((provider) => [provider.id, provider]));
const statusByDeviceId = new Map(securityStatuses.map((status) => [status.deviceId, status]));
const threatStore = new Map(threatSeed.map((threat) => [threat.id, threat]));
const scanStore = new Map(scanSeed);
const policyStore = new Map(policySeed.map((policy) => [policy.id, policy]));

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

function paginate<T>(items: T[], page: number, limit: number) {
  const total = items.length;
  const totalPages = total === 0 ? 1 : Math.ceil(total / limit);
  const offset = (page - 1) * limit;
  return {
    data: items.slice(offset, offset + limit),
    pagination: { page, limit, total, totalPages }
  };
}

function parseDateRange(startDate?: string, endDate?: string) {
  let start: Date | undefined;
  let end: Date | undefined;

  if (startDate) {
    const parsed = new Date(startDate);
    if (Number.isNaN(parsed.getTime())) {
      return { error: 'Invalid startDate' };
    }
    start = parsed;
  }

  if (endDate) {
    const parsed = new Date(endDate);
    if (Number.isNaN(parsed.getTime())) {
      return { error: 'Invalid endDate' };
    }
    end = parsed;
  }

  if (start && end && start > end) {
    return { error: 'startDate must be before endDate' };
  }

  return { start, end };
}

function matchDateRange(value: string, start?: Date, end?: Date) {
  const dateValue = new Date(value);
  if (Number.isNaN(dateValue.getTime())) {
    return false;
  }
  if (start && dateValue < start) {
    return false;
  }
  if (end && dateValue > end) {
    return false;
  }
  return true;
}

function withProvider<T extends { providerId: string }>(item: T) {
  return {
    ...item,
    provider: providerById.get(item.providerId) ?? null
  };
}

const listStatusQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  providerId: z.string().optional(),
  status: z.enum(['protected', 'at_risk', 'unprotected', 'offline']).optional(),
  riskLevel: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  os: z.enum(['windows', 'macos', 'linux']).optional(),
  orgId: z.string().uuid().optional(),
  search: z.string().optional()
});

const deviceIdParamSchema = z.object({
  deviceId: z.string().uuid()
});

const threatIdParamSchema = z.object({
  id: z.string().uuid()
});

const listThreatsQuerySchema = z.object({
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

const scanRequestSchema = z.object({
  scanType: z.enum(['quick', 'full', 'custom'])
});

const listScansQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  status: z.enum(['queued', 'running', 'completed', 'failed']).optional(),
  scanType: z.enum(['quick', 'full', 'custom']).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional()
});

const listPoliciesQuerySchema = z.object({
  providerId: z.string().optional(),
  scanSchedule: z.enum(['daily', 'weekly', 'monthly', 'manual']).optional(),
  search: z.string().optional()
});

const createPolicySchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  providerId: z.string().optional(),
  scanSchedule: z.enum(['daily', 'weekly', 'monthly', 'manual']).default('weekly'),
  realTimeProtection: z.boolean().default(true),
  autoQuarantine: z.boolean().default(true),
  severityThreshold: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  exclusions: z.array(z.string().min(1)).optional().default([])
});

const dashboardQuerySchema = z.object({
  orgId: z.string().uuid().optional()
});

securityRoutes.use('*', authMiddleware);

securityRoutes.get(
  '/status',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listStatusQuerySchema),
  (c) => {
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);

    let results = securityStatuses;

    if (query.providerId) {
      results = results.filter((status) => status.providerId === query.providerId);
    }

    if (query.status) {
      results = results.filter((status) => status.status === query.status);
    }

    if (query.riskLevel) {
      results = results.filter((status) => status.riskLevel === query.riskLevel);
    }

    if (query.os) {
      results = results.filter((status) => status.os === query.os);
    }

    if (query.orgId) {
      results = results.filter((status) => status.orgId === query.orgId);
    }

    if (query.search) {
      const term = query.search.toLowerCase();
      results = results.filter((status) => {
        const providerName = providerById.get(status.providerId)?.name.toLowerCase() ?? '';
        return (
          status.deviceName.toLowerCase().includes(term) ||
          status.deviceId.toLowerCase().includes(term) ||
          providerName.includes(term)
        );
      });
    }

    const response = paginate(results.map(withProvider), page, limit);
    return c.json(response);
  }
);

securityRoutes.get(
  '/status/:deviceId',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deviceIdParamSchema),
  (c) => {
    const { deviceId } = c.req.valid('param');
    const status = statusByDeviceId.get(deviceId);

    if (!status) {
      return c.json({ error: 'Device not found' }, 404);
    }

    return c.json({ data: withProvider(status) });
  }
);

securityRoutes.get(
  '/threats',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listThreatsQuerySchema),
  (c) => {
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);
    const dateRange = parseDateRange(query.startDate, query.endDate);

    if ('error' in dateRange) {
      return c.json({ error: dateRange.error }, 400);
    }

    let results = Array.from(threatStore.values());

    if (query.severity) {
      results = results.filter((threat) => threat.severity === query.severity);
    }

    if (query.status) {
      results = results.filter((threat) => threat.status === query.status);
    }

    if (query.category) {
      results = results.filter((threat) => threat.category === query.category);
    }

    if (query.providerId) {
      results = results.filter((threat) => threat.providerId === query.providerId);
    }

    if (query.orgId) {
      results = results.filter((threat) => threat.orgId === query.orgId);
    }

    if (dateRange.start || dateRange.end) {
      results = results.filter((threat) => matchDateRange(threat.detectedAt, dateRange.start, dateRange.end));
    }

    if (query.search) {
      const term = query.search.toLowerCase();
      results = results.filter((threat) => {
        return (
          threat.name.toLowerCase().includes(term) ||
          threat.deviceName.toLowerCase().includes(term) ||
          threat.filePath.toLowerCase().includes(term)
        );
      });
    }

    const response = paginate(results.map(withProvider), page, limit);
    return c.json(response);
  }
);

securityRoutes.get(
  '/threats/:deviceId',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', listThreatsQuerySchema),
  (c) => {
    const { deviceId } = c.req.valid('param');
    const query = c.req.valid('query');

    if (!statusByDeviceId.has(deviceId)) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const { page, limit } = getPagination(query);
    const dateRange = parseDateRange(query.startDate, query.endDate);

    if ('error' in dateRange) {
      return c.json({ error: dateRange.error }, 400);
    }

    let results = Array.from(threatStore.values()).filter((threat) => threat.deviceId === deviceId);

    if (query.severity) {
      results = results.filter((threat) => threat.severity === query.severity);
    }

    if (query.status) {
      results = results.filter((threat) => threat.status === query.status);
    }

    if (query.category) {
      results = results.filter((threat) => threat.category === query.category);
    }

    if (query.providerId) {
      results = results.filter((threat) => threat.providerId === query.providerId);
    }

    if (query.orgId) {
      results = results.filter((threat) => threat.orgId === query.orgId);
    }

    if (dateRange.start || dateRange.end) {
      results = results.filter((threat) => matchDateRange(threat.detectedAt, dateRange.start, dateRange.end));
    }

    if (query.search) {
      const term = query.search.toLowerCase();
      results = results.filter((threat) => {
        return (
          threat.name.toLowerCase().includes(term) ||
          threat.filePath.toLowerCase().includes(term)
        );
      });
    }

    const response = paginate(results.map(withProvider), page, limit);
    return c.json(response);
  }
);

securityRoutes.post(
  '/threats/:id/quarantine',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', threatIdParamSchema),
  (c) => {
    const { id } = c.req.valid('param');
    const threat = threatStore.get(id);

    if (!threat) {
      return c.json({ error: 'Threat not found' }, 404);
    }

    if (threat.status === 'removed') {
      return c.json({ error: 'Threat already removed' }, 400);
    }

    if (threat.status === 'quarantined') {
      return c.json({ error: 'Threat already quarantined' }, 400);
    }

    const updated: Threat = {
      ...threat,
      status: 'quarantined',
      quarantinedAt: new Date().toISOString()
    };
    threatStore.set(id, updated);

    return c.json({ data: withProvider(updated) });
  }
);

securityRoutes.post(
  '/threats/:id/restore',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', threatIdParamSchema),
  (c) => {
    const { id } = c.req.valid('param');
    const threat = threatStore.get(id);

    if (!threat) {
      return c.json({ error: 'Threat not found' }, 404);
    }

    if (threat.status !== 'quarantined') {
      return c.json({ error: 'Threat is not quarantined' }, 400);
    }

    const updated: Threat = {
      ...threat,
      status: 'active',
      restoredAt: new Date().toISOString()
    };
    threatStore.set(id, updated);

    return c.json({ data: withProvider(updated) });
  }
);

securityRoutes.post(
  '/threats/:id/remove',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', threatIdParamSchema),
  (c) => {
    const { id } = c.req.valid('param');
    const threat = threatStore.get(id);

    if (!threat) {
      return c.json({ error: 'Threat not found' }, 404);
    }

    if (threat.status === 'removed') {
      return c.json({ error: 'Threat already removed' }, 400);
    }

    const updated: Threat = {
      ...threat,
      status: 'removed',
      removedAt: new Date().toISOString()
    };
    threatStore.set(id, updated);

    return c.json({ data: withProvider(updated) });
  }
);

securityRoutes.post(
  '/scan/:deviceId',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deviceIdParamSchema),
  zValidator('json', scanRequestSchema),
  (c) => {
    const { deviceId } = c.req.valid('param');
    const payload = c.req.valid('json');
    const status = statusByDeviceId.get(deviceId);

    if (!status) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const scan: ScanRecord = {
      id: randomUUID(),
      deviceId,
      deviceName: status.deviceName,
      orgId: status.orgId,
      scanType: payload.scanType,
      status: 'queued',
      startedAt: new Date().toISOString(),
      threatsFound: 0
    };

    const deviceScans = scanStore.get(deviceId) ?? [];
    deviceScans.unshift(scan);
    scanStore.set(deviceId, deviceScans);

    return c.json({ data: scan }, 202);
  }
);

securityRoutes.get(
  '/scans/:deviceId',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', listScansQuerySchema),
  (c) => {
    const { deviceId } = c.req.valid('param');
    const query = c.req.valid('query');

    if (!statusByDeviceId.has(deviceId)) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const { page, limit } = getPagination(query);
    const dateRange = parseDateRange(query.startDate, query.endDate);

    if ('error' in dateRange) {
      return c.json({ error: dateRange.error }, 400);
    }

    let scans = scanStore.get(deviceId) ?? [];

    if (query.status) {
      scans = scans.filter((scan) => scan.status === query.status);
    }

    if (query.scanType) {
      scans = scans.filter((scan) => scan.scanType === query.scanType);
    }

    if (dateRange.start || dateRange.end) {
      scans = scans.filter((scan) => matchDateRange(scan.startedAt, dateRange.start, dateRange.end));
    }

    const response = paginate(scans, page, limit);
    return c.json(response);
  }
);

securityRoutes.get(
  '/policies',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listPoliciesQuerySchema),
  (c) => {
    const query = c.req.valid('query');
    let policies = Array.from(policyStore.values());

    if (query.providerId) {
      policies = policies.filter((policy) => policy.providerId === query.providerId);
    }

    if (query.scanSchedule) {
      policies = policies.filter((policy) => policy.scanSchedule === query.scanSchedule);
    }

    if (query.search) {
      const term = query.search.toLowerCase();
      policies = policies.filter((policy) => {
        return (
          policy.name.toLowerCase().includes(term) ||
          policy.description?.toLowerCase().includes(term)
        );
      });
    }

    return c.json({ data: policies });
  }
);

securityRoutes.post(
  '/policies',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createPolicySchema),
  (c) => {
    const payload = c.req.valid('json');

    if (payload.providerId && !providerById.has(payload.providerId)) {
      return c.json({ error: 'Unknown providerId' }, 400);
    }

    const timestamp = new Date().toISOString();
    const policy: SecurityPolicy = {
      id: randomUUID(),
      name: payload.name,
      description: payload.description,
      providerId: payload.providerId,
      scanSchedule: payload.scanSchedule,
      realTimeProtection: payload.realTimeProtection,
      autoQuarantine: payload.autoQuarantine,
      severityThreshold: payload.severityThreshold,
      exclusions: payload.exclusions ?? [],
      createdAt: timestamp,
      updatedAt: timestamp
    };

    policyStore.set(policy.id, policy);

    return c.json({ data: policy }, 201);
  }
);

securityRoutes.get(
  '/dashboard',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', dashboardQuerySchema),
  (c) => {
    const query = c.req.valid('query');
    const filteredStatuses = query.orgId
      ? securityStatuses.filter((status) => status.orgId === query.orgId)
      : securityStatuses;
    const filteredThreats = query.orgId
      ? Array.from(threatStore.values()).filter((threat) => threat.orgId === query.orgId)
      : Array.from(threatStore.values());

    const lastScanAt = filteredStatuses
      .map((status) => status.lastScanAt)
      .sort()
      .at(-1) ?? null;

    const providerCoverage = securityProviders.map((provider) => {
      const deviceCount = filteredStatuses.filter((status) => status.providerId === provider.id).length;
      const coverage = filteredStatuses.length === 0 ? 0 : Math.round((deviceCount / filteredStatuses.length) * 100);
      return {
        providerId: provider.id,
        providerName: provider.name,
        deviceCount,
        coverage
      };
    });

    const stats: DashboardStats = {
      totalDevices: filteredStatuses.length,
      protectedDevices: filteredStatuses.filter((status) => status.status === 'protected').length,
      atRiskDevices: filteredStatuses.filter((status) => status.status === 'at_risk').length,
      unprotectedDevices: filteredStatuses.filter((status) => status.status === 'unprotected').length,
      offlineDevices: filteredStatuses.filter((status) => status.status === 'offline').length,
      totalThreatsDetected: filteredThreats.length,
      activeThreats: filteredThreats.filter((threat) => threat.status === 'active').length,
      quarantinedThreats: filteredThreats.filter((threat) => threat.status === 'quarantined').length,
      removedThreats: filteredThreats.filter((threat) => threat.status === 'removed').length,
      lastScanAt,
      providers: providerCoverage
    };

    return c.json({ data: stats });
  }
);
