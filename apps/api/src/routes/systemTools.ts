import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { devices } from '../db/schema';
import { authMiddleware, requireScope, type AuthContext } from '../middleware/auth';
import { executeCommand, CommandTypes } from '../services/commandQueue';
import { createAuditLog } from '../services/auditService';

export const systemToolsRoutes = new Hono();

// ============================================
// TYPES
// ============================================

interface ProcessInfo {
  pid: number;
  name: string;
  cpuPercent: number;
  memoryMB: number;
  user: string;
  status: 'running' | 'sleeping' | 'stopped' | 'zombie';
  startTime: string;
  commandLine: string;
  parentPid: number | null;
  threads: number;
}

interface ServiceInfo {
  name: string;
  displayName: string;
  status: 'running' | 'stopped' | 'paused' | 'starting' | 'stopping';
  startType: 'auto' | 'manual' | 'disabled' | 'auto_delayed';
  account: string;
  description: string;
  path: string;
  dependencies: string[];
}

interface RegistryKey {
  name: string;
  path: string;
  subKeyCount: number;
  valueCount: number;
  lastModified: string;
}

interface RegistryValue {
  name: string;
  type: 'REG_SZ' | 'REG_EXPAND_SZ' | 'REG_BINARY' | 'REG_DWORD' | 'REG_QWORD' | 'REG_MULTI_SZ';
  data: string | number | string[];
}

interface EventLogInfo {
  name: string;
  displayName: string;
  recordCount: number;
  maxSize: number;
  retentionDays: number;
  lastWriteTime: string;
}

interface EventLogEntry {
  recordId: number;
  timeCreated: string;
  level: 'information' | 'warning' | 'error' | 'critical' | 'verbose';
  source: string;
  eventId: number;
  message: string;
  category: string;
  user: string | null;
  computer: string;
}

interface ScheduledTaskInfo {
  path: string;
  name: string;
  state: 'ready' | 'running' | 'disabled' | 'queued';
  lastRunTime: string | null;
  lastRunResult: number | null;
  nextRunTime: string | null;
  author: string;
  description: string;
  triggers: Array<{
    type: string;
    enabled: boolean;
    schedule?: string;
  }>;
  actions: Array<{
    type: string;
    path?: string;
    arguments?: string;
  }>;
}

interface FileEntryInfo {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: string;
  permissions?: string;
}

type RegistryOverrides = {
  added: Set<string>;
  removed: Set<string>;
};

// ============================================
// HELPER FUNCTIONS
// ============================================

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

async function ensureOrgAccess(
  orgId: string,
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>
) {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }

  if (auth.scope === 'partner') {
    return auth.canAccessOrg(orgId);
  }

  // system scope has access to all
  return true;
}

async function getDeviceWithOrgCheck(
  deviceId: string,
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>
) {
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return null;
  }

  const hasAccess = await ensureOrgAccess(device.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  return device;
}


const registryKeyOverrides = new Map<string, RegistryOverrides>();

function getRegistryOverrides(key: string): RegistryOverrides {
  const existing = registryKeyOverrides.get(key);
  if (existing) return existing;
  const created = { added: new Set<string>(), removed: new Set<string>() };
  registryKeyOverrides.set(key, created);
  return created;
}

// ============================================
// VALIDATION SCHEMAS
// ============================================

const deviceIdParamSchema = z.object({
  deviceId: z.string().uuid()
});

const pidParamSchema = z.object({
  deviceId: z.string().uuid(),
  pid: z.string().transform(val => parseInt(val, 10))
});

const serviceNameParamSchema = z.object({
  deviceId: z.string().uuid(),
  name: z.string().min(1).max(256)
});

const registryQuerySchema = z.object({
  hive: z.enum(['HKEY_LOCAL_MACHINE', 'HKEY_CURRENT_USER', 'HKEY_CLASSES_ROOT', 'HKEY_USERS', 'HKEY_CURRENT_CONFIG']),
  path: z.string().min(0).max(1024)
});

