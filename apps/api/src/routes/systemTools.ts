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
  data: string | number | string[] | number[];
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
  state: 'ready' | 'running' | 'disabled' | 'queued' | 'unknown';
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


function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asOptionalNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseNumericLike(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = /^0x/i.test(trimmed)
    ? Number.parseInt(trimmed.slice(2), 16)
    : Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeRegistryValueName(name: string): string {
  return name === '(Default)' ? '' : name;
}

function presentRegistryValueName(name: string): string {
  return name === '' ? '(Default)' : name;
}

function parseBinaryString(value: string): number[] {
  const compact = value.replace(/[^0-9a-fA-F]/g, '');
  if (!compact) return [];
  const padded = compact.length % 2 === 0 ? compact : `0${compact}`;
  const bytes: number[] = [];
  for (let i = 0; i < padded.length; i += 2) {
    const parsed = Number.parseInt(padded.slice(i, i + 2), 16);
    if (!Number.isFinite(parsed)) continue;
    bytes.push(parsed);
  }
  return bytes;
}

function parseBinaryObject(value: Record<string, unknown>): number[] {
  const sorted = Object.entries(value)
    .filter(([key, val]) => /^\d+$/.test(key) && typeof val === 'number')
    .sort((a, b) => Number.parseInt(a[0], 10) - Number.parseInt(b[0], 10))
    .map(([, val]) => Number(val))
    .filter((num) => Number.isFinite(num) && num >= 0 && num <= 255);
  return sorted;
}

function normalizeRegistryValueData(type: string, data: unknown): string | number | string[] | number[] {
  switch (type) {
    case 'REG_DWORD':
    case 'REG_QWORD': {
      if (typeof data === 'number') return data;
      if (typeof data === 'string') {
        const parsed = parseNumericLike(data);
        return parsed ?? data;
      }
      return String(data ?? '');
    }
    case 'REG_MULTI_SZ': {
      if (Array.isArray(data)) {
        return data.map((entry) => String(entry));
      }
      if (typeof data === 'string') {
        return data
          .split(/\r?\n|\u0000/g)
          .map((entry) => entry.trim())
          .filter(Boolean);
      }
      return [];
    }
    case 'REG_BINARY': {
      if (Array.isArray(data)) {
        return data
          .map((entry) => (typeof entry === 'number' ? entry : Number(entry)))
          .filter((num) => Number.isFinite(num) && num >= 0 && num <= 255);
      }
      if (typeof data === 'string') {
        return parseBinaryString(data);
      }
      const record = asRecord(data);
      if (record) return parseBinaryObject(record);
      return [];
    }
    default:
      if (typeof data === 'string') return data;
      if (typeof data === 'number') return String(data);
      return String(data ?? '');
  }
}

function toRegistryCommandData(type: string, data: unknown): string {
  switch (type) {
    case 'REG_DWORD':
    case 'REG_QWORD': {
      if (typeof data === 'number' && Number.isFinite(data)) return String(Math.trunc(data));
      if (typeof data === 'string') {
        const parsed = parseNumericLike(data);
        return parsed !== null ? String(Math.trunc(parsed)) : data;
      }
      return String(data ?? '');
    }
    case 'REG_MULTI_SZ':
      if (Array.isArray(data)) return data.map((entry) => String(entry)).join('\n');
      return String(data ?? '');
    case 'REG_BINARY':
      if (Array.isArray(data)) {
        return data
          .map((entry) => (typeof entry === 'number' ? entry : Number(entry)))
          .filter((num) => Number.isFinite(num) && num >= 0 && num <= 255)
          .map((num) => num.toString(16).padStart(2, '0'))
          .join(' ')
          .toUpperCase();
      }
      if (typeof data === 'string') {
        return data;
      }
      if (data instanceof Uint8Array) {
        return Array.from(data).map((num) => num.toString(16).padStart(2, '0')).join(' ').toUpperCase();
      }
      {
        const record = asRecord(data);
        if (record) {
          return parseBinaryObject(record)
            .map((num) => num.toString(16).padStart(2, '0'))
            .join(' ')
            .toUpperCase();
        }
      }
      return '';
    default:
      return String(data ?? '');
  }
}

function mapRegistryKeyFromAgent(key: unknown): RegistryKey | null {
  const record = asRecord(key);
  if (!record) return null;

  const name = asString(record.name);
  const path = asString(record.path);
  if (!name || path === undefined) return null;

  return {
    name,
    path,
    subKeyCount: asNumber(record.subKeyCount) ?? 0,
    valueCount: asNumber(record.valueCount) ?? 0,
    lastModified: asString(record.lastModified) ?? ''
  };
}

function mapRegistryValueFromAgent(value: unknown): RegistryValue | null {
  const record = asRecord(value);
  if (!record) return null;

  const name = asString(record.name);
  const type = asString(record.type);
  if (name === undefined || !type) return null;

  return {
    name: presentRegistryValueName(name),
    type: type as RegistryValue['type'],
    data: normalizeRegistryValueData(type, record.data)
  };
}

function normalizeTaskState(value?: string): ScheduledTaskInfo['state'] {
  switch ((value ?? '').toLowerCase()) {
    case 'ready':
    case 'running':
    case 'disabled':
    case 'queued':
      return value!.toLowerCase() as ScheduledTaskInfo['state'];
    default:
      return 'unknown';
  }
}

function normalizeTaskTrigger(trigger: unknown): ScheduledTaskInfo['triggers'][number] | null {
  if (typeof trigger === 'string') {
    const text = trigger.trim();
    if (!text) return null;
    return { type: text, enabled: true };
  }

  const record = asRecord(trigger);
  if (!record) return null;

  const type = asString(record.type) ?? asString(record.name) ?? asString(record.description) ?? 'Schedule';
  const schedule = asString(record.schedule) ?? asString(record.startBoundary) ?? asString(record.nextRunTime);
  const enabledRaw = record.enabled;
  const enabled = typeof enabledRaw === 'boolean'
    ? enabledRaw
    : typeof enabledRaw === 'string'
      ? enabledRaw.toLowerCase() !== 'false'
      : true;

  return schedule ? { type, enabled, schedule } : { type, enabled };
}

function normalizeTaskAction(action: unknown): ScheduledTaskInfo['actions'][number] | null {
  if (typeof action === 'string') {
    const path = action.trim();
    if (!path) return null;
    return { type: 'execute', path };
  }

  const record = asRecord(action);
  if (!record) return null;

  const type = asString(record.type) ?? 'execute';
  const path = asString(record.path) ?? asString(record.command);
  const args = asString(record.arguments) ?? asString(record.args);

  return {
    type,
    ...(path ? { path } : {}),
    ...(args ? { arguments: args } : {})
  };
}

function normalizeScheduledTask(task: unknown): ScheduledTaskInfo | null {
  const record = asRecord(task);
  if (!record) return null;

  const path = asString(record.path) ?? asString(record.taskPath) ?? '';
  const derivedName = path.split('\\').filter(Boolean).pop() ?? path;
  const name = asString(record.name) ?? (derivedName || 'Unknown Task');

  const triggers = Array.isArray(record.triggers)
    ? record.triggers.map(normalizeTaskTrigger).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    : [];
  const actions = Array.isArray(record.actions)
    ? record.actions.map(normalizeTaskAction).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    : [];

  return {
    path,
    name,
    state: normalizeTaskState(asString(record.state) ?? asString(record.status)),
    lastRunTime: asString(record.lastRunTime) ?? asString(record.lastRun) ?? null,
    lastRunResult: asOptionalNumber(record.lastRunResult ?? record.lastResult),
    nextRunTime: asString(record.nextRunTime) ?? asString(record.nextRun) ?? null,
    author: asString(record.author) ?? '',
    description: asString(record.description) ?? '',
    triggers,
    actions
  };
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
  data: z.union([
    z.string(),
    z.number(),
    z.array(z.string()),
    z.array(z.number()),
    z.record(z.number())
  ])
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

    const result = await executeCommand(deviceId, CommandTypes.REGISTRY_KEYS, {
      hive,
      path
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    if (result.status === 'failed') {
      return c.json({ error: result.error || 'Failed to load registry keys' }, 500);
    }

    try {
      const payload = JSON.parse(result.stdout || '{}');
      const keys = (Array.isArray(payload.keys) ? payload.keys : [])
        .map(mapRegistryKeyFromAgent)
        .filter((entry): entry is RegistryKey => Boolean(entry));
      return c.json({ data: keys });
    } catch (error) {
      console.error('Failed to parse agent response for registry keys:', error);
      return c.json({ error: 'Failed to parse agent response for registry keys' }, 502);
    }
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
    const { hive, path } = c.req.valid('query');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const result = await executeCommand(deviceId, CommandTypes.REGISTRY_VALUES, {
      hive,
      path
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    if (result.status === 'failed') {
      return c.json({ error: result.error || 'Failed to load registry values' }, 500);
    }

    try {
      const payload = JSON.parse(result.stdout || '{}');
      const values = (Array.isArray(payload.values) ? payload.values : [])
        .map(mapRegistryValueFromAgent)
        .filter((entry): entry is RegistryValue => Boolean(entry));
      return c.json({ data: values });
    } catch (error) {
      console.error('Failed to parse agent response for registry values:', error);
      return c.json({ error: 'Failed to parse agent response for registry values' }, 502);
    }
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

    const result = await executeCommand(deviceId, CommandTypes.REGISTRY_GET, {
      hive,
      path,
      name: normalizeRegistryValueName(name)
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    if (result.status === 'failed') {
      const error = result.error || 'Failed to get registry value';
      return c.json({ error }, error.toLowerCase().includes('not found') ? 404 : 500);
    }

    try {
      const payload = JSON.parse(result.stdout || '{}');
      const value = mapRegistryValueFromAgent(payload);
      if (!value) {
        return c.json({ error: 'Invalid registry value payload from agent' }, 502);
      }

      const fullPath = value.name === '(Default)'
        ? `${hive}\\${path}`
        : `${hive}\\${path}\\${value.name}`;

      return c.json({
        data: {
          ...value,
          fullPath
        }
      });
    } catch (error) {
      console.error('Failed to parse agent response for registry value:', error);
      return c.json({ error: 'Failed to parse agent response for registry value' }, 502);
    }
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

    const normalizedName = normalizeRegistryValueName(name);
    const commandData = toRegistryCommandData(type, data);
    const result = await executeCommand(deviceId, CommandTypes.REGISTRY_SET, {
      hive,
      path,
      name: normalizedName,
      type,
      data: commandData
    }, { userId: auth.user?.id, timeoutMs: 30000 });

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
        name: normalizedName,
        type,
        data: commandData.substring(0, 200)
      },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: result.status === 'completed' ? 'success' : 'failure',
      errorMessage: result.error
    });

    if (result.status === 'failed') {
      const error = result.error || 'Failed to set registry value';
      return c.json({ error }, error.toLowerCase().includes('not found') ? 404 : 500);
    }

    return c.json({
      success: true,
      message: `Registry value ${name || '(Default)'} set successfully`,
      data: {
        hive,
        path,
        name: name || '(Default)',
        type,
        data: normalizeRegistryValueData(type, data)
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

    const normalizedName = normalizeRegistryValueName(name);
    const result = await executeCommand(deviceId, CommandTypes.REGISTRY_DELETE, {
      hive,
      path,
      name: normalizedName
    }, { userId: auth.user?.id, timeoutMs: 30000 });

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
        name: normalizedName
      },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: result.status === 'completed' ? 'success' : 'failure',
      errorMessage: result.error
    });

    if (result.status === 'failed') {
      const error = result.error || 'Failed to delete registry value';
      return c.json({ error }, error.toLowerCase().includes('not found') ? 404 : 500);
    }

    return c.json({
      success: true,
      message: `Registry value ${name || '(Default)'} deleted successfully`
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
    if (!normalizedPath) {
      return c.json({ error: 'Invalid registry key path' }, 400);
    }

    const result = await executeCommand(deviceId, CommandTypes.REGISTRY_KEY_CREATE, {
      hive,
      path: normalizedPath
    }, { userId: auth.user?.id, timeoutMs: 30000 });

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
      result: result.status === 'completed' ? 'success' : 'failure',
      errorMessage: result.error
    });

    if (result.status === 'failed') {
      const error = result.error || 'Failed to create registry key';
      return c.json({ error }, error.toLowerCase().includes('not found') ? 404 : 500);
    }

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
    if (!normalizedPath) {
      return c.json({ error: 'Invalid registry key path' }, 400);
    }

    const result = await executeCommand(deviceId, CommandTypes.REGISTRY_KEY_DELETE, {
      hive,
      path: normalizedPath
    }, { userId: auth.user?.id, timeoutMs: 30000 });

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
      result: result.status === 'completed' ? 'success' : 'failure',
      errorMessage: result.error
    });

    if (result.status === 'failed') {
      const error = result.error || 'Failed to delete registry key';
      return c.json({ error }, error.toLowerCase().includes('not found') ? 404 : 500);
    }

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
    const { page, limit } = getPagination(c.req.valid('query'));
    const folder = c.req.query('folder') || '\\';
    const search = c.req.query('search') || '';
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const result = await executeCommand(deviceId, CommandTypes.TASKS_LIST, {
      folder,
      search,
      page,
      limit
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    if (result.status === 'failed') {
      return c.json({ error: result.error || 'Failed to list tasks' }, 500);
    }

    try {
      const payload = JSON.parse(result.stdout || '{}');
      const rawTasks = Array.isArray(payload.tasks) ? payload.tasks : [];
      const tasks = rawTasks
        .map(normalizeScheduledTask)
        .filter((task): task is ScheduledTaskInfo => Boolean(task));

      return c.json({
        data: tasks,
        meta: {
          total: typeof payload.total === 'number' ? payload.total : tasks.length,
          page: typeof payload.page === 'number' ? payload.page : page,
          limit: typeof payload.limit === 'number' ? payload.limit : limit,
          totalPages: typeof payload.totalPages === 'number' ? payload.totalPages : 1
        }
      });
    } catch (error) {
      console.error('Failed to parse agent response for task listing:', error);
      return c.json({ error: 'Failed to parse agent response for task listing' }, 502);
    }
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

    const result = await executeCommand(deviceId, CommandTypes.TASK_GET, {
      path
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    if (result.status === 'failed') {
      const error = result.error || 'Failed to get task';
      return c.json({ error }, error.toLowerCase().includes('not found') ? 404 : 500);
    }

    try {
      const payload = JSON.parse(result.stdout || '{}');
      const task = normalizeScheduledTask(payload);
      if (!task) {
        return c.json({ error: 'Invalid task payload from agent' }, 502);
      }
      return c.json({ data: task });
    } catch (error) {
      console.error('Failed to parse agent response for task details:', error);
      return c.json({ error: 'Failed to parse agent response for task details' }, 502);
    }
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

    const result = await executeCommand(deviceId, CommandTypes.TASK_RUN, {
      path
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'run_scheduled_task',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: { path },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: result.status === 'completed' ? 'success' : 'failure',
      errorMessage: result.error
    });

    if (result.status === 'failed') {
      const error = result.error || 'Failed to run task';
      return c.json({ error }, error.toLowerCase().includes('not found') ? 404 : 500);
    }

    return c.json({
      success: true,
      message: `Task ${path} started successfully`
    });
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

    const result = await executeCommand(deviceId, CommandTypes.TASK_ENABLE, {
      path
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'enable_scheduled_task',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: { path },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: result.status === 'completed' ? 'success' : 'failure',
      errorMessage: result.error
    });

    if (result.status === 'failed') {
      const error = result.error || 'Failed to enable task';
      return c.json({ error }, error.toLowerCase().includes('not found') ? 404 : 500);
    }

    return c.json({
      success: true,
      message: `Task ${path} enabled successfully`
    });
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

    const result = await executeCommand(deviceId, CommandTypes.TASK_DISABLE, {
      path
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'disable_scheduled_task',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: { path },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: result.status === 'completed' ? 'success' : 'failure',
      errorMessage: result.error
    });

    if (result.status === 'failed') {
      const error = result.error || 'Failed to disable task';
      return c.json({ error }, error.toLowerCase().includes('not found') ? 404 : 500);
    }

    return c.json({
      success: true,
      message: `Task ${path} disabled successfully`
    });
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
