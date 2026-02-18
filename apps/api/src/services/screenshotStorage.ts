/**
 * Screenshot Storage Service
 *
 * Handles temporary storage of screenshots for AI vision analysis.
 * Uses local filesystem. Screenshots auto-expire based on retention policy.
 */

import { db } from '../db';
import { aiScreenshots } from '../db/schema/ai';
import { eq, and, lte } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { writeFile, mkdir, unlink, readFile } from 'fs/promises';
import { join } from 'path';

const SCREENSHOT_DIR = process.env.SCREENSHOT_STORAGE_DIR || '/tmp/breeze-screenshots';
const DEFAULT_RETENTION_HOURS = 24;

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
  const uuid = randomUUID();
  const storageKey = `screenshots/${orgId}/${deviceId}/${uuid}.jpg`;

  const fullPath = join(SCREENSHOT_DIR, orgId, deviceId);
  await mkdir(fullPath, { recursive: true });
  await writeFile(join(fullPath, `${uuid}.jpg`), imageBuffer);

  const expiresAt = new Date(Date.now() + retentionHours * 60 * 60 * 1000);

  const [record] = await db.insert(aiScreenshots).values({
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
        console.error(`[ScreenshotStorage] Failed to delete expired screenshot file ${fullPath}:`, err);
        continue; // Skip DB record deletion to avoid orphaning
      }
    }

    await db.delete(aiScreenshots).where(eq(aiScreenshots.id, record.id));
    deleted++;
  }

  return deleted;
}
