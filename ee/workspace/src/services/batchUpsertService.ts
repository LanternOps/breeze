import type { WorkspaceDatabase } from '../hostTypes';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { workspaceFileIndex } from '../schema/workspace';
import { deviceIdFromKey } from './runScope';

export const MAX_BATCH_ENTRIES = 2000;
const UPSERT_CHUNK_SIZE = 500;

// Wire shape for one file-index entry (spec §2.4; the Go agent serializes
// these). Timestamps are validated as ISO-8601 here so a garbage mtime is a
// 400 at the boundary instead of an Invalid Date exploding mid-chunk after
// earlier chunks already committed.
export const batchEntrySchema = z.object({
  relPath: z.string().max(4096),
  parentPath: z.string().max(4096),
  name: z.string().max(512),
  isDir: z.boolean(),
  size: z.number().int().nonnegative(),
  mtime: z.iso.datetime({ offset: true }),
  ctime: z.iso.datetime({ offset: true }).nullable().optional(),
  ext: z.string().max(64).nullable().optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
}).strict();

export type BatchEntry = z.infer<typeof batchEntrySchema>;

export function createBatchUpsertService(d: WorkspaceDatabase) {
  return {
    /**
     * Chunks intentionally run without one encompassing transaction. Upserts are
     * idempotent, so callers recover by retrying; sweep execution remains gated on
     * an explicit complete finish.
     *
     * Entries are deduplicated by relPath before writing, last entry wins —
     * required because ON CONFLICT DO UPDATE cannot touch the same row twice in
     * one statement ("cannot affect row a second time"). The returned `inserted`
     * counts rows written post-dedup (inserts and updates alike) while `expected`
     * echoes the raw entry count, so inserted < expected simply means the batch
     * carried duplicate relPaths — it is NOT a partial-failure signal. Both
     * fields go over the wire to the Go agent verbatim.
     */
    async upsertBatch(
      orgId: string,
      sourceId: string,
      deviceKey: string,
      entries: BatchEntry[],
    ): Promise<{ inserted: number; expected: number }> {
      const deduplicatedEntries = [...new Map(
        entries.map((entry) => [entry.relPath, entry]),
      ).values()];
      let inserted = 0;
      for (let offset = 0; offset < deduplicatedEntries.length; offset += UPSERT_CHUNK_SIZE) {
        const chunk = deduplicatedEntries.slice(offset, offset + UPSERT_CHUNK_SIZE);
        const rows = chunk.map((entry) => ({
          orgId,
          sourceId,
          deviceId: deviceIdFromKey(deviceKey),
          deviceKey,
          relPath: entry.relPath,
          parentPath: entry.parentPath,
          name: entry.name,
          isDir: entry.isDir,
          size: entry.size,
          mtime: new Date(entry.mtime),
          ctime: entry.ctime ? new Date(entry.ctime) : null,
          ext: entry.ext ?? null,
          attrs: entry.attrs ?? {},
          lastSeenAt: sql`now()`,
          deletedAt: null,
          updatedAt: sql`now()`,
        }));

        const written = await d.insert(workspaceFileIndex).values(rows)
          .onConflictDoUpdate({
            target: [
              workspaceFileIndex.orgId,
              workspaceFileIndex.sourceId,
              workspaceFileIndex.deviceKey,
              workspaceFileIndex.relPath,
            ],
            set: {
              name: sql`excluded.name`,
              parentPath: sql`excluded.parent_path`,
              isDir: sql`excluded.is_dir`,
              size: sql`excluded.size`,
              mtime: sql`excluded.mtime`,
              ctime: sql`excluded.ctime`,
              ext: sql`excluded.ext`,
              attrs: sql`excluded.attrs`,
              lastSeenAt: sql`now()`,
              deletedAt: null,
              updatedAt: sql`now()`,
            },
          })
          .returning({ id: workspaceFileIndex.id });
        inserted += written.length;
      }
      return { inserted, expected: entries.length };
    },

    async tombstonePaths(
      orgId: string,
      sourceId: string,
      deviceKey: string,
      relPaths: string[],
    ): Promise<number> {
      if (relPaths.length === 0) return 0;
      const rows = await d.update(workspaceFileIndex)
        .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(
          eq(workspaceFileIndex.orgId, orgId),
          eq(workspaceFileIndex.sourceId, sourceId),
          eq(workspaceFileIndex.deviceKey, deviceKey),
          inArray(workspaceFileIndex.relPath, relPaths),
          isNull(workspaceFileIndex.deletedAt),
        ))
        .returning({ id: workspaceFileIndex.id });
      return rows.length;
    },
  };
}
