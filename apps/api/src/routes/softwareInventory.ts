import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, sql, desc, asc, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  devices,
  softwareInventory,
  softwarePolicies,
} from '../db/schema';
import { authMiddleware, requireScope, type AuthContext } from '../middleware/auth';

export const softwareInventoryRoutes = new Hono();

softwareInventoryRoutes.use('*', authMiddleware);
softwareInventoryRoutes.use('*', requireScope('organization', 'partner', 'system'));

// ============================================
// Query Schemas
// ============================================

const listQuerySchema = z.object({
  search: z.string().optional(),
  vendor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  sortBy: z.enum(['name', 'vendor', 'deviceCount', 'lastSeen']).default('deviceCount'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

const approveSchema = z.object({
  softwareName: z.string().min(1).max(500),
  vendor: z.string().max(200).optional(),
});

const denySchema = z.object({
  softwareName: z.string().min(1).max(500),
  vendor: z.string().max(200).optional(),
});

const deviceDrilldownQuerySchema = z.object({
  vendor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// ============================================
// Helpers
// ============================================

function resolveOrgId(auth: AuthContext): string | null {
  if (auth.orgId) return auth.orgId;
  if (Array.isArray(auth.accessibleOrgIds) && auth.accessibleOrgIds.length === 1) {
    return auth.accessibleOrgIds[0] ?? null;
  }
  return null;
}

type PolicyStatus = 'allowed' | 'blocked' | 'audit' | 'no_policy';

async function getPolicyStatusMap(orgId: string): Promise<Map<string, PolicyStatus>> {
  const policies = await db
    .select({
      mode: softwarePolicies.mode,
      rules: softwarePolicies.rules,
      isActive: softwarePolicies.isActive,
    })
    .from(softwarePolicies)
    .where(and(eq(softwarePolicies.orgId, orgId), eq(softwarePolicies.isActive, true)));

  const statusMap = new Map<string, PolicyStatus>();

  for (const policy of policies) {
    const rules = policy.rules as { software?: Array<{ name: string; vendor?: string }> } | null;
    if (!rules?.software) continue;

    for (const rule of rules.software) {
      const key = `${rule.name.toLowerCase()}|${(rule.vendor ?? '').toLowerCase()}`;
      const status: PolicyStatus =
        policy.mode === 'allowlist' ? 'allowed' :
        policy.mode === 'blocklist' ? 'blocked' : 'audit';
      statusMap.set(key, status);
    }
  }

  return statusMap;
}

// ============================================
// Config Policy Auto-Link Helper
// ============================================

async function ensureDefaultConfigPolicyLink(
  orgId: string,
  softwarePolicyId: string,
  configPolicyName: string,
  userId: string | null
): Promise<void> {
  // Find or create the named config policy for this org
  let [configPolicy] = await db
    .select()
    .from(configurationPolicies)
    .where(
      and(
        eq(configurationPolicies.orgId, orgId),
        eq(configurationPolicies.name, configPolicyName),
        eq(configurationPolicies.status, 'active')
      )
    )
    .limit(1);

  if (!configPolicy) {
    [configPolicy] = await db
      .insert(configurationPolicies)
      .values({
        orgId,
        name: configPolicyName,
        description: 'Auto-created for default software policy',
        status: 'active',
        createdBy: userId,
      })
      .returning();
  }

  if (!configPolicy) return;

  // Upsert the software_policy feature link
  await db
    .insert(configPolicyFeatureLinks)
    .values({
      configPolicyId: configPolicy.id,
      featureType: 'software_policy',
      featurePolicyId: softwarePolicyId,
    })
    .onConflictDoUpdate({
      target: [configPolicyFeatureLinks.configPolicyId, configPolicyFeatureLinks.featureType],
      set: {
        featurePolicyId: softwarePolicyId,
        updatedAt: new Date(),
      },
    });

  // Ensure an org-level assignment exists
  await db
    .insert(configPolicyAssignments)
    .values({
      configPolicyId: configPolicy.id,
      level: 'organization',
      targetId: orgId,
      priority: 0,
      assignedBy: userId,
    })
    .onConflictDoNothing();
}

// ============================================
// GET / — Aggregate inventory
// ============================================

softwareInventoryRoutes.get('/', zValidator('query', listQuerySchema), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const { search, vendor, limit, offset, sortBy, sortOrder } = c.req.valid('query');

  const orgId = resolveOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'Organization context required' }, 400);
  }

  const conditions: SQL[] = [eq(devices.orgId, orgId)];

  if (search) {
    const escaped = search.replace(/[%_\\]/g, '\\$&');
    conditions.push(sql`LOWER(${softwareInventory.name}) LIKE LOWER(${'%' + escaped + '%'})`);
  }
  if (vendor) {
    const escaped = vendor.replace(/[%_\\]/g, '\\$&');
    conditions.push(sql`LOWER(COALESCE(${softwareInventory.vendor}, '')) LIKE LOWER(${'%' + escaped + '%'})`);
  }

  const whereClause = and(...conditions);

  // Count total unique software entries
  const countResult = await db.execute(sql`
    SELECT COUNT(*) AS total FROM (
      SELECT 1
      FROM ${softwareInventory}
      INNER JOIN ${devices} ON ${softwareInventory.deviceId} = ${devices.id}
      WHERE ${whereClause}
      GROUP BY LOWER(${softwareInventory.name}), LOWER(COALESCE(${softwareInventory.vendor}, ''))
    ) sub
  `);
  const total = Number((countResult[0] as { total: string } | undefined)?.total ?? 0);

  // Sort mapping
  const sortColumn =
    sortBy === 'name' ? sql`MIN(${softwareInventory.name})` :
    sortBy === 'vendor' ? sql`MIN(${softwareInventory.vendor})` :
    sortBy === 'lastSeen' ? sql`MAX(${softwareInventory.lastSeen})` :
    sql`COUNT(DISTINCT ${softwareInventory.deviceId})`;

  const orderDir = sortOrder === 'asc' ? sql`ASC` : sql`DESC`;

  const rows = await db.execute(sql`
    SELECT
      MIN(${softwareInventory.name}) AS name,
      MIN(${softwareInventory.vendor}) AS vendor,
      COUNT(DISTINCT ${softwareInventory.deviceId}) AS device_count,
      MIN(${softwareInventory.lastSeen}) AS first_seen,
      MAX(${softwareInventory.lastSeen}) AS last_seen,
      jsonb_agg(DISTINCT jsonb_build_object('version', ${softwareInventory.version}, 'device_id', ${softwareInventory.deviceId}))
        FILTER (WHERE ${softwareInventory.version} IS NOT NULL) AS version_data
    FROM ${softwareInventory}
    INNER JOIN ${devices} ON ${softwareInventory.deviceId} = ${devices.id}
    WHERE ${whereClause}
    GROUP BY LOWER(${softwareInventory.name}), LOWER(COALESCE(${softwareInventory.vendor}, ''))
    ORDER BY ${sortColumn} ${orderDir}
    LIMIT ${limit} OFFSET ${offset}
  `);

  // Build policy status map
  const policyStatusMap = await getPolicyStatusMap(orgId);

  // Process results
  const data = (rows as unknown as Array<{
    name: string;
    vendor: string | null;
    device_count: string;
    first_seen: string | null;
    last_seen: string | null;
    version_data: Array<{ version: string; device_id: string }> | null;
  }>).map((row) => {
    // Collapse version_data into {version, count} pairs
    const versionCounts: Record<string, number> = {};
    if (row.version_data) {
      for (const entry of row.version_data) {
        const v = entry.version || 'Unknown';
        versionCounts[v] = (versionCounts[v] ?? 0) + 1;
      }
    }
    const versions = Object.entries(versionCounts)
      .map(([version, count]) => ({ version, count }))
      .sort((a, b) => b.count - a.count);

    // Check policy status
    const key = `${row.name.toLowerCase()}|${(row.vendor ?? '').toLowerCase()}`;
    const policyStatus: PolicyStatus = policyStatusMap.get(key) ?? 'no_policy';

    return {
      name: row.name,
      vendor: row.vendor,
      deviceCount: Number(row.device_count),
      versions,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      policyStatus,
    };
  });

  return c.json({ data, pagination: { total, limit, offset } });
});

// ============================================
// POST /approve — Quick approve
// ============================================

softwareInventoryRoutes.post('/approve', zValidator('json', approveSchema), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const { softwareName, vendor } = c.req.valid('json');

  const orgId = resolveOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'Organization context required' }, 400);
  }

  // Find or create "Default Allowlist" policy
  const [existing] = await db
    .select()
    .from(softwarePolicies)
    .where(
      and(
        eq(softwarePolicies.orgId, orgId),
        eq(softwarePolicies.name, 'Default Allowlist'),
        eq(softwarePolicies.mode, 'allowlist')
      )
    )
    .limit(1);

  if (existing) {
    const rules = existing.rules as { software: Array<{ name: string; vendor?: string }>; allowUnknown?: boolean };
    // Check if already present
    const alreadyExists = rules.software.some(
      (r) => r.name.toLowerCase() === softwareName.toLowerCase() &&
             (r.vendor ?? '').toLowerCase() === (vendor ?? '').toLowerCase()
    );

    if (!alreadyExists) {
      rules.software.push({ name: softwareName, vendor: vendor || undefined });
      await db
        .update(softwarePolicies)
        .set({ rules, updatedAt: new Date() })
        .where(eq(softwarePolicies.id, existing.id));
    }

    // Ensure config policy link exists
    try {
      await ensureDefaultConfigPolicyLink(orgId, existing.id, 'Default Allowlist Config', auth.user?.id ?? null);
    } catch (err) {
      console.warn('[softwareInventory] Failed to auto-link config policy for Default Allowlist:', err);
    }

    return c.json({ success: true, policyId: existing.id });
  }

  // Create new default allowlist policy
  const [created] = await db
    .insert(softwarePolicies)
    .values({
      orgId,
      name: 'Default Allowlist',
      description: 'Auto-created allowlist for approved software',
      mode: 'allowlist',
      rules: {
        software: [{ name: softwareName, vendor: vendor || undefined }],
        allowUnknown: false,
      },
      isActive: true,
      enforceMode: false,
      createdBy: auth.user?.id ?? null,
    })
    .returning();

  // Auto-link to a config policy so devices can receive this policy
  try {
    await ensureDefaultConfigPolicyLink(orgId, created!.id, 'Default Allowlist Config', auth.user?.id ?? null);
  } catch (err) {
    console.warn('[softwareInventory] Failed to auto-link config policy for Default Allowlist:', err);
  }

  return c.json({ success: true, policyId: created!.id }, 201);
});