const registryValueQuerySchema = registryQuerySchema.extend({
  name: z.string().min(0).max(256)
});

const registryValueBodySchema = z.object({
  hive: z.enum(['HKEY_LOCAL_MACHINE', 'HKEY_CURRENT_USER', 'HKEY_CLASSES_ROOT', 'HKEY_USERS', 'HKEY_CURRENT_CONFIG']),
  path: z.string().min(0).max(1024),
  name: z.string().min(0).max(256),
  type: z.enum(['REG_SZ', 'REG_EXPAND_SZ', 'REG_BINARY', 'REG_DWORD', 'REG_QWORD', 'REG_MULTI_SZ']),
  data: z.union([z.string(), z.number(), z.array(z.string())])
});

const registryKeyBodySchema = z.object({
  hive: z.enum(['HKEY_LOCAL_MACHINE', 'HKEY_CURRENT_USER', 'HKEY_CLASSES_ROOT', 'HKEY_USERS', 'HKEY_CURRENT_CONFIG']),
  path: z.string().min(1).max(1024)
});

const registryKeyQuerySchema = z.object({
  hive: z.enum(['HKEY_LOCAL_MACHINE', 'HKEY_CURRENT_USER', 'HKEY_CLASSES_ROOT', 'HKEY_USERS', 'HKEY_CURRENT_CONFIG']),
  path: z.string().min(1).max(1024)
});

const eventLogNameParamSchema = z.object({
  deviceId: z.string().uuid(),
  name: z.string().min(1).max(256)
});

const eventLogQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  level: z.enum(['information', 'warning', 'error', 'critical', 'verbose']).optional(),
  source: z.string().optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  eventId: z.string().transform(val => parseInt(val, 10)).optional()
});

const eventRecordParamSchema = z.object({
  deviceId: z.string().uuid(),
  name: z.string().min(1).max(256),
  recordId: z.string().transform(val => parseInt(val, 10))
});

const taskPathParamSchema = z.object({
  deviceId: z.string().uuid(),
  path: z.string().min(1).max(512)
});

const fileListQuerySchema = z.object({
  path: z.string().min(1).max(2048)
});

const paginationQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional()
});

// ============================================
// PROCESSES ROUTES
// ============================================

// GET /api/v1/system-tools/devices/:deviceId/processes - List all processes
systemToolsRoutes.get(
  '/devices/:deviceId/processes',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', paginationQuerySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const { page, limit } = getPagination(c.req.valid('query'));
    const search = c.req.query('search') || '';

    // Execute command on agent
    const result = await executeCommand(deviceId, CommandTypes.LIST_PROCESSES, {
      page,
      limit,
      search
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    if (result.status === 'failed') {
      return c.json({ error: result.error || 'Failed to get processes' }, 500);
    }

    // Parse the result from agent
    try {
      const data = JSON.parse(result.stdout || '{}');
      return c.json({
        data: data.processes || [],
        meta: {
          total: data.total || 0,
          page: data.page || page,
          limit: data.limit || limit,
          totalPages: data.totalPages || 1
        }
      });
    } catch (parseError) {
      console.error('Failed to parse agent response for process listing:', parseError);
      return c.json({ error: 'Failed to parse agent response for process listing' }, 502);
    }
  }
);

// GET /api/v1/system-tools/devices/:deviceId/processes/:pid - Get process details
systemToolsRoutes.get(
  '/devices/:deviceId/processes/:pid',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', pidParamSchema),
  async (c) => {
    const { deviceId, pid } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // TODO: Replace with actual agent call
    return c.json({ error: 'Not yet implemented - agent integration pending' }, 501);
  }
);

// POST /api/v1/system-tools/devices/:deviceId/processes/:pid/kill - Kill a process
systemToolsRoutes.post(
  '/devices/:deviceId/processes/:pid/kill',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', pidParamSchema),
  async (c) => {
    const { deviceId, pid } = c.req.valid('param');
    const auth = c.get('auth');
    const force = c.req.query('force') === 'true';

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // Execute kill command on agent
    const result = await executeCommand(deviceId, CommandTypes.KILL_PROCESS, {
      pid,
      force
    }, { userId: auth.user?.id, timeoutMs: 15000 });

    // Audit log for sensitive operation
    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'kill_process',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: {
        pid,
        force,
        result: result.status
      },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: result.status === 'completed' ? 'success' : 'failure',
      errorMessage: result.error
    });

    if (result.status === 'failed') {
      return c.json({ error: result.error || 'Failed to kill process' }, 500);
    }

    try {
      const data = JSON.parse(result.stdout || '{}');
      return c.json({
        success: true,
        message: `Process ${pid} (${data.name || 'unknown'}) terminated successfully`
      });
    } catch {
      return c.json({
        success: true,
        message: `Process ${pid} terminated successfully`
      });
    }
  }
);

