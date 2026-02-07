import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware, requireScope } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';

export const softwareRoutes = new Hono();

type Platform = 'windows' | 'macos' | 'linux';
type SoftwareCategory =
  | 'browser'
  | 'utility'
  | 'compression'
  | 'productivity'
  | 'communication'
  | 'developer'
  | 'media'
  | 'security';
type LicenseType = 'free' | 'commercial' | 'open-source';
type DeploymentAction = 'install' | 'uninstall' | 'update';
type DeploymentStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

interface Device {
  id: string;
  name: string;
  os: Platform;
}

interface SoftwareCatalogItem {
  id: string;
  name: string;
  vendor: string;
  category: SoftwareCategory;
  description: string;
  platforms: Platform[];
  latestVersion: string;
  homepage: string;
  licenseType: LicenseType;
  tags: string[];
  deprecated: boolean;
  createdAt: string;
  updatedAt: string;
}

interface SoftwareVersion {
  id: string;
  softwareId: string;
  version: string;
  releaseDate: string;
  notes?: string;
  downloadUrl: string;
  sha256?: string;
  sizeMB?: number;
  supportedPlatforms: Platform[];
}

interface Deployment {
  id: string;
  softwareId: string;
  softwareName: string;
  action: DeploymentAction;
  status: DeploymentStatus;
  version?: string;
  deviceIds: string[];
  requestedBy: string;
  requestReason?: string;
  requestedAt: string;
  scheduledAt?: string;
  completedAt?: string;
  cancelReason?: string;
}

interface DeploymentResult {
  deploymentId: string;
  deviceId: string;
  status: DeploymentStatus;
  message: string;
  startedAt?: string;
  completedAt?: string;
}

interface DeviceInventoryItem {
  softwareId: string;
  name: string;
  version: string;
  installedAt: string;
  source: string;
  pendingUninstall?: boolean;
}

interface DeviceInventory {
  deviceId: string;
  deviceName: string;
  os: Platform;
  lastScannedAt: string;
  items: DeviceInventoryItem[];
}

const devices: [Device, Device, Device] = [
  {
    id: 'a3f1c7d2-5b3c-4fa8-b7e9-1b2a3c4d5e6f',
    name: 'WIN-SEA-01',
    os: 'windows'
  },
  {
    id: 'b4e2d8f3-6c4d-4b9e-9f10-2a3b4c5d6e7f',
    name: 'MAC-NYC-14',
    os: 'macos'
  },
  {
    id: 'c5f3e9a4-7d5e-4c10-a111-3b4c5d6e7f80',
    name: 'UBU-LON-22',
    os: 'linux'
  }
];

