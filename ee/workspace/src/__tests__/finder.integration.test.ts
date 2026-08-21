import { randomUUID } from 'node:crypto';
import type { WorkspaceDatabase } from '../hostTypes';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createActivityService } from '../services/activityService';
import { createFileQueryService } from '../services/fileQueryService';
import { createSourcesService } from '../services/sourcesService';

const ADMIN_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
const APP_URL = process.env.DATABASE_URL_APP
  ?? 'postgresql://breeze_app:breeze_test@localhost:5433/breeze_test';
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

if (new URL(ADMIN_URL).port === '5432' || new URL(APP_URL).port === '5432') {
  throw new Error('refusing to run against :5432 — use the test stack (:5433)');
}

let admin: postgres.Sql;
let app: postgres.Sql;
let appDb: ReturnType<typeof drizzle>;

// Org A (the org under test) and its estate.
let partnerA: string;
let orgA: string;
let siteA: string;
let device1: string;
let device2: string;
let smbVisibleId: string;
let smbHiddenId: string;
let localSourceId: string;

// Org B (RLS / cross-org foil), fully seeded by admin.
let partnerB: string;
let orgB: string;
let orgBSourceId: string;

// File-index fixture ids (org A unless suffixed B).
let dirDocsId: string;
let fileReportId: string; // docs/henderson-report.pdf (smb, name match)
let fileNotesId: string; // docs/meeting-notes.txt (smb)
let fileScanId: string; // archive/henderson/scan-0034.txt (smb, rel_path-only match)
let fileRootId: string; // readme.md (smb, root listing)
let fileTombstoneId: string; // docs/henderson-old.pdf (smb, deleted_at set)
let fileHiddenId: string; // docs/henderson-hidden.pdf (hidden source)
let fileDev1Id: string; // profile/henderson-dev1.txt (local, device 1)
let fileDev2Id: string; // profile/henderson-dev2.txt (local, device 2)
let fileOrgBId: string; // docs/henderson-b.pdf (org B)
// filed/ fixture for Finding 4a: subdirs must stay navigable under a Browse
// filter. Names avoid 'henderson' so the search tests above are unaffected.
let filedSubAId: string; // filed/sub-alpha (smb, dir)
let filedSubBId: string; // filed/sub-beta (smb, dir)
let filedMatchId: string; // filed/permit-app.pdf (smb, enriched: 'permit application')
let filedFoilId: string; // filed/foil-note.txt (smb, unenriched foil)

type AppContext = {
  tx: postgres.TransactionSql;
  sources: ReturnType<typeof createSourcesService>;
  files: ReturnType<typeof createFileQueryService>;
  activity: ReturnType<typeof createActivityService>;
};

/** Run fn as breeze_app inside org A's access context (mirrors withDbAccessContext set_configs). */
async function asOrgA<T>(fn: (context: AppContext) => Promise<T>): Promise<T> {
  return appDb.transaction(async (transaction) => {
    const tx = (transaction as unknown as { session: { client: postgres.TransactionSql } })
      .session.client;
    await tx`SELECT set_config('breeze.scope', 'organization', true),
                    set_config('breeze.org_id', ${orgA}, true),
                    set_config('breeze.accessible_org_ids', ${orgA}, true),
                    set_config('breeze.accessible_partner_ids', ${partnerA}, true),
                    set_config('breeze.user_id', '', true),
                    set_config('breeze.current_partner_id', '', true)`;
    const db = transaction as unknown as WorkspaceDatabase;
    return fn({
      tx,
      sources: createSourcesService(db),
      files: createFileQueryService(db),
      activity: createActivityService(db),
    });
  });
}

