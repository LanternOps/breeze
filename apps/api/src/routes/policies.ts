import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { authMiddleware, requireScope } from '../middleware/auth';

export const policyRoutes = new Hono();

type PolicyType = 'compliance' | 'security' | 'configuration' | 'monitoring' | 'custom';
type PolicyStatus = 'draft' | 'active' | 'inactive' | 'archived';
type EnforcementLevel = 'monitor' | 'warn' | 'enforce';
type PolicyTargetType = 'all' | 'sites' | 'groups' | 'tags' | 'devices';
type AssignmentTargetType = 'all' | 'org' | 'site' | 'group' | 'tag' | 'device';
type ComplianceStatus = 'compliant' | 'non_compliant' | 'unknown';

type Policy = {
  id: string;
  orgId: string;
  name: string;
  description?: string;
  type: PolicyType;
  status: PolicyStatus;
  enforcementLevel: EnforcementLevel;
  targetType: PolicyTargetType;
  targetIds?: string[];
  rules: Record<string, unknown>[];
  checkIntervalMinutes: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  activatedAt?: Date | null;
  deactivatedAt?: Date | null;
  archivedAt?: Date | null;
};

type PolicySnapshot = {
  name: string;
  description?: string;
  type: PolicyType;
  enforcementLevel: EnforcementLevel;
  targetType: PolicyTargetType;
  targetIds?: string[];
  rules: Record<string, unknown>[];
  checkIntervalMinutes: number;
};

type PolicyVersion = {
  id: string;
  policyId: string;
  version: number;
  snapshot: PolicySnapshot;
  createdAt: Date;
  note?: string;
  rolledBackFrom?: string;
};

type PolicyAssignment = {
  id: string;
  policyId: string;
  targetType: AssignmentTargetType;
  targetId: string;
  createdAt: Date;
};

type Device = {
  id: string;
  orgId: string;
  name: string;
  siteId?: string;
  groupIds?: string[];
  tags?: string[];
};

type DeviceCompliance = {
  deviceId: string;
  deviceName: string;
  status: ComplianceStatus;
  violationCount: number;
  violations: Array<{
    policyId: string;
    policyName: string;
    ruleName: string;
    message: string;
  }>;
  lastCheckedAt: string;
};

type PolicyTemplate = {
  id: string;
  type: PolicyType;
  name: string;
  description?: string;
  defaults: {
    enforcementLevel?: EnforcementLevel;
    targetType?: PolicyTargetType;
    targetIds?: string[];
    rules: Record<string, unknown>[];
    checkIntervalMinutes?: number;
  };
};

const policyTypeSchema = z.enum(['compliance', 'security', 'configuration', 'monitoring', 'custom']);
const policyStatusSchema = z.enum(['draft', 'active', 'inactive', 'archived']);
const enforcementLevelSchema = z.enum(['monitor', 'warn', 'enforce']);
const policyTargetTypeSchema = z.enum(['all', 'sites', 'groups', 'tags', 'devices']);
const assignmentTargetTypeSchema = z.enum(['all', 'org', 'site', 'group', 'tag', 'device']);
const complianceStatusSchema = z.enum(['compliant', 'non_compliant', 'unknown']);

const listPoliciesSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  type: policyTypeSchema.optional(),
  status: policyStatusSchema.optional(),
  orgId: z.string().uuid().optional()
});

const policyRuleSchema = z.record(z.any());

const createPolicySchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  type: policyTypeSchema,
  status: policyStatusSchema.optional(),
  enforcementLevel: enforcementLevelSchema.optional(),
  targetType: policyTargetTypeSchema.optional(),
  targetIds: z.array(z.string().min(1)).optional(),
  rules: z.array(policyRuleSchema).min(1),
  checkIntervalMinutes: z.number().int().min(5).max(1440).optional()
}).superRefine((data, ctx) => {
  if (data.status === 'archived') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Archived status cannot be set on create',
      path: ['status']
    });
  }
  if (data.targetType && data.targetType !== 'all' && (!data.targetIds || data.targetIds.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'targetIds are required when targetType is not all',
      path: ['targetIds']
    });
  }
});

const updatePolicySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  type: policyTypeSchema.optional(),
  status: policyStatusSchema.optional(),
  enforcementLevel: enforcementLevelSchema.optional(),
  targetType: policyTargetTypeSchema.optional(),
  targetIds: z.array(z.string().min(1)).optional(),
  rules: z.array(policyRuleSchema).min(1).optional(),
  checkIntervalMinutes: z.number().int().min(5).max(1440).optional()
});

const policyIdParamSchema = z.object({ id: z.string().uuid() });
const rollbackParamSchema = z.object({ id: z.string().uuid(), versionId: z.string().uuid() });
const assignmentParamSchema = z.object({ id: z.string().uuid(), assignmentId: z.string().uuid() });
const templateParamSchema = z.object({ templateId: z.string().uuid() });
const deviceParamSchema = z.object({ deviceId: z.string().uuid() });

const createAssignmentSchema = z.object({
  targetType: assignmentTargetTypeSchema,
  targetId: z.string().min(1).optional()
}).superRefine((data, ctx) => {
  if (data.targetType !== 'all' && !data.targetId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'targetId is required for the selected targetType',
      path: ['targetId']
    });
  }
});

const listVersionsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional()
});

const listAssignmentsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional()
});

const listComplianceSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  status: complianceStatusSchema.optional()
});

const listTemplatesSchema = z.object({
  type: policyTypeSchema.optional()
});

const createFromTemplateSchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  enforcementLevel: enforcementLevelSchema.optional(),
  targetType: policyTargetTypeSchema.optional(),
  targetIds: z.array(z.string().min(1)).optional(),
  checkIntervalMinutes: z.number().int().min(5).max(1440).optional()
});

const testPolicySchema = z.object({
  deviceId: z.string().uuid(),
  context: z.record(z.any()).optional()
});

const policies = new Map<string, Policy>();
const policyVersions = new Map<string, PolicyVersion[]>();
const policyAssignments = new Map<string, PolicyAssignment[]>();
const policyCompliance = new Map<string, DeviceCompliance[]>();
const devices = new Map<string, Device>();

const defaultOrgId = randomUUID();
const secondaryOrgId = randomUUID();
const defaultSiteId = randomUUID();
const defaultGroupId = randomUUID();
const secureTag = 'secure';

const policyTemplates: PolicyTemplate[] = [
  {
    id: randomUUID(),
    type: 'compliance',
    name: 'Disk Encryption Baseline',
    description: 'Ensure devices have full disk encryption enabled.',
    defaults: {
      enforcementLevel: 'warn',
      targetType: 'all',
      rules: [{ type: 'disk_encryption', required: true }],
      checkIntervalMinutes: 60
    }
  },
  {
    id: randomUUID(),
    type: 'security',
    name: 'Prohibited Software',
    description: 'Detect and remediate prohibited software installs.',
    defaults: {
      enforcementLevel: 'enforce',
      targetType: 'tags',
      targetIds: [secureTag],
      rules: [{ type: 'prohibited_software', softwareName: 'ExampleToolbar' }],
      checkIntervalMinutes: 120
    }
  }
];

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

function snapshotPolicy(policy: Policy): PolicySnapshot {
  return {
    name: policy.name,
    description: policy.description,
    type: policy.type,
    enforcementLevel: policy.enforcementLevel,
    targetType: policy.targetType,
    targetIds: policy.targetIds,
    rules: policy.rules,
    checkIntervalMinutes: policy.checkIntervalMinutes
  };
}

function addPolicyVersion(policy: Policy, note?: string, rolledBackFrom?: string) {
  const versions = policyVersions.get(policy.id) ?? [];
  const versionEntry: PolicyVersion = {
    id: randomUUID(),
    policyId: policy.id,
    version: policy.version,
    snapshot: snapshotPolicy(policy),
    createdAt: new Date(),
    note,
    rolledBackFrom
  };
  versions.unshift(versionEntry);
  policyVersions.set(policy.id, versions);
  return versionEntry;
}

function stableComplianceStatus(seed: string): ComplianceStatus {
  let hash = 0;
  for (const char of seed) {
    hash = (hash + char.charCodeAt(0) * 17) % 100;
  }
  if (hash < 65) return 'compliant';
  if (hash < 85) return 'non_compliant';
  return 'unknown';
}

function getPolicyAssignments(policyId: string) {
  return policyAssignments.get(policyId) ?? [];
}

