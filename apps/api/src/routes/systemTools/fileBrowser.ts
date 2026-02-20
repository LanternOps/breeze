import { Hono } from 'hono';
import { basename } from 'node:path';
import { zValidator } from '@hono/zod-validator';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { executeCommand, CommandTypes } from '../../services/commandQueue';
import { createAuditLog } from '../../services/auditService';
import { getDeviceWithOrgCheck } from './helpers';
import { deviceIdParamSchema, fileListQuerySchema, fileDownloadQuerySchema, fileCopyBodySchema, fileMoveBodySchema, fileDeleteBodySchema, fileTrashRestoreBodySchema, fileTrashPurgeBodySchema } from './schemas';

export const fileBrowserRoutes = new Hono();

// GET /devices/:deviceId/files - List files for a path
fileBrowserRoutes.get(
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

// GET /devices/:deviceId/files/download - Download a file
fileBrowserRoutes.get(
  '/devices/:deviceId/files/download',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', fileDownloadQuerySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const { path } = c.req.valid('query');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const result = await executeCommand(deviceId, CommandTypes.FILE_READ, {
      path,
      encoding: 'base64'
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    if (result.status === 'failed') {
      const error = result.error || 'Failed to read file';
      return c.json({ error }, error.toLowerCase().includes('not found') ? 404 : 500);
    }

    try {
      const payload = JSON.parse(result.stdout || '{}');
      const encodedContent = typeof payload.content === 'string' ? payload.content : '';
      if (!encodedContent) {
        return c.json({ error: 'Invalid file payload from agent' }, 502);
      }

      const fileData = Buffer.from(encodedContent, 'base64');
      const filename = basename(typeof payload.path === 'string' ? payload.path : path) || 'download.bin';

      const safeFilename = filename
        // Disallow header injection via CRLF.
        .replace(/[\r\n]/g, '')
        // Escape quoted-string backslashes and quotes.
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"');

      c.header('Content-Type', 'application/octet-stream');
      c.header('Content-Disposition', `attachment; filename="${safeFilename}"`);
      c.header('Content-Length', String(fileData.length));
      return c.body(fileData);
    } catch (error) {
      console.error('Failed to parse agent response for file download:', error);
      return c.json({ error: 'Failed to parse agent response for file download' }, 502);
    }
  }
);

// POST /devices/:deviceId/files/upload - Upload a file
fileBrowserRoutes.post(
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

// POST /devices/:deviceId/files/copy - Copy files
fileBrowserRoutes.post(
  '/devices/:deviceId/files/copy',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('json', fileCopyBodySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const { items } = c.req.valid('json');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const results = [];
    for (const item of items) {
      const result = await executeCommand(deviceId, CommandTypes.FILE_COPY, {
        sourcePath: item.sourcePath,
        destPath: item.destPath,
      }, { userId: auth.user?.id, timeoutMs: 60000 });

      const success = result.status !== 'failed';
      results.push({
        sourcePath: item.sourcePath,
        destPath: item.destPath,
        status: success ? 'success' : 'failure',
        error: success ? undefined : result.error,
      });

      await createAuditLog({
        orgId: device.orgId,
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'file_copy',
        resourceType: 'device',
        resourceId: deviceId,
        resourceName: device.hostname ?? device.id,
        details: { sourcePath: item.sourcePath, destPath: item.destPath },
        ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
        result: success ? 'success' : 'failure',
        errorMessage: success ? undefined : result.error,
      });
    }

    return c.json({ results });
  }
);

// POST /devices/:deviceId/files/move - Move/rename files
fileBrowserRoutes.post(
  '/devices/:deviceId/files/move',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('json', fileMoveBodySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const { items } = c.req.valid('json');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const results = [];
    for (const item of items) {
      const result = await executeCommand(deviceId, CommandTypes.FILE_RENAME, {
        oldPath: item.sourcePath,
        newPath: item.destPath,
      }, { userId: auth.user?.id, timeoutMs: 60000 });

      const success = result.status !== 'failed';
      results.push({
        sourcePath: item.sourcePath,
        destPath: item.destPath,
        status: success ? 'success' : 'failure',
        error: success ? undefined : result.error,
      });

      await createAuditLog({
        orgId: device.orgId,
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'file_move',
        resourceType: 'device',
        resourceId: deviceId,
        resourceName: device.hostname ?? device.id,
        details: { sourcePath: item.sourcePath, destPath: item.destPath },
        ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
        result: success ? 'success' : 'failure',
        errorMessage: success ? undefined : result.error,
      });
    }

    return c.json({ results });
  }
);

// POST /devices/:deviceId/files/delete - Delete files (move to trash)
fileBrowserRoutes.post(
  '/devices/:deviceId/files/delete',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('json', fileDeleteBodySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const { paths, permanent } = c.req.valid('json');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const results = [];
    for (const path of paths) {
      const result = await executeCommand(deviceId, CommandTypes.FILE_DELETE, {
        path,
        permanent,
        recursive: true,
        deletedBy: auth.user?.email || auth.user?.id,
      }, { userId: auth.user?.id, timeoutMs: 30000 });

      const success = result.status !== 'failed';
      results.push({
        path,
        status: success ? 'success' : 'failure',
        error: success ? undefined : result.error,
      });

      await createAuditLog({
        orgId: device.orgId,
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'file_delete',
        resourceType: 'device',
        resourceId: deviceId,
        resourceName: device.hostname ?? device.id,
        details: { path, permanent },
        ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
        result: success ? 'success' : 'failure',
        errorMessage: success ? undefined : result.error,
      });
    }

    return c.json({ results });
  }
);

// GET /devices/:deviceId/files/trash - List trash contents
fileBrowserRoutes.get(
  '/devices/:deviceId/files/trash',
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

    const result = await executeCommand(deviceId, CommandTypes.FILE_TRASH_LIST, {}, { userId: auth.user?.id, timeoutMs: 30000 });

    if (result.status === 'failed') {
      return c.json({ error: result.error || 'Failed to list trash' }, 502);
    }

    try {
      const data = JSON.parse(result.stdout || '{}');
      return c.json({ data: data.items || [] });
    } catch {
      return c.json({ error: 'Failed to parse trash list response' }, 502);
    }
  }
);

