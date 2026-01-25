import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware, requireScope } from '../middleware/auth';

export const discoveryRoutes = new Hono();

type DiscoveryProfile = {
  id: string;
  orgId: string;
  name: string;
  subnets: string[];
  methods: string[];
  schedule: {
    type: 'manual' | 'cron' | 'interval';
    cron?: string;
    intervalMinutes?: number;
  };
  createdAt: string;
  updatedAt: string;
};

type DiscoveryJob = {
  id: string;
  orgId: string;
  profileId: string;
  agentId: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed';
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  results: Array<{
    assetId: string;
    status: 'new' | 'linked' | 'ignored';
    assetType: string;
  }>;
};

type DiscoveryAsset = {
  id: string;
  orgId: string;
  assetType: 'device' | 'printer' | 'router' | 'switch' | 'unknown';
  status: 'new' | 'linked' | 'ignored';
  hostname: string | null;
  ipAddress: string | null;
  macAddress: string | null;
  linkedDeviceId: string | null;
  ignoredReason: string | null;
  createdAt: string;
  updatedAt: string;
};

const discoveryProfiles: DiscoveryProfile[] = [
  {
    id: 'profile-001',
    orgId: '00000000-0000-0000-0000-000000000000',
    name: 'Default Discovery',
    subnets: ['10.0.0.0/24', '10.0.1.0/24'],
    methods: ['ping', 'arp'],
    schedule: { type: 'interval', intervalMinutes: 60 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
];

const discoveryAssets: DiscoveryAsset[] = [
  {
    id: 'asset-001',
    orgId: '00000000-0000-0000-0000-000000000000',
    assetType: 'device',
    status: 'new',
    hostname: 'printer-01',
    ipAddress: '10.0.0.42',
    macAddress: 'AA:BB:CC:DD:EE:01',
    linkedDeviceId: null,
    ignoredReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    id: 'asset-002',
    orgId: '00000000-0000-0000-0000-000000000000',
    assetType: 'router',
    status: 'linked',
    hostname: 'core-router',
    ipAddress: '10.0.0.1',
    macAddress: 'AA:BB:CC:DD:EE:02',
    linkedDeviceId: 'device-123',
    ignoredReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
];

const discoveryJobs: DiscoveryJob[] = [
  {
    id: 'job-001',
    orgId: '00000000-0000-0000-0000-000000000000',
    profileId: 'profile-001',
    agentId: null,
    status: 'completed',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    results: [
      { assetId: 'asset-001', status: 'new', assetType: 'device' },
      { assetId: 'asset-002', status: 'linked', assetType: 'router' }
    ]
  }
];

function canAccessOrg(auth: { scope: string; orgId: string | null }, orgId: string) {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }

  return true;
}

function resolveOrgId(
  auth: { scope: string; orgId: string | null },
  requestedOrgId?: string,
  requireForNonOrg = false
) {
  if (auth.scope === 'organization') {
    if (!auth.orgId) {
      return { error: 'Organization context required', status: 403 } as const;
    }

    if (requestedOrgId && requestedOrgId !== auth.orgId) {
      return { error: 'Access to this organization denied', status: 403 } as const;
    }

    return { orgId: auth.orgId } as const;
  }

  if (requireForNonOrg && !requestedOrgId) {
    return { error: 'orgId is required', status: 400 } as const;
  }

  return { orgId: requestedOrgId ?? null } as const;
}

const listProfilesSchema = z.object({
  orgId: z.string().uuid().optional()
});

const scheduleSchema = z.object({
  type: z.enum(['manual', 'cron', 'interval']),
  cron: z.string().min(1).optional(),
  intervalMinutes: z.number().int().positive().optional()
}).refine((data) => {
  if (data.type === 'cron') return Boolean(data.cron);
  if (data.type === 'interval') return Boolean(data.intervalMinutes);
  return true;
}, { message: 'Schedule details required for selected type' });

const createProfileSchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1).max(255).optional(),
  subnets: z.array(z.string().min(1)).min(1),
  methods: z.array(z.string().min(1)).min(1),
  schedule: scheduleSchema
});

const updateProfileSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  subnets: z.array(z.string().min(1)).min(1).optional(),
  methods: z.array(z.string().min(1)).min(1).optional(),
  schedule: scheduleSchema.optional()
});

const scanSchema = z.object({
  profileId: z.string().min(1),
  agentId: z.string().uuid().optional()
});

const listJobsSchema = z.object({
  orgId: z.string().uuid().optional()
});

const listAssetsSchema = z.object({
  orgId: z.string().uuid().optional(),
  status: z.enum(['new', 'linked', 'ignored']).optional(),
  assetType: z.enum(['device', 'printer', 'router', 'switch', 'unknown']).optional()
});

const linkAssetSchema = z.object({
  deviceId: z.string().uuid()
});

const ignoreAssetSchema = z.object({
  reason: z.string().max(1000).optional()
});

const topologyQuerySchema = z.object({
  orgId: z.string().uuid().optional()
});

discoveryRoutes.use('*', authMiddleware);

// GET /profiles - List discovery profiles for org
discoveryRoutes.get(
  '/profiles',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listProfilesSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth, query.orgId, false);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    // Filter profiles based on org access
    let data;
    if (orgResult.orgId) {
      // Specific org requested
      data = discoveryProfiles.filter(profile => profile.orgId === orgResult.orgId);
    } else if (auth.scope === 'organization' && auth.orgId) {
      // Org-scoped user - show their org's profiles
      data = discoveryProfiles.filter(profile => profile.orgId === auth.orgId);
    } else {
      // Partner/system - show all accessible profiles (for now, all of them)
      data = discoveryProfiles;
    }
    return c.json({ data });
  }
);

// POST /profiles - Create profile with subnets, methods, schedule
discoveryRoutes.post(
  '/profiles',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createProfileSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    const orgResult = resolveOrgId(auth, body.orgId, true);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const now = new Date().toISOString();
    const profile: DiscoveryProfile = {
      id: `profile-${Date.now()}`,
      orgId: orgResult.orgId as string,
      name: body.name ?? `Discovery Profile ${discoveryProfiles.length + 1}`,
      subnets: body.subnets,
      methods: body.methods,
      schedule: body.schedule,
      createdAt: now,
      updatedAt: now
    };

    discoveryProfiles.push(profile);
    return c.json(profile, 201);
  }
);

// GET /profiles/:id - Get profile details
discoveryRoutes.get(
  '/profiles/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const profileId = c.req.param('id');
    const profile = discoveryProfiles.find(item => item.id === profileId);

    if (!profile || !canAccessOrg(auth, profile.orgId)) {
      return c.json({ error: 'Profile not found' }, 404);
    }

    return c.json(profile);
  }
);

// PATCH /profiles/:id - Update profile
discoveryRoutes.patch(
  '/profiles/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateProfileSchema),
  async (c) => {
    const auth = c.get('auth');
    const profileId = c.req.param('id');
    const updates = c.req.valid('json');

    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    const profile = discoveryProfiles.find(item => item.id === profileId);
    if (!profile || !canAccessOrg(auth, profile.orgId)) {
      return c.json({ error: 'Profile not found' }, 404);
    }

    const profileIndex = discoveryProfiles.indexOf(profile);
    const now = new Date().toISOString();
    const updated: DiscoveryProfile = {
      id: profile.id,
      orgId: profile.orgId,
      createdAt: profile.createdAt,
      name: updates.name ?? profile.name,
      subnets: updates.subnets ?? profile.subnets,
      methods: updates.methods ?? profile.methods,
      schedule: updates.schedule ?? profile.schedule,
      updatedAt: now
    };

    discoveryProfiles[profileIndex] = updated;
    return c.json(updated);
  }
);

// DELETE /profiles/:id - Delete profile
discoveryRoutes.delete(
  '/profiles/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const profileId = c.req.param('id');
    const profile = discoveryProfiles.find(item => item.id === profileId);

    if (!profile || !canAccessOrg(auth, profile.orgId)) {
      return c.json({ error: 'Profile not found' }, 404);
    }

    const profileIndex = discoveryProfiles.indexOf(profile);
    discoveryProfiles.splice(profileIndex, 1);
    return c.json({ success: true });
  }
);

