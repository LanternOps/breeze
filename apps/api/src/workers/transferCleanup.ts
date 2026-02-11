import { lt, or, eq, and } from 'drizzle-orm';
import { db } from '../db';
import { fileTransfers } from '../db/schema';
import { deleteTransfer } from '../services/fileStorage';

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

async function runCleanup() {
  try {
    const cutoff = new Date(Date.now() - MAX_AGE_MS);

    // Find old or failed transfers
    const staleTransfers = await db
      .select({ id: fileTransfers.id, status: fileTransfers.status })
      .from(fileTransfers)
      .where(
        or(
          and(
            lt(fileTransfers.createdAt, cutoff),
            or(
              eq(fileTransfers.status, 'completed'),
              eq(fileTransfers.status, 'failed'),
              eq(fileTransfers.status, 'pending')
            )
          ),
          eq(fileTransfers.status, 'failed')
        )
      )
      .limit(100);

    if (staleTransfers.length === 0) return;

    let cleaned = 0;
    for (const transfer of staleTransfers) {
      try {
        deleteTransfer(transfer.id);
        cleaned++;
      } catch (err) {
        console.error('[transfer-cleanup] Failed to delete transfer', transfer.id, err);
      }
    }

    if (cleaned > 0) {
      console.log(`[TransferCleanup] Cleaned up ${cleaned} transfer file(s)`);
    }
  } catch (err) {
    console.error('[TransferCleanup] Error during cleanup:', err);
  }
}

export function initializeTransferCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(runCleanup, CLEANUP_INTERVAL_MS);
  // Run once at startup after a short delay
  setTimeout(runCleanup, 10000);
  console.log('[TransferCleanup] Initialized (interval: 1h, max age: 24h)');
}

export function stopTransferCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
