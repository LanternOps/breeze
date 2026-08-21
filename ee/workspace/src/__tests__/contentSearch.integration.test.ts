// Hybrid retrieval — real-DB integration (:5433). Seeds a miniature estate
// shaped like the demo corpus traps: entity-only matches (APN in body, not
// name), the misfile shape (sole FTS-AND hit vs many name matches), project
// resolution, tombstone/visibility exclusion, and the disagreement flag.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { WorkspaceDatabase } from '../hostTypes';
import { createContentSearchService } from '../services/contentSearchService';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
const APP_URL = process.env.DATABASE_URL_APP ?? 'postgresql://breeze_app:breeze_test@localhost:5433/breeze_test';
if (new URL(ADMIN_URL).port === '5432') throw new Error('refusing to run against :5432 — use the test stack (:5433)');

let admin: postgres.Sql;
let app: postgres.Sql;
let appDb: ReturnType<typeof drizzle>;
let partner: string, org: string, source: string, hiddenSource: string;
const DEVICE = randomUUID();

interface SeedFile {
  key: string;
  rel: string;
  text?: string;
  entities?: Array<{ type: string; value: string }>;
  enrichment?: Record<string, string | null>;
  tombstoned?: boolean;
  sourceOverride?: string;
  /** Content chunks (workspace_content_chunks). Defaults to a single chunk of `text`. */
  chunks?: string[];
}

// A chunk longer than the 700-char passage byte cap, matching "easement".
const LONG_EASEMENT_CHUNK = `easement continuation: ${'the parties further covenant and agree regarding the said easement across the parcel. '.repeat(12)}`;

const ids: Record<string, string> = {};

const SEED: SeedFile[] = [
  {
    key: 'scan34',
    rel: 'Projects/2024-007 Vine Hill Winery Site Plan/scan_0034.md',
    text: 'GRANT OF EASEMENT. Kowalski Family Trust grants to the City of Fairoaks an easement for the Henderson Road Water Main Replacement Project across APN 042-330-021.',
    entities: [{ type: 'apn', value: '042-330-021' }],
    enrichment: {
      inferred_project_key: '2023-041', inferred_project_label: 'Henderson Water Main Replacement',
      inferred_doc_type: 'easement deed',
      declared_project_key: '2024-007', declared_project_label: 'Vine Hill Winery Site Plan',
    },
    // Two chunks: the deed body (the top passage) plus an over-cap continuation
    // that proves snippet byte-capping.
    chunks: [
      'GRANT OF EASEMENT. Kowalski Family Trust grants to the City of Fairoaks an easement for the Henderson Road Water Main Replacement Project across APN 042-330-021.',
      LONG_EASEMENT_CHUNK,
    ],
  },
  // Name-match foils: "henderson" in path/name but no "easement" in body.
  ...Array.from({ length: 8 }, (_, i) => ({
    key: `hend${i}`,
    rel: `Projects/2023-041 Henderson Water Main Replacement/henderson-doc-${i}.md`,
    text: `Progress notes ${i} for the water main job. Pipe staging and paving.`,
  })),
  {
    key: 'ros',
    rel: 'Projects/2019-112 Quail Hollow Estates ROS/record_of_survey.md',
    text: 'Record of survey narrative for Quail Hollow Estates, APN 057-071-012 and APN 057-071-013.',
    entities: [{ type: 'apn', value: '057-071-012' }, { type: 'apn', value: '057-071-013' }],
  },
  {
    key: 'corner',
    rel: 'Projects/2019-112 Quail Hollow Estates ROS/CornerRecord.md',
    text: 'Corner record, found pipe at the northwest corner of Lot 3, APN 057-071-012.',
    entities: [{ type: 'apn', value: '057-071-012' }],
  },
  {
    key: 'title-email',
    rel: 'Emails/2019-112/title order request.eml',
    text: 'Subject: title order\n\nPlease open a title order for APN 057-071-012.',
    entities: [{ type: 'apn', value: '057-071-012' }],
  },
  // A file whose NAME carries the APN-ish digits but body does not (trigram foil).
  { key: 'foil', rel: 'Legacy/057-scan-index.md', text: 'Old scanning index, no parcels here.' },
  { key: 'tomb', rel: 'Projects/2019-112 Quail Hollow Estates ROS/tombstoned.md', text: 'APN 057-071-012 haunted file', entities: [{ type: 'apn', value: '057-071-012' }], tombstoned: true },
  // hidden's chunk is a STRONG lexical match for "easement henderson" — the
  // visibility scope, not weak ranking, is what must keep it unreachable.
  {
    key: 'hidden', rel: 'Secret/hidden.md', text: 'APN 057-071-012 in a hidden source',
    entities: [{ type: 'apn', value: '057-071-012' }], sourceOverride: 'hidden',
    chunks: ['GRANT OF EASEMENT for the Henderson Road Water Main Replacement — this hidden passage must never surface.'],
  },
];

