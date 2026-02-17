import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, sql, desc, inArray } from 'drizzle-orm';
import { db } from '../../db';
import {
  fileTransfers,
  devices,
  users
} from '../../db/schema';
import { requireScope } from '../../middleware/auth';
import { saveChunk, assembleChunks, getFileStream, getFileSize, hasAssembledFile, getTotalBytesReceived, MAX_TRANSFER_SIZE_BYTES } from '../../services/fileStorage';
import { Readable } from 'stream';
import { createTransferSchema, listTransfersSchema } from './schemas';
import {
  getPagination,
  getDeviceWithOrgCheck,
  getSessionWithOrgCheck,
  getTransferWithOrgCheck,
  hasSessionOrTransferOwnership,
  logSessionAudit,
  MAX_ACTIVE_TRANSFERS_PER_ORG,
  MAX_ACTIVE_TRANSFERS_PER_USER
} from './helpers';

export const transferRoutes = new Hono();

// POST /remote/transfers - Initiate file transfer
transferRoutes.post(
  '/transfers',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createTransferSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    // Verify device access
    const device = await getDeviceWithOrgCheck(data.deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found or access denied' }, 404);
    }

    // Check device is online
    if (device.status !== 'online') {
      return c.json({ error: 'Device is not online', deviceStatus: device.status }, 400);
    }

    // Guardrail: cap concurrent transfers per org (and per user) to prevent disk/CPU exhaustion.
    const activeTransferStatuses = ['pending', 'transferring'] as const;
    if (MAX_ACTIVE_TRANSFERS_PER_ORG > 0) {
      const orgTransferCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(fileTransfers)
        .innerJoin(devices, eq(fileTransfers.deviceId, devices.id))
        .where(and(
          eq(devices.orgId, device.orgId),
          inArray(fileTransfers.status, [...activeTransferStatuses])
        ));

      const currentCount = Number(orgTransferCount[0]?.count ?? 0);
      if (currentCount >= MAX_ACTIVE_TRANSFERS_PER_ORG) {
        return c.json({
          error: 'Maximum concurrent transfers reached for this organization',
          currentCount,
          maxAllowed: MAX_ACTIVE_TRANSFERS_PER_ORG
        }, 429);
      }
    }

    if (MAX_ACTIVE_TRANSFERS_PER_USER > 0 && auth.scope !== 'system') {
      const userTransferCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(fileTransfers)
        .innerJoin(devices, eq(fileTransfers.deviceId, devices.id))
        .where(and(
          eq(devices.orgId, device.orgId),
          eq(fileTransfers.userId, auth.user.id),
          inArray(fileTransfers.status, [...activeTransferStatuses])
        ));

      const currentCount = Number(userTransferCount[0]?.count ?? 0);
      if (currentCount >= MAX_ACTIVE_TRANSFERS_PER_USER) {
        return c.json({
          error: 'Maximum concurrent transfers reached for this user',
          currentCount,
          maxAllowed: MAX_ACTIVE_TRANSFERS_PER_USER
        }, 429);
      }
    }

    // Verify session if provided
    if (data.sessionId) {
      const sessionResult = await getSessionWithOrgCheck(data.sessionId, auth);
      if (!sessionResult) {
        return c.json({ error: 'Session not found' }, 404);
      }
      if (sessionResult.session.status !== 'active') {
        return c.json({ error: 'Session is not active' }, 400);
      }
      if (!hasSessionOrTransferOwnership(auth, sessionResult.session.userId)) {
        return c.json({ error: 'Access denied' }, 403);
      }
    }

    // Create transfer record
    const [transfer] = await db
      .insert(fileTransfers)
      .values({
        sessionId: data.sessionId || null,
        deviceId: data.deviceId,
        userId: auth.user.id,
        direction: data.direction,
        remotePath: data.remotePath,
        localFilename: data.localFilename,
        sizeBytes: BigInt(data.sizeBytes),
        status: 'pending',
        progressPercent: 0
      })
      .returning();

    if (!transfer) {
      return c.json({ error: 'Failed to create transfer' }, 500);
    }

    // Log audit event
    await logSessionAudit(
      'file_transfer_initiated',
      auth.user.id,
      device.orgId,
      {
        transferId: transfer.id,
        deviceId: data.deviceId,
        deviceHostname: device.hostname,
        direction: data.direction,
        remotePath: data.remotePath,
        localFilename: data.localFilename,
        sizeBytes: data.sizeBytes
      },
      c.req.header('X-Forwarded-For') || c.req.header('X-Real-IP')
    );

    return c.json({
      id: transfer.id,
      sessionId: transfer.sessionId,
      deviceId: transfer.deviceId,
      userId: transfer.userId,
      direction: transfer.direction,
      remotePath: transfer.remotePath,
      localFilename: transfer.localFilename,
      sizeBytes: Number(transfer.sizeBytes),
      status: transfer.status,
      progressPercent: transfer.progressPercent,
      createdAt: transfer.createdAt,
      device: {
        id: device.id,
        hostname: device.hostname
      }
    }, 201);
  }
);