const softwareCatalog: SoftwareCatalogItem[] = [
  {
    id: 'sw-001',
    name: 'Google Chrome',
    vendor: 'Google',
    category: 'browser',
    description: 'Enterprise-ready browser with centralized policy support.',
    platforms: ['windows', 'macos', 'linux'],
    latestVersion: '121.0.6167.161',
    homepage: 'https://www.google.com/chrome/',
    licenseType: 'free',
    tags: ['browser', 'google', 'chromium', 'managed'],
    deprecated: false,
    createdAt: '2024-01-10T12:00:00.000Z',
    updatedAt: '2024-03-01T08:30:00.000Z'
  },
  {
    id: 'sw-002',
    name: 'Mozilla Firefox',
    vendor: 'Mozilla',
    category: 'browser',
    description: 'Open source browser with rapid security releases.',
    platforms: ['windows', 'macos', 'linux'],
    latestVersion: '122.0.1',
    homepage: 'https://www.mozilla.org/firefox/',
    licenseType: 'open-source',
    tags: ['browser', 'mozilla', 'privacy'],
    deprecated: false,
    createdAt: '2024-01-12T14:00:00.000Z',
    updatedAt: '2024-03-04T09:15:00.000Z'
  },
  {
    id: 'sw-003',
    name: '7-Zip',
    vendor: 'Igor Pavlov',
    category: 'compression',
    description: 'High compression archive tool for Windows endpoints.',
    platforms: ['windows'],
    latestVersion: '23.01',
    homepage: 'https://www.7-zip.org/',
    licenseType: 'free',
    tags: ['compression', 'archive', 'utility'],
    deprecated: false,
    createdAt: '2024-01-18T10:30:00.000Z',
    updatedAt: '2024-02-20T16:45:00.000Z'
  },
  {
    id: 'sw-004',
    name: 'Visual Studio Code',
    vendor: 'Microsoft',
    category: 'developer',
    description: 'Lightweight editor with extensions and remote workflows.',
    platforms: ['windows', 'macos', 'linux'],
    latestVersion: '1.86.2',
    homepage: 'https://code.visualstudio.com/',
    licenseType: 'free',
    tags: ['developer', 'editor', 'extensions'],
    deprecated: false,
    createdAt: '2024-01-20T09:00:00.000Z',
    updatedAt: '2024-03-02T12:00:00.000Z'
  },
  {
    id: 'sw-005',
    name: 'Slack',
    vendor: 'Slack Technologies',
    category: 'communication',
    description: 'Team messaging and collaboration platform.',
    platforms: ['windows', 'macos', 'linux'],
    latestVersion: '4.36.140',
    homepage: 'https://slack.com/',
    licenseType: 'commercial',
    tags: ['communication', 'chat', 'collaboration'],
    deprecated: false,
    createdAt: '2024-02-01T13:15:00.000Z',
    updatedAt: '2024-03-05T11:10:00.000Z'
  },
  {
    id: 'sw-006',
    name: 'Zoom',
    vendor: 'Zoom Video Communications',
    category: 'communication',
    description: 'Video conferencing client with enterprise controls.',
    platforms: ['windows', 'macos', 'linux'],
    latestVersion: '5.17.7',
    homepage: 'https://zoom.us/',
    licenseType: 'commercial',
    tags: ['communication', 'video', 'meetings'],
    deprecated: false,
    createdAt: '2024-02-05T15:40:00.000Z',
    updatedAt: '2024-03-06T10:20:00.000Z'
  },
  {
    id: 'sw-007',
    name: 'VLC Media Player',
    vendor: 'VideoLAN',
    category: 'media',
    description: 'Cross-platform media player with broad codec support.',
    platforms: ['windows', 'macos', 'linux'],
    latestVersion: '3.0.20',
    homepage: 'https://www.videolan.org/vlc/',
    licenseType: 'open-source',
    tags: ['media', 'player', 'video'],
    deprecated: false,
    createdAt: '2024-02-08T09:50:00.000Z',
    updatedAt: '2024-03-03T14:25:00.000Z'
  }
];