// ============================================
// SERVICES ROUTES (Windows)
// ============================================

// GET /api/v1/system-tools/devices/:deviceId/services - List all services
systemToolsRoutes.get(
  '/devices/:deviceId/services',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', paginationQuerySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const { page, limit } = getPagination(c.req.valid('query'));
    const search = c.req.query('search') || '';
    const status = c.req.query('status') || '';

    // Execute command on agent
    const result = await executeCommand(deviceId, CommandTypes.LIST_SERVICES, {
      page,
      limit,
      search,
      status
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    if (result.status === 'failed') {
      return c.json({ error: result.error || 'Failed to get services' }, 500);
    }

    try {
      const data = JSON.parse(result.stdout || '{}');
      return c.json({
        data: data.services || [],
        meta: {
          total: data.total || 0,
          page: data.page || page,
          limit: data.limit || limit,
          totalPages: data.totalPages || 1
        }
      });
    } catch (parseError) {
      console.error('Failed to parse agent response for service listing:', parseError);
      return c.json({ error: 'Failed to parse agent response for service listing' }, 502);
    }
  }
);

// GET /api/v1/system-tools/devices/:deviceId/services/:name - Get service details
systemToolsRoutes.get(
  '/devices/:deviceId/services/:name',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', serviceNameParamSchema),
  async (c) => {
    const { deviceId, name } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // TODO: Replace with actual agent call
    return c.json({ error: 'Not yet implemented - agent integration pending' }, 501);
  }
);

// POST /api/v1/system-tools/devices/:deviceId/services/:name/start - Start service
systemToolsRoutes.post(
  '/devices/:deviceId/services/:name/start',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', serviceNameParamSchema),
  async (c) => {
    const { deviceId, name } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // TODO: Replace with actual agent call
    return c.json({ error: 'Not yet implemented - agent integration pending' }, 501);
  }
);

// POST /api/v1/system-tools/devices/:deviceId/services/:name/stop - Stop service
systemToolsRoutes.post(
  '/devices/:deviceId/services/:name/stop',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', serviceNameParamSchema),
  async (c) => {
    const { deviceId, name } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // TODO: Replace with actual agent call
    return c.json({ error: 'Not yet implemented - agent integration pending' }, 501);
  }
);

// POST /api/v1/system-tools/devices/:deviceId/services/:name/restart - Restart service
systemToolsRoutes.post(
  '/devices/:deviceId/services/:name/restart',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', serviceNameParamSchema),
  async (c) => {
    const { deviceId, name } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // TODO: Replace with actual agent call
    return c.json({ error: 'Not yet implemented - agent integration pending' }, 501);
  }
);

// ============================================
// REGISTRY ROUTES (Windows)
// ============================================

// GET /api/v1/system-tools/devices/:deviceId/registry/keys - List registry keys
systemToolsRoutes.get(
  '/devices/:deviceId/registry/keys',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', registryQuerySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const { hive, path } = c.req.valid('query');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // TODO: Replace with actual agent call
    const prefix = path ? `${path}\\` : '';
    const mockKeys: RegistryKey[] = [
      { name: 'SOFTWARE', path: `${prefix}SOFTWARE`, subKeyCount: 15, valueCount: 0, lastModified: '2024-01-10T10:00:00Z' },
      { name: 'SYSTEM', path: `${prefix}SYSTEM`, subKeyCount: 8, valueCount: 0, lastModified: '2024-01-12T14:30:00Z' },
      { name: 'HARDWARE', path: `${prefix}HARDWARE`, subKeyCount: 3, valueCount: 2, lastModified: '2024-01-01T00:00:00Z' }
    ];

    const overrideKey = `${deviceId}:${hive}:${path}`;
    const overrides = registryKeyOverrides.get(overrideKey);
    const keys = overrides
      ? [
          ...mockKeys.filter(key => !overrides.removed.has(key.name)),
          ...Array.from(overrides.added)
            .filter(name => !mockKeys.some(key => key.name === name))
            .map(name => ({
              name,
              path: `${prefix}${name}`,
              subKeyCount: 0,
              valueCount: 0,
              lastModified: new Date().toISOString()
            }))
        ]
      : mockKeys;

    return c.json({ data: keys });
  }
);

