import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { authMiddleware, requireScope } from '../middleware/auth';

export const patchRoutes = new Hono();

type PatchSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
type PatchOs = 'windows' | 'macos' | 'linux';

const patchCatalog = [
  {
    id: 'patch-001',
    title: 'Windows cumulative update',
    source: 'windows_update',
    severity: 'critical' as PatchSeverity,
    os: 'windows' as PatchOs,
    releasedAt: '2024-02-01T00:00:00.000Z',
    requiresReboot: true,
    description: 'Security rollup for Windows 11.'
  },
  {
    id: 'patch-002',
    title: 'macOS security update',
    source: 'apple_security',
    severity: 'high' as PatchSeverity,
    os: 'macos' as PatchOs,
    releasedAt: '2024-02-10T00:00:00.000Z',
    requiresReboot: true,
    description: 'Security update for macOS.'
  },
  {
    id: 'patch-003',
    title: 'Linux kernel update',
    source: 'linux_vendor',
    severity: 'medium' as PatchSeverity,
    os: 'linux' as PatchOs,
    releasedAt: '2024-02-20T00:00:00.000Z',
    requiresReboot: false,
    description: 'Kernel security update.'
  }
];

const patchSources = [
  { id: 'windows_update', name: 'Windows Update', os: 'windows' as PatchOs },
  { id: 'apple_security', name: 'Apple Security', os: 'macos' as PatchOs },
  { id: 'linux_vendor', name: 'Linux Vendor', os: 'linux' as PatchOs }
];

const patchApprovals = [
  {
    id: 'approval-001',
    patchId: 'patch-001',
    orgId: '00000000-0000-0000-0000-000000000000',
    status: 'approved' as const,
    updatedAt: '2024-02-05T00:00:00.000Z',
    updatedBy: 'system'
  }
];

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

function resolveOrgId(
  auth: { scope: string; orgId: string | null },
  requestedOrgId?: string
) {
  if (auth.scope === 'organization') {
    if (!auth.orgId) {
      return { error: 'Organization context required' } as const;
    }

    if (requestedOrgId && requestedOrgId !== auth.orgId) {
      return { error: 'Access to this organization denied' } as const;
    }

    return { orgId: auth.orgId } as const;
  }

  return { orgId: requestedOrgId ?? null } as const;
}

const listPatchesSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  source: z.string().min(1).max(100).optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
  os: z.enum(['windows', 'macos', 'linux']).optional()
});

const patchIdParamSchema = z.object({
  id: z.string().min(1)
});

const scanSchema = z.object({
  deviceIds: z.array(z.string().uuid()).min(1),
  source: z.string().min(1).max(100).optional()
});

const listSourcesSchema = z.object({
  os: z.enum(['windows', 'macos', 'linux']).optional()
});

const listApprovalsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  status: z.enum(['approved', 'declined', 'deferred', 'pending']).optional(),
  patchId: z.string().min(1).optional()
});

const approvalActionSchema = z.object({
  note: z.string().max(1000).optional()
});

const deferSchema = z.object({
  deferUntil: z.string().datetime(),
  note: z.string().max(1000).optional()
});

const bulkApproveSchema = z.object({
  patchIds: z.array(z.string().min(1)).min(1),
  note: z.string().max(1000).optional()
});

const complianceSchema = z.object({
  orgId: z.string().uuid().optional(),
  source: z.string().min(1).max(100).optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
  os: z.enum(['windows', 'macos', 'linux']).optional()
});

const complianceReportSchema = z.object({
  orgId: z.string().uuid().optional(),
  format: z.enum(['csv', 'pdf']).optional()
});

patchRoutes.use('*', authMiddleware);

// GET /patches - List available patches
patchRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listPatchesSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, 403);
    }

    const { page, limit, offset } = getPagination(query);
    const filtered = patchCatalog.filter((patch) => {
      if (query.source && patch.source !== query.source) return false;
      if (query.severity && patch.severity !== query.severity) return false;
      if (query.os && patch.os !== query.os) return false;
      return true;
    });

    return c.json({
      data: filtered.slice(offset, offset + limit),
      pagination: { page, limit, total: filtered.length }
    });
  }
);