const softwareVersions: SoftwareVersion[] = [
  {
    id: 'ver-001',
    softwareId: 'sw-001',
    version: '121.0.6167.161',
    releaseDate: '2024-02-13T00:00:00.000Z',
    notes: 'Security fixes and stability improvements.',
    downloadUrl: 'https://dl.google.com/chrome/install/enterprise/chrome_121.msi',
    sha256: 'b3f1a7c2e4d5f60718293a4b5c6d7e8f9012a3b4c5d6e7f8091a2b3c4d5e6f70',
    sizeMB: 108,
    supportedPlatforms: ['windows', 'macos', 'linux']
  },
  {
    id: 'ver-002',
    softwareId: 'sw-001',
    version: '120.0.6099.234',
    releaseDate: '2024-01-18T00:00:00.000Z',
    notes: 'Policy updates for enterprise deployments.',
    downloadUrl: 'https://dl.google.com/chrome/install/enterprise/chrome_120.msi',
    sha256: 'd7a1b2c3d4e5f60718293a4b5c6d7e8f9012a3b4c5d6e7f8091a2b3c4d5e6f70',
    sizeMB: 106,
    supportedPlatforms: ['windows', 'macos', 'linux']
  },
  {
    id: 'ver-003',
    softwareId: 'sw-002',
    version: '122.0.1',
    releaseDate: '2024-02-29T00:00:00.000Z',
    notes: 'Security release with policy improvements.',
    downloadUrl: 'https://download.mozilla.org/firefox/releases/122.0.1/Firefox.msi',
    sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012a3b4c5d6e7f8091a2b3c4d5e6f70b',
    sizeMB: 56,
    supportedPlatforms: ['windows', 'macos', 'linux']
  },
  {
    id: 'ver-004',
    softwareId: 'sw-003',
    version: '23.01',
    releaseDate: '2024-01-25T00:00:00.000Z',
    notes: 'Performance improvements and bug fixes.',
    downloadUrl: 'https://www.7-zip.org/a/7z2301-x64.msi',
    sha256: 'c1b2c3d4e5f60718293a4b5c6d7e8f9012a3b4c5d6e7f8091a2b3c4d5e6f70c',
    sizeMB: 1.5,
    supportedPlatforms: ['windows']
  },
  {
    id: 'ver-005',
    softwareId: 'sw-004',
    version: '1.86.2',
    releaseDate: '2024-02-22T00:00:00.000Z',
    notes: 'Extension host updates and UI fixes.',
    downloadUrl: 'https://update.code.visualstudio.com/1.86.2/win32-x64/stable',
    sha256: 'e1b2c3d4e5f60718293a4b5c6d7e8f9012a3b4c5d6e7f8091a2b3c4d5e6f70d',
    sizeMB: 92,
    supportedPlatforms: ['windows', 'macos', 'linux']
  },
  {
    id: 'ver-006',
    softwareId: 'sw-005',
    version: '4.36.140',
    releaseDate: '2024-02-28T00:00:00.000Z',
    notes: 'Admin control improvements and stability fixes.',
    downloadUrl: 'https://downloads.slack-edge.com/releases/windows/SlackSetup.msi',
    sha256: 'f1b2c3d4e5f60718293a4b5c6d7e8f9012a3b4c5d6e7f8091a2b3c4d5e6f70e',
    sizeMB: 115,
    supportedPlatforms: ['windows', 'macos', 'linux']
  },
  {
    id: 'ver-007',
    softwareId: 'sw-006',
    version: '5.17.7',
    releaseDate: '2024-02-26T00:00:00.000Z',
    notes: 'Security improvements for video meetings.',
    downloadUrl: 'https://zoom.us/client/latest/ZoomInstallerFull.msi',
    sha256: 'b1b2c3d4e5f60718293a4b5c6d7e8f9012a3b4c5d6e7f8091a2b3c4d5e6f70f',
    sizeMB: 94,
    supportedPlatforms: ['windows', 'macos', 'linux']
  },
  {
    id: 'ver-008',
    softwareId: 'sw-007',
    version: '3.0.20',
    releaseDate: '2024-01-11T00:00:00.000Z',
    notes: 'Maintenance release with playback fixes.',
    downloadUrl: 'https://get.videolan.org/vlc/3.0.20/win64/vlc-3.0.20.msi',
    sha256: 'c2b2c3d4e5f60718293a4b5c6d7e8f9012a3b4c5d6e7f8091a2b3c4d5e6f701',
    sizeMB: 41,
    supportedPlatforms: ['windows', 'macos', 'linux']
  }
];

const deployments: Deployment[] = [
  {
    id: 'dep-001',
    softwareId: 'sw-001',
    softwareName: 'Google Chrome',
    action: 'update',
    status: 'completed',
    version: '121.0.6167.161',
    deviceIds: [devices[0].id, devices[1].id],
    requestedBy: 'ops@breeze.local',
    requestedAt: '2024-03-01T09:00:00.000Z',
    completedAt: '2024-03-01T09:45:00.000Z'
  },
  {
    id: 'dep-002',
    softwareId: 'sw-004',
    softwareName: 'Visual Studio Code',
    action: 'install',
    status: 'running',
    version: '1.86.2',
    deviceIds: [devices[2].id],
    requestedBy: 'devops@breeze.local',
    requestedAt: '2024-03-05T16:20:00.000Z'
  },
  {
    id: 'dep-003',
    softwareId: 'sw-006',
    softwareName: 'Zoom',
    action: 'uninstall',
    status: 'pending',
    version: '5.17.7',
    deviceIds: [devices[1].id],
    requestedBy: 'it@breeze.local',
    requestedAt: '2024-03-06T11:35:00.000Z'
  }
];