function doesAssignmentMatchDevice(assignment: PolicyAssignment, device: Device) {
  switch (assignment.targetType) {
    case 'all':
      return true;
    case 'org':
      return assignment.targetId === device.orgId;
    case 'device':
      return assignment.targetId === device.id;
    case 'site':
      return device.siteId === assignment.targetId;
    case 'group':
      return device.groupIds?.includes(assignment.targetId);
    case 'tag':
      return device.tags?.includes(assignment.targetId);
    default:
      return false;
  }
}

function policyMatchesDevice(policy: Policy, device: Device) {
  if (policy.status !== 'active') return false;
  if (policy.targetType === 'all') return true;
  if (policy.targetType === 'devices') return policy.targetIds?.includes(device.id) ?? false;
  if (policy.targetType === 'sites') return policy.targetIds?.includes(device.siteId ?? '') ?? false;
  if (policy.targetType === 'groups') return policy.targetIds?.some((id) => device.groupIds?.includes(id)) ?? false;
  if (policy.targetType === 'tags') return policy.targetIds?.some((id) => device.tags?.includes(id)) ?? false;
  return false;
}

function ensureSeedData() {
  if (policies.size > 0) return;

  const deviceA: Device = {
    id: randomUUID(),
    orgId: defaultOrgId,
    name: 'Atlas-01',
    siteId: defaultSiteId,
    groupIds: [defaultGroupId],
    tags: [secureTag]
  };

  const deviceB: Device = {
    id: randomUUID(),
    orgId: defaultOrgId,
    name: 'Nimbus-02',
    siteId: defaultSiteId,
    groupIds: [defaultGroupId],
    tags: []
  };

  const deviceC: Device = {
    id: randomUUID(),
    orgId: secondaryOrgId,
    name: 'Orion-03',
    tags: ['staging']
  };

  devices.set(deviceA.id, deviceA);
  devices.set(deviceB.id, deviceB);
  devices.set(deviceC.id, deviceC);

  const now = new Date();

  const policyA: Policy = {
    id: randomUUID(),
    orgId: defaultOrgId,
    name: 'Disk Encryption',
    description: 'Ensure disks are encrypted on all endpoints.',
    type: 'compliance',
    status: 'active',
    enforcementLevel: 'warn',
    targetType: 'all',
    rules: [{ type: 'disk_encryption', required: true }],
    checkIntervalMinutes: 60,
    version: 1,
    createdAt: now,
    updatedAt: now,
    activatedAt: now
  };

  const policyB: Policy = {
    id: randomUUID(),
    orgId: defaultOrgId,
    name: 'Prohibited Software',
    description: 'Block known prohibited software titles.',
    type: 'security',
    status: 'draft',
    enforcementLevel: 'enforce',
    targetType: 'tags',
    targetIds: [secureTag],
    rules: [{ type: 'prohibited_software', softwareName: 'ExampleToolbar' }],
    checkIntervalMinutes: 120,
    version: 1,
    createdAt: now,
    updatedAt: now
  };

  const policyC: Policy = {
    id: randomUUID(),
    orgId: secondaryOrgId,
    name: 'Configuration Baseline',
    description: 'Baseline configuration checks for staging.',
    type: 'configuration',
    status: 'inactive',
    enforcementLevel: 'monitor',
    targetType: 'groups',
    targetIds: ['staging-group'],
    rules: [{ type: 'config_check', path: '/etc/example.conf', expected: true }],
    checkIntervalMinutes: 180,
    version: 1,
    createdAt: now,
    updatedAt: now
  };

  policies.set(policyA.id, policyA);
  policies.set(policyB.id, policyB);
  policies.set(policyC.id, policyC);

  addPolicyVersion(policyA, 'Initial version');
  addPolicyVersion(policyB, 'Initial version');
  addPolicyVersion(policyC, 'Initial version');

  policyAssignments.set(policyA.id, [
    {
      id: randomUUID(),
      policyId: policyA.id,
      targetType: 'all',
      targetId: 'all',
      createdAt: now
    }
  ]);
}

policyRoutes.use('*', authMiddleware);

// GET /policies/templates - List policy templates by type
policyRoutes.get(
  '/templates',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listTemplatesSchema),
  (c) => {
    const query = c.req.valid('query');
    const templates = query.type
      ? policyTemplates.filter((template) => template.type === query.type)
      : policyTemplates;
    return c.json({ data: templates });
  }
);

