import { Hono } from 'hono';
import { basename } from 'node:path';
import { zValidator } from '@hono/zod-validator';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { executeCommand, CommandTypes } from '../../services/commandQueue';
import { createAuditLog } from '../../services/auditService';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import { getDeviceWithOrgCheck } from './helpers';
import {
  isCommandFailure,
  mapCommandFailure,
  buildBulkItemFailure,
  buildSingleItemUploadBody,
  auditErrorMessage,
} from './fileBrowserHelpers';
import { deviceIdParamSchema, fileListQuerySchema, fileDownloadQuerySchema, fileCopyBodySchema, fileMoveBodySchema, fileDeleteBodySchema, fileTrashRestoreBodySchema, fileTrashPurgeBodySchema, fileUploadBodySchema } from './schemas';

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

    if (isCommandFailure(result)) {
      const { message, status } = mapCommandFailure(result, 'Failed to list files.');
      return c.json({ error: message }, status);
    }

    try {
      const data = JSON.parse(result.stdout || '{}');
      return c.json({ data: data.entries || [] });
    } catch {
      return c.json({ error: 'Failed to parse agent response for file listing' }, 502);
    }
  }
);

// GET /devices/:deviceId/files/drives - List available drives/mount points
fileBrowserRoutes.get(
  '/devices/:deviceId/files/drives',
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

    const result = await executeCommand(deviceId, CommandTypes.FILE_LIST_DRIVES, {}, {
      userId: auth.user?.id,
      timeoutMs: 15000,
    });

    if (isCommandFailure(result)) {
      const { message, status } = mapCommandFailure(result, 'Failed to list drives.');
      return c.json({ error: message }, status);
    }

    try {
      const data = JSON.parse(result.stdout || '{}');
      return c.json({ data: data.drives || [] });
    } catch {
      return c.json({ error: 'Failed to parse agent response for drive listing' }, 502);
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

    if (isCommandFailure(result)) {
      const raw = result.error || '';
      if (raw.toLowerCase().includes('not found')) {
        return c.json({ error: raw }, 404);
      }
      const { message, status } = mapCommandFailure(result, 'Failed to read file.');
      return c.json({ error: message }, status);
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
  zValidator('json', fileUploadBodySchema),
  async (c) => {
    const { deviceId } = c.req.valid('param');
    const auth = c.get('auth');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    const body = c.req.valid('json');

    // Large files (base64-encoded) need more time to transit DB → WS → agent → disk.
    const sizeBytes = Buffer.byteLength(body.content, 'utf8');
    const timeoutMs = sizeBytes > 1024 * 1024 ? 120000 : 30000;

    const result = await executeCommand(deviceId, CommandTypes.FILE_WRITE, {
      path: body.path,
      content: body.content,
      encoding: body.encoding
    }, { userId: auth.user?.id, timeoutMs });

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
      ipAddress: getTrustedClientIpOrUndefined(c),
      result: isCommandFailure(result) ? 'failure' : 'success',
      errorMessage: isCommandFailure(result) ? auditErrorMessage(result) : undefined,
    });

    if (isCommandFailure(result)) {
      const body = buildSingleItemUploadBody(result, 'Failed to write file.');
      const { status, ...payload } = body;
      return c.json(payload, status);
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
      try {
        const result = await executeCommand(deviceId, CommandTypes.FILE_COPY, {
          sourcePath: item.sourcePath,
          destPath: item.destPath,
        }, { userId: auth.user?.id, timeoutMs: 60000 });

        const success = !isCommandFailure(result);
        const failure = success ? null : buildBulkItemFailure(result);
        results.push({
          sourcePath: item.sourcePath,
          destPath: item.destPath,
          status: success ? 'success' : 'failure',
          error: failure?.message,
          unverified: failure?.unverified || undefined,
        });

        await createAuditLog({
          orgId: device.orgId,
          actorId: auth.user.id,
          actorEmail: auth.user.email,
          action: 'file_copy',
          resourceType: 'device',
          resourceId: deviceId,
          resourceName: device.hostname ?? device.id,
          details: { sourcePath: item.sourcePath, destPath: item.destPath, unverified: failure?.unverified || undefined },
          ipAddress: getTrustedClientIpOrUndefined(c),
          result: success ? 'success' : 'failure',
          errorMessage: success ? undefined : auditErrorMessage(result),
        }).catch(auditErr => console.error(`[fileBrowser] audit log failed for device ${deviceId}:`, auditErr instanceof Error ? auditErr.message : auditErr));
      } catch (err) {
        results.push({
          sourcePath: item.sourcePath,
          destPath: item.destPath,
          status: 'failure',
          error: err instanceof Error ? err.message : 'Unexpected error',
        });
      }
    }

    const allFailed = results.length > 0 && results.every(r => r.status === 'failure');
    return c.json({ results }, allFailed ? 502 : 200);
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
      try {
        const result = await executeCommand(deviceId, CommandTypes.FILE_RENAME, {
          oldPath: item.sourcePath,
          newPath: item.destPath,
        }, { userId: auth.user?.id, timeoutMs: 60000 });

        const success = !isCommandFailure(result);
        const failure = success ? null : buildBulkItemFailure(result);
        results.push({
          sourcePath: item.sourcePath,
          destPath: item.destPath,
          status: success ? 'success' : 'failure',
          error: failure?.message,
          unverified: failure?.unverified || undefined,
        });

        await createAuditLog({
          orgId: device.orgId,
          actorId: auth.user.id,
          actorEmail: auth.user.email,
          action: 'file_move',
          resourceType: 'device',
          resourceId: deviceId,
          resourceName: device.hostname ?? device.id,
          details: { sourcePath: item.sourcePath, destPath: item.destPath, unverified: failure?.unverified || undefined },
          ipAddress: getTrustedClientIpOrUndefined(c),
          result: success ? 'success' : 'failure',
          errorMessage: success ? undefined : auditErrorMessage(result),
        }).catch(auditErr => console.error(`[fileBrowser] audit log failed for device ${deviceId}:`, auditErr instanceof Error ? auditErr.message : auditErr));
      } catch (err) {
        results.push({
          sourcePath: item.sourcePath,
          destPath: item.destPath,
          status: 'failure',
          error: err instanceof Error ? err.message : 'Unexpected error',
        });
      }
    }

    const allFailed = results.length > 0 && results.every(r => r.status === 'failure');
    return c.json({ results }, allFailed ? 502 : 200);
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
      try {
        const result = await executeCommand(deviceId, CommandTypes.FILE_DELETE, {
          path,
          permanent,
          recursive: true,
          deletedBy: auth.user?.email || auth.user?.id,
        }, { userId: auth.user?.id, timeoutMs: 30000 });

        const success = !isCommandFailure(result);
        const failure = success ? null : buildBulkItemFailure(result);
        results.push({
          path,
          status: success ? 'success' : 'failure',
          error: failure?.message,
          unverified: failure?.unverified || undefined,
        });

        await createAuditLog({
          orgId: device.orgId,
          actorId: auth.user.id,
          actorEmail: auth.user.email,
          action: 'file_delete',
          resourceType: 'device',
          resourceId: deviceId,
          resourceName: device.hostname ?? device.id,
          details: { path, permanent, unverified: failure?.unverified || undefined },
          ipAddress: getTrustedClientIpOrUndefined(c),
          result: success ? 'success' : 'failure',
          errorMessage: success ? undefined : auditErrorMessage(result),
        }).catch(auditErr => console.error(`[fileBrowser] audit log failed for device ${deviceId}:`, auditErr instanceof Error ? auditErr.message : auditErr));
      } catch (err) {
        results.push({
          path,
          status: 'failure',
          error: err instanceof Error ? err.message : 'Unexpected error',
        });
      }
    }

    const allFailed = results.length > 0 && results.every(r => r.status === 'failure');
    return c.json({ results }, allFailed ? 502 : 200);
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

    if (isCommandFailure(result)) {
      const { message, status } = mapCommandFailure(result, 'Failed to list trash.');
      return c.json({ error: message }, status);
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
      try {
        const result = await executeCommand(deviceId, CommandTypes.FILE_TRASH_RESTORE, {
          trashId,
        }, { userId: auth.user?.id, timeoutMs: 30000 });

        const success = !isCommandFailure(result);
        const failure = success ? null : buildBulkItemFailure(result);
        let restoredPath: string | undefined;
        if (success) {
          try {
            const data = JSON.parse(result.stdout || '{}');
            restoredPath = data.restoredPath;
          } catch (parseErr) {
            console.error(`[fileBrowser] failed to parse restore response for device ${deviceId}:`, parseErr instanceof Error ? parseErr.message : parseErr);
          }
        }

        results.push({
          trashId,
          status: success ? 'success' : 'failure',
          restoredPath,
          error: failure?.message,
          unverified: failure?.unverified || undefined,
        });

        await createAuditLog({
          orgId: device.orgId,
          actorId: auth.user.id,
          actorEmail: auth.user.email,
          action: 'file_restore',
          resourceType: 'device',
          resourceId: deviceId,
          resourceName: device.hostname ?? device.id,
          details: { trashId, restoredPath, unverified: failure?.unverified || undefined },
          ipAddress: getTrustedClientIpOrUndefined(c),
          result: success ? 'success' : 'failure',
          errorMessage: success ? undefined : auditErrorMessage(result),
        }).catch(auditErr => console.error(`[fileBrowser] audit log failed for device ${deviceId}:`, auditErr instanceof Error ? auditErr.message : auditErr));
      } catch (err) {
        results.push({
          trashId,
          status: 'failure',
          error: err instanceof Error ? err.message : 'Unexpected error',
        });
      }
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

    const success = !isCommandFailure(result);

    await createAuditLog({
      orgId: device.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'file_trash_purge',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.id,
      details: {
        trashIds: body.trashIds,
        purgeAll: !body.trashIds,
        unverified: result.status === 'timeout' ? true : undefined,
      },
      ipAddress: getTrustedClientIpOrUndefined(c),
      result: success ? 'success' : 'failure',
      errorMessage: success ? undefined : auditErrorMessage(result),
    }).catch(auditErr => console.error(`[fileBrowser] audit log failed for device ${deviceId}:`, auditErr instanceof Error ? auditErr.message : auditErr));

    if (isCommandFailure(result)) {
      const { message, status } = mapCommandFailure(result, 'Failed to purge trash.', { mutating: true });
      return c.json({ error: message }, status);
    }

    try {
      const data = JSON.parse(result.stdout || '{}');
      return c.json({ success: true, purged: data.purged || 0 });
    } catch (parseErr) {
      console.error(`[fileBrowser] failed to parse purge response for device ${deviceId}:`, parseErr instanceof Error ? parseErr.message : parseErr);
      return c.json({ success: true, warning: 'Could not confirm purge count from agent' });
    }
  }
);