const deploymentResults: DeploymentResult[] = [
  {
    deploymentId: 'dep-001',
    deviceId: devices[0].id,
    status: 'completed',
    message: 'Updated successfully.',
    startedAt: '2024-03-01T09:02:00.000Z',
    completedAt: '2024-03-01T09:08:00.000Z'
  },
  {
    deploymentId: 'dep-001',
    deviceId: devices[1].id,
    status: 'completed',
    message: 'Updated successfully.',
    startedAt: '2024-03-01T09:10:00.000Z',
    completedAt: '2024-03-01T09:40:00.000Z'
  },
  {
    deploymentId: 'dep-002',
    deviceId: devices[2].id,
    status: 'running',
    message: 'Installer executing.',
    startedAt: '2024-03-05T16:25:00.000Z'
  },
  {
    deploymentId: 'dep-003',
    deviceId: devices[1].id,
    status: 'pending',
    message: 'Queued for next check-in.'
  }
];

const softwareInventory: DeviceInventory[] = [
  {
    deviceId: devices[0].id,
    deviceName: devices[0].name,
    os: devices[0].os,
    lastScannedAt: '2024-03-04T08:10:00.000Z',
    items: [
      {
        softwareId: 'sw-001',
        name: 'Google Chrome',
        version: '121.0.6167.161',
        installedAt: '2024-03-01T09:08:00.000Z',
        source: 'deployment'
      },
      {
        softwareId: 'sw-003',
        name: '7-Zip',
        version: '23.01',
        installedAt: '2024-02-02T11:00:00.000Z',
        source: 'baseline'
      }
    ]
  },
  {
    deviceId: devices[1].id,
    deviceName: devices[1].name,
    os: devices[1].os,
    lastScannedAt: '2024-03-06T10:00:00.000Z',
    items: [
      {
        softwareId: 'sw-001',
        name: 'Google Chrome',
        version: '121.0.6167.161',
        installedAt: '2024-03-01T09:40:00.000Z',
        source: 'deployment'
      },
      {
        softwareId: 'sw-006',
        name: 'Zoom',
        version: '5.17.7',
        installedAt: '2023-12-15T14:30:00.000Z',
        source: 'user'
      }
    ]
  },
  {
    deviceId: devices[2].id,
    deviceName: devices[2].name,
    os: devices[2].os,
    lastScannedAt: '2024-03-05T16:30:00.000Z',
    items: [
      {
        softwareId: 'sw-004',
        name: 'Visual Studio Code',
        version: '1.86.2',
        installedAt: '2024-03-05T16:28:00.000Z',
        source: 'deployment'
      },
      {
        softwareId: 'sw-007',
        name: 'VLC Media Player',
        version: '3.0.20',
        installedAt: '2024-02-10T09:15:00.000Z',
        source: 'baseline'
      }
    ]
  }
];

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

function generateId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

function matchesSearch(item: SoftwareCatalogItem, term: string | undefined) {
  if (!term) return true;
  const haystack = [
    item.name,
    item.vendor,
    item.description,
    item.category,
    item.tags.join(' ')
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(term.toLowerCase());
}

const categorySchema = z.enum([
  'browser',
  'utility',
  'compression',
  'productivity',
  'communication',
  'developer',
  'media',
  'security'
]);

const platformSchema = z.enum(['windows', 'macos', 'linux']);

const listCatalogSchema = z.object({
  search: z.string().optional(),
  q: z.string().optional(),
  category: categorySchema.optional(),
  platform: platformSchema.optional(),
  page: z.string().optional(),
  limit: z.string().optional()
});

const catalogSearchSchema = z.object({
  q: z.string().min(1),
  category: categorySchema.optional()
});

const catalogIdParamSchema = z.object({
  id: z.string().min(1)
});

const createCatalogSchema = z.object({
  name: z.string().min(1).max(200),
  vendor: z.string().min(1).max(200),
  category: categorySchema,
  description: z.string().min(1).max(1000),
  platforms: z.array(platformSchema).min(1),
  latestVersion: z.string().min(1).max(50),
  homepage: z.string().url(),
  licenseType: z.enum(['free', 'commercial', 'open-source']),
  tags: z.array(z.string().min(1).max(50)).optional(),
  deprecated: z.boolean().optional()
});

const updateCatalogSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  vendor: z.string().min(1).max(200).optional(),
  category: categorySchema.optional(),
  description: z.string().min(1).max(1000).optional(),
  platforms: z.array(platformSchema).min(1).optional(),
  latestVersion: z.string().min(1).max(50).optional(),
  homepage: z.string().url().optional(),
  licenseType: z.enum(['free', 'commercial', 'open-source']).optional(),
  tags: z.array(z.string().min(1).max(50)).optional(),
  deprecated: z.boolean().optional()
});

