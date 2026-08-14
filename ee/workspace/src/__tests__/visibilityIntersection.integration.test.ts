// Shared visibility predicate + group intersection — real-DB integration
// (:5433). ONE rule (src/services/visibility.ts) now governs source visibility
// across every read surface. This proves the group-intersection arm of that
// rule end-to-end: a grouped source ('["g1","g2"]') becomes visible exactly
// when the caller's claim set overlaps it, and stays hidden for the empty set
// (today's fail-closed default) and a non-overlapping set — asserted on
// fileQuery search/browse, every (lexical) hybrid arm, the passages path,
// recents, the department feed, and the filing list. An ungrouped source is
// visible under all three claim sets (the control).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { WorkspaceDatabase } from '../hostTypes';
import { createFileQueryService } from '../services/fileQueryService';
import { createContentSearchService } from '../services/contentSearchService';
import { createActivityService } from '../services/activityService';
import { createFilingService } from '../services/filingService';
import { createCrosswalkService } from '../services/crosswalkService';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
const APP_URL = process.env.DATABASE_URL_APP ?? 'postgresql://breeze_app:breeze_test@localhost:5433/breeze_test';
if (new URL(ADMIN_URL).port === '5432') throw new Error('refusing to run against :5432 — use the test stack (:5433)');

// Claim sets: MEMBER overlaps the grouped source's {g1,g2}; NON_MEMBER does
// not; EMPTY is the routes' fail-closed default (ungrouped-only).
const MEMBER = ['g1'];
const NON_MEMBER = ['g3'];
const EMPTY: string[] = [];

let admin: postgres.Sql;
let app: postgres.Sql;
let appDb: ReturnType<typeof drizzle>;
let partner: string, org: string, site: string, openSource: string, groupedSource: string;
const DEVICE = randomUUID();
const ids: Record<string, string> = {};

type Services = {
  files: ReturnType<typeof createFileQueryService>;
  content: ReturnType<typeof createContentSearchService>;
  activity: ReturnType<typeof createActivityService>;
  filing: ReturnType<typeof createFilingService>;
};

async function asOrg<T>(fn: (svc: Services) => Promise<T>): Promise<T> {
  return appDb.transaction(async (transaction) => {
    const tx = (transaction as unknown as { session: { client: postgres.TransactionSql } }).session.client;
    await tx`SELECT set_config('breeze.scope', 'organization', true),
                    set_config('breeze.org_id', ${org}, true),
                    set_config('breeze.accessible_org_ids', ${org}, true),
                    set_config('breeze.accessible_partner_ids', ${partner}, true),
                    set_config('breeze.user_id', '', true),
                    set_config('breeze.current_partner_id', '', true)`;
    const db = transaction as unknown as WorkspaceDatabase;
    const crosswalk = createCrosswalkService(db);
    return fn({
      files: createFileQueryService(db),
      content: createContentSearchService(db),
      activity: createActivityService(db),
      filing: createFilingService(db, { crosswalkService: crosswalk }),
    });
  });
}

interface SeedFile {
  key: string;
  src: 'grouped' | 'open';
  rel: string;
  text?: string;
  entities?: Array<{ type: string; value: string; origin?: string }>;
  enrichment?: Record<string, string | null>;
  emailMeta?: object;
  /** Seed one workspace_file_activity row for DEVICE against this file. */
  activity?: boolean;
}