// POST /devices/:deviceId/files/trash/restore - Restore from trash
fileBrowserRoutes.post(
  '/devices/:deviceId/files/trash/restore',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('json', fileTrashRestoreBodySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const { trashIds } = c.req.valid('json');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const results = [];
    for (const trashId of trashIds) {
      const result = await executeCommand(deviceId, CommandTypes.FILE_TRASH_RESTORE, {
        trashId,
      }, { userId: auth.user?.id, timeoutMs: 30000 });

      const success = result.status !== 'failed';
      let restoredPath: string | undefined;
      if (success) {
        try {
          const data = JSON.parse(result.stdout || '{}');
          restoredPath = data.restoredPath;
        } catch { /* ignore parse error */ }
      }

      results.push({
        trashId,
        status: success ? 'success' : 'failure',
        restoredPath,
        error: success ? undefined : result.error,
      });

      await createAuditLog({
        orgId: device.orgId,
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'file_restore',
        resourceType: 'device',
        resourceId: deviceId,
        resourceName: device.hostname ?? device.id,
        details: { trashId, restoredPath },
        ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
        result: success ? 'success' : 'failure',
        errorMessage: success ? undefined : result.error,
      });
    }

    return c.json({ results });
  }
);

// POST /devices/:deviceId/files/trash/purge - Permanently delete from trash
fileBrowserRoutes.post(
  '/devices/:deviceId/files/trash/purge',
  authMiddleware,
  requireScope('system', 'partner', 'organization'),
  zValidator('param', deviceIdParamSchema),
  zValidator('json', fileTrashPurgeBodySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const body = c.req.valid('json');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const result = await executeCommand(deviceId, CommandTypes.FILE_TRASH_PURGE, {
      trashIds: body.trashIds || [],
    }, { userId: auth.user?.id, timeoutMs: 30000 });

    const success = result.status !== 'failed';

    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'file_trash_purge',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: { trashIds: body.trashIds, purgeAll: !body.trashIds },
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
      result: success ? 'success' : 'failure',
      errorMessage: success ? undefined : result.error,
    });

    if (result.status === 'failed') {
      return c.json({ error: result.error || 'Failed to purge trash' }, 502);
    }

    try {
      const data = JSON.parse(result.stdout || '{}');
      return c.json({ success: true, purged: data.purged || 0 });
    } catch {
      return c.json({ success: true });
    }
  }
);