// POST /policies/from-template/:templateId - Create from template
policyRoutes.post(
  '/from-template/:templateId',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', templateParamSchema),
  zValidator('json', createFromTemplateSchema),
  (c) => {
    ensureSeedData();
    const auth = c.get('auth');
    const { templateId } = c.req.valid('param');
    const data = c.req.valid('json');
    const template = policyTemplates.find((item) => item.id === templateId);

    if (!template) {
      return c.json({ error: 'Template not found' }, 404);
    }

    let orgId = data.orgId;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgId = auth.orgId;
    } else if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const targetType = data.targetType ?? template.defaults.targetType ?? 'all';
    const targetIds = data.targetIds ?? template.defaults.targetIds;

    if (targetType !== 'all' && (!targetIds || targetIds.length === 0)) {
      return c.json({ error: 'targetIds are required when targetType is not all' }, 400);
    }

    const now = new Date();
    const policy: Policy = {
      id: randomUUID(),
      orgId: orgId!,
      name: data.name ?? template.name,
      description: data.description ?? template.description,
      type: template.type,
      status: 'draft',
      enforcementLevel: data.enforcementLevel ?? template.defaults.enforcementLevel ?? 'monitor',
      targetType,
      targetIds,
      rules: template.defaults.rules,
      checkIntervalMinutes: data.checkIntervalMinutes ?? template.defaults.checkIntervalMinutes ?? 60,
      version: 1,
      createdAt: now,
      updatedAt: now
    };

    if (policy.targetType === 'all') {
      policy.targetIds = undefined;
    }

    policies.set(policy.id, policy);
    addPolicyVersion(policy, `Created from template ${template.name}`);

    return c.json(policy, 201);
  }
);

// GET /policies/effective/:deviceId - Calculate effective policy for device
policyRoutes.get(
  '/effective/:deviceId',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deviceParamSchema),
  (c) => {
    ensureSeedData();
    const { deviceId } = c.req.valid('param');
    const device = devices.get(deviceId);

    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const effectivePolicies = Array.from(policies.values())
      .filter((policy) => policy.status === 'active' && policy.orgId === device.orgId)
      .map((policy) => {
        const matchedBy: string[] = [];
        if (policyMatchesDevice(policy, device)) {
          matchedBy.push(`targetType:${policy.targetType}`);
        }
        const assignments = getPolicyAssignments(policy.id);
        for (const assignment of assignments) {
          if (doesAssignmentMatchDevice(assignment, device)) {
            matchedBy.push(`assignment:${assignment.targetType}`);
          }
        }
        if (matchedBy.length === 0) {
          return null;
        }
        return {
          policy,
          matchedBy
        };
      })
      .filter((entry): entry is { policy: Policy; matchedBy: string[] } => Boolean(entry));

    return c.json({
      device,
      policies: effectivePolicies,
      count: effectivePolicies.length
    });
  }
);

// GET /policies - List policies with filters
policyRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listPoliciesSchema),
  (c) => {
    ensureSeedData();
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    let data = Array.from(policies.values());

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      data = data.filter((policy) => policy.orgId === auth.orgId);
    } else if (query.orgId) {
      data = data.filter((policy) => policy.orgId === query.orgId);
    }

    if (query.type) {
      data = data.filter((policy) => policy.type === query.type);
    }

    if (query.status) {
      data = data.filter((policy) => policy.status === query.status);
    } else {
      data = data.filter((policy) => policy.status !== 'archived');
    }

    const total = data.length;
    const paged = data.slice(offset, offset + limit);

    return c.json({
      data: paged,
      pagination: { page, limit, total }
    });
  }
);

