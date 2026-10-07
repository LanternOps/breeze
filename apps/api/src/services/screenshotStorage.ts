/**
 * Screenshot Storage Service
 *
 * Handles temporary storage of screenshots for AI vision analysis.
 * Uses local filesystem. Screenshots auto-expire based on retention policy.
 */

import { db } from '../db';
import { aiScreenshots } from '../db/schema/ai';
import { eq, and, gt, lte, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { writeFile, mkdir, unlink, readFile } from 'fs/promises';
import { join } from 'path';
import { envInt } from '../utils/envInt';

const SCREENSHOT_DIR = process.env.SCREENSHOT_STORAGE_DIR || '/tmp/breeze-screenshots';
const DEFAULT_RETENTION_HOURS = 24;

/**
 * Per-device storage budget. `ai_screenshots` has no quota today, so a single
 * device can write an unbounded number of ~1 MiB-body-gated files until the
 * shared `SCREENSHOT_STORAGE_DIR` fills — a 64 MB tmpfs in the repo compose,
 * or the host disk if a droplet points the dir at a real volume — breaking
 * screenshot capture, installer-zip builds and software uploads for every
 * tenant on the instance. Bounding one device's LIVE (non-expired) footprint
 * keeps that failure local to the offending device instead.
 */
const MAX_SCREENSHOT_BYTES = envInt('SCREENSHOT_MAX_BYTES', 1_600_000);
const MAX_SCREENSHOTS_PER_DEVICE = envInt('SCREENSHOT_MAX_PER_DEVICE', 20);
const MAX_SCREENSHOT_BYTES_PER_DEVICE = envInt(
  'SCREENSHOT_MAX_BYTES_PER_DEVICE',
  MAX_SCREENSHOTS_PER_DEVICE * MAX_SCREENSHOT_BYTES,
);

export class ScreenshotTooLargeError extends Error {
  constructor(public readonly sizeBytes: number, public readonly maxBytes: number) {
    super(`Screenshot of ${sizeBytes} bytes exceeds the ${maxBytes} byte limit`);
    this.name = 'ScreenshotTooLargeError';
  }
}

export class ScreenshotQuotaExceededError extends Error {
  constructor(public readonly deviceId: string, public readonly reason: 'count' | 'bytes') {
    super(`Device ${deviceId} exceeded its live screenshot ${reason} quota`);
    this.name = 'ScreenshotQuotaExceededError';
  }
}

interface StoreScreenshotParams {
  deviceId: string;
  orgId: string;
  sessionId?: string;
  imageBase64: string;
  width: number;
  height: number;
  capturedBy: 'agent' | 'helper' | 'user';
  reason?: string;
  retentionHours?: number;
}

interface StoredScreenshot {
  id: string;
  storageKey: string;
  width: number;
  height: number;
  sizeBytes: number;
  expiresAt: Date;
}

/** Live (non-expired) screenshot count and total bytes currently stored for a device. */
async function getDeviceScreenshotUsage(deviceId: string): Promise<{ count: number; bytes: number }> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum(${aiScreenshots.sizeBytes}), 0)::bigint`,
    })
    .from(aiScreenshots)
    .where(and(eq(aiScreenshots.deviceId, deviceId), gt(aiScreenshots.expiresAt, new Date())))
    .limit(1);

  return { count: Number(row?.count ?? 0), bytes: Number(row?.bytes ?? 0) };
}

export async function storeScreenshot(params: StoreScreenshotParams): Promise<StoredScreenshot> {
  const {
    deviceId,
    orgId,
    sessionId,
    imageBase64,
    width,
    height,
    capturedBy,
    reason,
    retentionHours = DEFAULT_RETENTION_HOURS,
  } = params;

  const imageBuffer = Buffer.from(imageBase64, 'base64');
  const sizeBytes = imageBuffer.length;

  if (sizeBytes > MAX_SCREENSHOT_BYTES) {
    throw new ScreenshotTooLargeError(sizeBytes, MAX_SCREENSHOT_BYTES);
  }

  const usage = await getDeviceScreenshotUsage(deviceId);
  if (usage.count >= MAX_SCREENSHOTS_PER_DEVICE) {
    throw new ScreenshotQuotaExceededError(deviceId, 'count');
  }
  if (usage.bytes + sizeBytes > MAX_SCREENSHOT_BYTES_PER_DEVICE) {
    throw new ScreenshotQuotaExceededError(deviceId, 'bytes');
  }

  const uuid = randomUUID();
  const storageKey = `screenshots/${orgId}/${deviceId}/${uuid}.jpg`;

  const fullPath = join(SCREENSHOT_DIR, orgId, deviceId);
  const filePath = join(fullPath, `${uuid}.jpg`);
  await mkdir(fullPath, { recursive: true });
  await writeFile(filePath, imageBuffer);

  const expiresAt = new Date(Date.now() + retentionHours * 60 * 60 * 1000);

  // The file is written first so a row never points at missing bytes. If the
  // row cannot be recorded, remove the file again: nothing else references
  // it, so the retention sweep (which walks rows) would never reclaim it.
  let record: typeof aiScreenshots.$inferSelect | undefined;
  try {
    [record] = await db.insert(aiScreenshots).values({
      deviceId,
      orgId,
      sessionId,
      storageKey,
      width,
      height,
      sizeBytes,
      capturedBy,
      reason,
      expiresAt,
    }).returning();
    if (!record) throw new Error('Failed to store screenshot record in database');
  } catch (err) {
    await unlink(filePath).catch((cleanupErr: unknown) => {
      console.error(`[ScreenshotStorage] Failed to remove screenshot file ${filePath} after insert failure:`, cleanupErr);
    });
    throw err;
  }

  return {
    id: record.id,
    storageKey,
    width,
    height,
    sizeBytes,
    expiresAt,
  };
}

export async function getScreenshot(id: string, orgId: string): Promise<{ data: Buffer; record: typeof aiScreenshots.$inferSelect } | null> {
  const [record] = await db.select().from(aiScreenshots)
    .where(and(eq(aiScreenshots.id, id), eq(aiScreenshots.orgId, orgId)))
    .limit(1);

  if (!record) return null;

  const parts = record.storageKey.split('/');
  const filename = parts[parts.length - 1];
  const fullPath = join(SCREENSHOT_DIR, record.orgId, record.deviceId, filename!);

  try {
    const data = await readFile(fullPath);
    return { data, record };
  } catch (err: unknown) {
    const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code !== 'ENOENT') {
      console.error(`[ScreenshotStorage] Failed to read screenshot file at ${fullPath}:`, err);
    }
    return null;
  }
}

export async function deleteExpiredScreenshots(): Promise<number> {
  const now = new Date();
  const expired = await db.select().from(aiScreenshots)
    .where(lte(aiScreenshots.expiresAt, now));

  let deleted = 0;
  for (const record of expired) {
    const parts = record.storageKey.split('/');
    const filename = parts[parts.length - 1];
    const fullPath = join(SCREENSHOT_DIR, record.orgId, record.deviceId, filename!);

    try {
      await unlink(fullPath);
    } catch (err: unknown) {
      const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
      if (code !== 'ENOENT') {
        // Keep the row: it is the only pointer to these bytes, and the next
        // retention run retries the delete.
        console.error(`[ScreenshotStorage] Failed to delete expired screenshot file ${fullPath}; keeping row for retry:`, err);
        continue;
      }
    }

    await db.delete(aiScreenshots).where(eq(aiScreenshots.id, record.id));
    deleted++;
  }

  return deleted;
}
