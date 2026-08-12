// dashboardService — unit tests for the admin dashboard read model. All
// queries are mocked (dispatched by a distinctive SQL fragment per card, the
// same idiom as contentIngestService.test.ts's `classify` helper) so these
// tests pin the summary ASSEMBLY (mapping, JS-side unfiled-pool partition,
// queue cap, empty-org zeros) without a real DB. The real SQL is pinned by
// dashboard.integration.test.ts.
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceDatabase } from '../hostTypes';
import { createDashboardService } from './dashboardService';
import type { IngestStatus } from './contentIngestService';

const ORG = '11111111-1111-1111-1111-111111111111';

// Render the static SQL text of a drizzle `sql` template (params drop out) —
// mirrors the sqlText walk in ingestJobsService.test.ts / contentIngestService.test.ts.
function sqlText(value: unknown): string {
  if (Array.isArray(value)) return value.map(sqlText).join('');
  if (!value || typeof value !== 'object') return '';
  const c = value as { value?: unknown; queryChunks?: unknown[] };
  const own = Array.isArray(c.value) && c.value.every((p) => typeof p === 'string')
    ? c.value.join('')
    : '';
  return own + (c.queryChunks ?? []).map(sqlText).join('');
}

function classify(text: string): string {
  if (text.includes('FROM workspace_sources s')) return 'sources';
  if (text.includes('FROM workspace_content_chunks')) return 'chunks';
  if (text.includes('en.model IS NULL')) return 'enrichPending';
  if (text.includes("fi.ext = 'eml'")) return 'filing';
  if (text.includes('FROM workspace_file_activity a')) return 'activity';
  if (text.includes('FROM workspace_projects p')) return 'projects';
  if (text.includes('SELECT now()')) return 'now';
  throw new Error(`dashboardService test: unclassified query: ${text.slice(0, 200)}`);
}

function makeDb(rows: Partial<Record<string, unknown[]>> = {}) {
  const calls: Array<{ kind: string; text: string }> = [];
  const execute = vi.fn(async (q: unknown) => {
    const text = sqlText(q);
    const kind = classify(text);
    calls.push({ kind, text });
    return rows[kind] ?? [];
  });
  return { db: { execute } as unknown as WorkspaceDatabase, calls, execute };
}

const emptyStatus: IngestStatus = {
  eligible: 0, extracted: 0, failed: 0, skippedTooLarge: 0, skippedBinary: 0, blockedDlp: 0, pending: 0,
};