// POST /policies - Create new policy
policyRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createPolicySchema),
  (c) => {
    ensureSeedData();
    const auth = c.get('auth');
    const data = c.req.valid('json');

    let orgId = data.orgId;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      orgId = auth.orgId;
    } else if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const now = new Date();
    const status = data.status ?? 'draft';

    if (status === 'archived') {
      return c.json({ error: 'Archived status cannot be set on create' }, 400);
    }

    const policy: Policy = {
      id: randomUUID(),
      orgId: orgId!,
      name: data.name,
      description: data.description,
      type: data.type,
      status,
      enforcementLevel: data.enforcementLevel ?? 'monitor',
      targetType: data.targetType ?? 'all',
      targetIds: data.targetIds,
      rules: data.rules,
      checkIntervalMinutes: data.checkIntervalMinutes ?? 60,
      version: 1,
      createdAt: now,
      updatedAt: now,
      activatedAt: status === 'active' ? now : null
    };

    if (policy.targetType === 'all') {
      policy.targetIds = undefined;
    }

    policies.set(policy.id, policy);
    addPolicyVersion(policy, 'Initial version');

    return c.json(policy, 201);
  }
);

// GET /policies/:id/versions - Get version history
policyRoutes.get(
  '/:id/versions',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdParamSchema),
  zValidator('query', listVersionsSchema),
  (c) => {
    ensureSeedData();
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const query = c.req.valid('query');
    const policy = policies.get(id);

    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    if (auth.scope === 'organization' && auth.orgId && policy.orgId !== auth.orgId) {
      return c.json({ error: 'Access to this policy denied' }, 403);
    }

    const versions = policyVersions.get(id) ?? [];
    const { page, limit, offset } = getPagination(query);
    const total = versions.length;
    const data = versions.slice(offset, offset + limit);

    return c.json({
      data,
      pagination: { page, limit, total }
    });
  }
);

// POST /policies/:id/rollback/:versionId - Rollback to version
policyRoutes.post(
  '/:id/rollback/:versionId',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', rollbackParamSchema),
  (c) => {
    ensureSeedData();
    const auth = c.get('auth');
    const { id, versionId } = c.req.valid('param');
    const policy = policies.get(id);

    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    if (auth.scope === 'organization' && auth.orgId && policy.orgId !== auth.orgId) {
      return c.json({ error: 'Access to this policy denied' }, 403);
    }

    if (policy.status === 'archived') {
      return c.json({ error: 'Archived policies cannot be rolled back' }, 400);
    }

    const versions = policyVersions.get(id) ?? [];
    const targetVersion = versions.find((version) => version.id === versionId);

    if (!targetVersion) {
      return c.json({ error: 'Version not found' }, 404);
    }

    policy.name = targetVersion.snapshot.name;
    policy.description = targetVersion.snapshot.description;
    policy.type = targetVersion.snapshot.type;
    policy.enforcementLevel = targetVersion.snapshot.enforcementLevel;
    policy.targetType = targetVersion.snapshot.targetType;
    policy.targetIds = targetVersion.snapshot.targetIds;
    policy.rules = targetVersion.snapshot.rules;
    policy.checkIntervalMinutes = targetVersion.snapshot.checkIntervalMinutes;
    policy.updatedAt = new Date();
    policy.version += 1;

    addPolicyVersion(policy, `Rollback to version ${targetVersion.version}`, targetVersion.id);

    return c.json({
      policy,
      rolledBackTo: targetVersion
    });
  }
);

// GET /policies/:id/assignments - Get policy assignments
policyRoutes.get(
  '/:id/assignments',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdParamSchema),
  zValidator('query', listAssignmentsSchema),
  (c) => {
    ensureSeedData();
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const query = c.req.valid('query');
    const policy = policies.get(id);

    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    if (auth.scope === 'organization' && auth.orgId && policy.orgId !== auth.orgId) {
      return c.json({ error: 'Access to this policy denied' }, 403);
    }

    const assignments = getPolicyAssignments(id);
    const { page, limit, offset } = getPagination(query);
    const total = assignments.length;
    const data = assignments.slice(offset, offset + limit);

    return c.json({
      data,
      pagination: { page, limit, total }
    });
  }
);

// POST /policies/:id/assignments - Create assignment
policyRoutes.post(
  '/:id/assignments',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdParamSchema),
  zValidator('json', createAssignmentSchema),
  (c) => {
    ensureSeedData();
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');
    const policy = policies.get(id);

    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    if (auth.scope === 'organization' && auth.orgId && policy.orgId !== auth.orgId) {
      return c.json({ error: 'Access to this policy denied' }, 403);
    }

    if (policy.status === 'archived') {
      return c.json({ error: 'Archived policies cannot be assigned' }, 400);
    }

    const assignments = getPolicyAssignments(id);
    const targetId = data.targetType === 'all' ? 'all' : data.targetId!;
    const exists = assignments.some(
      (assignment) => assignment.targetType === data.targetType && assignment.targetId === targetId
    );

    if (exists) {
      return c.json({ error: 'Assignment already exists' }, 409);
    }

    const assignment: PolicyAssignment = {
      id: randomUUID(),
      policyId: id,
      targetType: data.targetType,
      targetId,
      createdAt: new Date()
    };

    assignments.push(assignment);
    policyAssignments.set(id, assignments);

    return c.json(assignment, 201);
  }
);

