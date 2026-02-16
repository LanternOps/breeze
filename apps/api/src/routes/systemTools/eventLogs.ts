import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { executeCommand, CommandTypes } from '../../services/commandQueue';
import { getDeviceWithOrgCheck, getPagination, asRecord, asString, asNumber, asOptionalNumber } from './helpers';
import {
  deviceIdParamSchema,
  eventLogNameParamSchema,
  eventLogQuerySchema,
  eventRecordParamSchema
} from './schemas';
import type { EventLogInfo, EventLogEntry } from './types';

function normalizeEventLevel(value?: string): EventLogEntry['level'] {
  switch ((value ?? '').toLowerCase()) {
    case 'critical':
      return 'critical';
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    case 'verbose':
      return 'verbose';
    case 'information':
    case 'info':
    default:
      return 'information';
  }
}

function mapEventLogFromAgent(log: unknown): EventLogInfo | null {
  const record = asRecord(log);
  if (!record) return null;

  const name = asString(record.name);
  if (!name) return null;

  return {
    name,
    displayName: asString(record.displayName) ?? name,
    recordCount: asNumber(record.recordCount) ?? 0,
    maxSize: asNumber(record.maxSizeBytes) ?? asNumber(record.maxSize) ?? 0,
    retentionDays: asNumber(record.retentionDays) ?? 0,
    lastWriteTime: asString(record.lastWriteTime) ?? ''
  };
}

function mapEventEntryFromAgent(entry: unknown): EventLogEntry | null {
  const record = asRecord(entry);
  if (!record) return null;

  const recordId = asOptionalNumber(record.recordId);
  if (recordId === null) return null;

  const eventId = asOptionalNumber(record.eventId);

  return {
    recordId,
    timeCreated: asString(record.timeCreated) ?? '',
    level: normalizeEventLevel(asString(record.level)),
    source: asString(record.source) ?? '',
    eventId: eventId ?? 0,
    message: asString(record.message) ?? '',
    category: asString(record.category) ?? '',
    user: asString(record.userId) ?? asString(record.user) ?? null,
    computer: asString(record.computer) ?? asString(record.machineName) ?? '',
    rawXml: asString(record.rawXml) ?? '',
  };
}

export const eventLogsRoutes = new Hono();

// GET /devices/:deviceId/eventlogs - List available logs
eventLogsRoutes.get(
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

    const result = await executeCommand(deviceId, CommandTypes.EVENT_LOGS_LIST, {}, {
      userId: auth.user?.id,
      timeoutMs: 30000
    });

    if (result.status === 'failed') {
      return c.json({ error: result.error || 'Failed to list event logs' }, 500);
    }

    try {
      const payload = JSON.parse(result.stdout || '{}');
      const logs = (Array.isArray(payload.logs) ? payload.logs : [])
        .map(mapEventLogFromAgent)
        .filter((entry: EventLogInfo | null): entry is EventLogInfo => Boolean(entry));
      return c.json({ data: logs });
    } catch (error) {
      console.error('Failed to parse agent response for event logs:', error);
      return c.json({ error: 'Failed to parse agent response for event logs' }, 502);
    }
  }
);

// GET /devices/:deviceId/eventlogs/:name - Get log info
eventLogsRoutes.get(
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

    const result = await executeCommand(deviceId, CommandTypes.EVENT_LOGS_LIST, {}, {
      userId: auth.user?.id,
      timeoutMs: 30000
    });

    if (result.status === 'failed') {
      return c.json({ error: result.error || 'Failed to get event log info' }, 500);
    }

    try {
      const payload = JSON.parse(result.stdout || '{}');
      const logs = (Array.isArray(payload.logs) ? payload.logs : [])
        .map(mapEventLogFromAgent)
        .filter((entry: EventLogInfo | null): entry is EventLogInfo => Boolean(entry));

      const log = logs.find((entry: EventLogInfo) => entry.name.toLowerCase() === name.toLowerCase());
      if (!log) {
        return c.json({ error: 'Event log not found' }, 404);
      }

      return c.json({ data: log });
    } catch (error) {
      console.error('Failed to parse agent response for event log info:', error);
      return c.json({ error: 'Failed to parse agent response for event log info' }, 502);
    }
  }
);

// GET /devices/:deviceId/eventlogs/:name/events - Query events
eventLogsRoutes.get(
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

    const { page, limit } = getPagination(query);

    const result = await executeCommand(deviceId, CommandTypes.EVENT_LOGS_QUERY, {
      logName: name,
      level: query.level ?? '',
      source: query.source ?? '',
      eventId: query.eventId ?? 0,
      page,
      limit
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    if (result.status === 'failed') {
      return c.json({ error: result.error || 'Failed to query event logs' }, 500);
    }

    try {
      const payload = JSON.parse(result.stdout || '{}');
      const events = (Array.isArray(payload.events) ? payload.events : [])
        .map((entry: unknown) => mapEventEntryFromAgent(entry))
        .filter((entry: EventLogEntry | null): entry is EventLogEntry => Boolean(entry));

      return c.json({
        data: events,
        meta: {
          total: typeof payload.total === 'number' ? payload.total : events.length,
          page: typeof payload.page === 'number' ? payload.page : page,
          limit: typeof payload.limit === 'number' ? payload.limit : limit,
          totalPages: typeof payload.totalPages === 'number' ? payload.totalPages : 1
        }
      });
    } catch (error) {
      console.error('Failed to parse agent response for event query:', error);
      return c.json({ error: 'Failed to parse agent response for event query' }, 502);
    }
  }
);

// GET /devices/:deviceId/eventlogs/:name/events/:recordId - Get event
eventLogsRoutes.get(
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

    const result = await executeCommand(deviceId, CommandTypes.EVENT_LOG_GET, {
      logName: name,
      recordId
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    if (result.status === 'failed') {
      const error = result.error || 'Failed to get event';
      return c.json({ error }, error.toLowerCase().includes('not found') ? 404 : 500);
    }

    try {
      const payload = JSON.parse(result.stdout || '{}');
      const event = mapEventEntryFromAgent(payload);
      if (!event) {
        return c.json({ error: 'Invalid event payload from agent' }, 502);
      }
      return c.json({ data: event });
    } catch (error) {
      console.error('Failed to parse agent response for event detail:', error);
      return c.json({ error: 'Failed to parse agent response for event detail' }, 502);
    }
  }
);