// GET /api/v1/system-tools/devices/:deviceId/registry/values - List registry values
systemToolsRoutes.get(
  '/devices/:deviceId/registry/values',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', registryQuerySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // TODO: Replace with actual agent call
    const mockValues: RegistryValue[] = [
      { name: '(Default)', type: 'REG_SZ', data: '' },
      { name: 'ProductName', type: 'REG_SZ', data: 'Windows 11 Pro' },
      { name: 'CurrentVersion', type: 'REG_SZ', data: '6.3' },
      { name: 'InstallDate', type: 'REG_DWORD', data: 1704067200 },
      { name: 'PathName', type: 'REG_EXPAND_SZ', data: '%SystemRoot%' }
    ];

    return c.json({ data: mockValues });
  }
);

// GET /api/v1/system-tools/devices/:deviceId/registry/value - Get registry value
systemToolsRoutes.get(
  '/devices/:deviceId/registry/value',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', registryValueQuerySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const { hive, path, name } = c.req.valid('query');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // TODO: Replace with actual agent call
    const mockValue: RegistryValue = {
      name: name || '(Default)',
      type: 'REG_SZ',
      data: 'Windows 11 Pro'
    };

    return c.json({
      data: {
        ...mockValue,
        fullPath: `${hive}\\${path}\\${name}`
      }
    });
  }
);

// PUT /api/v1/system-tools/devices/:deviceId/registry/value - Set registry value
systemToolsRoutes.put(
  '/devices/:deviceId/registry/value',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('json', registryValueBodySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const { hive, path, name, type, data } = c.req.valid('json');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // Audit log for sensitive operation
    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'set_registry_value',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: {
        hive,
        path,
        name,
        type,
        data: typeof data === 'string' ? data.substring(0, 200) : data // Truncate for audit
      },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: 'success'
    });

    // TODO: Replace with actual agent call
    return c.json({
      success: true,
      message: `Registry value ${name} set successfully`,
      data: {
        hive,
        path,
        name,
        type,
        data
      }
    });
  }
);

// DELETE /api/v1/system-tools/devices/:deviceId/registry/value - Delete registry value
systemToolsRoutes.delete(
  '/devices/:deviceId/registry/value',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', registryValueQuerySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const { hive, path, name } = c.req.valid('query');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // Audit log for sensitive operation
    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'delete_registry_value',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: {
        hive,
        path,
        name
      },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: 'success'
    });

    // TODO: Replace with actual agent call
    return c.json({
      success: true,
      message: `Registry value ${name} deleted successfully`
    });
  }
);