// DELETE /policies/:id/assignments/:assignmentId - Remove assignment
policyRoutes.delete(
  '/:id/assignments/:assignmentId',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', assignmentParamSchema),
  (c) => {
    ensureSeedData();
    const auth = c.get('auth');
    const { id, assignmentId } = c.req.valid('param');
    const policy = policies.get(id);

    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    if (auth.scope === 'organization' && auth.orgId && policy.orgId !== auth.orgId) {
      return c.json({ error: 'Access to this policy denied' }, 403);
    }

    const assignments = getPolicyAssignments(id);
    const index = assignments.findIndex((assignment) => assignment.id === assignmentId);

    if (index === -1) {
      return c.json({ error: 'Assignment not found' }, 404);
    }

    const [removed] = assignments.splice(index, 1);
    policyAssignments.set(id, assignments);

    return c.json(removed);
  }
);

// GET /policies/:id/compliance - Get compliance status per device
policyRoutes.get(
  '/:id/compliance',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdParamSchema),
  zValidator('query', listComplianceSchema),
  (c) => {
    ensureSeedData();
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const query = c.req.valid('query');
    const policy = policies.get(id);

    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    if (auth.scope === 'organization' && auth.orgId && policy.orgId !== auth.orgId) {
      return c.json({ error: 'Access to this policy denied' }, 403);
    }

    let compliance = policyCompliance.get(id);

    if (!compliance) {
      compliance = Array.from(devices.values())
        .filter((device) => device.orgId === policy.orgId)
        .map((device) => {
          const status = stableComplianceStatus(`${id}:${device.id}`);
          const violationCount = status === 'non_compliant' ? 1 : 0;
          return {
            deviceId: device.id,
            deviceName: device.name,
            status,
            violationCount,
            violations: violationCount > 0 ? [{
              policyId: id,
              policyName: policy.name,
              ruleName: 'Mock rule evaluation',
              message: 'Device failed a simulated rule.'
            }] : [],
            lastCheckedAt: new Date().toISOString()
          };
        });
      policyCompliance.set(id, compliance);
    }

    if (query.status) {
      compliance = compliance.filter((entry) => entry.status === query.status);
    }

    const { page, limit, offset } = getPagination(query);
    const total = compliance.length;
    const data = compliance.slice(offset, offset + limit);

    return c.json({
      data,
      pagination: { page, limit, total }
    });
  }
);

// POST /policies/:id/activate - Activate a draft policy
policyRoutes.post(
  '/:id/activate',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdParamSchema),
  (c) => {
    ensureSeedData();
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const policy = policies.get(id);

    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    if (auth.scope === 'organization' && auth.orgId && policy.orgId !== auth.orgId) {
      return c.json({ error: 'Access to this policy denied' }, 403);
    }

    if (policy.status !== 'draft') {
      return c.json({ error: 'Only draft policies can be activated' }, 400);
    }

    policy.status = 'active';
    policy.activatedAt = new Date();
    policy.deactivatedAt = null;
    policy.updatedAt = new Date();

    return c.json(policy);
  }
);

// POST /policies/:id/deactivate - Deactivate active policy
policyRoutes.post(
  '/:id/deactivate',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdParamSchema),
  (c) => {
    ensureSeedData();
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const policy = policies.get(id);

    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    if (auth.scope === 'organization' && auth.orgId && policy.orgId !== auth.orgId) {
      return c.json({ error: 'Access to this policy denied' }, 403);
    }

    if (policy.status !== 'active') {
      return c.json({ error: 'Only active policies can be deactivated' }, 400);
    }

    policy.status = 'inactive';
    policy.deactivatedAt = new Date();
    policy.updatedAt = new Date();

    return c.json(policy);
  }
);