// GET /remote/transfers - List transfers
transferRoutes.get(
  '/transfers',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listTransfersSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    // Build conditions array
    const conditions: ReturnType<typeof eq>[] = [];

    // Filter by org access based on scope
    if (auth.scope === 'organization') {
    if (!auth.orgId) {
      return c.json({ error: 'Organization context required' }, 403);
    }
    conditions.push(eq(devices.orgId, auth.orgId));
  } else if (auth.scope === 'partner') {
    const orgIds = auth.accessibleOrgIds ?? [];
    if (orgIds.length === 0) {
      return c.json({
        data: [],
        pagination: { page, limit, total: 0 }
      });
    }
    conditions.push(inArray(devices.orgId, orgIds));
    }

    if (auth.scope !== 'system') {
      conditions.push(eq(fileTransfers.userId, auth.user.id));
    }

    // Additional filters
    if (query.deviceId) {
      conditions.push(eq(fileTransfers.deviceId, query.deviceId));
    }

    if (query.status) {
      conditions.push(eq(fileTransfers.status, query.status));
    }

    if (query.direction) {
      conditions.push(eq(fileTransfers.direction, query.direction));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(fileTransfers)
      .innerJoin(devices, eq(fileTransfers.deviceId, devices.id))
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Get transfers with device info
    const transfersList = await db
      .select({
        id: fileTransfers.id,
        sessionId: fileTransfers.sessionId,
        deviceId: fileTransfers.deviceId,
        userId: fileTransfers.userId,
        direction: fileTransfers.direction,
        remotePath: fileTransfers.remotePath,
        localFilename: fileTransfers.localFilename,
        sizeBytes: fileTransfers.sizeBytes,
        status: fileTransfers.status,
        progressPercent: fileTransfers.progressPercent,
        errorMessage: fileTransfers.errorMessage,
        createdAt: fileTransfers.createdAt,
        completedAt: fileTransfers.completedAt,
        deviceHostname: devices.hostname,
        userName: users.name
      })
      .from(fileTransfers)
      .innerJoin(devices, eq(fileTransfers.deviceId, devices.id))
      .leftJoin(users, eq(fileTransfers.userId, users.id))
      .where(whereCondition)
      .orderBy(desc(fileTransfers.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: transfersList.map(t => ({
        id: t.id,
        sessionId: t.sessionId,
        deviceId: t.deviceId,
        userId: t.userId,
        direction: t.direction,
        remotePath: t.remotePath,
        localFilename: t.localFilename,
        sizeBytes: Number(t.sizeBytes),
        status: t.status,
        progressPercent: t.progressPercent,
        errorMessage: t.errorMessage,
        createdAt: t.createdAt,
        completedAt: t.completedAt,
        device: { hostname: t.deviceHostname },
        user: { name: t.userName }
      })),
      pagination: { page, limit, total }
    });
  }
);

// GET /remote/transfers/:id - Get transfer details/progress
transferRoutes.get(
  '/transfers/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const transferId = c.req.param('id');

    const result = await getTransferWithOrgCheck(transferId, auth);
    if (!result) {
      return c.json({ error: 'Transfer not found' }, 404);
    }

    const { transfer, device } = result;
    if (!hasSessionOrTransferOwnership(auth, transfer.userId)) {
      return c.json({ error: 'Access denied' }, 403);
    }

    // Get user info
    const [user] = await db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, transfer.userId))
      .limit(1);

    return c.json({
      id: transfer.id,
      sessionId: transfer.sessionId,
      deviceId: transfer.deviceId,
      userId: transfer.userId,
      direction: transfer.direction,
      remotePath: transfer.remotePath,
      localFilename: transfer.localFilename,
      sizeBytes: Number(transfer.sizeBytes),
      status: transfer.status,
      progressPercent: transfer.progressPercent,
      errorMessage: transfer.errorMessage,
      createdAt: transfer.createdAt,
      completedAt: transfer.completedAt,
      device: {
        id: device.id,
        hostname: device.hostname,
        osType: device.osType
      },
      user: user ? { name: user.name, email: user.email } : null
    });
  }
);

// POST /remote/transfers/:id/cancel - Cancel transfer
transferRoutes.post(
  '/transfers/:id/cancel',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const transferId = c.req.param('id');

    const result = await getTransferWithOrgCheck(transferId, auth);
    if (!result) {
      return c.json({ error: 'Transfer not found' }, 404);
    }

    const { transfer, device } = result;
    if (!hasSessionOrTransferOwnership(auth, transfer.userId)) {
      return c.json({ error: 'Access denied' }, 403);
    }

    // Only allow cancelling pending or transferring transfers
    if (!['pending', 'transferring'].includes(transfer.status)) {
      return c.json({
        error: 'Cannot cancel transfer in current state',
        status: transfer.status
      }, 400);
    }

    const [updated] = await db
      .update(fileTransfers)
      .set({
        status: 'failed',
        errorMessage: 'Cancelled by user',
        completedAt: new Date()
      })
      .where(eq(fileTransfers.id, transferId))
      .returning();

    if (!updated) {
      return c.json({ error: 'Failed to update transfer' }, 500);
    }

    // Log audit event
    await logSessionAudit(
      'file_transfer_cancelled',
      auth.user.id,
      device.orgId,
      {
        transferId,
        deviceId: device.id,
        deviceHostname: device.hostname,
        direction: transfer.direction,
        remotePath: transfer.remotePath
      },
      c.req.header('X-Forwarded-For') || c.req.header('X-Real-IP')
    );

    return c.json({
      id: updated.id,
      status: updated.status,
      errorMessage: updated.errorMessage,
      completedAt: updated.completedAt
    });
  }
);