// ============================================
// POST /deny — Quick deny
// ============================================

softwareInventoryRoutes.post('/deny', zValidator('json', denySchema), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const { softwareName, vendor } = c.req.valid('json');

  const orgId = resolveOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'Organization context required' }, 400);
  }

  // Find or create "Default Blocklist" policy
  const [existing] = await db
    .select()
    .from(softwarePolicies)
    .where(
      and(
        eq(softwarePolicies.orgId, orgId),
        eq(softwarePolicies.name, 'Default Blocklist'),
        eq(softwarePolicies.mode, 'blocklist')
      )
    )
    .limit(1);

  if (existing) {
    const rules = existing.rules as { software: Array<{ name: string; vendor?: string }>; allowUnknown?: boolean };
    const alreadyExists = rules.software.some(
      (r) => r.name.toLowerCase() === softwareName.toLowerCase() &&
             (r.vendor ?? '').toLowerCase() === (vendor ?? '').toLowerCase()
    );

    if (!alreadyExists) {
      rules.software.push({ name: softwareName, vendor: vendor || undefined });
      await db
        .update(softwarePolicies)
        .set({ rules, updatedAt: new Date() })
        .where(eq(softwarePolicies.id, existing.id));
    }

    // Ensure config policy link exists
    try {
      await ensureDefaultConfigPolicyLink(orgId, existing.id, 'Default Blocklist Config', auth.user?.id ?? null);
    } catch (err) {
      console.warn('[softwareInventory] Failed to auto-link config policy for Default Blocklist:', err);
    }

    return c.json({ success: true, policyId: existing.id });
  }

  const [created] = await db
    .insert(softwarePolicies)
    .values({
      orgId,
      name: 'Default Blocklist',
      description: 'Auto-created blocklist for denied software',
      mode: 'blocklist',
      rules: {
        software: [{ name: softwareName, vendor: vendor || undefined }],
      },
      isActive: true,
      enforceMode: false,
      createdBy: auth.user?.id ?? null,
    })
    .returning();

  // Auto-link to a config policy so devices can receive this policy
  try {
    await ensureDefaultConfigPolicyLink(orgId, created!.id, 'Default Blocklist Config', auth.user?.id ?? null);
  } catch (err) {
    console.warn('[softwareInventory] Failed to auto-link config policy for Default Blocklist:', err);
  }

  return c.json({ success: true, policyId: created!.id }, 201);
});