// POST /patches/scan - Trigger patch scan for devices
patchRoutes.post(
  '/scan',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', scanSchema),
  async (c) => {
    const data = c.req.valid('json');
    return c.json({
      success: true,
      jobId: `scan-${Date.now()}`,
      deviceCount: data.deviceIds.length
    });
  }
);

// GET /patches/sources - List available patch sources
patchRoutes.get(
  '/sources',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listSourcesSchema),
  async (c) => {
    const query = c.req.valid('query');
    const sources = query.os ? patchSources.filter((s) => s.os === query.os) : patchSources;
    return c.json({ data: sources });
  }
);

// GET /patches/approvals - List patch approvals for org
patchRoutes.get(
  '/approvals',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listApprovalsSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, 403);
    }

    const { page, limit, offset } = getPagination(query);
    const filtered = patchApprovals.filter((approval) => {
      if (orgResult.orgId && approval.orgId !== orgResult.orgId) return false;
      if (query.status && approval.status !== query.status) return false;
      if (query.patchId && approval.patchId !== query.patchId) return false;
      return true;
    });

    return c.json({
      data: filtered.slice(offset, offset + limit),
      pagination: { page, limit, total: filtered.length }
    });
  }
);

// POST /patches/bulk-approve - Bulk approve patches
patchRoutes.post(
  '/bulk-approve',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', bulkApproveSchema),
  async (c) => {
    const data = c.req.valid('json');
    return c.json({
      success: true,
      approved: data.patchIds,
      failed: []
    });
  }
);

// GET /patches/compliance - Get compliance summary
patchRoutes.get(
  '/compliance',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', complianceSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, 403);
    }

    const approvalsForOrg = patchApprovals.filter((approval) => {
      if (orgResult.orgId && approval.orgId !== orgResult.orgId) return false;
      return true;
    });

    const summary = approvalsForOrg.reduce(
      (acc, approval) => {
        acc.total++;
        acc[approval.status]++;
        return acc;
      },
      { total: 0, approved: 0, declined: 0, deferred: 0, pending: 0 }
    );

    return c.json({
      data: {
        summary,
        filters: {
          source: query.source ?? null,
          severity: query.severity ?? null,
          os: query.os ?? null
        }
      }
    });
  }
);

// GET /patches/compliance/report - Generate compliance report
patchRoutes.get(
  '/compliance/report',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', complianceReportSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgResult = resolveOrgId(auth, query.orgId);
    if ('error' in orgResult) {
      return c.json({ error: orgResult.error }, 403);
    }

    return c.json({
      reportId: `report-${Date.now()}`,
      status: 'queued',
      format: query.format ?? 'csv'
    });
  }
);

// POST /patches/:id/approve - Approve patch
patchRoutes.post(
  '/:id/approve',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', patchIdParamSchema),
  zValidator('json', approvalActionSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const patch = patchCatalog.find((item) => item.id === id);
    if (!patch) {
      return c.json({ error: 'Patch not found' }, 404);
    }

    return c.json({
      id: patch.id,
      status: 'approved'
    });
  }
);

// POST /patches/:id/decline - Decline patch
patchRoutes.post(
  '/:id/decline',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', patchIdParamSchema),
  zValidator('json', approvalActionSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const patch = patchCatalog.find((item) => item.id === id);
    if (!patch) {
      return c.json({ error: 'Patch not found' }, 404);
    }

    return c.json({
      id: patch.id,
      status: 'declined'
    });
  }
);

// POST /patches/:id/defer - Defer patch to later date
patchRoutes.post(
  '/:id/defer',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', patchIdParamSchema),
  zValidator('json', deferSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');
    const patch = patchCatalog.find((item) => item.id === id);
    if (!patch) {
      return c.json({ error: 'Patch not found' }, 404);
    }

    return c.json({
      id: patch.id,
      status: 'deferred',
      deferUntil: data.deferUntil
    });
  }
);

// GET /patches/:id - Get patch details
patchRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', patchIdParamSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const patch = patchCatalog.find((item) => item.id === id);
    if (!patch) {
      return c.json({ error: 'Patch not found' }, 404);
    }

    return c.json(patch);
  }
);