const SEED: SeedFile[] = [
  // Grouped-source document: exercises the entity, FTS, trigram, and project
  // arms plus the passages chunk. Only a claim overlapping {g1,g2} sees it.
  {
    key: 'gf', src: 'grouped',
    rel: 'Grouped/2030-100 Restricted Reservoir/restricted-plan.md',
    text: 'GRANT OF EASEMENT restricted reservoir gladstone parcel across APN 099-100-200.',
    entities: [{ type: 'apn', value: '099-100-200' }],
    enrichment: {
      inferred_project_key: '2030-100', inferred_project_label: 'Restricted Reservoir',
      inferred_doc_type: 'easement deed',
      declared_project_key: '2030-100', declared_project_label: 'Restricted Reservoir',
    },
    activity: true,
  },
  // Grouped-source unfiled email: exercises the filing list.
  {
    key: 'ge', src: 'grouped', rel: 'Grouped/Unfiled/restricted intake.eml',
    entities: [{ type: 'person', value: 'Restricted Person', origin: 'llm' }],
    emailMeta: { subject: 'restricted intake', from: 'Restricted Person' },
  },
  // Ungrouped-source control document: visible under every claim set.
  {
    key: 'of', src: 'open',
    rel: 'Open/2031-200 Public Reservoir/public-plan.md',
    text: 'public reservoir gladstone parcel across APN 099-100-201.',
    entities: [{ type: 'apn', value: '099-100-201' }],
    enrichment: {
      inferred_project_key: '2031-200', inferred_project_label: 'Public Reservoir',
      declared_project_key: '2031-200', declared_project_label: 'Public Reservoir',
    },
    activity: true,
  },
  // Ungrouped-source control email.
  {
    key: 'oe', src: 'open', rel: 'Open/Unfiled/public intake.eml',
    entities: [{ type: 'person', value: 'Public Person', origin: 'llm' }],
    emailMeta: { subject: 'public intake', from: 'Public Person' },
  },
];

beforeAll(async () => {
  admin = postgres(ADMIN_URL, { max: 1 });
  app = postgres(APP_URL, { max: 1 });
  appDb = drizzle(app);
  partner = randomUUID(); org = randomUUID(); site = randomUUID();
  openSource = randomUUID(); groupedSource = randomUUID();
  const sfx = randomUUID();
  await admin`INSERT INTO partners (id, name, slug) VALUES (${partner}, 'wsp-vis', ${`wsp-vis-${sfx}`})`;
  await admin`INSERT INTO organizations (id, partner_id, name, slug)
              VALUES (${org}, ${partner}, 'wsp-vis-org', ${`wsp-vis-org-${sfx}`})`;
  // A real device row: workspace_file_activity.device_id carries an FK.
  await admin`INSERT INTO sites (id, org_id, name) VALUES (${site}, ${org}, 'wsp-vis-site')`;
  await admin`INSERT INTO devices
                (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
              VALUES (${DEVICE}, ${org}, ${site}, ${`wsp-vis-dev-${sfx}`}, 'vis-1', 'windows', '11', 'amd64', 'test')`;
  await admin`INSERT INTO workspace_sources (id, org_id, kind, display_name, root_path, visibility_group_ids)
              VALUES (${openSource}, ${org}, 'smb_share', 'open estate', '\\\\srv\\open', '[]'::jsonb),
                     (${groupedSource}, ${org}, 'smb_share', 'grouped estate', '\\\\srv\\grouped', '["g1","g2"]'::jsonb)`;
  await admin`INSERT INTO workspace_projects (org_id, project_key, label)
              VALUES (${org}, '2030-100', 'Restricted Reservoir'),
                     (${org}, '2031-200', 'Public Reservoir')`;
  for (const f of SEED) {
    const id = randomUUID();
    ids[f.key] = id;
    const srcId = f.src === 'grouped' ? groupedSource : openSource;
    const name = f.rel.split('/').pop()!;
    const parent = f.rel.slice(0, f.rel.lastIndexOf('/'));
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : null;
    await admin`INSERT INTO workspace_file_index
        (id, org_id, source_id, rel_path, parent_path, name, is_dir, ext, size, mtime)
        VALUES (${id}, ${org}, ${srcId}, ${f.rel}, ${parent}, ${name}, false, ${ext}, 500, now())`;
    if (f.text) {
      await admin`INSERT INTO workspace_file_content (org_id, file_index_id, status, extracted_text, source_size, source_mtime)
                  VALUES (${org}, ${id}, 'extracted', ${f.text}, 500, now())`;
      await admin`INSERT INTO workspace_content_chunks (org_id, file_index_id, chunk_index, text)
                  VALUES (${org}, ${id}, 0, ${f.text})`;
    }
    for (const e of f.entities ?? []) {
      await admin`INSERT INTO workspace_content_entities (org_id, file_index_id, entity_type, value_norm, origin)
                  VALUES (${org}, ${id}, ${e.type}, ${e.value}, ${e.origin ?? 'regex'})`;
    }
    if (f.enrichment || f.emailMeta) {
      await admin`INSERT INTO workspace_file_enrichment ${admin({
        org_id: org, file_index_id: id,
        ...(f.enrichment ?? {}),
        ...(f.emailMeta ? { email_meta: JSON.stringify(f.emailMeta) } : {}),
      })}`;
    }
    if (f.activity) {
      await admin`INSERT INTO workspace_file_activity (org_id, file_index_id, device_id, action)
                  VALUES (${org}, ${id}, ${DEVICE}, 'open')`;
    }
  }
});