describe('dashboardService.summary — shape assembly (mocked queries)', () => {
  it('empty org: no rows anywhere → an all-zero summary, never throws', async () => {
    const { db } = makeDb({ now: [{ ts: '2026-07-19T00:00:00Z' }] });
    const contentIngestStatus = vi.fn(async () => emptyStatus);
    const svc = createDashboardService(db, { contentIngestStatus });

    const summary = await svc.summary(ORG);

    expect(summary.sources).toEqual([]);
    expect(summary.ingest).toEqual({
      eligible: 0, extracted: 0, failed: 0, skippedTooLarge: 0, skippedBinary: 0,
      blockedDlp: 0, pending: 0, enrichPending: 0, chunks: 0,
    });
    expect(summary.filing).toEqual({
      unfiled: 0, suggested: 0, confirmed: 0, reassigned: 0, highConfidence: 0, queue: [],
    });
    expect(summary.activity).toEqual([]);
    expect(summary.projects).toEqual([]);
    expect(summary.generatedAt).toBe('2026-07-19T00:00:00.000Z');
    expect(contentIngestStatus).toHaveBeenCalledWith(ORG);
  });

  it('sources: maps counts, active run, and null timestamps correctly', async () => {
    const { db } = makeDb({
      sources: [
        {
          id: 'src-1', display_name: 'Fileserver', kind: 'smb_share', status: 'active',
          last_complete_run_at: '2026-07-18T10:00:00Z',
          live_files: 5, live_dirs: 2, tombstoned: 1,
          newest_seen_at: '2026-07-19T09:00:00Z',
          active_run_id: 'run-1', active_run_status: 'running',
          active_run_started_at: '2026-07-19T08:00:00Z', active_run_stats: { seen: 3 },
        },
        {
          id: 'src-2', display_name: 'Archive', kind: 'local_profile', status: 'paused',
          last_complete_run_at: null,
          live_files: 0, live_dirs: 0, tombstoned: 0, newest_seen_at: null,
          active_run_id: null, active_run_status: null, active_run_started_at: null, active_run_stats: null,
        },
      ],
    });
    const svc = createDashboardService(db, { contentIngestStatus: vi.fn(async () => emptyStatus) });

    const { sources } = await svc.summary(ORG);

    expect(sources).toEqual([
      {
        id: 'src-1', name: 'Fileserver', kind: 'smb_share', status: 'active',
        lastCompleteRunAt: '2026-07-18T10:00:00.000Z',
        liveFiles: 5, liveDirs: 2, tombstoned: 1, newestSeenAt: '2026-07-19T09:00:00.000Z',
        activeRun: { id: 'run-1', status: 'running', startedAt: '2026-07-19T08:00:00.000Z', stats: { seen: 3 } },
      },
      {
        id: 'src-2', name: 'Archive', kind: 'local_profile', status: 'paused',
        lastCompleteRunAt: null,
        liveFiles: 0, liveDirs: 0, tombstoned: 0, newestSeenAt: null,
        activeRun: null,
      },
    ]);
  });

  it('ingest: forwards contentIngestStatus fields (incl. blockedDlp) and adds enrichPending/chunks', async () => {
    const { db } = makeDb({
      enrichPending: [{ n: 4 }],
      chunks: [{ n: 42 }],
    });
    const status: IngestStatus = {
      eligible: 20, extracted: 12, failed: 1, skippedTooLarge: 2, skippedBinary: 1, blockedDlp: 3, pending: 5,
    };
    const svc = createDashboardService(db, { contentIngestStatus: vi.fn(async () => status) });

    const { ingest } = await svc.summary(ORG);

    expect(ingest).toEqual({
      eligible: 20, extracted: 12, failed: 1, skippedTooLarge: 2, skippedBinary: 1,
      blockedDlp: 3, pending: 5, enrichPending: 4, chunks: 42,
    });
  });

  it('filing: partitions the unfiled-email pool by status and caps the queue at 10', async () => {
    // 12 candidate .eml rows under an undeclared folder (2 segments →
    // deriveDeclaredProject returns null) plus one already-declared control
    // that must be excluded from every count.
    const undeclared = Array.from({ length: 12 }, (_, i) => ({
      id: `f-${i}`, rel_path: `Unfiled/mail-${i}.eml`, name: `mail-${i}.eml`,
      status: i < 8 ? null : (i < 10 ? 'suggested' : (i === 10 ? 'confirmed' : 'reassigned')),
      suggested_project_label: i >= 8 ? 'Henderson' : null,
      confidence: i === 9 ? 'high' : null,
    }));
    const declaredControl = {
      id: 'f-declared', rel_path: 'Projects/2023-041 Henderson/note.eml', name: 'note.eml',
      status: null, suggested_project_label: null, confidence: null,
    };
    const { db } = makeDb({ filing: [...undeclared, declaredControl] });
    const svc = createDashboardService(db, { contentIngestStatus: vi.fn(async () => emptyStatus) });

    const { filing } = await svc.summary(ORG);

    // 8 untouched + 2 suggested = 10 still-undecided ("unfiled"); 1 confirmed; 1 reassigned.
    expect(filing.unfiled).toBe(10);
    expect(filing.suggested).toBe(2);
    expect(filing.confirmed).toBe(1);
    expect(filing.reassigned).toBe(1);
    expect(filing.highConfidence).toBe(1); // the single suggested+high row (i === 9)
    expect(filing.queue).toHaveLength(10); // capped, even though the undecided pool is exactly 10
    expect(filing.queue.every((q) => q.relPath.startsWith('Unfiled/'))).toBe(true);
    expect(filing.queue.map((q) => q.id)).not.toContain('f-declared');
    // A suggested row in the queue carries its suggestion; an untouched one does not.
    expect(filing.queue[8]).toMatchObject({ id: 'f-8', suggestedProjectLabel: 'Henderson', confidence: null });
    expect(filing.queue[0]).toMatchObject({ id: 'f-0', suggestedProjectLabel: null, confidence: null });
  });

  it('filing: queue caps at 10 even when the undecided pool exceeds it', async () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      id: `f-${i}`, rel_path: `Unfiled/mail-${i}.eml`, name: `mail-${i}.eml`,
      status: null, suggested_project_label: null, confidence: null,
    }));
    const { db } = makeDb({ filing: rows });
    const svc = createDashboardService(db, { contentIngestStatus: vi.fn(async () => emptyStatus) });

    const { filing } = await svc.summary(ORG);

    expect(filing.unfiled).toBe(15);
    expect(filing.queue).toHaveLength(10);
  });

  it('activity: maps recency-ordered rows with 7-day event counts', async () => {
    const { db } = makeDb({
      activity: [
        { file_index_id: 'f-1', name: 'a.md', rel_path: 'Projects/x/a.md', last_activity_at: '2026-07-19T12:00:00Z', events_7d: 3 },
      ],
    });
    const svc = createDashboardService(db, { contentIngestStatus: vi.fn(async () => emptyStatus) });

    const { activity } = await svc.summary(ORG);

    expect(activity).toEqual([{
      fileIndexId: 'f-1', name: 'a.md', relPath: 'Projects/x/a.md',
      lastActivityAt: '2026-07-19T12:00:00.000Z', events7d: 3,
    }]);
  });

  it('projects: maps per-project filed/crosswalk/evidence counts', async () => {
    const { db } = makeDb({
      projects: [
        { project_key: '2023-041', label: 'Henderson', filed_emails: 4, crosswalk_entities: 6, evidence_files: 9 },
      ],
    });
    const svc = createDashboardService(db, { contentIngestStatus: vi.fn(async () => emptyStatus) });

    const { projects } = await svc.summary(ORG);

    expect(projects).toEqual([
      { projectKey: '2023-041', label: 'Henderson', filedEmails: 4, crosswalkEntities: 6, evidenceFiles: 9 },
    ]);
  });

  it('passes orgId through to every query and to contentIngestStatus', async () => {
    const { db, calls } = makeDb();
    const contentIngestStatus = vi.fn(async () => emptyStatus);
    const svc = createDashboardService(db, { contentIngestStatus });

    await svc.summary(ORG);

    expect(contentIngestStatus).toHaveBeenCalledWith(ORG);
    for (const call of calls) {
      if (call.kind === 'now') continue; // SELECT now() carries no org_id
      expect(call.text).toContain('org_id');
    }
  });
});