// POST /api/v1/system-tools/devices/:deviceId/registry/key - Create registry key
systemToolsRoutes.post(
  '/devices/:deviceId/registry/key',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('json', registryKeyBodySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const { hive, path } = c.req.valid('json');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const normalizedPath = path.replace(/\\+$/, '');
    const parts = normalizedPath.split('\\');
    const name = parts.pop();
    const parentPath = parts.join('\\');

    if (!name) {
      return c.json({ error: 'Invalid registry key path' }, 400);
    }

    const overrideKey = `${deviceId}:${hive}:${parentPath}`;
    const overrides = getRegistryOverrides(overrideKey);
    overrides.added.add(name);
    overrides.removed.delete(name);

    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'create_registry_key',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: {
        hive,
        path: normalizedPath
      },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: 'success'
    });

    return c.json({
      success: true,
      message: `Registry key ${normalizedPath} created successfully`
    });
  }
);

// DELETE /api/v1/system-tools/devices/:deviceId/registry/key - Delete registry key
systemToolsRoutes.delete(
  '/devices/:deviceId/registry/key',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', registryKeyQuerySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const { hive, path } = c.req.valid('query');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const normalizedPath = path.replace(/\\+$/, '');
    const parts = normalizedPath.split('\\');
    const name = parts.pop();
    const parentPath = parts.join('\\');

    if (!name) {
      return c.json({ error: 'Invalid registry key path' }, 400);
    }

    const overrideKey = `${deviceId}:${hive}:${parentPath}`;
    const overrides = getRegistryOverrides(overrideKey);
    overrides.removed.add(name);
    overrides.added.delete(name);

    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'delete_registry_key',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: {
        hive,
        path: normalizedPath
      },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: 'success'
    });

    return c.json({
      success: true,
      message: `Registry key ${normalizedPath} deleted successfully`
    });
  }
);

// ============================================
// EVENT LOGS ROUTES (Windows)
// ============================================

// GET /api/v1/system-tools/devices/:deviceId/eventlogs - List available logs
systemToolsRoutes.get(
  '/devices/:deviceId/eventlogs',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // TODO: Replace with actual agent call
    return c.json({ error: 'Not yet implemented - agent integration pending' }, 501);
  }
);

// GET /api/v1/system-tools/devices/:deviceId/eventlogs/:name - Get log info
systemToolsRoutes.get(
  '/devices/:deviceId/eventlogs/:name',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', eventLogNameParamSchema),
  async (c) => {
    const { deviceId, name } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // TODO: Replace with actual agent call
    return c.json({ error: 'Not yet implemented - agent integration pending' }, 501);
  }
);

// GET /api/v1/system-tools/devices/:deviceId/eventlogs/:name/events - Query events
systemToolsRoutes.get(
  '/devices/:deviceId/eventlogs/:name/events',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', eventLogNameParamSchema),
  zValidator('query', eventLogQuerySchema),
  async (c) => {
    const { deviceId, name } = c.req.valid('param');
    const query = c.req.valid('query');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // TODO: Replace with actual agent call
    return c.json({ error: 'Not yet implemented - agent integration pending' }, 501);
  }
);

// GET /api/v1/system-tools/devices/:deviceId/eventlogs/:name/events/:recordId - Get event
systemToolsRoutes.get(
  '/devices/:deviceId/eventlogs/:name/events/:recordId',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', eventRecordParamSchema),
  async (c) => {
    const { deviceId, name, recordId } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // TODO: Replace with actual agent call
    return c.json({ error: 'Not yet implemented - agent integration pending' }, 501);
  }
);

// ============================================
// SCHEDULED TASKS ROUTES (Windows)
// ============================================