const versionParamSchema = z.object({
  id: z.string().min(1)
});

const createVersionSchema = z.object({
  version: z.string().min(1).max(50),
  releaseDate: z.string().datetime(),
  notes: z.string().max(2000).optional(),
  downloadUrl: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i, 'sha256 must be 64 hex characters').optional(),
  sizeMB: z.number().min(0.1).max(2048).optional(),
  supportedPlatforms: z.array(platformSchema).min(1)
});

const listDeploymentsSchema = z.object({
  status: z.enum(['pending', 'queued', 'running', 'completed', 'failed', 'cancelled']).optional(),
  action: z.enum(['install', 'uninstall', 'update']).optional(),
  softwareId: z.string().min(1).optional(),
  deviceId: z.string().uuid().optional(),
  requestedBy: z.string().min(1).optional(),
  page: z.string().optional(),
  limit: z.string().optional()
});

const deploymentIdParamSchema = z.object({
  id: z.string().min(1)
});

const createDeploymentSchema = z.object({
  softwareId: z.string().min(1),
  action: z.enum(['install', 'uninstall', 'update']),
  version: z.string().min(1).max(50).optional(),
  deviceIds: z.array(z.string().uuid()).min(1),
  requestedBy: z.string().min(1).max(200),
  reason: z.string().max(500).optional(),
  scheduleAt: z.string().datetime().optional()
});

const cancelDeploymentSchema = z.object({
  reason: z.string().max(500).optional()
});

const listInventorySchema = z.object({
  deviceId: z.string().uuid().optional(),
  softwareId: z.string().min(1).optional(),
  search: z.string().min(1).optional()
});

const inventoryParamSchema = z.object({
  deviceId: z.string().uuid()
});

const inventoryUninstallParamSchema = z.object({
  deviceId: z.string().uuid(),
  softwareId: z.string().min(1)
});

const uninstallRequestSchema = z.object({
  requestedBy: z.string().min(1).max(200),
  reason: z.string().max(500).optional(),
  scheduleAt: z.string().datetime().optional()
});

softwareRoutes.use('*', authMiddleware);

// GET /catalog - List catalog items with search, category filter
softwareRoutes.get(
  '/catalog',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listCatalogSchema),
  (c) => {
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);
    const searchTerm = query.search ?? query.q;
    const filtered = softwareCatalog.filter((item) => {
      if (!matchesSearch(item, searchTerm)) return false;
      if (query.category && item.category !== query.category) return false;
      if (query.platform && !item.platforms.includes(query.platform)) return false;
      return true;
    });

    return c.json({
      data: filtered.slice(offset, offset + limit),
      pagination: { page, limit, total: filtered.length }
    });
  }
);

// POST /catalog - Add catalog item
softwareRoutes.post(
  '/catalog',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createCatalogSchema),
  (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');
    const now = new Date().toISOString();
    const item: SoftwareCatalogItem = {
      id: generateId('sw'),
      name: payload.name,
      vendor: payload.vendor,
      category: payload.category,
      description: payload.description,
      platforms: payload.platforms,
      latestVersion: payload.latestVersion,
      homepage: payload.homepage,
      licenseType: payload.licenseType,
      tags: payload.tags ?? [],
      deprecated: payload.deprecated ?? false,
      createdAt: now,
      updatedAt: now
    };

    softwareCatalog.push(item);
    writeRouteAudit(c, {
      orgId: auth.orgId,
      action: 'software.catalog.create',
      resourceType: 'software_catalog_item',
      resourceId: item.id,
      resourceName: item.name,
      details: {
        vendor: item.vendor,
        latestVersion: item.latestVersion,
      },
    });
    return c.json({ data: item }, 201);
  }
);