// ============================================
// POST /clear — Remove from allowlist/blocklist
// ============================================

softwareInventoryRoutes.post('/clear', zValidator('json', approveSchema), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const { softwareName, vendor } = c.req.valid('json');

  const orgId = resolveOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'Organization context required' }, 400);
  }

  // Remove from both Default Allowlist and Default Blocklist
  const defaults = await db
    .select()
    .from(softwarePolicies)
    .where(
      and(
        eq(softwarePolicies.orgId, orgId),
        eq(softwarePolicies.isActive, true),
        sql`${softwarePolicies.name} IN ('Default Allowlist', 'Default Blocklist')`
      )
    );

  let cleared = false;
  for (const policy of defaults) {
    const rules = policy.rules as { software: Array<{ name: string; vendor?: string }>; allowUnknown?: boolean };
    if (!rules?.software) continue;

    const before = rules.software.length;
    rules.software = rules.software.filter(
      (r) =>
        !(r.name.toLowerCase() === softwareName.toLowerCase() &&
          (r.vendor ?? '').toLowerCase() === (vendor ?? '').toLowerCase())
    );

    if (rules.software.length < before) {
      cleared = true;
      await db
        .update(softwarePolicies)
        .set({ rules, updatedAt: new Date() })
        .where(eq(softwarePolicies.id, policy.id));
    }
  }

  return c.json({ success: true, cleared });
});