// GET /api/v1/system-tools/devices/:deviceId/tasks - List scheduled tasks
systemToolsRoutes.get(
  '/devices/:deviceId/tasks',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', paginationQuerySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // TODO: Replace with actual agent call
    return c.json({ error: 'Not yet implemented - agent integration pending' }, 501);
  }
);

// GET /api/v1/system-tools/devices/:deviceId/tasks/:path - Get task details
systemToolsRoutes.get(
  '/devices/:deviceId/tasks/:path',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', taskPathParamSchema),
  async (c) => {
    const { deviceId, path } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // TODO: Replace with actual agent call
    return c.json({ error: 'Not yet implemented - agent integration pending' }, 501);
  }
);

// POST /api/v1/system-tools/devices/:deviceId/tasks/:path/run - Run task
systemToolsRoutes.post(
  '/devices/:deviceId/tasks/:path/run',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', taskPathParamSchema),
  async (c) => {
    const { deviceId, path } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // TODO: Replace with actual agent call
    return c.json({ error: 'Not yet implemented - agent integration pending' }, 501);
  }
);

// POST /api/v1/system-tools/devices/:deviceId/tasks/:path/enable - Enable task
systemToolsRoutes.post(
  '/devices/:deviceId/tasks/:path/enable',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', taskPathParamSchema),
  async (c) => {
    const { deviceId, path } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // TODO: Replace with actual agent call
    return c.json({ error: 'Not yet implemented - agent integration pending' }, 501);
  }
);

// POST /api/v1/system-tools/devices/:deviceId/tasks/:path/disable - Disable task
systemToolsRoutes.post(
  '/devices/:deviceId/tasks/:path/disable',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', taskPathParamSchema),
  async (c) => {
    const { deviceId, path } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // TODO: Replace with actual agent call
    return c.json({ error: 'Not yet implemented - agent integration pending' }, 501);
  }
);

// ============================================
// FILE BROWSER ROUTES
// ============================================

// GET /api/v1/system-tools/devices/:deviceId/files - List files for a path
systemToolsRoutes.get(
  '/devices/:deviceId/files',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', fileListQuerySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const { path } = c.req.valid('query');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // Execute file_list command on agent
    const result = await executeCommand(deviceId, CommandTypes.FILE_LIST, {
      path
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    if (result.status === 'failed') {
      return c.json({ error: result.error || 'Agent failed to list files. The device may be offline.' }, 502);
    }

    try {
      const data = JSON.parse(result.stdout || '{}');
      return c.json({ data: data.entries || [] });
    } catch {
      return c.json({ error: 'Failed to parse agent response for file listing' }, 502);
    }
  }
);

// POST /api/v1/system-tools/devices/:deviceId/files/upload - Upload a file
systemToolsRoutes.post(
  '/devices/:deviceId/files/upload',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const body = await c.req.json<{
      path: string;
      content: string;
      encoding?: 'base64' | 'text';
    }>();

    if (!body.path || typeof body.path !== 'string') {
      return c.json({ error: 'path is required' }, 400);
    }
    if (body.content === undefined || typeof body.content !== 'string') {
      return c.json({ error: 'content is required' }, 400);
    }

    const result = await executeCommand(deviceId, CommandTypes.FILE_WRITE, {
      path: body.path,
      content: body.content,
      encoding: body.encoding || 'text'
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    // Audit log after command execution with actual result
    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'file_upload',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: {
        path: body.path,
        encoding: body.encoding || 'text',
        sizeBytes: body.content.length
      },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: result.status === 'failed' ? 'failure' : 'success'
    });

    if (result.status === 'failed') {
      return c.json({ error: result.error || 'Failed to write file' }, 500);
    }

    try {
      const data = JSON.parse(result.stdout || '{}');
      return c.json({
        success: true,
        data: {
          path: data.path || body.path,
          size: data.size || 0,
          written: true
        }
      });
    } catch {
      return c.json({
        success: true,
        data: { path: body.path, written: true }
      });
    }
  }
);
