import { z } from 'zod';

export const deviceIdParamSchema = z.object({
  deviceId: z.string().guid()
});

export const pidParamSchema = z.object({
  deviceId: z.string().guid(),
  pid: z.string().transform(val => parseInt(val, 10))
});

export const serviceNameParamSchema = z.object({
  deviceId: z.string().guid(),
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
    z.record(z.string(), z.number())
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
  deviceId: z.string().guid(),
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
  deviceId: z.string().guid(),
  name: z.string().min(1).max(256),
  recordId: z.string().transform(val => parseInt(val, 10))
});

export const taskPathParamSchema = z.object({
  deviceId: z.string().guid(),
  path: z.string().min(1).max(512)
});

export const taskHistoryQuerySchema = z.object({
  limit: z.string().optional()
});

export const paginationQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional()
});

// File operation schemas

// Check both forward and back slashes since paths may come from Windows or Unix agents
const filePathString = z.string().min(1).max(2048).refine(
  (val) => !val.includes('\0') && !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(val),
  { message: 'Invalid path: null bytes and path traversal (..) are not allowed' }
);

export const fileListQuerySchema = z.object({
  path: filePathString
});

export const fileDownloadQuerySchema = z.object({
  path: filePathString
});

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

// The agent rejects file_write payloads over 4MB decoded
// (agent/internal/remote/tools/fileops.go MaxFileWriteSize), and its WebSocket
// read limit is sized from that cap (agent/internal/websocket/client.go
// maxMessageSize, issue #2399) — an oversized frame is not gracefully
// rejected, it kills the agent's WS connection. Enforce the same bound here so
// the API never emits a file_write frame the agent cannot accept. Larger
// transfers go through the chunked file-transfer endpoints instead.
export const AGENT_MAX_FILE_WRITE_BYTES = 4 * 1024 * 1024;
// Mirrors Go's base64.StdEncoding.EncodedLen(n): ceil(n/3)*4, padding included.
export const AGENT_MAX_FILE_WRITE_BASE64_CHARS =
  Math.ceil(AGENT_MAX_FILE_WRITE_BYTES / 3) * 4;

export const fileUploadBodySchema = z
  .object({
    path: filePathString,
    // Custom message: the char count references the invisible base64 blob,
    // not the user's file — surface the actionable limit instead (the
    // FileManager UI always uploads base64 and renders this message verbatim).
    content: z
      .string()
      .min(0)
      .max(AGENT_MAX_FILE_WRITE_BASE64_CHARS, {
        message: 'File too large (max 4MB); use file transfer for larger files',
      }),
    encoding: z.enum(['base64', 'text']).optional().default('text'),
  })
  .superRefine((body, ctx) => {
    // The .max() above bounds base64 exactly; text content is measured in
    // UTF-8 bytes (what the agent writes to disk), which can exceed the char
    // count for multi-byte content.
    const tooLarge =
      body.encoding === 'text' &&
      Buffer.byteLength(body.content, 'utf8') > AGENT_MAX_FILE_WRITE_BYTES;
    if (tooLarge) {
      ctx.addIssue({
        code: 'custom',
        path: ['content'],
        message: `File too large (max ${AGENT_MAX_FILE_WRITE_BYTES / (1024 * 1024)}MB); use file transfer for larger files`,
      });
    }
  });