async function asOrg<T>(fn: (svc: ReturnType<typeof createContentSearchService>) => Promise<T>): Promise<T> {
  return appDb.transaction(async (transaction) => {
    const tx = (transaction as unknown as { session: { client: postgres.TransactionSql } })
      .session.client;
    await tx`SELECT set_config('breeze.scope', 'organization', true),
                    set_config('breeze.org_id', ${org}, true),
                    set_config('breeze.accessible_org_ids', ${org}, true),
                    set_config('breeze.accessible_partner_ids', ${partner}, true),
                    set_config('breeze.user_id', '', true),
                    set_config('breeze.current_partner_id', '', true)`;
    return fn(createContentSearchService(transaction as unknown as WorkspaceDatabase));
  });
}

beforeAll(async () => {
  admin = postgres(ADMIN_URL, { max: 1 });
  app = postgres(APP_URL, { max: 1 });
  appDb = drizzle(app);
  partner = randomUUID(); org = randomUUID(); source = randomUUID(); hiddenSource = randomUUID();
  const sfx = randomUUID();
  await admin`INSERT INTO partners (id, name, slug) VALUES (${partner}, 'wsp-search', ${`wsp-search-${sfx}`})`;
  await admin`INSERT INTO organizations (id, partner_id, name, slug, currency_code)
              VALUES (${org}, ${partner}, 'wsp-search-org', ${`wsp-search-org-${sfx}`}, 'USD')`;
  await admin`INSERT INTO workspace_sources (id, org_id, kind, display_name, root_path, visibility_group_ids)
              VALUES (${source}, ${org}, 'smb_share', 'estate', '\\\\srv\\estate', '[]'::jsonb),
                     (${hiddenSource}, ${org}, 'smb_share', 'hidden', '\\\\srv\\hidden', '["g1"]'::jsonb)`;
  await admin`INSERT INTO workspace_projects (org_id, project_key, label)
              VALUES (${org}, '2019-112', 'Quail Hollow Estates ROS'),
                     (${org}, '2023-041', 'Henderson Water Main Replacement')`;
  for (const f of SEED) {
    const id = randomUUID();
    ids[f.key] = id;
    const srcId = f.sourceOverride === 'hidden' ? hiddenSource : source;
    const name = f.rel.split('/').pop()!;
    const parent = f.rel.slice(0, f.rel.lastIndexOf('/'));
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : null;
    await admin`INSERT INTO workspace_file_index
        (id, org_id, source_id, rel_path, parent_path, name, is_dir, ext, size, mtime, deleted_at)
        VALUES (${id}, ${org}, ${srcId}, ${f.rel}, ${parent}, ${name}, false, ${ext}, 500, now(),
                ${f.tombstoned ? admin`now()` : null})`;
    if (f.text) {
      await admin`INSERT INTO workspace_file_content (org_id, file_index_id, status, extracted_text, source_size, source_mtime)
                  VALUES (${org}, ${id}, 'extracted', ${f.text}, 500, now())`;
    }
    // Chunks power the passages() retrieval arms. No embedder in tests →
    // embedding stays NULL and only the FTS/trigram arms rank them.
    const chunks = f.chunks ?? (f.text ? [f.text] : []);
    for (let i = 0; i < chunks.length; i += 1) {
      await admin`INSERT INTO workspace_content_chunks (org_id, file_index_id, chunk_index, text)
                  VALUES (${org}, ${id}, ${i}, ${chunks[i]})`;
    }
    for (const e of f.entities ?? []) {
      await admin`INSERT INTO workspace_content_entities (org_id, file_index_id, entity_type, value_norm, origin)
                  VALUES (${org}, ${id}, ${e.type}, ${e.value}, 'regex')`;
    }
    if (f.enrichment) {
      await admin`INSERT INTO workspace_file_enrichment ${admin({
        org_id: org, file_index_id: id, ...f.enrichment,
      })}`;
    }
  }
});

