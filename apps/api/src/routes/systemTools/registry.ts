import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { executeCommand, CommandTypes } from '../../services/commandQueue';
import { createAuditLog } from '../../services/auditService';
import { getDeviceWithOrgCheck, asRecord, asString, asNumber } from './helpers';
import {
  deviceIdParamSchema,
  registryQuerySchema,
  registryValueQuerySchema,
  registryValueBodySchema,
  registryKeyBodySchema,
  registryKeyQuerySchema
} from './schemas';
import type { RegistryKey, RegistryValue } from './types';

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

export const registryRoutes = new Hono();

// GET /devices/:deviceId/registry/keys - List registry keys
registryRoutes.get(
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
        .filter((entry: RegistryKey | null): entry is RegistryKey => Boolean(entry));
      return c.json({ data: keys });
    } catch (error) {
      console.error('Failed to parse agent response for registry keys:', error);
      return c.json({ error: 'Failed to parse agent response for registry keys' }, 502);
    }
  }
);

// GET /devices/:deviceId/registry/values - List registry values
registryRoutes.get(
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
        .filter((entry: RegistryValue | null): entry is RegistryValue => Boolean(entry));
      return c.json({ data: values });
    } catch (error) {
      console.error('Failed to parse agent response for registry values:', error);
      return c.json({ error: 'Failed to parse agent response for registry values' }, 502);
    }
  }
);

// GET /devices/:deviceId/registry/value - Get registry value
registryRoutes.get(
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

// PUT /devices/:deviceId/registry/value - Set registry value
registryRoutes.put(
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

// DELETE /devices/:deviceId/registry/value - Delete registry value
registryRoutes.delete(
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

// POST /devices/:deviceId/registry/key - Create registry key
registryRoutes.post(
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

// DELETE /devices/:deviceId/registry/key - Delete registry key
registryRoutes.delete(
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