// ============================================
// GET /:name/devices — Device drill-down
// ============================================

softwareInventoryRoutes.get('/:name/devices', zValidator('query', deviceDrilldownQuerySchema), async (c) => {
  const auth = c.get('auth') as AuthContext;
  const softwareName = decodeURIComponent(c.req.param('name'));
  const { vendor, limit, offset } = c.req.valid('query');

  const orgId = resolveOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'Organization context required' }, 400);
  }

  const conditions: SQL[] = [
    eq(devices.orgId, orgId),
    sql`LOWER(${softwareInventory.name}) = LOWER(${softwareName})`,
  ];

  if (vendor) {
    conditions.push(sql`LOWER(COALESCE(${softwareInventory.vendor}, '')) = LOWER(${vendor})`);
  }

  const whereClause = and(...conditions);

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(softwareInventory)
    .innerJoin(devices, eq(softwareInventory.deviceId, devices.id))
    .where(whereClause);
  const total = Number(countResult[0]?.count ?? 0);

  const rows = await db
    .select({
      deviceId: devices.id,
      hostname: devices.hostname,
      osType: devices.osType,
      osVersion: devices.osVersion,
      version: softwareInventory.version,
      lastSeen: softwareInventory.lastSeen,
    })
    .from(softwareInventory)
    .innerJoin(devices, eq(softwareInventory.deviceId, devices.id))
    .where(whereClause)
    .orderBy(desc(softwareInventory.lastSeen))
    .limit(limit)
    .offset(offset);

  return c.json({
    data: rows,
    pagination: { total, limit, offset },
  });
});