afterAll(async () => {
  for (const t of ['workspace_content_chunks', 'workspace_content_entities', 'workspace_file_enrichment',
    'workspace_file_content', 'workspace_projects', 'workspace_file_index', 'workspace_sources']) {
    await admin.unsafe(`DELETE FROM ${t} WHERE org_id = $1`, [org]);
  }
  await admin`DELETE FROM organizations WHERE id = ${org}`;
  await admin`DELETE FROM partners WHERE id = ${partner}`;
  await admin.end(); await app.end();
});

describe('hybrid content search (RRF, real DB)', () => {
  it('Beat-2 shape: an APN query surfaces entity-carrying files above the name foil', async () => {
    const results = await asOrg((svc) => svc.search(org, DEVICE, { q: '057-071-012' }));
    const top3 = results.slice(0, 3).map((r) => r.id);
    expect(top3).toEqual(expect.arrayContaining([ids.ros, ids.corner, ids['title-email']]));
    // hidden-source and tombstoned entity hits never appear at all
    const all = results.map((r) => r.id);
    expect(all).not.toContain(ids.tomb);
    expect(all).not.toContain(ids.hidden);
    // matched entities are reported for the UI
    expect(results[0].matchedEntities).toEqual([{ type: 'apn', value: '057-071-012' }]);
  });

  it('Beat-3 shape: "Henderson easement" ranks the misfiled deed first with the disagreement flag', async () => {
    const results = await asOrg((svc) => svc.search(org, DEVICE, { q: 'Henderson easement' }));
    expect(results[0].id).toBe(ids.scan34);
    expect(results[0].metadataDisagreement).toBe(true);
    expect(results[0].inferredDocType).toBe('easement deed');
    expect(results[0].declaredProjectLabel).toBe('Vine Hill Winery Site Plan');
    expect(results[0].snippet).toMatch(/easement/i);
  });

  it('project resolution: "the Quail Hollow parcel" pulls the 2019-112 set', async () => {
    const results = await asOrg((svc) => svc.search(org, DEVICE, { q: 'the Quail Hollow parcel' }));
    const top3 = results.slice(0, 3).map((r) => r.id);
    expect(top3).toEqual(expect.arrayContaining([ids.ros]));
    const all = results.map((r) => r.id);
    expect(all).toEqual(expect.arrayContaining([ids.ros, ids.corner, ids['title-email']]));
  });

  it('groups emails distinctly and keeps filename search working (Beat 1)', async () => {
    const results = await asOrg((svc) => svc.search(org, DEVICE, { q: '057-071-012' }));
    const email = results.find((r) => r.id === ids['title-email']);
    expect(email?.group).toBe('email');

    const byName = await asOrg((svc) => svc.search(org, DEVICE, { q: 'CornerRecord' }));
    expect(byName.map((r) => r.id)).toContain(ids.corner);
  });

  it('project/docType filters narrow to the enriched deed, excluding the unenriched name foils', async () => {
    const all = await asOrg((svc) => svc.search(org, DEVICE, { q: 'henderson' }));
    expect(all.map((r) => r.id)).toContain(ids.scan34);
    expect(all.length).toBeGreaterThan(1); // the 8 unenriched name foils also match "henderson"

    const byDocType = await asOrg((svc) => svc.search(org, DEVICE, {
      q: 'henderson', docType: 'easement deed',
    }));
    expect(byDocType.map((r) => r.id)).toEqual([ids.scan34]);
    expect(byDocType.length).toBeLessThan(all.length);

    const byProject = await asOrg((svc) => svc.search(org, DEVICE, {
      q: 'henderson', project: 'Henderson Water Main Replacement',
    }));
    expect(byProject.map((r) => r.id)).toEqual([ids.scan34]);

    const noMatch = await asOrg((svc) => svc.search(org, DEVICE, {
      q: 'henderson', docType: 'no-such-doc-type',
    }));
    expect(noMatch).toEqual([]);
  });

  it('respects sourceId scoping and limit clamping', async () => {
    const results = await asOrg((svc) => svc.search(org, DEVICE, {
      q: '057-071-012', sourceId: hiddenSource,
    }));
    expect(results).toEqual([]); // hidden source is not visible → empty scope

    const limited = await asOrg((svc) => svc.search(org, DEVICE, { q: 'the', limit: 2 }));
    expect(limited.length).toBeLessThanOrEqual(2);
  });
});