// GET /catalog/search?q= - Search catalog
softwareRoutes.get(
  '/catalog/search',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', catalogSearchSchema),
  (c) => {
    const query = c.req.valid('query');
    const matches = softwareCatalog.filter((item) => {
      if (!matchesSearch(item, query.q)) return false;
      if (query.category && item.category !== query.category) return false;
      return true;
    });

    return c.json({ data: matches, total: matches.length });
  }
);

// GET /catalog/:id/versions - List versions for catalog item
softwareRoutes.get(
  '/catalog/:id/versions',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', versionParamSchema),
  (c) => {
    const { id } = c.req.valid('param');
    const item = softwareCatalog.find((entry) => entry.id === id);
    if (!item) {
      return c.json({ error: 'Catalog item not found' }, 404);
    }

    const versions = softwareVersions
      .filter((version) => version.softwareId === id)
      .sort((a, b) => b.releaseDate.localeCompare(a.releaseDate));

    return c.json({ data: versions });
  }
);

// POST /catalog/:id/versions - Add new version
softwareRoutes.post(
  '/catalog/:id/versions',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', versionParamSchema),
  zValidator('json', createVersionSchema),
  (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');
    const item = softwareCatalog.find((entry) => entry.id === id);
    if (!item) {
      return c.json({ error: 'Catalog item not found' }, 404);
    }

    const version: SoftwareVersion = {
      id: generateId('ver'),
      softwareId: id,
      version: payload.version,
      releaseDate: payload.releaseDate,
      notes: payload.notes,
      downloadUrl: payload.downloadUrl,
      sha256: payload.sha256,
      sizeMB: payload.sizeMB,
      supportedPlatforms: payload.supportedPlatforms
    };

    softwareVersions.push(version);
    item.latestVersion = payload.version;
    item.updatedAt = new Date().toISOString();

    writeRouteAudit(c, {
      orgId: auth.orgId,
      action: 'software.catalog.version.create',
      resourceType: 'software_version',
      resourceId: version.id,
      resourceName: item.name,
      details: {
        softwareId: id,
        version: version.version,
      },
    });

    return c.json({ data: version }, 201);
  }
);

// GET /catalog/:id - Get catalog item details
softwareRoutes.get(
  '/catalog/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', catalogIdParamSchema),
  (c) => {
    const { id } = c.req.valid('param');
    const item = softwareCatalog.find((entry) => entry.id === id);
    if (!item) {
      return c.json({ error: 'Catalog item not found' }, 404);
    }

    const versionCount = softwareVersions.filter((entry) => entry.softwareId === id).length;
    return c.json({ data: { ...item, versionCount } });
  }
);

// PATCH /catalog/:id - Update catalog item
softwareRoutes.patch(
  '/catalog/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', catalogIdParamSchema),
  zValidator('json', updateCatalogSchema),
  (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');
    const item = softwareCatalog.find((entry) => entry.id === id);
    if (!item) {
      return c.json({ error: 'Catalog item not found' }, 404);
    }

    Object.assign(item, payload, { updatedAt: new Date().toISOString() });
    writeRouteAudit(c, {
      orgId: auth.orgId,
      action: 'software.catalog.update',
      resourceType: 'software_catalog_item',
      resourceId: item.id,
      resourceName: item.name,
      details: {
        updatedFields: Object.keys(payload),
      },
    });
    return c.json({ data: item });
  }
);

