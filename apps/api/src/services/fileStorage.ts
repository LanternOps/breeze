import { mkdirSync, existsSync, createReadStream, createWriteStream, readdirSync, unlinkSync, rmdirSync, statSync } from 'fs';
import { join } from 'path';
import type { Readable } from 'stream';

const STORAGE_PATH = process.env.TRANSFER_STORAGE_PATH || './data/transfers';
const MAX_TRANSFER_SIZE_MB = parseInt(process.env.MAX_TRANSFER_SIZE_MB || '500', 10);

export const MAX_TRANSFER_SIZE_BYTES = MAX_TRANSFER_SIZE_MB * 1024 * 1024;
export const CHUNK_SIZE = 1024 * 1024; // 1MB per chunk

function transferDir(transferId: string): string {
  return join(STORAGE_PATH, transferId);
}

function chunkPath(transferId: string, chunkIndex: number): string {
  return join(transferDir(transferId), `chunk_${String(chunkIndex).padStart(6, '0')}`);
}

function assembledPath(transferId: string): string {
  return join(transferDir(transferId), 'assembled');
}

/**
 * Ensure the storage directory exists for a transfer.
 */
export function ensureTransferDir(transferId: string): void {
  const dir = transferDir(transferId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Save a chunk of data for a transfer.
 */
export async function saveChunk(transferId: string, chunkIndex: number, data: Buffer): Promise<void> {
  ensureTransferDir(transferId);
  const path = chunkPath(transferId, chunkIndex);

  return new Promise((resolve, reject) => {
    const ws = createWriteStream(path);
    ws.on('finish', resolve);
    ws.on('error', reject);
    ws.end(data);
  });
}

/**
 * Get the number of chunks saved for a transfer.
 */
export function getChunkCount(transferId: string): number {
  const dir = transferDir(transferId);
  if (!existsSync(dir)) return 0;

  return readdirSync(dir).filter(f => f.startsWith('chunk_')).length;
}

/**
 * Get total bytes received across all chunks for a transfer.
 */
export function getTotalBytesReceived(transferId: string): number {
  const dir = transferDir(transferId);
  if (!existsSync(dir)) return 0;

  return readdirSync(dir)
    .filter(f => f.startsWith('chunk_'))
    .reduce((total, f) => {
      try {
        return total + statSync(join(dir, f)).size;
      } catch {
        return total;
      }
    }, 0);
}

/**
 * Assemble all chunks into a single file.
 * Chunks are concatenated in order (chunk_000000, chunk_000001, ...).
 */
export async function assembleChunks(transferId: string): Promise<void> {
  const dir = transferDir(transferId);
  const files = readdirSync(dir)
    .filter(f => f.startsWith('chunk_'))
    .sort();

  if (files.length === 0) {
    throw new Error('No chunks found to assemble');
  }

  const outPath = assembledPath(transferId);
  const out = createWriteStream(outPath);

  for (const file of files) {
    await new Promise<void>((resolve, reject) => {
      const input = createReadStream(join(dir, file));
      input.on('error', reject);
      input.on('end', resolve);
      input.pipe(out, { end: false });
    });
  }

  out.end();

  await new Promise<void>((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });

  // Clean up chunk files
  for (const file of files) {
    try {
      unlinkSync(join(dir, file));
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Get a readable stream for the assembled file.
 */
export function getFileStream(transferId: string): Readable | null {
  const path = assembledPath(transferId);
  if (!existsSync(path)) return null;
  return createReadStream(path);
}

/**
 * Get the size of the assembled file.
 */
export function getFileSize(transferId: string): number {
  const path = assembledPath(transferId);
  if (!existsSync(path)) return 0;
  return statSync(path).size;
}

/**
 * Delete all files for a transfer (chunks and assembled).
 */
export function deleteTransfer(transferId: string): void {
  const dir = transferDir(transferId);
  if (!existsSync(dir)) return;

  for (const file of readdirSync(dir)) {
    try {
      unlinkSync(join(dir, file));
    } catch {
      // Ignore
    }
  }

  try {
    rmdirSync(dir);
  } catch {
    // Ignore
  }
}

/**
 * Check if the assembled file exists for a transfer.
 */
export function hasAssembledFile(transferId: string): boolean {
  return existsSync(assembledPath(transferId));
}