afterAll(async () => {
  for (const t of ['workspace_file_activity', 'workspace_content_chunks', 'workspace_content_entities',
    'workspace_file_enrichment', 'workspace_file_content', 'workspace_projects',
    'workspace_file_index', 'workspace_sources']) {
    await admin.unsafe(`DELETE FROM ${t} WHERE org_id = $1`, [org]);
  }
  await admin`DELETE FROM devices WHERE id = ${DEVICE}`;
  await admin`DELETE FROM sites WHERE id = ${site}`;
  await admin`DELETE FROM organizations WHERE id = ${org}`;
  await admin`DELETE FROM partners WHERE id = ${partner}`;
  await admin.end(); await app.end();
});

describe('shared visibility predicate — group intersection', () => {
  describe('fileQueryService', () => {
    it('visibleSources admits the grouped source only for an overlapping claim', async () => {
      const member = await asOrg(({ files }) => files.visibleSources(org, MEMBER));
      expect(member.map((s) => s.id).sort()).toEqual([openSource, groupedSource].sort());

      for (const claims of [EMPTY, NON_MEMBER]) {
        const rows = await asOrg(({ files }) => files.visibleSources(org, claims));
        const sourceIds = rows.map((s) => s.id);
        expect(sourceIds).toContain(openSource); // ungrouped control always visible
        expect(sourceIds).not.toContain(groupedSource);
      }
    });

    it('search returns the grouped file only for an overlapping claim; the ungrouped control always', async () => {
      const member = await asOrg(({ files }) => files.search(org, DEVICE, { q: 'restricted' }, MEMBER));
      expect(member.map((r) => r.id)).toContain(ids.gf);

      for (const claims of [EMPTY, NON_MEMBER]) {
        const hidden = await asOrg(({ files }) => files.search(org, DEVICE, { q: 'restricted' }, claims));
        expect(hidden.map((r) => r.id)).not.toContain(ids.gf);
        const control = await asOrg(({ files }) => files.search(org, DEVICE, { q: 'public' }, claims));
        expect(control.map((r) => r.id)).toContain(ids.of);
      }
    });

    it('browse returns the grouped folder only for an overlapping claim', async () => {
      const parent = 'Grouped/2030-100 Restricted Reservoir';
      const member = await asOrg(({ files }) => files.browse(org, DEVICE, groupedSource, parent, {}, MEMBER));
      expect(member.map((r) => r.id)).toEqual([ids.gf]);

      for (const claims of [EMPTY, NON_MEMBER]) {
        const hidden = await asOrg(({ files }) => files.browse(org, DEVICE, groupedSource, parent, {}, claims));
        expect(hidden).toEqual([]); // hidden source → empty, indistinguishable from unknown
      }
    });
  });

  describe('contentSearchService hybrid arms', () => {
    // One query per arm trigger shape (vector arm is embedder-gated and absent
    // in integration, like the rest of the suite). Every arm shares the one
    // visibility scope tail, so the intersection holds on all of them.
    const arms: Array<{ name: string; q: string }> = [
      { name: 'entity token', q: '099-100-200' },
      { name: 'FTS phrase', q: 'restricted reservoir' },
      { name: 'trigram fragment', q: 'restricted-plan' },
      { name: 'project key', q: '2030-100' },
    ];
    for (const arm of arms) {
      it(`${arm.name}: grouped file surfaces only for an overlapping claim`, async () => {
        const member = await asOrg(({ content }) => content.search(org, DEVICE, { q: arm.q }, MEMBER));
        expect(member.map((r) => r.id)).toContain(ids.gf);

        for (const claims of [EMPTY, NON_MEMBER]) {
          const hidden = await asOrg(({ content }) => content.search(org, DEVICE, { q: arm.q }, claims));
          expect(hidden.map((r) => r.id)).not.toContain(ids.gf);
        }
      });
    }

    it('the ungrouped control document surfaces under every claim set', async () => {
      for (const claims of [EMPTY, NON_MEMBER, MEMBER]) {
        const rows = await asOrg(({ content }) => content.search(org, DEVICE, { q: 'public reservoir' }, claims));
        expect(rows.map((r) => r.id)).toContain(ids.of);
      }
    });
  });

  describe('contentSearchService passages (cited-RAG path)', () => {
    it('never retrieves the grouped source chunk without an overlapping claim', async () => {
      const member = await asOrg(({ content }) => content.passages(org, 'easement restricted', { helperDeviceId: DEVICE }, MEMBER));
      expect(member.map((p) => p.fileIndexId)).toContain(ids.gf);

      for (const claims of [EMPTY, NON_MEMBER]) {
        const hidden = await asOrg(({ content }) => content.passages(org, 'easement restricted', { helperDeviceId: DEVICE }, claims));
        expect(hidden.map((p) => p.fileIndexId)).not.toContain(ids.gf);
      }
    });
  });

  describe('activityService', () => {
    it('recents surfaces grouped-source activity only for an overlapping claim', async () => {
      const member = await asOrg(({ activity }) => activity.recents(org, DEVICE, null, undefined, MEMBER));
      expect(member.map((r) => r.id)).toContain(ids.gf);

      for (const claims of [EMPTY, NON_MEMBER]) {
        const hidden = await asOrg(({ activity }) => activity.recents(org, DEVICE, null, undefined, claims));
        expect(hidden.map((r) => r.id)).not.toContain(ids.gf);
        expect(hidden.map((r) => r.id)).toContain(ids.of); // ungrouped control
      }
    });

    it('department feed spans grouped activity only for an overlapping claim', async () => {
      const member = await asOrg(({ activity }) => activity.departmentRecent(org, DEVICE, undefined, MEMBER));
      expect(member.map((r) => r.id)).toContain(ids.gf);

      for (const claims of [EMPTY, NON_MEMBER]) {
        const hidden = await asOrg(({ activity }) => activity.departmentRecent(org, DEVICE, undefined, claims));
        expect(hidden.map((r) => r.id)).not.toContain(ids.gf);
        expect(hidden.map((r) => r.id)).toContain(ids.of); // ungrouped control
      }
    });
  });

  describe('filingService', () => {
    it('list includes the grouped-source email only for an overlapping claim', async () => {
      const member = await asOrg(({ filing }) => filing.list(org, MEMBER));
      expect(member.map((r) => r.relPath)).toContain('Grouped/Unfiled/restricted intake.eml');

      for (const claims of [EMPTY, NON_MEMBER]) {
        const rels = (await asOrg(({ filing }) => filing.list(org, claims))).map((r) => r.relPath);
        expect(rels).not.toContain('Grouped/Unfiled/restricted intake.eml');
        expect(rels).toContain('Open/Unfiled/public intake.eml'); // ungrouped control
      }
    });
  });
});
