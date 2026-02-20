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

// File operation schemas

const filePathString = z.string().min(1).max(2048).refine(
  (val) => !val.includes('\0') && !val.split('/').includes('..') && !val.split('\\').includes('..'),
  { message: 'Invalid path: null bytes and path traversal (..) are not allowed' }
);

export const fileCopyBodySchema = z.object({
  items: z.array(z.object({
    sourcePath: filePathString,
    destPath: filePathString,
  })).min(1).max(100),
});

export const fileMoveBodySchema = z.object({
  items: z.array(z.object({
    sourcePath: filePathString,
    destPath: filePathString,
  })).min(1).max(100),
});

export const fileDeleteBodySchema = z.object({
  paths: z.array(filePathString).min(1).max(100),
  permanent: z.boolean().optional().default(false),
});

const trashIdString = z.string().min(1).max(512).refine(
  (val) => !val.includes('/') && !val.includes('\\') && !val.includes('..') && !val.includes('\0'),
  { message: 'Invalid trash ID: must not contain path separators or traversal sequences' }
);

export const fileTrashRestoreBodySchema = z.object({
  trashIds: z.array(trashIdString).min(1).max(100),
});

export const fileTrashPurgeBodySchema = z.object({
  trashIds: z.array(trashIdString).optional(),
});