/** Admin-seeded file row; RLS-exempt writer so fixtures can span orgs/partitions. */
async function seedFile(input: {
  orgId: string;
  sourceId: string;
  deviceId?: string | null;
  deviceKey?: string;
  relPath: string;
  isDir?: boolean;
  ext?: string | null;
  mtimeDaysAgo?: number;
  deleted?: boolean;
}): Promise<string> {
  const id = randomUUID();
  const slash = input.relPath.lastIndexOf('/');
  const name = input.relPath.slice(slash + 1);
  const parentPath = slash < 0 ? '' : input.relPath.slice(0, slash);
  const days = input.mtimeDaysAgo ?? 1;
  await admin`INSERT INTO workspace_file_index
                (id, org_id, source_id, device_id, device_key, rel_path, parent_path, name,
                 is_dir, ext, size, mtime, last_seen_at, deleted_at)
              VALUES
                (${id}, ${input.orgId}, ${input.sourceId}, ${input.deviceId ?? null},
                 ${input.deviceKey ?? ZERO_UUID}, ${input.relPath}, ${parentPath}, ${name},
                 ${input.isDir ?? false}, ${input.ext ?? null}, ${input.isDir ? 0 : 100},
                 ${admin`now() - make_interval(days => ${days})`}, now(),
                 ${input.deleted ? admin`now()` : null})`;
  return id;
}

beforeAll(async () => {
  admin = postgres(ADMIN_URL, { max: 1 });
  app = postgres(APP_URL, { max: 1 });
  appDb = drizzle(app);
  partnerA = randomUUID();
  partnerB = randomUUID();
  orgA = randomUUID();
  orgB = randomUUID();
  siteA = randomUUID();
  device1 = randomUUID();
  device2 = randomUUID();
  orgBSourceId = randomUUID();
  const suffix = randomUUID();

  await admin`INSERT INTO partners (id, name, slug)
              VALUES (${partnerA}, 'wsp finder a', ${`wsp-finder-a-${suffix}`}),
                     (${partnerB}, 'wsp finder b', ${`wsp-finder-b-${suffix}`})`;
  await admin`INSERT INTO organizations (id, partner_id, name, slug, currency_code)
              VALUES (${orgA}, ${partnerA}, 'wsp finder org a', ${`wsp-finder-org-a-${suffix}`}, 'USD'),
                     (${orgB}, ${partnerB}, 'wsp finder org b', ${`wsp-finder-org-b-${suffix}`}, 'USD')`;
  await admin`INSERT INTO sites (id, org_id, name)
              VALUES (${siteA}, ${orgA}, 'wsp finder site')`;
  await admin`INSERT INTO devices
                (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
              VALUES
                (${device1}, ${orgA}, ${siteA}, ${`wsp-finder-1-${suffix}`}, 'finder-1', 'windows', '11', 'amd64', 'test'),
                (${device2}, ${orgA}, ${siteA}, ${`wsp-finder-2-${suffix}`}, 'finder-2', 'windows', '11', 'amd64', 'test')`;

  // Org A sources go through the real service under the org RLS context.
  await asOrgA(async ({ sources }) => {
    const visible = await sources.create(orgA, {
      kind: 'smb_share',
      displayName: 'Alder Creek',
      rootPath: '\\\\srv\\alder',
      crawlDeviceId: device1,
      visibilityGroupIds: [],
      crawlCadenceMinutes: 60,
      excludeGlobs: [],
      watch: false,
      status: 'active',
    });
    const hidden = await sources.create(orgA, {
      kind: 'smb_share',
      displayName: 'Hidden share',
      rootPath: '\\\\srv\\hidden',
      crawlDeviceId: device1,
      visibilityGroupIds: ['g1'], // non-empty group list must FAIL CLOSED
      crawlCadenceMinutes: 60,
      excludeGlobs: [],
      watch: false,
      status: 'active',
    });
    const local = await sources.create(orgA, {
      kind: 'local_profile',
      displayName: 'Local profiles',
      rootPath: '/Users',
      crawlDeviceId: null,
      visibilityGroupIds: [],
      crawlCadenceMinutes: 60,
      excludeGlobs: [],
      watch: false,
      status: 'active',
    });
    smbVisibleId = visible.id;
    smbHiddenId = hidden.id;
    localSourceId = local.id;
  });

  // Org B estate is a pure foil — admin-seeded, never touched through asOrgA.
  await admin`INSERT INTO workspace_sources (id, org_id, kind, display_name, root_path)
              VALUES (${orgBSourceId}, ${orgB}, 'smb_share', 'b share', '\\\\srv\\bravo')`;

  dirDocsId = await seedFile({
    orgId: orgA, sourceId: smbVisibleId, relPath: 'docs', isDir: true,
  });
  fileReportId = await seedFile({
    orgId: orgA, sourceId: smbVisibleId, relPath: 'docs/henderson-report.pdf', ext: 'pdf', mtimeDaysAgo: 1,
  });
  fileNotesId = await seedFile({
    orgId: orgA, sourceId: smbVisibleId, relPath: 'docs/meeting-notes.txt', ext: 'txt', mtimeDaysAgo: 2,
  });
  fileScanId = await seedFile({
    orgId: orgA, sourceId: smbVisibleId, relPath: 'archive/henderson/scan-0034.txt', ext: 'txt', mtimeDaysAgo: 3,
  });
  fileRootId = await seedFile({
    orgId: orgA, sourceId: smbVisibleId, relPath: 'readme.md', ext: 'md', mtimeDaysAgo: 4,
  });
  fileTombstoneId = await seedFile({
    orgId: orgA, sourceId: smbVisibleId, relPath: 'docs/henderson-old.pdf', ext: 'pdf', deleted: true,
  });
  fileHiddenId = await seedFile({
    orgId: orgA, sourceId: smbHiddenId, relPath: 'docs/henderson-hidden.pdf', ext: 'pdf',
  });
  fileDev1Id = await seedFile({
    orgId: orgA, sourceId: localSourceId, deviceId: device1, deviceKey: device1,
    relPath: 'profile/henderson-dev1.txt', ext: 'txt',
  });
  fileDev2Id = await seedFile({
    orgId: orgA, sourceId: localSourceId, deviceId: device2, deviceKey: device2,
    relPath: 'profile/henderson-dev2.txt', ext: 'txt',
  });
  fileOrgBId = await seedFile({
    orgId: orgB, sourceId: orgBSourceId, relPath: 'docs/henderson-b.pdf', ext: 'pdf',
  });

  // filed/ holds two subdirs, one enriched file, and one unenriched foil — all
  // under parent_path 'filed' so they never surface in the root or docs/ browse
  // assertions above. Finding 4a: a filtered Browse must keep the subdirs.
  filedSubAId = await seedFile({
    orgId: orgA, sourceId: smbVisibleId, relPath: 'filed/sub-alpha', isDir: true,
  });
  filedSubBId = await seedFile({
    orgId: orgA, sourceId: smbVisibleId, relPath: 'filed/sub-beta', isDir: true,
  });
  filedMatchId = await seedFile({
    orgId: orgA, sourceId: smbVisibleId, relPath: 'filed/permit-app.pdf', ext: 'pdf', mtimeDaysAgo: 1,
  });
  filedFoilId = await seedFile({
    orgId: orgA, sourceId: smbVisibleId, relPath: 'filed/foil-note.txt', ext: 'txt', mtimeDaysAgo: 2,
  });

  // Enrichment for the docs/ report and the filed/ match only — meeting-notes
  // and foil-note stay unenriched so a browse narrowed by project or docType
  // must drop them. Proves the EXISTS predicates narrow real rows, not just
  // render in the SQL text.
  await admin`INSERT INTO workspace_file_enrichment
                (org_id, file_index_id, inferred_project_label, inferred_doc_type)
              VALUES
                (${orgA}, ${fileReportId}, 'Henderson Water Main Replacement', 'easement deed'),
                (${orgA}, ${filedMatchId}, 'Filed Project X', 'permit application')`;
});