// DELETE /catalog/:id - Remove catalog item
softwareRoutes.delete(
  '/catalog/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', catalogIdParamSchema),
  (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const index = softwareCatalog.findIndex((entry) => entry.id === id);
    if (index === -1) {
      return c.json({ error: 'Catalog item not found' }, 404);
    }

    const removed = softwareCatalog[index]!;
    softwareCatalog.splice(index, 1);
    for (let i = softwareVersions.length - 1; i >= 0; i -= 1) {
      if ((softwareVersions[i]?.softwareId ?? '') === id) {
        softwareVersions.splice(i, 1);
      }
    }

    writeRouteAudit(c, {
      orgId: auth.orgId,
      action: 'software.catalog.delete',
      resourceType: 'software_catalog_item',
      resourceId: removed.id,
      resourceName: removed.name,
    });

    return c.json({ success: true, id });
  }
);

// GET /deployments - List deployments with filters
softwareRoutes.get(
  '/deployments',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listDeploymentsSchema),
  (c) => {
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);
    const filtered = deployments.filter((deployment) => {
      if (query.status && deployment.status !== query.status) return false;
      if (query.action && deployment.action !== query.action) return false;
      if (query.softwareId && deployment.softwareId !== query.softwareId) return false;
      if (query.deviceId && !deployment.deviceIds.includes(query.deviceId)) return false;
      if (query.requestedBy && deployment.requestedBy !== query.requestedBy) return false;
      return true;
    });

    return c.json({
      data: filtered.slice(offset, offset + limit),
      pagination: { page, limit, total: filtered.length }
    });
  }
);

// POST /deployments - Create deployment (install/uninstall/update)
softwareRoutes.post(
  '/deployments',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createDeploymentSchema),
  (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');
    const item = softwareCatalog.find((entry) => entry.id === payload.softwareId);
    if (!item) {
      return c.json({ error: 'Catalog item not found' }, 404);
    }

    const now = new Date().toISOString();
    const deployment: Deployment = {
      id: generateId('dep'),
      softwareId: item.id,
      softwareName: item.name,
      action: payload.action,
      status: payload.scheduleAt ? 'queued' : 'pending',
      version: payload.version ?? item.latestVersion,
      deviceIds: payload.deviceIds,
      requestedBy: payload.requestedBy,
      requestReason: payload.reason,
      requestedAt: now,
      scheduledAt: payload.scheduleAt
    };

    deployments.push(deployment);

    payload.deviceIds.forEach((deviceId) => {
      deploymentResults.push({
        deploymentId: deployment.id,
        deviceId,
        status: deployment.status,
        message: deployment.status === 'queued' ? 'Scheduled deployment.' : 'Queued for execution.'
      });
    });

    writeRouteAudit(c, {
      orgId: auth.orgId,
      action: 'software.deployment.create',
      resourceType: 'software_deployment',
      resourceId: deployment.id,
      resourceName: deployment.softwareName,
      details: {
        softwareId: deployment.softwareId,
        action: deployment.action,
        deviceCount: deployment.deviceIds.length,
      },
    });

    return c.json({ data: deployment }, 201);
  }
);

// GET /deployments/:id - Get deployment details
softwareRoutes.get(
  '/deployments/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deploymentIdParamSchema),
  (c) => {
    const { id } = c.req.valid('param');
    const deployment = deployments.find((entry) => entry.id === id);
    if (!deployment) {
      return c.json({ error: 'Deployment not found' }, 404);
    }

    return c.json({ data: deployment });
  }
);

// POST /deployments/:id/cancel - Cancel pending deployment
softwareRoutes.post(
  '/deployments/:id/cancel',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deploymentIdParamSchema),
  zValidator('json', cancelDeploymentSchema),
  (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');
    const deployment = deployments.find((entry) => entry.id === id);
    if (!deployment) {
      return c.json({ error: 'Deployment not found' }, 404);
    }

    if (deployment.status !== 'pending' && deployment.status !== 'queued') {
      return c.json({ error: 'Deployment cannot be cancelled' }, 409);
    }

    deployment.status = 'cancelled';
    deployment.cancelReason = payload.reason;
    deployment.completedAt = new Date().toISOString();

    deploymentResults.forEach((result) => {
      if (result.deploymentId === deployment.id && result.status !== 'completed') {
        result.status = 'cancelled';
        result.message = payload.reason ?? 'Cancelled by operator.';
        result.completedAt = deployment.completedAt;
      }
    });

    writeRouteAudit(c, {
      orgId: auth.orgId,
      action: 'software.deployment.cancel',
      resourceType: 'software_deployment',
      resourceId: deployment.id,
      resourceName: deployment.softwareName,
      details: {
        previousStatus: 'pending_or_queued',
        reason: payload.reason,
      },
    });

    return c.json({ data: deployment });
  }
);