// POST /remote/transfers/:id/chunks - Upload a chunk (from agent, multipart)
transferRoutes.post(
  '/transfers/:id/chunks',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const transferId = c.req.param('id');

    const result = await getTransferWithOrgCheck(transferId, auth);
    if (!result) {
      return c.json({ error: 'Transfer not found' }, 404);
    }

    const { transfer, device } = result;
    if (!hasSessionOrTransferOwnership(auth, transfer.userId)) {
      return c.json({ error: 'Access denied' }, 403);
    }

    if (!['pending', 'transferring'].includes(transfer.status)) {
      return c.json({ error: 'Cannot upload chunks in current state', status: transfer.status }, 400);
    }

    // Parse multipart form data
    const formData = await c.req.formData();
    const chunkIndexStr = formData.get('chunkIndex');
    const chunkFile = formData.get('data');

    if (chunkIndexStr === null || !chunkFile) {
      return c.json({ error: 'Missing chunkIndex or data' }, 400);
    }

    const chunkIndex = parseInt(String(chunkIndexStr), 10);
    if (isNaN(chunkIndex) || chunkIndex < 0) {
      return c.json({ error: 'Invalid chunkIndex' }, 400);
    }

    let chunkData: Buffer;
    if (chunkFile instanceof File) {
      chunkData = Buffer.from(await chunkFile.arrayBuffer());
    } else {
      chunkData = Buffer.from(String(chunkFile));
    }

    // Check total size doesn't exceed limit
    const currentBytes = getTotalBytesReceived(transferId);
    if (currentBytes + chunkData.length > MAX_TRANSFER_SIZE_BYTES) {
      return c.json({ error: `Transfer exceeds maximum size of ${MAX_TRANSFER_SIZE_BYTES / (1024 * 1024)}MB` }, 413);
    }

    await saveChunk(transferId, chunkIndex, chunkData);

    // Update progress
    const totalReceived = currentBytes + chunkData.length;
    const sizeBytes = Number(transfer.sizeBytes);
    const progressPercent = sizeBytes > 0
      ? Math.min(100, Math.round((totalReceived / sizeBytes) * 100))
      : 0;

    const updates: Record<string, unknown> = {
      status: 'transferring',
      progressPercent
    };

    // If all bytes received, assemble and mark complete
    if (sizeBytes > 0 && totalReceived >= sizeBytes) {
      try {
        await assembleChunks(transferId);
        updates.status = 'completed';
        updates.progressPercent = 100;
        updates.completedAt = new Date();
      } catch (err) {
        updates.status = 'failed';
        updates.errorMessage = `Assembly failed: ${err instanceof Error ? err.message : 'unknown'}`;
      }
    }

    await db
      .update(fileTransfers)
      .set(updates)
      .where(eq(fileTransfers.id, transferId));

    return c.json({
      chunkIndex,
      bytesReceived: totalReceived,
      progressPercent: updates.progressPercent,
      status: updates.status
    });
  }
);

// GET /remote/transfers/:id/download - Download completed file (upload direction)
transferRoutes.get(
  '/transfers/:id/download',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const transferId = c.req.param('id');

    const result = await getTransferWithOrgCheck(transferId, auth);
    if (!result) {
      return c.json({ error: 'Transfer not found' }, 404);
    }

    const { transfer } = result;
    if (!hasSessionOrTransferOwnership(auth, transfer.userId)) {
      return c.json({ error: 'Access denied' }, 403);
    }

    // Only allow download for completed upload transfers
    if (transfer.direction !== 'upload') {
      return c.json({ error: 'Can only download files from upload transfers' }, 400);
    }

    if (transfer.status !== 'completed') {
      return c.json({
        error: 'Transfer is not completed',
        status: transfer.status
      }, 400);
    }

    if (!hasAssembledFile(transferId)) {
      return c.json({ error: 'File not found in storage' }, 404);
    }

    const fileSize = getFileSize(transferId);
    const stream = getFileStream(transferId);
    if (!stream) {
      return c.json({ error: 'Failed to read file' }, 500);
    }

    // Convert Node.js Readable to a web ReadableStream
    const webStream = Readable.toWeb(stream) as ReadableStream;

    return new Response(webStream, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(transfer.localFilename)}"`,
        'Content-Length': String(fileSize),
      },
    });
  }
);