// POST /scan - Trigger discovery scan with profileId, optional agentId
discoveryRoutes.post(
  '/scan',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', scanSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    const profile = discoveryProfiles.find(item => item.id === body.profileId);

    if (!profile || !canAccessOrg(auth, profile.orgId)) {
      return c.json({ error: 'Profile not found' }, 404);
    }

    const now = new Date().toISOString();
    const job: DiscoveryJob = {
      id: `job-${Date.now()}`,
      orgId: profile.orgId,
      profileId: profile.id,
      agentId: body.agentId ?? null,
      status: 'queued',
      createdAt: now,
      startedAt: null,
      completedAt: null,
      results: []
    };

    discoveryJobs.push(job);
    return c.json(job, 201);
  }
);

// GET /jobs - List discovery jobs
discoveryRoutes.get(
  '/jobs',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listJobsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth, query.orgId, true);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const data = discoveryJobs.filter(job => job.orgId === orgResult.orgId);
    return c.json({ data });
  }
);

// GET /jobs/:id - Get job details with results
discoveryRoutes.get(
  '/jobs/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const jobId = c.req.param('id');
    const job = discoveryJobs.find(item => item.id === jobId);

    if (!job || !canAccessOrg(auth, job.orgId)) {
      return c.json({ error: 'Job not found' }, 404);
    }

    return c.json({
      ...job,
      assets: job.results.map(result => discoveryAssets.find(asset => asset.id === result.assetId)).filter(Boolean)
    });
  }
);

// GET /assets - List discovered assets with filters (status, assetType)
discoveryRoutes.get(
  '/assets',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listAssetsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth, query.orgId, true);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const data = discoveryAssets.filter(asset => asset.orgId === orgResult.orgId).filter(asset => {
      if (query.status && asset.status !== query.status) return false;
      if (query.assetType && asset.assetType !== query.assetType) return false;
      return true;
    });

    return c.json({ data });
  }
);

// POST /assets/:id/link - Link asset to managed device
discoveryRoutes.post(
  '/assets/:id/link',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', linkAssetSchema),
  async (c) => {
    const auth = c.get('auth');
    const assetId = c.req.param('id');
    const body = c.req.valid('json');
    const asset = discoveryAssets.find(item => item.id === assetId);

    if (!asset || !canAccessOrg(auth, asset.orgId)) {
      return c.json({ error: 'Asset not found' }, 404);
    }

    const assetIndex = discoveryAssets.indexOf(asset);
    const now = new Date().toISOString();
    const updated: DiscoveryAsset = {
      ...asset,
      status: 'linked',
      linkedDeviceId: body.deviceId,
      ignoredReason: null,
      updatedAt: now
    };

    discoveryAssets[assetIndex] = updated;
    return c.json(updated);
  }
);

// POST /assets/:id/ignore - Ignore asset
discoveryRoutes.post(
  '/assets/:id/ignore',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', ignoreAssetSchema),
  async (c) => {
    const auth = c.get('auth');
    const assetId = c.req.param('id');
    const body = c.req.valid('json');
    const asset = discoveryAssets.find(item => item.id === assetId);

    if (!asset || !canAccessOrg(auth, asset.orgId)) {
      return c.json({ error: 'Asset not found' }, 404);
    }

    const assetIndex = discoveryAssets.indexOf(asset);
    const now = new Date().toISOString();
    const updated: DiscoveryAsset = {
      ...asset,
      status: 'ignored',
      linkedDeviceId: null,
      ignoredReason: body.reason ?? asset.ignoredReason,
      updatedAt: now
    };

    discoveryAssets[assetIndex] = updated;
    return c.json(updated);
  }
);

// GET /topology - Get network topology nodes and edges
discoveryRoutes.get(
  '/topology',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', topologyQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth, query.orgId, true);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, orgResult.status);
    }

    const assets = discoveryAssets.filter(asset => asset.orgId === orgResult.orgId);
    const nodes = assets.map(asset => ({
      id: asset.id,
      type: asset.assetType,
      label: asset.hostname ?? asset.ipAddress ?? asset.id
    }));

    return c.json({ nodes, edges: [] });
  }
);