// GET /deployments/:id/results - Get per-device results
softwareRoutes.get(
  '/deployments/:id/results',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deploymentIdParamSchema),
  (c) => {
    const { id } = c.req.valid('param');
    const deployment = deployments.find((entry) => entry.id === id);
    if (!deployment) {
      return c.json({ error: 'Deployment not found' }, 404);
    }

    const results = deploymentResults.filter((result) => result.deploymentId === id);
    return c.json({ data: results });
  }
);

// GET /inventory - List all software inventory
softwareRoutes.get(
  '/inventory',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listInventorySchema),
  (c) => {
    const query = c.req.valid('query');
    let filtered = softwareInventory;

    if (query.deviceId) {
      filtered = filtered.filter((entry) => entry.deviceId === query.deviceId);
    }

    if (query.softwareId) {
      filtered = filtered.filter((entry) =>
        entry.items.some((item) => item.softwareId === query.softwareId)
      );
    }

    if (query.search) {
      const term = query.search.toLowerCase();
      filtered = filtered.filter((entry) => {
        const deviceMatch = entry.deviceName.toLowerCase().includes(term);
        const itemMatch = entry.items.some((item) => item.name.toLowerCase().includes(term));
        return deviceMatch || itemMatch;
      });
    }

    return c.json({ data: filtered, total: filtered.length });
  }
);

// GET /inventory/:deviceId - Get device software inventory
softwareRoutes.get(
  '/inventory/:deviceId',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', inventoryParamSchema),
  (c) => {
    const { deviceId } = c.req.valid('param');
    const inventory = softwareInventory.find((entry) => entry.deviceId === deviceId);
    if (!inventory) {
      return c.json({ error: 'Device inventory not found' }, 404);
    }

    return c.json({ data: inventory });
  }
);

// POST /inventory/:deviceId/:softwareId/uninstall - Queue uninstall
softwareRoutes.post(
  '/inventory/:deviceId/:softwareId/uninstall',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', inventoryUninstallParamSchema),
  zValidator('json', uninstallRequestSchema),
  (c) => {
    const auth = c.get('auth');
    const { deviceId, softwareId } = c.req.valid('param');
    const payload = c.req.valid('json');
    const inventory = softwareInventory.find((entry) => entry.deviceId === deviceId);
    if (!inventory) {
      return c.json({ error: 'Device inventory not found' }, 404);
    }

    const item = inventory.items.find((entry) => entry.softwareId === softwareId);
    if (!item) {
      return c.json({ error: 'Software not found on device' }, 404);
    }

    const catalogItem = softwareCatalog.find((entry) => entry.id === softwareId);
    if (!catalogItem) {
      return c.json({ error: 'Catalog item not found' }, 404);
    }

    item.pendingUninstall = true;

    const now = new Date().toISOString();
    const deployment: Deployment = {
      id: generateId('dep'),
      softwareId: catalogItem.id,
      softwareName: catalogItem.name,
      action: 'uninstall',
      status: payload.scheduleAt ? 'queued' : 'pending',
      version: item.version,
      deviceIds: [deviceId],
      requestedBy: payload.requestedBy,
      requestReason: payload.reason,
      requestedAt: now,
      scheduledAt: payload.scheduleAt
    };

    deployments.push(deployment);
    deploymentResults.push({
      deploymentId: deployment.id,
      deviceId,
      status: deployment.status,
      message: payload.reason ?? 'Queued uninstall request.'
    });

    writeRouteAudit(c, {
      orgId: auth.orgId,
      action: 'software.uninstall.queue',
      resourceType: 'software_deployment',
      resourceId: deployment.id,
      resourceName: catalogItem.name,
      details: {
        deviceId,
        softwareId,
      },
    });

    return c.json({ data: deployment }, 202);
  }
);
