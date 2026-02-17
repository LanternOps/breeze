import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { executeCommand, CommandTypes } from '../../services/commandQueue';
import { createAuditLog } from '../../services/auditService';
import { getDeviceWithOrgCheck, getPagination, asRecord, asString } from './helpers';
import { deviceIdParamSchema, serviceNameParamSchema, paginationQuerySchema } from './schemas';
import type { ServiceInfo } from './types';

function normalizeServiceStatus(value?: string): ServiceInfo['status'] {
  switch ((value ?? '').toLowerCase()) {
    case 'running':
      return 'running';
    case 'stopped':
      return 'stopped';
    case 'paused':
      return 'paused';
    case 'startpending':
    case 'starting':
    case 'continuepending':
      return 'starting';
    case 'stoppending':
    case 'stopping':
      return 'stopping';
    default:
      return 'stopped';
  }
}

function normalizeServiceStartType(value?: string): ServiceInfo['startType'] {
  const raw = (value ?? '').toLowerCase();
  if (raw.includes('delayed')) return 'auto_delayed';
  if (raw.includes('automatic') || raw === 'enabled' || raw === 'auto') return 'auto';
  if (raw.includes('disabled') || raw === 'masked') return 'disabled';
  if (raw.includes('manual')) return 'manual';
  return 'manual';
}

function mapServiceFromAgent(service: unknown): ServiceInfo | null {
  const record = asRecord(service);
  if (!record) return null;

  const name = asString(record.name);
  if (!name) return null;

  const displayName = asString(record.displayName) ?? name;
  const status = normalizeServiceStatus(asString(record.status));
  const startType = normalizeServiceStartType(asString(record.startType) ?? asString(record.startupType));
  const account = asString(record.account) ?? '';
  const description = asString(record.description) ?? '';
  const path = asString(record.path) ?? '';
  const dependencies = Array.isArray(record.dependencies)
    ? record.dependencies.map((value) => String(value))
    : [];

  return {
    name,
    displayName,
    status,
    startType,
    account,
    description,
    path,
    dependencies
  };
}

export const servicesRoutes = new Hono();

// GET /devices/:deviceId/services - List all services
servicesRoutes.get(
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
      const services = (Array.isArray(data.services) ? data.services : [])
        .map(mapServiceFromAgent)
        .filter((service: ServiceInfo | null): service is ServiceInfo => Boolean(service));
      return c.json({
        data: services,
        meta: {
          total: typeof data.total === 'number' ? data.total : services.length,
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

// GET /devices/:deviceId/services/:name - Get service details
servicesRoutes.get(
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

    const result = await executeCommand(deviceId, CommandTypes.GET_SERVICE, {
      name
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    if (result.status === 'failed') {
      const error = result.error || 'Failed to get service';
      return c.json({ error }, error.toLowerCase().includes('not found') ? 404 : 500);
    }

    try {
      const payload = JSON.parse(result.stdout || '{}');
      const service = mapServiceFromAgent(payload);
      if (!service) {
        return c.json({ error: 'Invalid service payload from agent' }, 502);
      }
      return c.json({ data: service });
    } catch (error) {
      console.error('Failed to parse agent response for service details:', error);
      return c.json({ error: 'Failed to parse agent response for service details' }, 502);
    }
  }
);

// POST /devices/:deviceId/services/:name/start - Start service
servicesRoutes.post(
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

    const result = await executeCommand(deviceId, CommandTypes.START_SERVICE, {
      name
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'start_service',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: { name },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: result.status === 'completed' ? 'success' : 'failure',
      errorMessage: result.error
    });

    if (result.status === 'failed') {
      const error = result.error || 'Failed to start service';
      return c.json({ error }, error.toLowerCase().includes('not found') ? 404 : 500);
    }

    return c.json({
      success: true,
      message: `Service ${name} started successfully`
    });
  }
);

// POST /devices/:deviceId/services/:name/stop - Stop service
servicesRoutes.post(
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

    const result = await executeCommand(deviceId, CommandTypes.STOP_SERVICE, {
      name
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'stop_service',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: { name },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: result.status === 'completed' ? 'success' : 'failure',
      errorMessage: result.error
    });

    if (result.status === 'failed') {
      const error = result.error || 'Failed to stop service';
      return c.json({ error }, error.toLowerCase().includes('not found') ? 404 : 500);
    }

    return c.json({
      success: true,
      message: `Service ${name} stopped successfully`
    });
  }
);

// POST /devices/:deviceId/services/:name/restart - Restart service
servicesRoutes.post(
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

    const result = await executeCommand(deviceId, CommandTypes.RESTART_SERVICE, {
      name
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'restart_service',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: { name },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: result.status === 'completed' ? 'success' : 'failure',
      errorMessage: result.error
    });

    if (result.status === 'failed') {
      const error = result.error || 'Failed to restart service';
      return c.json({ error }, error.toLowerCase().includes('not found') ? 404 : 500);
    }

    return c.json({
      success: true,
      message: `Service ${name} restarted successfully`
    });
  }
);
