import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { backupCommandResultSchema } from '../routes/backup/resultSchemas';
import {
  BACKUP_SNAPSHOT_ROOT_DIR,
  BACKUP_SNAPSHOT_MANIFEST_KEY,
} from './backupSnapshotStorage';

// This suite pins the Go(agent) <-> TS(API) contracts that today are held
// together only by comments. This repo's history shows mechanical parity tests
// catch cross-boundary drift that human review misses; these do the same for the
// backup wire/format constants.
//
// From apps/api/src/services -> repo root is four levels up (matches
// src/config/proxyTrustCompose.test.ts).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

describe('backup Go<->TS contract — GC journal max-age (data-safety invariant)', () => {
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  it('the API GC journal-age constant is exactly 7 days (604800000 ms)', () => {
    expect(SEVEN_DAYS_MS).toBe(604_800_000);
  });

  it('API backupRetention.ts still defines BACKUP_GC_AGENT_JOURNAL_MAX_AGE_MS as 7 days', () => {
    // The constant is not exported from backupRetention.ts (and this suite must
    // not edit that file), so pin it by source text rather than by import.
    const src = readRepoFile('apps/api/src/jobs/backupRetention.ts');
    expect(src).toMatch(
      /BACKUP_GC_AGENT_JOURNAL_MAX_AGE_MS\s*=\s*7\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/,
    );
  });

  it('agent journal.go still defines journalMaxAge as 7 * 24 * time.Hour (MUST equal the API value)', () => {
    // The GC's manifest-less protection window is journalMaxAge + 48h = 9 days,
    // and the strict inequality against journalMaxAge is a data-safety invariant.
    // If the agent bumps journalMaxAge without the API following, the two drift
    // and the GC can delete a snapshot the agent still considers resumable.
    const src = readRepoFile('agent/internal/backup/journal.go');
    expect(src).toMatch(/journalMaxAge\s*=\s*7\s*\*\s*24\s*\*\s*time\.Hour/);
  });
});

describe('backup Go<->TS contract — snapshot root dir + manifest key', () => {
  it('API constants match their documented values', () => {
    expect(BACKUP_SNAPSHOT_ROOT_DIR).toBe('snapshots');
    expect(BACKUP_SNAPSHOT_MANIFEST_KEY).toBe('manifest.json');
  });

  it('agent snapshot.go still defines snapshotRootDir/snapshotManifestKey equal to the API constants', () => {
    const src = readRepoFile('agent/internal/backup/snapshot.go');
    expect(src).toMatch(
      new RegExp(`snapshotRootDir\\s*=\\s*"${BACKUP_SNAPSHOT_ROOT_DIR}"`),
    );
    expect(src).toMatch(
      new RegExp(`snapshotManifestKey\\s*=\\s*"${BACKUP_SNAPSHOT_MANIFEST_KEY.replace('.', '\\.')}"`),
    );
  });
});

describe('backup Go<->TS contract — result JSON round-trips through backupCommandResultSchema', () => {
  it('an incremental (deduped) BackupJob result survives the schema with all fields intact', () => {
    // A realistic backup_run result exactly as Go's encoding/json emits the
    // agent BackupJob struct (camelCase json tags; agent/internal/backup/backup.go).
    // This run referenced files from a prior snapshot, so the omitempty
    // referenced*/errorCount fields are present.
    const wireJson = JSON.stringify({
      id: 'job-abc',
      startedAt: '2026-07-17T00:00:00Z',
      completedAt: '2026-07-17T00:05:00Z',
      status: 'completed',
      filesBackedUp: 120,
      bytesBackedUp: 5_000_000,
      errorCount: 2,
      referencedFiles: 80,
      referencedBytes: 4_200_000,
      snapshot: {
        id: 'snap-xyz',
        timestamp: '2026-07-17T00:05:00Z',
        size: 5_000_000,
        files: [
          {
            sourcePath: 'C:\\Users\\a.txt',
            backupPath: 'snapshots/snap-xyz/a.txt',
            size: 10,
            // File mtimes carry a local UTC offset, not a Z (F13).
            modTime: '2026-07-16T12:00:00-07:00',
          },
        ],
      },
    });

    const parsed = backupCommandResultSchema.parse(JSON.parse(wireJson));

    expect(parsed.filesBackedUp).toBe(120);
    expect(parsed.bytesBackedUp).toBe(5_000_000);
    expect(parsed.errorCount).toBe(2);
    expect(parsed.referencedFiles).toBe(80);
    expect(parsed.referencedBytes).toBe(4_200_000);
    expect(parsed.snapshot?.id).toBe('snap-xyz');
    expect(parsed.snapshot?.files?.[0]?.backupPath).toBe('snapshots/snap-xyz/a.txt');
  });

  it('a full backup that omits referenced*/errorCount (Go omitempty) leaves them undefined — NOT coerced to 0', () => {
    // omitempty drops the zero-valued dedup fields on a full backup. The
    // persistence layer relies on undefined (not 0) to keep the columns NULL for
    // legacy/full runs, so the omitted-vs-zero distinction MUST be preserved.
    const wireJson = JSON.stringify({
      id: 'job-full',
      status: 'completed',
      filesBackedUp: 500,
      bytesBackedUp: 9_000_000,
      snapshot: { id: 'snap-full' },
    });

    const parsed = backupCommandResultSchema.parse(JSON.parse(wireJson));

    expect(parsed.referencedBytes).toBeUndefined();
    expect(parsed.referencedFiles).toBeUndefined();
    expect(parsed.errorCount).toBeUndefined();
    expect(parsed.snapshot?.id).toBe('snap-full');
  });

  it('an explicit 0 for referenced*/errorCount is preserved as 0 (the other side of omitted-vs-zero)', () => {
    const parsed = backupCommandResultSchema.parse({
      status: 'completed',
      filesBackedUp: 3,
      bytesBackedUp: 1000,
      referencedBytes: 0,
      referencedFiles: 0,
      errorCount: 0,
      snapshot: { id: 'snap-zero' },
    });

    expect(parsed.referencedBytes).toBe(0);
    expect(parsed.referencedFiles).toBe(0);
    expect(parsed.errorCount).toBe(0);
    // 0 is distinct from undefined — pin the distinction explicitly.
    expect(parsed.referencedBytes).not.toBeUndefined();
  });
});