afterAll(async () => {
  if (!admin) return;
  try {
    await admin`DELETE FROM workspace_file_activity WHERE org_id IN (${orgA}, ${orgB})`;
    await admin`DELETE FROM workspace_file_index WHERE org_id IN (${orgA}, ${orgB})`;
    await admin`DELETE FROM workspace_sources WHERE org_id IN (${orgA}, ${orgB})`;
    await admin`DELETE FROM devices WHERE id IN (${device1}, ${device2})`;
    await admin`DELETE FROM sites WHERE id = ${siteA}`;
    await admin`DELETE FROM organizations WHERE id IN (${orgA}, ${orgB})`;
    await admin`DELETE FROM partners WHERE id IN (${partnerA}, ${partnerB})`;
  } finally {
    await admin.end();
    await app?.end();
  }
});

describe.sequential('workspace finder end-to-end integration', () => {
  it('lists only active empty-visibility sources (fail closed on group lists)', async () => {
    const sources = await asOrgA(({ files }) => files.visibleSources(orgA));
    expect(sources.map((s) => s.id).sort()).toEqual([smbVisibleId, localSourceId].sort());
    expect(sources.find((s) => s.id === smbHiddenId)).toBeUndefined();
  });

  it('searches by name and rel_path, ranks name matches first, and leaks nothing', async () => {
    const results = await asOrgA(({ files }) => files.search(orgA, device1, { q: 'henderson' }));
    const ids = results.map((r) => r.id);

    // Name match, rel_path-only match, and device 1's own local row all hit.
    expect(ids).toContain(fileReportId);
    expect(ids).toContain(fileScanId);
    expect(ids).toContain(fileDev1Id);

    // Tombstoned, hidden-source, cross-org, and other-device rows never appear.
    expect(ids).not.toContain(fileTombstoneId);
    expect(ids).not.toContain(fileHiddenId);
    expect(ids).not.toContain(fileOrgBId);
    expect(ids).not.toContain(fileDev2Id);

    // Plausible-first: the strong name match outranks the rel_path-only match.
    expect(ids.indexOf(fileReportId)).toBeLessThan(ids.indexOf(fileScanId));

    // openPath is the UNC join for smb files, null for local-profile rows.
    expect(results.find((r) => r.id === fileReportId)?.openPath)
      .toBe('\\\\srv\\alder\\docs\\henderson-report.pdf');
    expect(results.find((r) => r.id === fileDev1Id)?.openPath).toBeNull();
  });

  it('scopes local-profile search rows to the calling device', async () => {
    const asDevice2 = await asOrgA(({ files }) => files.search(orgA, device2, { q: 'henderson' }));
    const ids = asDevice2.map((r) => r.id);
    expect(ids).toContain(fileDev2Id);
    expect(ids).not.toContain(fileDev1Id);
  });

  it('honors search filters: sourceId, ext, and limit', async () => {
    const smbOnly = await asOrgA(({ files }) => files.search(orgA, device1, {
      q: 'henderson', sourceId: smbVisibleId,
    }));
    expect(smbOnly.map((r) => r.id).sort()).toEqual([fileReportId, fileScanId].sort());

    const pdfOnly = await asOrgA(({ files }) => files.search(orgA, device1, {
      q: 'henderson', ext: 'pdf',
    }));
    expect(pdfOnly.map((r) => r.id)).toEqual([fileReportId]);

    const limited = await asOrgA(({ files }) => files.search(orgA, device1, {
      q: 'henderson', limit: 1,
    }));
    expect(limited).toHaveLength(1);
  });

  it('browses an exact parent_path, dirs first, tombstones excluded', async () => {
    const root = await asOrgA(({ files }) => files.browse(orgA, device1, smbVisibleId, ''));
    expect(root.map((r) => [r.id, r.isDir])).toEqual([
      [dirDocsId, true],
      [fileRootId, false],
    ]);
    // Directories never carry an openPath.
    expect(root.find((r) => r.id === dirDocsId)?.openPath).toBeNull();

    const docs = await asOrgA(({ files }) => files.browse(orgA, device1, smbVisibleId, 'docs'));
    expect(docs.map((r) => r.id)).toEqual([fileReportId, fileNotesId]);
    expect(docs.map((r) => r.id)).not.toContain(fileTombstoneId);
  });

  it('narrows a browsed directory by project and by docType against real enrichment rows', async () => {
    // docs/ holds the enriched report plus the unenriched meeting-notes foil.
    const unfiltered = await asOrgA(({ files }) => files.browse(orgA, device1, smbVisibleId, 'docs'));
    expect(unfiltered.map((r) => r.id)).toEqual([fileReportId, fileNotesId]);

    // docType narrows to the sole enriched row — the foil is dropped.
    const byDocType = await asOrgA(({ files }) =>
      files.browse(orgA, device1, smbVisibleId, 'docs', { docType: 'easement deed' }));
    expect(byDocType.map((r) => r.id)).toEqual([fileReportId]);
    expect(byDocType.length).toBeLessThan(unfiltered.length);

    // project narrows identically.
    const byProject = await asOrgA(({ files }) =>
      files.browse(orgA, device1, smbVisibleId, 'docs', {
        project: 'Henderson Water Main Replacement',
      }));
    expect(byProject.map((r) => r.id)).toEqual([fileReportId]);

    // Both predicates AND together on the same (enriched) row.
    const both = await asOrgA(({ files }) =>
      files.browse(orgA, device1, smbVisibleId, 'docs', {
        project: 'Henderson Water Main Replacement', docType: 'easement deed',
      }));
    expect(both.map((r) => r.id)).toEqual([fileReportId]);

    // A value no enrichment row carries narrows to empty.
    const noMatch = await asOrgA(({ files }) =>
      files.browse(orgA, device1, smbVisibleId, 'docs', { docType: 'no-such-doc-type' }));
    expect(noMatch).toEqual([]);
  });

  it('keeps subdirectories navigable when a Browse filter is active (Finding 4a)', async () => {
    // filed/ = two subdirs + one enriched file + one unenriched foil.
    const unfiltered = await asOrgA(({ files }) => files.browse(orgA, device1, smbVisibleId, 'filed'));
    expect(unfiltered.map((r) => r.id)).toEqual([
      filedSubAId, filedSubBId, filedFoilId, filedMatchId,
    ]);

    // With a docType filter active, the enrichment predicate must NOT hide the
    // subdirectories (they carry no enrichment row) — dirs-first, then the sole
    // enriched file. The unenriched foil is dropped.
    const filtered = await asOrgA(({ files }) =>
      files.browse(orgA, device1, smbVisibleId, 'filed', { docType: 'permit application' }));
    expect(filtered.map((r) => r.id)).toEqual([filedSubAId, filedSubBId, filedMatchId]);
    expect(filtered.map((r) => r.id)).not.toContain(filedFoilId);
    // Directories still carry no openPath even when they survive a filter.
    expect(filtered.find((r) => r.id === filedSubAId)?.openPath).toBeNull();
  });

  it('returns nothing when browsing a hidden or unknown source', async () => {
    const hidden = await asOrgA(({ files }) => files.browse(orgA, device1, smbHiddenId, 'docs'));
    expect(hidden).toEqual([]);
    const unknown = await asOrgA(({ files }) => files.browse(orgA, device1, randomUUID(), ''));
    expect(unknown).toEqual([]);
  });

  it('partitions local-profile browsing per device', async () => {
    const dev1 = await asOrgA(({ files }) => files.browse(orgA, device1, localSourceId, 'profile'));
    expect(dev1.map((r) => r.id)).toEqual([fileDev1Id]);
    const dev2 = await asOrgA(({ files }) => files.browse(orgA, device2, localSourceId, 'profile'));
    expect(dev2.map((r) => r.id)).toEqual([fileDev2Id]);
  });

  it('getFile enforces visibility and partition', async () => {
    const ok = await asOrgA(({ files }) => files.getFile(orgA, device1, fileReportId));
    expect(ok?.openPath).toBe('\\\\srv\\alder\\docs\\henderson-report.pdf');
    expect(await asOrgA(({ files }) => files.getFile(orgA, device1, fileHiddenId))).toBeNull();
    expect(await asOrgA(({ files }) => files.getFile(orgA, device1, fileDev2Id))).toBeNull();
    expect(await asOrgA(({ files }) => files.getFile(orgA, device1, fileOrgBId))).toBeNull();
  });

  it('refuses to record activity for tombstoned, hidden, cross-org, or unknown files', async () => {
    await asOrgA(async ({ activity }) => {
      for (const fileIndexId of [fileTombstoneId, fileHiddenId, fileOrgBId, randomUUID()]) {
        expect(await activity.record(orgA, {
          fileIndexId, deviceId: device1, helperUser: 'Front Desk', action: 'open',
        })).toEqual({ notFound: true });
      }
      // Another device's local-profile row is outside device 1's partition.
      expect(await activity.record(orgA, {
        fileIndexId: fileDev2Id, deviceId: device1, helperUser: 'Front Desk', action: 'open',
      })).toEqual({ notFound: true });
    });
    const rows = await admin`SELECT id FROM workspace_file_activity WHERE org_id = ${orgA}`;
    expect(rows).toHaveLength(0);
  });

  it('records helper activity with a NULL user_id (finder migration applied)', async () => {
    await asOrgA(async ({ activity }) => {
      expect(await activity.record(orgA, {
        fileIndexId: fileReportId, deviceId: device1, helperUser: 'Front Desk', action: 'open',
      })).toEqual({ recorded: true });
    });
    const rows = await admin<Array<{ user_id: string | null; helper_user: string; device_id: string }>>`
      SELECT user_id, helper_user, device_id
      FROM workspace_file_activity
      WHERE org_id = ${orgA} AND file_index_id = ${fileReportId}`;
    expect(rows).toEqual([{ user_id: null, helper_user: 'Front Desk', device_id: device1 }]);
  });

  it('round-trips recents with label filtering and DISTINCT ON dedupe', async () => {
    await asOrgA(async ({ activity }) => {
      // Second touch of the same file must not duplicate it in recents.
      expect(await activity.record(orgA, {
        fileIndexId: fileReportId, deviceId: device1, helperUser: 'Front Desk', action: 'copy_path',
      })).toEqual({ recorded: true });
      // A different label on the same device.
      expect(await activity.record(orgA, {
        fileIndexId: fileDev1Id, deviceId: device1, helperUser: 'Back Office', action: 'open',
      })).toEqual({ recorded: true });
    });

    const frontDesk = await asOrgA(({ activity }) => activity.recents(orgA, device1, 'Front Desk'));
    expect(frontDesk.map((r) => r.id)).toEqual([fileReportId]);

    const backOffice = await asOrgA(({ activity }) => activity.recents(orgA, device1, 'Back Office'));
    expect(backOffice.map((r) => r.id)).toEqual([fileDev1Id]);

    const nobody = await asOrgA(({ activity }) => activity.recents(orgA, device1, 'Nobody'));
    expect(nobody).toEqual([]);

    // Null label = all activity on this device, deduped per file.
    const all = await asOrgA(({ activity }) => activity.recents(orgA, device1, null));
    expect(all.map((r) => r.id).sort()).toEqual([fileReportId, fileDev1Id].sort());
  });

  it('keeps recents device-scoped', async () => {
    const dev2Recents = await asOrgA(({ activity }) => activity.recents(orgA, device2, null));
    expect(dev2Recents).toEqual([]);
  });

  it('spans devices in the department feed without exposing who or where', async () => {
    // Device 2 touches a shared smb file; a hidden-source touch is forged by
    // admin to prove the feed still excludes it.
    await asOrgA(async ({ activity }) => {
      expect(await activity.record(orgA, {
        fileIndexId: fileNotesId, deviceId: device2, helperUser: 'Ops', action: 'open',
      })).toEqual({ recorded: true });
    });
    await admin`INSERT INTO workspace_file_activity (org_id, file_index_id, device_id, action)
                VALUES (${orgA}, ${fileHiddenId}, ${device1}, 'open')`;

    const department = await asOrgA(({ activity }) => activity.departmentRecent(orgA, device1));
    const ids = department.map((r) => r.id);
    expect(ids).toContain(fileReportId); // device 1's activity
    expect(ids).toContain(fileNotesId); // device 2's activity — the feed spans devices
    expect(ids).not.toContain(fileHiddenId);
    expect(ids).not.toContain(fileOrgBId);
    // Device 1's own local file is in its partition; device 2 must not see it.
    const asDevice2 = await asOrgA(({ activity }) => activity.departmentRecent(orgA, device2));
    expect(asDevice2.map((r) => r.id)).not.toContain(fileDev1Id);

    // No who/which-device attribution leaves the service ("track work, not workers").
    for (const row of department) {
      expect(row).not.toHaveProperty('deviceId');
      expect(row).not.toHaveProperty('helperUser');
      expect(row).not.toHaveProperty('userId');
      expect(typeof row.lastActivityAt).toBe('string');
    }
  });

  it('never returns org B rows under org A RLS context, even by direct id probe', async () => {
    // Belt (service org filter) and suspenders (RLS): read org B's row raw.
    const raw = await asOrgA(({ tx }) => tx`
      SELECT id FROM workspace_file_index WHERE id = ${fileOrgBId}`);
    expect(raw).toHaveLength(0);
    const search = await asOrgA(({ files }) => files.search(orgA, device1, { q: 'henderson-b' }));
    expect(search.map((r) => r.id)).not.toContain(fileOrgBId);
  });
});
