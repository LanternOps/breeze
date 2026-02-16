import { z } from 'zod';

export const deviceIdParamSchema = z.object({
  deviceId: z.string().uuid()
});

export const pidParamSchema = z.object({
  deviceId: z.string().uuid(),
  pid: z.string().transform(val => parseInt(val, 10))
});

export const serviceNameParamSchema = z.object({
  deviceId: z.string().uuid(),
  name: z.string().min(1).max(256)
});

export const registryQuerySchema = z.object({
  hive: z.enum(['HKEY_LOCAL_MACHINE', 'HKEY_CURRENT_USER', 'HKEY_CLASSES_ROOT', 'HKEY_USERS', 'HKEY_CURRENT_CONFIG']),
  path: z.string().min(0).max(1024)
});

export const registryValueQuerySchema = registryQuerySchema.extend({
  name: z.string().min(0).max(256)
});

export const registryValueBodySchema = z.object({
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

export const registryKeyBodySchema = z.object({
  hive: z.enum(['HKEY_LOCAL_MACHINE', 'HKEY_CURRENT_USER', 'HKEY_CLASSES_ROOT', 'HKEY_USERS', 'HKEY_CURRENT_CONFIG']),
  path: z.string().min(1).max(1024)
});

export const registryKeyQuerySchema = z.object({
  hive: z.enum(['HKEY_LOCAL_MACHINE', 'HKEY_CURRENT_USER', 'HKEY_CLASSES_ROOT', 'HKEY_USERS', 'HKEY_CURRENT_CONFIG']),
  path: z.string().min(1).max(1024)
});

export const eventLogNameParamSchema = z.object({
  deviceId: z.string().uuid(),
  name: z.string().min(1).max(256)
});

export const eventLogQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  level: z.enum(['information', 'warning', 'error', 'critical', 'verbose']).optional(),
  source: z.string().optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  eventId: z.string().transform(val => parseInt(val, 10)).optional()
});

export const eventRecordParamSchema = z.object({
  deviceId: z.string().uuid(),
  name: z.string().min(1).max(256),
  recordId: z.string().transform(val => parseInt(val, 10))
});

export const taskPathParamSchema = z.object({
  deviceId: z.string().uuid(),
  path: z.string().min(1).max(512)
});

export const taskHistoryQuerySchema = z.object({
  limit: z.string().optional()
});

export const fileListQuerySchema = z.object({
  path: z.string().min(1).max(2048)
});

export const fileDownloadQuerySchema = z.object({
  path: z.string().min(1).max(2048)
});

export const paginationQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional()
});