describe('passages (visibility-scoped chunk retrieval, real DB)', () => {
  it('ranks the easement chunk first, populates openPath for smb, and byte-caps snippets', async () => {
    const passages = await asOrg((svc) => svc.passages(org, 'easement henderson', { helperDeviceId: DEVICE }));
    expect(passages.length).toBeGreaterThan(0);
    expect(passages.length).toBeLessThanOrEqual(6);
    expect(passages[0].fileIndexId).toBe(ids.scan34);
    expect(passages[0].sourceId).toBe(source);
    expect(passages[0].snippet).toMatch(/easement/i);
    expect(passages[0].openPath).toBe(
      '\\\\srv\\estate\\Projects\\2024-007 Vine Hill Winery Site Plan\\scan_0034.md',
    );
    for (const p of passages) {
      expect(p.snippet.length).toBeLessThanOrEqual(700);
      expect(p.fileIndexId).not.toBe(ids.tomb);
      expect(p.fileIndexId).not.toBe(ids.hidden);
    }
  });

  it('never surfaces a passage from a hidden source even when it is the strongest lexical match', async () => {
    // hidden's chunk literally contains "easement" and "Henderson" — only the
    // fail-closed visibility scope keeps it out of the result set.
    const passages = await asOrg((svc) => svc.passages(org, 'easement henderson', { helperDeviceId: DEVICE }));
    expect(passages.map((p) => p.fileIndexId)).not.toContain(ids.hidden);
  });

  it('fileIndexId narrows retrieval to that single file', async () => {
    const broad = await asOrg((svc) => svc.passages(org, 'water main', { helperDeviceId: DEVICE }));
    expect(broad.length).toBeGreaterThan(1);
    const narrowed = await asOrg((svc) => svc.passages(org, 'water main', {
      helperDeviceId: DEVICE, fileIndexId: ids.scan34,
    }));
    expect(narrowed.length).toBeGreaterThan(0);
    expect(narrowed.every((p) => p.fileIndexId === ids.scan34)).toBe(true);
    expect(narrowed.length).toBeLessThan(broad.length);
  });

  it('caps at 6 passages and truncates an over-cap snippet to 700 chars', async () => {
    const capped = await asOrg((svc) => svc.passages(org, 'water main', { helperDeviceId: DEVICE, limit: 50 }));
    expect(capped.length).toBeLessThanOrEqual(6);
    // scan34's long continuation chunk exceeds 700 chars pre-cap → proves the cap bites.
    const easement = await asOrg((svc) => svc.passages(org, 'easement', { helperDeviceId: DEVICE }));
    expect(easement.some((p) => p.snippet.length === 700)).toBe(true);
    expect(easement.every((p) => p.snippet.length <= 700)).toBe(true);
  });
});

describe('group intersection (claim-scoped visibility)', () => {
  // The hidden source carries visibility_group_ids ['g1']. A caller whose claim
  // set overlaps it now reaches its file (search) and its chunk (passages)
  // through the SAME shared predicate — the fail-closed default ([]) keeps them
  // out, and a non-overlapping claim (['g3']) does too.
  it('search surfaces the hidden-source entity hit only for an overlapping claim', async () => {
    const member = await asOrg((svc) => svc.search(org, DEVICE, { q: '057-071-012' }, ['g1']));
    expect(member.map((r) => r.id)).toContain(ids.hidden);

    for (const claims of [[], ['g3']]) {
      const scoped = await asOrg((svc) => svc.search(org, DEVICE, { q: '057-071-012' }, claims));
      expect(scoped.map((r) => r.id)).not.toContain(ids.hidden);
    }
  });

  it('passages retrieves the hidden-source chunk only for an overlapping claim', async () => {
    const member = await asOrg((svc) => svc.passages(org, 'easement henderson', { helperDeviceId: DEVICE }, ['g1']));
    expect(member.map((p) => p.fileIndexId)).toContain(ids.hidden);

    for (const claims of [[], ['g3']]) {
      const scoped = await asOrg((svc) => svc.passages(org, 'easement henderson', { helperDeviceId: DEVICE }, claims));
      expect(scoped.map((p) => p.fileIndexId)).not.toContain(ids.hidden);
    }
  });
});