// POST /policies/:id/test - Dry run policy evaluation
policyRoutes.post(
  '/:id/test',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdParamSchema),
  zValidator('json', testPolicySchema),
  (c) => {
    ensureSeedData();
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');
    const policy = policies.get(id);
    const device = devices.get(data.deviceId);

    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    if (auth.scope === 'organization' && auth.orgId && policy.orgId !== auth.orgId) {
      return c.json({ error: 'Access to this policy denied' }, 403);
    }

    if (device.orgId !== policy.orgId) {
      return c.json({ error: 'Device does not belong to this policy organization' }, 400);
    }

    const status = stableComplianceStatus(`${id}:${data.deviceId}:test`);
    const violations = status === 'non_compliant'
      ? [{
          ruleName: 'Mock rule evaluation',
          message: 'Simulated rule failure',
          details: data.context ?? {}
        }]
      : [];

    return c.json({
      policyId: id,
      deviceId: data.deviceId,
      status,
      evaluatedAt: new Date().toISOString(),
      rulesEvaluated: policy.rules.length,
      violations
    });
  }
);

// GET /policies/:id - Get policy details
policyRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdParamSchema),
  (c) => {
    ensureSeedData();
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const policy = policies.get(id);

    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    if (auth.scope === 'organization' && auth.orgId && policy.orgId !== auth.orgId) {
      return c.json({ error: 'Access to this policy denied' }, 403);
    }

    return c.json(policy);
  }
);

// PATCH /policies/:id - Update policy
policyRoutes.patch(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdParamSchema),
  zValidator('json', updatePolicySchema),
  (c) => {
    ensureSeedData();
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');
    const policy = policies.get(id);

    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    if (auth.scope === 'organization' && auth.orgId && policy.orgId !== auth.orgId) {
      return c.json({ error: 'Access to this policy denied' }, 403);
    }

    if (policy.status === 'archived') {
      return c.json({ error: 'Archived policies cannot be updated' }, 400);
    }

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    if (data.status === 'active') {
      return c.json({ error: 'Use activate to enable a policy' }, 400);
    }

    if (data.status === 'archived') {
      return c.json({ error: 'Use delete to archive a policy' }, 400);
    }

    if (data.targetType && data.targetType !== 'all' && !data.targetIds && (!policy.targetIds || policy.targetIds.length === 0)) {
      return c.json({ error: 'targetIds are required when targetType is not all' }, 400);
    }

    const beforeSnapshot = snapshotPolicy(policy);

    if (data.name !== undefined) policy.name = data.name;
    if (data.description !== undefined) policy.description = data.description;
    if (data.type !== undefined) policy.type = data.type;
    if (data.status !== undefined) policy.status = data.status;
    if (data.enforcementLevel !== undefined) policy.enforcementLevel = data.enforcementLevel;
    if (data.targetType !== undefined) policy.targetType = data.targetType;
    if (data.targetIds !== undefined) policy.targetIds = data.targetIds;
    if (data.rules !== undefined) policy.rules = data.rules;
    if (data.checkIntervalMinutes !== undefined) policy.checkIntervalMinutes = data.checkIntervalMinutes;

    if (policy.targetType === 'all') {
      policy.targetIds = undefined;
    }

    policy.updatedAt = new Date();

    const afterSnapshot = snapshotPolicy(policy);
    const changed = JSON.stringify(beforeSnapshot) !== JSON.stringify(afterSnapshot);

    if (changed) {
      policy.version += 1;
      addPolicyVersion(policy, 'Policy updated');
    }

    return c.json(policy);
  }
);

// DELETE /policies/:id - Delete policy (archive)
policyRoutes.delete(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdParamSchema),
  (c) => {
    ensureSeedData();
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const policy = policies.get(id);

    if (!policy) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    if (auth.scope === 'organization' && auth.orgId && policy.orgId !== auth.orgId) {
      return c.json({ error: 'Access to this policy denied' }, 403);
    }

    if (policy.status === 'archived') {
      return c.json({ error: 'Policy is already archived' }, 400);
    }

    policy.status = 'archived';
    policy.archivedAt = new Date();
    policy.updatedAt = new Date();

    return c.json({
      id: policy.id,
      status: policy.status,
      archivedAt: policy.archivedAt
    });
  }
);
